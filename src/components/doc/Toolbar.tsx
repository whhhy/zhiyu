import { useState, useRef, useEffect, useMemo } from 'react'
import { Dropdown, MenuItem, MenuDivider, MenuLabel, Popover, Tooltip, IconButton } from '@/components/ui'
import { useStore } from '@/store'
import { BLOCK_META } from './Editor'
import { YUQUE_CARDS, CARD_GROUPS } from '@/data/cards'
import type { Block } from '@/types'
import './index.css'

/* ============================================================
   文档工具栏 —— 语雀：字体 / 字号 / 对齐 / 颜色 / 列表 / 插入卡片
   ============================================================ */

const FONTS = [
  { value: '', label: '默认' },
  { value: 'PingFang SC', label: '苹方' },
  { value: 'Microsoft YaHei', label: '微软雅黑' },
  { value: 'SimSun', label: '宋体' },
  { value: 'KaiTi', label: '楷体' },
  { value: 'Georgia', label: 'Georgia' },
  { value: 'monospace', label: '等宽' },
]

const SIZES = [
  { value: '13px', label: '小' },
  { value: '15px', label: '标准' },
  { value: '17px', label: '中' },
  { value: '20px', label: '大' },
  { value: '24px', label: '特大' },
]

const COLORS = [
  '', '#e34d59', '#e9703e', '#e8a33d', '#46b160', '#0a7cff', '#a349a4', '#1f2329', '#8a9099',
]

interface ToolbarProps {
  onFormat: (cmd: string, value?: string) => void
  onBlockType: (t: Block['type']) => void
  activeBlockType: Block['type']
  onInsert: (cardId: string) => void
  onSave: () => void
  saved: boolean
  readOnly?: boolean
  /** 当前文档 id —— 「链接到文档」里要把自己排除掉 */
  currentDocId?: string
}

export default function Toolbar({ onFormat, onBlockType, activeBlockType, onInsert, onSave, saved, readOnly, currentDocId }: ToolbarProps) {
  const [state, setState] = useState<Record<string, boolean>>({})
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [docQ, setDocQ] = useState('')
  const [openId, setOpenId] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { docs } = useStore() as any
  /**
   * 「链接到文档」的下拉只列当前知识库里的文档。
   * 跨库链接在语义上就不成立 —— 被链到的人可能对那个库一点权限都没有，
   * 点过去就是一个 403，比死链还让人困惑。
   */
  const docList = useMemo(() => {
    const all: any[] = Array.isArray(docs) ? docs : []
    const q = docQ.trim().toLowerCase()
    return all
      .filter((d) => d.id !== currentDocId)
      .filter((d) => (q ? String(d.title || '').toLowerCase().includes(q) : true))
      .slice(0, 40)
  }, [docs, docQ, currentDocId])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const exec = (cmd: string, value?: string) => {
    onFormat(cmd, value)
    // 同步激活态
    setState((s) => ({ ...s, [cmd]: !s[cmd] }))
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState({}), 1200)
  }

  const Btn = ({
    cmd,
    title,
    children,
    active,
    disabled,
  }: {
    cmd?: string
    title: string
    children: React.ReactNode
    active?: boolean
    disabled?: boolean
  }) => (
    <Tooltip title={title} placement="bottom">
      <button
        className={`yq-tb-btn ${active ?? (cmd ? state[cmd] : false) ? 'is-active' : ''} ${disabled ? 'is-disabled' : ''}`}
        disabled={disabled}
        onMouseDown={(e) => {
          if (cmd && !disabled) {
            e.preventDefault()
            exec(cmd)
          }
        }}
      >
        {children}
      </button>
    </Tooltip>
  )

  /**
   * 标题块本身字重就是 600/700。
   * 浏览器的 queryCommandState('bold') 把「非 normal 字重」都算作已加粗，
   * 于是 toggle 会变成「取消加粗」，反而把 600 降级成 normal，字看起来更细。
   * 语雀的做法是：标题块里加粗按钮置灰。
   */
  const isHeading = ['h1', 'h2', 'h3', 'h4'].includes(activeBlockType)

  if (readOnly) {
    return (
      <div className="yq-toolbar yq-toolbar-ro">
        <span className="yq-tb-readonly">只读模式</span>
        <div className="yq-flex-1" />
        <span className="yq-tb-saved">已发布</span>
      </div>
    )
  }

  return (
    <div className="yq-toolbar">
      {/* 块类型 */}
      <Dropdown
        align="left"
        width={168}
        trigger={(open, toggle) => (
          <button className="yq-tb-blocktype" onClick={toggle}>
            <span className="yq-tb-blocktype-icon">{BLOCK_META[activeBlockType]?.icon ?? '¶'}</span>
            <span className="yq-tb-blocktype-label">{BLOCK_META[activeBlockType]?.label ?? '正文'}</span>
            <span className="yq-tb-caret">▾</span>
          </button>
        )}
      >
        {(close) => (
          <>
            {['基础', '扩展', '媒体'].map((g) => (
              <div key={g}>
                <MenuLabel>{g}</MenuLabel>
                {(Object.keys(BLOCK_META) as Block['type'][])
                  .filter((t) => BLOCK_META[t].group === g)
                  .map((t) => (
                    <MenuItem
                      key={t}
                      icon={BLOCK_META[t].icon}
                      trailing={activeBlockType === t ? '✓' : undefined}
                      onClick={() => { onBlockType(t); close() }}
                    >
                      {BLOCK_META[t].label}
                    </MenuItem>
                  ))}
              </div>
            ))}
          </>
        )}
      </Dropdown>

      <span className="yq-tb-divider" />

      {/* 字体 */}
      <Popover
        align="left"
        width={132}
        trigger={(open, toggle) => (
          <button className="yq-tb-select" onClick={toggle}>
            字体 <span className="yq-tb-caret">▾</span>
          </button>
        )}
      >
        {(close) =>
          FONTS.map((f) => (
            <button
              key={f.value}
              className="yq-tb-select-item"
              style={{ fontFamily: f.value || undefined }}
              onClick={() => { onFormat('fontName', f.value); close() }}
            >
              {f.label}
            </button>
          ))
        }
      </Popover>

      {/* 字号 */}
      <Popover
        align="left"
        width={96}
        trigger={(open, toggle) => (
          <button className="yq-tb-select" onClick={toggle}>
            字号 <span className="yq-tb-caret">▾</span>
          </button>
        )}
      >
        {(close) =>
          SIZES.map((s) => (
            <button
              key={s.value}
              className="yq-tb-select-item"
              onClick={() => { onFormat('fontSize', s.value); close() }}
            >
              {s.label}
            </button>
          ))
        }
      </Popover>

      <span className="yq-tb-divider" />

      {/* 基础格式 */}
      <Btn
        cmd="bold"
        disabled={isHeading}
        title={isHeading ? '标题块本身已加粗' : '加粗 Ctrl+B'}
      ><b>B</b></Btn>
      <Btn cmd="italic" title="斜体 Ctrl+I"><i>I</i></Btn>
      <Btn cmd="underline" title="下划线 Ctrl+U"><u>U</u></Btn>
      <Btn cmd="strikeThrough" title="删除线"><s>S</s></Btn>

      <Popover
        align="left"
        width={128}
        trigger={(open, toggle) => (
          /* 用 Tooltip 而不是原生 title：原生那个要悬停一秒才弹、样式也不统一，
             和左右两边的 B / I / U 放在一起像是两种东西。 */
          <Tooltip title="文字颜色" placement="bottom">
            <button className="yq-tb-btn" onClick={toggle}>
              <span className="yq-tb-color-underline" style={{ background: '#1f2329' }}>A</span>
            </button>
          </Tooltip>
        )}
      >
        {(close) => (
          <div className="yq-tb-colors">
            {COLORS.map((c) => (
              <button
                key={c || 'reset'}
                className="yq-tb-color"
                style={{ background: c || 'transparent', border: c ? undefined : '1px dashed var(--yq-border-3)' }}
                title={c || '默认'}
                onClick={() => { onFormat('foreColor', c || '#1f2329'); close() }}
              />
            ))}
          </div>
        )}
      </Popover>

      <Popover
        align="left"
        width={128}
        trigger={(open, toggle) => (
          <Tooltip title="背景色" placement="bottom">
            <button className="yq-tb-btn" onClick={toggle}>
              <span className="yq-tb-color-underline" style={{ background: '#fff3a3' }}>A</span>
            </button>
          </Tooltip>
        )}
      >
        {(close) => (
          <div className="yq-tb-colors">
            {['#fff3a3', '#d4edda', '#d1ecf0', '#f8d7da', '#e2e3e5', '#ffffff'].map((c) => (
              <button
                key={c}
                className="yq-tb-color"
                style={{ background: c, border: '1px solid var(--yq-border-1)' }}
                onClick={() => { onFormat('hiliteColor', c); close() }}
              />
            ))}
          </div>
        )}
      </Popover>

      <span className="yq-tb-divider" />

      {/* 列表 */}
      <Btn cmd="insertUnorderedList" title="无序列表"><span className="yq-tb-list">•</span></Btn>
      <Btn cmd="insertOrderedList" title="有序列表"><span className="yq-tb-list">1.</span></Btn>
      <Btn cmd="outdent" title="减少缩进">⇤</Btn>
      <Btn cmd="indent" title="增加缩进">⇥</Btn>

      <span className="yq-tb-divider" />

      {/* 对齐 */}
      <Btn cmd="justifyLeft" title="左对齐">⇤</Btn>
      <Btn cmd="justifyCenter" title="居中">↔</Btn>
      <Btn cmd="justifyRight" title="右对齐">⇥</Btn>

      <span className="yq-tb-divider" />

      {/* 链接 */}
      <Popover
        align="left"
        width={280}
        trigger={(open, toggle) => (
          <Tooltip title="插入链接" placement="bottom">
            <button className="yq-tb-btn" onClick={() => { toggle(); setLinkOpen(open) }}>
              🔗
            </button>
          </Tooltip>
        )}
      >
        {(close) => (
          <div className="yq-tb-link">
            <input
              placeholder="粘贴链接地址"
              value={linkUrl}
              onChange={(e) => setLinkUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && linkUrl) {
                  onFormat('createLink', linkUrl)
                  setLinkUrl('')
                  close()
                }
              }}
              autoFocus
            />
            <button
              className="yq-tb-link-ok"
              onClick={() => {
                if (linkUrl) { onFormat('createLink', linkUrl); setLinkUrl(''); close() }
              }}
            >
              确定
            </button>
          </div>
        )}
      </Popover>

      <Btn cmd="removeFormat" title="清除格式">⌫</Btn>

      <span className="yq-tb-divider" />

      {/* 链接到本文档库里的另一篇。
          语雀的做法是「插入文档块 / 章节链接」，能从站内挑，不用去地址栏复制。
          没有这个入口时唯一的办法是手贴 URL，而手贴的 URL 拼错了
          界面不会有任何提示，只是一条点不开的死链。

          章节展开有个**如实降级**：轻量启动之后正文是按需拉的，
          没打开过的文档手上没有 blocks，就没有章节可列 ——
          这时只给文档级链接，而不是先去把全文拉下来再列（那会让「点开一个选择器」
          变成一次全量网络请求）。打开过的那篇就有章节。 */}
      <Popover
        trigger={(open, toggle) => (
          <Tooltip title="链接到文档" placement="bottom">
            <button className="yq-tb-icon" onClick={toggle}>📎</button>
          </Tooltip>
        )}
      >
        {(close) => (
          <div className="yq-tb-doclink">
            <input
              className="yq-tb-doclink-q"
              placeholder="搜文档，插入站内链接"
              value={docQ}
              onChange={(e) => setDocQ(e.target.value)}
              autoFocus
            />
            {docList.length === 0 && <div className="yq-tb-doclink-empty">没有匹配的文档</div>}
            {docList.map((d: any) => {
              const open = openId === d.id
              // 只列标题块：章节链接指向的就是标题
              const heads: any[] = ((d.blocks || []) as any[])
                .filter((b: any) => b && /^h[1-6]$/.test(String(b.type)) && b.text)
                .slice(0, 30)
              return (
                <div key={d.id} className="yq-tb-doclink-row">
                  <div className="yq-tb-doclink-rowmain">
                    <button
                      className="yq-tb-doclink-item"
                      /* mousedown 要拦：不然输入框先失焦，弹层就跟着关了，点不到条目 */
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        onFormat('createLink', `#/book/${d.bookId}/doc/${d.id}`)
                        setDocQ('')
                        close()
                      }}
                    >
                      <span className="yq-tb-doclink-icon">📄</span>
                      <span className="yq-tb-doclink-title">{d.title || '（无标题）'}</span>
                    </button>
                    {heads.length > 0 && (
                      <button
                        className="yq-tb-doclink-expand"
                        title={open ? '收起章节' : '链到具体章节'}
                        aria-expanded={open}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setOpenId(open ? '' : d.id)}
                      >
                        {open ? '▾' : '▸'}
                      </button>
                    )}
                  </div>
                  {open && heads.map((b) => (
                    <button
                      key={b.id}
                      className="yq-tb-doclink-head"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        // 锚点用块 id：大纲、划词定位、「查看该位置」已经在用同一套
                        onFormat('createLink', `#/book/${d.bookId}/doc/${d.id}#${b.id}`)
                        setDocQ('')
                        setOpenId('')
                        close()
                      }}
                    >
                      <span className={'yq-tb-doclink-hl yq-tb-doclink-h' + b.type}>{'#'.repeat(Number(String(b.type).slice(1)))}</span>
                      <span className="yq-tb-doclink-title">{String(b.text).slice(0, 60)}</span>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        )}
      </Popover>

      {/* 插入卡片 —— 语雀 40+ 特色卡片 */}
      <Dropdown
        align="left"
        width={300}
        trigger={(open, toggle) => (
          <button className="yq-tb-insert" onClick={toggle}>
            <span className="yq-tb-insert-plus">+</span>
            <span>插入</span>
            <span className="yq-tb-caret">▾</span>
          </button>
        )}
      >
        {(close) => (
          <div className="yq-tb-cards">
            {CARD_GROUPS.map((g) => {
              const items = YUQUE_CARDS.filter((c) => c.group === g)
              if (!items.length) return null
              return (
                <div key={g} className="yq-tb-cards-group">
                  <div className="yq-tb-cards-label">{g}</div>
                  <div className="yq-tb-cards-grid">
                    {items.map((c) => (
                      <button
                        key={c.id}
                        className="yq-tb-cards-item"
                        onClick={() => { onInsert(c.id); close() }}
                      >
                        <span className="yq-tb-cards-icon">{c.icon}</span>
                        <span className="yq-ellipsis">{c.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Dropdown>

      <div className="yq-flex-1" />

      <span className={`yq-tb-save ${saved ? 'is-saved' : ''}`}>
        {saved ? '✓ 已保存' : '保存中…'}
      </span>
    </div>
  )
}
