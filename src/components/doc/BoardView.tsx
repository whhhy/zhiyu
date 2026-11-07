import { useEffect, useMemo, useRef, useState } from 'react'
import type { BoardCard, BoardShape, Doc } from '@/types'
import { Dropdown, MenuItem, MenuLabel, Tooltip } from '@/components/ui'
import {
  boardAddCard, boardAddEdge, boardEdgesOf, boardLayout, boardPatchCard, boardRemoveCard,
  boardRemoveEdge, boardToJSON, downloadJSON, PALETTE, SHAPES, useDocSection,
} from './sheetStore'
import './index.css'

/* ============================================================
   画板 —— 自由放置便签，用于流程图 / 架构图 / 脑图
   卡片位置 / 底色 / 形状 / 连线全部落在 doc.sheetData.board，
   刷新后按原样恢复；窄屏重排只作用于显示，不会覆盖用户摆好的位置。
   ============================================================ */

/**
 * 下载文件名。纯中文标题在部分浏览器（无头 Chromium 就是）会被丢成 "download"，
 * 所以这里兜一个 ASCII 名，实在取不到可用字符就用文档 id。
 */
function jsonName(doc: Doc) {
  const t = (doc.title || '').trim()
  if (!/[\w-]/.test(t)) return `board-${doc.id}.json`
  return `${t.replace(/[^\w.-]+/g, '_')}.json`
}

export default function BoardView({ doc, readOnly }: { doc: Doc; readOnly?: boolean }) {
  const [data, setData] = useDocSection(doc.id, 'board', readOnly)
  const [selected, setSelected] = useState<string | null>(null)
  const [linkFrom, setLinkFrom] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<BoardCard[] | null>(null)
  const [vp, setVp] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth))
  const [fullscreen, setFullscreen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const drag = useRef<{ id: string; sx: number; sy: number; x: number; y: number } | null>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)

  /** 视口宽度：窄屏按两列错位重排（只改显示） */
  useEffect(() => {
    let last = window.innerWidth
    const sync = () => {
      if (Math.abs(window.innerWidth - last) < 8) return
      last = window.innerWidth
      setVp(window.innerWidth)
      setSelected(null)
    }
    window.addEventListener('resize', sync)
    return () => window.removeEventListener('resize', sync)
  }, [])

  useEffect(() => {
    if (editing && textRef.current) textRef.current.focus()
  }, [editing])

  const canvasW = fullscreen ? Math.max(320, vp - 32) : Math.max(280, vp - 48)
  // auto：窄屏自动重排；free：用户摆过位置，一切以数据为准
  const shown = useMemo(
    () => draft ?? (data.layout === 'auto' ? boardLayout(data.cards, vp, canvasW) : data.cards),
    [draft, data.cards, data.layout, vp, canvasW],
  )

  const sel = data.cards.find((c) => c.id === selected) || null

  /* ---------------- 拖拽 ---------------- */

  const onMouseDown = (e: React.MouseEvent, c: BoardCard) => {
    if (e.button !== 0) return
    setSelected(c.id)
    // 连线模式 / 正在改文字时不启动拖拽
    if (readOnly || editing === c.id || linkFrom) return
    // 只记起点和位移，不在每一帧重读画布 rect：
    // 选中卡片会让次级工具条出现、画布整体下移一截，每帧重量的算法
    // 会把这次位移算进卡片坐标里，松手时卡片就偏了。
    drag.current = { id: c.id, sx: e.clientX, sy: e.clientY, x: c.x, y: c.y }
  }

  const onMouseMove = (e: React.MouseEvent) => {
    const d = drag.current
    if (!d) return
    const x = Math.max(0, Math.round(d.x + (e.clientX - d.sx)))
    const y = Math.max(0, Math.round(d.y + (e.clientY - d.sy)))
    setDraft(shown.map((c) => (c.id === d.id ? { ...c, x, y } : c)))
  }

  /** 拖完落盘：显示坐标即数据坐标，同时把布局切成 free，之后不再被窄屏重排改写 */
  const endDrag = () => {
    if (!drag.current) return
    drag.current = null
    if (draft) setData({ ...data, cards: draft, layout: 'free' })
    setDraft(null)
  }

  /* ---------------- 增删改 ---------------- */

  const addCard = () => {
    const next = boardAddCard(data)
    setData(next.data)
    setSelected(next.id)
    setLinkFrom(null)
  }

  const removeCard = (id: string) => {
    setData(boardRemoveCard(data, id))
    setSelected(null)
    if (editing === id) setEditing(null)
  }

  const patch = (id: string, p: Partial<BoardCard>) => setData(boardPatchCard(data, id, p))

  const onCardClick = (c: BoardCard) => {
    if (linkFrom) {
      if (linkFrom !== c.id) setData(boardAddEdge(data, linkFrom, c.id))
      setLinkFrom(null)
      return
    }
    setSelected(c.id)
  }

  const edges = sel ? boardEdgesOf(data, sel.id) : []
  const nameOf = (id: string) => data.cards.find((c) => c.id === id)?.text || '?'
  const json = boardToJSON(data)

  return (
    <div className={`yq-board ${fullscreen ? 'yq-board-fs' : ''}`}>
      <div className="yq-board-bar">
        <span className="yq-board-title">画板 · {doc.title}</span>
        <span className="yq-dt-count">{data.cards.length} 张卡片 · {data.edges.length} 条连线</span>
        <span className="yq-flex-1" />
        {!readOnly && (
          <>
            <span className="yq-board-label">卡片底色</span>
            {PALETTE.map((c) => (
              <button
                key={c}
                className={`yq-board-swatch ${sel?.color === c ? 'is-active' : ''}`}
                style={{ background: c }}
                title="设置选中卡片底色"
                onClick={() => sel && patch(sel.id, { color: c })}
              />
            ))}
            <Dropdown
              width={140}
              trigger={(open, toggle) => (
                <button className={`yq-board-btn ${open ? 'is-open' : ''}`} disabled={!sel} onClick={toggle}>
                  形状 ▾
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuLabel>卡片形状</MenuLabel>
                  {SHAPES.map((s) => (
                    <MenuItem
                      key={s.value}
                      icon={sel?.shape === s.value ? '●' : '○'}
                      disabled={!sel}
                      onClick={() => { if (sel) patch(sel.id, { shape: s.value as BoardShape }); close() }}
                    >
                      {s.label}
                    </MenuItem>
                  ))}
                </>
              )}
            </Dropdown>
            <button className="yq-board-btn" onClick={() => setData({ ...data, background: data.background === 'grid' ? 'plain' : 'grid' })}>
              {data.background === 'grid' ? '▦ 网格底' : '▢ 纯色底'}
            </button>
            <button className="yq-board-add" onClick={addCard}>＋ 添加卡片</button>
            {sel && (
              <button
                className={`yq-board-btn ${linkFrom ? 'is-on' : ''}`}
                onClick={() => setLinkFrom(linkFrom ? null : sel.id)}
              >
                {linkFrom ? '取消连线' : '⇢ 连线'}
              </button>
            )}
            {sel && <button className="yq-board-btn" onClick={() => setEditing(sel.id)}>✎ 编辑文字</button>}
          </>
        )}
        <button className="yq-board-btn" onClick={() => setExportOpen((v) => !v)}>⇩ JSON</button>
        <button className="yq-board-btn" onClick={() => setFullscreen(true)}>⛶ 全屏</button>
        {fullscreen && (
          <button className="yq-board-btn" onClick={() => setFullscreen(false)}>← 退出全屏</button>
        )}
        {!readOnly && sel && <button className="yq-board-del" onClick={() => removeCard(sel.id)}>删除选中</button>}
      </div>

      <div
        className={`yq-board-canvas ${data.background === 'plain' ? 'is-plain' : ''}`}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onClick={(e) => { if (e.target === e.currentTarget) { setSelected(null); setLinkFrom(null) } }}
      >
        {/* SVG 连线 */}
        <svg className="yq-board-lines" width="100%" height="100%">
          {data.edges.map((e) => {
            const a = shown.find((c) => c.id === e.from)
            const b = shown.find((c) => c.id === e.to)
            if (!a || !b) return null
            const highlighted = selected === a.id || selected === b.id
            return (
              <path
                key={e.id}
                d={`M ${a.x + a.w} ${a.y + a.h / 2} C ${a.x + a.w + 40} ${a.y + a.h / 2}, ${b.x - 40} ${b.y + b.h / 2}, ${b.x} ${b.y + b.h / 2}`}
                fill="none"
                stroke={highlighted ? 'var(--yq-primary)' : 'var(--yq-border-2)'}
                strokeWidth={highlighted ? 2 : 1.5}
                markerEnd="url(#arrow)"
              />
            )
          })}
          <defs>
            <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
              <path d="M0,0 L0,6 L7,3 z" fill="var(--yq-border-2)" />
            </marker>
          </defs>
        </svg>

        {shown.map((c) => (
          <div
            key={c.id}
            data-card-id={c.id}
            className={`yq-board-card is-${c.shape} ${selected === c.id ? 'is-selected' : ''} ${
              linkFrom === c.id ? 'is-linkfrom' : ''
            } ${linkFrom && linkFrom !== c.id ? 'is-linkable' : ''}`}
            style={{ left: c.x, top: c.y, width: c.w, height: c.h, background: c.color }}
            onMouseDown={(e) => onMouseDown(e, c)}
            onClick={(e) => { e.stopPropagation(); onCardClick(c) }}
            onDoubleClick={() => !readOnly && setEditing(c.id)}
          >
            {editing === c.id ? (
              <textarea
                ref={textRef}
                className="yq-board-edit"
                value={c.text}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => patch(c.id, { text: e.target.value })}
                onBlur={() => setEditing(null)}
                onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null) }}
              />
            ) : (
              <span className="yq-board-text">{c.text}</span>
            )}
          </div>
        ))}
      </div>

      {/* 连线 / 导出 等次级操作 */}
      {(sel || exportOpen) && (
        <div className="yq-board-sub">
          {sel && (
            <>
              <span className="yq-board-label">连线</span>
              {edges.length === 0 && <span className="yq-dt-count">这张卡片还没有连线</span>}
              {edges.map((e) => (
                <span className="yq-board-chip" key={e.id}>
                  {nameOf(e.from)} → {nameOf(e.to)}
                  <button title="删除连线" onClick={() => setData(boardRemoveEdge(data, e.id))}>✕</button>
                </span>
              ))}
            </>
          )}
          {exportOpen && (
            <div className="yq-board-export">
              <div className="yq-board-export-head">
                <b>导出 JSON</b>
                <span className="yq-dt-count">{data.cards.length} 张卡片 / {data.edges.length} 条连线</span>
                <span className="yq-flex-1" />
                <button
                  className="yq-board-btn is-primary"
                  onClick={() => downloadJSON(jsonName(doc), json)}
                >
                  ⇩ 下载
                </button>
              </div>
              <pre className="yq-board-json">{json}</pre>
            </div>
          )}
        </div>
      )}

      {!readOnly && (
        <div className="yq-board-foot">
          <span className="yq-dt-count">拖动卡片可重新排布 · 双击卡片改文字</span>
          <span className="yq-flex-1" />
          {linkFrom && <span className="yq-dt-count">已选中起点「{nameOf(linkFrom)}」，再点一张卡片连成线</span>}
          <Tooltip title="清空画板上的全部卡片与连线">
            <button className="yq-board-btn is-danger" onClick={() => { setData({ ...data, cards: [], edges: [] }); setSelected(null) }}>
              清空画板
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  )
}
