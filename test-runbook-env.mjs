/*
 * RUNBOOK.md 与源码的**双向**一致性守卫
 * ============================================================
 * 为什么要盯这个
 *
 * 一份「完整但过时」的部署手册**比坏掉的更危险** ——
 * 坏掉的那份你一眼看得出来，而过时的那份你**照着做，然后被咬**。
 *
 * 真实踩过的一次：验收套件里的 `YQ_ACCEPT_PORT`。
 * 它「文档里有、名字也对」，但 override 里压根没有 ports 映射 ——
 * 设了它必然失败，而报错（连不上）与事实（容器 Up 且 healthy）完全相反。
 *
 * 所以这里查**两个方向**：
 *
 *   A. 手册里写了、源码里没读  → **假旋钮**：照着设没有任何效果，
 *      或者像上面那样反而把事情弄坏
 *   B. 源码里读了、手册里没写  → **隐藏的坑**：部署时出了事，
 *      运维在手册里翻不到那条变量
 *
 * 外加：
 *   C. `||` 形式的默认值逐条比对（手册写 30、代码是 7，这种事最难发现）
 *   D. RUNBOOK.md 自己有没有 U+FFFD —— 它是当前**唯一完好**的部署手册，
 *      它坏了必须有人知道，而不是等到有人照着坏手册部署
 */
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`) }
}

/* ---------- 剥注释 ---------- */
const stripCode = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))

/* ---------- 手册里的环境变量表 ---------- */
const RUNBOOK = 'RUNBOOK.md'
const rbRaw = fs.readFileSync(RUNBOOK, 'utf8')
const rbLines = rbRaw.split('\n')

/**
 * 表里一行形如： | `YQ_DB` | `data/yuque.db` | 说明 |
 *
 * ⚠️ 第一版只取**每行第一个**反引号变量，于是
 *   | `YQ_SSO_NAME_HEADER` / `YQ_SSO_EMAIL_HEADER` | 空 | … |
 * 这种**共用一行**的写法，第二个变量就被判成「源码读了、手册没写」——
 * 假阳性。而假阳性比漏报更坏：它会让人去改一份**本来正确**的手册。
 *   ⇒ 取第一个单元格里的**全部**反引号变量。
 */
const docRows = []
rbLines.forEach((l, i) => {
  const cells = l.split('|')
  if (cells.length < 4) return
  const vars = [...cells[1].matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1])
  if (!vars.length) return
  const def = cells[2].replace(/[`\s]/g, '').trim()
  for (const v of vars) docRows.push({ var: v, def, line: i + 1 })
})

console.log(`\n== 手册侧 ==`)
console.log(`  ${RUNBOOK}：${rbRaw.length} 字符 / 坏字 ${(rbRaw.match(/\uFFFD/g) || []).length} / 环境变量表 ${docRows.length} 行`)

ok((rbRaw.match(/\uFFFD/g) || []).length === 0,
  `${RUNBOOK} 里没有乱码替换字符（它是当前唯一完好的部署手册，坏了要有人知道）`)
ok(docRows.length >= 10,
  `环境变量表解析出来了（${docRows.length} 行 —— 解析不出来的话后面每条都是恒真）`)

/* ---------- 源码里真正被读的环境变量 ---------- */
function collectFiles(root) {
  const out = []
  ;(function w(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) w(p)
      else if (/\.ts$/.test(e.name)) out.push(p)
    }
  })(root)
  return out
}

const srcFiles = collectFiles('server')
const reads = new Map()   // var -> [{file, expr}]
for (const f of srcFiles) {
  const src = stripCode(fs.readFileSync(f, 'utf8'))
  const re = /process\.env\.([A-Z][A-Z0-9_]*)/g
  let m
  while ((m = re.exec(src))) {
    const v = m[1]
    // 记下这一行，用来比对默认值
    const lineStart = src.lastIndexOf('\n', m.index) + 1
    const lineEnd = src.indexOf('\n', m.index)
    const line = src.slice(lineStart, lineEnd < 0 ? undefined : lineEnd)
    if (!reads.has(v)) reads.set(v, [])
    reads.get(v).push({ file: f.split(path.sep).join('/'), line })
  }
}
console.log(`\n== 源码侧 ==`)
console.log(`  server/ ${srcFiles.length} 个文件，读到 ${reads.size} 个环境变量`)

const docVars = new Set(docRows.map((r) => r.var))

console.log('\n== A. 手册写了、源码没读（假旋钮）==')
const fake = docRows.filter((r) => !reads.has(r.var))
ok(fake.length === 0,
  '手册里的每个环境变量，源码里真的在读',
  fake.map((f) => `${f.var}（手册第 ${f.line} 行）`).join(', '))

console.log('\n== B. 源码读了、手册没写（隐藏的坑）==')
/* 部署时才关心的那批。PORT/YQ_DB 也在其中，手册里有。
   这个集合里若多出新变量，要么补手册，要么说明它不面向部署。 */
const UNDOCUMENTED_ALLOWED = new Set([
  // 只在测试/脚本里设、服务端读它没有部署含义的，不在这次范围里
])
const hidden = [...reads.keys()].filter((v) => !docVars.has(v) && !UNDOCUMENTED_ALLOWED.has(v))
ok(hidden.length === 0,
  '源码读的每个环境变量，手册里都有（部署出事时翻得到）',
  hidden.join(', '))

console.log('\n== C. `||` 形式的默认值逐条比对 ==')
{
  const mismatches = []
  for (const r of docRows) {
    const sites = reads.get(r.var) || []
    // 手册可能写成「不设 = …」「空」「—」这类描述句，不是字面量
    if (/^(不设|空|—|留空)/.test(r.def)) continue
    const literal = r.def.replace(/[。].*$/, '').trim()
    if (!literal || !/^[\w./@-]+$/.test(literal)) continue
    const hit = sites.some((s) => {
      const esc = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // 三种写法都要认：`||` 默认、`??` 默认、
      // 以及 `YQ_TRUST_PROXY === '0'` 这种「设某值才开」的形式
      return new RegExp(`\\|\\|\\s*['"]?${esc}['"]?`).test(s.line)
        || new RegExp(`\\?\\?\\s*['"]?${esc}['"]?`).test(s.line)
        || new RegExp(`===\\s*['"]${esc}['"]`).test(s.line)
    })
    if (!hit) {
      const sample = sites.map((s) => `${s.file}: ${s.line.trim()}`)[0] || '(源码里没找到读它的地方)'
      mismatches.push(`${r.var} 手册写 ${r.def}，源码是 → ${sample}`)
    }
  }
  ok(mismatches.length === 0, '手册写的默认值与源码一致', '\n     ' + mismatches.join('\n     '))
}

console.log('\n== E. 第 1 / 9 节教的那两条路必须真的走得通 ==')
/*
 * 这一条不属于上面的 A/B/C —— 变量名、默认值全对，**照样可能是错的文档**。
 *
 * 实测过（2026-10-12，真起服务数出来的）：
 *   不设 `YQ_DEMO` → **6 个账号 / 2 空间 / 4 知识库 / 26 篇文档**
 *   `YQ_DEMO=0`    → 1 个账号 / 1 空间 / 0 / 0
 *
 * 而第 1 节原来是「设三个变量」，**没有 `YQ_DEMO=0`**；
 * 第 3 节还写着「自动播种（管理员 + 个人空间）」——
 * 那只是第二种情况。照着最短路径抄，公司内网的知识库会自带
 * 四个演示库、26 篇文档，外加**五个你没创建过的账号**。
 *
 * 变量表里有 `YQ_DEMO`、默认值也写对了（`不设 = 播演示数据`），
 * 所以 A/B/C 三条**全绿** —— 手册是对的，只有**抄哪几行**是错的。
 * 这就是为什么守卫不能只查「文档与源码是否对得上」，
 * 还得查「文档教的那条路走下来到底会得到什么」。
 */
{
  const book = fs.readFileSync(RUNBOOK, 'utf8')
  const sec1 = /## 1\.[\s\S]*?\n---\n/.exec(book)?.[0] || ''
  ok(/YQ_DEMO\s*=\s*0/.test(sec1),
    '第 1 节的命令里有 `YQ_DEMO=0`（公司首次部署不要演示内容）',
    sec1 ? '第 1 节里没找到' : '连第 1 节都没解析出来')
  ok(/#\s*3\./.test(book) && /不设（默认值）/.test(book),
    '第 3 节写明了「不设 YQ_DEMO 会播演示内容」这件事')
  ok(!/播种（管理员 \+ 个人空间）/.test(book),
    '第 3 节不再把默认播种说成「管理员 + 个人空间」（那只是 YQ_DEMO=0 的情况）')

  /* 第 9 节原来写「迁移脚本是独立的，按需跑」—— **那个脚本不存在**。 */
  ok(!/迁移脚本是独立的/.test(book),
    '第 9 节不再让人去找一个不存在的迁移脚本')
  ok(/启动时自动补齐|自动补列/.test(book),
    '第 9 节写明表结构是**启动时自动补齐**的（真实机制是 db.ts 里的幂等 ALTER）')
  /* 而这条机制是真的：db.ts 里得有那段 ALTER，否则文档又在说空话。 */
  const dbSrc = fs.readFileSync('server/db.ts', 'utf8')
  ok(/ALTER TABLE \w+ ADD COLUMN/.test(dbSrc) && /PRAGMA table_info/.test(dbSrc),
    '而且源码里真有那套幂等补列（PRAGMA 查 + ALTER 加），不是文档凭空写的')

  /*
   * 第 6 节原来无条件说「配错 YQ_TRUSTED_PROXY_IPS = 谁也登不进来」。
   * 实测（2026-10-12）：配成一个不包含客户端的地址后，**口令登录照样拿到令牌** ——
   * 因为口令登录不看那个头，它只管 XFF 与统一认证头的信任。
   * 那句不区分「开没开统一认证」，会把人送去查一个可能根本不存在的问题。
   */
  ok(!/配错的后果是\*\*谁也登不进来\*\*/.test(book),
    '第 6 节不再无条件说「配错就谁也登不进来」（那只对开了统一认证的部署成立）')
  const authSrc = fs.readFileSync('server/auth.ts', 'utf8')
  ok(/if \(!fromTrustedProxy\(req\)\) return null/.test(authSrc),
    '而源码里 SSO 头确实在「来源不可信」时直接作废（所以那种部署才真会登不进来）')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)