/* ============================================================
   Mermaid `mindmap`（脑图）解析与 SVG 渲染
   ------------------------------------------------------------
   为什么单独成一套件：纯函数，Node 里直接 import 跑，秒级完成。
   它守的是中文内网文档里很常见的一类内容（公司介绍、知识体系梳理）。

   ⚠️ 断言照**实际踩到的坑**写的：
     · 把 mindmap 喂给 `parseFlowchart` → 14 个节点、**0 条边**，
       一堆互不相连的方框。树不是图：边得由**缩进**推出来，
       而 flowchart 的边来自源码里的 `A-->B`。
     · `stripShape` 第一版用一条大正则并排写「开括号组 / 闭括号组」，
       开分支里混进了裸 `(`，分组不配对 → 正则**编译都过不了**
       （`Unmatched ')'`）。改成三段直白的字符串处理才稳。
     · `::icon(fa fa-book)` 第一版被静默剥掉 —— 剥了不报等于假装支持。
   ============================================================ */
import { parseMindmap, renderMindmapSvg, isMindmapSource, stripShape } from './src/lib/mindmap.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

const SAMPLE = `mindmap
  root((知识库))
    文档
      规范
        编码约定
      流程
      模板
    卡片
      互动
      媒体
    设置
      成员
      权限`

const count = (n) => 1 + n.children.reduce((a, c) => a + count(c), 0)

console.log('== 识别 ==')
{
  ok(isMindmapSource('mindmap\nroot\n  a'), 'mindmap 认得出')
  ok(isMindmapSource('  \n mindmap\nroot'), '前面有空行也认得出')
  ok(!isMindmapSource('graph TD\nA-->B'), '流程图不被误认')
  ok(!isMindmapSource('pie\n"a" : 1'), '饼图不被误认')
  ok(!isMindmapSource('mindmapme\nroot'), 'mindmapme 不被误认（前缀要卡住）')
  ok(!isMindmapSource(''), '空串不认')
}

console.log('\n== 缩进树：层级由缩进推出来 ==')
{
  const m = parseMindmap(SAMPLE)
  ok(!!m.root, '有根节点')
  ok(m.root.label === '知识库', '根名剥掉了 `(( ))`', JSON.stringify(m.root?.label))
  ok(m.root.depth === 0 && m.root.children.length === 3, '根下三个一级节点',
    `${m.root?.depth}/${m.root?.children.length}`)
  const doc = m.root.children[0]
  ok(doc.label === '文档' && doc.depth === 1, '一级节点 depth=1', `${doc.label}/${doc.depth}`)
  ok(doc.children.length === 3, '文档下三个子节点', String(doc.children.length))
  ok(doc.children[0].label === '规范' && doc.children[0].depth === 2, '二级 depth=2')
  ok(doc.children[0].children[0].label === '编码约定' && doc.children[0].children[0].depth === 3, '三级 depth=3')
  ok(count(m.root) === 12, `整棵树 12 个节点（${count(m.root)}）`)
  ok(m.skipped.length === 0, '完整样例没有 skipped', JSON.stringify(m.skipped))
}

console.log('\n== 缩进宽度：2 格 / 4 格 / tab 混用都算一级 ==')
{
  const two = parseMindmap('mindmap\nroot\n  a\n    b\n      c')
  ok(count(two.root) === 4, '两空格缩进（4 个节点）', String(count(two.root)))
  const four = parseMindmap('mindmap\nroot\n    a\n        b\n            c')
  ok(count(four.root) === 4, '四空格缩进（4 个节点）', String(count(four.root)))
  const mixed = parseMindmap('mindmap\nroot\n  a\n    b\n      c')
  ok(count(mixed.root) === 4, '两格/四格混用也算一级（4 个节点）', String(count(mixed.root)))
  const tab = parseMindmap('mindmap\nroot\n\ta\n\t\tb')
  ok(count(tab.root) === 3, 'tab 缩进算一级（3 个节点）', String(count(tab.root)))
}

console.log('\n== 边数必须等于「节点数 - 1」（树的基本性质）==')
{
  const svg = renderMindmapSvg(parseMindmap(SAMPLE))
  const edges = (svg.match(/class="yq-mm-edge"/g) || []).length
  ok(edges === 11, `11 条边 = 12 节点 - 1（${edges}）`)
  ok((svg.match(/class="yq-mm-root"/g) || []).length === 1, '根画成实心圆')
  ok((svg.match(/class="yq-mm-node"/g) || []).length === 3, '三个一级节点画成描边框')
  // 8 个更深的节点 + 3 个一级框内的字 = 11 条 yq-mm-text
  ok((svg.match(/class="yq-mm-text"/g) || []).length === 11,
    '11 条文字（8 个深层节点 + 3 个一级框内）')
  ok(svg.indexOf('yq-mm-edge') < svg.indexOf('yq-mm-root'), '边在节点**之前**（垫在底下）')
}

console.log('\n== 根名不能被裁（第一版半径写死 15，「知识库」被裁成「知…」）==')
{
  const svg = renderMindmapSvg(parseMindmap(SAMPLE))
  ok(svg.includes('>知识库<'), '根名完整出现在 SVG 里', svg.match(/yq-mm-root-text">([^<]*)</)?.[1])
  const r = Number(/<circle cx="[\d.]+" cy="[\d.]+" r="([\d.]+)" class="yq-mm-root"/.exec(svg)?.[1])
  ok(r >= 16, `根圆半径随名字变大（${r}）`)
  const short = renderMindmapSvg(parseMindmap('mindmap\nroot\n  a'))
  const r2 = Number(/<circle cx="[\d.]+" cy="[\d.]+" r="([\d.]+)" class="yq-mm-root"/.exec(short)?.[1])
  ok(r2 >= 16 && r2 < r, `短名字的圆更小（${r2} < ${r}），不是一刀切`)
  const long = renderMindmapSvg(parseMindmap('mindmap\nroot((这是一个特别特别长的根节点名字))\n  a'))
  ok(long.includes('这是一个特别特别长的根节点名字'), '超长根名也不裁')
}

console.log('\n== 外壳写法：显示名不是整串 ==')
{
  const cases = [
    ['root((知识库))', '知识库'],
    ['A[标签]', '标签'],
    ['B(圆)', '圆'],
    ['{花}', '花'],
    ['[[方]]', '方'],
    ['((就这个))', '就这个'],
    ['[类] 名字', '名字'],
    ['普通名字', '普通名字'],
    ['', ''],
  ]
  for (const [tok, want] of cases) {
    ok(stripShape(tok).label === want, `${JSON.stringify(tok).padEnd(16)} → ${JSON.stringify(want)}`,
      JSON.stringify(stripShape(tok)))
  }
  ok(stripShape('普通名字').shaped === false, '没外壳的标记 shaped=false')
  ok(stripShape('A[标签]').shaped === true, '有外壳的标记 shaped=true')
}

console.log('\n== 认得但做不了：要报出来 ==')
{
  const icon = parseMindmap('mindmap\n  root\n    ::icon(fa fa-book) 阅读\n      A')
  ok(icon.root.children[0].label === '阅读', '::icon 的文字留下来了', icon.root.children[0]?.label)
  ok(icon.skipped.some((s) => /::icon/.test(s)), '::icon 报了「图标未实现」（静默剥掉等于假装支持）',
    JSON.stringify(icon.skipped))
  /* ⚠️ 2026-10-07：这两条断言原来写的是「报了未实现」——
     当时确实做不到。现在 classDef 接进来了（复用 diagram-style 那份共用判据），
     所以要断言**样式真的挂上、而且不再报「未实现」**。
     ⚠️ 脑图的节点 id 是自动生成的（m1/m2…），所以样式只能**按显示名**匹配 ——
        这条也钉住，否则将来有人改成按 id 匹配就会全静默失效。 */
  const cls = parseMindmap('mindmap\n  root\n    很急:::urgent\n      子')
  ok(cls.root.children[0].label === '很急', ':::class 的文字留下来了', cls.root.children[0]?.label)
  ok(!cls.skipped.some((s) => /:::/.test(s)), ':::class 不再报「未实现」（做得到就别报做不到）',
    JSON.stringify(cls.skipped))

  const cdef = parseMindmap('mindmap\n  root\n    产品:::hot\n    研发\nclassDef hot fill:#fee,stroke:#c33,color:#900')
  ok(!cdef.skipped.some((s) => /classDef/.test(s)), 'classDef 不再报「未实现」', JSON.stringify(cdef.skipped))
  ok(cdef.root.children.length === 2, 'classDef 不影响正常节点', String(cdef.root.children.length))
  const hot = cdef.root.children[0]
  ok(hot.style?.includes('fill:#fee') && hot.labelFill === '#900', '按显示名挂上了样式', hot.style)
  ok(!cdef.root.children[1].style, '没写 ::: 的节点不受影响')

  /* `class 名1,名2 样式名` 这种写法（脑图里同样合法） */
  const byClass = parseMindmap('mindmap\n  root\n    A\n    B\nclassDef x fill:#eef\nclass A,B x')
  ok(byClass.root.children.every((n) => n.style?.includes('fill:#eef')), 'class A,B x 也认',
    JSON.stringify(byClass.root.children.map((n) => n.style)))

  /* 引用了没有定义的 classDef 必须报出来 */
  const bad = parseMindmap('mindmap\n  root\n    甲:::nosuch')
  ok(bad.skipped.some((s) => /没有定义/.test(s)), '引用不存在的 classDef 会报', JSON.stringify(bad.skipped))
}

console.log('\n== 边界 ==')
{
  ok(parseMindmap('').root === null, '空源码不炸')
  ok(renderMindmapSvg(parseMindmap('')) === '', '空源码渲染出空串')
  ok(renderMindmapSvg(parseMindmap('mindmap')) === '', '只有头部渲染出空串')
  const only = parseMindmap('mindmap\nroot((只有根))')
  ok(!!only.root && only.root.children.length === 0, '单节点也能画')
  ok(renderMindmapSvg(only).length > 0, '单节点渲染出东西', String(renderMindmapSvg(only).length))
  const twoRoots = parseMindmap('mindmap\n  root((一))\n    a\n  root2((二))\n    b')
  ok(twoRoots.root?.label === '一', '第二个同级「根」没有顶掉第一个')
  ok(twoRoots.skipped.length > 0, '认不出的第二个根报出来', JSON.stringify(twoRoots.skipped))
}

console.log('\n== 渲染 ==')
{
  const svg = renderMindmapSvg(parseMindmap(SAMPLE))
  ok(svg.startsWith('<svg') && svg.trimEnd().endsWith('</svg>'), '是完整 SVG')
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
  ok(vb && Number(vb[1]) > 0 && Number(vb[2]) > 0, `viewBox 正数（${vb?.[1]}×${vb?.[2]}）`)
  ok(svg.includes('知识库') && svg.includes('编码约定') && svg.includes('权限'), '节点名都进了 SVG')
  const esc = renderMindmapSvg(parseMindmap('mindmap\n  root\n    <script>x</script>'))
  ok(!/<script/i.test(esc), '<script> 被转义掉了，没进 SVG')
  ok(esc.includes('&lt;script&gt;'), '转义后的实体在 SVG 里')
}

console.log('\n== 路由 ==')
{
  // ⚠️ 完整的路由表**只有一份**，在 test-statediagram.mjs。
  //    这里只留与脑图有关的两条。
  const { pickDiagramMode, LOCALLY_RENDERED_MODES } = await import('./src/lib/diagram.ts')
  ok(pickDiagramMode('mindmap\n  root\n    a') === 'mind', 'mindmap 走自己的解析器')
  ok(LOCALLY_RENDERED_MODES.includes('mind'), 'mind 在本地可渲染清单里', LOCALLY_RENDERED_MODES.join(','))
  ok(pickDiagramMode('graph TD\nA-->B') === 'flow', '流程图不被脑图入口吃掉')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1