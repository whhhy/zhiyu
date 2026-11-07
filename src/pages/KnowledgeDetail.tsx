import { useParams, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { useStore } from '@/store'
import { useSpacePerms } from '@/lib/perms'
import { Avatar, Button, Empty, Tag } from '@/components/ui'
import { timeAgo } from '@/components/layout/TopBar'
import '../styles/layout.css'
import './Help.css'

/* ============================================================
   话题详情 —— 讨论区
   ------------------------------------------------------------
   这一页以前是**整个假的**，而且四处都假得不一样：

   1. 回复列表是组件里写死的 5 条（`SEED_REPLIES`），只活在 useState 里 ——
      刷新就没、换设备看不见、发出去的东西存不住。
      界面上却和真评论长得一模一样，用户会理所当然地以为它是存的。
   2. 「赞」按钮**根本没有 onClick**。纯装饰，点下去什么都不发生。
   3. 回复条数写的是 `replies.length + topic.replyCount` ——
      把本地假回复数和种子里的历史值相加，是在编数字。
      而 Dashboard / 发现 / 小记 / 顶栏 5 处也都在直接显示 `topic.replyCount`。
   4. 正文那句「这个问题没有标准答案，想听听大家的看法」是**写死的**，
      每一个话题都显示这一句，包括标题是「Q3 OKR 初稿征求意见」的那个。

   现在回复是真的独立实体（`topic_replies`，权限跟父话题所在空间走），
   条数一律用 `getTopicReplyCount()` 取真数，「赞」直接去掉 ——
   少一个按钮好过一个点了没反应的按钮。
   ============================================================ */

export default function KnowledgeDetail() {
  const { topicId } = useParams()
  const navigate = useNavigate()
  const { getMember, currentUser, getTopicReplies, getTopicReplyCount, getTopicParticipants, replyToTopic, toast } = useStore()
  const topic = useStore((s) => s.topics.find((t) => t.id === topicId))
  const [text, setText] = useState('')

  /**
   * 权限第一道，挂**在页面**上。
   *
   * 这一页以前一个权限 hook 都没挂 —— 而 store 的 `spaceCommentBlocked`
   * 边界是「**问过**且没有才拦」，所以这里的 caps 常常是 `null` → 放行。
   * 而 `TopBar` 只预热**当前空间**：话题属于别的空间时，那份判据从来没被问过。
   *
   * 判据与服务端 `denyReason` 同源（`capsInSpace().comment`），
   * fail closed：没问回来时按「不能」处理。
   */
  const spaceCaps = useSpacePerms(topic?.spaceId)
  const canComment = spaceCaps !== null && spaceCaps.comment

  if (!topic) {
    return <div style={{ padding: 40 }}><Empty icon="🫥" text="话题不存在" /></div>
  }

  const author = getMember(topic.authorId)
  // 真回复，不带假数据
  const replies = getTopicReplies(topic.id)
  const count = getTopicReplyCount(topic.id)
  // 参与者调 store 那个统一口径（发起人 + 真正回过帖的人）
  // ——工作台的话题卡片原先自己读那个从不维护的 `participants` 快照，
  //   于是同一件事两页一个对一个错。两边现在都调同一个函数。
  const participants = getTopicParticipants(topic.id)

  const submit = () => {
    const t = text.trim()
    if (!t) return
    /*
     * ⚠️ 这里原来是无条件 `replyToTopic(...)` 之后 `setText('')`。
     * 而被拒时（没有空间的发言权）store 默默拒掉 ——
     * **用户写的整段回复就这样被清空了，一条提示都没有**。
     * 那比「点了没反应」更糟：内容丢了，用户会以为系统吞了他的草稿。
     *
     * 现在只有**真的发出去**才清空；被拒就说清楚为什么，并留着原文。
     */
    if (!replyToTopic(topic.id, t)) {
      toast('在这个空间里没有发言权限，回复没有发出去（内容已保留）', 'error')
      return
    }
    setText('')
  }

  return (
    <div className="yq-dash yq-dash-narrow">
      <header className="yq-topic-header">
        <button className="yq-topic-back" onClick={() => navigate('/')}>← 返回讨论区</button>
        <h1 className="yq-topic-title">{topic.title}</h1>
        <div className="yq-topic-meta">
          <Avatar name={author?.name || '?'} size={22} />
          <span>{author?.name}</span>
          <span>·</span>
          <span>{timeAgo(topic.createdAt)}</span>
          <span>·</span>
          <span>{count} 条回复</span>
          <span className="yq-flex-1" />
          <div className="yq-topic-participants">
            {participants.slice(0, 6).map((p, i) => (
              <Avatar key={i} name={getMember(p)?.name || '?'} size={22} />
            ))}
          </div>
        </div>
      </header>

      {/*
        这里原来有一段写死的正文（「这个问题没有标准答案…」），
        每一个话题都显示它，包括标题是「Q3 OKR 初稿征求意见」的那个。
        话题的正文本身就在标题里，再编一段通用文案只会让人以为是模板。
        真要支持话题正文，应该给 topics 加一个 body 字段 —— 现在没有，就不假装有。
      */}

      <div className="yq-topic-replies">
        {replies.length === 0 ? (
          <Empty icon="💬" text="还没有回复，抢沙发" />
        ) : (
          replies.map((r) => {
            const a = getMember(r.authorId)
            const mine = r.authorId === currentUser.id
            return (
              <div key={r.id} className="yq-card yq-topic-reply">
                <Avatar name={a?.name || '?'} size={30} />
                <div className="yq-flex-1" style={{ minWidth: 0 }}>
                  <div className="yq-topic-reply-meta">
                    <b>{a?.name || '未知成员'}</b>
                    <span>{timeAgo(r.createdAt)}</span>
                    {r.authorId === topic.authorId && <Tag size="sm" color="primary">发起人</Tag>}
                    {mine && <Tag size="sm">我</Tag>}
                  </div>
                  <p className="yq-topic-reply-text">{r.text}</p>
                  <div className="yq-topic-reply-foot">
                    <button onClick={() => setText((v) => `${v}@${a?.name || ''} `)}>回复</button>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="yq-topic-composer yq-card">
        <Avatar name={currentUser.name} size={32} />
        {!canComment ? (
          // 没有发言权就不给输入框：整个组件**早退**，
          // 而不是给一个「能打字但发不出去」的框（那样用户会白写一段）。
          <div className="yq-topic-composer-foot" style={{ width: '100%' }}>
            <span className="yq-topic-send-note">在这个空间里没有发言权限，无法回复。</span>
          </div>
        ) : (
          <>
        <textarea
          className="yq-topic-input"
          placeholder="写下你的看法…（⌘ + Enter 发送）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
          }}
        />
        <div className="yq-topic-composer-foot">
          {/*
            这行说明是有意加的：这个页面的回复**以前存不住**，
            用户很可能已经踩过一次「发出去刷新就没」。先讲清楚发出去会存到哪。
          */}
          <span className="yq-topic-send-note">回复会保存到本工作台，换设备登录也看得见</span>
          <span className="yq-flex-1" />
          <Button variant="primary" size="sm" onClick={submit} disabled={!text.trim()}>发表回复</Button>
        </div>
          </>
        )}
      </div>
    </div>
  )
}
