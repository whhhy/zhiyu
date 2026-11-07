/* ============================================================
   Graphviz DOT（digraph / graph）→ 复用 Flowchart 的布局与渲染
   ------------------------------------------------------------
   为什么要做：语雀官方《如何插入文本绘图》的五种里，Graphviz 还没做。
   它和 Mermaid 流程图语法不同，但**图结构完全一样**（点、边、方向、
   节点形状、连线标签），所以没必要另写一套布局 —— 这里只做
   「DOT 语法 → Flowchart 结构」这一步转换，布局和出 SVG
   **直接复用 src/lib/flowchart.ts**，零新增依赖、零新增渲染代码。

   覆盖范围**如实标注**：
     · 支持 digraph / graph（有无向边）、strict、rankdir、注释、
       节点形状、边标签；**cluster 里的点与边照常解析**
     · 节点形状 box/rect/ellipse/oval/circle/diamond/doublecircle/
       cylinder/stadium/plaintext/none
   **不支持**：cluster 的**外框**、rank/same 等布局约束、
     HTML 标签、多图与页面尺寸。这些进 `skipped`，界面上如实说明。
   ============================================================ */

import { assignLayers, type FlowNode, type FlowShape, type Flowchart, type FlowGroup } from './flowchart.ts'

/** DOT 的 shape 名 → FlowShape。映射不到的一律当矩形并记进 skipped。 */
const SHAPE_MAP: Record<string, FlowShape> = {
  box: 'rect', rect: 'rect', rectangle: 'rect', square: 'rect',
  plaintext: 'rect', none: 'rect', plain: 'rect', note: 'rect', 'invtriangle': 'rect',
  ellipse: 'round', oval: 'round', egg: 'round',
  circle: 'circle', doublecircle: 'circle', point: 'circle', doubleoctagon: 'circle',
  diamond: 'diamond', mdiamond: 'diamond', invhouse: 'diamond',
  cylinder: 'cylinder', database: 'cylinder',
  stadium: 'stadium', pill: 'stadium', terminal: 'stadium',
}

const toShape = (name: string): FlowShape | null =>
  SHAPE_MAP[String(name || '').toLowerCase()] || null

/** 头部声明。`(?:di)?graph` 才同时吃 `digraph` 与 `graph` ——
 *  写成 `di?graph` 匹配不到 `graph`，于是**无向图整段解析成空**。
 *  ⚠️ 图名是**可选**的：`digraph { a->b }` 是合法 DOT，
 *     要求图名会让这类写法（以及几乎所有手写的小样例）整个认不出来。
 *  ⚠️ 图名**可以是中文**：`digraph 工单流转 { … }` 在本项目里是常态，
 *     而 `[A-Za-z_]` 开头的正则会**整段认不出来，图渲染成空白** ——
 *     不报错、不告警，只是「图不见了」。 */
const NAME = '(?:[A-Za-z_\\u4e00-\\u9fa5][\\w\\u4e00-\\u9fa5]*\\s*)?'
const DOT_HEAD = new RegExp(`^\\s*(strict\\s+)?((?:di)?graph)\\b\\s*${NAME}\\{`, 'i')

/** 端口：`a:n -> b:s` 的 id 是 `a` / `b`，`:n` 是锚点（不实现布局，剥掉） */
const stripPort = (s: string) => s.replace(/^"(?:[^"\\]|\\.)*"$/, (m) => m).split(':')[0].trim()

/** 从 openIdx 处的 `{` 找配对的 `}`（尊重引号）。找不到就返回末尾。 */
function matchBrace(s: string, openIdx: number): number {
  let d = 0, quote = false
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\') { i++; continue }
      if (ch === '"') quote = false
      continue
    }
    if (ch === '"') { quote = true; continue }
    if (ch === '{') d++
    else if (ch === '}') { d--; if (d === 0) return i }
  }
  return s.length
}

export function parseDot(src: string): Flowchart {
  const out: Flowchart = { direction: 'TD', nodes: [], edges: [], skipped: [], groups: [] }
  const byId = new Map<string, FlowNode>()
  /** cluster 的栈。add 要往当前所有 cluster 里登记成员（嵌套时父组也要含子组成员）。 */
  const stack: FlowGroup[] = []

  const add = (id: string, label?: string, shape?: FlowShape | null) => {
    if (!id) return
    let n = byId.get(id)
    if (!n) {
      // ⚠️ layer/order 初始化：解析期就该有，别指望 assignLayers 一定补上
      n = { id, label: label || id, shape: shape || 'rect', layer: 0, order: 0 } as unknown as Flowchart['nodes'][number]
      byId.set(id, n as unknown as typeof n)
      out.nodes.push(n)
    } else {
      if (label) n.label = label
      if (shape) n.shape = shape
    }
    for (const g of stack) if (!g.members.includes(id)) g.members.push(id)
  }

  /* ---------- 属性串 → 键值 ---------- */
  function parseAttrs(s: string): Record<string, string> {
    const attrs: Record<string, string> = {}
    let i = 0
    while (i < s.length) {
      while (i < s.length && /[\s,;]/.test(s[i])) i++
      if (i >= s.length) break
      let key = ''
      while (i < s.length && s[i] !== '=' && !/[\s,;]/.test(s[i])) key += s[i++]
      key = key.trim()
      while (i < s.length && /\s/.test(s[i])) i++
      if (!key || s[i] !== '=') { while (i < s.length && !/[\s,;]/.test(s[i])) i++; continue }
      i++                                             // 跳过 =
      while (i < s.length && /\s/.test(s[i])) i++
      let val = ''
      if (s[i] === '"') {
        i++
        while (i < s.length) {
          if (s[i] === '\\' && i + 1 < s.length) { val += s[i + 1]; i += 2; continue }
          if (s[i] === '"') { i++; break }
          val += s[i++]
        }
      } else {
        while (i < s.length && !/[,;\]}]/.test(s[i])) val += s[i++]
        val = val.trim()
      }
      attrs[key.toLowerCase()] = val
    }
    return attrs
  }

  const clean = (s: string) => String(src || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ').replace(/^\s*#[^\n]*/gm, ' ')

  /** 把一段 body 拆成语句；遇到 `{` 开头的就递归进去（cluster）。 */
  function parseBody(body: string, depth: number) {
    const stmts: string[] = []
    let d = 0, quote = false, buf = ''
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]
      if (quote) {
        buf += ch
        if (ch === '\\') { buf += body[++i] ?? ''; continue }
        if (ch === '"') quote = false
        continue
      }
      if (ch === '"') { quote = true; buf += ch; continue }
      if (ch === '{' || ch === '[') d++
      else if (ch === '}' || ch === ']') {
        if (d === 0 && ch === '}') { if (buf.trim()) stmts.push(buf.trim()); return stmts }
        d--
      }
      if (ch === ';' && d === 0) { if (buf.trim()) stmts.push(buf.trim()); buf = ''; continue }
      if (ch === '\n' && d === 0) { if (buf.trim()) stmts.push(buf.trim()); buf = ''; continue }
      buf += ch
    }
    if (buf.trim()) stmts.push(buf.trim())
    void depth
    return stmts
  }

  function handle(stmt: string, depth: number) {
    const s = stmt.trim()
    if (!s) return

    /* cluster：外框现在**真的画出来**（复用 flowchart 的分组层），
       ⚠️ 里面的点与边照常参与分层 —— 分组只是布局后的装饰。
       ⚠️ 还要处理「`}` 后面还跟着语句」：`subgraph X { a } a->b;`
          后面那条边不能跟着 cluster 一起被吞掉，否则边凭空少一条。 */
    const cl = /^(?:subgraph|cluster[_\w]*)\b([\s\S]*)$/i.exec(s)
    if (cl || s.startsWith('{')) {
      const rest = cl ? cl[1] : s.slice(1)
      const braceAt = rest.indexOf('{')
      const rawName = cl && braceAt < 0 ? rest.trim().replace(/;$/, '') : braceAt < 0 ? '' : rest.slice(0, braceAt).trim()
      const g: FlowGroup = {
        id: rawName || `cluster_${out.groups.length + 1}`,
        label: '', members: [], depth: stack.length,
      }
      stack.push(g)
      out.groups.push(g)
      if (braceAt >= 0) {
        /* ⚠️ matchBrace 必须从 `{` **本身**那个下标起算。
           把 `{` 先 slice 掉再传 0 的话，深度从 0 起步、
           第一个 `}` 就把它打成 -1 —— 于是**后半段 cluster 整段被吞**，
           `subgraph a { x->y } subgraph b { y->z }` 只剩一条边。 */
        const closeAbs = matchBrace(rest, braceAt)
        const inner = rest.slice(braceAt + 1, closeAbs)
        /* `label = "前端";` 是这个 cluster 的显示名，不是节点 */
        for (const st of parseBody(inner, stack.length)) {
          const lm = /^label\s*=\s*(".*"|[^;]+);?$/.exec(st.trim())
          if (lm) { g.label = lm[1].trim().replace(/^["']|["']$/g, ''); continue }
          handle(st, stack.length)
        }
        const tail = rest.slice(closeAbs + 1).trim()
        stack.pop()
        if (tail) handle(tail, stack.length)      // ← cluster 之后的语句照常解析
      } else {
        stack.pop()
      }
      if (!g.label) g.label = g.id
      return
    }

    /* 语句级属性 */
    const gAttr = /^(rankdir|label|bg|fontsize|fontname|splines|ranksep|nodesep)\s*=\s*(.+)$/i.exec(s)
    if (gAttr) {
      if (gAttr[1].toLowerCase() === 'rankdir') {
        const d = gAttr[2].trim().replace(/["']/g, '').toUpperCase()
        out.direction = (d === 'LR' || d === 'RL' || d === 'BT' ? d : 'TD') as Flowchart['direction']
      }
      return
    }

    /* 默认属性：node [shape=diamond] —— 局部默认，不实现但也别当成节点 */
    if (/^(node|edge|graph)\s*\[/i.test(s)) return

    /* 边：A -> B [label="是"] / A -- B
       ⚠️ 端点 token 里**允许冒号**（端口写法），匹配后再剥 ——
          直接把 `:` 排除在 token 外，`a:p -> b:q` 整行会匹配不上、
          被推进 skipped，图上凭空少一条边。 */
    const edge = /^("(?:[^"\\]|\\.)*"|[^\s;[\]{}"]+?)\s*(--|<--|->|<-)\s*("(?:[^"\\]|\\.)*"|[^\s;[\]{}"]+?)\s*(?:\[([\s\S]*)\])?\s*;?$/.exec(s)
    if (edge && !/^(graph|node|edge|strict)$/i.test(edge[1])) {
      const from = stripPort(edge[1]), to = stripPort(edge[3])
      if (!from || !to) return
      const attrs = edge[4] ? parseAttrs(edge[4]) : {}
      add(from); add(to)
      out.edges.push({ from, to, label: attrs.label || '', arrow: edge[2].includes('>') || edge[2].startsWith('<') ? 'solid' : 'none' })
      return
    }

    /* 节点：A [label="开始", shape=diamond] / 裸 a */
    const node = /^("(?:[^"\\]|\\.)*"|[^\s;[\]{}"]+?)\s*(?:\[([\s\S]*)\])?\s*;?$/.exec(s)
    if (node && node[1] && !/^(graph|node|edge|strict)$/i.test(node[1])) {
      const attrs = node[2] ? parseAttrs(node[2]) : {}
      const rawShape = attrs.shape
      const shape = rawShape ? toShape(rawShape) : null
      if (rawShape && !shape) out.skipped.push(`shape=${rawShape}（认不出，按矩形画）`)
      add(stripPort(node[1]), attrs.label, shape)
      return
    }

    out.skipped.push(s.replace(/\s+/g, ' ').slice(0, 60))
  }

  const text = clean(src)
  const head = DOT_HEAD.exec(text)
  if (!head) return out
  const body = text.slice(head[0].length, text.lastIndexOf('}') >= 0 ? text.lastIndexOf('}') : undefined)
  for (const st of parseBody(body, 0)) handle(st, 0)

  /* ⚠️ 分层不能漏：漏了每个节点都是 `layer: undefined`，
     渲染时整张图挤成一坨，而 SVG 照样生成成功 —— 只是「图怪」，不报错。 */
  assignLayers(out.nodes as unknown as Flowchart['nodes'], out.edges)
  return out
}

/** 一眼看出这份源码是不是 DOT（供界面切换渲染方式用） */
export function isDotSource(src: string): boolean {
  return DOT_HEAD.test(String(src || '').trim())
}