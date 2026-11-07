/* ============================================================
   语雀数据模型
   层级：空间(Space) > 知识库(Book) > 目录(Node, 可嵌套) > 文档(Doc)
   四大文稿类型：doc 文档 / sheet 表格 / board 画板 / table 数据表
   ============================================================ */

/** 文稿类型 */
export type DocType = 'doc' | 'sheet' | 'board' | 'table'

/** 目录节点类型：分组(目录) 或 叶子(具体文稿) */
export type NodeType = 'group' | DocType

/** 空间（团队 / 个人） */
export interface Space {
  id: string
  name: string
  desc: string
  avatar: string
  /** 团队空间 or 个人空间 */
  kind: 'team' | 'personal'
  memberCount: number
  createdAt: number
}

/** 成员 */
export interface Member {
  id: string
  name: string
  avatar: string
  account: string
  role: 'owner' | 'admin' | 'member'
}

/** 知识库 */
export interface Book {
  id: string
  spaceId: string
  name: string
  desc: string
  avatar: string
  visibility: 'public' | 'private' | 'space'
  /**
   * ⚠️ 这里**刻意没有** `docCount` / `wordCount`（2026-10-12 删掉）。
   *
   * 它们以前在类型上，但服务端 `books` 表里**压根没有这两列** ——
   * 于是 `toRow()` 每次都把它们丢掉，而客户端每次都在推。
   * 更糟的是它们**看起来能用**：值永远是种子里那几个数字，
   * 一次真实编辑都不会让它们动一下 ——
   * 界面上一句 `{book.wordCount}` 读到的是**永久停在建库那一刻的假数**，
   * 而且不报任何错。
   *
   * 现在统计一律现算：`useBookStats()`（`src/lib/useBookStats.ts`）。
   * 把这两个字段从类型里删掉，就是让「读它会拿到假数」这件事**在编译期就不可能**。
   *
   * `test-sync-fields.mjs` 盯住这一条：客户端推的字段服务端接不住，它就红。
   */
  createdAt: number
  updatedAt: number
}

/** 目录编排单元 —— 语雀的特色，一棵树 */
export interface TreeNode {
  id: string
  bookId: string
  parentId: string | null
  title: string
  type: NodeType
  /** 图标 emoji / 图标名 */
  icon?: string
  /** type !== 'group' 时指向实际文稿 */
  docId?: string
  children?: string[]
  /** 排序权重 */
  order: number
  /** 是否在目录中隐藏（语雀支持隐藏草稿等） */
  hidden?: boolean
}

/** 文档正文块 —— 编辑器最小单位 */
export interface Block {
  id: string
  type:
    | 'p'
    | 'h1'
    | 'h2'
    | 'h3'
    | 'h4'
    | 'ul'
    | 'ol'
    | 'todo'
    | 'code'
    | 'quote'
    | 'divider'
    | 'image'
    | 'table'
    | 'callout'
    | 'card'
  /** 纯文本 / markdown 源码 */
  text: string
  /** todo 勾选态 */
  checked?: boolean
  /** 任务归属成员 id */
  assignee?: string
  /** 代码语言 */
  lang?: string
  /** callout 表情 */
  emoji?: string
  /** 图片/表格等资源 */
  src?: string
  /**
   * 块级卡片的结构化数据（附件/公式/投票等）。
   * 约定：type === 'card' 时 data.cardId 指向 src/data/cards.ts 的卡片 id，
   * 渲染时据此从 src/components/cards 的 CARD_REGISTRY 找组件；
   * 卡片的所有可交互状态都必须放在这里，组件内部不许留「唯一真相」。
   * 必须 JSON 可序列化 —— 这份数据要进 localStorage。
   */
  data?: Record<string, any>
  /**
   * 富文本 HTML 快照。
   * text 是纯文本（用于搜索/大纲/导出 Markdown），
   * html 是带格式的（用于渲染与持久化）——
   * 两者分开存，就不必担心 HTML 污染 Markdown 源文。
   */
  html?: string
  meta?: Record<string, any>
}

/** 文稿 */
export interface Doc {
  id: string
  type: DocType
  title: string
  /** lake 源文（markdown），阅读态用它 */
  body: string
  blocks: Block[]
  authorId: string
  createdAt: number
  updatedAt: number
  wordCount: number
  /** 可见性 */
  visibility: 'public' | 'private' | 'space'
  /** 是否公开在互联网 */
  published: boolean
  /** 标签 */
  tags: string[]
  /**
   * 点赞的人（userId 数组），和 `Note.likes` 同一个形状。
   *
   * ⚠️ 这一列以前**根本不存在**：文档页那个 👍 完全是组件内 state，
   * 而点赞数是 `3 + docId 末位 × 2` **算出来的** ——
   * 看着像有人赞过，其实谁都没赞。刷新就没、换设备看不见。
   * 语雀工作台的「我点赞的」视图要靠这份数据，所以先把它变成真的。
   */
  likes: string[]
  /**
   * 这篇文档属于哪个知识库。
   *
   * ⚠️ 这一列**运行时一直有**（`createDoc(bookId, …)` 建出来就带着、
   * 同步也按它推），但接口上从来没声明过 —— 于是凡是读 `doc.bookId`
   * 的地方都在报「Property 'bookId' does not exist on type 'Doc'」，
   * 而那 4 处全是**权限守卫**（`bookEditBlocked(d.bookId)`）。
   *
   * 声明成**可选**：服务端下发的旧数据、以及种子数据里那几篇
   * 不挂在任何库下的文档，都没有这一列。
   */
  bookId?: string
  /**
   * 这篇文档所在的空间。同样是**运行时一直有、接口上没声明**的一列
   * （`createDoc` 时按 book 反查填的 —— 见 store 里那句
   * 「冗余存一份 bookId / spaceId」）。服务端判权限要走
   * doc→book→space，少这一列就得每次去查目录节点。
   */
  spaceId?: string
  /**
   * 「路径」：文档在知识库里的短地址（语雀的 slug）。
   * 服务端能按它解析，所以分享出去的链接用它；没设就退回 docId。
   * 同一个知识库里唯一 —— 重名会被服务端拒，并说清是哪一篇占了。
   */
  slug?: string
  /** 摘录：分享卡片与搜索结果里那一行说明 */
  summary?: string
  /** 历史版本 */
  versions?: DocVersion[]
  /**
   * 表格类文稿（sheet 工作表 / table 数据表 / board 画板）的结构化数据。
   * 唯一真相：这三个文稿的所有可编辑内容都挂在这里，改完由 updateDoc 落盘，
   * 组件内部只留「光标位置 / 选中项」这类瞬时 UI 态。
   * 必须是纯 JSON（要进 localStorage）；老存档没有这个字段时按种子兜底，
   * 首次进入时由各组件写回一次。
   */
  sheetData?: DocSheetData
  /**
   * 文档锁定：语雀的「锁定文档」——
   * 锁定后除持有者以外的人只能读；持有者自己照常编辑（不会把自己锁在外面）。
   * null / undefined = 未锁定。
   */
  lock?: DocLock | null
  /**
   * 置顶时刻（毫秒时间戳）。null / undefined / 0 = 未置顶。
   *
   * 语雀的对应物是 doc.pinned_at（2026-10-12 匿名 SSR 实测，
   * 并且带一个具名开关 enable_book_doc_pin）。
   *
   * ⚠️ **两端必须都是 null**：服务端库里是 0，而服务端下发时由
   * `entities.ts` 的 DOC_SHAPE 归一成 null。客户端新建的文档没有这个键
   * （undefined）。0 与 undefined 不是同一个值 —— 不归一的话
   * 「打开一次文档」就会被判成本地有改动。
   * 判定一律写 `Number(pinnedAt) > 0`，别写 `if (pinnedAt)`。
   */
  pinnedAt?: number | null
}

/** 文档锁的持有信息 */
export interface DocLock {
  /** 锁持有者 memberId */
  memberId: string
  /** 加锁时间 */
  at: number
}

export interface DocVersion {
  id: string
  title: string
  body: string
  createdAt: number
  editorName: string
  /** 快照的块列表 —— 历史版本 diff 与「恢复到该版本」的真正依据 */
  blocks: Block[]
  /** 快照时间（与 createdAt 同值，UI 用这个字段） */
  at: number
  /** 这次快照是怎么产生的：自动保存 / 手动保存 / 打开文档 / 恢复前 … */
  label: string
}

/** 评论 */
export interface Comment {
  id: string
  docId: string
  authorId: string
  text: string
  createdAt: number
  /** 锚定的块 id */
  anchorId?: string
  replies: Comment[]
}

/** 小记 —— 语雀的时间线碎片记录 */
export interface Note {
  id: string
  spaceId: string
  text: string
  authorId: string
  createdAt: number
  likes: string[]
  tags: string[]
  image?: string
}

/** 话题 / 讨论 */
export interface Topic {
  id: string
  spaceId: string
  title: string
  authorId: string
  createdAt: number
  /**
   * 种子里的历史回复条数。
   *
   * **界面上不要直接显示它。** 它描述的是「这个话题曾经有多少条回复」，
   * 而真正的回复行在 `topicReplies` 里 —— 两者对不上时（演示数据必然对不上），
   * 显示这个字段就是编数字。用 `getTopicReplyCount(id)` 拿真数。
   */
  replyCount: number
  participants: string[]
  hot: boolean
}

/** 讨论区里的一条回复 */
export interface TopicReply {
  id: string
  topicId: string
  authorId: string
  text: string
  createdAt: number
}

/**
 * 知识库邀请（2026-10-11）
 *
 * ⚠️ 与下面的 `Collaboration` 是**两回事**：
 *   · 本条是「把人拉进知识库」，有服务端表、有路由、会真的进 `book_members`
 *   · Collaboration 是**文档级**协作，纯客户端种子数据，没有服务端支撑
 *
 * 状态机：pending → accepted / declined / revoked
 */
export interface BookInvite {
  id: string
  bookId: string
  bookName: string
  toUserId: string
  fromUserId: string
  /** 接受后拿到的角色 */
  role: 'reader' | 'editor'
  /** 邀请人写的一句话 */
  message: string
  status: 'pending' | 'accepted' | 'declined' | 'revoked'
  createdAt: number
  /** 处理时间；pending 时为 0 */
  respondedAt: number
  /**
   * 我是**收方**（能接受 / 拒绝）还是**发方**（只能看与撤回）。
   *
   * ⚠️ 这条是必须的：`GET /api/invites` 同时返回「我收到的」和
   *    「我发出的」—— 不区分的话，发出去的那几条会混进待办列表，
   *    用户对着自己发出去的邀请看到「接受 / 拒绝」两个按钮。
   */
  asReceiver: boolean
  /**
   * 两个人名，**由服务端从 users 表解析好一起返回**。
   *
   * ⚠️ 为什么不能靠客户端自己查：
   *   界面原来一律走 `getMember(id)?.name`。但成员表里未必有这个人 ——
   *   他可能不在同一个空间，或者成员列表还没加载完。
   *   那时收件箱显示「有人」、等待列表显示「未知成员」——
   *   **而服务端明明已经知道名字**，就在响应里躺着没人用。
   *   用户看着的是「未知成员」，他不知道对面是谁，只能退回去翻成员表。
   *   所以：客户端查到的名字优先（可能带本地改动），查不到就用服务端给的。
   */
  fromName?: string
  /** 被邀请人（发方视角下要知道在等谁） */
  toName?: string
}

/*
 * ⚠️ 这里原来有 `export interface Collaboration`（协作邀请），
 *    2026-10-11 已删 —— 那套是无服务端表、无 API、不在同步实体清单里的
 *    **纯客户端假数据**，界面在补了真正的 `BookInvite` 之后就不读它了。
 *
 *    它长得像真数据：docId / fromMemberId 全指向真实条目、unread 也有，
 *    而它是编的。留着的话，下一个人排查「协作列表为什么是空的」，
 *    会先怀疑同步或渲染，而不是先问「这套数据本来没人读」。
 *
 *    真正在用的是 `BookInvite`（上面那个，有服务端表、有路由、
 *    接受后真的进 book_members）。
 */

/** 收藏 */
export interface Favorite {
  id: string
  targetType: 'doc' | 'book'
  targetId: string
  title: string
  createdAt: number
}

/** 关注一个空间或一个人 */
export interface Follow {
  id: string
  targetType: 'space' | 'user'
  targetId: string
  createdAt: number
}

/** 全局状态 */
export interface AppData {
  currentUser: Member
  spaces: Space[]
  members: Member[]
  books: Book[]
  nodes: TreeNode[]
  docs: Record<string, Doc>
  comments: Record<string, Comment[]>
  notes: Note[]
  topics: Topic[]
  /** 话题（讨论区）的回复。独立实体，按 topicId 归属 */
  topicReplies: TopicReply[]
  favorites: Favorite[]
  /** 关注（空间 / 人）。个人实体 */
  follows: Follow[]
  /** 最近访问 */
  recents: { docId: string; viewedAt: number }[]
  /**
   * 回收站。**只有文档一级** —— 语雀的回收站也只收单篇文档，
   * 删知识库是硬删、不可恢复（见 store 的 `deleteBook`）。
   *
   * `bookId` 必须在类型里：回收站要按它分组显示、恢复时也要靠它把文档
   * 放回原来的库。以前它只在运行时被 `deleteDoc` 用 `as any` 塞进去，
   * 类型上等于「不存在」—— 于是谁想读它都得先绕一次类型断言，
   * 而读它的地方（删除知识库时要摘掉本库的回收站行）就是这样被漏掉的。
   */
  trash: { docId: string; title: string; bookId: string; deletedAt: number }[]

  /**
   * 知识库邀请（2026-10-11）。服务端下发的**待处理**邀请。
   *
   * ⚠️ 为什么它属于 `AppData`（会被 persist）而 toast 不属于：
   *    邀请是**别人的待办**（林知远登录时看到的是发给他的），
   *    刷新后必须还在 —— 而「应用内消息」属于 UI 态，刷新就该没。
   *    不过实际以服务端为准，persist 只是让刷新后不至于空白一下。
   */
  bookInvites?: BookInvite[]

  /* ---- 以下为知识库设置中心 / 模板中心 / 协作 / 划词评论 ---- */
  /** 知识库设置，key 为 bookId */
  bookSettings: Record<string, BookSettings>
  /** 知识库成员与权限，key 为 bookId */
  bookMembers: Record<string, BookMember[]>
  /** 模板中心 */
  templates: DocTemplate[]
  /** 划词评论，key 为 docId */
  selectionComments: Record<string, SelectionComment[]>
  /** 远端协作者的光标（演示态） */
  cursors: CollabCursor[]
}

/* ============================================================
   知识库设置中心
   语雀：知识库设置支持「信息 / 目录管理 / 文档管理 / 权限 / 安全 / 统计 / 回收站」
   ============================================================ */

export interface BookSettings {
  /** 导出限制：禁止成员导出敏感文档 */
  restrictExport: boolean
  /** 全局水印 */
  watermark: boolean
  watermarkText: string
  /** IP 白名单，仅这些 IP 能访问 */
  ipWhitelist: boolean
  ipList: string[]
  /**
   * 搜索关键词屏蔽（语雀企业版）。
   * 开着时，含这些词的**搜索请求在服务端就被拒**，返回空结果 ——
   * 不是搜出来再由前端藏起来（那等于先把片段发出去）。
   * 挡的是查询词，不是「结果里含这个词的文档」。
   *
   * ⚠️ 这两列声明成**可选**，是刻意的（2026-10-18 `npm run build` 修类型时发现的）：
   *   `defaultBookSettings()` **故意不给它们默认值**，走数据库列的默认值
   *   （`blockSearch INTEGER NOT NULL DEFAULT 0`）。
   *   理由见 `server/sync.ts` 里 WATCHED 上面那段 ——
   *   `book_settings` 的列清单在项目里有五份、各自独立维护，
   *   而「五处应当一致」这个不变量**本来就不成立**（这两处就该不一样）。
   *
   *   所以不是「忘了补」，是「前端不给、用表默认」。消费侧本来就写成
   *   `s.blockTerms || []`，与可选一致。
   */
  blockSearch?: boolean
  blockTerms?: string[]
  /** 离职权限回收 */
  autoRevoke: boolean
  /** 是否公开在互联网 */
  publicAccess: boolean
  /** 默认文档宽度：standard / wide */
  defaultWidth: 'standard' | 'wide'
  /** 文档默认可见性 */
  defaultVisibility: 'public' | 'private' | 'space'
  /**
   * 新建文档放在层级的顶部还是底部。
   *
   * 2026-10-10 实测语雀「更多设置 → 高级选项」有这一项（顶部新增 / 底部新增），
   * 说明文字是「系统会根据该设置将其置于层级的顶部或底部」。
   */
  newDocPosition: 'top' | 'bottom'
}

export interface BookMember {
  id: string
  /** book 级角色：拥有者 / 管理员 / 编辑者 / 阅读者 / 访客 */
  role: 'owner' | 'admin' | 'editor' | 'reader' | 'visitor'
  /** 该成员在本知识库可执行的操作 */
  perms: {
    read: boolean
    comment: boolean
    edit: boolean
    create: boolean
    export: boolean
    share: boolean
  }
  joinedAt: number
}

/* ============================================================
   模板中心
   语雀：支持「本知识库模板 / 团队模板 / 我的模板」三类自定义模板
   ============================================================ */

export interface DocTemplate {
  id: string
  name: string
  desc: string
  /** 来源：本知识库 / 团队 / 官方 / 我的 */
  scope: 'official' | 'book' | 'team' | 'mine'
  bookId?: string
  spaceId?: string
  icon: string
  /** 模板正文（markdown），用于预览与「用模板新建」 */
  body: string
  category: string
  createdAt: number
  usedCount: number
}

/* ============================================================
   实时协作（演示态：模拟远端光标，不含 CRDT）
   ============================================================ */

export interface CollabCursor {
  id: string
  docId: string
  memberId: string
  /** 目标块 id */
  blockId: string
  /** 光标在该块文本中的字符偏移 */
  offset: number
  /** 选区 [start, end]，无选区时两者相等 */
  range: [number, number]
  color: string
  /** 最近活跃时间，用于离线淡出 */
  activeAt: number
}

/* ---------------- 并发编辑的合并记录 ---------------- */

/** 合并发生在哪一类目标上 */
export type CollabConflictTarget = 'block' | 'card' | 'sheet'

/**
 * 一次自动合并的记录。
 * 正文块、卡片 data、doc.sheetData 三条线共用这一份结构，
 * 协作条只管把它显示出来（「N 处并发编辑已自动合并」+ 逐条详情）。
 */
export interface CollabConflict {
  id: string
  docId: string
  /** 目标类型：正文块 / 卡片数据 / 文稿数据 */
  target: CollabConflictTarget
  /**
   * 正文块 / 卡片所在的块 id。
   * 表格类文稿（工作表 / 数据表 / 画板）没有块，落到 section 上。
   */
  blockId?: string
  /** 文稿数据的目标段：sheets / table / board（仅 target === 'sheet'） */
  section?: 'sheets' | 'table' | 'board'
  /** 人话位置，例：工作表「需求列表」 · 第 3 行 · D 列 · 内容 */
  where: string
  /** 谁的编辑被合并进来了 */
  actorId: string
  actorName: string
  /** 冲突几处（同一对象上被仲裁掉的字段数） */
  count: number
  /** 合并发生时间 */
  at: number
  /** 高亮到什么时候（2 秒淡出），UI 用它决定要不要再闪一次 */
  highlightUntil: number
}

/* ============================================================
   划词评论
   语雀阅读/编辑模式：选中文字可「评论」或「保存到小记」
   ============================================================ */

export interface SelectionComment {
  id: string
  docId: string
  authorId: string
  /** 被选中的原文 */
  quote: string
  /** 所在块 id */
  blockId: string
  text: string
  createdAt: number
  resolved: boolean
  replies: Comment[]
}

/* ============================================================
   表格类文稿的结构化数据（doc.sheetData）
   三个文稿共用一个命名空间：sheets 工作表 / table 数据表 / board 画板。
   约束：全部是可 JSON 序列化的纯数据，不许塞类实例、DOM 引用、函数。
   ============================================================ */

/** 单元格类型：文本 / 数字 / 下拉 / 日期 */
export type CellKind = 'text' | 'number' | 'select' | 'date'

/* ---------------- 工作表（sheet） ---------------- */

/** 工作表单元格：v 是原始值（统一用字符串存，number/date 渲染时再格式化） */
export interface SheetCell {
  v: string
}

/** 工作表列定义 */
export interface SheetCol {
  id: string
  name: string
  k: CellKind
  /** 列宽（px），缺省走 CSS 默认值 */
  w?: number
  /** k === 'select' 时的候选项 */
  opts?: string[]
}

/** 单个工作表（一个 tab） */
export interface SheetTab {
  id: string
  name: string
  cols: SheetCol[]
  rows: SheetCell[][]
}

/** 工作表数据：多 sheet + 当前选中的 tab */
export interface SheetData {
  sheets: SheetTab[]
  activeId: string
}

/* ---------------- 数据表（table） ---------------- */

export type DtStatus = '待开始' | '进行中' | '评审中' | '已完成'
export type DtPriority = 'P0' | 'P1' | 'P2'
/** 可筛选 / 排序的字段 */
export type DtField = 'name' | 'owner' | 'status' | 'priority' | 'date' | 'tags'
/** 视图形态：四种视图看的是同一份 records */
export type DtViewType = 'table' | 'kanban' | 'gallery' | 'calendar'
export type DtOp = 'is' | 'isNot' | 'contains' | 'before' | 'after'

/** 一条记录 */
export interface DtRecord {
  id: string
  /** 需求名称 */
  name: string
  /** 负责人姓名，对应 members 里的人 */
  owner: string
  status: DtStatus
  priority: DtPriority
  /** YYYY-MM-DD */
  date: string
  tags: string[]
  /** 备注（数据表自己的额外字段，旧数据没有也兼容） */
  note?: string
}

/** 视图自带的筛选 / 排序条件，随视图一起落盘 */
export interface DtRule {
  field: DtField
  op: DtOp
  value: string
}

/** 一个视图：kind 决定渲染成表格 / 看板 / 画廊 / 日历 */
export interface DtView {
  id: string
  name: string
  kind: DtViewType
  /** 状态筛选（'全部' 表示不过滤） */
  status: DtStatus | '全部'
  /** 关键字搜索（按名称 / 负责人 / 标签模糊匹配） */
  q: string
  sort: DtField
  dir: 'asc' | 'desc'
  rules: DtRule[]
  /** 日历视图当前翻到的月份 YYYY-MM */
  month?: string
  /** 分组字段（看板按状态固定分组，此处留给后续扩展） */
  groupBy?: DtField
}

/** 数据表数据：记录 + 视图 + 当前视图 */
export interface TableData {
  records: DtRecord[]
  views: DtView[]
  activeViewId: string
}

/* ---------------- 画板（board） ---------------- */

export type BoardShape = 'rect' | 'round' | 'circle' | 'diamond' | 'cylinder'

/** 画板卡片：x/y/w/h 是「画布坐标」，与视口无关，落盘即所见 */
export interface BoardCard {
  id: string
  x: number
  y: number
  w: number
  h: number
  text: string
  /** 底色，取 PALETTE 里的色值 */
  color: string
  shape: BoardShape
}

/** 卡片之间的连线 */
export interface BoardEdge {
  id: string
  from: string
  to: string
}

/** 画布布局模式：
 * - auto：窄屏按卡片序重排（只影响显示，不动数据）
 * - free：用户已经摆过位置，数据即所见，任何视口都不再重排
 */
export type BoardLayout = 'auto' | 'free'

/** 画板数据 */
export interface BoardData {
  cards: BoardCard[]
  edges: BoardEdge[]
  /** 画布底色（网格底 / 纯色） */
  background: 'grid' | 'plain'
  layout: BoardLayout
}

/** doc.sheetData 的总结构 —— 三种文稿共用一个命名空间，按文稿类型只填其中一段 */
export interface DocSheetData {
  /** 数据结构版本，留给将来做迁移 */
  v?: number
  sheets?: SheetData
  table?: TableData
  board?: BoardData
}
