/**
 * 移动端冒烟：四个窄/宽视口 × 三个关键页面
 *   断言 1：没有横向溢出（真实内容宽度，不是被 overflow-x:hidden 掩盖的假绿）
 *   断言 2：关键元素可见 + 可点
 *   断言 3：抽屉/弹窗这类浮层打开后不越界、点遮罩能关
 *
 * 用法：node smoke-mobile.cjs
 */
const { chromium } = require('playwright')
const http = require('http')
const fs = require('fs')
const path = require('path')
const DIST = process.env.SMOKE_DIST || 'dist'

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
/** 默认服务 dist/；SMOKE_DIST 可以指向一份快照，避免和并行的 build 抢同一个目录 */
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0]
  let f = path.join(DIST, u === '/' ? 'index.html' : u)
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
  res.end(fs.readFileSync(f))
})

const PORT = 4900 + Math.floor(Math.random() * 500)
const BASE = process.env.SMOKE_BASE || `http://localhost:${PORT}`
// ⚠️ 这里原来写死的是 '/workspace/yuque/.smoke…' —— Linux 开发环境的残留。
//    在 Windows 上它被解析成 `H:\workspace\yuque\.smoke`，**截图落在工作区外面、
//    盘根下面**，而 .gitignore 里明明列着这些目录名（本来的意图就是放在项目根）。
//    实测一次就堆了 15.1MB，而且**没有任何地方会报**。
//    截图是手动套件唯一的失败取证手段，落在人不会去看的地方，
//    「失败了但看不出为什么」和「套件没跑」长得一模一样。
//    所以改成脚本所在目录；要放别处用 SMOKE_OUT 覆盖。
const OUT = process.env.SMOKE_OUT || path.join(__dirname, '.smoke-mobile')
fs.mkdirSync(OUT, { recursive: true })

const VIEWPORTS = [
  { name: 'iphone-se', label: 'iPhone SE', width: 320, height: 568, phone: true },
  { name: 'iphone-12', label: 'iPhone 12', width: 390, height: 844, phone: true },
  { name: 'ipad', label: 'iPad 竖屏', width: 768, height: 1024, phone: true },
  { name: 'ipad-landscape', label: 'iPad 横屏', width: 1024, height: 768, phone: false },
]

const PAGES = [
  { key: 'dash', label: '工作台', hash: '/#/', ready: '.yq-dash-greeting' },
  { key: 'book', label: '知识库主页', hash: '/#/book/b1', ready: '.yq-toc-row' },
  { key: 'doc', label: '文档页', hash: '/#/book/b1/doc/d2', ready: '.yq-block' },
  { key: 'sheet', label: '工作表卡片', hash: '/#/book/b2/doc/t6', ready: '.yq-sheet-grid' },
  { key: 'table', label: '数据表卡片', hash: '/#/book/b2/doc/d7', ready: '.yq-dt-bar' },
  { key: 'board', label: '画板卡片', hash: '/#/book/b2/doc/d8', ready: '.yq-board-card' },
  { key: 'bookset', label: '知识库设置中心', hash: '/#/book/b1/settings', ready: '.yq-bset-nav' },
  { key: 'settings', label: '设置', hash: '/#/settings', ready: '.yq-settings' },
  { key: 'templates', label: '模板中心', hash: '/#/templates', ready: '.yq-tpl-item' },
  { key: 'notes', label: '小记', hash: '/#/notes', ready: '.yq-note-body' },
  { key: 'discover', label: '发现', hash: '/#/find', ready: '.yq-discover-card' },
]

const errors = []
const steps = []

;(async () => {
  await new Promise((r) => server.listen(PORT, r))
  const browser = await chromium.launch()

  const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png` })

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

  /**
   * 真实的横向溢出量。
   * 页面开了 html/body overflow-x:hidden 兜底，直接读 scrollWidth 永远是绿的，
   * 所以先临时放开再量 —— 量完立刻还原，量到的才是内容真实宽度。
   */
  const overflow = (page) =>
    page.evaluate(() => {
      const html = document.documentElement
      const body = document.body
      const ph = html.style.overflowX
      const pb = body.style.overflowX
      html.style.overflowX = 'visible'
      body.style.overflowX = 'visible'
      void html.offsetWidth // 强制重排
      const res = { sw: Math.max(html.scrollWidth, body.scrollWidth), iw: window.innerWidth }
      html.style.overflowX = ph
      body.style.overflowX = pb
      return res
    })

  /** 越界元素清单：横向滚动容器内部的内容不算页面级溢出 */
  const offenders = (page) =>
    page.evaluate(() => {
      const vw = window.innerWidth
      const out = []
      for (const el of document.querySelectorAll('body *')) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (r.right <= vw + 1 && r.left >= -1) continue
        let p = el.parentElement
        let contained = false
        while (p) {
          const ox = getComputedStyle(p).overflowX
          if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') { contained = true; break }
          p = p.parentElement
        }
        if (contained) continue
        const cls = String(el.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.')
        out.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} [${Math.round(r.left)}…${Math.round(r.right)}]`)
        if (out.length >= 10) break
      }
      return out
    })

  const assertNoOverflow = async (page, where) => {
    const { sw, iw } = await overflow(page)
    if (sw > iw + 1) {
      const list = await offenders(page)
      throw new Error(`${where} 横向溢出 scrollWidth=${sw} > innerWidth=${iw}\n     越界元素: ${list.join(' | ') || '(未定位到，可能是 fixed 浮层)'}`)
    }
  }

  for (const vp of VIEWPORTS) {
    console.log(`\n──────── ${vp.label} ${vp.width}×${vp.height} ${vp.phone ? '(移动版式)' : '(平板版式)'} ────────`)
    // 每个视口一个全新 context：避免 localStorage 串味
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: vp.phone,
      hasTouch: vp.phone,
      ignoreHTTPSErrors: /^https:/.test(BASE),
    })
    const page = await ctx.newPage()
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${vp.name} ${m.text()}`) })
    page.on('pageerror', (e) => errors.push(`[pageerror] ${vp.name} ${e.message}`))

    /* ---------- 1. 三个必测页面：无横向溢出 ---------- */
    for (const p of PAGES) {
      await check(`${vp.label} · ${p.label} · 无横向溢出`, async () => {
        await page.goto(`${BASE}${p.hash}`, { waitUntil: 'networkidle' })
        await page.waitForSelector(p.ready, { timeout: 8000 })
        await page.waitForTimeout(350)
        await assertNoOverflow(page, p.label)
        await shot(page, `${vp.name}-${p.key}`)
      })
    }

    /* ---------- 2. 工作台：关键元素可见可点 + 汉堡抽屉 ---------- */
    await check(`${vp.label} · 工作台 · 导航形态正确`, async () => {
      await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' })
      await page.waitForSelector('.yq-dash-greeting')

      // 知识库卡片：可见 + 真能点（点第二张，卡片数 >= 2）
      const cards = page.locator('.yq-book-card')
      if ((await cards.count()) < 2) throw new Error('知识库卡片过少: ' + (await cards.count()))
      if (!(await cards.first().isVisible())) throw new Error('知识库卡片不可见')
      await cards.nth(1).click()
      await page.waitForTimeout(600)
      if (!/#\/(book|space)\//.test(page.url())) throw new Error('点卡片没跳转: ' + page.url())
      await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' })
      await page.waitForSelector('.yq-dash-greeting')

      const burger = page.locator('.yq-topbar-burger')
      if (vp.phone) {
        if (!(await burger.isVisible())) throw new Error('手机断点缺汉堡按钮')
        await burger.click()
        await page.waitForSelector('.yq-sidenav.is-open', { timeout: 3000 })
        await page.waitForTimeout(400)
        const box = await page.locator('.yq-sidenav').boundingBox()
        if (!box || box.x < -1) throw new Error('抽屉没滑进来: ' + JSON.stringify(box))
        if (box.x + box.width > vp.width + 1) throw new Error('抽屉超出右边界: ' + JSON.stringify(box))
        await assertNoOverflow(page, '抽屉打开态')
        await shot(page, `${vp.name}-nav-drawer`)

        // 点遮罩关闭（不 force：必须证明遮罩真的可见可点）
        const navMask = page.locator('.yq-sidenav-mask')
        if (!(await navMask.isVisible())) throw new Error('导航遮罩不可见')
        // 遮罩铺满视口，抽屉只占左侧一段 —— 点它右边的空白
        const navMaskPt = { x: Math.min(vp.width - 5, Math.round(box.x + box.width + 20)), y: 60 }
        await navMask.click({ position: navMaskPt })
        await page.waitForTimeout(400)
        if (await navMask.count() > 0) throw new Error('点遮罩没关闭抽屉')
        const closed = await page.locator('.yq-sidenav').boundingBox()
        if (closed && closed.x + closed.width > 0) throw new Error('点遮罩没关闭抽屉: ' + JSON.stringify(closed))
      } else {
        if (await burger.count() > 0 && (await burger.isVisible())) throw new Error('非手机断点不该出现汉堡')
        // 平板：侧栏收成图标条 + 主菜单进「···」
        const rail = await page.locator('.yq-sidenav').boundingBox()
        if (!rail || rail.width > 80) throw new Error('平板侧栏没收成图标条: ' + JSON.stringify(rail))
        const more = page.locator('.yq-topbar-more')
        if (!(await more.isVisible())) throw new Error('平板缺「···」主菜单')
        await more.click()
        await page.waitForSelector('.yq-popover', { timeout: 3000 })
        for (const k of ['工作台', '空间', '发现', '模板', '帮助', '小记']) {
          const item = page.locator('.yq-popover .yq-menu-item').filter({ hasText: k }).first()
          if ((await item.count()) === 0) throw new Error(`「···」里缺入口：${k}`)
          if (!(await item.isVisible())) throw new Error(`「···」里的「${k}」不可见`)
        }
        await assertNoOverflow(page, '「···」下拉打开态')
        await shot(page, `${vp.name}-more-menu`)
        await page.keyboard.press('Escape')
        await page.mouse.click(5, 400)
      }
    })

    /* ---------- 3. 文档页：抽屉形态 + 正文宽度 ---------- */
    await check(`${vp.label} · 文档页 · 目录/大纲/正文`, async () => {
      await page.goto(`${BASE}/#/book/b1/doc/d2`, { waitUntil: 'networkidle' })
      await page.waitForSelector('.yq-block')
      await page.waitForTimeout(400)

      // 正文永远不许比视口宽（72px padding 收没收对，就看这条）
      const docBox = await page.locator('.yq-doc-content').boundingBox()
      if (!docBox) throw new Error('正文没渲染')
      if (docBox.width > vp.width + 1) throw new Error(`正文比视口宽 ${Math.round(docBox.width)} > ${vp.width}`)
      // 首行文字必须真的落在屏幕内
      const firstBlock = await page.locator('[data-block-id]').first().boundingBox()
      if (!firstBlock || firstBlock.x < -1 || firstBlock.x + firstBlock.width > vp.width + 1) {
        throw new Error('首个内容块越界: ' + JSON.stringify(firstBlock))
      }

      if (vp.phone) {
        const headerH = (await page.locator('.yq-topbar').boundingBox()).height
        // 目录树收成顶部抽屉：默认整块退到顶栏后面（底边不越过顶栏下沿）
        const treeClosed = await page.locator('.yq-tree').boundingBox()
        if (treeClosed && treeClosed.y + treeClosed.height > headerH + 1) {
          throw new Error(`目录树默认没收起（露在顶栏下方 ${Math.round(treeClosed.y + treeClosed.height - headerH)}px）: ` + JSON.stringify(treeClosed))
        }
        const bar = page.locator('.yq-doc-mobilebar')
        if (!(await bar.isVisible())) throw new Error('缺抽屉开关条')
        const btns = page.locator('.yq-doc-mbtn')
        for (const k of ['目录', '大纲']) {
          const b = btns.filter({ hasText: k }).first()
          if ((await b.count()) === 0) throw new Error(`开关条缺「${k}」按钮`)
          if (!(await b.isVisible())) throw new Error(`开关条的「${k}」按钮不可见`)
        }
        // 目录抽屉
        await page.locator('.yq-doc-mbtn', { hasText: '目录' }).click()
        await page.waitForSelector('.yq-tree.is-open', { timeout: 3000 })
        await page.waitForTimeout(420)
        const treeOpen = await page.locator('.yq-tree').boundingBox()
        if (!treeOpen || treeOpen.y < -1 || treeOpen.y + treeOpen.height > vp.height + 1) {
          throw new Error('目录抽屉没铺进视口: ' + JSON.stringify(treeOpen))
        }
        if (treeOpen.x + treeOpen.width > vp.width + 1) throw new Error('目录抽屉超出右边界')
        // 命中测试：抽屉中心点到的必须是抽屉自己（证明盖在遮罩之上、能点）
        const hit = await page.evaluate(([x, y]) => {
          const el = document.elementFromPoint(x, y)
          return el ? `${el.tagName.toLowerCase()}.${String(el.className || '').split(/\s+/)[0]}` : 'null'
        }, [Math.round(treeOpen.x + treeOpen.width / 2), Math.round(treeOpen.y + Math.min(60, treeOpen.height / 2))])
        if (!hit.includes('yq-tree')) throw new Error('目录抽屉被遮罩盖住了，命中的是 ' + hit)
        await assertNoOverflow(page, '目录抽屉打开态')
        await shot(page, `${vp.name}-doc-tree-drawer`)
        // 抽屉里的目录可点
        const treeItem = page.locator('.yq-tree.is-open .yq-tree-item').first()
        if (!(await treeItem.isVisible())) throw new Error('抽屉里的目录项不可见')
        const docMask = page.locator('.yq-doc-drawermask')
        if (!(await docMask.isVisible())) throw new Error('文档抽屉遮罩不可见')
        // 遮罩在顶栏之下，顶部那一块点不到 —— 选抽屉以外的空白处点
        const treeMaskPt = { x: 5, y: Math.min(vp.height - 5, Math.round(treeOpen.y + treeOpen.height + 20)) }
        if (treeMaskPt.y <= treeOpen.y + treeOpen.height) throw new Error('抽屉占满了视口，没有遮罩可点')
        await docMask.click({ position: treeMaskPt })
        await page.waitForTimeout(420)
        const treeShut = await page.locator('.yq-tree').boundingBox()
        if (treeShut && treeShut.y + treeShut.height > headerH + 1) {
          throw new Error('点遮罩没关目录抽屉: ' + JSON.stringify(treeShut))
        }

        // 大纲抽屉（从底部）
        await page.locator('.yq-doc-mbtn', { hasText: '大纲' }).click()
        await page.waitForSelector('.yq-outline.is-open', { timeout: 3000 })
        await page.waitForTimeout(420)
        const outBox = await page.locator('.yq-outline.is-open').boundingBox()
        if (!outBox || outBox.y < -1 || outBox.y + outBox.height > vp.height + 1) {
          throw new Error('大纲抽屉没铺进视口: ' + JSON.stringify(outBox))
        }
        const outHit = await page.evaluate(([x, y]) => {
          const el = document.elementFromPoint(x, y)
          return el ? `${el.tagName.toLowerCase()}.${String(el.className || '').split(/\s+/)[0]}` : 'null'
        }, [Math.round(outBox.x + outBox.width / 2), Math.round(outBox.y + outBox.height - 40)])
        if (!outHit.includes('yq-outline')) throw new Error('大纲抽屉被遮罩盖住了，命中的是 ' + outHit)
        await assertNoOverflow(page, '大纲抽屉打开态')
        await shot(page, `${vp.name}-doc-outline-drawer`)
        // 底部抽屉：点它上方的遮罩关闭
        const outMask = page.locator('.yq-doc-drawermask')
        if (!(await outMask.isVisible())) throw new Error('大纲抽屉遮罩不可见')
        const outMaskPt = { x: 5, y: Math.round(outBox.y - 20) }
        if (outMaskPt.y <= headerH) throw new Error('大纲抽屉上方没有遮罩可点: ' + JSON.stringify(outBox))
        await outMask.click({ position: outMaskPt })
        await page.waitForTimeout(420)
        // 关掉后大纲抽屉整体退场（窄屏下 hidden 态不渲染 pinned 侧栏）
        if ((await page.locator('.yq-outline.is-drawer').count()) !== 0) {
          throw new Error('点遮罩没关大纲抽屉')
        }
        if (await page.locator('.yq-outline-mini-wrap').isVisible()) {
          throw new Error('窄屏下不该露出 mini 把手')
        }

        // 菜单栏只留标题 + ···，且 ··· 里有全部被收走的操作
        if (await page.locator('.yq-doc-share-primary').isVisible()) throw new Error('窄屏菜单栏仍显示「分享」按钮')
        if (await page.locator('.yq-doc-comment-btn').isVisible()) throw new Error('窄屏菜单栏仍显示「评论」按钮')
        const more = page.locator('.yq-doc-more')
        if (!(await more.isVisible())) throw new Error('窄屏缺「···」按钮')
        await more.click()
        await page.waitForSelector('.yq-popover', { timeout: 3000 })
        const moved = page.locator('.yq-doc-bar-move .yq-menu-item')
        // 必须断言「可见」而不是只读文本：allTextContents() 对 display:none 的
        // 元素照样返回内容，只读文本会漏掉「菜单项其实没显示」这种回归
        for (const k of ['阅读模式', '点赞', '划词评论', '评论', '收藏', '分享']) {
          const item = moved.filter({ hasText: k }).first()
          if ((await item.count()) === 0) throw new Error(`「···」里没收进「${k}」`)
          if (!(await item.isVisible())) throw new Error(`「···」里的「${k}」不可见（父节点还是 display:none？）`)
        }
        await assertNoOverflow(page, '「···」打开态')
        await shot(page, `${vp.name}-doc-more-menu`)
        await page.keyboard.press('Escape')
        await page.mouse.click(5, 300)
        await page.waitForTimeout(250)
        await assertNoOverflow(page, '文档页静息态')
      } else {
        // 宽屏：目录树与大纲仍然是并排常驻
        const tree = await page.locator('.yq-tree').boundingBox()
        if (!tree || tree.width < 100) throw new Error('宽屏目录树异常: ' + JSON.stringify(tree))
        const outline = await page.locator('.yq-outline').boundingBox()
        if (!outline || outline.width < 100) throw new Error('宽屏大纲异常: ' + JSON.stringify(outline))
        if (tree.x + tree.width + outline.width > vp.width + 1) throw new Error('目录+大纲挤爆视口')
        if (await page.locator('.yq-doc-mobilebar').isVisible()) throw new Error('宽屏不该出现抽屉开关条')
        // 工具栏可横向滚动
        const tb = await page.locator('.yq-toolbar').boundingBox()
        if (!tb || tb.width > vp.width + 1) throw new Error('工具栏溢出: ' + JSON.stringify(tb))
      }
    })

    /* ---------- 4. 搜索：图标按钮 → 全屏面板 ---------- */
    await check(`${vp.label} · 全局搜索`, async () => {
      await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' })
      const entry = page.locator('.yq-global-search')
      if (!(await entry.isVisible())) throw new Error('搜索入口不可见')
      const eb = await entry.boundingBox()
      if (eb.x + eb.width > vp.width + 1) throw new Error('搜索入口越界: ' + JSON.stringify(eb))
      await entry.click()
      await page.waitForSelector('.yq-searchpanel', { timeout: 3000 })
      await page.waitForTimeout(350)
      const pb = await page.locator('.yq-searchpanel').boundingBox()
      if (pb.width > vp.width + 1) throw new Error('搜索面板比视口宽: ' + JSON.stringify(pb))
      if (vp.phone && pb.width < vp.width - 1) throw new Error(`搜索面板没铺满（${pb.width} < ${vp.width}）`)
      // 空查询态不能是一片全屏空白：建议词得露出来
      const chips = page.locator('.yq-search-suggest')
      if ((await chips.count()) === 0) throw new Error('搜索面板空态没有建议词')
      if (!(await chips.first().isVisible())) throw new Error('搜索面板的建议词不可见（整块被藏了？）')
      const row = await chips.first().boundingBox()
      if (row.y + row.height > vp.height + 1) throw new Error('建议词落在视口外: ' + JSON.stringify(row))
      await assertNoOverflow(page, '搜索面板')
      await shot(page, `${vp.name}-search`)
      await page.keyboard.type('权限')
      await page.waitForSelector('.yq-searchrow', { timeout: 3000 })
      await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
    })

    /* ---------- 5. 弹窗：宽度 min(原宽, 100vw-24) 且不越界 ---------- */
    await check(`${vp.label} · 弹窗`, async () => {
      await page.goto(`${BASE}/#/book/b1/doc/d2`, { waitUntil: 'networkidle' })
      await page.waitForSelector('.yq-block')
      await page.click('.yq-doc-more')
      await page.waitForSelector('.yq-popover', { timeout: 3000 })
      await page.locator('.yq-menu-item', { hasText: '文档设置' }).click()
      await page.waitForSelector('.yq-modal', { timeout: 3000 })
      await page.waitForTimeout(350)
      const mb = await page.locator('.yq-modal').boundingBox()
      if (mb.width > vp.width) throw new Error(`弹窗比视口宽 ${Math.round(mb.width)} > ${vp.width}`)
      if (mb.width < 200) throw new Error('弹窗宽度异常: ' + mb.width)
      await assertNoOverflow(page, '弹窗')
      await shot(page, `${vp.name}-modal`)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
    })

    /* ---------- 6. 表格卡片：列宽不挤压，走横向滚动 ---------- */
    await check(`${vp.label} · 表格横向滚动`, async () => {
      for (const [hash, sel] of [[`${BASE}/#/book/b2/doc/t6`, '.yq-sheet-grid'], [`${BASE}/#/book/b2/doc/d7`, '.yq-dt-table table']]) {
        await page.goto(hash, { waitUntil: 'networkidle' })
        await page.waitForSelector(sel, { timeout: 8000 })
        await page.waitForTimeout(300)
        await assertNoOverflow(page, sel)
      }
      // 知识库设置中心的成员表：窄屏走横向滚动容器，不该把列压扁
      await page.goto(`${BASE}/#/book/b1/settings`, { waitUntil: 'networkidle' })
      await page.waitForSelector('.yq-bset-nav', { timeout: 8000 })
      await page.locator('button').filter({ hasText: '权限' }).first().click()
      await page.waitForTimeout(500)
      await page.waitForSelector('.yq-bset-member', { timeout: 5000 })
      const sc = await page.locator('.yq-bset-members').evaluate((e) => ({
        overflowX: getComputedStyle(e).overflowX,
        clientW: e.clientWidth,
        scrollW: e.scrollWidth,
      }))
      if (vp.phone) {
        // 手机：四列塞不下，必须靠横向滚动容器兜住，不能压扁列宽
        if (!['auto', 'scroll'].includes(sc.overflowX)) {
          throw new Error('成员表没有横向滚动容器: ' + JSON.stringify(sc))
        }
        const rowW = await page.locator('.yq-bset-member').first().evaluate((e) => e.getBoundingClientRect().width)
        if (rowW < 419) throw new Error(`成员行被压扁到 ${Math.round(rowW)}px，列宽在挤压: ` + JSON.stringify(sc))
      } else {
        // 平板：容器本身够宽，桌面四列版式保留即可
        if (sc.scrollW > sc.clientW + 1) throw new Error('平板下成员表不该横向溢出: ' + JSON.stringify(sc))
      }
      await assertNoOverflow(page, '知识库设置中心·成员表')
      await shot(page, `${vp.name}-bookset-members`)
    })

    await ctx.close()
  }

  await browser.close()
  server.close()

  const failed = steps.filter((s) => !s.ok)
  console.log('\n' + '='.repeat(60))
  console.log(`通过 ${steps.length - failed.length}/${steps.length}`)
  if (failed.length) {
    console.log('\n失败项：')
    failed.forEach((f) => console.log(`  ✗ ${f.label}\n    ${f.errs.join('\n    ')}`))
  }
  console.log(`\n截图目录: ${OUT}`)
  process.exit(failed.length ? 1 : 0)
})()
