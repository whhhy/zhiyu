import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '@/store'
import { Avatar, Empty } from '@/components/ui'
import { timeAgo } from '@/components/layout/TopBar'
import { copyText } from '@/lib/clipboard'
import './index.css'

/* ============================================================
   划词工具条 —— 语雀：选中文字后可「评论」或「保存到小记」
   纯 overlay，不侵入编辑器 DOM：只读选区信息，画绝对定位的浮层
   ============================================================ */

export interface SelectionInfo {
  text: string
  /** 选区所在块 id */
  blockId: string
  /** 相对视口的选区矩形 */
  rect: { top: number; left: number; width: number; height: number }
  atStart: number
  atEnd: number
}

export function useTextSelection(scrollRef: React.RefObject<HTMLElement>) {
  const [sel, setSel] = useState<SelectionInfo | null>(null)

  const compute = useCallback(() => {
    const s = window.getSelection()
    if (!s || s.isCollapsed || !s.rangeCount) return null
    const text = s.toString().trim()
    if (!text || text.length < 2) return null

    const range = s.getRangeAt(0)
    const anc = range.commonAncestorContainer
    const ancEl = anc.nodeType === Node.ELEMENT_NODE ? (anc as Element) : anc.parentElement
    const blockEl = ancEl?.closest<HTMLElement>('[data-block-id]')
    if (!blockEl) return null

    const r = range.getBoundingClientRect()
    if (!r.width && !r.height) return null

    // 选区在该块文本中的字符区间
    const pre = range.cloneRange()
    pre.selectNodeContents(blockEl)
    pre.setEnd(range.startContainer, range.startOffset)
    const atStart = pre.toString().length
    const atEnd = atStart + text.length

    return {
      text,
      blockId: blockEl.dataset.blockId!,
      rect: { top: r.top, left: r.left, width: r.width, height: r.height },
      atStart,
      atEnd,
    }
  }, [])

  useEffect(() => {
    const onChange = () => {
      // 等浏览器把选区定下来
      requestAnimationFrame(() => setSel(compute()))
    }
    document.addEventListener('selectionchange', onChange)
    // 正文滚动时选区矩形会变，重新算（否则浮层跟文字脱节）
    const sc = scrollRef.current
    sc?.addEventListener('scroll', onChange, { passive: true })
    return () => {
      document.removeEventListener('selectionchange', onChange)
      sc?.removeEventListener('scroll', onChange)
    }
  }, [compute, scrollRef])

  const clear = useCallback(() => setSel(null), [])
  return { sel, clear, recompute: compute }
}

/* ============================================================
   划词工具条
   ============================================================ */

export function SelectionToolbar({
  sel,
  canComment,
  canNote,
  onComment,
  onSaveNote,
  onCancel,
}: {
  sel: SelectionInfo
  /**
   * 「评论」按**这篇文档**的 `comment` 判，
   * 「存小记」按**空间**的 `comment` 判（notes 是空间级实体）—— 两个 id 空间不能混。
   *
   * 默认 true 是为了旧调用方不回归；文档页传的是真的判据。
   * 「复制」不需要任何权限，所以没有开关。
   */
  canComment?: boolean
  canNote?: boolean
  onComment: () => void
  onSaveNote: () => void
  onCancel: () => void
}) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('.yq-selbar') || t.closest('.yq-selpop')) return
      onCancel()
    }
    setTimeout(() => document.addEventListener('mousedown', onDown), 0)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onCancel])

  // 浮层贴选区顶部；靠右边界时右对齐，避免溢出视口
  const left = Math.min(sel.rect.left, window.innerWidth - 200)
  const above = sel.rect.top > 48
  const top = above ? sel.rect.top - 36 : sel.rect.top + sel.rect.height + 6

  return (
    <div className="yq-selbar" style={{ top, left }} onMouseDown={(e) => e.preventDefault()}>
      {/*
        分隔线要夹在**相邻的可见按钮**之间，所以按可见项生成。
        写死三个 `<span className="yq-selbar-div" />` 的话，
        「有评论权、没存小记权」那一档（reader）会变成
        `[评论][复制]` —— 两个按钮之间少一道线，看起来是连在一起的。
        那是条件显隐带出来的新问题，肉眼很容易漏。
      */}
      {[
        canComment !== false ? { k: 'c', icon: '💬', label: '评论', title: '评论', onClick: onComment } : null,
        canNote !== false ? { k: 'n', icon: '🗒️', label: '存小记', title: '保存到小记', onClick: onSaveNote } : null,
        // 复制不需要任何权限，永远在
        { k: 'p', icon: '⧉', label: '', title: '复制', onClick: onCopy },
      ].filter(Boolean).map((it, i) => (
        <Fragment key={it!.k}>
          {i > 0 && <span className="yq-selbar-div" />}
          <button onClick={it!.onClick} title={it!.title}>
            <span className="yq-selbar-icon">{it!.icon}</span>{it!.label}
          </button>
        </Fragment>
      ))}
    </div>
  )
}

/**
 * 划词复制。
 *
 * 原来写的是 `navigator.clipboard?.writeText(...)` —— 内网 HTTP（非安全上下文）
 * 下 `navigator.clipboard` 是 `undefined`，那个 `?.` 让它变成空操作，
 * 而这里**连提示都没有**：用户以为复制了，粘到别处是空的。
 * ⇒ 统一走 `copyText`，降级由它负责，并如实回报。
 */
function onCopy() {
  const text = window.getSelection()?.toString() || ''
  if (!text) return
  void copyText(text)
}

/* ============================================================
   划词评论弹窗
   ============================================================ */

export function SelectionCommentPop({
  sel,
  onClose,
  onSubmit,
}: {
  sel: SelectionInfo
  onClose: () => void
  onSubmit: (text: string) => void
}) {
  const [text, setText] = useState('')
  const left = Math.min(sel.rect.left, window.innerWidth - 340)
  const top = Math.min(sel.rect.top + sel.rect.height + 8, window.innerHeight - 240)

  return (
    <div className="yq-selpop" style={{ top, left }} onMouseDown={(e) => e.preventDefault()}>
      <div className="yq-selpop-head">评论</div>
      <div className="yq-selpop-quote">“{sel.text}”</div>
      <textarea
        className="yq-selpop-input"
        autoFocus
        placeholder="写下你的评论…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) onSubmit(text.trim())
          if (e.key === 'Escape') onClose()
        }}
      />
      <div className="yq-selpop-foot">
        <span className="yq-flex-1">⌘ + Enter 发送</span>
        <button className="yq-btn yq-btn-text yq-btn-sm" onClick={onClose}>取消</button>
        <button className="yq-btn yq-btn-primary yq-btn-sm" disabled={!text.trim()} onClick={() => onSubmit(text.trim())}>
          发表
        </button>
      </div>
    </div>
  )
}

/* ============================================================
   划词评论侧栏 —— 列出本文档的所有划词评论
   ============================================================ */

export function SelectionCommentPanel({
  docId,
  canComment = true,
  onClose,
  onJump,
}: {
  docId: string
  /**
   * 「回复」「标记解决」「重新打开」都是**写**动作，服务端按 `caps.comment` 判。
   *
   * ⚠️ 这里以前**一个门都没有** —— 实测（探针，真服务端）：
   * visitor 和 reader 看到的按钮完全一样（✕ / 回复 / 标记解决），
   * visitor 点下去 store 照收、服务端拒、顶栏常驻「N 处修改没有保存」而本人修不好。
   *
   * 面板本身仍然对所有人开放：**看**别人写的划词评论是读，不需要任何权限。
   * 默认 true 是为了旧调用方不回归。
   */
  canComment?: boolean
  onClose: () => void
  onJump: (blockId: string) => void
}) {
  const {
    selectionComments, getMember, currentUser,
    resolveSelectionComment, replySelectionComment, removeSelectionComment, toast,
  } = useStore()
  const list = selectionComments[docId] || []
  const open = list.filter((c) => !c.resolved)
  const resolved = list.filter((c) => c.resolved)

  return (
    <aside className="yq-selpanel">
      <div className="yq-selpanel-head">
        <span>划词评论 {list.length > 0 && `(${list.length})`}</span>
        <button onClick={onClose}>✕</button>
      </div>

      <div className="yq-selpanel-body">
        {list.length === 0 && (
          <Empty icon="💬" text="还没有划词评论" action={
            <span style={{ fontSize: 11, color: 'var(--yq-text-4)' }}>在正文里选中一段文字即可评论</span>
          } />
        )}

        {open.length > 0 && open.map((c) => {
          const a = getMember(c.authorId)
          return (
            <div key={c.id} className="yq-selc">
              <div className="yq-selc-quote" onClick={() => c.blockId && onJump(c.blockId)} title="点击定位">
                “{c.quote}”
              </div>
              <div className="yq-selc-row">
                <Avatar name={a?.name || '?'} size={22} />
                <div className="yq-flex-1" style={{ minWidth: 0 }}>
                  <div className="yq-selc-meta">
                    <b>{a?.name}</b>
                    <span>{timeAgo(c.createdAt)}</span>
                  </div>
                  <div className="yq-selc-text">{c.text}</div>
                </div>
              </div>
              {(c.replies || []).map((r) => {
                const ra = getMember(r.authorId)
                return (
                  <div key={r.id} className="yq-selc-reply">
                    <Avatar name={ra?.name || '?'} size={18} />
                    <div style={{ minWidth: 0 }}>
                      <b>{ra?.name}</b>
                      <span className="yq-selc-text">{r.text}</span>
                    </div>
                  </div>
                )
              })}
              <div className="yq-selc-acts">
                {canComment && (
                  <>
                    <button
                      onClick={() => {
                        const t = prompt('回复这条评论')
                        if (t?.trim()) replySelectionComment(docId, c.id, t.trim())
                      }}
                    >
                      回复
                    </button>
                    <button onClick={() => { resolveSelectionComment(docId, c.id); toast('已标记为解决', 'success') }}>
                      标记解决
                    </button>
                  </>
                )}
                {canComment && c.authorId === currentUser.id && (
                  <button className="is-danger" onClick={() => removeSelectionComment(docId, c.id)}>删除</button>
                )}
              </div>
            </div>
          )
        })}

        {resolved.length > 0 && (
          <>
            <div className="yq-selpanel-label">已解决 ({resolved.length})</div>
            {resolved.map((c) => (
              <div key={c.id} className="yq-selc is-resolved">
                <div className="yq-selc-quote">“{c.quote}”</div>
                <div className="yq-selc-text">{c.text}</div>
                <div className="yq-selc-acts">
                  {canComment && <button onClick={() => resolveSelectionComment(docId, c.id)}>重新打开</button>}
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  )
}
