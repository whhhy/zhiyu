/**
 * IP 白名单以前只在「打开单篇文档」那一个入口执行
 * ============================================================
 * 设置页写着「仅允许下列 IP 访问本知识库，其余请求将被拒绝」，
 * 而实测开着白名单、当前 IP 不在名单里时：
 *
 * | 入口 | 修之前 |
 * | --- | --- |
 * | `/api/entity/docs` 文稿列表 | **200 + 10 篇**（整库标题全列出来） |
 * | `/api/entity/books` 知识库列表 | **200 + 1 个** |
 * | `/api/search` 搜索 | **200 + 5 条（含正文片段）** |
 * | `/api/export` 整包导出 | **200（整个工作台导走）** |
 * | `/api/perms/book/:id` 能力面板 | **read/edit/create 全 true** |
 * | `/api/doc/:id` 单篇文档 | 403 ✅ 只有这一处是对的 |
 *
 * **除了打不开单篇，什么都拦不住** —— 而搜索和导出正是最省事的两条路：
 * 不必打开任何一篇，搜一下就拿走标题和片段，导一下就拿走整个工作台。
 *
 * `/api/export` 那处的原因特别隐蔽：
 *   ```ts
 *   requireIpAllowed(restricted[0] || null, ctx)   // restricted = 开了「禁止导出」的库
 *   ```
 * `restricted` 是**「开了禁止导出」的库**，所以只要没人开「禁止导出」（默认状态），
 * 它就是空数组 → 传 `null` → `requireIpAllowed` 第一行 `if (!bookId) return` 放行。
 * **IP 白名单要等「禁止导出」也被打开才生效** —— 而这两个开关没有任何依赖关系。
 *
 * ------------------------------------------------------------
 * 修完之后：列表安静、详情明确
 * ------------------------------------------------------------
 *   文稿/知识库列表 → 200 + 0 行（静默过滤）
 *   搜索            → 200 + 0 条
 *   能力面板        → 403（带 IP 与库名）
 *   单篇文档        → 403
 *   整包导出        → 403（带 IP 与库名）
 *   平台 owner      → 不受影响（否则连备份都做不了）
 *
 * **列表为什么是静默过滤而不是 403**：一次 bootstrap 要读二十几张表、跨多个知识库，
 * 用户可能对好几个库都有权限 —— 抛错就得回答「你被哪个库挡了」，
 * 而只挡了其中一个时整页报错并不比少几条更让人明白。
 * 真正「打开某篇」时是明确 403，会说清「当前 IP 不在白名单内」，
 * **用户点进去那一刻就知道原因了**。
 * 而能力面板改成 403 是因为它回答的是「你能做什么」，
 * 报一组全 false 会被界面读成「你没权限」，那不是这里发生的事。
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.IPWL_PORT || await freePort()
const DB = 'data/_ipwl-test.db'
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
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'ipw@2026' },
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
/*
 * ⚠️ 这里**必须把 o.headers 合并进去**，不能整个覆盖。
 * 本节要靠 `X-Forwarded-For` 伪造来源 IP，而原来写成
 * `headers: { 'Content-Type':…, ...(tk ? … : {}) }` 会把手写的头全丢掉 →
 * 伪造不生效 → 而**「伪造没生效」和「白名单挡住了」在输出里长得一模一样**
 * （都是「读到 0 篇」），很容易据此汇报「修好了」。`test-trustproxy` 那套
 * 已经踩过同一个坑，它开头专门写了这段提醒。
 */
const ses = (p, o = {}, tk) => call(p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.headers || {}), ...(tk ? { Authorization: 'Bearer ' + tk } : {}) } })
/** 以某个来源 IP 读文稿列表（默认模式服务端信 X-Forwarded-For） */
const readVia = (tk, xff) => ses('/api/entity/docs', { headers: { 'X-Forwarded-For': xff } }, tk)
const one = (sql, ...a) => { const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000'); const r = d.prepare(sql).get(...a); d.close(); return r }
/*
 * ⚠️ `close()` 必须在 finally：句柄泄漏会**自己把库锁住**，
 * 于是收摊删库永远失败，报出来是「临时库删不掉」——
 * 看着像服务端没退出，其实是自己没放手。
 */
const exec = (sql, ...a) => {
  const d = new DatabaseSync(DB)
  try { d.exec('PRAGMA busy_timeout = 5000'); return d.prepare(sql).run(...a) } finally { d.close() }
}
/** 绕过 sync 的写入侧校验，直接改库 —— 用来造「老数据」那种状态 */
const setRaw = (bookId, wl, list) => exec('UPDATE book_settings SET ipWhitelist = ?, ipList = ? WHERE bookId = ?', wl, list, bookId)
const push = async (tk, upsert) => { const r = await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert, remove: {} }) }, tk); return { status: r.status, applied: r.d?.applied, rejected: r.d?.rejected, error: r.d?.error } }

const SFX = Math.random().toString(36).slice(2, 7)
const admin = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'ipw@2026' }) })).d?.token
const mkUser = async (tag) => {
  const acct = tag + SFX
  await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234', name: tag }) })
  const tok = (await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234' }) })).d.token
  return { id: (await ses('/api/v2/user', {}, tok)).d.id, tok }
}
const A = await mkUser('ipa_')
const bk = (await ses('/api/entity/books', {}, admin)).d.rows[0]
const grant = await push(admin, { bookMembers: [{ userId: A.id, bookId: bk.id, role: 'editor', perms: JSON.stringify({}), joinedAt: Date.now() }] })

console.log('\n== 前置 ==')
ok(!!admin && !!A.id && !!bk, `身份与库：${A.id} / ${bk.name}`)
ok(!!one('SELECT 1 AS x FROM book_members WHERE bookId = ? AND userId = ?', bk.id, A.id),
  `他是《${bk.name}》的 editor（push ${grant.status}）—— 不成立就退出`, JSON.stringify(grant?.rejected))
if (!one('SELECT 1 AS x FROM book_members WHERE bookId = ? AND userId = ?', bk.id, A.id)) {
  console.log('\n前置不成立，不往下验。'); stop(); process.exit(fail ? 1 : 0)
}
const setWl = async (on, list) => {
  const p = await push(admin, { bookSettings: [{ bookId: bk.id, ipWhitelist: on, ipList: list }] })
  const row = one('SELECT ipWhitelist, ipList FROM book_settings WHERE bookId = ?', bk.id)
  return { p, row }
}

/* ============ 基准 ============ */
console.log('\n== 基准：白名单关着，一切正常 ==')
let docId = ''
{
  const d = await setWl(0, [])
  ok(Number(d.row?.ipWhitelist) === 0, `设置落库（ipWhitelist=${d.row?.ipWhitelist}）`)
  const docs = (await ses('/api/entity/docs', {}, A.tok)).d?.rows || []
  ok(docs.length > 0, `文稿列表：${docs.length} 篇`)
  ok((await ses('/api/entity/books', {}, A.tok)).d?.rows?.length > 0, '知识库列表有内容')
  const one1 = await ses(`/api/doc/${docs[0].id}`, {}, A.tok)
  ok(one1.status === 200, `单篇文档：HTTP ${one1.status}`)
  ok((await ses('/api/search?q=a', {}, A.tok)).status === 200, '搜索可用')
  ok((await ses('/api/export', {}, A.tok)).status === 200, '整包导出可用')
  const perms = (await ses(`/api/perms/book/${bk.id}`, {}, A.tok)).d
  ok(perms?.caps?.read === true, '能力面板说能读')
  docId = docs[0].id
}

/* ============ 白名单开、白名单里没有我 ============ */
console.log('\n== 白名单开着，当前 IP 不在里面 ==')
{
  const s = await setWl(1, ['203.0.113.7'])
  ok(Number(s.row?.ipWhitelist) === 1, `设置落库（ipList=${s.row?.ipList}，故意不含 127.0.0.1）`)

  const docs = await ses('/api/entity/docs', {}, A.tok)
  ok((docs.d?.rows?.length || 0) === 0, `文稿列表 0 行（以前是 ${docs.d?.rows?.length}）`,
    `修之前这里会把整库标题列出来`)

  const books = await ses('/api/entity/books', {}, A.tok)
  ok((books.d?.rows?.length || 0) === 0, '知识库列表 0 个')

  const one1 = await ses(`/api/doc/${docId}`, {}, A.tok)
  ok(one1.status === 403, `单篇文档 403（HTTP ${one1.status}）`)
  ok(String(one1.d?.error || '').includes('白名单'), '理由说清是白名单', one1.d?.error)

  const exp = await ses('/api/export', {}, A.tok)
  ok(exp.status === 403, `整包导出 403（HTTP ${exp.status}）—— 修之前是 200，整个工作台导得走`,
    String(exp.d?.error || '').slice(0, 90))
  ok(String(exp.d?.error || '').includes('白名单'), '导出的理由也说清是白名单')

  const srch = await ses('/api/search?q=a', {}, A.tok)
  ok((srch.d?.results?.length || 0) === 0, `搜索 0 条（修之前返回了 ${srch.d?.results?.length} 条含正文片段的命中）`)

  const perms = await ses(`/api/perms/book/${bk.id}`, {}, A.tok)
  ok(perms.status === 403, `能力面板 403（HTTP ${perms.status}）—— 修之前报 read/edit/create 全 true`,
    String(perms.d?.error || '').slice(0, 80))
}

/* ============ 平台 owner 同样受白名单约束 ============ */
console.log('\n== 平台 owner 同样受白名单约束（刻意的取舍）==')
{
  /*
   * ⚠️ 这里我一度写成「owner 不受影响」，还给它加了豁免 ——
   * 结果 `test-v2ip` 立刻 18 项全红：
   * `resolveBook(bookId, ctx, u)` 里的 `u` 是**令牌所属用户**，
   * 而访问令牌通常是平台 owner 发的 → 豁免触发 → **`/api/v2` 白名单整个失效**。
   *
   * 想清楚之后的结论是**不加豁免**，三条理由：
   *   ① **IP 白名单问的是「请求从哪来」，不是「谁在请求」** ——
   *      它是网络层；owner 豁免是权限层的东西，混在一起就等于
   *      「一把 owner 的令牌给整个网段开后门」。
   *   ② 7.21 修 `/api/v2` 时 `requireIpAllowed(bookId, ctx)` **本来就没传 user**，
   *      所以「owner 也会被挡」一直是既有行为，加豁免反而是偏离。
   *   ③ 管理员要进去，把自己的 IP 加进名单即可 ——
   *      那是一次明确的、有痕迹的操作，比「隐形豁免」好。
   *
   * （对比 `exportAllowed` 的 owner 豁免：那是**权限**判断，豁免是对的。）
   */
  /*
   * 注意断言的写法：这里**不能**说「owner 一篇都读不到」——
   * 演示库有 4 个库，只给 `bk` 这一个开了白名单，
   * owner 读到的那十几篇是**另外 3 个没开白名单的库**的。
   * 该断言的是「**白名单那个库**的文档一条都读不到」。
   * （第一版写成「读不到」就红了，红的是断言 —— 又一次「范围没摆准」。）
   */
  const docs = (await ses('/api/entity/docs', {}, admin)).d?.rows || []
  const mine = docs.filter((d) => d.bookId === bk.id)
  ok(mine.length === 0, `owner 在白名单外读不到这个库的文档（${mine.length} 篇）—— 没有隐形豁免`,
    `而其他 ${docs.length} 篇来自没开白名单的库，那是应该看得见的`)
  ok((await ses('/api/export', {}, admin)).status === 403, 'owner 的整包导出也 403')
  ok((await ses(`/api/perms/book/${bk.id}`, {}, admin)).status === 403, 'owner 的能力面板也 403')

  // 但把自己的 IP 加进名单之后他就回来了 —— 这才是该有的操作路径
  await setWl(1, ['203.0.113.7', '127.0.0.1', '::1', '::ffff:127.0.0.1'])
  const back = (await ses('/api/entity/docs', {}, admin)).d?.rows || []
  ok(back.filter((d) => d.bookId === bk.id).length > 0, '把自己 IP 加进名单后 owner 就读得到这个库了（不是无解，是有明确操作）')
}

/* ============ 白名单里加上我 ============ */
console.log('\n== 白名单里加上当前 IP，一切恢复 ==')
{
  // 127.0.0.1 是不是服务端看到的地址不确定，两种都放进去最稳
  await setWl(1, ['203.0.113.7', '127.0.0.1', '::1', '::ffff:127.0.0.1'])
  const docs = (await ses('/api/entity/docs', {}, A.tok)).d?.rows || []
  const back = docs.length > 0 || (await ses(`/api/doc/${docId}`, {}, A.tok)).status === 200
  ok(back, `恢复访问（列表 ${docs.length} 篇，单篇 HTTP ${(await ses(`/api/doc/${docId}`, {}, A.tok)).status}）`)
}

/* ============ 关掉白名单 ============ */
console.log('\n== 关掉白名单 ==')
{
  await setWl(0, [])
  const docs = (await ses('/api/entity/docs', {}, A.tok)).d?.rows || []
  ok(docs.length > 0, `又读得到 ${docs.length} 篇`)
  ok((await ses('/api/export', {}, A.tok)).status === 200, '导出恢复')
}

/* ============ 空名单：既推不进来，也不该放行 ============
 *
 * 改之前：推 `ipWhitelist:1, ipList:[]` → **applied**，
 * 而 `ipAllowed` 里是 `if (!list.length) return true` → **放行所有人**；
 * 同一屏的设置页却写着「白名单为空，开启后将没有人能访问」。
 * 管理员加 0 个 IP、打开开关、以为锁了门 —— 实际谁都能进。
 *
 * 现在这条组合在**写入边界**就被拒；万一库里已经有（直接改库 / 老数据），
 * `ipAllowed` 负责**关门**。两处互补，不是重复。
 */
console.log('\n== 空名单：推不进来，也不放行 ==')
{
  const p = await setWl(1, [])
  const rej = (p.p.rejected || []).filter((r) => r.entity === 'bookSettings')
  ok(rej.length === 1, `推「开着 + 空名单」被拒（${rej[0]?.reason?.slice(0, 40) || '没被拒'}）`,
    `applied=${(p.p.applied || []).length} rejected=${JSON.stringify(p.p.rejected)}`)
  ok(Number(p.row?.ipWhitelist) === 0, `那一行没被改成「开着」（ipWhitelist=${p.row?.ipWhitelist}）`)
  ok((await ses('/api/entity/docs', {}, A.tok)).d?.rows?.length > 0, '白名单没开成，读取照旧正常')

  // ⚠️ 必须连**字符串形式**一起堵：`JSON.stringify([])` 是 `'[]'`（长度 2），
  //   只看 `length` 会把它当成「非空」→ **放行一个空名单**。
  //   判据要是写成 `Array.isArray(v) ? ... : 有内容`，这里就会漏。
  const p2 = await setWl(1, JSON.stringify([]))
  const rej2 = (p2.p.rejected || []).filter((r) => r.entity === 'bookSettings')
  ok(rej2.length === 1, `字符串形式的空名单（双重编码那条路）同样被拒（${rej2[0]?.reason?.slice(0, 30) || '没被拒'}）`)
  ok(Number(p2.row?.ipWhitelist) === 0, `那一行仍然没被开（ipWhitelist=${p2.row?.ipWhitelist}）`)

  // 真到库里真存在这个状态时，服务端必须**关门**而不是开门
  setRaw(bk.id, 1, '[]')
  ok((await ses('/api/entity/docs', {}, A.tok)).d?.rows?.length === 0, '直接改库造成「开着+空名单」→ 谁都进不去')
  ok((await ses(`/api/doc/${docId}`, {}, A.tok)).status === 403, '单篇文档也 403')
  setRaw(bk.id, 0, '[]')
  ok((await ses('/api/entity/docs', {}, A.tok)).d?.rows?.length > 0, '恢复后读取正常')
}

/* ============ 双重编码的老数据行：不能被前缀绕过 ============
 *
 * `toRow` 对 json 列无条件 `JSON.stringify`，不判断传进来的
 * 是不是已经一段 JSON 文本 —— 于是 `ipList: JSON.stringify(list)`
 * （字符串）存进去就是**双重编码**的 `"[\"203.0.113.70\"]"`。
 *
 * 改之前 `JSON.parse` 一次解出来是个**字符串**，`list.includes(ip)`
 * 于是成了**子串匹配**：名单里只有 `203.0.113.70` 时，
 * **不在名单里的** `203.0.113.7` 也能读到全部正文（探针实测 10 篇）。
 * 默认 `YQ_TRUST_PROXY` 下 XFF 又信客户端，于是发 `X-Forwarded-For: 0`
 * （`"0"` 是那段文本的子串）就能白嫖 —— 整行白名单形同虚设。
 */
console.log('\n== 双重编码的老数据行：按数组成员判断，不按子串 ==')
{
  setRaw(bk.id, 1, JSON.stringify(JSON.stringify(['203.0.113.70'])))
  ok(String(one('SELECT ipList FROM book_settings WHERE bookId = ?', bk.id)?.ipList).includes('\\"'),
    `前置：这一行确实是双重编码的（ipList=${one('SELECT ipList FROM book_settings WHERE bookId = ?', bk.id)?.ipList}）`)
  ok((await readVia(A.tok, '203.0.113.70')).d?.rows?.length > 0, '名单里那个 IP 进得去')
  ok((await readVia(A.tok, '203.0.113.7')).d?.rows?.length === 0, '★ 前缀 IP 进不去（它根本不在名单里）',
    `修之前这里是 ${(await readVia(A.tok, '203.0.113.7')).d?.rows?.length} 篇`)
  ok((await readVia(A.tok, '0')).d?.rows?.length === 0, '★ X-Forwarded-For: 0 也进不去（修之前能白嫖整库）')
  ok((await ses(`/api/doc/${docId}`, { headers: { 'X-Forwarded-For': '203.0.113.7' } }, A.tok)).status === 403,
    '开单篇也是 403')
}

/* ============ 种子不许自带白名单地址 ============
 *
 * `defaultBookSettings()` 里 `ipList` 曾经是 `['203.0.113.24','203.0.113.55']`
 * （当示例写的），而 `seed.ts` 用这个默认值给**每个**知识库铺一行设置。
 * 后果是这个套件在跑的过程中撞见过：查「库里那行白名单」时读到了
 * `203.0.113.55` —— 一个谁也没加过、谁也不属于的地址。
 *
 * 真正伤的地方在界面上：名单天生非空 → 「名单为空才让开开关」那条永远触发不了
 * → 管理员新建一个库、顺手把开关一开，就把自己和所有人一起关在门外，
 * 而界面上看不出任何异样。已改成 `ipList: []`。
 *
 * 这里钉的是**结果**（种出来的库里没有白名单地址）而不是源码里的字面量，
 * 因为「怎么实现」会变，「种出来的东西对不对」不会。
 */
console.log('\n== 种子数据里没有谁也不属于的白名单地址 ==')
{
  const seeded = (await ses('/api/entity/books', {}, admin)).d?.rows || []
  const dirty = []
  for (const b of seeded) {
    const r = one('SELECT ipWhitelist, ipList FROM book_settings WHERE bookId = ?', b.id)
    let list = []
    try { const a = JSON.parse(String(r?.ipList ?? '[]')); list = Array.isArray(a) ? a : [] } catch { list = [] }
    if (Number(r?.ipWhitelist) === 1 || list.length) dirty.push(`${b.name}（开关=${r?.ipWhitelist} 名单=${r?.ipList}）`)
  }
  ok(!dirty.length, `${seeded.length} 个种子库都没有默认的白名单地址`, dirty.join('；'))
}

/* ============ 源码层：别把 ip 参数删回去 ============ */
console.log('\n== 源码层：这条防护容易被改回去，钉住 ==')
{
  const syncSrc = readFileSync('server/sync.ts', 'utf8')
  const idxSrc = readFileSync('server/index.ts', 'utf8')
  // ① readEntity 必须**必传** ip，这样新增调用点会编译报错而不是静默漏掉
  ok(/readEntity\(user: User, def: EntityDef, ip: string \| null\)/.test(syncSrc),
    'readEntity 的 ip 是必传参数（漏传会编译红）')
  ok(/readEntity\(user: User, def: EntityDef, ip: string \| null\)/.test(syncSrc), 'readEntityLite 同样必传')
  // ② 过滤必须在 readEntity 里
  ok(/ip !== null && !ipAllowed\(bookId, ip\)/.test(syncSrc), 'readEntity 里真的判了 ipAllowed')
  // ③ 搜索那条（实际写法是 `[...books].filter(...)`，第一版断言写成
  //    `bIds.filter(` 匹配不到 —— 断言自己写错，红的是断言不是代码）
  ok(/\[\.\.\.books\]\.filter\(\(b\) => ipAllowed\(b, ip\)\)/.test(syncSrc),
    '搜索在 SQL 之前剔掉白名单外的库')
  // ④ 导出那条 —— 要断言新写法在，且**代码**里没有旧写法。
  //    第一版直接扫全文，结果命中了记录这件事的**注释**（那行还留着，
  //    注释要留着说明改过什么）。改成扫掉注释行。
  const idxCode = idxSrc.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
  ok(!/requireIpAllowed\(restricted\[0\] \|\| null/.test(idxCode),
    '导出不再用「只有开了禁止导出才查 IP」那个写法')
  ok(/ipBlocked = readable\.filter\(\(bid\) => !ipAllowed\(bid, clientIp\(ctx\.req\)\)\)/.test(idxCode),
    '导出独立判 IP 白名单')
  // ⑤ 能力面板
  ok(/perms\/book\/:id[\s\S]{0,700}requireIpAllowed\(ctx\.params\.id, ctx\)/.test(idxCode),
    '能力面板也判 IP（否则界面显示「有编辑权」而点进去 403）')
  // ⑥ **不许加 owner 豁免** —— 加了会让令牌继承它，`/api/v2` 白名单整个失效
  //    （`resolveBook(bookId, ctx, u)` 里的 `u` 就是令牌所属用户）。
  //    这两条是那次 18 项红的纪念，见上面 owner 那节的说明。
  const permsSrc = readFileSync('server/perms.ts', 'utf8')
  const ipFn = /export function ipAllowed\([\s\S]{0,800}?\n\}/.exec(permsSrc)?.[0] || ''
  ok(ipFn.length > 0, '找到 ipAllowed 的函数体')
  ok(!/role === 'owner'/.test(ipFn), 'ipAllowed 里没有 owner 豁免（加了会让令牌继承它）')
  /*
   * 下面两条是**回归钉子**：上面那两节的行为断言已经证明它们该成立，
   * 这里再钉一层，是为了让「有人顺手把代码简化回去」时立刻红。
   *   · `if (!list.length) return true` —— 空名单放行所有人，
   *     而同一屏的设置页写着「没有人能访问」，文案与实现正好相反；
   *   · 不走 `normalizeIpList` —— 双重编码的老数据行会退化成子串匹配。
   */
  ok(!/if \(!list\.length\) return true/.test(ipFn), 'ipAllowed 里没有「空名单 = 放行所有人」那条（fail closed 才对）')
  ok(/normalizeIpList\(bs\.ipList\)/.test(ipFn), 'ipAllowed 走 normalizeIpList（双重编码行才能按数组成员判断）')
  ok(!/ipAllowed\([^)]*,\s*(u|user)\s*\)/.test(idxCode + syncSrc),
    '没有一处给 ipAllowed 传当前用户（那正是豁免的入口）')
  // ⑥ 路由层必须传真实 IP，不能传 null
  const nulls = (idxSrc.match(/readEntity\(u, def, null\)|searchAll\(u, q, limit, null\)|bootstrap\(u, lite, null\)/g) || []).length
  ok(nulls === 0, '面向用户的路由没有一处传 null（null 只留给服务端内部读取）', String(nulls))
}

await cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
