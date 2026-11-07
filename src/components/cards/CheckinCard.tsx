import { useStore } from '@/store'
import { CardShell, MiniBtn, todayYmd, ymd, useCardDefaults } from './common'
import type { CardProps } from './types'

interface CheckinData {
  span?: number
  /** 已打卡的日期 YYYY-MM-DD */
  dates?: string[]
}

/** 打卡卡片：7 格 / 30 格，连续天数统计（数据存在文档里，跟着文档走） */
export default function CheckinCard({ data, onChange, readOnly }: CardProps<CheckinData>) {
  useCardDefaults(data, onChange, { span: 7, dates: [] })
  const span = data?.span === 30 ? 30 : 7
  const dates = data?.dates ?? []
  const today = new Date()
  const todayStr = todayYmd()

  // 最近 span 天（含今天），从旧到新
  const days: { d: string; n: number }[] = Array.from({ length: span }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (span - 1 - i))
    return { d: ymd(d), n: span - i }
  })

  const on = dates.includes(todayStr)
  const toggle = () => {
    if (readOnly) return
    onChange({ dates: on ? dates.filter((d) => d !== todayStr) : [...dates, todayStr].sort() })
  }

  // 连续天数：从今天（或昨天，今天还没打时）往前数
  let streak = 0
  const set = new Set(dates)
  let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (!set.has(ymd(cursor))) cursor = new Date(cursor.getTime() - 86400000)
  while (set.has(ymd(cursor))) {
    streak++
    cursor = new Date(cursor.getTime() - 86400000)
  }
  /** 最长连续记录 */
  const longest = (() => {
    const sorted = [...dates].sort()
    let bestRun = 0
    let run = 0
    let prev = ''
    for (const s of sorted) {
      const gap = prev ? new Date(s).getTime() - new Date(prev).getTime() : 0
      run = gap === 86400000 ? run + 1 : 1
      bestRun = Math.max(bestRun, run)
      prev = s
    }
    return bestRun
  })()

  return (
    <CardShell
      icon="🗓"
      title="打卡"
      desc={`连续 ${streak} 天`}
      actions={
        <>
          <MiniBtn active={span === 7} onClick={() => onChange({ span: 7 })}>7 格</MiniBtn>
          <MiniBtn active={span === 30} onClick={() => onChange({ span: 30 })}>30 格</MiniBtn>
        </>
      }
    >
      <div className="yq-kc-checkin-stats">
        <span className="yq-kc-checkin-num">{streak}</span>
        <span className="yq-kc-checkin-unit">天连续打卡</span>
        <span className="yq-kc-flex" />
        <span className="yq-kc-checkin-unit">累计 {dates.length} 天 · 最长 {longest} 天</span>
      </div>
      <div className="yq-kc-checkin-grid">
        {days.map(({ d, n }) => (
          <button
            key={d}
            className={`yq-kc-checkin-cell ${set.has(d) ? 'is-on' : ''} ${d === todayStr ? 'is-today' : ''}`}
            disabled={readOnly}
            title={d}
            data-checkin={d}
            onClick={() => {
              // 只能操作今天及以前；点历史格子是补签/取消
              if (n > 1) {
                onChange({ dates: set.has(d) ? dates.filter((x) => x !== d) : [...dates, d].sort() })
              } else {
                toggle()
              }
            }}
          />
        ))}
      </div>
      <div className="yq-kc-checkin-foot">
        <MiniBtn active={on} disabled={readOnly} onClick={toggle}>
          {on ? '✓ 今天已打卡（点击取消）' : '打卡'}
        </MiniBtn>
        <span>点方格可补签 / 取消，打卡记录随文档保存</span>
      </div>
    </CardShell>
  )
}
