import { CardShell, MiniBtn, uid, useCardDefaults } from './common'
import type { CardProps } from './types'

interface KbCard { id: string; text: string }
interface KbCol { id: string; name: string; cards: KbCard[] }
interface KanbanData {
  cols?: KbCol[]
}

const DEFAULT: KbCol[] = [
  { id: 'c1', name: '待办', cards: [] },
  { id: 'c2', name: '进行中', cards: [] },
  { id: 'c3', name: '已完成', cards: [] },
]

/** 看板卡片：列 + 卡片，可增删、可左右移动 */
export default function KanbanCard({ data, onChange, readOnly }: CardProps<KanbanData>) {
  useCardDefaults(data, onChange, { cols: DEFAULT })
  const cols = data?.cols?.length ? data.cols : DEFAULT
  const set = (next: KbCol[]) => onChange({ cols: next })

  const addCol = () => set([...cols, { id: uid('c'), name: `新列 ${cols.length + 1}`, cards: [] }])
  const addCard = (ci: number) => {
    const text = window.prompt('新卡片内容', '新任务')
    if (text == null) return
    set(cols.map((c, i) => (i === ci ? { ...c, cards: [...c.cards, { id: uid('k'), text }] } : c)))
  }
  const moveCard = (from: number, ci: number, di: number) => {
    const to = from + di
    if (to < 0 || to >= cols.length) return
    const card = cols[from].cards[ci]
    if (!card) return
    const next = cols.map((c) => ({ ...c, cards: [...c.cards] }))
    next[from].cards.splice(ci, 1)
    next[to].cards.push(card)
    set(next)
  }

  return (
    <CardShell
      icon="📋"
      title="看板"
      desc={`${cols.length} 列 / ${cols.reduce((n, c) => n + c.cards.length, 0)} 张卡`}
      actions={!readOnly ? <MiniBtn onClick={addCol}>＋ 列</MiniBtn> : null}
    >
      <div className="yq-kc-kanban">
        {cols.map((c, ci) => (
          <div className="yq-kc-kb-col" key={c.id}>
            <div className="yq-kc-kb-head">
              <input
                className="yq-kc-input"
                style={{ height: 20, padding: '0 4px', fontSize: 12, border: '1px solid transparent', background: 'none' }}
                defaultValue={c.name}
                readOnly={readOnly}
                onChange={(e) => set(cols.map((x, i) => (i === ci ? { ...x, name: e.target.value } : x)))}
              />
              <span className="yq-kc-kb-count">{c.cards.length}</span>
              <span className="yq-kc-flex" />
              {!readOnly && (
                <button className="yq-kc-btn is-danger" style={{ height: 18, padding: '0 4px' }}
                  disabled={cols.length <= 1}
                  onClick={() => set(cols.filter((_, i) => i !== ci))} title="删除该列">
                  ✕
                </button>
              )}
            </div>
            {c.cards.map((k, ki) => (
              <div className="yq-kc-kb-card" key={k.id}>
                <div className="yq-kc-kb-card-row">
                  <textarea
                    className="yq-kc-textarea"
                    defaultValue={k.text}
                    readOnly={readOnly}
                    rows={1}
                    onChange={(e) => set(cols.map((x, i) => (i === ci ? { ...x, cards: x.cards.map((y, j) => (j === ki ? { ...y, text: e.target.value } : y)) } : x)))}
                  />
                  {!readOnly && (
                    <>
                      <button className="yq-kc-btn" style={{ height: 18, padding: '0 4px' }} disabled={ci === 0}
                        onClick={() => moveCard(ci, ki, -1)} title="左移">‹</button>
                      <button className="yq-kc-btn" style={{ height: 18, padding: '0 4px' }} disabled={ci === cols.length - 1}
                        onClick={() => moveCard(ci, ki, 1)} title="右移">›</button>
                      <button className="yq-kc-btn is-danger" style={{ height: 18, padding: '0 4px' }}
                        onClick={() => set(cols.map((x, i) => (i === ci ? { ...x, cards: x.cards.filter((_, j) => j !== ki) } : x)))}>✕</button>
                    </>
                  )}
                </div>
              </div>
            ))}
            {!readOnly && <button className="yq-kc-kb-add" onClick={() => addCard(ci)}>＋ 添加卡片</button>}
          </div>
        ))}
      </div>
    </CardShell>
  )
}
