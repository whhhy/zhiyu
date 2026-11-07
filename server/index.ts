/* ============================================================
   服务端入口
   一个进程同时负责三件事：
     1. 提供 REST API
     2. 中继 WebSocket 实时协作
     3. 托管前端构建产物（dist/）

   为什么单进程而不是 nginx + node + 数据库：
   内网部署的运维成本决定成败。「docker run 一条命令就能起」比
   「先装 nginx、配 upstream、处理跨域」更值得选。
   需要接公司现有网关时，**反代这一个端口**即可（nginx 那段见 DEPLOY 第四节）。
   挂在子路径上要**重新构建**：VITE_API_BASE=/knowledge npm run build
   （⚠️ 没有 `YQ_BASE_PATH` 那个东西 —— 早先这里写过它，代码里从来没有过，
     配了它什么也不会发生，而症状是「点什么都 404」。）
   ============================================================ */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, normalize, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { db, logChange, parseJson } from './db.ts'
import type { Row } from './db.ts'
import { hashPassword, verifyPassword, createSession, destroySession, userFromToken, extractToken, clientIp, fromTrustedProxy, purgeExpiredSessions, listSessions, revokeSessionByRef, SSO_ENABLED, SSO_ONLY, ssoHeaderUser, createUserWithSpace } from './auth.ts'
import { bootstrap, push, changesSince, readEntity, searchAll, restoreDoc, purgeDoc, deleteBook, moveDoc, purgeExpiredTrash, trashRetentionDays, docRow, resolveDoc, exportBundle, importBundle, docsReferencing, reindex } from './sync.ts'
import { byName, toClient, auditEntityColumns } from './entities.ts'
import type { EntityDef } from './entities.ts'
import { capsInBook, capsOfDoc, canSeeDocRow, bookIdOfDoc, ipAllowed, exportAllowed, capsInSpace, publicDocGate } from './perms.ts'
import { attachWebSocket, presence } from './ws.ts'
import { logAudit, readAudit, readMySecurityLog, AUDIT } from './audit.ts'
import { createApiToken, listApiTokens, revokeApiToken, revokeAllApiTokens, verifyApiToken, SCOPES } from './tokens.ts'
import type { Scope } from './tokens.ts'
import { markdownToBlocks } from '@/lib/markdown-to-blocks'
import { countWordsFromBlocks } from '@/lib/word-count'
import { isEmpty, seed } from './seed.ts'
import type { User } from './perms.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.PORT || 8080)
const HOST = process.env.HOST || '0.0.0.0'

/* ============================================================
   极简路由
   不引 express：内网部署少一个依赖就少一份「装不上」的理由，
   而这里需要的路由能力只有「路径 + 方法」两级。
   ============================================================ */

type Handler = (ctx: Ctx) => Promise<unknown> | unknown
interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  user: User | null
  /**
   * 这把凭据是**哪一种**。
   *
   * 只有 user 是不够的：一把访问令牌和一次网页会话都能解析出用户，
   * 但它们能做的地方不一样。会话是「这个人在浏览器里操作」，
   * 令牌是「一段程序在替这个人调 API」——
   * 前者可以管理令牌、可以读审计日志、可以整包导出，
   * 后者只该出现在 /api/v2。记不住来源就没法在这里卡住它，
   * 而漏掉这一层的表现是：CI 里一把只读令牌能读走整个工作台。
   */
  auth: AuthInfo | null
  params: Record<string, string>
  body: () => Promise<any>
}
interface AuthInfo {
  via: 'session' | 'token'
  /** 会话令牌给全部；访问令牌只给创建时勾的那几项 */
  scopes: Scope[]
  tokenId?: string
}
interface Route {
  method: string
  seg: string[]
  handler: Handler
}

const routes: Route[] = []
const on = (method: string, path: string, handler: Handler) =>
  routes.push({ method, seg: path.split('/').filter(Boolean), handler })

function match(method: string, pathname: string) {
  const parts = pathname.split('/').filter(Boolean)
  for (const r of routes) {
    if (r.method !== method) continue
    if (r.seg.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < r.seg.length; i++) {
      const s = r.seg[i]
      if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i])
      else if (s !== parts[i]) { ok = false; break }
    }
    if (ok) return { handler: r.handler, params }
  }
  return null
}

/* ============================================================
   响应助手
   ============================================================ */

function json(res: ServerResponse, code: number, body: any) {
  const s = JSON.stringify(body)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
  })
  res.end(s)
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += c.length
    // 附件走独立的二进制通道，这里只兜住「有人硬塞超大 JSON」的误用。
    //
    // 抛的时候**必须带 status=413**（Payload Too Large）：
    // 原来是个没有 status 的 Error，dispatcher 一律当 500 ——
    // 而这明明是**客户端**把包撑大了。后果有两个：
    //   · 返回 500，对方以为服务端挂了，去查服务端的健康状况；
    //   · `if (status >= 500) console.error` 会把它**记成服务端错误**，
    //     于是一次误用就能把错误日志刷满，真故障反而被淹掉。
    if (size > 64 * 1024 * 1024) {
      const e: any = new Error('请求体过大（上限 64MB）。附件请走 /api/attachment 的二进制通道。')
      e.status = 413
      throw e
    }
    chunks.push(c as Buffer)
  }
  if (!chunks.length) return null
  const raw = Buffer.concat(chunks)
  try { return JSON.parse(raw.toString('utf8')) } catch { return null }
}

/** 需要登录的路由用它包一层 */
function requireUser(ctx: Ctx): User {
  if (!ctx.user) { const e: any = new Error('未登录或会话已过期'); e.status = 401; throw e }
  return ctx.user
}

/** 需要某项 scope 的路由用它包一层。会话令牌一律放行 */
function requireScope(ctx: Ctx, need: Scope): User {
  const u = requireUser(ctx)
  if (ctx.auth?.via === 'token' && !ctx.auth.scopes.includes(need)) {
    const e: any = new Error(
      `这把令牌只有 ${ctx.auth.scopes.join(' / ' || 'read')} 权限，做不了 ${need}。` +
      `请到「设置 → 访问令牌」新建一把带 ${need} 权限的令牌。`,
    )
    e.status = 403
    throw e
  }
  return u
}

/* ============================================================
   鉴权路由
   ============================================================ */

/**
 * 密码登录的尝试次数限制。
 *
 * 为什么要加：默认部署**注册是敞开的**（`SSO_ONLY` 默认 0，
 * 任何能连到这个端口的人都能注册 —— 注册本身不给任何数据，
 * 这一点是有意的、DEPLOY 第三节写明了开通流程），
 * 而种子管理员的口令是写在代码里的 `yuque@2026`。
 * 这两件事叠起来就是：**内网里任何人都可以对 `/api/auth/login` 无限次穷举**。
 *
 * 而同一个服务里，**对外分享的访问密码早就有这套限流**（8 次 / 10 分钟，
 * 锁定期内正确密码也进不去）。主登录不管、分享密码管，
 * 这个不对称没有任何道理 —— 所以照同一个模式补上。
 *
 * **键为什么是 `账号|IP` 而不是单独一个**：
 * · 单独按账号 → 攻击者只要知道 `admin` 这个名字，就能把**所有**人锁在外面
 *   （他在自己那边狂试，你这边全员登不进来），这是拿限流当 DoS 用；
 * · 单独按 IP → **内网全员共享一个出口 IP 是常态**，
 *   任意一个人手滑 8 次，整个办公室一起登不进来；
 * · 账号 + IP → 攻击者猜 `admin` 只能锁住**他自己那个组合**，
 *   而同事在同一个 NAT 后用各自的账号，互不影响。
 *   和分享密码用 `docId|ip` 是同一个取舍。
 *
 * **在查用户之前就判**（下面代码里 `fail()` 之前那一步）：
 * 于是不存在的账号同样被计数 —— 429 与 401 的差别
 * 不会告诉攻击者「这个账号是不是真的存在」。
 *
 * 内存里计数、进程重启清零：和分享密码同一个理由，
 * 防的是「写个循环穷举」，而那种事一次重启就打断。
 */
const loginTries = new Map<string, { n: number; until: number }>()
const LOGIN_TRY_LIMIT = 8
const LOGIN_TRY_WINDOW_MS = 10 * 60 * 1000
const loginTryKey = (account: string, ip: string) => `${account}|${ip}`

function loginBlocked(account: string, ip: string): boolean {
  const k = loginTryKey(account, ip)
  const rec = loginTries.get(k)
  if (!rec) return false
  if (Date.now() > rec.until) { loginTries.delete(k); return false }
  return rec.n >= LOGIN_TRY_LIMIT
}
function noteLoginTry(account: string, ip: string) {
  const k = loginTryKey(account, ip)
  const rec = loginTries.get(k)
  if (!rec || Date.now() > rec.until) loginTries.set(k, { n: 1, until: Date.now() + LOGIN_TRY_WINDOW_MS })
  else rec.n++
}
const clearLoginTries = (account: string, ip: string) => loginTries.delete(loginTryKey(account, ip))

on('POST', '/api/auth/register', async (ctx) => {
  const b = await ctx.body()
  const account = String(b?.account || '').trim()
  const password = String(b?.password || '')
  const name = String(b?.name || '').trim()
  if (!account || !password) { const e: any = new Error('账号与密码必填'); e.status = 400; throw e }
  if (password.length < 6) { const e: any = new Error('密码至少 6 位'); e.status = 400; throw e }
  if (SSO_ONLY) { const e: any = new Error('本实例只接受统一认证，请从公司门户进入'); e.status = 403; throw e }

  const exists = db.prepare('SELECT 1 AS x FROM users WHERE account = ?').get(account)
  if (exists) { const e: any = new Error('该账号已存在'); e.status = 409; throw e }

  const { hash, salt } = hashPassword(password)
  // 建用户 + 开个人空间（与统一认证首登共用一条路径）
  const u = createUserWithSpace({ account, name: name || account, email: String(b?.email || ''), passHash: hash, passSalt: salt })

  const token = createSession(u.id, String(ctx.req.headers['user-agent'] || ''), clientIp(ctx.req))
  return { token, user: { id: u.id, name: u.name, account: u.account, role: u.role } }
})

on('POST', '/api/auth/login', async (ctx) => {
  const b = await ctx.body()
  const account = String(b?.account || '').trim()
  const password = String(b?.password || '')
  const ip = clientIp(ctx.req)
  // 账号不存在与密码错误返回同一句话，避免暴露「哪些账号存在」
  const fail = () => { const e: any = new Error('账号或密码不正确'); e.status = 401; throw e }
  if (SSO_ONLY) { const e: any = new Error('本实例只接受统一认证，请从公司门户进入'); e.status = 403; throw e }
  /*
   * 限流判在**查用户之前**：不存在的账号同样被计数，
   * 于是 429 与 401 的差别不泄露「这个账号是不是真的存在」。
   * 判在之后的话，攻击者可以用 401/429 的差别把账号表一个个试出来。
   */
  if (loginBlocked(account, ip)) {
    const e: any = new Error('登录尝试次数过多，请 10 分钟后再试'); e.status = 429; throw e
  }
  const u = db.prepare('SELECT * FROM users WHERE account = ?').get(account) as Row | undefined
  if (!u) { noteLoginTry(account, ip); fail() }
  if (!verifyPassword(password, String(u.passHash), String(u.passSalt))) { noteLoginTry(account, ip); fail() }
  clearLoginTries(account, ip)
  const token = createSession(String(u.id), String(ctx.req.headers['user-agent'] || ''), ip)
  return { token, user: { id: u.id, name: u.name, account: u.account, role: u.role, avatar: u.avatar || '', passwordChangedAt: u.passwordChangedAt || null } }
})

/**
 * 统一认证入口。
 *
 * 关键设计：**这里只负责「一次性证明你是谁」，然后发一个普通会话令牌**，
 * 之后的权限判定、会话撤销、审计全都走原来那套，一行没改。
 * 统一认证只换入口，不换内核 —— 换整套认证机制的话，
 * 权限矩阵里每一处判定都得重新验证一遍，那种改法出过 bug 都不知道是哪一层坏的。
 */
on('POST', '/api/auth/sso', async (ctx) => {
  // 没开这个开关就别留这个口子：返回 404，前端自动回落到密码登录
  if (!SSO_ENABLED) { const e: any = new Error('未启用统一认证'); e.status = 404; throw e }

  const who = ssoHeaderUser(ctx.req)
  /*
   * 被拒时**要说清是哪一种「没有」**。
   *
   * 原来只说「请求未携带网关认证信息」—— 于是两种完全不同的故障
   * 摆出同一张脸：
   *   · 网关没传认证头          → 「网关配置错了」
   *   · 传了但来源不在 YQ_TRUSTED_PROXY_IPS 里 → 「**你名单填错了**」
   * 第二种在内网特别容易踩：多级反代（网关 → nginx → 服务）时，
   * 请求到服务的 `remoteAddress` 是**nginx 那层**，
   * 而运维通常只填了网关 —— 于是**全员登不进来**，
   * 症状只是登录页一直转圈，而提示指向的方向（网关）恰好是好的那个。
   */
  if (!who) {
    const trusted = fromTrustedProxy(ctx.req)
    const e: any = new Error(
      !trusted && String(process.env.YQ_TRUSTED_PROXY_IPS || '').trim()
        ? `请求来自 ${clientIp(ctx.req)}，不在 YQ_TRUSTED_PROXY_IPS 名单里，所以不认网关认证头。` +
          `多级反代时请把**实际那一层**（不一定是网关）也填进去。`
        : '请求未携带网关认证信息',
    )
    e.status = 401
    throw e
  }

  // 账号大小写不敏感：AD / LDAP / 企业微信的登录名都不区分大小写，
  // 不这么做的话同一个人换个大小写就成了两个账号、两份个人空间。
  let row = db.prepare('SELECT id,name,account,role,avatar FROM users WHERE lower(account) = lower(?)').get(who.account) as Row | undefined
  if (!row) {
    // 首次登录自动开户（JIT），省掉「先在门户建人、再来这儿建人」的双重录入
    //
    // 管理员判定看的是「这个位置有没有人占了」，不是「这是不是数据库里的第一个人」。
    // 播种时一定会建一个 admin 账号，而在 YQ_SSO_ONLY=1 的部署里密码登录是关掉的，
    // 那个 admin 永远登不进来 —— 于是纯统一认证的全新部署如果没有这条规则，
    // 就会是一个谁都不是管理员的库，而且不报任何错。
    //
    // 两种情况下第一个进门的人得当 owner：
    //   · 只允许统一认证 —— 密码建的 admin 进不来，且还没有人从门进来过
    //   · 库里一个 owner 都没有 —— 全新初始化还没播种成功
    // 其余情况一律 member。让「第一个进门的人」无脑拿平台权限，
    // 等于谁抢得快谁当管理员。
    //
    // ⚠️ 判据**以函数形式**传进去，不在这里先算好：
    // 它必须在 `createUserWithSpace` 的事务**内**求值 ——
    // 否则就是「事务外查、事务内插」，并发首登会拿到**两个** owner
    // （owner 是平台最高权限：管理页、全量审计、办离职、整包导出）。
    // 这里先算好再传 result 的写法看着一样，实则修了个寂寞。
    createUserWithSpace({
      account: who.account,
      name: who.name,
      email: who.email,
      viaSso: true,
      decideRole: () => {
        const noSsoUserYet = !db.prepare('SELECT 1 AS x FROM users WHERE viaSso = 1 LIMIT 1').get()
        const noOwnerYet = !db.prepare("SELECT 1 AS x FROM users WHERE role = 'owner' LIMIT 1").get()
        return (noOwnerYet || (SSO_ONLY && noSsoUserYet)) ? 'owner' : 'member'
      },
    })
    row = db.prepare('SELECT id,name,account,role,avatar FROM users WHERE lower(account) = lower(?)').get(who.account) as Row
  }

  const token = createSession(String(row.id), String(ctx.req.headers['user-agent'] || ''), clientIp(ctx.req))
  return { token, user: { id: row.id, name: row.name, account: row.account, role: row.role, avatar: row.avatar || '', passwordChangedAt: row.passwordChangedAt || null } }
})

on('POST', '/api/auth/logout', async (ctx) => {
  const t = extractToken(ctx.req)
  if (t) destroySession(t)
  return { ok: true }
})

on('GET', '/api/auth/me', (ctx) => {
  const u = requireUser(ctx)
  const row = db.prepare('SELECT id,name,account,role,avatar,email,bio,passwordChangedAt FROM users WHERE id = ?').get(u.id) as Row
  return { user: row }
})

/**
 * 我登录过哪些设备（语雀的「帐户安全 → 登录设备」）。
 *
 * 现在能清会话的只有三条路：登出（只清当前）、改密码（清其他全部）、
 * 办离职（清该用户全部）。于是「这台电脑丢了但不想改密码把同事一起踢掉」
 * 没有出口 —— 底层能力早就有（会话是可撤销的随机 token），缺的只是这一层。
 *
 * ⚠️ 响应里**没有 token**，只有 `sha256(token)` 的前 16 位 ——
 * 主键就是 token 本身，把它发出去等于把别的设备的凭据交出去。
 * 细节见 `auth.ts` 里 `sessionRef` 那段。
 */
on('GET', '/api/auth/sessions', (ctx) => {
  const u = requireUser(ctx)
  return { sessions: listSessions(u.id, extractToken(ctx.req) || '') }
})

/** 下线某一台设备 */
on('DELETE', '/api/auth/sessions/:ref', (ctx) => {
  const u = requireUser(ctx)
  const r = revokeSessionByRef(u.id, String(ctx.params.ref || ''), extractToken(ctx.req) || '')
  if (r === 'current') {
    // 语雀也不让删当前设备（列表里那台是绿点）—— 想要这个效果就用「退出登录」
    const e: any = new Error('这是当前这台设备；要下线它请用「退出登录」')
    e.status = 400
    throw e
  }
  if (r === 'not-found') {
    // 不区分「不存在」和「不是你的」—— 两者都回 404，
    // 否则这个接口就成了「帮你确认某个 ref 存不存在」的探针
    const e: any = new Error('没有这台设备的登录记录')
    e.status = 404
    throw e
  }
  return { ok: true }
})

/**
 * 改自己的资料。
 *
 * 之前设置页那个「保存修改」按钮只弹了一句「资料已保存」——
 * 昵称、账号、简介三个输入框改的是**组件的局部 state**，
 * 点完按钮什么都没存，刷新就回去了。而这是设置页的**第一屏**。
 *
 * 这里只开放三项：**昵称 / 邮箱 / 个人简介**。
 *
 * **账号（登录名）刻意不给改**，理由不是「省事」：
 *   · 它是登录名，全局唯一，改名要处理「已被占用」这种用户没法自己解决的冲突；
 *   · 审计日志、访问日志、离职记录里到处都是它 —— 中途改掉会让历史记录对不上；
 *   · 统一认证（\`YQ_SSO_HEADER\`）下账号由网关决定，这里改了下次登录就被覆盖，
 *     于是「我改了名字，怎么刷新又变回去了」。
 * 所以界面上那个输入框改成只读并写清原因，而不是留一个改了不生效的框。
 *
 * **为什么不能用 \`/api/sync/push\` 走 members 实体**：那条路要平台管理员
 * （denyReason 里 members 只放行 admin）。改自己的昵称显然不该要管理员权限，
 * 所以这是一个只针对「自己」的窄接口，而不是把 members 的口子放松。
 */
on('PATCH', '/api/users/me', async (ctx) => {
  const u = requireUser(ctx)
  const b = (await ctx.body()) || {}

  // 只认这三个字段：多传的（account / role / passHash …）**一律忽略**，
  // 而不是报错 —— 但忽略要在代码里写明，否则将来有人会以为传了就生效了。
  const patch: Row = {}
  if ('name' in b) {
    const name = String(b.name ?? '').trim().slice(0, 40)
    if (!name) { const e: any = new Error('昵称不能为空'); e.status = 400; throw e }
    patch.name = name
  }
  if ('email' in b) {
    const email = String(b.email ?? '').trim().slice(0, 120)
    // 只挡明显不是邮箱的，不做完整校验 ——
    // 邮箱在这套系统里不参与任何逻辑（不发通知、不是登录名），
    // 写一套 RFC 规则只会让用户被一条看不懂的报错拦住。
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const e: any = new Error('邮箱格式不对（要包含 @ 和域名）'); e.status = 400; throw e
    }
    patch.email = email
  }
  if ('bio' in b) patch.bio = String(b.bio ?? '').trim().slice(0, 500)
  /*
   * 头像：这里只接受一个**附件 id**，不接受 URL 更不接受 data URL。
   *
   * ⚠️ 为什么不直接存图片：
   *   一张 200KB 的头像进 users 表 → 进同步实体 → 每台设备每次 bootstrap
   *   都带着它转一圈，写进 localStorage 也撑不住。
   *   存 id（指向 attachments 里那条记录）才是对的。
   *
   * ⚠️ 也不接受任意 URL：那等于「让用户把 <img> 指到任何地方」，
   *   而这个字段会出现在别人的界面上（协作条、成员列表…）。
   *   必须是本系统 attachments 里的 id。
   */
  if ('avatar' in b) {
    const id = String(b.avatar ?? '').trim()
    if (id) {
      const att = db.prepare('SELECT id FROM attachments WHERE id = ? AND docId IS NULL').get(id) as Row | undefined
      if (!att) { const e: any = new Error('这个头像不存在，请重新上传'); e.status = 400; throw e }
      patch.avatar = id
    } else {
      patch.avatar = ''
    }
  }

  if (!Object.keys(patch).length) {
    return { ok: true, user: db.prepare('SELECT id,name,account,role,avatar,email,bio FROM users WHERE id = ?').get(u.id) as Row }
  }

  const sets = Object.keys(patch).map((k) => `${k} = ?`)
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...Object.values(patch), u.id)

  // 记一条变更，别的设备才能看到这个改动（不然只有这台设备的 store 变了）。
  // 注意 users 表**没有 rev 列**（它不在同步协议里当实体版本用），
  // 所以这里不能像别的实体那样传 rev —— 传一个不存在的列会直接
  // 「no such column: rev」，而报错发生在保存成功之后，最难查。
  logChange('members', u.id, 'upsert', 0, u.id)
  return { ok: true, user: db.prepare('SELECT id,name,account,role,avatar,email,bio FROM users WHERE id = ?').get(u.id) as Row }
})

/* ============================================================
   数据同步路由
   ============================================================ */

on('GET', '/api/bootstrap', (ctx) => {
  const u = requireUser(ctx)
  // lite=0 时才整包带正文。默认轻量：正文按需从 /api/doc/:id 取。
  const lite = ctx.url.searchParams.get('lite') !== '0'
  return bootstrap(u, lite, clientIp(ctx.req))
})

on('POST', '/api/sync/push', async (ctx) => {
  const u = requireUser(ctx)
  const b = await ctx.body()
  return push(u, { upsert: b?.upsert || {}, remove: b?.remove || {} })
})

on('GET', '/api/sync/changes', (ctx) => {
  const u = requireUser(ctx)
  const since = Number(ctx.url.searchParams.get('since') || 0)
  return changesSince(u, Number.isFinite(since) ? since : 0, clientIp(ctx.req))
})

/**
 * 全文搜索。
 * 轻量启动之后客户端不再持有全部正文，搜索只能在服务端做 ——
 * 否则用户搜一篇自己没打开过的文档，结果永远是空。
 */
on('GET', '/api/search', (ctx) => {
  const u = requireUser(ctx)
  const q = ctx.url.searchParams.get('q') || ''
  const limit = Math.min(50, Math.max(1, Number(ctx.url.searchParams.get('limit') || 20)))
  return { results: searchAll(u, q, limit, clientIp(ctx.req)) }
})

/** 单实体读取：前端按需拉某一篇文档时用，避免整包 bootstrap */
on('GET', '/api/entity/:name', (ctx) => {
  const u = requireUser(ctx)
  const def = byName.get(ctx.params.name)
  if (!def) { const e: any = new Error('未知实体'); e.status = 404; throw e }
  return { rows: readEntity(u, def, clientIp(ctx.req)) }
})

/* ============================================================
   文档接口
   ============================================================ */

/**
 * 单篇正文：打开文档时按需拉取。
 * 这是让 bootstrap 能保持轻量的另一半 —— 目录树和列表只要元信息，
 * 只有真正打开那篇的人才需要 blocks。
 */
/**
 * 知识库配了 IP 白名单时，非白名单地址一律拒。
 *
 * `ipAllowed` 以前定义了却**从来没被调用过** —— 设置页写着
 * 「仅允许下列 IP 访问本知识库，其余请求将被拒绝」，存了、同步了、
 * 跨设备都显示，实际上任何 IP 都能进。
 */
function requireIpAllowed(bookId: string | null, ctx: any) {
  if (!bookId) return
  const ip = clientIp(ctx.req)
  if (ipAllowed(bookId, ip)) return
  const e: any = new Error(`当前 IP（${ip}）不在该知识库的白名单内，拒绝访问`)
  e.status = 403
  throw e
}

/** 同一个 slug 有好几篇时，这个用户读得到几篇 —— 只为了把话说清楚 */
function capsReadableSlug(u: User, slug: string): number {
  const rows = db.prepare("SELECT id FROM docs WHERE slug = ? AND slug <> ''").all(slug) as Row[]
  return rows.filter((r) => capsOfDoc(u, String(r.id)).read).length
}

on('GET', '/api/doc/:id', (ctx) => {
  const u = requireUser(ctx)
  /**
   * `:id` 既可以是 docId，也可以是「路径」（slug）。
   *
   * 语雀的地址是 `/namespace/book/<slug>`，而我们内部一路用 docId。
   * 只认一个的话，另一个就成了「看得见、点不动」的死地址 ——
   * 而这正是文档设置里那个「路径」输入框以前的状态：
   * 填了、存了、**什么链接都用不上它**。
   *
   * 查不到就 404，**绝不猜**：slug 猜错等于把另一篇文档的内容
   * 发给以为自己在读这一篇的人。
   *
   * ⚠️ 而「绝不猜」以前**没做到**：`ORDER BY id LIMIT 1` 挑的是字典序最小的
   * 那一篇，跟「谁在访问」「访问的是哪个库」毫无关系。slug 唯一性是
   * **按知识库**的，所以同一个 slug 在两个库里各有一篇完全合法。
   * 后果：只属于 A 库的同事访问 A 库那篇的路径会拿到 403，
   * 而真相是「路径有歧义」—— 他会去找管理员要一个自己本来就有的权限。
   * 现在按「他读得到的」收窄；收窄后仍多于一篇就**明说**，不猜。
   */
  const hit = resolveDoc(ctx.params.id, u)
  if (!hit.id && hit.candidates > 1) {
    const e: any = new Error(
      `「${ctx.params.id}」这个路径在 ${hit.candidates} 个知识库里都存在，` +
      `而你能读到其中的 ${capsReadableSlug(u, ctx.params.id)} 篇 —— 路径有歧义，不猜。请用文档 id 打开。`,
    )
    e.status = 409
    throw e
  }
  const docId = hit.id || ctx.params.id
  /*
   * **先判存在，再判权限。**
   *
   * 原来顺序反着：先 `capsOfDoc` 再看有没有这一行。
   * 而 `capsOfDoc` 对一个不存在的 id 会走到「没有知识库归属 → 没有任何能力」，
   * 于是**不存在的文档返回 403**。
   *
   * 后果很具体：别人分享给你一个失效链接，你看到的是「没有阅读该文档的权限」，
   * 而真相是「这篇已经不存在了」—— 你会去找自己要权限，
   * 或者以为链接是内部专用的。实际上根本不用申请任何权限。
   *
   * 反过来「存在但无权」仍然是 403，这个顺序调整不影响它。
   */
  const row = docRow(docId)
  if (!row) { const e: any = new Error('文档不存在'); e.status = 404; throw e }
  // 软删的文稿不该被当成「存在但读不了」，而是「不在了」——
  // 区分开，客户端才能把回收站里的条目正确处理
  if (Number(row.trashed) === 1) { const e: any = new Error('文档已在回收站中'); e.status = 410; throw e }
  const caps = capsOfDoc(u, docId)
  if (!caps.read) { const e: any = new Error('没有阅读该文档的权限'); e.status = 403; throw e }
  requireIpAllowed(bookIdOfDoc(docId), ctx)
  return { doc: toClient(byName.get('docs')!, row), caps, resolvedId: docId }
})

on('GET', '/api/doc/:id/versions', (ctx) => {
  const u = requireUser(ctx)
  if (!capsOfDoc(u, ctx.params.id).read) { const e: any = new Error('没有权限'); e.status = 403; throw e }
  // IP 白名单：这一条返回的是**每一版历史版本的完整内容**，漏判等于白名单失效
  requireIpAllowed(bookIdOfDoc(ctx.params.id), ctx)
  return { versions: (db.prepare('SELECT * FROM doc_versions WHERE docId = ? ORDER BY at DESC LIMIT 100').all(ctx.params.id) as Row[]).map((r) => toClient(byName.get('docVersions')!, r)) }
})

/**
 * 反向链接：哪些文档引用了这一篇。
 *
 * 语雀的「双向引用」里能反向看到的那一半。没有它，一份规范里链出去的
 * 三份文档是一条**单向**的绳 —— 被引用的那篇根本不知道自己被谁依赖，
 * 改了接口没人知道要去同步。
 *
 * **越权过滤不是可选项**：引用方可能在另一个知识库里，也可能用户对它
 * 根本没有读权限。不过滤的话，这个接口等于一张「谁在引用哪些敏感文档」
 * 的名单 —— 标题和 id 全泄漏。所以逐条按**引用方**判读权限。
 */
on('GET', '/api/doc/:id/backlinks', (ctx) => {
  const u = requireUser(ctx)
  if (!capsOfDoc(u, ctx.params.id).read) { const e: any = new Error('没有权限'); e.status = 403; throw e }
  requireIpAllowed(bookIdOfDoc(ctx.params.id), ctx)
  const rows = db.prepare(
    `SELECT d.id, d.title, d.bookId, d.updatedAt, l.at AS linkedAt
       FROM doc_links l JOIN docs d ON d.id = l.sourceDocId
      WHERE l.targetDocId = ? AND COALESCE(d.trashed,0) = 0
      ORDER BY l.at DESC`,
  ).all(ctx.params.id) as Row[]
  const out = rows
    // 引用方自己读不到，就不该出现在名单里
    .filter((r) => capsOfDoc(u, String(r.id)).read)
    .map((r) => ({ id: String(r.id), title: String(r.title || ''), bookId: String(r.bookId || ''), linkedAt: Number(r.linkedAt) || 0 }))
  return { backlinks: out }
})

/** 出链：这篇文档引用了谁 */
on('GET', '/api/doc/:id/links', (ctx) => {
  const u = requireUser(ctx)
  if (!capsOfDoc(u, ctx.params.id).read) { const e: any = new Error('没有权限'); e.status = 403; throw e }
  requireIpAllowed(bookIdOfDoc(ctx.params.id), ctx)
  const rows = db.prepare(
    `SELECT d.id, d.title, d.bookId FROM doc_links l JOIN docs d ON d.id = l.targetDocId
      WHERE l.sourceDocId = ? AND COALESCE(d.trashed,0) = 0`,
  ).all(ctx.params.id) as Row[]
  const out = rows
    .filter((r) => capsOfDoc(u, String(r.id)).read)
    .map((r) => ({ id: String(r.id), title: String(r.title || ''), bookId: String(r.bookId || '') }))
  return { links: out }
})

/**
 * 从回收站恢复。
 * 软删除下正文、版本、评论都还在库里，所以这里只是把标记翻回去。
 * 不做成「客户端把文稿推回来」—— 客户端早就没有那份数据了，
 * 让它回传只会得到一个空壳（这正是之前「恢复」的实际效果）。
 */
on('POST', '/api/doc/:id/restore', (ctx) => {
  const u = requireUser(ctx)
  requireIpAllowed(bookIdOfDoc(ctx.params.id), ctx)
  const r = restoreDoc(u, ctx.params.id)
  if (!r.ok) { const e: any = new Error(r.reason || '恢复失败'); e.status = 400; throw e }
  const row = docRow(ctx.params.id)
  return { ok: true, doc: row ? toClient(byName.get('docs')!, row) : null }
})

/** 彻底删除：真正不可逆，只给知识库管理员 */
on('POST', '/api/doc/:id/purge', (ctx) => {
  const u = requireUser(ctx)
  // 不可逆操作，白名单外的地址更不该能做
  requireIpAllowed(bookIdOfDoc(ctx.params.id), ctx)
  // 标题要**在删之前**取：purgeDoc 之后行就没了
  const title = String(docRow(ctx.params.id)?.title || '')
  const r = purgeDoc(u, ctx.params.id)
  if (!r.ok) { const e: any = new Error(r.reason || '删除失败'); e.status = 403; throw e }
  /**
   * 这一条**以前根本没记**（`AUDIT.trashPurge` 早就定义了、中文名也写了，
   * 但全项目没有任何地方调用它）——
   * 而「清空回收站」记了、同为不可逆的附件删除也记了。
   *
   * 所以在这之前的行为是：**批量清空有迹可查，逐篇永久删除查无此人**。
   * 而永久删除是不可逆的 —— 出了事第一句要问的就是
   * 「谁在什么时候把哪一篇删了」，而那正好是唯一查不到的那种。
   *
   * 标题也进审计：事后要能回答「删掉的到底是什么」，
   * 光有 id 的话还得去翻备份才知道那是哪篇。
   */
  logAudit({
    actorId: u.id, action: AUDIT.trashPurge,
    targetType: 'doc', targetId: ctx.params.id, targetName: title,
  })
  return { ok: true }
})

/* ============================================================
   删除知识库
   ------------------------------------------------------------
   产品现在**完全没有**这个能力：store 里只有 createBook / updateBook，
   服务端没有端点，UI 没有入口（`test-mdimport-e2e` 里就写着这个缺口，
   而且它每跑一次就留下一个清不掉的「导入夹具」库）。

   语义 = **硬删**，跟语雀一致。语雀的回收站只管文档、不管知识库，
   所以「删库」这一步本身没有后悔药。
   所以界面上必须把这句话说死，不能用「已移入回收站」这种含糊说法 ——
   用户照着文案理解自己的数据状态，结论错了比功能缺失更糟。
   ============================================================ */
on('DELETE', '/api/book/:id', (ctx) => {
  const u = requireUser(ctx)
  const bookId = ctx.params.id
  // 不可逆操作，白名单外的地址更不该能做
  requireIpAllowed(bookId, ctx)
  // 名字要在删之前取：deleteBook 之后行就没了
  const name = String((db.prepare('SELECT name FROM books WHERE id = ?').get(bookId) as Row | undefined)?.name || '')
  const r = deleteBook(u, bookId)
  if (!r.ok) {
    const e: any = new Error(r.reason || '删除失败')
    // 有文档删不掉是「中止」，不是「没权限」—— 报 409 并把哪几篇带回去
    e.status = r.failed.length ? 409 : 403
    e.detail = { failed: r.failed }
    throw e
  }
  // 同一批不可逆操作里就它影响最大：出事后第一句要问的是「谁删的哪个库」
  logAudit({
    actorId: u.id, action: AUDIT.bookDelete,
    targetType: 'book', targetId: bookId, targetName: name,
    detail: { purgedDocs: r.purged },
  })
  return { ok: true, purgedDocs: r.purged }
})

/* ============================================================
   单篇文档的外部分享
   ------------------------------------------------------------
   这里要解决的是一个**假承诺**：分享弹窗里一直挂着
   「互联网上获得链接的人可查看」，但这条路上**什么都没有** ——
   所有接口都要求登录，外部的人拿到链接只会看到登录页。
   而管理员点完「保存设置」还会看到一句「权限已更新」。

   也就是说，一个准备对外发布的文档，管理员会**放心地**把链接发出去，
   因为界面明确告诉他已经公开了 —— 然后对方打不开，或者更糟：
   他后来以为「反正链接没人能看」而把内部内容也设成了公开。
   ============================================================ */

/**
 * 访问密码的尝试次数限制。
 *
 * 内存里计数，进程重启就清零 —— 这是**刻意的**：它防的是
 * 「拿到链接的人写个循环穷举 4 位数字」，
 * 那种事一次进程重启就会打断。
 * 真正要长期限流就该落到表里，但为了一个内网部署的知识库，
 * 上那张表只会带来一个「有人忘了清理」的负担。
 */
const shareTries = new Map<string, { n: number; until: number }>()
const SHARE_TRY_LIMIT = 8
const SHARE_TRY_WINDOW_MS = 10 * 60 * 1000

function shareTryKey(docId: string, ip: string) { return `${docId}|${ip}` }

function shareBlocked(docId: string, ip: string): boolean {
  const rec = shareTries.get(shareTryKey(docId, ip))
  if (!rec) return false
  if (Date.now() > rec.until) { shareTries.delete(shareTryKey(docId, ip)); return false }
  return rec.n >= SHARE_TRY_LIMIT
}

function noteShareTry(docId: string, ip: string) {
  const k = shareTryKey(docId, ip)
  const rec = shareTries.get(k)
  if (!rec || Date.now() > rec.until) shareTries.set(k, { n: 1, until: Date.now() + SHARE_TRY_WINDOW_MS })
  else rec.n++
}
const clearShareTries = (docId: string, ip: string) => shareTries.delete(shareTryKey(docId, ip))

/**
 * 匿名读取一篇对外分享的文档。
 *
 * 这个接口**刻意不登录**，所以它返回什么要一个字段一个字段地想：
 *   · 只给标题 + 正文 + 分享设置，**不给**评论、版本、反向链接、
 *     空间成员名单、作者 id —— 那些是内部数据，与「读这一篇」无关。
 *   · 不给 `spaceId` / `bookId` 之外的任何定位信息：拿到一篇文档
 *     不应该顺带得到「同一空间里还有哪些库」。
 *
 * 密码走 **POST 的 JSON body**，不走请求头，也不走 query：
 *   · 请求头是 ByteString，「口令2026」这种中文口令**根本发不出去**
 *     （fetch 直接抛 TypeError，而报错发生在浏览器里，跟知识库毫无关系，
 *       排查起来会以为是服务端挂了）。
 *   · query 会进浏览器历史、进网关访问日志、进 Referer 头。
 */
function readPublicDoc(ctx: Ctx, given: string) {
  /*
   * 分享链接**没有身份**可依据，所以 slug 命中多篇时只能不猜。
   * （旧实现 `ORDER BY id LIMIT 1` 会挑字典序最小的那篇 ——
   *  访客点开一个分享链接，拿到的是另一个知识库里同名路径的文档。
   *  这正是这个函数上面那段注释警告的事，而它自己没做到。）
   */
  const hit = resolveDoc(ctx.params.id, null)
  if (!hit.id && hit.candidates > 1) {
    const e: any = new Error(`「${ctx.params.id}」这个路径在 ${hit.candidates} 个知识库里都存在，无法确定是哪一篇。请用分享链接里的完整地址。`)
    e.status = 404
    throw e
  }
  const docId = hit.id || ''
  if (!docId) { const e: any = new Error('文档不存在'); e.status = 404; throw e }
  const ip = clientIp(ctx.req)
  const gate = publicDocGate(docId, ip)

  // 不存在 / 已在回收站 → 404。告诉外部「这篇删了」等于确认它曾经存在过
  if (!gate.ok && (gate.reason === 'not-found' || gate.reason === 'trashed')) {
    const e: any = new Error(gate.message); e.status = 404; throw e
  }
  if (!gate.ok) { const e: any = new Error(gate.message); e.status = 403; throw e }

  if (gate.needPassword) {
    if (shareBlocked(docId, ip)) {
      const e: any = new Error('密码尝试次数过多，请 10 分钟后再试'); e.status = 429; throw e
    }
    const sh = db.prepare('SELECT passwordHash, passwordSalt FROM doc_share WHERE docId = ?').get(docId) as Row
    if (!given || !verifyPassword(given, String(sh.passwordHash || ''), String(sh.passwordSalt || ''))) {
      noteShareTry(docId, ip)
      const e: any = new Error(given ? '访问密码不对' : '这份文档需要访问密码'); e.status = 401; throw e
    }
    clearShareTries(docId, ip)
  }

  const row = docRow(docId) as Row
  // 分享被打开是要留痕的 —— 「这份对外文档被谁看过」正是访问日志要回答的问题，
  // 而访客没有账号，所以记 IP。进的是 doc_views 那张按天去重的表。
  try {
    const day = new Date().toISOString().slice(0, 10)
    db.prepare(
      'INSERT OR IGNORE INTO doc_views (docId, day, userId, bookId, at) VALUES (?,?,?,?,?)',
    ).run(docId, day, 'public', String(row.bookId || ''), Date.now())
  } catch { /* 记不上不影响阅读 */ }

  const bs = db.prepare('SELECT watermark, watermarkText FROM book_settings WHERE bookId = ?')
    .get(String(row.bookId || '')) as Row | undefined

  return {
    title: String(row.title || ''),
    /** 摘录：分享卡片与外部页上那一行说明。空就是没有，不编 */
    summary: String(row.summary || ''),
    /** 「路径」：外部链接用它，短且可读；没设就退回 docId */
    slug: String(row.slug || ''),
    // blocks 是正文真正的来源（body 是 Markdown 源，渲染认 blocks）
    blocks: parseJson(row.blocks) || [],
    body: String(row.body || ''),
    updatedAt: Number(row.updatedAt) || 0,
    allowDownload: gate.allowDownload,
    /**
     * 水印跟着知识库设置走：对外分享的文档默认该带阅读人痕迹。
     *
     * **访客 IP 一定要带，与有没有自定义文案无关。**
     *
     * 原来是 `watermarkText || \`${ip} · ${日期}\`` ——
     * 管理员**一设自定义文案，访客信息就整个没了**，
     * 分享出去的水印只剩一句「内部资料」，追不到任何人。
     * 而登录态那边（`DocPage`）是 `{文案} · {姓名}（{账号}）`，
     * 一直带着人；同一个开关，两处策略不一致。
     *
     * 那条「|| 兜底」的写法看着像「没文案时也别空着」，
     * 实际效果是「**一有文案就不追人了**」——
     * 恰恰把最该记的情况漏掉。（设置页写着「水印会附加当前阅读人的
     * 姓名与账号」，而匿名访客**原理上就没有**姓名账号，
     * 所以这条承诺在分享页上只能兑现一半：**能兑现的是 IP**。）
     *
     * 带 IP 不泄露什么：访客本就知道自己的 IP，
     * 而这份水印恰恰是给他自己看的线索。
     */
    watermark: bs && Number(bs.watermark) === 1
      ? {
          enabled: true,
          text: `${String(bs.watermarkText || '').trim() || '内部资料'} · ${ip}`,
        }
      : { enabled: false, text: '' },
  }
}

on('GET', '/api/public/doc/:id', (ctx) => readPublicDoc(ctx, ''))

/** 带密码的同一件事。分 POST 是因为口令要进 body（见上面那段说明） */
on('POST', '/api/public/doc/:id', async (ctx) => {
  const b = (await ctx.body()) || {}
  return readPublicDoc(ctx, String(b.password ?? ''))
})

/**
 * 改某个人的**平台角色**（member ⇄ admin）。
 *
 * ============================
 * 为什么单独一个接口，而不在 members 的 writable 里放 role
 * ------------------------------------------------------------
 * 放进去很简单，但那样就多了一条「推任意实体行」的提权路径：
 * 只要拿到 admin，任何人都能靠一次 sync push 把同伙提成 admin。
 * 而 sync push 的粒度是**整张表**，不适合表达
 * 「只有 owner 能改角色、且不能改自己、且不能降掉最后一个 owner」这几条。
 *
 * 更要紧的是那条「不能降掉最后一个 owner」——
 * 一旦降掉，**整个实例就没有人能进设置页了**，只能去删数据库文件重开。
 * 这不是理论风险：角色下拉一不小心点错就够了。
 *
 * 所以：role **不进 writable**，提权只有这一条窄路。
 */
on('POST', '/api/users/:id/role', async (ctx) => {
  const me = requireUser(ctx)
  // 只有 owner 能改角色 —— admin 自己不能再往上抬，也不能把别人抬到和自己一样
  if (me.role !== 'owner') {
    const e: any = new Error('只有平台超级管理员（owner）能改别人的角色')
    e.status = 403
    throw e
  }
  const target = String(ctx.params.id)
  const b = (await ctx.body()) || {}
  const role = String(b.role || '')

  if (role !== 'member' && role !== 'admin') {
    const e: any = new Error('角色只能是 member 或 admin')
    e.status = 400
    throw e
  }
  // 改自己的角色 = 自己把自己降权。可能是手滑，也可能是想「体验一下普通成员」，
  // 但结果都一样：owner 是这个实例唯一的最高权限来源，改掉就可能没人能改回来。
  if (target === me.id) {
    const e: any = new Error('不能改自己的角色 —— 这一层只有一个人有，改了就没人能改回来')
    e.status = 400
    throw e
  }
  const row = db.prepare('SELECT id, name, account, role FROM users WHERE id = ?').get(target) as Row | undefined
  if (!row) { const e: any = new Error('该成员不存在'); e.status = 404; throw e }
  if (String(row.role) === role) {
    return { ok: true, unchanged: true, role, name: String(row.name || '') }
  }

  // 降掉最后一个 owner —— 宁可拒绝，也不能把人锁在门外
  if (String(row.role) === 'owner') {
    const owners = Number((db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner'").get() as Row).n)
    if (owners <= 1) {
      const e: any = new Error('这是最后一个平台超级管理员，不能降级 —— 降掉之后没人能进设置页了')
      e.status = 400
      throw e
    }
  }

  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target)
  logChange('members', target, 'upsert', 0, me.id)
  logAudit({
    actorId: me.id, action: AUDIT.roleChange,
    targetType: 'user', targetId: target, targetName: String(row.name || ''),
    detail: { account: String(row.account || ''), from: String(row.role || ''), to: role },
  })
  return { ok: true, role, name: String(row.name || '') }
})

/**
 * 回收站保留期 —— 界面上那个「还剩 N 天」倒计时要用它。
 *
 * 以前是前端**写死 30 天**算的，而服务端根本没有清除任务。
 * 现在这个数从服务端来：部署时把 YQ_TRASH_DAYS 改成别的值，
 * 界面上的承诺就跟着变，而不是继续说一个不成立的「30 天」。
 */
on('GET', '/api/trash/retention', (ctx) => {
  // 要登录：这是部署侧的保留策略，不是给外部访客看的。
  // 对外分享页另有 `/api/public/doc/:id`，那个才是免鉴权白名单里的。
  requireUser(ctx)
  const days = trashRetentionDays()
  return {
    days,
    note: days > 0
      ? `删除满 ${days} 天后自动永久清除`
      : '本实例未开启自动清除，回收站里的文档会一直保留',
  }
})

/**
 * 把文档移到 / 复制到另一个知识库（语雀的「移动到… / 复制到…」）。
 *
 * 真正的活儿都在 sync.ts 的 moveDoc 里（权限两边都判、两个库的索引都重算、
 * 目录节点跟着换库、复制换新 id）。这里只做参数解析。
 */
on('POST', '/api/doc/:id/move', async (ctx) => {
  const u = requireUser(ctx)
  requireIpAllowed(bookIdOfDoc(ctx.params.id), ctx)
  const b = (await ctx.body()) || {}
  const mode = String(b.mode || 'move') === 'copy' ? 'copy' : 'move'
  const targetBookId = String(b.bookId || '')
  if (!targetBookId) { const e: any = new Error('请选择目标知识库'); e.status = 400; throw e }
  const r = moveDoc(u, ctx.params.id, targetBookId, mode)
  if (!r.ok) { const e: any = new Error(r.reason || '操作失败'); e.status = r.status || 400; throw e }
  return { ok: true, ...r }
})

/**
 * 清空回收站：**真的**把里面每一篇永久删掉。
 *
 * 回收站页原来那个「清空回收站」按钮是这么写的：
 * \`useStore.setState({ trash: [] })\` 加一句 toast。
 * 也就是说 —— 服务端的 \`trash\` 表和 \`docs\` 行**一行都没动**，
 * 刷新一下那些文档就全回来了。而按钮上的确认文案写着
 * 「N 个文档将被**永久删除**，**无法恢复**」。
 *
 * 这是这一类里最糟的一个：它不只没做事，它还**承诺了一件不可逆的事**。
 * 用户照着这句话去理解自己的数据状态，得到的是错的结论。
 *
 * 所以这里逐篇走 \`purgeDoc\` —— 索引、版本、trash 行、changes 记录
 * 都由那一个函数负责，不在这里重写一遍。
 * 逐篇判定权限：清空回收站是**管理员**动作，里面可能有别人删的文档。
 */
on('POST', '/api/trash/purge-all', (ctx) => {
  const u = requireUser(ctx)
  if (u.role !== 'owner' && u.role !== 'admin') {
    const e: any = new Error('只有管理员可以清空回收站（里面可能有别人删的文档）')
    e.status = 403
    throw e
  }
  const rows = db.prepare('SELECT docId FROM trash').all() as Row[]
  const purged: string[] = []
  const failed: { docId: string; reason: string }[] = []
  for (const r of rows) {
    const id = String(r.docId)
    const res = purgeDoc(u, id)
    if (res.ok) purged.push(id)
    else failed.push({ docId: id, reason: res.reason || '没有权限' })
  }
  if (!rows.length) return { ok: true, purged: 0, purgedIds: [] as string[], failed: [] as { docId: string; reason: string }[] }
  logAudit({
    actorId: u.id, action: AUDIT.trashPurgeAll,
    targetType: 'trash', targetId: '',
    detail: { purged: purged.length, failed },
  })
  // **把清掉的 id 也回给客户端**：只回一个数量的话，客户端没法决定
  // 本地该摘掉哪几行 —— 只能全清（那会把没权限的那几篇也从界面上抹掉，
  // 用户以为它们真被删了），或者不清（那这次删除在界面上完全看不出来）。
  return { ok: failed.length === 0, purged: purged.length, purgedIds: purged, failed }
})

/** 读分享设置（要有该文档的「分享」权限） */
on('GET', '/api/doc/:id/share', (ctx) => {
  const u = requireUser(ctx)
  if (!capsOfDoc(u, ctx.params.id).share) { const e: any = new Error('没有管理这篇文档分享设置的权限'); e.status = 403; throw e }
  requireIpAllowed(bookIdOfDoc(ctx.params.id), ctx)
  return { share: shareSettingsOf(ctx.params.id) }
})

/**
 * 设置 / 取消访问密码、有效期、是否允许下载。
 *
 * 密码只存 scrypt 哈希 + 盐，**明文不落库、不进审计** ——
 * 和个人访问令牌同一个道理：这类东西丢了就重设，不需要「找回」。
 * 审计里只记「设了密码 / 取消了密码」和有效期，不记密码本身。
 */
on('POST', '/api/doc/:id/share', async (ctx) => {
  const u = requireUser(ctx)
  if (!capsOfDoc(u, ctx.params.id).share) { const e: any = new Error('没有管理这篇文档分享设置的权限'); e.status = 403; throw e }
  requireIpAllowed(bookIdOfDoc(ctx.params.id), ctx)
  const b = (await ctx.body()) || {}
  const prev = shareSettingsOf(ctx.params.id)
  const now = Date.now()

  // password: null / '' = 取消密码；字符串 = 设置（空字符串视作取消）
  const rawPwd = b.password === undefined ? undefined : (b.password === null ? '' : String(b.password))
  if (rawPwd !== undefined && rawPwd && rawPwd.length < 4) {
    const e: any = new Error('访问密码至少 4 位 —— 太短的话，拿到链接的人穷举几分钟就出来了')
    e.status = 400
    throw e
  }
  const expiresInDays = b.expiresInDays === undefined ? undefined : Number(b.expiresInDays)
  if (expiresInDays !== undefined && (!Number.isFinite(expiresInDays) || expiresInDays < 0 || expiresInDays > 3650)) {
    const e: any = new Error('有效期要在 0（永不过期）到 3650 天之间'); e.status = 400; throw e
  }

  /**
   * 密码的更新是**三态**，不是两态：
   *   · 不传 password          → **保持原样**（局部更新，不是全量覆盖）
   *   · 传 null 或空串          → 取消密码
   *   · 传非空串               → 设置新密码
   *
   * 这一点是实测踩出来的：分享弹窗里「允许下载」那个开关单独发一次
   * `{ allowDownload: false }`，而这里原来把「没传密码」当成「密码置空」——
   * 于是**顺手把作者设好的访问密码清了**。
   *
   * 而且它完全不会报错：开关照样变、有效期照样在、分享照样能打开，
   * 只是密码没了。作者要到「链接打不开了」才发现，而且早就想不通
   * 「我明明设过密码怎么又要输」。这类静默丢失最难自查。
   */
  const cur = db.prepare('SELECT * FROM doc_share WHERE docId = ?').get(ctx.params.id) as Row | undefined
  const keepPwd = rawPwd === undefined
  const hash = keepPwd ? { hash: String(cur?.passwordHash || ''), salt: String(cur?.passwordSalt || '') }
    : rawPwd ? hashPassword(rawPwd) : { hash: '', salt: '' }

  const expiresAt = expiresInDays === undefined
    ? Number(cur?.expiresAt || 0)
    : (expiresInDays > 0 ? now + expiresInDays * 86400000 : 0)
  /**
   * `prev.allowDownload` 是布尔，而 `node:sqlite` **只接受** null/number/string/bigint/Uint8Array。
   * 直接把布尔绑上去会报「Provided value cannot be bound to SQLite parameter N」，
   * 而且报错说的是参数**序号**不是列名 —— 排查时会以为是别的地方写错了。
   * 所以这里统一收成 0/1。
   */
  const allowDownload = b.allowDownload === undefined
    ? (prev.allowDownload ? 1 : 0)
    : (b.allowDownload === true ? 1 : 0)

  const curRow = db.prepare('SELECT * FROM doc_share WHERE docId = ?').get(ctx.params.id) as Row | undefined
  const rev = Number(curRow?.rev ?? 0) + 1
  if (curRow) {
    db.prepare('UPDATE doc_share SET passwordHash = ?, passwordSalt = ?, expiresAt = ?, allowDownload = ?, updatedAt = ?, updatedBy = ?, rev = ? WHERE docId = ?')
      .run(hash.hash || '', hash.salt || '', expiresAt, allowDownload, now, u.id, rev, ctx.params.id)
  } else {
    db.prepare('INSERT INTO doc_share (docId, passwordHash, passwordSalt, expiresAt, allowDownload, updatedAt, updatedBy, rev) VALUES (?,?,?,?,?,?,?,?)')
      .run(ctx.params.id, hash.hash || '', hash.salt || '', expiresAt, allowDownload, now, u.id, rev)
  }
  logChange('docShare', ctx.params.id, 'upsert', rev, u.id)

  logAudit({
    actorId: u.id, action: AUDIT.docShare,
    targetType: 'doc', targetId: ctx.params.id,
    targetName: String(docRow(ctx.params.id)?.title || ''),
    // 明文绝不入审计 —— 只记「从有变成无」这类状态变化
    detail: {
      passwordSet: !!hash.hash,
      passwordCleared: prev.hasPassword && !hash.hash,
      expiresAt,
      allowDownload: allowDownload === 1,
    },
  })

  return { ok: true, share: shareSettingsOf(ctx.params.id) }
})

/** 读出分享设置的对外形状（**永远不含**密码哈希） */
function shareSettingsOf(docId: string) {
  const r = db.prepare('SELECT passwordHash, expiresAt, allowDownload, updatedAt FROM doc_share WHERE docId = ?').get(docId) as Row | undefined
  const expiresAt = Number(r?.expiresAt || 0)
  return {
    hasPassword: !!String(r?.passwordHash || ''),
    expiresAt,
    expired: expiresAt > 0 && expiresAt < Date.now(),
    allowDownload: r ? Number(r.allowDownload) === 1 : true,
    updatedAt: Number(r?.updatedAt || 0),
  }
}

/* ============================================================
   权限查询
   前端要按权限决定「新建按钮灰不灰」「能不能分享」，
   判据必须来自服务端，不能让前端自己算一套。
   ============================================================ */

on('GET', '/api/perms/book/:id', (ctx) => {
  const u = requireUser(ctx)
  /*
   * IP 白名单在这里也要判一次。
   *
   * 能力面板的作用是「告诉他在这个库里能做什么」，而白名单开着、
   * 当前 IP 不在名单里时，他**实际上什么都做不了** ——
   * 面板却报 `read/edit/create/…` 全 true。
   * 于是界面上「编辑」亮着、点进去报 403，
   * 用户看到的是「按钮坏了」而不是「你的 IP 没在白名单里」。
   *
   * 抛 403 而不是回一组全 false：
   *   全 false 会被界面读成「你没权限」，而这不是权限问题；
   *   403 带上 IP 和库名，才对得上设置页写的那句话。
   */
  requireIpAllowed(ctx.params.id, ctx)
  return { caps: capsInBook(u, ctx.params.id) }
})

/**
 * 空间级的能力。
 *
 * ⚠️ 为什么必须有这一条（2026-10-12 补）：前端要判「这个人能不能在这个空间里
 * **建知识库**」，而建库的判据是 `capsInSpace(sid).admin` —— 那是**空间**的能力。
 * 但当时只有 `/api/perms/book/:id` 一个接口，于是前端只能拿**空间 id** 去问它。
 *
 * 后果不是报错，是**全 false**：`capsInBook(u, <空间id>)` 里
 * `spaceIdOfBook(空间id)` 查不到、`book_members` 也没有这一行 → 返回零能力。
 * 界面上「新建知识库」于是对**空间管理员**消失了 ——
 * 而服务端 `denyReason` 明明放他过（「你不是空间管理员」那条不会拦他）。
 *
 * 方向和 IP 白名单那条一样：**全 false 会被界面读成「你没权限」**，
 * 而真相是「我问错了对象」。所以这里给空间一份真的。
 */
on('GET', '/api/perms/space/:id', (ctx) => {
  const u = requireUser(ctx)
  return { caps: capsInSpace(u, ctx.params.id) }
})

on('GET', '/api/perms/doc/:id', (ctx) => {
  const u = requireUser(ctx)
  /*
   * **先判存在**（和 `/api/doc/:id` 同一个顺序调整）。
   *
   * 原来直接返回 `capsOfDoc(...)`，而一篇**不存在**的文档会走到
   * 「没有知识库归属 → 没有任何能力」→ 返回一组全 false。
   * 界面上那正是「你没权限」的样子，而真相是「这篇不存在」——
   * 别人分享给你一个失效链接，你会去找自己要权限，
   * 或者以为链接是内部专用的。**其实根本不用申请任何权限。**
   */
  const row = docRow(ctx.params.id)
  if (!row) { const e: any = new Error('文档不存在'); e.status = 404; throw e }
  if (Number(row.trashed) === 1) { const e: any = new Error('文档已在回收站中'); e.status = 410; throw e }
  // 与 `/api/perms/book/:id` 同一个理由：它回答的是「你能做什么」，
  // 报一组全 false 会被界面读成「你没权限」，而白名单是网络来源问题
  requireIpAllowed(bookIdOfDoc(ctx.params.id), ctx)
  return { caps: capsOfDoc(u, ctx.params.id) }
})

/* ============================================================
   附件
   二进制走独立通道：BLOB 直接进 SQLite。
   知识库附件量级（几十 MB 到几百 MB）对 SQLite 完全够用，
   省掉一个对象存储的部署项，内网运维会轻松很多。
   ============================================================ */

on('POST', '/api/attachment', async (ctx) => {
  const u = requireUser(ctx)
  const docId = String(ctx.url.searchParams.get('docId') || '')
  /**
   * **必须挂在某篇文档上。**
   *
   * 原来 docId 可以为空，而两端的权限判定都写成
   * \`if (docId && !capsOfDoc(...))\` —— 也就是「没有 docId 就**不判权限**」。
   * 于是任何登录用户都能传一个「不挂文档」的附件，
   * 而任何登录用户（哪怕对相关文档毫无权限）都能下载它。
   * 这在内网知识库里是一条实打实的外泄路径。
   *
   * 而且这类附件**永远不会被回收**：清理是按 docId 做的（见 purgeDocCore），
   * 没有 docId 就谁也带不走它。
   *
   * 客户端一直是带 docId 的（见 src/lib/api.ts 的 uploadAttachment），
   * 所以这条约束对现有用法零影响 —— 它挡住的是构造出来的 API 调用。
   */
  if (!docId) {
    const e: any = new Error('附件必须挂在某篇文档上（没有归属文档就无法判断谁有权看它）')
    e.status = 400
    throw e
  }
  if (!docRow(docId)) { const e: any = new Error('文档不存在'); e.status = 404; throw e }
  if (!capsOfDoc(u, docId).edit) { const e: any = new Error('没有上传权限'); e.status = 403; throw e }
  // 附件通道也要判 IP 白名单（见下面 GET 那段的理由）
  requireIpAllowed(bookIdOfDoc(docId), ctx)

  const chunks: Buffer[] = []
  let size = 0
  for await (const c of ctx.req) {
    size += c.length
    if (size > 64 * 1024 * 1024) { const e: any = new Error('附件超过 64MB'); e.status = 413; throw e }
    chunks.push(c as Buffer)
  }
  const buf = Buffer.concat(chunks)
  // 文件名放在 x-filename 头（URL 编码），中文才不会乱码
  const rawName = String(ctx.req.headers['x-filename'] || 'file')
  const filename = decodeURIComponent(Buffer.from(rawName, 'latin1').toString('utf8'))
  const id = `att_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const mime = String(ctx.req.headers['content-type'] || 'application/octet-stream')
  db.prepare('INSERT INTO attachments (id,docId,blockId,filename,mime,size,data,createdAt) VALUES (?,?,?,?,?,?,?,?)')
    .run(id, docId || null, String(ctx.url.searchParams.get('blockId') || '') || null, filename, mime, buf.length, buf, Date.now())
  return { id, name: filename, size: buf.length, mime }
})

/**
 * 只问「还在不在」，不取正文。
 *
 * 客户端用它来决定一张附件卡片该不该说「已丢失」：
 * 服务端形态下 `attachmentUrl(key)` 永远拼得出来，
 * 所以「地址存在」**说明不了文件存在** —— 附件被删掉之后，
 * 卡片照样显示「⬇ 下载」，点了才 404。
 *
 * 单独注册 HEAD 而不是让 GET 兼管：附件动辄几百 MB，
 * 用 GET 探测等于为了看一眼把整个文件下一遍。
 * 权限判定与 GET **完全一致** —— 这里只改响应体，不改谁能看。
 */
on('HEAD', '/api/attachment/:id', (ctx) => {
  const u = requireUser(ctx)
  const row = db.prepare('SELECT id,docId,filename,mime,size FROM attachments WHERE id = ?').get(ctx.params.id) as Row | undefined
  if (!row) { const e: any = new Error('附件不存在'); e.status = 404; throw e }
  if (!row.docId) {
    const e: any = new Error('这个附件没有关联文档，无法判断谁有权查看它')
    e.status = 403
    throw e
  }
  if (!capsOfDoc(u, String(row.docId)).read) { const e: any = new Error('没有权限'); e.status = 403; throw e }
  /*
   * IP 白名单 —— 附件通道以前**只判文档权限**。
   *
   * 实测（探针，2026-10-06）：同一个 IP，`/api/doc/:id` 和
   * `/api/perms/book/:id` 都是 403「当前 IP 不在该知识库的白名单内」，
   * 而 `GET /api/attachment/:id` **200，把文件原样发了过来**。
   * HEAD 也 200（等于确认了文件存在），DELETE 还 200 —— 附件真的被删掉了。
   *
   * 这比前几处更糟，原因是**它制造了一种虚假的安全感**：
   * 管理员看到「打开单篇被挡住了」，自然会认为整个库都挡住了，
   * 而附件恰恰是公司最在意的那些文件（客户名单、预算表、合同扫描件）。
   *
   * 同一个家族的前三处：`/api/export`（7.29）、`/api/sync/changes`（7.31）、
   * WebSocket 协作房间（7.31）。每处的形态都一样 ——
   * **这条通路压根不经过上一条的判据**。
   */
  requireIpAllowed(bookIdOfDoc(String(row.docId)), ctx)
  /*
   * Content-Length 用 `size` 列，**不要 `Buffer.from(row.data)`**。
   * HEAD 的意义就是不取正文；那一版顺手写了 Buffer.from(row.data)，
   * 而 SELECT 里并没有 data 列 —— `Buffer.from(undefined)` 直接抛，
   * 于是探测请求一律 500。两边都测了才看出来：只读代码是看不出来的。
   */
  ctx.res.writeHead(200, {
    'Content-Type': String(row.mime || 'application/octet-stream'),
    'Content-Length': Number(row.size || 0),
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(String(row.filename))}`,
  })
  ctx.res.end()
  return undefined
})

on('GET', '/api/attachment/:id', (ctx) => {
  const u = requireUser(ctx)
  const row = db.prepare('SELECT * FROM attachments WHERE id = ?').get(ctx.params.id) as Row | undefined
  if (!row) { const e: any = new Error('附件不存在'); e.status = 404; throw e }
  /**
   * 没有归属文档的附件：**拒绝**，而不是放行。
   *
   * 原来的判断是 \`if (row.docId && !capsOfDoc(...))\`，
   * docId 为空时整条判定被跳过 → 任何登录用户都能下载。
   *
   * 现在上传端已经不许再产生这种附件（见上面那个 POST），
   * 所以这一条是给**历史数据**兜底的：万一库里已经有无主的附件，
   * 它不能变成一个「谁都能下」的后门。宁可打不开，也不能默认放行。
   */
  if (!row.docId) {
    const e: any = new Error('这个附件没有关联文档，无法判断谁有权查看它')
    e.status = 403
    throw e
  }
  if (!capsOfDoc(u, String(row.docId)).read) { const e: any = new Error('没有权限'); e.status = 403; throw e }
  // 与 GET 完全一致：同一条通路上的每个入口都得自己判一次
  requireIpAllowed(bookIdOfDoc(String(row.docId)), ctx)
  const data = Buffer.from(row.data as Uint8Array)
  ctx.res.writeHead(200, {
    'Content-Type': String(row.mime || 'application/octet-stream'),
    'Content-Length': data.length,
    // 附件名可能是中文，要显式编码，否则浏览器会当成 latin1
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(String(row.filename))}`,
  })
  ctx.res.end(data)
  return undefined
})

/**
 * 删一个附件。
 *
 * ============================================================
 * 为什么必须有这条
 * ------------------------------------------------------------
 * 以前只有 POST 和 GET，**没有删除**。而客户端卡片上的「删除」按钮
 * 走的是 `releaseAttachment` → `deleteAttachment(key)`，也就是
 * **删本机 IndexedDB 里的那一份**。在服务端模式下 key 是附件 id，
 * 二进制在 SQLite 里 —— 这次删除什么也没删到。
 *
 * 后果不是「有垃圾」，而是「**误传的敏感文件删不掉**」：
 * 卡片从正文里消失了（用户以为删掉了），二进制还躺在库里，
 * 任何有该文档读权限的人拿到 id 仍能下走 `/api/attachment/<id>`，
 * 而且它只会在**整篇文档被永久删除**时才跟着消失。
 * 对一个要部署到内网当公司知识库的系统，这是事故级的。
 *
 * 判权跟上传对齐：能往这篇文档里塞东西的人（edit）才能把它拿走。
 * 用 read 是不够的 —— 只读的人不该能删别人的附件。
 *
 * 判权按**发起删除的那篇文档**（`?docId=`）而不是 `attachments.docId`：
 * 用户是在那篇文档里撤掉自己的引用，凭什么要对他没有 edit 的
 * 另一个库拥有权限。复制出来的副本就是这么个情况。
 *
 * ============================================================
 * 「删除」其实是两件事，混在一起就会出事
 * ------------------------------------------------------------
 * ① 撤掉**这一篇**对它的引用（用户点的就是这个）
 * ② 把**二进制**删掉（只有没有别人引用时才该做）
 *
 * 原来只有 ②，于是 ① 在副本里做、后果落在原件上。
 * 现在服务端按真实引用数决定：没有别人引用就真删，
 * 有就只撤引用并如实告诉用户「这份文件还被 N 篇文档引用，已保留」——
 * 那不是失败，是正确的共享语义，不该弹红色错误。
 */
on('DELETE', '/api/attachment/:id', (ctx) => {
  const u = requireUser(ctx)
  const row = db.prepare('SELECT id,docId,filename,size FROM attachments WHERE id = ?').get(ctx.params.id) as Row | undefined
  if (!row) { const e: any = new Error('附件不存在'); e.status = 404; throw e }

  const fromDocId = String(ctx.url.searchParams.get('docId') || '')
  /*
   * 判权用哪篇文档：
   *   · 传了 docId → 用户是在撤**那篇**文档里的引用，判它的 edit
   *   · 没传 → 只能退回附件自己的归属（老客户端 / 手工调用）
   */
  const permDocId = fromDocId || String(row.docId || '')
  if (!permDocId) {
    /*
     * 无主附件**连管理员也删不掉**，理由和下载端一样：判不出归属就判不出权限。
     * 这里看起来别扭（管理员明明是库里最大的人），但它是有意的：
     * 谁能删一条「不知道属于谁」的记录，等于谁能删任意一条记录 ——
     * 归属缺失时这个判断没有可靠的依据。宁可让它留在库里等人查，
     * 也不要开一个「无主即无限制」的删除口。
     */
    const e: any = new Error('这个附件没有关联文档，无法判断谁有权删除它')
    e.status = 403
    throw e
  }
  if (!capsOfDoc(u, permDocId).edit) { const e: any = new Error('没有删除权限'); e.status = 403; throw e }
  // 删除同样要判 IP：白名单挡住的地址不该能删掉库里的文件（实测修之前真的能删）
  requireIpAllowed(bookIdOfDoc(permDocId), ctx)

  const others = docsReferencing(String(row.id)).filter((id) => id !== fromDocId)

  if (others.length) {
    /*
     * 还有别的文档在用它。
     *
     * 传了 docId（正常路径，用户只是在副本里撤自己的引用）：
     *   把文件留下并如实说明。**这不是失败** —— 弹一个红色错误会让用户
     *   以为卡片没删掉，于是反复点，而文件其实谁也删不了。
     *
     * 没传 docId（手工调用 / 老客户端）：没法知道用户想撤哪一篇的引用，
     *   而无条件删正是要防的那种事故，所以**明确拒掉**并说清差在哪。
     */
    if (!fromDocId) {
      const e: any = new Error(
        `这份文件还被 ${others.length} 篇文档引用着（${others.slice(0, 3).join('、')}${others.length > 3 ? '…' : ''}），`
        + '不能直接删。请到引用它的文档里，从附件卡片上删除。',
      )
      e.status = 409
      throw e
    }
    logAudit({
      actorId: u.id,
      action: AUDIT.attachmentDetach,
      targetType: 'attachment',
      targetId: String(row.id),
      targetName: String(row.filename || ''),
      detail: { from: fromDocId, keptFor: others },
    })
    return {
      ok: true,
      id: String(row.id),
      /** 二进制**没有**被删：还有别的文档在用 */
      deleted: false,
      keptFor: others.length,
      notice: `这份文件还被 ${others.length} 篇文档引用，已保留文件（只撤掉了本文档里的引用）`,
    }
  }

  db.prepare('DELETE FROM attachments WHERE id = ?').run(ctx.params.id)
  logAudit({
    actorId: u.id,
    action: AUDIT.attachmentDelete,
    targetType: 'attachment',
    targetId: String(row.id),
    // 名字和大小进审计：事后要能回答「删掉的到底是什么」
    targetName: String(row.filename || ''),
    detail: { docId: permDocId, size: Number(row.size || 0) },
  })
  return { ok: true, id: String(row.id), deleted: true, keptFor: 0 }
})

/**
 * 导出整个工作台。
 * 走服务端而不是客户端打包 —— 客户端只有元信息，打出来的包是空壳。
 */
on('GET', '/api/export', (ctx) => {
  const u = requireUser(ctx)
  /**
   * 「禁止导出」开关以前没人查 —— 这里开始才真的执行。
   *
   * 判断是**逐个知识库**的：只要有一个用户可读的知识库开了限制，
   * 整包导出就必须拒。不能只看「这个用户有没有 export 权限」，
   * 因为开关是挂在库上的。
   *
   * 这里直接查全部知识库再按 capsInBook 判可读，而不是用 readEntity ——
   * 后者的过滤口径和权限判定不是一回事，会漏掉「靠 book_members
   * 才可见、但不在空间成员名册里」的书，于是限制静默失效。
   */
  const allBooks = db.prepare('SELECT id FROM books').all() as Row[]
  /*
   * ⚠️ 以前这里是 `requireIpAllowed(restricted[0] || null, ctx)` ——
   * 而 `restricted` 是「开了**禁止导出**的库」。只要**没有库开禁止导出**
   * （默认状态），它就是空数组 → 传 `null` → `requireIpAllowed` 第一行
   * `if (!bookId) return` 直接放行。
   *
   * 也就是说：**IP 白名单要等「禁止导出」也被打开才生效**。
   * 而这两个开关没有任何依赖关系，管理员单独开 IP 白名单是完全合法的用法。
   *
   * 实测（探针，2026-10-05）：白名单开着、当前 IP 不在名单里，
   * `/api/export` 照样 200，把整个工作台导走了。
   *
   * 现在 IP 白名单**独立判定**，遍历的是「我能读的全部知识库」，
   * 和有没有开禁止导出无关。
   */
  const readable = allBooks.map((b) => String(b.id)).filter((bid) => capsInBook(u, bid).read)
  const ipBlocked = readable.filter((bid) => !ipAllowed(bid, clientIp(ctx.req)))
  if (ipBlocked.length) {
    const e: any = new Error(
      `当前 IP（${clientIp(ctx.req)}）不在 ${ipBlocked.length} 个知识库的白名单内，无法导出整个工作台。请联系管理员把你的地址加进白名单。`,
    )
    e.status = 403
    throw e
  }

  const restricted = readable.filter((bid) => !exportAllowed(bid, u))
  if (restricted.length) {
    const e: any = new Error(
      `有 ${restricted.length} 个知识库开启了「禁止导出」，无法导出整个工作台。请到具体知识库里单独导出，或联系管理员关闭该限制。`,
    )
    e.status = 403
    throw e
  }
  const bundle = exportBundle(u)
  const s = JSON.stringify(bundle, null, 2)
  const name = `yuque-workspace-${new Date().toISOString().slice(0, 10)}.json`
  // 数据整体出了系统，这条必须留痕：出了事第一句要问的是「谁导的、什么时候」
  logAudit({
    actorId: u.id, action: AUDIT.export,
    targetType: 'workspace', targetId: u.id,
    detail: { bytes: Buffer.byteLength(s), books: bundle.data?.books?.length ?? 0, docs: Object.keys(bundle.data?.docs || {}).length },
  })
  ctx.res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  })
  ctx.res.end(s)
  return undefined
})

/* ============================================================
   阅读统计
   ============================================================ */

/** 本地日期（YYYY-MM-DD）。按天聚合，不引时区库 —— 内网部署都在同一时区 */
const localDay = (t = Date.now()) => {
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 记一次阅读。
 *
 * 必须走服务端、并且在权限判定之后 —— 否则「无权访问的人刷接口」也能
 * 把别人的文档访问量顶上去。同一人同一天同一篇只记一次（主键去重），
 * 所以「浏览量」不会被刷新页面灌水。
 */
on('POST', '/api/doc/:id/view', (ctx) => {
  const u = requireUser(ctx)
  const docId = ctx.params.id
  if (!capsOfDoc(u, docId).read) { const e: any = new Error('没有阅读该文档的权限'); e.status = 403; throw e }
  requireIpAllowed(bookIdOfDoc(docId), ctx)
  const bookId = bookIdOfDoc(docId)
  if (!bookId) return { ok: true }
  const row = docRow(docId)
  if (!row || Number(row.trashed) === 1) return { ok: true }
  db.prepare(`INSERT OR IGNORE INTO doc_views (docId, day, userId, bookId, at) VALUES (?,?,?,?,?)`)
    .run(docId, localDay(), u.id, bookId, Date.now())
  return { ok: true }
})

/**
 * 知识库的阅读统计（真数据）。
 *
 * 「访问者」按人去重、「浏览量」按 (文档, 天, 人) 计数，
 * 近 14 天趋势是真实的每日条数。没有记录时返回 0 —— 那才是诚实的答案，
 * 总比一个随机数生成的柱状图强。
 */
on('GET', '/api/book/:id/stats', (ctx) => {
  const u = requireUser(ctx)
  const bookId = ctx.params.id
  if (!capsInBook(u, bookId).read) { const e: any = new Error('没有阅读该知识库的权限'); e.status = 403; throw e }
  /*
   * IP 白名单 —— **这里原来漏了**，7.29 那次修复把列表 / 搜索 / 导出 /
   * 能力面板都接上了，独独漏了这里。
   *
   * 漏掉的后果比文档正文更敏感：这份接口返回的是 `doc_views`
   * 汇总的 14 天曲线，也就是**谁在哪天看了哪一篇**。
   * 而白名单开着、当前 IP 不在里面时：
   *   · 文稿列表   → 0 行（被过滤）
   *   · 单篇文档   → 403
   *   · 能力面板   → 403
   *   · **书级访问统计 → 照样 200 返回** ← 漏网的那一条
   *
   * 这正是 7.23 记的那条老毛病的又一次：一个判据散在多处，
   * 补的时候漏了一处，而**漏掉的那处没有任何东西会告诉你**。
   * （`test-trustproxy` / `test:trustedproxy` 当时也只覆盖了
   *   已接上的那几条，没覆盖这条。）
   */
  requireIpAllowed(bookId, ctx)
  const days: { day: string; value: number }[] = []
  const today = new Date()
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000)
    days.push({ day: localDay(d.getTime()), value: 0 })
  }
  const from = days[0].day
  const rows = db.prepare('SELECT day, userId FROM doc_views WHERE bookId = ? AND day >= ?')
    .all(bookId, from) as Row[]
  const byDay = new Map<string, number>()
  const visitors = new Set<string>()
  for (const r of rows) {
    byDay.set(String(r.day), (byDay.get(String(r.day)) || 0) + 1)
    visitors.add(String(r.userId))
  }
  for (const d of days) d.value = byDay.get(d.day) || 0
  const total = Number((db.prepare('SELECT COUNT(*) AS n FROM doc_views WHERE bookId = ?').get(bookId) as Row).n)
  const allVisitors = Number((db.prepare('SELECT COUNT(DISTINCT userId) AS n FROM doc_views WHERE bookId = ?').get(bookId) as Row).n)
  return { visitors: allVisitors, views: total, days }
})

/* ============================================================
   成员离职
   ------------------------------------------------------------
   知识库设置里的「离职权限自动回收」以前是**只存不执行**的开关。
   真正要解决的是一件很具体的事：同事离职后，他的账号还能登进来、
   还能翻公司文档 —— 而且没有任何人会去一个个知识库里手动移除。

   所以这里做成一个**管理员动作**而不是一个自动钩子：
   「自动」的触发点（HR 系统、离职流程）各家不一样，
   与其猜一个猜错的自动化，不如给一个可靠的手动动作 ——
   人会忘，但点了就一定生效，而且能立刻验证。
   ============================================================ */

on('POST', '/api/users/:id/offboard', (ctx) => {
  const me = requireUser(ctx)
  if (me.role !== 'owner' && me.role !== 'admin') {
    const e: any = new Error('只有管理员可以办理离职'); e.status = 403; throw e
  }
  const target = String(ctx.params.id)
  if (target === me.id) { const e: any = new Error('不能把自己设为离职'); e.status = 400; throw e }
  const row = db.prepare('SELECT id, name, account, role FROM users WHERE id = ?').get(target) as Row | undefined
  if (!row) { const e: any = new Error('该成员不存在'); e.status = 404; throw e }
  if (String(row.role) === 'owner') { const e: any = new Error('不能对平台超级管理员办理离职'); e.status = 403; throw e }

  // 1. 会话全清：不等他自己点退出，下次请求就 401
  const sessions = db.prepare('DELETE FROM sessions WHERE userId = ?').run(target).changes

  /**
   * 1a. **降权** —— 原来没有这一步，于是离职的管理员离职后**仍然是管理员**。
   *
   * 实测（2026-10-05，探针）：造一个 `role=admin` 的账号 → 办离职 → 重新登录 →
   *   · 读成员名册 200（7 个人）
   *   · 推 `members` 行 → **applied**（`denyReason` 对 members 只判 `user.role !== 'admin'`）
   *   · 给别人办离职 → **200**
   *
   * 也就是说：**一个已经离职的人，还能管理平台。**
   *
   * 根因是四步里「降 role」被漏掉了，而平台层的能力判据**只看 role**。
   * 改知识库成员那条还能挡住（它走 `capsInBook` 要求是该库管理员），
   * 而平台层的 `members` 判据一行 role 就放行了。
   *
   * **为什么降成 `member` 而不是「删掉账号」**：
   * 他的文档、评论、审计记录都以 `userId` 关联，删账号会留下
   * 一堆指向不存在用户的行（和 7.8 那一节同一类问题）。
   *
   * **原 role 必须记进审计** —— 不记的话，离职之后就再也查不出
   * 「他当初是不是管理员」了，而那正是出事之后要问的第一个问题。
   *
   * ⚠️ 降权**不等于停用账号**：降完之后他**仍然能登录**，
   * 只是不再是管理员、也不再是任何空间的成员（个人空间的名册行也被第 3 步删了）。
   * 真正的「停用账号」需要 `users.disabled` 字段 + 登录时拒绝，
   * 那是**新功能**，不夹在这次修复里做 —— 见 README 已知边界。
   */
  const roleBefore = String(row.role || 'member')
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run('member', target)

  /**
   * 1b. 访问令牌全撤。
   *
   * 这一条是后来补的，因为它不在「登录状态」里：会话清了人就被踢下线了，
   * 界面上也看得到（登录页），很容易以为「离职处理完了」。
   * 但令牌不需要会话 —— 它拿着就能直接调 /api/v2 读文档。
   * 于是会出现最难查的那种状态：**人已经离职、网页进不去了，
   * 而 CI / 外部系统还在照常读他的文档**，而所有界面看上去都正常。
   *
   * 双保险还有一层：撤了之后即使有残留，space_members / book_members
   * 也已经清空，权限矩阵本身就不会给他任何读权限。
   */
  const tokens = revokeAllApiTokens(target)

  // 2. 移出所有空间
  const spaces = db.prepare('DELETE FROM space_members WHERE userId = ?').run(target).changes

  /**
   * 3. 知识库：按**每个库自己的开关**决定要不要收。
   *    autoRevoke=1 → 收回；=0 → 保留
   *    「保留」是有意义的：有人离职了但这个库的权限暂时不能收
   *    （比如交接期、外包只做这一个库），管理员可以按库逐个决定。
   *
   * ⚠️⚠️ **`COALESCE(bs.autoRevoke, 1)` 不是可有可无的防御性写法，是修一个真缺陷。**
   *
   * `book_settings` 的一行**只有 `seed.ts` 会铺**。而知识库绝大多数是
   * **用户在界面上新建的** —— `createBook` 只建了 `books` 与 `book_members`，
   * 不建设置行。于是新库在这条 LEFT JOIN 上出来的是 `NULL`，
   * `Number(null) === 1` 为假 → **一个都不收**。
   *
   * 实测（探针，2026-10-12，真服务端）：UI 新建的库 + 加了成员 + **一个字设置都没碰**
   * → 库里没有这一行 → `revokedBooks=0, keptBooks=1` → 离职的人**权限原封不动**；
   * 而界面上那个开关显示的是 `autoRevoke: true`（客户端默认值）。
   *
   * 也就是说：**界面写着「离职权限自动回收」已开启，实际一个人都没收回。**
   *
   * 方向也说明为什么必须这么修：缺行时**其余五个开关的缺省方向都是安全的**
   * （publicAccess 缺行 = 不公开；ipWhitelist 缺行 = 没配名单 = 放行；
   *  restrictExport / watermark / blockSearch 缺行 = 没开），
   * 只有 `autoRevoke` 的缺省值是**开**，而缺行被读成了**关** ——
   * 全项目唯一一处「缺行 = 放过」，还正好是安全向的那一个。
   *
   * 所以判据是：**这一列的缺省值就是 1**（`db.ts` 的列定义、
   * `defaultBookSettings()`、界面默认值三处都是开），
   * 缺行只是「还没读出来」，不能当成「管理员特意关了」。
   */
  const inBooks = db.prepare('SELECT bm.bookId, COALESCE(bs.autoRevoke, 1) AS autoRevoke FROM book_members bm LEFT JOIN book_settings bs ON bs.bookId = bm.bookId WHERE bm.userId = ?')
    .all(target) as Row[]
  const revoked: string[] = []
  const kept: string[] = []
  for (const b of inBooks) {
    const bid = String(b.bookId)
    if (Number(b.autoRevoke) === 1) {
      db.prepare('DELETE FROM book_members WHERE bookId = ? AND userId = ?').run(bid, target)
      revoked.push(bid)
    } else {
      kept.push(bid)
    }
  }

  logAudit({
    actorId: me.id, action: AUDIT.offboard,
    targetType: 'user', targetId: target, targetName: String(row.name || ''),
    // roleBefore 不记的话，离职之后就查不出「他当初是不是管理员」了 ——
    // 而那正是出事之后要问的第一个问题。
    detail: { account: row.account, roleBefore, roleAfter: 'member', sessions: Number(sessions), spaces: Number(spaces), tokens: Number(tokens), revoked, kept },
  })

  return {
    ok: true,
    account: row.account,
    name: row.name,
    sessions: Number(sessions),
    spaces: Number(spaces),
    tokens: Number(tokens),
    revokedBooks: revoked.length,
    keptBooks: kept.length,
    // kept 里若是 0，说明每个开了开关的库都收了；否则要提醒管理员逐个确认
    keptBookIds: kept,
    // 降权前后的 role 一起返回：界面上要能说清「他原本是管理员，已降为成员」，
    // 否则管理员只看到「办理成功」，不知道系统替他把权限改了。
    roleBefore,
    roleAfter: 'member',
    // ⚠️ 账号**没有**被停用 —— 他仍然能重新登录（只是不再是管理员、也不再是任何空间的成员）。
    // 真正的停用需要 `users.disabled`，那是新功能，见 README 已知边界。
    accountDisabled: false,
  }
})

/**
 * 读操作日志。
 *
 * **只给平台管理员。** 日志里能看到「谁给谁开了权限」「谁导出了整个工作台」，
 * 这本身就是敏感信息 —— 普通成员拿到它等于拿到一份权限地图。
 */
/**
 * 我的安全记录（语雀的「帐户安全 → 安全记录」）。
 *
 * 和 `/api/audit` 的区别只有一处，但那一处就是全部：
 * **这里只认「我就是当事人」的那几类安全动作**（改密码 / 建令牌 / 撤令牌），
 * 而不是给我看整个日志 —— 后者对普通成员等于发一份权限地图。
 *
 * ⚠️ `actorId` **不读 query**。只要它接受 `?actorId=别人`，
 * 一个普通成员就能读到任意人的日志，管理员那道闸门等于白设。
 * 参数里只认 `limit`。
 */
on('GET', '/api/auth/security-log', (ctx) => {
  const me = requireUser(ctx)
  return { items: readMySecurityLog(me.id, Number(ctx.url.searchParams.get('limit') || 50)) }
})

on('GET', '/api/audit', (ctx) => {
  const me = requireUser(ctx)
  if (me.role !== 'owner' && me.role !== 'admin') {
    const e: any = new Error('只有管理员可以查看操作日志'); e.status = 403; throw e
  }
  const q = ctx.url.searchParams
  return {
    items: readAudit({
      limit: Number(q.get('limit') || 100),
      action: q.get('action') || undefined,
      actorId: q.get('actorId') || undefined,
    }),
    /** 动作清单，给界面做筛选下拉 */
    actions: Object.values(AUDIT),
  }
})

/**
 * 员工访问日志：谁在什么时候看过哪些文档。
 *
 * 语雀企业版把它和「空间操作日志」并列成两项安全能力，本项目此前只有操作日志那一半。
 * 对公司来说这不是锦上添花 —— 涉密文档的**访问复核**（谁看过、哪天看的）
 * 经常是等保 / ISO 27001 检查时要拿出来的东西。
 *
 * 几个刻意的设计：
 *
 * ① **复用 doc_views，不再单开一张表。** 那张表记的是「谁在哪天看过哪篇」，
 *    主键 (docId, day, userId)，写入前先过阅读权限判定。
 *    它有界（同一人同一天同一篇只算一次），刷页面灌不进去，也灌不满 ——
 *    再开一张逐次记录的表，几个月后就是几十亿行。
 *
 * ② **粒度是天，不是秒。** `at` 是当天**首次**阅读的时刻，因为主键去重
 *    之后同一天不会再更新。界面上照实写「当天首次」，不假装是精确时间。
 *    复核要的是「哪天看过」，按天正好够用。
 *
 * ③ **只给平台管理员。** 访问日志能回答「谁翻过这份薪酬方案」，
 *    普通成员拿到它等于拿到一份「大家在看什么」的地图。
 *
 * ④ **按管理员自己能读的范围过滤。** 管理员也不是所有知识库的 owner
 *    （比如他只是某个空间的 owner），看不见的那些库不列。
 */
on('GET', '/api/accesslog', (ctx) => {
  const me = requireUser(ctx)
  if (me.role !== 'owner' && me.role !== 'admin') {
    const e: any = new Error('只有管理员可以查看访问日志'); e.status = 403; throw e
  }
  const q = ctx.url.searchParams
  const limit = Math.min(500, Math.max(1, Number(q.get('limit') || 100)))
  const days = Math.min(365, Math.max(1, Number(q.get('days') || 30)))
  const bookFilter = q.get('bookId') || ''
  const userFilter = q.get('userId') || ''
  const since = Date.now() - days * 86400000

  const rows = db.prepare(`
    SELECT v.docId, v.day, v.userId, v.bookId, v.at,
           d.title AS docTitle, us.name AS userName, us.account AS userAccount,
           b.name AS bookName
      FROM doc_views v
      LEFT JOIN docs  d  ON d.id  = v.docId
      LEFT JOIN users us ON us.id = v.userId
      LEFT JOIN books b  ON b.id  = v.bookId
     WHERE v.at >= ?${bookFilter ? ' AND v.bookId = ?' : ''}${userFilter ? ' AND v.userId = ?' : ''}
     ORDER BY v.at DESC LIMIT ?`)
    // 条件和参数**分别**拼 —— 早先写成「三种组合选一组参数」，
    // 只传 bookId 时会多塞一个 userId 的占位，SQLite 直接抛「参数个数不对」，
    // 接口整个 500。而这种组合恰恰是最自然的用法（按知识库筛）。
    .all(since, ...(bookFilter ? [bookFilter] : []), ...(userFilter ? [userFilter] : []), limit) as Row[]

  const items = rows
    // 管理员读不到的库不列 —— 他自己都打不开，凭什么从日志里看到标题
    .filter((r) => capsInBook(me, String(r.bookId)).read)
    .map((r) => ({
      docId: String(r.docId),
      docTitle: String(r.docTitle || '（已删除）'),
      bookId: String(r.bookId),
      bookName: String(r.bookName || ''),
      userId: String(r.userId),
      userName: String(r.userName || ''),
      userAccount: String(r.userAccount || ''),
      day: String(r.day || ''),
      firstAt: Number(r.at) || 0,
    }))

  return {
    items,
    /** 粒度说明随接口一起给，界面上照着说，不让读的人自己猜 */
    granularity: 'day',
    note: '按天记录：同一人同一天看同一篇只记一次，时间是当天首次阅读的时刻。',
  }
})

on('POST', '/api/auth/password', async (ctx) => {
  const u = requireUser(ctx)
  const b = (await ctx.body()) || {}
  const oldPwd = String(b.oldPassword || '')
  const newPwd = String(b.newPassword || '')

  // 先按强度挡掉，省得拿弱口令去跟 scrypt 较劲
  if (newPwd.length < 8) { const e: any = new Error('新密码至少 8 位'); e.status = 400; throw e }
  if (!/[A-Za-z]/.test(newPwd) || !/\d/.test(newPwd)) {
    const e: any = new Error('新密码需要同时包含字母和数字'); e.status = 400; throw e
  }
  if (oldPwd === newPwd) { const e: any = new Error('新密码不能与当前密码相同'); e.status = 400; throw e }

  const row = db.prepare('SELECT passHash, passSalt FROM users WHERE id = ?').get(u.id) as Row | undefined
  if (!row || !verifyPassword(oldPwd, String(row.passHash), String(row.passSalt))) {
    // 不说「旧密码错了」之外的任何信息，避免变成账号探测的旁路
    //
    // ⚠️ 这里**原来返 401，是错的**（2026-10-16 修）。
    // `src/lib/api.ts` 的契约是「401 = 会话失效」→ 清 token + 跳登录页。
    // 于是**用户只是把旧密码输错一次，就被踢回登录页**，
    // 未保存的内容全丢 —— 而他做的唯一错事是敲错一位密码。
    // 「会话有效、但你给的这个口令不对」一律 400。
    const e: any = new Error('当前密码不正确'); e.status = 400; throw e
  }
  const { hash, salt } = hashPassword(newPwd)
  db.prepare('UPDATE users SET passHash = ?, passSalt = ? WHERE id = ?').run(hash, salt, u.id)

  /**
   * 踢掉**其他**所有会话。
   * 改密码的意义就是「密码泄露了，把别人挡在外面」——
   * 不清会话的话，偷到密码的人手上的令牌还能继续用，这一改等于没改。
   * 发起这次修改的会话留着：不然用户会当场被踢出登录，还得再输一遍新密码。
   */
  const me = extractToken(ctx.req)
  const others = db.prepare('DELETE FROM sessions WHERE userId = ? AND token <> ?').run(u.id, me || '').changes
  db.prepare('UPDATE users SET passwordChangedAt = ? WHERE id = ?').run(Date.now(), u.id)
  logAudit({
    actorId: u.id, action: AUDIT.passwordChange,
    targetType: 'user', targetId: u.id,
    detail: { otherSessionsClosed: Number(others) },
  })
  return { ok: true, otherSessionsClosed: Number(others) }
})

/**
 * 新建团队空间。
 *
 * 为什么不走同步：`space_members` **不在同步实体清单里**（见 server/entities.ts）。
 * 如果让客户端直接推 spaces 行，空间会建出来、成员行却永远不会存在 ——
 * 服务端 `capsInSpace` 判不到成员，于是「谁建的谁进不去」，
 * 和之前 book_members 复合主键那个坑是同一类。
 *
 * 所以这里由服务端在一个事务里把两行一起写掉，客户端拿回结果合并进 store。
 */
on('POST', '/api/spaces', async (ctx) => {
  const u = requireUser(ctx)
  const b = (await ctx.body()) || {}
  const name = String(b.name || '').trim()
  if (!name) { const e: any = new Error('空间名称必填'); e.status = 400; throw e }
  if (name.length > 60) { const e: any = new Error('空间名称不要超过 60 字'); e.status = 400; throw e }

  const id = `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const now = Date.now()
  const avatar = String(b.avatar || '🏢')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare('INSERT INTO spaces (id,name,desc,avatar,kind,createdAt,rev,updatedBy) VALUES (?,?,?,?,?,?,0,?)')
      .run(id, name, String(b.desc || ''), avatar, 'team', now, u.id)
    db.prepare('INSERT INTO space_members (spaceId,userId,role,joinedAt) VALUES (?,?,?,?)')
      .run(id, u.id, 'owner', now)
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  logChange('spaces', id, 'upsert', 0, u.id)
  return {
    space: { id, name, desc: String(b.desc || ''), avatar, kind: 'team', createdAt: now, rev: 0, updatedBy: u.id },
  }
})

/**
 * ============================================================
 * 空间成员名册 / 加人 / 移人 —— **刻意不判 IP 白名单**
 * ============================================================
 * 这一族（下面三条路由）只判 `capsInSpace`，**没有** `requireIpAllowed`。
 * 那是**有意的**，理由两条：
 *
 * ① **粒度不对**。IP 白名单挂在**知识库**上，而这三条管的是**空间**的成员关系。
 *    一个空间下可能有 4 个库，其中 1 个开了白名单 —— 拿那 1 个库的名单去卡
 *    整个空间的名册，等于「一个库设了网段限制 → 整个空间的成员名单跟着消失」。
 *
 * ② **会把管理员锁在外面**。开白名单的本意是「这份资料不出内网」，
 *    而管理员出差/在家要加人、移人是很正常的事。把它卡住的结果是
 *    「为了看资料设的网段限制，顺便让整个团队的人事操作做不了了」。
 *
 * 同一族的平台接口（`/api/accesslog`、`/api/audit`、离职办理、访问令牌）
 * 也是同样的理由。
 *
 * ⚠️ **写在这里是为了防止「好心补上」**：2026-10-06 为了收口 IP 白名单，
 * 扫了一遍全部路由，这种「没判 IP」的一眼就会被当成漏网而补上 ——
 * 而上面两条理由说明补上是错的。`test-attip` 里也钉了同一条。
 * ============================================================
 */

/** 空间成员名册（`space_members` 不在同步清单里，只能靠接口） */
on('GET', '/api/spaces/:id/members', (ctx) => {
  const u = requireUser(ctx)
  const sid = ctx.params.id
  // 空间成员看得到名册；不是成员的直接拒（别让人试探空间里都有谁）
  if (!capsInSpace(u, sid).read) { const e: any = new Error('你不是该空间的成员'); e.status = 403; throw e }
  const rows = db.prepare(`
    SELECT sm.userId, sm.role, sm.joinedAt, us.name, us.account, us.avatar
    FROM space_members sm JOIN users us ON us.id = sm.userId
    WHERE sm.spaceId = ? ORDER BY sm.role = 'owner' DESC, sm.joinedAt ASC`).all(sid) as Row[]
  return {
    members: rows.map((r) => ({
      userId: String(r.userId), name: String(r.name || ''), account: String(r.account || ''),
      avatar: String(r.avatar || ''), role: String(r.role || 'member'), joinedAt: Number(r.joinedAt || 0),
    })),
    isAdmin: capsInSpace(u, sid).admin === true,
  }
})

/**
 * 把人加进空间。
 *
 * 加进来之后还顺手给他补上这个空间**现有**知识库的只读身份 ——
 * 不然他打开空间是一片空白：空间成员身份本身不给任何书的读权限
 * （`capsInBook` 只在空间 owner/admin 时才提前放行），而
 * `space_members` 又不在同步清单里，客户端没法自己补这些行。
 *
 * 局限要说明白：**这个空间里之后再新建的知识库不会自动带上他**，
 * 需要再点一次「添加成员」。自动补齐得靠服务端事件，这里刻意不做 ——
 * 猜错一次就是权限悄悄放大，比多点一下糟糕。
 *
 * `userIds` 批量和 `userId` 单个都收。给一个 200 人的部门开通空间，
 * 一次只能加一个就意味着点 200 次、而且中途失败只进去一半；
 * 知识库那边早就是一次 commit 加一批了（见 addBookMembers）。
 * 但**逐个独立提交**：某个人失败不影响其他人，失败名单如实回给前端，
 * 不做「要么全成要么全不成」—— 一个人填错账号不该让另外 199 个人也进不来。
 */
on('POST', '/api/spaces/:id/members', async (ctx) => {
  const u = requireUser(ctx)
  const sid = ctx.params.id
  if (!capsInSpace(u, sid).admin) { const e: any = new Error('只有空间管理员可以添加成员'); e.status = 403; throw e }
  const b = (await ctx.body()) || {}
  const role = String(b.role || 'member') === 'admin' ? 'admin' : 'member'
  const raw: any[] = Array.isArray(b.userIds) ? b.userIds : [b.userId]
  // 去重 + 去掉空值：同一个人被勾两次不该产生两条记录
  const targets = [...new Set(raw.map((x) => String(x || '')).filter(Boolean))]
  if (!targets.length) { const e: any = new Error('缺少 userId'); e.status = 400; throw e }
  if (targets.length > 500) { const e: any = new Error('一次最多添加 500 人'); e.status = 400; throw e }

  const books = db.prepare('SELECT id FROM books WHERE spaceId = ?').all(sid) as Row[]
  const added: any[] = []
  const failed: any[] = []
  for (const target of targets) {
    const us = db.prepare('SELECT id, account FROM users WHERE id = ?').get(target) as Row | undefined
    if (!us) { failed.push({ userId: target, error: '该用户不存在' }); continue }
    let granted = 0
    try {
      db.exec('BEGIN IMMEDIATE')
      // 已入过空间的人保留原来的加入时间，不要因为「重新添加」把他变成新成员
      db.prepare('INSERT OR REPLACE INTO space_members (spaceId,userId,role,joinedAt) VALUES (?,?,?,COALESCE((SELECT joinedAt FROM space_members WHERE spaceId=? AND userId=?),?))')
        .run(sid, target, role, sid, target, Date.now())
      for (const bk of books) {
        // 已经有该书的身份就别覆盖：加空间成员不该把人家在书里的管理员降成只读
        const has = db.prepare('SELECT 1 AS x FROM book_members WHERE bookId = ? AND userId = ?').get(String(bk.id), target)
        if (has) continue
        db.prepare('INSERT INTO book_members (bookId,userId,role,perms,joinedAt) VALUES (?,?,?,?,?)')
          .run(String(bk.id), target, 'reader', JSON.stringify({ read: true, comment: true, edit: false, create: false, export: false, share: false }), Date.now())
        granted++
      }
      db.exec('COMMIT')
      added.push({ userId: target, account: String(us.account || ''), role, grantedBooks: granted })
      // 权限授予必须可追溯：这条记录回答「谁在什么时候把谁放进了哪个空间」
      logAudit({
        actorId: u.id, action: AUDIT.spaceMemberAdd,
        targetType: 'space', targetId: sid,
        targetName: String((db.prepare('SELECT name FROM spaces WHERE id = ?').get(sid) as Row | undefined)?.name || ''),
        detail: { userId: target, account: us.account, role, grantedBooks: granted },
      })
      // 同上：成员数是现算的，`space_members` 又不在同步清单里，
      // 不手动记一笔的话，别的端侧栏上的成员数会一直停在加入之前。
      logChange('spaces', sid, 'upsert', Number((db.prepare('SELECT rev FROM spaces WHERE id = ?').get(sid) as Row | undefined)?.rev || 0), u.id)
    } catch (err) {
      try { db.exec('ROLLBACK') } catch { /* 已经回滚了 */ }
      failed.push({ userId: target, error: (err as any)?.message || '添加失败' })
    }
  }
  return { ok: failed.length === 0, added, failed }
})


/* ============================================================
   头像上传（2026-10-11）
   ------------------------------------------------------------
   收一张图，存成 attachments 里一条 docId 为空的记录，把 id 回给前端。
   前端再 PATCH /api/users/me { avatar: id } —— **两步**，
   和「先传文件再引用」是同一条路，不另造机制。

   ⚠️ 二进制通道与附件一致：裸 body + Content-Type（不是 multipart），
      见 POST /api/attachment —— 复用那套已验证的写法，别自己发明。
   ============================================================ */
const AVATAR_MAX = 2 * 1024 * 1024   // 2MB
const AVATAR_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

on('POST', '/api/users/me/avatar', async (ctx) => {
  const u = requireUser(ctx)
  const mime = String(ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
  const ext = AVATAR_MIME[mime]
  if (!ext) {
    const e: any = new Error('只支持 PNG / JPEG / GIF / WebP（' + (mime || '没识别出类型') + '）')
    e.status = 400
    throw e
  }

  const chunks: Buffer[] = []
  let size = 0
  for await (const c of ctx.req) {
    size += c.length
    // 边收边卡：超了立刻停，不要先收完再判断（那样内存白占）
    if (size > AVATAR_MAX) { const e: any = new Error('头像太大，请用 2MB 以内的图片'); e.status = 413; throw e }
    chunks.push(c as Buffer)
  }
  const data = Buffer.concat(chunks)
  if (!data.length) { const e: any = new Error('没收到图片内容'); e.status = 400; throw e }

  const id = 'av_' + randomBytes(8).toString('hex')
  db.prepare(
    'INSERT INTO attachments (id, docId, blockId, filename, mime, size, data, createdAt) VALUES (?,?,?,?,?,?,?,?)',
  ).run(id, null, null, 'avatar.' + ext, mime, data.length, data, Date.now())

  return { ok: true, avatarId: id, mime, size: data.length }
})

/**
 * 取头像。
 *
 * ⚠️ 头像属于**个人资料**，而它会出现在别人的界面上（协作条、成员列表…）。
 *    所以这里要登录、要校验「这个附件确实挂在**我**头上」——
 *    不能因为知道 id 就能下到任何一张图。
 */
on('GET', '/api/users/me/avatar/:id', (ctx) => {
  const u = requireUser(ctx)
  const row = db.prepare(
    "SELECT id, mime, data FROM attachments WHERE id = ? AND docId IS NULL AND filename LIKE 'avatar.%'",
  ).get(ctx.params.id) as Row | undefined
  if (!row) { const e: any = new Error('头像不存在'); e.status = 404; throw e }
  // ⚠️ 只允许本人取：av_ 前缀是我们自己发的，但**不能只凭前缀判** ——
  //   附件 id 是 hex，前缀只是习惯。真正要紧的是这条记录属于谁，
  //   所以下面用 users.avatar 反查，而不是看 id 长什么样。
  const mine = db.prepare('SELECT avatar FROM users WHERE id = ?').get(u.id) as Row | undefined
  if (!mine || String(mine.avatar || '') !== String(row.id)) {
    const e: any = new Error('这不是你的头像')
    e.status = 403
    throw e
  }
  /*
   * ⚠️ 这里原来写成
   *      Buffer.isBuffer(row.data) ? row.data : Buffer.from(String(row.data ?? ''), 'base64')
   *    结果取回来的字节是**乱码**：上传 70B / 取回 96B。
   *
   *    原因是 node:sqlite 的 BLOB 在某些路径上回来的是 **Uint8Array 而不是 Buffer**，
   *    于是 `Buffer.isBuffer` 为 false，掉进 base64 分支 ——
   *    把二进制当字符串再 base64 解一遍，越解越乱。
   *
   *    正确写法与 GET /api/attachment/:id 一致：
   *    `Buffer.from(row.data as Uint8Array)`（Buffer 本身是 Uint8Array 的子类，
   *    这一句对两种形态都对）。
   *
   *    症状是「图片能显示但花掉」/「大小对不上」——
   *    **只看响应头看不出问题，必须逐字节比**。
   */
  const buf = Buffer.from(row.data as Uint8Array)
  ctx.res.writeHead(200, {
    'Content-Type': String(row.mime || 'image/png'),
    'Content-Length': buf.length,
    // 私有：个人资料不进任何公共缓存（换设备/换人要重新取）
    'Cache-Control': 'private, max-age=300',
  })
  ctx.res.end(buf)
  return undefined
})

/* ============================================================
   知识库邀请（2026-10-11）
   ============================================================
   以前本项目只有「管理员单向把人加进库」（知识库设置 → 权限 → 添加成员），
   对方**没有拒绝的机会**、也不知道自己被加了。
   语雀的邀请是「发出去 → 对方看到 → 接受 / 拒绝」。

   ⚠️ 送达只做**站内**：对方登录后顶栏亮红点 + 工作台待办列表。
      本项目没有 SMTP —— 声称「已发邮件」是假的，而假通知比没有更糟
      （对方会一直等）。要接邮件是往这里加投递器，不动这张表。

   ⚠️ 权限口径全部走 capsInBook，和别处一致：
      · 发起邀请要这个库的 **admin**（editor 拉人就越权了）
      · 接受 / 拒绝只能**被邀请本人**
      · 撤回只有**邀请人本人**或库管理员
*/

const ROLES: readonly string[] = ['reader', 'editor']

/** 发起邀请 */
on('POST', '/api/books/:id/invites', async (ctx) => {
  const u = requireUser(ctx)
  const bookId = ctx.params.id
  if (!capsInBook(u, bookId).admin) {
    const e: any = new Error('只有知识库管理员可以邀请人')
    e.status = 403
    throw e
  }
  const body = (await ctx.body()) || {}
  const toUserId = String(body.userId || '')
  const role = String(body.role || 'reader')
  if (!toUserId) { const e: any = new Error('要指定邀请谁'); e.status = 400; throw e }
  if (!ROLES.includes(role)) { const e: any = new Error('角色只能是阅读者或编辑者'); e.status = 400; throw e }

  const target = db.prepare('SELECT id, name, account FROM users WHERE id = ?').get(toUserId) as Row | undefined
  if (!target) { const e: any = new Error('这个人不存在'); e.status = 404; throw e }
  if (toUserId === u.id) { const e: any = new Error('不能邀请自己'); e.status = 400; throw e }

  // 已经是成员就不用邀了 —— 否则会发一条「邀请你进你已经在的库」
  const already = db.prepare('SELECT 1 FROM book_members WHERE bookId = ? AND userId = ?').get(bookId, toUserId)
  if (already) { const e: any = new Error(`${target.name} 已经是这个知识库的成员了`); e.status = 400; throw e }

  const book = db.prepare('SELECT name FROM books WHERE id = ?').get(bookId) as Row | undefined
  if (!book) { const e: any = new Error('知识库不存在'); e.status = 404; throw e }

  /*
   * 重复邀请的两种处理：
   *   · 已经有 pending → 直接回它，**不报错也不重复插**。
   *     「报错」在 UI 上就是一句红字，用户会以为出错了；
   *     而「重复插」会在对方待办里出现两条一样的。
   *     幂等返回 + 刷新列表，是这里唯一说得通的做法。
   */
  const pending = db.prepare(
    "SELECT id FROM book_invites WHERE bookId = ? AND toUserId = ? AND status = 'pending'",
  ).get(bookId, toUserId) as Row | undefined
  if (pending) return { ok: true, inviteId: String(pending.id), alreadySent: true }

  const id = 'inv_' + randomBytes(8).toString('hex')
  const now = Date.now()
  try {
    db.prepare(
      'INSERT INTO book_invites (id,bookId,toUserId,fromUserId,role,message,status,createdAt,respondedAt) VALUES (?,?,?,?,?,?,?,?,0)',
    ).run(id, bookId, toUserId, u.id, role, String(body.message || ''), 'pending', now)
  } catch (err: any) {
    // 并发下两个人同时点了「邀请」：部分唯一索引会挡下第二条。
    // 这不是错误 —— 回一个明确的结果，别让用户以为失败。
    const dup = /UNIQUE constraint failed/i.test(String(err?.message || ''))
    if (dup) {
      const again = db.prepare(
        "SELECT id FROM book_invites WHERE bookId = ? AND toUserId = ? AND status = 'pending'",
      ).get(bookId, toUserId) as Row | undefined
      if (again) return { ok: true, inviteId: String(again.id), alreadySent: true }
    }
    const e: any = new Error(err?.message || '邀请发不出去')
    e.status = 500
    throw e
  }

  logAudit({
    actorId: u.id, action: AUDIT.bookInviteSend,
    targetType: 'book', targetId: bookId,
    targetName: String(book.name || ''),
    detail: { toUserId, role },
  })
  return { ok: true, inviteId: id, alreadySent: false }
})

/** 接受 / 拒绝（只能被邀请本人） */
on('POST', '/api/invites/:id/respond', async (ctx) => {
  const u = requireUser(ctx)
  const id = ctx.params.id
  const body = (await ctx.body()) || {}
  const accept = body.accept === true

  const inv = db.prepare('SELECT * FROM book_invites WHERE id = ?').get(id) as Row | undefined
  if (!inv) { const e: any = new Error('邀请不存在'); e.status = 404; throw e }
  if (String(inv.toUserId) !== u.id) {
    // 说「不存在」而不是「不是你的」：告诉别人这条邀请存在
    // 就等于泄露了谁邀请了谁。
    const e: any = new Error('邀请不存在')
    e.status = 404
    throw e
  }
  if (String(inv.status) !== 'pending') {
    const e: any = new Error(`这条邀请已经${inv.status === 'accepted' ? '被接受' : '处理过了'}`)
    e.status = 400
    throw e
  }

  const bookId = String(inv.bookId)
  const now = Date.now()

  if (!accept) {
    db.prepare("UPDATE book_invites SET status = 'declined', respondedAt = ? WHERE id = ?").run(now, id)
    const book = db.prepare('SELECT name FROM books WHERE id = ?').get(bookId) as Row | undefined
    logAudit({
      actorId: u.id, action: AUDIT.bookInviteDecline,
      targetType: 'book', targetId: bookId,
      targetName: String(book?.name || ''),
      detail: { inviteId: id, fromUserId: String(inv.fromUserId) },
    })
    return { ok: true, status: 'declined' }
  }

  /*
   * 接受：**先加成员，再改状态**。
   * 反过来（先改状态再加成员）的话，加成员失败会留下一条
   * 「已接受但其实没进库」的记录 —— 用户看到邀请消失了，
   * 点进知识库却没有权限，而两边都不报错。
   */
  const already = db.prepare('SELECT 1 FROM book_members WHERE bookId = ? AND userId = ?').get(bookId, u.id)
  if (!already) {
    // perms 按角色直接展开 —— 与上面「加空间成员」那段**同一份口径**，
    // 不另造映射表（两处各算一次，迟早算出不一样的权限）。
    const perms = String(inv.role) === 'editor'
      ? { read: true, comment: true, edit: true, create: true, export: true, share: false }
      : { read: true, comment: true, edit: false, create: false, export: false, share: false }
    db.prepare(
      'INSERT INTO book_members (bookId, userId, role, perms, joinedAt) VALUES (?,?,?,?,?)',
    ).run(bookId, u.id, String(inv.role), JSON.stringify(perms), now)
  }
  db.prepare("UPDATE book_invites SET status = 'accepted', respondedAt = ? WHERE id = ?").run(now, id)

  const book = db.prepare('SELECT name FROM books WHERE id = ?').get(bookId) as Row | undefined
  logAudit({
    actorId: u.id, action: AUDIT.bookInviteAccept,
    targetType: 'book', targetId: bookId,
    targetName: String(book?.name || ''),
    detail: { inviteId: id, fromUserId: String(inv.fromUserId), role: String(inv.role) },
  })

  // 成员变了要记一笔变更，否则别人那端的成员数不会更新
  logChange('books', bookId, 'upsert', Number((db.prepare('SELECT rev FROM books WHERE id = ?').get(bookId) as Row | undefined)?.rev || 0), u.id)

  return { ok: true, status: 'accepted', bookId, role: String(inv.role) }
})

/** 撤回（邀请人本人或库管理员） */
on('DELETE', '/api/invites/:id', (ctx) => {
  const u = requireUser(ctx)
  const id = ctx.params.id
  const inv = db.prepare('SELECT * FROM book_invites WHERE id = ?').get(id) as Row | undefined
  if (!inv) { const e: any = new Error('邀请不存在'); e.status = 404; throw e }

  const isSender = String(inv.fromUserId) === u.id
  if (!isSender && !capsInBook(u, String(inv.bookId)).admin) {
    const e: any = new Error('只有邀请人或管理员可以撤回')
    e.status = 403
    throw e
  }
  db.prepare("UPDATE book_invites SET status = 'revoked', respondedAt = ? WHERE id = ?").run(Date.now(), id)

  const book = db.prepare('SELECT name FROM books WHERE id = ?').get(String(inv.bookId)) as Row | undefined
  logAudit({
    actorId: u.id, action: AUDIT.bookInviteRevoke,
    targetType: 'book', targetId: String(inv.bookId),
    targetName: String(book?.name || ''),
    detail: { inviteId: id, toUserId: String(inv.toUserId) },
  })
  return { ok: true, status: 'revoked' }
})

/**
 * 与我有关的待处理邀请 —— **收到的 + 发出的**。
 *
 * ⚠️ 原来这里只查 `toUserId = ?`（我收到的）。
 *    于是「等待对方处理」那一块永远是空的：它要的是**我发出去的**，
 *    而 store 里的 `bookInvites` 只有这一个来源 ——
 *    表现是「邀请发出去了、toast 也说发出去了，但权限页什么都不显示」。
 *
 *    两边都要给，理由不同：
 *      · 收到的 → 对方决定进不进（接受 / 拒绝）
 *      · 发出的 → 我要能看到谁还没处理，并能撤回
 *    没发出去这条的话，管理员除了「再点一次邀请」（而那会拿到
 *    「之前已经邀请过他了」）没有别的办法。
 *
 * ⚠️ 权限：发出的那条按「我对这个库有 admin」过滤 ——
 *    否则能看到「我把某人邀请进了某个我早就没权限的库」。
 */
on('GET', '/api/invites', (ctx) => {
  const u = requireUser(ctx)
  const rows = db.prepare(
    `SELECT * FROM book_invites
      WHERE status = 'pending' AND (toUserId = ? OR fromUserId = ?)
      ORDER BY createdAt DESC`,
  ).all(u.id, u.id) as Row[]

  const shape = (r: Row) => ({
    id: String(r.id),
    bookId: String(r.bookId),
    bookName: String((db.prepare('SELECT name FROM books WHERE id = ?').get(String(r.bookId)) as Row | undefined)?.name || ''),
    fromUserId: String(r.fromUserId),
    fromName: String((db.prepare('SELECT name FROM users WHERE id = ?').get(String(r.fromUserId)) as Row | undefined)?.name || ''),
    toUserId: String(r.toUserId),
    toName: String((db.prepare('SELECT name FROM users WHERE id = ?').get(String(r.toUserId)) as Row | undefined)?.name || ''),
    role: String(r.role),
    message: String(r.message || ''),
    /**
     * 一并返回 status —— 类型里有它，将来客户端要区分状态时不必再改接口。
     * ⚠️ 而客户端**不要**再按它过滤：上面 SQL 已经只查了 pending 的行，
     *    再筛一次（对象里以前连这个字段都没有）会得到空集，且不报错。
     */
    status: String(r.status),
    createdAt: Number(r.createdAt),
    /** 我是收方（能接受/拒绝）还是发方（只能看与撤回）—— 界面据此决定按钮 */
    asReceiver: String(r.toUserId) === u.id,
  })

  // 发出的那条要按「我对这个库还有没有 admin」过滤
  const invites = rows
    .map(shape)
    .filter((inv) => inv.asReceiver || capsInBook(u, inv.bookId).admin)

  return { ok: true, invites }
})

/** 移出空间。不能把最后一个 owner 移走，否则这个空间谁都管不了了。 */
on('DELETE', '/api/spaces/:id/members/:userId', (ctx) => {
  const u = requireUser(ctx)
  const sid = ctx.params.id
  const target = String(ctx.params.userId)
  if (!capsInSpace(u, sid).admin) { const e: any = new Error('只有空间管理员可以移除成员'); e.status = 403; throw e }
  const row = db.prepare('SELECT role FROM space_members WHERE spaceId = ? AND userId = ?').get(sid, target) as Row | undefined
  if (!row) return { ok: true, removed: 0 }
  if (String(row.role) === 'owner') {
    const owners = Number((db.prepare("SELECT COUNT(*) AS n FROM space_members WHERE spaceId = ? AND role = 'owner'").get(sid) as Row).n)
    if (owners <= 1) { const e: any = new Error('这个空间至少要留一个管理员'); e.status = 400; throw e }
  }
  const removed = db.prepare('DELETE FROM space_members WHERE spaceId = ? AND userId = ?').run(sid, target).changes
  // 收回权限同样要留痕：出事时第一句要问的就是「权限是什么时候没的、谁动的」
  logAudit({
    actorId: u.id, action: AUDIT.spaceMemberRemove,
    targetType: 'space', targetId: sid,
    targetName: String((db.prepare('SELECT name FROM spaces WHERE id = ?').get(sid) as Row | undefined)?.name || ''),
    detail: { userId: target },
  })
  // 他在这个空间里各书的身份也一并收回，否则书还在、人却还在名册里
  const inBooks = db.prepare('SELECT id FROM books WHERE spaceId = ?').all(sid) as Row[]
  let cleared = 0
  for (const bk of inBooks) {
    cleared += db.prepare('DELETE FROM book_members WHERE bookId = ? AND userId = ?').run(String(bk.id), target).changes
  }
  // 空间行上的 memberCount 是现算的（表里没这一列），所以成员一动，
  // 别的端**不会**自动看到新数字 —— `space_members` 不在同步清单里，
  // 不会产生 spaces 的变更记录。得手动记一笔，否则侧栏/顶栏/工作台
  // 三处的成员数永远停在加入之前。
  logChange('spaces', sid, 'upsert', Number((db.prepare('SELECT rev FROM spaces WHERE id = ?').get(sid) as Row | undefined)?.rev || 0), u.id)
  return { ok: true, removed: Number(removed), clearedBooks: cleared }
})

/* ============================================================
   删除空间 / 撤销删除（2026-10-16 照真实语雀补）
   ------------------------------------------------------------
   语雀官方《如何删除空间》原文：
     「空间管理员可以在空间管理-空间设置-高级设置中找到空间的删除入口」
     「需要验证之后删除：删除操作后 24 小时内可以进行撤销，
       超过 24 小时即确认，确认后删除不可逆转」
   官方《如何删除个人团队》还补了一条：账号最多 5 个空间，
   删掉是为了**腾出额度**。

   三个设计点都是照它来的，不是自己发明的：
   ① **软删除**。空间的 books / nodes / docs 全是 ON DELETE CASCADE，
      直接 DELETE 会级联抹掉整棵树；而语雀那 24 小时反悔期
      正是为了兜住这个 —— 没有它，一次手滑就是整个团队的知识库没了。
   ② **验证身份**。这是不可逆操作，光凭一个登录态就敢删整棵树，
      等于把「会话被 XSS 偷走」的代价放大到不可挽回。
   ③ **谁能删**：空间管理员（`capsInSpace(...).admin`），
      和语雀「空间管理员」是同一档。
   ============================================================ */

/** 撤销窗口：24 小时。超过即确认，之后再不可逆 */
const SPACE_UNDO_HOURS = 24

/** 这个空间行（不管删没删） */
const spaceRow = (sid: string) => db.prepare('SELECT * FROM spaces WHERE id = ?').get(sid) as Row | undefined

on('DELETE', '/api/spaces/:id', async (ctx) => {
  const u = requireUser(ctx)
  const sid = ctx.params.id
  if (!capsInSpace(u, sid).admin) {
    const e: any = new Error('只有空间管理员可以删除空间'); e.status = 403; throw e
  }
  const row = spaceRow(sid)
  if (!row) { const e: any = new Error('空间不存在'); e.status = 404; throw e }

  /*
   * 删掉之后这个人一个空间都不剩 = 谁都登不进来也建不了新的。
   * 和「最后一个拥有者移不走」同一类护栏 —— 拦得住的是「把人关在门外」，
   * 不是「少删了一个空间」。
   */
  const remaining = db.prepare(
    'SELECT COUNT(*) AS n FROM spaces WHERE deletedAt = 0 AND id <> ? AND id IN (SELECT spaceId FROM space_members WHERE userId = ?)',
  ).get(sid, u.id) as Row
  if (Number(remaining.n) <= 0) {
    const e: any = new Error('这是你最后一个空间，删掉之后就进不来了 —— 请先新建或加入另一个空间'); e.status = 400; throw e
  }

  /* 身份验证：口令错就是错，不给「要不要再确认一次」的余地 */
  const body = (await ctx.body()) || {}
  const given = String(body.password || '')
  if (!given) { const e: any = new Error('请输入你的登录口令以确认删除'); e.status = 400; throw e }
  const me = db.prepare('SELECT passHash, passSalt FROM users WHERE id = ?').get(u.id) as Row | undefined
  /*
   * ⚠️⚠️ 这里**必须用 400，不能用 401**（2026-10-16 实测踩到）。
   *
   * `src/lib/api.ts` 的契约是「401 = 会话失效」→ 清 token + 跳登录页。
   * 而 401 在这个项目里的含义是唯一的、不可复用的。
   * 第一次写成 401 之后实测到的现象是：**用户只是把口令打错了一次，
   * 就被踢回登录页**，未保存的内容全丢 —— 而他做的唯一错事是输错一位密码。
   *
   * 所以「会话有效、但你给的这个口令不对」一律 400。
   */
  if (!me || !verifyPassword(given, String(me.passHash), String(me.passSalt))) {
    const e: any = new Error('登录口令不正确'); e.status = 400; throw e
  }

  if (Number(row.deletedAt || 0) > 0) {
    return { ok: true, alreadyDeleted: true, undoUntil: Number(row.deletedAt) + SPACE_UNDO_HOURS * 3600_000 }
  }

  const now = Date.now()
  const books = db.prepare('SELECT id, name FROM books WHERE spaceId = ?').all(sid) as Row[]
  db.prepare('UPDATE spaces SET deletedAt = ? WHERE id = ?').run(now, sid)
  /*
   * 记的是 **upsert** 不是 delete —— 行还在，只是进了撤销窗口。
   * 增量流里 `changesSince` 会把这个空间翻译成「删除」发给各端
   * （和软删文稿同一套），所以别人那边侧栏也会跟着消失。
   * 记成 delete 的话，撤销时反而没有一条能让它回来的 upsert。
   */
  logChange('spaces', sid, 'upsert', Number(row.rev || 0), u.id)
  logAudit({
    actorId: u.id, action: AUDIT.spaceDelete,
    targetType: 'space', targetId: sid,
    targetName: String(row.name || ''),
    detail: { books: books.length, undoUntil: now + SPACE_UNDO_HOURS * 3600_000 },
  })
  return {
    ok: true,
    deletedBooks: books.length,
    undoUntil: now + SPACE_UNDO_HOURS * 3600_000,
    undoHours: SPACE_UNDO_HOURS,
  }
})

on('POST', '/api/spaces/:id/restore', (ctx) => {
  const u = requireUser(ctx)
  const sid = ctx.params.id
  if (!capsInSpace(u, sid).admin) {
    const e: any = new Error('只有空间管理员可以撤销删除'); e.status = 403; throw e
  }
  const row = spaceRow(sid)
  if (!row) { const e: any = new Error('空间不存在'); e.status = 404; throw e }
  if (Number(row.deletedAt || 0) <= 0) return { ok: true, restored: false }

  const until = Number(row.deletedAt) + SPACE_UNDO_HOURS * 3600_000
  if (Date.now() > until) {
    const e: any = new Error(`已超过 ${SPACE_UNDO_HOURS} 小时的撤销窗口，这个空间已经不可逆地被删除了`); e.status = 409; throw e
  }
  db.prepare('UPDATE spaces SET deletedAt = 0 WHERE id = ?').run(sid)
  /*
   * 这一次必须记 **upsert**：各端收到它才会把空间加回列表。
   * （上面删除时也记的 upsert，靠的是 changesSince 那一侧的翻译；
   *   撤销时行上的 deletedAt 已经清零，翻译不触发，所以要靠这一条。）
   */
  logChange('spaces', sid, 'upsert', Number(row.rev || 0), u.id)
  logAudit({
    actorId: u.id, action: AUDIT.spaceRestore,
    targetType: 'space', targetId: sid,
    targetName: String(row.name || ''),
    detail: {},
  })
  return { ok: true, restored: true }
})

/**
 * 导入数据包：逐条过服务端权限，不接受客户端自称的「该覆盖什么」 */
on('POST', '/api/import', async (ctx) => {
  const u = requireUser(ctx)
  const raw = await ctx.body()
  const r = importBundle(u, raw, String(raw?.mode) === 'replace' ? 'replace' : 'merge')
  if (!r.ok) { const e: any = new Error(r.error || '导入失败'); e.status = 400; throw e }
  return r
})

/** 导出完整性自查：让客户端能确认真拿到的是带正文的包 */
on('GET', '/api/export/verify', (ctx) => {
  const u = requireUser(ctx)
  const def = byName.get('docs')!
  const docs = readEntity(u, def, clientIp(ctx.req)) as any[]
  return {
    docs: docs.length,
    withBody: docs.filter((d) => Array.isArray(d.blocks) && d.blocks.length).length,
  }
})

/* ============================================================
   访问令牌的管理接口（只能用会话调）
   ------------------------------------------------------------
   刻意不给访问令牌自己发令牌的能力：它自己调这些接口会在
   dispatcher 那道「令牌只能走 /api/v2」里被挡下来，所以这里
   用 requireUser 之外再加一句显式说明，调试时能一眼看懂 401 的来由。
   ============================================================ */

function denyTokenForManagement(ctx: Ctx) {
  if (ctx.auth?.via === 'token') {
    const e: any = new Error('访问令牌不能管理访问令牌 —— 否则一把泄露的令牌能无限自我复制')
    e.status = 403
    throw e
  }
}

on('GET', '/api/tokens', (ctx) => {
  const u = requireUser(ctx)
  denyTokenForManagement(ctx)
  return { tokens: listApiTokens(u.id) }
})

/**
 * 新建令牌。**明文只在这一次响应里出现。**
 *
 * 返回 `token` 字段之后服务端就只剩哈希了，所以界面上必须弹一次
 * 「复制并保存，之后看不到」—— 这不是体验问题：
 * 如果用户事后发现「怎么再也找不回来了」，第一反应会是「这功能坏了」。
 */
on('POST', '/api/tokens', async (ctx) => {
  const u = requireUser(ctx)
  denyTokenForManagement(ctx)
  const b = (await ctx.body()) || {}
  const t = createApiToken(u.id, { name: b.name, scopes: b.scopes, days: b.days })
  logAudit({
    actorId: u.id, action: AUDIT.tokenCreate,
    targetType: 'token', targetId: t.id, targetName: t.name,
    // 明文绝不入审计。detail 只留权限和有效期 —— 这两样才是事后要复查的
    detail: { scopes: t.scopes, expiresAt: t.expiresAt, prefix: t.prefix },
  })
  return { ...t, warning: '这是唯一一次显示完整令牌的机会，关闭后无法再次查看。' }
})

on('DELETE', '/api/tokens/:id', (ctx) => {
  const u = requireUser(ctx)
  denyTokenForManagement(ctx)
  const okDone = revokeApiToken(u.id, ctx.params.id)
  if (!okDone) {
    // 分不清「不存在 / 不是你的 / 已经撤过了」是有意的：
    // 说清楚就等于让调用方能枚举别人的令牌 id
    const e: any = new Error('令牌不存在，或已经撤销过了')
    e.status = 404
    throw e
  }
  logAudit({
    actorId: u.id, action: AUDIT.tokenRevoke,
    targetType: 'token', targetId: ctx.params.id,
  })
  return { ok: true }
})

/* ============================================================
   OpenAPI v2（用访问令牌调）
   ------------------------------------------------------------
   路径刻意沿用语雀官方 OpenAPI 的形状（/api/v2/repos/:namespace/:book/...），
   这样照着语雀文档写的脚本改个域名就能先跑起来。

   **namespace 用空间的 id**（语雀那边是 group_login）。
   本项目的 spaces 表没有唯一登录名，硬造一个反而会出现同名空间歧义。
   为了不让人踩坑，这里额外接受**空间名精确匹配**：
   命中多个就直接报错让人改用 id，不做「挑一个」的静默猜测。

   字段名（id / slug / title / body / word_count …）也照语雀的习惯，
   唯一故意的偏离：列表接口返回 { data, total } 而不是裸数组 ——
   裸数组让「翻页翻到头了」和「总共就这些」看起来一模一样，
   写脚本的人无从判断，而这不是语雀那份 API 能替我们解决的问题。
   ============================================================ */

/** 空间 id 或唯一空间名 → 空间 id */
function resolveNamespace(ns: string): string {
  const byId = db.prepare('SELECT id FROM spaces WHERE id = ?').get(ns) as Row | undefined
  if (byId) return String(byId.id)
  const rows = db.prepare('SELECT id FROM spaces WHERE name = ?').all(ns) as Row[]
  if (rows.length === 1) return String(rows[0].id)
  if (rows.length > 1) {
    const e: any = new Error(`有 ${rows.length} 个空间都叫「${ns}」，请改用空间 id`)
    e.status = 400
    throw e
  }
  const e: any = new Error('空间不存在')
  e.status = 404
  throw e
}

/**
 * 解析 :namespace / :book 并判读权限。
 *
 * 空间对不上时回 **404 而不是 403**：403 等于承认「这个库存在，
 * 你只是不能看」，而那本身就把库名泄漏出去了。命名空间不匹配
 * 在语义上就是「这里没有你要的东西」。
 *
 * ============================================================
 * IP 白名单也在这里判 —— 它以前只在两个地方查
 * ============================================================
 * `requireIpAllowed` 的调用点只有 `requireDoc` 和导出接口，
 * 于是**整个 `/api/v2` 全是绕过口**。实测（白名单放行 203.0.113.24，
 * 从 198.51.100.7 发请求）：
 *
 *   /api/doc/d1                    → 403（拦住了）
 *   /api/v2/.../docs/d1            → 200，完整正文 296 字符
 *   /api/v2/.../docs               → 200，10 篇的标题/字数/标签
 *   /api/v2/.../toc                → 200，4 个根节点
 *   PUT  /api/v2/.../docs/d1       → 200，**标题被改了**
 *   DEL  /api/v2/.../docs/d1       → 200，**文档被删了**
 *
 * 为什么这一条特别要紧：**令牌只对 `/api/v2` 生效**。
 * 也就是说 v2 是**唯一**能用令牌在网外操作知识库的通道 ——
 * 管理员配了「仅限公司网段」以为资料出不去，
 * 实际上一张令牌就能把整库读走、改标题、删进回收站。
 * 而 DEPLOY 又明说「照语雀官方文档写的脚本改个域名就能跑」，
 * 那些脚本走的正是这里。
 *
 * 放在 `resolveBook` 而不是每条路由里，是因为 6 条带 `:book` 的
 * v2 路由全都经过它 —— 少写六遍，漏一条的余地也就没了。
 * 剩下那条不走 `resolveBook` 的（`GET /api/v2/repos`）单独处理，
 * 见那里注释。
 */
function resolveBook(ctx: Ctx, u: User) {
  const spaceId = resolveNamespace(ctx.params.namespace)
  const bookId = ctx.params.book
  const b = db.prepare('SELECT id, spaceId, name, desc, avatar, visibility, createdAt, updatedAt FROM books WHERE id = ?')
    .get(bookId) as Row | undefined
  if (!b || String(b.spaceId) !== spaceId) { const e: any = new Error('知识库不存在'); e.status = 404; throw e }
  if (!capsInBook(u, bookId).read) { const e: any = new Error('没有阅读该知识库的权限'); e.status = 403; throw e }
  requireIpAllowed(bookId, ctx)
  return b
}

const iso = (ms: any) => (Number(ms) ? new Date(Number(ms)).toISOString() : null)

on('GET', '/api/v2/user', (ctx) => {
  const u = requireScope(ctx, 'read')
  return { id: u.id, login: u.account, name: u.name, avatar: u.avatar }
})

on('GET', '/api/v2/repos', (ctx) => {
  const u = requireScope(ctx, 'read')
  const rows = db.prepare('SELECT id, spaceId, name, desc, avatar, visibility, createdAt, updatedAt FROM books ORDER BY createdAt DESC')
    .all() as Row[]
  // 逐个过权限矩阵：令牌不因为「能调 API」就看得见全部库
  const data = rows
    .filter((b) => capsInBook(u, String(b.id)).read)
    /**
     * IP 白名单**逐个过滤**，不是整体 403。
     *
     * 这条路由的语义是「列出你能访问的库」，所以白名单不通过的库
     * **就不该出现在结果里** —— 和 `capsInBook` 过滤是同一件事的两个条件。
     *
     * 为什么不跟 `resolveBook` 那样抛 403：一个人往往同时能访问好几个库，
     * 只要其中一个开了白名单就整个 403 的话，他会连**没开白名单的那几个也一起
     * 看不到**，而那些库他明明有权访问。403 在这里是「因为 A 库的事，
     * 把你对 B 库的能力也收走了」。
     *
     * 代价是「为什么我明明是成员，库却不见了」不好解释。
     * 权衡下来仍然选过滤：403 会承认那个库存在，而 404 风格的静默更符合
     * 本项目「不因为『没归属』就全网可见」的一贯取舍。
     */
    .filter((b) => ipAllowed(String(b.id), clientIp(ctx.req)))
    .map((b) => ({
      id: String(b.id),
      namespace: String(b.spaceId || ''),
      slug: String(b.id),
      name: String(b.name || ''),
      description: String(b.desc || ''),
      avatar: String(b.avatar || ''),
      public: String(b.visibility) === 'public',
      created_at: iso(b.createdAt),
      updated_at: iso(b.updatedAt),
    }))
  return { data, total: data.length }
})

on('GET', '/api/v2/repos/:namespace/:book', (ctx) => {
  const u = requireScope(ctx, 'read')
  const b = resolveBook(ctx, u)
  const bookId = String(b.id)
  const n = (sql: string, ...a: any[]) => Number((db.prepare(sql).get(...a) as Row).n)
  const live = (extra = '') => `SELECT COUNT(*) AS n FROM docs WHERE COALESCE(trashed,0) = 0${extra}`
  return {
    id: bookId,
    namespace: String(b.spaceId),
    slug: bookId,
    name: String(b.name || ''),
    description: String(b.desc || ''),
    avatar: String(b.avatar || ''),
    public: String(b.visibility) === 'public',
    created_at: iso(b.createdAt),
    updated_at: iso(b.updatedAt),
    counts: {
      docs: n(live(' AND bookId = ?'), bookId),
      nodes: n('SELECT COUNT(*) AS n FROM nodes WHERE bookId = ?', bookId),
      members: n('SELECT COUNT(*) AS n FROM book_members WHERE bookId = ?', bookId),
      comments: n(
        'SELECT COUNT(*) AS n FROM comments c JOIN docs d ON d.id = c.docId WHERE d.bookId = ?', bookId,
      ),
    },
  }
})

/**
 * 目录树。
 *
 * 输出**嵌套**结构（children）而不是平铺：调用方（门户、文档站、
 * 静态站生成器）要的就是树，平铺的话每家都得自己再拼一次。
 * 孤儿节点（parentId 指着一个不存在的节点）按根处理 ——
 * 少一层总比整棵子树凭空消失好。
 */
on('GET', '/api/v2/repos/:namespace/:book/toc', (ctx) => {
  const u = requireScope(ctx, 'read')
  const b = resolveBook(ctx, u)
  const rows = db.prepare('SELECT id, parentId, title, type, icon, docId, ord, hidden FROM nodes WHERE bookId = ? ORDER BY ord, id')
    .all(String(b.id)) as Row[]

  type Item = { id: string; title: string; type: string; icon: string; doc_id: string | null; order: number; visible: boolean; children: Item[] }
  const byId = new Map<string, Item>()
  for (const r of rows) {
    // 「仅自己可见」的文稿，**连节点带标题一起不给**（平台 owner 也不豁免）。
    // 这一支是**直接查 SQL** 的，不经过 readEntity，所以实体上挂的 `visible`
    // 钩子救不了它 —— 得在这里单独判（和 `exportBundle` 不同，那条走 readEntity，
    // 自动继承）。漏掉的话，API 调用方（门户、静态站生成器）会拿到
    // 别人的**私密文稿标题**。
    const docId = r.docId ? String(r.docId) : ''
    if (docId && !canSeeDocRow(u, docId)) continue
    byId.set(String(r.id), {
      id: String(r.id),
      title: String(r.title || ''),
      type: String(r.type || 'group'),
      icon: String(r.icon || ''),
      doc_id: r.docId ? String(r.docId) : null,
      order: Number(r.ord) || 0,
      visible: Number(r.hidden) !== 1,
      children: [],
    })
  }
  const roots: Item[] = []
  for (const r of rows) {
    if (!byId.has(String(r.id))) continue
    const item = byId.get(String(r.id))!
    const parent = r.parentId ? byId.get(String(r.parentId)) : null
    if (parent) parent.children.push(item)
    else roots.push(item)
  }
  return { data: roots, total: rows.length }
})

/**
 * 文稿列表（不含正文）。
 *
 * 归属判定必须和 perms.bookIdOfDoc 一致：docs.bookId 允许为空，
 * 那种要经目录节点反查。只按 bookId 列过滤的话，
 * 「有权限却不出现在列表里」的文档就只能靠直链进 ——
 * 而调用方根本不知道它存在，于是表现为「API 少了几篇」。
 */
const DOC_IN_BOOK = (bookId: string) =>
  `(d.bookId = ? OR (COALESCE(d.bookId,'') = '' AND d.id IN (SELECT docId FROM nodes WHERE bookId = ? AND docId IS NOT NULL)))`

on('GET', '/api/v2/repos/:namespace/:book/docs', (ctx) => {
  const u = requireScope(ctx, 'read')
  const b = resolveBook(ctx, u)
  const bookId = String(b.id)
  const limit = Math.min(100, Math.max(1, Number(ctx.url.searchParams.get('limit') || 50)))
  const page = Math.max(1, Number(ctx.url.searchParams.get('page') || 1))
  const rows = db.prepare(
    `SELECT d.id, d.title, d.type, d.tags, d.createdAt, d.updatedAt, d.wordCount, d.published
       FROM docs d WHERE ${DOC_IN_BOOK(bookId)} AND COALESCE(d.trashed,0) = 0
         -- 「仅自己可见」的文稿不进列表（平台 owner 也不豁免）
         AND (d.visibility <> 'private' OR d.authorId = ?)
      ORDER BY d.updatedAt DESC LIMIT ? OFFSET ?`,
  ).all(bookId, bookId, u.id, limit, (page - 1) * limit) as Row[]
  const total = Number((db.prepare(
    `SELECT COUNT(*) AS n FROM docs d WHERE ${DOC_IN_BOOK(bookId)} AND COALESCE(d.trashed,0) = 0
       AND (d.visibility <> 'private' OR d.authorId = ?)`,
  ).get(bookId, bookId, u.id) as Row).n)
  return {
    data: rows.map((r) => ({
      id: String(r.id),
      slug: String(r.id),
      title: String(r.title || ''),
      type: String(r.type || 'doc'),
      tags: parseJson(r.tags) as string[],
      word_count: Number(r.wordCount) || 0,
      published: Number(r.published) === 1,
      created_at: iso(r.createdAt),
      updated_at: iso(r.updatedAt),
    })),
    total, page, limit,
  }
})

/** 文稿详情：body 就是 Markdown 源码（库里那一列本来就是 Markdown） */
on('GET', '/api/v2/repos/:namespace/:book/docs/:id', (ctx) => {
  const u = requireScope(ctx, 'read')
  const b = resolveBook(ctx, u)
  const r = docRow(ctx.params.id)
  if (!r) { const e: any = new Error('文档不存在'); e.status = 404; throw e }
  if (Number(r.trashed) === 1) { const e: any = new Error('文档已在回收站中'); e.status = 410; throw e }
  // 路径上的 bookId 必须真的是这篇的库，否则 /repos/A/docs/<B里的id> 会漏权限判定
  const own = String(r.bookId || bookIdOfDoc(String(r.id)) || '')
  if (own && own !== String(b.id)) { const e: any = new Error('该文档不在这个知识库里'); e.status = 404; throw e }
  if (!capsOfDoc(u, ctx.params.id).read) { const e: any = new Error('没有阅读该文档的权限'); e.status = 403; throw e }
  return {
    id: String(r.id),
    slug: String(r.id),
    title: String(r.title || ''),
    type: String(r.type || 'doc'),
    body: String(r.body || ''),
    format: 'markdown',
    tags: parseJson(r.tags) as string[],
    word_count: Number(r.wordCount) || 0,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt),
    updated_by: r.updatedBy ? String(r.updatedBy) : null,
  }
})

/**
 * Markdown → 块。取的是前端那一份纯函数，两边结果必然一致。
 *
 * ⚠️ 必须返回**数组本身**，不能先 JSON.stringify。
 * `push()` 内部的 `toRow` 会对 json 列做一次序列化，
 * 传字符串进来就变成双重编码：库里存的是
 * `"[{\"id\":...}]"`（一个字符串），读出来 `JSON.parse` 之后
 * **仍然是个字符串**，于是 `doc.blocks.some(...)` 在网页端直接炸。
 *
 * 这个坑的表现特别难认：建文档的接口 200、
 * `/api/doc/:id` 也 200、正文也有内容、字数也对 ——
 * 只有真正渲染的那一行抛 `blocks.some is not a function`。
 */
function blocksOfMarkdown(md: string) {
  return markdownToBlocks(md)
}

/**
 * 字数口径收在 `@/lib/word-count`，前端 store 也调同一份。
 * 原来这里是 `countWords(md)` —— 数的是 **markdown**，于是 `# ` 是 2 个字、
 * `- [ ] ` 是 6 个、表格的 `| --- |` 更是一堆；而前端数的是块 text，
 * 又把空白全算上。实测一篇 11 块的文档两边差 **9 字**，
 * 而这个数字是要给人看的（文档头 / 知识库列表 / 工作台统计 / 发现页 / 目录树），
 * 同一个数会因为文档走 API 还是走编辑器而变。
 */

/**
 * 建一篇文稿。
 *
 * 走 `push` 而不是直接写表 —— 这样 rev 递增、changes 日志、
 * 检索投影、doc_links 重算全部自动跟着走。
 * 少走这条路的话，API 建的文档会**在网页端正常显示、却搜不到**：
 * 因为 search_index 是 upsertRow 里刷的，直接 INSERT 不碰它。
 *
 * 同样因为走 push，权限判定是同一份代码，不是另抄一遍。
 */
on('POST', '/api/v2/repos/:namespace/:book/docs', async (ctx) => {
  const u = requireScope(ctx, 'write')
  const b = resolveBook(ctx, u)
  const bookId = String(b.id)
  if (!capsInBook(u, bookId).create) { const e: any = new Error('没有在该知识库新建文档的权限'); e.status = 403; throw e }

  const body = (await ctx.body()) || {}
  const title = String(body.title ?? '').trim().slice(0, 200)
  if (!title) { const e: any = new Error('title 必填'); e.status = 400; throw e }
  const md = String(body.body ?? '')
  const parentId = String(body.parent_id ?? body.parentId ?? '')

  // parent_id 必须是**本库里的**节点，否则会把目录挂到别的库下面去
  let parent = ''
  if (parentId) {
    const p = db.prepare('SELECT bookId FROM nodes WHERE id = ?').get(parentId) as Row | undefined
    if (!p || String(p.bookId) !== bookId) { const e: any = new Error('parent_id 不在这个知识库里'); e.status = 400; throw e }
    parent = parentId
  }

  const docId = 'doc_' + randomBytes(6).toString('hex')
  const nodeId = 'n_' + randomBytes(6).toString('hex')
  const now = Date.now()
  const ord = Number((db.prepare('SELECT MAX(ord) AS m FROM nodes WHERE bookId = ? AND parentId IS ?').get(bookId, parent || null) as Row).m) || 0

  const blocks = blocksOfMarkdown(md)
  /**
   * 标题与正文第一个 H1 对齐 —— 和浏览器端 `applyDerivedTitle` **完全同一套规则**。
   *
   * 原来这里直接用调用方传的 `title`，两者可能对不上，于是：
   *   用户在编辑器里改**一个字**（改的是第二段，跟标题毫无关系）
   *   → `applyDerivedTitle` 把 title 改成正文里的 H1
   * → 目录、书签、分享链接里的标题在**第一次编辑后漂走**，而用户什么都没碰。
   * 导入/迁移场景尤其明显：几百篇文档每篇都要人手动改一次才收敛。
   *
   * ⚠️ 试过「调用方 title 赢、把 H1 改写成它」，**不行**：
   * 当正文首个 H1 才是有意义的可搜内容、而 title 很泛时，
   * 改写 H1 会把那串内容从索引里抹掉（test-apitoken 的「发版流水线」就是这么红的）。
   * 那条规则修好了 auditgap，却制造了一个更隐蔽的洞。
   *
   * 所以以**正文第一个 H1 为准**（与客户端一字不差），调用方传的 title
   * 只在正文没有 H1 时才用。
   * ⚠️ 这是**接口行为变更**：传了 title 又与首个 H1 冲突的调用方，拿到的是 H1。
   *    要保住在外部系统里的原标题，正确做法是把它写成正文的第一个 H1。
   */
  const firstH1 = blocks.find((b: any) => b && b.type === 'h1' && String(b.text || '').trim())
  const finalTitle = (firstH1 ? String(firstH1.text) : title).trim().slice(0, 200) || title

  const res = push(u, {
    upsert: {
      docs: [{
        id: docId, bookId, spaceId: String(b.spaceId), type: 'doc',
        title: finalTitle, body: md, blocks,
        authorId: u.id, createdAt: now, updatedAt: now,
        wordCount: countWordsFromBlocks(blocks), visibility: String(b.visibility || 'space'), published: 0, tags: [],
      }],
      nodes: [{ id: nodeId, bookId, parentId: parent || null, title: finalTitle, type: 'doc', docId, ord: ord + 1 }],
    },
  })
  if (res.rejected.length) { const e: any = new Error(`写入被拒：${res.rejected[0].reason}`); e.status = 400; throw e }
  return { id: docId, slug: docId, node_id: nodeId, title: finalTitle, format: 'markdown' }
})

/**
 * 改文稿。
 *
 * **只接受白名单里的字段。** 逐个 `in` 判断而不是整体覆盖，
 * 因为整体覆盖能让调用方改掉 rev / updatedBy / trashed / bookId ——
 * 而 trashed=0 等于「把别人删掉的文档悄悄恢复」，bookId 等于「把文档搬走」。
 * 这两个都不该是「更新接口」顺带的副作用。
 */
on('PUT', '/api/v2/repos/:namespace/:book/docs/:id', async (ctx) => {
  const u = requireScope(ctx, 'write')
  const b = resolveBook(ctx, u)
  const bookId = String(b.id)
  const cur = docRow(ctx.params.id)
  if (!cur) { const e: any = new Error('文档不存在'); e.status = 404; throw e }
  const own = String(cur.bookId || bookIdOfDoc(String(cur.id)) || '')
  if (own !== bookId) { const e: any = new Error('该文档不在这个知识库里'); e.status = 404; throw e }
  if (!capsOfDoc(u, ctx.params.id).edit) { const e: any = new Error('没有编辑该文档的权限'); e.status = 403; throw e }

  const patch = (await ctx.body()) || {}
  const next: Row = { id: ctx.params.id, updatedAt: Date.now() }
  const explicitTitle = 'title' in patch
  if (explicitTitle) next.title = String(patch.title ?? '').trim().slice(0, 200)
  if ('body' in patch) {
    const md = String(patch.body ?? '')
    next.body = md
    // 改了正文就一定要重算 blocks，否则网页端看到的还是旧内容 ——
    // API 显示新正文、网页显示旧正文，两边对不上而且没人会知道该信谁
    next.blocks = blocksOfMarkdown(md)
    next.wordCount = countWordsFromBlocks(next.blocks)
    /* 与 POST 同一套规则：正文第一个 H1 就是标题。
     * 但这次请求**显式传了 title 就以它为准** —— 调用方既然明确说了要什么标题，
     * 就不该被正文悄悄覆盖（建文档时不存在这种明确意图，所以那边优先 H1）。
     * 不这么做的话：API 改完正文，用户在网页上再改一个字，标题又变了。 */
    if (!explicitTitle) {
      const h1 = next.blocks.find((x: any) => x && x.type === 'h1' && String(x.text || '').trim())
      if (h1) next.title = String(h1.text).trim().slice(0, 200)
    }
  }
  if ('tags' in patch) next.tags = Array.isArray(patch.tags) ? patch.tags.map((t: any) => String(t).slice(0, 40)).slice(0, 20) : []
  if ('type' in patch) next.type = ['doc', 'sheet', 'board', 'table'].includes(String(patch.type)) ? String(patch.type) : 'doc'

  const res = push(u, { upsert: { docs: [next] } })
  if (res.rejected.length) { const e: any = new Error(`写入被拒：${res.rejected[0].reason}`); e.status = 400; throw e }

  // 目录里的标题跟着一起改，否则列表里显示的还是旧标题
  const node = db.prepare('SELECT id FROM nodes WHERE docId = ? AND bookId = ?').get(ctx.params.id, bookId) as Row | undefined
  if (node && typeof next.title === 'string') {
    push(u, { upsert: { nodes: [{ id: String(node.id), title: next.title }] } })
  }
  return { ok: true, id: String(cur.id), rev: res.applied[0]?.rev ?? 0 }
})

/** 删文稿：走软删除（和网页端一个路径），所以**进回收站、可以恢复** */
on('DELETE', '/api/v2/repos/:namespace/:book/docs/:id', (ctx) => {
  const u = requireScope(ctx, 'write')
  const b = resolveBook(ctx, u)
  const bookId = String(b.id)
  const cur = docRow(ctx.params.id)
  if (!cur) { const e: any = new Error('文档不存在'); e.status = 404; throw e }
  const own = String(cur.bookId || bookIdOfDoc(String(cur.id)) || '')
  if (own !== bookId) { const e: any = new Error('该文档不在这个知识库里'); e.status = 404; throw e }
  if (!capsOfDoc(u, ctx.params.id).edit) { const e: any = new Error('没有删除该文档的权限'); e.status = 403; throw e }
  const res = push(u, { remove: { docs: [ctx.params.id] } })
  if (res.rejected.length) { const e: any = new Error(`删除被拒：${res.rejected[0].reason}`); e.status = 400; throw e }

  /**
   * 补一条回收站记录。
   *
   * 服务端的软删只做两件事：翻 `trashed` 标记、记一条变更。
   * 而「回收站」页面读的是 `trash` 那张表，那一行是**客户端**在删除时
   * 一起推上来的。所以从 API 删的文档会变成：
   * 正文还在库里、能恢复，但回收站里**列不出来** ——
   * 恢复得到，却找不到要恢复哪一篇。
   *
   * 这里补上，不去改 `deleteRow`：浏览器那条路本来就是客户端推 trash 行，
   * 在服务端也写一次会和客户端各写一遍（同一 docId 覆盖，内容大致相同，
   * 但「谁写的、什么时候写的」就对不上了）。只在这条新路上补，是最小改动。
   */
  push(u, {
    upsert: {
      trash: [{
        docId: ctx.params.id, bookId,
        title: String(cur.title || ''),
        deletedAt: Date.now(), deletedBy: u.id,
      }],
    },
  })

  return { ok: true, id: ctx.params.id, trashed: true }
})

/* ============================================================
   运维
   ------------------------------------------------------------
   ⚠️ `/api/health` 是**有意免鉴权**的，而且它的响应内容里
      **`sso` / `ssoOnly` 必须留在公开响应里** —— 不要「加固」它。

   为什么免鉴权：Docker 与 compose 的 healthcheck、
   `run-all-tests.mjs` 的探活、以及前端的模式闸门
   （`AppGate.tsx`）都在**还没有令牌**的时候打它。
   要求先登录 = 健康检查自己把自己判死（容器进 restart 循环、
   前端直接退回本地模式）。`test-lint` 的 `PUBLIC_ROUTES` 里
   也登记了这条免鉴权及理由。

   为什么 `sso` / `ssoOnly` 不能挪到鉴权之后（2026-10-06 实测后补的注释）：
   统一认证部署下，**登录页必须在拿到令牌之前**就知道该显示
   「走 SSO 的按钮」还是「密码表单」—— 前端 `src/lib/api.ts`
   读的就是这两个字段（`serverSso()` / `serverSsoOnly()`）。
   给这个接口加鉴权，看起来是在做安全加固，实际效果是
   **统一认证部署所有人都登不进去**。

   代价（明说，不装作没有）：任何能连到这个端口的人，
   不登录就能知道「这里开着统一认证 / 没开」——
   也就是能判断该走伪造请求头还是走弱口令爆破。
   对策是**网络层**的，DEPLOY 已写明：开了 `YQ_SSO_HEADER` 之后
   服务**绝不能被直连**（防火墙只放行认证网关），启动日志里那条
   ⚠️ 警告说的就是这件事。

   顺带一提：`users` / `docs` / `online` 三个字段**没有任何地方在读**
   （扫过 src + server：前端只读 `sso` / `ssoOnly`；`online` 在
   `src/lib/sync.ts` 里另有一个同名但无关的「同步通不通」）。
   它们仍然是有用的运维诊断（DEPLOY 排障表里用 `online` 对账协作条人数），
   所以留着，但要知道它们是**未鉴权可见的组织规模信息**。
   `test-security-settings` 里有断言钉住「前端真的在读 sso/ssoOnly」。
   ============================================================ */
on('GET', '/api/health', () => ({
  ok: true,
  users: Number((db.prepare('SELECT COUNT(*) AS n FROM users').get() as Row).n),
  docs: Number((db.prepare('SELECT COUNT(*) AS n FROM docs').get() as Row).n),
  online: presence(),
  // 前端据此决定：开着统一认证就别再渲染密码表单。
  // 这两个字段**必须**留在免鉴权响应里 —— 登录页在拿到令牌之前就要用它们。
  sso: SSO_ENABLED,
  ssoOnly: SSO_ONLY,
  ts: Date.now(),
}))

/* ============================================================
   静态资源
   ============================================================ */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
}

async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
  // 防目录穿越：规范化后必须仍在 dist 之内
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, rel)
  if (!file.startsWith(DIST)) file = join(DIST, 'index.html')
  if (!existsSync(file)) file = join(DIST, 'index.html')
  // 目录请求回落到 index.html
  if (!extname(file) || (existsSync(file) && (await stat(file)).isDirectory())) file = join(DIST, 'index.html')

  try {
    const buf = await readFile(file)
    const ext = extname(file)
    // 带 hash 的构建产物可以长缓存；index.html 绝不能缓存，
    // 否则发版后用户拿到旧壳子指向已经不存在的 JS，页面白屏。
    const immutable = file.includes(`${'assets'}`) && /-[A-Za-z0-9_]{8,}\./.test(file)
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    })
    res.end(buf)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404')
  }
}

/* ============================================================
   启动
   ============================================================ */

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  // 同源部署本来不需要 CORS，但内网常见「前端 nginx + 后端 8080」的拆法，
  // 放开并配合上面的 token 鉴权（不是靠 CORS 保护数据）。
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Filename')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  if (!url.pathname.startsWith('/api/')) {
    await serveStatic(req, res, url.pathname)
    return
  }

  const hit = match(req.method || 'GET', url.pathname)
  if (!hit) { json(res, 404, { error: '接口不存在' }); return }

  /**
   * 解出「谁在调」，并且记住「拿什么调的」。
   *
   * 两个来源的凭据格式不冲突（会话是 43 位 base64url，令牌以 yq_ 开头），
   * 但这里**不靠前缀区分** —— 先查会话，查不到再查令牌。
   * 靠前缀判的话，将来任何一处改动让令牌前缀变了，
   * 表现会是「令牌一律 401」而不是任何显式的错误，很难往这儿想。
   */
  const raw = extractToken(req)
  let user: User | null = null
  let auth: AuthInfo | null = null
  if (raw) {
    user = userFromToken(raw)
    if (user) auth = { via: 'session', scopes: [...SCOPES] }
    else {
      const t = verifyApiToken(raw)
      if (t) { user = t.user; auth = { via: 'token', scopes: t.scopes, tokenId: t.tokenId } }
    }
  }

  /**
   * 访问令牌**只在 /api/v2 生效**。
   *
   * 这一刀是刻意的，不是「顺手这么写」。/api 下还有三类东西是浏览器专用或
   * 权限更高的：/api/sync/push（能把任意实体行按行推上来）、/api/audit
   * （一份权限地图）、/api/export（整个工作台的数据包）。
   * 而访问令牌是给 CI 和外部程序用的，让它能碰这三样等于把它们一起送出去。
   *
   * 放在路由匹配之后、handler 之前：新加的路由默认就落在外面，
   * 不需要每个写路由的人记得「这里还要再判一次」。
   */
  if (auth?.via === 'token' && !url.pathname.startsWith('/api/v2/')) {
    json(res, 401, { error: '访问令牌只能用于 /api/v2 接口；网页与同步接口请用会话令牌（设置 → 访问令牌）' })
    return
  }

  try {
    const out = await hit.handler({
      req, res, url, user, auth, params: hit.params,
      body: () => readBody(req),
    })
    if (res.writableEnded) return
    json(res, 200, out ?? { ok: true })
  } catch (e: any) {
    const status = e?.status || 500
    if (status >= 500) console.error(`[api] ${url.pathname}`, e)
    json(res, status, { error: e?.message || '服务器内部错误' })
  }
})

/**
 * compose 文件里那个占位符口令。
 *
 * 它是**写在仓库里的字面量**，任何拿到这个项目的人都知道它是什么。
 * 之前的行为是：照常启动、只在日志里打一句「请设置 YQ_ADMIN_PASSWORD」——
 * 而那句话只在口令**完全没设**的时候才打。照抄 compose 又忘了改的人，
 * 拿到的是一个公开口令的管理员账号，而且没有任何提示。
 */
const PLACEHOLDER_PASSWORD = '请改成你自己的口令'

/* 首次启动：播种 */
async function bootstrapFirstRun() {
  const account = process.env.YQ_ADMIN_ACCOUNT || 'admin'

  /**
   * 占位符口令一律拒绝启动。
   *
   * 为什么不和「没设口令」同等对待（后者只用默认口令 + 打印警告）：
   * 「没设」说明部署的人压根没考虑这件事，本地试玩也需要它；
   * 而「设成了占位符」说明他**抄了 compose 但没改**——这是内网部署里最常见的路径，
   * 给它一个能跑起来的公开口令，是把一个低级失误变成一次入侵。
   *
   * 拒绝启动（而不是打个警告）是刻意的：容器会直接进 restart 循环并留下日志，
   * 这比一行躺在日志里等人看见要可靠得多。
   * 万一真的要拿这个口令跑（比如本机试验），显式设 YQ_ALLOW_PLACEHOLDER_PASSWORD=1 放行。
   *
   * ⚠️⚠️ 2026-10-08：这段检查原来写在 `if (!isEmpty()) return` **之后** ——
   *   而 `./data` 是宿主机目录、**跨重建持久**。于是只要库里已有数据，
   *   这条检查就**永远被跳过**，注释承诺的「抄了 compose 忘了改 → 拒绝启动」
   *   在第二次 `docker compose up` 之后就不再成立。
   *
   *   实测：先建好库、再 `docker compose up -d`（口令仍是占位符），
   *   容器**照常 healthy**，日志里也没有那条拒绝信息。
   *
   *   （这不是可利用的漏洞 —— 库里已有真实用户，口令早就定死了；
   *   但它是**文档/注释承诺与实现不符**，而这条承诺本身就是防呆机制。）
   *   所以把检查提到最前面：**只要口令还是占位符，就永远拒绝启动。**
   */
  if (process.env.YQ_ADMIN_PASSWORD === PLACEHOLDER_PASSWORD && process.env.YQ_ALLOW_PLACEHOLDER_PASSWORD !== '1') {
    console.error(
      '\n' +
      '============================================================\n' +
      '  拒绝启动：YQ_ADMIN_PASSWORD 还是 docker-compose.yml 里的占位符。\n' +
      '\n' +
      '  这个口令字面量就写在仓库里，等于没有口令。改这一行再起：\n' +
      '    YQ_ADMIN_PASSWORD: "你自己的口令（至少 8 位，含字母和数字）"\n' +
      '\n' +
      '  （这个检查与库里有没有数据无关 —— 空库、重建后的旧库，一样会拦。）\n' +
      '  确实要用这个口令跑本机试验，就显式设 YQ_ALLOW_PLACEHOLDER_PASSWORD=1。\n' +
      '============================================================\n',
    )
    process.exit(1)
  }

  if (!isEmpty()) return

  const password = process.env.YQ_ADMIN_PASSWORD || 'yuque@2026'
  const demo = process.env.YQ_DEMO !== '0'
  console.log('[seed] 数据库为空，正在初始化…')
  const report = await seed({ demo, adminAccount: account, adminPassword: password, adminName: process.env.YQ_ADMIN_NAME || '管理员' })
  console.log(
    `[seed] 完成：${report.users} 账号 / ${report.spaces} 空间 / ${report.books} 知识库 / ` +
    `${report.nodes} 目录 / ${report.docs} 文档`,
  )
  console.log(`[seed] 管理员账号：${report.adminAccount}   密码：${report.adminPassword}`)
  if (!process.env.YQ_ADMIN_PASSWORD) {
    console.log('[seed] 上面这组是默认口令。正式使用前请设置 YQ_ADMIN_PASSWORD 环境变量重新初始化，或登录后立即修改。')
  }
}

/**
 * 检索索引的口径版本。
 *
 * 索引是**写时派生**的 —— upsertRow 存一次文稿就顺手 reindex 一次。
 * 于是「改了口径」只会作用于**之后**写的文稿，升级前写下的那些还停在旧口径上：
 * 实测（2026-10-06）：把卡片 data 的抽取从「只抽 name/text」改成深走之后，
 * 同一个部署实例里，**新写的文档能搜到卡片里的内容，老文档搜不到** ——
 * 而界面上没有任何东西会提示这件事，搜索只是「有的文档搜得到、有的搜不到」。
 *
 * 所以把口径版本落库，启动时对不上就重建一遍。
 * **改口径就把这个数字 +1** —— 不然改了也不会有人来重建。
 */
const SEARCH_INDEX_VERSION = '2'

function reindexAllIfStale() {
  const K = 'search_index_version'
  let cur = ''
  try { cur = String((db.prepare('SELECT v FROM kv_meta WHERE k = ?').get(K) as Row | undefined)?.v || '') } catch { /* 旧库没这张表就当没记过 */ }
  if (cur === SEARCH_INDEX_VERSION) return
  let n = 0
  try {
    for (const t of [['doc', 'SELECT id FROM docs'], ['book', 'SELECT id FROM books'], ['note', 'SELECT id FROM notes']] as const) {
      for (const r of db.prepare(t[1]).all() as Row[]) { reindex(t[0], String(r.id)); n++ }
    }
    db.prepare('INSERT INTO kv_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(K, SEARCH_INDEX_VERSION)
    console.log(`[search] 索引口径已是 v${SEARCH_INDEX_VERSION}（重建 ${n} 条）`)
  } catch (e) {
    /* 重建失败不能让服务起不来：搜索还能用，只是有一部分文档的口径是旧的 */
    console.warn('[search] 全量重建索引失败，本次仍按旧索引服务', e)
  }
}

await bootstrapFirstRun()
reindexAllIfStale()

if (!existsSync(join(DIST, 'index.html'))) {
  console.warn(`[warn] 未找到前端构建产物（${DIST}）。请先执行 npm run build；API 与 WebSocket 仍可正常使用。`)
}

/**
 * 把「这份前端产物是拿哪个 API 前缀构建的」打出来。
 *
 * 为什么必须有这一行：`VITE_API_BASE` 是**构建期**变量，
 * 子路径部署要 `VITE_API_BASE=/knowledge npm run build`；
 * 而 `src/lib/api.ts` 的 `apiBase()` 拿不到它就返回 `''`，
 * 即**照常构建**出来的产物会把 API 请求打回站点根。
 *
 * 所以最典型的事故是：部署到 `/knowledge/` 之后，谁跑了一次
 * `npm run build` 或者 `npm run test:all`（它在跑套件前必定重新构建），
 * 产物被换成根路径版本 → **全站 API 404**，
 * 而界面能打开（资源路径是相对的），症状是「登录一直转圈 / 数据加载不出来」，
 * 没有任何一处会提示「你的产物被重建过了」。
 *
 * 这一行让运维**在启动那一刻**就看见前缀对不对 ——
 * 不用等到发现全站坏了再回头猜是哪次构建干的。
 *
 * 标记文件是 vite 的 `closeBundle` 钩子写的（见 vite.config.ts）；
 * 读不到只说明这次构建没带标记（老产物 / 手工拷的 dist），
 * 那就不说 —— 宁可少一行，不要在这里抛。
 */
try {
  const infoPath = join(DIST, '.buildinfo.json')
  if (existsSync(infoPath)) {
    const info = JSON.parse(readFileSync(infoPath, 'utf8'))
    const base = String(info?.apiBase || '')
    if (base) {
      console.log(`[server] 前端产物构建于 ${info.builtAt || '未知时间'}，API 前缀 = ${base}（这份产物只能挂在 ${base}/ 下）`)
    } else {
      console.log(`[server] 前端产物构建于 ${info.builtAt || '未知时间'}，API 前缀 = 空（同源部署 / 站点根）`)
      console.log('[server]    如果你把服务挂在子路径（如 /knowledge/）下，这份产物是**错的**：')
      console.log('[server]    要用 `VITE_API_BASE=/knowledge npm run build` 重新构建，否则全站 API 会 404。')
    }
  }
} catch (e) {
  // 读不到标记不是致命问题：老产物、手工拷的 dist 都没有它
}

attachWebSocket(server)

/* ============================================================
   回收站保留期：到期自动永久清除
   ------------------------------------------------------------
   界面上一直写着「保留 30 天，过期后自动永久清除」，还给每篇算倒计时 ——
   而在此之前**没有任何东西会执行这件事**，文档会一直躺着。
   公司照这句话理解自己的数据保留策略，会得到一个错的结论。
   （见 sync.ts 的 purgeExpiredTrash：计时基准只认服务端写的 deletedAt，
     不认客户端推上来的 trash.deletedAt。）
   ============================================================ */
const RETENTION_DAYS = trashRetentionDays()

/**
/** 回收站保留期：一轮只清一批，下一轮再清 —— 别在用户正编辑时长时间占着写锁 */
const runPurge = () => {
  if (RETENTION_DAYS <= 0) return null
  try {
    const r = purgeExpiredTrash(RETENTION_DAYS, 40)
    console.log(`[trash] 保留期扫描：命中 ${r.scanned}，清除 ${r.purged}，跳过未知 ${r.skippedUnknown}（保留 ${RETENTION_DAYS} 天）`)
    if (r.purged) console.log(`[trash] 保留期到期，已永久清除 ${r.purged} 篇`)
    if (r.skippedUnknown) {
      console.warn(`[trash] 有 ${r.skippedUnknown} 篇不知道什么时候删的（deletedAt 为空），已跳过 —— 宁可多留着`)
    }
    return r
  } catch (e) {
    console.warn('[trash] 保留期清除失败', e)
    return null
  }
}

/**
 * 空间撤销窗口到期 → 真删。
 *
 * ⚠️ 这一步是**不可逆**的（books / nodes / docs 全是 ON DELETE CASCADE），
 * 所以它只在 `deletedAt` 确实超过 24 小时时才跑；
 * `deletedAt` 为 0 的活空间被 `COALESCE(deletedAt,0) > 0` 挡住，
 * 一行都不会碰到。删不掉的（外键报错）就不硬删 —— 宁可多留着并说清楚。
 */
const runSpacePurge = () => {
  try {
    const deadline = Date.now() - SPACE_UNDO_HOURS * 3600_000
    const due = db.prepare('SELECT id, name FROM spaces WHERE COALESCE(deletedAt,0) > 0 AND deletedAt < ?').all(deadline) as Row[]
    let gone = 0
    for (const s of due) {
      try {
        gone += db.prepare('DELETE FROM spaces WHERE id = ?').run(String(s.id)).changes
      } catch (e) {
        console.warn(`[space] 空间「${s.name}」到期但删不掉（保留）：${(e as Error)?.message || e}`)
      }
    }
    if (due.length) console.log(`[space] 撤销窗口到期，已永久删除 ${gone} 个空间${gone < due.length ? `（${due.length - gone} 个删不掉，已保留）` : ''}`)
    return gone
  } catch (e) {
    console.warn('[space] 到期清理失败', e)
    return 0
  }
}

/**
 * 定时清扫。**回收站保留期**和**过期会话**挂在同一个定时器上 ——
 * 同一个库里的两件「到期就该清」的事，不该有两个节奏。
 * 空间的撤销窗口到期也算同一类，所以挂在同一个 `runHousekeeping` 上。
 *
 * ⚠️ 清会话**不能**跟着 `YQ_TRASH_DAYS` 一起关掉：
 * 那是「回收站要不要自动清」，而会话过期是「凭据该不该继续有效」，
 * 两件事本来就没有依赖关系。合并定时器时很容易顺手把它们绑在一起。
 *
 * ⚠️ 这里合并时**差点把 runPurge 漏掉**：它定义在下面却从没被调用，
 * 于是「保留期到期自动清除」静默失效、而没有任何东西会报错 ——
 * 它本来只在到期时才做事，没到期时一切看起来完全正常。
 *
 * `purgeExpiredSessions` 补的是 7.31 之后发现的一个洞：过期会话
 * 只在「有人拿这个 token 来请求」时被顺手删掉一行，没人碰的**永远留着**。
 */
const runHousekeeping = () => {
  try {
    const n = purgeExpiredSessions(400)
    if (n) console.log(`[session] 清掉 ${n} 条过期会话`)
  } catch (e) {
    // 清不掉不是致命问题：过期判断在 userFromToken 里已经做了，
    // 这里只是不让表无限涨 —— 所以只记一句，不往上抛。
    console.warn('[session] 清理过期会话失败', e)
  }
  runSpacePurge()
  return runPurge()
}

// 启动先跑一次：进程可能几天没重启，而到期的时间不取决于进程在不在
runHousekeeping()
if (RETENTION_DAYS <= 0) {
  console.log('[trash] 保留期已关闭（YQ_TRASH_DAYS=0）：回收站里的文档不会自动清除')
  // 保留期关了，**过期会话照样要清** —— 那是另一件事，
  // 不能跟着这个开关一起关掉。所以定时器无条件存在。
}
const timer = setInterval(runHousekeeping, 6 * 3600 * 1000)
// 不要因为这个定时器而让进程不退出
timer.unref?.()

server.listen(PORT, HOST, () => {
  console.log(`[server] 知语知识库已启动  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)
  console.log(`[server] 数据库：${process.env.YQ_DB || 'data/yuque.db'}`)

  /**
   * 启动自检：实体声明的列在表里是不是都在。
   *
   * 老库升级最阴险的一种坏法是「缺列」：`CREATE TABLE IF NOT EXISTS` 对已存在的表
   * 什么也不做，所以只改建表语句、不补 ALTER 的话，全新库一切正常，
   * 而老库上**访问到那一列时**才 500 —— 而且报错是 `no such column: xxx`，
   * 触发它的是「改一下设置」这种日常操作，报错里一个字都没提升级。
   *
   * 这里明确喊出来（不抛，抛了老实例直接起不来，风险更大）。
   */
  try {
    const missing = auditEntityColumns()
    if (missing.length) {
      console.log(`[server] ⚠️  数据库缺列：${missing.length} 处。老库升级后访问这些列会报 no such column。`)
      for (const m of missing.slice(0, 20)) console.log(`[server] ⚠️    ${m.table}.${m.column}（实体 ${m.entity} 声明了它）`)
      if (missing.length > 20) console.log(`[server] ⚠️    …… 还有 ${missing.length - 20} 处`)
    }
  } catch (e) {
    console.log(`[server] ⚠️  列自检没能跑完：${(e as any)?.message || e}`)
  }

  if (SSO_ENABLED) {
    console.log(`[server] 统一认证：已开启，信任请求头 ${process.env.YQ_SSO_HEADER}`)
    console.log('[server] ⚠️ 务必确认本服务无法被直连（防火墙只放行认证网关）——能被直连就等于任何人都能伪造这个头登录进来。')
    if (String(process.env.YQ_TRUSTED_PROXY_IPS || '').trim()) {
      console.log(`[server] 统一认证：已配置 YQ_TRUSTED_PROXY_IPS=${process.env.YQ_TRUSTED_PROXY_IPS}，只有来自这些地址的请求才认那个头。`)
      console.log('[server]    ⚠️ 配错的后果是「谁也登不进来」而不是「被绕过」—— 头不对时是静默失败，症状是登录页一直转圈。')
    } else {
      console.log('[server]    想多一道技术防线：设 YQ_TRUSTED_PROXY_IPS=<网关IP>，只有来自它的请求才认这个头。')
    }
    if (SSO_ONLY) console.log('[server] 统一认证：本地注册与密码登录已关闭（YQ_SSO_ONLY）')
  }
})
