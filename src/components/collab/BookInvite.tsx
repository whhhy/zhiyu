/* ============================================================
   知识库邀请 —— 待办（工作台那一项）与发起入口（权限页）

   替换掉原来那个**纯客户端假数据**的协作列表：
     · 旧：collaborations 是种子数据，无服务端、无路由；
       服务端形态下侧栏已隐藏入口，但 `?tab=collab` 手敲仍能打开
       一个恒空的页面 + 两个只改本地状态的按钮。
     · 新：bookInvites 是**真的**服务端数据，接受后会真的进 book_members。
   ============================================================ */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '@/store'
import { getMode } from '@/lib/api'
import { Button, Empty, Input, Modal, Select, Tag } from '@/components/ui'
import { timeAgo } from '@/components/layout/TopBar'
import type { Member } from '@/types'

const ROLE_META = {
  editor: { label: '可编辑', color: 'primary' as const, verb: '一起编辑' },
  reader: { label: '可阅读', color: 'default' as const, verb: '查看' },
}

/* ---------------- 待办：工作台「协作」那一项 ---------------- */

/**
 * 挂载时拉一次待办。
 *
 * ⚠️ 为什么不在 store 初始化时拉：那时 AppGate 可能还在探测模式，
 *    直接请求会得到「接口不存在」并把控制台刷红。
 *    组件挂载时 getMode() 一定已经定了。
 */
export function BookInviteList() {
  const { bookInvites, refreshBookInvites, acceptBookInvite, rejectBookInvite, getMember } = useStore()
  const navigate = useNavigate()
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    void refreshBookInvites()
  }, [refreshBookInvites])

  /**
   * ⚠️ 本地模式下**不摆这个列表**。
   *
   * 本地模式没有服务端，邀请根本发不出去 —— 摆一个恒空的「没有待处理」
   * 等于骗人说「你收过邀请，都处理完了」。所以明确说清楚。
   */
  if (getMode() !== 'server') {
    return (
      <section>
        <div className="yq-section-title"><span>协作邀请</span></div>
        <Empty
          icon="🤝"
          text="邀请需要连着服务端才能用"
          action={<span style={{ fontSize: 12, color: 'var(--yq-text-4)' }}>当前是本地模式，数据只在你的浏览器里，别人看不到也发不过来</span>}
        />
      </section>
    )
  }

  const act = async (inv: { id: string; bookId: string }, accept: boolean) => {
    setBusy(inv.id)
    const okDone = accept ? await acceptBookInvite(inv.id) : await rejectBookInvite(inv.id)
    setBusy(null)
    // 接受成功就直接带他进那个库 —— 点「接受」的第一反应是「我能进去看看吗」
    if (okDone && accept) navigate(`/book/${inv.bookId}`)
  }

  /**
   * 待办列表只列**我收到的**。
   *
   * ⚠️ store 里的 `bookInvites` 现在同时含「我收到的」和「我发出的」
   *    （`GET /api/invites` 两边都返回，因为权限页的「等待对方处理」
   *    要靠它）。不按 `asReceiver` 过滤的话，
   *    用户会对着**自己发出去**的邀请看到「接受 / 拒绝」两个按钮。
   */
  const inbox = bookInvites.filter((i) => i.asReceiver !== false)

  return (
    <section>
      <div className="yq-section-title">
        <span>协作邀请</span>
        {inbox.length > 0 && <Tag size="sm" color="primary">{inbox.length} 条待处理</Tag>}
      </div>

      {inbox.length === 0 ? (
        <Empty
          icon="🤝"
          text="没有待处理的邀请"
          action={<span style={{ fontSize: 12, color: 'var(--yq-text-4)' }}>别人在知识库的「权限」里邀请你之后，会出现在这里</span>}
        />
      ) : (
        <div className="yq-collab-list">
          {inbox.map((inv) => {
            const from = getMember(inv.fromUserId)
            // 成员表里未必有这个人（他可能不在同一空间 / 列表还没加载完）。
            // 查不到就用服务端已经解析好的名字 —— 原来的写法在这里显示「有人」，
            // 用户根本不知道是谁在邀请他。
            const fromName = from?.name || inv.fromName || '有人'
            const meta = ROLE_META[inv.role] || ROLE_META.reader
            return (
              <div key={inv.id} className="yq-collab-item yq-card yq-card-hover">
                <div className="yq-flex-1" style={{ minWidth: 0 }}>
                  <div className="yq-collab-title">
                    <b>{fromName}</b> 邀请你{meta.verb}知识库《{inv.bookName}》
                  </div>
                  <div className="yq-list-row-meta">
                    <span>{timeAgo(inv.createdAt)}</span>
                    <Tag size="sm" color={meta.color}>{meta.label}</Tag>
                    {inv.message && <span className="yq-ellipsis">「{inv.message}」</span>}
                  </div>
                </div>
                <div className="yq-collab-actions">
                  <Button size="sm" variant="text" disabled={busy === inv.id} onClick={() => act(inv, false)}>
                    拒绝
                  </Button>
                  <Button size="sm" variant="primary" disabled={busy === inv.id} onClick={() => act(inv, true)}>
                    {busy === inv.id ? '处理中…' : '接受'}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/* ---------------- 发起邀请：知识库设置 → 权限 ---------------- */

/**
 * 在「添加成员」之外**另开一个入口**。
 *
 * 为什么不把两者合并：
 *   · 「添加成员」是**管理员直接生效**的（对方没机会拒绝）
 *   · 「邀请」是**发出去、等对方处理**的
 * 语义不同，合成一个弹窗就说不清到底发生了什么 ——
 * 而这一条恰恰是内网场景最需要说清的（把人拉进来和请人进来不是一回事）。
 */
export function InviteToBookDialog({
  bookId, open, onClose,
}: {
  bookId: string
  open: boolean
  onClose: () => void
}) {
  const { members, getBookMembers, inviteToBook, toast, currentUser } = useStore()
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState<'reader' | 'editor'>('reader')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)

  const already = useMemo(() => new Set(getBookMembers(bookId).map((m) => m.id)), [bookId, getBookMembers])
  const candidates = useMemo(
    () => (members as Member[]).filter((m) => m.id !== currentUser.id && !already.has(m.id)),
    [members, already, currentUser.id],
  )

  const submit = async () => {
    if (!userId) { toast('先选一个人', 'error'); return }
    setSending(true)
    const done = await inviteToBook(bookId, userId, role, message.trim())
    setSending(false)
    // 失败时 toast 已经说了原因，弹窗**留着** —— 关掉的话用户得重新填一遍
    if (done) { setUserId(''); setMessage(''); onClose() }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="邀请加入知识库"
      width={440}
      footer={
        <>
          <Button variant="text" disabled={sending} onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={sending || !userId} onClick={submit}>
            {sending ? '发送中…' : '发出邀请'}
          </Button>
        </>
      }
    >
      <p className="yq-bset-card-desc" style={{ marginBottom: 14 }}>
        发出之后<b>对方会看到一条待办</b>，可以接受也可以拒绝 —— 他不会自动获得权限。
        要让对方**直接生效**，用旁边的「添加成员」。
      </p>

      <label className="yq-bset-modal-label">邀请谁</label>
      {candidates.length === 0 ? (
        <Empty icon="👥" text="空间里的人都已经是这个知识库的成员了" />
      ) : (
        <Select
          value={userId}
          onChange={setUserId}
          options={[
            { value: '', label: '选一个人…' },
            ...candidates.map((m) => ({ value: m.id, label: `${m.name}（@${m.account}）` })),
          ]}
        />
      )}

      <label className="yq-bset-modal-label" style={{ marginTop: 14 }}>给什么权限</label>
      <Select
        value={role}
        onChange={(v) => setRole(v as 'reader' | 'editor')}
        options={[
          { value: 'reader', label: '阅读者 —— 只能看' },
          { value: 'editor', label: '编辑者 —— 能改、能新建' },
        ]}
      />
      <p className="yq-bset-modal-hint">
        这里只给这两种。要给管理员，去「成员与权限」里改 ——
        邀请入口直接发管理员的话，等于绕过了那次「你确定要让他管这个库吗」的确认。
      </p>

      <label className="yq-bset-modal-label" style={{ marginTop: 14 }}>说句话（可选）</label>
      <Input value={message} placeholder="比如：这份手册要一起维护" onChange={(e) => setMessage(e.target.value)} />
    </Modal>
  )
}
