/* ============================================================
   Mermaid `mindmap`（脑图）→ 原生 SVG
   ------------------------------------------------------------
   为什么做：脑图是中文内网文档里很常见的一类内容（公司介绍、
   知识体系梳理、产品规划）。它的结构就是**缩进树**，不涉及图算法
   （没有环、没有分层、没有交叉），所以零依赖就能出图。

   ⚠️ **不能复用 flowchart**：实测把 mindmap 源码喂进 `parseFlowchart`
     会得到 14 个节点、**0 条边** —— 一堆互不相连的方框。
     树不是图，边得由**缩进**推出来，不是由源码里的 `A-->B` 给的。

   覆盖范围**如实标注**：
     · 支持 mindmap、缩进层级、`root` 与 `root((名称))` 等形状写法、
       `::icon(...)` 前缀（内容忽略，只取文字）、`:::class` 类标记与 classDef 样式
   **不支持**：左右双向布局（本实现固定「根在左、往右展开」）、
     markdown 粗体/斜体。这些进 `skipped`，界面明说。
   ⚠️ 上面「样式 classDef」原来写在**不支持**里，而 2026-10-07 已经接上
     （见下面 `applyStyles`）—— 文件头与实现自相矛盾。它还会被复制到**卡片里
     用户能看到的说明**，于是等于告诉用户一个已经能用的功能不能用。
   ============================================================ */

import { firstMeaningfulLine } from './first-line.ts'

import { parseStyles, styleAttr, isClassAssign, CLASS_DEF_RE, type StyleProps } from './diagram-style.ts'

export interface MindNode {
  id: string
  label: string
  /** 0 = 根 */
  depth: number
  children: MindNode[]
  /** classDef 生成的、已校验转义的 style 属性串；无则 undefined */
  style?: string
  /** classDef 的 `color`（文字色），单独挂在 text 上 */
  labelFill?: string
}

export interface Mindmap {
  root: MindNode | null
  /** 认得但确实没实现的写法（如 `::icon` 的图标、markdown 粗斜体），界面上如实说 */
  skipped: string[]
}

/** 剥掉 `root((知识库))` / `A[标签]` / `B(圆)` / `[类] 名字` 这类外壳，只留显示名。
 *
 *  ⚠️ 之前用一条大正则把「开括号组 / 闭括号组」并排写，开分支里混进了裸 `(`，
 *     整个分组不配对 → 正则直接**编译不过**（`Unmatched ')'`）。
 *     这里改成三段直白的字符串处理，不做花活：
 *       ① 整段被包裹（`((名称))` / `[[名称]]`）→ 取里面
 *       ② 尾部带括号（`A[标签]`）→ 取括号里，`A` 只是 id
 *       ③ 前缀类标记（`[类] 名称`）→ 取类标记之后的文字
 *  注意 mermaid 里 `A[带]括号` 的**显示名**是「带」而不是整串 —— 渲染只需要显示名。 */
export function stripShape(tok: string): { label: string; shaped: boolean } {
  const t = String(tok || '').trim()
  if (!t) return { label: '', shaped: false }

  // ① 整段被包裹
  const OPEN = '([{'
  const CLOSE = ')]}'
  let s = 0, e = t.length
  while (s < e && OPEN.includes(t[s])) s++
  let closes = 0
  while (e > s && CLOSE.includes(t[e - 1])) { closes++; e-- }
  if (s > 0 && closes >= s && e > s) {
    const inner = t.slice(s, e).trim()
    if (inner) return { label: inner, shaped: true }
  }

  // ② 尾部带括号：`A[标签]` / `B(圆)`
  const tail = /[\s]?(\[\[|\(\(|\{\{|\[|\(|\{)([\s\S]*)\]?\}?\)?\)?$/.exec(t)
  if (tail && tail[2].trim() && !t.startsWith(tail[1])) {
    const inner = tail[2].replace(/\s*[\]\)\}]+$/, '').trim()
    if (inner) return { label: inner, shaped: true }
  }

  // ③ 前缀类标记：`[类] 名称`
  const pre = /^\[([^\]]{1,20})\]\s*(\S.*)$/.exec(t)
  if (pre) return { label: pre[2].trim(), shaped: true }

  return { label: t, shaped: false }
}

export function parseMindmap(src: string): Mindmap {
  const out: Mindmap = { root: null, skipped: [] }
  /** 栈：[{ indent, node }]，同一缩进层的父节点在下面 */
  const stack: Array<{ indent: number; node: MindNode }> = []
  /** classDef / `class 名字 名` 的行 */
  const styleLines: string[] = []
  /** 行内 `名称:::class` 收集到的 (显示名, classDef 名) */
  const inlineAssign: Array<[string, string]> = []
  let seq = 0

  for (const raw of String(src || '').split('\n')) {
    if (!raw.trim()) continue
    const indent = (raw.match(/^[\t ]*/)?.[0].replace(/\t/g, '  ').length) ?? 0
    let line = raw.trim()

    if (/^mindmap\b/i.test(line)) continue
    /* classDef / `class A,B name` —— 2026-10-07 接上了共用的样式解析器。
       ⚠️ 必须**在这一步之前**拦：原来它们掉进下面那个「认得但没实现」的分支，
       界面上报「:::class 样式未实现」，而我们其实已经能做了。 */
    if (CLASS_DEF_RE.test(line) || isClassAssign(line)) { styleLines.push(line); continue }
    if (/^\.+\s+\w+\s*:\s*\w+|^\*+\s*$/i.test(line)) {
      out.skipped.push(line.replace(/\s+/g, ' ').slice(0, 50))   // 图标/样式以外的花式写法
      continue
    }

    /* `::icon(fa fa-book) 阅读` —— 图标取不了（要字体图标），但**文字要留**。
       不剥的话界面上会出现一串 `::icon(fa fa-book)`。
       剥了也要**报一笔**：认得、剥了、但没画图标 —— 属于「做不到」那一类，
       静默剥掉就等于假装支持了。 */
    const icons = line.match(/::icon\([^)]*\)/g)
    if (icons) out.skipped.push(`${line.replace(/\s+/g, ' ').slice(0, 40)}（::icon 图标未实现，只取文字）`)
    line = line.replace(/::icon\([^)]*\)\s*/g, '')
    /* `:::className` 样式标记：剥掉 `:::` 但**把名字留下**，等会儿挂到节点上。
       ⚠️ 脑图的节点 id 是自动生成的（m1/m2…），不能按 id 匹配样式，
       所以这里记的是**剥完外壳之后的显示名** —— mermaid 对脑图也是这么认的。 */
    const cls = /:::[\w-]+/.exec(line)
    let inlineClass = ''
    if (cls) { inlineClass = cls[0].replace(':::', ''); line = line.replace(/:::[\w-]+\s*/g, '') }
    line = line.trim()
    if (!line) continue

    const { label } = stripShape(line)
    if (!label) continue
    if (inlineClass) inlineAssign.push([label, inlineClass])

    const node: MindNode = { id: `m${++seq}`, label, depth: 0, children: [] }

    // 弹掉同层或更深的父
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    if (!stack.length) {
      if (!out.root) out.root = node       // 第一行是根
      else { out.skipped.push(line.slice(0, 40)); continue }   // 根之上的第二条同级，认不出
    } else {
      stack[stack.length - 1].node.children.push(node)
    }
    node.depth = stack.length
    stack.push({ indent, node })
  }

  /* classDef → 按**显示名**挂到节点上（见上面那条注释：脑图 id 是自动生成的）。
     `parsed.assign` 的键就是显示名 —— 两种写法（`class A,B 名` 与 `A:::名`）
     都被 parseStyles 归到同一张表里，这里只做一次合并。 */
  if (styleLines.length || inlineAssign.length) {
    const parsed = parseStyles([...styleLines, ...inlineAssign.map(([l, c]) => `${l}:::${c}`)].join('\n'))
    const byLabel = new Map<string, StyleProps>()
    for (const [key, names] of parsed.assign) {
      let acc: StyleProps | null = null
      for (const nm of names) if (parsed.defs.has(nm)) acc = { ...(acc || {}), ...parsed.defs.get(nm)! }
      if (acc) byLabel.set(key, acc)
    }
    const apply = (n: MindNode) => {
      const p = byLabel.get(n.label)
      if (p) {
        n.style = styleAttr(p) || undefined
        n.labelFill = p.color ? String(p.color) : undefined
      }
      n.children.forEach(apply)
    }
    if (out.root) apply(out.root)
    out.skipped.push(...parsed.problems)
  }
  return out
}

/** 一眼看出这份源码是不是脑图 */
export function isMindmapSource(src: string): boolean {
  return /^mindmap\b/i.test(firstMeaningfulLine(src))
}

/* ---------------- 渲染 ---------------- */

const LEVEL_W = 186
const ROW_H = 30
const PAD = 18
const NODE_W = 150
const NODE_H = 26
const ROOT_R = 15

const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function textWidth(s: string, size: number): number {
  let w = 0
  for (const ch of String(s)) w += /[\u2e80-\uffff]/.test(ch) ? size : size * 0.56
  return w
}

function clip(s: string, size: number, maxW: number): string {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of String(s)) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out ? out + '…' : '…'
}

export function renderMindmapSvg(m: Mindmap): string {
  if (!m.root) return ''
  const root = m.root

  /* 先给每个**叶子**按序分配一行，父节点取子节点的纵向中点 ——
     这是树布局最省事也最可预期的做法（不用力导向，不会抖）。 */
  let row = 0
  const pos = new Map<MindNode, { x: number; y: number }>()
  const walk = (n: MindNode): number => {
    if (!n.children.length) {
      const y = row++ * ROW_H
      pos.set(n, { x: PAD + n.depth * LEVEL_W + NODE_W / 2, y })
      return y
    }
    const ys = n.children.map(walk)
    const y = (Math.min(...ys) + Math.max(...ys)) / 2
    pos.set(n, { x: PAD + n.depth * LEVEL_W + NODE_W / 2, y })
    return y
  }
  walk(root)

  const maxRow = row - 1
  /* 根圆**按根名长度**算半径，不能写死。
     写死 15px 时，clip 宽度只剩 24 —— 三个中文字的「知识库」被裁成「知…」，
     而根名恰恰是整张图最重要的那行字。 */
  const rootR = Math.max(ROOT_R, textWidth(root.label, 12) / 2 + 9)
  const maxNodeHalf = NODE_W / 2
  // 最右边那个节点：PAD + (层数-1)*LEVEL_W + 中心x + 半个框
  const w = PAD * 2 + (depth(root) - 1) * LEVEL_W + maxNodeHalf * 2
  const h = PAD * 2 + (maxRow + 1) * ROW_H

  const parts: string[] = []
  // 先画连线（垫在节点下面）
  const edges: string[] = []
  const walkEdges = (n: MindNode) => {
    const p = pos.get(n)!
    for (const c of n.children) {
      const q = pos.get(c)!
      const half = n === root ? rootR : NODE_W / 2
      const x1 = p.x + half
      const x2 = q.x - NODE_W / 2
      const midX = (x1 + x2) / 2
      edges.push(
        `<path d="M${x1},${p.y} C${midX},${p.y} ${midX},${q.y} ${x2},${q.y}" fill="none" class="yq-mm-edge"/>`
      )
      walkEdges(c)
    }
  }
  walkEdges(root)
  parts.push(edges.join(''))

  // 再画节点
  const nodes: string[] = []
  const walkNodes = (n: MindNode) => {
    const p = pos.get(n)!
    const st = n.style || ''
    const tf = n.labelFill ? ` fill="${esc(n.labelFill)}"` : ''
    if (n === root) {
      nodes.push(
        `<circle cx="${p.x}" cy="${p.y}" r="${rootR}" class="yq-mm-root"${st}/>` +
        `<text x="${p.x}" y="${p.y}" text-anchor="middle" dominant-baseline="middle" class="yq-mm-root-text"${tf}>${esc(n.label)}</text>`
      )
    } else if (n.depth === 1) {
      nodes.push(
        `<rect x="${p.x - NODE_W / 2}" y="${p.y - NODE_H / 2}" width="${NODE_W}" height="${NODE_H}" rx="5" class="yq-mm-node"${st}/>` +
        `<text x="${p.x}" y="${p.y}" text-anchor="middle" dominant-baseline="middle" class="yq-mm-text"${tf}>${esc(clip(n.label, 12, NODE_W - 12))}</text>`
      )
    } else {
      /* ⚠️ 第三层**只有文字、没有盒子** —— classDef 的 fill/stroke 挂上去也没有东西可挂。
         这里只挂**文字颜色**，并如实说明：这不是「样式没生效」，是这个形状本身没有面。 */
      nodes.push(`<text x="${p.x}" y="${p.y}" text-anchor="middle" dominant-baseline="middle" class="yq-mm-text"${tf}>${esc(clip(n.label, 11, 150))}</text>`)
    }
    n.children.forEach(walkNodes)
  }
  walkNodes(root)
  parts.push(nodes.join(''))

  return `<svg class="yq-mm-svg" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}" width="${Math.ceil(w)}" height="${Math.ceil(h)}" role="img" aria-label="脑图">` +
    parts.join('') + `</svg>`
}

const depth = (n: MindNode): number =>
  n.children.length ? Math.max(...n.children.map(depth)) + 1 : 1
