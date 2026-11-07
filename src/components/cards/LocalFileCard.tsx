import { LocalMediaBase } from './LocalMedia'
import type { CardProps } from './types'
import type { LocalData } from './LocalMedia'

/** 本地文件：PDF 走内嵌预览，图片直接看，其它类型给下载 */
export default function LocalFileCard({ data, onChange, readOnly }: CardProps<LocalData>) {
  return (
    <LocalMediaBase
      data={data || {}}
      onChange={onChange}
      readOnly={readOnly}
      icon="📄"
      title="本地文件"
      desc={data?.name || '选一个本地文件'}
      accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.md,image/*"
      emptyHint="选择 Word / PDF / 图片 等文件，存成 data URL 写进文档"
      render={(d) => {
        const t = d.type || ''
        if (t.startsWith('image/')) return <img className="yq-kc-media" src={d.dataUrl} alt={d.name} />
        if (t === 'application/pdf' || /\.pdf$/i.test(d.name || ''))
          return <iframe className="yq-kc-media" title={d.name} src={d.dataUrl} />
        return (
          <div className="yq-kc-note is-info">
            <span>📎</span>
            <span>这个类型（{t || '未知'}）浏览器不能内嵌预览，用下面的下载按钮取走。</span>
          </div>
        )
      }}
    />
  )
}
