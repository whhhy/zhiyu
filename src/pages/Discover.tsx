import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useBookStats } from '@/lib/useBookStats'
import { useStore } from '@/store'
import { Avatar, Tag, Segmented } from '@/components/ui'
import { timeAgo } from '@/components/layout/TopBar'
import '../styles/layout.css'

/* ============================================================
   发现 —— 最近更新 / 知识库 / 讨论区
   ------------------------------------------------------------
   这里的两个 tab 名以前和内容对不上：

   · 「热门内容」其实**没有热度**。代码是
     `[...published, ...Object.values(docs).slice(0, 6)]` ——
     「已发布的」加上「前 6 篇」，既不是热门也不是最近，
     只是数组的前几项。列一个不存在的排行，比不列更糟。
     现在改成真按更新时间排序，标签也说实话。
   · 「公开知识库」列的是**全部**知识库（公开 / 空间内 / 私密都列）。
     演示数据里一个 public 的都没有，所以按标签过滤的话这一页永远是空的 ——
     但那正是事实：没人把知识库设成公开。
     既然标签做不到与内容一致，就把标签改成内容实际的样子。
   ============================================================ */

export default function Discover() {
  const navigate = useNavigate()
  const { books, docs, nodes, getMember, topics, getTopicReplyCount } = useStore()
  const bs = useBookStats()
  const [tab, setTab] = useState('recent')

  // 真按最近更新排序。已经能读到的文稿（服务端按权限过滤过）就是全部来源。
  const recent = useMemo(
    () => Object.values(docs).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 8),
    [docs],
  )

  return (
    <div className="yq-dash">
      <header className="yq-dash-header">
        <div>
          <h1 className="yq-dash-greeting">发现</h1>
          <p className="yq-dash-date">看看你最近能读到的文稿、知识库和讨论</p>
        </div>
      </header>

      <div style={{ marginBottom: 20 }}>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'recent', label: '最近更新' },
            { value: 'books', label: '全部知识库' },
            { value: 'topic', label: '讨论区' },
          ]}
        />
      </div>

      {tab === 'recent' && (
        <div className="yq-discover-grid">
          {recent.length === 0 ? (
            <div className="yq-card" style={{ gridColumn: '1 / -1', padding: 40, textAlign: 'center' }}>
              还没有可以看的文稿 —— 权限范围内的文稿会出现在这里。
            </div>
          ) : (
            recent.map((d) => {
              const node = nodes.find((n) => n.docId === d.id)
              const author = getMember(d.authorId)
              const book = books.find((b) => b.id === node?.bookId)
              return (
                <div
                  key={d.id}
                  className="yq-discover-card yq-card yq-card-hover"
                  onClick={() => node && navigate(`/book/${node.bookId}/doc/${d.id}`)}
                >
                  <div className="yq-discover-card-head">
                    <span className="yq-discover-card-type">{d.type === 'doc' ? '📄' : d.type === 'sheet' ? '📊' : '🎨'}</span>
                    {d.published && <Tag color="green" size="sm">已发布</Tag>}
                  </div>
                  <h3 className="yq-discover-card-title yq-clamp-2">{d.title}</h3>
                  <p className="yq-discover-card-desc yq-clamp-3">{d.body.replace(/[#>*`|-]/g, '').slice(0, 110)}</p>
                  <div className="yq-discover-card-foot">
                    <Avatar name={author?.name || '?'} size={20} />
                    <span className="yq-ellipsis">{author?.name}</span>
                    <span className="yq-flex-1" />
                    <span>{book?.name}</span>
                    <span>·</span>
                    <span>{timeAgo(d.updatedAt)}</span>
                  </div>
                </div>
              )
            })
          )}
        </div>
      )}

      {tab === 'books' && (
        <div className="yq-discover-grid">
          {books.map((b) => (
            <div key={b.id} className="yq-discover-card yq-card yq-card-hover" onClick={() => navigate(`/book/${b.id}`)}>
              <div className="yq-discover-card-head">
                <span style={{ fontSize: 26 }}>{b.avatar}</span>
                <Tag color={b.visibility === 'public' ? 'green' : 'default'} size="sm">
                  {b.visibility === 'public' ? '公开' : b.visibility === 'private' ? '私密' : '空间内'}
                </Tag>
              </div>
              <h3 className="yq-discover-card-title">{b.name}</h3>
              <p className="yq-discover-card-desc yq-clamp-2">{b.desc}</p>
              <div className="yq-discover-card-foot">
                <span>{bs(b).docCount} 篇文档</span>
                <span>·</span>
                <span>{(bs(b).wordCount / 10000).toFixed(1)}w 字</span>
                <span className="yq-flex-1" />
                <span>{timeAgo(b.updatedAt)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'topic' && (
        <div className="yq-card">
          {topics.map((t) => {
            const a = getMember(t.authorId)
            return (
              <div key={t.id} className="yq-list-row" onClick={() => navigate(`/knowledge/${t.id}`)}>
                <span className="yq-list-icon">{t.hot ? '🔥' : '💬'}</span>
                <div className="yq-flex-1" style={{ minWidth: 0 }}>
                  <div className="yq-list-row-title">{t.title}</div>
                  <div className="yq-list-row-meta">
                    <span>{a?.name} 发起</span>
                    <span>·</span>
                    <span>{getTopicReplyCount(t.id)} 条回复</span>
                    <span>·</span>
                    <span>{timeAgo(t.createdAt)}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
