import { CardShell, MiniBtn, SyncTextarea } from './common'
import { useStore } from '@/store'
import type { CardProps } from './types'
import { copyText } from '@/lib/clipboard'

interface EncData {
  text?: string
  cipher?: string
  pass?: string
}

/** UTF-8 安全的 Base64（中文/Emoji 不会变成乱码） */
function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  // 分块拼，避免大文本 spread 爆栈
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}
function b64decode(s: string): string {
  const bin = atob(s.replace(/\s+/g, ''))
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

/** 加密文本卡片：Base64 编码 + 解码。
 *  如实标注：Base64 是编码不是加密，任何人拿到密文都能解回来。 */
export default function EncryptedCard({ data, onChange, readOnly }: CardProps<EncData>) {
  const toast = useStore((s) => s.toast)
  const d = data || {}

  const encode = () => {
    if (!d.text) return
    onChange({ cipher: b64encode(d.text) })
  }
  const decode = () => {
    if (!d.cipher) return
    try {
      onChange({ text: b64decode(d.cipher) })
    } catch {
      toast('这段不是合法的 Base64，解不开', 'error')
    }
  }

  return (
    <CardShell
      icon="🔐"
      title="加密文本"
      desc="Base64 编解码"
      actions={
        !readOnly ? (
          <>
            <MiniBtn onClick={encode}>↓ 编码</MiniBtn>
            <MiniBtn onClick={decode}>↑ 解码</MiniBtn>
          </>
        ) : null
      }
    >
      <div className="yq-kc-note is-warn">
        <span>⚠️</span>
        <span>
          Base64 是<strong>编码</strong>不是加密 —— 任何拿到这段字符的人都能一键解回原文。
          真正的加密需要密钥（那种「加密文本」走的是服务端密钥，本项目没有密钥体系）。
        </span>
      </div>
      {/* 解码是「外部回填」，所以用 SyncTextarea：数据回来时输入框要真的变，
          用户自己打字时又不能被重置掉光标 */}
      <SyncTextarea
        className="yq-kc-textarea"
        value={d.text ?? ''}
        readOnly={readOnly}
        rows={3}
        placeholder="输入明文"
        onCommit={(v) => onChange({ text: v })}
      />
      <div className={`yq-kc-enc-out ${d.cipher ? '' : 'is-empty'}`} data-cipher={d.cipher ? '1' : '0'}>
        {d.cipher || '点「↓ 编码」生成密文'}
      </div>
      {d.cipher && !readOnly && (
        <div className="yq-kc-row" style={{ marginTop: 6 }}>
          <MiniBtn onClick={() => {
          /* 同「复制链接」那个坑：内网 HTTP 下 `navigator.clipboard?.writeText` 是空操作，
             而这里原来还会弹「密文已复制」—— 绿色提示配一个空的剪贴板。 */
          void copyText(d.cipher!).then((r) =>
            toast(r.ok ? '密文已复制' : `复制失败：${r.message}`, r.ok ? 'success' : 'error'))
        }}>复制密文</MiniBtn>
        </div>
      )}
    </CardShell>
  )
}
