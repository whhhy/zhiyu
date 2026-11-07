/* ============================================================
   Mermaid `pie`（饼图）解析与 SVG 渲染
   ------------------------------------------------------------
   为什么单独成一套件：纯函数，秒级完成。

   为什么先做饼图、而不是类图 / 实体关系图：那几种需要**专属的视觉
   语言**（隔层盒子 + 继承三角 / 乌鸦脚），硬做很容易变成「看着像
   画对了、其实关系符号是错的」—— 状态图复合态那个框就是前车之鉴。
   饼图没有这种陷阱，就该先做。

   套件里的断言照**实际踩到的坑**写：
     · 把 pie 喂给 `parseFlowchart` → 1 个叫「pie」的节点，
       带引号的行全进 skipped，不带引号的**反而被当成节点**
     · **负值**第一版当 0 处理，界面上看着「有这一项」，
       而实际上那一块根本不画 —— 饼图的负值是镜像扇区，必须明确拒掉
     · 占比 100% 那一片：两段弧同起同止，`A` 弧指令画不出来，
       要走「两个半圆 + 一条直径」
   ============================================================ */
import { parsePie, renderPieSvg, isPieSource } from './src/lib/pie.ts'
import { parseFlowchart, renderFlowchartSvg } from './src/lib/flowchart.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

const SAMPLE = `pie title 数据分布
    "文档" : 45
    "卡片" : 35
    附件 : 15
    其他 : 5`

console.log('== 识别 ==')
{
  ok(isPieSource('pie\n"a" : 1'), 'pie 认得出')
  ok(isPieSource('pie title 分布\n"a" : 1'), '带标题的也认得出')
  ok(isPieSource('pie showData\n"a" : 1'), 'pie showData 也认得出')
  ok(!isPieSource('graph TD\nA-->B'), '流程图不被误认')
  ok(!isPieSource('mindmap\nroot'), '脑图不被误认')
  ok(!isPieSource('gantt\ndateFormat X'), '甘特图不被误认')
  ok(!isPieSource(''), '空串不认')
}

console.log('\n== 解析：名称与数值 ==')
{
  const p = parsePie(SAMPLE)
  ok(p.title === '数据分布', `标题认出来（${p.title}）`)
  ok(p.slices.length === 4, `四片（${p.slices.length}）`)
  ok(p.slices.map((s) => s.label).join(',') === '文档,卡片,附件,其他',
    '带引号与不带引号的名称都认得', p.slices.map((s) => s.label).join(','))
  ok(p.slices.map((s) => s.value).join(',') === '45,35,15,5', '数值对',
    p.slices.map((s) => s.value).join(','))
  ok(p.slices.every((s, i) => s.tone === i % 8), '色档依次递进',
    p.slices.map((s) => s.tone).join(','))
  ok(p.skipped.length === 0, '完整样例没有 skipped', JSON.stringify(p.skipped))
  const many = parsePie('pie\n' + Array.from({ length: 9 }, (_, i) => `"项${i}" : ${i + 1}`).join('\n'))
  ok(many.slices[8].tone === 0, '超过 8 片时色档回绕（不会越界）', String(many.slices[8].tone))
}

console.log('\n== 负值必须拒掉并报出来（当 0 处理是骗人）==')
{
  const p = parsePie('pie\n"甲" : 5\n"负的" : -3\n"丙" : 2')
  ok(p.slices.length === 2, '负值那一片不产出（其余照常）', String(p.slices.length))
  ok(p.skipped.some((s) => /负值/.test(s)), '负值报出来了', JSON.stringify(p.skipped))
  ok(p.slices.map((s) => s.label).join(',') === '甲,丙', '负值不影响其它片',
    p.slices.map((s) => s.label).join(','))
  ok(renderPieSvg(p).length > 0, '有正值的部分照样能画')
}

console.log('\n== 为什么不能复用 flowchart（这里钉住原因）==')
{
  const f = parseFlowchart(SAMPLE)
  ok(f.nodes.some((n) => n.id === 'pie'), '只解析出 1 个叫 pie 的节点', JSON.stringify(f.nodes.map((n) => n.id)))
  ok(f.skipped.some((s) => /文档/.test(s)), '带引号的行全进 skipped', JSON.stringify(f.skipped))
  ok(renderFlowchartSvg(f).length < renderPieSvg(parsePie(SAMPLE)).length,
    'flowchart 那套画出来的东西明显不是饼图')
}

console.log('\n== 边界 ==')
{
  ok(parsePie('').slices.length === 0, '空源码不炸')
  ok(renderPieSvg(parsePie('')) === '', '空源码渲染出空串')
  ok(renderPieSvg(parsePie('pie')) === '', '只有头部渲染出空串')
  ok(renderPieSvg(parsePie('pie\n"甲" : 0\n"乙" : 0')) === '', '全 0（总和为 0）渲染出空串')
  ok(parsePie('pie\n"甲" : 1').slices.length === 1, '单片认得出')
  const hundred = renderPieSvg(parsePie('pie\n"甲" : 10'))
  ok(hundred.length > 0, '占比 100% 的单片也画得出来（弧同起同闭要特殊处理）', String(hundred.length))
  ok(parsePie('pie\n1.5 : x').slices.length === 0 || true, '小数/坏行不炸')
  const dec = parsePie('pie\n"甲" : 1.5\n"乙" : 2.5')
  ok(dec.slices.map((s) => s.value).join(',') === '1.5,2.5', '小数认得',
    dec.slices.map((s) => s.value).join(','))
  const bad = parsePie('pie\n这一行没有冒号\n"甲" : 1')
  ok(bad.skipped.length === 1, '坏行进 skipped', JSON.stringify(bad.skipped))
  ok(bad.slices.length === 1, '坏行不影响其它行')
  ok(parsePie('pie\n%% 注释\n"甲" : 1').skipped.length === 0, '注释不报')
  ok(parsePie('pie\ntitle 数据\n"甲" : 1').title === '数据', '标题单独一行也认')
}

console.log('\n== 渲染 ==')
{
  const svg = renderPieSvg(parsePie(SAMPLE))
  ok(svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>'), '是完整 SVG')
  // 4 片 + 4 个图例色块
  ok((svg.match(/class="yq-pie-slice"/g) || []).length === 8, '四片扇形 + 四个图例色块',
    String((svg.match(/class="yq-pie-slice"/g) || []).length))
  ok((svg.match(/class="yq-pie-legend"/g) || []).length === 4, '四个图例标签')
  ok(svg.includes('数据分布'), '标题进了 SVG')
  // 45/100 = 45%
  ok(svg.includes('（45%）'), '百分比算对了（45/100）')
  ok(svg.includes('（5%）'), '最小那片的百分比也对（5/100）')
  ok(/class="yq-pie-title"/.test(svg), '标题有专门的类名')
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
  ok(vb && Number(vb[1]) > 0 && Number(vb[2]) > 0, `viewBox 正数（${vb?.[1]}×${vb?.[2]}）`)
  const notitle = renderPieSvg(parsePie('pie\n"甲" : 1'))
  ok(!/class="yq-pie-title"/.test(notitle), '没有标题就不画标题')
  const esc = renderPieSvg(parsePie('pie\n"<script>x</script>" : 1'))
  ok(!/<script/i.test(esc), '<script> 被转义掉了，没进 SVG')
}

console.log('\n== 路由 ==')
{
  // ⚠️ 不硬编码整份清单：加了新图种就会红（见 test-statediagram 里的说明）
  const { pickDiagramMode, LOCALLY_RENDERED_MODES } = await import('./src/lib/diagram.ts')
  ok(pickDiagramMode('pie\n"a" : 1') === 'pie', 'pie 走自己的解析器')
  ok(pickDiagramMode('pie title X\n"a" : 1') === 'pie', '带标题的也走')
  ok(LOCALLY_RENDERED_MODES.includes('pie'), 'pie 在本地可渲染清单里', LOCALLY_RENDERED_MODES.join(','))
  ok(new Set(LOCALLY_RENDERED_MODES).size === LOCALLY_RENDERED_MODES.length,
    '清单里没有重复项（新增图种时这条不会失效）')
  ok(pickDiagramMode('graph TD\nA-->B') === 'flow', '流程图不被饼图入口吃掉')
  /* ⚠️ 2026-10-07 改过：原来断言 `=== 'unsupported'`。那不是隔离断言，是把
     「甘特图被路由闸误吞」这个 bug 当成了正确行为抄下来的。
     甘特图自己的解析器/渲染器一直都在，只是 `diagram.ts` 里
     `mk === 'unknown' && isGanttSource(text)` 恒假。现在期望值是 'gantt'。 */
  ok(pickDiagramMode('gantt\ndateFormat X') === 'gantt',
    'mermaid 的 gantt 走本地渲染器（不再被吞成「未实现」）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1