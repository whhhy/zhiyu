import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { useBookStats, useBookRecentDocs } from '@/lib/useBookStats'
import { useStore } from '@/store'
import { useSpacePerms } from '@/lib/perms'
import { resolveTab } from '@/lib/dashboard-tab'
import { Avatar, Tag, Empty, Segmented, Progress, Select, Modal, Input, Button } from '@/components/ui'
import { timeAgo, DOC_TYPE_META, NewDocModal } from '@/components/layout/TopBar'
import type { Doc, DocType } from '@/types'
import { BookInviteList } from '@/components/collab/BookInvite'
import '../styles/layout.css'
import './Dashboard.css'

/* ============================================================
   工作台 —— 语雀首页
   左侧七 tab 已由 SideNav 提供，这里渲染对应内容
   ============================================================ */

export default function Dashboard() {
  const [params, setParams] = useSearchParams()
  const rawTab = params.get('tab') || 'doc'
  /*
   * `?tab=collab` 也要拦，不能只藏侧栏入口。
   *
   * 侧栏那一项在服务端形态下已经隐藏了（见 SideNav 的 visibleSections），
   * 但 URL 是可以手敲的 —— 于是 `/?tab=collab` 照样能打开那个恒空的
   * CollabTab：空列表 + 「待处理(0)」+ 两个只改本地状态的假按钮。
   *
   * 口径放在 `@/lib/dashboard-tab`，**SideNav 也调它**算高亮 ——
   * 第一版就是漏了那边，结果内容回到文档页而侧栏一个高亮都没有。
   */
  const tab = resolveTab(rawTab)
  const navigate = useNavigate()
  const {
    books, spaces, nodes, docs, recents, topics, favorites,
    currentUser, getMember, notes, isFavorite, activeSpaceId,
  } = useStore()
  const bs = useBookStats()

  const activeSpace = spaces.find((s) => s.id === activeSpaceId) || spaces[0]
  const myBooks = books.filter((b) => b.spaceId === activeSpace?.id)

  const setTab = (t: string) => (t === 'doc' ? setParams({}) : setParams({ tab: t }))

  return (
    <div className="yq-dash">
      <header className="yq-dash-header">
        <div>
          <h1 className="yq-dash-greeting">
            {greeting()}，{currentUser.name}
          </h1>
          <p className="yq-dash-date">{today()}</p>
        </div>
        {/*
          这里原来有一排成员头像（`AvatarGroup members={members.map(m => m.name)}`），
          2026-10-16 按实测语雀删掉 —— 三条理由，每条都独立成立：

          ① **语雀没有这个东西**。实测 `/dashboard`：头部只有一个「开始」区标题 +
            四张入口卡，右上角**空的**。这排头像是我们凭空加的。

          ② **它不受空间限制**。取的是 `members` 全表，所以一个只在一个
             1 人空间里的新账号，头部也会看见这台机器上另外 6 个人。
             内网部署时这就是信息泄露 —— 他对那些人**没有任何权限**。

          ③ **它自己跟自己打架**。侧栏写「1 位成员」，头部摆 7 个头像，
             而且没有标题、没有 tooltip、点不动，读者无从知道那是什么意思。

          同名组件在别处**保留**：文档页的协作条、空间页的成员概览 ——
          那两处都限定在真实成员/协作者旁边并且带人数，是有信息量的。
          要删的只是「一个空间都不限定、还什么上下文都没有」的这一处。
        */}
      </header>

      {tab === 'doc' && <StartSection />}

      {tab === 'doc' && <DocTab />}
      {tab === 'book' && <BookTab />}
      {tab === 'team' && <TeamTab />}
      {tab === 'collab' && <BookInviteList />}
      {tab === 'discuss' && <DiscussTab />}
      {tab === 'follow' && <FollowTab />}
      {tab === 'favorite' && <FavoriteTab />}
    </div>
  )
}

/* ============================================================
   「开始」区 —— 语雀工作台顶部的四张入口卡
   ------------------------------------------------------------
   2026-10-10 直接在真实语雀上量的：标题就叫「开始」（不是「工作台」），
   卡片顺序与文案是：
     新建文档   / 文档、表格、画板、数据表（右侧有 ⌄）
     新建知识库 / 使用知识库整理知识
     模板中心   / 从模板中获取灵感
     AI 帮你写  / AI 助手帮你一键生成文档

   ⚠️ **第四张卡没做，而且是有意不做的。**
     我们没有 AI 能力。照抄一张卡片进去、点下去什么都发生不了，
     那是这个项目一直在清的同一类缺陷（假动作）——
     而它在工作台最显眼的位置，比缺一张卡伤害更大。
     等真做了 AI 助手再补这一张。

   同样地，「新建文档」卡右侧那个 `⌄`（真语雀是「先选类型、再选知识库」
   的快捷菜单）这里**没有画**：我们没有「当前知识库」这个上下文，
   摆一个只通向同一个弹窗的箭头，是在假装有一个更快的路径。
   点卡片 → 同一个新建弹窗（选库 + 选类型），行为是真的。
   ============================================================ */

function StartSection() {
  const navigate = useNavigate()
  const { createBook, toast, activeSpaceId, canCreateBookIn, loadSpaceCaps } = useStore()
  const [newOpen, setNewOpen] = useState(false)

  /*
   * 建库入口按**服务端同一条判据**显隐（空间管理员）。
   * 以前无差别摆着：普通成员点下去得到一句「知识库已创建」和一个
   * 刷新也不消失的空壳库（服务端三行全拒，本地留着它）。
   * 未确认时先不显示 —— `canCreateBookIn` 对未知返回 false。
   */
  const canCreate = canCreateBookIn(activeSpaceId)
  useEffect(() => {
    if (!canCreate) loadSpaceCaps(activeSpaceId)
  }, [canCreate, activeSpaceId, loadSpaceCaps])   // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="yq-dash-start">
      <h2 className="yq-section-title">开始</h2>
      <div className="yq-dash-start-cards">
        <button className="yq-start-card" onClick={() => setNewOpen(true)}>
          <span className="yq-start-card-icon">📄</span>
          <span className="yq-start-card-body">
            <span className="yq-start-card-title">新建文档</span>
            <span className="yq-start-card-desc">文档、表格、画板、数据表</span>
          </span>
        </button>

        {canCreate && (
        <button
          className="yq-start-card"
          onClick={() => {
            const id = createBook(activeSpaceId, '新知识库')
            // store 也会拒（canCreateBookIn）；这里是第二道，
            // 负责把「不能建」这件事说明白，而不是默默什么都不发生
            if (!id) { toast('只有空间管理员可以新建知识库', 'error'); return }
            toast('知识库已创建', 'success')
            navigate(`/book/${id}`)
          }}
        >
          <span className="yq-start-card-icon">📗</span>
          <span className="yq-start-card-body">
            <span className="yq-start-card-title">新建知识库</span>
            <span className="yq-start-card-desc">使用知识库整理知识</span>
          </span>
        </button>
        )}

        <button className="yq-start-card" onClick={() => navigate('/templates')}>
          <span className="yq-start-card-icon">🎨</span>
          <span className="yq-start-card-body">
            <span className="yq-start-card-title">模板中心</span>
            <span className="yq-start-card-desc">从模板中获取灵感</span>
          </span>
        </button>
      </div>

      {newOpen && <NewDocModal onClose={() => setNewOpen(false)} />}
    </section>
  )
}

/* ---------------- 文档 ---------------- */
/**
 * 工作台「文档」区的四个视图 + 三维筛选（2026-10-10 对照官方语雀工作台补齐）。
 *
 * 语雀那边的样子（实测读到的）：
 *   视图：编辑过 / 浏览过 / 我点赞的 / 我评论过
 *   筛选：类型 / 归属 / 创建者
 *   每行：标题 · 作者 · 所属库 · 日期
 * 我们原来只有「最近编辑 + 今天/本周/本月」—— 后者语雀没有，前者缺了三项。
 *
 * ⚠️ 四个视图**每一个都必须由真实数据算出来**，不能拿 store 字段凑：
 *   · 编辑过   → doc.authorId === me（我创建的）
 *   · 浏览过   → recents（服务端同步的最近访问）
 *   · 我点赞的 → doc.likes 里有我（这一列 2026-10-10 才补上，
 *                之前点赞是假的 —— 数字按 docId 末位算出来）
 *   · 我评论过 → comments 里 authorId === me
 * 一个视图返回空就显示空态，**不能拿别的数据顶替** ——
 * 「没人评论过」显示成「你编辑过的」是编造。
 */
type DocView = 'edited' | 'viewed' | 'liked' | 'commented'

function DocTab() {
  const bs = useBookStats()
  const navigate = useNavigate()
  const { recents, docs, nodes, books, members, getMember, currentUser, comments, topics } = useStore()
  const [view, setView] = useState<DocView>('edited')
  const [fType, setFType] = useState('')
  const [fBook, setFBook] = useState('')
  const [fAuthor, setFAuthor] = useState('')

  /** docId → { node, book }，列表里每行都要显示「所属库」 */
  const locOf = (docId: string) => {
    const node = nodes.find((n) => n.docId === docId)
    return { node, book: node ? books.find((b) => b.id === node.bookId) : undefined }
  }

  const allDocs: Doc[] = Object.values(docs || {})

  const VIEWS: { key: DocView; label: string }[] = [
    { key: 'edited', label: '编辑过' },
    { key: 'viewed', label: '浏览过' },
    { key: 'liked', label: '我点赞的' },
    { key: 'commented', label: '我评论过' },
  ]

  /** 每个视图各自的候选集 —— 空就是空，不借用别的视图 */
  const baseOf = (v: DocView): Doc[] => {
    if (v === 'edited') return allDocs.filter((d) => d.authorId === currentUser?.id)
    if (v === 'viewed') return (recents || []).map((r) => docs[r.docId]).filter(Boolean) as Doc[]
    if (v === 'liked') return allDocs.filter((d) => Array.isArray(d.likes) && d.likes.includes(currentUser?.id))
    // 我评论过：comments 是 Record<docId, Comment[]>
    const mine = new Set<string>()
    for (const [docId, list] of Object.entries(comments || {})) {
      if ((list || []).some((c) => c.authorId === currentUser?.id)) mine.add(docId)
    }
    return allDocs.filter((d) => mine.has(d.id))
  }

  /** 排序时间：浏览过用 viewedAt（那才是「浏览」的时刻），其余用 updatedAt */
  const stampOf = (v: DocView, d: Doc): number => {
    if (v !== 'viewed') return Number(d.updatedAt) || 0
    const r = (recents || []).find((x) => x.docId === d.id)
    return Number(r?.viewedAt) || Number(d.updatedAt) || 0
  }

  const items = baseOf(view)
    .filter((d) => (fType ? d.type === fType : true))
    .filter((d) => (fBook ? locOf(d.id).node?.bookId === fBook : true))
    .filter((d) => (fAuthor ? d.authorId === fAuthor : true))
    .sort((a, b) => stampOf(view, b) - stampOf(view, a))
    .slice(0, 30)

  /** 筛选项从**候选集**里取，而不是从全库取 —— 否则会出现「筛完必为空」 */
  const candidates = baseOf(view)
  const typeOptions = [...new Set(candidates.map((d) => d.type).filter(Boolean))] as DocType[]
  const bookOptions = [...new Set(candidates.map((d) => locOf(d.id).node?.bookId).filter(Boolean))] as string[]
  const authorOptions = [...new Set(candidates.map((d) => d.authorId).filter(Boolean))] as string[]

  const EMPTY_TEXT: Record<DocView, string> = {
    edited: '你还没有创建过文档',
    viewed: '你还没有浏览过文档',
    liked: '你还没有点赞过文档',
    commented: '你还没有评论过文档',
  }

  const feed = buildFeed({ docs, nodes, books, comments, topics, getMember })

  return (
    <>
      <div className="yq-dash-cols">
        {/* 左：文档区（视图 + 筛选 + 列表） */}
        <section className="yq-dash-main">
          <div className="yq-section-title">
            <span>文档</span>
            <Segmented
              size="sm"
              value={view}
              onChange={(v) => { setView(v as DocView); setFType(''); setFBook(''); setFAuthor('') }}
              options={VIEWS.map((v) => ({ value: v.key, label: v.label }))}
            />
          </div>

          {/* 三维筛选：类型 / 归属 / 创建者 */}
          <div className="yq-dash-filters">
            <Select
              size="sm"
              className="yq-dash-filter yq-dash-filter-type"
              value={fType}
              onChange={setFType}
              options={[
                { value: '', label: '全部类型' },
                ...typeOptions.map((t) => ({ value: t, label: DOC_TYPE_META[t]?.label ?? t })),
              ]}
            />
            <Select
              size="sm"
              className="yq-dash-filter yq-dash-filter-book"
              value={fBook}
              onChange={setFBook}
              options={[
                { value: '', label: '全部知识库' },
                ...bookOptions.map((b) => ({ value: b, label: books.find((x) => x.id === b)?.name ?? b })),
              ]}
            />
            <Select
              size="sm"
              className="yq-dash-filter yq-dash-filter-author"
              value={fAuthor}
              onChange={setFAuthor}
              options={[
                { value: '', label: '全部创建者' },
                ...authorOptions.map((a) => ({ value: a, label: getMember(a)?.name ?? a })),
              ]}
            />
            {(fType || fBook || fAuthor) && (
              <button
                className="yq-dash-filter-clear"
                onClick={() => { setFType(''); setFBook(''); setFAuthor('') }}
              >
                清空筛选
              </button>
            )}
          </div>

          {items.length === 0 ? (
            <Empty icon="📄" text={EMPTY_TEXT[view]} />
          ) : (
            <div className="yq-card">
              {items.map((doc) => {
                const { node, book } = locOf(doc.id)
                const author = getMember(doc.authorId)
                return (
                  <div
                    key={doc.id}
                    className="yq-list-row"
                    onClick={() => node && navigate(`/book/${node.bookId}/doc/${doc.id}`)}
                  >
                    <span className="yq-list-icon">{DOC_TYPE_META[doc.type]?.icon ?? '📄'}</span>
                    <div className="yq-flex-1" style={{ minWidth: 0 }}>
                      <div className="yq-list-row-title yq-ellipsis">{doc.title}</div>
                      <div className="yq-list-row-meta">
                        {/* 语雀每行是「作者 / 归属 / 日期」三段 */}
                        <span>{author?.name || '未知'}</span>
                        <span>·</span>
                        <span>{book?.name || '未归档'}</span>
                        <span>·</span>
                        <span>{timeAgo(stampOf(view, doc))}</span>
                      </div>
                    </div>
                    <Avatar name={author?.name || '?'} size={22} />
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* 右：动态流 */}
        <aside className="yq-dash-aside">
          <div className="yq-section-title">
            <span>团队动态</span>
          </div>
          <div className="yq-card yq-feed">
            {feed.length ? feed.map((f, i) => (
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
                <span className="yq-list-row-meta">还没有动态。同事新建文档、评论或发起话题之后会出现在这里。</span>
              </div>
            )}
          </div>
        </aside>
      </div>

      {/* 知识库速览 */}
      <section className="yq-dash-books">
        <div className="yq-section-title">
          <span>我的知识库</span>
          <Link to={`/space/${useStore.getState().activeSpaceId}`} className="yq-dash-more">
            全部 →
          </Link>
        </div>
        <div className="yq-book-cards">
          {books.slice(0, 4).map((b) => (
            <Link key={b.id} to={`/book/${b.id}`} className="yq-book-card yq-card yq-card-hover">
              <div className="yq-book-card-avatar">{b.avatar}</div>
              <div className="yq-book-card-name yq-ellipsis">{b.name}</div>
              <div className="yq-book-card-meta">
                {bs(b).docCount} 篇 · {formatNum(bs(b).wordCount)} 字
              </div>
              <div className="yq-book-card-progress">
                <Progress percent={Math.min(100, (bs(b).docCount / 15) * 100)} />
              </div>
            </Link>
          ))}
        </div>
      </section>
    </>
  )
}

/* ---------------- 知识库 ---------------- */
function BookTab() {
  const bs = useBookStats()
  const navigate = useNavigate()
  const { books, spaces, createBook, toast, activeSpaceId, canCreateBookIn, loadSpaceCaps } = useStore()
  const [scope, setScope] = useState('all')

  /* 与 StartSection 同一套判据（服务端只让空间管理员建库），
     未确认时先不显示入口 —— 详见 canCreateBookIn 的注释。 */
  const canCreate = canCreateBookIn(activeSpaceId)
  useEffect(() => {
    if (!canCreate) loadSpaceCaps(activeSpaceId)
  }, [canCreate, activeSpaceId, loadSpaceCaps])   // eslint-disable-line react-hooks/exhaustive-deps

  const list = books.filter((b) => (scope === 'all' ? true : b.spaceId === scope))

  return (
    <section>
      <div className="yq-section-title">
        <span>全部知识库</span>
        <div className="yq-flex yq-items-center yq-gap-8">
          <Segmented
            size="sm"
            value={scope}
            onChange={setScope}
            options={[{ value: 'all', label: '全部' }, ...spaces.map((s) => ({ value: s.id, label: s.name.slice(0, 4) }))]}
          />
          {canCreate && (
          <button
            className="yq-btn yq-btn-primary yq-btn-sm"
            onClick={() => {
              const id = createBook(activeSpaceId, '新知识库')
              if (!id) { toast('只有空间管理员可以新建知识库', 'error'); return }
              toast('知识库已创建', 'success')
              navigate(`/book/${id}`)
            }}
          >
            ＋ 新建知识库
          </button>
          )}
        </div>
      </div>

      <div className="yq-book-grid">
        {list.map((b) => {
          const space = spaces.find((s) => s.id === b.spaceId)
          return (
            <div key={b.id} className="yq-book-card yq-card yq-card-hover yq-book-card-lg" onClick={() => navigate(`/book/${b.id}`)}>
              <div className="yq-book-card-head">
                <div className="yq-book-card-avatar yq-book-card-avatar-lg">{b.avatar}</div>
                <div className="yq-flex-1" style={{ minWidth: 0 }}>
                  <div className="yq-book-card-name-lg yq-ellipsis">{b.name}</div>
                  <div className="yq-book-card-space">{space?.name}</div>
                </div>
                <Tag color={b.visibility === 'private' ? 'default' : 'green'} size="sm">
                  {b.visibility === 'private' ? '私密' : b.visibility === 'public' ? '公开' : '空间内'}
                </Tag>
              </div>
              <p className="yq-book-card-desc yq-clamp-2">{b.desc || '暂无描述'}</p>
              <div className="yq-book-card-foot">
                <span>{bs(b).docCount} 篇文档</span>
                <span>·</span>
                <span>{formatNum(bs(b).wordCount)} 字</span>
                <span className="yq-flex-1" />
                <span>{timeAgo(b.updatedAt)}更新</span>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/* ---------------- 团队 ---------------- */
/**
 * 堆叠卡上的时间戳。语雀那边是 `06-25 13:57` 这种「月-日 时:分」，
 * 不是「3 天前」—— 所以这里也照它那样写绝对时间。
 */
function stackTime(ts: number) {
  const d = new Date(ts)
  if (!ts || Number.isNaN(d.getTime())) return ''
  const p = (x: number) => String(x).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function TeamTab() {
  const bs = useBookStats()
  const recent = useBookRecentDocs(3)
  const { spaces, members, books, nodes, docs } = useStore()
  const [sel, setSel] = useState(spaces.find((s) => s.kind === 'team')?.id || spaces[0]?.id)
  const space = spaces.find((s) => s.id === sel)
  const spaceBooks = books.filter((b) => b.spaceId === sel)
  const spaceNodes = nodes.filter((n) => spaceBooks.some((b) => b.id === n.bookId) && n.docId)
  const spaceDocs = spaceNodes.map((n) => docs[n.docId!]).filter(Boolean)

  return (
    <div className="yq-dash-cols">
      <section className="yq-dash-main">
        <div className="yq-section-title">
          <span>团队空间</span>
          <Segmented
            size="sm"
            value={sel || ''}
            onChange={setSel}
            options={spaces.filter((s) => s.kind === 'team').map((s) => ({ value: s.id, label: s.name }))}
          />
        </div>

        <div className="yq-team-hero yq-card">
          <div className="yq-team-hero-avatar">{space?.avatar}</div>
          <div className="yq-flex-1">
            <h2 className="yq-team-hero-name">{space?.name}</h2>
            <p className="yq-team-hero-desc">{space?.desc}</p>
            <div className="yq-team-hero-stats">
              <div><b>{space?.memberCount}</b><span>成员</span></div>
              <div><b>{spaceBooks.length}</b><span>知识库</span></div>
              <div><b>{spaceDocs.length}</b><span>文档</span></div>
              <div><b>{formatNum(spaceDocs.reduce((n, d) => n + d.wordCount, 0))}</b><span>总字数</span></div>
            </div>
          </div>
        </div>

        {/*
          堆叠卡 —— 语雀团队主页 `content: ["book_stacks"]` 的形态
          （2026-10-15 实测：/yuque 一本书一张大卡，卡内列最近 3 篇文档 + 时间戳）。

          以前这里是**一行式列表**（名称 + 篇数），而且那几行**根本不能点**：
          团队页看到有哪些库，却一个都打不开。现在卡面本身是到书页的链接，
          卡内每篇文档也是到那篇文档的链接。
        */}
        <div className="yq-section-title" style={{ marginTop: 20 }}>知识库</div>
        {spaceBooks.length === 0 ? (
          <div className="yq-card yq-list-empty">这个空间下还没有知识库</div>
        ) : (
          <div className="yq-stack-grid">
            {spaceBooks.map((b) => {
              const list = recent(b.id)
              return (
                <div key={b.id} className="yq-card yq-stack">
                  <Link to={`/book/${b.id}`} className="yq-stack-head">
                    <span className="yq-stack-cover">{b.avatar}</span>
                    <div className="yq-stack-meta">
                      <div className="yq-stack-name yq-ellipsis">{b.name}</div>
                      <div className="yq-stack-sub">{bs(b).docCount} 篇文档</div>
                    </div>
                  </Link>
                  {b.desc && <p className="yq-stack-desc yq-ellipsis-2">{b.desc}</p>}
                  <div className="yq-stack-docs">
                    {list.length === 0 ? (
                      <div className="yq-stack-doc yq-stack-doc-empty">还没有文档</div>
                    ) : (
                      list.map((d) => (
                        <Link key={d.id} to={`/book/${b.id}/doc/${d.id}`} className="yq-stack-doc">
                          <span className="yq-stack-doc-t yq-ellipsis">{d.title}</span>
                          <span className="yq-stack-doc-at">{stackTime(d.updatedAt)}</span>
                        </Link>
                      ))
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>

      <aside className="yq-dash-aside">
        <div className="yq-section-title"><span>成员</span></div>
        <div className="yq-card">
          {members.map((m) => {
            const authored = spaceDocs.filter((d) => d.authorId === m.id).length
            return (
              <div key={m.id} className="yq-list-row" style={{ cursor: 'default' }}>
                <Avatar name={m.name} size={32} />
                <div className="yq-flex-1" style={{ minWidth: 0 }}>
                  <div className="yq-list-row-title">{m.name}</div>
                  <div className="yq-list-row-meta">
                    <span>@{m.account}</span>
                    <span>·</span>
                    <span>贡献 {authored} 篇文档</span>
                  </div>
                </div>
                <Tag color={m.role === 'owner' ? 'primary' : m.role === 'admin' ? 'green' : 'default'} size="sm">
                  {m.role === 'owner' ? '拥有者' : m.role === 'admin' ? '管理员' : '成员'}
                </Tag>
              </div>
            )
          })}
        </div>
      </aside>
    </div>
  )
}

/* ---------------- 讨论 ---------------- */
function DiscussTab() {
  const navigate = useNavigate()
  const { topics, getMember, members, getTopicReplyCount, getTopicParticipants, createTopic, activeSpaceId, spaces, toast } = useStore()
  const [sort, setSort] = useState('hot')
  /*
   * 权限第一道（与 `server/denyReason` 的 `topics` 分支同源：`capsInSpace().comment`）。
   * 这一页以前没问过，于是 store 的 `spaceCommentBlocked` 读到 null 就放行了。
   */
  const discussCaps = useSpacePerms(activeSpaceId)
  const canComment = discussCaps !== null && discussCaps.comment
  const [newOpen, setNewOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')

  /**
   * 热门按**真实**回复数排，不用 `t.replyCount`。
   * 那个字段是种子里的历史值，和实际回复行对不上 ——
   * 拿它排序等于「按一个编出来的数字给话题排名」。
   */
  const list = [...topics].sort((a, b) => (sort === 'hot' ? getTopicReplyCount(b.id) - getTopicReplyCount(a.id) : b.createdAt - a.createdAt))

  const submit = () => {
    /*
     * ⚠️ `createTopic` 返回 `''` 有**两种**原因：标题为空，或者没有发言权。
     * 原来一律说「标题不能为空」—— 于是**权限被拒被误报成标题问题**，
     * 用户会反复改标题，而真正的原因一个字都没提。
     * 这里先分清是哪一种，再说对应的话。
     */
    if (!title.trim()) { toast('标题不能为空', 'error'); return }
    if (!canComment) { toast('在这个空间里没有发言权限，发不起话题', 'error'); return }
    const id = createTopic(activeSpaceId, title.trim(), body.trim())
    if (!id) { toast('发起失败，请稍后再试', 'error'); return }
    setNewOpen(false); setTitle(''); setBody('')
    toast('话题已发起', 'success')
    navigate(`/knowledge/${id}`)
  }

  return (
    <section>
      <div className="yq-section-title">
        <span>讨论</span>
        <div className="yq-flex yq-items-center yq-gap-8">
          <Segmented
            size="sm"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'hot', label: '热门' },
              { value: 'new', label: '最新' },
            ]}
          />
          {/*
            「发起话题」入口。
            ⚠️ 以前这里**什么都没有** —— 讨论区只能看不能发，
            而三处文案都写着能发（Space 的空状态、Dashboard 的空状态、
            Help 的「遇到问题可以直接在讨论区发帖」+ 一个「去讨论区」按钮）。
            表、实体、同步形状一直都在，只缺这个入口和一个 action。
          */}
          <button className="yq-btn yq-btn-primary yq-btn-sm" onClick={() => setNewOpen(true)}>
            ＋ 发起话题
          </button>
        </div>
      </div>

      <div className="yq-card">
        {list.map((t) => {
          const a = getMember(t.authorId)
          return (
            <div key={t.id} className="yq-list-row" onClick={() => navigate(`/knowledge/${t.id}`)}>
              <span className="yq-list-icon">{t.hot ? '🔥' : '💬'}</span>
              <div className="yq-flex-1" style={{ minWidth: 0 }}>
                <div className="yq-list-row-title yq-ellipsis">{t.title}</div>
                <div className="yq-list-row-meta">
                  <span>{a?.name} 发起</span>
                  <span>·</span>
                  <span>{timeAgo(t.createdAt)}</span>
                </div>
              </div>
              <div className="yq-discuss-participants">
                {/* 参与者按**真实回复**算。原先这里读的是 `t.participants` ——
                    那是建话题那一刻的快照、之后再没变过，于是「12 回复」
                    旁边只挂一个头像、甚至挂着从未回复过的人的头像
                    （话题详情页一直是自己算的，所以那一页是对的）。
                    现在两边都调 store 的同一个函数，不会再漂。 */}
                {getTopicParticipants(t.id).slice(0, 3).map((p, i) => (
                  <Avatar key={i} name={members.find((m) => m.id === p)?.name || '?'} size={20} />
                ))}
                <span className="yq-discuss-replies">{getTopicReplyCount(t.id)} 回复</span>
              </div>
            </div>
          )
        })}
      </div>

      <Modal
        open={newOpen}
        onClose={() => { setNewOpen(false); setTitle(''); setBody('') }}
        title="发起话题"
        width={520}
        footer={
          <>
            <Button variant="text" onClick={() => { setNewOpen(false); setTitle(''); setBody('') }}>取消</Button>
            <Button variant="primary" disabled={!title.trim()} onClick={submit}>发起</Button>
          </>
        }
      >
        <div>
          <div className="yq-topic-field">
            <label htmlFor="yq-topic-title">标题</label>
            <Input
              id="yq-topic-title"
              value={title}
              placeholder="一句话说清你想聊什么"
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
            />
          </div>
          <div className="yq-topic-field">
            <label htmlFor="yq-topic-body">正文</label>
            <textarea
              id="yq-topic-body"
              className="yq-topic-textarea"
              rows={4}
              value={body}
              placeholder="展开说说（可留空；填了会作为第一条回复）"
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          <p className="yq-bset-hint" style={{ marginTop: 0, marginLeft: 68 }}>
            话题属于「{spaces.find((s) => s.id === activeSpaceId)?.name || '当前空间'}」，
            同一空间的人都能看到并回复。
          </p>
        </div>
      </Modal>
    </section>
  )
}

/* ---------------- 关注 / 收藏 ----------------
   这一段以前整个是假的，而且骗法有两层：

   1. 列表是编的 —— 「我关注的空间」列的是 `spaces`（**全部**空间），
      「我关注的人」列的是 `members` 去掉 u1（**几乎全部**成员）。
      也就是说不管你关注过什么，它都显示你关注了所有东西。
   2. 按钮是死的 —— 两个「已关注」都没有 onClick，点了什么都不会发生。
      而项目里压根没有「关注」这张表。

   现在关注是真的独立实体（`follows`，个人数据、服务端按 userId 过滤）：
   列表只列真关注过的，按钮能点、能取消；再给一块「可以关注」，
   不然一个只能看不能加的关注页是废的。 */
function FollowTab() {
  const bs = useBookStats()
  const { spaces, members, books, follows, toggleFollow, isFollowing, currentUser } = useStore()

  const mySpaces = spaces.filter((s) => isFollowing('space', s.id))
  const myPeople = members.filter((m) => m.id !== currentUser.id && isFollowing('user', m.id))
  // 可以关注 = 存在、还没关注。少了这块，关注页就只能看不能加。
  const otherSpaces = spaces.filter((s) => !isFollowing('space', s.id))
  const otherPeople = members.filter((m) => m.id !== currentUser.id && !isFollowing('user', m.id))

  const followBtn = (type: 'space' | 'user', id: string, on: boolean) => (
    <button
      className={`yq-btn yq-btn-sm ${on ? 'yq-btn-default' : 'yq-btn-primary'}`}
      onClick={() => toggleFollow(type, id)}
    >
      {on ? '已关注' : '＋ 关注'}
    </button>
  )

  return (
    <div className="yq-dash-cols">
      <section className="yq-dash-main">
        <div className="yq-section-title"><span>我关注的空间</span></div>
        <div className="yq-card">
          {mySpaces.length === 0 ? (
            <div className="yq-list-empty">还没有关注任何空间，下面可以挑一个</div>
          ) : (
            mySpaces.map((s) => (
              <div key={s.id} className="yq-list-row">
                <span className="yq-space-avatar">{s.avatar}</span>
                <div className="yq-flex-1" style={{ minWidth: 0 }}>
                  <div className="yq-list-row-title">{s.name}</div>
                  <div className="yq-list-row-meta">{s.desc}</div>
                </div>
                {followBtn('space', s.id, true)}
              </div>
            ))
          )}
        </div>

        <div className="yq-section-title" style={{ marginTop: 20 }}>我关注的人</div>
        <div className="yq-card">
          {myPeople.length === 0 ? (
            <div className="yq-list-empty">还没有关注任何人</div>
          ) : (
            myPeople.map((m) => (
              <div key={m.id} className="yq-list-row">
                <Avatar name={m.name} size={32} />
                <div className="yq-flex-1">
                  <div className="yq-list-row-title">{m.name}</div>
                  <div className="yq-list-row-meta">@{m.account}</div>
                </div>
                {followBtn('user', m.id, true)}
              </div>
            ))
          )}
        </div>

        {/*
          可以关注。没有这一块的话，关注页只能看不能加 ——
          你得先在这里关注，才知道这里能关注。
        */}
        {otherSpaces.length + otherPeople.length > 0 && (
          <>
            <div className="yq-section-title" style={{ marginTop: 20 }}>可以关注</div>
            <div className="yq-card">
              {otherSpaces.map((s) => (
                <div key={s.id} className="yq-list-row">
                  <span className="yq-space-avatar">{s.avatar}</span>
                  <div className="yq-flex-1" style={{ minWidth: 0 }}>
                    <div className="yq-list-row-title yq-ellipsis">{s.name}</div>
                    <div className="yq-list-row-meta">{s.kind === 'team' ? '团队空间' : '个人空间'}</div>
                  </div>
                  {followBtn('space', s.id, false)}
                </div>
              ))}
              {otherPeople.map((m) => (
                <div key={m.id} className="yq-list-row">
                  <Avatar name={m.name} size={32} />
                  <div className="yq-flex-1">
                    <div className="yq-list-row-title">{m.name}</div>
                    <div className="yq-list-row-meta">@{m.account}</div>
                  </div>
                  {followBtn('user', m.id, false)}
                </div>
              ))}
            </div>
          </>
        )}
        <p className="yq-space-members-note-text" style={{ marginTop: 10 }}>
          关注是<b>你自己</b>的视图，只影响你自己看到什么。别人不会因为你关注了某个空间而收到通知。
        </p>
      </section>
      <aside className="yq-dash-aside">
        <div className="yq-section-title"><span>推荐知识库</span></div>
        <div className="yq-card">
          {books.map((b) => (
            <div key={b.id} className="yq-list-row">
              <span className="yq-list-icon">{b.avatar}</span>
              <div className="yq-flex-1" style={{ minWidth: 0 }}>
                <div className="yq-list-row-title yq-ellipsis">{b.name}</div>
                <div className="yq-list-row-meta">{bs(b).docCount} 篇</div>
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}

function FavoriteTab() {
  const bs = useBookStats()
  const navigate = useNavigate()
  const { favorites, docs, books, nodes } = useStore()

  if (!favorites.length) {
    return <Empty icon="🔖" text="还没有收藏内容" action={<span style={{ fontSize: 12, color: 'var(--yq-text-4)' }}>在文档右上角点击「☆ 收藏」即可添加</span>} />
  }

  return (
    <section>
      <div className="yq-section-title"><span>我的收藏</span></div>
      <div className="yq-card">
        {favorites.map((f) => {
          const d = f.targetType === 'doc' ? docs[f.targetId] : undefined
          const b = f.targetType === 'book' ? books.find((x) => x.id === f.targetId) : undefined
          return (
            <div
              key={f.id}
              className="yq-list-row"
              onClick={() => (d ? navigate(`/book/${nodes.find((n) => n.docId === d.id)?.bookId || ''}/doc/${d.id}`) : b && navigate(`/book/${b.id}`))}
            >
              <span className="yq-list-icon">{d ? (DOC_TYPE_META[d.type]?.icon ?? '📄') : b?.avatar ?? '📚'}</span>
              <div className="yq-flex-1" style={{ minWidth: 0 }}>
                <div className="yq-list-row-title yq-ellipsis">
                {/*
                  标题取**活的**那一份：`f.title` 只是收藏那一刻的**快照**，
                  文档改名之后它就永远是旧的了 —— 而这页手里明明已经有
                  `d`（活的文档）和 `b`（活的知识库）。
                  2026-10-12 实测：改完标题，收藏夹里那条一直显示旧名字。
                  只有目标已经不在了（删掉的文档）才回退到快照 ——
                  那时快照正是唯一剩下的线索。
                */}
                {d?.title || b?.name || f.title}
              </div>
                <div className="yq-list-row-meta">
                  <Tag size="sm">{f.targetType === 'doc' ? '文档' : '知识库'}</Tag>
                  <span>{timeAgo(f.createdAt)}收藏</span>
                </div>
              </div>
              <button
                className="yq-iconbtn"
                onClick={(e) => { e.stopPropagation(); useStore.getState().toggleFavorite(f.targetType, f.targetId, f.title) }}
                title="取消收藏"
              >
                ★
              </button>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/* ---------------- 工具 ---------------- */

export type FeedItem = {
  key: string
  who: string
  what: string
  target: string
  where?: string
  at: number
  docId?: string
  bookId?: string
  /**
   * 所属空间。空间页的「动态」要按它过滤 ——
   * 语雀点进某个空间能看到**这个空间**的动态，我们原来只有工作台那一层。
   *
   * ⚠️ 三条产出（文档 / 评论 / 话题）都得填，漏一条那条就会在空间页里消失，
   *    而界面上看不出「漏了」，只显得「这个空间没人动过」。
   */
  spaceId?: string
}

/**
 * 团队动态：**从真实数据推导**。
 *
 * ⚠️⚠️ 这里原来是一个**写死的 7 条数组**：
 *
 *   { who: '周砚', what: '更新了文档', target: '线上事故复盘集', at: '12 分钟前' }
 *   { who: '陈小满', what: '评论了', target: '五分钟上手语雀', at: '1 小时前' } …
 *
 * 而且它对**所有人、所有部署形态无条件渲染**。实测一个全新空实例
 * （users=1 / docs=0，2026-10-08）：打开工作台第一眼看到的就是
 *
 *   周砚 更新了文档《线上事故复盘集》· 12 分钟前
 *   陈小满 评论了《五分钟上手语雀》· 1 小时前
 *   苏晚 新建了知识库《团队手册》· 3 小时前
 *   林知远 发布了《2025-10 更新日志》· 昨天
 *   何舟 补充了《性能优化实战》· 昨天
 *
 * **这五个人和这五篇文档在这个实例里一个都不存在。** 公司部署内网知识库
 * 的第一天，同事看到的第一个页面就是虚构的团队活动 —— 这比缺功能严重得多，
 * 它直接摧毁对整个产品的信任。
 *
 * 三处具体的错：
 *   ① **人名与文档在种子里是真的，但关系是编的** —— 《线上事故复盘集》
 *      在 seed.ts:379 是 u2 陈小满建的，feed 却说 u3 周砚更新了它；
 *   ② **时间是写死的字符串** —— 「12 分钟前」永远是 12 分钟前，
 *      三个月后还是 12 分钟前；
 *   ③ 「2025-10 更新日志」「性能优化实战」**在种子里压根不存在**。
 *
 * 为什么之前几轮审计没抓到（值得记）：
 *   · AppData 字段普查 —— 它不是 store 字段，是个字面量数组；
 *   · 接口审计 —— 它不发任何请求；
 *   · 硬编码数字普查 —— 我只扫了「\d+ 篇/个/条」这种形状，
 *     而这里全是**人名 + 文档名**，没有数字。
 *
 * 为什么用「创建了」而不是「更新了」：
 *   客户端 `Doc` 形状里**只有 authorId / createdAt / updatedAt，没有 updatedBy**
 *   —— 「谁最后改的」是真拿不到的。拿 authorId 配 updatedAt 去说
 *   「谁更新了」是**冒名顶替**（同事后来改的会记到作者头上）。
 *   所以只用能对上号的那一组：authorId + createdAt → 「创建了」。
 *   这条和 types/index.ts 里 Topic.replyCount 那段注释是同一个原则：
 *   **拿不到的数据就不要显示，而不是编一个像样的。**
 */
export function buildFeed(src: {
  docs: Record<string, any>
  nodes: any[]
  books: any[]
  comments: Record<string, any[]>
  topics: any[]
  getMember: (id: string) => any
}, opts: { spaceId?: string; limit?: number } = {}): FeedItem[] {
  const { docs, nodes, books, comments, topics, getMember } = src
  const out: FeedItem[] = []
  const nameOf = (id: string) => getMember(id)?.name || '某位同事'

  for (const d of Object.values(docs || {})) {
    if (!d || !d.id) continue
    const node = nodes.find((n) => n.docId === d.id)
    const book = books.find((b) => b.id === node?.bookId)
    out.push({
      key: 'doc:' + d.id,
      who: nameOf(d.authorId),
      what: '创建了',
      target: d.title,
      where: book?.name,
      at: Number(d.createdAt) || 0,
      docId: d.id,
      bookId: node?.bookId,
      spaceId: book?.spaceId,
    })
  }

  for (const [docId, list] of Object.entries(comments || {})) {
    for (const c of list || []) {
      if (!c?.id) continue
      const d = (docs || {})[docId]
      out.push({
        key: 'c:' + c.id,
        who: nameOf(c.authorId),
        what: '评论了',
        target: d?.title || '一篇文档',
        at: Number(c.createdAt) || 0,
        docId,
        // 评论本身没有空间，得顺着 doc → node → book 找回来
        spaceId: books.find((b) => b.id === (nodes.find((n) => n.docId === docId)?.bookId))?.spaceId,
      })
    }
  }

  for (const t of topics || []) {
    if (!t?.id) continue
    out.push({
      key: 't:' + t.id,
      who: nameOf(t.authorId),
      what: '发起了话题',
      target: t.title,
      at: Number(t.createdAt) || 0,
      spaceId: t.spaceId,
    })
  }

  /*
   * ⚠️ 过滤必须**在截断之前**。
   *   原来只有 `.slice(0, 8)`；空间页要按 spaceId 取的话，
   *   如果先截 8 条再过滤，一个活跃空间里那 8 条全属于别的空间 →
   *   空间页就会显示「没人动过」，而这个事实是假的。
   */
  const all = out.filter((f) => f.at > 0).sort((a, b) => b.at - a.at)
  const scoped = opts.spaceId ? all.filter((f) => f.spaceId === opts.spaceId) : all
  return scoped.slice(0, opts.limit ?? 8)
}

function greeting() {
  const h = new Date().getHours()
  if (h < 6) return '凌晨好'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

function today() {
  return new Date().toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  })
}

function formatNum(n: number) {
  return n >= 10000 ? (n / 10000).toFixed(1) + 'w' : String(n)
}
