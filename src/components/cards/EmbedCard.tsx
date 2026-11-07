import { useState } from 'react'
import { CardShell, MiniBtn, SyncInput } from './common'
import type { CardProps } from './types'

export interface EmbedInfo {
  /** iframe 的 src；null = 该服务没有可嵌入的地址（会退化成占位框 + 链接） */
  src: string | null
  link: string
  label: string
}

export interface EmbedProvider {
  id: string
  icon: string
  name: string
  hint: string
  example: string
  /** 如实说明这个服务能不能被嵌进来 */
  note: string
  parse: (url: string) => EmbedInfo | null
}

export interface EmbedData {
  url?: string
}

/** 第三方服务嵌入卡片：填 URL → 真实 iframe（拿不到 iframe 就退化成带链接的占位框） */
export function EmbedCardBase({
  data,
  onChange,
  readOnly,
  provider,
}: {
  data: EmbedData
  onChange: (patch: Partial<EmbedData>) => void
  readOnly?: boolean
  provider: EmbedProvider
}) {
  const url = (data?.url || '').trim()
  const info = url ? provider.parse(url) : null
  const [loaded, setLoaded] = useState(false)

  return (
    <CardShell
      icon={provider.icon}
      title={`嵌入${provider.name}`}
      desc={info ? `将嵌入 ${info.label}` : url ? '链接无法解析' : '待填链接'}
    >
      <div className="yq-kc-note is-info">
        <span>🌐</span>
        <span>{provider.note}</span>
      </div>
      <div className="yq-kc-row">
        <SyncInput
          className="yq-kc-input"
          value={url}
          readOnly={readOnly}
          placeholder={provider.hint}
          onCommit={(v) => { setLoaded(false); onChange({ url: v }) }}
        />
        {!readOnly && url && !info && <MiniBtn onClick={() => onChange({ url: '' })}>清除</MiniBtn>}
      </div>
      {url && !info && (
        <div className="yq-kc-note is-error" style={{ marginTop: 8 }}>
          <span>⚠️</span>
          <span>
            没从这个链接里解析出嵌入地址。试试标准分享链接，例如
            <code style={{ margin: '0 4px' }}>{provider.example}</code>
          </span>
        </div>
      )}
      {info && (
        <>
          <div className="yq-kc-embed-frame" style={{ marginTop: 8 }}>
            {info.src && (
              <iframe
                src={info.src}
                title={info.label}
                allowFullScreen
                referrerPolicy="no-referrer"
                onLoad={() => setLoaded(true)}
              />
            )}
            {(!info.src || !loaded) && (
              <div className="yq-kc-embed-fallback">
                <span style={{ fontSize: 20 }}>{provider.icon}</span>
                <span>将嵌入 {info.label}</span>
                {info.src ? <span>{loaded ? '正在加载…' : '正在向该服务请求内容（需要联网）'}</span> : <span>该服务没有提供可嵌入的地址</span>}
                <a href={info.link} target="_blank" rel="noreferrer">在新标签打开原文 ↗</a>
              </div>
            )}
          </div>
          <div className="yq-kc-hint" style={{ marginTop: 6 }}>
            来源：{info.link}
          </div>
        </>
      )}
    </CardShell>
  )
}
