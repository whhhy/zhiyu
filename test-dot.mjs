/* ============================================================
   Graphviz DOT 解析 + 与 Flowchart 共用布局/渲染的契约
   + 文本绘图的路由判定（PlantUML / DOT / Mermaid 三族）
   ------------------------------------------------------------
   为什么单独成一套件：纯函数（解析 + 出 SVG 字符串），
   Node 里直接 import 跑，秒级完成，改一行立刻能验。

   它守的是 2026-10-06/07 记下的 1:1 差距最后一块拼图：
   语雀官方五种文本绘图里 Graphviz 一直空着。
   本轮补 DOT —— **不重写布局**，而是转成 Flowchart 结构后
   复用 `src/lib/flowchart.ts` 的分层与渲染，零新增渲染代码。

   套件里有五条断言是照**实际踩到的坑**写的：
     · 没调 assignLayers → 每个节点 layer 是 undefined，图挤成一坨，
       而 SVG 照样生成成功（只是「图怪」，不报错）
     · `(?:di)?graph` 写成 `di?graph` → 无向图整段解析成空
     · 头部正则要求图名 → `digraph { a->b }` 这种合法写法认不出
     · cluster 整段进 skipped → 里面的点与边、以及 cluster 之后
       的语句全部凭空消失（静默丢内容）
     · 端点 token 排除 `:` → 端口写法 `a:p -> b:q` 整行匹配不上
   ============================================================ */
import { parseDot, isDotSource } from './src/lib/dot.ts'
import { renderFlowchartSvg } from './src/lib/flowchart.ts'
import { pickDiagramMode, LOCALLY_RENDERED_MODES } from './src/lib/diagram.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

const SAMPLE = `digraph G {
  rankdir=LR;
  // 行注释
  start [label="收到工单", shape=box];
  check  [label="需要审批吗", shape=diamond];
  store  [label="工单库", shape=cylinder];
  ok     [label="通过", shape=stadium];
  no     [label="驳回", shape=ellipse];
  start -> check [label="提交"];
  check -> store [label="是"];
  check -> no [label="否"];
  no -> start [label="重新提交"];
  store -> ok;
}`

console.log('== 识别 ==')
{
  ok(isDotSource('digraph G { a -> b }'), 'digraph 认得出')
  ok(isDotSource('graph G { a -- b }'), 'graph（无向）也认得出')
  ok(isDotSource('strict digraph G { a -> b }'), 'strict 认得出')
  ok(isDotSource('digraph { a -> b }'), '省略图名也认得出（合法 DOT）')
  // ⚠️ 中文图名：本项目里「digraph 工单流转 { … }」是常态，
  //    图名正则若只收 [A-Za-z_]，整段认不出来 → 图**渲染成空白**且不报错
  ok(isDotSource('digraph 工单流转 { a -> b }'), '中文图名认得出')
  ok(isDotSource('strict digraph 订单状态机 { a -> b }'), 'strict + 中文图名认得出')
  ok(parseDot('digraph 工单流转 { a -> b; }').edges.length === 1, '中文图名能解析出边')
  ok(parseDot('graph 流程 {\n rankdir=LR;\n a -> b;\n}').direction === 'LR', '中文图名 + rankdir 生效')
  ok(isDotSource('  \n digraph G {\n a->b;\n}'), '前面有空行也认得出')
  ok(!isDotSource('graph TD\nA-->B'), 'mermaid 的 graph TD 不被当成 DOT')
  ok(!isDotSource('@startuml\nA -> B\n@enduml'), 'PlantUML 不被当成 DOT')
  ok(!isDotSource('sequenceDiagram\nA->>B: x'), 'mermaid 时序图不被当成 DOT')
  ok(!isDotSource('随便一段'), '普通文字不认')
  ok(!isDotSource(''), '空串不认')
}

console.log('\n== 解析：节点、形状、标签、边 ==')
{
  const g = parseDot(SAMPLE)
  const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]))
  ok(g.direction === 'LR', `rankdir=LR 被认出来（${g.direction}）`)
  ok(g.nodes.length === 5, `五个节点（${g.nodes.length}）`, JSON.stringify(g.nodes.map((n) => n.id)))
  ok(by.start?.label === '收到工单', 'label 属性生效', JSON.stringify(by.start))
  ok(by.check?.shape === 'diamond', 'shape=diamond → diamond', by.check?.shape)
  ok(by.store?.shape === 'cylinder', 'shape=cylinder → cylinder', by.store?.shape)
  ok(by.ok?.shape === 'stadium', 'shape=stadium → stadium', by.ok?.shape)
  ok(by.no?.shape === 'round', 'shape=ellipse → round', by.no?.shape)
  ok(g.edges.length === 5, `五条边（${g.edges.length}）`, JSON.stringify(g.edges.map((e) => `${e.from}->${e.to}`)))
  ok(g.edges[0].label === '提交', '边标签生效', JSON.stringify(g.edges[0]))
  ok(g.skipped.length === 0, '完整样例没有 skipped', JSON.stringify(g.skipped))
}

console.log('\n== 分层必须真跑（漏掉这步图会挤成一坨却不报错）==')
{
  const g = parseDot(SAMPLE)
  const L = Object.fromEntries(g.nodes.map((n) => [n.id, n.layer]))
  ok(g.nodes.every((n) => typeof n.layer === 'number'), '每个节点都有数字 layer',
    JSON.stringify(g.nodes.map((n) => [n.id, n.layer])))
  ok(g.nodes.every((n) => typeof n.order === 'number'), '每个节点都有数字 order')
  ok(L.start === 0, `起点在第 0 层（${L.start}）`)
  ok(L.check === 1, `check 在第 1 层（${L.check}）`)
  ok(L.store === 2 && L.no === 2, '分叉的两个节点同层', JSON.stringify(L))
  ok(L.ok === 3, `终点在最外层（${L.ok}）`)
  // 真正能出图，而且不是一个塌掉的尺寸
  const svg = renderFlowchartSvg(g)
  // ⚠️ 别硬编码 viewBox 的数字前缀 —— 那是把「大概对」写成了断言。
  //   要真的解出宽高再比大小。
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
  const w = Number(vb?.[1]), h = Number(vb?.[2])
  ok(vb && w > 0 && h > 0, `viewBox 宽高都是正数（${w}×${h}，没塌成 0）`, svg.slice(0, 90))
  ok((svg.match(/class="yq-fc-node/g) || []).length === 5, '五个节点形状都画出来了')
  ok((svg.match(/yq-fc-edge"/g) || []).length === 5, '五条连线都画出来了')
}

console.log('\n== 无向 / strict / 注释 ==')
{
  const und = parseDot('graph G {\n a -- b;\n b -- c;\n}')
  ok(und.nodes.length === 3, '无向图的点都在', String(und.nodes.length))
  ok(und.edges.length === 2, '无向图的边都在', String(und.edges.length))
  ok(und.edges.every((e) => e.arrow === 'none'), '无向边不画箭头（arrow=none）',
    JSON.stringify(und.edges.map((e) => e.arrow)))
  ok(parseDot('strict digraph G { a -> b; }').nodes.length === 2, 'strict 能解析')
  const cm = parseDot('digraph { /* 块 */ a -> b; // 行\n b -> c; }')
  ok(cm.nodes.length === 3 && cm.edges.length === 2, '块注释与行注释都被剥掉',
    `${cm.nodes.length}/${cm.edges.length}`)
}

console.log('\n== cluster：外框现在真画出来（点与边一直是对的）==')
{
  const g = parseDot('digraph { subgraph cluster_0 { a; b; } a -> b; }')
  ok(g.nodes.length === 2, 'cluster 里的点被解析出来', JSON.stringify(g.nodes.map((n) => n.id)))
  ok(g.edges.length === 1, 'cluster **之后**的边没被吞掉', JSON.stringify(g.edges.map((e) => `${e.from}->${e.to}`)))
  ok(g.groups.length === 1, 'cluster 被收集成分组（不再是「外框未画」）', JSON.stringify(g.groups))
  ok(g.groups[0].members.join(',') === 'a,b', '成员正确', g.groups[0]?.members.join(','))
  ok(g.skipped.length === 0, '认得的 cluster 不该再进 skipped', JSON.stringify(g.skipped))
  const svg = renderFlowchartSvg(g)
  ok((svg.match(/class="yq-fc-group"/g) || []).length === 1, '框真的画进 SVG 了')
  const nested = parseDot('digraph { subgraph cluster_a { x -> y } subgraph cluster_b { y -> z } }')
  ok(nested.nodes.length === 3 && nested.edges.length === 2, '两个 cluster 的内容都在',
    `${nested.nodes.length}/${nested.edges.length}`)
  ok(nested.groups.length === 2, '两个 cluster 都成了分组', String(nested.groups.length))
  const named = parseDot('digraph { subgraph cluster_a { label = "分组A"; x -> y } }')
  ok(named.groups[0].label === '分组A', 'cluster 的 label= 当显示名', named.groups[0]?.label)
  ok(named.nodes.length === 2, 'label= 不是节点', String(named.nodes.length))
}

console.log('\n== 端口写法 ==')
{
  const g = parseDot('digraph { a:p -> b:q; }')
  ok(g.nodes.length === 2, '端口写法产出两个点', JSON.stringify(g.nodes.map((n) => n.id)))
  ok(g.edges.length === 1, '端口写法产出边')
  ok(g.nodes.map((n) => n.id).join(',') === 'a,b', '端口被剥掉（id 是冒号前那段）', JSON.stringify(g.nodes.map((n) => n.id)))
  ok(g.skipped.length === 0, '端口写法不该进 skipped', JSON.stringify(g.skipped))
}

console.log('\n== 属性与引号 ==')
{
  const q = parseDot('digraph { a [label="say \\"hi\\""]; }')
  ok(q.nodes[0].label === 'say "hi"', '引号里的转义引号还原正确', JSON.stringify(q.nodes[0].label))
  const order = parseDot('digraph { a [shape=diamond, label="甲"]; a->b; }')
  const by = Object.fromEntries(order.nodes.map((n) => [n.id, n]))
  ok(by.a?.shape === 'diamond' && by.a?.label === '甲', '属性顺序换了也照样认',
    JSON.stringify(by.a))
  const multi = parseDot('digraph {\n  a [\n    label="很长的一段标签"\n  ];\n  a -> b [label="边上的文字"];\n}')
  ok(multi.nodes[0].label === '很长的一段标签', '跨行属性能解析', JSON.stringify(multi.nodes[0]))
  ok(multi.edges[0].label === '边上的文字', '跨行边标签能解析')
}

console.log('\n== 认不出来的写法要明说 ==')
{
  const g = parseDot('digraph { a [shape=hexagon]; a->b; }')
  ok(g.nodes.length === 2 && g.edges.length === 1, '未知形状不影响点与边')
  ok(g.skipped.some((s) => /hexagon/.test(s)), '未知形状记进 skipped', JSON.stringify(g.skipped))
  ok(parseDot('').nodes.length === 0, '空源码不炸')
  ok(parseDot('graph TD\nA-->B').nodes.length === 0, '非 DOT 不产出节点')
  ok(parseDot('digraph { a -> b;').nodes.length === 2, '缺右括号照样把内容解析出来（不丢）')
}

console.log('\n== 渲染复用：文本必须转义 ==')
{
  const g = parseDot('digraph { a [label="<script>x</script> & \\"q\\""]; a->b; }')
  const svg = renderFlowchartSvg(g)
  ok(!/<script/i.test(svg), '<script> 被转义掉了，没进 SVG')
  ok(svg.includes('&lt;script&gt;'), '转义后的实体在 SVG 里')
  ok(renderFlowchartSvg(parseDot('')) === '', '空源码渲染出空串')
}

console.log('\n== 路由：**只**留与 DOT 有关的判定 ==')
{
  /* ⚠️ 完整的路由表**只有一份**，在 test-statediagram.mjs 的「路由」一节。
     2026-10-07 这里曾抄了一份全表，结果加了 stateDiagram 之后两边打架：
     本套件还停在 stateDiagram → unsupported，那边已经是 state，
     全量因此红了两项。
     路由判定的性质决定它**只能有一处** —— 抄一份就等于造一个必然过期的副本。
     这里只留「DOT 相关的」那几条：它们才是本套件真正要守的东西。 */
  ok(pickDiagramMode('digraph { a -> b }') === 'dot', 'DOT 不被 mermaid 入口吃掉')
  ok(pickDiagramMode('graph TD\nA-->B') === 'flow', 'mermaid 的 graph 不被 DOT 入口吃掉')
  ok(pickDiagramMode('graph G { a -- b; }') === 'dot', '无向 graph 走 DOT（不是 mermaid）')
  ok(pickDiagramMode('digraph 工单流转 { a -> b; }') === 'dot', '中文图名也走 DOT')
  ok(pickDiagramMode('@startuml\nA -> B\n@enduml') === 'uml', 'PlantUML 优先于 DOT')
  ok(LOCALLY_RENDERED_MODES.includes('dot'), 'dot 在本地可渲染清单里', LOCALLY_RENDERED_MODES.join(','))
  ok(new Set(LOCALLY_RENDERED_MODES).size === LOCALLY_RENDERED_MODES.length,
    '本地可渲染清单里没有重复项（新增图种时这条不会失效）', LOCALLY_RENDERED_MODES.join(','))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
