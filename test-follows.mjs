/* ============================================================
   关注：真的能关注，也能取消
   ------------------------------------------------------------
   这个模块以前整个是假的，而且骗法有两层：

   1. **列表是编的。** 「我关注的空间」列的是 `spaces` —— 也就是**全部**空间；
      「我关注的人」列的是 `members` 去掉 u1 —— 也就是**几乎全部**成员。
      不管你关注过什么，它都显示你关注了所有东西。
   2. **按钮是死的。** 两个「已关注」都没有 onClick，点了什么都不会发生。
      而项目里压根没有「关注」这张表。

   共同的点是都不报错：单元测试不渲染、浏览器脚本也不点这个 tab。
   所以这个套件从两头钉：接口/存储层确认关注是真数据，
   界面层确认列表只列真关注过的、按钮点了真的会变。
   ============================================================ */

import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { chromium } from 'playwright'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.FOLLOW_PORT || await freePort()
const BASE = `http://localhost:${PORT}`
const DB = `data/_follow-${Date.now().toString(36)}.db`
const PW = 'follow-test@2026'
const SUF = Date.now().toString(36)

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

let kid = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0' },
  stdio: ['ignore', 'ignore', 'ignore'],
})

const json = async (p, opt = {}) => {
  const res = await fetch(BASE + p, opt)
  const t = await res.text()
  try { return { status: res.status, data: t ? JSON.parse(t) : null } } catch { return { status: res.status, data: null } }
}
const post = (p, body, tk) => json(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) },
  body: JSON.stringify(body || {}),
})
const waitUp = async () => {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true } catch { /* 等 */ }
  }
  return false
}

try {
  await waitUp()

  console.log('\n== 新库里没有关注关系（不是「关注了所有东西」）==')
  const admin = (await post('/api/auth/login', { account: 'admin', password: PW })).data
  const T = admin.token
  const H = { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' }

  const boot = (await json('/api/bootstrap?lite=0', { headers: H })).data
  ok((boot.data.follows || []).length === 0, '全新库里关注是空的', JSON.stringify(boot.data.follows))
  ok((boot.data.spaces || []).length >= 1, '但空间是有的（有可关注的对象）', String(boot.data.spaces?.length))

  // 注册第二个人，才有「可关注的人」
  await post('/api/auth/register', { account: `fo_b_${SUF}`, password: 'test1234', name: `被关注${SUF}` })
  const boot2 = (await json('/api/bootstrap?lite=0', { headers: H })).data
  const someBody = boot2.data.members[0]
  const mySpace = boot2.data.spaces[0]

  console.log('\n== 关注能存住 ==')
  const push = await post('/api/sync/push', {
    upsert: {
      follows: [
        { id: 'fo_a', targetType: 'space', targetId: mySpace.id, createdAt: Date.now() },
        { id: 'fo_b', targetType: 'user', targetId: someBody.id, createdAt: Date.now() },
      ],
    },
    remove: {},
  }, T)
  ok(push.status === 200, '推关注不报错', String(push.status))
  ok(!JSON.stringify(push.data || {}).includes('缺少主键'), '没被当成「缺少主键」静默丢掉', JSON.stringify(push.data).slice(0, 160))

  const boot3 = (await json('/api/bootstrap?lite=0', { headers: H })).data
  ok((boot3.data.follows || []).length === 2, '回读拿到 2 条关注', String(boot3.data.follows?.length))
  ok((boot3.data.follows || []).some((f) => f.targetType === 'space' && f.targetId === mySpace.id), '空间关注在')
  ok((boot3.data.follows || []).some((f) => f.targetType === 'user' && f.targetId === someBody.id), '人的关注在')

  console.log('\n== 关注是个人数据，别人看不到 ==')
  const out = (await post('/api/auth/register', { account: `fo_x_${SUF}`, password: 'test1234', name: `路人${SUF}` })).data
  const outBoot = (await json('/api/bootstrap?lite=0', { headers: { Authorization: 'Bearer ' + out.token } })).data
  ok((outBoot.data.follows || []).length === 0, '路人拿到的是空关注表（不是管理员那两条）',
    JSON.stringify(outBoot.data.follows))

  console.log('\n== 重启之后还在 ==')
  try { kid.kill() } catch { /* 已退出 */ }
  await new Promise((r) => setTimeout(r, 800))
  kid = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  await waitUp()
  const admin2 = (await post('/api/auth/login', { account: 'admin', password: PW })).data
  const boot4 = (await json('/api/bootstrap?lite=0', { headers: { Authorization: 'Bearer ' + admin2.token } })).data
  ok((boot4.data.follows || []).length === 2, '重启后关注还在', String(boot4.data.follows?.length))

  console.log('\n== 界面上：列表只列真关注过的，按钮真能点 ==')
  const br = await chromium.launch()
  const ctx = await br.newContext()
  const p = await ctx.newPage()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', PW)
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(1500)

  // 切到「关注」tab
  await p.goto(`${BASE}/#/?tab=follow`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(800)

  const followedSpaces = await p.locator('.yq-dash-main .yq-card').first().locator('.yq-list-row').count()
  ok(followedSpaces === 1, `「我关注的空间」只列了 1 个（关注了 1 个，不是全部空间）`, String(followedSpaces))

  // 「赞」式的死按钮在这里的表现就是：点了没有任何变化
  const before = await p.evaluate(() => (window.__yqStore.getState().follows || []).length)
  await p.locator('.yq-dash-main button:has-text("已关注")').first().click()
  await p.waitForTimeout(1000)
  const after = await p.evaluate(() => (window.__yqStore.getState().follows || []).length)
  ok(after === before - 1, `点「已关注」真的取消了关注（${before} → ${after}）`, `${before} → ${after}`)

  // 刷新后仍然是取消状态（以前这种点击刷新就没）
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(1200)
  await p.goto(`${BASE}/#/?tab=follow`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(800)
  const afterReload = await p.evaluate(() => (window.__yqStore.getState().follows || []).length)
  ok(afterReload === after, `刷新后取消状态还在（${afterReload}）`, String(afterReload))

  console.log('\n== 「可以关注」这一块不能没有 ==')
  // 关注页只能看不能加的话，你得先关注才知道这里能关注
  const addBtns = await p.locator('button:has-text("＋ 关注")').count()
  ok(addBtns > 0, '有可关注的对象可以点（关注页不只是只读）', String(addBtns))
  await p.locator('button:has-text("＋ 关注")').first().click()
  await p.waitForTimeout(1000)
  const afterAdd = await p.evaluate(() => (window.__yqStore.getState().follows || []).length)
  ok(afterAdd === afterReload + 1, `点「＋ 关注」真的关注上了（${afterReload} → ${afterAdd}）`, `${afterReload} → ${afterAdd}`)

  await br.close()
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  try { kid.kill() } catch { /* 已退出 */ }
  await new Promise((r) => setTimeout(r, 500))
  const left = []
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (!existsSync(f)) continue
    try { rmSync(f, { force: true }) } catch { left.push(f) }
  }
  if (left.length || existsSync(DB)) console.log(`  WARN  临时库没删干净：${left.join(', ')}`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
