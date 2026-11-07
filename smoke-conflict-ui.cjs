/**
 * 冲突可视化：协作条上的「N 处并发编辑已自动合并」
 * ============================================================
 * CRDT 合并是静默的。以前 lastConflicts 只是 collaboration.ts 里的一个闭包变量，
 * 记下来就没人看 —— 用户完全不知道「刚才这里被动过」。
 * 这里验的是整条链路：
 *   ① 制造一次真并发合并 → 协作条出现提示
 *   ② 展开后能逐条看到：哪一块 / 谁的编辑 / 冲突几处 / 什么时间
 *   ③ 「查看该位置」能真的滚到那个块，并把它闪一下
 *   ④ 「忽略」能清空
 *
 * 并发怎么造：把 op 消息扣在发送方，等两边都改完再一起放行
 * （见 holdOps 的注释）——这正是真实世界「消息在路上交叉」的样子，
 * 比 Promise.all 撞定时器稳得多。
 *
 * 前置：先 `npm run build`（脚本跑 dist）。
 * 跑法：node smoke-conflict-ui.cjs
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

const PORT = 7100 + Math.floor(Math.random() * 90)
const BASE = `http://localhost:${PORT}`
const DOC = '/#/book/b1/doc/d5'
// ⚠️ 这里原来写死的是 '/workspace/yuque/.smoke…' —— Linux 开发环境的残留。
//    在 Windows 上它被解析成 `H:\workspace\yuque\.smoke`，**截图落在工作区外面、
//    盘根下面**，而 .gitignore 里明明列着这些目录名（本来的意图就是放在项目根）。
//    实测一次就堆了 15.1MB，而且**没有任何地方会报**。
//    截图是手动套件唯一的失败取证手段，落在人不会去看的地方，
//    「失败了但看不出为什么」和「套件没跑」长得一模一样。
//    所以改成脚本所在目录；要放别处用 SMOKE_OUT 覆盖。
const OUT = process.env.SMOKE_OUT || path.join(__dirname, '.smoke-conflict-ui')
fs.mkdirSync(OUT, { recursive: true })

let fail = 0
const errors = []
const t = async (name, fn) => {
  const before = errors.length
  try {
    await fn()
    const errs = errors.slice(before)
    if (errs.length) throw new Error(errs.join(' | '))
    console.log(`✅ ${name}`)
  } catch (e) {
    fail++
    console.log(`❌ ${name}\n   ${e.message}`)
  }
}
const eq = (name, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${name}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
}

const waitFor = async (fn, ms = 6000, step = 120) => {
  const t0 = Date.now()
  for (;;) {
    let v
    try { v = await fn() } catch { v = null }
    if (v) return v
    if (Date.now() - t0 > ms) return v
    await new Promise((r) => setTimeout(r, step))
  }
}

const watch = (page, tag) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[${tag}] ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`[${tag} pageerror] ${e.message}`))
}

const become = (page, memberId) =>
  page.evaluate((id) => {
    const st = window.__yqStore
    const m = st.getState().members.find((x) => x.id === id)
    st.setState({ currentUser: m, cursors: [] })
  }, memberId)

let A, B
/** 扣住 op 消息，制造在途延迟（详见文件头注释） */
const holdOps = (page) =>
  page.evaluate(() => {
    if (!window.__holdPatched) {
      window.__holdPatched = true
      const orig = BroadcastChannel.prototype.postMessage
      window.__origPost = orig
      BroadcastChannel.prototype.postMessage = function (msg) {
        if (window.__hold && msg && msg.kind === 'op') {
          window.__held.push([this, msg])
          return
        }
        return orig.call(this, msg)
      }
    }
    window.__hold = true
    window.__held = []
  })
const releaseOps = (page) =>
  page.evaluate(() => {
    window.__hold = false
    const held = window.__held || []
    window.__held = []
    for (const [ch, msg] of held) window.__origPost.call(ch, msg)
    return held.length
  })

/** 在第 i 个正文块末尾追加文字（等价于用户在那儿打字） */
const appendText = (page, i, text) =>
  page.evaluate(([idx, s]) => {
    const st = window.__yqStore
    const blocks = st.getState().docs.d5.blocks.map((b, j) =>
      j === idx ? { ...b, text: b.text + s, html: undefined } : b)
    st.getState().setDocBlocks('d5', blocks)
  }, [i, text])

/** store 里的合并记录（断言真相：UI 只是它的一层皮） */
const records = (page) =>
  page.evaluate(() => JSON.parse(JSON.stringify(window.__yqStore.getState().collabConflicts || [])))

;(async () => {
  await new Promise((r) => server.listen(PORT, r))
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  A = await ctx.newPage()
  B = await ctx.newPage()
  watch(A, 'A')
  watch(B, 'B')

  await A.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
  await A.waitForSelector('.yq-dash-greeting', { timeout: 20000 })
  await A.evaluate(() => localStorage.clear())
  await A.reload({ waitUntil: 'domcontentloaded' })
  await A.waitForSelector('.yq-dash-greeting', { timeout: 20000 })
  await B.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
  await B.waitForSelector('.yq-dash-greeting', { timeout: 20000 })
  await become(B, 'u2')
  await A.goto(`${BASE}${DOC}`, { waitUntil: 'domcontentloaded' })
  await B.goto(`${BASE}${DOC}`, { waitUntil: 'domcontentloaded' })
  await A.waitForSelector('.yq-block-text')
  await B.waitForSelector('.yq-block-text')
  await A.waitForTimeout(1500)

  // 记住第 3 块（.nth(2)）的位置与 id，后面要验「滚过去了」
  const targetId = await A.evaluate(() => window.__yqStore.getState().docs.d5.blocks[2].id)

  await t('制造一次真并发合并（同一个块、同一处）', async () => {
    await holdOps(A)
    await holdOps(B)
    await appendText(A, 2, '甲改')
    await appendText(B, 2, '乙改')
    await A.waitForTimeout(400)
    const [na, nb] = [await releaseOps(A), await releaseOps(B)]
    if (!na || !nb) throw new Error(`有一边没发出 op（A=${na} B=${nb}）`)
    const got = await waitFor(async () => {
      const [ra, rb] = [await records(A), await records(B)]
      return ra.length && rb.length ? { ra, rb } : null
    })
    if (!got) throw new Error('两端都没有产生合并记录')
    console.log(`   A 端: ${got.ra[0].where}｜${got.ra[0].actorName}｜冲突 ${got.ra[0].count} 处`)
  })

  await t('合并记录挂在 store 上（不再是闭包变量，React 读得到）', async () => {
    const list = await records(A)
    eq('  至少一条', list.length >= 1, true)
    const r = list[0]
    for (const k of ['id', 'docId', 'target', 'blockId', 'where', 'actorId', 'actorName', 'count', 'at', 'highlightUntil']) {
      if (!(k in r)) throw new Error(`记录缺字段 ${k}`)
    }
    eq('  目标是正文块', r.target, 'block')
    eq('  指向第 3 块', r.blockId, targetId)
    if (typeof r.count !== 'number' || r.count < 1) throw new Error('冲突处数不对: ' + r.count)
  })

  await t('协作条出现「N 处并发编辑已自动合并」', async () => {
    const bar = await waitFor(async () => {
      const n = await A.locator('.yq-collab-conflict').count()
      if (!n) return null
      return {
        title: await A.locator('.yq-collab-conflict-title').innerText(),
        hasBar: await A.locator('.yq-doc-collabbar.has-conflict').count(),
      }
    })
    if (!bar) throw new Error('协作条上没有出现合并提示')
    if (!/^1 处并发编辑已自动合并$/.test(bar.title.trim())) throw new Error('提示文案不对: ' + bar.title)
    eq('  协作条进入「有冲突」态（会变高让提示展开）', bar.hasBar, 1)
  })

  await t('展开后能看到详情：位置 / 谁合并的 / 几处 / 时间', async () => {
    // 新合并会自动展开；已经展开就不用再点
    if (!(await A.locator('.yq-collab-conflict-body').count())) {
      await A.locator('.yq-collab-conflict-head').click()
      await A.waitForSelector('.yq-collab-conflict-body')
    }
    const item = await A.locator('.yq-collab-conflict-item').first().innerText()
    console.log(`   详情: ${item.replace(/\n/g, ' · ')}`)
    if (!item.includes('正文块')) throw new Error('没写清是哪个块: ' + item)
    if (!item.includes('陈小满')) throw new Error('没写清是谁的编辑合并进来了: ' + item)
    if (!/冲突 1 处/.test(item)) throw new Error('没写清冲突几处: ' + item)
    if (!/\d{2}:\d{2}:\d{2}/.test(item)) throw new Error('没写时间: ' + item)
    eq('  有一条记录', await A.locator('.yq-collab-conflict-item').count(), 1)
  })

  await t('被合并的块会高亮（约 2 秒后淡出）', async () => {
    // 高亮是合并那一刻就挂上的；这里重放一次跳转来验它确实会挂、也确实会掉
    await A.locator('.yq-collab-conflict-act').first().click()
    await A.waitForSelector(`[data-block-id="${targetId}"].yq-collab-flash`, { timeout: 3000 })
    const gone = await waitFor(
      async () => (await A.locator(`[data-block-id="${targetId}"].yq-collab-flash`).count()) === 0,
      5000,
      150,
    )
    if (!gone) throw new Error('高亮没有自动淡出（class 一直挂着）')
  })

  await t('「查看该位置」能真的滚到那个块', async () => {
    // 先滚到很远的地方，保证「滚过去」这件事是可观测的
    await A.evaluate(() => { document.querySelector('.yq-doc-scroll')?.scrollTo({ top: 0 }) })
    await A.waitForTimeout(400)
    const before = await A.evaluate((id) => {
      const el = document.querySelector(`[data-block-id="${id}"]`)
      return el ? el.getBoundingClientRect().top : null
    }, targetId)
    if (before === null) throw new Error('目标块不在 DOM 里')
    const wasInView = before > 0 && before < 900

    await A.locator('.yq-collab-conflict-act').first().click()
    await A.waitForTimeout(900) // 平滑滚动 + 高亮
    const after = await A.evaluate((id) => {
      const el = document.querySelector(`[data-block-id="${id}"]`)
      const r = el.getBoundingClientRect()
      return { top: r.top, h: window.innerHeight, flashing: el.classList.contains('yq-collab-flash') }
    }, targetId)
    if (!wasInView) throw new Error('前置条件不成立：目标块本来就在视口里，这条断言没意义')
    // 居中：允许 ±120px 的容差
    const center = after.top + 100
    if (Math.abs(center - after.h / 2) > 160) {
      throw new Error(`没滚到视口中间：top=${Math.round(after.top)} h=${after.h}`)
    }
    if (!after.flashing) throw new Error('跳转后没有高亮')
    console.log(`   滚动前 top=${Math.round(before)} → 滚动后 top=${Math.round(after.top)}（视口高 ${after.h}）`)
  })

  await t('「忽略」清空记录（store 与界面一起清）', async () => {
    await A.locator('.yq-collab-conflict-ignore').click()
    await A.waitForTimeout(300)
    eq('  store 里没了', (await records(A)).length, 0)
    eq('  界面上的提示也没了', await A.locator('.yq-collab-conflict').count(), 0)
    eq('  协作条回到一行', await A.locator('.yq-doc-collabbar.has-conflict').count(), 0)
    // 协作条本体还在（在场成员入口不能被一起干掉）
    eq('  协作成员入口还在', await A.locator('.yq-doc-collab-count').count(), 1)
  })

  await t('忽略只影响本端：另一端的提示还在（不是全局广播）', async () => {
    const n = await waitFor(async () => (await B.locator('.yq-collab-conflict').count()) > 0, 3000)
    if (!n) throw new Error('B 端的提示也没了 —— 说明「忽略」被误做成了广播')
  })

  await t('合并本身没被「忽略」影响：两页正文仍然一致', async () => {
    const txt = (p) => p.evaluate(() => window.__yqStore.getState().docs.d5.blocks.map((b) => [b.id, b.text]))
    const got = await waitFor(async () => {
      const [a, b] = [await txt(A), await txt(B)]
      return JSON.stringify(a) === JSON.stringify(b) ? a : null
    }, 4000)
    if (!got) {
      const [a, b] = [await txt(A), await txt(B)]
      const diff = a.map((x, i) => (x[1] === b[i]?.[1] ? null : `  #${i} ${x[0]}: A=${JSON.stringify(x[1])} B=${JSON.stringify(b[i]?.[1])}`)).filter(Boolean)
      throw new Error(`两页正文不一致\n${diff.join('\n') || '(块数不同) ' + a.length + ' vs ' + b.length}`)
    }
    /**
     * 两处改动落在**同一位置**（都追加在同一块末尾），本来就必须择一：
     * 硬要两处都留就是「把两段话拼在一起」，那不是合并，是制造新内容。
     * 底线是收敛 —— 两端字面一致，且留下的正是仲裁胜出的那一份。
     */
    const line = got.find(([id]) => id === targetId)
    if (!line) throw new Error('目标块不见了')
    if (!['三层结构甲改', '三层结构乙改'].includes(line[1])) {
      throw new Error(`仲裁结果既不是甲改也不是乙改：${JSON.stringify(line[1])}`)
    }
    console.log(`   收敛结果: ${line[1]}`)
  })

  await A.screenshot({ path: `${OUT}/A-合并提示.png` })
  await browser.close()
  server.close()
  console.log('\n' + '='.repeat(46) + `\n${fail === 0 ? '冲突可视化全部通过' : fail + ' 项失败'}`)
  console.log(`截图目录: ${OUT}`)
  process.exit(fail ? 1 : 0)
})()
