import { useSyncExternalStore } from 'react'
import { useStore } from '@/store'
import { CURSOR_COLORS } from '@/data/settings'
import { YUQUE_CARDS } from '@/data/cards'
import type { Block, CollabConflict, CollabCursor, DocSheetData } from '@/types'
import { getMode } from '@/lib/api'
import { openTransport, type CollabTransport } from '@/lib/collab-transport'
import {
  createLog, makeOp, markApplied, blockVersionAt, lastOpForTarget,
  mergeText, mergeObject, deepEqual, collectNames, describeConflictPath, wins,
  type Op as CrdtOp,
  type OpLogState,
  type ObjConflict,
} from '@/lib/crdt/core'

/* ============================================================
   跨标签页实时协作 —— BroadcastChannel
   ------------------------------------------------------------
   同一 origin 下开多个标签页（本项目调试时用同一个浏览器 context
   模拟两个窗口），靠 BroadcastChannel 互相同步三类状态：

   1) content  正文块。任一标签页 setDocBlocks 后广播，对端用
                **不落盘** 的 setDocBlocksRemote 应用（见下方
                「不放大 localStorage 写入」一节）。
   2) cursor    协作光标。selectionchange 时把选区换算成
                { blockId, offset, range } 广播，对端写入 store.cursors。
   3) presence  在场心跳。谁在线、在哪篇文档、最后一次活跃时间。
                对端超过 PRESENCE_TIMEOUT_MS 没收到心跳就判定离线。

   消息一律带 `from`（本标签页唯一 id）——**回环判定只看 from**，
   不用 memberId：同一个人可能开两个标签页，A 必须收下 B 的消息。
   内容消息另带 `authorId`（这次改动的作者），仅用于归属与展示。

   刻意不做的事：没有 CRDT / OT，正文是「最后写入者胜」。
   ============================================================ */

const CHANNEL_PREFIX = 'yuque-clone:doc:'
const PROTOCOL = 1

/** 心跳周期：5s 一次，远小于超时阈值，留 3~4 次容错 */
const HEARTBEAT_MS = 5_000
/** 心跳超时：超过这个时间没收到某个成员的心跳即视为离线，移除其光标与头像 */
const PRESENCE_TIMEOUT_MS = 20_000
/**
 * 正文广播的尾随防抖：一次粘贴 / 一段 IME 会连着改很多次，合并成一条。
 *
 * 100ms 不是随手取的：60ms 时，一次 6 连击（按键间隔 60ms）会发出 6 条 op，
 * 对端就要 commit 6 次 —— 虽然落盘有 400ms 防抖兜着，机器一忙就摊成 6 次写盘，
 * 协同条的「落盘有没有节流」直接被顶穿。100ms 能把连击收敛成 1~2 条，
 * 而对端看到改动的延迟只多了 40ms（人眼分辨不出），换的是对端少一半的
 * 克隆 / 传输 / 合并开销。
 */
const CONTENT_DEBOUNCE_MS = 100

/** 本标签页唯一 id（模块级：整个页面生命周期内不变） */
const TAB_ID = `tab_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`

/** 频道名带项目 + 文档前缀，避免和同源部署的其它应用串扰 */
const channelName = (docId: string) => `${CHANNEL_PREFIX}${docId}`

/**
 * doc.sheetData 的三段，各自独立成一个同步目标。
 * 三段共用一个命名空间，但只有对应文稿类型的那一段会被改动，
 * 分开做基准与冲突记账才不会互相干扰。
 */
const SECTION_KEYS = ['sheets', 'table', 'board'] as const
type SectionKey = (typeof SECTION_KEYS)[number]
const isSectionKey = (k: string): k is SectionKey => (SECTION_KEYS as readonly string[]).includes(k)

const SECTION_LABEL: Record<SectionKey, string> = { sheets: '工作表', table: '数据表', board: '画板' }
/** sheet.set / card.set 的逻辑目标键 */
const sheetKeyOf = (k: SectionKey) => `sheet:${k}`
const cardKeyOf = (blockId: string) => `card:${blockId}`

/** 卡片类型 id → 中文名（冲突文案用；认不出就退回「卡片」） */
function cardNameOf(block: Block | undefined): string {
  const id = block?.data?.cardId
  return (typeof id === 'string' && YUQUE_CARDS.find((c) => c.id === id)?.name) || '卡片'
}

/**
 * 记一份「上次广播出去的文稿数据」基准。
 * 只留三段本体（不深拷贝）：store 里的对象是不可变的，
 * 每次写入都是新对象，指针本身就等价于一次快照。
 */
function snapshotSheet(sheet: DocSheetData | undefined): DocSheetData | null {
  if (!sheet) return null
  const out: DocSheetData = { v: sheet.v }
  for (const k of SECTION_KEYS) {
    const v = sheet[k]
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/* ============================================================
   消息协议
   ============================================================ */

export type CollabMessage =
  /** 正文变更：blocks 整体覆盖，title 跟随首块 H1（可缺省） */
  | {
      v: typeof PROTOCOL
      kind: 'content'
      from: string
      docId: string
      authorId: string
      blocks: Block[]
      title?: string
      /** 发送方当前的发送序号，接收方据此对齐自己的期望值 */
      rev?: number
      ts: number
    }
  /**
   * 增量正文变更。
   * 之前每次按键都把整个 Block[] 结构化克隆广播一次，
   * 几百块的大文档会明显浪费（克隆 + 传输 + 对端整篇比较）。
   * 改成只发「变了哪些块」+「顺序」，并带 base/from 做基准校验。
   */
  | {
      v: typeof PROTOCOL
      kind: 'patch'
      from: string
      docId: string
      authorId: string
      /** 我发这条时的基准序号（= 我已发出去的最大序号） */
      base: number
      /** 这条消息自身的序号 */
      rev: number
      /** 新增 / 修改的块（整块，字段全带） */
      upserts: Block[]
      /** 被删掉的块 id */
      deletes: string[]
      /** 顺序有没有变；变了就给完整 id 顺序 */
      order?: string[]
      title?: string
      ts: number
    }
  /**
   * 单个操作（CRDT 层）。
   * patch 是「这块文档变了什么」，op 是「我做了一次什么修改」——
   * 后者带因果依赖与该块的基准版本，对端才能判断这是顺序执行还是并发冲突。
   */
  | {
      v: typeof PROTOCOL
      kind: 'op'
      from: string
      docId: string
      memberId: string
      ops: CrdtOp[]
      ts: number
    }
  /** 对端发现基准对不上，请重发全量 */
  | {
      v: typeof PROTOCOL
      kind: 'need-full'
      from: string
      docId: string
      memberId: string
      ts: number
    }
  /** 光标变更：cursor 为 null 表示「我离开正文了」 */
  | {
      v: typeof PROTOCOL
      kind: 'cursor'
      from: string
      docId: string
      memberId: string
      cursor: CollabCursor | null
      ts: number
    }
  /** 在场心跳 */
  | {
      v: typeof PROTOCOL
      kind: 'presence'
      from: string
      docId: string
      memberId: string
      activeAt: number
      ts: number
    }
  /** 我走了（切文档 / 关闭标签页） */
  | {
      v: typeof PROTOCOL
      kind: 'leave'
      from: string
      docId: string
      memberId: string
      ts: number
    }

/** Omit 对联合类型不分配，这里要逐个成员去字段，所以手写一个分配版 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
/** 发出时统一由 post 补上 v / from */
type OutgoingMessage = DistributiveOmit<CollabMessage, 'v' | 'from'>

const isMessage = (m: unknown, docId: string): m is CollabMessage => {
  if (!m || typeof m !== 'object') return false
  const x = m as Partial<CollabMessage>
  return (
    x.v === PROTOCOL &&
    typeof x.from === 'string' &&
    x.from.length > 0 &&
    x.docId === docId &&
    typeof x.kind === 'string'
  )
}

/* ============================================================
   成员标识色 —— 颜色跟着人走，不是每次刷新都换
   ============================================================ */

export function colorOfMember(memberId: string): string {
  const i = useStore.getState().members.findIndex((m) => m.id === memberId)
  return CURSOR_COLORS[(i < 0 ? 0 : i) % CURSOR_COLORS.length]
}

/* ============================================================
   在场名单（模块级 + useSyncExternalStore 暴露给 React）
   —— 只有远端成员；自己永远由调用方补上
   ============================================================ */

export interface CollabPeer {
  memberId: string
  docId: string
  tabId: string
  /** 该成员最后一次本地活跃时间（打字 / 点鼠标），用来判断「正在编辑 / 暂时离开」 */
  activeAt: number
  /** 我这边最后一次收到它心跳的时间 */
  lastSeen: number
}

const peers = new Map<string, CollabPeer>()
const peerListeners = new Set<() => void>()
/** 快照缓存：getSnapshot 必须返回稳定引用，否则 useSyncExternalStore 会死循环 */
let peerSnapshot: CollabPeer[] = []

function emitPeers() {
  peerSnapshot = Array.from(peers.values()).sort((a, b) => a.memberId.localeCompare(b.memberId))
  peerListeners.forEach((l) => l())
}

function subscribePeers(l: () => void) {
  peerListeners.add(l)
  return () => {
    peerListeners.delete(l)
  }
}

/** 掉线清理：心跳超时的成员从名单里消失（同时清掉它的光标） */
function prunePeers() {
  const now = Date.now()
  let dirty = false
  for (const [id, p] of peers) {
    if (now - p.lastSeen <= PRESENCE_TIMEOUT_MS) continue
    peers.delete(id)
    useStore.getState().removeMemberCursor(p.docId, p.memberId)
    dirty = true
  }
  if (dirty) emitPeers()
  return dirty
}

/** 当前文档的远端在场成员（不含自己）。快照是模块级缓存，调用方按 docId 过滤 */
export function useCollabPeers(): CollabPeer[] {
  return useSyncExternalStore(
    subscribePeers,
    () => peerSnapshot,
    () => peerSnapshot,
  )
}

/* ============================================================
   演示模式开关（默认关）
   —— 没有第二个标签页时，用假协作者把画面填满；
      一旦检测到真实连接就立刻让位给真协同。
   ============================================================ */

let demoMode = false
const demoListeners = new Set<() => void>()

export function subscribeDemo(l: () => void) {
  demoListeners.add(l)
  return () => {
    demoListeners.delete(l)
  }
}

const getDemo = () => demoMode

export function useDemoMode(): boolean {
  return useSyncExternalStore(subscribeDemo, getDemo, getDemo)
}

export function setDemoMode(v: boolean) {
  if (demoMode === v) return
  demoMode = v
  demoListeners.forEach((l) => l())
}

/* ============================================================
   选区 → 协作光标
   ------------------------------------------------------------
   与 RemoteCursor 的测量口径保持一致：以块内第一个非空 TextNode
   为基准算字符偏移（富文本块可能被 <span> 拆成多个文本节点），
   两端都用同一基准，跨块选区则退化为块首的插入点。
   ============================================================ */

const findBlockEl = (node: Node, root: HTMLElement): HTMLElement | null => {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const block = el?.closest<HTMLElement>('[data-block-id]') || null
  return block && root.contains(block) ? block : null
}

/** 与编辑器一致：正文在 .yq-block-text，代码块在 .yq-code-body */
const anchorTextNode = (blockEl: HTMLElement): Text | null => {
  const textEl = blockEl.querySelector<HTMLElement>('.yq-block-text, .yq-code-body')
  if (!textEl) return null
  for (const n of Array.from(textEl.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE && (n.textContent || '').length > 0) return n as Text
  }
  return null
}

/** 选区端点 → 相对 anchor 的字符偏移 */
function offsetInAnchor(anchor: Text, node: Node, offset: number): number {
  if (node === anchor) return Math.max(0, Math.min(anchor.length, offset))
  const r = document.createRange()
  try {
    r.setStart(anchor, 0)
    r.setEnd(node, offset)
    return r.toString().length
  } catch {
    // 端点落在 anchor 之前（前置空文本节点等）→ 视作块首
    return 0
  }
}

interface LocalCursor {
  blockId: string
  offset: number
  range: [number, number]
}

function selectionToCursor(root: HTMLElement | null): LocalCursor | null {
  if (!root) return null
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const r = sel.getRangeAt(0)
  if (!root.contains(r.startContainer)) return null
  const blockEl = findBlockEl(r.startContainer, root)
  if (!blockEl) return null
  const blockId = blockEl.dataset.blockId
  const anchor = anchorTextNode(blockEl)
  if (!blockId || !anchor) return null

  const start = offsetInAnchor(anchor, r.startContainer, r.startOffset)
  let range: [number, number] = [start, start]
  if (!r.collapsed) {
    // 选区终点也在同一块里才画高亮，否则只留插入点
    const endBlock = findBlockEl(r.endContainer, root)
    if (endBlock === blockEl) {
      const end = offsetInAnchor(anchor, r.endContainer, r.endOffset)
      range = [Math.min(start, end), Math.max(start, end)]
    }
  }
  return { blockId, offset: start, range }
}

/* ============================================================
   会话
   ============================================================ */

/** 两份块数组是否等价（只看渲染与同步关心的字段，够用且便宜） */
/** 单块是否等价（字段全比，含富文本 html 与卡片 data） */
function sameBlock(x: Block, y: Block): boolean {
  if (x === y) return true
  if (x.id !== y.id || x.type !== y.type || x.text !== y.text) return false
  if (x.checked !== y.checked || x.lang !== y.lang || x.emoji !== y.emoji) return false
  if (x.html !== y.html) return false
  if (x.src !== y.src) return false
  if (x.data !== y.data) return false
  return true
}

/**
 * 只看「除 data 以外」的字段。
 * 投票勾了哪项、看板卡片挪到哪列这类改动只碰 data，走 card.set 更合适：
 * 对端拿到的是「卡片数据变了」而不是「整块被换掉了」，
 * 合并时才能按字段做，而不是把对方在正文里的改动一起顶掉。
 */
function sameBlockExceptData(x: Block, y: Block): boolean {
  if (x === y) return true
  if (x.id !== y.id || x.type !== y.type || x.text !== y.text) return false
  if (x.checked !== y.checked || x.lang !== y.lang || x.emoji !== y.emoji) return false
  if (x.html !== y.html) return false
  if (x.src !== y.src) return false
  return true
}

function sameBlocks(a: Block[], b: Block[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if (x.id !== y.id || x.type !== y.type || x.text !== y.text) return false
    if (x.checked !== y.checked || x.lang !== y.lang || x.emoji !== y.emoji) return false
    /**
     * 富文本格式必须一起比。
     * 只比 text 会漏掉「文本没变、只是加了个粗」这类变更：
     * 对端收到的 blocks 与本地 text 相同 → 被判为相同 → 直接短路丢弃，
     * 表现就是「A 加粗了，B 收到文字但格式没跟上」。
     */
    if (x.html !== y.html) return false
    /* 图片附件（src 是 data URL，字符串直接比） */
    if (x.src !== y.src) return false
    /* 卡片数据用引用比较：卡片每次改动都是新对象，能可靠检出变化 */
    if (x.data !== y.data) return false
  }
  return true
}

/**
 * 打开一篇文档的协作会话。
 * @param docId   文档 id
 * @param getRoot 编辑器根节点（懒取：effect 首跑时 ref 可能还没挂上）
 */
export function openCollabSession(opts: {
  docId: string
  getRoot: () => HTMLElement | null
}): { close: () => void } {
  const { docId, getRoot } = opts
  const noop = { close: () => {} }
  // 服务端模式走 WebSocket（跨设备），本地模式走 BroadcastChannel（同浏览器多标签）。
  // 两种模式的协议与合并逻辑完全一致，这里只换了管道。
  if (getMode() === 'server' ? typeof WebSocket === 'undefined' : typeof BroadcastChannel === 'undefined') {
    return noop
  }

  let channel: CollabTransport
  try {
    channel = openTransport(docId)
  } catch {
    return noop
  }

  // 身份一律在发送/接收的当下现取：用户可能在文档页中途切换身份
  const me = () => useStore.getState().currentUser
  let closed = false
  let lastCursorKey = ''
  let lastActivityAt = Date.now()
  /** 远端内容的时间戳水位：乱序到达的旧消息直接丢，避免内容来回跳 */
  let lastAppliedTs = 0
  let contentTimer: ReturnType<typeof setTimeout> | null = null
  /** 上次真正广播出去的 blocks，作为算增量的基准 */
  /**
   * 这里是普通函数不是 hook（openCollabSession），所以用闭包变量而不是 useRef。
   * 用 useRef 会直接抛 React #321，文档页整页白屏。
   * 闭包变量天然按会话隔离——每次 openCollabSession 调用是一份新的。
   */
  /** 上次真正广播出去的 blocks，作为算增量的基准 */
  let lastSent: Block[] | null = null
  let lastSentTitle: string | undefined = undefined
  /**
   * 上次真正广播出去的 doc.sheetData（只用来判断「这一段要不要发」）。
   * 它和 peerKnown 不是一回事：lastSent 是「我发过的」，
   * peerKnown 是「对端一定已经有的」——见下面 peerKnown 的注释。
   */
  let lastSentSheet: DocSheetData | null = null
  /**
   * 每个目标「对端已经有的最后一个版本」。算 op 基准值
   * （baseBlock / baseData / baseValue）时取它。
   *
   * 为什么不能直接用 lastSent：lastSent 只记「我自己发过的」。
   * 「B 从 A 那里拿到一张新卡片、还没广播就改了它」这种最常见的接力场景里，
   * B 的 lastSent 里根本没有这张卡 —— 算出来的基准是个空壳，
   * A 拿它做三路合并就会把 B 改的字段判成冲突并丢掉。
   * peerKnown 在「应用远端 op」时也会往前推，所以 B 知道「A 已经有这张卡了」。
   */
  let peerKnown = new Map<string, any>()
  /**
   * 每个目标「当前本地状态是由哪条 op 产生的」。
   *
   * 仲裁就是拿它和进来的 op 比大小 —— 一句话说清规则：
   * **同一个位置永远归那批 op 里最大的那条**。(clock, actor) 是全局一致的全序，
   * 两端拿到同一对 op 时结论必然互补，所以一定收敛。
   *
   * 这里有三个先后踩过的坑，都是「我方版本」取错导致的：
   * ① 取「log 里最后一个 op」——那可能就是刚收进来的对方的 op，
   *    等于拿对方比对方（`wins(o, o)` 恒真），两端都判自己赢。
   * ② 只取「我自己发的最后一条」——我的 op 若是最小的，就会把每条进来的 op 都吃一遍，
   *    最终落在**最后收到的那条**上而不是最大的那条（三端实测 B 就是这样落单的）。
   * ③ 拿「合并结果」当版本——合并结果不对应任何单条 op，比较就没有公共口径。
   * 现在这版记的是「本地状态归谁」：赢了留我自己的、输了记对方的，天然单调不减。
   */
  const stateOf = new Map<string, { clock: number; actor: string }>()
  /** 本地状态归 o 这条 op（与现有记录比，取大的那个） */
  const claim = (key: string | undefined, o: CrdtOp) => {
    if (!key) return
    const cur = stateOf.get(key)
    if (!cur || wins(o.clock, o.actor, cur.clock, cur.actor)) stateOf.set(key, { clock: o.clock, actor: o.actor })
  }
  /** 我已发出的最大序号 */
  let sentRev = 0
  /**
   * 每个发送方各自维护一条发送序号，A 的 seq 和 B 的 seq 是两条独立序列。
   * 所以必须按 from 分别追踪「我从这个来源已应用到第几条」，
   * 拿单一变量去比会把不同来源的序号混在一起，导致每次 patch 都被误判为错位。
   */
  const peerRev = new Map<string, number>()
  /**
   * 该块最近一个**已广播**的 op id。
   * 必须是「已广播」而不是「已记录」：op.after 里的每个 id 对端都要能对上，
   * 填进只在本地存在的 id 会让对端的因果就绪判定永远不满足，op 一直卡在缓冲区。
   */
  const sentLastOf = new Map<string, string>()
  /** CRDT 操作日志：因果就绪判定 + 取三路合并的 base */
  const oplog: OpLogState = createLog()
  /** 应用远端内容的深度：>0 时屏蔽「正文变更 → 广播」，防止 A→B→A 回环 */
  let applyRemoteDepth = 0
  /**
   * 远端 op 的落地批量。
   * 一次协同（对方连着打字 / 拖表格）会连着来十几条 op，
   * 逐条应用 = 逐次重渲染 + 逐次排落盘，接收端自己先卡住了。
   * 攒 120ms 合成一批：渲染一次、落盘一次，对端感知不到差别。
   * 按来源分桶，避免把两个人的编辑混成一批（冲突提示要写清是谁合并进来的）。
   */
  const REMOTE_APPLY_MS = 120
  const pendingRemote = new Map<string, { memberId: string; ops: CrdtOp[]; ts: number }>()
  let applyTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 合并「回声」：本地合并出来的内容要作为一条**更大的 op** 推回去。
   *
   * 为什么需要：块级合并的版本归属是近似的 —— 合并结果同时含着两边的内容，
   * 却不对应任何单条 op。三端以上在同一位置并发时，两端可能各自算出
   * 「我采信对方也是对的」（一个停在 A 那版、一个停在 B 那版）。
   * 回声把「分歧」变成一条 op：clock 顶到「我见过的最大值」，于是它是全局最大 ——
   * 谁收到谁采纳，三端最终落在同一条 op 上。
   * 收下之后本地就等于这条 op 的内容，不会再触发新的回声，所以不会打转。
   */
  /** 本会话登记过的远端成员，close 时只摘自己摘的 */
  const owned = new Set<string>()

  const post = (msg: OutgoingMessage) => {
    if (closed) return
    try {
      channel.postMessage({ v: PROTOCOL, from: TAB_ID, ...msg } as CollabMessage)
    } catch {
      /* 结构化克隆失败等，忽略单条消息 */
    }
  }

  /* ---------------- 发出 ---------------- */

  const sendPresence = () => {
    post({ kind: 'presence', docId, memberId: me().id, activeAt: lastActivityAt, ts: Date.now() })
  }

  const sendLeave = () => {
    post({ kind: 'leave', docId, memberId: me().id, ts: Date.now() })
  }

  /**
   * 发送正文变更。
   * - 首次（或对端还没有这份文档）发全量
   * - 之后只发 patch：变了哪些块、删了哪些、顺序有没有变
   * - 实际没有任何变化时一条都不发（省流量）
   */
  const sendContent = () => {
    const doc = useStore.getState().docs[docId]
    if (!doc) return
    /**
     * 正文还没加载时**一条都不能发**。
     * 轻量启动之后，本地可能只有元信息、blocks 是 undefined；
     * 这时候发全量等于告诉对端「这篇文档是空的」，
     * 对方照单全收就把正文清掉了 —— 而且两边都看不出异常。
     * 宁可晚几秒发，也不要发一份假的。
     */
    if (!Array.isArray(doc.blocks)) return

    const cur = doc.blocks
    const prev: Block[] | null = lastSent
    /**
     * 基准快照索引必须在这里建 —— 此时 lastSent 还是「上次广播出去的内容」。
     * 放到后面（lastSent 已被赋成 cur 之后）就变成了拿新内容当基准，
     * 三路合并的 base 等于"改动后"，合并结果毫无意义。
     */
    const prevById = new Map((prev ?? []).map((b) => [b.id, b]))
    /** 取「我已广播的、该目标最近的一个 op」作为因果依赖 */
    const afterOf = (key?: string) => (key ? [sentLastOf.get(key)] : []).filter(Boolean) as string[]

    // 没有基准可增量（首帧）→ 发全量，并在本地 oplog 里给每块记一条基线 op。
    // 少了基线，后续 op 的 after 会指向不存在的 op，
    // 基准快照也会退化成空串，三路合并直接失效。
    if (!prev) {
      lastSent = cur.slice()
      // 文稿数据同样要记基准，否则第一次改表格时算不出 baseValue
      lastSentSheet = snapshotSheet(doc.sheetData)
      // 刚发出去的全量，就是对端一定已有的版本
      peerKnown = new Map(cur.map((b) => [b.id, b]))
      for (const k of SECTION_KEYS) {
        const v = doc.sheetData?.[k]
        if (v !== undefined) peerKnown.set(sheetKeyOf(k), v)
      }
      sentRev = 0
      sentLastOf.clear()
      post({ kind: 'content', docId, authorId: me().id, blocks: cur, title: doc.title, rev: 0, ts: Date.now() })
      return
    }

    const prevMap = new Map(prev.map((b) => [b.id, b]))
    const curMap = new Map(cur.map((b) => [b.id, b]))

    const upserts = cur.filter((b) => {
      const p = prevMap.get(b.id)
      return !p || !sameBlock(p, b)
    })
    const deletes = prev.filter((b) => !curMap.has(b.id)).map((b) => b.id)

    const orderChanged = prev.length !== cur.length || prev.some((b, i) => b.id !== cur[i]?.id)
    const titleChanged = lastSentTitle !== doc.title

    /**
     * 文稿数据（工作表 / 数据表 / 画板）的差异。
     * 只有「真的变了」的那一段才发：writeSection 每次都会新建顶层对象，
     * 不比内容的话每敲一个字都要把整份 sheetData 重播一遍。
     */
    const sheet: DocSheetData = doc.sheetData || {}
    const sheetOps: CrdtOp[] = []
    for (const key of SECTION_KEYS) {
      const now = sheet[key] ?? null
      const sent = lastSentSheet?.[key] ?? null
      if (deepEqual(now, sent)) continue
      // 基准取「对端一定有的那一版」：可能比上次广播的更新（我从对端学过这一段）
      const before = peerKnown.get(sheetKeyOf(key)) ?? sent
      sheetOps.push(
        makeOp(oplog, TAB_ID, docId, 'sheet.set', {
          target: sheetKeyOf(key),
          payload: { key, value: now },
          // 改动前的这一段：没有它对端只能整段覆盖
          baseValue: before,
          after: afterOf(sheetKeyOf(key)),
        }),
      )
    }

    // 真没变化就别发
    if (!upserts.length && !deletes.length && !orderChanged && !titleChanged && !sheetOps.length) {
      lastSent = cur.slice()
      lastSentTitle = doc.title
      return
    }

    lastSent = cur.slice()
    lastSentTitle = doc.title
    lastSentSheet = snapshotSheet(doc.sheetData)

    /**
     * 把「状态差异」翻译成「操作」再广播。
     * 每个 op 带上该块变更时的基准 op（after），
     * 对端据此判断：这是因果可达（顺序执行）还是并发（需要三路合并）。
     * 这一步是「不再整篇覆盖」的关键 —— 每个块独立结算。
     */
    const ops: CrdtOp[] = []

    for (const b of deletes) {
      ops.push(makeOp(oplog, TAB_ID, docId, 'block.remove', {
        blockId: b, after: afterOf(b), baseBlock: prevById.get(b),
      }))
    }
    for (const b of upserts) {
      // 同上：优先用「对端一定有的那一版」当基准
      const before = peerKnown.get(b.id) ?? prevById.get(b.id)
      /**
       * 只改了 data → 发 card.set 而不是 block.upsert。
       * 两者的区别在于对端怎么合：card.set 走对象级字段合并
       * （「A 改了投票项、B 改了结束开关」两处都留），
       * block.upsert 走整块替换（对端的 data 会直接盖掉我本地同名块的 data）。
       */
      if (before && sameBlockExceptData(before, b) && !deepEqual(before.data, b.data)) {
        ops.push(makeOp(oplog, TAB_ID, docId, 'card.set', {
          blockId: b.id,
          target: cardKeyOf(b.id),
          payload: { data: b.data },
          // 基准 = 改动前的 data，对端拿它当字段级合并的 base
          baseData: before.data ?? null,
          baseBlock: before,
          after: afterOf(cardKeyOf(b.id)),
        }))
        continue
      }
      ops.push(makeOp(oplog, TAB_ID, docId, 'block.upsert', {
        blockId: b.id, payload: b, after: afterOf(b.id),
        // 基准快照 = 我这次改动之前该块的样子，对端拿它当三路合并的 base
        baseBlock: before ?? { id: b.id, type: b.type, text: '' },
      }))
    }
    if (orderChanged) {
      ops.push(makeOp(oplog, TAB_ID, docId, 'block.move', { payload: { order: cur.map((b) => b.id) } }))
    }
    if (titleChanged) {
      ops.push(makeOp(oplog, TAB_ID, docId, 'doc.title', { payload: { title: doc.title } }))
    }
    ops.push(...sheetOps)
    if (!ops.length) return

    // 本地先记入 log（确立基准），再广播；广播后登记进 sentLastOf
    for (const o of ops) markApplied(o, oplog)
    for (const o of ops) {
      if (o.blockId) sentLastOf.set(o.blockId, o.id)
      // 本地状态现在归我这条 op（见 stateOf 的注释）
      claim(o.target ?? o.blockId, o)
      if (o.target) sentLastOf.set(o.target, o.id)
      // 广播出去的即「对端已知的版本」：卡片 / 文稿数据只记自己那一段
      if (o.kind === 'sheet.set' && o.payload?.key) peerKnown.set(sheetKeyOf(o.payload.key), o.payload.value)
      else if (o.kind === 'card.set' && o.blockId) peerKnown.set(cardKeyOf(o.blockId), o.payload?.data)
      else if (o.kind === 'block.upsert' && o.blockId) peerKnown.set(o.blockId, o.payload)
    }
    post({ kind: 'op', docId, memberId: me().id, ops, ts: Date.now() })
  }

  /** 对端要全量：把当前状态作为全量发出去，并把基准重置 */
  const sendFullNow = () => {
    const doc = useStore.getState().docs[docId]
    // 同 sendContent：正文没加载就没有「当前状态」可言
    if (!doc || !Array.isArray(doc.blocks)) return
    lastSent = doc.blocks.slice()
    lastSentTitle = doc.title
    lastSentSheet = snapshotSheet(doc.sheetData)
    peerKnown = new Map(doc.blocks.map((b) => [b.id, b]))
    for (const k of SECTION_KEYS) {
      const v = doc.sheetData?.[k]
      if (v !== undefined) peerKnown.set(sheetKeyOf(k), v)
    }
    sentRev = 0
    post({ kind: 'content', docId, authorId: me().id, blocks: doc.blocks, title: doc.title, rev: 0, ts: Date.now() })
  }

  /**
   * 本地正文变更 → 广播。
   * 防抖 60ms：一次粘贴 / 一段中文输入法会连着改十几次。
   */
  const scheduleContent = () => {
    if (contentTimer) clearTimeout(contentTimer)
    contentTimer = setTimeout(flushContent, CONTENT_DEBOUNCE_MS)
  }

  /**
   * 立刻把攒着的本地改动发出去（不再等防抖）。
   *
   * 什么时候必须这么做：**收到别人的 op 之前**。
   * 仲裁比的是 (clock, actor)，而 clock 是发消息的那一刻才分配的。
   * 如果本地有个还没广播的改动，对端的 op 先到了：
   *   我这边「我方版本」查不到任何 op → 只能按 (0, '') 参与仲裁 → 必输；
   *   对方那边「我方版本」是它刚发的那条 → 正常比。
   * 两边比的不是同一对元素，结果就是各判各的输赢 —— 三端并发实测分叉。
   * 先把自己的改动说出去（拿到 clock），再听别人的，两边才在比同一对元素。
   */
  function flushContent() {
    if (contentTimer) {
      clearTimeout(contentTimer)
      contentTimer = null
    }
    sendContent()
  }

  const publishLocalCursor = (force = false) => {
    const c = selectionToCursor(getRoot())
    const key = c ? `${c.blockId}:${c.offset}:${c.range[0]}-${c.range[1]}` : ''
    if (!force && key === lastCursorKey) return
    lastCursorKey = key

    const st = useStore.getState()
    if (!c) {
      // 选区离开正文（点进评论区 / 工具栏）：告诉别人我先撤了
      if (st.cursors.some((x) => x.docId === docId && x.memberId === me().id)) {
        st.removeMemberCursor(docId, me().id)
      }
      post({ kind: 'cursor', docId, memberId: me().id, cursor: null, ts: Date.now() })
      return
    }

    const memberId = me().id
    const cursor: CollabCursor = {
      id: `cur_${docId}_${memberId}`,
      docId,
      memberId,
      blockId: c.blockId,
      offset: c.offset,
      range: c.range,
      color: colorOfMember(memberId),
      activeAt: Date.now(),
    }
    st.setCursor(cursor)
    post({ kind: 'cursor', docId, memberId, cursor, ts: Date.now() })
  }

  /* ---------------- 收到 ---------------- */

  /**
   * 应用增量。基准对不上（中间漏了消息 / 对端刚上线 / 我刚重置过）
   * 就退回全量，并向发送方要一份完整内容，避免静默错位。
   */
  /**
   * 应用一批远端 op。
   *
   * 判定分三种：
   *  ① 目标块我根本没见过 / 这 op 不碰正文块 → 直接应用
   *  ② 该 op 的基准是我本地该块**当前**的版本 → 因果可达，顺序应用
   *  ③ 基准是更早的版本（中间漏了）或从没见过 → 并发，走三路合并
   *
   * ②③ 的区别就是「不丢数据」与「整篇覆盖」的分界。
   */
  const applyOp = (m: Extract<CollabMessage, { kind: 'op' }>) => {
    /**
     * 这里**不查** lastAppliedTs 水位。
     * 那道水位是给「整篇全量 / 增量」挡乱序旧消息用的；
     * 拿到 op 身上来用会出事：后加入的标签页广播了一次全量内容（水位被推到现在），
     * 此前其他人已经发出的 op 就全被当成「旧消息」丢掉 ——
     * 实测三端并发就是这样分叉的：A、B 各自的改动谁也没送达谁。
     * op 自带 id（markApplied 去重）与因果信息，顺序交给合并本身处理。
     */
    const st = useStore.getState()
    const cur = st.docs[docId]
    if (!cur) return

    /**
     * 直接应用，不做「因果就绪就卡住」的等待。
     *
     * 原本用 ingest() 的 isReady 严格卡依赖，后加入的标签页
     * （它没见过其他人的历史 op）会被永久卡在缓冲区里 —— op 到了却生效不了。
     *
     * 去掉这层依赖是安全的：每个 op 都自带基准值（baseBlock / baseData /
     * baseValue），三路合并完全靠它，不依赖本地 log 里的因果顺序。
     * 真正的顺序/并发判定在下面的合并逻辑里。
     */
    /**
     * 每条 op 都是「先合并、后记账」（见下面循环末尾的 markApplied）：
     * markApplied 会把 lastOpOf[目标] 覆盖成这条 op 本身，
     * 先记账再读就永远读到「对方自己」——
     * ① 因果判定恒为假，快捷路径形同虚设；
     * ② 仲裁的「我方版本」也是这条，wins(o, o) 恒真，两端各自都判自己赢，永不收敛；
     * ③ 同一批里第二条指向同块的 op，拿到的还是这批之前的旧版本。
     * 逐条处理 + 逐条记账，上面三条同时解决。
     */
    const ready = m.ops.filter((o) => !oplog.seen.has(o.id))
    if (!ready.length) return

    const merged = new Map(cur.blocks.map((b) => [b.id, { ...b }]))
    let nextOrder: string[] | undefined
    let title = cur.title
    let changed = false
    /** doc.sheetData 的合并结果（只有 sheet.set 会动它） */
    let nextSheet: DocSheetData | null = null
    /** 本批产生的冲突，最后统一写进 store 给协作条 */
    const conflicts: Omit<CollabConflict, 'id' | 'at' | 'highlightUntil'>[] = []
    const authorName = st.getMember(m.memberId)?.name || m.memberId

    /** 「对方是不是在我的改动之上继续改的」：after 里含我最后一个 op 即为是 */
    const isCausal = (o: CrdtOp, key: string) => {
      const myLast = oplog.lastOpOf.get(key)
      return !!myLast && o.after.includes(myLast)
    }
    /** 仲裁：谁的 (clock, actor) 大谁赢 —— 与正文完全同一套确定性规则 */
    const tieBreakOf = (o: CrdtOp, key: string) => {
      const mine = stateOf.get(key)
      return () => wins(mine?.clock ?? 0, mine?.actor ?? '', o.clock, o.actor)
    }
    /**
     * 因果可达也不能无条件整块采纳。
     *
     * 「对方基于我的改动继续改」只说明对方的快照**包含我的**，
     * 不代表它也包含「我把别人的改动合并进来之后的那份」。
     * 三端并发就会翻车：C 合过 A 的 op（本地 = A+C），随后收到 A 的下一条 op
     * （after 含 A 那条，判为因果可达）→ 整块换成 A 的快照 → C 自己的 C 没了。
     * 修法：本地值必须还等于「对方已知的那一版」（peerKnown）才允许整块采纳，
     * 否则一律走三路合并。
     */
    const localIsKnown = (key: string, local: any) => {
      const known = peerKnown.get(key)
      return known === undefined || deepEqual(local, known)
    }
    /** 对象级冲突 → 人话位置 */
    const labelsOf = (list: ObjConflict[], names: Record<string, string>) =>
      list.map((c) => describeConflictPath(c.segments, names))

    /**
     * 处理一条 op。
     * 记账（markApplied）刻意放在调用方、也就是本函数**之后**：
     * 函数里读到的 lastOpOf / verOf 因此始终是「这条 op 之前」的我方版本。
     */
    const applyOne = (o: CrdtOp) => {
      if (o.kind === 'block.remove') {
        if (merged.delete(o.blockId!)) changed = true
        peerKnown.delete(o.blockId!)
        // 删除也是一种状态归属：记上对方这条 op，
        // 否则同一个块「我删了、对方又改了」时，我这边没有可比较的版本
        claim(o.blockId!, o)
        return
      }
      if (o.kind === 'block.move') {
        nextOrder = (o.payload?.order as string[]) || nextOrder
        changed = true
        return
      }
      if (o.kind === 'doc.title') {
        title = String(o.payload?.title ?? title)
        changed = true
        return
      }

      /* ---------------- sheet.set：文稿数据（工作表 / 数据表 / 画板） ---------------- */
      if (o.kind === 'sheet.set') {
        const key = String(o.payload?.key ?? o.target?.replace(/^sheet:/, '') ?? '')
        if (!isSectionKey(key)) return
        const before = (nextSheet ?? cur.sheetData ?? {})[key] ?? null
        const theirs = o.payload?.value ?? null
        if (deepEqual(before, theirs)) return

        let value = theirs
        let labels: string[] = []
        /**
         * 对方没有可对齐的基准（他基于我没见过的版本改的）→
         * 只能整段采纳；逐字段硬合会把两边新增的行混在一起。
         */
        if (o.baseValue !== undefined && o.baseValue !== null
          && !(isCausal(o, sheetKeyOf(key)) && localIsKnown(sheetKeyOf(key), before))) {
          const r = mergeObject(o.baseValue, before, theirs, { tieBreak: tieBreakOf(o, sheetKeyOf(key)) })
          value = r.value
          labels = labelsOf(r.conflicts, collectNames(before))
        }
        // 对方手上就是 theirs（哪怕我仲裁时没采纳它）——peerKnown 记的是「对方有什么」
        peerKnown.set(sheetKeyOf(key), theirs)
        // 本地状态归谁：整段采纳了对方的、或我赢了，才记对方那条 op
        if (value === theirs) claim(sheetKeyOf(key), o)
        nextSheet = { ...(nextSheet ?? cur.sheetData ?? {}), [key]: value } as DocSheetData
        if (labels.length) {
          conflicts.push({
            docId, target: 'sheet', section: key, blockId: undefined,
            where: `${SECTION_LABEL[key]}${labels.length > 1 ? ` 等 ${labels.length} 处` : ''} · ${labels[0]}`,
            actorId: m.memberId, actorName: authorName, count: labels.length,
          })
        }
        return
      }

      /* ---------------- card.set：卡片数据（投票 / 看板 / 打卡 …） ---------------- */
      if (o.kind === 'card.set') {
        const bid = o.blockId
        if (!bid) return
        const local = merged.get(bid)
        const theirs = o.payload?.data
        // 本地没有这个块：正文还没同步过来，丢了这条 op 也没有意义
        // （对方的 block.upsert 到了之后会把整块带过来）
        if (!local || theirs === undefined) return
        if (deepEqual(local.data ?? null, theirs)) return

        let value = theirs
        let labels: string[] = []
        if (o.baseData !== undefined && o.baseData !== null
          && !(isCausal(o, cardKeyOf(bid)) && localIsKnown(cardKeyOf(bid), local.data ?? null))) {
          const r = mergeObject(o.baseData, local.data ?? {}, theirs, { tieBreak: tieBreakOf(o, cardKeyOf(bid)) })
          value = r.value
          labels = labelsOf(r.conflicts, collectNames(theirs))
        }
        const nextBlock = { ...local, data: value }
        peerKnown.set(cardKeyOf(bid), theirs)
        if (value === theirs) claim(cardKeyOf(bid), o)
        merged.set(bid, nextBlock)
        changed = true
        if (labels.length) {
          conflicts.push({
            docId, target: 'card', blockId: bid,
            where: `${cardNameOf(local)}${labels.length > 1 ? ` 等 ${labels.length} 处` : ''} · ${labels[0]}`,
            actorId: m.memberId, actorName: authorName, count: labels.length,
          })
        }
        return
      }

      if (o.kind !== 'block.upsert') return

      const incoming = o.payload as Block
      const local = merged.get(o.blockId!)
      if (!local) {
        // 没见过这块 → 直接放
        merged.set(o.blockId!, incoming)
        peerKnown.set(o.blockId!, incoming)
        claim(o.blockId!, o)
        changed = true
        return
      }

      /**
       * 同一块已有本地内容 —— 先判因果，再判并发。
       *
       * 判据只能是「对方的 op 是否建立在我最后一个 op 之上」：
       *   o.after 里含 myLast → 对方是在我的改动之上继续编辑的，
       *     因果可达，它的版本已经包含了我的改动。
       *   不含 → 双方互不知晓对方的新改动 → 真并发，走三路合并。
       *
       * 两个曾经的坑：
       * ① 用「本地内容是否等于 base」判断因果 → "对方基于我改的"被误判成并发，
       *    再整体替换 incoming，把自己的改动一起抹掉。
       * ② 只看 after 就整块采纳 → 三端并发时 C 会丢掉自己刚合出来的内容，
       *    所以还要过一道 localIsKnown（见上）。
       */
      if (isCausal(o, o.blockId!) && localIsKnown(o.blockId!, local)) {
        merged.set(o.blockId!, incoming)   // 因果可达且本地没有多余改动：对方的版本更完整
        peerKnown.set(o.blockId!, incoming)
        claim(o.blockId!, o)
        changed = true
        return
      }

      // 真并发：取共同祖先作为三路合并的 base。
      // 优先用 op 自带的 baseBlock —— after 为空时（真并发）本地 log 里查不到基准。
      const baseOpId = o.after[o.after.length - 1]
      const logged = baseOpId ? blockVersionAt(oplog, o.blockId!, baseOpId) : undefined
      const baseVer = o.baseBlock
        ? { block: o.baseBlock, text: String(o.baseBlock.text ?? ''), opId: '', clock: 0, actor: '' }
        : logged
      if (!baseVer) {
        // 共同祖先在本地不存在（对端基于我没见过的版本）→ 退化为确定性择一
        const mine = stateOf.get(o.blockId!)
        const picked = wins(mine?.clock ?? 0, mine?.actor ?? '', o.clock, o.actor) ? incoming : local
        merged.set(o.blockId!, picked)
        peerKnown.set(o.blockId!, incoming)
        if (picked === incoming) claim(o.blockId!, o)
        changed = true
        return
      }

      /**
       * 两边都改了这一块 → 三路合并。
       *
       * 仲裁的「我方版本」必须取**这条 op 记账之前**的版本：
       * 一旦先记账，log 里最后一条就是刚进来的这条，wins(o, o) 恒为真，
       * 两端各自都判「我赢」，各留各的，谁也不服谁 —— 永远不收敛。
       * （applyOne 读 oplog.verOf、调用方随后才 markApplied，就是为这个。）
       */
      const mine = stateOf.get(o.blockId!)
      const tieBreak = () => wins(mine?.clock ?? 0, mine?.actor ?? '', o.clock, o.actor)
      const r = mergeText(
        baseVer.text,
        String(local.text ?? ''),
        String(incoming.text ?? ''),
        tieBreak,
      )
      const out: Block = { ...incoming, text: r.text }

      /**
       * 卡片数据单独做一次对象级三路合并。
       * 正文走的是「整块取对方 + 文本合并」，如果 data 也这么取，
       * 「A 改了投票、B 改了打卡」就会互相顶掉 —— data 必须按字段合。
       */
      let dataLabels: string[] = []
      const hasData = baseVer.block?.data !== undefined || local.data !== undefined || incoming.data !== undefined
      if (hasData) {
        const d = mergeObject(baseVer.block?.data ?? {}, local.data ?? {}, incoming.data ?? {}, { tieBreak })
        out.data = d.value
        dataLabels = labelsOf(d.conflicts, collectNames(incoming.data))
      }

      /**
       * html 只有在「正文就是对方那一版」时才留得住。
       *
       * html 是某一次输入当时的 innerHTML，和别的版本的正文不配套。
       * 合并结果只要不是逐字等于 theirs（我赢了、或两边真的合出了新句子），
       * 带着对方的 html 就是错的 —— 而 Editor 是照着 html 渲染的，
       * 于是 store 里是「AAA」、界面上却显示「BBB」：
       * 仲裁明明生效了，用户看到的还是没合并过的内容（比丢格式难查得多）。
       */
      if (r.text !== incoming.text && out.html !== undefined) out.html = undefined

      merged.set(o.blockId!, out)
      peerKnown.set(o.blockId!, incoming)
      /**
       * 归属只跟**真正判给对方的那个位置**走：
       * 没有任何一个冲突位置判给对方 → 归属不动（正文里虽然混进了对方
       * 不冲突的那几处，但那些位置不参与后续仲裁）；
       * 有位置判给了对方 → 归属记对方那条 op。
       * 注意不能用「我赢没赢」来判断：没有冲突时 mergeText 根本不调 tieBreak，
       * 拿它的返回值当结论会凭空改归属。
       */
      if (r.conflicts.some((c) => c.winner === 'theirs')) claim(o.blockId!, o)
      const n = r.conflicts.length + dataLabels.length
      if (n) {
        const quote = String(out.text || '').replace(/\s+/g, ' ').trim().slice(0, 18)
        const where = dataLabels.length
          ? `${cardNameOf(out)}${dataLabels.length > 1 ? ` 等 ${dataLabels.length} 处` : ''} · ${dataLabels[0]}`
          : quote ? `正文块「${quote}」${r.conflicts.length > 1 ? ` 等 ${r.conflicts.length} 处` : ''}` : '正文块'
        conflicts.push({
          docId,
          // 卡片块（data 也在变）算 card，纯文本冲突算 block
          target: dataLabels.length ? 'card' : 'block',
          blockId: o.blockId!,
          where,
          actorId: m.memberId, actorName: authorName, count: n,
        })
      }
      changed = true
    }

    for (const o of ready) {
      applyOne(o)
      markApplied(o, oplog)
    }

    if (conflicts.length) {
      const st2 = useStore.getState()
      for (const c of conflicts) st2.pushCollabConflict(c)
    }
    if (!changed && !nextSheet) return

    let next = Array.from(merged.values())
    if (nextOrder) {
      const byId = new Map(next.map((b) => [b.id, b]))
      const reordered = nextOrder.map((id) => byId.get(id)).filter(Boolean) as Block[]
      // 保留不在 order 里的块（对端可能没看到它们），追加在末尾
      const inOrder = new Set(nextOrder)
      next = [...reordered, ...next.filter((b) => !inOrder.has(b.id))]
    }

    const blocksSame = title === cur.title && sameBlocks(next, cur.blocks)
    if (blocksSame && !nextSheet) return

    applyRemoteDepth++
    try {
      if (!blocksSame) st.setDocBlocksRemote(docId, next, title)
      if (nextSheet) st.setDocSheetRemote(docId, nextSheet)
    } finally {
      applyRemoteDepth--
    }
  }

  /** 把攒下的远端 op 按来源冲刷（每来源一次 applyOp = 一次渲染 + 一次落盘） */
  const flushRemoteOps = () => {
    applyTimer = null
    if (!pendingRemote.size) return
    /**
     * 只在「我确实有还没发出去的本地改动」时提前发。
     * 顺序问题只存在于这种情况（见 flushContent 的注释：仲裁要靠 clock 定序）；
     * 无条件 flush 会让「收到别人的 op 就把收下来的内容再播一遍」，
     * 对端每收一条就重写一次 DOM —— 正在打字的那一端会丢字。
     */
    if (contentTimer) flushContent()
    const batches = [...pendingRemote.values()]
    pendingRemote.clear()
    for (const b of batches) {
      applyOp({ v: PROTOCOL, kind: 'op', docId, from: '', memberId: b.memberId, ops: b.ops, ts: b.ts })
    }
  }

  /** 收下一批远端 op：先进桶，攒够一个短窗口再一起应用 */
  const scheduleRemoteOps = (m: Extract<CollabMessage, { kind: 'op' }>) => {
    const bucket = pendingRemote.get(m.from)
    if (bucket) {
      bucket.ops.push(...m.ops)
      if (m.ts > bucket.ts) bucket.ts = m.ts
    } else {
      pendingRemote.set(m.from, { memberId: m.memberId, ops: [...m.ops], ts: m.ts })
    }
    if (applyTimer) clearTimeout(applyTimer)
    applyTimer = setTimeout(flushRemoteOps, REMOTE_APPLY_MS)
  }

  const applyPatch = (m: Extract<CollabMessage, { kind: 'patch' }>) => {
    if (m.ts < lastAppliedTs) return
    lastAppliedTs = m.ts

    const expect = peerRev.get(m.from) ?? 0
    if (m.base !== expect) {
      // 基准错位（漏了消息 / 对端刚上线没拿到我的基准）：要一份全量
      post({ kind: 'need-full', docId, memberId: me().id, ts: Date.now() })
      return
    }

    const st = useStore.getState()
    const cur = st.docs[docId]
    if (!cur) return

    // 增量的 upserts 里可能含「内容其实没变」的块（本地改回原样），
    // 过滤掉能少一次无谓渲染
    const curMap = new Map(cur.blocks.map((b) => [b.id, b]))
    const upserts = m.upserts.filter((b) => {
      const c = curMap.get(b.id)
      return !c || !sameBlock(c, b)
    })
    peerRev.set(m.from, m.rev)
    if (!upserts.length && !m.deletes.length && !m.order && m.title === undefined) return

    const del = new Set(m.deletes)
    const merged = new Map(cur.blocks.filter((b) => !del.has(b.id)).map((b) => [b.id, b]))
    for (const b of m.upserts) merged.set(b.id, b)
    let next = Array.from(merged.values())
    if (m.order) {
      const byId = new Map(next.map((b) => [b.id, b]))
      next = m.order.map((id) => byId.get(id)).filter(Boolean) as Block[]
    }

    if (m.title === cur.title && sameBlocks(next, cur.blocks)) return

    applyRemoteDepth++
    try {
      st.setDocBlocksRemote(docId, next, m.title ?? cur.title)
    } finally {
      applyRemoteDepth--
    }
  }

  const applyContent = (m: Extract<CollabMessage, { kind: 'content' }>) => {
    if (m.ts < lastAppliedTs) return // 乱序的旧消息
    lastAppliedTs = m.ts
    // 收到全量：把该来源的期望值对齐到它当前序号，后续 patch 从这里接
    peerRev.set(m.from, m.rev ?? 0)
    const st = useStore.getState()
    const cur = st.docs[docId]
    if (!cur) return // 本地没有这篇文档（可能刚被删）

    /**
     * 全量内容**不是覆盖指令**。
     *
     * 它的用途是「让刚上线的标签页拿到一份文档」，可发送方的基准往往已经很旧了
     * （它自己也是从更早的时点带上来的）。以前整段替换，三端并发时直接出事：
     * C 刚上线广播全量（带着 C 自己的改动），把 A、B 刚敲的字整篇盖掉，
     * 而 A、B 的 op 又被上面那道时间戳水位丢掉 —— 三端各留各的。
     *
     * 所以它只能**补**，不能**覆盖**：
     *   本地没有这块 → 收下（新块 / 我这边缺的那部分）
     *   本地已经有   → 保留我的
     * 为什么不能反过来「我等于我上次广播的内容就采信对方的」：
     * peerKnown 记的是「我告诉过大家什么」，不是「**这个**发送方知道什么」。
     * 晚加入的 C 从没收到过 A 的 op，A 却会以为自己广播过就等于 C 也有 ——
     * 于是 C 的旧快照把 A 的新内容盖掉（实测三端并发就分叉在这里）。
     * 保留本地这份不会丢东西：我的下一次广播会带着基准推过去，对端能正确合并。
     * （删除由 block.remove op 单独同步，不靠全量。）
     */
    const localById = new Map(cur.blocks.map((b) => [b.id, b]))
    const next: Block[] = []
    const taken = new Set<string>()
    for (const b of m.blocks) {
      taken.add(b.id)
      next.push(localById.get(b.id) ?? b)
    }
    // 本地有、这份全量里没有的块：保留（对方可能只是还没拿到）
    for (const b of cur.blocks) if (!taken.has(b.id)) next.push(b)

    peerKnown = new Map(m.blocks.map((b) => [b.id, b]))

    const title = m.title ?? cur.title
    if (title === cur.title && sameBlocks(next, cur.blocks)) return // 已经是这份内容，别白渲染一遍

    /**
     * 挡住「远端来的改动又被当成自己的改动广播出去」：
     * 少了这一步就是 A→B→A→B 无限回环（两边每次都写一次内存 + 重渲染）。
     * 计数必须包住 set()：zustand 的订阅回调是在 set 里同步触发的。
     */
    applyRemoteDepth++
    try {
      st.setDocBlocksRemote(docId, next, title)
    } finally {
      applyRemoteDepth--
    }
  }

  const onMessage = (e: MessageEvent) => {
    if (closed) return
    const m = e.data as CollabMessage
    if (!isMessage(m, docId)) return
    if (m.from === TAB_ID) return // 自己发的不处理（BroadcastChannel 不会回环，这里是双保险）

    const st = useStore.getState()
    switch (m.kind) {
      case 'content':
        applyContent(m)
        break
      case 'op':
        scheduleRemoteOps(m)
        break
      case 'patch':
        applyPatch(m)
        break
      case 'need-full':
        // 对端说它那边基准错位了，重发一份全量让它自愈
        if (m.memberId !== st.currentUser.id) sendFullNow()
        break
      case 'cursor': {
        // 同一个人的另一个标签页不算「别人」：不显示自己的光标，人数也不重复计
        if (m.memberId === st.currentUser.id) return
        if (!m.cursor) {
          st.removeMemberCursor(docId, m.memberId)
          break
        }
        // 颜色以本地的成员表为准（标识色归一，不接受对端塞任意色值）
        st.setCursor({ ...m.cursor, color: colorOfMember(m.memberId) })
        break
      }
      case 'presence': {
        if (m.memberId === st.currentUser.id) return
        const fresh = !peers.has(m.memberId)
        peers.set(m.memberId, {
          memberId: m.memberId,
          docId,
          tabId: m.from,
          activeAt: m.activeAt,
          lastSeen: Date.now(),
        })
        owned.add(m.memberId)
        emitPeers()
        // 刚发现的新成员：立刻回一条心跳，省掉等对方下一次心跳的 5s 空窗
        if (fresh) sendPresence()
        break
      }
      case 'leave': {
        if (m.memberId === st.currentUser.id) return
        peers.delete(m.memberId)
        owned.delete(m.memberId)
        st.removeMemberCursor(docId, m.memberId)
        emitPeers()
        break
      }
    }
  }

  /* ---------------- 本地监听 ---------------- */

  /** 真实活跃时间：打字 / 点鼠标。用于「正在编辑 / 暂时离开」的文案判断 */
  const bumpActivity = () => {
    lastActivityAt = Date.now()
  }

  const onSelectionChange = () => {
    // 只关心正文里的选区，但离开正文也要发（撤掉光标）
    if (!getRoot()) return
    publishLocalCursor()
  }

  /**
   * 正文变更 → 广播。
   * 挂 store 订阅而不是改每个调用点：工具栏改块类型、插入卡片、
   * 恢复历史版本……凡是动了 docs[docId] 的路径都自动同步，不漏。
   * setDocBlocksRemote 内部用 applyRemoteDepth 挡住「远端来的改动再发出去」。
   */
  const unsubStore = useStore.subscribe((s, prev) => {
    if (closed) return
    if (applyRemoteDepth > 0) return
    const next = s.docs[docId]
    if (!next || next === prev.docs[docId]) return
    scheduleContent()
  })

  channel.addEventListener('message', onMessage)
  document.addEventListener('selectionchange', onSelectionChange)
  window.addEventListener('keydown', bumpActivity, { passive: true })
  window.addEventListener('pointerdown', bumpActivity, { passive: true })

  // 关闭 / 刷新 / 被系统回收：先喊一声「我走了」，对端立刻摘掉光标
  const onUnload = () => sendLeave()
  window.addEventListener('beforeunload', onUnload)
  window.addEventListener('pagehide', onUnload)

  const timer = setInterval(() => {
    sendPresence()
    prunePeers()
  }, HEARTBEAT_MS)

  /**
   * 开场就把基准立起来（而不是等到「第一次本地改动」再立）。
   *
   * 没有基准时，第一次改动会走首帧分支，广播出去的是一份**整篇全量**而不是 op：
   * 对端只能整篇接收，压根没有合并的机会 —— 两个人同时改就会互相覆盖，
   * 协作条也一片静默（既没有冲突记录，也说不清是谁改的）。
   * 实测「B 输入的内容 A 看不到」就是这么来的：后进标签页挂上会话后没发生任何
   * 文档改动，基准一直是空的，它的第一笔改动就走了全量通道。
   */
  const doc0 = useStore.getState().docs[docId]
  // 正文未加载时不能建基准：blocks 是 undefined，
  // 而且更糟的是会把「空」当成对端已知的状态，后面再发全量就把正文清掉了。
  if (doc0 && Array.isArray(doc0.blocks)) {
    lastSent = doc0.blocks.slice()
    lastSentTitle = doc0.title
    lastSentSheet = snapshotSheet(doc0.sheetData)
    peerKnown = new Map(doc0.blocks.map((b) => [b.id, b]))
    for (const k of SECTION_KEYS) {
      const v = doc0.sheetData?.[k]
      if (v !== undefined) peerKnown.set(sheetKeyOf(k), v)
    }
    // 会话刚开时我一条 op 都没发过，stateOf 为空 —— 这正是「我没改过这一块」的表达：
    // 仲裁时自然让给对方（对端那边则会判自己赢），两端结论一致。
  }

  // 开场：先亮个相（也让先到的标签页立刻发现我）
  sendPresence()
  publishLocalCursor(true)

  const close = () => {
    if (closed) return
    // 先喊「我走了」再置 closed —— post() 里有 closed 守卫，顺序反了就发不出去
    sendLeave()
    closed = true
    clearInterval(timer)
    if (contentTimer) clearTimeout(contentTimer)
    contentTimer = null
    if (applyTimer) clearTimeout(applyTimer)
    applyTimer = null
    pendingRemote.clear()
    unsubStore()
    channel.removeEventListener('message', onMessage)
    document.removeEventListener('selectionchange', onSelectionChange)
    window.removeEventListener('keydown', bumpActivity)
    window.removeEventListener('pointerdown', bumpActivity)
    window.removeEventListener('beforeunload', onUnload)
    window.removeEventListener('pagehide', onUnload)
    try {
      channel.close()
    } catch {
      /* 已关闭 */
    }
    const hadPeers = owned.size > 0
    for (const id of owned) peers.delete(id)
    owned.clear()
    if (hadPeers) emitPeers()
    useStore.getState().clearDocCursors(docId)
  }

  return { close }
}
