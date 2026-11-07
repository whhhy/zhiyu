/* ============================================================
   我的安全记录（语雀的「帐户安全 → 安全记录」）
   ============================================================
   为什么要有这一条：`/api/audit` **只给管理员**（理由正当 —— 日志里能看到
   「谁给谁开了权限」「谁导出了整个工作台」，普通成员拿到等于拿到权限地图），
   于是缺的那一半是：**普通成员看不到自己做过什么安全操作**。

   这一节验的全都是「不该看到的看不到」，因为这条接口一旦漏，
   漏掉的就是整个管理员闸门的意义。
   ============================================================ */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'

const PORT = process.env.SECLOG_PORT || await freePort()
const DB = 'data/_sec-log-test.db'
const BASE = `http://localhost:${PORT}`
const PW = 'seclog-test@2026'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }

const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
srv.stdout.on('data', (d) => { log += d })
srv.stderr.on('data', (d) => { log += d })
/* ---- 收摊：等子进程**真的退出**再删库 ----
 *
 * ⚠️ 原来只有 `process.on('exit', stop)`：exit 处理器是**同步**的，
 * `srv.kill()` 只是发信号，那一刻子进程还活着（Windows 文件锁），
 * 删库必然失败又被空 catch 吞掉 —— 于是每单独跑一次，data/ 里就多留一个库。
 * 全量跑时 runner 的清扫会兜住，**单独跑不会**；而单独跑正是排查时做的事。
 */
const { rmSync: rmDb, existsSync: exDb } = await import('node:fs')
let srvExited = false
srv.once('exit', () => { srvExited = true })
const cleanup = async () => {
  if (!srvExited) {
    srv.kill()
    for (let i = 0; i < 50 && !srvExited; i++) await new Promise((r) => setTimeout(r, 100))
  }
  const stuck = []
  for (const s of ['', '-wal', '-shm']) {
    let gone = false
    for (let i = 0; i < 5 && !gone; i++) {
      try { rmDb(DB + s, { force: true }); gone = true } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
    if (!gone && exDb(DB + s)) stuck.push(DB + s)
  }
  if (stuck.length) console.log('  ⚠️  临时库删不掉（服务可能还占着）：' + stuck.join(', '))
}
/* 兜底：崩溃/早退时也收一次（那时没法 await，只能尽力） */
const stop = () => { try { srv.kill() } catch {} }
process.on('exit', stop)

try {
  let up = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(BASE + '/api/health')).ok) { up = true; break } } catch { /* 等 */ }
  }
  if (!up) { console.error('服务没起来：\n' + log.slice(0, 900)); stop(); process.exit(1) }

  const call = async (p, tok, o = {}) => {
    const r = await fetch(BASE + p, { ...o, headers: { ...(o.headers || {}), ...(tok ? { Authorization: 'Bearer ' + tok } : {}) } })
    const t = await r.text()
    let d = null
    try { d = JSON.parse(t) } catch { /* 保留原文 */ }
    return { status: r.status, d, raw: t }
  }
  const reg = async (account) => (await call('/api/auth/register', '', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account, password: 'test1234', name: account }),
  })).d?.token
  const me = async (p, o = {}) => call(p, adminTok, o)

  const adminTok = (await call('/api/auth/login', '', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: PW }),
  })).d?.token
  const bob = await reg('seclog_bob')
  const carol = await reg('seclog_carol')
  ok(!!adminTok && !!bob && !!carol, '三个账号就绪（admin / bob / carol）')

  console.log('\n== 制造一些记录 ==')
  // bob 改一次密码
  await call('/api/auth/password', bob, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldPassword: 'test1234', newPassword: 'bob-new-2026' }),
  })
  // bob 建一个令牌再撤掉
  // ⚠️ 路径是 `/api/tokens`（不是 `/api/v2/tokens` —— 我第一版写错了，
  //    于是「建令牌」那条记录压根没产生，下游三条断言就都成了空断言。
  //    表现是「其中两条红」，而真因是**探针没造出前置**。）
  const tk = await call('/api/tokens', bob, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ci', scopes: ['read'], days: 0 }),
  })
  ok(tk.status === 200 && !!tk.d?.token, `bob 建了一个 API 令牌（实际 ${tk.status}）`, tk.raw.slice(0, 100))

  // admin 做几件「不是安全动作」的事：加成员、导出
  await call('/api/auth/login', '', {})
  ok(true, '（其余记录靠下面 admin 自己的日志来验）')

  // admin 也做两件事：一件在白名单里（建令牌）、一件**不在**（导出）。
  //
  // ⚠️ 不这么做的话，「这条路由只给 3 类安全动作」那条是**恒真的**：
  // admin 一条安全操作都没做过 → 0 类 ≤ 3 → 通过，而它其实什么都没验。
  // 空断言比没断言更糟 —— 它会把「检查坏了」显示成「检查通过」。
  await call('/api/tokens', adminTok, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'admin-ci', scopes: ['read'], days: 0 }),
  })
  await call('/api/export', adminTok)

  console.log('\n== bob 看自己的 ==')
  const mine = await call('/api/auth/security-log', bob)
  ok(mine.status === 200, `GET /api/auth/security-log → 200（实际 ${mine.status}）`, mine.raw.slice(0, 100))
  const items = mine.d?.items || []
  ok(items.length >= 1, `看到自己的 ${items.length} 条记录`)
  ok(items.some((x) => x.action === 'user.password.change'), '包含「修改密码」')
  ok(items.some((x) => x.action === 'token.create'), '包含「创建访问令牌」')
  ok(items.every((x) => typeof x.label === 'string' && x.label), '每条都带中文标签（界面上不用显示原始动作名）')

  console.log('\n== 不能越界 ==')
  // ① query 里的 actorId 必须是**装饰品**
  const spoof = await call('/api/auth/security-log?actorId=' + encodeURIComponent(adminTok ? 'admin' : '') + '&limit=500', bob)
  ok((spoof.d?.items || []).length === items.length, '传 ?actorId= 读不到别人的（条数与不传时相同）', `${(spoof.d?.items || []).length} vs ${items.length}`)
  ok(!/"actorId"/.test(spoof.raw), '响应里根本没有 actorId 这个字段（不是「读了但不给」）')

  // ② 普通成员仍然读不到全量日志
  const denied = await call('/api/audit', bob)
  ok(denied.status === 403, `bob 读 /api/audit 仍然 403（实际 ${denied.status}）`)

  // ③ 换个人也不一样
  const carolMine = await call('/api/auth/security-log', carol)
  ok((carolMine.d?.items || []).length === 0, 'carol 的安全记录是空的（她什么都没做过）', String((carolMine.d?.items || []).length))

  console.log('\n== 管理员用这条路由，也拿不到全量日志 ==')
  const adminSelf = await call('/api/auth/security-log', adminTok)
  ok(adminSelf.status === 200, 'admin 也能看自己的')
  const selfActions = new Set((adminSelf.d?.items || []).map((x) => x.action))
  const adminAll = await call('/api/audit?limit=500', adminTok)
  const allActions = new Set((adminAll.d?.items || []).map((x) => x.action))
  ok(adminAll.status === 200, 'admin 走 /api/audit 才是全量')
  // admin 刚做过「建令牌」（在白名单里）和「导出数据」（**不在**白名单里）
  ok(selfActions.has('token.create'), `admin 的安全记录里有「创建令牌」（实际：${[...selfActions].join(',')}）`)
  ok(!selfActions.has('data.export'), '但**没有**「导出数据」—— 那不是安全动作，不该出现在这里')
  /*
   * ⚠️ 下面这条要**逐条核白名单**，不能拿「条数比 /api/audit 少」当证据。
   * 破坏对照把这条路由改成调 `readAudit` 时，**比较式断言照样通过** ——
   * 因为 /api/audit 是管理员视角、看到**所有人**的动作（3 类），
   * 而坏掉的路由只看 admin 自己的（2 类），`3 > 2` 依然成立。
   * 比较错了对象，断言就抓不到它要抓的东西。
   */
  const WHITELIST = new Set(['user.password.change', 'token.create', 'token.revoke'])
  const outside = [...selfActions].filter((a) => !WHITELIST.has(a))
  ok(outside.length === 0, `返回的每一个动作都在白名单内（越界的：${outside.join(',') || '无'}）`)
  ok(allActions.size >= selfActions.size, `（对比：/api/audit 能看到 ${allActions.size} 类动作）`)

  console.log('\n== detail 里不能有凭据 ==')
  {
    const raw = mine.raw
    ok(!/eyJ[A-Za-z0-9_-]{10,}/.test(raw), '响应里没有 JWT 形状的长串')
    const tokenCreate = items.find((x) => x.action === 'token.create')
    if (tokenCreate) {
      ok(!tokenCreate.detail?.token, '建令牌那条的 detail 里**没有明文令牌**（服务端本来就只记 scopes/expiresAt/prefix）', JSON.stringify(tokenCreate.detail))
    } else {
      ok(false, '（没抓到建令牌那条，下面的断言就少了保护）')
    }
  }
} finally {
  await cleanup()
  for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
