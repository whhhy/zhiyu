import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useStore } from '@/store'
import { Avatar, Tag } from '@/components/ui'
import { resolveTab, tabVisible } from '@/lib/dashboard-tab'
import { timeAgo } from './TopBar'
import './SideNav.css'

/* ============================================================
   工作台左侧导航 —— **照 2026-10-10 实测的真实语雀排的**
   ------------------------------------------------------------
   语雀那边长这样（`ul[role=menu]` + 一层类名 `personalSubMenuWrapper`）：

       开始    ← **菜单第一项**（data-testid="sidebar:sidebar-menu-first-item"）
       AI 写作
       小记
       收藏
       逛逛
     ▸ 知识库 ›   ← 单独一组，可折叠，下面是知识库列表
     更多（底部）

   ⚠️ 「开始」**不是分组标题，它自己就是一个导航项**（当前所在位置）。
     我一直以为那是组名 —— 那是我们自己的叫法，不是语雀的。
   ============================================================ */

/** 个人区：与语雀一一对应的四项。**无标题**——语雀那边就没有组名 */
const SECTIONS = [
  {
    label: null,
    items: [
      { key: 'doc', label: '开始', icon: '🕐', to: '/' },
      { key: 'notes', label: '小记', icon: '✍️', to: '/notes' },
      { key: 'favorite', label: '收藏', icon: '🔖', to: '/?tab=favorite' },
      { key: 'discover', label: '逛逛', icon: '⌘', to: '/find' },
    ],
  },
  /*
   * 知识库组：语雀这里是**可折叠的分组 + 知识库列表**，
   * 不是一项 tab。我们没有那个列表（侧栏宽度也不够），
   * 所以先只保留「知识库」这一项，等有了列表再把 `▸` 展开。
   */
  {
    label: '知识库',
    collapsible: true,
    items: [
      { key: 'book', label: '全部知识库', icon: '📚', to: '/?tab=book' },
    ],
  },
  /*
   * ⚠️ 这一组**语雀的个人区里没有**，是我们多出来的（团队 / 协作 / 讨论 / 关注）。
   * 删掉它们是**减功能**，所以不删 —— 但也**不能混进上面那组**：
   * 混进去等于宣称「语雀的个人导航长这样」，而实际不是。
   * 单独一组，是如实说「这些是我们额外的」。
   */
  {
    label: '团队',
    collapsible: true,
    items: [
      { key: 'team', label: '团队', icon: '👥', to: '/?tab=team' },
      { key: 'collab', label: '协作', icon: '🤝', to: '/?tab=collab' },
      { key: 'discuss', label: '讨论', icon: '💬', to: '/?tab=discuss' },
      { key: 'follow', label: '关注', icon: '⭐', to: '/?tab=follow' },
    ],
  },
]

/**
 * ⚠️ **本块从下一行开始讲的都是 2026-10-08 当时的情况，已经不是现状了。**
 * 邀请流程后来真的做了，现在协作 tab 走的是真数据。**往下读之前先看本块末尾
 * 那一段「2026-10-12：这段理由已经过期了」** —— 别照着上面那段把入口改回去。
 *
 * 当时的原始记录：「协作」这一个 tab 在服务端形态下**恒为空**，而且页面上有两个假按钮。
 *
 * 查实（2026-10-08）：`collaborations` 是**纯客户端种子数据** ——
 * 只在 `src/data/seed.ts:507` 造出来，**没有服务端表、没有 API、
 * 不在 `server/entities.ts` 的同步实体清单里**。服务端模式下
 * `clearLocalSnapshot()` 把它清成 `[]`（store/index.ts:1604），
 * 而 `hydrate()` 只覆盖服务端真送来的字段，于是它永远是 `[]`。
 *
 * 后果是 `CollabTab` 永远渲染：一个空列表 + 「全部 / 待处理(0)」，
 * 加两个**接受 / 拒绝**按钮 —— 那两个按钮只改本地
 * `collaborations`，既不落库也不走同步，点了刷新就没，属于
 * `test-no-fake-actions` 管的同一类假动作。
 *
 * ⚠️ ⚠️ 2026-10-12：这段理由**已经过期了**，改的时候顺手记下来，
 * 因为它现在说的和代码做的**相反**。
 *
 * 原文写的是「本项目**没有邀请流程** —— 谁也发不出邀请，所以那两条永远不会有数据」，
 * 而**部署态直接不显示**协作入口。
 *
 * 现在的事实（`components/collab/BookInvite.tsx` 顶上写着同样的来龙去脉）：
 *   · 邀请流程**真的存在**了 —— `book_invites` 表 + 发起 / 接受 / 拒绝 / 撤回四个接口
 *     + 审计埋点，接受之后真的会进 `book_members`；
 *   · 工作台 `?tab=collab` 渲染的是 `<BookInviteList/>`（真数据），
 *     不是原来那两个只改本地状态的按钮；
 *   · `tabVisible()`（`@/lib/dashboard-tab`）现在**恒为 true** ——
 *     部署态**照常显示**协作入口（顶栏红点也数的是真的 bookInvites）。
 *
 * 为什么必须记：照着原文信的人会去把 `tabVisible('collab')` 改回 false ——
 * 那会把一个已经能用的功能**改坏**，而且症状是「邀请发不出去/收不到」，
 * 极难往「一条过期注释」上想。
 *
 * 仍然成立的那部分：语雀的个人区里**没有**「团队 / 协作 / 讨论 / 关注」这一组，
 * 它们是我们多出来的（所以单独成组，不混进个人区）。
 *
 * ⚠️ 「能不能看见」和「高亮谁」必须是**同一份口径**（`@/lib/dashboard-tab`，
 * Dashboard 也调它）。第一版只让 Dashboard 改写 `?tab=collab`、忘了这里
 * 也读同一个 URL 参数算高亮 —— 结果部署实例上手敲深链：内容区回到文档页，
 * 但侧栏 `active==='collab'` 而那一项已被过滤 → **一个导航项都没高亮**。
 * 两处各算各的就会出这种「内容对了、导航错了」的半截状态。
 */
function visibleSections() {
  return SECTIONS.map((sec) => ({
    ...sec,
    items: sec.items.filter((it) => tabVisible(it.key)),
  }))
}

export default function SideNav({
  drawer = false,
  open = false,
  onClose,
}: {
  /** 窄屏抽屉态：常驻侧栏 → 滑入式抽屉 */
  drawer?: boolean
  open?: boolean
  onClose?: () => void
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const { books, spaces, bookInvites, topics, favorites, currentUser, activeSpaceId, members, notes, docs } = useStore()

  const params = new URLSearchParams(location.search)
  /*
   * 高亮口径必须和 Dashboard 渲染的那一份一致。
   *
   * 这里原来写的是 `params.get('tab') || 'doc'` —— 拿**原始**参数算高亮。
   * 于是服务端形态下手敲 `/?tab=collab`：Dashboard 已经把它改写成文档页了，
   * 而这里 `active` 还是 `'collab'`，而那一项刚被过滤掉
   * → **侧栏一个高亮都没有**。内容对了、导航是死的，最容易被当成「页面卡了」。
   */
  /*
   * ⚠️ 高亮**一律过 `resolveTab`** —— SideNav 和 Dashboard 必须用同一份口径，
   *   这是 `dashboard-tab.ts` 存在的全部理由（两处各算各的就会出现
   *   「内容对了、导航错了」的半截状态）。
   *
   *   而「小记 / 逛逛」根本不在工作台上，它们没有 `?tab=` 可言。
   *   所以先把**路径**折成一个 tab，再交给 resolveTab 收口 ——
   *   不是在外面自己判一遍（那正是这个文件被逼出来的那个 bug）。
   */
  const pathTab = location.pathname === '/notes' ? 'notes'
    : location.pathname === '/find' ? 'discover' : null
  const active = resolveTab(pathTab || params.get('tab'))
  const activeSpace = spaces.find((s) => s.id === activeSpaceId) || spaces[0]
  /** 协作待办数。现在是真的 bookInvites —— 原来数的是纯客户端种子的 unread 字段 */
  /** 协作待办数。现在是真的 bookInvites —— 原来数的是纯客户端种子的 unread 字段 */
  const unreadCollab = (bookInvites || []).length
  const mySpaces = spaces.filter((s) => s.kind === 'team')

  /*
   * 文档数以前是**写死的 8**。
   *
   * 于是一个刚部署好、库里一篇文档都没有的实例，侧栏照样写着「📄 文档 8」——
   * 而它看起来完全正常，不报错、不置灰。跟统计页那批编造数字是同一类问题：
   * **界面在展示一个它并不掌握的数据。**
   *
   * 轻量启动之后客户端并没有全部文稿的正文，但**元信息是全的**
   * （bootstrap lite 只砍 blocks，不砍行），所以这里数得出真实篇数。
   */
  const counts: Record<string, number> = {
    book: books.length,
    collab: unreadCollab,
    discuss: topics.length,
    favorite: favorites.length,
    doc: Object.keys(docs || {}).length,
  }

  /** 抽屉里点任意一项都算「已做出选择」，顺手收起 */
  const go = (to: string) => {
    navigate(to)
    if (drawer) onClose?.()
  }

  return (
    <aside
      className={`yq-sidenav ${drawer ? 'is-drawer' : ''} ${drawer && open ? 'is-open' : ''}`}
      aria-hidden={drawer && !open ? true : undefined}
    >
      {/*
       * 侧栏顶部搜索框 —— 照 2026-10-11 实测真实语雀的 DOM 复刻：
       *
       *   <span class="ant-input-affix-wrapper ant-input-affix-wrapper-disabled …">
       *     <input class="ant-input ant-input-disabled" disabled placeholder="搜索">
       *     <span class="ant-input-suffix">Ctrl J</span>
       *
       * ⚠️ 关键一点：**它带 `disabled`，在语雀里点不动** ——
       *    只是个指向快捷键的视觉提示，真要搜索必须按 Ctrl J。
       *    所以这里也做成禁用输入框，而不是接一个「点了就弹搜索」的动作。
       *
       *    两个理由：
       *      ① 1:1 —— 它那边点不动，这边就不该点得动
       *      ② 本项目的原则是「不放假动作」——
       *      一个长得能点、点了没反应的框比没有更糟；禁用反而是诚实的
       *
       * 真正的搜索入口在**顶栏**（那个是真能点的），快捷键 ⌘J / Ctrl J 也真绑了。
       */}
      <div className="yq-sidenav-search">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <input type="text" placeholder="搜索" disabled readOnly aria-label="搜索（按 Ctrl J 打开）" />
        <kbd>Ctrl J</kbd>
      </div>

      {/* 当前空间卡片 */}
      <div className="yq-sidenav-space" onClick={() => go(`/space/${activeSpace?.id}`)} title={activeSpace?.name}>
        <span className="yq-sidenav-space-avatar">{activeSpace?.avatar}</span>
        <div className="yq-flex-1" style={{ minWidth: 0 }}>
          <div className="yq-sidenav-space-name yq-ellipsis">{activeSpace?.name}</div>
          <div className="yq-sidenav-space-meta">{activeSpace?.memberCount} 位成员</div>
        </div>
      </div>

      {/* 七 tab */}
      <nav className="yq-sidenav-tabs">
        {visibleSections().map((sec, i) => (
          <div key={i} className="yq-sidenav-section">
            {sec.label && <div className="yq-sidenav-label">{sec.label}</div>}
            {sec.items.map((it) => (
              <button
                key={it.key}
                className={`yq-sidenav-item ${active === it.key ? 'is-active' : ''}`}
                title={it.label}
                onClick={() => go(it.to)}
              >
                <span className="yq-sidenav-icon">{it.icon}</span>
                <span className="yq-sidenav-text">{it.label}</span>
                {counts[it.key] > 0 && (
                  <span className={`yq-sidenav-count ${it.key === 'collab' && unreadCollab ? 'is-hot' : ''}`}>
                    {counts[it.key]}
                  </span>
                )}
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/* 底部小记入口 */}
      <div className="yq-sidenav-foot">
        <button className="yq-sidenav-note" onClick={() => go('/notes')}>
          <span className="yq-sidenav-note-icon">✍️</span>
          <div className="yq-flex-1" style={{ minWidth: 0, textAlign: 'left' }}>
            <div className="yq-sidenav-note-title">记一笔</div>
            <div className="yq-sidenav-note-hint yq-ellipsis">
              {notes[0]?.text.slice(0, 14) || '快速记录碎片想法'}
            </div>
          </div>
        </button>
      </div>

      {/* 抽屉专属：底部再来一个显式关闭入口，拇指够得到 */}
      {drawer && (
        <button className="yq-sidenav-close" onClick={onClose} title="收起导航">
          ✕
        </button>
      )}
    </aside>
  )
}
