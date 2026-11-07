/* ============================================================
   文档的可搜文本 —— 服务端与前端**共用**同一套口径
   ------------------------------------------------------------
   为什么要有这个文件：2026-10-06 之前，抽「一篇文档里有哪些可搜文字」
   这件事在两个地方各写了一遍，而它们**不一样**：

     · server/sync.ts 的 reindex  —— 抽 块 text + 卡片 data 的 name/text
     · src/lib/useSearch.ts      —— 只抽 块 text（body 为空时的兜底）

   于是纯前端形态（没连服务端、或文档没打开过）里，
   「投票的问题」「看板的条目」这类**只存在于卡片 data 里**的内容搜不到 ——
   而同一个人连上服务端就能搜到。同一份数据、两种形态、两种答案。

   口径定成：**标题 + 正文 + 每块的 text + 卡片 data 的深走结果**，
   与服务端一致。三道边界（跳过 blob/id 键、单串 ≤200、单块 ≤1500）
   见 cardSearchText。

   顺带修掉一个真 bug：原来前端在 `body` 为空时才退到 blocks，
   而 body 本身也是从 blocks 派生的、卡片位置是空的 ——
   于是「卡片里有什么」这条信息**两处都拿不到**。
   ============================================================ */

/** 卡片 data 里不参与索引的键：二进制、blob、以及不可读的 id 列表 */
const CARD_SKIP_KEYS = new Set(['dataUrl', 'html', 'svg', 'css', 'src', 'key', 'votes'])
const CARD_MAX_STR = 200
const CARD_MAX_TOTAL = 1500

/**
 * 深走卡片 data，把「像人话」的短字符串收进 emit。
 *
 * 为什么深走而不是给每种卡片写一张字段表：卡片有 44 个 id、data 形状还在变，
 * 逐个写就得维护一张表，漏一个就又是那种「安静地搜不到」的洞。
 *
 * 三道边界不是「额外功能」，是深走的刹车 —— 没有它们，
 * 一张塞满图的相册会把整段 base64 塞进索引。
 */
export function cardSearchText(data: unknown, emit: (s: string) => void) {
  let budget = CARD_MAX_TOTAL
  const walk = (v: unknown, depth: number) => {
    if (budget <= 0 || depth > 6) return
    if (typeof v === 'string') {
      const s = v.trim()
      if (!s || s.length > CARD_MAX_STR) return
      emit(s)
      budget -= s.length
      return
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (CARD_SKIP_KEYS.has(k)) continue
        walk(x, depth + 1)
      }
    }
  }
  walk(data, 0)
}

/** 服务端索引用的那一份（标题在调用方拼，这里只管正文与块） */
export function blocksSearchText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    const blk = b as { type?: string; text?: unknown; data?: unknown }
    // 分割线的 text 是空壳，进索引只会稀释结果（刻意的）；
    // 图片的 text 现在是**图片右边那段话**（真实正文）→ 要进索引，
    // 但它的 data（附件名 / alt）不是正文，不进。
    if (blk.type === 'divider') continue
    if (blk.type === 'image') {
      if (typeof blk.text === 'string' && blk.text) parts.push(blk.text)
      continue
    }
    if (typeof blk.text === 'string' && blk.text) parts.push(blk.text)
    if (blk.data && typeof blk.data === 'object') {
      const got: string[] = []
      cardSearchText(blk.data, (s) => got.push(s))
      parts.push(...got)
    }
  }
  return parts.join(' ')
}

/**
 * 一篇文档的可搜文本 —— 前端本地搜索与摘要都用它。
 *
 * ⚠️ `body` 不再作为首选：它是由 blocks 派生的、卡片位置是空的，
 * 直接用它会把卡片内容整个漏掉。所以**以 blocks 为准，body 只在没有 blocks 时兜底**
 * （导入包/老数据可能只有 body）。
 */
export function docSearchText(doc: { body?: string; blocks?: unknown }): string {
  const fromBlocks = blocksSearchText(doc.blocks)
  if (fromBlocks) return fromBlocks
  return String(doc.body || '')
}