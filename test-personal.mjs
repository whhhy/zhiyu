/**
 * personal 实体的行定位以前不带归属：任何登录用户能删掉/覆盖别人的收藏、
 * 关注、最近浏览，而服务端回的是 `applied` + **零拒绝**。
 * ============================================================
 * `recents` / `favorites` / `follows` 的主键里**没有 userId**
 * （`recents` 的主键干脆就是 `docId`），而：
 *
 *   · `upsertRow` 查 existing 只按 `def.pk` → **B 记一次最近浏览，
 *     命中了 A 的那一行**，走 UPDATE + `extra.userId = B` → **A 的被顶掉**
 *   · `deleteRow` 的 where 也只按 `def.pk` → **B 推一条 remove，
 *     A 和 B 的两行一起没**
 *   · 而 `denyReason` 第一行 `if (def.personal) return null` 又是放行的
 *
 * 三样凑在一起 = 完整的越权写。而且**没有任何报错**。
 * `docId` 在任何文档 URL 里都公开，所以「删最近浏览」这条**人人能触发**；
 * 收藏 / 关注的 id 是随机 `uid()` 不易猜，但「知道就能删」已经足够。
 *
 * ------------------------------------------------------------
 * ⚠️ 探针版本：第一版造数据就造错了，结论只对了一半
 * ------------------------------------------------------------
 * 第一版不检查「A 的那行到底写进去没有」就往下走。
 * 而 A 那行**从一开始就没存在过**（被 C 顶掉了），
 * 于是「C 删完之后 A 也不见了」看起来成立，其实验的是
 * **一个本来就为空的集合**。
 *
 * 结论没错（真被删了），但它**只证明了 deleteRow 那一半** ——
 * 另一半（upsert 覆盖）被自己的造数据 bug 盖住了。
 * 当时我照着探针只改了 `deleteRow`，**漏了 `upsertRow`**。
 *
 * 所以这个套件的第一条断言是**前置**：
 * 两人各记一次之后，`recents` 必须真的有两行。不成立就当场退出，
 * 宁可报「前置不成立」也不在错的前提上往下验。
 * ============================================================
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const PORT = process.env.PERSONAL_PORT || await freePort()
const DB = 'data/_personal-test.db'
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
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'personal@2026' }, stdio: ['ignore', 'ignore', 'ignore'],
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
  try { return { status: r.status, d: t ? JSON.parse(t) : null } } catch { return { status: r.status, d: null } }
}
const ses = (p, o = {}, tk) => call(p, { ...o, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) } })
const rows = (sql, ...a) => { const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000'); const r = d.prepare(sql).all(...a); d.close(); return r }

const admin = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'personal@2026' }) })).d.token
ok(!!admin, '管理员登录成功')
const B = (await ses('/api/entity/books', {}, admin)).d.rows[0]
const doc = (await ses('/api/entity/docs', {}, admin)).d.rows.find((x) => !x.trashed)
ok(!!doc, '拿一篇文档当目标', String(doc?.id))

const SFX = Math.random().toString(36).slice(2, 7)
const mkUser = async (tag) => {
  const acct = tag + SFX
  await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234', name: tag }) })
  const tok = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234' }) })).d.token
  return { id: (await ses('/api/v2/user', {}, tok)).d.id, tok }
}
const A = await mkUser('pa_')
const C = await mkUser('pc_')
ok(!!A.id && !!C.id && A.id !== C.id, `两个不同的账号：${A.id} / ${C.id}`)

const favId = 'pfav_' + SFX
const flwId = 'pflw_' + SFX
const docId = String(doc?.id)

for (const u of [A, C]) {
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: {
      recents: [{ docId, viewedAt: Date.now() }],
      favorites: [{ id: u === A ? favId : 'pfav2_' + SFX, targetType: 'doc', targetId: docId, title: '收藏', createdAt: Date.now() }],
      follows: [{ id: u === A ? flwId : 'pflw2_' + SFX, targetType: 'space', targetId: String(B.spaceId), createdAt: Date.now() }],
    } }),
  }, u.tok)
}

const recentsOf = () => rows('SELECT userId FROM recents WHERE docId = ?', docId).map((r) => String(r.userId))
const has = (arr, id) => arr.includes(id)

console.log('\n== 前置：两个人各有一行（不成立就别往下验）==')
{
  const rc = recentsOf()
  ok(rc.length === 2, `recents 有两行（实际 ${rc.length}）`, rc.join(','))
  ok(has(rc, A.id) && has(rc, C.id), '**A 和 C 各一行**', rc.join(','))
  if (rc.length < 2) {
    console.log('\n  ⚠️ 前置不成立 —— 第一版探针就是这么栽的：在错的前提上往下验，')
    console.log('     结论只对了一半（只验出 delete 那半边，漏了 upsert 覆盖）。')
    stop()
    process.exit(1)
  }
}

console.log('\n== ① 写：B 再记一次同一篇，不该顶掉 A 的 ==')
{
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { recents: [{ docId, viewedAt: Date.now() + 1000 }] } }),
  }, C.tok)
  const after = recentsOf()
  ok(has(after, A.id), '**A 的那条还在**（修之前：被 C 顶掉，库里只剩一行）', after.join(','))
  ok(after.length === 2, '还是两行', String(after.length))
}

console.log('\n== ② 删：B 推 remove，删不掉 A 的 ==')
{
  const r = await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ remove: { recents: [docId] } }) }, C.tok)
  const left = recentsOf()
  ok(has(left, A.id), '**A 的最近浏览还在**', left.join(','))
  ok(!has(left, C.id), 'C 自己那条真删掉了（修的不能是「谁都不让删」）', left.join(','))
  ok((r.d?.rejected || []).length === 0, '**没有报错**（静默无效，而不是给用户挂一条假的「没保存」）', JSON.stringify(r.d).slice(0, 80))
  ok(!!A.id && has(left, A.id), '结论：跨用户删除被挡住了')
}

console.log('\n== ③ 收藏：写与删都要按归属 ==')
{
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { favorites: [{ id: favId, targetType: 'doc', targetId: docId, title: '收藏', createdAt: Date.now() }] } }),
  }, A.tok)
  ok(rows('SELECT id FROM favorites WHERE id = ?', favId).length === 1, '（前置）A 的收藏在库里')

  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ remove: { favorites: [favId] } }) }, C.tok)
  const left = rows('SELECT id FROM favorites WHERE id = ?', favId)
  ok(left.length === 1, '**C 删不掉 A 的收藏**', `还剩 ${left.length} 行`)

  // 自己删自己的要成功
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ remove: { favorites: [favId] } }) }, A.tok)
  ok(rows('SELECT id FROM favorites WHERE id = ?', favId).length === 0, 'A 自己删自己的，成功了')
}

console.log('\n== ④ 关注：同上 ==')
{
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { follows: [{ id: flwId, targetType: 'space', targetId: String(B.spaceId), createdAt: Date.now() }] } }),
  }, A.tok)
  ok(rows('SELECT id FROM follows WHERE id = ?', flwId).length === 1, '（前置）A 的关注在库里')
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ remove: { follows: [flwId] } }) }, C.tok)
  ok(rows('SELECT id FROM follows WHERE id = ?', flwId).length === 1, '**C 删不掉 A 的关注**')
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ remove: { follows: [flwId] } }) }, A.tok)
  ok(rows('SELECT id FROM follows WHERE id = ?', flwId).length === 0, 'A 自己删自己的，成功了')
}

console.log('\n== 读：本来就没问题（这次一并钉住，防回归）==')
{
  for (const [name, ent] of [['最近浏览', 'recents'], ['收藏', 'favorites'], ['关注', 'follows']]) {
    const mine = (await ses(`/api/entity/${ent}`, {}, A.tok)).d.rows
    const others = (await ses(`/api/entity/${ent}`, {}, C.tok)).d.rows
    const mineIds = new Set(mine.map((r) => r.id ?? r.docId))
    const leaked = others.filter((r) => mineIds.has(r.id ?? r.docId))
    ok(leaked.length === 0, `${name}：B 读不到 A 的行`, `泄漏 ${leaked.length} 行`)
  }
}

console.log('\n== 源码层面：两处都要带归属，别只改一处 ==')
{
  const code = readFileSync('server/sync.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
  const up = code.slice(code.indexOf('function upsertRow'), code.indexOf('\n}\n', code.indexOf('function upsertRow')))
  const del = code.slice(code.indexOf('function deleteRow'), code.indexOf('\n}\n', code.indexOf('function deleteRow')))
  ok(/def\.personal/.test(up) && /userCol/.test(up), '**upsertRow 的 existing 查询带了归属**')
  ok(/def\.personal/.test(del) && /userCol/.test(del), '**deleteRow 的 where 带了归属**')
  ok(/userId/.test(code) === false || /if\s*\(def\.personal\)/.test(code),
    '（说明）`writable` 里本来就不含 userId，所以归属只能由服务端补 —— 这两处补的就是它')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await cleanup()
process.exit(fail ? 1 : 0)
