/**
 * 办完离职的管理员，重新登录回来还能不能当管理员 —— 原来能
 * ============================================================
 * `POST /api/users/:id/offboard` 原来只有四步：
 *   ① 清会话 ② 撤 API 令牌 ③ 移出所有空间 ④ 按每个库的开关收回 `book_members`
 *
 * **没有一步降 `role`，也没有一步停用账号。**
 * 而平台层的能力判据在 `denyReason` 里写的是：
 *   ```ts
 *   if (def.name === 'members') { if (user.role !== 'admin') return '只有管理员可以维护成员' }
 *   ```
 * —— **只看 role**，不看他还在不在任何空间、也不看有没有会话之外的身份。
 *
 * 实测（修之前，探针）：造一个 `role=admin` 的账号 → 办离职 → **重新登录** →
 *   · 读成员名册 → 200（7 个人）
 *   · 推 `members` 行 → **applied**，而且**真落库了**
 *   · 给别人办离职 → **200**
 *
 * 也就是说：**一个已经办完离职的人，还能管理平台。**
 * 对照着看更刺眼的是同一次探针里的另一条：
 *   改知识库成员**被拒**了（理由「需要该知识库的管理员权限」）
 * —— 同一个请求里，知识库级判据挡住了，**平台级判据没挡住**。
 *
 * ------------------------------------------------------------
 * 为什么降成 `member` 而不是删掉账号
 * ------------------------------------------------------------
 * 他的文档、评论、审计记录都以 `userId` 关联。删账号会留下一堆
 * 指向不存在用户的行 —— 和 7.8 那一节是同一类问题（孤儿数据）。
 *
 * **原 role 必须记进审计**：不记的话，离职之后就再也查不出
 * 「他当初是不是管理员」了，而那正是出事之后要问的第一个问题。
 *
 * ------------------------------------------------------------
 * 降权 ≠ 停用（这条要如实说清）
 * ------------------------------------------------------------
 * 降完之后他**仍然能重新登录**，只是不再是管理员、也不再是任何空间的成员。
 * 真正的「停用账号」需要 `users.disabled` 字段 + 登录时拒绝，
 * 那是**新功能**，不夹在这次修复里做。
 * 返回值里专门带 `accountDisabled: false` 就是为了让界面能照实说。
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const PORT = process.env.OFFADMIN_PORT || await freePort()
const DB = 'data/_offadmin-test.db'
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
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: 'oa@2026' },
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
const all = (sql, ...a) => { const d = new DatabaseSync(DB); d.exec('PRAGMA busy_timeout = 5000'); const r = d.prepare(sql).all(...a); d.close(); return r }
const push = async (tk, upsert) => { const r = await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert, remove: {} }) }, tk); return { status: r.status, applied: r.d?.applied, rejected: r.d?.rejected, error: r.d?.error } }
const login = (account, password) => call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account, password }) })

const SFX = Math.random().toString(36).slice(2, 7)
const owner = (await login('admin', 'oa@2026')).d?.token
const mkAccount = async (tag, role) => {
  const acct = tag + SFX
  const PWD = 'test1234'
  await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: PWD, name: tag }) })
  const tok = (await login(acct, PWD)).d?.token
  const id = (await ses('/api/v2/user', {}, tok)).d?.id
  if (role && role !== 'member') await ses(`/api/users/${id}/role`, { method: 'POST', body: JSON.stringify({ role }) }, owner)
  return { acct, PWD, tok, id, role: one('SELECT role FROM users WHERE id = ?', id)?.role }
}
const bk = (await ses('/api/entity/books', {}, owner)).d.rows[0]

/* ============ 前置：一个管理员 + 一个普通成员 ============ */
console.log('\n== 前置 ==')
const A = await mkAccount('offadm', 'admin')
const M = await mkAccount('offmem', null)
ok(A.role === 'admin', `离职者是平台管理员（库里 role=${A.role}）`)
ok(M.role === 'member', `另有一个普通成员（库里 role=${M.role}）`)
if (A.role !== 'admin') { console.log('\n前置不成立，退出。'); stop(); process.exit(1) }
ok((await ses('/api/entity/members', {}, A.tok)).status === 200, '离职前他能读成员名册（前置）')

/* ============ 办离职 ============ */
console.log('\n== 办离职 ==')
let offResult = {}
{
  const r = (await ses(`/api/users/${A.id}/offboard`, { method: 'POST' }, owner)).d
  offResult = r || {}
  ok(r?.ok === true, '办理成功', JSON.stringify(r).slice(0, 100))
  ok(Number(r?.sessions) >= 1, `清了 ${r?.sessions} 个会话`)
  ok(!one('SELECT 1 AS x FROM sessions WHERE userId = ?', A.id), '库里的会话真的没了')
}

/* ============ 降权 ============ */
console.log('\n== ★ 降权（原来没有这一步）==')
{
  ok(one('SELECT role FROM users WHERE id = ?', A.id)?.role === 'member',
    'role 从 admin 降成了 member', `实际 ${one('SELECT role FROM users WHERE id = ?', A.id)?.role}`)
  ok(offResult.roleBefore === 'admin', '返回里带出了降权前的 role', String(offResult.roleBefore))
  ok(offResult.roleAfter === 'member', '返回里带出了降权后的 role')
  ok(offResult.accountDisabled === false, '**并明说账号没有被停用**（否则界面会以为「办完就登不上了」）')
  ok(!!one('SELECT 1 AS x FROM users WHERE id = ?', A.id), '账号行还在（没删 —— 删了会留下指向空用户的文档/评论/审计）')
}

/* ============ 审计必须记原 role ============ */
console.log('\n== 审计里必须能查出「他当初是不是管理员」==')
{
  const rows = all('SELECT * FROM audit_log WHERE targetId = ? ORDER BY rowid DESC LIMIT 3', A.id)
  const rec = rows.find((r) => String(r.action || '').includes('offboard'))
  ok(!!rec, '审计里有一条 offboard 记录', rows.map((r) => String(r.action)).join(','))
  if (rec) {
    const detail = (() => { try { return JSON.parse(String(rec.detail || '{}')) } catch { return {} } })()
    ok(detail.roleBefore === 'admin', '记录里带着 roleBefore=admin', JSON.stringify(detail).slice(0, 100))
  }
}

/* ============ 重新登录回来 ============ */
console.log('\n== ★ 他重新登录回来 ==')
let tok2 = ''
{
  const old = await ses('/api/v2/user', {}, A.tok)
  ok(old.status === 401, `原来那个会话失效了（HTTP ${old.status}）`)

  const r = await login(A.acct, A.PWD)
  tok2 = r.d?.token || ''
  ok(!!tok2, `重新登录成功（HTTP ${r.status}）—— 账号没被停用，这一点如实记着`)

  if (tok2) {
    const me2 = (await ses('/api/v2/user', {}, tok2)).d
    ok(me2?.id === A.id, '拿回的是同一个身份')

    // 关键三条：平台层能力必须不再有
    const p1 = await push(tok2, { members: [{ id: A.id, name: '他自己改的名字', account: A.acct, email: '', avatar: '', bio: '' }] })
    ok((p1.rejected?.length || 0) === 1, '**改 members 行被拒**（原来 applied 而且真落库）', JSON.stringify(p1?.applied || p1?.rejected))
    ok(one('SELECT name FROM users WHERE id = ?', A.id)?.name !== '他自己改的名字', '名字真没被改掉')

    const p2 = await push(tok2, { bookMembers: [{ userId: 'z' + SFX, bookId: bk.id, role: 'reader', perms: JSON.stringify({}), joinedAt: Date.now() }] })
    ok((p2.rejected?.length || 0) === 1, '改知识库成员仍被拒（这条靠的是 book 级判据，不靠 role）')

    const off2 = await ses(`/api/users/${M.id}/offboard`, { method: 'POST' }, tok2)
    ok(off2.status !== 200, '**不能给别人办离职**（原来 200）', String(off2.d?.error || '').slice(0, 60))
    ok(one('SELECT role FROM users WHERE id = ?', M.id)?.role === 'member', '而那个普通成员确实没被影响')

    // 空间与库
    const bks = (await ses('/api/entity/books', {}, tok2)).d?.rows || []
    ok(bks.length === 0, `看不到任何知识库（${bks.length} 个）`)
  }
}

/* ============ owner 仍然不能被办离职 ============ */
console.log('\n== 平台超级管理员不能被办离职 ==')
{
  // 找 owner 之外的那个 owner？库里只有一个（就是调用者自己），
  // 所以这条真正验的是「不能给自己办离职」—— 先试自己，再试造一个 owner。
  const self = await ses(`/api/users/${one('SELECT id FROM users WHERE role = ? LIMIT 1', 'owner').id}/offboard`, { method: 'POST' }, owner)
  ok(self.status === 400, `不能给自己办离职（HTTP ${self.status}）`, String(self.d?.error || '').slice(0, 50))

  // 造第二个 owner 试试 —— 结果发现**提权接口压根不允许 member → owner**
  //（这是对的：owner 是「库里的第一个人」或 SSO 首登，不能被授予）。
  // 所以「拒了对 owner 办离职」这条只能用「不能给自己办离职」来覆盖，
  // 下面把「提权被拒」这件事也钉住 —— 它是这条防线的前一道闸。
  const other = await mkAccount('offown', 'owner')
  ok(other.role === 'member', `提权接口拒绝了 member → owner（库里 role=${other.role}）—— owner 只能靠「第一个用户」或 SSO 首登产生`)
  ok(one('SELECT COUNT(*) AS n FROM users WHERE role = ?', 'owner')?.n === 1, '库里始终只有一个 owner')
}

/* ============ 普通成员办离职：不该有多余副作用 ============ */
console.log('\n== 普通成员办离职 ==')
{
  const before = one('SELECT role FROM users WHERE id = ?', M.id)?.role
  const r = (await ses(`/api/users/${M.id}/offboard`, { method: 'POST' }, owner)).d
  ok(r?.ok === true, '办理成功', JSON.stringify(r).slice(0, 80))
  ok(one('SELECT role FROM users WHERE id = ?', M.id)?.role === before, `role 保持 ${before}（降权是幂等的，不该把 member 降成别的东西）`)
  ok(r?.roleBefore === 'member', '返回里的 roleBefore 如实写 member')
}

/* ============ 源码层：别把降权那行删回去 ============ */
console.log('\n== 源码层 ==')
{
  const src = readFileSync('server/index.ts', 'utf8')

  /**
   * 取整个 offboard 处理函数的源码。
   *
   * ⚠️ 原来是 `/offboard[\s\S]{0,4000}?\n\}\)/` —— 一个**固定 4000 字符的窗口**。
   * 2026-10-12 它红了，而**代码没问题**：给 offboard 补了一段讲「缺行被读成关」
   * 的注释（约 2000 字）之后，函数体超过 4000 字符，
   * 从路由起点找不到 `\n})` → 引擎换到后面某个 `AUDIT.offboard` 起匹配，
   * 抓到 885 个字符、里面当然没有降权那行。
   *
   * 也就是说这条判据报的**位置和长度都不对**，红的原因与被测的东西无关。
   * 「窗口不够长」这种失败模式比断言写错更阴：它只在注释变长时才发作，
   * 而那正是注释在讲清一件事的时候。
   *
   * 现在按**花括号配平**从 `on('POST', '/api/users/:id/offboard',` 之后
   * 一路配到闭合为止，与注释长度无关。
   */
  const handlerSource = (fileSrc, needle) => {
    const at = fileSrc.indexOf(needle)
    if (at < 0) return ''
    let depth = 0
    let started = false
    for (let i = at + needle.length; i < fileSrc.length; i++) {
      const ch = fileSrc[i]
      if (ch === '{') { depth++; started = true }
      else if (ch === '}') {
        depth--
        if (started && depth === 0) return fileSrc.slice(at, i + 1)
      }
    }
    return ''
  }
  const seg = handlerSource(src, "on('POST', '/api/users/:id/offboard'")
  ok(seg.length > 0, '找到 offboard 路由的函数体')

  // ⚠️ 这里必须验「窗口**装得下**」—— 否则上面那个坑会以另一种形式复发：
  //   片段太短时下面几条会因为扫不到而**假绿**。
  ok(seg.length > 1000 && /return\s*\{/.test(seg),
    `取到的函数体是完整的（${seg.length} 字符，含 return）`, `长度 ${seg.length}`)

  // 注意扫的是**剥掉注释**的代码：这段函数上方那段长注释里
  // 写着「原来没有一步降 role」，扫全文会先命中注释里的字样。
  const code = seg.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')
  ok(/UPDATE users SET role = \?/.test(code), 'offboard 里有降权这一步（剥掉注释后扫的）')
  ok(/roleBefore/.test(code), '原 role 进了审计 detail')
  ok(!/DELETE FROM users/.test(code), '**没有删账号行**（否则文档/评论/审计会指向空用户）')
  ok(/accountDisabled: false/.test(code), '返回值明说账号没被停用')

  /**
   * 破坏对照：把降权那行拿掉，这条判据必须变红。
   * —— 上一版**没有**这个对照，所以「窗口缩水」这件事才只能靠人发现。
   */
  const crippled = seg.replace(/UPDATE users SET role = \?[^)]*\)\.run\([^)]*\)/, '')
  ok(crippled !== seg && !/UPDATE users SET role = \?/.test(
      crippled.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n')),
    '破坏对照：删掉降权那行之后，上面那条判据会红')
}

await cleanup()
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
