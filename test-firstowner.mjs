/* ============================================================
   「第一个进门的人」只能有一个 owner
   ============================================================
   守的是一条不变量：**并发首登之后，从门进来的人里恰好一个 owner**。

   ------------------------------------------------------------
   ⚠️ 这个套件**曾经被我写成一个错误结论的证据**，这里把经过如实留着：
   写它的时候，我读代码发现「判权（查有没有 owner / 有没有 SSO 用户）」
   和「插入」是分开的两步、不在一个事务里，于是判成「并发首登会产出两个 owner」，
   并按「修了一个漏洞」的口径写了解释和测试。

   **实测推翻了这个结论**：把事务撤掉、连跑 8 轮「6 个人同时首登」，
   SSO owner **一次都没超过 1 个**。原因是注册与 SSO 首登这两个处理器
   **一个 `await` 都没有**（`async` 但全同步），Node 单线程事件循环
   不会在它中间插进另一个请求 —— 那个竞争在当前架构下**不可达**。

   所以这一套的定位是：
   · 运行时那几轮 = **不变量守门**。它不证明「当时抓到了什么」，
     它保证以后**不管**架构怎么变，这条都还成立。
   · 下面那几条**源码层**断言 = 确定性证据：判据必须在 `BEGIN IMMEDIATE` 里求值。
     这一条不管运行时撞不撞得上都成立。
   · 事务本身是**防御性加固**：不可达 ≠ 安全，只差「有人加了个 await」
     或「将来多进程」这一步之遥，而症状是两个平台 owner、**不留任何痕迹**。

   这也是本项目记过的那条的一个新例子：**读代码推出一个「并发缺陷」，
   和它真的能被触发，是两件事** —— 而只有实测能分开它们。
   =================================================================== */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.FIRSTOWNER_PORT || await freePort()
const DB = 'data/_firstowner-test.db'
const BASE = `http://localhost:${PORT}`
const ROUNDS = Number(process.env.FIRSTOWNER_ROUNDS || 6)
const CONCURRENCY = 6

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function start() {
  const p = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: {
      ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'fo@2026', YQ_DEMO: '0',
      YQ_SSO_HEADER: 'X-Forwarded-User', YQ_SSO_ONLY: '1', YQ_TRUST_PROXY: '1',
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try { if ((await fetch(BASE + '/api/health')).ok) return p } catch { /* 等 */ }
  }
  console.error('服务没能在 20 秒内起来')
  try { p.kill() } catch {}
  process.exit(1)
}

function countSsoOwners() {
  const d = new DatabaseSync(DB)
  d.exec('PRAGMA busy_timeout = 5000')
  const n = Number(d.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND viaSso = 1").get().n)
  const total = Number(d.prepare('SELECT COUNT(*) AS n FROM users').get().n)
  d.close()
  return { owners: n, total }
}

/** 一轮：N 个人同时从门进来 */
async function oneRound(round) {
  /*
   * ⚠️ 每轮必须**从干净库开始**。
   * 第一版没清 —— 于是第 1 轮之后库里已经有 viaSso 的用户，
   * `noSsoUserYet` 恒为假，后面 5 轮**一个人 owner 都拿不到**，
   * 输出却显示「SSO owner 1 个」（第 1 轮留下的）。
   * 也就是说 6 轮里只有 1 轮在测那个竞争，另外 5 轮是**恒真的**。
   * 「看不出异常」和「没在测」在结果上完全一样 ——
   * 是「每轮角色全是 member、而 owner 数恰好等于上一轮留下的那个」这个细节暴露的。
   */
  for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }
  const srv = await start()
  try {
    // ⚠️ 真的并发：一次性把请求全打出去，而不是一个个 await
    const people = Array.from({ length: CONCURRENCY }, (_, i) => `race${round}_${i}`)
    const results = await Promise.all(people.map((who) =>
      fetch(BASE + '/api/auth/sso', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-User': who },
        body: '{}',
      }).then(async (r) => ({ who, status: r.status, body: await r.json().catch(() => null) })),
    ))
    const roles = results.map((r) => r.body?.user?.role)
    const { owners, total } = countSsoOwners()
    return { owners, total, roles, statuses: results.map((r) => r.status) }
  } finally {
    try { srv.kill() } catch {}
    await sleep(200)
  }
}

try {
  console.log(`== 运行时不变量：${ROUNDS} 轮 × 每轮 ${CONCURRENCY} 人同时首登 ==`)
  let worst = 0
  const detail = []
  for (let r = 1; r <= ROUNDS; r++) {
    const res = await oneRound(r)
    worst = Math.max(worst, res.owners)
    detail.push(`第 ${r} 轮：SSO owner ${res.owners} 个 / 库里共 ${res.total} 人，角色 ${res.roles.join(',')}`)
    // 每轮都必须服务起来、每个人都拿到令牌
    if (res.statuses.some((s) => s !== 200)) detail.push(`   ⚠️ 第 ${r} 轮有人没登录成功：${res.statuses.join(',')}`)
  }
  for (const d of detail) console.log('   ' + d)
  ok(worst === 1, `每一轮都**恰好一个** SSO owner（最多观测到 ${worst} 个）`)

  console.log('\n== 源码层：判据必须在事务内求值（这条是确定性的）==')
  {
    const a = readFileSync('server/auth.ts', 'utf8')
    const i = a.indexOf('export function createUserWithSpace')
    const fn = i < 0 ? '' : a.slice(i, a.indexOf('\nexport ', i + 10))
    ok(fn.length > 0, `（能取到 createUserWithSpace）`, `长度 ${fn.length}`)
    const beginAt = fn.indexOf("db.exec('BEGIN IMMEDIATE')")
    const decideAt = fn.indexOf('opts.decideRole?.()')
    const countAt = fn.indexOf("SELECT COUNT(*) AS n FROM users")
    ok(beginAt >= 0, '函数里有 BEGIN IMMEDIATE')
    ok(beginAt < decideAt && beginAt < countAt,
      '**「判据」在 BEGIN 之后求值**（事务外查、事务内插 = 修了个寂寞）',
      `BEGIN@${beginAt} decideRole@${decideAt} count@${countAt}`)
    ok(/ROLLBACK/.test(fn), '失败会 ROLLBACK（不会留下建了用户但没空间的半截状态）')
    ok(/decideRole\?:/.test(a), '并提供了 decideRole 钩子，让调用方把判据传进来而不是传结果')

    const idx = readFileSync('server/index.ts', 'utf8')
    ok(/decideRole:\s*\(\)\s*=>/.test(idx), '统一认证那条路确实用的是 decideRole（不是先算好再传 role）')
    ok(!/const needOwner =/.test(idx), '而且事务外那段预计算已经删掉了')
  }

  console.log(`\n说明：运行时那 ${ROUNDS} 轮是**不变量守门**，不是「当时抓到 bug 的证据」——`)
  console.log('那个窗口在两次 SELECT 之间是微秒级，能不能撞上取决于机器与并发度。')
  console.log('真正确定性的是上面那几条源码层断言。')
} finally {
  for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
