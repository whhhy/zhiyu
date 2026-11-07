import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useStore } from '@/store'
import { ensureDocLoaded } from '@/lib/sync'
import { getMode, recordDocView, fetchBacklinks, fetchOutlinks, getDocShare, setDocShare } from '@/lib/api'
import { usePrefs, getPrefs, FONT_SIZE_PX } from '@/lib/prefs'
import { useDocPerms, useSpacePerms } from '@/lib/perms'
import { Avatar, AvatarGroup, Dropdown, MenuItem, MenuDivider, MenuLabel, Modal, Popover, Switch, Tag, Tooltip, Button, Empty, Input } from '@/components/ui'
import { timeAgo, DOC_TYPE_META } from '@/components/layout/TopBar'
import DocTree from '@/components/doc/Tree'
import MoveDocDialog from '@/components/doc/MoveDocDialog'
import Editor from '@/components/doc/Editor'
import Toolbar from '@/components/doc/Toolbar'
import Outline, { type OutlineMode } from '@/components/doc/Outline'
import RemoteCursorLayer, { IDLE_MS } from '@/components/doc/RemoteCursor'
import ShortcutPanel from '@/components/doc/Shortcuts'
import {
  useTextSelection, SelectionToolbar, SelectionCommentPop, SelectionCommentPanel,
  type SelectionInfo,
} from '@/components/doc/Selection'
import SheetView from '@/components/doc/SheetView'
import BoardView from '@/components/doc/BoardView'
import TableView from '@/components/doc/TableView'
import { useCollaboration, useDemoCollaborators } from '@/hooks/useFakeCollaborators'
import { useCollabPeers, useDemoMode, setDemoMode, type CollabPeer } from '@/lib/collaboration'
import { ConflictNotice } from '@/components/collab'
import { useMediaQuery, BP } from '@/hooks/useMediaQuery'
import type { Block, CollabCursor, DocType, DocVersion } from '@/types'
import { YUQUE_CARDS } from '@/data/cards'
import { downloadDocAs } from '@/lib/io'
import { safeFileNameWithExt } from '@/lib/filename'
import { withCardNotices } from '@/lib/blocks-markdown'
import { binaryWhere } from '@/lib/attachment-store'
import { pushUndo, redoDoc, undoDoc, clearUndo } from '@/lib/undo'
import { normalizeSlug, docShareUrl } from '@/lib/slug'
import { copyText } from '@/lib/clipboard'
import './DocPage.css'
import './print.css'

/* ============================================================
   文档页 —— 语雀三段式：目录树 | 内容 | 大纲
   ============================================================ */

export default function DocPage() {
  const { bookId, docId } = useParams()
  /** 「移动 / 复制到…」的弹窗（逻辑在 @/components/doc/MoveDocDialog） */
  const [moveOpen, setMoveOpen] = useState(false)
  /** 打开时是「移动」还是「复制」—— 树菜单的两项分别传不同的初值 */
  const [moveMode, setMoveMode] = useState<'move' | 'copy'>('move')
  const navigate = useNavigate()
  const {
    docs, nodes, books, members, getMember, comments, setDocBlocks, updateDoc, deleteDoc,
    isFavorite, toggleFavorite, toast, currentUser, cursors,
    setTreeCollapsed, treeCollapsed,
    /* 历史版本：存快照 / 恢复到某一版 */
    addDocVersion, restoreDocVersion,
    /* 文档锁定：锁 / 解锁 */
    lockDoc, unlockDoc,
  } = useStore()

  const doc = docs[docId!]
  /**
   * 正文按需加载。
   * 轻量启动时 store 里只有这篇的元信息（标题/作者/字数），没有 blocks；
   * 打开时才去服务端要正文。没这一步的话，2000 篇的知识库登录一次要下 18MB。
   *
   * 注意 `doc` 存在但 `doc.blocks` 还没有，是**加载中**，不是「文档不存在」——
   * 早先只有一个 `if (!doc)` 分支，会把加载中的文档误报成已删除。
   */
  const bodyLoading = !!doc && !Array.isArray(doc.blocks)
  useEffect(() => {
    if (!docId) return
    if (Array.isArray(docs[docId]?.blocks)) return
    let alive = true
    ensureDocLoaded(docId).then(() => { if (alive) void useStore.getState() })
    return () => { alive = false }
  }, [docId, docs])

  /**
   * 章节锚点跳转。
   *
   * 语雀那个功能字面就叫「**章节**链接」：链的不是整篇，是某一节。
   * 形式是 `#/book/x/doc/y#<块id>` —— 锚点直接用块的 id，
   * 因为大纲、划词评论定位、「查看该位置」已经全在用 `data-block-id` 了，
   * 这里不另造一套坐标。
   *
   * **不需要**「等 blocks 加载完再跳」的守卫：轻量启动之后正文是按需拉的，
   * 刚进页面时那一节确实还没渲染，但这个 effect 的依赖里就有 `docs` ——
   * 正文到位会触发一次重跑，那时元素才在。所以这里找不到元素就直接返回。
   * （一开始写了条 `if (!blocks) return` 的守卫，破坏对照时发现删掉它一条断言都不红 ——
   * 查下来是它本来就没作用。留着一条自己都说不清有没有用的分支，不如删。）
   *
   * 监听 hashchange 是为了「同页内再点一次同一锚点」——
   * 只在挂载时跳一次的话，第二次点同一个链接会停在原地，看起来像没反应。
   */
  useEffect(() => {
    if (!docId) return
    const readAnchor = () => {
      const h = window.location.hash || ''
      const i = h.lastIndexOf('#')
      return i >= 0 && i < h.length - 1 ? h.slice(i + 1) : ''
    }
    const go = () => {
      const anchor = readAnchor()
      if (!anchor) return
      const el = scrollRef.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(anchor)}"]`)
      if (!el) return
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      // 闪一下：告诉读者「你到的是这一节」，而不是「页面好像没动」。
      // 复用协同合并高亮那一套 class（collab.css 里已定义好动画和 reduced-motion），
      // 不另造一套 —— 两处高亮长得不一样只会让人以为有两种含义。
      el.classList.remove('yq-collab-flash')
      void el.offsetWidth
      el.classList.add('yq-collab-flash')
      setTimeout(() => el.classList.remove('yq-collab-flash'), 2000)
    }
    // 先等一拍：正文是异步拉的，刚挂载时往往还没有
    const t = setTimeout(go, 60)
    window.addEventListener('hashchange', go)
    return () => { clearTimeout(t); window.removeEventListener('hashchange', go) }
  }, [docId, docs])

  /**
   * 上报一次阅读（知识库统计页的数据来源）。
   * 放在这里而不是「文档加载完成」之后，是为了让「点开就看」也算一次 ——
   * 统计要的是「有多少人看过」，不是「有多少人看完了」。
   * 服务端会判读权限、按 (文档, 天, 人) 去重，重复打开不灌水。
   */
  useEffect(() => {
    if (!docId || getMode() !== 'server') return
    recordDocView(docId)
  }, [docId])
  // URL 上的 bookId 可能与文档实际归属不一致（例如手改链接），
  // 目录树与面包屑一律以文档实际所在的知识库为准，避免串库。
  const realBookId = nodes.find((n) => n.docId === docId)?.bookId || bookId

  // 用 realBookId（路由上的 bookId 或目录节点反查出来的那个），
  // 而不是 doc.bookId —— Doc 类型里压根没有这个字段，库的归属在目录树上。
  /**
 * 能当目标的知识库：**同一个空间里、我现在这篇不在的那几个**。
 *
 * 刻意不列全部知识库 —— 跨空间搬文档等于把内容带到一个
 * 那里的人可能不该看到的地方。真要跨空间，应该先建一个知识库。
 *
 * 服务端还会再判一次（源库要 edit、目标库要 create），这里只是
 * **别给用户看一个点了会被拒的选项**。
 *
 * ⚠️ 这份计算搬进了 `@/components/doc/MoveDocDialog`（连同那 ~100 行弹窗）。
 *    这里只留一个**长度判断**给顶栏菜单用（决定「移动 / 复制到…」要不要禁用）。
 *    两处各算一份 = 两份会分叉的口径，正是这轮栽过两次的形状。
 */
const moveTargets = useMemo(() => {
    const cur = books.find((b) => b.id === realBookId)
    if (!cur) return []
    return books.filter((b) => b.id !== cur.id && b.spaceId === cur.spaceId)
  }, [books, realBookId])
  const book = books.find((b) => b.id === realBookId)

  /**
   * 全局水印。
   *
   * 之前这个开关只存不执行，界面上写「尚未实现」——
   * 现在它真的会在正文上叠一层带阅读人姓名与账号的水印。
   *
   * 局限要说明白：**这是网页水印，能被有技术能力的人用开发者工具去掉**。
   * 它的价值在于「随手截屏外传时能追到人」，不是「防技术手段」。
   * 真要防外泄，靠的是只读角色与导出限制，不是水印。
   *
   * 注意选择器里**不能**用 getBookSettings：它每次都 spread 出一个新对象
   * （`{...defaults, ...stored}`），而 zustand 用 Object.is 比较快照 ——
   * 每次渲染都「新」，于是无限重渲染。这里选的是**原始行**，
   * 它只在设置真的被改时才换引用。
   */
  const rawBookSettings = useStore((s) => (realBookId ? s.bookSettings[realBookId] : undefined))
  const watermarkOn = !!rawBookSettings?.watermark
  const watermarkText = String(rawBookSettings?.watermarkText || '').trim() || '内部资料'

  /** 编辑器字号：本地偏好，不参与同步（见 lib/prefs.ts 的说明） */
  const [prefs] = usePrefs()
  const editorFontPx = FONT_SIZE_PX[prefs.editorFontSize]
  const node = nodes.find((n) => n.docId === docId)
  const [saved, setSaved] = useState(true)
  // 初始状态取本地偏好「启动时打开大纲」；此后用户在大纲上点图钉会覆盖它。
  // 这里用函数式初始化而不是 useEffect 补一次：否则首帧会先按 pinned 渲染，
  // 再跳成隐藏 —— 大纲闪一下，读者会以为是自己点错了。
  const [outlineMode, setOutlineMode] = useState<OutlineMode>(
    () => (getPrefs().outlineOnOpen ? 'pinned' : 'hidden'),
  )
  const [shareOpen, setShareOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [commentOpen, setCommentOpen] = useState(false)
  const [readOnly, setReadOnly] = useState(false)
  /**
   * 页面尺寸：标准页宽 / 超宽模式。
   *
   * 语雀是**知识库级 + 单篇级**两层：知识库在「更多设置」里定默认，
   * 单篇文档可以自己再切（快捷键 p）。这里把知识库级接上，
   * 键 `docId` 是为了让换文档时重新取该库的默认值 ——
   * 在同一个库里连着开不同文档时，就不用每次手动切回去。
   *
   * ⚠️ 别改成 useEffect 补一次：那样首帧会先按 standard 渲染再跳成 wide，
   *    宽表格文档会「闪一下变宽」。
   */
  const [pageWidth, setPageWidth] = useState<'standard' | 'wide'>(
    () => (rawBookSettings?.defaultWidth === 'wide' ? 'wide' : 'standard'),
  )
  const [docSettingsOpen, setDocSettingsOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  /*
   * ⚠️ 点赞以前是**假的**，这里整段换掉了：
   *   const [liked, setLiked] = useState(false)
   *   const [likeCount, setLikeCount] = useState(() => 3 + (Number(docId?.slice(-1)) || 0) * 2)
   * 也就是「有 3~12 个人赞过」这个印象**完全是按 docId 末位算出来的**，
   * 谁都没赞过；而且状态只在内存里，刷新就没、换设备看不见。
   *
   * 现在读的是 `doc.likes`（落库、走同步），和 `notes.likes` 同一个形状。
   * 语雀工作台的「我点赞的」视图靠的就是这份数据。
   */
  const liked = !!doc?.likes?.includes(currentUser?.id || '')
  /**
   * 编辑器当前聚焦的块 —— 粘贴时要在它后面插。
   *
   * ⚠️ 必须和别的 useState 放在一起，绝不能落到 `if (!doc) return` 之后：
   * hook 数量一变就是 React #310，表现是整页白屏，
   * 报错完全指不到真因（看着像「页面崩了」，实际是「多写了个 hook 放错地方」）。
   */
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null)
  const [selPop, setSelPop] = useState<SelectionInfo | null>(null)
  const [cardFullscreen, setCardFullscreen] = useState<'sheet' | null>(null)
  const [selPanel, setSelPanel] = useState(false)
  const { addSelectionComment, addNote, activeSpaceId, toggleDocLike } = useStore()
  /** 点赞人数：来自 `doc.likes`（落库、走同步），不是算出来的 */
  const likeCount = doc?.likes?.length || 0
  // 「引用」面板默认收起：绝大多数文档一条引用都没有
  const [backlinksOpen, setBacklinksOpen] = useState(false)
  const [titleEditing, setTitleEditing] = useState(false)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  /* 窄屏：目录树 → 顶部抽屉，大纲 → 底部抽屉 */
  const isPhone = useMediaQuery(BP.phone)
  const [treeOpen, setTreeOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /**
   * 编辑器的「把焦点放到某个块上」的能力。
   *
   * 插完一张卡片（表格 / 代码 / 提示）之后要补一个收尾空段落并把光标放进去 ——
   * 聚焦是编辑器的内部能力（它有 `focusBlock`），所以由编辑器把函数交出来。
   */
  const editorFocusRef = useRef<((id: string) => void) | null>(null)
  /* 划词评论 / 划词存小记 */
  const { sel, clear: clearSel } = useTextSelection(scrollRef)

  /* ---------------- 实时协作（跨标签页真协同） ---------------- */
  // 一条 BroadcastChannel：正文块 / 光标 / 在场心跳都从这里过（见 @/lib/collaboration）
  useCollaboration(docId, editorRef)
  // 在场名单（心跳驱动，超时自动摘除）
  const peers = useCollabPeers()
  const docPeers = useMemo(() => peers.filter((p) => p.docId === docId), [peers, docId])

  /**
   * 服务端判定的编辑权。
   * 早先前端完全没问过权限，`readOnly` 只是个本地开关 ——
   * 于是只读成员看到的是可编辑页面，打字看着存进去了，
   * 一提交就被服务端拒掉，界面上一点提示都没有。
   *
   * caps 为 null 表示「还没问完」，这时**不锁**：宁可晚一点锁，
   * 也不要因为一次慢查询把人挡在门外。问完之后不能编辑就是明确只读。
   *
   * ⚠️ 这个 hook 必须留在**所有条件 return 之前**。
   * 放在后面会触发 React #310（渲染出的 hook 数量与上一次不一致），
   * 表现是整页白屏而不是「少了个权限判断」—— 报错信息完全指不到真因。
   */
  const docCaps = useDocPerms(docId)
  /** 明确知道没有编辑权 */
  const noEditRight = docCaps !== null && !docCaps.edit
  /**
   * 「确知有编辑权」。`noEditRight` 的反面，**同样 fail closed**：
   * `docCaps` 为 null（权限还没问回来）时判 false ——
   * 这几项都是写操作，宁可晚半秒出现，也不要先给一个会被拒的。
   *
   * 「···」菜单里对 reader / visitor 以前**一个门都没接**（实测菜单盘点）：
   * 锁定文档 / 标记「已发布」/ 文档设置 / 删除文档 / 分享 全是可点的。
   * 点下去本地真的变了、服务端拒 → 顶栏常驻「N 处修改没有保存」而本人修不好，
   * 其中「删除文档」最重：文档从树上消失进了本地回收站，服务端还放着。
   */
  const canEdit = docCaps !== null && docCaps.edit
  /**
   * 「能不能在这篇文档下发言」—— 判的是 **comment**，不是 edit。
   *
   * 服务端对 comments / selectionComments / 两个 replies 实体统一按 `caps.comment` 判
   * （`server/sync.ts` 的 isComment 分支）。reader 的 comment=true、edit=false，
   * 他本来就该能评论、只是不能改正文 —— 拿 edit 顶替会把这一档人一起拒掉。
   *
   * ⚠️ 实测（探针，真服务端，reader 角色）：划词面板里的
   * 「回复」「标记解决」以前**对 reader 和 visitor 一视同仁地开着**，
   * store 照收 → 服务端拒 → 顶栏常驻「N 处修改没有保存」而本人修不好。
   */
  const canComment = docCaps !== null && docCaps.comment
  /**
   * 「存小记」是**空间级**动作（notes 走 `isSpaceLevel`），
   * 判的是空间里的 comment，**不是**这篇文档的 —— 两个 id 空间不能混。
   */
  const spaceCaps = useSpacePerms(activeSpaceId)
  const canNote = spaceCaps !== null && spaceCaps.comment
  /**
   * 权限还没问回来时，**一律按只读处理**（fail closed）。
   *
   * 权限是异步查的，在这之前如果放行编辑，编辑器挂载时那次
   * 「正文归一化」就会把 doc 写回去 —— 只读成员于是产生一次
   * 必然被拒的写入，表现为顶栏常驻「N 处修改没有保存」。
   * 他一个字都没改过。
   *
   * 代价是有编辑权的人会有一瞬间的只读（几十毫秒）。
   * 这个代价远小于「用户以为存了其实没存」。
   */
  const capsUnknown = docCaps === null
  useEffect(() => {
    // 只在**确知**没有编辑权时才提示；权限未知的那一瞬不吵用户
    if (noEditRight) toast('你对这篇文档只有阅读权限，编辑已关闭', 'info')
  }, [noEditRight, toast])
  // 演示模式：默认关。没有第二个标签页时可以用假协作者填画面，
  // 一旦检测到真实协作者就自动让位（开关逻辑在 hook 内部）
  const demo = useDemoMode()
  useDemoCollaborators(docId)
  // 自己的光标不画在自己正文上（store 里存了，渲染时过滤掉）
  const docCursors = useMemo(
    () => cursors.filter((c) => c.docId === docId && c.memberId !== currentUser.id),
    [cursors, docId, currentUser.id],
  )
  // 光标显示开关（看别人编辑时想关掉）
  const [cursorsOn, setCursorsOn] = useState(true)

  const siblings = nodes
    .filter((n) => n.bookId === realBookId && n.parentId === node?.parentId)
    .sort((a, b) => a.order - b.order)
  const idx = siblings.findIndex((n) => n.id === node?.id)
  const prev = idx > 0 ? siblings[idx - 1] : null
  const next = idx < siblings.length - 1 ? siblings[idx + 1] : null

  const docComments = comments[docId!] || []
  // 工具栏块类型跟随当前激活块，初始取第一块
  const [activeType, setActiveType] = useState<Block['type']>('p')
  useEffect(() => {
    // 正文可能还没拉到（轻量启动），此时 blocks 是 undefined
    if (doc?.blocks?.[0]) setActiveType(doc.blocks[0].type)
  }, [docId])
  const faved = docId ? isFavorite('doc', docId) : false
  const author = doc ? getMember(doc.authorId) : undefined
  /** 在场成员：自己 + 心跳未超时的远端成员（用于顶栏头像组） */
  const onlineMembers = useMemo(() => {
    const ids = new Set([currentUser.id, ...docPeers.map((p) => p.memberId)])
    return members.filter((m) => ids.has(m.id))
  }, [members, docPeers, currentUser.id])

  // 保存（防抖）
  const scheduleSave = useCallback(
    (blocks: Block[], opts?: { recordUndo?: boolean }) => {
      if (!docId) return
      /*
       * 撤销栈：记**提交之前**的块数组。
       *
       * 为什么挂在这里而不是各个编辑入口：正文的所有用户编辑
       * （打字 / 回车 / 删块 / 插卡片 / 粘贴 / 改块类型 / 表格单元格）
       * **全都汇到这一个函数**，挂一处就一处不漏；
       * 挂多处则迟早有一个入口忘了挂 —— 而那个入口的表现是「那一步撤不回来」。
       *
       * ⚠️ 旧块要从 **store** 读，不能用闭包里的 `doc.blocks`：
       *    打字是逐字提交的，闭包里的值可能已经落后一个字符。
       */
      if (opts?.recordUndo !== false) {
        const prev = useStore.getState().docs[docId]?.blocks
        if (prev) pushUndo(docId, prev, blocks)
      }
      setSaved(false)
      setDocBlocks(docId, blocks)
      /**
       * 历史版本：自动保存就是最自然的快照时机。
       * 快照去重与条数上限都在 store 的 addDocVersion 里
       * （内容没变不记、只留最近 MAX_DOC_VERSIONS 条 + 总体积上限），
       * 所以这里可以放心地每次保存都调。
       */
      useStore.getState().addDocVersion(docId, '自动保存')
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => setSaved(true), 500)
    },
    [docId, setDocBlocks],
  )

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  /**
   * 历史版本：打开一篇文档先存一版现状。
   * 内容与已有快照一致时 store 会跳过，所以反复打开不会把版本列表灌满。
   *
   * ⚠️ 原来只依赖 `docId`（注释还专门写了「依赖 doc 的话每敲一个字都会重新触发」）——
   *   而**轻量启动下打开文档的那一刻，正文还没到本地**：`d.blocks` 是 undefined。
   *   store 的 `addDocVersion` 对这种情况是**明确拒绝**的
   *   （「正文没加载到本地时不许存版本」，否则会存下一份空快照、回滚出来是空白）。
   *
   * 于是「打开文档先存一版」**从来没有发生过**：
   *   · 打开 → 被守卫挡掉（提示「文档尚未加载」）
   *   · 正文随后异步到达 → **没有任何东西再触发一次**
   *   · 结果：同事打开一篇文档，历史版本是**空的**
   *
   * 而这个功能的全部意义就是「误删误改可随时找回」。
   * 换句话说：**安全网根本没部署上**，而界面上恰恰写着它在。
   *
   * 修法：依赖「正文到没到」这个**布尔**，而不是 doc 对象本身
   *（依赖 doc 每敲一个字都会重跑）。`addDocVersion` 自带指纹去重，
   * 所以正文到达时它只会在真有新内容的情况下存一版。
   */
  /* 抽屉：换文档就收起；Esc 也能收起 */
  useEffect(() => {
    setTreeOpen(false)
    setOutlineOpen(false)
  }, [docId, realBookId])

  useEffect(() => {
    if (!isPhone || (!treeOpen && !outlineOpen)) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setTreeOpen(false)
      setOutlineOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isPhone, treeOpen, outlineOpen])

  /**
   * 窄屏下大纲的「钉住 / 收起」两态被翻译成「抽屉开 / 关」：
   * 图钉按钮 → 关抽屉，工具条入口 → 开抽屉。
   */
  const outlineEffective: OutlineMode = isPhone ? (outlineOpen ? 'pinned' : 'hidden') : outlineMode
  const setOutlineEffective = (m: OutlineMode) =>
    isPhone ? setOutlineOpen(m === 'pinned') : setOutlineMode(m)
  /* 两个抽屉互斥：开一个就关另一个 */
  const openTree = () => { setOutlineOpen(false); setTreeOpen(true) }
  const openOutline = () => { setTreeOpen(false); setOutlineOpen(true) }

  /**
   * 语雀快捷键：
   * ⌘S 手动保存（自动保存之外）· ⌘⇧F 目录 · ⌘⇧O 大纲 · ⌘⇧P 页宽 · ⌘⇧R 阅读模式
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /*
       * 撤销 / 重做（⌘Z / ⌘⇧Z / ⌘Y）。
       *
       * ⚠️ **只在正文编辑器里接管** —— 标题输入框、评论框、设置页那些输入框
       * 里的 ⌘Z 必须还是浏览器原生的（那里没有块数组可撤）。
       * 判据是「事件目标在 .yq-editor 里面」，不是「有没有焦点」。
       */
      if (e.metaKey || e.ctrlKey) {
        const k = e.key.toLowerCase()
        if (k === 'z' || k === 'y') {
          const inEditor = !!(e.target as HTMLElement)?.closest?.('.yq-editor')
          if (!inEditor || !docId) return
          e.preventDefault()
          const cur = useStore.getState().docs[docId]?.blocks || []
          const isRedo = e.shiftKey || k === 'y'
          const back = isRedo ? redoDoc(docId, cur) : undoDoc(docId, cur)
          if (!back) {
            toast(isRedo ? '没有可重做的操作' : '没有可撤销的操作', 'info')
            return
          }
          /* recordUndo: false —— 撤销**自己**不能再进历史栈，
             否则按一次 ⌘Z 会把「刚撤销的那步」又记回去，第二次 ⌘Z 就成了空转。 */
          scheduleSave(back, { recordUndo: false })
          toast(isRedo ? '已重做' : '已撤销', 'info')
          return
        }
      }
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) {
        // ⌘S 手动保存
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
          e.preventDefault()
          if (saveTimer.current) clearTimeout(saveTimer.current)
          setSaved(true)
          if (docId) addDocVersion(docId, '手动保存')
          toast('已手动保存', 'success')
        }
        return
      }
      switch (e.key.toLowerCase()) {
        case 'f': e.preventDefault(); setTreeCollapsed(!treeCollapsed); break
        case 'o': e.preventDefault(); setOutlineMode((m) => (m === 'pinned' ? 'hidden' : 'pinned')); break
        case 'p': e.preventDefault(); setPageWidth((w) => (w === 'standard' ? 'wide' : 'standard')); break
        case 'r': e.preventDefault(); setMode((m) => (m === 'edit' ? 'preview' : 'edit')); break
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [toast, treeCollapsed, docId, addDocVersion, scheduleSave])

  /**
   * 「这个人现在能不能编辑这篇文档」—— 供上面的快照 effect 用。
   *
   * 之所以自己算而不用后面那个 `editorReadOnly`：那个在 `if (!doc) return`
   * 之后才算，引用它就得把 effect 也挪过去，而**那样会撞 hook 数量**（见上）。
   *
   * 三种「不能存」的场合：
   *   · 正文没到（blocks 还没加载）→ 存了也是空快照
   *   · 手动只读 / 阅读模式 → 他本来就打算不动这篇
   *   · **没有编辑权（阅读者 / 访客）** → 存了会被服务端拒，
   *     于是顶栏挂出「1 处修改没有保存」的假告警（他什么都没改）
   *   · 权限还没判定（capsUnknown）→ 等到位，effect 会再跑一次
   */
  const blocksLoaded = Array.isArray(doc?.blocks)
  const noEditRightNow = capsUnknown || noEditRight
  const lockedByOtherNow = !!doc?.lock && doc.lock.memberId !== currentUser.id
  const canEditNow = blocksLoaded && !noEditRightNow && mode !== 'preview' && !readOnly && !lockedByOtherNow

  /**
   * 历史版本：打开一篇文档先存一版现状（**能编辑时**才存）。
   *
   * ⚠️⚠️ **这个 effect 必须留在 `if (!doc || bodyLoading) return` 之前。**
   *   我第一版为了拿到 `editorReadOnly` 把它挪到了那个 return 之后 ——
   *   于是「文档还没到」时这个 hook 不跑、「文档到了」才跑，
   *   **两次渲染的 hook 数量不一样** → React error #310（渲染的 hook 比上次多）
   *   → 整页白屏，`.yq-block` 一个都不出现。
   *   `tsc` 抓不到（它不查调用顺序），build 也过，
   *   是**全量测试**把 18 个套件一起打红才暴露的。
   *
   * 所以这里用 `doc?.` 空值取值自己算一遍「能不能编辑」，
   * 不依赖后面那个只在 doc 就绪后才算的 `editorReadOnly`。
   */
  useEffect(() => {
    if (!docId || !blocksLoaded || !canEditNow) return
    useStore.getState().addDocVersion(docId, '打开文档')
  }, [docId, blocksLoaded, canEditNow])
  if (!doc || bodyLoading) {
    // 加载中和不存在要分开：把「还在拉」说成「已删除」是最糟的一种错
    return (
      <div className="yq-docpage yq-docpage-blank">
        {bodyLoading ? (
          <DocSkeleton title={doc!.title} />
        ) : (
          <Empty icon="🫥" text="文档不存在或已被删除" action={<button className="yq-btn yq-btn-primary yq-btn-md" onClick={() => navigate('/')}>回到工作台</button>} />
        )}
      </div>
    )
  }

  const type = doc.type as DocType
  const meta = DOC_TYPE_META[type] || DOC_TYPE_META.doc

  /* ---------------- 文档锁定（语雀：锁定后别人只能读） ---------------- */
  // 语义：lock.memberId 是锁的持有者。
  // - 持有者自己：照常编辑（不存在「自己把自己锁在外面」）
  // - 别人：只读 + 顶部提示条「XX 锁定了此文档」
  // - 只有持有者能解锁，别人点了只会得到一句提示
  const lock = doc.lock || null
  const lockedByMe = !!lock && lock.memberId === currentUser.id
  const lockedByOther = !!lock && lock.memberId !== currentUser.id
  const lockHolderName = lock ? getMember(lock.memberId)?.name || '某位成员' : ''

  /** 传给编辑器的只读态：本地只读 / 阅读模式 / 被别人锁了 / 权限未知或没有编辑权 */
  const editorReadOnly = readOnly || mode === 'preview' || lockedByOther || noEditRight || capsUnknown

  /**
   * 从编辑器 DOM 反向同步 blocks 到 store。
   * 工具栏的加粗/颜色等富文本命令走的是 document.execCommand，
   * 不会触发 React 的 onInput，所以只能在这里把 innerHTML 捞回来。
   */
  const syncFromDom = () => {
    const root = editorRef.current
    if (!root || !docId) return
    const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-block-id]'))
      .map((el) => {
        const id = el.dataset.blockId!
        const prev = doc.blocks.find((x) => x.id === id)
        if (!prev) return null
        const textEl = el.querySelector<HTMLElement>('.yq-block-text, .yq-code-body')
        /**
         * 卡片 / 图片 / 表格 / 分割线块没有 .yq-block-text 节点，
         * 它们的内容只存在于 block 自身（data / src / text），
         * 这里必须原样返回 prev —— 丢掉的话，用户按一下 Ctrl+B 整张卡片就没了。
         */
        if (!textEl) return prev
        const text = textEl.innerText
        const html = textEl.innerHTML
        /**
         * 没变化的块必须原样返回 prev，不能返回 null。
         * 下面的 filter(Boolean) 会把 null 一并丢掉，
         * 一旦漏掉"没变化的块"，就会拿一个残缺数组覆盖整个文档。
         * 优化点在 setDocBlocks 里的相等判断，不在这里。
         */
        if (prev.text === text && prev.html === html) return prev
        return { ...prev, text, html }
      })
      .filter(Boolean) as Block[]
    if (blocks.length) scheduleSave(blocks)
  }

  /* ---------- 富文本命令 ---------- */
  const onFormat = (cmd: string, value?: string) => {
    if (editorReadOnly) return
    if (cmd === 'fontSize') {
      // execCommand 只支持 1-7，用 insertHTML 拿到真实字号
      const sel = window.getSelection()
      const text = sel?.toString() || ''
      if (!text) return
      document.execCommand('insertHTML', false, `<span style="font-size:${value}">${text}</span>`)
      syncFromDom()
      return
    }
    document.execCommand(cmd, false, value)
    syncFromDom()
  }

  /**
   * 语雀的文档标题就是正文的第一个 H1 块，两者是同一份数据 ——
   * 所以编辑首块 H1 时 title 要跟着变，右侧目录/面包屑/搜索才会更新。
   *
   * 这个派生**已经收进 store 的 `setDocBlocks`**（和 `body` 同一个 commit）。
   * 以前它写在这里，于是「同一份数据」有两处实现：
   * 敲一下标题要先 commit 一次、再 commit 一次 title ——
   * 而**回滚和导入那两条路径走不到这里**，于是它们能造成
   * 「目录树里一个标题、正文第一行另一个标题」，且没有任何报错。
   *
   * 留在这里的这份曾经是三份实现里最容易漏的一份：任何**绕过编辑器**
   * 直接改 blocks 的路径（协作合并、导入、模板）都不会经过它。
   */
  const handleBlockChange = (blocks: Block[]) => {
    scheduleSave(blocks)
  }

  /**
   * 粘贴：在**当前聚焦块之后**插入这一批块。
   *
   * 语雀的招牌交互：从别处复制一段 Markdown 源码粘进来，
   * 自动变成标题 / 列表 / 待办 / 代码 / 表格 / 图片。
   *
   * 之前这里把多行粘贴写成「第一行插进当前块、其余丢掉」（循环里有个 break），
   * 粘 5 行只剩 1 行 —— 既是数据丢失，也丢掉了这个交互。
   */
  const handlePasteBlocks = (incoming: Block[]) => {
    if (!incoming.length) return
    // 在**当前聚焦块之后**插入；没有聚焦块就追加到末尾
    const cur = doc.blocks
    const at = cur.findIndex((b) => b.id === activeBlockId)
    const head = at >= 0 ? cur.slice(0, at + 1) : cur
    const tail = at >= 0 ? cur.slice(at + 1) : []
    scheduleSave([...head, ...incoming, ...tail])
    /*
     * 「已粘贴并转换为 N 个块」——这个「转换」只对 Markdown 粘贴成立。
     * 同一个入口还被**多行纯文本**和**剪贴板图片**（2026-10-18 补）用着，
     * 那两条路径根本没有「转换」这回事，说「转换」就是在讲一件没发生的事。
     */
    toast(`已粘贴 ${incoming.length} 个块`, 'success')
  }

  /** 插卡片：cardId 来自统一卡片目录，格式类已在编辑器内处理，这里只管独立卡片 */
  const handleInsertCard = (cardId: string) => {
    const card = YUQUE_CARDS.find((c) => c.id === cardId)
    if (!card) return

    // 有对应块类型的卡片：插成一个新块
    if (card.blockType) {
      const nb: Block = {
        id: `bk_${Date.now().toString(36)}`,
        type: card.blockType,
        text: cardId === 'code' ? '// 在这里输入代码' : cardId === 'callout' ? '在这里输入提示内容' : '',
        ...(cardId === 'code' ? { lang: 'javascript' } : {}),
        ...(cardId === 'callout' ? { emoji: '💡' } : {}),
      }
      /**
       * ⚠️ 必须从 **store 读当前**的块，不能用闭包里的 `doc.blocks`。
       *   实测（部署端逐项量）：从斜杠菜单插「表格」之后，前一段落里
       *   **残留着触发词 `/表格`** —— 紧接着打什么字都接在它后面。
       *
       *   成因：Editor 的 onPick 是 `flushSync(清掉 "/")` 之后**同一个 tick 内**
       *   调 `onInsertCard`，而这里这个函数是上一次渲染的闭包，手里拿的是
       *   **清空之前**那份 `doc.blocks`；`setDocBlocks([...doc.blocks, nb])`
       *   于是把清空结果整个盖回去。界面上没有任何报错，只是那两个字赖着不走。
       *
       *   这是本项目第三次为「两次写同一处、后者拿着旧快照」栽跟头
       *   （分割线那次同源）。从 store 读就跟调用时机无关了。
       */
      const cur = useStore.getState().docs[docId!]?.blocks ?? doc.blocks
      /*
       * 末块接不了普通光标（表格 / 代码 / 提示都是卡片形态）→
       * 补一个空段落在它下面，并把光标放进去。
       * 不补的话：插完卡片，光标还留在**插卡片之前**那个块里，
       * 用户接着打字，字跑到了卡片**上面**（和粘贴图片是同一类问题）。
       */
      const tailId = `bk_tail${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
      const needsTail = card.blockType !== 'p'
      const blocksOut = needsTail
        ? [...cur, nb, { id: tailId, type: 'p' as Block['type'], text: '' }]
        : [...cur, nb]
      useStore.getState().setDocBlocks(docId!, blocksOut)
      if (needsTail) editorFocusRef.current?.(tailId)
      toast(`已插入${card.name}`, 'success')
      return
    }

    // 需要独立文稿的卡片：画板 / 工作表 / 数据表在语雀里本来就是另一种文稿类型，
    // 插进来就是新建一篇文稿，从左侧目录进去编辑
    const createsDoc: Record<string, DocType> = {
      board: 'board', sheet: 'sheet', datatable: 'table',
    }
    const t = createsDoc[cardId]
    if (t) {
      /*
       * ⚠️ 这里原来是无条件 `toast('已新建X，在左侧目录中查看','info')`，
       * 而 `createDoc` 被拒时返回**空串** —— 被拒时用户会看到一句
       * 「已新建…在左侧目录中查看」，而树上什么都没有。
       * 比「点了没反应」更糟：它先让用户信了。
       *
       * ⚠️ 但要说清楚**可达性**：这条路在**编辑器的插卡片面板**里，
       * 走到这里的人本来就有 edit 权限，所以读者点不到它 ——
       * 与 `TopBar` 的新建弹窗、`BookSettings` 文档管理那两个**真的够得着**
       * 的入口不是一回事（那两个是活缺陷，这里是纵深防御）。
       *
       * 走 `createDocOrExplain`：被拒时它弹说明，成功了才说成功。
       */
      const nid = useStore.getState().createDocOrExplain(realBookId!, node?.parentId ?? null, `新建${DOC_TYPE_META[t].label}`, t)
      if (!nid) return
      toast(`已新建${DOC_TYPE_META[t].label}，在左侧目录中查看`, 'info')
      return
    }

    /**
     * 其余特色卡片：插成一个 type: 'card' 的块。
     * 卡片的结构化数据全在 data 上，编辑器按 data.cardId 找组件渲染
     * （src/components/cards/index.tsx 的 CARD_REGISTRY）。
     * 这样附件 / 投票 / 思维导图这些卡片的内容会跟着文档一起存进 localStorage，
     * 刷新后还在 —— 而不是弹一句「演示」就没了。
     */
    const nb: Block = {
      id: `bk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type: 'card',
      text: '',
      data: { cardId },
    }
    /**
     * 必须从 store 现取 blocks，不能用这个闭包里的 doc.blocks。
     * 斜杠菜单选中卡片时，编辑器刚把触发用的 "/" 从块里清掉，
     * 而本函数是那次渲染之前创建的闭包 —— 拿旧数组回写，
     * "/xxx" 就会又出现在正文里（截图里能直接看到）。
     */
    const cur = useStore.getState().docs[docId!]?.blocks ?? doc.blocks
    // 插在最后一个非卡片块之后，避免连续插卡片时被塞到文末看不到
    const at = [...cur].reverse().findIndex((b) => b.type !== 'card')
    const idx = at === -1 ? cur.length : cur.length - 1 - at
    const next = [...cur]
    next.splice(idx, 0, nb)
    useStore.getState().setDocBlocks(docId!, next)
    toast(`已插入${card.name}卡片`, 'success')
  }

  /**
   * 改标题只需 `updateDoc` —— 它已经把目录节点一并改了（见 store 里
   * `updateDoc` 那段注释：改标题必须两边同步，否则目录树显示旧名字）。
   *
   * 以前这里**额外**调了一次 `renameNode`，那是「同一份概念改两遍」：
   * 两次 commit = 两条同步记录，白跑一轮差分，而且只要有人改了
   * `updateDoc` 就得多记住一处补刀 —— 第三条路径（文档设置）就是这么漏的。
   */
  const handleTitle = (t: string) => {
    updateDoc(docId!, { title: t })
  }

  return (
    <div
      className={`yq-docpage ${pageWidth === 'wide' ? 'is-wide' : ''} ${cardFullscreen ? 'is-cardfs' : ''}`}
      style={{ ['--yq-doc-font' as any]: `${editorFontPx}px` }}
    >
      {/*
        打印页眉：屏幕上**不显示**，只在 @media print 里出现（见 print.css）。
        为什么要有它：屏幕上作者和更新时间在顶栏那一行，
        而顶栏在打印时是要退场的 —— 于是纸面上只剩一坨正文，
        传阅出去之后没人知道这是谁写的、什么时候写的。
      */}
      <div className="yq-print-header" aria-hidden="true">
        <div className="yq-print-header-title">{doc.title}</div>
        <div className="yq-print-header-meta">
          <span>{book?.name || ''}</span>
          <span>{(author?.name || '未知') + ' 更新于 ' + new Date(doc.updatedAt).toLocaleDateString('zh-CN')}</span>
          {doc.summary ? <span>{doc.summary}</span> : null}
        </div>
      </div>

      {watermarkOn && (
        <div className="yq-doc-watermark" aria-hidden="true" data-testid="doc-watermark">
          {Array.from({ length: 12 }, (_, i) => (
            <span key={i} className="yq-doc-watermark-item">
              {watermarkText} · {currentUser.name}（{currentUser.account}）
            </span>
          ))}
        </div>
      )}
      {/* 卡片全屏：语雀「进入卡片的独立编辑界面后，整个正文输入会变成纯卡片操作」
          —— 目录 / 菜单栏 / 工具栏 / 大纲全部退场，卡片独占编辑区 */}
      {!cardFullscreen && (
        <DocTree
          bookId={realBookId!}
          activeDocId={docId}
          /* 折叠状态接上 store —— 原来 `⌘⇧F` 只翻转了 store 的值而界面不动，
             因为折叠由 Tree 内部的局部 state 决定（同一个病：toggleOutline）。 */
          collapsed={treeCollapsed}
          onCollapsedChange={setTreeCollapsed}
          drawer={isPhone}
          open={treeOpen}
        />
      )}

      {/* 中：主区 */}
      <div className="yq-doc-main">
        {/* 窄屏专属：目录 / 大纲的抽屉开关。宽屏这两个面板常驻，不需要入口 */}
        {!cardFullscreen && (
          <div className="yq-doc-mobilebar">
            <button
              className={`yq-doc-mbtn ${treeOpen ? 'is-on' : ''}`}
              onClick={() => (treeOpen ? setTreeOpen(false) : openTree())}
              aria-expanded={treeOpen}
            >
              ☰ 目录
            </button>
            <button
              className={`yq-doc-mbtn ${outlineOpen ? 'is-on' : ''}`}
              onClick={() => (outlineOpen ? setOutlineOpen(false) : openOutline())}
              aria-expanded={outlineOpen}
            >
              ☰ 大纲
            </button>
            <span className="yq-doc-mbtn-spacer" />
            <button className="yq-doc-mbtn" onClick={() => setShareOpen(true)}>分享</button>
            <button className="yq-doc-mbtn" onClick={() => setCommentOpen((v) => !v)}>
              评论{docComments.length > 0 ? ` ${docComments.length}` : ''}
            </button>
          </div>
        )}

        {/* 抽屉遮罩：一个遮罩同时罩住目录抽屉和大纲抽屉 */}
        {!cardFullscreen && isPhone && (treeOpen || outlineOpen) && (
          <button
            className="yq-doc-drawermask"
            aria-label="关闭抽屉"
            onClick={() => { setTreeOpen(false); setOutlineOpen(false) }}
          />
        )}
        {/**
         * 菜单栏 —— 语雀的编辑器是「菜单栏 / 工具栏 / 正文」三层结构。
         * 左侧是新建与跳转入口，右侧是针对这篇文档的操作。
         */}
        {!cardFullscreen && (
        <header className="yq-doc-bar">
          <div className="yq-doc-bar-left">
            <Dropdown
              align="left"
              width={210}
              trigger={(open, toggle) => (
                <button className="yq-doc-new" onClick={toggle} title="新建">
                  <svg viewBox="0 0 14 14" width="11" height="11">
                    <path d="M7 1.5v11M1.5 7h11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                  <span className="yq-doc-new-caret">▾</span>
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuLabel>新建</MenuLabel>
                  {(['doc', 'sheet', 'board', 'table'] as DocType[]).map((t) => (
                    <MenuItem
                      key={t}
                      icon={DOC_TYPE_META[t].icon}
                      onClick={() => {
                        const nid = useStore.getState().createDoc(realBookId!, node?.parentId ?? null, '未命名', t)
                        if (nid) navigate(`/book/${realBookId}/doc/${nid}`)
                        close()
                      }}
                    >
                      新建{DOC_TYPE_META[t].label}
                    </MenuItem>
                  ))}
                  <MenuDivider />
                  <MenuItem icon="📚" onClick={() => { navigate(`/space/${book?.spaceId}`); close() }}>
                    回到知识库
                  </MenuItem>
                </>
              )}
            </Dropdown>

            <span className="yq-doc-bar-type" title={meta.label}>{meta.icon}</span>
            <span className="yq-doc-bar-title yq-ellipsis">{doc.title}</span>
            {doc.visibility === 'private' && (
              <Tooltip title="仅自己可见"><span className="yq-doc-bar-lock">🔒</span></Tooltip>
            )}
          </div>

          <div className="yq-doc-bar-right">
            {/* 头像组 = 真实在场的人（自己 + 心跳中的远端成员） */}
            <MemberAvatars users={onlineMembers} />

            <Tooltip title="阅读模式">
              <button
                className={`yq-doc-act ${mode === 'preview' ? 'is-active' : ''}`}
                onClick={() => setMode(mode === 'edit' ? 'preview' : 'edit')}
              >
                👁
              </button>
            </Tooltip>


            <Tooltip title={liked ? '取消点赞' : '点赞'}>
              <button className={`yq-doc-like ${liked ? 'is-liked' : ''}`} onClick={() => toggleDocLike(doc.id)}>
                👍 {likeCount}
              </button>
            </Tooltip>

            <Tooltip title="划词评论：选中正文文字即可发表">
              <button
                className={`yq-doc-act ${selPanel ? 'is-active' : ''}`}
                onClick={() => setSelPanel((v) => !v)}
              >
                ✎
              </button>
            </Tooltip>

            <button className="yq-doc-comment-btn" onClick={() => setCommentOpen((v) => !v)}>
              评论
              {docComments.length > 0 && <span className="yq-doc-comment-count">{docComments.length}</span>}
            </button>

            <button
              className={`yq-doc-share ${faved ? 'is-faved' : ''}`}
              onClick={() => { toggleFavorite('doc', docId!, doc.title); toast(faved ? '已取消收藏' : '已收藏', 'success') }}
            >
              {faved ? '★ 已收藏' : '☆ 收藏'}
            </button>

            <button className="yq-doc-share yq-doc-share-primary" onClick={() => setShareOpen(true)}>
              分享
            </button>

            <Dropdown
              align="right"
              width={250}
              trigger={(open, toggle) => (
                <button className="yq-doc-act yq-doc-more" onClick={toggle}>···</button>
              )}
            >
              {(close) => (
                <div onClick={(e) => e.stopPropagation()}>
                  {/* 窄屏专属：这几项在桌面端是内联按钮，窄屏被收走了，所以在这里补入口 */}
                  <div className="yq-doc-bar-move">
                    <MenuLabel>操作</MenuLabel>
                    <MenuItem
                      icon={mode === 'preview' ? '✎' : '👁'}
                      onClick={() => { setMode(mode === 'edit' ? 'preview' : 'edit'); close() }}
                    >
                      {mode === 'preview' ? '退出阅读模式' : '阅读模式'}
                    </MenuItem>
                    <MenuItem
                      icon="👍"
                      onClick={() => { toggleDocLike(doc.id); close() }}
                    >
                      {liked ? '取消点赞' : '点赞'}（{likeCount}）
                    </MenuItem>
                    <MenuItem icon="✎" onClick={() => { setSelPanel((v) => !v); close() }}>
                      划词评论
                    </MenuItem>
                    <MenuItem icon="💬" onClick={() => { setCommentOpen((v) => !v); close() }}>
                      评论{docComments.length > 0 ? ` (${docComments.length})` : ''}
                    </MenuItem>
                    <MenuItem
                      icon={faved ? '★' : '☆'}
                      onClick={() => {
                        toggleFavorite('doc', docId!, doc.title)
                        toast(faved ? '已取消收藏' : '已收藏', 'success')
                        close()
                      }}
                    >
                      {faved ? '取消收藏' : '收藏'}
                    </MenuItem>
                    <MenuItem icon="↗" onClick={() => { setShareOpen(true); close() }}>
                      分享
                    </MenuItem>
                  </div>


                  {/*
                     桌面段：以下这些在窄屏是收进上面那个菜单的，
                     在桌面端**没有别的地方能点**，所以必须一直显示。
                     以前它们被包在 .yq-doc-bar-move 里（那个 class 桌面端 display:none），
                     于是桌面端点「···」是个空菜单。
                  */}
                  <MenuDivider />

                  <MenuItem icon="📐" disabled={!canEdit} onClick={() => { setDocSettingsOpen(true); close() }}>
                    文档设置
                  </MenuItem>
                  <MenuDivider />
                  <MenuLabel>页面尺寸</MenuLabel>
                  {(['standard', 'wide'] as const).map((w) => (
                    <MenuItem
                      key={w}
                      icon={pageWidth === w ? '●' : '○'}
                      trailing={pageWidth === w ? '当前' : undefined}
                      onClick={() => { setPageWidth(w); close() }}
                    >
                      {w === 'standard' ? '标准页宽' : '超宽模式'}
                    </MenuItem>
                  ))}
                  <MenuDivider />
                  <MenuItem icon="🕘" onClick={() => { setHistoryOpen(true); close() }}>历史版本</MenuItem>
                  <MenuItem
                    icon={lock ? '🔓' : '🔒'}
                    // 没编辑权就锁不了：锁推的是 docs.lock，服务端按 edit 判，
                    // 而它挡的是**别人**的编辑，所以比别的写操作更不该给假按钮。
                    disabled={!canEdit || (!!lock && !lockedByMe)}
                    onClick={() => {
                      if (lock) {
                        if (!lockedByMe) return
                        unlockDoc(docId!)
                        toast('已解锁，其他成员可以继续编辑了', 'success')
                      } else if (lockDoc(docId!)) {
                        toast('已锁定文档，其他成员只能阅读', 'success')
                      }
                      close()
                    }}
                  >
                    {lock
                      ? lockedByMe
                        ? '解锁文档'
                        : `已锁定 · ${lockHolderName} 正在编辑`
                      : '锁定文档'}
                  </MenuItem>
                  <MenuItem
                    icon="📦"
                    disabled={noEditRight || !moveTargets.length}
                    onClick={() => { setMoveMode('move'); setMoveOpen(true); close() }}
                  >
                    移动 / 复制到…
                  </MenuItem>
                  <MenuItem icon="🔗" onClick={() => {
                    /*
                     * 原来这里写的是 `navigator.clipboard?.writeText(url); toast('链接已复制','success')` ——
                     * 那个 `?.` 在**内网 HTTP**（非安全上下文，实测 `typeof navigator.clipboard === 'undefined'`）
                     * 下让整句变成空操作，于是弹了一个**绿色的「链接已复制」而剪贴板里什么都没有**。
                     * 降级成功也要说清楚，别让人以为链接已经发出去了。
                     */
                    void copyText(location.href).then((r) =>
                      toast(r.ok ? '链接已复制' : `复制失败：${r.message}`, r.ok ? 'success' : 'error'))
                    close()
                  }}>
                    复制链接
                  </MenuItem>
                  {/*
                   * 四个导出入口都过 `withCardNotices`：文档里有互动卡片时，
                   * 卡片内容不会进导出（卡片没有对应的 markdown 语法），
                   * 所以在**产物末尾**补一段说明。
                   *
                   * 为什么不在 `blocksToMarkdown` 里就写进去：`doc.body` 还有
                   * 分享页（PublicDoc 渲染的就是 body）与发现页摘要两个消费方，
                   * 在那两处说「不随 Markdown 导出」是错的 —— 三个消费方里有两个
                   * 会被这句话带偏。说明要待在它说得出口的那一步。
                   */}
                  <MenuItem icon="📄" onClick={() => { downloadDoc(doc.title, withCardNotices(doc.body, doc.blocks)); close() }}>
                    导出 Markdown
                  </MenuItem>
                  <MenuItem icon="📘" onClick={() => { downloadDocAs(doc.title, withCardNotices(doc.body, doc.blocks), 'docx'); close() }}>
                    导出 Word（.docx）
                  </MenuItem>
                  <MenuItem icon="🌐" onClick={() => { downloadDocAs(doc.title, withCardNotices(doc.body, doc.blocks), 'html'); close() }}>
                    导出 HTML（自带样式，可直接看/打印）
                  </MenuItem>
                  <MenuItem icon="📝" onClick={() => { downloadDocAs(doc.title, withCardNotices(doc.body, doc.blocks), 'txt'); close() }}>
                    导出纯文本
                  </MenuItem>
                  {/*
                    措辞是「打印 / 另存为 PDF」，**不是「导出 PDF」**。
                    后者会让人以为点下去有个文件落到磁盘上；
                    而实际发生的是：页面被整理成打印版式，然后弹出浏览器的
                    打印对话框，PDF 要在**那里**选「另存为 PDF」。
                    不自己生成 PDF 文件是因为中文字形要内嵌字体子集，
                    而这个项目最看重「内网机器上少一个依赖」。
                  */}
                  <MenuItem icon="🖨" onClick={() => { close(); printDoc(doc) }}>
                    打印 / 另存为 PDF
                  </MenuItem>
                  <MenuDivider />
                  <MenuItem
                    icon={readOnly ? '🔓' : '🔒'}
                    onClick={() => {
                      setReadOnly(!readOnly)
                      toast(
                        readOnly ? '已回到可编辑' : '只读预览：只影响你现在的这个页面',
                        'info',
                      )
                      close()
                    }}
                  >
                    {readOnly ? '退出只读预览' : '只读预览'}
                  </MenuItem>
                  {/*
                    「发布到互联网」这个说法是**错的**，而且错在要紧的地方。

                    它做的唯一一件事是 `published: true`，而这个字段在界面上
                    只驱动三处「已发布」标签（DocPage 两处、发现页一处）。
                    没有任何「互联网发布」这回事 —— 本项目是内网部署，
                    要不要对公网开放是**知识库级**的「互联网上获得链接的人可阅读」
                    开关，在「知识库设置 → 权限」里配，和这里这个标记毫无关系。

                    而「已发布到互联网」这句 toast 会让管理员以为
                    「这篇东西现在任何拿到链接的人都能看了」。
                  */}
                  <MenuItem icon="🏷" disabled={!canEdit} onClick={() => { updateDoc(docId!, { published: !doc.published }); toast(doc.published ? '已取消「已发布」标记' : '已标记为「已发布」（团队内可见的标签）', 'success'); close() }}>
                    {doc.published ? '取消「已发布」标记' : '标记为「已发布」'}
                  </MenuItem>
                  <MenuDivider />
                  <MenuItem
                    icon="🗑"
                    danger
                    disabled={!canEdit}
                    onClick={() => {
                      if (confirm(`确定删除《${doc.title}》？可从回收站找回。`)) {
                        deleteDoc(docId!)
                        toast('已移入回收站', 'info')
                        navigate(`/book/${realBookId}`)
                      }
                      close()
                    }}
                  >
                    删除文档
                  </MenuItem>

                  {/* 语雀：双向引用在「...」面板里，统计信息之上 */}
                  <MenuDivider />
                  <MenuItem
                    icon="🔗"
                    onClick={() => setBacklinksOpen((v) => !v)}
                  >
                    {backlinksOpen ? '收起引用' : '查看引用'}
                  </MenuItem>
                  {backlinksOpen && <DocBacklinks docId={doc.id} />}

                  {/* 语雀：统计信息固定在「...」面板最下方 */}
                  <DocStats doc={doc} authorName={author?.name || '未知'} />
                </div>
              )}
            </Dropdown>
          </div>
        </header>
        )}

        {/* 文档锁定提示条：被锁的人看到「XX 锁定了此文档」，自己锁的人看到自己持锁 */}
        {lock && (
          <DocLockBar
            holderName={lockHolderName}
            byMe={lockedByMe}
            at={lock.at}
            onUnlock={() => {
              unlockDoc(docId!)
              toast('已解锁，其他成员可以继续编辑了', 'success')
            }}
          />
        )}

        {/* 协作条：右上角入口，展示在场成员并可一键关掉协作光标。
            表格类文稿（工作表 / 数据表 / 画板）也要有：
            它们的并发合并发生在 doc.sheetData 上，提示得有个地方落。 */}
        <CollabBar
          docId={docId!}
          scrollRef={scrollRef}
          cursors={docCursors}
          peers={docPeers}
          docTitle={doc.title}
          blocks={doc.blocks}
          showCursors={cursorsOn}
          onToggleCursors={setCursorsOn}
          demo={demo}
        />

        {/**
       * 划词浮层：选中文字后出现「评论 / 存小记 / 复制」工具条。
       * 这里必须把选区【快照】存进 state：弹窗的 textarea 自动聚焦会改变选区，
       * 触发 selectionchange 把实时 sel 置空，若直接依赖 sel，弹窗会刚出现就消失。
       *
       * ⚠️ 渲染条件以前是 `!editorReadOnly`，而它含 `noEditRight`（= !caps.edit）——
       * 于是 **reader 连工具条都出不来**：服务端明明判给他 `comment: true`、
       * 允许发划词评论，界面上却没有任何入口。这是「功能没了」而不是「假动作」，
       * 一样是假的，只是方向相反 —— 而且管理员只会以为「这功能还没做」。
       * 同一个条件还把「复制」一起藏了，而复制根本不需要任何权限。
       *
       * 所以：选中就有工具条，具体哪个按钮按**各自**的判据显隐
       * （评论看文档的 comment，小记看空间的 comment，复制无条件）。
       */}
      {sel && !selPop && !selPanel && (
        <SelectionToolbar
          sel={sel}
          canComment={canComment}
          canNote={canNote}
          onComment={() => setSelPop(sel)}
          onSaveNote={() => {
            /*
             * ⚠️ 这里原来是无条件 `addNote(...)` + `toast('已保存到小记','success')`。
             * 没有空间发言权时 store 默默拒掉 —— 而界面报的是「已保存」，
             * 划词选中的那段话**当场消失**（`clearSel` 照样执行）。
             * 用户会以为存成了，去小记里找又找不到。
             *
             * 现在只在真存进去时才报成功、才清选区；被拒就说清楚，并保留选区。
             */
            const note = `「${doc.title}」中摘录：${sel.text}`
            if (!useStore.getState().addNote(activeSpaceId, note)) {
              toast('在这个空间里没有发言权限，摘录没有存进小记（内容已保留）', 'error')
              return
            }
            toast('已保存到小记', 'success')
            clearSel()
          }}
          onCancel={clearSel}
        />
      )}

      {selPop && (
        <SelectionCommentPop
          sel={selPop}
          onClose={() => { setSelPop(null); clearSel() }}
          onSubmit={(t) => {
            addSelectionComment(docId!, selPop.text, selPop.blockId, t)
            toast('评论已发表', 'success')
            setSelPop(null)
            setSelPanel(true)
            clearSel()
          }}
        />
      )}

      {/* 工具栏 */}
        {type === 'doc' && (
          <Toolbar
            onFormat={onFormat}
            onBlockType={(t) => {
              if (doc.blocks.length) {
                useStore.getState().setDocBlocks(docId!, doc.blocks.map((b, i) => (i === 0 ? { ...b, type: t } : b)))
              }
            }}
            activeBlockType={activeType}
            onInsert={handleInsertCard}
            onSave={() => {}}
            saved={saved}
            readOnly={editorReadOnly}
            currentDocId={docId}
          />
        )}

        {/* 正文滚动区 */}
        <div className="yq-doc-scroll" ref={scrollRef}>
          <div className="yq-doc-content">
            {!cardFullscreen && <>
            {/**
             * 标题不在这里单独渲染 —— 语雀的文档标题就是正文的第一个 H1 块，
             * 元信息（作者 / 更新时间 / 字数）紧跟在该块之后。
             * 只有非文档型文稿（表格 / 画板 / 数据表）没有块结构，才需要独立标题区。
             */}
            {type !== 'doc' && (
              <div className="yq-doc-title-row">
                <span className="yq-doc-type-icon" title={meta.label}>{meta.icon}</span>
                {titleEditing ? (
                  <input
                    className="yq-doc-title-input"
                    defaultValue={doc.title}
                    autoFocus
                    onBlur={(e) => { handleTitle(e.target.value.trim() || '未命名'); setTitleEditing(false) }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                      if (e.key === 'Escape') setTitleEditing(false)
                    }}
                  />
                ) : (
                  <h1 className="yq-doc-title" onClick={() => !editorReadOnly && setTitleEditing(true)} title="点击重命名">
                    {doc.title}
                  </h1>
                )}
              </div>
            )}

            {/* 元信息（文档型：插在标题块之后；其他：跟在标题区后） */}
            {type !== 'doc' && !cardFullscreen && (
              <div className="yq-doc-meta">
                <Avatar name={author?.name || '?'} size={20} />
                <span className="yq-doc-meta-name">{author?.name}</span>
                <span className="yq-doc-meta-sep">·</span>
                <span>{timeAgo(doc.updatedAt)}更新</span>
                <span className="yq-doc-meta-sep">·</span>
                <span>{doc.wordCount} 字</span>
                {doc.published && <Tag color="green" size="sm">已发布</Tag>}
                {doc.tags.map((t) => (
                  <Tag key={t} color="primary" size="sm">{t}</Tag>
                ))}
              </div>
            )}
            </>}

            {/* 内容按类型分发 */}
            {type === 'doc' && (
              <div ref={editorRef} className={mode === 'preview' ? 'yq-doc-preview-mode' : ''}>
                <Editor
                  blocks={doc.blocks}
                  onChange={handleBlockChange}
      onPasteBlocks={handlePasteBlocks}
                  readOnly={editorReadOnly}
                  onInsertCard={handleInsertCard}
                  focusRef={editorFocusRef}
                  mentionableDocs={Object.values(docs).slice(0, 8).map((d) => ({ id: d.id, title: d.title }))}
                  afterFirstSlot={
                    <div className="yq-doc-meta yq-doc-meta-inblock">
                      <Avatar name={author?.name || '?'} size={18} />
                      <span className="yq-doc-meta-name">{author?.name}</span>
                      <span className="yq-doc-meta-sep">·</span>
                      <span>{timeAgo(doc.updatedAt)}更新</span>
                      <span className="yq-doc-meta-sep">·</span>
                      <span>{doc.wordCount} 字</span>
                      {doc.published && <Tag color="green" size="sm">已发布</Tag>}
                      {doc.tags.map((t) => (
                        <Tag key={t} color="primary" size="sm">{t}</Tag>
                      ))}
                    </div>
                  }
                  onActiveBlockChange={(id) => {
                    setActiveBlockId(id)
                    if (id) {
                      const b = doc.blocks.find((x) => x.id === id)
                      if (b) setActiveType(b.type)
                    }
                  }}
                  members={members}
                />
              </div>
            )}
            {/* 语雀：编辑态右下角常驻快捷键面板入口 */}
            <div className="yq-doc-corner">
              <button className="yq-doc-corner-btn" onClick={() => setShortcutsOpen(true)} title="快捷键">
                ⌨
              </button>
            </div>

            {/* data-collab-section：合并提示「查看该位置」的落点。
                这层壳只能加在 DocPage —— 文稿视图本身是只读的共享组件。 */}
            {type === 'sheet' && (
              <div data-collab-section="sheets">
                <SheetView
                  doc={doc}
                  readOnly={editorReadOnly}
                  onChange={(b) => scheduleSave([{ id: 'sh', type: 'table', text: b }])}
                  onFullscreenChange={(v) => setCardFullscreen(v ? 'sheet' : null)}
                />
              </div>
            )}
            {type === 'board' && (
              <div data-collab-section="board">
                <BoardView doc={doc} readOnly={editorReadOnly} />
              </div>
            )}
            {type === 'table' && (
              <div data-collab-section="table">
                <TableView doc={doc} readOnly={editorReadOnly} />
              </div>
            )}

            {/* 底部分页导航 */}
            <div className="yq-doc-nav">
              {prev ? (
                <button className="yq-doc-nav-item" onClick={() => navigate(`/book/${realBookId}/doc/${prev.docId}`)}>
                  <span className="yq-doc-nav-dir">← 上一篇</span>
                  <span className="yq-doc-nav-title yq-ellipsis">{prev.title}</span>
                </button>
              ) : <span />}
              {next ? (
                <button className="yq-doc-nav-item is-next" onClick={() => navigate(`/book/${realBookId}/doc/${next.docId}`)}>
                  <span className="yq-doc-nav-dir">下一篇 →</span>
                  <span className="yq-doc-nav-title yq-ellipsis">{next.title}</span>
                </button>
              ) : <span />}
            </div>
          </div>

          {/* 远端协作光标 overlay：绝对定位覆盖在正文之上，
              不修改任何 contentEditable 块的 DOM。关掉开关即整层不渲染。 */}
          {cursorsOn && type === 'doc' && (
            <RemoteCursorLayer cursors={docCursors} scrollRef={scrollRef} editorRef={editorRef} />
          )}
        </div>
      </div>

      {/* 右：大纲（语雀三态：钉住 / 隐藏成 mini 边 / 悬浮展开） */}
      {!cardFullscreen && <Outline
        blocks={doc.blocks}
        scrollRef={scrollRef}
        mode={outlineEffective}
        onModeChange={setOutlineEffective}
        drawer={isPhone}
        open={outlineOpen}
      />}

      {/* 评论抽屉 */}
      {commentOpen && (
        <CommentPanel docId={docId!} canComment={canComment} onClose={() => setCommentOpen(false)} />
      )}
      {selPanel && (
        <SelectionCommentPanel
          docId={docId!}
          canComment={canComment}
          onClose={() => setSelPanel(false)}
          onJump={(blockId) => {
            const el = scrollRef.current?.querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }}
        />
      )}

      {shareOpen && (
        <ShareModal
          doc={doc}
          canEditPerm={doc.authorId === currentUser.id}
          onClose={() => setShareOpen(false)}
          onChange={(p) => updateDoc(docId!, p)}
        />
      )}
      {/*
       * 「移动 / 复制文档」现在住在 `@/components/doc/MoveDocDialog`。
       *
       * 原来这 ~100 行是内联在这里的；2026-10-09 对照官方语雀的目录树
       * 「···」菜单时发现它第二个地方也要用（树节点的「移动…」/「复制…」），
       * 所以抽成组件共用 —— 抄第二遍就是「同一份逻辑两处、必漏一处」，
       * 这轮已经因为这个形状栽过两次。
       */}
      {moveOpen && (
        <MoveDocDialog
          docId={doc.id}
          bookId={realBookId!}
          title={doc.title || '未命名'}
          mode={moveMode}
          onClose={() => setMoveOpen(false)}
        />
      )}
      {shortcutsOpen && <ShortcutPanel open onClose={() => setShortcutsOpen(false)} />}
      {docSettingsOpen && (
        <DocSettingsModal
          doc={doc}
          onClose={() => setDocSettingsOpen(false)}
          onChange={(patch) => updateDoc(docId!, patch)}
        />
      )}
      {historyOpen && (
        <HistoryModal doc={doc} onClose={() => setHistoryOpen(false)} onRestore={(versionId) => {
          // 真恢复：该版本的 blocks / title / body 一起换回去
          // （store 内部会先把恢复前的现状存一版，恢复错了还能再退回来）
          if (!restoreDocVersion(docId!, versionId)) {
            toast('该版本已失效，无法恢复', 'error')
            return
          }
          /*
           * 恢复版本后，撤销栈里那些快照描述的是**另一段正文**了 ——
           * 不清掉的话，按一次 ⌘Z 会把内容退回到恢复之前的样子，
           * 用户看到的是「我明明恢复了这一版，怎么又变回去了」。
           */
          clearUndo(docId!)
          setHistoryOpen(false)
          setSaved(true)
          toast('已恢复该版本', 'success')
        }} />
      )}
    </div>
  )
}

/* ---------------- 辅助组件 ---------------- */

/**
 * 文档锁定提示条（语雀：锁住后别人只能看）。
 * - 别人锁的：「XX 锁定了此文档」+ 只读说明（没有解锁按钮 —— 不是他的锁）
 * - 自己锁的：提示自己持锁，并给一个「解锁」出口
 */
function DocLockBar({
  holderName, byMe, at, onUnlock,
}: {
  holderName: string
  byMe: boolean
  at: number
  onUnlock: () => void
}) {
  return (
    <div className={`yq-doc-lockbar ${byMe ? 'is-mine' : ''}`} data-testid="doc-lockbar">
      <span className="yq-doc-lockbar-icon">🔒</span>
      <span className="yq-doc-lockbar-text">
        {byMe ? (
          <>
            <b>你锁定了此文档</b>，其他人打开时只能阅读（{timeAgo(at)}加锁）
          </>
        ) : (
          <>
            <b>{holderName} 锁定了此文档</b>，当前为只读模式（{timeAgo(at)}加锁）
          </>
        )}
      </span>
      {byMe && (
        <button className="yq-btn yq-btn-default yq-btn-sm yq-doc-lockbar-btn" onClick={onUnlock}>
          解锁
        </button>
      )}
    </div>
  )
}

/**
 * 知识库成员头像组（菜单栏右侧常驻）。
 * 名字从 AvatarGroup 改为 MemberAvatars，避免和 @/components/ui 的
 * AvatarGroup（协作条用的是它）撞名。
 */
function MemberAvatars({ users }: { users: { name: string; avatar: string }[] }) {
  return (
    <div className="yq-doc-members">
      {users.slice(0, 4).map((u, i) => (
        <Tooltip key={i} title={u.name} placement="bottom">
          <Avatar name={u.name} size={22} />
        </Tooltip>
      ))}
    </div>
  )
}

/**
 * 协作条 —— 菜单栏与工具栏之间的一行，右上角入口。
 * 左半边是「N 处并发编辑已自动合并」（有合并时才出现，可展开看详情 / 跳转 / 忽略），
 * 右半边是「N 人正在协作」+ 在场成员头像组；点开看「谁在编辑哪篇文档 / 编辑到哪一句」。
 *
 * 人数是**真实在场人数**，来源是两条路的并集（按成员去重）：
 * - peers：BroadcastChannel 心跳里在线的人（哪怕他光标没动也在线）
 * - cursors：有光标的人（含演示模式灌进来的假协作者）
 * 至少 1 —— 永远有你自己。
 */
function CollabBar({
  docId,
  scrollRef,
  cursors,
  peers,
  docTitle,
  blocks,
  showCursors,
  onToggleCursors,
  demo,
}: {
  docId: string
  scrollRef: React.RefObject<HTMLDivElement>
  cursors: CollabCursor[]
  peers: CollabPeer[]
  docTitle: string
  blocks: Block[]
  showCursors: boolean
  onToggleCursors: (v: boolean) => void
  demo: boolean
}) {
  const { currentUser, getMember, collabConflicts, clearCollabConflicts, toast } = useStore()
  // 只看本文档，新的在前
  const conflicts = useMemo(
    () => collabConflicts.filter((c) => c.docId === docId).sort((a, b) => b.at - a.at),
    [collabConflicts, docId],
  )
  // 每秒 tick 一次：「正在编辑 / 暂时离开」要随时间自己变
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const rows = useMemo(() => {
    const idle = (at: number) => now - at > IDLE_MS
    const quoteOf = (blockId: string) =>
      (blocks.find((b) => b.id === blockId)?.text || '').replace(/\s+/g, ' ').slice(0, 26)
    const list: {
      id: string
      name: string
      color: string
      state: string
      quote: string
      me: boolean
    }[] = [
      { id: '__me__', name: currentUser.name, color: '', state: '正在编辑', quote: '', me: true },
    ]
    const seen = new Set<string>(['__me__'])
    // 心跳在场的人：即使光标暂时撤了也在名单里
    for (const p of peers) {
      if (seen.has(p.memberId)) continue
      seen.add(p.memberId)
      const c = cursors.find((x) => x.memberId === p.memberId)
      list.push({
        id: p.memberId,
        name: getMember(p.memberId)?.name || p.memberId,
        color: c?.color || '',
        state: idle(p.activeAt) ? '暂时离开' : '正在编辑',
        quote: c ? quoteOf(c.blockId) : '',
        me: false,
      })
    }
    // 只有光标没有心跳的（演示模式）：补进来，人数才和画面一致
    for (const c of cursors) {
      if (seen.has(c.memberId)) continue
      seen.add(c.memberId)
      list.push({
        id: c.memberId,
        name: getMember(c.memberId)?.name || c.memberId,
        color: c.color,
        state: idle(c.activeAt) ? '暂时离开' : '正在编辑',
        quote: quoteOf(c.blockId),
        me: false,
      })
    }
    return list
    // getMember 是稳定的 store 方法，不必进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peers, cursors, blocks, now, currentUser.name])

  return (
    <div className={`yq-doc-collabbar ${conflicts.length ? 'has-conflict' : ''}`}>
      <ConflictNotice
        conflicts={conflicts}
        scrollRef={scrollRef}
        onIgnore={() => {
          clearCollabConflicts(docId)
          toast('已忽略这次合并提示', 'info')
        }}
      />
      <Popover
        align="right"
        width={290}
        trigger={(open, toggle) => (
          <button className={`yq-doc-collabbtn ${open ? 'is-open' : ''}`} onClick={toggle} title="查看协作成员">
            <AvatarGroup members={rows.map((r) => r.name)} size={20} max={4} />
            <span className="yq-doc-collab-count">{rows.length} 人正在协作</span>
            <span className="yq-doc-collab-caret">▾</span>
          </button>
        )}
      >
        {() => (
          <div className="yq-collab-panel">
            <div className="yq-menu-label">协作中的成员</div>
            {rows.map((r) => (
              <div key={r.id} className="yq-collab-item">
                <Avatar name={r.name} size={24} />
                <div className="yq-collab-item-main">
                  <div className="yq-collab-item-row">
                    {!r.me && (
                      <i
                        className="yq-collab-dot"
                        style={{ ['--yq-collab-color' as string]: r.color }}
                      />
                    )}
                    <span>{r.name}</span>
                    {r.me && <span className="yq-collab-me">我</span>}
                    <span className="yq-collab-item-state">· {r.state}</span>
                  </div>
                  <div className="yq-collab-item-doc">
                    在 <b>《{docTitle}》</b> 中
                  </div>
                  {r.quote && <div className="yq-collab-item-quote">「{r.quote}」</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Popover>

      <label className="yq-doc-collab-switch">
        <span>显示协作光标</span>
        <Switch checked={showCursors} onChange={onToggleCursors} size="sm" />
      </label>
      {/* 演示模式（默认关）：只有一个标签页时用假协作者填画面，
          检测到真实协作者后会自动让位 */}
      <label className="yq-doc-collab-switch" title="没有第二个标签页时，用模拟协作者演示">
        <span>演示协作者</span>
        <Switch checked={demo} onChange={setDemoMode} size="sm" />
      </label>
    </div>
  )
}

function CommentPanel({ docId, canComment = true, onClose }: { docId: string; canComment?: boolean; onClose: () => void }) {
  const { comments, addComment, addReply, deleteComment, getMember, currentUser, toast } = useStore()
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const list = comments[docId] || []

  const submit = () => {
    if (!text.trim()) return
    if (replyTo) addReply(docId, replyTo, text.trim())
    else addComment(docId, text.trim())
    setText('')
    setReplyTo(null)
  }

  return (
    <aside className="yq-comment">
      <div className="yq-comment-head">
        <span>评论 {list.length > 0 && `(${list.length})`}</span>
        <button onClick={onClose}>✕</button>
      </div>
      <div className="yq-comment-body">
        {list.length === 0 && <Empty icon="💬" text="还没有评论" />}
        {list.map((c) => {
          const a = getMember(c.authorId)
          // 只能删自己的：服务端也会再判一次（deleteComment 之前压根不存在，
          // 评论发出去就撤不回来）。这里只是不让界面给出做不到的按钮。
          // 另外服务端对**删除**也先判 caps.comment，所以两条件缺一不可
          // ——「只能删自己的」不代表「什么人都能删」。
          const canDelete = canComment && c.authorId === currentUser.id
          return (
            <div key={c.id} className="yq-comment-item">
              <Avatar name={a?.name || '?'} size={26} />
              <div className="yq-flex-1" style={{ minWidth: 0 }}>
                <div className="yq-comment-meta">
                  <b>{a?.name}</b>
                  <span>{timeAgo(c.createdAt)}</span>
                  {canDelete && (
                    <button
                      className="yq-comment-del"
                      title="删除这条评论"
                      onClick={() => {
                        if (window.confirm('删除这条评论？它下面的回复也会一起删掉。')) {
                          deleteComment(docId, c.id)
                          toast('已删除评论', 'success')
                        }
                      }}
                    >
                      删除
                    </button>
                  )}
                </div>
                <div className="yq-comment-text">{c.text}</div>
                {canComment && (
                  <button className="yq-comment-reply" onClick={() => setReplyTo(c.id)}>
                    回复
                  </button>
                )}
                {(c.replies || []).length > 0 && (
                  <div className="yq-comment-replies">
                    {(c.replies || []).map((r) => {
                      const ra = getMember(r.authorId)
                      return (
                        <div key={r.id} className="yq-comment-reply-item">
                          <Avatar name={ra?.name || '?'} size={20} />
                          <div style={{ minWidth: 0 }}>
                            <div className="yq-comment-meta">
                              <b>{ra?.name}</b>
                              <span>{timeAgo(r.createdAt)}</span>
                            </div>
                            <div className="yq-comment-text">{r.text}</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="yq-comment-foot">
        {replyTo && (
          <div className="yq-comment-replying">
            正在回复
            <button onClick={() => setReplyTo(null)}>✕</button>
          </div>
        )}
        {/*
        * 输入区。判据是 `caps.comment` —— 服务端对评论/回复统一按它判。
        *
        * ⚠️ 这里以前对所有人开着。visitor（comment=false）能打一行字、点发送 →
        * store 收下、界面立刻出现这条评论 → 服务端才拒 →
        * 顶栏常驻「N 处修改没有保存」，**而他自己修不好**。
        * 给一个做不到的动作，比不给更糟：它先让你信了。
        */}
      {canComment ? (
        <>
          <div className="yq-comment-input-row">
            <Avatar name={currentUser.name} size={26} />
            <textarea
              className="yq-comment-input"
              placeholder="写下你的评论…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
              }}
            />
          </div>
          <div className="yq-comment-actions">
            <span className="yq-comment-hint">⌘ + Enter 发送</span>
            <button className="yq-btn yq-btn-primary yq-btn-sm" onClick={submit} disabled={!text.trim()}>
              发送
            </button>
          </div>
        </>
      ) : (
        <div className="yq-comment-hint" style={{ padding: '10px 12px' }}>
          你在这个知识库没有评论权限，可以看看别人的讨论。
        </div>
      )}
      </div>
    </aside>
  )
}

/**
 * 打印当前文档。
 *
 * 做两件小事，然后交给浏览器：
 *   1. 给 `<html>` 加一个标记类 —— 打印样式据此决定「正常打印」
 *      还是「重置了本地偏好的样子」（比如把字号调小过、勾了「始终打印背景」）。
 *   2. `afterprint` 之后把标记摘掉，否则**这个类会留在页面上**，
 *      用户打印完看一眼屏幕，发现界面变了。
 *
 * 用 `window.print()` 而不是开一个打印页：正文已经在屏幕上，
 * 图片、公式、卡片都是渲染好的，另开一页要重新取一遍数据，
 * 而那正是「另开一页」最容易出错的地方。
 */
export function printDoc(doc: { title: string }) {
  const root = document.documentElement
  root.classList.add('yq-printing')
  const done = () => {
    root.classList.remove('yq-printing')
    window.removeEventListener('afterprint', done)
  }
  window.addEventListener('afterprint', done)
  // 万一浏览器不触发 afterprint（少数内核会），兜底 1 秒后摘掉
  setTimeout(done, 1500)
  window.print()
}

function ShareModal({
  doc, onClose, onChange, canEditPerm = true,
}: {
  doc: any
  onClose: () => void
  onChange: (p: any) => void
  /**
   * 「能不能改这篇的访问权限」—— 判据与服务端 `denyReason` 那一条**逐字一致**：
   * 只有**作者本人**能改 `visibility`（editor 也不行，
   * 否则同事一推，作者自己就再也看不见自己那篇了）。
   *
   * ⚠️ 不接这道门的后果：改 radio → 点「保存权限」→ toast「权限已更新」，
   * 而 store 层已经拒了 —— **一句成功的假话**，比不给按钮更糟。
   * （读的部分不受影响：复制链接任何人都会，那是读。）
   */
  canEditPerm?: boolean
}) {
  const { members, toast } = useStore()
  const [perm, setPerm] = useState(doc.visibility)
  const [link, setLink] = useState('')

  /* ---------- 对外分享设置（真正落库的那部分） ---------- */
  const [share, setShare] = useState<{ hasPassword: boolean; expiresAt: number; expired: boolean; allowDownload: boolean } | null>(null)
  const [pwd, setPwd] = useState('')
  const [days, setDays] = useState('0')
  const [allowDownload, setAllowDownload] = useState(true)
  const [busy, setBusy] = useState(false)

  /**
   * 链接必须指向**本机真实部署地址**。
   *
   * 原来这里是写死的 `https://www.yuque.com/yuque-clone/<id>` ——
   * 一个「复制成功、toast 成功、链接也确实能点」的**假链接**：
   * 复制给外部合作方，对方打开的是语雀官网上的一个不存在的路径。
   * 这比没有链接更糟：没有链接他知道还没做，有了假链接他以为发出去了。
   */
  useEffect(() => {
    setLink(`${location.origin}/#/public/doc/${doc.id}`)
  }, [doc.id])

  useEffect(() => {
    let alive = true
    getDocShare(doc.id)
      .then((r) => {
        if (!alive) return
        setShare(r.share)
        setAllowDownload(r.share.allowDownload)
        const left = r.share.expiresAt ? Math.ceil((r.share.expiresAt - Date.now()) / 86400000) : 0
        setDays(left > 0 ? String(left) : '0')
      })
      .catch(() => { /* 读不到就按默认值显示，别挡住分享权限本身 */ })
    return () => { alive = false }
  }, [doc.id])

  const saveShare = async () => {
    setBusy(true)
    try {
      const r = await setDocShare(doc.id, {
        // 没填密码且原来就没有 → 不动这一项，避免误把别人的密码清掉
        password: pwd ? pwd : (share?.hasPassword ? null : undefined),
        expiresInDays: Number(days) || 0,
        allowDownload,
      })
      setShare(r.share)
      setPwd('')
      toast('分享设置已保存', 'success')
    } catch (e: any) {
      toast(e?.message || '保存失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 这个库开没开「公开访问」—— 决定单篇的「公开」到底有没有用。
   * 必须在界面上说清楚，不然管理员会以为链接发出去了对方就能看。
   *
   * bookSettings 是 store 里**单独一张表**（不是 Book 上的一个字段），
   * 所以这里按 id 取，不能写成 `book.settings`。
   */
  const bookSettings = useStore((s) => (doc.bookId ? s.bookSettings[doc.bookId] : undefined))
  const bookPublic = !!bookSettings?.publicAccess

  return (
    <Modal
      open
      onClose={onClose}
      title="分享文档"
      width={560}
      footer={
        <>
          <Button variant="text" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            disabled={!canEditPerm}
            title={canEditPerm ? undefined : '只有这篇的作者本人能改访问权限'}
            onClick={() => {
              onChange({ visibility: perm })
              toast('权限已更新', 'success')
              onClose()
            }}
          >
            保存权限
          </Button>
        </>
      }
    >
      <div className="yq-share">
        <div className="yq-share-label">访问权限</div>
        <div className="yq-share-opts">
          {[
            { v: 'space', label: '空间成员可查看', desc: '源子科技空间的成员可以阅读这篇文档', off: false },
            { v: 'public', label: '互联网上获得链接的人可查看', desc: '任何拿到链接的人都能阅读，适合对外分享', off: false },
            // 「仅自己可见」以前是个能点、能存、**但不生效**的选项：
            // 服务端判权限只看知识库，不看文档的 visibility，
            // 于是同空间的其他人照样打得开，而作者以为只有自己能看。
            //
            // 2026-10-06 真做了。要接的面比看起来多，最容易漏的是**目录树**：
            // `nodes` 自己带一份**标题副本**，也是同步实体 ——
            // 只过滤 `docs` 的话，别人照样在目录里看见这篇的标题。
            //
            // 已接的面（服务端 `perms.canSeeDocRow` 是唯一判据）：
            //   · `capsOfDoc` → 正文 / 版本 / 正反向链接 / 分享 / 能力面板 /
            //     附件 / v2 详情 / v2 改删 —— **平台 owner 也不豁免**；
            //   · `docs` 与 `nodes` 两个实体的 `visible` 钩子 → bootstrap、
            //     同步拉取、增量、**整包导出**（那条走 readEntity，自动继承）；
            //   · `/api/search` 的 SQL 前置 + JS 兜底；
            //   · `/api/v2` 的 toc 与 docs 列表（那两处直接查 SQL，得单独接）。
            // 写路径也补了：editor 不能把**别人**的文档设成 private
            // （否则同事一推，作者自己就再也看不见自己那篇了）。
            { v: 'private', label: '仅自己可见', desc: '只有你自己能打开这篇 —— 同空间的人也看不到（平台管理员同样看不到）', off: false },
          ].map((o) => (
            <label
              key={o.v}
              className={`yq-share-opt ${perm === o.v ? 'is-active' : ''} ${o.off || !canEditPerm ? 'is-off' : ''}`}
              title={o.off ? '这个选项还不能生效，别指望它保护文档' : undefined}
            >
              <input
                type="radio"
                checked={perm === o.v}
                disabled={o.off || !canEditPerm}
                onChange={() => setPerm(o.v as any)}
              />
              <span className="yq-share-radio" />
              <span className="yq-flex-1">
                <span className="yq-share-opt-label">
                  {o.label}
                  {o.off && <span className="yq-share-badge">未实现</span>}
                </span>
                <span className="yq-share-opt-desc">{o.desc}</span>
              </span>
            </label>
          ))}
        </div>

        {perm === 'public' && !bookPublic && (
          <div className="yq-share-warn">
            这个知识库还没开「公开访问」，<b>现在把链接发给外部的人，对方仍然打不开</b>。
            需要先到「知识库 → 设置 → 权限」里打开。
          </div>
        )}

        {perm === 'public' && (
          <>
            <div className="yq-share-row">
              <span className="yq-share-label" style={{ marginBottom: 0 }}>允许下载 / 导出</span>
              <Switch
                checked={allowDownload}
                onChange={(v) => { setAllowDownload(v); setDocShare(doc.id, { allowDownload: v }).then((r) => setShare(r.share)).catch(() => {}) }}
                size="sm"
              />
            </div>
            <div className="yq-share-hint">
              关闭后，分享页上不提供导出入口。
              <b>它拦不住截图和复制正文</b> —— 文字已经显示在对方屏幕上了。
            </div>

            <div className="yq-share-label">访问密码（可选）</div>
            <div className="yq-share-row">
              <input
                className="yq-input"
                type="password"
                placeholder={share?.hasPassword ? '已设置密码（留空则取消）' : '不填 = 不需要密码'}
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
              />
            </div>
            <div className="yq-share-hint">
              密码只存哈希，管理员也看不到原密码，丢了只能重设。
              连续输错 8 次会锁 10 分钟（防穷举）。
            </div>

            <div className="yq-share-row">
              <span className="yq-share-label" style={{ marginBottom: 0 }}>有效期</span>
              <select className="yq-input" style={{ width: 140 }} value={days} onChange={(e) => setDays(e.target.value)}>
                <option value="0">永不过期</option>
                <option value="7">7 天</option>
                <option value="30">30 天</option>
                <option value="90">90 天</option>
                <option value="365">一年</option>
              </select>
              <Button variant="primary" size="sm" onClick={saveShare} disabled={busy}>
                {busy ? '保存中…' : '保存分享设置'}
              </Button>
            </div>
            {share?.expired && <div className="yq-share-warn">这份分享已经过期了</div>}
          </>
        )}

        <div className="yq-share-label">分享链接</div>
        <div className="yq-share-link">
          <input value={link} readOnly />
          <button
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(link)
                toast('链接已复制到剪贴板', 'success')
              } catch {
                toast(`复制失败，请手动复制：${link}`, 'error')
              }
            }}
          >
            复制
          </button>
        </div>
        {perm === 'public' && (
          <div className="yq-share-hint">
            这是本知识库的地址，发给谁对方就从这里打开。
          </div>
        )}

        <div className="yq-share-label">协作成员</div>
        <div className="yq-share-members">
          {members.map((m) => (
            <div key={m.id} className="yq-share-member">
              <Avatar name={m.name} size={28} />
              <div className="yq-flex-1" style={{ minWidth: 0 }}>
                <div className="yq-share-member-name">{m.name}</div>
                <div className="yq-share-member-account">@{m.account}</div>
              </div>
              <select className="yq-share-member-role" defaultValue={m.role}>
                {m.role === 'owner' && <option value="owner">拥有者</option>}
                <option value="edit">可编辑</option>
                <option value="read">可阅读</option>
              </select>
            </div>
          ))}
          <button
            className="yq-share-invite"
            onClick={async () => {
              /*
               * 原来这里是 toast('邀请链接已生成（演示）')。
               * 那样做比没有更糟：用户以为同事已经收到邀请，
               * 实际上什么都没发生 —— 而且事后无从发现。
               *
               * 现在只做**能真正做到**的那件事：把链接复制到剪贴板。
               * 对方能不能打开取决于他在不在空间里、有没有权限 ——
               * 这句必须说清楚，不能让「复制了链接」被理解成「已授予权限」。
               */
              const url = `${location.origin}/#/book/${doc.bookId}/doc/${doc.id}`
              try {
                await navigator.clipboard.writeText(url)
                toast('链接已复制。对方还需要在空间成员名单里、且对这个库有权限，才能打开。', 'success')
              } catch {
                toast(`复制失败，请手动复制：${url}`, 'error')
              }
            }}
          >
            ＋ 复制链接
          </button>
        </div>
      </div>
    </Modal>
  )
}

/* ============================================================
   历史版本：块级 diff（纯前端，不引 diff 库）
   ------------------------------------------------------------
   两层：
   1) 块级 —— 用 LCS 在「块 id 序列」上求最长公共子序列。
      LCS 里的对 = 同一块（没动 or 改了内容），LCS 之外剩下的
      左边是「删除」、右边是「新增」。
      为什么按 id 而不是按文本：文本一改就对不上，会把一次改字
      显示成「删一段 + 加一段」，diff 就没法看了。
   2) 块内 —— 对同一块 id 的左右文本再做一次 LCS（字符级），
      把「改了哪几个字」标出来。
   复杂度都是 O(n·m)；块数与文本长度都设了上限，
   超了就退化成更粗的粒度（整块替换 / 按行比），不会卡住 UI。
   ============================================================ */

type DiffStatus = 'same' | 'add' | 'del' | 'mod'
/** 块内 diff 的片段：same 未变 / del 只在旧版 / add 只在新版 */
interface TextSeg { type: 'same' | 'add' | 'del'; text: string }
interface DiffRow {
  status: DiffStatus
  left: Block | null
  right: Block | null
  /** 改的是哪一层：类型 / 文本 / 属性（勾选态、图片 src、卡片数据…） */
  kind: 'type' | 'text' | 'attr' | null
  leftSegs: TextSeg[]
  rightSegs: TextSeg[]
}
/** LCS 操作序列；超出规模上限时返回 null（调用方降级） */
interface LcsOp { t: 'same' | 'del' | 'add'; ai: number; bi: number }

const BLOCK_TYPE_LABEL: Record<string, string> = {
  p: '正文', h1: 'H1', h2: 'H2', h3: 'H3', h4: 'H4', ul: '无序', ol: '有序',
  todo: '待办', code: '代码', quote: '引用', divider: '分割线', image: '图片',
  table: '表格', callout: '提示', card: '卡片',
}

/** 块在 diff 界面里的名字：`正文#a1b2` */
const blockLabel = (b: Block | null) => (b ? `${BLOCK_TYPE_LABEL[b.type] || b.type}#${b.id.slice(-4)}` : '（无）')

/**
 * 可比较的块文本。
 * 卡片的 text 恒为空（内容都在 data 里），直接 diff 文本会显示成
 * 「空 → 空，未变」，哪怕附件都换了 —— 所以给卡片造一句人话摘要。
 */
function blockText(b: Block | null | undefined): string {
  if (!b) return ''
  if (b.type === 'card') {
    const d = b.data || {}
    const name = d.name || d.title || d.text || d.cardId || '卡片'
    const size = d.size ? ` · ${d.size}B` : ''
    // 服务端形态下二进制在数据库里，说「IndexedDB」是假的 ——
    // 而这行会被**复制出去**（选区复制、划词评论的引用），所以它也跟着一起骗人。
    // 判据统一用 `binaryWhere()`，别在这儿再抄一遍 getMode/isAuthed。
    const where = d.key ? ` · ${binaryWhere()}` : d.dataUrl ? ' · 内联 data URL' : ''
    return `[卡片 ${d.cardId || '?'}] ${name}${size}${where}`
  }
  if (b.type === 'image') return `[图片] ${b.src || ''}${b.text ? ' ' + b.text : ''}`
  if (b.type === 'divider') return '———'
  return b.text || ''
}

/** 便宜的字符串哈希：给超长的卡片数据做指纹用（避免整段 JSON 反复比较） */
function hashStr(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

/**
 * 块的「内容签名」：决定这一行是「未变」还是「修改」。
 * 比整块 JSON 便宜：只取影响显示的字段，data 超过 4KB 才退化成哈希。
 */
function blockSig(b: Block): string {
  let dataSig = ''
  if (b.data) {
    const s = JSON.stringify(b.data)
    dataSig = s.length > 4096 ? `${s.length}:${hashStr(s)}` : s
  }
  return [
    b.type, b.checked ? '1' : '0', b.assignee || '', b.lang || '', b.emoji || '',
    b.src || '', b.text || '', b.html || '', dataSig,
  ].join('\u0001')
}

/**
 * 最长公共子序列。
 * 返回按顺序排好的操作序列（same/del/add），ai/bi 是各自序列里的下标。
 * maxCells 是规模闸门：n·m 超过它就返回 null，让调用方降级
 * （一千个块的两两比较是一百万个格子，会把弹窗卡住）。
 */
function lcsOps<T>(a: T[], b: T[], eq: (x: T, y: T) => boolean, maxCells: number): LcsOp[] | null {
  const n = a.length
  const m = b.length
  const ops: LcsOp[] = []
  if (n === 0 || m === 0) {
    for (let i = 0; i < n; i++) ops.push({ t: 'del', ai: i, bi: -1 })
    for (let j = 0; j < m; j++) ops.push({ t: 'add', ai: -1, bi: j })
    return ops
  }
  if (n * m > maxCells) return null
  const w = m + 1
  const dp = new Int32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] = eq(a[i], b[j])
        ? dp[(i + 1) * w + j + 1] + 1
        : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (eq(a[i], b[j])) {
      ops.push({ t: 'same', ai: i, bi: j })
      i++
      j++
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ t: 'del', ai: i, bi: -1 })
      i++
    } else {
      ops.push({ t: 'add', ai: -1, bi: j })
      j++
    }
  }
  while (i < n) { ops.push({ t: 'del', ai: i, bi: -1 }); i++ }
  while (j < m) { ops.push({ t: 'add', ai: -1, bi: j }); j++ }
  return ops
}

/** 把 LCS 操作序列折成左右两栏的片段（相邻同类合并） */
function foldSegs(ops: LcsOp[], pick: (op: LcsOp) => string): TextSeg[] {
  const segs: TextSeg[] = []
  for (const op of ops) {
    const text = pick(op)
    if (text === '') continue
    const type = op.t === 'same' ? 'same' : op.t === 'add' ? 'add' : 'del'
    const last = segs[segs.length - 1]
    if (last && last.type === type) last.text += text
    else segs.push({ type, text })
  }
  return segs
}

/**
 * 块内文本 diff，返回左右两栏的片段。
 * 三级降级：字符级 → 按行 → 整块替换（段数太多时按行比才不会爆内存）。
 */
function diffText(a: string, b: string): { left: TextSeg[]; right: TextSeg[] } {
  if (a === b) {
    const s: TextSeg[] = a ? [{ type: 'same', text: a }] : []
    return { left: s, right: s.map((x) => ({ ...x })) }
  }
  // 1) 字符级：中文按字、英文按字符，粒度最细
  // （Array.from 按码点切，emoji 这类增补平面字符才算「一个字符」）
  const ca = Array.from(a)
  const cb = Array.from(b)
  const ops = lcsOps(ca, cb, (x, y) => x === y, 250_000)
  if (ops) {
    return {
      left: foldSegs(ops, (op) => (op.t === 'add' ? '' : ca[op.ai])),
      right: foldSegs(ops, (op) => (op.t === 'del' ? '' : cb[op.bi])),
    }
  }
  // 2) 文本太长 → 按行比
  const la = a.split('\n')
  const lb = b.split('\n')
  const lops = lcsOps(la, lb, (x, y) => x === y, 40_000)
  if (lops) {
    return {
      left: foldSegs(lops, (op) => (op.t === 'add' ? '' : la[op.ai] + '\n')),
      right: foldSegs(lops, (op) => (op.t === 'del' ? '' : lb[op.bi] + '\n')),
    }
  }
  // 3) 还是太大 → 整块替换（别硬算，宁可粗一点也别卡 UI）
  return {
    left: a ? [{ type: 'del', text: a }] : [],
    right: b ? [{ type: 'add', text: b }] : [],
  }
}

/** 一行 diff */
function makeRow(status: DiffStatus, left: Block | null, right: Block | null): DiffRow {
  if (status === 'mod') {
    const kind: DiffRow['kind'] = left!.type !== right!.type
      ? 'type'
      : left!.text !== right!.text || left!.html !== right!.html
        ? 'text'
        : 'attr'
    const segs = diffText(blockText(left), blockText(right))
    return { status, left, right, kind, leftSegs: segs.left, rightSegs: segs.right }
  }
  return { status, left, right, kind: null, leftSegs: [], rightSegs: [] }
}

/** 规模闸门：块数太多时不做 id-LCS，退化成「按 id 配对 + 其余算增删」 */
const DIFF_MAX_CELLS = 250_000

function diffBlocks(left: Block[], right: Block[]): DiffRow[] {
  const ops = lcsOps(left, right, (x, y) => x.id === y.id, DIFF_MAX_CELLS)
  if (ops) {
    return ops.map((op) => {
      if (op.t === 'del') return makeRow('del', left[op.ai], null)
      if (op.t === 'add') return makeRow('add', null, right[op.bi])
      const a = left[op.ai]
      const b = right[op.bi]
      return makeRow(blockSig(a) === blockSig(b) ? 'same' : 'mod', a, b)
    })
  }
  // 兜底：不在 LCS 里的按 id 就近配对，剩下的是纯新增 / 纯删除
  const rows: DiffRow[] = []
  const usedRight = new Set<number>()
  const byId = new Map<string, number>()
  right.forEach((b, i) => { if (b && !byId.has(b.id)) byId.set(b.id, i) })
  const leftOnly: Block[] = []
  left.forEach((a) => {
    const j = a ? byId.get(a.id) : undefined
    if (j === undefined) leftOnly.push(a)
    else {
      usedRight.add(j)
      rows.push(makeRow(blockSig(a) === blockSig(right[j]) ? 'same' : 'mod', a, right[j]))
    }
  })
  leftOnly.forEach((a) => rows.push(makeRow('del', a, null)))
  right.forEach((b, i) => { if (!usedRight.has(i)) rows.push(makeRow('add', null, b)) })
  return rows
}

/** diff 一栏的「版本」：真快照和「当前内容」共用这个形状 */
interface DiffSide {
  id: string
  title: string
  blocks: Block[]
  at: number
  editorName: string
  label: string
}

const DIFF_STATUS_META: Record<DiffStatus, { label: string; mark: string }> = {
  same: { label: '未变', mark: '=' },
  mod: { label: '修改', mark: '~' },
  add: { label: '新增', mark: '+' },
  del: { label: '删除', mark: '−' },
}

/** 一栏的渲染：只显示属于这一栏的片段，被改掉的片段带高亮 */
function DiffCell({ row, side }: { row: DiffRow; side: 'old' | 'new' }) {
  const block = side === 'old' ? row.left : row.right
  // 空侧也要带 data-side：CSS 与测试都靠它区分「新增行的左栏」/「删除行的右栏」
  if (!block) return <div className="yq-diff-cell is-void" data-side={side} />
  const segs = side === 'old' ? row.leftSegs : row.rightSegs
  return (
    <div className="yq-diff-cell" data-side={side}>
      <span className="yq-diff-cell-id">{blockLabel(block)}</span>
      <span className="yq-diff-cell-text">
        {segs.length ? (
          segs.map((s, i) =>
            s.type === 'same'
              ? <span key={i}>{s.text}</span>
              : <mark key={i} className={s.type === 'add' ? 'yq-diff-ins' : 'yq-diff-del'}>{s.text}</mark>,
          )
        ) : (
          <span className="yq-diff-raw">{blockText(block) || '（空块）'}</span>
        )}
      </span>
    </div>
  )
}

/**
 * 历史版本弹窗。
 * - 左侧是真版本列表（store 里存的快照，不是编出来的）
 * - 右侧是块级 diff：选 2 个版本互相比，或选 1 个与当前内容比
 * - 「恢复」真把 blocks / title / body 换回该版本
 */
function HistoryModal({
  doc, onClose, onRestore,
}: {
  doc: any
  onClose: () => void
  onRestore: (versionId: string) => void
}) {
  const { addDocVersion, toast } = useStore()
  const versions: DocVersion[] = doc.versions || []
  const [picked, setPicked] = useState<string[]>([])
  const [onlyDiff, setOnlyDiff] = useState(false)

  const current = useMemo(
    () => ({
      id: '__current__',
      title: doc.title,
      blocks: (doc.blocks || []) as Block[],
      at: doc.updatedAt,
      editorName: '当前内容',
      label: '当前',
    }),
    [doc.title, doc.blocks, doc.updatedAt],
  )

  const pick = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 2 ? [p[1], id] : [...p, id]))

  /** 对比的左右两侧：左边永远是旧的那一侧 */
  const [leftV, rightV] = useMemo<[DiffSide | null, DiffSide | null]>(() => {
    if (picked.length === 2) {
      const two = picked
        .map((id) => versions.find((v) => v.id === id))
        .filter(Boolean) as DocVersion[]
      if (two.length !== 2) return [null, null]
      const [a, b] = [...two].sort((x, y) => x.at - y.at)
      return [a, b]
    }
    if (picked.length === 1) {
      const v = versions.find((x) => x.id === picked[0])
      if (!v) return [null, null]
      return v.at <= current.at ? [v, current] : [current, v]
    }
    return [null, null]
  }, [picked, versions, current])

  const rows = useMemo(
    () => (leftV && rightV ? diffBlocks(leftV.blocks || [], rightV.blocks || []) : []),
    [leftV, rightV],
  )
  const stat = useMemo(() => {
    const s = { add: 0, del: 0, mod: 0, same: 0 }
    for (const r of rows) s[r.status]++
    return s
  }, [rows])
  const shown = onlyDiff ? rows.filter((r) => r.status !== 'same') : rows

  return (
    <Modal open onClose={onClose} title="历史版本" width={900}>
      <div className="yq-history yq-history-compare">
        <div className="yq-history-hint">
          知语会保留每次保存的版本，误删误改可随时找回。选 2 个版本互相比，或选 1 个与当前内容比。
        </div>
        <div className="yq-history-split">
          {/* 左：版本列表 */}
          <div className="yq-history-list">
            {versions.length === 0 && (
              <div className="yq-history-empty">还没有历史版本 —— 编辑正文或点下面的按钮存一版。</div>
            )}
            {versions.map((v, i) => (
              <div
                key={v.id}
                data-version-id={v.id}
                className={`yq-history-item ${i === 0 ? 'is-current' : ''} ${picked.includes(v.id) ? 'is-picked' : ''}`}
              >
                <div className="yq-history-dot">{i === 0 ? '●' : '○'}</div>
                <div className="yq-flex-1" style={{ minWidth: 0 }}>
                  <div className="yq-history-label">
                    <button className="yq-history-pick" onClick={() => pick(v.id)} title="选它来对比">
                      {picked.includes(v.id) ? '☑' : '☐'} {v.label}
                    </button>
                    {i === 0 && <Tag color="green" size="sm">最新</Tag>}
                    {picked.includes(v.id) && <Tag color="primary" size="sm">已选</Tag>}
                  </div>
                  <div className="yq-history-meta">
                    {/* 带上具体时刻：连续几次自动保存 timeAgo 都是「刚刚」，光看相对时间分不清 */}
                    {v.editorName} · {timeAgo(v.at)} {new Date(v.at).toLocaleTimeString('zh-CN', { hour12: false })} · {(v.blocks || []).length} 块
                  </div>
                </div>
                <button
                  className="yq-btn yq-btn-default yq-btn-sm yq-history-restore"
                  onClick={() => onRestore(v.id)}
                  title="把正文恢复到这一版"
                >
                  恢复
                </button>
              </div>
            ))}
            <button
              className="yq-btn yq-btn-default yq-btn-sm yq-history-snapshot"
              onClick={() => {
                const id = addDocVersion(doc.id, '快照')
                toast(id ? '已存一版快照' : '内容与最新版本一致，没重复存', id ? 'success' : 'info')
              }}
            >
              ＋ 立即存一版快照
            </button>
          </div>

          {/* 右：块级 diff 并排 */}
          <div className="yq-history-diff">
            {leftV && rightV ? (
              <>
                <div className="yq-diff-head">
                  <div className="yq-diff-side">
                    <b>{leftV.label}</b>
                    <span className="yq-ellipsis">{leftV.title}</span>
                    <span className="yq-diff-sub">{leftV.editorName} · {timeAgo(leftV.at)}</span>
                  </div>
                  <div className="yq-diff-mid">
                    <label className="yq-diff-only">
                      <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} />
                      只看差异
                    </label>
                    <div className="yq-diff-stat">
                      <span className="is-add">+{stat.add}</span>
                      <span className="is-del">−{stat.del}</span>
                      <span className="is-mod">~{stat.mod}</span>
                    </div>
                  </div>
                  <div className="yq-diff-side is-new">
                    <b>{rightV.label}</b>
                    <span className="yq-ellipsis">{rightV.title}</span>
                    <span className="yq-diff-sub">{rightV.editorName} · {timeAgo(rightV.at)}</span>
                  </div>
                </div>
                <div className="yq-diff-rows">
                  {shown.length === 0 && <div className="yq-history-empty">两个版本没有差异。</div>}
                  {shown.map((r, i) => (
                    <div key={i} className="yq-diff-row" data-status={r.status}>
                      <div className="yq-diff-badge" title={DIFF_STATUS_META[r.status].label}>
                        {DIFF_STATUS_META[r.status].mark}
                      </div>
                      <DiffCell row={r} side="old" />
                      <DiffCell row={r} side="new" />
                    </div>
                  ))}
                </div>
                <div className="yq-diff-legend">
                  <span><mark className="yq-diff-del">旧版文字</mark></span>
                  <span><mark className="yq-diff-ins">新版文字</mark></span>
                  <span>＝ 未变</span>
                  <span>~ 修改</span>
                  <span>＋ 新增</span>
                  <span>－ 删除</span>
                </div>
              </>
            ) : (
              <Empty icon="🔀" text="选两个版本对比，或选一个与当前内容对比" />
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}

/** 语雀：统计信息固定在「...」面板底部 */
function DocStats({ doc, authorName }: { doc: any; authorName: string }) {
  const { members, getMember } = useStore()
  const contributors = members.slice(0, 4)
  const date = (ts: number) =>
    new Date(ts).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })

  return (
    <div className="yq-doc-stats">
      <div className="yq-menu-label">统计信息</div>
      <div className="yq-doc-stats-row">
        <span>字数</span>
        <b>{doc.wordCount.toLocaleString()}</b>
      </div>
      <div className="yq-doc-stats-row">
        <span>创建时间</span>
        <b>{date(doc.createdAt)}</b>
      </div>
      <div className="yq-doc-stats-row">
        <span>创建者</span>
        <b>{authorName}</b>
      </div>
      <div className="yq-doc-stats-row">
        <span>最后编辑</span>
        <b>{date(doc.updatedAt)}</b>
      </div>
      <div className="yq-doc-stats-row yq-doc-stats-contrib">
        <span>贡献者</span>
        <div className="yq-doc-stats-avatars">
          {contributors.map((m: any, i: number) => (
            <Tooltip key={i} title={m.name} placement="top">
              <Avatar name={m.name} size={20} />
            </Tooltip>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 「被引用」与「引用了」—— 语雀的双向引用。
 *
 * 语雀的引用是**双向可见**的：链出去时知道链给了谁，被链到时也知道
 * 被谁链了。只做正向那半边的话，一份规范改了接口，被它引用的那几篇
 * 根本不知道自己该跟着改 —— 这是知识库最容易烂掉的地方。
 *
 * 列表在「...」菜单里按需拉：绝大多数文档一条引用都没有，
 * 每次进文档都白拉一次接口没意义。
 */
function DocBacklinks({ docId }: { docId: string }) {
  const [open, setOpen] = useState(false)
  const [back, setBack] = useState<{ id: string; title: string; bookId: string }[] | null>(null)
  const [out, setOut] = useState<{ id: string; title: string; bookId: string }[] | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!open) return
    let dead = false
    setBack(null); setOut(null)
    Promise.all([fetchBacklinks(docId), fetchOutlinks(docId)]).then(([b, o]) => {
      if (dead) return
      setBack(b); setOut(o)
    })
    return () => { dead = true }
  }, [open, docId])

  if (!open) return null
  const go = (r: { bookId: string; id: string }) => { setOpen(false); navigate(`/book/${r.bookId}/doc/${r.id}`) }

  return (
    <div className="yq-doc-backlinks">
      <div className="yq-menu-label">被引用 · {back === null ? '…' : back.length}</div>
      {!back?.length && <div className="yq-doc-backlinks-empty">还没有别的文档引用这一篇</div>}
      {back?.map((r) => (
        <button key={r.id} className="yq-doc-backlink-item" onClick={() => go(r)}>
          <span className="yq-doc-backlink-title">{r.title || '（无标题）'}</span>
        </button>
      ))}

      <div className="yq-menu-label" style={{ marginTop: 10 }}>引用了 · {out === null ? '…' : out.length}</div>
      {!out?.length && <div className="yq-doc-backlinks-empty">这一篇还没有链到别的文档</div>}
      {out?.map((r) => (
        <button key={r.id} className="yq-doc-backlink-item" onClick={() => go(r)}>
          <span className="yq-doc-backlink-title">{r.title || '（无标题）'}</span>
        </button>
      ))}
    </div>
  )
}

/** 文档设置：标题、路径、摘录、标签、页面宽度 */
function DocSettingsModal({
  doc, onClose, onChange,
}: {
  doc: any
  onClose: () => void
  onChange: (patch: any) => void
}) {
  const { toast } = useStore()
  const [title, setTitle] = useState(doc.title)
  /*
   * 两处初值以前都是**编的**：
   *   · 路径默认填 doc.id —— 于是界面上永远显示一个「路径」，
   *     用户以为路径已经设好了，其实那只是它的内部 id。
   *   · 摘录默认截正文前 60 字 —— 用户从没写过摘录，
   *     打开就有一行摘要，看不出是替他编的。
   * 两个字段都改成如实：没有就是空。
   */
  const [slug, setSlug] = useState(doc.slug || '')
  const [summary, setSummary] = useState(doc.summary || '')
  const [tagInput, setTagInput] = useState(doc.tags.join(' '))

  return (
    <Modal
      open
      onClose={onClose}
      title="文档设置"
      width={520}
      footer={
        <>
          <Button variant="text" onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            onClick={() => {
              onChange({
                title: title.trim() || '未命名',
                // 存之前先归一化，界面上看到的和存下来的就是同一个东西
                slug: normalizeSlug(slug),
                summary: summary.trim(),
                tags: tagInput.split(/[\s,，]+/).filter(Boolean),
              })
              toast('文档已保存', 'success')
              onClose()
            }}
          >
            保存
          </Button>
        </>
      }
    >
      <div className="yq-docset">
        <div className="yq-share-label">标题</div>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />

        <div className="yq-share-label" style={{ marginTop: 16 }}>路径</div>
        <div className="yq-docset-slug">
          {/* 必须是**本机真实地址**。原来这里写死 yuque.com/yuque-clone/，
              而这个字段压根没落库也解析不了 —— 一个填了不生效、
              还指着别家公司官网的假地址。 */}
          <span>{location.host}/#/public/doc/</span>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={doc.id} />
        </div>
        <div className="yq-docset-hint">
          留空就用文档 id；填了就用它当地址（同一个知识库里要唯一）。
          只认字母、数字和连字符，中文会被去掉 —— 这时候地址退回文档 id。
          <br />
          地址长这样：<code>{docShareUrl(location.origin, doc.id, slug)}</code>
        </div>

        <div className="yq-share-label" style={{ marginTop: 16 }}>摘录</div>
        <textarea
          className="yq-docset-area"
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="一两句话说清这篇讲什么。会显示在对外分享页和搜索结果里"
        />

        <div className="yq-share-label" style={{ marginTop: 16 }}>标签</div>
        <Input
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          placeholder="空格分隔多个标签"
        />

        <div className="yq-docset-hint">
          公开知识库支持对单篇文档加密，加密后标题会显示一把小锁。
        </div>
      </div>
    </Modal>
  )
}

/**
 * 导出 Markdown。
 *
 * ⚠️ 这里以前是 `a.download = \`${title}.md\`` —— **零净化**，于是：
 *   · 标题《设计/方案:v2?》→ 文件名 `设计/方案:v2?.md`（`/` 在 Windows 上是路径分隔符，
 *     落盘时会被当成子目录，直接存不进去）
 *   · 标题《手册.md》→ `手册.md.md`
 *   · 超长标题 → 路径超限，导出静默失败
 *   · 空白标题 → `   .md`
 *
 * 而同一页的 Word / HTML / 纯文本走 `io.ts` 那条（它有净化），
 * 整库导出走 `book-export.ts`（也有）—— **三处实现，只有一处是全的**。
 * 现在统一收在 `@/lib/filename`。
 */
function downloadDoc(title: string, body: string) {
  const blob = new Blob([body], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = safeFileNameWithExt(title, 'md')
  a.click()
  URL.revokeObjectURL(url)
}

export { downloadDoc }
/**
 * 文档正文骨架。正文是按需拉的，这一屏就是拉取期间用户看到的东西。
 * 给标题占位 + 几行文字占位，避免空白闪烁。
 */
function DocSkeleton({ title }: { title: string }) {
  return (
    <div className="yq-doc-skeleton">
      <h1 className="yq-doc-skeleton-title">{title || '文档'}</h1>
      {[92, 78, 88, 64, 80].map((w, i) => (
        <div key={i} className="yq-doc-skeleton-line" style={{ width: w + '%' }} />
      ))}
    </div>
  )
}
