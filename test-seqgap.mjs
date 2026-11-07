/**
 * 增量拉取超过 LIMIT 时，客户端会**永久丢掉**一段变更
 * ============================================================
 * `changesSince` 里写着 `LIMIT 2000`，但返回给客户端的游标是
 *
 *     return { seq: currentSeq(), upsert, remove }
 *
 * `currentSeq()` 是 `changes` 表的**全局最大值**。
 *
 * 于是：待拉取超过 2000 条时，服务端只发了前 2000 条，
 * 却告诉客户端「你已经同步到最新的了」。客户端那边是
 *
 *     seq = Math.max(seq, delta.seq)
 *
 * 无条件采信 —— 下一轮从最大值往后问，**中间那一段永远不会被送到**。
 * 不报错、不告警、界面上什么异常都看不出来。
 *
 * 为什么这不是理论问题：这正是内网部署最典型的场景 ——
 * 一台笔记本周末关机，周一打开时同事已经写了上千条。
 *
 * ------------------------------------------------------------
 * 这个套件钉的是**性质**，不是某个具体实现
 * ------------------------------------------------------------
 * 断言写成「分两轮拉，能把 2100 条全部覆盖」，
 * 而不是「seq 必须等于某个具体公式」——
 * 以后有人改成加分页标志或换实现，这条断言照样成立。
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const PORT = process.env.SEQGAP_PORT || await freePort()
const DB = 'data/_seqgap-test.db'
const BASE = `http://localhost:${PORT}`
const LIMIT = 2000
const EXTRA = 100 // 待拉取总数 = LIMIT + EXTRA

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch {} } }
if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在跑 —— 这轮会打在旧代码上，结果不可信。`)
  process.exit(1)
}
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'sg@2026' },
  stdio: ['ignore', 'ignore', 'ignore'],
})
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
let up = false
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break } } catch { /* 等 */ }
}
if (!up) { console.error('服务没能在 20 秒内起来'); stop(); process.exit(1) }

const call = async (p, o = {}) => {
  const r = await fetch(BASE + p, o)
  const t = await r.text()
  try { return { status: r.status, d: t ? JSON.parse(t) : null } } catch { return { status: r.status, d: null, raw: t.slice(0, 120) } }
}
const ses = (p, o = {}, tk) => call(p, { ...o, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) } })
const exec = (sql, ...a) => { const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000'); const r = d.prepare(sql).run(...a); d.close(); return r }
const one = (sql, ...a) => { const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000'); const r = d.prepare(sql).get(...a); d.close(); return r }

const admin = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'sg@2026' }) })).d?.token

console.log('\n== 前置 ==')
const doc = (await ses('/api/entity/docs', {}, admin)).d?.rows?.[0]
const head0 = Number(one('SELECT COALESCE(MAX(seq),0) AS s FROM changes').s)
ok(!!admin && !!doc?.id, `身份与文稿：${doc?.id}`)
// ⚠️ 刻意**不**断言 `head0 > 0`：种子是 `seed.ts` 直插的、**不走同步**，
// 所以新建的库里 changes 表本来就是空的（实测 head=0）。
// 早先写成断言「表非空」，结果这条自己红了 —— 而它其实在讲另一件事。
// 这里要的只是「有个基准点」，0 完全可以。
ok(head0 >= 0, `基准点 head0=${head0}（新建库的 changes 表是空的，种子不走同步）`)
if (!doc?.id) { console.log('\n前置不成立，退出。'); stop(); process.exit(fail ? 1 : 0) }

// 灌 LIMIT + EXTRA 条变更日志，全指向这一篇（每条都会在增量里落成一行）
{
  const d = new DatabaseSync(DB)
  d.exec('PRAGMA busy_timeout = 5000')
  const ins = d.prepare('INSERT INTO changes (entity, entityId, op, rev, actorId, at) VALUES (?,?,?,?,?,?)')
  d.exec('BEGIN')
  for (let i = 0; i < LIMIT + EXTRA; i++) ins.run('docs', String(doc.id), 'upsert', 1, 'seed', Date.now())
  d.exec('COMMIT')
  d.close()
}
const head = Number(one('SELECT COALESCE(MAX(seq),0) AS s FROM changes').s)
const pending = head - head0
ok(pending === LIMIT + EXTRA, `新灌了 ${pending} 条待拉取（head ${head0} → ${head}）`)

const pull = async (since) => (await ses(`/api/sync/changes?since=${since}`, {}, admin)).d || {}

console.log('\n== 第一轮：拉一次 ==')
let d1 = {}
{
  d1 = await pull(head0)
  const rows = d1?.upsert?.docs?.length || 0
  ok(rows === LIMIT, `发了 ${rows} 条（= LIMIT ${LIMIT}，服务端确实截断了）`, `期望 ${LIMIT}`)
  /*
   * 这一条在写这个套件时是**反的** —— 我照着有 bug 的行为写的断言
   * （`seq === head` 算通过），因为当时就是为了把 bug 显示出来。
   * 修好之后必须反过来：截断了就**不能**宣称已经到 head。
   *
   * 「照着错误行为写断言」这件事本身很容易漏 —— 套件是绿的、
   * 标题写着「但游标直接跳到了 head」、结果是 FAIL，
   * 三者互相矛盾，最后才看出是断言的方向错了，不是代码又坏了。
   */
  ok(d1?.seq !== head,
    `游标**没有**跳到 head（回的是 ${d1?.seq}，head=${head}）`,
    d1?.seq === head ? '—— 客户端会以为已同步完，中间那段永远拿不到' : '')
  ok(d1?.more === true, `并明确说了「还有更多」（more=${d1?.more}）—— 客户端可立刻续拉`)
  ok(d1?.seq === LIMIT, `游标 = 扫到的最后一条（${d1?.seq}）`)
}

console.log('\n== 第二轮：拿第一轮回的游标继续拉 ==')
{
  const d2 = await pull(d1?.seq ?? head0)
  const rows2 = d2?.upsert?.docs?.length || 0
  ok(rows2 === EXTRA,
    `补齐了剩下 ${rows2} 条（期望 ${EXTRA}）`,
    rows2 === 0 ? '—— 第一轮已经宣称同步到 head，这一段永远丢了' : '')
  ok(d2?.seq === head, `第二轮才到达 head（${d2?.seq}）`)
  ok(d2?.more === false, `第二轮 more=${d2?.more}（已经发完了）`)
  ok(LIMIT + rows2 === LIMIT + EXTRA, `两轮合计覆盖全部 ${LIMIT + rows2} / ${LIMIT + EXTRA} 条`)
}

console.log('\n== 客户端那一侧 ==')
{
  const src = readFileSync('src/lib/sync.ts', 'utf8')
  ok(/seq = Math\.max\(seq, delta\.seq\)/.test(src),
    '客户端是 `seq = Math.max(seq, delta.seq)` —— 服务端给什么就信什么，没有分页概念')
  ok(/if \(!delta\.more\) return/.test(src),
    '**它会看 `more` 并接着拉**，而不是干等下一个轮询周期',
    '—— 服务端一次最多给 2000 条，不续拉的话离线久的设备要等好几轮才追得完')
  ok(/MAX_CATCHUP_ROUNDS/.test(src) && /round < MAX_CATCHUP_ROUNDS/.test(src),
    '**续拉有硬上限**（防的是服务端一直回 more 时的死循环，不是「保险」）')
  ok(/if \(polling\) return/.test(src) && /finally \{\s*polling = false/.test(src),
    '**poll() 不会重入**（定时器 + 窗口聚焦可能同时叫；加了循环之后窗口长了几十倍，'
    + '两个请求抢同一个 seq 游标就会跳段）')
  ok(/more\?: boolean/.test(readFileSync('src/lib/api.ts', 'utf8')),
    '拉取函数的返回类型里有 `more`（不是靠 any 蒙混过去的）')
}

console.log('\n== 服务端那一侧的源码层 ==')
{
  const src = readFileSync('server/sync.ts', 'utf8')
  const at = src.indexOf('export function changesSince')
  const fn = src.slice(at, at + 9000)
  /*
   * `Delta` 接口声明在 `changesSince` **上方** —— 第一版我只在函数体往后
   * 9000 字里找 `more: boolean`，于是这条恒为失败。
   * 「按锚点取一段窗口再匹配」正是本项目记过最多次的坑：窗口取窄了不是报错，
   * 而是**静默地什么都没匹配到**，看起来像「代码没写」。
   * 所以这里查全文，别查窗口。
   */
  const deltaIf = src.slice(Math.max(0, src.indexOf('export interface Delta')), src.indexOf('}', src.indexOf('export interface Delta')))
  ok(/more:\s*boolean/.test(deltaIf), '`Delta` 接口声明了 `more: boolean`')
  ok(/it\s*\)/.test(deltaIf) || /无视这个字段|不会丢数据/.test(deltaIf),
    '注释里写明了「即使客户端无视它也不会丢数据」（正确性由 seq 保证，不靠这个字段）')
  ok(/const scannedTo = logs\.length \? Number\(logs\[logs\.length - 1\]\.seq\)/.test(fn),
    '游标取「扫到的最后一条」，不是全局最大值')
  ok(/seq: more \? scannedTo : head/.test(fn), '**没发完就只报到扫到的位置**')
  ok(!/return \{ seq: currentSeq\(\), upsert, remove/.test(fn), '不再是 `seq: currentSeq()`')
  // 被判据 continue 掉的日志行：游标必须跨过它们，否则客户端会一直卡在同一段
  ok(/const scannedTo = logs\.length \?/.test(fn) && /logs\[logs\.length - 1\]/.test(fn),
    '游标跨过**所有扫过的**日志行（含被过滤掉的）—— 否则客户端每次都问同一段、永远过不去')
}

await cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
