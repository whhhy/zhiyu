/**
 * 部署完整性检查。
 *
 * 2026-10-06 由 smoke-deploy.cjs 转为回归套件：那个脚本是 16 个 smoke 里
 * **唯一原本跑不起来**的（4173 上得先有人跑着 preview），而部署完整性恰恰是
 * 内网交付前最该跑的一项 —— 最该跑的那项反而跑不了，1 秒就退。
 * 现在连不上时会自起本地静态服务；SMOKE_BASE 指向远端却连不上，**一律判失败**
 * （那正是要报的故障，不许悄悄退回本地，那样会把「部署挂了」变成「验的是本地」）。
 * 之前出现过「测试全绿但线上 CSS 返回 503」——
 * 因为大部分用例只断言 DOM 结构，不依赖样式，样式整个挂掉也测不出来。
 * 这个脚本只干一件事：把首页引用的每个资源真实取一遍，确认状态码和体积。
 *
 * 用法：SMOKE_BASE=https://xxx node smoke-deploy.cjs
 */
import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

/** ESM 下没有 __dirname */
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const DIST = process.env.SMOKE_DIST || 'dist'
let BASE = process.env.SMOKE_BASE || 'http://localhost:4173'

/**
 * 为什么加这段。
 *
 * 这个脚本原来是**唯一跑不起来的一个**：16 个 smoke 脚本里只有它依赖外部前提 ——
 * 4173 上得先有个人跑着 `vite preview`。没人在跑的时候它 1 秒就退，
 * 报「首页 0 / ERR_CONNECTION_REFUSED」。而「部署完整性」恰恰是内网交付前
 * 最该跑的一项，**最该跑的一项反而是唯一跑不了的**。
 *
 * 所以：连不上的时候，如果目标是本机、且 dist/ 在，就自起一个静态服务验 dist/。
 *
 * ⚠️ 但**绝不能因此变绿**：自起服务验的是「构建产物本身完整」，
 * 不是「线上那台部署好了」。所以输出里必须明写这一点，
 * 而且 SMOKE_BASE 指向**远端**而连不上时，一律判失败 —— 那正是要报的故障。
 */
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(BASE)
let selfStarted = null

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }
const staticServer = () => new Promise((resolve, reject) => {
  if (!fs.existsSync(DIST)) return reject(new Error(`没有 ${DIST}/ 目录，先跑 npm run build`))
  const srv = http.createServer((req, res) => {
    const u = req.url.split('?')[0]
    let f = path.join(__dirname, DIST, u === '/' ? 'index.html' : u)
    if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(__dirname, DIST, 'index.html')
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
    res.end(fs.readFileSync(f))
  })
  srv.listen(0, () => resolve(srv))
})

const reachable = (base) => new Promise((resolve) => {
  const mod = base.startsWith('https') ? https : http
  const req = mod.get(base + '/', { timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode < 500) })
  req.on('error', () => resolve(false))
  req.on('timeout', () => { req.destroy(); resolve(false) })
})

// 沙箱出网是自签代理证书，Node 原生 https 默认会拒绝
const NO_VERIFY = /^https:/.test(BASE) ? { rejectUnauthorized: false } : {}

const get = (url) => new Promise((resolve) => {
  const mod = url.startsWith('https') ? https : http
  mod.get(url, NO_VERIFY, (res) => {
    let n = 0
    res.on('data', (c) => (n += c.length))
    res.on('end', () => resolve({ status: res.statusCode, bytes: n }))
  }).on('error', () => resolve({ status: 0, bytes: 0 }))
})

;(async () => {
  let fail = 0
  let okN = 0
  const t = async (name, fn) => {
    try { await fn(); okN++; console.log(`✅ ${name}`) }
    catch (e) { fail++; console.log(`❌ ${name}\n   ${e.message}`) }
  }

  // 先看目标在不在
  if (!(await reachable(BASE))) {
    if (LOOPBACK) {
      selfStarted = await staticServer()
      const port = selfStarted.address().port
      BASE = `http://localhost:${port}`
      console.log(`⚠️  ${process.env.SMOKE_BASE || 'http://localhost:4173'} 连不上，已自起本地静态服务验 ${DIST}/（${BASE}）`)
      console.log('    这验的是**构建产物本身完整**，**不是**线上那台部署好了 ——')
      console.log('    要验真实部署，把 SMOKE_BASE 指到它；指了却连不上，下面会直接判失败。')
    } else {
      console.log(`❌ 连不上 ${BASE}`)
      console.log('    SMOKE_BASE 指向的是**远端**，连不上就该判失败 —— 这正是要报的问题。')
      console.log('    不会自动退回本地静态服务，那样会把「部署挂了」变成「验的是本地」。')
      console.log(`\n结果：1 通过 / 1 失败`)
      process.exit(1)
    }
  }

  const assets = await new Promise((resolve) => {
    const mod = BASE.startsWith('https') ? https : http
    mod.get(BASE + '/', NO_VERIFY, (res) => {
      let b = ''
      res.on('data', (c) => (b += c))
      res.on('end', () => resolve([...b.matchAll(/(?:src|href)="\.?\/?(assets\/[^"]+)"/g)].map((m) => m[1])))
    }).on('error', () => resolve([]))
  })

  await t('首页可访问且能解析出资源引用', async () => {
    const r = await get(BASE + '/')
    if (r.status !== 200) throw new Error(`首页 ${r.status}`)
    if (!assets.length) throw new Error('首页里没解析到 assets 引用')
    console.log(`   引用了 ${assets.length} 个资源：${assets.join(', ')}`)
  })

  for (const a of assets) {
    await t(`资源 ${a} 可下载且非空`, async () => {
      const r = await get(`${BASE}/${a}`)
      if (r.status !== 200) throw new Error(`状态码 ${r.status}`)
      if (r.bytes < 1000) throw new Error(`体积异常 ${r.bytes}B，可能是错误页`)
      console.log(`   ${r.status} · ${(r.bytes / 1024).toFixed(0)} KB`)
    })
  }

  await t('真实浏览器加载后样式已生效（body 有背景色）', async () => {
    const b = await chromium.launch()
    const p = await b.newPage({ ignoreHTTPSErrors: /^https:/.test(BASE) })
    const failed = []
    p.on('requestfailed', (r) => failed.push(r.url()))
    p.on('response', (r) => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`) })
    await p.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-dash-greeting', { timeout: 25000 })
    await p.waitForTimeout(800)
    const info = await p.evaluate(() => ({
      sheets: document.styleSheets.length,
      bg: getComputedStyle(document.body).backgroundColor,
      barH: (() => { const e = document.querySelector('.yq-topbar'); return e ? getComputedStyle(e).height : 'n/a' })(),
    }))
    await b.close()
    if (failed.length) throw new Error('有资源加载失败: ' + failed.slice(0, 3).join(' | '))
    if (!info.sheets) throw new Error('一个样式表都没加载')
    if (info.bg === 'rgba(0, 0, 0, 0)' || info.bg === 'rgb(255, 255, 255)') {
      throw new Error(`body 背景色没生效（${info.bg}），CSS 很可能没加载`)
    }
    if (info.barH === '0px' || info.barH === 'n/a') throw new Error('顶栏没有高度，布局 CSS 缺失')
    console.log(`   ${info.sheets} 个样式表 · body 背景 ${info.bg} · 顶栏高 ${info.barH}`)
  })

  /* 汇总行逐字用「结果：N 通过 / M 失败」——
   run-all-tests.mjs:401 按这条正则计数，写成别的语序整套件会被判「本身异常」。 */
  console.log(`\n结果：${okN} 通过 / ${fail} 失败`)
  if (fail === 0) console.log('部署完整')
  if (selfStarted) selfStarted.close()
  process.exit(fail ? 1 : 0)
})()
