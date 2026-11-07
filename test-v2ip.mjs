/**
 * IP 白名单在 `/api/v2` 上以前是**完全没生效的**
 * ============================================================
 * 知识库设置里有一项「仅允许下列 IP 访问本知识库，其余请求将被拒绝」，
 * 存进 SQLite、同步到各设备、界面上写着一句明确的承诺。
 * README 那一栏也写着「✅ 读正文按来源 IP 拦截」。
 *
 * ------------------------------------------------------------
 * 实际只在一个入口成立
 * ------------------------------------------------------------
 * `requireIpAllowed()` 全项目只有两个调用点：`requireDoc`（网页端那条）
 * 和导出接口。**`/api/v2` 的 8 条路由一条都没调。**
 *
 * 实测（白名单放行 203.0.113.24，从 198.51.100.7 发请求，管理员身份）：
 *
 *   /api/doc/d1                 → 403  拦住了
 *   GET  /api/v2/.../docs/d1    → 200  **完整正文 296 字符**
 *   GET  /api/v2/.../docs       → 200  **10 篇的标题 / 字数 / 标签**
 *   GET  /api/v2/.../toc        → 200  **4 个根节点**
 *   PUT  /api/v2/.../docs/d1    → 200  **标题被改了**
 *   DELETE /api/v2/.../docs/d1  → 200  **文档被删进回收站了**
 *
 * ------------------------------------------------------------
 * 为什么这一条比别的权限问题要紧
 * ------------------------------------------------------------
 * **令牌只对 `/api/v2` 生效。** 也就是说 v2 是唯一能用 API 令牌在**网外**
 * 操作知识库的通道。而 DEPLOY 又明说「照着语雀官方文档写的脚本改个域名
 * 就能先跑起来」——那些脚本走的正是这里。
 *
 * 于是管理员配了「仅限公司网段，本资料不出内网」之后，实际状态是：
 * **任何拿到令牌的人，从任何 IP，都能把这个库读走、改标题、删进回收站。**
 * 承诺越具体，这个洞越贵。
 * ============================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const PORT = process.env.V2IP_PORT || '8193'
const DB = 'data/_v2ip-test.db'
const BASE = `http://localhost:${PORT}`

/** 白名单里放行 TEST-NET-3（文档保留段）；本机模拟的「网外」地址用 TEST-NET-2 */
const ALLOW_IP = '203.0.113.24'
const OUTSIDE_IP = '198.51.100.7'

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
  env: { ...process.env, PORT, YQ_DB: DB }, stdio: ['ignore', 'pipe', 'pipe'],
})
srv.stdout.on('data', () => {})
srv.stderr.on('data', () => {})
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
  try { if ((await fetch(`${BASE}/api/health`)).ok) { up = true; break } } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 500))
}
if (!up) { console.error('服务没能在 20 秒内起来'); stop(); process.exit(1) }

const call = async (p, o = {}) => {
  const r = await fetch(BASE + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}) } })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}
const ses = (p, o = {}, t) => call(p, { ...o, headers: { ...(o.headers || {}), Authorization: 'Bearer ' + t } })

const admin = (await call('/api/auth/login', { method: 'POST', body: JSON.stringify({ account: 'admin', password: 'yuque@2026' }) })).json.token || ''
ok(!!admin, '管理员登录成功')

const books = (await ses('/api/entity/books', {}, admin)).json.rows
ok(books.length >= 2, `种子库里有至少两个知识库（实际 ${books.length}）—— 「列库」那条要对比着看`)

/** 只对 WL 那个库开白名单；另一个保持「无限制」，用来对照 */
const WL = books[0]
const FREE = books.find((b) => b.id !== WL.id)

const IN = (t) => ({ Authorization: 'Bearer ' + t, 'X-Forwarded-For': ALLOW_IP })
const OUT = (t) => ({ Authorization: 'Bearer ' + t, 'X-Forwarded-For': OUTSIDE_IP })

const setWL = (bookId, on) => ses('/api/sync/push', {
  method: 'POST', headers: { Authorization: 'Bearer ' + admin },
  body: JSON.stringify({ upsert: { bookSettings: [{ bookId, ipWhitelist: on ? 1 : 0, ipList: on ? [ALLOW_IP] : [], restrictExport: 0, watermark: 0, watermarkText: '', autoRevoke: 0, publicAccess: 0, defaultWidth: 'standard', defaultVisibility: 'space' }] }, remove: {} }),
}, admin)

const readRow = (id) => {
  const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000')
  const r = d.prepare('SELECT id, title, trashed, body FROM docs WHERE id = ?').get(id)
  d.close()
  return r
}

console.log('\n== 基准：网页端那条路本来就拦得住（否则后面验的就不是同一件事）==')
{
  /*
   * 白名单**必须先打开**。第一版把这节写在开开关之前，
   * 于是「白名单外 IP 读正文」拿到 200，两项红 ——
   * 而 200 在那个时点是**对的**（开关还没开，白名单对谁都不生效）。
   * 红的不是代码，是我的期望算错了：
   * 想验「开关拦住了」，前提得是「开关开着」。
   */
  await setWL(WL.id, true)
  /*
   * ⚠️ 这里取列表的请求**必须带白名单内的 IP**。
   * 7.29 之后「文稿列表」也走白名单了（以前只有打开单篇才查），
   * 而这条请求不带 X-Forwarded-For → 真实 IP 是 127.0.0.1 →
   * 不在名单里 → 列表 0 行 → `D` 是 undefined → 整个套件崩在第一行。
   *
   * 改动本身是对的：7.21 之前管理员在网页端**能列文档、只是打不开**，
   * 那才是更别扭的状态（看见却点不开）。现在白名单真的生效了。
   */
  const D = (await ses('/api/entity/docs', { headers: IN(admin) }, admin)).json.rows.find((d) => d.bookId === WL.id && !d.trashed)
  ok(!!D, '（前置）白名单内的 IP 能取到这个库的文档列表', String(D?.id))
  if (!D) { console.log('\n前置不成立，不往下验。'); stop(); process.exit(1) }
  const inn = await ses(`/api/doc/${D.id}`, { headers: { 'X-Forwarded-For': ALLOW_IP } }, admin)
  const out = await ses(`/api/doc/${D.id}`, { headers: { 'X-Forwarded-For': OUTSIDE_IP } }, admin)
  ok(inn.status === 200, '白名单内 IP 读正文 → 200', String(inn.status))
  ok(out.status === 403, '白名单外 IP 读正文 → 403（基准，它一直是拦得住的）', String(out.status))
  ok(/白名单/.test(String(out.json?.error || '')), '拒绝时说清了是白名单问题，不是笼统的「没有权限」', String(out.json?.error).slice(0, 70))
}

/* ---------------------------------------------------------------- */
console.log('\n== 白名单内：v2 一条都不能误伤 ==')
{
  const chk = (await ses('/api/entity/bookSettings', { headers: IN(admin) }, admin)).json.rows.find((r) => r.bookId === WL.id)
  ok(Number(chk?.ipWhitelist) === 1 && JSON.stringify(chk?.ipList) === JSON.stringify([ALLOW_IP]),
    '白名单开关存下了（后面验的不是「开关没存」）', JSON.stringify({ w: chk?.ipWhitelist, l: chk?.ipList }))

  const D = (await ses('/api/entity/docs', { headers: IN(admin) }, admin)).json.rows.find((d) => d.bookId === WL.id && !d.trashed)
  const p = `/api/v2/repos/${WL.spaceId}/${WL.id}`
  ok((await ses(`${p}/docs/${D.id}`, { headers: IN(admin) }, admin)).status === 200, '读单篇 → 200')
  ok((await ses(`${p}/docs`, { headers: IN(admin) }, admin)).status === 200, '读列表 → 200')
  ok((await ses(`${p}/toc`, { headers: IN(admin) }, admin)).status === 200, '读目录 → 200')
  ok((await ses(`/api/v2/repos`, { headers: IN(admin) }, admin)).status === 200, '列知识库 → 200')
}

console.log('\n== 白名单外：v2 每一条都必须 403 ==')
{
  const p = `/api/v2/repos/${WL.spaceId}/${WL.id}`
  // 取 docId 也必须带白名单内的 IP —— 列表本身现在也走白名单了
  const docId = (await ses('/api/entity/docs', { headers: IN(admin) }, admin)).json.rows.find((d) => d.bookId === WL.id && !d.trashed)?.id
  ok(!!docId, '（前置）拿到一篇文稿的 id', String(docId))
  if (!docId) { console.log('前置不成立，不往下验。'); stop(); process.exit(1) }
  const cases = [
    ['读单篇', `${p}/docs/${docId}`, {}],
    ['读列表', `${p}/docs`, {}],
    ['读目录', `${p}/toc`, {}],
    ['读库信息', `/api/v2/repos/${WL.spaceId}/${WL.id}`, {}],
    ['建文稿', `${p}/docs`, { method: 'POST', body: JSON.stringify({ title: '白名单外建的', body: '# 不该进得来' }) }],
  ]
  for (const [label, path, opt] of cases) {
    const r = await ses(path, { ...opt, headers: OUT(admin) }, admin)
    ok(r.status === 403, `${label} → 403`, `${r.status} ${String(r.json?.error || '').slice(0, 50)}`)
  }

  // 改和删单独验：403 之后必须**查库确认真没写进去**。
  // 「返回 403 但其实已经改了」是完全可能的（先写后判），那时候光看状态码是绿的。
  const D = (await ses('/api/entity/docs', { headers: IN(admin) }, admin)).json.rows.find((d) => d.bookId === WL.id && !d.trashed)
  const before = readRow(D.id)
  const put = await ses(`${p}/docs/${D.id}`, { method: 'PUT', headers: OUT(admin), body: JSON.stringify({ title: '白名单外改的标题' }) }, admin)
  ok(put.status === 403, '改文稿 → 403', String(put.status))
  const afterPut = readRow(D.id)
  ok(afterPut?.title === before?.title, '**查库确认标题真的没变**（403 不等于没写进去）',
    `库里是 ${JSON.stringify(String(afterPut?.title).slice(0, 30))}，原来 ${JSON.stringify(String(before?.title).slice(0, 20))}`)

  const del = await ses(`${p}/docs/${D.id}`, { method: 'DELETE', headers: OUT(admin) }, admin)
  ok(del.status === 403, '删文稿 → 403', String(del.status))
  const afterDel = readRow(D.id)
  ok(Number(afterDel?.trashed) === 0, '**查库确认它没进回收站**',
    `trashed=${afterDel?.trashed}`)
}

/* ---------------------------------------------------------------- */
console.log('\n== 令牌：这是最要紧的一半 ==')
{
  /*
   * 令牌**只对 /api/v2 生效**，所以它就是这个洞的真实入侵面：
   * 网页端那条路本来就是拦得住的，漏的恰恰是令牌能走的这一条。
   * 用会话验一遍不算数 —— 得用令牌验。
   */
  const tk = (await ses('/api/tokens', { method: 'POST', body: JSON.stringify({ name: '网外脚本', scopes: ['read', 'write'], days: 0 }) }, admin)).json
  ok(typeof tk.token === 'string' && tk.token.startsWith('yq_'), '建了一把 read+write 令牌', JSON.stringify(tk).slice(0, 80))

  const p = `/api/v2/repos/${WL.spaceId}/${WL.id}`
  const D = (await ses('/api/entity/docs', { headers: IN(admin) }, admin)).json.rows.find((d) => d.bookId === WL.id && !d.trashed)
  const before = readRow(D.id)

  const rd = await ses(`${p}/docs/${D.id}`, { headers: OUT(tk.token) }, admin)
  ok(rd.status === 403, '**令牌 + 白名单外 IP 读正文 → 403**', `${rd.status} ${String(rd.json?.body || '').slice(0, 40)}`)
  ok(!rd.json?.body, '响应里没有正文（不是「403 但把内容也带上了」）', String(rd.json?.body).slice(0, 40))

  const ls = await ses(`${p}/docs`, { headers: OUT(tk.token) }, admin)
  ok(ls.status === 403, '令牌读列表 → 403', String(ls.status))
  ok(!JSON.stringify(ls.json).includes(WL.name), '**列表响应里连库名都没带**', String(ls.json).slice(0, 80))

  const wr = await ses(`${p}/docs/${D.id}`, { method: 'PUT', headers: OUT(tk.token), body: JSON.stringify({ title: '令牌改的' }) }, admin)
  ok(wr.status === 403, '令牌改文稿 → 403', String(wr.status))
  ok(readRow(D.id)?.title === before?.title, '查库确认令牌那次写入也没落库', JSON.stringify(String(readRow(D.id)?.title).slice(0, 30)))

  // 同一个令牌从白名单内的 IP 来：必须能用（不能把令牌也一起禁了）
  const sameTok = await ses(`${p}/docs/${D.id}`, { headers: IN(tk.token) }, admin)
  ok(sameTok.status === 200, '**同一把令牌从白名单内 IP 来照常可用**（拦的是 IP，不是令牌）', String(sameTok.status))

  await ses(`/api/tokens/${tk.id}`, { method: 'DELETE' }, admin)
}

/* ---------------------------------------------------------------- */
console.log('\n== 列库那条：不能整体 403，只能过滤 ==')
{
  /*
   * 整体 403 的问题是：一个人往往同时能访问好几个库，只要其中一个开了
   * 白名单，就把他对**没开白名单的那些库**的能力也一起收走了。
   * 所以这条路由的语义是「列出你能访问的」——过滤，而不是拒绝。
   */
  await setWL(FREE.id, false)
  const r = await ses('/api/v2/repos', { headers: OUT(admin) }, admin)
  ok(r.status === 200, '白名单外的 IP 列库 → 200（不是整体拒绝）', String(r.status))
  const ids = (r.json?.data || []).map((b) => b.id)
  ok(!ids.includes(WL.id), '**开了白名单、而本机 IP 不在里面的那个库不出现**', JSON.stringify(ids))
  ok(ids.includes(FREE.id), '没开白名单的库照常出现（不能顺手一起藏了）', JSON.stringify(ids))
  ok(!JSON.stringify(r.json).includes(WL.name), '连它的名字都没出现在响应里', String(r.json).slice(0, 90))
}

/**
 * 剥掉注释再扫源码。
 *
 * 这不是洁癖，是被破坏对照逼出来的：把 `requireIpAllowed(bookId, ctx)`
 * 注释成 `// requireIpAllowed(bookId, ctx)` 之后，源码断言**照样全绿** ——
 * 因为正则 `/requireIpAllowed\(/` 匹配到了注释里的那个名字。
 * 而真实情况是那行代码已经没了。
 *
 * 「源码里有 X」这种检查，**必须扫真实代码**。
 * 否则它守的是「有人曾经在这里写过 X 的字样」，不是「X 还在执行」。
 *
 * 只剥 `/* *\/` 块和行尾 `//`；字符串里的 `//`（`http://…`）前面是 `:` 不是空白，
 * 不会被误伤。
 */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .map((l) => l.replace(/(^|\s)\/\/.*$/, '$1'))
  .join('\n')

console.log('\n== 源码层面：每条 v2 路由都得自己判到 IP ==')
{
  /*
   * 第一版这里写的是「v2 路由共 8 条」—— **结果测出 9 条**，因为那是硬编码的
   * 数量，而项目里明明有别的匹配（注释里也出现了 `on('GET', '/api/v2/...`）。
   * 更要紧的是：**硬编码数量这件事本身就是错的检查**。
   * 以后有人加第 10 条 v2 路由，这一条照样绿 —— 而那条新路由可能压根没判 IP。
   *
   * 换成真正想问的那件事：**逐条路由看它的 handler 里有没有判 IP**。
   * 加了新路由而忘了判，这一条会红；数量变多变少都不影响。
   */
  const src = stripComments(readFileSync('server/index.ts', 'utf8'))
  const i = src.indexOf('function resolveBook')
  const seg = src.slice(i, src.indexOf('\n}\n', i))
  ok(/requireIpAllowed\(/.test(seg),
    'requireIpAllowed 在 resolveBook 里（6 条带 :book 的路由全经过它）—— 已剥注释，注释里写着不算数')

  const marks = [...src.matchAll(/\bon\('(?:GET|POST|PUT|DELETE|PATCH|HEAD)', '(\/api\/v2[^']*)'/g)]
  ok(marks.length > 0, `扫到 ${marks.length} 条 v2 路由`)

  const bare = []
  const skipped = []
  for (let k = 0; k < marks.length; k++) {
    const start = marks[k].index + marks[k][0].length
    const end = k + 1 < marks.length ? src.indexOf("on('", start) : src.length
    const handler = src.slice(start, end < 0 ? src.length : end)
    const path = marks[k][1]
    if (/resolveBook\(/.test(handler) || /ipAllowed\(/.test(handler)) continue
    /*
     * 只要求**涉及知识库数据**的路由判 IP。
     *
     * 现在扫出来 9 条，其中 `GET /api/v2/user` 不判 —— 而它是**该不判**的：
     * 它只返回调用者自己的 `{id, login, name, avatar}`，不碰任何知识库。
     * IP 白名单存在 `book_settings` 里、是**知识库级**的设置，
     * 这条路由压根没有 bookId，**没有可查的白名单**。
     * 要求它判，就等于要求造一个不存在的判据。
     *
     * 所以判据是「碰知识库就判」，不是「每条都判」——
     * 前者有理由，后者只会逼着人写一个查不到东西的 if。
     */
    if (path.includes(':book') || path === '/api/v2/repos') bare.push(path)
    else skipped.push(path)
  }
  ok(bare.length === 0,
    '每条**碰知识库**的 v2 路由都判到了 IP（要么走 resolveBook，要么自己判）',
    bare.length ? `没判的：${bare.join('、')}` : '')
  ok(skipped.every((p) => p === '/api/v2/user'),
    '不判的那条确实不碰知识库（只有 /api/v2/user 合理豁免）', `实际豁免：${skipped.join('、') || '无'}`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await cleanup()
process.exit(fail ? 1 : 0)
