import { useStore } from '@/store'
import { CardShell, MiniBtn } from './common'
import type { CardProps } from './types'

interface MentionData {
  memberId?: string
}

/** 提及卡片：选成员，显示成 @名字 的彩色 chip */
export default function MentionCard({ data, onChange, readOnly }: CardProps<MentionData>) {
  const members = useStore((s) => s.members)
  const cur = members.find((m) => m.id === data?.memberId)

  return (
    <CardShell
      icon="@"
      title="提及"
      desc={cur ? `@${cur.name}` : '选一位成员'}
      actions={cur && !readOnly ? <MiniBtn onClick={() => onChange({ memberId: '' })}>清除</MiniBtn> : null}
    >
      <div className="yq-kc-mention">
        {cur ? (
          <span className="yq-chip" data-member={cur.id}>
            <span className="yq-chip-avatar">{cur.avatar}</span>
            @{cur.name}
          </span>
        ) : (
          <span className="yq-kc-hint">还没选人</span>
        )}
      </div>
      <div className="yq-kc-picker-list">
        {members.map((m) => (
          <button
            key={m.id}
            className="yq-kc-picker-item"
            disabled={readOnly}
            onClick={() => onChange({ memberId: m.id })}
            title={`${m.name} · ${m.account}`}
          >
            <span className="yq-chip-avatar">{m.avatar}</span>
            {m.name}
            {cur?.id === m.id ? ' ✓' : ''}
          </button>
        ))}
      </div>
    </CardShell>
  )
}
