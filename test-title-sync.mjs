/*
 * 「标题」这一个概念的四份副本（2026-10-12 补）
 *
 * ============================================================
 * 语雀的模型是「标题 = 第一个 H1 块」，而我们把它拆成了**四份**
 * ============================================================
 *   · `docs.title`      —— 标题本体
 *   · `nodes.title`     —— 目录项标题（侧边树 / 目录管理 / 工作台列表都读它）
 *   · `blocks[0]`(h1)   —— 文档型文稿正文里的第一个 H1（大纲面板读它）
 *   · `body`            —— 由 blocks 转出的 Markdown 源，**导出与对外分享页认它**
 *
 * 这四份**没有一处会自动互相跟随**，于是每多一个改标题的入口就多一条漏路。
 * 已经中过三次：
 *   · 2026-10-10  正文 H1 → title 改了，node.title 没跟上（目录树显示「未命名」）
 *   · 2026-10-12  文档设置 → title 改了，node.title 没跟上（树上是旧名字）
 *   · 2026-10-12  文档设置 → title 改了，blocks[0] 和 body 没跟上
 *                   ⇒ **导出 Markdown / Word / HTML 出来还是旧标题**
 * 而前两条修复都只补了 `node.title`，**没补块和 body** ——
 * 第三条就是从那个缝里漏过去的。
 *
 * 修法统一收在写入点：`updateDoc` 与 `renameNode` 都走 `withSyncedTitle`。
 *
 * ============================================================
 * 判据要点
 * ============================================================
 * · **四条入口都得走一遍**（只测一条就会重演这个 bug）。
 * · 每条都要**同时看本地和服务端** —— 只看本地的话，
 *   「本地改了服务端没改」也会显示成绿。
 * · **两种文档都要测**：
 *     · 首块是 h1（文档型）→ 四份都得跟上
 *     · 首块不是 h1（表格 / 画板那类）→ **不能硬塞一个 h1 进去**，
 *       那是造数据；只同步 title 与 node
 * · 「当场就跟上」那条不等轮询：这个 bug 的症状正是「当场没变、刷新才对」。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.TITLE_SYNC_PORT || await freePort()
const DB = 'data/_titleguard.db'
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
  try { if ((await fetch(`${BASE}/api/health`)).ok) up = true } catch { /* 等 */ }
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
  if (!inApp) throw new Error('登录后未进入应用')
  await page.waitForTimeout(2000)
}

const four = (bag, did) => {
  const D = bag.docs
  const d = Array.isArray(D) ? D.find((x) => x.id === did) : D?.[did]
  const n = (bag.nodes || []).find((x) => x.docId === did)
  const h1 = (d?.blocks || []).find((b) => b.type === 'h1')
  return {
    doc: d?.title ?? null,
    node: n?.title ?? null,
    hasH1: !!h1,
    h1: h1 ? String(h1.text) : null,
    body: String(d?.body || '').split('\n')[0],
  }
}
const localFour = (p, did) => p.evaluate((d) => {
  const s = window.__yqStore.getState()
  const n = s.nodes.find((x) => x.docId === d)
  const doc = s.docs[d]
  const h1 = (doc?.blocks || []).find((b) => b.type === 'h1')
  return {
    doc: doc?.title ?? null,
    node: n?.title ?? null,
    hasH1: !!h1,
    h1: h1 ? String(h1.text) : null,
    body: String(doc?.body || '').split('\n')[0],
  }
}, did)
const srvFour = async (H, did) => {
  const bo = await (await fetch(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
  return four(bo.data, did)
}

try {
  const br = await chromium.launch()
  try {
    const p = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
    await login(p, 'admin', 'yuque@2026')
    const H = {
      Authorization: 'Bearer ' + await p.evaluate(() => localStorage.getItem('yq_token')),
      'Content-Type': 'application/json; charset=utf-8',
    }
    const sfx = Date.now().toString(36)
    const made = await p.evaluate((x) => {
      const s = window.__yqStore.getState()
      const b = s.createBook('s1', '标题一致 ' + x)
      // A：文档型，首块就是 h1 —— 四份都该跟着 title 变
      const a = window.__yqStore.getState().createDoc(b, null, '原始标题')
      window.__yqStore.getState().setDocBlocks(a, [
        { id: 'h1', type: 'h1', text: '原始标题' },
        { id: 'p1', type: 'p', text: '正文一段。' },
      ])
      // B：首块不是 h1（表格 / 画板那类）—— **不能硬塞 h1 进去**
      const c = window.__yqStore.getState().createDoc(b, null, '表格标题', 'sheet')
      window.__yqStore.getState().setDocBlocks(c, [{ id: 't1', type: 'p', text: '表格内容。' }])
      return { b, a, c }
    }, sfx)
    for (let i = 0; i < 30; i++) {
      const bo = await (await p.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
      if ((bo.data.books || []).some((x) => x.id === made.b)) break
      await p.waitForTimeout(500)
    }
    await p.waitForTimeout(4000)
    await p.goto(`${BASE}/#/book/${made.b}/doc/${made.a}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-app', { timeout: 25000 })
    await p.waitForTimeout(4000)

    const checkDoc = async (did, label, expect) => {
      await p.waitForTimeout(6500)
      const l = await localFour(p, did)
      const s = await srvFour(H, did)
      ok(l.doc === expect, `${label}｜本地 doc.title = ${JSON.stringify(l.doc)}`)
      ok(l.node === expect, `${label}｜本地 node.title（目录树）= ${JSON.stringify(l.node)}`)
      ok(s.doc === expect, `${label}｜服务端 doc.title = ${JSON.stringify(s.doc)}`)
      ok(s.node === expect, `${label}｜服务端 node.title = ${JSON.stringify(s.node)}`)
      return { l, s }
    }

    console.log('\n== 起点 ==')
    console.log('  A:', JSON.stringify(await localFour(p, made.a)))
    console.log('  B:', JSON.stringify(await localFour(p, made.c)))

    /* ---------- A：四条入口，四份副本都要跟上 ---------- */
    console.log('\n== A（首块是 h1）· ① 侧边树行内双击 ==')
    await p.evaluate((d) => {
      const s = window.__yqStore.getState()
      const n = s.nodes.find((x) => x.docId === d)
      s.renameNode(n.id, '树里改的标题')
    }, made.a)
    {
      const { l, s } = await checkDoc(made.a, '树里改名', '树里改的标题')
      ok(l.hasH1 && l.h1 === '树里改的标题', `**首个 h1 块跟上了** = ${JSON.stringify(l.h1)}`)
      ok(l.body === '# 树里改的标题', `**body 首行跟上了**（导出认它）= ${JSON.stringify(l.body)}`)
      ok(s.h1 === '树里改的标题', `服务端 h1 块 = ${JSON.stringify(s.h1)}`)
      ok(s.body === '# 树里改的标题', `服务端 body 首行 = ${JSON.stringify(s.body)}`)
    }

    console.log('\n== ② 文档页点标题 ==')
    await p.evaluate((d) => window.__yqStore.getState().updateDoc(d, { title: '文档页改的标题' }), made.a)
    {
      const { l, s } = await checkDoc(made.a, '文档页改标题', '文档页改的标题')
      ok(l.h1 === '文档页改的标题', `**首个 h1 块跟上了** = ${JSON.stringify(l.h1)}`)
      ok(l.body === '# 文档页改的标题', `**body 首行跟上了** = ${JSON.stringify(l.body)}`)
      ok(s.h1 === '文档页改的标题', `服务端 h1 块 = ${JSON.stringify(s.h1)}`)
      ok(s.body === '# 文档页改的标题', `服务端 body 首行 = ${JSON.stringify(s.body)}`)
    }

    console.log('\n== ③ 「···」→ 文档设置 ==')
    {
      await p.locator('.yq-doc-more').first().click({ timeout: 8000 })
      await p.waitForTimeout(900)
      await p.locator('.yq-menu-item', { hasText: '文档设置' }).first().click({ timeout: 8000 })
      await p.waitForTimeout(1200)
      await p.locator('.yq-docset input').first().fill('文档设置改的标题')
      await p.waitForTimeout(400)
      await p.locator('button', { hasText: '保存' }).last().click({ timeout: 8000 })
      await p.waitForTimeout(700)
      // 立刻就看 —— 不等轮询。这个 bug 的症状就是「当场没变、刷新才对」
      const instant = await localFour(p, made.a)
      ok(instant.h1 === '文档设置改的标题',
        `文档设置改标题｜**当场** h1 就跟上了 = ${JSON.stringify(instant.h1)}（不等轮询）`)
      ok(instant.body === '# 文档设置改的标题',
        `文档设置改标题｜**当场** body 首行就跟上了 = ${JSON.stringify(instant.body)}`)
    }
    {
      const { l, s } = await checkDoc(made.a, '文档设置改标题', '文档设置改的标题')
      ok(l.h1 === '文档设置改的标题', `h1 块 = ${JSON.stringify(l.h1)}`)
      ok(l.body === '# 文档设置改的标题', `body 首行 = ${JSON.stringify(l.body)}`)
      ok(s.h1 === '文档设置改的标题', `服务端 h1 块 = ${JSON.stringify(s.h1)}`)
      ok(s.body === '# 文档设置改的标题', `服务端 body 首行 = ${JSON.stringify(s.body)}`)
    }

    console.log('\n== ④ 正文里改第一个 H1 ==')
    await p.evaluate((d) => {
      const s = window.__yqStore.getState()
      s.setDocBlocks(d, [{ id: 'h1', type: 'h1', text: '正文 H1 的标题' }, { id: 'p1', type: 'p', text: '正文。' }])
    }, made.a)
    {
      const { l, s } = await checkDoc(made.a, '正文 H1 改标题', '正文 H1 的标题')
      ok(l.node === '正文 H1 的标题', `node.title 也跟上了 = ${JSON.stringify(l.node)}`)
      ok(s.h1 === '正文 H1 的标题', `服务端 h1 块 = ${JSON.stringify(s.h1)}`)
      ok(s.body === '# 正文 H1 的标题', `服务端 body 首行 = ${JSON.stringify(s.body)}`)
    }

    /* ---------- B：首块不是 h1，不能硬塞 ---------- */
    console.log('\n== B（首块不是 h1）· 改标题不该动块 ==')
    {
      await p.evaluate((d) => window.__yqStore.getState().updateDoc(d, { title: '表格改的标题' }), made.c)
      await p.waitForTimeout(6500)
      const l = await localFour(p, made.c)
      const s = await srvFour(H, made.c)
      ok(l.doc === '表格改的标题', `doc.title 改了 = ${JSON.stringify(l.doc)}`)
      ok(l.node === '表格改的标题', `node.title 跟上了 = ${JSON.stringify(l.node)}`)
      ok(!l.hasH1 && !s.hasH1, '**没有凭空多出一个 h1 块**（那是造数据）')
      ok(l.body === s.body, `body 保持原样没被动（${JSON.stringify(l.body)}）`)
    }

    /* ---------- 刷新之后仍然一致 ---------- */
    console.log('\n== 刷新之后 ==')
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-app', { timeout: 25000 })
    await p.waitForTimeout(6000)
    {
      const s = await srvFour(H, made.a)
      ok(s.doc === s.node && s.doc === s.h1 && s.body === `# ${s.doc}`,
        `服务端四份仍然一致（title=${JSON.stringify(s.doc)} node=${JSON.stringify(s.node)} h1=${JSON.stringify(s.h1)} body=${JSON.stringify(s.body)}）`)
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