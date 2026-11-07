/*
 * 导入的入口形态与进度反馈（2026-10-16 照真实语雀补的）
 *
 * ------------------------------------------------------------
 * ① 形态：语雀是「一个入口 → 选格式」，我们原来是设置页里**一排 5 个导入按钮**。
 *    六个平级按钮（Markdown / zip / Word / Excel / 语雀库 / 数据包）看着齐，
 *    实际上用户根本不知道该点哪个 —— **入口多不等于好找**。
 *
 * ② 进度：语雀 5 态（等待/上传/处理/失败/成功）。我们**没有「上传」这一态** ——
 *    解析在浏览器里做，文件根本没离开本机。
 *    照抄一个「上传 xx%」就是**说一个不存在的过程**，和这个项目一直在清的
 *    假动作是同一类。所以只报能说真话的：解析中 / 写入中 N/M。
 */
import { readFileSync, readdirSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (c, l, e = '') => { if (c) { pass++; console.log(`  PASS  ${l}`) } else { fail++; console.log(`  FAIL  ${l} ${e}`) } }

/** 剥注释，否则下面那些「刻意不这么写」的说明会被当成代码命中 */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const src = readFileSync('src/pages/Settings.tsx', 'utf8')
const IMP = 'src/components/doc/ImportDialog.tsx'
const imp = readFileSync(IMP, 'utf8')
const code = strip(src)
const impCode = strip(imp)

/**
 * 只扫「导入」真的可能在的两个文件。
 *
 * ⚠️ 判据不能钉死「实现住在哪个文件」—— 2026-10-18 就被这条反过来咬了一次：
 * 那天这套导入从 Settings.tsx 搬进了 ImportDialog.tsx（为了让目录树能原地弹框），
 * 而下面原本有四条判据是直接读 Settings.tsx 的，于是**整套安静退化成什么都没验**。
 *
 * 「套件绿」不等于「它跑到了那条断言」—— 这里改成扫两个文件，
 * 真正要钉的是**只有一份实现**，不是它住在哪。
 */
const both = code + '\n' + impCode

console.log('\n== 只有一个导入入口 ==')
{
  ok(/setImpOpen\(true\)/.test(code), '设置页有一个「导入…」入口')
  const rows = [...code.matchAll(/<Row\s+label="([^"]*)"/g)].map((m) => m[1])
  ok(rows.filter((r) => r.startsWith('导入')).length === 1,
    '设置页只有「导入」一行 —— 同一个格式不许有两个入口',
    JSON.stringify(rows.filter((r) => r.startsWith('导入'))))

  const picker = /function ImportPicker[\s\S]*?\n}\n/.exec(impCode)?.[0] || ''
  ok(picker.length > 0, '格式选择器组件在')
  const items = /const ITEMS[^=]*=\s*\[([\s\S]*?)\n  \]/.exec(picker)?.[1] || ''
  const picks = [...items.matchAll(/k: '(\w+)'/g)].map((m) => m[1])
  ok(picks.length === 6, `六种格式都在（实得 ${picks.length}）`, JSON.stringify(picks))
  ok(/md/.test(picks) && /zip/.test(picks) && /docx/.test(picks) && /sheet/.test(picks) && /lake/.test(picks) && /bundle/.test(picks),
    'Markdown / zip / Word / Excel / 语雀库 / 数据包 六个都在', JSON.stringify(picks))
  ok(/不支持/.test(picker), '选择器里也写了不支持的三种（不是藏起来）')
}

console.log('\n== 只有一份实现（抄一遍就是必漏一处）==')
{
  /*
   * 这条是这次改动真正要防的东西。
   *
   * 目录树与设置页**各自**需要一个入口，但底下**只能有一份**导入实现。
   * 判据不写「住在哪个文件」，只写「有几个文件声明了它」——
   * 这样以后再搬一次家也不用改判据，而真抄了第二份立刻会红。
   */
  const srcFiles = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = d + '/' + e.name
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name)) srcFiles.push(p)
    }
  }
  walk('src')
  const defines = (needle) => srcFiles.filter((f) => strip(readFileSync(f, 'utf8')).includes(needle))
  for (const [name, needle] of [
    ['ImportPicker', 'function ImportPicker'],
    ['ImportProgress', 'function ImportProgress'],
    ['ImportDialog', 'export function ImportDialog'],
  ]) {
    const hit = defines(needle)
    ok(hit.length === 1 && hit[0] === IMP, `${name} 全项目只声明一次（在 ${IMP.replace('src/', '')}）`,
      `实得：${JSON.stringify(hit)}`)
  }
  // 落库建库也只能有一处
  const creators = srcFiles.filter((f) => {
    const c = strip(readFileSync(f, 'utf8'))
    return /createBook\(/.test(c) && /ImportDialog|resolveTarget/.test(c)
  })
  ok(creators.length === 1, '导入路径里的 createBook 只有一处（resolveTarget）', JSON.stringify(creators))
}

console.log('\n== 进度反馈 ==')
{
  ok(/function ImportProgress/.test(impCode), '有进度条组件')
  ok(/解析中/.test(impCode) && /写入中/.test(impCode), '两态都在：解析中 / 写入中')
  /*
   * 「上传中」**不能**作为进度态出现 —— 文件根本没离开本机，报它是编的。
   *
   * ⚠️ 判据只认「上传中」这个**具体的态名**，不能只判「上传」两个字：
   * 代码里有「头像上传失败」「上传中…」(头像那个)、
   * 「图片不跟着上传」等等正当用法 —— 一律扫进去会变成
   * 「为了绿而改代码」。
   */
  ok(!/上传中(?!…)/.test(both), '**没有**「上传中」这个进度态 —— 文件没离开本机，报它是编的')
  ok(/onProgress\?\.\(made, total\)/.test(impCode), 'Markdown 系落库会逐篇报进度')
  ok(/onProgress\?\.\(made, payloads\.length\)/.test(impCode), '表格落库会逐篇报进度')
  const uses = (impCode.match(/<ImportProgress prog=\{prog\} \/>/g) || []).length
  ok(uses >= 4, `${uses} 个导入弹窗里放了进度条（Markdown / Word / zip / 表格）`)
  const clears = (impCode.match(/setProg\(null\)/g) || []).length
  ok(clears >= 4, `${clears} 处结束时清掉进度（不留在屏幕上）`)
  ok(/data-testid="import-progress"/.test(impCode), '进度条有 testid（浏览器套件能验）')
}

console.log('\n== 入口位置：侧栏 ＋ 菜单（实测语雀），且**原地弹框** ==')
{
  const tree = readFileSync('src/components/doc/Tree.tsx', 'utf8')
  const treeCode = strip(tree)

  // 语雀侧栏 ＋ 菜单的实测项序（2026-10-16 量到的）：
  //   文档/表格/画板/数据表 ── 从模板新建… / 导入… / AI 帮你写 ── 新建分组 / 添加链接
  const menuIdx = treeCode.indexOf('从模板新建…')
  ok(menuIdx > 0, '侧栏 ＋ 菜单里在同一个菜单里排了「从模板新建…」')

  const impIdx = treeCode.indexOf('导入…')
  ok(impIdx > 0, '侧栏 ＋ 菜单里有「导入…」这一项（**这就是语雀的位置**）', String(impIdx))
  ok(menuIdx >= 0 && impIdx > menuIdx,
    '项序照语雀：从模板新建… 在前，导入… 在后',
    `从模板=${menuIdx} 导入=${impIdx}`)

  ok(/AI 帮你写/.test(treeCode) === false,
    '**没有**「AI 帮你写」—— 本项目无 AI 能力，摆一项点下去什么都不发生就是假动作')

  /*
   * ⚠️ 这条判据 2026-10-18 改过一次方向，而**原来那条钉的是错的行为**：
   * 它当时断言 `settings?tab=data&import=1` 必须存在 ——
   * 也就是「点导入必须跳去设置页」被写成了硬要求。
   * 那是回避不是解决：用户站在某个库的目录里要点导入，却被换个页面，
   * 落地时已经不知道自己刚才在哪个库。
   * 判据固化了一个错误行为，比没有判据更难拆 —— 现在钉的是正确行为。
   */
  ok(/settings\?tab=data&import=1/.test(treeCode) === false,
    '侧栏导入**不再**跳设置页（点了就换页面，落地时已经不知道刚才在哪个库）')
  ok(/<ImportDialog/.test(treeCode), '侧栏就地渲染 ImportDialog（和设置页同一份实现）')
  ok(/targetBookId=\{bookId\}/.test(treeCode),
    '并且把当前 bookId 传下去 —— 不传就会新建一个库，「在书 A 里导入、落进书 B」')

  // 设置页那一处入口复用同一个组件，而不是自己留一份
  ok(/<ImportDialog/.test(code), '设置页也渲染同一个 ImportDialog')
  ok(/onResult=\{setImportInfo\}/.test(code), '设置页接结果文案（导入完在「导入」那行下面说结果）')

  // 深链仍然认，但只是顺带
  ok(/sp\.get\('import'\)/.test(src) && /setImpOpen\(true\)/.test(src),
    '设置页仍认 ?import=1 深链')
  ok(/sp\.get\('tab'\)/.test(src), '设置页认 ?tab= 跳页签')
  ok(/n\.delete\('import'\)/.test(src),
    '用完就把参数从 URL 抹掉（否则按「后退」弹窗会自己再弹出来）')
}

console.log('\n== 落到哪个库：写在界面上，不靠用户猜 ==')
{
  /*
   * 这个框在两处出现而**落点不同**（当前库 / 新建一个库）。
   * 不写出来，用户只能导完之后翻遍知识库列表才知道东西去哪了。
   */
  ok(/targetHint/.test(impCode), '选择器带 targetHint')
  ok(/data-testid="import-target"/.test(impCode), '那一行有 testid（浏览器套件能验）')
  ok(/导入到哪里/.test(impCode), '界面上有一行说明落到哪')
  ok(/当前知识库/.test(impCode) && /新建一个知识库/.test(impCode),
    '两种落点都写出来了（当前库 / 新建一个）')
  // 建库只在 resolveTarget 一处，且那里才判空串
  const creates = (impCode.match(/createBook\(/g) || []).length
  ok(creates === 1, `导入路径里 createBook 只出现一次（实得 ${creates}）`)
  ok(/if \(targetBookId\) return targetBookId/.test(impCode),
    '有目标库时直接用它，不建新库')

  /*
   * `books` 是**数组**（`Book[]`），不是按 id 索引的字典。
   *
   * ⚠️ 2026-10-18 真机实测翻过一次车：写成 `books[targetBookId]?.name || '未命名'`，
   * 数组用字符串下标取不到东西 → 落进硬编码兜底 → 界面**自信地显示一个假名字**
   * （真书名叫「导入的 Word 文档」，提示却写「『未命名』」）。
   *
   * 一个写死的兜底比没有兜底更坏：没有的时候至少知道自己没查到。
   */
  ok(/books\[targetBookId\]/.test(impCode) === false,
    '没有把 books 当字典下标取（它是数组）')
  ok(/books\.find\(b => b\.id === targetBookId\)|books\.find\(\(b\) => b\.id === targetBookId\)/.test(impCode),
    '按 id 用 find 查书名（数组只能这么查）')
  ok(!/\.name \|\| ['"]/.test(impCode),
    '书名没有「查不到就编一个」的兜底 —— 编出来的名字会被当成真的')
}

console.log('\n== 弹窗关掉之后还能再开 ==')
{
  /*
   * ⚠️ 2026-10-18 真机实测踩过，且症状极隐蔽：
   * 格式选择器关闭时只 `setPickOpen(false)`、**不通知调用方**，
   * 于是调用方的 `open` 停在 `true`、组件里的 `wasOpen.current` 也停在 `true`。
   * 用户第二次点「导入…」时 `setImpOpen(true)` 是空操作，
   * `open` 没变 → effect 不跑 → **弹窗再也不开**。
   *
   * 「第一次能开、之后永远没反应」，而控制台一句错都没有。
   * 这类缺陷纯静态看不出来，但只要把「关掉再开」钉住就不会再犯。
   */
  ok(/onClose=\{\(\) => \{ setPickOpen\(false\); onClose\(\) \}\}/.test(impCode),
    '选择器关闭时同时清自己的状态**并**通知调用方')
  ok(/setPickOpen\(true\)/.test(impCode) && /if \(open && !wasOpen\.current\)/.test(impCode),
    '从外面打开才重置选择器（不是每次重渲染都重置）')
}

console.log('\n== 不支持的格式写在界面上 ==')
{
  ok(/暂不支持的导入格式/.test(src), '设置页那一行还在')
  ok(/\.doc/.test(src) && /\.xls/.test(src) && /Evernote/.test(src), '三个不支持的都点名了')
  const reasons = [...src.matchAll(/第三方依赖|数据模型|二进制私有格式/g)].length
  ok(reasons >= 2, `${reasons} 处写了「为什么不支持」，不只是列名字`)
}

console.log('\n== 别的套件不许还指着旧按钮 ==')
{
  /*
   * 入口改名那天，`test-create-denied` 直接红了；而 `test-lakebook`
   * **照样绿** —— 因为它那条 `waitForSelector('button:has-text("选择 .lakebook 文件")')`
   * 所在分支在那一轮根本没走到。
   *
   * 也就是说：**「套件绿」不等于「它跑到了那条断言」**。
   * 所以这里加一条静态扫描：旧按钮文案不许再出现在任何套件里，
   * 而不只是「跑到的那几条会红」。
   */
  const STALE = ['选择文件夹', '选择文件导入', '选择 .docx 文件', '选择 zip 文件', '选择表格文件', '选择 .lakebook 文件']
  const files = [
    'test-create-denied.mjs', 'test-import-md.mjs', 'test-mdimport-e2e.mjs',
    'test-lakebook.mjs', 'smoke-io.cjs',
  ]
  for (const f of files) {
    let t = ''
    try { t = readFileSync(f, 'utf8') } catch { ok(false, `${f} 读不到`); continue }
    // 剥掉注释后再扫：这几处**故意**在注释里引用旧文案来解释为什么改的
    const code = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    const hit = STALE.filter((w) => code.includes(w))
    ok(hit.length === 0, `${f} 不再用旧按钮文案`, hit.join(' | '))
  }
  // 新入口应该在这几个套件里都出现
  for (const f of ['test-create-denied.mjs', 'test-import-md.mjs', 'test-mdimport-e2e.mjs', 'test-lakebook.mjs', 'smoke-io.cjs']) {
    let t = ''
    try { t = readFileSync(f, 'utf8') } catch { continue }
    ok(t.includes('导入…') && t.includes('.yq-imppick-item'),
      `${f} 走的是新的两步入口（导入… → 格式选择器）`)
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
