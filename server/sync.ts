/* ============================================================
   同步引擎 —— 服务端权威存储 + 增量变更流

   分工（很重要，别混淆两种「合并」）：
   · **文档内部的并发编辑** 由前端的 CRDT 层解决（已通过 79 项纯函数测试
     与收敛性测试）。它逐块 / 逐字段合并两个端同时输入的内容。
   · **跨设备的持久化与传播** 由本模块解决。它保证「谁在改都能存下来、
     别人刷新能看到」。

   所以这里的策略是**实体级最后写入生效**，不做内容级合并：
   同一个文档两个人同时打字时，两边的输入先在各自的 CRDT 层与对方
   的历史合并，再由这里落库。CRDT 已经在端内验证过收敛，
   服务端再做一遍合并反而会引入第二套仲裁规则。

   变更以 changes 表的递增 seq 为锚：客户端记住上次同步到的 seq，
   之后只要 WHERE seq > ? 就能补齐断线期间的所有改动。
   ============================================================ */

import { cardSearchText } from '@/lib/card-search'
import { db, logChange, boolInt } from './db.ts'
import type { Row } from './db.ts'
// 审计。`audit.ts` 只依赖 `db.ts`，所以这里引用它**不会成环** ——
// 这一点改之前确认过（怕的是 audit → sync → audit）。
import { logAudit, AUDIT } from './audit.ts'
import { randomBytes } from 'node:crypto'
import { ENTITIES, COMPOSITE_PK, toClient, toRow, parseJsonField } from './entities.ts'
import type { EntityDef } from './entities.ts'
import { capsInBook, capsOfDoc, bookIdOfDoc, capsInSpace, ipAllowed, normalizeIpList } from './perms.ts'
import type { User, Caps, Action } from './perms.ts'
// slug 归一化只有这一份实现，前端 `@/lib/slug` 用的是同一个函数。
// 抽出去的理由与 markdownToBlocks 完全一样：两边各写一份的话，
// 用户在界面上看到的地址和存下来的地址会不一样，表现为分享链接 404，
// 而两边各自都测得过。
import { normalizeSlug } from '@/lib/slug'
export { normalizeSlug }

// 口径只有一份：blocks → markdown / 字数，在 `src/lib/blocks-markdown.ts`。
//
// ⚠️ 服务端**不引用**它了。曾经在 upsertRow 里拿它重算 body / wordCount，
// 后来撤掉了 —— 理由见 upsertRow 里那段注释（牵涉「body 与 blocks 谁是权威」
// 这个没有定论的问题，不该由我单方面定）。**别把 import 加回去。**

/** 推送时会被拒的权限动作 */
const WRITE_ACTION: Action = 'edit'

/* ============================================================
   作用域工具
   ============================================================ */

/** 当前用户可读的知识库集合 —— 一次算完，后面所有实体过滤都靠它 */
export function readableBooks(user: User): Set<string> {
  const out = new Set<string>()
  const books = db.prepare('SELECT id FROM books').all() as Row[]
  for (const b of books) {
    const caps = capsInBook(user, String(b.id))
    if (caps.read) out.add(String(b.id))
  }
  // 个人空间的内容对该用户可见
  const spaces = db.prepare('SELECT id FROM space_members WHERE userId = ?').all(user.id) as Row[]
  for (const s of spaces) out.add(`@space:${s.spaceId}`)
  return out
}

function canReadBook(bookId: string, user: User): boolean {
  return capsInBook(user, bookId).read
}

/* ============================================================
   空间级实体：讨论区与小记
   ------------------------------------------------------------
   `notes` / `topics` / `topicReplies` 这三张表的 `bookOf` 返回的
   **其实是 spaceId**（`topicReplies` 没有这列，靠 `bookOf` 顺父话题反查）。

   于是任何「按 bookId 判权限」的地方都拿着一个空间 id 去查知识库，
   查不到 → `capsInSpace(user, null)` → 零能力 → 一律拒。
   读和写都中招：
     · 读（`readEntity` → `canReadBook`）：空间成员**一行都看不到**
     · 写（`denyReason`）：空间成员**一条都发不出来**

   而这两张表根本不属于任何知识库 —— 讨论区是空间级的东西。
   所以判权限一律走 `capsInSpace`（它给空间成员 read + comment）。

   **为什么提成模块级常量**：
   读和写是两处独立判断，写成两遍的话，改了一处忘了另一处就会
   变成「能发看不见」—— 那正是我第一版修完的样子：
   探针只测了写没测读，于是「写通了、读还是坏的」被我当成了收工。
   （同一个「一处判断写两遍」的坑，这一轮已经栽过两次：
    一次是 `bookMemberRemove` 只写在 `upsertRow`，
    一次就是这里。）
   ============================================================ */
const SPACE_LEVEL_ENTS = new Set(['notes', 'topics', 'topicReplies'])
const isSpaceLevel = (name: string) => SPACE_LEVEL_ENTS.has(name)

/**
 * 表实际有哪些列。
 * 不能想当然地给每张表都塞 rev / updatedBy —— 子表（book_members、favorites、
 * recents、trash、doc_versions…）本来就没有这些列，塞进去会直接报
 * "table X has no column named rev"。这里直接问一次 SQLite 并缓存。
 */
const columnCache = new Map<string, Set<string>>()

function tableColumns(table: string): Set<string> {
  let cols = columnCache.get(table)
  if (!cols) {
    cols = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((r) => String(r.name)),
    )
    columnCache.set(table, cols)
  }
  return cols
}

/** 取出这一行归属的知识库（支持经 docId / commentId / 目录节点反查） */
function resolveBook(def: EntityDef, row: Row): string | null {
  const direct = def.bookOf(row)
  if (direct) return direct
  if (def.bookViaDoc) {
    const docId = row[def.bookViaDoc]
    if (docId) return bookIdOfDoc(String(docId))
  }
  if (def.bookViaNode && row.id) {
    // 与 perms.bookIdOfDoc 同一套解析：bookId 列为空就查目录树
    return bookIdOfDoc(String(row.id))
  }
  if (def.bookViaComment) {
    // 回复挂在评论上，而评论挂在文稿上 —— 要走两跳才能定位到知识库。
    // 少一跳就会判不出作用域，权限过滤会把它当成「无归属」而丢掉。
    const parentId = row[def.bookViaComment]
    if (!parentId) return null
    const table = def.bookViaComment === 'commentId' ? 'comments' : 'selection_comments'
    const c = db.prepare(`SELECT docId FROM ${table} WHERE id = ?`).get(String(parentId)) as Row | undefined
    if (c?.docId) return bookIdOfDoc(String(c.docId))
  }
  return null
}

/* ============================================================
   读
   ============================================================ */

/** 回复行补上 docId：客户端要靠它把回复挂回 Record<docId, Comment[]> */
function enrichReplyDocIds(def: EntityDef, rows: Row[]): Row[] {
  if (!def.enrichDocId) return rows
  const fk = def.bookViaComment === 'commentId' ? 'commentId' : 'selectionCommentId'
  const table = fk === 'commentId' ? 'comments' : 'selection_comments'
  const stmt = db.prepare(`SELECT docId FROM ${table} WHERE id = ?`)
  return rows.map((r) => {
    if (r.docId) return r
    const c = stmt.get(String(r[fk] ?? '')) as Row | undefined
    return c?.docId ? { ...r, docId: String(c.docId) } : r
  })
}

/** 软删除的文稿对普通读取不可见，但接口自己要用（恢复 / 彻底删） */
export function docRow(docId: string): Row | undefined {
  return db.prepare('SELECT * FROM docs WHERE id = ?').get(docId) as Row | undefined
}

/**
 * 一段路径片段 → 真正的 docId：先按 id 查，再按 slug 查。
 *
 * 为什么两个都要：语雀的地址是 `/namespace/book/<slug>`，
 * 而我们内部一路用 docId（`#/book/b1/doc/d2`）。
 * 只认一个的话，另一个就变成了「看得见、点不动」的死地址 ——
 * 而这正是这次要修的那个假控件的另一种形态。
 *
 * **slug 查不到时返回 null，绝不「猜一个」**：slug 猜错等于
 * 把另一篇文档的内容发给以为在读这一篇的人。
 * 所以 `GET /api/doc/<slug>` 拿不到就是 404，不会给你一篇相近的。
 */
export interface DocResolution {
  id: string | null
  /** 这个路径命中了几篇（slug 的唯一性是**按知识库**的，所以可能是多篇） */
  candidates: number
}

/**
 * `:id` 既可以是 docId，也可以是「路径」（slug）。
 *
 * 原来这里是 `SELECT id FROM docs WHERE slug = ? ORDER BY id LIMIT 1` ——
 * 而 slug 的唯一索引是 `ON docs(bookId, slug)`，**按知识库唯一，不是全局唯一**。
 * 于同一个 slug 在 A、B 两个库里各有一篇是完全合法的（也拦不住），
 * 而查找却全局只取一篇：`ORDER BY id LIMIT 1` 挑中的是**字典序最小的那篇**，
 * 跟「谁在访问」「访问的是哪个库」毫无关系。
 *
 * 实测（探针，2026-10-06）：slug `dup-x` 同时存在于两个库时
 *   · 只属于 A 库的同事访问这个路径 → **403「没有阅读该文档的权限」**
 *     —— 而那篇就在他能读的库里、路径也是他自己的。
 *     用户看到的是「我有权限、链接也对，但系统说我没权限」，
 *     **会去找管理员要一个他本来就有权的文档**。这是最坏的排查方向。
 *   · admin 访问 → **静默拿到 B 库那篇**，而他以为自己在读 A 库那篇。
 *
 * 而这个函数上面的注释一直写着「slug 猜错等于把另一篇文档的内容发给以为自己在读
 * 这一篇的人」——**规则写对了，实现没做到**。
 *
 * 现在的口径：
 *   · 只有一篇            → 就是它
 *   · 多篇，有身份        → 收窄到「他读得到的」那一篇；仍然多篇就**不猜**
 *   · 多篇，没身份（分享）→ 不猜
 *   · 收窄后 0 篇         → 当作不存在（他读不到的那些不该影响他的链接）
 */
export function resolveDoc(idOrSlug: string, user?: User | null): DocResolution {
  if (!idOrSlug) return { id: null, candidates: 0 }
  const byId = db.prepare('SELECT id FROM docs WHERE id = ?').get(idOrSlug) as Row | undefined
  if (byId) return { id: String(byId.id), candidates: 1 }
  const cands = db.prepare("SELECT id FROM docs WHERE slug = ? AND slug <> ''").all(idOrSlug) as Row[]
  if (!cands.length) return { id: null, candidates: 0 }
  if (cands.length === 1) return { id: String(cands[0].id), candidates: 1 }
  const pool = user ? cands.filter((c) => capsOfDoc(user, String(c.id)).read) : []
  if (pool.length === 1) return { id: String(pool[0].id), candidates: cands.length }
  return { id: null, candidates: cands.length }
}

/** 只要 id。**多篇时不猜**（以前是 ORDER BY id LIMIT 1 挑一篇）。 */
export function resolveDocId(idOrSlug: string, user?: User | null): string | null {
  return resolveDoc(idOrSlug, user).id
}

/**
 * slug 归一化 —— **只有这一份实现**，前端 `@/lib/slug` 用的同一个函数。
 *
 * 两边各写一份的后果不是「不优雅」，是「用户在界面上看到的地址
 * 和存下来的地址不一样」，表现为分享链接 404，而两边各自都测得过。
 * 抽出去的理由与 markdownToBlocks 完全一样。
 */

/** 未软删的文稿才有意义：版本、回复、目录项都挂在它下面 */
const liveDoc = (id: any): string | null => {
  if (!id) return null
  const r = db.prepare('SELECT trashed FROM docs WHERE id = ?').get(String(id)) as Row | undefined
  return r && r.trashed !== 1 ? String(id) : null
}

/**
 * 软删一篇文稿时，把目录树里指向它的那些节点**藏起来**（`hidden = 1`）。
 *
 * 关键点：**不删**。删掉之后 `restoreDoc` 就再也找不回它在树上的位置了 ——
 * 文稿能回到库里，但树上哪儿都点不着，而提示写的是「已还原到原位置」。
 * 真正删节点的地方是 `purgeDocCore`（永久删除），那时才该连位置一起去掉。
 *
 * 记 `nodes` 的变更：别的设备靠这个把那一项从树上摘下去。
 */
function hideNodesOfDoc(docId: string, actorId: string) {
  const rows = db.prepare('SELECT id, hidden FROM nodes WHERE docId = ?').all(docId) as Row[]
  for (const r of rows) {
    if (Number(r.hidden) === 1) continue
    const nid = String(r.id)
    db.prepare('UPDATE nodes SET hidden = 1, rev = COALESCE(rev,0) + 1, updatedBy = ? WHERE id = ?')
      .run(actorId, nid)
    logChange('nodes', nid, 'upsert', Number(r.rev || 0) + 1, actorId)
  }
}

/** 还原时把位置放回树上（`hideNodesOfDoc` 的反面） */
function showNodesOfDoc(docId: string, actorId: string) {
  const rows = db.prepare('SELECT id, hidden FROM nodes WHERE docId = ?').all(docId) as Row[]
  for (const r of rows) {
    if (Number(r.hidden) !== 1) continue
    const nid = String(r.id)
    db.prepare('UPDATE nodes SET hidden = 0, rev = COALESCE(rev,0) + 1, updatedBy = ? WHERE id = ?')
      .run(actorId, nid)
    logChange('nodes', nid, 'upsert', Number(r.rev || 0) + 1, actorId)
  }
}

/**
 * 目录节点上的 `title` 是**文档标题的一份冗余副本**；读出来时**以文档为准**。
 *
 * 为什么必须有这一步（2026-10-10 在真实部署实例上实测到的）：
 * 客户端连着打字时，防抖推送会撞上「上一轮还在飞」，于是 `nodes` 那张表
 * 落地的可能是**倒数第二版**的标题，而 `docs` 那张是最后一版 ——
 * 两份就分叉了，而且**不会自愈**：库里错的那一行为 nobody 会再去写它。
 * 症状是「文档标题对、目录树少一个字」，而且毫无报错。
 *
 * 只在**读**的时候派生，不去改库：
 *   · 库里那份留着当历史，导出/备份的形状不变；
 *   · 任何写入路径（含第三方直接调 API）造成的分叉，**下一次读就自愈**；
 *   · 分组节点（没有 docId）标题只能存在 `nodes` 里，原样保留。
 *
 * ⚠️ `readEntity` 和 `changesSince` 是**两条独立**的读路（后者直接
 *   `SELECT` 一行，不经过 `readEntity`），两处都要接 —— 漏一处就是
 *   「全量刷新能看到、增量拉取看不到」的半截状态。
 */
function deriveNodeTitle(row: Row): Row {
  const docId = String(row.docId || '')
  if (!docId) return row
  const d = db.prepare('SELECT title FROM docs WHERE id = ? AND trashed = 0').get(docId) as Row | undefined
  if (!d || String(row.title) === String(d.title)) return row
  return { ...row, title: d.title }
}

/**
 * `ip` **必传**，这是有意的：
 * 以前这个函数只判权限、不看 IP，于是「IP 白名单」这个设置在
 * **列表、搜索、导出、能力面板**四条路径上完全没执行 ——
 * 实测开着白名单、白名单里没有自己时：
 *
 *   `/api/entity/docs`   → 200 + 10 篇（全列出来了）
 *   `/api/entity/books`  → 200 + 1 个
 *   `/api/search`        → 200 + 5 条（含正文片段）
 *   `/api/export`        → 200（整包导走）
 *   `/api/perms/book/:id`→ read=true，能力面板说「你有全部权限」
 *   而只有 `/api/doc/:id` 打开单篇时才是 403
 *
 * 也就是说：**除了打不开单篇，什么都拦不住。**
 * 设置页写着「仅允许下列 IP 访问本知识库，其余请求将被拒绝」——
 * 而那句话当时只对最后一个入口成立。
 *
 * 参数做成**必传**（`null` 表示「服务端内部读取，不做 IP 判定」），
 * 是为了让**新增调用点时编译就红**，而不是靠人记得传。
 * 以前这类漏洞反复出现的形式就是「漏了一处调用点」。
 */
export function readEntity(user: User, def: EntityDef, ip: string | null): Row[] {
  if (def.personal) {
    const col = def.userCol || 'userId'
    return (db.prepare(`SELECT * FROM ${def.table} WHERE ${col} = ?`).all(user.id) as Row[])
      .map((r) => toClient(def, r))
  }

  // 回收站里的文稿不进正常读取（软删除的正文仍在库里，只是不展示）
  const where = def.name === 'docs' ? ' WHERE trashed = 0' : ''
  const rows = db.prepare(`SELECT * FROM ${def.table}${where}`).all() as Row[]
  const out: Row[] = []
  for (const r of rows) {
    // 自定义可见性优先（模板这类归属不唯一的实体）。
    // ⚠️ 它是**替代**判定：命中就 continue，后面的 bookViaDoc / 库能力 /
    //    IP 白名单**都不执行**。所以它只给「本来就不按知识库判」的行用。
    if (def.visible) {
      if (def.visible(r, user)) out.push(toClient(def, r))
      continue
    }
    /*
     * `filter` 是**附加**判定：和上面那一整套**叠加**，全过了再判它。
     *
     * 为什么要分两个：2026-10-06 给 `docs` 挂 `visible` 的结果是
     * **IP 白名单被整个绕过**（test-ipwhitelist / ipwlchanges / trustproxy
     * 三个套件一起红：「该挡的 26 篇全放行」）。
     * 教训就是上面注释写的：`visible` 能短路的东西比你以为的多。
     */
    if (def.filter && !def.filter(r, user)) continue
    // 挂在已删文稿下面的评论 / 版本 / 回复一并隐藏，
    // 否则会出现「文档没了但评论还在」的幽灵数据
    if (def.bookViaDoc && !liveDoc(r[def.bookViaDoc])) continue
    if (def.bookViaComment) {
      const parent = db.prepare('SELECT docId FROM comments WHERE id = ?').get(String(r[def.bookViaComment])) as Row | undefined
      if (!liveDoc(parent?.docId)) continue
    }
    const bookId = resolveBook(def, r)
    if (!bookId) {
      // 没有知识库归属的行：只有显式可读才放行。
      // 宁可少给也不要因为「没归属」就全网可见。
      if (def.name === 'spaces') {
        if (canSeeSpace(user, String(r.id))) out.push(toClient(def, r))
      }
      continue
    }
    // 空间级实体（讨论区 / 小记）：`bookId` 其实是 spaceId，按空间判，
    // 见上面 SPACE_LEVEL_ENTS 那段说明 —— 走 canReadBook 就是拿空间 id
    // 去查知识库，空间成员会**一行都读不到**。
    if (isSpaceLevel(def.name) ? capsInSpace(user, bookId).read : canReadBook(bookId, user)) {
      /*
       * IP 白名单和权限判据是**两回事**，以前这里只判了后者。
       * 实测开着白名单、白名单里没有自己时，列表照样把整库列出来
       * （见上面 readEntity 的说明）。
       *
       * 这里用的是**静默过滤**而不是抛 403，原因有两个：
       *   · 一次 bootstrap 要读二十几张表、跨多个知识库，
       *     抛错就得回答「你被哪个库挡了」，而用户可能对好几个库都有权限；
       *   · 真正「打开某篇」时走 `/api/doc/:id`，那里是明确 403，
       *     会说清「当前 IP 不在白名单内」——
       *     **列表安静、详情明确**，用户点进去时就知道原因了。
       *
       * `ip === null` 是服务端内部读取（导出包、完整性自查），
       * 那条路上一律不按 IP 判定 —— 真要导出的管理员也不该被自己的白名单挡住。
       */
      if (ip !== null && !ipAllowed(bookId, ip)) continue
      out.push(toClient(def, r))
    }
  }
  const out2 = enrichReplyDocIds(def, out)
  // 目录节点标题以文档为准（冗余副本 + 历史分叉都靠这一步自愈）
  return def.name === 'nodes' ? out2.map(deriveNodeTitle) : out2
}

function canSeeSpace(user: User, spaceId: string): boolean {
  if (user.role === 'owner') return true
  const m = db.prepare('SELECT 1 AS x FROM space_members WHERE spaceId = ? AND userId = ?').get(spaceId, user.id)
  if (m) return true
  // 空间下有任一可读知识库，则该空间可见
  const books = db.prepare('SELECT id FROM books WHERE spaceId = ?').all(spaceId) as Row[]
  return books.some((b) => canReadBook(String(b.id), user))
}

/**
 * 首次登录 / 刷新：一次性把该用户能看到的东西全给它。
 *
 * `lite` 模式（客户端默认用这个）**不带文稿正文**，只给元信息
 * （标题 / 作者 / 时间 / 字数 / 类型）。正文走 `GET /api/doc/:id` 按需拉。
 *
 * 为什么要拆：知识库是会长大的。实测 26 篇时整包 61KB 没问题，
 * 灌到 2000 篇就是 **18.4MB** —— 每登录一次、每个新人都要下一遍，
 * 内网带宽下直接不可用。目录树与列表只需要元信息，正文只有打开那篇的人需要。
 */
/**
 * 给空间行补上现算的成员数。
 *
 * `spaces` 表**没有** memberCount 这一列（客户端 seed 里有，
 * 但服务端才是权威）—— 而顶栏的空间切换器、侧栏、工作台三处都在读它。
 * 于是服务端模式下那些位置显示的是空白：`undefined 位成员` 被 React 渲染成空，
 * 看起来像「加载失败」而不是「没数据」。
 *
 * 同样地，**不能**让客户端各自去数：客户端拿不到 `space_members`
 * （它不在同步实体清单里），只有服务端数得出来。
 *
 * 全量（bootstrap）和增量（changesSince）**都要调**：
 * 增量走的是泛型的 toClient，不经过这里的话，成员数一变，
 * 别的端就永远停在加入之前 —— 而表面上一切正常。
 */
function withSpaceMemberCount(rows: Row[]): Row[] {
  if (!Array.isArray(rows) || !rows.length) return rows
  const counts = new Map<string, number>()
  for (const m of db.prepare('SELECT spaceId, COUNT(*) AS n FROM space_members GROUP BY spaceId').all() as Row[]) {
    counts.set(String(m.spaceId), Number(m.n) || 0)
  }
  for (const row of rows) {
    // 一个人一个空间都没有的空间（不该有，但别让界面显示空白）算 0 而不是 undefined
    row.memberCount = counts.get(String(row.id)) ?? 0
  }
  return rows
}

export function bootstrap(user: User, lite = true, ip: string | null = null) {
  const data: Record<string, Row[]> = {}
  for (const def of ENTITIES) {
    if (def.name === 'members') continue
    data[def.name] = lite ? readEntityLite(user, def, ip) : readEntity(user, def, ip)
  }
  // 成员名册：全员可见（内网知识库需要「谁在空间里」这类信息），
  // 但只给公开字段，密码列在这里就剔掉。
  data.members = (db.prepare('SELECT id, name, account, avatar, role, createdAt FROM users').all() as Row[])
    .map((r) => ({ id: r.id, name: r.name, avatar: r.avatar || '', account: r.account, role: r.role }))

  /**
   * 空间的成员数在这里现算 —— 见 withSpaceMemberCount 的说明。
   */
  if (Array.isArray(data.spaces)) withSpaceMemberCount(data.spaces)

  // 注意：回复**不**在这里嵌套回父评论。
  // 前端同步是按行做的，回复是独立实体；嵌套只在客户端做一次，
  // 服务端再单独拼一遍就成了两条路径 —— 两处都得对，迟早只改一处。
  return { data, seq: currentSeq(), lite }
}

/** 轻量读取：与 readEntity 同样的权限过滤，但把**文稿正文**置空。 */
const HEAVY_COLUMNS = new Set(['blocks', 'sheetData'])

function readEntityLite(user: User, def: EntityDef, ip: string | null): Row[] {
  // 只对 docs 生效。
  // 曾经写成「凡是有 blocks 列的实体都裁掉」，结果 doc_versions 的
  // 快照也被裁了 —— 前端拿到的是「有版本号、没有内容的空版本」，
  // 点回滚才发现恢复不了。**同名不同义**的列名是这里最坑的地方。
  if (def.name !== 'docs') return readEntity(user, def, ip)
  // 先按正常规则判可见性，再把重列摘掉 —— 顺序不能反，
  // 反了就等于「没权限的文档只因为轻量就不判了」。
  // 注意不要再挂 `_lite` 之类的标记：toClient 已经跑过了，
  // 这个标记会绕过 shape 直接漏到业务数据里，
  // 而客户端多一个键就等于「每次都判定为变了」→ 全量重推。
  return readEntity(user, def, ip).map((row) => {
    const out: Row = { ...row }
    for (const c of HEAVY_COLUMNS) {
      if (c in out) delete out[c]
    }
    return out
  })
}

/* ============================================================
   写
   ============================================================ */

export interface PushResult {
  applied: { entity: string; id: string; rev: number }[]
  rejected: { entity: string; id: string; reason: string }[]
  seq: number
}

export function currentSeq(): number {
  const r = db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM changes').get() as Row
  return Number(r.s)
}

/**
 * 把一列的值压成**可以逐字比较**的字符串。
 *
 * ⚠️ 必须归一化，因为同一个值在两边的形态不一样：
 *   · JSON 列在库里存的是 TEXT，`existing.likes` 读出来是 `'["u_1"]'`；
 *   · 客户端推的是**已解析**的数组，`incoming.likes` 是 `['u_1']`。
 * 不归一的话它们永远比不相等，「只改了 likes」会被判成「什么都改了」，
 * 于是这个口子等于没开 —— 而且症状是「点赞还是推不上去」，看不出是哪一步错了。
 *
 * 键序也压平：对象的键顺序不同但内容一样，不该算「变了」。
 */
function comparableCell(v: unknown): string {
  if (v === undefined || v === null) return 'null'
  let x = v
  if (typeof x === 'string') {
    const t = x.trim()
    if (t.startsWith('{') || t.startsWith('[')) {
      try { x = JSON.parse(t) } catch { /* 不是 JSON，就按原字符串比 */ }
    }
  }
  if (Array.isArray(x)) return `[${x.map(comparableCell).join(',')}]`
  if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${k}:${comparableCell(o[k])}`).join(',')}}`
  }
  return String(x)
}

/**
 * 两个列值是否「同一个值」。
 *
 * 除了 JSON 形态要归一（`toRow` 已经把客户端值转成存储形态了，
 * 所以真正要处理的只剩下面这一条），还有**「空」的两种写法**：
 *
 * ⚠️ 协议里的「空」是 `null`，库里的「空」是 `0`。`pinnedAt` 就是这样：
 * 客户端推 `null`，服务端存 `0`；而读侧早就按「两种都读成没置顶」处理
 * （见 `store/index.ts` 的 `togglePinDoc` 注释：归一到 null，两种都读成没置顶）。
 *
 * 不把它们视作相等，那个「只放行点赞」的口子就**永远开不了** ——
 * 症状是「服务端逻辑明明写了，点赞还是推不上去」，
 * 而日志里只有一句「没有 edit 权限」，完全指不到这一层。
 *
 * 判据是「**两边都空**」，不是「一边空就算相等」：
 * 一边空一边是 `5`，照样算变了。所以这不是把 null 和 0 混为一谈，
 * 只是承认「这个字段没设」有两种写法。
 */
function sameCell(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v === null || v === undefined || v === 0
  if (empty(a) && empty(b)) return true
  return comparableCell(a) === comparableCell(b)
}

/**
 * 判断「这次推送除了 `allow` 这一列，别的 writable 列都没动」。
 *
 * 两条边界必须写清楚，少一条就会把口子开成后门：
 *
 * 1. **`allow` 必须真的出现在 incoming 里。**
 *    删除路径传的是 `denyReason(user, def, existing, {})` —— 空对象。
 *    若只看「别的列都没变」，空对象会**判定通过**，于是 reader 能删文档。
 *    所以先要求 `allow in incoming`，删除一律走到正常的权限判据。
 *
 * 2. **incoming 里没有的键按「没改」算。**
 *    `toRow()` 是 `if (!(c in input)) continue` —— 没带的键压根不会被写，
 *    所以它当然算「没改」。反过来把「缺键」当成「变了」的话，
 *    轻量模式那种不带正文的推送会把本该放行的点赞也拒掉。
 */
function onlyColumnChanged(def: EntityDef, existing: Row | null, incoming: Row, allow: string): boolean {
  if (!existing) return false
  if (!(allow in incoming)) return false
  for (const c of def.writable) {
    if (c === allow) continue
    if (!(c in incoming)) continue
    if (!sameCell(incoming[c], existing[c])) return false
  }
  return true
}

/** 判断一次写入是否被允许，返回拒绝原因（null = 放行） */
function denyReason(user: User, def: EntityDef, existing: Row | null, incoming: Row): string | null {
  if (def.personal) return null

  /**
   * 文档锁 —— 放在 owner 早退**之前**，所以平台管理员也一样被挡。
   *
   * 以前它在下面，被 `if (user.role === 'owner') return null` 提前放掉了，
   * 而界面 `DocPage` 的 `lockedByOther` 只看 memberId、不看权限，
   * 于是两边不一致：界面对 owner 显示「XX 锁定了此文档」+ 编辑器只读，
   * 服务端却让他照改不误。owner 在界面上是只读的，所以**不会误改**；
   * 真正出事的是他改用脚本或另一个客户端去改 ——
   * 那一刻改动静默成功，而持有者收不到任何冲突提示。
   *
   * 锁防的是**编辑冲突**，不是权限，所以它和「管理员什么都能管」是两件事。
   * （`exportAllowed` 那边的 owner 豁免没动 —— 那是权限开关，语义不同。）
   *
   * **代价要说清：没有「强制解锁」这个动作。** owner 被别人锁着的文档挡在门外时，
   * 只能等持有者解锁，或者请持有者先把锁放了。界面提示的也是
   * 「只有持有者能解锁」，与这里一致。
   * 真要加「管理员强制解锁」，那是**新功能**，不是这个修复的一部分。
   */
  if (def.name === 'docs' && existing?.lockMemberId && String(existing.lockMemberId) !== user.id) {
    return '文档已被他人锁定'
  }

  /**
   * 「仅自己可见」这条只能由**作者本人**动。
   *
   * `docs.visibility` 在 `writable` 里，而通用写路径判的是
   * `capsInBook(user, bookId).edit` —— 也就是**任何一个 editor 都能改别人的可见性**。
   * 两种后果都实：
   *   · 把别人的文档设成 `private` → 作者自己再也看不见（正文没丢，
   *     但目录、搜索、实体列表里全都没有），而他唯一能做的就是找管理员，
   *     而管理员**同样看不到**（owner 不豁免）；
   *   · 更糟的反方向：把别人的 `private` **改回 `space`** ——
   *     那等于**替别人把私密文稿公开给全空间**，而且没有任何痕迹。
   *     实测（2026-10-06，套件 `test-privdoc`）：同事一推，作者的
   *     「仅自己可见」就静默失效了。
   *
   * 所以判的是**「真的改了」**：协作者保存文档时推的是**整行**（含当前
   * `visibility`），值没变就放过 —— 否则正常的共同编辑会被一起挡掉。
   *
   * 可见性的正规入口是分享弹窗，它也是走这条 push
   * （`DocPage` 的 `onChange({ visibility })` → 同步），
   * 所以这里就是唯一该判的地方。
   */
  if (def.name === 'docs' && incoming.visibility !== undefined) {
    const curVis = String(existing?.visibility ?? 'space')
    if (String(incoming.visibility) !== curVis) {
      const authorId = String(existing?.authorId || '')
      if (authorId && authorId !== user.id) return '只有作者本人能改这篇的可见性'
    }
  }

  /*
   * 「IP 白名单开着 + 名单为空」这个状态**不许被写进来**。
   *
   * 它危险在两处同时成立：
   *   · 服务端空名单 = 放行所有人（改之前）→ 管理员以为锁了门，其实没锁；
   *   · 一旦真按「空 = 全拒」来修，锁死的人**连设置页都进不去**
   *     （`bookSettings` 自己也在 IP 过滤里），界面开关显示为「关」，
   *     而服务端在拒绝一切 —— 显示和实际正好相反。
   *
   * 所以拦在**写入边界**：这个组合压根产生不出来。
   * `ipAllowed()` 那层的 fail closed 负责的是「万一它还是存在（直接改库），
   * 宁可关门也不要开门」，两处是**互补**的，不是重复。
   *
   * ⚠️ 放在 `if (user.role === 'owner') return null` **之前**，和上面文档锁同一条理由：
   * 这不是权限问题，是「这个状态本身危险」，owner 也不该能写出来。
   * 而 `normalizeIpList` 能解开双重编码（`test-attip` / `test-day1` 那几个套件
   * 推的就是 `JSON.stringify(list)`）—— 不解开的话
   * `JSON.stringify([])` = `'[]'` 长度 2，会被当成「非空」而**放行一个空名单**。
   */
  if (def.name === 'bookSettings' && ('ipWhitelist' in incoming || 'ipList' in incoming)) {
    const on = Number('ipWhitelist' in incoming ? incoming.ipWhitelist : existing?.ipWhitelist ?? 0) === 1
    const rawList = 'ipList' in incoming ? incoming.ipList : existing?.ipList
    if (on && !normalizeIpList(rawList).length) {
      return 'IP 白名单开着、名单却是空的 —— 那样等于谁都能进这个知识库。请先添加至少一个 IP，或者把白名单关掉。'
    }
  }

  if (user.role === 'owner') return null

  const row = { ...(existing || {}), ...incoming }

  // 成员名册：只有平台管理员能改
  if (def.name === 'members') {
    if (user.role !== 'admin') return '只有管理员可以维护成员'
    return null
  }
  // 空间：只有空间 owner/admin 能改
  if (def.name === 'spaces') {
    const m = db.prepare('SELECT role FROM space_members WHERE spaceId = ? AND userId = ?').get(String(row.id), user.id) as Row | undefined
    if (!m) return '你不是该空间的成员'
    if (m.role !== 'owner' && m.role !== 'admin') return '只有空间管理员可以修改空间'
    return null
  }
  /**
   * 建库：按**空间**判，不按「这个还不存在的知识库」判。
   *
   * 放在 `user.role === 'owner'` 早退**之后**是有意的：
   * 平台 owner 的行为**一个字都没变**，包括他导入数据包时的行为。
   *
   * 导入路径的影响面**实测**过（`data/_importprobe.mjs` 那个探针，
   * 源库导包 → 空库新同事导入）：
   *   · owner 导入 → 早退命中，走老路，不受影响；
   *   · merge 模式重复导入同一个包 → `existing` 非 null，走老路；
   *   · 包的 spaceId 在目标库不存在 → 外键直接拒绝
   *     （实测拒绝文案：`FOREIGN KEY constraint failed`）；
   *   · 包的 spaceId 改指到目标库真实空间、且导入者是该空间 **admin** 时
   *     → **books / nodes / docs / comments / bookSettings 全部导进去了**
   *     （books 4、docs 26，实测）。
   * 也就是说「放宽」是**有条件**兑现的：条件是「导入者得是那个空间的管理员」。
   * ⚠️ 而 `POST /api/spaces/:id/members` 的 role 白名单是
   * `admin` / `member`（`index.ts`：`=== 'admin' ? 'admin' : 'member'`），
   * **给不了 `owner`** —— 传 `owner` 会被**静默降级成 member**。
   * 我第一版探针就传了 owner，于是被拒时一度以为修复失效，
   * 其实是自己把参数传错了。
   * （核过了：界面 `Space.tsx` 的 role 也只有 `admin | member`，
   *   所以这个白名单和界面**一致**，不是静默错。）
   *
   * `books` 的 `bookOf` 返回的是**它自己**的 id（`entities.ts`：
   * `bookOf: (r) => S(r.id)`），所以下面那段通用逻辑会拿
   * `capsInBook(user, 新库的 id)` 去判 —— 而这一刻库里还没有这一行：
   *   · `spaceIdOfBook(新库id)` 查不到 books 行 → null
   *   · `capsInSpace(user, null)` → NONE
   *   · `book_members` 里也还没有行 → NONE
   * → 「没有 edit 权限」，**任何普通用户都建不出第一条知识库**。
   * 平台 owner 看起来正常，是因为他在上面 `user.role === 'owner'` 早退了。
   *
   * 更糟的是它和下面 `bookMembers` 的判据**互相等待**（自锁）：
   *   · books 新行要「是该库 admin」→ admin 身份来自 book_members 行
   *   · bookMembers 新行也要「是该库 admin」→ 而 books 行还不存在
   * 两种推送顺序都实测过（`test-emptyfirst`，探针里也留了输出）：
   *   · books 在前     → books「没有 edit 权限」+ bookMembers「需要该知识库的管理员权限」
   *   · bookMembers 在前 → bookMembers「需要该知识库的管理员权限」+ books「没有 edit 权限」
   *   · 对照组平台 owner：同样两行、同样顺序，**都 applied**
   *
   * 这是**同一个病根的第三次**：`notes`/`topics`/`topicReplies` 那三处是
   * 拿 bookId 去查一个**空间**（它们的 `bookOf` 返回 spaceId），
   * 这次是拿 bookId 去查一个**还不存在的库**。
   * 判据统一是：**凡是「这一行不属于任何已有知识库」的写入，不按 bookId 判。**
   *
   * 只在**新建**时走这条路。已有的 books 行继续走下面的通用逻辑 ——
   * 不加这个限制会回退：库的 editor 能改名、能改可见性，
   * 改成按空间判之后，空间普通成员（只有 read+comment）就都改不了了。
   * 这一条是实测钉住的（破坏对照②去掉 `!existing` → 「editor 能改名」当场红）。
   *
   * 判据是**空间管理员**（`capsInSpace().admin`）而不是空间成员：
   * 建库是管理动作，让每个成员都能建，空间目录会变成垃圾堆。
   */
  if (def.name === 'books' && !existing) {
    const sid = String(row.spaceId || '')
    if (!sid) return '知识库必须属于一个空间'
    if (!capsInSpace(user, sid).admin) {
      return `你不是「${spaceNameOf(sid)}」这个空间的管理员，没法在里面建知识库`
    }
    return null
  }

  /**
   * 模板：**写**路径要和**读**路径（`entities.ts` 里的 `visible`）对齐。
   *
   * `visible` 认四种来源 —— 官方模板（人人可见）、个人模板（`ownerId` 是本人）、
   * 库模板（按 bookId）、空间模板（按 spaceId）—— 而 `denyReason` 原来只认一种：
   * `bookOf: (r) => S(r.bookId)`。
   *
   * 后果实测（探针，普通注册用户）：
   *   建一个自己的模板（`scope: 'mine'`，`bookId` 为空）
   *   → **「无法确定所属知识库」**，一件都建不出来。
   *   而他**读**模板是好的（能读到 8 个）—— 又一次**读写两套判据**。
   *
   * 这是同一个病根的**第四次**：
   *   ① ② `notes` / `topics` / `topicReplies`：拿 bookId 去查一个**空间**
   *   ③   `books`：拿 bookId 去查一个**还不存在的库**（7.24）
   *   ④   `templates`：拿 bookId 去判一个**根本不属于任何知识库**的东西
   * 判据统一还是那句：**这一行不属于任何知识库时，不按 bookId 判。**
   *
   * `scope: 'mine'` 的新建**不看推上来的 ownerId** ——
   * 服务端在 `upsertRow` 里强制 `ownerId = user.id`。
   * 不强制的话 B 能建出 `ownerId = A` 的模板：那份东西进 A 的列表，
   * 而 B 自己反而改不了它（按 ownerId 判），两头都别扭。
   * 修改时按**库里已有的** ownerId 判，不看推上来什么。
   */
  if (def.name === 'templates') {
    const scope = String(row.scope || 'official')
    if (scope === 'official') {
      // 官方模板不属于任何个人 —— 只有平台管理员能改。
      // （owner 在函数开头就早退了，所以这里只可能收到普通用户。）
      return '官方模板只有平台管理员能改'
    }
    if (scope === 'mine') {
      if (!existing) return null   // 新建：ownerId 由服务端强制填成本人
      return String(existing.ownerId || '') === user.id ? null : '只能改自己建的模板'
    }
    if (row.bookId) {
      const caps = capsInBook(user, String(row.bookId))
      return caps[WRITE_ACTION] ? null : `没有 ${WRITE_ACTION} 权限`
    }
    if (row.spaceId) {
      const caps = capsInSpace(user, String(row.spaceId))
      return caps[WRITE_ACTION] ? null : `没有 ${WRITE_ACTION} 权限`
    }
    return '模板必须属于某个知识库、空间，或者标成个人模板'
  }

  // 知识库设置 / 成员：需要该库的 admin
  if (def.name === 'bookSettings' || def.name === 'bookMembers') {
    const bookId = String(row.bookId || row.id || '')
    const caps = capsInBook(user, bookId)
    return caps.admin ? null : '需要该知识库的管理员权限'
  }

  const bookId = resolveBook(def, row)
  if (!bookId) return '无法确定所属知识库'

  /**
   * 空间级实体：讨论区（`topics` / `topicReplies`）和小记（`notes`）。
   *
   * 这三张表的 `bookOf` 返回的**其实是 spaceId**（`topics.spaceId` / `notes.spaceId`；
   * `topicReplies` 没有，靠 `bookOf` 顺父话题反查一次）——
   * 于是下面那行 `capsInBook(user, bookId)` 拿着一个**空间 id 去查知识库**，查不到，
   * 落回 `capsInSpace(user, null)` → 零能力 → 一律拒。
   *
   * 实测（2026-10-05，探针）：
   *   · 普通同事（注册后自动是 3 个知识库的成员、能正常编辑文档）
   *     → 发小记、发帖、回复，**全部「没有 edit 权限」**
   *   · 同一个人再显式给 B 库 editor → **还是**「没有 edit 权限」
   *   · 平台 owner 因为有 `if (user.role === 'owner') return null` 早退，反而能发
   *
   * 也就是说：**小记和讨论区只对平台管理员开放**，普通同事一个都发不出来。
   * 而这三张表根本不属于任何知识库 —— 讨论区是空间级的东西，
   * 拿「是不是某知识库的 editor」来判发言权，本来就是判错了对象。
   *
   * 所以这里按**空间成员身份**判：进了这个空间就有发言权（`capsInSpace`
   * 给空间成员 read + comment），没进就拒。发言是 `comment` 而不是 `edit` ——
   * 和评论那一类保持一致，发帖不需要文档编辑权。
   */
  const SPACE_LEVEL = isSpaceLevel(def.name)
  const isComment = SPACE_LEVEL
    || def.name === 'comments' || def.name === 'selectionComments'
    || def.name === 'commentReplies' || def.name === 'selectionCommentReplies'
  const action: Action = isComment ? 'comment' : WRITE_ACTION
  const caps: Caps = SPACE_LEVEL ? capsInSpace(user, bookId) : capsInBook(user, bookId)
  /**
   * 点赞是一种**轻互动**：语雀里 reader 也可以点，它不该要编辑权。
   *
   * 而 `likes` 是 `docs` 的一列，`docs` 默认按 `edit` 判 ——
   * 于是 reader 点 👍 → 界面从「👍 0」变成「👍 1」→ 服务端拒 →
   * 顶栏常驻「1 处修改没有保存」，**而他自己修不好**（实测 2026-10-12 探针：
   * 服务端 `likes` 仍是 null）。这和目录树、评论那几处是同一个病。
   *
   * ⚠️ **只放行「除了 likes 什么都没改」的那种推送。**
   * 判据比的是**逐列**：标题 / 正文 / 可见性 / 置顶 / 锁 任何一列动了都照旧拒 ——
   * 否则这一条等于给越权开了个口子，改标题也会被顺手放过去。
   *
   * 它放在锁判定之后：被锁的文档连点赞也不给（锁防的是「动这篇」，点赞也在内）。
   */
  if (def.name === 'docs' && !caps[WRITE_ACTION] && onlyColumnChanged(def, existing, incoming, 'likes')) {
    return null
  }
  if (!caps[action]) {
    return SPACE_LEVEL
      ? `你不是「${spaceNameOf(bookId)}」这个空间的成员，没法在那里发言`
      : `没有 ${action} 权限`
  }

  /**
   * 删评论：本人或该库的管理员。
   *
   * 上面那道 comment 权限是「能不能发言」，而发言权不等于删除权 ——
   * 不加这一条的话，任何能评论的人都能把别人的评论删掉，
   * 而讨论记录在知识库里的价值恰恰在于它不会被随手抹掉。
   */
  if ((def.name === 'comments' || def.name === 'selectionComments') && existing) {
    const author = String(existing.authorId || '')
    if (author && author !== user.id && !caps.admin) return '只能删除自己发的评论'
  }

  /**
   * 文档锁原来在这里，被 `user.role === 'owner'` 的早退提前放掉了 ——
   * 现在它挪到了**函数开头、owner 早退之前**（原因见那里）。
   *
   * 这一段留下来是记一件事：判断里那个
   * 「incoming 的 lockMemberId 得和库里一样」的第二条件**已经删掉**，
   * 而它是**给冒充者开的门**（实测见 `test-lock`）：
   *   · `lock.memberId` 客户端读得到（`GET /api/doc/:id` 就返回）
   *   · 所以 B 推 `{ id, blocks, lockMemberId: A的id }` 曾经能通过，
   *     库里正文真被改，而锁**还显示是 A 的** ——
   *     服务端认为「就是持有者本人在编辑」，A 于是收不到任何冲突提示。
   *
   * 判断现在只看 `existing.lockMemberId` 和 `user.id`，
   * **不看推上来什么**。持有者自己压根进不来这个分支，怎么推都能改。
   */
  return null
}

/**
 * 审计里把 0/1 说成「开/关」—— 事后读的人不该去猜 1 是开还是关。
 *
 * 一开始这里写了个 `if (key === 'autoRevoke') … else …`，两个分支返回同样的字。
 * 看着像「这个键特殊处理」，实际它和其他开关**完全一样**：
 * 都是 1=开、0=关，没有例外。所以那个 if 纯属多余，
 * 而且它会让人以为 autoRevoke 的语义和别的不同 —— 那才是真正的害处。
 */
const boolLabel = (v: unknown) => (v ? '开' : '关')

/** 白名单地址数：审计里只记「几个」，不记整份地址表（那是敏感信息）
 *
 * ⚠️ 必须走 `normalizeIpList`：原来的 `countList` 只 `JSON.parse` **一轮**，
 * 双重编码的行解出来是个**字符串** → `Array.isArray` 为假 → 记成「0 个」。
 * 于是一条 3 个地址的白名单，审计里写的是「白名单地址：0 个」——
 * **审计日志自己说假话**，而事后拿审计追「谁把名单清空了」的人正是靠这条。
 */
const countIps = (v: unknown) => normalizeIpList(v).length

/** 屏蔽词数：同上，只记「几个」 —— 词表本身也是内容，不该进审计 */
const countTerms = (v: unknown) => countList(v)

/** 两个 JSON 列表共用的计数：坏了就当 0，而不是让保存失败 */
const countList = (v: unknown) => {
  try {
    const a = JSON.parse(String(v || '[]'))
    return Array.isArray(a) ? a.length : 0
  } catch { return 0 }
}

const PERM_KEYS = ['read', 'comment', 'edit', 'create', 'export', 'share'] as const
const PERM_LABEL: Record<string, string> = {
  read: '阅读', comment: '评论', edit: '编辑', create: '新建', export: '导出', share: '分享',
}

/**
 * 逐项比 perms，**只返回真正变了的那几项**。
 *
 * 为什么不比整体：perms 是整个 JSON 串，审计里写「perms 变了」答不了任何问题，
 * 而事后真正要问的是「导出权是谁给的」「分享权被谁关掉的」。
 */
function permsDiff(before: unknown, after: unknown): Record<string, string> {
  const read = (v: unknown) => {
    try { return JSON.parse(String(v || '{}')) as Record<string, unknown> } catch { return {} }
  }
  const a = read(before), b = read(after)
  const out: Record<string, string> = {}
  for (const k of PERM_KEYS) {
    const from = !!a[k], to = !!b[k]
    if (from !== to) out[PERM_LABEL[k]] = `${from ? '开' : '关'} → ${to ? '开' : '关'}`
  }
  return out
}

/** 空间名：拒绝信息里说清「是哪个空间」，比丢一句「没权限」有用 */
const spaceNameOf = (spaceId: string) =>
  String((db.prepare('SELECT name FROM spaces WHERE id = ?').get(String(spaceId)) as Row | undefined)?.name || spaceId)

/** 单行 upsert，返回新的 rev */
function upsertRow(user: User, def: EntityDef, input: Row): { rev: number } | { denied: string } {  const id = String(input[def.pk] ?? '')
  if (!id) return { denied: '缺少主键' }

  const composite = COMPOSITE_PK[def.name]
  const keyCols: string[] = composite ? [...composite] : [def.pk]
  /*
   * personal 实体（`recents` / `favorites` / `follows`）的行定位**必须带归属列**。
   *
   * 它们的主键里**没有 userId**（`recents` 的主键干脆就是 `docId`），
   * 只按主键查等于「这一行不管是谁的都算同一条」。后果实测是**双向的**：
   *
   *   · 写：B 记一次「最近浏览」→ 查 `WHERE docId = ?` 命中了 **A 的那一行**
   *     → 走 UPDATE + `extra.userId = B` → **A 的那条被 B 顶掉了**。
   *     探针里「两人各自记过 → recents 只剩一行」就是这么来的。
   *   · 删：B 推 `remove: { recents: ['d1'] }` → `WHERE docId = ?` →
   *     **A 和 B 的两行一起没**（`deleteRow` 那边已同样修掉）。
   *
   * 两次都**没有任何报错**，服务端回的是 `applied` + 零拒绝。
   *
   * 这里补上之后，别人的行**根本查不到** → 走 INSERT，各存各的。
   */
  if (def.personal) keyCols.push(def.userCol || 'userId')
  const keyVals = keyCols.map((c) => (c === (def.userCol || 'userId') && def.personal ? user.id : (input[c] ?? (c === def.pk ? id : undefined))))
  const existing = (db.prepare(`SELECT * FROM ${def.table} WHERE ${keyCols.map((c) => `${c} = ?`).join(' AND ')}`)
    .get(...keyVals) as Row | undefined)

  const incoming = toRow(def, input)
  const why = denyReason(user, def, existing, incoming)
  if (why) return { denied: why }

  /**
   * slug 归一化 + 同库重名拦截。
   *
   * 两件事都必须做在**写进去之前**：
   *   · 归一化：`Deploy Guide` 和 `deploy-guide` 应该是同一个地址。
   *     不归一的话用户改了大小写就会拿到一条失效的分享链接。
   *   · 重名：唯一索引会拦，但拦出来的错是
   *     `UNIQUE constraint failed: docs.bookId, docs.slug` ——
   *     界面上没人看得懂「这跟我的路径有什么关系」。
   *     自己先查一遍，才能说清是**哪一篇**占了、建议改成什么。
   */
  if (def.name === 'docs' && 'slug' in input) {
    const slug = normalizeSlug(input.slug)
    incoming.slug = slug
    if (slug) {
      const owner = db.prepare(
        "SELECT title FROM docs WHERE bookId = ? AND slug = ? AND id <> ? AND COALESCE(trashed,0) = 0",
      ).get(String(incoming.bookId || existing?.bookId || ''), slug, id) as Row | undefined
      if (owner) {
        return { denied: `这个路径已被《${String(owner.title || '另一篇文档')}》占用，同一个知识库里路径要唯一` }
      }
    }
  }

  /**
   * ~~曾经在这里用 `blocks` 重算 `body` / `wordCount`~~ —— **撤掉了，别加回来。**
   *
   * 想法是：客户端有好几个写入点（7.17 补完前是三个），
   * 而 `body` / `wordCount` 都在服务端 `docs` 实体的 `writable` 里 ——
   * 旧版本客户端、导入包、任何直接调 API 的人，都能推一对自相矛盾的值。
   * 在服务端兜一道，确实是「派生值在写入点算，而这个写入点谁也绕不过去」。
   *
   * **但它把 `test-doclinks` 弄红了**（33/9），而那揭示的是一个**没定论的问题**：
   *
   * `docLinkSources` 明确扫 `body` —— 也就是**设计上 body 可以携带
   * blocks 表达不了的内容**。用例里链接正是**只写在 body、blocks 是空的**，
   * 重算之后 body 变成 `# `，链接没了，反向引用全空。
   *
   * 所以真正的问题是「**body 与 blocks 谁是权威**」，而这个问题没有答案：
   *   · 客户端那侧能自洽（body = f(blocks)），所以只在客户端算就够了
   *   · 服务端这侧要重算，就得先接受「body 不能再有独立于 blocks 的内容」
   *     —— 而那是**改变既有契约**，不是我该单方面做的取舍
   *
   * 留着的风险是：旧客户端推上来的陈旧 body 会被照单全收
   * （导出可能拿到旧内容）。但那至少是**行为可预测**的，
   * 比「客户端说 A、库里是 B」要好。
   *
   * 而且这里本来就有**两个权威并存**，不是只有「blocks 权威」那一个：
   *   · 网页编辑器：blocks 权威，body 是它的投影（7.17 在客户端的写入点算）
   *   · `/api/v2` 建文稿：`body: md, blocks: blocksOfMarkdown(md)`
   *     —— body 权威，blocks 是从它派生的（见 server/index.ts）
   * 服务端要替任一边做决定，等于**单方面废掉另一边**。
   * 要统一，得先决定哪条路作废 —— 那是产品取舍。
   *
   * 下面的断言钉住的正是「不重算」这个现状：
   * 客户端推什么 body，库里就是什么 body；没推就保持原样。
   * `test-bodyserver.mjs` 守着这两条。
   */

  const rev = Number(existing?.rev ?? 0) + 1
  const cols0 = tableColumns(def.table)
  const extra: Row = {}
  if (cols0.has('rev')) extra.rev = rev
  if (cols0.has('updatedBy')) extra.updatedBy = user.id
  if (def.personal && cols0.has(def.userCol || 'userId')) extra[def.userCol || 'userId'] = user.id
  /**
   * 个人模板的 `ownerId` 由**服务端**写死，不看推上来什么。
   *
   * 和上面 personal 实体的 `userId` 是同一个道理，但这条不能靠
   * `def.personal` 顺带覆盖 —— `templates` 是张普通表（官方模板不是任何人的），
   * 标成 personal 会把「官方模板人人可读」那条一起弄坏。
   *
   * 不强制的话 B 能建出一个 `ownerId = A` 的个人模板：
   * 那份东西出现在 **A** 的模板列表里，而 B 自己按 ownerId 判反而改不了它。
   * 判据那边（`denyReason` 的 templates 分支）已经**不看** incoming.ownerId 了，
   * 所以强制赋值是最后一道，也是唯一一道。
   */
  if (def.name === 'templates' && String(incoming.scope || '') === 'mine' && cols0.has('ownerId')) {
    extra.ownerId = user.id
  }
  // 书单/目录的 createdAt 由客户端给，不覆盖服务端已有值
  if (existing?.createdAt != null && def.name === 'books') extra.createdAt = existing.createdAt

  const cols = { ...existing, ...incoming, ...extra }
  const keys = Object.keys(cols).filter((k) => cols0.has(k))
  const vals = keys.map((k) => cols[k] as any)

  // 存在则 UPDATE，不存在则 INSERT。
  // 不用 INSERT ... ON CONFLICT：它要求指定冲突目标，
  // 而这里的主键有单列（docs.id）和复合（book_members.bookId+userId）两种形态，
  // 按存在性分支更直白，也不会在复合主键上静默失效。
  /**
   * 单行写入失败（外键指向不存在的关联、字段超长、类型不符…）**不要炸掉整批**。
   *
   * 导入数据包时最容易踩：包里带着 `bookMembers` 指向源库才有的用户，
   * 目标库没有这个人 → FOREIGN KEY constraint failed → 整个事务回滚，
   * 一篇都导不进来。恢复动作最需要的是「能导多少算多少，并如实说清少了什么」。
   */
  try {
    if (existing) {
      const setKeys = keys.filter((k) => !keyCols.includes(k))
      const setSql = setKeys.map((k) => `${k} = ?`).join(', ')
      const setVals = setKeys.map((k) => cols[k] as any)
      // 复合主键（book_members 的 bookId+userId）必须两个条件都带上：
      // 只按 userId 匹配会把同一个人在**别的知识库**里的那行也一起改掉。
      const whereSql = keyCols.map((k) => `${k} = ?`).join(' AND ')
      const whereVals = keyCols.map((k) => cols[k] as any)
      if (setSql) db.prepare(`UPDATE ${def.table} SET ${setSql} WHERE ${whereSql}`).run(...setVals, ...whereVals)
    } else {
      db.prepare(`INSERT INTO ${def.table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...vals)
    }
  } catch (e: any) {
    return { denied: '关联数据不存在或数据不合法，已跳过：' + String(e?.message || '').slice(0, 80) }
  }

  logChange(def.name, id, 'upsert', rev, user.id)

  /**
   * 建库的人自动成为这个库的 owner —— **由服务端保证**，不指望客户端补推。
   *
   * 客户端的 `createBook` 会把 books 和 bookMembers 放进同一次 commit，
   * 但服务端那一行 bookMembers 会被 `denyReason` 的
   * 「需要该知识库的管理员权限」拒掉 —— 推它的那一刻，这个库的管理员身份
   * 正是要靠这次创建来产生。于是**库建出来了，却没有任何人是它的 owner**，
   * 创建者自己打不开（`capsInBook` 查不到成员行 → NONE）。
   *
   * 另一个方向的问题是客户端不该有这层义务：只要哪条路径推 books 时
   * 少带了 bookMembers，库里就会留下一个谁也管不了的库。
   *
   * 所以不去 `bookMembers` 的判据上开「新建库豁免」这种口子
   * （那得判断「这一行是不是某个新库的成员行」，很容易开成真漏洞），
   * 而是把这条不变量直接做掉：**谁建的，谁是 owner。**
   *
   * 幂等：先查再插。重放同一次创建、或客户端在下一轮 push 里
   * 又把那行 bookMembers 推上来（这时他已经是该库 owner，能通过判据），
   * 都不会多出第二行 —— 复合主键 (bookId,userId) 也会挡一层。
   *
   * ⚠️ **`user.role !== 'owner'` 这半个条件不能去掉** ——
   * 去掉它第一版就把 `test-sync-converge` 弄红了，而它揭示的是**真的**：
   *
   * 平台 owner 靠 `capsInBook` 开头的 `if (user.role === 'owner') return admin`
   * 访问**任何**库，他**根本不需要成员行**。给他补一行 = 在表里造一条
   * 没有语义的数据。
   *
   * 代价具体长什么样：`test-sync-converge` 里同一个人是**多个库**的成员，
   * 它重建状态时按 `userId` 单键索引 `bookMembers`（客户端用的是复合键
   * `bookId::userId`，测试为了简单换成了单键）。owner 建库时补出来的那一行
   * 让 `u_admin` 这个键在**增量**和**全量**下解析到了不同的行，
   * 于是「增量追平 == 全量重拉」这条最基础的不变量红了。
   *
   * 注意这不是「测试太严」：它说明**这条不变量此前成立是有前提的**
   * —— 前提是「没有人会主动往 book_members 里塞没有语义的行」。
   * 我的补行越过了这个前提，而它在补之前没有人检查过。
   */
  if (def.name === 'books' && !existing && user.role !== 'owner') {
    const already = db.prepare('SELECT 1 AS x FROM book_members WHERE bookId = ? AND userId = ?').get(id, user.id)
    if (!already) {
      db.prepare('INSERT INTO book_members (bookId,userId,role,perms,joinedAt) VALUES (?,?,?,?,?)')
        .run(id, user.id, 'owner', JSON.stringify({}), Date.now())
      logChange('bookMembers', user.id, 'upsert', 1, user.id)
    }
  }

  /**
   * 知识库安全设置要记审计 —— 而且**只记真正变了的开关**。
   *
   * 为什么在这里而不是某个专用接口：设置中心是**客户端 store 直接改**的，
   * 经 `/api/sync/push` 落库，服务端压根没有「改设置」这个路由。
   * （`AUDIT.settingsChange` 早就定义了、中文名也写了，但没人调用它。）
   *
   * 为什么只记变化：设置行是**整行推**的，客户端每次打开设置中心
   * 都会把所有开关原样推一遍。不比差异的话，审计里会出现
   * 「改了 7 个开关 → 0 变化」这种记录，多到没人看，
   * 而**真正要查的那一条正好淹在里面**。
   *
   * 记的是「谁把哪个开关从什么改成什么」，因为事后要回答的是
   * 「IP 白名单是什么时候没的」「禁止导出是什么时候被关掉的」，
   * 光记「改了设置」答不上。
   */
  if (def.name === 'bookSettings') {
    /*
     * 要盯住的开关。
     *
     * 判断标准是「**它坏掉时有人会知道吗**」，不是「它算不算设置」：
     * · IP 白名单 / 禁止导出 / 公开访问 / 离职自动回收 —— 关掉就直接放开了什么
     * · 搜索屏蔽 —— 关掉之后**被屏蔽的词就搜到了**，那是安全事件
     * · 水印 —— 关掉之后内部标识就没了
     * 而 `defaultWidth` / `defaultVisibility` 不在这儿：那是排版与默认可见性，
     * 改了没人「受害」，进了审计只会把真信号淹掉。
     *
     * ⚠️ `blockSearch` / `blockTerms` 原来是**漏的** ——
     * 2026-10-05 我给设置加审计时只列了 6 项，漏了这两个。
     * 而它们恰恰是安全开关（「谁在什么时候把搜索屏蔽关了」和
     * 「谁在什么时候把 IP 白名单关了」是同一类问题）。
     *
     * 这不是「一开始就想漏了」，是**加的时候没数一遍**：
     * `book_settings` 的列清单在项目里有**五份**（CREATE TABLE / seed 的
     * INSERT / `defaultBookSettings()` / 这里的 `writable` / 这张 WATCHED），
     * 每份独立维护，漏一处就静默失效。
     * 我试过为此写一条 lint（比对五份清单），**撤了** ——
     * 因为 `defaultBookSettings()` 故意只有 10 个键（`blockSearch` /
     * `blockTerms` 前端不给默认值，用表默认的「不屏蔽」），
     * 「五处应当一致」这个不变量**本身就不成立**，
     * 硬凑的检查只会误报。教训留在下面，不做成检查。
     */
    const WATCHED: Record<string, string> = {
      ipWhitelist: 'IP 白名单', ipList: '白名单地址',
      restrictExport: '禁止导出', publicAccess: '公开访问',
      watermark: '水印', autoRevoke: '离职自动回收',
      blockSearch: '搜索关键词屏蔽', blockTerms: '屏蔽词表',
    }
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    /** 两个 JSON 列表列：只记「几个」，不记整份内容（地址表、词表都是敏感内容） */
    const LIST_COLS: Record<string, (v: unknown) => number> = {
      ipList: countIps,
      blockTerms: countTerms,
    }
    for (const [k, label] of Object.entries(WATCHED)) {
      if (!(k in (incoming as Row))) continue
      const before = (existing as Row | null)?.[k]
      const after = (incoming as Row)[k]
      if (String(before ?? '') === String(after ?? '')) continue
      const count = LIST_COLS[k]
      changes[label] = count
        ? { from: `${count(before)} 个`, to: `${count(after)} 个` }
        : { from: boolLabel(before), to: boolLabel(after) }
    }
    if (Object.keys(changes).length) {
      const name = String((db.prepare('SELECT name FROM books WHERE id = ?').get(String(id)) as Row | undefined)?.name || '')
      logAudit({
        actorId: user.id,
        action: AUDIT.settingsChange,
        targetType: 'book',
        targetId: String(id),
        targetName: name,
        detail: { changes },
      })
    }
  }

  /**
   * 知识库成员的**新增 / 改权限**要记 —— 而它以前**也**没人记。
   *
   * 同样是「同一个界面上，一半记一半不记」：
   *   · 空间成员增删 → `POST /api/spaces/:id/members`（专用路由，记了）
   *   · 知识库成员增删 → `/api/sync/push`（**没有专用路由**）
   * 于是「谁把谁放进这个知识库、给了什么权限」查不到，
   * 而权限授予恰恰是最需要留痕的那一类
   * （`denyReason` 那一层就是专门判它的）。
   *
   * 只记**新增**：这里已存在的行被 UPDATE（改 role / perms）也是「权限变了」，
   * 但和新增混在一条记录里会读不清 —— 所以**分开记**，
   * 改动那条见 `deleteRow` 旁边（移除）与下面这段之后的说明。
   */
  if (def.name === 'bookMembers' && existing) {
    const bookId = String((incoming as Row).bookId || '')
    const bookName = String((db.prepare('SELECT name FROM books WHERE id = ?').get(bookId) as Row | undefined)?.name || '')
    const who = db.prepare('SELECT name, account FROM users WHERE id = ?').get(String(id)) as Row | undefined
    if (bookId && id) {
      const from = { role: String(existing.role || ''), perms: existing.perms }
      const to = { role: String((incoming as Row).role || ''), perms: (incoming as Row).perms }
      // 角色没变、perms 也没变 → 什么都没改，不记
      if (String(from.role) !== String(to.role) || String(from.perms ?? '') !== String(to.perms ?? '')) {
        logAudit({
          actorId: user.id,
          action: AUDIT.bookMemberAdd,
          targetType: 'book',
          targetId: bookId,
          targetName: bookName,
          detail: {
            userId: id,
            name: String(who?.name || ''),
            account: String(who?.account || ''),
            role: to.role,
            from: from.role,
            // perms 逐项比：事后要问的是「导出权是谁给的」，不是「perms 变没变」
            permsChanged: permsDiff(from.perms, to.perms),
          },
        })
      }
    }
  }

  // 文稿写完同步刷新检索投影，否则新写的字搜不到
  if (def.name === 'docs' || def.name === 'books' || def.name === 'notes') reindex(def.name === 'docs' ? 'doc' : def.name === 'books' ? 'book' : 'note', id)
  // 同理：正文改了，「谁引用了我」也得跟着重算，否则删掉链接后列表还留着
  if (def.name === 'docs') {
    relink(id)
    reindexParentBook(id)
  }
  return { rev }
}

/**
 * 文稿变了，顺手把它**所属知识库**的索引也重建一次。
 *
 * 知识库的索引正文 = 它下面所有文稿的标题（见 reindex 的 'book' 分支），
 * 所以文稿**新增 / 改名 / 删除**都会让书级索引变陈旧。
 *
 * 而原来只在书自己被写的时候才重建它，于是实测出来两头都错：
 *   · 改标题后搜**新**标题 → 只命中文档，命不中知识库（书级索引还是旧标题）
 *   · 改标题后搜**旧**标题 → 只剩知识库命中，**库里留着改名之前的内容**
 * 删文档更糟：它的标题会永远留在书级索引里，删了还能搜到。
 */
function reindexParentBook(docId: string) {
  try {
    const row = db.prepare('SELECT bookId FROM docs WHERE id = ?').get(docId) as Row | undefined
    if (row?.bookId) reindex('book', String(row.bookId))
  } catch (e) {
    // 重建失败不该让用户的保存失败（正文已经落库了），
    // 但要喊 —— 否则表现是「书在搜索里搜不全」这种很难自查的问题
    console.warn('[search] 刷新所属知识库索引失败', docId, e)
  }
}

function deleteRow(user: User, def: EntityDef, id: string): { ok: true } | { denied: string } {
  /**
   * 复合主键的行，id 传的是 `bookId::userId`。
   *
   * 之前这里只按 def.pk（userId）删，于是「把人从 A 知识库移出」会把他
   * 在 B、C、D 知识库里的成员身份**一起删掉** —— 而界面上只显示 A 少了一行。
   * 权限被静默放大，排查时根本想不到跟这里有关。
   */
  const composite = COMPOSITE_PK[def.name]
  const sep = composite ? id.indexOf('::') : -1
  // 键列与参数必须一一对应。复合 id 里没有 `::`（老客户端只给了一个 id）时，
  // 退化成按单列删 —— 这时如果还按两列传参，占位符和参数个数就对不上了。
  const keyCols: string[] = composite && sep >= 0 ? [...composite] : [def.pk]
  const keyVals: any[] = composite && sep >= 0 ? [id.slice(0, sep), id.slice(sep + 2)] : [id]

  /**
   * personal 实体的删除条件**必须带上归属列**。
   *
   * `recents` / `favorites` / `follows` 的主键里**没有 userId**
   * （`recents` 的主键干脆就是 `docId`），所以只按主键删等于
   * **「删掉所有人对应的那一行」**。而 `denyReason` 第一行
   * `if (def.personal) return null` 又是放行的 ——
   * 两边凑在一起就成了：**任何一个登录用户，推一条 remove 就能删掉别人的收藏、
   * 别人的关注、别人的最近浏览。**
   *
   * 实测（2026-10-05，探针）：C 推 `remove: { recents: ['d1'] }`，
   * 服务端回 `applied` + **零拒绝**，而库里 A 的那一行**也一起没了**。
   * `docId` 在任何文档 URL 里都公开，所以这条**人人都能触发**；
   * 收藏 id 是随机 `uid()` 不易猜，但「知道就能删」已经足够。
   *
   * 加了归属列之后，别人的行对当前用户**根本查不到**
   * （下面 `existing` 取不到就 `return { ok: true }`）——
   * 也就是「删自己的」照样成功，而「删别人的」变成**静默无效**。
   * 静默无效而不是报错：客户端差分只知道自己删了哪一行，
   * 报错会在顶栏挂一条「N 处没保存」，而那对用户是**不存在的**问题。
   */
  if (def.personal) {
    const ucol = def.userCol || 'userId'
    keyCols.push(ucol)
    keyVals.push(user.id)
  }
  const whereSql = keyCols.map((c) => `${c} = ?`).join(' AND ')

  const existing = db.prepare(`SELECT * FROM ${def.table} WHERE ${whereSql}`).get(...keyVals) as Row | undefined
  if (!existing) return { ok: true }
  const why = denyReason(user, def, existing, {})
  if (why) return { denied: why }

  /**
   * 文稿走**软删除**：只翻标记，正文、版本、评论全部留着。
   *
   * 之前是硬删，删完 `GET /api/doc/:id` 直接 404，而回收站里还列着它、
   * 点「恢复」只弹一句「已恢复，请重新归档」—— 内容其实早就没了。
   * 那不叫回收站，叫删除记录的墓碑。误删一篇文档就等于永久丢失，
   * 而界面上完全看不出这一点。
   */
  if (def.name === 'docs') {
    if (Number(existing.trashed) === 1) return { ok: true }
    const rev = Number(existing.rev || 0) + 1
    // deletedAt 由**服务端**写，不采信客户端推上来的 trash.deletedAt ——
    // 那是保留期的计时基准，让客户端定就等于让它决定「什么时候被销毁」。
    db.prepare('UPDATE docs SET trashed = 1, deletedAt = ?, rev = ?, updatedBy = ? WHERE id = ?')
      .run(Date.now(), rev, user.id, String(existing.id))
    logChange('docs', String(existing.id), 'upsert', rev, user.id)
    /*
     * 目录树里那一项**藏起来，而不是删掉**。
     *
     * 为什么：以前这里是把节点一起删掉的（客户端 `deleteDoc` 过滤掉那个 node，
     * 推上来就真删了）。于是 `restoreDoc` 只翻得回 `docs.trashed`，
     * **树上的位置找不回来了** —— 文稿回到库里，却哪儿都点不着。
     * 提示还写着「已还原到原位置」，那句话是假的
     * （实测：还原后 `nodes` 里 0 行引用它；见 `test-trash-perms.mjs` ⑥）。
     *
     * 改法用现成的 `nodes.hidden` 列：目录树本来就不渲染 `hidden` 的节点
     * （`Tree.tsx`），导出也跳过它们（`book-export.ts`）——
     * 也就是说「软删期间它在树上不可见」这件事**本来就需要**，
     * 之前是靠着真删节点顺带实现的，等于拿「结构性的删除」顶替了「可见性」。
     *
     * 真正删节点的地方仍然是 `purgeDocCore`（永久删除）—— 那时才该连位置一起去掉。
     */
    hideNodesOfDoc(String(existing.id), user.id)
    // 删掉的标题不能永远留在所属知识库的索引里 —— 搜「旧标题」会搜到那个库，
    // 而库里已经什么都没有了。恢复（restoreDoc / purgeDoc）那边也会重建。
    reindexParentBook(String(existing.id))
    return { ok: true }
  }

  db.prepare(`DELETE FROM ${def.table} WHERE ${whereSql}`).run(...keyVals)
  if (def.name === 'books' || def.name === 'notes') {
    dropIndexOf(def.name === 'books' ? 'book' : 'note', id)
  }
  /**
   * 移出知识库成员要记 —— 和 `upsertRow` 里那条「加进来 / 改权限」配成一对。
   *
   * 为什么必须写在这里而不是 upsertRow：删除走的是 `remove`，
   * **压根不经过 upsertRow**。只在 upsertRow 里记的话，
   * 「谁把谁移出了这个知识库」永远查不到 ——
   * 而「权限是什么时候没的、谁动的」正是出事时第一句要问的
   * （空间成员那条 `/api/spaces/:id/members` 里就是这么写的）。
   *
   * 只有 `bookId::userId` 那种复合 id 能认出人；
   * 老客户端只给一个 id 时退化成按单列删，**认不出是谁就不记** ——
   * 留空比记错强。
   */
  if (def.name === 'bookMembers' && sep >= 0) {
    const bookId = String(keyVals[0])
    const userId = String(keyVals[1])
    const bookName = String((db.prepare('SELECT name FROM books WHERE id = ?').get(bookId) as Row | undefined)?.name || '')
    const who = db.prepare('SELECT name, account FROM users WHERE id = ?').get(userId) as Row | undefined
    logAudit({
      actorId: user.id,
      action: AUDIT.bookMemberRemove,
      targetType: 'book',
      targetId: bookId,
      targetName: bookName,
      detail: {
        userId,
        name: String(who?.name || ''),
        account: String(who?.account || ''),
        role: String(existing.role || ''),
        // 顺带记下他当时有的权限：事后要判断「他走之前能看多少」时，原始数据已经没了
        perms: existing.perms,
      },
    })
  }
  logChange(def.name, id, 'delete', Number(existing.rev || 0), user.id)
  return { ok: true }
}

/** 恢复一篇被软删的文稿：翻回标记即可，正文是原封不动的 */
export function restoreDoc(user: User, docId: string): { ok: boolean; reason?: string } {
  const row = docRow(docId)
  if (!row) return { ok: false, reason: '文档不存在，或已被彻底删除' }
  const caps = row.bookId ? capsInBook(user, String(row.bookId)) : null
  if (!caps || !caps.edit) return { ok: false, reason: '没有恢复该文档的权限' }
  const rev = Number(row.rev || 0) + 1
  db.prepare('UPDATE docs SET trashed = 0, rev = ?, updatedBy = ?, updatedAt = ? WHERE id = ?')
    .run(rev, user.id, Date.now(), docId)
  db.prepare('DELETE FROM trash WHERE docId = ?').run(docId)
  /*
   * 把目录树里的位置放回去 —— 软删时是**藏**节点而不是删节点（见 `hideNodesOfDoc`）。
   * 不做这一步的话：文稿回到库里了，可树上哪儿都点不着，
   * 而提示写着「已还原到原位置」。
   */
  showNodesOfDoc(docId, user.id)
  logChange('docs', docId, 'upsert', rev, user.id)
  // 恢复之后这篇的标题该重新出现在所属知识库的搜索里
  reindex('doc', docId)
  reindexParentBook(docId)
  return { ok: true }
}

/** 彻底删除 —— 这才是不可逆的操作，只有知识库管理员能做 */
export function purgeDoc(user: User, docId: string): { ok: boolean; reason?: string } {
  const row = docRow(docId)
  if (!row) return { ok: false, reason: '文档不存在' }
  const caps = row.bookId ? capsInBook(user, String(row.bookId)) : null
  if (!caps || !caps.admin) return { ok: false, reason: '只有知识库管理员可以彻底删除' }
  purgeDocCore(docId, row, user.id)
  return { ok: true }
}

/**
 * 彻底删除一个知识库 —— 连带它下面**所有**文档一起删干净，不可恢复。
 *
 * 语义跟语雀一致：**硬删**。语雀的回收站只管文档，不管知识库，
 * 所以「删库」这一步本身没有后悔药。本项目的回收站也只到文档一级
 * （`trash` 表存的是 docId），所以这里**不能**走「把文档全塞进回收站」那条路 ——
 * 那样恢复单篇文档时它指向的知识库已经没了，会留下一批点不动的孤儿文档。
 *
 * ⚠️ 逐篇**复用 `purgeDoc`**，不重写一遍级联：
 *   docs / trash / 版本 / 评论 / 划词评论 / 附件（含共享附件的归属迁移）/
 *   目录节点 / 搜索索引 / 收藏 / 关注 / 最近访问 —— 每一项都是 `purgeDoc`
 *   已经处理过的。两处各写一遍，漏一项就是「删库之后还能搜到那篇的标题」。
 *
 * 为什么必须显式清：`docs.bookId` 是**冗余列、没有外键**
 * （`db.ts:164` 就是个裸 `TEXT`），而 `nodes` / `book_members` / `book_settings`
 * 都带 `ON DELETE CASCADE`。所以光删 `books` 那一行，**文档会全部留下**。
 */
export function deleteBook(user: User, bookId: string): { ok: boolean; reason?: string; purged: number; failed: { docId: string; reason: string }[] } {
  const book = db.prepare('SELECT id, name, rev FROM books WHERE id = ?').get(bookId) as Row | undefined
  if (!book) return { ok: false, reason: '知识库不存在', purged: 0, failed: [] }
  if (!capsInBook(user, bookId).admin) return { ok: false, reason: '只有知识库管理员可以删除知识库', purged: 0, failed: [] }

  /*
   * 要删的文档 = `docs.bookId` 指过来的 **∪** 该库目录节点挂着的。
   *
   * 只按 `docs.bookId` 查是不够的：那一列是**为了省一次查询而冗余出来的**
   * （`db.ts:162` 的注释就是这么写的），历史数据 / 早期版本建出来的文档
   * 完全可能 bookId 是空的而只有节点指路 —— 那样删完库，这些文档就成了
   * 既不在任何库里、又删不掉的孤儿。宁可多查一次节点表。
   */
  const ids = new Set<string>()
  for (const r of db.prepare('SELECT id FROM docs WHERE bookId = ?').all(bookId) as Row[]) ids.add(String(r.id))
  for (const r of db.prepare('SELECT docId FROM nodes WHERE bookId = ? AND docId IS NOT NULL').all(bookId) as Row[]) ids.add(String(r.docId))

  let purged = 0
  const failed: { docId: string; reason: string }[] = []
  for (const docId of ids) {
    const res = purgeDoc(user, docId)
    if (res.ok) purged++
    else failed.push({ docId, reason: res.reason || '删除失败' })
  }

  /*
   * 有文档删不掉就**整次中止**：库还在、文档少了一半 ——
   * 那是最难收拾的一种中间状态（用户以为删干净了，其实只剩一半）。
   * 报告哪几篇删不掉，让人先把权限问题处理掉再来。
   */
  if (failed.length) {
    return { ok: false, reason: `有 ${failed.length} 篇文档删不掉，已中止，知识库没有被删除`, purged, failed }
  }

  // 库级的东西：收藏/关注是按 targetType + targetId 存的，不走外键
  db.prepare('DELETE FROM favorites WHERE targetType = ? AND targetId = ?').run('book', bookId)
  db.prepare('DELETE FROM follows WHERE targetType = ? AND targetId = ?').run('book', bookId)
  // book_members / book_settings / 剩下的分组节点：靠 ON DELETE CASCADE
  db.prepare('DELETE FROM books WHERE id = ?').run(bookId)
  dropIndexOf('book', bookId)
  // 别的设备要靠这条把库从列表里摘掉，不记的话它们那边会留一个点进去 404 的死库
  logChange('books', bookId, 'delete', Number(book.rev || 0), user.id)
  return { ok: true, purged, failed }
}

/**
 * 真正把那篇删干净：docs / trash / 版本 / 索引，一条不留。
 *
 * 抽出来是因为**保留期任务**也要用它 —— 自动清除没有「当前用户」，
 * 走不了上面那道权限判定。但它做的必须是同一件事：
 * 如果这里只把 docs 那一行删掉，那么
 *   · 搜索索引里还留着那篇的标题（旧库的书级索引也会一直显示它）
 *   · doc_versions 里的历史版本成了孤儿
 *   · 别的设备拉增量时收到的是「删了一行」，本地却删不掉
 * 所以宁可重复一遍，也不要出现「自动清的和手动清的结果不一样」。
 *
 * actorId 记进 changes：系统任务传 'system'，这样审计里能看出
 * 这一篇是被**保留期**清掉的，而不是某个人手动删的。
 */
function purgeDocCore(docId: string, row: Row, actorId: string) {
  // bookId 必须在**删之前**取：行一没，reindexParentBook 就查不到了，
  // 书级索引里那篇的标题就会永远留着（实测就是彻底删完还能搜到那个库）
  const bookIdOfDoc = String(row.bookId || '')

  /**
   * 连带清干净。
   *
   * 这里以前只删了 docs / trash / doc_versions 三张表 ——
   * 而实测（test-docpurge）永久删除一篇带附件和评论的文档之后：
   *   · **目录树上那一项还在**（点进去是 404）
   *   · 附件 BLOB 还在（几百 MB 堆在库里，而且**永远不会被回收**）
   *   · 评论、划词评论、收藏、最近访问、协作快照、阅读记录、分享设置，全都还在
   *
   * `attachments.docId` 没有外键，所以不会级联；而**没有任何别的东西**会回收它们。
   * 一句话说：以前那句「永久删除」只是让那一行不见了，别的东西都还在原地。
   *
   * 顺序有讲究：先拿住评论 id（要先删回复、再删评论），最后才删 docs。
   */
  const commentIds = db.prepare('SELECT id FROM comments WHERE docId = ?').all(docId).map((r: Row) => String(r.id))
  const selIds = db.prepare('SELECT id FROM selection_comments WHERE docId = ?').all(docId).map((r: Row) => String(r.id))
  for (const cid of commentIds) db.prepare('DELETE FROM comment_replies WHERE commentId = ?').run(cid)
  for (const sid of selIds) db.prepare('DELETE FROM selection_comment_replies WHERE selectionCommentId = ?').run(sid)
  db.prepare('DELETE FROM comments WHERE docId = ?').run(docId)
  db.prepare('DELETE FROM selection_comments WHERE docId = ?').run(docId)

  /*
   * 附件是最要紧的一条：BLOB 不会被任何机制回收。
   *
   * 但**不能按 docId 一把梭**。`attachments.docId` 只说明「谁传的」，
   * 说明不了「谁还在用」—— 而复制一篇带附件的文档时 `moveDoc` 是
   * **逐字照抄 blocks** 的，于是副本和原件指向同一个附件 id，
   * 表里却只记了原件那一份。
   *
   * 于是「永久删除原件」会连带把副本还在用的附件删掉：
   * 实测 —— 删掉原件返回 200，副本文档完好无损地还在，
   * 而它的附件 404 了。永久删除是最破坏性的操作，
   * 用户要的「那一篇没了」绝不该变成「旁边那篇坏了」。
   *
   * 所以这里逐个看：还有别的文档引用着就留下。
   * `excludeDocId` 是**本文档自己** —— 此刻 docs 行还在，
   * 不排除的话每个附件都会被自己判成「还有人用」，一个都删不掉。
   */
  {
    const mine = db.prepare('SELECT id, docId FROM attachments WHERE docId = ?').all(docId) as Row[]
    for (const a of mine) {
      const key = String(a.id)
      const others = docsReferencing(key, docId)
      if (others.length === 0) {
        db.prepare('DELETE FROM attachments WHERE id = ?').run(key)
        continue
      }
      /*
       * 留下还不够 —— **归属也得跟着搬家**。
       *
       * `attachments.docId` 此刻还指着本文档，而本文档马上就要被删。
       * 于是下载鉴权 `capsOfDoc(u, row.docId)` 会落在一个不存在的文档上，
       * 判出「没有权限」—— 附件**还在库里，但谁都下不到**。
       * 实测：永久删除原件返回 200，二进制保住了，而副本取它拿到 **403**。
       *
       * 所以把归属改到还活着的那一篇上。只改一个字段，权限模型
       * （按 docId 判）不用动，审计与引用计数也都照旧。
       */
      db.prepare('UPDATE attachments SET docId = ? WHERE id = ?').run(others[0], key)
      console.warn(
        `[purge] 附件 ${key} 还有 ${others.length} 篇文档在引用，保留并把归属改到 ${others[0]}（${others.join('、')}）`,
      )
    }
  }

  // 目录树：留着就是一个点进去 404 的死项
  const nodeIds = db.prepare('SELECT id FROM nodes WHERE docId = ?').all(docId).map((r: Row) => String(r.id))
  db.prepare('DELETE FROM nodes WHERE docId = ?').run(docId)

  db.prepare('DELETE FROM doc_versions WHERE docId = ?').run(docId)
  // 反向引用：谁引用了这篇，也要跟着断（这一篇本身已经从 doc_links 里被清过）
  db.prepare('DELETE FROM doc_links WHERE sourceDocId = ? OR targetDocId = ?').run(docId, docId)
  db.prepare('DELETE FROM recents WHERE docId = ?').run(docId)
  db.prepare('DELETE FROM doc_snapshots WHERE docId = ?').run(docId)
  db.prepare('DELETE FROM doc_views WHERE docId = ?').run(docId)
  db.prepare('DELETE FROM doc_share WHERE docId = ?').run(docId)
  db.prepare('DELETE FROM favorites WHERE targetType = ? AND targetId = ?').run('doc', docId)
  db.prepare('DELETE FROM follows WHERE targetType = ? AND targetId = ?').run('doc', docId)

  db.prepare('DELETE FROM docs WHERE id = ?').run(docId)
  db.prepare('DELETE FROM trash WHERE docId = ?').run(docId)
  dropIndexOf('doc', docId)
  if (bookIdOfDoc) {
    try { reindex('book', bookIdOfDoc) } catch (e) { console.warn('[search] 刷新所属知识库索引失败', docId, e) }
  }
  logChange('docs', docId, 'delete', Number(row.rev || 0), actorId)
  // nodes 也记一笔：别的设备要靠这个把树上那一项摘掉，
  // 不记的话别的设备树上会留着一个点进去 404 的死项
  for (const nid of nodeIds) logChange('nodes', nid, 'delete', 0, actorId)
}

/** 回收站保留期（天）。0 = 不自动清除。可用环境变量 YQ_TRASH_DAYS 改 */
export function trashRetentionDays(): number {
  const raw = String(process.env.YQ_TRASH_DAYS ?? '30').trim()
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30
}

/**
 * 回收站保留期：**到期自动永久清除**。
 *
 * 回收站页一直写着「删除的文档保留 30 天，过期后自动永久清除」，
 * 还给每篇算了个「还剩 N 天」的倒计时 —— 而全仓库**没有任何东西会清除它们**，
 * 文档会一直躺着。公司按这句话理解自己的数据保留策略，会得出一个错的结论。
 *
 * 三条不能省的约束：
 *
 * ① **只认 docs.deletedAt**，不认 trash.deletedAt。后者是客户端推上来的，
 *    传 0 就等于「1970 年删的」—— 而这正是要**销毁数据**的地方，
 *    让客户端来定这个时刻，等于把删除开关交到外面。
 * ② **deletedAt = 0 的一律跳过**（不知道什么时候删的）。宁可多留着。
 * ③ **分批**。一次删几千行会把 SQLite 写锁占满，而这是后台任务，
 *    用户正在编辑。一次几十篇、跑几轮更稳。
 */
export function purgeExpiredTrash(days: number, batch = 40): { purged: number; scanned: number; skippedUnknown: number } {
  if (!Number.isFinite(days) || days <= 0) return { purged: 0, scanned: 0, skippedUnknown: 0 }
  const cutoff = Date.now() - days * 86400000
  const rows = db.prepare(
    'SELECT id FROM docs WHERE trashed = 1 AND deletedAt > 0 AND deletedAt < ? LIMIT ?',
  ).all(cutoff, batch) as Row[]
  const unknown = Number((db.prepare(
    'SELECT COUNT(*) AS n FROM docs WHERE trashed = 1 AND COALESCE(deletedAt, 0) = 0',
  ).get() as Row).n)
  let purged = 0
  for (const r of rows) {
    const id = String(r.id)
    const row = docRow(id)
    if (!row) continue
    try {
      purgeDocCore(id, row, 'system')
      purged++
    } catch (e) {
      // 一篇失败不该中断整批 —— 下一轮还会再试它
      console.warn('[trash] 保留期清除某一篇失败', id, e)
    }
  }
  return { purged, scanned: rows.length, skippedUnknown: unknown }
}

/**
 * 哪些文档的正文里还引用着这个附件（`excludeDocId` 那篇不算）。
 *
 * ============================================================
 * 为什么要按**正文**判，而不是按 `attachments.docId`
 * ------------------------------------------------------------
 * 复制一篇带附件的文档时，`moveDoc` 是**逐字照抄 blocks** 的
 * （`String(row.blocks || '[]')`）—— 副本和原件指向同一个附件 id，
 * 而 `attachments.docId` 只能记其中一个。
 *
 * 附件表那一行只说明「谁传的」，说明不了「谁还在用」。
 * 两处都栽在这上面：删除接口（7.13）和永久删除（purgeDocCore）——
 * 后者更糟，因为永久删除是最破坏性的操作。
 *
 * 连**回收站里的**文档也算引用 —— 回收站的文档能恢复，
 * 它的卡片还得能用。
 *
 * 判据用 SQL 的 LIKE 先粗筛、JSON.parse 再精确认：
 * LIKE 会误命中（key 可能出现在正文文字里），但绝不会漏，
 * 方向是安全的 —— 而漏判的后果是删掉别人还在用的文件。
 *
 * JSON 解析不了时**保守当作「还有人在用」**（返回该文档）：
 * 宁可多留一份没人认领的附件，也不要弄坏一篇活着的文档。
 * blocks 是服务端自己写进去的，解析失败本不该发生；
 * 真发生了，说明历史数据有问题，而这时候毁掉别人的东西比留垃圾糟得多。
 */
export function docsReferencing(attachmentId: string, excludeDocId = ''): string[] {
  const out: string[] = []
  const rows = excludeDocId
    ? db.prepare('SELECT id, blocks FROM docs WHERE id != ? AND blocks LIKE ?').all(excludeDocId, `%"${attachmentId}"%`) as Row[]
    : db.prepare('SELECT id, blocks FROM docs WHERE blocks LIKE ?').all(`%"${attachmentId}"%`) as Row[]
  for (const r of rows) {
    let blocks: any
    try { blocks = JSON.parse(String(r.blocks || '[]')) } catch { out.push(String(r.id)); continue }
    if (!Array.isArray(blocks)) { out.push(String(r.id)); continue }
    if (blocks.some((b) => b?.data?.key === attachmentId)) out.push(String(r.id))
  }
  return out
}

/**
 * 把一篇文稿**移动**或**复制**到另一个知识库。
 *
 * 语雀的「移动到… / 复制到…」。这个动作看着只是改一个 `bookId`，
 * 实际要照顾到的东西有一串：
 *
 *   ① **两个库都要重算检索索引。** 文档级索引里那行的 bookId 变了，
 *      但**书级索引**存的是「这个库下面所有文稿的标题」——
 *      只重算 doc 的话，旧库里会留着这篇的标题（搜旧库的标题能搜到它，
 *      点进去却是空的），新库里则压根搜不到。
 *      这一条是照着 \`purgeDoc\` 里同一个坑写的（那边注释写了来龙去脉）。
 *   ② **目录节点也要跟着换库。** nodes 表上的 bookId 才是目录树真正认的东西，
 *      只改 docs.bookId 的话，这篇会从旧库的树上消失、却不出现在新库的树上
 *      —— 变成一篇「没有入口的文档」。
 *   ③ **权限两边都要判。** 源库要 \`edit\`（不然等于把人文档搬走），
 *      目标库要 \`create\`（不然等于往别人的库里塞东西）。
 *      只判一边的话 either 是数据丢失、要么是越权写入。
 *   ④ **复制不能沿用原 id。** 同 id 会在目标库里撞上另一篇文档，
 *      而 id 是主键 —— 撞了就是「静默变成那一篇」，用户以为复制了，
 *      实际覆盖了别人的文档。
 *   ⑤ 复制出来的**作者**是操作的人，不是原作者 —— 否则新库里会出现
 *      一个「这个库里根本没这个人」的作者名。
 */
export function moveDoc(user: User, docId: string, targetBookId: string, mode: 'move' | 'copy'):
  { ok: boolean; reason?: string; status?: number; docId?: string; nodeId?: string } {
  /** 权限不够一律 403。返回 400 听着像「你参数填错了」，
      而用户重填一遍参数并不会有第二个库给他 —— 那条路是死的。 */
  const row = docRow(docId)
  if (!row) return { ok: false, reason: '文档不存在' }
  if (Number(row.trashed) === 1) return { ok: false, reason: '文档在回收站里，先恢复再移动' }

  const fromBookId = String(row.bookId || bookIdOfDoc(docId) || '')
  if (!fromBookId) return { ok: false, reason: '这篇文档不属于任何知识库，没有地方可移' }
  if (mode === 'move' && fromBookId === targetBookId) {
    return { ok: false, reason: '它已经在这个知识库里了' }
  }

  const target = db.prepare('SELECT id, spaceId FROM books WHERE id = ?').get(targetBookId) as Row | undefined
  if (!target) return { ok: false, reason: '目标知识库不存在' }

  // ③ 两边都判
  if (!capsInBook(user, fromBookId).edit) {
    return { ok: false, status: 403, reason: '你没有原知识库的编辑权限（等于把别人的文档搬走）' }
  }
  if (!capsInBook(user, targetBookId).create) {
    return { ok: false, status: 403, reason: '你在目标知识库里没有新建文档的权限' }
  }

  const node = db.prepare('SELECT id, parentId, ord FROM nodes WHERE docId = ? AND bookId = ?').get(docId, fromBookId) as Row | undefined
  const now = Date.now()

  // ④ 复制要换新 id
  const newId = mode === 'copy'
    ? 'doc_' + randomBytes(6).toString('hex')
    : docId
  const newNodeId = 'n_' + randomBytes(6).toString('hex')

  // 新库里的父节点必须在**目标库**里；不给就放根下
  const parentHint = (targetBookId && node?.parentId) || null
  let parentId: string | null = null
  if (parentHint) {
    const p = db.prepare('SELECT id FROM nodes WHERE id = ? AND bookId = ?').get(String(parentHint), targetBookId) as Row | undefined
    parentId = p ? String(p.id) : null
  }

  db.exec('BEGIN IMMEDIATE')
  try {
    if (mode === 'copy') {
      db.prepare(
        `INSERT INTO docs (id, type, title, body, blocks, authorId, createdAt, updatedAt, wordCount,
                           visibility, published, tags, sheetData, spaceId, bookId, slug, summary)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        newId, String(row.type || 'doc'), String(row.title || '') + '（副本）', String(row.body || ''),
        String(row.blocks || '[]'), user.id, now, now, Number(row.wordCount || 0),
        String(row.visibility || 'space'), Number(row.published || 0), String(row.tags || '[]'),
        row.sheetData == null ? null : String(row.sheetData), String(target.spaceId || ''), targetBookId,
        // 副本不给 slug —— 同一个路径在两个库里会互相绊住
        '', String(row.summary || ''),
      )
    } else {
      db.prepare('UPDATE docs SET bookId = ?, spaceId = ?, updatedAt = ? WHERE id = ?')
        .run(targetBookId, String(target.spaceId || ''), now, docId)
    }

    // ② 目录节点
    const ord = Number((db.prepare('SELECT MAX(ord) AS m FROM nodes WHERE bookId = ? AND parentId IS ?')
      .get(targetBookId, parentId) as Row).m) || 0
    if (mode === 'copy' || !node) {
      db.prepare('INSERT INTO nodes (id, bookId, parentId, title, type, icon, docId, ord, hidden) VALUES (?,?,?,?,?,?,?,?,0)')
        .run(newNodeId, targetBookId, parentId, String(row.title || '') + '（副本）', 'doc', '', newId, ord + 1)
    } else {
      db.prepare('UPDATE nodes SET bookId = ?, parentId = ? WHERE id = ?').run(targetBookId, parentId, String(node.id))
    }

    // 反向引用（doc_links）跟着走：移动后那些「谁引用了我」要指对地方
    // —— doc_links 记的是 docId，复制出来的副本引用关系需要重建，
    //    而移动的那篇引用不变（docId 没变）。
    if (mode === 'copy') relink(newId)

    // 变更记录：docs 与 nodes 都要，别的设备才能把树上那一项也挪过去
    const rev = Number(row.rev || 0) + 1
    logChange('docs', newId, 'upsert', mode === 'copy' ? 1 : rev, user.id)
    logChange('nodes', mode === 'copy' ? newNodeId : String(node?.id || ''), 'upsert', 1, user.id)
    if (mode === 'move' && node) logChange('nodes', String(node.id), 'upsert', 1, user.id)

    db.exec('COMMIT')
  } catch (e: any) {
    db.exec('ROLLBACK')
    return { ok: false, reason: '移动失败：' + String(e?.message || '').slice(0, 80) }
  }

  // ① 两个库的索引都要重算
  try {
    reindex('doc', newId)
    reindex('book', targetBookId)
    if (mode === 'move') reindex('book', fromBookId)
  } catch (e) {
    console.warn('[search] 移动后刷新索引失败', docId, e)
  }
  /*
   * ⚠️ 这里原来还有一句 `try { reindexParentBook(docId) } catch { /* 索引可以之后补 *\/ }`。
   * 它是**两重无效**的，所以删掉了 ——
   *
   *   ① 重复：移动完成后 `docs.bookId` 已经是**目标库**了，而
   *      `reindexParentBook` 是靠 `SELECT bookId FROM docs` 解析归属的，
   *      于是它重建的是**目标库**的索引 —— 上面 `reindex('book', targetBookId)`
   *      刚刚建过一遍。真正需要重建的**原库**是靠 `reindex('book', fromBookId)`
   *      那一行处理的，它在这里。
   *
   *   ② 那层 catch 永远不可能触发：`reindexParentBook` 自己内部就有
   *      try/catch（而且它那一层**会** console.warn）。
   *      外面的 catch 能抓到的只有「函数都没进去就抛了」这种不可能发生的事。
   *
   * 留着它的实际危害不是多跑一次索引，而是**误导**：
   * 后来的人看到「移动后处理原库索引的是这一行」，
   * 很可能把真正管用的 `reindex('book', fromBookId)` 当成重复而删掉 ——
   * 删了之后，移走的文档标题会永远留在原库的书级索引里
   * （删文档时那个坑就是这么来的，见 reindexParentBook 上面那段注释）。
   */

  return { ok: true, docId: newId, nodeId: mode === 'copy' ? newNodeId : (node ? String(node.id) : '') }
}

/**
 * 客户端推送一批变更。
 * 全部成功才整体提交吗？不 —— 一条被拒不该让其余的也白改，
 * 所以逐条独立判定，把被拒的条目连同原因回给前端。
 */
export function push(user: User, payload: { upsert?: Record<string, Row[]>; remove?: Record<string, string[]> }): PushResult {
  const applied: PushResult['applied'] = []
  const rejected: PushResult['rejected'] = []

  const run = () => {
    for (const [name, rows] of Object.entries(payload.upsert || {})) {
      const def = ENTITIES.find((d) => d.name === name)
      /*
       * ⚠️ `rows` 必须是数组。曾经这里直接 `for (const r of rows)`，
       * 于是**推进来一个对象**就是 `TypeError: rows is not iterable` → 抛到路由 →
       * 整个事务 ROLLBACK，**同一批次里的其他行一起没**。
       *
       * 实测能踩到的形状（探针，2026-10-05）：
       *   `{ bookMembers: [{ userId, bookId, role }] }`        ✅ 200
       *   `{ bookMembers: { b1: [{ id, role }] } }`            ❌ 500 + 整批回滚
       * 第二种是**客户端 store 里的真实形状**（`bookMembers: Record<bookId, BookMember[]>`），
       * 只是客户端的 sync 引擎会先摊平成数组（`recordOfArray`）才推。
       * 所以网页端碰不到，但下面这三样都会：
       *   · 手写脚本调 `/api/sync/push`（文档里就是这么教的）
       *   · 导入数据包（`importBundle` 自己摊平，但第三方包不保证）
       *   · 以后任何新客户端忘了摊平
       *
       * 正确的反应是**只拒这一项、继续处理别的**：
       * 「你推的形状不对」是调用方的错，不该让同批次其他人的改动一起回滚 ——
       * 而 500 也把「服务端坏了」和「你参数推错了」混成了一件事，
       * 客户端没法据此决定要不要重试。
       */
      if (!Array.isArray(rows)) {
        rejected.push({ entity: name, id: '', reason: `这一项必须是一个数组（收到 ${typeof rows === 'object' ? '对象' : typeof rows}），已跳过，未影响其他实体` })
        continue
      }
      if (!def) {
        for (const r of rows) rejected.push({ entity: name, id: String(r[def?.pk || 'id'] ?? ''), reason: '未知实体' })
        continue
      }
      for (const r of rows) {
        const res = upsertRow(user, def, r)
        if ('denied' in res) rejected.push({ entity: name, id: String(r[def.pk]), reason: res.denied })
        else applied.push({ entity: name, id: String(r[def.pk]), rev: res.rev })
      }
    }
    for (const [name, ids] of Object.entries(payload.remove || {})) {
      const def = ENTITIES.find((d) => d.name === name)
      if (!def) continue
      // 和上面 upsert 同一个洞：`ids` 推进来一个字符串/对象就是 `not iterable`，
      // 同样会把整批事务拖下水。字符串是特别容易犯的那个 ——
      // `{ remove: { docs: 'd1' } }` 看着只像少写了两个括号。
      if (!Array.isArray(ids)) {
        rejected.push({ entity: name, id: '', reason: `remove 里这一项必须是 id 数组（收到 ${typeof ids}），已跳过，未影响其他实体` })
        continue
      }
      for (const id of ids) {
        const res = deleteRow(user, def, id)
        if ('denied' in res) rejected.push({ entity: name, id, reason: res.denied })
        else applied.push({ entity: name, id, rev: 0 })
      }
    }
  }

  // 一批写入放一个事务：中途失败不会留下写一半的状态
  db.exec('BEGIN IMMEDIATE')
  try {
    run()
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }

  return { applied, rejected, seq: currentSeq() }
}

/**
 * 重建某条目的检索索引。
 * 文稿的正文存在 blocks（JSON）里，搜不了；这里抽成一段纯文本。
 * 只在对应实体真的写了的时候调用，不做全量重建。
 */
/**
 * 从一篇文稿的正文里认出「指向本站其它文稿」的链接，重算 doc_links。
 *
 * 之所以在**服务端**扫而不是让客户端报上来：
 * 这张表必须和正文永远一致。客户端报上来的话，正文里删掉链接、
 * 表里还留着，「谁引用了我」就会指着一篇根本不提我的文档说谎 ——
 * 而这种谎比功能缺失更难发现，因为它看起来是正常数据。
 *
 * 认的路由形态是站内真实的那个：#/book/<bookId>/doc/<docId>
 * 完整 URL（http://host/#/book/...）和相对写法（#/book/...）都能认出来，
 * 因为用户是从地址栏复制的，带不带域名都有。
 */
const DOC_ROUTE = /#\/book\/[^/]*\/doc\/([A-Za-z0-9_-]+)/g

/** 收集一篇文稿里所有可能藏链接的文本：body、每块的 html / text / data */
function docLinkSources(row: Row): string[] {
  const out: string[] = [String(row.body || '')]
  try {
    const blocks = parseJsonField(row.blocks)
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (!b || typeof b !== 'object') continue
        const any = b as any
        for (const k of ['html', 'text', 'title']) {
          if (typeof any[k] === 'string') out.push(any[k])
        }
        if (any.data && typeof any.data === 'object') {
          for (const k of ['url', 'link', 'href']) {
            if (typeof any.data[k] === 'string') out.push(any.data[k])
          }
        }
      }
    }
  } catch { /* blocks 坏了也不能让保存失败，链接表可以之后再补 */ }
  return out
}

/** 重算某篇文稿的出链。文稿不存在时只清不写。 */
export function relink(docId: string) {
  try {
    const row = db.prepare('SELECT id, body, blocks FROM docs WHERE id = ?').get(docId) as Row | undefined
    db.prepare('DELETE FROM doc_links WHERE sourceDocId = ?').run(docId)
    if (!row) return
    const targets = new Set<string>()
    for (const src of docLinkSources(row)) {
      DOC_ROUTE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = DOC_ROUTE.exec(src))) {
        if (m[1] && m[1] !== docId) targets.add(m[1])
      }
    }
    if (!targets.size) return
    const ins = db.prepare('INSERT OR IGNORE INTO doc_links (sourceDocId, targetDocId, at) VALUES (?, ?, ?)')
    const at = Date.now()
    for (const t of targets) {
      // 指向一篇不存在的文档也要记？不要 —— 否则重名/已删的 id 会在页面上变成死链
      const exists = db.prepare('SELECT 1 AS x FROM docs WHERE id = ? AND COALESCE(trashed,0) = 0').get(t)
      if (exists) ins.run(docId, t, at)
    }
  } catch (e) {
    /**
     * 这里刻意**不吞**。
     * 失败意味着「反向链接会少算」，而用户看到的是一个安静地少了几条的列表 ——
     * 没有任何提示他这个功能其实坏了。
     * 写进日志，保存本身不能因此失败（正文已经落库了，回滚会连带丢掉用户的编辑）。
     */
    console.warn('[doc_links] 重算失败', docId, e)
  }
}



export function reindex(kind: 'doc' | 'book' | 'note', id: string) {
  try {
    if (kind === 'doc') {
      const row = db.prepare('SELECT id, title, body, blocks, bookId, updatedAt FROM docs WHERE id = ?').get(id) as Row | undefined
      if (!row) { dropIndex('doc', id); return }
      let text = String(row.body || '')
      try {
        const blocks = parseJsonField(row.blocks)
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (!b || typeof b !== 'object') continue
            // 分割线的 text 是空壳；图片的 text 现在是**图片右边那段话**（真实正文）→ 要进索引
            if (b.type === 'divider') continue
            if (b.type === 'image') {
              if (typeof b.text === 'string' && b.text) text += (text ? '\n' : '') + b.text
              continue
            }
            if (typeof b.text === 'string' && b.text) text += (text ? '\n' : '') + b.text
            /**
             * 卡片类（附件名、公式、投票项）也常被搜。
             *
             * 这里原来跟着一句 `if (!b.text) continue` ——
             * 本意是跳过空壳，但**卡片的内容恰恰不在 text 里**：
             * 附件卡片的可搜内容是 data.name，而它的 text 通常是空的（说明文字）。
             * 于是整块被跳过，**上传的附件在搜索里根本搜不到** ——
             * 对一个要搜「预算表.xlsx」的知识库，这是个实打实的洞。
             *
             * 演示数据里一个带 data 的块都没有（都是正文块），
             * 所以这个洞平时看不出来，直到有人真插了一张附件卡片。
             * 现在 text 空只跳过 text 本身，data 照常抽。
             */
            if (b.data && typeof b.data === 'object') cardSearchText(b.data, (s) => { text += (text ? ' ' : '') + s })
          }
        }
      } catch { /* blocks 坏了也不能让写入失败，索引可以之后再补 */ }
      upsertIndex('doc', id, row.bookId ?? null, null, String(row.title || ''), text, Number(row.updatedAt) || 0)
      return
    }
    if (kind === 'book') {
      const row = db.prepare('SELECT id, name, desc, spaceId, updatedAt FROM books WHERE id = ?').get(id) as Row | undefined
      if (!row) { dropIndex('book', id); return }
      /**
       * 知识库的正文就是它下面所有文稿的标题，否则搜「团队手册」只会命中文档、搜不到库本身。
       * **必须排除回收站里的** —— 用户删掉的文档，标题不该还能通过知识库搜出来。
       * 漏了这个 `trashed = 0` 的话，删掉一篇文档之后搜它的标题照样能搜到那个库。
       *
       * ⚠️ 300 这个上限原来是 `LIMIT 300` **不带 ORDER BY**：
       * 留哪 300 条由 SQLite 的扫描顺序决定（实测就是行 id 顺序），
       * 而这个索引**每次写文稿都会整条重算** ——
       * 于是「这篇的标题能不能搜到这个库」变得没有规律。
       *
       * 更糟的是实测（探针，2026-10-06，341 篇的库）：
       * 留住的恰恰是**最老的** 300 篇。搜「最老的一篇」能命中知识库，
       * 搜「最新的一篇」只命中文档、命不中库。
       * 而一个公司知识库里真正会被搜的，是**最近更新**的那些 ——
       * 新人手册、新政策、刚改完的文档。上限把最不可能被搜的留了下来。
       *
       * 所以按更新时间倒序取：**上限还在，但取的是最该被搜的那批**，
       * 而且**可预期**（不再是「碰运气」，是明确的「最近的 300 篇」）。
       * 这个上限本身是索引正文大小的取舍，不是「支持 300 篇」的承诺 ——
       * 库更大时更老的标题在**书级**搜不到，但**文档本身照样能搜到**
       * （doc 索引是逐篇建的，不受这个上限影响）。
       */
      const titles = db.prepare(
        "SELECT title FROM docs WHERE bookId = ? AND COALESCE(trashed,0) = 0 ORDER BY COALESCE(updatedAt,0) DESC, id DESC LIMIT 300",
      ).all(id) as Row[]
      const text = titles.map((t) => String(t.title || '')).join('\n')
      upsertIndex('book', id, id, row.spaceId ?? null, String(row.name || ''),
        [String(row.desc || ''), text].filter(Boolean).join('\n'), Number(row.updatedAt) || 0)
      return
    }
    const row = db.prepare('SELECT id, text, spaceId, createdAt FROM notes WHERE id = ?').get(id) as Row | undefined
    if (!row) { dropIndex('note', id); return }
    upsertIndex('note', id, null, row.spaceId ?? null, '', String(row.text || ''), Number(row.createdAt) || 0)
  } catch (e) {
    // 索引失败绝不能连累主流程：内容已经存下去了，索引可以补
    console.warn('[search] 建立索引失败', kind, id, (e as Error)?.message)
  }
}

function upsertIndex(kind: string, id: string, bookId: any, spaceId: any, title: string, text: string, updatedAt: number) {
  db.prepare(`INSERT INTO search_index (kind, targetId, bookId, spaceId, title, text, updatedAt)
              VALUES (?,?,?,?,?,?,?)
              ON CONFLICT(kind, targetId) DO UPDATE SET
                bookId=excluded.bookId, spaceId=excluded.spaceId, title=excluded.title,
                text=excluded.text, updatedAt=excluded.updatedAt`)
    .run(kind, id, bookId, spaceId, title, text.slice(0, 200000), updatedAt)
}

function dropIndex(kind: string, id: string) {
  db.prepare('DELETE FROM search_index WHERE kind = ? AND targetId = ?').run(kind, id)
}

/** 供删除路径使用（upsertRow 里直接调 reindex 即可，删除要先摘索引） */
export function dropIndexOf(kind: 'doc' | 'book' | 'note', id: string) {
  dropIndex(kind, id)
}

/**
 * 搜索。覆盖文档 / 知识库 / 小记。
 * 权限过滤是硬要求：命中集必须落在「当前用户能看」的范围内，
 * 不能先搜出来再靠前端过滤 —— 那等于把无权内容的片段发出去。
 */
/**
 * 这个查询词里有没有命中被屏蔽的词。
 *
 * 从 `book_settings` 现读，不缓存 —— 管理员改完屏蔽词要立刻生效，
 * 缓存会让「已经撤下的词还在挡」或者「新加的词还在漏」。
 */
export function isBlockedSearchTerm(q: string): boolean {
  const kw = String(q || '').toLowerCase()
  if (!kw) return false
  let rows: Row[] = []
  try {
    rows = db.prepare('SELECT blockSearch, blockTerms FROM book_settings WHERE blockSearch = 1').all() as Row[]
  } catch {
    return false   // 旧库还没有这两列时不该把搜索整个搞挂
  }
  for (const r of rows) {
    let terms: string[] = []
    try {
      const v = parseJsonField(r.blockTerms)
      if (Array.isArray(v)) terms = v.map((x) => String(x).toLowerCase()).filter(Boolean)
    } catch { /* 词表坏了就当没配，而不是让搜索整个 500 */ }
    for (const t of terms) {
      if (t && kw.includes(t)) return true
    }
  }
  return false
}

export function searchAll(user: User, q: string, limit = 20, ip: string | null = null): any[] {
  const kw = String(q || '').trim()
  if (!kw) return []
  /**
   * 关键词屏蔽（语雀企业版的「搜索关键词屏蔽」）。
   *
   * 挡在**最前面**、服务端、连 SQL 都不发出去 ——
   * 如果先搜出来再让前端过滤，等于把命中的标题和片段先发出去再收回，
   * 那不叫屏蔽。所以这里直接返回空。
   *
   * 挡的是「查询词里含被屏蔽的词」，不是「结果里含」——
   * 后者会把整个知识库连正常内容一起抹掉，那不是屏蔽，是自残。
   *
   * 大小写不敏感；管理员自己搜也照样挡 ——
   * 这条本来就是防「谁搜到了」的，放开后门等于没开。
   */
  if (isBlockedSearchTerm(kw)) return []

  const books = new Set<string>()
  const spaces = new Set<string>()
  if (user.role !== 'owner') {
    for (const b of db.prepare('SELECT id FROM books').all() as Row[]) {
      if (capsInBook(user, String(b.id)).read) books.add(String(b.id))
    }
    for (const s of db.prepare('SELECT spaceId FROM space_members WHERE userId = ?').all(user.id) as Row[]) {
      spaces.add(String(s.spaceId))
    }
  }

  const like = `%${kw.replace(/[%_\\]/g, (m) => '\\' + m)}%`

  /**
   * 权限过滤必须发生在 **LIMIT 之前**。
   *
   * 原来是在 JS 里过滤的：SQL 先 `LIMIT 400`，再逐条判权限。
   * 于是一个高频词只要前 400 条命中恰好都是别人家的文档，
   * 有权限的那几条排在 401 条之后 —— 结果是**零条**，
   * 而用户明明能看到那些文档。
   *
   * 可读的知识库 / 空间在函数开头就已经算出来了，直接拼进 SQL 的
   * IN 条件里，让数据库先把没权限的剔掉，再截断。
   */
  const ph = (n: number) => Array(n).fill('?').join(',')
  const scopeSql: string[] = []
  const scopeVals: any[] = []
  /*
   * 三种索引行在 bookId / spaceId 上的填法各不相同（见 reindex）：
   *   doc  → bookId = 所属知识库
   *   book → bookId = **它自己**（不是 spaceId）
   *   note → bookId = null，spaceId = 所属空间
   * 所以第一支不能写成 `s.kind <> 'note' AND ...`，但也不必 ——
   * note 的 bookId 是 null，压根不会命中 IN 列表；第二支再单独兜住它。
   *
   * 「不属于任何知识库的文稿」在这里也匹配不上（bookId 为空），
   * 但那是不可达状态：docs.bookId 是 NOT NULL 且 ON DELETE CASCADE，
   * 删库会连带删掉文稿，不会留下孤儿。
   */
  if (user.role !== 'owner') {
    /*
     * IP 白名单在这里一起下推。
     *
     * 以前搜索完全不看 `ipAllowed` —— 实测开着白名单、当前 IP 不在名单里时，
     * `/api/search` 照样返回 200 + 若干条**含正文片段**的结果。
     * 于是「仅允许下列 IP 访问本知识库」在最容易被顺手用的那条路径上形同虚设：
     * 不必打开文档，搜一下就把标题和片段拿走了。
     *
     * 剔在 SQL 之前而不是结果之后：结果过滤会让 LIMIT 先取满再丢，
     * 而这里的过滤是「这个库压根不给我看」，本来就该在查询范围之外。
     *
     * `ip === null`（服务端内部调用）不做判定 —— 和 readEntity 同一套约定。
     */
    const bIds = ip === null ? [...books] : [...books].filter((b) => ipAllowed(b, ip))
    const sIds = [...spaces]
    if (!bIds.length && !sIds.length) return []   // 一处都读不到，别白跑一次全表扫描
    if (bIds.length) { scopeSql.push(`s.bookId IN (${ph(bIds.length)})`); scopeVals.push(...bIds) }
    if (sIds.length) { scopeSql.push(`(s.kind = 'note' AND s.spaceId IN (${ph(sIds.length)}))`); scopeVals.push(...sIds) }
  }

  const rows = db.prepare(`
    SELECT s.kind, s.targetId, s.bookId, s.spaceId, s.title, s.text
    FROM search_index s
    LEFT JOIN docs d ON s.kind = 'doc' AND d.id = s.targetId
    WHERE (s.title LIKE ? ESCAPE '\\' OR s.text LIKE ? ESCAPE '\\')
      -- 回收站里的文稿不进搜索结果：用户删掉了就是不想再看到
      AND (s.kind <> 'doc' OR (d.id IS NOT NULL AND d.trashed = 0))
      -- 「仅自己可见」的文稿不进搜索结果（**平台 owner 也不豁免**）。
      -- 必须下推到 LIMIT 之前：不这样，前 400 条恰好全是别人的私密文稿时，
      -- 用户自己那几条有权看的结果会被整个截掉（和上面 scope 那个坑同形）。
      AND (s.kind <> 'doc' OR d.visibility <> 'private' OR d.authorId = ?)
      ${scopeSql.length ? `AND (${scopeSql.join(' OR ')})` : ''}
    LIMIT 400`).all(like, like, user.id, ...scopeVals) as Row[]

  /*
   * JS 兜底（第二道），和 SQL 里的判据**必须是同一套**。
   *
   * 这里没有再查一遍库，而是**一次查询**把「这批结果里属于别人的私密文稿」捞出来 ——
   * 逐行调 `canSeeDocRow` 会对每条结果多一次查库，而这里只需要一次。
   * 之所以还要它：SQL 里那几支作用域/可见性条件是**可以写错的**，
   * 而漏掉一支的后果是**把别人的正文片段发出去**（项目记过的那句：
   * 「不能先搜出来再靠前端过滤 —— 那等于把无权内容的片段发出去」）。
   */
  const docIds = [...new Set(rows.filter((r) => r.kind === 'doc').map((r) => String(r.targetId || '')).filter(Boolean))]
  const hidden = new Set<string>()
  if (docIds.length) {
    const priv = db.prepare(
      `SELECT id FROM docs WHERE visibility = 'private' AND authorId <> ? AND id IN (${docIds.map(() => '?').join(',')})`,
    ).all(user.id, ...docIds) as Row[]
    for (const r of priv) hidden.add(String(r.id))
  }

  const out: any[] = []
  for (const r of rows) {
    if (r.kind === 'doc' && hidden.has(String(r.targetId || ''))) continue
    /*
     * 第二道防线，不是唯一一道。
     *
     * 真正的过滤已经下推到 SQL 的 WHERE 里（在 LIMIT 之前），否则
     * 「前 400 条恰好全是别人家的文档」会把用户有权看的结果整个截掉。
     *
     * 这里再判一次是**故意**的：SQL 里的作用域条件一旦写错（比如漏了 note
     * 那一支），这一行就是最后一道挡越权的闸门。多一次 Set 查找的成本，
     * 换来「作用域条件写错了也不会泄露内容」。
     *
     * 这句话验过：把 SQL 里的作用域条件整个摘掉、只留这一层，
     * 搜索结果里依然没有一条越权内容（临时去掉 → 跑 → 只回来自己那条 → 恢复）。
     * 没验过就写「兜得住」，那只是愿望。
     */
    if (user.role !== 'owner') {
      if (r.kind === 'note') {
        if (!spaces.has(String(r.spaceId))) continue
      } else if (r.bookId) {
        if (!books.has(String(r.bookId))) continue
      } else {
        continue
      }
    }
    const text = String(r.text || '')
    const title = String(r.title || '')
    const i = text.toLowerCase().indexOf(kw.toLowerCase())
    // 命中次数：搜索页要按「出现得多不多」排序，摘要面板不用。
    // 单独数而不是从摘要里数 —— 摘要是截断过的，数字会偏小。
    const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    const count = (title.match(re)?.length || 0) + (text.match(re)?.length || 0)
    out.push({
      kind: r.kind,
      id: r.targetId,
      bookId: r.bookId,
      title: r.title,
      /**
       * 作者写的摘录。有它就用它，**没有就退回正文片段** ——
       * 反过来做（永远用正文片段）的话，那个「摘录」输入框就白给了，
       * 用户写了半年发现从来不显示。
       */
      summary: r.kind === 'doc'
        ? String((db.prepare('SELECT summary FROM docs WHERE id = ?').get(String(r.targetId)) as Row | undefined)?.summary || '')
        : '',
      at: i,
      count,
      excerpt: i < 0
        ? text.slice(0, 76).replace(/\n/g, ' ')
        : text.slice(Math.max(0, i - 24), i + 52).replace(/\n/g, ' '),
    })
  }
  // 标题命中的排前面，其余按原顺序
  return out.sort((a, b) => (a.at < 0 ? 1 : 0) - (b.at < 0 ? 1 : 0)).slice(0, limit)
}

/* ============================================================
   导出 / 导入
   ============================================================ */

const BUNDLE_FORMAT = 'yuque-clone-bundle'
const BUNDLE_VERSION = 2

/**
 * 导出整个工作台（**服务端做**）。
 *
 * 早先导出是在客户端打包本地 store 的，而轻量启动之后本地只有元信息 ——
 * 实测 26 篇文档、**0 个正文块**，一个「备份」就这么交出去了，
 * 界面上还弹「工作台已导出」。拿它恢复等于把知识库清空。
 *
 * 所以导出必须从服务端拿：这里返回的是**带正文**的完整包，
 * 并且按调用者的权限过滤 —— 拿不到没权限的内容。
 */
export function exportBundle(user: User) {
  const take = <T,>(name: string) => (readEntity(user, byName(name) as any, null) as T[])
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: Date.now(),
    exportedBy: { id: user.id, name: user.name, account: user.account },
    spaces: take('spaces'),
    books: take('books'),
    /**
     * 刻意**不带** `members`（账号表）。
     *
     * 那一列里有 `passHash` / `passSalt`。
     * 导出是「内容备份」，把账号凭据顺手捎上、再在导入时静默地创建一批账号，
     * 那是**安全决策**，不该作为「导入数据」的副作用发生。
     *
     * 原来它是「在包里、但导入顺序表里没有」—— 两头不一致，
     * 看起来像遗漏、实际谁也没实现，属于最该消除的那种含糊。
     * 现在明确写下来：包不带账号，导入也不建账号。
     * 公司真要迁移账号，那是另一件需要单独设计和确认的事。
     */
    nodes: take('nodes'),
    docs: take('docs'),
    docVersions: take('docVersions'),
    comments: take('comments'),
    commentReplies: take('commentReplies'),
    selectionComments: take('selectionComments'),
    selectionCommentReplies: take('selectionCommentReplies'),
    notes: take('notes'),
    topics: take('topics'),
    /**
     * 讨论区的回复是**真实内容**，不是元信息。
     *
     * 原来这里没有 `topicReplies`，于是「导出整个工作台 → 导入新实例」
     * 会把**所有讨论回复悄悄丢掉** —— 父话题在、回复没了，
     * 而界面上不会提示任何东西。
     *
     * 之所以一直没被发现：种子数据里 `topic_replies` 恰好是 0 行，
     * 演示和测试都看不出来。跟附件搜不到那个是同一类问题 ——
     * **演示数据刚好没覆盖到的那条路径**。
     */
    topicReplies: take('topicReplies'),
    templates: take('templates'),
    favorites: take('favorites'),
    follows: take('follows'),
    /** 回收站条目：不带上，迁移过去的实例里回收站会是一片空白 */
    trash: take('trash'),
    bookSettings: take('bookSettings'),
    bookMembers: take('bookMembers'),
    /**
     * 刻意**不带** `attachments`（附件二进制）。
     *
     * 后果必须说清楚：**导出的包里，附件卡片在、附件文件不在。**
     * 卡片数据里的 `key` 指的是附件 id，而这个 id 在新实例里查无此物，
     * 导入之后那些卡片会显示「附件二进制已丢失」。
     *
     * 为什么不做进去：附件是 BLOB，一个知识库几百 MB 起，
     * base64 进 JSON 还要再涨三分之一；而且导出本来就**按调用者权限过滤**，
     * 要正确带上就得逐篇判读权限再决定带不带 —— 这是另一件需要单独设计的活，
     * 顺手塞进来只会得到一个「大部分能带走、少数悄悄丢了」的导出包，
     * 那比明确不含更糟。
     *
     * 真正含二进制的备份是**文件级备份整个数据目录**（DEPLOY 备份那一节）。
     * 「导出整个工作台」的定位是内容迁移，不是灾备。
     *
     * 三处界面（设置页、帮助页、DEPLOY）都照这里写明了这一点。
     * 界面上原来只说了账号和最近浏览两样，附件是第三样却没提 ——
     * 而「留档」「换机器」这句话会让人以为它含附件。
     */
    attachments: undefined,
    /**
     * 刻意**不带** `recents`（最近浏览）。
     *
     * 它是「这台设备、这个人最近看过什么」，属于设备本地的临时状态：
     * 搬到新实例之后，把所有人的最近浏览复制过去既没有意义，
     * 还会让「最近」列表出现一批谁都没点过的记录。
     *
     * 这一条是**取舍**不是遗漏，所以写在这儿免得下次被当成漏项补回去。
     */
  }
}

/**
 * 导入数据包。
 *
 * 逐条过权限：能不能写由服务端说了算，
 * 客户端只是把文件递上来而已（它没有资格决定什么该覆盖）。
 */
export function importBundle(
  user: User,
  raw: any,
  mode: 'replace' | 'merge',
): { ok: boolean; error?: string; counts?: Record<string, number>; rejected?: number } {
  if (!raw || raw.format !== BUNDLE_FORMAT) return { ok: false, error: '不是本应用导出的数据包' }
  if (Number(raw.version) > BUNDLE_VERSION) {
    return { ok: false, error: `数据包版本（${raw.version}）高于当前程序支持的（${BUNDLE_VERSION}），请升级后再导入` }
  }

  const upsert: Record<string, any[]> = {}
  const remove: Record<string, string[]> = {}
  let rejected = 0
  const counts: Record<string, number> = {}

  /**
   * 导入顺序：父对象必须在子对象**之前**，否则子记录会因为父不存在被拒。
   *
   * 原来这份清单里没有 `topicReplies`，所以就算导出包带上了讨论区回复，
   * 导入时也会被当成「不认识的名字」丢掉 —— **两头都漏，才是真丢**。
   */
  const ORDER = ['spaces', 'books', 'nodes', 'docs', 'docVersions', 'comments', 'commentReplies',
    'selectionComments', 'selectionCommentReplies', 'notes', 'topics', 'topicReplies', 'templates',
    'favorites', 'follows', 'trash', 'bookSettings', 'bookMembers']
  // recents（最近浏览）是设备本地的临时状态，刻意不迁移，见 exportBundle 里的说明

  for (const name of ORDER) {
    const rows = Array.isArray(raw[name]) ? raw[name] : []
    if (!rows.length) continue
    const def = byName(name)
    if (!def) { rejected += rows.length; continue }
    if (!def.writable.length) { rejected += rows.length; continue }
    ;(upsert[name] ||= []).push(...rows)
    counts[name] = rows.length
  }

  if (!Object.keys(upsert).length) return { ok: false, error: '数据包里没有可导入的内容' }

  if (mode === 'replace') {
    /*
     * 「整体替换」= 把**这个库里凡是包里没有的行**删掉，只留包里的。
     *
     * ⚠️ 这里原来有一句注释说「只清**当前用户自己写的东西**，不碰别人的内容」——
     * **那是错的**，而且是危险的错：它让人以为这个模式是安全的，
     * 而实际代码是 `SELECT id FROM <表>` —— **没有任何按用户的过滤**，
     * `gone` 算的就是全表里不在包里的所有行。
     *
     * 真正把范围收窄的是**下游**：`deleteRow` 逐条问 `denyReason`，
     * 普通成员删不动别人的东西（被拒的会计进 rejected，界面会显示
     * 「N 条因权限被跳过」）；
     * 但 **`denyReason` 对平台 owner 是早退放行的**，
     * 所以 owner 选「整体替换」= 全库的书 / 节点 / 评论**硬删**。
     * （`docs` 走软删进回收站，还能救；书和评论没有这一层。）
     *
     * 所以这个语义和界面那句话是一致的、也是刻意的：
     *   · 界面：「整体替换（当前所有内容会被清空）」+ 红色「不可撤销」；
     *   · 用法：它服务的是「从 A 导一份、把 B 变成 A」这种迁移，
     *     而不是「清一清自己的旧数据」。
     * 界面侧另有一道 `confirm()` 兜住误点（见 Settings.tsx 的 importMode）。
     */
    for (const [name, rows] of Object.entries(upsert)) {
      const def = byName(name)
      if (!def) continue
      /*
       * ⚠️⚠️ 这里原来写死的是 `SELECT id FROM <表>` ——
       * **而并不是每张表都有 id 列**：
       *   · `book_settings` 的主键是 `bookId`
       *   · `trash` 的主键是 `docId`
       *   · `book_members` 是复合主键（`bookId` + `userId`）
       * 于是只要导入包里出现了这三类中的任何一类，整条 SQL 就抛
       * `no such column: id`。而这个错误发生在 `push()` **之前**，
       * 事务还没开始 → **整包导入全部作废，什么都没导进去**。
       *
       * 后果是：「整体替换」这个模式**从来没有成功执行过一次** ——
       * `book_settings` 每个知识库都有一行（`seed.ts` 铺的），
       * 所以它在**任何**实例上必然报错。实测（`test-export`）：
       *   整体替换 → {"error":"no such column: id"}，接收端纹丝不动。
       *
       * 修法：按实体声明的主键取列，复合主键按 `deleteRow` 认的那个形状
       * （`a::b`）拼回去 —— 两边必须一致，否则删不掉却还不报错。
       */
      const composite = COMPOSITE_PK[name] || []
      const keyCols = composite.length ? [...composite] : [def.pk]
      const idOf = (r: Row) =>
        composite.length
          ? keyCols.map((c) => String(r?.[c] ?? '')).join('::')
          : String(r?.[def.pk] ?? '')
      const existing = db.prepare(`SELECT ${keyCols.join(', ')} FROM ${def.table}`).all() as Row[]
      const incoming = new Set(rows.map((r) => idOf(r)))
      const gone = existing.map((e) => idOf(e)).filter((id) => !incoming.has(id))
      if (gone.length) (remove[name] ||= []).push(...gone)
    }
  }

  const res = push(user, { upsert, remove })
  rejected += res.rejected.length
  return { ok: true, counts, rejected, mode }
}

function byName(name: string) {
  return ENTITIES.find((e) => e.name === name)
}

/* ============================================================
   增量拉取
   ============================================================ */

export interface Delta {
  seq: number
  upsert: Record<string, Row[]>
  remove: Record<string, string[]>
  /**
   * 这一次**没有发完**，还有更早的 seq 没送到。
   *
   * 有了它客户端可以立刻接着拉，不必等下一个轮询周期；
   * 但真正的正确性由 `seq` 保证（它报的是扫到的位置，不是全局最大值），
   * 所以即使客户端**完全无视这个字段**也不会丢数据 ——
   * 这一点是刻意的，不能为了省事把 seq 又改回 currentSeq()。
   */
  more: boolean
}

export function changesSince(user: User, since: number, ip: string | null): Delta {
  const logs = db.prepare('SELECT * FROM changes WHERE seq > ? ORDER BY seq ASC LIMIT 2000').all(since) as Row[]
  const upsert: Record<string, Row[]> = {}
  const remove: Record<string, string[]> = {}

  for (const log of logs) {
    const def = ENTITIES.find((d) => d.name === log.entity)
    if (!def) continue
    const id = String(log.entityId)

    if (log.op === 'delete') {
      ;(remove[def.name] ||= []).push(id)
      continue
    }

    const row = db.prepare(`SELECT * FROM ${def.table} WHERE ${def.pk} = ?`).get(id) as Row | undefined
    if (!row) {
      ;(remove[def.name] ||= []).push(id)
      continue
    }
    // 软删除的文稿：从增量里以「删除」的形式通知各端，
    // 这样别的端也会把它从列表里去掉（正文本身还留在库里）
    if (def.name === 'docs' && Number(row.trashed) === 1) {
      ;(remove[def.name] ||= []).push(id)
      continue
    }
    /*
     * 软删除的空间（2026-10-16，照语雀的「删除后 24 小时内可撤销」）。
     *
     * ⚠️ 这一条不是可有可无的装饰 —— `readEntity` 的 `filter` 会把删掉的空间
     * 挡在全量之外，而**增量流如果不同步通知，各端侧栏就会一直留着它**：
     * 一个点进去 404 的死空间，比「删了但还显示」更难解释。
     * 和上面 `docs.trashed` 走的是同一套机制。
     */
    if (def.name === 'spaces' && Number((row as any).deletedAt || 0) > 0) {
      ;(remove[def.name] ||= []).push(id)
      continue
    }
    // 挂在已删文稿下面的评论 / 版本，同样以删除通知
    if (def.bookViaDoc && !liveDoc(row[def.bookViaDoc])) {
      ;(remove[def.name] ||= []).push(id)
      continue
    }
    if (def.filter && !def.filter(row, user)) continue
    if (def.personal) {
      if (String(row[def.userCol || 'userId']) !== user.id) continue
    } else if (def.visible) {
      if (!def.visible(row, user)) continue
    } else {
      const bookId = resolveBook(def, row)
      if (!bookId) {
        if (!(def.name === 'spaces' && canSeeSpace(user, id))) continue
      } else if (isSpaceLevel(def.name) ? !capsInSpace(user, bookId).read : !canReadBook(bookId, user)) {
        /*
         * 空间级实体（讨论区 / 小记）在这里**也**要按空间判。
         *
         * 这是同一个 bug 的**第三处**，而且比前两处更根本：
         * `changesSince` 是增量同步的出口 —— 客户端平时就是靠它拿变更的。
         * 这里 continue 掉，`notes` / `topics` / `topicReplies` 的变更
         * **永远发不到客户端**。
         *
         * 也就是说：只修 `readEntity`（直连库读）和 `denyReason`（写入判权）
         * 是不够的 —— 客户端根本收不到这些数据，界面上还是空的。
         * 前两处修得再对，也只是让「服务端答对了」，
         * 而数据压根走不过去。
         *
         * 前一轮我只查了自己改过的那两处，第三处是这一轮
         * 用探针把 `resolveBook` 的**所有**调用点扫了一遍才发现的。
         */
        continue
      }
    }
    /*
     * IP 白名单 —— 7.29 那次漏了**整条通路**。
     *
     * 当时的修法是给 `readEntity` / `readEntityLite` / `bootstrap` / `searchAll`
     * 加必传的 `ip` 参数，让「新增调用点时编译就红」。那个机制挡住了新的调用点漏传，
     * 可它**挡不住一条不经过 readEntity 的独立通路**：
     * `changesSince` 自己 SELECT、自己判权限、自己 toClient 下发。
     *
     * 而它恰恰是**客户端平时拿数据的那条路**（函数上面的注释就写着这句）。
     * 实测：白名单开着、当前 IP 不在名单里时，列表 0 篇、搜索 0 条、单篇 403 ——
     * 全对，而 `/api/sync/changes` 把那篇文档**连 blocks 一起**发了过来。
     * 轻量启动之后客户端本地只有元信息、正文靠增量补，
     * 所以这条口一漏，白名单挡住的库照样能被完整读走。
     *
     * 判据放在 `toClient` **之前**：已经取出来了，索性别发。
     */
    const bookIdOfRow = resolveBook(def, row)
    /*
     * ⚠️ 这里**必须先判 `ip`**，不能写 `ipAllowed(bookIdOfRow, ip || '')`。
     *
     * 那个写法是我自己第一版的错：`ip === null` 在这套 API 里的约定是
     * 「服务端内部读取，**不做** IP 判定」（readEntity / bootstrap / searchAll
     * 都是这个意思，参数注释也这么写）。而 `ip || ''` 会把 null 变成空串，
     * `ipAllowed` 里面是 `list.includes('')` —— 恒为 false ——
     * 于是**每一行都被丢掉**，全量同步静默变成空的。
     *
     * 失败形态特别坏：不是报错，不是少几行，是「同步之后什么都没了」，
     * 而调用方（未来的某个内部读取点）完全看不出是自己漏传了。
     * 现在还没有调用方传 null，所以它只是潜伏 —— 但一个声明成
     * `string | null` 的参数带着相反的语义，就是一颗定时炸弹。
     */
    if (ip && bookIdOfRow && !ipAllowed(bookIdOfRow, ip)) continue


    // 目录节点标题以文档为准（见 deriveNodeTitle）—— 这条路不经过 readEntity。
    // ⚠️ 局部变量名保持叫 `client`：`test-sync-converge` 有一条源码级断言
    //   钉的就是 `client._rev = Number(row.rev` 这个形状（「_rev 只在增量里发」）。
    //   我第一版图省事把它改名成 `c`，那条断言立刻红了。
    //   与其放宽守卫，不如别动它依赖的名字 —— 守卫可以脆，我不该比它更脆。
    const client = toClient(def, def.name === 'nodes' ? deriveNodeTitle(row) : row)
    client._rev = Number(row.rev || 0)
    ;(upsert[def.name] ||= []).push(...enrichReplyDocIds(def, [client]))
  }

  // 空间行的成员数是现算的，增量里也得带上（见 withSpaceMemberCount）
  if (upsert.spaces) withSpaceMemberCount(upsert.spaces)

  /*
   * 游标必须报「这一批**真的扫到哪**」，不能报全局最大值。
   *
   * 原来这里写的是 `seq: currentSeq()` —— 而 `currentSeq()` 是
   * `changes` 表的 MAX(seq)。于是待拉取超过 `CHANGE_LIMIT`（2000）时：
   *
   *   服务端只发了前 2000 条，却告诉客户端「你已经同步到最新的了」；
   *   客户端那边是 `seq = Math.max(seq, delta.seq)`，**无条件采信**；
   *   下一轮从最大值往后问 → 中间那一段**永远不会被送到**。
   *
   * 实测（test-seqgap，灌 2100 条）：第一轮发 2000 条、回 `seq=2100`，
   * 第二轮从 2100 往后拉 —— **0 条**。剩下 100 条静默丢失，
   * 不报错、不告警、界面上看不出任何异常。
   *
   * 为什么这不是理论问题：这正是内网部署最典型的场景 ——
   * 一台笔记本周末关机，周一打开时同事已经写了上千条。
   *
   * ------------------------------------------------------------
   * 为什么用「扫到的最后一条」而不是「过滤掉的也要算进去」
   * ------------------------------------------------------------
   * 上面那个循环里，权限/白名单/软删除判据会 `continue` 掉一些日志行 ——
   * 那些行**没进结果**，但游标必须**跨过**它们，否则客户端下一轮又问同一段，
   * 而它们永远过不去 —— 每次拉都卡在同一处。
   *
   * 所以游标取 `logs` 里的最后一个 seq：**扫过的都算走过，没发的不发**。
   */
  const head = currentSeq()
  const scannedTo = logs.length ? Number(logs[logs.length - 1].seq) : Number(since)
  const more = scannedTo < head
  return { seq: more ? scannedTo : head, upsert, remove, more }
}
