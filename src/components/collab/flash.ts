import type { CollabConflict } from '@/types'

/* ============================================================
   合并高亮 / 跳转
   ------------------------------------------------------------
   被合并的位置要「闪一下」，但绝不能为此去改 Editor 的渲染：
   contentEditable 被 React 重排一次，光标就会跳、正在打的字会丢。
   所以这里只做两件最轻的事：给目标元素挂一个 class，2 秒后摘掉。
   ============================================================ */

const FLASH_CLASS = 'yq-collab-flash'
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()

/** 目标元素的定位：正文块走 data-block-id，文稿数据走 DocPage 包的那层壳 */
const selectorOf = (c: CollabConflict) =>
  c.blockId ? `[data-block-id="${c.blockId}"]` : c.section ? `[data-collab-section="${c.section}"]` : ''

/** 在容器里找到这条合并对应的元素（找不到就静默返回，合并本身不受影响） */
export function targetEl(root: HTMLElement | null, c: CollabConflict): HTMLElement | null {
  if (!root) return null
  const sel = selectorOf(c)
  if (!sel) return null
  return root.querySelector<HTMLElement>(sel) || document.querySelector<HTMLElement>(sel)
}

/** 闪一下：加 class → 到点摘掉。重复调用会顺延，不会叠出多个定时器 */
export function flashTarget(
  root: HTMLElement | null,
  c: CollabConflict,
  ms: number,
): HTMLElement | null {
  const el = targetEl(root, c)
  if (!el) return null
  el.classList.remove(FLASH_CLASS)
  // 强制重排，让连续两次合并都能重新触发 CSS 动画
  void el.offsetWidth
  el.classList.add(FLASH_CLASS)
  const old = timers.get(el)
  if (old) clearTimeout(old)
  timers.set(
    el,
    setTimeout(() => {
      el.classList.remove(FLASH_CLASS)
      timers.delete(el)
    }, ms),
  )
  return el
}

/** 「查看该位置」：滚过去 + 闪一下 */
export function jumpToConflict(
  root: HTMLElement | null,
  c: CollabConflict,
  ms: number,
): HTMLElement | null {
  const el = flashTarget(root, c, ms)
  if (!el) return null
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  return el
}

export { FLASH_CLASS }
