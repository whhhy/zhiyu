import { useStore } from '@/store'
import { computeBookStats, computeBookRecentDocs, statsOf } from './bookStats'

/**
 * 组件里直接用这个：`const bs = useBookStats()`，然后 `bs(book).docCount`。
 *
 * 做成 hook 而不是让每个组件自己算，是因为「N 篇 · M 字」散在
 * 工作台 / 顶栏 / 发现 / 搜索 / 模板 / 空间 / 书页 **7 个页面 15 处**，
 * 每处自己算一遍的话，改一次口径要动 15 个地方 —— 漏一处就又是一个
 * 「同一个知识库两个页面两个数」。
 *
 * 单独放一个文件，而不是塞进 bookStats.ts：那边是**纯函数**，
 * 要能在 Node 里直接 import 做单元测试（那里没有 React，也没有 store）。
 * 把 hook 混进去，那个测试就没法跑了。
 */
export function useBookStats() {
  const { books, docs, nodes } = useStore() as any
  const map = computeBookStats(books, docs, nodes || [])
  return (b: { id: string }) => statsOf(map, b.id)
}

/**
 * 团队主页「堆叠卡」里每本书最近更新的 N 篇（语雀实测形态）。
 *
 * 和 `useBookStats` 走同一份 store、同一套取数规则 —— 见
 * `bookStats.ts` 里 `computeBookRecentDocs` 的注释。
 */
export function useBookRecentDocs(limit = 3) {
  const { books, docs, nodes } = useStore() as any
  const map = computeBookRecentDocs(books, docs, nodes || [], limit)
  return (bookId: string) => map.get(bookId) || []
}
