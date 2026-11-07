/* ============================================================
   Flowchart（graph/flowchart）解析与 SVG 渲染
   ------------------------------------------------------------
   为什么单独成一套件：这块是**纯函数**（解析 + 布局 + 出 SVG 字符串），
   所以能像 `test-exportcards` 那样在 Node 里直接 import 跑 ——
   不起服务、不开浏览器，秒级完成，改一行立刻能验。

   它守的是 2026-10-06 记下的那个 1:1 差距：语雀官方《如何插入文本绘图》
   列了 PlantUML / Mermaid / Flowchart / Graphviz / Gantt 五种，我们只有一种。
   本轮补 Flowchart —— 五种里最常用、也最便宜的一种（不必引 mermaid 那个库）。
   ============================================================ */
import { parseFlowchart, renderFlowchartSvg, isFlowchartSource } from './src/lib/flowchart.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

const SAMPLE = `graph TD
    A[开始] --> B{是否通过}
    B -->|是| C[写入订单]
    B -->|否| D[(退回队列)]
    C --> E([完成])
    D -.-> A`

console.log('== 识别：哪些源码算 Flowchart ==')
ok(isFlowchartSource('graph TD\nA-->B'), 'graph 开头认得出')
ok(isFlowchartSource('flowchart LR\nA-->B'), 'flowchart 开头也认得出')
ok(!isFlowchartSource('@startuml\nA -> B\n@enduml'), 'PlantUML 不被误认成 Flowchart')
ok(!isFlowchartSource('普通一段文字'), '普通文字不认')
ok(isFlowchartSource('%% 注释\ngraph TD\nA-->B'), '注释行在前也认得出（第一行有效行）')

console.log('\n== 解析：节点、形状、边、标签 ==')
{
  const fc = parseFlowchart(SAMPLE)
  ok(fc.direction === 'TD', `方向识别为 TD（${fc.direction}）`)
  ok(fc.nodes.length === 5, `解析出 5 个节点（${fc.nodes.length}）`, JSON.stringify(fc.nodes.map((n) => n.id)))
  const by = Object.fromEntries(fc.nodes.map((n) => [n.id, n]))
  ok(by.A?.shape === 'rect' && by.A?.label === '开始', 'A 是矩形、标题「开始」', JSON.stringify(by.A))
  ok(by.B?.shape === 'diamond' && by.B?.label === '是否通过', 'B 是菱形（{}）')
  ok(by.D?.shape === 'cylinder', 'D 是圆柱（[] 数据库）', by.D?.shape)
  ok(by.E?.shape === 'stadium', 'E 是跑道（([])）', by.E?.shape)
  ok(fc.edges.length === 5, `解析出 5 条边（${fc.edges.length}）`)
  const labelled = fc.edges.filter((e) => e.label)
  ok(labelled.length === 2, `两条带标签的连线被认出来（${labelled.length}）`, JSON.stringify(fc.edges))
  ok(labelled.some((e) => e.label === '是') && labelled.some((e) => e.label === '否'), '标签内容是「是」/「否」')
  ok(fc.edges.some((e) => e.arrow === 'dotted'), '虚线 -.-> 被认成 dotted')
  ok(fc.edges.filter((e) => e.arrow === 'solid').length === 4, '实线 --> 被认成 solid')
}

console.log('\n== 分层：菱形在中间，起点在第 0 层 ==')
{
  const fc = parseFlowchart(SAMPLE)
  const L = Object.fromEntries(fc.nodes.map((n) => [n.id, n.layer]))
  ok(L.A === 0, `起点 A 在第 0 层（${L.A}）`)
  ok(L.B === 1, `判断 B 在第 1 层（${L.B}）`)
  ok(L.D === 2, `退回 D 在第 2 层（${L.D}）`)
}

console.log('\n== 成环不会死循环（真实流程图里很常见）==')
{
  const fc = parseFlowchart('graph LR\nA --> B\nB --> A\nB --> C')
  ok(fc.nodes.length === 3, `成环时节点照样解析出来（${fc.nodes.length}）`)
  ok(fc.nodes.every((n) => Number.isFinite(n.layer) && n.layer >= 0), '每个节点都有合法层号（没有 NaN / 负数）')
  ok(parseFlowchart('graph TD\nA-->A').nodes.length === 1, '自环也不炸')
}

console.log('\n== 不认的语法要**说人话**，不能装作全支持 ==')
{
  const fc = parseFlowchart(`graph TD
    A[开始]
    subgraph one
      B[子图里的]
    end
    A --> B`)
  ok(fc.nodes.length >= 2, '子图里的节点仍被认出来（不丢弃内容）', `nodes=${fc.nodes.length}`)
  /* ⚠️ 这条断言在 2026-10-07 **作废并反转**。
     原来断言的是「subgraph/end 会被记进 skipped」——
     而那其实是**假告警**：它们是被认识的语法，只是当时外框没画。
     假告警比没有告警更糟：用户会去查一个不存在的问题。
     现在外框真画出来了（见「subgraph：分组外框」一节），
     所以这两行不但不该进 skipped，分组本身还必须被收集起来。 */
  ok(fc.skipped.length === 0, 'subgraph/end 不再被报成「不认识的写法」', JSON.stringify(fc.skipped))
  ok(fc.groups.length >= 1, '分组被收集起来了', JSON.stringify(fc.groups.map((g) => g.label)))
}

console.log('\n== 四种方向 ==')
for (const [src, want] of [['graph TD', 'TD'], ['flowchart LR', 'LR'], ['graph BT', 'BT'], ['flowchart RL', 'RL']]) {
  ok(parseFlowchart(src + '\nA-->B').direction === want, `「${src}」方向 = ${want}`)
}
{
  const fc = parseFlowchart('graph LR\nA-->B-->C')
  const xs = fc.nodes.map((n) => n.layer)
  ok(new Set(xs).size === 3, '左右排时三个节点分属三层（不会挤在同一列）', JSON.stringify(xs))
}

console.log('\n== 渲染成 SVG ==')
{
  const svg = renderFlowchartSvg(parseFlowchart(SAMPLE))
  ok(svg.startsWith('<svg'), '输出以 <svg 开头')
  ok(svg.trimEnd().endsWith('</svg>'), '输出以 </svg> 结尾')
  ok(/<polygon[^>]*yq-fc-diamond/.test(svg), '菱形节点画出来了')
  ok(/<marker id="yq-fc-arrow"/.test(svg), '箭头 marker 有了')
  ok((svg.match(/yq-fc-edge"/g) || []).length === 5, '五条连线都画出来了')
  ok((svg.match(/class="yq-fc-node/g) || []).length === 5, '五个节点形状都画出来了')
  ok(/stroke-dasharray="5 4"/.test(svg), '虚线边用了 dasharray')
  ok(svg.includes('是否通过'), '节点文字进了 SVG')
  ok(svg.includes('>是<'), '连线标签进了 SVG')
  ok(!/<script/i.test(svg), 'SVG 里没有 script')
  ok(renderFlowchartSvg(parseFlowchart('')) === '', '空源码渲染出空串（不是一段坏 SVG）')
  ok(renderFlowchartSvg(parseFlowchart('graph TD\nA[只有一个节点]')).includes('只有一个节点'), '单节点也能画')
}

console.log('\n== 文本必须转义 ==')
{
  const fc = parseFlowchart('graph TD\nA["<script>x</script> & \\"引号\\""]')
  const svg = renderFlowchartSvg(fc)
  ok(!/<script/i.test(svg), '<script> 被转义掉了，没进 SVG')
  ok(svg.includes('&lt;script&gt;'), '转义后的实体在 SVG 里')
}

console.log('\n== subgraph：分组外框（点与边本来就对，缺的是那个框）==')
{
  const src = `graph TD
    subgraph 前端
        A[打开页面] --> B[点提交]
    end
    subgraph 后端
        C[校验参数] --> D[写库]
    end
    B --> C
    D --> E([完成])`
  const fc = parseFlowchart(src)
  ok(fc.groups.length === 2, `两个分组（${fc.groups.length}）`, JSON.stringify(fc.groups))
  ok(fc.groups[0].label === '前端', '分组名当显示名', fc.groups[0]?.label)
  ok(fc.groups[0].members.join(',') === 'A,B', '成员收集正确', fc.groups[0]?.members.join(','))
  ok(fc.groups[1].members.join(',') === 'C,D', '第二个分组的成员', fc.groups[1]?.members.join(','))
  ok(fc.nodes.length === 5, '五个节点都在', String(fc.nodes.length))
  ok(fc.edges.length === 4, '四条边都在（分组不能吞边）', String(fc.edges.length))
  // ⚠️ 这两条是**假告警**：`subgraph`/`end` 是被认识的，只是外框曾经不画
  ok(fc.skipped.length === 0, 'subgraph/end 不该被报成「不认识的写法」', JSON.stringify(fc.skipped))
  // ⚠️ 分组**不参与分层** —— 参与的话整张图会错位
  const L = Object.fromEntries(fc.nodes.map((n) => [n.id, n.layer]))
  ok(L.A === 0 && L.B === 1 && L.C === 2 && L.D === 3 && L.E === 4, '分层不受分组影响', JSON.stringify(L))
  const svg = renderFlowchartSvg(fc)
  ok((svg.match(/class="yq-fc-group"/g) || []).length === 2, '两个框都画出来了')
  ok((svg.match(/yq-fc-group-label/g) || []).length === 2, '两个框的标签都画出来了')
  ok(svg.includes('前端') && svg.includes('后端'), '分组名进了 SVG')
  ok(svg.indexOf('yq-fc-group') < svg.indexOf('yq-fc-node'), '框在节点**之前**（垫在底下，不能盖住节点）')
  const plain = renderFlowchartSvg(parseFlowchart('graph TD\nA-->B'))
  ok(!/class="yq-fc-group"/.test(plain), '没有分组时不画框（回归）')
}

console.log('\n== 嵌套分组：外框必须真的包住内框 ==')
{
  const src = `graph LR
    subgraph 全流程
      subgraph 准备
        A[接需求] --> B[评估]
      end
      subgraph 实施
        C[开发] --> D[联调]
      end
      B --> C
    end
    D --> E([上线])`
  const fc = parseFlowchart(src)
  ok(fc.groups.length === 3, '三个分组', String(fc.groups.length))
  ok(fc.groups[0].depth === 0 && fc.groups[1].depth === 1 && fc.groups[2].depth === 1, '层号对',
    JSON.stringify(fc.groups.map((g) => [g.label, g.depth])))
  ok(fc.groups[0].members.length === 4, '父组的成员**包含子组的**（否则外框会画小）',
    fc.groups[0].members.join(','))
  const svg = renderFlowchartSvg(fc)
  ok((svg.match(/class="yq-fc-group"/g) || []).length === 3, '三个框都画了')
  // ⚠️ 第一版把边距写成「越外层越少」，外框顶边落到内框**下面**，
  //    画出来是两个平行的框 —— 这条只有看像素才发现，单测当时全绿
  const rects = [...svg.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="8" class="yq-fc-group"/g)]
    .map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }))
  const maxW = Math.max(...rects.map((q) => q.w))
  const outer = rects.find((r) => r.w === maxW)
  const inner = rects.filter((r) => r !== outer)
  ok(inner.length === 2, '两个内框')
  ok(inner.every((r) => r.x > outer.x && r.y > outer.y && r.x + r.w < outer.x + outer.w && r.y + r.h < outer.y + outer.h),
    '两个内框都被外框**完整包住**', JSON.stringify({ outer, inner }))
}

console.log('\n== 组内 direction：做不到也要说人话 ==')
{
  const fc = parseFlowchart('graph LR\n subgraph G\n  direction TB\n  A --> B\n end')
  ok(fc.nodes.length === 2, '组内 direction 不影响节点解析', String(fc.nodes.length))
  ok(fc.skipped.length === 1 && /direction/.test(fc.skipped[0]), '给一句能照着改的话', JSON.stringify(fc.skipped))
  ok(!fc.skipped.some((s) => /^direction/.test(s) && /不认/.test(s)), '不是「不认识的写法」那种假告警')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1