import { useState, type ReactNode } from 'react'
import {
  ATTACHMENT_HINT, CardShell, FilePicker, MiniBtn, attachFileToDoc, detachAttachment,
  emptyAttachmentPatch, formatBytes, releaseAttachment, storageUsedBytes, useAttachmentUrl,
} from './common'
import { useStore } from '@/store'
import { useServer } from '@/lib/attachment-store'
import type { CardProps } from './types'

export interface LocalData {
  name?: string
  size?: number
  type?: string
  /** IndexedDB 内容指纹：二进制本体在 IndexedDB，不在文档里 */
  key?: string
  /** 仅降级路径（IndexedDB 不可用）才有：二进制被内联成 data URL */
  dataUrl?: string
  lastModified?: number
  at?: number
  stored?: boolean
  /** 降级原因，UI 上如实显示 */
  degraded?: string
  risky?: boolean
  error?: string
}

const MAX_HINT = ATTACHMENT_HINT

/**
 * 「嵌入本地文件」三张卡（本地文件 / 本地音频 / 本地视频）的共用实现。
 * 差异只在渲染方式：文档预览框 / audio 播放器 / video 播放器。
 *
 * 存法与附件卡一致：二进制进 IndexedDB，block.data 只留元信息；
 * 刷新后按 key 取回 Blob 生成 objectURL 再交给 render 渲染。
 * render 拿到的 data 里 dataUrl 已经是**可用的 URL**（blob: 或降级的 data:），
 * 所以三张卡自己不用关心二进制到底存在哪儿。
 */
export function LocalMediaBase({
  data,
  onChange,
  readOnly,
  icon,
  title,
  desc,
  accept,
  render,
  emptyHint,
}: {
  data: LocalData
  onChange: (patch: Partial<LocalData>) => void
  readOnly?: boolean
  icon: string
  title: string
  desc: string
  accept: string
  render: (d: LocalData) => ReactNode
  emptyHint: string
}) {
  const [busy, setBusy] = useState(false)
  const [delErr, setDelErr] = useState('')
  const [delNote, setDelNote] = useState('')
  // 同 FileCard：判据统一从 attachment-store 取，别各处抄一遍
  const serverMode = useServer()
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

  const clear = async () => {
    setBusy(true)
    setDelErr('')
    setDelNote('')
    try {
      // 同 FileCard：先删二进制再清卡片，删不掉就把原因还给用户
      const { err, keptFor } = await detachAttachment(
        useStore.getState().docs, d.key, () => onChange(emptyAttachmentPatch()),
      )
      if (err) setDelErr(err)
      else if (keptFor) setDelNote(`这份文件还被 ${keptFor} 篇文档引用，已保留文件（只撤掉了本文档里的引用）`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <CardShell
      icon={icon}
      title={title}
      desc={desc}
      actions={
        has && !readOnly ? (
          <>
            <FilePicker accept={accept} onFile={(f) => attach(f)} readOnly={readOnly} label="替换" />
            <MiniBtn danger onClick={clear}>清空</MiniBtn>
          </>
        ) : null
      }
    >
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
      {d.error && !d.degraded && (
        <div className="yq-kc-note is-error">
          <span>⚠️</span>
          <span>{d.error}</span>
        </div>
      )}
      {d.risky && !d.error && !d.degraded && (
        <div className="yq-kc-note is-warn"><span>⚠️</span><span>正文额度吃紧，写盘可能失败，建议先清理旧内容。</span></div>
      )}
      {!has ? (
        <div className="yq-kc-file-empty">
          {busy ? (
            <span>正在读取…</span>
          ) : (
            <>
              <div style={{ marginBottom: 8 }}>{emptyHint}</div>
              <FilePicker accept={accept} onFile={(f) => attach(f)} readOnly={readOnly} label="选择文件" />
            </>
          )}
          <div className="yq-kc-hint" style={{ marginTop: 8 }}>{MAX_HINT}</div>
        </div>
      ) : (
        <>
          {state === 'missing' && (
            <div className="yq-kc-note is-error">
              <span>⚠️</span>
              <span>
            附件二进制已丢失（key：{d.key}）。
            {serverMode
              ? '它存在服务端数据库里，通常是数据库被换过、或者这份数据是从别处迁来的。'
              : '可能清过浏览器数据，请重新选择文件。'}
          </span>
            </div>
          )}
          {state !== 'missing' && render({ ...d, dataUrl: url })}
          <div className="yq-kc-file" style={{ marginTop: 8 }}>
            <span className="yq-kc-file-icon">{icon}</span>
            <span className="yq-kc-file-main">
              <span className="yq-kc-file-name">{d.name}</span>
              <span className="yq-kc-file-meta">{d.type || '未知类型'} · {formatBytes(d.size || 0)}</span>
              <span className="yq-kc-file-meta">
                {d.key ? `⚡ 二进制在${serverMode ? '服务端数据库' : ' IndexedDB'}（${d.key.slice(0, 16)}…）· 正文只占元信息` : '📦 二进制内联在文档数据里'}
              </span>
            </span>
            <span className="yq-kc-file-actions">
              {state === 'ready' ? (
                <a className="yq-kc-btn" href={url} download={d.name}>⬇ 下载</a>
              ) : (
                <span className="yq-kc-hint">{state === 'loading' ? '读取中…' : '不可下载'}</span>
              )}
            </span>
          </div>
        </>
      )}
    </CardShell>
  )
}
