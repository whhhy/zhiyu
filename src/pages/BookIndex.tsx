import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useBookStats } from '@/lib/useBookStats'
import { useBookPerms } from '@/lib/perms'
import { useStore } from '@/store'
import { Avatar, Tag, Button, Dropdown, MenuItem, MenuDivider, Segmented, Input, Empty } from '@/components/ui'
import { timeAgo, DOC_TYPE_META } from '@/components/layout/TopBar'
import DocTree from '@/components/doc/Tree'
import type { TreeNode } from '@/types'
import '../styles/layout.css'
import './BookIndex.css'

/* ============================================================
   知识库主页 —— 语雀的「像书一样」的目录编排视图
   左侧树 + 右侧「目录编排」卡片列表
   ============================================================ */

export default function BookIndex() {
  const { bookId } = useParams()
  const navigate = useNavigate()
  const {
    books, nodes, docs, getMember, favorites, isFavorite, toggleFavorite,
    createDoc, createNode, toast, updateBook, setActiveSpace,
  } = useStore()
  const bs = useBookStats()
  /*
   * 这一页的写操作（新建文档 / 新建分组 / 重命名）要按**服务端同一条判据**显隐。
   * 判据未确认时按「不能」处理（fail closed）—— 与 `Tree.tsx` 完全一致。
   */
  const caps = useBookPerms(bookId)
  const canCreate = caps !== null && caps.create
  const canEdit = caps !== null && caps.edit

  const book = books.find((b) => b.id === bookId)
  /**
   * 行内改名（语雀就是在标题上直接改）。
   *
   * 原来是：把名字后面加一个「✎」，然后弹一句「已重命名（演示）」——
   * 名字真的被改成了带铅笔符号的样子，提示又说这是演示，两头都不对。
   * 中间试过 window.prompt：能改名，但那个弹窗阻塞、样式不可控，
   * 而且**测不到**（Playwright 收不到它的 dialog 事件，自动化里等于不存在）。
   * 行内输入框既好用又好测。
   */
  const [renaming, setRenaming] = useState(false)
  const startRename = () => setRenaming(true)
  const commitRename = (raw: string) => {
    setRenaming(false)
    const name = String(raw).trim()
    if (!name) { toast('名称不能为空', 'error'); return }
    if (!book || name === book.name) return
    updateBook(bookId!, { name })
    toast('已重命名', 'success')
  }
  const roots = nodes.filter((n) => n.bookId === bookId && n.parentId === null).sort((a, b) => a.order - b.order)
  const bookNodes = nodes.filter((n) => n.bookId === bookId)
  const bookDocs = bookNodes.filter((n) => n.docId).map((n) => docs[n.docId!]).filter(Boolean)
  const totalWords = bookDocs.reduce((n, d) => n + d.wordCount, 0)
  const faved = bookId ? isFavorite('book', bookId) : false

  if (!book) {
    return <div style={{ padding: 40 }}><Empty icon="🫥" text="知识库不存在" /></div>
  }

  const recent = [...bookDocs].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5)

  /** 递归收集子节点数量 */
  const countTree = (n: TreeNode): number => {
    const kids = bookNodes.filter((c) => c.parentId === n.id)
    return 1 + kids.reduce((s, c) => s + countTree(c), 0)
  }

  const flatten = (n: TreeNode, depth: number): { node: TreeNode; depth: number }[] => {
    const out = [{ node: n, depth }]
    bookNodes
      .filter((c) => c.parentId === n.id)
      .sort((a, b) => a.order - b.order)
      .forEach((c) => out.push(...flatten(c, depth + 1)))
    return out
  }

  return (
    <div className="yq-bookpage">
      <DocTree bookId={bookId!} activeDocId={undefined} />

      <div className="yq-bookpage-main">
        {/* 知识库头 */}
        <header className="yq-bookpage-hero">
          <div className="yq-bookpage-hero-row">
            <div className="yq-bookpage-avatar">{book.avatar}</div>
            <div className="yq-flex-1" style={{ minWidth: 0 }}>
              <div className="yq-bookpage-title-row">
                {renaming ? (
                  <input
                    className="yq-bookpage-title-input"
                    autoFocus
                    defaultValue={book.name}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename((e.target as HTMLInputElement).value)
                      if (e.key === 'Escape') setRenaming(false)
                    }}
                    onBlur={(e) => commitRename(e.target.value)}
                    aria-label="知识库名称"
                  />
                ) : (
                  <h1 className="yq-bookpage-title" onDoubleClick={() => startRename()}>{book.name}</h1>
                )}
                <Tag color={book.visibility === 'private' ? 'default' : 'green'} size="sm">
                  {book.visibility === 'private' ? '私密' : book.visibility === 'public' ? '公开' : '空间内'}
                </Tag>
              </div>
              <p className="yq-bookpage-desc">{book.desc}</p>
            </div>
            <div className="yq-bookpage-actions">
              <Button
                variant="default"
                icon={faved ? '★' : '☆'}
                onClick={() => { toggleFavorite('book', bookId!, book.name); toast(faved ? '已取消收藏' : '已收藏', 'success') }}
              >
                {faved ? '已收藏' : '收藏'}
              </Button>
              {/*
                「新建文档」和右边那个 `···` 里的新建各类型 / 新建分组 / 重命名，
                全部要 `create` / `edit` 权限。

                ⚠️ 2026-10-12 实测（探针，真服务端，reader 角色）：这一页
                对阅读者**完全敞开** —— 他点「新建文档」→ 本地真的多出一篇
                （节点 1 → 2）→ 服务端拒（`books`「没有 edit 权限」等 12 条）→
                顶栏常驻「12 处修改没有保存」，**而他自己修不好**。

                知识库主页是**所有人一进来就在的页面**，比侧边那棵树更常用，
                所以这一处的假动作比树那一处影响更大。
                判据与 `Tree.tsx` 同一份（`useBookPerms` → 服务端 `denyReason` 的 caps）。
              */}
              {canCreate && (
              <Button
                variant="primary"
                icon="＋"
                onClick={() => {
                  /*
                   * ⚠️ 原来这里是 `roots[0]?.id ?? null` —— 挂在**第一个根节点**下面。
                   *
                   * 那个 `roots[0]` 是凭空抓的：这一页的目录是**扁平列表 + 拖拽排序**，
                   * 根本没有「当前选中目录」的概念（见上面 roots 的定义）。
                   * 于是点一次「新建文档」→ 挂到 roots[0] 下；再点一次 → roots[0] 还是
                   * 那个（它是第一个），于是又挂到它下面 —— **空知识库里点三次就得到
                   * 「未命名 → 未命名 → 未命名」三层套娃**（实测，用户在部署实例上看到的）。
                   *
                   * 而且在**有分组目录**的知识库里更隐蔽：新建的文档不是出现在根，
                   * 而是被塞进第一个分组 —— 用户以为建在根，实际进了某个目录。
                   *
                   * 正确做法挂根（`null`）。同一个产品里已经有对的实现：
                   * `Tree.tsx` 底部「新建文档」是 `createNode(bookId, null, 'doc')`，
                   * hover/右键「在此新建文档」是 `createNode(bookId, node.id, …)` ——
                   * 要放进子目录本来就有专门的入口，不需要在这里猜一个父节点。
                   */
                  const id = createDoc(bookId!, null, '未命名', 'doc')
                  if (id) {
                    setActiveSpace(book.spaceId)
                    navigate(`/book/${bookId}/doc/${id}`)
                  }
                }}
              >
                新建文档
              </Button>
              )}
              <Dropdown
                align="right"
                width={200}
                trigger={(open, toggle) => (
                  <Button variant="default" onClick={toggle}>···</Button>
                )}
              >
                {(close) => (
                  <>
                    {/* 新建各类型 / 新建分组要 create，重命名要 edit（理由见上面那个按钮的注释） */}
                    {canCreate && (<>
                    <MenuLabel2>新建</MenuLabel2>
                    {(['doc', 'sheet', 'board', 'table'] as const).map((t) => (
                      <MenuItem
                        key={t}
                        icon={DOC_TYPE_META[t].icon}
                        onClick={() => {
                          // 同上：挂根，不挂 roots[0]。理由见上面那个按钮的注释。
                          const id = createDoc(bookId!, null, '未命名', t)
                          if (id) navigate(`/book/${bookId}/doc/${id}`)
                          close()
                        }}
                      >
                        新建{DOC_TYPE_META[t].label}
                      </MenuItem>
                    ))}
                    <MenuItem icon="📁" onClick={() => { createNode(bookId!, null, 'group'); toast('已新建分组', 'success'); close() }}>
                      新建分组
                    </MenuItem>
                    </>)}
                    <MenuDivider />
                    <MenuLabel2>知识库设置</MenuLabel2>
                    {canEdit && (
                    <MenuItem
                      icon="✎"
                      onClick={() => { close(); startRename() }}
                    >
                      重命名
                    </MenuItem>
                    )}
                    <MenuItem icon="⚙" onClick={() => { navigate(`/book/${bookId}/settings`); close() }}>
                      知识库设置
                    </MenuItem>
                  </>
                )}
              </Dropdown>
            </div>
          </div>

          <div className="yq-bookpage-stats">
            <span><b>{bs(book).docCount}</b> 篇文档</span>
            <span><b>{formatW(totalWords)}</b> 字</span>
            <span><b>{bookNodes.filter((n) => n.type === 'group').length}</b> 个分组</span>
            <span className="yq-flex-1" />
            <span>创建于 {new Date(book.createdAt).toLocaleDateString('zh-CN')}</span>
            <span>·</span>
            <span>{timeAgo(book.updatedAt)}更新</span>
          </div>
        </header>


        {/*
         * 欢迎区（2026-10-10 实测语雀后补）。
         * 语雀在这一页的第一句话是「👋 欢迎来到知识库 / 知识库就像书一样…」，
         * 本地早先从统计条直接跳到目录编排，中间是空的。
         *
         * ⚠️ 语雀这句话下面还会画一个成员头像占位 —— **这里不画**：
         *    那是「当前还没有成员」的意思，我们画一个假头像等于编造。
         */}
        <div className="yq-bookpage-welcome">
          <div className="yq-bookpage-welcome-title">👋 欢迎来到知识库</div>
          <p className="yq-bookpage-welcome-desc">
            知识库就像书一样，让多篇文档结构化，方便知识的创作与沉淀
          </p>
        </div>

        {/* 目录编排 */}
        <div className="yq-bookpage-body">
          <section className="yq-bookpage-toc">
            <div className="yq-section-title">
              <span>目录</span>
              {/*
               * ⚠️ 这里原来有一句「支持拖拽调整顺序，拖到条目中间可成为子项」。
               * 而下面这些行是**纯只读**的：只有 onClick 跳转，
               * 零个拖拽处理器（`draggable` / `onDragStart` / `onDrop` 全都没有）。
               * 拖拽**确实存在**，但在侧边目录树 `components/doc/Tree.tsx` 上 ——
               * 提示挂在另一块界面上，等于在只读列表旁边承诺一个它做不到的动作。
               *
               * 所以删掉的是**这句提示**，不是「以后不许有拖拽」：
               * 哪天这个目录真接上拖拽了，把它加回来就行。
               * `test-catalog-row-e2e` 钉的是「要么真有拖拽、要么别这么写」这个不变式，
               * 而不是「这里永远不能拖」。
               */}
            </div>

            {roots.length === 0 ? (
              <Empty icon="📁" text="目录还是空的，点下面的按钮开始吧" />
            ) : (
              <div className="yq-toc">
                {roots.flatMap((r) => flatten(r, 0)).map(({ node, depth }) => {
                  const d = node.docId ? docs[node.docId] : undefined
                  const author = d ? getMember(d.authorId) : undefined
                  const isGroup = node.type === 'group'
                  return (
                    <div
                      key={node.id}
                      className={`yq-toc-row ${d ? 'is-doc' : 'is-group'}`}
                      style={{ paddingLeft: 14 + depth * 22 }}
                      onClick={() => !isGroup && node.docId && navigate(`/book/${bookId}/doc/${node.docId}`)}
                    >
                      <span className="yq-toc-icon">
                        {isGroup ? (node.children?.length ? '📂' : '📁') : DOC_TYPE_META[d?.type || 'doc'].icon}
                      </span>
                      <span className="yq-toc-title">{node.title}</span>
                      {!isGroup && d && (
                        <>
                          <span className="yq-toc-meta">
                            {d.wordCount} 字 · {timeAgo(d.updatedAt)}更新
                          </span>
                          {author && <Avatar name={author.name} size={20} />}
                        </>
                      )}
                      {isGroup && (
                        <span className="yq-toc-meta">{countTree(node) - 1} 项</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          <aside className="yq-bookpage-side">
            <div className="yq-section-title"><span>最近编辑</span></div>
            <div className="yq-card">
              {recent.map((d) => (
                <div key={d.id} className="yq-list-row" onClick={() => navigate(`/book/${bookId}/doc/${d.id}`)}>
                  <span className="yq-list-icon">{DOC_TYPE_META[d.type]?.icon ?? '📄'}</span>
                  <div className="yq-flex-1" style={{ minWidth: 0 }}>
                    <div className="yq-list-row-title yq-ellipsis">{d.title}</div>
                    <div className="yq-list-row-meta">
                      <span>{getMember(d.authorId)?.name}</span>
                      <span>·</span>
                      <span>{timeAgo(d.updatedAt)}</span>
                    </div>
                  </div>
                </div>
              ))}
              {recent.length === 0 && (
                <div style={{ padding: 20, textAlign: 'center', color: 'var(--yq-text-4)', fontSize: 13 }}>
                  还没有文档
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

function MenuLabel2({ children }: { children: React.ReactNode }) {
  return <div className="yq-menu-label">{children}</div>
}

function formatW(n: number) {
  return n >= 10000 ? (n / 10000).toFixed(1) + 'w' : String(n)
}
