import { CardShell, MiniBtn, humanDate, todayYmd, useCardDefaults } from './common'
import type { CardProps } from './types'

interface CalendarData {
  month?: string
  selected?: string
}

const DOW = ['一', '二', '三', '四', '五', '六', '日']

/** 日历卡片：月视图，点选日期，显示选中的日期 */
export default function CalendarCard({ data, onChange, readOnly }: CardProps<CalendarData>) {
  useCardDefaults(data, onChange, { month: todayYmd().slice(0, 7), selected: '' })
  const now = new Date()
  const month = data?.month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const [y, m] = month.split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  // 周一为一周之首：getDay() 的 0(周日) 换算成 6
  const lead = (first.getDay() + 6) % 7
  const days = new Date(y, m, 0).getDate()
  const today = todayYmd()

  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, i) => `${y}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`),
  ]
  while (cells.length % 7 !== 0) cells.push(null)

  const shift = (delta: number) => {
    const d = new Date(y, m - 1 + delta, 1)
    onChange({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` })
  }

  return (
    <CardShell
      icon="📅"
      title="日历"
      desc={data?.selected ? humanDate(data.selected) : '未选择日期'}
      actions={
        <>
          <MiniBtn onClick={() => shift(-1)} title="上个月">‹</MiniBtn>
          <MiniBtn onClick={() => onChange({ month: today.slice(0, 7) })}>本月</MiniBtn>
          <MiniBtn onClick={() => shift(1)} title="下个月">›</MiniBtn>
        </>
      }
    >
      <div className="yq-kc-cal">
        <div className="yq-kc-cal-head">
          <span className="yq-kc-cal-title">{y} 年 {m} 月</span>
          <span className="yq-kc-flex" />
          {data?.selected && !readOnly && <MiniBtn onClick={() => onChange({ selected: '' })}>清除</MiniBtn>}
        </div>
        <div className="yq-kc-cal-grid">
          {DOW.map((d) => (
            <div className="yq-kc-cal-dow" key={d}>{d}</div>
          ))}
          {cells.map((c, i) => (
            <button
              key={i}
              className={`yq-kc-cal-cell ${c ? '' : 'is-out'} ${c === today ? 'is-today' : ''} ${c && c === data?.selected ? 'is-sel' : ''}`}
              disabled={!c || readOnly}
              onClick={() => c && onChange({ selected: c })}
              data-date={c || undefined}
            >
              {c ? Number(c.slice(-2)) : ''}
            </button>
          ))}
        </div>
        <div className="yq-kc-cal-foot">
          <span>已选：</span>
          <span className="yq-kc-cal-sel">{data?.selected || '无'}</span>
        </div>
      </div>
    </CardShell>
  )
}
