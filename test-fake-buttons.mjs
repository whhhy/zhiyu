/*
 * 项目级「假按钮」扫描
 * ------------------------------------------------------------
 * `test-no-fake-actions` 一直在抓「能点却没反应」的控件，
 * 但它只覆盖了 `src/pages/Settings.tsx` 一页 ——
 * 而那种假按钮恰恰最可能出现在卡片、布局、边栏这些**没人专门测过**的地方。
 * 这里把范围拉到整个 `src/`。
 *
 * 判据：一个 `<button>` 如果**既没有 onClick、也没有 disabled**，
 * 按下去就不会有任何事发生 —— 而它长得跟能用的按钮一模一样。
 *
 * ⚠️ 三条实现纪律，都是被自己的错教出来的：
 *
 *  ① **按整个标签收，不能按行。**
 *     第一版按行扫，于是
 *         <button
 *           className="…"
 *           onClick={go}     ← 在下一行
 *         >
 *     全被误报，十几个，全是这么来的 —— **判据太松，不是代码有假按钮**。
 *
 *  ② **自检必须走同一条代码路径。**
 *     第一版的自检另写了一份「按行扫」的简化版，于是真扫描器从按行改成
 *     按标签之后，自检那份纹丝不动、照样全绿 ——
 *     「扫描器坏了它还绿」比没有自检更糟。
 *     现在 `findFakeButtons()` 是唯一实现，真扫描和自检都调它。
 *
 *  ③ **自检要有正样本也要有负样本。**
 *     只验「该抓的能抓到」的话，一个「见 button 就抓」的扫描器也能通过。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = 'src'
const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.tsx$/.test(e.name)) files.push(p)
  }
})(ROOT)
files.sort()

/** 剥掉注释，免得注释里出现的 <button 文本被当成真按钮 */
function stripCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
}

/**
 * 唯一的扫描实现。返回 [{ line（1 起）, text }]（line 是相对传入文本的行号）。
 * 真实扫描和自检都调它 —— 任何一处改了逻辑，两边一起变。
 */
export function findFakeButtons(src) {
  const out = []
  const lines = stripCode(src).split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/<button\b/.test(lines[i])) continue
    let tag = lines[i].slice(lines[i].indexOf('<button'))
    let endLine = i
    /*
     * 上限从 12 行放宽到 40：Editor.tsx 那个多选勾选框的标签跨了 16 行，
     * 中间还夹着 6 行解释「为什么挂一个空 handler」的注释 ——
     * 上限 12 时收不到末尾那行 `onClick`，于是把一个**真能用**的按钮
     * 报成了假的。第三次判据太窄。
     *
     * 注释在标签内部同样会被 stripCode 抹成空格，所以不会把注释里的
     * `/>` 当成标签结束 —— 这一点是被下面那条自检钉住的。
     */
    while (!/>$/.test(tag.trim()) && endLine + 1 < lines.length && endLine - i < 40) {
      endLine++
      tag += ' ' + lines[endLine].trim()
    }
    /*
     * 判据是「**有没有挂事件**」，不是「有没有 onClick」。
     *
     * 第二版只认 `onClick=`，于是报了三个假的：FlowchartCard 的连线端口、
     * Editor 的选择框和类型面板 —— 它们分别用 `onPointerDown` / `onMouseDown`，
     * 按下去是真有反应的。**判据太窄，不是代码有假按钮。**
     * React 的事件属性一律是 `on` + 大写字母，所以按形状认就够了，
     * 也不必每加一种事件就来改这里。
     */
    if (/on[A-Z]\w*=/.test(tag)) { i = endLine; continue }
    if (/\bdisabled\b/.test(tag)) { i = endLine; continue }
    if (/type="submit"/.test(tag)) { i = endLine; continue }   // 行为在 form 上
    if (/\{\.\.\./.test(tag)) { i = endLine; continue }        // 透传 props
    out.push({ line: i + 1, text: tag.slice(0, 120) })
    i = endLine
  }
  return out
}

const suspicious = []
let scannedTags = 0
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  const hits = findFakeButtons(src)
  scannedTags += (stripCode(src).match(/<button\b/g) || []).length
  for (const h of hits) suspicious.push({ f, i: h.line, line: h.text })
}

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }

}

console.log('\n== 扫描器自检（走的是同一个 findFakeButtons）==')
ok(findFakeButtons('<button onClick={go}>x</button>').length === 0, '负样本：带 onClick 的不算')
ok(findFakeButtons('<button onPointerDown={go}>x</button>').length === 0,
  '负样本：用 onPointerDown 的不算（连线端口就是这么写的，第二版把它误报了）')
ok(findFakeButtons('<button onMouseDown={go}>x</button>').length === 0,
  '负样本：用 onMouseDown 的不算（编辑器选择框就是这么写的）')
ok(findFakeButtons('<button online={x}>x</button>').length === 1,
  '正样本：`online=` 这类**小写**属性不算事件（别把 onXxx 认得太宽）')
ok(findFakeButtons('<button disabled>x</button>').length === 0, '负样本：明确禁用的不算')
ok(findFakeButtons('<button type="submit">x</button>').length === 0, '负样本：表单提交不算')
ok(findFakeButtons('<button {...rest}>x</button>').length === 0, '负样本：透传 props 不算')
ok(findFakeButtons('// <button>只在注释里</button>').length === 0, '负样本：注释里的不算')
ok(findFakeButtons('<button>x</button>').length === 1, '正样本：光秃秃的 <button> 抓得到')
ok(findFakeButtons('<button\n  className="a"\n>光秃秃，多行</button>').length === 1,
  '正样本：多行写法也抓得到（这条守住「按整标签收」那个修正）')
ok(findFakeButtons('<button\n  className="a"\n  onClick={go}\n>有 onClick</button>').length === 0,
  '负样本：多行写法里的 onClick 也认（第一版就是在这漏的）')
ok(findFakeButtons([
  '<button',
  '  type="button"',
  '  /*',
  '   * 真正干活的是父 div 的 onMouseDown。',
  '   * 这里给个**幂等**的 onClick。',
  '   */',
  '  onClick={(e) => e.stopPropagation()}',
  '/>',
].join('\n')).length === 0,
  '负样本：标签里夹着多行注释、onClick 在最末尾的那一行的，也不算假（Editor 那个勾选框就是这个形状）')
ok(findFakeButtons([
  '<button',
  '  type="button"',
  '  /*',
  '   * 注释里有个 /> 别被当成标签结束',
  '   */',
  '  title="真的没有 handler"',
  '/>',
].join('\n')).length === 1,
  '正样本：标签内注释里的 `/>` 不会提前截断收标签（否则这条会漏）')

console.log(`\n== 全项目扫描（${files.length} 个 tsx / ${scannedTags} 个 <button>）==`)
ok(suspicious.length === 0,
  '没有「能点却没反应」的按钮（既无 onClick 也未禁用）',
  '\n     ' + suspicious.slice(0, 6).map((s) => `${s.f}:${s.i}  ${s.line}`).join('\n     '))

/*
 * 按钮里的**文字**不许有自己的 hover 底色（2026-10-18）。
 *
 * 这是一条源码层就能抓的判据，而它的后果是**纯视觉的**：
 * `.yq-btn-text` 是 `color: inherit`，在主按钮上继承到 `#fff`（白字）；
 * 而它原来的 `:hover` 把背景换成 `--yq-bg-3`（#f0f2f5，接近白）。
 * 于是鼠标一移上去，主按钮中间那几个字**整块消失**，只剩一个白方块
 * （`＋` 图标在 span 外面，所以还看得见）。
 *
 * 为什么值得钉：用户报上来的是「鼠标选中这几个字会变白」——
 * 而真正的原因是「被自己的 hover 底色吃掉了」。
 * 「变白」和「看不见」差着一个可见性，而 hover 与选中的手感也差着一次拖动。
 * 症状离原因太远，所以**在源码层钉住成因**比在浏览器里复现更可靠。
 *
 * ⚠️ 钉的是不变式「文字 span 不自带 hover 底色」，不是「不许有 hover」——
 *    按钮整体该有的 hover（边框、背景、字色）一律不在这条管辖范围内。
 */
{
  const cssFiles = []
  const walkCss = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`
      if (e.isDirectory()) walkCss(p)
      else if (e.name.endsWith('.css')) cssFiles.push(p)
    }
  }
  walkCss('src')

  const offenders = []
  for (const f of cssFiles) {
    /* ⚠️ **必须先剥注释**，否则这条守卫会去检查「文档里有没有提到这个写法」。
     *   第一版没剥，于是我那段「这里原来还有一条 `.yq-btn-text:hover …`」的说明
     *   注释**自己把规则重新触发了一遍** —— 规则已经删掉了，守卫却还是红的。
     *
     *   和 `test-import-ui` 里剥注释同一个坑：
     *   越想解释清楚为什么删，注释里就越会原样引用被删的那行。
     */
    const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    /* `.xxx-text:hover ... { ... background ... }` —— 文字类 span 自带 hover 底色 */
    for (const m of css.matchAll(/(\.[A-Za-z0-9_-]*text[^\s:{]*:hover[^{]*)\{([^}]*)\}/g)) {
      if (/background/.test(m[2])) offenders.push(`${f}  ${m[1].trim()}`)
    }
  }
  ok(offenders.length === 0,
    '没有「文字 span 自带 hover 底色」的规则（白字按钮上会把这几个字吃掉）',
    '\n     ' + offenders.slice(0, 6).join('\n     '))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)