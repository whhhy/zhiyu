import { useMemo, useState } from 'react'
import type { Doc, DtField, DtRecord, DtRule, DtStatus, DtView } from '@/types'
import { useStore } from '@/store'
import { Avatar, Dropdown, Input, MenuDivider, MenuItem, MenuLabel, Segmented, Select, Tag } from '@/components/ui'
import {
  activeView, applyView, calendarCells, DT_FIELDS, DT_OPS, DT_PRIORITIES, DT_STATUSES,
  DT_VIEW_TYPES, STATUS_COLOR, monthOf, shiftMonth, tableAddRecord, tableAddView,
  tableRemoveRecord, tableRemoveView, tableSwitchView, tableUpdateRecord, tableUpdateView,
  today, useDocSection,
} from './sheetStore'
import './index.css'

/* ============================================================
   数据表 —— 多视图：表格 / 看板 / 画廊 / 日历
   四个视图看的是同一份 records（切换视图只是换渲染方式，不换数据），
   唯一真相在 doc.sheetData.table。
   ============================================================ */

const PRIORITY_TAG: Record<string, 'danger' | 'warning' | 'default'> = {
  P0: 'danger', P1: 'warning', P2: 'default',
}

/** 字段的可选值：给筛选条件 / 下拉用（空数组 = 自由输入） */
const fieldOptions = (f: DtField, records: DtRecord[]): string[] => {
  switch (f) {
    case 'status': return [...DT_STATUSES]
    case 'priority': return [...DT_PRIORITIES]
    case 'owner': {
      const names = records.map((r) => r.owner).filter(Boolean)
      return [...new Set(names)]
    }
    case 'tags': return [...new Set(records.flatMap((r) => r.tags))]
    default: return []
  }
}

/* ---------------- 记录字段表单（表格内联 / 详情面板共用） ---------------- */

function RecordFields({
  record, members, readOnly, onPatch, compact,
}: {
  record: DtRecord
  members: { id: string; name: string }[]
  readOnly?: boolean
  onPatch: (p: Partial<DtRecord>) => void
  compact?: boolean
}) {
  const ownerName = (n: string) => {
    const m = members.find((x) => x.name === n)
    return m ? m.name : n
  }
  return (
    <div className={`yq-dt-fields ${compact ? 'is-compact' : ''}`}>
      <label className="yq-dt-field">
        <span>需求名称</span>
        <input
          className="yq-dt-input"
          value={record.name}
          readOnly={readOnly}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
      </label>
      <label className="yq-dt-field">
        <span>负责人</span>
        <Select
          size="sm"
          value={ownerName(record.owner)}
          onChange={(v) => onPatch({ owner: v })}
          options={(members.length ? members.map((m) => m.name) : fieldOptions('owner', [record])).map((n) => ({ value: n, label: n }))}
        />
      </label>
      <label className="yq-dt-field">
        <span>状态</span>
        <Select
          size="sm"
          value={record.status}
          onChange={(v) => onPatch({ status: v as DtStatus })}
          options={DT_STATUSES.map((s) => ({ value: s, label: s }))}
        />
      </label>
      <label className="yq-dt-field">
        <span>优先级</span>
        <Select
          size="sm"
          value={record.priority}
          onChange={(v) => onPatch({ priority: v as DtRecord['priority'] })}
          options={DT_PRIORITIES.map((s) => ({ value: s, label: s }))}
        />
      </label>
      <label className="yq-dt-field">
        <span>截止日期</span>
        <input
          className="yq-dt-input"
          type="date"
          value={record.date}
          readOnly={readOnly}
          onChange={(e) => onPatch({ date: e.target.value })}
        />
      </label>
      <label className="yq-dt-field is-wide">
        <span>标签（用、分隔）</span>
        <input
          className="yq-dt-input"
          value={record.tags.join('、')}
          readOnly={readOnly}
          onChange={(e) => onPatch({ tags: e.target.value.split(/[、,，]/).map((s) => s.trim()).filter(Boolean) })}
        />
      </label>
    </div>
  )
}

/* ---------------- 筛选条件编辑器 ---------------- */

function RuleEditor({
  view, records, onChange,
}: {
  view: DtView
  records: DtRecord[]
  onChange: (rules: DtRule[]) => void
}) {
  const blank: DtRule = { field: 'status', op: 'is', value: '' }
  const draft = view.rules
  return (
    <div className="yq-dt-rules">
      {draft.length === 0 && <div className="yq-dt-rules-empty">没有筛选条件</div>}
      {draft.map((rule, i) => (
        <div className="yq-dt-rule" key={i}>
          <Select
            size="sm"
            value={rule.field}
            onChange={(v) => onChange(draft.map((x, j) => (j === i ? { ...x, field: v as DtField, value: '' } : x)))}
            options={DT_FIELDS.map((f) => ({ value: f.value, label: f.label }))}
          />
          <Select
            size="sm"
            value={rule.op}
            onChange={(v) => onChange(draft.map((x, j) => (j === i ? { ...x, op: v as DtRule['op'] } : x)))}
            options={DT_OPS.map((o) => ({ value: o.value, label: o.label }))}
          />
          {fieldOptions(rule.field, records).length ? (
            <Select
              size="sm"
              value={rule.value}
              onChange={(v) => onChange(draft.map((x, j) => (j === i ? { ...x, value: v } : x)))}
              options={[{ value: '', label: '（空）' }, ...fieldOptions(rule.field, records).map((o) => ({ value: o, label: o }))]}
            />
          ) : (
            <input
              className="yq-dt-input"
              value={rule.value}
              placeholder="值"
              onChange={(e) => onChange(draft.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
            />
          )}
          <button className="yq-dt-rule-del" onClick={() => onChange(draft.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <button className="yq-dt-btn" onClick={() => onChange([...draft, { ...blank, value: fieldOptions(blank.field, records)[0] || '' }])}>
        ＋ 添加条件
      </button>
    </div>
  )
}

/* ============================================================
   主组件
   ============================================================ */

export default function TableView({ doc, readOnly }: { doc: Doc; readOnly?: boolean }) {
  const [data, setData] = useDocSection(doc.id, 'table', readOnly)
  const members = useStore((s) => s.members)
  const [selected, setSelected] = useState<string | null>(null)
  /** 正在拖拽的记录（和目录树一致：不只靠 dataTransfer 传 id） */
  const [dragId, setDragId] = useState<string | null>(null)

  const view = activeView(data)
  const rows = useMemo(() => applyView(view, data.records), [view, data.records])
  const rec = data.records.find((r) => r.id === selected) || null

  const patchView = (patch: Partial<DtView>) => setData(tableUpdateView(data, view.id, patch))
  const patchRec = (id: string, patch: Partial<DtRecord>) => setData(tableUpdateRecord(data, id, patch))

  const addRecord = () => {
    const next = tableAddRecord(data, { owner: members[0]?.name || '' })
    setData(next)
    setSelected(next.records[next.records.length - 1].id)
  }
  const removeRecord = (id: string) => {
    setData(tableRemoveRecord(data, id))
    if (selected === id) setSelected(null)
  }

  const month = view.month || monthOf(today())

  return (
    <div className="yq-dt">
      <div className="yq-dt-bar">
        <Segmented
          size="sm"
          value={view.kind}
          onChange={(v) => {
            const kind = v as DtView['kind']
            // 切到日历时落在最早有数据的那个月，否则会翻到一片空白的当月
            const firstDate = data.records.map((r) => r.date).filter(Boolean).sort()[0] || today()
            patchView(kind === 'calendar' ? { kind, month: view.month || monthOf(firstDate) } : { kind })
          }}
          options={DT_VIEW_TYPES.map((t) => ({ value: t.value, label: t.label, icon: t.icon }))}
        />
        <Dropdown
          width={200}
          trigger={(open, toggle) => (
            <button className={`yq-dt-viewbtn ${open ? 'is-open' : ''}`} onClick={toggle}>
              ☰ {view.name} ▾
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuLabel>视图（同一份记录）</MenuLabel>
              {data.views.map((v) => (
                <MenuItem
                  key={v.id}
                  icon={v.id === view.id ? '●' : '○'}
                  trailing={
                    !readOnly && data.views.length > 1 ? (
                      <span
                        className="yq-menu-trailing"
                        onClick={(e) => { e.stopPropagation(); setData(tableRemoveView(data, v.id)) }}
                      >
                        ✕
                      </span>
                    ) : undefined
                  }
                  onClick={() => { close(); setData(tableSwitchView(data, v.id)) }}
                >
                  {DT_VIEW_TYPES.find((t) => t.value === v.kind)?.icon} {v.name}
                </MenuItem>
              ))}
              {!readOnly && (
                <>
                  <MenuDivider />
                  {DT_VIEW_TYPES.map((t) => (
                    <MenuItem key={t.value} icon="＋" onClick={() => { close(); setData(tableAddView(data, t.value)) }}>
                      新建{t.label}视图
                    </MenuItem>
                  ))}
                </>
              )}
            </>
          )}
        </Dropdown>
        <Input
          size="sm"
          className="yq-dt-search"
          value={view.q}
          placeholder="搜索需求 / 负责人 / 标签"
          onChange={(e) => patchView({ q: e.target.value })}
        />
        <select className="yq-dt-filter" value={view.status} onChange={(e) => patchView({ status: e.target.value as DtView['status'] })}>
          {['全部', ...DT_STATUSES].map((s) => (
            <option key={s} value={s}>{s === '全部' ? '全部状态' : s}</option>
          ))}
        </select>
        <select
          className="yq-dt-filter"
          value={view.sort}
          onChange={(e) => patchView({ sort: e.target.value as DtField })}
        >
          {DT_FIELDS.map((f) => <option key={f.value} value={f.value}>按{f.label}</option>)}
        </select>
        <button className="yq-dt-btn" onClick={() => patchView({ dir: view.dir === 'asc' ? 'desc' : 'asc' })}>
          {view.dir === 'asc' ? '↑ 升序' : '↓ 降序'}
        </button>
        {!readOnly && (
          <Dropdown
            width={320}
            trigger={(open, toggle) => (
              <button className={`yq-dt-btn ${open || view.rules.length ? 'is-on' : ''}`} onClick={toggle}>
                筛选条件{view.rules.length ? ` ${view.rules.length}` : ''}
              </button>
            )}
          >
            {() => <RuleEditor view={view} records={data.records} onChange={(rules) => patchView({ rules })} />}
          </Dropdown>
        )}
        <span className="yq-flex-1" />
        <span className="yq-dt-count">{rows.length} / {data.records.length} 条记录</span>
        {!readOnly && <button className="yq-btn yq-btn-green yq-btn-sm" onClick={addRecord}>＋ 新建记录</button>}
      </div>

      {/* ---------------- 表格视图 ---------------- */}
      {view.kind === 'table' && (
        <div className="yq-dt-table">
          <table>
            <thead>
              <tr>
                <th>需求名称</th>
                <th style={{ width: 110 }}>负责人</th>
                <th style={{ width: 100 }}>状态</th>
                <th style={{ width: 72 }}>优先级</th>
                <th style={{ width: 110 }}>截止日期</th>
                <th style={{ width: 90 }}>标签</th>
                {!readOnly && <th style={{ width: 40 }} />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={selected === r.id ? 'is-selected' : ''}
                  data-record-id={r.id}
                  onClick={() => setSelected(r.id)}
                >
                  <td className="yq-dt-name">
                    {readOnly ? r.name : (
                      <input
                        className="yq-dt-cellinput"
                        value={r.name}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => patchRec(r.id, { name: e.target.value })}
                      />
                    )}
                  </td>
                  <td>
                    <span className="yq-dt-owner">
                      <Avatar name={r.owner} size={18} />
                      {r.owner}
                    </span>
                  </td>
                  <td>
                    <span className="yq-dt-status" style={{ color: STATUS_COLOR[r.status] }}>
                      ● {r.status}
                    </span>
                  </td>
                  <td><Tag color={PRIORITY_TAG[r.priority]} size="sm">{r.priority}</Tag></td>
                  <td className="yq-dt-date">{r.date}</td>
                  <td>
                    <span className="yq-dt-tags">
                      {r.tags.map((t) => <Tag key={t} size="sm">{t}</Tag>)}
                    </span>
                  </td>
                  {!readOnly && (
                    <td>
                      <button className="yq-dt-del" title="删除记录" onClick={(e) => { e.stopPropagation(); removeRecord(r.id) }}>✕</button>
                    </td>
                  )}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={readOnly ? 6 : 7} className="yq-dt-empty">没有符合条件的记录</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ---------------- 看板视图（按状态分列，拖拽即改状态） ---------------- */}
      {view.kind === 'kanban' && (
        <div className="yq-dt-kanban">
          {DT_STATUSES.map((st) => {
            const items = rows.filter((r) => r.status === st)
            return (
              <div
                key={st}
                className="yq-dt-col"
                data-status={st}
                onDragOver={(e) => { if (!readOnly) e.preventDefault() }}
                onDrop={(e) => {
                  if (readOnly) return
                  e.preventDefault()
                  const id = e.dataTransfer.getData('text/plain') || dragId
                  setDragId(null)
                  if (id) patchRec(id, { status: st })
                }}
              >
                <div className="yq-dt-col-head">
                  <span className="yq-dt-dot" style={{ background: STATUS_COLOR[st] }} />
                  {st}
                  <span className="yq-dt-col-count">{items.length}</span>
                </div>
                {items.map((r) => (
                  <div
                    key={r.id}
                    className="yq-dt-card"
                    draggable={!readOnly}
                    data-record-id={r.id}
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', r.id); setDragId(r.id) }}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => setSelected(r.id)}
                  >
                    <div className="yq-dt-card-name">{r.name}</div>
                    <div className="yq-dt-card-foot">
                      <Avatar name={r.owner} size={18} />
                      <Tag color={PRIORITY_TAG[r.priority]} size="sm">{r.priority}</Tag>
                      <span className="yq-dt-card-date">{r.date.slice(5)}</span>
                    </div>
                  </div>
                ))}
                {!readOnly && items.length === 0 && (
                  <div className={`yq-dt-coldrop ${dragId ? 'is-hot' : ''}`}>{dragId ? '松手放到这里' : '拖到这里'}</div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ---------------- 画廊视图 ---------------- */}
      {view.kind === 'gallery' && (
        <div className="yq-dt-gallery">
          {rows.map((r) => (
            <div key={r.id} className="yq-dt-gcard" data-record-id={r.id} onClick={() => setSelected(r.id)}>
              <div className="yq-dt-gthumb">{r.name.slice(0, 2)}</div>
              <div className="yq-dt-gcard-name">{r.name}</div>
              <div className="yq-dt-gcard-foot">
                <Tag color={PRIORITY_TAG[r.priority]} size="sm">{r.priority}</Tag>
                <span style={{ color: STATUS_COLOR[r.status] }}>{r.status}</span>
                <span className="yq-dt-gcard-date">{r.date}</span>
              </div>
            </div>
          ))}
          {rows.length === 0 && <div className="yq-dt-empty">没有符合条件的记录</div>}
        </div>
      )}

      {/* ---------------- 日历视图（按截止日期落格） ---------------- */}
      {view.kind === 'calendar' && (
        <div className="yq-dt-cal">
          <div className="yq-dt-cal-nav">
            <button className="yq-dt-btn" onClick={() => patchView({ month: shiftMonth(month, -1) })}>‹</button>
            <span className="yq-dt-cal-title">{month.replace('-', ' 年 ')} 月</span>
            <button className="yq-dt-btn" onClick={() => patchView({ month: shiftMonth(month, 1) })}>›</button>
            <button className="yq-dt-btn" onClick={() => patchView({ month: monthOf(today()) })}>今天</button>
            <span className="yq-flex-1" />
            <span className="yq-dt-count">{rows.length} 条</span>
          </div>
          <div className="yq-dt-cal-head">
            {['一', '二', '三', '四', '五', '六', '日'].map((d) => <span key={d}>{d}</span>)}
          </div>
          <div className="yq-dt-cal-grid">
            {calendarCells(month).map((cell) => {
              const items = rows.filter((r) => r.date === cell.date)
              return (
                <div
                  key={cell.date}
                  className={`yq-dt-cell ${cell.inMonth ? '' : 'is-out'} ${cell.isToday ? 'is-today' : ''}`}
                >
                  <span className="yq-dt-cell-num">{cell.day}</span>
                  {items.map((r) => (
                    <span
                      key={r.id}
                      className="yq-dt-event"
                      data-record-id={r.id}
                      style={{ borderLeftColor: STATUS_COLOR[r.status] }}
                      onClick={() => setSelected(r.id)}
                    >
                      {r.name}
                    </span>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* ---------------- 记录详情：四种视图下都能改字段 ---------------- */}
      {rec && (
        <div className="yq-dt-editor">
          <div className="yq-dt-editor-head">
            <b>记录详情</b>
            <span className="yq-dt-editor-id">{rec.id}</span>
            <span className="yq-flex-1" />
            {!readOnly && (
              <button className="yq-dt-btn is-danger" onClick={() => removeRecord(rec.id)}>删除记录</button>
            )}
            <button className="yq-dt-btn" onClick={() => setSelected(null)}>关闭</button>
          </div>
          <RecordFields
            record={rec}
            members={members}
            readOnly={readOnly}
            onPatch={(p) => patchRec(rec.id, p)}
          />
        </div>
      )}
    </div>
  )
}
