/* ============================================================
   统一认证（走网关认证头）验证
   ------------------------------------------------------------
   这个套件自己起三个服务，不吃外部状态：
     A 关着 SSO     —— 确认 /api/auth/sso 不留后门，注册登录照常
     B 开着 SSO     —— 首次登录自动开户、大小写/域名前缀归一、令牌可用
     C 只许 SSO     —— 注册与密码登录必须被关掉，否则等于开了个绕过入口

   为什么必须自己起服务：SSO 是**环境变量**控制的开关，
   跑在共享的那个测试服务上永远测不到它 —— 测出来的是「没配时的行为」，
   不是「配了时的行为」。这两种混在一起，绿灯是没有意义的。
   ============================================================ */

import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { chromium } from 'playwright'
import { freePort } from './scripts/free-port.mjs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const PLAIN_PORT = process.env.SSO_PLAIN_PORT || await freePort()
const SSO_PORT = process.env.SSO_PORT || await freePort()
const ONLY_PORT = process.env.SSO_ONLY_PORT || await freePort()
const A = `http://localhost:${PLAIN_PORT}`
const B = `http://localhost:${SSO_PORT}`
const C = `http://localhost:${ONLY_PORT}`

/** 每个实例自带口令：不继承环境里的 ADMIN_PASS，免得一套变量错了整份证据作废 */
const PW = 'sso-test@2026'

const dbs = []
const kids = []

function startServer(port, env) {
  const db = `data/_sso-${port}-${Date.now().toString(36)}.db`
  dbs.push(db)
  const kid = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT: String(port), YQ_DB: db, YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0', ...env },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  kids.push(kid)
  return kid
}

async function waitUp(base, label) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`${base}/api/health`)).ok) return } catch { /* 等 */ }
  }
  throw new Error(`${label} 没能在 20 秒内起来`)
}

const post = async (base, p, body, headers = {}) => {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}
const get = async (base, p, headers = {}) => {
  const res = await fetch(base + p, { headers })
  return { status: res.status, data: await res.json().catch(() => null) }
}

let browser
try {
  startServer(PLAIN_PORT, {})
  startServer(SSO_PORT, { YQ_SSO_HEADER: 'X-Forwarded-User', YQ_SSO_NAME_HEADER: 'X-Forwarded-Name', YQ_SSO_EMAIL_HEADER: 'X-Forwarded-Email' })
  startServer(ONLY_PORT, { YQ_SSO_HEADER: 'X-Forwarded-User', YQ_SSO_ONLY: '1' })
  await waitUp(A, '实例 A')
  await waitUp(B, '实例 B')
  await waitUp(C, '实例 C')

  /* ---------- A：没开 SSO 时，不能凭空多出一个登录入口 ---------- */
  console.log('\n== A 关着统一认证 ==')
  {
    const h = await get(A, '/api/health')
    ok(h.data?.sso === false, 'health 里声明未开启', JSON.stringify(h.data?.sso))
    const sso = await post(A, '/api/auth/sso')
    ok(sso.status === 404, 'SSO 接口返回 404 而不是放行', String(sso.status))
    // 顺带钉住「没开 SSO 时密码这条路没被我改坏」
    const reg = await post(A, '/api/auth/register', { account: 'plainuser', password: 'plainpass', name: '普通同事' })
    ok(reg.status === 200 && !!reg.data?.token, '普通注册仍然可用', String(reg.status))
    const li = await post(A, '/api/auth/login', { account: 'plainuser', password: 'plainpass' })
    ok(li.status === 200 && !!li.data?.token, '普通密码登录仍然可用', String(li.status))
  }

  /* ---------- B：开着 SSO ---------- */
  console.log('\n== B 开着统一认证 ==')
  let ownerToken = ''
  {
    const h = await get(B, '/api/health')
    ok(h.data?.sso === true, 'health 里声明已开启', JSON.stringify(h.data?.sso))

    const noHdr = await post(B, '/api/auth/sso')
    ok(noHdr.status === 401, '不带认证头 → 401，不给建号', String(noHdr.status))

    // 第一个从门进来的人。播种已经建了一个能用密码登的 admin，
    // 所以统一认证开着的普通部署里，第一个人就只是普通成员 ——
    // 不能让「第一个进门的人」绕过管理员白拿平台权限。
    //
    // 注意姓名头传的是百分号编码：HTTP 头只能是 Latin-1，浏览器和 Node
    // 都会在发出之前就把「张三」这种非 ASCII 头值拒掉 —— 所以真实网关
    // 也只能编码后传。想验证这点，可以把下面这行直接写成 '张三'，
    // 会在 fetch 那里就抛 ByteString 错误，跟服务端无关。
    const r1 = await post(B, '/api/auth/sso', {}, { 'X-Forwarded-User': 'zhangsan', 'X-Forwarded-Name': '%E5%BC%A0%E4%B8%89', 'X-Forwarded-Email': 'zhangsan%40corp.com' })
    ok(r1.status === 200 && !!r1.data?.token, '带认证头即可登录', String(r1.status))
    ok(r1.data?.user?.name === '张三', '百分号编码的姓名头能解出中文', r1.data?.user?.name)
    ok(r1.data?.user?.role === 'member', '统一认证开的号默认是普通成员（管理员另有其人）', r1.data?.user?.role)
    ownerToken = r1.data?.token || ''

    // 另一种现实里同样常见的编码：RFC 2047（Word 域、Outlook 转发会这么发）
    const r1c = await post(B, '/api/auth/sso', {}, { 'X-Forwarded-User': 'sunqi', 'X-Forwarded-Name': '=?UTF-8?B?5a2Z5LiD?=' })
    ok(r1c.data?.user?.name === '孙七', 'RFC 2047 编码的姓名头也能解出中文', r1c.data?.user?.name)

    // 没开 YQ_SSO_ONLY 时，密码这条路必须没被我改坏
    const adminLogin = await post(B, '/api/auth/login', { account: 'admin', password: PW })
    ok(adminLogin.status === 200, '开着统一认证时，管理员仍可用密码登录', String(adminLogin.status))

    // 发下来的令牌必须真的能用（统一认证只换入口，不换内核）
    const me = await get(B, '/api/auth/me', { Authorization: `Bearer ${ownerToken}` })
    ok(me.status === 200 && me.data?.user?.account === 'zhangsan', '令牌可直接用于后续请求', `${me.status} ${me.data?.user?.account}`)
    const bs = await get(B, '/api/bootstrap', { Authorization: `Bearer ${ownerToken}` })
    ok(bs.status === 200 && !!bs.data?.data, '令牌能拉取知识库数据', String(bs.status))

    // 自动开户的人也得有地方落笔
    const spaces = (bs.data?.data?.spaces || []).filter((s) => s.kind === 'personal')
    ok(spaces.length >= 1, '自动开户的人有个人空间', String(spaces.length))

    // 第二次登录是同一个账号，不该再开一个
    const r1b = await post(B, '/api/auth/sso', {}, { 'X-Forwarded-User': 'zhangsan' })
    ok(r1b.data?.user?.id === r1.data?.user?.id, '再次登录复用同一个账号', `${r1b.data?.user?.id} vs ${r1.data?.user?.id}`)

    // 账号大小写不敏感：AD / LDAP / 企业微信的登录名都不区分大小写
    const upper = await post(B, '/api/auth/sso', {}, { 'X-Forwarded-User': 'ZhangSan' })
    ok(upper.data?.user?.id === r1.data?.user?.id, '换个大小写仍是同一个人（不重复开户）', upper.data?.user?.account)

    // 第二个同事：普通成员
    const r2 = await post(B, '/api/auth/sso', {}, { 'X-Forwarded-User': 'lisi' })
    ok(r2.status === 200 && r2.data?.user?.role === 'member', '第二个人是普通成员', r2.data?.user?.role)

    // 域名前缀：AD 给的是 DOMAIN\user，邮箱形式给的是 user@corp.com
    const r3 = await post(B, '/api/auth/sso', {}, { 'X-Forwarded-User': 'CORP\\wangwu' })
    ok(r3.status === 200 && r3.data?.user?.name === 'wangwu', '域名前缀被剥掉用于显示名', r3.data?.user?.name)
    const r4 = await post(B, '/api/auth/sso', {}, { 'X-Forwarded-User': 'zhaoliu@corp.com' })
    ok(r4.status === 200 && r4.data?.user?.name === 'zhaoliu', '邮箱形式也能认出显示名', r4.data?.user?.name)
    // 账号本身也可能是百分号编码的邮箱
    const r5 = await post(B, '/api/auth/sso', {}, { 'X-Forwarded-User': 'sunba%40corp.com' })
    ok(r5.status === 200 && r5.data?.user?.account === 'sunba@corp.com', '编码过的邮箱账号也解得出来', r5.data?.user?.account)
    // 存和查必须走同一个函数：换个大小写再来一次，还是同一个人
    const r5b = await post(B, '/api/auth/sso', {}, { 'X-Forwarded-User': 'SUNBA%40CORP.COM' })
    ok(r5b.data?.user?.id === r5.data?.user?.id, '编码过的账号也按大小写不敏感匹配', `${r5b.data?.user?.id} vs ${r5.data?.user?.id}`)

    // 伪造头里夹不可见字符 / 超长，一律当没传。
    // 这里用 tab 而不是换行：换行会被 Node 的 HTTP 解析器挡在门外（返回 400），
    // 那样测到的是 Node 的行为、不是我们这层的过滤，测了等于没测。
    // tab 能穿过解析器进来，正好能验证我们自己那道过滤。
    const ctl = await fetch(`${B}/api/auth/sso`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-User': 'a\tb' }, body: '{}',
    })
    ok(ctl.status === 401, '用户名里夹不可见字符 → 拒掉（401）', String(ctl.status))
    const long = await post(B, '/api/auth/sso', {}, { 'X-Forwarded-User': 'x'.repeat(200) })
    ok(long.status === 401, '超长的用户名 → 拒掉（401）', String(long.status))

    // 统一认证开的账号没有口令，就该登不进去
    const pwd = await post(B, '/api/auth/login', { account: 'lisi', password: '' })
    ok(pwd.status === 401, '统一认证开的账号不能用密码登录', String(pwd.status))

    // 前端不该在开着统一认证时还渲染密码表单
    browser = await chromium.launch()
    const ctx = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-User': 'zhangsan' } })
    const page = await ctx.newPage()
    await page.goto(B, { waitUntil: 'domcontentloaded' })
    const wentStraightIn = await page.waitForSelector('.yq-app', { timeout: 25000 }).then(() => true).catch(() => false)
    ok(wentStraightIn, '浏览器里带着认证头访问，直接进应用、看不到登录页')
    const tokenInLs = await page.evaluate(() => localStorage.getItem('yq_token'))
    ok(!!tokenInLs, '统一认证后也落了会话令牌（刷新不用再认证）')

    // 反过来：不带认证头时应该老实显示登录页，而不是卡在白屏
    const ctx2 = await browser.newContext()
    const page2 = await ctx2.newPage()
    await page2.goto(B, { waitUntil: 'domcontentloaded' })
    const showsLogin = await page2.waitForSelector('.yq-login-card', { timeout: 25000 }).then(() => true).catch(() => false)
    ok(showsLogin, '没带认证头时回落到登录页')
    const errText = await page2.textContent('.yq-login-err').catch(() => '')
    ok(/统一认证/.test(errText || ''), '登录页说明了原因（不是让人干瞪眼）', errText || '(空)')
  }

  /* ---------- C：只许统一认证 ---------- */
  console.log('\n== C 只允许统一认证 ==')
  {
    const h = await get(C, '/api/health')
    ok(h.data?.sso === true && h.data?.ssoOnly === true, 'health 声明「仅统一认证」', JSON.stringify(h.data))
    const reg = await post(C, '/api/auth/register', { account: 'backdoor', password: 'backdoor', name: '后门' })
    ok(reg.status === 403, '本地注册被关掉（403）', String(reg.status))
    const li = await post(C, '/api/auth/login', { account: 'admin', password: PW })
    ok(li.status === 403, '密码登录被关掉（403），连播种的 admin 也进不来', String(li.status))
    // 但统一认证这条路必须是通的，否则谁也进不去
    const viaSso = await post(C, '/api/auth/sso', {}, { 'X-Forwarded-User': 'ceo' })
    ok(viaSso.status === 200, '统一认证这条路仍然畅通', String(viaSso.status))
    // 这一条是「只许统一认证」能不能用的关键：播种建的 admin 密码登录已关，
    // 进不来。要是第一个 SSO 用户也只是 member，这个部署就没有管理员，
    // 谁也进不了设置页 —— 而且不报任何错，是最难查的那种坏法。
    ok(viaSso.data?.user?.role === 'owner', '只许统一认证时，第一个进门的人成为管理员', viaSso.data?.user?.role)
    // 但不能人人都成管理员：这条规则只对第一个人生效
    const second = await post(C, '/api/auth/sso', {}, { 'X-Forwarded-User': 'lisi' })
    ok(second.data?.user?.role === 'member', '第二个人仍是普通成员', second.data?.user?.role)

    // 界面上不该还摆着「注册一个」的入口
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(C, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-login-card', { timeout: 25000 }).catch(() => {})
    const switchVisible = await page.isVisible('.yq-login-switch').catch(() => false)
    ok(!switchVisible, '登录页不再显示「注册一个」入口')
  }
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  try { await browser?.close() } catch { /* 已关 */ }
  for (const k of kids) { try { k.kill() } catch { /* 已退出 */ } }
  for (const f of dbs) for (const s of ['', '-wal', '-shm']) {
    if (existsSync(f + s)) { try { rmSync(f + s) } catch { /* 删不掉就算了 */ } }
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
