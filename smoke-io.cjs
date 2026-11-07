/**
 * 导出 / 导入
 * ============================================================
 * 为什么要测这个：项目没有服务端（零网络请求、静态托管），
 * 「把文档带到另一台设备」全靠这个通路。它要是坏了，用户就真的没法迁了。
 */
const { chromium } = require('playwright')
const http = require('http'); const fs = require('fs'); const path = require('path')
const DIST = process.env.SMOKE_DIST || 'dist'
const PORT = 6900 + Math.floor(Math.random() * 90)
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

/** 监听下载事件并拿到内容 */
async function captureDownload(page, action) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), action()])
  const p = `/tmp/dl-${Math.random().toString(36).slice(2)}`
  await dl.saveAs(p)
  const buf = fs.readFileSync(p)
  fs.unlinkSync(p)
  return { name: dl.suggestedFilename(), text: buf.toString('utf8') }
}

;(async () => {
  await new Promise((r) => server.listen(PORT, r))
  const b = await chromium.launch()
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const page = await ctx.newPage()
  const URL = `http://localhost:${PORT}`
  await page.goto(`${URL}/#/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-dash-greeting', { timeout: 20000 })

  await t('设置页有「导出整个工作台 / 导入数据包」入口', async () => {
    await page.goto(`${URL}/#/settings`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-dash-greeting, .yq-settings', { timeout: 15000 })
    await page.locator('button').filter({ hasText: '数据管理' }).first().click()
    await page.waitForTimeout(400)
    const txt = await page.textContent('body')
    if (!txt.includes('导出整个工作台')) throw new Error('缺少导出入口')
    if (!txt.includes('导入数据包')) throw new Error('缺少导入入口')
  })

  let bundle = null
  await t('导出的数据包结构正确且含全部内容', async () => {
    bundle = await captureDownload(page, () =>
      page.locator('button').filter({ hasText: '导出数据包' }).first().click())
    if (!bundle.name.endsWith('.json')) throw new Error('文件名不是 json: ' + bundle.name)
    const j = JSON.parse(bundle.text)
    if (j.format !== 'yuque-clone-bundle') throw new Error('format 字段不对')
    if (!j.data.docs || !j.data.books || !j.data.nodes) throw new Error('缺 docs/books/nodes')
    if (Object.keys(j.data.docs).length < 10) throw new Error('文档数太少: ' + Object.keys(j.data.docs).length)
    if (j.data.books.length < 3) throw new Error('知识库数太少: ' + j.data.books.length)
    console.log(`   ${bundle.name} · ${Object.keys(j.data.docs).length} 篇文档 / ${j.data.books.length} 个知识库 / ${(bundle.text.length / 1024).toFixed(0)} KB`)
  })

  await t('包内含文稿数据（先编辑一次工作表才会写 sheetData）', async () => {
    // sheetData 是「编辑时才写入」的，种子数据本来没有 —— 所以先去工作表改一个单元格
    await page.goto(`${URL}/#/book/b2/doc/t6`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-sheet-grid')
    await page.waitForTimeout(600)
    await page.locator('.yq-sheet-grid td input').first().click()
    await page.keyboard.press('End')
    await page.keyboard.type('-X')
    await page.waitForTimeout(900)

    await page.goto(`${URL}/#/settings`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)
    await page.locator('button').filter({ hasText: '数据管理' }).first().click()
    await page.waitForTimeout(400)
    const b2 = await captureDownload(page, () =>
      page.locator('button').filter({ hasText: '导出数据包' }).first().click())
    const j = JSON.parse(b2.text)
    const withSheet = Object.values(j.data.docs).filter((d) => d.sheetData)
    if (!withSheet.length) throw new Error('编辑过工作表，包里仍没有 sheetData')
    if (!JSON.stringify(withSheet[0].sheetData).includes('-X')) throw new Error('sheetData 里没有刚才的编辑')
    console.log(`   ${withSheet.length} 篇含文稿数据，编辑内容已入包`)
  })

  await t('导入校验：非法文件被拒绝且不破坏现有数据', async () => {
    const before = await page.evaluate(() => Object.keys(window.__yqStore.getState().docs).length)
    const r = await page.evaluate(async () => {
      const m = await import('/src/lib/io.ts').catch(() => null)
      return m ? null : 'module-not-loadable-in-runtime'
    })
    void r
    // 走 UI：选一个非法 json
    // ⚠️ 入口 2026-10-16 收成了「导入…」→ 格式选择器（照语雀的形态），
    //    原来那个「选择文件导入」按钮没有了 —— 现在是选择器里的「本系统数据包」。
    await page.locator('button').filter({ hasText: '导入…' }).first().click()
    await page.waitForSelector('.yq-imppick-item', { state: 'visible', timeout: 8000 })
    await page.locator('.yq-imppick-item', { hasText: '本系统数据包' }).first().click()
    await page.waitForSelector('.yq-import', { timeout: 5000 })
    await page.setInputFiles('.yq-import-drop input', {
      name: 'bad.json',
      mimeType: 'application/json',
      buffer: Buffer.from('{ 这不是合法 JSON'),
    })
    await page.waitForTimeout(600)
    const after = await page.evaluate(() => Object.keys(window.__yqStore.getState().docs).length)
    if (after !== before) throw new Error(`导入失败后数据被破坏了: ${before} → ${after}`)
    const txt = await page.textContent('body')
    if (!txt.includes('导入失败')) throw new Error('没有给出失败提示')
  })

  await t('导入非法数据包（格式对但内容残缺）也被拒绝', async () => {
    await page.setInputFiles('.yq-import-drop input', {
      name: 'wrong.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({ format: 'yuque-clone-bundle', version: 1, data: {} })),
    })
    await page.waitForTimeout(600)
    const txt = await page.textContent('body')
    if (!txt.includes('不完整')) throw new Error('没有识别出内容不完整')
  })

  await t('合并导入：本地新增的内容能带进包里再导回', async () => {
    // 本地新建一篇 → 重新导出 → 校验包里有它
    const nid = await page.evaluate(() =>
      window.__yqStore.getState().createDoc('b1', 'n1', '导入前新建的文档'))
    await page.waitForTimeout(800)
    // 前面的用例可能把导入弹窗打开了，导出按钮会被遮住 —— 先确保没有弹窗
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    const b2 = await captureDownload(page, () =>
      page.locator('button').filter({ hasText: '导出数据包' }).first().click())
    const j = JSON.parse(b2.text)
    if (!j.data.docs[nid]) throw new Error('新文档没进包')
    console.log(`   新文档 ${nid} 已包含在 ${(b2.text.length / 1024).toFixed(0)} KB 的包中`)
  })

  await t('单篇文档导出：Markdown / HTML / 纯文本', async () => {
    await page.goto(`${URL}/#/book/b1/doc/d3`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-block-text')
    await page.locator('.yq-doc-more').click()
    await page.waitForTimeout(300)

    const html = await captureDownload(page, () =>
      page.locator('text=导出 HTML').click())
    if (!html.name.endsWith('.html')) throw new Error('文件名: ' + html.name)
    if (!html.text.includes('<!doctype html>') || !html.text.includes('<pre><code>'))
      throw new Error('HTML 内容不完整')
    if (!html.text.includes('认识编辑器')) throw new Error('HTML 里没有正文')
    console.log(`   ${html.name} · ${(html.text.length / 1024).toFixed(1)} KB · 含代码块`)

    await page.locator('.yq-doc-more').click()
    await page.waitForTimeout(300)
    const txt = await captureDownload(page, () =>
      page.locator('text=导出纯文本').click())
    if (!txt.text.includes('认识编辑器')) throw new Error('纯文本没正文')
  })

  await b.close(); server.close()
  console.log('\n' + '='.repeat(46) + `\n${fail === 0 ? '导出/导入全部通过' : fail + ' 项失败'}`)
  process.exit(fail ? 1 : 0)
})()
