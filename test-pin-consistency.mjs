/*
 * 置顶在两个界面上的一致性（2026-10-12 补）
 *
 * ============================================================
 * 补的是「同一份数据，两个界面表现不一致」
 * ============================================================
 * 侧边树 `Tree.tsx`：`pinFirst` 排序 + 📌 标记 + 菜单里的「置顶」。
 * 设置页的「目录管理」`CatalogTab`：**一个 pin 字样都没有**（改之前 grep 零命中），
 * 而它**能拖拽排序**。
 *
 * 组合出来的三个用户可见后果：
 *   1. 在侧边树置顶一篇，切到设置页 —— 没有任何迹象，像是被清掉了；
 *   2. 想取消置顶只能回侧边树（那儿的行内只有 ＋ 和 🗑）；
 *   3. 这一屏能拖拽排序，而**置顶不改 order**（改的是渲染时的插队），
 *      所以拖动置顶项之后侧边树仍把它排最前 —— 那一屏什么都不解释，
 *      用户只会觉得「拖了没反应」。
 *
 * ============================================================
 * 判据要点
 * ============================================================
 * · **两处顺序本来就该不同**（树插队、设置页显示存储顺序），
 *   所以不能断言「顺序一致」—— 那会把正确行为判成失败。
 *   该断言的是「**置顶项有标记**」和「**标记解释了这个差异**」。
 * · 查标记要查 `.yq-bset-pin` 这个**元素**，
 *   **不能查 innerText 里有没有 📌** —— 行内那个切换按钮本身就写着 📌，
 *   按文字查会永远为真（我第一版就这么写的，红了一条而产品是对的）。
 * · 两边都要验：树里插队（第一项是它）**和** 设置页里能看到标记。
 * · 反向：从设置页也能置顶 —— 不能只验「取消」，否则「加」那边坏了没人知道。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.PIN_CONSISTENCY_PORT || await freePort()
const DB = 'data/_pincons.db'
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

/** 侧边树里那一行的可见顺序（只取文档） */
const treeOrder = (page) => page.evaluate(() =>
  [...document.querySelectorAll('.yq-tree-row, .yq-tree-item, [class*="yq-tree"]')]
    .map((r) => (r.innerText || '').trim().split('\n')[0])
    .filter((t) => /文档/.test(t)))
/** 设置页目录管理里某一行的「置顶标记」—— 查元素，不查文字 */
const catPinned = (page, title) => page.evaluate((t) => {
  const row = [...document.querySelectorAll('.yq-bset-row')].find((r) => (r.innerText || '').includes(t))
  return !!row && !!row.querySelector('.yq-bset-pin')
}, title)

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
      const b = s.createBook('s1', '置顶一致性 ' + x)
      const ids = {}
      for (const t of ['甲', '乙', '丙']) ids[t] = window.__yqStore.getState().createDoc(b, null, t + '文档')
      return { b, ...ids }
    }, sfx)
    for (let i = 0; i < 30; i++) {
      const bo = await (await p.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
      if ((bo.data.books || []).some((x) => x.id === made.b)) break
      await p.waitForTimeout(500)
    }
    await p.waitForTimeout(4000)
    const storedOrder = await p.evaluate((bid) =>
      window.__yqStore.getState().nodes
        .filter((n) => n.bookId === bid && n.type === 'doc')
        .sort((a, b) => a.order - b.order).map((n) => n.title), made.b)
    console.log(`存储顺序：${storedOrder.join(' → ')}`)
    const PIN = storedOrder[2]   // 挑排最后那个，置顶后位移最明显
    console.log(`要置顶的是：${PIN}`)

    const goCatalog = async () => {
      await p.goto(`${BASE}/#/book/${made.b}/settings`, { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-app', { timeout: 25000 })
      await p.waitForTimeout(3000)
      await p.locator('.yq-bset-nav-item', { hasText: '目录管理' }).first().click({ timeout: 8000 })
      await p.waitForTimeout(1800)
    }
    const goTree = async () => {
      await p.goto(`${BASE}/#/book/${made.b}`, { waitUntil: 'domcontentloaded' })
      await p.waitForSelector('.yq-app', { timeout: 25000 })
      await p.waitForTimeout(3500)
    }

    /* ---------- ① 在侧边树置顶 ---------- */
    console.log('\n== ① 在侧边树置顶，然后看设置页 ==')
    await goTree()
    await p.evaluate((d) => window.__yqStore.getState().togglePinDoc(d), made[PIN[0]])
    await p.waitForTimeout(6000)
    {
      const order = await treeOrder(p)
      ok(order[0] === PIN, `侧边树里它排第一（第一项是 ${order[0]}，期望 ${PIN}）`)
      ok(await p.evaluate(() => !!document.querySelector('.yq-tree-pin')), '侧边树有 📌')
      await goCatalog()
      ok(await catPinned(p, PIN), '**设置页的目录管理里也标出来了**（这就是两处顺序不同的解释）')
      // 两处顺序本来就应该不同 —— 断言它不同，并说清楚为什么
      const catOrder = await p.evaluate(() =>
        [...document.querySelectorAll('.yq-bset-tree .yq-bset-title')].map((t) => t.textContent.trim()))
      ok(catOrder.join() !== order.join(),
        `两处顺序确实不同，而这是**预期**的（设置页显示存储顺序 ${catOrder.map((t) => t.replace('📌', '')).join('→')}）`)
    }

    /* ---------- ② 从设置页取消置顶 ---------- */
    console.log('\n== ② 从设置页取消置顶 ==')
    {
      await p.locator('.yq-bset-row', { hasText: PIN }).locator('.yq-bset-row-act').first().click({ timeout: 8000 })
      await p.waitForTimeout(7000)
      ok(!(await catPinned(p, PIN)), '设置页的 📌 标记没了')
      await goTree()
      ok(!(await p.evaluate(() => !!document.querySelector('.yq-tree-pin'))), '侧边树的 📌 也跟着没了')
      const order = await treeOrder(p)
      ok(order[0] === storedOrder[0], `侧边树第一项回到存储顺序（${order[0]} = ${storedOrder[0]}）`)
    }

    /* ---------- ③ 反向：也能从设置页置顶 ---------- */
    console.log('\n== ③ 反向：也能从设置页置顶 ==')
    {
      await goCatalog()
      await p.locator('.yq-bset-row', { hasText: PIN }).locator('.yq-bset-row-act').first().click({ timeout: 8000 })
      await p.waitForTimeout(7000)
      ok(await catPinned(p, PIN), '从设置页点一下就置顶了')
      await goTree()
      const order = await treeOrder(p)
      ok(order[0] === PIN, `侧边树里它插到了第一（${order[0]}）`)
    }

    /* ---------- ④ 服务端真的存了 ---------- */
    console.log('\n== ④ 刷新之后还在吗 ==')
    {
      const pinned = await p.evaluate(async ([bid, did]) => {
        const t = localStorage.getItem('yq_token')
        const r = await fetch(`/api/doc/${did}`, { headers: { Authorization: 'Bearer ' + t } })
        const j = await r.json()
        return Number(j?.doc?.pinnedAt) > 0
      }, [made.b, made[PIN[0]]])
      ok(pinned, '服务端 pinnedAt 有值（不是只改了本地）')
    }

    /* ---------- ⑤ 没有编辑权的人不该拿到能点的按钮 ---------- */
    console.log('\n== ⑤ 没有编辑权的人 ==')
    {
      const acct = `pc_ro_${sfx}`
      const reg = await (await p.request.post(`${BASE}/api/auth/register`, {
        data: { account: acct, password: 'test1234', name: '只读同事' },
      })).json()
      await p.request.post(`${BASE}/api/sync/push`, {
        headers: H,
        data: { upsert: { bookMembers: [{
          bookId: made.b, userId: reg.user.id, role: 'reader',
          perms: { read: true, comment: true, edit: false, create: false, export: false, share: false },
          joinedAt: Date.now(),
        }] } },
      })
      await p.waitForTimeout(5000)
      const pg2 = await (await br.newContext({ viewport: { width: 1500, height: 1000 } })).newPage()
      await login(pg2, acct, 'test1234')
      await pg2.goto(`${BASE}/#/book/${made.b}/settings`, { waitUntil: 'domcontentloaded' })
      await pg2.waitForSelector('.yq-app', { timeout: 25000 })
      await pg2.waitForTimeout(3500)
      await pg2.locator('.yq-bset-nav-item', { hasText: '目录管理' }).first().click({ timeout: 8000 })
      await pg2.waitForTimeout(1800)
      const btn = await pg2.evaluate(() => {
        const b = document.querySelector('.yq-bset-row .yq-bset-row-act')
        return b ? { disabled: b.disabled === true, text: (b.textContent || '').trim() } : null
      })
      ok(!!btn && btn.disabled === true, `置顶按钮对读者是**禁用**的（实际：${btn ? (btn.disabled ? '禁用' : '★ 可点') : '没有这个按钮'}）`)
      ok(await catPinned(pg2, PIN), '置顶状态对读者照样看得见（读，不需要权限）')
      await pg2.close()
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