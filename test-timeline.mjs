/* ============================================================
   Mermaid `timeline`（时间线）
   ------------------------------------------------------------
   这个图种最危险的地方是**排出来的位置本身在表达时间**：
   位置错了，图看着完全正常，读者读到的却是错的时间线。
   所以套件的重点不是「语法能不能解析」，而是**排序与定位对不对**。

   本轮真实踩到（探针 + 浏览器像素）：
     ① 季度被算成年份中点 → `2024 Q3`(1013.5) 排到了 `2025 Q1`(1013) 前面，
        整条时间线**倒着排**
     ② 正则里的 `-?` 把 `2024-03` 的分隔符当成负号 → 三个分支一个都进不去，
        退化成「年份就是 2024」，位置全错且不报错
     ③ 最低那个事件框底边 axisY+14 压住周期标签字形顶 axisY+9.4
        （重叠 4.6px）→ 图上标签像被切了一半。**坐标全对，只有像素看得出来**
   ============================================================ */
import { parseTimeline, renderTimelineSvg, isTimelineSource } from './src/lib/timeline.ts'

let pass = 0, fail = 0
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  PASS ' + msg) }
  else { fail++; console.log('  FAIL ' + msg + (extra != null ? ' —— ' + JSON.stringify(extra) : '')) }
}

const tw = (s, size) => {
  let w = 0
  for (const ch of String(s)) { const cp = ch.codePointAt(0) || 0; w += cp > 0xffff || /[\u2e80-\uffff]/.test(ch) ? size : size * 0.56 }
  return w
}
const xs = (svg) => [...svg.matchAll(/cx="([\d.]+)" cy="[\d.]+" r="3.5"/g)].map((m) => Number(m[1]))
const dim = (svg, k) => Number(new RegExp(k + '="(\\d+)"').exec(svg)[1])
const labelYs = (svg) => [...svg.matchAll(/<text[^>]*class="yq-tl-period"[^>]*>/g)]
  .map((t) => Number(/y="([\d.]+)"/.exec(t[0])[1]))
const evRects = (svg) => [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
  .map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }))

console.log('== 识别 ==')
{
  ok(isTimelineSource('timeline\n  2024 : A'), 'timeline 认得出')
  ok(isTimelineSource('\n%% c\n  timeline\n  2024 : A'), '前面有空行与注释、图种头带缩进也认得出')
  ok(!isTimelineSource('journey\n  section A\n    x: 1'), '用户旅程不被误认')
  ok(!isTimelineSource('gantt\n  section s'), '甘特图不被误认')
  ok(!isTimelineSource(''), '空源码不认')
}

console.log('\n== 基本结构 ==')
{
  const t = parseTimeline('timeline\n    title 历程\n    2024 Q1 : 调研\n    2024 Q3 : 试点 : 培训\n    2025 Q1 : 推广')
  ok(t.title === '历程', '标题', t.title)
  ok(t.periods.length === 3, '三个周期', t.periods.length)
  ok(t.periods[1].events.join(',') === '试点,培训', '一行多个事件', t.periods[1].events)
  ok(t.skipped.length === 0, '没有跳过的行', t.skipped)
  ok(t.fellBackToEven === false, '全都能认年份，不退回等距', t.fellBackToEven)
}

console.log('\n== ① 季度顺序：倒着排过一次 ==')
{
  const t = parseTimeline('timeline\n  2024 Q1 : 乙\n  2024 Q3 : 甲\n  2025 Q1 : 丙')
  ok(t.periods[0].value === 2024, 'Q1 = 年', t.periods.map((p) => p.value))
  ok(t.periods[1].value === 2024.5, 'Q3 = 年 + 2/4', t.periods.map((p) => p.value))
  ok(t.periods[2].value === 2025, '次年 Q1 比同年 Q3 大', t.periods.map((p) => p.value))
  ok(parseTimeline('timeline\n  2024年3季度 : X').periods[0].value === 2024.5, '「年 + 季度」中文写法一致')

  /* 真正要紧的是**图上的顺序** */
  const svg = renderTimelineSvg(parseTimeline('timeline\n  2025 Q1 : 丙\n  2024 Q3 : 甲\n  2024 Q1 : 乙\n  2025 Q4 : 丁'))
  const order = [...svg.matchAll(/class="yq-tl-period">([^<]*)</g)].map((m) => m[1])
  ok(order.join(',') === '2024 Q1,2024 Q3,2025 Q1,2025 Q4', '图上按时间先后排，不是按源码顺序', order)
  const x = xs(svg)
  ok(x.every((v, i) => i === 0 || v > x[i - 1]), 'x 坐标严格递增', x)
}

console.log('\n== ② 数字里的 `-` 是分隔符，不是负号 ==')
{
  ok(parseTimeline('timeline\n  2024-03 : X').periods[0].value === 2024 + 2 / 12, '`2024-03` = 3 月（不是负 3）',
    parseTimeline('timeline\n  2024-03 : X').periods[0].value)
  ok(parseTimeline('timeline\n  2022-2025 : X').periods[0].value === 2023.5, '`2022-2025` = 区间中点',
    parseTimeline('timeline\n  2022-2025 : X').periods[0].value)
  ok(parseTimeline('timeline\n  2022~2025 : X').periods[0].value === 2023.5, '`~` 也是区间')
  ok(parseTimeline('timeline\n  2024年3月 : X').periods[0].value === 2024 + 2 / 12, '「年 + 月」中文写法一致')
  ok(parseTimeline('timeline\n  2024 : X').periods[0].value === 2024, '光年份就是年份')
  ok(parseTimeline('timeline\n  上线后 : X').periods[0].value === null, '认不出年份就是 null（不猜）',
    parseTimeline('timeline\n  上线后 : X').periods[0].value)
}

console.log('\n== 认不出年份时要说实话，而不是悄悄等距 ==')
{
  const t = parseTimeline('timeline\n  2024 : A\n  上线后 : B')
  ok(t.fellBackToEven === true, '标记为已退回等距', t.fellBackToEven)
  const svg = renderTimelineSvg(t)
  ok(svg.includes('yq-tl-warn'), '图上写明「已按等距摆放」')
  ok(/等距/.test(svg), '提示里有「等距」两个字', svg.match(/<text[^>]*yq-tl-warn[^>]*>[^<]*/)?.[0])
  ok(renderTimelineSvg(parseTimeline('timeline\n  2024 : A')).includes('yq-tl-warn') === false, '全都认得出时不给这句提示')
}

console.log('\n== 定位：间隙按时间差成比例 ==')
{
  const svg = renderTimelineSvg(parseTimeline('timeline\n  2002 : A\n  2012 : B\n  2022 : C'))
  const x = xs(svg)
  const g1 = x[1] - x[0], g2 = x[2] - x[1]
  ok(Math.abs(g1 - g2) <= 2, '时间差相等 → 间距相等', [g1, g2])

  const svg2 = renderTimelineSvg(parseTimeline('timeline\n  2002 : A\n  2004 : B\n  2022 : C'))
  const y = xs(svg2)
  ok((y[1] - y[0]) < (y[2] - y[1]), '时间差 2 年 vs 18 年，间距必须不等', [y[1] - y[0], y[2] - y[1]])

  /* 撞下限也不许变成等距：第一版正是这么把比例顶没的 */
  const dense = xs(renderTimelineSvg(parseTimeline('timeline\n  2024 Q1 : 甲\n  2024 Q2 : 乙\n  2025 Q1 : 丙\n  2025 Q4 : 丁')))
  const gaps = [dense[1] - dense[0], dense[2] - dense[1], dense[3] - dense[2]]
  ok(new Set(gaps.map((g) => Math.round(g))).size > 1, '列多跨度小时间距仍有差别（没被列宽顶成等距）', gaps)
}

console.log('\n== 空输入 ==')
{
  for (const [name, src] of [['空源码', ''], ['只有头', 'timeline'], ['只有 title', 'timeline\n  title t']]) {
    const t = parseTimeline(src)
    ok(t.periods.length === 0, `${name}：不产出周期`, t.periods.length)
    ok(renderTimelineSvg(t) === '', `${name}：不产出 SVG`)
  }
  /* 行尾多余的冒号不该造出空事件格子 */
  const t = parseTimeline('timeline\n  2024 : 里程碑:')
  ok(t.periods[0].events.length === 1, '行尾冒号不产生空事件', t.periods[0].events)
}

console.log('\n== ③ 图元不许越界、不许互相压住（浏览器实测踩过）==')
{
  const CASES = {
    季度: 'timeline\n  title 历程\n  2024 Q1 : 调研选型\n  2024 Q3 : 试点上线 : 培训 20 人\n  2025 Q1 : 全员推广\n  2025 Q4 : 内网私有化部署',
    区间月份: 'timeline\n  2022-2025 : 建设期\n  2024-03 : 灰度\n  2024年6月 : 全量',
    无年份: 'timeline\n  上线前 : 准备\n  上线后 : 复盘',
    单列: 'timeline\n  2024 : 只有一列',
    长标签: 'timeline\n  2024 : 这是一个非常非常长的里程碑名称需要放得下',
    超长标签: 'timeline\n  ' + '啊'.repeat(60) + ' : x',
  }
  for (const [name, src] of Object.entries(CASES)) {
    const svg = renderTimelineSvg(parseTimeline(src))
    const W = dim(svg, 'width'), H = dim(svg, 'height')
    const bad = []

    /* 横向：事件框与周期标签都不得越出 viewBox（第一版 5 个用例全越界） */
    for (const r of evRects(svg)) if (r.x < 0 || r.x + r.w > W) bad.push(`事件框 x [${r.x}, ${r.x + r.w}] vs W=${W}`)
    const names = [...svg.matchAll(/class="yq-tl-period">([^<]*)</g)].map((m) => m[1])
    const x = xs(svg)
    names.forEach((p, i) => {
      const half = tw(p, 12) / 2
      if (x[i] - half < -0.5 || x[i] + half > W + 0.5) bad.push(`标签「${p}」越界`)
    })

    /* 纵向：最低事件框下沿必须低于周期标签字形顶（第一版重叠 4.6px） */
    const labelTop = Math.max(...labelYs(svg)) - 12 * 0.72
    const rs = evRects(svg)
    if (rs.length) {
      const lowest = Math.max(...rs.map((r) => r.y + r.h))
      if (lowest > labelTop) bad.push(`事件框压住周期标签：下沿 ${lowest} > 字形顶 ${labelTop.toFixed(1)}`)
      if (lowest > H) bad.push(`事件框超出下边界 ${lowest} > H=${H}`)
    }
    ok(!bad.length, `${name}：${W}×${H} 内无越界、无重叠`, bad)
  }
}

console.log('\n== 渲染基本形状 ==')
{
  const svg = renderTimelineSvg(parseTimeline('timeline\n  2024 : A : B'))
  ok(svg.startsWith('<svg'), '是 SVG')
  ok(svg.includes('yq-tl-svg'), '根节点带类名')
  ok((svg.match(/class="yq-tl-axis"/g) || []).length === 1, '轴只有一条')
  ok(xs(svg).length === 1, '一个周期一个刻度点')
  ok(evRects(svg).length === 2, '两个事件两个框', evRects(svg).length)
  ok(svg.includes('>A<') && svg.includes('>B<'), '事件文字在图上')
  const esc = renderTimelineSvg(parseTimeline('timeline\n  2024 : <script>x</script>'))
  ok(!esc.includes('<script>'), '标签被转义', esc.includes('&lt;script&gt;'))
  ok(!renderTimelineSvg(parseTimeline('')).length, '空的不出图')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)