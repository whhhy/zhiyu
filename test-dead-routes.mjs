/*
 * 死链守卫：跳转到一个**没注册**的路由。
 *
 * ------------------------------------------------------------
 * 为什么盯这个形状
 *
 * 路由表最后一行是
 *     <Route path="*" element={<Navigate to="/" replace />} />
 * 也就是说：**任何拼错的路径都不会报错、不会白屏**，
 * 只是把你静默送回首页。
 *
 * 界面上那个入口看着完全正常，用户点下去「页面变了但不是我点的那个」。
 * 开发者从日志里看不到任何异常 —— 这类缺陷只能靠「点了没反应」这种
 * 用户反馈发现，而用户往往不会精确说出他想去哪。
 *
 * ------------------------------------------------------------
 * 判据与它的边界
 *
 * 从源码里抽出站内跳转目标字面量，用路由表匹配一遍，匹配不上的报出来。
 *
 * ⚠️ 这是**静态字面量匹配**，不追变量。所以：
 *   · 它只能证明「这些写死的路径都有对应的路由」
 *   · 拼在变量里的路径它管不着
 *   每条命中仍要去代码里看一眼 —— 判据红不等于代码错（下面自检第 4 条就是这个坑）。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 路由表。改 App.tsx 的 <Routes> 时**必须同步改这里**，否则两边都不可信。 */
const ROUTES = [
  '/', '/space/:spaceId', '/book/:bookId', '/book/:bookId/settings',
  '/book/:bookId/doc/:docId', '/knowledge/:topicId', '/search', '/find',
  '/templates', '/help', '/notes', '/trash', '/settings',
]

function toRe(tpl) {
  const segs = tpl.split('/').filter((x) => x !== '')
  if (!segs.length) return /^\/?$/
  const body = segs.map((s) => (s.startsWith(':') ? '[^/]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/')
  return new RegExp(`^/${body}/?$`)
}
const RES = ROUTES.map(toRe)

function collect(root, exts) {
  const out = []
  ;(function w(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue
        w(p)
      } else if (exts.some((x) => e.name.endsWith(x))) out.push(p.split(path.sep).join('/'))
    }
  })(root)
  return out
}

function stripCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
}

/** 归一化跳转目标：剥查询串/hash、把 ${…} 当成一段参数 */
function norm(t) {
  return t.replace(/[?#].*$/, '').replace(/\$\{[^}]*\}/g, ':p').replace(/`/g, '')
}

const PATTERNS = [
  { re: /\bnavigate\(\s*['"`]([^'"`]+)['"`]/g, kind: 'navigate' },
  { re: /\bto\s*=\s*['"`]([^'"`]+)['"`]/g, kind: 'to' },
  { re: /href\s*=\s*['"`]#([^'"`]+)['"`]/g, kind: 'hash' },
]

const files = collect('src', ['.ts', '.tsx'])
const dead = []
let total = 0
for (const f of files) {
  const lines = stripCode(fs.readFileSync(f, 'utf8')).split('\n')
  lines.forEach((line, i) => {
    for (const { re, kind } of PATTERNS) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(line))) {
        const t = norm(m[1])
        if (!t.startsWith('/') || /^https?:/.test(t)) continue
        total++
        if (!RES.some((r) => r.test(t))) dead.push({ f, i: i + 1, kind, raw: m[1] })
      }
    }
  })
}

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`) }
}

console.log('\n== 匹配器自检 ==')
ok(RES.some((r) => r.test('/settings')), '正：已注册的路径匹配得上')
ok(!RES.some((r) => r.test('/settings-typo')), '负：拼错的路径匹配不上（否则守卫永远绿）')
ok(!RES.some((r) => r.test('/book/')), '负：缺参数段也算死链')
ok(norm('/?tab=collab') === '/' && RES.some((r) => r.test(norm('/?tab=collab'))),
  '正：查询参数要剥掉（第一版忘了剥，把 Dashboard 的 ?tab=collab 报成死链 —— 判据太严）')
ok(RES.some((r) => r.test(norm('/book/${id}/doc/${d}'))),
  '正：模板字符串拼接的参数段能匹配')

console.log(`\n== 全项目扫描（${files.length} 个源文件 / ${ROUTES.length} 条路由 / ${total} 个站内跳转）==`)
ok(dead.length === 0,
  '没有跳向未注册路由的死链（撞上兜底重定向 = 点了被静默送回首页）',
  '\n     ' + dead.map((h) => `${h.f}:${h.i}  [${h.kind}]  ${h.raw}`).join('\n     '))
for (const h of dead) console.log(`   · ${h.f}:${h.i}  [${h.kind}]  ${h.raw}`)

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)