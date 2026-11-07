/**
 * 普通成员在 comments / replies / 划词 / 回收站 这几条路径上的真实处境
 * ============================================================
 * 为什么要有这个套件：`denyReason` 开头是
 * `if (def.personal) …` 之后紧跟 `if (user.role === 'owner') return null`，
 * 所以**只用 admin 跑过的套件验的都是被早退放行的那条路**。
 * 扫过一遍，有 12 个套件从注册过第二个账号。
 * 前两轮在这个盲区里各挖到一个严重缺陷：
 *   · 空库里普通同事建不出第一条知识库（7.24）
 *   · 模板中心列得出 8 个，「新建」一点就被拒（7.26）
 * 这一轮把剩下几张表也走一遍。
 *
 * ------------------------------------------------------------
 * 前置必须先摆对，否则验的是「他没权限」而不是「这条路坏了」
 * ------------------------------------------------------------
 * 第一版探针直接把普通用户丢进去，结论是「他发不出评论」——
 * 而真相是**新注册用户压根读不到演示库的文稿**
 * （`createUserWithSpace` 只给他建空个人空间，不塞进任何现有知识库，
 * 语雀也是这样）。所以那个「发不出」验的是权限，不是功能。
 *
 * 现在先把前置摆对：**把演示库第一个库加给他当 editor**，
 * 确认他能读到文稿之后，再逐个验。
 * 前置不成立就当场退出 —— 在错的前提上验出的结论只对一半。
 *
 * ------------------------------------------------------------
 * 回收站是**两处**状态，而且这里我差点得出一个错误结论
 * ------------------------------------------------------------
 *   · `docs.trashed = 1`   服务端的软删标记（`deleteRow`）
 *   · `trash` 表一行        客户端的回收站列表（服务端 `INTO trash` 零命中）
 *
 * 探针第一版只推了 `remove: { docs }`、没推 `trash` 行，
 * 于是查 `trash` 表当然是空的 → 那一格红。
 *
 * **但那格红着，它前后两格却都绿**：
 *   「能删掉它 ✅」「文档回来了 ✅」。
 * 也就是说：**中间失败被两边的好消息盖住了**，
 * 扫一眼「大部分都绿」就放过去了。
 *
 * 而更要命的是它一度看起来像个**真缺陷**（「删除静默成功」）。
 * 实际是探针漏了客户端的第二步。
 * 所以这里把「两处状态都要查」写成断言 ——
 * 少查一处，得到的就只是一个好看的假象。
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const PORT = process.env.TBLWRITE_PORT || await freePort()
const DB = 'data/_tblwrite-test.db'
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
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'tbl@2026' },
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
  try { return { status: r.status, d: t ? JSON.parse(t) : null } } catch { return { status: r.status, d: null } }
}
const ses = (p, o = {}, tk) => call(p, { ...o, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) } })
const one = (sql, ...a) => { const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000'); const r = d.prepare(sql).get(...a); d.close(); return r }
const push = (tk, o) => ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: o.upsert || {}, remove: o.remove || {} }) }, tk).then((r) => r.d)

const SFX = Math.random().toString(36).slice(2, 7)
const admin = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'tbl@2026' }) })).d?.token
const acct = 'tbl' + SFX
await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234', name: '普通成员' }) })
const tok = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234' }) })).d?.token
const me = (await ses('/api/v2/user', {}, tok)).d

/* ============ 前置 ============ */
console.log('\n== 前置：给他一个库的 editor 身份 ==')
const books = (await ses('/api/entity/books', {}, admin)).d.rows
const bk = books[0]
ok(!!admin && !!tok && !!bk, `身份与目标库都拿到：${me?.id} / ${bk?.name}`)
await ses(`/api/spaces/${bk.spaceId}/members`, { method: 'POST', body: JSON.stringify({ userIds: [me.id], role: 'member' }) }, admin)
await push(admin, { upsert: { bookMembers: [{ userId: me.id, bookId: bk.id, role: 'editor', perms: JSON.stringify({}), joinedAt: Date.now() }] } })
const caps = (await ses('/api/perms/book/' + bk.id, {}, tok)).d
ok(caps?.caps?.edit === true, `他对《${bk.name}》有 edit`, JSON.stringify(caps?.caps).slice(0, 90))
const hisDocs = (await ses('/api/entity/docs', {}, tok)).d.rows.filter((d) => !d.trashed)
ok(hisDocs.length > 0, `他能读到 ${hisDocs.length} 篇文稿（前置：不成立就退出，下面验的全是「他没权限」）`)
if (!hisDocs.length || caps?.caps?.edit !== true) {
  console.log('\n前置不成立，这个套件不往下验。')
  stop(); process.exit(fail ? 1 : 0)
}
const doc = hisDocs[0]

/* ============ docVersions ============ */
console.log('\n== docVersions：靠 bookViaDoc=docId 反查 ==')
{
  const vs = (await ses('/api/entity/docVersions', {}, tok)).d.rows
  ok(true, `他读到 ${vs.length} 个版本（owner ${(await ses('/api/entity/docVersions', {}, admin)).d.rows.length} 个）—— 只读这条不构成结论，下面才是写入`)
  // ⚠️ writable 里是 `at`（版本时间）不是 `version`，`editorName` 也是必填。
  // 第一版写成 `version: 1` 且漏了 editorName → 「NOT NULL constraint failed: doc_versions.at」，
  // 看着像权限问题，其实是**探针自己造错了行**。
  const vid = 'dv_' + SFX
  const now = Date.now()
  const p = await push(tok, { upsert: { docVersions: [{ id: vid, docId: doc.id, title: '他存的版本', body: 'x', blocks: [{ id: 'b1', type: 'paragraph', text: 'x' }], editorName: '普通成员', at: now, label: '', createdAt: now }] } })
  ok((p?.rejected?.length || 0) === 0, '他能在自己读得到的文稿下存版本', JSON.stringify(p?.rejected))
  ok(!!one('SELECT 1 AS x FROM doc_versions WHERE id = ?', vid), '（证据）版本行真落库')
  const readBack = (await ses('/api/entity/docVersions', {}, tok)).d.rows.find((v) => v.id === vid)
  ok(!!readBack, '而且他自己能读回来（bookViaDoc 反查对得上）')
}

/* ============ comments / commentReplies ============ */
console.log('\n== comments / commentReplies：bookViaComment 两跳 ==')
const cid = 'c_' + SFX
{
  const p = await push(tok, { upsert: { comments: [{ id: cid, docId: doc.id, authorId: me.id, text: '普通成员的评论', createdAt: Date.now() }] } })
  ok((p?.rejected?.length || 0) === 0, '他能在文稿下发表评论', JSON.stringify(p?.rejected))
  ok(!!one('SELECT 1 AS x FROM comments WHERE id = ?', cid), '（证据）评论行真落库')
  if (one('SELECT 1 AS x FROM comments WHERE id = ?', cid)) {
    const rid = 'cr_' + SFX
    const p2 = await push(tok, { upsert: { commentReplies: [{ id: rid, commentId: cid, authorId: me.id, text: '他的回复', createdAt: Date.now() }] } })
    ok((p2?.rejected?.length || 0) === 0, '他能回复评论（两跳反查）', JSON.stringify(p2?.rejected))
  }
}

/* ============ selectionComments / selectionCommentReplies ============ */
console.log('\n== selectionComments / selectionCommentReplies ==')
const scid = 'sc_' + SFX
{
  const p = await push(tok, { upsert: { selectionComments: [{ id: scid, docId: doc.id, authorId: me.id, text: '划词评论', quote: '选中的一段', createdAt: Date.now() }] } })
  ok((p?.rejected?.length || 0) === 0, '他能发划词评论', JSON.stringify(p?.rejected))
  ok(!!one('SELECT 1 AS x FROM selection_comments WHERE id = ?', scid), '（证据）划词行真落库')
  if (one('SELECT 1 AS x FROM selection_comments WHERE id = ?', scid)) {
    const rid = 'scr_' + SFX
    const p2 = await push(tok, { upsert: { selectionCommentReplies: [{ id: rid, selectionCommentId: scid, authorId: me.id, text: '他的划词回复', createdAt: Date.now() }] } })
    ok((p2?.rejected?.length || 0) === 0, '他能回复划词评论（两跳）', JSON.stringify(p2?.rejected))
  }
}

/* ============ trash：两处状态都要查 ============ */
console.log('\n== trash：删除 → 回收站 → 恢复 ==')
const did = 'd_' + SFX
{
  const now = Date.now()
  // ⚠️ docs.updatedAt 是 NOT NULL。第一版探针漏了它 →
  // 建文档被拒，而「能删掉它」却通过了（删一行不存在的东西不报错），
  // 差点得出「删除静默成功」的错误结论。
  const p0 = await push(tok, { upsert: {
    nodes: [{ id: 'n_' + SFX, bookId: bk.id, parentId: null, title: '给他删的那篇', type: 'doc', ord: 99, createdAt: now, updatedAt: now }],
    docs: [{ id: did, bookId: bk.id, title: '给他删的那篇', body: 'x', wordCount: 1, createdAt: now, updatedAt: now }],
  } })
  ok((p0?.rejected?.length || 0) === 0, '他先建一篇自己的文档', JSON.stringify(p0?.rejected))
  const made = !!one('SELECT 1 AS x FROM docs WHERE id = ?', did)
  ok(made, '（前置）文档真落库了，否则后面验的是「删一行不存在的东西」')
  if (!made) { console.log('\n前置不成立，不往下验。'); stop(); process.exit(fail ? 1 : 0) }

  // 真实客户端是两处状态：remove docs + upsert trash 行
  const del = await push(tok, {
    remove: { docs: [did] },
    upsert: { trash: [{ docId: did, bookId: bk.id, title: '给他删的那篇', deletedAt: Date.now() }] },
  })
  ok((del?.rejected?.length || 0) === 0, '他能删掉它（推 remove + trash 行）', JSON.stringify(del?.rejected))

  // ⚠️ 两处**分别**查。少查一处，中间的失败就会被两边的绿盖住。
  const soft = one('SELECT trashed, deletedAt FROM docs WHERE id = ?', did)
  ok(Number(soft?.trashed) === 1, `服务端软删标记 docs.trashed = ${soft?.trashed}（带 deletedAt=${soft?.deletedAt}）`)
  const tr = one('SELECT docId, bookId FROM trash WHERE docId = ?', did)
  ok(!!tr, `客户端回收站行 trash 表：${JSON.stringify(tr)}`)
  const listed = (await ses('/api/entity/trash', {}, tok)).d.rows.some((r) => r.docId === did)
  ok(listed, '他的回收站列表里能读到它')

  const restore = await ses(`/api/doc/${did}/restore`, { method: 'POST' }, tok)
  ok(restore.status === 200, `他能恢复回来（HTTP ${restore.status}）`, JSON.stringify(restore.d).slice(0, 80))
  ok(!one('SELECT 1 AS x FROM trash WHERE docId = ?', did), '恢复后 trash 行没了')
  ok(Number(one('SELECT trashed FROM docs WHERE id = ?', did)?.trashed) === 0, '恢复后软删标记也清了')
  ok(!!one('SELECT 1 AS x FROM docs WHERE id = ?', did), '文档回来了')
}

/* ============ 反面：不是成员的人不行 ============ */
console.log('\n== 反面：没身份的人不行 ==')
{
  const acct2 = 'tblx' + SFX
  await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct2, password: 'test1234', name: '路人' }) })
  const tok2 = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct2, password: 'test1234' }) })).d?.token
  const p = await push(tok2, { upsert: { comments: [{ id: 'cx_' + SFX, docId: doc.id, authorId: 'x', text: '路人评论', createdAt: Date.now() }] } })
  ok((p?.rejected?.length || 0) === 1, '路人在这篇文稿下发不出评论', JSON.stringify(p?.rejected))
  ok(!one('SELECT 1 AS x FROM comments WHERE id = ?', 'cx_' + SFX), '而且没落库')
}

await cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
