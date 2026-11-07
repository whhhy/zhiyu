import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useBookStats } from '@/lib/useBookStats'
import { useStore } from '@/store'
import { Avatar, AvatarGroup, Tag, Button, Segmented, Modal, Input, Checkbox, Select, Empty } from '@/components/ui'
import { spaceMembers as loadSpaceMembers, addSpaceMember, removeSpaceMember, type SpaceMember } from '@/lib/api'
import { timeAgo } from '@/components/layout/TopBar'
/**
 * 动态流**与工作台共用同一个推导函数**。
 *
 * ⚠️ 为什么不在这儿再写一遍：那份推导当初是「写死的 7 条虚构动态」，
 *    被抓到过一次（2026-10-08，全新空实例上照样渲染）。
 *    复制一份就等于把那类假象种第二遍。
 *    Dashboard 不导入 Space，所以这是单向依赖，没有循环。
 */
import { buildFeed } from './Dashboard'
import '../styles/layout.css'
import './Dashboard.css'

/* ============================================================
   空间页 —— 一个空间下的全部知识库
   ============================================================ */

const SPACE_ROLE_LABEL: Record<string, string> = { owner: '拥有者', admin: '管理员', member: '成员' }

export default function Space() {
  const { spaceId } = useParams()
  const navigate = useNavigate()
  const { spaces, books, nodes, docs, comments, topics, getMember, createBook, createSpace, deleteSpace, restoreSpace, setActiveSpace, toast, setSpaceCaps, loadSpaceCaps, currentUser, spaceCaps, canCreateBookIn } = useStore()
  const bs = useBookStats()
  const [sort, setSort] = useState('updated')

  const space = spaces.find((s) => s.id === spaceId) || spaces[0]

  /** 这个空间的动态。与工作台共用 buildFeed，只多传一个 spaceId 让它自己过滤。 */
  const spaceFeed = useMemo(
    () => buildFeed({ docs, nodes, books, comments, topics, getMember }, { spaceId: space?.id, limit: 8 }),
    [docs, nodes, books, comments, topics, getMember, space?.id],
  )

  /**
   * 空间成员名单**只在服务端**（`space_members` 不在同步实体清单里）。
   *
   * 以前这里直接渲染 `{space?.memberCount}`，而服务端的 spaces 行里根本没有
   * 这个字段 —— 于是空间头那行永远是「N 成员」后面什么都没有，看着像加载失败。
   * 同一处还有个更隐蔽的假象：头像组喂的是全公司成员，于是 200 人的公司
   * 显示成「这个空间有 200 个成员」。
   *
   * 所以这里老老实实查接口；查不到就显示「—」，不拿别处的数据顶替。
   */
  const [roster, setRoster] = useState<SpaceMember[] | null>(null)
  const [rosterErr, setRosterErr] = useState('')
  /**
   * 「我在这个空间里是不是管理员」**只有一份真相**，在 store 的 `spaceCaps` 里。
   *
   * 原来这里是组件自己的 `useState`，而 store 里存着同一个答案 ——
   * 两个来源就意味着「有一处忘了更新」，而这类分叉最后长成
   * 「成员管理面板开着、但建库按钮没有」这种看着像 bug 的东西。
   *
   * ⚠️ 值是**一组 caps**，不是一个布尔：`canCreateBookIn` 读的是 `.admin`，
   *   而从成员名册那份 `isAdmin` 布尔推出来的对象里**只有 admin 是真的**，
   *   其余几项一概不知道 —— 所以这里不能拿布尔拼一个「看起来完整」的 caps，
   *   那会让别的读取者以为 read/edit 也是 false（= 拒绝）而不是「不知道」。
   */
  const isSpaceAdmin = spaceCaps[String(space?.id || '')]?.admin === true

  const sid = space?.id
  // 建库入口的判据来自服务端的空间能力（`GET /api/perms/space/:id`）。
  // 这一页本来就要问空间相关的东西，顺手把答案备好。
  useEffect(() => { if (sid) loadSpaceCaps(sid) }, [sid, loadSpaceCaps])
  const loadRoster = useCallback(() => {
    if (!sid) return
    loadSpaceMembers(sid)
      .then((r) => {
        setRoster(r.members || []); setRosterErr('')
        /*
         * 把答案写进 store：另外三个建库入口（工作台两处 + 顶栏菜单）
         * 判的是**同一件事**，而这里已经把答案拿到手了 ——
         * 不写进去就得让它们各打一次接口。
         * ⚠️ 只填 `admin`，其余项留 `false` 是**故意的**：
         *   这份答案只被 `canCreateBookIn`（读 admin）用到，
         *   而把「不知道」写成 false 会被读成「明确没有」——
         *   真要读别的项，应该让它去问 `GET /api/perms/space/:id`。
         */
        setSpaceCaps(sid, { read: true, comment: false, edit: false, create: false, export: false, share: false, admin: r.isAdmin === true })
      })
      .catch((e) => setRosterErr(e?.message || '成员名单加载失败'))
  }, [sid, setSpaceCaps])

  useEffect(() => {
    // 换空间时先清空：不清的话会拿上一个空间的名单冒充新空间的，
    // 数量和名字都是错的，而且没有任何加载中的提示。
    setRoster(null)
    setRosterErr('')
    loadRoster()
  }, [loadRoster])

  /*
   * 把 URL 上的空间同步成「当前空间」。
   *
   * ⚠️⚠️ 原来是 `if (spaceId && space?.id !== spaceId) setActiveSpace(spaceId)`
   * —— **渲染中 setState**。它平时能收敛（set 完之后 `space.id` 就等于 `spaceId`，
   * 条件变假），所以一直没出事。
   *
   * 但它有一个**前提**：路由上那个空间必须在 store 里。
   * 2026-10-16 加上「删除空间」之后这个前提第一次不成立：
   * 空间被删 → 它从 `spaces` 里消失 → `space` 回退到 `spaces[0]` →
   * `space.id !== spaceId` **永远为真** → 无限 setState →
   * 整页崩成白屏（React error #185: Maximum update depth exceeded），
   * 而且**连截图都超时**，症状完全看不出是哪里来的。
   *
   * 修法两条一起上：
   * ① 放进 effect —— 渲染中 setState 本来就是反模式；
   * ② 条件里加「这个空间真的还在」—— 空间没了就别同步，
   *    否则会把一个已经删掉的空间重新设为当前空间。
   */
  useEffect(() => {
    if (!spaceId) return
    if (!spaces.some((s) => s.id === spaceId)) return   // 已被删除（或无权可见）：不认
    if (space?.id !== spaceId) setActiveSpace(spaceId)
  }, [spaceId, spaces, space?.id, setActiveSpace])

  /**
   * 建库的判据**直接问 store**（`canCreateBookIn`），和另外三个入口同一个来源。
   * 它内部已经含了平台 owner/admin 的早退，以及本地形态（无服务端 ⇒ 放行）。
   */
  const canCreateHere = canCreateBookIn(space?.id || '')
  /** 建**空间**的判据更严：服务端要求你是「那个空间」的 owner/admin，
   *  而一个还不存在的空间谁都不是它的管理员 ⇒ 实际只有平台管理员能建。 */
  const isPlatformAdmin = currentUser.role === 'owner' || currentUser.role === 'admin'

  const myBooks = books
    .filter((b) => b.spaceId === space?.id)
    .sort((a, b) => (sort === 'updated' ? b.updatedAt - a.updatedAt : b.createdAt - a.createdAt))

  const spaceBookIds = new Set(myBooks.map((b) => b.id))
  const spaceNodes = nodes.filter((n) => spaceBookIds.has(n.bookId) && n.docId)
  const spaceDocs = spaceNodes.map((n) => docs[n.docId!]).filter(Boolean)
  const totalWords = spaceDocs.reduce((n, d) => n + d.wordCount, 0)

  return (
    <div className="yq-dash">
      {/* 空间头 */}
      <header className="yq-space-hero">
        <div className="yq-space-hero-avatar">{space?.avatar}</div>
        <div className="yq-flex-1" style={{ minWidth: 0 }}>
          <div className="yq-space-hero-head">
            <h1 className="yq-space-hero-name">{space?.name}</h1>
            <Tag color={space?.kind === 'team' ? 'primary' : 'green'} size="sm">
              {space?.kind === 'team' ? '团队空间' : '个人空间'}
            </Tag>
          </div>
          <p className="yq-space-hero-desc">{space?.desc}</p>
          <div className="yq-space-hero-stats">
            <span><b>{myBooks.length}</b> 知识库</span>
            <span><b>{spaceNodes.length}</b> 文档</span>
            <span><b>{formatWords(totalWords)}</b> 总字数</span>
            <span>
              <b>{rosterErr ? '—' : roster ? roster.length : '…'}</b> 成员
            </span>
            <span className="yq-flex-1" />
            <AvatarGroup members={(roster || []).map((m) => m.name)} size={24} />
          </div>
        </div>
        <div className="yq-space-hero-actions">
          {/*
            「新建空间」以前根本不存在。
            真实部署里空间只有两个来源：种子数据，和注册/统一认证时自动开的
            那一个个人空间 —— 团队空间建不出来，「空间→知识库→文稿」
            的三级在非演示场景下就塌成了两级。

            ⚠️ 入口按**服务端同一条判据**显隐（平台 owner/admin）。
            服务端 `denyReason` 的 spaces 分支要求「你是**那个空间**的
            owner/admin」，而一个还不存在的空间谁都不是它的管理员 ——
            于是这条规则实际等价于「只有平台管理员能建空间」。
            普通成员点下去会拿到一句报错（下面那个 catch 是对的，不算假承诺），
            但那是个**走不通的按钮**：和「新建知识库」一起修掉才说得通。
          */}
          {isPlatformAdmin && (
          <Button
            variant="default"
            icon="＋"
            onClick={async () => {
              const name = window.prompt('团队空间名称', '新团队空间')
              if (name == null) return
              const n = name.trim()
              if (!n) { toast('空间名称不能为空', 'error'); return }
              /*
               * 这里的 try 是必需的，不是保险起见：
               *
               * `api.request()` 在 `!res.ok` 时 **throw new ApiError**，它**不返回 null**；
               * store 里那句 `if (!sp) return null` 依赖的是「200 但响应里没有 space 字段」，
               * 那是另一回事。
               *
               * 所以真被拒（401 / 403）时异常从 `await createSpace(n)` 直接冒泡，
               * 而这个 `async onClick` 原来**没有 catch**、项目也**没有全局兜底**：
               * 用户点「新建空间」，界面上**什么都不弹**，控制台一条 Uncaught。
               *
               * 下面那句 `toast('创建失败')` 在真被拒时是**死代码**。
               *
               * 内网里这条太容易撞上：SSO 头没配对、IP 白名单把网关挡在外面、
               * 反代漏转发某个头 —— 三者都会让 `POST /api/spaces` 变成 401/403。
               */
              try {
                const id = await createSpace(n)
                if (!id) { toast('创建失败', 'error'); return }
                toast(`团队空间「${n}」已创建`, 'success')
                navigate(`/space/${id}`)
              } catch (err: any) {
                toast(err?.message || '创建失败', 'error')
              }
            }}
          >
            新建空间
          </Button>
          )}
          {/*
            空间设置入口（2026-10-16 照真实语雀的位置结构补的）。
            这里原来摆的是「删除空间」—— 规则（谁能删、验口令、24 小时撤销）
            都对，但**位置错**：一个会级联抹掉 books/nodes/docs 整棵树的
            不可逆操作，和「新建知识库」并排、同权重，
            等于完全没做危险隔离。
            删除现在在「空间设置 → 高级设置」里（SpaceSettings.tsx）。
          */}
          <Button
            variant="default"
            icon="⚙"
            title="空间设置"
            onClick={() => navigate(`/space/${space?.id}/settings`)}
          >
            设置
          </Button>
          {/*
          入口按**服务端同一条判据**显隐（`isSpaceAdmin`，就是成员名册那个接口
          返回的 `isAdmin`），不按前端自己的角色猜。

          以前这里无差别地摆着，普通成员点下去得到一句「知识库已创建」
          和一个刷新也不消失的空壳库（服务端三行全拒）。
          判据未确认时**先不显示** —— 宁可晚半秒出现，也不要先给一个假的按钮。
          */}
        {canCreateHere && (
        <Button
            variant="primary"
            icon="＋"
            onClick={() => {
              const id = createBook(space!.id, '新知识库')
              /*
               * ★ 必须判 `!id`（2026-10-12）。
               *
               * 服务端只让**空间管理员**建库，而这里原来无条件 toast
               * 「知识库已创建」并跳进去 —— 普通成员点下去会得到
               * 一句「已创建」、一个地址，以及一个**刷新也不消失**的空壳库
               * （服务端三行全拒，本地留着它）。
               *
               * store 现在也会拒（`canCreateBookIn`），所以这里是第二道：
               * store 负责「不可能说谎」，界面负责「把话说明白」。
               */
              if (!id) { toast('只有空间管理员可以新建知识库', 'error'); return }
              toast('知识库已创建', 'success')
              navigate(`/book/${id}`)
            }}
          >
            新建知识库
          </Button>
        )}
        </div>
      </header>

      {/* 知识库列表 */}
      <section>
        <div className="yq-section-title">
          <span>全部知识库 ({myBooks.length})</span>
          <Segmented
            size="sm"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'updated', label: '最近更新' },
              { value: 'created', label: '最近创建' },
            ]}
          />
        </div>

        {myBooks.length === 0 ? (
          <div className="yq-card" style={{ padding: 40, textAlign: 'center' }}>
            <div className="yq-empty-icon">📚</div>
            <p style={{ color: 'var(--yq-text-3)', fontSize: 14, marginTop: 8 }}>这个空间还没有知识库</p>
          </div>
        ) : (
          <div className="yq-book-grid">
            {myBooks.map((b) => {
              const lastNodes = nodes
                .filter((n) => n.bookId === b.id && n.docId)
                .slice(0, 3)
                .map((n) => docs[n.docId!])
                .filter(Boolean)
              return (
                <div
                  key={b.id}
                  className="yq-book-card yq-card yq-card-hover yq-book-card-lg"
                  onClick={() => navigate(`/book/${b.id}`)}
                >
                  <div className="yq-book-card-head">
                    <div className="yq-book-card-avatar yq-book-card-avatar-lg">{b.avatar}</div>
                    <div className="yq-flex-1" style={{ minWidth: 0 }}>
                      <div className="yq-book-card-name-lg yq-ellipsis">{b.name}</div>
                      <div className="yq-book-card-space">{timeAgo(b.updatedAt)}更新</div>
                    </div>
                    <Tag color={b.visibility === 'private' ? 'default' : 'green'} size="sm">
                      {b.visibility === 'private' ? '私密' : b.visibility === 'public' ? '公开' : '空间内'}
                    </Tag>
                  </div>
                  <p className="yq-book-card-desc yq-clamp-2">{b.desc || '暂无描述'}</p>
                  <div className="yq-book-last">
                    {lastNodes.map((d) => (
                      <div key={d.id} className="yq-book-last-row">
                        <span>{d.type === 'doc' ? '📄' : d.type === 'sheet' ? '📊' : d.type === 'board' ? '🎨' : '🗃️'}</span>
                        <span className="yq-ellipsis">{d.title}</span>
                      </div>
                    ))}
                    {bs(b).docCount > 3 && <div className="yq-book-last-more">还有 {bs(b).docCount - 3} 篇…</div>}
                  </div>
                  <div className="yq-book-card-foot">
                    <span>{bs(b).docCount} 篇文档</span>
                    <span>·</span>
                    <span>{formatWords(bs(b).wordCount)} 字</span>
                    <span className="yq-flex-1" />
                    <span>创建于 {new Date(b.createdAt).toLocaleDateString('zh-CN')}</span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/*
        空间级动态 —— 2026-10-11 对照真实语雀补的。
        那边点进某个空间能看到**这个空间**的动态；我们原来只有工作台那一层，
        于是「这个空间最近发生了什么」只能去工作台找。

        ⚠️ 过滤交给 buildFeed 自己做（opts.spaceId），**不在这里筛**：
          它内部先按空间过滤、再截断。先截 8 条再筛的话，
          一个活跃空间里那 8 条可能全属于别的空间 →
          空间页显示「没人动过」，而这个事实是假的。
      */}
      <section className="yq-card yq-bset-card">
        <div className="yq-section-title">
          <span>空间动态</span>
        </div>
        <div className="yq-feed">
          {spaceFeed.length ? spaceFeed.map((f) => (
            <div
              key={f.key}
              className="yq-feed-item"
              style={f.docId ? { cursor: 'pointer' } : undefined}
              onClick={f.bookId ? () => navigate(`/book/${f.bookId}/doc/${f.docId}`) : undefined}
            >
              <Avatar name={f.who} size={24} />
              <div className="yq-flex-1" style={{ minWidth: 0 }}>
                <div className="yq-feed-text">
                  <b>{f.who}</b> {f.what}{' '}
                  <span className="yq-feed-target">{f.target}</span>
                </div>
                <div className="yq-list-row-meta" style={{ marginTop: 2 }}>
                  {f.where && <span>{f.where}</span>}
                  {f.where && <span>·</span>}
                  <span>{timeAgo(f.at)}</span>
                </div>
              </div>
            </div>
          )) : (
            <div className="yq-feed-item yq-feed-empty">
              <span className="yq-list-row-meta">
                这个空间还没有动态。同事新建文档、评论或发起话题之后会出现在这里。
              </span>
            </div>
          )}
        </div>
      </section>

      {/*
        空间成员管理与「删除空间」都已搬到 `/space/:id/settings`
        （SpaceSettings.tsx，2026-10-16）。这里保留成员数与头像组作为概览，
        点成员数进设置 —— 成员管理本身不再占空间页正文的位置。
      */}
      {roster && roster.length > 0 && (
        <div className="yq-section-title" style={{ marginTop: 20, cursor: 'pointer' }} onClick={() => navigate(`/space/${space?.id}/settings?tab=members`)}>
          <span>空间成员（{roster.length}）→</span>
          <span className="yq-flex yq-items-center">
            <AvatarGroup members={roster.map((m) => m.name)} size={24} />
          </span>
        </div>
      )}
    </div>
  )
}

function formatWords(n: number) {
  return n >= 10000 ? (n / 10000).toFixed(1) + 'w' : String(n)
}
