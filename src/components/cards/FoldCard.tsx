import { CardShell, MiniBtn, SyncInput, SyncTextarea, useCardDefaults } from './common'
import type { CardProps } from './types'

interface FoldData {
  title?: string
  open?: boolean
  text?: string
}

/** 折叠块：标题可编辑，可展开/收起，里面是一个普通段落 */
export default function FoldCard({ data, onChange, readOnly }: CardProps<FoldData>) {
  useCardDefaults(data, onChange, { title: '折叠内容', open: true, text: '' })
  const d = data || {}
  const open = d.open !== false
  return (
    <CardShell
      icon="🗜"
      title="折叠块"
      tone="flat"
      actions={
        <>
          <MiniBtn active={open} onClick={() => onChange({ open: !open })}>
            {open ? '收起' : '展开'}
          </MiniBtn>
          {!readOnly && <MiniBtn onClick={() => onChange({ title: '折叠内容', text: '在这里输入内容' })}>重置</MiniBtn>}
        </>
      }
    >
      <div className={`yq-kc-fold ${open ? 'is-open' : ''}`}>
        <div className="yq-kc-fold-head" onClick={() => onChange({ open: !open })}>
          <span className="yq-kc-fold-caret">▶</span>
          <SyncInput
            className="yq-kc-fold-title"
            value={d.title ?? '折叠内容'}
            readOnly={readOnly}
            placeholder="折叠标题"
            onClick={(e) => e.stopPropagation()}
            onCommit={(v) => onChange({ title: v })}
          />
        </div>
        {open && (
          <div className="yq-kc-fold-body">
            <SyncTextarea
              className="yq-kc-textarea"
              value={d.text ?? ''}
              readOnly={readOnly}
              rows={2}
              placeholder="折叠里的段落内容"
              onCommit={(v) => onChange({ text: v })}
            />
          </div>
        )}
      </div>
    </CardShell>
  )
}
