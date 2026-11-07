/**
 * 知识库的「N 篇 · M 字」——**读取时现算**，不读存起来的聚合值。
 *
 * ============================================================
 * 为什么不能继续读 book.docCount / book.wordCount
 * ------------------------------------------------------------
 * 那是两个**会漂移的存量聚合**：
 *   · 建库时给 0，之后只在「新建文档」时 +1 —— 删文档**不减**；
 *   · wordCount 建库之后再没被更新过，编辑文档也不动它。
 *
 * 后果不是「慢慢不准」，是**直接跟真值对不上**：
 * 服务端 seed 建出来的知识库 wordCount 全是 0，而客户端 seed
 * （`src/data/seed.ts`）里写的是 28400 / 45100 那些编造的数字。
 * 服务端才是权威 —— 于是工作台上每个知识库都显示「0 字」，
 * 同一本书的书页（那边是现算的）却显示 2107 字。
 *
 * 这跟项目里已经修过的「阅读统计是编造的」是同一类问题：
 * **把派生值存起来，就一定有一处路径忘了更新它。**
 *
 * 所以这里现算。代价是每次渲染遍历一次文档，量级是
 * 「文档数 × 书数」；内网部署的规模（几千篇文档）完全承受得住，
 * 而换来的是**结构上不可能不一致**。
 *
 * 这个文件刻意只留纯函数、不引 store —— 它要能在 Node 里被直接 import
 * 做单元测试。React 那层在 `useBookStats.ts`。
 */

export interface DocLike {
  bookId?: string
  wordCount?: number
}

export interface NodeLike {
  bookId?: string
  docId?: string | null
  /**
   * 目录树上被隐藏的节点（软删一篇文档时，节点是**藏起来**而不是删掉 ——
   * 见 `server/sync.ts` 的 `hideNodesOfDoc`：真删的话还原时位置就找不回来了）。
   */
  hidden?: boolean
}

export interface BookStats {
  docCount: number
  wordCount: number
}

/**
 * 按知识库汇总。
 *
 * 用 `nodes` 上挂的 `docId` 数篇数，而不是 `docs` 里数 ——
 * 因为目录里没挂出去的文档（刚建好还没加进目录）在界面上就不算这个库的篇数，
 * 这和用户在书页看到的口径一致。
 */
export function computeBookStats(
  books: { id: string }[] | Record<string, { id: string }>,
  docs: Record<string, DocLike> | DocLike[],
  nodes: NodeLike[],
): Map<string, BookStats> {
  const out = new Map<string, BookStats>()
  const bookIds = Array.isArray(books) ? books.map((b) => b.id) : Object.values(books || {}).map((b) => b.id)
  for (const id of bookIds) out.set(id, { docCount: 0, wordCount: 0 })

  const docMap: Record<string, DocLike> = Array.isArray(docs)
    ? Object.fromEntries(docs.map((d: any, i: number) => [d.id || String(i), d]))
    : (docs || {})

  for (const n of nodes || []) {
    if (!n || !n.bookId || !n.docId) continue
    /*
     * 隐藏的节点不算这个库的篇数。
     *
     * 依据是「篇数按目录里挂出去的算」（见上面的注释）——
     * 而 `Tree.tsx` **不渲染 `hidden` 的节点**，所以算进去会和树对不上：
     * 树上没有这一项，书页上却写着「N 篇」。
     *
     * ⚠️ 以前这里只靠下一行的「文档取不到就跳过」，而那只是**巧合**：
     *   软删时文档确实也从 `docs` 里没了。另一条数法（`book-export`）
     *   查的却是 `hidden` —— 两处规则不同，今天一致纯属运气。
     *   2026-10-14 软删改成「藏节点」之后这个巧合就更不能 reliance 了：
     *   哪天统计不再经过 `docs`，篇数就会悄悄多出一篇。
     */
    if (n.hidden) continue
    const st = out.get(n.bookId)
    if (!st) continue
    const d = docMap[n.docId]
    if (!d) continue          // 指向已删文档的残留节点，不计入
    st.docCount += 1
    st.wordCount += Number(d.wordCount) || 0
  }
  return out
}

/** 兜底：拿不到统计时给出 0，而不是 undefined 让界面显示 NaN */
export function statsOf(map: Map<string, BookStats> | undefined, bookId: string): BookStats {
  return map?.get(bookId) || { docCount: 0, wordCount: 0 }
}

export interface RecentDoc {
  id: string
  title: string
  updatedAt: number
}

/**
 * 每个知识库最近更新的 N 篇 —— 语雀团队主页「堆叠卡」里那几条文档。
 *
 * 2026-10-15 实测语雀 `/yuque`：`content: ["book_stacks"]`，
 * 一本书一张大卡，卡内列最近 3 篇文档带时间戳。
 * （`layout.aside` 里配的 topics / latest_docs / latest_books
 *   在真实页面上**根本没有渲染** —— 那是配置项，别照着它臆造一整条侧栏。）
 *
 * ⚠️ 取数规则必须与 `computeBookStats` **同源**，一条都不能差：
 *   跳过 `hidden` 节点、跳过 `docs` 里取不到的节点。
 * 后一条同时是**权限边界**：服务端的 `docs` 行按 `canSeeDocRow` 过滤过，
 * 客户端 store 里根本没有他读不到的文档 —— 于是「取不到」天然等于
 * 「不该在这里出现它的标题」，私有文档不会顺着堆叠卡泄漏出去。
 * 这里要是自己另写一套（比如直接遍历 docs），那条边界就没了。
 */
export function computeBookRecentDocs(
  books: { id: string }[] | Record<string, { id: string }>,
  docs: Record<string, { title?: string; updatedAt?: number }> | { id?: string; title?: string; updatedAt?: number }[],
  nodes: NodeLike[],
  limit = 3,
): Map<string, RecentDoc[]> {
  const out = new Map<string, RecentDoc[]>()
  const bookIds = Array.isArray(books) ? books.map((b) => b.id) : Object.values(books || {}).map((b) => b.id)
  for (const id of bookIds) out.set(id, [])

  const docMap: Record<string, { title?: string; updatedAt?: number }> = Array.isArray(docs)
    ? Object.fromEntries(docs.map((d: any, i: number) => [d.id || String(i), d]))
    : (docs || {})

  for (const n of nodes || []) {
    if (!n || !n.bookId || !n.docId) continue
    if (n.hidden) continue
    const list = out.get(n.bookId)
    if (!list) continue
    const d = docMap[n.docId]
    if (!d) continue
    list.push({ id: String(n.docId), title: String(d.title || '无标题'), updatedAt: Number(d.updatedAt) || 0 })
  }

  for (const [id, list] of out) {
    // 同毫秒更新时按标题排，保证结果稳定 —— 否则每次渲染顺序都可能跳
    list.sort((a, b) => (b.updatedAt - a.updatedAt) || a.title.localeCompare(b.title, 'zh-CN'))
    out.set(id, list.slice(0, Math.max(0, limit)))
  }
  return out
}
