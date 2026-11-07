/* ============================================================
   权限模型 —— 服务端真实鉴权
   语雀的层级：空间 → 知识库 → 文稿。
   本实现把它落成一份可判定的权限矩阵，
   关键点：这是**服务端**判的，前端传什么都不能提权。

   角色能力表（与前端 BookMember.role 对齐）：
     owner   全部
     admin   全部（除平台级）
     editor  读 评论 编辑 新建 导出 分享
     reader  读 评论 导出
     visitor 读
   ============================================================ */

import { db } from './db.ts'
import type { Row } from './db.ts'

export type Action = 'read' | 'comment' | 'edit' | 'create' | 'export' | 'share' | 'admin'

/** 角色 → 能力集合 */
const ROLE_CAPS: Record<string, Action[]> = {
  owner: ['read', 'comment', 'edit', 'create', 'export', 'share', 'admin'],
  admin: ['read', 'comment', 'edit', 'create', 'export', 'share', 'admin'],
  editor: ['read', 'comment', 'edit', 'create', 'export', 'share'],
  reader: ['read', 'comment', 'export'],
  visitor: ['read'],
}

export interface User {
  id: string
  name: string
  account: string
  role: string
  avatar: string
}

export interface Caps {
  read: boolean
  comment: boolean
  edit: boolean
  create: boolean
  export: boolean
  share: boolean
  admin: boolean
}

const NONE: Caps = { read: false, comment: false, edit: false, create: false, export: false, share: false, admin: false }

function capsFrom(list: Action[]): Caps {
  const s = new Set(list)
  return {
    read: s.has('read'), comment: s.has('comment'), edit: s.has('edit'),
    create: s.has('create'), export: s.has('export'), share: s.has('share'), admin: s.has('admin'),
  }
}

/* ============================================================
   作用域解析
   ============================================================ */

/** 取一个文稿所属的知识库：优先用冗余列，回落到目录树反查 */
export function bookIdOfDoc(docId: string): string | null {
  const d = db.prepare('SELECT bookId, spaceId FROM docs WHERE id = ?').get(docId) as Row | undefined
  if (d?.bookId) return String(d.bookId)
  const n = db.prepare('SELECT bookId FROM nodes WHERE docId = ? LIMIT 1').get(docId) as Row | undefined
  return n?.bookId ? String(n.bookId) : null
}

export function spaceIdOfBook(bookId: string): string | null {
  const b = db.prepare('SELECT spaceId FROM books WHERE id = ?').get(bookId) as Row | undefined
  return b?.spaceId ? String(b.spaceId) : null
}

/** 空间能力：owner/admin 拿全部，否则只有读 */
export function capsInSpace(user: User, spaceId: string | null): Caps {
  if (!spaceId) return NONE
  if (user.role === 'owner') return capsFrom(ROLE_CAPS.admin)
  const m = db.prepare('SELECT role FROM space_members WHERE spaceId = ? AND userId = ?').get(spaceId, user.id) as Row | undefined
  if (!m) return NONE
  if (m.role === 'owner' || m.role === 'admin') return capsFrom(ROLE_CAPS.admin)
  return capsFrom(['read', 'comment'])
}

/**
 * 知识库能力。
 * 优先级（自上而下短路）：
 *   1. 平台 owner —— 内网超级管理员
 *   2. 空间 owner/admin —— 对空间内所有知识库有全部权限
 *   3. 知识库成员角色 —— 角色给一份基线能力
 *   4. 成员行上的 perms —— 逐项覆盖（语雀的权限矩阵就是这一层）
 *   5. 公开访问 —— 知识库开了 publicAccess 时，未登录以外的人也能只读
 */
export function capsInBook(user: User, bookId: string): Caps {
  if (user.role === 'owner') return capsFrom(ROLE_CAPS.admin)

  const spaceId = spaceIdOfBook(bookId)
  const spaceCaps = capsInSpace(user, spaceId)
  if (spaceCaps.admin) return spaceCaps

  const bm = db.prepare('SELECT role, perms FROM book_members WHERE bookId = ? AND userId = ?')
    .get(bookId, user.id) as Row | undefined

  if (!bm) {
    // 非成员：只在知识库明确开放公开访问时给只读
    const bs = db.prepare('SELECT publicAccess FROM book_settings WHERE bookId = ?').get(bookId) as Row | undefined
    if (bs && bs.publicAccess === 1) return capsFrom(['read'])
    return NONE
  }

  const caps = capsFrom(ROLE_CAPS[String(bm.role)] || ROLE_CAPS.visitor)

  // 逐项覆盖：前端权限矩阵里关掉的项，服务端真的关掉
  let perms: any = {}
  try { perms = JSON.parse(String(bm.perms || '{}')) } catch { perms = {} }
  for (const k of ['read', 'comment', 'edit', 'create', 'export', 'share'] as const) {
    if (perms[k] === false) caps[k] = false
    else if (perms[k] === true) caps[k] = true
  }
  return caps
}

/**
 * 这一篇「仅自己可见」时，**是不是作者本人**。
 *
 * ⚠️ **平台 owner 也不豁免**（这是 2026-10-06 明确决定过的）。
 *
 * 理由：owner 的权限是为了管成员、办离职、看审计、导出整包，
 * 不是为了读别人的私密笔记。而「仅自己可见」这句话的字面意思就是
 * 「只有我自己」—— 一个连字面意思都不兑现的开关，比不给更糟：
 * 作者会以为只有自己能看。
 *
 * 另一种答法（owner 沿用「本来就能读一切」的一致性）也有它的道理，
 * 但那意味着平台最高权限能读到每个人的私密笔记 ——
 * owner 令牌一旦被冒用（DEPLOY 记着「不带任何密码直接登录成那个人」），
 * 整套「仅自己」就形同虚设。
 *
 * 放在这里而不是某一个路由上，是因为**判权点有十几个**
 * （正文 / 版本 / 正反向链接 / 分享 / 能力面板 / 附件 / 导出 / v2 …），
 * 漏一处就是泄漏。`capsOfDoc` 是它们共同的入口。
 */
export function canSeeDocRow(user: User, docId: string): boolean {
  const d = db.prepare('SELECT visibility, authorId FROM docs WHERE id = ?').get(docId) as Row | undefined
  if (!d) return true   // 不存在 → 交给原有的 404 那条路，别在这里变成 403
  if (String(d.visibility) !== 'private') return true
  return String(d.authorId || '') === String(user.id)
}

/**
 * 文稿能力 = 所属知识库能力。
 * 找不到知识库归属时降级为空间能力（孤立文稿仍受空间约束）。
 *
 * 「仅自己可见」判在**最前面**、也就是在 `capsInBook` 的 owner 早退**之前** ——
 * 放后面的话 owner 会被那行早退直接放过去，私有对最高权限失效。
 */
export function capsOfDoc(user: User, docId: string): Caps {
  if (!canSeeDocRow(user, docId)) return NONE
  const bookId = bookIdOfDoc(docId)
  if (bookId) return capsInBook(user, bookId)
  const d = db.prepare('SELECT spaceId FROM docs WHERE id = ?').get(docId) as Row | undefined
  return capsInSpace(user, d?.spaceId ? String(d.spaceId) : null)
}

/**
 * 这一篇现在是不是**被别人锁着**。
 *
 * 锁防的是**编辑冲突**，不是权限 —— 所以它和「谁能编辑」是两件事，
 * 也因此它有自己的判据、也要在**每一条写入路径**上各判一次。
 *
 * 落库那条路（`denyReason`）一直判着；WebSocket 协作通道以前**只判了 `edit`** ——
 * 实测（探针，2026-10-06）：A 持有锁，B（同样是 editor）经协作通道发一条 `content`，
 *   · 落库路：B 的 push 被 `rejected: 文档已被他人锁定`，回读标题没变 ✔
 *   · 协作路：B 的消息**被转发给了锁持有者 A**，而且服务端还把 B 的快照
 *     写进了 `doc_snapshots`（`actorId` 是 B）❌
 *
 * 后果链条很具体：A 的客户端是 CRDT 合并，会把这条 op 应用进去；
 * 等 A 一保存，**B 塞进来的字就落库了** —— 锁被整个绕过去，
 * 而界面上 A 看到的是「我自己在打字」。
 *
 * 这和 IP 白名单那几处是同一个形态：**独立通路不经过上一条的判据**。
 *
 * @param holderId  当前持有者（`docs.lockMemberId`），没锁就是空
 * @param userId   想写的人
 *
 * 名字和前端 `DocPage.tsx` 里那个同名变量是**故意一样的** ——
 * 那是同一个判据（「这篇是不是被别人锁着」），
 * 服务端与客户端用同一个名字，读代码时不用在脑子里做一次映射。
 * （前端那个是布尔变量，这里是函数。）
 */
export function lockedByOther(holderId: unknown, userId: string): boolean {
  const h = String(holderId || '')
  return !!h && h !== userId
}

/**
 * 白名单那一列 → 真正能拿来比对的地址数组。
 *
 * ============================
 * 为什么不能直接 `JSON.parse` 就用
 * ============================
 * `toRow()` 对 json 列**无条件** `JSON.stringify(v)`，它不判断 `v`
 * 本来是不是一段 JSON 文本。于是只要有谁推了
 * `ipList: JSON.stringify(list)`（**字符串**而不是数组），
 * 库里存下来的就是**双重编码**的 `"[\"203.0.113.70\"]"`。
 *
 * 后果不是「显示难看」，是**白名单形同虚设**：老写法
 * `JSON.parse(...)` 解出来是个**字符串**，接着 `list.includes(ip)`
 * 就成了**子串匹配**而不是数组成员判断。实测（探针，真服务端）：
 *
 * | 库里那一列 | 名单里只有 203.0.113.70 时，请求 203.0.113.7 |
 * | --- | --- |
 * | `["203.0.113.70"]`（数组，正常） | 0 篇 ✅ 挡住 |
 * | `"[\"203.0.113.70\"]"`（双重编码） | **10 篇 ❌ 混进去了** |
 *
 * 而 `203.0.113.7` **根本不在名单里** —— 它只是前一个地址的前缀。
 * 更糟的是默认 `YQ_TRUST_PROXY` 下 `X-Forwarded-For` 是信客户端的，
 * 于是这一行**完全绕得开**：发 `X-Forwarded-For: 0` 就行（`"0"` 是那段文本的子串）。
 *
 * 所以这里**必须先确认是数组**，不是数组就当空名单（fail closed）。
 * 解两轮是为了把已经存进去的双重编码行也救回来 ——
 * 那些行是历史数据，不能要求人手动去改库；
 * 而「解出来还是字符串」时返回 `[]`，走的是**挡住所有人**那条路，不是放行。
 */
export function normalizeIpList(raw: unknown): string[] {
  let v: unknown = raw
  for (let i = 0; i < 2 && typeof v === 'string'; i++) {
    try { v = JSON.parse(v) } catch { break }
  }
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x).trim()).filter(Boolean)
}

/**
 * 知识库设置里配了 IP 白名单时，非白名单地址一律拒（内网常见诉求）
 *
 * ⚠️ 这里**没有 owner 豁免**，而且这是刻意的 ——
 * 曾经我加过一个（理由是「否则管理员一开白名单就把自己关在外面」），
 * 立刻被 `test-v2ip` 抓出 18 项红：
 *
 *   `resolveBook(bookId, ctx, u)` 里的 `u` 是**令牌所属用户**。
 *   而访问令牌通常是平台 owner 发的 → owner 豁免触发 →
 *   **`/api/v2` 的白名单整个失效**，7.21 刚补上的防护被一笔抹掉。
 *
 * **IP 白名单问的是「请求从哪来」，不是「谁在请求」**，
 * 它属于网络层；而 owner 豁免属于权限层。两者混在一起时，
 * 一把 owner 的令牌就等于给整个网段开了后门。
 *
 * 另外，7.21 修 `/api/v2` 时 `requireIpAllowed(bookId, ctx)` **本来就没传 user**，
 * 所以「owner 也会被白名单挡」是**既有行为**，加豁免反而是偏离。
 * 要进去，管理员把自己的 IP 加进名单即可 —— 那是一次明确的、有痕迹的操作。
 * （对比 `exportAllowed` 的 owner 豁免：那是**权限**判断，豁免是对的。）
 */
/**
 * 这个 IP 能不能读这个知识库。
 *
 * ⚠️ **「名单为空」现在等于「谁都进不来」**，这是刻意的 fail closed。
 * 改之前这里是 `if (!list.length) return true`（空名单 = 放行所有人），
 * 而设置页同一屏上写着「白名单为空，开启后将没有人能访问」——
 * **文案说锁门、服务端却把门开着**。管理员加 0 个 IP、打开开关、
 * 以为锁了库，实际谁都能进。这是关于安全控制的假承诺，必须倒向「关上门」。
 *
 * 为什么**不能**靠「服务端先拒绝这种写入」来避免锁死：
 * `bookSettings` 这一行自己也在 `readEntity` 的 IP 过滤范围里
 * （`server/sync.ts`），一旦这个状态真的存在，管理员**连设置页都读不到**，
 * `getBookSettings()` 会退回默认值、界面上开关显示为「关」，
 * 而服务端在拒绝一切 —— **界面显示的和实际做的正好相反**，比原来更难查。
 * 所以防线做在**产生这个状态之前**：写入侧拒绝（`denyReason`）+ 界面不让开，
 * 让这个状态在产品里压根到不了；万一它还是存在（直接改库），
 * 服务端这一层负责**关门**而不是开门。
 * 真锁死了的恢复办法（改库那一条）写在 `RUNBOOK.md` 里。
 */
export function ipAllowed(bookId: string, ip: string): boolean {
  const bs = db.prepare('SELECT ipWhitelist, ipList FROM book_settings WHERE bookId = ?').get(bookId) as Row | undefined
  if (!bs || Number(bs.ipWhitelist) !== 1) return true
  const list = normalizeIpList(bs.ipList)
  if (!list.length) return false
  return list.includes(String(ip ?? '').trim())
}

/**
 * 该知识库是否禁止导出。
 *
 * 这个开关以前**完全没人调用** —— 设置页写「禁止成员把文档导出为
 * Markdown / Word / PDF，防止资料外流」，存了、同步了、跨设备都显示，
 * 但导出接口根本不查它。管理员在把内部文档放进来之前打开这个开关，
 * 得到的却是零保护。
 *
 * 实现上要特别小心一件事：这个开关**不能**实现成
 * 「挡掉那些没有导出权限的人」—— 编辑者本来就有导出权，
 * 那样写出来的判断永远不成立，开关等于又是一个摆设。
 *
 * 它唯一真正拦得住的是**整包导出**（`/api/export` 那个一键导出的数据包）。
 * 单篇文档的 Markdown / Word / PDF 是在浏览器本地生成的，
 * 只要能读，文字就已经在别人屏幕上了，服务端管不着 ——
 * 这一点在设置页上写清楚了，不能让管理员以为它能防住外流。
 *
 * 平台管理员不受限：否则开启之后连备份都没法做。
 */
export function exportAllowed(bookId: string, user: User): boolean {
  const bs = db.prepare('SELECT restrictExport FROM book_settings WHERE bookId = ?').get(bookId) as Row | undefined
  if (!bs || bs.restrictExport !== 1) return true
  return user.role === 'owner'
}

/* ============================================================
   一篇文档能不能被**未登录的人**读到
   ------------------------------------------------------------
   ============================
   为什么是两个开关而不是一个
   ------------------------------------------------------------
   `docs.visibility = 'public'` 是**这一篇**的设置，
   `book_settings.publicAccess` 是**整个库**的开关。
   只看前者的话，一个人只要对着一篇文档点了「公开」，
   整篇内容就对互联网开放了 —— 而大多数场景里人的本意是
   「这一篇可以给外部看」，不是「我们这个库见谁都能读」。

   所以这里取**两个都要开**。少一个都不是「松了一点」，
   而是把一次单篇分享变成整库公开。

   ============================
   返回值刻意带上「为什么不行」
   ------------------------------------------------------------
   外部拿到的是一串链接，他只会看到一句话。
   403 一律写成「不可访问」的话，管理员排查时无从下手：
   他明明开了公开，还是不行，到底差在哪一步。
   ============================================================ */

export type PublicGate =
  | { ok: true; needPassword: boolean; allowDownload: boolean }
  | { ok: false; reason: string; message: string }

export function publicDocGate(docId: string, ip: string): PublicGate {
  const d = db.prepare('SELECT id, bookId, visibility, trashed FROM docs WHERE id = ?').get(docId) as Row | undefined
  if (!d) return { ok: false, reason: 'not-found', message: '文档不存在' }
  if (Number(d.trashed) === 1) return { ok: false, reason: 'trashed', message: '文档已被删除' }

  const bookId = d.bookId ? String(d.bookId) : bookIdOfDoc(docId)
  // 没有知识库归属的文档不对外开放：判不出作用域时一律拒 ——
  // 「也许是安全的」不构成把内容放到公网上的理由。
  if (!bookId) return { ok: false, reason: 'not-public', message: '该文档未设置对外分享' }

  const bs = db.prepare('SELECT publicAccess FROM book_settings WHERE bookId = ?').get(bookId) as Row | undefined
  if (!bs || Number(bs.publicAccess) !== 1) {
    return {
      ok: false, reason: 'book-closed',
      message: '该知识库未开启「公开访问」。请到「知识库 → 设置 → 权限」里打开，再来分享这一篇。',
    }
  }
  if (String(d.visibility) !== 'public') {
    return { ok: false, reason: 'not-public', message: '该文档没有设置为「互联网上获得链接的人可查看」' }
  }
  // IP 白名单对外分享同样生效 —— 它是知识库级的安全设置，
  // 「对外分享这一篇」不等于「这一篇对所有 IP 开放」。
  // 这里**不传 user**：走这条路的是未登录的访客，没有身份可言，
  // 平台 owner 的豁免对它本来就不适用（owner 要导出/访问走的是登录路径）。
  if (!ipAllowed(bookId, ip)) {
    return { ok: false, reason: 'ip', message: `当前 IP（${ip}）不在该知识库的白名单内` }
  }

  const sh = db.prepare('SELECT passwordHash, expiresAt, allowDownload FROM doc_share WHERE docId = ?').get(docId) as Row | undefined
  if (sh && Number(sh.expiresAt) > 0 && Number(sh.expiresAt) < Date.now()) {
    return { ok: false, reason: 'expired', message: '这份分享已过期' }
  }
  return {
    ok: true,
    needPassword: !!(sh && String(sh.passwordHash || '')),
    allowDownload: sh ? Number(sh.allowDownload) === 1 : true,
  }
}

/* ============================================================
   人类可读的原因 —— 403 时直接回给前端，日志与提示都靠它
   ============================================================ */

export function describe(caps: Caps): string[] {
  return (Object.keys(caps) as (keyof Caps)[]).filter((k) => !caps[k])
}
