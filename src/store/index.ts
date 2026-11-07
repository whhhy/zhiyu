import { create } from 'zustand'
import { createSeedData } from '@/data/seed'
import { countWordsFromBlocks } from '@/lib/word-count'
import { getMode, createSpaceRemote, deleteSpace as deleteSpaceRemote, restoreSpace as restoreSpaceRemote, updateMyProfile as updateMyProfileApi, inviteToBook, myBookInvites, respondBookInvite, bootstrap, spacePerms } from '@/lib/api'
import { permsForRole, bookCapsSync, spaceCapsSync, primePermsCache, type Caps } from '@/lib/perms'
import type {
  AppData, Block, Book, BookMember, BookSettings, CollabConflict, CollabCursor, Comment, Doc,
  DocSheetData, DocType, DocTemplate, DocVersion, Member, NodeType, Note, SelectionComment,
  TopicReply, TreeNode, BookInvite, Topic } from '@/types'
import { defaultBookSettings, seedBookMembers, seedTemplates, seedSelectionComments } from '@/data/settings'
import { markdownToBlocks } from '@/lib/markdown-to-blocks'
import { blocksToMarkdown } from '@/lib/blocks-markdown'

/* ============================================================
   全局 store —— 内存态 + localStorage 持久化
   ============================================================ */

const STORAGE_KEY = 'yuque-clone-data-v1'

/**
 * 刚被删掉、还处在撤销窗口内的空间行（2026-10-16，照语雀的 24 小时撤销）。
 *
 * 为什么要在客户端留一份：删除时要把这行从列表里摘掉（不然用户还站在
 * 一个已经不存在的空间上），而撤销时要把它**原样**放回去。
 * 自己重新拼一行会漏成员数这类字段 —— 而「侧栏写着 1 个成员、
 * 实际有 6 个」这种不一致，正是这个项目反复在修的那一类。
 *
 * 刻意**不做成持久化**：刷新页面之后这份暂存就没了，
 * 那时撤销入口本来也不该还在（见 Space.tsx 的提示）。
 */
const pendingSpaceRestore = new Map<string, any>()

function load(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as AppData
      if (parsed && parsed.docs && Object.keys(parsed.docs).length) {
        // 老版本存档补齐新字段，避免升级后空白
        parsed.bookSettings = parsed.bookSettings || {}
        parsed.bookMembers = parsed.bookMembers || {}
        parsed.templates = parsed.templates || seedTemplates
        parsed.selectionComments = parsed.selectionComments || {}
        // 光标是实时态，从来不落盘：老存档里的残留直接丢掉，
        // 否则刷新后会挂着一批"幽灵光标"（这些块可能早被改了）
        parsed.cursors = []
        return parsed
      }
    }
  } catch {
    /* 解析失败则用种子 */
  }
  return createSeedData()
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
/** 最近一次待落盘的数据，供「页面即将卸载」时同步补写 */
let pendingData: AppData | null = null
/** 这一轮待落盘数据的起点（算 maxWait 用） */
let pendingSince = 0

/** 本地编辑：400ms 尾随防抖。用户自己敲的东西要尽快上盘。 */
const SAVE_DEBOUNCE_MS = 400
/**
 * 远端合并结果：1200ms 尾随 + 1200ms 上限（debounce with maxWait）。
 *
 * 为什么和本地编辑不是一个档：远端来的内容在**源标签页**已经落过盘
 * （两个标签页共用一份 localStorage），本标签页再写一遍是纯放大 ——
 * 一次就是 40KB+ 的 JSON.stringify，机器一忙就把主线程占满。
 * 但也不能完全不写：把对方的改动并进来之后的**那份合并结果**只在本页内存里，
 * 源标签页一旦关掉就再没人写它了。
 * 所以给它一个更宽的窗口，再用 maxWait 兜底：
 * 「最多每 1.2s 写一次，且最多延后 1.2s」，写盘频率与网络抖动解耦。
 */
const REMOTE_SAVE_DEBOUNCE_MS = 1200
const REMOTE_SAVE_MAX_WAIT_MS = 1200

function writeNow(data: AppData) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    /* 配额溢出：静默失败，不影响使用 */
  }
}

/** 真正落盘（防抖到点 / 页面卸载都走这里） */
function flushPending() {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = null
  const d = pendingData
  pendingData = null
  pendingSince = 0
  if (d) writeNow(d)
}

/**
 * 排一次落盘。
 * maxWait > 0 时是「尾随防抖 + 最长等待」：连续不断的改动也不会把落盘无限推迟。
 */
function persist(data: AppData, delay = SAVE_DEBOUNCE_MS, maxWait = 0) {
  pendingData = data
  const now = Date.now()
  if (!pendingSince) pendingSince = now
  if (saveTimer) clearTimeout(saveTimer)
  const capped = maxWait ? Math.min(delay, Math.max(0, pendingSince + maxWait - now)) : delay
  saveTimer = setTimeout(flushPending, capped)
  // 顺手交给同步器：连着服务端时，这里会差分后推给服务器。
  // 放在这里而不是各个 action 里，是因为 commit() 是全站唯一的写入口 ——
  // 挂一次就覆盖了全部 100 多个 action，不用逐个改。
  notifySync(data)
}

/**
 * 页面即将卸载时立刻补写。
 * 400ms 防抖意味着「刚新建一篇文档就切走/关页」会丢数据 ——
 * 定时器会随页面卸载被清掉，待写的那份永远进不了 localStorage。
 * pagehide 比 beforeunload 更可靠（移动端 / 关闭标签不一定触发 beforeunload）。
 */
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushPending)
  window.addEventListener('beforeunload', flushPending)
  // bfcache 场景：从后退返回时不需要重写，但保证 pending 已清
  window.addEventListener('pageshow', () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    pendingData = null
    pendingSince = 0
  })
}

const uid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/* ============================================================
   服务端同步挂载点
   ------------------------------------------------------------
   这里**不能**直接 import 同步器：sync.ts 需要 useStore，
   而本文件就是 useStore 的定义处，直接 import 会形成循环依赖。
   （循环依赖在 ESM 下不会立刻报错，但会拿到 undefined 的绑定，
     表现是「一进页面就白屏」，很难查。）
   所以这里只留一个注册位，由 sync.ts 在启动时把自己挂上来。
   ============================================================ */

type SyncHook = (data: AppData) => void
let syncHook: SyncHook | null = null

/**
 * 目录树写操作的权限第二道（2026-10-12 补）。
 *
 * 为什么界面之外还要这一道（探针实证，真服务端，reader 角色）：
 * 目录树的菜单以前对**阅读者也全开**，他点「删除」→
 * 本地那一篇真的从树上消失、toast 弹「已移入回收站」→
 * 服务端才拒（`trash` / `nodes`「没有 edit 权限」）→
 * 顶栏常驻「N 处修改没有保存」，**而他自己修不好**。
 *
 * 一句「已删除」换来一个删不掉、也恢复不了的状态，比「点了没反应」糟得多。
 *
 * 界面那一半在 `Tree.tsx`（`useBookPerms` 把菜单关掉）；
 * 这里是第二半：**任何调用方都无从说谎**，包括脚本和以后新增的入口。
 *
 * ⚠️ 边界写清楚：这里判的是「**问过**且**没有**」。
 *   还没问过（caps 为 null）时**不拦** ——
 *   `createDoc` 这类热路径在导入页那种没挂树的地方会一直是 null，
 *   那样会把管理员正常建文档一起拒掉。
 *   剩下的缺口是「任何页面都还没挂树之前脚本直接调」，
 *   而界面上的入口已经关上了，拿这个换掉误拒不划算（详见 `bookCapsSync`）。
 */
function bookEditBlocked(bookId: string | null | undefined): boolean {
  const c = bookCapsSync(bookId)
  return c !== null && !c.edit
}

/**
 * 「建」的同类判据（`createNode` / `createDoc`）。
 *
 * 与 `bookEditBlocked` 唯一的区别是看 `create` 而不是 `edit` ——
 * 服务端 `denyReason` 对建文稿判的就是 `caps.create`，
 * 界面显隐也得跟它一致，不能拿 edit 顶替（虽然本项目的角色表里
 * 有 create 的角色一定也有 edit，但那是**现在的巧合**，不是契约）。
 */
function bookCreateBlocked(bookId: string | null | undefined): boolean {
  const c = bookCapsSync(bookId)
  return c !== null && !c.create
}

/**
 * 「这个库的设置 / 成员」的判据 —— 判的是 **`admin`，不是 `edit`**。
 *
 * 服务端 `server/sync.ts` 把 `bookSettings` 与 `bookMembers` 这两个实体放在一起判：
 * `capsInBook(user, bookId).admin`，拒绝文案是「需要该知识库的管理员权限」。
 * 而 `editor` 的 admin 是 **false** —— 也就是说**编辑者也不能改成员和设置**。
 * 拿 `edit` 顶替会把 editor 放进来，那才是真的开洞子。
 *
 * ⚠️ 这一处是整个产品里**后果最重**的假动作：
 * 实测（探针，visitor / reader / editor 各一轮）这页以前**一个门都没有** ——
 * `BookSettings` 整页没有角色门，路由也不挡，任何成员敲 URL 就进得来，
 * 而「成员与权限」那一节的「添加成员」「邀请」无条件渲染。
 * 于是一个**阅读者**调 `addBookMember(bookId, x, 'admin')`，
 * **界面的成员名单当场多出一个管理员**，服务端一条没改（顶栏挂 4 条）。
 *
 * 边界同样只判「**问过**且**没有**」。
 */
function bookAdminBlocked(bookId: string | null | undefined): boolean {
  const c = bookCapsSync(bookId)
  return c !== null && !c.admin
}

/**
 * 「评论」的同类判据（评论 / 划词评论 / 两个回复实体）。
 *
 * ⚠️ 这里判的是 `caps.comment`，**不是** `edit`（2026-10-12 踩过这个区别）：
 * 服务端 `server/sync.ts` 的 isComment 分支把 comments / selectionComments /
 * commentReplies / selectionCommentReplies 这**四个实体**统一按 `comment` 判，
 * 拿 edit 顶替会把「能评论、不能编辑」的 reader 一起拒掉 ——
 * 而 reader 在角色表里 comment 本来就是 true，他应当能发言。
 *
 * 实测（探针，真服务端，perms 里 comment 显式关掉）：
 * 划词面板对这个人**照常渲染 ✎、点得开**，「回复」「标记解决」也都点得动；
 * 走 `addSelectionComment` store 收下了 → 服务端拒 →
 * 顶栏常驻「N 处修改没有保存」，**而他自己修不好**。
 * 和目录树那一处是同一个病（界面给了服务端不允许的动作）。
 *
 * 边界同样只判「**问过**且**没有**」：caps 还没问回来时不拦，
 * 否则没挂树的页面会把管理员正常发言也拒掉。
 */
/**
 * 「能不能改这一份模板」—— 与 `server/sync.ts` 的 templates 分支**四路对齐**。
 *
 * 服务端那一条是四分叉的：
 *   · `official` —— 只有平台管理员能改（平台 owner 在函数开头早退了，所以只可能是 admin）
 *   · `mine`     —— 新建放行（ownerId 由服务端强制填成本人）；修改按**库里已有的** ownerId 判
 *   · 有 bookId  —— `capsInBook().edit`
 *   · 有 spaceId —— `capsInSpace().edit`
 *
 * ⚠️ 别简化成「一律要 edit」：那会把「建自己的模板」这个正当功能也堵掉
 *（那是「功能没了」而不是「假动作」）。也别简化成「一律放行」：
 * 服务端会拒，而界面看起来建成功了。
 *
 * 边界与别处一致：caps 还没问回来时**不拦**，
 * 剩下的缺口是「脚本绕过」，界面上的入口另有各页的显隐。
 */
function templateBlocked(tpl: { scope?: string; bookId?: string; spaceId?: string; ownerId?: string } | null | undefined): boolean {
  if (!tpl) return true
  const scope = String(tpl.scope || 'official')
  if (scope === 'mine') {
    // 服务端按**库里已有的** ownerId 判，不看推上来什么 —— 这里也一样
    const owner = tpl.ownerId ? String(tpl.ownerId) : ''
    return !!owner && owner !== useStore.getState().currentUser.id
  }
  if (scope === 'official') {
    const r = useStore.getState().currentUser.role
    return r !== 'owner' && r !== 'admin'
  }
  if (tpl.bookId) return bookEditBlocked(tpl.bookId)
  if (tpl.spaceId) {
    const c = spaceCapsSync(tpl.spaceId)
    return c !== null && !c.edit
  }
  return false
}

function commentBlocked(docId: string | null | undefined): boolean {
  const d = docId ? useStore.getState().docs[docId] : null
  const c = bookCapsSync(d?.bookId)
  return c !== null && !c.comment
}

/**
 * 「空间级发言」的判据 —— 讨论区（话题 / 回复）与小记。
 *
 * 服务端 `denyReason` 里 `isSpaceLevel(def.name)` 把 `topics` / `topicReplies` /
 * `notes` 这三张表统一按 **`capsInSpace().comment`** 判，
 * 不是知识库的 `edit`，也不是空间的 `admin`。
 *
 * ⚠️ 以前这三个 action（`createTopic` / `replyToTopic` / `likeNote`）**一个门都没有**。
 * 而这一片是**空间级**的：不是这个知识库的成员，也可以进讨论区 ——
 * 于是「不在这个空间里的人」发一条话题，本地立刻出现、服务端拒，
 * 顶栏挂一条他自己修不好的告警。
 *
 * 语义与 `commentBlocked` 一致：只判「**问过**且**没有**」。
 */
function spaceCommentBlocked(spaceId: string | null | undefined): boolean {
  const c = spaceCapsSync(spaceId)
  return c !== null && !c.comment
}

/** 由 src/lib/sync.ts 在 start() 时调用；传 null 可解绑 */
export const registerSyncHook = (fn: SyncHook | null) => { syncHook = fn }

/**
 * 「应用了远端文稿」的通知（store → sync）。
 *
 * 和 `registerSyncHook` 是反方向：那个是「本地改了」上报，
 * 这个是「**远端**的正文进来了，同步基准该跟着走」。
 *
 * 为什么必须有：协作文档走 WebSocket / BroadcastChannel，
 * **不经过同步增量**。于是协作落地的正文只进了 store，基准还停在旧版本，
 * 下一次差分就把它当成「我改的」推上去 —— 只读成员推不动，
 * 顶栏常驻一条「N 处修改没有保存」，而他其实什么都没改。
 */
type RemoteDocHook = (docId: string, doc: Doc) => void
let remoteDocHook: RemoteDocHook | null = null
export const registerRemoteDocHook = (fn: RemoteDocHook | null) => { remoteDocHook = fn }

const notifySync = (data: AppData) => {
  if (!syncHook) return
  try { syncHook(data) } catch (e) { console.error('[sync] 本地变更上报失败', e) }
}

/**
 * 这段文本像不像 Markdown 源码？用来决定粘贴时要不要转块。
 *
 * （markdownToBlocks 本身在 `@/lib/markdown-to-blocks`，是纯函数 —— 服务端建文稿要用同一份。）
 */
export function looksLikeMarkdown(text: string): boolean {
  const t = text.trim()
  if (!t || !/\n/.test(t)) return false
  return [
    /^#{1,6}\s/m,       // 标题
    /^```/m,            // 代码围栏
    /^\s*[-*+]\s/m,      // 无序列表
    /^\s*\d+[.)]\s/m,    // 有序列表
    /^\s*>\s?/m,         // 引用
    /^\s*[-*+]\s\[[ xX]\]\s/m, // 待办
    /^\s*\|.*\|\s*$/m,   // 表格
    /^!\[[^\]]*\]\(/m,   // 图片
    /^\s*(\*\*{3,}|-{3,})\s*$/m, // 分割线
  ].some((re) => re.test(t))
}

export interface Toast {
  id: string
  message: string
  type: 'success' | 'info' | 'error'
  /**
   * 可选动作（2026-10-16 加，为「删除空间后的 24 小时撤销」）。
   *
   * 为什么必须有：删完空间界面会**立刻跳走**，
   * 而撤销入口如果只挂在那个弹窗里，跳走的同一刻它自己就没了 ——
   * 相当于「给了 24 小时反悔期，但没人能找到那 24 小时」。
   * 提示条是唯一活得下来的常驻表面。
   */
  action?: { label: string; run: () => void }
}

/* ============================================================
   历史版本的两个小工具
   ============================================================ */

/**
 * 历史版本保留上限。
 * 快照就是一份完整的 blocks，8 份已经能让一篇长文档的存档翻好几倍；
 * 再多就轮到「历史版本把正文额度吃光」了，所以宁可少留几版。
 */
export const MAX_DOC_VERSIONS = 8

/** 单篇快照超过这个体量就跳过自动快照（≈ UTF-16 落盘字节） */
const VERSION_SNAPSHOT_MAX_BYTES = 256 * 1024

/** 单篇文档的历史版本总体积上限：超了就从最旧的一版开始丢 */
const VERSION_TOTAL_MAX_BYTES = 192 * 1024

/**
 * 自动保存的合并窗口。
 * 一次连续输入会触发很多次「保存完成」，每次都存一版的话，
 * 8 个位置很快就被同一段内容的微小改动占满，真正想找回的版本反而被挤掉。
 * 所以只有「自动保存」会按时间合并；打开文档 / 手动保存 / 恢复前 / 手动快照
 * 这些明确的事件一律立刻存，不受窗口限制。
 */
const AUTOSAVE_COALESCE_MS = 20_000

/**
 * 合并提示的合并窗口：同一目标在这段时间内的多次合并并成一条。
 * 一次协同往往连着来十几个 op，逐条列出来用户根本来不及看。
 */
const CONFLICT_MERGE_WINDOW_MS = 3_000

/** 被合并的块高亮多久（协作条提示与正文高亮共用一个时长） */
export const CONFLICT_FLASH_MS = 2_000

/** 版本列表裁剪：先按条数砍，再按总体积从最旧的开始砍（最新的永远保留） */
function trimVersions(versions: DocVersion[]): DocVersion[] {  const kept = versions.slice(0, MAX_DOC_VERSIONS)
  let bytes = 0
  const out: DocVersion[] = []
  for (let i = kept.length - 1; i >= 0; i--) {
    const b = JSON.stringify(kept[i].blocks || []).length * 2
    if (bytes + b > VERSION_TOTAL_MAX_BYTES && out.length) break
    bytes += b
    out.unshift(kept[i])
  }
  return out
}

/** 快照要独立于后续编辑：深拷贝一份（block 契约上保证是纯 JSON） */
const cloneBlocks = (blocks: Block[]): Block[] => JSON.parse(JSON.stringify(blocks || []))

/**
 * 版本内容指纹，用来判断「这次保存和上一版有没有区别」。
 * 一次改动只差一个字符时也要能认出来，所以走全量 JSON 哈希而不是长度比较。
 */
function versionFingerprint(title: string, blocks: Block[]): string {
  const json = JSON.stringify({ t: title, b: blocks || [] })
  let h = 0x811c9dc5
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `${h.toString(16)}:${json.length}`
}

interface Store extends AppData {
  toasts: Toast[]
  /** 当前空间 */
  activeSpaceId: string
  /**
   * 这个**空间**里我有什么权限（`useSpacePerms` 的结果，键为 spaceId）。
   *
   * ⚠️ 它和 `bookAdmin` 是**两件事**，不能互相顶替（2026-10-12 踩过）：
   *   「能不能在这个空间里建知识库」判的是 `capsInSpace(sid).admin`；
   *   而拿**空间 id** 去问 `/api/perms/book/:id` 会得到**全 false** ——
   *   界面上读成「你没权限」，真相是「我问错了对象」。
   *   后果是**空间管理员（非平台管理员）的「新建知识库」按钮整个消失**，
   *   而服务端 `denyReason` 明明放他过。
   *
   *   这是「功能没了」而不是「假动作」——一样是假的，只是方向相反，
   *   所以它比假动作更难被发现：管理员只会以为「这功能还没做」。
   *
   * 不落盘：权限会变，烤一份上次的答案进来会让显隐停在旧判据上。
   */
  spaceCaps: Record<string, Caps>
  /** 当前打开的文档 */
  activeDocId: string | null
  /** 侧边目录是否展开 */
  treeCollapsed: boolean
  /** 目录宽度，可拖拽调整（语雀支持拖动目录与正文之间的竖线） */
  treeWidth: number
  /**
   * 并发编辑的自动合并记录（正文块 / 卡片 data / doc.sheetData 三条线共用）。
   * 纯 UI 态：协作条展示「N 处并发编辑已自动合并」+ 逐条详情 + 跳转高亮。
   * 原来这份数据是 collaboration.ts 里的闭包变量，React 根本读不到。
   */
  collabConflicts: CollabConflict[]

  setActiveSpace: (id: string) => void
  setActiveDoc: (id: string | null) => void
  setTreeCollapsed: (v: boolean) => void
  setTreeWidth: (v: number) => void

  toast: (message: string, type?: Toast['type'], action?: Toast['action']) => void
  dismissToast: (id: string) => void

  /* --- 查询 --- */
  getMember: (id: string) => Member | undefined

  /* --- 文档写操作 --- */
  updateDoc: (docId: string, patch: Partial<Doc>) => void
  setDocBlocks: (docId: string, blocks: Block[]) => void
  /** 应用来自其它标签页的正文（走 BroadcastChannel 同步进来，不落盘） */
  setDocBlocksRemote: (docId: string, blocks: Block[], title?: string) => void
  /** 应用来自其它标签页的文稿数据合并结果（工作表 / 数据表 / 画板） */
  setDocSheetRemote: (docId: string, sheetData: DocSheetData) => void
  /**
   * 建一篇文稿。
   *
   * `initBlocks` 存在的理由：「小记 → 转为文档」这个功能以前**只带走了标题、
   * 丢掉了正文** —— 新建出来的文稿 `body: ''` 加一个空 H1 占位，
   * 于是「把这条想法整理成文档」变成了「把想法标题整理成一篇空文档」，
   * 内容一个字没留下。用户不会觉得是 bug，只会觉得「怎么是空的」。
   */
  createDoc: (bookId: string, parentId: string | null, title?: string, type?: DocType, initBlocks?: Block[]) => string
  /**
   * 建文稿，**没有 `create` 权限时弹一条说明并返回 `''`**。
   *
   * 所有面向用户的「新建」入口都应该走它，不要各写一遍 `if (!id)` ——
   * 实测同一个「被拒后仍然报成功」在三个入口各犯过一次（见实现处注释）。
   */
  createDocOrExplain: (bookId: string, parentId: string | null, title?: string, type?: DocType) => string
  deleteDoc: (docId: string) => void
  restoreFromTrash: (docId: string) => void

  /**
   * 删除知识库 —— **硬删**，连带库里所有文档一起没了，**不可恢复**（语义同语雀）。
   *
   * 以前整个产品**没有**这个能力：没有 store 方法、没有服务端端点、UI 没入口。
   *
   * ⚠️ 为什么不是「进回收站」：回收站在本项目里只到**文档**一级
   * （`trash` 表存的是 docId）。如果删库只是把文档全塞进去，
   * 那么事后恢复任意一篇时它指向的知识库已经不存在了 ——
   * 用户会拿到一批点不动的孤儿文档，比直接删更难收拾。
   *
   * 失败**必须抛**：服务端发现有文档删不掉时会整次中止（库还在），
   * 这时候界面要如实说「没删掉、库还在」，不能先把库从列表里摘掉。
   */
  deleteBook: (bookId: string) => Promise<{ purgedDocs: number }>

  /**
   * 服务端把某几篇**永久删除**之后，把它们从本地也摘掉。
   *
   * 不摘的话：回收站里那一行没了（我们把它过滤掉了），
   * 但知识库目录里点进去还在 —— 表现是「删不掉的那篇还在」，
   * 而服务端明明已经删干净了。两边对不上，用户会以为删除失败。
   */
  dropPurgedDocs: (docIds: string[]) => void
  toggleFavorite: (targetType: 'doc' | 'book', targetId: string, title: string) => void
  isFavorite: (targetType: 'doc' | 'book', targetId: string) => boolean

  /* --- 知识库邀请（2026-10-11） --- */
  /**
   * 我收到的待处理邀请。**服务端形态下才是真的** ——
   * 本地模式下没有服务端，邀请发不出去，这里永远是空的。
   * UI 必须按这一点门控（见 BookInviteList）。
   *
   * ⚠️ 这里原来还挂着 `acceptCollaboration` / `rejectCollaboration`
   *    两个动作和一大段注释，讲的是「本项目没有邀请流程、
   *    collaborations 是纯客户端种子数据」。**那句话已经不成立了** ——
   *    2026-10-11 补了真正的知识库邀请（见上面的 bookInvites）。
   *    而那两个动作本身也早随 CollabTab 一起删了，
   *    只剩这段注释挂在原地，像是「有意保留的能力边界」。
   *
   *    留着比删掉更糟：下一个人读到「本项目没有邀请流程」，
   *    会以为那是个还没做的功能，而不是一句已经过期的话。
   *
   *    顺带记下一个仍然有效的教训（它当年是真的）：
   *    **凡是改数据的写操作都必须走 `commit`，不能用裸 `setState`** ——
   *    本 store 没挂 persist 中间件，落盘只发生在 `commit()` 里。
   *    `Trash` / `Settings` 里那几处 `setState` 是另一回事 ——
   *    它们前面已经真调过服务端了，服务端才是真相，本地只是乐观同步。
   */
  bookInvites: BookInvite[]
  /** 拉一次待办。登录后与接受 / 拒绝后都要调 */
  refreshBookInvites: () => Promise<void>
  /** 发起邀请。返回 false 表示失败（toast 已经说了原因） */
  inviteToBook: (bookId: string, userId: string, role: 'reader' | 'editor', message?: string) => Promise<boolean>
  /** 接受：服务端会真的把他加进 book_members，本地补一份 optimistic */
  acceptBookInvite: (inviteId: string) => Promise<boolean>
  rejectBookInvite: (inviteId: string) => Promise<boolean>
  /** 我在这个库里发出去的、还等着对方处理的 */
  getSentInvites: (bookId: string) => BookInvite[]

  /* --- 关注 --- */
  /**
   * 关注 / 取消关注一个空间或一个人。
   *
   * 以前这个模块整个是假的：关注页列的是**全部**空间和除 u1 外的**全部**成员，
   * 配两个没有 onClick 的「已关注」按钮，而项目里压根没有关注这张表。
   * 与 favorites 同构（个人实体，服务端按 userId 过滤）。
   */
  toggleFollow: (targetType: 'space' | 'user', targetId: string) => void
  isFollowing: (targetType: 'space' | 'user', targetId: string) => boolean

  /* --- 目录树写操作 --- */
  renameNode: (nodeId: string, title: string) => void
  createNode: (bookId: string, parentId: string | null, type: NodeType) => string
  moveNode: (nodeId: string, newParentId: string | null, newIndex: number) => void
  deleteNode: (nodeId: string) => void

  /* --- 知识库 --- */
  createBook: (spaceId: string, name: string, desc?: string) => string
  updateBook: (bookId: string, patch: Partial<Book>) => void

  /* --- 评论 --- */
  addComment: (docId: string, text: string) => void
  /** 删评论并连带删掉它下面的回复 */
  deleteComment: (docId: string, commentId: string) => void
  addReply: (docId: string, parentId: string, text: string) => void

  /* --- 讨论区（话题回复）--- */
  /**
   * 发一条话题回复。
   *
   * 走 store action → commit → 同步推送，和评论同一套机制。
   * 之前这个列表只活在组件的 useState 里：一刷新就没、换设备看不见，
   * 而界面上和真评论长得一模一样。
   */
  /**
   * 发一条话题回复，返回新回复的 id；**被拒时返回 `''`**。
   *
   * ⚠️ 以前返回 `void`，于是调用方没法判断成没成 ——
   * `KnowledgeDetail` 那句「回复之后无条件 `setText('')`」就是这么来的：
   * 没有权限时 store 拒了，而**用户写的整段话被清空了，一条提示都没有**。
   * 用户会以为自己手滑了，或者系统把草稿吃了，重打一遍还是一样。
   *
   * 返回 id 之后，「成功才清空、失败要说明」才能写出来。
   */
  replyToTopic: (topicId: string, text: string) => string
  /**
   * 发起一个话题（讨论区）。
   *
   * ⚠️ 这条动作以前**压根不存在** —— 讨论区只能看、不能发，
   * 而三处文案都写着能发（详见实现处的注释）。2026-10-12 补上。
   * 返回新话题的 id；标题为空返回 ''。
   */
  createTopic: (spaceId: string, title: string, text?: string) => string
  /** 某个话题的真实回复，按时间正序 */
  getTopicReplies: (topicId: string) => TopicReply[]
  /**
   * 某个话题的**真实**回复条数。
   *
   * 界面上一律用它，不要用 `topic.replyCount` —— 那个字段是种子里的历史值，
   * 和实际回复行对不上，拿来显示就是编数字。
   */
  getTopicReplyCount: (topicId: string) => number
  /**
   * 这个话题的参与者（**按真实回复算**，不是 `topic.participants` 那个快照）。
   *
   * ⚠️ 2026-10-12 实测：`topics.participants` 只在建话题那一刻写一次
   * （`body ? [authorId] : []`），之后**从不变**。而工作台的话题卡片
   * （`Dashboard.tsx`）恰恰读的是它 —— 于是同一张卡片上，
   * 头像列表是陈旧的、旁边的「N 回复」是真实的（`getTopicReplyCount`），
   * 出现「12 回复」旁边只挂一个头像、甚至挂着从未回复过的人的头像。
   *
   * 话题详情页早就自己按真实回复算了（所以那一页是对的）——
   * **同一件事两个视图，一个对一个错**。这就是「同一份口径两处各算一遍迟早漂」。
   *
   * 所以收在 store：两个视图都调它，以后再加第三个视图也不会漂。
   * 口径与详情页保持一致：**发起人 + 真正回过帖的人**，去重。
   */
  getTopicParticipants: (topicId: string) => string[]

  /* --- 小记 --- */
  /**
   * 新建团队空间。
   *
   * 以前**根本没有这个动作** —— 空间只来自两处：种子数据，和注册/统一认证
   * 时自动开的那一个个人空间。真实部署里于是永远建不出「研发部」这种团队空间，
   * 「空间 → 知识库 → 文稿」的三级在非演示场景下塌成了两级。
   *
   * 服务端模式下必须走接口而不是同步：`space_members` 不在同步实体清单里，
   * 客户端推上去的空间会没有成员行，服务端判「谁建的谁进不去」。
   */
  createSpace: (name: string, desc?: string) => Promise<string | null>
  /**
   * 删除空间（2026-10-16，照真实语雀：空间管理员 + 验证口令 + 24 小时可撤销）。
   *
   * 返回 `undoUntil`（撤销窗口截止时刻）；被拒返回 `null`。
   * **调用方必须判这个返回值** —— 不判的话界面会假装删成功了。
   */
  deleteSpace: (spaceId: string, password: string) => Promise<{ undoUntil: number; deletedBooks: number } | null>
  /** 撤销删除。成功返回 true */
  restoreSpace: (spaceId: string) => Promise<boolean>
  /** 返回新小记的 id；**被拒时返回 `''`**（理由同 `replyToTopic`） */
  addNote: (spaceId: string, text: string) => string
  likeNote: (noteId: string) => void
  /** 点赞 / 取消点赞一篇文稿（落 `doc.likes`，会跟着同步走） */
  toggleDocLike: (docId: string) => void
  /**
   * 置顶 / 取消置顶一篇文稿（落 `doc.pinnedAt`，会跟着同步走）。
   *
   * 语雀的对应物是 `doc.pinned_at`，带一个具名开关
   * `enable_book_doc_pin`（2026-10-12 匿名 SSR 取到的 settings 里带着）。
   * 返回置顶后的时刻（取消时是 null），好让调用方直接拿去提示。
   */
  togglePinDoc: (docId: string) => number | null

  /* --- 最近访问 --- */
  touchDoc: (docId: string) => void

  /* --- 知识库设置中心 --- */
  getBookSettings: (bookId: string) => BookSettings
  updateBookSettings: (bookId: string, patch: Partial<BookSettings>) => void
  getBookMembers: (bookId: string) => BookMember[]
  updateMemberRole: (bookId: string, memberId: string, role: BookMember['role']) => void
  updateMemberPerm: (bookId: string, memberId: string, perm: keyof BookMember['perms'], value: boolean) => void
  removeBookMember: (bookId: string, memberId: string) => void
  addBookMember: (bookId: string, memberId: string, role: BookMember['role']) => void
  /**
   * 一次加多个人。
   *
   * 为什么要单独一个 action，而不是 UI 里循环调 addBookMember：
   * 循环 N 次就是 N 次 commit、N 次同步推送。给一个 200 人的公司开通
   * 知识库会变成 200 个来回，而且中途断网就只加进去一半。
   * 一次 commit 只有一条同步记录，天然是原子的。
   */
  addBookMembers: (bookId: string, memberIds: string[], role: BookMember['role']) => void

  /* --- 模板中心 --- */
  createTemplate: (tpl: Omit<DocTemplate, 'id' | 'createdAt' | 'usedCount'>) => string
  updateTemplate: (id: string, patch: Partial<DocTemplate>) => void
  deleteTemplate: (id: string) => void
  /**
   * 用模板在指定知识库下新建文档。
   *
   * 「已用 N 次」也在这里 +1（原实现里另有一个 `useTemplate` action 干这件事，
   * 但没人调用它 —— UI 走的是本 action，于是那个 +1 从来没发生过，
   * 而模板页两处都在展示 `usedCount`。看起来是数据不动，不是 UI 坏了）。
   */
  applyTemplate: (bookId: string, parentId: string | null, tplId: string) => string

  /* --- 协作光标（跨标签页实时同步） --- */
  setCursor: (c: CollabCursor) => void
  /** 只摘某个人的光标（他离开正文 / 掉线 / 关掉了标签页） */
  removeMemberCursor: (docId: string, memberId: string) => void
  clearDocCursors: (docId: string) => void

  /* --- 并发编辑的自动合并记录（协作条消费） --- */
  /** 记一次合并。同一目标短时间内的多次合并会并成一条，避免刷屏 */
  pushCollabConflict: (c: Omit<CollabConflict, 'id' | 'at' | 'highlightUntil'> & { at?: number; highlightUntil?: number }) => void
  /** 「忽略」：清掉某篇文档（或全部）的合并记录 */
  clearCollabConflicts: (docId?: string) => void

  /* --- 划词评论 --- */
  addSelectionComment: (docId: string, quote: string, blockId: string, text: string) => void
  resolveSelectionComment: (docId: string, id: string) => void
  replySelectionComment: (docId: string, id: string, text: string) => void
  removeSelectionComment: (docId: string, id: string) => void

  /* --- 空间 --- */
  switchUser: (memberId: string) => void

  /**
   * 改自己的资料（昵称 / 邮箱 / 个人简介）。
   *
   * 刻意**不走 sync push**：那条路是 members 实体，而服务端
   * `denyReason` 对 members 要求平台管理员 —— 改自己的昵称
   * 不该要管理员权限，放松那道口子又会变成「谁都能改所有人」。
   *
   * 所以先请服务端写，再把**服务端回来的那一行**合进本地：
   * 不这么做的话，界面上显示的是用户刚输入的值，
   * 而服务端可能拒了其中一项（空昵称、邮箱格式不对），
   * 于是两台设备上显示的不一样。
   */
  /**
   * 改自己的资料。`avatar` 是 attachments 里那条记录的 id（不是 URL / data URL），
   * 空串表示回到首字母头像 —— 理由见 `MyProfile.avatar` 的注释。
   */
  updateMyProfile: (patch: { name?: string; email?: string; bio?: string; avatar?: string }) => Promise<void>
  reset: () => void

  /* --- 历史版本（快照 / diff / 恢复） --- */
  /**
   * 存一版快照。内容与最新一版完全一致时直接跳过
   * （自动保存每敲一下键都会来一次，不去重版本列表会被灌满），
   * 存成了返回新快照 id，没存成返回 null。
   */
  addDocVersion: (docId: string, label?: string) => string | null
  /** 恢复到某个历史版本：真把 blocks / title / body 换回去（恢复前先存一版现状，可再撤销） */
  restoreDocVersion: (docId: string, versionId: string) => boolean

  /* --- 文档锁定 --- */
  /** 锁定文档：别人只能读，持有者自己照常编辑 */
  lockDoc: (docId: string) => boolean
  /** 解锁（语义上只有持有者自己能解锁） */
  unlockDoc: (docId: string) => void

  /* --- 服务端同步 --- */
  /** 清空本地快照（服务端形态下登录前调用，见实现里的说明） */
  clearLocalSnapshot: () => void
  /**
   * 登录后用服务端返回的整包数据覆盖本地状态。
   * 走 set() 而不是 commit()：这是「从权威源灌进来」，
   * 不是用户操作，没必要再回推给服务端（会白跑一轮差分）。
   */
  hydrate: (data: Partial<AppData>, opts?: { currentUser?: AppData['currentUser'] }) => void
  /**
   * 应用远端增量。
   * 同样走 set()：远端来的内容再 commit 回去就是无限回环。
   * —— 这是本地/远端分流的唯一判据，别改。
   */
  applyRemote: (patch: Record<string, unknown>) => void
  /**
   * 问服务端「我在这个空间里有什么权限」，结果记进 `spaceCaps`。
   *
   * 走 `GET /api/perms/space/:id`（2026-10-12 新加）。
   *
   * ⚠️ 曾经拿**空间 id** 去问 `/api/perms/book/:id` —— 那会得到**全 false**，
   *   于是空间管理员（非平台管理员）的「新建知识库」按钮整个消失，
   *   而服务端 `denyReason` 明明放他过。
   *   我第一版的探针只测了平台管理员（他早退 true），所以没露出来。
   *
   * 失败时记「只有 read」而不是「没有权限」：
   * 「查不到」在界面上表现成「不给入口」是对的，
   * 而一组全 false 会被读成「你不是管理员」—— 那是**关于人的断言**，
   * 而我们其实什么都不知道。
   */
  loadSpaceCaps: (spaceId: string) => Promise<boolean>
  /**
   * 直接记下一个已知的空间判据（不发请求）。
   *
   * 给「本来就已经拿到了这个答案」的调用方用 —— `Space.tsx` 的成员名册
   * 调的就是同一个接口（`/api/spaces/:id/members` 返回 `isAdmin`），
   * 让它顺手写进来，另外三个建库入口就能复用同一份结果。
   */
  setSpaceCaps: (spaceId: string, value: Caps) => void
  /**
   * 这个人能不能在这个空间里新建知识库。
   *
   * 判据来自服务端 `capsInSpace(sid).admin`（`denyReason` 的 books 分支：
   * 「建库是管理动作」）。**没查过**时返回 **false** —— 先不显示入口，
   * 宁可晚半秒出现也不要先给一个会被服务端拒掉的。
   *
   * ⚠️ 这里读的是 **store 的 `spaceCaps` 切片**，不是 `lib/perms` 里那个
   *   hook 用的缓存 —— 同一个事实存两份，就会有「一份更新了另一份没更新」
   *   的分叉（第一版就是这么错的：`canCreateBookIn` 读缓存、
   *   `loadSpaceCaps` 写 store，于是它永远读到 undefined）。
   */
  canCreateBookIn: (spaceId: string) => boolean
}

export const useStore = create<Store>((set, get) => {
  /** 每次写操作后统一存盘 */
  /**
   * 落盘时必须剔除 toasts 与 cursors：
   * - toasts 是纯 UI 态
   * - cursors 是跨标签页协作的实时态（selectionchange 一次就变一次）
   * 两者都进 localStorage 会造成高频写盘，
   * 而且刷新后页面会挂着上一轮的"幽灵光标"。
   * 另外：改到 cursors 的 action 一律用 set() 而不经过 commit，
   * 免得「不写 cursors 却还是排了一次落盘」。
   */
  const PERSIST_SKIP = new Set(['toasts', 'activeDocId', 'cursors', 'collabConflicts'])

  /**
   * 写操作统一入口。
   * delay / maxWait 决定落盘档位：本地编辑走默认 400ms，
   * 远端合并结果走 REMOTE_SAVE_*（理由见上面两个常量的注释）。
   */
  const commit = (fn: (s: Store) => Partial<Store>, delay?: number, maxWait?: number) => {
    set((s) => {
      const patch = fn(s)
      const next = { ...s, ...patch }
      const data: Record<string, unknown> = {}
      for (const k of Object.keys(next)) {
        if (!PERSIST_SKIP.has(k)) data[k] = (next as any)[k]
      }
      persist(data as unknown as AppData, delay ?? SAVE_DEBOUNCE_MS, maxWait ?? 0)
      return patch
    })
  }

  /** 字数口径收在 `@/lib/word-count`：服务端建/改文档走的是同一份实现。
   *  原来这里是 `b.text.length` 求和（空白也算），而服务端数的是 markdown
   *  （把 `# -` 这些标记符号算成字）—— 实测一篇 11 块的文档两边差 9 字，
   *  而这个数字是要给人看的（文档头 / 知识库列表 / 工作台统计 / 发现页 / 目录树）。 */
  const recomputeWordCount = (d: Doc): number => {
    if (!d.blocks) return d.wordCount
    return countWordsFromBlocks(d.blocks)
  }

  /**
   * 标题 = 第一个 H1 块的文字（语雀的模型：两者是同一份数据）。
   *
   * 以前这个派生写在三个地方：`DocPage.handleBlockChange`（本地编辑）、
   * `restoreDocVersion`（回滚）、以及协作层「记得把 title 传进来」这个隐式契约。
   * 三份实现意味着**总有一条路径会漏** —— 漏掉的表现是
   * 「目录树里一个标题、正文第一行另一个标题」，而且不会有任何报错。
   *
   * 所以它跟 `body` 一样收在写入点：只有一处能写错，也只有一处能写对。
   *
   * 第一个块**不是** h1 时不动 title —— 那类文稿（工作表 / 画板）
   * 的标题有别的来源，块里没有就不该被覆盖。
   *
   * ============================================================
   * h1 为空时**不能**直接抹成「未命名」—— 那是另一种空
   * ------------------------------------------------------------
   * `createDoc(bookId, parentId, title)` 会**同时**留下一个空 h1 占位，
   * 而 `blocks[0]` 通常还是那个空 h1。也就是说「h1 空但 title 有值」
   * 是一个**合法且被产品自己造出来**的状态：
   *   · Markdown 导入（`Settings.tsx` 用 `createDoc(…, n.title)`）
   *   · 小记转文档（`Notes.tsx` 同样）
   *   · 各个「新建」按钮（传 '未命名' 或 `新建${label}`）
   *
   * 一看到空 h1 就覆盖，等于**新建一篇文档、往里加一个段落，标题就被抹成
   * 「未命名」**了 —— `test-no-spurious-push` 立刻抓到了这个。
   *
   * 所以要分清两种空：
   *   · **本来就没写** → 保留 createDoc 传进来的那个
   *   · **写了又被删空** → 才回到「未命名」
   * 要分清就必须看**上一版的 h1**，所以这里要 `prev`。
   */
  /**
   * 第三个参数 `force` 区分两种**性质不同**的写入：
   *   · 普通编辑（force=false）：只在**首个 H1 真的变了**时才改标题。
   *   · 整份内容替换 —— 版本回滚（force=true）：无条件按新内容重算。
   *
   * 为什么要分开：回滚换的是**另一份内容**，哪怕两份的首个 H1 文字恰好相同，
   * 标题也必须跟回滚目标那份走（它自带一个 title）。而普通编辑只是动了别的块，
   * H1 没动就不该碰标题。
   *
   * 2026-10-06 实测过为什么需要前一条：API 建了一篇 title 与首个 H1 不一致的文档，
   * 用户改了**第二段**（跟标题无关），标题被无声地改成了 H1，
   * 于是目录 / 书签 / 分享链接里的标题在第一次编辑后漂走。
   * 但不能一刀切成「无条件重算」—— 那样 `test-bodyfresh` 的回滚那条就红了。
   */
  const applyDerivedTitle = (d: Doc, prev?: Doc, force = false): void => {
    const first = d.blocks?.[0]
    if (!first || first.type !== 'h1') return
    const t = first.text.trim()
    if (t) {
      if (!force && prev) {
        const prevFirst = prev.blocks?.[0]
        const prevText = prevFirst && prevFirst.type === 'h1' ? String(prevFirst.text || '').trim() : ''
        if (prevText === t) return
      }
      d.title = t
      return
    }
    const prevFirst = prev?.blocks?.[0]
    if (prevFirst && prevFirst.type === 'h1' && prevFirst.text.trim()) d.title = '未命名'
  }

  /**
   * 目录节点（nodes[].title）必须跟着 `doc.title` 一起变。
   *
   * ⚠️ 2026-10-10 实测抓到的：文档型文稿在正文 H1 里改标题，
   *   `doc.title` 变了，**目录树里还是「未命名」**。
   *   目录树、知识库设置页的目录、工作台列表读的都是 `node.title`，
   *   所以同事在目录里看到的永远是「未命名」，除非他双击手动改名一次。
   *
   *   为什么漏：语雀的模型是「标题 = 第一个 H1 块」，而我们把这个
   *   「一份数据」拆成了 `docs.title` 和 `nodes.title` 两个字段。
   *   以前只有**非文档型**文稿（表格/画板）那条路径会两边都改
   *   （`DocPage.handleTitle` → updateDoc + renameNode），
   *   而文档型走的是 setDocBlocks → applyDerivedTitle，只改 docs 一边。
   *
   *   和上面那个「三处实现」是同一族：**同一份概念存在多份副本，
   *   就总有一条路径只改其中一份。** 修法也一样 —— 收在写入点。
   */
  const syncNodeTitle = (s: Store, docId: string, title: string): TreeNode[] =>
    s.nodes.map((n) => (n.docId === docId && n.title !== title ? { ...n, title } : n))

  /**
   * 「标题」这一个概念在 `docs` 里有**三份副本**，改一处就得带着另外两处走：
   *   · `docs.title`       —— 标题本体
   *   · `docs.blocks[0]`   —— 文档型文稿的第一个 h1 块（语雀的模型：「标题 = 第一个 H1」）
   *   · `docs.body`        —— 由 blocks 转出的 Markdown 源，**导出与对外分享页认的是它**
   *
   * ⚠️ 2026-10-12 实测抓到的：`applyDerivedTitle` 只做了「H1 → title」**一个方向**，
   *   反方向是空的。所以在「文档设置」里改完标题：
   *     title = 改过的标题，blocks[0] = 原始标题，body 首行 = `# 原始标题`
   *   —— **导出成 Markdown / Word / HTML 出来还是旧标题**，大纲面板和对外分享页
   *   读的也都是块。刷新后服务端存的三份照样分叉。
   *
   * 为什么收在这里：**写入点**。`updateDoc` 和 `renameNode` 是仅有的两处
   * 写标题的地方，让每个界面自己记得补三刀，第三个调用方一定会漏
   * （`updateDoc` 那条就是这么漏的）。这也和 `syncNodeTitle` 同一个道理 ——
   * 上一轮已经把「目录节点」那份副本收进写入点了，这两份同理。
   *
   * 只在**首个块确实是 h1** 时才动它：表格 / 画板那类文稿第一个块不是 h1，
   * 它们的标题本来就跟正文无关，硬塞一个 h1 进去反而是造数据。
   */
  const withSyncedTitle = (d: Doc, title: string): Doc => {
    const next: Doc = { ...d, title, updatedAt: Date.now() }
    const first = d.blocks?.[0]
    if (Array.isArray(d.blocks) && first?.type === 'h1' && String(first.text || '') !== title) {
      next.blocks = [{ ...first, text: title }, ...d.blocks.slice(1)]
      next.body = blocksToMarkdown(next.blocks)
    }
    return next
  }

  /**
   * 改一篇文档 = 这个库也「被更新了」。
   *
   * ⚠️ 2026-10-12 实测抓到的：以前只有**结构变化**（新建 / 移动 / 用模板建一篇）
   * 会动 `books.updatedAt`，而工作台与空间页的知识库卡片显示的正是
   * `{timeAgo(b.updatedAt)}更新`、列表还按它排序 ——
   * 于是**今天改了一篇文档，那个库还写着「3 天前更新」**、位置也不动。
   *
   * 收在**写内容的两个入口**（`setDocBlocks` / `updateDoc`），
   * 别让每个编辑器自己记得补 —— 第三个入口漏掉就是同一个结局。
   * 远端合并进来的正文不用补：这一行 `books` 本身会走同步，
   * 别的设备拉到就跟着更新了。
   */
  const bumpBookUpdatedAt = (s: Store, bookId: string | null | undefined) => {
    if (!bookId || !s.books.some((b) => b.id === bookId)) return s.books
    return s.books.map((b) => (b.id === bookId ? { ...b, updatedAt: Date.now() } : b))
  }

  /**
   * 知识库级别的「N 篇 · M 字」**不再在这里增量维护**。
   *
   * 以前是「新建文档时 docCount + 1」，结果删文档不减、编辑也不更新字数，
   * 而服务端 seed 给的是 0 —— 于是工作台上每个库都显示「0 字」，
   * 同一本书的书页却显示真值。
   *
   * 现在改成读取时现算（`lib/bookStats.ts` 的 `useBookStats()`），
   * 结构上就不可能不一致。`books` 上那两个字段仍然留着
   * （实体和历史数据里有），但**没有任何界面再读它们**。
   */

  return {
    ...load(),
    toasts: [],
    activeSpaceId: 's1',
    activeDocId: null,
    treeCollapsed: false,
    /** 知识库邀请的待办（服务端形态下才有内容；本地模式永远是空的） */
    bookInvites: [],
    /**
     * 空起步，**刻意不从 localStorage 恢复**：权限会变，
     * 烤一份上一次的答案进来就会让界面的显隐停在旧判据上。
     * 代价是每次打开页面要问一次服务端（`loadSpaceCaps`），
     * 换来的是「权限变了界面就跟着变」。
     */
    spaceCaps: {},
    treeWidth: 260,
    collabConflicts: [],

    setActiveSpace: (id) => commit(() => ({ activeSpaceId: id })),
    setActiveDoc: (id) => set({ activeDocId: id }),
    setTreeCollapsed: (v) => set({ treeCollapsed: v }),
    setTreeWidth: (v) => set({ treeWidth: v }),

    toast: (message, type = 'info', action) => {
      const id = uid('t')
      set((s) => ({ toasts: [...s.toasts, { id, message, type, action }] }))
      /*
       * 带动作的活久一点：普通提示 2.6 秒顺手扫过就行，
       * 而「撤销删除」这种**24 小时窗口**的入口，2.6 秒后就没了等于没有 ——
       * 用户不会为了点一个按钮去盯着一条提示等它不消失。
       */
      setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      }, action ? 12000 : 2600)
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

    /* ---------------- 查询 ---------------- */
    getMember: (id) => get().members.find((m) => m.id === id),

    /* ---------------- 文档 ---------------- */
    updateDoc: (docId, patch) => {
      /*
       * 权限第二道（见文件头 `bookEditBlocked`）。
       *
       * 它是**通用文稿写入口**，界面上有五处在调：
       * 改标题 / 标记「已发布」/ 分享设置 / 文档设置 / 表格单元格。
       * 实测（探针，reader 与 visitor 各一轮）这五处以前**一个门都没接**：
       * 点「标记为已发布」→ 本地立刻变成 true、服务端仍是 false →
       * 顶栏常驻「1 处修改没有保存」，而本人修不好。
       *
       * ⚠️ 必须读路径绕开它：`_loaded`（正文是否已加载）是在
       * `src/lib/sync.ts` 里**直接给 doc 对象赋值**的，不走这个 action ——
       * 所以加守卫不会让只读成员的文档永远停在骨架态。
       */
      if (bookEditBlocked(get().docs[docId]?.bookId)) return
      commit((s) => {
        const d = s.docs[docId]
        if (!d) return {}
        // 改标题时走 withSyncedTitle：它会把**首个 h1 块和 body** 一起带上
        // （见它那段注释：三份副本，只同步其中一份就是导出出来还是旧标题）。
        // 调用方自己传了 blocks 的就别动它 —— 那种写入的权威是块，不是标题。
        const next = patch.title !== undefined && !('blocks' in patch)
          ? withSyncedTitle({ ...d, ...patch }, String(patch.title))
          : { ...d, ...patch, updatedAt: Date.now() }
        const docs = { ...s.docs, [docId]: next }
        const nodes = patch.title !== undefined ? syncNodeTitle(s, docId, String(next.title)) : s.nodes
        // 改标题也是「这个库被更新了」（见 bumpBookUpdatedAt 那段注释）
        const books = patch.title !== undefined ? bumpBookUpdatedAt(s, next.bookId) : s.books
        const out: any = nodes === s.nodes ? { docs } : { docs, nodes }
        return books === s.books ? out : { ...out, books }
      })
    },

    /**
     * 写正文块，**同时把 `body` 一起更新**。
     *
     * ============================================================
     * 以前只改 blocks，于是 `docs.body` 永远是「建文档时」的那一份
     * ------------------------------------------------------------
     * 而 `docs.body` 有三个真实的用户可见消费方：
     *   · 单篇导出 Markdown / Word / HTML / 纯文本（DocPage 的「···」菜单）
     *   · 对外分享页（PublicDoc.tsx 渲染的就是 body）
     *   · 发现页的卡片摘要
     *
     * 实测（真实流程：建文档 → 在正文段落里敲字 → 导出）：
     *     导出文件名 未命名.md，**内容长度 0**
     *     分享页访客只看到一个标题，正文一个字都没有
     *     发现页摘要空
     *
     * 而搜索**早就撞见过这个问题**（useSearch.ts 的注释写着
     * 「没打开过的文档 body 是空的」），当时选的是
     * `d.body || blocks.map(b => b.text)` —— 绕过，而不是根治。
     * 于是同一根因在另外三处一直在流血，而它们连报错都没有：
     * 文件能正常下载、分享页能正常打开、toast 还会说「已导出」。
     *
     * 派生值就在**写入点**算一次，而不是在每个读取方各算一遍 ——
     * 三处读取方曾经就是「同一个概念三份实现」，这已经出过一次事。
     *
     * 同一个 commit 里顺带把 **title 也派生出来** ——
     * 语雀的模型是「文档标题就是正文的第一个 H1 块」，两者是同一份数据。
     * 以前这个派生写在**三个地方**：`DocPage.handleBlockChange`（本地编辑）、
     * `restoreDocVersion`（回滚）、以及协作层「记得把 title 传进来」这个隐式契约。
     * 三份实现意味着**总有一条路径会漏**，而漏掉的表现是
     * 「目录树里一个标题、正文第一行另一个标题」。
     * 跟 `body` 一样收进写入点，就只有一处能写错 —— 也只有一处能写对。
     */
    setDocBlocks: (docId, blocks) =>
      commit((s) => {
        const d = s.docs[docId]
        if (!d) return {}
        const next = { ...d, blocks, body: blocksToMarkdown(blocks), updatedAt: Date.now() }
        applyDerivedTitle(next, d)
        next.wordCount = recomputeWordCount(next)
        // 目录节点跟着标题走（见 syncNodeTitle 那段注释）
        const nodes = syncNodeTitle(s, docId, next.title)
        // 这个库也跟着「最近更新」走（见 bumpBookUpdatedAt 那段注释）
        const books = bumpBookUpdatedAt(s, next.bookId)
        const out: any = nodes === s.nodes ? { docs: { ...s.docs, [docId]: next } } : { docs: { ...s.docs, [docId]: next }, nodes }
        return books === s.books ? out : { ...out, books }
      }),

    /**
     * 远端同步专用：**不落盘**。
     * 同一份内容在源标签页已经 commit 过（400ms 防抖持久化），
     * 这里再走一遍 commit 就变成两个标签页互相写 localStorage，
     * 后写的会盖掉对方的版本。远端只更新内存态即可 ——
     * 真要刷新页面，从源标签页的落盘结果读回来是同一份数据。
     */
    /**
     * 远端 apply 后【必须落盘】。
     * 之前这里走 set() 不落盘，理由是"避免两个标签页互相写盘"——
     * 但合并是收敛的，两边落盘的内容本来就一致，不存在互相覆盖。
     * 不落盘的后果是：合并结果只活在内存里，刷新即丢。
     * commit 自带 400ms 防抖，不会出现每 60ms 写一次盘的问题。
     */
    setDocBlocksRemote: (docId, blocks, title) =>
      commit((s) => {
        const d = s.docs[docId]
        if (!d) return {}
        // body 也要跟上：它是**读**导出 / 分享 / 摘要用的，
        // 只在本地 setDocBlocks 里更新的话，跨标签页合并进来的正文
        // 在这一台设备上导出会是旧的。
        const next = { ...d, blocks, body: blocksToMarkdown(blocks), updatedAt: Date.now() }
        // title 也派生（见 setDocBlocks 的说明）。只有调用方**没显式给** title 时才覆盖 ——
        // 协作层传进来的那个 title 已经是权威值了。
        if (title === undefined) applyDerivedTitle(next, d)
        next.wordCount = recomputeWordCount(next)
        if (title !== undefined && title !== d.title) next.title = title
        // 协作来的正文也是「服务端的样子」，同步基准必须跟上。
        // 不跟的话：store 是新版本、基准是旧版本 → 下次差分判变 →
        // 把它当成「我改的」推上去。有编辑权的人推得动（只是白推一趟），
        // 只读成员推不动 → 顶栏常驻「N 处修改没有保存」，
        // 而他一个字都没改、只是**别人在同一篇文档里动了手**。
        // 必须在 commit 落地前通知：commit 之后就是差分了。
        //
        // 这一行曾经被并进上面那句注释的末尾（删空行时吃掉了换行），
        // 于是协作进来的正文不再更新基准 → 差分判「我改的」→ 只读成员
        // 收到一条他根本没做的告警。**tsc 完全没抓到** ——
        // 可选调用 `remoteDocHook?.()` 被注释掉之后，代码依然合法，
        // 只是**静默地不生效**。这是「代码写在注释里」最坏的一种。
        remoteDocHook?.(docId, next)
        // 协作合并进来的标题同样要同步到目录节点 ——
        // 否则「别人改的标题」在我这台设备的目录树上看不到。
        const nodes = syncNodeTitle(s, docId, next.title)
        return nodes === s.nodes
          ? { docs: { ...s.docs, [docId]: next } }
          : { docs: { ...s.docs, [docId]: next }, nodes }
      }, REMOTE_SAVE_DEBOUNCE_MS, REMOTE_SAVE_MAX_WAIT_MS),

    /**
     * 远端同步专用：应用合并后的 doc.sheetData（工作表 / 数据表 / 画板）。
     * 和 setDocBlocksRemote 一样走 commit（落盘）：合并是收敛的，
     * 两边落盘的内容本来就一致，不存在互相覆盖；不落盘的话合并结果只活在内存里。
     *
     * ============================================================
     * 下面原来那句「`sheetData` 就在差分白名单 DOC_COMPARE_FIELDS 里」
     * **是错的，而且是个陷阱** —— 已删
     * ------------------------------------------------------------
     * `DOC_COMPARE_FIELDS` 里**没有** `sheetData`（只特判了 `blocks`）。
     * 下一个人看到「注释说有、代码没有」，很可能会「顺手补上」——
     * 而那恰恰会**引入**这条注释想防的假告警：sheetData 一旦参与差分，
     * 看同一张表的只读成员就会因为它「变了」而收到一条他根本没做的告警。
     *
     * 真正的机制是这样的：差分靠 `updatedAt` 判定（它在白名单里，而任何
     * `updateDoc` 都会改它），所以工作表的改动**照样**会被推上去 ——
     * 靠的是 `updatedAt` 变了，不是 `sheetData` 参与了比较。
     * 这一点实测过：改一个工作表文档的 sheetData，服务端确实收到了。
     *
     * 那基准为什么还要跟上？因为 `remoteDocHook` 记的是「服务端的样子」。
     * 基准落后的话，下次差分会把这一篇判成「本地又变了」→ 白推一趟。
     * 这个结论对，**理由是错的** —— 理由错比结论错更危险：
     * 它会把人引向一个正好会引入 bug 的「修复」。
     */
    setDocSheetRemote: (docId, sheetData) =>
      commit((s) => {
        const d = s.docs[docId]
        if (!d) return {}
        const next = { ...d, sheetData, updatedAt: Date.now() }
        // 同步基准必须跟上（见上面）：基准落后 → 下次差分把这一篇判成
        // 「本地又变了」→ 白推一趟。remoteDocHook 记的是服务端的样子。
        remoteDocHook?.(docId, next)
        return { docs: { ...s.docs, [docId]: next } }
      }, REMOTE_SAVE_DEBOUNCE_MS, REMOTE_SAVE_MAX_WAIT_MS),

    createDoc: (bookId, parentId, title, type = 'doc', initBlocks) => {
      /*
       * 建文稿要 `create`。和 `bookCreateBlocked` 的边界一样：
       * **问过且没有**才拒；没问过（caps 为 null）时放行 ——
       * 导入流程、小记转文档、顶栏的新建弹窗都不一定挂着知识库主页，
       * 按 null 就拒会把管理员正常建文档也一起挡掉。
       */
      if (bookCreateBlocked(bookId)) return ''
      const id = uid('d')
      commit((s) => {
        // 语雀：文档标题就是正文的第一个 H1 块，新建时预置空的 H1 占位
        const blocks: Block[] = initBlocks?.length ? initBlocks : [{ id: uid('bk'), type: 'h1', text: '' } as Block]
        const doc: Doc = {
          id,
          type,
          title: title || '未命名',
          /**
           * `body` 由 blocks 算出来，不是写死空串。
           *
           * 「小记 → 转为文档」传的是**真实正文**（`initBlocks` 里整条小记都在），
           * 而这里 `body: ''` 是硬编码的 —— 于是转出来的那篇文档
           * **导出是零字节、分享页是空白页、摘要也是空的**。
           *
           * 而且它**不经过 `setDocBlocks`**，所以 7.17 那个「在写入点算 body」
           * 的修复对它一点用没有。同一类根因（派生值没有单一来源）在
           * 两个写入点上各漏了一次 —— 所以两个点都算，而不是只修顺手碰到的那一个。
           */
          body: blocksToMarkdown(blocks),
          blocks,
          authorId: s.currentUser.id,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          /**
           * 默认可见性**从知识库设置读**。
           *
           * 原来这里写死 `'space'`，而 `BookSettings.defaultVisibility`
           * 在设置中心摆着 —— 管理员改完，界面显示「已改」，
           * 新建的文档却还是老可见性。那是个**改了没反应的开关**。
           */
          visibility: s.bookSettings[bookId]?.defaultVisibility || 'space',
          published: false,
          tags: [],
          likes: [],
          /**
           * 冗余存一份 bookId / spaceId。
           * 服务端判权限要走 doc→book→space；不填就得每次去查目录节点。
           * 早先这里不填，于是出现「服务端有权限、列表却不显示」——
           * 别人打开知识库根本看不到新建的文档，只有拿直链才进得去。
           * 服务端也留了经目录节点反查的兜底，但那是兜底，不是主路径。
           */
          bookId,
          spaceId: s.books.find((b) => b.id === bookId)?.spaceId,
          /*
           * ⚠️ 这里原来收尾是 `} as Doc` ——
           *   而这个字面量**缺必填字段**（`wordCount` 是下一行才算的），
           *   `as` 把「它不是 Doc」这件事整个盖住了，于是
           *   `npm run build` 一直报 TS2352「两者没有足够重叠」。
           *
           * 去掉断言，让类型检查说实话；缺的字段就地补上。
           * `as` 是纯类型操作、运行时零影响，所以去掉它不会改变任何行为。
           */
          wordCount: 0,
        }
        doc.wordCount = recomputeWordCount(doc)
        const siblings = s.nodes.filter((n) => n.bookId === bookId && n.parentId === parentId)
        const node: TreeNode = {
          id: uid('n'),
          bookId,
          parentId,
          title: doc.title,
          type,
          docId: id,
          /**
           * 落点：按知识库设置「文档新建位置」加到顶部或底部
           * （语雀：系统会根据该设置将其置于层级的顶部或底部）。
           *
           * 原来恒为 `siblings.length + 1` —— 也就是永远追加到最后，
           * 设置中心那个下拉框改了等于没改。
           *
           * 往顶部插时要把**同层已有节点整体后移**，否则会出现两个 order 相同，
           * 目录顺序就开始随机漂。top 用 `i + 2` 天然避开与第一项撞号。
           */
          order: s.bookSettings[bookId]?.newDocPosition === 'bottom'
            ? siblings.length + 1
            : 1,
        }
        const insertAtTop = s.bookSettings[bookId]?.newDocPosition !== 'bottom'
        const nodes = insertAtTop
          ? s.nodes.map((n) => (
              n.bookId === bookId && n.parentId === parentId
                ? { ...n, order: n.order + 1 }
                : n
            ))
          : s.nodes
        return {
          docs: { ...s.docs, [id]: doc },
          nodes: [...nodes, node],
          books: s.books.map((b) => (b.id === bookId ? { ...b, updatedAt: Date.now() } : b)),
        }
      })
      return id
    },

    /**
     * 建一篇文稿；**没有 `create` 权限时如实说不行**，返回 `''`。
     *
     * 为什么要有这个动作，而不是让每个入口自己判 `if (!id)`：
     * 实测 2026-10-14，同一个「被拒后仍然报成功」在**三个**入口各犯了一次 ——
     *   · `TopBar.tsx` 的新建弹窗：报「已新建」+ 跳 `/book/x/doc/`（**死链**）
     *   · `BookSettings.tsx` 目录管理的「新建文档」：同上
     *   · `DocPage.tsx` 的「在此新建文档」：报「已新建…在左侧目录中查看」，而树上什么都没有
     *
     * 后两种比「点了没反应」更糟：**它先让用户信了**。
     * 同一个判断写三遍，就有三遍会漏 —— 收进 store 之后只有这一处能写错。
     *
     * 成功时不弹提示（各入口的文案不一样：「已新建文档」/「在左侧目录中查看」），
     * 由调用方自己补；失败时这里**必须**弹，因为这一刻用户已经在等一个结果了。
     */
    createDocOrExplain: (bookId, parentId, title, type = 'doc') => {
      const id = get().createDoc(bookId, parentId, title, type)
      if (!id) get().toast('在这个知识库里没有新建文档的权限', 'error')
      return id
    },

    deleteDoc: (docId) => {
      /*
       * 权限第二道（见文件头 `bookEditBlocked`）。这一条比别处都严重：
       * 删掉之后本地那篇**真的从树上消失**、进了本地回收站，
       * 而服务端还好好地放着 → 顶栏挂出几条推不动的改动，
       * 他自己既删不掉也恢复不了（实测 2026-10-12，reader 与 visitor 都是 4 条）。
       *
       * 目录树的 `deleteNode` 早就有这道守卫，**文档这一层一直没接** ——
       * 同一个病，只是漏了一层。
       */
      if (bookEditBlocked(get().docs[docId]?.bookId)) return
      commit((s) => {
        const d = s.docs[docId]
        if (!d) return {}
        // bookId 必须在删节点**之前**取：服务端靠它判权限，
        // 缺了这条回收站记录对非管理员就是不可见的（等于删了但找不回来）
        const bookId = bookIdOfDoc(s, docId)
        return {
          docs: Object.fromEntries(Object.entries(s.docs).filter(([k]) => k !== docId)),
          /*
           * 目录节点**藏起来，不删掉**（与 `server/sync.ts` 的 `hideNodesOfDoc` 同一口径）。
           *
           * 以前这里是 `s.nodes.filter((n) => n.docId !== docId)` —— 节点被真删了，
           * 于是 `restoreFromTrash` 只能翻回 `docs.trashed`，**树上的位置找不回来**：
           * 文稿回到库里却哪儿都点不着，而提示写着「已还原到原位置」。
           * （实测 `test-trash-perms.mjs` ⑥：还原后 `nodes` 里 0 行引用它。）
           *
           * `Tree.tsx` 本来就不渲染 `hidden` 的节点，所以隐藏之后界面上
           * 和「删掉了」看不出差别，而还原能把位置放回去。
           * 真正该删节点的地方是永久删除（`purgeDoc` → 服务端 `purgeDocCore`）。
           */
          nodes: s.nodes.map((n) => (n.docId === docId ? { ...n, hidden: true } : n)),
          trash: [...s.trash, { docId, title: d.title, bookId, deletedAt: Date.now() }],
          activeDocId: s.activeDocId === docId ? null : s.activeDocId,
        }
      })
    },

      dropPurgedDocs: (docIds) => {
      const kill = new Set(docIds)
      commit(() => {
        const docs = { ...get().docs }
        for (const id of kill) delete docs[id]
        return {
          docs,
          trash: get().trash.filter((t) => !kill.has(t.docId)),
          // 目录节点里的 docId 也要摘，否则树里点进去是空白
          nodes: get().nodes.map((n) => (n.docId && kill.has(n.docId)
            ? { ...n, docId: '' }
            : n)),
        }
      })
    },

  restoreFromTrash: (docId) => {
      const item = get().trash.find((t) => t.docId === docId)
      if (!item) return
      /*
       * 权限第二道（见文件头 `bookEditBlocked`）。
       *
       * ⚠️ 诚实地标注强度：这一层**不是关键那道防线** ——
       * 它本来就已经是「先问服务端、失败不动本地」的正确写法
       * （服务端 `restoreDoc` 判 `capsInBook().edit`，被拒时只弹一条错误、
       * 本地那行纹丝不动）。所以这里加的不是「原来会丢数据」，
       * 只是把一次注定失败的往返省掉，并把原因说得更准。
       * 真正补上的短板在界面那一侧：`BookSettings` 的 `BookTrashTab`
       * 和 `/trash` 页以前对**所有角色**都渲染出可点的按钮。
       *
       * 判据仍然只用「问过且没有」：回收站常在**还没挂过树**的 `/trash` 页被看，
       * 那时 caps 一直是 null，按 null 就拦会把管理员的正常还原一起拒掉。
       */
      if (bookEditBlocked(item.bookId)) {
        get().toast('没有恢复该文档的权限（服务端要求编辑权）', 'error')
        return
      }
      // 恢复必须由服务端执行：本地已经没有那份正文了（软删除时从 store 移除了），
      // 之前这里只是把回收站条目删掉、弹一句「已恢复，请重新归档」——
      // 而服务端那份早就被硬删了，等于什么都没恢复。
      // 现在服务端是软删除，正文原封不动，翻回标记即可。
      void (async () => {
        try {
          const { restoreDoc } = await import('@/lib/api')
          if (getMode() === 'server') {
            const r = await restoreDoc(docId)
            const st = get()
            /*
             * 把目录树里的位置一并放回来（`deleteDoc` 软删时只是**藏**了节点）。
             * 服务端 `restoreDoc` 也会清 `hidden`，但那要等下一轮同步 ——
             * 这一屏里用户看到的是「已还原」却找不到它，得等几秒才出现。
             */
            const nodes = st.nodes.map((n) => (n.docId === docId ? { ...n, hidden: false } : n))
            if (r?.doc) {
              // 正文原样拿回来（含历史版本），标成已加载
              const doc = { ...(r.doc as any), _loaded: true }
              st.applyRemote({ docs: { ...st.docs, [docId]: doc }, nodes, trash: st.trash.filter((t) => t.docId !== docId) })
            } else {
              st.applyRemote({ nodes, trash: st.trash.filter((t) => t.docId !== docId) })
            }
            get().toast(`已恢复「${item.title}」`, 'success')
            return
          }
        } catch (e: any) {
          get().toast(e?.message || '恢复失败', 'error')
          return
        }
        // 本地模式：只能恢复条目，正文确实已经随 localStorage 一起没了
        // （目录节点照样放回树上 —— 它没跟着正文一起丢）
        commit((s) => ({
          nodes: s.nodes.map((n) => (n.docId === docId ? { ...n, hidden: false } : n)),
          trash: s.trash.filter((t) => t.docId !== docId),
        }))
        get().toast(`已从回收站移除「${item.title}」。本地模式下正文无法找回`, 'info')
      })()
    },

    /**
     * 删除知识库（硬删）。**先问服务端、成功了才动本地**。
     *
     * 顺序不能反：服务端发现有文档删不掉时会整次中止（库还在那儿），
     * 这时候如果本地先把库从列表里摘掉，刷新一下它又回来了 ——
     * 用户看到的是「提示说没删掉、库却时有时无」，比报错更难信。
     */
    deleteBook: async (bookId) => {
      const st0 = get()
      const book = st0.books.find((b) => b.id === bookId)
      const docIds = new Set(
        st0.nodes.filter((n) => n.bookId === bookId && n.docId).map((n) => String(n.docId)),
      )

      if (getMode() === 'server') {
        const { deleteBookRemote } = await import('@/lib/api')
        const r = await deleteBookRemote(bookId)   // 失败会抛，交给调用方如实显示
        commit((s) => {
          const docs = { ...s.docs }
          for (const id of docIds) delete docs[id]
          return {
            books: s.books.filter((b) => b.id !== bookId),
            nodes: s.nodes.filter((n) => n.bookId !== bookId),
            docs,
            // 回收站里属于这个库的行也一并摘掉：库都没了，
            // 留着就是「恢复回来也点不动」的孤儿条目
            trash: s.trash.filter((t) => t.bookId !== bookId),
            favorites: s.favorites.filter((f) => !(f.targetType === 'book' && f.targetId === bookId)),
            bookMembers: Object.fromEntries(Object.entries(s.bookMembers).filter(([k]) => k !== bookId)),
            bookSettings: Object.fromEntries(Object.entries(s.bookSettings).filter(([k]) => k !== bookId)),
            activeDocId: s.activeDocId && docIds.has(s.activeDocId) ? null : s.activeDocId,
          }
        })
        get().toast(`已删除知识库「${book?.name || ''}」及其 ${r?.purgedDocs ?? docIds.size} 篇文档，不可恢复`, 'success')
        return { purgedDocs: Number(r?.purgedDocs ?? docIds.size) }
      }

      // 本地模式：没有服务端，直接从本地摘干净（同样不可恢复）
      commit((s) => {
        const docs = { ...s.docs }
        for (const id of docIds) delete docs[id]
        return {
          books: s.books.filter((b) => b.id !== bookId),
          nodes: s.nodes.filter((n) => n.bookId !== bookId),
          docs,
          trash: s.trash.filter((t) => t.bookId !== bookId),
          favorites: s.favorites.filter((f) => !(f.targetType === 'book' && f.targetId === bookId)),
        }
      })
      get().toast(`已删除知识库「${book?.name || ''}」及其 ${docIds.size} 篇文档，不可恢复`, 'success')
      return { purgedDocs: docIds.size }
    },

    toggleFavorite: (targetType, targetId, title) =>
      commit((s) => {
        const exists = s.favorites.find((f) => f.targetType === targetType && f.targetId === targetId)
        if (exists) return { favorites: s.favorites.filter((f) => f.id !== exists.id) }
        return { favorites: [{ id: uid('f'), targetType, targetId, title, createdAt: Date.now() }, ...s.favorites] }
      }),

    isFavorite: (targetType, targetId) =>
      get().favorites.some((f) => f.targetType === targetType && f.targetId === targetId),

    /* ---------------- 关注 ---------------- */
    toggleFollow: (targetType, targetId) =>
      commit((s) => {
        const exists = (s.follows || []).find((f) => f.targetType === targetType && f.targetId === targetId)
        if (exists) return { follows: (s.follows || []).filter((f) => f.id !== exists.id) }
        return { follows: [...(s.follows || []), { id: uid('fo'), targetType, targetId, createdAt: Date.now() }] }
      }),

    isFollowing: (targetType, targetId) =>
      (get().follows || []).some((f) => f.targetType === targetType && f.targetId === targetId),

    /* ---------------- 目录树 ---------------- */
    /* ---------------- 目录树写操作：权限第二道 ---------------- */
    renameNode: (nodeId, title) =>
      commit((s) => {
        const n = s.nodes.find((x) => x.id === nodeId)
        if (!n || bookEditBlocked(n.bookId)) return {}
        if (!n) return {}
        const nodes = s.nodes.map((x) => (x.id === nodeId ? { ...x, title } : x))
        // 同步文档标题 —— 走 `withSyncedTitle`，它把**首个 h1 块和 body** 一起带上。
        // 这里以前是 `{...doc, title}`，于是从侧边树改名会留下同样的分叉：
        // 目录显示新名、导出出来还是旧标题（见 withSyncedTitle 那段注释）。
        const docs = n.docId && s.docs[n.docId]
          ? { ...s.docs, [n.docId]: withSyncedTitle(s.docs[n.docId], title) }
          : s.docs
        return { nodes, docs }
      }),

    createNode: (bookId, parentId, type) => {
      // 建目录项要 `create`。以前这条完全没有守卫 ——
      // 阅读者在知识库主页点「新建分组」会真的多出一个节点，
      // 服务端再拒，而他本地留下一个改不掉的目录（实测 2026-10-12）。
      if (bookCreateBlocked(bookId)) return ''
      if (type === 'group') {
        const id = uid('n')
        commit((s) => {
          const siblings = s.nodes.filter((n) => n.bookId === bookId && n.parentId === parentId)
          return {
            nodes: [
              ...s.nodes,
              { id, bookId, parentId, title: '新分组', type: 'group', order: siblings.length + 1, children: [] },
            ],
          }
        })
        return id
      }
      return get().createDoc(bookId, parentId, '未命名', type as DocType)
    },

    moveNode: (nodeId, newParentId, newIndex) =>
      commit((s) => {
        // 防环：不能把节点移动到自己或自己的子孙下
        const isDescendant = (target: string, ancestor: string): boolean => {
          let cur = s.nodes.find((n) => n.id === target)
          while (cur?.parentId) {
            if (cur.parentId === ancestor) return true
            cur = s.nodes.find((n) => n.id === cur!.parentId)
          }
          return false
        }
        if (nodeId === newParentId || (newParentId && isDescendant(newParentId, nodeId))) return {}

        const moving = s.nodes.find((n) => n.id === nodeId)
        if (moving && bookEditBlocked(moving.bookId)) return {}   // 见文件头 bookEditBlocked
        if (!moving) return {}

        // 原位置重排
        const oldSibs = s.nodes
          .filter((n) => n.bookId === moving.bookId && n.parentId === moving.parentId && n.id !== nodeId)
          .sort((a, b) => a.order - b.order)
          .map((n, i) => ({ ...n, order: i + 1 }))

        // 新位置插入
        const newSibs = s.nodes
          .filter((n) => n.bookId === moving.bookId && n.parentId === newParentId && n.id !== nodeId)
          .sort((a, b) => a.order - b.order)
        newSibs.splice(Math.max(0, Math.min(newIndex, newSibs.length)), 0, { ...moving, parentId: newParentId })

        const reindexed = newSibs.map((n, i) => ({ ...n, order: i + 1 }))
        const touched = new Map<string, TreeNode>()
        // 注意：不能把 moving 放进 touched —— reindexed 里已经包含了它的最新副本
        // （新 parentId + 新 order），moving 是移动前的旧对象，放在后面会把它覆盖回去，
        // 导致 moveNode 静默失效（拖拽看起来成功，节点却没动）
        ;[...oldSibs, ...reindexed].forEach((n) => touched.set(n.id, n))
        const nodes = s.nodes.map((n) => touched.get(n.id) || n)
        return { nodes }
      }),

    deleteNode: (nodeId) =>
      commit((s) => {
        // 权限第一道（见文件头 bookEditBlocked）：没有编辑权就**别把节点摘掉**。
        // 摘掉之后界面会显示「已删除」而服务端拒绝，用户被留在一个
        // 删不掉、也恢复不了的状态里。
        const target0 = s.nodes.find((x) => x.id === nodeId)
        if (target0 && bookEditBlocked(target0.bookId)) return {}
        // 递归收集所有子孙
        const collect = (id: string, acc: string[] = []): string[] => {
          const n = s.nodes.find((x) => x.id === id)
          if (!n) return acc
          acc.push(id)
          s.nodes.filter((x) => x.parentId === id).forEach((c) => collect(c.id, acc))
          return acc
        }
        const ids = new Set(collect(nodeId))
        const docIds = new Set(
          s.nodes.filter((n) => ids.has(n.id) && n.docId).map((n) => n.docId!),
        )
        const deletedDocs = Object.values(s.docs).filter((d) => docIds.has(d.id))
        /*
         * ⚠️ `bookId` 和 `deleteDoc` 里那条一样，**必须有** ——
         * 少了它，服务端 bootstrap 按 bookId 判权限时会把这条回收站记录滤掉，
         * 于是「从目录树删掉的文档在回收站里看不到、也恢复不了」，
         * 而正文还躺在库里（`docs.trashed = 1`）。
         *
         * 这不是假设：实测（2026-10-09 部署实例）17 条回收站行
         * `bookId` 全是 NULL，接口返回 0 条，库里却有 17 行 trashed=1 ——
         * 典型的「删了但找不回来」。
         *
         * 同一个文件里的 `deleteDoc` 早就写了这句注释
         * （「服务端靠它判权限，缺了这条回收站记录对非管理员就是不可见的」），
         * 说明这个问题被发现过、修了一条路径，**漏了另一条**。
         */
        const bookIdOf = (docId: string) => bookIdOfDoc(s, docId)
        return {
          nodes: s.nodes.filter((n) => !ids.has(n.id)),
          docs: Object.fromEntries(Object.entries(s.docs).filter(([k]) => !docIds.has(k))),
          trash: [
            ...s.trash,
            ...deletedDocs.map((d) => ({
              docId: d.id,
              title: d.title,
              bookId: bookIdOf(d.id),
              deletedAt: Date.now(),
            })),
          ],
        }
      }),

    /* ---------------- 知识库 ---------------- */
    createBook: (spaceId, name, desc = '') => {
      /*
       * ★ 服务端只允许**空间管理员**建库（`denyReason` 的 books 分支）。
       *   这里必须**先问一句再建**，否则会出现这一整串假象：
       *
       *   1. 按钮在界面上一视同仁地摆着，四个入口都没判角色；
       *   2. 点一下 → 库里立刻出现一个库 → toast「知识库已创建」→ 跳进去；
       *   3. 服务端把 books / bookSettings / bookMembers **三行一起拒掉**
       *      （`你不是「X」这个空间的管理员，没法在里面建知识库`）；
       *   4. 而那个库**刷新也不消失**（实测 2026-10-12 探针）——
       *      本地 store 留着它，地址能打开，里面空的，服务端根本不知道它。
       *
       *   也就是说：一句「已创建」，换来一个永远同步不出去的空壳。
       *   在这个壳里继续写的文档也**一篇都传不上去**。
       *
       *   拒在 store 而不是只藏按钮，是为了让**任何调用方都无从说谎** ——
       *   界面入口以后还会增加，只改按钮迟早漏一处。
       *
       * 本地形态没有服务端，也就没有这条规则：照旧放行。
       */
      if (!get().canCreateBookIn(spaceId)) return ''
      const id = uid('b')
      const now = Date.now()
      /*
       * ⚠️ 这里原来没写返回类型，于是 TS 把这个回调推成
       *   `{} | { books; bookMembers; bookSettings }` 的联合，
       *   而 `bookMembers` 的每一格又推成「旧数组 | 新数组」的联合 ——
       *   结果整个回调**不满足 `Partial<Store>`**，`npm run build` 报 TS2345。
       *
       * 写上返回类型，让类型检查**指着具体是哪个字段**不对，
       * 而不是甩一句「整个回调都不对」。
       */
      commit((s): Partial<Store> => {
        /*
         * 兜底：传进来的空间不存在就用第一个真实存在的。
         *
         * 背景见下面 hydrate 里那段注释 —— `activeSpaceId` 的默认值是种子里的
         * `'s1'`，服务端形态下通常没有这个空间，于是 book.spaceId 成了
         * 悬空外键，被服务端逐条判定拒掉（`FOREIGN KEY constraint failed`），
         * 而 push 仍是 HTTP 200、客户端又不看 `rejected` ——
         * 表现就是「建好了但刷新就没」。
         *
         * hydrate 已经校正过一次，这里是第二道：别让任何一个悬空 id 流出去。
         * 一个空间都没有时直接不建 —— 建了也是白建，
         * 而且会在界面上留下一个刷新就消失的假知识库。
         */
        const spaces = s.spaces || []
        const realSpaceId = spaces.some((sp) => sp.id === spaceId) ? spaceId : spaces[0]?.id
        if (!realSpaceId) return {}
        return {
          books: [
            {
              id,
              spaceId: realSpaceId,
              name,
              desc,
              avatar: '📚',
              visibility: 'private',
              createdAt: now,
              updatedAt: now,
            },
            ...s.books,
          ],
        // 创建者自动成为这个知识库的 owner。
        //
        // 不加这一条的话：服务端 capsInBook 对「不是空间 owner/admin 且没有
        // book_members 行」的人返回 NONE —— 于是一个**普通成员**新建的
        // 知识库，他自己打不开。平台 owner 和空间管理员看不出来（他们本来
        // 就绕过成员表），所以只有普通同事建库时才会撞上。
        //
        // 和 books 放在同一次 commit 里，是为了只产生一条同步记录。
        bookMembers: {
          ...s.bookMembers,
          [id]: [
            {
              id: s.currentUser.id,
              role: 'owner' as BookMember['role'],
              perms: permsForRole('owner'),
              joinedAt: now,
            },
          ],
        },
        /**
         * 新库同时铺一条**默认设置行**（2026-10-12 补）。
         *
         * 以前只建了 books 与 book_members，服务端因此**根本没有这一行** ——
         * 而服务端要靠它判公开访问、IP 白名单、导出限制、水印、
         * 搜索屏蔽、**离职权限自动回收**。
         *
         * 最要命的是最后那个：它的缺省值是「开」（列定义、默认值、界面三处都是开），
         * 可缺行在 `LEFT JOIN` 上出来是 NULL、被读成了「关」。
         * 实测（探针，2026-10-12，真服务端）：UI 新建的库 + 加了成员 +
         * 一个字设置都没碰 → 办理离职时 `revokedBooks=0`，
         * 离职的人**权限原封不动**，而界面上那个开关显示的是「已开启」。
         *
         * 服务端那一侧已经用 `COALESCE(bs.autoRevoke, 1)` 兜住了
         * （安全向的判据不能因为「读不出来」就放过），这里补的是**根因**：
         * 让「一个刚建的库在服务端没有设置行」这个状态**不再存在**，
         * 顺带其余五个开关也从此有服务端那一行可读。
         *
         * 用 `defaultBookSettings()` 而不是手写一份 ——
         * 「同一份列清单有好几处、漏一处就静默失效」这件事本项目已经吃过一次
         * （见 `server/sync.ts` 里 WATCHED 那段注释）。
         *
         * 和 books / bookMembers 放在同一次 commit 里：只产生一条同步记录。
         */
        bookSettings: {
          ...s.bookSettings,
          [id]: defaultBookSettings(),
        },
        }
      })
      // 一个空间都没有 → 上面的 commit 返回了 {}，这时不该返回一个 id，
      // 否则调用方会拿着一个根本没建出来的 id 去跳转。
      return get().books.some((b) => b.id === id) ? id : ''
    },

    updateBook: (bookId, patch) =>
      commit((s) => ({ books: s.books.map((b) => (b.id === bookId ? { ...b, ...patch } : b)) })),

    /* ---------------- 评论 ---------------- */
    /**
     * 删掉一条评论，连带它下面的回复一起删。
     *
     * 之前根本没有这个 action —— 评论一旦发出去就撤不回来。
     * 对内网知识库这不是小事：贴错了内部链接、写了不该公开的内容，
     * 唯一的办法是找管理员去数据库里改行。
     *
     * 回复必须一起删，否则会留下一堆挂在一个不存在的评论下面的孤儿。
     * 差分会自动算出这两批 remove（评论走通用路径，回复走 comments 分支里
     * extractReplies 摊平后的那条），客户端不需要额外处理。
     */
    deleteComment: (docId: string, commentId: string) => {
      // 权限第二道（见文件头 commentBlocked）。服务端对删除也先判 caps.comment，
      // 再判「只能删自己发的」—— 这里是前一半。
      if (commentBlocked(docId)) return
      commit((s) => ({
        comments: {
          ...s.comments,
          [docId]: (s.comments[docId] || []).filter((c) => c.id !== commentId),
        },
      }))
    },

    addComment: (docId, text) => {
      if (commentBlocked(docId)) return
      commit((s) => {
        const c: Comment = {
          id: uid('c'),
          docId,
          authorId: s.currentUser.id,
          text,
          createdAt: Date.now(),
          replies: [],
        }
        return { comments: { ...s.comments, [docId]: [...(s.comments[docId] || []), c] } }
      })
    },

    addReply: (docId, parentId, text) => {
      if (commentBlocked(docId)) return
      commit((s) => {
        const list = s.comments[docId] || []
        const replies = list.map((c) =>
          c.id === parentId
            ? { ...c, replies: [...(c.replies || []), { id: uid('c'), docId, authorId: s.currentUser.id, text, createdAt: Date.now(), replies: [] }] }
            : c,
        )
        return { comments: { ...s.comments, [docId]: replies } }
      })
    },

    /* ---------------- 讨论区（话题回复）---------------- */

    /* ---------------- 讨论区：发起话题 ---------------- */
    /**
     * 发起一个话题。
     *
     * ⚠️ 为什么现在才补（2026-10-12）：`topics` 这个实体**从来只能看、不能写**。
     *   表在（`server/db.ts` 的 `topics`）、实体在（`writable` 七项齐全）、
     *   类型在、同步形状在（`SHAPE.topics = 'array'`）——
     *   **只缺一个写入路径和一个按钮**。而三处文案都承诺了它：
     *   · `Space.tsx` 的空状态：「同事新建文档、评论或**发起话题**之后会出现在这里」
     *   · `Dashboard.tsx` 的空状态：同一句
     *   · `Help.tsx`：「遇到问题可以直接在讨论区**发帖**」+ 一个「去讨论区」按钮
     *   连动态流都备好了 `what: '发起了话题'` 那一支。
     *
     *   所以正确做法是**把能力补上**，不是把那三句改成「不能发帖」——
     *   后者才是把假承诺换成另一句假承诺。
     *
     * 正文落在**第一条回复**里：`Topic` 这个类型只有标题，
     * 内容本来就在 `topicReplies`（列表页也只显示标题 + 回复数）。
     * 不给正文就只建一个标题空贴。
     *
     * 返回新话题的 id；标题为空返回 ''（调用方据此不弹成功提示）。
     */
    createTopic: (spaceId, title, text = '') => {
      const t = String(title || '').trim()
      if (!t) return ''
      // 权限第二道（见文件头 spaceCommentBlocked）：讨论区是**空间级**的，
      // 服务端按 `capsInSpace().comment` 判，不是知识库的 edit。
      if (spaceCommentBlocked(spaceId)) return ''
      const body = String(text || '').trim()
      const id = uid('tp')
      const now = Date.now()
      commit((s) => {
        const topic: Topic = {
          id,
          spaceId: String(spaceId || ''),
          title: t,
          authorId: s.currentUser.id,
          createdAt: now,
          /**
           * 种子里的 `replyCount` 是历史值，界面上**不准直接显示**它
           * （见 types 里那一段的注释）。这里按真数给：
           * 有正文就是 1 条回复，没有就是 0。
           */
          replyCount: body ? 1 : 0,
          participants: body ? [s.currentUser.id] : [],
          hot: false,
        }
        return {
          topics: [topic, ...(s.topics || [])],
          // 正文作为第一条回复 —— 和上面的 commit 放一起，只产生一条同步记录
          topicReplies: body
            ? [...(s.topicReplies || []), { id: uid('tr'), topicId: id, authorId: s.currentUser.id, text: body, createdAt: now }]
            : s.topicReplies || [],
        }
      })
      return id
    },

    replyToTopic: (topicId, text) => {
      const t = String(text || '').trim()
      // 空回复不落库：界面上按钮已经禁用了，这里再挡一次是防脚本直接调。
      // 落了空行的话，回复条数会多一条，而正文什么都没有。
      if (!t) return ''
      // 权限第二道（见文件头 spaceCommentBlocked）：先由话题反查它属于哪个空间。
      const topic = (get().topics || []).find((x) => x.id === topicId)
      // ⚠️ **查不到就当没有权限**，不能放过去 ——
      // 不是空间成员的话，那个话题压根不会进他的 `topics`，
      // 于是 `topic` 是 undefined、`spaceId` 也无从得知，
      // `spaceCapsSync(undefined)` 返回 null（「没问过」）→ 守卫**静默放行**。
      // 实测正是这样：`loadSpaceCaps('s1')` 已经回全 false 了，
      // `replyToTopic` 照样成功、本地多出一条回复（实测 2026-10-12）。
      // 「反查不到」不是「没权限」，但在这条路上它只能按「没有」处理 ——
      // 界面本来也不会对一个看不见的话题给出回复框。
      if (!topic) return ''
      if (spaceCommentBlocked(topic.spaceId)) return ''
      const rid = uid('tr')
      commit((s) => ({
        topicReplies: [
          ...(s.topicReplies || []),
          { id: rid, topicId, authorId: s.currentUser.id, text: t, createdAt: Date.now() },
        ],
      }))
      return rid
    },

    getTopicReplies: (topicId) =>
      (get().topicReplies || []).filter((r) => r.topicId === topicId).sort((a, b) => a.createdAt - b.createdAt),

    getTopicReplyCount: (topicId) =>
      (get().topicReplies || []).reduce((n, r) => (r.topicId === topicId ? n + 1 : n), 0),

    /** 参与者按**真实回复**算（见声明处那段注释：快照那个字段从不维护） */
    getTopicParticipants: (topicId) => {
      const s = get()
      const topic = (s.topics || []).find((t) => t.id === topicId)
      if (!topic) return []
      const authors = (s.topicReplies || []).filter((r) => r.topicId === topicId).map((r) => r.authorId)
      return [...new Set([topic.authorId, ...authors].filter(Boolean))]
    },

    /* ---------------- 小记 ---------------- */
    /**
     * 问服务端「我在这个空间里是不是管理员」。
     *
     * 复用 `/api/spaces/:id/members` 的 `isAdmin` —— 它本来就在返回，
     * `Space.tsx` 的成员名册用的就是它。这里只是把答案**留在 store 里**，
     * 好让另外三个建库入口也能用同一份判据。
     *
     * ⚠️ 走的是 `GET /api/perms/space/:id`（2026-10-12 新加），**不是**
     *   拿空间 id 去问 `/api/perms/book/:id` —— 那会得到**全 false**，
     *   于是空间管理员的「新建知识库」按钮整个消失（而服务端放他过）。
     *   我第一版就是这么写的，探针只测了平台管理员（他早退 true）所以没露出来。
     *
     * 失败时记「只有 read」而不是「没有权限」：
     * 「查不到」在界面上表现成「不给入口」是对的，
     * 而一组全 false 会被读成「你不是管理员」—— 那是**关于人的断言**，
     * 而我们其实什么都不知道。
     */
    loadSpaceCaps: async (spaceId) => {
      const id = String(spaceId || '')
      if (!id) return false
      if (getMode() !== 'server') return true
      try {
        const c = await spacePerms(id)
        const v = { read: true, comment: false, edit: false, create: false, export: false, share: false, admin: false, ...(c as any) }
        primePermsCache('space', id, v)   // 见 setSpaceCaps 里那条：两处都要写
        set((s) => ({ spaceCaps: { ...s.spaceCaps, [id]: v } }))
        return v.admin === true
      } catch {
        primePermsCache('space', id, { read: true, comment: false, edit: false, create: false, export: false, share: false, admin: false })
        set((s) => ({ spaceCaps: { ...s.spaceCaps, [id]: { read: true, comment: false, edit: false, create: false, export: false, share: false, admin: false } } }))
        return false
      }
    },

    /**
     * 直接记下一个已知的空间判据（不发请求）。
     *
     * 给「本来就已经拿到了这个答案」的调用方用 —— `Space.tsx` 的成员名册
     * 调的就是同一个接口（`/api/spaces/:id/members` 返回 `isAdmin`），
     * 让它顺手写进来，另外三个建库入口就能复用同一份结果。
     */
    setSpaceCaps: (spaceId, value) => {
      const id = String(spaceId || '')
      if (!id) return
      // ⚠️ **两处都要写**：store 切片给界面读，`primePermsCache` 给
      //    `spaceCapsSync` 读 —— 后者是 store 层那些守卫的判据来源。
      //    只写切片的话守卫永远读到 null，「问过才拦」就成了「永远不拦」。
      primePermsCache('space', id, value)
      set((s) => ({ spaceCaps: { ...s.spaceCaps, [id]: value } }))
    },

    canCreateBookIn: (spaceId) => {
      // 本地形态没有服务端，也就没有这条规则 —— 谁都能建
      if (getMode() !== 'server') return true
      const role = get().currentUser.role
      // 平台 owner/admin 直接放行（服务端 denyReason 里也是这个早退）
      if (role === 'owner' || role === 'admin') return true
      // ⚠️ 读 store 切片（`loadSpaceCaps` 写的就是它），不是 lib 里那个 hook 缓存
      return get().spaceCaps[String(spaceId || '')]?.admin === true
    },

    createSpace: async (name, desc = '') => {
      const n = String(name || '').trim()
      if (!n) return null
      if (getMode() !== 'server') {
        // 本地模式：没有服务端，直接写 store
        const id = `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
        const now = Date.now()
        commit((s) => ({
          spaces: [...s.spaces, { id, name: n, desc: desc || '', avatar: '🏢', kind: 'team', createdAt: now, memberCount: 1 } as any],
        }))
        return id
      }
      const r = await createSpaceRemote(n, desc || '')
      const sp = r?.space
      if (!sp) return null
      commit((s) => (s.spaces.some((x) => x.id === sp.id) ? {} : { spaces: [...s.spaces, sp as any] }))
      return String(sp.id)
    },

    deleteSpace: async (spaceId, password) => {
      const sid = String(spaceId || '')
      if (!sid || !password) return null
      if (getMode() !== 'server') {
        // 本地模式没有服务端就没有权限/口令可验，但「删了就从列表里摘掉」必须照样发生
        commit((s) => ({ spaces: s.spaces.filter((x) => x.id !== sid) }))
        return { undoUntil: 0, deletedBooks: 0 }
      }
      const r = await deleteSpaceRemote(sid, password)
      if (!r || r.ok === false) return null
      /*
       * 本地立刻摘掉，别等下一轮同步 ——
       * 服务端已经把 `changesSince` 那侧接上了，但用户点完还站在
       * 一个已经不存在了的空间的页面上，看着就是「点了没反应」。
       *
       * 顺手把**原来那一行**留一份：撤销时原样放回去 ——
       * 既不用重新拉一次全量，也不用自己拼半行（拼错了会漏成员数）。
       */
      const gone = get().spaces.find((x) => x.id === sid)
      if (gone) pendingSpaceRestore.set(sid, gone)
      commit((s) => ({ spaces: s.spaces.filter((x) => x.id !== sid) }))
      return {
        undoUntil: Number(r.undoUntil || 0),
        deletedBooks: Number(r.deletedBooks || 0),
      }
    },

    restoreSpace: async (spaceId) => {
      const sid = String(spaceId || '')
      if (!sid) return false
      if (getMode() !== 'server') return false
      const r = await restoreSpaceRemote(sid)
      if (!r || !r.restored) return false
      const back = pendingSpaceRestore.get(sid)
      pendingSpaceRestore.delete(sid)
      if (back) commit((s) => (s.spaces.some((x) => x.id === sid) ? {} : { spaces: [...s.spaces, back] }))
      /*
       * 服务端那一侧已经是权威（行上的 deletedAt 已清零），
       * 这里**不需要**重新拉全量：下一轮同步会把它对齐。
       * 拉全量反而会在「服务端已恢复、增量还没到」的当口把状态搅乱。
       */
      return true
    },

    addNote: (spaceId, text) => {
      // 「存小记」是**空间级**动作（notes 走 `isSpaceLevel`），判的是空间里的 comment。
      // 以前完全没门：非空间成员点一下，本地真的多出一条小记，服务端拒，
      // 顶栏常驻「N 处修改没有保存」而本人修不好。
      const c = spaceCapsSync(spaceId)
      if (c !== null && !c.comment) return ''
      const nid = uid('n')
      commit((s) => ({
        notes: [
          { id: nid, spaceId, text, authorId: s.currentUser.id, createdAt: Date.now(), likes: [], tags: [] },
          ...s.notes,
        ],
      }))
      return nid
    },

    likeNote: (noteId) => {
      // 权限第二道（见文件头 spaceCommentBlocked）：`notes` 是空间级实体，
      // 服务端按 `capsInSpace().comment` 判。点赞是 `notes.likes` 这一列，
      // 一样要跟着走 —— 不然非空间成员点赞就是假动作。
      const note = (get().notes || []).find((n) => n.id === noteId)
      if (spaceCommentBlocked(note?.spaceId)) return
      commit((s) => ({
        notes: s.notes.map((n) => {
          if (n.id !== noteId) return n
          const liked = n.likes.includes(s.currentUser.id)
          return {
            ...n,
            likes: liked ? n.likes.filter((l) => l !== s.currentUser.id) : [...n.likes, s.currentUser.id],
          }
        }),
      }))
    },

    /**
     * 点赞 / 取消点赞一篇文稿。
     *
     * ⚠️ 以前文档页那个 👍 是**假的**：数字写死成
     * `3 + (Number(docId.slice(-1)) || 0) * 2`（按 id 末位算出来），
     * 状态只在组件的 useState 里，刷新就没、换设备不同步、服务端也没这概念。
     * 看着像「有人赞过」，其实谁都没赞 —— 和「重置演示数据把 26 篇假文档推上真库」
     * 是同一类：**界面在展示一个它并不掌握的数据**。
     *
     * 现在落到 `doc.likes`（userId 数组，照 `notes.likes` 的形状），
     * 会跟着同步走，所以换设备也看得见。语雀工作台的「我点赞的」视图靠它。
     */
    toggleDocLike: (docId) =>
      commit((s) => {
        const d = s.docs[docId]
        if (!d) return {}
        const likes = Array.isArray(d.likes) ? d.likes : []
        const liked = likes.includes(s.currentUser.id)
        return {
          docs: {
            ...s.docs,
            [docId]: {
              ...d,
              likes: liked ? likes.filter((l) => l !== s.currentUser.id) : [...likes, s.currentUser.id],
            },
          },
        }
      }),

    touchDoc: (docId) =>
      commit((s) => ({
        recents: [{ docId, viewedAt: Date.now() }, ...s.recents.filter((r) => r.docId !== docId)].slice(0, 20),
      })),

    /**
     * 置顶 / 取消置顶一篇文稿。
     *
     * ⚠️ **刻意不改 `updatedAt`**，理由和下面那句一样重要：
     *   置顶不是一次编辑。把「更新时间」改成「置顶时间」会让
     *   「最近更新」列表、知识库列表的排序、文档头的「N 前更新」全都说谎。
     *   同理 `toggleDocLike` 也不改。
     *
     *   那怎么同步上去？靠 `pinnedAt` **自己参与差分比较**
     *   （见 `src/lib/sync.ts` 的 DOC_COMPARE_FIELDS 注释）。
     *   在那之前它压根不同步 —— 实测过：本地 pinnedAt 有值、
     *   服务端是 0，而界面**一声不吭**。
     *
     * 只存「置顶没置顶 + 什么时候」，**不动树上的 order**：
     * 显示顺序由渲染层算（Tree.tsx 的 pinFirst），取消置顶就精确回原位，
     * 而且不会因为点一下置顶就把整棵目录树改写一遍（那要走同步 + 审计）。
     *
     * 归一到 null：本地新建的文档没有这个键，服务端下发的是 null。
     * 两种都读成「没置顶」。
     */
    togglePinDoc: (docId) => {
      /*
       * ⚠️ 这里原来写的是 `useStore.getState().docs[docId]`。
       *
       * 那是一次**自我引用** —— store 的类型要从这个字面量推断出来，
       * 而这个字面量里的表达式又要先知道 store 的类型。TypeScript 解不开，
       * 于是 `useStore` 的类型塌掉，**全项目**每一个 `useStore((s) => …)`
       * 拿到的 `s` 都退化成 `unknown` —— 表现为几百条
       * 「'd' is of type 'unknown'」散布在十几个文件里。
       *
       * 同文件里其他方法一直用的是 `get()`（zustand 给的取当前 state 的入口），
       * 它不构成自我引用。改成 `get()` 即可，行为完全一样。
       */
      const d = get().docs[docId]
      if (!d) return null
      // 置顶写的是 docs（要 edit 权限）—— 和上面那几个目录写操作同一道守卫
      if (bookEditBlocked(d.bookId)) return null
      const pinned = Number(d.pinnedAt) > 0
      const next = pinned ? null : Date.now()
      commit((s) => {
        const cur = s.docs[docId]
        if (!cur) return {}
        return { docs: { ...s.docs, [docId]: { ...cur, pinnedAt: next } } }
      })
      return next
    },

    /* ---------------- 知识库设置中心 ---------------- */
    getBookSettings: (bookId) => ({
      ...defaultBookSettings(),
      ...(get().bookSettings[bookId] || {}),
    }),

    updateBookSettings: (bookId, patch) => {
      // 权限第二道（见文件头 bookAdminBlocked）。
      // `bookSettings` 是服务端按 **admin** 判的实体，而这一节以前**完全没门** ——
      // 安全设置页那五个开关（导出限制 / 水印 / IP 白名单 / 屏蔽词 / 离职回收）
      // 谁都点得动，点完本地变了、服务端拒，顶栏挂一条修不好的告警。
      if (bookAdminBlocked(bookId)) return
      commit((s) => ({
        bookSettings: {
          ...s.bookSettings,
          [bookId]: { ...defaultBookSettings(), ...(s.bookSettings[bookId] || {}), ...patch },
        },
      }))
    },

    /**
     * 知识库里**显式配置过**的成员。
     *
     * 这里曾经有个回退：查不到就按空间成员编一份「默认角色」出来。
     * 后果不是显示不好看，是**功能直接没了**：
     *   · 服务端 capsInBook 对非成员返回 NONE（谁也进不来），
     *     前端却显示「14 位成员，角色齐全」—— 界面在撒谎
     *   · 「添加成员」对话框的候选人是「空间成员减去已在库里的」，
     *     编造出来的名单恰好包含了空间全体 → 候选人恒为空
     *     → 新建的知识库**永远显示「成员都已在知识库中了」，一个人也加不进去**
     * 种子数据每个库都有显式 book_members 行，所以演示时看不出来；
     * 真实使用第一个新建的库就撞上。
     *
     * 所以这里只返回真的。空就是空，权限判定本来也一直以服务端为准。
     */
    getBookMembers: (bookId) => get().bookMembers[bookId] || [],

    /**
     * 改角色。
     *
     * 必须**同时重算 perms**，只改 role 是不行的：
     * 服务端是「先按角色给基线、再用成员行上的 perms 逐项覆盖」，
     * 所以一旦成员行上留着旧角色的 perms，改角色就完全没有效果。
     * 实测：把 reader 提升为 editor，服务端判定的权限一项都没变
     * （edit 仍然是 false）—— 而界面上角色下拉框明明显示「编辑者」。
     *
     * 「把实习生提升为编辑者」在公司里是每周都会发生的操作，
     * 而它静默无效这件事没人会怀疑到权限判定顺序上去。
     *
     * 语义上也说得通：perms 是在角色**之上**的逐项微调。
     * 换角色等于换了一套基线，旧基线上的微调不该继续留着。
     * 真的只想微调某一项，用 updateMemberPerm。
     */
    updateMemberRole: (bookId, memberId, role) => {
      if (bookAdminBlocked(bookId)) return
      commit((s) => {
        const list = s.bookMembers[bookId] || get().getBookMembers(bookId)
        return {
          bookMembers: {
            ...s.bookMembers,
            [bookId]: list.map((m) => (m.id === memberId ? { ...m, role, perms: permsForRole(role) } : m)),
          },
        }
      })
    },

    updateMemberPerm: (bookId, memberId, perm, value) => {
      if (bookAdminBlocked(bookId)) return
      commit((s) => {
        const list = s.bookMembers[bookId] || get().getBookMembers(bookId)
        return {
          bookMembers: {
            ...s.bookMembers,
            [bookId]: list.map((m) =>
              m.id === memberId ? { ...m, perms: { ...m.perms, [perm]: value } } : m),
          },
        }
      })
    },

    removeBookMember: (bookId, memberId) => {
      if (bookAdminBlocked(bookId)) return
      commit((s) => {
        const list = s.bookMembers[bookId] || get().getBookMembers(bookId)
        return { bookMembers: { ...s.bookMembers, [bookId]: list.filter((m) => m.id !== memberId) } }
      })
    },

    addBookMember: (bookId, memberId, role) => {
      if (bookAdminBlocked(bookId)) return
      commit((s) => {
        const list = s.bookMembers[bookId] || get().getBookMembers(bookId)
        if (list.some((m) => m.id === memberId)) return {}
        return {
          bookMembers: {
            ...s.bookMembers,
            [bookId]: [
              ...list,
              { id: memberId, role, perms: permsForRole(role), joinedAt: Date.now() },
            ],
          },
        }
      })
    },

    addBookMembers: (bookId, memberIds, role) => {
      if (bookAdminBlocked(bookId)) return
      commit((s) => {
        const list = s.bookMembers[bookId] || get().getBookMembers(bookId)
        const have = new Set(list.map((m) => m.id))
        // 去重 + 去掉已经在库里的：同一个人被勾两次、或列表刷新前刚被别人加进来，
        // 都不该产生两条记录（bookMembers 出现重复行会让权限界面显示成两行同一个人）
        const fresh = [...new Set(memberIds)].filter((id) => id && !have.has(id))
        if (!fresh.length) return {}
        const now = Date.now()
        return {
          bookMembers: {
            ...s.bookMembers,
            [bookId]: [
              ...list,
              ...fresh.map((id) => ({
                id,
                role,
                perms: permsForRole(role),
                joinedAt: now,
              })),
            ],
          },
        }
      })
    },

    /* ---------------- 知识库邀请（2026-10-11） ---------------- */

    /*
     * 待办只在**服务端形态**下有内容。
     * 本地模式没有服务端，邀请根本发不出去 —— 所以这里 getMode() 一判就空，
     * UI 也就不会摆一个永远空的待办区。
     */
    refreshBookInvites: async () => {
      if (getMode() !== 'server') return
      try {
        const r = await myBookInvites()
        /*
         * ⚠️ 这里原来还写着 `.filter((i) => i.status === 'pending')` ——
         *    而 `GET /api/invites` 的 SQL **已经只查 pending 的行**，
         *    并且它返回的对象里**没有 status 字段**（只返回展示要用的那些）。
         *    于是这个 filter 把**每一条**都滤掉了：`i.status` 是 undefined，
         *    `undefined === 'pending'` 永远 false。
         *
         *    症状极像「接口通了但界面不显示」：
         *      · 请求 200，数据齐全
         *      · toast 正常
         *      · store 里恒为 []
         *    而我为此绕了好几轮（怀疑顺序、怀疑 hydrate 覆盖、怀疑 base、
         *    甚至怀疑 getMode）—— 全靠猜。
         *
         *    **教训**：在服务端已经过滤过的集合上，再按同一个条件过滤一次，
         *    只会得到空集 —— 而且不会报错。
         *    要么服务端返回 status 让客户端能筛，要么客户端别筛。
         *    这里选后者：SQL 已经筛过了，客户端再筛就是重复劳动。
         */
        commit(() => ({ bookInvites: r.invites || [] }), 0)
      } catch (e: any) {
        // 拉不到就保持原样，别把已有的待办清空 —— 那等于「你的邀请没了」
        //
        // ⚠️ 这里原来是一个**空的** `catch {}`，
        //    于是「为什么待办是空的」这个问题**没有任何线索** ——
        //    我为此绕了好几轮（怀疑调用顺序、怀疑 hydrate 覆盖、怀疑 apiBase）。
        //    一个吞掉异常的 catch，等于把排查成本转给了下一个读代码的人。
        console.warn('[refreshBookInvites] 拉取待办失败：', e?.message || e)
      }
    },

    inviteToBook: async (bookId, userId, role, message = '') => {
      try {
        const r = await inviteToBook(bookId, userId, role, message)
        if (r.alreadySent) get().toast('之前已经邀请过他了，等他处理就行', 'info')
        else get().toast('邀请已发出，等对方在待办里处理', 'success')
        /*
         * ⚠️ 这里原来写的是 `commit(() => ({}), 0)` —— **空提交**，
         *    它不拉任何数据，只是触发一次同步推送。
         *    结果：邀请**确实发出去了**（服务端 200、库里 pending、toast 也弹了），
         *    但发起方的「等待对方处理」那一块永远是空的 ——
         *    因为 `bookInvites` 只有 `refreshBookInvites()` 会填，
         *    而那个只在登录时和待办组件挂载时调。
         *
         *    实测才发现：服务端数据是对的、界面是错的，
         *    而 toast 写着「已发出」，从用户角度看一切正常。
         *
         *    所以发完必须**真的去拉一次**。
         */
        await get().refreshBookInvites()
        return true
      } catch (e: any) {
        get().toast(e?.message || '邀请发不出去', 'error')
        return false
      }
    },

    acceptBookInvite: async (inviteId) => {
      const inv = get().bookInvites.find((i) => i.id === inviteId)
      if (!inv) return false
      try {
        const r = await respondBookInvite(inviteId, true)
        commit((st) => ({
          bookInvites: st.bookInvites.filter((i) => i.id !== inviteId),
          /*
           * 乐观补**成员身份**（只有这一个）。
           *
           * ⚠️⚠️ 第一版还顺手乐观补了 `books`（那个库本身），结果：
           *   · 页面能渲染了（不再「🫥 知识库不存在」）
           *   · 但顶栏从此常驻「1 处修改没有保存」
           *
           *   原因：同步的差分是**逐行 JSON.stringify 比较**。
           *   我补的那行 `desc:'' / spaceId:'' / docCount:0` 与服务端真数据不同
           *   → 判定「本地改了」→ 推上去 → 服务端按权限拒 → 常驻告警。
           *
           *   **假告警比没有告警更糟**：人会开始无视所有告警，
           *   而下一次真的没保存时他也不会当回事。
           *
           *   所以这里**只补成员身份**（那不是服务端实体的一个字段，
           *   不会被差分判成「本地改动」），库本身等真数据：
           *   接受成功后立刻拉一次 bootstrap，而不是自己造一行。
           */
          bookMembers: {
            ...st.bookMembers,
            [inv.bookId]: [
              ...(st.bookMembers[inv.bookId] || []),
              {
                id: st.currentUser.id,
                role: (r.role || inv.role) as BookMember['role'],
                perms: permsForRole((r.role || inv.role) as BookMember['role']),
                joinedAt: Date.now(),
              },
            ],
          },
        }))
        // 库本身去服务端拉真数据 —— 别自己造一行（见上面那段注释）
        try {
          const fresh = await bootstrap()
          const list = Array.isArray((fresh as any)?.data?.books) ? (fresh as any).data.books : []
          const mine = list.filter((b: any) => (b.id ?? b.bookId) === inv.bookId)
          if (mine.length) {
            commit((st) => ({
              books: st.books.some((b) => b.id === inv.bookId)
                ? st.books.map((b) => {
                  const real = mine.find((x: any) => (x.id ?? x.bookId) === b.id)
                  return real ? { ...b, ...real, id: b.id } : b
                })
                : [{ ...mine[0], id: inv.bookId }, ...st.books],
            }))
          }
        } catch {
          // 拉不到就等下一轮同步 —— 顶栏空一会儿比常驻假告警好
        }
        get().toast(`已加入《${inv.bookName}》`, 'success')
        return true
      } catch (e: any) {
        get().toast(e?.message || '接受失败，邀请还在待办里', 'error')
        return false
      }
    },

    rejectBookInvite: async (inviteId) => {
      try {
        await respondBookInvite(inviteId, false)
        commit((st) => ({ bookInvites: st.bookInvites.filter((i) => i.id !== inviteId) }))
        get().toast('已拒绝这条邀请', 'info')
        return true
      } catch (e: any) {
        get().toast(e?.message || '操作失败，邀请还在待办里', 'error')
        return false
      }
    },

    /**
     * 这个库里「还在等人处理」的邀请。
     *
     * ⚠️ 为什么库管理员能看到**别人**发出去的：
     *   邀请是异步的 —— 对方没处理时管理员看不到任何痕迹，
     *   只能再点一次邀请，而那会拿到「之前已经邀请过他了」。
     *   也就是说没有这条，管理员**除了等没有别的办法**。
     *
     * 口径收在这里而不是界面：第一版把这段判断写在组件里，
     * 而 action 声明了却没人调用 —— 同一份口径两处各算一遍，迟早漂。
     */
    getSentInvites: (bookId) => {
      const st = get()
      const role = (st.bookMembers[bookId] || st.getBookMembers(bookId))
        .find((m) => m.id === st.currentUser.id)?.role
      const iAmAdmin = role === 'owner' || role === 'admin'
      return st.bookInvites.filter((i) => i.bookId === bookId && (i.fromUserId === st.currentUser.id || iAmAdmin))
    },

    /* ---------------- 模板中心 ---------------- */
    createTemplate: (tpl) => {
      // 权限第二道（见文件头 templateBlocked）。判的是**这份模板自己**的归属：
      // 标成「我的」的一律放行（那本来就是个人功能，服务端还会把 ownerId 强制填成本人），
      // 挂在知识库/空间下的才要对应的 edit。
      if (templateBlocked(tpl as any)) return ''
      const id = uid('tpl')
      commit((s) => ({
        templates: [
          { ...tpl, id, createdAt: Date.now(), usedCount: 0 },
          ...s.templates,
        ],
      }))
      return id
    },

    updateTemplate: (id, patch) => {
      if (templateBlocked(get().templates.find((t) => t.id === id))) return
      commit((s) => ({ templates: s.templates.map((t) => (t.id === id ? { ...t, ...patch } : t)) }))
    },

    deleteTemplate: (id) => {
      // ⚠️ 判据看的是**库里那一份**的归属，不是推进来的 patch ——
      //    服务端也是这么判的（`String(existing.ownerId) === user.id`）。
      if (templateBlocked(get().templates.find((t) => t.id === id))) return
      commit((s) => ({ templates: s.templates.filter((t) => t.id !== id) }))
    },

    /** 用模板在指定知识库下新建文档 */
    applyTemplate: (bookId, parentId, tplId) => {
      const t = get().templates.find((x) => x.id === tplId)
      if (!t) return ''
      // 权限第二道（见文件头 bookCreateBlocked）：它**真的在建一篇文档**，
      // 服务端按 `capsInBook().create` 判。以前一个阅读者点「用这个模板建一篇」，
      // 本地真的多出一篇、服务端拒、顶栏挂一条他自己修不好的告警。
      if (bookCreateBlocked(bookId)) return ''
      const blocks = markdownToBlocks(t.body)
      const title = t.name
      const id = uid('d')
      /**
       * 字数用 `recomputeWordCount` 算，和别的写入点**同一个口径**。
       *
       * 原来写的是 `wordCount: t.body.length` —— 那是**含 markdown 符号的
       * 原文长度**：`# ` 两个字符、`- ` 两个、`- [ ] ` 六个…
       * 而 `recomputeWordCount` 算的是**块的文字长度**，不含符号。
       *
       * 于是同一篇文档，用模板建出来的字数会**明显偏大**，
       * 手动敲出来的才是准的 —— 而两处都叫「字数」。
       * 模板 body 里 `##`、`- [ ]` 那种写法越多，偏得越多。
       */
      const draft: Doc = {
        id, type: 'doc' as DocType, title, body: t.body, blocks,
        authorId: get().currentUser.id,
        createdAt: Date.now(), updatedAt: Date.now(),
        visibility: get().bookSettings[bookId]?.defaultVisibility || 'space',
        published: false, tags: [], likes: [],
        wordCount: 0,
      }
      draft.wordCount = recomputeWordCount(draft)

      commit((s) => {
        const siblings = s.nodes.filter((n) => n.bookId === bookId && n.parentId === parentId)
        return {
          docs: { ...s.docs, [id]: draft },
          nodes: [
            ...s.nodes,
            { id: uid('n'), bookId, parentId, title, type: 'doc' as NodeType, docId: id, order: siblings.length + 1 },
          ],
          books: s.books.map((b) => (b.id === bookId ? { ...b, updatedAt: Date.now() } : b)),
          templates: s.templates.map((x) => (x.id === tplId ? { ...x, usedCount: x.usedCount + 1 } : x)),
        }
      })
      return id
    },

    /* ---------------- 协作光标 ---------------- */
    /*
     * 光标是高频实时态（selectionchange 一次就写一次），
     * 而且 cursors 本来就在 PERSIST_SKIP 里、不进 localStorage。
     * 所以这里必须用 set() 而不是 commit()：commit 会无条件排一次
     * 400ms 防抖落盘，等于每次挪光标都把整份数据序列化写一遍盘，纯浪费。
     */
    setCursor: (c) =>
      set((s) => ({
        cursors: [...s.cursors.filter((x) => !(x.docId === c.docId && x.memberId === c.memberId)), c],
      })),

    removeMemberCursor: (docId, memberId) =>
      set((s) => ({ cursors: s.cursors.filter((c) => !(c.docId === docId && c.memberId === memberId)) })),

    clearDocCursors: (docId) =>
      set((s) => ({ cursors: s.cursors.filter((c) => c.docId !== docId) })),

    /* ---------------- 并发编辑的合并记录 ---------------- */
    /**
     * 记一次合并。同一目标（同一个块 / 同一段文稿数据）短时间内的多次合并
     * 会并成一条并累加冲突数 —— 一次协同里往往连着来十几个 op，
     * 逐条列出来协作条会被刷爆，用户根本来不及看。
     */
    pushCollabConflict: (c) =>
      set((s) => {
        const at = c.at ?? Date.now()
        const rec: CollabConflict = {
          id: uid('cf'),
          docId: c.docId,
          target: c.target,
          blockId: c.blockId,
          section: c.section,
          where: c.where,
          actorId: c.actorId,
          actorName: c.actorName,
          count: Math.max(1, c.count),
          at,
          highlightUntil: c.highlightUntil ?? at + CONFLICT_FLASH_MS,
        }
        const key = `${rec.docId}|${rec.target}|${rec.blockId ?? rec.section ?? ''}`
        const rest = s.collabConflicts.filter((x) => {
          const k = `${x.docId}|${x.target}|${x.blockId ?? x.section ?? ''}`
          // 同目标：3 秒内并成一条；更早的另起一条（顺序按时间倒着排）
          return k !== key || at - x.at > CONFLICT_MERGE_WINDOW_MS
        })
        const merged = rest.find((x) => `${x.docId}|${x.target}|${x.blockId ?? x.section ?? ''}` === key)
        if (merged) {
          merged.count += rec.count
          merged.at = rec.at
          merged.highlightUntil = rec.highlightUntil
        } else {
          rest.push(rec)
        }
        // 只留最近 20 条：更早的合并提示已经没有回看的价值了
        return { collabConflicts: rest.slice(-20) }
      }),

    clearCollabConflicts: (docId) =>
      set((s) => ({
        collabConflicts: docId ? s.collabConflicts.filter((c) => c.docId !== docId) : [],
      })),

    /* ---------------- 划词评论 ---------------- */
    addSelectionComment: (docId, quote, blockId, text) => {
      if (commentBlocked(docId)) return
      commit((s) => {
        const c: SelectionComment = {
          id: uid('sc'), docId, quote, blockId, text,
          authorId: s.currentUser.id, createdAt: Date.now(), resolved: false, replies: [],
        }
        return { selectionComments: { ...s.selectionComments, [docId]: [...(s.selectionComments[docId] || []), c] } }
      })
    },

    resolveSelectionComment: (docId, id) => {
      if (commentBlocked(docId)) return
      commit((s) => ({
        selectionComments: {
          ...s.selectionComments,
          [docId]: (s.selectionComments[docId] || []).map((c) => (c.id === id ? { ...c, resolved: true } : c)),
        },
      }))
    },

    replySelectionComment: (docId, id, text) => {
      if (commentBlocked(docId)) return
      commit((s) => ({
        selectionComments: {
          ...s.selectionComments,
          [docId]: (s.selectionComments[docId] || []).map((c) =>
            c.id === id
              ? { ...c, replies: [...(c.replies || []), { id: uid('c'), docId, authorId: s.currentUser.id, text, createdAt: Date.now(), replies: [] }] }
              : c),
        },
      }))
    },

    removeSelectionComment: (docId, id) => {
      if (commentBlocked(docId)) return
      commit((s) => ({
        selectionComments: {
          ...s.selectionComments,
          [docId]: (s.selectionComments[docId] || []).filter((c) => c.id !== id),
        },
      }))
    },

    /* ---------------- 历史版本 ---------------- */
    addDocVersion: (docId, label = '自动保存') => {
      const s = get()
      const d = s.docs[docId]
      if (!d) return null
      // 权限第二道（见文件头 bookEditBlocked）：`docVersions` 归属经 docId 反查，
      // 服务端按 `capsInBook().edit` 判。读侧本来就只在**能编辑时**才存快照
      // （DocPage 那个 effect 先判 canEditNow），这里是第二道。
      if (bookEditBlocked(d.bookId)) return null
      /**
       * 正文没加载到本地时不许存版本。
       *
       * 轻量启动之后没打开过的文稿只有元信息，`d.blocks` 是 undefined。
       * 早先这里写的是 `d.blocks || []` —— 于是会存下一份**空的**版本快照，
       * 界面上还显示「已存」，点回滚却发现恢复出来是空白。
       * 存不下就说存不下，别造一份假的出来。
       */
      if (!Array.isArray(d.blocks)) {
        get().toast('文档尚未加载，暂不能保存历史版本', 'info')
        return null
      }
      const blocks = d.blocks
      // 正文体量太大就别自动存了：每份快照都是一份完整 blocks，
      // 历史版本自己就能把 localStorage 的 4MB 吃光，反而拖累正文。
      if (JSON.stringify(blocks).length * 2 > VERSION_SNAPSHOT_MAX_BYTES) {
        get().toast('文档体积较大，已跳过自动快照（历史版本也会占用存储）', 'info')
        return null
      }
      const list = d.versions || []
      const head = list[0]
      // 与最新一版内容一致就不重复记
      if (head && versionFingerprint(head.title, head.blocks) === versionFingerprint(d.title, blocks)) {
        return null
      }
      const at = Date.now()
      // 连续输入的自动保存按时间合并：别让同一段内容的微小改动刷满 8 个位置。
      // 其它标签（打开文档 / 手动保存 / 恢复前 / 手动快照）都是明确事件，不合并。
      if (label === '自动保存' && head?.label === '自动保存' && at - head.at < AUTOSAVE_COALESCE_MS) {
        return null
      }
      const v: DocVersion = {
        id: uid('v'),
        title: d.title,
        body: d.body,
        createdAt: at,
        at,
        editorName: s.currentUser.name,
        blocks: cloneBlocks(blocks),
        label,
      }
      commit((st) => {
        const doc = st.docs[docId]
        if (!doc) return {}
        return {
          docs: {
            ...st.docs,
            [docId]: { ...doc, versions: trimVersions([v, ...(doc.versions || [])]) },
          },
        }
      })
      return v.id
    },

    restoreDocVersion: (docId, versionId) => {
      const d0 = get().docs[docId]
      if (!d0) return false
      // 权限第二道（见文件头 bookEditBlocked）：回滚会**真的改写正文与标题**，
      // 服务端按 `capsInBook().edit` 判。没编辑权的人点回滚，
      // 本地立刻变成旧版本、服务端不动 —— 他自己看不出来发生了什么。
      if (bookEditBlocked(d0.bookId)) return false
      const v0 = (d0.versions || []).find((x) => x.id === versionId)
      if (!v0) return false
      // 恢复本身是一次「重要操作」：先把现状存一版，恢复错了还能再退回去
      get().addDocVersion(docId, '恢复前')
      // 老版本快照可能只有 body（没有 blocks），退回按 markdown 切块
      const hasBlocks = !!v0.blocks?.length
      const blocks = hasBlocks ? cloneBlocks(v0.blocks) : markdownToBlocks(v0.body || '')
      commit((s) => {
        const d = s.docs[docId]
        if (!d) return {}
        /**
         * `body` 和 `title` 都**由 blocks 重算**，不直接用快照里那两个字段。
         *
         * 原来写的是 `{ title: v0.title, body: v0.body }` —— 而那两个字段
         * 是**存版本那一刻的派生结果**，不是权威数据。实测：
         *
         *   造一版（body 被清空，模拟「在我修 body 之前存的历史版本」）
         *   → 改点正文 → 回滚
         *   → blocks 正确（2 个块、内容都在）
         *     但 body 变成了空串，**服务端也跟着空了**
         *   → 于是又回到「导出零字节、分享页空白页」（7.17 那三个消费方）
         *
         * 而且这不是假设：**这个版本库跑了很久，里面每一个在
         * 「body 开始被维护」之前存下的版本，它的 body 都是空的或陈旧的。**
         *
         * 所以只有「快照里没有 blocks」那种老版本才该用 `v0.body` ——
         * 那时它是**唯一**的来源，不是「一个陈旧的派生值」。
         */
        const next: Doc = { ...d, blocks, updatedAt: Date.now() }
        if (!hasBlocks) next.title = v0.title
        // force：回滚换的是**另一份内容**，标题必须跟这份走，
        // 不能因为「两份的首个 H1 恰好同字」就沿用现在这份的标题。
        applyDerivedTitle(next, d, true)
        next.body = blocksToMarkdown(blocks)
        next.wordCount = recomputeWordCount(next)
        // 回滚换了标题，目录节点也得换 —— 否则回滚之后目录里还是回滚前的标题
        const nodes = syncNodeTitle(s, docId, next.title)
        return nodes === s.nodes
          ? { docs: { ...s.docs, [docId]: next } }
          : { docs: { ...s.docs, [docId]: next }, nodes }
      })
      return true
    },

    /* ---------------- 文档锁定 ---------------- */
    lockDoc: (docId) => {
      const s = get()
      const d = s.docs[docId]
      if (!d) return false
      /*
       * 权限第二道（见文件头 `bookEditBlocked`）。
       *
       * ⚠️ 这一条比别处的假动作更重：锁不是改自己那份数据，
       * 它**让别人也改不了这篇**。而服务端对 `docs` 按 `edit` 判，
       * 所以锁其实压根推不上去（实测：本地锁上了、服务端 lock 仍是 null）。
       * 也就是说今天还只是「白锁一次 + 挂一条修不好的告警」；
       * 但只要哪天服务端那条按列放行的口子（见 `denyReason` 里的 likes 特例）
       * 被误放宽到别的列，reader 就能**真的把一篇文档锁死**。
       */
      if (bookEditBlocked(d.bookId)) return false
      if (d.lock && d.lock.memberId === s.currentUser.id) return true // 幂等：别刷出一堆重复消息
      if (d.lock && d.lock.memberId !== s.currentUser.id) {
        get().toast(`${(s.members.find((m) => m.id === d.lock!.memberId)?.name) || '对方'}已锁定此文档`, 'info')
        return false
      }
      commit((st) => {
        const doc = st.docs[docId]
        if (!doc) return {}
        return {
          docs: {
            ...st.docs,
            [docId]: { ...doc, lock: { memberId: st.currentUser.id, at: Date.now() } },
          },
        }
      })
      return true
    },

    unlockDoc: (docId) => {
      const s = get()
      const d = s.docs[docId]
      if (!d || !d.lock) return
      // 与 `lockDoc` 同一道守卫：推的是 `docs.lock`，要 edit 权限
      if (bookEditBlocked(d.bookId)) return
      // 只有持有者能解锁：被别人解锁等于把别人的「正在编辑」状态抹掉
      if (d.lock.memberId !== s.currentUser.id) {
        get().toast('只有锁定文档的人能解锁', 'info')
        return
      }
      commit((st) => {
        const doc = st.docs[docId]
        if (!doc) return {}
        return { docs: { ...st.docs, [docId]: { ...doc, lock: null } } }
      })
    },

    /* ---------------- 个人资料 ---------------- */
    updateMyProfile: async (patch) => {
      if (getMode() !== 'server') {
        // 本地模式没有服务端可写。**不假装成功** ——
        // 以前那个按钮就是这样：弹「资料已保存」，其实只改了组件局部 state。
        get().toast('本地模式下改不了资料（数据只在 localStorage 里），请登录后再改', 'info')
        return
      }
      try {
        const r = await updateMyProfileApi(patch)
        const saved = r.user
        if (!saved?.id) return
        commit(() => {
          const members = get().members.map((m) => (m.id === saved.id ? { ...m, ...saved } : m))
          const me = members.find((m) => m.id === saved.id) || get().currentUser
          return { members, currentUser: me }
        })
        get().toast('资料已保存', 'success')
      } catch (e: any) {
        get().toast(e?.message || '保存失败', 'error')
      }
    },

    /* ---------------- 空间 ---------------- */
    switchUser: (memberId) => {
      const m = get().members.find((x) => x.id === memberId)
      if (m) {
        commit(() => ({ currentUser: m }))
        get().toast(`已切换为 ${m.name}`, 'info')
      }
    },

  /**
   * 服务端形态下清空本地状态，等服务端把权威数据送来。
   *
   * 两个要点，缺一不可：
   *
   * 1. **必须清掉 localStorage 读出来的那份**。它可能是上一个版本、
   *    上一次会话的，字段形状都不一样（服务端早先是 lockMemberId，现在是 lock）。
   *    它在 hydrate 之前还在的话，任何一次 commit 都会把这份陈旧数据推上去。
   *
   * 2. **清成空，不能灌回种子数据**。这里到 hydrate 之间有一次
   *    `await`（网络请求），组件会在这段时间挂载并 commit；
   *    而此时基准还是空的，差分会把**整个种子数据集**当成「我的改动」推上去。
   *    种子有 26 篇 —— 于是只读成员一打开页面就报 26 处没保存。
   *
   * 本地形态不受影响：那里 localStorage 就是唯一真相。
   */
  clearLocalSnapshot: () => {
    try { localStorage.removeItem(STORAGE_KEY) } catch { /* 隐私模式 */ }
    const blank: Partial<AppData> = {
      currentUser: { id: '', name: '', account: '', avatar: '', role: 'member' } as Member,
      spaces: [], members: [], books: [], nodes: [], docs: {}, comments: {},
      notes: [], topics: [], topicReplies: [], favorites: [], follows: [], recents: [], trash: [],
    /* 知识库邀请的待办（服务端形态下才有内容） */
    bookInvites: [],
      bookSettings: {}, bookMembers: {}, templates: [] as any, selectionComments: {},
    }
    set({
      ...(blank as any),
      // 保留纯 UI 态
      toasts: [], activeDocId: null, activeSpaceId: 's1', treeCollapsed: false,
      treeWidth: 260, collabConflicts: [], cursors: [],
      /* 退出登录：上一个身份的权限答案必须一起清掉，
         否则换人登录会先按**他的**判据显隐半秒。 */
      spaceCaps: {},
    })
  },

    reset: () => {
      localStorage.removeItem(STORAGE_KEY)
      set({ ...createSeedData(), activeDocId: null })
      get().toast('已恢复为初始演示数据', 'success')
    },

    /* ---------------- 服务端同步 ---------------- */
    hydrate: (data, opts) => {
      // 只覆盖真正从服务端拿到的字段：seed 数据里的 currentUser / cursors 等
      // 要保留，否则登录后第一眼看到的是空成员表。
      const patch: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(data)) {
        if (v === undefined) continue
        patch[k] = v
      }
      if (opts?.currentUser) patch.currentUser = opts.currentUser
      // 光标永远不进持久化，也不该被服务端数据覆盖
      patch.cursors = []
      patch.collabConflicts = []

      /*
       * `activeSpaceId` 的默认值是**种子里的 `'s1'`**（本文件 609 / 1639 行）。
       * 服务端形态下这个空间多半不存在 —— 全新部署里只有注册时自动建的
       * 个人空间 `sp_<userId>`。
       *
       * 后果（实测 2026-10-09，一次性空实例）：
       *   工作台「＋ 新建知识库」和顶栏菜单都调 `createBook(activeSpaceId, …)`，
       *   于是推上去的 book.spaceId 是一个**不存在的外键** ——
       *   服务端逐条判定时把它拒了：
       *     rejected: [{ entity:'books', reason:'FOREIGN KEY constraint failed' }]
       *   而 push 返回 **HTTP 200**，客户端又不看 `rejected`
       *   → 界面上「建好了」，刷新之后**什么都没了**。
       *
       *   显示层其实有兜底（`spaces.find(s => s.id === activeSpaceId) || spaces[0]`），
       *   所以界面看着完全正常 —— 只有**写操作**会把那个坏 id 递出去。
       *
       * 所以这里在 hydrate 时校正一次：activeSpaceId 必须在 spaces 里，
       * 否则落到第一个（真实存在的那个）。
       */
      const spaces = (patch.spaces ?? get().spaces ?? []) as { id: string }[]
      if (Array.isArray(spaces) && spaces.length) {
        const cur = get().activeSpaceId
        if (!spaces.some((s) => s.id === cur)) {
          set({ activeSpaceId: spaces[0].id } as any)
        }
      }

      set(patch as any)
    },

    applyRemote: (patch) => {
      set(patch as any)
    },
  }
})

/* 便捷 hooks */

/**
 * 某个文稿挂在哪个知识库下。
 *
 * `doc` 自己不一定带 bookId（新建时可能没填），要经目录节点反查 ——
 * `deleteDoc` 和 `deleteNode` 生成回收站记录时都要用它。
 */
function bookIdOfDoc(s: Store, docId: string): string {
  return (s.docs[docId] as any)?.bookId || s.nodes.find((n) => n.docId === docId)?.bookId || ''
}

export const useCurrentUser = () => useStore((s) => s.currentUser)
export const useDoc = (id: string | undefined) => useStore((s) => (id ? s.docs[id] : undefined))
/**
 * markdownToBlocks 现在住在 `@/lib/markdown-to-blocks`（纯函数，服务端也要用）。
 * 两个名字都从这里转出：`markdownToBlocks` 是导入方一直在用的那个，
 * `mdToBlocks` 是更早起的别名 —— 都留着，免得为了搬家去改一串调用点。
 */
export { markdownToBlocks, markdownToBlocks as mdToBlocks }
