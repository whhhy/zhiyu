/* ============================================================
   Mermaid `erDiagram`（实体关系图）+ 它与类图共用的渲染契约
   ------------------------------------------------------------
   它不另写渲染：实体与类**结构一样**（名字 + 属性表的隔层盒子），
   关系也都是带标注的连线，所以直接复用 `renderClassDiagramSvg`。
   套件顺带钉住「**引用的 marker 必须都有定义**」——
   2026-10-07 实测发现 `yq-cd-arrow-1` 被引用却从没定义，
   于是**正向关系（最常见的那种）画出来没有箭头**，而单测全绿、
   界面上也只是「线看着短了一点」。
   ============================================================ */
import { parseErDiagram, renderErDiagramSvg, isErDiagramSource } from './src/lib/erdiagram.ts'
import { parseClassDiagram, renderClassDiagramSvg } from './src/lib/classdiagram.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

const SAMPLE = `erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    CUSTOMER ||--|| ADDRESS : "lives at"
    PRODUCT }o--|| ORDER_ITEM : "referenced by"
    CUSTOMER {
        string name PK
        string email UK
        int age
    }
    ORDER {
        int id PK
        string status
        int customer_id FK
    }`

console.log('== 识别 ==')
{
  ok(isErDiagramSource('erDiagram\nA ||--o{ B'), 'erDiagram 认得出')
  ok(isErDiagramSource('  \n erDiagram\nA ||--o{ B'), '前面有空行也认得出')
  ok(!isErDiagramSource('classDiagram\nclass A'), '类图不被误认')
  ok(!isErDiagramSource('graph TD\nA-->B'), '流程图不被误认')
  ok(!isErDiagramSource(''), '空串不认')
}

console.log('\n== 四种基数都要认出来（认错就是画错的数据模型）==')
{
  const d = parseErDiagram('erDiagram\n  A ||--o{ B : x\n  A |o--|| B : y\n  A }o--|{ B : z')
  const kinds = d.relations.map((r) => r.kind)
  ok(d.relations.length === 3, `三条关系（${d.relations.length}）`, JSON.stringify(kinds))
  ok(kinds.includes('1 → 0..N'), '`||--o{` = 恰好一 → 零或多', JSON.stringify(kinds))
  ok(kinds.includes('0..1 → 1'), '`|o--||` = 零或一 → 恰好一', JSON.stringify(kinds))
  ok(kinds.includes('0..N → 1..N'), '`}o--|{` = 零或多 → 一或多', JSON.stringify(kinds))
  ok(d.skipped.length === 0, '没有掉进 skipped', JSON.stringify(d.skipped))
  // ⚠️ 第三次栽在**非捕获组**上：基数写成 `(?:…)` 时整份正则只剩 4 个组，
  //    而代码按 6 个读 → 「线型」被当成「左基数」，`to` 是 undefined，
  //    **四条关系一条都没画出来**，全部掉进 skipped。
  ok(d.relations.every((r) => r.from && r.to && r.to !== 'undefined'),
    '每条关系的两端都取到了实体（不是 undefined）', JSON.stringify(d.relations.map((r) => [r.from, r.to])))
}

console.log('\n== 实体与属性 ==')
{
  const d = parseErDiagram(SAMPLE)
  ok(d.classes.length === 6, `六个实体（${d.classes.length}）`, JSON.stringify(d.classes.map((c) => c.id)))
  const cust = d.classes.find((c) => c.id === 'CUSTOMER')
  ok(cust.rows.length === 3, `CUSTOMER 三条属性（${cust.rows.length}）`, JSON.stringify(cust.rows))
  ok(cust.rows[0] === 'string name PK', 'PK 后缀保留', cust.rows[0])
  ok(cust.rows[1].endsWith('UK'), 'UK 后缀保留', cust.rows[1])
  const order = d.classes.find((c) => c.id === 'ORDER')
  ok(order.rows.some((r) => r.endsWith('FK')), 'FK 后缀保留', JSON.stringify(order.rows))
  const bare = parseErDiagram('erDiagram\n  ONLY_ONE')
  ok(bare.classes.length === 1, '光秃秃一个实体名也认（不然会掉进 skipped）', String(bare.classes.length))
}

console.log('\n== 识别 / 非识别：实线与虚线 ==')
{
  const d = parseErDiagram('erDiagram\n  A ||--o{ B : strong\n  A ||..o{ B : weak')
  ok(d.relations.length === 2, '两条关系', String(d.relations.length))
  ok(d.relations[0].dashed === false, '`--`（识别）是实线', String(d.relations[0].dashed))
  ok(d.relations[1].dashed === true, '`..`（非识别）是虚线', String(d.relations[1].dashed))
  const svg = renderErDiagramSvg(d)
  // ⚠️ 属性顺序：`d` … `fill` `class` `stroke-dasharray`。按固定顺序写正则会漏
  const dashed = (svg.match(/class="yq-cd-rel"[^>]*stroke-dasharray/g) || []).length
  ok(dashed === 1, `只有非识别那条是虚线（${dashed}）`)
}

console.log('\n== 基数标在文字上，不是画乌鸦脚 ==')
{
  const svg = renderErDiagramSvg(parseErDiagram(SAMPLE))
  ok(!/polygon[^>]*yq-cd/.test(svg), '没有画任何多边形（宁可少画也不画错）')
  ok((svg.match(/class="yq-cd-rel-label"/g) || []).length === 4, '四条关系都有标注',
    String((svg.match(/class="yq-cd-rel-label"/g) || []).length))
  const labels = [...svg.matchAll(/class="yq-cd-rel-label">([^<]*)</g)].map((m) => m[1])
  ok(labels.some((l) => l.includes('1 → 0..N')), '基数写进标注', JSON.stringify(labels))
  ok(labels.some((l) => l.includes('places')), '关系说明也写进标注', JSON.stringify(labels))
  // 引号是 mermaid 的定界符，不是内容
  ok(!labels.some((l) => l.includes('&quot;')), '标签两端的引号被剥掉（否则标注更宽、更早被截断）', JSON.stringify(labels))
  // 标注宽度上限：比列间距窄，否则会盖住相邻盒子的成员行（上一轮实测）
  // ⚠️ **不能按字符个数判** —— 中西文宽度差一倍多。要按渲染那套宽度规则算：
  //    中文 = 字号，西文 = 0.56 × 字号，字号 10，列间距上限 104px。
  const px = (s) => [...s].reduce((w, ch) => w + (/[\u2e80-\uffff]/.test(ch) ? 10 : 10 * 0.56), 0)
  ok(labels.every((l) => px(l) <= 104), '标注渲染宽度都在上限内',
    JSON.stringify(labels.map((l) => [l, Math.round(px(l))])))
}

console.log('\n== marker 守卫：引用的必须有定义 ==')
{
  /* ⚠️ 2026-10-07 真实缺陷：代码引用 `yq-cd-arrow-1`，
     而 defs 里只定义了 `yq-cd-arrow-2` 和 `yq-cd-arrow-0` ——
     于是**正向关系（最常见的那种）根本没有箭头**。
     单测全绿、也不报错，界面上只是「线看着短了一点」。 */
  for (const [label, svg] of [
    ['类图', renderClassDiagramSvg(parseClassDiagram('classDiagram\n  A --> B\n  C --> A'))],
    ['实体关系图', renderErDiagramSvg(parseErDiagram(SAMPLE))],
  ]) {
    const refs = [...new Set([...svg.matchAll(/marker-end="url\(#([^)]+)\)"/g)].map((m) => m[1]))]
    const defs = [...new Set([...svg.matchAll(/<marker id="([^"]+)"/g)].map((m) => m[1]))]
    const missing = refs.filter((r) => !defs.includes(r))
    ok(refs.length > 0, `${label} 确实用了 marker`, JSON.stringify(refs))
    ok(missing.length === 0, `${label} 引用的 marker 全都有定义`, `缺：${missing.join(',')}`)
    const unused = defs.filter((d) => !refs.includes(d))
    ok(unused.length === 0, `${label} 没有定义了却没人用的 marker`, `多余：${unused.join(',')}`)
  }
}

console.log('\n== 边界 ==')
{
  ok(parseErDiagram('').classes.length === 0, '空源码不炸')
  ok(renderErDiagramSvg(parseErDiagram('')) === '', '空源码渲染出空串')
  ok(renderErDiagramSvg(parseErDiagram('erDiagram')) === '', '只有头部渲染出空串')
  const bad = parseErDiagram('erDiagram\n  A ??? B')
  ok(bad.relations.length === 0 && bad.skipped.length === 1, '认不出的关系行进 skipped', JSON.stringify(bad.skipped))
  const bracket = parseErDiagram('erDiagram\n  T {\n    string[] tags\n    int n\n  }')
  ok(bracket.classes[0].rows.length === 2, '属性里带方括号也认', JSON.stringify(bracket.classes[0].rows))
  const noType = parseErDiagram('erDiagram\n  T {\n    这行没类型\n  }')
  ok(noType.skipped.length === 1, '没有类型的属性行进 skipped', JSON.stringify(noType.skipped))
  const esc = renderErDiagramSvg(parseErDiagram('erDiagram\n  A ||--o{ B : <script>x</script>'))
  ok(!/<script/i.test(esc), '<script> 被转义掉了，没进 SVG')
}

console.log('\n== 路由 ==')
{
  const { pickDiagramMode, LOCALLY_RENDERED_MODES } = await import('./src/lib/diagram.ts')
  ok(pickDiagramMode('erDiagram\nA ||--o{ B') === 'er', 'erDiagram 走自己的解析器')
  ok(pickDiagramMode('erDiagram\nA {\n string x\n}') === 'er', '带属性体的也走')
  ok(LOCALLY_RENDERED_MODES.includes('er'), 'er 在本地可渲染清单里', LOCALLY_RENDERED_MODES.join(','))
  ok(new Set(LOCALLY_RENDERED_MODES).size === LOCALLY_RENDERED_MODES.length,
    '清单里没有重复项（新增图种时这条不会失效）')
  ok(pickDiagramMode('classDiagram\nclass A') === 'class', '类图路由没被影响')
  ok(pickDiagramMode('graph TD\nA-->B') === 'flow', '流程图路由没被影响')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1