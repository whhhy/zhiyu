/* ============================================================
   本地偏好（字号 / 大纲）
   ------------------------------------------------------------
   以前设置页里「编辑器字号」是个 `onChange={() => {}}` 的空控件：
   界面上有，点下去什么都不会发生。这类控件最坏的地方在于
   **它看起来完全正常** —— 不是报错、不是灰的，就是不生效。

   同一个 tab 里还有三个同类：
     · 「默认目录样式：树形 / 列表」—— 目录**只有树形**，列表形态不存在
     · 「水印」—— 那是每个知识库各自的设置，放在全局页只会让人配错地方
     · 「自动保存」—— 自动保存是真的（400ms 落盘），只是不能关
   三条都已按「要么真做、要么说清楚」处理。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')
const PW = process.env.ADMIN_PASS || 'yuque@2026'
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

try {
  const ctx = await browser.newContext()
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(String(e?.message || e)))
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', PW)
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(1500)

  // 备一篇文档
  const { bookId, docId } = await p.evaluate((sfx) => {
    const s = window.__yqStore.getState()
    const b = s.createBook('s1', '偏好验证库 ' + sfx)
    const d = s.createDoc(b, null, '偏好测试文档')
    window.__yqStore.getState().setDocBlocks(d, [
      { id: 'bk1', type: 'h1', text: '一个大标题', order: 0 },
      { id: 'bk2', type: 'p', text: '这是正文，用来量字号。', order: 1 },
    ])
    return { bookId: b, docId: d }
  }, suffix)
  await p.waitForTimeout(2000)

  const openDoc = async () => {
    await p.goto(`${BASE}/#/book/${bookId}/doc/${docId}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block', { timeout: 25000 })
    await p.waitForTimeout(1500)
  }
  /** 正文块的实际渲染字号（px），比读 CSS 变量更可靠：它证明真的生效了 */
  const measure = () => p.evaluate(() => {
    const el = document.querySelector('.yq-block-p .yq-block-text') || document.querySelector('.yq-block-text')
    const h1 = document.querySelector('.yq-block-h1 .yq-block-text')
    return {
      body: el ? parseFloat(getComputedStyle(el).fontSize) : 0,
      h1: h1 ? parseFloat(getComputedStyle(h1).fontSize) : 0,
    }
  })

  await openDoc()
  const md0 = await measure()
  ok(md0.body > 0, `默认字号渲染为 ${md0.body}px`, String(md0.body))

  console.log('\n== 调成「大」要真的变大 ==')
  await p.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-settings-nav', { timeout: 25000 })
  await p.click('.yq-settings-nav-item:has-text("偏好设置")')
  await p.waitForSelector('.yq-settings-card', { timeout: 15000 })
  await p.waitForTimeout(800)
  await p.click('.yq-settings-card button:has-text("大")')
  await p.waitForTimeout(1000)

  const stored = await p.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('yq_prefs_v1') || '{}') } catch { return null }
  })
  ok(stored?.editorFontSize === 'lg', '偏好写进了 localStorage（这是本机偏好，不该跟着文档同步）', JSON.stringify(stored))

  await openDoc()
  const lg = await measure()
  ok(lg.body > md0.body, `正文变大了：${md0.body}px → ${lg.body}px`, `${md0.body} → ${lg.body}`)
  ok(
    Math.abs(lg.h1 - lg.body * 2.1) < 2 && lg.h1 > md0.h1,
    `标题跟着一起缩放（${lg.h1}px ≈ ${lg.body}px × 2.1，且比默认的 ${md0.h1}px 更大）`,
    `${lg.h1} vs ${lg.body * 2.1}`,
  )

  console.log('\n== 刷新之后还在（不是只活在内存里）==')
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-block', { timeout: 25000 })
  await p.waitForTimeout(1800)
  const afterReload = await measure()
  ok(Math.abs(afterReload.body - lg.body) < 0.5, `刷新后仍是 ${afterReload.body}px`, String(afterReload.body))

  console.log('\n== 调成「小」==')
  await p.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-settings-nav', { timeout: 25000 })
  await p.click('.yq-settings-nav-item:has-text("偏好设置")')
  await p.waitForSelector('.yq-settings-card', { timeout: 15000 })
  await p.waitForTimeout(800)
  await p.click('.yq-settings-card button:has-text("小")')
  await p.waitForTimeout(1000)
  await openDoc()
  const sm = await measure()
  ok(sm.body < md0.body, `正文变小了：${md0.body}px → ${sm.body}px`, `${md0.body} → ${sm.body}`)

  console.log('\n== 坏掉的 localStorage 不能把界面带崩 ==')
  await p.evaluate(() => localStorage.setItem('yq_prefs_v1', '{ 不是合法 JSON'))
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-app', { timeout: 25000 })
  await p.waitForTimeout(1500)
  ok(errs.length === 0, '存了坏 JSON 也不影响启动（读到就用默认值）', errs.slice(0, 2).join(' | '))
  await p.evaluate(() => localStorage.setItem('yq_prefs_v1', JSON.stringify({ editorFontSize: '超大' })))
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-app', { timeout: 25000 })
  await p.waitForTimeout(1500)
  ok(errs.length === 0, '写了非法枚举值也回落到默认值，不带着脏值一路走', errs.slice(0, 2).join(' | '))

  console.log('\n== 「启动时打开大纲」==')
  // 大纲的初值是在**挂载时**读的（useState 的函数式初始化），
  // 所以必须真的 reload —— 只改 hash 不会让 DocPage 重新挂载。
  //
  // 「展开与否」不能靠「元素在不在」或「宽度多少」来判断：
  // 收起态里**仍然存在**一个 `.yq-outline.yq-outline-float`（悬停才显示的浮层），
  // 它只是 display:none、宽度 0。所以要挑「真的可见的那个」。
  const outlineState = () => p.evaluate(() => {
    const all = [...document.querySelectorAll('.yq-outline')]
    const visible = all.find((e) => getComputedStyle(e).display !== 'none')
    if (visible) return { state: '展开', width: Math.round(visible.getBoundingClientRect().width) }
    return { state: '收起', width: 0 }
  })
  await p.evaluate(() => localStorage.setItem('yq_prefs_v1', JSON.stringify({ editorFontSize: 'md', outlineOnOpen: false })))
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-block', { timeout: 25000 })
  await p.waitForTimeout(1800)
  const closed = await outlineState()
  ok(closed.state === '收起', '关掉偏好后大纲默认收起（只剩一条悬停才展开的细边）', JSON.stringify(closed))

  await p.evaluate(() => localStorage.setItem('yq_prefs_v1', JSON.stringify({ editorFontSize: 'md', outlineOnOpen: true })))
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-block', { timeout: 25000 })
  await p.waitForTimeout(1800)
  const opened = await outlineState()
  ok(opened.state === '展开' && opened.width > 150, `打开偏好后大纲默认展开（${opened.width}px）`, JSON.stringify(opened))

  console.log('\n== 通知偏好 ==')
  {
    // 模拟**老存档**：只有最初那两个字段，没有 notify
    await p.evaluate(() => localStorage.setItem('yq_prefs_v1', JSON.stringify({ editorFontSize: 'md', outlineOnOpen: true })))
    await p.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-settings-nav', { timeout: 25000 })
    await p.click('.yq-settings-nav-item:has-text("消息通知")')
    await p.waitForSelector('.yq-settings-card', { timeout: 15000 })
    await p.waitForTimeout(800)
    // 全部必须是「受控」的 true/false，而不是 undefined（undefined 会让开关看起来是关的）
    // 用 aria-checked 判断，而不是 class —— 它是这个控件的语义来源
    const states = await p.locator('.yq-switch').evaluateAll((els) => els.map((e) => e.getAttribute('aria-checked')))
    ok(states.length >= 5, `通知开关全部渲染出来了（${states.length} 个）`, String(states.length))
    ok(states.every((s) => s === 'true' || s === 'false'), '每个开关都有明确的 aria-checked（没有 undefined 造成的失控）', JSON.stringify(states))

    // 关掉「文档评论」，刷新后应当还是关的
    const first = p.locator('.yq-switch').first()
    const wasOn = (await first.getAttribute('aria-checked')) === 'true'
    await first.click()
    await p.waitForTimeout(800)
    const stored = await p.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('yq_prefs_v1') || '{}') } catch { return null }
    })
    ok(
      stored?.notify?.comment === !wasOn,
      `关掉「文档评论」真的写进了本地存储（${wasOn} → ${!wasOn}）`,
      JSON.stringify(stored?.notify),
    )
    ok(
      stored?.notify?.collab === true && stored?.notify?.weekly === false,
      '改一项不会把另外四项打回 undefined（notify 是合并而不是整体替换）',
      JSON.stringify(stored?.notify),
    )
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-settings-nav', { timeout: 25000 })
    await p.click('.yq-settings-nav-item:has-text("消息通知")')
    await p.waitForSelector('.yq-switch', { timeout: 15000 })
    await p.waitForTimeout(900)
    const after = await p.locator('.yq-switch').first().getAttribute('aria-checked')
    ok(after === String(!wasOn), '刷新之后这个开关保持原样（不是只在内存里改了一下）', String(after))
  }

  console.log('\n== 假控件已经清掉 ==')
  await p.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-settings-nav', { timeout: 25000 })
  await p.click('.yq-settings-nav-item:has-text("偏好设置")')
  await p.waitForSelector('.yq-settings-card', { timeout: 15000 })
  await p.waitForTimeout(600)
  const prefText = (await p.locator('.yq-settings-card').first().textContent()) || ''
  ok(!/默认目录样式/.test(prefText), '「默认目录样式」这个不存在的选项已经去掉')
  ok(/只有\s*树形|只有树形/.test(prefText.replace(/\s+/g, '')), '并说明了目录只有树形一种形态', prefText.slice(0, 60))
  ok(/自动保存/.test(prefText) && !/停止输入 0\.5 秒后自动保存\s*$/.test(prefText.trim()), '自动保存写成了「已启用」的事实陈述')
  await p.click('.yq-settings-nav-item:has-text("安全")')
  await p.waitForTimeout(800)
  const secText = (await p.locator('.yq-settings-card').first().textContent()) || ''
  ok(!/（旗舰版）/.test(secText), '安全页里那个「（旗舰版）」假按钮没了')
  ok(/知识库设置/.test(secText), '并指路到真正生效的开关所在位置', secText.slice(0, 60))
  ok(errs.length === 0, '全程没有 JS 报错', errs.slice(0, 2).join(' | '))
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  try { await browser.close() } catch { /* 已关 */ }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
