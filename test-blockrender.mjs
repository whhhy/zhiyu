/* ============================================================
   h3 / h4 / callout / quote：这四种块**真的被画出来了吗**
   ============================================================
   为什么要有这一节：上一轮量化编辑器内核差距时扫出这么一条 ——
   `h3`、`h4`、`callout` 这三个字符串，在全项目 104 个测试/冒烟文件里
   **一次都没出现过**（`quote` 只在导入解析里出现过）。
   而它们在源码里是有实现的（`callout` 命中 7 个源文件）。

   「有实现」和「被测过」之间那道缝，正是本项目反复吃的一类：
   后端绿、前端没被走到；或者样式规则哪天被人删了，
   **2640 多项断言没有一项会红**，因为压根没有一项看着它。

   ------------------------------------------------------------
   这四种块和别的块有一处结构性的不一样，写断言前必须知道
   ------------------------------------------------------------
   `Editor.tsx` 的分派是「**外层类名 + CSS**」，不是标签：
   p / h1-h4 / ul / ol / todo / quote / callout **全部**渲染成同一个
   `<div class="yq-block-text">`，差别只有外面那个 `.yq-block-{type}`。

   所以：
     · 断言 `<h3>` 标签       —— 一定失败（它不是 h3，是 div）
     · 断言「有 yq-block-h3 类」—— 恒真，等于没测
   唯一有意义的判据是**计算样式**：
     h1 2.1em > h2 1.6em > h3 1.27em > h4 1.07em > p 1em
     quote 有 border-left:3px + italic
     callout 的样式挂在外层（background/border），且多一个 .yq-callout-emoji

   字号是 em，跟着「编辑器字号」偏好缩放，所以**断言层级顺序**、
   不写死像素 —— 否则换个字号偏好这条测试就假红了。

   ------------------------------------------------------------
   破坏对照（跑过的实测值，不是设想）
   ------------------------------------------------------------
   基准 38 通过 / 0 失败。三处替换，逐个还原后复跑：

   ① 删掉 `.yq-block-quote .yq-block-text` 整条 → **35 通过 / 3 失败**
      红的是：左边线（实得 0px none）、斜体（实得 normal）、刷新后引用样式。
   ② h3 的 `font-size: 1.27em` → `1em` → **37 通过 / 1 失败**
      红的是「字号是递减的」。注意只红这一项：把 h3 改成跟正文一样，
      「和正文不一样吗」这种问法答不上来，但**顺序**立刻就不成立 ——
      这就是为什么这里断言的是 h3 > h4 > p 的序，不是「别相等」。
   ③ 把菜单完整还原成 0×0（CSS 尺寸 + JSX 把手 + 操作条 hover 规则，三处同去）
      → **4 通过 / 2 失败**，且套件在 hover 那步直接超时中止。

      ②第一次只去掉 CSS 里的 width/height 时**没有红** ——
      因为 JSX 那个把手 `<span>` 自带行高，容器照样不是 0×0。
      也就是说这个修复有两处独立贡献，只去一处复现不出原状。
      想验证「原缺陷真被抓住」，必须三处一起去掉才算数。

   三次替换都已还原，还原后复跑回到 38/0。

   ------------------------------------------------------------
   这一节顺带抓出来的两个真缺陷（都修了）
   ------------------------------------------------------------
   1. **「块类型」菜单从来就打不开。**
      `.yq-block-type-menu` 里唯一的子元素是 `display:none` 的面板，
      所以容器塌成 0×0；而打开面板的唯一 CSS 是 `:hover` 这个 0×0 的元素。
      实测：操作条 48×20、容器 0×0、hover 超时、鼠标移到它坐标上也不出现。
      换块类型当时只能靠 markdown 快捷键。
   2. **高亮块（callout）的底色一编辑就没。**
      `.yq-block.is-active { background: transparent }` 是 (0,2,0)，
      压过 `.yq-block-callout` 的 (0,1,0)。用 CDP 的层叠结论确认过，
      不是读 CSS 猜的。
   =================================================================== */
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')
const PW = process.env.ADMIN_PASS || 'yuque@2026'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const TYPES = [
  { type: 'h3', label: '标题 3', mark: '三级标题' },
  { type: 'h4', label: '标题 4', mark: '四级标题' },
  { type: 'quote', label: '引用', mark: '引用一段' },
  { type: 'callout', label: '高亮块', mark: '提示一段' },
]

const browser = await chromium.launch()

/** 逐块取「类型类名 + 计算样式」。这是唯一能区分这几种块的信号。 */
const probe = (page) => page.$$eval('.yq-block', (els) =>
  els.map((el) => {
    const t = el.querySelector('.yq-block-text') || el
    const cs = getComputedStyle(t)
    const bs = getComputedStyle(el)
    return {
      cls: el.className,
      text: (t.innerText || '').trim(),
      fontSize: parseFloat(cs.fontSize),
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      blW: cs.borderLeftWidth,
      blS: cs.borderLeftStyle,
      blockBg: bs.backgroundColor,
      blockBorderW: bs.borderTopWidth,
      blockRadius: bs.borderTopLeftRadius,
      hasEmoji: !!el.querySelector('.yq-callout-emoji'),
    }
  }),
)

const byType = (rows, t) => rows.find((r) => new RegExp(`yq-block-${t}\\b`).test(r.cls))

/** 界面上把第 idx 个块转成 type（走真实的「块类型」菜单） */
const convertViaMenu = async (page, idx, type, label) => {
  const block = page.locator('.yq-block').nth(idx)
  // 面板默认 display:none，只有 hover 才显示 —— 不 hover 就点会失败
  await block.locator('.yq-block-type-menu').hover()
  await block.locator(`.yq-block-type-item:has-text("${label}")`).click()
  await page.waitForTimeout(250)
}

try {
  const ctx = await browser.newContext()
  const p = await ctx.newPage()

  console.log('== 登录 + 建一个自己的库/文档（不碰共享夹具）==')
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', PW)
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(1000)

  const sfx = Date.now().toString(36)
  const bookId = await p.evaluate((s) => window.__yqStore.getState().createBook('s1', '块渲染探针库 ' + s), sfx)
  await p.waitForTimeout(2000)
  const docId = await p.evaluate((b) => window.__yqStore.getState().createDoc(b, null, '块渲染探针'), bookId)
  await p.waitForTimeout(2000)
  ok(!!bookId && !!docId, `建了探针库 / 文档（${bookId} / ${docId}）`)

  // createDoc 只往 store 放数据，页面还停在工作台 —— 必须自己再导航进去
  await p.goto(`${BASE}/#/book/${bookId}/doc/${docId}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-block', { timeout: 25000 })
  await p.waitForTimeout(600)

  console.log('\n== 先把正文块铺好 ==')
  /* 新建文档**只有 1 个块**，而且是 h1 —— 实测出来的，不是假设。
     Editor.tsx:72-78 的注释也写着「文档标题本身是第一个 H1 块」，所以这是设计。
     在标题里按 Enter 得到的是 p（onEnter 里 nextType = isList ? b.type : 'p'），
     标题不会自己续下去 —— 所以从标题往下铺 5 个正文块。 */
  let rows = await probe(p)
  ok(rows.length === 1 && /yq-block-h1\b/.test(rows[0].cls), '新建文档只有 1 个块，且是标题块',
    rows.map((r) => r.cls).join(' | '))

  const marks = ['正文基准', ...TYPES.map((t) => t.mark)]
  await p.locator('.yq-block-text').nth(0).click()
  await p.keyboard.type('块渲染探针', { delay: 15 })
  for (let i = 0; i < marks.length; i++) {
    await p.keyboard.press('Enter')
    await p.waitForTimeout(180)
    await p.keyboard.type(marks[i], { delay: 15 })
  }
  await p.waitForTimeout(400)
  rows = await probe(p)
  ok(rows.length === 6, `标题 + 5 个正文块 = ${rows.length} 个块`)
  ok(rows.slice(1).every((r) => /yq-block-p\b/.test(r.cls)), '后 5 个都是正文块（还没转换）',
    rows.map((r) => r.cls).join(' | '))

  console.log('\n== 「块类型」菜单必须打得开（回归钉子）==')
  {
    const mb = await p.locator('.yq-block-type-menu').nth(1).evaluate((el) => {
      const r = el.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    })
    ok(mb.w > 0 && mb.h > 0,
      `菜单容器有真实命中区（${mb.w}×${mb.h}）—— 0×0 时 :hover 永不成立，菜单等于不存在`, `${mb.w}×${mb.h}`)
    await p.locator('.yq-block-type-menu').nth(1).hover()
    await p.waitForTimeout(250)
    ok(await p.locator('.yq-block-type-panel').nth(1).isVisible(), 'hover 后面板真的弹出来了')
    ok(await p.locator('.yq-block-type-trigger').nth(1).isVisible(), '面板外面有个看得见的把手（不然没人知道这儿能点）')
    // 四种目标类型都得在菜单里摆着
    const items = await p.locator('.yq-block-type-panel').nth(1)
      .locator('.yq-block-type-item').allTextContents()
    for (const { label } of TYPES)
      ok(items.some((x) => x.includes(label)), `菜单里有「${label}」这一项`)
  }

  console.log('\n== 走「块类型」菜单转出四种块 ==')
  /* 块 0 是标题，块 1 是留着当对照的正文，所以要转的是块 2..5 */
  for (let i = 0; i < TYPES.length; i++) {
    const { type, label, mark } = TYPES[i]
    await convertViaMenu(p, i + 2, type, label)
    rows = await probe(p)
    const r = byType(rows, type)
    ok(!!r, `菜单能转出 ${type}（${label}）`)
    ok(r?.text.includes(mark), `${type} 的文字没丢（${r?.text?.slice(0, 20)}）`)
  }
  rows = await probe(p)
  ok(!!byType(rows, 'p'), '作为对照的正文块还在（后面全靠它反证）')

  console.log('\n== 层级顺序：h3 > h4 > 正文（断言序，不断言像素）==')
  const [pRow, h3, h4] = [byType(rows, 'p'), byType(rows, 'h3'), byType(rows, 'h4')]
  ok(
    pRow && h3 && h4 && h3.fontSize > h4.fontSize && h4.fontSize > pRow.fontSize,
    `字号是递减的（正文 ${pRow?.fontSize} < h4 ${h4?.fontSize} < h3 ${h3?.fontSize}）`,
    `p=${pRow?.fontSize} h3=${h3?.fontSize} h4=${h4?.fontSize}`,
  )
  ok(h3?.fontWeight === '600' && h4?.fontWeight === '600', `标题字重 600（h3=${h3?.fontWeight} h4=${h4?.fontWeight}）`)
  ok(pRow && pRow.fontWeight !== '600', `正文不是标题字重（${pRow?.fontWeight}）`)

  console.log('\n== quote：引用块真有左边线和斜体 ==')
  const q = byType(rows, 'quote')
  ok(q?.blW === '3px' && q?.blS === 'solid', `左边线 3px solid（实得 ${q?.blW} ${q?.blS}）`)
  ok(q?.fontStyle === 'italic', `斜体（实得 ${q?.fontStyle}）`)
  ok(pRow && pRow.blW !== '3px' && pRow.fontStyle !== 'italic',
    `反证：正文没有左边线也不是斜体（${pRow?.blW} / ${pRow?.fontStyle}）—— 不然上面两条等于什么都没验`)

  console.log('\n== callout：底色挂在外层 + 带表情 ==')
  const c = byType(rows, 'callout')
  ok(!!c?.hasEmoji, 'callout 里有 .yq-callout-emoji 表情')
  ok(c?.blockBg && c.blockBg !== pRow?.blockBg, `底色和正文不同（${c?.blockBg} vs ${pRow?.blockBg}）`)
  ok(c?.blockBorderW === '1px', `外层有 1px 边框（${c?.blockBorderW}）`)
  ok(c?.blockRadius && c.blockRadius !== '0px', `外层有圆角（${c?.blockRadius}）`)
  ok(pRow && pRow.blockBorderW !== '1px', `反证：正文外层没有边框（${pRow?.blockBorderW}）`)

  console.log('\n== 刷新后还在吗（服务端往返）==')
  await p.waitForTimeout(1800)   // 等防抖落盘
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-block', { timeout: 25000 })
  await p.waitForTimeout(900)
  const after = await probe(p)
  for (const { type } of TYPES) {
    const r = byType(after, type)
    ok(!!r, `刷新后 ${type} 还在`)
  }
  const aq = byType(after, 'quote')
  ok(aq?.blW === '3px' && aq?.fontStyle === 'italic', `刷新后引用样式还在（${aq?.blW} / ${aq?.fontStyle}）`)
  const ac = byType(after, 'callout')
  ok(!!ac?.hasEmoji, '刷新后 callout 表情还在')
  ok(!!byType(after, 'p'), '刷新后对照正文块还在')

  /*
   * 末尾是**图片块**时，能不能在它下面新建一行（2026-10-19 用户报）
   * ------------------------------------------------------------
   * 「末尾继续输入区」的点击逻辑原来判的是「最后一块**没有文字**就进去」，
   * 而图片块的 text **本来就是空的**（图在 data 里）——
   * 于是它被当成「可以进去的空块」，而图片块**压根没有可编辑元素**：
   * 既进不去光标，**也不会新建一行**。
   *
   * 判据钉的是「**块数有没有变**」和「**光标落在哪**」——
   * 只看「末尾那块还在不在」的话，两种实现都满足。
   */
  console.log('\n== 末尾是图片块时，能在它下面新建一行 ==')
  {
    const imgDoc = await p.evaluate((b) => {
      const st = window.__yqStore.getState()
      const doc = st.createDoc(b, null, '图片块末尾探针')
      st.setDocBlocks(doc, [
        { id: 'bk_t1', type: 'p', text: '图片前面这段' },
        { id: 'bk_t2', type: 'image', text: '', src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
      ])
      return doc
    }, bookId)
    await p.goto(`${BASE}/#/book/${bookId}/doc/${imgDoc}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block[data-block-id="bk_t2"]', { timeout: 25000 })
    await p.waitForTimeout(900)

    const beforeN = await p.evaluate((d) => window.__yqStore.getState().docs[d].blocks.length, imgDoc)
    const tail = await p.locator('.yq-editor-tail').boundingBox()
    ok(!!tail, '末尾有一块「继续输入区」（点它应该能加一行）')
    if (tail) {
      await p.mouse.click(tail.x + tail.width / 2, tail.y + Math.min(20, tail.height / 2))
      await p.waitForTimeout(1200)
    }
    const afterN = await p.evaluate((d) => window.__yqStore.getState().docs[d].blocks.length, imgDoc)
    ok(afterN === beforeN + 1,
      `★ 在图片下面新建了一行（${beforeN} → ${afterN}）—— 原来块数不变，压根建不出来`,
      String(afterN))

    const focused = await p.evaluate(() => {
      const el = document.activeElement
      return {
        tag: el ? el.tagName : 'null',
        editable: !!(el && el.getAttribute && el.getAttribute('contenteditable') === 'true'),
      }
    })
    ok(focused.editable, `★ 光标落进了新行里（可以马上打字）—— ${focused.tag}`)

    await p.evaluate(([b, d]) => window.__yqStore.getState().deleteDoc(d), [bookId, imgDoc])
  }

  /*
   * 悬浮工具条不可见时**不许吃点击**（2026-10-20 实测出来的 bug）
   * ------------------------------------------------------------
   * 图片块和表格块都有一条悬浮工具条，它浮在块的**上方** 26px ——
   * 而那里正是**上一段文字**所在的位置。
   * `opacity: 0` 的元素**照样接收指针事件**，于是原状是：
   *   点上一段文字的中点，命中的是**看不见的「下载图片」**（点下去直接开始下载）。
   * 实测（修复前）：段落 x=494~540 那一整条被吃掉，5 个取样点里有 1 个命中工具条。
   *
   * ⚠️ 判据钉的是「**点得到的是不是那段文字**」，不是「工具条 opacity 是不是 0」——
   * 原状恰好是 opacity:0 而 pointer-events:auto，只改一半就会假绿。
   * ⚠️ fixture 必须保证**真的重叠**：用一张**宽图**（工具条落在图片右缘 = 段落文字中间）。
   * 1×1 的小图会让工具条缩到段落左缘之外，那样下面那条断言恒真、等于没测。
   *  ⇒ 所以先断言「**重叠区非空**」，再断言「重叠区里点得到的是那段文字」。
   */
  console.log('\n== 悬浮工具条不可见时不吃点击（否则它盖住上一段文字）==')
  {
    const WIDE = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120">'
      + '<rect width="240" height="120" fill="#8957e5"/></svg>')
    const tbDoc = await p.evaluate(([b, src]) => {
      const st = window.__yqStore.getState()
      const doc = st.createDoc(b, null, '工具条遮挡探针')
      st.setDocBlocks(doc, [
        { id: 'bk_s1', type: 'p', text: '图片上面这一段文字写得足够长，长到能铺满一整行，这样工具条正好落在文字中间' },
        { id: 'bk_s2', type: 'image', text: '', src },
        { id: 'bk_s3', type: 'p', text: '图片下面那一段' },
      ])
      return doc
    }, [bookId, WIDE])
    await p.goto(`${BASE}/#/book/${bookId}/doc/${tbDoc}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block-image', { timeout: 25000 })
    await p.waitForTimeout(900)

    const pr = await p.evaluate(() => {
      const para = document.querySelector('.yq-block[data-block-id="bk_s1"] .yq-block-text')
      const tb = document.querySelector('.yq-img-toolbar')
      if (!para || !tb) return { found: false }
      const a = para.getBoundingClientRect()
      const b = tb.getBoundingClientRect()
      /* 工具条与上面那段文字的**重叠区** */
      const x0 = Math.max(a.left, b.left), x1 = Math.min(a.right, b.right)
      const y0 = Math.max(a.top, b.top), y1 = Math.min(a.bottom, b.bottom)
      const overlap = { w: Math.round(x1 - x0), h: Math.round(y1 - y0) }
      let hit = null
      if (overlap.w > 2 && overlap.h > 2) {
        const el = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2)
        hit = {
          title: el ? (el.getAttribute('title') || '') : null,
          cls: el ? String(el.className).slice(0, 40) : null,
          inPara: el ? !!el.closest('.yq-block[data-block-id="bk_s1"]') : false,
          inToolbar: el ? !!el.closest('.yq-img-toolbar') : false,
        }
      }
      return {
        found: true,
        pointerEvents: getComputedStyle(tb).pointerEvents,
        opacity: getComputedStyle(tb).opacity,
        overlap,
        hit,
      }
    })
    ok(pr.found, '图片块上有工具条、它上面有那段文字', JSON.stringify(pr))
    ok(pr.overlap && pr.overlap.w > 2 && pr.overlap.h > 2,
      `★ fixture 真的重叠（工具条压在上一段文字上：${JSON.stringify(pr.overlap)}）—— 不重叠的话下面那些断言全恒真`,
      JSON.stringify(pr.overlap))
    ok(pr.pointerEvents === 'none',
      `★ 工具条不可见时不吃指针事件（pointer-events=${pr.pointerEvents}，opacity=${pr.opacity}）`, String(pr.pointerEvents))
    ok(pr.hit && pr.hit.inPara && !pr.hit.inToolbar,
      '★ 重叠区里点得到的是**上面那段文字**，不是看不见的「下载图片」', JSON.stringify(pr.hit))

    /* 反过来：显形之后按钮**仍然点得到**（别把「不吃事件」修成「永远点不到」） */
    await p.locator('.yq-block-image img').hover()
    await p.waitForTimeout(500)
    const reach = await p.evaluate(() => {
      const tb = document.querySelector('.yq-img-toolbar')
      if (!tb) return { found: false }
      const btn = tb.querySelector('a[title="下载图片"]') || tb.querySelector('button')
      const r = btn.getBoundingClientRect()
      const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return {
        found: true,
        opacity: getComputedStyle(tb).opacity,
        pointerEvents: getComputedStyle(tb).pointerEvents,
        hitTitle: el ? (el.getAttribute('title') || String(el.className).slice(0, 30)) : null,
      }
    })
    ok(reach.found && reach.opacity === '1' && reach.pointerEvents === 'auto',
      `悬停时工具条显形并恢复吃事件（opacity=${reach.opacity}, pointer-events=${reach.pointerEvents}）`, JSON.stringify(reach))
    ok(/下载图片|复制图片/.test(String(reach.hitTitle)),
      '★ 显形后那个点上命中的是**按钮自己**（鼠标移过去还点得到）', JSON.stringify(reach))

    await p.evaluate(([b, d]) => window.__yqStore.getState().deleteDoc(d), [bookId, tbDoc])
  }

  /*
   * 从**图片**用键盘落到下面那段文字（2026-10-20 用户：「语雀是直接在图片后面编辑的」）
   * ------------------------------------------------------------
   * 修之前实测：点中图片后 `document.activeElement` 是 **BODY** ——
   * 图片块**压根不可聚焦**，于是按 Enter / ↓ **什么都不会发生**，光标也无处可去。
   * 鼠标能过去（点图片下面那片空白），键盘过不去。
   *
   * ⚠️ 判据钉「**光标落在哪个块**」（看块 id）—— 两个都是 p 的块，
   * 光看类型分不出来（这个坑我刚踩过：类型数组 [p,image,p,p] 看不出新块插在哪）。
   */
  console.log('\n== 从图片用键盘落到下面那段文字 ==')
  {
    const WIDE2 = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120">'
      + '<rect width="240" height="120" fill="#20c997"/></svg>')
    const kbDoc = await p.evaluate(([b, src]) => {
      const st = window.__yqStore.getState()
      const doc = st.createDoc(b, null, '图片键盘探针')
      st.setDocBlocks(doc, [
        { id: 'bk_k1', type: 'p', text: '第一段' },
        { id: 'bk_k2', type: 'image', text: '', src },
        { id: 'bk_k3', type: 'p', text: '图片后面那段' },
      ])
      return doc
    }, [bookId, WIDE2])
    await p.goto(`${BASE}/#/book/${bookId}/doc/${kbDoc}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block-image', { timeout: 25000 })
    await p.waitForTimeout(900)

    const caretBlock = () => p.evaluate(() => {
      const el = document.activeElement
      const blk = el && el.closest ? el.closest('[data-block-id]') : null
      return {
        id: blk ? blk.getAttribute('data-block-id') : null,
        editable: !!(el && el.getAttribute && el.getAttribute('contenteditable') === 'true'),
      }
    })

    await p.click('.yq-block-image img')
    await p.waitForTimeout(400)
    const onImg = await caretBlock()
    ok(onImg.id === 'bk_k2',
      '★ 点中图片后焦点落在**图片块**上（不是 BODY —— 之前按什么键都没反应）',
      JSON.stringify(onImg))

    await p.keyboard.press('ArrowDown')
    await p.waitForTimeout(500)
    const afterDown = await caretBlock()
    ok(afterDown.id === 'bk_k3' && afterDown.editable,
      '★ 按 ↓ 光标落到图片**下面**那段文字里（可以马上打字）', JSON.stringify(afterDown))

    await p.keyboard.type('接上的字', { delay: 40 })
    await p.waitForTimeout(900)
    const typed = await p.evaluate((d) => {
      const bs = window.__yqStore.getState().docs[d].blocks
      return bs.map((b) => ({ id: b.id, x: String(b.text || '').slice(0, 16) }))
    }, kbDoc)
    const landed = typed.find((t) => t.id === 'bk_k3')
    ok(!!landed && landed.x.includes('接上的字'),
      '★ 接着打的字落在**图片下面那段**里（不是图片上面，也不是新建块）', JSON.stringify(typed))

    /* 按 Enter：图片下面应当多一个空段落，光标进去 */
    await p.click('.yq-block-image img')
    await p.waitForTimeout(300)
    await p.keyboard.press('Enter')
    await p.waitForTimeout(700)
    const afterEnter = await p.evaluate((d) => {
      const bs = window.__yqStore.getState().docs[d].blocks
      return bs.map((b) => ({ id: b.id, t: b.type, x: String(b.text || '').slice(0, 12) }))
    }, kbDoc)
    const imgIdx = afterEnter.findIndex((b) => b.id === 'bk_k2')
    const nextOne = afterEnter[imgIdx + 1]
    const inNew = await caretBlock()
    ok(!!nextOne && nextOne.t === 'p' && nextOne.id !== 'bk_k3',
      '★ 图片下面新建了一个段落（不是复用原来那段）', JSON.stringify(afterEnter))
    ok(inNew.id === nextOne.id && inNew.editable,
      '★ 光标落进那个新段落（可以马上打字）', JSON.stringify(inNew))

    await p.evaluate(([b, d]) => window.__yqStore.getState().deleteDoc(d), [bookId, kbDoc])
  }

  /*
   * 「在图片后面编辑」的两条**最朴素**的路（2026-10-20 用户实测报「还是有问题」）
   * ------------------------------------------------------------
   * 真实文档里的结构：图片块**下面**那一行是文件名（caption），
   * 它**属于图片块** —— 点那里放不下光标；
   * 而图片后面**已经有**一段时，「末尾继续输入区」又在文档最底下，离图片很远。
   * ⇒ 于是「点图片 → 打字，字出现在图片后面」这条最朴素的期待，
   *   在真实文档里**根本走不通**（之前一个字都进不去，界面零反馈）。
   *
   * 这两条要钉住：
   *   ① 点中图片**直接打字** → 在图片**正下方**建一段，字落进去
   *   ② 点图片**下面那一行**（文件名）→ 光标直接落到下面那段
   */
  console.log('\n== 在图片后面编辑：点图片直接打字 / 点图片下面那一行 ==')
  {
    const WIDE3 = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120">'
      + '<rect width="240" height="120" fill="#d63384"/></svg>')
    const edDoc = await p.evaluate(([b, src]) => {
      const st = window.__yqStore.getState()
      const doc = st.createDoc(b, null, '图片后面编辑探针')
      st.setDocBlocks(doc, [
        { id: 'bk_e1', type: 'p', text: '图片上面这段' },
        { id: 'bk_e2', type: 'image', text: '', src, data: { key: 'k1', name: 'pic.png', dataUrl: src } },
        { id: 'bk_e3', type: 'p', text: '图片下面那段' },
      ])
      return doc
    }, [bookId, WIDE3])
    await p.goto(`${BASE}/#/book/${bookId}/doc/${edDoc}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block-image', { timeout: 25000 })
    await p.waitForTimeout(900)

    /*
     * ①a 图片**后面已经有**一段 → 打出来的字落在**那一段的开头**
     *
     * ⚠️ 必须模拟**中文输入法**的真实路径：
     *   物理键（keydown）→ 组字 → insertText（**最后这一步没有 keydown**）。
     *   实测：直接 `keyboard.type('中文')` 发的全是 insertText，keydown 事件数 = 0 ——
     *   那样测的是「压根没有 keydown 时会怎样」，而真实用户按的**有** keydown。
     *   （物理键本身会留下一个字母，是测试环境没有输入法的产物，断言用 includes。）
     */
    await p.click('.yq-block-image img')
    await p.waitForTimeout(400)
    await p.keyboard.press('z')
    await p.waitForTimeout(500)
    const caretAfterKey = await p.evaluate(() => {
      const el = document.activeElement
      const blk = el && el.closest ? el.closest('[data-block-id]') : null
      return {
        id: blk ? blk.getAttribute('data-block-id') : null,
        editable: !!(el && el.getAttribute && el.getAttribute('contenteditable') === 'true'),
        inImgText: !!(el && el.closest && el.closest('.yq-img-text')),
      }
    })
    await p.keyboard.insertText('直接打的字')
    await p.waitForTimeout(1000)
    const typed = await p.evaluate((d) => {
      const bs = window.__yqStore.getState().docs[d].blocks
      return bs.map((b) => ({ id: b.id, t: b.type, x: String(b.text || '').slice(0, 20) }))
    }, edDoc)
    ok(caretAfterKey.id === 'bk_e2' && caretAfterKey.editable && caretAfterKey.inImgText,
      '★ 点中图片按下第一个键 → 光标进了**图片自己下面那一行**（中文组字才有地方落）', JSON.stringify(caretAfterKey))
    const imgBlk1 = typed.find((b) => b.id === 'bk_e2')
    ok(!!imgBlk1 && imgBlk1.x.includes('直接打的字'),
      '★ 打出来的字落在**图片自己那段**里（图片下面那一行）', JSON.stringify(typed))
    ok(!typed.some((b) => b.id === 'bk_e1' && b.x.includes('直接打的字')),
      '★ 图片上面那段没被塞进这串字', JSON.stringify(typed))

    /* ①b 图片是**最后一个块** → 打字要在图片正下方**新建**一段 */
    await p.evaluate(([d, src]) => {
      window.__yqStore.getState().setDocBlocks(d, [
        { id: 'bk_f1', type: 'p', text: '上面那段' },
        { id: 'bk_f2', type: 'image', text: '', src, data: { key: 'k1', name: 'pic.png', dataUrl: src } },
      ])
    }, [edDoc, WIDE3])
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block-image', { timeout: 25000 })
    await p.waitForTimeout(900)
    await p.click('.yq-block-image img')
    await p.waitForTimeout(400)
    await p.keyboard.press('z')
    await p.waitForTimeout(700)
    await p.keyboard.insertText('图片后面新起的字')
    await p.waitForTimeout(1000)
    const typed2 = await p.evaluate((d) => {
      const bs = window.__yqStore.getState().docs[d].blocks
      return bs.map((b) => ({ id: b.id, t: b.type, x: String(b.text || '').slice(0, 22) }))
    }, edDoc)
    const imgIdx2 = typed2.findIndex((b) => b.id === 'bk_f2')
    const imgBlk2 = typed2[imgIdx2]
    ok(!!imgBlk2 && imgBlk2.x.includes('图片后面新起的字'),
      '★ 图片是最后一个块时，打字落在**图片自己下面那一行**（图片正下方）', JSON.stringify(typed2))

    /* ② 点图片下面那一行（文件名）→ 光标落到下面那段
     * ⚠️ 先把块**复原**成「图片后面有一段」的形状 ——
     *   上一小段 ①b 把它换成了「图片是最后一个块」，那时下面本来就没有段落。 */
    await p.evaluate(([d, src]) => {
      window.__yqStore.getState().setDocBlocks(d, [
        { id: 'bk_e1', type: 'p', text: '图片上面这段' },
        { id: 'bk_e2', type: 'image', text: '', src, data: { key: 'k1', name: 'pic.png', dataUrl: src } },
        { id: 'bk_e3', type: 'p', text: '图片下面那段' },
      ])
    }, [edDoc, WIDE3])
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block-image', { timeout: 25000 })
    await p.waitForTimeout(900)
    const capBox = await p.locator('.yq-img-block-caption').first().boundingBox()
    ok(!!capBox, '图片下面有那一行文件名（就是点它放不下光标的地方）', JSON.stringify(capBox))
    if (capBox) {
      await p.mouse.click(capBox.x + capBox.width / 2, capBox.y + capBox.height / 2)
      await p.waitForTimeout(600)
      const caret = await p.evaluate(() => {
        const el = document.activeElement
        const blk = el?.closest?.('[data-block-id]')
        return {
          id: blk ? blk.getAttribute('data-block-id') : null,
          editable: el?.getAttribute?.('contenteditable') === 'true',
        }
      })
      ok(caret.id === 'bk_e3' && caret.editable,
        '★ 点图片下面那一行 → 光标直接落到图片**下面那段**（能马上打字）', JSON.stringify(caret))
    }

    await p.evaluate(([b, d]) => window.__yqStore.getState().deleteDoc(d), [bookId, edDoc])
  }

  /*
   * 「在图片后面编辑」的**最终形态**：图片**右边**紧跟文字，**同一行**。
   * ------------------------------------------------------------
   * 语雀的形态（用户 2026-10-20 给的截图）：图片右边就是那段话。
   * ⇒ 图片块的 `text` 装「图片后面那段话」，渲染在图片**右边**。
   *
   * 判据钉两件事：
   *   ① **字落在图片块自己的 text 里**（不是落到别的块）；
   *   ② **几何上同一行**（文字的矩形与图片的矩形在竖直方向重叠）——
   *      只看「文字存在」的话，把字放到**下一行**也满足，那不是语雀的形态。
   */
  console.log('\n== 图片 + 下面那一行的文字 ==')
  {
    const WIDE4 = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">'
      + '<rect width="200" height="100" fill="#1f6feb"/></svg>')
    const ilDoc = await p.evaluate(([b, src]) => {
      const st = window.__yqStore.getState()
      const doc = st.createDoc(b, null, '同行尾巴探针')
      st.setDocBlocks(doc, [
        { id: 'bk_i1', type: 'p', text: '上面这一段' },
        { id: 'bk_i2', type: 'image', text: '', src, data: { key: 'k1', name: 'pic.png', dataUrl: src } },
      ])
      return doc
    }, [bookId, WIDE4])
    await p.goto(`${BASE}/#/book/${bookId}/doc/${ilDoc}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block-image', { timeout: 25000 })
    await p.waitForTimeout(900)

    await p.click('.yq-block-image img')
    await p.waitForTimeout(500)
    const inTail = await p.evaluate(() => {
      const el = document.activeElement
      return {
        inImgText: !!(el && el.closest && el.closest('.yq-img-text')),
        editable: !!(el && el.getAttribute && el.getAttribute('contenteditable') === 'true'),
      }
    })
    ok(inTail.inImgText && inTail.editable,
      '★ 点图片 → 光标进**图片下面那一行**（不是落到别的块，也不是进不去）', JSON.stringify(inTail))

    await p.keyboard.press('z')
    await p.waitForTimeout(300)
    await p.keyboard.press('Backspace')
    await p.keyboard.insertText('紧跟在图片右边的话')
    await p.waitForTimeout(1000)
    const st2 = await p.evaluate((d) => {
      const bs = window.__yqStore.getState().docs[d].blocks
      return bs.map((b) => ({ id: b.id, t: b.type, x: String(b.text || '').slice(0, 22) }))
    }, ilDoc)
    const imgBlk = st2.find((b) => b.id === 'bk_i2')
    const upBlk = st2.find((b) => b.id === 'bk_i1')
    ok(!!imgBlk && imgBlk.x.includes('紧跟在图片右边的话'),
      '★ 那串字落在**图片块自己**的 text 里（图片的 `text` 就是「图片后面那段话」）', JSON.stringify(st2))
    ok(!!upBlk && !upBlk.x.includes('紧跟在图片右边的话'),
      '★ 图片**上面**那段没被塞进这串字', JSON.stringify(st2))

    const geo = await p.evaluate(() => {
      const img = document.querySelector('.yq-block-image img')
      const tail = document.querySelector('.yq-img-text')
      if (!img || !tail) return { found: false }
      const a = img.getBoundingClientRect()
      const b = tail.getBoundingClientRect()
      return {
        found: true,
        below: b.top >= a.bottom - 2,
        overlapping: b.top < a.bottom && b.bottom > a.top,
        alignedLeft: Math.abs(b.left - a.left) <= 2,
        tailW: Math.round(b.width),
      }
    })
    ok(geo.found && geo.below && !geo.overlapping,
      '★ 几何上文字在图片**下面**一行（用户 2026-10-20：「文字在中间，而不是下面」）',
      JSON.stringify(geo))
    ok(geo.found && geo.alignedLeft,
      '★ 文字与图片**左对齐**（不是飘到右边去）', JSON.stringify(geo))
    ok(geo.found && geo.tailW > 0,
      '★ 文字区有**实际宽度**（宽度 0 → 占位竖排 + 光标画不出来）', JSON.stringify(geo))

    /* 占位提示**整个不要**（用户 2026-10-20：悬停就冒出「在图片后面写点文字」） */
    await p.locator('.yq-block-image img').first().hover()
    await p.waitForTimeout(400)
    const phHover = await p.evaluate(() => {
      const tail = document.querySelector('.yq-img-text')
      return tail ? getComputedStyle(tail, '::before').content : null
    })
    await p.locator('.yq-block-image img').first().click()
    await p.waitForTimeout(400)
    const phFocus = await p.evaluate(() => {
      const tail = document.querySelector('.yq-img-text')
      return tail ? getComputedStyle(tail, '::before').content : null
    })
    ok(phHover === 'none' && phFocus === 'none',
      '★ 图片下面那行**不冒占位提示**（悬停/聚焦都不冒）',
      `悬停=${phHover} 聚焦=${phFocus}`)

    await p.evaluate(([b, d]) => window.__yqStore.getState().deleteDoc(d), [bookId, ilDoc])
  }

  /*
   * 回归守卫（2026-10-20 真踩到）：在**文字块**里按可打印字符时，
   * 文档级的 ↑↓ 处理**不许**把光标带走、也不许吃掉字符。
   *
   * 原来的代码只挡了 Enter，**可打印字符 fall through** 到「跳到相邻块」——
   * 于是**打英文时光标跳到上一个块、字符被吃掉**；
   * 而中文走 IME（**没有 keydown**）所以一直没暴露，测试全绿。
   * ⚠️ 这条**必须用英文**测（英文才有 keydown）—— 用中文测等于没测。
   */
  console.log('\n== 文字块里打英文：光标不许被抢、字符不许被吃掉 ==')
  {
    const enDoc = await p.evaluate((b) => {
      const st = window.__yqStore.getState()
      const doc = st.createDoc(b, null, '英文打字探针')
      st.setDocBlocks(doc, [
        { id: 'bk_e10', type: 'p', text: '第一段' },
        { id: 'bk_e11', type: 'p', text: '第二段' },
      ])
      return doc
    }, bookId)
    await p.goto(`${BASE}/#/book/${bookId}/doc/${enDoc}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block-text', { timeout: 25000 })
    await p.waitForTimeout(900)

    await p.locator('.yq-block[data-block-id="bk_e10"] .yq-block-text').click()
    await p.waitForTimeout(300)
    await p.keyboard.press('End')
    await p.keyboard.type('XYZ', { delay: 60 })
    await p.waitForTimeout(1000)
    const en = await p.evaluate((d) => {
      const bs = window.__yqStore.getState().docs[d].blocks
      const el = document.activeElement
      const blk = el && el.closest ? el.closest('[data-block-id]') : null
      return {
        texts: bs.map((b) => String(b.text || '')),
        focusId: blk ? blk.getAttribute('data-block-id') : null,
      }
    }, enDoc)
    ok(en.texts[0].includes('XYZ'),
      '★ 英文键真的进了当前块（没被文档级处理器吃掉）', JSON.stringify(en.texts))
    ok(en.texts[1] === '第二段' && en.focusId === 'bk_e10',
      '★ 光标**没有被跳到别的块**（原来会 fall through 到「跳到上一个块」）', JSON.stringify(en))

    await p.evaluate(([b, d]) => window.__yqStore.getState().deleteDoc(d), [bookId, enDoc])
  }

  await ctx.close()
} catch (e) {
  fail++
  console.log(`  FAIL  套件异常：${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`)
} finally {
  await browser.close()
}

/* 汇总行必须逐字用约定的「结果：N 通过 / M 失败」——
   run-all-tests.mjs:401 就是按这个正则计数的。写成别的语序，
   runner 会判成「套件本身异常」，这一套的 38 项**一项都不计进总数**，
   而且报的还是 FAIL。（第一版就栽在这儿。） */
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1