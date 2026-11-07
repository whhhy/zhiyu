/**
 * IP 白名单漏了「增量同步」这条出口
 * ============================================================
 * 7.29 那次把白名单铺到了列表 / 搜索 / 整包导出 / 能力面板 / 单篇文档，
 * 唯独 **`/api/sync/changes` 没铺**。
 *
 * 而它恰恰是**客户端平时拿数据的那条路**：
 * `changesSince` 上面的注释就写着「客户端平时就是靠它拿变更的」。
 * 轻量启动之后客户端本地只有元信息，正文靠增量补 —— 于是这条口一漏，
 * 白名单挡住的库，它的文档**照样一篇篇连正文一起送到**。
 *
 * 实测（这个套件）：白名单开着、当前 IP 不在名单里时
 *   `/api/entity/docs` → 0 篇        ✅（7.29 修过）
 *   `/api/search`     → 0 条        ✅
 *   `/api/doc/:id`    → 403         ✅
 *   `/api/sync/changes` → **那篇文档连正文一起发过来了**   ❌
 *
 * 也就是说：**只要不点进任何一篇，挂着白名单的库就能被完整读走**。
 *
 * ------------------------------------------------------------
 * 为什么「看起来已经查过了」却还是漏
 * ------------------------------------------------------------
 * 7.29 的修法是给 `readEntity` / `readEntityLite` / `bootstrap` / `searchAll`
 * 加**必传**的 `ip` 参数，让「新增调用点时编译就红」。
 * 那个机制本身是对的，它确实挡住了新的调用点漏传 ——
 * 但 `changesSince` **不经过 readEntity**，它自己 `SELECT * FROM <table>`
 * 逐行取、自己判权限、自己 `toClient` 下发。
 * 也就是说：**它是一条独立的数据通路，压根不经过那个必传参数。**
 *
 * 这就是本项目记过最多次的那条教训的又一例：
 * **「一个判断散在多处，漏一处不会有人告诉你」**。
 *
 * ------------------------------------------------------------
 * 修法
 * ------------------------------------------------------------
 * `changesSince` 加 `ip` 参数（同样必传，`null` = 服务端内部读取不做判定），
 * 在 `toClient` 之前按 `ipAllowed(resolveBook(def, row), ip)` 过滤。
 *
 * **`remove` 那一侧刻意不过滤**，理由写在那段注释里 ——
 * 删除通知只带一个不透明的 id，不带任何内容，而它恰恰是让客户端
 * 把「加白名单之前就已经同步到本地的旧副本」清掉的唯一途径。
 * 为此去反查已删行的 bookId 是脆的（行已经没了），而且会引入
 * 「查不出来该怎么办」这个新问题。
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.IPWLC_PORT || await freePort()
const DB = 'data/_ipwlc-test.db'
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
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'ipwc@2026' },
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
/** 伪造来源 IP。服务默认 `YQ_TRUST_PROXY` 为「信」—— 关掉是 `=0` 才不信，
 *  写成「没设就不信」会是破坏性变更（test-trustproxy 钉着这一点）。 */
const sesFrom = (p, ip, tk) => call(p, { headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip, Authorization: 'Bearer ' + tk } })
const one = (sql, ...a) => { const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000'); const r = d.prepare(sql).get(...a); d.close(); return r }

const SFX = Math.random().toString(36).slice(2, 7)
const admin = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'ipwc@2026' }) })).d?.token
const acct = 'ipwc' + SFX
await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234', name: '普通成员' }) })
const tok = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234' }) })).d?.token
const me = (await ses('/api/v2/user', {}, tok)).d
const bk = (await ses('/api/entity/books', {}, admin)).d.rows[0]
const push = async (tk, body) => {
  const r = await ses('/api/sync/push', { method: 'POST', body: JSON.stringify(body) }, tk)
  return { status: r.status, applied: r.d?.applied, rejected: r.d?.rejected }
}

console.log('\n== 前置 ==')
{
  const g = await push(admin, { upsert: { bookMembers: [{ userId: me.id, bookId: bk.id, role: 'editor', perms: '{}', joinedAt: Date.now() }] }, remove: {} })
  const isMember = !!one('SELECT 1 AS x FROM book_members WHERE bookId = ? AND userId = ?', bk.id, me.id)
  ok(!!admin && !!me?.id && !!bk, `身份与库：${me?.id} / ${bk?.id}`)
  ok(isMember, `他是《${bk?.name}》的 editor（push ${g.status}）—— 不成立就退出`)
  if (!isMember) { console.log('\n前置不成立，不往下验。'); stop(); process.exit(fail ? 1 : 0) }
}

// 他自己写一篇，正文里有能认出来的字样
const DOC = 'ipwlc' + SFX
const SECRET = '内网机密-' + SFX
{
  const r = await push(tok, {
    upsert: { docs: [{ id: DOC, bookId: bk.id, title: '白名单测试 ' + DOC, body: SECRET, blocks: [{ type: 'p', text: SECRET }], wordCount: 1, createdAt: Date.now(), updatedAt: Date.now() }] },
    remove: {},
  })
  ok(r.status === 200 && (r.applied?.length || 0) === 1, `他写进了一篇（push ${r.status}）`, JSON.stringify(r.rejected))
}

const changesDocs = async (ip) => {
  const r = ip ? await sesFrom('/api/sync/changes?since=0', ip, tok) : await ses('/api/sync/changes?since=0', {}, tok)
  return { status: r.status, rows: r.d?.upsert?.docs || [], raw: JSON.stringify(r.d || {}) }
}
const setWl = async (on, list) => {
  const p = await push(admin, { upsert: { bookSettings: [{ bookId: bk.id, ipWhitelist: on, ipList: list }] }, remove: {} })
  return { p, row: one('SELECT ipWhitelist, ipList FROM book_settings WHERE bookId = ?', bk.id) }
}

/* ============ 基准：白名单关着，增量里当然有 ============ */
console.log('\n== 基准：白名单关着 ==')
{
  await setWl(0, [])
  const c = await changesDocs()
  const hit = c.rows.find((r) => r.id === DOC)
  ok(c.status === 200, `增量 HTTP ${c.status}`)
  ok(!!hit, `增量里有他那篇（${c.rows.length} 篇 docs）—— 不成立后面就是空断言`)
  ok(String(c.raw).includes(SECRET), '增量里带着正文 —— 这一条是后面「有没有漏」的判据')
  if (!hit || !String(c.raw).includes(SECRET)) {
    console.log('\n基准不成立（增量本来就不发这篇），后面的断言无法证明任何事。停止。')
    stop(); process.exit(fail ? 1 : 0)
  }
}

/* ============ 白名单开、当前 IP 不在里面 ============ */
console.log('\n== 白名单开着，当前 IP 不在里面 ==')
{
  const s = await setWl(1, ['203.0.113.77'])
  ok(Number(s.row?.ipWhitelist) === 1, `设置落库（ipList=${s.row?.ipList}，故意不含本机）`)

  // 先确认已修好的几条还是好的 —— 免得把「全都漏了」误当成「只漏了这一条」
  const list = await ses('/api/entity/docs', {}, tok)
  ok((list.d?.rows?.length || 0) === 0, `文稿列表 0 行（7.29 修过，这一轮它得仍然是对的）`)
  const search = await ses('/api/search?q=' + encodeURIComponent(SECRET), {}, tok)
  ok((search.d?.results?.length || 0) === 0, `搜索 0 条（含那个机密字样）`)

  const c = await changesDocs()
  const leaked = c.rows.find((r) => r.id === DOC)
  ok(!leaked, `增量里**没有**他那篇（实际 ${c.rows.length} 篇 docs）`,
    leaked ? `—— 泄漏了：${JSON.stringify(leaked).slice(0, 160)}` : '')
  ok(!String(c.raw).includes(SECRET), '增量里不含那个机密字样',
    String(c.raw).includes(SECRET) ? '—— 正文整个发过来了' : '')
}

/* ============ 白名单开着，但来源 IP 在名单里 ============ */
/*
 * 这一段是**整个套件里最不能省的一段**。
 *
 * 前面那些只验了「不在名单 → 被拦」，那是一条**否定**断言。
 * 而一个写错的判据完全可以是「只要白名单开着就全拦」——
 * 那样前面照样全绿，而**白名单这个功能本身彻底废掉**：
 * 管理员把自己和同事都加进名单，谁都读不了，而界面上还写着
 * 「仅允许下列 IP 访问本知识库」。
 *
 * 所以必须验正向：名单内的 IP 照常拿得到。
 * 而且它是**有牙齿**的 —— 如果 X-Forwarded-For 没被采信（真实 IP 是 127.0.0.1，
 * 不在名单里），这两条会红，而不是变成一个恒真的通过。
 */
console.log('\n== 白名单开着，但来源 IP 在名单里（这一段不能省）==')
{
  const ALLOW = '203.0.113.77'
  const s = await setWl(1, [ALLOW])
  ok(Number(s.row?.ipWhitelist) === 1, `设置落库（名单里只有 ${ALLOW}）`)

  const c = await changesDocs(ALLOW)
  ok(c.rows.some((r) => r.id === DOC),
    `名单内的 IP 仍然拿得到增量（${c.rows.length} 篇 docs）`,
    c.rows.length === 0 ? '—— 判据写成了「白名单一开就全拦」，功能本身废了' : '')
  ok(String(c.raw).includes(SECRET), '正文也照常下发')

  const list = await sesFrom('/api/entity/docs', ALLOW, tok)
  ok((list.d?.rows?.length || 0) > 0, `名单内的 IP 文稿列表也有内容（${list.d?.rows?.length} 篇）`)

  // 对照：换一个不在名单里的 IP，还是拿不到 —— 证明上面那几条不是「反正都能拿到」
  const other = await changesDocs('198.51.100.9')
  ok(!other.rows.some((r) => r.id === DOC), '换个不在名单的 IP 又拿不到了（两组对照才成立）')
}

/* ============ 白名单关回去，一切恢复 ============ */
console.log('\n== 白名单关回去 ==')
{
  await setWl(0, [])
  const c = await changesDocs()
  ok(c.rows.some((r) => r.id === DOC), `增量里又有了（${c.rows.length} 篇）—— 不是被永久删掉了`)
}

/* ============ 破坏对照 ============ */
console.log('\n== 破坏对照：源码层确认判据真的在 ==')
/*
 * 源码层的断言必须**先剥掉注释**再匹配。
 *
 * 第一版没剥，于是「没有把 null 兜成空串」那条**恒为失败**：
 * 它匹配到的是我自己写的那段解释性注释里的字面量
 * `ipAllowed(bookIdOfRow, ip || '')`，而不是代码。
 *
 * 恒假的断言比没有断言更糟 —— 它会让人去改本来正确的代码。
 * 这和 run-all-tests.mjs 里「用 fromCharCode 写 U+FFFD」是同一个坑：
 * 描述缺陷的注释，本身会命中描述缺陷的正则。
 */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ')
{
  const src = readFileSync('server/sync.ts', 'utf8')
  const at = src.indexOf('export function changesSince')
  const fn = stripComments(src.slice(at, at + 5000))
  ok(/ipAllowed/.test(fn), 'changesSince 里真的调了 ipAllowed')
  ok(/ip: string \| null/.test(fn), 'ip 是必传参数（新增调用点会编译红）')
  ok(!/ip: string \| null = null/.test(fn), '没有给默认值 —— 有默认值就等于「忘了传也没事」')
  /*
   * `null` 必须表示「不做判定」，而不是「拿空串去比」。
   *
   * `ipAllowed` 内部是 `list.includes(ip)`，所以 `ip || ''` 会让
   * **每一行**都被判成不在名单里 → 同步结果整个空掉，
   * 而调用方（未来的内部读取点）完全看不出是自己漏传。
   *
   * 这是本套件**自己第一版**写错的地方：修 `/api/sync/changes` 时
   * 我顺手写了 `ipAllowed(bookIdOfRow, ip || '')`。
   * 修好漏洞之后顺手查了全项目，同类写法只有那一处 ——
   * 但一个声明成 `string | null` 的参数带着相反的语义就是定时炸弹。
   */
  ok(!/ipAllowed\([^)]*\|\|\s*''/.test(fn), "没有把 null 兜成空串（那会让每一行都被丢掉）")
  ok(/if \(ip &&/.test(fn), '判据先短路在 `ip` 上（null 直接不做判定）')
}

/* ============ null 的语义：拿别的读路径对齐 ============ */
console.log('\n== `null` 的语义和另外两条读路径一致 ==')
{
  const src = stripComments(readFileSync('server/sync.ts', 'utf8'))
  const readAt = src.indexOf('export function readEntity')
  ok(/ip !== null && !ipAllowed\(/.test(src.slice(readAt, readAt + 3000)),
    'readEntity 同样是显式判 null（不是靠空串）')
  const searchAt = src.indexOf('export function searchAll')
  ok(/ip === null \? /.test(src.slice(searchAt, searchAt + 4000)),
    'searchAll 也是同一个约定（null = 不过滤）')
}


await cleanup()
// 汇总行必须是 `结果：N 通过 / M 失败` —— run-all-tests.mjs 靠正则认这一行来计总数。
// 写成别的语序（全过也不算错）的话，套件会**一项都没进总数**，而且报的是
// 「套件本身异常」，把你引去查代码，而代码其实一点问题都没有。
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
