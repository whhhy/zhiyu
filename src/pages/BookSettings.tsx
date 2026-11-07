import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '@/store'
import { useBookPerms } from '@/lib/perms'
import { bookStats, getMode, purgeDoc, revokeBookInvite } from '@/lib/api'
import { exportBookZip, downloadBytes } from '@/lib/book-export'
import { InviteToBookDialog } from '@/components/collab/BookInvite'
import {
  Avatar, Button, Checkbox, Empty, Input, Modal, Progress, Select, Switch, Tag, Tooltip,
} from '@/components/ui'
import { DOC_TYPE_META, timeAgo } from '@/components/layout/TopBar'
import type { BookMember, Member, NodeType, TreeNode } from '@/types'
import '../styles/layout.css'
import './BookSettings.css'

/* ============================================================
   知识库设置中心 —— 语雀的「目录管理 / 权限 / 安全 / 统计」
   面包屑 + 左侧竖排导航 + 右侧内容卡片
   ============================================================ */

/*
 * ============================================================
   左栏结构 —— **完全对着 2026-10-10 实测的语雀改的**
   （原始记录见 data/_fidelity-booksettings.md）

   实测推翻了原来的两处想当然：
     1. 语雀把左栏**分成两组**：「设置」（知识库信息 / 权限 / 安全设置 / 更多设置）
        和「高级功能」（统计 / 目录管理 / 文档管理 / 消息推送 / 回收站）。
        原来那 4 项是平铺一列，语雀根本不是那样。
     2. **顺序也不一样**。语雀把「知识库信息」放在最前、「统计」排在
        「目录管理」之前 —— 和「按重要性排」的直觉相反，是按它自己的分组排的。
        我原本以为语雀是「目录管理」打头，实测推翻。

   ⚠️ 语雀给安全设置 / 统计 / 消息推送挂了「会员」角标，**这里没抄角标**：
      那是它的付费分层，内网自用抄过来只会让人以为点不开。
      但安全设置与统计的功能本身都在，所以照做。

   ⚠️ 「消息推送」是会员功能，本项目没有推送服务，**不做这个入口** ——
      摆一个点了没反应的菜单，比少一个更糟。
   ============================================================ */

type TabKey = 'basic' | 'perm' | 'security' | 'advanced' | 'stats' | 'catalog' | 'docs' | 'trash'

type TabDef = { key: TabKey; label: string; icon: string }

/** 左栏分组。group 决定渲染到哪个小标题下 —— 语雀就是两个小标题。 */
const TAB_GROUPS: { title: string; tabs: TabDef[] }[] = [
  {
    title: '设置',
    tabs: [
      { key: 'basic', label: '知识库信息', icon: '📘' },
      { key: 'perm', label: '权限', icon: '👥' },
      { key: 'security', label: '安全设置', icon: '🛡️' },
      { key: 'advanced', label: '更多设置', icon: '⚙️' },
    ],
  },
  {
    title: '高级功能',
    tabs: [
      { key: 'stats', label: '统计', icon: '📈' },
      { key: 'catalog', label: '目录管理', icon: '🗂️' },
      { key: 'docs', label: '文档管理', icon: '📄' },
      { key: 'trash', label: '回收站', icon: '🗑️' },
    ],
  },
]

/* ---------------- 角色 ---------------- */

const ROLE_LABEL: Record<BookMember['role'], string> = {
  owner: '拥有者',
  admin: '管理员',
  editor: '编辑者',
  reader: '阅读者',
  visitor: '访客',
}

const ROLE_OPTIONS = (Object.keys(ROLE_LABEL) as BookMember['role'][]).map((v) => ({
  value: v,
  label: ROLE_LABEL[v],
}))

/* ---------------- 权限矩阵 ---------------- */

const PERM_ITEMS: { key: keyof BookMember['perms']; label: string }[] = [
  { key: 'read', label: '阅读' },
  { key: 'comment', label: '评论' },
  { key: 'edit', label: '编辑' },
  { key: 'create', label: '新建' },
  { key: 'export', label: '导出' },
  { key: 'share', label: '分享' },
]

export default function BookSettings() {
  const { bookId = '' } = useParams()
  const navigate = useNavigate()
  const { books } = useStore()
  const [tab, setTab] = useState<TabKey>('basic')

  const book = books.find((b) => b.id === bookId)

  if (!book) {
    return (
      <div className="yq-page">
        <Empty icon="🫥" text="知识库不存在" action={<Button variant="default" onClick={() => navigate('/')}>返回工作台</Button>} />
      </div>
    )
  }

  return (
    <div className="yq-page yq-bset">
      {/* 面包屑：知识库名 / 设置 */}
      <nav className="yq-bset-crumb">
        <button className="yq-bset-crumb-item" onClick={() => navigate(`/book/${book.id}`)}>
          <span className="yq-bset-crumb-avatar">{book.avatar}</span>
          {book.name}
        </button>
        <span className="yq-bset-crumb-sep">/</span>
        <span className="yq-bset-crumb-current">设置</span>
      </nav>

      <div className="yq-bset-layout">
        <nav className="yq-bset-nav">
          {TAB_GROUPS.map((g) => (
            <div key={g.title} className="yq-bset-nav-group">
              <div className="yq-bset-nav-group-title">{g.title}</div>
              {g.tabs.map((t) => (
                <button
                  key={t.key}
                  className={`yq-bset-nav-item ${tab === t.key ? 'is-active' : ''}`}
                  onClick={() => setTab(t.key)}
                >
                  <span className="yq-bset-nav-icon">{t.icon}</span>
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        <div className="yq-bset-body">
          {tab === 'basic' && <BasicTab bookId={book.id} />}
          {tab === 'perm' && <PermTab bookId={book.id} />}
          {tab === 'security' && <SecurityTab bookId={book.id} />}
          {tab === 'advanced' && <AdvancedTab bookId={book.id} />}
          {tab === 'stats' && <StatsTab bookId={book.id} />}
          {tab === 'catalog' && <CatalogTab bookId={book.id} />}
          {tab === 'docs' && <DocsTab bookId={book.id} />}
          {tab === 'trash' && <BookTrashTab bookId={book.id} />}
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   1. 目录管理 —— 完整目录树 + 拖拽排序 + 就地改名
   ============================================================ */

type DropPos = 'before' | 'after' | 'inside'

function CatalogTab({ bookId }: { bookId: string }) {
  const { nodes, docs, renameNode, createNode, moveNode, deleteNode, togglePinDoc, toast } = useStore()
  // 置顶写的是 `docs.pinnedAt`，服务端按 `capsInBook().edit` 判。
  // 与 `PermTab` 同一份判据（服务端同源），fail closed。
  const catCaps = useBookPerms(bookId)
  const catCanEdit = catCaps !== null && catCaps.edit
  const [expanded, setExpanded] = useState<Set<string>>(
    () => new Set(nodes.filter((n) => n.bookId === bookId && n.type === 'group').map((n) => n.id)),
  )
  const [editing, setEditing] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: DropPos } | null>(null)

  const bookNodes = useMemo(() => nodes.filter((n) => n.bookId === bookId), [nodes, bookId])
  const childrenOf = useCallback(
    (parentId: string | null) =>
      bookNodes.filter((n) => n.parentId === parentId).sort((a, b) => a.order - b.order),
    [bookNodes],
  )
  const roots = childrenOf(null)

  const groupCount = bookNodes.filter((n) => n.type === 'group').length
  const docCount = bookNodes.filter((n) => n.docId).length

  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  /** targetId 是否为 ancestorId 的子孙（含自己）—— 防环校验 */
  const isInSubtree = (targetId: string, ancestorId: string): boolean => {
    let cur = bookNodes.find((n) => n.id === targetId)
    while (cur) {
      if (cur.id === ancestorId) return true
      cur = cur.parentId ? bookNodes.find((n) => n.id === cur!.parentId) : undefined
    }
    return false
  }

  /** 拖到行上/下边缘 = 同级前后；拖到分组中间 = 成为子项 */
  const computeDrop = (e: React.DragEvent, node: TreeNode): { id: string; pos: DropPos } | null => {
    if (dragId && node.id === dragId) return null
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const ratio = (e.clientY - rect.top) / rect.height
    if (node.type === 'group' && ratio > 0.3 && ratio < 0.7) {
      if (dragId && isInSubtree(node.id, dragId)) return null
      return { id: node.id, pos: 'inside' }
    }
    if (dragId && node.parentId && isInSubtree(node.parentId, dragId)) return null
    return { id: node.id, pos: ratio < 0.5 ? 'before' : 'after' }
  }

  const resetDrag = () => {
    setDragId(null)
    setDropTarget(null)
  }

  const handleDrop = (target: { id: string; pos: DropPos } | null) => {
    if (!dragId || !target) return resetDrag()
    // 没有编辑权就不动目录，而且**什么都不说** ——
    // 说了「已移到顶层」而服务端没改，比不说更糟（见上面 `draggable` 那段）
    if (!catCanEdit) return resetDrag()
    const node = bookNodes.find((n) => n.id === target.id)
    if (!node) return resetDrag()

    if (target.pos === 'inside') {
      moveNode(dragId, node.id, childrenOf(node.id).length + 1)
      setExpanded((s) => new Set(s).add(node.id))
      toast(`已移动到「${node.title}」内`, 'success')
    } else {
      const sibs = childrenOf(node.parentId).filter((n) => n.id !== dragId)
      const idx = sibs.findIndex((n) => n.id === node.id)
      moveNode(dragId, node.parentId, target.pos === 'before' ? idx : idx + 1)
      toast('目录已调整', 'success')
    }
    resetDrag()
  }

  /** 子树节点数（含自身） */
  const subtreeSize = (id: string): number =>
    1 + childrenOf(id).reduce((sum, c) => sum + subtreeSize(c.id), 0)

  const onCreate = (parentId: string | null, type: NodeType) => {
    /*
     * ⚠️ 原来是无条件 `createNode(...)` 之后直接报「已新建文档」——
     * 而 store 被拒时**返回空串**，于是**读者点完看到的是一条成功提示，
     * 树上什么都没多**。（隔壁「文档管理」那处是同一个病，那边修了，这边漏了。）
     *
     * store 那一道本来就接得住（`bookCreateBlocked`，而这一页挂了
     * `useBookPerms`，caps 问得到）—— 所以这里要做的只是
     * **别把「被拒」说成「已建好」**。
     */
    const id = createNode(bookId, parentId, type)
    if (!id) { toast('在这个知识库里没有新建权限，什么都没建', 'error'); return }
    if (parentId) setExpanded((s) => new Set(s).add(parentId))
    toast(type === 'group' ? '已新建分组' : `已新建${DOC_TYPE_META[type as 'doc']?.label ?? '文档'}`, 'success')
  }

  const onDelete = (node: TreeNode) => {
    const n = subtreeSize(node.id) - 1
    const tip = n > 0 ? `其下 ${n} 个子项会一并删除，` : ''
    // 同样：store 拒了就是没删，不能报「已移入回收站」
    if (!catCanEdit) { toast('在这个知识库里没有删除权限，什么都没删', 'error'); return }
    if (confirm(`确定删除「${node.title}」？${tip}可从回收站找回文档。`)) {
      deleteNode(node.id)
      toast('已移入回收站', 'info')
    }
  }

  const renderNode = (node: TreeNode, depth: number): React.ReactNode => {
    const kids = childrenOf(node.id)
    const isOpen = expanded.has(node.id)
    const isGroup = node.type === 'group'
    const doc = node.docId ? docs[node.docId] : undefined
    /** 这篇有没有被置顶 —— 侧边树据此插队，这里据此显示标记（见下面那个 📌 的注释） */
    const isPinned = Number(doc?.pinnedAt) > 0
    const drop = dropTarget?.id === node.id ? dropTarget.pos : null

    return (
      <div key={node.id} className="yq-bset-row-wrap">
        <div
          className={`yq-bset-row ${isGroup ? 'is-group' : ''} ${dragId === node.id ? 'is-dragging' : ''} drop-${drop || 'none'}`}
          data-node-id={node.id}
          data-node-title={node.title}
          style={{ paddingLeft: 8 + depth * 22 }}
          /*
       * ⚠️ 拖拽也写目录结构（`moveNode`），所以它和上面那几个按钮是**同一类入口**。
       *   原来 `draggable` 是无条件的 —— 读者能把整棵树拖着玩，
       *   拖完弹一句「已移到顶层」，而服务端一条没改（`moveNode` 有守卫）。
       *   拖拽没法「禁用」，只能不给拖。
       */
      draggable={catCanEdit && editing !== node.id}
          onDragStart={(e) => {
            setDragId(node.id)
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', node.id)
          }}
          onDragEnd={resetDrag}
          onDragOver={(e) => {
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            setDropTarget(computeDrop(e, node))
          }}
          onDragLeave={() => setDropTarget(null)}
          onDrop={(e) => {
            e.preventDefault()
            e.stopPropagation()
            handleDrop(computeDrop(e, node))
          }}
          onClick={() => isGroup && toggle(node.id)}
          // 改名也是写（`renameNode`）。原来双击就能进编辑态，而 store 的守卫会
          // **静默丢弃** —— 输入框一关改名就没了，用户分不清是自己没权限还是系统吃掉了。
          onDoubleClick={() => { if (catCanEdit) setEditing(node.id) }}
        >
          <span className="yq-bset-handle" title="拖拽排序">⠿</span>

          {isGroup ? (
            <span
              className={`yq-bset-caret ${isOpen ? 'is-open' : ''}`}
              onClick={(e) => { e.stopPropagation(); toggle(node.id) }}
            >
              ▸
            </span>
          ) : (
            <span className="yq-bset-caret is-ph" />
          )}

          <span className="yq-bset-icon">
            {isGroup ? (isOpen ? '📂' : '📁') : DOC_TYPE_META[doc?.type || (node.type as 'doc')]?.icon ?? '📄'}
          </span>

          {editing === node.id ? (
            <input
              className="yq-bset-input"
              defaultValue={node.title}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onDragStart={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v && v !== node.title) renameNode(node.id, v)
                setEditing(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <span className="yq-bset-title yq-ellipsis">
              {/*
                置顶标记。⚠️ 这一屏以前**一个 pin 字样都没有**，于是：
                  · 在侧边树置顶了一篇，切到这里 —— 没有任何迹象，像是被清掉了；
                  · 想取消置顶只能回侧边树，这里的行内只有 ＋ 和 🗑；
                  · 而这一屏**能拖拽排序**，拖动置顶项之后侧边树仍会把它插到最前，
                    那一屏却什么都不解释 —— 用户只会觉得「拖了没反应」。
                置顶不改 order（改的是渲染时的插队），所以两处顺序天然不同，
                这个标记就是解释那个不同的唯一线索。
              */}
              {isPinned && <span className="yq-bset-pin" title="已置顶（侧边树里会排在同组最前）">📌</span>}
              {node.title}
            </span>
          )}

          <span className="yq-bset-row-meta">
            {isGroup ? `${subtreeSize(node.id) - 1} 项` : doc ? `${doc.wordCount} 字 · ${timeAgo(doc.updatedAt)}` : '—'}
          </span>

          <div className="yq-bset-row-actions" onClick={(e) => e.stopPropagation()}>
            {/* 分组没有「文稿」，也就无从置顶 —— 语雀那边置顶是挂在文稿上的 */}
            {!isGroup && node.docId && (
              <Tooltip title={isPinned ? '取消置顶' : '置顶（侧边树里排在同组最前）'}>
                <button
                  className={`yq-bset-row-act ${isPinned ? 'is-on' : ''}`}
                  disabled={!catCanEdit}
                  onClick={() => togglePinDoc(String(node.docId))}
                >
                  📌
                </button>
              </Tooltip>
            )}
            <Tooltip title="新建子项">
              <button className="yq-bset-row-act" disabled={!catCanEdit}
                title={catCanEdit ? '' : '在这个知识库里没有新建权限'}
                onClick={() => onCreate(node.id, 'doc')}>＋</button>
            </Tooltip>
            <Tooltip title="删除">
              <button className="yq-bset-row-act" disabled={!catCanEdit}
                title={catCanEdit ? '' : '在这个知识库里没有删除权限'}
                onClick={() => onDelete(node)}>🗑</button>
            </Tooltip>
          </div>
        </div>

        {isOpen && kids.length > 0 && (
          <div className="yq-bset-children">{kids.map((c) => renderNode(c, depth + 1))}</div>
        )}
      </div>
    )
  }

  return (
    <section className="yq-card yq-bset-card">
      <header className="yq-bset-card-head">
        <div>
          <h2 className="yq-bset-card-title">目录管理</h2>
          <p className="yq-bset-card-desc">
            拖拽条目可调整顺序：拖到条目上/下边缘插入同级前后，拖到分组中间成为其子项；双击标题可改名。
          </p>
        </div>
        <div className="yq-bset-head-actions">
          {/* 与上面两个行内按钮同一口径：一个标签里的写入口要么全开、要么全关，
              逐个加 disabled 必然漏一个（这三个之前就漏了）。 */}
          <Button variant="default" size="sm" icon="📁" disabled={!catCanEdit}
            title={catCanEdit ? '' : '在这个知识库里没有新建权限'}
            onClick={() => onCreate(null, 'group')}>新建分组</Button>
          <Button variant="primary" size="sm" icon="＋" disabled={!catCanEdit}
            title={catCanEdit ? '' : '在这个知识库里没有新建权限'}
            onClick={() => onCreate(null, 'doc')}>新建文档</Button>
        </div>
      </header>

      {roots.length === 0 ? (
        <Empty
          icon="🗂️"
          text="目录还是空的，点右上角开始编排吧"
          action={
            <Button variant="primary" disabled={!catCanEdit}
              title={catCanEdit ? '' : '在这个知识库里没有新建权限'}
              onClick={() => onCreate(null, 'doc')}>新建文档</Button>
          }
        />
      ) : (
        <div
          className={`yq-bset-tree ${dropTarget?.id === '__root__' ? 'drop-inside' : ''}`}
          onDragOver={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node)) return
            e.preventDefault()
            setDropTarget({ id: '__root__', pos: 'inside' })
          }}
          onDrop={(e) => {
            e.preventDefault()
            if (dropTarget?.id === '__root__' && dragId) {
              if (!catCanEdit) { resetDrag(); return }
              moveNode(dragId, null, roots.length)
              toast('已移到顶层', 'success')
              resetDrag()
            }
          }}
        >
          {roots.map((n) => renderNode(n, 0))}
        </div>
      )}

      <footer className="yq-bset-tree-foot">
        共 <b>{groupCount}</b> 个目录 / <b>{docCount}</b> 篇文档
        <span className="yq-bset-tree-foot-hint">删除的文档可在右上角「回收站」找回</span>
      </footer>
    </section>
  )
}

/* ============================================================
   2. 权限 —— 成员表格 + 权限矩阵 + 公开访问
   ============================================================ */

function PermTab({ bookId }: { bookId: string }) {
  const { members, getMember, getBookMembers, updateMemberRole, updateMemberPerm, removeBookMember, addBookMembers, getBookSettings, updateBookSettings, toast } =
    useStore()
  const [openId, setOpenId] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  /** 「邀请」弹窗。与 addOpen 分开：两个入口语义不同，不该共用一个开关 */
  const [inviteOpen, setInviteOpen] = useState(false)
  /*
   * ⚠️ 这两样要**真的从 store 取**，不能凭印象写名字：
   *   第一版写了个 `currentUserId`，而 store 里根本没这个字段 ——
   *   tsc 会报「找不到名字」，而如果它恰好叫别的名字我就得再改一轮。
   *   所以直接看 store 的解构行（见上面第 403 行）。
   */
  const { getSentInvites, currentUser } = useStore()
  const [picked, setPicked] = useState<string[]>([])

  /**
   * 我在这个库里发出去、**还等着对方处理**的。
   *
   * ⚠️ 用 store 的 action，**不在这儿自己 filter 一遍** ——
   *   第一版就是自己算的，于是 `getSentInvites` 声明了却没人调用，
   *   而同一份口径在两处各算一遍迟早会漂
   *   （本项目吃过这个亏：面包屑的 crumbDoc 算两遍，
   *   「文档标题」和「目录树标题」就分叉了）。
   */
  const myRole = getBookMembers(bookId).find((m) => m.id === currentUser.id)?.role
  const iAmAdmin = myRole === 'owner' || myRole === 'admin'
  const pending = getSentInvites(bookId).filter((i) => i.fromUserId === currentUser.id || iAmAdmin)
  const [pickRole, setPickRole] = useState<BookMember['role']>('editor')

  const bookMembers = getBookMembers(bookId)
  const settings = getBookSettings(bookId)
  const candidates = members.filter((m) => !bookMembers.some((b) => b.id === m.id))

  /**
   * 「能不能改成员」—— 判 **`admin`，不是 `edit`**。
   *
   * 服务端 `server/sync.ts` 把 `bookMembers` 和 `bookSettings` 放一起判：
   * `capsInBook(user, bookId).admin`，拒绝文案「需要该知识库的管理员权限」。
   * **editor 的 admin 是 false** —— 编辑者也不能改成员，这是有意的。
   *
   * ⚠️ 这一节以前**一个门都没有**（实测探针，visitor / reader / editor 各一轮）：
   * `BookSettings` 整页没有角色门、路由也不挡，任何成员敲 URL 就进得来，
   * 而下面这两个按钮无条件渲染。于是**一个阅读者**点「添加成员」把某人设成
   * 管理员，**名单当场就变了**，服务端一条没改，顶栏挂 4 条修不好的告警。
   *
   * 用 `useBookPerms`（服务端同源）而不是本地 `myRole` ——
   * 两处各算一遍迟早会漂，漂了就会出现「界面说有、其实没有」。
   * 权限还没问回来时按「不能」处理（fail closed），与 `Tree.tsx` 一致。
   */
  const caps = useBookPerms(bookId)
  const canAdmin = caps !== null && caps.admin

  const onAdd = () => {
    if (!picked.length) return
    // 一次 commit：同步只推一条记录，中途断网不会出现「只加进去一半」
    addBookMembers(bookId, picked, pickRole)
    toast(
      picked.length === 1
        ? `已添加 ${getMember(picked[0])?.name} 为${ROLE_LABEL[pickRole]}`
        : `已添加 ${picked.length} 位成员为${ROLE_LABEL[pickRole]}`,
      'success',
    )
    setAddOpen(false)
    setPicked([])
    setPickRole('editor')
  }

  return (
    <>
      <section className="yq-card yq-bset-card">
        <header className="yq-bset-card-head">
          <div>
            <h2 className="yq-bset-card-title">成员与权限</h2>
            <p className="yq-bset-card-desc">点击成员行可展开该成员在本知识库的操作权限矩阵。</p>
          </div>
          <div className="yq-flex yq-gap-8">
            {canAdmin ? (
              <>
                <Button variant="default" size="sm" icon="✉️" onClick={() => setInviteOpen(true)}>邀请</Button>
                <Button variant="primary" size="sm" icon="＋" onClick={() => setAddOpen(true)}>添加成员</Button>
              </>
            ) : (
              <span className="yq-bset-card-hint">只有知识库管理员能改成员</span>
            )}
          </div>
        </header>

        {bookMembers.length === 0 ? (
          <Empty icon="👥" text="还没有成员，添加一个人开始协作"
            action={canAdmin ? <Button variant="primary" onClick={() => setAddOpen(true)}>添加成员</Button> : undefined} />
        ) : (
          <div className="yq-bset-members">
            <div className="yq-bset-member yq-bset-member-head">
              <span className="yq-bset-member-id">成员</span>
              <span className="yq-bset-member-role">角色</span>
              <span className="yq-bset-member-join">加入时间</span>
              <span className="yq-bset-member-op" />
            </div>

            {bookMembers.map((bm) => {
              const m = getMember(bm.id)
              const open = openId === bm.id
              return (
                <div key={bm.id} className={`yq-bset-member-group ${open ? 'is-open' : ''}`}>
                  <div className="yq-bset-member" onClick={() => setOpenId(open ? null : bm.id)}>
                    <span className="yq-bset-member-id">
                      <Avatar name={m?.name || '?'} size={30} />
                      <span className="yq-bset-member-text">
                        <span className="yq-bset-member-name">{m?.name || '未知成员'}</span>
                        <span className="yq-bset-member-account">@{m?.account ?? '—'}</span>
                      </span>
                    </span>

                    <span className="yq-bset-member-role" onClick={(e) => e.stopPropagation()}>
                      <Select
                        size="sm"
                        value={bm.role}
                        disabled={!canAdmin}
                        options={ROLE_OPTIONS}
                        onChange={(v) => {
                          updateMemberRole(bookId, bm.id, v as BookMember['role'])
                          toast(`已将 ${m?.name} 设为${ROLE_LABEL[v as BookMember['role']]}`, 'success')
                        }}
                      />
                    </span>

                    <span className="yq-bset-member-join">{new Date(bm.joinedAt).toLocaleDateString('zh-CN')}</span>

                    <span className="yq-bset-member-op" onClick={(e) => e.stopPropagation()}>
                      <Tooltip title={bm.role === 'owner' ? '拥有者不可移除' : '移除成员'}>
                        <button
                          className="yq-bset-op-btn"
                          disabled={!canAdmin || bm.role === 'owner'}
                          onClick={() => {
                            if (confirm(`确定将「${m?.name}」移出本知识库？`)) {
                              removeBookMember(bookId, bm.id)
                              toast('已移除成员', 'info')
                            }
                          }}
                        >
                          移除
                        </button>
                      </Tooltip>
                    </span>
                  </div>

                  {open && (
                    <div className="yq-bset-perm">
                      <div className="yq-bset-perm-title">
                        {m?.name} 的权限
                        <span className="yq-bset-perm-hint">拥有者与管理员默认拥有全部权限</span>
                      </div>
                      <div className="yq-bset-perm-grid">
                        {PERM_ITEMS.map((p) => (
                          <div key={p.key} className="yq-bset-perm-cell">
                            <Checkbox
                              checked={bm.perms[p.key]}
                              disabled={!canAdmin || bm.role === 'owner' || bm.role === 'admin'}
                              onChange={(v) => updateMemberPerm(bookId, bm.id, p.key, v)}
                            >
                              {p.label}
                            </Checkbox>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className="yq-card yq-bset-card">
        <div className="yq-bset-card-title">外部成员与公开访问</div>
        <p className="yq-bset-card-desc">控制知识库是否对互联网公开，公开后链接可被任何人访问。</p>
        <div className="yq-bset-line">
          <div className="yq-bset-line-main">
            <div className="yq-bset-line-label">互联网上获得链接的人可阅读</div>
            <div className="yq-bset-line-desc">
              开启后，任何拿到文档链接的人都可以阅读本知识库中文档为「互联网可见」的部分。
            </div>
          </div>
          {settings.publicAccess ? <Tag color="warning" size="sm">互联网可见</Tag> : <Tag size="sm">仅限成员</Tag>}
          <Switch
            checked={settings.publicAccess}
            onChange={(v) => {
              updateBookSettings(bookId, { publicAccess: v })
              toast(v ? '已开启公开访问' : '已关闭公开访问', 'success')
            }}
          />
        </div>
      </section>

      {/*
       * 我发出去的邀请。
       *
       * ⚠️ 没有它的话管理员**除了等没有别的办法**：
       *   对方没处理时这里一片空白，他只能再点一次邀请，
       *   而那会拿到一句「之前已经邀请过他了」——
       *   等于告诉他「你只能等」，却什么都不显示。
       */}
      {pending.length > 0 && (
        <section className="yq-card yq-bset-card">
          <h2 className="yq-bset-card-title">等待对方处理（{pending.length}）</h2>
          <p className="yq-bset-card-desc">
            对方登录后在工作台的「协作邀请」里能看到。发出去之后**只有他能决定**进不进这个库。
          </p>
          <div className="yq-bset-members" style={{ marginTop: 12 }}>
            {pending.map((inv) => {
              // 成员表里未必有这个人（他可能还没进任何空间 / 列表没加载完）。
              // 原来查不到就写死「未知成员」—— 而服务端把名字一起发过来了（inv.toName），
              // 用户于是看着「未知成员」，只能退回成员表里一个个找。
              const toName = getMember(inv.toUserId)?.name || inv.toName || '未知成员'
              return (
              <div key={inv.id} className="yq-bset-member">
                <span className="yq-bset-member-id">
                  <Avatar name={toName} size={30} />
                  <span className="yq-bset-member-text">
                    <span className="yq-bset-member-name">{toName}</span>
                    <span className="yq-bset-member-account">
                      {timeAgo(inv.createdAt)}发出 · {inv.role === 'editor' ? '编辑者' : '阅读者'}
                      {inv.message ? ` · 「${inv.message}」` : ''}
                    </span>
                  </span>
                </span>
                <span className="yq-bset-member-op">
                  <Button
                    size="sm"
                    variant="text"
                    onClick={() => {
                      revokeBookInvite(inv.id)
                        .then(() => toast('已撤回这条邀请', 'info'))
                        .catch((e: any) => toast(e?.message || '撤回失败', 'error'))
                    }}
                  >
                    撤回
                  </Button>
                </span>
              </div>
              )
            })}
          </div>
        </section>
      )}

      <InviteToBookDialog bookId={bookId} open={inviteOpen} onClose={() => setInviteOpen(false)} />

      <Modal
        open={addOpen}
        onClose={() => { setAddOpen(false); setPicked([]) }}
        title={picked.length > 1 ? `添加成员（已选 ${picked.length} 人）` : '添加成员'}
        width={440}
        footer={
          <>
            <Button variant="text" onClick={() => { setAddOpen(false); setPicked([]) }}>取消</Button>
            <Button variant="primary" disabled={!picked.length} onClick={onAdd}>
              {picked.length > 1 ? `添加 ${picked.length} 位成员` : '确认添加'}
            </Button>
          </>
        }
      >
        {candidates.length === 0 ? (
          <Empty icon="🎉" text="空间里的成员都已在知识库中了" />
        ) : (
          <AddMembersBody
            candidates={candidates}
            picked={picked}
            onToggle={(id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))}
            onPickAll={(ids) => setPicked(ids)}
            role={pickRole}
            onRole={setPickRole}
          />
        )}
      </Modal>
    </>
  )
}

/* ============================================================
   批量添加成员
   ------------------------------------------------------------
   一次加一个，在公司里是不能用的：给一个 200 人的空间开通知识库，
   要点 200 次。所以这里做多选 + 搜索 + 全选。

   「全选」选的是**当前搜索结果**而不是全部候选 —— 搜出 8 个人时，
   按全选应当只加这 8 个，而不是把另外 90 个也加进去。
   这种「以为是筛选，其实是全选」的差异，用户要等到事后看成员列表才发现。
   ============================================================ */

function AddMembersBody({
  candidates,
  picked,
  onToggle,
  onPickAll,
  role,
  onRole,
}: {
  candidates: Member[]
  picked: string[]
  onToggle: (id: string) => void
  onPickAll: (ids: string[]) => void
  role: BookMember['role']
  onRole: (r: BookMember['role']) => void
}) {
  const [kw, setKw] = useState('')
  const filtered = useMemo(() => {
    const q = kw.trim().toLowerCase()
    if (!q) return candidates
    return candidates.filter(
      (m) => m.name.toLowerCase().includes(q) || String(m.account || '').toLowerCase().includes(q),
    )
  }, [candidates, kw])

  const filteredIds = filtered.map((m) => m.id)
  const allPicked = filteredIds.length > 0 && filteredIds.every((id) => picked.includes(id))

  return (
    <>
      <div className="yq-bset-modal-label">选择成员</div>

      <Input
        size="sm"
        className="yq-bset-pick-search"
        value={kw}
        onChange={(e: any) => setKw(e.target.value)}
        placeholder="搜索姓名或账号"
        prefix={<span style={{ color: 'var(--yq-text-4)' }}>🔍</span>}
      />

      <div className="yq-bset-pick-bar">
        <Checkbox
          checked={allPicked}
          onChange={(v) => onPickAll(v ? filteredIds : [])}
        >
          {kw.trim() ? `全选搜索结果（${filtered.length}）` : `全选（${candidates.length}）`}
        </Checkbox>
        {picked.length > 0 && (
          <span className="yq-bset-pick-count">已选 {picked.length} 人</span>
        )}
      </div>

      <div className="yq-bset-modal-list yq-bset-modal-list-multi">
        {filtered.length === 0 ? (
          <div className="yq-bset-pick-none">没有匹配的成员</div>
        ) : (
          filtered.map((m) => {
            const on = picked.includes(m.id)
            return (
              <label key={m.id} className={`yq-bset-modal-item is-multi ${on ? 'is-active' : ''}`}>
                <Checkbox checked={on} onChange={() => onToggle(m.id)} />
                <Avatar name={m.name} size={28} />
                <span className="yq-bset-member-text">
                  <span className="yq-bset-member-name">{m.name}</span>
                  <span className="yq-bset-member-account">@{m.account}</span>
                </span>
              </label>
            )
          })
        )}
      </div>

      <div className="yq-bset-modal-label">设置角色（对本次选中的所有人）</div>
      <Select value={role} options={ROLE_OPTIONS} onChange={(v) => onRole(v as BookMember['role'])} />
      <p className="yq-bset-modal-hint">
        角色决定成员的默认权限，添加后可在成员列表中逐项调整。
      </p>
    </>
  )
}

/* ============================================================
   3. 安全 —— 导出限制 / 水印 / IP 白名单 / 离职回收
   ============================================================ */

function SecurityTab({ bookId }: { bookId: string }) {
  const { getBookSettings, updateBookSettings, toast } = useStore()
  const [ipInput, setIpInput] = useState('')
  const [termInput, setTermInput] = useState('')
  const s = getBookSettings(bookId)

  /**
   * 安全设置整节是 **admin 专属**（服务端把 `bookSettings` 和 `bookMembers`
   * 放一起按 `capsInBook().admin` 判）。
   *
   * ⚠️ 这里**整节早退**而不是给五个开关逐个加 `disabled` ——
   * 逐个加必漏一个，而漏掉的那个就是又一处「界面给了服务端不允许的动作」。
   * 一个门覆盖全节，结构上不可能漏（`DangerZone` 早就是这么写的）。
   *
   * 页面路由本身不挡（任何成员敲 URL 都进得来），这一节以前**完全没有门**：
   * 导出限制 / 水印 / IP 白名单 / 屏蔽词 / 离职回收 五个开关谁都点得动，
   * 点完本地变了、服务端拒（`需要该知识库的管理员权限`），顶栏挂一条修不好的告警。
   */
  const secCaps = useBookPerms(bookId)
  const secCanAdmin = secCaps !== null && secCaps.admin
  if (!secCanAdmin) {
    return (
      <section className="yq-card yq-bset-card">
        <div className="yq-bset-card-title">安全</div>
        <Empty icon="🔒" text="安全设置只有知识库管理员能改" />
      </section>
    )
  }

  const addIp = () => {
    const v = ipInput.trim()
    if (!v) return
    if (s.ipList.includes(v)) {
      toast('该 IP 已在白名单中', 'info')
      setIpInput('')
      return
    }
    updateBookSettings(bookId, { ipList: [...s.ipList, v] })
    setIpInput('')
  }

  /**
   * 删掉一个 IP。**删掉最后一个时要把开关一起关掉** ——
   * 「开着 + 空名单」这个组合压根不该存在：
   *   · 服务端对它是 fail closed（空名单 = 谁都进不来），一旦产生，
   *     管理员连这一页都进不来（`bookSettings` 自己也在 IP 过滤里），
   *     而界面上开关显示为「关」—— 显示和实际正好相反；
   *   · 服务端写入侧也会直接拒掉这种组合（`denyReason` 里那条）。
   * 所以这里主动带上 `ipWhitelist: false`，让这个状态压根推不出去。
   */
  const removeIp = (ip: string) => {
    const rest = s.ipList.filter((x) => x !== ip)
    if (!rest.length && s.ipWhitelist) {
      updateBookSettings(bookId, { ipList: rest, ipWhitelist: false })
      toast('名单已清空，IP 白名单已一并关闭（空名单会把整个知识库对所有 IP 关闭）', 'info')
      return
    }
    updateBookSettings(bookId, { ipList: rest })
  }

  const addTerm = () => {
    const v = termInput.trim()
    if (!v) return
    const cur = s.blockTerms || []
    if (cur.includes(v)) {
      toast('该词已在屏蔽列表中', 'info')
      setTermInput('')
      return
    }
    updateBookSettings(bookId, { blockTerms: [...cur, v] })
    setTermInput('')
  }

  return (
    <section className="yq-card yq-bset-card">
      <div className="yq-bset-card-title">安全</div>
      <p className="yq-bset-card-desc">以下设置作用于本知识库的全部文档，对所有成员生效。</p>

      <div className="yq-bset-line">
        <div className="yq-bset-line-main">
          <div className="yq-bset-line-label">导出限制</div>
          <div className="yq-bset-line-desc">
            禁止把<b>整个工作台</b>一键导出为数据包（平台管理员除外，用于备份）。
            注意：它<b>挡不住</b>「已读权限的人复制正文」—— Markdown / Word / HTML
            是在浏览器本地生成的，文字到了别人屏幕上就收不回来了。
            真要防外流，请给对方只读角色，或不给读权限。
          </div>
        </div>
        <Switch
          checked={s.restrictExport}
          onChange={(v) => {
            updateBookSettings(bookId, { restrictExport: v })
            toast(v ? '已开启导出限制' : '已关闭导出限制', 'success')
          }}
        />
      </div>

      <div className="yq-bset-line">
        <div className="yq-bset-line-main">
          <div className="yq-bset-line-label">全局水印</div>
          <div className="yq-bset-line-desc">
            在文档正文上叠加水印，内容是「文案 + 当前阅读人的姓名与账号」，
            随手截屏外传时可以追到人。
            <br />
            ⚠️ 这是<b>网页水印</b>：有技术能力的人用开发者工具可以去掉。
            它的作用是「降低随手外传的概率并留下线索」，不是「防技术手段」——
            真要防外泄，请配合只读角色和导出限制。
          </div>
        </div>
        <Switch
          checked={s.watermark}
          onChange={(v) => {
            updateBookSettings(bookId, { watermark: v })
            toast(v ? '已开启全局水印' : '已关闭全局水印', 'success')
          }}
        />
      </div>

      {s.watermark && (
        <div className="yq-bset-subline">
          <div className="yq-bset-line-label">水印文案</div>
          <div className="yq-bset-ip-input">
            <Input
              value={s.watermarkText}
              placeholder="例如：源子科技 · 内部资料"
              onChange={(e) => updateBookSettings(bookId, { watermarkText: e.target.value })}
            />
          </div>
          <div className="yq-bset-line-desc">
            水印会附加当前阅读人的姓名与账号；<b>对外分享页上访客没有账号，改带访客的 IP</b>。
          </div>
        </div>
      )}

      <div className="yq-bset-line">
        <div className="yq-bset-line-main">
          <div className="yq-bset-line-label">IP 白名单</div>
          <div className="yq-bset-line-desc">
            仅允许下列 IP <b>读取本知识库的正文</b>，其余请求会被服务端拒绝（403）。
            填的是你看到的来源地址；经 nginx 反代时取 <code>X-Forwarded-For</code> 的第一段。
            <br />
            <b>名单里至少要有一个地址才能开启</b>：空名单等于没设防
            （服务端会把它当成「谁都不许进」，而设置页也会跟着一起进不来）。
          </div>
        </div>
        <Switch
          checked={s.ipWhitelist}
          /*
           * ⚠️ 只有「关 → 开」这一侧会被挡，**「开 → 关」永远不挡**。
           * 万一库里已经存在「开着 + 空名单」（老数据 / 直接改库），
           * 挡掉关闭就等于把管理员**永久锁在这个状态里** ——
           * 那正是「修安全设置时把门焊死」这类事故的典型形状。
           */
          disabled={!s.ipWhitelist && s.ipList.length === 0}
          onChange={(v) => {
            if (v && s.ipList.length === 0) {
              toast('先在下面添加至少一个 IP，才能开启白名单', 'info')
              return
            }
            updateBookSettings(bookId, { ipWhitelist: v })
            toast(v ? '已开启 IP 白名单' : '已关闭 IP 白名单', 'success')
          }}
        />
      </div>

      {/*
       * 名单编辑区**一直显示**，不再跟着开关走。
       *
       * ⚠️ 这里原来是 `{s.ipWhitelist && …}`，而同一屏上开关又改成
       * 「名单为空时不让开」—— **两条规则叠在一起就成了死锁**：
       *   开关关着 → 编辑区不渲染 → 加不了 IP → 开关永远开不了。
       * 而且它**不报任何错**：开关就在那儿，只是灰着，点不动，
       * 界面上也没有一句话说明「要先加 IP」。
       * （这个项目里「两条各自正确的规则叠出没人设计的中间态」栽过好几次，
       *   症状都是某个功能彻底不能用而没有任何提示。）
       *
       * 常驻显示顺带也对：**先把管理员自己的 IP 加进去，再开开关** ——
       * 白名单对管理员自己也不豁免，顺序反了就是把自己关在门外。
       */}
      <div className="yq-bset-subline">
          <div className="yq-bset-ip-list">
            {s.ipList.map((ip) => (
              <Tag key={ip} size="sm" onClose={() => removeIp(ip)}>
                {ip}
              </Tag>
            ))}
            {s.ipWhitelist && s.ipList.length === 0 && (
              <span className="yq-bset-line-desc">
                ★ 名单是空的：当前这个库<b>对所有 IP 都是关闭的</b>，包括你自己。删掉最后一条会自动把白名单关掉。
              </span>
            )}
            {!s.ipWhitelist && s.ipList.length === 0 && (
              <span className="yq-bset-line-desc">
                先在下面添加至少一个 IP，上面的开关才可用（空名单开启等于没锁门）。
              </span>
            )}
            {/*
             * 白名单**对管理员自己也不豁免** —— 这条是刻意的，理由见 server/perms.ts 里
             * `ipAllowed` 的注释：它判断的是「请求从哪来」（网络层），
             * 而不是「谁在请求」（权限层）。早先给 owner 加过豁免，
             * 结果访问令牌（通常是 owner 发的）继承了豁免，
             * `/api/v2` 的白名单整个失效 —— `test-v2ip` 当时 18 项全红。
             *
             * 所以这里必须写明：**开之前先把自己的 IP 加进去**，
             * 否则管理员会把自己关在这个库外面。
             */}
            {s.ipWhitelist && s.ipList.length > 0 && (
              <span className="yq-bset-line-desc">
                管理员也不豁免 —— 自己的 IP 不在名单里的话，你也进不来
              </span>
            )}
          </div>
          <div className="yq-bset-ip-input">
            <Input
              value={ipInput}
              placeholder="输入 IP 地址后回车添加，如 203.0.113.24"
              onChange={(e) => setIpInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addIp()
              }}
            />
            <Button variant="default" onClick={addIp}>添加</Button>
          </div>
      </div>

      <div className="yq-bset-line">
        <div className="yq-bset-line-main">
          <div className="yq-bset-line-label">搜索关键词屏蔽</div>
          <div className="yq-bset-line-desc">
            含下列词的<b>搜索请求会被服务端直接拒绝</b>，返回空结果。
            用来防「靠猜关键词把不该看的文档搜出来」——
            比如薪酬、并购这类词，猜中了也不给结果。
            <br />
            挡的是<b>查询词</b>，不是「结果里含这个词的文档」——
            后者会把整个知识库连正常内容一起抹掉。
            命中任意一个即拦，大小写不敏感。
          </div>
        </div>
        <Switch
          checked={!!s.blockSearch}
          onChange={(v) => {
            updateBookSettings(bookId, { blockSearch: v })
            toast(v ? '已开启搜索关键词屏蔽' : '已关闭搜索关键词屏蔽', 'success')
          }}
        />
      </div>

      {s.blockSearch && (
        <div className="yq-bset-subline">
          <div className="yq-bset-ip-list">
            {(s.blockTerms || []).map((t) => (
              <Tag key={t} size="sm" onClose={() => updateBookSettings(bookId, { blockTerms: (s.blockTerms || []).filter((x) => x !== t) })}>
                {t}
              </Tag>
            ))}
            {(s.blockTerms || []).length === 0 && (
              <span className="yq-bset-line-desc">词表为空 —— 开着等于没开，建议至少加一个</span>
            )}
          </div>
          <div className="yq-bset-ip-input">
            <Input
              value={termInput}
              placeholder="输入要屏蔽的词后回车添加，如 薪酬"
              onChange={(e) => setTermInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addTerm() }}
            />
            <Button variant="default" onClick={addTerm}>添加</Button>
          </div>
        </div>
      )}

      <div className="yq-bset-line">
        <div className="yq-bset-line-main">
          <div className="yq-bset-line-label">离职权限自动回收</div>
          <div className="yq-bset-line-desc">
            管理员在「设置 → 成员管理」办理离职时，
            <b>开了这个开关的知识库会一并收回</b>他的权限；
            关掉的库会保留他的成员身份，方便交接期或只做单个库的外包。
            <br />
            办离职本身会清掉他的全部登录会话、移出所有空间 —— 那部分不受本开关影响。
          </div>
        </div>
        <Switch
          checked={s.autoRevoke}
          onChange={(v) => {
            updateBookSettings(bookId, { autoRevoke: v })
            toast(v ? '已开启离职权限回收' : '已关闭离职权限回收', 'success')
          }}
        />
      </div>

      {/* ⚠️ 删除知识库**不在这页**了。
          2026-10-10 实测语雀：它把「删除知识库」放在「更多设置」那一节
          （和「导出知识库」「转移知识库」并排），不在安全设置页。
          实测记录见 data/_fidelity-booksettings.md。
          这里留一行指路，免得用户以为功能没了。 */}
      <p className="yq-bset-hint">
        要删除整个知识库，去「更多设置」。
      </p>
    </section>
  )
}

/* ============================================================
   危险操作区 —— 删除知识库
   ------------------------------------------------------------
   产品以前**完全没有**删除知识库的能力：没有 store 方法、没有服务端端点、
   UI 没有入口。`test-mdimport-e2e` 里就写着这个缺口 ——
   它每跑一次就留下一个清不掉的「导入夹具」库。

   语义 = **硬删**，跟语雀一致（语雀的回收站只管文档、不管知识库），
   所以这一步**没有后悔药**。因此这一块的重点不是「怎么删」，
   而是**别让人误删**：

     · 只有知识库管理员看得见（服务端也会再判一次，不靠前端藏）
     · 先告诉用户**会连带删掉几篇文档**，不是「可能会删除一些内容」这种含糊话
     · 必须**手打库名**才能点得动 —— 手打比点一下「确定」慢三秒，
       而这三秒正是防误删的全部意义
     · 文案说死「**不可恢复**」。写成「已移入回收站」而实际没进回收站，
       是这类操作里最糟的一种：用户照着文案理解自己的数据状态，
       得到的结论是错的。
   ============================================================ */

function DangerZone({ bookId }: { bookId: string }) {
  const { books, nodes, deleteBook, toast, currentUser, getBookMembers } = useStore()
  const navigate = useNavigate()
  const [armed, setArmed] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  const book = books.find((b) => b.id === bookId)
  /** 这个库有几篇文档 —— 必须在删之前算出来，删完就没了 */
  const docCount = new Set(nodes.filter((n) => n.bookId === bookId && n.docId).map((n) => String(n.docId))).size

  /**
   * 只有管理员看得见这个入口。
   *
   * ⚠️ 隐藏**不是**权限控制，服务端 `deleteBook` 会用 `capsInBook().admin`
   * 再判一次。这里只是别把一个「点了就永久删掉全库」的按钮
   * 摆在每个阅读者面前。
   */
  const myBookRole = getBookMembers(bookId).find((m) => m.id === currentUser.id)?.role
  const canDelete =
    currentUser.role === 'owner' || currentUser.role === 'admin' ||
    myBookRole === 'owner' || myBookRole === 'admin'

  if (!book || !canDelete) return null
  const match = typed.trim() === book.name

  return (
    <div className="yq-bset-danger">
      <div className="yq-bset-line-label">危险操作</div>
      <div className="yq-bset-line-desc">
        删除知识库会<b>连带删除它下面的全部 {docCount} 篇文档</b>，
        包括评论、历史版本和附件。<b>不可恢复</b> —— 回收站只管单篇文档，不收整个库。
      </div>

      {!armed ? (
        <Button variant="danger" onClick={() => { setArmed(true); setTyped('') }}>
          删除这个知识库…
        </Button>
      ) : (
        <>
          <div className="yq-bset-danger-confirm">
            请输入库名 <b>{book.name}</b> 以确认
          </div>
          <Input value={typed} placeholder={book.name} onChange={(e) => setTyped(e.target.value)} />
          <div className="yq-flex yq-gap-8">
            <Button
              variant="danger"
              disabled={!match || busy}
              onClick={async () => {
                if (!match) return
                setBusy(true)
                try {
                  await deleteBook(bookId)
                  navigate('/')
                } catch (e: any) {
                  /*
                   * 失败必须**如实说「知识库还在」**。
                   * 服务端发现有文档删不掉时会整次中止（库没删）——
                   * 这时候界面如果已经把库从列表里摘掉，
                   * 用户刷新一下它又回来了，看到的就是「提示说没删、库却时有时无」。
                   */
                  toast(`${e?.message || '删除失败'}。知识库仍然存在`, 'error')
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? '删除中…' : `永久删除（含 ${docCount} 篇文档）`}
            </Button>
            <Button variant="default" disabled={busy} onClick={() => { setArmed(false); setTyped('') }}>
              取消
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

/* ============================================================
   4. 统计 —— 概览数字 + 近 14 天趋势 + 贡献者排行
   ============================================================ */

/*
 * 这里原来有一个 `lcg()` 线性同余伪随机，用来生成「近 14 天访问趋势」。
 * 已删除：统计现在是真数据。留着它只会让人以为还能用随机数填图。
 */

function StatsTab({ bookId }: { bookId: string }) {
  const { nodes, docs, getMember, getBookMembers } = useStore()

  /**
   * 访问者 / 浏览量 / 趋势图现在都是**真数据**。
   *
   * 以前这里是编的：`seedBookStats` 里写死「访问者 1843、浏览量 12760」，
   * 14 天趋势用一个种子 LCG **随机生成**，连「今天 N 次」也是随机数。
   * 公司里真会拿这个数写报告，所以不能继续编。
   * 现在没有记录就显示 0 —— 那才是诚实的答案。
   */
  const [stats, setStats] = useState<{ visitors: number; views: number; days: { day: string; value: number }[] } | null>(null)
  const [statsErr, setStatsErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    if (getMode() !== 'server') { setStats({ visitors: 0, views: 0, days: [] }); return }
    bookStats(bookId)
      .then((s) => { if (alive) setStats(s) })
      .catch((e) => { if (alive) setStatsErr(e?.message || '读取失败') })
    return () => { alive = false }
  }, [bookId])

  const bookNodes = useMemo(() => nodes.filter((n) => n.bookId === bookId), [nodes, bookId])
  const docCount = bookNodes.filter((n) => n.docId).length
  const contributors = getBookMembers(bookId).length

  const trend = useMemo(() => {
    const days = stats?.days || []
    return days.map((d, i) => {
      const [, m, dd] = d.day.split('-')
      return { label: `${Number(m)}/${Number(dd)}`, value: d.value, today: i === days.length - 1 }
    })
  }, [stats])

  const max = Math.max(...trend.map((t) => t.value), 1)
  const trendTotal = trend.reduce((n, t) => n + t.value, 0)
  const todayValue = trend.length ? trend[trend.length - 1].value : 0

  const ranking = useMemo(() => {
    const counts = new Map<string, number>()
    bookNodes.forEach((n) => {
      if (!n.docId) return
      const d = docs[n.docId]
      if (!d) return
      counts.set(d.authorId, (counts.get(d.authorId) || 0) + 1)
    })
    return [...counts.entries()]
      .map(([id, count]) => ({ member: getMember(id), count }))
      .filter((x) => x.member)
      .sort((a, b) => b.count - a.count)
  }, [bookNodes, docs, getMember])

  const rankMax = ranking[0]?.count || 1
  const rankTotal = ranking.reduce((n, r) => n + r.count, 0) || 1

  const cards = [
    { label: '访问者', value: stats?.visitors ?? 0, unit: '人' },
    { label: '阅读人次', value: stats?.views ?? 0, unit: '次' },
    { label: '贡献者', value: contributors, unit: '人' },
    { label: '文档数', value: docCount, unit: '篇' },
  ]

  return (
    <>
      <section className="yq-bset-stats-grid">
        {cards.map((c) => (
          <div key={c.label} className="yq-card yq-bset-stat">
            <div className="yq-bset-stat-label">{c.label}</div>
            <div className="yq-bset-stat-value">
              {c.value.toLocaleString('zh-CN')}
              <span className="yq-bset-stat-unit">{c.unit}</span>
            </div>
          </div>
        ))}
      </section>

      <section className="yq-card yq-bset-card">
        <header className="yq-bset-card-head">
          <div>
            <h2 className="yq-bset-card-title">近 14 天访问趋势</h2>
            <p className="yq-bset-card-desc">
              共 {trendTotal.toLocaleString('zh-CN')} 次访问，日均 {Math.round(trendTotal / 14).toLocaleString('zh-CN')} 次
            </p>
          </div>
          <Tag color="primary" size="sm">今天 {todayValue.toLocaleString('zh-CN')} 次</Tag>
        </header>

        {statsErr && <div className="yq-bset-line-desc">读取统计失败：{statsErr}</div>}
        {trendTotal === 0 && !statsErr && (
          <div className="yq-bset-line-desc">
            近 14 天还没有阅读记录。数据来自真实的上报（同事打开文档时记一次，
            同一人同一天同一篇只算一次），**没有记录就是 0**，不填任何占位数字。
          </div>
        )}

        <div className="yq-bset-chart">
          {trend.map((t) => (
            <div key={t.label} className={`yq-bset-bar-col ${t.today ? 'is-today' : ''}`}>
              <Tooltip title={`${t.label} · ${t.value.toLocaleString('zh-CN')} 次访问`}>
                <div className="yq-bset-bar-track">
                  <div className="yq-bset-bar" style={{ height: `${Math.max(4, (t.value / max) * 100)}%` }} />
                </div>
              </Tooltip>
              <div className="yq-bset-axis">{t.label}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="yq-card yq-bset-card">
        <div className="yq-bset-card-title">贡献者排行</div>
        <p className="yq-bset-card-desc">按在本知识库创建的文档数量统计。</p>

        {ranking.length === 0 ? (
          <Empty icon="👤" text="还没有文档，暂时没有贡献者" />
        ) : (
          <div className="yq-bset-rank">
            {ranking.map((r, i) => (
              <div key={r.member!.id} className="yq-bset-rank-row">
                <span className="yq-bset-rank-no">{i + 1}</span>
                <Avatar name={r.member!.name} size={26} />
                <span className="yq-bset-rank-name">{r.member!.name}</span>
                <div className="yq-bset-rank-bar">
                  <Progress percent={(r.count / rankMax) * 100} />
                </div>
                <span className="yq-bset-rank-num">
                  {r.count} 篇 · {Math.round((r.count / rankTotal) * 100)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  )
}

/* ============================================================
   1. 知识库信息 —— 对着语雀 settings/basic 做的

   实测到的字段（2026-10-10，data/_fidelity-booksettings.md）：
     图标和名称 * / 简介 / 路径(slug) / 封面 / 「更新信息」按钮

   ⚠️「路径」是语雀的 slug（URL 里 `/u33412935/mwink0` 那串）。
     本地 Book 没有这个字段 —— 加到 Book 上会让种子和同步都要跟着动，
     而 slug 的唯一性由服务端管（文档 slug 已有那套机制）。
     所以这里**显示它但不给改**，并说清为什么。
     哪天真要支持改库 slug，得先在服务端加唯一性检查，不能只在前端存一个字段。
   ============================================================ */

function BasicTab({ bookId }: { bookId: string }) {
  const { books, updateBook, toast, currentUser, getBookMembers } = useStore()
  const book = books.find((b) => b.id === bookId)
  const [name, setName] = useState(book?.name || '')
  const [desc, setDesc] = useState(book?.desc || '')
  const [saving, setSaving] = useState(false)

  /*
   * 换库时把表单重置成新库的值。
   * 没有这个：从 A 库切到 B 库，B 的名字会被 A 的旧输入覆盖，
   * 而用户看到的是「B 库的表单」—— 保存就把 B 改成 A 的名字了。
   */
  useEffect(() => {
    setName(book?.name || '')
    setDesc(book?.desc || '')
  }, [bookId])   // eslint-disable-line react-hooks/exhaustive-deps

  if (!book) return null

  /**
   * 判据要对着**服务端**，不是对着同一页的「危险操作」那一节。
   *
   * 原来这里只认 owner/admin（注释写着「与『危险操作』同一套判据」），
   * 但服务端对**已有库**的改名 / 改简介走的是通用写入判据
   * （`server/sync.ts` 的 `denyReason`：`capsInBook(user, bookId).edit`）——
   * 也就是说**编辑者本来就有这个权限**，而且这件事被 `test-emptyfirst`
   * 明确钉住了：那一节叫「不许回退：改名字仍按『这个库』判」，
   * 里面断言「库的 editor 能给这个库改名」且名字真改了，
   * 破坏对照里「去掉限制」会当场红 4 项。
   *
   * ⇒ 两边对不上：**界面比产品更严**，编辑者在界面上改不了库名，
   * 而系统是允许的。方向和 IP 白名单那次相反 ——
   * 那次是界面比服务端**松**（假安全承诺），这次是**严**（假权限限制）。
   * 一样是文案与实现分家，只不过这次是把人挡在门外，而不是把门开着。
   *
   * 「危险操作」（删除 / 转移）和「更多设置」写的是 `bookSettings`，
   * 服务端确实判 `capsInBook().admin`，那两处保持 admin 不变。
   */
  const myRole = getBookMembers(bookId).find((m) => m.id === currentUser.id)?.role
  const canEdit =
    currentUser.role === 'owner' || currentUser.role === 'admin' ||
    myRole === 'owner' || myRole === 'admin' || myRole === 'editor'

  const dirty = name.trim() !== book.name || desc.trim() !== (book.desc || '')

  return (
    <section className="yq-bset-card">
      <h2 className="yq-bset-card-title">知识库信息</h2>
      <p className="yq-bset-card-desc">这些信息会显示在知识库列表和文档页的顶栏上。</p>

      <div className="yq-bset-field">
        <label className="yq-bset-line-label">
          图标和名称 <span className="yq-bset-req">*</span>
        </label>
        <div className="yq-bset-name-row">
          <Input
            className="yq-bset-avatar-input"
            value={book.avatar}
            readOnly
            aria-label="知识库图标"
            title="图标暂不支持自定义"
          />
          <Input
            value={name}
            disabled={!canEdit}
            onChange={(e) => setName(e.target.value)}
            placeholder="给知识库起个名字"
          />
        </div>
        {!canEdit && <p className="yq-bset-hint">只有编辑者及以上可以修改知识库信息（阅读者只能看）</p>}
      </div>

      <div className="yq-bset-field">
        <label className="yq-bset-line-label">简介</label>
        <textarea
          className="yq-bset-textarea"
          value={desc}
          disabled={!canEdit}
          placeholder="这个知识库是做什么的？写一句话，成员在列表里就能看到"
          onChange={(e) => setDesc(e.target.value)}
        />
      </div>

      <div className="yq-bset-field">
        <label className="yq-bset-line-label">路径</label>
        <div className="yq-bset-slug-row">
          <code className="yq-bset-slug">{book.id}</code>
        </div>
        <p className="yq-bset-hint">
          知识库在 URL 里的标识：<code>/book/{book.id}</code>。
          暂时只能看不能改 —— 改了会让已经发出去的链接全部失效。
        </p>
      </div>

      <div className="yq-bset-actions">
        <Button
          variant="primary"
          disabled={!canEdit || !dirty || !name.trim() || saving}
          onClick={async () => {
            if (!name.trim()) return
            setSaving(true)
            try {
              updateBook(bookId, { name: name.trim(), desc: desc.trim() })
              toast('知识库信息已更新', 'success')
            } catch (e: any) {
              toast(e?.message || '更新失败，信息没有变', 'error')
            } finally {
              setSaving(false)
            }
          }}
        >
          {saving ? '更新中…' : '更新信息'}
        </Button>
        {dirty && (
          <Button
            variant="default"
            disabled={saving}
            onClick={() => { setName(book.name); setDesc(book.desc || '') }}
          >
            撤销修改
          </Button>
        )}
      </div>
    </section>
  )
}

/* ============================================================
   2. 更多设置 —— 对着语雀 settings/advanced 做的

   实测到的三节：
     文档设置（单选）：标准页宽 / 超宽显示
     高级选项（复选）：开启评论功能 / 开启自动发布 / 文档新建位置
     知识库设置（卡片）：导出 / 转移 / 删除

   ✅ 这两个开关**接的是真字段**，不是摆着好看的：
     · `defaultWidth`      —— 本来就定义在 BookSettings 上，但全项目**零处读取**，
                             是个「有字段没出口」的僵尸。这里接上（DocPage 读它）。
     · `defaultVisibility` —— `createDoc` 一直在读它，新文档的可见性真的由它决定。
     · 评论开关           —— 复用已有的 `bookCommentsDisabled`？没有这个字段，
                             所以**不假装能做**：评论开关留空并说明原因，
                             而不是加一个改了没用的开关。

   ⚠️ 自动发布：本地没有「草稿 / 已发布」两态之外的通知系统，
      照搬语雀那句「不会发送动态或消息」的说明也做不到，
      所以**不做这一项**，只保留页宽和新建位置两个真开关。
   ============================================================ */

function AdvancedTab({ bookId }: { bookId: string }) {
  const { bookSettings, updateBookSettings, toast, currentUser, getBookMembers, nodes, docs, books } = useStore()
  const [exporting, setExporting] = useState(false)
  const navigate = useNavigate()
  const st = bookSettings[bookId] || {}

  /** 「去导出」要落到真文档上：取这个库里最近更新的一篇 */
  const firstDocId = useMemo(() => {
    const ids = Array.from(new Set(
      nodes.filter((n) => n.bookId === bookId && n.docId).map((n) => String(n.docId)),
    ))
    const live = ids.map((id) => docs[id]).filter(Boolean)
    if (live.length === 0) return ''
    return live.sort((a, b) => b.updatedAt - a.updatedAt)[0].id
  }, [nodes, docs, bookId])

  const myRole = getBookMembers(bookId).find((m) => m.id === currentUser.id)?.role
  const canEdit =
    currentUser.role === 'owner' || currentUser.role === 'admin' ||
    myRole === 'owner' || myRole === 'admin'

  const width = st.defaultWidth || 'standard'
  const newPos = st.newDocPosition || 'top'

  return (
    <>
      <section className="yq-bset-card">
        <h2 className="yq-bset-card-title">文档设置</h2>

        <label className={`yq-bset-radio ${!canEdit ? 'is-disabled' : ''}`}>
          <input
            type="radio"
            name="doc-width"
            checked={width === 'standard'}
            disabled={!canEdit}
            onChange={() => {
              updateBookSettings(bookId, { defaultWidth: 'standard' })
              toast('新打开的文档将用标准页宽', 'success')
            }}
          />
          <div>
            <div className="yq-bset-radio-title">标准页宽</div>
            <div className="yq-bset-line-desc">文档展示宽度固定，不随浏览器宽度变化，适合以文字为主</div>
          </div>
        </label>

        <label className={`yq-bset-radio ${!canEdit ? 'is-disabled' : ''}`}>
          <input
            type="radio"
            name="doc-width"
            checked={width === 'wide'}
            disabled={!canEdit}
            onChange={() => {
              updateBookSettings(bookId, { defaultWidth: 'wide' })
              toast('新打开的文档将用超宽显示', 'success')
            }}
          />
          <div>
            <div className="yq-bset-radio-title">超宽显示</div>
            <div className="yq-bset-line-desc">文档展示宽度根据浏览器自适应，适合有超宽表格的文档</div>
          </div>
        </label>

        <p className="yq-bset-hint">
          改的是<b>新打开</b>文档的默认页宽；单篇文档里已经手动切过的，以那篇为准。
        </p>
      </section>

      <section className="yq-bset-card">
        <h2 className="yq-bset-card-title">高级选项</h2>

        <div className="yq-bset-line">
          <div className="yq-bset-line-main">
            <div className="yq-bset-line-label">文档新建位置</div>
            <div className="yq-bset-line-desc">新建文档时，系统会根据该设置将其置于层级的顶部或底部</div>
          </div>
          {/*
           * Select 没有 disabled 属性，**不为此改公共组件** ——
           * 那是所有调用方共用的 API，加一个字段会影响每一处。
           * 原生 `<fieldset disabled>` 会连带禁用里面的 select，
           * 这是 HTML 自带的语义，不需要动组件。
           */}
          <fieldset className="yq-bset-fieldset" disabled={!canEdit}>
            <Select
              value={newPos}
              options={[
                { value: 'top', label: '顶部新增' },
                { value: 'bottom', label: '底部新增' },
              ]}
              onChange={(v) => {
                updateBookSettings(bookId, { newDocPosition: v as 'top' | 'bottom' })
                toast(v === 'top' ? '新文档将加在顶部' : '新文档将加在底部', 'success')
              }}
            />
          </fieldset>
        </div>

        {!canEdit && <p className="yq-bset-hint">只有管理员可以修改这些设置</p>}
      </section>

      {/* 导出 / 转移 / 删除 —— 语雀把删库放在这一节，不在安全设置页 */}
      <section className="yq-bset-card">
        <h2 className="yq-bset-card-title">知识库设置</h2>

        {/*
         * 整库导出（2026-10-10 补上）。
         *
         * 早先这里是**占位**：语雀在这一处导出整库，而本项目只有单篇导出，
         * 于是写清边界 + 把用户送到文档页。那版还写过一句「跳到一个
         * 不存在的导出页」—— 那条路由在 App.tsx 里压根不存在，
         * 点下去就是 404（是 test-lint 的「静态跳转必须在路由表里」抓到的）。
         *
         * 现在 `src/lib/book-export.ts` 实现了真正的整库打包，
         * 这里换成真导出：目录 → 文件夹，文档 → 一篇一个 .md，
         * 外加一份 `_目录.md` 与 `manifest.json`。
         *
         * ⚠️ `canRead` 判的是「**这个人**能不能看」而不是「能不能导出」——
         *    只读成员点一下就把全库拿走，那不叫导出，叫泄露。
         */}
        <div className="yq-bset-line">
          <div className="yq-bset-line-main">
            <div className="yq-bset-line-label">导出知识库</div>
            <div className="yq-bset-line-desc">
              把整个知识库打包成一个 zip：目录层级对应文件夹，每篇文档一个 .md，
              另附一份<b>目录清单</b>与 manifest。只能导出<b>你有权限看</b>的文档。
            </div>
          </div>
          <Button
            variant="default"
            disabled={exporting || !firstDocId}
            title={firstDocId ? '' : '这个知识库还没有文档'}
            onClick={async () => {
              const book = books.find((b) => b.id === bookId)
              if (!book) { toast('知识库不存在', 'error'); return }
              setExporting(true)
              try {
                /*
                 * 可见性判据与文档页一致：
                 *   私密文档只有成员看得到，公开/空间内的全库成员看得到。
                 * 读不到就不进包 —— 并且**报数**，不静默少几篇。
                 */
                const myId = currentUser.id
                const canRead = (d: { visibility: string; authorId: string }) =>
                  d.visibility !== 'private' || d.authorId === myId
                const r = exportBookZip(book, nodes, docs, canRead)
                downloadBytes(r.zipBytes, r.fileName, 'application/zip')
                toast(
                  r.skipped
                    ? `已导出 ${r.docCount} 篇（${r.skipped} 篇无权限或已隐藏，没进包）`
                    : `已导出 ${r.docCount} 篇文档`,
                  'success',
                )
              } catch (e: any) {
                /*
                 * ⚠️ 失败绝不能说成成功。
                 * 打包中途失败却弹「已导出」，用户拿到一个打不开的 zip，
                 * 还会以为内容已经备份好了 —— 那比不导出更糟。
                 */
                toast(`${e?.message || '导出失败'}。没有生成文件`, 'error')
              } finally {
                setExporting(false)
              }
            }}
          >
            {exporting ? '正在打包…' : '导出'}
          </Button>
        </div>

        <DangerZone bookId={bookId} />
      </section>
    </>
  )
}

/* ============================================================
   3. 文档管理 —— 对着语雀 /docs 做的

   实测到的：
     表头：所有文档（可全选） / 作者 / 状态 / 更新时间
     右上：新建按钮 + 「输入标题进行搜索」搜索框
     每行：文档类型图标 + 标题 + 权限锁 + 右侧 ⋯
     状态列：未发布的文档显示「未发布」

   本地 Doc 上有 `published` 和 `visibility` 两个字段，
   所以「状态」不是编的 —— 真按字段算。
   ============================================================ */

function DocsTab({ bookId }: { bookId: string }) {
  const { nodes, docs, getMember, createDocOrExplain, toast } = useStore()
  const navigate = useNavigate()
  const [q, setQ] = useState('')

  /**
   * 权限第一道。**这一页以前完全没有问过权限** ——
   * 目录管理、成员、安全、回收站四个标签都挂了 `useBookPerms`，只有它没有。
   *
   * 后果不是「界面多了个按钮」，而是 store 那道守卫在这一页**彻底失效**：
   * `bookCreateBlocked` 的边界是「**问过**且没有才拦」（见 `bookCapsSync` 的注释），
   * 而这里 caps 永远是 `null` → 永远当成「没问过」→ 永远放行。
   * 实测（reader，2026-10-14）：读者在**空知识库**的文档管理里点「新建」，
   * 本地当场多出一篇文稿、界面报「已新建文档」并跳进那篇 ——
   * 而服务端会拒，于是顶栏挂一条他自己修不好的告警。
   *
   * 所以**凡是提供写入口的页面，都得自己问一次权限**：
   * 否则 store 层的第二道会静悄悄退化成「永不拦」。
   *
   * fail closed：caps 还是 `null` 时按「不能」处理，与其余标签同一口径。
   */
  const docsCaps = useBookPerms(bookId)
  const docsCanCreate = docsCaps !== null && docsCaps.create

  const rows = useMemo(() => {
    const ids = Array.from(new Set(
      nodes.filter((n) => n.bookId === bookId && n.docId).map((n) => String(n.docId)),
    ))
    return ids
      .map((id) => docs[id])
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .filter((d) => (q.trim() ? d.title.includes(q.trim()) : true))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [nodes, docs, bookId, q])

  return (
    <section className="yq-bset-card">
      <div className="yq-bset-card-head">
        <div>
          <h2 className="yq-bset-card-title">文档管理</h2>
          <p className="yq-bset-card-desc">
            共 {rows.length} 篇文档{q.trim() ? `（匹配「${q.trim()}」）` : ''}
          </p>
        </div>
        <Input
          className="yq-bset-search"
          value={q}
          placeholder="输入标题进行搜索"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {rows.length === 0 ? (
        <Empty
          icon="📄"
          text={q.trim() ? '没有标题匹配的文档' : '这个知识库还没有文档'}
          action={
            !q.trim() ? (
              <Button
                variant="primary"
                disabled={!docsCanCreate}
                title={docsCanCreate ? '' : '在这个知识库里没有新建文档的权限'}
                onClick={() => {
                  /*
                   * ⚠️ 这里原来是无条件 `toast('已新建文档','success')` +
                   * `navigate(.../${id})`，而 `createDoc` 被拒时返回**空串** ——
                   * 于是没有新建权限的读者点完会看到「已新建」成功，然后被送进死链。
                   * 走 `createDocOrExplain`：被拒时它弹说明，成功了才跳转。
                   */
                  const id = createDocOrExplain(bookId, null, '未命名文档')
                  if (!id) return
                  toast('已新建文档', 'success')
                  navigate(`/book/${bookId}/doc/${id}`)
                }}
              >
                新建
              </Button>
            ) : undefined
          }
        />
      ) : (
        <table className="yq-bset-table">
          <thead>
            <tr>
              <th style={{ width: '46%' }}>标题</th>
              <th>作者</th>
              <th>状态</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const author = getMember(d.authorId)
              return (
                <tr key={d.id}>
                  <td>
                    <button
                      className="yq-bset-doc-link"
                      onClick={() => navigate(`/book/${bookId}/doc/${d.id}`)}
                    >
                      <span className="yq-bset-doc-icon">
                        {DOC_TYPE_META[d.type]?.icon || '📄'}
                      </span>
                      {d.title || '未命名文档'}
                      {d.visibility !== 'space' && (
                        <Tooltip title={d.visibility === 'private' ? '私密文档' : '公开文档'}>
                          <span className="yq-bset-lock">{d.visibility === 'private' ? '🔒' : '🌐'}</span>
                        </Tooltip>
                      )}
                    </button>
                  </td>
                  <td>{author?.name || '未知成员'}</td>
                  <td>
                    {d.published ? (
                      <Tag color="green" size="sm">已发布</Tag>
                    ) : (
                      <Tag size="sm">未发布</Tag>
                    )}
                  </td>
                  <td className="yq-bset-time">{timeAgo(d.updatedAt)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}

/* ============================================================
   4. 回收站（知识库内）—— 对着语雀 /trash 做的

   实测到的表头：名称 / 操作者 / 删除时间 / 操作

   ⚠️ 本地另有一个全局回收站页 `/trash`，**故意保留**：
      语雀那个是「这个知识库的回收站」，而全局那页能一次看所有库删掉的文档。
      语雀自己没有全局页，但多一个视图不是缺陷（内网运维确实用得上）。
      两个入口指向同一份数据，不是两份。
   ============================================================ */

function BookTrashTab({ bookId }: { bookId: string }) {
  const { trash, restoreFromTrash, toast } = useStore()
  const [q, setQ] = useState('')

  /**
   * 权限第一道。这里是**单个**知识库，所以用 `useBookPerms` 就够
   * （全局那页 `/trash` 跨库，得按行判，用的是 `useBookPermsMany`）。
   *
   * 实测（reader，探针 2026-10-12）：改之前这一页对读者渲染出可点的
   * 「还原」和「永久删除」，而两个动作服务端都会拒 ——
   * `restoreDoc` 要 `edit`、`purgeDoc` 要 `admin`（见 `server/sync.ts`）。
   *
   * ⚠️ 这里原来还挂着第二个条件 `!docs[t.docId]`（title 写着
   * 「正文已不在本地，无法还原」）。**它恒为真，而且把功能关死了**：
   * `server/sync.ts` 的 `readEntity` 对 `docs` 强制加了 `WHERE trashed = 0`
   * —— 软删的正文**不进任何人**的本地库，管理员也不例外。
   * 于是「还原」对**所有人**都是禁的，包括库的拥有者。
   *
   * 它错在哪：恢复本来就是**服务端驱动**的。`POST /api/doc/:id/restore`
   * 只翻 `trashed` 标记（正文原封不动），并把整篇文稿原样返回，
   * `restoreFromTrash` 收到后按 `_loaded: true` 装回本地 ——
   * 「正文不在本地」根本不是障碍，那句话是一句**过时的事实陈述**。
   *
   * 佐证：全局页 `/trash` 的「恢复」从来没有这个条件，
   * 于是同一个编辑者在全局页能点、在这一页不能点 —— 两个入口自相矛盾。
   * （实测 `test-trash-perms.mjs`：改之前管理员那一行的 title
   *  正是「正文已不在本地，无法还原」。）
   *
   * fail closed：caps 还是 `null` 时按「不能」处理，与 `MembersTab` 同一口径。
   */
  const caps = useBookPerms(bookId)
  const canRestore = caps !== null && caps.edit
  const canPurge = caps !== null && caps.admin

  const rows = trash.filter((t) => t.bookId === bookId)
    .filter((t) => (q.trim() ? t.title.includes(q.trim()) : true))
    .sort((a, b) => b.deletedAt - a.deletedAt)

  return (
    <section className="yq-bset-card">
      <div className="yq-bset-card-head">
        <div>
          <h2 className="yq-bset-card-title">回收站</h2>
          <p className="yq-bset-card-desc">
            {rows.length ? `这个知识库有 ${rows.length} 篇文档在回收站里` : '这个知识库的回收站是空的'}
          </p>
        </div>
        <Input
          className="yq-bset-search"
          value={q}
          placeholder="搜索文档"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {rows.length === 0 ? (
        <Empty
          icon="🗑"
          text={q.trim() ? '没有匹配的文档' : '回收站是空的'}
          action={
            <span style={{ fontSize: 12, color: 'var(--yq-text-4)' }}>
              删除的文档会出现在这里
            </span>
          }
        />
      ) : (
        <table className="yq-bset-table">
          <thead>
            <tr>
              <th style={{ width: '52%' }}>名称</th>
              <th>删除时间</th>
              <th style={{ width: 160 }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.docId}>
                <td className="yq-bset-trash-name">{t.title || '未命名文档'}</td>
                <td className="yq-bset-time">{timeAgo(t.deletedAt)}</td>
                <td>
                  <div className="yq-flex yq-gap-8">
                    <Button
                      size="sm"
                      disabled={!canRestore}
                      title={canRestore ? '' : '没有恢复该文档的权限（服务端要求编辑权）'}
                      onClick={() => {
                        try {
                          restoreFromTrash(t.docId)
                          toast('已还原到原位置', 'success')
                        } catch (e: any) {
                          toast(e?.message || '还原失败', 'error')
                        }
                      }}
                    >
                      还原
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={!canPurge}
                      title={canPurge ? '' : '只有知识库管理员可以彻底删除'}
                      onClick={async () => {
                        /*
                         * 与全局回收站页同一口径：**先等服务端真删**。
                         * 只把这一行从本地摘掉的话，服务端那篇还在 ——
                         * 而按钮上写着「永久删除」，用户会以为它没了。
                         * 失败必须如实说「仍在回收站里」。
                         */
                        if (!confirm(`永久删除「${t.title || '未命名文档'}」？此操作不可恢复。`)) return
                        try {
                          await purgeDoc(t.docId)
                          useStore.setState((s) => ({ trash: s.trash.filter((x) => x.docId !== t.docId) }))
                          useStore.getState().dropPurgedDocs?.([t.docId])
                          toast('已永久删除', 'success')
                        } catch (e: any) {
                          toast(e?.message || '删除失败，文档仍在回收站里', 'error')
                        }
                      }}
                    >
                      永久删除
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
