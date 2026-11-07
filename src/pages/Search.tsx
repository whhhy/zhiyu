import { useState, useMemo } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useBookStats } from '@/lib/useBookStats'
import { useStore } from '@/store'
import { Input, Segmented, Tag, Avatar, Empty, Tabs } from '@/components/ui'
import { timeAgo, DOC_TYPE_META } from '@/components/layout/TopBar'
import { useSearch, excerptOf } from '@/lib/useSearch'
import type { DocType } from '@/types'
import '../styles/layout.css'
import './Search.css'

/* ============================================================
   搜索结果页
   ============================================================ */

export default function Search() {
  const [params, setParams] = useSearchParams()
  const navigate = useNavigate()
  const { docs, nodes, books, notes, getMember } = useStore()
  const bs = useBookStats()
  const q = params.get('q') || ''
  const [input, setInput] = useState(q)
  const [scope, setScope] = useState('all')
  const [sort, setSort] = useState('relevance')

  const submit = (v: string) => {
    setInput(v)
    setParams(v ? { q: v } : {})
  }

  /**
   * 搜索走共用的 hook（src/lib/useSearch.ts）。
   * 顶栏 ⌘K 与这一页共用一份实现 —— 它们曾经各写各的，
   * 轻量启动之后只有顶栏那条路改成了服务端检索，这一页忘了改，
   * 结果「搜自己没打开过的文档」永远无结果。
   */
  const { docs: results, books: bookResults, notes: noteResults, total, loading, remote } =
    useSearch(q, scope, sort, 30)


  const highlight = (text: string) => {
    if (!q.trim()) return text
    const parts = text.split(new RegExp(`(${q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
    return parts.map((p, i) =>
      p.toLowerCase() === q.trim().toLowerCase() ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>,
    )
  }

  return (
    <div className="yq-dash">
      <div className="yq-searchpage-head">
        <Input
          size="lg"
          prefix={<span style={{ color: 'var(--yq-text-4)' }}>🔍</span>}
          placeholder="搜索文档、知识库、小记…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit(input)}
          autoFocus
        />
        <div className="yq-searchpage-filters">
          <Segmented
            size="sm"
            value={scope}
            onChange={setScope}
            options={[
              { value: 'all', label: '全部' },
              { value: 'mine', label: '我创建的' },
            ]}
          />
          <span className="yq-flex-1" />
          {q && <span className="yq-searchpage-count">找到 {total} 条结果</span>}
          <Segmented
            size="sm"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'relevance', label: '相关度' },
              { value: 'time', label: '时间' },
            ]}
          />
        </div>
      </div>

      {!q ? (
        <div className="yq-card" style={{ padding: 32 }}>
          <div className="yq-searchpage-hint">
            <h3>搜索能力</h3>
            <p>
              知语的搜索覆盖文档标题、正文与小记，并可按作者过滤。
            </p>
            {/*
              ⚠️ 原来这里写的是「覆盖文档标题、正文、**评论**与小记，
              并支持按**空间**与作者过滤」—— **两个词都是假的**：

                · 评论**根本没有进搜索索引**。服务端的 reindex 只有
                  doc / book / note **三种**索引行，前端本地那条
                  （docSearchText）也只取 blocks / body。
                · 也**没有空间筛选器**。上面那个筛选只有
                  全部 / 我创建的，scope 的类型就是 `'all' | 'mine'`。

              页面上写着一句自己做不到的话，比不写更糟 ——
              用户会以为「搜不到 = 这条评论不存在」，而那条评论就在那篇文档底下。

              ⇒ 按实现改成能兑现的那几句。要真加上评论/空间搜索，
              那是**改实现**，不是改文案 —— 那件事留到有人提需求时再做。
            */}
            <div className="yq-searchpage-tips">
              {['编辑器', '权限', '事故', '数据表', '报销'].map((k) => (
                <button key={k} onClick={() => submit(k)}>{k}</button>
              ))}
            </div>
          </div>
        </div>
      ) : total === 0 ? (
        <Empty icon="🔍" text={`没有找到与「${q}」相关的内容`} />
      ) : (
        <>
          {bookResults.length > 0 && (
            <section className="yq-searchpage-sec">
              <div className="yq-section-title"><span>知识库</span></div>
              <div className="yq-card">
                {bookResults.map((b) => (
                  <div key={b.id} className="yq-list-row" onClick={() => navigate(`/book/${b.id}`)}>
                    <span className="yq-list-icon">{b.avatar}</span>
                    <div className="yq-flex-1" style={{ minWidth: 0 }}>
                      <div className="yq-list-row-title">{highlight(b.name)}</div>
                      <div className="yq-list-row-meta">{highlight(b.desc)}</div>
                    </div>
                    <Tag>{bs(b).docCount} 篇</Tag>
                  </div>
                ))}
              </div>
            </section>
          )}

          {results.length > 0 && (
            <section className="yq-searchpage-sec">
              <div className="yq-section-title"><span>文档</span></div>
              <div className="yq-card">
                {/* 整个 hit 原样传下去：excerpt 由服务端给，
                    拆成 {doc, inTitle, ...} 再拼回去会把 excerpt 弄丢，
                    摘要就退化成读本地 body —— 而那里是空的。 */}
                {results.map((hit) => {
                  const { doc } = hit
                  const node = nodes.find((n) => n.docId === doc.id)
                  const book = books.find((b) => b.id === node?.bookId)
                  const author = getMember(doc.authorId)
                  return (
                    <div
                      key={doc.id}
                      className="yq-searchpage-hit"
                      onClick={() => node && navigate(`/book/${node.bookId}/doc/${doc.id}`)}
                    >
                      <div className="yq-searchpage-hit-title">
                        <span>{DOC_TYPE_META[(doc.type || 'doc') as DocType]?.icon ?? '📄'}</span>
                        {highlight(doc.title)}
                      </div>
                      <div className="yq-searchpage-hit-excerpt">{highlight(excerptOf(hit, q))}</div>
                      <div className="yq-searchpage-hit-meta">
                        <span>{book?.name}</span>
                        <span>·</span>
                        <span>{author?.name}</span>
                        <span>·</span>
                        <span>{timeAgo(doc.updatedAt)}</span>
                        {doc.tags.map((t: string) => <Tag key={t} size="sm">{t}</Tag>)}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {noteResults.length > 0 && (
            <section className="yq-searchpage-sec">
              <div className="yq-section-title"><span>小记</span></div>
              <div className="yq-card">
                {noteResults.map((n) => (
                  <div key={n.id} className="yq-list-row" onClick={() => navigate('/notes')}>
                    <span className="yq-list-icon">🗒️</span>
                    <div className="yq-flex-1" style={{ minWidth: 0 }}>
                      <div className="yq-searchpage-hit-excerpt" style={{ marginTop: 0 }}>{highlight(n.text)}</div>
                      <div className="yq-list-row-meta">
                        <span>{getMember(n.authorId)?.name}</span>
                        <span>·</span>
                        <span>{timeAgo(n.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  )
}
