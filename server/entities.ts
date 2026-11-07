/* ============================================================
   实体注册表
   前端有 20 来种实体，如果为每一种写一套 CRUD / 同步 / 鉴权，
   代码量会三倍且极易出现「某个表忘了鉴权」这种洞。
   这里把差异收敛成一份声明式描述，其余全部走通用逻辑。

   每个实体要说明：
   - table / json / writable：存储形状
   - scope：这一行归属于哪个知识库 —— 鉴权的唯一依据
   - personal：是否按当前登录用户隔离
   ============================================================ */

import type { Row } from './db.ts'
import { db } from './db.ts'
import { capsInBook, canSeeDocRow, type User } from './perms.ts'

/** 可见性谓词里要用到的两个判定（放在这里是因为 perms 依赖 db，不能反向依赖） */
const canReadBookId = (bookId: string, userId: string): boolean =>
  capsInBook({ id: userId, name: '', account: '', role: 'member', avatar: '' } as User, bookId).read

const inSpace = (spaceId: string, userId: string): boolean =>
  !!db.prepare('SELECT 1 AS x FROM space_members WHERE spaceId = ? AND userId = ?').get(spaceId, userId)

export interface EntityDef {
  /** API 里的实体名（与前端 AppData 的键一致） */
  name: string
  table: string
  /** 以 JSON TEXT 存储的列 */
  json: string[]
  /** 布尔列（存 0/1，读出时还原成 boolean） */
  bools: string[]
  /** 允许客户端写入的列；未列出的列一律忽略，防止越权改 rev/updatedBy */
  writable: string[]
  /** 主键列 */
  pk: string
  /**
   * 鉴权作用域：从一行数据推出它属于哪个知识库。
   * 返回 bookId；返回 null 表示「不归属任何知识库」，此时走 personal/全局规则。
   */
  bookOf: (row: Row) => string | null
  /**
   * 自定义可见性判定，返回 true 表示这一行对该用户可见。
   * 用于「归属不唯一」的行 —— 比如模板：官方模板不属于任何知识库，
   * 但人人都该看到；个人模板只属于它的主人。
   * 不填则走默认的 bookOf / bookViaDoc 逻辑。
   *
   * ⚠️ 它是**替代**判定：`readEntity` 里命中它就 `continue`，
   * 后面的 bookViaDoc / 库能力 / **IP 白名单**那一整套**都不再执行**。
   * 所以它只适合「本来就不该按知识库判」的行。
   *
   * 有一类**不属于任何知识库**之外、却仍然要按库判的行（`docs` / `nodes`）：
   * 那种要写 `filter`（叠加），**不是** `visible`（替代）。
   * 2026-10-06 实测踩过：给 `docs` 挂上 `visible` 之后，
   * `test-ipwhitelist` / `test-ipwlchanges` / `test-trustproxy` 一起变红
   * （「文稿列表 0 行」变成「26 篇全放行」）—— **IP 白名单被整个绕过了**。
   */
  visible?: (row: Row, user: { id: string }) => boolean
  /**
   * **附加**判定：与 bookOf / bookViaDoc / 库能力 / IP 白名单**叠加**，
   * 全都过了之后再判它。返回 false 就这一行不给这个人。
   *
   * 什么时候用它而不是 `visible`：这一行**本来就属于某个知识库**、
   * 那些判定一个都不能少（尤其 IP 白名单），只是要**再**按行加一条规则
   * —— 目前是 `docs` / `nodes` 的「仅自己可见」。
   */
  filter?: (row: Row, user: { id: string }) => boolean
  /**
   * 该行不直接带 bookId，但带一个指向文稿的列（如 comment.docId），
   * 知识库归属要经这个文稿反查。权限过滤按这个走。
   */
  bookViaDoc?: string
  /**
   * 该行的 bookId 可能为空，要经目录树反查（文稿新建时常见）。
   * 与 perms.bookIdOfDoc 的解析保持一致，否则「有权限但不显示」。
   */
  bookViaNode?: boolean
  /**
   * 再多一跳：该行带的是**评论 id**（不是文稿 id），
   * 要先 commentId → docId → bookId 才能定位作用域。
   * 评论的回复在库里是子表，必须走这条路才能判权限。
   */
  bookViaComment?: string
  /**
   * 读出时补上 docId。
   * 回复表里只存了 commentId，而客户端要把回复挂回
   * Record<docId, Comment[]> 里的那一条 —— 没有 docId 就定位不到父对象。
   * 与其在客户端反查（那要额外一轮请求），不如服务端读的时候顺手带上。
   */
  enrichDocId?: boolean
  /** 是否按登录用户隔离（收藏 / 最近访问） */
  personal?: boolean
  /** 读取权限：'read' 即可见 */
  readPerm?: string
  /** 写入权限 */
  writePerm?: string
  /** 该实体是否纳入同步 */
  sync?: boolean
  /** 归属用户列（personal 实体用它） */
  userCol?: string
  /**
   * **入站**字段改名：前端推的键叫 `from`，表里的列叫 `to`。
   *
   * ============================
   * 为什么需要它：`nodes.order` → `nodes.ord`
   * ------------------------------------------------------------
   * 前端的 `TreeNode` 叫 `order`，表里的列叫 `ord`，
   * 而 `toRow()` 是**按 `writable` 里的列名去 `input` 里取值**的 ——
   * 于是客户端推上来的 `order` 从来没被读过，
   * 那一列永远是 `DEFAULT 0`。
   *
   * 实测（探针，2026-10-12）：客户端新建 3 篇文档，
   * 本地 order 是 3 / 2 / 1，**刷新一次全变成 0**，
   * 目录顺序随之回到「数组的插入顺序」。
   * 拖拽调好的顺序同样存不住 —— 而且**不报任何错**：
   * 服务端回的是 `applied`，没有任何 `rejected`。
   *
   * 为什么一直没人发现：读的那一侧早就修好了
   * （`NODE_SHAPE` 把 `ord` 补成 `order`），
   * 而种子数据本来就是按正确 ord 插进去的，
   * 所以「顺序没存住」和「顺序存住了」在演示数据上**长得一模一样**。
   * 要等有人真的建过新文档、或者真的拖过一次才会露出来。
   *
   * 语义：**目标列自带值时不覆盖**。
   * `/api/v2` 建文稿（`server/index.ts`）推的就是 `ord`（服务端自己算的
   * `MAX(ord) + 1`），那是权威值，不能被客户端的 `order` 顶掉。
   */
  writeAliases?: Record<string, string>
  /**
   * 入站**对象** → 若干列。键是客户端那个对象的字段名，
   * 值是 `{ 对象的键: 列名 }`。
   *
   * 用它而不是 `writeAliases` 的场合：**一对多**。
   * 本项目只有一处 —— `docs.lock: { memberId, at }`
   * ↔ `lockMemberId` / `lockAt`（读侧由 `DOC_SHAPE` 合成）。
   *
   * 没有它的时候：界面上点「锁定文档」返回成功、锁条也显示，
   * 而服务端那一列是空的 —— **刷新后锁条消失**，别人照样能编辑。
   * 实测 2026-10-12；`test-lock.mjs` 没抓到，因为它全程走 API
   * 直推 `lockMemberId`，从没走客户端这一条路。
   */
  writeObjects?: Record<string, Record<string, string>>
  /**
   * 出站前把这一行整理成**前端认识的形状**。
   *
   * 存在的理由：服务端用 `lockMemberId` / `lockAt` 两列存锁，
   * 而前端的 Doc 类型是 `lock: { memberId, at } | null`。
   * 字段名对不上 → 差分时「本地有 lock、服务端没有」→ 判定为「变了」
   * → **每一篇文稿每次打开页面都被推上去**。
   * 有编辑权的人推得动，看不出异常；只读成员推不动，
   * 顶栏就常驻一条「N 处修改没有保存」—— 而他其实什么都没改。
   *
   * 顺便把 `trashed` / `_lite` 这类服务端内部标记摘掉，
   * 它们不该出现在业务数据里。
   */
  shape?: (row: Row) => Row
}

const S = (v: any): string | null => (v == null || v === '' ? null : String(v))

const DOC_SHAPE = (row: Row): Row => {
  const { lockMemberId, lockAt, trashed, _lite, pinnedAt, ...rest } = row
  const lock = lockMemberId ? { memberId: String(lockMemberId), at: Number(lockAt) || 0 } : null
  /**
   * pinnedAt 归一成 **null**，而不是把库里的 0 原样发出去。
   *
   * 理由与上面 lock 那一行同类，而且更隐蔽：客户端的 Doc 类型是
   * `pinnedAt?: number | null`，本地新建的文档**压根没有这个键**（undefined），
   * 而库里默认是 0 —— 0 与 undefined 不是同一个值，
   * 差分时就会判成「本地改了」，于是**每一篇文稿每次打开页面都被推一遍**。
   * 有编辑权的人推得动，看不出异常；只读成员推不动，
   * 顶栏就常驻一条「N 处修改没有保存」—— 而他一个字都没改。
   *
   * 归一之后两端都是 null，两边恒等。
   */
  return { ...rest, lock, pinnedAt: Number(pinnedAt) || null }
}

/**
 * 知识库成员：`userId` 同时补一个 `id`。
 *
 * 客户端的 `BookMember` 类型是 `{ id, role, perms, joinedAt }`，
 * 而表里的主键列叫 `userId` —— 服务端不给 `id`，
 * 于是所有 `b.id` 都是 `undefined`。后果不是「显示难看」，是：
 *
 *   · 「谁还没加进来」判断 `!bookMembers.some(b => b.id === m.id)`
 *     恒为真 → **已经在库里的人全部出现在候选名单里**
 *   · `addBookMembers` 里的去重 `new Set(list.map(m => m.id))`
 *     变成 `{undefined}` → 同一个人可以被**反复添加**，
 *     权限界面于是显示成两行同一个人
 *
 * 而那两处的注释都写着「已经在库里的要去掉」—— 保护写在那里，
 * 但在服务端形态下**从来没生效过**。这类错最难查：
 * 代码完全正常、注释还把意图说得很清楚，就是行为不对。
 *
 * 这里补 `id` 而不是让客户端改读 `userId`：形状统一放服务端一处，
 * 比让每个界面自己记住「这个实体例外」可靠。
 */
const BOOK_MEMBER_SHAPE = (row: Row): Row => {
  if (row.id === undefined && row.userId !== undefined) {
    return { ...row, id: String(row.userId) }
  }
  return row
}

/**
 * 目录节点：`ord` 同时补一个 `order`。
 *
 * 客户端的 `TreeNode` 叫 `order`，表里的列叫 `ord` —— 服务端不给 `order`，
 * 于是 `sort((a, b) => a.order - b.order)` 里两个 `undefined` 相减得 `NaN`，
 * **排序等于没做**。表现是：拖拽调好的目录顺序，刷新一下 / 换台设备就乱了。
 *
 * 之所以一直没人报：种子数据本来就是按 ord 顺序插进去的，
 * 所以「不排序」的结果和「排对了」长得一模一样 ——
 * 要等有人**真的拖过一次**才会暴露。
 */
/**
 * 成员：补一个可见性判定，并**把凭据列摘掉**。
 *
 * ① 为什么原来一行都读不出来。
 *     `readEntity` 的兜底规则是「推不出知识库归属的行不放行」
 *     （宁可少给，也不要因为「没归属」就全网可见）。
 *     `members` 的 bookOf 恒为 null —— 成员不属于任何知识库 ——
 *     于是**每一个成员行都被这条规则丢掉了**，`/api/entity/members` 对谁都是空。
 *
 *     平时看不出来，因为每个浏览器的 localStorage 里都躺着种子 members，
 *     而远端回来的 0 行不会覆盖它。所以「演示数据刚好没覆盖的路径」又一次：
 *     演示账号在两边都在，**通过注册进来的新同事只存在于服务端**，
 *     于是他在这台机器上看不见，换台设备也看不见 ——
 *     而 @提及、待办指派、协作者头像、远程光标的名字全都读 `store.members`。
 *
 * ② 为什么必须同时摘列，不能只加 visible。
 *     可见性一放开，`SELECT *` 就把 passHash / passSalt 一起发出去了。
 *     那两列是口令的哈希和盐 —— 泄漏它们的危害不比明文口令小多少
 *     （离线爆破一个弱口令绰绰有余）。
 *     所以这里显式删掉凭据列，连带 viaSso / passwordChangedAt
 *     （那两个不是机密，但属于服务端内部状态，前端没有用途）。
 *
 *     注意写入方向是安全的：`toRow` 只放行 writable 列，
 *     而 members 的 writable 不含任何密码列，客户端改不到。
 */
const MEMBER_SHAPE = (row: Row): Row => {
  const { passHash, passSalt, viaSso, passwordChangedAt, ...rest } = row
  void passHash; void passSalt; void viaSso; void passwordChangedAt
  return rest
}

const NODE_SHAPE = (row: Row): Row => {
  // **两个方向都要做**：加 order（客户端叫这个），同时**删掉 ord**（表里叫这个）。
  //
  // 只加不删是不行的：客户端本地新建的节点只有 order、没有 ord，
  // 而服务端回来的每一行都带 ord → 那一行**永远比不相等** →
  // 每次打开页面都把节点重推一遍。有编辑权的人推得动、看不出异常；
  // 只读成员推不动，顶栏就常驻一条「N 处修改没有保存」，而他一个字都没改。
  //
  // DOC_SHAPE 对 lockMemberId / lockAt / trashed / _lite 一直都是「删干净」的，
  // 这里原来只做加法，两边不一致。
  const { ord, ...rest } = row
  void ord
  if (rest.order === undefined && row.ord !== undefined) {
    return { ...rest, order: row.ord }
  }
  return rest
}

/* ============================================================
   注册表
   ============================================================ */

export const ENTITIES: EntityDef[] = [
  {
    name: 'spaces', table: 'spaces', pk: 'id',
    json: [], bools: [],
    /*
     * `deletedAt` **不在 writable 里** —— 它是服务端的撤销窗口标记，
     * 客户端推什么都不能改它（放进 writable 就等于让任何一端
     * 「复活」或「删除」别人的空间）。
     */
    writable: ['name', 'desc', 'avatar', 'kind', 'createdAt'],
    /**
     * 已进入撤销窗口的空间对所有读取路径隐身。
     *
     * 用 `filter`（叠加）而不是 `visible`（替代）—— 理由与 `docs` / `nodes`
     * 那两条完全一样：`visible` 会短路掉别的判定。
     * 这一条不判权限（空间本来就不按知识库判），但仍然是**叠加**语义，
     * 免得以后给空间加上 IP 白名单之类时被顺手替换掉。
     */
    filter: (r) => !Number((r as any).deletedAt || 0),
    bookOf: () => null,
    writePerm: 'admin',
  },
  {
    name: 'books', table: 'books', pk: 'id',
    json: [], bools: [],
    writable: ['spaceId', 'name', 'desc', 'avatar', 'visibility', 'createdAt', 'updatedAt'],
    bookOf: (r) => S(r.id),
  },
  {
    name: 'nodes', table: 'nodes', pk: 'id',
    json: [], bools: ['hidden'],
    writable: ['bookId', 'parentId', 'title', 'type', 'icon', 'docId', 'ord', 'hidden'],
    // 客户端推 `order`，表里的列叫 `ord`（原因见 EntityDef.writeAliases）
    writeAliases: { order: 'ord' },
    bookOf: (r) => S(r.bookId),
    /**
     * 目录树里**不能出现别人「仅自己可见」的文档**。
     *
     * ⚠️ 只过滤 `docs` 是不够的 —— 这条是最容易漏的一面：
     * `nodes` 自己带一份 **`title`（文档标题的副本）**，而且它也是同步实体。
     * 于是私有文档的**标题**照样会通过同步推进每个同事的 localStorage，
     * 前端目录树又直接渲染 `node.title`（`Tree.tsx:163`）。
     * 表现是「标题看得见、点进去 403」—— **等于把「仅自己」写在标题上泄露了**。
     *
     * 所以凡是**指向一个他读不到的文档**的节点，连标题一起不给他。
     * 分组节点（`type: 'group'`，没有 docId）不受影响。
     */
    /** `filter`（叠加判定），不是 `visible` —— 见 EntityDef 里那两条注释 */
    filter: (r, user) => {
      const docId = String(r.docId || '')
      if (!docId) return true
      return canSeeDocRow(user, docId)
    },
    shape: NODE_SHAPE,
  },
  {
    name: 'docs', table: 'docs', pk: 'id',
    // `likes` 和 notes.likes 同一个形状（userId 数组），见 db.ts 里那一列的说明
    json: ['blocks', 'tags', 'sheetData', 'likes'], bools: ['published'],
    writable: [
      'type', 'title', 'body', 'blocks', 'authorId', 'createdAt', 'updatedAt', 'wordCount',
      'visibility', 'published', 'tags', 'sheetData', 'lockMemberId', 'lockAt', 'spaceId', 'bookId',
      // 路径与摘录以前没有这两列，弹窗里的输入框写了也被**静默丢掉**。
      // 补进 writable 之后它们才真的落库 —— 见 db.ts 里同一件事的说明。
      'slug', 'summary',
      // 点赞：不进 writable 的话客户端点完只改本地，同步时被静默丢掉
      'likes',
      // 置顶：同一个坑（slug / summary / likes 都踩过）。
      // 不进 writable 的话点「置顶」只有界面上变了，刷新就回去，
      // 而且**不报错** —— 和「改了等于没改」一样难查。
      'pinnedAt',
    ],
    // 锁：客户端推 `lock: { memberId, at }`，库里是两列。
    // 少了这一条，界面上点「锁定文档」刷新后就白点了（见 writeObjects 的说明）。
    writeObjects: { lock: { memberId: 'lockMemberId', at: 'lockAt' } },
    bookOf: (r) => S(r.bookId),
    /**
     * 文稿的 bookId 允许为空（新建文档时前端不一定会填），
     * 这时要经目录节点反查 —— 和 perms.bookIdOfDoc 保持同一套解析。
     *
     * 两边不一致会出事：权限判定用节点反查（认得），
     * 而列表过滤只看 bookId 列（不认）→ 文档在「有权限」但「不显示」，
     * 别人打开列表根本看不到这篇，只有拿到直链才进得去。
     * 种子数据每篇都填了 bookId，所以这个洞一直没被暴露。
     */
    bookViaNode: true,
    shape: DOC_SHAPE,
    /**
     * 「仅自己可见」（`docs.visibility = 'private'`）：**只有作者本人**。
     *
     * 这一条是整个功能的地基 —— `readEntity` 和 `changesSince`
     * **两条路都尊重它**（前者 `sync.ts:267`、后者 `sync.ts:2166`），
     * 而这两条正是同步的读通道。
     *
     * 也就是说挂上之后，别人的正文**根本不会进他的本地库** ——
     * 这一步比「界面上不显示」强得多。剩下的读路径（`/api/search`、
     * 导出、`/api/v2`、目录树）各自要单独补，那几处是直接查 SQL 的。
     *
     * 判据与 `perms.canSeeDocRow` 是同一套 —— **同一个判断写两遍、
     * 改一处忘另一处就又变成不一致**，所以钩子里直接调它。
     *
     * ⚠️ 用的是 **`filter`（叠加）而不是 `visible`（替代）**：
     * 后者会短路掉 IP 白名单判定（实测踩过，三个 IP 套件一起红）。
     */
    filter: (r, user) => canSeeDocRow(user, String(r.id)),
  },
  {
    name: 'docVersions', table: 'doc_versions', pk: 'id',
    json: ['blocks'], bools: [],
    writable: ['docId', 'title', 'body', 'blocks', 'createdAt', 'editorName', 'at', 'label'],
    bookOf: () => null,
    bookViaDoc: 'docId',
  },
  {
    name: 'comments', table: 'comments', pk: 'id',
    json: [], bools: [],
    writable: ['docId', 'authorId', 'text', 'createdAt', 'anchorId'],
    bookOf: () => null,
    bookViaDoc: 'docId',   // 归属经 docId 反查，权限过滤靠它
    sync: true,
  },
  {
    name: 'selectionComments', table: 'selection_comments', pk: 'id',
    json: [], bools: ['resolved'],
    writable: ['docId', 'authorId', 'quote', 'blockId', 'text', 'createdAt', 'resolved'],
    bookOf: () => null,
    bookViaDoc: 'docId',
  },
  /* ---------- 评论回复 ----------
     前端把回复**嵌套**在父评论的 replies 数组里，而同步是按行做的。
     所以客户端同步层会把它们摊平成这两种实体推上来，读的时候再嵌套回去。
     不这么做的话，replies 不在评论的 writable 列里，会被静默丢掉 ——
     表现是「回复发出去了，刷新就没了」。 */
  {
    name: 'commentReplies', table: 'comment_replies', pk: 'id',
    json: [], bools: [],
    writable: ['commentId', 'authorId', 'text', 'createdAt'],
    bookOf: () => null,
    bookViaComment: 'commentId',
    enrichDocId: true,
  },
  /**
   * 话题（讨论区）的回复。
   *
   * 权限跟**父话题**走：话题本身属于某个空间（`topics.spaceId`），
   * 而回复行里只有 topicId，所以 `bookOf` 要先反查一次话题。
   *
   * 反查查不到时返回 null（= 不可见）而不是放行：
   * 父话题被删了、或者压根不该被这个用户看见，回复也就没有独立存在的理由。
   * 猜错的后果是「用户明明看不到这个话题，却能拿到它的回复列表」。
   */
  {
    name: 'topicReplies', table: 'topic_replies', pk: 'id',
    json: [], bools: [],
    writable: ['topicId', 'authorId', 'text', 'createdAt'],
    bookOf: (r) => {
      const t = db.prepare('SELECT spaceId FROM topics WHERE id = ?').get(String(r.topicId || '')) as Row | undefined
      return t ? S(t.spaceId) : null
    },
  },
  {
    name: 'selectionCommentReplies', table: 'selection_comment_replies', pk: 'id',
    json: [], bools: [],
    writable: ['selectionCommentId', 'authorId', 'text', 'createdAt'],
    bookOf: () => null,
    bookViaComment: 'selectionCommentId',
    enrichDocId: true,
  },
  {
    name: 'notes', table: 'notes', pk: 'id',
    json: ['likes', 'tags'], bools: [],
    writable: ['spaceId', 'text', 'authorId', 'createdAt', 'likes', 'tags', 'image'],
    bookOf: (r) => S(r.spaceId),
  },
  {
    name: 'topics', table: 'topics', pk: 'id',
    json: ['participants'], bools: ['hot'],
    writable: ['spaceId', 'title', 'authorId', 'createdAt', 'replyCount', 'participants', 'hot'],
    bookOf: (r) => S(r.spaceId),
  },
  {
    name: 'templates', table: 'templates', pk: 'id',
    json: [], bools: [],
    writable: ['name', 'desc', 'scope', 'bookId', 'spaceId', 'icon', 'body', 'category', 'createdAt', 'usedCount', 'ownerId'],
    bookOf: (r) => S(r.bookId),
    /**
     * 模板的可见性按来源分三种，官方模板不属于任何知识库但人人可见 ——
     * 之前按 bookId 过滤时它们被整批丢掉（种了 11 条只回来 3 条）。
     */
    visible: (r, user) => {
      if (r.scope === 'official') return true
      if (r.scope === 'mine') return String(r.ownerId || '') === user.id
      if (r.bookId) return canReadBookId(String(r.bookId), user.id)
      if (r.spaceId) return inSpace(String(r.spaceId), user.id)
      return false
    },
  },
  {
    name: 'favorites', table: 'favorites', pk: 'id',
    json: [], bools: [],
    writable: ['id', 'targetType', 'targetId', 'title', 'createdAt'],
    bookOf: () => null, personal: true, userCol: 'userId',
  },
  {
    /**
     * 知识库邀请（2026-10-11）。
     *
     * ⚠️ **不是 `personal: true`** —— 那样只有被邀请人能看见，
     *    邀请人就看不到自己发出去的东西了（他没法撤回、也没法看谁还没处理）。
     *    这里用 `visible` 显式写：**被邀请人 + 邀请人**都能看到。
     */
    name: 'bookInvites', table: 'book_invites', pk: 'id',
    json: [], bools: [],
    writable: ['id', 'bookId', 'toUserId', 'fromUserId', 'role', 'message', 'status', 'createdAt', 'respondedAt'],
    bookOf: (r) => S(r.bookId),
    visible: (r, user) => String(r.toUserId) === String(user?.id) || String(r.fromUserId) === String(user?.id),
  },
  {
    /** 关注空间 / 关注人。个人实体，跟 favorites 同构 */
    name: 'follows', table: 'follows', pk: 'id',
    json: [], bools: [],
    writable: ['id', 'targetType', 'targetId', 'createdAt'],
    bookOf: () => null, personal: true, userCol: 'userId',
  },
  {
    name: 'recents', table: 'recents', pk: 'docId',
    json: [], bools: [],
    writable: ['docId', 'viewedAt'],
    bookOf: () => null, personal: true, userCol: 'userId',
  },
  {
    name: 'trash', table: 'trash', pk: 'docId',
    json: [], bools: [],
    writable: ['docId', 'bookId', 'title', 'deletedAt'],
    bookOf: (r) => S(r.bookId),
    /**
     * 回收站里带一份**删除那一刻的标题快照**，
     * 所以它和 `docs` / `nodes` 一样要过「仅自己可见」这一关。
     *
     * ⚠️ 这里原来漏判，症状**只发生在别人删掉的私有文稿上**：
     *   正文那一层是拦住的（`docs` 行被筛掉，他读不到内容），
     *   但 `trash` 行照样同步进了他本地库，回收站列表里**冒出一个
     *   他从来没读过的标题**（实测：私有文稿「薪酬调整方案…」出现在
     *   普通成员的回收站里，见 `test-trash-perms.mjs`）。
     *
     * 为什么「作者自己删自己的私有文稿」不会漏：
     * `canSeeDocRow` 认 `authorId`，而回收站多半只有作者会去点 ——
     * 但**别的成员只要能读这个库，就会收到这一行**。
     *
     * 判据直接调 `perms.canSeeDocRow`，和 `docs` / `nodes` 同一份，
     * 不另写一套（同一个判断写两遍、改一处忘另一处就又不一致了）。
     */
    filter: (r, user) => canSeeDocRow(user, String(r.docId || '')),
  },
  {
    name: 'members', table: 'users', pk: 'id',
    json: [], bools: [],
    // 密码列不在 writable 里 —— 客户端永远改不到
    writable: ['name', 'account', 'email', 'avatar', 'bio'],
    bookOf: () => null,
    // 成员不属于任何知识库，但人人都该看得见这份名单（@提及、待办指派、
    // 协作者头像、远程光标的名字全读它）。见 MEMBER_SHAPE 上面那段。
    visible: () => true,
    shape: MEMBER_SHAPE,
  },
  {
    name: 'bookSettings', table: 'book_settings', pk: 'bookId',
    json: ['ipList', 'blockTerms'],
    bools: ['restrictExport', 'watermark', 'ipWhitelist', 'blockSearch', 'autoRevoke', 'publicAccess'],
    writable: [
      'restrictExport', 'watermark', 'watermarkText', 'ipWhitelist', 'ipList',
      'blockSearch', 'blockTerms',
      'autoRevoke', 'publicAccess', 'defaultWidth', 'defaultVisibility',
      // 2026-10-10 加：语雀「更多设置 → 高级选项」的「文档新建位置」。
      // 不登记的话它**存不进服务端** —— 管理员在界面上选了「底部新增」，
      // 刷新一回到「顶部新增」，而 store 里读的还是本地那份，
      // 于是换个设备/重登就丢。test-fieldsync 就是查这条。
      'newDocPosition',
    ],
    bookOf: (r) => S(r.bookId),
  },
  {
    name: 'bookMembers', table: 'book_members', pk: 'userId',
    json: ['perms'], bools: [],
    writable: ['bookId', 'userId', 'role', 'perms', 'joinedAt'],
    bookOf: (r) => S(r.bookId),
    shape: BOOK_MEMBER_SHAPE,
  },
]

/** 复合主键的实体要单独处理（book_members 实际是 bookId+userId） */
export const COMPOSITE_PK: Record<string, string[]> = {
  bookMembers: ['bookId', 'userId'],
}

export const byName = new Map(ENTITIES.map((e) => [e.name, e]))

/* ============================================================
   行 <-> 前端对象 的转换
   ============================================================ */

/** SQLite 行 → 前端对象（JSON 解析、0/1 还原成 boolean、隐藏内部列） */
export function toClient(def: EntityDef, row: Row): Row {
  const out: Row = { ...row }
  for (const c of def.json) out[c] = parseJsonField(row[c])
  for (const c of def.bools) out[c] = row[c] === 1 || row[c] === true
  // rev / updatedBy 是同步协议内部用的，不外泄给业务代码
  delete out.rev
  delete out.updatedBy
  // 最后按前端认识的形状整理（字段改名、摘掉服务端内部标记）
  return def.shape ? def.shape(out) : out
}

/** JSON 列解析：数组给 []、对象给 {}，避免各处写 ?? 兜底 */
export function parseJsonField(raw: any) {
  if (raw == null) return null
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return null }
}

/** 前端对象 → SQLite 列值（可写列过滤、JSON 序列化、布尔转 0/1） */
export function toRow(def: EntityDef, input: Row, extra: Row = {}): Row {
  const out: Row = { ...extra }
  /*
   * 入站字段改名（`writeAliases`）。
   *
   * 只在「目标列没自带值」时才搬 —— 服务端自己算出来的列
   * （`/api/v2` 的 `ord` = MAX+1）是权威，不能被客户端顶掉。
   * 不新建对象、直接写 `input` 是**故意的**：这里的调用方
   * (`upsertRow`) 传进来的是刚 `JSON.parse` 出来的请求体，
   * 除了这里没有别处读它；而少一个 `{...input}` 拷贝。
   */
  for (const [from, to] of Object.entries(def.writeAliases || {})) {
    if (from in input && !(to in input)) input[to] = input[from]
  }
  /*
   * 入站**对象**摊平成列（`writeObjects`）—— `writeAliases` 的镜像。
   *
   * 为什么单独一条：`lock` 不是一个键对应一列，
   * 客户端推上来的是 `lock: { memberId, at }`，
   * 而库里是两列 `lockMemberId` / `lockAt`。
   * 一对一的 `writeAliases` 表达不了这件事。
   *
   * 读侧早就有对称的处理（`DOC_SHAPE` 把两列合成 `lock`），
   * 而**写侧原来完全没有** —— 实测（探针，2026-10-12，真服务端）：
   * 界面上点「锁定文档」→ `lockDoc` 返回 true、锁条也显示出来了 →
   * 服务端 `lockMemberId` 是 **undefined** → **刷新后锁条消失**。
   * 「锁定文档」是协作控制（别人不该能编辑你锁住的那篇），
   * 点了等于没点，而**不报任何错**。
   *
   * ⚠️ 为什么一直没被发现：`test-lock.mjs`（18KB）把锁定机制的每个分支都验了，
   * 但它**全程用 API 直接推 `lockMemberId` / `lockAt`**，
   * 从没走过界面上 `lockDoc` → 同步这条路。
   * 协议层测得很透，客户端那一层根本没被碰过 ——
   * 和 `nodes.order` 是同一个形状：**读侧修好了，写侧没人写**。
   *
   * 语义与 `writeAliases` 一致：**目标列自带值时不覆盖**
   * （`/api/v2` 那类服务端自己算出来的列是权威）。
   */
  for (const [field, map] of Object.entries(def.writeObjects || {})) {
    // 客户端**没带**这个字段 = 「我不知道」，保持原样；
    // 带了 null = 「我认为它现在是空的」，那就要真的清掉 ——
    // 否则界面上点「解锁」永远不生效（第一版就漏了这条，套件当场红了）。
    if (!(field in input)) continue
    const v = (input as any)[field]
    for (const [from, to] of Object.entries(map)) {
      if (to in input) continue                       // 目标列自带值时不覆盖
      if (v === null || v === undefined) { input[to] = null; continue }
      if (typeof v === 'object' && v[from] !== undefined) input[to] = v[from]
    }
  }
  // 主键必须无条件带上。
  // writable 描述的是「业务上允许改哪些列」，主键不在其中很正常；
  // 但一旦漏掉，INSERT 就会不带主键 —— SQLite 的 TEXT PRIMARY KEY
  // 并不会自动 NOT NULL，于是真的插进去一条 id=NULL 的行，
  // 而 changes 日志记的却是客户端传的那个 id，两边对不上，
  // 增量同步就会把「刚建好的东西」当成已删除推给别的端。
  // 所以这里统一兜住，不依赖各实体的 writable 列表有没有手滑。
  for (const c of [def.pk, ...(COMPOSITE_PK[def.name] || [])]) {
    if (input[c] !== undefined) out[c] = input[c]
  }
  for (const c of def.writable) {
    if (!(c in input)) continue
    let v = input[c]
    if (def.json.includes(c)) v = v === undefined || v === null ? null : JSON.stringify(v)
    else if (def.bools.includes(c)) v = v ? 1 : 0
    else if (typeof v === 'object' && v !== null) v = JSON.stringify(v)
    out[c] = v === undefined ? null : v
  }
  return out
}

/**
 * 启动自检：实体声明的列，是不是都真的在表里。
 *
 * ============================
 * 为什么要有这道检查
 * ------------------------------------------------------------
 * 建表语句全是 `CREATE TABLE IF NOT EXISTS` —— 这句话对**已存在**的表什么也不做。
 * 所以「给表加一列」有两种做法，只有一种是对的：
 *   ✗ 只改 CREATE TABLE      → 全新库没事，**老库升级后那列不存在**
 *   ✓ CREATE TABLE + 补 ALTER → 新老库都对
 *
 * 第二种要人记得，而人总会忘。实测就忘过一次：给 book_settings 加了
 * `blockSearch` / `blockTerms`（搜索关键词屏蔽），没补迁移 ——
 * 老库升级后「一改知识库设置」就 500，报错是 `no such column: blockSearch`，
 * **报错里一个字都没提升级**，谁也不会往版本问题上想。
 *
 * ============================
 * 这里只**喊**，不抛
 * ------------------------------------------------------------
 * 抛了的话老实例直接起不来，风险比 500 更大。
 * 但一定要喊得足够显眼 —— 启动日志里多一行「你的库缺这几列」，
 * 比三个月后从 500 日志里倒推要省事得多。
 */
export function auditEntityColumns(): { entity: string; table: string; column: string }[] {
  const missing: { entity: string; table: string; column: string }[] = []
  const cache = new Map<string, Set<string>>()
  for (const def of ENTITIES) {
    let cols = cache.get(def.table)
    if (!cols) {
      try {
        cols = new Set((db.prepare(`PRAGMA table_info(${def.table})`).all() as Row[]).map((c) => String(c.name)))
      } catch {
        cols = new Set()      // 表压根不存在：算全缺，启动日志会点出来
      }
      cache.set(def.table, cols)
    }
    const declared = new Set<string>([def.pk, ...def.json, ...def.bools, ...def.writable])
    for (const c of declared) {
      if (c && !cols.has(c)) missing.push({ entity: def.name, table: def.table, column: c })
    }
  }
  return missing
}
