/**
 * 收敛性专项 —— CRDT 的底线要求。
 * ============================================================
 * 无论并发怎么发生，两端最终内容必须【字面完全一致】。
 * 只要出现「A 留自己的、B 留自己的」，就是坏的：
 * 轻则内容丢失，重则越同步越乱，再也收敛不了。
 *
 * 这个脚本只做一件事：构造并发 → 断言收敛。
 */
const { chromium } = require('playwright')
const http = require('http'); const fs = require('fs'); const path = require('path')
const DIST = process.env.SMOKE_DIST || 'dist'
const PORT = 7000 + Math.floor(Math.random() * 90)
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

const content = (p, doc) =>
  p.evaluate((d) => JSON.stringify(
    window.__yqStore.getState().docs[d].blocks.map((b) => [b.id, b.type, b.text])), doc)

/** 找出两端不一致的块 */
async function diffOf(A, B, doc) {
  const [a, b] = [JSON.parse(await content(A, doc)), JSON.parse(await content(B, doc))]
  const out = []
  const m = new Map(b.map((x) => [x[0], x]))
  for (const x of a) {
    const y = m.get(x[0])
    if (!y) out.push(`${x[0]} 只在 A`)
    else if (y[2] !== x[2]) out.push(`${x[0]}: A=${JSON.stringify(x[2])} B=${JSON.stringify(y[2])}`)
  }
  for (const y of b) if (!a.find((x) => x[0] === y[0])) out.push(`${y[0]} 只在 B`)
  return out
}

;(async () => {
  await new Promise((r) => server.listen(PORT, r))
  const b = await chromium.launch()
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } })
  const A = await ctx.newPage()
  const URL = `http://localhost:${PORT}`

  await A.goto(`${URL}/#/`, { waitUntil: 'domcontentloaded' })
  await A.waitForSelector('.yq-dash-greeting', { timeout: 20000 })
  await A.evaluate(() => localStorage.clear())
  await A.reload({ waitUntil: 'domcontentloaded' })
  await A.waitForSelector('.yq-dash-greeting')

  const openTwo = async (doc) => {
    const B = await ctx.newPage()
    await B.goto(`${URL}/#/`, { waitUntil: 'domcontentloaded' })
    await B.waitForSelector('.yq-dash-greeting', { timeout: 20000 })
    await B.evaluate(() => window.__yqStore.getState().switchUser('u2'))
    await A.goto(`${URL}/#/book/b1/doc/${doc}`, { waitUntil: 'domcontentloaded' })
    await B.goto(`${URL}/#/book/b1/doc/${doc}`, { waitUntil: 'domcontentloaded' })
    await A.waitForSelector('.yq-block-text')
    await B.waitForSelector('.yq-block-text')
    await A.waitForTimeout(1600)
    return B
  }

  const type = async (p, i, text, pos = 'End') => {
    await p.locator('.yq-block-text').nth(i).click()
    await p.keyboard.press(pos)
    await p.keyboard.type(text, { delay: 18 })
  }

  /* ---------------- 场景 1：同块不同位置（应全保留且收敛） ---------------- */
  await t('同块不同位置并发 → 两处都在且两端一致', async () => {
    const B = await openTwo('d5')
    await type(A, 1, '甲头', 'Home')
    await A.waitForTimeout(1300)
    await type(B, 1, '乙尾', 'End')
    await A.waitForTimeout(1600)
    await B.waitForTimeout(500)
    const d = await diffOf(A, B, 'd5')
    if (d.length) throw new Error('两端不一致:\n     ' + d.join('\n     '))
    const txt = await A.locator('.yq-block-text').nth(1).textContent()
    if (!txt.includes('甲头') || !txt.includes('乙尾')) throw new Error('并发改动丢失: ' + txt.slice(0, 30))
    await B.close()
  })

  /* ---------------- 场景 2：同块同位置（必须择一，且两端择出同一个） ---------------- */
  await t('同块同位置并发 → 择一但两端必须一致', async () => {
    const B = await openTwo('d5')
    // 真正并发：两边紧挨着改，都没等到对方的 op
    await A.locator('.yq-block-text').nth(2).click()
    await B.locator('.yq-block-text').nth(2).click()
    await Promise.all([A.keyboard.press('Home'), B.keyboard.press('Home')])
    await A.keyboard.type('AAA', { delay: 15 })
    await B.keyboard.type('BBB', { delay: 15 })
    await A.waitForTimeout(2200)
    await B.waitForTimeout(800)
    const d = await diffOf(A, B, 'd5')
    if (d.length) {
      throw new Error('择一结果两端不同（这正是要修的收敛性 bug）:\n     ' + d.join('\n     '))
    }
    const txt = await A.locator('.yq-block-text').nth(2).textContent()
    if (!/AAA|BBB/.test(txt)) throw new Error('双方改动全丢了: ' + txt.slice(0, 20))
    await B.close()
  })

  /* ---------------- 场景 3：两人都改，且各自 clock 差很多 ---------------- */
  await t('一方多次编辑后再并发 → 仍须收敛', async () => {
    const B = await openTwo('d5')
    // A 连续改 6 次（clock 会明显大于 B），再与 B 并发
    for (const t6 of ['1', '2', '3', '4', '5', '6']) {
      await type(A, 3, t6, 'End')
      await A.waitForTimeout(160)
    }
    await A.waitForTimeout(1300)
    await type(B, 3, 'B改', 'Home')
    await A.waitForTimeout(2000)
    await B.waitForTimeout(600)
    const d = await diffOf(A, B, 'd5')
    if (d.length) {
      throw new Error('clock 差异大的并发未收敛:\n     ' + d.join('\n     '))
    }
    await B.close()
  })

  /* ---------------- 场景 4：三个标签页同时改同一块 ---------------- */
  await t('三端同时改同一块 → 三端必须一致', async () => {
    const B = await openTwo('d5')
    const C = await ctx.newPage()
    await C.goto(`${URL}/#/book/b1/doc/d5`, { waitUntil: 'domcontentloaded' })
    await C.waitForSelector('.yq-block-text')
    await C.waitForTimeout(1600)

    for (const p of [A, B, C]) {
      await p.locator('.yq-block-text').nth(4).click()
      await p.keyboard.press('Home')
    }
    await Promise.all([A, B, C].map((p) => p.keyboard.type(p === A ? 'A' : p === B ? 'B' : 'C', { delay: 15 })))
    await A.waitForTimeout(2600)
    await B.waitForTimeout(1200)
    await C.waitForTimeout(600)

    const sa = await content(A, 'd5')
    const sb = await content(B, 'd5')
    const sc = await content(C, 'd5')
    if (sa !== sb || sb !== sc) {
      const [aa, bb, cc] = [JSON.parse(sa), JSON.parse(sb), JSON.parse(sc)]
      const diffs = []
      for (let i = 0; i < Math.max(aa.length, bb.length, cc.length); i++) {
        const x = aa[i], y = bb[i], z = cc[i]
        if (!x || !y || !z || JSON.stringify(x) !== JSON.stringify(y) || JSON.stringify(y) !== JSON.stringify(z)) {
          diffs.push(`#${i} A=${JSON.stringify(x)} B=${JSON.stringify(y)} C=${JSON.stringify(z)}`)
        }
      }
      throw new Error('三端不一致:\n     ' + (diffs.length ? diffs.join('\n     ') : '数组长度不同'))
    }
    await B.close(); await C.close()
  })

  /* ---------------- 场景 5：收敛后再编辑，状态不能回退 ---------------- */
  await t('收敛之后再编辑 → 不会回退到旧内容', async () => {
    const B = await openTwo('d5')
    await type(A, 1, 'X1', 'Home'); await A.waitForTimeout(1300)
    await type(B, 1, 'Y1', 'End'); await A.waitForTimeout(1600); await B.waitForTimeout(500)
    const merged = await A.locator('.yq-block-text').nth(1).textContent()

    await type(A, 1, 'Z', 'End'); await A.waitForTimeout(1500)
    await B.waitForTimeout(800)
    const d = await diffOf(A, B, 'd5')
    if (d.length) throw new Error('后续编辑后不一致:\n     ' + d.join('\n     '))
    const after = await A.locator('.yq-block-text').nth(1).textContent()
    if (!after.includes('X1') || !after.includes('Y1')) throw new Error('之前合并的内容丢了: ' + after.slice(0, 30))
    if (!merged) throw new Error('合并结果为空')
    await B.close()
  })

  await b.close(); server.close()
  console.log('\n' + '='.repeat(50) + `\n${fail === 0 ? '收敛性全部通过' : fail + ' 项未收敛'}`)
  process.exit(fail ? 1 : 0)
})()
