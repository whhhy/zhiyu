import { useEffect, useState } from 'react'

/**
 * 订阅一条媒体查询。
 * 初值同步读一次 matchMedia，首屏就不会闪回桌面版式；
 * 非浏览器环境（SSR / 老浏览器）兜底为 false = 桌面版式。
 */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  )

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(query)
    const onChange = () => setMatch(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return match
}

/** 与 src/styles/responsive.css 里的断点一一对应，改一处两处都要改 */
export const BP = {
  /** 平板：侧栏图标条、顶栏主菜单进「更多」 */
  tablet: '(max-width: 1024px)',
  /** 手机：完整移动版式 */
  phone: '(max-width: 768px)',
  /** 小屏 */
  small: '(max-width: 480px)',
} as const
