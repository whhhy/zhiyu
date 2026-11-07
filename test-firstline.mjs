/* ============================================================
   「第一行有内容的源码」—— 7 个图种判定的共同入口
   ------------------------------------------------------------
   这个套件存在的理由是一次**跨 7 个文件的同形缺陷**：
   statediagram / pie / timeline / erdiagram / classdiagram /
   mindmap / journey 各自都写着

       const t = src.trim()
       return /^xxx\\b/i.test(t.split('\\n').find(跳过空行与 %% 注释) || '')

   跳过前导空行 / `%%` 注释之后拿到的是**带缩进**的那一行，
   却拿它去测**行首**正则 —— 于是「前面有空行或注释、且图种头有缩进」
   这种完全正常的写法被判成「不是这个图种」。

   症状形态特别能骗人：**不报错、不空图**，只是路由落到兜底分支，
   界面上给出一张**不相干**的结构预览，而用户只会以为自己的源码写错了。

   为什么不是「顺手改改就行」：同一个判据在 7 处各写一遍，
   改完一处就一定会有人忘了另一处（这次是补 journey 时撞上，
   才发现另外 6 处早就带着同一个 bug）。所以提成 `first-line.ts`，
   这个套件钉住「7 处都必须走共用函数」以及行为本身。
   ============================================================ */
import { firstMeaningfulLine } from './src/lib/first-line.ts'
import { isStateDiagramSource } from './src/lib/statediagram.ts'
import { isPieSource } from './src/lib/pie.ts'
import { isTimelineSource } from './src/lib/timeline.ts'
import { isErDiagramSource } from './src/lib/erdiagram.ts'
import { isClassDiagramSource } from './src/lib/classdiagram.ts'
import { isMindmapSource } from './src/lib/mindmap.ts'
import { isJourneySource } from './src/lib/journey.ts'
import { pickDiagramMode, LOCALLY_RENDERED_MODES } from './src/lib/diagram.ts'
import { detectMermaid } from './src/lib/mermaid.ts'

let pass = 0, fail = 0
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  PASS ' + msg) }
  else { fail++; console.log('  FAIL ' + msg + (extra != null ? ' —— ' + JSON.stringify(extra) : '')) }
}

const ALL = [
  ['状态图', isStateDiagramSource, 'stateDiagram-v2\n  [*] --> S', 'state'],
  ['饼图', isPieSource, 'pie title x\n  "a" : 1', 'pie'],
  ['时间线', isTimelineSource, 'timeline\n  2024 : A', 'timeline'],
  ['实体关系图', isErDiagramSource, 'erDiagram\n  A ||--o{ B : x', 'er'],
  ['类图', isClassDiagramSource, 'classDiagram\n  class A', 'class'],
  ['脑图', isMindmapSource, 'mindmap\n  root((x))', 'mind'],
  ['用户旅程', isJourneySource, 'journey\n  section A\n    x: 1', 'journey'],
]

console.log('== 判据本身 ==')
{
  ok(firstMeaningfulLine('') === '', '空源码返回空串')
  ok(firstMeaningfulLine('只有一行') === '只有一行', '单行')
  ok(firstMeaningfulLine('\n\n  journey') === 'journey', '跳过前导空行并去掉缩进')
  ok(firstMeaningfulLine('  %% 注释\n%% 又一行\n  pie title x') === 'pie title x', '跳过连续 %% 注释')
  ok(firstMeaningfulLine('%% 注释') === '', '只有注释时返回空串（不是返回注释行）')
  ok(firstMeaningfulLine(null) === '', 'null 不炸')
}

console.log('\n== 每个图种：常规写法 ==')
for (const [name, fn, src] of ALL) ok(fn(src), `${name}：认得出`, src)

console.log('\n== 缺陷本体：前导空行 / %% 注释 + 图种头带缩进 ==')
for (const [name, fn, src] of ALL) {
  const indented = '\n  %% 这是注释\n  ' + src.split('\n').join('\n  ')
  ok(fn(indented), `${name}：带缩进也认得出（这就是 2026-10-07 修掉的那个）`, indented.replace(/\n/g, '\\n'))
}

console.log('\n== 反向隔离：不能把别的图种认走 ==')
{
  for (const [name, fn, src] of ALL) {
    /* 把本图种的源码换成另一个图种的，换成别的就都不该认 */
    const others = ALL.filter(([, , s]) => s !== src)
    const wrong = others.filter(([, ofn, osrc]) => ofn(osrc) && fn(osrc))
    ok(!wrong.length, `${name}：不会被别的图种语法误触发`, wrong.map((w) => w[0]))
  }
  /* 识别只看首行 —— 后面写得再离谱也算「是这种图」。
     出不出得了图是**渲染层**的职责，不该由识别函数来把关；
     把两件事混在一起，出现「源码明明是饼图却提示不支持」这种自相矛盾的话。 */
  ok(isPieSource('pie') === true, '孤零零一个 `pie` 也算识别成功（出不出图由渲染层负责）')
  ok(isTimelineSource('timeline 这行后面全是废话') === true, '首行是 timeline 就算，不在识别层挑语法')
  ok(pickDiagramMode('pie') === 'pie', '空内容也照样路由到 pie 分支')
  ok(pickDiagramMode('timeline 2024 : A') === 'timeline', '空内容也照样路由到 timeline 分支')
}

console.log('\n== 路由：这 7 种都要落在自己的分支上 ==')
for (const [name, , src, mode] of ALL) {
  ok(pickDiagramMode(src) === mode, `${name}：pickDiagramMode → ${mode}`, pickDiagramMode(src))
  ok(LOCALLY_RENDERED_MODES.includes(mode), `${name}：算「本地出 SVG」那几种`, mode)
}

console.log('\n== detectMermaid 与 isXSource 不打架 ==')
{
  ok(detectMermaid('journey\n  x: 1') === 'journey', 'detectMermaid 认得 journey')
  ok(detectMermaid('timeline\n  2024 : A') === 'timeline', 'detectMermaid 认得 timeline')
  ok(detectMermaid('classDiagram\n class A') === 'class', 'detectMermaid 认得 class')
  ok(detectMermaid('') === 'unknown', '空的是 unknown')
}

console.log('\n== 命名与导出没被改坏 ==')
{
  ok(typeof isJourneySource === 'function' && typeof isTimelineSource === 'function', '两个新判据都在')
  ok(typeof firstMeaningfulLine === 'function', '共用函数可导出')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)