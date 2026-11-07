/**
 * 专项验证：富文本格式持久化
 * 之前加粗/颜色/字号只在编辑期有效（基于 execCommand），刷新就没了。
 * 现在 block.html 存快照，挂载时优先恢复。
 */
const { chromium } = require('playwright')
const http = require('http'); const fs = require('fs'); const path = require('path')
const DIST = process.env.SMOKE_DIST || 'dist'
const PORT = 5600 + Math.floor(Math.random() * 90)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0]
  let f = path.join(__dirname, DIST, u === '/' ? 'index.html' : u)
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(__dirname, DIST, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
  res.end(fs.readFileSync(f))
})

;(async () => {
  await new Promise((r) => server.listen(PORT, r))
  const b = await chromium.launch()
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } })
  p.on('pageerror', (e) => console.log('ERR', e.message))
  let fail = 0
  const t = async (name, fn) => {
    try { await fn(); console.log(`✅ ${name}`) }
    catch (e) { fail++; console.log(`❌ ${name}\n   ${e.message}`) }
  }

  const DOC = 'd5' // 知识库与目录编排
  const go = async () => {
    // 先落到工作台，让 store 用种子数据初始化，再进文档
    await p.goto(`http://localhost:${PORT}/#/`, { waitUntil: 'networkidle' })
    await p.waitForSelector('.yq-dash-greeting', { timeout: 10000 })
    await p.goto(`http://localhost:${PORT}/#/book/b1/doc/${DOC}`, { waitUntil: 'networkidle' })
    await p.waitForSelector('.yq-block-text', { timeout: 10000 })
    await p.waitForTimeout(400)
  }

  await go()

  // 在第 3 个块里输入并加粗
  await t('加粗 + 颜色 → 刷新后仍在', async () => {
    const target = p.locator('.yq-block-text').nth(1)
    await target.click()
    await p.keyboard.press('End')
    await p.keyboard.type('加粗测试', { delay: 20 })
    await p.waitForTimeout(200)

    // 选中刚输入的 4 个字并加粗
    await p.evaluate(() => {
      const els = [...document.querySelectorAll('.yq-block-text')]
      const el = els[1]
      const tn = el.firstChild
      const r = document.createRange()
      r.setStart(tn, tn.textContent.length - 4)
      r.setEnd(tn, tn.textContent.length)
      const s = window.getSelection()
      s.removeAllRanges(); s.addRange(r)
    })
    await p.waitForTimeout(150)
    await p.click('.yq-tb-btn:has-text("B")')
    await p.waitForTimeout(600)

    // 刷新前先确认格式已在 DOM 上
    const blk2 = p.locator('.yq-block-text').nth(1)   // p 块：h 块字重已粗，加粗按钮是灰的
    const hasBold = await blk2.evaluate((el) => !!el.querySelector('b, strong, [style*="bold"]'))
    if (!hasBold) throw new Error('加粗未应用到 DOM')

    await p.waitForTimeout(900)   // 等防抖落盘
    await p.reload({ waitUntil: 'networkidle' })
    await p.waitForSelector('.yq-block-text')
    await p.waitForTimeout(500)

    const after = await blk2.evaluate((el) => ({
      hasBold: !!el.querySelector('b, strong, [style*="bold"]'),
      text: el.innerText,
    }))
    if (!after.text.includes('加粗测试')) throw new Error('刷新后文本丢失: ' + after.text)
    if (!after.hasBold) throw new Error('刷新后加粗丢失 ← 这就是本次要修的 bug')
  })

  await t('localStorage 里确实存了 html', async () => {
    const stored = await p.evaluate(() => {
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

  await t('颜色 → 刷新后仍在', async () => {
    const target = p.locator('.yq-block-text').nth(1)
    await target.click()
    await p.keyboard.press('End')
    await p.keyboard.type('颜色测试', { delay: 20 })
    await p.waitForTimeout(200)
    await p.evaluate(() => {
      const el = document.querySelectorAll('.yq-block-text')[1]
      const tn = el.firstChild
      const r = document.createRange()
      r.setStart(tn, tn.textContent.length - 4); r.setEnd(tn, tn.textContent.length)
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
    })
    await p.waitForTimeout(150)
    // 打开前景色面板点红色
    await p.click('.yq-tb-btn:has-text("A") >> nth=0')
    await p.waitForSelector('.yq-tb-colors', { timeout: 3000 })
    await p.click('.yq-tb-color[title="#e34d59"]')
    await p.waitForTimeout(700)

    await p.reload({ waitUntil: 'networkidle' })
    await p.waitForSelector('.yq-block-text')
    await p.waitForTimeout(500)
    const ok = await p.locator('.yq-block-text').nth(1).evaluate((el) => {
      const hit = [...el.querySelectorAll('span, font, [style*="color"]')]
        .some((n) => (n.getAttribute('style') || '').toLowerCase().includes('rgb(227, 77, 89)')
          || (n.getAttribute('color') || '').toLowerCase() === '#e34d59'
          || (n.textContent || '').includes('颜色测试'))
      return { text: el.innerText, hit }
    })
    if (!ok.text.includes('颜色测试')) throw new Error('刷新后文本丢失: ' + ok.text)
    if (!ok.hit) throw new Error('刷新后颜色丢失')
  })

  await t('markdown 转换后的块 html 干净', async () => {
    // 真实用户路径：空块打前缀即转换。
    // （MD_RULES 只在 t.length <= 5 时触发，所以必须是空块/短内容）
    const nid = await p.evaluate(() => window.__yqStore.getState().createDoc('b1', 'n1', '转换测试'))
    await p.goto(`http://localhost:${PORT}/#/book/b1/doc/${nid}`, { waitUntil: 'networkidle' })
    await p.waitForSelector('.yq-block-text')
    await p.waitForTimeout(400)

    const t1 = p.locator('.yq-block-text').first()
    await t1.click()
    await p.keyboard.press('End')
    await p.keyboard.press('Enter')
    await p.waitForTimeout(200)

    const t2 = p.locator('.yq-block-text').nth(1)
    await t2.click()
    await p.keyboard.type('## ', { delay: 40 })
    await p.waitForTimeout(300)
    await p.keyboard.type('转换后', { delay: 20 })
    await p.waitForTimeout(600)

    const after = await t2.evaluate((el) => ({
      html: el.innerHTML,
      cls: el.closest('[data-block-id]').className,
    }))
    if (!after.cls.includes('h2')) throw new Error('未转成 h2: ' + after.cls)
    if (!after.html.includes('转换后')) throw new Error('转换后输入丢失: ' + after.html)
    if (/<(b|strong|font|span\s+style)/i.test(after.html)) {
      throw new Error('转换后 html 残留格式标签: ' + after.html.slice(0, 100))
    }

    // 落盘的 html 也要是干净的纯文本
    const stored = await p.evaluate((docId) => {
      const d = JSON.parse(localStorage.getItem('yuque-clone-data-v1'))
      const b = d.docs[docId].blocks[1]
      return { type: b.type, html: b.html }
    }, nid)
    if (stored.type !== 'h2') throw new Error('落盘类型错误: ' + stored.type)
    if (/<(b|strong|font|span\s+style)/i.test(stored.html)) {
      throw new Error('落盘 html 残留格式: ' + stored.html)
    }
    console.log('   落盘 html:', JSON.stringify(stored.html))
  })

  await p.screenshot({ path: '.smoke/40-富文本持久化.png' })
  await b.close(); server.close()
  console.log('\n' + '='.repeat(40) + `\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`)
  process.exit(fail ? 1 : 0)
})()
