import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useStore } from '@/store'
import { Avatar, Tag, Button, Segmented, Modal, Input, Checkbox, Select, Empty } from '@/components/ui'
import { spaceMembers as loadSpaceMembers, addSpaceMember, removeSpaceMember, type SpaceMember } from '@/lib/api'
import '../styles/layout.css'
import './Dashboard.css'

/* ============================================================
   空间设置 —— 照真实语雀的位置结构（2026-10-16）
   ------------------------------------------------------------
   语雀官方《如何删除空间》：「空间管理员可以在**空间管理-空间设置-高级设置**中
   找到空间的删除入口」；官方《如何设置空间管理员》又说
   「成员可以在工作台点击**左上角空间名称旁边的下拉按钮**」进入空间管理。

   所以语雀这边是**三级**：空间管理 → 空间设置 → 高级设置。

   ⚠️⚠️ 2026-10-16 之前，这个按钮直接摆在**空间页右上角**，和「新建空间」
   「新建知识库」并排。规则（谁能删、验口令、24 小时撤销）是对的，
   **位置是错的** —— 而且错在要紧的地方：

   「删除整个空间」是一个会级联抹掉 books/nodes/docs 整棵树的不可逆操作，
   却和「新建一个知识库」用同样的视觉权重、同样的位置。
   这不是好看不好看的问题，是**危险操作没有和常用操作分开**。

   所以现在拆成三个标签，删除只在「高级设置」里出现：
   · 基本信息 —— 空间名/简介/类型/成员数，只读展示
   · 成员       —— 从空间页正文搬过来的成员管理（space_members 不走同步，
                  所以这里显示的一律是服务端说了算的结果）
   · 高级设置   —— 危险区，删除空间
   ============================================================ */

const SPACE_ROLE_LABEL: Record<string, string> = { owner: '拥有者', admin: '管理员', member: '成员' }

type TabKey = 'basic' | 'members' | 'advanced'

export default function SpaceSettings() {
  const { spaceId } = useParams()
  const navigate = useNavigate()
  const { spaces, books, spaceCaps, loadSpaceCaps } = useStore()
  const [tab, setTab] = useState<TabKey>('basic')
  /*
   * ⚠️ 标签要**从 URL 读**（2026-10-17 补）。
   *
   * `Space.tsx` 那一行「空间成员（6）→」链过来时带的是
   * `?tab=members`，而这里原来只有一句 `useState('basic')` ——
   * 于是点过去**停在「基本信息」**，看起来像「点了没反应」。
   * 而成员管理整个搬到这一页之后，空间页上就只剩这一个入口，
   * 它失灵 = 那条路直接断了。
   */
  const [sp] = useSearchParams()
  const urlTab = sp.get('tab') as TabKey | null
  useEffect(() => {
    if (urlTab === 'basic' || urlTab === 'members' || urlTab === 'advanced') setTab(urlTab)
  }, [urlTab])
  const [roster, setRoster] = useState<SpaceMember[] | null>(null)
  const [rosterErr, setRosterErr] = useState('')
  const [delOpen, setDelOpen] = useState(false)

  const space = spaces.find((s) => s.id === spaceId)
  const sid = space?.id

  /* 权限判据与空间页同一份：`useSpacePerms` 写进 store 的 spaceCaps。
     不用前端自己的角色猜 —— 服务端才是判的那个。 */
  const isAdmin = spaceCaps[String(space?.id || '')]?.admin === true

  /**
   * ⚠️ **必须自己问一次空间权限**（2026-10-17 修）。
   *
   * `spaceCaps` 是由 `useSpacePerms` / `loadSpaceCaps` 灌进 store 的，
   * 而**只有空间页 Space.tsx 调了它**。成员管理搬到这一页之后，
   * 直接进来时 `spaceCaps` 是空的 → `isAdmin` 恒为 false →
   * **管理员看到的是一份只读名册，「添加成员」按钮整个不见了**。
   *
   * 症状特别像「把管理员权限做没了」，而它其实是「这一页没去问」。
   */
  useEffect(() => { if (sid) loadSpaceCaps(sid) }, [sid, loadSpaceCaps])

  const loadRoster = useCallback(async () => {
    if (!sid) return
    setRoster(null); setRosterErr('')
    try {
      const r = await loadSpaceMembers(sid)
      setRoster(r.members || [])
    } catch (e: any) {
      setRosterErr(e?.message || '成员名单加载失败')
    }
  }, [sid])

  useEffect(() => {
    // 换空间时先清空：不清的话会拿上一个空间的名单冒充新空间的
    setRoster(null); setRosterErr('')
    loadRoster()
  }, [loadRoster])

  if (!space) {
    return (
      <div className="yq-dash yq-dash-narrow">
        <Empty icon="🫥" text="空间不存在或你无权访问" action={
          <Button variant="default" onClick={() => navigate('/')}>回到工作台</Button>
        } />
      </div>
    )
  }

  const isTeam = space.kind === 'team'

  return (
    <div className="yq-dash yq-dash-narrow">
      <header className="yq-dash-header">
        <div>
          <h1 className="yq-dash-greeting">{space.name} · 设置</h1>
          <p className="yq-dash-date">
            {isTeam ? '团队空间' : '个人空间'} · 空间管理员才能改这里的设置
          </p>
        </div>
        <Button variant="default" onClick={() => navigate(`/space/${space.id}`)}>返回空间</Button>
      </header>

      <div style={{ marginBottom: 20 }}>
        <Segmented
          value={tab}
          onChange={(v) => setTab(v as TabKey)}
          options={[
            { value: 'basic', label: '基本信息' },
            { value: 'members', label: '成员' },
            { value: 'advanced', label: '高级设置' },
          ]}
        />
      </div>

      {tab === 'basic' && (
        <section className="yq-card" style={{ padding: 20 }}>
          <div className="yq-space-hero-head" style={{ marginBottom: 16 }}>
            <div className="yq-space-hero-avatar">{space.avatar}</div>
            <div>
              <h2 className="yq-space-hero-name">{space.name}</h2>
              <p className="yq-space-hero-desc">{space.desc || '（没有写简介）'}</p>
            </div>
          </div>
          <div className="yq-space-hero-stats" style={{ borderTop: '1px solid var(--yq-border-1)' }}>
            <div><b>{isTeam ? '团队空间' : '个人空间'}</b><span>类型</span></div>
            <div><b>{roster ? roster.length : '—'}</b><span>成员</span></div>
            <div><b>{new Date(space.createdAt).toLocaleDateString('zh-CN')}</b><span>创建于</span></div>
          </div>
          {/*
            改名/改简介刻意**没做**。
            界面上摆一个改不了的输入框，比不摆更糟 ——
            「看得见、点不动、又没说明为什么」正是这个项目反复在修的那一类。
            真要做的前提是服务端有对应的写接口和权限判定，现在两边都没有。
          */}
          <p className="yq-settings-hint" style={{ marginTop: 16 }}>
            空间名称与简介目前由创建时确定，暂不支持在这里修改。
            空间成员请到「成员」标签管理。
          </p>
        </section>
      )}

      {tab === 'members' && (
        <SpaceMembers
          spaceId={String(sid || '')}
          kind={space.kind}
          roster={roster}
          error={rosterErr}
          isAdmin={isAdmin}
          onRefresh={loadRoster}
        />
      )}

      {tab === 'advanced' && (
        <section className="yq-card" style={{ padding: 20 }}>
          <div className="yq-settings-title">危险操作</div>
          <p className="yq-settings-desc" style={{ marginTop: 6 }}>
            这一页里的操作会影响到**整个空间**，包括它下面所有知识库与文档。
          </p>

          {!isAdmin ? (
            <p className="yq-settings-hint" style={{ marginTop: 16 }}>
              只有空间管理员可以删除空间。如果需要，请联系该空间的拥有者。
            </p>
          ) : (
            <div style={{ marginTop: 18, paddingTop: 16, borderTop: '1px solid var(--yq-border-1)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 240 }}>
                  <div style={{ fontWeight: 600, color: 'var(--yq-text-1)' }}>删除这个空间</div>
                  <div style={{ fontSize: 13, color: 'var(--yq-text-3)', marginTop: 4, lineHeight: 1.6 }}>
                    连同它下面的全部知识库和文档一起删除。需要验证登录口令，
                    删除后 <b>24 小时内</b>可以撤销，超过就<b>不可逆</b>了。
                  </div>
                </div>
                <Button variant="danger" onClick={() => setDelOpen(true)}>删除空间</Button>
              </div>
            </div>
          )}
        </section>
      )}

      <DeleteSpaceDialog
        open={delOpen}
        onClose={() => setDelOpen(false)}
        spaceId={String(sid || '')}
        spaceName={space.name}
        /*
         * 连带动几个库必须说**真实数字**，不能在弹窗里写「若干」。
         * 之前那个占位的 0 看着无害，但它会让人以为「删一个空空间」，
         * 而实际可能连着几十篇文档。
         */
        bookCount={books.filter((b) => b.spaceId === space.id).length}
      />
    </div>
  )
}

/* ============================================================
   删除空间 / 撤销删除（2026-10-16 · 照真实语雀）
   ------------------------------------------------------------
   语雀官方《如何删除空间》：「空间管理员可以在空间管理-空间设置-高级设置中
   找到空间的删除入口」「需要验证之后删除：删除操作后 24 小时内可以进行撤销，
   超过 24 小时即确认，确认后删除不可逆转」。

   这个弹窗刻意把三件事都摊开写出来，因为**每少写一件都会变成另一种伤害**：
   · 连带删掉几个知识库 —— 空间的 books/nodes/docs 是级联的，
     用户以为「删个空间」，实际是一整棵树；
   · 回收站里**找不回来** —— 语雀的回收站只到文档一级，
     空间进撤销窗口之后，文档本身并没有进回收站；
   · 24 小时之后不可逆 —— 不说这句，用户会以为「待会儿再找管理员恢复」。

   口令输入框是**必须的**，不是保险起见：服务端会验，
   空提交会被 400 挡回来 —— 界面不给这个框，用户就只能一次次失败。
   ============================================================ */
export function DeleteSpaceDialog({
  open, onClose, spaceId, spaceName, bookCount,
}: {
  open: boolean
  onClose: () => void
  spaceId: string
  spaceName: string
  bookCount: number
}) {
  const deleteSpace = useStore((s) => s.deleteSpace)
  const restoreSpace = useStore((s) => s.restoreSpace)
  const toast = useStore((s) => s.toast)
  const navigate = useNavigate()
  const [pwd, setPwd] = useState('')
  const [busy, setBusy] = useState(false)
  const [undoUntil, setUndoUntil] = useState(0)
  /*
   * ⚠️ 目标空间 id 必须在**打开时**锁定，不能一直跟着 `spaceId` 这个 prop 走。
   *
   * `spaceId` 是 `String(space?.id || '')`，而 Space 页里的 `space` 是
   * `spaces.find(...) || spaces[0]` —— **删掉之后它会回退到别的空间**。
   * 于是删除成功 → store 提交 → 重渲染 → prop 变成另一个空间的 id →
   * 提示条上那个「撤销」闭包拿到的是错的 id → 点下去 404「空间不存在」。
   *
   * 症状离原因很远（用户只看到「撤销」没反应），所以钉在这里。
   */
  const [targetId, setTargetId] = useState('')
  const [targetName, setTargetName] = useState('')

  useEffect(() => {
    if (open) { setPwd(''); setUndoUntil(0); setTargetId(spaceId); setTargetName(spaceName) }
  }, [open, spaceId, spaceName])

  const run = async () => {
    if (!pwd) { toast('请输入登录口令', 'error'); return }
    const id = targetId
    const name = targetName
    setBusy(true)
    try {
      const r = await deleteSpace(id, pwd)
      if (!r) { toast('删除失败，空间没有被删掉', 'error'); return }
      const n = r.deletedBooks
      /*
       * 「撤销」挂在**提示条**上，不留在弹窗里 ——
       * 删完立刻跳走的话，弹窗和它一起没了，等于「给了 24 小时反悔期，
       * 却没人找得到那 24 小时」。提示条是唯一活过导航的常驻表面。
       */
      toast(
        n ? `空间「${name}」已删除，连同 ${n} 个知识库` : `空间「${name}」已删除`,
        'success',
        { label: '撤销删除', run: () => { void undo(id, name) } },
      )
      setUndoUntil(Number(r.undoUntil || 0))
      navigate('/')
    } catch (err: any) {
      toast(err?.message || '删除失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const undo = async (id: string, name: string) => {
    try {
      if (await restoreSpace(id)) {
        toast(`空间「${name}」已恢复`, 'success')
        setUndoUntil(0)
        navigate(`/space/${id}`)
      } else {
        toast('撤销失败：可能已经超过 24 小时', 'error')
      }
    } catch (err: any) {
      toast(err?.message || '撤销失败', 'error')
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={undoUntil ? '空间已删除' : `删除空间「${spaceName}」`}
      width={520}
      footer={
        undoUntil ? (
          <Button
            variant="primary"
            disabled={busy}
            /*
             * ⚠️ 这里原来写的是 `onClick={undo}` ——
             *   `undo(id, name)` 要两个参数，而点击处理器只会传一个事件对象，
             *   于是 `restoreSpace(MouseEvent)` 拿到的是鼠标事件。
             *   结果：删除空间之后，弹窗里这个「撤销删除」**按下去没反应**。
             *   （删除成功那一下 toast 上的「撤销删除」是对的 —— 那是
             *    `run: () => { void undo(id, name) }`，显式包了一层。）
             *
             * 用的是 `targetId`/`targetName` 而不是 `spaceId`/`spaceName` ——
             * 删掉之后那两个 prop 会回退到**别的空间**（见上面那段注释），
             * 那样撤销就作用到错的空间上了。
             */
            onClick={() => void undo(targetId, targetName)}
          >
            撤销删除
          </Button>
        ) : (
          <>
            <Button variant="text" onClick={onClose} disabled={busy}>取消</Button>
            <Button variant="danger" disabled={busy || !pwd} onClick={run}>
              {busy ? '删除中…' : '确认删除'}
            </Button>
          </>
        )
      }
    >
      {undoUntil ? (
        <>
          <p>这个空间和它下面的 {bookCount} 个知识库已经进入撤销窗口。</p>
          <p>
            <b>24 小时内</b>可以点「撤销删除」把它整个拿回来；
            超过 24 小时就<b>不可逆</b>了，回收站里也找不回来
            （回收站只到文档一级，空间删除是另一回事）。
          </p>
        </>
      ) : (
        <>
          <p>即将删除空间「{spaceName}」，<b>连同它下面的 {bookCount} 个知识库和全部文档</b>。</p>
          <ul style={{ margin: '8px 0', paddingLeft: 20, color: 'var(--yq-text-3)' }}>
            <li>删除后 <b>24 小时内</b>可以撤销，24 小时后<b>不可逆</b>；</li>
            <li>回收站里<b>找不回来</b> —— 回收站只到文档一级；</li>
            <li>这是不可逆操作，需要验证你的登录口令。</li>
          </ul>
          <label style={{ display: 'block', marginTop: 12 }}>
            <span style={{ fontSize: 13, color: 'var(--yq-text-2)' }}>登录口令</span>
            <Input
              type="password"
              value={pwd}
              onChange={(e: any) => setPwd(e.target.value)}
              placeholder="输入你的登录口令以确认"
              style={{ marginTop: 4 }}
            />
          </label>
        </>
      )}
    </Modal>
  )
}

/* ============================================================
   空间成员
   ------------------------------------------------------------
   以前这里**一个入口都没有**：团队空间建出来之后就只有建的人一个，
   别人连进来的路径都没有 —— 空间从「一个容器」退化成「一个私有文件夹」。

   名单不写进 store（`space_members` 不走同步，写进去会和真实权限分叉）：
   改完直接重新拉接口，界面显示的一律是服务端说了算的结果。
   ============================================================ */

export function SpaceMembers({
  spaceId, kind, roster, error, isAdmin, onRefresh,
}: {
  spaceId: string
  kind?: string
  roster: SpaceMember[] | null
  error: string
  isAdmin: boolean
  onRefresh: () => void
}) {
  const members = useStore((s) => s.members)
  const currentUserId = useStore((s) => s.currentUser.id)
  const toast = useStore((s) => s.toast)

  const [addOpen, setAddOpen] = useState(false)
  const [kw, setKw] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [role, setRole] = useState<'admin' | 'member'>('member')
  const [busy, setBusy] = useState(false)

  const inSpace = new Set((roster || []).map((m) => m.userId))
  const candidates = useMemo(() => members.filter((m) => m.id && !inSpace.has(m.id)), [members, roster])
  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter(
      (m) => m.name.toLowerCase().includes(q) || String(m.account || '').toLowerCase().includes(q),
    )
  }, [candidates, kw])

  const filteredIds = filtered.map((m) => m.id)
  const allPicked = filteredIds.length > 0 && filteredIds.every((id) => picked.includes(id))
  const ownerCount = (roster || []).filter((m) => m.role === 'owner').length

  const closeAdd = () => { setAddOpen(false); setPicked([]); setKw('') }

  const onAdd = async () => {
    if (!picked.length || busy) return
    setBusy(true)
    try {
      const r = await addSpaceMember(spaceId, picked, role)
      const bad = r.failed || []
      if (!bad.length) {
        const n = r.added.length
        const books = r.added.reduce((s, a) => s + (a.grantedBooks || 0), 0)
        toast(
          n === 1
            ? `已把 ${r.added[0].account} 加为${SPACE_ROLE_LABEL[role]}`
            : `已添加 ${n} 位${SPACE_ROLE_LABEL[role]}`,
          'success',
        )
        // 顺带说清楚「只读身份」补到了几本书：没提的话，
        // 新人进来发现每个知识库都打得开却不能编辑，会以为是 bug。
        if (books > 0) toast(`已同步 ${books} 个现有知识库的只读身份`, 'info')
      } else if (!r.added.length) {
        toast(`添加失败：${bad[0].error}`, 'error')
      } else {
        // 部分失败要照实说，不能弹一句「添加成功」就完事
        toast(`${r.added.length} 人成功，${bad.length} 人失败：${bad[0].error}`, 'error')
      }
      closeAdd()
      onRefresh()
    } catch (e: any) {
      toast(e?.message || '添加成员失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const onRemove = async (m: SpaceMember) => {
    if (m.userId === currentUserId) { toast('不能把自己移出空间', 'error'); return }
    if (!confirm(`确定把「${m.name}」移出「${kind === 'team' ? '团队' : ''}空间」？\n他在这个空间里各知识库的身份会一并收回。`)) return
    try {
      const r = await removeSpaceMember(spaceId, m.userId)
      onRefresh()
      toast(
        r.removed
          ? `已移出${r.clearedBooks ? `，并收回 ${r.clearedBooks} 个知识库的身份` : ''}`
          : '该成员已不在空间中',
        'info',
      )
    } catch (e: any) {
      toast(e?.message || '移除失败', 'error')
    }
  }

  return (
    <section style={{ marginTop: 24 }}>
      <div className="yq-section-title">
        <span>空间成员{roster ? `（${roster.length}）` : ''}</span>
        {isAdmin && (
          <Button variant="default" size="sm" icon="＋" onClick={() => setAddOpen(true)}>添加成员</Button>
        )}
      </div>

      {error ? (
        <div className="yq-card yq-space-members-note">
          <span>成员名单加载失败：{error}</span>
          <Button variant="text" size="sm" onClick={onRefresh}>重试</Button>
        </div>
      ) : !roster ? (
        <div className="yq-card yq-space-members-note"><span>正在加载成员名单…</span></div>
      ) : roster.length === 0 ? (
        <div className="yq-card yq-space-members-note">
          <span>名单是空的。这通常是权限或数据异常 —— 空间至少有创建者。</span>
        </div>
      ) : (
        <div className="yq-space-members">
          <div className="yq-space-member yq-space-member-head">
            <span>成员</span>
            <span>角色</span>
            <span>加入时间</span>
            <span />
          </div>
          {roster.map((m) => {
            // 最后一个 owner 不给移除：不然这个空间就没人能管得了了
            const lastOwner = m.role === 'owner' && ownerCount <= 1
            const isMe = m.userId === currentUserId
            return (
              <div key={m.userId} className="yq-space-member">
                <span className="yq-space-member-id">
                  <Avatar name={m.name || '?'} size={30} />
                  <span className="yq-space-member-text">
                    <span className="yq-space-member-name">
                      {m.name || '未知成员'}{isMe && <i className="yq-space-member-me">我</i>}
                    </span>
                    <span className="yq-space-member-account">@{m.account || '—'}</span>
                  </span>
                </span>
                <span>
                  <Tag size="sm" color={m.role === 'member' ? 'default' : 'primary'}>
                    {SPACE_ROLE_LABEL[m.role] || m.role}
                  </Tag>
                </span>
                <span className="yq-space-member-join">
                  {m.joinedAt ? new Date(m.joinedAt).toLocaleDateString('zh-CN') : '—'}
                </span>
                <span className="yq-space-member-op">
                  {!isAdmin ? null : isMe ? (
                    <span className="yq-space-member-hint">—</span>
                  ) : (
                    <button
                      className="yq-space-member-remove"
                      disabled={lastOwner}
                      title={lastOwner ? '这个空间至少要留一个拥有者' : '移出空间'}
                      onClick={() => onRemove(m)}
                    >
                      移除
                    </button>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/*
        局限写在界面上，不只写在代码注释里：
        新人进空间只拿到**现有**知识库的只读身份，之后新建的库不会自动带上他。
        不说清楚的话，第一个撞上这事的同事会以为权限坏了。
      */}
      {isAdmin && (
        <p className="yq-space-members-note-text">
          成员在空间内可以浏览空间的知识库。新成员会自动获得该空间<b>现有</b>知识库的只读身份；
          之后在这个空间里新建的知识库不会自动带上他，需要再点一次「添加成员」。
        </p>
      )}

      <Modal
        open={addOpen}
        onClose={closeAdd}
        title={picked.length > 1 ? `添加成员（已选 ${picked.length} 人）` : '添加成员'}
        width={440}
        footer={
          <>
            <Button variant="text" onClick={closeAdd}>取消</Button>
            <Button variant="primary" disabled={!picked.length || busy} onClick={onAdd}>
              {busy ? '添加中…' : picked.length > 1 ? `添加 ${picked.length} 位成员` : '确认添加'}
            </Button>
          </>
        }
      >
        {candidates.length === 0 ? (
          <Empty icon="🎉" text="公司里的人都已经在这个空间了" />
        ) : (
          <>
            <div className="yq-space-pick-label">选择成员</div>
            <Input
              size="sm"
              className="yq-space-pick-search"
              value={kw}
              onChange={(e: any) => setKw(e.target.value)}
              placeholder="搜索姓名或账号"
              prefix={<span style={{ color: 'var(--yq-text-4)' }}>🔍</span>}
            />
            <div className="yq-space-pick-bar">
              <Checkbox checked={allPicked} onChange={(v) => setPicked(v ? filteredIds : [])}>
                {kw.trim() ? `全选搜索结果（${filtered.length}）` : `全选（${candidates.length}）`}
              </Checkbox>
              {picked.length > 0 && <span className="yq-space-pick-count">已选 {picked.length} 人</span>}
            </div>
            <div className="yq-space-pick-role">
              <span>加入后的角色</span>
              <Select
                size="sm"
                value={role}
                onChange={(v) => setRole(v as 'admin' | 'member')}
                options={[
                  { value: 'member', label: '成员（浏览空间内知识库）' },
                  { value: 'admin', label: '管理员（可再加人、移除成员）' },
                ]}
              />
            </div>
            <div className="yq-space-pick-list">
              {filtered.length === 0 ? (
                <div className="yq-space-pick-none">没有匹配的成员</div>
              ) : (
                filtered.map((m) => {
                  const on = picked.includes(m.id)
                  return (
                    <label key={m.id} className={`yq-space-pick-item ${on ? 'is-active' : ''}`}>
                      <Checkbox checked={on} onChange={() => setPicked((p) => (p.includes(m.id) ? p.filter((x) => x !== m.id) : [...p, m.id]))} />
                      <Avatar name={m.name} size={28} />
                      <span className="yq-space-member-text">
                        <span className="yq-space-member-name">{m.name}</span>
                        <span className="yq-space-member-account">@{m.account}</span>
                      </span>
                    </label>
                  )
                })
              )}
            </div>
          </>
        )}
      </Modal>
    </section>
  )
}
