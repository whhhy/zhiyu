import { useLayoutEffect, useRef, useState } from 'react'
import { CardShell, MiniBtn, uid, useCardDefaults } from './common'
import type { CardProps } from './types'

interface UmlClass {
  id: string
  name: string
  attrs: string
  methods: string
}
interface UmlRelation {
  from: string
  to: string
  label: string
}
interface UmlData {
  classes?: UmlClass[]
  relations?: UmlRelation[]
}

const DEFAULT: UmlClass[] = [
  { id: 'k1', name: 'User', attrs: '- id: string\n- name: string', methods: '+ login()\n+ logout()' },
  { id: 'k2', name: 'Order', attrs: '- id: string\n- amount: number', methods: '+ pay()\n+ cancel()' },
]
const COLS = 2
const GAP_X = 24
const GAP_Y = 20
const BOX_W = 152
const HEAD_H = 24

const splitLines = (s: string) => s.split('\n').filter((x) => x.trim())

/** UML 类图：可增删类/属性/方法，可加关系，虚线连到类之间 */
export default function UmlCard({ data, onChange, readOnly }: CardProps<UmlData>) {
  useCardDefaults(data, onChange, { classes: DEFAULT, relations: [] })
  const classes = data?.classes?.length ? data.classes : DEFAULT
  const relations = data?.relations ?? []
  const stageRef = useRef<HTMLDivElement>(null)
  const [lines, setLines] = useState<{ x1: number; y1: number; x2: number; y2: number }[]>([])

  const setClasses = (next: UmlClass[]) => onChange({ classes: next })

  // 类框位置是自动布局的，但框高随属性/方法行数变，连线要量了才知道。
  // 注意：measure 会在每次渲染后跑（要跟上 attrs/输入的变化），
  // 所以 setLines 必须做等值判断 —— 否则「新数组 → setState → 重渲染 → 再量」
  // 会把自己绕成死循环，标签页直接卡死。
  const measure = () => {
    const stage = stageRef.current
    if (!stage) return
    const base = stage.getBoundingClientRect()
    const next = relations
      .map((r) => {
        const a = stage.querySelector<HTMLElement>(`[data-uml-class="${r.from}"]`)
        const b = stage.querySelector<HTMLElement>(`[data-uml-class="${r.to}"]`)
        if (!a || !b) return null
        const ra = a.getBoundingClientRect()
        const rb = b.getBoundingClientRect()
        return {
          x1: (ra.right - base.left) + (rb.left < ra.left ? -6 : 6),
          y1: ra.top - base.top + HEAD_H / 2,
          x2: rb.left - base.left - (rb.left < ra.left ? 6 : -6),
          y2: rb.top - base.top + HEAD_H / 2,
        }
      })
      .filter(Boolean) as { x1: number; y1: number; x2: number; y2: number }[]
    setLines((prev) =>
      prev.length === next.length &&
      prev.every((l, i) => l.x1 === next[i].x1 && l.y1 === next[i].y1 && l.x2 === next[i].x2 && l.y2 === next[i].y2)
        ? prev
        : next,
    )
  }

  useLayoutEffect(measure) // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [relations, classes]) // eslint-disable-line react-hooks/exhaustive-deps

  const posOf = (i: number) => ({
    left: 12 + (i % COLS) * (BOX_W + GAP_X),
    top: 12 + Math.floor(i / COLS) * 140,
  })

  const addClass = () => setClasses([...classes, { id: uid('k'), name: 'NewClass', attrs: '- field: string', methods: '+ method()' }])
  const delClass = (id: string) =>
    onChange({ classes: classes.filter((c) => c.id !== id), relations: relations.filter((r) => r.from !== id && r.to !== id) })
  const addRelation = () => {
    if (classes.length < 2) return
    onChange({ relations: [...relations, { from: classes[0].id, to: classes[1].id, label: '关联' }] })
  }

  return (
    <CardShell
      icon="🔷"
      title="UML 图"
      desc={`${classes.length} 个类 / ${relations.length} 条关系`}
      actions={
        !readOnly ? (
          <>
            <MiniBtn onClick={addClass}>＋ 类</MiniBtn>
            <MiniBtn disabled={classes.length < 2} onClick={addRelation}>＋ 关系</MiniBtn>
          </>
        ) : null
      }
    >
      <div className="yq-kc-uml-stage" ref={stageRef} style={{ minHeight: 12 + Math.ceil(classes.length / COLS) * 140 }}>
        <svg className="yq-kc-uml-svg">
          {lines.map((l, i) => (
            <path
              key={i}
              className="yq-kc-uml-line"
              d={`M ${l.x1} ${l.y1} C ${(l.x1 + l.x2) / 2} ${l.y1}, ${(l.x1 + l.x2) / 2} ${l.y2}, ${l.x2} ${l.y2}`}
            />
          ))}
        </svg>
        {classes.map((c, i) => {
          const p = posOf(i)
          return (
            <div className="yq-kc-uml-box" key={c.id} data-uml-class={c.id} style={{ left: p.left, top: p.top, width: BOX_W }}>
              <div className="yq-kc-uml-name">
                <input
                  className="yq-ellipsis"
                  style={{ width: '100%', border: 0, background: 'none', font: 'inherit', color: 'inherit', textAlign: 'center', outline: 'none' }}
                  defaultValue={c.name}
                  readOnly={readOnly}
                  onChange={(e) => setClasses(classes.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)))}
                />
                {!readOnly && (
                  <button className="yq-kc-btn is-danger" style={{ height: 16, padding: '0 4px', marginLeft: 4 }}
                    onClick={() => delClass(c.id)}>✕</button>
                )}
              </div>
              <div className="yq-kc-uml-sec">
                {splitLines(c.attrs).map((a, ai) => (
                  <div key={ai}><em>-</em>{a.replace(/^[-+]/, '')}</div>
                ))}
              </div>
              <div className="yq-kc-uml-sec">
                {splitLines(c.methods).map((m, mi) => (
                  <div key={mi}><em>+</em>{m.replace(/^[-+]/, '')}</div>
                ))}
              </div>
              <div style={{ padding: '3px 6px', borderTop: '1px dashed var(--yq-border-1)' }}>
                <input
                  className="yq-kc-input"
                  style={{ height: 18, fontSize: 11, border: '1px solid transparent', background: 'none', padding: '0 2px' }}
                  defaultValue={c.attrs}
                  readOnly={readOnly}
                  placeholder="属性，一行一个"
                  onChange={(e) => setClasses(classes.map((x) => (x.id === c.id ? { ...x, attrs: e.target.value } : x)))}
                />
                <input
                  className="yq-kc-input"
                  style={{ height: 18, fontSize: 11, border: '1px solid transparent', background: 'none', padding: '0 2px' }}
                  defaultValue={c.methods}
                  readOnly={readOnly}
                  placeholder="方法，一行一个"
                  onChange={(e) => setClasses(classes.map((x) => (x.id === c.id ? { ...x, methods: e.target.value } : x)))}
                />
              </div>
            </div>
          )
        })}
      </div>
      <div className="yq-kc-uml-list">
        {relations.map((r, i) => (
          <span className="yq-kc-uml-item" key={i}>
            <span>
              {classes.find((c) => c.id === r.from)?.name || '?'} → {classes.find((c) => c.id === r.to)?.name || '?'}
            </span>
            {!readOnly && (
              <button className="yq-kc-btn is-danger" style={{ height: 16, padding: '0 4px' }}
                onClick={() => onChange({ relations: relations.filter((_, k) => k !== i) })}>✕</button>
            )}
          </span>
        ))}
      </div>
      <div className="yq-kc-hint" style={{ marginTop: 6 }}>
        框里的两个小输入框改属性/方法（一行一个，虚线是依赖关系）。
      </div>
    </CardShell>
  )
}
