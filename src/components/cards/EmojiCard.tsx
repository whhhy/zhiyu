import { useStore } from '@/store'
import { CardShell, MiniBtn, useCardDefaults } from './common'
import type { CardProps } from './types'

interface EmojiData {
  used?: string[]
}

const CATS: [string, string[]][] = [
  ['表情', ['😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘', '😗', '😚', '😙', '😋', '😛', '😜', '🤪', '😝', '🤑', '🤗', '🤭', '🤔', '🤐', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬', '😴', '😪', '😵', '🥱', '😷', '🤒', '🤕', '🤢', '🤮', '🥵', '🥶', '😎', '🤓', '🧐', '😕', '😟', '🙁', '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖', '😣', '😞', '😓', '😩', '😫', '😤', '😡', '😠', '🤬', '💀', '👻', '💩', '🤡']],
  ['手势', ['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '👋', '🤚', '🖐', '✋', '🖖', '👏', '🙌', '🤝', '🙏', '💪', '🦾', '✍️', '💅', '🤳']],
  ['物品', ['🔥', '⭐', '✨', '⚡', '💥', '💯', '🎉', '🎊', '🎁', '🏆', '🥇', '🥈', '🥉', '⚽', '🏀', '🏈', '🎮', '🎧', '🎸', '📷', '💻', '📱', '⌨️', '🖥', '📚', '📝', '📌', '📎', '🔑', '🔒', '🔓', '🔍', '💡', '🔔', '⏰', '📅', '📊', '📈', '📉', '🗂', '📁', '🧭', '💰', '💎', '🧪', '🔧', '⚙️', '🧩', '🎯', '🚀', '✈️', '🚗', '🏠', '🌈', '☀️', '🌙', '⛈', '❄️']],
  ['符号', ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '❗', '❓', '💯', '✅', '❌', '⭕', '❌', '🚫', '⚠️', '🔔', '♻️', '🔗', '💬', '🗯', '🕘', '🅰', '🅱', '🔝', '🔙', '➕', '➖', '➗', '✖', '♾', '⚡', '🔔', '💤', '🆗', '🆕', '🆓', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣']],
]

/** 找到当前可插入文本的光标宿主（contentEditable / textarea / 文本 input） */
function caretHost(): HTMLElement | null {
  const ae = document.activeElement as HTMLElement | null
  if (!ae) return null
  if (ae.isContentEditable) return ae
  if (ae.tagName === 'TEXTAREA') return ae
  if (ae.tagName === 'INPUT' && ['text', 'search', 'url', ''].includes((ae as HTMLInputElement).type)) return ae
  return null
}

/** 表情卡片：点选插入到当前光标处（execCommand insertText，兼容中文输入法） */
export default function EmojiCard({ data, onChange, readOnly }: CardProps<EmojiData>) {
  useCardDefaults(data, onChange, { used: [] })
  const used = data?.used ?? []

  const pick = (e: string) => {
    const host = caretHost()
    if (host) {
      host.focus()
      document.execCommand('insertText', false, e)
    } else {
      useStore.getState().toast('请先把光标点进正文或输入框，再选表情', 'info')
    }
    onChange({ used: [e, ...used.filter((x) => x !== e)].slice(0, 8) })
  }

  return (
    <CardShell icon="😀" title="表情" desc="点一下插到光标处" actions={
      used.length ? <MiniBtn onClick={() => onChange({ used: [] })}>清空记录</MiniBtn> : null
    }>
      {used.length > 0 && (
        <div className="yq-kc-emoji-used">
          <span className="yq-kc-emoji-used-label">最近：</span>
          {used.map((e) => (
            <button key={e} className="yq-kc-emoji-btn" onClick={() => pick(e)} title={e}>{e}</button>
          ))}
        </div>
      )}
      {CATS.map(([name, list]) => (
        <div key={name}>
          <div className="yq-kc-emoji-cat">{name}</div>
          <div className="yq-kc-emoji-grid">
            {list.map((e) => (
              <button key={e} className="yq-kc-emoji-btn" onClick={() => pick(e)} title={e} disabled={readOnly}>
                {e}
              </button>
            ))}
          </div>
        </div>
      ))}
    </CardShell>
  )
}
