/*
 * 「一条还没有任何回复的评论，刷新之后打开评论/划词评论面板」（2026-10-12 补）
 *
 * ============================================================
 * 补的是什么：一条**必崩**的路
 * ============================================================
 * 评论面板 `c.replies.length`、划词评论面板 `c.replies.map`，
 * 两处都没有兜底。而服务端表里**根本没有 replies 这一列**
 * （回复是 comment_replies / selection_comment_replies 两张独立行表），
 * 所以刷新之后回来的父评论天生就没这个键。
 *
 * 实测（`_probe-panel-crash.mjs`，修复前）：
 *     服务端划词评论：1 | 有 replies 键吗：false
 *     服务端评论：1 | 有 replies 键吗：false
 *     评论面板打开了：false
 *     异常：Cannot read properties of undefined (reading 'length')
 *     划词面板打开了：false
 *     异常：Cannot read properties of undefined (reading 'map')
 *
 * 为什么一直没被发现：**种子数据里每条评论都带至少一条回复**。
 * 于是「`replies` 一定会被建出来」在演示数据上永远成立 ——
 * 这套判据必须自己造一条零回复的评论才算真的验过。
 *
 * ============================================================
 * 三条做法，两道防线的分工（别把它们说成一样强）
 * ============================================================
 * ① 边界归一（`nestReplies` 让每条父评论都带上 `replies: []`）—— **可观测、会被红**
 * ② 渲染兜底（两个面板 `(c.replies || [])`）—— **不可观测**
 *
 * 破坏对照实测：回退①，下面「每条…的 replies 都是数组」两条立刻红；
 * 而回退②，套件**一条都不红** —— 因为①已经把形状补齐了，
 * `c.replies` 必然是数组，崩不了。
 *
 * 所以②是**纯冗余层**：它的价值只在「将来某条新路绕过①」时兜住白屏，
 * 而那种情况要靠下面的判据去发现，别指望②自己会报警。
 * 这里不写一条去死盯 `|| []` 字面量的判据 —— 那是拿「钉住当前长相」
 * 冒充「钉住不变式」，源码一改写法就红一片。
 *
 * 因此判据必须覆盖**两条进数据的路**，而不只是刷新这一条：
 *   · 刷新（bootstrap → nestReplies）—— 形状 + 面板
 *   · 增量（另一个客户端发言 → 轮询 → mergeReplies）—— 同上
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.COMMENT_REPLIES_PORT || await freePort()
const DB = 'data/_cmtrep.db'
const BASE = `http://127.0.0.1:${PORT}`

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着删 */ } }
}
if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在跑。自起服务会打错目标，结果不可信。`)
  process.exit(1)
}
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB },
  stdio: ['ignore', 'ignore', 'ignore'],
})
let up = false
for (let i = 0; i < 40 && !up; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { if ((await fetch(`${BASE}/api/health`)).ok) up = true } catch { /* 还没起 */ }
}
if (!up) { console.error('服务没起来'); srv.kill(); process.exit(1) }

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

/**
 * 打开评论面板。
 *
 * 那个按钮是 `setCommentOpen((v) => !v)` —— **开关**，不是「打开」。
 * 面板已经开着的时候再点一下是把它关掉，于是 `innerText` 读出来是空的，
 * 看着就像「这条评论没渲染出来」。第一版就栽在这儿。
 */
const ensureCommentPanel = async (p) => {
  if (!(await p.evaluate(() => !!document.querySelector('.yq-comment')))) {
    await p.locator('.yq-doc-comment-btn').first().click({ timeout: 8000 })
  }
  await p.waitForTimeout(1200)
}

const ZERO_C = '一条还没有任何回复的评论'
const WITH_R_C = '这条下面会有人回复'
const REPLY_T = '第一条回复'
const ZERO_S = '一条还没有回复的划词评论'

try {
  const br = await chromium.launch()
  try {
    const p = await (await br.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    const errs = []
    p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 90)))

    await p.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-login-card', { timeout: 25000 })
    await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
    await p.fill('.yq-login-card input[type="password"]', 'yuque@2026')
    await p.click('.yq-login-submit')
    await p.waitForSelector('.yq-app', { timeout: 30000 })
    await p.waitForTimeout(1800)
    const token = await p.evaluate(() => localStorage.getItem('yq_token'))
    const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' }

    /* ---------- 自建「零回复」的评论与划词评论 ---------- */
    const made = await p.evaluate(
      async ([zero, withR, replyT, zeroS]) => {
        const s0 = window.__yqStore.getState()
        const b = s0.createBook('s1', '零回复面板 ' + Date.now().toString(36))
        const d = window.__yqStore.getState().createDoc(b, null, '零回复探针')
        const s1 = window.__yqStore.getState()
        s1.setDocBlocks(d, [...s1.docs[d].blocks, { id: 'bk_p1', type: 'p', text: '可以引用的那一段。' }])
        const s2 = window.__yqStore.getState()
        s2.addComment(d, zero)                                   // ★ 零回复
        const parentId = window.__yqStore.getState().comments[d].slice(-1)[0].id
        s2.addComment(d, withR)                                  // 有回复
        const withRId = window.__yqStore.getState().comments[d].slice(-1)[0].id
        window.__yqStore.getState().addReply(d, withRId, replyT)
        window.__yqStore.getState().addSelectionComment(d, '可以引用的那一段。', 'bk_p1', zeroS)
        return { b, d, parentId, withRId }
      },
      [ZERO_C, WITH_R_C, REPLY_T, ZERO_S],
    )
    await p.waitForTimeout(5000)

    /* ---------- 基准：服务端确实没有 replies 这一列 ---------- */
    console.log('\n== 基准：服务端回来的行本来就没有 replies 键 ==')
    {
      const boot = await (await p.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
      const mine = (boot.data.comments || []).filter((c) => c.docId === made.d)
      const sc = (boot.data.selectionComments || []).filter((c) => c.docId === made.d)
      ok(mine.length === 2, `服务端收到了 2 条评论（实到 ${mine.length}）`)
      ok(sc.length === 1, `服务端收到了 1 条划词评论（实到 ${sc.length}）`)
      const bare = mine.filter((c) => !('replies' in c))
      // 注意是「两条都没有」，不是「只有零回复那条没有」：
      // 服务端表里压根没有 replies 这一列，带回复的那条也是从另一张行表里现挂上去的。
      // 区别在于 nestReplies 能不能从 byParent 里给它补上键 ——
      // 零回复那条补不上（byParent 里没有它的条目），于是 became undefined。
      ok(bare.length === 2, `两条评论在服务端都没有 replies 键（实到 ${bare.length}）——这一列根本不存在`)
      ok(sc.every((c) => !('replies' in c)), '划词评论同样没有这个键')
      ok(
        boot.data.commentReplies?.some((r) => r.commentId === made.withRId),
        '带回复的那条，它的回复在**另一张行表**里作为独立行存在',
      )
      ok(
        !boot.data.commentReplies?.some((r) => r.commentId === made.parentId),
        '零回复那条在回复表里一条都没有（这就是补不上键的那条）',
      )
    }

    /* ---------- 刷新，看两个面板会不会崩 ---------- */
    console.log('\n== 刷新之后打开两个面板 ==')
    errs.length = 0
    await p.reload({ waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-app', { timeout: 25000 })
    await p.goto(`${BASE}/#/book/${made.b}/doc/${made.d}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-app', { timeout: 25000 })
    await p.waitForTimeout(4000)

    /* ---------- ① 边界归一：store 形状（回退归一修复就红） ---------- */
    {
      const shape = await p.evaluate((d) => {
        const s = window.__yqStore.getState()
        const cs = s.comments[d] || []
        const ss = s.selectionComments[d] || []
        return {
          n: cs.length, sn: ss.length,
          bad: cs.filter((c) => !Array.isArray(c.replies)).length,
          sbad: ss.filter((c) => !Array.isArray(c.replies)).length,
        }
      }, made.d)
      ok(shape.n === 2, `store 里两条评论都在（实到 ${shape.n}）`)
      ok(shape.sn === 1, `store 里那条划词评论也在（实到 ${shape.sn}）`)
      ok(shape.bad === 0, `每条评论的 replies 都是数组（不合规 ${shape.bad} 条）`)
      ok(shape.sbad === 0, `每条划词评论的 replies 都是数组（不合规 ${shape.sbad} 条）`)
    }

    /* ---------- ② 渲染兜底：面板不崩（回退渲染兜底就红） ---------- */
    {
      const openComment = async () => {
        await ensureCommentPanel(p)
      }
      await openComment()
      ok(await p.evaluate(() => !!document.querySelector('.yq-comment')), '评论面板打开了')
      const txt = await p.evaluate(() => document.querySelector('.yq-comment')?.innerText || '')
      ok(txt.includes(ZERO_C), '零回复的那条渲染出来了（不是只有「不崩」的空白面板）')
      ok(txt.includes(REPLY_T), '带回复的那条，连回复一起渲染出来了')
      ok(errs.length === 0, '评论面板全程没有异常', errs.join(' | '))
    }

    errs.length = 0
    {
      await p.locator('.yq-doc-bar-right button', { hasText: '✎' }).first().click({ timeout: 8000 })
      await p.waitForTimeout(1200)
      ok(await p.evaluate(() => !!document.querySelector('.yq-selpanel')), '划词评论面板打开了')
      const stxt = await p.evaluate(() => document.querySelector('.yq-selpanel')?.innerText || '')
      ok(stxt.includes(ZERO_S), '零回复的划词评论渲染出来了')
      ok(errs.length === 0, '划词评论面板全程没有异常', errs.join(' | '))
    }

    /* ---------- 增量那条路：另一个客户端发言，不刷新也要接得住 ---------- */
    console.log('\n== 增量：别处新发的评论，轮询接进来之后形状还对不对 ==')
    {
      const INCR = '这是另一个客户端刚发的，还没有任何回复'
      const p2 = await (await br.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
      await p2.goto(`${BASE}/#/book/${made.b}/doc/${made.d}`, { waitUntil: 'domcontentloaded' })
      await p2.waitForSelector('.yq-login-card', { timeout: 25000 }).catch(() => { })
      if (await p2.locator('.yq-login-card input[autocomplete="username"]').count()) {
        await p2.fill('.yq-login-card input[autocomplete="username"]', 'admin')
        await p2.fill('.yq-login-card input[type="password"]', 'yuque@2026')
        await p2.click('.yq-login-submit')
      }
      await p2.waitForSelector('.yq-app', { timeout: 30000 })
      await p2.waitForTimeout(2500)
      await p2.evaluate(
        async ([d, t]) => { await window.__yqStore.getState().addComment(d, t) },
        [made.d, INCR],
      )
      await p2.waitForTimeout(6000)          // 等它推上去

      // 页面 A 只靠 8 秒轮询接（不刷新），顺便戳一下 visibilitychange 逼它立刻拉
      errs.length = 0
      let seen = false
      for (let i = 0; i < 24 && !seen; i++) {
        await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
        await p.waitForTimeout(1000)
        seen = await p.evaluate((t) => {
          const s = window.__yqStore.getState()
          return Object.values(s.comments).flat().some((c) => c.text === t)
        }, INCR)
      }
      ok(seen, '页面 A 没刷新也收到了别处新发的评论')
      if (seen) {
        const bad = await p.evaluate(
          (t) => {
            const s = window.__yqStore.getState()
            const all = Object.values(s.comments).flat()
            return {
              n: all.length,
              bad: all.filter((c) => !Array.isArray(c.replies)).length,
              mine: all.filter((c) => c.text === t)[0]?.replies?.length ?? -1,
            }
          },
          INCR,
        )
        ok(bad.bad === 0, `增量之后每条评论的 replies 仍是数组（共 ${bad.n} 条，不合规 ${bad.bad} 条）`)
        ok(bad.mine === 0, '刚进来的那条，replies 是空数组而不是 undefined')
        await ensureCommentPanel(p)
        const t2 = await p.evaluate(() => document.querySelector('.yq-comment')?.innerText || '')
        ok(t2.includes(INCR), '增量来的评论在面板里渲染出来了')
        ok(errs.length === 0, '增量之后面板依然没有异常', errs.join(' | '))
      }
      await p2.close()
    }
  } finally { await br.close() }
} catch (e) {
  fail++
  console.error('异常：', e.stack || e.message)
} finally {
  const exited = once(srv, 'exit')
  srv.kill()
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (!existsSync(f)) continue
    for (let i = 0; i < 5; i++) {
      try { rmSync(f, { force: true }); break } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)