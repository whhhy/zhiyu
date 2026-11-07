/**
 * 冒烟测试：真实浏览器跑一遍主要路径，捕获运行时错误 + 截图
 */
const { chromium } = require('playwright')
const http = require('http')
const fs = require('fs')
const path = require('path')
const DIST = process.env.SMOKE_DIST || 'dist'

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0]
  let f = path.join(__dirname, DIST, u === '/' ? 'index.html' : u)
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(__dirname, DIST, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
  res.end(fs.readFileSync(f))
})

// 用随机高端口：多个测试进程可能并发跑，避免 EADDRINUSE
/* ⚠️ `SMOKE_BASE` **只能指向本地模式的实例**（无鉴权网关的那种）。
 *
 * 2026-10-07 实测：把它指到部署实例（`SMOKE_BASE=http://host:8090 node smoke.cjs`）
 * 会 **17 通过 / 29 失败** —— 不是部署产物坏了，是**这个套件结构性地依赖本地模式**：
 *   · 它没有登录流程，全程停在登录页；
 *   · 断言大量假设「localStorage 就是真相」（如最后一条就叫「localStorage 持久化」），
 *     服务端模式里真相在服务端；
 *   · 有些用例直接调 `window.__yqStore.getState().createDoc(...)` 而不同步，
 *     服务端会以 403 拒掉那次写入 —— 实测的 console 403 就是这么来的，
 *     而**同一个部署实例上六个主要路径（工作台/协作/知识库/文档/设置/搜索）一个 403 都没有**，
 *     所以那 403 是套件的假设造成的，不是产品缺陷。
 *
 * 我试过给它加一段「有登录页就先登录」，结果照样 29 失败 —— 登录只是第一道门，
 * 后面的假设要一条条改。**半套的改动比没有更糟**（看起来支持了、实际不能用），所以回退。
 *
 * 要验部署实例，现在用**能登录的套件**（它们本来就是按服务端写的）：
 *   node smoke-cards.cjs              27 张卡片真实插入 + 交互 + 刷新恢复
 *   npm test:permissions             权限与只读态
 *   npm run test:mdimport            Markdown 导入端到端
 * 把主套件改造成服务端模式可用，是一件独立的活（29 条要逐条核假设）。 */
const PORT = 4200 + Math.floor(Math.random() * 600)
const BASE = process.env.SMOKE_BASE || `http://localhost:${PORT}`
// ⚠️ 这里原来写死的是 '/workspace/yuque/.smoke…' —— Linux 开发环境的残留。
//    在 Windows 上它被解析成 `H:\workspace\yuque\.smoke`，**截图落在工作区外面、
//    盘根下面**，而 .gitignore 里明明列着这些目录名（本来的意图就是放在项目根）。
//    实测一次就堆了 15.1MB，而且**没有任何地方会报**。
//    截图是手动套件唯一的失败取证手段，落在人不会去看的地方，
//    「失败了但看不出为什么」和「套件没跑」长得一模一样。
//    所以改成脚本所在目录；要放别处用 SMOKE_OUT 覆盖。
const OUT = process.env.SMOKE_OUT || path.join(__dirname, '.smoke')
fs.mkdirSync(OUT, { recursive: true })

const errors = []
const steps = []

;(async () => {
  await new Promise((r) => server.listen(PORT, r))
  const browser = await chromium.launch()
    const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    // 沙箱出网是自签代理证书，Chromium 不信任；线上真实访问不需要这个开关
    ignoreHTTPSErrors: process.env.SMOKE_BASE ? /^https:/.test(process.env.SMOKE_BASE) : false,
  })
  const page = await ctx.newPage()

  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console] ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

  const shot = async (name) => {
    await page.screenshot({ path: `${OUT}/${name}.png` })
  }

  const check = async (label, fn) => {
    const before = errors.length
    try {
      await fn()
      const newErrs = errors.slice(before)
      steps.push({ label, ok: newErrs.length === 0, errs: newErrs })
      console.log(`${newErrs.length === 0 ? '✅' : '❌'} ${label}${newErrs.length ? '\n   ' + newErrs.join('\n   ') : ''}`)
    } catch (e) {
      steps.push({ label, ok: false, errs: [e.message] })
      console.log(`❌ ${label}\n   ${e.message}`)
    }
  }

  // 1. 工作台
  await check('工作台首页', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-dash-greeting', { timeout: 5000 })
    const t = await page.textContent('.yq-dash-greeting')
    if (!t || !t.includes('好')) throw new Error('问候语未渲染: ' + t)
    await shot('01-dashboard')
  })

  // 2. 工作台各 tab
  for (const [tab, sel] of [
    ['book', '.yq-book-grid'],
    ['team', '.yq-team-hero'],
    ['collab', '.yq-collab-list'],
    ['discuss', '.yq-list-row'],
    ['follow', '.yq-list-row'],
    ['favorite', '.yq-list-row'],
  ]) {
    await check(`工作台 tab=${tab}`, async () => {
      await page.goto(`${BASE}/#/?tab=${tab}`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(sel, { timeout: 5000 })
      await shot(`02-tab-${tab}`)
    })
  }

  // 3. 知识库主页
  await check('知识库主页', async () => {
    await page.goto(`${BASE}/#/book/b1`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-toc-row', { timeout: 5000 })
    const rows = await page.locator('.yq-toc-row').count()
    if (rows < 5) throw new Error(`目录行数异常: ${rows}`)
    await shot('03-book')
  })

  // 4. 文档页
  await check('文档页渲染', async () => {
    await page.goto(`${BASE}/#/book/b1/doc/d2`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block', { timeout: 5000 })
    const blocks = await page.locator('[data-block-id]').count()
    if (blocks < 5) throw new Error(`块数异常: ${blocks}`)
    const tree = await page.locator('.yq-tree-item').count()
    if (tree < 4) throw new Error(`目录树根节点异常: ${tree}`)
    await shot('04-doc')
  })

  // 5. Markdown 快捷输入（在空块上逐字输入，模拟真实打字）
  await check('Markdown 快捷输入 # → h2', async () => {
    const nid = await page.evaluate(() => window.__yqStore.getState().createDoc('b1', 'n2', '编辑器测试'))
    await page.goto(`${BASE}/#/book/b1/doc/${nid}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block-text')

    // 首块是 H1（文档标题）。先给标题命名，再回车开新块测转换
    const title = page.locator('.yq-block-text').first()
    await title.click()
    await page.keyboard.type('我的测试文档', { delay: 20 })
    await page.waitForTimeout(200)
    let docTitle = await page.locator('.yq-doc-bar-title').textContent()
    if (!docTitle.includes('我的测试文档')) throw new Error('首块 H1 未同步到文档标题: ' + docTitle)

    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)
    const target = page.locator('.yq-block-text').nth(1)
    await target.click()
    await page.keyboard.type('##', { delay: 40 })
    await page.keyboard.press('Space', { delay: 40 })
    await page.waitForTimeout(200)
    const cls = await page.locator('[data-block-id]').nth(1).getAttribute('class')
    if (!cls.includes('h2')) throw new Error('# 未转换为 h2, class=' + cls)
    await page.keyboard.type('转换成功', { delay: 30 })
    const txt = await page.locator('.yq-block-text').nth(1).textContent()
    if (!txt.includes('转换成功')) throw new Error('转换后输入丢失: ' + txt)
    await shot('05-md-convert')
  })

  // 6. 斜杠菜单
  await check('斜杠菜单 /', async () => {
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('/', { delay: 40 })
    await page.waitForSelector('.yq-slash', { timeout: 3000 })
    const items = await page.locator('.yq-slash-item').count()
    if (items < 10) throw new Error('菜单项过少: ' + items)
    await shot('06-slash')
    await page.keyboard.type('todo', { delay: 40 })
    await page.waitForTimeout(200)
    const filtered = await page.locator('.yq-slash-item').count()
    if (filtered === 0 || filtered >= items) throw new Error('过滤未生效: ' + filtered)
    await shot('06b-slash-filter')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    const last = page.locator('[data-block-id]').last()
    const cls = await last.getAttribute('class')
    if (!cls.includes('todo')) throw new Error('斜杠选择未转换块类型: ' + cls)
    // 触发用的 "/" 必须被清掉：text 和 html 都要清，
    // 只清 text 的话 BlockRow 会拿旧 html 把 "/" 写回 DOM
    const left = await last.locator('.yq-block-text').innerText()
    if (left.trim() !== '') throw new Error(`斜杠触发字符没清干净: ${JSON.stringify(left)}`)
  })

  // 6b. 语雀特色：拼音 / 首字母 / 中文 搜索 + 最近使用
  await check('卡片面板：拼音/首字母/中文搜索 + 最近使用', async () => {
    /**
     * 用 d2 这篇已有文档，不要 createDoc。
     * 之前改成"新建文档做自包含"反而把新节点插进了 b1 的目录树，
     * 污染了后面依赖树结构的用例（大纲 / 拖拽）。
     * 正确的隔离方式是：显式点击定位到目标块，不依赖上一个用例留下的光标位置。
     */
    await page.goto(`${BASE}/#/book/b1/doc/d2`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block-text')
    const N = await page.locator('.yq-block-text').count()

    // 始终在最后一个块上开面板：先回到底部再回车新起一块，位置确定
    const openPanel = async () => {
      await page.locator('.yq-block-text').nth(N - 1).click()
      await page.keyboard.press('End')
      await page.keyboard.press('Enter')
      await page.waitForTimeout(220)
      await page.locator('.yq-block-text').nth(N).click()
      await page.keyboard.press('End')
      await page.keyboard.type('/', { delay: 30 })
      await page.waitForSelector('.yq-slash-cards', { timeout: 3000 })
    }
    const names = () => page.locator('.yq-slash-item .yq-slash-name').allTextContents()

    // 全拼 tupian → 图片
    await openPanel()
    await page.keyboard.type('tupian', { delay: 20 })
    await page.waitForTimeout(200)
    let n = await names()
    if (!n.includes('图片')) throw new Error('全拼 tupian 未命中图片: ' + JSON.stringify(n))
    await shot('06c-pinyin-full')

    // 拼音首字母 swdt → 思维导图
    // 注意：只删搜索词本身，多删一次会连触发用的 "/" 一起删掉导致面板关闭
    for (let i = 0; i < 'tupian'.length; i++) await page.keyboard.press('Backspace')
    await page.waitForTimeout(150)
    await page.keyboard.type('swdt', { delay: 20 })
    await page.waitForTimeout(200)
    n = await names()
    if (!n.includes('思维导图')) throw new Error('首字母 swdt 未命中思维导图: ' + JSON.stringify(n))

    // 中文「日历」
    for (let i = 0; i < 'swdt'.length; i++) await page.keyboard.press('Backspace')
    await page.waitForTimeout(150)
    await page.keyboard.type('日历', { delay: 30 })
    await page.waitForTimeout(200)
    n = await names()
    if (!n.includes('日历')) throw new Error('中文「日历」未命中: ' + JSON.stringify(n))
    await page.keyboard.press('Escape')

    // 用掉一个卡片后，空面板应出现「最近使用」
    await openPanel()
    await page.keyboard.type('siweidaotu', { delay: 20 })
    await page.waitForTimeout(200)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    await openPanel()
    const hasRecent = await page.locator('.yq-slash-group-label', { hasText: '最近使用' }).count()
    if (hasRecent === 0) throw new Error('未展示最近使用')
    await shot('06d-recent')
    await page.keyboard.press('Escape')
  })

  // 7. 大纲
  await check('大纲：钉住 → 隐藏成 mini → 悬浮展开 → 重新钉住', async () => {
    await page.waitForSelector('.yq-outline-item', { timeout: 3000 })
    const n = await page.locator('.yq-outline-item').count()
    if (n === 0) throw new Error('大纲条目为空')
    await shot('07a-outline-pinned')

    // 点图钉 → 隐藏成右侧 mini 边
    await page.click('.yq-outline-pin')
    await page.waitForSelector('.yq-outline-mini', { timeout: 3000 })
    if (await page.locator('.yq-outline-float').isVisible())
      throw new Error('mini 态下浮层未隐藏')
    if (await page.locator('.yq-doc-scroll').evaluate((e) => e.clientWidth) < 100)
      throw new Error('异常')
    await shot('07b-outline-mini')

    // 悬浮 mini → 展开浮层
    await page.hover('.yq-outline-mini')
    await page.waitForSelector('.yq-outline-float', { timeout: 3000 })
    await page.waitForTimeout(600) // 等淡入动画结束，否则 Playwright 判定元素不稳定
    const f = await page.locator('.yq-outline-float .yq-outline-item').count()
    if (f === 0) throw new Error('悬浮未展开大纲')
    await shot('07c-outline-float')

    // 再点图钉 → 钉回侧栏
    // 浮层带淡入动画，Playwright 的稳定性判定会反复重试，这里直接派发点击
    await page.locator('.yq-outline-float .yq-outline-pin').dispatchEvent('click')
    await page.waitForTimeout(300)
    if (await page.locator('.yq-outline:not(.yq-outline-float)').count() === 0)
      throw new Error('未钉回侧栏')
  })

  // 7b. 超宽模式
  await check('超宽模式切换', async () => {
    const narrow = await page.locator('.yq-doc-content').evaluate((e) => e.clientWidth)
    await page.click('.yq-doc-more')
    await page.waitForTimeout(300)
    await page.click('text=超宽模式')
    await page.waitForTimeout(300)
    const wide = await page.locator('.yq-doc-content').evaluate((e) => e.clientWidth)
    if (wide <= narrow) throw new Error(`超宽未生效 narrow=${narrow} wide=${wide}`)
    await shot('07d-wide')
    await page.click('.yq-doc-more')
    await page.waitForTimeout(200)
    await page.click('text=标准页宽')
    await page.waitForTimeout(300)
  })

  // 7c. 统计信息面板
  await check('「···」统计信息面板', async () => {
    await page.click('.yq-doc-more')
    await page.waitForSelector('.yq-doc-stats', { timeout: 3000 })
    const txt = await page.locator('.yq-doc-stats').textContent()
    for (const k of ['字数', '创建时间', '创建者', '最后编辑', '贡献者']) {
      if (!txt.includes(k)) throw new Error('统计信息缺少「' + k + '」')
    }
    await shot('07e-doc-stats')
    await page.keyboard.press('Escape')
    await page.mouse.click(700, 500)
  })

  // 8. 目录树交互：新建
  await check('目录树新建文档', async () => {
    await page.click('.yq-tree-add')
    await page.waitForTimeout(600)
    if (!page.url().includes('/doc/')) throw new Error('未跳转到新文档: ' + page.url())
    await shot('08-new-doc')
  })

  // 9. 工作表 / 画板 / 数据表
  for (const [id, sel, name] of [
    ['t6', '.yq-sheet-grid', '工作表'],
    ['d8', '.yq-board-card', '画板'],
    ['d7', '.yq-dt-bar', '数据表'],
  ]) {
    await check(`${name}渲染`, async () => {
      await page.goto(`${BASE}/#/book/b2/doc/${id}`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(sel, { timeout: 5000 })
      await shot(`09-${name}`)
    })
  }

  // 10. 评论面板
  await check('评论面板', async () => {
    await page.goto(`${BASE}/#/book/b1/doc/d2`, { waitUntil: 'domcontentloaded' })
    await page.click('.yq-doc-comment-btn')
    await page.waitForSelector('.yq-comment-item', { timeout: 3000 })
    await shot('10-comments')
  })

  // 11. 分享弹窗
  await check('分享弹窗', async () => {
    await page.click('.yq-doc-share-primary')
    await page.waitForSelector('.yq-share-opt', { timeout: 3000 })
    await shot('11-share')
    await page.keyboard.press('Escape')
  })

  // 12. 搜索
  await check('全局搜索 ⌘K', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
    await page.click('.yq-global-search')
    await page.waitForSelector('.yq-searchpanel', { timeout: 3000 })
    await page.keyboard.type('权限')
    await page.waitForSelector('.yq-searchrow', { timeout: 3000 })
    const n = await page.locator('.yq-searchrow').count()
    if (n === 0) throw new Error('搜索无结果')
    await shot('12-search')
    await page.keyboard.press('Escape')
  })

  // 13. 其他页面
  for (const [path, sel, name] of [
    ['/space/s1', '.yq-space-hero', '空间'],
    ['/notes', '.yq-note-body', '小记'],
    ['/find', '.yq-discover-card', '发现'],
    ['/help', '.yq-help-grid', '帮助'],
    ['/settings', '.yq-settings', '设置'],
    ['/trash', '.yq-list-row', '回收站'],
    ['/search?q=编辑器', '.yq-searchpage-hit', '搜索页'],
  ]) {
    await check(`${name}页`, async () => {
      await page.goto(`${BASE}/#${path}`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector(sel, { timeout: 5000 })
      await shot(`13-${name}`)
    })
  }

  // 13b. @ 唤起面板
  await check('@ 唤起面板（成员 + 文档）', async () => {
    // 用 d1 而不是 d2：划词测试也要用 d2，两篇隔开避免状态互相污染
    await page.goto(`${BASE}/#/book/b1/doc/d1`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block-text')
    const t2 = page.locator('.yq-block-text').last()
    await t2.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.keyboard.type('@', { delay: 40 })
    await page.waitForSelector('.yq-mention', { timeout: 3000 })
    const groups = await page.locator('.yq-mention-group').allTextContents()
    if (!groups.includes('成员') || !groups.includes('文档')) {
      throw new Error('分组缺失: ' + JSON.stringify(groups))
    }
    await page.keyboard.type('林', { delay: 40 })
    await page.waitForTimeout(250)
    await shot('13b-mention')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(250)
    const txt = await page.locator('.yq-block-text').last().textContent()
    if (!txt.includes('@林知远')) throw new Error('未插入提及: ' + txt)
    await page.keyboard.press('Backspace')
  })

  // 13c. 快捷键面板 + 组合键
  await check('快捷键面板与组合键', async () => {
    await page.click('.yq-doc-corner-btn')
    await page.waitForSelector('.yq-shortcuts', { timeout: 3000 })
    await shot('13c-shortcuts')
    await page.keyboard.press('Escape')

    // ⌘⇧P 切超宽
    await page.goto(`${BASE}/#/book/b1/doc/d2`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-doc-content')
    const w0 = await page.locator('.yq-doc-content').evaluate((e) => e.clientWidth)
    await page.keyboard.press('Meta+Shift+P')
    await page.waitForTimeout(350)
    const w1 = await page.locator('.yq-doc-content').evaluate((e) => e.clientWidth)
    if (w1 <= w0) throw new Error(`⌘⇧P 超宽未生效 ${w0}→${w1}`)

    // ⌘⇧O 大纲收起
    await page.keyboard.press('Meta+Shift+P')
    await page.waitForTimeout(250)
    await page.keyboard.press('Meta+Shift+O')
    await page.waitForTimeout(300)
    if ((await page.locator('.yq-outline-mini').count()) === 0) throw new Error('⌘⇧O 未收起大纲')
    await page.keyboard.press('Meta+Shift+O')
    await page.waitForTimeout(300)
  })

  // 13d. 目录宽度拖拽
  await check('目录宽度拖拽', async () => {
    await page.waitForSelector('.yq-tree-resizer', { timeout: 3000 })
    const w0 = await page.locator('.yq-tree').evaluate((e) => e.clientWidth)
    const box = await page.locator('.yq-tree-resizer').boundingBox()
    await page.mouse.move(box.x + 3, box.y + 200)
    await page.mouse.down()
    await page.mouse.move(box.x + 83, box.y + 200, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const w1 = await page.locator('.yq-tree').evaluate((e) => e.clientWidth)
    if (w1 - w0 < 60) throw new Error(`拖拽未生效 ${w0}→${w1}`)
    await shot('13d-tree-resize')
  })

  // 13e. 划词评论
  await check('划词：工具条 → 评论 → 侧栏', async () => {
    await page.goto(`${BASE}/#/book/b1/doc/d2`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block-text')

    // 选中正文里的一段文字
    const txt = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.yq-block-text')]
      const target = els.find((e) => e.innerText.includes('语雀是一个'))
      if (!target) return null
      const tn = target.firstChild
      if (!tn) return null
      const r = document.createRange()
      r.setStart(tn, 0)
      r.setEnd(tn, Math.min(6, tn.textContent.length))
      const s = window.getSelection()
      s.removeAllRanges()
      s.addRange(r)
      return s.toString()
    })
    if (!txt) throw new Error('未构造选区')
    await page.waitForTimeout(300)
    await page.waitForSelector('.yq-selbar', { timeout: 3000 })
    await shot('13e-selbar')

    // 点「评论」
    await page.click('.yq-selbar button:has-text("评论")')
    await page.waitForSelector('.yq-selpop', { timeout: 3000 })
    await page.fill('.yq-selpop-input', '这里建议补一张语法速查表。')
    await page.click('.yq-selpop-foot .yq-btn-primary')
    await page.waitForSelector('.yq-selpanel', { timeout: 3000 })
    const n = await page.locator('.yq-selc').count()
    if (n < 2) throw new Error('划词评论未入库: ' + n)
    await shot('13f-selpanel')

    // 存小记 —— 先关掉侧栏：工具条与评论侧栏互斥，侧栏开着时不出工具条
    await page.click('.yq-selpanel-head button')
    await page.waitForTimeout(300)
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('.yq-block-text')]
      const target = els.find((e) => e.innerText.includes('语雀是一个'))
      const tn = target.firstChild
      const r = document.createRange()
      r.setStart(tn, 0); r.setEnd(tn, 4)
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
    })
    await page.waitForTimeout(300)
    if ((await page.locator('.yq-selbar').count()) === 0) throw new Error('选区变化后工具条未重现')
    await page.click('.yq-selbar button:has-text("存小记")')
    await page.waitForTimeout(300)
    const notes = await page.evaluate(() => window.__yqStore.getState().notes[0]?.text || '')
    if (!notes.includes('摘录')) throw new Error('未保存到小记: ' + notes)
  })

  // 13f. 表格卡片全屏独立编辑态
  await check('工作表卡片全屏独立编辑态', async () => {
    await page.goto(`${BASE}/#/book/b2/doc/t6`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-sheet-grid')
    await page.click('button[title="进入卡片的独立编辑界面"]')
    await page.waitForSelector('.yq-sheet-fs', { timeout: 3000 })
    await page.waitForTimeout(500)   // 等 scale 动画结束，否则测到的是动画中间帧
    const box = await page.locator('.yq-sheet-fs').boundingBox()
    const vp = page.viewportSize()
    if (box.width < vp.width * 0.95 || box.height < vp.height * 0.95) {
      throw new Error(`未铺满全屏 ${JSON.stringify(box)} vs ${JSON.stringify(vp)}`)
    }
    if ((await page.locator('.yq-doc-bar').isVisible())) throw new Error('全屏下正文未退场')
    await shot('13g-sheet-fullscreen')
    await page.click('.yq-sheet-fs-back')
    await page.waitForTimeout(300)
    if ((await page.locator('.yq-sheet-fs').count()) > 0) throw new Error('未退出全屏')
  })

  // 13h. 打印 / 另存为 PDF：界面外壳必须全部退场
  await check('打印视图：只剩正文，外壳全退场', async () => {
    await page.goto(`${BASE}/#/book/b1/doc/d2`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block')
    await page.waitForTimeout(800)

    // 屏幕上页眉不该出现 —— 它只在 @media print 里显形
    if (await page.locator('.yq-print-header').isVisible()) {
      throw new Error('打印页眉在屏幕上就显形了（应该只在打印时出现）')
    }

    // emulateMedia 能看到打印时真正会出来的样子，而系统打印对话框
    // 在无头环境里既弹不出来也点不动 —— 所以只能这样验。
    await page.emulateMedia({ media: 'print' })
    await page.waitForTimeout(400)
    try {
      if (!(await page.locator('.yq-print-header').isVisible())) {
        throw new Error('打印时页眉没出现（作者/更新时间那一行会丢）')
      }
      const head = await page.locator('.yq-print-header').innerText()
      if (!/更新于/.test(head)) throw new Error('页眉里没有更新时间: ' + head.replace(/\n/g, ' '))

      /**
       * 按**可见的交互元素**逐个列，而不是查我以为在的那几个类名。
       * 之前只查了顶栏/侧栏/操作条，全绿 —— 而截图上清清楚楚地留着
       * 左侧目录树、编辑工具条、协作条、「已保存」提示和块前面的绿色加号。
       * 静态地检查「我以为在的东西」，证明不了「该不在的都不在了」。
       */
      const left = await page.evaluate(() => {
        const out = []
        for (const el of document.querySelectorAll('button, input, select, textarea, [role="button"]')) {
          const cls = typeof el.className === 'string' ? el.className : ''
          // 待办的勾选框也是 button，但它是**内容**（表达「已完成」），该留
          if (cls.includes('yq-todo-box')) continue
          const cs = getComputedStyle(el)
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue
          const r = el.getBoundingClientRect()
          if (r.width < 2 || r.height < 2) continue
          out.push(cls.split(' ').filter(Boolean).slice(0, 2).join('.') || el.tagName.toLowerCase())
        }
        return out
      })
      if (left.length) throw new Error('打印态下还残留着: ' + [...new Set(left)].slice(0, 6).join(', '))

      // 正文要占满整页 —— 屏幕上它被挤在中间一窄条
      const covered = await page.evaluate(() => {
        const el = document.querySelector('.yq-doc-content')
        if (!el) return 0
        return Math.round((el.getBoundingClientRect().width / window.innerWidth) * 100)
      })
      if (covered < 92) throw new Error('正文只占了 ' + covered + '% 宽度')

      // 待办勾选框要留着
      const todo = await page.evaluate(() => {
        const cb = document.querySelector('.yq-todo-box')
        return cb ? getComputedStyle(cb).display : 'none'
      })
      if (todo === 'none') throw new Error('待办的勾选框被一起藏了（那是内容不是外壳）')

      await shot('13h-print-view')
    } finally {
      await page.emulateMedia({ media: 'screen' })
    }
  })

  // 13g. DocTree 拖拽排序（HTML5 DnD，mouse 事件不触发这类事件）
  await check('目录树拖拽：成为子项 / 同级排序 / 防环', async () => {
    // 必须先导航：上一个用例把页面留在别的知识库上了
    await page.goto(`${BASE}/#/book/b1/doc/d1`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-tree-item')

    const dnd = async (srcSel, dstSel, ratio) => {
      const a = await page.evaluate(([ss]) => {
        const el = document.querySelector(ss)
        if (!el) return 'missing'
        el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }))
        return 'ok'
      }, [srcSel])
      if (a !== 'ok') throw new Error(a)
      // dragstart 触发了 setState，必须让出一帧，否则 dragId 还是 null
      await page.waitForTimeout(80)
      await page.evaluate(([ds, r]) => {
        const el = document.querySelector(ds)
        if (!el) return
        const dt = new DataTransfer()
        const b = el.getBoundingClientRect()
        const at = { clientX: b.left + b.width / 2, clientY: b.top + b.height * r }
        el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }))
        el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }))
      }, [dstSel, ratio])
      await page.waitForTimeout(300)
    }
    /**
     * 必须用 DOM 上的 data-node-id 定位，不能用 store 里的节点顺序。
     * 树是深度优先渲染的，DOM 第 N 行未必等于 store 里第 N 个根节点
     * （前面的用例已经改过这棵树）。
     */
    const rows = () => page.evaluate(() =>
      [...document.querySelectorAll('.yq-tree-item')].map((e) => ({
        id: e.dataset.nodeId, title: e.dataset.nodeTitle,
      })))
    const isGroup = (id) => page.evaluate((i) => {
      const n = window.__yqStore.getState().nodes.find((x) => x.id === i)
      return !!n && n.type === 'group'
    }, id)

    // 目标必须是「分组」才能成为其子项；且不能和源是同一个节点
    const all = await rows()
    const src = all[0]
    const dst = all.find((r) => r.id !== src.id && isGroup(r.id))
    if (!dst) throw new Error('找不到可用的分组目标行')

    // 拖到分组中间 → 成为子项
    await dnd(`[data-node-id="${src.id}"]`, `[data-node-id="${dst.id}"]`, 0.5)
    const parentAfter = await page.evaluate((id) =>
      window.__yqStore.getState().nodes.find((x) => x.id === id).parentId, src.id)
    if (parentAfter !== dst.id) {
      throw new Error(`成为子项失败: ${src.id}(${src.title}) 期望 parent=${dst.id}(${dst.title}) 实际 ${parentAfter}`)
    }

    // 拖到另一条目下方 → 该条目应排到目标之后。
    // 必须挑两个【同级】节点：把父节点拖向自己的子项会被防环正确拒绝，
    // 那种用例测不出排序是否生效。
    // 一次把 DOM 顺序 + 各自的 parentId 取回来，在 JS 侧选同级的两个节点。
    // （Array.find 不支持 async 回调，回调返回的 Promise 恒为真，不能这么筛。）
    const r1 = await page.evaluate(() => {
      const ns = window.__yqStore.getState().nodes
      return [...document.querySelectorAll('.yq-tree-item')].map((e) => {
        const n = ns.find((x) => x.id === e.dataset.nodeId)
        return { id: e.dataset.nodeId, title: e.dataset.nodeTitle, parent: n && n.parentId }
      })
    })
    const x = r1[0]
    const y = r1.find((r) => r.id !== x.id && r.parent === x.parent)
    if (!y) throw new Error('找不到与源同级的目标行')
    const before = r1.map((n) => n.id)
    await dnd(`[data-node-id="${x.id}"]`, `[data-node-id="${y.id}"]`, 0.9)
    await page.waitForTimeout(350)
    const after = (await rows()).map((n) => n.id)
    const ax = after.indexOf(x.id), ay = after.indexOf(y.id)
    if (ax === -1 || ay === -1) throw new Error('拖拽后节点丢失')
    if (ax <= ay) {
      throw new Error(`同级排序失败: ${JSON.stringify(before)} → ${JSON.stringify(after)}（期望「${x.title}」排到「${y.title}」之后）`)
    }

    // 防环：store 层必须拒绝把节点移进自己的子孙
    const snap = () => page.evaluate(() => JSON.stringify(
      window.__yqStore.getState().nodes.map((n) => [n.id, n.parentId])))
    const b4 = await snap()
    const g2 = all.find((r) => isGroup(r.id))
    const g2child = await page.evaluate((pid) => {
      const n = window.__yqStore.getState().nodes.find((x) => x.parentId === pid)
      return n && n.id
    }, g2.id)
    if (g2child) {
      await page.evaluate(([a, b]) => window.__yqStore.getState().moveNode(a, b, 0), [g2.id, g2child])
      await page.waitForTimeout(200)
      if (b4 !== (await snap())) throw new Error('防环失效：节点被移进自己的子孙')
    }
  })

  // 13h. 知识库设置中心
  await check('知识库设置中心：四 tab + 目录拖拽 + 统计', async () => {
    await page.goto(`${BASE}/#/book/b1/settings`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-bset-row, .yq-bset-nav', { timeout: 5000 })

    // 目录管理：整棵树渲染 + 拖拽排序
    const rows0 = await page.locator('.yq-bset-row').count()
    if (rows0 < 8) throw new Error('目录树行数过少: ' + rows0)
    const dndTree = async (a, bSel, ratio) => {
      await page.evaluate(([x]) => {
        const el = document.querySelector(x)
        el?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }))
      }, [a])
      await page.waitForTimeout(80)
      await page.evaluate(([y, r]) => {
        const el = document.querySelector(y)
        if (!el) return
        const dt = new DataTransfer()
        const rc = el.getBoundingClientRect()
        const at = { clientX: rc.left + 20, clientY: rc.top + rc.height * r }
        el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }))
        el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }))
      }, [bSel, ratio])
      await page.waitForTimeout(300)
    }
    // 同样用 DOM 上的 data-node-id 定位，不能用 store 的节点顺序
    const bRows = () => page.evaluate(() =>
      [...document.querySelectorAll('.yq-bset-row')].map((e) => ({
        id: e.dataset.nodeId, title: e.dataset.nodeTitle,
        group: e.classList.contains('is-group'),
      })))
    const br = await bRows()
    const bs = br[0]
    const bd = br.find((r) => r.id !== bs.id && r.group)
    if (!bd) throw new Error('设置中心找不到可用的分组目标行')
    await dndTree(`[data-node-id="${bs.id}"]`, `[data-node-id="${bd.id}"]`, 0.5)
    const par = await page.evaluate((id) =>
      window.__yqStore.getState().nodes.find((x) => x.id === id).parentId, bs.id)
    if (par !== bd.id) throw new Error(`设置中心拖拽未生效: ${bs.id} 期望 ${bd.id} 实际 ${par}`)
    await shot('13h-设置中心-目录')

    // 权限 / 安全 / 统计
    for (const [i, name, must] of [[1, '权限', '成员'], [2, '安全', '水印'], [3, '统计', '访问']]) {
      const btn = page.locator('button').filter({ hasText: name }).first()
      await btn.click()
      await page.waitForTimeout(450)
      const txt = await page.textContent('body')
      if (!txt.includes(must)) throw new Error(`「${name}」tab 内容异常，找不到「${must}」`)
      await shot(`13h-设置中心-${name}`)
    }
  })

  // 13i. 模板中心
  await check('模板中心：目录 + 预览 + 搜索 + 用模板新建', async () => {
    await page.goto(`${BASE}/#/templates`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-tpl-item', { timeout: 5000 })
    const n = await page.locator('.yq-tpl-item').count()
    if (n < 8) throw new Error('模板条目过少: ' + n)
    // 预览区渲染出了 markdown 排版节点
    const md = await page.locator('.yq-md-h1, .yq-md-h2, .yq-md-list, .yq-md-table, .yq-md-code, .yq-md-quote').count()
    if (md === 0) throw new Error('预览区未渲染 markdown')
    await shot('13i-模板中心')

    // 顶栏入口
    const nav = await page.locator('.yq-topbar-nav a, .yq-topbar-nav button').filter({ hasText: '模板' }).count()
    if (nav === 0) throw new Error('顶栏缺少「模板」入口')

    // 搜索过滤
    await page.fill('input[placeholder*="搜索"]', '复盘')
    await page.waitForTimeout(400)
    const filtered = await page.locator('.yq-tpl-item').count()
    if (filtered === 0 || filtered >= n) throw new Error('搜索过滤异常: ' + filtered)

    // 用此模板新建 → 真实落库
    await page.fill('input[placeholder*="搜索"]', '')
    await page.waitForTimeout(300)
    await page.locator('.yq-tpl-item').first().click()
    await page.waitForTimeout(200)
    await page.locator('button:has-text("用此模板新建")').first().click()
    await page.waitForSelector('.yq-tpl-modal, [class*="modal"]', { timeout: 4000 })
    await page.waitForTimeout(300)
    await page.locator('button:has-text("确认"), button:has-text("确定")').last().click()
    await page.waitForTimeout(600)
    if (!page.url().includes('/doc/')) throw new Error('未跳转到新建文档: ' + page.url())
    await shot('13j-模板-新建文档')
  })

  // 13k. 协作光标
  // 说明：这一条原来是靠「模拟协作者随机游走」来验证渲染层的。
  // 协同改成跨标签页真协同后，单开一个标签页本来就没有别人，
  // 所以这里改成真开第二个标签页（同 context，共享 BroadcastChannel 频道），
  // 让它以另一位成员的身份在正文里放一个真实光标 —— 断言的东西没变，
  // 变的只是「光标从哪来」。详见 smoke-collab.cjs（双向内容同步的完整自验）。
  await check('协作光标：渲染 / 开关 / 离开清理', async () => {
    await page.goto(`${BASE}/#/book/b1/doc/d2`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block-text')

    // B：同 context 的第二个标签页，切成另一位成员后在正文里落真实光标
    const pageB2 = await ctx.newPage()
    pageB2.on('pageerror', (e) => errors.push(`[B pageerror] ${e.message}`))
    await pageB2.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
    await pageB2.evaluate(() => {
      const s = window.__yqStore
      s.setState({ currentUser: s.getState().members.find((m) => m.id === 'u2'), cursors: [] })
    })
    await pageB2.goto(`${BASE}/#/book/b1/doc/d2`, { waitUntil: 'domcontentloaded' })
    await pageB2.waitForSelector('.yq-block-text')
    const bBlock = pageB2.locator('.yq-block-text').nth(1)
    await bBlock.click()
    await pageB2.keyboard.press('End')

    // 等 A 收到 B 的光标广播（心跳 + selectionchange 都有广播）
    const gotCursor = async () => {
      const n = await page.locator('.yq-collab-caret').count()
      return n >= 1
    }
    for (let i = 0; i < 40 && !(await gotCursor()); i++) await page.waitForTimeout(100)

    const n = await page.evaluate(() => window.__yqStore.getState().cursors.length)
    if (n < 1) throw new Error('没有收到远端协作者')
    const caret = await page.locator('.yq-collab-caret').count()
    if (caret < 1) throw new Error('DOM 里没有渲染远端光标')
    const label = await page.locator('.yq-collab-label').count()
    if (label < 1) throw new Error('没有名字标签')
    await shot('13k-协作光标')

    // 协作条：真实在场人数 = 我 + B
    const barTxt = await page.locator('.yq-doc-collabbar').innerText()
    if (!barTxt.includes('协作')) throw new Error('协作条内容异常: ' + barTxt)

    // 关掉开关 → 光标消失
    await page.click('.yq-doc-collab-switch .yq-switch')
    await page.waitForTimeout(600)
    const after = await page.locator('.yq-collab-caret').count()
    if (after > 0) throw new Error('关闭开关后光标仍在: ' + after)
    await page.click('.yq-doc-collab-switch .yq-switch')
    await page.waitForTimeout(400)

    // B 关掉标签页 → 广播 leave → A 立刻清掉它的光标
    await pageB2.close()
    const dropped = async () =>
      (await page.evaluate(() => window.__yqStore.getState().cursors.length)) === 0
    for (let i = 0; i < 40 && !(await dropped()); i++) await page.waitForTimeout(100)
    if (!(await dropped())) {
      const left = await page.evaluate(() => window.__yqStore.getState().cursors.length)
      throw new Error('B 关闭后 A 仍残留 cursors: ' + left)
    }

    // 离开文档 → cursors 清理，不泄漏
    await page.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)
    const leaked = await page.evaluate(() => window.__yqStore.getState().cursors.length)
    if (leaked !== 0) throw new Error('离开文档后残留 cursors: ' + leaked)
  })

  // 13l. 协作光标标签避让（多人光标靠太近时标签不能叠在一起）
  await check('协作光标：标签重叠避让', async () => {
    await page.goto(`${BASE}/#/book/b1/doc/d2`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block-text')
    await page.waitForTimeout(800)

    // 造一个必然重叠的场景：三个人挤在同一个块、同一行相邻位置
    await page.evaluate(() => {
      const s = window.__yqStore.getState()
      const blk = s.docs.d2.blocks.find((x) => x.type === 'p') || s.docs.d2.blocks[0]
      s.clearDocCursors('d2')
      const now = Date.now()
      const mk = (id, mid, off, color) =>
        ({ id, docId: 'd2', memberId: mid, blockId: blk.id, offset: off, range: [off, off], color, activeAt: now })
      s.setCursor(mk('c1', 'u2', 3, '#28a745'))
      s.setCursor(mk('c2', 'u4', 4, '#f5a623'))
      s.setCursor(mk('c3', 'u5', 5, '#8e44ad'))
    })
    await page.waitForTimeout(900)

    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('.yq-collab-label')].map((e) => {
        const r = e.getBoundingClientRect()
        return { text: e.textContent, x: r.left, y: r.top, w: r.width, h: r.height }
      }))
    if (labels.length < 3) throw new Error('光标标签未渲染: ' + labels.length)

    const overlaps = []
    for (let i = 0; i < labels.length; i++) {
      for (let j = i + 1; j < labels.length; j++) {
        const a = labels[i], c = labels[j]
        const hit = !(a.x + a.w <= c.x || c.x + c.w <= a.x || a.y + a.h <= c.y || c.y + c.h <= a.y)
        if (hit) overlaps.push(`${a.text} ↔ ${c.text}`)
      }
    }
    if (overlaps.length) throw new Error('标签仍重叠: ' + overlaps.join(', '))
    await shot('13l-标签避让')
  })

  /** 选中第 n 个可编辑块的全部文字 */
  const selectBlock = (n) => page.evaluate((i) => {
    const el = document.querySelectorAll('.yq-block-text')[i]
    if (!el || !el.firstChild) return false
    const r = document.createRange()
    r.selectNodeContents(el)
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
    return true
  }, n)

  // 13m. 富文本格式持久化（之前加粗 / 颜色 / 字号刷新就没了）

  await check('富文本：加粗 + 颜色 → 刷新后仍在', async () => {
    const target = page.locator('.yq-block-text').nth(1)
    await target.click()
    await page.keyboard.press('End')
    await page.keyboard.type('加粗测试', { delay: 20 })
    await page.waitForTimeout(200)

    // 选中刚输入的 4 个字并加粗
    await page.evaluate(() => {
      const els = [...document.querySelectorAll('.yq-block-text')]
      const el = els[1]
      const tn = el.firstChild
      const r = document.createRange()
      r.setStart(tn, tn.textContent.length - 4)
      r.setEnd(tn, tn.textContent.length)
      const s = window.getSelection()
      s.removeAllRanges(); s.addRange(r)
    })
    await page.waitForTimeout(150)
    await page.click('.yq-tb-btn:has-text("B")')
    await page.waitForTimeout(600)

    // 刷新前先确认格式已在 DOM 上
    const blk2 = page.locator('.yq-block-text').nth(1)   // p 块：h 块字重已粗，加粗按钮是灰的
    const hasBold = await blk2.evaluate((el) => !!el.querySelector('b, strong, [style*="bold"]'))
    if (!hasBold) throw new Error('加粗未应用到 DOM')

    await page.waitForTimeout(900)   // 等防抖落盘
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block-text')
    await page.waitForTimeout(500)

    const after = await blk2.evaluate((el) => ({
      hasBold: !!el.querySelector('b, strong, [style*="bold"]'),
      text: el.innerText,
    }))
    if (!after.text.includes('加粗测试')) throw new Error('刷新后文本丢失: ' + after.text)
    if (!after.hasBold) throw new Error('刷新后加粗丢失 ← 这就是本次要修的 bug')
  })

  await check('富文本：localStorage 里确实存了 html', async () => {
    const stored = await page.evaluate(() => {
      const d = JSON.parse(localStorage.getItem('yuque-clone-data-v1') || '{}')
      const blocks = d.docs?.d5?.blocks || []
      const blk = blocks[1]
      if (!blk) return { err: 'blocks[2] 不存在，长度=' + blocks.length }
      return { hasHtml: typeof blk.html === 'string' && blk.html.length > 0, html: (blk.html || '').slice(0, 120) }
    })
    if (stored.err) throw new Error(stored.err)
    if (!stored.hasHtml) throw new Error('block.html 未落盘')
    console.log('   存储的 html 片段:', JSON.stringify(stored.html))
  })

  await check('富文本：颜色 → 刷新后仍在', async () => {
    const target = page.locator('.yq-block-text').nth(1)
    await target.click()
    await page.keyboard.press('End')
    await page.keyboard.type('颜色测试', { delay: 20 })
    await page.waitForTimeout(200)
    await page.evaluate(() => {
      const el = document.querySelectorAll('.yq-block-text')[1]
      const tn = el.firstChild
      const r = document.createRange()
      r.setStart(tn, tn.textContent.length - 4); r.setEnd(tn, tn.textContent.length)
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
    })
    await page.waitForTimeout(150)
    // 打开前景色面板点红色
    await page.click('.yq-tb-btn:has-text("A") >> nth=0')
    await page.waitForSelector('.yq-tb-colors', { timeout: 3000 })
    await page.click('.yq-tb-color[title="#e34d59"]')
    await page.waitForTimeout(700)

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block-text')
    await page.waitForTimeout(500)
    const ok = await page.locator('.yq-block-text').nth(1).evaluate((el) => {
      const hit = [...el.querySelectorAll('span, font, [style*="color"]')]
        .some((n) => (n.getAttribute('style') || '').toLowerCase().includes('rgb(227, 77, 89)')
          || (n.getAttribute('color') || '').toLowerCase() === '#e34d59'
          || (n.textContent || '').includes('颜色测试'))
      return { text: el.innerText, hit }
    })
    if (!ok.text.includes('颜色测试')) throw new Error('刷新后文本丢失: ' + ok.text)
    if (!ok.hit) throw new Error('刷新后颜色丢失')
  })

  await check('富文本：markdown 转换后的块 html 干净', async () => {
    /**
     * 用 d3 的末尾新块来测，不 createDoc、不新建文稿。
     * 原写法是「新建文档 → 等落盘 → 跳转」，这两步在慢网络下
     * 会引入与被测逻辑无关的竞态（localStorage 已有内容时更容易复现）。
     * 转换行为与文档无关，在已有文档末尾起一块等价，且不污染目录树。
     */
    await page.goto(`${BASE}/#/book/b1/doc/d3`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block-text')
    await page.waitForTimeout(300)

    const n = await page.locator('.yq-block-text').count()
    await page.locator('.yq-block-text').nth(n - 1).click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(300)
    await page.locator('.yq-block-text').nth(n).click()
    await page.keyboard.press('End')

    // 真实用户路径：空块打前缀即转换
    await page.keyboard.type('## ', { delay: 50 })
    await page.waitForTimeout(400)
    await page.keyboard.type('转换后', { delay: 25 })
    await page.waitForTimeout(700)

    const blk = page.locator('[data-block-id]').last()
    const after = await blk.evaluate((el) => {
      const t = el.querySelector('.yq-block-text')
      return { html: t.innerHTML, cls: el.className }
    })
    if (!after.cls.includes('h2')) throw new Error('未转成 h2: ' + after.cls)
    if (!after.html.includes('转换后')) throw new Error('转换后输入丢失: ' + after.html)
    if (/<(b|strong|font|span\s+style)/i.test(after.html)) {
      throw new Error('转换后 html 残留格式标签: ' + after.html.slice(0, 100))
    }
    // 落盘的 html 也必须是干净纯文本
    // 注意：目录节点 id（n_xxx）和 block id（bk_xxx）是两套命名空间，
    // 这里必须用 block 自己的 data-block-id 去查，不能借道 nodes
    const bid = await blk.getAttribute('data-block-id')
    const stored = await page.evaluate((id) => {
      const d = JSON.parse(localStorage.getItem('yuque-clone-data-v1') || '{}')
      const b = (d.docs?.d3?.blocks || []).find((x) => x.id === id)
      return b ? { type: b.type, html: b.html } : null
    }, bid)
    if (!stored) throw new Error('未找到落盘的块')
    if (stored.type !== 'h2') throw new Error('落盘类型错误: ' + stored.type)
    if (/<(b|strong|font|span\s+style)/i.test(stored.html || '')) {
      throw new Error('落盘 html 残留格式: ' + stored.html)
    }
  })

  // 14. 刷新持久化
  await check('localStorage 持久化', async () => {
    await page.goto(`${BASE}/#/book/b1/doc/d2`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block-text')
    const target = page.locator('.yq-block-text').last()
    await target.click()
    await page.keyboard.type('持久化测试XYZ')
    await page.waitForTimeout(900)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block-text')
    const body = await page.textContent('.yq-doc-content')
    if (!body.includes('持久化测试XYZ')) throw new Error('刷新后内容丢失')
  })

  await browser.close()
  server.close()

  const failed = steps.filter((s) => !s.ok)
  console.log('\n' + '='.repeat(50))
  console.log(`通过 ${steps.length - failed.length}/${steps.length}`)
  if (failed.length) {
    console.log('\n失败项：')
    failed.forEach((f) => console.log(`  ✗ ${f.label}\n    ${f.errs.join('\n    ')}`))
  }
  console.log(`\n截图目录: ${OUT}`)
  process.exit(failed.length ? 1 : 0)
})()
