import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useBookStats } from '@/lib/useBookStats'
import { useBookPermsMany } from '@/lib/perms'
import { useStore } from '@/store'
import type { DocTemplate } from '@/types'
import { Button, Dropdown, Empty, Input, MenuDivider, MenuItem, MenuLabel, Modal, Segmented, Select, Tag, Tooltip } from '@/components/ui'
import { timeAgo } from '@/components/layout/TopBar'
import { renderMarkdown } from '@/utils/markdown'
import '../styles/layout.css'
/* markdown 排版规则 2026-10-07 从本文件抽到 styles/markdown.css ——
   分享页与帮助页也在渲染 markdown，它们同样需要这套规则。 */
import '../styles/markdown.css'
import './Templates.css'

/* ============================================================
   模板中心 —— 形态是「左目录 + 右预览」，不是卡片墙
   来源分四类：官方 / 团队 / 我的 / 本知识库

   ⚠️⚠️ **这一页没有可核对的语雀对应物。**（2026-10-10 实测）

   实测过程与结论：
     · `yuque.com/templates` 打开后**不是模板中心**，而是一个叫
       「Templates」的**知识库**（第二层导航是 知识库 / 动态 / 资源 / 成员）——
       也就是说，那个 URL 在真实语雀上被一个用户的知识库占着。
     · 工作台那张「模板中心」卡（`data-testid="dashboard:quick_start:template"`）
       **不是 `<a>`**，是 `div` + JS 跳转，DOM 上读不出目标路由
       （`a[href*="template"]` 一条都没有）。

   所以：
     · 卡片本身（位置、文案、图标）是对着真实页面做的；
     · 但**这个页面是我们自己的设计**，不是照抄某个已知形态。
       改它的时候别拿「语雀就是这样」当理由，也别为了「更像」去猜一个路由。
   ============================================================ */

type TagColor = 'default' | 'primary' | 'green' | 'warning' | 'danger'

const SCOPE_META: Record<DocTemplate['scope'], { label: string; color: TagColor }> = {
  official: { label: '官方', color: 'primary' },
  team: { label: '团队', color: 'green' },
  mine: { label: '我的', color: 'default' },
  book: { label: '本知识库', color: 'warning' },
}

const SCOPES = [
  { value: 'all', label: '全部' },
  { value: 'official', label: '官方模板' },
  { value: 'mine', label: '我的模板' },
  { value: 'team', label: '团队模板' },
  { value: 'book', label: '本知识库' },
]

/** 新建模板的候选图标 */
const ICON_CHOICES = [
  '📄', '📝', '📋', '📊', '🗂️', '📌', '📅', '🗺️',
  '🎯', '🚀', '🧭', '🧪', '🛠️', '🏗️', '🧩', '🔍',
  '💡', '🔥', '⚠️', '✅', '💬', '👥', '💰', '🌱',
]

/** 分类下拉的兜底项，已有分类会并进来 */
const BASE_CATEGORIES = ['协作办公', '产品', '研发', '团队', '成长', '生活', '通用']

const DEFAULT_BODY = `# 新模板标题

## 一、背景

## 二、目标

## 三、行动项
- [ ] 待办项`

interface FormState {
  mode: 'create' | 'edit'
  tpl?: DocTemplate
  initial?: { name?: string; body?: string; icon?: string }
}

export default function Templates() {
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { templates, books, docs, nodes, toast, createTemplate, updateTemplate, deleteTemplate, applyTemplate } = useStore()
  const bs = useBookStats()

  const [scope, setScope] = useState('all')
  const [q, setQ] = useState('')
  const [selId, setSelId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState | null>(null)
  const [applyTpl, setApplyTpl] = useState<DocTemplate | null>(null)
  const [dropTpl, setDropTpl] = useState<DocTemplate | null>(null)
  const [pickBook, setPickBook] = useState(false)
  const [fromDoc, setFromDoc] = useState(false)

  /** 上下文知识库：URL ?book=xxx */
  const ctxBookId = params.get('book') || ''
  const ctxBook = books.find((b) => b.id === ctxBookId)

  /**
   * 权限第一道，挂在**页面**上而不是只挂在 `ApplyModal` 里。
   *
   * ⚠️ 这里踩了一次很典型的坑：先把 hook 加在弹窗里，界面确实关上了，
   * 但 store 的 `bookCreateBlocked` 仍然会被绕过 ——
   * 因为那一支守卫的边界是「**问过**且没有才拦」，而弹窗没打开时
   * 这一页**从来没问过** → caps 是 `null` → 放行。
   * 实测：读者在 `#/templates` 上直接调 `applyTemplate`，本地真的多出一篇。
   *
   * 所以规则要再往前推一步：
   *   **hook 要挂在「能触发这个写操作的那个页面」上**，
   *   挂在更深的子组件里就只关住了界面、关不住 store 那一道。
   *
   * 挂在页面上的额外好处：`BookPickerModal`、`从文档创建` 这些
   * 将来新增的入口自动就带着判据了，不必每个都记得再问一次。
   */
  useBookPermsMany(books.map((b) => b.id))

  const categories = useMemo(() => {
    const set = new Set([...BASE_CATEGORIES, ...templates.map((t) => t.category)])
    return Array.from(set)
  }, [templates])

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return templates.filter((t) => {
      if (scope === 'book') {
        // 本知识库 = 归属该库的模板；没带 ?book= 时退化为 scope==='book'
        if (t.scope !== 'book' && !(ctxBookId && t.bookId === ctxBookId)) return false
      } else if (scope !== 'all' && t.scope !== scope) {
        return false
      }
      if (!kw) return true
      return [t.name, t.desc, t.category].some((s) => s.toLowerCase().includes(kw))
    })
  }, [templates, scope, q, ctxBookId])

  /** 按分类分组，分类顺序取首次出现顺序，组内保持列表顺序 */
  const groups = useMemo(() => {
    const map = new Map<string, DocTemplate[]>()
    list.forEach((t) => {
      const k = t.category || '未分类'
      if (!map.has(k)) map.set(k, [])
      map.get(k)!.push(t)
    })
    return Array.from(map, ([category, items]) => ({ category, items }))
  }, [list])

  /** 选中项失效（搜索/切分类/删除）时自动落到第一个 */
  useEffect(() => {
    if (list.length === 0) {
      setSelId(null)
      return
    }
    if (!selId || !list.some((t) => t.id === selId)) setSelId(list[0].id)
  }, [list, selId])

  const selected = templates.find((t) => t.id === selId) || null

  const saveTemplate = (data: { name: string; desc: string; icon: string; category: string; body: string }) => {
    if (form?.mode === 'edit' && form.tpl) {
      updateTemplate(form.tpl.id, data)
      setSelId(form.tpl.id)
      toast('模板已更新', 'success')
    } else {
      const id = createTemplate({ ...data, scope: 'mine', bookId: ctxBookId || undefined })
      setSelId(id)
      setScope('mine')
      toast('模板已创建', 'success')
    }
    setForm(null)
  }

  const copyToMine = (t: DocTemplate) => {
    const id = createTemplate({
      name: `${t.name} 副本`,
      desc: t.desc,
      icon: t.icon,
      category: t.category,
      body: t.body,
      scope: 'mine',
    })
    setSelId(id)
    setScope('mine')
    toast('已复制到「我的模板」', 'success')
  }

  const removeTemplate = (t: DocTemplate) => {
    deleteTemplate(t.id)
    toast(`已删除模板《${t.name}》`, 'info')
  }

  const doApply = (t: DocTemplate, bookId: string) => {
    const docId = applyTemplate(bookId, null, t.id)
    setApplyTpl(null)
    if (!docId) {
      toast('模板应用失败', 'error')
      return
    }
    toast(`已用《${t.name}》新建文档`, 'success')
    navigate(`/book/${bookId}/doc/${docId}`)
  }

  return (
    <div className="yq-tpl">
      {/* ---------------- 顶部 ---------------- */}
      <header className="yq-tpl-header">
        <div className="yq-flex-1">
          <h1 className="yq-tpl-title">模板中心</h1>
          <p className="yq-tpl-sub">
            用结构化模板一键新建文档：官方模板开箱即用，团队约定统一结构，写好的内容也能存成自己的模板
          </p>
        </div>
        <div className="yq-tpl-header-act">
          {ctxBook && (
            <Tag color="primary" size="sm">
              当前知识库：{ctxBook.name}
            </Tag>
          )}
          <Button variant="default" icon="📥" onClick={() => setFromDoc(true)}>
            从文档创建
          </Button>
          <Button variant="primary" icon="＋" onClick={() => setForm({ mode: 'create' })}>
            我的模板
          </Button>
        </div>
      </header>

      <div className="yq-tpl-bar">
        <Segmented value={scope} onChange={setScope} options={SCOPES} />
        <span className="yq-tpl-count">
          共 {list.length} 个模板{ctxBook ? ` · ${ctxBook.name}` : ''}
        </span>
      </div>

      {/* ---------------- 左目录 + 右预览 ---------------- */}
      <div className="yq-tpl-body">
        <aside className="yq-tpl-side">
          <div className="yq-tpl-search">
            <Input
              size="sm"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              prefix={<span>🔍</span>}
              placeholder="搜索名称、描述、分类"
            />
          </div>

          <div className="yq-tpl-list">
            {groups.length === 0 ? (
              <Empty
                icon={q ? '🔍' : '🗂️'}
                text={q ? `没有找到与「${q}」匹配的模板` : '这个分类下还没有模板'}
                action={
                  !q && scope === 'book' && !ctxBookId ? (
                    <Button variant="default" size="sm" onClick={() => setPickBook(true)}>
                      选择知识库
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              groups.map((g) => (
                <div key={g.category} className="yq-tpl-group">
                  <div className="yq-tpl-group-label">
                    <span className="yq-ellipsis">{g.category}</span>
                    <span className="yq-tpl-group-num">{g.items.length}</span>
                  </div>
                  {g.items.map((t) => (
                    <div
                      key={t.id}
                      className={`yq-tpl-item ${t.id === selId ? 'is-active' : ''}`}
                      onClick={() => setSelId(t.id)}
                    >
                      <span className="yq-tpl-item-icon">{t.icon}</span>
                      <div className="yq-tpl-item-body">
                        <div className="yq-tpl-item-name yq-ellipsis">{t.name}</div>
                        <div className="yq-tpl-item-desc yq-ellipsis">{t.desc}</div>
                        <div className="yq-tpl-item-meta">
                          <Tag color={SCOPE_META[t.scope].color} size="sm">
                            {SCOPE_META[t.scope].label}
                          </Tag>
                          {/*
                           * 0 次时**不显示**，而不是显示「已用 0 次」。
                           *
                           * 这个数原来在种子里写死（18420 / 12360 / …），
                           * 是从别处抄来的常量 —— 公司内网刚部署、没人用过，
                           * 却写着「已用 18420 次」，属于**编造的社会认同**。
                           * 和团队动态写死 7 条虚构人+文档、侧栏文档数写死 8
                           * 是同一族：**界面在展示一个它并不掌握的数据**。
                           *
                           * 现在从 0 开始、由真实的 `applyTemplate` 长出来，
                           * 于是「已用 3 次」对同事是有意义的内部信号。
                           * 0 的时候干脆不说 —— 没什么可说的。
                           */}
                          {t.usedCount > 0 && <span className="yq-tpl-item-used">已用 {t.usedCount} 次</span>}
                        </div>
                      </div>

                      <div className="yq-tpl-item-act" onClick={(e) => e.stopPropagation()}>
                        <Button variant="primary" size="sm" onClick={() => setApplyTpl(t)}>
                          用此模板
                        </Button>
                        <Dropdown
                          align="right"
                          width={168}
                          trigger={(_, toggle) => (
                            <button className="yq-tpl-more" onClick={toggle} title="更多">
                              ···
                            </button>
                          )}
                        >
                          {(close) => (
                            <>
                              <MenuLabel>{t.category}</MenuLabel>
                              <MenuItem icon="📄" onClick={() => { setSelId(t.id); close() }}>
                                查看预览
                              </MenuItem>
                              <MenuItem icon="⚡" onClick={() => { setApplyTpl(t); close() }}>
                                用此模板新建
                              </MenuItem>
                              {t.scope === 'mine' ? (
                                <>
                                  <MenuDivider />
                                  <MenuItem icon="✏️" onClick={() => { setForm({ mode: 'edit', tpl: t }); close() }}>
                                    重命名 / 编辑
                                  </MenuItem>
                                  <MenuItem icon="🗑" danger onClick={() => { setDropTpl(t); close() }}>
                                    删除模板
                                  </MenuItem>
                                </>
                              ) : (
                                <>
                                  <MenuDivider />
                                  <MenuItem icon="⧉" onClick={() => { copyToMine(t); close() }}>
                                    复制为我的模板
                                  </MenuItem>
                                </>
                              )}
                            </>
                          )}
                        </Dropdown>
                      </div>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        </aside>

        {/* ---------------- 右侧预览 ---------------- */}
        <section className="yq-tpl-preview">
          {!selected ? (
            <Empty icon="📄" text="左侧选择一个模板，右侧预览正文效果" />
          ) : (
            <>
              <div className="yq-tpl-preview-head">
                <span className="yq-tpl-preview-icon">{selected.icon}</span>
                <div className="yq-flex-1">
                  <div className="yq-tpl-preview-title yq-ellipsis">
                    {selected.name}
                    <Tag color={SCOPE_META[selected.scope].color} size="sm">
                      {SCOPE_META[selected.scope].label}
                    </Tag>
                  </div>
                  <p className="yq-tpl-preview-desc">{selected.desc}</p>
                  <div className="yq-tpl-preview-meta">
                    <span>{selected.category}</span>
                    {/* 同上：0 次不展示，别拿一个空数字占位 */}
                    {selected.usedCount > 0 && (
                      <>
                        <span>·</span>
                        <span>已使用 {selected.usedCount} 次</span>
                      </>
                    )}
                    <span>·</span>
                    <span>创建于 {timeAgo(selected.createdAt)}</span>
                  </div>
                </div>
                <div className="yq-tpl-preview-act">
                  {selected.scope === 'mine' && (
                    <>
                      <Tooltip title="编辑模板">
                        <button className="yq-tpl-preview-iconbtn" onClick={() => setForm({ mode: 'edit', tpl: selected })}>
                          ✏️
                        </button>
                      </Tooltip>
                      <Tooltip title="删除模板">
                        <button className="yq-tpl-preview-iconbtn" onClick={() => setDropTpl(selected)}>
                          🗑
                        </button>
                      </Tooltip>
                    </>
                  )}
                  <Button variant="primary" icon="＋" onClick={() => setApplyTpl(selected)}>
                    用此模板新建
                  </Button>
                </div>
              </div>

              <div className="yq-tpl-paper">
                <div className="yq-tpl-paper-label">正文预览 · 只读</div>
                {renderMarkdown(selected.body)}
              </div>
            </>
          )}
        </section>
      </div>

      {/* ---------------- 弹窗 ---------------- */}
      {form && (
        <TemplateFormModal
          mode={form.mode}
          tpl={form.tpl}
          initial={form.initial}
          categories={categories}
          onClose={() => setForm(null)}
          onSave={saveTemplate}
        />
      )}

      {applyTpl && (
        <ApplyModal
          tpl={applyTpl}
          ctxBookId={ctxBookId}
          onClose={() => setApplyTpl(null)}
          onConfirm={(bookId) => doApply(applyTpl, bookId)}
        />
      )}

      {dropTpl && (
        <Modal
          open
          onClose={() => setDropTpl(null)}
          title="删除模板"
          width={400}
          footer={
            <div className="yq-tpl-foot">
              <Button variant="text" onClick={() => setDropTpl(null)}>
                取消
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  removeTemplate(dropTpl)
                  setDropTpl(null)
                }}
              >
                确认删除
              </Button>
            </div>
          }
        >
          <p className="yq-tpl-hint">
            确定删除模板《{dropTpl.name}》吗？删除后无法恢复，已经用它创建的文档不受影响。
          </p>
        </Modal>
      )}

      {pickBook && (
        <BookPickerModal
          title="选择知识库"
          onClose={() => setPickBook(false)}
          onPick={(id) => {
            setParams({ book: id })
            setScope('book')
            setPickBook(false)
          }}
        />
      )}

      {fromDoc && (
        <DocPickerModal
          onClose={() => setFromDoc(false)}
          onPick={(d) => {
            setForm({
              mode: 'create',
              initial: { name: d.title, body: d.body, icon: '📄' },
            })
            setFromDoc(false)
          }}
        />
      )}
    </div>
  )
}

/* ============================================================
   新建 / 编辑模板
   ==================================================================================== */

function TemplateFormModal({
  mode,
  tpl,
  initial,
  categories,
  onClose,
  onSave,
}: {
  mode: 'create' | 'edit'
  tpl?: DocTemplate
  initial?: { name?: string; body?: string; icon?: string }
  categories: string[]
  onClose: () => void
  onSave: (data: { name: string; desc: string; icon: string; category: string; body: string }) => void
}) {
  const [name, setName] = useState(tpl?.name ?? initial?.name ?? '')
  const [desc, setDesc] = useState(tpl?.desc ?? '')
  const [icon, setIcon] = useState(tpl?.icon ?? initial?.icon ?? '📄')
  const [category, setCategory] = useState(tpl?.category ?? categories[0])
  const [body, setBody] = useState(tpl?.body ?? initial?.body ?? DEFAULT_BODY)
  const [tab, setTab] = useState<'edit' | 'preview'>('edit')

  const submit = () => {
    const n = name.trim()
    if (!n) return
    onSave({ name: n, desc: desc.trim(), icon, category, body })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={mode === 'edit' ? '编辑模板' : '新建我的模板'}
      width={620}
      footer={
        <div className="yq-tpl-foot">
          <span className="yq-tpl-hint yq-flex-1">正文支持 Markdown，可在「预览」页签看效果</span>
          <Button variant="text" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={submit}>
            {mode === 'edit' ? '保存修改' : '创建模板'}
          </Button>
        </div>
      }
    >
      <div className="yq-tpl-form">
        <Field label="名称">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：线上事故跟进表" autoFocus />
        </Field>
        <Field label="描述">
          <Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="一句话说明这个模板适合什么场景" />
        </Field>
        <Field label="图标">
          <div className="yq-tpl-icons">
            {ICON_CHOICES.map((c) => (
              <button
                key={c}
                className={`yq-tpl-icon ${c === icon ? 'is-active' : ''}`}
                onClick={() => setIcon(c)}
                title={c}
              >
                {c}
              </button>
            ))}
          </div>
        </Field>
        <Field label="分类">
          <Select value={category} onChange={setCategory} options={categories.map((c) => ({ value: c, label: c }))} />
        </Field>
        <div className="yq-tpl-form-body">
          <div className="yq-tpl-form-body-head">
            <span className="yq-tpl-form-label">正文</span>
            <Segmented
              size="sm"
              value={tab}
              onChange={(v) => setTab(v as 'edit' | 'preview')}
              options={[
                { value: 'edit', label: '编辑' },
                { value: 'preview', label: '预览' },
              ]}
            />
          </div>
          {tab === 'edit' ? (
            <textarea
              className="yq-tpl-textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="# 标题&#10;&#10;## 小节&#10;- 列表项&#10;- [ ] 待办"
              spellCheck={false}
            />
          ) : (
            <div className="yq-tpl-form-preview">{renderMarkdown(body)}</div>
          )}
          <div className="yq-tpl-hint">支持 # 标题、- 列表、- [ ] 待办、``` 代码块、&gt; 引用、| 表格、--- 分隔线、**加粗**、`行内代码`</div>
        </div>
      </div>
    </Modal>
  )
}

/* ============================================================
   用此模板新建 —— 选目标知识库
   ============================================================ */

function ApplyModal({
  tpl,
  ctxBookId,
  onClose,
  onConfirm,
}: {
  tpl: DocTemplate
  ctxBookId: string
  onClose: () => void
  onConfirm: (bookId: string) => void
}) {
  const bs = useBookStats()
  const { books, nodes } = useStore()
  const [bookId, setBookId] = useState(ctxBookId || books[0]?.id || '')

  /*
   * 权限第一道。**这一页以前一个权限 hook 都没挂**，
   * 于是 store 的 `bookCreateBlocked`（边界是「问过且没有才拦」）
   * 在这里读到的是 `null` ——「没问过」—— 于是**永远放行**。
   *
   * 实测后果（reader，2026-10-14）：任何读者打开模板中心，
   * 选一个他**读得到但建不了**的知识库，点「确认新建」，
   * 本地真的多出一篇文稿、界面报「已用《…》新建文档」并跳进去 ——
   * 而服务端拒收（`applyTemplate` 按 `capsInBook().create` 判），
   * 于是顶栏挂一条他自己修不好的告警。
   *
   * 这是同一个病的**第三个现场**（前两个：设置页「文档管理」、
   * 顶栏的新建弹窗）。凡是提供写入口的页面都得自己问一次权限。
   *
   * fail closed：caps 还是 `null` 时按「不能」处理。
   */
  const capsMap = useBookPermsMany(books.map((b) => b.id))
  const canCreateIn = (id: string) => capsMap[id] != null && capsMap[id]!.create
  const picked = bookId && canCreateIn(bookId)

  return (
    <Modal
      open
      onClose={onClose}
      title="用此模板新建"
      width={480}
      footer={
        <div className="yq-tpl-foot">
          <Button variant="text" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={!picked}
            title={picked ? '' : '在这个知识库里没有新建文档的权限'}
            onClick={() => { if (picked) onConfirm(bookId) }}
          >
            确认新建
          </Button>
        </div>
      }
    >
      <div className="yq-tpl-hint" style={{ marginBottom: 10 }}>
        将以《{tpl.name}》的正文结构在所选知识库根目录下新建一篇文档，标题默认取模板名，创建后即可自由修改。
      </div>
      <div className="yq-tpl-books">
        {books.map((b) => {
          const roots = nodes.filter((n) => n.bookId === b.id && n.parentId === null).length
          const can = canCreateIn(b.id)
          return (
            <button
              key={b.id}
              className={`yq-tpl-book ${bookId === b.id ? 'is-active' : ''}`}
              disabled={!can}
              title={can ? '' : '在这个知识库里没有新建文档的权限'}
              onClick={() => can && setBookId(b.id)}
            >
              <span className="yq-tpl-book-avatar">{b.avatar}</span>
              <span className="yq-flex-1" style={{ textAlign: 'left', minWidth: 0 }}>
                <span className="yq-tpl-book-name yq-ellipsis">{b.name}</span>
                <span className="yq-tpl-book-meta">
                  {bs(b).docCount} 篇文档 · {roots} 个根目录{can ? '' : ' · 无新建权限'}
                </span>
              </span>
              {bookId === b.id && can && <span className="yq-tick">✓</span>}
            </button>
          )
        })}
      </div>
    </Modal>
  )
}

/* ============================================================
   选知识库（本知识库分类需要上下文）
   ============================================================ */

function BookPickerModal({
  title,
  onClose,
  onPick,
}: {
  title: string
  onClose: () => void
  onPick: (bookId: string) => void
}) {
  const { books } = useStore()
  const [q, setQ] = useState('')
  const kw = q.trim().toLowerCase()
  const list = books.filter((b) => !kw || b.name.toLowerCase().includes(kw) || b.desc.toLowerCase().includes(kw))

  return (
    <Modal open onClose={onClose} title={title} width={440}>
      <div style={{ marginBottom: 10 }}>
        <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} prefix={<span>🔍</span>} placeholder="搜索知识库" />
      </div>
      <div className="yq-tpl-books">
        {list.length === 0 ? (
          <Empty icon="📚" text="没有匹配的知识库" />
        ) : (
          list.map((b) => (
            <button
              key={b.id}
              className="yq-tpl-book"
              onClick={() => {
                onPick(b.id)
                onClose()
              }}
            >
              <span className="yq-tpl-book-avatar">{b.avatar}</span>
              <span className="yq-flex-1" style={{ textAlign: 'left', minWidth: 0 }}>
                <span className="yq-tpl-book-name yq-ellipsis">{b.name}</span>
                <span className="yq-tpl-book-meta">{b.desc}</span>
              </span>
            </button>
          ))
        )}
      </div>
    </Modal>
  )
}

/* ============================================================
   从已有文档存为模板
   ============================================================ */

function DocPickerModal({ onClose, onPick }: { onClose: () => void; onPick: (doc: { title: string; body: string }) => void }) {
  const { docs, nodes, books } = useStore()
  const [q, setQ] = useState('')
  const kw = q.trim().toLowerCase()

  const list = useMemo(() => {
    return Object.values(docs)
      .filter((d) => !kw || d.title.toLowerCase().includes(kw) || d.body.toLowerCase().includes(kw))
      .slice(0, 30)
  }, [docs, kw])

  return (
    <Modal open onClose={onClose} title="从文档创建模板" width={520}>
      <div className="yq-tpl-hint" style={{ marginBottom: 10 }}>
        选择一篇已有文档，把它的正文结构存成「我的模板」，下次一键复用。
      </div>
      <div style={{ marginBottom: 10 }}>
        <Input size="sm" value={q} onChange={(e) => setQ(e.target.value)} prefix={<span>🔍</span>} placeholder="搜索文档标题或正文" />
      </div>
      <div className="yq-tpl-books">
        {list.length === 0 ? (
          <Empty icon="📄" text={`没有找到与「${q}」相关的文档`} />
        ) : (
          list.map((d) => {
            const book = books.find((b) => b.id === nodes.find((n) => n.docId === d.id)?.bookId)
            return (
              <button
                key={d.id}
                className="yq-tpl-book"
                onClick={() => {
                  onPick({ title: d.title, body: d.body })
                  onClose()
                }}
              >
                <span className="yq-tpl-book-avatar">📄</span>
                <span className="yq-flex-1" style={{ textAlign: 'left', minWidth: 0 }}>
                  <span className="yq-tpl-book-name yq-ellipsis">{d.title}</span>
                  <span className="yq-tpl-book-meta yq-ellipsis">
                    {book?.name} · {d.wordCount} 字
                  </span>
                </span>
              </button>
            )
          })
        )}
      </div>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="yq-tpl-field">
      <label>{label}</label>
      <div>{children}</div>
    </div>
  )
}
