import { CardShell, useCardDefaults } from './common'
import type { CardProps } from './types'

interface StatusData {
  status?: string
}

export const STATUSES: { id: string; label: string; cls: string }[] = [
  { id: 'todo', label: '待办', cls: 'is-todo' },
  { id: 'doing', label: '进行中', cls: 'is-doing' },
  { id: 'done', label: '已完成', cls: 'is-done' },
  { id: 'blocked', label: '阻塞', cls: 'is-blocked' },
  { id: 'review', label: '待评审', cls: 'is-review' },
  { id: 'cancel', label: '已取消', cls: 'is-cancel' },
]

export const statusMeta = (id?: string) => STATUSES.find((s) => s.id === id) || STATUSES[0]

/** 状态卡片：下拉选状态，带颜色，显示成小徽章 */
export default function StatusCard({ data, onChange, readOnly }: CardProps<StatusData>) {
  useCardDefaults(data, onChange, { status: 'todo' })
  const cur = statusMeta(data?.status)
  return (
    <CardShell icon="🚦" title="状态">
      <div className="yq-kc-status">
        <span className={`yq-kc-badge ${cur.cls}`} data-status={cur.id}>
          {cur.label}
        </span>
        <span className="yq-kc-flex" />
        <select
          className="yq-kc-select"
          style={{ width: 130 }}
          value={cur.id}
          disabled={readOnly}
          onChange={(e) => onChange({ status: e.target.value })}
        >
          {STATUSES.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>
    </CardShell>
  )
}
