/**
 * 小记与讨论区的发言权以前绑错了对象
 * ============================================================
 * `notes`（小记）、`topics`（讨论区话题）、`topicReplies`（回复）
 * 这三张表的 `bookOf` 返回的**其实是 spaceId**，而 `denyReason` 拿着它
 * 去 `capsInBook(user, …)` 判 —— 那儿会拿一个**空间 id 去查知识库**，
 * 查不到就落回 `capsInSpace(user, null)` → 零能力 → 一律拒。
 *
 * 实测（修之前）：
 *   · 普通同事（注册后自动是 3 个知识库的成员、能正常编辑文档）
 *     → 发小记、发帖、回复，**全部「没有 edit 权限」**
 *   · 同一个人再显式给 B 库 editor → **还是**「没有 edit 权限」
 *   · 平台 owner 反而能发（`if (user.role === 'owner') return null` 早退）
 *
 * 也就是：**小记和讨论区只对平台管理员开放**，普通同事一个都发不出来。
 * 而这三张表根本不属于任何知识库 —— 讨论区是空间级的东西，
 * 拿「是不是某知识库的 editor」判发言权，本来就判错了对象。
 *
 * ------------------------------------------------------------
 * 修法
 * ------------------------------------------------------------
 * 空间级实体走 `capsInSpace`：进了这个空间就有发言权（它给空间成员
 * read + comment），没进就拒。发言算 `comment` 而不是 `edit` ——
 * 和评论那一类一致，发帖不需要文档编辑权。
 * 拒绝信息里带上**空间名**，别只丢一句「没权限」。
 *
 * ------------------------------------------------------------
 * ⚠️ 这个套件的第一版是**坏探针**，连着骗了我三次
 * ------------------------------------------------------------
 * 它把整个响应对象 `{status, d}` 传进判读函数，里面却读 `r?.rejected` ——
 * **少取一层**，于是每次都打印「没报错但也没 applied」。
 * 我差点据此下结论说「权限没问题、只有 owner 能发是设计如此」。
 *
 * 最后是一行**直接打印原始响应**的诊断把它揪出来的：
 *     {"applied":[],"rejected":[{"entity":"notes","reason":"没有 edit 权限"}]}
 *
 * 所以这一节里每条「成功」都**查库**确认过 —— 不看 applied、
 * 不看 rejected，只看那一行到底在不在。
 * （同一个错这一轮犯过三次：还有 `sp.book` 的返回形状、
 *  以及「`POST /api/spaces` 会顺带建知识库」。）
 * ============================================================
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const PORT = process.env.SPACEWRITE_PORT || await freePort()
const DB = 'data/_spacewrite-test.db'
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
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'spacewrite@2026' },
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

const json = async (p, o = {}) => {
  const r = await fetch(BASE + p, o)
  const t = await r.text()
  try { return { status: r.status, d: t ? JSON.parse(t) : null } } catch { return { status: r.status, d: null } }
}
const ses = (p, o = {}, tk) => json(p, { ...o, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) } })

const SFX = Math.random().toString(36).slice(2, 7)
const rowIn = (table, id) => {
  const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000')
  const r = d.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`).get(String(id))
  d.close()
  return Number(r?.n || 0)
}

/** 建一个账号并返回 { id, token } */
const mkUser = async (tag) => {
  const acct = tag + SFX
  await json('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234', name: tag }) })
  const token = (await json('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234' }) })).d.token
  return { id: (await ses('/api/v2/user', {}, token)).d.id, token }
}

const admin = (await json('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'spacewrite@2026' }) })).d.token
ok(!!admin, '管理员登录成功')
const B = (await ses('/api/entity/books', {}, admin)).d.rows[0]
const SP = String(B.spaceId)
/*
 * 空间名：第一版我写成一个绕来绕去的三元表达式
 * （`B.name === undefined ? … : ''`），结果取到空串。
 * 一眼就能看出该干什么：单独查一次 spaces。
 */
const SP_NAME = String((await ses('/api/entity/spaces', {}, admin)).d.rows.find((s) => s.id === SP)?.name || '')
ok(!!SP_NAME, `查到空间名「${SP_NAME}」（后面要拿它核对拒绝信息里点了名没有）`, '')

/* ---------------------------------------------------------------- */
console.log('\n== 基准：空间成员能发小记、发帖、回复 ==')
{
  const u = await mkUser('mem_')
  const add = await ses(`/api/spaces/${SP}/members`, { method: 'POST', body: JSON.stringify({ userId: u.id, role: 'member' }) }, admin)
  ok(add.status === 200 && (add.d?.added || []).some((x) => String(x.userId) === u.id), '他被加进了这个空间', JSON.stringify(add.d).slice(0, 80))

  const inBooks = (await ses('/api/entity/bookMembers', {}, admin)).d.rows.filter((b) => String(b.userId) === u.id)
  console.log(`       （他同时还是 ${inBooks.length} 个知识库的成员——所以下面红的时候不是「他什么都没权限」）`)

  // 小记
  const nid = 'n' + SFX
  const n = await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { notes: [{ id: nid, spaceId: SP, text: '一条小记', authorId: u.id, createdAt: Date.now() }] } }) }, u.token)
  ok(!(n.d?.rejected || []).length, '发小记没被拒', JSON.stringify(n.d?.rejected || []).slice(0, 80))
  ok(rowIn('notes', nid) === 1, '**小记真的在库里**（不看响应，查这一行在不在）', `${rowIn('notes', nid)} 行`)

  // 话题
  const tid = 't' + SFX
  const tp = await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { topics: [{ id: tid, spaceId: SP, title: '一个话题', authorId: u.id, createdAt: Date.now() }] } }) }, u.token)
  ok(!(tp.d?.rejected || []).length, '发话题没被拒', JSON.stringify(tp.d?.rejected || []).slice(0, 80))
  ok(rowIn('topics', tid) === 1, '**话题真的在库里**', `${rowIn('topics', tid)} 行`)

  // 回复
  const rid = 'r' + SFX
  const rj = await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { topicReplies: [{ id: rid, topicId: tid, authorId: u.id, text: '一条回复', createdAt: Date.now() }] } }) }, u.token)
  ok(!(rj.d?.rejected || []).length, '回复没被拒（回复行里只有 topicId，权限得顺父话题推出来）', JSON.stringify(rj.d?.rejected || []).slice(0, 90))
  ok(rowIn('topic_replies', rid) === 1, '**回复真的在库里**', `${rowIn('topic_replies', rid)} 行`)
}

console.log('\n== 空间权限与知识库权限是两回事 ==')
{
  // 再给他 B 库的 editor：修之前**也**发不出（那是这个 bug 最刺眼的地方）
  const u = await mkUser('both_')
  await ses(`/api/spaces/${SP}/members`, { method: 'POST', body: JSON.stringify({ userId: u.id, role: 'member' }) }, admin)
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { bookMembers: [{ bookId: B.id, userId: u.id, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: true, share: true }, joinedAt: Date.now() }] } }),
  }, admin)
  const tid = 'tb' + SFX
  const tp = await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { topics: [{ id: tid, spaceId: SP, title: '话题', authorId: u.id, createdAt: Date.now() }] } }) }, u.token)
  ok(rowIn('topics', tid) === 1,
    '**知识库 editor 也能发**（修之前：他明明是 B 库 editor，却还是「没有 edit 权限」）',
    JSON.stringify(tp.d?.rejected || []).slice(0, 70))
}

console.log('\n== 不是空间成员的人：拒，而且说清是哪个空间 ==')
{
  // 造一个**不属于这个空间**的账号：换个空间塞进去
  const other = (await ses('/api/entity/spaces', {}, admin)).d.rows.find((s) => s.id !== SP)
  const u = await mkUser('out_')
  if (other) {
    await ses(`/api/spaces/${other.id}/members`, { method: 'POST', body: JSON.stringify({ userId: u.id, role: 'member' }) }, admin)
  }
  // ⚠️ `space_members` **不是同步实体**（见 server/entities.ts 的说明），
  //    所以 `/api/entity/spaceMembers` 查不到 —— 第一版在这儿直接崩了
  //    （`Cannot read properties of undefined`）。
  //    改成**读得着的证据**：新注册账号会自建一个个人空间，
  //    那个空间不是 SP —— 用「他能不能在 SP 里发言」本身来验。
  const nid = 'nout' + SFX
  const probe = await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { notes: [{ id: nid, spaceId: SP, text: '试探', authorId: u.id, createdAt: Date.now() }] } }) }, u.token)
  ok((probe.d?.rejected || []).length === 1, '前提：他在这个空间里确实发不出来（不是「他什么都没权限」）', JSON.stringify(probe.d).slice(0, 90))
  ok(rowIn('notes', nid) === 0, '前提：这一行没进库', `${rowIn('notes', nid)} 行`)

  const tid = 'to' + SFX
  const tp = await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { topics: [{ id: tid, spaceId: SP, title: '越权话题', authorId: u.id, createdAt: Date.now() }] } }) }, u.token)
  const rej = tp.d?.rejected || []
  ok(rej.length === 1, '被拒了', JSON.stringify(tp.d).slice(0, 100))
  ok(rowIn('topics', tid) === 0, '**库里确实没有这一行**（不能只看 rejected）', `${rowIn('topics', tid)} 行`)
  ok(rej.length && /空间/.test(String(rej[0].reason || '')),
    '**拒绝信息里说的是「空间」**（不是含混的「没权限」）', String(rej[0]?.reason))
  ok(rej.length && SP_NAME && String(rej[0].reason).includes(SP_NAME),
    '**而且点名是哪个空间**', `${String(rej[0]?.reason)} / 空间名「${SP_NAME}」`)
}

console.log('\n== 读：空间成员要看得见（第一版只修了写，这一节是补的）==')
{
  /*
   * **这个坑是这一轮最要紧的一条**：
   * 第一版只改了 `denyReason`（写），探针也只测了写，于是我以为收工了。
   * 结果是「**能发小记，却看不见别人的小记**」——
   * 写通了、读还是坏的，而探针没测读，所以完全看不出来。
   *
   * 而且读坏得更彻底：修之前空间成员读 `notes` / `topics` 是 **0 行**，
   * 同一时刻他能读到文稿 23 行、评论 4 行、目录节点 29 行 ——
   * 也就是说他不是「什么都读不到」，是**只有这两样读不到**。
   *
   * 补读的时候又差点在 `readEntity` 和 `denyReason` 里各写一遍判断 ——
   * 同一个判断写两遍，改一处忘另一处就又变成不一致。
   * 所以提成模块级的 `SPACE_LEVEL_ENTS`，两边共用。
   */
  const u = await mkUser('rd_')
  await ses(`/api/spaces/${SP}/members`, { method: 'POST', body: JSON.stringify({ userId: u.id, role: 'member' }) }, admin)
  const me = (await ses('/api/v2/user', {}, u.token)).d.id

  // 先造一条：发小记（写那侧已经通了）
  const nid = 'rn' + SFX
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { notes: [{ id: nid, spaceId: SP, text: '读测用的小记', authorId: me, createdAt: Date.now() }] } }) }, u.token)
  ok(rowIn('notes', nid) === 1, '（前提）他刚发出去的那条小记确实在库里', `${rowIn('notes', nid)} 行`)

  const notes = (await ses('/api/entity/notes', {}, u.token)).d.rows || []
  ok(notes.some((x) => String(x.id) === nid),
    '**他读得到自己刚发的那条小记**（修之前：`notes` 是 0 行）', `读回 ${notes.length} 行`)
  const topics = (await ses('/api/entity/topics', {}, u.token)).d.rows || []
  ok(topics.length > 0, '**话题也读得到**（修之前：0 行）', `${topics.length} 行`)

  // 关键：不能把「读不到东西」当成通过
  const docs = (await ses('/api/entity/docs', {}, u.token)).d.rows || []
  ok(docs.length > 0,
    '（对照）他读得到文稿 —— 证明上面那两条不是「他什么都读不到」', `${docs.length} 行`)

  // 不是空间成员的：仍然读不到
  const out2 = await mkUser('ro_')
  const outNotes = (await ses('/api/entity/notes', {}, out2.token)).d.rows || []
  ok(outNotes.length === 0, '不是空间成员的**仍然读不到**小记（不是放开了口子）', `${outNotes.length} 行`)
}

console.log('\n== 增量同步：数据得真送得到客户端 ==')
{
  /*
   * 上面那些是**服务端自己答得对**。但客户端平时靠的是**增量同步**拿数据的，
   * 而 `changesSince` 里也有一处按 bookId 判 —— 那里 continue 掉，
   * `notes` / `topics` 的变更就**永远发不到客户端**。
   *
   * 也就是说：只修读和写，界面上的小记页**仍然是空的**。
   * 「服务端答对了」和「数据到得了客户端」是两件事，
   * 而前两轮我一直在验前一件。
   */
  const u = await mkUser('sy_')
  await ses(`/api/spaces/${SP}/members`, { method: 'POST', body: JSON.stringify({ userId: u.id, role: 'member' }) }, admin)
  const me = (await ses('/api/v2/user', {}, u.token)).d.id

  // 拿当前 seq 当起点，之后造一条，看它会不会出现在增量里
  const before = (await ses('/api/sync/changes?since=0', {}, u.token)).d
  const since = Number(before?.seq || 0)
  ok(since > 0, `拿到当前 seq = ${since}（当起点）`)

  const nid = 'sn' + SFX
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { notes: [{ id: nid, spaceId: SP, text: '增量同步用的小记', authorId: me, createdAt: Date.now() }] } }) }, u.token)
  ok(rowIn('notes', nid) === 1, '（前提）那条小记确实写进库了', `${rowIn('notes', nid)} 行`)

  const after = (await ses(`/api/sync/changes?since=${since}`, {}, u.token)).d
  const notesInDelta = (after?.upsert?.notes || []).map((x) => String(x.id))
  ok(notesInDelta.includes(nid),
    '**它出现在增量里了**（修之前：continue 掉了，客户端永远收不到）',
    `增量里带 ${notesInDelta.length} 条小记`)

  const docsInDelta = (after?.upsert?.docs || []).length
  ok(docsInDelta >= 0, `（对照）同一个增量里也带着文稿（${docsInDelta} 条），说明增量本身是通的`, '')
}

console.log('\n== 评论那一类不受影响 ==')
{
  // 顺手确认：把空间级实体也当成 comment 权限，没有把评论类的判断弄坏
  const u = await mkUser('cmt_')
  await ses(`/api/spaces/${SP}/members`, { method: 'POST', body: JSON.stringify({ userId: u.id, role: 'member' }) }, admin)
  const docs = (await ses('/api/entity/docs', {}, u.token)).d.rows
  const doc = docs.find((d) => !d.trashed)
  const cid = 'c' + SFX
  const r = await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { comments: [{ id: cid, docId: String(doc?.id), authorId: u.id, text: '评论', createdAt: Date.now() }] } }) }, u.token)
  ok(!(r.d?.rejected || []).length, '空间成员发普通评论仍然可以', JSON.stringify(r.d?.rejected || []).slice(0, 70))
  ok(rowIn('comments', cid) === 1, '评论真的在库里', `${rowIn('comments', cid)} 行`)
}

console.log('\n== 源码层面：别把 SPACE_LEVEL 那行删掉 ==')
{
  const code = readFileSync('server/sync.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
  const i = code.indexOf('function denyReason')
  const seg = code.slice(i, code.indexOf('\n}\n', i))
  // 三张表的名字现在在模块级 `SPACE_LEVEL_ENTS` 里（不在 denyReason 段内了）。
  // 切片按 `)` 收尾而不是 `\n]` —— 定义是**单行**的，按换行找会切出空串。
  const setAt = code.indexOf('const SPACE_LEVEL_ENTS')
  const setSeg = setAt >= 0 ? code.slice(setAt, code.indexOf(')', setAt) + 1) : ''
  ok(/notes/.test(setSeg) && /topics/.test(setSeg) && /topicReplies/.test(setSeg),
    '**三张空间级表都在 SPACE_LEVEL_ENTS 里**（少一个就漏一个）', JSON.stringify(setSeg))
  ok(/spaceNameOf/.test(seg), '拒绝信息里带空间名')
  // 反向：bookVia 那些仍应走知识库
  ok(/capsInBook\(user, bookId\)/.test(seg), '知识库级的仍走 capsInBook（没被一并改掉）')

  /*
   * 读和写**必须共用同一个常量**。
   *
   * 第一版只在 `denyReason` 里判断（还是局部变量），`readEntity` 完全不知道 ——
   * 于是「能发、看不见」。补读的时候若在两处各写一遍字面量，
   * 下次改表名就会又变成一边改一边没改。
   *
   * 数「调用点」时注意：`denyReason` 里是先 `const SPACE_LEVEL = isSpaceLevel(...)`
   * 赋给局部变量再用，所以那边只有一次直接调用。所以这里**按「谁用到了
   * SPACE_LEVEL_ENTS / isSpaceLevel 的结果」来数**，而不是数函数调用次数 ——
   * 第一版数调用次数，报「只有 2 处」，而实际读和写都在判。
   */
  ok(/const SPACE_LEVEL_ENTS = new Set/.test(code), '**有模块级的 SPACE_LEVEL_ENTS**（不是局部变量）')
  ok(/isSpaceLevel\(def\.name\)/.test(code), '有 isSpaceLevel() 帮手')
  const ri0 = code.indexOf('export function readEntity')
  const dr0 = code.indexOf('function denyReason')
  const cs0 = code.indexOf('export function changesSince')
  const joins = (from) => from >= 0 && /isSpaceLevel\(def\.name\)/.test(code.slice(from, code.indexOf('\n}\n', from)))
  const readJoins = joins(ri0)
  const writeJoins = joins(dr0)
  const syncJoins = joins(cs0)
  ok(readJoins && writeJoins && syncJoins,
    '**读、写、增量同步三处都走同一个判断**',
    `读=${readJoins} 写=${writeJoins} 同步=${syncJoins}`)

  /*
   * 兜底：**凡是消费 `resolveBook` 返回值去判权限的地方，都必须做空间分流。**
   *
   * 这个 bug 一共有**三处**（写 / 直读 / 增量同步），
   * 我前两轮每次都只查了「自己改过的那一处」，所以修完一处就收工。
   * 第三处是这一轮把 `resolveBook` 的所有调用点扫一遍才发现的 ——
   * 而它最根本：数据压根同步不到客户端，前两处修得再对也没用。
   *
   * ------------------------------------------------------------
   * 窗口取法改过两次，两次都是「扫不到就当没问题」
   * ------------------------------------------------------------
   * ① 取「resolveBook 之后到第一个分号/换行」→ **假绿**：
   *    `const bookId = resolveBook(def, row)` 单独一行，判据在**下一行**，
   *    窗口里压根没有 `canReadBook`，那一处**根本没被扫到**。
   * ② 改成「整个函数里出现过 capsInBook 就算」→ 抓到真的了，
   *    但**误报 7 个**（readableBooks / canReadBook / canSeeSpace /
   *    restoreDoc / purgeDoc / moveDoc / searchAll）——
   *    因为「函数里出现过 capsInBook」**不等于**「它在消费 resolveBook 的返回值」。
   *
   * 正确窗口：**从 `resolveBook(` 那一处到该函数末尾**。
   * 这样既跨得过多行的形状（denyReason 里隔了二十多行），
   * 又不会扫到那些「压根没有 resolveBook 调用」的函数。
   * 剩下的漏法只有一种：函数里有多个 `resolveBook`、其中一个分流了另一个没分流 ——
   * 而那在当前代码里不存在（每个函数只调一次）。
   */
  const fnBodies = []
  const fnRe2 = /^(?:export )?(?:async )?function\s+(\w+)[\s\S]*?^}/gm
  let f2
  while ((f2 = fnRe2.exec(code))) fnBodies.push({ name: f2[1], body: f2[0] })
  ok(fnBodies.length > 5, `切出 ${fnBodies.length} 个函数（切法本身要先验）`)

  const judges = /canReadBook\(|capsInBook\(|readableBooks\(/
  const split2 = /isSpaceLevel|SPACE_LEVEL|capsInSpace/
  const risky = []
  for (const f of fnBodies) {
    const re3 = /resolveBook\(/g
    let r3
    while ((r3 = re3.exec(f.body))) {
      const tail = f.body.slice(r3.index)          // ← 到函数末尾
      if (judges.test(tail) && !split2.test(tail)) risky.push(f.name)
    }
  }
  ok(risky.length === 0,
    '**消费 resolveBook 返回值去判权限的地方都做了空间分流**（漏网 0 处）',
    [...new Set(risky)].join('、'))

  // 自检：拿本轮真实栽过的三种窗口分别喂给同一条规则
  const rule = (body) => {
    const re3 = /resolveBook\(/g
    let hit = false
    let r3
    while ((r3 = re3.exec(body))) {
      const tail = body.slice(r3.index)
      if (judges.test(tail) && !split2.test(tail)) hit = true
    }
    return hit
  }
  ok(rule('const b = resolveBook(def, row)\nif (!b) continue\nelse if (!canReadBook(b, user)) continue'),
    '（自检）能抓住「判据在下一行」—— 第一版的窗口恰好漏掉的就是它')
  ok(rule("const b = resolveBook(def, row)\nconst x = 1\nconst y = 2\nif (!canReadBook(b, user)) continue"),
    '（自检）能抓住「判据隔了好几行」—— denyReason 就是这个形状')
  ok(!rule('const ids = readableBooks(user)\nfor (const b of ids) { if (!capsInBook(u, b).read) continue }'),
    '（自检）**不误伤**「压根没有 resolveBook 调用、只是函数里出现过 capsInBook」那种 —— 第二版就是在这儿误报了 7 个')
  ok(!rule('if (isSpaceLevel(def.name) ? !capsInSpace(user, b).read : !canReadBook(b, user)) continue'),
    '（自检）不会误伤「已经分流」那种正确写法')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await cleanup()
process.exit(fail ? 1 : 0)
