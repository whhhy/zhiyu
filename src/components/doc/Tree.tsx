import { useState, useCallback, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useStore } from '@/store'
import { Dropdown, MenuItem, MenuDivider, Input, Tooltip } from '@/components/ui'
import { DOC_TYPE_META, timeAgo } from '@/components/layout/TopBar'
import { useBookPerms } from '@/lib/perms'
import { copyText } from '@/lib/clipboard'
import type { NodeType, TreeNode } from '@/types'
import MoveDocDialog from './MoveDocDialog'
import ImportDialog from './ImportDialog'
import './index.css'

/* ============================================================
   知识库目录树 —— 语雀的招牌功能
   无限层级嵌套、拖拽排序、就地改名、右键菜单、绿色 + 号
   ============================================================ */

export default function DocTree({
  bookId,
  activeDocId,
  collapsed,
  onCollapsedChange,
  drawer = false,
  open = false,
}: {
  bookId: string
  activeDocId?: string
  /**
   * 折叠状态。**由外部（store）单一来源持有**，组件不再自己存一份。
   *
   * 为什么改：原来这里是 `useState(collapsedPanel)`，而 `store.treeCollapsed`
   * 在全项目**只被 DocPage:368 写、从没有读过** —— 于是 `⌘⇧F` 真的翻转了
   * store 的值（事件实测到了页面），可界面纹丝不动，因为折叠由这份局部 state
   * 决定。那和上轮清掉的 `toggleOutline` 是同一个病：看起来有能力，实际不生效。
   * 现在折叠只有一个真相来源，`⌘⇧F` 与折叠按钮走同一条路。
   */
  collapsed?: boolean
  onCollapsedChange?: (v: boolean) => void
  /** 窄屏抽屉态：目录树从顶部滑入覆盖正文 */
  drawer?: boolean
  open?: boolean
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const { nodes, docs, books, renameNode, createNode, moveNode, deleteNode, toast, treeWidth, setTreeWidth, updateBook, isFavorite, toggleFavorite } = useStore()
  /*
   * 这个知识库我有什么权限。
   *
   * ⚠️ `useBookPerms` 的注释里**早就写着**「设置页、目录树的『新建』按钮要靠它」——
   *   而这个文件从来没调用过它。于是目录树的写操作对**阅读者也全开**：
   *   重命名 / 置顶 / 移动… / 复制… / 删除，外加 hover 才出现的 ＋ 新建子项。
   *
   * 实测（2026-10-12 探针，真服务端，reader 角色）：
   *   点「删除」→ confirm 通过 → toast「已移入回收站」→
   *   **本地那一篇真的从树上消失了**，而服务端三条都被拒：
   *     trash ×2 / nodes —— 「没有 edit 权限」
   *   然后顶栏常驻「6 处修改没有保存」，**用户自己修不好**。
   *
   * 也就是说：一个人点了一个他无权做的动作，界面**乐观地把结果演出来了**，
   * 而真相要等同步被拒才出现。这一族里最坏的一种 ——
   * 比「点了没反应」糟，因为它先让你信了。
   *
   * 权限**还没问回来**时一律按「不能」处理（fail closed）：
   * 宁可晚半秒出现按钮，也不要先给一个会被拒的。
   */
  const caps = useBookPerms(bookId)
  const canEdit = caps !== null && caps.edit
  const canCreate = caps !== null && caps.create
  /** 这本书收藏了没有 —— 书行那个 ⋯ 菜单里要用 */
  const faved = isFavorite('book', bookId)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<{ id: string; pos: 'before' | 'after' | 'inside' } | null>(null)
  /** 折叠：外部受控（见 props 里的说明）。没传 onCollapsedChange 时退化为内部 state */
  const [collapsedInner, setCollapsedInner] = useState(false)
  const collapsedPanel = collapsed ?? collapsedInner
  const setCollapsedPanel = (v: boolean) => {
    setCollapsedInner(v)
    onCollapsedChange?.(v)
  }
  /**
   * 右键命中的节点 + 鼠标位置。
   * 目录树的右键菜单**不能**挂在每个 NodeMenu 自己身上 —— 那个组件长在
   * `.yq-tree-actions` 里（hover 才显形），而右键点在节点标题上，
   * 两者是不同的 DOM 位置。所以由列表层统一记，右键时在根部渲染一份。
   */
  const [ctxNode, setCtxNode] = useState<{ node: TreeNode; x: number; y: number } | null>(null)
  /**
   * 导入对话框（2026-10-18）。
   *
   * 之前这个入口是 `navigate('/settings?tab=data&import=1')` ——
   * **换个页面**去导入。语雀不是这样：侧栏 ＋ 就在某个库的目录里，
   * 点「导入…」**原地**弹格式选择框，导完东西还在这个库里
   * （官方 Lake 文档第 2 步写的就是「选择知识库的导入」）。
   *
   * 所以整套导入搬成了 ImportDialog，这里只开它，并把 `bookId` 传下去 ——
   * 不传的话它会去新建一个知识库，于是「在书 A 里点导入、内容落进书 B」。
   */
  const [impOpen, setImpOpen] = useState(false)

  const book = books.find((b) => b.id === bookId)

  /**
   * 置顶优先的排序（**只在同一分组内**生效）。
   *
   * 语雀的对应物是 `doc.pinned_at` + 具名开关 `enable_book_doc_pin`
   * （2026-10-12 匿名 SSR 取到的 settings 里带着这一项）。
   *
   * 为什么**不改树上的 order**，只在渲染时排：
   *   · 取消置顶就精确回到原来的位置 —— 改 order 的话取消时你并不知道
   *     该恢复到哪个值（除非另存一份），用户会看到自己排的顺序被弄乱；
   *   · 点一下置顶不该改写整棵目录树：那会走节点实体的同步 + 审计，
   *     在审计日志里看起来像「有人重排了目录」；
   *   · 分组节点没有 docId，也就无从置顶 —— 排序只在有文档的项之间比较。
   *
   * 两条都置顶时按**置顶时刻**排（先置顶的在前）：
   *   这样连点两次的顺序也可预期，而不是交给渲染引擎的稳定性和 id 兜底。
   */
  const pinFirst = (a: TreeNode, b: TreeNode) => {
    const pa = Number((a.docId ? docs[a.docId]?.pinnedAt : 0)) || 0
    const pb = Number((b.docId ? docs[b.docId]?.pinnedAt : 0)) || 0
    if (pa && pb) return pa - pb
    if (pa) return -1
    if (pb) return 1
    return a.order - b.order
  }

  const roots = nodes
    .filter((n) => n.bookId === bookId && n.parentId === null)
    .sort(pinFirst)

  const toggle = (id: string) =>
    setExpanded((s) => {
      const n = new Set(s)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })

  const isInBook = location.pathname === `/book/${bookId}`

  /* ---------- 拖拽落点计算 ---------- */
  const computeDrop = (e: React.DragEvent, node: TreeNode) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const offset = e.clientY - rect.top
    const ratio = offset / rect.height
    if (node.type === 'group' && ratio > 0.3 && ratio < 0.7) return { id: node.id, pos: 'inside' as const }
    return { id: node.id, pos: ratio < 0.5 ? ('before' as const) : ('after' as const) }
  }

  const handleDrop = useCallback(
    (target: { id: string; pos: 'before' | 'after' | 'inside' }) => {
      if (!dragId || !target) return
      const node = nodes.find((n) => n.id === target.id)
      if (!node) return

      if (target.pos === 'inside') {
        moveNode(dragId, node.id, (node.children?.length || 0) + 1)
        setExpanded((s) => new Set(s).add(node.id))
        toast(`已移动到「${node.title}」内`, 'success')
      } else {
        // 计算同级插入位置
        const parentId = node.parentId
        const sibs = nodes
          .filter((n) => n.bookId === bookId && n.parentId === parentId && n.id !== dragId)
          .sort((a, b) => a.order - b.order)
        const idx = sibs.findIndex((n) => n.id === node.id)
        const insertAt = target.pos === 'before' ? idx : idx + 1
        moveNode(dragId, parentId, insertAt)
        toast('目录已调整', 'success')
      }
      setDragId(null)
      setDropTarget(null)
    },
    [dragId, nodes, moveNode, bookId, toast],
  )

  const renderNode = (node: TreeNode, depth: number): JSX.Element | null => {
    if (node.hidden) return null
    const children = nodes
      .filter((n) => n.parentId === node.id)
      .sort(pinFirst)
    const isOpen = expanded.has(node.id)
    /*
     * ⚠️⚠️ **能不能展开，不能只看 `type === 'group'`。**
     *
     * 原来只有 group 有可点的展开箭头，文档节点给的是个占位的
     * `.yq-tree-caret-ph`（不可点），而 onClick 里对非 group 是「导航到文档」。
     * 于是：**文档节点只要有子项，子项就永远渲染不出来** ——
     * 因为下面 `{isOpen && children.length > 0 && …}` 要求 `isOpen`，
     * 而 `isOpen` 只能靠 toggle 变成 true，toggle 又只能从那个箭头点。
     *
     * 这不是「显示得不好看」，是**数据在、界面不可达**：
     *  · hover 的 ＋「新建子项」是 `createNode(bookId, node.id, 'doc')`
     *    —— 对**任何**节点都生效，包括文档节点；
     *  · 右键菜单的「在此新建文档 / 在此新建分组」同理；
     *  · 拖拽 `pos === 'inside'` 也会把条目放进文档节点里。
     *
     * 三条路都能造出子项，界面却一条都不显示。实测（2026-10-09 部署实例）：
     * 用户在「源子科技产品手册」下建了 6 篇文稿，目录树里**一篇都看不到**。
     *
     * 而且 `expanded` 是内存里的 useState，**刷新就清空** ——
     * 即使刚建完那一瞬间能看见（新建后有 setExpanded），刷新后也永远消失。
     *
     * 语雀里文档是可以有自己的子文档的，所以正确修法是
     * **让任何有子项的节点都能展开**，而不是禁止在文档下建子项。
     */
    const canExpand = node.type === 'group' || children.length > 0
    // 注意：分组节点没有 docId，若不守卫会与 undefined === undefined 恒真而被全部高亮
    const isActive = node.docId != null && node.docId === activeDocId
    const drop = dropTarget?.id === node.id ? dropTarget.pos : null
    /** 这一项对应的文档是不是置顶着（分组节点永远不是） */
    const pinned = Number(node.docId ? docs[node.docId]?.pinnedAt : 0) > 0

    return (
      <div key={node.id} className="yq-tree-node-wrap">
        <div
          className={`yq-tree-item ${isActive ? 'is-active' : ''} ${dragId === node.id ? 'is-dragging' : ''} drop-${drop || 'none'}`}
          data-node-id={node.id}
          data-node-title={node.title}
          style={{ paddingLeft: 6 + depth * 14 }}
          /*
           * 拖拽也是写操作（服务端按 `edit` 判），所以没有编辑权时
           * **连元素都不能 draggable** —— 不是「能拖但会被拒」：
           * 那会让阅读者一拖就看到高亮的落点提示，界面等于在说「可以放这儿」。
           */
          draggable={canEdit}
          onContextMenu={(e) => {
            /*
             * 右键弹节点菜单 —— 本文件第 11 行和 README 1646 都写着「右键菜单」，
             * 原来只有 `···` 按钮能弹（onContextMenu 在整个 src 里 0 匹配）。
             * 用 state 把坐标交给下面那个 NodeMenu，它和 `···` 是同一个 Dropdown。
             */
            e.preventDefault()
            e.stopPropagation()
            setCtxNode({ node, x: e.clientX, y: e.clientY })
          }}
          onDragStart={(e) => {
            if (!canEdit) { e.preventDefault(); return }
            setDragId(node.id)
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', node.id)
          }}
          onDragEnd={() => { setDragId(null); setDropTarget(null) }}
          onDragOver={(e) => {
            if (!canEdit) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDropTarget(computeDrop(e, node))
          }}
          onDragLeave={() => setDropTarget(null)}
          onDrop={(e) => {
            if (!canEdit) return
            e.preventDefault()
            e.stopPropagation()
            handleDrop(computeDrop(e, node))
          }}
          onClick={() => {
            if (node.type === 'group') toggle(node.id)
            else if (node.docId) navigate(`/book/${bookId}/doc/${node.docId}`)
          }}
          onDoubleClick={() => setEditing(node.id)}
        >
          {/* 展开箭头 */}
          {canExpand ? (
            <span
              className={`yq-tree-caret ${isOpen ? 'is-open' : ''}`}
              onClick={(e) => { e.stopPropagation(); toggle(node.id) }}
              title={isOpen ? '收起' : '展开'}
            >
              ▸
            </span>
          ) : (
            <span className="yq-tree-caret yq-tree-caret-ph" />
          )}

          {/* 图标 */}
          <span className="yq-tree-icon">
            {node.type === 'group' ? (isOpen ? '📂' : '📁') : DOC_TYPE_META[node.type].icon}
          </span>

          {/* 标题 / 改名输入框 */}
          {editing === node.id ? (
            <input
              className="yq-tree-input"
              defaultValue={node.title}
              autoFocus
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v) renameNode(node.id, v)
                setEditing(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <>
              {/* 置顶标记。放在标题**前面**而不是 hover 操作区里 ——
                  hover 才出现的控件在截图 / 打印 / 窄屏折叠时一律看不到，
                  而「哪几篇被置顶了」是必须一眼看见的信息。 */}
              {pinned && (
                <span className="yq-tree-pin" title="已置顶" aria-label="已置顶">📌</span>
              )}
              <span className="yq-tree-title yq-ellipsis">{node.title}</span>
            </>
          )}

          {/* hover 操作 */}
          <div className="yq-tree-actions">
            {/*
              ＋「新建子项」要 `create` 权限：它建的是**文稿**，
              服务端 `denyReason` 判的是 `caps.create`。
              没有 create 的人点了它，本地会多出一篇文档（同样「乐观地演出来」），
              然后被服务端拒掉 —— 和删除是同一种坏。
            */}
            {canCreate && (
            <Tooltip title="新建子项">
              <button
                className="yq-tree-act yq-tree-act-add"
                onClick={(e) => {
                  e.stopPropagation()
                  const id = createNode(bookId, node.id, 'doc')
                  setExpanded((s) => new Set(s).add(node.id))
                  if (id) navigate(`/book/${bookId}/doc/${id}`)
                }}
              >
                +
              </button>
            </Tooltip>
            )}
            <NodeMenu
              node={node}
              bookId={bookId}
              canEdit={canEdit}
              canCreate={canCreate}
              onRename={() => setEditing(node.id)}
              onCreate={(id) => setExpanded((s) => new Set(s).add(id))}
              onDelete={() => {
                if (confirm(`确定删除「${node.title}」？子项会一并删除，可从回收站找回。`)) {
                  deleteNode(node.id)
                  toast('已移入回收站', 'info')
                }
              }}
            />
          </div>
        </div>

        {isOpen && children.length > 0 && (
          <div className="yq-tree-children">{children.map((c) => renderNode(c, depth + 1))}</div>
        )}
      </div>
    )
  }

  if (collapsedPanel) {
    return (
      <div className={`yq-tree yq-tree-collapsed ${drawer ? 'is-drawer' : ''} ${drawer && open ? 'is-open' : ''}`}>
        <Tooltip title="展开目录" placement="right">
          <button className="yq-tree-expand" onClick={() => setCollapsedPanel(false)}>
            ☰
          </button>
        </Tooltip>
        <div className="yq-tree-collapsed-items">
          {roots.slice(0, 12).map((n) => (
            <Tooltip key={n.id} title={n.title} placement="right">
              <button
                className={`yq-tree-collapsed-item ${n.docId === activeDocId ? 'is-active' : ''}`}
                onClick={() => n.docId && navigate(`/book/${bookId}/doc/${n.docId}`)}
              >
                {n.type === 'group' ? '📁' : DOC_TYPE_META[n.type].icon}
              </button>
            </Tooltip>
          ))}
        </div>
      </div>
    )
  }

  /*
   * 右键菜单本体 —— 与每个节点上的 `···`（NodeMenu）是**同一份 children**。
   *
   * ⚠️ 位置很关键：必须在 collapsedPanel 那个 early-return **之后**。
   *    折叠态只渲染图标列，那些节点没有 onContextMenu，右键也不该弹菜单。
   */
  const ctxMenu = ctxNode && (
    <NodeMenu
      node={ctxNode.node}
      bookId={bookId}
      /* 右键这份和 ··· 那份是**同一个组件**，所以权限也得传同一份 ——
         否则会出现「· · · 里没有删除、右键里有」这种分叉。 */
      canEdit={canEdit}
      canCreate={canCreate}
      ctxAt={{ x: ctxNode.x, y: ctxNode.y }}
      onClose={() => setCtxNode(null)}
      onCreate={(id) => setExpanded((s) => new Set(s).add(id))}
      onRename={() => { setEditing(ctxNode.node.id); setCtxNode(null) }}
      onDelete={() => {
        setCtxNode(null)
        const n = ctxNode.node
        if (confirm(`确定删除「${n.title}」？子项会一并删除，可从回收站找回。`)) {
          deleteNode(n.id)
          toast('已移入回收站', 'info')
        }
      }}
    />
  )

  /* ---------- 目录宽度拖拽 ---------- */
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = treeWidth
    const onMove = (ev: MouseEvent) => {
      const w = startW + (ev.clientX - startX)
      setTreeWidth(Math.max(180, Math.min(480, w)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className={`yq-tree ${drawer ? 'is-drawer' : ''} ${drawer && open ? 'is-open' : ''}`}
      /* 抽屉态由 CSS 决定宽度，不能再用拖拽出来的 inline width 顶掉 */
      style={drawer ? undefined : { width: treeWidth }}
    >
      {/* 知识库头 —— 语雀这里就是「书名 + 锁 + 收起」，而**顶栏那一格放的是空间名** */}
      <div className="yq-tree-head">
        <button
          className="yq-tree-book yq-flex-1"
          onClick={() => navigate(`/book/${bookId}`)}
          title="返回知识库目录"
        >
          <span className="yq-tree-book-avatar">{book?.avatar}</span>
          <span className="yq-tree-book-name yq-ellipsis">{book?.name}</span>
          {/*
            锁图标：语雀的知识库名后面带一把锁（2026-10-10 实测）。
            只在**不是空间内公开**时显示 —— 全空间可见的库挂一把锁是在说假话。
          */}
          {book && book.visibility !== 'space' && (
            <span className="yq-tree-book-lock" title={book.visibility === 'private' ? '仅自己可见' : '受限可见'}>
              🔒
            </span>
          )}
        </button>
        <button
          className="yq-tree-collapse"
          onClick={() => setCollapsedPanel(true)}
          title="收起目录"
        >
          ⟨
        </button>
        {/*
          知识库菜单（2026-10-17）。

          ⚠️⚠️ 以前这里是个 **假动作**，而且是本项目最该清的那一类：
            `<button title="知识库设置" onClick={() => navigate('/book/.../settings')}>⋯</button>`
          —— `⋯` 在所有人的认知里都是「更多菜单」，而它**不弹菜单、直接跳走**。
          用户点它，结果被带离知识库。（而且书页右上角**已经**有一个真·`⋯` 菜单，
          同一个图标两种行为，谁都会踩。）

          改成真菜单，并按实测语雀**挪到书名那一行**（语雀是
          `📄 sss 🔒 ▾ ⋯`，书行上，不是面板标题行）。

          ⚠️ 菜单里**刻意不放「新建文档 / 新建分组」**：
          目录标题行下面**已经**有 ＋ 和「新建各类型」下拉了（见下面那段），
          本文件那句注释写着「**整个侧栏只有这一处新建入口**」。
          这里再放一遍就成了第三处 —— 每多一个入口，就多一次「我刚才点的那个怎么没了」。

          ⚠️ 语雀那个 `⋯` **量不到内容**：它在无障碍树里没有名字，点不到
          （2026-10-17 实测 `bsk observe` 只给出 `搜索/首页/目录` 三个有名字的按钮）。
          所以下面这几项是**按「属于这本书、且不与侧栏别处重复」挑的**，
          不是照抄来的 —— 这一点写在这里，别让下一个人以为它是实测结果。
        */}
        <Dropdown
          align="right"
          width={190}
          trigger={(open, toggle) => (
            <button className="yq-tree-more" title="知识库菜单" onClick={toggle}>⋯</button>
          )}
        >
          {(close) => (
            <>
              <MenuItem
                icon="⚙"
                onClick={() => { navigate(`/book/${bookId}/settings`); close() }}
              >
                知识库设置
              </MenuItem>
              {canEdit && (
                <MenuItem
                  icon="✎"
                  onClick={() => {
                    const name = window.prompt('知识库名称', book?.name || '')
                    const n = (name || '').trim()
                    if (n && n !== book?.name) {
                      updateBook(bookId, { name: n })
                      toast('已重命名', 'success')
                    }
                    close()
                  }}
                >
                  重命名知识库
                </MenuItem>
              )}
              <MenuItem
                icon={faved ? '★' : '☆'}
                onClick={() => {
                  toggleFavorite('book', bookId, book?.name || '')
                  toast(faved ? '已取消收藏' : '已收藏', 'success')
                  close()
                }}
              >
                {faved ? '取消收藏' : '收藏知识库'}
              </MenuItem>
            </>
          )}
        </Dropdown>
      </div>

      {/*
       * 「目录」标题行 —— 2026-10-11 对照真实语雀的侧栏形态补上。
       *
       * 那边这一行右边有两个图标，而**整个侧栏只有这一处新建入口**
       *（树下面没有「新建文档」）。我们原来把按钮放在树下面，
       * 等于多了一个语雀没有的入口 —— 所以这里是**搬上去**，不是加一个。
       *
       * 只放**有真实行为**的两个：＋（新建文档）与「更多类型」下拉。
       * 第二个图标（带点的列表，看着像排序/视图选项）没量到确切语义，
       * 而这边也没有现成的排序功能 —— 猜一个出来就是假动作，
       * 假动作比缺功能更伤人，所以**不臆造**。
       */}
      <div className="yq-tree-cat">
        <span className="yq-tree-cat-title">目录</span>
        {/*
         * ⚠️ 底部工具栏这两个入口以前**没有门**，而 hover 的那个 ＋（上面那处）
         *   有门 —— 同一个页面上两个「＋」，一个有权限一个没有，标准不一致。
         *
         *   它们虽然不谎报成功（两个处理函数都判了 `if (id)`，被拒就什么都不发生），
         *   但对没有新建权的人来说，**点了完全没反应**——
         *   而上面 hover 的 ＋ 干脆不出现，等于告诉他「这里不能建」。
         *   同一件事给出两种相反的信号，比缺功能更让人拿不准。
         */}
        {canCreate && (
          <Dropdown
            align="left"
            width={200}
            trigger={(open, toggle2) => (
              <button className="yq-tree-cat-add" onClick={toggle2} title="新建 / 导入" aria-label="新建或导入">
                <span className="yq-tree-add-icon">+</span>
              </button>
            )}
          >
            {(close) => (
              <>
                {/* 项序与分组照 2026-10-16 实测的真实语雀（侧栏 ＋ 菜单）：
                      文档 / 表格 / 画板 / 数据表 ── 从模板新建… / 导入… / AI 帮你写 ── 新建分组 / 添加链接
                    语雀那份实测清单：
                      0 文档  1 表格  2 画板  3 数据表
                      4 ────  5 从模板新建...  6 导入...  7 AI 帮你写
                      8 ────  9 新建分组  10 添加链接
                    「AI 帮你写」**刻意不做** —— 本项目没有 AI 能力，
                    摆一项点下去什么都不发生，那正是这里一直在清的那类假动作。 */}
                {(['doc', 'sheet', 'board', 'table'] as NodeType[]).map((t) => (
                  <MenuItem
                    key={t}
                    icon={DOC_TYPE_META[t as keyof typeof DOC_TYPE_META].icon}
                    onClick={() => {
                      const id = createNode(bookId, null, t as any)
                      if (id && t !== 'group') navigate(`/book/${bookId}/doc/${id}`)
                      close()
                    }}
                  >
                    {DOC_TYPE_META[t as keyof typeof DOC_TYPE_META].label}
                  </MenuItem>
                ))}
                <MenuDivider />
                <MenuItem
                  icon="🎬"
                  onClick={() => { navigate('/templates'); close() }}
                >
                  从模板新建…
                </MenuItem>
                {/*
                  导入入口按实测语雀的位置放在这里（侧栏 ＋ 菜单，2026-10-16）。

                  ⚠️ **原地弹框，不换页面**（2026-10-18）。
                  原来这一项是 `navigate('/settings?tab=data&import=1')`，
                  那是回避而不是解决：用户正站在某个库的目录里要点「导入」，
                  却被扔去设置页，落地时已经不知道自己在哪个库了。
                  现在 ImportDialog 就地渲染，和设置页共用同一份实现。
                */}
                <MenuItem
                  icon="↓"
                  onClick={() => { setImpOpen(true); close() }}
                >
                  导入…
                </MenuItem>
                <MenuDivider />
                <MenuItem
                  icon="📁"
                  onClick={() => {
                    createNode(bookId, null, 'group')
                    close()
                  }}
                >
                  新建分组
                </MenuItem>
              </>
            )}
          </Dropdown>
        )}
      </div>

      {/* 目录树本体 */}
      <div className="yq-tree-body">
        <div
          className={`yq-tree-list ${dropTarget && !roots.find((r) => r.id === dropTarget.id) ? 'drop-inside' : ''}`}
          onDragOver={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
              e.preventDefault()
              setDropTarget({ id: '__root__', pos: 'inside' })
            }
          }}
          onDrop={(e) => {
            if (dropTarget?.id === '__root__' && dragId) {
              moveNode(dragId, null, roots.length)
              setDragId(null)
              setDropTarget(null)
            }
          }}
        >
          {roots.map((n) => renderNode(n, 0))}
          {roots.length === 0 && <div className="yq-tree-empty">目录还是空的</div>}
        </div>

      </div>

      {/* 语雀：可以拖动「目录」和「正文」之间的竖线调整目录宽度 */}
      <div
        className="yq-tree-resizer"
        onMouseDown={startResize}
        title="拖动调整目录宽度"
      />

      {/* 右键菜单（无条件挂载：没右键过时它自己渲染成空 trigger） */}
      {ctxMenu}

      {/*
        导入：原地弹框（2026-10-18）。
        `targetBookId` 必传 —— 不传的话它会去新建一个知识库，
        于是「在书 A 里点导入、内容落进书 B」。
      */}
      <ImportDialog
        open={impOpen}
        onClose={() => setImpOpen(false)}
        targetBookId={bookId}
      />
    </div>
  )
}

/* ---------------- 节点右键菜单 ---------------- */

function NodeMenu({
  node,
  bookId,
  canEdit = true,
  canCreate = true,
  onRename,
  onDelete,
  ctxAt = null,
  onClose,
  onCreate,
}: {
  node: TreeNode
  bookId: string
  /**
   * 这个知识库的 `edit` / `create` 权限。
   *
   * 默认 true 是为了**单独用 NodeMenu 时不回归**（旧调用方没有这两个 prop）。
   * 目录树本体从外层传真的进来 —— 见 DocTree 里 useBookPerms 那段注释：
   * 以前这里对阅读者也全开，点下去本地乐观地改了、服务端拒，
   * 用户被留在一个自己修不好的状态里。
   */
  canEdit?: boolean
  canCreate?: boolean
  onRename: () => void
  onDelete: () => void
  /**
   * 建完子项后通知外层把这一支展开。
   *
   * 为什么需要：hover 的 ＋「新建子项」自己会 `setExpanded`，
   * 但右键菜单这份 NodeMenu 拿不到树的 state —— 于是
   * 「在此新建文档」建完之后，父节点如果是**文档节点**，
   * 用户看到的仍然是「什么都没发生」（子项被建出来了，但展开不了）。
   *
   * 不传就退化为旧行为（不展开），这样 NodeMenu 单独用也不会报错。
   */
  onCreate?: (nodeId: string) => void
  /**
   * 传了就是右键菜单（按这个坐标定位，面板直接常开）；
   * 不传就是节点上的 `···` 按钮菜单。
   * 两种用法共用下面这份 children —— 所以不可能出现「右键菜单少一项」这种分叉。
   */
  ctxAt?: { x: number; y: number } | null
  onClose?: () => void
}) {
  const { createNode, isFavorite, toggleFavorite, toast, moveNode, togglePinDoc, docs } = useStore()
  const navigate = useNavigate()
  const faved = node.docId ? isFavorite('doc', node.docId) : isFavorite('book', bookId)
  /** 这一项当前是不是置顶着 —— 决定菜单项写「置顶」还是「取消置顶」 */
  const pinnedHere = Number(node.docId ? docs[node.docId]?.pinnedAt : 0) > 0
  /** 打开「移动 / 复制」弹窗的模式；null = 没打开 */
  const [moveFor, setMoveFor] = useState<'move' | 'copy' | null>(null)
  /** 这篇文档的站内地址 —— 「复制链接 / 在新标签页打开」都要它 */
  const docUrl = node.docId ? `${location.origin}/#/book/${bookId}/doc/${node.docId}` : ''

  // 右键菜单的 trigger 不渲染任何东西：它是「凭空出现在鼠标处」的，
  // 面板靠 ctxAt 常开，trigger 只占一个 ref 锚点。
  const isCtx = ctxAt !== null

  return (
    <Dropdown
      align="right"
      width={176}
      anchor={ctxAt}
      open={isCtx || undefined}
      onOpenChange={isCtx ? () => onClose?.() : undefined}
      trigger={(open, toggle) => (isCtx ? null : (
        <button
          className="yq-tree-act"
          onClick={(e) => { e.stopPropagation(); toggle() }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          ···
        </button>
      ))}
    >
      {(close) => (
        <>
          {node.docId && (
            <>
              <MenuItem
                icon="✎"
                onClick={() => { navigate(`/book/${bookId}/doc/${node.docId}`); close() }}
              >
                编辑文档
              </MenuItem>
              {/* 下面两项按语雀目录树的「···」菜单对齐（2026-10-09 对照官方）：
                  复制链接 / 在新标签页打开。 */}
              <MenuItem
                icon="🔗"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(docUrl)
                    toast('链接已复制', 'success')
                  } catch {
                    // 剪贴板不可用（非 HTTPS / 无权限）时别静默失败，
                    // 把地址摆出来让人自己拿 —— 复制链接失败的场合正是这些。
                    window.prompt('复制这个链接：', docUrl)
                  }
                  close()
                }}
              >
                复制链接
              </MenuItem>
              <MenuItem
                icon="↗"
                onClick={() => { window.open(docUrl, '_blank', 'noopener'); close() }}
              >
                在新标签页打开
              </MenuItem>
            </>
          )}
          {canEdit && (
          <MenuItem
            icon="✎"
            onClick={() => { onRename(); close() }}
          >
            重命名
          </MenuItem>
          )}
          {node.type === 'group' && canCreate && (
            <>
              <MenuItem
                icon="＋"
                onClick={() => {
                  const id = createNode(bookId, node.id, 'doc')
                  // 建完把这一支展开 —— 不然分组是折叠的话，
                  // 「新建了但看不见」，用户会以为没生效。
                  onCreate?.(node.id)
                  close()
                  if (id) navigate(`/book/${bookId}/doc/${id}`)
                }}
              >
                在此新建文档
              </MenuItem>
              <MenuItem
                icon="📁"
                onClick={() => {
                  createNode(bookId, node.id, 'group')
                  onCreate?.(node.id)
                  close()
                }}
              >
                在此新建分组
              </MenuItem>
            </>
          )}
          {node.docId && (
            <MenuItem
              icon={faved ? '🔖' : '☆'}
              onClick={() => {
                toggleFavorite('doc', node.docId!, node.title)
                toast(faved ? '已取消收藏' : '已收藏', 'success')
                close()
              }}
            >
              {faved ? '取消收藏' : '收藏'}
            </MenuItem>
          )}
          {/*
           * 「置顶 / 取消置顶」：语雀的 `doc.pinned_at`
           * （服务端带着具名开关 `enable_book_doc_pin`）。
           *
           * 只给**有文档的项** —— 分组没有正文可置顶，
           * 给它一个按钮就只能是个假动作。
           *
           * 效果是「排到本组最前」，且**不改动树上的 order**
           * （理由见 DocTree 里 pinFirst 那段注释）：
           * 取消置顶就精确回原位，也不会在审计日志里留下
           * 一条看起来像「有人重排了目录」的写入。
           */}
          {node.docId && canEdit && (
            <MenuItem
              icon="📌"
              onClick={() => {
                const at = togglePinDoc(node.docId!)
                toast(at ? '已置顶，排到本组最前' : '已取消置顶', 'success')
                close()
              }}
            >
              {pinnedHere ? '取消置顶' : '置顶'}
            </MenuItem>
          )}
          <MenuDivider />
          <MenuItem icon="⧉" onClick={() => {
            /* 同「复制链接」：原来那个 `?.` 在内网 HTTP 下是空操作，
               而它还会弹「标题已复制」—— 弹了绿色提示却什么都没复制。 */
            void copyText(node.title).then((r) =>
              useStore.getState().toast(r.ok ? '标题已复制' : `复制失败：${r.message}`, r.ok ? 'success' : 'error'))
            close()
          }}>
            复制标题
          </MenuItem>
          {/*
           * 「移出目录」：把这一项从当前目录提到知识库根。
           *
           * 语雀目录树的「···」里有这一项（2026-10-09 对照官方）。
           * 底层就是 `moveNode(nodeId, null, index)` —— store 里本来就有，
           * 只是没有入口，只能靠拖拽实现，而拖拽在小屏/不方便拖的时候没有替代。
           *
           * 只在**确实有父节点**时出现：根上的那一项没有目录可移出，
           * 给一个永远无效的按钮比不给更糟。
           */}
          {/*
           * 「移动…」/「复制…」：按语雀那份菜单对齐。
           *
           * 服务端 `moveDoc(docId, bookId, mode)` 早就支持这两种模式，
           * DocPage 里也早就有弹窗 —— 只是**目录树上没入口**，用户得先打开
           * 文档、再从顶部菜单绕一圈才能移动一个目录项。
           *
           * 弹窗本身抽成了 `@/components/doc/MoveDocDialog`，两处共用 ——
           * 抄第二遍就是「同一份逻辑两处、必漏一处」。
           */}
          {node.docId && canEdit && (
            <>
              <MenuItem
                icon="📦"
                onClick={() => { setMoveFor('move'); close() }}
              >
                移动…
              </MenuItem>
              <MenuItem
                icon="⧉"
                onClick={() => { setMoveFor('copy'); close() }}
              >
                复制…
              </MenuItem>
            </>
          )}
          {moveFor && node.docId && (
            <MoveDocDialog
              docId={node.docId}
              bookId={bookId}
              title={node.title}
              mode={moveFor}
              onClose={() => setMoveFor(null)}
            />
          )}
          {node.parentId && canEdit && (
            <MenuItem
              icon="⇤"
              onClick={() => {
                // 排到根级最后：顺序由 order 决定，给一个足够大的值
                const roots = useStore.getState().nodes.filter(
                  (n) => n.bookId === bookId && n.parentId === null,
                )
                moveNode(node.id, null, Math.max(0, ...roots.map((n) => n.order)) + 1)
                toast('已移出目录', 'success')
                close()
              }}
            >
              移出目录
            </MenuItem>
          )}
          {canEdit && (
          <>
          <MenuDivider />
          <MenuItem icon="🗑" danger onClick={() => { onDelete(); close() }}>
            删除
          </MenuItem>
          </>
          )}
        </>
      )}
    </Dropdown>
  )
}
