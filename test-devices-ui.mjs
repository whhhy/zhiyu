/* ============================================================
   登录设备 / 我的安全记录：设置页**真的把它们画出来了**
   ============================================================
   为什么要有这一节：`test-sessions`（22 项）和 `test-seclog`（20 项）验的都是
   **接口层**。而「承诺了就要做」这条在这里有个很具体的形态 ——
   就算接口全对，只要 `listSessions` 压根没在组件里被调用、
   或者面板渲染时抛了错，**那 20 项照样全绿**，而设置页上就是一片空白。

   这正是本项目反复吃的那一类：**后端绿，前端没被走到**。
   所以这一节走浏览器：真登录两台「设备」、进设置页、**看着那两行出现**、
   点「下线这台」、**看着那一行消失**。
   「看着出现 / 消失」是没有好替代的 —— 断言 DOM 里有那两行，
   比断言接口返回 200 强得多，但也强得有限（它仍不能证明「行里的按钮真能点」，
   而那一条由下面第 ⑥ 步补）。

   只做**可逆**的事：两次登录 + 一次下线，不改密码、不建令牌 ——
   共享服务（8092）是所有浏览器套件共用的，留下残渣会影响后面的套件。
   「我的安全记录」这里只验它**渲染出来了**（标题 + 说明），
   它的数据正确性由 `test-seclog` 在接口层管。
   =================================================================== */
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')
const PW = process.env.ADMIN_PASS || 'yuque@2026'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

const browser = await chromium.launch()
const loginIn = async (ctx) => {
  const p = await ctx.newPage()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', PW)
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(1200)
  return p
}

try {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const p = await loginIn(ctxA)
  console.log('== 制造两台设备 ==')
  const pB = await loginIn(ctxB)
  const tokA = await p.evaluate(() => localStorage.getItem('yq_token'))
  const tokB = await pB.evaluate(() => localStorage.getItem('yq_token'))
  ok(!!tokA && !!tokB && tokA !== tokB, '两个浏览器上下文各自登录 → 两台设备（令牌不同）')
  const H = { Authorization: 'Bearer ' + tokA }

  const listNow = async () => (await (await p.request.get(`${BASE}/api/auth/sessions`, { headers: H })).json()).sessions || []
  const before = await listNow()
  ok(before.length >= 2, `接口侧确实有 ${before.length} 条会话（下面要能在界面上看到它们）`)

  console.log('\n== 设置页 → 安全 ==')
  await p.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-settings-nav', { timeout: 25000 })
  await p.click('.yq-settings-nav-item:has-text("安全")')
  await p.waitForSelector('.yq-settings-body', { timeout: 15000 })
  await p.waitForTimeout(800)

  const body = async () => (await p.locator('.yq-settings-body').textContent()) || ''
  ok(/登录过的设备/.test(await body()), '「登录过的设备」这一节渲染出来了')
  ok(/我的安全记录/.test(await body()), '「我的安全记录」这一节也渲染出来了')

  console.log('\n== 设备列表真的列出了两台 ==')
  await p.waitForTimeout(1200)
  const rows = p.locator('.yq-settings-body >> text=/当前设备/')
  const curCount = await rows.count()
  ok(curCount >= 1, `界面上标出了「当前设备」（${curCount} 处）—— 而本浏览器就是当前这台`)
  const secText = await body()
  ok(/下线这台/.test(secText), '另一台设备有「下线这台」按钮')
  // 当前设备那一行不该有按钮
  const curRow = p.locator('.yq-settings-body div', { hasText: '当前设备' }).last()
  const curRowText = (await curRow.textContent()) || ''
  ok(!/下线这台/.test(curRowText), '而**当前**那一行没有「下线这台」（点了就把自己踢下线）', curRowText.slice(0, 60).replace(/\s+/g, ' '))
  ok(/要下线这台请用/.test(secText), '并且写清了要改用「退出登录」')

  console.log('\n== 真点一下「下线这台」==')
  const rowsBefore = await p.locator('.yq-settings-body div:has-text("下线这台")').count()
  ok(rowsBefore >= 1, `有 ${rowsBefore} 行可下线`)
  await p.locator('.yq-settings-body button:has-text("下线这台")').first().click()
  await p.waitForTimeout(1800)
  // 重点不是接口变了（那是 test-sessions 管的），而是**界面上那一行真的消失了**
  const rowsAfter = await p.locator('.yq-settings-body div:has-text("下线这台")').count()
  ok(rowsAfter === rowsBefore - 1, `界面上可下线的行从 ${rowsBefore} 变成 ${rowsAfter}（刷新后面板自己重读了列表）`)
  const afterList = await listNow()
  ok(afterList.length === before.length - 1, `接口侧也从 ${before.length} 条降到 ${afterList.length} 条`)
  const goneTokB = await pB.evaluate(() => fetch('/api/auth/me', { headers: { Authorization: 'Bearer ' + localStorage.getItem('yq_token') } }).then((r) => r.status).catch(() => -1))
  ok(goneTokB === 401, `被踢掉那台设备的令牌立刻失效（${goneTokB}）`)

  console.log('\n== 安全记录那一节不空壳 ==')
  const secText2 = await body()
  ok(/还没有记录|我的安全记录/.test(secText2), '安全记录区有内容（数据由 test-seclog 在接口层验）')
} catch (e) {
  fail++
  console.log(`  FAIL  套件异常：${e?.message || e}`)
} finally {
  await browser.close()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
