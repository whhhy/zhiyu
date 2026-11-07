/* ============================================================
   Gantt 甘特图解析与 SVG 渲染
   ------------------------------------------------------------
   为什么单独成一套件：纯函数，Node 里直接 import 跑，秒级完成。
   它守的是语雀官方《如何插入文本绘图》五种里**最后一个完全没碰的** ——
   Gantt。而且它是这几种里最便宜的一种：排期图本质是「时间轴 + 横条」，
   不需要图算法，所以零依赖就能本地出 SVG。

   套件里四条断言是照**实际踩到的坑**写的，不是照设计意图：
     · `after` 消耗后漏了 k++ → 后面读到的还是 "after x"，
       时长解析失败，**整条任务凭空消失**
     · 结束日期被当时长 → `2026-01-05, 2026-01-09` 的条短了 3 倍，
       而**图看着还挺像那么回事**
     · `0d` 被当非法时长 → 里程碑整条丢掉，而「少一个里程碑」的图
       看上去仍然完全正常
     · `after` 任务的时长从 `NaN - NaN` 里反推 → 条长度变 0，
       画成一条看不见的线
   ============================================================ */
import { parseGantt, renderGanttSvg, isGanttSource, TICK_W, TICK_TEXT_DX } from './src/lib/gantt.ts'
import { pickDiagramMode, LOCALLY_RENDERED_MODES } from './src/lib/diagram.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

const MS_DAY = 86400000
const day = (s) => Date.parse(`${s}T00:00:00Z`)
const iso = (ms) => new Date(ms).toISOString().slice(0, 10)

const SAMPLE = `gantt
    dateFormat YYYY-MM-DD
    title 内网知识库一期排期
    section 准备
    需求确认      :done,    r1, 2026-01-05, 2026-01-09
    环境准备      :done,    r2, 2026-01-06, 4d
    section 开发
    认证与权限    :crit,    d1, 2026-01-12, 8d
    知识库 CRUD   :active,  d2, after d1, 10d
    全文检索      :         d3, 2026-01-14, 6d
    section 上线
    灰度发布      :crit,    m1, 2026-02-02, 0d
    全量切换      :         m2, after m1, 2d`

console.log('== 识别 ==')
{
  ok(isGanttSource('gantt\ntitle X'), 'gantt 认得出')
  ok(isGanttSource('@startgantt\nx\n@endgantt'), '@startgantt 方言认得出')
  ok(!isGanttSource('graph TD\nA-->B'), 'mermaid 流程图不被误认')
  ok(!isGanttSource('digraph G { a->b }'), 'DOT 不被误认')
  ok(!isGanttSource('sequenceDiagram\nA->>B: x'), '时序图不被误认')
  ok(!isGanttSource(''), '空串不认')
}

console.log('\n== 头部 ==')
{
  const g = parseGantt(SAMPLE)
  ok(g.title === '内网知识库一期排期', `title 认出来（${g.title}）`)
  ok(g.dateFormat === 'YYYY-MM-DD', `dateFormat 认出来（${g.dateFormat}）`)
  ok(g.tasks.length === 7, `七条任务（${g.tasks.length}）`, JSON.stringify(g.tasks.map((t) => t.name)))
  ok(g.skipped.length === 0, '完整样例没有 skipped', JSON.stringify(g.skipped))
}

console.log('\n== 时长与结束日期 ==')
{
  const g = parseGantt(SAMPLE)
  const by = Object.fromEntries(g.tasks.map((t) => [t.id, t]))
  ok(iso(by.r1.start) === '2026-01-05', 'r1 起始对', iso(by.r1.start))
  ok(iso(by.r1.end) === '2026-01-09',
    'r1 写的是**结束日期**而不是时长（第一版当时长，条短了 3 倍）', iso(by.r1.end))
  ok(by.r2.dur === 4 * MS_DAY, 'r2 的 4d 时长对', String(by.r2.dur))
  ok(by.d1.dur === 8 * MS_DAY, 'd1 的 8d 时长对', String(by.d1.dur))
  ok(by.d3.dur === 6 * MS_DAY, 'd3 的 6d 时长对', String(by.d3.dur))
  ok(by.d1.end - by.d1.start === by.d1.dur, 'end - start 等于声明的时长')
  // 单位：m 是「分」不是月 —— 写错会让一条 5m 的任务横跨 5 个月
  const units = parseGantt('gantt\nsection S\na : a1, 2026-01-05, 2w\nb : b1, 2026-01-05, 12h\nc : c1, 2026-01-05, 30m\nd : d1, 2026-01-05, 500ms')
  const U = Object.fromEntries(units.tasks.map((t) => [t.id, t.dur]))
  ok(U.a1 === 14 * MS_DAY, '2w = 14 天', String(U.a1))
  ok(U.b1 === 12 * 3600000, '12h = 12 小时', String(U.b1))
  ok(U.c1 === 30 * 60000, '30m = 30 **分钟**（不是月）', String(U.c1))
  ok(U.d1 === 500, '500ms = 500 毫秒', String(U.d1))
}

console.log('\n== 里程碑：0d 是合法写法 ==')
{
  const g = parseGantt(SAMPLE)
  const m1 = g.tasks.find((t) => t.id === 'm1')
  ok(!!m1, '`0d` 的任务没被丢掉（第一版把里程碑整条丢掉，图看着还挺正常）')
  ok(m1 && m1.dur === 0, 'm1 时长为 0', String(m1?.dur))
  const tagged = parseGantt('gantt\nsection S\n发布 : milestone, k1, 2026-02-02, 0d')
  ok(tagged.tasks[0].tags.includes('milestone'), 'milestone 标签认出来')
  const svg = renderGanttSvg(parseGantt(SAMPLE))
  ok((svg.match(/class="yq-gantt-ms"/g) || []).length === 1, '里程碑画成菱形', svg.match(/yq-gantt-ms/g)?.length)
}

console.log('\n== after 依赖（第一版整条任务凭空消失）==')
{
  const g = parseGantt(SAMPLE)
  const by = Object.fromEntries(g.tasks.map((t) => [t.id, t]))
  ok(!!by.d2, 'after 任务没被丢掉')
  ok(by.d2.afterRef === 'd1', 'after 引用记下了', by.d2?.afterRef)
  ok(iso(by.d2.start) === '2026-01-20', 'd2 起点接在 d1 结束（01-20）', iso(by.d2.start))
  ok(by.d2.dur === 10 * MS_DAY, 'after 任务的**时长**没丢（不能从 NaN 里反推）', String(by.d2?.dur))
  ok(iso(by.d2.end) === '2026-01-30', 'd2 结束对', iso(by.d2.end))
  ok(iso(by.m2.start) === '2026-02-02', 'm2 接在里程碑 m1 之后', iso(by.m2.start))
  ok(!g.tasks.some((t) => t.unresolved), '没有 unresolved')
}

console.log('\n== after 成环 / 引用不存在：不能死循环，也不能默默画错位置 ==')
{
  const cyc = parseGantt('gantt\nsection S\na : a1, after a2, 3d\nb : a2, after a1, 3d')
  ok(cyc.tasks.length === 2, '成环的两条任务都还在（没被丢掉）', String(cyc.tasks.length))
  ok(cyc.tasks.every((t) => t.unresolved), '成环的两条都标 unresolved')
  ok(cyc.skipped.length >= 2, '成环如实进 skipped', JSON.stringify(cyc.skipped))
  const miss = parseGantt('gantt\nsection S\na : a1, after 不存在, 3d')
  ok(miss.tasks[0].unresolved === true, '引用不存在也标 unresolved')
  ok(renderGanttSvg(cyc) === '', '全是 unresolved 时渲染出空串（不是一张位置错掉的图）')
}

console.log('\n== section 分组 ==')
{
  const g = parseGantt(SAMPLE)
  const secs = [...new Set(g.tasks.map((t) => t.section))]
  ok(secs.join(',') === '准备,开发,上线', '三个 section 且顺序按源码', secs.join(','))
  const svg = renderGanttSvg(g)
  ok((svg.match(/class="yq-gantt-section"/g) || []).length === 3, '三个 section 标题都画了')
  const none = parseGantt('gantt\na : a1, 2026-01-05, 3d')
  ok(none.tasks[0].section === '未分组', '没写 section 的任务有归属，不至于凭空消失', none.tasks[0].section)
}

console.log('\n== 标签 ==')
{
  const g = parseGantt(SAMPLE)
  const by = Object.fromEntries(g.tasks.map((t) => [t.id, t]))
  ok(by.r1.tags.includes('done'), 'done 标签')
  ok(by.d1.tags.includes('crit'), 'crit 标签')
  ok(by.d2.tags.includes('active'), 'active 标签')
  ok(by.d3.tags.length === 0, '没标签的任务 tags 为空', JSON.stringify(by.d3.tags))
  ok(by.d3.id === 'd3', '标签和 id 分得开（d3 没有标签但 id 认对了）')
}

console.log('\n== 认不出来的写法要明说 ==')
{
  ok(parseGantt('gantt\nsection S\na : a1, 2026-01-05, 3光年').tasks.length === 0, '坏时长不产出任务')
  ok(parseGantt('gantt\nsection S\na : a1, 2026-01-05, 3光年').skipped.length === 1, '坏时长进 skipped')
  ok(parseGantt('gantt\nsection S\n任务 : t1, 前天, 3d').tasks.length === 0, '坏日期不产出任务（不猜日期）')
  ok(parseGantt('gantt\nsection S\n任务 : t1, 前天, 3d').skipped.length === 1, '坏日期进 skipped')
  const ex = parseGantt('gantt\nexclude weekends\nsection S\na : a1, 2026-01-05, 3d')
  ok(ex.skipped.some((s) => /exclude/.test(s)), 'exclude 明说没参与计算', JSON.stringify(ex.skipped))
  ok(ex.tasks.length === 1, 'exclude 不影响其它任务')
  const until = parseGantt('gantt\nsection S\na : a1, 2026-01-05, until a2')
  ok(until.skipped.some((s) => /until/.test(s)), 'until 明说未实现')
  ok(parseGantt('gantt\nsection S\n这行没有冒号').skipped.length === 1, '没冒号的行进 skipped')
  ok(parseGantt('@startgantt\n标题 : t1, 2026-01-05, 3d\n@endgantt').skipped.length === 0,
    '@start/@end 是成对标记，不是「不认识的写法」（假告警比没告警更糟）')
}

console.log('\n== 边界 ==')
{
  ok(parseGantt('').tasks.length === 0, '空源码不炸')
  ok(renderGanttSvg(parseGantt('')) === '', '空源码渲染出空串')
  ok(parseGantt('gantt').tasks.length === 0, '只有头部时不凭空造任务')
  ok(renderGanttSvg(parseGantt('gantt')) === '', '只有头部渲染出空串')
  const allBad = parseGantt('gantt\nsection S\na : a1, 2026-01-05, 3光年')
  ok(renderGanttSvg(allBad) === '', '全部解析失败时渲染出空串')
}

console.log('\n== 渲染 ==')
{
  const svg = renderGanttSvg(parseGantt(SAMPLE))
  ok(svg.startsWith('<svg'), '输出以 <svg 开头')
  ok(svg.trimEnd().endsWith('</svg>'), '输出以 </svg> 结尾')
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
  ok(vb && Number(vb[1]) > 0 && Number(vb[2]) > 0, `viewBox 正数（${vb?.[1]}×${vb?.[2]}）`)
  // 7 条任务：6 根条 + 1 个里程碑
  ok((svg.match(/class="yq-gantt-(bar|crit|done|active)"/g) || []).length === 6, '六根条都画了')
  ok((svg.match(/class="yq-gantt-done"/g) || []).length === 2, 'done 配色两条')
  ok((svg.match(/class="yq-gantt-crit"/g) || []).length === 1, 'crit 配色一条')
  ok((svg.match(/class="yq-gantt-active"/g) || []).length === 1, 'active 配色一条')
  ok((svg.match(/class="yq-gantt-tick"/g) || []).length > 0, '时间轴刻度画了')
  ok((svg.match(/class="yq-gantt-grid"/g) || []).length > 0, '网格线画了')
  ok(svg.includes('内网知识库一期排期'), '标题进了 SVG')
  ok(svg.includes('知识库 CRUD'), '任务名进了 SVG')
  ok(svg.includes('2026-01-05'), '日期刻度进了 SVG')
  ok(/class="yq-gantt-title"/.test(svg), '标题有专门的类名')
  const single = renderGanttSvg(parseGantt('gantt\nsection S\n只有一件事 : t1, 2026-01-05, 3d'))
  ok(single.length > 0, '单任务也能画')
  const noTitle = renderGanttSvg(parseGantt('gantt\nsection S\na : a1, 2026-01-05, 3d'))
  ok(!/class="yq-gantt-title"/.test(noTitle), '没有 title 就不画标题行')
}

console.log('\n== 文本必须转义 ==')
{
  const svg = renderGanttSvg(parseGantt('gantt\ntitle <script>x</script>\nsection S\na : a1, 2026-01-05, 3d'))
  ok(!/<script/i.test(svg), '<script> 被转义掉了，没进 SVG')
  ok(svg.includes('&lt;script&gt;'), '转义后的实体在 SVG 里')
}

console.log('\n== 路由：解析器会画 ≠ 用户能看见 ==')
/* ⚠️ 2026-10-07 补上这一节，因为**甘特图整个功能从来没被路由到过**。
   `diagram.ts` 里那句 `if (mk === 'unknown' && isGanttSource(text))`
   恒假 —— `detectMermaid('gantt…')` 返回的是 `'gantt'` 而不是 `'unknown'` ——
   于是落到 `unsupported`。而这个套件原来 43 项全绿：
   它只断 `parseGantt` / `renderGanttSvg` / `isGanttSource`，**从不调路由**，
   静态预览页更是直接 `renderGanttSvg(parseGantt(src))`，把路由绕得干干净净。

   教训不是「少写了一条断言」，是：**有实现 + 解析器测试全绿，仍然可以是
   用户永远看不到的功能**。凡是「界面上有个开关/一个入口」的实现，
   判据必须落在**入口那一层**，不是落在解析器那一层。 */
{
  /* 最小的一份独立 `gantt`（不带任何方言特征）—— 缺陷就出在这种最普通的写法上 */
  const GANTT = 'gantt\ndateFormat YYYY-MM-DD\nsection S\n需求确认 : r1, 2026-01-05, 4d'
  ok(pickDiagramMode(GANTT) === 'gantt',
    '普通 `gantt` 源码路由到甘特分支（这条原来失败 → 用户只看到「未实现」）',
    pickDiagramMode(GANTT))
  ok(pickDiagramMode('@startgantt\ntitle X\n任务 : r1, 2026-01-05, 4d\n@endgantt') === 'gantt',
    '@startgantt 方言也路由到甘特分支')
  ok(LOCALLY_RENDERED_MODES.includes('gantt'), '甘特图算「本地能出 SVG」那几种')
  /* 别的族不能被误吞：甘特闸修好之后，确认没把流程图/时序图一起吃掉 */
  ok(pickDiagramMode('graph TD\nA-->B') === 'flow', '流程图没被甘特闸吃掉', pickDiagramMode('graph TD\nA-->B'))
  ok(pickDiagramMode('sequenceDiagram\nA->>B: x') === 'seq', '时序图没被甘特闸吃掉')
  ok(pickDiagramMode('digraph G { a->b }') === 'dot', 'DOT 没被甘特闸吃掉')
  ok(pickDiagramMode('stateDiagram-v2\n[*] --> A') === 'state', '状态图没被甘特闸吃掉')
  /* 产品自己的示例按钮加载的就是上面那份 SAMPLE —— 它必须路由到甘特 */
  ok(pickDiagramMode(SAMPLE) === 'gantt', '这个套件用的产品级 SAMPLE 能路由到甘特',
    pickDiagramMode(SAMPLE))
}

console.log('\n== exclude / until：画不对的那几行必须被说出来 ==')
{
  /* 删掉「mk === unknown」那道闸之后，剩下的风险是 mermaid 的 exclude /
     多周分页画出来**时间不对**。这里钉住它们的处理方式：不静默画错，逐条报。 */
  const ex = parseGantt('gantt\ndateFormat YYYY-MM-DD\nsection S\nexclude weekends\n任务 : t1, 2026-01-05, 4d')
  ok(ex.skipped.some((s) => /exclude/.test(s)), 'exclude 被明确报出来（不参与计算）', ex.skipped)
  ok(ex.tasks.length === 1, 'exclude 不影响正常任务', ex.tasks.length)
  const un = parseGantt('gantt\nsection S\na : t1, until t2')
  ok(un.skipped.some((s) => /until/.test(s)), 'until 依赖明确报出来、整条不画', un.skipped)
  ok(un.tasks.length === 0, 'until 那条真的没画', un.tasks.length)
  /* ⚠️ 少写 id 的畸形写法（`a : until t1`）**不会**进 until 分支 ——
     `until t1` 会先被当成 id 吃掉，于是起始认不出。它仍然被 skipped 报出来，
     没有被悄悄画成一根错的条。要保的性质是这个，不是「每种畸形都有专属文案」。 */
  const noId = parseGantt('gantt\nsection S\na : until t1')
  ok(noId.tasks.length === 0, '少写 id 的 until 写法也不画（宁可空着）', noId.tasks.length)
  ok(noId.skipped.length > 0, '并且明确报出来，不是静默丢掉', noId.skipped)
}

console.log('\n== 时间轴刻度必须放得下（原来最右一格被切）==')
/* ⚠️ 2026-10-07 补。缺陷形态：套件只断「刻度画了」，没断「刻度放得下」。
   最右一格的日期标签往右伸出约 53px，而画布右缘只比网格线多留 42px ——
   界面上那格显示成 `2026-01-2`。
   ⚠️ 这里**量不了真实字宽**（纯函数里没有字体），所以断的是**几何关系**：
 *   最右刻度的 x + 预留标签宽 <= 画布宽。预留宽用导出的 TICK_W 真常量 ——
 *   在测试里另写一个 58，两处各写一遍就必然漂（这个项目的老毛病）。
 *   「TICK_W 够不够」那一层是拿浏览器 getBBox 实测的（58 >= 实测 53）。 */
{
  const src = 'gantt\ndateFormat YYYY-MM-DD\nsection 准备\n' +
    'a : r1, 2026-01-05, 2026-01-09\nb : r2, 2026-01-19, 2d'
  for (const [label, s] of [['短跨度', src], ['长跨度',
    'gantt\ndateFormat YYYY-MM-DD\nsection S\na : r1, 2026-01-05, 4d\nb : r2, 2027-06-05, 9d']]) {
    const svg = renderGanttSvg(parseGantt(s))
    const W = Number(/width="([\d.]+)"/.exec(svg)[1])
    /* 每个 <text class="yq-gantt-tick"> 的 x 是紧跟 class 之前的那个 x= */
    const tickX = [...svg.matchAll(/<text x="([\d.]+)" y="[\d.]+" class="yq-gantt-tick"/g)]
      .map((m) => Number(m[1]))
    ok(tickX.length > 0, `${label}：刻度标签画出来了`, tickX.length)
    const rightmost = Math.max(...tickX)
    /* ⚠️ 必须**减掉** TICK_TEXT_DX 再比 —— text.x 已经含了那 3px 偏移，
       而 TICK_W 本身就是「从网格线起算」的预留宽度。直接在 text.x 上加 TICK_W
       等于重复算了 3px，第一版就是这么写的，短跨度图差 3px 假红。
       这里断的正是 TICK_W 被引入时想保证的那条不变式。 */
    const rightmostGridX = rightmost - TICK_TEXT_DX
    ok(rightmostGridX + TICK_W <= W,
      `${label}：最右刻度标签有地方放（网格线 ${rightmostGridX.toFixed(0)} + 预留 ${TICK_W} <= 画布 ${W}）`,
      rightmostGridX)
    /* 顺带钉住「标签起点不跑到网格线左边」—— 反向越界也不好 */
    ok(tickX.every((x) => x >= 0 && x <= W), `${label}：每个刻度标签起点都在画布内`, JSON.stringify(tickX))
  }
  /* TICK_W 本身要与实测对齐：浏览器量到的 `2026-01-21` 宽约 53，
     加上绘制偏移 3 要 56，留 58 有 2px 余量。改小了会重新切字。 */
  ok(TICK_W >= 56, `TICK_W=${TICK_W} ≥ 实测所需 56（标签 53 + 偏移 3）`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1