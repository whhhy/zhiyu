/* ============================================================
   同步引擎 —— 把 store 的本地落盘升级成「服务端权威 + 跨设备同步」

   为什么能不改那 100 多个 action：
   store 里所有写操作都收敛到一个入口 commit()，commit() 统一调 persist()。
   所以只要在 persist() 旁边挂一个「同步器」，全站自动就有服务端同步了 ——
   不用去 100 个 action 里逐个加「记得调接口」。

   三条数据流：
     1. 启动   bootstrap  → 整包灌进 store
     2. 本地改 persist()  → 差分 → 推送
     3. 远端改 轮询/推送  → 写进 store（走 set，不回弹）

   **绝不能把远端改动再 commit 回去**，否则会无限回环。
   所以 applyRemote 一律用 set()，这也是 store 里 set 与 commit 的分工。
   ============================================================ */

import { useStore, registerSyncHook, registerRemoteDocHook } from '@/store'
import type { AppData } from '@/types'
import {
  getMode, isAuthed, bootstrap as apiBootstrap, pullChanges, pushChanges,
  serverDataToAppData, api,
} from './api'
import type { Member } from '@/types'
// 成员名单一变，权限缓存就作废（判据与理由见 poll 里那段注释）
import { clearPermsCache } from './perms'

/* ============================================================
   实体映射：store 的键 ↔ 服务端的实体名
   —— record 形态的（docs / bookSettings）在推送时要摊平成数组
   ============================================================ */

type Bucket = 'array' | 'record' | 'recordOfArray'

const SHAPE: Record<string, Bucket> = {
  spaces: 'array',
  members: 'array',
  books: 'array',
  nodes: 'array',
  docs: 'record',
  comments: 'recordOfArray',
  selectionComments: 'recordOfArray',
  notes: 'array',
  topics: 'array',
  templates: 'array',
  favorites: 'array',
  follows: 'array',
  recents: 'array',
  trash: 'array',
  bookSettings: 'record',
  bookMembers: 'recordOfArray',
  /**
   * 知识库邀请（2026-10-11）。
   *
   * ⚠️ 不登记在这里的后果不是「报错」而是**静默不同步**：
   *   服务端已经把 bookInvites 写进表了，客户端却收不到 ———
   *   表现是「邀请发出去了，对方刷新后待办里什么都没有」，
   *   而两边都不报错。是 `test-entity-keys` 的「服务端每个实体客户端 SHAPE
   *   里都有」那条抓到的（它那句话说得很准：缺一个 = 那个实体静默不同步）。
   */
  bookInvites: 'array',
  docVersions: 'array',
  /**
   * 回复是独立实体。
   * 前端把回复**嵌套**在父评论的 replies 里，而同步按行做；
   * 不摊平的话 replies 不在评论的可写列里，会被静默丢弃 ——
   * 表现是「回复发出去了，刷新就没了」。
   */
  commentReplies: 'array',
  selectionCommentReplies: 'array',
  /**
   * 话题（讨论区）的回复。
   *
   * 以前这个列表只存在于组件的 useState 里：刷新就没、换设备看不见，
   * 而界面和真评论长得一模一样。摊平成行推上去，权限跟父话题走。
   * 刻意**不**做成 REPLY_OF 那种嵌套型：话题的回复要能单独按 topicId 过滤，
   * 嵌套的话每次取一个话题都得先在 store 里定位父对象。
   */
  topicReplies: 'array',
}

/** 会推给服务端的实体（成员名册不推，用户资料走独立接口） */
const PUSHABLE = Object.keys(SHAPE).filter((k) => k !== 'members')

/** 嵌套型实体 → 其回复实体 */
const REPLY_OF: Record<string, { parent: string; replies: string; fk: string }> = {
  commentReplies: { parent: 'comments', replies: 'commentReplies', fk: 'commentId' },
  selectionCommentReplies: { parent: 'selectionComments', replies: 'selectionCommentReplies', fk: 'selectionCommentId' },
}

/* ============================================================
   状态
   ============================================================ */

let seq = 0
/** 上一次与服务端一致的快照，作为差分基准 */
let baseline: Record<string, any[]> = {}
let started = false
/** 服务端数据是否已经灌进 store。false 期间一律不推送，见 onLocalChange。 */
let hydrated = false
let pushing = false
/** 推送失败后待重试的增量 */
let retry: { upsert: Record<string, any[]>; remove: Record<string, string[]> } | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null

type Listener = (s: SyncState) => void
export interface SyncState {
  online: boolean
  pushing: boolean
  lastPushAt: number
  lastPullAt: number
  error: string | null
  /** 最近一次被服务端拒绝的写入，UI 要如实告诉用户 */
  rejected: { entity: string; id: string; reason: string }[]
}
export const state: SyncState = {
  online: false, pushing: false, lastPushAt: 0, lastPullAt: 0, error: null, rejected: [],
}

const listeners = new Set<Listener>()
export const onSyncState = (fn: Listener) => { listeners.add(fn); return () => listeners.delete(fn) }

/**
 * 必须给监听者一个**新对象**。
 *
 * 之前这里传的是 `state` 本身，而 `state` 是被**原地修改**的。
 * 于是 `SyncStatus` 里的 `useState<SyncState>(syncState)` 拿到的
 * 初值和每次收到的都是**同一个引用** —— `setS(state)` 遇到
 * `Object.is` 相等的值，React 直接 bail out，**根本不重渲染**。
 *
 * 后果：「N 处修改没有保存」「已离线」「同步异常」这三个告警
 * 只能靠**父组件偶然重渲染**才顺带显示出来。实测：服务端明明以
 * 「文档已被他人锁定」拒了写入、内容确实没存上，而顶栏**一次都没出现过**。
 *
 * 内部逻辑读 `state.x` 不受影响（它要的就是就地更新），
 * 只有 React 那边需要新引用。
 */
function emit(patch: Partial<SyncState>) {
  Object.assign(state, patch)
  for (const fn of listeners) fn({ ...state })
}

/* ============================================================
   差分
   ------------------------------------------------------------
   为什么要差分而不是「把整个 AppData 推上去」：
   一来流量大（正文几十 KB），二来会把**别人的**改动整片覆盖掉。
   差分保证「我只推我真正改过的那几行」。
   ============================================================ */

/**
 * 这些实体是「挂在某个父键下」的行，摊平时必须把父键一起带上。
 *
 * 服务端给的行带 `bookId` / `docId` / `commentId`，而前端 store 里存的是
 * Record<父键, 行[]>，行本身**没有**那个父键。差分时两边形状不一致 →
 * 每次都判定「变了」→ 每次都重推 → 普通成员推不动 →
 * 顶栏常驻一条「N 处修改没有保存」，而他其实什么都没改。
 *
 * 假告警比没有告警更糟：人会开始无视所有告警。
 */
const PARENT_KEY: Record<string, string> = {
  comments: 'docId',
  selectionComments: 'docId',
  bookMembers: 'bookId',
}

function toRows(key: string, value: any): any[] {
  const shape = SHAPE[key]
  if (shape === 'array') return Array.isArray(value) ? value.map((r) => withServerPk(key, r)) : []
  if (shape === 'record') {
    return Object.entries(value || {}).map(([k, v]) =>
      withServerPk(key, { ...(v as any), [key === 'bookSettings' ? 'bookId' : 'id']: k }),
    )
  }
  if (shape === 'recordOfArray') {
    // 评论类：Record<docId, Comment[]>，服务端按行存，行的主键是评论自己的 id。
    // 必须用 entries —— values 会把父键丢掉，那样每一行都没有 docId，
    // 差分永远对不上（见上面 PARENT_KEY 的说明）。
    const parentKey = PARENT_KEY[key] || 'docId'
    const out: any[] = []
    for (const [parentId, list] of Object.entries(value || {})) {
      for (const item of (list as any[]) || []) {
        out.push(withServerPk(key, { ...item, [parentKey]: item[parentKey] ?? parentId }))
      }
    }
    return out
  }
  return []
}

/** 摊平：把嵌套的 replies 抽成独立的行，并从父对象上摘掉 */
function extractReplies(replyKey: string, rows: any[]): any[] {
  const cfg = REPLY_OF[replyKey]
  const out: any[] = []
  for (const r of rows) {
    const nested = r.replies
    if (!Array.isArray(nested) || !nested.length) continue
    for (const rep of nested) {
      // 一定要把 reply 自己的 replies 摘掉：它在前端是个空数组占位，
      // 而服务端基准里没有这一列。留着它，stable() 每次都比不相等 ——
      // 结果是每次改别的东西都要把所有回复重推一遍（写放大）。
      const { replies: _drop, ...rest } = rep
      out.push({ ...rest, [cfg.fk]: r.id, docId: r.docId })
    }
  }
  return out
}

/**
 * 摊平历史版本。
 *
 * 和评论回复是同一个坑：versions 嵌套在 doc 里，而 docs 表没有这一列，
 * 不单独推就等于「历史版本只活在这个浏览器里」——
 * 同事换台设备打开，误删了东西连回滚的机会都没有。
 */
function extractVersions(rows: any[]): any[] {
  const out: any[] = []
  for (const d of rows) {
    if (!Array.isArray(d.versions) || !d.versions.length) continue
    for (const v of d.versions) {
      const { at: _at, ...rest } = v
      out.push({ ...rest, docId: d.id, at: v.at ?? v.createdAt ?? 0 })
    }
  }
  return out
}

/**
 * 前端对象的主键字段名与服务端列名不一致的实体。
 *
 * bookMembers 在前端用 `id` 存 userId，服务端的列叫 `userId`，
 * 而复合主键是 (bookId, userId) —— 少一列，服务端就判「缺少主键」，
 * **整行静默丢弃**，不报错也不回滚。
 *
 * 表现是：在界面上把某人加进知识库、或改他的角色和权限，
 * 点完看着对了，刷新就没了，换台设备也没有。
 * 服务端其实一直在回 `rejected: [{reason:'缺少主键'}]`，只是没人看。
 */
const PK_ALIAS: Record<string, string> = { bookMembers: 'userId' }

/** 复合主键的实体：行键必须带上父键，否则不同知识库里的同一个人会撞成一行 */
const COMPOSITE_ENTITIES = new Set(['bookMembers'])

/** 补上服务端主键列。返回新对象，不改原对象。 */
function withServerPk(key: string, row: any): any {
  const col = PK_ALIAS[key]
  if (!col || row == null || typeof row !== 'object') return row
  if (row[col] == null && row.id != null) return { ...row, [col]: String(row.id) }
  return row
}

const rowKey = (key: string, r: any): string => {
  if (key === 'bookSettings') return String(r.bookId)
  if (key === 'recents' || key === 'trash') return String(r.docId)
  // 复合主键：光用 id（= userId）会把 A 库里那行和 B 库里那行当成同一行，
  // 于是 B 库的改动被判成「没变」而丢掉，A 库的改动却可能被推到 B 库去
  if (COMPOSITE_ENTITIES.has(key)) return `${r.bookId}::${r[PK_ALIAS[key]] ?? r.id}`
  return String(r.id)
}

/**
 * 这份文稿的正文是否已经加载到本地。
 *
 * 轻量 bootstrap 之后，绝大多数文稿只有元信息、没有 blocks。
 * 这种行**绝不能**参与推送 —— 它带着一份「空的 blocks」，
 * 差分看过去就是「正文被清空了」，会直接抹掉服务端的内容。
 * 整个轻量化方案成立与否，全靠这一条守住。
 */
const isDocLoaded = (r: any): boolean => Array.isArray(r?.blocks) && r._loaded === true

/**
 * 稳定序列化：只比较**业务字段**。
 *
 * 两个必须排除的键：
 * - `_rev`：服务端版本号，同步协议内部用
 * - `_loaded`：客户端自己标的「正文已加载」，服务端根本不知道有这个字段
 *
 * `_loaded` 漏掉的后果特别隐蔽：本地行比基准行多一个键，
 * 于是**每一篇文稿每次打开页面都被判定为「变了」并推上去**。
 * 有编辑权的人推得动，看不出异常；只读成员推不动，
 * 顶栏就常驻一条「N 处修改没有保存」—— 而他其实什么都没改。
 * 假告警比没有告警更糟：人会开始无视所有告警。
 */
const COMPARE_IGNORE = new Set(['_rev', '_loaded'])

function stable(v: any): string {
  if (v === null || v === undefined) return ''
  if (typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']'
  const keys = Object.keys(v)
    .filter((k) => !COMPARE_IGNORE.has(k) && v[k] !== undefined)
    .sort()
  return '{' + keys.map((k) => `${k}:${stable(v[k])}`).join(',') + '}'
}

/**
 * 取「可比形状」。
 *
 * 轻量启动之后，没打开过的文稿只有元信息、**根本没有 blocks 这个键**。
 * 直接拿它和基准（带正文）比，`stable()` 每次都不相等 ——
 * 于是改任何别的东西都会把所有没打开过的文稿重推一遍（写放大）。
 *
 * 所以：本地没有正文时，只比元信息。
 * 这样改标题、改目录这类操作**照常同步**，
 * 而服务端 upsert 是字段级合并（`{...existing, ...incoming}`），
 * 客户端没带 blocks 字段 = 服务端的正文原样保留，不需要额外保护。
 */
/**
 * 文稿参与差分的字段白名单。
 *
 * 用白名单而不是黑名单，是因为本地这一侧会多出一些服务端不认的字段：
 * `_loaded`（正文是否已加载）、`versions`（嵌套的历史版本，单独同步）、
 * `replies`（嵌套的评论），以及各种 UI 态。
 * 只要多一个键，差分就判「变了」→ 整篇被推上去 →
 * 只读成员推不动 → 顶栏常驻「N 处修改没有保存」，而他其实什么都没改。
 *
 * 之前是逐个把字段加进黑名单（`_rev`、`_loaded`、去掉 `versions`……），
 * 每加一个都要重新验一轮，而漏掉的那个只会表现为「偶尔有一条假告警」，
 * 极难定位。白名单一次把这类问题关掉。
 *
 * ============================================================
 * **`sheetData` 刻意不在这里**（而且 `comparable()` 也不特判它）
 * ------------------------------------------------------------
 * 加进去**看起来**像「让工作表的改动参与同步」，实际后果是
 * **给只读成员造一条他根本没做的告警**：他只是打开着同一张表，
 * 而表的数据由别人改过，`sheetData` 一参与比较就会被判「本地变了」。
 *
 * 而工作表的改动**照样推得上去** —— 靠的不是它参与比较，
 * 是 `updatedAt`：它在白名单里，而任何 `updateDoc` 都会改它。
 * 实测过：改一篇工作表文档的 sheetData，服务端确实收到了，刷新也没丢。
 *
 * 写在这里而不是只写在 `setDocSheetRemote` 的注释里：
 * 那条注释曾经白纸黑字说「sheetData 就在白名单里」——
 * **说错了，而且会把人引向一个正好引入 bug 的「修复」**。
 * 理由错比结论错更危险。
 * ============================================================
 * **`likes` 与 `pinnedAt` 也要参与比较，但走的是另一条路（2026-10-12 修）**
 * ------------------------------------------------------------
 * 这两个字段以前**不在**比较里，于是「点一下赞」「点一下置顶」
 * 在服务端**从来没有落过库** —— 实测：本地 likes=["u_admin"]，
 * 服务端 likes=[]，而且**不报错、不提示**，刷新就没了。
 *
 * 和 sheetData 相反的是：那两个动作走的是 `toggleDocLike`，
 * **它不碰 `updatedAt`**（点赞不是一次编辑，把「更新时间」改成
 * 点赞时间会让「最近更新」列表说谎）。所以「靠 updatedAt 带一把」
 * 那条路在这里根本不存在，只能让字段自己参与比较。
 *
 * ⚠️ 两个都必须**在 comparable 里归一**，不能靠 `if (f in r)` 带过：
 *   · 本地新建的文档**没有** `pinnedAt` 这个键（undefined），
 *     服务端下发的是 `null`（见 entities.ts 的 DOC_SHAPE）；
 *     `in` 的写法会跳过缺失的键 → 两边可比形状的**键集合不同**
 *     → `stable()` 恒不相等 → 每一篇文稿每次打开页面都被重推一遍。
 *     那正是本文件开头警告的「写放大」，而且症状和 sheetData 那次一模一样。
 *   · `likes` 是数组，`stable()` 按下标比 —— `["u1","u2"]` 和
 *     `["u2","u1"]` 是同一批人却会被判为不同。所以要排序。
 *
 * 下面 `DOC_COMPARE_FIELDS` 里**没有**这两个字段（那是另一条路的清单），
 * 它们在 `comparable()` 里被无条件写进可比形状 —— 理由紧跟其后。
 * ============================================================ */
const DOC_COMPARE_FIELDS = [
  'id', 'type', 'title', 'body', 'authorId', 'createdAt', 'updatedAt',
  'wordCount', 'visibility', 'published', 'tags', 'lock', 'bookId', 'spaceId',
]

/**
 * 这两个字段**不走**上面的白名单循环，而是无条件写进可比形状。
 * 理由见上面那段注释：键集合必须两端一致，否则等于给每一篇文稿
 * 造一条「本地有、服务端没有」的假差异（写放大）。
 */
function comparable(key: string, r: any): any {
  if (key !== 'docs') return r
  if (r == null) return r
  const out: any = {}
  for (const f of DOC_COMPARE_FIELDS) if (f in r) out[f] = r[f]
  // 正文单独处理：**两边都有才比**。
  // 少一个 blocks 就判为不同，等于「打开一次文档就重推一次正文」；
  // 而「本地没有正文、基准有」只可能发生在正文正在加载的那一瞬间，
  // 那个竞态由 ensureDocLoaded 里「先对齐基准再落 store」的顺序解决。
  if (Array.isArray(r.blocks)) out.blocks = r.blocks
  // 赞过的人：按**集合**比，与点序无关（否则 ["u1","u2"] 与 ["u2","u1"] 被判为不同）
  out.likes = Array.isArray(r.likes) ? [...r.likes].sort() : []
  // 置顶时刻：0 / null / undefined 一律归成 null
  out.pinnedAt = Number(r.pinnedAt) || null
  return out
}

/**
 * 诊断用：把某实体「本地 vs 基准」按 comparable() 的口径并排打出来。
 *
 * 为什么留着：有个已定位到一半的缺陷（只读成员收到假告警）就卡在
 * 「两边到底哪个字段不等」这一步，而这个函数就是答案。
 * 配合 `window.__yqDebugCompare` 可以在浏览器里直接问：
 *   __yqDebugCompare('docs', docId) → { diffKeys, localKeys, baseKeys }
 *
 * 只读，不改任何状态。
 */
export function __debugCompare(key: string, id: string) {
  const s = useStore.getState() as any
  const next = (s[key] && typeof s[key] === 'object' && !Array.isArray(s[key])) ? s[key][id] : undefined
  const prev = (baseline[key] || []).find((r: any) => rowKey(key, r) === id)
  const a = comparable(key, next), b = comparable(key, prev)
  const diffKeys: string[] = []
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) diffKeys.push(k)
  }
  return { localKeys: Object.keys(next || {}), baseKeys: Object.keys(prev || {}), diffKeys, a, b }
}

/**
 * 诊断用：docs 差分「判定为不同」的**全部**记录。
 *
 * 之前只记第一条 —— 而访客页的生命周期里可能早就有过无关的差分，
 * 记下来的那一对未必是关键时刻的。改成记全部 + 可重置，
 * 才能看清「基准掉队」发生在拉取之前还是之后。
 *
 * 只读，不影响 diff 的任何行为。数量有上限，免得长期运行把内存吃满。
 */
const DIFF_PROBE_MAX = 50
let diffProbes: { id: string; changed: string[]; base: any; local: any }[] = []
export function __diffProbe() { return diffProbes }
export function __resetDiffProbe() { diffProbes = [] }

function diff(key: string, next: any[], prev: any[]) {
  const prevMap = new Map(prev.map((r) => [rowKey(key, r), r]))
  const nextMap = new Map(next.map((r) => [rowKey(key, r), r]))

  const upsert: any[] = []
  for (const [k, r] of nextMap) {
    const old = prevMap.get(k)
    if (!old || stable(comparable(key, old)) !== stable(comparable(key, r))) {
      if (key === 'docs' && diffProbes.length < DIFF_PROBE_MAX) {
        const a = comparable(key, old), b = comparable(key, r)
        const changed = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])]
          .filter((f) => JSON.stringify(a?.[f]) !== JSON.stringify(b?.[f]))
        diffProbes.push({ id: k, changed, base: a, local: b })
      }
      upsert.push(r)
    }
  }
  const remove: string[] = []
  for (const k of prevMap.keys()) if (!nextMap.has(k)) remove.push(k)

  return { upsert, remove }
}

/* ============================================================
   拉取：启动时整包
   ============================================================ */

/**
 * 用服务端的整包数据覆盖本地状态。
 * @param currentUser 当前登录的人。必须由调用方传 —— 服务端返回的
 *        成员名册里没有「谁是我」这个信息，取列表第一个会让所有人
 *        都变成同一个人（「切换身份」和协作署名全都会错）。
 */
export async function hydrate(currentUser?: { id: string; name: string; account: string; avatar?: string; role?: string } | null): Promise<boolean> {
  if (getMode() !== 'server') return false
  // lite：只要元信息，正文按需拉。
  const { data, seq: s } = await apiBootstrap()
  seq = s

  /**
   * 先做一次**归一化**，再拿去填 store 和基准。
   *
   * 顺序很重要：早先基准直接取服务端原始行、store 取归一化后的行，
   * 两边形状不一致（原始行没有 `id`），于是每次差分都判定「变了」，
   * 每次都重推全部成员关系。普通成员推不动，
   * 顶栏从此常驻一条「N 处修改没有保存」，而他其实什么都没改。
   *
   * 假告警比没有告警更糟 —— 人会开始无视所有告警。
   */
  if (Array.isArray(data.bookMembers)) {
    data.bookMembers = data.bookMembers.map((r: any) => ({ ...r, id: r.id ?? r.userId }))
  }

  // 记录基准：之后所有差分都拿它当「服务端的样子」
  baseline = {}
  for (const key of PUSHABLE) baseline[key] = data[key] || []

  const appData = serverDataToAppData(data)
  hydrated = true
  // 标出「正文未加载」。轻量 bootstrap 里没有 blocks，
  // 不显式标记的话，差分会把「本地没有正文」当成「正文被清空」。
  const docs = (appData as any).docs || {}
  for (const d of Object.values<any>(docs)) d._loaded = false
  // 把摊平的历史版本挂回各篇文档。
  // 服务端是版本的唯一权威：本地那份可能因为任何一次状态替换而丢过，
  // 每次启动都重新以服务端为准，不做合并。
  nestVersions(docs, data.docVersions || [])

  const me = currentUser || undefined
  useStore.getState().hydrate(appData as Partial<AppData>, {
    currentUser: me
      ? ({
        id: me.id,
        name: me.name,
        account: me.account,
        avatar: me.avatar || '',
        // 角色要**用服务端给的那个**。
        //
        // 这里原来写死 'member'，于是服务端模式下登录的是管理员也显示成普通成员 ——
        // 所有按角色显隐的管理界面（管理员入口、离职办理…）会**静默消失**，
        // 而页面上看不出任何异常。
        //
        // 这不影响安全性：真正的判定全在服务端（capsInBook / denyReason），
        // 这里只决定「界面上要不要给你那个按钮」。但把服务端已经告诉我们的
        // 真相丢掉，换成一个假的，是纯亏。
        role: (me.role as Member['role']) || 'member',
      } as Member)
      : undefined,
  })
  hydrated = true
  /*
   * ⚠️ hydrate 之后**必须再拉一次协作邀请**。
   *
   * 上面那次 `hydrate(appData)` 是用**服务端 bootstrap 的数据整体重建 store**，
   * 而 `bookInvites` 不在 bootstrap 里（它是走 `/api/invites` 单独拉的），
   * 于是它被重置成 `[]` —— 而且是在登录流程里被清掉的，
   * 紧接着 AppGate 挂的那句 `refreshBookInvites()` 拉到数据、commit 进去，
   * **如果顺序反过来就会被吃掉**。
   *
   * 实测症状（看着像「接口对了但界面不显示」）：
   *   · 服务端 `GET /api/invites` 返回正确（200，数据齐全）
   *   · 浏览器 store 里 `bookInvites` 却是 `[]`
   *   · 手动再调一次 `refreshBookInvites()` 仍然是 0
   *
   * 放在 hydrate 之后、返回之前 —— 任何一次 hydrate 都会重新拉，
   * 于是**不管谁在什么顺序上调用 hydrate，待办都不会丢**。
   * 这比依赖调用方的顺序可靠：顺序依赖的写法，漏一个调用点就静默失效。
   */
  try {
    await useStore.getState().refreshBookInvites()
  } catch {
    // 拉不到不影响登录 —— 顶栏红点晚几秒亮比进不去应用好得多
  }
  emit({ online: true, error: null })
  return true
}

/* ============================================================
   按需加载正文
   ============================================================ */

const loadingDocs = new Map<string, Promise<void>>()

/**
 * 确保这篇文稿的正文在本地。
 * 已加载 / 正在加载 / 本地模式 —— 都直接返回。
 *
 * 并发的重复请求会合并成一个：目录树与最近编辑表可能同时点开同一篇，
 * 没有这道合并就会打两次请求（更糟的是两次 applyRemote 互相覆盖）。
 */
export function ensureDocLoaded(docId: string): Promise<void> {
  if (!docId) return Promise.resolve()
  const cur = useStore.getState().docs[docId]
  if (cur && isDocLoaded(cur)) return Promise.resolve()
  /*
   * ⚠️ 在回收站里的文稿**不许再拉回来**（2026-10-15 修）。
   *
   * 症状：删掉一篇文档后，它同时出现在 `docs` 和 `trash` 里，且**永不自愈**。
   *
   * 这条路和增量那条是两回事 —— 增量那边已经按 trash 过滤了，
   * 而这里是被**文档页自己**叫起来的：`deleteDoc` 之后 `docs[docId]` 变成 undefined，
   * DocPage 里那个 `ensureDocLoaded` 的 effect 于是重跑，
   * 又去 `GET /api/doc/:id` 把正文拉了回来 ——
   * 而那一刻服务端**还没收到**删除请求，于是「删除」被原地撤销。
   *
   * 用户看不到任何异常（树上那个节点是 hidden 的），
   * 但一篇他以为删掉的文稿，**正文一直留在本地存储里**，
   * 客户端搜索也会把它搜出来。内网知识库不能接受这个。
   *
   * 判据用现成的权威：**回收站里有这篇，就是它已被删**。
   * 还原会清掉那行 trash，所以不影响正常还原。
   */
  if (useStore.getState().trash.some((t) => String(t.docId) === String(docId))) return Promise.resolve()
  if (getMode() !== 'server' || !isAuthed()) return Promise.resolve()

  const inflight = loadingDocs.get(docId)
  if (inflight) return inflight

  const p = (async () => {
    try {
      const res = await api.get<{ doc: any }>(`/api/doc/${encodeURIComponent(docId)}`)
      const doc = res.doc
      if (!doc) return
      // 正文必须是数组。曾经服务端把 {blocks,title} 整个当正文存了回来，
      // 于是 Array.isArray 为 false、编辑器拿到非数组直接白屏。
      // 这里再挡一道：宁可停在骨架态，也不要把坏数据写进 store。
      if (!Array.isArray(doc.blocks)) {
        console.error('[sync] 文稿正文格式异常，已忽略', docId, typeof doc.blocks)
        return
      }
      // 手动保存？→ 真正的自动存档会自己带版本快照，这里不要多此一举。
      doc._loaded = true
      /**
       * 版本要**合并**而不是整行覆盖。
       * `/api/doc/:id` 返回的是「正文 + 元信息」，不带 versions
       * （版本在另一个实体里）。直接覆盖等于每拉一次正文就把本地历史版本清空一次。
       */
      const cur = useStore.getState().docs[docId]
      if (Array.isArray(cur?.versions) && !Array.isArray(doc.versions)) doc.versions = cur.versions

      /**
       * 顺序要紧：**先对齐基准，再落 store**。
       *
       * 反过来会出竞态：文档页挂载时会 `addDocVersion('打开文档')`，
       * 而那一刻正文可能正在拉取中。若先 applyRemote 再补基准，
       * 中间任何一次 commit 触发的差分都会看到「本地有正文、基准没有」，
       * 于是把这篇正文当改动推上去。
       * 有编辑权的人推得动，看不出异常；只读成员推不动，
       * 顶栏就常驻一条「N 处修改没有保存」—— 而他其实什么都没改。
       */
      baseline.docs = mergeRows(baseline.docs || [], [doc])
      useStore.getState().applyRemote({ docs: { ...useStore.getState().docs, [docId]: doc } })
    } catch (e: any) {
      // 拉不到正文不是致命错误：目录、标题这些仍然可用，
      // 页面会停在骨架态而不是把文档误判成「不存在」。
      console.warn('[sync] 文稿正文加载失败', docId, e?.message)
    } finally {
      loadingDocs.delete(docId)
    }
  })()

  loadingDocs.set(docId, p)
  return p
}

/* ============================================================
   推送：本地每次落盘时调用
   ============================================================ */

let pushTimer: ReturnType<typeof setTimeout> | null = null
let pending: { upsert: Record<string, any[]>; remove: Record<string, string[]> } = { upsert: {}, remove: {} }

/**
 * 挂到 store 的 persist() 旁边。
 * @param data 这一轮待落盘的完整 AppData
 */
export function onLocalChange(data: Partial<AppData>) {
  if (getMode() !== 'server' || !isAuthed()) return
  // hydrate 还没跑完时基准是空的，此时任何差分都会把「全部内容」当成改动推上去。
  // 从 clearLocalSnapshot()（清空）到 hydrate()（灌入）之间有一次网络往返，
  // 组件会在这段时间挂载并 commit —— 所以这里必须挡住。
  if (!hydrated) return

  for (const key of PUSHABLE) {
    /**
     * 这两个实体必须跳过通用差分。
     *
     * 它们在 SHAPE 里（要参与同步），但 store 里**没有**同名的顶层字段 ——
     * docVersions 嵌在 doc.versions 里，commentReplies 嵌在 comment.replies 里。
     * 通用循环拿 `toRows(key, undefined)` 得到空数组，
     * 再和「服务端确实有这些行」的基准一比，得出结论：**全删**。
     *
     * 实测：打开一次应用（登录 → hydrate → 第一次推送），
     * 服务端所有评论回复就被清空了，界面上毫无异常 —— 别人回复的内容凭空消失。
     * 差分算出来的 remove 服务端照删，因为那在协议上完全合法。
     *
     * 它们各自的正确通路在下面：
     *   · 版本 → docs 分支里 extractVersions，只推新增、永不推删除
     *   · 回复 → comments/selectionComments 分支里 extractReplies 摊平后做差分
     * 少一个「这里为什么必须跳过」，承诺就等于不存在。
     */
    if (key === 'docVersions' || key === 'commentReplies' || key === 'selectionCommentReplies') continue

    const next = toRows(key, (data as any)[key])

    // 嵌套型实体：回复要单独摊平出来做差分。
    // 注意父对象本身**不能**带上 replies 一起推 —— 服务端评论表没有这一列，
    // 带了会被忽略，而真正的问题是没有单独推这份数据。
    if (key === 'comments' || key === 'selectionComments') {
      const replyKey = key === 'comments' ? 'commentReplies' : 'selectionCommentReplies'
      const flat = extractReplies(replyKey, next)
      const { upsert, remove } = diff(replyKey, flat, baseline[replyKey] || [])
      if (upsert.length) (pending.upsert[replyKey] ||= []).push(...upsert)
      if (remove.length) (pending.remove[replyKey] ||= []).push(...remove)
    }

    const stripped = next.map((r) => {
      if (r.replies === undefined && r.versions === undefined) return r
      const { replies, versions, ...rest } = r
      return rest
    })

    // 历史版本也是嵌套的，要单独摊平推上去
    if (key === 'docs') {
      /**
       * 只推新增，**永不推删除**。
       *
       * 版本历史是知识库的保险丝：误删了文档还能回滚。
       * 而客户端的版本列表可能因为任何一次状态替换而短暂变空
       * （doc 被整行覆盖、re-hydrate、增量回包…），
       * 那一刻算出来的 remove 会把服务端的存档整片抹掉 ——
       * 而且是自我强化的：抹掉后其他端的基准也跟着空，下一轮继续抹。
       *
       * 所以这里刻意不做删除。版本只在两种情况下消失：
       * 整篇文档被删（服务端级联），或超过保留上限被裁剪。
       * 这两种都不需要客户端来宣布。
       */
      const loaded = next.filter((r) => Array.isArray(r.blocks))
      const vers = extractVersions(loaded)
      if (vers.length) {
        const { upsert: vu } = diff('docVersions', vers, baseline.docVersions || [])
        if (vu.length) (pending.upsert.docVersions ||= []).push(...vu)
      }
    }

    /**
     * 文稿的 remove **必须用全量算**。
     *
     * 踩过：2026 篇的库跑完一轮剩 0 篇。
     * 当时我写了「未加载的文稿不参与推送」这条保护，
     * 结果它们在「本地现状」里消失了，差分得出「它们被删了」，全库清空。
     * 界面上完全看不出异常，因为「删除」本来就是合法操作。
     *
     * upsert 侧不需要特殊保护：客户端没带 blocks 字段，
     * 服务端的字段级合并会原样保留正文。
     */
    const { upsert, remove } = diff(key, stripped, baseline[key] || [])
    if (upsert.length) (pending.upsert[key] ||= []).push(...upsert)
    /*
     * 空间的删除**永远不由客户端宣布**（2026-10-16 加）。
     *
     * 成因实测过：删空间的界面动作只是「把这个空间从本地 store 里摘掉」，
     * 而下一轮通用差分看到「基准里有、现状里没有」→
     * 算出一条 remove → 推上去 → **服务端照删**。
     * 于是「24 小时可撤销」被客户端的推送整条旁路掉：
     * 点「撤销」得到的是 404「空间不存在」。
     *
     * 这和上面 `docVersions` 那条是同一个机制：
     * 差分算出来的 remove 在协议上**完全合法**，所以错得毫无症状。
     *
     * 所以空间的删除只认服务端那一条通路
     * （`DELETE /api/spaces/:id` → 写 `deletedAt` → 24 小时窗口）。
     * 客户端这边只推 upsert（改名、改头像、改简介都照常同步）。
     */
    if (key !== 'spaces' && remove.length) (pending.remove[key] ||= []).push(...remove)
  }
  if (!Object.keys(pending.upsert).length && !Object.keys(pending.remove).length) return

  // 与本地落盘同一档防抖：本地写盘是 400ms，联网再快也没有意义
  if (pushTimer) clearTimeout(pushTimer)
  pushTimer = setTimeout(flush, 400)
}

export async function flush(): Promise<void> {
  if (getMode() !== 'server' || !isAuthed()) return
  /*
   * ⚠️⚠️ 这里原来只有一句 `if (pushing) return`，而那一行会**静默丢数据**。
   *
   * 实测症状（2026-10-10 在真实部署实例上撞到）：
   * 把文档标题敲成「部署第一天」，重启后**文档标题对、目录树标题停在「部署第一」**。
   * 查服务端两行分叉的原因就是这个：
   *
   *   1. 连着打字时，防抖到点的 `flush()` 撞上「上一轮推送还在飞」→ 直接 return；
   *   2. `pending` 里那批行**没有排下一次**（`finally` 只做了 `pushing = false`）；
   *   3. 于是它们一直躺在 `pending` 里，**要等下一次本地改动才会被推走** ——
   *      而用户改完就停手了。
   *
   * 所以「最后那一改」在服务端就是没有的：本地 localStorage 有（那是同步写的），
   * 别人看不到、刷新后自己也看不到。而 `pagehide` 的兜底 `flush()`
   * **恰恰在最需要它的时刻失效** —— 页面正在关闭，上一次推送几乎必然还在飞。
   *
   * 现在两处都补：撞上在飞的推送时排一次补推；推送结束时若还有待推的立刻续上。
   */
  if (pushing) {
    if (!pushTimer) pushTimer = setTimeout(() => { pushTimer = null; flush() }, 400)
    return
  }
  if (!Object.keys(pending.upsert).length && !Object.keys(pending.remove).length && !retry) return

  const batch = retry || pending
  if (retry) { pending = { upsert: {}, remove: {} } }
  else pending = { upsert: {}, remove: {} }

  pushing = true
  emit({ pushing: true })
  try {
    const res = await pushChanges(batch.upsert, batch.remove)

    // 被拒的行要回滚基准，否则下次差分还会再推一遍同样的非法写入
    const rejectedKeys = new Set(res.rejected.map((r) => `${r.entity}:${r.id}`))
    for (const [entity, rows] of Object.entries(batch.upsert)) {
      const ok = rows.filter((r) => !rejectedKeys.has(`${entity}:${rowKey(entity, r)}`))
      baseline[entity] = mergeRows(baseline[entity] || [], ok, entity)
    }

    emit({ lastPushAt: Date.now(), online: true, error: null, rejected: res.rejected })
    seq = Math.max(seq, res.seq)
    retry = null
  } catch (e: any) {
    // 网络抖动不是丢数据的理由：合并进 retry，等下轮一起重试
    mergeInto(retry, batch)
    emit({ online: false, error: e?.message || '同步失败' })
    if (!retryTimer) {
      retryTimer = setTimeout(() => { retryTimer = null; flush() }, 5000)
    }
  } finally {
    pushing = false
    emit({ pushing: false })
    /*
     * 这一次推送的**飞行期间**又攒下的增量（`pending`）必须续上。
     * 少了这一句，它们就只等下一次本地改动 —— 而用户改完就停手了。
     */
    if (!pushTimer && (Object.keys(pending.upsert).length || Object.keys(pending.remove).length || retry)) {
      pushTimer = setTimeout(() => { pushTimer = null; flush() }, 0)
    }
  }
}

function mergeRows(base: any[], incoming: any[], key = '') {
  // 必须传实体名：复合主键的实体（bookMembers）行键要带父键，
  // 不传就退化成 String(r.id)，同一个人在两个知识库里的行会互相覆盖
  const m = new Map(base.map((r) => [rowKey(key, r), r]))
  for (const r of incoming) m.set(rowKey(key, r), r)
  return [...m.values()]
}

function mergeInto(slot: { upsert: Record<string, any[]>; remove: Record<string, string[]> } | null, batch: typeof pending) {
  if (!slot) return
  for (const [k, v] of Object.entries(batch.upsert)) (slot.upsert[k] ||= []).push(...v)
  for (const [k, v] of Object.entries(batch.remove)) (slot.remove[k] ||= []).push(...v)
}

/* ============================================================
   拉取增量：轮询 + 窗口聚焦
   —— WebSocket 只跑协作消息，实体变更仍走 HTTP 轮询兜底，
      这样即使 WS 被内网代理掐了，数据也不会停在旧版本。
   ============================================================ */

let pollTimer: ReturnType<typeof setInterval> | null = null
/** 正在拉取中。轮询定时器 + 窗口聚焦可能同时叫 poll()，重入会让两个请求
 *  抢同一个 `seq` 游标 —— 以前一次拉取的窗口很短，重入概率低到可以忽略；
 *  加了「续拉」循环之后窗口长了几十倍，就不能靠概率了。 */
let polling = false
/**
 * 一次 poll 最多连续续拉几轮。
 *
 * 服务端每批最多给 2000 条变更。离线久了（比如周末关机的笔记本），
 * 不续拉就得等好几个轮询周期才追得完 —— 那段时间里界面是旧的。
 *
 * **上限不是为了「保险」，而是为了防死循环**：如果服务端一直返回 `more`
 * （它坏了、或者以后有人改了 `more` 的语义），这里没有上限就是一个能把
 * 浏览器挂死的循环。20 轮 × 2000 = 40000 条变更，足够补完任何合理的离线期；
 * 剩下的交给下一个轮询周期，不会丢（游标是对的，`test-seqgap` 钉着）。
 */
const MAX_CATCHUP_ROUNDS = 20

export async function poll(): Promise<void> {
  if (getMode() !== 'server' || !isAuthed()) return
  if (document.visibilityState === 'hidden') return
  if (polling) return
  polling = true
  try {
    for (let round = 0; round < MAX_CATCHUP_ROUNDS; round++) {
      const delta = await pullChanges(seq)
      emit({ online: true, lastPullAt: Date.now(), error: null })
      if (delta.seq === seq && !Object.keys(delta.upsert).length && !Object.keys(delta.remove).length) {
        seq = Math.max(seq, delta.seq)
        return
      }
      applyDelta(delta.upsert, delta.remove)
      seq = Math.max(seq, delta.seq)
      /**
       * 游标已经是对的（服务端报的是「这一批真的扫到哪」），
       * 所以**即使完全无视 `more` 也不会丢数据** —— 剩下的会在下一个轮询周期补上。
       * `more` 只决定「现在补完」还是「等下一轮」。
       */
      if (!delta.more) return
    }
  } catch (e: any) {
    if (e?.status === 401) { emit({ online: false, error: '登录已过期' }); return }
    emit({ online: false, error: e?.message || '同步失败' })
  } finally {
    polling = false
  }
}

/** 把远端增量写进 store（走 hydrate，不 commit，避免回环） */
function applyDelta(upsertIn: Record<string, any[]>, remove: Record<string, string[]>) {
  const store = useStore.getState()
  const patch: any = {}
  // 允许在下面给 upsert 补一个空的 docs（只为把新版本挂上去）
  let upsert = upsertIn

  // 增量按实体名顺序无关，但**回复必须先于父评论落地**：
  // 父评论被整体替换时，未知 id 的回复会被一起抹掉。
  // 所以这里先把回复挂到待用的父对象上，再走原有的合并逻辑。
  const replyRows: Record<string, any[]> = {}
  for (const [key, rows] of Object.entries(upsert)) {
    if (REPLY_OF[key]) { replyRows[key] = rows; baseline[key] = mergeRows(baseline[key] || [], rows, key) }
  }

  // 新增的历史版本同理：它是独立实体，父文档这一轮可能根本没变
  const versionRows = upsert.docVersions || []
  if (versionRows.length) {
    baseline.docVersions = mergeRows(baseline.docVersions || [], versionRows)
    // 版本要挂到本地文档上，所以即便 docs 这一轮没变化也得走一遍
    if (!upsert.docs) upsert = { ...upsert, docs: [] }
  }

  // 要处理的父实体 = 增量里出现的 ∪ **有回复挂上来的**。
  // 只遍历 Object.keys(upsert) 是不够的：「只有一个人回复了」时，
  // 增量里只有 commentReplies、没有 comments，父对象压根不会被碰到，
  // 于是这条回复永远嵌套不进去 —— 服务端明明存好了，界面就是看不见。
  const parentKeys = new Set<string>(Object.keys(upsert))
  for (const [rk, rows] of Object.entries(replyRows)) {
    if (!rows.length) continue
    parentKeys.add(REPLY_OF[rk].parent)
  }

  /**
   * **成员名单变了 → 权限缓存作废。**
   *
   * 权限缓存（`lib/perms.ts` 的 `cache`）整个会话**从不过期** ——
   * `clearPermsCache()` 之前导出了却**一次都没被调用过**。
   * 于是「管理员刚把某人提成编辑者」这件事，在他那边要刷新才看得见：
   * 界面的显隐、store 里的 `bookEditBlocked`，全都还按**旧的**判据走。
   *
   * 方向对谁都不友好：
   *   · 刚被**降**权的：按钮还在 → 点了被服务端拒 → 又是那个修不好的状态；
   *   · 刚被**升**权的：按钮不出现 → 明明现在有权限却做不了事。
   *
   * 而权限是**从服务端问来的**，不是客户端推的 —— 所以它的缓存不能靠
   * 数据推送来失效，只能在「成员的权限可能变了」时显式清掉。
   * 判据用 `bookMembers` 就够：它一变，**所有**知识库对我这个人的判据
   * 都可能跟着变（他可能同时是这个库、另一个库的成员），全清比精确失效更保险，
   * 代价只是下一次 `useBookPerms` 重新问一次。
   */
  /*
   * ⚠️ 判据只用「**这一轮真的推来了 bookMembers 行**」，
   *   不要加「两边数量不一样」这类启发式 ——
   *   本项目的 `bookMembers` 在 store 里按 bookId 键、在基准里按行，
   *   两者长度本来就不相等，那条条件会**恒为真**，
   *   于是每 8 秒清一次缓存、每 8 秒重问一次权限。
   *   守卫看起来在工作，代价是一条看不见的轮询负担。
   */
  if ((upsert.bookMembers || []).length) clearPermsCache()

  for (const key of parentKeys) {
    const rows = upsert[key] || []
    if (REPLY_OF[key]) continue
    // 自己刚推上去的会原样回来，按 _rev 去重
    const incoming = rows.filter((r) => !isEcho(key, r))

    const cfg = REPLY_OF[key === 'comments' ? 'commentReplies' : 'selectionCommentReplies']
    const pendingReplies = replyRows[cfg.replies] || []
    // 三种情况都得处理：正文变了 / 回复到了 / 新版本到了。
    // 少任一条就会出现「服务端明明存好了，界面就是看不见」。
    const wantsVersions = key === 'docs' && versionRows.length > 0
    if (!incoming.length && !pendingReplies.length && !wantsVersions) continue
    baseline[key] = mergeRows(baseline[key] || [], rows, key)

    const shape = SHAPE[key]
    if (shape === 'array') {
      patch[key] = mergeRows((store as any)[key] || [], incoming, key)
    } else if (shape === 'record') {
      patch[key] = { ...(store as any)[key] }
      for (const r of incoming) {
        const k = rowKey(key, r)
        ;(patch[key] as any)[k] = { ...r, [key === 'bookSettings' ? 'bookId' : 'id']: k }
      }
      // 增量里的文稿一定带正文（服务端 changes 流不裁重列），
      // 所以要标成已加载 —— 否则「别人刚好在编辑这篇」反而让它停在骨架态。
      if (key === 'docs') {
        /*
         * ⚠️ 在回收站里的文稿**不能被增量复活**（2026-10-15 修）。
         *
         * 症状：删掉一篇文档后，它**同时**出现在 `docs` 和 `trash` 里，
         * 而且**永远不会自愈**（实测观察 30 秒，零变化）。
         *
         * 成因是一次**游标竞态**，不是合并逻辑写错了（remove 分支是处理 docs 的）：
         *   1. 用户删除 → 本地移除 + 推 remove（服务端把 trashed 置 1 并记一条变更 N）
         *   2. 此刻**正在飞行**的那次轮询，它的响应是在删除生效**之前**算出来的，
         *      于是里面还带着这篇文稿（upsert）
         *   3. 客户端应用它 → 文稿被加回；同时 `seq` 推到了 ≥ N
         *   4. 下一轮从 ≥ N 往后问，**再也不会看到 N** ——
         *      那条「移除」就这么永远丢了
         *
         * 为什么当缺陷处理：树上那个节点是 `hidden` 的，**用户完全看不见**，
         * 于是一篇他以为删掉的文稿，**正文一直留在本地存储里**
         * （客户端搜索也读 `docs`，会把它搜出来）。
         * 对内网知识库来说，「删除」必须真的把本地副本也带走。
         *
         * 修法取的是**已有权威**：回收站里有没有这篇，就是「它已被删」的判据。
         * 还原时本地会清掉那行 trash（`restoreFromTrash`），
         * 之后这篇就能正常落回正文 —— 不需要额外的墓碑集合，也不会互相打架。
         */
        const deleted = new Set(((store as any).trash || []).map((t: any) => String(t.docId)))
        for (const k of Object.keys(patch.docs)) if (deleted.has(String(k))) delete patch.docs[k]
        // 基准里也要摘掉：留着它的话，之后每次本地改动做差分都会算出一次
        // 「这篇被删了」并推上去 —— 服务端那条路是 no-op，但成了**每次都白推一趟**。
        baseline.docs = (baseline.docs || []).filter((r: any) => !deleted.has(String(rowKey('docs', r))))
      }
      if (key === 'docs') {
        for (const k of Object.keys(patch.docs)) {
          const d = patch.docs[k]
          if (Array.isArray(d.blocks)) d._loaded = true
          /**
           * 整行替换会把本地嵌套的 versions 抹掉。
           * 服务端只在「有新版本」时才推 docVersions 出来，
           * 所以别人改一句正文、你这边刚存过一版 —— 收到的是
           * 一份不带 versions 的文档行，直接替换就等于「历史版本被清空了」。
           * 所以：没有新版本时，保留本地那份。
           */
          const prev = (store as any)[key]?.[k]
          if (!Array.isArray(d.versions) && Array.isArray(prev?.versions)) d.versions = prev.versions
        }
        // 把新到的历史版本挂上去
        if (versionRows.length) nestVersions(patch.docs, versionRows)
      }
    } else if (COMPOSITE_ENTITIES.has(key)) {
      /**
       * 复合主键的嵌套型（bookMembers：Record<bookId, BookMember[]>）。
       * 父键是 bookId，不是 docId —— 之前这里写死 r.docId，
       * 于是远端来的成员变更被塞进 `bookMembers[undefined]`，
       * 本地那个库一个成员都没变。管理员在另一台设备上把人移出了，
       * 这边照样看得见。
       */
      const parentKey = PARENT_KEY[key] || 'docId'
      patch[key] = { ...(store as any)[key] }
      for (const r of incoming) {
        const parentId = r[parentKey]
        if (!parentId) continue
        const list = [...((patch[key] as any)[parentId] || [])]
        const i = list.findIndex((x: any) => String(x.id) === String(r[PK_ALIAS[key]] ?? r.id))
        if (i >= 0) list[i] = { ...list[i], ...r, id: r[PK_ALIAS[key]] ?? r.id }
        else list.push({ ...r, id: r[PK_ALIAS[key]] ?? r.id })
        ;(patch[key] as any)[parentId] = list
      }
    } else {
      // 嵌套型（评论）：先把待挂的回复拼进来，再逐条合并父对象
      patch[key] = { ...(store as any)[key] }
      for (const r of incoming) {
        const list = [...((patch[key] as any)[r.docId] || [])]
        const i = list.findIndex((x: any) => x.id === r.id)
        const extra = pendingReplies
          .filter((rep) => rep[cfg.fk] === r.id)
          .map((rep) => ({ ...rep, replies: [] }))
        if (i >= 0) list[i] = { ...list[i], ...r, replies: mergeReplies(list[i].replies, extra) }
        else list.push({ ...r, replies: mergeReplies([], extra) })
        ;(patch[key] as any)[r.docId] = list
      }
      // 父评论这一轮没变，但它的回复变了：按父 id 反查 docId 再补挂
      if (!incoming.length) {
        for (const rep of pendingReplies) {
          const docId = rep.docId
          if (!docId || !patch[key][docId]) continue
          const list = [...patch[key][docId]]
          const i = list.findIndex((c: any) => c.id === rep[cfg.fk])
          if (i < 0) continue
          list[i] = { ...list[i], replies: mergeReplies(list[i].replies, [{ ...rep, replies: [] }]) }
          patch[key][docId] = list
        }
      }
    }
  }

  for (const [key, ids] of Object.entries(remove)) {
    baseline[key] = (baseline[key] || []).filter((r) => !ids.includes(rowKey(key, r)))
    if (REPLY_OF[key]) continue
    // 历史版本的删除只有本端自己造成过（删版本/删文档），远端不会推 remove 过来；
    // 真收到了也要照做，但不能去动 doc.versions —— 那是 docVersions 分支的事
    if (key === 'docVersions') continue
    const shape = SHAPE[key]
    if (shape === 'array') {
      patch[key] = ((store as any)[key] || []).filter((r: any) => !ids.includes(rowKey(key, r)))
    } else if (shape === 'record') {
      const next = { ...(store as any)[key] }
      for (const id of ids) delete next[id]
      patch[key] = next
    } else if (COMPOSITE_ENTITIES.has(key)) {
      /**
       * 复合主键实体的 remove：id 形如 `bookId::userId`。
       *
       * 不能走下面那个「id 就是父键」的通用分支 —— bookMembers 的父键是
       * bookId，拿 `b1::u1` 去 next[id] 里找只会得到 undefined，
       * 真正那一行在 next['b1'] 里纹丝不动：远端把人移出了，本地还留着。
       */
      const next = { ...(store as any)[key] }
      for (const id of ids) {
        const sep = id.indexOf('::')
        if (sep < 0) continue
        const bookId = id.slice(0, sep)
        const userId = id.slice(sep + 2)
        const list = [...(next[bookId] || [])]
        const cleaned = list.filter((x: any) => String(x.id) !== userId)
        if (cleaned.length) next[bookId] = cleaned
        else delete next[bookId]
      }
      patch[key] = next
    } else {
      const cfg = REPLY_OF[key === 'comments' ? 'commentReplies' : 'selectionCommentReplies']
      const next = { ...(store as any)[key] }
      for (const id of ids) {
        const list = [...(next[id] || [])]
        // 评论的 remove 传的是评论 id，不是 docId
        const cleaned = list.filter((x: any) => x.id !== id)
        if (cleaned.length) next[id] = cleaned
        else delete next[id]
      }
      // 父评论没了，挂在它下面的回复也要一起清掉，否则会变成孤儿
      if (cfg) {
        for (const [docId, list] of Object.entries<any>(next)) {
          next[docId] = list.map((c: any) => ids.includes(c.id)
            ? { ...c, replies: (c.replies || []).filter((r: any) => !ids.includes(r.id)) }
            : c)
        }
      }
      patch[key] = next
    }
  }

  if (Object.keys(patch).length) store.applyRemote(patch)

  // 拉回来的行由上面的 upsert 分支补基准（`baseline[key] = mergeRows(...)`）。
  // 这里**不需要**再补一遍：早先以为漏了，加了一段重复实现，
  // 实测对「只读成员看到别人改动后被推出假告警」没有任何改善 ——
  // 说明根因不在这里（真正的线索在 718 行那条
  // 「增量里的文稿一定带正文」的注释：前提若不成立，基准会被替换成残缺行）。
}

/** 回复合并：按 id 覆盖或追加，保留既有顺序 */
function mergeReplies(cur: any[] | undefined, extra: any[]): any[] {
  const out = [...(cur || [])]
  for (const r of extra) {
    const i = out.findIndex((x) => x.id === r.id)
    if (i >= 0) out[i] = { ...out[i], ...r }
    else out.push(r)
  }
  return out
}

/** 把摊平的历史版本挂回 doc.versions（就地改，供 bootstrap 与增量共用） */
function nestVersions(docs: Record<string, any>, rows: any[]) {
  if (!rows.length) return
  const byDoc = new Map<string, any[]>()
  for (const v of rows) {
    const k = String(v.docId ?? '')
    if (!k) continue
    if (!byDoc.has(k)) byDoc.set(k, [])
    byDoc.get(k)!.push(v)
  }
  for (const [docId, list] of byDoc) {
    const d = docs[docId]
    if (!d) continue
    const cur = Array.isArray(d.versions) ? d.versions : []
    const seen = new Set(cur.map((v: any) => v.id))
    d.versions = [...cur, ...list.filter((v) => !seen.has(v.id))]
      .sort((a, b) => (b.at || 0) - (a.at || 0))
  }
}

/**
 * 回声判定：服务端回推的 rev 不大于我基准里已知的，说明是我自己刚写的那份。
 * 之所以要判，是因为正文内容还会走 CRDT 合并，
 * 同一份数据可能既从同步流回来、也从协作广播回来。
 */
function isEcho(key: string, r: any): boolean {
  const known = baseline[key] || []
  const old = known.find((x) => rowKey(key, x) === rowKey(key, r))
  return !!old && Number(r._rev) <= Number((old as any)._rev)
}

/* ============================================================
   生命周期
   ============================================================ */

export function start(): void {
  if (started || getMode() !== 'server') return
  started = true
  // 把「本地每次落盘都通知我」这个能力挂进 store 的写入口
  registerSyncHook(onLocalChange)
  /**
   * 协作落地的远端正文**也要推基准**。
   *
   * 协作文档走 WebSocket / BroadcastChannel，**不经过同步增量**。
   * 于是 `setDocBlocksRemote` 之后：store 是新版本、基准还是旧版本
   * → 下一次差分判「我改的」→ 推上去。
   * 有编辑权的人推得动（只是白推一趟，内容并没有变）；
   * 只读成员推不动 → 顶栏常驻「N 处修改没有保存」，
   * 而他一个字都没改，只是**别人在同一篇文档里动了手**。
   *
   * 触发时机很紧：store 是在 `commit()` 里改的，而 commit 之后就是差分。
   * 所以通知必须发生在**落地之前**（见 store 里 `remoteDocHook?.(...)` 的位置）。
   */
  registerRemoteDocHook((docId, doc) => {
    baseline.docs = mergeRows(baseline.docs || [], [doc], 'docs')
  })
  if (!pollTimer) pollTimer = setInterval(poll, 8000)
  // 切回标签页立刻拉一次：内网办公场景里一天要切几十次标签
  window.addEventListener('focus', poll)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll() })
  // 页面即将关闭前尽量把待推送的补掉
  window.addEventListener('pagehide', () => { flush() })
}

export function stop(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  window.removeEventListener('focus', poll)
  registerSyncHook(null)
  registerRemoteDocHook(null)
  started = false
  hydrated = false
  seq = 0
  baseline = {}
  pending = { upsert: {}, remove: {} }
  retry = null
}

/**
 * ⚠️ 这里原来还有一份 `wsUrl()`，与 `lib/api.ts` 里那份**逐字重复**，
 *    而**全项目没有任何地方 import 它**（协作连接走的是 `collab-transport.ts`，
 *    它 import 的是 `./api` 那一份）。
 *
 * 删掉它的理由不是「重复」本身，而是**它是一个假的修复目标**：
 * 将来要改 WebSocket 地址（比如子路径部署的前缀），改这一份**毫无效果**，
 * 而代码看着完全正常 —— 症状是「改了没用」，排查方向直接被带偏。
 * 这与本项目吃过的那几枪同源：`wsUrl` 那次、回收站 `bookId` 修了
 * `deleteDoc` 漏了 `deleteNode`、演示控件门控修了设置页漏了顶栏。
 */
export const currentUser = (): Member | undefined => useStore.getState().currentUser
