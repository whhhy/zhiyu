/*
 * 模板的权限（2026-10-12 补）
 *
 * ============================================================
 * 服务端那一条是**四分叉**的，客户端以前一条都没接
 * ============================================================
 * `server/sync.ts` 的 templates 分支：
 *   · `official` —— 只有平台管理员能改
 *   · `mine`     —— 新建放行（ownerId 由服务端强制填成本人）；修改按**库里已有的** ownerId 判
 *   · 有 bookId  —— `capsInBook().edit`
 *   · 有 spaceId —— `capsInSpace().edit`
 *
 * 客户端 `createTemplate` / `updateTemplate` / `deleteTemplate` / `applyTemplate`
 * 四个 action 此前**一个守卫都没有**。最重的是 `applyTemplate` ——
 * 它**真的在建一篇文档**（服务端按 `capsInBook().create` 判），
 * 于是一个阅读者点「用这个模板建一篇」，本地真的多出一篇、服务端拒、
 * 顶栏挂一条他自己修不好的告警。
 *
 * ============================================================
 * 这套判据的重点不是「挡住」，是**别挡错**
 * ============================================================
 * 简化成「一律要 edit」会把「建自己的模板」这个正当功能堵掉 ——
 * 那是「功能没了」，比假动作更难被发现（没人会去报「这个功能不见了」）。
 * 所以三档都要测：
 *   · reader      —— 建不了文档、动不了别人的模板、建不了官方模板
 *   · editor      —— 用模板建文档要还能用（反向）
 *   · **任何人**  —— 建自己的、删自己的，要还能用
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.TEMPLATE_PERMS_PORT || await freePort()
const DB = 'data/_tplperm.db'
const BASE = `http://127.0.0.1:${PORT}`

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着删 */ } }
}
if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在跑。自起服务会打错目标，结果不可信。`)
  process.exit(1)
}
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB },
  stdio: ['ignore', 'ignore', 'ignore'],
})
let up = false
for (let i = 0; i < 40 && !up; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { if ((await fetch(`${BASE}/api/health`)).ok) up = true } catch { /* 还没起 */ }
}
if (!up) { console.error('服务没起来'); srv.kill(); process.exit(1) }

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}
const login = async (page, a, pw) => {
  await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 25000 })
  await page.waitForSelector('.yq-login-submit:not([disabled])', { timeout: 25000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', a)
  await page.fill('.yq-login-card input[type="password"]', pw)
  await page.click('.yq-login-submit')
  let inApp = false
  for (let i = 0; i < 25 && !inApp; i++) {
    await page.waitForTimeout(1000)
    inApp = await page.evaluate(() => !!document.querySelector('.yq-app')).catch(() => false)
  }
  if (!inApp) throw new Error('登录后仍未进入应用')
  await page.waitForTimeout(1500)
}

try {
  const br = await chromium.launch()
  try {
    const admin = await (await br.newContext({ viewport: { width: 1400, height: 950 } })).newPage()
    await login(admin, 'admin', 'yuque@2026')
    const AH = {
      Authorization: 'Bearer ' + await admin.evaluate(() => localStorage.getItem('yq_token')),
      'Content-Type': 'application/json; charset=utf-8',
    }
    const sfx = Date.now().toString(36)

    const made = await admin.evaluate((x) => {
      const s = window.__yqStore.getState()
      const b = s.createBook('s1', '模板权限 ' + x)
      const d = window.__yqStore.getState().createDoc(b, null, '一篇 ' + x)
      window.__yqStore.getState().setDocBlocks(d, [{ id: 'bk_1', type: 'p', text: '正文。' }])
      // 三种归属各来一份：官方 / 挂在这个库下 / 管理员自己的
      const official = s.templates.find((t) => t.scope === 'official') || { id: 'tpl_o', name: '官方模板', scope: 'official', body: '# 官方' }
      const bookTpl = window.__yqStore.getState().createTemplate({ name: '库模板', scope: 'book', bookId: b, body: '# 库模板', category: 'c' })
      const myTpl = window.__yqStore.getState().createTemplate({ name: '我的模板', scope: 'mine', body: '# 我的模板', category: 'c' })
      return { b, d, officialId: official.id, bookTpl, myTpl }
    }, sfx)
    console.log(`模板：官方 ${made.officialId} / 库 ${made.bookTpl} / 我的 ${made.myTpl}`)

    for (let i = 0; i < 30; i++) {
      const bo = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
      if ((bo.data.books || []).some((x) => x.id === made.b)) break
      await admin.waitForTimeout(500)
    }

    const mkUser = async (key) => {
      const acct = `tp_${key}_${sfx}`
      const reg = await (await admin.request.post(`${BASE}/api/auth/register`, {
        data: { account: acct, password: 'test1234', name: `${key} 同事` },
      })).json()
      return { acct, id: reg.user.id }
    }
    const reader = await mkUser('reader')
    const editor = await mkUser('editor')
    await admin.request.post(`${BASE}/api/sync/push`, {
      headers: AH,
      data: {
        upsert: {
          bookMembers: [
            { bookId: made.b, userId: reader.id, role: 'reader', perms: { read: true, comment: true, edit: false, create: false, export: false, share: false }, joinedAt: Date.now() },
            { bookId: made.b, userId: editor.id, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: false, share: false }, joinedAt: Date.now() },
          ],
        },
      },
    })
    await admin.waitForTimeout(6000)

    const srvState = async () => {
      const bo = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
      return {
        templates: (bo.data.templates || []).length,
        docs: Object.values(bo.data.docs || {}).length,
        nodes: (bo.data.nodes || []).length,
      }
    }
    const base0 = await srvState()
    console.log('服务端初始：', JSON.stringify(base0))

    for (const R of [
      { key: 'reader', u: reader, canCreate: false },
      { key: 'editor', u: editor, canCreate: true },
    ]) {
      const pg = await (await br.newContext({ viewport: { width: 1400, height: 950 } })).newPage()
      const errs = []
      pg.on('pageerror', (e) => errs.push(String(e.message).slice(0, 80)))
      await login(pg, R.u.acct, 'test1234')
      await pg.goto(`${BASE}/#/book/${made.b}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(4500)

      console.log(`\n== ${R.key}（${R.canCreate ? '有新建权' : '没有新建权'}）==`)
      const r = await pg.evaluate(([bid, did, oId, bTpl]) => {
        const s = window.__yqStore.getState()
        const before = { tpl: s.templates.length, docs: Object.keys(s.docs).length }
        const applied = s.applyTemplate(bid, null, bTpl)
        const ownTpl = s.createTemplate({ name: '我自己的模板', scope: 'mine', body: '# 我自己的', category: 'c' })
        const offTpl = s.createTemplate({ name: '冒充官方', scope: 'official', body: '# 冒充', category: 'c' })
        // 动别人的：库模板（挂在 bookId 下）+ 官方模板
        s.updateTemplate(bTpl, { name: '偷偷改名' })
        s.deleteTemplate(bTpl)
        s.updateTemplate(oId, { name: '偷偷改官方' })
        s.deleteTemplate(oId)
        const st = window.__yqStore.getState()
        const stillBook = st.templates.find((t) => t.id === bTpl)
        const stillOff = st.templates.find((t) => t.id === oId)
        // 自己那份要能删得掉
        let ownDeleted = false
        if (ownTpl) { s.deleteTemplate(ownTpl); ownDeleted = !window.__yqStore.getState().templates.find((t) => t.id === ownTpl) }
        return {
          applied: !!applied,
          docsAdded: Object.keys(window.__yqStore.getState().docs).length > before.docs,
          ownCreated: !!ownTpl,
          ownDeleted,
          offCreated: !!offTpl,
          bookTemplateIntact: !!stillBook && stillBook.name !== '偷偷改名',
          officialIntact: !!stillOff && stillOff.name !== '偷偷改官方',
        }
      }, [made.b, made.d, made.officialId, made.bookTpl])
      await pg.waitForTimeout(9000)

      const banner = await pg.evaluate(() => {
        const m = document.body.innerText.match(/(\d+)\s*处修改没有保存/)
        return m ? m[0] : '(无告警)'
      })
      const now = await srvState()
      console.log(`  本地：建文档=${r.applied} 多出文档=${r.docsAdded} 建自己的=${r.ownCreated} 删自己的=${r.ownDeleted} 建官方=${r.offCreated}`)
      console.log(`  服务端：${JSON.stringify(now)}（基线 ${JSON.stringify(base0)}）`)

      if (!R.canCreate) {
        ok(!r.applied && !r.docsAdded, 'applyTemplate 被拒（没新建权的人建不出文档）')
        ok(!r.offCreated, 'createTemplate(冒充官方) 被拒')
        ok(r.bookTemplateIntact, '库模板没被动过（改 / 删都被拒）')
        ok(r.officialIntact, '官方模板没被动过')
        ok(now.templates === base0.templates, `服务端模板数没变（${now.templates}）`)
      } else {
        ok(r.applied && r.docsAdded, 'applyTemplate 成功（反向：有新建权的人必须还能用模板建文档）')
        ok(now.docs === base0.docs + 1 && now.nodes === base0.nodes + 1,
          `服务端真多了一篇（docs ${base0.docs}→${now.docs}，nodes ${base0.nodes}→${now.nodes}）`)
        // ⚠️ 模板数会**少一个**，而且这是**对的**：
        //   editor 对挂在 bookId 下的模板有 edit，服务端本来就放行他删 ——
        //   他这一轮建了 1 个自己的、又删了 1 个自己的、还删了那个库模板。
        // 所以「数量不变」这条断言只适用于 reader，不能套到两档角色上
        //（我第一版就是这么写的，红了一条而产品是对的）。
        ok(now.templates === base0.templates - 1,
          `模板数少 1（建 1 删 1 再删掉那个库模板：${base0.templates}→${now.templates}）`)
      }
      /* 三档都要：建自己的、删自己的，任何人都还能用 —— 别把正当功能堵掉 */
      ok(r.ownCreated, '**建自己的模板**还能用（那是个人功能，堵掉就是「功能没了」）')
      ok(r.ownDeleted, '**删自己的模板**还能用')
      ok(banner === '(无告警)', `顶栏没有留下修不好的告警（${banner}）`)

      ok(errs.length === 0, '全程没有异常', errs.join(' | '))
      await pg.close()
    }
  } finally { await br.close() }
} catch (e) {
  fail++
  console.error('异常：', e.stack || e.message)
} finally {
  const exited = once(srv, 'exit')
  srv.kill()
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (!existsSync(f)) continue
    for (let i = 0; i < 5; i++) {
      try { rmSync(f, { force: true }); break } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)