import { useRef, useState } from 'react'
import { CardShell, MiniBtn, uid, useCardDefaults } from './common'
import type { CardProps } from './types'

interface FlowNode {
  id: string
  text: string
  x: number
  y: number
}
interface FlowEdge {
  from: string
  to: string
}
interface FlowData {
  nodes?: FlowNode[]
  edges?: FlowEdge[]
}

/** 画布设计坐标：固定一套坐标系，容器变窄时按比例缩放，拖动时再换算回来 */
const W = 620
const H = 300
const NW = 118
const NH = 34

const DEFAULT_NODES: FlowNode[] = [
  { id: 'a', text: '开始', x: 30, y: 40 },
  { id: 'b', text: '处理', x: 240, y: 130 },
  { id: 'c', text: '结束', x: 450, y: 40 },
]
const DEFAULT_EDGES: FlowEdge[] = [
  { from: 'a', to: 'b' },
  { from: 'b', to: 'c' },
]

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** 连线路径：从源节点右侧中点贝塞尔到目标节点左侧中点 */
function edgePath(a: FlowNode, b: FlowNode) {
  const x1 = a.x + NW
  const y1 = a.y + NH / 2
  const x2 = b.x
  const y2 = b.y + NH / 2
  const dx = Math.max(28, Math.abs(x2 - x1) * 0.45)
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`
}

/**
 * 流程图卡片：节点可增删、可拖动，从节点右侧圆点拉线连到另一个节点。
 *
 * 拖动和拉线的监听器都在 pointerdown 里【同步】挂到 window 上，
 * 不用 useEffect：pointermove 属于连续事件，React 会把 passive effect 降级延迟，
 * 手一快（连续事件在 effect 挂上之前就发完了）就整段丢失，表现为「拖不动 / 线拉不上」。
 */
export default function FlowchartCard({ data, onChange, readOnly }: CardProps<FlowData>) {
  useCardDefaults(data, onChange, { nodes: DEFAULT_NODES, edges: DEFAULT_EDGES })
  const nodes = data?.nodes?.length ? data.nodes : DEFAULT_NODES
  const edges = data?.edges ?? DEFAULT_EDGES
  const [dragId, setDragId] = useState<string | null>(null)
  const [link, setLink] = useState<{ from: string; x: number; y: number; over: string } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  const byId = (id: string) => nodes.find((n) => n.id === id)

  /** 页面坐标 → 画布设计坐标 */
  const toCanvas = (clientX: number, clientY: number) => {
    const rect = boxRef.current!.getBoundingClientRect()
    return {
      x: (clientX - rect.left) * (W / rect.width),
      y: (clientY - rect.top) * (H / rect.height),
    }
  }

  const startDrag = (e: React.PointerEvent, n: FlowNode) => {
    if (readOnly) return
    const { x, y } = toCanvas(e.clientX, e.clientY)
    const dx = x - n.x
    const dy = y - n.y
    let raf = 0
    const onMove = (ev: PointerEvent) => {
      ev.preventDefault()
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const p = toCanvas(ev.clientX, ev.clientY)
        const nx = clamp(Math.round(p.x - dx), 0, W - NW)
        const ny = clamp(Math.round(p.y - dy), 0, H - NH)
        onChange({ nodes: nodes.map((t) => (t.id === n.id ? { ...t, x: nx, y: ny } : t)) })
      })
    }
    const onUp = () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setDragId(null)
    }
    window.addEventListener('pointermove', onMove, { passive: false })
    window.addEventListener('pointerup', onUp)
    setDragId(n.id)
  }

  const startLink = (e: React.PointerEvent, n: FlowNode) => {
    if (readOnly) return
    e.stopPropagation()
    let cur = { from: n.id, x: n.x + NW, y: n.y + NH / 2, over: '' }
    setLink(cur)
    const onMove = (ev: PointerEvent) => {
      const p = toCanvas(ev.clientX, ev.clientY)
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const over = el?.closest<HTMLElement>('[data-flow-node]')?.dataset.flowNode ?? ''
      cur = { ...cur, x: p.x, y: p.y, over }
      setLink(cur)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setLink(null)
      if (!cur.over || cur.over === cur.from) return
      if (edges.some((e2) => e2.from === cur.from && e2.to === cur.over)) return
      onChange({ edges: [...edges, { from: cur.from, to: cur.over }] })
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const addNode = () =>
    onChange({
      nodes: [
        ...nodes,
        {
          id: uid('f'),
          text: '新节点',
          x: 20 + ((nodes.length * 61) % (W - NW - 30)),
          y: 20 + ((nodes.length * 47) % (H - NH - 30)),
        },
      ],
    })
  const delNode = (id: string) =>
    onChange({ nodes: nodes.filter((n) => n.id !== id), edges: edges.filter((e) => e.from !== id && e.to !== id) })
  const delEdge = (i: number) => onChange({ edges: edges.filter((_, k) => k !== i) })

  const linkFrom = link ? byId(link.from) : null

  return (
    <CardShell
      icon="📐"
      title="流程图"
      desc={`${nodes.length} 节点 / ${edges.length} 连线`}
      actions={
        !readOnly ? (
          <>
            <MiniBtn onClick={addNode}>＋ 节点</MiniBtn>
            {edges.length > 0 && <MiniBtn danger onClick={() => onChange({ edges: [] })}>清空连线</MiniBtn>}
          </>
        ) : null
      }
    >
      <div className="yq-kc-flow">
        <div className="yq-kc-flow-canvas" ref={boxRef} style={{ height: H }}>
          <svg className="yq-kc-flow-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            <defs>
              <marker id="yqkc-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M0 0 L7 3.5 L0 7 z" fill="var(--yq-border-3)" />
              </marker>
              <marker id="yqkc-arrow-new" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto">
                <path d="M0 0 L7 3.5 L0 7 z" fill="var(--yq-primary)" />
              </marker>
            </defs>
            {edges.map((e, i) => {
              const a = byId(e.from)
              const b = byId(e.to)
              if (!a || !b) return null
              return (
                <g key={i}>
                  <path className="yq-kc-flow-edge" d={edgePath(a, b)} markerEnd="url(#yqkc-arrow)" />
                  {!readOnly && (
                    <circle
                      cx={(a.x + NW + b.x) / 2}
                      cy={(a.y + b.y) / 2 + NH / 2}
                      r="5"
                      fill="var(--yq-danger)"
                      style={{ pointerEvents: 'all', cursor: 'pointer' }}
                      onClick={() => delEdge(i)}
                    >
                      <title>点击删除连线</title>
                    </circle>
                  )}
                </g>
              )
            })}
            {link && linkFrom && (
              <path
                className="yq-kc-flow-edge is-new"
                d={`M ${linkFrom.x + NW} ${linkFrom.y + NH / 2} L ${link.x} ${link.y}`}
                markerEnd="url(#yqkc-arrow-new)"
              />
            )}
          </svg>

          {nodes.map((n) => (
            <div
              key={n.id}
              className={`yq-kc-flow-node ${dragId === n.id ? 'is-dragging' : ''} ${link?.over === n.id ? 'is-target' : ''}`}
              data-flow-node={n.id}
              style={{
                left: (n.x / W) * 100 + '%',
                top: (n.y / H) * 100 + '%',
                width: (NW / W) * 100 + '%',
                height: NH,
              }}
              onPointerDown={(e) => {
                if (readOnly) return
                if ((e.target as HTMLElement).classList.contains('yq-kc-flow-port')) return
                startDrag(e, n)
              }}
            >
              <input
                className="yq-kc-flow-node-text"
                defaultValue={n.text}
                readOnly={readOnly}
                onChange={(e) => onChange({ nodes: nodes.map((x) => (x.id === n.id ? { ...x, text: e.target.value } : x)) })}
              />
              {!readOnly && (
                <>
                  <button
                    className="yq-kc-flow-port"
                    title="从这里拉线连到另一个节点"
                    onPointerDown={(e) => startLink(e, n)}
                  />
                  <button
                    className="yq-kc-flow-port is-del"
                    title="删除节点"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => delNode(n.id)}
                  >
                    ✕
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="yq-kc-flow-bar">
          <span className="yq-kc-flow-hint">拖节点改位置 · 从右侧蓝点拉到别的节点连线 · 点连线上的红点删除</span>
        </div>
      </div>
    </CardShell>
  )
}
