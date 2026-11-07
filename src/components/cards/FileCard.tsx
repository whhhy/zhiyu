import { useState } from 'react'
import {
  ATTACHMENT_HINT, CardShell, FilePicker, MiniBtn, attachFileToDoc, detachAttachment,
  emptyAttachmentPatch, formatBytes, releaseAttachment, storageUsedBytes, useAttachmentUrl,
} from './common'
import { useStore } from '@/store'
import { useServer } from '@/lib/attachment-store'
import type { CardProps } from './types'

interface FileData {
  name?: string
  size?: number
  type?: string
  /** IndexedDB 里的内容指纹：二进制本体在 IndexedDB，不在文档里 */
  key?: string
  /** 仅降级路径（IndexedDB 不可用）才有：二进制被内联成 data URL */
  dataUrl?: string
  lastModified?: number
  at?: number
  /** 二进制确实进了 IndexedDB */
  stored?: boolean
  /** 降级原因：IDB 不可用 / 配额满，如实写进文档并显示 */
  degraded?: string
  /** 正文额度吃紧 */
  risky?: boolean
  error?: string
}

const humanType = (t: string) => {
  if (!t) return '未知类型'
  if (t.startsWith('image/')) return '图片'
  if (t.startsWith('video/')) return '视频'
  if (t.startsWith('audio/')) return '音频'
  if (t.startsWith('text/')) return '文本'
  if (t.includes('pdf')) return 'PDF'
  if (t.includes('sheet') || t.includes('excel')) return '表格'
  if (t.includes('word') || t.includes('document')) return '文档'
  if (t.includes('zip') || t.includes('rar') || t.includes('compressed')) return '压缩包'
  return t
}

/**
 * 附件卡片。
 *
 * 存法：二进制进 IndexedDB，Block.data 里只留
 * `{ name, size, type, key, lastModified }` —— 正文那 4MB 额度只管文字，
 * 插多大的图都不会把文档撑爆。刷新后凭 key 取回 Blob 生成 objectURL 渲染。
 * IndexedDB 不可用时降级成原来的 data URL 方案，并在卡片上写明降级原因。
 */
export default function FileCard({ data, onChange, readOnly }: CardProps<FileData>) {
  /*
   * 二进制到底在哪儿，取决于运行形态：
   *   · 本地模式 → 浏览器 IndexedDB
   *   · 服务端   → SQLite 的 attachments 表（BLOB）
   * 本项目**主推内网服务端部署**，而这段文案原来一律写「在 IndexedDB」——
   * 于是部署之后每张附件卡都在说假话。清浏览器数据也不会让附件真的丢
   * （它在库里），所以「可能清过浏览器数据」同样是把人引向错误的排查方向。
   */
  // 判据统一从 attachment-store 取，别在这个文件里再抄一遍
  const serverMode = useServer()
  const where = useServer() ? '服务端数据库' : ' IndexedDB'
  const [busy, setBusy] = useState(false)
  const [delErr, setDelErr] = useState('')
  const [delNote, setDelNote] = useState('')
  const d = data || {}
  const has = !!(d.key || d.dataUrl)
  const { url, state } = useAttachmentUrl(d.key, d.dataUrl)

  const attach = async (file: File, force = false) => {
    setBusy(true)
    try {
      const prev = d.key
      const patch = await attachFileToDoc(file, force)
      onChange(patch)
      // 换源：旧的那份没人引用了就回收掉（同一个文件重选时 key 不变，别误删）
      if (prev && prev !== patch.key) await releaseAttachment(useStore.getState().docs, prev)
    } finally {
      setBusy(false)
    }
  }

  const detach = async () => {
    setBusy(true)
    setDelErr('')
    setDelNote('')
    try {
      // 删不掉就留着卡片并把原因说出来 —— 不能让「看起来删了」和「真删了」脱节
      const { err, keptFor } = await detachAttachment(
        useStore.getState().docs, d.key, () => onChange(emptyAttachmentPatch()),
      )
      if (err) setDelErr(err)
      else if (keptFor) setDelNote(`这份文件还被 ${keptFor} 篇文档引用，已保留文件（只撤掉了本文档里的引用）`)
    } finally {
      setBusy(false)
    }
  }

  if (!has) {
    return (
      <CardShell icon="📎" title="附件" desc="文件会存进本文档，刷新后仍在">
        <div className="yq-kc-file-empty">
          {busy ? (
            <span>正在读取文件…</span>
          ) : (
            <>
              <div style={{ marginBottom: 8 }}>把文件选进来，二进制存{where}，文档里只留元信息</div>
              <FilePicker onFile={(f) => attach(f)} readOnly={readOnly} label="选择文件" />
            </>
          )}
        </div>
        {d.error && (
          <>
            <div className="yq-kc-note is-error" style={{ marginTop: 8, marginBottom: 0 }}>
              <span>⚠️</span>
              <span>{d.error}</span>
            </div>
            {d.name && (
              <div className="yq-kc-row" style={{ marginTop: 6 }}>
                <MiniBtn onClick={() => attach(new File([], d.name!))} title="用占位文件替换">
                  仍要插入空附件
                </MiniBtn>
                <span className="yq-kc-hint">建议先删掉一些旧内容或历史版本再试</span>
              </div>
            )}
          </>
        )}
        <div className="yq-kc-hint" style={{ marginTop: 8 }}>{ATTACHMENT_HINT}</div>
      </CardShell>
    )
  }

  const isImg = (d.type || '').startsWith('image/')
  return (
    <CardShell
      icon="📎"
      title="附件"
      actions={
        !readOnly ? (
          <>
            <FilePicker onFile={(f) => attach(f)} readOnly={readOnly} label="替换" />
            <MiniBtn danger onClick={detach}>删除</MiniBtn>
          </>
        ) : null
      }
    >
      {/* 降级必须如实说明：用户要知道自己这份文件没进 IndexedDB */}
      {delErr && (
        <div className="yq-kc-note is-error" style={{ marginBottom: 8 }}>
          <span>⚠️</span>
          <span>
            附件没删掉：{delErr} 二进制仍在库里，卡片先留着。
          </span>
        </div>
      )}
      {delNote && !delErr && (
        <div className="yq-kc-note is-warn" style={{ marginBottom: 8 }}>
          <span>ℹ️</span>
          <span>{delNote}</span>
        </div>
      )}
      {d.degraded && (
        <div className="yq-kc-note is-warn">
          <span>⚠️</span>
          <span>
            {d.degraded} 这份文件会占用正文额度（当前 {formatBytes(storageUsedBytes())}，上限约 4MB）。
          </span>
        </div>
      )}
      {d.risky && !d.degraded && (
        <div className="yq-kc-note is-warn">
          <span>⚠️</span>
          {/* 同样按形态说：服务端形态下「清旧内容」也没用 ——
              风险来自**正文**写不进 4MB 额度（二进制不在正文里），
              该做的是删旧正文，不是删浏览器数据。 */}
          <span>
            {d.error} 附件本身在{serverMode ? '服务端数据库' : ' IndexedDB'}，
            但**正文**写盘可能失败（正文有 4MB 额度），建议先清理旧的正文内容。
          </span>
        </div>
      )}
      {state === 'missing' && (
        <div className="yq-kc-note is-error">
          <span>⚠️</span>
          {/* 服务端形态下附件在数据库里 —— **清浏览器数据并不会让它丢**，
              所以原来那句「可能清过浏览器数据」在这里是误导，会把人引到错误的排查方向。 */}
          <span>
            附件二进制已丢失（key：{d.key}）。
            {serverMode
              ? '它存在服务端数据库里，通常是数据库被换过、或者这份数据是从别处迁来的。'
              : '可能清过浏览器数据，请重新选择文件。'}
          </span>
        </div>
      )}
      {isImg && state === 'ready' && (
        <img className="yq-kc-media" style={{ marginBottom: 8 }} src={url} alt={d.name} />
      )}
      <div className="yq-kc-file">
        <span className="yq-kc-file-icon">📄</span>
        <span className="yq-kc-file-main">
          <span className="yq-kc-file-name">{d.name}</span>
          <span className="yq-kc-file-meta">
            {humanType(d.type || '')} · {formatBytes(d.size || 0)}
            {d.at ? ` · ${new Date(d.at).toLocaleString('zh-CN')}` : ''}
          </span>
          <span className="yq-kc-file-meta">
            {d.key ? `⚡ 二进制在${serverMode ? '服务端数据库' : ' IndexedDB'}（${d.key.slice(0, 16)}…）· 正文只占元信息` : '📦 二进制内联在文档数据里'}
          </span>
        </span>
        <span className="yq-kc-file-actions">
          {state === 'ready' ? (
            <a className="yq-kc-btn" href={url} download={d.name} title="下载">
              ⬇ 下载
            </a>
          ) : (
            <span className="yq-kc-hint">{state === 'loading' ? '读取中…' : '不可下载'}</span>
          )}
        </span>
      </div>
    </CardShell>
  )
}
