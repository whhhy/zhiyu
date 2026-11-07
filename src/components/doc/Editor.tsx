import {
  Fragment,
  useRef,
  useState,
  useMemo,
  useCallback,
  useEffect,
  useSyncExternalStore,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ClipboardEvent,
  type ReactNode,
} from 'react'
import type { Block } from '@/types'
import { flushSync } from 'react-dom'
import { Dropdown, MenuItem, MenuDivider, MenuLabel } from '@/components/ui'
import { YUQUE_CARDS, CARD_GROUPS, matchCards, type YuqueCard } from '@/data/cards'
import CardHost from '@/components/cards'
import { useStore } from '@/store'
import { markdownToBlocks, looksLikeMarkdown } from '@/store'
import { attachFileToDoc, releaseBlockAttachment, useAttachmentUrl } from '@/components/cards/common'
import { BLOCK_MIME, copyText, readCopiedBlocks, writeClipboard, type CopiedBlock } from '@/lib/clipboard'
import './index.css'

/* ============================================================
   块级复制粘贴：现在**接管 Ctrl+C / Ctrl+X**，不再只是菜单里的旁门
   ------------------------------------------------------------
   原来的做法是「模块级变量 `blockClipboard`，只有点菜单『复制内容』才写」。
   实测下来问题很大（详见 `src/lib/clipboard.ts` 顶部）：

   · 编辑器**没有** `onCopy`/`onCut`，用户按 Ctrl+C 走浏览器原生行为，
     那个模块变量纹丝不动 —— 接着点菜单「粘贴」粘出来的是**上一次**复制的东西，
     跟刚才那次 Ctrl+C 毫无关系；
   · 模块级 = 永不过期，也没有 React 状态，所以菜单里那项「粘贴」的置灰状态
     是**渲染那一刻**读到的旧值；
   · 它只能存**一个**块。

   现在：
   · 真正的剪贴板是**系统剪贴板**（自定义 MIME `application/x-yuque-block`），
     Ctrl+C / Ctrl+V 直接可用；
   · 这个 store 只服务两件事：让菜单「粘贴」在**内网 HTTP**（读不了系统剪贴板）
     下也有东西可粘，以及让菜单项的置灰状态跟得上。
   · 带**时间戳 + 来源**，超过 TTL 就当没有 —— 否则会粘出上周复制的东西。
   ============================================================ */
const CLIP_TTL = 5 * 60 * 1000
type CopiedMeta = { blocks: CopiedBlock[]; at: number; from: string }
let _clipStore: CopiedMeta | null = null
const readClip = () => (_clipStore && Date.now() - _clipStore.at < CLIP_TTL ? _clipStore : null)
const writeClip = (m: CopiedMeta) => { _clipStore = m }
/** 订阅：菜单项的置灰状态要跟着变，不能只在渲染那一刻读一次 */
const _clipSubs = new Set<() => void>()
const emitClip = () => { _clipSubs.forEach((f) => f()) }
const subscribeClip = (f: () => void) => { _clipSubs.add(f); return () => { _clipSubs.delete(f) } }

/* ============================================================
   哪些块渲染成**可编辑的文本元素**
   ============================================================
   「末尾继续输入区」原来判的是「最后一个块**没有文字**就进去」——
   而图片 / 表格 / 卡片 / 代码块的 `text` **本来就是空的**（内容在 data 里），
   于是「点下面那片空白」被判成「进最后一个块」，
   而那些块**压根没有 `.yq-block-text` 这个可编辑元素** ——
   结果既进不去光标，也**不会新建一行**（2026-10-19 用户报：
   「没办法在图片下面新建一行写文字」）。

   ⇒ 判据换成「最后一块**是不是可编辑的**」。
   这个清单必须与下面的渲染分支保持一致：
     `!isDivider && !isCode && !isImage && !isTable && !isCard` 才渲染 .yq-block-text
   清单和渲染分支分家的那天，这个 bug 会原样回来。
   ============================================================ */
const TEXT_BLOCK_TYPES = new Set<Block['type']>([
  'p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'todo', 'quote', 'callout',
])

/**
 * 图片块能拿到的地址。
 *
 * 图片块的 `text` 是空的（内容在 `data` / `src` 里），
 * 所以「复制内容」照抄 `block.text` 复制的是**空串** ——
 * 用户说「图片不能复制」，有一半是这个。
 */
function imageUrlOf(b: Block): string {
  if (b.src) return b.src
  const d = (b.data || {}) as { key?: string; dataUrl?: string }
  if (d.dataUrl) return d.dataUrl
  if (d.key) return `${location.origin}/api/attachment/${d.key}`
  return ''
}

/* ============================================================
   语雀式块编辑器
   - contentEditable 块，每块独立
   - Enter 新建块 / Backspace 合并
   - Markdown 快捷输入（# - 1. > ``` []）
   - 块左侧绿色 + 号、拖拽柄、类型切换
   ============================================================ */

export const BLOCK_META: Record<
  Block['type'],
  { label: string; icon: string; group: string }
> = {
  p: { label: '正文', icon: '¶', group: '基础' },
  h1: { label: '标题 1', icon: 'H1', group: '基础' },
  h2: { label: '标题 2', icon: 'H2', group: '基础' },
  h3: { label: '标题 3', icon: 'H3', group: '基础' },
  h4: { label: '标题 4', icon: 'H4', group: '基础' },
  ul: { label: '无序列表', icon: '•', group: '基础' },
  ol: { label: '有序列表', icon: '1.', group: '基础' },
  todo: { label: '待办事项', icon: '☑', group: '基础' },
  quote: { label: '引用', icon: '❝', group: '扩展' },
  /**
   * ⚠️ 这里原来写的是「提示卡片」，而 `src/data/cards.ts` 里同一个 id 叫「高亮块」。
   * 后果是实测出来的：**用户在块类型菜单里看到「提示卡片」，把这四个字打进斜杠菜单，
   * 搜不到任何东西** —— matchCards 走的是 name / pinyin / initial / en 四条，
   * 「高亮块」/「gaoliangkuai」/「glk」/「callout」里没有「提示卡片」这串。
   * 反过来搜「高亮块」倒是能搜到。于是同一个块有两个名字，一个能搜一个不能。
   * 统一成卡片目录里的官方名（cards.ts 头部写着「分类顺序与语雀官方一致」）。
   * test-blockrender 里有一条断言钉住两处必须一致，防它再分叉。
   */
  callout: { label: '高亮块', icon: '💡', group: '扩展' },
  code: { label: '代码块', icon: '</>', group: '扩展' },
  divider: { label: '分割线', icon: '—', group: '扩展' },
  image: { label: '图片', icon: '🖼', group: '媒体' },
  table: { label: '表格', icon: '▦', group: '媒体' },
  /**
   * 特色卡片块。group 故意取一个不在块类型菜单分组里的名字 ——
   * 卡片不是靠「块类型」菜单转出来的（转出来没有 data，就是个空壳），
   * 只能通过 "/" 斜杠菜单插入。
   */
  card: { label: '特色卡片', icon: '🧩', group: '特色' },
}

/** 列表类块：Enter 时延续类型 */
const LIST_TYPES: Block['type'][] = ['ul', 'ol', 'todo']
const HEADING_TYPES: Block['type'][] = ['h1', 'h2', 'h3', 'h4']

export interface EditorHandle {
  insert: (type: Block['type'], afterId?: string) => void
  focus: () => void
  getActiveBlockId: () => string | null
}

interface EditorProps {
  blocks: Block[]
  onChange: (blocks: Block[], caretBlockId?: string) => void
  readOnly?: boolean
  onBlockFocus?: (blockId: string) => void
  onActiveBlockChange?: (blockId: string | null) => void
  members?: { id: string; name: string; avatar: string }[]
  /**
   * 插在第一个块之后的内容插槽。
   * 语雀的文档元信息（作者 / 更新时间 / 字数）就挂在这个位置——
   * 因为文档标题本身是第一个 H1 块，元信息必须跟在标题块下面。
   */
  afterFirstSlot?: ReactNode
  /** 插入卡片（图片/表格/画板等），交由上层处理 */
  onInsertCard?: (cardId: string) => void
  /** 粘贴多行内容：在当前块之后插入这些块（Markdown 转换 / 纯文本拆段共用） */
  onPasteBlocks?: (blocks: Block[]) => void
  /** "@" 面板可提及的文档 */
  mentionableDocs?: { id: string; title: string }[]
  /**
   * 把「把焦点放到某个块上」的能力交给上层。
   *
   * 上层（DocPage）插完一张卡片后要**补一个收尾空段落并把光标放进去** ——
   * 否则「插完表格接着在下面写」这件事做不到（和粘贴图片是同一类问题）。
   * 而聚焦是编辑器的内部能力（它有 `focusBlock`），所以由编辑器把函数交出去。
   */
  focusRef?: { current: ((id: string) => void) | null }
}

/** markdown 前缀 → 块类型 */
const MD_RULES: [RegExp, Block['type']][] = [
  [/^#\s$/, 'h1'],
  [/^##\s$/, 'h2'],
  [/^###\s$/, 'h3'],
  [/^####\s$/, 'h4'],
  [/^[-*]\s$/, 'ul'],
  [/^\d+\.\s$/, 'ol'],
  [/^>\s$/, 'quote'],
  [/^```\s$/, 'code'],
  [/^\[\s?\]\s$/, 'todo'],
]

export default function Editor({ blocks, onChange, readOnly, onBlockFocus, onActiveBlockChange, members = [], afterFirstSlot, onInsertCard, onPasteBlocks, mentionableDocs = [], focusRef }: EditorProps) {
  const [activeId, setActiveId] = useState<string | null>(blocks[0]?.id || null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [slash, setSlash] = useState<{ id: string; x: number; y: number; q: string } | null>(null)
  /** 语雀：最近使用的卡片最多展示 4 个 */
  const [recentCards, setRecentCards] = useState<string[]>([])
  /** @ 唤起面板：语雀「文档内支持 @ 唤起面板找文档或用户」 */
  const [mention, setMention] = useState<{ id: string; x: number; y: number; q: string } | null>(null)
  /**
   * 块多选（语雀：点左侧选择框 / ⌘ 点击 连选）。
   *
   * 为什么之前没有：全项目搜不到任何 `ctrlKey`/`shiftKey` 的点击分支，
   * 帮助页与快捷键面板也从未提过 —— 也就是说官方有、我们没有，
   * 且**没有任何文案承诺过**。所以这是补功能，不是修失真。
   *
   * `anchor` 是 shift 连选的起点：shift 点 B 时选 A..B 这一段；
   * ⌘ 点是逐个加/减。
   */
  const [sel, setSel] = useState<string[]>([])
  const [selAnchor, setSelAnchor] = useState<string | null>(null)
  const inSelectMode = sel.length > 0
  /** 供渲染时 O(1) 查 —— 注意每次渲染重建，别让它活过一轮 */
  const selSet = new Set(sel)

  const clearSel = useCallback(() => { setSel([]); setSelAnchor(null) }, [])

  /**
   * 订阅块剪贴板。
   *
   * 原来菜单里那项的 `disabled={!getBlockClipboard()}` 是在**渲染那一刻**
   * 读一个模块级变量 —— React 不会因为模块变量变了就重渲染，
   * 于是置灰状态停留在旧的：「我刚 Ctrl+C 过，它怎么还灰着」。
   * ⇒ 这里用 `useSyncExternalStore` 订阅，复制完菜单会真的变亮。
   */
  const clip = useSyncExternalStore(subscribeClip, readClip, readClip)

  /**
   * 待聚焦的块 id。
   *
   * 为什么需要「延迟一轮」：插入是**同步**提交的（store 立刻变），
   * 但那一刻新块**还没挂载**，`focusBlock` 找不到它。
   * 所以先把 id 记在这儿，等 `blocks` 更新后再聚焦。
   */
  const pendingFocus = useRef<string | null>(null)
  useEffect(() => {
    const id = pendingFocus.current
    if (!id) return
    if (!blocks.some((b) => b.id === id)) return
    pendingFocus.current = null
    setActiveId(id)
    focusBlock(id)
  }, [blocks])
  /* 把聚焦能力交给上层（DocPage 插完卡片要靠它落光标） */
  useEffect(() => {
    if (!focusRef) return
    focusRef.current = (id: string) => { pendingFocus.current = id }
    return () => { focusRef.current = null }
  }, [focusRef])

  const toggleSelect = useCallback((e: { shiftKey: boolean }, id: string) => {
    if (e.shiftKey && selAnchor) {
      const a = blocks.findIndex((b) => b.id === selAnchor)
      const b = blocks.findIndex((x) => x.id === id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSel(blocks.slice(lo, hi + 1).map((x) => x.id))
        return
      }
    }
    setSelAnchor(id)
    setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  }, [blocks, selAnchor])

  /** 批量删除。至少留一个空块 —— 不能把文档删空 */
  const deleteSelected = useCallback(() => {
    if (!sel.length) return
    const kill = new Set(sel)
    const firstIdx = blocks.findIndex((b) => kill.has(b.id))
    const next = blocks.filter((b) => !kill.has(b.id))
    const finalBlocks = next.length
      ? next
      : [{ id: 'bk_' + Date.now().toString(36), type: 'p' as const, text: '' }]
    flushSync(() => onChange(finalBlocks))
    clearSel()
    const target = finalBlocks[Math.max(0, firstIdx - 1)] || finalBlocks[0]
    setActive(target.id)
    focusBlock(target.id)
  }, [sel, blocks, onChange, clearSel])

  /** 批量转块类型（语雀的「把选中的都变成标题/列表」） */
  const convertSelected = useCallback((type: Block['type']) => {
    if (!sel.length) return
    const s = new Set(sel)
    const next = blocks.map((b) => (s.has(b.id) ? { ...b, type, ...(type === 'code' ? { lang: 'javascript' } : {}) } : b))
    flushSync(() => onChange(next))
  }, [sel, blocks, onChange])
  const markRecent = (id: string) =>
    setRecentCards((r) => [id, ...r.filter((x) => x !== id)].slice(0, 4))
  const rootRef = useRef<HTMLDivElement>(null)
  const blockMap = useRef(new Map<string, Block>())

  // 维护最新 blocks 的 ref，供键盘处理读取
  blocks.forEach((b) => blockMap.current.set(b.id, b))
  const getBlocks = () => blocks
  const getBlock = (id: string) => blockMap.current.get(id)

  useEffect(() => {
    onActiveBlockChange?.(activeId)
  }, [activeId, onActiveBlockChange])

  /** 同步聚焦到指定块末尾 */
  const focusBlock = (id: string) => {
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-block-id="${id}"]`)
    /* ⚠️ `.yq-img-text` 也在列 —— 图片**右边**那段文字是图片块的一部分，
       它是能进光标的（语雀就是图片后面接着写）。 */
    const textEl = el?.querySelector<HTMLElement>('.yq-block-text, .yq-code-body, .yq-img-text') || el
    if (!textEl) return
    textEl.focus()
    placeCaretEnd(textEl)
  }

  const setActive = (id: string) => {
    setActiveId(id)
    const b = blockMap.current.get(id)
    if (b) onBlockFocus?.(id)
  }

  /** 把光标放到指定块的开头（↓ 跳过去时用） */
  const focusBlockAt = (id: string, where: 'start' | 'end') => {
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-block-id="${id}"]`)
    const textEl = el?.querySelector<HTMLElement>('.yq-block-text, .yq-code-body, .yq-img-text')
    if (!textEl) return
    setActive(id)
    if (where === 'end') { placeCaretEnd(textEl); return }
    textEl.focus()
    const range = document.createRange()
    range.selectNodeContents(textEl)
    range.collapse(true)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
  }

  /* ---------------- "/" 斜杠菜单 ---------------- */
  const openSlash = (blockId: string, el: HTMLDivElement) => {
    const rect = el.getBoundingClientRect()
    setSlash({ id: blockId, x: rect.left, y: rect.bottom + 4, q: '' })
  }

  const closeSlash = useCallback(() => setSlash(null), [])

  useEffect(() => {
    if (!slash) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSlash(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [slash])

  // 面板内过滤词跟随用户在块里的输入
  useEffect(() => {
    if (!slash) return
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-block-id="${slash.id}"] .yq-block-text`)
    if (!el) return
    const id = setInterval(() => {
      const t = el.innerText
      setSlash((s) => (s && s.q !== t ? { ...s, q: t.replace(/^\//, '') } : s))
      if (!t.startsWith('/')) setSlash(null)
    }, 60)
    return () => clearInterval(id)
  }, [slash?.id])

  /**
   * 在某个块后面插入**一组**块 —— 复制粘贴要保序，插一个就够用的那个
   * `insertAfter` 不能用（它每插一个都会重算下标）。
   *
   * ⚠️ 必须一次提交：每插一个就 `onChange` 一次的话，
   * 中间那些帧里 `blocks` 还是旧的，第二块会插到第一个的位置上。
   */
  const insertBlocksAfter = useCallback(
    (id: string, incoming: CopiedBlock[]) => {
      if (!incoming.length) return
      const idx = blocks.findIndex((b) => b.id === id)
      const fresh = incoming.map((c) => ({
        id: `bk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        type: c.type as Block['type'],
        text: c.text || '',
        ...(c.data ? { data: JSON.parse(JSON.stringify(c.data)) } : {}),
      }))
      const next = [...blocks]
      next.splice(idx + 1, 0, ...fresh)
      flushSync(() => onChange(next, fresh[0].id))
      setActive(fresh[0].id)
      focusBlock(fresh[0].id)
    },
    [blocks, onChange],
  )

  /**
   * **替换**：把选区压到的那些块换成新块。
   *
   * 为什么放在 Editor 而不是 DocPage：替换完**光标要落到新块里**，
   * 而焦点是 Editor 管的（`setActive` + `focusBlock`）。
   * 放 DocPage 的话，替换之后 `activeId` 指向的旧块已经不存在了 ——
   * 粘完一下没焦点，还得再点一下。
   */
  const replaceBlocks = useCallback(
    (removeIds: string[], incoming: Block[]) => {
      if (!incoming.length) return
      const idxs = blocks.map((b, i) => (removeIds.includes(b.id) ? i : -1)).filter((i) => i >= 0)
      if (!idxs.length) {
        // 选区没压到任何块 —— 退回复制，别静默丢掉选中的内容
        const anchor = activeId ?? blocks[0]?.id
        if (anchor) insertBlocksAfter(anchor, incoming)
        return
      }
      const first = idxs[0]
      const last = idxs[idxs.length - 1]
      // 重新发 id：万一进来的块带着旧 id，撞上正文里已有的块就麻烦了
      const fresh = incoming.map((c) => ({
        ...c,
        id: `bk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      }))
      const next = [...blocks.slice(0, first), ...fresh, ...blocks.slice(last + 1)]
      flushSync(() => onChange(next, fresh[0].id))
      setActive(fresh[0].id)
      focusBlock(fresh[0].id)
    },
    [blocks, onChange, activeId, insertBlocksAfter],
  )

  /**
   * 复制：把**一组块**写进系统剪贴板，并如实告诉用户结果。
   *
   * 纯文本那一半给跨应用用；块结构走自定义 MIME（内网 HTTP 下写不进去，
   * 那时候只能说「只复制了纯文本」—— 见 clipboard.ts 的降级分支）。
   */
  const copyBlocks = useCallback(
    (ids: string[], from: string) => {
      const picked = ids
        .map((id) => blocks.find((b) => b.id === id))
        .filter((b): b is Block => !!b)
      if (!picked.length) return
      const payload: CopiedBlock[] = picked.map((b) => ({ type: b.type, text: b.text, data: b.data }))
      /*
       * 纯文本那一半给跨应用用。
       * ⚠️ 图片块的 `text` 是空的 —— 照抄它，复制到系统剪贴板的就是**空串**，
       * 用户粘到别处什么都没有（2026-10-19 用户报「图片不能复制」的一半）。
       * ⇒ 图片块改成复制它的**地址**。
       */
      const plain = picked.map((b) => (b.type === 'image'
        ? [imageUrlOf(b), b.text].filter(Boolean).join(' ')
        : b.text)).join('\n')
      writeClip({ blocks: payload, at: Date.now(), from })
      emitClip()
      void writeClipboard(plain, payload).then((r) => {
        const t = useStore.getState().toast
        if (r.ok && r.rich) t(`已复制 ${picked.length} 个块（结构会原样粘回来）`, 'success')
        else if (r.ok) t(`已复制 ${picked.length} 个块的纯文本`, 'info')
        else t(r.message, 'info')
      })
      if (ids.length) clearSel()
    },
    [blocks, clearSel],
  )

  /**
   * Ctrl+C / Ctrl+X —— 现在**接管**了。
   *
   * 什么时候**不**接管：用户是在**选字**，不是在复制块。
   * 判据是「选区非折叠且选出来的字非空白」—— 这时候抢走剪贴板会把
   * 「复制这段话」变成「复制整个块」，是明显的倒退。
   *
   * 复制哪些块：有多选就整组（按正文顺序，不按点选的顺序），
   * 否则当前聚焦的那个。光标不在任何块里就不管，交给浏览器。
   */
  const handleCopyEvent = (e: ClipboardEvent<HTMLElement>) => {
    if (readOnly) return
    const s = window.getSelection()
    if (s && !s.isCollapsed && s.toString().trim()) return
    let ids: string[] = []
    let from = '当前块'
    if (inSelectMode && sel.length) {
      const order = new Map(blocks.map((b, i) => [b.id, i]))
      ids = [...sel].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      from = `选中的 ${ids.length} 个块`
    } else if (activeId) {
      ids = [activeId]
    }
    if (!ids.length) return
    e.preventDefault()
    copyBlocks(ids, from)
  }

  /**
   * 复制**图片本身**（二进制进剪贴板），而不是复制地址。
   *
   * ⚠️ 这条路**需要安全上下文**（https 或 localhost）：
   * `navigator.clipboard.write` 配 `ClipboardItem` 写图片，
   * 在内网 HTTP 部署下 `navigator.clipboard` 压根是 `undefined`。
   * ⇒ 拿不到就退回复制地址，并**说清楚是退化了**，
   * 而不是弹一个「已复制」让人以为图已经在剪贴板里。
   */
  const copyImage = useCallback(async (b: Block) => {
    const toast = useStore.getState().toast
    const url = imageUrlOf(b)
    if (!url) { toast('这张图没有可复制的地址', 'error'); return }
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        const blob = await (await fetch(url)).blob()
        const type = blob.type || 'image/png'
        if (ClipboardItem.supports(type)) {
          await navigator.clipboard.write([new ClipboardItem({ [type]: blob })])
          toast('图片已复制（可以直接粘到 Word / 飞书）', 'success')
          return
        }
      }
    } catch { /* 拿不到就落到下面统一处理 */ }
    const r = await copyText(url)
    toast(r.ok
      ? '已复制图片地址（当前是 HTTP 访问，浏览器不让把图片本身写进剪贴板）'
      : `复制失败：${r.message}`, r.ok ? 'info' : 'error')
  }, [])

  /* ---------------- 写操作 ---------------- */

  const update = useCallback(
    (id: string, patch: Partial<Block>) => {
      onChange(blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)))
    },
    [blocks, onChange],
  )

  const insertAfter = useCallback(
    (id: string, type: Block['type'] = 'p', text = '', data?: Record<string, any>) => {
      const idx = blocks.findIndex((b) => b.id === id)
      const nb: Block = {
        id: `bk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        type,
        text,
        // 复制卡片块时要把结构化数据一起带走，否则复制出来是个空壳
        ...(data ? { data: JSON.parse(JSON.stringify(data)) } : {}),
      }
      const next = [...blocks]
      next.splice(idx + 1, 0, nb)
      // 同步提交，保证 DOM 里立刻有新块可聚焦（异步渲染会让快速连打丢焦点）
      flushSync(() => onChange(next, nb.id))
      setActive(nb.id)
      focusBlock(nb.id)
    },
    [blocks, onChange],
  )

  /**
   * 在第 index 个位置插一个新块（index = blocks.length 就是插到最后），光标放进去。
   *
   * 为什么要有「按位置插」而不只是「按块插」：
   *   两张**紧挨着**的图片之间没有「下一块」可指 ——
   *   而「在图片后面继续编辑文字」要的就是**那个位置**上多一行。
   */
  const insertAt = useCallback((index: number, type: Block['type'] = 'p', text = '') => {
    const nb: Block = {
      id: `bk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type,
      text,
    }
    const next = [...blocks]
    next.splice(Math.max(0, Math.min(index, next.length)), 0, nb)
    flushSync(() => onChange(next, nb.id))
    setActive(nb.id)
    focusBlock(nb.id)
  }, [blocks, onChange])

  /** 这个块能不能进光标（有没有可编辑元素）—— 判据取自真实 DOM */
  const isEditableBlock = useCallback((id: string) => {
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-block-id="${id}"]`)
    return !!el?.querySelector('.yq-block-text, .yq-code-body, .yq-img-text')
  }, [])

  /**
   * 从 from 往后（dir=1）/往前（dir=-1）找第一个「能进光标」的块。
   *
   * 判据取自**真实 DOM**（有没有 .yq-block-text / .yq-code-body），
   * 而不是「块的 type 清单」—— 清单和渲染分支一改名就会对不上，
   * 而对不上的后果是「跳不过去」或者「跳到进不去的地方」。
   */
  const findEditableFrom = useCallback((from: number, dir: 1 | -1): string | null => {
    for (let i = from + dir; i >= 0 && i < blocks.length; i += dir) {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-block-id="${blocks[i].id}"]`)
      if (el?.querySelector('.yq-block-text, .yq-code-body, .yq-img-text')) return blocks[i].id
    }
    return null
  }, [blocks])

  /**
   * 「在图片后面编辑」—— 光标落到**紧挨着的下一段**文字里。
   * ------------------------------------------------------------
   * 2026-10-20 用户实测报的问题（真实文档里）：
   *   图片块的**下面**那一行是文件名（caption），它**属于图片块** ——
   *   点那里放不下光标；而图片后面**已经有**一段时，
   *   「末尾继续输入区」又在**文档最底下**（离图片很远）。
   *   ⇒ 「点图片下面 → 打字」这条路在真实文档里**根本走不通**。
   *
   * 规则：
   *   · 紧接着的那块**能进光标** → 光标进去（不制造空段落）
   *   · 紧接着的那块是**图片**（两张图挨着）或者压根没有 → **在那个位置**新建一段
   */
  const editAfter = useCallback((id: string) => {
    const idx = blocks.findIndex((b) => b.id === id)
    if (idx < 0) return
    const next = blocks[idx + 1]
    if (next && isEditableBlock(next.id)) { focusBlockAt(next.id, 'start'); return }
    insertAt(idx + 1, 'p')
  }, [blocks, isEditableBlock, insertAt])

  /**
   * 点在**块之间的空隙**上 → 就在那儿建一段，光标放进去。
   * ------------------------------------------------------------
   * 2026-10-20 实测（用户正在编辑的那篇，里面两张图紧挨着）：
   *   图片块下面有 **30px 死区** —— 命中的是 `.yq-editor-blocks`（容器），
   *   点下去**什么都不会发生**：没有光标、没有反馈。
   *   而两张相邻的图之间（gap 38px）命中的还是图片自己的文件名行。
   *   ⇒ 于是「在图片后面继续编辑文字」在那篇里**无处可去**。
   *
   * 语雀/Notion 的做法：在空隙里点就在那儿开一段。
   * ⚠️ 只在**点中容器本身**时触发（点在某个块上 → 走各块自己的处理）。
   */
  const onGapMouseDown = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return
    const y = e.clientY
    const els = [...(rootRef.current?.querySelectorAll('.yq-block') || [])]
    let idx = els.length
    for (let i = 0; i < els.length; i++) {
      if (els[i].getBoundingClientRect().top > y) { idx = i; break }
    }
    e.preventDefault()
    const b = blocks[idx]
    /* 那个位置已经有一段**空的** → 直接进去，不制造多余的空段落 */
    if (b && !b.text && isEditableBlock(b.id)) { focusBlockAt(b.id, 'start'); return }
    insertAt(idx, 'p')
  }

  /**
   * ↑ / ↓ 在块间移动；**图片这类进不去光标的块**，按 Enter / ↓ 直接落到下面那段文字。
   * ------------------------------------------------------------
   * 2026-10-20 实测（用户：「语雀是直接在图片后面编辑的」）：
   *   点中图片之后 `document.activeElement` 是 BODY ——
   *   图片块**压根不可聚焦**，于是按 Enter / ↓ **什么都不会发生**，
   *   光标也无处可去：鼠标能过去（点图片下面那片空白），键盘过不去。
   *   而「↑ ↓ 在块间移动」是快捷键面板里**承诺过**的（见 Shortcuts.tsx），
   *   实际并不存在 —— 面板承诺了、界面做不到，正是这个项目最恨的那一类。
   *
   * ⚠️ 拦 ↑↓ 之前必须先量「光标是不是已经在首/末行」：
   *   不然多行段落里按 ↑↓ 会被抢走（浏览器本来是在段内上下移动光标）。
   *   判据：单行块里随便按；多行块里只有光标在**开头**（↑）/ **结尾**（↓）才让给块间移动。
   */
  useEffect(() => {
    if (readOnly) return
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const k = e.key
      /* 可打印的单字符（就是「在打字」）；IME 组字中的 key 不算 */
      const printable = k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing
      if (k !== 'ArrowDown' && k !== 'ArrowUp' && k !== 'Enter' && !printable) return
      const ae = document.activeElement as HTMLElement | null
      if (!ae || !ae.closest?.('.yq-editor')) return
      const holder = ae.closest<HTMLElement>('[data-block-id]')
      const curId = holder?.getAttribute('data-block-id') || null
      if (!curId) return
      const idx = blocks.findIndex((b) => b.id === curId)
      if (idx < 0) return
      const inEditable = !!ae.closest?.('[contenteditable="true"]')
      /* 焦点在按钮/链接上（刚点过图片工具条）→ 这些键归那个控件，别抢 */
      const onControl = !!ae.closest?.('button, a')
      if (onControl && (k === 'Enter' || k === ' ')) return

      if (!inEditable) {
        /* 图片 / 表格 / 卡片 / 分割线：光标进不去，只能靠键盘跳出去 */
        if (k === 'Enter') { e.preventDefault(); insertAfter(curId, 'p'); return }
        /*
         * **直接打字**（2026-10-20 用户报「在图片后面编辑还是有问题」）：
         * 之前图片被选中时敲键盘**一个字都进不去**，界面零反馈 ——
         * 用户只会以为「又坏了」。而「点图片 → 打字，字就出现在图片后面」
         * 正是这句话最直白的期望。
         *
         * ⚠️⚠️ **必须只挪光标、不能拦下这个键**（2026-10-20 实测踩到）：
         *   中文输入走的是 **IME**：组字过程里**没有 keydown**，
         *   最后落地的是 `insertText`/`input`（实测：打中文时 keydown 事件数 = 0）。
         *   所以：
         *     · 拦下键（preventDefault）+ 自己把字塞进去 → **中文一个都进不来**；
         *     · 只拦英文 → 中文还是进不来。
         *   ⇒ 正确做法是**先把光标挪进一个可编辑块**，然后**不拦这个键**，
         *     让浏览器把字（和中文的组字过程）送进那个块里。
         *
         * ⚠️ 焦点在工具条按钮上时不抢（那是那个按钮自己的键盘行为）。
         */
        if (printable && !onControl) {
          /* 图片块自己有「右边那段」→ 光标进**它自己**
             （语雀：文字紧跟在图片右边，同一行）。 */
          const ownEl = rootRef.current?.querySelector<HTMLElement>(`[data-block-id="${curId}"]`)
          const tail = ownEl?.querySelector<HTMLElement>('.yq-img-text')
          if (tail) { tail.focus({ preventScroll: true }); placeCaretEnd(tail); return }
          const next = findEditableFrom(idx, 1)
          if (next) focusBlockAt(next, 'start')
          else insertAfter(curId, 'p')
          return
        }
        const dir: 1 | -1 = k === 'ArrowDown' ? 1 : -1
        const target = findEditableFrom(idx, dir)
        if (target) { e.preventDefault(); focusBlockAt(target, dir === 1 ? 'start' : 'end') }
        else if (dir === 1) { e.preventDefault(); insertAfter(curId, 'p') }
        return
      }

      /*
       * 光标在文字里：**只有 ↑↓** 才轮到「块间移动」。
       *
       * ⚠️⚠️ 其它键（可打印字符 / Backspace / Delete…）**一律不碰** ——
       *   2026-10-20 实测踩到：这里原来只挡了 Enter，**可打印字符会 fall through**
       *   到下面的「跳到相邻块」逻辑 —— 于是**打英文时光标跳到上一个块、字符被吃掉**。
       *   而中文因为走 IME（**没有 keydown**）一直没暴露，测试全绿。
       *   ⇒ 「这个键在别的上下文里有没有主人」：在文字块里，字符归浏览器。
       */
      if (k !== 'ArrowDown' && k !== 'ArrowUp') return
      const textEl = ae.closest<HTMLElement>('.yq-block-text, .yq-code-body, .yq-img-text')
      if (!textEl) return
      if (k === 'ArrowDown') {
        if (!(isCaretAtEnd(textEl) || isSingleLineBlock(textEl))) return
      } else {
        if (!(caretOffsetIn(textEl) === 0 || isSingleLineBlock(textEl))) return
      }
      const dir: 1 | -1 = k === 'ArrowDown' ? 1 : -1
      const target = findEditableFrom(idx, dir)
      if (target) { e.preventDefault(); focusBlockAt(target, dir === 1 ? 'start' : 'end') }
      else if (dir === 1) { e.preventDefault(); insertAfter(curId, 'p') }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [blocks, readOnly, insertAfter])

  /**
   * 删块之后回收该块引用的附件二进制。
   * 失败只弹提示，**不把块恢复回去** —— 块已经删了，
   * 为了一个删不掉的孤儿文件把它塞回正文，用户会以为「删除没生效」而反复点。
   * 提示里写清「二进制还在库里」，比假装成功诚实。
   *
   * keptFor > 0（文件还被别的文档引用着）用 info 而不是 error：
   * 那不是失败，是共享语义，按错误提示会让人一直点。
   */
  const releaseAfterRemove = useCallback(
    (b: Block | undefined): Promise<{ err: string; keptFor: number }> => {
      if (!b?.data?.key) return Promise.resolve({ err: '', keptFor: 0 })
      return releaseBlockAttachment(useStore.getState().docs, b).then(({ err, keptFor }) => {
        if (err) useStore.getState().toast(`附件删除失败：${err} 二进制仍留在库里`, 'error')
        else if (keptFor) useStore.getState().toast(`这份文件还被 ${keptFor} 篇文档引用，已保留文件`, 'info')
        return { err, keptFor }
      })
    },
    [],
  )

  const removeBlock = useCallback(
    (id: string) => {
      if (blocks.length === 1) {
        // 最后一个块不能删，转成空正文重来。
        // html 必须一起清：这里 spread 了旧块，只清 text 的话
        // BlockRow 同步 DOM 时会拿旧 html 把内容原样写回来（删不掉）。
        const nb = { ...blocks[0], type: 'p' as const, text: '', html: '' }
        // 附件块走到这里（最后一个块删不掉 → 转成空段落）同样要回收二进制
        void releaseAfterRemove(blocks[0])
        onChange([nb], nb.id)
        return
      }
      const idx = blocks.findIndex((b) => b.id === id)
      const next = blocks.filter((b) => b.id !== id)
      onChange(next)
      /*
       * 删块要回收这个块引用的附件二进制。
       *
       * 原来只有卡片内部的「删除」按钮会回收，走的是 emptyAttachmentPatch；
       * 而**卡片工具栏的「删除卡片」和块级菜单的「删除块」（`···` 与右键都落这里）
       * 都直接进 removeBlock**，于是那条路上附件变成孤儿 ——
       * 服务端模式下就是一份永远下不掉的文件。
       *
       * 放在删完之后再回收（而不是之前）：`releaseAttachment` 靠
       * `countAttachmentRefs > 1` 判断还有没有别的块在用同一个 key，
       * 必须让文档里已经**不含**这个块，它才认得出「没人引用了」。
       * 失败只提示、不回滚 —— 块已经删了，为一个孤儿文件把它塞回去反而更糟。
       */
      const gone = blocks[idx]
      if (gone) void releaseAfterRemove(gone)
      const target = next[Math.max(0, idx - 1)]
      if (target) {
        setActive(target.id)
        focusBlock(target.id)
      }
    },
    [blocks, onChange],
  )

  /**
   * 卡片数据的补丁入口。
   * 同一个事件里连着改两次是常事（先加一张图、再清掉错误提示），
   * 而 blocks 是同一次渲染的快照 —— 直接浅合并会让后一次把前一次覆盖掉。
   * 所以这里用 pending 把连续补丁串起来；
   * 一旦发现 store 里的 data 不是我们最后写进去的那个对象（= 别人改了，比如协同同步），
   * 就以 store 为准重新起算。
   */
  const pendingCardData = useRef(new Map<string, Record<string, any>>())
  const patchCardData = useCallback(
    (id: string, patch: Record<string, any>) => {
      const cur = blockMap.current.get(id)?.data
      const pending = pendingCardData.current.get(id)
      const base = !pending || (cur && cur !== pending) ? cur || {} : pending
      const next = { ...base, ...patch }
      pendingCardData.current.set(id, next)
      update(id, { data: next })
    },
    [update],
  )

  const convert = useCallback(
    (id: string, type: Block['type']) => {
      const nextBlocks = blocks.map((b) =>
        b.id === id ? { ...b, type, ...(type === 'code' ? { lang: 'javascript' } : {}) } : b)
      flushSync(() => onChange(nextBlocks))
      setActive(id)
      focusBlock(id)
    },
    [blocks, onChange],
  )

  const move = useCallback(
    (id: string, dir: -1 | 1) => {
      const idx = blocks.findIndex((b) => b.id === id)
      const to = idx + dir
      if (to < 0 || to >= blocks.length) return
      const next = [...blocks]
      ;[next[idx], next[to]] = [next[to], next[idx]]
      flushSync(() => onChange(next))
      setActive(id)
      focusBlock(id)
    },
    [blocks, onChange],
  )

  /* ---------------- 拖拽排序 ---------------- */

  const handleDrop = (overIdx: number) => {
    if (!dragId) return
    const from = blocks.findIndex((b) => b.id === dragId)
    if (from < 0) return
    const next = [...blocks]
    const [item] = next.splice(from, 1)
    next.splice(from < overIdx ? overIdx - 1 : overIdx, 0, item)
    onChange(next)
    setDragId(null)
    setOverId(null)
  }

  return (
    <div className="yq-editor" ref={rootRef} onClick={() => onActiveBlockChange?.(null)} onCopy={handleCopyEvent} onCut={handleCopyEvent}>
      <div className="yq-editor-blocks">
        {blocks.map((b, i) => (
          <Fragment key={b.id}>
          {i === 0 && afterFirstSlot}
          <BlockRow
            block={b}
            index={i}
            onPasteBlocks={(incoming) => {
              /*
               * 末尾是**图片**时：光标进图片**右边那段**（同行尾巴文字）。
               * 语雀就是这样（用户 2026-10-20 的截图：图片右边紧跟着字，同一行）。
               * ⇒ 不再补一个「图片下面的空段落」—— 那会把字放到**下一行**。
               *
               * 末尾是**其它不可编辑**的块（表格 / 卡片 / 代码）时，
               * 仍然**补一个空段落在它下面，并把光标放进去**
               * （2026-10-19 用户报「图片在最后一行粘贴，没办法继续往下写新行」：
               *   粘贴是「在当前块之后插」，而当前块是图片**上面**那个 ——
               *   光标还留在那儿，用户接着打字，字直接跑到了图片**上面**）。
               */
              const last = incoming[incoming.length - 1]
              if (last && last.type === 'image') {
                pendingFocus.current = last.id
                onPasteBlocks?.(incoming)
                return
              }
              if (last && !TEXT_BLOCK_TYPES.has(last.type)) {
                const tailId = `bk_tail${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
                pendingFocus.current = tailId
                onPasteBlocks?.([...incoming, { id: tailId, type: 'p', text: '' }])
                return
              }
              onPasteBlocks?.(incoming)
            }}
            /**
             * 替换谁？**先看多选**：勾选了若干块就替换那些块；
             * 没多选才轮到「文本选区压到了哪些块」。
             * 两种「选择」都要覆盖 —— 用户说「选择粘贴」时，
             * 指的多半是其中之一，而两种以前都是「粘到下一行」。
             */
            onReplaceBlocks={(ids, incoming) => replaceBlocks(sel.length ? sel : ids, incoming)}
            hasMultiSel={sel.length > 0}
            active={activeId === b.id}
            readOnly={readOnly}
            dragging={dragId === b.id}
            overTarget={overId === b.id && dragId !== b.id}
            members={members}
            onFocus={() => setActive(b.id)}
            onBlur={() => setActiveId((c) => (c === b.id ? c : c))}
            onText={(t, html) => {
              // markdown 快捷输入检测
              const rule = MD_RULES.find(([re]) => re.test(t))
              if (rule && t.length <= 5) {
                const [re, type] = rule
                const rest = t.replace(re, '')
                // 类型变了，之前攒的 html 格式不再适用，必须清掉
                update(b.id, {
                  type, text: rest, html: rest ? escapeHtml(rest) : '',
                  ...(type === 'code' ? { lang: 'javascript' } : {}),
                })
                return
              }
              // 纯文本没变但格式变了（加粗/颜色/链接…），也要落盘
              update(b.id, { text: t, html })
            }}
            onEnter={(e, el) => {
              // 斜杠菜单打开时把 Enter 让给菜单（双保险）
              if (slash && slash.id === b.id) return
              e.preventDefault()
              const isList = LIST_TYPES.includes(b.type)
              if (isList && b.text.trim() === '') {
                convert(b.id, 'p')
                return
              }
              const nextType: Block['type'] = isList ? b.type : 'p'
              const sel = window.getSelection()
              const selText = sel && !sel.isCollapsed ? sel.toString() : ''
              if (selText) {
                // 选中文本回车：拆分块
                const before = b.text.replace(selText, '').slice(0, Math.max(0, selectionOffset(el, sel!)))
                const after = b.text.replace(selText, '').slice(Math.max(0, selectionOffset(el, sel!)))
                const idx = blocks.findIndex((x) => x.id === b.id)
                const nb: Block = {
                  id: `bk_${Date.now().toString(36)}`,
                  type: b.type,
                  text: after,
                  checked: b.checked,
                }
                const cur = blocks.find((x) => x.id === b.id)!
                const next = [...blocks]
                next[idx] = { ...cur, text: before }
                next.splice(idx + 1, 0, nb)
                onChange(next, nb.id)
                setActive(nb.id)
                return
              }
              insertAfter(b.id, nextType)
            }}
            onBackspace={(e, el) => {
              const txt = getBlock(b.id)?.text ?? ''
              const atStart = isCaretAtStart(el)
              if (LIST_TYPES.includes(b.type) && txt.trim() === '') {
                e.preventDefault()
                convert(b.id, 'p')
                return
              }
              if (txt === '' && blocks.length > 1) {
                e.preventDefault()
                removeBlock(b.id)
                return
              }
              if (atStart && HEADING.includes(b.type)) {
                e.preventDefault()
                convert(b.id, 'p')
                return
              }
            }}
            onTab={(e) => {
              e.preventDefault()
              if (LIST_TYPES.includes(b.type)) convert(b.id, 'p')
              else insertAfter(b.id, 'ul')
            }}
            onSlashMenu={(el) => openSlash(b.id, el)}
            onSlashClose={closeSlash}
            onMention={(el, mq, mx, my) => setMention({ id: b.id, x: mx, y: my, q: mq })}
            onMentionClose={() => setMention(null)}
            onDuplicateBlock={() => insertAfter(b.id, b.type, b.text, b.data)}
            onCopyBlock={() => copyBlocks([b.id], '当前块')}
            onCopyImage={() => copyImage(b)}
            onImageText={(t) => update(b.id, { text: t, html: '' })}
            onImageEnter={() => insertAfter(b.id, 'p')}
            onEditAfter={() => editAfter(b.id)}
            canPaste={!!clip}
            /** 菜单里的「粘贴」：把剪贴板里那**一组**块插到本块后面。
             *  读的是同一个 store，所以刚按完 Ctrl+C 再来点这里，粘的就是刚才那些块。 */
            onPaste={() => {
              const c = readClip()
              if (!c) return
              insertBlocksAfter(b.id, c.blocks)
            }}
            onCardWidth={(m) => useStore.getState().toast(
              m === 'screen' ? '已进入卡片全屏编辑（演示）' : '已设为全宽展示', 'info')}
            onInsert={(type) => insertAfter(b.id, type)}
            onConvert={(type) => convert(b.id, type)}
            onDelete={() => removeBlock(b.id)}
            onMoveUp={() => move(b.id, -1)}
            onMoveDown={() => move(b.id, 1)}
            onToggleTodo={() => update(b.id, { checked: !b.checked })}
            /* 卡片自己管自己的编辑，这里只负责把补丁合并回 block.data */
            onCardData={(patch) => patchCardData(b.id, patch)}
            onDragStart={() => setDragId(b.id)}
            onDragOver={() => setOverId(b.id)}
            onDrop={() => handleDrop(i)}
            selected={selSet.has(b.id)}
            selectMode={inSelectMode}
            onToggleSelect={(e) => toggleSelect(e, b.id)}
          />
          </Fragment>
        ))}
      </div>

      {/* "@" 唤起面板 */}
      {mention && (
        <MentionMenu
          x={mention.x}
          y={mention.y}
          q={mention.q}
          members={members}
          docs={mentionableDocs}
          onClose={() => setMention(null)}
          onPick={(v) => {
            const label = 'name' in v ? v.name : v.title
            const el = rootRef.current?.querySelector<HTMLElement>(`[data-block-id="${mention.id}"] .yq-block-text`)
            if (el) {
              const t = el.innerText
              const caret = caretOffset(el)
              const next = t.slice(0, caret).replace(/@[\w\u4e00-\u9fa5]*$/, `@${label} `) + t.slice(caret)
              el.innerText = next
              /**
               * text 和 html 必须一起回写。
               * 只写 text 的话，store 里的 html 还是旧的，
               * 下面那个同步 DOM 的 effect 会拿旧 html 把刚插进去的内容覆盖回去。
               */
              const nextHtml = el.innerHTML
              blockMap.current.set(mention.id, { ...blockMap.current.get(mention.id)!, text: next, html: nextHtml })
              const nb = blocks.map((b) => (b.id === mention.id ? { ...b, text: next, html: nextHtml } : b))
              flushSync(() => onChange(nb))
              focusBlock(mention.id)
            }
            setMention(null)
          }}
        />
      )}

      {/* 批量操作条（语雀）：选中若干块后浮在底部 */}
      {inSelectMode && !readOnly && (
        <div className="yq-bulkbar" contentEditable={false} data-selected={sel.length}>
          <span className="yq-bulkbar-count">已选 {sel.length} 块</span>
          <Dropdown
            align="left"
            width={160}
            trigger={(open, toggle) => <button className="yq-bulkbar-btn" onClick={toggle}>转为 ▾</button>}
          >
            {(close) => (
              <>
                {(['h1', 'h2', 'p', 'ul', 'ol', 'todo', 'quote', 'code'] as Block['type'][]).map((t) => (
                  <MenuItem key={t} onClick={() => { convertSelected(t); close() }}>
                    转为{BLOCK_META[t]?.label || t}
                  </MenuItem>
                ))}
              </>
            )}
          </Dropdown>
          <button className="yq-bulkbar-btn" onClick={clearSel}>取消选择</button>
          <button className="yq-bulkbar-btn is-danger" onClick={deleteSelected}>删除</button>
        </div>
      )}

      {/* "/" 斜杠菜单 —— 格式 + 40+ 特色卡片 */}
      {slash ? <SlashMenu x={slash.x} y={slash.y} q={slash.q} recent={recentCards}
        onPick={(c) => {
          // 格式类：直接把当前块转成对应类型
          // 卡片类：交给上层插入（图片/表格/画板等需要独立编辑器）
          if (c.kind === 'format' && c.blockType) {
            const t = c.blockType
            /* ⚠️ 分割线要**单独走一条**：它没有 contentEditable 区域
               （下面那行 `!isDivider && ...` 把 `.yq-block-text` 整个排除了），
               唯一的交互是「点击删除」。所以原来那句 `focusBlock(slash.id)`
               必然落空 —— 焦点丢到 BODY，用户**插完分割线就写不下去了**，
               界面上没有任何提示（实测：块数不增加、activeElement 是 BODY）。

               语雀 / Notion 的做法是：转成分割线之后**在下面补一个空段落并聚焦**。
               这里复用现成的 `insertAfter`，它已经带了 flushSync —— 必须同步提交，
               否则 DOM 里还没渲染出新块，focusBlock 找不到东西（下面 onEnter 那段
               注释记的同一个坑）。 */
            if (t === 'divider') {
              /* ⚠️ 必须**一次算完**最终数组，不能「先转换、再调 insertAfter」。
                 第一版那么写的，结果分割线自己消失了：`insertAfter` 闭包里的
                 `blocks` 是**转换前**那一份，它 `next.splice` 之后
                 `onChange(next)` 把转换结果整个覆盖掉了 —— 界面上看不到任何报错，
                 只是「插完分割线，下面出来一个空段落，线没了」。
                 这是本项目反复吃过的「两次写同一处、后者拿着旧快照」那类坑。 */
              const i = blocks.findIndex((b) => b.id === slash.id)
              const nb: Block = {
                id: `bk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
                type: 'p',
                text: '',
                html: '',
              }
              const next = [...blocks]
              next[i] = { ...next[i], type: t, text: '', html: '' }
              next.splice(i + 1, 0, nb)
              // flushSync：异步渲染会让下面那次 focusBlock 找不到还没挂载的新块
              flushSync(() => onChange(next, nb.id))
              setActive(nb.id)
              focusBlock(nb.id)
              closeSlash()
              return
            }
            const next = blocks.map((b) =>
              b.id === slash.id
                ? { ...b, type: t, text: '', html: '', ...(t === 'code' ? { lang: 'javascript' } : {}) }
                : b,
            )
            flushSync(() => onChange(next))
            setActive(slash.id)
            focusBlock(slash.id)
            closeSlash()
            return
          }
          /**
           * 清掉触发用的 "/"，避免残留在正文里。
           * text 和 html 必须一起清空：BlockRow 同步 DOM 时优先用 html，
           * 只清 text 的话，那几个字会从 html 里原样长回来
           *（斜杠菜单的查询词整个就是块里的全部内容，所以直接清空即可）。
           */
          const cleared = blocks.map((b) =>
            b.id === slash.id ? { ...b, text: '', html: '' } : b)
          flushSync(() => onChange(cleared))
          closeSlash()
          markRecent(c.id)
          onInsertCard?.(c.id)
        }}
        onClose={closeSlash}
      /> : null}

      {/* 末尾继续输入区 */}
      {!readOnly && (
        <div
          className="yq-editor-tail"
          onClick={() => {
            const last = blocks[blocks.length - 1]
            /*
             * ⚠️「新建文档后随手写点东西，结果全写进了标题」——
             *   2026-10-10 用户在页面上实测报上来的（输入 SSSSSS，标题跟着变）。
             *
             * 新建一篇文档只有**一个**块：空的 H1，而它就是文档标题本身
             * （见 store 的 `applyDerivedTitle`：标题 = 第一个 H1）。
             * 所以「末尾是空块就把光标送过去」这条规则，在新建文档上
             * 等价于「点正文那片空白 → 光标跳回标题」——
             * 正文一个字没写，标题先被改了。
             *
             * 语雀那边标题下面**本来就有正文行**，点空白处进的是正文。
             * 我们没有正文块可进，就改成「就地补一个正文段落再把光标放进去」——
             * `insertAfter` 内部已经做了 `flushSync + focusBlock`，光标不会丢。
             *
             * ⚠️ 条件必须是 `blocks.length === 1`：
             *   放宽成「首个块是空 H1」的话，一篇已经有正文的文档
             *   点末尾空白会被硬塞进一个新段落，末尾那个正文块反而进不去。
             */
            const titleOnly = blocks.length === 1 && last?.type === 'h1' && !last.text
            /*
             * ⚠️ 判据是「最后一块**是不是可编辑的**」，不是「它有没有文字」。
             * 图片 / 表格 / 卡片 / 代码块的 text 本来就是空的 ——
             * 用「没有文字」判，会把它们当成「可以进去的空块」，
             * 而它们**压根没有可编辑元素**，于是
             *   既进不去光标，**也不会新建一行**（2026-10-19 用户报）。
             */
            if (last && TEXT_BLOCK_TYPES.has(last.type) && !last.text && !titleOnly) {
              /*
               * 用共用的 `focusBlock`，别再自己 querySelector 一遍。
               *
               * ⚠️ 破坏对照实测出来的：原来这里取的是 `[data-block-id]`，
               *   那是**块的包装 div**，不是里面那个 `contenteditable` 的
               *   `.yq-block-text`。`el.focus()` 对一个不可编辑的包装层
               *   什么也没做，`placeCaretEnd(el)` 也只是把选区放了个空处 ——
               *   于是「点末尾空白处」**压根放不下光标**，敲什么都没反应。
               *   （测试里那条「标题没被改」当时是**假绿**：
               *   字一个都没打进去，当然改不了标题。）
               */
              focusBlock(last.id)
            } else {
              insertAfter(blocks[blocks.length - 1].id, 'p')
            }
          }}
        />
      )}
    </div>
  )
}

const HEADING: Block['type'][] = ['h1', 'h2', 'h3', 'h4']

/* ============================================================
   单个块
   ============================================================ */

interface RowProps {
  block: Block
  index: number
  active: boolean
  readOnly?: boolean
  dragging?: boolean
  overTarget?: boolean
  members: { id: string; name: string; avatar: string }[]
  onFocus: () => void
  onBlur: () => void
  onText: (t: string, html: string) => void
  /** 粘贴多行：在当前块之后插入这一批块 */
  onPasteBlocks: (blocks: Block[]) => void
  /**
   * **替换**：把选区压到的那些块换成新块。
   * 有选区时粘贴走这条路；没给就退回复制（宁可追加也别静默丢内容）。
   */
  onReplaceBlocks?: (removeIds: string[], incoming: Block[]) => void
  /** 处于「多选块」状态（勾选框选中了若干块）—— 粘贴要替换那些块 */
  hasMultiSel?: boolean
  onEnter: (e: ReactKeyboardEvent<HTMLDivElement>, el: HTMLDivElement) => void
  onBackspace: (e: ReactKeyboardEvent<HTMLDivElement>, el: HTMLDivElement) => void
  onTab: (e: ReactKeyboardEvent<HTMLDivElement>) => void
  onSlashMenu: (el: HTMLDivElement) => void
  onSlashClose: () => void
  onMention: (el: HTMLDivElement, q: string, x: number, y: number) => void
  onMentionClose: () => void
  onDuplicateBlock: () => void
  /** 菜单里的「复制内容」：走和 Ctrl+C 同一个函数，两个入口只留一份实现 */
  onCopyBlock: () => void
  /** 菜单里的「复制图片」：把图片二进制写进剪贴板（只有图片块有） */
  onCopyImage?: () => void
  /**
   * 「在图片后面继续编辑文字」：**同行**尾巴文字的输入。
   * 走**独立的**更新通道 —— 不能走 onText：
   * 那个通道带「markdown 快捷输入 → 把块换成别的类型」，
   * 在图片的尾巴上敲个「# 」就会把**图片**变成标题块。
   */
  onImageText?: (t: string) => void
  /** 图片的尾巴文字里按回车 → 在图片**下面**新建一段 */
  onImageEnter?: () => void
  /**
   * 「在图片后面编辑」：点图片**下面**那一行（文件名 / 留白）时，
   * 把光标送到紧挨着的下一段文字里。
   */
  onEditAfter?: () => void
  /** 剪贴板里有东西（且没过 TTL）。由父组件订阅后传进来 —— 不能在渲染那一刻现读 */
  canPaste: boolean
  /** 菜单里的「粘贴」；剪贴板空时那项是置灰的，点不到 */
  onPaste?: () => void
  onCardWidth: (mode: 'normal' | 'full' | 'screen') => void
  onInsert: (type: Block['type']) => void
  onConvert: (type: Block['type']) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onToggleTodo: () => void
  /** 卡片块的数据补丁（浅合并进 block.data） */
  onCardData: (patch: Record<string, any>) => void
  onDragStart: () => void
  onDragOver: () => void
  onDrop: () => void
  /** 多选：本块是否在选区里（决定左侧出现选择框、块底色高亮） */
  selected?: boolean
  /** 多选模式下本块是否被禁用（只读或已退出多选时为 false） */
  selectMode?: boolean
  onToggleSelect: (e: React.MouseEvent<HTMLDivElement>) => void
}

const BlockRow = memo(function BlockRow(p: RowProps) {
  const { block } = p
  const lastEmitted = useRef(block.text)
  const lastEmittedHtml = useRef(block.html || '')
  const inited = useRef(false)
  const elRef = useRef<HTMLDivElement | null>(null)

  /*
   * 菜单的打开态与右键坐标 —— **两件事必须分开存**。
   *
   * 第一版只留 `ctxAt` 并用它推导 `open={ctxAt !== null}`，结果 ··· 按钮彻底点不动：
   * toggle 报「我要开」，而 open 只由 ctxAt 决定，ctxAt 只有右键才会被设。
   * 反过来若把 open 无条件交给 ctxAt，按钮那条路又会坏 —— Popover 在 document 上
   * 监听 `mousedown` 来关闭自己，而 ··· 按钮在 `.yq-popover-wrap` 里、
   * `ref.current.contains(target)` 为真，这次 mousedown 不关它；可紧接着的 click
   * 把 toggle 打上，同一个 open 先「保持」再「切反」，净效果是**点一下没反应**。
   * （那个按钮原来能点开，只是因为当时 open 是 Popover 的内部 state，关闭逻辑碰不到它。）
   *
   * 现在：右键 → open=true + anchor=鼠标位置；按钮 → open=true + anchor=null（原定位）。
   */
  const [menuOpen, setMenuOpen] = useState(false)
  const [ctxAt, setCtxAt] = useState<{ x: number; y: number } | null>(null)
  const closeMenu = () => { setMenuOpen(false); setCtxAt(null) }

  /*
   * 为什么要右键：块级菜单原本只挂在 `···` 按钮上，而 `Tree.tsx:11` /
   * 本文件 247 行 / README 1646 三处都写着「右键菜单」—— 三个字都承诺了，
   * `onContextMenu` 却在整个 src 里 0 匹配。现在右键和按钮走**同一个 Dropdown**
   * （同一份 children、同一批 action），不可能再出现「两边菜单内容不一样」的分叉。
   */

  /**
   * contentEditable 的 div 不会渲染 children —— React 只在挂载时给一个空 div。
   * 必须在 ref 的 commit 阶段同步写入一次初值，否则首屏所有块都是空白。
   * 之后内容变化才走下面的 useEffect，且只在「非自身输入」时回写，避免打断光标。
   */
  const attachText = (el: HTMLDivElement | null) => {
    elRef.current = el
    if (el && !inited.current) {
      inited.current = true
      // 优先恢复富文本 HTML；老数据没有 html 时回落到纯文本
      if (block.html) {
        el.innerHTML = block.html
      } else if (el.innerText !== block.text) {
        el.innerText = block.text
      }
      lastEmitted.current = block.text
      lastEmittedHtml.current = block.html || ''
    }
  }

  /**
   * props 外部变更时同步 DOM（自身输入不回写，避免打断光标）。
   *
   * 依赖里必须带 block.html：只比 text 的话，
   * 「文本没变、只是被加了粗」（协同远端改格式、或别处 execCommand）
   * 这条路径根本不会触发，DOM 会一直停在旧内容——
   * store 里明明是对的，界面上却看不到格式。
   */
  useEffect(() => {
    const el = elRef.current
    if (!el) return
    // 本地刚输入的：lastEmitted 已同步，直接跳过，不会打断光标
    if (lastEmitted.current === block.text && lastEmittedHtml.current === (block.html || '')) return

    lastEmitted.current = block.text
    lastEmittedHtml.current = block.html || ''

    const want = block.html ?? escapeHtml(block.text)
    if (el.innerHTML !== want) {
      el.innerHTML = want
      // 本地正在这个块里编辑时（类型转换等），把光标放回末尾
      if (document.activeElement === el) placeCaretEnd(el)
    }
  }, [block.text, block.html])

  const handleInput = (e: React.FormEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    // innerText 在中文输入法下会带不换行空格（\xa0），统一成普通空格再存
    const t = el.innerText.replace(/\u00a0/g, ' ')
    const html = el.innerHTML
    lastEmitted.current = t
    lastEmittedHtml.current = html
    p.onText(t, html)

    // "/" 快捷菜单：在 onInput 判定而非 keydown，
    // 这样新块刚拿到焦点时立即输入也能稳定触发，不依赖焦点时序。
    //
    /* ⚠️ 这里原来写的是 `/^\/\S*$/` —— `\S` 是「非空白」，于是正文里**一有空格
       整个菜单就被关掉**。实测（在部署实例上逐个输入量命中）：
         「正文 」→ 菜单没了   「正文 x」→ 菜单没了   「本 地」→ 菜单没了
         「标题 1」→ 菜单没了（菜单上明明写着这一项，照着打却打不出来）
       卡片目录里 4 个名字带空格（标题 1~4），**照原样输入一个都选不中**。

       而菜单本身的过滤（`matchCards`）早就把空白规范化掉了，中间的空格完全能搜；
       60ms 那个轮询用的也是 `!t.startsWith('/')` —— **两处判据本来就不一致**，
       轮询从来没在管这件事。判据统一成「以 / 开头」，与轮询、与 matchCards 一致。 */
    if (t.startsWith('/')) {
      p.onSlashMenu(el)
    } else {
      p.onSlashClose()
    }
    // 「@」唤起：光标前是 @ 或 @+关键词
    const caret = caretOffset(el)
    const before = t.slice(0, caret)
    const m = before.match(/@([\w\u4e00-\u9fa5]*)$/)
    if (m) {
      const r = el.getBoundingClientRect()
      p.onMention(el, m[1], r.left, r.bottom + 2)
    } else {
      p.onMentionClose()
    }
  }

  /**
   * 粘贴进来的块该**放哪**。
   *
   * 2026-10-19 用户报：「选择粘贴还是会粘贴到下一行」——
   * 选中一段字按 Ctrl+V，内容跑到下面去了，原来选中的还在。
   *
   * 根因：所有「造块」的路径都调 `onPasteBlocks(...)`，
   * 而那个函数是「在当前块**之后**插一批新块」——
   * **从头到尾没看选区**。单行纯文本那条走 `execCommand('insertText')`，
   * 那个命令天然会替换选区 —— 于是「粘单词正常、粘多行跑偏」，
   * 看着像两套逻辑各说各话。
   *
   * 规则（编辑器通用）：
   *   · **有选区** → 替换掉被选中的那些块
   *   · **无选区** → 在当前块之后追加（原来的行为）
   */
  const pasteBlocksHere = (incoming: Block[]) => {
    if (!incoming.length) return
    /*
     * 两种「选择」都要管：
     *   ① **多选块**（勾选框 / ⌘点 / ⇧连选）—— 粘到被勾选的块上
     *   ② **文本选区** —— 粘到选区压到的块上
     * 以前两种都是「在当前块之后追加」，于是用户说「粘到下一行」。
     */
    if (p.hasMultiSel) {
      if (p.onReplaceBlocks) { p.onReplaceBlocks([], incoming); return }
    }
    const s = window.getSelection()
    const hasSel = !!(s && !s.isCollapsed && s.rangeCount && s.toString().trim())
    if (hasSel && s.rangeCount) {
      // 选区压到了哪些块 —— 用 Range.intersectsNode 逐块问，
      // 别用「选区起止落在哪个块」那种近似（选区跨块时会漏）。
      const range = s.getRangeAt(0)
      const touched: string[] = []
      document.querySelectorAll('.yq-block[data-block-id]').forEach((b) => {
        const t = b.querySelector('[contenteditable]') as HTMLElement | null
        if (!t || !range.intersectsNode(t)) return
        const id = b.getAttribute('data-block-id')
        if (id) touched.push(id)
      })
      if (touched.length) {
        if (p.onReplaceBlocks) { p.onReplaceBlocks(touched, incoming); return }
        // 没给替换通道就退回复制（宁可追加也不要静默丢掉选中的内容）
      }
    }
    p.onPasteBlocks(incoming)
  }

  /**
   * 粘贴一张图片：走 `attachFileToDoc` 上传，再插一个**图片块**。
   *
   * 刻意复用 `ImageBlock` 那条上传通道（`force: true`）：
   *   · 服务端形态 → 二进制进 SQLite，key 是附件 id；
   *   · 本地形态 → IndexedDB；
   *   · 上传失败还会降级成 data URL。
   * 三条路都在那一个函数里收口，这里**不另开一条** ——
   * 另开一条的结果就是「上传一张图」有两种行为，而只有一种有人测过。
   *
   * `src` 留空、`data.key` 指路 —— 和图片块自己上传时一模一样，
   * 所以本地上传出来的图和粘贴进来的图，在存储上**没有区别**。
   */
  const pasteImage = async (file: File) => {
    const toast = (m: string, k?: 'success' | 'error' | 'info') => useStore.getState().toast(m, k)
    const patch = await attachFileToDoc(file, true)
    if (!patch.key && !patch.dataUrl) {
      toast(patch.error || '图片粘贴失败', 'error')
      return
    }
    pasteBlocksHere([{
      id: `bk_img${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      type: 'image',
      text: '',
      data: { key: patch.key, dataUrl: patch.dataUrl, name: patch.name, size: patch.size },
    }])
    if (patch.degraded) toast(`图片已降级保存：${patch.degraded}`, 'info')
  }

  /**
   * 粘贴。
   *
   * 语雀最有辨识度的交互之一：**粘一段 Markdown 源码进来，自动变成块**
   * （标题 / 列表 / 待办 / 代码 / 表格 / 图片），而不是一坨带符号的纯文本。
   *
   * 之前这里只处理「第一行插进当前块、其余行丢掉」—— 循环里还有个 `break`，
   * 粘 5 行只剩 1 行。既是数据丢失，也丢掉了这个招牌交互。
   */
  const handlePaste = (e: ClipboardEvent<HTMLDivElement>) => {
    /*
     * ① **剪贴板里的图片**先判（2026-10-18 补）。
     *
     * 之前这里第一句就是 `getData('text/plain')`，于是：
     *   · 截图 Ctrl+V —— `text/plain` 是**空串**，整个分支等于什么都没做，
     *     用户看到的是「按了没反应」，而控制台一句错都没有；
     *   · 从别的应用复制一张图 —— 同上。
     *
     * 也就是说「粘贴图片」这条路径**从来没通过**。
     * 而图片块本身早就能收文件了（`ImageBlock.upload` → `attachFileToDoc`），
     * 只是**剪贴板里的东西从来没被送到它手上** —— 又是一处「两端都有、中间没连线」。
     *
     * ⚠️ 必须放在读 text 之前：截图粘贴时剪贴板里**同时**有 image 和一个空 text，
     *    谁先谁后就决定了「粘图片」还是「什么都不发生」。
     */
    for (const item of Array.from(e.clipboardData?.items || [])) {
      if (!item.type || !item.type.startsWith('image/')) continue
      const file = item.getAsFile()
      if (!file) continue
      e.preventDefault()
      pasteImage(file)
      return
    }

    /*
     * 自家剪贴板（Ctrl+C 写进去的块结构）—— 必须排在**文本分支之前**。
     *
     * 为什么不能只看 `text/plain`：那一路会把代码块降级成段落、
     * 表格降级成一行管道符、卡片降级成空壳 —— 看着「粘上了」，
     * 结构却全丢了，而且**没有任何提示**。
     *
     * 排第二（图片之后）是有意的：截图粘贴时剪贴板里同时有 image 和
     * 我们上次复制的东西，谁先谁后决定「粘图片」还是「粘上次那个块」。
     */
    const copied = readCopiedBlocks(e.clipboardData)
    if (copied && copied.length) {
      e.preventDefault()
      const stamp = Date.now().toString(36)
      pasteBlocksHere(
        copied.map((c, i) => ({
          id: `bk_c${stamp}${i}${Math.random().toString(36).slice(2, 6)}`,
          type: c.type as Block['type'],
          text: c.text || '',
          ...(c.data ? { data: JSON.parse(JSON.stringify(c.data)) } : {}),
        })),
      )
      return
    }

    const text = e.clipboardData.getData('text/plain')

    /*
     * 多选块：**优先于**单行分支。
     *
     * 实测踩到过：多选了两个块，粘一段单行文字，结果文字被塞进了
     * 光标所在的那一块（`丙块` 变成「# 换掉的标题丙块」）——
     * 因为单行走的是 `insertText` 那条路，压根没经过 `pasteBlocksHere`，
     * 多选状态自然被无视了。
     * ⇒ 「有没有在多选」要判在**所有**分支之前。
     */
    if (p.hasMultiSel) {
      e.preventDefault()
      const incoming = looksLikeMarkdown(text)
        ? markdownToBlocks(text)
        : [{ id: `bk_p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, type: 'p' as Block['type'], text: text.trim() }]
      pasteBlocksHere(incoming)
      return
    }

    /*
     * 单行：按普通文本插入。
     *
     * `insertText` 会**替换当前选区** —— 所以「选中两个字粘一个词」是就地替换的，
     * 这一条一直是对的。
     */
    if (!text.includes('\n')) {
      e.preventDefault()
      document.execCommand('insertText', false, text)
      lastEmitted.current = elRef.current?.innerText ?? text
      p.onText(lastEmitted.current, elRef.current?.innerHTML ?? '')
      return
    }

    // 像 Markdown 才转块；否则按纯文本逐行拆成多个正文块，不能丢内容
    if (looksLikeMarkdown(text)) {
      e.preventDefault()
      pasteBlocksHere(markdownToBlocks(text))
      return
    }

    e.preventDefault()
    const paras = text.split(/\n{2,}/).map((s) => s.replace(/\n/g, ' ')).filter((s) => s.trim())
    const blocks: Block[] = paras.map((s) => ({ id: `bk_p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, type: 'p', text: s.trim() }))
    pasteBlocksHere(blocks)
  }

  const isDivider = block.type === 'divider'
  const isCode = block.type === 'code'
  const isTodo = block.type === 'todo'
  const isImage = block.type === 'image'
  const isTable = block.type === 'table'
  const isCard = block.type === 'card'

  /**
   * 这些块**进不去光标**（没有 .yq-block-text）—— 图片 / 表格 / 卡片 / 分割线。
   *
   * 它们也得能被键盘接管：点一下 → 焦点落在块容器上（tabIndex=-1，不进 Tab 顺序）→
   * 按 ↓ 或 Enter 就能落到下面那段文字（见 Editor 里那段「块间移动」的处理）。
   *
   * 2026-10-20 实测：修之前点中图片后 `document.activeElement` 是 BODY，
   * 按 Enter / ↓ **什么都不会发生** —— 鼠标能过去、键盘过不去。
   */
  const focusable = isImage || isTable || isCard || isDivider

  /**
   * 卡片块本身是 draggable（要能拖动排序），但整块也带着 draggable，
   * 于是「在卡片里的按钮/输入框上按下鼠标」会被浏览器当成拖拽整块：
   * 拖拽一旦启动，pointermove/pointerup 就被浏览器吞掉不派发 ——
   * 表现是流程图拖不动、连线拉不上，卡片里的文字也选不中。
   * 所以记住鼠标是在哪儿按下的，在 dragstart 里把「从卡片里发起的拖拽」取消掉。
   */
  const dragFromInside = useRef(false)

  const cls = [
    'yq-block', `yq-block-${block.type}`,
    p.active ? 'is-active' : '',
    p.dragging ? 'is-dragging' : '',
    p.overTarget ? 'is-over' : '',
    p.selected ? 'is-selected' : '',
    p.selectMode ? 'is-selecting' : '',
  ].filter(Boolean).join(' ')

  return (
    <div
      className={cls}
      data-block-id={block.id}
      draggable={!p.readOnly && !isDivider}
      /* 进不去光标的块也要能被键盘接管（见上面 focusable 的注释） */
      tabIndex={focusable && !p.readOnly ? -1 : undefined}
      onContextMenu={(e) => {
        /*
         * 右键弹块级菜单（语雀行为）。
         *
         * 两条必须做对，否则会出「菜单点了没反应 / 关不掉」这类怪问题：
         * ① preventDefault —— 不拦的话浏览器原生菜单会盖在上面；
         * ② 在 contentEditable 里右键，浏览器**默认就会把光标挪过去**，
         *    这正是我们要的（不然菜单里的「复制内容」复制的是别的块）。
         *    但只读态不拦：只读文档右键就该给浏览器原生菜单（能复制、能检查）。
         */
        if (p.readOnly) return
        /*
         * 图片上**不拦**原生右键菜单。
         *
         * 浏览器自带的「复制图片」「在新标签页打开图片」是**我们自己给不出来的** ——
         * 前者要把图片二进制写进剪贴板，而那需要**安全上下文**（https），
         * 内网 HTTP 部署下压根没有那个 API。
         * 于是拦掉它 = 把用户**唯一能复制图片的路**也堵了
         * （2026-10-19 用户报「编辑界面的图片不能复制」）。
         *
         * 块的菜单仍然在 `···` 那里，两条路不冲突。
         */
        if (isImage && (e.target as HTMLElement).closest?.('img')) return
        e.preventDefault()
        setCtxAt({ x: e.clientX, y: e.clientY })
        setMenuOpen(true)
      }}
      onMouseDown={(e) => {
        dragFromInside.current = !!(e.target as HTMLElement).closest?.('.yq-kc-host')
        /*
         * 多选的三种手势（语雀）：
         *   · 点左侧勾选框 → 开关这一块
         *   · ⌘/Ctrl 点块   → 逐个加/减
         *   · ⇧ 点块        → 从 anchor 连选一段
         * 都在**按下时**判定而不是 click：多选态下内容区还要能正常拖文本选区，
         * 用 click 的话浏览器会先把文本选中，块就选不中了。
         */
        if (p.readOnly) return
        const t = e.target as HTMLElement
        if (t.closest?.('.yq-block-selectbox') || e.metaKey || e.ctrlKey || (e.shiftKey && p.selectMode)) {
          e.preventDefault()
          p.onToggleSelect(e)
          return
        }
        /*
         * 点「进不去光标」的块（图片/表格/卡片/分割线）→ 焦点落在块容器上，
         * 这样按 ↓/Enter 才能落到下面那段文字。
         * ⚠️ 不 preventDefault —— 块是 draggable 的，拦了会把拖拽排序也一起拦掉。
         */
        if (focusable && !t.closest?.('button, input, textarea, select, a, [contenteditable]')) {
          /*
           * 点在**图片本身**上 → 焦点落在块容器（工具条要能显形、键盘要能接管）。
           * 点在图片**下面**那一行（文件名 / 留白）→ 那块地方**属于图片块**，
           * 光标进不去 —— 而用户点它就是想「在图片后面写字」。
           */
          if (t.closest?.('img')) {
            p.onFocus()
            ;(e.currentTarget as HTMLElement).focus({ preventScroll: true })
          } else {            /*
             * ⚠️ 必须 preventDefault —— 否则浏览器**默认的 mousedown 行为**
             * 会把焦点落到最近的可聚焦祖先（就是图片块容器），
             * **把我刚挪过去的光标又抢回去**（实测：点完光标还在图片块上）。
             */
            e.preventDefault()
            p.onEditAfter?.()
          }
        }
      }}
      onDragStart={(e) => {
        if (dragFromInside.current) {
          // 在卡片控件区按下 → 不当拖拽处理，浏览器会正常派发后续 pointer 事件
          e.preventDefault()
          dragFromInside.current = false
          return
        }
        p.onDragStart()
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => p.onDrop()}
      onDragOver={(e) => {
        e.preventDefault()
        p.onDragOver()
      }}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        p.onDrop()
      }}
      onClick={(e) => {
        /*
         * 点图片 → 光标进图片**右边**那段（语雀的形态：图片后面紧跟着文字）。
         *
         * ⚠️ 放在 **click** 而不是 mousedown：
         *   mousedown 的默认行为会把焦点落到块容器（tabIndex=-1），
         *   **抢走我们挪过去的光标**；
         *   而放在 click 里做，**拖拽排序**不受影响 —— 拖完不会有 click 事件。
         */
        const t = e.target as HTMLElement
        if (!t.closest?.('img')) return
        const tail = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('.yq-img-text')
        if (!tail) return
        tail.focus({ preventScroll: true })
        placeCaretEnd(tail)
      }}
    >
      {/* 多选勾选框：只在「已有多选」或「处于多选态」时出现。
          纯靠 hover 出现的做法在触屏上根本点不到 —— 所以用「有选中或处于多选态」触发。 */}
      {!p.readOnly && (p.selectMode || p.selected) && (
        <button
          type="button"
          className={`yq-block-selectbox ${p.selected ? 'is-on' : ''}`}
          contentEditable={false}
          title={p.selected ? '取消选择' : '选择这一块'}
          aria-pressed={!!p.selected}
          /*
           * 真正干活的是父 div 的 onMouseDown（mousedown 早于 click，
           * 浏览器不会先把文本选中）。但 lint 有一条「button 必须有 handler」
           * 的规则 —— 挂空 handler 会被判成「点了没反应」。
           * 所以这里给个**幂等**的 onClick：mousedown 已经改过状态，
           * 这次 click 再切一次会把它切回去。所以干脆什么都不做，
           * 只用 type="button" 表明语义。
           */
          onClick={(e) => e.stopPropagation()}
        />
      )}
      {/* 左侧操作条 */}
      {!p.readOnly && (
        <div className="yq-block-gutter">
          <button className="yq-block-add" title="插入块" onClick={() => p.onInsert('p')}>
            +
          </button>
          {/*
            这里原来有一个 `<button className="yq-block-grip" title="块类型">⋮⋮</button>`，
            没有 onClick、连 CSS 规则都没有（`.yq-block-grip` 全项目只出现这一次）。
            问题是它长得**就像拖拽手柄**、title 又写着「块类型」：
            用户会去拖它、也会去点它，两件事都不会发生。
            而块本身早就是 draggable 的（外层 div 上有 draggable），
            拖整块本来就能拖，所以这个假手柄纯属添乱 —— 删掉。
          */}
          <div className="yq-block-type-menu" title="块类型">
            {/* 这个把手是补上的：面板只认 `:hover .yq-block-type-menu`，
                而那个容器此前是 0×0，hover 永远不成立（Editor.css 里记了实测）。
                就算把命中区修好了，没有一个看得见的东西提示「这里能换类型」，
                用户照样不知道 —— 打得开和找得到是两回事。

                ⚠️ 这里**不要**加 contentEditable={false}。加过一次，
                test-paste 从 20/0 掉到 2/18：粘贴出来的块全变成了 h1、
                纯文本三段只留下一段。Chromium 把 contenteditable=false
                当成编辑边界，而这块就挨着 .yq-block-text。
                A/B 实测过：加上红 18 项，摘掉回 20/0。
                把手上的 pointer-events:none（见 Editor.css）已经够用了。 */}
            <span className="yq-block-type-trigger">{BLOCK_META[block.type]?.icon || '¶'}</span>
            <BlockTypeMenu block={block} onConvert={p.onConvert} members={p.members} />
          </div>
        </div>
      )}

      <div className="yq-block-main">
        {/* todo 复选框 */}
        {isTodo && (
          <button className={`yq-todo-box ${block.checked ? 'is-checked' : ''}`} onClick={p.onToggleTodo}>
            {block.checked && (
              <svg viewBox="0 0 12 12" width="10" height="10">
                <path d="M2 6.2 4.6 8.8 10 3.4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
        )}

        {/* 有序列表编号 */}
        {block.type === 'ol' && <span className="yq-ol-marker" data-ord={p.index} />}

        {/* 分割线 */}
        {isDivider && (
          <div className="yq-divider" onClick={() => p.onDelete()} title="点击删除">
            <hr />
          </div>
        )}

        {/* 图片 */}
        {isImage && (
          <ImageBlock
            block={block}
            onChange={(t) => p.onText(block.text, '')}
            onData={p.onCardData}
            readOnly={p.readOnly}
            onCopyImage={() => p.onCopyImage?.()}
            onTailText={p.onImageText}
            onTailEnter={p.onImageEnter}
            onTailFocus={p.onFocus}
          />
        )}

        {/* 表格 */}
        {isTable && (
          /* 语雀：悬浮卡片时左上角出现卡片自身工具条（复制/删除），
             卡片上方出现「全宽展示」「全屏」菜单 */
          <div className="yq-card-wrap">
            {!p.readOnly && (
              <div className="yq-card-toolbar" contentEditable={false}>
                <button onClick={p.onDuplicateBlock} title="复制卡片">⧉</button>
                <button onClick={p.onDelete} title="删除卡片">🗑</button>
                <span className="yq-flex-1" />
                <button
                  className={p.active ? 'is-on' : ''}
                  onClick={() => p.onCardWidth('full')}
                  title="全宽展示"
                >
                  ⇔
                </button>
                <button onClick={() => p.onCardWidth('screen')} title="全屏">⛶</button>
              </div>
            )}
            {/* ⚠️ 第二个参数是**新的** text，不是 `block.text`。
               照抄 ImageBlock 那行会写回旧值 —— 症状是「单元格改了、刷新就没」，
               而界面上看不出任何异常（实测 block.text 始终是 ""）。 */}
            <TableBlock block={block} readOnly={p.readOnly} onChange={(t) => p.onText(t, '')} />
          </div>
        )}

        {/* 代码块 */}
        {isCode && (
          <>
            <div className="yq-code-lang">
              <select
                value={block.lang || 'javascript'}
                onChange={(e) => p.onText(block.text, '')}
                disabled={p.readOnly}
              >
                {['javascript', 'typescript', 'python', 'go', 'java', 'sql', 'bash', 'json', 'text', 'html', 'css'].map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <div
              ref={attachText}
              className="yq-code-body"
              contentEditable={!p.readOnly}
              suppressContentEditableWarning
              spellCheck={false}
              onInput={handleInput}
              onFocus={p.onFocus}
              onKeyDown={(e) => {
                if (e.key === 'Tab') e.preventDefault()
              }}
            />
          </>
        )}

        {/* 特色卡片块：本身不是 contentEditable，内部各组件自己管自己的编辑 */}
        {isCard && (
          <CardHost
            cardId={block.data?.cardId || ''}
            data={block.data}
            readOnly={p.readOnly}
            onChange={(patch) => p.onCardData(patch)}
          />
        )}

        {/* 普通块 */}
        {!isDivider && !isCode && !isImage && !isTable && !isCard && (
          <div
            ref={attachText}
            className="yq-block-text"
            contentEditable={!p.readOnly}
            suppressContentEditableWarning
            spellCheck={false}
            /*
             * 首个 H1 是**文档标题**，不是正文，占位符不能说「输入 '/' 插入卡片」。
             *
             * 原来所有文本块共用这一句，于是新建文档时那一大片（它就是标题）
             * 顶着「输入 '/' 插入卡片」—— 谁看了都以为那是正文编辑区，
             * 于是敲进去的字全成了标题。和上面 tail 那条是同一个病根：
             * 「标题块」被当成了「普通正文块」对待。
             *
             * 标题块用「未命名」：和目录树、面包屑里那篇没标题的文档同一个词，
             * 免得同一页上出现两种说法。
             */
            data-placeholder={p.index === 0 && block.type === 'h1' ? '未命名' : "输入 '/' 插入卡片"}
            onInput={handleInput}
            onFocus={p.onFocus}
            onBlur={p.onBlur}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              const el = e.currentTarget
              if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                p.onEnter(e, el)
                return
              }
              if (e.key === 'Backspace') {
                p.onBackspace(e, el)
                return
              }
              if (e.key === 'Tab') {
                p.onTab(e)
                return
              }
              /**
               * Home / End 自己处理。
               * 浏览器的默认行为是按「视觉行」跳，而块的 DOM 里可能有多个
               * inline 元素（富文本 <b>/<span>/<font>），文本散在多个 TextNode，
               * 结果 Home 只回到当前 inline 元素的行首，跳不到整块的开头。
               * 块编辑器里「一块就是一行」，所以直接按整块文本长度定位。
               */
              if (e.key === 'Home' && !e.metaKey && !e.ctrlKey) {
                e.preventDefault()
                setCaretInBlock(el, 0)
                return
              }
              if (e.key === 'End' && !e.metaKey && !e.ctrlKey) {
                e.preventDefault()
                setCaretInBlock(el, el.innerText.length)
                return
              }
            }}
          />
        )}

        {/* callout 表情 */}
        {block.type === 'callout' && (
          <span className="yq-callout-emoji" contentEditable={false}>
            {block.emoji || '💡'}
          </span>
        )}

        {/* 待办指派人 */}
        {isTodo && !p.readOnly && p.members.length > 0 && (
          <span className="yq-todo-assignee" contentEditable={false}>
            <span className="yq-todo-assignee-avatar">{block.assignee || '+'}</span>
          </span>
        )}

        {/* 块级菜单：··· 按钮与右键共用同一份菜单 */}
        {!p.readOnly && (
          <Dropdown
            align="right"
            width={180}
            anchor={ctxAt}
            open={menuOpen}
            onOpenChange={(v) => { if (v) setMenuOpen(true); else closeMenu() }}
            trigger={(open, toggle) => (
              <button
                className="yq-block-more"
                onClick={toggle}
                onMouseDown={(e) => {
                  /*
                   * ⚠️ 这行是右键实现里**最容易被漏掉的一半**。
                   * Popover 靠 document 上的 `mousedown` 判断「点了面板外面」并关闭自己。
                   * 而 ··· 按钮恰好**在** `.yq-popover-wrap` 里，`ref.current.contains(target)`
                   * 为真 —— 于是这次 mousedown 不会关它；可**紧接着**的 click 又把
                   * `toggle()` 打上，同一个 open 先「保持」再「切反」，净效果是**点一下没反应**。
                   * 之前那个按钮能点开，是因为它原先走的是非受控路径（open 是内部 state，
                   * 关闭监听根本碰不到它）。现在右键把 open 提到受控，这条路径就露馅了。
                   */
                  e.preventDefault()
                  e.stopPropagation()
                }}
                contentEditable={false}
              >
                ···
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuLabel>操作</MenuLabel>
                <MenuItem icon="↑" onClick={() => { p.onMoveUp(); close() }}>上移</MenuItem>
                <MenuItem icon="↓" onClick={() => { p.onMoveDown(); close() }}>下移</MenuItem>
                <MenuItem
                  icon="⧉"
                  onClick={() => {
                    /* 和 Ctrl+C 走**同一个** copyBlocks —— 两个入口两份实现是
                       「菜单里粘出来的东西和刚按的 Ctrl+C 不一样」的根源。 */
                    p.onCopyBlock()
                    close()
                  }}
                >
                  复制内容
                </MenuItem>
                {/*
                 * 「复制图片」只给图片块。
                 *
                 * 浏览器原生菜单那条路（右键图片 → 复制图片）我们**刻意不拦**了，
                 * 但原生菜单在触屏上根本够不着 —— 所以块菜单里也得有一条。
                 * 写图片二进制需要安全上下文，HTTP 下会自动退回复制地址并说明。
                 */}
                {isImage && p.onCopyImage && (
                  <MenuItem icon="🖼" onClick={() => { p.onCopyImage?.(); close() }}>
                    复制图片
                  </MenuItem>
                )}
                <MenuItem
                  icon="📋"
                  /*
                   * 文案就是「粘贴」，**不写「粘贴到下方」**。
                   * 落点由「你点的是哪个块的菜单」决定 —— 在 A 块的菜单里粘贴，
                   * 块就落在 A 后面，这是编辑器的默认行为，不必每次重申。
                   *
                   * 之前写成「粘贴到下方」是自己加的三个字，而且：
                   *   · 和旁边的「复制内容」不对称（它也没写「复制当前块」）；
                   *   · 只给一个方向，像在暗示「不能往上粘」——
                   *     真要区分就该成对给「粘贴到上方 / 粘贴到下方」，
                   *     那又占两个菜单位。这半吊子不如不加。
                   */
                  /* 没复制过就置灰，而不是把这一项藏起来 ——
                     「换个地方粘贴」是同一个动作，藏起来用户根本不知道有它。
                     置灰状态由父组件订阅剪贴板后传进来，不是渲染那一刻现读。 */
                  disabled={!p.canPaste}
                  onClick={() => {
                    p.onPaste?.()
                    close()
                  }}
                >
                  粘贴
                </MenuItem>
                <MenuDivider />
                <MenuItem icon="🗑" danger onClick={() => { p.onDelete(); close() }}>删除块</MenuItem>
              </>
            )}
          </Dropdown>
        )}
        </div>
      </div>
  )
})

/* ---------------- 块类型菜单 ---------------- */

function BlockTypeMenu({
  block,
  onConvert,
  members,
}: {
  block: Block
  onConvert: (t: Block['type']) => void
  members: { id: string; name: string; avatar: string }[]
}) {
  const groups = ['基础', '扩展', '媒体']
  return (
    <div className="yq-block-type-panel">
      {groups.map((g) => (
        <div key={g} className="yq-block-type-group">
          <div className="yq-block-type-label">{g}</div>
          <div className="yq-block-type-items">
            {(Object.keys(BLOCK_META) as Block['type'][])
              .filter((t) => BLOCK_META[t].group === g)
              .map((t) => (
                <button
                  key={t}
                  className={`yq-block-type-item ${block.type === t ? 'is-active' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    onConvert(t)
                  }}
                >
                  <span className="yq-block-type-icon">{BLOCK_META[t].icon}</span>
                  <span>{BLOCK_META[t].label}</span>
                </button>
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ---------------- 图片块 ---------------- */

/**
 * 图片块。支持两种来源：
 * 1. 外链地址（粘贴 URL）
 * 2. 本地文件 —— 走 attachment-store：连着服务端就传服务端（可跨设备、鉴权下载），
 *    纯前端就进 IndexedDB。卡片这边无感知。
 *
 * 以前这里只让粘贴 URL，界面上却写着「或从本地拖入图片」——
 * **说能拖但根本没接拖拽事件**。界面承诺了做不到的事，
 * 用户试了发现没反应，比一开始就不写更糟。
 */
function ImageBlock({ block, onChange, onData, readOnly, onCopyImage, onTailText, onTailEnter, onTailFocus }: {
  block: Block
  onChange: (t: string) => void
  /** 写回 block.data（复用卡片数据补丁那条通道，浅合并） */
  onData: (patch: Record<string, any>) => void
  readOnly?: boolean
  /** 「复制图片」：把图片二进制写进剪贴板（HTTP 下会降级成复制地址） */
  onCopyImage?: () => void
  /**
   * 「在图片后面继续编辑文字」—— **同行**的尾巴文字。
   *
   * 语雀的实测（用户 2026-10-20 给的截图）：图片右边紧跟着文字，**同一行**。
   * 所以图片块不能再是「内容恒为空的纯图片块」——
   * 它的 `text` 装的就是**图片后面那段话**，渲染在图片**右边**。
   */
  onTailText?: (t: string) => void
  /** 尾巴文字里按回车 → 在图片**下面**新建一段 */
  onTailEnter?: () => void
  /** 光标进到尾巴文字上 → 这个块成为当前块 */
  onTailFocus?: () => void
}) {
  const [url, setUrl] = useState(block.src || '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [over, setOver] = useState(false)
  const [broken, setBroken] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  /**
   * 本地上传的图片：key 指向真正的二进制，dataUrl 是本地模式直接可用的地址
   *
   * 这里的 URL **必须走 `useAttachmentUrl`，不能自己拼** `attachmentUrl(key)`。
   *
   * 原因是本地形态的 key（`sha256-…`）指向**本机 IndexedDB**，压根不在服务端；
   * 而 `attachmentUrl()` 拼出来的一定是 `/api/attachment/<key>`。
   * 在**静态托管**（DEPLOY 写明支持的部署形态）下没有后端，那个地址必然 404，
   * 于是图片块里是一张**加载不出来的碎图**，而正文里明明有这张图。
   *
   * 实测：纯静态托管上传一张 PNG，key 写进了块、文件选择器一切正常，
   * 而 `<img>` 的 naturalWidth 是 0 —— 上传「成功」了，图却看不见。
   * 同一份代码里的 `FileCard` 一直是用 `useAttachmentUrl` 的，所以**文件卡好好的、
   * 图片块是坏的** —— 同一个概念两张卡，一张会修一张不会。
   */
  const own = block.data?.key ? block.data : null
  const { url: ownUrl, state: ownState } = useAttachmentUrl(own?.key, own?.dataUrl)
  const displayUrl = own ? ownUrl : url

  /**
   * 同行尾巴文字（图片右边那段）。
   * ⚠️ 必须**像别的文本块一样**用 ref + effect 同步内容 ——
   *   直接把 `block.text` 塞进 JSX 的话，每次输入都会重渲染，
   *   光标会被甩到末尾（中文输入法尤其明显：组字被打断）。
   */
  const tailRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = tailRef.current
    if (!el) return
    const want = block.text || ''
    if ((el.innerText || '') !== want) el.innerText = want
  }, [block.text])

  // 换源之后上一次的「加载失败」就不作数了
  useEffect(() => { setBroken(false) }, [displayUrl])

  const upload = async (file: File) => {
    if (!file.type.startsWith('image/')) { setErr('只能放图片文件'); return }
    setBusy(true); setErr('')
    try {
      const patch = await attachFileToDoc(file, true)
      if (!patch.key && !patch.dataUrl) {
        setErr(patch.error || '上传失败')
        return
      }
      if (patch.degraded) setErr(`已降级保存：${patch.degraded}`)
      onChange('')
      // src 留空表示「不是外链」，改由 data.key 指路
      onData({ key: patch.key, dataUrl: patch.dataUrl, name: patch.name, size: patch.size })
    } catch (e: any) {
      setErr(e?.message || '上传失败')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 同行尾巴文字（图片右边那段）。
   *
   * ⚠️ **三种状态都要有**（已加载 / 读取中 / 上传占位）：
   *   粘贴图片时有一瞬是「上传中」—— 那时图片还没显示出来，
   *   而**光标必须已经有地方落**（否则中文输入无处可去，界面零反馈）。
   */
  const tailNode = (
    <div
      ref={tailRef}
      className="yq-block-text yq-img-text"
      contentEditable={!readOnly}
      suppressContentEditableWarning
      spellCheck={false}
      data-placeholder="在图片后面写点文字"
      onFocus={onTailFocus}
      onInput={(e) => onTailText?.(e.currentTarget.innerText ?? '')}
      onKeyDown={(e) => {
        /* 回车 → 在图片**下面**新建一段（图片块自己不能回车建块） */
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onTailEnter?.() }
      }}
    />
  )
  if (displayUrl) {
    return (
      <div className="yq-img-block">
        {/* 图片本体（含工具条与文件名） */}
        <div className="yq-img-col">
          {/*
           * 悬浮工具条：语雀的图片是卡片，悬浮时左上角有它自己的工具条。
           * 表格块早就有（`.yq-card-toolbar`），图片却没有 ——
           * 于是「复制这张图」在图片上**一个入口都没有**。
           */}
          {!readOnly && (
            <div className="yq-img-toolbar" contentEditable={false} onMouseDown={(e) => e.preventDefault()}>
              <button onClick={onCopyImage} title="复制图片">🖼</button>
              <a href={displayUrl} download={own?.name || 'image'} title="下载图片">⤓</a>
            </div>
          )}
          <img
            src={displayUrl}
            // alt 留空的话读屏软件**什么都读不到**；文件名就是最好的替代文本
            alt={own?.name || block.data?.alt || '文档图片'}
            onError={() => setBroken(true)}
          />
          {own?.name && <div className="yq-img-block-caption">{own.name}</div>}
          {/*
           * 加载不出来就说出来。
           * 以前这里只有一个裸的 `<img src>`，而 `<img>` 加载失败时浏览器
           * 画的是一张碎图或者干脆什么都不画 —— 用户看到的是「图没了」，
           * 既不知道是文件丢了、没权限，还是网络问题。
           * 碎图不解释原因，比明确报错更难排查。
           */}
          {broken && (
            <div className="yq-kc-note is-error" style={{ marginTop: 8 }}>
              <span>⚠️</span>
              <span>
                这张图片加载不出来
                {own?.name ? `（${own.name}）` : ''}。
                可能是附件被删了、内容来自另一个实例、或者你没有查看这篇文档的权限。
              </span>
            </div>
          )}
        </div>

        {/*
         * **同行尾巴文字**：图片右边那段（语雀就是这样 —— 见用户 2026-10-20 的截图）。
         *
         * 它是**这个块的 `text`** —— 所以：
         *   · 搜索能搜到它、撤销能撤掉它、同步能同步它（都走块本身那条通道）；
         *   · 导出时它跟在图片后面（同 markdown 的一行）。
         * ⓘ 只读态也渲染（不然读文档的人看不到这段话）。
         */}
        {tailNode}
      </div>
    )
  }

  /*
   * 二进制确定不在了（`useAttachmentUrl` 取不回来），或者还在读。
   * 这两种都比「渲染一张碎图」诚实 —— 碎图不告诉用户发生了什么。
   * 措辞跟 `FileCard` 保持一致：同一个概念两张卡，不能一张会解释一张不会。
   */

  if (own && (ownState === 'missing' || ownState === 'loading')) {
    return (
      <div className="yq-img-block">
        <div className="yq-img-col">
          <div className="yq-kc-note is-error">
            <span>⚠️</span>
            <span>
              {ownState === 'loading'
                ? '正在读取图片…'
                : `图片已丢失（${own.name || own.key}）。可能附件被删掉了，或这份内容来自另一个实例。`}
            </span>
          </div>
        </div>
        {tailNode}
      </div>
    )
  }

  return (
    <div className="yq-img-block">
      <div
        className={`yq-img-block-empty ${over ? 'is-over' : ''}`}
        onDragOver={(e) => { if (readOnly) return; e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          if (readOnly) return
          e.preventDefault()
          setOver(false)
          const f = e.dataTransfer?.files?.[0]
          if (f) upload(f)
        }}
      >
        <input
          placeholder="粘贴图片地址后回车"
          defaultValue={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onChange(e.currentTarget.value)
          }}
          disabled={readOnly}
        />
        <span>或</span>
        <button type="button" className="yq-btn yq-btn-sm" disabled={readOnly || busy} onClick={() => fileRef.current?.click()}>
          {busy ? '上传中…' : '选择本地图片'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = '' }}
        />
        <span className="yq-img-block-hint">也可以直接把图片拖进来</span>
        {err && <span className="yq-img-block-err">{err}</span>}
      </div>
      {/* 上传中也要有尾巴文字 —— 粘贴图片的那一刻正是「上传中」，
          光标得有个地方落（否则中文输入无处可去）。 */}
      {tailNode}
    </div>
  )
}

/* ---------------- 表格块 ---------------- */

/**
 * 表格块：**可编辑**。
 *
 * ⚠️ 2026-10-07 之前这里是 `contentEditable={false}` 的静态渲染，
 *   `onChange` 声明了却**一次都没被调用**，`readOnly` 参数收了也没用 ——
 *   也就是「可编辑」和「只读」长得一模一样，用户对着打不动的格子猜。
 *   官方语雀的表格是可交互的，所以这是**必须补上的差距**，不是取舍。
 *
 * 存储形态没变：markdown 源码（`| a | b |` / 分隔行 / 数据行）。
 * 好处是导出、分享页、复制粘贴、markdown 导入全都不用改 —— 它们本来就吃这个形态。
 *
 * ⚠️ 单元格用 `onBlur` 提交、**不用 onInput**：contentEditable 受控回写会打断光标
 *   （本项目在正文的 `.yq-block-text` 上已经为这件事付过代价，见 attachText 那段）。
 *   代价是「打完不点别处就不落盘」，所以失焦、点增删按钮、以及进入只读态都会提交。
 */
function TableBlock({ block, readOnly, onChange }: {
  block: Block
  readOnly?: boolean
  onChange: (text: string) => void
}) {
  const lines = (block.text || '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |').split('\n')
  const rows = lines.map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
  const header = rows[0] || []
  const body = rows.slice(2)

  /** 唯一的写回通道：任何改动都序列化回 markdown 再交给 store */
  const commit = (h: string[], b: string[][]) =>
    onChange([
      '| ' + h.join(' | ') + ' |',
      '| ' + h.map(() => '---').join(' | ') + ' |',
      ...b.map((r) => '| ' + r.join(' | ') + ' |'),
    ].join('\n'))

  const setHeader = (i: number, v: string) => {
    const h = [...header]; h[i] = v; commit(h, body)
  }
  const setCell = (r: number, c: number, v: string) => {
    const b = body.map((row) => [...row])
    if (!b[r]) return
    b[r][c] = v
    commit(header, b)
  }
  const addRow = () => commit(header, [...body, header.map(() => '')])
  const delRow = (r: number) => commit(header, body.filter((_, i) => i !== r))
  const addCol = () =>
    commit([...header, '新列'], body.map((row) => [...row, '']))
  const delCol = (c: number) =>
    commit(header.filter((_, i) => i !== c), body.map((row) => row.filter((_, i) => i !== c)))

  /* 一格：内容由 DOM 自己维护，失焦时把 innerText 写回。
     key 用 `h{i}` / `r{ri}c{ci}` —— 增删行列后下标会挪，用下标当 key 会串内容。 */
  const cell = (tag: 'th' | 'td', v: string, cls: string,
    write: (nv: string) => void) => {
    const T = tag as any
    return (
      <T
        key={cls}
        className={readOnly ? '' : 'is-editable'}
        contentEditable={!readOnly}
        suppressContentEditableWarning
        spellCheck={false}
        onBlur={(e: React.FocusEvent<HTMLElement>) => {
          const nv = e.currentTarget.innerText.replace(/\u00a0/g, ' ').trim()
          /* 内容没变就别写：否则每次失焦都产生一次落盘 + 版本 */
          if (nv !== v) write(nv)
        }}
      >{v}</T>
    )
  }

  return (
    <div className="yq-table-wrap">
      <table className="yq-table-block" contentEditable={false}>
        <thead>
          <tr>
            {header.map((h, i) => cell('th', h, 'h' + i, (nv) => setHeader(i, nv)))}
            {!readOnly && (
              <th className="yq-table-op">
                <button title="删除最后一列" onClick={() => delCol(header.length - 1)}>−</button>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={'r' + ri}>
              {r.map((c, ci) => cell('td', c, 'r' + ri + 'c' + ci, (nv) => setCell(ri, ci, nv)))}
              {!readOnly && (
                <td className="yq-table-op">
                  <button title="删除这一行" onClick={() => delRow(ri)}>−</button>
                </td>
              )}
            </tr>
          ))}
          {/* 增删按钮占一行，但不进 markdown —— 少一行「假的」表格数据 */}
          {!readOnly && (
            <tr className="yq-table-ops">
              <td colSpan={header.length + 1}>
                <button onClick={addRow}>+ 行</button>
                <button onClick={addCol}>+ 列</button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/* ---------------- 光标工具 ---------------- */

function placeCaretEnd(el?: HTMLElement | null) {
  if (!el) return
  el.focus()
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function isCaretAtStart(el: HTMLElement): boolean {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return false
  const range = sel.getRangeAt(0)
  if (!range.collapsed) return false
  const pre = range.cloneRange()
  pre.selectNodeContents(el)
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString().length === 0
}

/**
 * 光标在这个块里的字符偏移；算不出来（选区不折叠 / 不在这个块里）就返回 null。
 * 与 isCaretAtStart 同一套算法，只是把长度取出来。
 */
function caretOffsetIn(el: HTMLElement): number | null {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  if (!range.collapsed) return null
  if (!el.contains(range.startContainer)) return null
  const pre = range.cloneRange()
  pre.selectNodeContents(el)
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString().length
}

/** 光标是不是在块内最后一个字符之后 */
function isCaretAtEnd(el: HTMLElement): boolean {
  const off = caretOffsetIn(el)
  if (off == null) return false
  return off >= (el.textContent || '').length
}

/**
 * 这个块是不是**只有一行**。
 * 单行块里按 ↑↓ 应当直接跳到相邻块（语雀就是这样），
 * 多行块里则要靠「光标在不在首/末行」来判断 —— 不然会抢走段内上下移动光标。
 */
function isSingleLineBlock(el: HTMLElement): boolean {
  const cs = getComputedStyle(el)
  const lh = parseFloat(cs.lineHeight)
  const fs = parseFloat(cs.fontSize) || 16
  const line = Number.isFinite(lh) && lh > 0 ? lh : fs * 1.5
  return el.clientHeight <= line * 1.6
}

/**
 * 把光标定位到块内第 offset 个字符处。
 * 必须走 TreeWalker：块的 DOM 里可能有多个 inline 元素（富文本），
 * 文本是散在多个 TextNode 里的，直接 setStart(块首节点) 会落在错误的节点上。
 */
function setCaretInBlock(el: HTMLElement, offset: number) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  let acc = 0
  let node: Node | null
  let target: Text | null = null
  let local = 0
  while ((node = walker.nextNode())) {
    const t = node as Text
    const len = (t.textContent || '').length
    if (acc + len >= offset) {
      target = t
      local = offset - acc
      break
    }
    acc += len
  }
  if (!target) {
    const last = el.lastChild
    if (!last) return
    const r = document.createRange()
    r.setStart(last, last.nodeType === Node.TEXT_NODE ? (last.textContent || '').length : 0)
    r.collapse(true)
    const sel0 = window.getSelection()
    sel0?.removeAllRanges()
    sel0?.addRange(r)
    return
  }
  const r = document.createRange()
  r.setStart(target, Math.min(local, (target.textContent || '').length))
  r.collapse(true)
  const sel0 = window.getSelection()
  sel0?.removeAllRanges()
  sel0?.addRange(r)
}

/** 转义成可安全写入 innerHTML 的纯文本 */
function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 光标相对于块文本的字符偏移 */
function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return el.innerText.length
  const range = sel.getRangeAt(0)
  if (!el.contains(range.startContainer)) return el.innerText.length
  const pre = range.cloneRange()
  pre.selectNodeContents(el)
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString().length
}

function selectionOffset(el: HTMLElement, sel: Selection): number {
  const range = sel.getRangeAt(0)
  const pre = range.cloneRange()
  pre.selectNodeContents(el)
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString().length
}

/* ============================================================
   "/" 斜杠菜单 —— 语雀编辑器标志性交互
   语雀原话：「同时输入快捷键「/」后，还支持直接搜索中文、拼音、
   拼音首字母、英文」「在特色卡片面板中增加最近使用功能，
   最多展示四个最近使用的应用」
   ============================================================ */

function SlashMenu({
  x, y, q, recent, onPick, onClose,
}: {
  x: number
  y: number
  q: string
  /** 最近使用的卡片 id，语雀最多展示 4 个 */
  recent: string[]
  onPick: (c: YuqueCard) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [sel, setSel] = useState(0)

  const matched = useMemo(() => matchCards(q), [q])
  const recentCards = useMemo(
    () => (q ? [] : recent.map((id) => YUQUE_CARDS.find((c) => c.id === id)).filter(Boolean) as YuqueCard[]),
    [recent, q],
  )

  /** 面板里的可见顺序 = 最近使用 + 搜索结果，键盘导航按同一顺序 */
  const flat = useMemo(
    () => [...recentCards, ...matched.filter((c) => !recentCards.some((r) => r.id === c.id))],
    [recentCards, matched],
  )

  useEffect(() => setSel(0), [q])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.is-active')?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  /**
   * 焦点还在 contentEditable 里，而 React 的 onKeyDown 会先于冒泡阶段的
   * document 监听执行 —— 块处理器会把 Enter 当成"新建块"。
   * 所以这里用【捕获阶段】拦截，抢在 React 委托之前拿到按键。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setSel((v) => Math.min(flat.length - 1, v + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setSel((v) => Math.max(0, v - 1)) }
      else if ((e.key === 'Enter' || e.key === 'Tab') && flat[sel]) { e.preventDefault(); e.stopPropagation(); onPick(flat[sel]) }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [flat, sel, onPick])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  const left = Math.min(x, window.innerWidth - 300)

  let cursor = -1
  const renderItem = (c: YuqueCard, inRecent = false) => {
    cursor += 1
    const i = cursor
    return (
      <button
        key={`${inRecent ? 'r' : 'n'}-${c.id}`}
        className={`yq-slash-item ${i === sel ? 'is-active' : ''}`}
        onMouseEnter={() => setSel(i)}
        onClick={() => onPick(c)}
      >
        <span className="yq-slash-icon">{c.icon}</span>
        <span className="yq-slash-name">{c.name}</span>
        <span className="yq-slash-en">{c.en.split(' ')[0]}</span>
      </button>
    )
  }

  /** 按语雀分组顺序渲染；搜索时打平不再分组 */
  const grouped = q
    ? null
    : CARD_GROUPS.map((g) => {
        const items = matched.filter((c) => c.group === g)
        return items.length ? { g, items } : null
      }).filter(Boolean) as { g: string; items: YuqueCard[] }[]

  return (
    <div className="yq-slash yq-slash-cards" ref={ref} style={{ top: y, left }} onClick={(e) => e.stopPropagation()}>
      <div className="yq-slash-head">
        <span>{q ? '搜索结果' : '插入'}</span>
        {q && <span className="yq-slash-q">/{q}</span>}
        {!q && <span className="yq-slash-tip">支持中文 / 拼音 / 首字母</span>}
      </div>

      <div className="yq-slash-list" ref={listRef}>
        {flat.length === 0 && <div className="yq-slash-empty">没有匹配的卡片</div>}

        {/* 最近使用 */}
        {recentCards.length > 0 && (
          <div className="yq-slash-group">
            <div className="yq-slash-group-label">最近使用</div>
            <div className="yq-slash-group-grid">
              {recentCards.map((c) => renderItem(c, true))}
            </div>
          </div>
        )}

        {/* 分组列表 */}
        {grouped
          ? grouped.map((grp) => (
              <div className="yq-slash-group" key={grp.g}>
                <div className="yq-slash-group-label">{grp.g}</div>
                <div className="yq-slash-group-grid">
                  {grp.items.map((c) => renderItem(c))}
                </div>
              </div>
            ))
          : flat.map((c) => renderItem(c))}
      </div>

      <div className="yq-slash-foot">↑↓ 选择 · ↵ 确认 · esc 关闭</div>
    </div>
  )
}

/* ============================================================
   "@" 唤起面板 —— 语雀支持提及成员或文档
   ============================================================ */

function MentionMenu({
  x, y, q, members, docs, onPick, onClose,
}: {
  x: number
  y: number
  q: string
  members: { id: string; name: string; avatar: string }[]
  docs: { id: string; title: string }[]
  onPick: (v: { id: string; name: string } | { id: string; title: string }) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [sel, setSel] = useState(0)

  const kw = q.trim().toLowerCase()
  const ms = members.filter((m) => !kw || m.name.toLowerCase().includes(kw) || m.name.includes(q.trim()))
  const ds = docs.filter((d) => !kw || d.title.toLowerCase().includes(kw)).slice(0, 5)
  const flat = [...ms, ...ds]

  useEffect(() => setSel(0), [q])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setSel((v) => Math.min(flat.length - 1, v + 1)) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setSel((v) => Math.max(0, v - 1)) }
      else if ((e.key === 'Enter' || e.key === 'Tab') && flat[sel]) { e.preventDefault(); e.stopPropagation(); onPick(flat[sel]) }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [flat, sel, onPick])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  if (!flat.length) return null

  return (
    <div className="yq-mention" ref={ref} style={{ top: y, left: Math.min(x, window.innerWidth - 260) }} onClick={(e) => e.stopPropagation()}>
      <div className="yq-mention-group">成员</div>
      {ms.map((m, i) => (
        <button key={m.id} className={`yq-mention-item ${i === sel ? 'is-active' : ''}`}
          onMouseEnter={() => setSel(i)} onClick={() => onPick(m)}>
          <span className="yq-mention-avatar">{m.avatar}</span>
          <span className="yq-mention-name">{m.name}</span>
        </button>
      ))}
      {ds.length > 0 && (
        <>
          <div className="yq-mention-group">文档</div>
          {ds.map((d, i) => (
            <button key={d.id} className={`yq-mention-item ${ms.length + i === sel ? 'is-active' : ''}`}
              onMouseEnter={() => setSel(ms.length + i)} onClick={() => onPick(d)}>
              <span className="yq-mention-avatar">📄</span>
              <span className="yq-mention-name yq-ellipsis">{d.title}</span>
            </button>
          ))}
        </>
      )}
    </div>
  )
}
