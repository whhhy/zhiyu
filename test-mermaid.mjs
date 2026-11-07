/* ============================================================
   Mermaid 文本绘图：图种识别 + sequenceDiagram 解析与 SVG 渲染
   ------------------------------------------------------------
   为什么单独成一套件：和 `test-flowchart` 一样是**纯函数**
   （识别 / 解析 / 出 SVG 字符串），Node 里直接 import 跑，秒级完成。

   它守的是 2026-10-06 记下的 1:1 差距的第二段：
   语雀官方《如何插入文本绘图》五种里 Mermaid 覆盖面最广，
   我们当时只做了 PlantUML（只能出结构预览）+ Flowchart。
   Flowchart 本身就是 mermaid 的 `graph`/`flowchart` 子集 ——
   真正缺的是**别的图种**，其中企业文档最常见的是 sequenceDiagram。

   本套件里三条断言是照着**实际踩到的坑**写的，不是照着设计意图：
     · `--x` 必须认成虚线且**不能**造出一个叫「x用户」的参与者
     · `participant 网关 as GW` 之后用 GW 引用的消息要能指回「网关」
     · 头部 `sequenceDiagram` 本身不算「不认识的写法」（假告警比没告警更糟）
   ============================================================ */
import { parseSequence, renderSequenceSvg, detectMermaid, mermaidLocalNotice, renderMermaidSvg, LOCALLY_RENDERED, KIND_LABEL } from './src/lib/mermaid.ts'
import { pickDiagramMode } from './src/lib/diagram.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

const SAMPLE = `sequenceDiagram
    autonumber
    participant 网关 as GW
    actor 用户
    participant 订单库
    用户->>GW: 提交订单
    activate 网关
    GW->>+订单库: 写入订单
    订单库-->>-GW: 返回订单号
    Note over 用户,网关: 这里做一次鉴权
    loop 每 5 分钟
        GW->>订单库: 对账
    end
    alt 库存充足
        GW-->>用户: 下单成功
    else 库存不足
        GW--x用户: 缺货
    end
    deactivate 网关`

console.log('== 图种识别：认出来是哪种，别把没实现的当成实现了 ==')
{
  const cases = [
    ['sequenceDiagram', 'sequence'],
    ['classDiagram\nA <|-- B', 'class'],
    ['stateDiagram\n[*] --> A', 'state'],
    ['stateDiagram-v2\n[*] --> A', 'state'],
    ['erDiagram\nA ||--o{ B : has', 'er'],
    ['pie title 占比\n"甲" : 10', 'pie'],
    ['gantt\ndateFormat YYYY', 'gantt'],
    ['mindmap\nroot((A))', 'mindmap'],
    ['journey\ntitle T', 'journey'],
    ['timeline\ntitle T', 'timeline'],
    ['graph TD\nA-->B', 'flowchart'],
    ['flowchart LR\nA-->B', 'flowchart'],
    ['@startuml\nA -> B\n@enduml', 'unknown'],
    ['@startmind\n* A\n@endmind', 'unknown'],
    ['普通一段中文', 'unknown'],
    ['', 'unknown'],
  ]
  for (const [src, want] of cases) {
    ok(detectMermaid(src) === want, `${JSON.stringify(src.split('\n')[0]).slice(0, 26).padEnd(28)} → ${want}`, `实得 ${detectMermaid(src)}`)
  }
  ok(detectMermaid('%% 注释在前\n%% 第二行\nsequenceDiagram\nA->>B: x') === 'sequence',
    '注释行在前也能认出 sequence（看的是第一条有效行）')
}

console.log('\n== 没实现的图种要明说差哪一种，不能笼统说「不支持」 ==')
{
  /* ⚠️ 2026-10-07：这张清单**去掉**了 journey 与 timeline ——
     两者已经各自有本地渲染器（journey.ts / timeline.ts），再断言「它们有
     没做的提示」就是拿旧事实钉住新代码。改法不是把期望值反过来，
     而是把它挪到**已实现**那一侧、并补一条反向断言：
     已实现的图种**不许**再被说成「没做」（界面上明明出图了还告诉用户没做，
     比不说更糟）。 */
  for (const k of ['class', 'state', 'er', 'pie', 'gantt', 'mindmap']) {
    const n = mermaidLocalNotice(k)
    ok(n.length > 0, `${k} 有专门的说明文案`)
    ok(!n.includes('undefined'), `${k} 的文案里没有 undefined`)
  }
  for (const k of ['journey', 'timeline']) {
    ok(mermaidLocalNotice(k) === '', `${k} 已实现，不再说「没做」`)
    ok(LOCALLY_RENDERED.includes(k), `${k} 在本地可渲染清单里`)
  }
  ok(mermaidLocalNotice('sequence') === '', 'sequence 不需要「没做」的提示')
  ok(mermaidLocalNotice('flowchart') === '', 'flowchart 不需要「没做」的提示')
  ok(mermaidLocalNotice('unknown') === '', '不是 mermaid 就不给提示')
  ok(!LOCALLY_RENDERED.includes('class'), '类图**不在**本文件的本地可渲染清单里（它走自己的渲染器）')

  /* ⚠️ 这里**不再硬编码整份清单**。原来写死 `'flowchart,sequence'`，
     于是每加一个图种都要记得改这一行，漏改就会红 —— 而「清单该长什么样」
     本来就不该由一个断言说了算。改成钉住**性质**：我要的那几种在、
     没有重复项、且与 `kind` 类型一致。 */
  for (const want of ['flowchart', 'sequence', 'journey', 'timeline']) {
    ok(LOCALLY_RENDERED.includes(want), `本地清单里有 ${want}`)
  }
  ok(new Set(LOCALLY_RENDERED).size === LOCALLY_RENDERED.length, '本地清单没有重复项', LOCALLY_RENDERED)
  ok(LOCALLY_RENDERED.every((k) => k !== 'unknown'), '本地清单里不该出现 unknown')

  /* 提示文案里列出的「已支持」必须**由清单生成**，
     否则每加一个图种都得改那句写死的「只做了流程图与时序图」——
     而漏改的后果是界面明明出图了、却告诉用户没做。 */
  const anyNotice = mermaidLocalNotice('mindmap')
  ok(anyNotice.includes('用户旅程图') && anyNotice.includes('时间线'),
    '「已支持」那句是从清单生成的，不是写死的', anyNotice)

  ok(renderMermaidSvg('classDiagram\nA <|-- B') === '', '类图渲染出空串（不是一张画错的图）')
}

console.log('\n== 认得全 mermaid 的图种：认不出来的**更不能说假话** ==')
{
  /* ⚠️ 2026-10-07 修的一处「界面说假话」：
     早期 KIND_RE 只收了 10 种，于是 `sankey-beta` / `gitGraph` / `xychart-beta`
     这类一律落到 `unknown` → `pickDiagramMode` 兜底返回 `'uml'` →
     界面标着「PlantUML（结构预览）」，**拿 PlantUML 解析器去啃 Mermaid 源码**。
     画出来是标签残渣，而标题写得很确定 —— 用户只会以为自己粘错了格式。
     收进图种表后它们路由到 `unsupported`，界面明说「这是 Mermaid 的桑基图，
     本地渲染器还没做」，**不画那张图**。 */
  const NOT_DONE = {
    xychart: ['xychart-beta\n  bar [1,2,3]'],
    gitgraph: ['gitGraph\n commit'],
    requirement: ['requirementDiagram\n  requirement r {}'],
    quadrant: ['quadrantChart\n  title Q'],
    architecture: ['architecture-beta\n  group g'],
    block: ['block-beta\n  A'],
    packet: ['packet-beta\n  A'],
    treemap: ['treemap\n  A'],
    kanban: ['kanban\n  A'],
    zenuml: ['zenuml\n  A'],
  }
  for (const [kind, srcs] of Object.entries(NOT_DONE)) {
    for (const src of srcs) {
      ok(detectMermaid(src) === kind, `${kind} 认得出（${src.split('\n')[0]}）`, detectMermaid(src))
      const n = mermaidLocalNotice(kind)
      ok(n.length > 0 && !n.includes('undefined') && n.includes(KIND_LABEL[kind]),
        `${kind} 的提示点名了它是哪一种图`, n.slice(0, 40))
    }
  }
  /* sankey 2026-10-07 补上了：它**不再**属于「认得出但没做」那组，
     所以既不该有「没做」提示，也不该落 unsupported。 */
  ok(mermaidLocalNotice('sankey') === '', 'sankey 已实现，不再给「没做」提示', mermaidLocalNotice('sankey'))
  ok(pickDiagramMode('sankey-beta\nA,B,10') === 'sankey', 'sankey 路由到自己的分支',
    pickDiagramMode('sankey-beta\nA,B,10'))
  ok(pickDiagramMode('sankey\nA,B,10') === 'sankey', '不带 -beta 的写法也认',
    pickDiagramMode('sankey\nA,B,10'))
  /* 关键：**不许再落到 uml**。落了就是「用 PlantUML 解析器啃 Mermaid 源码」。 */
  const modes = new Set(Object.values(NOT_DONE).flat().map((s) => pickDiagramMode(s)))
  ok(!modes.has('uml'), '这些图种一律不进 uml 兜底', [...modes].join(','))
  ok([...modes].every((m) => m === 'unsupported'), '这些图种全部路由到 unsupported（界面明说没做）', [...modes].join(','))

  /* 反向：已支持的那些不许被误伤。⚠️ 这里断的是 **mode** 而不是 notice ——
     `LOCALLY_RENDERED` 的含义是「mermaid.ts 本模块能出图」，class/state/er/pie
     走各自模块，它们的 notice 非空只是死代码，不影响用户。 */
  const KEEP = {
    flow: 'graph TD\n A-->B',
    seq: 'sequenceDiagram\n A->>B: x',
    journey: 'journey\n section A\n  x: 1',
    timeline: 'timeline\n 2024 : A',
    class: 'classDiagram\n class A',
    state: 'stateDiagram-v2\n [*] --> A',
    er: 'erDiagram\n A ||--o{ B : x',
    pie: 'pie\n "a" : 1',
    mind: 'mindmap\n root((x))',
    sankey: 'sankey-beta\nA,B,10',
  }
  for (const [want, src] of Object.entries(KEEP)) {
    ok(pickDiagramMode(src) === want, `已支持的 ${want} 不被新图种挤掉`, pickDiagramMode(src))
  }
  /* ⚠️ 2026-10-07 改过：原来这里断言 `pickDiagramMode('gantt…') === 'unsupported'`，
     理由是「exclude 算不了，硬画会画出时间不对的排期图」。
     那条**本身就是个 bug**：`diagram.ts` 里 `mk === 'unknown' && isGanttSource(text)`
     恒假（`detectMermaid('gantt…')` 返回 `'gantt'`），于是普通 gantt 全被吞成
     `unsupported`，只有冷僻的 `@startgantt` 方言能进本地渲染器 ——
     **甘特图 43 项测试全绿，用户却永远看不到**。
     现在 `parseGantt` 已把 exclude / until / 认不出的日期逐条放进 skipped 并说明，
     「画错」这个顾虑不再成立，所以甘特改走本地渲染器。
     隔离意图（mermaid 的闸不误伤别的族）保留，只是期望值改了。 */
  ok(pickDiagramMode('gantt\n section s') === 'gantt', 'mermaid 的 gantt 走本地渲染器（不再被吞成「未实现」）')

  /* KIND_LABEL 覆盖每一个 kind —— 少一个提示里就会出现 undefined */
  const KINDS = ['flowchart', 'sequence', 'class', 'state', 'er', 'pie', 'gantt', 'mindmap',
    'journey', 'timeline', 'sankey', 'xychart', 'gitgraph', 'requirement', 'quadrant',
    'architecture', 'block', 'packet', 'treemap', 'kanban', 'zenuml']
  ok(KINDS.every((k) => KIND_LABEL[k]), `KIND_LABEL 覆盖全部 ${KINDS.length} 种`,
    KINDS.filter((k) => !KIND_LABEL[k]).join(','))

  /* 非 mermaid 一律不该被认走 */
  for (const src of ['@startuml\nA->B', 'digraph G { a->b }', 'hello world', '']) {
    ok(pickDiagramMode(src) !== 'unsupported', `非 mermaid 不被误标（${src.split('\n')[0]}）`, pickDiagramMode(src))
  }
}

console.log('\n== 参与者：声明顺序、别名 ==')
{
  const s = parseSequence(SAMPLE)
  ok(s.participants.length === 3, `三个参与者（${s.participants.length}）`, JSON.stringify(s.participants))
  ok(s.participants.join(',') === '网关,用户,订单库', '按声明顺序排', JSON.stringify(s.participants))
  ok(s.labels.get('网关') === 'GW', '别名 GW 记住了')
  ok(s.labels.get('用户') === '用户', '没写 as 的显示名就是自己')
  const withAliasRef = parseSequence('sequenceDiagram\nparticipant 网关 as GW\nGW->>用户: x')
  ok(withAliasRef.participants.length === 2,
    '用别名 GW 引用不会多造一个参与者', JSON.stringify(withAliasRef.participants))
  ok(withAliasRef.events[0].type === 'message' &&
    withAliasRef.events[0].from === '网关',
    '用别名引用时 from 落到真 id 上')
}

console.log('\n== 消息：箭头、标签、实虚 ==')
{
  const s = parseSequence(SAMPLE)
  const msgs = s.events.filter((e) => e.type === 'message')
  ok(s.events.length === 7, `7 个事件（${s.events.length}）`, JSON.stringify(s.events.map((e) => e.type)))
  ok(msgs.length === 6, `6 条消息（${msgs.length}）`)
  ok(msgs[0].label === '提交订单', '消息标签对', JSON.stringify(msgs[0]))
  const dotted = msgs.filter((m) => m.type === 'message' && m.dotted)
  ok(dotted.length === 1, `一条虚线（${dotted.length}）`)
  ok(!s.participants.some((p) => p.includes('x') || p.includes('x用户')),
    '`--x用户` 没有被误认成参与者「x用户」', JSON.stringify(s.participants))
}

console.log('\n== 各种箭头写法都要接住（第一版只认 -->，-->> 全漏）==')
{
  const arrows = [
    ['A->>B: 1', false],
    ['A-->B: 2', false],
    ['A->B: 3', false],
    ['A-->>B: 4', false],
    ['A-)B: 5', false],
    ['A--)B: 6', false],
    ['A-xB: 7', true],
    ['A--xB: 8', true],
    ['A-\\B: 9', true],
  ]
  for (const [line, wantDotted] of arrows) {
    const s = parseSequence(`sequenceDiagram\n${line}`)
    const ev = s.events[0]
    const got = ev && ev.type === 'message' ? ev.dotted : null
    ok(got === wantDotted, `${line.padEnd(12)} dotted=${wantDotted}`, `实得 ${JSON.stringify(ev)}`)
    ok(s.participants.length === 2, `${line.padEnd(12)} 参与者正好两个`, JSON.stringify(s.participants))
  }
}

console.log('\n== 备注 ==')
{
  const s = parseSequence(SAMPLE)
  const notes = s.events.filter((e) => e.type === 'note')
  ok(notes.length === 1, `一条备注（${notes.length}）`)
  const n = notes[0]
  ok(n.over.join(',') === '用户,网关', 'note over A,B 认到两个参与者', JSON.stringify(n.over))
  ok(n.text === '这里做一次鉴权', '备注文字对', n.text)
  const right = parseSequence('sequenceDiagram\nNote right of A: 就这里')
  ok(right.events.length === 1 && right.events[0].type === 'note', '单侧 note 也认')
  ok(right.events[0].over.length === 1, '单侧 note 只覆盖一个参与者')
}

console.log('\n== loop / alt / else：框的区间与层号 ==')
{
  const s = parseSequence(SAMPLE)
  ok(s.blocks.length === 3, `三个框片段（${s.blocks.length}）`, JSON.stringify(s.blocks))
  ok(s.blocks[0].label === 'loop 每 5 分钟', 'loop 标签对', s.blocks[0].label)
  ok(s.blocks[1].label === 'alt 库存充足', 'alt 标签对', s.blocks[1].label)
  ok(s.blocks[2].label === 'else 库存不足', 'else 标签对', s.blocks[2].label)
  ok(s.blocks.every((b) => b.start <= b.end), '每个框的区间都不倒挂')
  ok(s.blocks[2].depth === s.blocks[1].depth, 'else 与它所属的 alt 是同一层', JSON.stringify(s.blocks))
  const nested = parseSequence('sequenceDiagram\nloop 外\nA->>B: 1\nalt 内\nA->>B: 2\nend\nend')
  ok(nested.blocks.length === 2, '嵌套框认得出两段', JSON.stringify(nested.blocks))
  ok(nested.blocks[1].depth === 1, '内层 depth 是 1', JSON.stringify(nested.blocks))
  ok(nested.blocks[0].depth === 0, '外层 depth 是 0')
}

console.log('\n== 源码写了一半也不该丢内容 ==')
{
  const s = parseSequence('sequenceDiagram\nA->>B: 消息\nloop 忘了 end\nA->>B: 里面')
  ok(s.events.length === 2, '缺 end 时两条消息都还在', String(s.events.length))
  ok(s.blocks.length === 1, '没关的框照样收尾', JSON.stringify(s.blocks))
  ok(s.blocks[0].end >= s.blocks[0].start, '收尾的区间不倒挂')
  const empty = parseSequence('sequenceDiagram')
  ok(empty.events.length === 0 && empty.participants.length === 0, '只有头部时不凭空造东西')
  ok(renderSequenceSvg(empty) === '', '只有头部时渲染出空串')
  ok(parseSequence('').participants.length === 0, '空源码不炸')
}

console.log('\n== 激活条 ==')
{
  const s = parseSequence('sequenceDiagram\nA->>+B: 调用\nB-->>-A: 返回\ndeactivate B')
  const acts = s.activations.get('B') || []
  ok(acts.length === 1, `B 有一段激活（${acts.length}）`, JSON.stringify([...s.activations]))
  ok(acts[0] && acts[0].end >= acts[0].start, '激活区间不倒挂')
  const never = parseSequence('sequenceDiagram\nA->>+B: 调用')
  const open = never.activations.get('B') || []
  ok(open.length === 1 && open[0].end !== -1, '没 deactivate 的激活条会被收尾', JSON.stringify(open))
  ok((never.activations.get('B') || []).every((a) => a.end >= 0), '不留下 end=-1 的悬空段')
}

console.log('\n== 认不出来的写法要记下来（而不是假装全支持）==')
{
  const s = parseSequence('sequenceDiagram\nA->>B: ok\n这是看不懂的一行')
  ok(s.skipped.length === 1 && s.skipped[0] === '这是看不懂的一行', '不认识的行进 skipped', JSON.stringify(s.skipped))
  ok(s.events.length === 1, '不影响其它行被解析')
  const clean = parseSequence(SAMPLE)
  ok(clean.skipped.length === 0, '完整样例不该有 skipped（含头部行）', JSON.stringify(clean.skipped))
  ok(clean.autonumber === true, 'autonumber 认出来了')
}

console.log('\n== 渲染 ==')
{
  const s = parseSequence(SAMPLE)
  const svg = renderSequenceSvg(s)
  ok(svg.startsWith('<svg'), '输出以 <svg 开头')
  ok(svg.trimEnd().endsWith('</svg>'), '输出以 </svg> 结尾')
  ok((svg.match(/class="yq-seq-head"/g) || []).length === 3, '三个参与者头都画了')
  ok((svg.match(/class="yq-seq-life"/g) || []).length === 3, '三条生命线都画了')
  ok((svg.match(/class="yq-seq-msg-label"/g) || []).length === 6, '六条消息标签都画了')
  ok((svg.match(/class="yq-seq-note"/g) || []).length === 1, '备注框画了')
  ok((svg.match(/class="yq-seq-bracket"/g) || []).length === 3, '三个框括号都画了')
  ok((svg.match(/class="yq-seq-act"/g) || []).length >= 1, '激活条画了')
  ok(/marker id="yq-seq-arrow"/.test(svg), '实线箭头 marker 有了')
  ok(/marker id="yq-seq-x"/.test(svg), '虚线 ×  marker 有了')
  ok(svg.includes('url(#yq-seq-x)'), '虚线消息用了 ×  marker')
  ok(svg.includes('>GW<'), '别名 GW 进了 SVG')
  ok(/yq-seq-no">1\./.test(svg), 'autonumber 编号进了 SVG')
  ok(renderSequenceSvg(parseSequence('')) === '', '空源码渲染出空串')
  const self = renderSequenceSvg(parseSequence('sequenceDiagram\nA->>A: 重试'))
  ok(self.length > 0, '自消息也能画（不是退化成零长度线）', String(self.length))
  ok((self.match(/class="yq-seq-msg-label"/g) || []).length === 1, '自消息的标签也在')
}

console.log('\n== 框要在参与者左边，不能压在头上 ==')
{
  // 第一版算出了 bracketRoom 却没往参与者的 x 上加，画面左边被吃掉一截
  const withBox = renderSequenceSvg(parseSequence('sequenceDiagram\nloop 每 5 分钟\nA->>B: 1\nend'))
  const withoutBox = renderSequenceSvg(parseSequence('sequenceDiagram\nA->>B: 1'))
  const firstHeadX = (svg) => Number(/<rect x="([\d.]+)" y="[\d.]+" width="[\d.]+" height="32" rx="4" class="yq-seq-head"/.exec(svg)?.[1])
  const wFirstHeadX = firstHeadX(withBox)
  const woFirstHeadX = firstHeadX(withoutBox)
  ok(wFirstHeadX > woFirstHeadX, '有框时参与者整体右移（给框让出位置）', `${wFirstHeadX} vs ${woFirstHeadX}`)
  ok(/class="yq-seq-bracket"/.test(withBox), '框确实画了')
  ok(!/class="yq-seq-bracket"/.test(withoutBox), '没框就不画括号')
}

console.log('\n== 文本必须转义 ==')
{
  const svg = renderSequenceSvg(parseSequence('sequenceDiagram\nA->>B: <script>x</script> & "引号"'))
  ok(!/<script/i.test(svg), '<script> 被转义掉了，没进 SVG')
  ok(svg.includes('&lt;script&gt;'), '转义后的实体在 SVG 里')
}

console.log('\n== 统一入口 renderMermaidSvg ==')
{
  ok(renderMermaidSvg('graph TD\nA-->B').includes('yq-fc-svg'), 'flowchart 走的是原来那套渲染')
  ok(renderMermaidSvg('sequenceDiagram\nA->>B: x').includes('yq-seq-svg'), 'sequence 走时序图渲染')
  ok(renderMermaidSvg('gantt\ndateFormat X') === '', 'gantt 出空串而不是画错')
  ok(renderMermaidSvg('@startuml\nA -> B\n@enduml') === '', 'PlantUML 不归 mermaid 入口管')
  ok(renderMermaidSvg('随便') === '', '非 mermaid 出空串')
}

/* 路由判定（`empty/uml/flow/seq/dot/unsupported`）已经搬到 `src/lib/diagram.ts`，
   断言也跟着搬到 **test-dot.mjs** —— 它现在要同时判 PlantUML / DOT / Mermaid 三族，
   放在只管 mermaid 的套件里会名不副实。 */

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1