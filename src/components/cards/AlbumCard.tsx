import { useState } from 'react'
import { CardShell, FilePicker, MiniBtn, checkCapacity, readFileAsDataUrl, uid, useCardDefaults } from './common'
import { Modal } from '@/components/ui'
import type { CardProps } from './types'

interface AlbumItem {
  id: string
  url: string
  caption: string
  /** 本地文件读进来的，标记一下方便提示体积 */
  local?: boolean
}
interface AlbumData {
  items?: AlbumItem[]
  err?: string
}

/** 画册卡片：图片九宫格，文件读成 data URL / 或直接贴图床地址 */
export default function AlbumCard({ data, onChange, readOnly }: CardProps<AlbumData>) {
  useCardDefaults(data, onChange, { items: [] })
  const items = data?.items ?? []
  const [url, setUrl] = useState('')
  const [zoom, setZoom] = useState<AlbumItem | null>(null)
  const [busy, setBusy] = useState(false)

  const set = (next: AlbumItem[]) => onChange({ items: next })

  const addFile = async (file: File) => {
    setBusy(true)
    try {
      const u = await readFileAsDataUrl(file)
      const cap = checkCapacity(u)
      if (!cap.ok) {
        onChange({ err: cap.message })
        return
      }
      // 一次事件里只能调一次 onChange：它是对 block.data 的浅合并，
      // 连着调两次第二次会拿同一份旧 data 覆盖掉第一次的结果（图就没了）
      onChange({ items: [...items, { id: uid('im'), url: u, caption: file.name, local: true }], err: '' })
    } catch {
      onChange({ err: '读取图片失败' })
    } finally {
      setBusy(false)
    }
  }
  const addUrl = () => {
    const v = url.trim()
    if (!v) return
    onChange({ items: [...items, { id: uid('im'), url: v, caption: '' }] })
    setUrl('')
  }

  return (
    <CardShell icon="📔" title="画册" desc={`${items.length} 张`}>
      {data?.err && <div className="yq-kc-note is-error"><span>⚠️</span><span>{data.err}</span></div>}
      <div className={`yq-kc-album ${items.length ? '' : 'is-empty'}`}>
        {items.map((it) => (
          <div className="yq-kc-album-item" key={it.id}>
            <img src={it.url} alt={it.caption} onClick={() => setZoom(it)} style={{ cursor: 'zoom-in' }} />
            <input
              defaultValue={it.caption}
              readOnly={readOnly}
              placeholder="说明"
              onChange={(e) => set(items.map((x) => (x.id === it.id ? { ...x, caption: e.target.value } : x)))}
            />
            {!readOnly && (
              <button className="yq-kc-album-del" onClick={() => set(items.filter((x) => x.id !== it.id))} title="移除">
                ✕
              </button>
            )}
          </div>
        ))}
        {!readOnly && (
          <span className="yq-kc-album-add">
            <FilePicker accept="image/*" onFile={addFile} readOnly={readOnly} label={busy ? '读取中…' : '＋ 本地图片'} />
          </span>
        )}
      </div>
      {!readOnly && (
        <div className="yq-kc-row" style={{ marginTop: 8 }}>
          <input
            className="yq-kc-input"
            value={url}
            placeholder="或粘贴图片地址 https://…"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addUrl()}
          />
          <MiniBtn onClick={addUrl}>添加</MiniBtn>
        </div>
      )}
      {items.length === 0 && !readOnly && <div className="yq-kc-hint" style={{ marginTop: 6 }}>还没有图片。本地图片会转成 base64 存进文档，注意 4MB 限制；大图建议用图床地址。</div>}
      <Modal open={!!zoom} onClose={() => setZoom(null)} title={zoom?.caption || '预览'} width={640}>
        {zoom && <img src={zoom.url} alt={zoom.caption} style={{ width: '100%' }} />}
      </Modal>
    </CardShell>
  )
}
