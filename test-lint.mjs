/* ============================================================
   服务端源码的静态体检
   ------------------------------------------------------------
   这不是「代码风格」检查，是挡一类**只在运行时才炸**的错误：

   1. **模板字符串里的反引号**。SQL 写在 `db.exec(\`...\`)` 里，
      而注释里随手写一个 `GET /api/doc/:id` 的反引号就会提前闭合字符串，
      后面的 SQL 全变成 JS 语法错误。`tsc` 与 `vite build` 都发现不了
      （服务端是 .ts，tsc 只编译 src/），只有 `node server/index.ts` 会炸。
   2. **BOM**。PowerShell 的 `Set-Content -Encoding UTF8` 会写 BOM；
      tsc/vite 都能过，Docker 里的 `npm run build` 直接失败。

   两个都踩过，所以做成检查，别再靠人记。
   ============================================================ */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const SERVER_DIR = 'server'
const SRC_DIR = 'src'
const SCAN_EXT = new Set(['.ts', '.tsx', '.mjs', '.cjs', '.js', '.css', '.json', '.md', '.yml', '.html'])

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (SCAN_EXT.has(extname(p))) out.push(p)
  }
  return out
}

/** 找出被反引号包起来的代码块，检查块内有没有落单的字符串边界 */
/**
 * 从 `from` 位置开始，找下一个模板字符串开引号并检查它有没有正常闭合。
 *
 * 原先这里只查每个文件的**第一处** db.exec( / db.prepare(` ——
 * 而一个文件里通常有几十处。于是除了第一条 SQL，其余全是盲区：
 * 在 SQL 注释里写个反引号（\`changes\`）就会把模板字符串截断，
 * 服务直接起不来，错误信息还指向一个毫不相干的位置。
 * 所以必须**逐处**查。
 */
function strayBackticksInTemplateFrom(src, from) {
  const open = src.indexOf('`', from)
  if (open < 0) return null
  // 开引号后面先确认这确实是个 SQL 模板（前面是 exec( 或 prepare(）
  const before = src.slice(Math.max(0, open - 30), open)
  if (!/db\.(exec|prepare)\(\s*$/.test(before)) return null
  let i = open + 1
  let brace = 0          // ${ } 嵌套深度
  while (i < src.length) {
    const ch = src[i]
    if (ch === '\\') { i += 2; continue }
    if (ch === '$' && src[i + 1] === '{') { brace++; i += 2; continue }
    if (ch === '}') { if (brace > 0) brace--; i++; continue }
    /**
     * 在 `${ ... }` 里的反引号属于**嵌套模板**，不是外层的闭合。
     * 不跟踪这一层就会把
     *   db.exec(`... ${ xs.map((c) => `${c} = ?`).join(' AND ') } ...`)
     * 里内层的开引号误当成闭合 —— 这段是合法的，且 server/sync.ts 里就有。
     */
    if (brace > 0) { i++; continue }
    if (ch === '`') {
      /**
       * 闭合反引号后面**必须**紧跟 ) , ; . （可夹空白）。
       *
       * 这一条是整套检查的关键。早先只判断「找到闭合反引号就算正常」，
       * 于是在 SQL 注释里写 `changes` 这种代码标记时，
       * 第一个反引号就把模板**提前闭合**了 —— 扫描器看着是配对的，
       * 实际文件已经坏了：服务起不来，报错还指在一个毫不相干的位置。
       *
       * 顺带一提 `node --check` 对这种文件**判它是合法的**（实测 EXIT=0），
       * 而运行时 strip-types 会抛 ERR_INVALID_TYPESCRIPT_SYNTAX。
       * 所以只能靠这条规则，不能指望解析器。
       */
      const after = src.slice(i + 1).match(/^\s*([),;.]|=>)/)
      if (!after) {
        return src.slice(Math.max(0, i - 50), i + 20) + '  <@line ' + (src.slice(0, i).split('\n').length)
      }
      return null            // 正常闭合
    }
    i++
  }
  // 扫到文件尾还没闭合 —— 那就是真的没闭合
  return `模板一直到文件尾都没闭合（line ${src.slice(0, open).split('\n').length} 起）`
}

console.log('\n== 模板字符串里的落单反引号 ==')
let checkedTotal = 0
for (const f of walk(SERVER_DIR)) {
  const src = readFileSync(f, 'utf8')
  // 逐处扫，不是只看第一处
  let pos = 0, checked = 0, bad = null
  while (pos < src.length && !bad) {
    const next = src.indexOf('db.', pos)
    if (next < 0) break
    const b = strayBackticksInTemplateFrom(src, next)
    if (b) bad = b
    else { checked++; pos = next + 3; continue }
  }
  if (bad) ok(false, `${f} 里 db.exec/db.prepare 的 SQL 模板有落单反引号`, `…${bad}…`)
  checkedTotal += checked
}
ok(true, `所有 db.exec / db.prepare 模板块的边界正常（共查 ${checkedTotal} 处）`)

console.log('\n== BOM ==')
/**
 * 根目录下要一起检查的文件：**排除 node_modules**。
 *
 * 原来只按 `p.includes('test-')` 过滤，而
 * `node_modules/@types/react-dom/test-utils/index.d.ts` 的**路径里正好有 `test-`**
 * —— 于是第三方依赖的 .d.ts 一直混在「源码」里被扫。
 * BOM / 控制字符扫它们只是浪费，而任何按内容判断的检查都会在它们身上误报
 * （第 8 条检查「注释行里不许藏着代码」就是这么被 `node_modules` 里的
 * 一段第三方注释带偏的）。依赖里的东西不由我们负责，也改不动。
 */
const rootFiles = walk('.', []).filter((p) =>
  !p.includes('node_modules') && !p.includes(`${sep}dist${sep}`) && !p.includes(`${sep}data${sep}`)
    && (p.includes('test-') || p === 'package.json' || p === 'Dockerfile' || p === 'run-all-tests.mjs'))
const all = [...walk(SERVER_DIR), ...walk(SRC_DIR), ...rootFiles]
let bomFiles = []
for (const f of all) {
  const b = readFileSync(f)
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) bomFiles.push(f)
}
ok(bomFiles.length === 0, `源码与配置文件都没有 BOM（${all.length} 个文件）`, bomFiles.join(', '))

console.log('\n== 乱码替换字符 U+FFFD ==')
/**
 * U+FFFD 是 Unicode 的「替换字符」，也就是解码失败时留下的那个问号方块。
 *
 * 它的危险在于**不报错**：代码照样编译、服务照样起，
 * 只是那句话里少了一个字。实测中它已经吃掉过用户可见的文案：
 * 导入高版本数据包时，报出来的是「数据?版本」——「包」这个字没了，
 * 用户就在界面上看到一个方块。注释里也散落着若干处读不通的句子，
 * 会持续误导下一个改代码的人。
 *
 * 跟 BOM 检查并排放在一起：两者都是「某个工具链环节把字节搞坏了」，
 * 而破坏本身没有任何一处会主动报警 —— 所以只能靠扫。
 *
 * 注意：本注释刻意不写那个字符的字面量，否则这条检查会先把自己判为失败。
 */
{
  const bad = []
  for (const f of all) {
    const lines = readFileSync(f, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (line.includes('\uFFFD')) bad.push(`${f}:${i + 1}  ${line.trim().slice(0, 60)}`)
    })
  }
  ok(bad.length === 0, `源码里没有乱码替换字符（${all.length} 个文件）`, bad.join('  |  '))
}

console.log('\n== 点了只弹一句提示、什么都没做的按钮 ==')
/**
 * 一个 `onClick` 里**只有** `toast(...)`、没有任何别的事 ——
 * 那这个按钮点下去不会改变任何状态，却长得像个能用的控件。
 *
 * 这个项目里这一类出现过好几次，而且是**同一个形状**：
 *   · 「保存修改」弹「资料已保存」—— 三个输入框改的是组件局部 state，
 *     服务端压根没有改资料的接口；
 *   · 「查看回收站（N）」弹「回收站中有 N 个文档」—— **不跳转**，
 *     而 `/trash` 页面就在那儿。
 *
 * 它们的共同点：界面上给了肯定的反馈（绿色 toast），
 * 而实际上什么都没发生。这比「按钮点了没反应」更糟 ——
 * 后者用户知道坏了，前者用户以为成功了。
 *
 * **只查 toast 打头的那种**：`onClick={() => { doThing(); toast('…') }}`
 * 是正常的（先做事再提示），不在这里报。
 *
 * 判据写死成「零容忍」而不是白名单：宁可有人来加一条说明，
 * 也不要默默放过一个。想豁免就把那行改成先做点事 —— 或者在
 * ALLOW 里写清楚为什么它本来就该只弹提示。
 *
 * ============================================================
 * 2026-10-12：这条判据改过一次实现方式，两个坑都记在这
 * ------------------------------------------------------------
 * ① **正则扫全文会跨出处理器。**
 *    原来是 `/onClick=\{\(\)\s*=>\s*\{?\s*(?:\{[\s\S]*?\}\s*)?toast\(/g`，
 *    `[\s\S]*?` 能吃花括号，于是匹配可以从某个 `onClick={() => {` 一路跨到
 *    **几百行之后**的某个 `}` + `toast(`，报出来的是另一个按钮。
 *    实测：给「新建知识库」加判空提示之后，这条报的是
 *    `Dashboard.tsx:292` 的「清空筛选」—— 那个按钮本来就该那么写。
 *
 * ② **收窄成 `[^{}]*?` 能消掉假阳性，但同时把真阳性也丢了**
 *    （`onClick={() => { toast('…') }}` 与它的多行写法都漏）。
 *    拿漏报换假阳性不算修好 —— 那条规则存在的意义就是抓后者。
 *
 * 所以最终**不用正则扫全文**：先按花括号配平取出那个处理器**自己的**体，
 * 再判断这个体是不是**只有一句 toast**。配平不可能跑出处理器，
 * 也没有「少写一个字符就漏掉」这类脆弱性。
 *
 * 判据红不等于代码错：看到它报一条读起来莫名其妙的**位置**，
 * 第一件事是把匹配到的原文打出来看，而不是去改那行代码。
 * ============================================================
 */
{
  const ALLOW = []

  /** 从 `=>` 之后开始，返回这个处理器**自己的**体（不含最外层花括号）；取不到就 null */
  const handlerBody = (src, from) => {
    let i = from
    while (i < src.length && /\s/.test(src[i])) i++
    if (src[i] !== '{') return null          // 表达式体，形如 `() => toast(...)`
    let depth = 0
    for (let j = i; j < src.length; j++) {
      if (src[j] === '{') depth++
      else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(i + 1, j) }
    }
    return null
  }

  const bad = []
  for (const f of walk(SRC_DIR)) {
    if (!/\.tsx?$/.test(f)) continue
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/onClick=\{\(\)\s*=>/g)) {
      const body = handlerBody(src, m.index + m[0].length)
      // 取不到体 = 表达式体；那种直接看后面是不是一句 toast
      const text = body === null
        ? src.slice(m.index + m[0].length).match(/^\s*toast\(/)
        : /^\s*toast\([\s\S]*\);?\s*$/.test(body)
      if (!text) continue
      const line = src.slice(0, m.index).split('\n').length
      if (ALLOW.includes(`${f}:${line}`)) continue
      bad.push(`${f}:${line}`)
    }
  }
  ok(bad.length === 0, `没有「只弹提示、什么都不做」的按钮（扫了 ${walk(SRC_DIR).length} 个文件）`, bad.join('  '))

  /**
   * 这条判据自己得先证明会咬（2026-10-12）。
   *
   * 上一版规则坏掉的时候，输出是**「52 通过 / 1 失败」**——
   * 它照样在跑、照样在计数，只是抓的是别的按钮。
   * 而如果我把它「修」成抓不到任何东西，它会变成 53 通过 / 0 失败，
   * 看起来比修好还绿。
   *
   * 所以这里自带一份正反样例：真的会咬的必须被咬到，不该咬的必须放过。
   */
  const shouldBite = [
    `onClick={() => toast('已复制')}`,
    `onClick={() => { toast('已复制') }}`,
    `onClick={() => {\n  toast('已复制')\n}}`,
  ]
  const shouldNotBite = [
    `onClick={() => { save(); toast('好了') }}`,
    `onClick={() => { setFType(''); setFBook(''); setFAuthor('') }}`,
    `onClick={() => {\n const id = createBook(s, 1)\n if (!id) { toast('只有空间管理员', 'error'); return }\n toast('已创建')\n navigate(id)\n}}`,
  ]
  const bites = (s) => {
    const m = /onClick=\{\(\)\s*=>/.exec(s)
    if (!m) return false
    const body = handlerBody(s, m.index + m[0].length)
    return body === null ? /^\s*toast\(/.test(s.slice(m.index + m[0].length)) : /^\s*toast\([\s\S]*\);?\s*$/.test(body)
  }
  for (const s of shouldBite) ok(bites(s), `规则自检：这种「只弹提示」必须被抓到 —— ${JSON.stringify(s.slice(0, 44))}`)
  for (const s of shouldNotBite) ok(!bites(s), `规则自检：这种「先做别的事」不该被抓 —— ${JSON.stringify(s.slice(0, 44))}`)
}

console.log('\n== 控制字符（NUL 等坏字节）==')/**
 * U+FFFD 那条检查抓的是「解码失败」，抓不到**写进去的**坏字节。
 *
 * 这次就栽在 NUL（\u0000）上：`setPwd(pwd + '\u0000')` —— 本该是空字符串。
 * 它的坏处特别深：
 *   · `tsc` **不报错**（`'\u0000'` 是合法的字符串字面量）
 *   · 运行时也不报错（那行本来就只是个占位写法）
 *   · 但它让整行既**显示不出来**、也**匹配不到** ——
 *     按原文去替换它会「找不到」，于是人会以为是自己的搜索写错了，
 *     转而去怀疑文件被改过、被工具弄坏过。
 *
 * 一个连「按字面量搜索源码」都能悄悄破坏的字节，
 * 和 BOM 属于同一类：都是某个环节把字节搞坏了，而**没有任何一处会报警**。
 *
 * 允许的只有 \t \n \r 和其它可见字符（含中文）。
 */
{
  const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
  const bad = []
  for (const f of all) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (CTRL.test(line)) {
        // 只报位置和行首，别把坏字节原样打进输出（那会让报告本身也坏掉）
        bad.push(`${f}:${i + 1}`)
      }
    })
  }
  ok(bad.length === 0, `源码里没有 NUL 等控制字符（${all.length} 个文件）`, bad.join('  |  '))
}

/* ============================================================
   附件 URL 只许从适配层出去
   ------------------------------------------------------------
   这条检查是**两次同一个错误**换来的：

   ① `FileCard` 走 `useAttachmentUrl`（会去 IndexedDB 取 Blob），
      而图片块当时写的是 `own.dataUrl || attachmentUrl(own.key)` ——
      拼出来的一定是 `/api/attachment/<key>`。而本地形态的 key
      （`sha256-…`）指向**本机**，压根不在服务端。
      于是静态托管下图片块是一张**加载不出来的碎图**（见 7.15）。

   ② 修完 ① 之后才发现另一半：`resolveFileUrl` 在服务端形态下
      **只拼地址不检查文件在不在**，于是 `state` 恒为 `ready`，
      `FileCard` 的 missing 分支根本进不去（见 7.16）。

   两次都是「绕过适配层自己拼地址」。所以把它变成**机器检查**，
   而不是又一次注释 —— 注释拦不住第三次。
   ============================================================ */

console.log('\n== 附件 URL 只许从适配层出去 ==')
{
  /** 剥掉注释再判断 —— 同一个坑第八次了：扫全文会扫到自己解释 bug 的注释 */
  const bare = (f) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const ALLOWED = join('lib', 'attachment-store.ts')
  const bad = []
  for (const f of walk(SRC_DIR)) {
    if (f.endsWith(ALLOWED)) continue
    // 注意去掉**行内**注释，否则 `// 用 attachmentUrl(key) 拼` 这种也会被算进去
    const code = bare(f).replace(/\/\/[^\n]*/g, '')
    if (/attachmentUrl\s*\(/.test(code)) bad.push(f)
  }
  ok(bad.length === 0, '除了 lib/attachment-store.ts 之外没人直接拼附件地址', bad.join('  |  '))

  // 反过来也钉一下：适配层自己必须还在用 attachmentUrl（不是被谁绕过了）
  //
  // 这一条头一版**靠注释撑着**：判断读的是原文，而 attachment-store.ts 的
  // 注释里正好有 `attachmentUrl(key)` 几个字 —— 于是把代码里那次调用换掉，
  // 它照样通过。**扫全文会扫到自己解释 bug 的注释**（同一个坑，第九次）。
  // 所以这里也必须剥掉注释再判断。
  const storeCode = readFileSync(join(SRC_DIR, 'lib', 'attachment-store.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^\n]*/g, '')
  ok(/attachmentUrl\s*\(/.test(storeCode), '适配层仍然负责拼这个地址（剥了注释再判断，不是靠注释撑着）')
}

/* ============================================================
   「注释行里不许藏着代码」—— 试过，**撤回**
   ------------------------------------------------------------
   `store/index.ts` 里 `remoteDocHook?.(docId, next)` 曾经被并进一句
   注释的末尾（我删一个空行时吃掉了换行），导致协作进来的正文不再更新
   同步基准 → 只读成员收到一条他根本没做的告警。

   所以我加了一条检查「注释行里不许藏着可执行代码」。**它一直误报**，
   误报的全是这个项目里**故意引用代码片段**的注释：

       * verifyApiToken 里（`expiresAt < Date.now()` 直接 return null），
       // 形如  if (key === 'bookSettings') return String(r.bookId)
       *     if (useServer()) return { url: attachmentUrl(key), revoke: false }

   ——「在注释里贴一段代码说明」正是这套代码的注释风格，也是它可读的原因。
   一条需要不停加白名单的检查，最后会退化成「什么都查不到」，
   而白名单本身又变成下一个没人看的东西。

   **而且它本来也不需要。** 那个 bug 是被 `test-permissions-ui` 的
   「协作进来的文稿没有被差分当成『我改的』」抓到的 —— 功能测试抓的。
   静态扫描只是又给它加了一层会吵的、而且抓不准的网。

   留着这段注释，是为了**下次别再犯**（别在删空行时把下一行吃掉），
   而不是为了让 lint 假装能管这件事。
   ============================================================ */

/* ============================================================
   「已证实 / 实测证实」这类强断言要不要机器检查？—— 试过，**撤回**
   ------------------------------------------------------------
   起因是我自己犯了个错：把一个**只观察了现象、没坐实机制**的推断
   写成了「**实测证实**的协作缺陷，根因是 B 用旧内容覆盖」。
   随后两个受控探针都**没复现**，删除路径本身是对的 —— 也就是说
   「实测证实」修饰的是一个猜测。后来的人会以为根因清楚，照着去改
   一个不存在的问题。

   于是想加一条检查：源码里出现「已证实 / 已确认」这类强度词时，
   旁边必须有「未坐实 / 推测」的限定。**它抓不住我那个错**：
   我犯错的地方是 **README.md**，而这条检查只扫源码（server + src + test-*）。
   **作用域从一开始就是错的。**

   扩到 md 也不行：md 里「含 5 次破坏对照」「含 39 项断言」这类强断言
   是**合法**的（后面真有证据），要机器区分「有证据的强断言」和
   「没证据的强断言」，就得判断证据在不在 —— 那是人做的事。

   所以撤回。**教训写在文档里**（README 7.19），
   而不是靠一条抓不准的检查假装有防线。
   ============================================================ */

console.log('\n== 明显的中文占位符 / 未写完的代码 ==')
const TODO = /(TODO|FIXME|XXX|待实现|没写完)/g
const hits = []
for (const f of walk(SERVER_DIR)) {
  const src = readFileSync(f, 'utf8')
  if (TODO.test(src)) hits.push(f)
}
ok(hits.length === 0, '服务端没有留 TODO/FIXME', hits.join(', '))

/* ============================================================
   卡片覆盖率
   ------------------------------------------------------------
   README 里写过一句「27 张真做，其余是如实标注的占位」。
   这种话会过期 —— 过了几轮，卡片补齐了，文档还写着占位；
   或者反过来，有人往 cards.ts 加了一张卡却忘了写组件，
   正文里就渲染成「未实现的卡片」，而没有任何东西会报错。

   所以把它变成不变量：`src/data/cards.ts` 里每张卡，必须落在
   三者之一 —— 卡片组件、编辑器原生块、独立文稿类型。

   解析失败必须报错而不是放行：这里如果一个 id 都没解析出来，
   「一个都没漏」这句话就是假的 —— 绿灯比红灯危险。
   ============================================================ */

console.log('\n== 卡片覆盖率（每张卡都有归宿）==')
{
  const cardsSrc = readFileSync(join(SRC_DIR, 'data', 'cards.ts'), 'utf8')
  const allIds = [...cardsSrc.matchAll(/\bid:\s*'([a-z0-9]+)'/g)].map((m) => m[1])

  const idxSrc = readFileSync(join(SRC_DIR, 'components', 'cards', 'index.tsx'), 'utf8')
  const regSlice = idxSrc.slice(idxSrc.indexOf('CARD_REGISTRY'), idxSrc.indexOf('STANDALONE_CARD_IDS'))
  const implemented = new Set([...regSlice.matchAll(/^\s{2}([a-zA-Z0-9]+):/gm)].map((m) => m[1]))
  const standalone = new Set(
    (idxSrc.match(/STANDALONE_CARD_IDS\s*=\s*\[([^\]]*)\]/) || [, ''])[1]
      .split(',').map((s) => s.trim().replace(/['`]/g, '')).filter(Boolean),
  )

  // 编辑器原生块：从 Block['type'] 联合类型里取
  const typesSrc = readFileSync(join(SRC_DIR, 'types', 'index.ts'), 'utf8')
  const blockSlice = typesSrc.slice(typesSrc.indexOf('export interface Block'), typesSrc.indexOf('export interface Block') + 1200)
  const baseTypes = new Set([...blockSlice.matchAll(/^\s*\|\s*'([a-z0-9]+)'/gm)].map((m) => m[1]))

  ok(allIds.length >= 40, `解析出卡片清单（${allIds.length} 张）`, allIds.length ? '' : '一个都没解析到，多半是 cards.ts 改了写法')
  ok(implemented.size >= 20, `解析出卡片组件注册表（${implemented.size} 个）`, implemented.size ? '' : '没解析到，检查 CARD_REGISTRY 是否改名')
  ok(baseTypes.size >= 10, `解析出编辑器原生块类型（${baseTypes.size} 个）`, baseTypes.size ? '' : '没解析到，检查 Block.type 的写法')

  const orphans = allIds.filter((id) => !implemented.has(id) && !standalone.has(id) && !baseTypes.has(id))
  ok(orphans.length === 0, `${allIds.length} 张卡都有归宿（${implemented.size} 组件 / ${standalone.size} 独立文稿 / ${baseTypes.size} 原生块）`, orphans.join(', '))
}

/* ============================================================
   「点了没反应」的控件
   ------------------------------------------------------------
   这不是洁癖，是两次真实事故：
     - 讨论区的「赞」按钮没有 onClick，纯装饰；
     - Dashboard 关注页两个「已关注」按钮没有 onClick，
       而整个模块连「关注」这张表都没有。
   共同点是**界面上看起来是个能点的东西，点下去什么都不发生**，
   而且都不报错 —— 单元测试和浏览器脚本都不会发现。

   所以做成一条静态检查，让这一类 bug 没法再悄悄进来。

   三个必须处理的坑（都是第一版探针踩过的）：
     1. 不能用 /<button\b([^>]*?)>/ 扫标签 —— 属性里的 `=>` 那个 `>`
        会把标签提前截断，于是 onClick 在同一标签后面的行也被判成「没有」。
        要按花括号深度扫到真正配对的 `>`。
     2. 必须先剥注释 —— 不然会命中注释里写的示例代码。
     3. 不能只认 onClick —— onMouseDown / onPointerDown / onKeyDown 都是有效处理；
        有 `{...rest}` 展开的（基础组件 Button/IconButton）也放过。
   ============================================================ */
console.log('\n== 点了没反应的控件（button 没有任何事件处理）==')
{
  /** 从 src[start]（指向 '<'）扫到配对的 '>'，跳过字符串、模板串与花括号里的箭头 */
  const scanTag = (src, start) => {
    let depth = 0, quote = ''
    for (let i = start; i < src.length; i++) {
      const c = src[i]
      if (quote) { if (c === quote && src[i - 1] !== '\\') quote = ''; continue }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue }
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) return i
    }
    return -1
  }

  /** 去掉注释（块注释、行注释、JSX 表达式注释），并把换行换成空格以保住行号 */
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))

  const HANDLER = /on(Click|MouseDown|MouseUp|PointerDown|PointerUp|KeyDown|KeyUp|DblClick|Change|Input|Submit|ContextMenu|TouchStart|Wheel)\b/
  const dead = []
  const tsxFiles = walk(SRC_DIR).filter((p) => p.endsWith('.tsx'))

  for (const f of tsxFiles) {
    const src = stripComments(readFileSync(f, 'utf8'))
    let i = 0
    while ((i = src.indexOf('<button', i)) !== -1) {
      if (!/[\s>]/.test(src[i + 7] || ' ')) { i += 7; continue }   // <buttonFoo 不是标签
      const end = scanTag(src, i)
      if (end === -1) break
      const tag = src.slice(i, end + 1)
      const line = src.slice(0, i).split('\n').length
      if (!HANDLER.test(tag) && !/type="submit"/.test(tag) && !/\{\.\.\./.test(tag)) {
        dead.push(`${f}:${line}`)
      }
      i = end + 1
    }
  }

  ok(tsxFiles.length > 10, `扫到了前端组件文件（${tsxFiles.length} 个 .tsx）`, tsxFiles.length <= 10 ? '扫得太少，多半是 walk 出问题了' : '')
  ok(dead.length === 0, `没有「点了没反应」的 button（扫了 ${tsxFiles.length} 个文件）`, dead.join('  '))
}

console.log('\n== 服务端源码能被真正解析（语法兜底）==')
{
  /**
   * 上面那条反引号检查是**启发式**，它看不见成对的反引号
   * （我自己就在注释里写了一次成对的，lint 照样放过）。
   * 所以这里补一道真解析：让 tsc 把 server/ 全部过一遍。
   *
   * 只挑 TS1xxx（语法类）报错：这里没配 @types/node，
   * 类型错（TS2307 找不到 node:crypto、TS2580 找不到 process）
   * 是预期的、不该让体检挂掉 —— 我们要的是「文件能不能被解析」。
   */
  const r = spawnSync(
    process.execPath,
    [join('node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--allowImportingTsExtensions',
      '--module', 'esnext', '--target', 'es2022', '--moduleResolution', 'bundler', '--skipLibCheck',
      'server/index.ts'],
    { encoding: 'utf8', cwd: process.cwd() },
  )
  const out = `${r.stdout || ''}${r.stderr || ''}`
  // TS1000~TS1999 是语法/词法错误
  const syntax = out.split('\n').filter((l) => /error TS1\d{3}:/.test(l))
  ok(syntax.length === 0, `server/ 全部文件都能被解析（只看语法错，类型错不在此列）`, syntax.slice(0, 3).join(' | '))
}

console.log('\n== 前端静态 API 路径在服务端都有对应路由 ==')
{
  /**
   * 「点了没反应」的第三种形态：路径写错 → 404。
   *
   * **覆盖面要说明白**：这里只收前端代码里**完全静态**的 /api 字面量
   * （不含 ${}、<>()，也不是字符串拼接的片段）。大概只覆盖全部调用的一小半，
   * 模板拼出来的路径查不了 —— 静态分析到这一步就停了，猜下去只会误报一片。
   *
   * 前两版探针的教训：
   *   - v1 把 api.del 映射成 'DEL'，服务端是 'DELETE'，全是假警报；
   *   - v2 把 '<id>' 当成真实段、把嵌套 ${} 当路径，都误判；
   *   - v2 还把 '/api/doc/' + id + '/view' 的**第一段**当成完整路径。
   * 误报的检查比没有检查更糟：人会开始无视它，然后真的 404 也跟着被无视。
   */
  const normRoute = (p) =>
    '/' + p.replace(/\?.*$/, '').split('/').filter(Boolean)
      .map((x) => (x.startsWith(':') ? '*' : x)).join('/')

  const routes = []
  for (const f of walk(SERVER_DIR)) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/\bon\(\s*'(GET|POST|PUT|PATCH|DELETE)',\s*'([^']+)'/g)) {
      routes.push(normRoute(m[2]))
    }
  }

  const used = new Map()
  for (const f of walk(SRC_DIR)) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/['"`]\/api\/[^'"`\s]*['"`]/g)) {
      const raw = m[0].slice(1, -1)
      if (/[${}<>()]/.test(raw) || raw.length < 8) continue
      if (/^\s*\+/.test(src.slice(m.index + m[0].length))) continue   // 拼接片段，不是完整路径
      used.set(normRoute(raw), `${f}:${src.slice(0, m.index).split('\n').length}`)
    }
  }

  const orphan = [...used.entries()].filter(([p]) => !routes.includes(p))
  ok(used.size > 5, `扫到了前端静态 API 路径（${used.size} 条）`, used.size <= 5 ? '扫得太少，多半是正则退化了' : '')
  ok(orphan.length === 0, `${used.size} 条静态 API 路径在服务端都有对应路由`, orphan.map(([p, w]) => `${p}（${w}）`).join('  '))
}

console.log('\n== 每个服务端接口都做了鉴权（或写明了为什么不用）==')
{
  /**
   * 内网知识库最要命的不是界面难看，是**任何一个漏判权限的接口**：
   * 任意登录用户能读别人团队的知识库，或者能改别人的东西。
   *
   * 免鉴权的接口必须**逐个写出来** —— 名单反过来写（默认都有鉴权、
   * 手工摘掉几个）时，漏掉一个就是漏洞，所以这里是白名单。
   */
  const PUBLIC_ROUTES = new Map([
    ['GET /api/health', '探活：不能要求先登录，否则健康检查自己把自己判死'],
    ['POST /api/auth/login', '登录入口本身'],
    ['POST /api/auth/register', '注册入口本身'],
    ['POST /api/auth/sso', '统一认证入口：用网关认证头换会话，本来就没有本地口令'],
    ['POST /api/auth/logout', '取出 token 销毁该会话；本来就没登录时登出应当是无害的空操作，不是 401'],
    // 对外分享页：这两条**本来就不该登录** —— 它们是给「没有账号、只有链接」的
    // 外部访客用的。加了 requireUser 就等于这份分享没做（访客只会看到登录页）。
    // 保护不靠登录，靠 publicDocGate：文档级 + 知识库级两个开关、访问密码、
    // 有效期、IP 白名单，四道全过才给正文。
    ['GET /api/public/doc/:id', '对外分享的匿名读取（不设密码时的情形）。保护在 publicDocGate 里，不在登录上'],
    ['POST /api/public/doc/:id', '同上，只是把访问密码放进 JSON body —— 请求头发不出中文口令'],
  ])
  /**
   * 认得的「这里做了鉴权」的写法。
   *
   * `requireScope` 是后加的：访问令牌那套接口要按 read / write 分档，
   * 它内部第一件事就是 requireUser，所以和 requireUser 等价 ——
   * 不把它列进来，那 9 个 /api/v2 接口会被报成「没鉴权」，
   * 而报红的原因是这张名单旧了，不是代码漏了。
   */
  const GUARDS = /requireUser|requireScope|requireAdmin|SSO_ONLY|extractToken\(ctx\.req\)|clientIp\(|x-forwarded-user/

  const rows = []
  for (const f of walk(SERVER_DIR)) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/\bon\(\s*'(GET|POST|PUT|PATCH|DELETE)',\s*'([^']+)'\s*,\s*(async\s*)?\(/g)) {
      const start = m.index
      const nextOn = src.indexOf('\non(', start + 5)
      const body = src.slice(start, nextOn > 0 ? nextOn : src.length)
      const key = `${m[1]} ${m[2]}`
      rows.push({ key, where: `${f}:${src.slice(0, start).split('\n').length}`, guarded: GUARDS.test(body) })
    }
  }
  const bad = rows.filter((r) => !r.guarded && !PUBLIC_ROUTES.has(r.key))
  // 名单里写了理由的也要盯着：有人把理由删了要能看出来
  const noReason = [...PUBLIC_ROUTES.keys()].filter((k) => !rows.some((r) => r.key === k))

  ok(rows.length >= 20, `扫到了服务端接口（${rows.length} 条）`, rows.length < 20 ? '扫得太少，多半是正则退化了' : '')
  ok(bad.length === 0, `每个接口都做了鉴权或写明了免鉴权理由（免鉴权 ${PUBLIC_ROUTES.size} 条）`,
    bad.map((b) => `${b.key}（${b.where}）`).join('  '))
  ok(noReason.length === 0, '免鉴权名单里没有已经不存在的接口（别留过期条目）', noReason.join('  '))
}

console.log('\n== 界面里跳转的路径都在路由表里 ==')
{
  /**
   * 指向不存在路由的导航项，点进去是一片空白 —— 而它看上去完全正常。
   * 和「按钮没有 onClick」是同一类：都不会报错，只是点了没反应。
   *
   * 带插值的路径（`/book/${id}/doc/${docId}`）**跳过**：静态分析判不了，
   * 硬判只会误报一片 —— 误报的检查比没有检查更糟。
   */
  const app = readFileSync(join(SRC_DIR, 'App.tsx'), 'utf8')
  const routes = [...app.matchAll(/<Route path="([^"]*)"/g)].map((m) => m[1])
  const normPath = (p) => p.split('?')[0].split('/').map((x) => (x.startsWith(':') ? '*' : x)).join('/') || '/'
  const known = new Set(routes.map(normPath))

  const hits = []
  for (const f of walk(SRC_DIR)) {
    if (!/\.tsx?$/.test(f)) continue
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/(?:navigate\(|to=)\s*[`'"]([^`'"]+)[`'"]/g)) {
      const p = m[1]
      if (!p.startsWith('/') || p.includes('${') || p.includes('+')) continue
      hits.push({ p, where: `${f}:${src.slice(0, m.index).split('\n').length}` })
    }
  }
  const bad = hits.filter((h) => {
    const segs = normPath(h.p).split('/')
    return !known.has(normPath(h.p))
      && ![...known].some((k) => {
        const ks = k.split('/')
        return ks.length === segs.length && ks.every((x, i) => x === '*' || x === segs[i])
      })
  })
  ok(routes.length >= 8, `解析出路由表（${routes.length} 条）`, routes.length < 8 ? '正则在 App.tsx 写法变化后失效了' : '')
  ok(hits.length >= 5, `扫到界面里的静态跳转（${hits.length} 处）`, hits.length < 5 ? '扫得太少，多半是正则退化了' : '')
  ok(bad.length === 0, `${hits.length} 处静态跳转都能在路由表里找到`, bad.map((b) => `${b.p}（${b.where}）`).join('  '))
}

console.log('\n== 协作落地的远端数据必须推同步基准 ==')
{
  /**
   * 协作文档走 WebSocket / BroadcastChannel，**不经过同步增量**。
   * 所以每个 `*Remote` 动作在 commit 远端数据之前，都必须调 `remoteDocHook`
   * 把同步基准推到与 store 一致 —— 否则下一次差分会把**别人**的改动
   * 当成「我改的」推上去：编辑者白推一趟，只读成员推不动，
   * 顶栏常驻一条「N 处修改没有保存」，而他一个字都没改。
   *
   * 这条检查防的是「加了第三个 Remote 动作又忘了通知」。
   */
  const src = readFileSync(join(SRC_DIR, 'store', 'index.ts'), 'utf8')
  const actions = [...src.matchAll(/^\s{4}(\w+Remote): \([^)]*\) =>\s*$/gm)].map((m) => m[1])
  const missing = actions.filter((name) => {
    const i = src.indexOf(`\n    ${name}: (`)
    // 从这个动作定义到下一个 store 成员定义之间的片段
    const rest = src.slice(i + 1)
    const j = rest.search(/\n    [a-zA-Z]\w*[:(]/)
    const body = j > 0 ? rest.slice(0, j) : rest.slice(0, 1200)
    return !/remoteDocHook\?\./.test(body)
  })
  ok(actions.length >= 2, `扫到 ${actions.length} 个 *Remote 动作`, actions.length < 2 ? '扫得太少，正则退化了' : '')
  ok(missing.length === 0, '每个 *Remote 动作都通知了同步基准', missing.join('  '))
}

console.log('\n== 自起服务的套件：临时库不能被上一次崩掉的运行毒化 ==')
{
  /**
   * 会起 `server/index.ts` 的套件，各自要一个临时库。
   *
   * 库名如果**固定**，就只在跑完时清理 —— 而服务刚被 kill、
   * 文件还被占着时 `rmSync` 会抛 EBUSY，被 `catch` 吞掉。
   * 于是上一轮**崩掉**（工具超时 / Ctrl-C / 断言失败）就留下一个半截的库。
   *
   * 后果不是「多占点磁盘」，是**下一次运行直接被毒化**：库还在，
   * seed 不再跑，里面可能一篇文档都没有，
   * 而报出来的是 `Cannot read properties of undefined (reading 'bookId')`
   * —— 一个和「上次崩了」毫无关系的报错，极难往根因上想。
   *
   * 两种写法都可以接受：
   *   ① 库名里带 `Date.now()`（每次全新，天然免疫）
   *   ② 固定名，但**在起服务之前**先删一遍
   * 只有「固定名 + 只在跑完清」是不行的。
   */
  const suites = readdirSync('.').filter((f) => /^test-.*\.mjs$/.test(f) && f !== 'test-lint.mjs')
  const bad = []
  let checked = 0
  for (const f of suites) {
    const src = readFileSync(f, 'utf8')
    if (!/server\/index\.ts/.test(src)) continue
    // 库名：字面量 data/xxx.db，或模板里带 ${...} 的
    const lits = [...src.matchAll(/data\/[A-Za-z0-9_\-]+\.db/g)].map((m) => m[0])
    const tpls = [...src.matchAll(/data\/[A-Za-z0-9_\-]*\$\{[^}]*\}[A-Za-z0-9_\-]*\.db/g)].map((m) => m[0])
    if (!lits.length && !tpls.length) continue
    checked++
    // 全部是模板名（带 ${}）→ 每次全新，天然免疫
    if (lits.length === 0) continue
    /**
     * 有固定名 → 必须有「带 force 的删除」。
     *
     * 这里认的是标记而不是位置：起服务前的清理和跑完的清理在源码里
     * 未必谁在前（清理函数常常定义在文件开头），但**带 force 的那种
     * 是刻意的预清理** —— 跑完那次的删除是不带 force 的，因为服务可能
     * 还占着文件，force 也删不掉，只能尽力而为。
     */
    if (!/rmSync\([^)]*force: true/.test(src) && !/unlinkSync/.test(src)) {
      bad.push(`${f}（固定库名 ${lits.join(', ')}，但没有「启动前强制清理」）`)
    }
  }
  ok(checked >= 4, `扫到 ${checked} 个自起服务的套件`, checked < 4 ? '扫得太少，正则退化了' : '')
  ok(bad.length === 0, '每个套件的临时库要么每次全新、要么起服务前先清', bad.join('  '))
}

/*
 * ============================================================
 * 试过并撤掉的一条 lint：「断言写进去了不许只看响应体」
 * ============================================================
 * 动机很硬 —— **同一个错这一轮犯了三次**，三次都差点下错结论：
 *
 *   ① 判读函数收的是整个响应对象 `{ status, d }`，里面却读 `r?.rejected`
 *      —— **少取一层**。于是每次都打印「没报错但也没 applied」，
 *      我据此写下「权限没问题，只有 owner 能发是设计如此」，
 *      而真实响应是 `{"rejected":[{"reason":"没有 edit 权限"}]}`。
 *   ② 以为 `POST /api/spaces` 会顺带建知识库（它只返回 `{space}`）
 *   ③ 以为 `sp.book` 是返回体的一部分（实际是 `{space, books}`）
 *
 * 共同的根：**「没报错」被当成了「成功了」**。
 * 这个项目里同一个错误早就有前科 —— 7.17 的 `docs.body`
 * 「全程零报错」，而导出是零字节文件。
 *
 * ------------------------------------------------------------
 * 撤掉断言的原因：13 个套件里大部分是误报
 * ------------------------------------------------------------
 * 规则是「读 `.rejected` / `.applied` 的套件，全文必须出现
 * `DatabaseSync` / `SELECT` 之类」。跑出来 20 个命中 13 个「没查库」——
 * 但看下去，绝大多数是**用读接口做了二次确认**：
 *
 *     推一篇文档 → 再 GET 一次 → 比对内容
 *
 * 那**比直接查库更强**（走的是服务端的真实读取路径，连序列化都对得上），
 * 只是不写成 SQL。于是规则把正确的写法全判成了错。
 *
 * 想收紧也难：「断言成功」这个意图在源码里没有稳定标记 ——
 * 写在注释里、写在 `ok(...)` 的 label 里、还是靠人读，都不可靠。
 * 硬凑出来的正则只会**随机地**抓几个，而抓不准的检查比没有更糟：
 * 它会让人以为这一类问题已经被防住了。
 *
 * 下面那几行扫描**保留着**（当草稿/工具用），但**不判失败** ——
 * 真防住它的不是 lint，是每个套件自己复查，
 * 而这一点本轮新写的 `test-spacewrite`（每条「成功」都查库）
 * 和 `test-bulk-members`（推完再读一次）里已经是既成事实。
 *
 * 第二条教训也记在这儿：**规则的第一版几乎总是抓不准** ——
 * 这已经是 README 7.21 之后第二次「试了、退回、只留说明」。
 * 写规则的成本低于写套件，而**写错的规则有维护成本**：
 * 下一个人会照着它改代码。
 * ============================================================ */
{
  const suites = readdirSync('.').filter((f) => /^test-.*\.mjs$/.test(f) && f !== 'test-lint.mjs')
  const suspects = []
  for (const f of suites) {
    const raw = readFileSync(f, 'utf8')
    // 剥掉注释再扫 —— 注释里提到 rejected/applied 是解释，不是判读
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n')
    if (!/\.rejected|\.applied/.test(src)) continue
    // 复查的痕迹：直接查库，或用读接口二次确认
    const verifies = /DatabaseSync|sqlite|SELECT /.test(src) || /再查|复查|重新取|确认.*在库/.test(src)
    if (!verifies) suspects.push(f)
  }
  void suspects   // ← 断言撤掉了，理由见上面那段说明
  void suites
}

/* ============================================================
   文档 / 编排里提到的环境变量，代码里必须真的读得到
   ------------------------------------------------------------
   环境变量是**文档承诺、代码消费**的一对。写错名字、或者承诺一个
   根本不存在的变量，症状是**静默**的：配了没反应，
   而没人会怀疑「那个变量名是不是拼错了」。

   2026-10-06 的实例（`docker-compose.yml`）：让人设 `VQ_BASE_PATH` 来支持子路径部署，
   而代码里既没有 `VQ_BASE_PATH` 也没有 `YQ_BASE_PATH`；
   真正管用的 `VITE_API_BASE`（**构建期**变量）文档里一次都没出现。
   公司挂在门户子路径下 —— 也就是那段注释自己说的「内网常态」—— 照着做就装出坏的。
   ============================================================ */
console.log('\n== 文档 / 编排里提到的环境变量，代码里真的读得到 ==')
{
  // 代码侧：server/ + src/lib/api.ts + test-*.mjs（测试套件也消费 YQ_PORT 之类）
  const codeVars = new Set()
  const codeFiles = [
    ...readdirSync('server').filter((f) => f.endsWith('.ts')).map((f) => join('server', f)),
    join('src', 'lib', 'api.ts'),
    ...readdirSync('.').filter((f) => /^test-.*\.mjs$/.test(f)),
    'run-all-tests.mjs',
  ]
  for (const f of codeFiles) {
    let t
    try { t = readFileSync(f, 'utf8') } catch { continue }
    for (const m of t.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) codeVars.add(m[1])
    for (const m of t.matchAll(/\b(VITE_[A-Z0-9_]+)\b/g)) codeVars.add(m[1])
  }
  // 扫得太少一定是正则或路径出了问题，不是「没有未知变量」—— 这一条比任何断言都管用
  ok(codeVars.size > 30, `代码侧认出 ${codeVars.size} 个环境变量（太少 = 扫描本身坏了）`)

  // ⚠️ 正则要同时认 `YQ_*` 和 `VQ_*` 两族。第一版只写了 `\b(V?Q...`，
  // 而 `YQ_` 的 Y 和 Q 都是词字符、`Q` 前面没有 `\b` → 整族一个都没匹配上，
  // 结果 README/DEPLOY 报「提到 0 个」—— 那明显不对，而它看起来像个干净的结论。
  // 豁免：这两个名字**在文档里出现，恰恰是为了说明它们不存在**
  // （见 DEPLOY「挂在子路径上」那一节与 docker-compose 的注释）。
  // 不豁免的话这条检查等于要求「不许提」—— 而提一下正是为了不让下一个人再照着配。
  // 这和 runner 里用 String.fromCharCode 避开自己的 U+FFFD 检查是同一类问题：
  // **描述缺陷的文字，本身会命中描述缺陷的检查。**
  const ALLOWED = new Set(['YQ_BASE_PATH', 'VQ_BASE_PATH'])
  for (const f of ['README.md', 'DEPLOY.md', 'docker-compose.yml', 'Dockerfile']) {
    let t
    try { t = readFileSync(f, 'utf8') } catch { continue }
    const unknown = new Set()
    for (const m of t.matchAll(/\b([YV][A-Z0-9]*_[A-Z0-9_]+)\b/g)) {
      if (!codeVars.has(m[1]) && !ALLOWED.has(m[1])) unknown.add(m[1])
    }
    ok(unknown.size === 0, `${f} 里提到的环境变量代码都读得到`,
      [...unknown].map((v) => `${v}（代码里找不到，配了也没用）`).join(' '))
  }

  // 那两个具体的名字单独钉一下 —— 钉的是**指示句式**，不是「不许提到」。
  // ⚠️ 我第一版写成「compose 里不再提 VQ_BASE_PATH」，结果和自己刚加的豁免自相矛盾
  // （豁免的意思就是「文档里可以提它，只是要说明它不存在」）。
  // 真正要禁的是**指示你去设它**的那句话 ——
  // 原来写的是「把下面换成 "8080:80" 并给 VQ_BASE_PATH」。
  // 区分「提到」和「指示」很重要：提一次是为了不让下一个人再照着配。
  const compose = readFileSync('docker-compose.yml', 'utf8')
  ok(!/并给\s*V?Q_BASE_PATH|设置\s*V?Q_BASE_PATH|加上\s*V?Q_BASE_PATH/.test(compose),
    'docker-compose.yml 里**不再指示**去设那个不存在的变量')
  ok(/VITE_API_BASE/.test(compose), '并写清了真正管用的那个（**构建期**的 VITE_API_BASE）')
  const srvHead = readFileSync(join('server', 'index.ts'), 'utf8')
  ok(!/用\s*YQ_BASE_PATH/.test(srvHead), 'server/index.ts 的文件头注释也不再说「用 YQ_BASE_PATH」')

  /**
   * **反向**再查一遍：代码里读的运维类变量，DEPLOY 有没有写。
   *
   * 上面那条管「文档承诺了代码里没有的」，这条管「代码里有、文档一个字没提」。
   * 后者的症状同样静默：运维照着文档配，漏掉一个开关就默默用着默认值 ——
   * 而「默默用默认值」正是这个项目反复出事的形态：
   *   · `YQ_TRUST_PROXY` 不设 = **信** X-Forwarded-For
   *   · `YQ_DEMO` 不设 = 播种 26 篇演示文档
   *   · `YQ_TRUSTED_PROXY_IPS` 不设 = 谁写的头都信
   *   · `YQ_TRASH_DAYS` 不设 = 30 天
   * 将来加一个开关忘了写文档，这里会红。
   *
   * ⚠️ 范围只取**交付出去的代码**（server/ + src/），**不含 test-*.mjs**。
   * 第一版把测试套件也算进来，于是立刻报 `YQ_IMAGE` —— 那是 test-container
   * 用的镜像标签，压根不是运维要配的东西。前缀过滤（`YQ_`）太宽，
   * 真正区分的是「这段代码会不会跟着部署走」。
   */
  const shippedVars = new Set()
  /*
   * ⚠️ 这里踩了「空集合恒真」那个坑，而且踩得很彻底：
   * 第一版用 `x.startsWith('server/')` 过滤，而 `codeFiles` 里的路径来自
   * `join('server', f)` —— **Windows 上是 `server\index.ts`（反斜杠）**。
   * 于是过滤出**空集** → `opsVars` 为空 → `undocumented` 也为空 → **恒真通过**。
   *
   * 证据其实就印在这一条的标签里（「读了 0 个运维类变量」），我看到了却没当成信号。
   * 破坏对照把变量名从 DEPLOY 里删掉，它**照样全绿** —— 那一刻才看出来它是摆设。
   *
   * 所以下面：① 两种分隔符都认；② 数量必须合理，否则直接判失败。
   */
  const shippedFiles = codeFiles.filter((x) => /^(server|src)[\\/]/.test(x))
  for (const f of shippedFiles) {
    const t = readFileSync(f, 'utf8')
    for (const m of t.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) shippedVars.add(m[1])
  }
  for (const m of readFileSync(join('src', 'lib', 'api.ts'), 'utf8').matchAll(/\b(VITE_[A-Z0-9_]+)\b/g)) shippedVars.add(m[1])
  const opsVars = [...shippedVars].filter((v) => v.startsWith('YQ_') || v.startsWith('VITE_')).sort()
  ok(shippedFiles.length > 5 && opsVars.length >= 10,
    `扫到 ${shippedFiles.length} 个交付源文件、${opsVars.length} 个运维类变量`
    + '（为 0 就是路径分隔符没匹配上 → 后面那条会**恒真通过**）')
  const deploy = readFileSync('DEPLOY.md', 'utf8')
  const undocumented = opsVars.filter((v) => !deploy.includes(v))
  ok(undocumented.length === 0,
    `交付代码里读的 ${opsVars.length} 个运维类变量，DEPLOY 都写了`,
    undocumented.join(' ') + '（运维照着文档配就会默默用默认值）')
}

/* ============================================================
   机器路径不许写死
   ------------------------------------------------------------
   形态：**某个开发机上的绝对目录树被写进源码**，换台机器或换个平台就落到别处。

   2026-10-06 实测踩到的就是它：8 个手动冒烟套件里写着
     `const OUT = '/workspace/yuque/.smoke'`
   在 Windows 上 Node 把它解析成 `H:\workspace\yuque\.smoke` ——
   **截图落在工作区外面、盘根下面**，一次就堆了 **15.1MB**，
   而**没有任何地方会报**（套件照常全绿，因为它本来就该全绿）。
   `.gitignore` 里明明列着这些目录名 —— 本来的意图就是放在项目根。

   为什么要钉住：截图是手动套件**唯一的失败取证手段**。
   落在人不会去看的地方，「失败了但看不出为什么」和「套件没跑」长得一模一样，
   于是这类脚本会慢慢变成没人信、也没人跑的东西。
   ============================================================ */
console.log('\n== 机器路径不许写死 ==')
{
  /*
   * 机器根**必须拆开写**：`['/Users/', '/home/', …]` 会被下面那条检查命中 ——
   * 判据的字面量自己就是判据要找的东西。
   * 同一个坑本项目处理过两次：runner 用 `String.fromCharCode(0xfffd)` 避开自己的
   * U+FFFD 检查、环境变量检查把 `YQ_BASE_PATH` 放进显式豁免清单。
   * 这里选拆字符串（比豁免清单更硬：豁免清单会被人「顺手加一条」）。
   */
  const MACHINE_ROOTS = '/Users,/home,/root,/workspace,/mnt,/opt,/srv,/var,/etc'.split(',').map((r) => `${r}/`)
  const scanned = [
    ...walk(SERVER_DIR),
    ...walk(SRC_DIR),
    ...readdirSync('.').filter((f) => /\.(cjs|mjs)$/.test(f)),
  ]
  const hard = []
  const hardOut = []
  for (const f of scanned) {
    let inBlock = false
    readFileSync(f, 'utf8').split('\n').forEach((l, i) => {
      /*
       * 注释必须**真正跟踪**，只认行首 `//` / `*` / `/*` 是不够的：
       * 块注释里以反引号或缩进开头的那一行（`  \`const OUT = '/workspace/…'\``）
       * 三个标记一个都不匹配，于是它被当成代码，
       * 而它恰恰是**解释这次修复的说明文字** ——
       * 「描述缺陷的文字本身会命中描述缺陷的检查」。
       * 所以：先按 `/*` … `*\/` 切状态，行首标记只是补充。
       * 判据是「**代码里**还写死了它」，不是「文件里出现过它」。
       */
      const t = l.trim()
      if (inBlock) { if (l.includes('*/')) inBlock = false; return }
      if (t.startsWith('//')) return
      if (t.startsWith('/*')) { if (!(l.includes('*/') && l.indexOf('*/') > l.indexOf('/*'))) inBlock = true; return }
      for (const r of MACHINE_ROOTS) {
        if (l.includes(`'${r}`) || l.includes(`"${r}`)) hard.push(`${f}:${i + 1} ${t.slice(0, 56)}`)
      }
      const mo = /const OUT\s*=\s*(['"`])(.+?)\1/.exec(l)
      if (mo && mo[2].startsWith('/')) hardOut.push(`${f}:${i + 1} → ${mo[2]}`)
    })
  }
  // 声明了输出目录的冒烟脚本：钉住「截图不许落在项目外」
  const outFiles = scanned.filter((f) => /^smoke.*\.cjs$/.test(f) && /const OUT\s*=/.test(readFileSync(f, 'utf8')))
  const outFixed = outFiles.filter((f) => /const OUT\s*=\s*process\.env\.SMOKE_OUT\s*\|\|\s*path\.join\(__dirname,/.test(readFileSync(f, 'utf8')))

  ok(scanned.length > 40,
    `扫到 ${scanned.length} 个代码文件、${MACHINE_ROOTS.length} 个机器根`
    + '（为 0 就是路径没匹配上 → 下面三条会**恒真通过**）')
  ok(hard.length === 0,
    `没有写死的机器绝对路径（${MACHINE_ROOTS.length} 个常见根）`,
    hard.join(' | ') + '（换台机器就落到别处，且不报错）')
  ok(outFiles.length >= 5,
    `${outFiles.length} 个冒烟脚本声明了输出目录（<5 说明扫到的东西不对，不是「没问题」）`)
  ok(hardOut.length === 0 && outFiles.length === outFixed.length,
    `${outFixed.length}/${outFiles.length} 个脚本的输出目录走 __dirname / SMOKE_OUT，没有写死`,
    hardOut.join(' | ') + (outFixed.length !== outFiles.length ? '（有脚本没走 __dirname）' : ''))
}

/* ============================================================
   同一个东西不许有两个名字
   ------------------------------------------------------------
   形态：块类型菜单（`Editor.tsx` 的 `BLOCK_META`）与卡片目录
   （`src/data/cards.ts` 的 `YUQUE_CARDS`）各自维护一份中文名。
   两份都能用，但**只有卡片目录那份参与搜索**（matchCards 走 name/pinyin/initial/en）。

   2026-10-06 实测到的：`callout` 在菜单里叫「提示卡片」、在目录里叫「高亮块」。
   用户在菜单里看到「提示卡片」，把这四个字打进斜杠菜单 —— **搜不到任何东西**
   （「高亮块」/「gaoliangkuai」/「glk」/「callout」里没有这串）。
   反过来搜「高亮块」倒搜得到。于是同一个块两个名字，一个能搜一个不能。

   为什么放 lint 而不是浏览器套件：这是**源码层不变量**，
   与运行时状态无关，而且它改一次就会同时影响两个文件的读法。
   ============================================================ */
console.log('\n== 同一个东西不许有两个名字 ==')
{
  const cardsSrc = readFileSync('src/data/cards.ts', 'utf8')
  const edSrc = readFileSync('src/components/doc/Editor.tsx', 'utf8')

  const cardName = new Map()
  for (const line of cardsSrc.split('\n')) {
    const m = /^\s*\{\s*id:\s*'([^']+)'[\s\S]*?name:\s*'([^']+)'/.exec(line)
    if (m) cardName.set(m[1], m[2])
  }
  const metaBody = /BLOCK_META:\s*Record<[\s\S]*?>\s*=\s*\{([\s\S]*?)\n\}/.exec(edSrc)
  const metaLabel = new Map()
  if (metaBody) {
    for (const line of metaBody[1].split('\n')) {
      const m = /^\s*([a-z0-9]+):\s*\{\s*label:\s*'([^']+)'/.exec(line)
      if (m) metaLabel.set(m[1], m[2])
    }
  }

  // 这两条是「扫描器本身没坏」的基准：任一条为 0，下面那条比较会**恒真通过**
  ok(cardName.size === 44, `卡片目录解析出 ${cardName.size} 个名字（应为 44）`,
    '为 0 就是正则没匹配上 → 后面那条会**恒真通过**')
  ok(metaLabel.size === 15, `块类型菜单解析出 ${metaLabel.size} 个名字（应为 15）`,
    '为 0 就是正则没匹配上 → 后面那条会**恒真通过**')

  const diff = []
  const both = []
  for (const [id, label] of metaLabel) {
    if (!cardName.has(id)) continue      // `card` 只在菜单里（设计上不能转出来）
    both.push(id)
    if (cardName.get(id) !== label) diff.push(`${id}：菜单「${label}」 vs 目录「${cardName.get(id)}」`)
  }
  ok(both.length === 14,
    `两边都有名字的块共 ${both.length} 个（14 = 15 减去只在菜单里的 card）`,
    '数量不对说明有一侧漏解析，下面那条就不可信')
  ok(diff.length === 0,
    `${both.length} 个块在两处的名字完全一致（只有一个名字能搜、也能点到）`,
    diff.join(' | ') + '（用户看到 A、打进搜索框却是 B，就什么都搜不到）')
}

/* ============================================================
   帮助页说的「单篇导出格式」必须等于文档页菜单里真有的那些
   ============================================================
   这一页是**用户看不懂功能时会去查的那一页**，而它以前是重灾区
   （文件头写着「这一页以前每一项承诺都是假的」）。

   实际抓到过一次：帮助页写「单篇支持 Markdown / HTML / 纯文本 / **JSON**」，
   而文档页的「···」菜单里是 **Markdown / Word（.docx）/ HTML / 纯文本** ——
     · 漏了**能用的** Word：用户照着帮助页找不到导出 Word 的入口；
     · 多列了**点不到的** JSON：`io.ts` 里确实定义了 `'json'` 这个格式，
       但**没有任何地方拿它调 downloadDocAs**，菜单里也没有这一项。
   两个方向都错，而且都只有用户点得出来。

   判据取的是「菜单里实际出现的格式」而不是某个写死的清单 ——
   将来加了导出格式而忘了改帮助页，这条会红；反过来也一样。
*/
{
  const docSrc = readFileSync(join(SRC_DIR, 'pages/DocPage.tsx'), 'utf8')
  const helpSrc = readFileSync(join(SRC_DIR, 'pages/Help.tsx'), 'utf8')

  /** 菜单里真正有的格式：Markdown 走 downloadDoc，其余走 downloadDocAs(…, 'x') */
  const menu = new Set()
  if (/downloadDoc\(doc\.title/.test(docSrc)) menu.add('md')
  for (const m of docSrc.matchAll(/downloadDocAs\(doc\.title,[^)]*\)[^)]*?,\s*'(\w+)'\)/g)) menu.add(m[1])

  /** 各格式在帮助页里该被叫成什么（`io.ts` 的 DocFormat → 界面上写的名字） */
  const NAMES = { md: 'Markdown', docx: 'Word', html: 'HTML', txt: '纯文本', json: 'JSON' }

  // 只取「单篇支持 … ；」这一段 —— 同一句后面还提到整库的 JSON 包，
  // 那**是真的**（`downloadBundle`），拿整句去对会误报。
  const line = helpSrc.split('\n').find((l) => l.includes('单篇支持')) || ''
  const seg = /单篇支持([^；]+)/.exec(line)?.[1] || ''
  const claimed = Object.keys(NAMES).filter((k) => seg.includes(NAMES[k]))

  /* 基准：没解析出清单，下面那条就是恒真 —— 先证明判据读到了东西 */
  ok(claimed.length > 0 && menu.size > 0,
    `解析出两边的清单（菜单 ${menu.size} 项 / 帮助页 ${claimed.length} 项）`,
    `帮助页那段=${seg || '(没找到)'} 菜单=${[...menu].join(',')}`)

  const missing = [...menu].filter((k) => !claimed.includes(k))
  const extra = claimed.filter((k) => !menu.has(k))
  ok(!missing.length && !extra.length,
    '帮助页说的单篇导出格式与文档页菜单完全一致',
    missing.length ? `菜单有、帮助页没写：${missing.map((k) => NAMES[k])} ` : ''
    + (extra.length ? `帮助页写了、菜单里没有：${extra.map((k) => NAMES[k])}` : ''))

  /* 角色名同理：帮助页那张能力表是用户理解权限的唯一依据，
   * 而真正的判据在 `ROLE_CAPS`。加了一个角色只改一边的话，
   * 表上就会缺一行/多一行，而**双方都不会报错**。 */
  const perms = readFileSync(join(SERVER_DIR, 'perms.ts'), 'utf8')
  const capsBlock = /ROLE_CAPS[^=]*=\s*\{([\s\S]*?)\n\}/.exec(perms)?.[1] || ''
  const roleNames = [...capsBlock.matchAll(/^\s*(\w+):\s*\[/gm)].map((m) => m[1])
  /* 角色行长这样：`'· owner / admin：全部权限，含管理'`
   * ⚠️ 别用「含『权限』两个字」去筛 —— `· reader：读、评论、导出` 那行没有，
   *   第一版就是这么写的，只认出 2 个角色，然后**判据说服务端有三个角色没写**
   *   —— 红的其实是解析器。认准行首的 `· <小写词>` 形状就够了。 */
  const helpRoles = helpSrc.split('\n')
    .filter((l) => /'\s*·\s*[a-z]/.test(l))
    .map((l) => (l.match(/·\s*([a-z/ ]+?)\s*[:：]/) || [])[1] || '')
    .flatMap((r) => r.split('/').map((x) => x.trim()))
    .filter(Boolean)

  ok(roleNames.length > 0 && helpRoles.length > 0,
    `解析出两边的角色（服务端 ${roleNames.length} 个 / 帮助页 ${helpRoles.length} 个）`,
    `服务端=${roleNames.join(',') || '(没解析出)'} 帮助页=${helpRoles.join(',') || '(没解析出)'}`)
  const noRole = roleNames.filter((r) => !helpRoles.includes(r))
  const noHelp = helpRoles.filter((r) => !roleNames.includes(r))
  ok(!noRole.length && !noHelp.length,
    '帮助页的角色能力表与服务端 ROLE_CAPS 一一对应',
    noRole.length ? `服务端有、帮助页没写：${noRole} ` : '' + (noHelp.length ? `帮助页写了、服务端没有：${noHelp}` : ''))

  /* 散文里的**数字**最容易漂：哪天把防抖从 400 改成 300，
   * 帮助页那句「约 0.4 秒」就开始骗人，而它不会报任何错。 */
  const storeSrc = readFileSync(join(SRC_DIR, 'store/index.ts'), 'utf8')
  const debounce = Number((/const SAVE_DEBOUNCE_MS\s*=\s*(\d+)/.exec(storeSrc) || [])[1])
  const claimedSec = Number((/约\s*([\d.]+)\s*秒[^']*自动落盘/.exec(helpSrc) || [])[1])
  /* 基准：两个数都得解析出来，否则下面那条会恒真 */
  ok(debounce > 0 && claimedSec > 0,
    `解析出两边的落盘防抖（代码 ${debounce}ms / 帮助页 ${claimedSec}s）`)
  ok(debounce > 0 && claimedSec > 0 && Math.abs(debounce / 1000 - claimedSec) < 0.05,
    '帮助页说的「约 N 秒自动落盘」与代码里的 SAVE_DEBOUNCE_MS 一致',
    `代码 ${debounce}ms，帮助页写 ${claimedSec}s（差得超过 50ms 就是有一边过期了）`)

  /* 「本实例未开启自动清除」是一句关于**删除数据**的承诺。
   * 它成立的前提是 `runPurge()` 在保留期为 0 时真的不跑 ——
   * 那个 early return 一旦被人顺手删掉，界面就变成
   *「一边告诉管理员不会删、一边照删」，而两边都不会报错。 */
  const trash = readFileSync(join(SRC_DIR, 'pages/Trash.tsx'), 'utf8')
  const server = readFileSync(join(SERVER_DIR, 'index.ts'), 'utf8')
  const uiSays = /本实例未开启自动清除/.test(trash)
  const serverSkips = /RETENTION_DAYS\s*<=\s*0\)\s*return null/.test(server)
  ok(uiSays && serverSkips,
    '回收站那句「未开启自动清除」与 runPurge 的「保留期为 0 就不清」是配套的',
    uiSays ? '界面上写着，但服务端那个 early return 不在了 —— 变成了「承诺不删却在删」'
      : '服务端有 early return，但界面不再说明这件事')

  /* 同一件事**在两个页面各写了一遍**，其中一个写死了 30。
   * 运维把 YQ_TRASH_DAYS 改成 60 之后，回收站页说 60、账户设置页说 30 ——
   * 而这一句关系到**用户的数据什么时候被删**。 */
  const settings = readFileSync(join(SRC_DIR, 'pages/Settings.tsx'), 'utf8')
  const hardcoded = /删除的文档保留\s*\d+\s*天/.test(settings)
  /*
   * ⚠️ 只查「有没有写死数字」**不够**：第一版守卫就是这样，
   * 于是把 `retentionDays > 0` 改成 `true` 它照样全绿 ——
   * 而那意味着保留期为 0（本实例**没有**自动清除）时，
   * 这一行会说「保留 0 天，到期自动清除」。
   * 所以还得盯住**那个分支本身还在**。
   */
  const distinguishes = /retentionDays\s*>\s*0/.test(settings)
  ok(!hardcoded && /retentionDays/.test(settings) && distinguishes,
    '账户设置页的回收站保留期也不再写死（改成问服务端，且仍区分 0 与 >0）',
    hardcoded ? '又出现了一个写死的「保留 N 天」'
      : !distinguishes ? '「0 天（未开启自动清除）」这个分支不见了 —— 会变成「保留 0 天，到期自动清除」'
        : '没有读服务端的状态（retentionDays）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
