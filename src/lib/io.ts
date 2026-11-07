import type { AppData } from '@/types'
import { safeFileNameWithExt } from '@/lib/filename'
import { useStore } from '@/store'
import { buildDocx, readDocx } from '@/lib/docx'

/* ============================================================
   导出 / 导入
   ------------------------------------------------------------
   为什么要有这个：当前项目没有服务端（零网络请求，静态托管），
   所以「跨设备同步」这件事只能靠手动搬运。
   一个完整的导出包能让用户把整个工作台带到另一台设备继续写，
   而不只是导出单篇 Markdown。
   ============================================================ */

const BUNDLE_VERSION = 1

export interface ExportBundle {
  format: 'yuque-clone-bundle'
  version: number
  exportedAt: number
  /** 导出者 */
  exportedBy: string
  data: AppData
}

/* ---------------- 完整数据导出 ---------------- */

export function buildBundle(): ExportBundle {
  const s = useStore.getState()
  const { toasts: _t, ...data } = s as any
  return {
    format: 'yuque-clone-bundle',
    version: BUNDLE_VERSION,
    exportedAt: Date.now(),
    exportedBy: s.currentUser?.name || 'unknown',
    data: data as AppData,
  }
}

export function downloadBundle(filename?: string) {
  const bundle = buildBundle()
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  triggerDownload(blob, filename || `yuque-workspace-${dateStamp()}.json`)
}

/* ---------------- 导入 ---------------- */

export interface ImportResult {
  ok: boolean
  mode?: 'replace' | 'merge'
  counts?: { spaces: number; books: number; docs: number }
  error?: string
}

/** 解析并校验导入包。合并模式下同名 id 的条目以【导入包】为准。 */
export function applyBundle(
  raw: string,
  mode: 'replace' | 'merge',
): ImportResult {
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件' }
  }

  if (!parsed || parsed.format !== 'yuque-clone-bundle') {
    return { ok: false, error: '不是本应用导出的数据包' }
  }
  if (typeof parsed.version !== 'number' || parsed.version > BUNDLE_VERSION) {
    return { ok: false, error: `数据包版本 ${parsed.version} 高于当前支持的 ${BUNDLE_VERSION}` }
  }
  const d = parsed.data
  if (!d || typeof d !== 'object' || !d.docs || !d.books || !d.nodes) {
    return { ok: false, error: '数据包内容不完整（缺少 docs / books / nodes）' }
  }

  const s = useStore.getState()

  if (mode === 'replace') {
    useStore.setState({
      docs: d.docs,
      books: d.books,
      nodes: d.nodes,
      spaces: d.spaces || s.spaces,
      members: d.members || s.members,
      comments: d.comments || {},
      notes: d.notes || [],
      topics: d.topics || [],
      topicReplies: d.topicReplies || [],
      /*
       * ⚠️ collaborations 不再导入：那是**纯客户端种子**（无服务端表、
       *    不在同步实体清单里），服务端形态下 clearLocalSnapshot 会立刻清空它。
       *    导入它只会制造「包里居然有协作邀请」的假象。
       *    真的协作邀请走 bookInvites（下面那行），那是有服务端表的那种。
       */
      favorites: d.favorites || [],
      follows: d.follows || [],
      recents: d.recents || [],
      trash: d.trash || [],
      templates: d.templates || s.templates,
      bookSettings: d.bookSettings || {},
      bookMembers: d.bookMembers || {},
      bookInvites: d.bookInvites || [],
      selectionComments: d.selectionComments || {},
      cursors: [],            // 光标是实时态，不该从包里恢复
    } as any)
    return {
      ok: true,
      mode,
      counts: { spaces: (d.spaces || []).length, books: d.books.length, docs: Object.keys(d.docs).length },
    }
  }

  // 合并：导入包覆盖同名，其余保留本地
  useStore.setState((st: any) => ({
    docs: { ...st.docs, ...d.docs },
    books: mergeById(st.books, d.books),
    nodes: mergeById(st.nodes, d.nodes),
    spaces: mergeById(st.spaces, d.spaces || []),
    members: mergeById(st.members, d.members || []),
    notes: mergeById(st.notes, d.notes || []),
    topics: mergeById(st.topics, d.topics || []),
    topicReplies: mergeById(st.topicReplies || [], d.topicReplies || []),
    comments: { ...st.comments, ...(d.comments || {}) },
    selectionComments: { ...st.selectionComments, ...(d.selectionComments || {}) },
    templates: mergeById(st.templates, d.templates || []),
    recents: mergeById(st.recents, d.recents || []),
  }))
  return {
    ok: true,
    mode,
    counts: { spaces: (d.spaces || []).length, books: d.books.length, docs: Object.keys(d.docs).length },
  }
}

const mergeById = (a: any[] = [], b: any[] = []) => {
  const m = new Map<string, any>()
  for (const x of a) m.set(x.id, x)
  for (const x of b) m.set(x.id, x)
  return [...m.values()]
}

/* ---------------- 单篇文档导出 ---------------- */

export type DocFormat = 'md' | 'html' | 'txt' | 'json' | 'docx'

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** 用纯文本渲染一个可读的单文件 HTML，样式内联，双击就能看 */
export function docToHtml(title: string, body: string): string {
  const lines = body.split('\n')
  const out: string[] = []
  let inCode = false
  let inTable = false

  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false } }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')

    if (line.trim().startsWith('```')) {
      closeTable()
      out.push(inCode ? '</code></pre>' : '<pre><code>')
      inCode = !inCode
      continue
    }
    if (inCode) { out.push(escapeHtml(line) + '\n'); continue }

    // 表格
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim())
      if (/^[\s:|-]+$/.test(line)) continue  // 分隔行
      if (!inTable) { out.push('<table><thead><tr>' + cells.map((c) => `<th>${inlineMd(c)}</th>`).join('') + '</tr></thead><tbody>'); inTable = true }
      else { out.push('<tr>' + cells.map((c) => `<td>${inlineMd(c)}</td>`).join('') + '</tr>') }
      continue
    }
    closeTable()

    if (!line.trim()) continue
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`); continue }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { out.push('<hr>'); continue }
    if (/^>\s?/.test(line)) { out.push(`<blockquote>${inlineMd(line.replace(/^>\s?/, ''))}</blockquote>`); continue }
    const todo = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/)
    if (todo) {
      const checked = todo[1].toLowerCase() === 'x'
      out.push(`<div class="todo${checked ? ' done' : ''}"><span class="box">${checked ? '✓' : ''}</span>${inlineMd(todo[2])}</div>`)
      continue
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    if (ul) { out.push(`<ul><li>${inlineMd(ul[1])}</li></ul>`); continue }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/)
    if (ol) { out.push(`<ol><li>${inlineMd(ol[1])}</li></ol>`); continue }
    out.push(`<p>${inlineMd(line)}</p>`)
  }
  closeTable()
  if (inCode) out.push('</code></pre>')

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{font:15px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
       max-width:760px;margin:0 auto;padding:48px 24px;color:#1f2329;background:#fff}
  h1{font-size:30px}h2{font-size:22px;margin-top:28px}h3{font-size:18px;margin-top:22px}
  p{margin:12px 0}ul,ol{padding-left:24px}li{margin:4px 0}
  blockquote{margin:12px 0;padding:8px 14px;border-left:3px solid #d5d9de;color:#51565d;background:#f7f8fa}
  pre{background:#f7f8fa;border:1px solid #e5e8eb;border-radius:6px;padding:14px;overflow:auto}
  code{font:13px ui-monospace,Menlo,Consolas,monospace}
  hr{border:none;border-top:1px solid #e5e8eb;margin:28px 0}
  table{border-collapse:collapse;width:100%;margin:16px 0;font-size:14px}
  th,td{border:1px solid #e5e8eb;padding:8px 10px;text-align:left}
  th{background:#f7f8fa;font-weight:600}
  .todo{margin:6px 0;display:flex;gap:8px;align-items:flex-start}
  .todo .box{width:16px;height:16px;border:1px solid #c0c5cc;border-radius:3px;flex:0 0 auto;
             display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;margin-top:3px}
  .todo.done .box{background:#46b160;border-color:#46b160}
  .todo.done{color:#b4bac1;text-decoration:line-through}
  @media print{body{max-width:none;padding:0}}
</style></head>
<body>
<h1>${escapeHtml(title)}</h1>
${out.join('\n')}
</body></html>`
}

/** 行内 markdown：加粗、行内代码、链接 */
function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>')
}

export function downloadDocAs(title: string, body: string, format: DocFormat) {
  // docx 走的是二进制：buildDocx 自己生成 zip 字节，
  // 所以这一支不进下面的字符串 map —— Blob 的类型和内容都不一样。
  if (format === 'docx') {
    triggerDownload(
      new Blob([buildDocx(title, body) as any], {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
      safeName(title, 'docx'),
    )
    return
  }
  const map: Record<Exclude<DocFormat, 'docx'>, { content: string; mime: string; ext: string }> = {
    md: { content: body, mime: 'text/markdown;charset=utf-8', ext: 'md' },
    txt: { content: body.replace(/[#*`>|-]/g, ''), mime: 'text/plain;charset=utf-8', ext: 'txt' },
    html: { content: docToHtml(title, body), mime: 'text/html;charset=utf-8', ext: 'html' },
    json: { content: JSON.stringify({ title, body }, null, 2), mime: 'application/json', ext: 'json' },
  }
  const m = map[format]
  triggerDownload(new Blob([m.content], { type: m.mime }), safeName(title, m.ext))
}

/* ---------------- 工具 ---------------- */

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 不 revoke 的话部分浏览器会挂住 blob
  setTimeout(() => URL.revokeObjectURL(url), 4000)
}

const dateStamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

/**
 * 文件名净化 —— 收在 `@/lib/filename`，全项目只有那**一份**实现。
 *
 * ⚠️ 这里以前自己写了一份，而它与 `book-export.ts` 的同名函数**完全不同**：
 *    那份把**所有非 ASCII** 换成 `_`。于是导出一篇《产品手册》：
 *      Markdown（走 book-export 那条路）→ `产品手册.md` ✅
 *      Word / HTML / 纯文本（走这里）      → `untitled-20261014-1006.docx` ❌
 *    也就是这个中文知识库**四种导出格式里三种丢掉文件名**，
 *    同一天导出的多篇还会撞名（浏览器只能追加 (1)(2)）。
 *
 * 它当时的理由是「部分浏览器（无头 Chromium 就是）会把 download 属性里的
 * 非 ASCII 文件名整个丢成 download」—— 那个前提**过时**了，
 * 现代浏览器都支持 `a.download` 里的 UTF-8 文件名。
 */
const safeName = (raw: string, fallbackExt = 'md') => safeFileNameWithExt(raw, fallbackExt)
