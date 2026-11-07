import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '@/store'
import { useMediaQuery, BP } from '@/hooks/useMediaQuery'

import TopBar from '@/components/layout/TopBar'
import SideNav from '@/components/layout/SideNav'
import Toaster from '@/components/layout/Toaster'
import { AppGate } from '@/components/AppGate'

import Dashboard from '@/pages/Dashboard'
import Space from '@/pages/Space'
import SpaceSettings from '@/pages/SpaceSettings'
import BookIndex from '@/pages/BookIndex'
import BookSettings from '@/pages/BookSettings'
import DocPage from '@/pages/DocPage'
import Search from '@/pages/Search'
import Discover from '@/pages/Discover'
import Templates from '@/pages/Templates'
import Help from '@/pages/Help'
import Settings from '@/pages/Settings'
import Trash from '@/pages/Trash'
import Notes from '@/pages/Notes'
import KnowledgeDetail from '@/pages/KnowledgeDetail'
import PublicDoc from '@/pages/PublicDoc'

/** 工作台/空间/发现等使用左侧导航的页面 */
const withSideNav = true
const standalone = false

/**
 * 对外分享的文档页**完全绕开内部界面**：没有 AppGate、没有 store、没有侧栏。
 *
 * 为什么必须绕开 AppGate：它的职责是「没令牌就送登录页」，
 * 而对外访客本来就没有令牌 —— 让他看到登录页等于这份分享没做。
 *
 * 为什么放在这里而不是另建一个入口：分享页和控制台共用同一个 bundle，
 * 内网部署少一个文件、少一条反代规则。
 */
export default function App() {
  const location = useLocation()
  if (location.pathname.startsWith('/public/')) return <PublicDoc />
  return <AppShell />
}

/**
 * 内部界面本体，单独一个组件。
 *
 * 拆出来不是为了好看，是因为上面那个提前 return：
 * 它后面还有 useMediaQuery / useState / useEffect，
 * 条件 return 之后再调 hook 就是**违反 hooks 规则** ——
 * 两次渲染走的分支不一样时 React 会报
 * 「Rendered more hooks than during the previous render」，
 * 而报错时机通常在用户切路由那一刻，看起来和分享页毫无关系。
 */
function AppShell() {
  const location = useLocation()
  const navigate = useNavigate()
  const setActiveDoc = useStore((s) => s.setActiveDoc)
  const touchDoc = useStore((s) => s.touchDoc)

  /* 窄屏下左侧导航收成抽屉，由顶栏的汉堡按钮唤起 */
  const isPhone = useMediaQuery(BP.phone)
  const [navOpen, setNavOpen] = useState(false)

  // 文档页切换时记录
  useEffect(() => {
    const m = location.pathname.match(/\/doc\/([^/]+)/)
    if (m) {
      setActiveDoc(m[1])
      touchDoc(m[1])
    }
  }, [location.pathname, setActiveDoc, touchDoc])

  /**
 * 浏览器快捷键。
 *
 * ⚠️ 这里原来写的是「/ 聚焦搜索，n 新建」，`n` 从来没写过；
 * 而 `/` 那条**做了一件比不做更糟的事**：
 *
 *   if (e.key === '/') { e.preventDefault(); document.querySelector('[data-global-search]')?.focus() }
 *
 * `[data-global-search]` 是搜索面板里的那个 input（TopBar.tsx:387），
 * 而面板**只在它自己打开时才在 DOM 里**。于是面板关着时按 `/`：
 *   · preventDefault 生效 —— 浏览器自带的快速查找被吞掉；
 *   · `?.focus()` 作用在一个 null 上 —— 什么也没发生。
 * 用户看到的就是「按了 / 没反应」。
 *
 * 而且它与 `?`（TopBar.tsx:75，真能开搜索）职责重叠。
 * **留着一个「只吞不做」的 handler 比没有更糟** —— 现在只在面板已打开时
 * 才把焦点交给输入框（这才是 `preventDefault` 之外该做的事），不再吞按键。
 */
useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const typing = ['INPUT', 'TEXTAREA'].includes(t?.tagName) || t?.isContentEditable
      if (typing) return
      // 面板开着的时候，`/` 才去聚焦输入框；关着时**不拦**（全局搜索用 ?）
      if (e.key === '/') {
        document.querySelector<HTMLInputElement>('[data-global-search]')?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  /**
   * 语雀的顶栏是常驻的：进入文档/知识库后，主菜单会被面包屑替换，
   * 但 logo、知识库标题、搜索、通知、用户头像依然在原位。
   * 所以这里只切换「顶栏形态」，不做整页裸奔。
   */
  const isDoc = /\/doc\//.test(location.pathname)
  const isBookIndex = /^\/book\/[^/]+\/?$/.test(location.pathname)
  const inBook = isDoc || isBookIndex
  const showSideNav = !inBook && withSideNav

  /* 抽屉态：路由一变（含切 tab）就收起，点遮罩 / Esc 也能收起 */
  useEffect(() => {
    setNavOpen(false)
  }, [location.pathname, location.search])

  useEffect(() => {
    if (!navOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNavOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navOpen])

  // 抽屉只在「有侧栏 + 手机断点」时存在，宽屏回到常驻侧栏
  const navAsDrawer = showSideNav && isPhone

  return (
    <AppGate>
    <div className={`yq-app ${navAsDrawer ? 'yq-app-navdrawer' : ''}`}>
      <TopBar compact={inBook} onMenu={navAsDrawer ? () => setNavOpen(true) : undefined} />
      <div className={`yq-body ${inBook ? 'yq-body-full' : ''}`}>
        {showSideNav && <SideNav drawer={navAsDrawer} open={navOpen} onClose={() => setNavOpen(false)} />}
        {navAsDrawer && navOpen && (
          <button className="yq-sidenav-mask" aria-label="关闭导航" onClick={() => setNavOpen(false)} />
        )}
        <main className={`yq-main ${inBook ? 'yq-main-full' : ''}`}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/space/:spaceId" element={<Space />} />
            {/* 空间设置（2026-10-16 照真实语雀「空间管理-空间设置」补的）。
                删除空间在它的「高级设置」里 —— 见 SpaceSettings.tsx。 */}
            <Route path="/space/:spaceId/settings" element={<SpaceSettings />} />
            <Route path="/book/:bookId" element={<BookIndex />} />
            <Route path="/book/:bookId/settings" element={<BookSettings />} />
            <Route path="/book/:bookId/doc/:docId" element={<DocPage />} />
            <Route path="/knowledge/:topicId" element={<KnowledgeDetail />} />
            <Route path="/search" element={<Search />} />
            <Route path="/find" element={<Discover />} />
            <Route path="/templates" element={<Templates />} />
            <Route path="/help" element={<Help />} />
            <Route path="/notes" element={<Notes />} />
            <Route path="/trash" element={<Trash />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
      <Toaster />
      <KeyboardHints />
    </div>
    </AppGate>
  )
}

function KeyboardHints() {
  const navigate = useNavigate()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (['INPUT', 'TEXTAREA'].includes(t?.tagName) || t?.isContentEditable) return
      if (e.key === 'g') {
        // g 然后按 d/s
        const onNext = (e2: KeyboardEvent) => {
          if (e2.key === 'd') navigate('/')
          if (e2.key === 's') navigate('/search')
          if (e2.key === 'f') navigate('/find')
          document.removeEventListener('keydown', onNext)
        }
        document.addEventListener('keydown', onNext)
        setTimeout(() => document.removeEventListener('keydown', onNext), 1200)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate])
  return null
}
