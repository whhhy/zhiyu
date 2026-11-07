/* ============================================================
   Mermaid `classDiagram`（类图）解析与 SVG 渲染
   ------------------------------------------------------------
   守的是 2026-10-07 做的那个**明确的取舍**：类图画完整（隔层盒子 +
   成员表 + 六种关系 + 基数），但关系线上标的是**关系类型文字**，
   **不画** UML 的继承三角 / 组合菱形 —— 符号画错，读者读出来的
   关系就是错的（状态图复合态那个错框的前车之鉴）。
   套件里专门钉住了「每种关系都有类型文字」，防止将来有人偷偷画个错符号。

   断言照实际踩到的坑写：
     · 关系正则里**基数那两组写成了非捕获组** → `rel[3]` 拿到的是目标类名
       而不是基数，而 `kindOf` 因为位置错位收到 `undefined`，解析第一行就炸
     · `<|--` 必须排在 `-->` **之前**判，否则会被拆成 `<` + `-->` 认成关联
     · `<|--` 的箭头指向**基类**，边的方向要反过来（`版本 → 文档`）
   ============================================================ */
import { parseClassDiagram, renderClassDiagramSvg, isClassDiagramSource } from './src/lib/classdiagram.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

const SAMPLE = `classDiagram
    class 文档 {
        +String title
        +String slug
        +publish() void
        +archive() void
    }
    class 知识库 <<interface>> {
        +String name
    }
    class 版本 {
        +int rev
    }
    知识库 "1" o-- "*" 文档 : 收录
    文档 "1" *-- "*" 版本 : 历史
    文档 <|-- 版本`

console.log('== 识别 ==')
{
  ok(isClassDiagramSource('classDiagram\nclass A'), 'classDiagram 认得出')
  ok(isClassDiagramSource('  \n classDiagram\nclass A'), '前面有空行也认得出')
  ok(!isClassDiagramSource('graph TD\nA-->B'), '流程图不被误认')
  ok(!isClassDiagramSource('pie\n"a" : 1'), '饼图不被误认')
  ok(!isClassDiagramSource('sequenceDiagram\nA->>B: x'), '时序图不被误认')
  ok(!isClassDiagramSource(''), '空串不认')
}

console.log('\n== 类与成员 ==')
{
  const d = parseClassDiagram(SAMPLE)
  ok(d.classes.length === 3, `三个类（${d.classes.length}）`, JSON.stringify(d.classes.map((c) => c.id)))
  const doc = d.classes.find((c) => c.id === '文档')
  ok(doc.rows.length === 4, `文档有 4 个成员（${doc.rows.length}）`, JSON.stringify(doc.rows))
  ok(doc.rows[0] === '+String title', '属性原样保留', doc.rows[0])
  ok(doc.rows[2] === '+publish() void', '方法带 `()` 与返回类型也保留', doc.rows[2])
  ok(d.classes.find((c) => c.id === '知识库').annotation === 'interface', '<<interface>> 注解认出来',
    d.classes.find((c) => c.id === '知识库')?.annotation)
  ok(d.skipped.length === 0, '完整样例没有 skipped', JSON.stringify(d.skipped))
  const quoted = parseClassDiagram('classDiagram\nclass Doc["显示名"]')
  ok(quoted.classes[0].label === '显示名', '带引号的显示名认得出', quoted.classes[0].label)
  ok(quoted.classes[0].id === 'Doc', 'id 仍是 Doc', quoted.classes[0].id)
}

console.log('\n== 六种关系都要认出来（认错类型比不画更糟）==')
{
  const d = parseClassDiagram(`classDiagram
    class A
    class B
    class C
    class D
    class E
    class F
    B <|-- A
    C <|.. B
    D ..> A
    E --> A
    F o-- A
    C *-- D`)
  const kinds = d.relations.map((r) => `${r.from}-${r.to}:${r.kind}`)
  ok(d.relations.length === 6, `六条关系（${d.relations.length}）`, JSON.stringify(kinds))
  ok(d.relations.some((r) => r.kind === '继承'), '继承', kinds.join(' '))
  ok(d.relations.some((r) => r.kind === '实现'), '实现', kinds.join(' '))
  ok(d.relations.some((r) => r.kind === '依赖'), '依赖', kinds.join(' '))
  ok(d.relations.some((r) => r.kind === '关联'), '关联', kinds.join(' '))
  ok(d.relations.some((r) => r.kind === '聚合'), '聚合', kinds.join(' '))
  ok(d.relations.some((r) => r.kind === '组合'), '组合', kinds.join(' '))
  // mermaid 的 `<|--` 是**基类在左、子类在右**（官方例：`Animal <|-- Duck`），
  // 箭头指向左边的基类，所以边的方向是 右 → 左。
  // ⚠️ 第一版我把它写成 `子类 <|-- 基类` 再断言 from=子类 —— 那是**测试自己
  //    把语法写反了**，代码是对的。改成官方顺序，断言才对得上。
  const inh = parseClassDiagram('classDiagram\nclass 基类\nclass 子类\n基类 <|-- 子类')
    .relations.find((r) => r.kind === '继承')
  ok(inh && inh.from === '子类' && inh.to === '基类',
    '`<|--` 的箭头指向基类（左边是基类）', JSON.stringify(inh))
  // ⚠️ `<|--` 必须在 `-->` **之前**判，否则被拆成 `<` + `-->` 认成关联
  ok(inh && inh.kind === '继承', '`<|--` 没被认成关联（顺序不能反）', inh?.kind)
}

console.log('\n== 基数与标签 ==')
{
  const d = parseClassDiagram(SAMPLE)
  const agg = d.relations.find((r) => r.kind === '聚合')
  ok(agg.fromCard === '1' && agg.toCard === '*', '两端基数认出来（第一版写成非捕获组，拿到的是类名）',
    `"${agg.fromCard}"/"${agg.toCard}"`)
  ok(agg.label === '收录', '关系标签认出来', agg.label)
  const svg = renderClassDiagramSvg(d)
  ok(svg.includes('聚合 · 收录'), '图上标出「聚合 · 收录」', svg.includes('聚合 · 收录') ? '有' : '无')
  ok(svg.includes('组合 · 历史'), '图上标出「组合 · 历史」')
  ok(svg.includes('继承'), '继承那条也标了类型文字')
}

console.log('\n== 每条关系线都要有关系类型文字（不许画错符号）==')
{
  const d = parseClassDiagram(SAMPLE)
  const svg = renderClassDiagramSvg(d)
  const lines = (svg.match(/class="yq-cd-rel"/g) || []).length
  const labels = (svg.match(/class="yq-cd-rel-label"/g) || []).length
  ok(lines === 3, `三条关系线（${lines}）`)
  ok(labels === lines, `关系线数 = 类型文字数（${labels} vs ${lines}）——没有一条是「裸线」`)
  ok(!/polygon[^>]*yq-cd/.test(svg), '没有画任何多边形符号（宁可少画也不画错）')
  ok(svg.includes('yq-cd-arrowhead'), '箭头 marker 有')
  const dep = renderClassDiagramSvg(parseClassDiagram('classDiagram\nclass A\nclass B\nA ..> B : 用到'))
  ok(dep.includes('stroke-dasharray'), '依赖用虚线（区分「依赖类」与「拥有类」）')
}

console.log('\n== 盒子的隔层 ==')
{
  const svg = renderClassDiagramSvg(parseClassDiagram(SAMPLE))
  ok((svg.match(/class="yq-cd-box"/g) || []).length === 3, '三个盒子')
  ok((svg.match(/class="yq-cd-head"/g) || []).length === 3, '三个头部（类名那一层）')
  ok((svg.match(/class="yq-cd-div"/g) || []).length === 3, '三条成员分隔线')
  ok((svg.match(/class="yq-cd-row"/g) || []).length === 6, '六行成员（4+1+1）',
    String((svg.match(/class="yq-cd-row"/g) || []).length))
  ok(svg.includes('class="yq-cd-annot"'), '注解有专门的类名')
  ok(svg.includes('«interface»'), '注解文字进了 SVG')
  ok(svg.indexOf('yq-cd-head') < svg.indexOf('yq-cd-row'), '头部在成员之前')
}

console.log('\n== 成员多了要收起来（不能把盒子撑爆）==')
{
  const many = parseClassDiagram('classDiagram\nclass A {\n' + Array.from({ length: 12 }, (_, i) => `  +m${i}()`).join('\n') + '\n}')
  const svg = renderClassDiagramSvg(many)
  ok((svg.match(/class="yq-cd-row"/g) || []).length <= 6, '最多画 6 行',
    String((svg.match(/class="yq-cd-row"/g) || []).length))
  ok(svg.includes('还有 6 行'), '剩下的行数如实写出来', svg.includes('还有 6 行') ? '有' : '无')
}

console.log('\n== 认得但做不了的要报出来 ==')
{
  const dir = parseClassDiagram('classDiagram\ndirection LR\nclass A\nclass B\nA --> B')
  ok(dir.skipped.some((s) => /direction/.test(s)), 'direction 报出来', JSON.stringify(dir.skipped))
  const ns = parseClassDiagram('classDiagram\nnamespace Core {\nclass A\n}')
  ok(ns.skipped.some((s) => /namespace/.test(s)), 'namespace 报出来', JSON.stringify(ns.skipped))
  ok(!ns.skipped.some((s) => s === '}'), 'namespace 的收尾括号不算「不认识的写法」（配对问题不是写法问题）',
    JSON.stringify(ns.skipped))
  ok(ns.classes.length === 1, 'namespace 里的类照样解析', String(ns.classes.length))
}

console.log('\n== 边界 ==')
{
  ok(parseClassDiagram('').classes.length === 0, '空源码不炸')
  ok(renderClassDiagramSvg(parseClassDiagram('')) === '', '空源码渲染出空串')
  ok(renderClassDiagramSvg(parseClassDiagram('classDiagram')) === '', '只有头部渲染出空串')
  ok(parseClassDiagram('classDiagram\nclass A').classes.length === 1, '只有声明没有成员也画得出来')
  ok(renderClassDiagramSvg(parseClassDiagram('classDiagram\nclass A')).length > 0, '单类能画')
  const esc = renderClassDiagramSvg(parseClassDiagram('classDiagram\nclass A {\n  +x : <script>y</script>\n}'))
  ok(!/<script/i.test(esc), '<script> 被转义掉了，没进 SVG')
}

console.log('\n== 路由 ==')
{
  // ⚠️ 不硬编码整份清单（见 test-statediagram 的说明）
  const { pickDiagramMode, LOCALLY_RENDERED_MODES } = await import('./src/lib/diagram.ts')
  ok(pickDiagramMode('classDiagram\nclass A') === 'class', 'classDiagram 走自己的解析器')
  ok(pickDiagramMode('classDiagram\nclass A {\n +x\n}') === 'class', '带成员体的也走')
  ok(LOCALLY_RENDERED_MODES.includes('class'), 'class 在本地可渲染清单里', LOCALLY_RENDERED_MODES.join(','))
  ok(new Set(LOCALLY_RENDERED_MODES).size === LOCALLY_RENDERED_MODES.length,
    '清单里没有重复项（新增图种时这条不会失效）')
  ok(pickDiagramMode('graph TD\nA-->B') === 'flow', '流程图不被类图入口吃掉')
  ok(pickDiagramMode('erDiagram\nA ||--o{ B : has') === 'er',
    'erDiagram 也走本地渲染了（复用这套隔层盒子，基数标文字）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1