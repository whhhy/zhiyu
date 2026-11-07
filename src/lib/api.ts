/* ============================================================
   服务端接入 —— 能力探测 / 会话 / API 客户端
   ------------------------------------------------------------
   这一层要同时支持两种运行形态，因为公司内网的实际情况是两种都有：

   · **服务端模式**：连着 node 服务，登录、权限、跨设备同步、实时协同全都有。
   · **本地模式**：纯静态托管（就是原来那套），数据在浏览器里。
     演示、界面走查、断网演示时用它。

   启动时打一次 /api/health 决定走哪条路。探测不出来就退回本地模式，
   绝不能因为服务端没起来就白屏 —— 演示不能被部署环境绑架。
   ============================================================ */

import type { AppData, BookInvite, Member } from '@/types'

export type Mode = 'server' | 'local'

export interface ServerInfo {
  ok: boolean
  users: number
  docs: number
  ts: number
  sso?: boolean
  ssoOnly?: boolean
}

const TOKEN_KEY = 'yq_token'

/**
 * 记住「这台机器连过服务端」。
 *
 * 探测失败时要靠它区分两种完全不同的情况：
 *   · 本来就没有服务端（本地演示）—— 回落本地是对的
 *   · **本来有服务端，现在连不上了**（重启、网络抖动、反代挂了）——
 *     这时候回落本地是**危险的**
 */
const MODE_HINT = 'yq_mode_hint'

/* ------------------------------------------------------------
   会话失效通知
   ------------------------------------------------------------
   单独一个订阅机制，而不是让每个调用方自己判断 401：
   401 会出现在很多地方（同步推送、附件、搜索、成员列表…），
   谁碰到谁清令牌，结果是**没有任何一个地方负责把界面送回登录页**。
   这里集中发一次事件，AppGate 订阅它。
   ------------------------------------------------------------ */
const expiredListeners = new Set<() => void>()

export function onSessionExpired(cb: () => void): () => void {
  expiredListeners.add(cb)
  return () => { expiredListeners.delete(cb) }
}

function notifySessionExpired() {
  for (const cb of [...expiredListeners]) {
    try { cb() } catch { /* 某个订阅者坏了不该影响别人 */ }
  }
}

let mode: Mode = 'local'
let token: string | null = null
let base = ''

try { token = localStorage.getItem(TOKEN_KEY) } catch { /* 隐私模式 */ }

export const getMode = (): Mode => mode
export const getToken = (): string | null => token
export const isAuthed = (): boolean => !!token

export function setToken(t: string | null) {
  token = t
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* 存不下就只活在内存里，刷新需重新登录 */
  }
  /**
   * 同时落一份 cookie。
   *
   * 原因很实际：`<img src>` / `<video src>` / `<a download>` 都不会带
   * Authorization 头，而附件是要鉴权下载的。浏览器的同源请求会自动带上 cookie，
   * 服务端 `extractToken` 本来就读它 —— 于是图片能正常显示，
   * 不用为了图片去搞签名 URL 那一套。
   *
   * SameSite=Lax：同源导航会带上，跨站跳转不会。
   * 内网部署是同源的（或者经网关反代到同源），所以够用。
   */
  try {
    if (t) {
      document.cookie = `${TOKEN_KEY}=${encodeURIComponent(t)}; path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`
    } else {
      document.cookie = `${TOKEN_KEY}=; path=/; Max-Age=0`
    }
  } catch {
    /* 隐私模式下 cookie 可能不可写，那图片就走不了鉴权，属可接受的降级 */
  }
}

/** 同源部署时 base 为空；拆成 nginx + :8080 时由构建期变量指定 */
export function apiBase(): string {
  if (base) return base
  const injected = (import.meta as any).env?.VITE_API_BASE
  base = typeof injected === 'string' ? injected.replace(/\/$/, '') : ''
  return base
}

/* ============================================================
   HTTP
   ============================================================ */

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    ...(init.headers as Record<string, string> | undefined),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'

  let res: Response
  try {
    res = await fetch(apiBase() + path, { ...init, headers })
  } catch (e) {
    throw new ApiError('无法连接服务器，请检查网络或服务是否在运行', 0)
  }

  const text = await res.text()
  let data: any = null
  try { data = text ? JSON.parse(text) : null } catch { data = null }

  if (!res.ok) {
    /**
     * 401 = 会话失效。除了清令牌，**必须通知界面**。
     *
     * 之前只做了 `setToken(null)`，而没有任何人据此把界面送回登录页。
     * 后果（实测过）：会话作废 → 写入被 401 拒 → 令牌被清 →
     * **应用照常渲染、没有登录页、同步提示栏是空的** ——
     * 用户拿到的反馈是零。他会接着编辑，而每一次写入都被静默拒绝，
     * 改动堆在本地；等他真登录时 `clearLocalSnapshot()` 把它删掉。
     *
     * 这和「服务连不上」是**同一条数据丢失链路**的不同入口，
     * 而这条更容易撞上：`办理离职` 本身就会清空该同事的全部会话。
     */
    if (res.status === 401) {
      setToken(null)
      notifySessionExpired()
    }
    throw new ApiError(data?.error || `请求失败（${res.status}）`, res.status)
  }
  return data as T
}

export const api = {
  get: <T,>(p: string) => request<T>(p),  post: <T,>(p: string, body?: any) =>
    request<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  /**
   * 走 request() 而不是裸 fetch：401 时它会清 token 并交给上层跳登录页。
   * 裸 fetch 会漏掉这一步 —— 会话过期之后界面还装作一切正常，
   * 直到用户下一次点「保存」才看到一个莫名其妙的失败。
   */
  /**
   * body 是**后来加的可选参数**（2026-10-16，删空间要传口令）。
   * 现有调用点全都只传路径，行为不变 —— 但别把它写成必填：
   * `del(p, body)` 里 `body` 一旦必填，`deleteBookRemote` 那类
   * 「DELETE 无请求体」的调用点会集体红，而红的原因和它们本身无关。
   */
  del: <T,>(p: string, body?: any) =>
    request<T>(p, { method: 'DELETE', body: body === undefined ? undefined : JSON.stringify(body) }),
  /** 局部更新。改资料走它：PUT 的语义是「整份替换」，用在只改三个字段上会出事 */
  patch: <T,>(p: string, body?: any) =>
    request<T>(p, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
}

/* ============================================================
   文档之间的引用
   ============================================================ */

export type DocLinkRef = { id: string; title: string; bookId: string }

/**
 * 反向链接：哪些文档引用了这一篇。
 *
 * 语雀「双向引用」里能反向看到的那一半。没有它，一份规范里链出去的
 * 几份文档是**单向**的绳 —— 被引用的那篇不知道自己被谁依赖，
 * 改了接口没人知道要去同步。
 *
 * 只在服务端模式下问；本地模式没有服务端，也就无从知道别处的文档
 * 链到了这里。返回空数组而不是抛错，是为了让调用方不必分支。
 */
export async function fetchBacklinks(docId: string): Promise<DocLinkRef[]> {
  if (!docId || getMode() === 'local') return []
  try {
    const r = await request<{ backlinks?: DocLinkRef[] }>(`/api/doc/${docId}/backlinks`)
    return r?.backlinks || []
  } catch {
    // 拉不到就显示成「没有」，而不是把整篇文档的渲染拖垮
    return []
  }
}

/** 出链：这篇文档引用了谁 */
export async function fetchOutlinks(docId: string): Promise<DocLinkRef[]> {
  if (!docId || getMode() === 'local') return []
  try {
    const r = await request<{ links?: DocLinkRef[] }>(`/api/doc/${docId}/links`)
    return r?.links || []
  } catch {
    return []
  }
}

/* ============================================================
   能力探测
   ============================================================ */

let probed: Promise<Mode> | null = null

/**
 * 「探测失败，但本来是有服务端的」。
 *
 * 之前 probe() 一失败就静默回落本地模式，链条是这样的：
 *   服务重启的 2 秒空窗 → 用户看到的是**本地那份数据**（甚至演示种子）
 *   → SyncStatus 因为「本地模式」**不显示任何离线提示**
 *   → 用户以为在编辑真实知识库，照常写了一通
 *   → 服务恢复后重新进 AppGate，第 33 行 clearLocalSnapshot()
 *   → **他这期间的修改被直接删掉**
 *
 * 一次网络抖动造成真实数据丢失，而且全程界面上看不出任何异常。
 */
let unreachable = false

export function serverUnreachable() { return unreachable }

/** 曾经连过服务端的证据：要么手里有令牌，要么上次探测确认过是服务端形态 */
function hadServerBefore(): boolean {
  try {
    if (localStorage.getItem(TOKEN_KEY)) return true
    return localStorage.getItem(MODE_HINT) === 'server'
  } catch {
    return false
  }
}

/** 重新探测（离线页的「重试」按钮用；probed 的结果是要缓存的） */
export function reprobe(): Promise<Mode> {
  probed = null
  unreachable = false
  return probe()
}

/**
 * 只探一次，结果缓存。
 * 2.5 秒超时：内网服务没起来时不能让整个应用干等。
 */
export function probe(): Promise<Mode> {
  if (probed) return probed
  probed = (async () => {
    try {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), 2500)
      const res = await fetch(apiBase() + '/api/health', { signal: ctl.signal })
      clearTimeout(timer)
      if (!res.ok) { mode = 'local'; unreachable = hadServerBefore(); return mode }
      const info = (await res.json()) as ServerInfo
      mode = info && info.ok ? 'server' : 'local'
      if (mode === 'server') {
        unreachable = false
        try { localStorage.setItem(MODE_HINT, 'server') } catch { /* 隐私模式 */ }
      } else {
        unreachable = true
      }
      ssoOn = !!info?.sso
      ssoOnlyOn = !!info?.ssoOnly
    } catch {
      mode = 'local'
      unreachable = hadServerBefore()
    }
    return mode
  })()
  return probed
}

/** 强制指定模式（演示 / 测试用） */
export function forceMode(m: Mode) {
  mode = m
  probed = Promise.resolve(m)
}

/* ============================================================
   登录相关
   ============================================================ */

export interface AuthUser {
  id: string
  name: string
  account: string
  role: string
  avatar?: string
  /**
   * 密码最后修改时间（毫秒）。**没改过就是 null**。
   * 设置页原来写死「上次修改于 3 个月前」—— 系统里根本没有这个时间，
   * 所有人看到的都是 3 个月前，包括**今天刚改完密码**的人。
   */
  passwordChangedAt?: number | null
}

export const login = (account: string, password: string) =>
  api.post<{ token: string; user: AuthUser }>('/api/auth/login', { account, password })
    .then((r) => { setToken(r.token); return r.user })

export const register = (account: string, password: string, name: string) =>
  api.post<{ token: string; user: AuthUser }>('/api/auth/register', { account, password, name })
    .then((r) => { setToken(r.token); return r.user })

/**
 * 统一认证登录：请求体是空的，身份由网关写在请求头里。
 *
 * 前端**不参与**这件事 —— 它没法验证那个头是不是真的，
 * 所以这里只负责把「已经验过的人」换成一张普通会话令牌，
 * 之后所有请求照常带 Authorization，跟密码登录没有任何区别。
 * 没开统一认证时服务端返回 404，这里就当没试过。
 */
export const ssoLogin = () =>
  api.post<{ token: string; user: AuthUser }>('/api/auth/sso')
    .then((r) => { setToken(r.token); return r.user })

/** 服务端是否开着统一认证 / 是否只允许统一认证（由 /api/health 告知） */
let ssoOn = false
let ssoOnlyOn = false
export const serverSso = () => ssoOn
export const serverSsoOnly = () => ssoOnlyOn

/* ============================================================
   登录设备（语雀的「帐户安全 → 登录设备」）
   ------------------------------------------------------------
   `ref` 是服务端给的**不透明标识**，不是令牌 ——
   服务端那边 `sessions` 的主键就是 token，所以它绝不会把 token 发过来
   （主键发出去等于把别的设备的凭据交出去）。
   前端也只是**原样传回**这个 ref，不做解析、不做拼接。
   ============================================================ */
export type SessionRow = {
  ref: string
  ua: string
  ip: string
  createdAt: number
  expiresAt: number
  expired: boolean
  current: boolean
}
export const listSessions = () => api.get<{ sessions: SessionRow[] }>('/api/auth/sessions').then((r) => r.sessions || [])
export const revokeSession = (ref: string) => api.del(`/api/auth/sessions/${encodeURIComponent(ref)}`)

/**
 * 我的安全记录（语雀的「帐户安全 → 安全记录」）。
 *
 * ⚠️ 和管理员那份**不是同一个接口**：`/api/audit` 只有 owner/admin 能看，
 * 而这条只给「我自己做过的那几类安全动作」。所以这里没有任何筛选参数 ——
 * 能传 `actorId` 的接口早晚会变成「帮你读别人日志」的探针。
 */
export type SecurityLogRow = {
  at: number
  action: string
  label: string
  targetType: string
  targetName: string
  detail: unknown
}
export const listMySecurityLog = () => api.get<{ items: SecurityLogRow[] }>('/api/auth/security-log').then((r) => r.items || [])

export const logout = async () => {
  try { await api.post('/api/auth/logout') } catch { /* 令牌本来就失效了也算成功 */ }
  setToken(null)
}

export const me = () => api.get<{ user: AuthUser }>('/api/auth/me').then((r) => r.user)

/* ============================================================
   数据
   ============================================================ */

export const bootstrap = () =>
  api.get<{ data: Record<string, any[]>; seq: number }>('/api/bootstrap')

export const pullChanges = (since: number) =>
  api.get<{ seq: number; upsert: Record<string, any[]>; remove: Record<string, string[]>; more?: boolean }>(
    `/api/sync/changes?since=${since}`,
  )

export interface PushResult {
  applied: { entity: string; id: string; rev: number }[]
  rejected: { entity: string; id: string; reason: string }[]
  seq: number
}

export const pushChanges = (upsert: Record<string, any[]>, remove: Record<string, string[]>) =>
  api.post<PushResult>('/api/sync/push', { upsert, remove })

/** 服务端判定的权限：前端不自己算，灰不灰、能不能点都以这个为准 */
export const bookPerms = (bookId: string) =>
  api.get<{ caps: Record<string, boolean> }>(`/api/perms/book/${bookId}`).then((r) => r.caps)

export const docPerms = (docId: string) =>
  api.get<{ caps: Record<string, boolean> }>(`/api/perms/doc/${docId}`).then((r) => r.caps)

/**
 * 空间级的能力（2026-10-12 补）。
 *
 * 「能不能在这个空间里**建知识库**」判的是 `capsInSpace().admin`，
 * 而之前只有 book 一个接口 —— 拿空间 id 去问它会得到**全 false**，
 * 于是空间管理员的「新建知识库」按钮消失，而服务端其实放他过。
 */
export const spacePerms = (spaceId: string) =>
  api.get<{ caps: Record<string, boolean> }>(`/api/perms/space/${spaceId}`).then((r) => r.caps)

/**
 * 上报一次阅读。
 *
 * 服务端按 (文档, 天, 人) 去重，所以同一个人打开多少次都只算一次 ——
 * 统计里的「浏览量」指的是「有多少人今天看了它」，不是页面刷新次数。
 * 失败必须静默：统计上报不值得打断阅读。
 */
export const recordDocView = (docId: string) =>
  api.post('/api/doc/' + docId + '/view').catch(() => { /* 统计上报失败不影响阅读 */ })

export interface BookStats {
  visitors: number
  views: number
  days: { day: string; value: number }[]
}

export const bookStats = (bookId: string) => api.get<BookStats>(`/api/book/${bookId}/stats`)

/**
 * 新建团队空间。
 *
 * 走服务端而不是同步，因为 `space_members` 不在同步实体清单里：
 * 客户端推上去的空间没有成员行，服务端会判「谁建的谁进不去」。
 */
export const createSpaceRemote = (name: string, desc = '') =>
  api.post<{ space: AppData['spaces'][number] }>('/api/spaces', { name, desc })

/* ---- 空间成员（`space_members` 不在同步清单里，只能走接口）---- */

/* ---- 操作日志（审计）---- */

export interface AuditItem {
  id: string
  at: number
  actorId: string
  actorName: string
  action: string
  targetType: string
  targetId: string
  targetName: string
  detail: any
}

/** 只给管理员。普通成员调这个接口会被服务端 403。 */
export const auditLog = (opts: { limit?: number; action?: string; actorId?: string } = {}) => {
  const q = new URLSearchParams()
  if (opts.limit) q.set('limit', String(opts.limit))
  if (opts.action) q.set('action', opts.action)
  if (opts.actorId) q.set('actorId', opts.actorId)
  const qs = q.toString()
  return api.get<{ items: AuditItem[]; actions: string[] }>(`/api/audit${qs ? '?' + qs : ''}`)
}

export type AccessItem = {
  docId: string
  docTitle: string
  bookId: string
  bookName: string
  userId: string
  userName: string
  userAccount: string
  day: string
  firstAt: number
}

/**
 * 访问日志：谁在什么时候看过哪些文档。
 *
 * 和「操作日志」是**两回事**：那边答「谁改了什么」，这边答「谁翻过什么」。
 * 涉密文档的访问复核要的是后者 —— 等保 / ISO 27001 检查里常被点名。
 *
 * **粒度是天**，不是秒：同一人同一天看同一篇只记一次（否则刷新页面就能把
 * 访问量灌水），所以 `firstAt` 是当天**首次**阅读的时刻。界面上照实这么写，
 * 不让人对着一个「14:23」以为那是精确的打开时间。
 *
 * 只给管理员。普通成员调它会被服务端 403 —— 访问日志能回答「谁翻过这份
 * 薪酬方案」，普通成员拿到它等于拿到一份「大家在看什么」的地图。
 */
export const accessLog = (opts: { limit?: number; days?: number; bookId?: string; userId?: string } = {}) => {
  const q = new URLSearchParams()
  if (opts.limit) q.set('limit', String(opts.limit))
  if (opts.days) q.set('days', String(opts.days))
  if (opts.bookId) q.set('bookId', opts.bookId)
  if (opts.userId) q.set('userId', opts.userId)
  const qs = q.toString()
  return api.get<{ items: AccessItem[]; granularity: string; note: string }>(`/api/accesslog${qs ? '?' + qs : ''}`)
}

/** 动作名的中文说法。与服务端 AUDIT_LABEL 对应，服务端没给就退回原值 */
export const AUDIT_LABEL: Record<string, string> = {
  'space.member.add': '加入空间成员',
  'space.member.remove': '移出空间成员',
  'book.member.add': '添加知识库成员',
  'book.member.remove': '移除知识库成员',
  'data.export': '导出数据',
  'user.offboard': '办理离职',
  'user.password.change': '修改密码',
  'doc.purge': '彻底删除',
  'book.settings.change': '修改知识库设置',
  'token.create': '创建访问令牌',
  'token.revoke': '撤销访问令牌',
  'doc.share': '修改对外分享设置',
}

/* ============================================================
   单篇文档的对外分享
   ------------------------------------------------------------
   分享弹窗里「互联网 + 访问密码 + 有效期 + 允许下载」这一组，
   以前**全都不落库**（允许下载只改了组件局部 state）。
   现在服务端有 `doc_share` 表真正存着，这三个字段是对着它读写。
   ============================================================ */

export interface DocShare {
  hasPassword: boolean
  /** 0 = 永不过期 */
  expiresAt: number
  expired: boolean
  allowDownload: boolean
  updatedAt: number
}

export const getDocShare = (docId: string) =>
  api.get<{ share: DocShare }>(`/api/doc/${encodeURIComponent(docId)}/share`)

/** password 传 null 或空串 = 取消密码；不传这个字段 = 保持原样 */
export const setDocShare = (docId: string, input: { password?: string | null; expiresInDays?: number; allowDownload?: boolean }) =>
  api.post<{ ok: true; share: DocShare }>(`/api/doc/${encodeURIComponent(docId)}/share`, input)

/* ============================================================
   访问令牌（个人 API Token）
   ------------------------------------------------------------
   只列**不含凭据**的字段，`tokenHash` 服务端根本不发下来，
   `prefix` 是明文前 12 位 —— 界面上靠它认出「哪一把」。
   ============================================================ */

export interface ApiToken {
  id: string
  name: string
  prefix: string
  scopes: ('read' | 'write')[]
  createdAt: number
  lastUsedAt: number
  /** 0 = 永不过期 */
  expiresAt: number
  revokedAt: number
  status: 'active' | 'expired' | 'revoked'
}

export const listTokens = () => api.get<{ tokens: ApiToken[] }>('/api/tokens')

/** 返回值里的 `token` 是**唯一一次**能拿到明文的机会，界面上必须说清楚这一点 */
export const createToken = (input: { name: string; scopes: ('read' | 'write')[]; days: number }) =>
  api.post<ApiToken & { token: string; warning: string }>('/api/tokens', input)

export const revokeToken = (id: string) => api.del<{ ok: true }>(`/api/tokens/${id}`)

export interface SpaceMember {
  userId: string
  name: string
  account: string
  avatar: string
  role: 'owner' | 'admin' | 'member'
  joinedAt: number
}

export const spaceMembers = (spaceId: string) =>
  api.get<{ members: SpaceMember[]; isAdmin: boolean }>(`/api/spaces/${spaceId}/members`)

export interface AddSpaceMemberResult {
  userId: string
  account: string
  role: string
  /** 顺带补上的这个空间里**现有**知识库的只读身份数量 */
  grantedBooks: number
}

/**
 * 一次加一批。逐个独立提交：某个人失败不影响其他人，
 * `failed` 如实带回，不要在前端假装「全成功了」。
 */
export const addSpaceMember = (
  spaceId: string,
  userIds: string[],
  role: 'admin' | 'member' = 'member',
) =>
  api.post<{ ok: boolean; added: AddSpaceMemberResult[]; failed: { userId: string; error: string }[] }>(
    `/api/spaces/${spaceId}/members`, { userIds, role },
  )

export interface RemoveSpaceMemberResult {
  ok: boolean
  removed: number
  /** 一并收回的该空间内各知识库身份数量 */
  clearedBooks: number
}

export const removeSpaceMember = (spaceId: string, userId: string) =>
  api.del<RemoveSpaceMemberResult>(`/api/spaces/${spaceId}/members/${userId}`)

/* ---------------- 删除空间 / 撤销删除（2026-10-16，照真实语雀补） ----------------
   语雀官方《如何删除空间》：空间管理员在「空间管理-空间设置-高级设置」里删除，
   「需要验证之后删除：删除操作后 24 小时内可以进行撤销，超过 24 小时即确认」。
   所以这里**必须带口令**，返回里**必须带 undoUntil** ——
   界面要靠它告诉用户「还剩多久能反悔」，没有它就只剩一句「已删除」。 */

/** `undoUntil` = 撤销窗口的截止时刻（毫秒）；0 表示这次没有进入窗口 */
export interface DeleteSpaceResult {
  ok: boolean
  /** 一起被删掉的知识库数量 —— 删之前要告诉用户这个数 */
  deletedBooks?: number
  undoUntil?: number
  undoHours?: number
  alreadyDeleted?: boolean
}

/**
 * 删除空间。`password` 是**当前登录用户的口令**，服务端会验。
 * 被拒时 api 层会抛，调用方负责把服务端那句理由原样说出来。
 */
export const deleteSpace = (spaceId: string, password: string) =>
  api.del<DeleteSpaceResult>(`/api/spaces/${spaceId}`, { password })

/** 撤销删除。只有空间管理员能撤，且只在 24 小时窗口内有效 */
export const restoreSpace = (spaceId: string) =>
  api.post<{ ok: boolean; restored: boolean }>(`/api/spaces/${spaceId}/restore`, {})

/* ---------------- 知识库邀请（2026-10-11） ---------------- */

/**
 * 发起邀请。
 *
 * `alreadySent` 是**正常返回**而不是错误：已经有待处理邀请时回它，
 * 不报错也不重复插 —— 报错在界面上就是一句红字，用户会以为出错了；
 * 而重复插会让对方待办里出现两条一样的。
 */
export const inviteToBook = (bookId: string, userId: string, role: 'reader' | 'editor' = 'reader', message = '') =>
  api.post<{ ok: boolean; inviteId: string; alreadySent: boolean }>(
    `/api/books/${bookId}/invites`, { userId, role, message },
  )

/** 我收到的待处理邀请（顶栏红点与工作台待办都靠它） */
export const myBookInvites = () =>
  api.get<{ ok: boolean; invites: BookInvite[] }>('/api/invites')

/** 接受 / 拒绝。服务端返回接受后拿到的 bookId 与角色 */
export const respondBookInvite = (inviteId: string, accept: boolean) =>
  api.post<{ ok: boolean; status: string; bookId?: string; role?: string }>(
    `/api/invites/${inviteId}/respond`, { accept },
  )

/** 撤回（邀请人本人或该库管理员） */
export const revokeBookInvite = (inviteId: string) =>
  api.del<{ ok: boolean; status: string }>(`/api/invites/${inviteId}`)

/**
 * 办理离职：清会话、撤 API 令牌、移出空间、按各库的开关收回知识库权限，**并降权**
 *
 * ⚠️ `roleBefore` / `roleAfter` / `accountDisabled` 是补上的。
 * 服务端原来**不碰 `role`**，于是离职的管理员重新登录回来**仍是管理员** ——
 * 能改 members、能给别人办离职。7.31 修掉了。
 *
 * `accountDisabled` 恒为 `false`：账号**没有被停用**，他仍能登录
 * （只是不再是管理员、也不再是任何空间的成员）。
 * 真正停用需要 `users.disabled`，那是新功能，不在这里假装它存在。
 */
export interface OffboardResult {
  ok: boolean
  account: string
  name: string
  sessions: number
  spaces: number
  tokens?: number
  revokedBooks: number
  keptBooks: number
  keptBookIds: string[]
  /** 降权前的平台角色（owner 不会走到这里） */
  roleBefore?: string
  roleAfter?: string
  /** 恒为 false：账号没有被停用，仍然可以登录 */
  accountDisabled?: boolean
}

export const offboardUser = (userId: string) =>
  api.post<OffboardResult>(`/api/users/${userId}/offboard`)

/**
 * 修改密码。
 *
 * 服务端会**清掉其他所有会话** —— 改密码的意义就是把可能已经泄露出去的
 * 访问挡在门外，不清会话的话偷到密码的人手上的令牌照样能用。
 * 返回值告诉前端清了多少个会话，好如实告诉用户。
 */
export const changePassword = (oldPassword: string, newPassword: string) =>
  api.post<{ ok: boolean; otherSessionsClosed: number }>('/api/auth/password', { oldPassword, newPassword })

/**
 * 改自己的资料。
 *
 * **走服务端而不是 sync push**：members 实体那条路的 `denyReason`
 * 要求平台管理员 —— 改自己的昵称显然不该要管理员权限，
 * 放松那道口子又会变成「谁都能改所有人」。所以这是一个只针对「自己」的窄接口。
 *
 * **账号不在这里**：服务端不接受 account 字段。
 * 理由写在 server/index.ts 那个接口的注释里（登录名 + 审计一致性 + SSO 会被覆盖）。
 * 这里如实只暴露三个字段，不给界面一个「传了也不生效」的口子。
 */
export interface MyProfile {
  name: string
  email: string
  bio: string
  /**
   * 头像 = attachments 里那条记录的 **id**（不是 URL、不是 data URL）。
   *
   * ⚠️ 为什么是 id：一张 200KB 的图直接存进 users 表 → 进同步实体 →
   *    每台设备每次 bootstrap 都带着它转一圈，写进 localStorage 也撑不住。
   *    空串表示「用首字母头像」。
   */
  avatar: string
}

export const updateMyProfile = (patch: Partial<MyProfile>) =>
  api.patch<{ ok: boolean; user: { id: string } & MyProfile }>('/api/users/me', patch)

/**
 * 从回收站恢复。
 * 必须由服务端做 —— 客户端早就没有那份正文了（软删除时从 store 移除了），
 * 让它回传只会得到一个空壳。
 */
export const restoreDoc = (docId: string) =>
  api.post<{ ok: boolean; doc: any }>(`/api/doc/${encodeURIComponent(docId)}/restore`)

/** 彻底删除：真正不可逆 */
export const purgeDoc = (docId: string) =>
  api.post<{ ok: boolean }>(`/api/doc/${encodeURIComponent(docId)}/purge`)

/**
 * 删除知识库：**硬删**，连带它下面所有文档一起没了，**不可恢复**。
 *
 * 为什么不给「进回收站」这个选项：语雀的回收站只到文档一级，
 * 本项目的回收站也一样（`trash` 表存的是 docId）。
 * 「删库 = 把库里文档全塞进回收站」看起来更安全，实际会留下一批
 * 点不动的孤儿文档 —— 恢复单篇时它指向的知识库已经没了。
 *
 * 所以文案必须说死「不可恢复」，不能写「已移入回收站」。
 */
export const deleteBookRemote = (bookId: string) =>
  api.del<{ ok: boolean; purgedDocs: number }>(`/api/book/${encodeURIComponent(bookId)}`)

/**
 * 清空回收站。**管理员**才能调。
 *
 * 逐篇走服务端那个 `purgeDoc`：索引、版本、trash 行、变更记录都由它负责。
 * 返回清掉了几篇、哪几篇没权限 —— 失败的部分**不能假装成功**。
 */
/**
 * 改某个人的**平台角色**。
 *
 * 不走 sync push：`members` 的 writable 里刻意没有 `role` ——
 * 那条路一开放，「拿到 admin 就能把同伙提成 admin」，而 sync push
 * 也表达不了「不能改自己 / 不能降掉最后一个 owner」这两条。
 */
/**
 * 把文档移到 / 复制到另一个知识库。
 *
 * `move` 是搬走（原库那篇消失），`copy` 是留一份（原库还在）。
 * 服务端会判两边权限、两个库都重算检索索引、目录节点跟着换库。
 */
export const moveDoc = (docId: string, bookId: string, mode: 'move' | 'copy') =>
  api.post<{ ok: true; docId: string; nodeId: string }>(`/api/doc/${encodeURIComponent(docId)}/move`, { bookId, mode })

export const setUserRole = (userId: string, role: 'member' | 'admin') =>
  api.post<{ ok: boolean; role: string; name?: string }>(`/api/users/${encodeURIComponent(userId)}/role`, { role })

/**
 * 回收站保留期（天）。
 *
 * 界面上那个「还剩 N 天」倒计时按它算。
 * 以前是前端**写死 30**，而服务端根本没有清除任务 —— 那句话没有对应实现。
 * 现在服务端真会清（YQ_TRASH_DAYS 可配），这个数就得跟着从服务端问，
 * 否则部署时改了保留期、界面还在说 30 天。
 */
export const trashRetention = () =>
  api.get<{ days: number; note: string }>('/api/trash/retention')

export const purgeAllTrash = () =>
  api.post<{ ok: boolean; purged: number; purgedIds: string[]; failed: { docId: string; reason: string }[] }>('/api/trash/purge-all')

/* ============================================================
   附件
   ============================================================ */

/**
 * 上传附件。
 * 中文文件名不能直接放 HTTP 头（头只允许 latin1），要 encodeURIComponent 编码后传，
 * 服务端再解回来 —— 这就是 X-Filename 这个头存在的全部理由。
 */
export async function uploadAttachment(file: File, docId: string, blockId?: string) {
  const res = await fetch(
    `${apiBase()}/api/attachment?docId=${encodeURIComponent(docId)}${blockId ? `&blockId=${encodeURIComponent(blockId)}` : ''}`,
    {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': file.type || 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
      },
      body: file,
    },
  )
  if (!res.ok) throw new ApiError('附件上传失败', res.status)
  return res.json() as Promise<{ id: string; name: string; size: number; mime: string; url?: string }>
}

export const attachmentUrl = (id: string) => `${apiBase()}/api/attachment/${id}`

/* ---------------- 头像（2026-10-11） ---------------- */

/**
 * 上传头像。**两步走**：先传文件拿 id，再 PATCH /api/users/me 引用它 ——
 * 和「先传附件再插进文档」是同一条路，不另造机制。
 *
 * ⚠️ 通道与附件一致：裸 body + Content-Type，**不是 multipart**。
 *    二进制走 multipart 的话服务端要多一层解析，而这里没有那个需求。
 */
export async function uploadMyAvatar(file: File) {
  const res = await fetch(`${apiBase()}/api/users/me/avatar`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': file.type || 'image/png',
    },
    body: file,
  })
  if (!res.ok) {
    let msg = '头像上传失败'
    try { msg = (await res.json())?.error || msg } catch {}
    throw new ApiError(msg, res.status)
  }
  return res.json() as Promise<{ ok: boolean; avatarId: string; mime: string; size: number }>
}

/**
 * 头像的取图地址。
 *
 * ⚠️ 它需要登录态，所以**不能直接塞进 <img src>** ——
 *    那样浏览器不会带 Authorization 头，会拿到 403。
 *    用法是先 fetch 成 blob 再转 objectURL（见 Settings 里的 avatarUrl）。
 */
export const myAvatarUrl = (id: string) => `${apiBase()}/api/users/me/avatar/${id}`

/**
 * 删一个服务端附件（准确说是「撤掉本文档对它的引用」）。
 *
 * **必须传 docId。** 服务端要靠它做两件事：判权按这篇文档而不是附件的
 * 原始归属，以及判断「除了这篇，还有没有别的文档在用它」。
 * 不传的话服务端只能按老逻辑走，而那条路会无条件删掉二进制 ——
 * 复制出来的副本和原件指向同一个附件，在副本里删一次就会弄坏原件。
 *
 * 返回 `deleted: false` 是**正常结果，不是失败**：这份文件还被别的文档引用，
 * 所以只撤了引用、文件留着。调用方不该把它当错误弹出去。
 * 404 同样当成功：可能别人先删了，或者整篇文档已被永久删除。
 * 其它状态码照实抛 —— 403 意味着**真的没删掉**，必须让用户知道。
 */
export async function deleteRemoteAttachment(id: string, docId?: string): Promise<{ deleted: boolean; keptFor: number }> {
  const q = docId ? `?docId=${encodeURIComponent(docId)}` : ''
  const res = await fetch(`${apiBase()}/api/attachment/${encodeURIComponent(id)}${q}`, {
    method: 'DELETE',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  if (res.status === 404) return { deleted: true, keptFor: 0 }
  if (!res.ok) throw new ApiError('附件删除失败（可能没有删除权限）', res.status)
  const r = (await res.json().catch(() => ({}))) as { deleted?: boolean; keptFor?: number }
  return { deleted: r.deleted !== false, keptFor: Number(r.keptFor || 0) }
}

/**
 * 导出整个工作台。
 *
 * 服务端形态下**必须走服务端**：客户端只有元信息，
 * 打包出来是空壳（实测 26 篇文档、0 个正文块），
 * 拿它当备份等于把知识库清空。
 */
export async function serverExport(): Promise<string> {
  const res = await fetch(`${apiBase()}/api/export`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new ApiError('导出失败', res.status)
  return res.text()
}

/** 导出完整性自查：确认服务端给的包确实带正文 */
export const verifyExport = () =>
  fetch(`${apiBase()}/api/export/verify`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    .then((r) => r.json() as Promise<{ docs: number; withBody: number }>)

/** 导入数据包（服务端逐条判权限） */
export const serverImport = (raw: any, mode: 'merge' | 'replace') =>
  request<{ ok: boolean; counts?: Record<string, number>; rejected?: number }>('/api/import', {
    method: 'POST',
    body: JSON.stringify({ ...raw, mode }),
  })

/**
 * 协作 WebSocket 的地址。
 * token 只能走 query：浏览器 WebSocket API 不允许自定义请求头，
 * 而服务端需要在 upgrade 阶段就完成鉴权（那时还没有 header 可读）。
 * 换来的是 URL 会带上会话令牌，所以这条连接**不能**经过任何会记录
 * 完整 URL 的公共网关日志 —— 内网部署时注意这一点。
 */
export function wsUrl(): string {
  const b = apiBase()
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}${b}/ws?token=${encodeURIComponent(token || '')}`
}

/* ============================================================
   把服务端的扁平行还原成前端的 AppData 形状
   ------------------------------------------------------------
   服务端为了同步方便，一律返回「每种实体一个数组」。
   但前端 store 期望的是：数组给数组、Record 给 Record。
   这个转换只在这里做一处，别散落到各个组件里。
   ============================================================ */

export function rowsToRecord<T extends { id?: string; docId?: string }>(rows: T[], key = 'id'): Record<string, T> {
  const out: Record<string, T> = {}
  for (const r of rows) {
    const k = String((r as any)[key] ?? '')
    if (k) out[k] = r
  }
  return out
}

/**
 * 按父键把行数组分组。
 *
 * key 必须能显式指定：bookMembers 的父键是 **bookId**，不是 docId。
 * 之前这里写死 r.docId，于是知识库成员行全被归到 `out[undefined]` 里，
 * 刷新之后 store 对**每一个**知识库都认为「一个成员都没有」——
 * 权限页显示为空、添加成员对话框里又因为候选人算错而加不进去。
 */
export function rowsBy<T extends { docId: string }>(rows: T[], key = 'docId'): Record<string, T[]> {
  const out: Record<string, T[]> = {}
  for (const r of rows) {
    const k = String((r as any)[key] ?? '')
    if (!k) continue
    ;(out[k] ||= []).push(r)
  }
  return out
}

/**
 * 把回复挂回父评论。
 *
 * 服务端把回复存成独立行（同步按行做），前端要的是嵌套在父评论的 replies 里。
 * **嵌套只在这里做一次**：启动时用本函数，增量应用时也用本函数，
 * 服务端不再另外拼一遍 —— 两处各拼一次的话，迟早只改了一处。
 */
export function nestReplies(
  parentRows: any[],
  replyRows: any[],
  fk: 'commentId' | 'selectionCommentId',
): any[] {
  if (!parentRows.length) return parentRows
  const byParent = new Map<string, any[]>()
  for (const r of replyRows || []) {
    const k = String(r[fk] ?? '')
    if (!k) continue
    if (!byParent.has(k)) byParent.set(k, [])
    byParent.get(k)!.push({ ...r, replies: [] })
  }
  return parentRows.map((p) => {
    const extra = byParent.get(String(p.id))
    const cur = Array.isArray(p.replies) ? p.replies : []
    /**
     * 「一个回复都没有」的父评论也必须带上 `replies: []`。
     *
     * 服务端表里根本没有 replies 这一列，回复是独立的两张行表，
     * 所以刷新之后回来的父评论**天生就没有这个键** ——
     * 而评论面板直接 `c.replies.length`、划词评论面板直接 `c.replies.map`。
     * 症状是：新建一条评论（还没有人回）→ 刷新 → 点开面板 → 整块白掉，
     * 报 `Cannot read properties of undefined`。
     *
     * 为什么一直没被发现：种子数据里每条评论都带至少一条回复，
     * 于是「这个键一定会被建出来」在演示数据上永远成立。
     * 判据要专门造一条**零回复**的评论才算真的验过。
     */
    if (!extra?.length && cur.length) return p
    const seen = new Set(cur.map((r: any) => r.id))
    return { ...p, replies: [...cur, ...(extra || []).filter((r: any) => !seen.has(r.id))] }
  })
}

export function serverDataToAppData(rows: Record<string, any[]>): Partial<AppData> {
  const comments = nestReplies(rows.comments || [], rows.commentReplies || [], 'commentId')
  const selectionComments = nestReplies(
    rows.selectionComments || [], rows.selectionCommentReplies || [], 'selectionCommentId',
  )
  // 服务端 book_members 行的主键是 (bookId, userId)，没有单独的 id；
  // 而前端 BookMember 用的是 id。形状不一致会让差分每次都判定「变了」，
  // 于是每次打开页面都把全部成员关系重推一遍 —— 普通成员当然推不动，
  // 结果是顶栏常驻一条「N 处修改没有保存」，而其实什么都没改。
  const bookMembers = (rows.bookMembers || []).map((r) => ({ ...r, id: r.id ?? r.userId }))
  return {
    spaces: (rows.spaces || []) as any,
    members: (rows.members || []) as unknown as Member[],
    books: (rows.books || []) as any,
    nodes: (rows.nodes || []) as any,
    docs: rowsToRecord(rows.docs || []) as any,
    comments: rowsBy(comments) as any,
    selectionComments: rowsBy(selectionComments) as any,
    notes: (rows.notes || []) as any,
    topics: (rows.topics || []) as any,
    topicReplies: (rows.topicReplies || []) as any,
    templates: (rows.templates || []) as any,
    favorites: (rows.favorites || []) as any,
    follows: (rows.follows || []) as any,
    recents: (rows.recents || []) as any,
    trash: (rows.trash || []) as any,
    bookSettings: rowsToRecord(rows.bookSettings || [], 'bookId') as any,
    bookMembers: rowsBy(bookMembers as any, 'bookId') as any,
  }
}
