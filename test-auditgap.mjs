/**
 * 两条「定义了却没人调用」的审计动作
 * ============================================================
 * `server/audit.ts` 的 `AUDIT` 常量里一直有两条：
 *
 *   · `trashPurge`      = 'doc.purge'            中文名「彻底删除」
 *   · `settingsChange`  = 'book.settings.change' 中文名「修改知识库设置」
 *
 * **但全项目没有任何地方 `logAudit` 它们。** 常量和中文名都写了，
 * 就是没人记 —— 这是最难看的一种漏：代码看起来「支持」，
 * 实际那条记录永远不会出现。
 *
 * ------------------------------------------------------------
 * ① 永久删除不记审计
 * ------------------------------------------------------------
 * `POST /api/doc/:id/purge` 的注释自己写着「**彻底删除：真正不可逆**」，
 * 而同为不可逆的「清空回收站」记了 `trashPurgeAll`、附件删除记了
 * `attachmentDelete`。所以在这之前的行为是：
 *
 *     批量清空有迹可查，逐篇永久删除**查无此人**
 *
 * 而永久删除恰恰是出事之后第一句要问「谁在什么时候删了哪一篇」的那种。
 *
 * ------------------------------------------------------------
 * ② 安全设置不记审计（这一条更严重）
 * ------------------------------------------------------------
 * 设置中心是**客户端 store 直接改**的，经 `/api/sync/push` 落库，
 * 服务端**压根没有「改设置」这个路由** —— 所以不是「忘了调」，
 * 是**根本没有地方可以调**。
 *
 * 而 `book_settings` 里装的是：`ipWhitelist`（IP 白名单）、
 * `restrictExport`（禁止导出）、`publicAccess`（公开访问）、
 * `watermark`、`autoRevoke`。
 *
 * 也就是说：**谁关掉了 IP 白名单、谁关掉了「禁止导出」、
 * 谁打开了「公开访问」，审计里全都答不出来。**
 * 这几个开关正是 7.21 修的那个漏洞（`/api/v2` 绕过 IP 白名单）所依赖的防线 ——
 * 防线本身生效与否没人记，它被关掉也没人记。
 * ============================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.AUDITGAP_PORT || await freePort()
const DB = 'data/_auditgap-test.db'
const BASE = `http://localhost:${PORT}`
const PW = 'auditgap@2026'

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
  // **不传 YQ_DEMO**：要的就是种子库（见下面「取一个知识库」那段注释 ——
  // 关掉种子之后一本书都造不出来，绕了三次才认回来）
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: PW },
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

const json = async (p, opt = {}) => {
  const r = await fetch(BASE + p, opt)
  const t = await r.text()
  try { return { status: r.status, data: t ? JSON.parse(t) : null } } catch { return { status: r.status, data: null } }
}
const ses = (p, o = {}, tk) => json(p, { ...o, headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) } })

const admin = (await json('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: PW }) })).data.token
ok(!!admin, '管理员登录成功（待会儿读审计用他）')

/**
 * 这个库用 `YQ_DEMO=0` 起，**没有种子数据** ——
 * 所以第一版直接取 `books.rows[0]` 拿到的是 undefined，脚本当场崩了。
 * 改成自己建空间 + 知识库。
 *
 * 为什么这里值得用 YQ_DEMO=0：种子库里那些演示数据会**顺手把断言喂饱**。
 * 自己建的就只有自己造的那几条，「以前是 0 条」这种断言语义才干净。
 */
/**
 * 取一个知识库 —— 用**种子库**里已有的，不自己造。
 *
 * ⚠️ 这一段我先后猜错了三次，都记下来，因为都不是「试一下就好」的小事：
 *
 * ① 以为 `YQ_DEMO=0` 之外还有种子 → 实际这个环境**一本书都没有**
 *    （`/api/entity/books` 是 0 行），于是 `books[0]` 是 undefined，
 *    后面 `B.spaceId` 把脚本打崩。
 * ② 改用「新建团队空间」`POST /api/spaces` → 它**只返回 `{space}`、
 *    不建知识库**，建完 books 仍是 0 行。
 * ③ 改用「注册」这条路 → 也不产出知识库（0 本）。
 *
 * 三次都是**没看就写**。而这个套件要验的是「审计有没有记」，
 * 跟「能不能造出数据」**完全无关** —— 绕这一大圈是自己给自己加的活。
 *
 * 所以最后老老实实用种子库（`YQ_DEMO` 不传），
 * 整套断言里没有任何一处依赖「我能造出多少数据」。
 */
const books = (await ses('/api/entity/books', {}, admin)).data.rows
ok(books.length >= 1, `用种子库里现成的知识库（${books.length} 本）`, JSON.stringify(books[0] || {}).slice(0, 90))
const B = books[0]
/** 操作一律用 admin：审计里要能对上「谁动的手」，而 admin 是这个库里确定存在的人 */
const who = admin
const docRow = (id) => {
  const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000')
  const r = d.prepare('SELECT id, title, trashed FROM docs WHERE id = ?').get(id)
  d.close()
  return r
}
const auditList = async (action) => {
  const r = await ses(`/api/audit?action=${encodeURIComponent(action)}&limit=20`, {}, admin)
  return r.data?.items || []
}

/* ---------------------------------------------------------------- */
console.log('\n== ① 永久删除：不可逆的操作以前查无此人 ==')
{
  // 先造一篇能删的：软删除 → 再永久删除
  /* ⚠️ body 的首个 H1 与 title **故意写成一样**。
   产品的不变量是「title = 第一个 H1 块的文字」（store 的 applyDerivedTitle，
   服务端建文档时也是同一套）。原来这里是 `title: '待永久删除的那篇'` + `body: '# 正文'` ——
   两者矛盾，于是 2026-10-06 修服务端那条路时把它顶红了。
   改夹具而不是改产品：一条自相矛盾的数据，标题该是哪个本来就说不清。 */
  const mk = await ses('/api/v2/repos/' + B.spaceId + '/' + B.id + '/docs', {
    method: 'POST', body: JSON.stringify({ title: '待永久删除的那篇', body: '# 待永久删除的那篇' }),
  }, who)
  const docId = mk.data?.id
  ok(!!docId, '造一篇文档用于测试', String(docId))
  const title = docId ? String(docRow(docId)?.title || '') : ''

  const del = await ses(`/api/doc/${docId}/purge`, { method: 'POST' }, who)
  ok(del.status === 200, '永久删除成功', `${del.status} ${String(del.data?.error || '').slice(0, 40)}`)
  ok(!docRow(docId), '库里真的没了（不可逆）')

  const items = await auditList('doc.purge')
  ok(items.length === 1, `**审计里记下了这一条**（以前是 0 条）`, `实际 ${items.length} 条`)
  const rec = items[0]
  ok(rec && rec.targetId === docId, '记的是被删的那一篇', rec && rec.targetId)
  ok(rec && rec.actorId === 'u_admin',
    '记的是操作人（admin）', rec && rec.actorId)
  ok(rec && /待永久删除的那篇/.test(String(rec.targetName || '')),
    '**标题也记下来了**（事后光有 id 还得翻备份才知道那是哪篇）', rec && String(rec.targetName))
  ok(rec && Number(rec.at) > 0, '有时间戳', rec && String(rec.at))
}

console.log('\n== ② 安全设置：以前压根没有地方可以记 ==')
{
  // 先把 IP 白名单打开，确认它真的生效了
  const on = await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { bookSettings: [{ bookId: B.id, ipWhitelist: 1, ipList: ['203.0.113.24'], restrictExport: 0, publicAccess: 0, watermark: 0, watermarkText: '', autoRevoke: 1, defaultWidth: 'standard', defaultVisibility: 'space' }] } }),
  }, who)
  ok(!(on.data?.rejected || []).length, 'IP 白名单打开了', JSON.stringify(on.data?.rejected || []).slice(0, 80))
  const changed = await auditList('book.settings.change')
  ok(changed.length >= 1, '**打开白名单这件事被记下来了**（以前是 0 条）', `实际 ${changed.length} 条`)

  const rec = changed.find((r) => r.targetId === B.id)
  ok(!!rec, '记的是那个知识库', rec && rec.targetId)
  ok(rec && !!String(rec.targetName || ''), '知识库名字也记了（光有 id 读不懂）', rec && String(rec.targetName))
  const ch = rec?.detail?.changes
  ok(ch && 'IP 白名单' in ch, '**detail 说清是哪个开关**', JSON.stringify(ch))
  ok(ch && String(ch['IP 白名单']?.to) === '开', '记的是「变成开」而不是「改过设置」', JSON.stringify(ch?.['IP 白名单']))

  // 关掉白名单 + 关掉禁止导出 —— 这两件正是出事之后要查的
  const before2 = (await auditList('book.settings.change')).length
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { bookSettings: [{ bookId: B.id, ipWhitelist: 0, ipList: [], restrictExport: 1, publicAccess: 0, watermark: 0, watermarkText: '', autoRevoke: 1, defaultWidth: 'standard', defaultVisibility: 'space' }] } }),
  }, who)
  const after2 = await auditList('book.settings.change')
  ok(after2.length > before2, '关掉白名单 + 打开禁止导出 → 又多了一条', `${before2} → ${after2.length}`)
  const rec2 = after2.find((r) => r.targetId === B.id)
  const ch2 = rec2?.detail?.changes
  ok(ch2 && String(ch2['IP 白名单']?.from) === '开' && String(ch2['IP 白名单']?.to) === '关',
    '**「从开变成关」被如实记下**（事后要问的正是这个）', JSON.stringify(ch2?.['IP 白名单']))
  ok(ch2 && String(ch2['禁止导出']?.to) === '开', '同一格里另一处变化也记了', JSON.stringify(ch2))
  ok(ch2 && JSON.stringify(ch2).indexOf('203.0.113.24') < 0,
    '**白名单地址本身不进审计**（只记「几个」，那是敏感信息）', JSON.stringify(ch2))
}

console.log('\n== 搜索屏蔽这两个开关以前不进审计（是我自己漏的）==')
{
  /*
   * 2026-10-05 我给知识库设置加审计时，`WATCHED` 只列了 6 项 ——
   * **漏了 `blockSearch` 和 `blockTerms`**。
   *
   * 而它们恰恰是**安全开关**：「谁在什么时候把搜索屏蔽关了」
   * 和「谁在什么时候把 IP 白名单关了」是同一类问题。
   * 漏掉的表现是：审计里查不到，而设置界面明明有那个开关
   * （`BookSettings.tsx` 里开关 + 词表 + 「词表为空等于没开」的提示都在）。
   *
   * 为什么漏：`book_settings` 的列清单在项目里有**五份独立维护**
   * （CREATE TABLE / seed 的 INSERT / `defaultBookSettings()` /
   *  `entities.ts` 的 writable / 这张 WATCHED），加的时候没数一遍。
   */
  const bb = books.find((b) => b.id === B.id) || B
  const before = (await auditList('book.settings.change')).length
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { bookSettings: [{ bookId: bb.id, blockSearch: 1, blockTerms: ['内部代号', '未公开项目'], restrictExport: 1, publicAccess: 0, watermark: 0, watermarkText: '', ipWhitelist: 0, ipList: [], autoRevoke: 1, defaultWidth: 'standard', defaultVisibility: 'space' }] } }),
  }, admin)
  const after = await auditList('book.settings.change')
  ok(after.length > before, '开启搜索屏蔽 → 记下来了（以前是 0 条）', `${before} → ${after.length}`)

  const rec = after.find((r) => r.targetId === bb.id && r.detail?.changes?.['搜索关键词屏蔽'])
  ok(!!rec, '**detail 里点名「搜索关键词屏蔽」**', JSON.stringify(rec?.detail?.changes))
  ok(rec && String(rec.detail.changes['搜索关键词屏蔽']?.to) === '开', '记的是「变成开」', JSON.stringify(rec?.detail?.changes?.['搜索关键词屏蔽']))
  ok(rec && !!rec.detail.changes['屏蔽词表'],
    '**词表变化也记了**（加了词但没开开关等于没开，两件事都要能查到）', JSON.stringify(rec?.detail?.changes?.['屏蔽词表']))
  ok(rec && /个/.test(String(rec.detail.changes['屏蔽词表']?.to)),
    '词表只记「几个」', JSON.stringify(rec?.detail?.changes?.['屏蔽词表']))
  ok(rec && !JSON.stringify(rec.detail.changes).includes('内部代号'),
    '**词表内容不进审计**（那是内容，不是元信息）', JSON.stringify(rec?.detail?.changes))

  // 反向：搜索屏蔽**确实是服务端在执行**，不是只有界面。
  // ⚠️ 这里第一次写成 `q.json` —— 而本文件的 `json()` 返回 `{status, d}`，
  //    于是 `q.json` 是 undefined，`.slice` 直接把脚本打崩。
  //    **又是「少取一层」**：这一轮它已经坑过我一次了（见本文件头部那段）。
  // 直接用 fetch 看原始 body —— 本文件的 json() 解析失败时会把 data 置 null，
  // 那样我看到的就只有「undefined」，等于**证据被我自己丢掉了**。
  const raw = await fetch(`${BASE}/api/search?q=` + encodeURIComponent('内部代号'), { headers: { Authorization: 'Bearer ' + admin } })
  const text = await raw.text()
  console.log(`       原始响应：status=${raw.status} content-type=${raw.headers.get('content-type')} body=${JSON.stringify(text.slice(0, 120))}`)
  let payload = null
  try { payload = JSON.parse(text) } catch { payload = null }
  ok(payload != null && payload != undefined,
    '（对照）搜索接口返回了可解析的 JSON（说明屏蔽在服务端判，界面只是配置入口）',
    `status=${raw.status} body=${JSON.stringify(text.slice(0, 60))}`)
  // 响应形状是 `{ results: [...] }`（server/index.ts:332）。前两版都猜错了形状，
  // 于是断言「没验到东西」却**长得像验过了** —— 比红更糟。
  ok(Array.isArray(payload?.results), '响应是 `{ results: [...] }`', JSON.stringify(payload))
  ok(payload?.results?.length === 0,
    '**带着被屏蔽的词搜 → 零结果**（服务端真的拦住了，不是只存不执行）',
    `${payload?.results?.length} 条`)
}

console.log('\n== 没有变化的推入不该刷屏 ==')
{
  /*
   * 设置中心每次打开都会把**所有开关原样推一遍**。
   * 不比差异的话，审计里会多出「改了 7 个 → 0 变化」这种记录，
   * 真正要查的那一条正好淹在里面。
   */
  const before = (await auditList('book.settings.change')).length
  for (let i = 0; i < 3; i++) {
    await ses('/api/sync/push', {
      method: 'POST',
      body: JSON.stringify({ upsert: { bookSettings: [{ bookId: B.id, ipWhitelist: 0, ipList: [], restrictExport: 1, publicAccess: 0, watermark: 0, watermarkText: '', autoRevoke: 1, defaultWidth: 'standard', defaultVisibility: 'space' }] } }),
    }, who)
  }
  const after = (await auditList('book.settings.change')).length
  ok(after === before, `**原样推 3 次，日志一条不多**（${before} → ${after}）`, `多了 ${after - before} 条`)
}

console.log('\n== ③ 知识库成员增删：也定义了、也从来没记过 ==')
{
  /*
   * 这是我做完①②之后**顺手做的一次全量核对**发现的第三处：
   * 拿一个探针把 `AUDIT` 里 16 个动作逐个查「有没有人真的 logAudit」，
   * 结果是 `book.member.add` / `book.member.remove` 各 0 处。
   *
   * 形态和②一模一样：**定义了、中文名也写了、就是没人调**。
   * 而它比②更该记 —— 权限授予是审计最核心的用途
   * （`test-audit` 里「权限授予要留痕」那一节验的就是空间成员那条）。
   *
   * 同样是「同一个界面上，一半记一半不记」：
   *   · 空间成员 → `POST /api/spaces/:id/members`（专用路由，记了）
   *   · 知识库成员 → `/api/sync/push`（没有专用路由）
   */
  const books = (await ses('/api/entity/books', {}, admin)).data.rows
  const BB = books.find((b) => b.id === B.id) || B
  const members = (await ses('/api/entity/members', {}, admin)).data.rows || []
  const someone = members.find((m) => m.id && m.id !== 'u_admin')
  ok(!!someone, '找一个不是 admin 的账号来试', JSON.stringify(members.slice(0, 2)).slice(0, 80))

  const beforeAdd = (await auditList('book.member.add')).length
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { bookMembers: [{ bookId: BB.id, userId: someone.id, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: true, share: true }, joinedAt: Date.now() }] } }),
  }, admin)
  const afterAdd = await auditList('book.member.add')
  ok(afterAdd.length > beforeAdd, '**把一个人加进知识库 → 记下来了**（以前是 0 条）', `${beforeAdd} → ${afterAdd.length}`)
  const ar = afterAdd.find((r) => r.targetId === BB.id)
  ok(!!ar, '记的是那个知识库', ar && ar.targetId)
  ok(ar && /编辑|editor/.test(String(ar.detail?.role || '')), '**记了他是什么角色**', ar && String(ar.detail?.role))
  ok(ar && String(ar.detail?.userId) === String(someone.id), '记的是被加进来的那个人（不是操作人）', ar && String(ar.detail?.userId))

  // 改权限 —— 要逐项记，不能只写「perms 变了」
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ upsert: { bookMembers: [{ bookId: BB.id, userId: someone.id, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: false, share: false }, joinedAt: Date.now() }] } }),
  }, admin)
  const permsRec = (await auditList('book.member.add')).find((r) => r.targetId === BB.id && r.detail?.permsChanged)
  ok(!!permsRec, '**改权限也记**（把导出权收掉这种不能没痕迹）', '')
  /*
   * 第一版这里写的是 `/导出/` —— 红了，而**红的是我的断言**：
   * `permsChanged` 的形状是 `{ "导出": "开 → 关" }`，
   * 用 `/导出/` 本该匹配上… 实际没匹配，是因为那次取到的
   * 是**上一条**记录（`find` 只按 `permsChanged` 有没有值来找，
   * 而「加进来」那条 permsChanged 是 `{}`，空对象在 JS 里是真值）。
   *
   * 所以改成**同时验键和值**，别只靠一个正则：
   *   键要是「导出」，值要是「开 → 关」
   * 这样它验的是「逐项说清了是哪一项、变成了什么」，
   * 而不是「字符串里出现过某两个字」。
   */
  const pd = permsRec?.detail?.permsChanged || {}
  ok('导出' in pd, '**逐项点名「导出」**（不是笼统的 perms 变了）', JSON.stringify(pd))
  ok(String(pd['导出']).includes('开') && String(pd['导出']).includes('关'),
    '说清了是「开 → 关」这个方向', String(pd['导出']))
  // 顺带确认：没变的项不该出现（「分享」在这次推里确实也变了，所以看「阅读」）
  ok(!('阅读' in pd), '**没变的项不出现**（阅读权一直是开的，不该被记成变化）', JSON.stringify(pd))

  // 移出 —— 走 deleteRow（remove），压根不经过 upsertRow
  const beforeRm = (await auditList('book.member.remove')).length
  await ses('/api/sync/push', {
    method: 'POST',
    body: JSON.stringify({ remove: { bookMembers: [`${BB.id}::${someone.id}`] } }),
  }, admin)
  const afterRm = await auditList('book.member.remove')
  ok(afterRm.length > beforeRm, '**把一个人移出知识库 → 也记下来了**（remove 走 deleteRow，不经过 upsertRow）', `${beforeRm} → ${afterRm.length}`)
  const rr = afterRm.find((r) => r.targetId === BB.id)
  ok(rr && String(rr.detail?.userId) === String(someone.id), '记的是被移出的那个人', rr && String(rr.detail?.userId))
  ok(rr && !!rr.detail?.perms, '**顺带记下他当时有的权限**（事后要判断「他走之前能看多少」，那时原始数据已经没了）', rr && String(rr.detail?.perms).slice(0, 40))
}

console.log('\n== 兜底：AUDIT 里每个动作都得真有人记 ==')
{
  /*
   * ①②③ 都是「定义了就以为有人记」。
   * 与其一次次靠人记得去查，不如**把这条不变量写成断言**：
   * `AUDIT` 里新增一个动作却没人调 `logAudit`，这里就红。
   *
   * 这条检查的作用是**防止第四处**，而不是证明前三处。
   */
  const src = ['server/index.ts', 'server/sync.ts']
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
  const au = readFileSync('server/audit.ts', 'utf8')
  const defs = [...au.matchAll(/^\s{2}(\w+):\s*'([^']+)'/gm)].map((m) => ({ key: m[1], action: m[2] }))
  ok(defs.length >= 16, `AUDIT 里有 ${defs.length} 个动作`)

  /*
   * 兜底的关键在**怎么判断「有人记」**。
   *
   * 第一版只查「`AUDIT.xxx` 这个名字在源码里出现过没有」，
   * 第二版收紧成「有一行 `action: AUDIT.xxx`、且那行不是注释、也不带 `if (false`」。
   *
   * ⚠️ **但它还是抓不住形式对照**，这一点实测过：
   * 破坏对照写的是 `if (false && def.name === 'bookMembers' && sep >= 0) {`，
   * 而 `action: AUDIT.bookMemberRemove` 那一行**一个字都没改**，
   * 兜底照样全绿 —— 外层短路它看不见。
   *
   * 所以这条的**真实能力**是：
   *   ✅ 抓住「定义了动作、但整个项目里根本没有这个调用」
   *      （①②③ 那三处就是它抓出来的）
   *   ❌ 抓不住「调用还在、但被条件短路了」
   * 那种情况只有**运行时**断言抓得住 —— 也就是上面 ①②③ 那三节的端到端检查。
   * 这里只负责前一半，所以**不假装自己能管后一半**。
   *
   * 宁可漏报也不要假绿：漏报是「少一条检查」，假绿是「以为有保护」。
   */
  const callLines = src.split('\n')
  const reallyCalled = (key) => callLines.some((l) => {
    const t = l.trim()
    if (t.startsWith('//') || t.startsWith('*')) return false
    if (/if\s*\(\s*false/.test(t)) return false          // 同一行短路不算
    return new RegExp(`action:\\s*AUDIT\\.${key}\\b`).test(t)
  })
  const orphans = defs.filter((d) => !reallyCalled(d.key))
  ok(orphans.length === 0,
    '**每个 AUDIT 动作都有一处真调用**（抓「压根没写」；抓不到「被条件短路」——那是上面那几节的事）',
    orphans.length ? `没真记的：${orphans.map((d) => d.action).join('、')}` : '')

  // 反向：有人写了字面串而没用常量（拼错了会静默变成另一种记录）
  const literal = [...src.matchAll(/action:\s*'([a-z]+\.[a-z.\-]+)'/g)].map((m) => m[1])
  const known = new Set(defs.map((d) => d.action))
  const stray = [...new Set(literal.filter((a) => !known.has(a)))]
  ok(stray.length === 0, '没有绕开 AUDIT 常量直接写字面串（拼错了会静默变成另一种记录）', stray.join('、'))

  // 每个动作都要有中文名，界面上显示的就是它
  const noLabel = defs.filter((d) => !new RegExp(`\\[AUDIT\\.${d.key}\\]:`).test(au))
  ok(noLabel.length === 0, '每个动作都有中文名（审计页显示的是它，不是 action 标识）', noLabel.map((d) => d.action).join('、'))
}

console.log('\n== 源码层面：别把这两条删回去 ==')
{
  const idx = readFileSync('server/index.ts', 'utf8')
  const sy = readFileSync('server/sync.ts', 'utf8')
  const au = readFileSync('server/audit.ts', 'utf8')
  // 剥注释 —— 这套检查的价值全在**代码**里
  const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
  const ix = code(idx), syc = code(sy)

  const purgeSeg = ix.slice(ix.indexOf("/api/doc/:id/purge"), ix.indexOf("/api/doc/:id/purge") + 900)
  ok(/AUDIT\.trashPurge/.test(purgeSeg), '永久删除那一路调了 logAudit(AUDIT.trashPurge)')

  ok(/AUDIT\.settingsChange/.test(syc), '服务端在 upsertRow 里调了 AUDIT.settingsChange')
  ok(/def\.name === 'bookSettings'/.test(syc), '判断挂在 bookSettings 上')
  /*
   * 「比了差异才记」这段代码**离 `def.name === 'bookSettings'` 有一千多字符**
   * （中间是 WATCHED 表和循环），而我第一版的窗口只取 1400 ——
   * 结果这条断言红着，而我差点当成「实现没做」。
   *
   * 这段的窗口取法改过两次，两次都不是「数字拍错了」那么简单：
   *
   *   ① 第一版取固定 1400 字符 —— 而「比差异」的代码在 1400 之外，
   *      那条断言红着，我差点当成「实现没做」。
   *      → **别猜长度**。
   *   ② 第二版用 `indexOf("def.name === 'bookSettings'")` 当起点 ——
   *      而那个字符串在 **denyReason 里也有**（`'bookSettings' || … 'bookMembers'`），
   *      `indexOf` 命中的是前一处，切出来的窗口是 denyReason，那里面没有 before。
   *      → **锚点要挑只出现一次的那个**。
   *
   * 现在的锚点是 `logChange(...)`：记录就写在它后面，而 `logChange(def.name, …)`
   * 全文件只有这一处。右边界用**下一个顶格的 `if (def.name ===`**（换行锚定），
   * 不是字符数。
   */
  const lcAt = syc.indexOf("logChange(def.name, id, 'upsert'")
  const from = syc.indexOf("if (def.name === 'bookSettings'", lcAt)
  const to = syc.indexOf('\n  if (def.name ===', from + 10)
  ok(from > 0 && to > from, '找得到那段代码的边界', `${from} → ${to}`)
  const seg = from > 0 && to > from ? syc.slice(from, to) : ''
  ok(/before/.test(seg), '比了**旧值**（不读旧值就没法知道是不是「变了」）')
  ok(/String\(before \?\? ''\) === String\(after/.test(seg), '旧值和新值逐个开关比过')
  ok(/changes/.test(seg) && /Object\.keys\(changes\)\.length/.test(seg),
    '**只有真的有变化才记**（不刷屏的关键）')
  /*
   * ⚠️ 上面这条做第一次破坏对照时**没红**，而原因是我的对照不称职：
   * 我写的是 `if (false && Object.keys(changes).length)` ——
   * 那只掐掉了「记」，「差异照样被算出来」这件事还成立。
   *
   * 一条守 A 的断言，配一个只动 B 的对照，红的必然不是它。
   * 真正该验的对照是「**没有差异判断就记**」，
   * 而检查本身验的是「存在按差异决定要不要记的结构」，
   * 所以对照必须是「那个结构整个不在」。
   * 下面这条把「结构完整」钉得更死一点，免得下次又被形式对照糊弄过去。
   */
  ok(/if \(Object\.keys\(changes\)\.length\)\s*\{/.test(seg),
    '（对照说明）那条要用「整段删掉」来验，`if (false && …)` 不算：它只掐了「记」，没掐「算」')
  ok(/countIps|个/.test(seg), '白名单只记数量不记地址表')

  // AUDIT 常量里那两条不能被删（它们是「有中文名、有定义」的凭据）
  ok(/trashPurge:\s*'doc\.purge'/.test(au), "AUDIT 里 trashPurge 还在")
  ok(/settingsChange:\s*'book\.settings\.change'/.test(au), "AUDIT 里 settingsChange 还在")
  ok(/\[AUDIT\.trashPurge\]:/.test(au), '中文名也还在（界面上显示的是它）')
  ok(/\[AUDIT\.settingsChange\]:/.test(au), 'settingsChange 的中文名也还在')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
await cleanup()
process.exit(fail ? 1 : 0)
