import { useEffect, useRef, useState } from 'react'
import type { CellKind, Doc, SheetCol, SheetData, SheetTab } from '@/types'
import { Dropdown, MenuDivider, MenuItem, MenuLabel, Segmented } from '@/components/ui'
import {
  activeTab, CELL_KINDS, COL_LETTERS, DT_STATUSES, PRIORITY_COLOR, STATUS_COLOR,
  sheetAddCol, sheetAddRow, sheetAddTab, sheetDuplicateTab, sheetRemoveCol, sheetRemoveRow,
  sheetRemoveTab, sheetRenameTab, sheetSetCell, sheetSwitch, sheetToMarkdown, sheetUpdateCol,
  useDocSection,
} from './sheetStore'
import './index.css'

/* ============================================================
   工作表（表格）视图
   语雀：进入卡片的独立编辑界面后，「整个正文输入会变成纯卡片操作」，
   顶部工具条也会切换成适合当前卡片的工具条。

   数据不再写死：唯一真相是 doc.sheetData.sheets，
   组件里只留「光标 / 正在改名」这类瞬时态。全屏态和正文内嵌态读的是同一份数据。
   ============================================================ */

export interface SheetViewProps {
  doc: Doc
  readOnly?: boolean
  onChange: (body: string) => void
  /** 是否处于卡片全屏独立编辑态（语雀：进全屏后正文退场） */
  fullscreen?: boolean
  onFullscreenChange?: (v: boolean) => void
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** 下拉列的选项编辑：菜单每次打开都是新挂载，这里用局部 state 接住正在输入的串 */
function ColKindMenu({ col, onPatch }: { col: SheetCol; onPatch: (p: Partial<SheetCol>) => void }) {
  const [opts, setOpts] = useState((col.opts || []).join('、'))
  return (
    <>
      <MenuLabel>列类型</MenuLabel>
      {CELL_KINDS.map((k) => (
        <MenuItem
          key={k.value}
          onClick={() =>
            onPatch(k.value === 'select' && !col.opts?.length ? { k: k.value, opts: [...DT_STATUSES] } : { k: k.value })
          }
        >
          {col.k === k.value ? '●' : '○'} {k.label}
        </MenuItem>
      ))}
      {col.k === 'select' && (
        <>
          <MenuDivider />
          <div className="yq-sheet-opts">
            <input
              value={opts}
              onChange={(e) => setOpts(e.target.value)}
              onBlur={() => onPatch({ opts: opts.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) })}
              placeholder="选项，用、分隔"
            />
          </div>
        </>
      )}
    </>
  )
}

/** 单个单元格：按列类型给不同的编辑器 */
function CellEditor({
  value, kind, opts, readOnly, color, onChange, onKeyDown, onActivate,
}: {
  value: string
  kind: CellKind
  opts?: string[]
  readOnly?: boolean
  /** 状态 / 优先级这类有语义色的列，用 token 着色 */
  color?: string
  onChange: (v: string) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onActivate: () => void
}) {
  const common = {
    value,
    readOnly,
    onKeyDown,
    onClick: onActivate,
    onFocus: onActivate,
    style: color ? { color, fontWeight: 500 } : undefined,
  }
  if (kind === 'select') {
    return (
      <select
        {...common}
        className="yq-sheet-select"
        onChange={(e) => { onActivate(); onChange(e.target.value) }}
      >
        {!opts?.includes(value) && <option value={value}>{value || '—'}</option>}
        {(opts?.length ? opts : [value || '—']).map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    )
  }
  return (
    <input
      {...common}
      type={kind === 'number' ? 'number' : kind === 'date' ? 'date' : 'text'}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/* ============================================================
   网格（正文内嵌 / 全屏 共用同一个组件 —— 两态数据必然一致）
   ============================================================ */

function Grid({
  tab, cursor, readOnly, fs,
  onCursor, onCell, onColPatch, onRowHead, onColHead,
}: {
  tab: SheetTab
  cursor: [number, number]
  readOnly?: boolean
  fs?: boolean
  onCursor: (r: number, c: number, focus?: boolean) => void
  onCell: (r: number, c: number, v: string) => void
  onColPatch: (ci: number, patch: Partial<SheetCol>) => void
  onRowHead: (ri: number) => void
  onColHead: (ci: number) => void
}) {
  const [r, c] = cursor
  const statusCol = (col: SheetCol) => col.k === 'select' && col.name === '状态'
  const prioCol = (col: SheetCol) => col.k === 'select' && col.name === '优先级'

  const onKeyDown = (e: React.KeyboardEvent, ri: number, ci: number, kind: CellKind) => {
    // 必须 preventDefault：否则 Tab 还会走浏览器默认的「跳到下一个可聚焦元素」，
    // 和这里的导航叠加，一次 Tab 就跨两格
    const go = (nr: number, nc: number) => {
      e.preventDefault()
      onCursor(nr, nc, true)
    }
    if (e.key === 'Enter') return go(ri + 1, ci)
    if (e.key === 'Tab') return go(ri, ci + (e.shiftKey ? -1 : 1))
    // 下拉用方向键改值，别抢去当导航键
    if (kind === 'select') return
    if (e.key === 'ArrowDown') return go(ri + 1, ci)
    if (e.key === 'ArrowUp') return go(ri - 1, ci)
    if (e.key === 'ArrowLeft') return go(ri, ci - 1)
    if (e.key === 'ArrowRight') return go(ri, ci + 1)
    if (e.key === 'Home') return go(ri, 0)
    if (e.key === 'End') return go(ri, tab.cols.length - 1)
  }

  return (
    <table className={`yq-sheet-grid ${fs ? 'is-fs' : ''}`}>
      <thead>
        <tr>
          <th className="yq-sheet-corner" />
          {tab.cols.map((col, i) => (
            <th
              key={col.id}
              className={i === c ? 'is-active' : ''}
              onClick={() => onColHead(i)}
            >
              {COL_LETTERS[i]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {/* 列名行：可改名 / 可切类型 */}
        <tr className="yq-sheet-header-row">
          <td className="yq-sheet-rowhead" />
          {tab.cols.map((col, i) => (
            <td
              key={col.id}
              className={`yq-sheet-th ${i === c ? 'is-head-active' : ''}`}
              onClick={() => onColHead(i)}
            >
              {readOnly ? (
                <span className="yq-sheet-colname is-static">{col.name}</span>
              ) : (
                <input
                  className="yq-sheet-colname"
                  value={col.name}
                  onChange={(e) => onColPatch(i, { name: e.target.value })}
                />
              )}
              {!readOnly && (
                <Dropdown
                  width={180}
                  trigger={(open, toggle) => (
                    <button
                      className={`yq-sheet-colkind ${open ? 'is-open' : ''}`}
                      onClick={(e) => { e.stopPropagation(); toggle() }}
                    >
                      {CELL_KINDS.find((k) => k.value === col.k)?.label} ▾
                    </button>
                  )}
                >
                  {() => <ColKindMenu col={col} onPatch={(p) => onColPatch(i, p)} />}
                </Dropdown>
              )}
            </td>
          ))}
        </tr>

        {tab.rows.map((row, ri) => (
          <tr key={ri}>
            <td className="yq-sheet-rowhead" onClick={() => onRowHead(ri)}>{ri + 1}</td>
            {tab.cols.map((col, ci) => {
              const cell = row[ci] || { v: '' }
              return (
                <td
                  key={col.id}
                  data-cell={`${ri}-${ci}`}
                  className={ri === r && ci === c ? 'is-active' : ''}
                  onClick={() => onCursor(ri, ci)}
                >
                  <CellEditor
                    value={cell.v}
                    kind={col.k}
                    opts={col.opts}
                    readOnly={readOnly}
                    color={statusCol(col) ? STATUS_COLOR[cell.v] : undefined}
                    onActivate={() => { if (ri !== r || ci !== c) onCursor(ri, ci) }}
                    onChange={(v) => onCell(ri, ci, v)}
                    onKeyDown={(e) => onKeyDown(e, ri, ci, col.k)}
                  />
                  {prioCol(col) && <span className="yq-sheet-prio" style={{ color: PRIORITY_COLOR[cell.v] }} />}
                </td>
              )
            })}
          </tr>
        ))}
        {tab.rows.length === 0 && (
          <tr>
            <td className="yq-sheet-rowhead" />
            <td className="yq-sheet-empty" colSpan={tab.cols.length}>还没有数据行</td>
          </tr>
        )}
      </tbody>
    </table>
  )
}

/* ============================================================
   主组件
   ============================================================ */

export default function SheetView({
  doc, readOnly, onChange, fullscreen, onFullscreenChange,
}: SheetViewProps) {
  const [data, setData] = useDocSection(doc.id, 'sheets', readOnly)
  const tab = activeTab(data)
  const [cursor, setCursor] = useState<[number, number]>([0, 0])
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [width, setWidth] = useState<'normal' | 'full'>('normal')
  const wrapRef = useRef<HTMLDivElement>(null)
  const focusCell = useRef<string | null>(null)

  const [r, c] = cursor
  const value = tab.rows[r]?.[c]?.v ?? ''

  // 换 tab / 换文档后光标可能越界，收回第一格
  useEffect(() => { setCursor([0, 0]) }, [tab.id, doc.id])
  useEffect(() => { setRenaming(null) }, [tab.id])

  // 键盘导航后把焦点交给目标单元格（否则连续按方向键只会停在原格）
  useEffect(() => {
    if (!focusCell.current || !wrapRef.current) return
    const key = focusCell.current
    focusCell.current = null
    const el = wrapRef.current.querySelector<HTMLInputElement | HTMLSelectElement>(
      `[data-cell="${key}"] input, [data-cell="${key}"] select`,
    )
    if (!el) return
    el.focus()
    if ('select' in el) (el as HTMLInputElement).select?.()
  }, [cursor, tab.id, fullscreen])

  /** 所有写操作都从这里过：先落 doc.sheetData，再把当前 sheet 的 markdown 同步给正文 */
  const commit = (next: SheetData) => {
    setData(next)
    onChange?.(sheetToMarkdown(activeTab(next)))
  }

  const patchTab = (fn: (t: SheetTab) => SheetTab) => commit({ ...data, sheets: data.sheets.map((s) => (s.id === tab.id ? fn(s) : s)) })

  const onCursor = (nr: number, nc: number, focus = false) => {
    const rr = clamp(nr, 0, Math.max(0, tab.rows.length - 1))
    const cc = clamp(nc, 0, Math.max(0, tab.cols.length - 1))
    if (focus) focusCell.current = `${rr}-${cc}`
    setCursor([rr, cc])
  }

  const onCell = (ri: number, ci: number, v: string) => patchTab((t) => sheetSetCell(t, ri, ci, v))
  const onColPatch = (ci: number, patch: Partial<SheetCol>) => patchTab((t) => sheetUpdateCol(t, ci, patch))

  const addRow = () => {
    const at = tab.rows.length ? r + 1 : 0
    patchTab((t) => sheetAddRow(t, at).tab)
    onCursor(at, 0, true)   // 插完就把光标送进新行
  }
  const delRow = () => {
    if (!tab.rows.length) return
    patchTab((t) => sheetRemoveRow(t, r))
    onCursor(Math.min(r, tab.rows.length - 2), c)
  }
  const addCol = () => {
    const at = tab.cols.length
    patchTab((t) => sheetAddCol(t, at).tab)
    onCursor(r, at)         // 插完就把光标送进新列
  }
  const delCol = () => {
    if (tab.cols.length <= 1) return
    patchTab((t) => sheetRemoveCol(t, c))
    onCursor(r, Math.min(c, tab.cols.length - 2))
  }

  const startRename = (id: string) => {
    const s = data.sheets.find((x) => x.id === id)
    setDraftName(s?.name || '')
    setRenaming(id)
  }
  const commitRename = () => {
    if (renaming) commit(sheetRenameTab(data, renaming, draftName))
    setRenaming(null)
  }

  /* ---------------- 全屏独立编辑态 ---------------- */
  if (fullscreen) {
    return (
      <div className="yq-sheet-sheet yq-sheet-fs" ref={wrapRef}>
        <div className="yq-sheet-fs-bar">
          <button className="yq-sheet-fs-back" onClick={() => onFullscreenChange?.(false)}>
            ← 退出全屏
          </button>
          <span className="yq-sheet-fs-name">📊 {tab.name}</span>
          <Segmented
            size="sm"
            value={width}
            onChange={(v) => setWidth(v as 'normal' | 'full')}
            options={[
              { value: 'normal', label: '标准' },
              { value: 'full', label: '全宽' },
            ]}
          />
          <span className="yq-flex-1" />
          {!readOnly && (
            <>
              <button className="yq-sheet-fs-btn" title="插入一行" onClick={addRow}>＋ 行</button>
              <button className="yq-sheet-fs-btn" title="删除当前行" onClick={delRow}>− 行</button>
              <button className="yq-sheet-fs-btn" title="插入一列" onClick={addCol}>＋ 列</button>
              <button className="yq-sheet-fs-btn" title="删除当前列" onClick={delCol}>− 列</button>
            </>
          )}
        </div>

        <div className="yq-sheet-fs-body">
          <Grid
            tab={tab}
            cursor={cursor}
            readOnly={readOnly}
            fs
            onCursor={onCursor}
            onCell={onCell}
            onColPatch={onColPatch}
            onRowHead={(ri) => onCursor(ri, 0)}
            onColHead={(ci) => onCursor(r, ci)}
          />
        </div>

        <div className="yq-sheet-foot">
          <span>单元格 {COL_LETTERS[c]}{r + 1}</span>
          <span>·</span>
          <span>{tab.rows.length} 行 × {tab.cols.length} 列</span>
          <span className="yq-flex-1" />
          <input className="yq-sheet-formula" value={value} readOnly />
        </div>
      </div>
    )
  }

  /* ---------------- 正文内嵌态 ---------------- */
  return (
    <div className="yq-sheet-sheet">
      <div className="yq-sheet-bar">
        {data.sheets.map((s) =>
          s.id === renaming ? (
            <input
              key={s.id}
              className="yq-sheet-rename"
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                if (e.key === 'Escape') setRenaming(null)
              }}
            />
          ) : (
            <button
              key={s.id}
              className={`yq-sheet-tab ${s.id === data.activeId ? 'is-active' : ''}`}
              title={readOnly ? s.name : `${s.name}（双击重命名）`}
              onClick={() => commit(sheetSwitch(data, s.id))}
              onDoubleClick={() => !readOnly && startRename(s.id)}
            >
              {s.name}
            </button>
          ),
        )}
        {!readOnly && (
          <>
            <button className="yq-sheet-btn" onClick={() => commit(sheetAddTab(data))}>＋ 工作表</button>
            <Dropdown
              width={170}
              trigger={(open, toggle) => (
                <button className={`yq-sheet-btn yq-sheet-more ${open ? 'is-open' : ''}`} onClick={toggle}>⋯</button>
              )}
            >
              {(close) => (
                <>
                  <MenuLabel>{tab.name}</MenuLabel>
                  <MenuItem icon="✎" onClick={() => { close(); startRename(tab.id) }}>重命名</MenuItem>
                  <MenuItem icon="⧉" onClick={() => { close(); commit(sheetDuplicateTab(data, tab.id)) }}>复制工作表</MenuItem>
                  <MenuDivider />
                  <MenuItem
                    icon="🗑"
                    danger
                    disabled={data.sheets.length <= 1}
                    onClick={() => { close(); commit(sheetRemoveTab(data, tab.id)) }}
                  >
                    删除工作表
                  </MenuItem>
                </>
              )}
            </Dropdown>
          </>
        )}
        {!readOnly && <button className="yq-sheet-btn" title="插入一列" onClick={addCol}>＋ 增加列</button>}
        <span className="yq-flex-1" />
        {!readOnly && (
          <button className="yq-sheet-btn" onClick={() => onFullscreenChange?.(true)} title="进入卡片的独立编辑界面">
            ⛶ 全屏
          </button>
        )}
      </div>

      <div className="yq-sheet-body" ref={wrapRef}>
        <Grid
          tab={tab}
          cursor={cursor}
          readOnly={readOnly}
          onCursor={onCursor}
          onCell={onCell}
          onColPatch={onColPatch}
          onRowHead={(ri) => onCursor(ri, 0)}
          onColHead={(ci) => onCursor(r, ci)}
        />
      </div>

      <div className="yq-sheet-foot">
        <span>单元格 {COL_LETTERS[c]}{r + 1}</span>
        <span>·</span>
        <span>{tab.rows.length} 行 × {tab.cols.length} 列</span>
        {!readOnly && (
          <>
            <span>·</span>
            <button className="yq-sheet-btn" title="删除当前行" onClick={delRow}>− 行</button>
            <button className="yq-sheet-btn" title="插入一行" onClick={addRow}>＋ 行</button>
            <button className="yq-sheet-btn" title="删除当前列" onClick={delCol}>− 列</button>
          </>
        )}
        <span className="yq-flex-1" />
        <input className="yq-sheet-formula" value={value} readOnly />
      </div>
    </div>
  )
}
