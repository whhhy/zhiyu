/**
 * `YQ_TRUST_PROXY`：关掉之后不再信 `X-Forwarded-For`
 * ============================================================
 * `clientIp()` 原来**无条件**取 `X-Forwarded-For` 的第一段，
 * 而那个头**是请求方自己写的**，服务端无从验证。
 *
 * 它一路喂给三处：
 *   · `ipAllowed()` —— 知识库的 **IP 白名单**（7.29 刚补齐全部 5 条路径）
 *   · 分享页水印上的「阅读人 IP」—— 水印的作用正是「追得到人」
 *   · `sessions.ip` —— **只写不读**，所以不构成实际漏洞，但记录会失真
 *
 * 实测（改之前，探针）：白名单开着、名单里是 `10.9.9.9`、服务真在 `127.0.0.1`
 *   · 真 IP 请求                   → 读到 **0 篇**（白名单生效）
 *   · `X-Forwarded-For: 10.9.9.9` → 读到 **10 篇**（**绕过**）
 *
 * ------------------------------------------------------------
 * 这个套件最要紧的一条是「**默认行为一个字都不变**」
 * ------------------------------------------------------------
 * 加这个开关时我第一版判断错了：以为「加开关」本身就是破坏性变更。
 * 其实只要**默认仍然是「信」**，现有部署升级后行为完全相同 ——
 * 真正的破坏性变更是「把默认改成不信」，那会让所有已有反代部署的
 * 白名单、会话记录、水印**同时变成 `127.0.0.1`**。
 *
 * 所以这里用**两套服务**（一个默认、一个 `YQ_TRUST_PROXY=0`）来证明：
 * 默认那套照样被伪造绕过（行为没变），关掉那套伪造无效。
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 起一台服务，返回它的调用器与清理函数 */
async function boot(port, dbFile, extraEnv = {}) {
  for (const s of ['', '-wal', '-shm']) { const f = dbFile + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* ignore */ } } }
  const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT: String(port), YQ_DB: dbFile, YQ_ADMIN_PASSWORD: 'tp@2026', ...extraEnv },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  for (let i = 0; i < 50; i++) {
    await sleep(400)
    try { if ((await fetch(`http://127.0.0.1:${port}/api/health`)).ok) break } catch { /* 等 */ }
  }
  const call = async (p, o = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, o)
    const t = await r.text()
    try { return { status: r.status, d: t ? JSON.parse(t) : null } } catch { return { status: r.status, d: null } }
  }
  const ses = (p, o = {}, tk) => call(p, {
    ...o,
    // ⚠️ 这里**必须把 o.headers 合并进去**。
    //    第一版写成 `headers: { 'Content-Type':…, ...(tk ? … : {}) }`，
    //    **整个覆盖了 o.headers** —— 于是手写的 Authorization 和
    //    X-Forwarded-For 全被丢 → 全部 401，而 **401 在输出里长得
    //    和「被白名单挡住」几乎一样**（都是「读到 0 篇」），
    //    我差点据此汇报「伪造没用」。**探针坏掉时的表现，
    //    常常和「功能正常」是同一种样子。**
    headers: { 'Content-Type': 'application/json', ...(o.headers || {}), ...(tk ? { Authorization: 'Bearer ' + tk } : {}) },
  })
  const one = (sql, ...a) => { const d = new DatabaseSync(dbFile); d.exec('PRAGMA busy_timeout = 5000'); const r = d.prepare(sql).get(...a); d.close(); return r }
  const push = async (tk, upsert) => { const r = await ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert, remove: {} }) }, tk); return { status: r.status, applied: r.d?.applied, rejected: r.d?.rejected } }
  const login = (account, password) => call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account, password }) })
  return { call, ses, one, push, login, stop: () => { try { srv.kill() } catch { /* ignore */ } }, port }
}

const SFX = Math.random().toString(36).slice(2, 7)

/** 给一台服务铺好前置：注册一个人、给他 editor、开白名单 */
async function setup(s) {
  const admin = (await s.login('admin', 'tp@2026')).d?.token
  const acct = 'tp' + SFX
  await s.call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: acct, password: 'test1234', name: '普通成员' }) })
  const tok = (await s.login(acct, 'test1234')).d?.token
  const me = (await s.ses('/api/v2/user', {}, tok)).d
  const bk = (await s.ses('/api/entity/books', {}, admin)).d.rows[0]
  await s.push(admin, { bookMembers: [{ userId: me.id, bookId: bk.id, role: 'editor', perms: JSON.stringify({}), joinedAt: Date.now() }] })
  return { admin, tok, me, bk }
}

const readVia = (s, tok, xff) => s.ses('/api/entity/docs', { headers: { ...(xff == null ? {} : { 'X-Forwarded-For': xff }) } }, tok)

/* ================= A. 默认行为：与改之前完全一致 ================= */
console.log('\n== A. 默认（不设这个变量）：行为一个字都不变 ==')
{
  const s = await boot(8230, 'data/_tptrust-a.db')
  const { admin, tok, bk } = await setup(s)
  ok(!!(await s.ses('/api/entity/docs', {}, tok)).d?.rows?.length, '前置：不开白名单时读得到文稿')

  await s.push(admin, { bookSettings: [{ bookId: bk.id, ipWhitelist: 1, ipList: ['10.9.9.9'] }] })
  const row = s.one('SELECT ipWhitelist, ipList FROM book_settings WHERE bookId = ?', bk.id)
  ok(Number(row?.ipWhitelist) === 1, `白名单落库（ipList=${row?.ipList}）`)

  const real = (await readVia(s, tok, null)).d?.rows?.length
  ok(real === 0, `真 IP（127.0.0.1）被挡住：${real} 篇`)

  const forged = (await readVia(s, tok, '10.9.9.9')).d?.rows?.length
  ok(forged > 0, `★ 默认模式下伪造 XFF 依然能绕：${forged} 篇 —— **这正是「默认不变」的意思**`,
    '它证明加这个开关没有顺手改掉现有行为')
  s.stop()
}

/* ================= B. 关掉之后：伪造无效 ================= */
console.log('\n== B. YQ_TRUST_PROXY=0：伪造无效 ==')
{
  const s = await boot(8231, 'data/_tptrust-b.db', { YQ_TRUST_PROXY: '0' })
  const { admin, tok, bk } = await setup(s)
  ok(!!(await s.ses('/api/entity/docs', {}, tok)).d?.rows?.length, '前置：不开白名单时读得到文稿')

  await s.push(admin, { bookSettings: [{ bookId: bk.id, ipWhitelist: 1, ipList: ['10.9.9.9'] }] })

  const real = (await readVia(s, tok, null)).d?.rows?.length
  ok(real === 0, `真 IP 被挡住：${real} 篇`)

  const forged = (await readVia(s, tok, '10.9.9.9')).d?.rows?.length
  ok(forged === 0, `★ **伪造 XFF 无效了：${forged} 篇**`)

  // 而白名单里放「反代地址」时是可以进去的 —— 这就是 `=0` 之后的正确用法
  await s.push(admin, { bookSettings: [{ bookId: bk.id, ipWhitelist: 1, ipList: ['127.0.0.1', '::1', '::ffff:127.0.0.1'] }] })
  const viaLoopback = (await readVia(s, tok, null)).d?.rows?.length
  ok(viaLoopback > 0, `白名单里改填反代地址（127.0.0.1）后能进：${viaLoopback} 篇 —— 这是它的正确用法，不是坑`)
  s.stop()
}

/* ================= C. 源码层：默认必须是「信」 ================= */
console.log('\n== C. 源码层：默认值必须是「信」 ==')
{
  const src = readFileSync('server/auth.ts', 'utf8')
  const fn = /export function clientIp\([\s\S]{0,900}?\n\}/.exec(src)?.[0] || ''
  ok(fn.length > 0, '找到 clientIp 的函数体')
  ok(/YQ_TRUST_PROXY/.test(fn), '里面认这个变量')
  // 只在 **等于 '0'** 时才不信 —— 写成「没设就不信」就毁了向后兼容
  ok(/YQ_TRUST_PROXY === '0'/.test(fn), '**只在显式等于 0 时才不信**（写成「没设就不信」就是破坏性变更）')
  ok(!/!process\.env\.YQ_TRUST_PROXY/.test(fn), '没有把「未设置」当成「不可信」')
  // 两个分支都要有：不信时用 remoteAddress，信时先看 XFF
  ok(/remoteAddress/.test(fn), '不信时回落到 TCP 层的 remoteAddress')
  ok(/x-forwarded-for/.test(fn), '信时仍然读 X-Forwarded-For')
}

/* ================= D. 文档要说清两种模式 ================= */
console.log('\n== D. 文档：两种模式各自的适用场景 ==')
{
  const d = readFileSync('DEPLOY.md', 'utf8')
  ok(d.includes('YQ_TRUST_PROXY'), 'DEPLOY 提到了这个变量')
  ok(/不可被直连|不可直连/.test(d), '并且写明了「服务不可被直连」这个前提')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
