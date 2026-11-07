/**
 * 空库（YQ_DEMO=0）时，普通用户建不出第一条知识库
 * ============================================================
 * 演示模式永远带种子数据（`seed.ts` 直插，**不走同步**），
 * 所以「从零建出第一个知识库」这条路在演示环境里从来没被跑过。
 * 而公司内网部署恰恰是「空库 + 普通同事注册」的场景。
 *
 * 病根：`books` 的 `bookOf` 返回的是**它自己**的 id（`entities.ts`：
 * `bookOf: (r) => S(r.id)`），`denyReason` 的通用逻辑于是拿
 * `capsInBook(user, 新库的 id)` 去判 —— 而此刻库里还没有这一行：
 *   · `spaceIdOfBook(新库id)` → 查不到 books 行 → null
 *   · `capsInSpace(user, null)` → NONE
 *   · `book_members` 里也还没有行 → NONE
 * → 「没有 edit 权限」。
 *
 * 平台 owner 看起来正常，是因为他在 `denyReason` 开头就
 * `if (user.role === 'owner') return null` 早退了 ——
 * **又是一次「只有绕过的那个路径是好的」**。
 *
 * 更糟的是它和 `bookMembers` 的判据**互相等待**（自锁）：
 *   · books 新行要「是该库 admin」→ admin 身份来自 book_members 行
 *   · bookMembers 新行也要「是该库 admin」→ 而 books 行还不存在
 * 两种推送顺序实测都死：
 *   · books 在前     → books「没有 edit 权限」+ bookMembers「需要该知识库的管理员权限」
 *   · bookMembers 在前 → bookMembers「需要该知识库的管理员权限」+ books「没有 edit 权限」
 *   · 对照组平台 owner：同样两行、同样顺序，**都 applied**
 *
 * 这是**同一个病根的第三次**：`notes`/`topics`/`topicReplies` 那三处是
 * 拿 bookId 去查一个**空间**（`bookOf` 返回 spaceId），
 * 这次是拿 bookId 去查一个**还不存在的库**。
 *
 * 修法两半：
 *   1. `denyReason` 里 `books` **新建**行按空间判（`capsInSpace().admin`），
 *      已存在的行仍走通用逻辑 —— 不加这个限制会回退：
 *      库的 editor 能改名改可见性，改成按空间判就都改不了了。
 *   2. 服务端在建库时直接把创建者写成 owner。客户端 `createBook` 虽然
 *      会推 bookMembers，但那行会被拒（推它的那一刻 admin 身份正要靠这次创建
 *      来产生）→ **库建出来了却没人是 owner，创建者自己打不开**。
 *
 * ------------------------------------------------------------
 * 断言怎么排的：第一条是**前置**
 * ------------------------------------------------------------
 * 「建库成功」这种断言如果不先确认行真落库、身份真是 owner，
 * 就分不清是「修好了」还是「请求没发出去」。所以先摆基准和落库证据，
 * 再谈后续。
 *
 * ------------------------------------------------------------
 * 两次破坏对照都验过（别把它们撤了当成「多余」）
 * ------------------------------------------------------------
 * ① 把 `books && !existing` 短路成 `&& false`（回到旧行为）
 *    → 23 通过 / **10 失败**，红的正是那个自锁组合。
 *    但注意：「普通成员建库被拒」这条**仍然 PASS** ——
 *    旧逻辑也拒他，所以**这一条证明不了任何事**。
 *    真正兜住这个边界的是旁边那条「拒绝理由说清是哪个空间」，
 *    它红了。**否定式断言必须配基准**，否则它恒真。
 *
 * ② 去掉 `&& !existing`（让改已有库也按空间判）
 *    → 29 通过 / **4 失败**，红的正是「库的 editor 能改名」。
 *    这个限制就是靠那个用例守住的，不是靠注释。
 *
 * ③ 去掉补 owner 行里的 `user.role !== 'owner'`
 *    → 41 通过 / **1 失败**，红的正是「owner 建的库里没有任何成员行」。
 *    这一条是补上去的，因为第一版**漏了这个条件**、把
 *    `test-sync-converge` 弄红了（详见 7.25）。
 * ============================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.EMPTYFIRST_PORT || await freePort()
const DB = 'data/_emptyfirst-test.db'
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

// YQ_DEMO=0 是这个套件的**全部意义**：带演示数据的话，种子已经把库建好了，
// 根本走不到「空库建第一条库」这一步，测试会绿得像什么都没测。
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'empty@2026', YQ_DEMO: '0' },
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
const cnt = (t) => Number(one(`SELECT COUNT(*) AS n FROM ${t}`)?.n || 0)

const SFX = Math.random().toString(36).slice(2, 7)
const mkUser = async (tag) => {
  const acct = tag + SFX
  await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234', name: tag }) })
  const tok = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234' }) })).d.token
  return { id: (await ses('/api/v2/user', {}, tok)).d.id, tok }
}

/* ============ 基准：真的是空库 ============ */
console.log('\n== 基准：YQ_DEMO=0 出来的是空库 ==')
{
  ok(cnt('books') === 0, `books 表 0 行（实际 ${cnt('books')}）`)
  ok(cnt('docs') === 0, `docs 表 0 行（实际 ${cnt('docs')}）`)
  ok(cnt('book_members') === 0, `book_members 表 0 行（实际 ${cnt('book_members')}）`)
  ok(cnt('users') === 1, `只有 1 个用户（管理员）（实际 ${cnt('users')}）`)
}

/* ============ 步骤 1：新同事注册 ============ */
console.log('\n== 步骤 1：新同事注册，拿到什么 ==')
const A = await mkUser('ef_')
ok(!!A.id && !!A.tok, `注册并登录成功：${A.id}`)
{
  const sp = (await ses('/api/entity/spaces', {}, A.tok)).d.rows
  ok(sp.length >= 1, `注册后至少有 1 个个人空间（实际 ${sp.length}）`)
  const bk = (await ses('/api/entity/books', {}, A.tok)).d.rows
  ok(bk.length === 0, `注册后看不到任何知识库（实际 ${bk.length}）`)
}

/* ============ 步骤 2：建空间（这条路本来就是通的） ============ */
console.log('\n== 步骤 1b：注册后自动拿到的那个个人空间，他在里面能建库吗 ==')
{
  // 这是**首次体验的真正第一步**，比「建团队空间」更靠前：
  // 新同事登录后看到的是这个空间，不是他还没建的团队空间。
  // 修复要求「必须是空间管理员」，所以他得**本来就是**这个空间的 owner，
  // 否则这条路是断的 —— 而演示模式下这个空间被种子塞满了文档，
  // **建库按钮压根没被点过**。
  const mySpaces = (await ses('/api/entity/spaces', {}, A.tok)).d.rows
  ok(mySpaces.length >= 1, `他有自己的个人空间（实际 ${mySpaces.length}）`)
  const personal = mySpaces.find((s) => String(s.kind || '') !== 'team') || mySpaces[0]
  ok(!!personal, `取一个空间当个人空间：${personal?.name}（kind=${personal?.kind}）`)

  const isAdmin = !!one('SELECT 1 AS x FROM space_members WHERE spaceId = ? AND userId = ? AND role IN (?,?)',
    personal.id, A.id, 'owner', 'admin')
  ok(isAdmin, '他是这个空间的管理员（前置 —— 否则在里面建库必然被拒）')

  const pid = 'b_efp' + SFX
  const ppush = (await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({
    upsert: { books: [{ id: pid, spaceId: personal.id, name: '我的第一个库', desc: '', avatar: '📚', visibility: 'private', createdAt: Date.now(), updatedAt: Date.now() }] }, remove: {},
  }) }, A.tok)).d
  ok((ppush?.rejected?.length || 0) === 0, '他在自己的个人空间里能建出第一个库', JSON.stringify(ppush?.rejected))
  ok(!!one('SELECT 1 AS x FROM books WHERE id = ?', pid), '这个库真落库了')
  ok(one('SELECT role FROM book_members WHERE bookId = ? AND userId = ?', pid, A.id)?.role === 'owner',
    '他自动成为这个库的 owner')
}

console.log('\n== 步骤 2：建团队空间 ==')
const spId = (await ses('/api/spaces', { method: 'POST', body: JSON.stringify({ name: '研发部' }) }, A.tok)).d?.space?.id
ok(!!spId, `建空间成功：${spId}`)
ok(!!one('SELECT 1 AS x FROM space_members WHERE spaceId = ? AND userId = ? AND role = ?', spId, A.id, 'owner'),
  '他是这个空间的管理员（前置）')

/* ============ 步骤 3：建第一条知识库（核心） ============ */
console.log('\n== 步骤 3：建第一条知识库（走真实客户端路径 /api/sync/push）==')
const bookId = 'b_ef1' + SFX
const bookRow = (id, name) => ({ id, spaceId: spId, name, desc: '', avatar: '📚', visibility: 'private', createdAt: Date.now(), updatedAt: Date.now() })
// bookMembers 的服务端主键列叫 userId（复合主键 bookId+userId）。
// 客户端的 withServerPk 会在推送前把 id 补成 userId；
// 这里直接手写 payload、跳过了那一层，所以必须自己写 userId。
const memberRow = (id) => ({ userId: A.id, bookId: id, role: 'owner', perms: JSON.stringify({}), joinedAt: Date.now() })

// 顺序 = 客户端 store 里 commit 的书写顺序：books 在前、bookMembers 在后
const push1 = (await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({
  upsert: { books: [bookRow(bookId, '需求池')], bookMembers: [memberRow(bookId)] }, remove: {},
}) }, A.tok)).d
ok((push1?.rejected?.length || 0) === 0, 'books + bookMembers 一起推，无拒绝',
  JSON.stringify(push1?.rejected))

/* ============ 落库证据：先摆事实再谈后续 ============ */
console.log('\n== 落库证据（不能只看「没报错」）==')
const bmRow = one('SELECT userId, role FROM book_members WHERE bookId = ?', bookId)
ok(!!one('SELECT 1 AS x FROM books WHERE id = ?', bookId), 'books 行真的落库了')
ok(!!bmRow, 'book_members 行真的落库了')
ok(bmRow?.userId === A.id, '那行是创建者本人的，不是别人的', JSON.stringify(bmRow))
ok(bmRow?.role === 'owner', `创建者的角色是 owner（实际 ${bmRow?.role}）`)

/* ============ 建出来之后，他得真能用 ============ */
console.log('\n== 建出来之后他真能用（打不开自己刚建的库是最难受的那种坏）==')
{
  const seen = (await ses('/api/entity/books', {}, A.tok)).d.rows.find((b) => b.id === bookId)
  ok(!!seen, `他能读到刚建的库：${seen?.name || '读不到'}`)

  const nodeId = 'n_ef1' + SFX
  const pushNode = (await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({
    upsert: { nodes: [{ id: nodeId, bookId, parentId: null, title: '首页', type: 'doc', ord: 0 }] }, remove: {},
  }) }, A.tok)).d
  ok((pushNode?.rejected?.length || 0) === 0, '他能在新库里建目录节点', JSON.stringify(pushNode?.rejected))
}

/* ============ 步骤 4：换推送顺序，books 不能被带累 ============ */
console.log('\n== 步骤 4：换顺序（bookMembers 在前）—— books 仍然要能建出来 ==')
const bookId2 = 'b_ef2' + SFX
const push2 = (await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({
  upsert: { bookMembers: [memberRow(bookId2)], books: [bookRow(bookId2, '换顺序建的库')] }, remove: {},
}) }, A.tok)).d
ok(!!one('SELECT 1 AS x FROM books WHERE id = ?', bookId2), '顺序换了 books 照样落库（没被前面的拒绝带累）',
  JSON.stringify(push2))
ok(!!one('SELECT 1 AS x FROM book_members WHERE bookId = ? AND userId = ?', bookId2, A.id),
  '顺序换了创建者照样是 owner（服务端保证，不靠客户端补推）')

/* ============ 边界：不是空间管理员就不该能建库 ============ */
console.log('\n== 边界：普通空间成员建库应该被拒 ==')
const M = await mkUser('efm_')
{
  ok(!!M.id && M.id !== A.id, `第二个账号：${M.id}`)
  const add = (await ses(`/api/spaces/${spId}/members`, { method: 'POST', body: JSON.stringify({ userIds: [M.id], role: 'member' }) }, A.tok)).d
  ok(!!one('SELECT 1 AS x FROM space_members WHERE spaceId = ? AND userId = ?', spId, M.id),
    '他是研发部的普通成员（前置）', JSON.stringify(add))

  const bookId3 = 'b_ef3' + SFX
  const rej = (await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({
    upsert: { books: [bookRow(bookId3, '普通成员建的库')] }, remove: {},
  }) }, M.tok)).d
  ok((rej?.rejected?.length || 0) === 1, '普通成员建库被拒', JSON.stringify(rej))
  ok(String(rej?.rejected?.[0]?.reason || '').includes('研发部'),
    '拒绝理由说清是哪个空间，不是一句「没权限」', rej?.rejected?.[0]?.reason)
  ok(!one('SELECT 1 AS x FROM books WHERE id = ?', bookId3), '被拒的这一行确实没落库')
}

/* ============ 对照组：平台 owner 走同一条路仍然通 ============ */
console.log('\n== 对照组：平台 owner 走同一套 push ==')
const adminTok = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'empty@2026' }) })).d?.token
let ownerBookId = ''
{
  ownerBookId = 'b_ef4' + SFX
  const push4 = (await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({
    upsert: { books: [bookRow(ownerBookId, '管理员建的库')] }, remove: {},
  }) }, adminTok)).d
  ok((push4?.rejected?.length || 0) === 0, 'owner 建库无拒绝', JSON.stringify(push4?.rejected))
  ok(!!one('SELECT 1 AS x FROM books WHERE id = ?', ownerBookId), 'owner 建的库落库了')
}

/* ============ owner 建库**不该**产生成员行 ============ */
console.log('\n== 平台 owner 建库不该产生成员行 ==')
{
  /*
   * 这条是被 `test-sync-converge` 逼出来的：
   * 补 owner 行的逻辑第一版**没有**排除平台 owner，于是 owner 建库时
   * 也往 book_members 里塞了一行 —— 而 owner 靠 `capsInBook` 开头的
   * `if (user.role === 'owner') return admin` 访问**任何**库，
   * **根本不需要成员行**。那行是没有语义的数据。
   *
   * 后果实测落在 `test-sync-converge` 上：同一个人是多个库的成员，
   * 它按 `userId` 单键索引 bookMembers（客户端用复合键，测试为了简单换了单键），
   * 补出来的那行让 `u_admin` 这个键在增量和全量下解析到**不同的行**，
   * 「增量追平 == 全量重拉」这条最基础的不变量当场红了。
   *
   * 只查「空间 owner 建库有 owner 行」是**守不住**这个条件的 ——
   * 所以这里必须单独钉一条反向断言。
   */
  const ownerId = (await ses('/api/v2/user', {}, adminTok)).d?.id
  const row = one('SELECT userId, role FROM book_members WHERE bookId = ?', ownerBookId)
  ok(!row, `owner 建的库里没有任何成员行（实际 ${JSON.stringify(row)}）`)
  ok(!!one('SELECT 1 AS x FROM books WHERE id = ?', ownerBookId), '而这个库确实存在（不是没建出来）')
  // 顺带钉住：owner 访问它不靠成员行
  const canRead = (await ses('/api/perms/book/' + ownerBookId, {}, adminTok)).d
  ok(!!canRead, `owner 对这个库仍有能力（不靠成员行）：${JSON.stringify(canRead).slice(0, 80)}`)
  void ownerId
}

/* ============ 不许回退：已有库仍然按库判权限 ============ */
console.log('\n== 不许回退：改名字 / 改可见性仍按「这个库」判 ==')
{
  // 平台 owner 建一个库，把 A 提为 editor，然后让 A 改名。
  // 判据若从「库」改成「空间」，A（空间普通成员、只有 read+comment）就改不了了。
  const bookId5 = 'b_ef5' + SFX
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({
    upsert: { books: [bookRow(bookId5, '待改名')] }, remove: {},
  }) }, adminTok)
  await ses(`/api/spaces/${spId}/members`, { method: 'POST', body: JSON.stringify({ userIds: [A.id], role: 'member' }) }, adminTok)
  await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({
    upsert: { bookMembers: [{ userId: A.id, bookId: bookId5, role: 'editor', perms: JSON.stringify({}), joinedAt: Date.now() }] }, remove: {},
  }) }, adminTok)
  ok(one('SELECT role FROM book_members WHERE bookId = ? AND userId = ?', bookId5, A.id)?.role === 'editor',
    'A 是这个库的 editor（前置）')

  const upd = (await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({
    upsert: { books: [{ ...bookRow(bookId5, 'A 改的名'), id: bookId5 }] }, remove: {},
  }) }, A.tok)).d
  ok((upd?.rejected?.length || 0) === 0, '库的 editor 能给这个库改名', JSON.stringify(upd?.rejected))
  ok(one('SELECT name FROM books WHERE id = ?', bookId5)?.name === 'A 改的名', '名字真改了')

  // 反面：不是这个库成员的人改不了
  const C = await mkUser('efc_')
  const bad = (await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({
    upsert: { books: [{ ...bookRow(bookId5, '外人改的'), id: bookId5 }] }, remove: {},
  }) }, C.tok)).d
  ok((bad?.rejected?.length || 0) === 1, '不是成员的人改不了这个库', JSON.stringify(bad))
  ok(one('SELECT name FROM books WHERE id = ?', bookId5)?.name === 'A 改的名', '库名没被外人改掉')
}

/* ============ 源码层：别把这段判据删回去 ============ */
console.log('\n== 源码层：判据还在 ==')
{
  const src = readFileSync('server/sync.ts', 'utf8')
  ok(/def\.name === 'books' && !existing/.test(src), 'denyReason 里仍有「books 新建按空间判」这条分支')
  ok(/INSERT INTO book_members/.test(src), '仍有「建库时服务端补 owner 行」')
  // 这条不是断言，是**记一件本轮差点做的事**：
  // 如果为了让建库通过，把 `if (!existing)` 去掉，
  // 上面「库的 editor 能改名」那条就会红（已由那个用例守住）。
  ok(/books' && !existing[\s\S]{0,400}capsInSpace/.test(src), '这条判据用的是 capsInSpace，不是 capsInBook')
}

await cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
