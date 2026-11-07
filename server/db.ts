/* ============================================================
   服务端数据层 —— node:sqlite
   为什么用内置的 node:sqlite 而不是 better-sqlite3：
   内网部署最怕的就是「换台机器装不上」。better-sqlite3 要编译原生模块，
   node:sqlite 是 Node 自带的（本项目要求 Node >= 22.5），装依赖时零编译。
   代价是它带 ExperimentalWarning，功能与 API 稳定，不影响使用。
   ============================================================ */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export type Row = Record<string, any>

/** 数据库文件路径，可用 YQ_DB 环境变量覆盖（容器部署时挂卷） */
const DB_PATH = resolve(process.env.YQ_DB || 'data/yuque.db')

mkdirSync(dirname(DB_PATH), { recursive: true })

export const db = new DatabaseSync(DB_PATH)

/* 内网部署的并发特征：几十个同事同时读写。
   WAL 让「读」不阻塞「写」，这是必须开的；
   busy_timeout 让撞上写锁时排队而不是直接抛 SQLITE_BUSY。 */
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA busy_timeout = 5000')
db.exec('PRAGMA foreign_keys = ON')

/* ============================================================
   表结构
   设计约定：
   1. 所有业务主键沿用前端的 id（s1 / bk_xxx / doc_xxx），不做重映射 ——
      这样前端已有的 100 个 action 与种子数据可以零改动直接落库。
   2. JSON 字段（blocks / sheetData / tags…）以 TEXT 存，读出时 parse。
      它们天然是「整体读、整体写」，拆成关系表只会带来无意义的复杂度。
   3. 需要跨端同步的表都带 rev（单调递增的版本号）与 updatedBy。
      rev 是同步的锚点，见 server/sync.ts。
   ============================================================ */

/* ---------- 检索投影 ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  account     TEXT NOT NULL UNIQUE,   -- 登录名
  email       TEXT,
  avatar      TEXT DEFAULT '',
  passHash    TEXT NOT NULL,
  passSalt    TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',  -- owner=超级管理员 / admin / member
  viaSso      INTEGER NOT NULL DEFAULT 0,     -- 1=由统一认证自动开户
  /* 个人简介。设置页那个输入框以前只改了组件的局部 state，
     点保存弹「资料已保存」而**什么都没存** —— 这一列是它落的地方。 */
  bio         TEXT DEFAULT '',
  createdAt   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token     TEXT PRIMARY KEY,
  userId    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  ua        TEXT DEFAULT '',
  ip        TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId);

/* ---------- 空间（团队 / 个人） ---------- */
CREATE TABLE IF NOT EXISTS spaces (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  desc      TEXT DEFAULT '',
  avatar    TEXT DEFAULT '',
  kind      TEXT NOT NULL DEFAULT 'team',  -- team / personal
  createdAt INTEGER NOT NULL,
  rev       INTEGER NOT NULL DEFAULT 0,
  updatedBy TEXT,
  /*
   * 软删除时间戳：非 0 = 已删除，0/NULL = 活着。
   *
   * 2026-10-16 照真实语雀补的（官方帮助《如何删除空间》：
   * 「空间管理员可在空间管理-空间设置-高级设置里删除，
   *   删除后 24 小时内可撤销，超过 24 小时即确认，不可逆转」）。
   *
   * 为什么是软删而不是直接 DELETE：
   *   空间的子表 books → nodes → docs 全是 ON DELETE CASCADE，
   *   直接删会**级联抹掉整棵树**，而语雀给的那 24 小时反悔期
   *   正是为了防这个 —— 没有它，一次手滑就是整团队的知识库消失。
   */
  deletedAt INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS space_members (
  spaceId  TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  userId   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'member',  -- owner / admin / member
  joinedAt INTEGER NOT NULL,
  PRIMARY KEY (spaceId, userId)
);
CREATE INDEX IF NOT EXISTS idx_spacemem_user ON space_members(userId);

/* ---------- 知识库 ---------- */
CREATE TABLE IF NOT EXISTS books (
  id        TEXT PRIMARY KEY,
  spaceId   TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  desc      TEXT DEFAULT '',
  avatar    TEXT DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'space',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  rev       INTEGER NOT NULL DEFAULT 0,
  updatedBy TEXT
);
CREATE INDEX IF NOT EXISTS idx_books_space ON books(spaceId);

CREATE TABLE IF NOT EXISTS book_members (
  bookId   TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  userId   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'reader',
  perms    TEXT DEFAULT '{}',
  joinedAt INTEGER NOT NULL,
  PRIMARY KEY (bookId, userId)
);
CREATE INDEX IF NOT EXISTS idx_bookmem_user ON book_members(userId);

CREATE TABLE IF NOT EXISTS book_settings (
  bookId            TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  restrictExport    INTEGER NOT NULL DEFAULT 0,
  watermark         INTEGER NOT NULL DEFAULT 0,
  watermarkText     TEXT DEFAULT '',
  ipWhitelist       INTEGER NOT NULL DEFAULT 0,
  ipList            TEXT DEFAULT '[]',
  blockSearch       INTEGER NOT NULL DEFAULT 0,
  blockTerms        TEXT DEFAULT '[]',
  autoRevoke        INTEGER NOT NULL DEFAULT 1,
  publicAccess      INTEGER NOT NULL DEFAULT 0,
  defaultWidth      TEXT DEFAULT 'standard',
  defaultVisibility TEXT DEFAULT 'space',
  /* 2026-10-10 新增：语雀「更多设置 → 文档新建位置」。 */
  newDocPosition    TEXT DEFAULT 'top'
);

/* ---------- 目录树节点 ---------- */
CREATE TABLE IF NOT EXISTS nodes (
  id        TEXT PRIMARY KEY,
  bookId    TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  parentId  TEXT,
  title     TEXT NOT NULL DEFAULT '',
  type      TEXT NOT NULL DEFAULT 'group',
  icon      TEXT DEFAULT '',
  docId     TEXT,
  ord       REAL NOT NULL DEFAULT 0,
  hidden    INTEGER NOT NULL DEFAULT 0,
  rev       INTEGER NOT NULL DEFAULT 0,
  updatedBy TEXT
);
CREATE INDEX IF NOT EXISTS idx_nodes_book ON nodes(bookId, parentId);

/* ---------- 文稿（文档 / 工作表 / 画板 / 数据表） ---------- */
CREATE TABLE IF NOT EXISTS docs (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL DEFAULT 'doc',
  title       TEXT NOT NULL DEFAULT '',
  body        TEXT DEFAULT '',
  blocks      TEXT DEFAULT '[]',
  authorId    TEXT,
  createdAt   INTEGER NOT NULL,
  updatedAt   INTEGER NOT NULL,
  wordCount   INTEGER NOT NULL DEFAULT 0,
  visibility  TEXT NOT NULL DEFAULT 'space',
  published   INTEGER NOT NULL DEFAULT 0,
  tags        TEXT DEFAULT '[]',
  sheetData   TEXT,
  lockMemberId TEXT,
  lockAt      INTEGER,
  /* 反范式冗余：权限判定要 doc→book→space，走 nodes 会多一次查询 */
  spaceId     TEXT,
  bookId      TEXT,
  /**
   * 软删除标记。**删掉的文稿仍留在表里**，只是从这里过滤掉。
   *
   * 之前是硬删：删完 GET /api/doc/:id 直接 404，而回收站里还列着它、
   * 点「恢复」只弹一句「已恢复，请重新归档」—— 内容其实早就没了。
   * 那不叫回收站，叫删除记录的墓碑。误删一篇文档就等于永久丢失。
   *
   * 软删保留正文、版本、评论、附件关联，恢复只是把标记翻回去，
   * 所以恢复出来的东西是**完整的**，不是空壳。
   *
   * （注意：这段注释在 db.exec 的模板字符串里，不能出现反引号。）
   */
  trashed     INTEGER NOT NULL DEFAULT 0,
  /* 服务端记的删除时刻。回收站那圈「还剩 N 天」倒计时按它算，
     自动清除也按它算。
     **不能信 trash 表里的 deletedAt** —— 那是客户端推上来的，
     传个 0 就是「1970 年删的」，留着就是「明天就删」。
     所以删除那一刻由服务端写，这一列只可能来自 deleteRow。 */
  deletedAt   INTEGER DEFAULT 0,
  rev         INTEGER NOT NULL DEFAULT 0,
  updatedBy   TEXT,
  /* 路径（语雀的 slug）：文档在知识库里的短地址。
     为空表示没设，链接会退回用 docId —— 而**不是**退回一个假的地址。
     （真正的唯一性靠下面那个 partial unique index，见「补列」那一节。） */
  slug        TEXT DEFAULT '',
  /* 摘录：分享卡片与搜索结果里那一行说明。空就只是没有，不编。 */
  summary     TEXT DEFAULT '',
  /*
   * 点赞：存 userId 数组，和 notes.likes 同一个形状。
   *
   * 为什么补这一列（2026-10-09）：
   * 文档页那个赞以前是纯组件内 state，而点赞数是这么算出来的 ——
   * useState(() => 3 + (Number(docId.slice(-1)) || 0) * 2)。
   * 也就是说：数字是**按 docId 末位编出来的**，不是任何人真的点过；
   * 状态只在内存里，刷新就没、换设备看不见、服务端更没有这个概念。
   * 语雀工作台有「我点赞的」视图，它要靠这份数据。
   *
   * 存数组而不是建一张 doc_likes 表：notes 已经是这个形状并且跑通了，
   * 跟着走就别再发明第二种（复合主键那套坑这项目记过，见 book_members）。
   *
   * ⚠️⚠️⚠️ 这整段注释在 db.exec 的模板字符串里，**绝对不能出现反引号**。
   * 我写这一段时连着犯了两次：先在 notes.likes 上用了反引号，改掉之后
   * 又在 useState(...) 上用了 —— 每次都把模板字符串提前结束，
   * server 起不来，报的是 ERR_INVALID_TYPESCRIPT_SYNTAX，而**报错位置
   * 在一条注释里**，看起来像乱码、完全联想不到是反引号。
   * 所以这里一律用中文引号或不加引号的写法。
   */
  likes       TEXT DEFAULT '[]',
  /*
   * 置顶时刻（毫秒时间戳，0 = 没置顶）。
   *
   * 语雀的对应物是 docs.pinned_at，而它是被一个**具名开关**
   * enable_book_doc_pin 控制的（2026-10-12 匿名 SSR 取到的 settings 里
   * 就带着 enable_book_doc_pin: true），所以「知识库文档置顶」
   * 确实是语雀的产品能力，不是内部字段。
   *
   * 为什么落在 docs 而不是 nodes：
   *   · 语雀就落在 doc 上；
   *   · 置顶要能扛住「在目录里挪位置」——挂在节点上会跟着树一起动，
   *     取消置顶就找不到原来该待的位置了。
   *
   * 这里只存「有没有置顶 + 什么时候」，**不存顺序**：
   * 置顶的显示顺序由渲染层算（见 Tree.tsx 的 pinFirst 注释），
   * 树上的 order 一律不动 —— 取消置顶就精确回到原位，
   * 而且不会因为置顶产生一次节点改写（那会走整条同步 + 审计）。
   *
   * ⚠️ **故意不写 NOT NULL**，和上面 slug / summary / deletedAt 一样。
   *   线上协议里「没置顶」是 **null**（entities.ts 的 DOC_SHAPE 归一），
   *   而客户端新建的文档压根没有这个键 —— 客户端推上来的就是 null。
   *   这一列要是声明成 NOT NULL，服务端 INSERT 会直接被拒：
   *     rejected: docs/d1「NOT NULL constraint failed: docs.pinnedAt」
   *   实测踩过：这条把**点赞**一起弄挂了（同一行推送被一起拒），
   *   现象是「点完赞，本地有、服务端没有」。
   *   一列的「非空」约束只在该字段真的没有第三种取值时才成立；
   *   这里有 null / 0 / 时间戳三种，判据一律写 Number(pinnedAt) > 0。
   */
  pinnedAt    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_docs_book ON docs(bookId);
CREATE INDEX IF NOT EXISTS idx_docs_space ON docs(spaceId);
CREATE INDEX IF NOT EXISTS idx_docs_trashed ON docs(trashed);

/* ---------- 历史版本 ---------- */
CREATE TABLE IF NOT EXISTS doc_versions (
  id         TEXT PRIMARY KEY,
  docId      TEXT NOT NULL,
  title      TEXT DEFAULT '',
  body       TEXT DEFAULT '',
  blocks     TEXT DEFAULT '[]',
  createdAt  INTEGER NOT NULL,
  editorName TEXT DEFAULT '',
  at         INTEGER NOT NULL,
  label      TEXT DEFAULT '自动保存'
);
CREATE INDEX IF NOT EXISTS idx_versions_doc ON doc_versions(docId, at DESC);

/* ---------- 评论 ---------- */
CREATE TABLE IF NOT EXISTS comments (
  id        TEXT PRIMARY KEY,
  docId     TEXT NOT NULL,
  authorId  TEXT,
  text      TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  anchorId  TEXT,
  rev       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_comments_doc ON comments(docId);

CREATE TABLE IF NOT EXISTS comment_replies (
  id        TEXT PRIMARY KEY,
  commentId TEXT NOT NULL,
  authorId  TEXT,
  text      TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_replies_comment ON comment_replies(commentId);

/* ---------- 话题回复（讨论区）----------
   以前讨论区的回复只活在组件的 useState 里：一刷新就没、换设备看不见。
   界面上却和评论长得一模一样，用户会理所当然地以为它是存的。
   和 comment_replies 同构：独立表 + 父 id，权限跟着父话题所属的空间走。 */
CREATE TABLE IF NOT EXISTS topic_replies (
  id        TEXT PRIMARY KEY,
  topicId   TEXT NOT NULL,
  authorId  TEXT,
  text      TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topic_replies_topic ON topic_replies(topicId);

/* ---------- 划词评论 ---------- */
CREATE TABLE IF NOT EXISTS selection_comments (
  id        TEXT PRIMARY KEY,
  docId     TEXT NOT NULL,
  authorId  TEXT,
  quote     TEXT DEFAULT '',
  blockId   TEXT DEFAULT '',
  text      TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  resolved  INTEGER NOT NULL DEFAULT 0,
  rev       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_selcomments_doc ON selection_comments(docId);

CREATE TABLE IF NOT EXISTS selection_comment_replies (
  id               TEXT PRIMARY KEY,
  selectionCommentId TEXT NOT NULL,
  authorId         TEXT,
  text             TEXT NOT NULL,
  createdAt        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_selreplies ON selection_comment_replies(selectionCommentId);

/* ---------- 小记 / 话题 ---------- */
CREATE TABLE IF NOT EXISTS notes (
  id        TEXT PRIMARY KEY,
  spaceId   TEXT,
  text      TEXT NOT NULL,
  authorId  TEXT,
  createdAt INTEGER NOT NULL,
  likes     TEXT DEFAULT '[]',
  tags      TEXT DEFAULT '[]',
  image     TEXT,
  rev       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_notes_space ON notes(spaceId, createdAt DESC);

CREATE TABLE IF NOT EXISTS topics (
  id          TEXT PRIMARY KEY,
  spaceId     TEXT,
  title       TEXT NOT NULL,
  authorId    TEXT,
  createdAt   INTEGER NOT NULL,
  replyCount  INTEGER NOT NULL DEFAULT 0,
  participants TEXT DEFAULT '[]',
  hot         INTEGER NOT NULL DEFAULT 0,
  rev         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_topics_space ON topics(spaceId, createdAt DESC);

/* ---------- 模板 ---------- */
CREATE TABLE IF NOT EXISTS templates (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  desc      TEXT DEFAULT '',
  scope     TEXT NOT NULL DEFAULT 'official',
  bookId    TEXT,
  spaceId   TEXT,
  icon      TEXT DEFAULT '',
  body      TEXT DEFAULT '',
  category  TEXT DEFAULT '',
  createdAt INTEGER NOT NULL,
  usedCount INTEGER NOT NULL DEFAULT 0,
  ownerId   TEXT,
  rev       INTEGER NOT NULL DEFAULT 0
);

/* ---------- 收藏 / 最近访问 / 回收站 ---------- */
CREATE TABLE IF NOT EXISTS favorites (
  id         TEXT PRIMARY KEY,
  userId     TEXT NOT NULL,
  targetType TEXT NOT NULL,
  targetId   TEXT NOT NULL,
  title      TEXT DEFAULT '',
  createdAt  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fav_unique ON favorites(userId, targetType, targetId);

/* ---------- 知识库邀请（2026-10-11 新增）----------
   以前本项目只有「管理员单向把人加进库」，没有「发出去 → 对方收到 → 接受/拒绝」。
   collaborations 那套是纯客户端种子（无表、无 API、不在同步清单），UI 已门控隐藏。

   ⚠️ 这段 SQL 在**模板字符串**里，所以注释里**不能出现反引号** ——
      写一个就会把字符串提前闭合，tsc 抓不到，
      只有真起服务端才会炸（ERR_INVALID_TYPESCRIPT_SYNTAX）。
      ⚠️⚠️ 而这条注释本身第一版就**犯了它自己说的事**：
      里面为了举例写了两个反引号，于是照样炸。
      **注释里说明「别写反引号」时，连举例都不能用反引号。**

   状态机：pending → accepted / declined / expired
   ⚠️ 一个 (bookId,toUserId) 只允许**一条未处理的**邀请 ——
      重复邀请会让人在待办里看到好几条一样的。所以用部分唯一索引
      （只对 pending 建索引），而不是整表 (bookId,toUserId) 唯一 ——
      后者会让「拒绝过之后还能再邀请」这条正常路径直接失败。 */
CREATE TABLE IF NOT EXISTS book_invites (
  id          TEXT PRIMARY KEY,
  bookId      TEXT NOT NULL,
  toUserId    TEXT NOT NULL,
  fromUserId  TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'reader',
  message     TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pending',
  createdAt   INTEGER NOT NULL,
  respondedAt INTEGER DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_pending
  ON book_invites(bookId, toUserId) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_inv_to ON book_invites(toUserId, status);

/* ---------- 关注（空间 / 人）----------
   以前「关注」整个是假的：Dashboard 的关注页把**全部**空间和除 u1 外的
   **全部**成员列出来，配两个没有 onClick 的「已关注」按钮。
   也就是说列表是编的，按钮点了没反应，而项目里压根没有关注这张表。 */
CREATE TABLE IF NOT EXISTS follows (
  id         TEXT PRIMARY KEY,
  userId     TEXT NOT NULL,
  targetType TEXT NOT NULL,   -- 'space' | 'user'
  targetId   TEXT NOT NULL,
  createdAt  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_follow_unique ON follows(userId, targetType, targetId);

/* ---------- 操作日志（审计）----------
   公司内部知识库必须能回答一句话：「谁在什么时候把权限给了谁」。
   在这个表之前，项目里没有地方能回答它 ——
   changes 表只服务增量同步（谁改了哪一行），而且不记 actor 的意图：
   你看不出「把人加进知识库」和「改了知识库描述」的区别。
   权限授予、导出、离职回收这类动作没有第二份记录。

   ⚠️ 这段注释里**不能出现任何反引号**：整块建表语句在 db.exec 的模板字符串里，
   一个落单反引号就会把模板提前闭合 —— 文件看着配对，实际直接语法错误，
   而且报错位置会指到一个毫不相干的行。test-lint 会逐处扫这个。 */
CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  at         INTEGER NOT NULL,
  actorId    TEXT,
  actorName  TEXT DEFAULT '',
  action     TEXT NOT NULL,   -- space.member.add / export / offboard …
  targetType TEXT DEFAULT '', -- space / book / user / doc
  targetId   TEXT DEFAULT '',
  targetName TEXT DEFAULT '',
  detail     TEXT DEFAULT ''  -- JSON
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

/* ---------- 文档之间的引用（反向链接）----------
   语雀的「章节链接 / 插入文档块」是知识库的核心能力：
   一份规范里链接另外三份文档，是知识库和一堆孤立页面的分界线。
   官方选型文档也把「文档章节、段落间建立关联（单向/双向引用）」列为**基本功能**。

   这张表是**推导出来的**，不是客户端写上来的：
   保存文稿时扫一遍正文里的锚点，认出指向本站其它文稿的 href，重算这张表。
   做成推导而不是实体，是因为它必须和正文永远一致 ——
   要是允许客户端单独写，正文里删掉链接而表里还留着，
   「谁引用了我」就会指着一篇根本不提我的文档说谎。

   ⚠️ 这段注释里不能出现反引号（同上，模板字符串会被提前闭合）。 */
CREATE TABLE IF NOT EXISTS doc_links (
  sourceDocId TEXT NOT NULL,   -- 谁写的链接
  targetDocId TEXT NOT NULL,   -- 指向谁
  at          INTEGER NOT NULL,
  PRIMARY KEY (sourceDocId, targetDocId)
);
CREATE INDEX IF NOT EXISTS idx_doc_links_target ON doc_links(targetDocId);

CREATE TABLE IF NOT EXISTS recents (
  userId    TEXT NOT NULL,
  docId     TEXT NOT NULL,
  viewedAt  INTEGER NOT NULL,
  PRIMARY KEY (userId, docId)
);
CREATE INDEX IF NOT EXISTS idx_recents_user ON recents(userId, viewedAt DESC);

CREATE TABLE IF NOT EXISTS trash (
  docId     TEXT PRIMARY KEY,
  bookId    TEXT,
  title     TEXT DEFAULT '',
  deletedAt INTEGER NOT NULL,
  deletedBy TEXT
);

/* ---------- 附件二进制 ---------- */
CREATE TABLE IF NOT EXISTS attachments (
  id        TEXT PRIMARY KEY,
  docId     TEXT,
  blockId   TEXT,
  filename  TEXT NOT NULL,
  mime      TEXT DEFAULT 'application/octet-stream',
  size      INTEGER NOT NULL DEFAULT 0,
  data      BLOB,
  createdAt INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attach_doc ON attachments(docId);

/* ---------- 变更日志：跨端同步的锚点 ----------
   每一次写入都追加一行。客户端记住上次同步到的 seq，
   拉取时只要 WHERE seq > ?，就只传增量。
   相比「按表逐个对比」，这个表让同步变成一条有序的日志流，
   既能增量拉取，也能断线重连后补齐（不丢中间的消息）。

   ⚠️ **这张表只增不减，而且是有意的** —— 没有任何地方 DELETE FROM changes。
   *
   * 实测体积（含索引约 **73 字节/行**，2026-10-06 灌 20 万行量的）：
   *   每天 100 次写入 → 一年   2.5 MB
   *   每天 1000 次    → 一年  25 MB
   *   每天 10000 次   → 一年 254 MB
   * 内网部署通常是几十个活跃编辑，也就是第一档，**可以忽略**。
   *
   * seq 是 INTEGER PRIMARY KEY（AUTOINCREMENT，即 rowid 别名），
   * 所以 WHERE seq > ? ORDER BY seq ASC LIMIT 2000 走的是**索引范围扫描** ——
   * 每隔几秒被每个客户端调一次也不会变成全表扫描。
   *
   * ------------------------------------------------------------
   * 如果将来要清理这张表 —— 2026-10-06 有意没做，理由记在这里
   * ------------------------------------------------------------
   * 清理会让**离线很久的客户端静默丢掉一段变更**：
   * 它的 since 落在被删掉的区间里，WHERE seq > ? 一行都不匹配，
   * 服务端于是回一个「没有变化」—— 客户端认为已经同步完了。
   *
   * 这正是 7.31 修过的那个 bug 的新形态（那时是 LIMIT 2000 截断之后
   * 游标却报全局最大值）。所以真要清理的话，**必须同时**：
   *   ① 记下「保留下限」（比如 MIN(seq)），
   *   ② 客户端的 since 落在下限之前时**明确告诉它「游标太旧，请重新 bootstrap」**，
   *      而不是回一个空批次。
   * 只做 ① 不做 ②，就是把一个显式失败变成静默丢数据。
   * 宁可让库慢慢长 —— 它是**正确性**的锚点，不是缓存。 */
CREATE TABLE IF NOT EXISTS changes (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  entity   TEXT NOT NULL,
  entityId TEXT NOT NULL,
  op       TEXT NOT NULL,        -- upsert / delete
  rev      INTEGER NOT NULL DEFAULT 0,
  actorId  TEXT,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_changes_seq ON changes(seq);

/* ---------- 协同 op 归档 ----------
   协作过程本身不落 SQLite（走 WebSocket 广播），
   但每隔一段时间把最新快照存一行，用于新客户端接入时对齐，
   以及服务端重启后仍能恢复文档内容。 */
CREATE TABLE IF NOT EXISTS doc_snapshots (
  docId   TEXT NOT NULL,
  actorId TEXT,
  data    TEXT NOT NULL,
  clock   INTEGER NOT NULL DEFAULT 0,
  at      INTEGER NOT NULL,
  PRIMARY KEY (docId, actorId)
);

/* ---------- 检索索引 ----------
   正文是 JSON（blocks），没法直接 LIKE；而且轻量启动之后客户端不再持有
   全部正文，搜索**必须**在服务端做。

   这里存一份「可搜索的纯文本投影」，写入对应实体时同步更新。
   覆盖三类，与搜索框的占位文案一致：文档 / 知识库 / 小记。

   刻意用 LIKE 而不是 FTS5：FTS5 的 unicode61 分不了中文，
   trigram 又要求查询至少 3 个字 —— 而「产品」「系统」这种两字词
   在中文知识库里太常见了，用 FTS5 反而会直接漏掉。
   几千到几万篇的量级下，带权限过滤 + LIMIT 的 LIKE 扫描完全够用。
   真要上 FTS5，得先解决中文分词，不是换个 tokenize 就行。 */
CREATE TABLE IF NOT EXISTS search_index (
  kind      TEXT NOT NULL,      -- doc / book / note
  targetId  TEXT NOT NULL,
  bookId    TEXT,               -- 权限判定用；book 自身就是它
  spaceId   TEXT,
  title     TEXT DEFAULT '',
  text      TEXT DEFAULT '',
  updatedAt INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, targetId)
);
CREATE INDEX IF NOT EXISTS idx_search_book ON search_index(bookId);
CREATE INDEX IF NOT EXISTS idx_search_kind ON search_index(kind);

/* 索引口径的版本号。
 * 索引是**写时派生**的：upsertRow 每存一次文稿顺手 reindex 一次。
 * 问题是**口径本身会变** —— 2026-10-06 就把卡片 data 的抽取从
 * 「只抽 name/text」改成深走，于是新写的文稿能搜到卡片里的内容，
 * 而**升级之前写下的每一篇仍然搜不到**，要等到有人去编辑它才会重建。
 * 一家有几千篇文档的公司知识库，这一等就是好几年。
 *
 * 所以把口径版本号落库：启动时对不上就重建一次。 */
CREATE TABLE IF NOT EXISTS kv_meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`)

/* ============================================================
   阅读记录
   ------------------------------------------------------------
   以前知识库的「统计」页展示的是**编造的数字**：
   访问者/浏览量写死在 `src/data/settings.ts` 的 seedBookStats 里，
   14 天趋势图是用一个种子 LCG **随机生成**的，连「今天 N 次」也是。

   公司里真拿这个数写报告，所以必须换成真数据。
   这里记的是「谁在哪天看过哪篇」，主键就是那三样：
   同一个人同一天看同一篇只算一次 —— 否则「浏览量」会被刷新页面的
   次数灌水，而「访问者」本来就该按人去重。
   ============================================================ */
db.exec(`
CREATE TABLE IF NOT EXISTS doc_views (
  docId   TEXT NOT NULL,
  day     TEXT NOT NULL,              -- YYYY-MM-DD，按天聚合
  userId  TEXT NOT NULL,
  bookId  TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (docId, day, userId)
);
CREATE INDEX IF NOT EXISTS idx_docviews_book ON doc_views(bookId, day);
CREATE INDEX IF NOT EXISTS idx_docviews_doc ON doc_views(docId, day);
`)

/* ============================================================
   单篇文档的外部分享
   ------------------------------------------------------------
   分享弹窗里一直挂着「互联网上获得链接的人可查看」和「允许下载 / 导出」，
   但这两样**都没有任何服务端实现**：
     · 文档设成公开后，拿到链接的人打开仍然是登录页（所有接口都要登录）
     · 「允许下载」那个开关只改了组件里的局部 state，关掉弹窗就没了
   也就是说管理员点完「保存设置」会得到一句「权限已更新」，
   然后放心地把链接发给外部合作方 —— 而对方看到的是登录框。

   这种错的方向和「按钮点了没反应」正好相反：界面给了肯定的反馈，
   而实际上什么都没变。对一份准备对外的文档来说，这是最坏的一种假象。

   所以这张表把「外部分享」真正需要的东西存下来：
     访问密码（只存哈希与盐）、有效期、是否允许下载。
   「要不要对外公开」本身仍然在 docs.visibility 上 ——
   那是要跨端同步的业务字段，不能为了外部分享把它搬进服务端私有表。

   ⚠️ 同样不能出现反引号（模板字符串会被提前闭合）。
   ⚠️ 也不在同步清单里：密码哈希推给所有登录设备没有任何道理。
   ============================================================ */
db.exec(`
CREATE TABLE IF NOT EXISTS doc_share (
  docId         TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
  passwordHash  TEXT DEFAULT '',        -- 空 = 不需要密码
  passwordSalt  TEXT DEFAULT '',
  expiresAt     INTEGER NOT NULL DEFAULT 0,   -- 0 = 永不过期
  allowDownload INTEGER NOT NULL DEFAULT 1,
  updatedAt     INTEGER NOT NULL DEFAULT 0,
  updatedBy     TEXT,
  rev           INTEGER NOT NULL DEFAULT 0
);
`)

/* ============================================================
   个人访问令牌（API Token）
   ------------------------------------------------------------
   自建知识库最常被问到的两件事之一：CI 能不能自动发文档、
   别的系统能不能把文档读出去。答案不该是「你只能人去点网页」。

   ⚠️ **这张表刻意不进同步实体清单**（server/entities.ts 里没有 apiTokens）。
   理由不是「少一个功能」，而是它进了会发生下面这件事：
   同步是把每一行推给**所有登录设备**的。一旦 apiTokens 成为实体，
   令牌哈希（以及任何不小心混进去的明文列）就会被 bootstrap 整包发给
   每一个同事的前端，落到每一台机器的 localStorage 里。
   令牌是「某个人才能用的凭据」，权限个人级 —— 和 sessions、members、
   recents 一样属于**服务端私有**，见 test-apitoken 里的对应断言。

   ⚠️ 同理不能出现反引号（模板字符串会被提前闭合）。
   ============================================================ */
db.exec(`
CREATE TABLE IF NOT EXISTS api_tokens (
  id         TEXT PRIMARY KEY,
  userId     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,                 -- 人自己起的名字（「发版流水线」）
  prefix     TEXT NOT NULL,                 -- 明文前 12 位，只为界面上认得出是哪一把
  tokenHash  TEXT NOT NULL UNIQUE,          -- 只存哈希；明文只在创建那一次返回
  scopes     TEXT NOT NULL DEFAULT '["read"]',   -- JSON 数组：read / write
  createdAt  INTEGER NOT NULL,
  lastUsedAt INTEGER,
  expiresAt  INTEGER,                       -- 空 = 永不过期
  revokedAt  INTEGER                        -- 非空 = 已撤销
);
CREATE INDEX IF NOT EXISTS idx_apitokens_user ON api_tokens(userId);
`)

/* ============================================================
   补列
   ------------------------------------------------------------
   上面全是 CREATE TABLE IF NOT EXISTS —— 这句话对**已存在**的表什么也不做，
   不会把新加的字段补进去。老库直接跑新代码就会在访问那一列时炸
   （no such column），而且往往炸在很久之后某个不相关的请求上，很难查。

   所以后加的列都要在这里补一次。PRAGMA table_info 读的是当前实际结构，
   补过了就跳过，可以反复执行。
   ============================================================ */
const userCols = db.prepare('PRAGMA table_info(users)').all() as Row[]
if (!userCols.some((c) => c.name === 'viaSso')) {
  db.exec('ALTER TABLE users ADD COLUMN viaSso INTEGER NOT NULL DEFAULT 0')
}

/**
 * 密码最后修改时间。
 *
 * 设置页原来写死一句「上次修改于 3 个月前」—— 系统里根本没有这个时间，
 * 所有人看到的都是 3 个月前，包括**今天刚改完密码**的人。
 * 写死的数字比不显示更糟：它让人以为这个值是真的。
 *
 * 幂等 ALTER，老库直接补列。
 */
if (!userCols.some((c) => c.name === 'passwordChangedAt')) {
  db.exec('ALTER TABLE users ADD COLUMN passwordChangedAt INTEGER')
}

/**
 * 知识库设置：搜索关键词屏蔽。
 *
 * 同样必须补 —— `CREATE TABLE IF NOT EXISTS` 对**已存在**的表是什么都不做的，
 * 所以早先部署的实例上 `book_settings` 里根本没有这两列。
 * 实测那种库上：
 *   · 写设置 → `no such column: blockSearch`
 *   · 搜索时读屏蔽词 → `no such column: blockSearch`
 * 也就是「升级之后一改知识库设置就报 500」，而且报错出现在一个和升级毫无关系的操作上，
 * 极难往版本问题上想。
 *
 * 默认值必须是「关」：老库升级不该让存量实例突然开始屏蔽搜索。
 */
const bookSettingCols = db.prepare('PRAGMA table_info(book_settings)').all() as Row[]
if (!bookSettingCols.some((c) => c.name === 'blockSearch')) {
  db.exec('ALTER TABLE book_settings ADD COLUMN blockSearch INTEGER NOT NULL DEFAULT 0')
}
if (!bookSettingCols.some((c) => c.name === 'blockTerms')) {
  db.exec('ALTER TABLE book_settings ADD COLUMN blockTerms TEXT DEFAULT \'[]\'')
}

/*
 * 文档新建位置（2026-10-10 加，语雀「更多设置 → 高级选项」）。
 *
 * 为什么必须单独迁：**`CREATE TABLE IF NOT EXISTS` 对已存在的表不补列**。
 * 只改建表语句的话，新库有这一列、**老库没有** ——
 * 而症状极其难查：老实例在界面上选「底部新增」，看着生效了，
 * 重启一回到「顶部新增」（读 DEFAULT 'top'），
 * 而别人那台机器上根本连这个设置项都读不出来。
 *
 * `PRAGMA table_info` 读的是**当前实际结构**，所以查完再 ALTER 即可。
 */
if (!bookSettingCols.some((c) => c.name === 'newDocPosition')) {
  db.exec("ALTER TABLE book_settings ADD COLUMN newDocPosition TEXT DEFAULT 'top'")
}

/*
 * 空间的软删除标记（2026-10-16，照语雀「删除空间 + 24 小时撤销」补）。
 *
 * 与上面那条同一个坑：`CREATE TABLE IF NOT EXISTS` **对已存在的表不补列**。
 * 只改建表语句的话，新库有 `deletedAt`、老库没有 ——
 * 而症状是「老实例点删除空间直接报 `no such column: deletedAt`」，
 * 500 出在一个刚加的新功能上，很容易误判成「我改坏了」。
 */
const spaceCols = db.prepare('PRAGMA table_info(spaces)').all() as Row[]
if (!spaceCols.some((c) => c.name === 'deletedAt')) {
  db.exec('ALTER TABLE spaces ADD COLUMN deletedAt INTEGER NOT NULL DEFAULT 0')
}

/*
 * 知识库邀请（2026-10-11）。
 *
 * 建表用 `CREATE TABLE IF NOT EXISTS` 已经能覆盖老库，但**部分唯一索引**
 * 在个别 SQLite 版本上会报错 —— 而它是去重的关键（不建就会出现重复待办）。
 * 所以单独 try 一次，失败要**说出来**而不是静默跳过：
 * 没这个索引，「拒绝之后再邀请」会插进去第二条 pending。
 */
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_pending
            ON book_invites(bookId, toUserId) WHERE status = 'pending'`)
} catch (e) {
  console.warn('[warn] book_invites 的部分唯一索引没建成（' + (e?.message || e) +
    '）。功能能用，但同一对人可能出现多条待处理邀请。')
}

/**
 * 文稿的「路径」与「摘录」。
 *
 * 这两列以前**压根不存在**，而文档设置弹窗里有两个对应的输入框 ——
 * 「路径」还带着一个写死的 `yuque.com/yuque-clone/` 前缀。
 * 用户改路径、改摘录，点保存，弹「文档已保存」，
 * 而服务端把这两个字段**静默丢掉**（不在 writable 里，库里也没有列）。
 *
 * 静默丢掉是最糟的一种：不报错、不丢数据提示，
 * 只是「改了等于没改」，而界面上一切正常。
 *
 * 和上面 blockSearch 一样必须补 —— 老库上直接访问会 500，
 * 而且报的错是 `no such column: slug`，
 * 与「这次升级」毫无关系，谁也不会往版本问题上想。
 */
const docCols = db.prepare('PRAGMA table_info(docs)').all() as Row[]
if (!docCols.some((c) => c.name === 'slug')) {
  db.exec("ALTER TABLE docs ADD COLUMN slug TEXT DEFAULT ''")
}
if (!docCols.some((c) => c.name === 'summary')) {
  db.exec("ALTER TABLE docs ADD COLUMN summary TEXT DEFAULT ''")
}

/**
 * 文档点赞（存 userId 数组，见建表处那段注释）。
 *
 * 老库必须补 —— 和上面 slug / summary / deletedAt 同理：不补就是
 * `no such column: likes`，而且报错与「这次升级」毫无关系。
 *
 * 默认 '[]' 而不是 NULL：老库里的存量文档补列后一律「没人赞过」，
 * 而不是变成一个读不出来的东西。
 */
if (!docCols.some((c) => c.name === 'likes')) {
  db.exec("ALTER TABLE docs ADD COLUMN likes TEXT DEFAULT '[]'")
}

/**
 * docs.pinnedAt —— 文档置顶（见建表处那段注释）。
 *
 * 老库必须补：不补的话服务端一 SELECT * 就会
 * `no such column: pinnedAt`，而那个报错与「这次升级」毫无关系。
 *
 * ⚠️ **不需要回填**，但理由要说清楚，否则下一个人会去加：
 *   「按新建置顶时刻排序」听起来像是必须回填，可 0 在判定里
 *   明确表示「没置顶」（判定是 `Number(pinnedAt) > 0`），
 *   而存量文档本来就该是「没置顶」—— 回填成当前时间
 *   反而会把一个知识库的所有老文档**一次性全部置顶**，
 *   那是拿迁移当业务操作用。存量一律 0，界面自然看不到图钉。
 *
 * 可空、不回填，理由见建表处那一段（NOT NULL 会把整行推送一起拒掉）。
 */
if (!docCols.some((c) => c.name === 'pinnedAt')) {
  db.exec('ALTER TABLE docs ADD COLUMN pinnedAt INTEGER DEFAULT 0')
}

/**
 * 个人简介。
 *
 * 同一个道理：老库上不补这一列，「改资料」会直接 500
 * （`no such column: bio`），而那个报错与「这次升级」毫无关系。
 */
if (!userCols.some((c) => c.name === 'bio')) {
  db.exec("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''")
}

/**
 * docs.deletedAt —— 回收站保留期的计时基准。
 *
 * 补列之后要**回填**：老库里已经在回收站里的文档，这一列会是 0，
 * 而 0 在保留期判定里表示「不知道什么时候删的」。
 * 那批文档按两个办法处理都不对：
 *   · 当成「刚删的」→ 再留 30 天，其实可能躺了一年；
 *   · 当成「1970 年删的」→ 启动就把它们全清掉，那是在销毁用户数据。
 *
 * 所以回填成「补列这一刻」：等于从现在起重新算 30 天，
 * 多留一段时间不会丢东西。这是三个里唯一安全的一个。
 */
if (!docCols.some((c) => c.name === 'deletedAt')) {
  db.exec('ALTER TABLE docs ADD COLUMN deletedAt INTEGER DEFAULT 0')
  db.exec(`UPDATE docs SET deletedAt = COALESCE(
    (SELECT t.deletedAt FROM trash t WHERE t.docId = docs.id AND t.deletedAt > 0), 0
  ) WHERE trashed = 1 AND COALESCE(deletedAt, 0) = 0`)
}

/**
 * 同一个知识库里 slug 不能重。
 *
 * **partial index**：`WHERE slug <> ''` 是关键 ——
 * 绝大多数文档是没设路径的，它们之间允许重名（都叫空串）。
 * 没有这个条件的话，全库每篇没设路径的文档都会撞在一起，
 * 于是「加一篇文档」直接失败。
 *
 * 重名的后果不是「报错」那么简单：两条 URL 指向不同文档时，
 * 调用方拿到的是「看起来对但内容是另一篇」的东西。
 * 知识库场景下这种错比 500 难查得多。
 */
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_docs_slug ON docs(bookId, slug) WHERE slug <> ''")

/* ============================================================
   小工具
   ============================================================ */

/** node:sqlite 只接受 null/number/string/bigint/Uint8Array。
   布尔要显式转 0/1，否则会抛类型错。 */
export const boolInt = (v: unknown): number => (v ? 1 : 0)
export const intBool = (v: unknown): boolean => v === 1 || v === true || v === '1'

/** 安全解析 JSON 列，坏数据不能拖垮整个请求 */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback
  if (typeof raw !== 'string') return raw as T
  try {
    const v = JSON.parse(raw)
    return (v ?? fallback) as T
  } catch {
    return fallback
  }
}

/** 记录一条变更日志。返回新的 seq。 */
export function logChange(entity: string, entityId: string, op: 'upsert' | 'delete', rev: number, actorId: string) {
  db.prepare('INSERT INTO changes (entity, entityId, op, rev, actorId, at) VALUES (?,?,?,?,?,?)').run(
    entity, entityId, op, rev, actorId, Date.now(),
  )
}
