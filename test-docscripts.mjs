/*
 * 文档 ↔ package.json 的**双向**一致性守卫
 * ============================================================
 * 守卫的另外两环早就有了，缺的正是这一环：
 *   · package.json ↔ run-all-tests.mjs 的 SUITES  → runner 里「注册完整性」那一节
 *   · 文档里的项数 ↔ 实际跑的项数               → runner 里「文档核对」那一节
 * 但**没有一环保证文档里写的脚本名真的存在**。
 *
 * 真实踩到的（2026-10-18）：
 *
 *   | `test:runbook-env`    | 5  | … |   ← DEPLOY.md 第 1001 行
 *   | `test:catalog-row-e2e`| 4  | … |   ← DEPLOY.md 第 1002 行
 *
 * package.json 里叫 `test:runbook`，没有 `test:runbook-env`；
 * `test:catalog-row-e2e` 连脚本都没有。两行都是**照着测试文件名想出来的**，
 * 而测试文件名不等于 npm 脚本名。
 *
 * 为什么这两行能一直烂着还没人发现 —— 这是本守卫存在的全部理由：
 *
 * 「文档核对」那一节归一化之后找的是 `npm run testrunbook\s*#\s*(\d+)\s*项`
 * 或 `` `?testrunbook`?\s*\|\s*(\d+)\s*\| ``。DEPLOY 那行归一化出来是
 * `` `test:runbookenv` | 5 | `` —— 名字后面跟的是 `env` 而不是竖线，
 * **正则要求名字后面紧跟分隔符**，于是这一行对核对器**根本不存在**。
 *
 * 后果不是「多了一行错字」：
 *   · 有人照着 `npm run test:runbook-env` 去跑 → 报「没有这个脚本」，白跑；
 *   · 那一行的项数 `5`（真实 13）和 `4`（真实 9）**永远不会有人来对**，
 *     因为核对器看不见它 —— 一个**能自我豁免的错误**。
 *
 * 所以这个守卫查两个方向：
 *   A. 文档里写了、package.json 里没有 → **点不动的条目**（上面那两行）
 *   B. package.json 里有、文档里一个字都没有 → **没人知道的套件**
 *
 * 与「项数核对」为什么不能合并成一个判据：
 * 项数核对是**按名字查数字**的，名字错了它就成了瞎的；
 * 而这里查的是**名字本身**。两个判据各自独立地失败过一次，才值得各有各的。
 */
import fs from 'node:fs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`) }
}

/* ------------------------------------------------------------------
 * 1. package.json 侧：**精确**的套件脚本名
 * ------------------------------------------------------------------ */
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))

/**
 * 一个 npm 脚本算不算「套件」，判据是**它最终跑的那个 .mjs 是不是 test-*.mjs**。
 * 不是靠脚本名以 test: 开头 —— `test:index` 是生成器、`test:all` 是 runner 本身，
 * 两者都以 test: 开头却都不是套件。
 */
/*
 * ⚠️ 这条正则有个**词边界陷阱**，第一版就栽在上面。
 *
 *   /\b(test-[a-z0-9-]+\.mjs)\b/  对上 `node scripts/gen-test-index.mjs`
 *
 * `\b` 认的是「词字符 ↔ 非词字符」的交界，而 `-` 是非词字符 ——
 * 所以 `gen-` 和 `test-` 之间**也有一个词边界**，于是它匹配出
 * `test-index.mjs`，把生成器 `test:index` 当成了一个套件。
 * 后果是 B 方向报了个根本不存在的「没登记的套件」。
 *
 * ⇒ 要求 .mjs 前面必须是**行首或空白**（命令行里命令与参数的分隔），
 *   后面必须是**空白或行尾**。
 * （`run-all-tests.mjs` 里那份同样的正则也有这个问题，
 *   在那儿它只会让一个永不运行的套件查不出项数差，暂时无害，但别复制过去。）
 */
const SUITE_FILE_RE = /(?:^|\s)(test-[a-z0-9-]+\.mjs)(?=\s|$)/

/**
 * 三个集合，用途不同，别混：
 *   · `runnable`   —— 所有 test:* 脚本。A 方向只查「这个名字能不能跑」，
 *                    所以 `test:all`（runner 本身）必须在里面，否则满屏假阳性。
 *   · `suiteScripts` —— 真正会产出一个套件文件的脚本。B 方向查的是「文档里查不到」。
 */
const runnable = new Set() // 脚本名
const suiteScripts = new Map() // 脚本名 → 测试文件名
for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
  if (!name.startsWith('test:')) continue
  runnable.add(name)
  const m = SUITE_FILE_RE.exec(String(cmd))
  if (m) suiteScripts.set(name, m[1])
}

/* ------------------------------------------------------------------
 * 2. 文档侧：两种排版都要认
 *    README 写 `npm run test:x   #  N 项`
 *    DEPLOY 写 | `test:x` | N |
 * ------------------------------------------------------------------ */
const DOCS = ['README.md', 'DEPLOY.md']

/*
 * `YQ_DOC_OVERRIDE=<某份 DEPLOY.md 的路径>` 可以把 DEPLOY 换成别的文件来跑。
 *
 * 存在的理由不是「方便」：收窄 A 方向（只看表格第一格与 `npm run`）之后，
 * 必须能拿**历史上真的坏掉的那份文档**重放一次，证明它照样报得出来 ——
 * 合成样例只能证明「判据对注入的东西有反应」，证明不了它对**真的那个 bug**有反应。
 * 手上正好有修复前的备份，所以这条能力现在就有用。
 */
if (process.env.YQ_DOC_OVERRIDE) DOCS[1] = process.env.YQ_DOC_OVERRIDE

/**
 * 占位符：README 里为了讲「忘了加 SUITES 会怎样」而举的假脚本名。
 *
 * 为什么要留这个口子：README 第 197 行**故意**写着 `npm run test:xxx`
 * 来描述那个坑。把它当成真引用去报，就等于逼人把这段有用的说明改掉。
 *
 * 但口子必须**窄且可数** —— 下面会断言白名单长度不超过 2。
 * 白名单一大，A 方向就退化成「凡是我懒得列的都算占位符」。
 */
const isPlaceholder = (n) => /^test:[x<][A-Za-z0-9_]*$/i.test(n)
const PLACEHOLDERS_ALLOWED = 2

/**
 * 一行里**哪些名字算「可点跑的条目」** —— 只认两种：
 *   ① `npm run test:x`（能直接粘到终端）
 *   ② 表格行**第一格**里的名字（清单表的名字列）
 *
 * ⚠️ 第一版扫的是「整行里所有反引号包着的 test:*」，结果它把**它自己那一行文档**
 * 判成了坏引用：DEPLOY 里新增的那条 `test:docscripts` 说明中，
 * 正好引用了 `test:runbook-env` / `test:catalog-row-e2e` 这两个**反例**。
 *
 * 与「源码层守卫必须剥注释」是同一族：判据扫进了**散文**，
 * 而散文里提到一个名字，不等于文档承诺了「照它能跑」。
 * 按散文去要求存在，等于逼着人把解释错误的段落删掉 ——
 * 那是在用判据惩罚正确的文档。
 *
 * 收窄之后仍然抓得住真正的问题：那两行错名字都在**清单表的第一格**里。
 */
const entryNames = (line) => {
  const found = new Set()
  for (const m of line.matchAll(/npm run (test:[A-Za-z0-9_-]+)/g)) found.add(m[1])
  if (/^\s*\|/.test(line)) {
    const firstCell = line.split('|')[1] || ''
    for (const m of firstCell.matchAll(/`(test:[A-Za-z0-9_-]+)`/g)) found.add(m[1])
  }
  return found
}

const refs = [] // { file, line, name }
const docText = {}
for (const f of DOCS) {
  const raw = fs.readFileSync(f, 'utf8')
  docText[f] = raw
  raw.split('\n').forEach((line, i) => {
    for (const n of entryNames(line)) refs.push({ file: f, line: i + 1, name: n })
  })
}

/* ------------------------------------------------------------------
 * 3. 两个方向的判据（写成纯函数，好让下面做破坏对照）
 * ------------------------------------------------------------------ */

/** A：文档里引用了、package.json 里没有的脚本名（精确比对，不做前缀/归一化） */
const badRefs = (texts, names) => {
  const out = []
  for (const [file, raw] of Object.entries(texts)) {
    raw.split('\n').forEach((line, i) => {
      for (const n of entryNames(line)) {
        if (isPlaceholder(n)) continue
        if (!names.has(n)) out.push({ file, line: i + 1, name: n })
      }
    })
  }
  return out
}

/** B：package.json 里有、文档里一个字都没提的套件 */
const undocumented = (names, texts) => {
  const blob = Object.values(texts).join('\n')
  return [...names.keys()].filter((n) => {
    if (blob.includes('`' + n + '`')) return false
    if (blob.includes('npm run ' + n)) return false
    return !new RegExp('npm run ' + n + '(?![A-Za-z0-9_-])').test(blob)
  }).sort()
}

/* ==================================================================
 * 断言
 * ================================================================== */
console.log('\n== 先确认解析器不是空的 ==')
/*
 * 「后面每一条都是恒真」的防线。
 * 上一轮踩过：孤儿浏览器那条守卫因为时间戳写法错，恒为假 —— 安静地什么也没验。
 * 这次正着来：如果这两个集合解析不出来，A/B 两条判据会**同时变成空转**
 * （没有名字可比 = 没有错可报 = 全绿），而那正是本守卫最坏的失败方式。
 */
ok(suiteScripts.size >= 100,
  `package.json 里认出 ${suiteScripts.size} 个套件脚本（>= 100 —— 认少了后面每条都是空转）`)
ok(refs.length >= 100,
  `两份文档里认出 ${refs.length} 处脚本引用（>= 100 —— 认少了同上）`)
const placeholders = [...new Set(refs.map((r) => r.name).filter(isPlaceholder))]
ok(placeholders.length <= PLACEHOLDERS_ALLOWED,
  `占位符白名单只有 ${placeholders.length} 个（<= ${PLACEHOLDERS_ALLOWED}）：${placeholders.join('、') || '无'} —— 多了就等于「凡是没列的都当占位符」`)

console.log('\n== A 方向：文档里写的脚本名必须真的能跑 ==')
const bad = badRefs(docText, runnable)
ok(bad.length === 0,
  `文档里没有指向不存在脚本的条目（查出 ${bad.length} 处）`,
  bad.map((b) => `${b.file}:${b.line} \`${b.name}\``).join('；'))

console.log('\n== B 方向：每个套件都得在文档里有登记 ==')
const undoc = undocumented(suiteScripts, docText)
ok(undoc.length === 0,
  `没有「跑得起来但文档里查不到」的套件（查出 ${undoc.length} 个）`,
  undoc.join('、'))

console.log('\n== C 方向：光有文件的测试不会被任何环节发现 ==')
/*
 * runner 里那道「注册完整性」已经查了 package.json ↔ SUITES 的**两个方向**，
 * 但两个方向都建立在「已经有脚本或有登记」的前提上 ——
 * **一个既没有 npm 脚本、也没进 SUITES 的 test-*.mjs，两边都看不见它**。
 *
 * README 第 197 行记的正是这一族：加了 `npm run test:xxx` 却忘了加 SUITES，
 * 「那个套件从此一次都不会跑，而全套是绿的」。那次至少还有脚本可以提醒人；
 * 连脚本都没加的话，连提醒都没有。
 */
const runnerSrc = fs.readFileSync('run-all-tests.mjs', 'utf8')
const arrBody = /const SUITES = \[([\s\S]*?)\n\]/.exec(runnerSrc)
const suiteFiles = arrBody ? [...arrBody[1].matchAll(/'([^']+\.mjs)'/g)].map((m) => m[1]) : []
ok(suiteFiles.length >= 100,
  `从 run-all-tests.mjs 里解析出 ${suiteFiles.length} 个 SUITES 条目（>= 100 —— 解析不出来 C 方向就是空转）`)

const rootTestFiles = fs.readdirSync('.').filter((f) => /^test-[a-z0-9-]+\.mjs$/.test(f))
const registered = new Set([...suiteFiles, ...suiteScripts.values()])
const orphans = rootTestFiles.filter((f) => !registered.has(f))
ok(rootTestFiles.length >= 100,
  `根目录认出 ${rootTestFiles.length} 个 test-*.mjs（>= 100 —— 同上）`)
ok(orphans.length === 0,
  `没有「既没脚本也没登记」的孤儿测试文件（查出 ${orphans.length} 个）`,
  orphans.join('、'))

console.log('\n== 破坏对照：判据真的会红吗 ==')
/*
 * 不能拿「现在恰好一个都没查出来」当通过。
 *
 * 实测教训（2026-10-18）：孤儿浏览器守卫写完，第一次验的时候本机正好一个
 * `chrome` 进程都没有，于是「命中数 0」看起来像通过，其实那版过滤条件
 * 一个进程都没验到。后来把进程名临时换成有 71 个的 `msedge` 才验出它真的会咬人。
 *
 * 所以这里**主动造一个它该命中的样本**：往文档文本里塞一个不存在的脚本名，
 * 判据必须报出来；再造一个「文档里没有的套件」，B 方向也必须报出来。
 * 两条都红，这一轮的绿才有意义。
 */
{
  // ⚠️ canary 的名字必须长得**像真脚本名**。第一版注入的是
  // `__test_docscripts_canary__`（没有 `test:` 前缀），
  // 结果一条都没报出来 —— 而「什么都没报」正是判据失效的样子。
  // 是这条 canary 自己把这个问题喊出来的，不是靠肉眼看出 A 方向全红
  // （那 29 条里全是真的假阳性，混在一起根本分不出谁没验成）。
  const fake = 'test:__docscripts_canary__'
  // 两种形态都要验：`npm run` 命令，与**清单表第一格**（真正出问题的那两行就是这种）
  const poisoned = {
    ...docText,
    'README.md': docText['README.md'] + `\n\n\`npm run ${fake}\` —— 故意放的\n`,
    'DEPLOY.md': docText['DEPLOY.md'] + `\n| \`${fake}\` | 3 | 故意放的一行 |\n`,
  }
  const hitA = badRefs(poisoned, runnable)
  ok(hitA.some((h) => h.name === fake),
    `A 方向认得出假名字（命令形态 + 表格形态，注入 \`${fake}\` → 报出 ${hitA.length} 处，含它：${hitA.some((h) => h.name === fake)}）`)
}
{
  const ghost = 'test:__docscripts_ghost__'
  const ghostScripts = new Map(suiteScripts)
  ghostScripts.set(ghost, 'test-docscripts-ghost.mjs')
  const hitB = undocumented(ghostScripts, docText)
  ok(hitB.includes(ghost),
    `B 方向认得出没登记的套件（注入 ${ghost} → 报出 ${hitB.length} 个，含它：${hitB.includes(ghost)}）`)
}
{
  /*
   * 反向对照：把**真存在的**脚本名塞进文档，B 方向必须**不再**报它。
   * 只验「会红」不够 —— 一个永远红的判据跟没有判据一样坏，
   * 所以要同时验它在该绿的时候能绿。
   */
  const [real] = [...suiteScripts.keys()]
  const withReal = { ...docText, 'README.md': docText['README.md'] + `\n\nnpm run ${real}\n` }
  const stillBad = badRefs(withReal, runnable)
  ok(!stillBad.some((b) => b.name === real),
    `真名 ${real} 塞进文档不会被误报成坏引用`)
}
{
  // C 方向的对照：造一个「有文件、没脚本也没登记」的孤儿，看它报不报得出来。
  const ghostFile = 'test-docscripts-orphan-canary.mjs'
  const orphanHit = [...rootTestFiles, ghostFile].filter((f) => !registered.has(f))
  ok(orphanHit.includes(ghostFile),
    `C 方向认得出孤儿测试文件（注入 ${ghostFile} → 报出 ${orphanHit.length} 个，含它：${orphanHit.includes(ghostFile)}）`)
}

/*
 * ⚠️ 汇总行**必须**写成 `结果：N 通过 / M 失败`。
 *
 * 第一版写成 `12 通过 / 0 失败`，runner 直接判失败：
 *   `FAIL test-docscripts.mjs  没找到汇总行「结果：N 通过 / M 失败」，项数没计进总数`
 * 而它跑在浏览器里、8 条断言全过 —— 也就是说这一套的**判定完全取决于这一行的格式**。
 * 约定在 run-all-tests.mjs:997：`/结果：(\d+) 通过 \/ (\d+) 失败/`。
 */
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
