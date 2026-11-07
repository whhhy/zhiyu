/**
 * IP 白名单漏了附件通道（同一个家族的第四处，也是最要命的一处）
 * ============================================================
 * 家族成员：
 *   · `/api/export`           7.29 补
 *   · `/api/sync/changes`     7.31 补
 *   · WebSocket 协作房间       7.31 补
 *   · **附件通道（这一条）**
 *
 * 每处的形态都一样：**那条通路压根不经过上一条的判据**。
 *
 * ------------------------------------------------------------
 * 为什么这处最要命：它制造了一种虚假的安全感
 * ------------------------------------------------------------
 * 实测（探针，2026-10-06）：同一个人、同一个 IP、同一个白名单知识库 ——
 *
 *   `/api/doc/:id`            → 403「当前 IP 不在该知识库的白名单内」
 *   `/api/perms/book/:id`     → 403
 *   `GET  /api/attachment/:id` → **200，客户名单原文发了过来**
 *   `HEAD /api/attachment/:id` → **200**（等于确认了文件存在与大小）
 *   `DELETE /api/attachment/:id` → **200，附件真的从库里没了**
 *
 * 管理员看到「打开单篇被挡住了」，自然会认为整个库都挡住了；
 * 而附件恰恰是公司最在意的那些文件 —— 客户名单、预算表、合同扫描件。
 * 也就是说：文档正文挡住了，**真正想拿走的东西没挡住**。
 *
 * ------------------------------------------------------------
 * 四个入口都要自己判，不能指望上一条兜着
 * ------------------------------------------------------------
 * 上传 / HEAD / GET / DELETE 是四条独立入口。修法是每条都调
 * `requireIpAllowed`，而不是在某个公共 helper 里判一次 ——
 * 因为这四条根本不走同一个 helper，它们各查各的库。
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.ATTIP_PORT || await freePort()
const DB = 'data/_attip-test.db'
const BASE = `http://localhost:${PORT}`
const ALLOW_IP = '203.0.113.9'

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
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'att@2026' },
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
  const r = await fetch(BASE + p, o); const t = await r.text()
  try { return { status: r.status, d: t ? JSON.parse(t) : null } } catch { return { status: r.status, d: null, raw: t.slice(0, 120) } }
}
const ses = (p, o = {}, tk) => call(p, { ...o, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) } })
const one = (sql, ...a) => { const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000'); const r = d.prepare(sql).get(...a); d.close(); return r }
const push = (tk, upsert) => ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert, remove: {} }) }, tk)

const admin = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'att@2026' }) })).d?.token
const SFX = Math.random().toString(36).slice(2, 7)
const bk = (await ses('/api/entity/books', {}, admin)).d.rows[0]
const acct = 'att' + SFX
await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234', name: '同事' }) })
const tok = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234' }) })).d?.token
const uid = (await ses('/api/v2/user', {}, tok)).d.id

console.log('\n== 前置 ==')
{
  const g = await push(admin, { bookMembers: [{ userId: uid, bookId: bk.id, role: 'editor', perms: '{}', joinedAt: Date.now() }] })
  ok(!!admin && !!uid && !!bk, `身份与库：${uid} / ${bk.name}`)
  ok(!!one('SELECT 1 AS x FROM book_members WHERE bookId = ? AND userId = ?', bk.id, uid),
    `他是《${bk.name}》的 editor（push ${g.status}）—— 不成立就退出`)
  if (!one('SELECT 1 AS x FROM book_members WHERE bookId = ? AND userId = ?', bk.id, uid)) {
    console.log('\n前置不成立，不往下验。'); stop(); process.exit(fail ? 1 : 0)
  }
}

const DOC = 'attip_' + SFX
await push(tok, { docs: [{ id: DOC, bookId: bk.id, title: '附件探针 ' + SFX, body: 'x', createdAt: Date.now(), updatedAt: Date.now(), wordCount: 1 }] })

/**
 * 上传契约（第一版按 JSON 写被 400 打回来才发现）：
 * `docId` 走 **query 参数**，body 是**原始二进制**，文件名走 `x-filename` 头。
 */
const upload = async (name, text, ip) => fetch(`${BASE}/api/attachment?docId=${DOC}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(name), Authorization: 'Bearer ' + tok, ...(ip ? { 'X-Forwarded-For': ip } : {}) },
  body: Buffer.from(text, 'utf8'),
}).then(async (r) => ({ status: r.status, d: await r.json().catch(() => null) }))

const getAtt = (id, ip) => fetch(`${BASE}/api/attachment/${id}`, { headers: { Authorization: 'Bearer ' + tok, ...(ip ? { 'X-Forwarded-For': ip } : {}) } })
  .then(async (r) => ({ status: r.status, text: Buffer.from(await r.arrayBuffer()).toString('utf8') }))
const headAtt = (id, ip) => fetch(`${BASE}/api/attachment/${id}`, { method: 'HEAD', headers: { Authorization: 'Bearer ' + tok, ...(ip ? { 'X-Forwarded-For': ip } : {}) } })
  .then((r) => ({ status: r.status, len: r.headers.get('content-length') }))
const delAtt = (id, ip) => fetch(`${BASE}/api/attachment/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tok, ...(ip ? { 'X-Forwarded-For': ip } : {}) } })
  .then((r) => ({ status: r.status }))
const setWl = async (on, list) => {
  await push(admin, { bookSettings: [{ bookId: bk.id, ipWhitelist: on, ipList: list }] })
  return one('SELECT ipWhitelist, ipList FROM book_settings WHERE bookId = ?', bk.id)
}

const SECRET = '客户名单机密-' + SFX
let AID = ''

/* ============ 基准：白名单关着，四个入口都正常 ============ */
console.log('\n== 基准：白名单关着 ==')
{
  const s = await setWl(0, [])
  ok(Number(s?.ipWhitelist) === 0, '设置落库（白名单关着）')
  const up = await upload('客户名单.txt', SECRET)
  AID = up.d?.id
  ok(up.status === 200 && !!AID, `上传成功（${up.status}）`, up.d?.error || '')
  const g = await getAtt(AID)
  ok(g.status === 200 && g.text.includes(SECRET), '下载得到原文')
  const h = await headAtt(AID)
  ok(h.status === 200 && Number(h.len) > 0, `HEAD 200 且带 Content-Length（${h.len}）`)
  if (!AID || !g.text.includes(SECRET)) { console.log('\n基准不成立，停止。'); stop(); process.exit(fail ? 1 : 0) }
}

/* ============ 白名单开着、IP 不在里面 ============ */
console.log('\n== 白名单开着，当前 IP 不在里面 ==')
{
  const s = await setWl(1, [ALLOW_IP])
  ok(Number(s?.ipWhitelist) === 1, `设置落库（名单里只有 ${ALLOW_IP}，本机不在）`)

  // 先确认「文档侧确实被挡住了」—— 否则下面附件侧的结论没法对比
  const doc = await ses(`/api/doc/${DOC}`, {}, tok)
  ok(doc.status === 403, `对照组：/api/doc/:id → 403（${doc.status}）`)

  const g = await getAtt(AID)
  ok(g.status === 403, `附件 GET → 403（实际 ${g.status}）`,
    g.status === 200 ? `泄漏了：${g.text.slice(0, 80)}` : '')
  ok(!g.text.includes(SECRET), '**没有**拿到机密内容')

  const h = await headAtt(AID)
  ok(h.status === 403, `附件 HEAD → 403（实际 ${h.status}）—— 否则等于确认了文件存在与大小`)

  const d = await delAtt(AID)
  ok(d.status === 403, `附件 DELETE → 403（实际 ${d.status}）`)
  ok(!!one('SELECT 1 AS x FROM attachments WHERE id = ?', AID),
    '**附件还在库里** —— 修之前这一条是被真的删掉的')

  const up = await upload('偷偷传一个.txt', 'x')
  ok(up.status === 403, `往白名单外的库里上传 → 403（实际 ${up.status}）`)
}

/* ============ 白名单开着、IP 在名单里 ============ */
console.log('\n== 白名单开着，但来源 IP 在名单里（这一段不能省）==')
{
  const s = await setWl(1, [ALLOW_IP])
  ok(Number(s?.ipWhitelist) === 1, '设置落库')

  const g = await getAtt(AID, ALLOW_IP)
  ok(g.status === 200 && g.text.includes(SECRET), `名单内的 IP 照常下载（${g.status}）`,
    g.status === 403 ? '—— 判据写成了「开了白名单就一律拒绝」，把名单内的同事也挡了' : '')
  const h = await headAtt(AID, ALLOW_IP)
  ok(h.status === 200, `HEAD 也照常（${h.status}）`)
  const up = await upload('名单内的人传.txt', 'y', ALLOW_IP)
  ok(up.status === 200, `名单内的 IP 照常上传（${up.status}）`, up.d?.error || '')
}

/* ===================================================================
   整个家族：每一条「按知识库访问」的路由都要自己判 IP
   -------------------------------------------------------------------
   上面验的是附件通道。这一节把**全部**同类路由一次性钉住 ——
   因为这个家族已经被找到四处漏（export / sync changes / WS / 附件），
   而每一处的形态都一样：**那条通路压根不经过上一条的判据**。
 *
 * 一条一条加判据，靠的是「我记得」，而这正是本项目记过最多次的坑。
 * 这里的做法是反过来：把清单**写成数据**，让套件逐条跑。
 * 以后再加新路由，只要往这张表里加一行就自动纳入检查。
 * =================================================================== */
console.log('\n== 整个家族：逐条路由 ==')
{
  /*
   * ⚠️ 顺序：**先关白名单，再做任何事**。
   * 上一节结束时白名单是开着的，而这一节一开始就去取 `/api/entity/books` ——
   * admin 的 127.0.0.1 同样在名单外 → 拿到空数组 → `B1.id` 直接抛异常，
   * 整节一条断言都没跑就退出（症状：只打了个标题，然后什么都没有）。
   *
   * 修法是把它当一条纪律：**要造素材、要查数据，先回到白名单关着的状态。**
   */
  await setWl(0, [])
  const BOOKS = (await ses('/api/entity/books', {}, admin)).d.rows
  const B1 = BOOKS[0], B2 = BOOKS[1]
  if (!B1 || !B2) { ok(false, `需要两个知识库做素材，实际 ${BOOKS.length} 个 —— 本节跳过`); }
  const D2 = 'attip2_' + SFX
  const mkRow = (title, body) => ({ id: D2, bookId: B1.id, title, body, blocks: [{ type: 'p', text: body }], createdAt: Date.now(), updatedAt: Date.now(), wordCount: 1 })
  /*
   * ⚠️ 素材必须在**白名单关着**的时候建。
   * 上一节结束时白名单是开着的，于是这里的 push 会被白名单本身拒掉 ——
   * 然后后面十几条断言全在验一篇**根本不存在**的文档，症状是 404/403/200
   * 各种乱的都有，而真相是「测试自己的顺序错了」。
   *
   * 这和 README 里记的那条是同一件事：**建完立刻回读**。
   * 所以这里先关白名单、再建、建完查库确认在，才继续往下验。
   */
  await setWl(0, [])
  await push(tok, { docs: [mkRow('家族探针 ' + SFX, '正文一' + SFX)] })
  await push(tok, { docs: [mkRow('家族探针改 ' + SFX, '正文二' + SFX)] })
  /*
   * `versions` 要真的**有内容**可漏，否则「没有拿到」就是空断言。
   * 而版本是**客户端 store 生成的**（`addDocVersion`），服务端 push 文档本身
   * 不会凭空造出版本 —— 第一版没造，于是 `versions` 永远是空数组，
   * 那条「名单内的 IP 拿得到版本」的判据恒假。
   */
  const VER = 'v_' + SFX
  await push(tok, {
    docVersions: [{
      id: VER, docId: D2, title: '家族探针 ' + SFX, body: '第一版' + SFX,
      blocks: [{ type: 'p', text: '第一版' + SFX }], label: '改之前',
      createdAt: Date.now() - 60000, updatedAt: Date.now() - 60000, at: Date.now() - 60000,
    }],
  })
  const verRows = Number(one('SELECT COUNT(*) AS n FROM doc_versions WHERE docId = ?', D2)?.n || 0)
  if (verRows < 1) ok(false, '没造出历史版本（后面那条 versions 判据会恒假）')
  // 不可逆操作那一节要用的「受害者」也得在这时候建好（理由同上）
  const VICTIM = 'attipv_' + SFX
  await push(tok, { docs: [{ id: VICTIM, bookId: B1.id, title: '不可逆探针 ' + SFX, body: 'x', createdAt: Date.now(), updatedAt: Date.now(), wordCount: 1 }] })
  if (!one('SELECT 1 AS x FROM docs WHERE id = ?', D2) || !one('SELECT 1 AS x FROM docs WHERE id = ?', VICTIM)) {
    console.log('\n探针没建出这些文档，后面全是无效断言。停止。'); stop(); process.exit(fail ? 1 : 0)
  }

  const sesX = (p, o, ip) => call(p, { ...o, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok, 'X-Forwarded-For': ip } })

  /** 每条路由写全：路径、方法、body、成功判据 */
  const ROUTES = [
    { name: 'GET  /api/doc/:id', path: `/api/doc/${D2}`, o: {}, ok: (r) => r.status === 200 },
    { name: 'GET  /api/doc/:id/versions', path: `/api/doc/${D2}/versions`, o: {}, ok: (r) => r.status === 200 && (r.d?.versions || []).some((v) => String(v.id) === VER) },
    { name: 'GET  /api/doc/:id/backlinks', path: `/api/doc/${D2}/backlinks`, o: {}, ok: (r) => r.status === 200 },
    { name: 'GET  /api/doc/:id/links', path: `/api/doc/${D2}/links`, o: {}, ok: (r) => r.status === 200 },
    { name: 'GET  /api/doc/:id/share', path: `/api/doc/${D2}/share`, o: {}, ok: (r) => r.status === 200 },
    { name: 'GET  /api/perms/doc/:id', path: `/api/perms/doc/${D2}`, o: {}, ok: (r) => r.status === 200 && r.d?.caps?.read === true },
    { name: 'POST /api/doc/:id/view', path: `/api/doc/${D2}/view`, o: { method: 'POST' }, ok: (r) => r.status === 200 },
    { name: 'POST /api/doc/:id/share', path: `/api/doc/${D2}/share`, o: { method: 'POST', body: JSON.stringify({ allowDownload: true }) }, ok: (r) => r.status === 200 },
  ]

  await setWl(1, [ALLOW_IP])
  for (const rt of ROUTES) {
    const blocked = await ses(rt.path, rt.o, tok)
    ok(blocked.status === 403, `${rt.name} → 403（实际 ${blocked.status}）`,
      blocked.status === 200 ? '白名单外的 IP 拿到了东西' : '')
    const allowed = await sesX(rt.path, rt.o, ALLOW_IP)
    ok(rt.ok(allowed), `${rt.name} → 名单内的 IP 放行（实际 ${allowed.status}）`,
      '判据写成了「白名单一开就一律拒」的话，这里会红')
  }

  // 不可逆的那条：挡住的 IP 不许真的生效
  if (B2) {
    const mv = await ses(`/api/doc/${VICTIM}/move`, { method: 'POST', body: JSON.stringify({ bookId: B2.id, mode: 'move' }) }, tok)
    ok(mv.status === 403, `POST /api/doc/:id/move → 403（实际 ${mv.status}）`, mv.d?.error || '')
    /*
     * 「还在不在」必须**直接查库**，不能走 API ——
     * 而 `/api/doc/:id` 现在正被白名单挡住（那正是刚修好的）。
     * 第一版用 API 查，于是「查不到」被读成「文档被搬走了」，
     * 而真相是**查询本身被正确地拒了**。
     */
    ok(String(one('SELECT bookId FROM docs WHERE id = ?', VICTIM)?.bookId || '') === B1.id,
      '**文档真的还在原库**（直接查库确认；修之前它被搬到别的库去了）')
  }
}

/* ============ 源码层：四个入口各自判一次 ============ */
console.log('\n== 源码层 ==')
{
  const src = readFileSync('server/index.ts', 'utf8')
  /*
   * ⚠️ 这里踩过一次「按锚点取窗口」的坑：四个入口里有三个的路径是
   * `/api/attachment/:id`，我第一版全写成 `/api/attachment` ——
   * `indexOf` 返回 **-1**，`cut()` 于是返回**空串**，
   * 正则匹配不到，四条断言全红。
   *
   * 而「代码没写」和「窗口取空了」在输出上完全一样。
   * 所以 cut() 找不到起点时**必须显式失败**，不能默默返回空串。
   */
  const cut = (fromMark, toMark) => {
    const a = src.indexOf(fromMark)
    if (a < 0) throw new Error(`探针坏了：找不到起点 ${fromMark}（空窗口会被读成「代码没写」）`)
    const b = src.indexOf(toMark, a)
    if (b < 0) throw new Error(`探针坏了：找不到终点 ${toMark}`)
    return src.slice(a, b)
  }
  ok(/requireIpAllowed/.test(cut("on('POST', '/api/attachment'", "on('HEAD', '/api/attachment/:id'")),
    '上传入口判了 IP')
  ok(/requireIpAllowed/.test(cut("on('HEAD', '/api/attachment/:id'", "on('GET', '/api/attachment/:id'")),
    'HEAD 入口判了 IP')
  ok(/requireIpAllowed/.test(cut("on('GET', '/api/attachment/:id'", "on('DELETE', '/api/attachment/:id'")),
    'GET 入口判了 IP')
  ok(/requireIpAllowed/.test(cut("on('DELETE', '/api/attachment/:id'", "on('GET', '/api/export'")),
    'DELETE 入口判了 IP')
  const n = (src.match(/requireIpAllowed\(/g) || []).length
  ok(n >= 5, `requireIpAllowed 在 index.ts 里有 ${n} 处调用（每条独立通路各判一次）`)
}

/* ===================================================================
   刻意**不**判 IP 白名单的那几条（补上是错的）
   -------------------------------------------------------------------
   2026-10-06 为了收口 IP 白名单，扫过一遍全部路由。这种「没判 IP」的接口
   一眼就会被当成漏网而补上 —— 而补上是**错的**：

   · `spaces/:id/members`（名册 / 加人 / 移人）管的是**空间**的成员关系，
     而 IP 白名单挂在**知识库**上。一个空间下 4 个库、其中 1 个开了白名单，
     拿那 1 个库的名单去卡整个空间的名册 —— 等于「一个库设了网段限制，
     整个空间的成员名单跟着消失」。
   · 而且它会把管理员锁在外面：开白名单的本意是「这份资料不出内网」，
     而管理员出差时加个人、移个人是很正常的事。

   所以这里把「刻意不判」**钉成断言**：将来有人补上判定，这条会红，
   提醒他先想清楚是不是要改这个取舍，而不是默默改掉。
 * =================================================================== */
console.log('\n== 刻意不判 IP 白名单的那几条（补上是错的）==')
{
  const src = readFileSync('server/index.ts', 'utf8')
  const at = src.indexOf("on('GET', '/api/spaces/:id/members'")
  const seg = at < 0 ? '' : src.slice(Math.max(0, at - 2600), at + 4000)
  ok(seg.length > 0, '（能定位到空间成员那一族路由）')
  ok(/刻意不判 IP 白名单/.test(seg), '代码里写明了「这一族刻意不判 IP」')
  ok(/粒度不对/.test(seg) && /会把管理员锁在外面/.test(seg), '并且写清了**为什么**（粒度不对 + 会把管理员锁在外面）')
  ok(/防止「好心补上」/.test(seg), '还写明了「写这段是为了防止有人顺手补上」')
  // 三条路由本身确实没有 IP 判定 —— 这条是**前提**，钉的是「不判」这件事本身
  for (const [m, p] of [['GET', '/api/spaces/:id/members'], ['POST', '/api/spaces/:id/members'], ['DELETE', '/api/spaces/:id/members/:userId']]) {
    const a = src.indexOf(`on('${m}', '${p}'`)
    const b = a < 0 ? -1 : src.indexOf('\n})', a)
    const body = a < 0 || b < 0 ? '' : src.slice(a, b)
    ok(a >= 0 && body.length > 0 && !/requireIpAllowed|ipAllowed\(/.test(body),
      `${m} ${p} 确实没有 IP 判定（前提成立，这条钉的是「不判」这件事本身）`)
  }
}

await cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
