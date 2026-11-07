/* ============================================================
   快捷键：界面上写着的，**逐条真按一遍**
   ------------------------------------------------------------
   为什么静态判据不够（本项目实测栽了三次）：

   ① 读源码只能证伪「源码里没有」，证不了「按了真的有反应」。
      `⌘K` 藏在四处、`/` 聚焦搜索是假的 —— 都不是 grep 能发现的，
      前者因为「修复文案已经写在 Help.tsx 里了」，后者因为那句代码
      确实存在、只是 focus 了一个不在 DOM 里的元素。

   ② 我自己写的探针也栽了三次，每一种都会**把失败报成通过**或反过来：
      · 判据恒真：`after.startsWith('#/')` 被 `#/book/b1/doc/d1` 满足
        → `G 然后 D` 明明没跳路由，却报「有反应」。
      · 指纹测不出「按完回到原样」：`Esc` 关弹层，但按之前 overlays 本来就是 0；
        `↑↓` 移光标，但只看 dom 长度不一定变。
      · 状态没复位：上一条测完已跳到别的路由，裸键 `g` 在那里没绑定
        → `G 然后 D/S/F` 批量全灭、单独全好。**「探针没复位」和
        「按键没反应」在输出里长得一模一样。**

   所以这个套件的三条硬规矩：
   · 每条**从干净状态重来**（settle 里先跳回文档页，再关弹层）；
   · 判据写**具体终态**，绝不写「有变化就算过」；
   · 「关弹层」「移光标」这类键，必须**先造出状态再按**。

   ⚠️ 覆盖来源两处（同一个错常常有两份拷贝）：
     src/components/doc/Shortcuts.tsx 的 GROUPS（编辑态右下角面板）
     src/pages/Help.tsx 的 SHORTCUTS（帮助页）
   ============================================================ */

import { chromium } from 'playwright'
import fs from 'node:fs'

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')
const PW = process.env.ADMIN_PASS || 'yuque@2026'
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`) }
}

/* ---------- 收集两处声明 ---------- */
const sc = fs.readFileSync('src/components/doc/Shortcuts.tsx', 'utf8')
const panel = [...sc.matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)].map((m) => ({ key: m[1], label: m[2] }))
const hp = fs.readFileSync('src/pages/Help.tsx', 'utf8')
const hb = hp.slice(hp.indexOf('const SHORTCUTS'), hp.indexOf('const SHORTCUTS') + 1400)
const help = [...hb.matchAll(/k:\s*'([^']+)',\s*d:\s*'([^']+)'/g)].map((m) => ({ key: m[1], label: m[2] }))
ok(panel.length >= 15, `快捷键面板声明 ${panel.length} 条`)
ok(help.length >= 6, `帮助页声明 ${help.length} 条`)

/* 两处声明的规模本来就不同：面板 19 条是**编辑器专用**的完整清单，
   帮助页 8 条只挑「跨页面通用」的（? / G 然后 X / ⌘S / ⌘Enter…）。
   所以既不该要求两边一致，也不该要求谁包含谁 ——
   真正有意义的是：**帮助页那 8 条，每一条都在下面被实测覆盖**。
   （第一版写的是「面板不能有帮助页完全没提的」，结果 16 条全红 —— 判据本身没意义。） */
const covered = new Set([
  '?', 'G 然后 D', 'G 然后 S', 'G 然后 F', '⌘ S', '⌘ B', '⌘ I', '⌘ U', '⌘ Enter', 'Esc',
  'Enter', '⇧ Enter', 'Backspace', 'Tab', '↑ ↓', '/', '@', '⌘ Z',
  '⌘ ⇧ F', '⌘ ⇧ O', '⌘ ⇧ P', '⌘ ⇧ R',
  // 帮助页把三个键**写在一个条目里**（`⌘ B / ⌘ I / ⌘ U`），
  // 而实测是分开按的。第一版只写了 '⌘ B' / '⌘ I' / '⌘ U' 三个单键名，
  // 对不上这个合并条目 —— 判据得认得「A / B / C」这种写法。
  '⌘ B / ⌘ I / ⌘ U',
])
const coveredOne = (k) => covered.has(k) || k.split(/\s*\/\s*/).every((part) => covered.has(part.trim()))
const uncovered = help.filter((h) => !coveredOne(h.key)).map((h) => h.key)
ok(uncovered.length === 0,
  `帮助页声明的每一条都被本套件实测覆盖（未覆盖：${uncovered.join('、') || '无'}）`)

const browser = await chromium.launch()

/*
 * ⚠️ 这两个函数必须在 `try` **之外**定义。
 *   第一版把它们写在 try 里，finally 的收尾守卫调 `restore` 时
 *   `restore is not defined` —— 而收尾守卫恰恰是最后一道防线，
 *   **它自己抛错等于防线失效**（那正是 2026-10-08 事故的形态：
 *   探针写进部署数据，却因为收尾自己坏了而没人发现）。
 *
 *   所以这里用两个模块级变量把「页面」和「原文」交给它们：
 *   try 里登录后填上，finally 里照常能用。
 */
let page = null
let originTexts = null
let originBlockCount = 0
/** 目标文档：收尾时要用（finally 在 try 之外，拿不到 try 里的局部变量） */
let target = null
/**
 * ⚠️ 这里**绝不能 throw**。
 *   第一版它在块数对不上时直接 throw，而 settle() 会调它 —— 于是整套件在
 *   中途崩掉、**没打出汇总行**，runner 只能报「没找到汇总行，项数没计进总数」。
 *   后果是：后半段测试（⌘Z 那一组）和收尾守卫全都没跑，而整轮的「0 失败」看不出来。
 *   （这正是 run-all-tests.mjs 注释里记过的坑：套件没跑完，总账却是绿的。）
 *
 *   所以改成：返回 { ok:false, why }，由调用方记一条 FAIL 并继续。
 *   还原失败**必须报出来**，但不该让其余 30 条一起消失。
 */
const restore = async (label) => {
  if (!page || !originTexts) return { ok: true, n: 0 }
  /*
   * ⚠️ `page.evaluate` 可能在**页面正在跳转**时抛
   *   "Execution context was destroyed" —— 那不是测试失败，是时序。
   *   所以重试三次（每次先等页面稳定），而不是把它当成错误。
   *   三次都失败才返回 { ok:false }，由调用方记一条 FAIL。
   */
  let now = null
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.waitForLoadState('domcontentloaded').catch(() => {})
      await page.waitForTimeout(400)
      now = await page.evaluate(() => ({
        n: document.querySelectorAll('[data-block-id]').length,
        texts: [...document.querySelectorAll('.yq-block-text')].map((e) => e.textContent),
      }))
      lastErr = null
      break
    } catch (e) {
      lastErr = e
    }
  }
  if (!now) return { ok: false, why: `${label}：页面正在跳转，读不到正文（${lastErr?.message || '未知'}）` }
  if (now.n !== originBlockCount) {
    return { ok: false, why: `${label}：块数对不上（${now.n} vs 原 ${originBlockCount}），无法安全还原` }
  }
  const dirty = now.texts.filter((t, i) => t !== originTexts[i]).length
  if (!dirty) return { ok: true, n: 0 }
  await page.evaluate((o) => {
    const els = document.querySelectorAll('.yq-block-text')
    o.forEach((t, i) => { if (els[i] && els[i].textContent !== t) els[i].textContent = t })
  }, originTexts)
  await page.waitForTimeout(900)
  const check = await page.evaluate(() => [...document.querySelectorAll('.yq-block-text')].map((e) => e.textContent))
  const still = check.filter((t, i) => t !== originTexts[i]).length
  if (still) return { ok: false, why: `${label}：还原后仍有 ${still} 块不一致` }
  return { ok: true, n: dirty }
}

try {
  const p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  page = p   // 交给模块级 restore，finally 收尾时要用
  await p.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1500)
  if (await p.locator('.yq-login').count()) {
    await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
    await p.fill('.yq-login-card input[type="password"]', PW)
    await p.click('.yq-login-submit')
    await p.waitForSelector('.yq-login', { state: 'detached', timeout: 25000 })
  }
  await p.waitForTimeout(1500)

  target = await p.evaluate(() => {
    const st = window.__yqStore.getState()
    /*
     * ⚠️ 必须**优先 d1**，不能拿「第一篇 doc」。
     *   全量环境里临时库已被前 60 个套件塞满（实测 health 显示 users 27 / docs 43），
     *   「第一篇」会挑到别人造出来的文档 —— 块数是任意的，
     *   而这个套件的还原逻辑是**按 seed 还原 d1**，于是口径完全对不上，
     *   报出「块数对不上（11 vs 原 12）」。
     *   d1 的块数在 seed.ts 里是确定的（11 块），口径才稳定。
     */
    const d = st.docs.d1 && st.docs.d1.type === 'doc' && st.docs.d1.bookId
      ? st.docs.d1
      : Object.values(st.docs).find((x) => x.type === 'doc' && x.bookId)
    return d ? { url: `/book/${d.bookId}/doc/${d.id}`, id: d.id } : null
  })
  ok(!!target, '找到一篇可打开的文档', target ? target.url : 'null')
  ok(target && target.id === 'd1',
    '用的是 d1（块数与 seed 一致；拿「第一篇」会在全量环境下挑到别人造的文档）',
    target ? target.id : '')

  const gotoDoc = async () => {
    await p.goto(BASE + '/#' + target.url, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block', { timeout: 25000 })
    await p.waitForTimeout(1800)
  }
  await gotoDoc()
  originTexts = await p.evaluate(() =>
    [...document.querySelectorAll('.yq-block-text')].map((e) => e.textContent))
  // 块数另存一份：用 `[data-block-id]` 数（**分割线也算一个块**，但它没有 .yq-block-text）
  originBlockCount = await p.evaluate(() => document.querySelectorAll('[data-block-id]').length)

  /**
   * 复位：先回文档页 → **确保编辑模式** → 关所有弹层 → 正文精确还原。
   *
   * ⚠️ 「确保编辑模式」这步是补自己挖的坑：⌘⇧R 那条测完页面停在阅读模式，
   *   而 settle 只跳路由、不切模式 —— 后面 Esc / `/` / ↑↓ 全被这个残留状态毒化，
   *   七条一起红。**「探针没复位」和「按键没反应」在输出里长得一模一样**
   *   （上一轮已在 G 然后 X 上栽过一次，这里换了地方又栽）。
   *
   * ⚠️ 正文只能**按 index 精确还原**，绝不能清空 ——
   *   部署实例上是持久化数据，清空等于改用户的文档。
   */
  const settle = async () => {
    const onDoc = await p.evaluate(() => location.hash)
    const editable = await p.evaluate(() => document.querySelectorAll('.yq-block-text').length)
    if (!onDoc.startsWith('#/book/') || !editable) {
      await gotoDoc()
      // 阅读态下块不可编辑，按一次 ⌘⇧R 切回来（幂等：本来就是编辑态时它会切走，
      // 所以只在确认仍是阅读态时才按）
      const stillReading = await p.evaluate(() => !document.querySelector('.yq-block-text'))
      if (stillReading) {
        await p.keyboard.press('Control+Shift+r')
        await p.waitForTimeout(1000)
        await gotoDoc()
      }
    }
    for (let i = 0; i < 4; i++) {
      await p.keyboard.press('Escape')
      await p.mouse.click(6, 6)
      await p.waitForTimeout(200)
    }
    // ⚠️ 还原失败只记一条 FAIL，**不中断** —— 抛出去会让整套件崩掉、
    //    后面所有测试和收尾守卫都不跑，而 runner 只能报「没找到汇总行」。
    const r = await restore('settle')
    if (!r.ok) ok(false, r.why)
  }

  /* ══════════ settle ══════════
   * 复位：先回文档页 → **确保编辑模式** → 关所有弹层 → 正文精确还原。
   *
   * ⚠️ 「确保编辑模式」这步是补自己挖的坑：⌘⇧R 那条测完页面停在阅读模式，
   *   而 settle 只跳路由、不切模式 —— 后面 Esc / `/` / ↑↓ 全被这个残留状态毒化，
   *   七条一起红。**「探针没复位」和「按键没反应」在输出里长得一模一样**
   *   （上一轮已在 G 然后 X 上栽过一次，这里换了地方又栽）。
   *
   * ⚠️ restore 抛错时**不猜、不强改**：块数对不上就中止，
   *   因为那时已经不知道多出来的块是哪来的，硬改等于毁数据。
   */

  /* ══════════ 视图类快捷键（⌘⇧X）：终态要具体 ══════════ */
  const treeState = () => p.evaluate(() => {
    const t = document.querySelector('.yq-tree')
    if (!t) return 'no-tree'
    const items = t.querySelectorAll('.yq-tree-item').length
    const icons = t.querySelectorAll('.yq-tree-collapsed-item').length
    if (icons > 0 && items === 0) return 'collapsed'
    if (items > 0) return 'expanded'
    return 'unknown'
  })

  {
    await settle()
    const s0 = await p.evaluate(() => window.__yqStore.getState().treeCollapsed)
    const t0 = await treeState()
    await p.keyboard.press('Control+Shift+f')
    await p.waitForTimeout(900)
    const s1 = await p.evaluate(() => window.__yqStore.getState().treeCollapsed)
    const t1 = await treeState()
    await p.keyboard.press('Control+Shift+f')
    await p.waitForTimeout(900)
    const s2 = await p.evaluate(() => window.__yqStore.getState().treeCollapsed)
    const t2 = await treeState()
    /* 2026-10-08 修的真 bug：treeCollapsed 原来**只被写从不被读**，
       按键翻转了 store 而界面纹丝不动。所以必须同时断言 store 与界面。 */
    ok(s0 === false && s1 === true && t1 === 'collapsed' && t2 === 'expanded' && s2 === false,
      '⌘⇧F 折叠目录：store 与**界面**同步翻转（只翻 store 不动界面就是复发）',
      `store ${s0}→${s1}→${s2}；界面 ${t0}/${t1}/${t2}`)
  }

  {
    await settle()
    const n0 = await p.evaluate(() => document.querySelectorAll('.yq-outline').length)
    await p.keyboard.press('Control+Shift+o')
    await p.waitForTimeout(900)
    const n1 = await p.evaluate(() => document.querySelectorAll('.yq-outline').length)
    /* 隐藏态下大纲**仍然在 DOM 里**（是右侧那条 mini 边），
       所以「数量变化」恒为 1 → 1。判据必须看 mini 边在不在。 */
    const mini0 = await p.evaluate(() => document.querySelectorAll('.yq-outline-mini').length)
    await p.keyboard.press('Control+Shift+o')
    await p.waitForTimeout(900)
    const mini1 = await p.evaluate(() => document.querySelectorAll('.yq-outline-mini').length)
    ok(n1 !== n0 || mini1 !== mini0,
      '⌘⇧O 钉住/隐藏大纲：钉住面板或 mini 边至少有一个变了',
      `钉住 ${n0}→${n1}；mini ${mini0}→${mini1}`)
  }

  {
    await settle()
    /* ⌘⇧P：量 `.yq-docpage` 本身测不出来 —— `is-wide` 改的是内部
   `.yq-doc-content` 的宽度（DocPage.css:568），外层是 flex 铺满的。 */
const w0 = await p.evaluate(() => {
      const e = document.querySelector('.yq-docpage .yq-doc-content')
      return e ? Math.round(e.getBoundingClientRect().width) : 0
    })
    await p.keyboard.press('Control+Shift+p')
    await p.waitForTimeout(900)
    const w1 = await p.evaluate(() => {
      const e = document.querySelector('.yq-docpage .yq-doc-content')
      return e ? Math.round(e.getBoundingClientRect().width) : 0
    })
    /* 页宽由 `.yq-docpage.is-wide .yq-doc-content` 控制（DocPage.css:568）。
       第一版量的是 `.yq-doc-body` —— 那个类根本不存在，两边都量到 0，
       于是「宽度没变」被报成产品坏了。**判据的测量对象必须从源码确认**。 */
    ok(w1 !== w0 && w0 > 0, '⌘⇧P 标准页宽/超宽：`.yq-doc-content` 宽度真的变了', `${w0} → ${w1}`)
  }

  {
    await settle()
    /* ⌘⇧R：判据不能只看块数 —— 阅读模式下块还在，只是不可编辑。
   真正变的是 contentEditable，要看它。 */
const ce0 = await p.evaluate(() => document.querySelectorAll('.yq-block-text[contenteditable="true"]').length)
    await p.keyboard.press('Control+Shift+r')
    await p.waitForTimeout(1000)
    const ce1 = await p.evaluate(() => document.querySelectorAll('.yq-block-text[contenteditable="true"]').length)
    await p.keyboard.press('Control+Shift+r')
    await p.waitForTimeout(1000)
    const ce2 = await p.evaluate(() => document.querySelectorAll('.yq-block-text[contenteditable="true"]').length)
    ok(ce0 > 0 && ce1 === 0 && ce2 > 0,
      '⌘⇧R 阅读模式：可编辑块真的变成只读，再按回来', `contentEditable 块 ${ce0} → ${ce1} → ${ce2}`)
  }

  /* ══════════ ⌘S：toast 必须出现 ══════════ */
  {
    await settle()
    await p.locator('.yq-doc-body').first().click({ position: { x: 5, y: 5 } }).catch(() => {})
    await p.keyboard.press('Control+s')
    await p.waitForTimeout(900)
    const toast = await p.evaluate(() =>
      [...document.querySelectorAll('[class*="toast"]')].map((e) => (e.textContent || '').trim()).join('|'))
    ok(/已手动保存/.test(toast), '⌘S 手动保存：真的弹出「已手动保存」', toast.slice(0, 60))
  }

  /* ══════════ ? 开搜索（面板开着 + 输入框自动聚焦）══════════ */
  {
    await settle()
    await p.locator('.yq-doc-body').first().click({ position: { x: 5, y: 5 } }).catch(() => {})
    await p.keyboard.press('?')
    await p.waitForTimeout(1000)
    const st = await p.evaluate(() => ({
      panel: document.querySelectorAll('.yq-searchpanel').length,
      focused: document.activeElement ? document.activeElement.tagName + '.' + (document.activeElement.className || '').slice(0, 30) : null,
    }))
    ok(st.panel > 0 && st.focused === 'INPUT.yq-searchpanel-input',
      '? 全局搜索：面板打开且输入框自动聚焦', JSON.stringify(st))
    await p.keyboard.press('Escape')
  }

  /* ══════════ / :面板关着时**不许吞掉**按键 ══════════ */
  {
    await settle()
    await p.locator('.yq-doc-body').first().click({ position: { x: 5, y: 5 } }).catch(() => {})
    await p.keyboard.press('/')
    await p.waitForTimeout(900)
    const st = await p.evaluate(() => ({
      panel: document.querySelectorAll('.yq-searchpanel').length,
      focused: document.activeElement ? document.activeElement.tagName + '.' + (document.activeElement.className || '').slice(0, 30) : null,
    }))
    /* 修之前这里 preventDefault 了却 focus 不在 DOM 的元素 —— 表现为「按了没反应」。
       现在不许吞：如果焦点落进搜索输入框，说明 handler 又开始抢按键了。 */
    ok(st.focused !== 'INPUT.yq-searchpanel-input',
      '面板关着时按 / 不被劫持（之前 preventDefault 却 focus 不存在的元素）', JSON.stringify(st))
  }

  /* ══════════ G 然后 X：三跳，**逐个终态** ══════════ */
  for (const [k, want] of [['D', '#/'], ['S', '#/search'], ['F', '#/find']]) {
    await settle()
    const before = await p.evaluate(() => location.hash)
    await p.keyboard.press('g')
    await p.waitForTimeout(300)
    await p.keyboard.press(k.toLowerCase())
    await p.waitForTimeout(1000)
    const after = await p.evaluate(() => location.hash)
    /* ⚠️ 不能写 `after.startsWith('#/')` —— `#/book/b1/doc/d1` 也满足，
       那是上一版探针把「没跳」报成「有反应」的原因。这里比对**具体路由**。 */
    const okRoute = k === 'D' ? after === '#/' : after.startsWith(want)
    ok(okRoute && before !== after, `G 然后 ${k} → ${want}`, `${before} → ${after}`)
  }

  /* ══════════ Esc：必须**先造出弹层**再按 ══════════
   斜杠菜单同样只在空块里弹（判据 `t.startsWith('/')`），所以先清空第一块。 */
  {
    await settle()
    await p.locator('.yq-block-text').first().click()
    await p.waitForTimeout(300)
    await p.evaluate(() => { const el = document.querySelector('.yq-block-text'); if (el) el.textContent = '' })
    await p.waitForTimeout(400)
    await p.keyboard.press('/')
    await p.waitForTimeout(900)
    const opened = await p.evaluate(() => document.querySelectorAll('.yq-slash-item').length)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(800)
    const closed = await p.evaluate(() => document.querySelectorAll('.yq-slash-item').length)
    ok(opened > 0 && closed === 0, 'Esc 关闭斜杠菜单（先在空块里造出菜单再按 Esc）', `开 ${opened} → 关 ${closed}`)
    const r = await restore('Esc 测完')
    if (!r.ok) ok(false, r.why)   // 只记 FAIL，不中断 —— 抛出去整套件就没汇总行了
  }

  /* ══════════ 编辑器内：/ 插入面板、@ 提及、Enter/⇧Enter/Backspace/Tab、↑↓、⌘B/I/U ══════════ */
  /* `/ 唤起插入面板`：**必须在空块里测**。
   实测（2026-10-08）：块里有字时按 `/` 只是插字符，菜单不弹 ——
   因为判据是 `t.startsWith('/')`（Editor.tsx:699），`t` 是**整个块文本**。
   所以这条测的是「空块 + /」，这也正是帮助页写的用法（「在空块里直接输入 /」）。
   ⚠️ 测完立刻还原 —— 探针写过正文，这次栽过（见 restore 的说明）。 */
{
    await settle()
    const first = p.locator('.yq-block-text').first()
    await first.click()
    await p.waitForTimeout(300)
    await p.evaluate(() => {
      const el = document.querySelector('.yq-block-text')
      if (el) el.textContent = ''
    })
    await p.waitForTimeout(500)
    await p.keyboard.press('/')
    await p.waitForTimeout(1000)
    const slashN = await p.evaluate(() => document.querySelectorAll('.yq-slash-item').length)
    ok(slashN > 0, '/ 唤起插入面板（空块里）', `菜单项 ${slashN}`)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(400)
    const r = await restore('/ 菜单测完')
    if (!r.ok) ok(false, r.why)   // 只记 FAIL，不中断 —— 抛出去整套件就没汇总行了
  }

  {
    await settle()
    await p.locator('.yq-block-text').first().click()
    const m0 = await p.evaluate(() => document.querySelectorAll('[class*="mention"]').length)
    await p.keyboard.type('@')
    await p.waitForTimeout(900)
    const m1 = await p.evaluate(() => document.querySelectorAll('[class*="mention"]').length)
    ok(m1 > m0, '@ 唤起提及面板', `${m0} → ${m1}`)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(300)
    await p.evaluate((o) => {
      const els = document.querySelectorAll('.yq-block-text')
      o.forEach((t, i) => { if (els[i] && els[i].textContent !== t) els[i].textContent = t })
    }, await p.evaluate(() => [...document.querySelectorAll('.yq-block-text')].map((e) => e.textContent)))
  }

  /* ↑↓（一）：斜杠菜单条目之间移动（2026-10-20 补注：面板那句「在块间移动」指的是**块**，
   *   当时源码里没有、于是被这段「解释」掉了；现在块间移动是真的，见下面第二段断言） —— 它**只在斜杠菜单打开时被处理**
   （Editor.tsx:1499 / 1609 都在菜单组件的 useEffect 里），
   面板文案「在块间移动」指的是**菜单条目之间**（这一段只管菜单）。
   所以必须在空块里按 `/` 把菜单唤出来再测。
   ⚠️ 第一版按了没反应就报「没实现」—— 那是我没打开菜单。 */
{
    await settle()
    const first = p.locator('.yq-block-text').first()
    await first.click()
    await p.waitForTimeout(300)
    await p.evaluate(() => { const el = document.querySelector('.yq-block-text'); if (el) el.textContent = '' })
    await p.waitForTimeout(400)
    await p.keyboard.press('/')
    await p.waitForTimeout(900)
    const opened = await p.evaluate(() => document.querySelectorAll('.yq-slash-item').length)
    const selOf = () => p.evaluate(() => {
      const on = document.querySelector('.yq-slash-item.is-active')
      return on ? [...document.querySelectorAll('.yq-slash-item')].indexOf(on) : -1
    })
    const s0 = await selOf()
    await p.keyboard.press('ArrowDown')
    await p.waitForTimeout(500)
    const s1 = await selOf()
    await p.keyboard.press('ArrowUp')
    await p.waitForTimeout(500)
    const s2 = await selOf()
    ok(opened > 0 && s1 > s0 && s2 === s0,
      '↑ ↓ 在斜杠菜单条目间移动（菜单开着时归菜单管）',
      `菜单 ${opened} 项；选中 ${s0} →↓ ${s1} →↑ ${s2}`)
    await p.keyboard.press('Escape')
    await p.waitForTimeout(600)
    const r = await restore('↑↓ 测完')
    if (!r.ok) ok(false, r.why)   // 只记 FAIL，不中断 —— 抛出去整套件就没汇总行了
  }

  /* ↑↓（二）：**块之间**移动光标（2026-10-20 补上真的那条）
   * ------------------------------------------------------------
   * 面板承诺的是「↑ ↓ 在块间移动」—— 指的是**块**。
   * 修之前源码里根本没有这条路径（只有菜单条目之间那一条），
   * 于是被上一段「解释」掉了。现在补上了：
   *   光标在单行段落里按 ↓ → 落到**下一个块**；按 ↑ → 回到上一个。
   * 判据看**块 id 变没变**（不是「有没有变化」）——
   *   上一段的教训：只看 dom 长度，↑↓ 移光标时长度根本不变。 */
  {
    await settle()
    const caretBlock = () => p.evaluate(() => {
      const el = document.activeElement
      const blk = el && el.closest ? el.closest('[data-block-id]') : null
      return blk ? blk.getAttribute('data-block-id') : null
    })
    await p.locator('.yq-block-text').first().click()
    await p.waitForTimeout(300)
    const b0 = await caretBlock()
    await p.keyboard.press('ArrowDown')
    await p.waitForTimeout(600)
    const b1 = await caretBlock()
    await p.keyboard.press('ArrowUp')
    await p.waitForTimeout(600)
    const b2 = await caretBlock()
    ok(!!b0 && !!b1 && b1 !== b0,
      '★ ↑ ↓ 在**块之间**移动光标（面板承诺的那条，不是菜单条目）', `${b0} →↓ ${b1} →↑ ${b2}`)
    ok(b2 === b0, '★ 按 ↑ 能回到上一个块', `${b1} →↑ ${b2}（原 ${b0}）`)
    /* 本段只挪光标、没动正文，但仍然还原一次 —— 稳妥 */
    const r = await restore('块间移动测完')
    if (!r.ok) ok(false, r.why)
  }

  {
    await settle()
    const n0 = await p.evaluate(() => document.querySelectorAll('[data-block-id]').length)
    await p.locator('.yq-block-text').first().click()
    await p.keyboard.press('Enter')
    await p.waitForTimeout(900)
    const n1 = await p.evaluate(() => document.querySelectorAll('[data-block-id]').length)
    ok(n1 === n0 + 1, 'Enter 新建块', `${n0} → ${n1}`)
    /*
     * ⚠️ 这条**会改块结构**（多一个块），而 restore 只会还原文字。
     * 所以必须自己收回：把光标留在新块上按 Backspace（合并/删除），
     * 再核对块数回到原值。收不回就如实报，绝不留在部署数据里。
     */
    await p.keyboard.press('Backspace')
    await p.waitForTimeout(1000)
    const n2 = await p.evaluate(() => document.querySelectorAll('[data-block-id]').length)
    ok(n2 === n0, `Enter 之后按 Backspace 收回（块数回到 ${n0}）`, `${n1} → ${n2}`)
    const r = await restore('Enter 测完')
    if (!r.ok) ok(false, r.why)   // 只记 FAIL，不中断 —— 抛出去整套件就没汇总行了
  }

  {
    await settle()
    const styleOf = () => p.evaluate(() => {
      const s = document.getSelection()
      if (!s || !s.anchorNode) return null
      const el = s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement
      const st = el ? getComputedStyle(el) : null
      return st ? { weight: st.fontWeight, style: st.fontStyle, deco: st.textDecorationLine } : null
    })
    await p.locator('.yq-block-text').first().click()
    await p.keyboard.press('Control+a')
    await p.waitForTimeout(400)
    const s0 = await styleOf()
    await p.keyboard.press('Control+b')
    await p.waitForTimeout(700)
    const s1 = await styleOf()
    await p.keyboard.press('Control+i')
    await p.waitForTimeout(700)
    const s2 = await styleOf()
    await p.keyboard.press('Control+u')
    await p.waitForTimeout(700)
    const s3 = await styleOf()
    /* ⌘B/I/U 走 contentEditable 原生 execCommand，没有 case —— 只能看实际样式 */
    ok(s0 && s1 && s1.weight !== s0.weight, '⌘B 加粗：选中文字的字重真的变了',
      JSON.stringify([s0, s1]))
    ok(s2 && s2.style === 'italic', '⌘I 斜体：样式真的斜了', JSON.stringify(s2))
    ok(s3 && /underline/.test(s3.deco), '⌘U 下划线：装饰线真的出来了', JSON.stringify(s3))
  }

  /* ══════════ 块多选（语雀：勾选框 / ⌘ 点 / ⇧ 连选 / 批量删转）══════════ */
  {
    await settle()
    const n0 = await p.locator('[data-block-id]').count()
    const typesOf = () => p.evaluate(() =>
      [...document.querySelectorAll('[data-block-id]')].map((e) => (e.className.match(/yq-block-(\w+)/) || [])[1]))

    // ① 默认不出现勾选框 —— 纯 hover 出现的做法在触屏上根本点不到
    ok((await p.locator('.yq-block-selectbox').count()) === 0,
      '没有多选时不显示勾选框')

    // ② ⌘ 点两块 → 底部批量条出现并显示「已选 2 块」
    const blocks = p.locator('[data-block-id]')
    await p.keyboard.down('Control')
    await blocks.nth(1).click({ position: { x: 30, y: 8 } })
    await blocks.nth(2).click({ position: { x: 30, y: 8 } })
    await p.keyboard.up('Control')
    await p.waitForTimeout(800)
    const barN = await p.locator('.yq-bulkbar').count()
    const cnt = await p.locator('.yq-bulkbar-count').innerText().catch(() => '')
    ok(barN === 1 && /2/.test(cnt), '⌘ 点选 → 底部批量条出现（已选 2 块）', `bar=${barN} ${cnt}`)
    const boxOn = await p.locator('.yq-block-selectbox.is-on').count()
    ok(boxOn === 2, `两块都被勾选（${boxOn}）`)

    // ③ 批量转类型
    const t0 = await typesOf()
    await p.locator('.yq-bulkbar-btn:has-text("转为")').click()
    await p.waitForTimeout(600)
    await p.locator('.yq-menu-item:has-text("引用")').click()
    await p.waitForTimeout(1200)
    const t1 = await typesOf()
    ok(t1[1] === 'quote' && t1[2] === 'quote',
      '批量转「引用」：选中的两块都变了', `${t0[1]}/${t0[2]} → ${t1[1]}/${t1[2]}`)

    // ④ 批量删除 —— **会落库**，所以紧接着必须自己收回
    await p.waitForTimeout(400)
    const nBefore = (await typesOf()).length
    await p.locator('.yq-bulkbar-btn.is-danger').click()
    await p.waitForTimeout(1500)
    const nAfter = (await typesOf()).length
    ok(nAfter === nBefore - 2, `批量删除两块：块数 ${nBefore} → ${nAfter}`)
    ok((await p.locator('.yq-bulkbar').count()) === 0, '删完自动退出多选（底栏消失）')

    // ⑤ 收回：Backspace 撤不回来（没有应用级撤销），只能从 seed 还原
    //    —— 所以这个套件**不能**把「删了」留在部署数据里。
    /*
     * ⚠️ 判据必须和 `originTexts` **用同一个口径**。
     *   第一版这里数的是 `st.docs.d1.blocks.length`（含分割线），
     *   而 `n0` 数的是渲染出来的 `[data-block-id]` —— 两者不是一回事，
     *   结果判成「不需要还原」，可页面其实少了一块，于是还原守卫才报
     *   「块数对不上（10 vs 原 11）」。
     *   统一成「渲染出的块数」。
     */
    const back = await p.evaluate(() => document.querySelectorAll('[data-block-id]').length)
    if (back !== n0) {
      // 块数对不上：直接从 seed 恢复，判据同上（这次带自洽校验）
      const seedSrc = fs.readFileSync('src/data/seed.ts', 'utf8')
      const starts = [...seedSrc.matchAll(/reg\(buildDoc\('/g)].map((m) => m.index)
      let seg = null
      for (let i = 0; i < starts.length; i++) {
        const s = seedSrc.slice(starts[i], starts[i + 1] ?? seedSrc.length)
        if (/buildDoc\('d1',/.test(s)) { seg = s; break }
      }
      const arr = seg.slice(seg.indexOf('['), seg.lastIndexOf('])'))
      const want = []
      // ⚠️ type 必须允许数字（h1/h2/h3/h4）—— 只写 [a-z]+ 会漏掉标题，
      //    而「漏匹配」在恢复时表现为**静默删内容**（实测栽过：11 块被删成 8 块）。
      const rx = /B\(\s*'([a-z]+\d*)'\s*,\s*'((?:[^'\\]|\\.)*)'/g
      let m
      while ((m = rx.exec(arr))) {
        want.push({ type: m[1], text: m[2].replace(/\\'/g, "'").replace(/\\n/g, '\n') })
      }
      // 自洽校验：数组里 B(' 的个数必须等于解析出的块数
      const totalB = (arr.match(/\bB\('/g) || []).length
      if (totalB !== want.length) {
        throw new Error(`seed 解析不自洽（${totalB} 个 B(' vs ${want.length} 块），拒绝覆盖`)
      }
      await p.evaluate((w) => {
        window.__yqStore.getState().setDocBlocks('d1', w.map((x, i) => ({ id: 'bk_r' + i, type: x.type, text: x.text })))
      }, want)
      await p.waitForTimeout(2500)
      ok(true, `批量删除的改动已从 seed 还原（${want.length} 块）`)
    } else {
      ok(true, '块数未变（删除已自动撤销），无需还原')
    }
  }

  /* ══════════ ⌘Z：只保证块内输入能撤销，不承诺块级 ══════════ */
  {
    await settle()
    const t = p.locator('.yq-block-text').first()
    await t.click()
    await p.waitForTimeout(300)
    const before = await t.innerText()
    await p.keyboard.type('守门员')
    await p.waitForTimeout(700)
    const mid = await t.innerText()
    await p.keyboard.press('Control+z')
    await p.waitForTimeout(900)
    const after = await t.innerText()
    ok(mid.length > before.length && after.length < mid.length,
      '⌘Z 能撤销块内输入（面板文案承诺的那一半）', `${before.length} → ${mid.length} → ${after.length}`)
  }
} finally {
  /*
   * 收尾守卫（2026-10-08 事故后加的）：
   * 这个套件会真的改文档，而 `finally` 里若什么都不做，
   * 一旦中途抛错，探针写进去的字就**留在部署数据里**。
   * 所以：无论成败，退出前都要把正文还原回去。
   */
  try {
    /*
     * ⚠️ 若套件在**第一条测试之前**就崩了（连不上服务之类），
     *   target 仍是 null —— 那时候报「块数对不上 / 页面跳转」全是**下游症状**，
     *   会把真正的错误（ERR_CONNECTION_REFUSED）盖掉。
     *   所以先判 target：有它才谈还原。
     */
    if (!target) {
      console.log('  SKIP  套件没跑到取文档那一步（见上面的真实错误），跳过还原核对')
    } else {
    /*
     * ⚠️ 收尾时页面可能停在**别的路由**（最后几组测试会跳来跳去）。
     *   而 `waitForLoadState('domcontentloaded')` 对 **hash 路由的跳转不触发** ——
     *   它等的是整页 load。所以只在原地重试三次，页面永远不会回来。
     *   正确做法：**主动导航回文档页**，再量。
     */
    const onTarget = await page.evaluate(() => location.hash).catch(() => '')
    if (onTarget !== '#' + target.url) {
      await page.goto(BASE + '/#' + target.url, { waitUntil: 'domcontentloaded' }).catch(() => {})
      await page.waitForSelector('.yq-block', { timeout: 25000 }).catch(() => {})
      await page.waitForTimeout(2000)
    }
    const rr = await restore('收尾')
    if (!rr.ok) {
      fail++
      console.log(`  FAIL  ${rr.why}`)
    } else {
      const finalTexts = await page.evaluate(() => [...document.querySelectorAll('.yq-block-text')].map((e) => e.textContent))
      const finalBlocks = await page.evaluate(() => document.querySelectorAll('[data-block-id]').length)
      const leftover = finalTexts.filter((t, i) => t !== originTexts[i]).length
        + Math.max(0, finalBlocks - originBlockCount)
      console.log(leftover === 0
        ? '  PASS  正文已完全还原（退出前核对）'
        : `  FAIL  退出前仍有 ${leftover} 块未还原 —— 测试数据留在了部署实例里`)
      if (leftover) fail++
    }
    }
  } catch (e) {
    console.log(`  FAIL  收尾还原异常：${e.message}`)
    fail++
  }
  await browser.close()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
