/* ============================================================
   Mermaid `stateDiagram` 解析 + 与 Flowchart 共用布局/渲染的契约
   + 路由判定里 stateDiagram 那一路
   ------------------------------------------------------------
   为什么单独成一套件：纯函数，Node 里直接 import 跑，秒级完成。
   它守的是**内网知识库里最高频**的一类内容 —— 审批流 / 订单状态机 /
   工单流转。状态图的结构就是「状态 + 迁移 + 标签」，流程图引擎已经会做，
   所以这里只写解析，布局与出 SVG 复用 `src/lib/flowchart.ts`。

   套件里的断言全是照**实际踩到的坑**写的：
     · 直接把 stateDiagram 喂给 parseFlowchart → `stateDiagram-v2` 头变成
       凭空多出来的节点、`[*] --> 待支付` 这条**起始迁移整条丢失**、
       `note right of A` 造出两个幽灵节点
     · 所有 `[*]` 共用「起点 / 终点」两个 id → 复合态里的 `[*]` 与顶层
       终止点撞车，「已发货 → 终点」那条线**又拐进了售后流程**
     · `[*]` 没拿到 dot 形状 → 起点画成带文字的椭圆
     · 复合态内部的迁移不从复合态出发 → BFS 走不到，那一整块节点
       `layer` 是 `undefined` → 图挤成一坨而 SVG 照样生成成功
     · note 的**正文行**被「裸状态」规则当成状态名 → 图上多一个叫
       「说明」的框
     · 「先声明一堆状态、后面再连边」的写法 → 孤立状态**整批消失**
   ============================================================ */
import { readFileSync } from 'node:fs'
import { parseStateDiagram, isStateDiagramSource } from './src/lib/statediagram.ts'
import { renderFlowchartSvg } from './src/lib/flowchart.ts'
import { pickDiagramMode, LOCALLY_RENDERED_MODES } from './src/lib/diagram.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

const SAMPLE = `stateDiagram-v2
    [*] --> 待支付
    待支付 --> 已支付 : 用户付款
    已支付 --> 履约中
    履约中 --> 已发货 : 出库
    已发货 --> [*]
    state 售后 {
        [*] --> 申请中
        申请中 --> 通过 : 审核
        通过 --> [*]
    }
    履约中 --> 售后 : 用户申请`

const DOTS = (g) => g.nodes.filter((n) => n.shape === 'dot')

console.log('== 识别 ==')
{
  ok(isStateDiagramSource('stateDiagram\nA --> B'), 'stateDiagram 认得出')
  ok(isStateDiagramSource('stateDiagram-v2\nA --> B'), 'stateDiagram-v2 认得出')
  ok(isStateDiagramSource('  \n stateDiagram-v2\nA --> B'), '前面有空行也认得出')
  ok(!isStateDiagramSource('graph TD\nA-->B'), 'mermaid 流程图不被误认')
  ok(!isStateDiagramSource('sequenceDiagram\nA->>B: x'), '时序图不被误认')
  ok(!isStateDiagramSource('digraph G { a->b }'), 'DOT 不被误认')
  ok(!isStateDiagramSource('@startuml\nA -> B\n@enduml'), 'PlantUML 不被误认')
  ok(!isStateDiagramSource(''), '空串不认')
}

console.log('\n== 不能直接喂给 parseFlowchart（这里钉住为什么）==')
{
  const g = parseStateDiagram(SAMPLE)
  const ids = g.nodes.map((n) => n.id)
  ok(!ids.includes('stateDiagram-v2'), '头部没有变成一个节点', JSON.stringify(ids))
  ok(!ids.includes('state'), '复合态的 `state` 关键字没有变成节点')
  ok(!ids.includes('note'), '没有幽灵节点 note')
  /* ⚠️ 2026-10-07 补上递归布局后，顶层只剩**外层流程**的节点：
     复合态内部那 4 个（起止点、申请中、通过）进了 `售后.inner`，
     由内层那次布局负责。总数从 11 变成 7 是**结构变了**，不是丢内容 ——
     下面专门有一条断言在数「顶层 + 内层」加起来还是 11。 */
  ok(g.nodes.length === 7, `顶层七个节点（${g.nodes.length}）`, JSON.stringify(ids))
  const total = g.nodes.length + (g.nodes.find((n) => n.inner)?.inner.nodes.length || 0)
  ok(total === 11, `顶层 + 内层一共十一个节点（${total}）—— 一个都没丢`, JSON.stringify(ids))
  ok(g.skipped.length === 0, 'skipped 是空的：复合态现在画得出来，不该再报「做不到」',
    JSON.stringify(g.skipped))
}

console.log('\n== [*] 起止点 ==')
{
  const g = parseStateDiagram(SAMPLE)
  const dots = DOTS(g)
  /* 顶层 2 个（流程起止）+ 复合态内部 2 个 —— 后者不再混在顶层里 */
  ok(dots.length === 2, `顶层两个圆点（${dots.length}）—— 复合态那两个在它自己的框里`,
    JSON.stringify(dots.map((d) => d.id)))
  const cs = g.nodes.find((n) => n.inner)
  ok(cs && DOTS({ nodes: cs.inner.nodes.map((c) => c.n) }).length === 2,
    '复合态内部的起止点也在（画在框里）')
  ok(dots.every((d) => d.label === ''), '圆点不带文字')
  const first = parseStateDiagram('stateDiagram-v2\n[*] --> A\nA --> [*]')
  ok(DOTS(first).length === 2, '最简单的起止也认得出')
  const orphan = parseStateDiagram('stateDiagram-v2\n[*]')
  ok(DOTS(orphan).length === 0, '没人引用的 [*] 不画（不凭空多个孤零零的圆点）')
}

console.log('\n== 迁移与标签 ==')
{
  const g = parseStateDiagram(SAMPLE)
  ok(g.edges.length === 6, `顶层六条迁移（${g.edges.length}）—— 复合态内部那三条在框里`,
    JSON.stringify(g.edges.map((e) => `${e.from}->${e.to}`)))
  const cs = g.nodes.find((n) => n.inner)
  ok(cs && cs.inner.edges.length === 3, '复合态内部三条迁移',
    cs ? JSON.stringify(cs.inner.edges.map((e) => `${e.from}->${e.to}`)) : '')
  /* 标签**一条都不能丢**：内外层分开之后最容易丢的就是它 */
  const allLabels = [
    ...g.edges.map((e) => e.label),
    ...(cs ? cs.inner.edges.map((e) => e.e.label) : []),
  ]
  ok(allLabels.some((e) => e.includes('用户付款')), '「用户付款」这条标签在')
  ok(allLabels.some((e) => e.includes('审核')), '复合态里的「审核」标签也在（它在内层）',
    JSON.stringify(allLabels))
  ok(allLabels.some((e) => e.includes('用户申请')), '进/出复合态的标签也在')
  ok(g.edges.some((e) => e.from.startsWith('￿') && e.to === '待支付'), '起始迁移没丢')
  ok(g.edges.some((e) => e.from === '已发货' && e.to.startsWith('￿')), '终止迁移没丢')
  const noLabel = parseStateDiagram('stateDiagram-v2\nA --> B')
  ok(noLabel.edges.length === 1 && noLabel.edges[0].label === '', '没写标签时标签是空串')
}

console.log('\n== 分层：BFS 走不到的那块节点也得有 layer ==')
{
  const g = parseStateDiagram(SAMPLE)
  ok(g.nodes.every((n) => typeof n.layer === 'number'), '每个节点都有数字 layer',
    JSON.stringify(g.nodes.map((n) => [n.id, n.layer])))
  ok(g.nodes.every((n) => typeof n.order === 'number'), '每个节点都有数字 order')
  /* ⚠️ 2026-10-07 复合态有了递归布局之后，内层节点**不再出现在顶层** ——
     它们进到复合态的 `inner` 里、由内层那次布局负责分层。
     所以这里查的不再是「内层节点在顶层有 layer」，而是「内层节点确实被算进去了」。 */
  const cs = g.nodes.find((n) => n.id === '售后')
  ok(cs && cs.inner, '售后是一个带内层的复合态')
  const inside = cs ? cs.inner.nodes.map((c) => c.n) : []
  /* 4 个：复合态自己的起止点 + 申请中 + 通过。少一个就是丢了。 */
  ok(inside.length === 4 && inside.every((n) => typeof n.layer === 'number' && typeof n.order === 'number'),
    '复合态内部的节点有层号与顺序（内层那次布局给的）', JSON.stringify(inside.map((n) => [n.id, n.layer, n.order])))
  ok(inside.every((n) => typeof n.layer === 'number'), '包括内层那两个 [*] 圆点', JSON.stringify(inside.map((n) => n.id)))
  ok(!g.nodes.some((n) => ['申请中', '通过'].includes(n.id)),
    '内层节点不在顶层（否则会与外层排在同一层网格上 —— 那就是当初那个更大的错框）',
    JSON.stringify(g.nodes.map((n) => n.id)))
}

console.log('\n== 复合状态：递归布局画外框（2026-10-07 补上的）==')
{
  const g = parseStateDiagram(SAMPLE)
  const cs = g.nodes.find((n) => n.id === '售后')
  ok(cs && g.nodes.some((n) => n.id === '售后') && cs.inner,
    '复合态与它内部的状态都解析出来')
  ok(g.groups.length === 0, '不给渲染器传分组 —— 框由复合态自己的 w/h 画，不是那个通用分组框',
    JSON.stringify(g.groups))
  ok(!g.skipped.some((s) => /外框没画/.test(s)), '不再报「外框没画」', JSON.stringify(g.skipped))
  /* 框必须**装得下**每一个内层节点（含嵌套复合态）—— 装不下就是切字 */
  ok(cs && cs.inner, '有内层')
  if (cs && cs.inner) {
    const maxX = Math.max(...cs.inner.nodes.map((c) => c.x + (c.n.w || 0)))
    const maxY = Math.max(...cs.inner.nodes.map((c) => c.y + (c.n.h || 0)))
    ok(cs.w >= maxX && cs.h >= maxY, `框 ${cs.w}×${cs.h} 装得下内容 ${maxX.toFixed(0)}×${maxY.toFixed(0)}`)
    ok(cs.inner.nodes.every((c) => c.x >= 0 && c.y >= 0), '内层坐标都是正的（translate 之后不会被父框裁掉）',
      JSON.stringify(cs.inner.nodes.map((c) => [c.n.id, c.x, c.y])))
    ok(cs.inner.edges.length === 3, '内层三条边', cs.inner.edges.length)
  }
  const svg = renderFlowchartSvg(g)
  ok(/class="yq-fc-node yq-fc-composite"/.test(svg), 'SVG 里有复合态那个大框')
  ok(!/class="yq-fc-group"/.test(svg), '没有那个「更大的错框」')
  const named = parseStateDiagram('stateDiagram-v2\nstate "复合态" as cs {\n  [*] --> x\n}\ncs --> 终态')
  ok(named.nodes.some((n) => n.id === 'cs'), '带引号 as 形式的复合态也认得出',
    JSON.stringify(named.nodes.map((n) => n.id)))
  /* 单行写法 `state 甲 { a --> b }` —— 不展开的话它会变成一个
     名字叫「甲 { a --> b }」的裸状态，复合态一个都没有 */
  const oneLine = parseStateDiagram('stateDiagram-v2\n[*] --> A\nstate 甲 { a --> b }')
  const m = oneLine.nodes.find((n) => n.id === '甲')
  ok(m && m.inner && m.inner.nodes.length === 2, '单行复合态也认得，并展开成内层',
    JSON.stringify(oneLine.nodes.map((n) => n.id)))
  const unclosed = parseStateDiagram('stateDiagram-v2\nstate G {\n  [*] --> x')
  const ug = unclosed.nodes.find((n) => n.id === 'G')
  ok(unclosed.nodes.length === 1 && ug && ug.inner && ug.inner.nodes.length === 2,
    '没收尾的复合态照样解析（不丢内容）',
    JSON.stringify(unclosed.nodes.map((n) => n.id)))

  /* 嵌套：三层框套框，每层都要**装得下**且留够余量。
     ⚠️ 余量这条是 2026-10-07 浏览器实测逼出来的：第一版只加了「标题 + 一份内边距」，
     于是内层框的底边**正好压在外层框底边上**（余量 0）——
     不裁字、不报错，但读者看到的就是「框套框没套好」。
     ⚠️ 下面比较的必须是**相对**余量：递归收集到的是绝对坐标，
     直接减父框尺寸会算出负几百的「余量」—— 那是探针自己错。 */
  const C_PAD = 12, C_TITLE = 20
  const rects = []
  const dfs = (nodes, ox, oy, depth) => {
    for (const n of nodes) {
      if (!n.inner) continue
      rects.push({ name: n.id, x: ox, y: oy, w: n.w, h: n.h, depth })
      for (const c of n.inner.nodes) dfs([c.n], ox + c.x, oy + c.y, depth + 1)
    }
  }
  dfs(parseStateDiagram('stateDiagram-v2\n  [*] --> A\n  A --> B\n  state A {\n    a1 --> a2\n    state B {\n      b1 --> b2\n      state C {\n        c1 --> c2\n      }\n    }\n  }').nodes, 0, 0, 0)
  ok(rects.length === 3, '三层嵌套解析出三个复合态', JSON.stringify(rects.map((r) => r.name)))
  ok(rects.map((r) => r.depth).join(',') === '0,1,2', '深度是 0/1/2（第二三层真的嵌进去了）',
    JSON.stringify(rects.map((r) => [r.name, r.depth])))
  for (let i = 0; i + 1 < rects.length; i++) {
    const p = rects[i], c = rects[i + 1]
    if (c.depth !== p.depth + 1) continue
    const rx = c.x - p.x, ry = c.y - p.y
    const m = { l: rx, t: ry, r: p.w - rx - c.w, b: p.h - ry - c.h }
    ok(m.l >= C_PAD && m.r >= C_PAD && m.t >= C_PAD + C_TITLE - 2 && m.b >= C_PAD,
      `${c.name} 完整落在 ${p.name} 里（四边余量 ${m.l}/${m.t}/${m.r}/${m.b}）`)
  }
  /* 每个复合态的内容都要装得下（含嵌套复合态自身） */
  const checkFit = (nodes, label) => {
    for (const n of nodes) {
      if (!n.inner) continue
      const mx = Math.max(...n.inner.nodes.map((c) => c.x + (c.n.w || 0)))
      const my = Math.max(...n.inner.nodes.map((c) => c.y + (c.n.h || 0)))
      ok(n.w >= mx && n.h >= my, `${label}：${n.id} 装得下内容（${n.w}×${n.h} vs ${mx}×${my}）`)
      if (n.inner.nodes.some((c) => c.n.inner)) checkFit(n.inner.nodes.map((c) => c.n), label + '/' + n.id)
    }
  }
  const three = parseStateDiagram('stateDiagram-v2\n  [*] --> A\n  A --> B\n  state A {\n    a1 --> a2\n    state B {\n      b1 --> b2\n      state C {\n        c1 --> c2\n      }\n    }\n  }')
  checkFit(three.nodes, '三层')
}

console.log('\n== 并发区域（<<fork>> / <<join>>）==')
{
  const g = parseStateDiagram(`stateDiagram-v2
  [*] --> 待提交
  state 分岔 <<fork>>
  待提交 --> 分岔
  分岔 --> 人工审核
  分岔 --> 自动通过
  state 汇合 <<join>>
  人工审核 --> 汇合
  自动通过 --> 汇合
  汇合 --> 已完成`)
  const f = g.nodes.find((n) => n.id === '分岔')
  const j = g.nodes.find((n) => n.id === '汇合')
  ok(f?.shape === 'fork' && j?.shape === 'join', 'fork / join 认得并单独标形状',
    JSON.stringify(g.nodes.map((n) => `${n.id}(${n.shape})`)))
  ok(g.skipped.length === 0, '不再报「不认」', JSON.stringify(g.skipped))
  ok(g.edges.filter((e) => e.from === '分岔').length === 2, '分岔点真的分出两条边',
    g.edges.filter((e) => e.from === '分岔').length)

  const svg = renderFlowchartSvg(g)
  const bars = [...svg.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="[\d.]+" class="yq-fc-fork"/g)]
    .map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }))
  ok(bars.length === 2, '画出两根横杠（分岔 + 汇合）', bars.length)
  /* ⚠️ 必须是**横杠**而不是普通状态框。横杠是状态图里「这里分岔/汇合」的
     通用画法；画成圆角框等于宣称「这是个状态」，而它其实是路由点。
     高度差是最容易验的那一条。 */
  ok(bars.every((b) => b.h <= 20), '横杠明显比普通节点矮（不是状态框）', JSON.stringify(bars.map((b) => b.h)))
  ok(bars.every((b) => b.w >= 100), '横杠横贯节点宽度', JSON.stringify(bars.map((b) => b.w)))
  const W = Number(/width="(\d+)"/.exec(svg)[1]), H = Number(/height="(\d+)"/.exec(svg)[1])
  ok(bars.every((b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H),
    '横杠完整落在 viewBox 内', JSON.stringify({ bars, W, H }))

  /* ⚠️ `.yq-fc-fork` 的 CSS 必须存在 —— 不给 fill 就是 SVG 默认纯黑，
     在深色主题下会和背景糊在一起，看着像「这段没画出来」。 */
  const css2 = readFileSync('src/components/cards/cards.css', 'utf8')
  const fr = /\.yq-fc-fork\s*\{[^}]*\}/.exec(css2)?.[0] || ''
  /* ⚠️ 这里必须断**规则名对得上**且**有 fill**。
     第一版我写成 `/\.yq-fork|/.test(fr)` —— 正则里带空分支，于是**任何字符串都匹配**，
     断言恒真，等于没断。（这个项目反复吃过「恒真断言」的亏：
     照语法表逐条翻译出来的断言看起来很像测试，其实什么都验不到。） */
  ok(fr.length > 0, 'cards.css 里有 .yq-fc-fork 的规则', fr.slice(0, 60))
  ok(/fill\s*:/.test(fr), '.yq-fc-fork 显式给了 fill（不给就是 SVG 默认纯黑，深色主题下会糊掉）', fr)

  /* 方向无关：横排下同样是横杠 */
  const lr = parseStateDiagram('stateDiagram-v2\n  direction LR\n  [*] --> A\n  state 分 <<fork>>\n  A --> 分\n  分 --> B\n  B --> [*]')
  ok(lr.nodes.find((n) => n.id === '分')?.shape === 'fork', 'direction LR 下也认得')
}
{
  const desc = parseStateDiagram('stateDiagram-v2\nA : 这是A的说明\nA --> B')
  ok(desc.nodes.find((n) => n.id === 'A')?.label === '这是A的说明', '`A : 说明` 当状态名',
    JSON.stringify(desc.nodes.find((n) => n.id === 'A')))
  const lone = parseStateDiagram('stateDiagram-v2\nA')
  ok(lone.nodes.length === 1, '孤立状态也画出来（第一版整批消失）', String(lone.nodes.length))
  ok(lone.skipped.length === 0, '孤立状态不该进 skipped')
}

console.log('\n== note 旁注：2026-10-07 从「认得但做不了」变成真画出来 ==')
{
  const g = parseStateDiagram('stateDiagram-v2\nA --> B\nnote right of A\n  这是一条说明')
  ok(g.nodes.length === 2, 'note 正文**不会**变成节点', JSON.stringify(g.nodes.map((n) => n.id)))
  ok(!g.nodes.some((n) => n.id.includes('说明')), '没有叫「说明」的幽灵框')
  /* 同行没写正文时（`note right of A` + 缩进续行）仍然吃掉续行 */
  ok(g.notes.length === 1 && g.notes[0].text === '这是一条说明', '缩进续行被收成正文', JSON.stringify(g.notes))
  ok(g.skipped.length === 0, '画得出来就不该再报「做不到」', JSON.stringify(g.skipped))

  const sides = parseStateDiagram('stateDiagram-v2\nA --> B\nnote right of A : 右\nB --> [*]\nnote left of B : 左')
  ok(sides.notes.map((n) => n.side).join(',') === 'right,left', '左右两侧都认',
    JSON.stringify(sides.notes.map((n) => n.side)))

  /* ⚠️ 同行有正文时**不吃**后续缩进行 —— 绝大多数文档整体缩进，
     无条件吃的结果是注释变成「这里是入口 A --> [*]」，把一条真实迁移吞了。 */
  const ind = parseStateDiagram('stateDiagram-v2\n  [*] --> A\n  note left of A : 这里是入口\n  A --> [*]')
  ok(ind.notes[0].text === '这里是入口', '缩进的下一行不会被吞进注释正文', JSON.stringify(ind.notes))
  ok(ind.edges.some((e) => e.from === 'A' && e.to.startsWith('￿')), '那条真实迁移还在',
    JSON.stringify(ind.edges.map((e) => `${e.from}->${e.to}`)))

  /* 两条 note 都要在：第一版新分支直接覆写 noteBody，把第一条静默吞了 */
  const two = parseStateDiagram('stateDiagram-v2\nA --> B\nnote right of A : 一\nnote right of B : 二\nB --> [*]')
  ok(two.notes.length === 2, '同一状态挂两条 note 都要在', JSON.stringify(two.notes.map((n) => n.text)))

  /* 指向不存在 / 没被用到的状态：丢掉并说出来，不画悬空框 */
  const ghost = parseStateDiagram('stateDiagram-v2\nA --> B\nnote right of 不存在 : x')
  ok(ghost.notes.length === 0, '指向不存在状态的 note 不留下', JSON.stringify(ghost.notes))
  ok(ghost.skipped.some((s) => /note 挂在/.test(s)), '并且说明为什么丢', JSON.stringify(ghost.skipped))

  /* ⚠️ 旁注框必须完整落在 viewBox 内。`note left of X` 的框整个画在 x 为负的一侧 ——
     只把旁注算进 max 不算进 min 的话，它「画出来了但整个在 viewBox 外」，
     界面上表现为「这行 note 没画」，而解析与坐标全对。 */
  const svg = renderFlowchartSvg(ind)
  const W = Number(/width="(\d+)"/.exec(svg)[1]), H = Number(/height="(\d+)"/.exec(svg)[1])
  const rects = [...svg.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="4" class="yq-fc-note"/g)]
    .map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }))
  ok(rects.length === 1, '左侧旁注确实画出来了', rects.length)
  ok(rects.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H),
    '旁注框完整落在 viewBox 内', JSON.stringify({ rects, W, H }))
  ok(svg.includes('yq-fc-note-text'), '旁注文字也在图上')
  /* 两条 note 要竖着排开，不能重叠 */
  const twoSvg = renderFlowchartSvg(two)
  const boxes2 = [...twoSvg.matchAll(/<rect x="(-?[\d.]+)" y="(-?[\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
    .filter((m) => /yq-fc-note/.test(twoSvg.slice(twoSvg.indexOf(m[0]), twoSvg.indexOf(m[0]) + 120)))
  void boxes2
  ok((twoSvg.match(/class="yq-fc-note"/g) || []).length === 2, '两条 note 都画出来了',
    (twoSvg.match(/class="yq-fc-note"/g) || []).length)

  /* ⚠️ `.yq-fc-note` / `.yq-fc-note-text` 的 CSS 必须存在：
     SVG 里没写 fill 的 rect 默认**纯黑**、text 默认黑字 ——
     页面上只看得见溢出到框外的那几个字，看着像「文字排版坏了」。
     第一版就是漏了这两条规则，浏览器实测才发现（单测与坐标全绿）。 */
  const css = readFileSync('src/components/cards/cards.css', 'utf8')
  ok(/\.yq-fc-note\s*\{/.test(css), 'cards.css 里有 .yq-fc-note 的规则')
  ok(/\.yq-fc-note-text\s*\{/.test(css), 'cards.css 里有 .yq-fc-note-text 的规则')
  const noteRule = /\.yq-fc-note\s*\{[^}]*\}/.exec(css)?.[0] || ''
  ok(/fill\s*:/.test(noteRule), '.yq-fc-note 显式给了 fill（否则 SVG 默认纯黑）', noteRule)
}

console.log('\n== direction ==')
{
  ok(parseStateDiagram('stateDiagram-v2\ndirection LR\nA --> B').direction === 'LR', 'direction LR 生效')
  ok(parseStateDiagram('stateDiagram-v2\ndirection TB\nA --> B').direction === 'TB', 'direction TB 生效')
  ok(parseStateDiagram('stateDiagram\nA --> B').direction === 'TD', '默认 TD')
}

console.log('\n== 边界 ==')
{
  ok(parseStateDiagram('').nodes.length === 0, '空源码不炸')
  ok(renderFlowchartSvg(parseStateDiagram('')) === '', '空源码渲染出空串')
  ok(renderFlowchartSvg(parseStateDiagram('stateDiagram-v2')) === '', '只有头部渲染出空串')
  const bad = parseStateDiagram('stateDiagram-v2\nA-- >B')
  ok(bad.nodes.length === 0 && bad.skipped.length === 1, '认不出的行进 skipped 且不产出节点',
    JSON.stringify(bad.skipped))
}

console.log('\n== 渲染 ==')
{
  const svg = renderFlowchartSvg(parseStateDiagram(SAMPLE))
  ok(svg.startsWith('<svg'), '输出以 <svg 开头')
  ok(svg.trimEnd().endsWith('</svg>'), '输出以 </svg> 结尾')
  ok((svg.match(/class="yq-fc-dot"/g) || []).length === 4, '四个起止点画成实心圆点')
  // 圆点是自闭合的 <circle/>，**后面不跟 <text>** —— 用正则抓「圆点后面紧跟的文字」
  // 而不是写一个双重否定（那种断言恒真，等于没验）
  ok(!/class="yq-fc-dot"\/>\s*<text/.test(svg), '圆点后面没有文字标签')
  ok(svg.includes('待支付') && svg.includes('审核'), '状态名与标签都进了 SVG')
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
  ok(vb && Number(vb[1]) > 0 && Number(vb[2]) > 0, `viewBox 正数（${vb?.[1]}×${vb?.[2]}）`)
  const esc = renderFlowchartSvg(parseStateDiagram('stateDiagram-v2\nA --> B : <script>x</script>'))
  ok(!/<script/i.test(esc), '<script> 被转义掉了，没进 SVG')
}

console.log('\n== 路由 ==')
{
  ok(pickDiagramMode('stateDiagram-v2\nA --> B') === 'state', 'stateDiagram 走自己的解析器')
  ok(pickDiagramMode('stateDiagram\nA --> B') === 'state', 'v1 语法也走')
  /* ⚠️ 这里**故意不硬编码**整份清单。
     2026-10-07 连续两轮栽在这上面：先是断言 `join(',') === 'flow,seq,dot,gantt'`，
     加了 state 就红，改成五种又加了 mind 再红 —— 每次都是**别的套件**里的
     一个字符串落后了。
     `LOCALLY_RENDERED_MODES` 是**派生清单**，每加一种图种它就会变长；
     把它整个写死等于在每个套件里都放一个必然过期的副本。
     真正该守的是「我要的那种在不在」和「清单别有重复」，
     这两条**不会**因为新增图种而失效。 */
  ok(LOCALLY_RENDERED_MODES.includes('state'), 'state 在本地可渲染清单里', LOCALLY_RENDERED_MODES.join(','))
  ok(new Set(LOCALLY_RENDERED_MODES).size === LOCALLY_RENDERED_MODES.length, '清单里没有重复项',
    LOCALLY_RENDERED_MODES.join(','))
  ok(!LOCALLY_RENDERED_MODES.includes('unsupported'),
    'unsupported 不该被当成「本地能出图」', LOCALLY_RENDERED_MODES.join(','))
  ok(pickDiagramMode('graph TD\nA-->B') === 'flow', 'mermaid 流程图不被状态图入口吃掉')
  /* ⚠️ 2026-10-07 改过：原来断言 `=== 'unsupported'`（「gantt 仍不走本地渲染器」）。
     那条锁死的是**甘特图路由被误吞**这个缺陷 —— `diagram.ts` 里
     `mk === 'unknown' && isGanttSource(text)` 恒假，因为 `detectMermaid('gantt…')`
     返回的是 `'gantt'`。状态图套件本来只用来做「别被别的族吃掉」的隔离断言，
     却顺手把当时的 bug 写成了期望值。 */
  ok(pickDiagramMode('gantt\ndateFormat X') === 'gantt', 'mermaid 的 gantt 走本地渲染器（不再被吞成「未实现」）')
  ok(pickDiagramMode('digraph G { a->b }') === 'dot', 'DOT 路由没被影响')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1