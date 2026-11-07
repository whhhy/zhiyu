/**
 * 同步推送的 payload 形状不对时，服务端整个事务回滚
 * ============================================================
 * `push()` 的 `run()` 原来直接 `for (const r of rows)`，于是
 * **`upsert` 里推进来一个对象就是 `TypeError: rows is not iterable`**：
 *
 *   · 抛到路由 → **HTTP 500**
 *   · `push` 外层 `catch` → `ROLLBACK` → **同一批次里的其他行一起没**
 *   · 而且 500 把「服务端坏了」和「你参数推错了」混成了一件事，
 *     客户端没法据此决定要不要重试
 *
 * 实测（探针，2026-10-05）：
 *   `{ bookMembers: [{ userId, bookId, role }] }`      → 200，写进去了
 *   `{ bookMembers: { b1: [{ id, role }] } }`          → **500 + 整批回滚**
 *
 * 第二种**就是客户端 store 里的真实形状**
 * （`bookMembers: Record<bookId, BookMember[]>`），
 * 只是客户端的 sync 引擎会先摊平成数组（`recordOfArray`）才推。
 * 所以网页端自己碰不到，但下面这三样都会：
 *   · 手写脚本调 `/api/sync/push`（README 就是这么教 API 用户的）
 *   · 导入数据包（`importBundle` 自己摊平，第三方包不保证）
 *   · 以后任何新客户端忘了摊平
 *
 * `remove` 那半边是**同一个洞**：
 *   `{ remove: { docs: 'd1' } }` —— 看着只像少写了两个括号，
 *   实际是一整个批次的改动被自己的手滑带下水。
 *
 * ------------------------------------------------------------
 * 修完之后的行为
 * ------------------------------------------------------------
 * 200 + 精确的 rejected：`这一项必须是一个数组（收到 对象），已跳过，未影响其他实体`。
 *
 * 「你推的形状不对」是**调用方**的错，不该让同批次其他人的改动一起回滚。
 * 这一条是本轮唯一一个**服务端**缺陷（前面几个都是权限判定），
 * 而它是**自己踩出来的**：探针的 push helper 写成 `.then((r) => r.d)`，
 * 把 status 丢了，于是 500 表现成 `applied=undefined rejected=undefined`
 * —— 形状和「返回空数组」不一样，但看代码的人极易读成后者。
 *
 * ------------------------------------------------------------
 * 两次破坏对照都验过
 * ------------------------------------------------------------
 * ① 撤掉 upsert 的 `!Array.isArray(rows)` → 17 通过 / **12 失败**，
 *    报错原样复现：`TypeError: rows is not iterable`（HTTP 500）
 * ② 撤掉 remove 的 `!Array.isArray(ids)` → 24 通过 / **5 失败**，
 *    报错原样复现：`TypeError: ids is not iterable`（HTTP 500）
 *
 * ② 单独验是有必要的：`remove` 那半边是**同一个洞**，
 * 而「同一个洞的两处」只修一处正是 7.23 记的那条老毛病。
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const PORT = process.env.PUSHSHAPE_PORT || await freePort()
const DB = 'data/_pushshape-test.db'
const BASE = `http://localhost:${PORT}`

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
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'ps@2026' },
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
  try { return { status: r.status, d: t ? JSON.parse(t) : null, raw: t } } catch { return { status: r.status, d: null, raw: t } }
}
const ses = (p, o = {}, tk) => call(p, { ...o, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) } })
const one = (sql, ...a) => { const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000'); const r = d.prepare(sql).get(...a); d.close(); return r }

const SFX = Math.random().toString(36).slice(2, 7)
const admin = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'ps@2026' }) })).d?.token
const acct = 'ps' + SFX
await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234', name: '普通成员' }) })
const tok = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234' }) })).d?.token
const me = (await ses('/api/v2/user', {}, tok)).d
const bk = (await ses('/api/entity/books', {}, admin)).d.rows[0]
ok(!!admin && !!me?.id && !!bk, `前置：${me?.id} / ${bk?.id}`)

/** push：status 与 applied/rejected 一起返回，**不能只返回 .d** */
const push = async (tk, body) => {
  const r = await ses('/api/sync/push', { method: 'POST', body: JSON.stringify(body) }, tk)
  return { status: r.status, applied: r.d?.applied, rejected: r.d?.rejected, error: r.d?.error }
}
const mkDoc = (id) => ({ id, bookId: bk.id, title: '形状测试 ' + id, body: 'x', wordCount: 1, createdAt: Date.now(), updatedAt: Date.now() })

/* ============ 基准：正常数组形状 ============ */
console.log('\n== 基准：数组形状一切正常 ==')
{
  const r = await push(admin, { upsert: { docs: [mkDoc('dok' + SFX)] }, remove: {} })
  ok(r.status === 200, `HTTP ${r.status}`)
  ok((r.applied?.length || 0) === 1, '写进去了')
  ok((r.rejected?.length || 0) === 0, '没有拒绝')
}

/* ============ upsert 里推进来对象 ============ */
console.log('\n== upsert 里推进来对象（客户端 store 的嵌套形状）==')
{
  // 同一批里放一行**正常**的 docs：它必须活下来
  const good = 'dgood' + SFX
  const r = await push(admin, {
    upsert: {
      docs: [mkDoc(good)],
      bookMembers: { [bk.id]: [{ id: me.id, role: 'editor', perms: {}, joinedAt: Date.now() }] },
    },
    remove: {},
  })
  ok(r.status === 200, `不再是 500（HTTP ${r.status}）`, String(r.error || ''))
  ok((r.rejected?.length || 0) === 1, '精确拒了这一项', JSON.stringify(r.rejected))
  ok(String(r.rejected?.[0]?.reason || '').includes('数组'), '理由说清「必须是数组」', r.rejected?.[0]?.reason)
  ok(String(r.rejected?.[0]?.reason || '').includes('未影响其他实体'), '并说清没连累别人')
  // **关键**：同一批里那行正常的 docs 必须真落库
  ok(!!one('SELECT 1 AS x FROM docs WHERE id = ?', good), '同批次的正常行照样落库了（没被回滚）')
}

/* ============ remove 里传字符串 ============ */
console.log('\n== remove 里传字符串（少写两个括号）==')
{
  const keep = 'dkeep' + SFX
  const r = await push(admin, {
    upsert: { docs: [mkDoc(keep)] },
    remove: { docs: 'dok' + SFX },
  })
  ok(r.status === 200, `不再是 500（HTTP ${r.status}）`, String(r.error || ''))
  ok((r.rejected?.length || 0) === 1, '精确拒了这一项', JSON.stringify(r.rejected))
  ok(!!one('SELECT 1 AS x FROM docs WHERE id = ?', keep), '同批次的正常行照样落库了')
  ok(!!one('SELECT 1 AS x FROM docs WHERE id = ?', 'dok' + SFX), '而那篇本该被删的还在（没被误删）')
}

/* ============ 各种别的形状 ============ */
console.log('\n== 别的形状也都只拒这一项 ==')
for (const [label, body] of [
  ['upsert 里是字符串', { upsert: { docs: 'd1' }, remove: {} }],
  ['upsert 里是数字', { upsert: { docs: 42 }, remove: {} }],
  ['upsert 里是 null', { upsert: { docs: null }, remove: {} }],
  ['remove 里是对象', { upsert: {}, remove: { docs: { a: 1 } } }],
  ['remove 里是 null', { upsert: {}, remove: { docs: null } }],
]) {
  const r = await push(admin, body)
  ok(r.status === 200, `${label} → 200 而不是 500（实得 ${r.status}）`, String(r.error || ''))
  ok((r.rejected?.length || 0) >= 1, `${label} 有明确的拒绝理由`, JSON.stringify(r.rejected))
}

/* ============ 未知实体仍然是「未知实体」 ============ */
console.log('\n== 未知实体照旧，别被新分支抢走 ==')
{
  const r = await push(admin, { upsert: { nosuchEntity: [{ id: 'x' }] }, remove: {} })
  ok(r.status === 200, `HTTP ${r.status}`)
  ok(String(r.rejected?.[0]?.reason || '') === '未知实体', '理由仍是「未知实体」', JSON.stringify(r.rejected))
}

/* ============ 普通用户推错形状，不该拿到 500 更不该 403 ============ */
console.log('\n== 普通用户推错形状 ==')
{
  const r = await push(tok, { upsert: { bookMembers: { [bk.id]: [{ id: me.id, role: 'owner' }] } }, remove: {} })
  ok(r.status === 200, `形状问题不该 500（HTTP ${r.status}）`)
  ok((r.rejected?.length || 0) === 1, '拒了这一项', JSON.stringify(r.rejected))
  ok(String(r.rejected?.[0]?.reason || '').includes('数组'), '理由是形状问题，不是权限问题')
  // 确认没有偷偷写入
  ok(!one('SELECT 1 AS x FROM book_members WHERE bookId = ? AND userId = ?', bk.id, me.id), '没偷偷写入')
}

await cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
