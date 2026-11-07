/* ============================================================
   本地偏好
   ------------------------------------------------------------
   这些**不参与同步**：它们是「这台机器、这个人」的阅读习惯，
   不是知识库的内容。跟着文档一起同步到所有设备没有意义 ——
   反而会让「改一次字号，全公司的同事编辑器都变了」。

   所以走 localStorage，并且**集中在这里**读。
   以前设置页里的「编辑器字号」是个 onChange={() => {}} 的空控件：
   界面上有，点了没反应。现在它是真的。
   ============================================================ */

import { useCallback, useEffect, useState } from 'react'

export interface Prefs {
  /** 文档编辑区字号：sm / md / lg */
  editorFontSize: 'sm' | 'md' | 'lg'
  /** 打开文档时右侧大纲是否展开 */
  outlineOnOpen: boolean
  /** 通知偏好 */
  notify: Record<NotifyKey, boolean>
}

export type NotifyKey = 'comment' | 'collab' | 'docUpdate' | 'topic' | 'weekly'

/** 通知项的默认值。weekly 默认关 —— 「每周精选」这种推荐流没人真的想要 */
export const NOTIFY_KEYS: { key: NotifyKey; label: string; desc: string }[] = [
  { key: 'comment', label: '文档评论', desc: '有人评论或回复你参与的文档' },
  { key: 'collab', label: '协作邀请', desc: '有人邀请你共同编辑文档' },
  { key: 'docUpdate', label: '文档更新', desc: '你关注的文档有新版本' },
  { key: 'topic', label: '话题回复', desc: '你参与的话题有人回复' },
  { key: 'weekly', label: '每周精选', desc: '每周一推送空间内热门内容' },
]

const DEFAULTS: Prefs = {
  editorFontSize: 'md',
  outlineOnOpen: true,
  notify: { comment: true, collab: true, docUpdate: true, topic: true, weekly: false },
}

const KEY = 'yq_prefs_v1'

export const FONT_SIZE_PX: Record<Prefs['editorFontSize'], number> = { sm: 13, md: 15, lg: 17 }

function read(): Prefs {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS, notify: { ...DEFAULTS.notify } }
    const j = JSON.parse(raw)
    return {
      // 每个字段都单独校验：localStorage 里的东西可能来自旧版本，也可能被人手改过。
      // 直接 {...DEFAULTS, ...j} 的话，一个坏值会一路带着走，而且没有任何症状。
      editorFontSize: ['sm', 'md', 'lg'].includes(j?.editorFontSize) ? j.editorFontSize : DEFAULTS.editorFontSize,
      outlineOnOpen: typeof j?.outlineOnOpen === 'boolean' ? j.outlineOnOpen : DEFAULTS.outlineOnOpen,
      // 通知是后加的字段，老存档里没有 —— 必须逐项兜底，
      // 直接展开的话，新增的通知项在老用户那儿会是 undefined（开关变成不受控）
      notify: Object.fromEntries(
        NOTIFY_KEYS.map(({ key }) => [key, typeof j?.notify?.[key] === 'boolean' ? j.notify[key] : DEFAULTS.notify[key]]),
      ) as Record<NotifyKey, boolean>,
    }
  } catch {
    return { ...DEFAULTS, notify: { ...DEFAULTS.notify } }
  }
}

let cache: Prefs | null = null
const listeners = new Set<(p: Prefs) => void>()

export function getPrefs(): Prefs {
  if (!cache) cache = read()
  return cache
}

export function setPrefs(patch: Partial<Prefs>) {
  const cur = getPrefs()
  // notify 要**合并**而不是整体替换：
  // setPrefs({ notify: {...} }) 只传一个键时，直接覆盖会把另外四个打回 undefined，
  // 界面上就变成一组「不受控」的开关。
  const next: Prefs = { ...cur, ...patch, notify: { ...cur.notify, ...(patch.notify || {}) } }
  cache = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* 隐私模式下写不了，内存里仍然有效 */ }
  for (const fn of listeners) fn(next)
}

/** 订阅偏好变化。同一标签页内即时生效（不需要刷新页面）。 */
export function usePrefs(): [Prefs, (patch: Partial<Prefs>) => void] {
  const [prefs, setLocal] = useState<Prefs>(getPrefs)
  useEffect(() => {
    const fn = (p: Prefs) => setLocal(p)
    listeners.add(fn)
    // 别的标签页改了也要跟上
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) setLocal(read()) }
    window.addEventListener('storage', onStorage)
    return () => { listeners.delete(fn); window.removeEventListener('storage', onStorage) }
  }, [])
  const patch = useCallback((p: Partial<Prefs>) => setPrefs(p), [])
  return [prefs, patch]
}
