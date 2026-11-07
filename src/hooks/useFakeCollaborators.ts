import { useEffect, type RefObject } from 'react'
import type { Block, CollabCursor } from '@/types'
import { useStore } from '@/store'
import { CURSOR_COLORS } from '@/data/settings'
import { openCollabSession, useCollabPeers, useDemoMode } from '@/lib/collaboration'

/* ============================================================
   协作光标（本文件历史上只有"模拟协作者"，现在是真协同）

   1) useCollaboration —— 真协同。
      开一条 BroadcastChannel（同源多标签页），收发的活儿全在
      @/lib/collaboration 里；这个 hook 只负责生命周期：
      文档页挂载 → 开会话，卸载 → close()（退频道 + 清光标）。
      效果只依赖 docId：正文 blocks 每次输入都会换新对象，
      绝不能进依赖数组，否则打字一次就把整个会话重建一遍
      （重建会 close 掉旧频道、并把对端光标清掉，视觉上闪断）。
   2) useDemoCollaborators —— 演示模式（默认关）。
      只有一个标签页时画面太冷清，用假协作者填一填；
      一旦检测到真实连接就自动让位。切文档 / 关闭时只摘自己
      造的那几条光标，不能连真实协作者的一起清掉。
   ============================================================ */

/**
 * 真实协同会话。
 * @param docId    当前文档
 * @param editorRef 编辑器根节点，用来把 DOM 选区换算成块内偏移
 */
export function useCollaboration(
  docId: string | undefined,
  editorRef: RefObject<HTMLElement>,
) {
  // editorRef 是 useRef 出来的稳定对象，不需要进依赖数组；
  // 依赖只有 docId —— 正文 blocks 每次输入都换新对象，
  // 一旦进了依赖数组，打字一次就会重建整个会话
  // （重建会 close 掉旧频道并清掉对端光标，视觉上闪断）。
  useEffect(() => {
    if (!docId) return
    const session = openCollabSession({ docId, getRoot: () => editorRef.current })
    return () => session.close()
  }, [docId])
}

/* ============================================================
   演示模式：模拟远端协作者
   ============================================================ */

const MIN_PERIOD = 1500
const MAX_PERIOD = 3000

interface Sim {
  memberId: string
  color: string
  blockId: string
  offset: number
  range: [number, number]
  /** 是否暂时切走（不在 store 里，视觉上消失） */
  away: boolean
  activeAt: number
}

const rand = (min: number, max: number) => min + Math.random() * (max - min)
const pickInt = (max: number) => Math.floor(Math.random() * Math.max(1, max))
/** 随机初始间隔，让每个成员的节奏天然错开 */
const period = () => Math.round(rand(MIN_PERIOD, MAX_PERIOD))

function toCursor(docId: string, s: Sim): CollabCursor {
  return {
    id: `cur_${docId}_${s.memberId}`,
    docId,
    memberId: s.memberId,
    blockId: s.blockId,
    offset: s.offset,
    range: s.range,
    color: s.color,
    activeAt: s.activeAt,
  }
}

/** 编辑器会渲染出文本容器的块类型（.yq-block-text / .yq-code-body） */
const CURSORABLE = new Set<Block['type']>([
  'p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'todo', 'quote', 'callout', 'code',
])

/** 有正文的块才谈得上光标（分割线 / 图片 / 表格没有文本容器） */
const textBlocks = (blocks: Block[]) =>
  blocks.filter((b) => CURSORABLE.has(b.type) && (b.text || '').length > 0)

/**
 * 假协作者。开关逻辑都在本 hook 内：
 * 演示模式打开 **且** 当前没有真实协作者在线时才起效。
 */
export function useDemoCollaborators(docId: string | undefined) {
  // 新建文档只有一个空 H1，没有任何可落位的正文，此时先不进协作；
  // 一旦正文有内容（false → true）effect 自动补跑，协作者就进来了。
  // 用 boolean 做 selector，返回值不变就不会引起额外渲染。
  // 注意 `?.` 只挡住了 docs[docId] 为空，挡不住 **blocks 还没加载**：
  // 轻量启动之后大部分文稿只有元信息，blocks 是 undefined，
  // 写成 `?.blocks.some(...)` 会在这里抛「undefined 上没有 some」。
  const hasText = useStore((s) =>
    !!(docId && s.docs[docId]?.blocks?.some((b) => (b.text || '').length > 0)),
  )
  // 演示模式开关 + 真实在场名单：任何一个变化都要重算 on
  const demo = useDemoMode()
  const peers = useCollabPeers()
  const realPeer = !!docId && peers.some((p) => p.docId === docId)
  const on = demo && !realPeer

  useEffect(() => {
    if (!docId || !on) return
    const st = useStore.getState()
    const doc = st.docs[docId]
    if (!doc || doc.type !== 'doc') return
    // 正文被清空（删光了）就散场
    const initBlocks = textBlocks(doc.blocks)
    if (!initBlocks.length) return

    // 排除自己，随机 2~3 位在场成员
    const pool = st.members.filter((m) => m.id !== st.currentUser.id)
    if (!pool.length) return
    const count = Math.min(pool.length, 2 + pickInt(2))
    const picked = [...pool].sort(() => Math.random() - 0.5).slice(0, count)

    // 颜色按成员固定（标识色应该跟着人走，不是每次刷新都换），
    // 取模保证同一个成员在不同文档里颜色一致且互不相同
    const colorOf = (memberId: string) => {
      const i = st.members.findIndex((m) => m.id === memberId)
      return CURSOR_COLORS[(i < 0 ? 0 : i) % CURSOR_COLORS.length]
    }

    const sims: Sim[] = []
    const timers: ReturnType<typeof setInterval>[] = []

    /** 把还在场的成员写回 store（切走的成员不写，视觉上就是消失了） */
    const publish = () => {
      const s = useStore.getState()
      for (const sim of sims) if (!sim.away) s.setCursor(toCursor(docId, sim))
    }

    /** 某个成员「切走」：只摘他自己那条光标，别人的不能动 */
    const republish = () => {
      const s = useStore.getState()
      for (const sim of sims) {
        if (sim.away) s.removeMemberCursor(docId, sim.memberId)
        else s.setCursor(toCursor(docId, sim))
      }
    }

    const step = (sim: Sim) => {
      const blocks = textBlocks(useStore.getState().docs[docId]?.blocks || [])
      if (!blocks.length) return

      if (sim.away) {
        // 切走一会儿又回来了
        sim.away = false
        sim.activeAt = Date.now()
        publish()
        return
      }

      const roll = Math.random()
      if (roll < 0.08) {
        // 短暂消失：切到别的文档 / 走神，光标先从正文里撤掉
        sim.away = true
        republish()
        return
      }

      if (roll < 0.78) {
        // 大多数时候留在当前块：移动光标 / 选中一段
        const cur = blocks.find((b) => b.id === sim.blockId) || blocks[pickInt(blocks.length)]
        const len = (cur.text || '').length
        if (roll < 0.5) {
          // 移动光标
          sim.offset = pickInt(len)
          sim.range = [sim.offset, sim.offset]
        } else {
          // 选中一段文字
          const start = pickInt(len)
          const end = Math.min(len, start + 3 + pickInt(16))
          sim.offset = start
          sim.range = start === end ? [start, start] : [start, end]
        }
      } else {
        // 换到别的块
        const others = blocks.filter((b) => b.id !== sim.blockId)
        const block = others.length ? others[pickInt(others.length)] : blocks[pickInt(blocks.length)]
        sim.blockId = block.id
        sim.offset = pickInt((block.text || '').length)
        sim.range = [sim.offset, sim.offset]
      }
      sim.activeAt = Date.now()
      publish()
    }

    // 落位 + 每个成员一个独立随机周期的定时器
    for (const m of picked) {
      const block = initBlocks[pickInt(initBlocks.length)]
      const off = pickInt((block.text || '').length)
      const sim: Sim = {
        memberId: m.id,
        color: colorOf(m.id),
        blockId: block.id,
        offset: off,
        range: [off, off],
        away: false,
        activeAt: Date.now(),
      }
      sims.push(sim)
      timers.push(setInterval(() => step(sim), period()))
    }
    publish()

    return () => {
      for (const t of timers) clearInterval(t)
      // 只摘自己造的：此刻可能已经有真人（另一个标签页）进来了
      for (const sim of sims) useStore.getState().removeMemberCursor(docId, sim.memberId)
    }
  }, [docId, hasText, on])
}
