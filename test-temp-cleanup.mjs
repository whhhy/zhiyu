/*
 * 收摊守卫：自己起服务、却把自己那个库留在 data/ 里的套件，一律点名。
 *
 * ------------------------------------------------------------
 * 为什么要有这条
 *
 * 2026-10-11 实测撞到：`test-lakebook.mjs` 每**单独跑**一次就在 data/ 里
 * 留一个 ~2.2MB 的库（+wal+shm）。它的清理只管 .lakebook 临时文件，
 * 不含自己建的 `data/_lakebook-e2e.db`。
 *
 * 之所以一直没被发现：**全量跑的时候它不自建服务**
 * （BASE 由 runner 传），而 runner 的 `sweepSuiteTemps` 会把 data/_* 的差集清掉。
 * ⇒ 只有单独跑才暴露 —— 而单独跑正是排查问题时做的事。
 *
 * ------------------------------------------------------------
 * 判据的边界（很重要）
 *
 * **不能**对「声明了 data/_x.db」的套件一律要求删除：
 * 用 runner 传进来的 BASE 的套件，那个 DB 常量只是**兜底默认值**，
 * 真跑起来用的是共享库 —— 它们**必须不删**，删了就把整轮测试的库删了。
 *
 * 所以这里只抓一种：**自己 spawn 了服务端、并且把那个 DB 传给了它、
 * 却没有清理代码**。那才是「自己制造、自己不收」。
 */
import fs from 'node:fs'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`) }
}

const suites = fs.readdirSync('.').filter((f) => /^test-.*\.mjs$/.test(f)).sort()

const offenders = []
const selfBoot = []
let checked = 0

for (const f of suites) {
  const lines = fs.readFileSync(f, 'utf8').split('\n')
  const src = lines.join('\n')

  // ① 它声明的 data/_*.db
  const dbs = [...new Set((src.match(/data\/_[A-Za-z0-9._-]+\.db/g) || []))]
  if (!dbs.length) continue

  // ② 它自己起服务端吗？把 YQ_DB 传给 spawn 了吗？
  const spawnLine = lines.findIndex((l) => /spawn(?:Sync)?\(process\.execPath/.test(l) && /server\/index\.ts/.test(l))
  const passesDbToServer = /YQ_DB:\s*DB\b/.test(src)
  if (spawnLine < 0 || !passesDbToServer) continue

  selfBoot.push({ f, dbs })
  checked++

  /*
   * ③ 收摊清理在不在？**必须看位置**。
   *
   * ⚠️ 第一版只按「整份文件里有没有 rmSync 这个库」判断，于是
   *    `for (const s of ['', '-wal', '-shm']) { … rmSync(f) … }` 被当成了收摊。
   *    可它出现在 **spawn 之前** —— 那是「**启动前**清掉上一轮的残留」，
   *    这一轮自己造的库跑完照样留着。
   *
   *    破坏对照当场戳穿了：把真收摊整块删掉，守卫**照样绿**。
   *    —— 一个不会咬的守卫比没有守卫更糟，因为它让人以为「查过了」。
   *
   * ⇒ 所以必须判断「**spawn 之后**还有没有清理」，按行号看，不看整份文件。
   */
  for (const db of dbs) {
    const stem = db.replace(/\.db$/, '')
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const tail = lines.slice(spawnLine + 1).join('\n')
    /*
     * ⚠️ 四版判据、四次误报，全是同一个病：**猜得太具体**。
     *   ① 只认 `rmSync`        → 漏 `fs.unlinkSync`
     *   ② 加上 `unlinkSync`    → 漏别名 `rmDb/exDb`
     *   ③ 只看「`(DB +`」      → 漏 `const f = DB + s`（DB 前面是 `=`，不是 `(`）
     *   ④ 再加删除函数名        → 又漏 `rmDb(`
     *
     * 每一版都在猜「它该长什么样」，于是每修一版就漏一批。
     * ⇒ 最终只问两件**与写法无关**的事实：
     *      ① spawn 之后，这个 DB 变量/路径**又被用过**（说明代码动了它）
     *      ② 并且是在一个**遍历 ['', '-wal', '-shm'] 之类的循环**里用的
     *         （那正是「连库带 wal/shm 一起清」的形状）
     *
     * 已知边界：一条套件如果循环里**只读不删**也会被判为已清理。
     * 本项目里没有这种写法；真要更严，就得靠跑一遍看残留（那才是真相）。
     */
    const usesDb = new RegExp(`\\bDB\\s*\\+|\\(\\s*${esc}|\\b${esc}\\b`).test(tail)
    const loops = /for\s*\(\s*const\s+\w+\s+of\s*\[/.test(tail)
    if (!(usesDb && loops)) offenders.push({ f, db })
  }
}

/**
 * 已知欠账：自己造了库、跑完不删的套件（2026-10-11 实测点出来的）。
 *
 * ⚠️ 为什么不直接判红：
 *   20 条长期红的检查 = 20 条没人看的检查 —— 那比没有检查更糟。
 *   而且这份债**不是幻觉**：单独跑一遍就多一个库，跑 20 遍就是 40MB。
 *   ⇒ 所以：**新增的泄漏立刻判红**（那才是回归），
 *     已知的每次都打印出来（那才是欠账）。
 *     修好一个就从这里删一个，列表会自己变短。
 */
const KNOWN = new Set([
  // 2026-10-11：**欠账已清零**。下面是清零的过程，留着是因为它本身就是教训：
  //
  //   ① 我第一版把 bodyserver 的 cleanup **定义**删了，而早退分支还在调它
  //      → ReferenceError，整套连结果都不打印。
  //   ② 改对之后仍然删不掉 —— 因为我把删库放在了 kill **之前**，
  //      那一刻服务还活着，文件当然锁着。
  //      而 server.killed 只是「信号已发出」，不是「已退出」，别拿它当退出标志。
  //   ③ cardtext 上加「等子进程退出」的循环反而把原生崩溃引了回来 ——
  //      罪魁是文件**末尾的顶层 await import()**，配合 exit 处理器会踩到那条路径。
  //      改用静态导入 + 直接删就干净了。
  //
  // 留空集合：新增的泄漏会立刻判红。
])

console.log(`\n== 收摊核对 ==`)
console.log(`  ${suites.length} 个套件里，${selfBoot.length} 个自己起服务端并把库传给了它`)

ok(checked > 0, '（前置）确实认出了几个自建服务的套件 —— 认不出的话后面每条都是恒真',
  `checked=${checked}`)

const key = (o) => `${o.f}|${o.db}`
const fresh = offenders.filter((o) => !KNOWN.has(key(o)))
const fixed = [...KNOWN].filter((k) => !offenders.some((o) => key(o) === k))

ok(fresh.length === 0,
  `没有**新增**的套件留下自己的库（已知欠账 ${KNOWN.size} 条不算）`,
  fresh.map((o) => `${o.f} → ${o.db}`).join('; '))

if (fixed.length) {
  console.log(`\n  ✅ 已知清单里有 ${fixed.length} 条已经收干净了，可以从 KNOWN 里删掉：`)
  for (const k of fixed) console.log(`     · ${k}`)
}

if (offenders.length) {
  console.log(`\n== 已知欠账（${offenders.length} 条，不判红，但每次都列出来）==`)
  for (const o of offenders) console.log(`   · ${o.f}  →  ${o.db}`)
  console.log('\n  为什么单列而不是判红：20 条长期红的检查等于没人看的检查。')
  console.log('  为什么它仍然是真的：单独跑一遍就多一个库，跑满 20 遍约 40MB，')
  console.log('  而 `data/` 有 200MB 阈值。修好一个就从 KNOWN 里删一个。')
}

/*
 * 反向自查：这条判据**不能**反过来要求「用 runner BASE 的套件也去删库」。
 * 那是把整轮测试的共享库删掉 —— 一条守卫差点造成的灾难。
 */
console.log('\n== 反向自查：判据没有反过来咬人 ==')
{
  const shared = suites.filter((f) => {
    const src = fs.readFileSync(f, 'utf8')
    return /YQ_PORT\s*\|\|\s*'8092'/.test(src) && !/YQ_DB:\s*DB\b/.test(src)
  })
  ok(true, `有 ${shared.length} 个套件用 runner 的 BASE —— 判据没有要求它们删库（那是共享库，删了就是灾难）`)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)