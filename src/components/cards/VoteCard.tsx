import { useStore } from '@/store'
import { CardShell, MiniBtn, uid, useCardDefaults } from './common'
import type { CardProps } from './types'

interface VoteOption {
  id: string
  text: string
  votes: string[]
}
interface VoteData {
  q?: string
  options?: VoteOption[]
  /** 当前用户投给了哪个选项 */
  myVote?: string
  closed?: boolean
}

const DEFAULT_OPTS: VoteOption[] = [
  { id: 'o1', text: '方案 A', votes: [] },
  { id: 'o2', text: '方案 B', votes: [] },
]

/** 投票卡片：问题 + 若干选项，可投，可看结果条 */
export default function VoteCard({ data, onChange, readOnly }: CardProps<VoteData>) {
  useCardDefaults(data, onChange, { q: '你更倾向哪个方案？', options: DEFAULT_OPTS, myVote: '', closed: false })
  const me = useStore((s) => s.currentUser.id)
  const q = data?.q ?? '你更倾向哪个方案？'
  const opts = data?.options?.length ? data.options : DEFAULT_OPTS
  const total = opts.reduce((n, o) => n + o.votes.length, 0)
  const my = opts.find((o) => o.id === data?.myVote)

  const vote = (id: string) => {
    if (readOnly || data?.closed) return
    // 改票：先从旧选项里摘掉自己
    const next = opts.map((o) => ({
      ...o,
      votes: o.votes.filter((v) => v !== me).concat(o.id === id ? [me] : []),
    }))
    onChange({ options: next, myVote: data?.myVote === id ? '' : id })
  }

  const addOpt = () => onChange({ options: [...opts, { id: uid('o'), text: `选项 ${opts.length + 1}`, votes: [] }] })
  const delOpt = (id: string) => onChange({ options: opts.filter((o) => o.id !== id), myVote: data?.myVote === id ? '' : data?.myVote })

  return (
    <CardShell
      icon="🗳"
      title="投票"
      desc={total ? `${total} 人已投` : '还没有人投票'}
      actions={
        !readOnly ? (
          <MiniBtn active={data?.closed} onClick={() => onChange({ closed: !data?.closed })}>
            {data?.closed ? '已结束' : '结束投票'}
          </MiniBtn>
        ) : null
      }
    >
      <input
        className="yq-kc-vote-q"
        defaultValue={q}
        readOnly={readOnly}
        placeholder="投票问题"
        onChange={(e) => onChange({ q: e.target.value })}
      />
      <div className="yq-kc-vote-opts">
        {opts.map((o) => {
          const pct = total ? Math.round((o.votes.length / total) * 100) : 0
          const isMine = o.id === data?.myVote
          return (
            <div className="yq-kc-vote-opt" key={o.id}>
              <div className="yq-kc-vote-main">
                <input
                  className="yq-kc-vote-text"
                  defaultValue={o.text}
                  readOnly={readOnly}
                  onChange={(e) => onChange({ options: opts.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)) })}
                />
                <span className="yq-kc-vote-num">
                  {o.votes.length} 票 · {pct}%
                </span>
                {!readOnly && (
                  <button className="yq-kc-btn is-danger" style={{ height: 20, padding: '0 5px' }} onClick={() => delOpt(o.id)} title="删除选项">
                    ✕
                  </button>
                )}
              </div>
              <div className="yq-kc-vote-bar">
                <div className={`yq-kc-vote-fill ${isMine ? 'is-mine' : ''}`} style={{ width: `${pct}%` }} />
              </div>
              <div className="yq-kc-row" style={{ marginTop: 3 }}>
                <MiniBtn active={isMine} disabled={data?.closed} onClick={() => vote(o.id)}>
                  {isMine ? '✓ 已投这票' : '投这一票'}
                </MiniBtn>
                {o.votes.length > 0 && (
                  <span className="yq-kc-hint">
                    {o.votes.length} 人：{o.votes.map((v) => v.replace(/^u/, '')).join('、')}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className="yq-kc-vote-foot">
        {!readOnly && <MiniBtn onClick={addOpt}>+ 增加选项</MiniBtn>}
        <span>{my ? `你投给了「${my.text}」` : '你还没投票'}</span>
        {data?.closed && <span className="yq-kc-badge is-cancel">已结束</span>}
      </div>
    </CardShell>
  )
}
