/* ============================================================
   Mermaid 文本绘图 → 原生 SVG（零依赖）
   ------------------------------------------------------------
   为什么要写这个：语雀官方《如何插入文本绘图》列的五种里，
   Mermaid 是**覆盖面最广**的一种（也是这五种里唯一一个大生态）。
   2026-10-06 补了 Flowchart，但 Flowchart 那套语法本来就是
   mermaid 的 `flowchart`/`graph` 子集 —— 也就是说「Mermaid 流程图」
   本来就能跑，**真正缺的是别的图种**，其中真实企业文档里
   最常见的是 `sequenceDiagram`（接口时序、登录链路、审批流转）。

   所以这个文件只做两件事：
     ① identify：认出这段源码是 mermaid 的哪一种图，
        没实现的图种**不当成实现了**（界面明说差哪一种）
     ② sequence：把 `sequenceDiagram` 本地渲染成 SVG

   ⚠️ 覆盖范围是**如实标注**的：
     · sequence 支持：participant/actor（含 as 别名）、消息箭头
       (-> -->> ->> -->> -) --) -x --x)、激活条（->>+ / deactivate）、
       Note over/left/right、loop/alt/else/opt/par/break/critical 框、
       autonumber
     · sequence **不支持**：alt 框里的 divider 多段样式（这里平铺成
       每段一个括号）、note 的多行富文本、actor 与 participant 的不同图形
     · journey / timeline 由 `journey.ts` / `timeline.ts` 各写一套
       （结构与流程图完全不同，硬塞进 parseFlowchart 会得到一堆孤立方框）
     · 其余图种（class/state/er/pie/gantt/mindmap）
       **一律不假装**，见 mermaidLocalNotice
   ============================================================ */

import { parseFlowchart, renderFlowchartSvg, isFlowchartSource } from './flowchart.ts'
import { firstMeaningfulLine } from './first-line.ts'

/** mermaid 的图种。`unknown` = 压根不是 mermaid。
 *
 * ⚠️ 这里**只收我们能判出来的图种**，但收得**全** ——
 *   早期只收了 10 种，于是 `sankey-beta` / `xychart-beta` / `gitGraph` 这些
 *   一律落到 `unknown`，`pickDiagramMode` 兜底返回 `'uml'`，
 *   界面于是标着「PlantUML（结构预览）」**拿 PlantUML 解析器去啃 Mermaid 源码** ——
 *   画出来是标签残渣，而标题还写得很确定。
 *   那不是「不支持」，那是**说假话**：用户会以为自己粘错了格式。
 *   收进来之后它们路由到 `unsupported`，界面明说「这是 Mermaid 的 sankey 图，
 *   本地渲染器还没做」，**不画那张图**。宁可说没做，不做看着像防护的东西。 */
export type MermaidKind =
  | 'flowchart' | 'sequence' | 'class' | 'state' | 'er'
  | 'pie' | 'gantt' | 'mindmap' | 'journey' | 'timeline'
  | 'sankey' | 'xychart' | 'gitgraph' | 'requirement' | 'quadrant'
  | 'architecture' | 'block' | 'packet' | 'treemap' | 'kanban' | 'zenuml'
  | 'unknown'

/** 本地渲染器真的能出图的图种 —— 界面只对这几种说「本地渲染」 */
export const LOCALLY_RENDERED: Array<Exclude<MermaidKind, 'unknown'>> =
  ['flowchart', 'sequence', 'journey', 'timeline', 'sankey']

/** 中文说明。给「认出来了但没做」的图种一个具体名字，
 *  而不是笼统一句「不支持」 —— 用户得知道差的是哪一种。 */
export const KIND_LABEL: Record<Exclude<MermaidKind, 'unknown'>, string> = {
  flowchart: '流程图',
  sequence: '时序图',
  class: '类图',
  state: '状态图',
  er: '实体关系图',
  pie: '饼图',
  gantt: '甘特图',
  mindmap: '思维导图',
  journey: '用户旅程图',
  timeline: '时间线',
  sankey: '桑基图',
  xychart: 'XY 图',
  gitgraph: 'Git 图',
  requirement: '需求图',
  quadrant: '四象限图',
  architecture: '架构图',
  block: '方块图',
  packet: '数据包图',
  treemap: '矩形树图',
  kanban: '看板图',
  zenuml: 'Zenuml 时序图',
}

/** 首行声明 → 图种。**顺序有讲究**：长名必须排在短名前面，
 *  否则 `stateDiagram` 会被 `state` 先吃掉、`architecture-beta` 会被别的吃掉。 */
const KIND_RE: Array<[RegExp, MermaidKind]> = [
  [/^\s*sequenceDiagram\b/i, 'sequence'],
  [/^\s*classDiagram\b/i, 'class'],
  [/^\s*stateDiagram(-v2)?\b/i, 'state'],
  [/^\s*erDiagram\b/i, 'er'],
  [/^\s*requirementDiagram\b/i, 'requirement'],
  [/^\s*gitGraph\b/i, 'gitgraph'],
  [/^\s*quadrantChart\b/i, 'quadrant'],
  [/^\s*xychart(-beta)?\b/i, 'xychart'],
  [/^\s*sankey(-beta)?\b/i, 'sankey'],
  [/^\s*architecture(-beta)?\b/i, 'architecture'],
  [/^\s*block(-beta)?\b/i, 'block'],
  [/^\s*packet(-beta)?\b/i, 'packet'],
  [/^\s*treemap(-beta)?\b/i, 'treemap'],
  [/^\s*kanban\b/i, 'kanban'],
  [/^\s*zenuml\b/i, 'zenuml'],
  [/^\s*journey\b/i, 'journey'],
  [/^\s*timeline\b/i, 'timeline'],
  [/^\s*mindmap\b/i, 'mindmap'],
  [/^\s*gantt\b/i, 'gantt'],
  [/^\s*pie\b/i, 'pie'],
  [/^\s*(graph|flowchart)\b/i, 'flowchart'],
]

/**
 * 「第一条有效行」—— **收在 `@/lib/first-line`，这里不再自己抄一份**。
 *
 * 那个文件当初就是为了抽掉这个重复才建的（注释里写着「在 7 个模块里各写了一遍」），
 * mindmap / pie / timeline / er / class / journey / statediagram 七处都已经在用它，
 * 只有这里还留着**逐字相同**的副本。
 *
 * 留着它不是「保险」，是**哪天改了它、没改那七处或反过来，图种路由就会分叉** ——
 * 而症状是「不报错、不空图，只是落到兜底分支，界面给出一张不相干的预览」。
 */

/** 这段源码是 mermaid 吗？是的话是哪一种。 */
export function detectMermaid(src: string): MermaidKind {
  const head = firstMeaningfulLine(src)
  if (!head) return 'unknown'
  if (/^@start(uml|mind|gantt|json|wbs)/i.test(head)) return 'unknown'   // PlantUML 家族优先
  for (const [re, kind] of KIND_RE) if (re.test(head)) return kind
  return 'unknown'
}

/** 界面用的一句话结论：本地能不能出图、差在哪。**没实现就说没实现。** */
export function mermaidLocalNotice(kind: MermaidKind): string {
  if (kind === 'unknown') return ''
  // 上一步已经把 'unknown' 排除了，这里收窄一次再查表
  if ((LOCALLY_RENDERED as MermaidKind[]).includes(kind)) return ''
  /* 已支持的图种**从 LOCALLY_RENDERED 生成**，不手写。
     原来这里写死「只做了流程图与时序图两种」—— 每加一个图种都得记得改这句话，
     而漏改的后果是**界面明明出图了、却告诉用户没做**（2026-10-07 补完
     journey/timeline 时就会踩上）。 */
  const done = LOCALLY_RENDERED.map((k) => KIND_LABEL[k]).join('、')
  return (
    `这段是 Mermaid 的**${KIND_LABEL[kind]}**（${kind}）。本地渲染器目前支持 ` +
    `${done}；${KIND_LABEL[kind]}还没做 —— 界面上不会假装出图。`
  )
}

/* 路由判定（`empty/uml/flow/seq/dot/unsupported`）**已经搬到 diagram.ts** ——
   它现在要同时判 PlantUML / DOT / Mermaid 三族，留在 mermaid.ts 里名不副实。
   组件请 import 那个，不要在这里再写一遍。 */

/* ============================================================
   sequenceDiagram
   ============================================================ */

export interface SeqMessage {
  type: 'message'
  from: string
  to: string
  label: string
  /** 实线箭头 = 调用；`x` / `\` 头 = 返回或丢失，画虚线 */
  dotted: boolean
}

export interface SeqNote {
  type: 'note'
  text: string
  /** 覆盖的参与者（`over A,B` 可能是多个；单侧 note 只有一个） */
  over: string[]
}

export type SeqEvent = SeqMessage | SeqNote

/** 一个框片段。`alt/else` 在 mermaid 里是「一个框两段」，
 *  这里按**每段一个括号**画 —— 平铺、可预期，
 *  代价是视觉上不是原来那个带 divider 的框（如实写在文件头）。 */
export interface SeqBlock {
  label: string
  start: number     // 事件下标（含）
  end: number       // 事件下标（含）
  depth: number
}

export interface Sequence {
  participants: string[]
  /** 参与者 id → 界面上显示的名字。`participant 网关 as GW` 里 id 是 `网关`，
   *  显示名是 `GW`。⚠️ 不能把显示名当 id —— 后面用 `GW->>…` 引用的消息
   *  会凭空多出一个叫 GW 的参与者（第一版就是这么错的）。 */
  labels: Map<string, string>
  events: SeqEvent[]
  blocks: SeqBlock[]
  /** 激活条：参与者 id → 若干区间（事件下标，end = -1 表示还没关） */
  activations: Map<string, Array<{ start: number; end: number }>>
  autonumber: boolean
  skipped: string[]
}

/* 消息箭头：`-`×1..3 接一个箭头头。头字符决定实虚：
     `>` `)` = 实线（调用 / 返回），`x` `\` = 虚线（丢失）。
   ⚠️ 这里的反斜杠是**必须的**：写 `'\)+'` 的话，JS 字符串里 `\)` 直接变成裸 `)`，
     正则里的 `(?:...|\)+|x|\\)` 就变成 `(?:>{1,2}|)+|x|\)` —— 分组被提前闭掉，
     `-{1,4}` 后面接了个跟头，**箭头只吃到 `--` 就停**。
     症状是 `--x用户` 认成参与者 `x用户`，图上凭空多一个人、箭头少一根。
   为什么写 `-{1,3}` 而不是逐个列举：第一版只认 `-->`，
   于是 `-->>`（带箭头的返回，内网文档里最常见的返回写法）全被漏掉，
   表现为「图里少一半线」而不是报错。 */
const ARROW_TOKEN = '-{1,3}(?:>{1,2}|\\)+|x|\\\\)'
const SEQ_MSG = new RegExp(`^(\\S+?)\\s*(${ARROW_TOKEN})([+-]?)\\s*(\\S+?)\\s*:\\s*(.*)$`)
const SEQ_DECL = /^(participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/i
const SEQ_NOTE = /^note\s+(over|left of|right of)\s+([^:]+?)\s*:\s*(.*)$/i
const SEQ_HEADER = /^sequenceDiagram\b/i
/** loop/alt/opt/par/break/critical/rect —— 开一个框 */
const BLOCK_OPEN = /^(loop|alt|opt|par|break|critical|rect)\b\s*(.*)$/i
const BLOCK_MID = /^else\b\s*(.*)$/i
const BLOCK_END = /^end\b$/i
const ACT_OPEN = /^activate\s+(\S+)$/i
const ACT_CLOSE = /^deactivate\s+(\S+)$/i

export function parseSequence(src: string): Sequence {
  const out: Sequence = {
    participants: [], labels: new Map(), events: [], blocks: [],
    activations: new Map(), autonumber: false, skipped: [],
  }
  const seen = new Set<string>()
  /** 显示名 → id。`participant 网关 as GW` 之后，用 GW 引用的消息要能找回「网关」 */
  const alias = new Map<string, string>()

  /** 解析一个参与者引用（可能是 id，也可能只是显示名），返回真正的 id */
  const resolve = (name: string) => alias.get(name) || name

  const addP = (name: string, label?: string): string => {
    const id = resolve(name)
    if (!id) return ''
    if (!seen.has(id)) {
      seen.add(id)
      out.participants.push(id)
      out.labels.set(id, label || id)
    } else if (label && out.labels.get(id) === id) {
      out.labels.set(id, label)            // 后来补上的显示名
    }
    return id
  }

  /* 框的栈：每层记住「这一段从第几个事件开始」。 */
  const stack: Array<{ label: string; depth: number; start: number }> = []
  const closeSeg = (endIdx: number) => {
    const top = stack.pop()
    if (!top) return
    // 空的段（`end` 紧挨着开）不画括号，但也不该报错
    if (endIdx >= top.start) out.blocks.push({ label: top.label, start: top.start, end: endIdx, depth: top.depth })
  }
  const openSeg = (label: string, depth: number, at: number) => {
    stack.push({ label, depth, start: at })
  }

  /* 激活条：深度 0→1 开一段，1→0 关一段。 */
  const actDepth = new Map<string, number>()
  const bump = (rawId: string, delta: number, at: number) => {
    const id = resolve(rawId)
    if (!id) return
    const before = actDepth.get(id) || 0
    const after = before + delta
    actDepth.set(id, after)
    const list = out.activations.get(id) || []
    if (before === 0 && after > 0) list.push({ start: at, end: -1 })
    if (before > 0 && after === 0) {
      const openSegs = list[list.length - 1]
      if (openSegs && openSegs.end === -1) openSegs.end = at
    }
    out.activations.set(id, list)
  }

  let firstMeaningful = true
  for (const raw of String(src || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue

    const at = out.events.length

    /* 头部声明行本身不是「不认识的写法」—— 不记进 skipped。
       否则界面会报「有一段写法本地渲染器不认」，而它其实是被正确消费掉的；
       这种假告警比没有告警更糟：用户会去找一个不存在的问题。 */
    if (firstMeaningful) {
      firstMeaningful = false
      if (SEQ_HEADER.test(line)) continue
    }

    if (BLOCK_END.test(line)) { closeSeg(at - 1); continue }

    const mid = BLOCK_MID.exec(line)
    if (mid && stack.length) {
      // else 换的是**同一层**的下一段，depth 必须沿用刚弹出的那一层
      const depth = stack[stack.length - 1].depth
      closeSeg(at - 1)
      openSeg(`else ${mid[1] || ''}`.trim(), depth, at)
      continue
    }

    const open = BLOCK_OPEN.exec(line)
    if (open) { openSeg(`${open[1]} ${open[2]}`.trim(), stack.length, at); continue }

    if (/^autonumber\b/i.test(line)) { out.autonumber = true; continue }
    if (/^title\b/i.test(line)) { out.skipped.push(line); continue }

    const decl = SEQ_DECL.exec(line)
    if (decl) {
      const label = (decl[3] || '').trim()
      addP(decl[2], label || undefined)
      if (label) alias.set(label, decl[2])   // `participant 网关 as GW`：GW 也要能指回网关
      continue
    }

    const ao = ACT_OPEN.exec(line)
    if (ao) { addP(ao[1]); bump(ao[1], 1, at); continue }
    const ac = ACT_CLOSE.exec(line)
    if (ac) { bump(ac[1], -1, at); continue }

    const note = SEQ_NOTE.exec(line)
    if (note) {
      const ids = note[2].split(',').map((s) => s.trim()).filter(Boolean)
      const resolved = ids.map((s) => addP(s)).filter(Boolean)
      out.events.push({ type: 'note', text: note[3].trim(), over: resolved })
      continue
    }

    const msg = SEQ_MSG.exec(line)
    if (msg) {
      const [, from, arrow, sign, to, label] = msg
      const f = addP(from), t = addP(to)
      if (!f || !t) { out.skipped.push(line); continue }
      const row = out.events.length
      out.events.push({ type: 'message', from: f, to: t, label: label.trim(), dotted: /[x\\]$/.test(arrow) })
      if (sign === '+') bump(t, 1, row)
      else if (sign === '-') bump(t, -1, row)
      continue
    }

    out.skipped.push(line)
  }

  // 源码写了一半（少一个 end）：把还开着的段按「到最后一行」收尾，别把内容丢了
  while (stack.length) closeSeg(out.events.length - 1)
  // 激活条同理
  const last = out.events.length - 1
  for (const list of out.activations.values()) {
    for (const seg of list) if (seg.end === -1) seg.end = last
  }

  /* 框按**源码顺序**排（外层在前）。
     ⚠️ closeSeg 是「弹栈时 push」，所以内层先进数组 —— 第一版拿到的是
     [内层, 外层] 这种反序。渲染时碰巧没差（每个括号独立画），
     但任何人拿 blocks[0] 当「第一个框」都会读错，如实修掉。 */
  out.blocks.sort((a, b) => (a.start - b.start) || (a.depth - b.depth))

  return out
}

/* ---------------- 渲染 ---------------- */

const HEAD_H = 42
const ROW_H = 36
const NOTE_H = 26
const PAD = 18
const HEAD_MIN_W = 96
const HEAD_MAX_W = 190
const BLOCK_INDENT = 13
const BRACKET_W = 9
const LABEL_MAX_W = 120
const ACT_W = 10

const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 粗略量一下文字宽度：中文按字号算，西文按 0.56 字号算。
 *  只用来决定**框画多宽**，量错一点的后果是框略窄/略宽，不会画错箭头。 */
function textWidth(s: string, size: number): number {
  let w = 0
  for (const ch of String(s)) w += /[\u2e80-\uffff]/.test(ch) ? size : size * 0.56
  return w
}

/** 裁到最宽的框里，超出部分用 … 收尾 */
function clip(s: string, size: number, maxW: number): string {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of String(s)) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out ? out + '…' : '…'
}

export function renderSequenceSvg(seq: Sequence): string {
  if (!seq.participants.length) return ''
  const N = seq.participants.length

  /* 框（loop/alt）在最左边占地方 —— **先**把这段让出来，
     否则括号会压在参与者的头上面（第一版就是这么错的：
     算出了 bracketRoom 却没往参与者的 x 上加，画面上左边被吃掉一截）。

     ⚠️ 让位量里必须算上**框标签的宽度**，不只是括号那几像素：
     标签是横排的字（`loop 每 5 分钟`），不预留的话它会盖住
     第一条消息的箭头和标签 —— 那才是真正「图画错了」。

     ⚠️ 还有一处：第一版写的是 `maxDepth ? … : 0`，把 depth 0 当成「没有框」。
     而**单个 loop 就在第 0 层** —— 于是最常见的「一个 loop」的图
     一个像素都没让位，括号直接压在参与者的头上。 */
  const maxDepth = seq.blocks.reduce((m, b) => Math.max(m, b.depth), 0)
  const labelRoom = seq.blocks.length
    ? Math.min(LABEL_MAX_W, Math.max(...seq.blocks.map((b) => textWidth(b.label, 10) + 8)))
    : 0
  const bracketRoom = seq.blocks.length ? maxDepth * BLOCK_INDENT + labelRoom + BRACKET_W + 10 : 0

  // 框宽按**显示名**长度定（`participant 网关 as 网关服务` 该按显示名画宽），
  // 但计算和画字都用同一个名字 —— 用 id 算宽、用 label 画字会让字溢出去
  const names = seq.participants.map((p) => seq.labels.get(p) || p)
  const heads = names.map((nm) => Math.min(HEAD_MAX_W, Math.max(HEAD_MIN_W, textWidth(nm, 12) + 24)))
  const gap = Math.max(...heads) / 2 + 24       // 头之间至少留出半个最宽的框，箭头才有地方写标签
  const xs: number[] = []
  let x = PAD + bracketRoom
  for (let i = 0; i < N; i++) { xs.push(x + heads[i] / 2); x += heads[i] + gap }
  const contentW = x - gap

  /* 每行的上下边界。**按各自真实行高算**：
     note 行只有 NOTE_H 高，用 ROW_H 去反推会把它上下各撑出 5px ——
     框括号和激活条一旦跨到 note 行，边界就会明显歪出去。
     （第一版就是 `rowY[i] ± ROW_H/2`，note 一多就看出来。） */
  const rowTop: number[] = []
  const rowBottom: number[] = []
  let y = PAD + HEAD_H + 14
  for (const ev of seq.events) {
    const h = ev.type === 'note' ? NOTE_H : ROW_H
    rowTop.push(y - h / 2)
    y += h
    rowBottom.push(y - h / 2)
  }
  if (rowBottom.length) rowBottom[rowBottom.length - 1] = y + PAD / 2   // 最后一行往下留白到画布底
  const totalH = y + PAD
  const totalW = contentW + heads[N - 1] / 2 + PAD

  const idx = new Map(seq.participants.map((p, i) => [p, i]))
  const parts: string[] = []

  // 参与者的头 + 生命线
  seq.participants.forEach((p, i) => {
    const w = heads[i]
    const cx = xs[i]
    const headBottom = PAD + HEAD_H - 10
    const nm = names[i]
    parts.push(
      `<rect x="${cx - w / 2}" y="${PAD}" width="${w}" height="${HEAD_H - 10}" rx="4" class="yq-seq-head"/>` +
      `<text x="${cx}" y="${PAD + (HEAD_H - 10) / 2}" text-anchor="middle" dominant-baseline="middle" class="yq-seq-name">${esc(clip(nm, 12, w - 12))}</text>` +
      `<line x1="${cx}" y1="${headBottom}" x2="${cx}" y2="${totalH - PAD}" class="yq-seq-life"/>`
    )
  })

  // 激活条画在生命线之上、消息之下（先画，后画的箭头压得住它）
  for (const [pid, segs] of seq.activations) {
    const i = idx.get(pid)
    if (i === undefined) continue
    for (const s of segs) {
      if (s.start < 0 || s.start >= rowTop.length) continue
      const y1 = rowTop[s.start]
      const y2 = rowBottom[s.end]
      parts.push(
        `<rect x="${xs[i] - ACT_W / 2}" y="${y1}" width="${ACT_W}" height="${Math.max(2, y2 - y1)}" rx="1.5" class="yq-seq-act"/>`
      )
    }
  }

  // 消息与备注
  let msgNo = 0
  seq.events.forEach((ev, i) => {
    const cy = rowTop[i] + (rowBottom[i] - rowTop[i]) / 2
    if (ev.type === 'note') {
      const ids = ev.over.map((p) => idx.get(p)).filter((v): v is number => v !== undefined)
      if (!ids.length) return
      const spanL = Math.min(...ids.map((k) => xs[k]))
      const spanR = Math.max(...ids.map((k) => xs[k]))
      const want = Math.max(textWidth(ev.text, 11) + 16, spanR - spanL + 28)
      const bw = Math.min(want, totalW - PAD * 2)
      const bx = Math.max(PAD, (spanL + spanR) / 2 - bw / 2)
      parts.push(
        `<rect x="${bx}" y="${cy - NOTE_H / 2 + 2}" width="${bw}" height="${NOTE_H - 4}" rx="2" class="yq-seq-note"/>` +
        `<text x="${bx + bw / 2}" y="${cy}" text-anchor="middle" dominant-baseline="middle" class="yq-seq-note-text">${esc(clip(ev.text, 11, bw - 12))}</text>`
      )
      return
    }

    msgNo++
    const fi = idx.get(ev.from)
    const ti = idx.get(ev.to)
    if (fi === undefined || ti === undefined) return
    const x1 = xs[fi], x2 = xs[ti]
    const dash = ev.dotted ? ' stroke-dasharray="5 4"' : ''
    const head = ev.dotted ? 'x' : 'arrow'
    const prefix = seq.autonumber ? `<tspan class="yq-seq-no">${msgNo}.</tspan> ` : ''

    if (fi === ti) {
      // 自消息：画一个小回环 —— 否则退化成零长度的线，看着像「什么都没画」
      const lx = x1 + 10
      parts.push(
        `<path d="M${x1},${cy} L${lx},${cy} L${lx},${cy + 16}" fill="none" class="yq-seq-msg"${dash}/>` +
        `<line x1="${lx}" y1="${cy + 16}" x2="${x1}" y2="${cy + 16}" class="yq-seq-msg" marker-end="url(#yq-seq-${head})"${dash}/>` +
        `<text x="${lx + 8}" y="${cy + 8}" class="yq-seq-msg-label">${prefix}${esc(ev.label)}</text>`
      )
      return
    }

    parts.push(
      `<line x1="${x1}" y1="${cy}" x2="${x2}" y2="${cy}" class="yq-seq-msg"${dash} marker-end="url(#yq-seq-${head})"/>` +
      `<text x="${(x1 + x2) / 2}" y="${cy - 7}" text-anchor="middle" class="yq-seq-msg-label">${prefix}${esc(ev.label)}</text>`
    )
  })

  // loop / alt 框：最左边的括号，深度往右缩一格
  for (const b of seq.blocks) {
    if (b.start < 0 || b.start >= rowTop.length) continue
    const bx = PAD + b.depth * BLOCK_INDENT
    const y1 = rowTop[b.start]
    const y2 = rowBottom[b.end]
    const h = Math.max(14, y2 - y1)
    // 标签从括号右边起排，必须在第一个参与者**之前**收尾。
    // 嵌套的括号往右缩，能放标签的宽度自然更小 —— 这正是该有的样子。
    const labelMax = Math.max(24, xs[0] - (bx + BRACKET_W + 4) - 6)
    parts.push(
      `<path d="M${bx + BRACKET_W},${y1} L${bx},${y1} L${bx},${y1 + h} L${bx + BRACKET_W},${y1 + h}" fill="none" class="yq-seq-bracket"/>` +
      `<text x="${bx + BRACKET_W + 4}" y="${y1 + 9}" class="yq-seq-block-label">${esc(clip(b.label, 10, labelMax))}</text>`
    )
  }

  return `<svg class="yq-seq-svg" viewBox="0 0 ${Math.ceil(totalW)} ${Math.ceil(totalH)}" width="${Math.ceil(totalW)}" height="${Math.ceil(totalH)}" role="img" aria-label="时序图">` +
    `<defs>` +
    `<marker id="yq-seq-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="yq-seq-arrowhead"/></marker>` +
    `<marker id="yq-seq-x" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 M10,0 L0,10" fill="none" stroke="currentColor" stroke-width="1.6"/></marker>` +
    `</defs>` + parts.join('') + `</svg>`
}

/* ============================================================
   统一入口：mermaid 源码 → SVG（只对本地真做了的图种出图）
   ============================================================ */

export function renderMermaidSvg(src: string): string {
  const kind = detectMermaid(src)
  if (kind === 'flowchart') {
    if (!isFlowchartSource(src)) return ''
    return renderFlowchartSvg(parseFlowchart(src))
  }
  if (kind === 'sequence') return renderSequenceSvg(parseSequence(src))
  return ''
}