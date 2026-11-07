/**
 * 验证「增量同步」真的在增量，而不是退化回整篇广播。
 * 做法：在页面上包一层 BroadcastChannel.postMessage，统计每条消息的
 * 结构化克隆体积与 blocks 长度；A 改一个字时，发出的应该是一条小 patch，
 * 而不是整个 Block[]。
 */
const { chromium } = require('playwright')
const http = require('http'); const fs = require('fs'); const path = require('path')
const DIST = process.env.SMOKE_DIST || 'dist'
const PORT = 6400 + Math.floor(Math.random() * 90)
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
  const URL = `http://localhost:${PORT}`

  // 只包 postMessage 记录，不碰构造器
  const hook = () => ctx.addInitScript(() => {
    window.__sent = []
    const orig = BroadcastChannel.prototype.postMessage
    BroadcastChannel.prototype.postMessage = function (m) {
      try {
        let size = 0
        try { size = JSON.stringify(m).length } catch {}
        window.__sent.push({ kind: m && m.kind, bytes: size, blocks: m && m.blocks ? m.blocks.length : undefined })
      } catch {}
      return orig.call(this, m)
    }
  })
  await hook()

  await A.goto(`${URL}/#/`, { waitUntil: 'domcontentloaded' })
  await A.waitForSelector('.yq-dash-greeting', { timeout: 20000 })
  await B.goto(`${URL}/#/`, { waitUntil: 'domcontentloaded' })
  await B.waitForSelector('.yq-dash-greeting', { timeout: 20000 })
  await B.evaluate(() => window.__yqStore.getState().switchUser('u2'))
  await A.goto(`${URL}/#/book/b1/doc/d2`, { waitUntil: 'domcontentloaded' })
  await B.goto(`${URL}/#/book/b1/doc/d2`, { waitUntil: 'domcontentloaded' })
  await A.waitForSelector('.yq-block-text')
  await B.waitForSelector('.yq-block-text')
  await A.waitForTimeout(1800)

  // 量一下整篇全量有多大，作为对比基线
  const fullSize = await A.evaluate(() => {
    const d = window.__yqStore.getState().docs.d2
    return JSON.stringify({ blocks: d.blocks, title: d.title }).length
  })
  console.log(`   基准：整篇全量约 ${fullSize} 字符（d2 共 ${await A.evaluate(() => window.__yqStore.getState().docs.d2.blocks.length)} 块）`)

  // 清空记录，只看增量阶段
  await A.evaluate(() => { window.__sent = [] })
  await B.evaluate(() => { window.__sent = [] })

  /**
   * 第一次输入必然是全量（会话刚建立，还没有增量基准，
   * 而且那一刻对端可能还没上线，全量最稳）。
   * 所以要测的是【第二次】输入 —— 那才是真正的增量路径。
   */
  await t('A 首次输入（建立基准）→ 建立后能收到', async () => {
    const target = A.locator('.yq-block-text').nth(1)
    await target.click()
    await A.keyboard.press('End')
    await A.keyboard.type('Z', { delay: 20 })
    await A.waitForTimeout(1200)
    const sent = await A.evaluate(() => window.__sent.filter((m) => m.kind === 'content' || m.kind === 'op'))
    if (!sent.length) throw new Error('A 一条内容消息都没发')
    console.log(`   基准消息: ${sent[sent.length - 1].kind}, ${sent[sent.length - 1].bytes} 字符`)
  })

  await t('B 收到了首次内容', async () => {
    const ok = await B.locator('.yq-block-text').nth(1).evaluate((el) => el.innerText.includes('Z'))
    if (!ok) throw new Error('B 没收到 A 的首次内容')
  })

  await t('A 第二次输入 → 发出的是小 op，不是整篇', async () => {
    await A.evaluate(() => { window.__sent = [] })
    const target = A.locator('.yq-block-text').nth(1)
    await target.click()
    await A.keyboard.press('End')
    await A.keyboard.type('Q', { delay: 20 })
    await A.waitForTimeout(1200)   // 越过 60ms 尾随防抖

    const sent = await A.evaluate(() => window.__sent.filter((m) => m.kind === 'content' || m.kind === 'op'))
    if (!sent.length) throw new Error('A 一条内容消息都没发')
    // 协议已从「整篇 patch」演进到「单块 op」，这里跟着断言 op 层：
    // 一条 op 只描述一个块的改动，绝不能再携带完整 blocks 数组。
    const msg = sent[sent.length - 1]
    if (msg.kind !== 'op') {
      throw new Error(`第二次仍是全量 content 而非 op（bytes=${msg.bytes}）—— 增量没生效`)
    }
    if (msg.blocks !== undefined) {
      throw new Error('op 消息里不该带完整 blocks 数组')
    }
    if (msg.bytes > fullSize * 0.6) {
      throw new Error(`op 体积 ${msg.bytes} 接近全量 ${fullSize}，增量没生效`)
    }
    console.log(`   op 实际体积 ${msg.bytes} 字符 ≈ 全量的 ${(msg.bytes / fullSize * 100).toFixed(1)}%`)
  })

  await t('B 应用了增量', async () => {
    const ok = await B.locator('.yq-block-text').nth(1).evaluate((el) => el.innerText.includes('Q'))
    if (!ok) throw new Error('B 没收到 A 的增量')
  })

  await t('A 再输入 → 仍是 op（基准能连续对上）', async () => {
    await A.evaluate(() => { window.__sent = [] })
    const target = A.locator('.yq-block-text').nth(1)
    await target.click()
    await A.keyboard.press('End')
    await A.keyboard.type('Y', { delay: 20 })
    await A.waitForTimeout(1200)
    const sent = await A.evaluate(() => window.__sent.filter((m) => m.kind === 'content' || m.kind === 'op'))
    const last = sent[sent.length - 1]
    if (last.kind !== 'op') throw new Error('第二条退化成全量了（可能触发了 need-full 往返）')
    const ok = await B.locator('.yq-block-text').nth(1).evaluate((el) => el.innerText.includes('Q') && el.innerText.includes('Y'))
    if (!ok) throw new Error('B 没收到第二条增量')
  })

  await t('A 改块类型（改的是结构）→ 增量也能带过去', async () => {
    await A.evaluate(() => { window.__sent = [] })
    const n = await A.locator('.yq-block-text').count()
    await A.locator('.yq-block-text').nth(n - 1).click()
    await A.keyboard.press('End')
    await A.keyboard.press('Enter')
    await A.waitForTimeout(250)
    await A.locator('.yq-block-text').nth(n).click()
    await A.keyboard.type('## ', { delay: 50 })
    await A.waitForTimeout(1200)
    const sent = await A.evaluate(() => window.__sent.filter((m) => m.kind === 'content' || m.kind === 'op'))
    if (!sent.length) throw new Error('结构变更没发消息')
    const ok = await B.evaluate(() => {
      const d = window.__yqStore.getState().docs.d2
      return d.blocks.some((b) => b.type === 'h2')
    })
    if (!ok) throw new Error('B 没拿到新块的 h2 类型')
  })

  await t('两边内容最终一致', async () => {
    const [ha, hb] = await Promise.all([
      A.evaluate(() => JSON.stringify(window.__yqStore.getState().docs.d2.blocks.map((b) => [b.id, b.type, b.text]))),
      B.evaluate(() => JSON.stringify(window.__yqStore.getState().docs.d2.blocks.map((b) => [b.id, b.type, b.text]))),
    ])
    if (ha !== hb) throw new Error('A/B 内容不一致')
  })

  await A.screenshot({ path: '.smoke/42-增量同步-A.png' })
  await b.close(); server.close()
  console.log('\n' + '='.repeat(40) + `\n${fail === 0 ? '全部通过' : fail + ' 项失败'}`)
  process.exit(fail ? 1 : 0)
})()
