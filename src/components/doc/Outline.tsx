import { useEffect, useMemo, useRef, useState } from 'react'
import type { Block } from '@/types'
import './index.css'

/* ============================================================
   文档大纲 —— 语雀的三态交互
   1) 钉住(pinned)：固定在右侧，悬浮出现「图钉」按钮
   2) 隐藏(hidden)：收缩成右侧边缘的 mini 态，只留一条细边
   3) 悬浮(mini + hover)：鼠标滑过 mini 条即展开成浮层
   语雀原话：「大纲会收缩在右侧边缘呈现 mini 状态，
   将鼠标轻滑过 mini 大纲上方，即可展开大纲与你呼应」
   ============================================================ */

export type OutlineMode = 'pinned' | 'hidden'

export default function Outline({
  blocks,
  scrollRef,
  mode,
  onModeChange,
  drawer = false,
  open = false,
}: {
  blocks: Block[]
  scrollRef: React.RefObject<HTMLElement>
  mode: OutlineMode
  onModeChange: (m: OutlineMode) => void
  /** 窄屏抽屉态：大纲从底部滑入覆盖正文 */
  drawer?: boolean
  open?: boolean
}) {
  const [hover, setHover] = useState(false)

  const heads = useMemo(
    () => blocks.filter((b) => ['h1', 'h2', 'h3', 'h4'].includes(b.type) && b.text.trim()),
    [blocks],
  )

  const words = useMemo(() => blocks.reduce((n, b) => n + (b.text?.length || 0), 0), [blocks])

  // 滚动跟随高亮
  useEffect(() => {
    if (mode !== 'pinned' && !hover) return
    const scroller = scrollRef.current
    if (!scroller) return

    const onScroll = () => {
      const top = scroller.scrollTop + 120
      let current = heads[0]?.id
      heads.forEach((h) => {
        const el = scroller.querySelector<HTMLElement>(`[data-block-id="${h.id}"]`)
        if (el && el.offsetTop <= top) current = h.id
      })
      document.querySelectorAll('[data-outline-item]').forEach((n) => {
        n.classList.toggle('is-active', (n as HTMLElement).dataset.outlineItem === current)
      })
    }
    onScroll()
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [heads, scrollRef, mode, hover])

  const jump = (id: string) => {
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-block-id="${id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const body = (
    <>
      <div className="yq-outline-body">
        {heads.length === 0 ? (
          <div className="yq-outline-empty">
            还没有标题
            <br />
            <span>用 H1~H4 建立结构</span>
          </div>
        ) : (
          heads.map((h, i) => (
            <button
              key={h.id}
              data-outline-item={h.id}
              className={`yq-outline-item yq-outline-lv-${h.type} ${i === 0 ? 'is-active' : ''}`}
              onClick={() => jump(h.id)}
            >
              {h.text || '未命名标题'}
            </button>
          ))
        )}
      </div>

      {heads.length > 0 && (
        <div className="yq-outline-foot">
          <div className="yq-outline-stat">
            <span>{blocks.length} 个块</span>
            <span>{words} 字</span>
          </div>
          <div className="yq-outline-readtime">
            约 {Math.max(1, Math.ceil(words / 400))} 分钟读完
          </div>
        </div>
      )}
    </>
  )

  /* ---------- 钉住态：固定侧栏（窄屏下由 CSS 变成底部抽屉） ---------- */
  if (mode === 'pinned') {
    return (
      <aside className={`yq-outline yq-fade-in ${drawer ? 'is-drawer' : ''} ${drawer && open ? 'is-open' : ''}`}>
        <div className="yq-outline-head">
          <span>大纲</span>
          {/* 语雀：悬浮大纲时出现图钉，点击即隐藏 */}
          <button
            className="yq-outline-pin"
            onClick={() => onModeChange('hidden')}
            title="隐藏大纲"
          >
            <svg viewBox="0 0 14 14" width="12" height="12">
              <path
                d="M5 1.5h4l-.6 3.2 2.1 2.1H3.5l2.1-2.1L5 1.5zM7 6.8v5.7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        {body}
      </aside>
    )
  }

  /* ---------- 隐藏态：右侧边缘 mini 条，悬浮展开 ---------- */
  return (
    <div
      className={`yq-outline-mini-wrap ${hover ? 'is-open' : ''}`}
      /* 离开整个组合区（把手 + 浮层）才收起，从把手移到浮层不闪 */
      onMouseLeave={() => setHover(false)}
    >
      {/* 收起时的细边把手。进入监听挂在把手自己身上 —— 父容器是
          pointer-events:none，挂在父级上的 onMouseEnter 在真实浏览器里不可靠 */}
      <div
        className="yq-outline-mini"
        title="展开大纲"
        onMouseEnter={() => setHover(true)}
      >
        <span className="yq-outline-mini-dots">
          {heads.slice(0, 6).map((h) => (
            <i key={h.id} />
          ))}
          {heads.length === 0 && <i />}
        </span>
      </div>

      {/* 悬浮展开的浮层 */}
      {/* 动画类必须条件挂载：元素在 display:none 期间就存在，
          若无条件加 yq-fade-in，动画会在隐藏时播完并停在 opacity:0，
          之后只切 display 不会重播，浮层就看不见了 */}
      <div className={`yq-outline yq-outline-float ${hover ? 'yq-fade-in' : ''}`}>
        <div className="yq-outline-head">
          <span>大纲</span>
          <button
            className="yq-outline-pin is-active"
            onClick={() => { onModeChange('pinned'); setHover(false) }}
            title="钉住大纲"
          >
            <svg viewBox="0 0 14 14" width="12" height="12">
              <path
                d="M5 1.5h4l-.6 3.2 2.1 2.1H3.5l2.1-2.1L5 1.5zM7 6.8v5.7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        {body}
      </div>
    </div>
  )
}
