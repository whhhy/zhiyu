import { Fragment, type ReactNode } from 'react'

/* ============================================================
   轻量 markdown → JSX 渲染器（零依赖）
   语雀的模板正文、文档正文都是 markdown 源文，
   这里手写一个够用的渲染，不引第三方库。

   支持：# ~ #### 标题 / 无序列表 / 有序列表 / 待办 - [ ] / 代码块 ``` /
        引用 > / 表格 | / 水平线 --- / 加粗 ** / 行内代码 `
   不支持：图片、链接、斜体、删除线、嵌套引用、自动链接、HTML 块、setext 标题
   ============================================================ */

/** 行内语法：`` `code` `` 与 **bold**，先匹配行内代码避免和加粗打架 */
const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)/g

const RE_HR = /^(?:-{3,}|\*{3,}|_{3,})$/
const RE_HEADING = /^(#{1,4})\s+(.+)$/
const RE_FENCE = /^```(\S*)\s*$/
const RE_QUOTE = /^>\s?/
const RE_UL = /^[-*+]\s+(.*)$/
const RE_OL = /^\d+[.)]\s+(.*)$/
const RE_TODO = /^[-*+]\s+\[([ xX])\]\s*(.*)$/

type Align = 'left' | 'center' | 'right'

interface ListItem {
  level: number
  text: string
}

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; lines: string[] }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'todo'; items: (ListItem & { checked: boolean })[] }
  | { type: 'code'; lang: string; code: string }
  | { type: 'quote'; lines: string[] }
  | { type: 'table'; head: string[]; rows: string[][]; align: Align[] }
  | { type: 'hr' }

/* ---------------- 行内 ---------------- */

/** 把一行文本里的 `code` 与 **bold** 变成 ReactNode 数组（不注入 HTML） */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = new RegExp(INLINE_RE)
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const token = m[0]
    if (token.charCodeAt(0) === 0x60 /* ` */) {
      out.push(
        <code key={key++} className="yq-md-code">
          {token.slice(1, -1)}
        </code>,
      )
    } else {
      out.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    }
    last = m.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/* ---------------- 块级解析 ---------------- */

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line)
const isTableSep = (line: string) => /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/.test(line)

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())

/** markdown 源文 → 块结构（纯数据，方便单测 / 复用） */
export function parseMarkdown(md: string): Block[] {
  const lines = String(md ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i].replace(/\s+$/, '')

    if (!line.trim()) {
      i++
      continue
    }

    // 代码块：```lang ... ```
    const fence = line.match(RE_FENCE)
    if (fence) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) {
        buf.push(lines[i])
        i++
      }
      i++ // 跳过收尾围栏（没闭合也照样收尾，别把后面当代码）
      blocks.push({ type: 'code', lang: fence[1] || '', code: buf.join('\n') })
      continue
    }

    // 水平线
    if (RE_HR.test(line.trim())) {
      blocks.push({ type: 'hr' })
      i++
      continue
    }

    // 标题
    const h = line.match(RE_HEADING)
    if (h) {
      blocks.push({ type: 'heading', level: h[1].length, text: h[2].trim() })
      i++
      continue
    }

    // 表格：| a | b | + | --- | --- | + 数据行
    if (isTableRow(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = splitRow(line)
      const align: Align[] = splitRow(lines[i + 1]).map((c) =>
        c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left',
      )
      i += 2
      const rows: string[][] = []
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(splitRow(lines[i]))
        i++
      }
      blocks.push({ type: 'table', head, rows, align })
      continue
    }

    // 引用：连续的 > 行合成一个引用块
    if (RE_QUOTE.test(line)) {
      const buf: string[] = []
      while (i < lines.length && RE_QUOTE.test(lines[i])) {
        buf.push(lines[i].replace(RE_QUOTE, ''))
        i++
      }
      blocks.push({ type: 'quote', lines: buf })
      continue
    }

    // 列表 / 待办：靠缩进（每 2 空格一级，最多 3 级）判层级
    const levelOf = (l: string) => Math.min(2, Math.floor((l.length - l.trimStart().length) / 2))
    const body = line.trim()

    const todo = body.match(RE_TODO)
    if (todo) {
      const items: (ListItem & { checked: boolean })[] = []
      while (i < lines.length) {
        const raw = lines[i]
        const m = raw.trim().match(RE_TODO)
        if (!m) break
        items.push({ level: levelOf(raw), checked: m[1] !== ' ', text: m[2] })
        i++
      }
      blocks.push({ type: 'todo', items })
      continue
    }

    const ul = body.match(RE_UL)
    const ol = body.match(RE_OL)
    if (ul || ol) {
      const items: ListItem[] = []
      while (i < lines.length) {
        const raw = lines[i]
        const t = raw.trim()
        const u = t.match(RE_UL)
        const o = t.match(RE_OL)
        if (!u && !o) break
        items.push({ level: levelOf(raw), text: (u || o)![1] })
        i++
      }
      blocks.push({ type: 'list', ordered: !!ol && !ul, items })
      continue
    }

    // 段落：连续非空行合并，换行用 <br/> 保住
    const buf: string[] = []
    while (i < lines.length) {
      const t = lines[i]
      if (
        !t.trim() ||
        RE_HR.test(t.trim()) ||
        RE_HEADING.test(t) ||
        RE_FENCE.test(t) ||
        RE_QUOTE.test(t) ||
        RE_UL.test(t.trim()) ||
        RE_OL.test(t.trim()) ||
        (isTableRow(t) && i + 1 < lines.length && isTableSep(lines[i + 1]))
      )
        break
      buf.push(t.replace(/\s+$/, ''))
      i++
    }
    blocks.push({ type: 'paragraph', lines: buf })
  }

  return blocks
}

/* ---------------- 渲染 ---------------- */

/** 扁平列表 → 嵌套树，再递归成 ul/ol */
function renderList(items: ListItem[], ordered: boolean): ReactNode {
  interface Node {
    text: string
    children: Node[]
  }
  const roots: Node[] = []
  const stack: { level: number; node: Node }[] = []

  items.forEach((it) => {
    const node: Node = { text: it.text, children: [] }
    while (stack.length && stack[stack.length - 1].level >= it.level) stack.pop()
    if (stack.length) stack[stack.length - 1].node.children.push(node)
    else roots.push(node)
    stack.push({ level: it.level, node })
  })

  const walk = (nodes: Node[]): ReactNode =>
    ordered ? (
      <ol className="yq-md-list yq-md-ol">
        {nodes.map((n, i) => (
          <li key={i} className="yq-md-li">
            {renderInline(n.text)}
            {n.children.length > 0 && walk(n.children)}
          </li>
        ))}
      </ol>
    ) : (
      <ul className="yq-md-list">
        {nodes.map((n, i) => (
          <li key={i} className="yq-md-li">
            {renderInline(n.text)}
            {n.children.length > 0 && walk(n.children)}
          </li>
        ))}
      </ul>
    )

  return walk(roots)
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.type) {
    case 'heading': {
      const Tag = (['h1', 'h2', 'h3', 'h4'] as const)[Math.min(3, b.level - 1)]
      return (
        <Tag key={key} className={`yq-md-h${b.level}`}>
          {renderInline(b.text)}
        </Tag>
      )
    }
    case 'paragraph':
      return (
        <p key={key} className="yq-md-p">
          {b.lines.map((l, i) => (
            <span key={i}>
              {i > 0 && <br />}
              {renderInline(l)}
            </span>
          ))}
        </p>
      )
    case 'list':
      return <Fragment key={key}>{renderList(b.items, b.ordered)}</Fragment>
    case 'todo':
      return (
        <ul key={key} className="yq-md-todo">
          {b.items.map((it, i) => (
            <li key={i} className={`yq-md-todo-li ${it.checked ? 'is-done' : ''}`} style={{ paddingLeft: it.level * 20 }}>
              <span className={`yq-md-todo-box ${it.checked ? 'is-done' : ''}`}>{it.checked ? '✓' : ''}</span>
              <span className="yq-md-todo-text">{renderInline(it.text)}</span>
            </li>
          ))}
        </ul>
      )
    case 'code':
      return (
        <div key={key} className="yq-md-pre">
          {b.lang && <span className="yq-md-pre-lang">{b.lang}</span>}
          <pre>
            <code>{b.code}</code>
          </pre>
        </div>
      )
    case 'quote':
      return (
        <blockquote key={key} className="yq-md-quote">
          {b.lines.map((l, i) => (
            <span key={i}>
              {i > 0 && <br />}
              {renderInline(l)}
            </span>
          ))}
        </blockquote>
      )
    case 'table':
      return (
        <div key={key} className="yq-md-table-wrap">
          <table className="yq-md-table">
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} style={{ textAlign: b.align[i] || 'left' }}>
                    {renderInline(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>
                  {b.head.map((_, ci) => (
                    <td key={ci} style={{ textAlign: b.align[ci] || 'left' }}>
                      {renderInline(r[ci] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'hr':
      return <hr key={key} className="yq-md-hr" />
    default:
      return null
  }
}

/** markdown 源文 → 排版好的只读正文（模板预览 / 编辑弹窗实时预览共用） */
export function renderMarkdown(md: string): ReactNode {
  const blocks = parseMarkdown(md)
  if (blocks.length === 0) return null
  return <div className="yq-md">{blocks.map(renderBlock)}</div>
}
