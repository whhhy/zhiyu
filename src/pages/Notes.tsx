import { useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '@/store'
import { useSpacePerms } from '@/lib/perms'
import { Avatar, Button, Tag, Input, Empty, Segmented } from '@/components/ui'
import { timeAgo } from '@/components/layout/TopBar'
import '../styles/layout.css'
import './Notes.css'

/* ============================================================
   小记 —— 基于时间线的碎片记录
   ============================================================ */

export default function Notes() {
  const navigate = useNavigate()
  const { notes, addNote, likeNote, getMember, currentUser, activeSpaceId, topics, getTopicReplyCount, toast } = useStore()
  const [text, setText] = useState('')
  const [tab, setTab] = useState('all')

  /**
   * 权限第一道。这一页以前也没挂任何 hook —— `spaceCapsSync` 读不到就放行。
   * 而 `TopBar` 预热的是**当前空间**的判据，恰好就是这里用的那个，
   * 所以它多半能读到；挂上是为了不依赖「别的页面碰巧问过」这件事。
   */
  const spaceCaps = useSpacePerms(activeSpaceId)
  const canComment = spaceCaps !== null && spaceCaps.comment

  const space = useStore.getState().spaces.find((s) => s.id === activeSpaceId)
  const list = notes.filter((n) => (tab === 'mine' ? n.authorId === currentUser.id : true))

  const submit = () => {
    if (!text.trim()) return
    /*
     * ⚠️ 这里原来是无条件 `addNote(...)` 之后 `setText('')` ——
     * 没有空间发言权时 store 默默拒掉，而**用户写的小记被清空了，零提示**。
     * 和话题回复同一形状（`KnowledgeDetail`）：内容丢了比「点了没反应」更糟。
     */
    if (!addNote(activeSpaceId, text.trim())) {
      toast('在这个空间里没有发言权限，小记没有存进去（内容已保留）', 'error')
      return
    }
    setText('')
  }

  return (
    <div className="yq-dash">
      <header className="yq-notes-header">
        <div>
          <h1 className="yq-dash-greeting">小记</h1>
          <p className="yq-dash-date">随手记录零散想法，按时间线沉淀，整理时可以一键转成文档</p>
        </div>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'all', label: '全部' },
            { value: 'mine', label: '我写的' },
          ]}
        />
      </header>

      {/* 输入框 */}
      <div className="yq-notes-composer yq-card">
        {!canComment ? (
          // 没发言权就整块早退，别给一个「能写但发不出去」的框 ——
          // 用户白写一段才知道不行，比一开始就说清楚糟得多。
          <div className="yq-notes-composer-foot" style={{ width: '100%' }}>
            <span className="yq-notes-count">在这个空间里没有发言权限，不能发小记。</span>
          </div>
        ) : (
          <>
        <div className="yq-notes-composer-row">
          <Avatar name={currentUser.name} size={32} />
          <textarea
            className="yq-notes-input"
            placeholder={`在「${space?.name}」记一笔…  支持 ⌘ + Enter 快速发布`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
            }}
          />
        </div>
        {text.trim() && (
          <div className="yq-notes-composer-foot">
            <span className="yq-notes-count">{text.length} 字</span>
            <span className="yq-flex-1" />
            <Button variant="text" size="sm" onClick={() => setText('')}>取消</Button>
            <Button variant="green" size="sm" onClick={submit} disabled={!text.trim()}>
              发布小记
            </Button>
          </div>
        )}
          </>
        )}
      </div>

      {/* 时间线 */}
      {list.length === 0 ? (
        <Empty icon="🗒️" text="还没有小记，上面写一条吧" />
      ) : (
        <div className="yq-notes-timeline">
          {list.map((n) => {
            const a = getMember(n.authorId)
            const liked = n.likes.includes(currentUser.id)
            return (
              <div key={n.id} className="yq-note">
                <div className="yq-note-rail">
                  <Avatar name={a?.name || '?'} size={32} />
                  <span className="yq-note-line" />
                </div>
                <div className="yq-note-body yq-card yq-card-hover">
                  <div className="yq-note-head">
                    <b>{a?.name}</b>
                    <span>{timeAgo(n.createdAt)}</span>
                  </div>
                  <p className="yq-note-text">{n.text}</p>
                  {n.image && <img src={n.image} className="yq-note-img" alt="" />}
                  <div className="yq-note-foot">
                    {n.tags.map((t) => <Tag key={t} size="sm">{t}</Tag>)}
                    <span className="yq-flex-1" />
                    <button
                      className={`yq-note-act ${liked ? 'is-liked' : ''}`}
                      onClick={() => likeNote(n.id)}
                    >
                      {liked ? '❤️' : '🤍'} {n.likes.length || ''}
                    </button>
                    <button
                      className="yq-note-act"
                      onClick={() => {
                        const st = useStore.getState()
                        const book = st.books.find((b) => b.spaceId === activeSpaceId)
                        // 空间里还没有知识库时，原来会 createDoc('') 建出一篇
                        // 无归属的文稿，然后跳到 /book/undefined/doc/xxx
                        if (!book) { st.toast('这个空间还没有知识库，先建一个再转', 'error'); return }
                        const flat = n.text.replace(/\s+/g, ' ').trim()
                        const head = flat.slice(0, 18) + (flat.length > 18 ? '…' : '')
                        const id = st.createDoc(
                          book.id,
                          null,
                          head,
                          'doc',
                          [
                            { id: 'bk_h1_' + Date.now().toString(36), type: 'h1', text: '' },
                            // 关键：把**整条小记**带过来。以前只拿前 18 个字当标题，
                            // 正文一个字没留 —— 「转为文档」变成了「转为空文档」。
                            { id: 'bk_p_' + Date.now().toString(36), type: 'p', text: n.text },
                          ],
                        )
                        if (!id) { st.toast('转换失败', 'error'); return }
                        const node = useStore.getState().nodes.find((x) => x.docId === id)
                        st.toast('已转为文档', 'success')
                        if (node) navigate(`/book/${node.bookId}/doc/${id}`)
                      }}
                      title="转为文档"
                    >
                      📄 转为文档
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* 相关话题 */}
      {topics.length > 0 && (
        <section className="yq-notes-topics">
          <div className="yq-section-title"><span>讨论区</span></div>
          <div className="yq-card">
            {topics.map((t) => (
              <div key={t.id} className="yq-list-row" onClick={() => navigate(`/knowledge/${t.id}`)}>
                <span className="yq-list-icon">{t.hot ? '🔥' : '💬'}</span>
                <div className="yq-flex-1" style={{ minWidth: 0 }}>
                  <div className="yq-list-row-title yq-ellipsis">{t.title}</div>
                  <div className="yq-list-row-meta">{getTopicReplyCount(t.id)} 条回复</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
