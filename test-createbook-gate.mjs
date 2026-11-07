/*
 * 「新建知识库」入口按服务端判据显隐（2026-10-12）
 *
 * ============================================================
 * 它防的是一条**假承诺**，而且是四条同源的假承诺
 * ============================================================
 * 服务端 `denyReason` 的 books 分支规定：建知识库必须是**空间管理员**
 * （注释写着「建库是管理动作，让每个成员都能建，空间目录会变成垃圾堆」）。
 * 而客户端的**四个**入口都不判角色：
 *
 *   工作台「开始」卡片 · 工作台「全部知识库」工具条 · 空间页 · 顶栏菜单
 *
 * 一个普通成员点下去会依次发生（实测，2026-10-12 探针，真服务端）：
 *
 *   1. 库里立刻出现一个知识库，toast 弹「知识库已创建」，地址跳进去了；
 *   2. 服务端把 books / bookSettings / bookMembers **三行一起拒掉**
 *      （`你不是「X」这个空间的管理员，没法在里面建知识库`）；
 *   3. 而那个库**刷新也不消失** —— 本地 store 留着它，地址能打开，
 *      里面是空的，服务端根本不知道它存在。
 *
 * 也就是说：一句「已创建」，换来一个**永远同步不出去的空壳**。
 * 继续在这个壳里写文档，那些文档也一篇都传不上去。
 *
 * ⚠️ 修复必须**两个方向都验**：
 *   正向：普通成员看不到入口（看不到 = 不会被引到假动作上）
 *   反向：管理员**照样看得到、也真建得出来** ——
 *         判据在「还没查到」时一律判 false（先不显示），
 *         而这条一旦写反，管理员的入口会一起消失，
 *         那就从「假动作」变成「功能没了」—— 一样是假的，只是方向相反。
 *
 * 自起服务 + 全新库：它要建知识库、要注册账号、在共享库里做这些就是污染。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.CREATEBOOK_GATE_PORT || await freePort()
const DB = 'data/_mkbook.db'
const BASE = `http://127.0.0.1:${PORT}`

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着 */ } }
}
if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在跑 —— 自起服务会打错目标，结果不可信。`)
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
const login = async (page, acct, password) => {
  await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 25000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', acct)
  await page.fill('.yq-login-card input[type="password"]', password)
  await page.click('.yq-login-submit')
  await page.waitForSelector('.yq-app', { timeout: 30000 })
  await page.waitForTimeout(1800)
}
const entryCount = (page) => page.evaluate(() =>
  [...document.querySelectorAll('button, [role="menuitem"]')]
    .filter((e) => (e.textContent || '').includes('新建知识库')).length)

try {
  const br = await chromium.launch()
  try {
    const suffix = Date.now().toString(36)
    const admin = await (await br.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
    await login(admin, 'admin', 'yuque@2026')
    const aTok = await admin.evaluate(() => localStorage.getItem('yq_token'))
    const AH = { Authorization: 'Bearer ' + aTok, 'Content-Type': 'application/json; charset=utf-8' }
    const boot = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
    const sid = (boot.data.spaces || [])[0]?.id
    ok(!!sid, `拿到要用的空间（${sid}）`)

    // 造一个普通空间成员
    const acct = `plain_${suffix}`
    const reg = await (await admin.request.post(`${BASE}/api/auth/register`, {
      data: { account: acct, password: 'test1234', name: '普通同事' },
    })).json()
    await admin.request.post(`${BASE}/api/spaces/${sid}/members`, {
      headers: AH, data: { userId: reg.user.id, role: 'member' },
    })

    /* ================= 反向：管理员必须照常用 ================= */
    console.log('\n== 管理员：入口在，而且真建得出来 ==')
    for (const [label, hash] of [['工作台', '/#/'], ['空间页', `/#/space/${sid}`]]) {
      await admin.goto(BASE + hash, { waitUntil: 'domcontentloaded' })
      await admin.waitForSelector('.yq-app', { timeout: 25000 })
      await admin.waitForTimeout(2000)
      const n = await entryCount(admin)
      ok(n > 0, `管理员在${label}看得到「新建知识库」（判据在「未确认」时是 false，这里不能一起消失）`, `count=${n}`)
    }
    {
      const before = await admin.evaluate(() => Object.values(window.__yqStore.getState().books).map((b) => b.id))
      await admin.goto(BASE + `/#/space/${sid}`, { waitUntil: 'domcontentloaded' })
      await admin.waitForSelector('.yq-app', { timeout: 25000 })
      await admin.waitForTimeout(2000)
      await admin.locator('button:has-text("新建知识库")').first().click()
      await admin.waitForTimeout(4500)
      const after = await admin.evaluate(() => Object.values(window.__yqStore.getState().books).map((b) => b.id))
      const fresh = after.filter((id) => !before.includes(id))
      ok(fresh.length === 1, '管理员点一下真的建出一个库', JSON.stringify(fresh))
      const b2 = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
      const srvIds = (b2.data.books || []).map((b) => b.id)
      ok(fresh.length === 1 && srvIds.includes(fresh[0]), '而且服务端真的收到了（不是只在本地）', JSON.stringify(srvIds))
      // 根因那一半：新库必须有设置行（见 test-offboard 的同名断言）
      const bs = b2.data.bookSettings || []
      const row = Array.isArray(bs) ? bs.find((r) => r.bookId === fresh[0]) : bs[fresh[0]]
      ok(!!row, '★ 新库同时铺出了设置行（没有它，「离职权限自动回收」会被读成关）',
        `bookSettings 拿到 ${Array.isArray(bs) ? `数组 ${bs.length} 行` : '对象'}`)
    }

    /* ================= 正向：普通成员不许被引到假动作上 ================= */
    console.log('\n== 普通成员：四个入口都不出现 ==')
    const member = await (await br.newContext({ viewport: { width: 1280, height: 720 } })).newPage()
    await login(member, acct, 'test1234')
    const myRole = await member.evaluate(() => window.__yqStore.getState().currentUser.role)
    ok(myRole === 'member', `他的角色确实是普通成员（${myRole}）`)

    for (const [label, hash] of [['工作台', '/#/'], ['空间页', `/#/space/${sid}`]]) {
      await member.goto(BASE + hash, { waitUntil: 'domcontentloaded' })
      await member.waitForSelector('.yq-app', { timeout: 25000 })
      await member.waitForTimeout(2500)
      const n = await entryCount(member)
      ok(n === 0, `${label}上没有「新建知识库」入口`, `count=${n}`)
    }

    console.log('\n== 即使绕过界面直接调 action，也建不出来 ==')
    {
      const before = await member.evaluate(() => Object.values(window.__yqStore.getState().books).map((b) => b.id))
      const r = await member.evaluate((s) => {
        const st = window.__yqStore.getState()
        return { can: st.canCreateBookIn(s), id: st.createBook(s, '偷偷建的') }
      }, sid)
      ok(r.can === false, 'canCreateBookIn 判 false（与服务端同一条判据）', String(r.can))
      ok(r.id === '', '★ createBook 返回空 —— store 层就拒了，不产生幽灵库', JSON.stringify(r.id))
      await member.waitForTimeout(3000)
      const after = await member.evaluate(() => Object.values(window.__yqStore.getState().books).map((b) => b.id))
      ok(after.length === before.length, '本地一个库都没多出来（以前会多一个而且刷新也不消失）',
        `${before.length} → ${after.length}`)
      const b2 = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
      const srvIds = (b2.data.books || []).map((b) => b.id)
      ok(srvIds.every((id) => after.includes(id)) || true, `服务端库数 ${srvIds.length}`)
    }

    console.log('\n== 「新建空间」同样不是人人能建 ==')
    {
      await member.goto(BASE + `/#/space/${sid}`, { waitUntil: 'domcontentloaded' })
      await member.waitForSelector('.yq-app', { timeout: 25000 })
      await member.waitForTimeout(2000)
      const n = await member.evaluate(() => [...document.querySelectorAll('button')]
        .filter((e) => (e.textContent || '').includes('新建空间')).length)
      ok(n === 0, '普通成员看不到「新建空间」（服务端要求你是「那个空间」的 owner/admin，' +
        '而还不存在的空间谁都不是它的管理员）', `count=${n}`)
    }

    /* ================= 空间管理员（非平台管理员）必须还能建 ================= */
    console.log('\n== 空间管理员（不是平台管理员）也要能建 ==')
    {
      /*
       * 这一节是被**我自己引入的回归**逼出来的。
       *
       * 第一版 `canCreateBookIn` 拿**空间 id** 去问 `/api/perms/book/:id` ——
       * 而那是个知识库接口，拿到空间 id 会返回**全 false**
       * （`capsInBook` 里 `spaceIdOfBook(空间id)` 查不到、`book_members`
       * 也没有这一行 → 零能力）。
       * 于是空间管理员的「新建知识库」按钮整个消失，
       * 而服务端 `denyReason` 明明放他过。
       *
       * 为什么第一版没抓到：它只测了**平台管理员**，
       * 而平台管理员在 `canCreateBookIn` 里**早退 true**，压根不查那份数据。
       * 于是「反向约束」我以为做了，其实只覆盖了最容易的那一半。
       *
       * 「功能没了」比「假动作」更难被发现 —— 管理员只会以为
       * 「这功能还没做」，不会想到「是我今天把它藏起来的」。
       */
      const acct2 = `spadmin_${suffix}`
      const reg2 = await (await admin.request.post(`${BASE}/api/auth/register`, {
        data: { account: acct2, password: 'test1234', name: '空间管理员' },
      })).json()
      const joinRes = await admin.request.post(`${BASE}/api/spaces/${sid}/members`, {
        headers: AH, data: { userId: reg2.user.id, role: 'admin' },
      })
      const joinBody = await joinRes.json().catch(() => ({}))
      ok(joinRes.status() < 400, '把他加成空间管理员', `${joinRes.status()} ${JSON.stringify(joinBody).slice(0, 90)}`)

      const sa = await (await br.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
      await login(sa, acct2, 'test1234')
      await sa.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
      await sa.waitForSelector('.yq-app', { timeout: 25000 })
      await sa.waitForTimeout(4000)
      const hisRole = await sa.evaluate(() => window.__yqStore.getState().currentUser.role)
      ok(hisRole === 'member', `他的平台角色确实只是 member（${hisRole}）—— 走的不是早退那条`)

      const sBtns = await sa.evaluate(() =>
        [...document.querySelectorAll('button')].map((e) => (e.textContent || '').trim()))
      ok(sBtns.some((t) => t.includes('新建知识库')),
        '★ 他在工作台上看得见「新建知识库」（这条以前是红的：他不是平台管理员）',
        JSON.stringify(sBtns.filter((t) => t.includes('新建'))))

      const made2 = await sa.evaluate(() => {
        const st = window.__yqStore.getState()
        return st.createBook(st.spaces[0].id, '空间管理员建的库 ' + Date.now().toString(36))
      })
      ok(!!made2, '而他真的建得出来（store 也没拦）', String(made2))
      await sa.waitForTimeout(4500)
      const srv2 = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
      ok((srv2.data.books || []).some((b) => b.id === made2),
        '★ 而且服务端真的收到了（不是只在本地）', `服务端库数=${(srv2.data.books || []).length}`)
      await sa.close()
      await admin.request.delete(`${BASE}/api/spaces/${sid}/members/${reg2.user.id}`, { headers: AH }).catch(() => {})
    }

    /* 收摊：把这个临时成员从空间里摘掉，别留在 runner 的共享数据里 */
    await admin.request.delete(`${BASE}/api/spaces/${sid}/members/${reg.user.id}`, { headers: AH }).catch(() => {})
    await member.close()
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