/**
 * 开着 IP 白名单的「第一天」，一步步都不该被 403 打断
 * ============================================================
 * 今天给 **13 条**通路补了 IP 判定（`/api/sync/changes`、WebSocket 协作房间、
 * 附件四入口、doc 九条子路由、`perms/doc`），每一处都有单独的用例。
 * 但**没有哪个测试走一遍「白名单开着、正常使用」的完整流程**。
 *
 * 而这正是最该防的回归形态：
 * 单独测每条路由时，如果我判错了其中一条**而那条恰好没被单独测到**，
 * 逐个测试全绿，真实同事却在「传个附件」或「看历史版本」那一步撞上 403 ——
 * 而这个功能本来就是管理员主动开的。
 *
 * ------------------------------------------------------------
 * 这一节的形态和别处不一样：它不验「某个东西被拒绝」，
 * 它验的是**「该通的全都通」**。所以它的每一步都必须是真操作，
 * 不能只发请求看状态码。
 * =================================================================== */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { WebSocket } from 'ws'

const PORT = process.env.DAY1_PORT || '8242'
const DB = 'data/_day1-test.db'
const BASE = `http://localhost:${PORT}`
const ALLOW = '203.0.113.77'   // 名单里只有它；本机 127.0.0.1 被挡
const OK_IP = ALLOW            // 身份扮演「从名单内的 IP 来的」

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
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'd1@2026', YQ_DEMO: '0' },
  stdio: ['ignore', 'ignore', 'ignore'],
})
/* ---- 收摊：等子进程**真的退出**再删库 ----
 *
 * ⚠️ 原来只有 `process.on('exit', stop)`：exit 处理器是**同步**的，
 * `srv.kill()` 只是发信号，那一刻子进程还活着（Windows 文件锁），
 * 删库必然失败又被空 catch 吞掉 —— 于是每单独跑一次，data/ 里就多留一个库。
 * 全量跑时 runner 的清扫会兜住，**单独跑不会**；而单独跑正是排查时做的事。
 */
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
      try { rmSync(DB + s, { force: true }); gone = true } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
    if (!gone && existsSync(DB + s)) stuck.push(DB + s)
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
  try { return { status: r.status, d: t ? JSON.parse(t) : null, raw: t } } catch { return { status: r.status, d: null, raw: t } }
}
/** ip=null 就是「名单外」，ip=ALLOW 是「名单内」 */
const ses = (p, o = {}, tk, ip = null) => call(p, {
  ...o,
  headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}), ...(ip ? { 'X-Forwarded-For': ip } : {}) },
})
const one = (sql, ...a) => { const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000'); const r = d.prepare(sql).get(...a); d.close(); return r }

/* ---------------- 建库、两个账号 ---------------- */
console.log('\n== 前置：一个干净的库（YQ_DEMO=0）+ 两个账号 ==')
const admin = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'd1@2026' }) })).d?.token
{
  const boot0 = (await ses('/api/bootstrap?lite=0', {}, admin)).d
  ok(!!admin, '管理员登录')
  ok((boot0?.data?.books || []).length === 0, 'YQ_DEMO=0 的干净库确实没有演示内容', String(boot0?.data?.books?.length))
  ok((boot0?.data?.spaces || []).length === 1, '但有 1 个个人空间（管理员自己的）', String(boot0?.data?.spaces?.length))
}
const ACCOUNT = 'd1u' + Math.random().toString(36).slice(2, 6)
await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: ACCOUNT, password: 'test1234', name: '新同事' }) })
const userTok = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: ACCOUNT, password: 'test1234' }) })).d?.token
const USER = (await ses('/api/v2/user', {}, userTok)).d
ok(!!userTok && !!USER?.id, `新同事账号：${USER?.id}`)

/* ---------------- 建空间、建库、加人 ---------------- */
console.log('\n== 第一天：建空间 / 建库 / 加人（名单内）==')
let BOOK = ''
{
  const sp = await ses('/api/spaces', { method: 'POST', body: JSON.stringify({ name: '研发部', desc: '部门空间' }) }, admin, OK_IP)
  ok(sp.status === 200, `建空间（${sp.status}）`, sp.raw?.slice(0, 100))
  const spaceId = sp.d?.space?.id
  const bk = await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { books: [{ id: 'b_day1', spaceId, name: '研发手册', desc: '', avatar: '', visibility: 'private', createdAt: Date.now(), updatedAt: Date.now() }] }, remove: {} }),
  }, admin, OK_IP)
  ok(bk.status === 200 && !(bk.d?.rejected || []).length, `建知识库（${bk.status}）`, JSON.stringify(bk.d?.rejected).slice(0, 120))
  const bid = spaceId ? (one('SELECT id FROM books WHERE spaceId = ?', spaceId) || {}).id : ''
  BOOK = String(bid || 'b_day1')
  const add = await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { bookMembers: [{ userId: USER.id, bookId: BOOK, role: 'editor', perms: '{}', joinedAt: Date.now() }] }, remove: {} }),
  }, admin, OK_IP)
  ok(add.status === 200 && !(add.d?.rejected || []).length, `把人加进知识库（${add.status}）`, JSON.stringify(add.d?.rejected).slice(0, 120))

  // 关键：打开白名单，从这里开始每一步都要能从名单内正常走
  const wl = await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { bookSettings: [{ bookId: BOOK, ipWhitelist: 1, ipList: [ALLOW] }] }, remove: {} }),
  }, admin, OK_IP)
  ok(wl.status === 200, `**打开 IP 白名单**（${wl.status}）`)
}

/* ---------------- 开着白名单，同事走完一整天的活 ---------------- */
console.log('\n== 白名单开着：新同事做完一整天的活，每一步都不该 403 ==')
const DOC = 'day1doc'
{
  const steps = [
    ['bootstrap 拿到工作台', () => ses('/api/bootstrap', {}, userTok, OK_IP)],
    ['文稿列表', () => ses('/api/entity/docs', {}, userTok, OK_IP)],
    ['建一篇文档', () => ses('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({ upsert: { docs: [{ id: DOC, bookId: BOOK, title: '入职第一篇', body: '# 入职\n\n第一天。', blocks: [{ type: 'h1', text: '入职' }, { type: 'p', text: '第一天。' }], createdAt: Date.now(), updatedAt: Date.now(), wordCount: 4 }] }, remove: {} }),
    }, userTok, OK_IP)],
    ['打开单篇', () => ses(`/api/doc/${DOC}`, {}, userTok, OK_IP)],
    ['历史版本', () => ses(`/api/doc/${DOC}/versions`, {}, userTok, OK_IP)],
    ['正向链接', () => ses(`/api/doc/${DOC}/links`, {}, userTok, OK_IP)],
    ['反向链接', () => ses(`/api/doc/${DOC}/backlinks`, {}, userTok, OK_IP)],
    ['知识库能力面板', () => ses(`/api/perms/book/${BOOK}`, {}, userTok, OK_IP)],
    ['文档能力面板', () => ses(`/api/perms/doc/${DOC}`, {}, userTok, OK_IP)],
    ['分享设置', () => ses(`/api/doc/${DOC}/share`, {}, userTok, OK_IP)],
    ['记一次阅读', () => ses(`/api/doc/${DOC}/view`, { method: 'POST' }, userTok, OK_IP)],
    ['搜索', () => ses('/api/search?q=' + encodeURIComponent('入职'), {}, userTok, OK_IP)],
    ['增量同步', () => ses('/api/sync/changes?since=0', {}, userTok, OK_IP)],
    ['上传附件', () => fetch(`${BASE}/api/attachment?docId=${DOC}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + userTok, 'X-Forwarded-For': OK_IP, 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent('入职须知.txt') },
      body: '第一天要带的东西',
    }).then((r) => ({ status: r.status, raw: '' }))],
  ]
  for (const [name, fn] of steps) {
    const r = await fn()
    const good = r.status >= 200 && r.status < 400
    ok(good, `${name} → ${r.status}`, good ? '' : String(r.raw || '').slice(0, 120))
  }
  // 附件的三种操作
  const row = one('SELECT id FROM attachments WHERE docId = ?', DOC)
  const attId = String(row?.id || '')
  ok(!!attId, '附件真的落库了', String(attId))
  if (attId) {
    const h = await fetch(`${BASE}/api/attachment/${attId}`, { method: 'HEAD', headers: { Authorization: 'Bearer ' + userTok, 'X-Forwarded-For': OK_IP } })
    ok(h.status === 200, `附件 HEAD → ${h.status}`)
    // ⚠️ 用原生 fetch 拿 body —— `call()` 那个 helper 已经把流读掉了，
    //    拿它的结果调 `arrayBuffer()` 会得到 "not a function"。
    const g = await fetch(`${BASE}/api/attachment/${attId}`, { headers: { Authorization: 'Bearer ' + userTok, 'X-Forwarded-For': OK_IP } })
    const text = Buffer.from(await g.arrayBuffer()).toString('utf8')
    ok(g.status === 200 && text.includes('第一天要带的东西'), `附件能下载且内容对（${g.status}）`, text.slice(0, 80))
    const d = await call(`/api/attachment/${attId}?docId=${DOC}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + userTok, 'X-Forwarded-For': OK_IP } })
    ok(d.status === 200, `附件能删（${d.status}）`, String(d.raw).slice(0, 80))
  }
  // WebSocket 协作
  {
    const openWs = (tk, ip) => new Promise((res, rej) => {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Authorization: 'Bearer ' + tk, 'X-Forwarded-For': ip } })
      ws.on('open', () => res(ws)); ws.on('error', rej)
      setTimeout(() => rej(new Error('ws 超时')), 8000)
    })
    let peerGot = false, denied = ''
    try {
      const a = await openWs(userTok, OK_IP)
      const b = await openWs(admin, OK_IP)
      // ⚠️ 监听要挂在**接收方**上：第一版挂在 `b` 上，可 `b` 是发送方，
      //    而 `broadcastToRoom(docId, m, c)` 明确排除发送者自己 ——
      //    于是 `b` 永远收不到，而症状是「协同没通」，看起来像产品坏了。
      const inbox = new Promise((r) => { const got = []; const on = (m) => { try { got.push(JSON.parse(String(m))) } catch {} }; b.on('message', on); setTimeout(() => { b.off('message', on); r(got) }, 1400) })
      a.send(JSON.stringify({ ctl: 'join', docId: DOC, memberId: USER.id }))
      b.send(JSON.stringify({ ctl: 'join', docId: DOC, memberId: 'admin' }))
      await new Promise((r) => setTimeout(r, 700))
      a.send(JSON.stringify({ docId: DOC, kind: 'op', ops: [{ type: 'insert', pos: 0, text: '协同内容' }] }))
      const got = await inbox
      peerGot = got.some((g) => JSON.stringify(g).includes('协同内容'))
      denied = String((got.find((g) => g.ctl === 'denied') || {}).reason || '')
      a.close(); b.close()
    } catch (e) { denied = '连接失败：' + (e?.message || e) }
    ok(peerGot, '实时协同房间能进、消息能收到', denied ? '被拒：' + denied : '')
    ok(!denied, '没有因为白名单被误挡', denied)
  }
}

/* ---------------- 反向：名单外真的拿不到受限库 ---------------- */
console.log('\n== 对照：名单外的 IP 拿不到那个受限知识库（否则上面全是空的）==')
{
  const boot = await ses('/api/bootstrap', {}, userTok, null)          // 不带 XFF = 名单外
  const books = boot.d?.data?.books || []
  ok(!(books || []).some((b) => b.id === BOOK),
    `名单外看不到「研发手册」（返回了 ${books.length} 个库）`,
    JSON.stringify((books || []).map((b) => b.id)).slice(0, 120))
  const doc = await ses(`/api/doc/${DOC}`, {}, userTok, null)
  ok(doc.status === 403, `名单外的单篇 → 403（实际 ${doc.status}）`)
  const search = await ses('/api/search?q=' + encodeURIComponent('入职'), {}, userTok, null)
  const hits = (search.d?.results || []).filter((r) => r.id === DOC)
  ok(hits.length === 0, `名单外搜不到那篇（命中 ${hits.length} 条）`)
  const changes = await ses('/api/sync/changes?since=0', {}, userTok, null)
  const leaked = (changes.d?.upsert?.docs || []).some((r) => r.id === DOC)
  ok(!leaked, '名单外的增量里没有那篇正文')
}

/* ---------------- 源码层：白名单判定不许被误改成「一律拒绝」 ---------------- */
console.log('\n== 源码层 ==')
{
  const idx = readFileSync('server/index.ts', 'utf8')
  const n = (idx.match(/requireIpAllowed\(/g) || []).length
  ok(n >= 20, `index.ts 里有 ${n} 处 requireIpAllowed 调用（13 处是今天补的）`)
  const src = readFileSync('src/lib/api.ts', 'utf8')
  ok(!/YQ_BASE_PATH/.test(src), '前端没在找一个不存在的运行期变量')
}

stop()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
