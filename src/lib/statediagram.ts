/* ============================================================
   Mermaid `stateDiagram` / `stateDiagram-v2` → 复用 Flowchart 的布局与渲染
   ------------------------------------------------------------
   为什么做：审批流、订单状态机、工单流转是**内网知识库里最高频**的内容之一，
   而状态图的结构就是「状态 + 迁移 + 标签」—— 流程图引擎已经会做。
   所以这里只写解析，布局与出 SVG **直接复用 src/lib/flowchart.ts**，
   零新增渲染代码、零新增依赖。

   ⚠️ **不能直接把 stateDiagram 喂给 parseFlowchart**（实测过，很难看）：
     · `stateDiagram-v2` 头部会变成一个**凭空多出来的节点**
     · `[*] --> 待支付` 这种**起始迁移整条丢失**（`[*]` 被当成不认识的行）
     · `note right of A` 会造出 `note` 和「说明文字」两个幽灵节点
     · `state X { … }` 的收尾 `}` 会掉进 skipped
     画出来是「几个凭空多出来的方框 + 少一半线」，而界面上看不出是认错了。

   覆盖范围**如实标注**：
     · 支持 stateDiagram / stateDiagram-v2、`[*]` 起始与终止、
       `A --> B : 标签`、`A : 说明`、`direction XX`
   **不支持**：复合状态的**外框**（`state 名称 { … }` 里的状态会照常解析并
     画出来，但**不会**被圈进框里 —— 理由见 `state X {` 分支的注释）、
     `note` 旁注、并发区域 `--`。这些进 `skipped`，界面上明说。
   ============================================================ */

import { assignLayers, layoutNodes, type FlowNode, type FlowEdge, type FlowShape, type Flowchart, type FlowGroup } from './flowchart.ts'
import { firstMeaningfulLine } from './first-line.ts'
import { parseStyles, styleForNode, styleAttr, isClassAssign, CLASS_DEF_RE } from './diagram-style.ts'

/** `[*]` 伪节点的 id 前缀。用**不可见字符**开头，源文档里不可能撞上。
 *
 *  ⚠️ 每个 `[*]` 都必须是**独立的 id**。第一版只分「起点 / 终点」两个，
 *     结果复合状态里的 `[*]` 和顶层的终止点共用一个 —— 于是顶层那条
 *     「已发货 → 终点」的线**又拐进了复合状态里**，
 *     图上看着像「订单发货完直接进了售后流程」。 */
const DOT_PREFIX = '￿dot'

/** `note right|left|over <状态> : 正文` —— mermaid 的状态图旁注。
 *  画成状态旁边一个小框；`over` 画在正上方。 */
export interface StateNote {
  target: string
  side: 'left' | 'right' | 'over'
  text: string
}

const DOT_SHAPE: FlowShape = 'dot'
const STATE_SHAPE: FlowShape = 'round'
const COMPOSITE_SHAPE: FlowShape = 'rect'

export function parseStateDiagram(src: string): Flowchart {
  const out: Flowchart = { direction: 'TD', nodes: [], edges: [], skipped: [], groups: [] }
  const byId = new Map<string, FlowNode>()
  const stack: FlowGroup[] = []
  /** classDef / `class A name` 的行，交给共用的样式解析器 */
  const styleLines: string[] = []
  /** 复合态的 id 集合 */
  const compositeIds = new Set<string>()
  /** 节点 id → **最近**的外层复合态 id（没有则不进表） */
  const ownerOf = new Map<string, string>()
  let dots = 0
  /** note 挂到哪个状态上、挂在哪一侧、正文是什么。
   *  2026-10-07 之前 note 只被「吃掉正文 + 报一句做不到」——
   *  那是诚实的，但 `note right of 已发货 : 客户已签收` 这种
   *  在真实审批流里并不罕见，白白不画就是白丢信息。 */
  let noteTarget = ''
  let noteSide: 'left' | 'right' | 'over' = 'right'
  let noteBody: string[] = []
  /** note 自己写了同行正文（`note right of A : 文本`）。有就不再吃后续缩进行 */
  let noteInline = false
  /* 把攒到的 note 收进 notes。一条 note 收完就把 noteTarget 清空 ——
     下一行是普通内容，不清的话它会被当成「还在正文里」而**整行被吃掉**。 */
  const notes: StateNote[] = []
  const flushNote = () => {
    const text = noteBody.join(' ').trim()
    if (noteTarget && text) notes.push({ target: noteTarget, side: noteSide, text })
    noteTarget = ''
    noteBody = []
    noteInline = false
  }

  const add = (id: string, label?: string, shape: FlowShape = STATE_SHAPE) => {
    if (!id) return ''
    let n = byId.get(id)
    if (!n) {
      // ⚠️ layer / order 必须**初始化**。assignLayers 只保证给兜底值，
      //    但解析期就该有 —— 别指望下游一定补上。
      n = { id, label: label ?? id, shape, layer: 0, order: 0 } as Flowchart['nodes'][number] & { label: string }
      byId.set(id, n as unknown as typeof n)
      out.nodes.push(n)
    } else if (label && n.shape === STATE_SHAPE && !n.label.startsWith(DOT_PREFIX)) {
      n.label = label            // `A : 说明` 补上说明，不覆盖已有的、不动 `[*]`
    }
    for (const g of stack) if (!g.members.includes(id)) g.members.push(id)
    /* ⚠️ 记下「最近的外层复合态」。这是切分内外两层图的唯一依据 ——
       `g.members` 记的是**所有**祖先（含外层），光看它判断不出「这状态
       到底属于哪个复合态」，于是内层图会被算到外层去 —— 也就是当初
       「框圈进不相干的状态」的同一个病根。
       ⚠️ 同一个状态先在内层出现、后被外层引用时**不覆盖**：
       它仍然属于内层（声明位置说了算），外层引用走「连到复合态」那条路。 */
    const innermost = stack[stack.length - 1]
    /* ⚠️ 必须排除「复合态自己」：`state X {` 是**先 push 自己的分组、再 add(X)**，
       所以 add(X) 时栈顶正好就是 X 的分组 —— 不排除的话 X 归 X 自己管，
       于是递归时每个复合态都撞上自引用兜底，内层一个都没算出来。
       症状：所有复合态都报「内部出现了对自身的引用」，图上全是空框。 */
    if (innermost && innermost.id !== id && !ownerOf.has(id)) ownerOf.set(id, innermost.id)
    return id
  }

  const dot = () => `${DOT_PREFIX}${++dots}`
  const resolveDot = (name: string) => (name.trim() === '[*]' ? dot() : name.trim())

  for (const raw of expandOneLineComposites(String(src || '')).split('\n')) {
    const indented = /^\s/.test(raw)
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    /* note 的**正文**是后续的缩进行。
       ⚠️ 不吃掉的话，正文那一行会被下面的「裸状态」规则当成状态名 ——
          `note right of A` 后面跟着 `说明`，图上就凭空多一个叫「说明」的框。
       ⚠️⚠️ 但**只在 note 自己没写正文时才吃**。绝大多数文档整体是缩进的
          （`  A --> [*]` 也带缩进），无条件吃缩进行的结果是
          注释正文变成「这里是入口 A --> [*]」，把**后面那条真实迁移也吞了** ——
          图上少一条线，而且两边都不报错。
          规则：同行有 `:` 正文就是完整的，不吃后续；没正文才吃缩进续行。 */
    if (noteTarget && !noteInline) {
      if (indented && noteBody.length < 6) { noteBody.push(line); continue }
      flushNote()
    }
    if (/^stateDiagram(-v2)?\b/i.test(line)) continue

    /* classDef / class A,B name —— mermaid 的状态图同样支持。
       ⚠️ 状态图**有自己的解析器**（不经过 parseFlowchart），所以流程图里那两道
       拦截在这里碰不到：`class S1 hot` 会一路掉到最后的
       `skipped.push(line)`，界面上报「不认」——
       而用户明明写了 classDef。⚠️ 拦截要放在 `note` 之前：
       `class` 开头的行不该被当成「note 正文」的续行判断。 */
    if (CLASS_DEF_RE.test(line) || isClassAssign(line)) { styleLines.push(line); continue }

    const dg = /^direction\s+(\w+)/i.exec(line)
    if (dg) {
      const d = dg[1].toUpperCase()
      out.direction = (d === 'LR' || d === 'RL' || d === 'BT' || d === 'TB' ? d : 'TD') as Flowchart['direction']
      continue
    }

    /* `note right|left|over <状态> : 正文`。
       ⚠️ 认得并**画出来**（2026-10-07 补上）。之前只「吃掉正文 + 报做不到」——
       那是诚实的，但 `note right of 已发货 : 客户已签收` 在真实审批流里并不罕见，
       白白不画就是白丢信息。 */
    const nt = /^note\s+(left|right|over)\s+of\s+(\S+?)\s*(?::\s*(.*))?$/i.exec(line)
    if (nt) {
      /* ⚠️ 必须先把**上一条** note 收尾：新 note 分支会直接覆写 noteBody，
         不 flush 的话第一条被静默吞掉 —— 连着两条 note 的源码很少见，
         而丢一条的图看着完全正常。 */
      flushNote()
      noteSide = nt[1].toLowerCase() as 'left' | 'right' | 'over'
      noteTarget = nt[2].trim().replace(/^["']|["']$/g, '')
      noteBody = nt[3] ? [nt[3].trim()] : []
      noteInline = !!nt[3] && nt[3].trim().length > 0
      /* ⚠️ **不要**在这里 add(noteTarget)。
         note 不该**创造**它指名的状态 —— `note right of 不存在 : x`
         会凭空多一个叫「不存在」的框，而那句话没说图里有这个状态。
         存在性统一放到解析末尾校验（那时全图都知道了），
         指名一个真没写出来的状态就丢掉并说一句实话。 */
      continue
    }
    /* 认得但画不了的写法：`note left of A, B : x`（多个状态）与 `end note` */
    if (/^note\b/i.test(line)) {
      out.skipped.push(line.replace(/\s+/g, ' ').slice(0, 50))
      noteTarget = ''
      noteBody = []
      noteInline = false
      continue
    }

    if (line === '}' || line === '};') { stack.pop(); continue }

    /* 复合状态：`state 名称 {` 或 `state "名称" as id {`
     *
     * ⚠️ **这里刻意不画外框**，只报一句实话。
     *   试过直接复用 flowchart 的分组框（`yq-fc-group`），画出来是**错的**：
     *   复合态内部的 `[*] --> 申请中` 不从复合态本身出发，会和**外层流程**
     *   排在同一层网格上 —— 于是框从「申请中」一路横跨到「售后」，
     *   把中间四五个不相干的状态全包了进去。
     *   看着像「复合态画对了」，其实只是画了一个更大的错框。
     *
     *   真要画对得**递归布局**：外层把复合态当一个整体参与分层，
     *   内部再单独跑一遍布局塞进框里。那是另一个量级的改动，
     *   在没有把握之前不如不画 —— 本项目的规矩是宁可写「没做」，
     *   也不做看起来像防护的东西。 */
    /* `state 分岔 <<fork>>` / `state 汇合 <<join>>` —— 并发区域的分岔与汇合。
       ⚠️ 必须**在 `state X {` 那个复合态分支之前**判：
          `state X <<fork>>` 没有花括号，会一路掉到最后的 skipped，
          界面上报「不认」—— 而它其实是认识的一种结构。 */
    const fj = /^state\s+["']?(.+?)["']?\s*<<\s*(fork|join)\s*>>\s*$/i.exec(line)
    if (fj) {
      add(fj[1].trim(), fj[1].trim(), (fj[2].toLowerCase() === 'fork' ? 'fork' : 'join') as FlowShape)
      continue
    }

    const cs = /^state\s+(.+?)\s*\{\s*$/.exec(line)
    if (cs) {
      let name = cs[1].trim().replace(/^["']|["']$/g, '')
      const as = /^["'].*["']\s+as\s+(\S+)$/.exec(cs[1].trim())
      if (as) name = as[1]
      const g: FlowGroup = { id: name, label: name, members: [], depth: stack.length }
      /* ⚠️ 归属要在 **push 自己之前**记：push 之后栈顶就是它自己的分组，
         而 `add` 里那个「复合态不归自己管」的守卫会把自引用挡掉 ——
         于是**嵌套复合态永远拿不到 owner**，第二层、第三层全被当成顶层。
         症状：三层嵌套画出来是三个平级的框，谁也不在谁里面。 */
      const parent = stack[stack.length - 1]
      if (parent && parent.id !== name) ownerOf.set(name, parent.id)
      stack.push(g)
      out.groups.push(g)
      compositeIds.add(name)
      // 复合态自己也是一个状态，mermaid 里可以整体迁移
      add(name, name, COMPOSITE_SHAPE)
      continue
    }
    /* `state 名称`（不带花括号，声明一个带说明的状态）*/
    const st = /^state\s+(.+?)\s*:\s*(.+)$/.exec(line)
    if (st) { add(st[1].trim(), st[2].trim()); continue }

    /* 迁移：`A --> B : 标签` / `A --> [*]` / `A --> B` */
    const tr = /^(.+?)\s*-->\s*(.+?)\s*(?::\s*(.*))?$/.exec(line)
    if (tr) {
      const rawFrom = tr[1].trim(), rawTo = tr[2].trim()
      const fromDot = rawFrom === '[*]', toDot = rawTo === '[*]'
      const from = resolveDot(rawFrom)
      const to = resolveDot(rawTo)
      if (from && to) {
        // ⚠️ `[*]` 必须拿到 dot 形状 —— 第一版走默认的 STATE_SHAPE，
        //    于是起点画出来是个带文字的椭圆，而 mermaid 是个实心小点
        add(from, fromDot ? '' : undefined, fromDot ? DOT_SHAPE : STATE_SHAPE)
        add(to, toDot ? '' : undefined, toDot ? DOT_SHAPE : STATE_SHAPE)
        out.edges.push({ from, to, label: (tr[3] || '').trim(), arrow: 'solid' })
      }
      continue
    }

    /* 裸状态：只有一个标识符，没有箭头也没有冒号。
       第一版把它丢进 skipped，于是「先声明一堆状态、后面再连边」的写法
       会**整批状态凭空消失** —— 而图看上去只是「少几个框」。 */
    if (/^[^\s:]+$/.test(line)) { add(line.trim()); continue }

    /* `A : 说明` —— 注意不能和上面的迁移正则抢：
       `A --> B : 标签` 已经先被 tr 吃掉了。 */
    const ds = /^([^:]+?)\s*:\s*(.+)$/.exec(line)
    if (ds) { add(ds[1].trim(), ds[2].trim()); continue }

    out.skipped.push(line.slice(0, 60))
  }

  /* 文件末尾那条 note 后面没有内容行了，这里兜一次 */
  flushNote()

  /* 没被任何迁移引用过的 `[*]` 不画 —— 不然会多出孤零零的圆点 */
  const prune = (id: string) => {
    if (!id.startsWith(DOT_PREFIX)) return
    if (out.edges.some((e) => e.from === id || e.to === id)) return
    const i = out.nodes.findIndex((n) => n.id === id)
    if (i >= 0) out.nodes.splice(i, 1)
    byId.delete(id)
    for (const g of out.groups) g.members = g.members.filter((m) => m !== id)
  }
  for (const n of [...out.nodes]) prune(n.id)

  /* 挂在**不存在 / 已被 prune 掉**的状态上的 note 不能留 ——
     那个状态图上没有，留着就在空白处画一个悬空的注释框。
     ⚠️ 必须在 prune **之后**判：挂在没人引用的 `[*]` 上的 note，
        prune 之后那个点已经没了。 */
  const live = new Set(out.nodes.map((n) => n.id))
  for (const nt of notes) {
    if (!live.has(nt.target)) out.skipped.push(`note 挂在 ${nt.target} 上，但那个状态不存在或没被用到`)
  }
  out.notes = notes.filter((n) => live.has(n.target))
  /* ⚠️ 必须把 note **挂到节点上** —— 渲染器是按节点读的（`n.notes`）。
     只存在 out.notes 里的话解析看着对、图上一个框都没有：
     「解析到了 1 条、画出 0 个」，而两边都不报错。 */
  for (const nt of out.notes) {
    const n = out.nodes.find((x) => x.id === nt.target)
    if (n) n.notes = [...(n.notes || []), { side: nt.side, text: nt.text }]
  }

  /* classDef → 节点样式。放在 prune **之后**：prune 会删节点，
     先挂样式就会给一个马上被删掉的节点白挂一遍。 */
  if (styleLines.length) {
    const parsed = parseStyles(styleLines.join('\n'))
    for (const n of out.nodes) {
      const p = styleForNode(parsed, n.id)
      if (!p) continue
      n.style = styleAttr(p) || undefined
      n.labelFill = p.color ? String(p.color) : undefined
    }
    out.skipped.push(...parsed.problems)
  }

  /* 复合态的分组**不再清空**：2026-10-07 补上了递归布局，
     分组框改由**复合态自己的 w/h** 画（见 `n.inner`），
     通用分组框那套只留给流程图的 subgraph / DOT 的 cluster。 */
  layoutComposites(out, compositeIds, ownerOf)

  assignLayers(out.nodes as unknown as Flowchart['nodes'], out.edges)
  return out
}

/* 复合态框的内边距与标题高度 —— 与 flowchart 的 GROUP_* 同一量级，
   但**不共用常量**：那边的框是按成员坐标反推的，这边是按内层布局算完的尺寸，
   两个含义不同却共用一个数字的话，改一个就会悄悄改到另一个。 */
const C_PAD = 12
const C_TITLE = 20

/**
 * 把**单行**复合态展开成多行。
 *
 * `state 甲 { a1 --> a2 }` 这种写法 mermaid 是允许的，而且文档里很常见
 * （一个复合态就两个状态，没人愿意为它多敲两行）。
 * ⚠️ 不展开的后果很隐蔽：它**不是**被当成「不认」而被报出来，
 * 而是掉到后面的「裸状态」规则里被当成一个叫 `甲 { a1 --> a2 }` 的状态 ——
 * 图上多出一个名字长得离谱的框，而复合态一个都没有。
 *
 * 展开放在**解析之前**做，而不是在循环里加分支：这样后面所有规则
 * （成员登记、内外层归属、递归布局）都只面对一种形状。
 * ⚠️ 只认「整行就是一个复合态」：`A --> B { ... }` 那类写法不碰，
 *    展开错了会吃掉一条真实的迁移。
 */
function expandOneLineComposites(src: string): string {
  return src.split('\n').flatMap((raw) => {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) return [raw]
    const m = /^state\s+(.+?)\s*\{\s*(.+?)\s*\}\s*$/.exec(line)
    /* `}` 前面不能还有另一个 `{`（那是嵌套，交给跨行规则） */
    if (!m || m[2].includes('{')) return [raw]
    const indent = /^\s*/.exec(raw)?.[0] || ''
    /* 内层用 `;` 分隔；没有分号就当一整行（`a1 --> a2` 本来就是一条边） */
    const body = m[2].split(';').map((s) => s.trim()).filter(Boolean)
    return [raw.replace(/\{\s*.+?\s*\}\s*$/, '{'), ...body.map((b) => indent + '  ' + b), indent + '}']
  }).join('\n')
}

/**
 * 复合态的**递归布局**：自底向上把每个复合态的内部子图排好，
 * 再把复合态**当成一个节点**参与外层分层。
 *
 * 为什么必须递归：复合态里面的状态如果和**外层流程**排在同一层网格上，
 * 那个框就会从「申请中」一路横跨到「售后」，把中间四五个不相干的状态
 * 全包进去 —— 看着像「复合态画对了」，其实只是画了一个**更大的错框**。
 *
 * 三步：
 *   ① 切图：内层节点 = `ownerOf` 指向本复合态的；内层边 = **两端 owner 相同**的
 *   ② 内层用**同一份** layoutNodes 排（不另写一套算法 —— 两套算法必然在某
 *      个边界情况上不一致，而图上只是「偏几像素」）
 *   ③ 外层把复合态当成一个 (w, h) 的节点；渲染时用 `<g transform>` 整体平移内层
 */
function layoutComposites(out: Flowchart, compositeIds: Set<string>, ownerOf: Map<string, string>): void {
  if (!compositeIds.size) { out.groups = []; return }
  const nodeOf = new Map(out.nodes.map((n) => [n.id, n]))

  /** 深度优先算一个复合态的内部；返回 { w, h } 并把 inner 挂到节点上 */
  const solve = (cid: string, seen: Set<string>): { w: number; h: number } => {
    const self = nodeOf.get(cid)
    if (!self) return { w: 0, h: 0 }
    if (self.inner) return { w: self.w || 0, h: self.h || 0 }
    /* ⚠️ 环 / 重复引用兜底：复合态里再嵌同名复合态时递归会自激，
       那时返回一个最小尺寸并报出来，而不是无限递归到栈溢出。 */
    if (seen.has(cid)) { out.skipped.push(`复合态 ${cid}：内部出现了对自身的引用，只画了外框`); return { w: 90, h: 60 } }
    seen.add(cid)

    const kids = out.nodes.filter((n) => ownerOf.get(n.id) === cid)
    /* 嵌套复合态先算 —— 它们的尺寸是本层布局的输入 */
    for (const k of kids) if (compositeIds.has(k.id)) solve(k.id, new Set(seen))

    const kidIds = new Set(kids.map((k) => k.id))
    const kidEdges = out.edges.filter((e) => kidIds.has(e.from) && kidIds.has(e.to))
    if (!kids.length) {
      self.w = 90; self.h = 44
      self.inner = { nodes: [], edges: [] }
      seen.delete(cid)
      return { w: self.w, h: self.h }
    }

    assignLayers(kids, kidEdges)
    const { pos, spanMain, spanCross } = layoutNodes(kids, kidEdges, out.direction)
    /* 内层画布：内容尺寸 + 一圈内边距 + 顶部标题那一条。
       ⚠️ 必须把 **spanMain / spanCross 也算进去**：分层排布里最后几层
       可能不满，靠节点自身的最大坐标算会**切掉最下面那一层**。 */
    const maxX = Math.max(...kids.map((k) => { const p = pos.get(k.id)!; return p.x + (k.w || 90) }))
    const maxY = Math.max(...kids.map((k) => { const p = pos.get(k.id)!; return p.y + (k.h || 44) }))
    const contentW = Math.max(spanMain, maxX)
    const contentH = Math.max(spanCross, maxY)

    /* 内层坐标**从 0 起算**（`inner` 是相对复合态左上角的局部坐标，
       渲染时靠 transform 平移）。原来那份 pos 是从 0 排的，但 offset
       可能为负（层内居中的偏移），要整体平到内边距处。 */
    const minX = Math.min(...kids.map((k) => pos.get(k.id)!.x))
    const minY = Math.min(...kids.map((k) => pos.get(k.id)!.y))
    const dx = C_PAD - minX
    const dy = C_PAD + C_TITLE - minY

    /* ⚠️ 四边都要留够：**只加顶部那条（标题）+ 一份内边距**是不够的** ——
       那样内层框的底边会**正好压在外层框的底边上**（余量 0）。
       浏览器实测：内层框比外层框低 0px，套在一起看着像「框没套好」。
       几何上：内容占 [min..max]，平移后占 [C_PAD+C_TITLE, C_PAD+C_TITLE+(max-min)]，
       所以**下面还得再来一份 C_PAD**，左右同理。 */
    self.w = Math.ceil((contentW - minX) + C_PAD * 2)
    self.h = Math.ceil((contentH - minY) + C_PAD + C_TITLE + C_PAD)
    self.inner = {
      nodes: kids.map((k) => ({ n: k, x: pos.get(k.id)!.x + dx, y: pos.get(k.id)!.y + dy })),
      edges: kidEdges.map((e) => {
        const a = pos.get(e.from)!, b = pos.get(e.to)!
        return { e, ax: a.x + dx, ay: a.y + dy, bx: b.x + dx, by: b.y + dy }
      }),
    }
    seen.delete(cid)
    return { w: self.w, h: self.h }
  }

  /** 复合态自己的嵌套深度：它自己归谁管 */
  const depthOf = (cid: string): number => {
    const owner = ownerOf.get(cid)
    if (!owner || owner === cid) return 1
    return 1 + depthOf(owner)
  }

  /* 深的后算：先按 depth 从大到小，保证内层尺寸先算好 */
  const order = [...compositeIds].sort((a, b) => depthOf(b) - depthOf(a))
  for (const cid of order) solve(cid, new Set())

  /* 外层只留「不在任何复合态里的」节点 —— 它们才是外层流程的步骤。
     ⚠️ 少做这一步的后果就是当初那个病：内层状态和外层步骤排在同一层，
        框从内层一路横跨到外层，把不相干的状态全圈进去。 */
  out.nodes = out.nodes.filter((n) => !ownerOf.has(n.id))

  /* 外层边 = **不是**「两端属于同一个复合态」的边。
     ⚠️ 外层指向内层的边（`S1 --> 申请中`，而申请中在复合态里）要**改指复合态**：
        内层节点已经被移出 out.nodes，不改指的话 pos 查不到，
        那条边会**静默消失** —— 图看着对，就是少一条线。 */
  out.edges = out.edges
    .map((e) => {
      const of = ownerOf.get(e.from), ot = ownerOf.get(e.to)
      if (of && of === ot) return null                 // 内层边，已经画在框里了
      return {
        ...e,
        from: of || e.from,
        to: ot || e.to,
      }
    })
    .filter((e): e is FlowEdge => !!e)

  /* 改指之后可能出现自环（`A --> A`），assignLayers 对环有兜底，但自环画出来
     是一条长度为 0 的线 —— 直接去掉，并说一句实话。 */
  out.edges = out.edges.filter((e) => {
    if (e.from !== e.to) return true
    out.skipped.push(`迁移 ${e.from} → ${e.to}：指向自己，没有意义`)
    return false
  })

  out.groups = []
}

/** 一眼看出这份源码是不是状态图 */
export function isStateDiagramSource(src: string): boolean {
  return /^stateDiagram(-v2)?\b/i.test(firstMeaningfulLine(src))
}
