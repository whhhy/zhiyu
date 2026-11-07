/**
 * `YQ_TRUSTED_PROXY_IPS` —— 只信来自指定 IP 的请求头（XFF 与统一认证头一起管）
 * ============================================================
 * 背景：这两个头**都是请求方自己写的**，而危害差着一个量级。
 * 实测（探针，2026-10-05，服务可直连 + YQ_SSO_HEADER=X-Forwarded-User）：
 *   · 伪造 `X-Forwarded-For`  → 绕过知识库 IP 白名单、记错访问来源
 *   · 伪造 `X-Forwarded-User` → **不带任何密码或令牌，直接登录成那个人**，
 *     拿到他的全部知识库；报一个**不存在**的账号还能 JIT 开户，
 *     **顺带抢走「第一个进门的人拿 owner」那个位置**。
 *
 * `YQ_SSO_ONLY=1` 挡不住：它只关「密码登录这条路」，
 * 而伪造头走的正是 SSO 那条路本身。
 *
 * ------------------------------------------------------------
 * 这个开关和 `YQ_TRUST_PROXY=0` 是一回事吗？不是 —— 我第一版混为一谈了
 * ------------------------------------------------------------
 *   · `YQ_TRUST_PROXY=0` = **完全不信 XFF**，退回 socket 地址。
 *     对 IP 够用，**对 SSO 毫无意义** —— IP 不是身份凭据，
 *     不信它并不会让「谁是你」变安全。
 *   · `YQ_TRUSTED_PROXY_IPS` = **只信列表里那些来源的头**。
 *     这个对 SSO 同样有效：反代在列表里 → 正常登录；
 *     别人从别的 IP 直连 → 那个头不算数 → 进不来。
 *
 * 我第一版把「SSO 头没有开关」说成「关了就没人能登录」，
 * 那是把「不信头」误读成「拒绝所有 SSO」——
 * **和前一轮把 `YQ_TRUST_PROXY=0` 说成破坏性变更，是同一种误判。**
 *
 * ------------------------------------------------------------
 * 最要紧的一条：**不设 = 全信 = 行为与加这个开关之前完全一致**
 * ------------------------------------------------------------
 * 破坏性变更是「把它默认设成拒绝」，那会让所有反代部署的同事一起登不进来。
 * 下面用三台服务分别证明：默认那台照样能被伪造（= 没顺手改掉现有行为）。
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function boot(port, dbFile, extraEnv = {}) {
  for (const s of ['', '-wal', '-shm']) { const f = dbFile + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* ignore */ } } }
  const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: {
      ...process.env, PORT: String(port), YQ_DB: dbFile, YQ_ADMIN_PASSWORD: 'tp@2026',
      YQ_SSO_HEADER: 'X-Forwarded-User', YQ_SSO_NAME_HEADER: 'X-Forwarded-Name',
      ...extraEnv,
    },
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
    // ⚠️ o.headers 必须合并进来 —— 第一版整个覆盖掉它，
    //    于是 Authorization 和 X-Forwarded-For 全被丢 → 全部 401，
    //    而 **401 在输出里长得和「被挡住」几乎一样**，差点得出相反结论。
    headers: { 'Content-Type': 'application/json', ...(o.headers || {}), ...(tk ? { Authorization: 'Bearer ' + tk } : {}) },
  })
  return { call, ses, stop: () => { try { srv.kill() } catch { /* ignore */ } }, port }
}
const sso = (s, user, name = '%E5%BC%A0%E4%B8%89') =>
  s.call('/api/auth/sso', { method: 'POST', headers: { 'X-Forwarded-User': user, 'X-Forwarded-Name': name } })
const docsVia = (s, tk, xff) =>
  s.ses('/api/entity/docs', { headers: xff == null ? {} : { 'X-Forwarded-For': xff } }, tk)

/* ══════════════ A. 不设：行为与加这个开关之前完全一致 ══════════════ */
console.log('\n== A. 不设 YQ_TRUSTED_PROXY_IPS：行为一个字都不变 ==')
{
  const s = await boot(8240, 'data/_tpp-a.db')
  const r1 = await sso(s, 'zhangsan')
  ok(!!r1.d?.token, `SSO 正常登录（HTTP ${r1.status}，${r1.d?.user?.id}）`, String(r1.d?.error || ''))
  const r2 = await sso(s, 'lisi')
  ok(!!r2.d?.token, '换个账号也能登（第二个身份存在了）')
  // ★ 伪造：什么都不带，只报一个别人的账号
  const r3 = await sso(s, 'lisi')
  ok(!!r3.d?.token && r3.d?.user?.id === r2.d?.user?.id,
    `★ 默认模式下伪造头照样能登录成别人（${r3.d?.user?.account}）—— **这正是「默认不变」的意思**`)

  const docs = await docsVia(s, r1.d.token, '10.9.9.9')
  ok(Array.isArray(docs.d?.rows), `XFF 也照样被采信（读到 ${docs.d?.rows?.length} 篇）`)
  s.stop()
}

/* ══════════════ B. 配了列表：伪造无效 ══════════════ */
console.log('\n== B. YQ_TRUSTED_PROXY_IPS 配了：不在这张表里的来源，头不算数 ==')
{
  // 本机的回环地址 —— 反代通常就跑在这儿
  const s = await boot(8241, 'data/_tpp-b.db', { YQ_TRUSTED_PROXY_IPS: '10.20.30.40' })  // 故意填一个**不是**本机的
  const r = await sso(s, 'zhangsan')
  ok(!r.d?.token, `★ 源不在列表里 → SSO 头当没传（HTTP ${r.status}）`, String(r.d?.error || '').slice(0, 50))

  const admin = (await s.call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'tp@2026' }) })).d?.token
  const docs = await docsVia(s, admin, '10.9.9.9')
  ok(Array.isArray(docs.d?.rows), `XFF 同样不再被采信（走的是 TCP 地址）`)
  s.stop()
}

/* ══════════════ C. 在列表里：一切照常 ══════════════ */
console.log('\n== C. 反代确实在列表里：一切照常（这才是正确用法，不是坑）==')
{
  const s = await boot(8242, 'data/_tpp-c.db', { YQ_TRUSTED_PROXY_IPS: '::ffff:127.0.0.1,127.0.0.1' })
  const r = await sso(s, 'zhangsan')
  ok(!!r.d?.token, `SSO 正常登录（${r.d?.user?.id}）—— 反代在列表里，头就认`,
    String(r.d?.error || '').slice(0, 50))
  // ::ffff: 前缀两种写法都认（Node 在 IPv4 连接上会给 ::ffff:127.0.0.1）
  const docs = await docsVia(s, r.d.token, '10.9.9.9')
  ok(Array.isArray(docs.d?.rows), `XFF 也照常采信（读到 ${docs.d?.rows?.length} 篇）`)
  s.stop()
}

/* ══════════════ D. 配错时能不能看出来（多级反代那个坑）══════════════ */
console.log('\n== D. 名单填错时，错误信息要能指到真正的原因 ==')
{
  /*
   * 内网最常见的形状是 **网关(SSO) → nginx → 服务**：
   * 请求到服务时 `remoteAddress` 是 **nginx 那一层**，
   * 而运维照文档填的往往是**网关** —— 于是反代不在名单里，
   * **全员登不进来**，症状只是「登录页一直转圈」。
   *
   * 而它和「网关没传认证头」原来摆出同一张脸：
   * 都只回一句「请求未携带网关认证信息」，
   * **提示指向的方向（网关）恰好是好的那个**。
   */
  const s = await boot(8243, 'data/_tpp-d.db', { YQ_TRUSTED_PROXY_IPS: '10.0.0.5' })
  const r = await sso(s, 'zhangsan')
  const err = String(r.d?.error || '')
  ok(!r.d?.token, `被拒了（HTTP ${r.status}）`)
  ok(/YQ_TRUSTED_PROXY_IPS/.test(err), '错误信息点名了是哪个配置挡的', JSON.stringify(err.slice(0, 60)))
  ok(/名单/.test(err), '并且说清了「不在名单里」')
  ok(/多级反代|实际那一层/.test(err), '还指了修法（多级反代要填实际那一层）')
  s.stop()
}

/* ══════════════ B2. 书级访问统计：曾经漏网的一条 ══════════════ */
console.log('\n== B2. /api/book/:id/stats 也必须被白名单挡住 ==')
{
  /*
   * 7.29 那次把列表 / 搜索 / 导出 / 能力面板都接上了白名单，**独独漏了这里**。
   * 漏掉的后果比文档正文更敏感：它返回 `doc_views` 汇总的 14 天曲线，
   * 也就是**谁在哪天看了哪一篇**。
   * 当时的状态：列表 0 行、单篇 403、能力面板 403、**访问统计照样 200**。
   *
   * 而这个套件当时也只覆盖了「已经接上」的那几条 ——
   * **漏掉的那条没有任何东西会告诉你**（7.23 那条老毛病的又一次）。
   */
  const s = await boot(8243, 'data/_tpb.db')
  const admin = (await s.call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account: 'admin', password: 'tp@2026' }) })).d?.token
  const bk = (await s.ses('/api/entity/books', {}, admin)).d.rows[0]
  // 先造一点访问数据，否则「返回 0 条」和「被挡住」长得一样
  const doc = (await s.ses('/api/entity/docs', {}, admin)).d.rows[0]
  await s.call(`/api/doc/${doc.id}/view`, { method: 'POST', headers: { Authorization: 'Bearer ' + admin }, body: JSON.stringify({ ms: 1000 }) })
  const before = await s.ses(`/api/book/${bk.id}/stats`, {}, admin)
  ok(before.status === 200, `前置：统计可用（HTTP ${before.status}）`)

  // ⚠️ 这个 `boot()` 返回的对象只有 `call` / `ses` / `sso` / `stop`，**没有 `push`** ——
  //    第一版直接写 `s.push(...)` 就崩在这里。`ses` 已经带了 token 参数。
  const pushed = await s.ses('/api/sync/push', { method: 'POST', body: JSON.stringify({ upsert: { bookSettings: [{ bookId: bk.id, ipWhitelist: 1, ipList: ['10.9.9.9'] }] }, remove: {} }) }, admin)
  ok((pushed.d?.applied || []).length > 0, '（前置）白名单推成功（applied 非空）',
    '没 applied → ' + JSON.stringify(pushed.d).slice(0, 140))
  // ⚠️ 这里**不能**用 `/api/entity/bookSettings` 查「开关存没存」——
  //    白名单已经开了，而当前 IP 正是在名单外，所以那个接口**理应**返回 0 行。
  //    第一版就拿它当「存没存」的判据，于是得到一个假红。
  //    **「查不到」在这个时点恰恰是白名单生效的证据。**
  //    验证落库要直接查 SQLite。
  {
    const { DatabaseSync } = await import('node:sqlite')
    const d = new DatabaseSync('data/_tpb.db')
    const row = d.prepare('SELECT ipWhitelist, ipList FROM book_settings WHERE bookId = ?').get(bk.id)
    d.close()
    ok(Number(row?.ipWhitelist) === 1, `（前置）白名单真落库了（库：${row?.ipWhitelist} / ${row?.ipList}）`)
  }
  const after = await s.ses(`/api/book/${bk.id}/stats`, {}, admin)
  ok(after.status === 403, `★ 开了白名单（当前 IP 不在里面）后统计 403（实际 ${after.status}）`, String(after.d?.error || '').slice(0, 50))
  ok(!after.d?.days, '响应里没有那 14 天的曲线')

  // v2 那几条不直接调 requireIpAllowed，靠 resolveBook 间接覆盖 ——
  // 这里钉住「那条判定还在」，免得有人挪走时没人发现
  const v2 = await s.ses(`/api/v2/repos/${bk.spaceId}/${bk.id}/docs`, {}, admin)
  ok(v2.status !== 200 || !v2.d?.data, `v2 的文稿列表同样被挡（HTTP ${v2.status}，走 resolveBook）`)
  s.stop()
}

/* ══════════════ E. 源码层 ══════════════ */console.log('\n== E. 源码层 ==')
{
  const src = readFileSync('server/auth.ts', 'utf8')
  ok(/YQ_TRUSTED_PROXY_IPS/.test(src), '认这个配置')
  ok(/TRUSTED_PROXY_IPS\.size === 0\) return true/.test(src),
    '**没配 = 全信**（写成「没配就不信」就是破坏性变更）')
  // 两个头必须走同一套判据 —— 配了列表却只挡一个，是「半修状态」
  const ssoFn = /export function ssoHeaderUser[\s\S]{0,1200}?\n\}/.exec(src)?.[0] || ''
  const ipFn = /export function clientIp[\s\S]{0,900}?\n\}/.exec(src)?.[0] || ''
  ok(ssoFn.length > 0 && /fromTrustedProxy\(req\)/.test(ssoFn), 'SSO 头走了 fromTrustedProxy')
  ok(ipFn.length > 0 && /fromTrustedProxy\(req\)/.test(ipFn), 'XFF 也走了 fromTrustedProxy')
  ok(/::ffff:/.test(src), '兼容 Node 给 IPv4 连接加的 ::ffff: 前缀')
  // 启动时要说清「配错的后果是什么」
  const idx = readFileSync('server/index.ts', 'utf8')
  ok(/YQ_TRUSTED_PROXY_IPS/.test(idx), '启动时把这个配置打出来')
  ok(/谁也登不进来/.test(idx), '并说明配错的后果是「进不来」而不是「被绕过」')
}

/* ══════════════ E. 文档 ══════════════ */
console.log('\n== F. 文档 ==')
{
  const d = readFileSync('DEPLOY.md', 'utf8')
  ok(d.includes('YQ_TRUSTED_PROXY_IPS'), 'DEPLOY 提到了它')
  ok(/IP 不是身份凭据/.test(d), '并说清了它和 YQ_TRUST_PROXY 的区别')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
