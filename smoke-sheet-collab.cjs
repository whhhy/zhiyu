/**
 * 文稿数据协同（sheet.set / card.set 走 CRDT）
 * ============================================================
 * 以前 CRDT 只覆盖 doc.blocks（正文块），doc.sheetData 是整段覆盖的：
 * 两个标签页同时改同一个工作表 / 数据表 / 画板，后写的把先写的整段顶掉。
 *
 * 这里验三件事：
 *   ① 同一张工作表改【不同单元格】→ 两处都在（逐格三路合并）
 *   ② 同一张工作表改【同一单元格】→ 收敛（按 (clock, actor) 仲裁），且记一条冲突
 *   ③ 看板卡片同时拖到【不同列】→ 两边都对（记录级 id 归并，互不干扰）
 *
 * 另加两条覆盖 doc.sheetData 之外的那一半：
 *   ④ 卡片块 data 改不同字段 → 两边都保留
 *   ⑤ 合并结果真的落盘（刷新还在）
 *
 * 前置：先 `npm run build`（脚本跑 dist）。
 * 跑法：node smoke-sheet-collab.cjs
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

const PORT = 7000 + Math.floor(Math.random() * 90)
const BASE = `http://localhost:${PORT}`
/** sheet=工作表 / d7=数据表 / d5=正文（卡片块在这里） */
const SHEET_DOC = '/#/book/b2/doc/t6'
const TABLE_DOC = '/#/book/b1/doc/d7'
const DOC_DOC = '/#/book/b1/doc/d5'
// ⚠️ 这里原来写死的是 '/workspace/yuque/.smoke…' —— Linux 开发环境的残留。
//    在 Windows 上它被解析成 `H:\workspace\yuque\.smoke`，**截图落在工作区外面、
//    盘根下面**，而 .gitignore 里明明列着这些目录名（本来的意图就是放在项目根）。
//    实测一次就堆了 15.1MB，而且**没有任何地方会报**。
//    截图是手动套件唯一的失败取证手段，落在人不会去看的地方，
//    「失败了但看不出为什么」和「套件没跑」长得一模一样。
//    所以改成脚本所在目录；要放别处用 SMOKE_OUT 覆盖。
const OUT = process.env.SMOKE_OUT || path.join(__dirname, '.smoke-sheet-collab')
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
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new Error(`${name}\n   期望 ${JSON.stringify(want)}\n   实际 ${JSON.stringify(got)}`)
  }
}

/** 轮询等条件成立（协同是异步的） */
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

/** 切成另一个成员（只改内存态，不写 localStorage） */
const become = (page, memberId) =>
  page.evaluate((id) => {
    const st = window.__yqStore
    const m = st.getState().members.find((x) => x.id === id)
    st.setState({ currentUser: m, cursors: [] })
  }, memberId)

/** 直接读 store 里的 doc.sheetData（断言真相，不看 DOM） */
const sheetOf = (page, docId) =>
  page.evaluate((id) => {
    const d = window.__yqStore.getState().docs[id]
    return JSON.parse(JSON.stringify(d.sheetData || {}))
  }, docId)

/** 第 ri 行第 ci 格的原始值 */
const cell = (sheet, ri, ci) => sheet?.sheets?.sheets?.[0]?.rows?.[ri]?.[ci]?.v

/** 直接改一格（走 store，等价于用户在单元格里打字后失焦） */
const setCell = (page, docId, ri, ci, v) =>
  page.evaluate(([id, r, c, val]) => {
    const st = window.__yqStore
    const doc = st.getState().docs[id]
    const sd = doc.sheetData
    const rows = sd.sheets.sheets[0].rows.map((row, i) =>
      row.map((cell, j) => (i === r && j === c ? { ...cell, v: val } : cell)))
    st.getState().updateDoc(id, {
      sheetData: { ...sd, sheets: { ...sd.sheets, sheets: sd.sheets.sheets.map((s, i) => (i === 0 ? { ...s, rows } : s)) } },
    })
  }, [docId, ri, ci, v])

/** 数据表里改一条记录的状态（等价于看板把卡片拖到某列） */
const setRecordStatus = (page, docId, rid, status) =>
  page.evaluate(([id, r, s]) => {
    const st = window.__yqStore
    const doc = st.getState().docs[id]
    const tb = doc.sheetData.table
    st.getState().updateDoc(id, {
      sheetData: { ...doc.sheetData, table: { ...tb, records: tb.records.map((x) => (x.id === r ? { ...x, status: s } : x)) } },
    })
  }, [docId, rid, status])

const recordStatus = (page, docId, rid) =>
  page.evaluate(([id, r]) => window.__yqStore.getState().docs[id].sheetData.table.records.find((x) => x.id === r)?.status, [docId, rid])

/** 卡片块的 data（投票 / 打卡这类） */
const cardData = (page, docId, blockId) =>
  page.evaluate(([id, b]) => JSON.parse(JSON.stringify(window.__yqStore.getState().docs[id].blocks.find((x) => x.id === b)?.data || {})), [docId, blockId])

const patchCardData = (page, docId, blockId, patch) =>
  page.evaluate(([id, b, p]) => {
    const st = window.__yqStore
    const blocks = st.getState().docs[id].blocks.map((x) => (x.id === b ? { ...x, data: { ...(x.data || {}), ...p } } : x))
    st.getState().setDocBlocks(id, blocks)
  }, [docId, blockId, patch])

/* ============================================================
   制造「真并发」
   ------------------------------------------------------------
   直接 Promise.all 两边一起改，测的是「谁先广播谁后收到」——
   结果取决于两个页面的定时器谁先跑，同一份代码两次跑可能一次有一次没有，
   拿它断言合并语义必然 flaky。
   所以这里显式制造在途延迟：把 op 消息扣在发送方，
   等两边都改完（各自的 op 都基于同一个基准生成了）再一起放行。
   这正是真实世界「两个人同时打字、消息在路上交叉」的样子。
   ============================================================ */
let A, B
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

/** 放行被扣下的 op，返回放了几条（0 说明这一边压根没产生 op） */
const releaseOps = (page) =>
  page.evaluate(() => {
    window.__hold = false
    const held = window.__held || []
    window.__held = []
    for (const [ch, msg] of held) window.__origPost.call(ch, msg)
    return held.length
  })

/** 两边各改一处 → 扣住双方 op → 放行。返回双方产生的 op 条数 */
async function concurrent(editA, editB) {
  await holdOps(A)
  await holdOps(B)
  await editA()
  await editB()
  // 等两边的 60ms 防抖都跑完，op 一定已经进了缓冲区
  await A.waitForTimeout(400)
  const [na, nb] = [await releaseOps(A), await releaseOps(B)]
  if (!na || !nb) throw new Error(`有一边没发出 op（A=${na} B=${nb}）`)
  return { na, nb }
}

;(async () => {
  await new Promise((r) => server.listen(PORT, r))
  const browser = await chromium.launch()
  // 同一个 context = 共享 localStorage + 共享 BroadcastChannel 频道
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

  /* ---------------- ① 工作表：不同单元格 ---------------- */
  await A.goto(`${BASE}${SHEET_DOC}`, { waitUntil: 'domcontentloaded' })
  await B.goto(`${BASE}${SHEET_DOC}`, { waitUntil: 'domcontentloaded' })
  await A.waitForSelector('[data-cell="0-0"] input')
  await B.waitForSelector('[data-cell="0-0"] input')
  await A.waitForTimeout(1200)

  await t('两页同时改同一张表的【不同单元格】→ 两处都在（DOM 上也看得见）', async () => {
    await concurrent(
      () => setCell(A, 't6', 1, 1, 'A改的名称'),
      () => setCell(B, 't6', 2, 1, 'B改的另一行'),
    )
    const got = await waitFor(async () => {
      const a = await sheetOf(A, 't6')
      const b = await sheetOf(B, 't6')
      if (cell(a, 1, 1) === 'A改的名称' && cell(b, 2, 1) === 'B改的另一行'
        && cell(a, 2, 1) === 'B改的另一行' && cell(b, 1, 1) === 'A改的名称') return { a, b }
      return null
    })
    if (!got) {
      const a = await sheetOf(A, 't6')
      throw new Error(`A 端第 2 行 = ${JSON.stringify(cell(a, 1, 1))} / 第 3 行 = ${JSON.stringify(cell(a, 2, 1))}`)
    }
    eq('  两端最终数据一致', JSON.stringify(got.a), JSON.stringify(got.b))
    // 别的格子不能被顺手改掉
    eq('  邻近格没被动过', cell(got.a, 0, 0), 'REQ-001')
  })

  await t('工作表同步是逐格的：另一页的单元格输入框里就是新值', async () => {
    const v = await B.locator('[data-cell="1-1"] input').inputValue()
    if (v !== 'A改的名称') throw new Error('B 的 DOM 上没看到 A 的改动，实际: ' + v)
    const v2 = await A.locator('[data-cell="2-1"] input').inputValue()
    if (v2 !== 'B改的另一行') throw new Error('A 的 DOM 上没看到 B 的改动，实际: ' + v2)
  })

  /* ---------------- ② 工作表：同一单元格 ---------------- */
  await t('两页同时改【同一单元格】→ 收敛到同一值，并记一条合并冲突', async () => {
    await concurrent(
      () => setCell(A, 't6', 4, 1, 'A写的内容'),
      () => setCell(B, 't6', 4, 1, 'B写的内容'),
    )
    const got = await waitFor(async () => {
      const a = cell(await sheetOf(A, 't6'), 4, 1)
      const b = cell(await sheetOf(B, 't6'), 4, 1)
      return a && a === b ? { a, b } : null
    })
    if (!got) {
      const a = cell(await sheetOf(A, 't6'), 4, 1)
      const b = cell(await sheetOf(B, 't6'), 4, 1)
      throw new Error(`没收敛：A=${a} B=${b}`)
    }
    if (!/^A写的内容$|^B写的内容$/.test(got.a)) throw new Error('仲裁结果既不是我也不是对方: ' + got.a)
    // 至少有一端应该记下这次冲突（另一端可能已经把对方的结果吸收成"因果可达"）
    const seen = await waitFor(async () => {
      for (const p of [A, B]) {
        const n = await p.locator('.yq-collab-conflict').count()
        if (n > 0) return await p.locator('.yq-collab-conflict-title').innerText()
      }
      return null
    }, 4000)
    if (!seen) throw new Error('两端都没有出现合并提示')
    console.log(`   仲裁结果: ${got.a}｜合并提示: ${seen}`)
  })

  /* ---------------- ③ 看板卡片拖到不同列 ---------------- */
  await A.goto(`${BASE}${TABLE_DOC}`, { waitUntil: 'domcontentloaded' })
  await B.goto(`${BASE}${TABLE_DOC}`, { waitUntil: 'domcontentloaded' })
  await A.waitForSelector('.yq-dt-bar')
  await B.waitForSelector('.yq-dt-bar')
  await A.waitForTimeout(1200)
  // 切到看板视图（工具条上的视图形态切换，两张表都走同一个 store 数据）
  for (const p of [A, B]) {
    await p.click('.yq-segmented button:has-text("看板")')
    await p.waitForSelector('.yq-dt-kanban')
  }
  await A.waitForTimeout(600)

  await t('看板：两张卡片同时拖到【不同列】→ 两边都对', async () => {
    const idA = await A.locator('.yq-dt-card').first().getAttribute('data-record-id')
    const idB = await B.locator('.yq-dt-card').nth(1).getAttribute('data-record-id')
    if (idA === idB) throw new Error('取到的不是两张不同的卡片')
    await concurrent(
      () => setRecordStatus(A, 'd7', idA, '已完成'),
      () => setRecordStatus(B, 'd7', idB, '评审中'),
    )
    const got = await waitFor(async () => {
      const [sa, sb] = [await recordStatus(A, 'd7', idA), await recordStatus(B, 'd7', idA)]
      const [ta, tb] = [await recordStatus(A, 'd7', idB), await recordStatus(B, 'd7', idB)]
      if (sa === '已完成' && sb === '已完成' && ta === '评审中' && tb === '评审中') return { sa, sb, ta, tb }
      return null
    })
    if (!got) {
      const dump = await A.evaluate(() => window.__yqStore.getState().docs.d7.sheetData.table.records.map((r) => `${r.id}:${r.status}`))
      throw new Error(`状态没同步：${JSON.stringify(dump)}`)
    }
    eq('  A 拖的卡片在两页都是「已完成」', [got.sa, got.sb], ['已完成', '已完成'])
    eq('  B 拖的卡片在两页都是「评审中」', [got.ta, got.tb], ['评审中', '评审中'])
  })

  await t('看板：同一张卡片同时拖到【不同列】→ 收敛 + 记冲突', async () => {
    const id = await A.locator('.yq-dt-card').first().getAttribute('data-record-id')
    await concurrent(
      () => setRecordStatus(A, 'd7', id, '待开始'),
      () => setRecordStatus(B, 'd7', id, '进行中'),
    )
    const got = await waitFor(async () => {
      const a = await recordStatus(A, 'd7', id)
      const b = await recordStatus(B, 'd7', id)
      return a && a === b ? { a, b } : null
    })
    if (!got) throw new Error('同一张卡片并发拖拽后没收敛')
    if (!['待开始', '进行中'].includes(got.a)) throw new Error('仲裁结果不合法: ' + got.a)
    console.log(`   仲裁结果: ${got.a}`)
  })

  await t('数据表：两端最终记录集完全一致（收敛）', async () => {
    const dump = (p) => p.evaluate(() => JSON.stringify(
      window.__yqStore.getState().docs.d7.sheetData.table.records.map((r) => [r.id, r.status])))
    const got = await waitFor(async () => {
      const [a, b] = [await dump(A), await dump(B)]
      return a === b ? a : null
    }, 5000)
    if (!got) throw new Error('两页记录集不一致')
  })

  /* ---------------- ④ 卡片 data：不同字段 ---------------- */
  await A.goto(`${BASE}${DOC_DOC}`, { waitUntil: 'domcontentloaded' })
  await B.goto(`${BASE}${DOC_DOC}`, { waitUntil: 'domcontentloaded' })
  await A.waitForSelector('.yq-block-text')
  await B.waitForSelector('.yq-block-text')
  await A.waitForTimeout(1500)
  // 找一张投票卡片：没有就现插一张
  const voteId = await A.evaluate(() => {
    const st = window.__yqStore
    const doc = st.getState().docs.d5
    const exist = doc.blocks.find((b) => b.data?.cardId === 'vote')
    if (exist) return exist.id
    const id = 'vote_probe_1'
    st.getState().setDocBlocks('d5', [
      ...doc.blocks,
      { id, type: 'card', text: '', data: { cardId: 'vote', q: '选哪个', myVote: '', closed: false, options: [{ id: 'o1', text: '方案 A', votes: [] }, { id: 'o2', text: '方案 B', votes: [] }] } },
    ])
    return id
  })
  await A.waitForTimeout(1200)
  await B.waitForTimeout(300)

  await t('卡片 data：两边改【不同字段】→ 两边都保留（投票项 + 是否结束）', async () => {
    await concurrent(
      () => patchCardData(A, 'd5', voteId, { myVote: 'o1' }),
      () => patchCardData(B, 'd5', voteId, { closed: true }),
    )
    const got = await waitFor(async () => {
      const a = await cardData(A, 'd5', voteId)
      const b = await cardData(B, 'd5', voteId)
      return a.myVote === 'o1' && a.closed === true && b.myVote === 'o1' && b.closed === true ? { a, b } : null
    })
    if (!got) {
      const a = await cardData(A, 'd5', voteId)
      const b = await cardData(B, 'd5', voteId)
      throw new Error(`A=${JSON.stringify(a)}\n   B=${JSON.stringify(b)}`)
    }
  })

  await t('卡片 data：同一字段两边都改 → 收敛 + 记一条卡片冲突', async () => {
    await concurrent(
      () => patchCardData(A, 'd5', voteId, { q: 'A 改的问题' }),
      () => patchCardData(B, 'd5', voteId, { q: 'B 改的问题' }),
    )
    const got = await waitFor(async () => {
      const a = (await cardData(A, 'd5', voteId)).q
      const b = (await cardData(B, 'd5', voteId)).q
      return a && a === b ? { a, b } : null
    })
    if (!got) throw new Error('卡片字段并发后没收敛')
    if (!['A 改的问题', 'B 改的问题'].includes(got.a)) throw new Error('仲裁结果不合法: ' + got.a)
    const seen = await waitFor(async () => {
      for (const p of [A, B]) {
        if ((await p.locator('.yq-collab-conflict').count()) > 0) {
          return await p.locator('.yq-collab-conflict-item').last().innerText()
        }
      }
      return null
    }, 4000)
    if (!seen) throw new Error('卡片字段冲突没有出现在合并提示里')
    if (!seen.includes('投票')) throw new Error('合并提示没写清是哪张卡片: ' + seen.replace(/\n/g, ' '))
    console.log(`   合并提示: ${seen.replace(/\n/g, ' · ')}`)
  })

  /* ---------------- ⑤ 落盘 ---------------- */
  await t('合并结果真的落盘了（刷新后还在）', async () => {
    await A.waitForTimeout(700)
    const before = JSON.stringify(await sheetOf(A, 't6'))
    await A.goto(`${BASE}${SHEET_DOC}`, { waitUntil: 'domcontentloaded' })
    await A.waitForSelector('[data-cell="0-0"] input')
    await A.waitForTimeout(600)
    const after = JSON.stringify(await sheetOf(A, 't6'))
    if (before !== after) throw new Error('刷新后工作表数据变了')
  })

  await A.screenshot({ path: `${OUT}/A-工作表.png`, fullPage: false })
  await B.screenshot({ path: `${OUT}/B-数据表.png`, fullPage: false })
  await browser.close()
  server.close()
  console.log('\n' + '='.repeat(46) + `\n${fail === 0 ? '文稿数据协同全部通过' : fail + ' 项失败'}`)
  console.log(`截图目录: ${OUT}`)
  process.exit(fail ? 1 : 0)
})()
