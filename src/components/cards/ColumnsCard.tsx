import { CardShell, MiniBtn, useCardDefaults } from './common'
import type { CardProps } from './types'

interface ColumnsData {
  cols?: string[]
}

const MIN = 2
const MAX = 3

/** 分栏卡片：2~3 栏，每栏可输入文字，可增删栏 */
export default function ColumnsCard({ data, onChange, readOnly }: CardProps<ColumnsData>) {
  useCardDefaults(data, onChange, { cols: ['', ''] })
  const cols = data?.cols && data.cols.length ? data.cols : ['', '']

  const setCol = (i: number, v: string) => onChange({ cols: cols.map((c, k) => (k === i ? v : c)) })
  const addCol = () => cols.length < MAX && onChange({ cols: [...cols, ''] })
  const removeCol = (i: number) => cols.length > MIN && onChange({ cols: cols.filter((_, k) => k !== i) })

  return (
    <CardShell
      icon="▥"
      title="分栏卡片"
      desc={`${cols.length} 栏`}
      actions={!readOnly ? <MiniBtn disabled={cols.length >= MAX} onClick={addCol}>+ 加一栏</MiniBtn> : null}
    >
      <div className="yq-kc-columns">
        {cols.map((c, i) => (
          <div className="yq-kc-col" key={i}>
            <div className="yq-kc-col-head">
              <span>第 {i + 1} 栏</span>
              <span className="yq-kc-flex" />
              {!readOnly && (
                <button className="yq-kc-btn is-danger" style={{ height: 18, padding: '0 5px' }}
                  disabled={cols.length <= MIN} onClick={() => removeCol(i)} title={cols.length <= MIN ? `至少保留 ${MIN} 栏` : '删除该栏'}>
                  ✕
                </button>
              )}
            </div>
            <textarea
              className="yq-kc-textarea"
              defaultValue={c}
              readOnly={readOnly}
              placeholder={`第 ${i + 1} 栏的内容`}
              onChange={(e) => setCol(i, e.target.value)}
            />
          </div>
        ))}
      </div>
      <div className="yq-kc-cols-bar">
        {!readOnly && <MiniBtn disabled={cols.length >= MAX} onClick={addCol}>+ 增加一栏</MiniBtn>}
        {!readOnly && (
          <MiniBtn disabled={cols.length <= MIN} onClick={() => removeCol(cols.length - 1)}>- 减少一栏</MiniBtn>
        )}
        <span className="yq-kc-hint">支持 {MIN}~{MAX} 栏</span>
      </div>
    </CardShell>
  )
}
