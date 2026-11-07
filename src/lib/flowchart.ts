/* ============================================================
   Flowchart（graph / flowchart 语法）→ 原生 SVG
   ------------------------------------------------------------
   为什么要写这个：语雀官方帮助《如何插入文本绘图》列的是
   **PlantUML / Mermaid / Flowchart / Graphviz / Gantt** 五种，
   我们只做了 PlantUML —— 而 PlantUML 那边还只能出结构预览
   （真渲染要 PlantUML Server，联网）。

   Flowchart 是这五种里**最常用、也最便宜**的一种：语法就几行，
   完全能本地渲染，不必引 mermaid 那个库 —— 而本项目最看重
   「内网机器上少一个依赖」。所以它成了第一个补上的
   （现在五种里 PlantUML 只出结构预览，其余都本地出 SVG）。

   ⚠️ 覆盖范围是**如实标注**的，不是「假装全支持」：
     · 支持 graph/flowchart 的方向、连线、四种最常见节点形状、连线标签、链式连线
     · 支持 **subgraph 分组框**（可嵌套）与 **classDef 样式**（含 `:::` 行内标记，
       走 `diagram-style.ts` 的白名单校验）
     · **不支持**组内单独换方向（subgraph 里不能改 direction）
   ⚠️ 上面这条清单以前写的是「不支持 subgraph、classDef」——
     那两个**后来都做了**（subgraph 是分组框，classDef 见 `applyStyles`）。
     注释比代码旧不会只是「不好看」：卡片里那段说明是**用户会读到的**，
     写着「不支持 classDef」等于告诉用户一个已经能用的功能不能用。
   ============================================================ */

import { parseStyles, styleForNode, styleAttr, isClassAssign, CLASS_DEF_RE } from './diagram-style.ts'

export type FlowShape =
  | 'rect' | 'round' | 'stadium' | 'cylinder' | 'circle' | 'diamond'
  /** 实心小圆点。stateDiagram 的 `[*]`（起始/终止）用这个 —— 
   *  用 `circle` 画会是个空心圈，跟「起点」这个意思差很远。 */
  | 'dot'
  /** 并发区域的分岔 / 汇合（`state X <<fork>>` / `<<join>>`）。
   *  ⚠️ 画成**粗横杠**而不是普通状态框：横杠是状态图里「这里分岔/汇合」的
   *     通用画法；而画成圆角框等于宣称「这是个状态」—— 它其实是路由点，
   *     画错了读者会以为凭空多了一个流程步骤。 */
  | 'fork' | 'join'

export interface FlowNode {
  id: string
  label: string
  shape: FlowShape
  layer: number
  order: number
  /** 由 `classDef` 生成的、**已校验并转义**的 style 属性串（形如 ` style="fill:#f9f"`）。
   *  为空表示这个节点没挂样式。值来自 `diagram-style.ts`，那里是白名单过滤过的 ——
   *  不要绕过它自己拼 `style`，那是全文唯一一处「用户源码 → HTML 属性」的路。 */
  style?: string
  /** `classDef` 的 `color`（文字色），单独挂在 text 上。
   *  为什么单独一个字段：形状的 fill 与文字的 color 在 mermaid 里是两件事，
   *  合成一个 style 挂到 rect 上，文字不会跟着变色（文字有自己的 class）。 */
  labelFill?: string
  /** 宽高。**缺省就是 NODE_W / NODE_H**，所以不设它们的行为与以前逐字一致 ——
   *  复合态那个框比普通状态大，才需要显式给。 */
  w?: number
  h?: number
  /** 复合态的内部子图（**局部坐标**，递归布局时算好）。
   *  有它就不按普通节点画，而是画一个大框 + 顶部标题 + 框内的子节点与子连线。
   *  ⚠️ 为什么不给「内层也放一套分组框」：那样会出现**两个框**
   *     （一个是我算出来的复合态尺寸，一个是通用分组框按成员反推的），
   *     两者差几像素时读者会以为画错了 —— 而那正是这轮要消灭的那类问题。 */
  inner?: {
    nodes: Array<{ n: FlowNode; x: number; y: number }>
    /** 两端点都已是**局部绝对坐标**（内层布局算好的） */
    edges: Array<{ e: FlowEdge; ax: number; ay: number; bx: number; by: number }>
  }
  /** 状态图旁注（`note right of A : …`）。挂在**节点 id** 上，
   *  渲染时按位置画在旁边的小框里。别的图种不用这一项。 */
  notes?: Array<{ side: 'left' | 'right' | 'over'; text: string }>
}

export interface FlowEdge {
  from: string
  to: string
  label: string
  /** 箭头样式：实线 / 虚线 / 粗线 / 无箭头 */
  arrow: 'solid' | 'dotted' | 'thick' | 'none'
}

/** 一个分组（mermaid 的 `subgraph` / DOT 的 `cluster`）。
 *  ⚠️ 分组**不影响分层** —— 里面的点与边照常参与 BFS，
 *     否则「分组后节点不在第 0 层」的图会整体错位。
 *     框是布局**之后**按成员的坐标反推出来的一层装饰。 */
export interface FlowGroup {
  id: string
  label: string
  /** 成员节点 id；嵌套时父组同时包含子组的成员 */
  members: string[]
  /** 0 = 最外层 */
  depth: number
}

export interface Flowchart {
  direction: 'TD' | 'BT' | 'LR' | 'RL'
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** 解析时跳过的行数不为 0 —— 说明有一部分语法我们不认，界面要如实说 */
  skipped: string[]
  groups: FlowGroup[]
  /** 状态图的旁注（`note right of 已发货 : 客户已签收`）。
   *  按**节点 id** 索引，渲染时画在该节点旁边的小框里。
   *  别的图种不用这一项 —— 放在 Flowchart 上是因为状态图复用这个渲染器，
   *  再造一套渲染就等于把同一件事写两遍。 */
  notes?: Array<{ target: string; side: 'left' | 'right' | 'over'; text: string }>
}

const NODE_W = 168
const NODE_H = 40
const GAP_X = 56
const GAP_Y = 64
/** 分组框与成员之间的留白，以及框顶部放标签要额外让出的高度 */
const GROUP_MARGIN = 14
const GROUP_DEPTH_MARGIN = 12
const GROUP_LABEL_H = 18

/** 粗略量文字宽度：中文按字号算，西文按 0.56 字号算。分组标签要用它裁一下。 */
function clipText(s: string, size: number, maxW: number): string {
  const tw = (t: string) => {
    let n = 0
    for (const ch of String(t)) n += /[\u2e80-\uffff]/.test(ch) ? size : size * 0.56
    return n
  }
  if (tw(s) <= maxW) return s
  let out = ''
  for (const ch of String(s)) {
    if (tw(out + ch + '…') > maxW) break
    out += ch
  }
  return out ? out + '…' : '…'
}

/* 节点形状的括号写法。**顺序有讲究**：长写法必须排在短写法前面，
   否则 `([…])` 会先被 `([…]` 吃掉。
   捕获组与形状的对应关系写死在 SHAPE_KIND 里 —— 第一版用「第几组 → 什么形状」
   的下标推算（把 `[]` 映成 diamond），于是 `A[开始]` 全被认成菱形。 */
const SHAPE_RE = /\(\[\s*([^\]]*?)\s*\]\)|\[\[\s*([^\]]*?)\s*\]\]|\(\(\s*([^)]*?)\s*\)\)|\[\(\s*([^\]]*?)\s*\)\]|\(\s*([^)]*?)\s*\)|\[\s*([^\]]*?)\s*\]|\{\s*([^{}]*?)\s*\}|>\s*([^\]]*?)\s*\]/
const SHAPE_KIND: Record<number, FlowShape> = {
  1: 'stadium',   // ([ ])
  2: 'rect',      // [[ ]] 子程序，本地渲染里与矩形不再区分
  3: 'circle',    // (( ))
  4: 'cylinder',  // [( )]
  5: 'round',     // ( )
  6: 'rect',      // [ ]
  7: 'diamond',   // { }
  8: 'rect',      // > ]
}

/** 这些是 mermaid 的声明行，不是节点 —— 认成节点会凭空多一个方框 */
const DIRECTIVE = /^(subgraph|end|classDef|class|linkStyle|style|click|direction|direction\s)\b/i

function classify(tok: string): { id: string; label: string; shape: FlowShape } | null {
  const t = tok.trim()
  if (!t) return null
  if (DIRECTIVE.test(t)) return null
  const m = /^([A-Za-z0-9_.\u4e00-\u9fa5-]+)\s*(.*)$/.exec(t)
  if (!m) return null
  const id = m[1]
  const rest = (m[2] || '').trim()
  if (!rest) return { id, label: id, shape: 'rect' }
  const s = SHAPE_RE.exec(rest)
  if (!s) return { id, label: id, shape: 'rect' }
  for (let k = 1; k <= 8; k++) {
    if (s[k] === undefined) continue
    return { id, label: (s[k] || '').trim() || id, shape: SHAPE_KIND[k] }
  }
  return { id, label: id, shape: 'rect' }
}

const arrowKind = (tok: string): FlowEdge['arrow'] => {
  const a = tok.trim()
  if (a.startsWith('-.') || a.startsWith('-.')) return 'dotted'
  if (a.startsWith('==') || a.startsWith('==')) return 'thick'
  return a.endsWith('-->') ? 'solid' : 'none'
}

/** 方向。默认 TD（从上到下）—— 这是绝大多数流程图的样子 */
function parseDirection(kw: string): Flowchart['direction'] {
  const d = String(kw || '').toUpperCase()
  if (d === 'BT' || d === 'TB') return 'BT'
  if (d === 'LR') return 'LR'
  if (d === 'RL') return 'RL'
  return 'TD'
}

/**
 * 按箭头切开一行，返回 [段, 箭头, 段, 箭头, …]。
 *
 * 为什么不用 `split(/(\s-->\s|…)/)`：
 *   ① `\s-->\s` 要求箭头**后面**也有空白，于是 `B -->|是| C` 整行切不开 ——
 *      带标签的连线全被当成一个节点，后面那个节点也一起丢了。
 *   ② `A-->B`（不带空格）是 mermaid 的合法写法，纯空白匹配同样接不住。
 * 这里改成**按括号深度扫描**：箭头只在深度 0 时才算，
 * 这样 `A[step --> next]` 这种标签里带箭头的写法也不会被切错。
 */
const ARROW_TOKENS = ['-.->', '-.-', '==>', '===', '-->', '---']

function splitChain(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let buf = ''
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (ch === '[' || ch === '(' || ch === '{') depth++
    else if (ch === ']' || ch === ')' || ch === '}') depth = Math.max(0, depth - 1)
    if (depth === 0) {
      const arrow = ARROW_TOKENS.find((a) => s.startsWith(a, i))
      if (arrow) {
        out.push(buf, arrow)
        buf = ''
        i += arrow.length
        continue
      }
    }
    buf += ch
    i++
  }
  out.push(buf)
  return out
}

/** `subgraph 名字 [显示名]` / `subgraph [显示名]`
 *  ⚠️ 名字与显示名要分开：`subgraph 前端` 两者相同，
 *     而 `subgraph fe 前端` 的 id 是 fe、画在框上的是「前端」。 */
const SUBGRAPH_RE = /^subgraph\b\s*(?:([^\s\[]+)\s*)?(?:\[([^\]]*)\])?/i

/** 把 `subgraph …` 与 `end` 从「不认识的写法」里摘出来。
 *  它们**是被认识的**（只是外框画不画是另一回事）——
 *  报成「不认」是假告警，用户会去查一个不存在的问题。 */
export function isGroupDirective(line: string): 'open' | 'close' | null {
  const t = line.trim()
  if (SUBGRAPH_RE.test(t)) return 'open'
  if (/^end\b/i.test(t)) return 'close'
  return null
}

/** 从一行里取分组的 id 与显示名 */
export function parseGroupHeader(line: string, fallbackId: string): { id: string; label: string } {
  const m = SUBGRAPH_RE.exec(line.trim())
  const id = (m?.[1] || '').trim()
  const label = (m?.[2] || '').trim().replace(/^["']|["']$/g, '')
  return { id: id || fallbackId, label: label || id || fallbackId }
}

/** 把源码解析成一张图。**只解析**，不渲染 —— 渲染是纯函数，好单测。 */
export function parseFlowchart(src: string): Flowchart {
  const out: Flowchart = { direction: 'TD', nodes: [], edges: [], skipped: [], groups: [] }
  const byId = new Map<string, FlowNode>()
  /** 分组的栈。**必须先于 add 声明** —— add 要往当前所有分组里登记成员。 */
  const stack: FlowGroup[] = []
  /** classDef / `class A,B name` 的行，交给共用的样式解析器。
   *  流程图里**没有**「类声明」这种歧义（那是类图才有的），所以两类行都在这收。 */
  const styleLines: string[] = []
  /** 行内 `X:::name` 收集到的 (节点 id, classDef 名) */
  const inlineAssign: Array<[string, string]> = []

  const add = (c: { id: string; label: string; shape: FlowShape }) => {
    let n = byId.get(c.id)
    if (!n) {
      n = { id: c.id, label: c.label, shape: c.shape, layer: 0, order: 0 }
      byId.set(c.id, n)
      out.nodes.push(n)
    } else if (c.label !== c.id) {
      n.label = c.label           // 后出现的定义覆盖前面的
      n.shape = c.shape
    }
    // 归到**所有**外层分组（嵌套时父组也要包含子组的成员，否则框会画小）
    for (const g of stack) if (!g.members.includes(c.id)) g.members.push(c.id)
  }

  for (const raw of String(src || '').split('\n')) {
    let line = raw.trim()
    if (!line) continue
    if (line.startsWith('%%')) continue                      // mermaid 注释

    /* classDef / class A,B name —— 这两行**不是「不认识的写法」**。
       原来它们直接掉进 skipped，界面上报「不认」，
       而用户明明写了 classDef 却看到一句「不支持」，会去查一个不存在的问题。 */
    if (CLASS_DEF_RE.test(line) || isClassAssign(line)) { styleLines.push(line); continue }

    /* 行内 `A:::name` / `A[标签]:::name` / `B:::name`（连线末端那种）。
       ⚠️ 先摘掉再交给 handleLine，否则 `:::name` 会被当成节点 id 的一部分 ——
          于是多出一个叫「A:::name」的幽灵节点，而真正的 A 反而没有样式。
       ⚠️⚠️ 回调**必须把节点本身还回去**。第一版返回空串，
          于是 `A[开始]:::hot --> B[处理]` 变成 ` --> B[处理]` ——
          A 连同它的标签**整个消失**，而图照样画得出来、只是少了一个节点。
          这种「少内容但完全没报错」是最难查的一类。 */
    line = line.replace(
      /([A-Za-z_][\w-]*)((?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?)\s*:::\s*([A-Za-z_][\w-]*)/g,
      (_m, id: string, shape: string, cls: string) => { inlineAssign.push([id, cls]); return id + shape }
    ).trim()

    const head = /^(graph|flowchart)\b\s*(\w+)?/i.exec(line)
    if (head) {
      out.direction = parseDirection(head[2] || 'TD')
      const rest = line.slice(head[0].length).trim()
      for (const part of rest.split(';')) if (part.trim()) handleLine(part.trim(), add, out)
      continue
    }
    /* 分组：`subgraph …` / `end`。**不是「不认识的写法」** —— */
    const dir = isGroupDirective(line)
    if (dir === 'open') {
      const hdr = parseGroupHeader(line, `sg${out.groups.length + 1}`)
      stack.push({ id: hdr.id, label: hdr.label, members: [], depth: stack.length })
      out.groups.push(stack[stack.length - 1])
      continue
    }
    if (dir === 'close') { stack.pop(); continue }
    /* `direction TB` 写在 subgraph 里面是合法且常见的（组内单独换方向）。
       我们**做不到**组内方向（要重跑一遍布局），但它是**认识的**——
       报成「不认识的写法」是假告警，用户会去查一个不存在的问题。
       这里给一句能照着改的话。 */
    const dg = /^direction\s+(\w+)/i.exec(line)
    if (dg && stack.length) {
      out.skipped.push(`分组内 direction ${dg[1]}（本地渲染器不换组内方向，已按整图方向画）`)
      continue
    }
    handleLine(line, add, out)
  }

  assignLayers(out.nodes, out.edges)

  /* classDef → 节点样式。**在分层之后**做：样式不影响布局，
     早期做会让「样式解析失败」和「布局失败」两种错误混在一起。 */
  applyStyles(out, styleLines, inlineAssign)
  return out
}

/**
 * 把 classDef / class / `X:::name` 落到节点上。
 *
 * ⚠️ 单独抽出来是因为**状态图与 DOT 都走 parseFlowchart** ——
 *    状态图在 mermaid 里同样支持 classDef，零成本就一起有了；
 *    而如果样式逻辑写在主循环里，DOT 的解析就得再抄一遍。
 */
function applyStyles(
  out: Flowchart,
  styleLines: string[],
  inlineAssign: Array<[string, string]>,
): void {
  if (!styleLines.length && !inlineAssign.length) return
  const parsed = parseStyles([...styleLines, ...inlineAssign.map(([id, c]) => `${id}:::${c}`)].join('\n'))
  for (const n of out.nodes) {
    const p = styleForNode(parsed, n.id)
    if (!p) continue
    n.style = styleAttr(p) || undefined
    n.labelFill = p.color ? String(p.color) : undefined
  }
  out.skipped.push(...parsed.problems)
}

/**
 * 一行 → 节点与边。
 *
 * 第一版在这里漏掉了**链式连线的最后一段**：
 * `A --> B` 按箭头切开后是 ['A ', '-->', ' B']，第三段后面没有箭头，
 * 代码里 `if (!arrowTok) continue` 就把 B 整段丢掉了 ——
 * 结果是「一条边都没有、节点少一个」，而界面看上去只是图空着。
 */
function handleLine(line: string, add: (c: { id: string; label: string; shape: FlowShape }) => void, out: Flowchart) {
  // 归一化 `A -- 文字 --> B`：先改成 `A -->|文字| B`，后面一条道处理
  let body = line.replace(/;\s*$/, '')
  body = body.replace(/(-{2,})\s*([^->|]+?)\s*(-{2,}>)/g, (_m, a: string, t: string, b: string) => `${a.slice(0, 2)}>|${t.trim()}|${b.slice(-3)}`)

  const chain = splitChain(body)
  if (chain.length === 1) {
    const c = classify(body)
    if (c) add(c)
    else if (body.trim()) out.skipped.push(body.trim())
    return
  }

  let prev: { id: string } | null = null
  let carried = ''
  for (let i = 0; i < chain.length; i += 2) {
    let seg = chain[i].trim()
    /* 箭头在**上一段后面**：`A --> B` 切开后是 ['A', ' --> ', 'B']，
       那个箭头属于 A→B 这条边，但它挂在 chain[i-1] 上。
       第一版写成「看当前段后面的箭头」—— 于是每条边的箭头都晚了一步，
       结果是**一条边都连不上**，而界面看上去只是「图空着」。
       这也是为什么上面的 D/E/边数/标签/虚线会一起红：它们全是同一个根因。 */
    const arrowBefore = i >= 2 ? String(chain[i - 1] || '').trim() : ''
    // 形如 `|是| C`：标签挂在箭头右边，剥掉再认节点
    let segLabel = ''
    const lm = /^\|([^|]*)\|\s*(.*)$/.exec(seg)
    if (lm) { segLabel = lm[1].trim(); seg = lm[2].trim() }

    const cur = classify(seg)
    if (!cur) {
      if (seg) out.skipped.push(seg)
      prev = null                     // 认不出的段**不能**跨过去连线
      carried = ''
      continue
    }
    add(cur)
    if (prev && arrowBefore) {
      out.edges.push({ from: prev.id, to: cur.id, label: segLabel || carried, arrow: arrowKind(arrowBefore) })
    }
    carried = segLabel
    prev = cur
  }
}

/**
 * 分层。
 *
 * ⚠️ 这里**不能**用拓扑排序 / 最长路径松弛：真实流程图里**经常有环**
 *（重试、回退、「不通过就回到第一步」），而**有环的图没有拓扑序**。
 * 第一版就是「迭代松弛层号」，在环上每轮都涨、40 轮跑满也不收敛 ——
 * 层号被推到 118，图整个撑到几千像素高，而界面上只是「图好大」。
 *
 * 改成 **BFS 跳数**：从源码里第一个节点出发（稳定、可预期，
 * 也符合「流程图的第一个节点就是起点」的直觉），每跳一层。
 * visited 集合天然让环停下，不会死循环也不会撑爆。
 * 代价：菱形图 `A→B,A→C,B→D,C→D` 里 D 会落在第 2 层而不是第 3 层 ——
 * 视觉上略微紧凑一点，对流程图来说没问题，如实说明而不是假装是拓扑序。
 */
/**
 * 分层 + 定序。**对外导出**，因为 `src/lib/dot.ts` 把 DOT 解析成同一套
 * Flowchart 结构后要走同一套布局。
 *
 * ⚠️ 别漏掉这一步：漏了的话每个节点都是 `layer: undefined`，
 * 渲染时 `byLayer` 只有一把 undefined 键，图会挤成一坨 ——
 * 而 SVG 字符串仍然生成成功，**看起来只是「图怪」**，不报错。
 */
export function assignLayers(nodes: FlowNode[], edges: FlowEdge[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  /* ⚠️ **先**把所有节点的 layer/order 兜底成 0。
   *    BFS 只走得到**从起点可达**的那些节点；复合状态内部的迁移
   *    （`[*] --> 申请中`）不从复合态本身出发，于是那一整块节点
   *    压根不会被访问到。
   *    不兜底的话它们是 `undefined`，渲染时 `byLayer` 只有一把
   *    undefined 键 —— 图挤成一坨，**而 SVG 照样生成成功**。
   *    （这与「漏调 assignLayers」是同一族，只是更隐蔽：这次调了。） */
  for (const n of nodes) { if (typeof n.layer !== 'number') n.layer = 0; if (typeof n.order !== 'number') n.order = 0 }
  const succ = new Map<string, string[]>()
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue
    const list = succ.get(e.from) || []
    if (!list.includes(e.to)) list.push(e.to)
    succ.set(e.from, list)
  }

  const first = nodes[0]
  if (first) {
    const seen = new Set<string>([first.id])
    let frontier = [first.id]
    let depth = 0
    while (frontier.length) {
      for (const id of frontier) { const n = byId.get(id); if (n) n.layer = depth }
      const next: string[] = []
      for (const id of frontier) for (const t of succ.get(id) || []) if (!seen.has(t)) { seen.add(t); next.push(t) }
      frontier = next
      depth++
      if (depth > nodes.length + 2) break     // 兜底：理论上到不了这里
    }
    // 环外的孤立节点留在第 0 层，不至于飘到图外
  }

  // 同一层里的顺序 = 在源码里第一次出现的顺序（可预期，不随遍历抖动）
  const seen = new Map<string, number>()
  for (const e of edges) for (const id of [e.from, e.to]) if (!seen.has(id)) seen.set(id, seen.size)
  for (const n of nodes) if (!seen.has(n.id)) seen.set(n.id, seen.size)
  for (const n of nodes) n.order = seen.get(n.id) ?? 0
}

const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 一个节点的 SVG 片段。菱形与圆柱用不同形状，其余是矩形/圆角/跑道/圆。 */
function nodeSvg(n: FlowNode, x: number, y: number): string {
  const W = n.w || NODE_W
  const H = n.h || NODE_H
  const cx = x + W / 2
  const cy = y + H / 2
  /* 形状样式（classDef 的 fill/stroke/…）与**文字颜色**是分开的两个属性：
     文字有自己的 class，把 fill 一起塞进 text 会变成「字的填充 = 无」。 */
  const st = n.style || ''
  const tFill = n.labelFill ? ` fill="${esc(n.labelFill)}"` : ''

  /* 复合态：一个大框 + 顶部标题 + 框内的子图。
     ⚠️ 子图用 `<g transform>` 整体平移，而不是给每个子节点重算坐标 ——
        坐标一旦在这里再算一遍，就和 statediagram 算的那份对不上了，
        而那种偏差在图上只是「框稍微歪一点」，最难发现。 */
  if (n.inner) {
    const body =
      n.inner.edges.map((e) => edgeSvg(e.e, { x: e.ax, y: e.ay }, { x: e.bx, y: e.by })).join('') +
      n.inner.nodes.map((c) => nodeSvg(c.n, c.x, c.y)).join('')
    return `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="7" class="yq-fc-node yq-fc-composite"${st}/>` +
      `<text x="${x + 8}" y="${y + 13}" class="yq-fc-group-label">${esc(clipText(n.label, 11, W - 16))}</text>` +
      `<g transform="translate(${x}, ${y})">${body}</g>`
  }

  const t = `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" class="yq-fc-label"${tFill}>${esc(n.label)}</text>`
  let shape = ''
  /* 下面的 W / H 取代了原来直接写死的 NODE_W / NODE_H ——
     复合态那个大框不走这个分支（上面已经 return 了），但留着统一写法，
     免得以后有人加形状时又写回常量，那会让大框的子节点尺寸对不上。 */
  switch (n.shape) {
    case 'diamond':
      shape = `<polygon points="${cx},${y} ${x + W},${cy} ${cx},${y + H} ${x},${cy}" class="yq-fc-node yq-fc-diamond"${st}/>`
      break
    case 'cylinder': {
      const ry = 9
      shape = `<path d="M${x},${y + ry} A ${W / 2} ${ry} 0 0 1 ${x + W},${y + ry} L${x + W},${y + H - ry} A ${W / 2} ${ry} 0 0 1 ${x},${y + H - ry} Z" class="yq-fc-node"${st}/>`
      break
    }
    case 'circle': {
      const r = H / 2
      shape = `<ellipse cx="${cx}" cy="${cy}" rx="${r}" ry="${r}" class="yq-fc-node"${st}/>`
      break
    }
    case 'stadium':
      shape = `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="${H / 2}" class="yq-fc-node"${st}/>`
      break
    case 'dot': {
      const r = 9
      shape = `<circle cx="${cx}" cy="${cy}" r="${r}" class="yq-fc-dot"${st}/>`
      return shape                          // 没有文字，`[*]` 就是个点
    }
    /* 并发区域的分岔/汇合：**一根横杠**，横贯整个节点宽度。
       ⚠️ 高度比普通节点小得多（9px vs 40px）—— 画成普通框的话，
       读者会以为那是个状态，而它其实是路由点。 */
    case 'fork':
    case 'join': {
      const bh = 9
      shape = `<rect x="${x}" y="${cy - bh / 2}" width="${W}" height="${bh}" rx="${bh / 2}" class="yq-fc-fork"${st}/>`
      return shape                          // 没有文字
    }
    case 'round':
      shape = `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="10" class="yq-fc-node"${st}/>`
      break
    default:
      shape = `<rect x="${x}" y="${y}" width="${W}" height="${H}" rx="3" class="yq-fc-node"${st}/>`
  }
  return shape + t
}

export interface LayoutResult {
  pos: Map<string, { x: number; y: number }>
  /** 跨层方向（垂直布局时的 y / 水平布局时的 x）的总长 */
  spanMain: number
  /** 层内排列方向的总长 */
  spanCross: number
}

/**
 * 分层 + 排坐标。**唯一的一份布局数学** ——
 * `renderFlowchartSvg` 与状态图的复合态递归布局都调它。
 *
 * ⚠️ 为什么必须共用：状态图要算「复合态里面那几个状态排成什么样」，
 *    如果在那里另写一份，两个算法就会在**某个边界情况上不一致** ——
 *    而图上只是「框和内容差几像素」，看不出是两份算法不一致。
 *    这正是本项目反复踩的那一类（「看起来对，其实偏了」）。
 *
 * 尺寸逐节点取（`n.w` / `n.h`，缺省就是 NODE_W / NODE_H），
 * 所以既有图种的行为与抽出前**逐字一致**。
 */
export function layoutNodes(
  nodes: FlowNode[],
  edges: FlowEdge[],
  direction: Flowchart['direction'],
): LayoutResult {
  const horizontal = direction === 'LR' || direction === 'RL'
  const byLayer = new Map<number, FlowNode[]>()
  for (const n of nodes) {
    const list = byLayer.get(n.layer) || []
    list.push(n)
    byLayer.set(n.layer, list)
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b)
  if (!layers.length) return { pos: new Map(), spanMain: 0, spanCross: 0 }

  /* 两条轴的步进要分开：水平方向时「层推进」走 x 的尺寸、
     「层内排列」走 y 的尺寸，写反了横排图会整体歪掉。 */
  const wOf = (n: FlowNode) => n.w || NODE_W
  const hOf = (n: FlowNode) => n.h || NODE_H
  const alongStep = (n: FlowNode) => (horizontal ? hOf(n) + GAP_Y : wOf(n) + GAP_X)
  const mainStep = (n: FlowNode) => (horizontal ? wOf(n) + GAP_X : hOf(n) + GAP_Y)
  const alongGap = horizontal ? GAP_Y : GAP_X
  const mainGap = horizontal ? GAP_X : GAP_Y

  const ordered = layers.map((l) => (byLayer.get(l) || []).slice().sort((a, b) => a.order - b.order))
  /* 跨轴要能装下**最宽的那一层**：原来用「最多节点数 × 固定步进」，
     节点大小不一样时那是不对的（一个复合态就足以把整层顶宽）。 */
  const spanMain = Math.max(...ordered.map((list) => list.reduce((a, n) => a + alongStep(n), 0) - alongGap))
  const spanCross = ordered.reduce((a, list) => a + list.reduce((s, n) => s + mainStep(n), 0), 0) - mainGap

  const pos = new Map<string, { x: number; y: number }>()
  /* 层推进改成**逐层累加**：原来 `li * 固定步进`，大小不等时那会把后面的层压上去 */
  const layerMainStart: number[] = []
  const layerMainSize = ordered.map((list) => list.reduce((s, n) => s + mainStep(n), 0))
  let acc = 0
  for (let i = 0; i < ordered.length; i++) { layerMainStart.push(acc); acc += layerMainSize[i] }
  const totalMain = acc

  ordered.forEach((list, li) => {
    const width = list.reduce((a, n) => a + alongStep(n), 0) - alongGap
    const offset = (spanMain - width) / 2
    let along = offset
    for (const n of list) {
      const main = (direction === 'RL' || direction === 'BT')
        ? totalMain - layerMainStart[li] - layerMainSize[li]
        : layerMainStart[li]
      pos.set(n.id, horizontal ? { x: main, y: along } : { x: along, y: main })
      along += alongStep(n)
    }
  })

  return { pos, spanMain, spanCross }
}

/** 箭头。只在终点那一侧留出半个节点的高度，线不会压到框里。 */
function edgeSvg(
  e: FlowEdge,
  a: { x: number; y: number },
  b: { x: number; y: number },
  sa: { w: number; h: number } = { w: NODE_W, h: NODE_H },
  sb: { w: number; h: number } = { w: NODE_W, h: NODE_H },
): string {
  const ax = a.x + sa.w / 2, ay = a.y + sa.h / 2
  const bx = b.x + sb.w / 2, by = b.y + sb.h / 2
  const dx = bx - ax, dy = by - ay
  const len = Math.hypot(dx, dy) || 1
  // 从两端各缩进半个框的半径，线才不会从框里穿出去。
  // ⚠️ 两端各用**自己**的尺寸：复合态那端是「整个框」，拿小节点的尺寸去缩进，
  //    线会从框的**正中**插进来 —— 看起来就是线穿过了框。
  const pad = (Math.min(sa.w, sa.h) + Math.min(sb.w, sb.h)) / 4
  const x1 = ax + (dx / len) * (pad * 0.55)
  const y1 = ay + (dy / len) * (pad * 0.55)
  const x2 = bx - (dx / len) * pad
  const y2 = by - (dy / len) * pad
  const dash = e.arrow === 'dotted' ? ' stroke-dasharray="5 4"' : ''
  const w = e.arrow === 'thick' ? 2.4 : 1.4
  const marker = e.arrow === 'none' ? '' : ' marker-end="url(#yq-fc-arrow)"'
  const label = e.label
    ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle" class="yq-fc-edge-label">${esc(e.label)}</text>`
    : ''
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="yq-fc-edge" stroke-width="${w}"${dash}${marker}/>` + label
}

/**
 * 图 → SVG 字符串。
 * 方向：TD/BT 上下排、LR/RL 左右排；RL/BT 只需把坐标倒过来，不用另一套算法。
 * 画布高度随层数增长 —— 节点多了会自动往下铺，不会挤成一团。
 */
export function renderFlowchartSvg(fc: Flowchart): string {
  if (!fc.nodes.length) return ''
  /* 布局数学在 layoutNodes 里（状态图的复合态递归也调它），
     这里只负责把结果翻译成 SVG。 */
  const { pos, spanMain, spanCross } = layoutNodes(fc.nodes, fc.edges, fc.direction)
  const horizontal = fc.direction === 'LR' || fc.direction === 'RL'
  /* 分组框：布局**之后**按成员坐标反推，纯装饰层，不参与分层。
     ⚠️ 先算框、再撑画布 —— 框带一圈留白、顶部还要放标签，
        只按节点算 viewBox 的话，**包住整张图的那个框会被裁掉**。
     ⚠️ 成员里可能有解析不出来的 id（引用了不存在的节点），跳过它们，
        但不能让整个框消失。
     ⚠️ 按 depth 升序（外层先、内层后），嵌套时内层才压在外层上面。 */
  const groups = fc.groups || []
  /* 留白按**层数反向**递增：`depth` 越小（越外层）留白越多，
     外框才真正**包住**内框。
     ⚠️ 反过来写（越外层留白越少）时，父子组顶边距同一个节点起算，
        外框顶边会落在内框**下面** —— 画出来是两个平行的框，
        嵌套等于没画。第一版就是这么错的，只有看像素才发现。 */
  const maxDepth = groups.reduce((m, g) => Math.max(m, g.depth), 0)
  const boxes = groups.map((g) => {
    /* ⚠️ 成员可能大小不一（subgraph 里套了复合态），所以要先按 id 找回
       节点本身再取它的 w/h。拿 NODE_W/NODE_H 去算右边，框会把大个子成员
       **切掉一截** —— 表现为「框的右边贴着字」。 */
    const ms = g.members
      .map((id) => ({ n: fc.nodes.find((x) => x.id === id), p: pos.get(id) }))
      .filter((x): x is { n: FlowNode; p: { x: number; y: number } } => !!x.n && !!x.p)
    if (!ms.length) return null
    const m = GROUP_MARGIN + (maxDepth - g.depth) * GROUP_DEPTH_MARGIN
    return {
      g,
      x0: Math.min(...ms.map((b) => b.p.x)) - m,
      y0: Math.min(...ms.map((b) => b.p.y)) - m - GROUP_LABEL_H,
      x1: Math.max(...ms.map((b) => b.p.x + (b.n.w || NODE_W))) + m,
      y1: Math.max(...ms.map((b) => b.p.y + (b.n.h || NODE_H))) + m,
    }
  }).filter(Boolean) as Array<{ g: FlowGroup; x0: number; y0: number; x1: number; y1: number }>

/* 旁注的位置**必须先于画布尺寸算**，否则最右边那条会被 viewBox 裁掉半截
   （症状是「注释只剩半个框」）。而它又需要 offX/offY —— 那是尺寸算完才知道的。
   所以这里先算**相对节点坐标**的旁注范围（不含偏移），拿它撑画布，
   定出 offX/offY 之后再加偏移去画。 */
  const notePlace = new Map<string, Array<{ nx: number; ny: number; tw: number; th: number; side: 'left' | 'right' | 'over'; text: string }>>()
  let maxNodeX = Math.max(...fc.nodes.map((n) => { const p = pos.get(n.id)!; return p.x + (n.w || NODE_W) }))
  let maxNodeY = Math.max(...fc.nodes.map((n) => { const p = pos.get(n.id)!; return p.y + (n.h || NODE_H) }))
  /* ⚠️ 旁注会往**左**和往上伸出 —— `note left of A` 的框整个画在 x 为负的一侧。
     只把旁注算进 max 不算进 min 的话，那条旁注**画出来了但整个在 viewBox 外**，
     界面上表现为「这行 note 没画」，而解析与坐标全对。
     这类「画了但看不见」的缺陷只有靠边界断言才抓得到。 */
  let minNoteX = 0
  let minNoteY = 0
  for (const n of fc.nodes) {
    const p = pos.get(n.id)!
    const W = n.w || NODE_W
    const H = n.h || NODE_H
    const list: Array<{ nx: number; ny: number; tw: number; th: number; side: 'left' | 'right' | 'over'; text: string }> = []
    ;(n.notes || []).forEach((nt, k) => {
      /* 宽度按中文实测量（11px 字号），不能按字符个数 ——
         按个数算会窄一截，长句被 clip 成「客户已签…」。 */
      const tw = Math.min(180, textPx(nt.text, 11) + 16)
      const th = 20 + Math.ceil(textPx(nt.text, 11) / (tw - 12)) * 13
      const nx = nt.side === 'left' ? p.x - tw - 10 : p.x + W + 10
      const ny = nt.side === 'over' ? p.y - th - 8 : p.y + (nt.side === 'left' ? 0 : k) * (th + 6)
      list.push({ nx, ny, tw, th, side: nt.side, text: nt.text })
      maxNodeX = Math.max(maxNodeX, nx + tw)
      maxNodeY = Math.max(maxNodeY, ny + th)
      minNoteX = Math.min(minNoteX, nx)
      minNoteY = Math.min(minNoteY, ny)
    })
    if (list.length) notePlace.set(n.id, list)
  }

    // 画布要同时容下节点、分组框、**大个子节点自身**，以及状态图旁注
  // （maxNodeX / maxNodeY 在上面那一段里已把旁注算进去了）
  const minX = Math.min(0, minNoteX, ...boxes.map((b) => b.x0))
  const minY = Math.min(0, minNoteY, ...boxes.map((b) => b.y0))
  const maxX = Math.max(horizontal ? spanCross : spanMain, maxNodeX, ...boxes.map((b) => b.x1))
  const maxY = Math.max(horizontal ? spanMain : spanCross, maxNodeY, ...boxes.map((b) => b.y1))
  const pad = 16
  const w = maxX - minX + pad * 2
  const h = maxY - minY + pad * 2
  const offX = pad - minX
  const offY = pad - minY

  const groupSvg = boxes
    .slice()
    .sort((a, b) => a.g.depth - b.g.depth)
    .map((b) =>
      `<rect x="${b.x0 + offX}" y="${b.y0 + offY}" width="${b.x1 - b.x0}" height="${b.y1 - b.y0}" rx="8" class="yq-fc-group"/>` +
      `<text x="${b.x0 + offX + 8}" y="${b.y0 + offY + 12}" class="yq-fc-group-label">${esc(clipText(b.g.label, 12, b.x1 - b.x0 - 16))}</text>`
    ).join('')

  const edges = fc.edges
    .map((e) => {
      const a = pos.get(e.from), b = pos.get(e.to)
      /* ⚠️ 两端各传**自己**的尺寸：复合态那端是大框，
         用小节点的尺寸去算连线端点，线会插在框的正中间。 */
      const na = fc.nodes.find((n) => n.id === e.from)
      const nb = fc.nodes.find((n) => n.id === e.to)
      return a && b
        ? edgeSvg(e, a, b, { w: na?.w || NODE_W, h: na?.h || NODE_H }, { w: nb?.w || NODE_W, h: nb?.h || NODE_H })
        : ''
    })
    .filter(Boolean)
    .join('')
  /* 旁注画在节点**旁边**（right/left）或**正上方**（over）。
     位置在上面的 notePlace 里算好（相对坐标），这里只加偏移画出来。 */
  const nodes = fc.nodes.map((n) => {
    const p = pos.get(n.id)!
    const list = notePlace.get(n.id) || []
    const noteSvg = list.map((b) =>
      `<rect x="${b.nx + offX}" y="${b.ny + offY}" width="${b.tw}" height="${b.th}" rx="4" class="yq-fc-note"/>` +
      wrapText(b.text, b.tw - 12, 11).map((ln, k) =>
        `<text x="${b.nx + offX + 6}" y="${b.ny + offY + 14 + k * 13}" class="yq-fc-note-text">${esc(ln)}</text>`).join('')
    ).join('')
    return nodeSvg(n, p.x + offX, p.y + offY) + noteSvg
  }).join('')

  return `<svg class="yq-fc-svg" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}" width="${Math.ceil(w)}" height="${Math.ceil(h)}" role="img" aria-label="流程图">` +
    `<defs><marker id="yq-fc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="yq-fc-arrowhead"/></marker></defs>` +
    groupSvg + edges + nodes + `</svg>`
}

/** 中文按字号、西文按 0.56×字号估算宽度（与 clipText 同一口径）。
 *  ⚠️ 别按**字符个数**估 —— 中文会窄掉一大截，长句被裁成「客户已签…」。 */
function textPx(s: string, size: number): number {
  let w = 0
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0) || 0
    w += cp > 0xffff || /[\u2e80-\uffff]/.test(ch) ? size : size * 0.56
  }
  return w
}

/** 按宽度折行（中文按字断，西文按词断），给旁注用。 */
function wrapText(s: string, maxW: number, size: number): string[] {
  if (maxW <= 0) return ['']
  const lines: string[] = []
  let cur = ''
  for (const ch of String(s)) {
    if (ch === '\n') { lines.push(cur); cur = ''; continue }
    if (textPx(cur + ch, size) > maxW && cur) { lines.push(cur); cur = ch }
    else cur += ch
  }
  if (cur) lines.push(cur)
  return lines.length ? lines : ['']
}

/** 一眼看出这份源码是不是 Flowchart（供界面切换渲染方式用） */
export function isFlowchartSource(src: string): boolean {
  const t = String(src || '').trim()
  if (!t) return false
  if (/^@start(uml|mind|gantt|json)/i.test(t)) return false      // PlantUML 家族优先
  return /^(graph|flowchart)\b/i.test(t.split('\n').find((l) => l.trim() && !l.trim().startsWith('%%')) || '')
}