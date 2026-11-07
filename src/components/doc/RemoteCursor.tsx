import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import type { CollabCursor } from '@/types'
import { useStore } from '@/store'
import { colorOfMember } from '@/lib/collaboration'
import './RemoteCursor.css'

/* ============================================================
   实时协作光标（远端协作者）—— 纯 overlay 渲染层
   ------------------------------------------------------------
   数据来自 store 的 cursors（由 @/lib/collaboration 从别的标签页
   同步过来，或演示模式灌入），这里只负责「把它画对」。

   边界说明（刻意不做的事）：
   - 不做 CRDT / 合并算法。
   - 绝不碰 contentEditable 块的 DOM。所有产物都是独立元素，
     绝对定位覆盖在正文之上，pointer-events: none。
   - 颜色只认成员标识色：以本地成员表为准重新算，
     不直接用消息里带的 color（避免对端塞任意色值）。
   ============================================================ */

/** 超过这个时间没动静就整体淡出（对方走神 / 切去别的界面了） */
export const IDLE_MS = 15_000
/** 名字标签高度（含 padding），用来判断首行要不要翻到光标下方 */
const LABEL_H = 20

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Measure {
  /** 光标竖线（滚动区内容坐标系） */
  caret: Rect
  /** 选区高亮，已换算成相对 caret 的偏移 */
  sels: Rect[]
  /** 名字标签是否翻到光标下方 */
  labelBelow: boolean
}

/* ============================================================
   位置计算
   ------------------------------------------------------------
   1) blockId → [data-block-id="..."] 元素
   2) 取块正文里第一个非空 TextNode（浏览器可能把文本拆成多个节点，
      contentEditable 里还可能混进 <br> / <font> 之类的元素）
   3) Range.setStart(textNode, offset) + getBoundingClientRect()
      拿到视口坐标
   4) 减滚动区 rect 的 left/top，再加 scrollTop/scrollLeft，
      换算成「滚动区内容坐标系」—— overlay 是滚动区的绝对定位
      子元素，天然跟着正文一起滚
   ============================================================ */

function findBlock(root: HTMLElement, blockId: string): HTMLElement | null {
  const list = root.querySelectorAll<HTMLElement>('[data-block-id]')
  for (const el of list) if (el.dataset.blockId === blockId) return el
  return null
}

function firstTextNode(el: HTMLElement): Text | null {
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && (node.textContent || '').length > 0) return node as Text
  }
  return null
}

function lineHeightOf(el: HTMLElement): number {
  const cs = window.getComputedStyle(el)
  const lh = parseFloat(cs.lineHeight)
  if (Number.isFinite(lh) && lh > 0) return lh
  const fs = parseFloat(cs.fontSize)
  return (Number.isFinite(fs) ? fs : 14) * 1.8
}

function measureCursor(c: CollabCursor, scroller: HTMLElement, root: HTMLElement): Measure | null {
  const block = findBlock(root, c.blockId)
  if (!block) return null
  // 与编辑器一致：正文在 .yq-block-text，代码块在 .yq-code-body。
  // 分割线 / 图片 / 表格块没有文本容器 —— 安全降级为不渲染。
  const textEl = block.querySelector<HTMLElement>('.yq-block-text, .yq-code-body')
  if (!textEl) return null
  const textNode = firstTextNode(textEl)
  if (!textNode) return null

  const len = textNode.textContent?.length ?? 0
  // offset 越界会让 setStart 抛 IndexSizeError，一律夹紧
  const clamp = (n: number) => Math.max(0, Math.min(len, Math.round(n) || 0))
  const a = clamp(c.range[0])
  const b = clamp(c.range[1])
  const [rs, re] = a <= b ? [a, b] : [b, a]
  const off = clamp(c.offset)

  const sRect = scroller.getBoundingClientRect()
  const toX = (v: number) => v - sRect.left + scroller.scrollLeft
  const toY = (v: number) => v - sRect.top + scroller.scrollTop

  let caret: Rect | null = null
  try {
    const range = document.createRange()
    range.setStart(textNode, off)
    range.setEnd(textNode, off)
    const r = range.getBoundingClientRect()
    const lineH = lineHeightOf(textEl)
    // 折叠 Range 的 rect 是「字体盒」（正文 17px / H1 27px），并且被行盒
    // 上下均分居中。竖线要的是整个行盒（正文 1.8em = 27px，H1 = 43px），
    // 所以按 half-leading 反推行盒顶边：lineTop = rect.top - (行盒高 - 字体盒高)/2
    const inkH = r.height > 1 ? r.height : lineH
    const lineTop = r.height > 1 ? r.top - (lineH - inkH) / 2 : textEl.getBoundingClientRect().top
    caret = { x: toX(r.left), y: toY(lineTop), w: 2, h: lineH }
  } catch {
    caret = null
  }
  if (!caret) return null

  const sels: Rect[] = []
  if (re > rs) {
    try {
      const range = document.createRange()
      range.setStart(textNode, rs)
      range.setEnd(textNode, re)
      // 跨行选区会返回多个行盒，逐个铺一层高亮
      for (const r of Array.from(range.getClientRects())) {
        if (r.width < 0.5 && r.height < 0.5) continue
        sels.push({
          x: toX(r.left) - caret.x,
          y: toY(r.top) - caret.y,
          w: r.width,
          h: r.height,
        })
      }
    } catch {
      /* 选区算不出来就只留光标竖线 */
    }
  }

  return { caret, sels, labelBelow: caret.y < LABEL_H }
}

/* ============================================================
   单个远端光标
   ============================================================ */

export function RemoteCursor({
  cursor,
  scroller,
  root,
  now,
  version,
  labelShift,
}: {
  cursor: CollabCursor
  scroller: HTMLElement
  root: HTMLElement
  now: number
  /** 宿主自增的测量版本号（滚动 / 尺寸变化 / 每秒心跳） */
  version: number
  /** 标签避让：本光标的标签相对默认位置要上移多少像素（由宿主统一算好） */
  labelShift: number
}) {
  const member = useStore((s) => s.members.find((m) => m.id === cursor.memberId))
  const [m, setM] = useState<Measure | null>(null)

  // 放 layout effect：commit 之后才量，保证量到的是最新的正文 DOM
  useLayoutEffect(() => {
    setM(measureCursor(cursor, scroller, root))
  }, [cursor, scroller, root, version])

  if (!m) return null

  const idle = now - cursor.activeAt > IDLE_MS
  const style: CSSProperties = {
    left: m.caret.x,
    top: m.caret.y,
    // 唯一允许的写死色：成员标识色，按 memberId 在本地成员表里取，
    // 保证「同一个人在任何标签页里都是同一个颜色」
    ['--yq-collab-color' as string]: colorOfMember(cursor.memberId) || cursor.color,
    // 标签被挤开时整体跟着上移
    ['--yq-label-shift' as string]: `${labelShift}px`,
  }

  return (
    <div
      className={`yq-collab-cursor ${idle ? 'is-idle' : ''} ${m.labelBelow ? 'is-below' : ''}`}
      style={style}
      aria-hidden
    >
      {m.sels.map((s, i) => (
        <i key={i} className="yq-collab-sel" style={{ left: s.x, top: s.y, width: s.w, height: s.h }} />
      ))}
      <span className="yq-collab-caret" style={{ height: m.caret.h }} />
      <span className="yq-collab-label">{member?.name || cursor.memberId}</span>
    </div>
  )
}

/* ============================================================
   overlay 宿主：铺在正文滚动区上，跟随滚动重算
   ============================================================ */

export default function RemoteCursorLayer({
  cursors,
  scrollRef,
  editorRef,
}: {
  cursors: CollabCursor[]
  /** 正文滚动区 .yq-doc-scroll */
  scrollRef: RefObject<HTMLDivElement>
  /** 编辑器宿主，用来按 [data-block-id] 找块 */
  editorRef: RefObject<HTMLDivElement>
}) {
  const [tick, setTick] = useState(() => ({ version: 0, now: Date.now() }))
  const rafRef = useRef(0)

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return

    const bump = () => setTick((t) => ({ ...t, version: t.version + 1 }))
    const bumpNow = () => setTick((t) => ({ version: t.version + 1, now: Date.now() }))

    // 滚动：rAF 节流，一帧最多重算一次
    const onScroll = () => {
      if (rafRef.current) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0
        bump()
      })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', bump)

    // 滚动区尺寸变化（评论抽屉展开、目录拖宽、超宽模式）同样要重算
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(bump) : null
    ro?.observe(scroller)

    // 每秒心跳：既刷新「离线淡出」，也让正文被编辑后光标不会长期错位
    const heart = setInterval(bumpNow, 1000)
    bump()

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', bump)
      ro?.disconnect()
      clearInterval(heart)
    }
  }, [scrollRef, rafRef])

  const scroller = scrollRef.current
  const root = editorRef.current

  /**
   * 名字标签避让。
   * 每个光标各自测量、彼此看不见对方，两个协作者光标落在相邻位置时
   * 标签会直接叠在一起糊成一团（这是实测截图里发现的问题）。
   * 这里在宿主层把所有光标量一遍，统一决定各自要上移多少像素。
   */
  const labelShift = useMemo(() => {
    // 注意：early return 必须在所有 hook 之后，
    // 否则首次渲染（scroller 还是 null）会少跑一个 hook，直接触发 React #310
    if (!scroller || !root) return new Map<string, number>()
    const measured = cursors
      .map((c) => ({ c, m: measureCursor(c, scroller, root) }))
      .filter((x): x is { c: CollabCursor; m: Measure } => !!x.m)

    // 从上到下依次放置：撞上已放置的标签就再往上抬一层
    const order = [...measured].sort((a, b) => a.m.caret.y - b.m.caret.y)
    const placed: Rect[] = []
    const shift = new Map<string, number>()

    for (const { c, m } of order) {
      const name = c.memberId
      const w = (c.memberId.length || 2) * 12 + 14 // 粗略宽度，仅用于碰撞判定
      let offset = 0
      for (let step = 0; step < 4; step++) {
        const y = m.caret.y - LABEL_H - step * LABEL_H
        const rect: Rect = { x: m.caret.x, y, w, h: LABEL_H }
        const hit = placed.some(
          (p) => !(rect.x + rect.w <= p.x || p.x + p.w <= rect.x || rect.y + rect.h <= p.y || p.y + p.h <= rect.y),
        )
        if (!hit) {
          offset = step * LABEL_H
          placed.push(rect)
          break
        }
        offset = (step + 1) * LABEL_H
      }
      shift.set(name, offset)
    }
    return shift
  }, [cursors, scroller, root, tick.version])

  if (!scroller || !root) return null

  return (
    <div className="yq-collab-layer" aria-hidden>
      {cursors.map((c) => (
        <RemoteCursor
          key={c.id}
          cursor={c}
          scroller={scroller}
          root={root}
          now={tick.now}
          version={tick.version}
          labelShift={labelShift.get(c.memberId) ?? 0}
        />
      ))}
    </div>
  )
}
