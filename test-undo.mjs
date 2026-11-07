/* ============================================================
   应用级撤销 / 重做（⌘Z / ⌘⇧Z）
   ============================================================
   2026-10-19 用户报「编辑没有回退」。实测当时的状态（真机，内网 HTTP）：

     · 块内打字 → ⌘Z 退**一个字**（"标题abc" → "标题ab"），靠浏览器原生撤销
     · 回车新建块 → ⌘Z **块撤不回来**（块数 2 → 2）
     · 块菜单删块 → ⌘Z **撤不回来**（块数 1 → 1）

   也就是说：跨块的操作一个都撤不回来，而界面上只有一句
   「撤销上一次输入（仅块内，不含块级操作）」。

   现在自己实现了一份（`src/lib/undo.ts`），把「撤的是哪个动作」钉清楚：

   ① 打字 —— 一次 ⌘Z 撤掉**整串**（不是一个字）
   ② 回车建块 —— 第一次 ⌘Z 撤掉刚输入的字，第二次撤掉那个块
      （**一次撤一个动作**，和 Word / Notion 一样；这条是断言，不是实现细节）
   ③ 删块 —— 一次 ⌘Z 撤回来
   ④ ⌘⇧Z 重做
   ⑤ 正文**之外**（评论框等）的 ⌘Z 不许接管 —— 那里是浏览器原生的
   ⑥ 撤销之后光标还在正文里

   判据盯的是**用户看到的结果**（块数、块内容、光标位置），
   不是「调用了某个函数」。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:8092'
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const browser = await chromium.launch()
try {
  const p = await (await browser.newContext()).newPage()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', process.env.ADMIN_PASS || 'yuque@2026')
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(1200)

  const bookId = await p.evaluate(() => window.__yqStore.getState().books[0]?.id)
  const docId = await p.evaluate((b) => {
    const st = window.__yqStore.getState()
    const doc = st.createDoc(b, null, '撤销探针', 'doc')
    st.setDocBlocks(doc, [{ id: 'bk_u1', type: 'h1', text: '标题' }])
    return doc
  }, bookId)
  await p.goto(`${BASE}/#/book/${bookId}/doc/${docId}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-block', { timeout: 25000 })
  await p.waitForTimeout(900)

  const snap = () => p.evaluate((d) => {
    const bs = window.__yqStore.getState().docs[d].blocks
    return { n: bs.length, texts: bs.map((b) => String(b.text || '')) }
  }, docId)

  console.log('\n== ① 打字：一次 ⌘Z 撤掉整串 ==')
  await p.locator('.yq-block-text').first().click()
  await p.keyboard.type('abc', { delay: 40 })
  await p.waitForTimeout(700)
  const typed = await snap()
  ok(typed.texts[0] === '标题abc', '打进去三个字', JSON.stringify(typed.texts))
  await p.keyboard.press('Control+z')
  await p.waitForTimeout(800)
  const undone = await snap()
  ok(undone.texts[0] === '标题',
    '★ 一次 ⌘Z 撤掉**整串**（原来只退一个字）', JSON.stringify(undone.texts))

  console.log('\n== ② 回车新建块：⌘Z 撤得回来 ==')
  const beforeEnter = await snap()
  await p.locator('.yq-block-text').first().click()
  await p.keyboard.press('End')
  await p.keyboard.press('Enter')
  await p.waitForTimeout(500)
  await p.keyboard.type('新行', { delay: 40 })
  await p.waitForTimeout(900)
  const afterEnter = await snap()
  ok(afterEnter.n === beforeEnter.n + 1, '回车建出一个新块', JSON.stringify(afterEnter))
  await p.keyboard.press('Control+z')
  await p.waitForTimeout(900)
  const undo1 = await snap()
  ok(undo1.n === afterEnter.n && undo1.texts[1] === '',
    '· 第一次 ⌘Z 撤掉的是**刚输入的字**（一次撤一个动作）', JSON.stringify(undo1.texts))
  await p.keyboard.press('Control+z')
  await p.waitForTimeout(900)
  const afterUndo = await snap()
  ok(afterUndo.n === beforeEnter.n,
    '★ 第二次 ⌘Z 把**新建的块**撤回来了（原来撤不回来）',
    `${beforeEnter.n} → ${afterEnter.n} → ${undo1.n} → ${afterUndo.n}`)

  console.log('\n== ③ 删块：⌘Z 撤得回来 ==')
  await p.locator('.yq-block-text').first().click()
  await p.keyboard.press('End')
  await p.keyboard.press('Enter')
  await p.waitForTimeout(500)
  await p.keyboard.type('要删掉的', { delay: 40 })
  await p.waitForTimeout(900)
  const beforeDel = await snap()
  ok(beforeDel.n === 2, '有两个块可以删', JSON.stringify(beforeDel))
  await p.locator('.yq-block').nth(1).hover()
  await p.waitForTimeout(300)
  await p.locator('.yq-block').nth(1).locator('.yq-block-more').click()
  await p.waitForSelector('.yq-menu-item', { state: 'visible', timeout: 8000 })
  await p.locator('.yq-menu-item', { hasText: '删除块' }).first().click()
  await p.waitForTimeout(1000)
  const afterDel = await snap()
  ok(afterDel.n === beforeDel.n - 1, '删掉了一个块', JSON.stringify(afterDel))
  await p.keyboard.press('Control+z')
  await p.waitForTimeout(900)
  const afterDelUndo = await snap()
  ok(afterDelUndo.n === beforeDel.n,
    '★ ⌘Z 把**删掉的块**撤回来了（原来撤不回来）',
    `${beforeDel.n} → ${afterDel.n} → ${afterDelUndo.n}`)

  console.log('\n== ④ 重做 ==')
  await p.keyboard.press('Control+Shift+z')
  await p.waitForTimeout(900)
  const redone = await snap()
  ok(redone.n === afterDel.n, '★ ⌘⇧Z 把撤销**重做**了', JSON.stringify(redone))

  console.log('\n== ⑤ 正文之外不接管 ⌘Z ==')
  const outside = await p.evaluate(() => {
    const ta = document.querySelector('.yq-comment-input')
    const target = ta || document.body
    target.focus()
    const ev = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })
    target.dispatchEvent(ev)
    return { on: ta ? '评论框' : 'body', defaultPrevented: ev.defaultPrevented }
  })
  ok(outside.defaultPrevented === false,
    `★ 正文之外（${outside.on}）的 ⌘Z **没被接管**`, JSON.stringify(outside))

  console.log('\n== ⑥ 撤销之后光标还在吗 ==')
  await p.locator('.yq-block-text').first().click()
  await p.keyboard.type('xyz', { delay: 40 })
  await p.waitForTimeout(700)
  await p.keyboard.press('Control+z')
  await p.waitForTimeout(900)
  const caret = await p.evaluate(() => {
    const el = document.activeElement
    return {
      editable: !!(el && el.getAttribute && el.getAttribute('contenteditable') === 'true'),
      inEditor: !!(el && el.closest && el.closest('.yq-editor')),
    }
  })
  ok(caret.editable && caret.inEditor, '★ 撤销之后光标**还在正文里**', JSON.stringify(caret))

  await p.evaluate(([b, d]) => window.__yqStore.getState().deleteDoc(d), [bookId, docId])
  await browser.close()
} catch (e) {
  fail++
  console.log(`  FAIL  套件异常：${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`)
} finally {
  await browser.close()
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
