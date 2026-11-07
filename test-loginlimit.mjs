/* ============================================================
   密码登录必须限流
   ------------------------------------------------------------
   改之前的形态：注册敞开着（`YQ_SSO_ONLY` 默认 0，任何能连到这个
   端口的人都能注册 —— 注册本身不给数据，这一点是有意的），
   而种子管理员的口令是写在代码里的 `yuque@2026`。
   两件事叠起来 = **内网里任何人都能对 `/api/auth/login` 无限次穷举**。

   而同一个服务里，**对外分享的访问密码早就有「8 次 / 10 分钟」**。
   主登录不管、分享密码管，这个不对称没有任何道理。

   ------------------------------------------------------------
   键选 `账号|IP`（和分享密码的 `docId|ip` 同构）的原因，
   **这一节比断言本身更重要**，改键之前先想清楚：
   · 单独按账号 → 攻击者只要知道 `admin` 这个名字，就能把**所有人**
     锁在外面（拿限流当 DoS 用）；
   · 单独按 IP → **内网全员共享一个出口 IP 是常态**，任意一个人手滑
     8 次，整个办公室一起登不进来；
   · 账号 + IP → 攻击者猜 `admin` 只能锁住**他自己那个组合**，
 *   同一 NAT 后的同事各算各的。

   ------------------------------------------------------------
   每一节都必须**两半都验**：只验「挡住了」的话，
   把判定写成「一律拒绝」也全绿，而**所有人都登不进去**了。
   =================================================================== */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

const PORT = process.env.LOGINLIMIT_PORT || await freePort()
const PORT2 = process.env.LOGINLIMIT_PORT2 || '8244'
const DB = 'data/_loginlimit-test.db'
const DB2 = 'data/_loginlimit-sso.db'
const BASE = `http://localhost:${PORT}`
const PW = 'll-test@2026'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

for (const s of ['', '-wal', '-shm']) for (const d of [DB, DB2]) { const f = d + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }

/** 起一个服务；起不来就退出（不留半截库给下一轮） */
async function start(port, db, env = {}) {
  if (await fetch(`http://localhost:${port}/api/health`).then((r) => r.ok).catch(() => false)) {
    console.error(`端口 ${port} 上已经有服务在跑 —— 这轮会打在旧代码上，结果不可信。`)
    process.exit(1)
  }
  const p = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT: port, YQ_DB: db, YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0', ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`http://localhost:${port}/api/health`)).ok) return p } catch { /* 等 */ }
  }
  console.error(`服务没能在 20 秒内起来（${port}）`)
  try { p.kill() } catch {}
  process.exit(1)
}

const login = async (base, account, password, ip) => {
  const r = await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ip ? { 'X-Forwarded-For': ip } : {}) },
    body: JSON.stringify({ account, password }),
  })
  const t = await r.text()
  let d = null
  try { d = JSON.parse(t) } catch { /* 保留原文 */ }
  return { status: r.status, d, raw: t }
}
const reg = async (base, account, ip) => {
  const r = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ip ? { 'X-Forwarded-For': ip } : {}) },
    body: JSON.stringify({ account, password: 'test1234', name: account }),
  })
  return r.status
}

let srv = null, srv2 = null
try {
  srv = await start(PORT, DB)
  const ADMIN_IP = '198.51.100.10'
  const OTHER_IP = '198.51.100.11'
  await reg(BASE, 'bob', ADMIN_IP)

  console.log('\n== 基线：正常登录是通的（不然后面全是恒真 ==')
  ok((await login(BASE, 'admin', PW, ADMIN_IP)).status === 200, '口令正确时登录 200')

  console.log('\n== ① 连错 8 次之后，第 9 次（**口令正确**）必须被挡 ==')
  const codes = []
  for (let i = 0; i < 8; i++) codes.push((await login(BASE, 'admin', 'wrong-' + i, ADMIN_IP)).status)
  ok(codes.every((c) => c === 401), `前 8 次都是 401（实际 ${codes.join(',')}）`)
  const ninth = await login(BASE, 'admin', PW, ADMIN_IP)
  ok(ninth.status === 429, `第 9 次**拿着正确口令**也被挡（实际 ${ninth.status}）`, ninth.raw.slice(0, 80))
  ok(/10 分钟|次数过多/.test(ninth.raw), '并说清了要等多久（不是一句「错误」）', ninth.raw.slice(0, 80))

  console.log('\n== ② 锁定期内，另一个账号（同一 NAT）**不受影响** ==')
  const bob = await login(BASE, 'bob', 'test1234', ADMIN_IP)
  ok(bob.status === 200, `同 IP、不同账号照常登录（实际 ${bob.status}）`, bob.raw.slice(0, 80))
  ok(!!bob.d?.token, '而且真的拿到了令牌（不是「没报错」当成功）')

  console.log('\n== ③ 不存在的账号同样被计数（不泄露账号是否存在）==')
  /*
   * ⚠️ 第一版这里只打了 3 次就断言「第 9 次是 429」——
   * 而 3 次当然到不了阈值，于是断言红、看起来像代码没生效。
   * 实际上是我**把循环写漏了**。
   * 「断言红」有两种原因（代码错 / 判据本身没跑到），
   * 区分它们要靠把前置条件也断言出来 —— 这里就是把 8 次逐一打满。
   */
  const ghostCodes = []
  for (let i = 0; i < 8; i++) ghostCodes.push((await login(BASE, '查无此人xyz', 'whatever', OTHER_IP)).status)
  ok(ghostCodes.every((c) => c === 401), `不存在的账号前 8 次也都是 401（实际 ${ghostCodes.join(',')}）—— 和真实账号完全一样`)
  const ghost9 = await login(BASE, '查无此人xyz', 'whatever', OTHER_IP)
  ok(ghost9.status === 429, `第 9 次同样是 429（实际 ${ghost9.status}）—— 与真实账号**同样的节奏**，所以区分不出账号存不存在`, ghost9.raw.slice(0, 80))

  console.log('\n== ④ 换个 IP 就是另一份额度（内网换出口不该被连坐）==')
  const fresh = await login(BASE, 'admin', PW, '198.51.100.77')
  ok(fresh.status === 200, `换一个 IP 就能正常登录（实际 ${fresh.status}）`, fresh.raw.slice(0, 80))

  console.log('\n== ⑤ 登录成功会清掉计数，不会「攒着」 ==')
  {
    const ip = '198.51.100.88'
    await login(BASE, 'admin', 'w1', ip)
    await login(BASE, 'admin', 'w2', ip)
    ok((await login(BASE, 'admin', PW, ip)).status === 200, '错 2 次后正确登录 → 200')
    await login(BASE, 'admin', 'w3', ip)
    await login(BASE, 'admin', 'w4', ip)
    ok((await login(BASE, 'admin', PW, ip)).status === 200, '清零后又错 2 次再登录 → 仍 200（没被之前的失败次数算进去）')
  }

  console.log('\n== ⑥ SSO 模式下报的是 403，不是被限流盖掉 ==')
  {
    srv2 = await start(PORT2, DB2, { YQ_SSO_ONLY: '1' })
    const r = await login(`http://localhost:${PORT2}`, 'admin', PW, '198.51.100.10')
    ok(r.status === 403, `YQ_SSO_ONLY=1 时是 403（实际 ${r.status}）—— 限流不能把「走统一认证」这条路盖成 429`, r.raw.slice(0, 80))
    ok(!/次数过多/.test(r.raw), '错误信息是「只接受统一认证」而不是「次数过多」')
    for (let i = 0; i < 9; i++) await login(`http://localhost:${PORT2}`, 'admin', 'x', '198.51.100.10')
    ok((await login(`http://localhost:${PORT2}`, 'admin', PW, '198.51.100.10')).status === 403,
      '连打 9 次之后**仍然是 403**（SSO 闸门没有被计数影响）')
  }
} finally {
  try { srv?.kill() } catch {}
  try { srv2?.kill() } catch {}
  for (const s of ['', '-wal', '-shm']) for (const d of [DB, DB2]) { const f = d + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
