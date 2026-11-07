/* ============================================================
   操作日志：权限与外流动作能追溯
   ------------------------------------------------------------
   在这个功能之前，「谁在什么时候把权限给了谁」**无处可查**。

   项目里本来有一张 `changes` 表，但它不能顶替：
     - 它只服务增量同步，而且会随同步窗口滚动；
     - 它记的是「哪一行变了」，不记意图 ——
       「把人加进知识库」和「改了知识库描述」在它眼里是同一种事。

   公司内部部署时，权限授予、导出、离职回收这三类必须有第二份记录。

   这个套件除了验「该记的都记了」，还特意验了一条**不该记的**：
   改个文档标题不进日志。日志如果什么都记，两周后就没人看了 ——
   而「全覆盖」本身又是个会误导人的假象。
   ============================================================ */

import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { chromium } from 'playwright'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.AUDIT_PORT || await freePort()
const BASE = `http://localhost:${PORT}`
const DB = `data/_audit-${Date.now().toString(36)}.db`
const PW = 'audit-test@2026'
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
const audit = (tk, qs = '') => json(`/api/audit${qs}`, { headers: { Authorization: 'Bearer ' + tk } })

try {
  await waitUp()

  console.log('\n== 全新库日志是空的 ==')
  const admin = (await post('/api/auth/login', { account: 'admin', password: PW })).data
  const T = admin.token
  const a0 = (await audit(T)).data
  ok(a0.items.length === 0, '新库一条日志都没有（不是塞了几条演示记录充数）', JSON.stringify(a0.items).slice(0, 120))
  ok(Array.isArray(a0.actions) && a0.actions.length > 0, '动作清单有内容（给界面做筛选下拉）', String(a0.actions?.length))

  console.log('\n== 权限授予要留痕 ==')
  const space = (await post('/api/spaces', { name: `审计用空间 ${SUF}` }, T)).data.space
  const out = (await post('/api/auth/register', { account: `au_b_${SUF}`, password: 'test1234', name: `被拉人${SUF}` })).data

  await post(`/api/spaces/${space.id}/members`, { userIds: [out.user.id], role: 'member' }, T)
  const a1 = (await audit(T)).data
  const add = a1.items.find((x) => x.action === 'space.member.add')
  ok(!!add, '加人进空间有日志', JSON.stringify(a1.items.map((x) => x.action)))
  ok(add?.actorId === admin.user.id, '记的是操作人（不是被操作的人）', String(add?.actorId))
  ok(add?.targetId === space.id, '记的是被改的那个空间', String(add?.targetId))
  ok(add?.targetName === space.name, '空间名字也记下来了（不然日志只有一串 id，读不懂）', String(add?.targetName))
  ok(add?.detail?.userId === out.user.id, 'detail 里记着被加进来的是谁', JSON.stringify(add?.detail))
  ok(Number(add?.at) > 0, '有时间戳', String(add?.at))

  await post(`/api/spaces/${space.id}/members`, { userIds: [out.user.id] }, out.token)
  const aDenied = (await audit(T)).data
  ok(aDenied.items.filter((x) => x.action === 'space.member.add').length === 1,
    '被拒的添加不写日志（不是先记上再判权限）', String(aDenied.items.length))

  await json(`/api/spaces/${space.id}/members/${out.user.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + T } })
  const a2 = (await audit(T)).data
  ok(a2.items.some((x) => x.action === 'space.member.remove'), '移出空间有日志',
    JSON.stringify(a2.items.map((x) => x.action)))

  console.log('\n== 数据外流要留痕 ==')
  const ex = await fetch(`${BASE}/api/export`, { headers: { Authorization: 'Bearer ' + T } })
  ok(ex.status === 200, '导出成功', String(ex.status))
  const a3 = (await audit(T)).data
  const exp = a3.items.find((x) => x.action === 'data.export')
  ok(!!exp, '导出整个工作台有日志', JSON.stringify(a3.items.map((x) => x.action)))
  ok(Number(exp?.detail?.bytes) > 0, '记了导出了多少字节', JSON.stringify(exp?.detail))

  console.log('\n== 改密码与离职要留痕 ==')
  await post('/api/auth/password', { oldPassword: PW, newPassword: 'audit-new@2026' }, T)
  const a4 = (await audit(T, `?action=user.password.change`)).data
  ok(a4.items.length === 1, '改密码有日志（按动作筛选能筛出来）', JSON.stringify(a4.items.map((x) => x.action)))

  const out2 = (await post('/api/auth/register', { account: `au_c_${SUF}`, password: 'test1234', name: `离职${SUF}` })).data
  const off = await post(`/api/users/${out2.user.id}/offboard`, {}, T)
  ok(off.status === 200, '办理离职成功', String(off.status))
  const a5 = (await audit(T, `?action=user.offboard`)).data
  ok(a5.items.length === 1, '办理离职有日志', JSON.stringify(a5.items.map((x) => x.action)))
  ok(a5.items[0]?.targetName?.includes('离职') || a5.items[0]?.detail?.account === `au_c_${SUF}`,
    '离职记录指明了是谁', JSON.stringify(a5.items[0]))

  console.log('\n== 日常内容改动**不**进日志 ==')
  const beforeDoc = (await audit(T)).data.items.length
  const doc = await post('/api/sync/push', {
    upsert: { docs: [{ id: 'd_aud', spaceId: space.id, title: '只是改了标题', authorId: admin.user.id, type: 'doc', blocks: [], wordCount: 0, createdAt: 1, updatedAt: Date.now() }] },
    remove: {},
  }, T)
  ok(doc.status === 200, '改标题成功', String(doc.status))
  const a6 = (await audit(T)).data
  // 相对断言，不写死条数：日志以后加了新动作，写死的数字就成了一种假约束
  ok(a6.items.length === beforeDoc, `改标题没有让日志变多（改前 ${beforeDoc} → 改后 ${a6.items.length}）`, String(a6.items.length))

  console.log('\n== 只有管理员能看 ==')
  const deny = await audit(out.token)
  ok(deny.status === 403, '普通成员调 /api/audit 被拒', String(deny.status))
  const anon = await json('/api/audit')
  ok(anon.status === 401, '没登录也拿不到', String(anon.status))

  console.log('\n== 重启之后还在 ==')
  try { kid.kill() } catch { /* 已退出 */ }
  await new Promise((r) => setTimeout(r, 800))
  kid = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  await waitUp()
  const admin2 = (await post('/api/auth/login', { account: 'admin', password: 'audit-new@2026' })).data
  ok(!!admin2.token, '改完密码能用新密码登录', JSON.stringify(admin2).slice(0, 80))
  const a7 = (await audit(admin2.token)).data
  ok(a7.items.length === a6.items.length, `重启后日志还在（重启前 ${a6.items.length} → 重启后 ${a7.items.length}）`, String(a7.items.length))

  console.log('\n== 界面上看得到 ==')
  const br = await chromium.launch()
  const ctx = await br.newContext()
  const p = await ctx.newPage()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', 'audit-new@2026')
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(1200)
  await p.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1200)

  ok((await p.locator('.yq-settings-nav button:has-text("操作日志")').count()) === 1, '管理员在设置里看得到「操作日志」')
  await p.click('.yq-settings-nav button:has-text("操作日志")')
  await p.waitForSelector('.yq-audit-row', { timeout: 15000 })
  await p.waitForTimeout(500)
  const rows = await p.locator('.yq-audit-row').count()
  // 和接口拿到的条数比，而不是和写死的数字比
  const apiCount = (await p.evaluate(async () => {
    const t = localStorage.getItem('yq_token') || ''
    const r = await fetch('/api/audit?limit=200', { headers: { Authorization: 'Bearer ' + t } })
    return (await r.json()).items.length
  }))
  ok(rows === apiCount, `界面上列出 ${rows} 条，和接口的 ${apiCount} 条一致`, `${rows} vs ${apiCount}`)
  const text = (await p.locator('.yq-audit-list').textContent().catch(() => '')) || ''
  ok(text.includes('加入空间成员'), '日志显示的是中文动作名（不是一串 action 标识）')
  ok(text.includes('导出数据'), '导出那一条也在')

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
