/* ============================================================
   鉴权 —— 密码与会话
   口令用 scrypt（N=16384, r=8, p=1）加盐哈希，
   这是 Node 内置的，不引 bcrypt/argon2 之类的原生依赖 ——
   内网机器往往没有编译工具链，少一个依赖就少一个装不上的理由。

   会话用随机 token 存表，不用 JWT：
   内网场景需要「立刻踢掉某人」和「改密码即失效」，服务端可撤销的会话
   天然支持，JWT 还得额外维护黑名单。
   ============================================================ */

import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto'
import { db } from './db.ts'
import type { Row } from './db.ts'
import type { User } from './perms.ts'

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }
/** 会话有效期 30 天，员工出差回来不用重新登录 */
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000

/* ============================================================
   统一认证（SSO）—— 走网关认证头
   ------------------------------------------------------------
   为什么不直接接 LDAP / AD / 企业微信：
   那三种各自要原生依赖和协议实现，而公司里几乎一定已经有一层统一认证网关
   （oauth2-proxy、mod_auth_openidc、nginx auth_request、企业微信 OAuth 回调……），
   它们**本来就会往请求头里塞一个用户名**。

   所以这里不认协议，只认一个头：网关证明过身份，把结论写在头上，我们照着认。
   LDAP、AD、企业微信、自研 SSO 全都能套，一行协议代码都不用写。

   ⚠️ 安全前提：信任头 = 信任网关。
   开着这个开关时**服务绝不能被直连**（防火墙只放行网关 IP），
   否则任何人都能伪造一个 `X-Forwarded-User: ceo` 登录进来。
   ============================================================ */

/** 认证头名，如 `X-Forwarded-User`。留空 = 不启用（默认） */
const SSO_HEADER = (process.env.YQ_SSO_HEADER || '').trim().toLowerCase()
/** 可选：真实姓名头，用于显示名 */
const SSO_NAME_HEADER = (process.env.YQ_SSO_NAME_HEADER || '').trim().toLowerCase()
/** 可选：邮箱头 */
const SSO_EMAIL_HEADER = (process.env.YQ_SSO_EMAIL_HEADER || '').trim().toLowerCase()

export const SSO_ENABLED = SSO_HEADER !== ''
/** 只允许统一认证，禁用本地注册与密码登录 */
export const SSO_ONLY = ['1', 'true', 'yes'].includes(String(process.env.YQ_SSO_ONLY || '').trim().toLowerCase())

/**
 * `YQ_TRUSTED_PROXY_IPS` —— **只信来自这些 IP 的请求头**。
 *
 * 为什么需要它：`X-Forwarded-User`（统一认证）和 `X-Forwarded-For`（客户端 IP）
 * **都是请求方自己写的**。而这两个头的危害差着一个量级：
 *   · 伪造 XFF  → 绕过知识库 IP 白名单、记错访问来源
 *   · 伪造 User → **不带任何密码或令牌，直接登录成那个人**
 * 实测（服务可直连时）：只发一个 `X-Forwarded-User: <同事的账号>` 就拿到了他的知识库；
 * 报一个**不存在**的账号还能 JIT 开户，**顺带抢走「第一个进门的人拿 owner」那个位置**。
 *
 * ⚠️ 与 `YQ_TRUST_PROXY=0` 的区别（我第一版把这两个混为一谈了）：
 *   · `YQ_TRUST_PROXY=0` = **完全不信 XFF**，退回 socket 地址。
 *     对 IP 够用（记录变粗但功能在），**对 SSO 毫无意义** ——
 *     IP 不是身份凭据，不信它并不会让「谁是你」这件事变安全。
 *   · `YQ_TRUSTED_PROXY_IPS` = **只信列表里那些来源的头**。
 *     这个对 SSO 同样有效：反代在列表里 → 正常登录；
 *     别人从别的 IP 直连 → 那个头不算数 → 登不进来。
 *
 * **不设 = 全信 = 与本开关存在之前的行为完全一致**，
 * 所以现有部署升级后不受影响。真正的破坏性变更是「把它默认设成空/拒绝」，
 * 那会让所有反代部署的同事一起登不进来。
 */
const TRUSTED_PROXY_IPS = new Set(
  String(process.env.YQ_TRUSTED_PROXY_IPS || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
)

/** 这个请求是不是来自「我们信任的那个反代」 */
export function fromTrustedProxy(req: any): boolean {
  if (TRUSTED_PROXY_IPS.size === 0) return true      // 没配 = 保持原状
  const peer = String(req.socket?.remoteAddress || '')
  return TRUSTED_PROXY_IPS.has(peer) || TRUSTED_PROXY_IPS.has(peer.replace(/^::ffff:/, ''))
}

/** 头最多认 128 字符：头是外部输入，超长的一律当没传 */
const SSO_MAX_LEN = 128

function headerValue(req: { headers: Record<string, any> }, name: string): string {
  const v = req.headers?.[name]
  const raw = Array.isArray(v) ? v[0] : v
  const s = String(raw ?? '').trim()
  if (!s || s.length > SSO_MAX_LEN) return ''
  // 头里带控制字符是伪造头的经典手法，直接拒掉
  if (/[\u0000-\u001f\u007f]/.test(s)) return ''
  return s
}

/**
 * 解出「人看的中文」。
 *
 * 头只能是 Latin-1（ByteString）—— 浏览器和 Node 都会在发出去之前
 * 就把「张三」这种非 ASCII 头值拒掉，所以网关**不可能**直接把中文塞进来。
 * 现实中能落地的就两种编码，这里都认：
 *   · 百分号编码   nginx / oauth2-proxy 常见：`%E5%BC%A0%E4%B8%89`
 *   · RFC 2047     MIME 编码字，Word 域、Outlook 转发常见：`=?UTF-8?B?...?=`
 * 认不出来就原样返回 —— 账号名本身是 ASCII 的场景不受影响。
 */
function decodeHeaderText(s: string): string {
  if (!s) return s
  // RFC 2047：=?charset?B|Q?text?=
  const rfc2047 = /^=\?([^?]+)\?([BbQq])\?([^?]*)\?=$/.exec(s)
  if (rfc2047) {
    try {
      const charset = /^utf-?8$/i.test(rfc2047[1]) ? 'utf8' : 'latin1'
      const body = rfc2047[2].toUpperCase() === 'B'
        ? Buffer.from(rfc2047[3], 'base64').toString(charset)
        : Buffer.from(rfc2047[3].replace(/_/g, ' '), 'latin1').toString(charset)
      return body || s
    } catch { return s }
  }
  // 百分号编码：整串都得是合法转义，否则当成原文（账号名里带 % 是可能的）
  if (s.includes('%') && /^[\x20-\x7e]*$/.test(s) && /%[0-9a-fA-F]{2}/.test(s)) {
    try { return decodeURIComponent(s) } catch { return s }
  }
  return s
}

/** `CORP\zhangsan` / `zhangsan@corp.com` → `zhangsan`；认不出来就原样用 */
function localPart(account: string): string {
  const s = account.includes('\\') ? account.slice(account.lastIndexOf('\\') + 1) : account
  return s.includes('@') ? s.slice(0, s.indexOf('@')) : s
}

/**
 * 从请求里解析「网关已经认证过的这个人」。
 * 没启用、或头没带上，返回 null —— 调用方据此回落到密码登录。
 */
export function ssoHeaderUser(req: { headers: Record<string, any> }): { account: string; name: string; email: string } | null {
  if (!SSO_ENABLED) return null
  /*
   * 来源不在信任列表里 → 这个头当没传。
   *
   * 这一句**必须在**读 `SSO_HEADER` 之前：SSO 头是**唯一**的凭据，
   * 所以不像 `clientIp` 那样还有「退回 socket 地址」的选项 ——
   * 不信它就是「这次请求进不来」，而这正是可直连时想要的结果。
   */
  if (!fromTrustedProxy(req)) return null
  // 账号也解一次编码：LDAP 的 login、AD 的 sAMAccountName 本来就是 ASCII，
  // 不用解；但有的企业给的是邮箱账号，网关传过来时可能已经是百分号编码。
  // 存和查走的是同一个函数，所以两边始终一致。
  const account = decodeHeaderText(headerValue(req, SSO_HEADER))
  if (!account) return null
  const name = decodeHeaderText(SSO_NAME_HEADER ? headerValue(req, SSO_NAME_HEADER) : '') || localPart(account)
  const email = decodeHeaderText(SSO_EMAIL_HEADER ? headerValue(req, SSO_EMAIL_HEADER) : '')
  return { account, name, email }
}

/**
 * 建用户 + 开一个个人空间。
 *
 * 注册和统一认证首次登录都走这里 —— 「新用户得有个落笔的地方」这条规则
 * 只写一遍。写两遍的话，早晚有一天只改了其中一处，然后新同事登录进来
 * 面对一片空白，还查不出是哪边的问题。
 *
 * ------------------------------------------------------------
 * 「谁是第一个管理员」的判断放进事务 —— **防御性加固，不是修了一个能触发的漏洞**
 *
 * ⚠️ 2026-10-06：我一度把这里写成「并发时两个请求都查到『还没人』，
 * 于是两个都成了 owner」。**那句话是错的**，实测推翻了它：
 * 把事务撤掉、连跑 8 轮「6 个人同时首登」，SSO owner **一次都没超过 1 个**。
 *
 * 原因：注册与统一认证首登这两个处理器**一个 `await` 都没有**（`async` 但全同步），
 * Node 单线程事件循环不会在它中间插进另一个请求 —— 整个判据 + 插入是一段不可分割的
 * 同步块。**那个竞争在当前架构下不可达。**
 *
 * 那为什么还要包？「不可达」和「安全」只差一步之遥：
 *   · 谁在判据与插入之间加一个 `await`（比如顺手加个 `await ctx.body()`、
 *     或把某次查库改成异步）—— 竞争立刻成立，而**症状是两个平台 owner**，
 *     没有任何报错；
 *   · 将来改成多进程 / 多实例共享同一个库 —— 同样立刻成立。
 * 平台 owner 能进管理页、看全量审计、给别人办离职、导出整包，
 * 攻击面翻倍且**不留痕迹**。所以把不变量变成结构性的：判据与三行 INSERT
 * 在同一个 `BEGIN IMMEDIATE` 里（`busy_timeout=5000` 已设，第二个请求排队等写锁，
 * 拿到锁时重新求值判据 → 看到第一人的行 → 拿到 member）。
 *
 * `decideRole` 这个可选参数是为了让调用方**把自己的判据传进来**，
 * 而不是自己先算好再传结果 —— 传结果的话判据仍在事务外跑，等于没包。
 * 这正是本项目记过的「同一个判断写两遍、改一处忘另一处」。
 */
export function createUserWithSpace(opts: {
  account: string
  name?: string
  email?: string
  passHash?: string
  passSalt?: string
  role?: string
  /**
   * 「我该不该当 owner」的判据，**在事务内**求值。
   * 返回 `'owner'` / `'member'` / 空（空 = 走默认的「库里第一个人」规则）。
   */
  decideRole?: () => string | null | undefined
  viaSso?: boolean
}) {
  // 库里第一个人是管理员。统一认证开启时也走这条：否则全新部署 +
  // SSO 会得到一个谁都不是管理员的库，谁也进不了设置页。
  // role 可以由调用方指定 —— 统一认证那条路要按「这个位置有没有人占了」判断，
  // 而不是按「这是不是第一个人」。
  db.exec('BEGIN IMMEDIATE')
  try {
    const count = Number((db.prepare('SELECT COUNT(*) AS n FROM users').get() as Row).n)
    const role = opts.role || opts.decideRole?.() || (count === 0 ? 'owner' : 'member')
    const id = `u_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const name = opts.name || opts.account
    const now = Date.now()
    db.prepare('INSERT INTO users (id,name,account,email,avatar,passHash,passSalt,role,viaSso,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(id, name, opts.account, opts.email || '', '', opts.passHash || '', opts.passSalt || '', role, opts.viaSso ? 1 : 0, now)

    const sid = `sp_${id}`
    db.prepare('INSERT INTO spaces (id,name,desc,avatar,kind,createdAt,rev,updatedBy) VALUES (?,?,?,?,?,?,0,?)')
      .run(sid, `${name} 的空间`, '', '', 'personal', now, id)
    db.prepare('INSERT INTO space_members (spaceId,userId,role,joinedAt) VALUES (?,?,?,?)').run(sid, id, 'owner', now)

    db.exec('COMMIT')
    return { id, name, account: opts.account, role }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 已经回滚了 */ }
    throw e
  }
}

export function hashPassword(password: string, salt?: string) {
  const s = salt ?? randomBytes(16).toString('hex')
  const h = scryptSync(password, s, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex')
  return { hash: h, salt: s }
}

/** 定长比较：防止按字节比对耗时的时序侧信道 */
export function verifyPassword(password: string, hash: string, salt: string): boolean {
  const candidate = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p })
  const expected = Buffer.from(hash, 'hex')
  if (expected.length !== candidate.length) return false
  return timingSafeEqual(candidate, expected)
}

export function newToken(): string {
  return randomBytes(32).toString('base64url')
}

export function createSession(userId: string, ua = '', ip = '') {
  const token = newToken()
  const now = Date.now()
  db.prepare('INSERT INTO sessions (token, userId, createdAt, expiresAt, ua, ip) VALUES (?,?,?,?,?,?)')
    .run(token, userId, now, now + SESSION_TTL_MS, ua.slice(0, 200), ip)
  return token
}

export function destroySession(token: string) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

/* ============================================================
   登录设备管理（语雀的「帐户安全 → 登录设备」）
   ------------------------------------------------------------
   列出会话、撤销某一条 —— 语雀那边的原文是「可以将你访问语雀的
   设备列表罗列出来…直接删除相关设备的访问权限，被删除后的设备会自动退出登录」。

   ⚠️ **最要紧的一条：`sessions` 的主键就是 token 本身**，
   所以列表接口**绝不能把 token 发给前端** ——
   那等于把别的设备的凭据原样交出去：
   一个能读到自己会话列表的人，顺手就拿到了他那台电脑的登录态。

   所以对外一律用 `ref`：**token 的 SHA-256 前 16 位**。
   · 拿不到 token（单向哈希）；
   · 不能反推（256 位摘要，截 16 位 base64url ≈ 96 位，穷举不动）；
   · **不需要改表**：老实例的 sessions 行一样能用，
     比加一列要「幂等 ALTER + 回填存量」省事得多，也不会动到迁移那条路。

   撤销时不去反查数据库里的 token，而是**把这个人的会话逐条算 ref 比对** ——
   一个用户手上有几条会话就几次哈希，代价可忽略，而这样
   「按 ref 撤销」这条路**根本碰不到 token 本身**。
   ============================================================ */
export function sessionRef(token: string): string {
  return createHash('sha256').update(token).digest('base64url').slice(0, 16)
}

/** 列出这个人的会话（**不含 token**），并标出哪一个是当前设备 */
export function listSessions(userId: string, currentToken: string) {
  const rows = db.prepare(
    'SELECT token, ua, ip, createdAt, expiresAt FROM sessions WHERE userId = ? ORDER BY createdAt DESC',
  ).all(userId) as Row[]
  const now = Date.now()
  return rows.map((r) => ({
    ref: sessionRef(String(r.token)),
    ua: String(r.ua || ''),
    ip: String(r.ip || ''),
    createdAt: Number(r.createdAt) || 0,
    expiresAt: Number(r.expiresAt) || 0,
    // 过期的不列 —— 它已经不能用了，列出来只会让人去点一个必然失败的「下线」
    expired: Number(r.expiresAt) < now,
    current: String(r.token) === currentToken,
  }))
}

/**
 * 按 ref 撤销一条会话。
 *
 * 返回值是给路由翻译成状态码的：
 *   `ok`        删掉了
 *   `current`   那是**当前这台设备** —— 语雀也不让删（绿点那台），
 *               这里给一句人话，而不是默默删掉自己把自己踢下线
 *   `not-found` 没有这条，或**它根本不属于你**
 *               —— 两种都回 404，不告诉调用方「这条存在但不是你的」
 */
export function revokeSessionByRef(userId: string, ref: string, currentToken: string): 'ok' | 'current' | 'not-found' {
  const rows = db.prepare('SELECT token FROM sessions WHERE userId = ?').all(userId) as Row[]
  const hit = rows.find((r) => sessionRef(String(r.token)) === ref)
  if (!hit) return 'not-found'
  if (String(hit.token) === currentToken) return 'current'
  db.prepare('DELETE FROM sessions WHERE token = ?').run(String(hit.token))
  return 'ok'
}

/**
 * 清掉已经过期的会话行。
 *
 * ⚠️ 以前**根本没有这个函数**，于是过期会话只会在「有人拿这个 token 来请求」
 * 时被 `userFromToken` 顺手删掉那一行 —— 没人再用的过期 token 就**永远留在表里**。
 *
 * 这不是「过期了还能用」：`userFromToken` 每次都会比对 `expiresAt`，
 * 所以**安全上是干净的**。真正的问题是另外两件：
 *   ① **表无限增长**。内网部署跑上一年半载，没人碰过的过期会话
 *      堆在那儿，而回收站是有定时清扫的 —— 同一个库里两种待遇。
 *   ② **语义不干净**：一条 30 天前就该失效的凭据还在库里躺着。
 *      今天 `userFromToken` 会挡住它；哪天有人动那行判断，
 *      这批僵尸凭据立刻变成**真实的越权入口**，而且没人知道它们在那儿。
 *
 * `limit` 限量删：一轮只清一批，别在用户正编辑的时候长时间占着写锁
 * —— 和回收站那个定时器是同一个理由。
 */
export function purgeExpiredSessions(limit = 200): number {
  return Number((db.prepare(
    'DELETE FROM sessions WHERE token IN (SELECT token FROM sessions WHERE expiresAt < ? LIMIT ?)',
  ).run(Date.now(), limit) as { changes?: number }).changes || 0)
}

/** 由 token 解析当前用户；过期会话顺手清掉 */
export function userFromToken(token: string | null): User | null {
  if (!token) return null
  const s = db.prepare('SELECT userId, expiresAt FROM sessions WHERE token = ?').get(token) as Row | undefined
  if (!s) return null
  if (Number(s.expiresAt) < Date.now()) {
    destroySession(token)
    return null
  }
  const u = db.prepare('SELECT id, name, account, role, avatar FROM users WHERE id = ?').get(s.userId) as Row | undefined
  if (!u) return null
  return { id: String(u.id), name: String(u.name), account: String(u.account), role: String(u.role), avatar: String(u.avatar || '') }
}

/** 从请求头取 token：优先 Authorization，兼容 Cookie（内网走网关时常用） */
export function extractToken(req: { headers: Record<string, any> }): string | null {
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim()
  const cookie = req.headers['cookie']
  if (typeof cookie === 'string') {
    const m = /(?:^|;\s*)yq_token=([^;]+)/.exec(cookie)
    if (m) return decodeURIComponent(m[1])
  }
  return null
}

/**
 * 客户端 IP。
 *
 * ⚠️ `X-Forwarded-For` **是请求方自己写的**，服务端**无从验证**。
 * 而它一路喂给三处：
 *   · `ipAllowed()` —— 知识库的 **IP 白名单**（7.29 刚补齐全部 5 条路径）
 *   · 分享页水印上的「阅读人 IP」—— 水印的作用正是「追得到人」
 *   · `sessions.ip`（只写不读，所以不构成实际漏洞，但记录会失真）
 *
 * 实测（探针，2026-10-05）：白名单开着、名单里是 `10.9.9.9`、服务真在 `127.0.0.1`
 *   · 真 IP 请求                       → 读到 **0 篇**（白名单生效）
 *   · `X-Forwarded-For: 10.9.9.9`     → 读到 **10 篇**（**绕过**）
 *
 * 所以**「服务不可被直连」是这个设置能成立的前提** ——
 * 一旦 8080 能被直接访问，白名单就等于没有。
 *
 * ------------------------------------------------------------
 * `YQ_TRUST_PROXY` 是给「服务确实可能被直连」的场景准备的
 * ------------------------------------------------------------
 * 设成 `0` 时**完全不信这个头**，一律用 TCP 层的 `remoteAddress`。
 *
 * **默认仍然是「信」**，所以现有部署升级后**行为一个字都不变** ——
 * 这一条是刻意的：默认改成不信，会让所有已有反代部署的
 * IP 白名单、会话记录、水印同时变成 `127.0.0.1`，那才是真正的破坏性变更。
 *
 * **两种模式各自适合什么**（DEPLOY 第四节有对应说明）：
 *   · 服务**只**绑 `127.0.0.1`、由同机反代转进来 → 用默认值，XFF 来自你自己的反代
 *   · 服务**能被别人直连**（哪怕只在内网） → `YQ_TRUST_PROXY=0`，
 *     代价是所有人都会被记成反代的地址，**白名单得填那个地址**。
 *     这不是「更安全的默认」，只是「把选择权交回给部署者」。
 */
export function clientIp(req: any): string {
  if (process.env.YQ_TRUST_PROXY === '0') {
    return String(req.socket?.remoteAddress || 'unknown')
  }
  // `YQ_TRUSTED_PROXY_IPS` 和 SSO 头**共用**一套判据：
  // 「这个请求头是谁写的」是同一个问题，不该有两套答案 ——
  // 配置了列表却只挡住 SSO 不挡 IP（或反过来），
  // 就会得到「登录安全了、但 IP 白名单还是能被绕」这种半修状态。
  if (!fromTrustedProxy(req)) {
    return String(req.socket?.remoteAddress || 'unknown')
  }
  // 内网通常在 nginx 后面，优先取 X-Forwarded-For 的第一段
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff) return xff.split(',')[0].trim()
  return String(req.socket?.remoteAddress || 'unknown')
}
