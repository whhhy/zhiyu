/**
 * 个人访问令牌 + OpenAPI v2
 *
 * ============================================================
 * 为什么要有这一套
 * ------------------------------------------------------------
 * 自建知识库最常被问到的两件事：「CI 能不能自动发文档」
 * 和「别的系统能不能把文档读出去」。原先的答案都只能靠人操作网页，
 * 或者整包导出整个库 —— 那等于把全公司的文档一次性摊到对方手里。
 *
 * 这里补的是语雀企业版的「个人访问令牌」：一把可撤销、可过期、
 * 权限分 read / write 两档的令牌，配一套 `/api/v2` 接口。
 *
 * ============================================================
 * 这个套件真正在钉的东西
 * ------------------------------------------------------------
 * 令牌类功能最容易出的不是「功能没有」，而是**它悄悄越权**。
 * 所以这里大半断言是反向的：
 *
 *  ① **令牌不绕过权限矩阵。** scope 只说「这把令牌想干什么」，
 *     知识库权限才说「这个人能干什么」，两者是交集。
 *     只测前者的话，一把 reader 的 write 令牌就能改文档 —— 而权限矩阵
 *     是内网部署里唯一那层「A 部门看不到 B 部门」的东西。
 *
 *  ② **令牌不越出 /api/v2。** /api/sync/push 能按行推任意实体、
 *     /api/export 是整个工作台的数据包、/api/audit 是一份权限地图。
 *     令牌一旦能碰这三样，等于把这三样一起送出去。
 *
 *  ③ **令牌不能自我复制。** 否则一把泄露的令牌能无限发新令牌，
 *     撤销也就没意义了。
 *
 *  ④ **API 建的文档在网页端真的看得见、真的搜得到。**
 *     这条是被「走错写入路径」逼出来的：`search_index` 是
 *     `push()` 里刷的，直接 INSERT 一行的话，文档在网页端正常显示、
 *     搜不到、点开还是空白 —— 而所有接口都返回 200。
 *
 * ============================================================
 * 一处**没有**实测、只靠代码逻辑的地方（如实标注）
 * ------------------------------------------------------------
 * 「令牌过了 expiresAt 就失效」这条**本套件没有测**。
 * 有效期最短是 1 天，测它就得等一天。
 * 这里能测的只是参数：days=1 时 expiresAt 确实约等于 now+1 天、
 * days=99999 会被截到 365 天。真正的失效判定在 server/tokens.ts 的
 * verifyApiToken 里（`expiresAt < Date.now()` 直接 return null），
 * 但没有端到端证据 —— 所以不写成断言。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { freePort } from './scripts/free-port.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

/**
 * 自己的端口（见 test-migrate / test-audit 同样的说明）。
 * 用共享端口的话，`test:all` 里那个已经占着的服务会让本套件
 * 静默跑去打**共享的库**，而本套件有一半断言依赖「库是我自己的」。
 */
const PORT = process.env.APITOKEN_PORT || await freePort()
const DB = 'data/_apitoken-test.db'
const BASE = `http://localhost:${PORT}`

/** 与令牌无关的普通会话调用（管理令牌、造数据） */
async function ses(path, opts = {}, tok = '') {
  return call(path, opts, tok)
}
/** 带访问令牌调用 */
async function tok(path, opts = {}, token = '') {
  return call(path, opts, token)
}
async function call(path, opts = {}, token = '') {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(opts.headers || {}),
    },
  })
  return { status: r.status, json: await r.json().catch(() => ({})) }
}

/* ---------------- 先删旧库，再起服务 ---------------- */
for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 还被占着就算了 */ } }
}

const server = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB },
  stdio: ['ignore', 'pipe', 'pipe'],
})
server.stdout.on('data', () => {})
server.stderr.on('data', () => {})

const cleanup = () => {
  try { server.kill() } catch { /* 已退出 */ }
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (existsSync(f)) { try { rmSync(f) } catch { /* 删不掉就算了 */ } }
  }
}
process.on('exit', cleanup)

let up = false
for (let i = 0; i < 40; i++) {
  try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break } } catch { /* 还没起来 */ }
  await new Promise((r) => setTimeout(r, 500))
}
if (!up) { console.error('服务没能在 20 秒内起来'); cleanup(); process.exit(1) }

/* ---------------- 登录三个角色 ---------------- */
/** 登录。**必须显式给口令** —— 助手函数里写死管理员口令的话，
    新注册账号那几条会拿错口令去登，然后红成「他没权限」这种完全指错方向的样子 */
async function login(account, password) {
  const r = await ses('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ account, password: password ?? (process.env.YQ_ADMIN_PASSWORD || 'yuque@2026') }),
  })
  return r.json.token || ''
}
const ADMIN_PWD = process.env.YQ_ADMIN_PASSWORD || 'yuque@2026'
const admin = await login('admin', ADMIN_PWD)
ok(!!admin, '管理员登录成功')
const adminId = (await ses('/api/auth/me', {}, admin)).json.user?.id || ''

/** 种子里的普通成员：一个知识库都进不去的那种人 */
const members = (await ses('/api/entity/members', {}, admin)).json.rows || []
ok(members.length >= 3, `拿到成员名单（${members.length} 人）`)

/**
 * 顺带钉住一件事：成员名单**读得出来，但不能带出凭据**。
 *
 * 这两条是一起的。原来 members 的 bookOf 恒为 null 而没有 visible，
 * readEntity 的兜底规则（「推不出知识库归属就不放行」）把每一行都丢了，
 * `/api/entity/members` 对谁都是空 —— 而演示数据在每台机器的 localStorage 里，
 * 于是平时看不出来，直到有**注册进来的新同事**只存在于服务端，
 * 他在所有设备上都不存在（@提及、待办指派、协作者头像全读这份名单）。
 *
 * 修它的时候必须同时想清楚另一件事：可见性一放开，
 * `SELECT *` 就会把 passHash / passSalt 一起发出去。所以这两条要一起钉。
 */
{
  const raw = JSON.stringify(members)
  ok(!/passHash/.test(raw), '成员名单里**没有 passHash**')
  ok(!/passSalt/.test(raw), '成员名单里**没有 passSalt**')
  ok(members.every((m) => m.name && m.account), '每个成员都有 name 和 account')
}

const books = (await ses('/api/entity/books', {}, admin)).json.rows || []
const spaceRows = (await ses('/api/entity/spaces', {}, admin)).json.rows || []
ok(books.length >= 1 && spaceRows.length >= 1, '拿到知识库与空间')

const teamSpace = spaceRows.find((s) => s.kind === 'team') || spaceRows[0]

const B = books.find((b) => b.spaceId === teamSpace.id) || books[0]

/**
 * 造一个「确实什么权限都没有」的人。
 *
 * 试过从演示数据里挑一个 role=member 的人当样本，**挑不出来** ——
 * 种子给每个人的权限都给得挺全，所以「他应该 403」这条断言
 * 永远红，而红的方向会让人去怀疑代码（第一次就是这么栽的：
 * 拿 role=member 当「没权限」，结果他 200，代码没错、基准错了）。
 *
 * 改成自己注册一个账号：新账号只有自己的个人空间，
 * 对任何现有知识库都没有读权限 —— 这条不依赖演示数据的具体内容，
 * 演示数据怎么改都不会让这条断言失去意义。
 */
const probeAccount = 'apiprobe_' + Math.random().toString(36).slice(2, 8)
let plainToken = ''
let plainCaps = null
{
  const reg = await ses('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ account: probeAccount, password: 'probe@2026', name: '令牌探针' }),
  })
  ok(reg.status === 200, `注册一个新账号当「没权限」样本（${probeAccount}）`, `${reg.status} ${String(reg.json.error).slice(0, 60)}`)
  // 注册接口本身就返回一个会话令牌，直接用（少一次往返，也顺带验了它真的能登录）
  plainToken = reg.json.token || await login(probeAccount, 'probe@2026')
  ok(!!plainToken, '新账号能登录')
  plainCaps = (await ses(`/api/perms/book/${B.id}`, {}, plainToken)).json.caps
  ok(plainCaps?.read === false, '他对《' + B.name + '》确实没有读权限', JSON.stringify(plainCaps))
  ok(plainCaps?.edit === false && plainCaps?.export === false, '编辑、导出也都没有（权限是真的缺，不只是缺读）', JSON.stringify(plainCaps))
  const fresh = (await ses('/api/entity/members', {}, admin)).json.rows || []
  const m = fresh.find((x) => x.account === probeAccount)
  ok(!!m, '**新注册的人在成员名单里** —— 以前这一条是坏的：members 实体读出来恒为空', m ? m.name : '(不在)')
  ok(!/passHash|passSalt/.test(JSON.stringify(fresh)), '整个名单里都没有凭据列')
}

/** 建一把令牌，返回 { id, token } */
async function mkToken(t, name, scopes, days) {
  const r = await ses('/api/tokens', { method: 'POST', body: JSON.stringify({ name, scopes, days }) }, t)
  return r.json
}

console.log('\n== 令牌本身：明文只出现一次 ==')
const READ = await mkToken(admin, '只读探针', ['read'], 0)
ok(typeof READ.token === 'string' && READ.token.startsWith('yq_'), '创建后返回明文，且以 yq_ 开头', JSON.stringify(READ).slice(0, 120))
ok(READ.token && READ.token.length >= 30, '明文长度足够（随机源不是凑合的）', String(READ.token?.length))

/* ---------- write 蕴含 read ---------- */
/*
 * 界面上「读」「写」是两个**互相独立**的勾选框，而令牌列表写的是
 * `includes('write') ? '读 + 写' : '只读'`；`requireScope` 又是严格成员判断。
 * 所以「取消读、勾写」原本会建出一把显示「读 + 写」、实际上**什么都读不了**的令牌
 * （403：「这把令牌只有 write 权限，做不了 read」）。
 *
 * 这条组合以前**一次都没测过** —— 本文件里每把令牌都是 ['read','write'] 或 ['read']。
 * 修法在 `normalizeScopes`：write 蕴含 read，而 `parseScopes` 读库时也走它，
 * 所以**已经发出去的写令牌同样被补上**。
 */
{
  const W = await mkToken(admin, '只勾写的探针', ['write'], 0)
  ok(Array.isArray(W.scopes) && W.scopes.includes('read') && W.scopes.includes('write'),
    '只勾「写」也会带上「读」（界面上那一栏显示的就是「读 + 写」）', JSON.stringify(W.scopes))
  const canRead = await fetch(`${BASE}/api/v2/user`, { headers: { Authorization: `Bearer ${W.token}` } })
  ok(canRead.status === 200, `这把令牌读得动（HTTP ${canRead.status}）—— 修之前是 403`,
    canRead.status === 403 ? String((await canRead.json().catch(() => ({}))).error || '').slice(0, 90) : '')
}
{
  const list = (await ses('/api/tokens', {}, admin)).json.tokens || []
  const mine = list.find((t) => t.id === READ.id)
  ok(!!mine, '列表里能看到这把令牌')
  const raw = JSON.stringify(list)
  ok(!raw.includes(READ.token), '列表里**没有明文**')
  ok(!/hash/i.test(raw), '列表里连哈希都没有')
  ok(mine?.prefix === READ.token.slice(0, 12), '列表给的前缀 = 明文前 12 位', `${mine?.prefix} vs ${READ.token?.slice(0, 12)}`)
  ok(mine?.status === 'active', '状态是 active', String(mine?.status))
}

console.log('\n== 有效期参数（真的过期测不了，见文件头） ==')
{
  const d1 = await mkToken(admin, '一天有效', ['read'], 1)
  const gap = Number(d1.expiresAt) - Date.now()
  ok(gap > 86000000 && gap < 87000000, `days=1 的 expiresAt 约等于 now+1 天`, `${Math.round(gap / 1000)}s`)
  const dBig = await mkToken(admin, '超长有效期', ['read'], 99999)
  const gap2 = Number(dBig.expiresAt) - Date.now()
  ok(gap2 <= 366 * 86400000, 'days=99999 被截断到一年以内', `${Math.round(gap2 / 86400000)} 天`)
  const d0 = await mkToken(admin, '永不过期', ['read'], 0)
  ok(d0.expiresAt === null, 'days=0 = 永不过期（expiresAt 为空）', String(d0.expiresAt))
  // 顺带把这两把多余的撤销掉，别留垃圾
  await ses(`/api/tokens/${d1.id}`, { method: 'DELETE' }, admin)
  await ses(`/api/tokens/${dBig.id}`, { method: 'DELETE' }, admin)
  await ses(`/api/tokens/${d0.id}`, { method: 'DELETE' }, admin)
}

console.log('\n== scope：只有两档，都真的有用 ==')
{
  const r = await tok('/api/v2/user', {}, READ.token)
  ok(r.status === 200 && r.json.login === 'admin', 'read 令牌能读 /api/v2/user', `${r.status} ${JSON.stringify(r.json).slice(0, 80)}`)

  const wr = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs`, { method: 'POST', body: JSON.stringify({ title: '不该建成' }) }, READ.token)
  ok(wr.status === 403, 'read 令牌**不能**建文档', String(wr.status))
  ok(/read \/ write|权限/.test(String(wr.json.error || '')), '403 说清了是权限不够、且给了怎么办', String(wr.json.error).slice(0, 90))

  const noScope = await mkToken(admin, '不指定权限', undefined, 0)
  ok(JSON.stringify(noScope.scopes) === '["read"]', '不指定权限时退化成只读（而不是全开）', JSON.stringify(noScope.scopes))
  const junk = await mkToken(admin, '乱写的权限', ['read', 'delete-everything', 'admin'], 0)
  ok(JSON.stringify(junk.scopes) === '["read"]', '不认识的权限被丢掉，剩下的只有 read', JSON.stringify(junk.scopes))
  await ses(`/api/tokens/${noScope.id}`, { method: 'DELETE' }, admin)
  await ses(`/api/tokens/${junk.id}`, { method: 'DELETE' }, admin)
}

console.log('\n== 令牌不能越出 /api/v2 ==')
{
  const cases = [
    ['/api/bootstrap', '整包数据'],
    ['/api/export', '整个工作台的数据包'],
    ['/api/audit', '权限地图'],
  ]
  for (const [p, what] of cases) {
    const r = await tok(p, {}, READ.token)
    ok(r.status === 401, `令牌读不到 ${p}（${what}）`, String(r.status))
  }
  const push = await tok('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: {} }) }, READ.token)
  ok(push.status === 401, '令牌推不了 /api/sync/push（那是浏览器的同步协议）', String(push.status))

  // 会话该能碰，证明上面几条不是「所有东西都 401」
  const sesPush = await ses('/api/entity/books', {}, admin)
  ok(sesPush.status === 200, '会话令牌仍然能读 /api/entity/books（对照：上面不是普遍 401）', String(sesPush.status))
}

console.log('\n== 令牌不能自我复制 ==')
{
  /*
   * 这里量到的是 **401 而不是 403**，而且这是对的：令牌打 /api/tokens
   * 先撞上 dispatcher 里那道「令牌只能走 /api/v2」，压根进不到 handler。
   *
   * 那 handler 里还有一道显式的 403 —— 它防的不是现在，
   * 是「以后有人在 /api/v2 下面加一个令牌管理接口」：
   * 那种路由能通过作用域那一刀，只有 handler 里那道还拦着。
   * 两道都不是摆设，但也只有一道是**现在**测得到的，所以这里就写 401。
   */
  const r = await tok('/api/tokens', {}, READ.token)
  ok(r.status === 401, '令牌列令牌被拒（401：作用域那一刀）', `${r.status} ${String(r.json.error).slice(0, 70)}`)
  ok(/\/api\/v2/.test(String(r.json.error || '')), '错误信息说清了令牌该去哪儿用', String(r.json.error))
  const c = await tok('/api/tokens', { method: 'POST', body: JSON.stringify({ name: '自我繁殖' }) }, READ.token)
  ok(c.status === 401, '令牌建令牌被拒（否则泄露的令牌能无限复制）', String(c.status))
  const del = await tok(`/api/tokens/${READ.id}`, { method: 'DELETE' }, READ.token)
  ok(del.status === 401, '令牌撤令牌被拒（不能撤掉别人的痕迹）', String(del.status))
  const stillMine = (await ses('/api/tokens', {}, admin)).json.tokens.find((t) => t.id === READ.id)
  ok(!!stillMine, '那把令牌还在（没被自己撤掉）')
}

console.log('\n== 撤销：立刻失效 ==')
{
  const t = await mkToken(admin, '待撤销', ['read'], 0)
  ok((await tok('/api/v2/user', {}, t.token)).status === 200, '撤销前能用')
  const d = await ses(`/api/tokens/${t.id}`, { method: 'DELETE' }, admin)
  ok(d.status === 200, '撤销成功', String(d.status))
  ok((await tok('/api/v2/user', {}, t.token)).status === 401, '撤销后立刻 401')
  const again = await ses(`/api/tokens/${t.id}`, { method: 'DELETE' }, admin)
  ok(again.status === 404, '重复撤销是 404（而不是假成功）', String(again.status))
  const list = (await ses('/api/tokens', {}, admin)).json.tokens || []
  ok(list.find((x) => x.id === t.id)?.status === 'revoked', '列表里状态变成 revoked', String(list.find((x) => x.id === t.id)?.status))
}

console.log('\n== 只能撤销自己的令牌 ==')
{
  const mineT = await mkToken(admin, '管理员的令牌', ['read'], 0)
  // 借一把别人的令牌来撤管理员的
  const thief = await mkToken(plainToken, '成员自己的令牌', ['read'], 0)
  const r = await tok(`/api/tokens/${mineT.id}`, { method: 'DELETE' }, thief.token)
  ok(r.status === 401 || r.status === 403 || r.status === 404, '令牌在 /api/v2 之外被挡住（先被作用域那一刀拦下）', String(r.status))
  // 真正验「撤不掉别人的」要用会话：普通成员登录后撤管理员的令牌
  const r2 = await ses(`/api/tokens/${mineT.id}`, { method: 'DELETE' }, plainToken)
  ok(r2.status === 404, '普通成员撤别人的令牌 → 404（不区分「不存在/不是你的/已撤销」）', `${r2.status} ${String(r2.json.error).slice(0, 60)}`)
  ok(!/不是你的/.test(String(r2.json.error || '')), '错误信息没有泄漏「这把存在但不属于你」', String(r2.json.error))
  ok((await tok('/api/v2/user', {}, mineT.token)).status === 200, '管理员的令牌没被撤掉（撤失败≠撤成功）')
  await ses(`/api/tokens/${mineT.id}`, { method: 'DELETE' }, admin)
  await ses(`/api/tokens/${thief.id}`, { method: 'DELETE' }, plainToken)
}

console.log('\n== 令牌不绕过权限矩阵（最要紧的一条） ==')
{
  const PW = await mkToken(admin, '管理员写令牌', ['read', 'write'], 0)
  const PM = await mkToken(plainToken, '成员写令牌', ['read', 'write'], 0)

  const own = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}`, {}, PW.token)
  ok(own.status === 200, '管理员令牌读自己的库', String(own.status))

  const denied = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}`, {}, PM.token)
  ok(denied.status === 403, '成员令牌读没权限的库 → 403（scope 是 write 也一样）', `${denied.status} ${String(denied.json.error).slice(0, 50)}`)

  const denyList = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs`, {}, PM.token)
  ok(denyList.status === 403, '成员令牌列那个库的文档 → 403', String(denyList.status))

  const repos = await tok('/api/v2/repos', {}, PM.token)
  ok(repos.status === 200, '成员令牌能列库（接口本身通）', String(repos.status))
  ok(!(repos.json.data || []).some((x) => x.id === B.id), '但那个库**不在**他拿到的列表里 —— 过滤发生在服务端')

  const ghost = await tok(`/api/v2/repos/${teamSpace.id}/bk_不存在`, {}, PW.token)
  ok(ghost.status === 404, '库不存在 → 404（不是 403，避免泄漏存在性）', String(ghost.status))

  /**
   * 「曾经是成员」这条要留给下一节单独验（移出空间之后）——
   * 这里只留「非成员读不到」这一半，凑在一起测会分不清
   * 到底是哪种身份在起作用。
   */

  await ses(`/api/tokens/${PW.id}`, { method: 'DELETE' }, admin)
  await ses(`/api/tokens/${PM.id}`, { method: 'DELETE' }, plainToken)
}

console.log('\n== 被移出空间后，令牌立刻读不到（不需要撤销） ==')
{
  const m2 = members.find((x) => x.role === 'member' && x.account !== probeAccount)
  if (!m2) { console.log('  SKIP  种子成员不够，跳过'); }
  else {
    const t2 = await login(m2.account)
    const tk2 = await mkToken(t2, '移出前', ['read', 'write'], 0)
    // 找一个他**在**的空间
    const mySpaces = (await ses(`/api/spaces/${teamSpace.id}/members`, {}, admin)).json.members || []
    const isIn = mySpaces.some((x) => x.userId === m2.id)
    if (isIn) {
      const before = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}`, {}, tk2.token)
      ok(before.status === 200, '移出前：他的令牌读得到这个库', `${before.status} ${String(before.json.error || '').slice(0, 40)}`)
      await ses(`/api/spaces/${teamSpace.id}/members/${m2.id}`, { method: 'DELETE' }, admin)
      const after = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}`, {}, tk2.token)
      ok(after.status === 403, '移出后：**令牌没变**，但已经读不到了（权限矩阵仍然生效）', String(after.status))
      ok((await tok('/api/v2/user', {}, tk2.token)).status === 200, '而令牌本身仍是有效的（证明 403 来自权限而不是令牌失效）')
    } else {
      ok(true, `跳过实质断言：${m2.name} 本来就不在 ${teamSpace.name}`)
    }
  }
}

console.log('\n== 命名空间：空间 id，或者唯一空间名 ==')
{
  const byId = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/toc`, {}, READ.token)
  ok(byId.status === 200, '用空间 id 能取目录', String(byId.status))
  const byName = await tok(`/api/v2/repos/${encodeURIComponent(teamSpace.name)}/${B.id}/toc`, {}, READ.token)
  ok(byName.status === 200, '用空间名也能取目录', String(byName.status))
  ok(JSON.stringify(byName.json.data) === JSON.stringify(byId.json.data), '两种写法拿到的是同一棵树')

  // 同名空间 → 必须报错让人改用 id，不能静默挑一个
  const dupName = '同名探针空间' + Date.now().toString(36)
  await ses('/api/spaces', { method: 'POST', body: JSON.stringify({ name: dupName }) }, admin)
  await ses('/api/spaces', { method: 'POST', body: JSON.stringify({ name: dupName }) }, admin)
  const amb = await tok(`/api/v2/repos/${encodeURIComponent(dupName)}/${B.id}/toc`, {}, READ.token)
  ok(amb.status === 400, '两个同名空间 → 400 而不是随便挑一个', `${amb.status} ${String(amb.json.error).slice(0, 60)}`)
  ok(/空间 id/.test(String(amb.json.error || '')), '错误信息告诉调用方改用空间 id', String(amb.json.error))

  // 空间与知识库不匹配 → 404，不泄漏这个库在别的空间里
  const other = spaceRows.find((s) => s.id !== teamSpace.id)
  if (other) {
    const mismatch = await tok(`/api/v2/repos/${other.id}/${B.id}/toc`, {}, READ.token)
    ok(mismatch.status === 404, '空间对不上 → 404（不是 403：那等于承认库存在）', String(mismatch.status))
  }
}

console.log('\n== 目录树 ==')
{
  const toc = (await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/toc`, {}, READ.token)).json
  const flat = []
  const walk = (items, depth) => { for (const it of items) { flat.push({ ...it, depth }); walk(it.children || [], depth + 1) } }
  walk(toc.data || [], 0)
  ok(flat.length > 0, `目录树非空（${flat.length} 个节点）`)
  ok(flat.some((n) => (n.children || []).length > 0), '是**嵌套**结构（有节点带 children）')
  ok(flat.every((n) => typeof n.id === 'string' && typeof n.title === 'string'), '每个节点都有 id 和 title')
  ok(flat.every((n) => n.doc_id === null || typeof n.doc_id === 'string'), 'doc_id 要么是字符串要么是 null')
  const depths = new Set(flat.map((n) => n.depth))
  ok(depths.size >= 2 || flat.length <= 1, '存在多层级（种子数据本身就是有层级的）', [...depths].join(','))
}

console.log('\n== 文稿：读 ==')
{
  const docs = (await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs?limit=5`, {}, READ.token)).json
  ok(Array.isArray(docs.data) && docs.data.length > 0, `列表有数据（${docs.data?.length}）`)
  ok(typeof docs.total === 'number' && docs.total >= docs.data.length, `total 存在且不小于本页条数（${docs.total}）`)
  ok(docs.limit === 5 && docs.page === 1, '翻页参数回显了（脚本能确认自己拿到第几页）')
  ok(docs.data.every((d) => d.body === undefined), '列表里**没有**正文（省带宽，也避免一份接口两种语义）')

  const p1 = (await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs?limit=2&page=1`, {}, READ.token)).json
  const p2 = (await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs?limit=2&page=2`, {}, READ.token)).json
  const ids1 = new Set(p1.data.map((d) => d.id))
  ok(p2.data.length > 0 && p2.data.every((d) => !ids1.has(d.id)), '第 2 页和第 1 页没有重复条目', `${p1.data.map((d) => d.id)} / ${p2.data.map((d) => d.id)}`)

  const one = docs.data[0]
  const det = (await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs/${one.id}`, {}, READ.token)).json
  ok(det.id === one.id && det.title === one.title, '详情的 id/标题和列表一致')
  ok(det.format === 'markdown', '正文声明自己是 markdown（调用方不用猜格式）', String(det.format))
  ok(typeof det.body === 'string' && det.body.length > 0, `正文非空（${det.body?.length} 字符）`)

  // 拿 A 库的路径去读 B 库的文档 → 404
  const otherBook = books.find((b) => b.id !== B.id)
  if (otherBook) {
    const cross = await tok(`/api/v2/repos/${teamSpace.id}/${otherBook.id}/docs/${one.id}`, {}, READ.token)
    ok(cross.status === 404, '用别的库的路径读这篇 → 404（路径与归属不符）', `${cross.status} ${String(cross.json.error).slice(0, 40)}`)
  }
}

console.log('\n== 文稿：写 —— 关键在「网页端真看得见」 ==')
{
  const MD = [
    '# 发版流水线说明',
    '',
    '这段由访问令牌写入。',
    '',
    '| 环境 | 负责人 |',
    '| --- | --- |',
    '| 预发 | 张三 |',
    '',
    '- [ ] 还没做的事',
    '',
    '```bash',
    'npm run deploy',
    '```',
  ].join('\n')

  const created = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs`, {
    method: 'POST',
    body: JSON.stringify({ title: '令牌写入的文档 ' + Math.random().toString(36).slice(2, 7), body: MD }),
  }, await mkToken(admin, '写令牌', ['read', 'write'], 0).then((x) => x.token))
  ok(created.status === 200, '令牌能建文档', `${created.status} ${String(created.json.error).slice(0, 60)}`)
  const docId = created.json.id
  ok(!!docId && created.json.node_id, '返回了 id 和目录节点 id')

  /**
   * 下面这三条才是这个套件最该钉住的。
   * 少走 push() 直接 INSERT 的话，它们会**同时**红：
   * 变化日志没记（别的端拉不到）、检索索引没刷（搜不到）、
   * blocks 没生成（网页端一片空白）—— 而建文档的接口一路 200。
   */
  const boot = (await ses('/api/bootstrap?lite=0', {}, admin)).json
  const inBoot = (boot.data?.docs || []).some((d) => d.id === docId)
  ok(inBoot, '**网页端的数据里能查到这篇**（bootstrap 里有它）')

  const webView = (await ses(`/api/doc/${docId}`, {}, admin)).json
  const blocks = webView.doc?.blocks
  ok(Array.isArray(blocks), 'blocks 是**数组** —— 双重编码时它会是个字符串，而渲染那行直接炸', typeof blocks)
  /*
   * 下面这几条一律走 `types` 而不直接 blocks.some(...)。
   * 原因很实际：blocks 一旦不是数组，`blocks.some` 会抛
   * TypeError 把整个套件带崩 —— 于是**只错一个地方**时，
   * 后面几十条断言一条都没跑，汇总也出不来。
   * 崩掉只能证明「有问题」，报出具体哪几条不成立才能定位。
   */
  const types = Array.isArray(blocks) ? blocks.map((b) => b.type) : []
  const texts = Array.isArray(blocks) ? blocks.map((b) => String(b.text || '')) : []
  ok(types.length > 0, `blocks 非空（${types.length}）—— 正文渲染认 blocks，为空就是网页端一片空白`)
  ok(types.includes('h1'), 'Markdown 的标题变成了 h1 块', types.join(','))
  ok(types.includes('table'), '表格变成了 table 块', types.join(','))
  ok(types.includes('todo'), '待办变成了 todo 块', types.join(','))
  ok(types.includes('code') && texts.some((t) => t.includes('npm run deploy')), '代码块内容完整', types.join(','))

  const search = (await ses('/api/search?q=' + encodeURIComponent('发版流水线'), {}, admin)).json
  ok((search.results || []).some((r) => r.id === docId || r.title?.includes('发版流水线')),
    '**搜索能搜到它** —— 检索投影是 upsertRow 里刷的，绕开就搜不到',
    JSON.stringify((search.results || []).slice(0, 3)).slice(0, 160))

  const toc = (await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/toc`, {}, READ.token)).json
  ok((toc.data || []).some((n) => n.doc_id === docId), '它出现在目录树里')

  // 顺带确认「最后一句是真话」：撤销 write 令牌后它就读不到了
  const tokId = (await ses('/api/tokens', {}, admin)).json.tokens.find((t) => t.name === '写令牌')?.id
  ok(!!tokId, '找得到刚才那把写令牌')

  console.log('\n== 文稿：改 ==')
  const W = (await ses('/api/tokens', {}, admin)).json.tokens.find((t) => t.name === '写令牌')
  const wTok = (await mkToken(admin, '改用', ['read', 'write'], 0)).token
  const upd = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs/${docId}`, {
    method: 'PUT', body: JSON.stringify({ body: '## 改过的标题\n\n正文也换了。' }),
  }, wTok)
  ok(upd.status === 200, '能改正文', `${upd.status} ${String(upd.json.error).slice(0, 60)}`)

  const after = (await ses(`/api/doc/${docId}`, {}, admin)).json.doc
  // 同样先取类型列表再判断：blocks 不是数组时 .some 会抛，把后面全带崩
  const afterTypes = Array.isArray(after.blocks) ? after.blocks.map((b) => b.type) : []
  ok(afterTypes.includes('h2'), '**blocks 跟着重算了** —— 只改 body 的话网页端还是旧内容', `types=${afterTypes.join(',')}`)
  ok(!afterTypes.includes('table'), '旧内容的表格块没了（不是追加，是替换）', afterTypes.join(','))
  ok(after.title === created.json.title, '只传 body 时标题不变')
  ok(after.wordCount > 0, '字数重算了', String(after.wordCount))

  const renamed = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs/${docId}`, {
    method: 'PUT', body: JSON.stringify({ title: '改过名字的文档' }),
  }, wTok)
  ok(renamed.status === 200, '能改标题')
  const toc2 = (await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/toc`, {}, READ.token)).json
  const node = [...(toc2.data || [])].flatMap(function f(x) { return [x, ...(x.children || []).flatMap(f)] }).find((n) => n.doc_id === docId)
  ok(node?.title === '改过名字的文档', '目录里的标题也跟着改了（否则列表和正文对不上）', String(node?.title))

  console.log('\n== 改写接口不能顺手改别的 ==')
  const evil = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs/${docId}`, {
    method: 'PUT', body: JSON.stringify({ bookId: 'bk_别的库', trashed: 0, rev: 999, updatedBy: 'u_伪造' }),
  }, wTok)
  ok(evil.status === 200, '带越权字段的请求不会 500（多余字段被忽略）', `${evil.status} ${String(evil.json.error).slice(0, 60)}`)
  const still = (await ses(`/api/doc/${docId}`, {}, admin)).json.doc
  ok(String(still.bookId) === String(B.id), 'bookId 没被改走', String(still.bookId))

  console.log('\n== 文稿：删（进回收站，不是消失） ==')
  const del = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs/${docId}`, { method: 'DELETE' }, wTok)
  ok(del.status === 200 && del.json.trashed === true, '删除返回 trashed', `${del.status} ${JSON.stringify(del.json).slice(0, 80)}`)
  const gone = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs/${docId}`, {}, wTok)
  ok(gone.status === 410, '再读是 410（已在回收站），不是 404', String(gone.status))
  const trashList = (await ses('/api/entity/trash', {}, admin)).json.rows || []
  ok(trashList.some((t) => t.docId === docId), '它在回收站里 —— 所以能恢复')
  ok((await ses(`/api/doc/${docId}/restore`, { method: 'POST' }, admin)).status === 200, '能恢复回来')
  const back = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs/${docId}`, {}, wTok)
  ok(back.status === 200, '恢复后又能读了', String(back.status))

  console.log('\n== 参数校验 ==')
  const noTitle = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs`, { method: 'POST', body: JSON.stringify({ body: 'x' }) }, wTok)
  ok(noTitle.status === 400, '不传 title → 400', String(noTitle.status))

  /**
   * parent_id 必须用**另一个库里真实存在的节点**。
   * 原来这里写的是 'n_别的库的节点' —— 那个 id 压根不存在，
   * 于是命中的是「找不到这个节点」那条分支，跨库那一条**根本没测到**：
   * 把归属校验拆掉，套件照样全绿（破坏对照时才发现的）。
   *
   * 两件事必须分开测，因为它们防的是不同的坏事：
   *   · 节点不存在   → 调用方传错了 id
   *   · 节点在别的库 → 目录被挂到别的知识库下面去（更隐蔽：请求是 200）
   */
  const ghostParent = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs`, {
    method: 'POST', body: JSON.stringify({ title: '挂到不存在的节点', parent_id: 'n_压根不存在' }),
  }, wTok)
  ok(ghostParent.status === 400, 'parent_id 指向不存在的节点 → 400', String(ghostParent.status))

  const otherBook = books.find((b) => b.id !== B.id)
  if (otherBook) {
    const otherToc = (await tok(`/api/v2/repos/${otherBook.spaceId}/${otherBook.id}/toc`, {}, READ.token)).json
    const foreign = otherToc.data?.[0]
    ok(!!foreign, `在另一个库里找到一个真实节点做素材（${otherBook.name}）`)
    if (foreign) {
      const badParent = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs`, {
        method: 'POST', body: JSON.stringify({ title: '挂错地方', parent_id: foreign.id }),
      }, wTok)
      ok(badParent.status === 400, 'parent_id 指向**别的库的真实节点** → 400（否则目录被挂到别的库下面）',
        `${badParent.status} ${String(badParent.json.error).slice(0, 50)}`)
      // 关键对照：确认它**没有**被建出来（200 的话就是真挂过去了）
      ok(badParent.status !== 200, '请求没有成功（目录没有被真的挂过去）')
      const t2 = (await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/toc`, {}, READ.token)).json
      const allNodes = []
      const walk2 = (xs) => { for (const x of xs) { allNodes.push(x); walk2(x.children || []) } }
      walk2(t2.data || [])
      ok(!allNodes.some((n) => n.title === '挂错地方'), '那个库里确实没有多出这个节点')
    }
  }
  const goodParent = (await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/toc`, {}, READ.token)).json.data?.[0]
  if (goodParent) {
    const okParent = await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/docs`, {
      method: 'POST', body: JSON.stringify({ title: '挂对的', body: 'x', parent_id: goodParent.id }),
    }, wTok)
    ok(okParent.status === 200, 'parent_id 指向本库节点 → 200', String(okParent.status))
    const newToc = (await tok(`/api/v2/repos/${teamSpace.id}/${B.id}/toc`, {}, READ.token)).json
    const target = newToc.data.find((n) => n.id === goodParent.id)
    ok((target.children || []).some((c) => c.title === '挂对的'), '新文档真的挂在了那个节点下面')
  }

  await ses(`/api/tokens/${(await ses('/api/tokens', {}, admin)).json.tokens.find((t) => t.name === '改用').id}`, { method: 'DELETE' }, admin)
  if (tokId) await ses(`/api/tokens/${tokId}`, { method: 'DELETE' }, admin)
}

console.log('\n== 审计留痕 ==')
{
  const a = (await ses('/api/audit?limit=200', {}, admin)).json.items || []
  const c = a.filter((x) => x.action === 'token.create')
  const r = a.filter((x) => x.action === 'token.revoke')
  ok(c.length > 0, `创建令牌记了审计（${c.length} 条）`)
  ok(r.length > 0, `撤销令牌记了审计（${r.length} 条）`)
  const raw = JSON.stringify(a)
  ok(!/yq_[A-Za-z0-9_-]{10,}/.test(raw), '**审计里没有明文令牌**（否则审计日志成了新的泄漏面）')
  const one = c[0]   // 审计是按时间倒序的，最新的一条在 [0]
  ok(one?.detail?.scopes !== undefined, '审计记了权限（事后要能复查「当时给了什么权限」）', JSON.stringify(one?.detail))
  ok(one?.actorId === adminId, '审计记了是谁创建的', `${one?.actorId} vs ${adminId}`)
  ok(one?.actorName === 'admin' || !!one?.actorName, '审计记了创建人的名字（不然要另外查一次 users）', String(one?.actorName))
}

console.log('\n== 离职必须连带撤销令牌 ==')
{
  /*
   * 这条是令牌引入后**最容易漏**的一条，因为它的失败方式非常安静：
   * 办理离职清了会话、清了空间成员、收了知识库权限，界面上「离职处理完了」，
   * 而令牌不需要会话 —— 它拿着就能继续调 /api/v2 读文档。
   * 于是状态变成「人已经离职、网页进不去了，但 CI / 外部系统照常读得到」。
   */
  const acc = 'apioff_' + Math.random().toString(36).slice(2, 8)
  const reg = await ses('/api/auth/register', {
    method: 'POST', body: JSON.stringify({ account: acc, password: 'off@2026', name: '离职探针' }),
  })
  const offId = reg.json.user?.id || ''
  const t = await login(acc, 'off@2026')
  const tk3 = await mkToken(t, '离职前建的', ['read', 'write'], 0)
  ok(!!tk3.token, '给他建一把令牌')
  ok((await tok('/api/v2/user', {}, tk3.token)).status === 200, '离职前令牌可用')

  const off = await ses(`/api/users/${offId}/offboard`, { method: 'POST' }, admin)
  ok(off.status === 200, '办理离职', `${off.status} ${String(off.json.error).slice(0, 60)}`)
  ok(off.json.tokens >= 1, `离职连带撤了令牌（${off.json.tokens} 把）`, JSON.stringify(off.json).slice(0, 120))
  ok(off.json.sessions >= 1, '同时也清了会话', String(off.json.sessions))

  const after = await tok('/api/v2/user', {}, tk3.token)
  ok(after.status === 401, '离职后那把令牌立刻失效', `${after.status} ${String(after.json.error).slice(0, 40)}`)

  const auditRows = (await ses('/api/audit?action=user.offboard&limit=5', {}, admin)).json.items || []
  const rec = auditRows.find((r) => r.targetId === offId)
  ok(!!rec, '离职记了审计')
  ok(rec?.detail?.tokens >= 1, '审计里记了「撤了几把令牌」—— 不记的话事后查不到还剩几把', JSON.stringify(rec?.detail))
  ok(!/yq_/.test(JSON.stringify(auditRows)), '离职审计里也没有令牌明文')
}

console.log('\n== 这张表不进同步 ==')
{
  /**
   * 这是**静态**断言，而且是必须的。
   * 同步会把每一行推给所有登录设备；api_tokens 一旦成为实体，
   * 令牌哈希就会被整包发到每一台机器的 localStorage 上。
   */
  const ent = readFileSync('server/entities.ts', 'utf8')
  ok(!/name:\s*'apiTokens'/.test(ent), '实体清单里没有 apiTokens')
  ok(!/api_tokens/.test(ent), 'entities.ts 里根本没提过 api_tokens 这张表')
  const boot = (await ses('/api/bootstrap?lite=0', {}, admin)).json
  ok(!/yq_[A-Za-z0-9_-]{20,}/.test(JSON.stringify(boot)), 'bootstrap 的返回里搜不到任何令牌明文')
  const seedSrc = readFileSync('server/sync.ts', 'utf8')
  ok(!/api_tokens/.test(seedSrc), 'exportBundle/importBundle 的清单里也没有它')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
cleanup()
process.exit(fail ? 1 : 0)
