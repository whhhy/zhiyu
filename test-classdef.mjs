/* ============================================================
   Mermaid `classDef` / `class` / `X:::name` —— 节点样式
   ------------------------------------------------------------
   这个套件分两半，重要性不对等：

   ① **注入面（白名单过滤）** —— 这是本项目全文里唯一一处把
      「用户写的源码」拼进 HTML 属性 的地方，而知识库是**全员可写**的。
      一个
          classDef x fill:red" onload="alert(1)
      原样拼进 `style="..."` 就是属性注入：引号闭合后后面整段变成新属性。
      **转义在这里不够** —— SVG 属性里浏览器会先解实体，`&quot;` 又变回引号。
      所以口径是白名单：整串不匹配就丢掉并报出来，绝不「清洗后凑合用」。

   ② **三个图种都接上了**（流程图 / 状态图 / 类图 / 实体关系图）——
      判据共用一份，写在 `diagram-style.ts`。
      ⚠️ 共享判据的必要性是被真实 bug 逼出来的：
      上一版那个「第二个 token 不是 `{`」的判据在三个解析器里各写一遍，
      结果同一个错犯三次，其中类图那次还额外漏了 `<<interface>>` 注解，
      害得「类声明被当样式吞掉」、套件 52/58。
   ============================================================ */
import { parseStyles, styleForNode, styleAttr, isClassAssign } from './src/lib/diagram-style.ts'
import { parseFlowchart, renderFlowchartSvg } from './src/lib/flowchart.ts'
import { parseStateDiagram } from './src/lib/statediagram.ts'
import { parseClassDiagram, renderClassDiagramSvg } from './src/lib/classdiagram.ts'
import { parseErDiagram, renderErDiagramSvg } from './src/lib/erdiagram.ts'
import { renderFlowchartSvg as renderStateDiagramSvg } from './src/lib/flowchart.ts'

let pass = 0, fail = 0
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  PASS ' + msg) }
  else { fail++; console.log('  FAIL ' + msg + (extra != null ? ' —— ' + JSON.stringify(extra) : '')) }
}

console.log('== ① 注入：属性注入是这里唯一真正危险的东西 ==')
{
  const EVIL = [
    ['引号闭合 + 事件处理器', 'classDef x fill:red" onload="alert(1)'],
    ['单引号闭合', "classDef x fill:red' onload='alert(1)"],
    ['分号塞第二个属性', 'classDef x fill:red;background:url(javascript:alert(1))'],
    ['url() 引用外部资源', 'classDef x fill:url(//evil/x)'],
    ['闭合标签再开 script', 'classDef x fill:red</style><script>alert(1)</script>'],
    ['老 IE 的 expression()', 'classDef x fill:expression(alert(1))'],
    ['闭合 style 再开标签', 'classDef x fill:red" /><script>alert(1)</script><rect x="'],
    ['换了个属性名照样堵', 'classDef x stroke-width:red" onmouseover="alert(1)'],
    ['rgba 后面跟注入', 'classDef x fill:rgb(1,2,3)" onfocus="alert(1)" autofocus x="'],
    ['color 属性也一样', 'classDef x color:#000" onload="alert(1)'],
    ['stroke-dasharray 塞 url', 'classDef x stroke-dasharray:4,url(//e)'],
    ['opacity 塞表达式', 'classDef x opacity:calc(1)'],
  ]
  for (const [name, src] of EVIL) {
    const attr = styleAttr(styleForNode(parseStyles(src), 'A'))
    const svg = renderFlowchartSvg(parseFlowchart(`flowchart TD\n  A --> B\n  ${src}\n  class A x`))
    /* 三个判据同时成立才算过：属性串里没有危险字符、SVG 里没有、
       而且**必须报出来**（静默丢弃 = 用户以为是自己写错了）。 */
    const badInAttr = /[<>"]|on[a-z]+\s*=|url\(|expression\(|javascript:/i.test(attr)
    const badInSvg = /onload=|onerror=|onmouseover=|onfocus=|<script|javascript:/i.test(svg)
    const reported = parseStyles(src).problems.length > 0
    ok(!badInAttr && !badInSvg && reported, name, { attr, badInAttr, badInSvg, reported })
  }
}

console.log('\n== ② 键名：源码是连字符，内部是驼峰 ==')
{
  /* 漏掉这张映射表的后果很隐蔽：`stroke-width` 是 classDef 里最常用的属性，
     却被报成「不支持」——用户根本看不出是自己的写法没问题。 */
  const p = parseStyles('classDef s fill:#fee,stroke:#c33,stroke-width:4px,font-size:13px,stroke-dasharray:5 4,opacity:0.8,color:#900\nclass A s')
  const s = styleForNode(p, 'A')
  ok(s !== null, '定义了也挂上了才有东西可查')
  ok(p.problems.length === 0, '七个属性全被接受', p.problems)
  ok(s.strokeWidth === '4px', 'stroke-width → strokeWidth', s.strokeWidth)
  ok(s.fontSize === '13px', 'font-size → fontSize', s.fontSize)
  ok(s.strokeDasharray === '5 4', 'stroke-dasharray', s.strokeDasharray)
  ok(s.opacity === '0.8', 'opacity', s.opacity)
  ok(styleAttr(s).includes('stroke-width:4px'), '输出的是 CSS 键名', styleAttr(s))
}

console.log('\n== 不支持的属性要**说出来**，不能悄悄丢 ==')
{
  const p = parseStyles('classDef s fill:#fee,gradient:x,transform:rotate(3)\nclass A s')
  ok(p.problems.filter((x) => x.includes('不支持')).length === 2, '两个不支持的属性各报一次', p.problems)
  ok(styleForNode(p, 'A') !== null, '支持的那个照样生效')
  const bad = parseStyles('classDef s fill:red,stroke:#c33;behavior:url(#x)\nclass A s')
  ok(bad.problems.some((x) => x.includes('不合法')), '塞了分号的值被拒', bad.problems)
}

console.log('\n== 引用了没有定义的 classDef：必须报 ==')
{
  const p = parseStyles('class A,B nosuch')
  ok(p.problems.some((x) => x.includes('没有定义')), '报出来了', p.problems)
  ok(p.problems.filter((x) => x.includes('A')).length === 1 && p.problems.filter((x) => x.includes('B')).length === 1,
    '两个节点各报一次', p.problems)
  const missing = parseStyles('classDef s fill:#fee\nclass A,B s')
  ok(missing.problems.length === 0, '定义齐全时不报', missing.problems)
}

console.log('\n== 多个 classDef 叠加：后写的覆盖先写的 ==')
{
  const p = parseStyles('classDef a fill:#fee\nclassDef b stroke:#c33\nclass X a,b')
  const s = styleForNode(p, 'X')
  ok(s.fill === '#fee' && s.stroke === '#c33', '两个都保留', s)
  const p2 = parseStyles('classDef a fill:#fee\nclassDef b fill:#0f0\nclass X a,b')
  ok(p2.fill === '#0f0' || styleForNode(p2, 'X').fill === '#0f0', '同属性后者胜出（同 CSS）', styleForNode(p2, 'X'))
}

console.log('\n== 流程图 ==')
{
  const SRC = `flowchart TD
    A[开始]:::hot --> B[处理]
    C[结束]:::hot
    classDef hot fill:#fee,stroke:#c33,stroke-width:3px,color:#900
    classDef cold fill:#eef,stroke:#33c
    class B cold`
  const fc = parseFlowchart(SRC)
  const byId = Object.fromEntries(fc.nodes.map((n) => [n.id, n]))
  ok(fc.nodes.map((n) => n.id).join(',') === 'A,B,C', '节点一个不少', fc.nodes.map((n) => n.id))
  /* ⚠️ 行内 ::: 的替换回调如果返回空串，`A[开始]:::hot` 会变成空 ——
     A 连标签一起消失，而图照样画得出来。这里钉死。 */
  ok(byId.A.label === '开始', 'A 的标签还在', byId.A.label)
  ok(byId.A.style?.includes('fill:#fee'), 'A 拿到 hot 的样式', byId.A.style)
  ok(byId.A.labelFill === '#900', 'A 的文字颜色单独挂上', byId.A.labelFill)
  ok(byId.C.style?.includes('fill:#fee'), 'C 也拿到 hot', byId.C.style)
  ok(byId.B.style?.includes('fill:#eef'), 'B 拿到 cold', byId.B.style)
  ok(fc.skipped.length === 0, '没有莫名跳过的行', fc.skipped)

  const svg = renderFlowchartSvg(fc)
  ok(!svg.includes(':::'), '图里没有残留的 :::', svg.includes(':::'))
  ok(!/id="A:::/.test(svg) && !/>hot</.test(svg), '没有 id 里带 ::: 的幽灵节点')
  ok(svg.includes('fill:#fee') && svg.includes('fill:#eef'), '两种样式都进了 SVG')
  /* 文字颜色必须挂在 text 上而不是形状上（挂形状上字不会变色） */
  ok(/class="yq-fc-label" fill="#900"/.test(svg), '文字颜色挂在 text 上')
}

console.log('\n== 状态图（走自己的解析器，接入要单独做）==')
{
  const sd = parseStateDiagram(`stateDiagram-v2
    [*] --> S1
    S1 --> S2
    classDef hot fill:#fee,stroke:#c33,color:#900
    class S1 hot`)
  const byId = Object.fromEntries(sd.nodes.map((n) => [n.id, n]))
  ok(byId.S1?.style?.includes('fill:#fee'), 'S1 有样式', byId.S1?.style)
  ok(byId.S2?.style === undefined, '没挂样式的状态不受影响')
  ok(sd.skipped.length === 0, 'classDef 行不再被报成「不认」', sd.skipped)
  ok(renderStateDiagramSvg(sd).includes('fill:#fee'), '样式进了 SVG')
  const bad = parseStateDiagram('stateDiagram-v2\n  [*] --> S1\n  class S1 nosuch')
  ok(bad.skipped.some((x) => x.includes('没有定义')), '状态图也报未定义', bad.skipped)
}

console.log('\n== 类图：`class A` 是声明，`class A,B x` 才是样式 ==')
{
  /* 这三个用例是 2026-10-07 的真回归，写错时套件直接 52/58。 */
  const decl = parseClassDiagram('classDiagram\n  class A\n  class B\n  classDef x fill:#fee\n  class A,B x')
  ok(decl.classes.map((c) => c.id).join(',') === 'A,B', '两个类都在', decl.classes.map((c) => c.id))
  ok(decl.classes.find((c) => c.id === 'A')?.style?.includes('fill:#fee'), 'A 有样式')
  ok(decl.skipped.length === 0, '声明行没被吞', decl.skipped)

  const annot = parseClassDiagram('classDiagram\n  class 文档 <<interface>> {\n    +String 名称\n  }')
  ok(annot.classes.length === 1 && annot.classes[0].annotation === 'interface', '<<interface>> 注解认得', annot.classes[0]?.annotation)
  ok(annot.classes[0].rows.length === 1, '成员还在', annot.classes[0].rows)
  ok(annot.skipped.length === 0, '注解声明没被当样式吞掉', annot.skipped)

  /* `class A {` 这种带花括号的声明 */
  const brace = parseClassDiagram('classDiagram\n  class A {\n    +int x\n  }')
  ok(brace.classes.length === 1 && brace.classes[0].rows.length === 1, 'class A { 是声明', brace.classes[0])

  const noDef = parseClassDiagram('classDiagram\n  class A\n  class B')
  ok(noDef.skipped.length === 0, '只有声明、没有 classDef 时不报「不认」', noDef.skipped)

  /* 盒子与头部都要上色，只给外框上色会被头部默认底色盖掉 */
  const styled = parseClassDiagram('classDiagram\n  class A\n  classDef x fill:#eef,stroke:#33c,color:#003\n  class A x')
  const svg = renderClassDiagramSvg(styled)
  ok((svg.match(/fill:#eef/g) || []).length === 2, '盒子 + 头部都上了色', (svg.match(/fill:#eef/g) || []).length)
  ok(/class="yq-cd-name" fill="#003"/.test(svg), '类名颜色挂上了')
}

console.log('\n== 实体关系图（复用类图渲染）==')
{
  const d = parseErDiagram('erDiagram\n  A ||--o{ B : x\n  A {\n    string id PK\n  }\n  B {\n    string id PK\n  }\n  classDef hot fill:#fee,stroke:#c33\n  class A hot')
  ok(d.classes.find((c) => c.id === 'A')?.style?.includes('fill:#fee'), '实体 A 有样式', d.classes.find((c) => c.id === 'A')?.style)
  ok(d.skipped.length === 0, 'classDef 行不再进 skipped', d.skipped)
  ok(renderErDiagramSvg(d).includes('fill:#fee'), '样式进了 SVG')
  ok(d.classes.length === 2 && d.relations.length === 1, '实体与关系都没丢', [d.classes.length, d.relations.length])
}

console.log('\n== 判据本身：isClassAssign ==')
{
  ok(isClassAssign('class A,B x'), 'class A,B x → 样式')
  ok(isClassAssign('class A x'), 'class A x → 样式')
  ok(!isClassAssign('class A'), 'class A → 声明')
  ok(!isClassAssign('class A {'), 'class A { → 声明')
  ok(!isClassAssign('class 文档 <<interface>> {'), 'class 文档 <<interface>> { → 声明')
  ok(!isClassAssign('classDef x fill:#fee'), 'classDef 那一行不算 class 赋值')
  ok(!isClassAssign('flowchart TD'), '无关行不算')
}

console.log('\n== 空/异常输入 ==')
{
  ok(styleAttr(null) === '' && styleAttr(undefined) === '', '没有样式就是空串')
  ok(styleAttr({}) === '', '空对象也是空串')
  ok(parseStyles('').defs.size === 0, '空源码不炸')
  ok(parseStyles('%% 只有注释').defs.size === 0, '只有注释也不炸')
  const fc = parseFlowchart('flowchart TD\n  A --> B')
  ok(renderFlowchartSvg(fc).includes('yq-fc-node') && !fc.nodes.some((n) => n.style), '没写 classDef 时样式属性完全缺席', fc.nodes.map((n) => n.style))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)