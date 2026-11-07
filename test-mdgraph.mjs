/* ============================================================
   Markdown 里带图形语言标签的围栏 → 文本绘图卡片
   ============================================================ */
import { markdownToBlocks } from './src/lib/markdown-to-blocks.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

console.log('== 图形围栏要变卡片（从 Confluence / Notion / GitHub 导出的 Markdown 里全是它们）==')
{
  for (const lang of ['mermaid', 'dot', 'graphviz', 'gv', 'plantuml', 'uml', 'puml', 'pu']) {
    const md = '```' + lang + '\ngraph TD\n  A --> B\n```'
    const b = markdownToBlocks(md)[0]
    ok(b && b.type === 'card' && b.data?.cardId === 'plantuml',
      ` \`\`\`${lang} → 文本绘图卡片`, JSON.stringify(b?.type))
  }
  // 大小写
  for (const lang of ['MerMaid', 'GraphViz', 'PLANTUML']) {
    const b = markdownToBlocks('```' + lang + '\nA --> B\n```')[0]
    ok(b?.type === 'card', `\`\`\`${lang}（大小写混写）也认`, b?.type)
  }
}

console.log('\n== 这些仍然是代码块（不能一律转）==')
{
  const cases = [
    ['plaintext', '```plaintext\ngraph TD\n  A --> B\n```', 'plaintext 里贴 mermaid 示例是「教人怎么写」'],
    ['text', '```text\nmermaid 语法长这样\n```', 'text 同理'],
    ['bash', '```bash\nnpm run deploy\n```', 'bash 是真代码'],
    ['js', '```js\nconst a = 1\n```', 'js 是真代码'],
    ['无标签', '```\nconst a = 1\n```', '无标签一律代码块'],
  ]
  for (const [lang, md, why] of cases) {
    const b = markdownToBlocks(md)[0]
    ok(b?.type === 'code', `${lang} 仍是代码块（${why}）`, b?.type)
  }
}

console.log('\n== 语言标签带 # + . - 的也要认（既有缺陷）==')
{
  /* ⚠️ 原来的围栏正则是 `(\w*)`，匹配不上 `objective-c` / `c++` ——
     于是整个围栏**不**被当代码块，落进段落分支，
     **代码连同内容一起变成一段普通文字**。没有代码块、没有报错。 */
  for (const [lang, why] of [['objective-c', 'Objective-C'], ['c++', 'C++'], ['mermaid-flow', '连字符']]) {
    const b = markdownToBlocks('```' + lang + '\nint x = 1;\n```')[0]
    ok(b?.type === 'code' && b.lang === lang,
      `\`\`\`${lang} 是代码块（${why}）—— 不是段落`, `${b?.type}/${b?.lang}`)
  }
  const dot = markdownToBlocks('```mermaid-flow\nA --> B\n```')[0]
  ok(dot?.type === 'code', '`mermaid-flow` **不是**图形标签（精确匹配），留在代码块', dot?.type)
}

console.log('\n== 源码必须一字不差地保留 ==')
{
  const src = 'graph TD\n  A["带 \\" 引号"] --> B((圆))\n  B --> C{判断}'
  const b = markdownToBlocks('```mermaid\n' + src + '\n```')[0]
  ok(b?.data?.src === src, '围栏内容原样进 data.src（含引号 / 空行 / 缩进）', JSON.stringify(b?.data?.src))
  ok(b?.text === '', 'card 块的 text 保持空（cardId 在 data 上，text 上放东西反而会让渲染器困惑）', JSON.stringify(b?.text))
}

console.log('\n== 形状必须是编辑器认的那个（2026-07 踩过：写成 type:"plantuml" 就静默空白）==')
{
  const b = markdownToBlocks('```mermaid\nA --> B\n```')[0]
  ok(b.type === 'card', '块类型是 card', b.type)
  ok(b.data?.cardId === 'plantuml', '卡片类型写在 data.cardId 上（不是 type）', b.data?.cardId)
  ok(typeof b.data?.src === 'string', '源码在 data.src 上（不是 text）')
}

console.log('\n== 边界 ==')
{
  ok(markdownToBlocks('```mermaid\n```')[0]?.type === 'card', '空围栏也转卡片（界面上是空白编辑框，不报错）')
  const unclosed = markdownToBlocks('```mermaid\ngraph TD\nA-->B')[0]
  ok(unclosed?.type === 'card' && unclosed.data.src === 'graph TD\nA-->B', '没闭合的围栏照样把内容取出来',
    JSON.stringify(unclosed?.data?.src))
  const indented = markdownToBlocks('```mermaid\n    graph TD\n        A --> B\n```')[0]
  ok(indented?.type === 'card' && indented.data.src.includes('graph TD'), '带缩进的内容照样认')
  ok(markdownToBlocks('').length === 0, '空源码不炸')
}

console.log('\n== 不影响普通正文 ==')
{
  const bs = markdownToBlocks('前面一段\n\n```mermaid\ngraph TD\nA-->B\n```\n\n后面一段')
  ok(bs.length === 3, `三块：段落 + 卡片 + 段落（${bs.length}）`, JSON.stringify(bs.map((b) => b.type)))
  ok(bs[0].type === 'p' && bs[2].type === 'p', '卡片前后是普通段落')
  ok(bs[1].type === 'card', '中间是卡片')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1