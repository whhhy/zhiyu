/* ============================================================
   应用级撤销 / 重做
   ============================================================
   为什么必须自己写一份：
   浏览器的原生撤销只活在**一个 contenteditable** 里，而且只退**一个字**；
   而我们每个字符都会把块数组写回 store、React 重渲染整块，
   原生撤销栈随时被冲掉。

   实测（2026-10-19，`http://192.168.1.16:8080` 真机）：
     · 块内打字 → ⌘Z 退**一个字**（"标题abc" → "标题ab"），原生撤销还在
     · 回车新建块 → ⌘Z **块撤不回来**（块数 2 → 2），只把新块里的字撤了
     · 块菜单删块 → ⌘Z **撤不回来**（块数 1 → 1）
   也就是说：跨块的操作（新建/删除/插卡片/转块类型）**一个都撤不回来**，
   而界面上只有一句「撤销上一次输入（仅块内，不含块级操作）」，用户根本不知道边界在哪。

   语雀的 ⌘Z 撤的是「刚才那个动作」。这里追平它。

   ------------------------------------------------------------
   三个设计决定
   ------------------------------------------------------------
   ① **存「提交前」的块数组快照**，不存操作日志。
      块数组就是正文的全部真相，快照即状态 —— 撤销 = 把快照写回去。
      存操作日志的话，每种操作都要写一套逆操作，漏一种就出现「撤销之后还是错的」。

   ② **连续打字合并成一条**。
      打字是逐字提交的（每个字符一次 onChange），不合并的话撤销栈会变成
      「一个字符一条」，⌘Z 一次退一个字 —— 那等于没做。
      判据：这次变更**只改了一个块的文字**（`pureTextEdit`），
      且上一条历史也是**同一块**、且发生在 TYPING_WINDOW 毫秒内 → 视作同一次输入。

   ③ **历史按文档分**（Map<docId, …>）。
      换一篇文档再回来，那篇的撤销栈还在 —— 和语雀一致。
   ============================================================ */
import type { Block } from '@/types'

/** 一次历史 = 提交**之前**的块数组快照 */
type Entry = { blocks: Block[]; at: number; blockId: string | null }

/** 连续输入的合并窗口：在这个时间差内的纯文本变更算同一次输入 */
const TYPING_WINDOW = 800
/** 栈深上限：正文可能很大，快照多了会吃内存 */
const MAX_DEPTH = 100

const undoStacks = new Map<string, Entry[]>()
const redoStacks = new Map<string, Block[][]>()

/**
 * 这次变更是不是「只改了一个块的文字」—— 也就是**打字**。
 *
 * 判据要准：
 *   · 块数变了 → 结构操作（回车/删除/插入）→ 不算打字
 *   · 块 id 对不上 → 结构操作 → 不算打字
 *   · 一次改了两块以上 → 不是打字（多选批量改、拖动排序）→ 不算打字
 *   · 只改了 `checked` / `lang` 这类字段 → 也不是打字（勾选待办、换代码语言）
 * 判错的代价：把结构操作当成打字合并掉 → 撤销会「跳过一次操作」。
 */
export function pureTextEdit(prev: Block[], next: Block[]): { blockId: string } | null {
  if (!Array.isArray(prev) || !Array.isArray(next)) return null
  if (prev.length !== next.length) return null
  let hit = ''
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i]
    const b = next[i]
    if (!a || !b || a.id !== b.id) return null
    if (a.text !== b.text || a.html !== b.html) {
      if (hit) return null        // 一次改了两块 → 不是打字
      hit = a.id
    }
  }
  return hit ? { blockId: hit } : null
}

/**
 * 记一次「提交之前」的状态。
 *
 * @param docId  文档 id
 * @param prev   **提交之前**的块数组
 * @param next   提交之后的块数组（用来判别是不是打字）
 */
export function pushUndo(docId: string, prev: Block[], next: Block[], now = Date.now()) {
  if (!docId || !Array.isArray(prev)) return
  const st = undoStacks.get(docId) || []
  const pt = pureTextEdit(prev, next)

  if (pt) {
    const top = st[st.length - 1]
    if (top && top.blockId === pt.blockId && now - top.at < TYPING_WINDOW) {
      /*
       * 同一次连续输入：**不动栈顶**。
       * 栈顶存的是「这一串输入**开始之前**的快照」——
       * 那正是撤销该串输入要回到的地方，替换它就等于把输入的起点抹掉了。
       * 只把时间戳往后挪，好让「还在连续输入中」这个判断保持成立。
       */
      top.at = now
      undoStacks.set(docId, st)
      redoStacks.delete(docId)
      return
    }
    st.push({ blocks: prev, at: now, blockId: pt.blockId })
  } else {
    st.push({ blocks: prev, at: now, blockId: null })
  }
  while (st.length > MAX_DEPTH) st.shift()
  undoStacks.set(docId, st)
  /* 一旦有新操作，重做栈就作废 —— 这是所有编辑器的共同约定 */
  redoStacks.delete(docId)
}

/** 撤销：返回要写回的块数组；没有可撤销的返回 null */
export function undoDoc(docId: string, current: Block[]): Block[] | null {
  const st = undoStacks.get(docId) || []
  if (!st.length) return null
  const e = st.pop()!
  const rs = redoStacks.get(docId) || []
  rs.push(current)
  redoStacks.set(docId, rs)
  undoStacks.set(docId, st)
  return e.blocks
}

/** 重做 */
export function redoDoc(docId: string, current: Block[]): Block[] | null {
  const rs = redoStacks.get(docId) || []
  if (!rs.length) return null
  const blocks = rs.pop()!
  const st = undoStacks.get(docId) || []
  st.push({ blocks: current, at: Date.now(), blockId: null })
  undoStacks.set(docId, st)
  redoStacks.set(docId, rs)
  return blocks
}

export const canUndo = (docId: string) => (undoStacks.get(docId) || []).length > 0
export const canRedo = (docId: string) => (redoStacks.get(docId) || []).length > 0
/** 换文档 / 删文档时清掉它那份历史 */
export const clearUndo = (docId: string) => { undoStacks.delete(docId); redoStacks.delete(docId) }
