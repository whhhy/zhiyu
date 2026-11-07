import { useCallback, useEffect, useRef } from 'react'
import { useStore } from '@/store'
import type {
  BoardCard, BoardData, BoardEdge, BoardShape, CellKind, DocSheetData, DtField, DtOp,
  DtPriority, DtRecord, DtRule, DtStatus, DtView, DtViewType, SheetCell, SheetCol, SheetData,
  SheetTab, TableData,
} from '@/types'

/* ============================================================
   表格类文稿的持久化数据层
   ------------------------------------------------------------
   三个文稿的唯一真相都挂在 doc.sheetData 上：
     sheetData.sheets  工作表（多 tab）
     sheetData.table   数据表（一份记录 + 多个视图）
     sheetData.board   画板（卡片 + 连线）
   组件不自己存 localStorage：所有写操作都走 store.updateDoc，
   和正文 / 卡片数据走的是同一条落盘链路（也不会和别的落盘逻辑打架）。
   ============================================================ */

export const DATA_VERSION = 1

/* ---------------- 通用小工具 ---------------- */

/** 列标 A / B / C … */
export const COL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/**
 * id 生成器：落盘数据里新实体的 id。
 * 只用自增序号 + 时间戳，不用 Math.random —— 同一份数据要能被复现 / 断言。
 */
let seq = 0
export const uid = (prefix: string) => `${prefix}_${(seq++).toString(36)}${Date.now().toString(36).slice(-4)}`

/** 深拷贝（种子写盘时用，避免后续改动污染常量种子） */
export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/* ---------------- 共用枚举 / 配色 ---------------- */

export const CELL_KINDS: { value: CellKind; label: string }[] = [
  { value: 'text', label: '文本' },
  { value: 'number', label: '数字' },
  { value: 'select', label: '下拉' },
  { value: 'date', label: '日期' },
]

export const DT_STATUSES: DtStatus[] = ['待开始', '进行中', '评审中', '已完成']
export const DT_PRIORITIES: DtPriority[] = ['P0', 'P1', 'P2']

export const DT_FIELDS: { value: DtField; label: string }[] = [
  { value: 'name', label: '需求名称' },
  { value: 'owner', label: '负责人' },
  { value: 'status', label: '状态' },
  { value: 'priority', label: '优先级' },
  { value: 'date', label: '截止日期' },
  { value: 'tags', label: '标签' },
]

export const DT_VIEW_TYPES: { value: DtViewType; label: string; icon: string }[] = [
  { value: 'table', label: '表格', icon: '▦' },
  { value: 'kanban', label: '看板', icon: '▤' },
  { value: 'gallery', label: '画廊', icon: '▩' },
  { value: 'calendar', label: '日历', icon: '▣' },
]

export const DT_OPS: { value: DtOp; label: string }[] = [
  { value: 'is', label: '等于' },
  { value: 'isNot', label: '不等于' },
  { value: 'contains', label: '包含' },
  { value: 'before', label: '早于' },
  { value: 'after', label: '晚于' },
]

export const STATUS_COLOR: Record<string, string> = {
  待开始: 'var(--yq-text-3)',
  进行中: 'var(--yq-primary)',
  评审中: 'var(--yq-warning)',
  已完成: 'var(--yq-green)',
}

export const PRIORITY_COLOR: Record<string, string> = {
  P0: 'var(--yq-danger)',
  P1: 'var(--yq-warning)',
  P2: 'var(--yq-text-3)',
}

export const PALETTE = [
  'var(--yq-primary-light)',
  'var(--yq-green-light)',
  'var(--yq-warning-light)',
  'var(--yq-danger-light)',
  'var(--yq-bg-3)',
  'var(--yq-bg-2)',
  'var(--yq-bg-1)',
]

export const SHAPES: { value: BoardShape; label: string }[] = [
  { value: 'rect', label: '矩形' },
  { value: 'round', label: '圆角' },
  { value: 'circle', label: '圆形' },
  { value: 'diamond', label: '菱形' },
  { value: 'cylinder', label: '圆柱' },
]

/* ============================================================
   初始种子 —— 首次打开（doc.sheetData 缺字段）时写盘一次，之后一律读写 doc.sheetData
   ============================================================ */

const SEED_SHEET_ROWS: string[][] = [
  ['REQ-001', '目录拖拽跨层级移动', '周砚', '已完成', 'P0', '2025-08-12'],
  ['REQ-002', '数据表看板视图', '陈小满', '进行中', 'P1', '2025-09-03'],
  ['REQ-003', '全文检索支持评论', '林知远', '进行中', 'P1', '2025-09-18'],
  ['REQ-004', '知识库封面自定义', '苏晚', '待开始', 'P2', '2025-10-01'],
  ['REQ-005', '移动端离线编辑', '何舟', '进行中', 'P2', '2025-10-12'],
  ['REQ-006', 'AI 问答接入空间公开页', '林知远', '评审中', 'P0', '2025-10-20'],
  ['REQ-007', '评论支持 @ 提醒', '陈小满', '已完成', 'P2', '2025-09-25'],
  ['REQ-008', '导出支持 docx', '周砚', '已完成', 'P1', '2025-09-30'],
]

export const SEED_SHEET: SheetData = {
  sheets: [
    {
      id: 'sh1',
      name: '需求列表',
      cols: [
        { id: 'c1', name: '需求编号', k: 'text' },
        { id: 'c2', name: '需求名称', k: 'text' },
        { id: 'c3', name: '负责人', k: 'text' },
        { id: 'c4', name: '状态', k: 'select', opts: [...DT_STATUSES] },
        { id: 'c5', name: '优先级', k: 'select', opts: [...DT_PRIORITIES] },
        { id: 'c6', name: '截止日期', k: 'date' },
      ],
      rows: SEED_SHEET_ROWS.map((r) => r.map((v) => ({ v }))),
    },
  ],
  activeId: 'sh1',
}

export const SEED_TABLE: TableData = {
  records: [
    { id: '1', name: '目录拖拽跨层级移动', owner: '周砚', status: '已完成', priority: 'P0', date: '2025-08-12', tags: ['编辑器'] },
    { id: '2', name: '数据表看板视图', owner: '陈小满', status: '进行中', priority: 'P1', date: '2025-09-03', tags: ['数据表'] },
    { id: '3', name: '全文检索支持评论', owner: '林知远', status: '进行中', priority: 'P1', date: '2025-09-18', tags: ['搜索'] },
    { id: '4', name: '知识库封面自定义', owner: '苏晚', status: '待开始', priority: 'P2', date: '2025-10-01', tags: ['知识库'] },
    { id: '5', name: '移动端离线编辑', owner: '何舟', status: '进行中', priority: 'P2', date: '2025-10-12', tags: ['移动端'] },
    { id: '6', name: 'AI 问答接入空间公开页', owner: '林知远', status: '评审中', priority: 'P0', date: '2025-10-20', tags: ['AI'] },
    { id: '7', name: '评论支持 @ 提醒', owner: '陈小满', status: '已完成', priority: 'P2', date: '2025-09-25', tags: ['协作'] },
    { id: '8', name: '导出支持 docx', owner: '周砚', status: '已完成', priority: 'P1', date: '2025-09-30', tags: ['导出'] },
  ],
  views: [
    { id: 'v_table', name: '全部需求', kind: 'table', status: '全部', q: '', sort: 'date', dir: 'asc', rules: [] },
    { id: 'v_board', name: '按状态', kind: 'kanban', status: '全部', q: '', sort: 'priority', dir: 'asc', rules: [] },
    { id: 'v_gallery', name: '卡片墙', kind: 'gallery', status: '全部', q: '', sort: 'name', dir: 'asc', rules: [] },
    { id: 'v_cal', name: '排期', kind: 'calendar', status: '全部', q: '', sort: 'date', dir: 'asc', rules: [], month: '2025-10' },
  ],
  activeViewId: 'v_table',
}

export const SEED_BOARD: BoardData = {
  cards: [
    { id: 'b1', x: 40, y: 30, w: 150, h: 56, text: '用户请求', color: PALETTE[0], shape: 'round' },
    { id: 'b2', x: 240, y: 30, w: 150, h: 56, text: 'API 网关', color: PALETTE[0], shape: 'round' },
    { id: 'b3', x: 440, y: 20, w: 150, h: 56, text: '鉴权服务', color: PALETTE[1], shape: 'rect' },
    { id: 'b4', x: 440, y: 100, w: 150, h: 56, text: '文档服务', color: PALETTE[1], shape: 'rect' },
    { id: 'b5', x: 440, y: 180, w: 150, h: 56, text: '搜索服务', color: PALETTE[1], shape: 'rect' },
    { id: 'b6', x: 650, y: 100, w: 150, h: 56, text: 'MySQL', color: PALETTE[2], shape: 'cylinder' },
    { id: 'b7', x: 650, y: 180, w: 150, h: 56, text: 'Elasticsearch', color: PALETTE[2], shape: 'cylinder' },
    { id: 'b8', x: 200, y: 260, w: 190, h: 96, text: '📌 待办\n画板支持流程图、架构图、脑图\n拖动卡片可重新排布', color: PALETTE[3], shape: 'round' },
  ],
  edges: [
    { id: 'e1', from: 'b1', to: 'b2' },
    { id: 'e2', from: 'b2', to: 'b3' },
    { id: 'e3', from: 'b2', to: 'b4' },
    { id: 'e4', from: 'b2', to: 'b5' },
    { id: 'e5', from: 'b4', to: 'b6' },
    { id: 'e6', from: 'b5', to: 'b7' },
    { id: 'e7', from: 'b4', to: 'b5' },
  ],
  background: 'grid',
  layout: 'auto',
}

/* ============================================================
   读 / 写
   ============================================================ */

export type SectionKey = 'sheets' | 'table' | 'board'

const SECTION_SEEDS: { [K in SectionKey]: DocSheetData[K] } = {
  sheets: SEED_SHEET,
  table: SEED_TABLE,
  board: SEED_BOARD,
}

/** 该文稿类型缺数据时的兜底种子（存量文档 / 新建文档都走这里） */
export const seedOf = <K extends SectionKey>(key: K): NonNullable<DocSheetData[K]> =>
  SECTION_SEEDS[key] as NonNullable<DocSheetData[K]>

/**
 * 落盘：把某一段数据写回 doc.sheetData。
 * 必须基于 store 里的最新 doc 做合并 —— 三个文稿共用一个 sheetData 命名空间，
 * 拿组件 props 里的旧 doc 合并会把别的段落（甚至别人的字段）覆盖掉。
 */
export function writeSection<K extends SectionKey>(docId: string, key: K, value: DocSheetData[K]) {
  const st = useStore.getState()
  const doc = st.docs[docId]
  if (!doc) return
  st.updateDoc(docId, {
    sheetData: { v: DATA_VERSION, ...doc.sheetData, [key]: value },
  })
}

/**
 * 订阅某一段文稿数据 + 拿到写入函数。
 * - 存量文档（localStorage 里没有 sheetData）不会白屏：先按种子渲染，副作用里补写一次种子
 * - 返回的 setter 在 readOnly 下是空操作
 */
export function useDocSection<K extends SectionKey>(
  docId: string,
  key: K,
  readOnly?: boolean,
): [NonNullable<DocSheetData[K]>, (next: NonNullable<DocSheetData[K]>) => void] {
  const stored = useStore((s) => (s.docs[docId]?.sheetData as DocSheetData | undefined)?.[key]) as
    | NonNullable<DocSheetData[K]>
    | undefined
  const seeded = useRef<string | null>(null)

  useEffect(() => {
    if (readOnly || stored) return
    // 同一篇文档只补写一次种子，避免竞态下重复写
    if (seeded.current === docId) return
    seeded.current = docId
    writeSection(docId, key, clone(seedOf(key)))
  }, [docId, key, readOnly, stored])

  const data = stored ?? (seedOf(key) as NonNullable<DocSheetData[K]>)
  const setData = useCallback(
    (next: NonNullable<DocSheetData[K]>) => {
      if (readOnly) return
      writeSection(docId, key, next)
    },
    [docId, key, readOnly],
  )
  return [data, setData]
}

/* ============================================================
   工作表：纯函数式的行 / 列 / tab 增删改
   ============================================================ */

const blankCell = (): SheetCell => ({ v: '' })

/** 补齐缺列的行、缺行的格 —— 老数据 / 手工编辑过的 JSON 都能安全渲染 */
export function normalizeTab(t: SheetTab): SheetTab {
  const cols = t.cols.length ? t.cols : [{ id: uid('c'), name: '列 A', k: 'text' as CellKind }]
  return {
    ...t,
    cols,
    rows: t.rows.map((row) => cols.map((_, i) => row[i] ?? blankCell())),
  }
}

/** 当前选中的 tab；activeId 失效时兜底到第一个，保证组件永远拿得到数据 */
export function activeTab(data: SheetData): SheetTab {
  return data.sheets.find((s) => s.id === data.activeId) || data.sheets[0] || normalizeTab({ id: '', name: '空表', cols: [], rows: [] })
}

const mapTab = (data: SheetData, fn: (t: SheetTab) => SheetTab): SheetData => {
  const cur = activeTab(data)
  return { ...data, sheets: data.sheets.map((s) => (s.id === cur.id ? fn(cur) : s)) }
}

export function sheetSetCell(t: SheetTab, ri: number, ci: number, v: string): SheetTab {
  const tab = normalizeTab(t)
  return {
    ...tab,
    rows: tab.rows.map((row, i) => (i === ri ? row.map((c, j) => (j === ci ? { ...c, v } : c)) : row)),
  }
}

export function sheetAddRow(t: SheetTab, at?: number): { tab: SheetTab; rowIndex: number } {
  const tab = normalizeTab(t)
  const rows = [...tab.rows]
  const idx = at == null ? rows.length : Math.max(0, Math.min(at, rows.length))
  rows.splice(idx, 0, tab.cols.map(blankCell))
  return { tab: { ...tab, rows }, rowIndex: idx }
}

export function sheetRemoveRow(t: SheetTab, ri: number): SheetTab {
  const tab = normalizeTab(t)
  return { ...tab, rows: tab.rows.filter((_, i) => i !== ri) }
}

export function sheetAddCol(t: SheetTab, at?: number, name?: string): { tab: SheetTab; colIndex: number } {
  const tab = normalizeTab(t)
  const cols = [...tab.cols]
  const idx = at == null ? cols.length : Math.max(0, Math.min(at, cols.length))
  cols.splice(idx, 0, { id: uid('c'), name: name || `列${COL_LETTERS[idx] || idx + 1}`, k: 'text' })
  return { tab: { ...tab, cols, rows: tab.rows.map((r) => normalizeRow(r, cols.length)) }, colIndex: idx }
}

/** 删列时把整表补齐到新的列数（少掉的格子直接丢，多出来的截断） */
function normalizeRow(row: SheetCell[], width: number): SheetCell[] {
  const out = row.slice(0, width)
  while (out.length < width) out.push(blankCell())
  return out
}

export function sheetRemoveCol(t: SheetTab, ci: number): SheetTab {
  const tab = normalizeTab(t)
  const cols = tab.cols.filter((_, i) => i !== ci)
  const width = cols.length
  return {
    ...tab,
    cols,
    // 先按列序删掉对应格子，再补齐到新的列数
    rows: tab.rows.map((r) => normalizeRow(r.filter((_, i) => i !== ci), width)),
  }
}

export function sheetUpdateCol(t: SheetTab, ci: number, patch: Partial<SheetCol>): SheetTab {
  const tab = normalizeTab(t)
  return { ...tab, cols: tab.cols.map((c, i) => (i === ci ? { ...c, ...patch } : c)) }
}

/** 切到别的 tab */
export function sheetSwitch(data: SheetData, id: string): SheetData {
  return data.sheets.some((s) => s.id === id) ? { ...data, activeId: id } : data
}

export function sheetAddTab(data: SheetData, name?: string): SheetData {
  const id = uid('sh')
  const base = activeTab(data)
  return {
    ...data,
    activeId: id,
    sheets: [
      ...data.sheets,
      normalizeTab({
        id,
        name: name || `工作表 ${data.sheets.length + 1}`,
        cols: base.cols.map((c) => ({ ...c, id: uid('c') })),
        rows: base.rows.map((r) => r.map((c) => ({ ...c }))),
      }),
    ],
  }
}

/** 删 tab 后把 activeId 挪到相邻的那个，不能指向已删的 id */
export function sheetRemoveTab(data: SheetData, id: string): SheetData {
  if (data.sheets.length <= 1) return data
  const idx = data.sheets.findIndex((s) => s.id === id)
  if (idx < 0) return data
  const sheets = data.sheets.filter((s) => s.id !== id)
  const activeId = data.activeId === id ? sheets[Math.min(idx, sheets.length - 1)].id : data.activeId
  return { ...data, sheets, activeId }
}

export function sheetRenameTab(data: SheetData, id: string, name: string): SheetData {
  const next = name.trim()
  if (!next) return data
  return { ...data, sheets: data.sheets.map((s) => (s.id === id ? { ...s, name: next } : s)) }
}

export function sheetDuplicateTab(data: SheetData, id: string): SheetData {
  const src = data.sheets.find((s) => s.id === id)
  if (!src) return data
  const nid = uid('sh')
  const copy: SheetTab = {
    ...clone(src),
    id: nid,
    name: `${src.name} 副本`,
    cols: src.cols.map((c) => ({ ...c, id: uid('c') })),
    rows: src.rows.map((r) => r.map((c) => ({ ...c }))),
  }
  const idx = data.sheets.findIndex((s) => s.id === id)
  const sheets = [...data.sheets]
  sheets.splice(idx + 1, 0, copy)
  return { ...data, sheets, activeId: nid }
}

/** 导出成 markdown 表格行（DocPage 的 onChange 拿它同步正文里的表格块） */
export function sheetToMarkdown(t: SheetTab): string {
  const tab = normalizeTab(t)
  return tab.rows
    .map((row) => `| ${tab.cols.map((_, i) => row[i]?.v || '').join(' | ')} |`)
    .join('\n')
}

/* ============================================================
   数据表：筛选 / 搜索 / 排序 / 视图 / 记录
   ============================================================ */

export function activeView(data: TableData): DtView {
  return data.views.find((v) => v.id === data.activeViewId) || data.views[0] || SEED_TABLE.views[0]
}

const fieldValue = (r: DtRecord, f: DtField): string => {
  switch (f) {
    case 'tags': return r.tags.join(' ')
    default: return String((r as any)[f] ?? '')
  }
}

function matchRule(r: DtRecord, rule: DtRule): boolean {
  if (!rule.field || !rule.value) return true
  const v = fieldValue(r, rule.field)
  switch (rule.op) {
    case 'is': return v === rule.value
    case 'isNot': return v !== rule.value
    case 'contains': return v.toLowerCase().includes(rule.value.toLowerCase())
    // 日期按字符串比较即可 —— YYYY-MM-DD 字典序 = 时间序
    case 'before': return v < rule.value
    case 'after': return v > rule.value
    default: return true
  }
}

/** 视图 → 真正的记录集：状态筛选 + 规则 + 搜索 + 排序，全部作用在真实数据上 */
export function applyView(view: DtView, records: DtRecord[]): DtRecord[] {
  const q = view.q.trim().toLowerCase()
  const out = records.filter((r) => {
    if (view.status !== '全部' && r.status !== view.status) return false
    if (!view.rules.every((rule) => matchRule(r, rule))) return false
    if (!q) return true
    return (
      r.name.toLowerCase().includes(q) ||
      r.owner.toLowerCase().includes(q) ||
      r.status.includes(q) ||
      r.priority.toLowerCase().includes(q) ||
      r.tags.some((t) => t.toLowerCase().includes(q))
    )
  })
  const dir = view.dir === 'desc' ? -1 : 1
  return out
    .map((r, i) => ({ r, i }))
    .sort((a, b) => {
      const av = fieldValue(a.r, view.sort)
      const bv = fieldValue(b.r, view.sort)
      if (av === bv) return a.i - b.i // 稳定排序
      return av > bv ? dir : -dir
    })
    .map((x) => x.r)
}

export function tableAddRecord(data: TableData, patch: Partial<DtRecord> = {}): TableData {
  const rec: DtRecord = {
    id: uid('r'),
    name: '新记录',
    owner: '周砚',
    status: '待开始',
    priority: 'P2',
    date: today(),
    tags: [],
    ...patch,
  }
  return { ...data, records: [...data.records, rec] }
}

export function tableUpdateRecord(data: TableData, id: string, patch: Partial<DtRecord>): TableData {
  return { ...data, records: data.records.map((r) => (r.id === id ? { ...r, ...patch } : r)) }
}

export function tableRemoveRecord(data: TableData, id: string): TableData {
  return { ...data, records: data.records.filter((r) => r.id !== id) }
}

export function tableAddView(data: TableData, kind: DtViewType, name?: string): TableData {
  const base = activeView(data)
  const id = uid('v')
  const view: DtView = {
    ...clone(base),
    id,
    name: name || `${DT_VIEW_TYPES.find((t) => t.value === kind)?.label || '视图'} ${data.views.length + 1}`,
    kind,
  }
  return { ...data, views: [...data.views, view], activeViewId: id }
}

export function tableRemoveView(data: TableData, id: string): TableData {
  if (data.views.length <= 1) return data
  const idx = data.views.findIndex((v) => v.id === id)
  if (idx < 0) return data
  const views = data.views.filter((v) => v.id !== id)
  const activeViewId = data.activeViewId === id ? views[Math.min(idx, views.length - 1)].id : data.activeViewId
  return { ...data, views, activeViewId }
}

export function tableUpdateView(data: TableData, id: string, patch: Partial<DtView>): TableData {
  return { ...data, views: data.views.map((v) => (v.id === id ? { ...v, ...patch } : v)) }
}

export function tableSwitchView(data: TableData, id: string): TableData {
  return data.views.some((v) => v.id === id) ? { ...data, activeViewId: id } : data
}

/* ---------------- 日历 ---------------- */

export const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export const monthOf = (date: string) => date.slice(0, 7)

export const shiftMonth = (ym: string, delta: number) => {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(y, (m - 1) + delta, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export interface CalCell {
  /** YYYY-MM-DD */
  date: string
  day: number
  inMonth: boolean
  isToday: boolean
}

/** 生成 6×7 的月历格子（周一起始），与记录按 date 字符串对齐 */
export function calendarCells(ym: string): CalCell[] {
  const [y, m] = ym.split('-').map(Number)
  const first = new Date(y, m - 1, 1)
  const offset = (first.getDay() + 6) % 7 // 周一 = 0
  const start = new Date(y, m - 1, 1 - offset)
  const t = today()
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return { date, day: d.getDate(), inMonth: d.getMonth() === m - 1, isToday: date === t }
  })
}

/* ============================================================
   画板
   ============================================================ */

/** 新卡片位置：按已有卡片数算一个确定的落点（不用 Math.random，否则同一次操作重渲染就漂） */
export function boardSlot(cards: BoardCard[]): { x: number; y: number } {
  const n = cards.length
  return { x: 40 + (n % 4) * 190, y: 40 + Math.floor(n / 4) * 90 }
}

export function boardAddCard(data: BoardData, text = '新卡片'): { data: BoardData; id: string } {
  const { x, y } = boardSlot(data.cards)
  const id = uid('b')
  return {
    data: {
      ...data,
      cards: [...data.cards, { id, x, y, w: 150, h: 56, text, color: PALETTE[6], shape: 'round' }],
    },
    id,
  }
}

export function boardPatchCard(data: BoardData, id: string, patch: Partial<BoardCard>): BoardData {
  return { ...data, cards: data.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) }
}

/** 删卡片要连它身上的线一起删，否则会留下指向空气的连线 */
export function boardRemoveCard(data: BoardData, id: string): BoardData {
  return {
    ...data,
    cards: data.cards.filter((c) => c.id !== id),
    edges: data.edges.filter((e) => e.from !== id && e.to !== id),
  }
}

export function boardAddEdge(data: BoardData, from: string, to: string): BoardData {
  if (from === to) return data
  if (!data.cards.some((c) => c.id === from) || !data.cards.some((c) => c.id === to)) return data
  // 同一对连线不重复建
  if (data.edges.some((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from))) return data
  return { ...data, edges: [...data.edges, { id: uid('e'), from, to }] }
}

export function boardRemoveEdge(data: BoardData, id: string): BoardData {
  return { ...data, edges: data.edges.filter((e) => e.id !== id) }
}

export function boardEdgesOf(data: BoardData, id: string): BoardEdge[] {
  return data.edges.filter((e) => e.from === id || e.to === id)
}

/**
 * 窄屏重排：桌面那套坐标是为 ~900px 画布设计的，手机上直接铺会有一大半卡片
 * 跑到屏幕外、并排的几张还会挤成一团。所以按可用宽度换一套初始排布。
 * 纯显示变换，不动 doc.sheetData —— 窄屏看到的排布和落盘的坐标互不污染。
 */
export function boardLayout(cards: BoardCard[], viewport: number, canvasW: number): BoardCard[] {
  const narrow = viewport <= 768
  if (!narrow) {
    // 画布窄于桌面布局时按比例缩一点，别让最右一列贴边
    const k = canvasW < 860 ? Math.max(0.62, canvasW / 900) : 1
    return cards.map((c) => ({
      ...c,
      x: Math.round(c.x * k),
      y: Math.round(c.y * k),
      w: Math.round(Math.min(c.w, Math.max(96, canvasW - 32))),
    }))
  }

  // 手机：两列错位，卡片宽度跟着视口走
  const cardW = Math.max(104, Math.min(160, Math.floor((canvasW - 44) / 2)))
  const rowH = 74
  return cards.map((c, i) => {
    const col = i % 2
    const row = Math.floor(i / 2)
    return {
      ...c,
      x: 16 + col * (cardW + 12),
      y: 18 + row * (rowH + 10) + (col ? rowH / 2 : 0), // 第二列下移半格 → 错位
      w: cardW,
      h: rowH,
    }
  })
}

/** 导出：纯 JSON（可再被 useDocSection 读回去） */
export const boardToJSON = (data: BoardData) =>
  JSON.stringify(
    { v: DATA_VERSION, type: 'board', exportedAt: new Date().toISOString(), ...clone(data) },
    null,
    2,
  )

/** 触发浏览器下载（不引第三方库，用 Blob + a[download]） */
export function downloadJSON(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // 立刻 revoke 会让部分浏览器来不及开始下载
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}
