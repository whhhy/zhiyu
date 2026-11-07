import { Link } from 'react-router-dom'
import { useStore } from '@/store'
import { CardShell, MiniBtn } from './common'
import type { CardProps } from './types'

interface YqDocData {
  docId?: string
}

/** 语雀内容卡片：选一篇已有文档，插一个可点的文档卡片（站内链接，真实可用） */
export default function YuqueDocCard({ data, onChange, readOnly }: CardProps<YqDocData>) {
  const docs = useStore((s) => s.docs)
  const nodes = useStore((s) => s.nodes)
  const all = Object.values(docs)
  const cur = data?.docId ? docs[data.docId] : null
  const nodeOf = (id: string) => nodes.find((n) => n.docId === id)

  return (
    <CardShell
      icon="🪶"
      title="知语内容"
      desc={cur ? '已选择一篇文档' : '选一篇文档'}
      actions={cur && !readOnly ? <MiniBtn onClick={() => onChange({ docId: '' })}>清除</MiniBtn> : null}
    >
      {cur ? (
        <Link className="yq-kc-yqdoc" to={`/book/${nodeOf(cur.id)?.bookId || ''}/doc/${cur.id}`}>
          <span className="yq-kc-yqdoc-icon">📄</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span className="yq-kc-yqdoc-title yq-ellipsis" style={{ display: 'block' }}>{cur.title || '未命名'}</span>
            <span className="yq-kc-yqdoc-meta">
              {cur.wordCount} 字 · {cur.blocks.length} 块 · 更新于 {new Date(cur.updatedAt).toLocaleDateString('zh-CN')}
            </span>
          </span>
          <span className="yq-kc-btn">打开</span>
        </Link>
      ) : (
        <div className="yq-kc-hint">还没选文档</div>
      )}
      <div className="yq-kc-picker-list">
        {all.slice(0, 12).map((d) => (
          <button key={d.id} className="yq-kc-picker-item" disabled={readOnly}
            onClick={() => onChange({ docId: d.id })} title={`${d.title} · ${d.wordCount} 字`}>
            📄 {d.title || '未命名'}
            {data?.docId === d.id ? ' ✓' : ''}
          </button>
        ))}
      </div>
    </CardShell>
  )
}
