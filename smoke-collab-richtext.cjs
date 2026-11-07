/**
 * 验证：富文本格式在跨标签页同步时是否保留
 * worker 报告第 3 条说「远端 apply 会丢富文本，BlockRow 只写 innerText」。
 * 但我后来给 attachText 改成了「优先读 block.html」，所以要实测确认。
 */
const { chromium } = require('playwright')
const http = require('http'); const fs = require('fs'); const path = require('path')
const DIST = process.env.SMOKE_DIST || 'dist'
const PORT = 5900 + Math.floor(Math.random() * 90)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0]
  let f = path.join(__dirname, DIST, u === '/' ? 'index.html' : u)
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(__dirname, DIST, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
  res.end(fs.readFileSync(f))
})

let fail = 0
const t = async (name, fn) => {
  try { await fn(); console.log(`✅ ${name}`) }
  catch (e) { fail++; console.log(`❌ ${name}\n   ${e.message}`) }
}

;(async () => {
  await new Promise((r) => server.listen(PORT, r))
  const b = await chromium.launch()
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
  const A = await ctx.newPage()
  const B = await ctx.newPage()
  const errs = []
  A.on('pageerror', (e) => errs.push('A ' + e.message))
  B.on('pageerror', (e) => errs.push('B ' + e.message))
  const URL = `http://localhost:${PORT}`

  // B 切成陈小满，模拟第二个人
  await A.goto(`${URL}/#/`, { waitUntil: 'networkidle' })
  await A.waitForSelector('.yq-dash-greeting')
  await B.goto(`${URL}/#/`, { waitUntil: 'networkidle' })
  await B.waitForSelector('.yq-dash-greeting')
  await B.evaluate(() => window.__yqStore.getState().switchUser('u2'))
  await B.waitForTimeout(500)

  // 两边都进同一篇文档
  await A.goto(`${URL}/#/book/b1/doc/d5`, { waitUntil: 'networkidle' })
  await B.goto(`${URL}/#/book/b1/doc/d5`, { waitUntil: 'networkidle' })
  await A.waitForSelector('.yq-block-text')
  await B.waitForSelector('.yq-block-text')
  await A.waitForTimeout(1500)

  await t('A 加粗 → B 看到加粗', async () => {
    // A 在 p 块末尾输入并加粗
    const ta = A.locator('.yq-block-text').nth(1)
    await ta.click()
    await A.keyboard.press('End')
    await A.keyboard.type('协同加粗', { delay: 20 })
    await A.waitForTimeout(250)
    await A.evaluate(() => {
      const el = document.querySelectorAll('.yq-block-text')[1]
      const tn = el.firstChild
      const r = document.createRange()
      r.setStart(tn, tn.textContent.length - 4); r.setEnd(tn, tn.textContent.length)
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
    })
    await A.waitForTimeout(200)
    await A.click('.yq-tb-btn:has-text("B")')
    await A.waitForTimeout(1400)   // 越过 60ms 广播 + 400ms 防抖

    const seen = await B.locator('.yq-block-text').nth(1).evaluate((el) => ({
      text: el.innerText,
      bold: !!el.querySelector('b, strong'),
    }))
    if (!seen.text.includes('协同加粗')) throw new Error('B 没收到文本: ' + seen.text.slice(0, 40))
    if (!seen.bold) {
      const dbg = await B.evaluate(() => {
        const st = window.__yqStore.getState().docs.d5.blocks[1]
        const ls = JSON.parse(localStorage.getItem('yuque-clone-data-v1') || '{}')
        return {
          storeHtml: st && st.html,
          storeText: st && st.text,
          lsHtml: ls.docs?.d5?.blocks?.[1]?.html,
        }
      })
      throw new Error('B 收到文本但加粗丢了\n   store.html=' + JSON.stringify(dbg.storeHtml)?.slice(-60) +
        '\n   store.text=' + JSON.stringify(dbg.storeText)?.slice(-30) +
        '\n   localStorage.html=' + JSON.stringify(dbg.lsHtml)?.slice(-60))
    }
  })

  await t('B 染颜色 → A 看到颜色', async () => {
    const tb = B.locator('.yq-block-text').nth(1)
    await tb.click()
    await B.keyboard.press('End')
    await B.keyboard.type('B染色', { delay: 20 })
    await B.waitForTimeout(250)
    await B.evaluate(() => {
      const el = document.querySelectorAll('.yq-block-text')[1]
      const tn = el.firstChild
      const r = document.createRange()
      r.setStart(tn, tn.textContent.length - 3); r.setEnd(tn, tn.textContent.length)
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r)
    })
    await B.waitForTimeout(200)
    await B.click('.yq-tb-btn:has-text("A") >> nth=0')
    await B.waitForSelector('.yq-tb-colors', { timeout: 3000 })
    await B.click('.yq-tb-color[title="#e34d59"]')
    await B.waitForTimeout(1400)

    const seen = await A.locator('.yq-block-text').nth(1).evaluate((el) => {
      const nodes = [...el.querySelectorAll('font, span')]
      return {
        text: el.innerText,
        colored: nodes.some((n) => (n.getAttribute('color') || '').toLowerCase() === '#e34d59'
          || (n.getAttribute('style') || '').toLowerCase().includes('227, 77, 89')),
      }
    })
    if (!seen.text.includes('B染色')) throw new Error('A 没收到文本')
    if (!seen.colored) throw new Error('A 收到文本但颜色丢了')
  })

  await t('B 刷新后格式仍在（远端内容真的落了盘）', async () => {
    await B.waitForTimeout(900)
    await B.reload({ waitUntil: 'networkidle' })
    await B.waitForSelector('.yq-block-text')
    await B.waitForTimeout(600)
    const seen = await B.locator('.yq-block-text').nth(1).evaluate((el) => ({
      text: el.innerText,
      bold: !!el.querySelector('b, strong'),
    }))
    if (!seen.bold) throw new Error('刷新后加粗丢失: ' + seen.text.slice(0, 30))
  })

  await A.screenshot({ path: '.smoke/41-协同-富文本A.png' })
  await B.screenshot({ path: '.smoke/41-协同-富文本B.png' })

  console.log('\n运行时错误:', errs.length ? errs.slice(0, 3) : '0 条')
  await b.close(); server.close()
  console.log('='.repeat(40) + `\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`)
  process.exit(fail ? 1 : 0)
})()
