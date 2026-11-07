/*
 * 点赞的权限（2026-10-12 补）
 *
 * ============================================================
 * 补的是什么：一个**只在别人点赞时才会发生**的假动作
 * ============================================================
 * `likes` 是 `docs` 的一列，而 `docs` 默认按 `edit` 判 ——
 * 于是 reader（能读、能评论，只是不能编辑）点 👍：
 *     点之前 👍 0 → 点之后 👍 1 → 本地 store 里有了
 *     → 服务端拒 → 顶栏常驻「1 处修改没有保存」，**而他自己修不好**
 *
 * 而语雀那边 reader 是可以点赞的，所以这同时是个 1:1 缺口。
 *
 * ⚠️ 这个洞特别隐蔽：点的人**不会报错**，别人刷新一下就看见他没点过，
 * 顶栏那条告警又指向「修改」而不是「点赞」——
 * 三个信号全在指别的地方。
 *
 * ============================================================
 * 修法与判据
 * ============================================================
 * 服务端 `denyReason` 放行「**除了 likes 什么都没改**」的那种推送。
 * 所以判据必须同时钉住两头：
 *   · 放行的那头：reader 点 👍 真落库，刷新还在
 *   · 不放行的那头：改标题 / 删文档 / 改正文，**照样被拒**
 * 只测第一头的话，那条口子就等于对 reader 完全敞开 ——
 * 而那比原来的假动作危险得多：原来是「他改不了」，现在变成「他能改标题」。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.LIKE_PERM_PORT || await freePort()
const DB = 'data/_likeperm.db'
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
  await page.fill('.yq-login-card input[autocomplete="username"]', a)
  await page.fill('.yq-login-card input[type="password"]', pw)
  await page.click('.yq-login-submit')
  await page.waitForSelector('.yq-app', { timeout: 30000 })
  await page.waitForTimeout(1800)
}

try {
  const br = await chromium.launch()
  try {
    const admin = await (await br.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    await login(admin, 'admin', 'yuque@2026')
    const AH = {
      Authorization: 'Bearer ' + await admin.evaluate(() => localStorage.getItem('yq_token')),
      'Content-Type': 'application/json; charset=utf-8',
    }
    const TITLE = '点赞权限 ' + Date.now().toString(36)
    const made = await admin.evaluate((title) => {
      const s = window.__yqStore.getState()
      const b = s.createBook('s1', title)
      const d = window.__yqStore.getState().createDoc(b, null, title)
      window.__yqStore.getState().setDocBlocks(d, [{ id: 'bk_1', type: 'p', text: '一篇可以被点赞的文档。' }])
      return { b, d }
    }, TITLE)

    // 必须等服务端真的有这个库再推成员行（见 test-tree-perms 的同一条注释）
    for (let i = 0; i < 30; i++) {
      const bo = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
      if ((bo.data.books || []).some((x) => x.id === made.b)) break
      await admin.waitForTimeout(500)
    }
    const acct = `ro_like_${Date.now().toString(36)}`
    const reg = await (await admin.request.post(`${BASE}/api/auth/register`, {
      data: { account: acct, password: 'test1234', name: '点赞同事' },
    })).json()
    await admin.request.post(`${BASE}/api/sync/push`, {
      headers: AH,
      data: {
        upsert: {
          bookMembers: [{
            bookId: made.b, userId: reg.user.id, role: 'reader',
            perms: { read: true, comment: true, edit: false, create: false, export: false, share: false },
            joinedAt: Date.now(),
          }],
        },
      },
    })
    await admin.waitForTimeout(4000)

    const pg = await (await br.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    const errs = []
    pg.on('pageerror', (e) => errs.push(String(e.message).slice(0, 80)))
    await login(pg, acct, 'test1234')
    await pg.goto(`${BASE}/#/book/${made.b}/doc/${made.d}`, { waitUntil: 'domcontentloaded' })
    await pg.waitForSelector('.yq-app', { timeout: 25000 })
    await pg.waitForTimeout(4500)

    const RT = await pg.evaluate(() => localStorage.getItem('yq_token'))
    const RH = { Authorization: 'Bearer ' + RT, 'Content-Type': 'application/json; charset=utf-8' }
    const push = async (payload) => (await pg.request.post(`${BASE}/api/sync/push`, { headers: RH, data: payload })).json()

    /* ---------- 放行的那一头 ---------- */
    console.log('\n== reader 点 👍 ==')
    ok(await pg.locator('.yq-doc-like').count() > 0, '👍 按钮在（读者本来就该能点赞）')
    const before = (await pg.locator('.yq-doc-like').first().innerText()).trim()
    await pg.locator('.yq-doc-like').first().click({ timeout: 8000 })
    await pg.waitForTimeout(1500)
    const after = (await pg.locator('.yq-doc-like').first().innerText()).trim()
    ok(before === '👍 0' && after === '👍 1', `点一下就变了（${before} → ${after}）`)
    await pg.waitForTimeout(7000)
    const banner = await pg.evaluate(() => {
      const m = document.body.innerText.match(/(\d+)\s*处修改没有保存/)
      return m ? m[0] : '(没有)'
    })
    ok(banner === '(没有)', `顶栏没有留下「N 处修改没有保存」（实际：${banner}）`)

    console.log('\n== 刷新之后它还在吗 ==')
    {
      await pg.reload({ waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(4500)
      const t = (await pg.locator('.yq-doc-like').first().innerText().catch(() => '')).trim()
      ok(t.includes('1'), `刷新后还是 ${JSON.stringify(t)} —— 真的落库了，不是只改了界面`)
    }

    /* ---------- 不放行的那一头（这条比上面那条更要紧） ---------- */
    console.log('\n== 但口子只能开在 likes 上 ==')
    {
      const r1 = await push({ upsert: { docs: [{ id: made.d, title: 'reader 偷偷改的标题' }] } })
      ok(r1.rejected?.length === 1 && /没有 edit 权限/.test(r1.rejected[0].reason),
        `改标题仍然被拒（${r1.rejected?.[0]?.reason || '★ 没被拒'}）`)

      const r2 = await push({ upsert: { docs: [{ id: made.d, body: 'reader 偷偷改的正文', blocks: [{ id: 'x', type: 'p', text: '偷改' }] }] } })
      ok(r2.rejected?.length === 1, `改正文仍然被拒（${r2.rejected?.[0]?.reason || '★ 没被拒'}）`)

      const r3 = await push({ upsert: { docs: [{ id: made.d, visibility: 'private' }] } })
      ok(r3.rejected?.length === 1, `改可见性仍然被拒（${r3.rejected?.[0]?.reason || '★ 没被拒'}）`)

      const r4 = await push({ upsert: { docs: [{ id: made.d, pinnedAt: 123 }] } })
      ok(r4.rejected?.length === 1, `改置顶仍然被拒（${r4.rejected?.[0]?.reason || '★ 没被拒'}）`)

      /* ⚠️ 删除走的是 `denyReason(user, def, existing, {})` —— 空对象。
       * 如果判据只看「别的列都没变」，空对象会**判定通过**，于是 reader 能删文档。
       * 这一条专门盯那个空载荷的分支。 */
      const r5 = await push({ remove: { docs: [made.d] } })
      ok(r5.rejected?.length === 1, `删文档仍然被拒（${r5.rejected?.[0]?.reason || '★ 没被拒'}）`)

      const r6 = await push({ upsert: { docs: [{ id: made.d, likes: [reg.user.id, reg.user.id], title: '顺手改个标题' }] } })
      ok(r6.rejected?.length === 1, 'likes 和别的字段一起推时**整体被拒**（不能拿点赞当通行证）')

      /*
       * ⚠️ 这一条是被**破坏对照逼出来的**，不是我想到的。
       * 放行判据里有一句「`null` 和 `0` 都算空」，写的是「**两边都空**」。
       * 把它误改成「一边空就算相等」，前面几条判据**一条都不会红** ——
       * 因为那些场景两边都不空，于是这个口子会静悄悄地开着。
       *
       * ⚠️⚠️ 而且**推送里必须带 `likes`**：不带的话 `onlyColumnChanged`
       * 会在第一道门（`allow in incoming`）就 return false ——
       * 压根走不到那个比较，所以怎么改都不会红。
       * 第一版这条就是漏了 likes，破坏对照照样「没咬住」，差点被我当成守卫无效。
       *
       * 这里挑 `lockMemberId`：库里它是空的（没锁），推上来一个有值的 ——
       * 「一边空、一边不空」正好命中。误放宽的话 reader 就能**把文档锁上**，
       * 那比原来的假动作严重得多。
       */
      const r7 = await push({
        upsert: { docs: [{ id: made.d, likes: [reg.user.id], lockMemberId: reg.user.id, lockAt: Date.now() }] },
      })
      ok(r7.rejected?.length === 1, `锁文档仍然被拒（${r7.rejected?.[0]?.reason || '★ 没被拒'}）`)

      // 前面那些越权尝试一个都不该落地。
      // ⚠️ 从界面上读标题，**不要**去 bootstrap 里读 ——
      //    这份库经 bootstrap 取不到这篇文档（读出来是 undefined），
      //    那时 `!/偷偷改的/.test(undefined读成的串)` 恒真，
      //    是一条**看着在、其实什么都没验**的判据。
      await pg.waitForTimeout(4000)
      await pg.reload({ waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(4000)
      // 不去猜标题元素是哪个（reader 的文档页和编辑态结构不同），
      // 直接看页面上有没有那串字 —— 这才是用户真正看到的东西。
      const shown = await pg.evaluate(() => document.body.innerText)
      ok(shown.includes(TITLE), `刷新后页面上还是原标题（找得到 ${JSON.stringify(TITLE)}）`)
      ok(!shown.includes('偷偷改的'), '页面上没有「偷偷改的」那几处')
    }

    ok(errs.length === 0, '全程没有异常', errs.join(' | '))
    await pg.close()
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