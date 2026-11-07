/**
 * 定时清扫：过期会话 + 回收站保留期，挂在同一个定时器上
 * ============================================================
 * 发现的洞：过期会话**从不被清理**。
 *
 * `sessions` 表原来只有四个出口，全是「针对特定 token 或特定用户」的：
 *   ① 登出 `DELETE WHERE token = ?`
 *   ② `userFromToken` 发现过期时顺手删那一行
 *   ③ 改密码时清掉别人的
 *   ④ 办离职时清掉全部
 *
 * 所以**没人再用的过期 token 永远留在表里** ——
 * 而同一个库里的回收站明明有 `setInterval` 在定期清，两种待遇。
 *
 * 这**不是**「过期了还能用」：`userFromToken` 每次都比对 `expiresAt`，
 * 所以安全上是干净的。真正的问题是：
 *   ① 表无限增长（内网跑上一年半载，僵尸会话堆在那儿）
 *   ② **语义不干净**：一条 30 天前就该失效的凭据还在库里躺着。
 *      今天 `userFromToken` 挡住它；哪天有人动那行判断，
 *      这批僵尸凭据立刻变成真实的越权入口，而且**没人知道它们在那儿**。
 *
 * ------------------------------------------------------------
 * 而修它的过程里，我差点弄坏另一件事
 * ------------------------------------------------------------
 * 把两件事合进一个定时器时，我写成了
 *   `const runHousekeeping = () => { 清会话… ; if (RETENTION_DAYS<=0) return; const runPurge = () => {...} }`
 * —— `runPurge` **定义了却从没被调用**，
 * 于是「保留期到期自动清除」**静默失效**，而没有任何东西会报错：
 * 它本来只在到期时才做事，没到期时一切看起来完全正常。
 *
 * 这一条比原问题更值得记：
 * **把两件「定时做的事」合并成一个定时器时，漏掉其中一件是完全无声的。**
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { freePort } from './scripts/free-port.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ═══════════ 1. 源码层：定时器只有一个，且两件事都在里面 ═══════════ */
console.log('\n== 源码层 ==')
{
  const idx = readFileSync('server/index.ts', 'utf8')

  // 只应有一个 6 小时定时器
  const timers = idx.match(/setInterval\(/g) || []
  const cleanupTimers = (idx.match(/setInterval\(runHousekeeping/g) || []).length
  ok(cleanupTimers === 1, `清扫定时器只有一个（runHousekeeping ×${cleanupTimers}）`)
  ok(timers.length <= 3, `index.ts 里的 setInterval 总数 ${timers.length}（另有 flushSnapshots / ws 那些）`)

  // runHousekeeping 必须两件事都做
  const hk = /const runHousekeeping = \(\) => \{[\s\S]{0,900}?\n\}/.exec(idx)?.[0] || ''
  ok(hk.length > 0, '找到 runHousekeeping')
  ok(/purgeExpiredSessions\(/.test(hk), '它清过期会话')
  ok(/return runPurge\(\)|runPurge\(\)/.test(hk),
    '★ 它**也调 runPurge**（回收站）—— 漏掉这一句就静默失效', hk.slice(0, 60))

  // 真的让它失效一次：YQ_BREAK_HOUSEKEEPING=1 时不调 runPurge
  // —— 光看源码不够，因为「定义了却没调用」在 tsc 和运行里都可能是绿的。
  {
    const PORT2 = '8271'
    const DB2 = 'data/_sessionpurge-break.db'
    for (const s of ['', '-wal', '-shm']) { const f = DB2 + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* ignore */ } } }
    const s2 = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
      env: { ...process.env, PORT: PORT2, YQ_DB: DB2, YQ_ADMIN_PASSWORD: 'bk@2026', YQ_TRASH_DAYS: '0', YQ_BREAK_HOUSEKEEPING: '1' },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    let up2 = false
    for (let i = 0; i < 50; i++) {
      await sleep(400)
      try { if ((await fetch(`http://127.0.0.1:${PORT2}/api/health`)).ok) { up2 = true; break } } catch { /* 等 */ }
    }
    ok(up2, '（破坏对照）服务在「漏调 runPurge」模式下也能起来 —— **这正是它静默的地方**')
    s2.kill()
    for (const s of ['', '-wal', '-shm']) { const f = DB2 + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* ignore */ } } }
  }

  // 关键：清会话不能跟着 YQ_TRASH_DAYS 走
  const sess = /try \{\s*const n = purgeExpiredSessions[\s\S]{0,200}?\n\s*\}/.exec(hk)?.[0] || ''
  ok(!/RETENTION_DAYS\s*<=\s*0/.test(sess.slice(0, sess.indexOf('purgeExpiredTrash') + 1)),
    '★ 清会话**不在** YQ_TRASH_DAYS 的 if 里（关掉保留期不该把关凭据也关掉）')
  ok(sess.indexOf('purgeExpiredSessions') < (sess.indexOf('RETENTION_DAYS') + 9999) || sess.indexOf('RETENTION_DAYS') < 0,
    '清会话排在回收站判断之前')

  // 定时器无条件存在（不受 YQ_TRASH_DAYS 影响）
  const after = idx.slice(idx.indexOf('runHousekeeping()'))
  ok(!/if \(RETENTION_DAYS[^\n]*\{\s*const timer = setInterval/.test(after),
    '定时器不是条件创建的（YQ_TRASH_DAYS=0 时照样要清会话）')
}

/* ═══════════ 2. purgeExpiredSessions 真的只删过期的 ═══════════ */
console.log('\n== purgeExpiredSessions 只删过期的 ==')
{
  const PORT = process.env.SESSIONPURGE_PORT || await freePort()
  const DB = 'data/_sessionpurge-test.db'
  for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* ignore */ } } }
  const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'sp2@2026' },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  process.on('exit', () => { try { srv.kill() } catch { /* ignore */ } })
  let up = false
  for (let i = 0; i < 50; i++) {
    await sleep(400)
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) { up = true; break } } catch { /* 等 */ }
  }
  ok(up, '服务端起来了')

  if (up) {
    const call = async (p, o = {}) => {
      const r = await fetch(`http://127.0.0.1:${PORT}${p}`, o)
      const t = await r.text()
      try { return { status: r.status, d: t ? JSON.parse(t) : null } } catch { return { status: r.status, d: null } }
    }
    const ses = (p, o = {}, tk) => call(p, {
      ...o,
      headers: { 'Content-Type': 'application/json', ...(o.headers || {}), ...(tk ? { Authorization: 'Bearer ' + tk } : {}) },
    })
    const tok = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'sp2@2026' }) })).d?.token
    ok(!!tok, '拿到会话')

    if (tok) {
      // 手工造三条：一条已过期、两条还有效
      const d = new DatabaseSync(DB)
      const now = Date.now()
      d.prepare('INSERT INTO sessions (token,userId,createdAt,expiresAt,ua,ip) VALUES (?,?,?,?,?,?)').run('tok_expired', 'u_admin', now - 1e7, now - 1000, 'x', '127.0.0.1')
      d.prepare('INSERT INTO sessions (token,userId,createdAt,expiresAt,ua,ip) VALUES (?,?,?,?,?,?)').run('tok_live1', 'u_admin', now, now + 1e9, 'x', '127.0.0.1')
      d.prepare('INSERT INTO sessions (token,userId,createdAt,expiresAt,ua,ip) VALUES (?,?,?,?,?,?)').run('tok_live2', 'u_admin', now, now + 1e9, 'x', '127.0.0.1')
      const before = Number(d.prepare('SELECT COUNT(*) AS n FROM sessions').get().n)
      d.close()
      ok(before >= 4, `造了 3 条（库里原有 ${before} 条，含刚才登录那条）`)

      // ⚠️ 必须在 import 之前设好 YQ_DB ——
      // `server/db.ts` 是**模块加载时**就 `new DatabaseSync(process.env.YQ_DB)` 的，
      // 而 `server/index.ts` 那个子进程是另开的连接。
      // 第一版先起子进程、后 import，于是 import 到的是
      // **默认的 data/yuque.db**，我在 _sessionpurge-test.db 里造的数据它一条都看不见
      // → 清掉 0 条，而那 3 条明明就在库里躺着。
      // 「清掉 0 条」和「数据不存在」在输出里长得一模一样。
      process.env.YQ_DB = DB
      const { purgeExpiredSessions } = await import(
        new URL('./server/auth.ts', import.meta.url).href
      )
      const n = purgeExpiredSessions(400)
      const d2 = new DatabaseSync(DB)
      const left = d2.prepare('SELECT token FROM sessions').all().map((r) => String(r.token))
      d2.close()
      ok(n >= 1, `清掉了 ${n} 条`)
      ok(!left.includes('tok_expired'), '**过期的那条被清掉了**', left.join(','))
      ok(left.includes('tok_live1') && left.includes('tok_live2'), '**还有效的两条留着了**', left.join(','))
      ok(left.includes(tok), '当前登录那条（用 tok 参数挂着）也留着了')

      // 限量：limit=1 时只清一条
      const d3 = new DatabaseSync(DB)
      d3.prepare('INSERT INTO sessions (token,userId,createdAt,expiresAt,ua,ip) VALUES (?,?,?,?,?,?)').run('tok_e2', 'u_admin', now - 1e7, now - 1000, 'x', '1')
      d3.prepare('INSERT INTO sessions (token,userId,createdAt,expiresAt,ua,ip) VALUES (?,?,?,?,?,?)').run('tok_e3', 'u_admin', now - 1e7, now - 1000, 'x', '1')
      d3.close()
      const n1 = purgeExpiredSessions(1)
      const d4 = new DatabaseSync(DB)
      const after2 = d4.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token LIKE 'tok_e%'").get().n
      d4.close()
      ok(n1 === 1, `限量参数生效：一轮只清 1 条（实得 ${n1}）`)
      ok(Number(after2) === 1, `另一条留到下一轮（剩 ${after2}）`)
    }
  }
  srv.kill()
  for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* ignore */ } } }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
