/*
 * 团队主页「堆叠卡」（book_stacks）—— 真浏览器端到端 + 源码层守卫。
 *
 * ------------------------------------------------------------
 * 这条形态的来历（2026-10-15 登录态实测真实语雀）
 *
 * `www.yuque.com/yuque` 的 `group.settings.homepage.layout`：
 *   header:  ["search_input", "headlines"]
 *   content: ["book_stacks"]
 *   aside:   ["topics", {最近发布的文档}, "latest_books"]
 *
 * ⚠️ 但**只有 content 里的 book_stacks 是真的**：
 *    aside 那三项在真实页面上根本没有渲染（导出的 71 万字节 HTML 里
 *    「最近发布的文档」「最近更新的知识库」各出现 0 次），
 *    nav 里也没有「议题」—— `/yuque/issues` 直接 404。
 *    照着配置项去实现一整条侧栏，就是臆造语雀自己都没显示的东西。
 *
 *    book_stacks 的实际样子：**一本书一张大卡**，
 *    卡内列出该库最近 3 篇文档 + `MM-DD HH:mm` 时间戳。
 *
 * ------------------------------------------------------------
 * 为什么单独一个套件
 *
 * 改之前团队页的「团队知识库」是**一行式列表，而且根本不能点** ——
 * 在团队页上看到有哪些库，却一个都打不开。这不是形态差异，
 * 是「看得见、进不去」。所以这里钉的不只是「长得像」，
 * 还钉「点得动、点得对」。
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { once } from 'node:events'

const ADMIN_PASS = process.env.ADMIN_PASS || 'yuque@2026'
const OUT = 'docs/shots'
mkdirSync(OUT, { recursive: true })

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

let ownSrv = null
let BASE = process.env.BASE

if (!BASE) {
  const PORT = process.env.STACKS_PORT || await freePort()
  const DB = 'data/_team-stacks.db'
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着 */ } }
  }
  if (await fetch(`http://localhost:${PORT}/api/health`).then((r) => r.ok).catch(() => false)) {
    console.error(`端口 ${PORT} 上已经有服务在跑 —— 自起服务会打错目标，结果不可信。`)
    process.exit(1)
  }
  ownSrv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: ADMIN_PASS, ADMIN_PASS },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  let up = false
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) { up = true; break } } catch { /* 等 */ }
  }
  if (!up) { console.error('自起服务没能在 20 秒内起来'); try { ownSrv.kill() } catch { }; process.exit(1) }
  BASE = `http://localhost:${PORT}`
  console.log(`\n== 自起服务 ${BASE} ==`)
}

try {
  const { chromium } = await import('playwright')
  const br = await chromium.launch()
  try {
    const p = await (await br.newContext()).newPage()
    await p.goto(BASE, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-login-card', { timeout: 25000 })
    await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
    await p.fill('.yq-login-card input[type="password"]', ADMIN_PASS)
    await p.click('.yq-login-submit')
    await p.waitForSelector('.yq-app', { timeout: 30000 })

    await p.goto(`${BASE}/#/?tab=team`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-stack-grid', { timeout: 25000 })
    await p.waitForTimeout(800)

    console.log('\n== 堆叠卡：结构 ==')
    const cards = p.locator('.yq-stack')
    const nCards = await cards.count()
    ok(nCards > 0, `团队页渲染出了堆叠卡（${nCards} 张）`, String(nCards))

    const titles = await p.locator('.yq-section-title').allTextContents()
    ok(titles.some((t) => t.includes('知识库')), '主区有「知识库」这一节（书是主内容）',
      JSON.stringify(titles))
    ok(titles.some((t) => t.includes('成员')), '成员被挪到了侧栏', JSON.stringify(titles))

    /* 每张卡的库名都必须是一个**能点**的链接。
       旧形态那几行是纯 div —— 看得见、进不去。 */
    console.log('\n== 堆叠卡：点得动（这一条才是重点）==')
    const first = cards.first()
    /*
     * ⚠️ 路由是 **HashRouter**，所以 `<Link to="/book/b1">` 渲染出来的
     *   `href` 是 `#/book/b1` 而不是 `/book/b1`。
     *   第一次写断言时按 `/book/...` 判，套件红了两条 —— 那是**判据**错了，
     *   不是产品错了。所以这里两种形状都收，只认末尾那段路径。
     */
    const routePath = (h) => String(h || '').replace(/^#/, '')
    const bookHref = await first.locator('.yq-stack-head').getAttribute('href')
    ok(!!bookHref && /^\/book\/[^/]+$/.test(routePath(bookHref)),
      '卡面是到书页的链接', `实际 href=${bookHref}`)

    const docLinks = first.locator('.yq-stack-doc[href]')
    const nDocs = await docLinks.count()
    ok(nDocs > 0, `卡内列出了文档（${nDocs} 条）`, String(nDocs))

    const firstDocHref = nDocs ? await docLinks.first().getAttribute('href') : ''
    ok(!!firstDocHref && /^\/book\/[^/]+\/doc\/[^/]+$/.test(routePath(firstDocHref)),
      '文档是到那篇文档的链接（bookId 与卡面同一个）', `实际 href=${firstDocHref}`)
    ok(!!bookHref && !!firstDocHref &&
      routePath(firstDocHref).split('/doc/')[0] === routePath(bookHref),
      '卡内文档的 bookId 与这张卡是同一个库（别串到别的书去）',
      `${firstDocHref} vs ${bookHref}`)

    /* 时间戳格式照语雀：`06-25 13:57`，不是「3 天前」 */
    console.log('\n== 堆叠卡：时间戳 ==')
    const ats = await first.locator('.yq-stack-doc-at').allTextContents()
    const at = (ats[0] || '').trim()
    ok(/^\d{2}-\d{2} \d{2}:\d{2}$/.test(at),
      `时间戳是「月-日 时:分」（${at}），与语雀一致`, `实际=「${at}」`)

    /* 真的点进去 —— 链接对不对，只有跳一次才知道 */
    console.log('\n== 堆叠卡：真点一次 ==')
    if (nDocs) {
      const cardTitle = ((await docLinks.first().locator('.yq-stack-doc-t').textContent()) || '').trim()
      await docLinks.first().click()
      await p.waitForFunction(
        () => /#\/book\/[^/]+\/doc\/[^/]+/.test(location.hash),
        null, { timeout: 15000 },
      ).catch(() => {})
      const hash = await p.evaluate(() => location.hash)
      ok(hash.includes('/doc/'), '点文档真的跳到了那一篇', `hash=${hash}`)

      /*
       * 判据用文档顶栏的标题 `.yq-doc-bar-title`。
       * 这里连着判错过三次，全记下来：
       *   ① `.yq-doc-title` —— 文档型文稿**没有**这个类，它的标题就是
       *      正文的第一个 H1 块（DocPage.tsx 1179-1204，照语雀的做法）；
       *   ② `.yq-tree-item.is-active[data-node-title]` —— 目录默认**折叠态**，
       *      渲染的是 `.yq-tree-collapsed-item`，那个元素上没有这个属性；
       *   ③ `.yq-doc-crumb-cur.is-doc` —— 那是**顶栏**的面包屑
       *      （`.yq-topbar-crumb*`），只到空间/知识库一级，压根不含文档名。
       * 教训：连着两次判据红而产品没问题时，就把 DOM 倒出来看，别再接着猜。
       */
      await p.waitForSelector('.yq-doc-bar-title', { timeout: 15000 }).catch(() => {})
      const shown = await p.evaluate(() => {
        const el = document.querySelector('.yq-doc-bar-title')
        return el ? (el.textContent || '').trim() : ''
      })
      ok(!!shown && shown === cardTitle,
        '跳过去之后顶栏标题就是卡上写的那一篇', `顶栏=「${shown}」卡=「${cardTitle}」`)
      await p.screenshot({ path: `${OUT}/team-stacks.png` })
    }

    /* 书名那一层也要真能点开 */
    await p.goto(`${BASE}/#/?tab=team`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-stack-head', { timeout: 15000 })
    await cards.first().locator('.yq-stack-head').click()
    await p.waitForFunction(() => /#\/book\/[^/]+$/.test(location.hash), null, { timeout: 15000 }).catch(() => {})
    const bhash = await p.evaluate(() => location.hash)
    ok(/#\/book\/[^/]+$/.test(bhash), '点卡面真的打开了那个知识库', `hash=${bhash}`)
  } finally {
    await br.close()
  }
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
}

console.log('\n== 源码层：TeamTab 必须走 computeBookRecentDocs ==')
{
  /*
   * 纯函数与 UI 各钉一半。数据规则由 test-bookstats 管，
   * 这里钉的是「TeamTab 真的用了它」——
   * 万一有人图省事改成直接遍历 `docs` 取最近三篇，
   * 私有文档标题就会顺着这张卡漏出去，而界面看上去完全正常。
   */
  const src = readFileSync('src/pages/Dashboard.tsx', 'utf8')
  ok(src.includes('useBookRecentDocs'), 'Dashboard 用的是 useBookRecentDocs 这条钩子')
  ok(/from '@\/lib\/useBookStats'/.test(src) && /useBookRecentDocs/.test(src),
    '它是从共享取数层引进来的，不是另写一份')
  const team = src.slice(src.indexOf('function TeamTab'), src.indexOf('/* ---------------- 讨论'))
  ok(team.length > 0 && !/\bdocs\s*\.\s*(values|Object)/.test(team),
    'TeamTab 里没有绕过取数层直接遍历 docs（那样会漏掉可见性过滤）')
  ok(team.includes('/doc/'), 'TeamTab 里的文档链接用的是路由形状 /book/:bookId/doc/:docId')
}

if (ownSrv) {
  const exited = once(ownSrv, 'exit')
  ownSrv.kill()
  const won = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))])
  if (!won) { try { ownSrv.kill('SIGKILL') } catch { /* 已经没了 */ } }
  const db = 'data/_team-stacks.db'
  for (const s of ['', '-wal', '-shm']) {
    const f = db + s
    if (!existsSync(f)) continue
    let gone = false
    for (let i = 0; i < 5 && !gone; i++) {
      try { rmSync(f, { force: true }); gone = true } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
    if (!gone) console.log(`  ⚠️  临时库删不掉：${f}`)
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
