/* ============================================================
   Mermaid `sankey-beta`（桑基图）
   ------------------------------------------------------------
   这个图种**带宽就是语义**：一条带宽两倍就表示流量两倍。
   所以套件的重点不是「能不能画出来」，而是
     ① 带宽必须**全局单一系数**缩放（不能每条边各自归一化）
     ② 列次必须按「从源头出发的最长路径」
     ③ 有环时不许假装能算 —— 环里最长路径发散，硬算会死循环

   另有一条**只有像素能发现的**：`.yq-sk-*` 的 CSS 必须显式给 fill/stroke，
   不给就是 SVG 默认纯黑，深色主题下和背景糊成一片。
   ============================================================ */
import { readFileSync } from 'node:fs'
import { parseSankey, renderSankeySvg, isSankeySource } from './src/lib/sankey.ts'
import { pickDiagramMode, LOCALLY_RENDERED_MODES } from './src/lib/diagram.ts'

let pass = 0, fail = 0
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  PASS ' + msg) }
  else { fail++; console.log('  FAIL ' + msg + (extra != null ? ' —— ' + JSON.stringify(extra) : '')) }
}

const SRC = `sankey-beta
    title 预算分配
    收入,成本,40
    成本,人力,25
    成本,房租,15
    人力,张三,20
    张三,产出,20`

console.log('== 识别与路由 ==')
{
  ok(isSankeySource('sankey-beta\nA,B,10'), 'sankey-beta 认得出')
  ok(isSankeySource('  \n %% c\n  sankey\n A,B,10'), '前面有空行/注释 + 图种头带缩进也认得出')
  ok(!isSankeySource('flowchart TD\nA-->B'), '流程图不被误认')
  ok(!isSankeySource(''), '空源码不认')
  ok(pickDiagramMode('sankey-beta\nA,B,10') === 'sankey', '路由到 sankey 分支', pickDiagramMode('sankey-beta\nA,B,10'))
  ok(LOCALLY_RENDERED_MODES.includes('sankey'), '算「本地出 SVG」那几种')
}

console.log('\n== 基本结构 ==')
{
  const s = parseSankey(SRC)
  ok(s.title === '预算分配', '标题', s.title)
  ok(s.links.length === 5, '五条连线', s.links.length)
  ok(s.nodes.length === 6, '六个节点', s.nodes.map((n) => n.id).join(','))
  ok(s.skipped.length === 0, '没有跳过的行', s.skipped)
  const by = Object.fromEntries(s.nodes.map((n) => [n.id, n]))
  ok(by['收入'].outTotal === 40, '源节点出量', by['收入'].outTotal)
  ok(by['成本'].inTotal === 40 && by['成本'].outTotal === 40, '中间节点进出相等', [by['成本'].inTotal, by['成本'].outTotal])
}

console.log('\n== 列次：从源头出发的最长路径 ==')
{
  const s = parseSankey(SRC)
  const rank = Object.fromEntries(s.nodes.map((n) => [n.id, n.rank]))
  ok(rank['收入'] === 0, '源头在第 0 列', rank['收入'])
  ok(rank['成本'] === 1, '一级在第 1 列', rank['成本'])
  ok(rank['人力'] === 2 && rank['房租'] === 2, '同层并列', [rank['人力'], rank['房租']])
  ok(rank['产出'] === 4, '最长路径决定层数（不是最短路径）', rank['产出'])
  /* ⚠️ 最短路径是 3、最长路径是 4 —— 用最短路径画出来的图会「挤」掉一列 */
  ok(s.depth === 4, '深度按最长路径', s.depth)
}

console.log('\n== 带宽是语义：两倍流量 = 两倍宽 ==')
{
  const w = (src) => [...renderSankeySvg(parseSankey(src)).matchAll(/class="yq-sk-band" stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]))
  const two = w('sankey-beta\nA,B,10\nA,C,20')
  ok(Math.abs(Math.max(...two) / Math.min(...two) - 2) < 0.05, '10 与 20 的带宽比正好 2', two)
  const same = w('sankey-beta\nA,B,10\nC,D,10')
  ok(same[0] === same[1], '等权重的两条一样宽（不能各自归一化）', same)
  /* 反向：各自的「相对大小」必须跨图可比 —— 同一张图里
     A→B(10) 与 C→D(30)，宽比要是 3 而不是 1 */
  const mixed = w('sankey-beta\nA,B,10\nC,D,30')
  ok(Math.abs(Math.max(...mixed) / Math.min(...mixed) - 3) < 0.05, '10 与 30 的带宽比是 3', mixed)
}

console.log('\n== 有环：不许假装能算 ==')
{
  const s = parseSankey('sankey-beta\nA,B,10\nB,C,5\nC,A,3')
  ok(s.nodes.length === 3 && s.links.length === 3, '环里的节点与连线都还在', [s.nodes.length, s.links.length])
  ok(s.skipped.some((x) => /环里/.test(x)), '明确说「在环里、列次算不出来」', s.skipped)
  ok(renderSankeySvg(s).length > 0, '仍然画得出来（按原始方向），不是空图')
}

console.log('\n== 画不出来 / 不该画的，如实报出来 ==')
{
  const neg = parseSankey('sankey-beta\nA,B,10\nB,C,-5')
  ok(neg.links.length === 1, '负权重那条不画', neg.links.length)
  ok(neg.skipped.some((x) => /不是正数/.test(x)), '负权重明确报出来', neg.skipped)

  const bad = parseSankey('sankey-beta\nA,B,10\n这一行根本没有逗号\nB,C,abc')
  ok(bad.skipped.length === 2, '两行坏写法各报一次', bad.skipped)

  const empty = parseSankey('sankey-beta')
  ok(empty.nodes.length === 0 && renderSankeySvg(empty) === '', '空输入不出图')
}

console.log('\n== 节点名里带逗号 ==')
{
  /* ⚠️ 不能简单 split(',') —— 真实来源里有 `华东,大区,销售,40` 这种。
     简单切分会把节点名切成「华东」和「大区」，图上凭空多两个节点。 */
  const s = parseSankey('sankey-beta\n"华东,大区",销售,30\n"华东,大区",市场,10')
  ok(s.links.length === 2, '两条连线', s.links.length)
  ok(s.nodes.length === 3, '三个节点（不是四个）', s.nodes.map((n) => n.id))
  ok(s.nodes.some((n) => n.id === '华东,大区'), '带逗号的节点名完整保留', s.nodes.map((n) => n.id))
}

console.log('\n== 图元不许超出 viewBox ==')
{
  for (const [name, src] of Object.entries({
    基本: SRC,
    名字带逗号: 'sankey-beta\n"华东,大区",销售,30\n华东大区,市场,10',
    环: 'sankey-beta\nA,B,10\nB,C,5\nC,A,3',
    单边: 'sankey-beta\nA,B,1',
    超长名: 'sankey-beta\n一个非常非常长的节点名称用来测试标签会不会超出画布,A,10',
  })) {
    const svg = renderSankeySvg(parseSankey(src))
    const W = Number(/width="(\d+)"/.exec(svg)[1]), H = Number(/height="(\d+)"/.exec(svg)[1])
    const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g)]
      .map((m) => ({ x: +m[1], y: +m[2], w: +m[3], h: +m[4] }))
    const texts = [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>([^<]*)</g)].map((m) => ({ x: +m[1], y: +m[2], t: m[3] }))
    const out = rects.filter((r) => r.x < 0 || r.y < 0 || r.x + r.w > W || r.y + r.h > H)
    /* 文字右端也要在界内（宽节点名容易溢出） */
    const outT = texts.filter((t) => t.x + textPx(t.t, 11) > W + 1 || t.y > H)
    ok(!out.length && !outT.length, `${name}：${rects.length} 个节点框 + ${texts.length} 处文字都在 ${W}×${H} 内`,
      { out: out.length, outT: outT.map((t) => t.t) })
  }
}

console.log('\n== ⚠️ CSS 规则必须存在且显式给 fill/stroke ==')
{
  const css = readFileSync('src/components/cards/cards.css', 'utf8')
  for (const sel of ['.yq-sk-node', '.yq-sk-band', '.yq-sk-label']) {
    const r = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{[^}]*\\}').exec(css)?.[0] || ''
    ok(r.length > 0, `${sel} 的规则存在`, r.slice(0, 60))
    ok(/fill\s*:|stroke\s*:/.test(r), `${sel} 显式给了 fill 或 stroke（不给就是 SVG 默认纯黑）`, r)
  }
  /* 带子是**描边路径**，`stroke:` 就是它的颜色 —— 那条必须有。
     真正要防的是**填充**：三次贝塞尔路径一旦被 fill，会把曲线围成的
     区域整块填上，看起来是一根粗带而不是流量带。 */
  const band = /\.yq-sk-band\s*\{[^}]*\}/.exec(css)?.[0] || ''
  ok(/\bstroke\s*:/.test(band), 'yq-sk-band 用 stroke 上色（带子本来就是描边路径）', band)
  const bandPaths = [...renderSankeySvg(parseSankey(SRC)).matchAll(/<path[^>]*class="yq-sk-band"[^>]*>/g)].map((m) => m[0])
  ok(bandPaths.length > 0 && bandPaths.every((p) => /fill="none"/.test(p)),
    '每条带子都是 fill="none" 的描边路径（被 fill 会变成一块闭合色斑）', bandPaths[0])
}

function textPx(s, size) {
  let w = 0
  for (const ch of String(s)) { const cp = ch.codePointAt(0) || 0; w += cp > 0xffff || /[\u2e80-\uffff]/.test(ch) ? size : size * 0.56 }
  return w
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)