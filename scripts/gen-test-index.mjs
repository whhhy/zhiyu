/*
 * 从**真实运行结果**生成测试索引 `docs/test-index.md`。
 *
 * 为什么另起一份，而不是就地修 README：
 *   · README 的测试清单段损坏严重（129 行里 62 行含坏字，还有粘连的长行）
 *   · 损伤是「一个字符 → U+FFFD?」，猜着补会产出**看着对但内容错**的文档
 *   · 而套件名与项数**有权威来源**：刚跑完的 _all.log
 *
 * 所以：数据从真跑结果来，产出放到一份**能重新生成**的文件里，
 * README 只加一行指针。清单从此不会再漂。
 *
 * 用法：node scripts/gen-test-index.mjs [全量日志路径]
 */
import fs from 'node:fs'
import path from 'node:path'

const LOG = process.argv[2] || '_all.log'
if (!fs.existsSync(LOG)) {
  console.error(`找不到运行日志 ${LOG} —— 先跑一次 npm run test:all`)
  process.exit(1)
}
/*
 * ⚠️ 两个踩过的坑，写在这儿免得下一个人重走：
 *
 *  ① 日志可能是 **UTF-16LE**（PowerShell 5.1 的 `>` 重定向默认写 Unicode）。
 *     按 utf8 读会满屏 NUL，而且 `includes('通过')` 直接 false ——
 *     症状是「候选行 0 条」，看起来像日志不对，其实是编码不对。
 *     这里按 BOM 自动判断。
 *  ② `^(?:OK|FAIL)\s+…` **必须带 `m` 修饰符**。不带的话 `^` 只匹配整个字符串开头，
 *     而套件行在中间 —— 于是 0 命中，而日志明明是好的。
 */
const raw = fs.readFileSync(LOG)
const isUtf16 = raw[0] === 0xFF && raw[1] === 0xFE
const log = raw.toString(isUtf16 ? 'utf16le' : 'utf8')
if (isUtf16) console.log(`（${LOG} 是 UTF-16LE，已按对应编码读取）`)

/* ---- ① 套件 → 项数 ---- */
const counts = new Map()
for (const m of log.matchAll(/^(?:OK|FAIL)\s+(test-[A-Za-z0-9-]+\.mjs)\s+(\d+) 通过/gm)) {
  counts.set(m[1], Number(m[2]))
}

/* ---- ② 套件 → npm script 名 ---- */
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const scriptOf = new Map()
for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
  if (!name.startsWith('test:')) continue
  const f = /\b(test-[a-z0-9-]+\.mjs)\b/.exec(cmd)?.[1]
  if (f) scriptOf.set(f, name)
}

/* ---- ③ 说明：优先复用 README 里完好那行；否则用套件自己的注释头 ----
 *
 * README 的清单有 62 行带坏字，所以大量条目取不到说明。
 * 而**每个套件文件开头的注释头是完好的**，而且正是在讲「它测什么」——
 *   `/** 伪造二进制附件失效的几种形态 *\/`
 * 那一句就是最准确的说明，比我另写一句强。
 */
const readme = fs.readFileSync('README.md', 'utf8').split('\n')
const descOf = new Map()
for (const l of readme) {
  const m = /^npm run (test:[a-z0-9-]+)\s+#\s*\d+\s*项\s*(.*)$/.exec(l)
  if (!m || l.includes('\uFFFD')) continue
  for (const [f, s] of scriptOf) if (s === m[1]) descOf.set(f, m[2].trim())
}

/** 取套件注释头里第一句有内容的话 */
function headerDesc(f) {
  const src = fs.readFileSync(f, 'utf8').split('\n')
  let i = 0
  while (i < src.length && !src[i].trim().startsWith('/*')) i++
  if (i >= src.length) return ''
  const out = []
  for (i++; i < src.length; i++) {
    const t = src[i].replace(/^\s*\*+\/?\s?/, '').replace(/\*\/\s*$/, '').trim()
    if (!t) { if (out.length) break; continue }
    if (/^[=\-—]{3,}$/.test(t)) continue          // 分隔线
    out.push(t)
    if (out.join('').length > 60) break
  }
  return out.join(' ').replace(/\s+/g, ' ').trim()
}

/* ---- ④ 生成 ---- */
const files = fs.readdirSync('.').filter((f) => /^test-.*\.mjs$/.test(f)).sort()
const rows = []
const missing = []
for (const f of files) {
  const script = scriptOf.get(f)
  const n = counts.get(f)
  if (!script || n == null) { missing.push(f); continue }
  rows.push({ script, n, desc: descOf.get(f) || headerDesc(f) })
}

const lines = [
  '# 测试索引（自动生成，勿手改）',
  '',
  `> 由 \`node scripts/gen-test-index.mjs\` 从 **\`${LOG}\` 的真实运行结果**生成。`,
  '> 套件名与项数来自实跑，不是手写 —— 所以它不会漂。',
  '> 手改这里没有意义，改完会被下次生成覆盖。',
  '',
  `本轮实跑：**${rows.length} 个套件 / ${rows.reduce((a, r) => a + r.n, 0)} 项**。`,
  '',
  '| 命令 | 项数 | 说明 |',
  '| --- | --- | --- |',
  ...rows.map((r) => `| \`npm run ${r.script}\` | ${r.n} | ${r.desc || '（说明在 README 里那行损坏了，这里留空）'} |`),
  '',
]

if (missing.length) {
  lines.push(
    '## 没进索引的套件',
    '',
    '它们要么没有 npm script，要么这一轮没跑到：',
    '',
    ...missing.map((f) => `- \`${f}\``),
    '',
  )
}

const OUT = 'docs/test-index.md'
fs.writeFileSync(OUT, lines.join('\n'), 'utf8')
const back = fs.readFileSync(OUT, 'utf8')
if (back.includes('\uFFFD')) { console.error('ABORT: 生成结果含 U+FFFD，未落盘'); process.exit(1) }
console.log(`已生成 ${OUT}：${rows.length} 个套件 / ${rows.reduce((a, r) => a + r.n, 0)} 项`)
if (missing.length) console.log(`未收录 ${missing.length} 个：${missing.join(', ')}`)