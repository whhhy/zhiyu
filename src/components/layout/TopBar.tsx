import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useLocation } from 'react-router-dom'
import { useBookStats } from '@/lib/useBookStats'
import { useStore } from '@/store'
import { useSearch, excerptOf } from '@/lib/useSearch'
import { logout, getMode } from '@/lib/api'
import { useBookPermsMany } from '@/lib/perms'
import SyncStatus from '@/components/SyncStatus'
import { useMediaQuery, BP } from '@/hooks/useMediaQuery'
import { Avatar, IconButton, Tooltip, Dropdown, MenuItem, MenuDivider, MenuLabel, Modal, Input, Button, Tag } from '@/components/ui'
import type { DocType, Book, Note } from '@/types'
import './TopBar.css'

/* ============================================================
   顶栏 —— 语雀结构：logo | 主菜单 | 搜索 | +号 | 通知 | 头像
   ============================================================ */

export const DOC_TYPE_META: Record<DocType, { label: string; icon: string; color: string }> = {
  doc: { label: '文档', icon: '📄', color: 'var(--yq-primary)' },
  sheet: { label: '工作表', icon: '📊', color: '#28a745' },
  board: { label: '画板', icon: '🎨', color: '#f5a623' },
  table: { label: '数据表', icon: '🗃️', color: '#8e44ad' },
}

export default function TopBar({
  compact = false,
  onMenu,
}: {
  compact?: boolean
  /** 窄屏下唤起左侧导航抽屉（汉堡按钮）。不传 = 没有抽屉，顶栏不显示汉堡 */
  onMenu?: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const { spaces, books, nodes, docs, currentUser, members, trash, toast, reset, setActiveSpace, activeSpaceId, bookInvites, canCreateBookIn, loadSpaceCaps } = useStore()

  /**
   * 铃铛红点：待处理的协作邀请。
   *
   * ⚠️ 原来数的是 `collaborations.filter(c => c.unread)` —— 那是**纯客户端种子**，
   *    服务端形态下永远是那几条假数据，红点要么常亮要么永灭，
   *    而用户点进去看到的是空列表。现在换成真的 bookInvites。
   *
   * ⚠️ 只数 `asReceiver` 的：store 里同时有「我发出的」，
   *    那些是我要**看**的，不是别人等我处理的 —— 混进来红点会常亮，
   *    而点进去那一条又没有接受按钮。
   */
  const unreadCount = (bookInvites || []).filter((i) => i.asReceiver !== false).length
  const bs = useBookStats()
  const [searchOpen, setSearchOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  /* 平板及以下：主菜单收进「···」；手机：空间切换器只剩头像 */
  const isTablet = useMediaQuery(BP.tablet)

  const activeSpace = spaces.find((s) => s.id === activeSpaceId) || spaces[0]
  const isHome = location.pathname === '/'
  const inSpace = location.pathname.startsWith('/space')

  /* 文档上下文：语雀顶栏在文档态会把主菜单换成「空间名 ›」 */
  const docMatch = location.pathname.match(/^\/book\/([^/]+)\/doc\/([^/]+)/)
  const inDoc = !!docMatch

  /**
   * 主菜单只有这一份数据源：宽屏渲染成常驻链接，窄屏渲染成「···」里的菜单项，
   * 两边入口完全一致，不存在「窄屏少一个功能」。
   */
  const MAIN_NAV = [
    { to: '/', label: '工作台', active: isHome },
    { to: `/space/${activeSpaceId}`, label: '空间', active: inSpace },
    { to: '/find', label: '发现', active: location.pathname === '/find' },
    { to: '/templates', label: '模板', active: location.pathname === '/templates' },
    { to: '/help', label: '帮助', active: location.pathname === '/help' },
    { to: '/notes', label: '小记', active: location.pathname === '/notes' },
  ]

  /*
 * 全局搜索快捷键：**⌘J / Ctrl+J**（语雀真实绑定，2026-10-10 对照官方工作台确认 ——
 * 搜索框右侧印的就是 `Ctrl J`）。
 *
 * 沿革，值得留着免得又被改回去：
 *   · 更早的注释写「/ 打开搜索，c 新建」—— 两个都不存在，注释比代码跑偏；
 *   · 2026-10-08 把面板里三处假写的 `⌘K` 收敛掉，代码里当时只留了 `?`；
 *   · 2026-10-10 对照真实语雀才发现 `?` 也不是它的搜索键 —— 它是 **⌘J**。
 *     所以这里**补上 ⌘J**，而不是把 `?` 改回去。
 *
 * ⚠️ `?` 仍然保留：它开的是**快捷键面板**（语雀文档编辑态右下角那个入口），
 *   和搜索是两件事。
 *
 * 两个修饰键形态都要认：macOS 是 ⌘J，Windows/Linux 是 Ctrl+J。
 */
useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (['INPUT', 'TEXTAREA'].includes(t?.tagName) || t?.isContentEditable) return
      const k = e.key.toLowerCase()
      if (k === 'j' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setSearchOpen(true)
        return
      }
      // `?` 保留：帮助页和快捷键面板都教过用户这个键，
      // test-shortcuts 也按行为测它。悄悄拿掉 = 教了又不算数。
      if (e.key === '?') setSearchOpen(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  /*
   * 顶栏「新建知识库」菜单项的判据是服务端给的（空间管理员），
   * 而顶栏是**全局常驻**的、拿不到空间页那份数据，所以在这里问一次。
   * 问之前那一项不显示 —— 见 `canCreateBookIn` 的注释。
   */
  useEffect(() => {
    if (!canCreateBookIn(activeSpaceId)) loadSpaceCaps(activeSpaceId)
  }, [activeSpaceId, canCreateBookIn, loadSpaceCaps])

  return (
    <>
      <header className="yq-topbar">
        {/* 左：汉堡（仅窄屏有左侧导航抽屉时出现）+ logo */}
        <div className="yq-topbar-left">
          {onMenu && (
            <button className="yq-topbar-burger" onClick={onMenu} aria-label="打开导航" title="导航">
              <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden>
                <path d="M2 4.5h14M2 9h14M2 13.5h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </button>
          )}
          <Link to="/" className="yq-logo" title="知语">
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
              <path
                d="M12 2.5c-2.2 0-4 1.8-4 4 0 1.6.9 2.9 2.3 3.6-1.9.5-3.3 2.2-3.3 4.2 0 1.6.9 3 2.2 3.7l.4 4 1.7-3.1h.7c2.2 0 4-1.8 4-4V6.5c0-2.2-1.8-4-4-4z"
                fill="var(--yq-primary)"
              />
              <circle cx="9.5" cy="6.4" r="1.1" fill="#fff" />
              <circle cx="13.5" cy="6.4" r="1.1" fill="#fff" />
            </svg>
            <span className="yq-logo-text">知语</span>
          </Link>

          {/* 空间切换：语雀在文档态隐藏（面包屑已标明归属），仅首页/空间页显示 */}
          {!compact && (
            <Dropdown
              align="left"
              width={244}
              trigger={(open, toggle) => (
                <button className="yq-space-switch" onClick={toggle} title="切换空间">
                  <span className="yq-space-avatar" style={{ background: 'var(--yq-primary)' }}>
                    {activeSpace?.avatar}
                  </span>
                  <span className="yq-space-name yq-ellipsis">{activeSpace?.name}</span>
                  <span className="yq-space-caret">▾</span>
                </button>
              )}
            >
            {(close) => (
              <>
                <div className="yq-space-list">
                  {spaces.map((s) => (
                    <button
                      key={s.id}
                      className={`yq-space-item ${s.id === activeSpaceId ? 'is-active' : ''}`}
                      onClick={() => {
                        setActiveSpace(s.id)
                        navigate(`/space/${s.id}`)
                        close()
                      }}
                    >
                      <span
                        className="yq-space-avatar yq-space-avatar-sm"
                        style={{ background: s.kind === 'team' ? 'var(--yq-primary)' : 'var(--yq-green)' }}
                      >
                        {s.avatar}
                      </span>
                      <span className="yq-flex-1 yq-ellipsis" style={{ textAlign: 'left' }}>
                        <span className="yq-space-item-name">{s.name}</span>
                        <span className="yq-space-item-meta">
                          {s.kind === 'team' ? '团队空间' : '个人空间'} · {s.memberCount} 人
                        </span>
                      </span>
                      {s.id === activeSpaceId && <span className="yq-tick">✓</span>}
                    </button>
                  ))}
                </div>
                <MenuDivider />
                {/*
                 * 同一套判据（服务端只让**空间管理员**建库），见 `canCreateBookIn`。
                 * 以前无差别摆着：普通成员点下去 → toast「知识库已创建」→ 跳进一个
                 * 服务端根本没有、而**本地刷新也不消失**的空壳库。
                 * 未确认时先不显示；store 也会拒，这里负责把话说明白。
                 */}
                {canCreateBookIn(activeSpaceId) && (
                <MenuItem
                  icon="＋"
                  onClick={() => {
                    const id = useStore.getState().createBook(activeSpaceId, '新知识库')
                    close()
                    if (!id) { toast('只有空间管理员可以新建知识库', 'error'); return }
                    navigate(`/book/${id}`)
                    toast('知识库已创建', 'success')
                  }}
                >
                  新建知识库
                </MenuItem>
                )}
                <MenuItem icon="⚙" onClick={() => { navigate('/settings'); close() }}>
                  账户设置
                </MenuItem>
              </>
            )}
            </Dropdown>
          )}

          {/*
            文档态左上角：**不是**「知识库 / 目录 / 文档名」三级面包屑。

            2026-10-10 直接在真实语雀上量过：那一格只有一个链接
            `› 个人知识库`，指向 `/dashboard/books`（知识库列表）——
            **知识库名不在顶栏**，它在**左侧目录树的顶部**（带锁图标），
            而文档标题在顶栏中间。

            所以：
              · 这里显示**空间名**（语雀叫「个人知识库」，就是空间/团队名），
                点了回到知识库列表；
              · 知识库名交给目录树顶（见 Tree.tsx 的「知识库头」）；
              · 当年那两个 `crumbDoc` / `crumbGroup` 是设计变更前的残留 ——
                语雀压根没有目录级和文档级面包屑，**该删而不是补渲染**。
          */}
          {compact && activeSpace && (
            <nav className="yq-topbar-crumb">
              <button
                className="yq-topbar-crumb-book"
                onClick={() => navigate(`/space/${activeSpace.id}`)}
                title="返回知识库列表"
              >
                <span className="yq-topbar-crumb-caret">›</span>
                <span className="yq-ellipsis">{activeSpace.name}</span>
              </button>
            </nav>
          )}
        </div>

        {/* 中：主菜单（文档态隐藏，由面包屑替代）
            平板及以下收进「···」下拉 —— 换排布，不砍入口 */}
        {!compact && (
          isTablet ? (
            <Dropdown
              align="left"
              width={168}
              trigger={(open, toggle) => (
                <button className={`yq-topbar-more ${open ? 'is-open' : ''}`} onClick={toggle} title="主菜单" aria-label="主菜单">
                  <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden>
                    <circle cx="3.5" cy="9" r="1.5" fill="currentColor" />
                    <circle cx="9" cy="9" r="1.5" fill="currentColor" />
                    <circle cx="14.5" cy="9" r="1.5" fill="currentColor" />
                  </svg>
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuLabel>主菜单</MenuLabel>
                  {MAIN_NAV.map((it) => (
                    <MenuItem
                      key={it.label}
                      icon={it.active ? '●' : '○'}
                      onClick={() => { navigate(it.to); close() }}
                    >
                      {it.label}
                    </MenuItem>
                  ))}
                </>
              )}
            </Dropdown>
          ) : (
            <nav className="yq-topbar-nav">
              {MAIN_NAV.map((it) => (
                <Link key={it.label} to={it.to} className={`yq-nav-item ${it.active ? 'is-active' : ''}`}>
                  {it.label}
                </Link>
              ))}
            </nav>
          )
        )}

        {/* 右：搜索 + 同步状态 + 操作 */}
        <div className="yq-topbar-right">
          <SyncStatus />
          <button className="yq-global-search" onClick={() => setSearchOpen(true)} title="搜索">
            <svg viewBox="0 0 16 16" width="14" height="14">
              <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span>搜索</span>
            {/*
                这里原来先后写过错三个键：`/`、`⌘K`、`?` —— 都对不上。
                2026-10-10 对照真实语雀工作台才定下来：**⌘J / Ctrl+J**，
                而且那边搜索框右侧印的就是它（上面第 87 行的绑定是真的）。
                `?` 是快捷键面板的键，不是搜索的。
            */}
            <kbd>⌘J</kbd>
          </button>

          <Tooltip title="新建">
            {/*
              * ⚠️ 补 `aria-label`（实测 2026-10-08 空实例走查时发现）：
              * 这个按钮里只有一个 svg，**没有任何可访问名称** ——
              * 「新建」这个 title 挂在 Tooltip 的外层包装上，落在按钮之外。
              *
              * 后果：读屏用户听到的是「按钮」，键盘用户按 Tab 过来也不知道
              * 按下去会发生什么。而这是整个产品**唯一的**全局创建入口，
              * 公司部署第一天同事就是要用它建出第一篇文档。
              * 视觉上看得见 ≠ 对所有人可用 —— 鼠标能点不等于无障碍。
              */}
            <button className="yq-new-btn" aria-label="新建" title="新建" onClick={() => setNewOpen(true)}>
              <svg viewBox="0 0 14 14" width="12" height="12">
                <path d="M7 1.5v11M1.5 7h11" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
          </Tooltip>

          {/* 铃铛红点：原来**无条件渲染**，而设置页白纸黑字写着「本项目**没有通知服务**」。
            点开若没有待处理项，红点还在 —— 用户只会以为「漏了」，
            不会想到它根本不是数据。
            面板里**确实有真实的未读概念**（ActivityPanel 里的 collaborations
            过滤 unread），所以这里跟随它：有待处理的协作邀请才亮。
            `unreadCount` 在组件顶层算（见 useStore 解构那一行之后）。 */}
          <Dropdown
            align="right"
            width={200}
            trigger={(open, toggle) => (
              <button
                className="yq-bell"
                onClick={toggle}
                title={unreadCount ? `动态（${unreadCount} 条待处理）` : '动态'}
                data-unread={unreadCount}
              >
                <svg viewBox="0 0 16 16" width="15" height="15">
                  <path
                    d="M8 2a3.8 3.8 0 0 0-3.8 3.8v2.4L3 11h10l-1.2-2.8V5.8A3.8 3.8 0 0 0 8 2zM6.3 13a1.7 1.7 0 0 0 3.4 0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                {unreadCount > 0 && <span className="yq-bell-dot" />}
              </button>
            )}
          >
            {() => <ActivityPanel />}
          </Dropdown>

          <Dropdown
            align="right"
            width={216}
            trigger={(open, toggle) => (
              <button className="yq-user" onClick={toggle}>
                <Avatar name={currentUser.name} size={26} />
                <span className="yq-user-name">{currentUser.name}</span>
                <span className="yq-space-caret">▾</span>
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="yq-user-card">
                  <Avatar name={currentUser.name} size={36} />
                  <div className="yq-flex-1" style={{ minWidth: 0 }}>
                    <div className="yq-user-card-name">{currentUser.name}</div>
                    <div className="yq-user-card-sub">
                      @{currentUser.account} · {roleLabel(currentUser.role)}
                    </div>
                  </div>
                </div>
                <MenuDivider />
                <MenuItem icon="👤" onClick={() => { navigate('/settings'); close() }}>账户设置</MenuItem>
                <MenuItem icon="🗑" onClick={() => { navigate('/trash'); close() }}>
                  回收站{trash.length ? ` (${trash.length})` : ''}
                </MenuItem>
                {/* ⚠️ 服务端形态下**不显示**「重置演示数据」。
                    `reset()` 是 `set({ ...createSeedData() })` ——
                    把 26 篇演示文档 + 4 个知识库灌进本地 store，
                    而服务端形态下同步差分会把这一整批当成「我的改动」推上去。
                    结果：**真实知识库里凭空多出 26 篇演示内容**，
                    而且写得很真，头几天很容易被当成真实内容引用。

                    和下面「切换身份（演示）」是同一类问题，但这个后果严重得多，
                    所以同样直接不显示（不是加免责声明）。 */}
                {getMode() !== 'server' && (
                <MenuItem
                  icon="↺"
                  onClick={() => {
                    if (confirm('确定要恢复为初始演示数据吗？你的所有修改都会丢失。')) {
                      reset()
                      close()
                    }
                  }}
                >
                  重置演示数据
                </MenuItem>
                )}
                <MenuDivider />
                {/*
                 * ⚠️ 这一项以前**根本不存在**，而 `logout()`（lib/api.ts:370）
                 * 从写下来那天起就没被任何地方引用过 —— 一个只有实现的函数。
                 *
                 * 后果是：界面上**没有办法登出**。用户只能手动清 localStorage，
                 * 而服务端那条会话还活着（令牌没销毁）。
                 *
                 * 而且它是被**明确承诺过**的：设置页「登录设备」里，
                 * 当前这台那一行写着「要下线这台请用『退出登录』」
                 * （Settings.tsx 的 DevicePanel）—— 指向一个不存在的按钮。
                 *
                 * 动作：调 logout() 走服务端销毁会话（令牌本来就失效也算成功），
                 * 然后**重新加载**而不是只改内存 —— 重载会把 AppGate 的
                 * 启动流程整个跑一遍（探测 → clearLocalSnapshot → 登录页），
                 * 这正是登出后该有的状态。
                 */}
                <MenuItem
                  icon="⎋"
                  onClick={async () => {
                    close()
                    try { await logout() } catch { /* 令牌本来就失效也算成功 */ }
                    // ⚠️ 必须写 `window.location` —— 这个文件里的 `location`
                    // 是 react-router 的 useLocation()，它没有 reload 方法。
                    window.location.reload()
                  }}
                >
                  退出登录
                </MenuItem>
                <MenuDivider />
                {/*
                 * ⚠️ 这里也必须门控 —— 上一轮只门控了设置页里那一份，
                 * **漏掉了顶栏这个头像菜单里自己的一份**（同一个演示功能，
                 * 两个地方各写了一遍）。
                 *
                 * 服务端形态下它换的只是名字：权限判定完全按登录令牌走，
                 * 换成别人并不会真的看到别人的东西 —— 表现是
                 * 「点了名字变了、权限没变、刷新又变回来」。
                 * 讲清楚的半真功能仍会诱导人点，所以直接不显示。
                 */}
                {getMode() !== 'server' && (
                <div className="yq-user-switch">
                  <div className="yq-user-switch-label">切换身份（演示）</div>
                  {members.map((m) => (
                    <button
                      key={m.id}
                      className={`yq-user-switch-item ${m.id === currentUser.id ? 'is-active' : ''}`}
                      onClick={() => { useStore.getState().switchUser(m.id); close() }}
                    >
                      <Avatar name={m.name} size={20} />
                      <span className="yq-flex-1" style={{ textAlign: 'left' }}>{m.name}</span>
                      {m.id === currentUser.id && <span className="yq-tick">✓</span>}
                    </button>
                  ))}
                </div>
                )}
              </>
            )}
          </Dropdown>
        </div>
      </header>

      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} />}
      {newOpen && <NewDocModal onClose={() => setNewOpen(false)} />}
    </>
  )
}

const roleLabel = (r: string) => ({ owner: '拥有者', admin: '管理员', member: '成员' }[r] || r)

/* ---------------- 全局搜索（? 唤起） ---------------- */

function SearchModal({ onClose }: { onClose: () => void }) {
  const bs = useBookStats()
  const [q, setQ] = useState('')
  const navigate = useNavigate()
  const { docs, nodes, books, notes, members, getMember } = useStore()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter') {
        const first = results[0]
        if (first) {
          // 命中是 {doc, ...} 的包装，知识库归属仍要从目录节点反查
          const node = nodes.find((n) => n.docId === first.doc.id)
          if (node) navigate(`/book/${node.bookId}/doc/${first.doc.id}`)
          onClose()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  /**
   * 搜索走共用的 hook（src/lib/useSearch.ts），与 /search 独立搜索页同一份实现。
   * 它们曾经各写各的：轻量启动改成服务端检索时只改了顶栏这一条路，
   * 搜索页还在扫本地 d.body —— 于是「搜自己没打开过的文档」在搜索页永远无结果。
   * 抽成一份之后，这类差异就不存在了。
   */
  const { docs: results, books: bookResults, notes: noteResults, loading: searching } = useSearch(q)
  return (
    <div className="yq-searchmask" onMouseDown={onClose}>
      <div className="yq-searchpanel yq-fade-in" onMouseDown={(e) => e.stopPropagation()}>
        <div className="yq-searchpanel-head">
          <svg viewBox="0 0 16 16" width="16" height="16" style={{ color: 'var(--yq-text-4)' }}>
            <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            data-global-search
            className="yq-searchpanel-input"
            placeholder="搜索文档、知识库、小记…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <kbd className="yq-searchpanel-kbd">ESC</kbd>
        </div>

        <div className="yq-searchpanel-body">
          {!q && (
            <div className="yq-searchpanel-hint">
              <div className="yq-searchpanel-hint-title">快捷键</div>
              {[
                /*
                 * ⚠️ 这里原来列的三条里**两条是编的**：
                 *   · `⌘K 全局搜索` —— 全 src 里 metaKey/toLowerCase === 'k' 零匹配；
                 *     本面板又是被 `?` 打开的，「⌘K 打开自己」讲不通。
                 *   · `/ 聚焦搜索` —— 面板一挂载输入框就已 autofocus，
                 *     源码里没有再绑过 `/`（`/` 是**编辑器里**唤起插入菜单的那个，
                 *     在输入框里打它只会打出一个斜杠字符）。
                 *   · `Esc 关闭弹窗` 是真的（见上面 onKey 的 `e.key === 'Escape'`）。
                 *
                 * 同一个错在 Shortcuts.tsx 的面板和 Help.tsx 里各有一份拷贝，
                 * 上一轮只改了其中一处 —— 这次三处一起收敛。
                 *
                 * ⚠️ 2026-10-10：对照真实语雀又改了一次 ——
                 *   它的搜索键是 **⌘J**（搜索框右侧印的就是 `Ctrl J`），
                 *   `?` 从来不是它的搜索键。`?` 是**快捷键面板**的键。
                 *   两个都留着：⌘J 对齐语雀，`?` 保留是因为已经教给用户了
                 *   （帮助页、快捷键面板都写着，test-shortcuts 也按行为测它）。
                 *   把已教出去的键悄悄拿掉，和「面板承诺了按了没反应」是同一类问题。
                 */
                ['⌘ J', '全局搜索（也可用 ?）'],
                ['Esc', '关闭弹窗'],
              ].map(([k, v]) => (
                <div key={k} className="yq-searchpanel-hint-row">
                  <kbd>{k}</kbd>
                  <span>{v}</span>
                </div>
              ))}
              <div className="yq-searchpanel-hint-title" style={{ marginTop: 16 }}>试试搜索</div>
              {['编辑器', '权限', '事故', '读书'].map((k) => (
                <div key={k} className="yq-searchpanel-hint-row" style={{ cursor: 'pointer' }} onClick={() => setQ(k)}>
                  <span className="yq-search-suggest">{k}</span>
                </div>
              ))}
            </div>
          )}

          {q && !results.length && !bookResults.length && !noteResults.length && (
            <div className="yq-searchpanel-empty">
              <div className="yq-empty-icon">🔍</div>
              <div>没有找到与「{q}」相关的内容</div>
            </div>
          )}

          {bookResults.length > 0 && (
            <>
              <div className="yq-searchpanel-group">知识库</div>
              {bookResults.map((b) => (
                <div key={b.id} className="yq-searchrow" onClick={() => { navigate(`/book/${b.id}`); onClose() }}>
                  <span className="yq-searchrow-icon">{b.avatar}</span>
                  <span className="yq-flex-1" style={{ minWidth: 0 }}>
                    <span className="yq-searchrow-title">{b.name}</span>
                    <span className="yq-searchrow-excerpt">{b.desc}</span>
                  </span>
                  <Tag>{bs(b).docCount} 篇</Tag>
                </div>
              ))}
            </>
          )}

          {results.length > 0 && (
            <>
              <div className="yq-searchpanel-group">文档</div>
              {results.map((r) => {
                const d = r.doc
                const node = nodes.find((n) => n.docId === d.id)
                return (
                <div
                  key={d.id}
                  className="yq-searchrow"
                  onClick={() => { if (node) { navigate(`/book/${node.bookId}/doc/${d.id}`); onClose() } }}
                >
                  <span className="yq-searchrow-icon">{(DOC_TYPE_META[(d.type || 'doc') as DocType] || DOC_TYPE_META.doc).icon}</span>
                  <span className="yq-flex-1" style={{ minWidth: 0 }}>
                    <span className="yq-searchrow-title">
                      {(d.title || '').split(new RegExp(`(${q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'i')).map((part: string, i: number) =>
                        part.toLowerCase() === q.trim().toLowerCase() ? <mark key={i}>{part}</mark> : part,
                      )}
                    </span>
                    <span className="yq-searchrow-excerpt">{excerptOf(r, q)}</span>
                  </span>
                  <span className="yq-searchrow-enter">↵</span>
                </div>
                )
              })}
            </>
          )}

          {noteResults.length > 0 && (
            <>
              <div className="yq-searchpanel-group">小记</div>
              {noteResults.map((n) => (
                <div key={n.id} className="yq-searchrow" onClick={() => { navigate('/notes'); onClose() }}>
                  <span className="yq-searchrow-icon">🗒️</span>
                  <span className="yq-flex-1" style={{ minWidth: 0 }}>
                    <span className="yq-searchrow-excerpt" style={{ marginTop: 0 }}>{n.text}</span>
                  </span>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="yq-searchpanel-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
          <span><kbd>↵</kbd> 打开</span>
          <span><kbd>ESC</kbd> 关闭</span>
          <span className="yq-flex-1" />
          <span className="yq-searchpanel-count">共 {results.length + bookResults.length + noteResults.length} 条结果</span>
        </div>
      </div>
    </div>
  )
}

/* ---------------- 新建弹窗 ---------------- */

/**
 * 新建弹窗（选知识库 + 选类型）。
 *
 * 导出是因为工作台的「开始」区也要用它 —— 同一个「新建文档」语义
 * 各写一遍，迟早有一边少判一个权限（这个项目已经吃过好几次）。
 */
export function NewDocModal({ onClose }: { onClose: () => void }) {
  const bs = useBookStats()
  const navigate = useNavigate()
  const { books, createDocOrExplain, toast } = useStore()
  const [bookId, setBookId] = useState(books[0]?.id || '')

  const recentBooks = books.slice(0, 5)
  /*
   * 列表按**每个库自己的 `create` 权限**标注。
   *
   * 这里以前把 `books.slice(0,5)` 原样列出，全不判权限 ——
   * 读者和访客看到的是一个**完全可选**的知识库列表，
   * 而列表里那些库他们一篇也建不了。
   *
   * 判据与服务端 `denyReason` 的 docs 分支同源（`caps.create`），
   * 数据来自 `useBookPermsMany`（多库按行问，和全局回收站页同一套）。
   * fail closed：还没问回来时按「不能」处理。
   */
  const capsMap = useBookPermsMany(recentBooks.map((b) => b.id))
  const canCreateIn = (id: string) => capsMap[id] != null && capsMap[id]!.create

  const create = (type: DocType) => {
    if (!bookId) return
    /*
     * ⚠️ 这里原来是无条件三连：
     *   const id = createDoc(...); toast(`已新建${label}`, 'success'); navigate(`.../doc/${id}`)
     * 而 `createDoc` 在**没有 create 权限时返回空串** ——
     * 于是访客/读者点完会看到「已新建文档」**成功**的提示，
     * 然后被送进 `/book/x/doc/` 那个**死链**。
     *
     * 比「点了没反应」更糟：它先让用户信了。
     *
     * 这个弹窗是**全局**的（顶栏 + 号），它并不知道「用户当前在看哪个目录」，
     * 所以不该替用户猜一个父节点 —— **挂根才对**。
     * （原来去取 `roots[0]` 当父节点，在空库里点几次「未命名」就一层套一层。）
     * 要放进子目录有专门的入口：目录树的「在此新建文档」。
     *
     * 走 `createDocOrExplain`：被拒时由它弹说明，成功时才继续跳转。
     * 弹窗里的知识库列表也按 `create` 权限标了出来（见 `canCreateIn`）。
     */
    const id = createDocOrExplain(bookId, null, '未命名', type)
    if (!id) return
    toast(`已新建${DOC_TYPE_META[type].label}`, 'success')
    navigate(`/book/${bookId}/doc/${id}`)
    onClose()
  }

  return (
    <Modal open onClose={onClose} title="新建" width={520}>
      <div className="yq-new-doc">
        <div className="yq-new-doc-label">新建到知识库</div>
        <div className="yq-new-doc-books">
          {recentBooks.map((b) => {
            const can = canCreateIn(b.id)
            return (
              <button
                key={b.id}
                className={`yq-new-doc-book ${bookId === b.id ? 'is-active' : ''}`}
                disabled={!can}
                title={can ? '' : '在这个知识库里没有新建文档的权限'}
                onClick={() => can && setBookId(b.id)}
              >
                <span className="yq-new-doc-book-avatar">{b.avatar}</span>
                <span className="yq-flex-1" style={{ textAlign: 'left', minWidth: 0 }}>
                  <span className="yq-new-doc-book-name yq-ellipsis">{b.name}</span>
                  <span className="yq-new-doc-book-meta">
                    {bs(b).docCount} 篇文档{can ? '' : ' · 无新建权限'}
                  </span>
                </span>
                {bookId === b.id && can && <span className="yq-tick">✓</span>}
              </button>
            )
          })}
        </div>
        <div className="yq-new-doc-label" style={{ marginTop: 20 }}>选择类型</div>
        <div className="yq-new-doc-types">
          {(Object.keys(DOC_TYPE_META) as DocType[]).map((t) => (
            <button key={t} className="yq-new-doc-type" onClick={() => create(t)}>
              <span className="yq-new-doc-type-icon">{DOC_TYPE_META[t].icon}</span>
              <span className="yq-new-doc-type-name">{DOC_TYPE_META[t].label}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  )
}

/* ---------------- 动态面板 ---------------- */

function ActivityPanel() {
  const { bookInvites, refreshBookInvites, topics, notes, getMember, members, recents, docs, nodes, books, getTopicReplyCount } = useStore()
  const navigate = useNavigate()

  return (
    <div className="yq-activity">
      <div className="yq-activity-head">动态</div>

      {/*
       * 只列**我收到的** —— store 里同时有「我发出的」，
       * 而这个面板点进去是去**接受/拒绝**的。
       * 混进来的话会看到点不动也删不掉的条目（面板里没有撤回按钮，
       * 撤回在「权限」页那一份里）。
       */}
      {bookInvites.filter((i) => i.asReceiver !== false).length > 0 && (
        <>
          <div className="yq-activity-group">协作待处理</div>
          {bookInvites.filter((i) => i.asReceiver !== false).map((inv) => {
            const from = getMember(inv.fromUserId)
            return (
              /*
               * ⚠️ 点这里**跳到工作台的协作页**（那里有接受/拒绝按钮），
               * 而不是直接接受 —— 通知面板不该替用户做「接受」这种决定。
               * 而且那条 URL 现在是真有内容的（以前恒空）。
               */
              <div
                key={inv.id}
                className="yq-activity-item"
                onClick={() => navigate('/?tab=collab')}
              >
                <Avatar name={from?.name || '?'} size={22} />
                <div className="yq-flex-1" style={{ minWidth: 0 }}>
                  <div className="yq-activity-text">
                    <b>{from?.name || '有人'}</b> 邀请你{inv.role === 'editor' ? '一起编辑' : '查看'}《{inv.bookName}》
                  </div>
                  <div className="yq-activity-time">{timeAgo(inv.createdAt)}</div>
                </div>
                <span className="yq-activity-dot" />
              </div>
            )
          })}
        </>
      )}

      {topics.slice(0, 3).map((t) => (
        <div key={t.id} className="yq-activity-item" onClick={() => navigate('/')}>
          <span className="yq-activity-emoji">{t.hot ? '🔥' : '💬'}</span>
          <div className="yq-flex-1" style={{ minWidth: 0 }}>
            <div className="yq-activity-text yq-ellipsis">{t.title}</div>
            <div className="yq-activity-time">
              {getTopicReplyCount(t.id)} 条回复 · {timeAgo(t.createdAt)}
            </div>
          </div>
        </div>
      ))}

      {notes.slice(0, 2).map((n) => {
        const a = getMember(n.authorId)
        return (
          <div key={n.id} className="yq-activity-item" onClick={() => navigate('/notes')}>
            <Avatar name={a?.name || '?'} size={22} />
            <div className="yq-flex-1" style={{ minWidth: 0 }}>
              <div className="yq-activity-text yq-clamp-2">{a?.name}：{n.text}</div>
              <div className="yq-activity-time">{timeAgo(n.createdAt)}</div>
            </div>
          </div>
        )
      })}

      {recents.slice(0, 2).map((r) => {
        const d = docs[r.docId]
        if (!d) return null
        const node = nodes.find((n) => n.docId === r.docId)
        const book = books.find((b) => b.id === node?.bookId)
        return (
          <div
            key={r.docId}
            className="yq-activity-item"
            onClick={() => node && navigate(`/book/${node.bookId}/doc/${r.docId}`)}
          >
            <span className="yq-activity-emoji">📄</span>
            <div className="yq-flex-1" style={{ minWidth: 0 }}>
              <div className="yq-activity-text yq-ellipsis">你编辑了《{d.title}》</div>
              <div className="yq-activity-time">
                {book?.name} · {timeAgo(r.viewedAt)}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function timeAgo(ts: number) {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo} 个月前`
  return `${Math.floor(mo / 12)} 年前`
}
