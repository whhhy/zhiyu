/* ============================================================
   离职办理与权限回收
   ------------------------------------------------------------
   「离职权限自动回收」以前是**只存不执行**的开关：设置页写着
   「成员离开空间时，自动收回其在本知识库的全部权限」，
   存进库、同步到各设备，实际什么也没发生。
   而且那时候连「办离职」这个动作本身都没有 ——
   同事离职后账号照样能登、照样能翻文档。

   现在补齐的是一个**管理员动作**而不是自动钩子：
   「自动」的触发点（HR 系统、离职流程）各家不一样，
   与其猜一个猜错的自动化，不如给一个可靠的手动动作 ——
   人会忘，但点了就一定生效，而且能立刻验证。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')
const PW = process.env.ADMIN_PASS || 'yuque@2026'
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

  const browser = await chromium.launch()
  const suffix = Date.now().toString(36)

try {
  const p = await (await browser.newContext()).newPage()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', PW)
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(1500)
  const token = await p.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }

  console.log('\n== 登录后的角色要听服务端的 ==')
  // hydrate 曾经把 role 写死成 'member'，于是管理员在服务端模式下
  // 所有按角色显隐的界面都静默消失 —— 页面上看不出任何异常。
  const meRole = await p.evaluate(() => window.__yqStore.getState().currentUser.role)
  const serverRole = (await (await p.request.get(`${BASE}/api/auth/me`, { headers: H })).json()).user.role
  ok(
    meRole === serverRole,
    `客户端认了服务端返回的角色（${serverRole}），不是写死的 member`,
    `客户端 ${meRole} / 服务端 ${serverRole}`,
  )

  // 准备一个要离职的同事，和两个知识库：一个开了回收开关、一个关了
  const reg = await (await p.request.post(`${BASE}/api/auth/register`, {
    data: { account: `off_${suffix}`, password: 'test1234', name: `离职同事${suffix}` },
  })).json()
  const uid = reg.user.id
  const uToken = (await (await p.request.post(`${BASE}/api/auth/login`, {
    data: { account: `off_${suffix}`, password: 'test1234' },
  })).json()).token

  const books = await p.evaluate(async (u) => {
    const s = window.__yqStore.getState()
    const on = s.createBook('s1', '开关打开的库 ' + Date.now().toString(36))
    const off = s.createBook('s1', '开关关闭的库 ' + Date.now().toString(36))
    /*
     * 第三个库：**建完就不碰**。
     *
     * ⚠️ 这不是「多测一个开关取值」，是补一个**以前根本产生不出来**的状态。
     *
     * `book_settings` 的一行只有 `seed.ts` 会铺，而知识库绝大多数是用户
     * 在界面上新建的 —— `createBook` 以前只建 books 与 book_members。
     * 于是新库在服务端**没有设置行**，`LEFT JOIN` 出来是 NULL。
     *
     * 缺省方向全表只有一个是反的：其余五个开关缺行 = 「没开」（安全），
     * 只有 `autoRevoke` 的缺省值是**开**（列定义 / defaultBookSettings() /
     * 界面三处都是开），却被读成了「关」。
     *
     * 实测（2026-10-12 探针，真服务端）：revokedBooks=0、keptBooks=1，
     * 离职的人权限原封不动，而界面上那个开关显示的是「已开启」。
     *
     * 前两个库都紧跟着调了 `updateBookSettings(...)`，**正好把那一行补上了** ——
     * 所以这个状态在这个套件里从来没出现过。写在这里就是为了不让它再消失。
     */
    const fresh = s.createBook('s1', '建完没碰过设置的库 ' + Date.now().toString(36))
    window.__yqStore.getState().addBookMembers(fresh, [u], 'editor')
    window.__yqStore.getState().addBookMembers(on, [u], 'editor')
    window.__yqStore.getState().addBookMembers(off, [u], 'editor')
    window.__yqStore.getState().updateBookSettings(on, { autoRevoke: true })
    window.__yqStore.getState().updateBookSettings(off, { autoRevoke: false })
    return { on, off, fresh }
  }, uid)
  await p.waitForTimeout(3000)

  const check = async (bid) => {
    const j = await (await p.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
    return (j.data.bookMembers || []).some((r) => r.bookId === bid && r.userId === uid)
  }
  ok(await check(books.on), '前置：他在「开关打开」的库里')
  ok(await check(books.off), '前置：他在「开关关闭」的库里')
  ok(await check(books.fresh), '前置：他在「建完没碰过设置」的库里')

  /*
   * 界面必须显示「已开启」—— 否则下面那条断言就成了「本来就该关」，
   * 方向反了也看不出来。这一条是**基准**，不能省。
   */
  const freshSwitch = await p.evaluate((b) => window.__yqStore.getState().getBookSettings(b).autoRevoke, books.fresh)
  ok(freshSwitch === true, '界面显示「离职权限自动回收」是开的（基准）', String(freshSwitch))

  /*
   * 这条咬的是**根因**那一半：`createBook` 必须同时铺出这一行。
   *
   * 为什么不能只靠上面那条行为断言：行为已经被服务端的 `COALESCE(…, 1)` 兜住了，
   * 所以单看「离职时收回了」是**分不清**是「根因修好了」还是「兜底还在」——
   * 把根因那一半拿掉，行为照样绿。而「服务端到底存不存这一行」
   * 是可以直接问的，所以这里就问它，不去 grep 源码。
   *
   * ⚠️ 回包里 `bookSettings` 是**数组**（`[{ bookId, …}, …]`），
   * 而客户端 store 里是按 bookId 键的**对象** —— 两种形状都认一下，
   * 否则这条断言会因为「取错了形状」而红，而红的原因跟被测的东西无关。
   * （第一版就是写成 `rows[bookId]`，拿到的是 undefined。）
   */
  const rawBs = (await (await p.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()).data
    .bookSettings || {}
  const freshRow = Array.isArray(rawBs)
    ? rawBs.find((r) => r.bookId === books.fresh)
    : rawBs[books.fresh]
  ok(!!freshRow,
    '★ 服务端确实存着这个新库的设置行（不是只在客户端有）',
    `拿到 ${Array.isArray(rawBs) ? `数组 ${rawBs.length} 行` : `对象键 ${Object.keys(rawBs).join(',') || '(空)'}`}`.slice(0, 160))
  ok(freshRow?.autoRevoke === true,
    '那一行的 autoRevoke 是 true（与界面显示一致）', JSON.stringify(freshRow?.autoRevoke))

  console.log('\n== 离职办理 ==')
  const r = await (await p.request.post(`${BASE}/api/users/${uid}/offboard`, { headers: H, data: {} })).json()
  ok(r.ok === true, '接口返回成功', JSON.stringify(r).slice(0, 120))
  ok(r.sessions >= 1, `清掉了他的登录会话（${r.sessions} 个）——他下次请求就掉线`, String(r.sessions))
  ok(r.spaces >= 1, `移出了 ${r.spaces} 个空间`, String(r.spaces))
  ok(r.revokedBooks === 2, '收回了「开关打开」与「没碰过设置」两个库', String(r.revokedBooks))
  ok(r.keptBooks === 1, '「开关关闭」的库保留了他的身份（交接期用）', String(r.keptBooks))

  console.log('\n== 权限真的收回了 ==')
  ok((await check(books.on)) === false, '开关打开的库里已经没有他')
  ok((await check(books.off)) === true, '开关关闭的库里他还留着（这是预期行为）')
  ok((await check(books.fresh)) === false,
    '★ 「建完没碰过设置」的库里也收回了（这一条以前是红的：没设置行 = 读成「关」）')

  console.log('\n== 他的令牌真的失效了 ==')
  const after = await p.request.get(`${BASE}/api/auth/me`, { headers: { Authorization: 'Bearer ' + uToken } })
  ok(after.status() === 401, '他原来的会话令牌已经不能用了（不是只在界面上被踢下线）', String(after.status()))

  console.log('\n== 边界情况 ==')
  {
    const self = await p.request.post(`${BASE}/api/users/${(await (await p.request.get(`${BASE}/api/auth/me`, { headers: H })).json()).user.id}/offboard`, { headers: H, data: {} })
    ok(self.status() === 400, '不能给自己办离职', String(self.status()))
    const owner = await p.request.post(`${BASE}/api/users/u_admin/offboard`, { headers: H, data: {} })
    // 这个库里的平台 owner 就是调用者自己，所以会先撞上「不能给自己办离职」那道
    // 闸门。两条都是拒绝，测的是「被拒」而不是具体哪条闸门先拦。
    ok([400, 403].includes(owner.status()), `对平台超级管理员的离职请求被拒（${owner.status()}）`, String(owner.status()))
    const ghost = await p.request.post(`${BASE}/api/users/u_nobody/offboard`, { headers: H, data: {} })
    ok(ghost.status() === 404, '不存在的成员给 404 而不是 500', String(ghost.status()))
  }

  console.log('\n== 普通成员不能办离职 ==')
  {
    // 用一个普通同事的令牌试试
    const reg2 = await (await p.request.post(`${BASE}/api/auth/register`, {
      data: { account: `plain_${suffix}`, password: 'test1234', name: '普通同事' },
    })).json()
    const t2 = (await (await p.request.post(`${BASE}/api/auth/login`, {
      data: { account: `plain_${suffix}`, password: 'test1234' },
    })).json()).token
    const r2 = await p.request.post(`${BASE}/api/users/${uid}/offboard`, { headers: { Authorization: 'Bearer ' + t2, 'Content-Type': 'application/json' }, data: {} })
    ok(r2.status() === 403, '普通成员调这个接口被拒', String(r2.status()))
  }

  console.log('\n== 界面上有入口 ==')
  {
    await p.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-settings-nav', { timeout: 25000 })
    await p.click('.yq-settings-nav-item:has-text("数据管理")')
    await p.waitForSelector('button:has-text("办理离职")', { timeout: 15000 })
    ok(true, '管理员在设置里能看到「成员管理 / 办理离职」')
    const btns = await p.locator('button:has-text("办理离职")').count()
    ok(btns > 0, `列出了 ${btns} 位可办理的成员（自己不在列表里）`)
  }
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  try { await browser.close() } catch { /* 已关 */ }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
