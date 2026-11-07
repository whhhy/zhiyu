/* ============================================================
   粘贴 Markdown 自动转块（语雀招牌交互）+ 粘贴不丢内容

   之前这里有两个问题：
   1. 多行粘贴的循环里有个 `break`，粘 5 行只剩 1 行 —— **静默丢内容**
   2. 没有「粘 Markdown 源码 → 自动转块」这个语雀最有辨识度的交互

   转换函数也只认标题/引用/分割线/列表/待办，
   ``` 代码块、| 表格、![]() 图片这三类知识库里最常见的内容会原样落成正文。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:8092'
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const MD = `# 周会纪要

## 进展

- 完成了登录
- 权限也调通了

- [x] 写测试
- [ ] 接 LDAP

1. 第一步
2. 第二步

> 这是一条引用

\`\`\`ts
const x: number = 1
\`\`\`

| 模块 | 状态 | 负责人 |
| --- | --- | --- |
| 登录 | 完成 | 甲 |
| 权限 | 完成 | 乙 |

![架构图](https://example.com/a.png)

最后一段普通文字。`

const login = async (page, account, password) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 25000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', account)
  await page.fill('.yq-login-card input[type="password"]', password)
  await page.click('.yq-login-submit')
  await page.waitForSelector('.yq-app', { timeout: 30000 })
  await page.waitForTimeout(1200)
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

try {
  const p0 = await (await browser.newContext()).newPage()
  await login(p0, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const token = await p0.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }

  const bookId = await p0.evaluate((s) => window.__yqStore.getState().createBook('s1', '粘贴测试 ' + s), suffix)
  await p0.waitForTimeout(1800)
  const docId = await p0.evaluate((b) => window.__yqStore.getState().createDoc(b, null, '粘贴测试文档'), bookId)
  await p0.waitForTimeout(2200)

  /*
   * 复制剪贴板要权限（`clipboard-read` / `clipboard-write`），
   * 不授权的话断言只能测到「空串」—— 那正是这个 bug 的症状本身。
   */
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log('  [err]', e.message.slice(0, 160)))
  await login(p, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  await p.goto(`${BASE}/#/book/${bookId}/doc/${docId}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-block', { timeout: 25000 })
  await p.waitForTimeout(2000)

  // 事件必须打在 **contentEditable** 上：paste 处理器挂在那里，
  // 打在父级 .yq-block 上不会触发（事件不往下传），结果就是「什么都没发生」。
  const pasteInto = async (text) => {
    const el = document.querySelector('.yq-block [contenteditable="true"], .yq-block [contenteditable]')
    if (!el) throw new Error('找不到可编辑元素')
    const dt = new DataTransfer()
    dt.setData('text/plain', text)
    el.focus()
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }

  /*
   * 打开某个块的 `···` 菜单，读「粘贴」那一项的 disabled，然后收摊。
   * 只读状态、不点击 —— 要点的是「变亮了吗」，不是「点了会怎样」。
   */
  const menuPasteDisabled = async (blockLoc) => {
    const pg = blockLoc.page()
    const read = async () => {
      await pg.waitForSelector('.yq-menu-item', { state: 'visible', timeout: 2500 })
      return pg.evaluate(() => {
        const it = [...document.querySelectorAll('.yq-menu-item')]
          .find((e) => /粘贴/.test(e.textContent || ''))
        if (!it) return { found: false, disabled: null }
        const btn = it.querySelector('button') || it
        return { found: true, disabled: btn.disabled === true || it.classList.contains('is-disabled') }
      })
    }
    await blockLoc.hover()
    await blockLoc.locator('.yq-block-more').click()
    try {
      try {
        return await read()
      } catch {
        /*
         * `.yq-block-more` 是**toggle** —— 上一次如果没关干净，
         * 这一下点下去是把菜单**关**上，于是什么都等不到，
         * 表现成「菜单打不开」。再点一次就开了。
         * （排查这个花了一轮：菜单其实好好的，是**调用方式**不对。）
         */
        await blockLoc.locator('.yq-block-more').click()
        return await read()
      }
    } finally {
      await pg.keyboard.press('Escape')
      await pg.waitForTimeout(250)
    }
  }

  console.log('\n== 粘贴一段 Markdown ==')
  const before = await p.evaluate((d) => window.__yqStore.getState().docs[d].blocks.length, docId)
  await p.locator('.yq-block').last().click()
  await p.waitForTimeout(300)
  await p.evaluate(pasteInto, MD)
  await p.waitForTimeout(1800)

  const blocks = await p.evaluate((d) =>
    window.__yqStore.getState().docs[d].blocks.map((b) => ({ t: b.type, x: (b.text || '').slice(0, 26), src: b.src, lang: b.lang })), docId)
  // 表格要多带一点文字，下面要断言表头
  const tblRaw = await p.evaluate((d) => {
    const b = window.__yqStore.getState().docs[d].blocks.find((x) => x.type === 'table')
    return b ? b.text : ''
  }, docId)
  const after = blocks.length
  ok(after > before + 10, `块数明显增加（${before} → ${after}）`)
  ok(after > before, '一行都没丢（之前的多行粘贴只保留第一行）')

  console.log('\n== 各类语法都转成了对应的块 ==')
  const types = blocks.map((b) => b.t)
  const has = (t) => types.includes(t)
  ok(has('h1'), '标题 → h1')
  ok(has('h2'), '二级标题 → h2')
  ok(has('ul'), '无序列表 → ul', types.join(','))
  ok(has('ol'), '有序列表 → ol')
  ok(has('todo'), '待办 → todo')
  ok(has('quote'), '引用 → quote')
  ok(has('code'), '代码围栏 → code')
  ok(has('table'), '表格 → table')
  ok(has('image'), '图片 → image')

  const code = blocks.find((b) => b.t === 'code')
  ok(code && code.x.includes('const x: number = 1'), '代码块内容完整（多行都在）', code?.x)
  ok(code?.lang === 'ts', '代码块记住了语言', code?.lang)

  const img = blocks.find((b) => b.t === 'image')
  ok(img && img.src === 'https://example.com/a.png', '图片地址被解析出来', img?.src)

  const tblText = tblRaw
  ok(tblText.includes('模块') && tblText.includes('负责人'), '表格内容进了 block.text（TableBlock 读的就是它）', tblText.slice(0, 40).replace(/\n/g, ' '))

  const todos = blocks.filter((b) => b.t === 'todo')
  ok(todos.length === 2, '两条待办都在', String(todos.length))
  ok(todos.some((t) => t.x.includes('写测试')), '已完成那条内容对')

  console.log('\n== 纯文本（不是 Markdown）也要一行不丢 ==')
  const plain = '第一段\n\n第二段\n\n第三段'
  await p.locator('.yq-block').last().click()
  await p.waitForTimeout(300)
  const n1 = await p.evaluate((d) => window.__yqStore.getState().docs[d].blocks.length, docId)
  await p.evaluate(pasteInto, plain)
  await p.waitForTimeout(1500)
  const n2 = await p.evaluate((d) => window.__yqStore.getState().docs[d].blocks.length, docId)
  ok(n2 >= n1 + 3, `三段全在（${n1} → ${n2}）`)

  console.log('\n== 落库 ==')
  await p.waitForTimeout(2000)
  const srv = await (await fetch(`${BASE}/api/doc/${docId}`, { headers: H })).json()
  const srvTypes = srv.doc.blocks.map((b) => b.type)
  ok(srvTypes.includes('code') && srvTypes.includes('table'), '服务端存到了代码块与表格', srvTypes.join(','))
  ok(srv.doc.blocks.length >= n2, '服务端块数不少于本地')

  /*
   * 块级「复制内容 → 粘贴」（2026-10-18）
   * ------------------------------------------------------------
   * 块菜单原来只有「复制内容」、**没有「粘贴」** —— 复制完只能靠 Ctrl+V，
   * 而那是**纯文本**：粘回来代码块变成段落、表格变成一句话、卡片变成空壳。
   *
   * 所以这里不只验「多了一个块」，还要验**块类型和结构一起过来了** ——
   * 只数块数的话，一个「粘成空段落」的假实现照样全绿。
   */
  console.log('\n== 块级复制粘贴：类型与结构都要跟着过来 ==')
  {
    /*
     * ⚠️ **另建一篇干净的文档**，不要用上面那篇。
     *   上面那篇里有表格，而当时记的是「表格块的『复制卡片』按钮会盖住相邻块的 `···`」
     *   （实测 Playwright 一直报 pointer events intercepted，`force:true` 也不行）。
     *
     * ⚠️⚠️ **2026-10-19 复现尝试的结果：复现不了，所以那段描述不能当结论用。**
     *   专门写了取证脚本（自起服务 + 命中测试 + 截图）试了 6 种排列：
     *   表格在最前 / 最后 / 紧跟长代码块 / 三列八行大表 / 表接表 / 紧跟长列表 ——
     *   **没有一处被盖住**。
     *
     *   几何上也说得通：`.yq-card-toolbar` 是 `left:0` 收缩到内容宽（实测 96px），
     *   而 `.yq-block-more` 在 `right:-30px`（实测 x≈1136 的右侧栏）——
     *   水平方向隔着大半个屏幕，不可能相交。
     *
     *   取证过程中量到过两次「点不到」，两次都是**判据自己的错**：
     *     ① `elementFromPoint` 返回 `null` —— 那是**点在视口外**（内容被长代码块顶出屏幕），
     *        不是遮挡。第一版没先判断点是否在视口内，于是差点为一件不存在的事改 CSS。
     *     ② 命中的是 `button.yq-doc-share` —— 那是**吸顶文档头**，
     *        因为 `scrollIntoView` 把块滚到了头子底下。也不是遮挡。
     *   ⇒ 「点不到」有三种可能（被盖住 / 在视口外 / 滚到吸顶头底下），
     *      判据必须分得开，否则就会「量到问题、其实没问题」。
     *
     *   所以这一段保留干净的文档，理由改成「**别让上面的文档干扰本节**」，
     *   而不是「上面那个有 bug」。
     */
    const cleanId = await p.evaluate((b) => {
      const st = window.__yqStore.getState()
      const doc = st.createDoc(b, null, '块级复制粘贴', 'doc')
      st.setDocBlocks(doc, [
        { id: 'bk_pp1', type: 'h2', text: '粘贴目标块' },
        { id: 'bk_pp2', type: 'code', text: 'const copied = 1', lang: 'ts' },
      ])
      return doc
    }, bookId)
    await p.goto(`${BASE}/#/book/${bookId}/doc/${cleanId}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block[data-block-id="bk_pp2"]', { timeout: 20000 })
    await p.waitForTimeout(900)

    const before = await p.evaluate((d) => window.__yqStore.getState().docs[d].blocks.length, cleanId)
    ok(before === 2, `干净文档里有 2 个块（h2 + code）`, String(before))

    // ① 悬停代码块 → ⋯ → 复制内容
    const src = p.locator('.yq-block[data-block-id="bk_pp2"]')
    await src.hover()
    await p.waitForTimeout(400)
    await src.locator('.yq-block-more').click()
    await p.waitForSelector('.yq-menu-item', { state: 'visible', timeout: 8000 })
    const menuTexts = await p.locator('.yq-menu-item').allTextContents()
    ok(menuTexts.some((t) => /复制内容/.test(t)), '块菜单里有「复制内容」')
    ok(menuTexts.some((t) => /粘贴/.test(t)),
      '★ 块菜单里有「粘贴」', menuTexts.join(' / '))
    await p.locator('.yq-menu-item', { hasText: '复制内容' }).first().click()
    await p.waitForTimeout(500)

    // ② 悬停 h2 块 → ⋯ → 粘贴（粘贴位置由**目标块**决定，所以得换个块）
    const dst = p.locator('.yq-block[data-block-id="bk_pp1"]')
    await dst.hover()
    await p.waitForTimeout(400)
    await dst.locator('.yq-block-more').click()
    await p.waitForSelector('.yq-menu-item', { state: 'visible', timeout: 8000 })
    const pasteItem = p.locator('.yq-menu-item', { hasText: '粘贴' }).first()
    const enabled = await pasteItem.evaluate((el) => !String(el.className).includes('is-disabled'))
    ok(enabled, '复制过之后「粘贴」是可点的（不是一直灰着）')
    await pasteItem.click()
    await p.waitForTimeout(1200)

    const shape = await p.evaluate((d) => {
      const bs = window.__yqStore.getState().docs[d].blocks
      return { types: bs.map((b) => b.type), texts: bs.map((b) => b.text) }
    }, cleanId)
    ok(shape.types.length === before + 1, `多了一个块（${before} → ${shape.types.length}）`, shape.types.join(','))
    /* 这一条才是重点：只数块数的话，「粘成一个空段落」的假实现照样全绿 */
    ok(shape.types.filter((t) => t === 'code').length === 2,
      '★ 粘回来的是**代码块**（类型没退化成段落）', shape.types.join(','))
    ok(shape.texts.some((t) => String(t).includes('const copied = 1')),
      '★ 粘回来的内容就是复制的那一块', JSON.stringify(shape.texts))

    /* `evaluate` 只接**一个**参数 —— 两个参数要打包成数组传，
       否则报 "Too many arguments"。 */
    await p.evaluate(([b, d]) => window.__yqStore.getState().deleteDoc(d), [bookId, cleanId])
  }

  /*
   * 粘贴图片（2026-10-18）
   * ------------------------------------------------------------
   * 之前 `handlePaste` 第一句就是 `getData('text/plain')`，于是：
   *   · 截图 Ctrl+V —— text/plain 是**空串**，分支等于什么都没做，
   *     用户看到「按了没反应」，控制台一句错都没有；
   *   · 从别的应用复制图片 —— 同上。
   * 图片块自己早就能收文件了（ImageBlock → attachFileToDoc），
   * 只是剪贴板里的东西**从来没被送到它手上**。
   *
   * ⚠️ 判据必须验「真的插进去一个带 key 的图片块」，
   *    不能只看块数 —— 一个「插了个空图片块、里面什么都没有」
   *    的假实现，块数照样对，而用户看到的还是一片空白。
   */
  console.log('\n== 粘贴剪贴板里的图片 ==')
  {
    const imgId = await p.evaluate((b) => {
      const st = window.__yqStore.getState()
      const doc = st.createDoc(b, null, '粘贴图片测试', 'doc')
      st.setDocBlocks(doc, [{ id: 'bk_img_t', type: 'p', text: '粘到这里' }])
      return doc
    }, bookId)
    await p.goto(`${BASE}/#/book/${bookId}/doc/${imgId}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block[data-block-id="bk_img_t"]', { timeout: 20000 })
    await p.waitForTimeout(800)

    /* 造一个**真 PNG**（1×1），走 ClipboardEvent 塞进 items */
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64')
    const before = await p.evaluate((d) => window.__yqStore.getState().docs[d].blocks.length, imgId)

    const got = await p.evaluate(async ([d, b64]) => {
      const bin = atob(b64)
      const arr = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
      const file = new File([arr], 'shot.png', { type: 'image/png' })
      const dt = new DataTransfer()
      dt.items.add(file)
      const el = document.querySelector('.yq-block[data-block-id="bk_img_t"] [contenteditable]')
        || document.querySelector('.yq-block[data-block-id="bk_img_t"]')
      if (!el) return { ok: false, why: '找不到可粘贴的块元素' }
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      return { ok: true }
    }, [imgId, png.toString('base64')])
    ok(got.ok, '往块里派发了一个带 image/png 的粘贴事件', JSON.stringify(got))

    await p.waitForTimeout(2500)
    const shape = await p.evaluate((d) => {
      const bs = window.__yqStore.getState().docs[d].blocks
      const imgs = bs.filter((b) => b.type === 'image')
      return {
        n: bs.length,
        imgs: imgs.length,
        keyed: imgs.filter((b) => (b.data && (b.data.key || b.data.dataUrl))).length,
        name: imgs[0] && imgs[0].data ? imgs[0].data.name : '',
      }
    }, imgId)
    /*
     * ⚠️ 2026-10-20：粘完图片**不再另起一个空段落**了。
     *   语雀的形态是「图片**右边**紧跟着文字，**同一行**」
     *   （用户给的截图：图片右边就是那段话）。
     *   ⇒ 现在图片块的 `text` 装的就是「图片后面那段话」，
     *     光标粘完就落在那里，可以直接接着写。
     */
    ok(shape.n === before + 1,
      `只多了一个图片块（没有另起空段落 —— 字跟在图片**右边**同一行）（${before} → ${shape.n}）`,
      JSON.stringify(shape))
    ok(shape.imgs === 1, `插进来的是**图片块**（${shape.imgs} 个）`, JSON.stringify(shape))
    ok(shape.keyed === 1,
      '★ 图片块里有 key 或 dataUrl（**不是空壳** —— 只数块数的话假实现照样全绿）',
      JSON.stringify(shape))
    ok(/shot\.png/.test(shape.name), '★ 附件名就是剪贴板里那个（上传成功了）', shape.name)

    /*
     * 图片块要有**自己的悬浮工具条**（语雀：图片是卡片，悬浮时左上角出现工具条）。
     * 表格块早就有 `.yq-card-toolbar`，图片却没有 ——
     * 于是「复制这张图」在图片上**一个入口都没有**。
     */
    const toolbar = await p.evaluate(() => {
      const b = document.querySelector('.yq-block-image')
      const tb = b ? b.querySelector('.yq-img-toolbar') : null
      if (!tb) return { found: false }
      const cs = getComputedStyle(tb)
      return {
        found: true,
        opacity: cs.opacity,
        buttons: [...tb.querySelectorAll('button, a')].map((e) => (e.getAttribute('title') || e.textContent || '').trim()),
      }
    })
    ok(toolbar.found, '图片块上有悬浮工具条', JSON.stringify(toolbar))
    ok(toolbar.buttons.some((t) => /复制图片/.test(t)),
      '★ 工具条里有「复制图片」', JSON.stringify(toolbar.buttons))
    ok(toolbar.buttons.some((t) => /下载/.test(t)),
      '★ 工具条里有「下载图片」', JSON.stringify(toolbar.buttons))
    // 悬停时它要真的显形（不是永远 opacity:0）
    await p.locator('.yq-block-image img').hover()
    await p.waitForTimeout(500)
    const shown = await p.evaluate(() => {
      const wrap = document.querySelector('.yq-img-block')
      const tb = document.querySelector('.yq-img-toolbar')
      return {
        opacity: tb ? getComputedStyle(tb).opacity : null,
        wrapHovered: wrap ? wrap.matches(':hover') : null,
      }
    })
    ok(shown.opacity === '1',
      `悬停图片时工具条显形（opacity=${shown.opacity}，容器 hover=${shown.wrapHovered}）`, JSON.stringify(shown))

    /*
     * 粘完图片要能**接着往下写**（2026-10-19 用户报「图片在最后一行粘贴，
     * 没办法继续往下写新行」；2026-10-20 又补充了语雀的形态：
     * 图片**右边**紧跟着文字，**同一行**）。
     *
     * 原来的症状比「建不了行」更糟：粘贴是「在当前块之后插」，
     * 而当前块是**图片上面那个** —— 光标还留在那儿，
     * 用户接着打字，字直接跑到了图片**上面**
     * （实测：块变成 ["接着写的字图片前面这段", image]）。
     *
     * 现在：光标落在**图片右边那段**（图片块的 `text`），字就跟在图片同一行。
     */
    const tail = await p.evaluate((d) => {
      const bs = window.__yqStore.getState().docs[d].blocks
      const el = document.activeElement
      const inBlock = el && el.closest ? el.closest('.yq-block') : null
      const focusId = inBlock ? inBlock.getAttribute('data-block-id') : null
      return {
        n: bs.length,
        types: bs.map((b) => b.type),
        lastId: bs.length ? bs[bs.length - 1].id : null,
        focusId,
        focusIsEditable: !!(el && el.getAttribute && el.getAttribute('contenteditable') === 'true'),
        focusInImgText: !!(el && el.closest && el.closest('.yq-img-text')),
      }
    }, imgId)
    ok(tail.focusIsEditable && tail.focusInImgText && tail.focusId === tail.lastId,
      '★ 光标落在**图片右边那段**里（可以马上接着打字，跟图片同一行）', JSON.stringify(tail))

    await p.keyboard.type('接着写的字', { delay: 60 })
    await p.waitForTimeout(1200)
    const typed = await p.evaluate((d) => {
      const bs = window.__yqStore.getState().docs[d].blocks
      return { texts: bs.map((b) => String(b.text || '').slice(0, 24)), types: bs.map((b) => b.type) }
    }, imgId)
    const imgText = typed.texts[typed.texts.length - 1]
    ok(imgText === '接着写的字',
      '★ 接着打的字落在**图片自己那段**里（不是跑到图片上面去了）',
      JSON.stringify(typed.texts))
    ok(!typed.texts[0].includes('接着写的字'),
      '★ 图片**上面**那个段落没被塞进这串字', JSON.stringify(typed.texts))

    await p.evaluate(([b, d]) => window.__yqStore.getState().deleteDoc(d), [bookId, imgId])
  }

  /*
   * Ctrl+C / Ctrl+V 的块级复制粘贴（2026-10-19 重写）
   * ------------------------------------------------------------
   * 原来那一版的毛病不是「少一个功能」，是**剪贴板和操作对不上**：
   * 编辑器没有 `onCopy`，用户按 Ctrl+C 走浏览器原生行为，
   * 那个模块级 `blockClipboard` 纹丝不动；接着点菜单「粘贴」，
   * 粘出来的是**上一次点菜单复制的那个块**。
   *
   * 所以这里断言的是**对应关系**，不是「有个粘贴按钮」：
   *   ① 按 Ctrl+C 之后，菜单里的「粘贴」必须**变亮**
   *      （它原来在渲染那一刻读模块级变量，复制完不会重渲染）
   *   ② 粘回来必须**类型不退化**（表格不能变成一段管道符）
   */
  console.log('\n== Ctrl+C 之后，菜单里的「粘贴」要变亮 ==')
  {
    const cId = await p.evaluate((b) => {
      const st = window.__yqStore.getState()
      const doc = st.createDoc(b, null, 'CtrlC 测试', 'doc')
      st.setDocBlocks(doc, [
        { id: 'bk_c1', type: 'h2', text: '第一个块' },
        { id: 'bk_c2', type: 'code', text: 'const a = 1', lang: 'ts' },
        { id: 'bk_c3', type: 'p', text: '第三个块' },
      ])
      return doc
    }, bookId)
    await p.goto(`${BASE}/#/book/${bookId}/doc/${cId}`, { waitUntil: 'domcontentloaded' })
    /*
     * ⚠️ 必须**刷新**，不能只改 hash。
     * 块剪贴板是模块级变量：同一页面里跳路由不会重新加载模块，
     * 而上面「复制内容」那一节已经往里写过东西了 ——
     * 不刷新的话「一开始是灰的」这条必然假红。
     */
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block[data-block-id="bk_c2"]', { timeout: 20000 })
    await p.waitForTimeout(900)

    // 先看一眼：没复制过时「粘贴」应该是灰的
    const beforeState = await menuPasteDisabled(p.locator('.yq-block[data-block-id="bk_c2"]'))
    ok(beforeState.disabled, '还没复制过时，「粘贴」是置灰的', JSON.stringify(beforeState))

    // 点一下代码块（把 activeId 设成它），然后派发 copy 事件
    const copied = await p.evaluate(() => {
      const sel = window.getSelection()
      if (sel) sel.removeAllRanges()          // 必须没有文本选区，否则按 Ctrl+C 是「复制这几个字」
      const block = document.querySelector('.yq-block[data-block-id="bk_c2"] .yq-block-text')
        || document.querySelector('.yq-block[data-block-id="bk_c2"]')
      block.focus()
      const dt = new DataTransfer()
      const root = document.querySelector('.yq-editor')
      root.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }))
      return { dispatched: true, focused: document.activeElement?.className || '' }
    })
    ok(copied.dispatched, '往 .yq-editor 派发了一个 copy 事件', JSON.stringify(copied))
    await p.waitForTimeout(700)

    const afterState = await menuPasteDisabled(p.locator('.yq-block[data-block-id="bk_c2"]'))
    ok(!afterState.disabled,
      '★ Ctrl+C 之后「粘贴」变亮了（原来它在渲染那一刻读模块变量，永远是旧值）',
      JSON.stringify(afterState))

    // ★ 现在往**别的块**里粘一个带自定义 MIME 的剪贴板 —— 结构必须原样过来
    console.log('\n== 自定义 MIME 的块结构要原样粘回来 ==')
    const beforeN = await p.evaluate((d) => window.__yqStore.getState().docs[d].blocks.length, cId)
    const pasted = await p.evaluate(() => {
      const dt = new DataTransfer()
      dt.setData('application/x-yuque-block', JSON.stringify([
        { type: 'table', text: '| 列一 | 列二 |\n| --- | --- |\n| 甲 | 乙 |' },
        { type: 'code', text: 'const pasted = 2', lang: 'ts' },
      ]))
      // 同时放一份纯文本 —— 判据要证明结构那一路**优先于**文本那一路
      dt.setData('text/plain', '| 列一 | 列二 |\n| --- | --- |\n| 甲 | 乙 |')
      const el = document.querySelector('.yq-block[data-block-id="bk_c3"] .yq-block-text')
        || document.querySelector('.yq-block[data-block-id="bk_c3"]')
      el.focus()
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      return { ok: true }
    })
    ok(pasted.ok, '往块里派发了一个带自定义 MIME 的粘贴事件')
    await p.waitForTimeout(2000)

    const shape = await p.evaluate((d) => {
      const bs = window.__yqStore.getState().docs[d].blocks
      return {
        n: bs.length,
        types: bs.map((b) => b.type),
        tableText: (bs.find((b) => b.type === 'table') || {}).text || '',
        codeText: (bs.find((b) => b.type === 'code' && /pasted/.test(b.text || '')) || {}).text || '',
      }
    }, cId)
    ok(shape.n === beforeN + 3,
      `粘进来 2 个内容块 + 1 个收尾空段落（${beforeN} → ${shape.n}）—— 收尾空段落是「末块接不了普通光标时留下的落点」`,
      JSON.stringify(shape))
    ok(shape.types.includes('table'), '★ 表格是**表格块**，没被降级成段落', shape.types.join(','))
    ok(shape.tableText.includes('| 列一 | 列二 |'),
      '★ 表格内容是原样（不是一段散掉的文字）', shape.tableText.slice(0, 60))
    ok(shape.types.filter((t) => t === 'code').length === 2,
      '★ 代码块也是代码块（结构没退化成段落）', shape.types.join(','))

    await p.evaluate(([b, d]) => window.__yqStore.getState().deleteDoc(d), [bookId, cId])
  }

  /*
   * 源码层：`navigator.clipboard?.writeText(...)` 这个写法**必须**不再出现。
   *
   * 为什么单列一条：它在**内网 HTTP**（非安全上下文，实测
   * `typeof navigator.clipboard === 'undefined'`）下是空操作，
   * 而界面**照样弹绿色的「已复制」** —— 全项目曾有 5 处。
   *
   * ⚠️ 判据必须**剥注释**：上面的注释里为了说明问题，
   *    正面引用了这个写法。不剥就会把说明文字当成代码来查。
   */
  console.log('\n== 源码里不许再有静默的剪贴板写法 ==')
  {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const strip = (src) => src
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
    const bad = []
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name)
        if (e.isDirectory()) { walk(f); continue }
        if (!/\.(ts|tsx)$/.test(e.name)) continue
        const src = strip(fs.readFileSync(f, 'utf8'))
        if (/navigator\.clipboard\?\./.test(src)) bad.push(f.replace(/\\/g, '/'))
      }
    }
    walk('src')
    ok(bad.length === 0, `src 里没有 navigator.clipboard?. 这种静默写法（查出 ${bad.length} 处）`, bad.join('、'))
    ok(fs.existsSync('src/lib/clipboard.ts'), '剪贴板统一走 src/lib/clipboard.ts')
  }

  /*
   * **有选区时，粘贴要替换选区**（2026-10-19 用户报）
   * ------------------------------------------------------------
   * 症状：选了一段字，按 Ctrl+V，**内容粘到了下面一行/一块**，
   * 原来选中的字还在 —— 像是「没选中」，像是「粘到下一行」。
   *
   * 根因在 `handlePaste`：只要剪贴板是**多行**（或自家块结构），
   * 它就走 `onPasteBlocks(...)` —— 而那个函数是「在当前块**之后**插一批新块」，
   * **从头到尾没看选区**。
   * 单行纯文本那条走的是 `execCommand('insertText')`，那个会替换选区 ——
   * 于是「粘单词正常、粘多行就跑偏」，很像是两套逻辑各说各话。
   *
   * 判据要盯的是「**被选中的那块**有没有被替换」，
   * 不是「文档里有没有出现新内容」—— 后者新旧实现都满足。
   */
  console.log('\n== 有选区时，粘贴要替换选区，而不是粘到下一行 ==')
  {
    const sId = await p.evaluate((b) => {
      const st = window.__yqStore.getState()
      const doc = st.createDoc(b, null, '选区粘贴测试', 'doc')
      st.setDocBlocks(doc, [
        { id: 'bk_s1', type: 'p', text: '原始文字在这里' },
        { id: 'bk_s2', type: 'p', text: '下面这一段不该被动' },
      ])
      return doc
    }, bookId)
    await p.goto(`${BASE}/#/book/${bookId}/doc/${sId}`, { waitUntil: 'domcontentloaded' })
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block[data-block-id="bk_s1"]', { timeout: 20000 })
    await p.waitForTimeout(900)

    /* ---------- ① 单行纯文本：替换选中的那几个字 ---------- */
    const single = await p.evaluate(() => {
      const el = document.querySelector('.yq-block[data-block-id="bk_s1"] .yq-block-text')
      const node = el.firstChild
      const range = document.createRange()
      range.setStart(node, 0)
      range.setEnd(node, 2)                      // 选中「原始」
      const s = window.getSelection()
      s.removeAllRanges()
      s.addRange(range)
      const picked = s.toString()
      const dt = new DataTransfer()
      dt.setData('text/plain', '替换')
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      return { picked }
    })
    ok(single.picked === '原始', '确实选中了「原始」两个字', JSON.stringify(single))
    await p.waitForTimeout(1200)
    const afterSingle = await p.evaluate((d) => {
      const bs = window.__yqStore.getState().docs[d].blocks
      return { n: bs.length, first: bs[0].text, second: bs[1] ? bs[1].text : '' }
    }, sId)
    ok(afterSingle.first === '替换文字在这里',
      '★ 选中的字被**替换**了（不是留在原地）', JSON.stringify(afterSingle))
    ok(afterSingle.n === 2, `块数没变（2 → ${afterSingle.n}）`, String(afterSingle.n))

    /* ---------- ② 多行 Markdown：替换掉被选中的那一块 ---------- */
    const multi = await p.evaluate(() => {
      const el = document.querySelector('.yq-block[data-block-id="bk_s1"] .yq-block-text')
      const range = document.createRange()
      range.selectNodeContents(el)               // 选中整块
      const s = window.getSelection()
      s.removeAllRanges()
      s.addRange(range)
      /* ⚠️ 选区内容必须在**派发之前**读。
       * 派发之后粘贴会把选区清掉（替换动作天然如此），
       * 于是 `s.toString()` 读到空串 —— 看着像「没选中」，
       * 实际是探针自己站错了位置。 */
      const picked = s.toString()
      const dt = new DataTransfer()
      dt.setData('text/plain', '# 新标题\n\n新正文')
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
      return { picked }
    })
    ok(/原始|替换/.test(multi.picked), '选中了整块内容', JSON.stringify(multi))
    await p.waitForTimeout(1800)
    const afterMulti = await p.evaluate((d) => {
      const bs = window.__yqStore.getState().docs[d].blocks
      return { n: bs.length, types: bs.map((b) => b.type), texts: bs.map((b) => b.text) }
    }, sId)
    ok(!afterMulti.texts.some((t) => String(t).includes('替换文字在这里')),
      '★ 被选中的那一块**被替换掉了**（原文没留下来）', JSON.stringify(afterMulti.texts))
    ok(afterMulti.n === 3,
      `块数是 3（1 块换成 2 块 + 下面那 1 块），不是 4 —— 原来多出来一块说明是「追加」而不是「替换」（实际 ${afterMulti.n}）`,
      String(afterMulti.n))
    ok(afterMulti.types[0] === 'h1', '★ 替换上去的是**标题块**（Markdown 转换照常）', afterMulti.types.join(','))
    ok(afterMulti.texts[2] === '下面这一段不该被动',
      '没被选中的那一块没被动过', JSON.stringify(afterMulti.texts))

    /* ---------- ③ 替换完之后光标要落在新块里 ---------- */
    const focus = await p.evaluate(() => {
      const el = document.activeElement
      const block = el && el.closest ? el.closest('.yq-block') : null
      return {
        tag: el ? el.tagName : 'null',
        blockId: block ? block.getAttribute('data-block-id') : null,
      }
    })
    ok(focus.blockId !== null,
      '★ 替换完之后光标还落在正文里（不是丢了焦点还得再点一下）', JSON.stringify(focus))

    await p.evaluate(([b, d]) => window.__yqStore.getState().deleteDoc(d), [bookId, sId])
  }

  /*
   * 多选块：勾选若干块之后粘贴，要**替换那些块**（2026-10-19 用户报「选择粘贴粘到下一行」的另一半）
   * ------------------------------------------------------------
   * 「选择」有两种，粘贴都得对上：
   *   ① 文本选区 —— 粘到选区压到的块上
   *   ② 多选块（勾选框 / ⌘点 / ⇧连选）—— 粘到被勾选的块上
   * 以前两种都是「在当前块之后追加」。
   */
  console.log('\n== 多选块之后粘贴，替换被勾选的块 ==')
  {
    const mId = await p.evaluate((b) => {
      const st = window.__yqStore.getState()
      const doc = st.createDoc(b, null, '多选粘贴测试', 'doc')
      st.setDocBlocks(doc, [
        { id: 'bk_m1', type: 'p', text: '甲块' },
        { id: 'bk_m2', type: 'p', text: '乙块' },
        { id: 'bk_m3', type: 'p', text: '丙块' },
      ])
      return doc
    }, bookId)
    await p.goto(`${BASE}/#/book/${bookId}/doc/${mId}`, { waitUntil: 'domcontentloaded' })
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block[data-block-id="bk_m1"]', { timeout: 20000 })
    await p.waitForTimeout(900)

    // ⌘/Ctrl 点块 = 逐个加/减（判定在 onMouseDown，所以点的是块本身）
    await p.locator('.yq-block[data-block-id="bk_m1"] .yq-block-text').click({ modifiers: ['Control'] })
    await p.waitForTimeout(300)
    await p.locator('.yq-block[data-block-id="bk_m2"] .yq-block-text').click({ modifiers: ['Control'] })
    await p.waitForTimeout(500)
    const selected = await p.evaluate(() => document.querySelectorAll('.yq-block.is-selected').length)
    ok(selected === 2, `勾选了 2 个块（实际 ${selected}）`, String(selected))

    await p.evaluate(() => {
      const dt = new DataTransfer()
      dt.setData('text/plain', '# 换掉的标题')
      const el = document.querySelector('.yq-block[data-block-id="bk_m3"] .yq-block-text')
      el.focus()
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    await p.waitForTimeout(1800)
    const after = await p.evaluate((d) => {
      const bs = window.__yqStore.getState().docs[d].blocks
      return { n: bs.length, types: bs.map((b) => b.type), texts: bs.map((b) => b.text) }
    }, mId)
    ok(!after.texts.includes('甲块') && !after.texts.includes('乙块'),
      '★ 被勾选的两个块**被替换掉了**', JSON.stringify(after.texts))
    ok(after.n === 2, `块数是 2（2 块换成 1 块 + 丙块），不是 4（实际 ${after.n}）`, String(after.n))
    ok(after.texts.includes('丙块'), '没被勾选的块还在', JSON.stringify(after.texts))

    await p.evaluate(([b, d]) => window.__yqStore.getState().deleteDoc(d), [bookId, mId])
  }

  /*
   * 图片块能不能复制（2026-10-19 用户报「编辑界面的图片不能复制」）
   * ------------------------------------------------------------
   * 两处：
   *   ① **右键被劫持** —— 块级 `onContextMenu` 调了 `preventDefault()`，
   *      于是浏览器自带的「复制图片」「在新标签页打开图片」**没了**。
   *      而「复制图片」要写图片二进制进剪贴板，那需要**安全上下文** ——
   *      内网 HTTP 部署下我们自己给不出来，所以更不能把原生那条路堵死。
   *   ② **「复制内容」复制的是空串** —— 图片块的 `text` 本来就是空的
   *      （图在 data/src 里），照抄它，粘到别处什么都没有。
   */
  console.log('\n== 图片块：右键不劫持 + 复制内容不是空串 ==')
  {
    const iId = await p.evaluate((b) => {
      const st = window.__yqStore.getState()
      const doc = st.createDoc(b, null, '图片块复制测试', 'doc')
      st.setDocBlocks(doc, [
        { id: 'bk_c1', type: 'p', text: '图片前面这段' },
        { id: 'bk_c2', type: 'image', text: '', src: 'https://example.com/pic.png' },
      ])
      return doc
    }, bookId)
    await p.goto(`${BASE}/#/book/${bookId}/doc/${iId}`, { waitUntil: 'domcontentloaded' })
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block[data-block-id="bk_c2"]', { timeout: 25000 })
    await p.waitForTimeout(900)

    /* ① 右键图片：原生菜单必须拿得到（defaultPrevented 要是 false） */
    const ctxRes = await p.evaluate(() => {
      const img = document.querySelector('.yq-block[data-block-id="bk_c2"] img')
      if (!img) return { found: false }
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })
      img.dispatchEvent(ev)
      return { found: true, defaultPrevented: ev.defaultPrevented }
    })
    ok(ctxRes.found, '图片块里确实渲染出了 <img>')
    ok(ctxRes.defaultPrevented === false,
      '★ 右键图片**没有**被拦（浏览器原生的「复制图片」还能用）',
      `defaultPrevented=${ctxRes.defaultPrevented}`)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(300)

    /* ② 块菜单里有「复制图片」 */
    await p.locator('.yq-block[data-block-id="bk_c2"]').hover()
    await p.waitForTimeout(300)
    await p.locator('.yq-block[data-block-id="bk_c2"] .yq-block-more').click()
    await p.waitForSelector('.yq-menu-item', { state: 'visible', timeout: 8000 })
    const menu = await p.evaluate(() =>
      [...document.querySelectorAll('.yq-menu-item')].map((e) => (e.textContent || '').trim()))
    ok(menu.some((t) => /复制图片/.test(t)), '图片块的菜单里有「复制图片」', JSON.stringify(menu))
    ok(menu.some((t) => /复制内容/.test(t)), '图片块的菜单里也有「复制内容」', JSON.stringify(menu))

    /* ③ 「复制内容」复制到系统剪贴板的**不是空串** */
    await p.evaluate(() => navigator.clipboard.writeText('__清空__'))
    await p.locator('.yq-menu-item', { hasText: '复制内容' }).first().click()
    await p.waitForTimeout(1200)
    const clip = await p.evaluate(() => navigator.clipboard.readText())
    ok(clip && clip.trim() && clip !== '__清空__',
      '★ 「复制内容」复制到系统剪贴板的是**图片地址**，不是空串', JSON.stringify(clip))
    ok(/pic\.png/.test(clip),
      '★ 而且复制的正是这张图的地址', JSON.stringify(clip))

    await p.evaluate(([b, d]) => window.__yqStore.getState().deleteDoc(d), [bookId, iId])
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

process.exit(fail ? 1 : 0)
