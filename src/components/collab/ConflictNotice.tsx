import { useEffect, useMemo, useRef, useState } from 'react'
import { CONFLICT_FLASH_MS } from '@/store'
import type { CollabConflict } from '@/types'
import { flashTarget, jumpToConflict } from './flash'
import './collab.css'

/* ============================================================
   并发编辑的合并提示
   ------------------------------------------------------------
   CRDT 合并是静默的：两边同时改，后到的那个不会把先到的顶掉，
   但用户完全看不出「刚才这里被动过」。
   这里把 store.collabConflicts 摆到协作条上：
     ① 收起的形态：一行「N 处并发编辑已自动合并」
     ② 展开的形态：逐条列出「谁 · 哪个位置 · 冲突几处 · 什么时候」
     ③ 每条都能「查看该位置」（滚动过去并闪一下）或整体「忽略」
   ============================================================ */

const clockOf = (at: number) => {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const TARGET_LABEL: Record<CollabConflict['target'], string> = {
  block: '正文',
  card: '卡片',
  sheet: '文稿数据',
}

export default function ConflictNotice({
  conflicts,
  scrollRef,
  onIgnore,
}: {
  /** 本文档的合并记录（新的在前） */
  conflicts: CollabConflict[]
  /** 正文滚动容器：跳转时以它为基准居中 */
  scrollRef: React.RefObject<HTMLElement>
  onIgnore: () => void
}) {
  const [open, setOpen] = useState(false)
  /** 已经看过的记录：看过就不再自动高亮（避免每次 re-render 都闪） */
  const seen = useRef<Set<string>>(new Set())
  /** 新合并进来时自动展开一次，用户不用去猜「那行字是什么意思」 */
  const autoOpenedFor = useRef('')

  const total = useMemo(() => conflicts.reduce((n, c) => n + c.count, 0), [conflicts])
  const latestAt = conflicts.length ? Math.max(...conflicts.map((c) => c.at)) : 0

  /**
   * 合并发生时把被合并的位置闪一下（2 秒淡出）。
   * 直接在 DOM 上加 class：不碰 Editor 的渲染，contentEditable 不会被重排。
   */
  useEffect(() => {
    if (!conflicts.length) return
    const fresh = conflicts.filter((c) => !seen.current.has(c.id))
    for (const c of fresh) {
      seen.current.add(c.id)
      flashTarget(scrollRef.current, c, CONFLICT_FLASH_MS)
    }
    if (fresh.length && autoOpenedFor.current !== String(latestAt)) {
      autoOpenedFor.current = String(latestAt)
      setOpen(true)
    }
  }, [conflicts, latestAt, scrollRef])

  if (!conflicts.length) return null

  return (
    <div className={`yq-collab-conflict ${open ? 'is-open' : ''}`} data-conflict-count={total}>
      <button
        className="yq-collab-conflict-head"
        onClick={() => setOpen((v) => !v)}
        title={open ? '收起' : '展开查看合并详情'}
      >
        <span className="yq-collab-conflict-dot" />
        <span className="yq-collab-conflict-title">{total} 处并发编辑已自动合并</span>
        <span className="yq-collab-conflict-caret">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="yq-collab-conflict-body">
          {conflicts.map((c) => (
            <div className="yq-collab-conflict-item" key={c.id}>
              <div className="yq-collab-conflict-row">
                <span className={`yq-collab-conflict-tag is-${c.target}`}>{TARGET_LABEL[c.target]}</span>
                <span className="yq-collab-conflict-where" title={c.where}>{c.where}</span>
                <span className="yq-collab-conflict-meta">
                  {c.actorName} 合并进来 · 冲突 {c.count} 处 · {clockOf(c.at)}
                </span>
              </div>
              <div className="yq-collab-conflict-acts">
                <button
                  className="yq-collab-conflict-act"
                  onClick={() => jumpToConflict(scrollRef.current, c, CONFLICT_FLASH_MS + 600)}
                >
                  查看该位置
                </button>
              </div>
            </div>
          ))}
          <div className="yq-collab-conflict-foot">
            <span className="yq-collab-conflict-hint">合并按字段进行，双方的改动都尽量保留</span>
            <button className="yq-collab-conflict-ignore" onClick={onIgnore}>忽略</button>
          </div>
        </div>
      )}
    </div>
  )
}
