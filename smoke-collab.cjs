/**
 * 协作自验：同一个 browser context 里开两个 Page（A / B），
 * 验证「跨标签页真协同」而不是演示动画。
 *
 * 覆盖：
 *   1) A 输入 → B 的正文 DOM 跟着变（内容同步 A→B）
 *   2) B 输入 → A 的正文 DOM 跟着变（内容同步 B→A）
 *   3) B 移动/选中光标 → A 渲染出 B 那个人的光标竖线 + 名字标签
 *   4)「N 人正在协作」= 真实在场人数（单人 1，双人 2，B 走后回 1）
 *   5) 远端同步过来的内容**不放大 localStorage 写入**（B 一次都不写盘）
 *   6) B 离开文档 / 直接关掉标签页 → A 立刻清掉它的光标
 *
 * 前置：先 `npm run build`（脚本跑 dist）。
 * 跑法：node smoke-collab.cjs
 */
const { chromium } = require('playwright')
const http = require('http')
const fs = require('fs')
const path = require('path')
const DIST = process.env.SMOKE_DIST || 'dist'

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0]
  let f = path.join(__dirname, DIST, u === '/' ? 'index.html' : u)
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(__dirname, DIST, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
  res.end(fs.readFileSync(f))
})

const PORT = 4800 + Math.floor(Math.random() * 600)
const BASE = `http://localhost:${PORT}`
const DOC = '/#/book/b1/doc/d2'
// ⚠️ 这里原来写死的是 '/workspace/yuque/.smoke…' —— Linux 开发环境的残留。
//    在 Windows 上它被解析成 `H:\workspace\yuque\.smoke`，**截图落在工作区外面、
//    盘根下面**，而 .gitignore 里明明列着这些目录名（本来的意图就是放在项目根）。
//    实测一次就堆了 15.1MB，而且**没有任何地方会报**。
//    截图是手动套件唯一的失败取证手段，落在人不会去看的地方，
//    「失败了但看不出为什么」和「套件没跑」长得一模一样。
//    所以改成脚本所在目录；要放别处用 SMOKE_OUT 覆盖。
const OUT = process.env.SMOKE_OUT || path.join(__dirname, '.smoke-collab')
fs.mkdirSync(OUT, { recursive: true })

const steps = []
const errors = []
let pageA, pageB

const check = async (label, fn) => {
  const before = errors.length
  try {
    await fn()
    const newErrs = errors.slice(before)
    steps.push({ label, ok: newErrs.length === 0, errs: newErrs })
    console.log(`${newErrs.length === 0 ? '✅' : '❌'} ${label}`)
    if (newErrs.length) console.log('   ' + newErrs.join('\n   '))
  } catch (e) {
    steps.push({ label, ok: false, errs: [e.message] })
    console.log(`❌ ${label}\n   ${e.message}`)
  }
}

/** 轮询等待条件成立（协同是异步的，不能 sleep 一次就断言） */
const waitFor = async (fn, ms = 4000, step = 100) => {
  const t0 = Date.now()
  let last
  for (;;) {
    last = await fn()
    if (last) return last
    if (Date.now() - t0 > ms) return last
    await new Promise((r) => setTimeout(r, step))
  }
}

const blockText = (page, i) =>
  page.evaluate((idx) => {
    const el = document.querySelectorAll('.yq-block-text')[idx]
    return (el?.innerText || '').replace(/\s+/g, '')
  }, i)

/** 在第 i 个正文块末尾落光标并打字 */
const typeInBlock = async (page, i, text) => {
  const el = page.locator('.yq-block-text').nth(i)
  await el.click()
  await page.keyboard.press('End')
  // 间隔要够大：contentEditable + store 回写本身就不快，
  // 间隔太小时浏览器会丢字（是编辑器既有行为，与同步无关）
  await page.keyboard.type(text, { delay: 60 })
}

/** 让某个 Page 以指定成员身份登录（直接改内存态，不写 localStorage） */
const become = (page, memberId) =>
  page.evaluate((id) => {
    const s = window.__yqStore
    const m = s.getState().members.find((x) => x.id === id)
    s.setState({ currentUser: m, cursors: [] })
    return m.name
  }, memberId)

/** 开始统计 localStorage.setItem 调用次数（用来验证"远端内容不写盘"） */
const watchWrites = (page) =>
  page.evaluate(() => {
    window.__lsWrites = 0
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = function (k, v) {
      window.__lsWrites++
      return orig.call(this, k, v)
    }
  })

const readWrites = (page) => page.evaluate(() => window.__lsWrites || 0)

const watch = (page, tag) => {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${tag} console] ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`[${tag} pageerror] ${e.message}`))
}

;(async () => {
  await new Promise((r) => server.listen(PORT, r))
  const browser = await chromium.launch()
  // 关键：同一个 context = 共享 localStorage + 共享 BroadcastChannel 频道
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  pageA = await ctx.newPage()
  watch(pageA, 'A')
  pageB = await ctx.newPage()
  watch(pageB, 'B')

  await check('准备：A 单开一篇文档', async () => {
    await pageA.goto(`${BASE}/#/`, { waitUntil: 'networkidle' })
    await pageA.goto(`${BASE}${DOC}`, { waitUntil: 'networkidle' })
    await pageA.waitForSelector('.yq-block-text')
    await pageA.waitForTimeout(600) // 等一轮心跳 / 互相发现
  })

  await check('在场人数：单开时是 1 人（只有自己）', async () => {
    const bar = await pageA.locator('.yq-doc-collab-count').innerText()
    if (bar.trim() !== '1 人正在协作') throw new Error('实际是: ' + bar)
    const carets = await pageA.locator('.yq-collab-caret').count()
    if (carets !== 0) throw new Error('单开时不该有别人的光标: ' + carets)
  })

  await check('B 上线（同 context 第二个标签页，切换为陈小满）', async () => {
    await pageB.goto(`${BASE}/#/`, { waitUntil: 'networkidle' })
    await become(pageB, 'u2') // B = 陈小满，A = 林知远
    await pageB.goto(`${BASE}${DOC}`, { waitUntil: 'networkidle' })
    await pageB.waitForSelector('.yq-block-text')
    await pageA.waitForTimeout(600)
  })

  await check('在场人数：B 上线后 A 变成 2 人', async () => {
    const bar = await waitFor(async () => {
      const t = await pageA.locator('.yq-doc-collab-count').innerText()
      return t.includes('2 人') ? t : null
    })
    if (!bar) throw new Error('A 页没看到第 2 个人: ' + bar)
  })

  await check('内容同步 A→B：A 输入的字符出现在 B 的正文 DOM', async () => {
    await watchWrites(pageB)
    await typeInBlock(pageA, 1, '甲页输入')
    const ok = await waitFor(async () => (await blockText(pageB, 1)).includes('甲页输入'))
    if (!ok) throw new Error('B 页正文没有 A 输入的内容：' + (await blockText(pageB, 1)))
  })

  await check('远端内容会落盘但有节流：不是每条消息都写一次', async () => {
    /**
     * 早先这里断言「B 一次都没写盘」，理由是"避免两个标签页互相写盘"。
     * 接入 CRDT 后这个假设站不住了：合并是收敛的，两边落盘内容一致，
     * 不存在互相覆盖；而【不落盘】的真实后果是合并结果只活在内存里、刷新即丢。
     * 所以改成走 commit（有 400ms 防抖），并把断言改为"有节流"：
     * 发 3 次编辑，落地次数应当明显少于消息数。
     */
    await watchWrites(pageB)
    const base = await readWrites(pageB)
    for (const t of ['甲甲', '页页', '输入输入']) {
      await typeInBlock(pageA, 1, t)
      await pageA.waitForTimeout(120)
    }
    await pageA.waitForTimeout(900) // 越过 400ms 防抖
    const n = (await readWrites(pageB)) - base
    if (n === 0) throw new Error('B 收到远端内容后一次都没落盘 —— 刷新会丢合并结果')
    if (n >= 3) throw new Error(`落盘没有节流：3 次编辑落地 ${n} 次`)
    console.log(`   3 次远端编辑合并为 ${n} 次落盘`)
  })

  await check('内容同步 B→A：B 输入的字符出现在 A 的正文 DOM', async () => {
    await watchWrites(pageA)
    await typeInBlock(pageB, 5, '乙页输入')
    const ok = await waitFor(async () => (await blockText(pageA, 5)).includes('乙页输入'))
    if (!ok) throw new Error('A 页正文没有 B 输入的内容：' + (await blockText(pageA, 5)))
  })


  await check('真实光标：A 渲染出 B（陈小满）的光标竖线与名字标签', async () => {
    // B 在第 3 个块里落一个真实选区（selectionchange → 广播）
    const el = pageB.locator('.yq-block-text').nth(3)
    await el.click()
    await pageB.keyboard.press('End')
    await pageB.keyboard.down('Shift')
    for (let i = 0; i < 4; i++) await pageB.keyboard.press('ArrowLeft')
    await pageB.keyboard.up('Shift')

    const carets = await waitFor(async () => {
      const n = await pageA.locator('.yq-collab-caret').count()
      return n >= 1 ? n : 0
    })
    if (!carets) throw new Error('A 页没有渲染出 B 的光标')
    const labels = await pageA.locator('.yq-collab-label').allInnerTexts()
    if (!labels.some((t) => t.includes('陈小满'))) {
      throw new Error('A 页光标标签不是 B 的成员名: ' + JSON.stringify(labels))
    }
    await pageA.screenshot({ path: `${OUT}/01-A-sees-B-cursor.png` })
  })

  await check('光标是「别人的」：A 自己不画自己的光标', async () => {
    const mine = await pageA.locator('.yq-collab-label').allInnerTexts()
    if (mine.some((t) => t.includes('林知远'))) {
      throw new Error('A 页把自己的光标也画出来了: ' + JSON.stringify(mine))
    }
  })

  await check('B 离开文档 → A 立刻清掉它的光标并回到 1 人', async () => {
    await pageB.goto(`${BASE}/#/`, { waitUntil: 'networkidle' })
    const gone = await waitFor(async () => {
      const n = await pageA.locator('.yq-collab-caret').count()
      const bar = await pageA.locator('.yq-doc-collab-count').innerText()
      return n === 0 && bar.includes('1 人')
    })
    if (!gone) {
      const n = await pageA.locator('.yq-collab-caret').count()
      const bar = await pageA.locator('.yq-doc-collab-count').innerText()
      throw new Error(`B 走了但 A 还留着光标(${n}) / ${bar}`)
    }
  })

  await check('直接关掉标签页（beforeunload/pagehide）→ A 也清掉', async () => {
    // 重新开一个 B 进来放光标，这次用「硬关闭」而不是路由跳转
    pageB = await ctx.newPage()
    watch(pageB, 'B2')
    await pageB.goto(`${BASE}/#/`, { waitUntil: 'networkidle' })
    await become(pageB, 'u2')
    await pageB.goto(`${BASE}${DOC}`, { waitUntil: 'networkidle' })
    await pageB.waitForSelector('.yq-block-text')
    const el = pageB.locator('.yq-block-text').nth(2)
    await el.click()
    await pageB.keyboard.press('End')

    const seen = await waitFor(async () => (await pageA.locator('.yq-collab-caret').count()) >= 1)
    if (!seen) throw new Error('A 页没看到重开的 B 的光标')

    await pageB.close()
    const gone = await waitFor(async () => (await pageA.locator('.yq-collab-caret').count()) === 0, 5000)
    if (!gone) throw new Error('B 的标签页关了，A 的光标还挂着（等待心跳超时兜底）')
  })

  /* ---- 以下两条是慢速检查：分别要等 15s 淡出与 20s 心跳超时 ---- */

  let pageC = null
  await check('准备：再开一个 B3 进来放光标（用于慢速计时）', async () => {
    pageC = await ctx.newPage()
    watch(pageC, 'B3')
    await pageC.goto(`${BASE}/#/`, { waitUntil: 'networkidle' })
    await become(pageC, 'u2')
    await pageC.goto(`${BASE}${DOC}`, { waitUntil: 'networkidle' })
    await pageC.waitForSelector('.yq-block-text')
    const el = pageC.locator('.yq-block-text').nth(4)
    await el.click()
    await pageC.keyboard.press('End')
    const seen = await waitFor(async () => (await pageA.locator('.yq-collab-caret').count()) >= 1)
    if (!seen) throw new Error('A 页没看到 B3 的光标')
    const idle = await pageA.locator('.yq-collab-cursor.is-idle').count()
    if (idle) throw new Error('刚动的光标不该是 idle')
  })

  await check('15 秒无活动 → 远端光标整体淡出（IDLE_MS）', async () => {
    const faded = await waitFor(
      async () => (await pageA.locator('.yq-collab-cursor.is-idle').count()) >= 1,
      20_000,
      500,
    )
    if (!faded) throw new Error('15s 后远端光标仍然是活跃态')
    // 淡出 ≠ 离线：他还在场，协作条的人数不变
    const bar = await pageA.locator('.yq-doc-collab-count').innerText()
    if (!bar.includes('2 人')) throw new Error('淡出后人数不该变: ' + bar)
  })

  await check('心跳超时（20s）→ 视为离线，摘掉光标与头像', async () => {
    // 模拟「标签页还在但已经收不到消息」（崩溃 / 断网 / 被系统挂起）
    await pageC.evaluate(() => {
      BroadcastChannel.prototype.postMessage = function () {}
    })
    const dropped = await waitFor(
      async () => {
        const c = await pageA.locator('.yq-collab-caret').count()
        const bar = await pageA.locator('.yq-doc-collab-count').innerText()
        return c === 0 && bar.includes('1 人')
      },
      30_000,
      500,
    )
    if (!dropped) {
      const c = await pageA.locator('.yq-collab-caret').count()
      const bar = await pageA.locator('.yq-doc-collab-count').innerText()
      throw new Error(`心跳超时后仍视为在线：光标 ${c} 个 / ${bar}`)
    }
    await pageC.close()
  })

  await pageA.screenshot({ path: `${OUT}/02-A-final.png` })

  await check('演示模式开关：默认关，打开后单开也有假协作者，关掉即散场', async () => {
    const demoSwitch = pageA.locator('.yq-doc-collab-switch').nth(1).locator('.yq-switch')
    const label = await pageA.locator('.yq-doc-collab-switch').nth(1).innerText()
    if (!label.includes('演示')) throw new Error('第二个开关不是演示模式: ' + label)
    if ((await pageA.locator('.yq-collab-caret').count()) !== 0) throw new Error('演示模式默认应该是关的')

    await demoSwitch.click()
    const appeared = await waitFor(async () => (await pageA.locator('.yq-collab-caret').count()) >= 1, 3000, 200)
    if (!appeared) throw new Error('打开演示模式后没有假协作者光标')
    await pageA.screenshot({ path: `${OUT}/03-A-demo-mode.png` })

    await demoSwitch.click()
    const gone = await waitFor(async () => (await pageA.locator('.yq-collab-caret').count()) === 0, 3000, 200)
    if (!gone) throw new Error('关掉演示模式后假协作者还留着')
  })

  await browser.close()
  server.close()

  const failed = steps.filter((s) => !s.ok)
  console.log('\n' + '='.repeat(56))
  console.log(`通过 ${steps.length - failed.length}/${steps.length}`)
  if (failed.length) {
    console.log('\n失败项：')
    failed.forEach((f) => console.log(`  ✗ ${f.label}\n    ${f.errs.join('\n    ')}`))
  }
  console.log(`\n截图目录: ${OUT}`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error('自验脚本崩了:', e)
  try { server.close() } catch {}
  process.exit(1)
})
