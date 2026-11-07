/*
 * 实测：空间页的「空间动态」真的按空间过滤，且显示的是真实数据。
 *
 * ⚠️ 两条判据：
 *   ① 空空间 → 显示写明的空态，不是空白
 *   ② 有数据的空间 → 条数 > 0，且**每一条的 where（知识库名）都属于这个空间**
 *      后者是关键：只断言「有条目」的话，不带过滤的实现照样能过。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, mkdirSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.SPACE_FEED_E2E_PORT || await freePort()
const DB = 'data/_spacefeed.db'
const BASE = `http://127.0.0.1:${PORT}`
mkdirSync('docs/shots', { recursive: true })

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着 */ } }
}
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB },
  stdio: ['ignore', 'ignore', 'ignore'],
})
let up = false
for (let i = 0; i < 40 && !up; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { if ((await fetch(`${BASE}/api/health`)).ok) up = true } catch { /* 等 */ }
}
if (!up) { console.error('服务没起来'); srv.kill(); process.exit(1) }

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

try {
  const br = await chromium.launch()
  try {
    const p = await (await br.newContext({ viewport: { width: 1280, height: 900 } })).newPage()
    await p.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-login-card', { timeout: 25000 })
    await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
    await p.fill('.yq-login-card input[type="password"]', 'yuque@2026')
    await p.click('.yq-login-submit')
    await p.waitForSelector('.yq-app', { timeout: 30000 })
    await p.waitForTimeout(1500)

    /*
     * ⚠️ 必须挑**条目最少**的那个空间来验。
     *
     * 破坏对照实测：拿条目最多的空间验，**抓不住**。
     * 那个空间自己的条目就 ≥ 8 条，于是「过滤后的前 8 条」与
     * 「不过滤的全局前 8 条」**完全一样** —— 判据恒绿。
     *
     * 这和之前那些「判据看起来在做某件事、实际一件都没验到」是同一族：
     * 数字对上了不等于事情发生了。
     * 种子里有个个人空间（1 本书、0 个话题），用它才对得上「少」与「多」。
     */
    const target = await p.evaluate(() => {
      const s = window.__yqStore.getState()
      const nodeBook = new Map((s.nodes || []).map((n) => [n.docId, n.bookId]))
      const spaceOfBook = new Map((s.books || []).map((b) => [b.id, b.spaceId]))
      let best = null
      for (const sp of s.spaces || []) {
        let n = Object.values(s.docs || {}).filter((d) => spaceOfBook.get(nodeBook.get(d.id)) === sp.id).length
        for (const list of Object.values(s.comments || {})) {
          n += (list || []).filter((c) => spaceOfBook.get(nodeBook.get(c.docId)) === sp.id).length
        }
        n += (s.topics || []).filter((t) => t.spaceId === sp.id).length
        if (!best || n < best.n) best = { id: sp.id, name: sp.name, n }
      }
      return best
    })
    const spaceId = target.id
    ok(!!spaceId, `挑到了用于对照的空间：${target.name}（独立算出 ${target.n} 条）`)
    await p.goto(`${BASE}/#/space/${spaceId}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-space-hero', { timeout: 25000 })
    await p.waitForSelector('.yq-feed', { timeout: 15000 })
    await p.waitForTimeout(800)

    const feed = await p.evaluate(() => {
      const card = [...document.querySelectorAll('.yq-feed')].pop()
      const items = [...card.querySelectorAll('.yq-feed-item:not(.yq-feed-empty)')]
      return {
        total: items.length,
        empty: !!card.querySelector('.yq-feed-empty'),
        targets: items.map((i) => (i.querySelector('.yq-feed-target')?.textContent || '').trim()),
        wheres: items.map((i) => [...i.querySelectorAll('.yq-list-row-meta span')]
          .map((s) => s.textContent.trim())
          .filter((t) => t && !/前$|昨天|前天/.test(t))[0] || ''),
      }
    })

    /*
     * ⚠️ 判据：拿页面里**独立算**出来的「这个空间应有的条数」和实际显示的比。
     *
     * 为什么不能只看「每条的 where 都属于这个空间」：
     *   评论与话题条目**本来就没有 where**（buildFeed 里没给），
     *   而我又取的是 meta 行第一个 span —— 于是取到的是**时间**。
     *   那个判据看起来在验「过滤」，其实大部分条目根本没被验到。
     *
     * 为什么不能只看「有条目」：
     *   完全不过滤的实现（直接渲染工作台那 8 条）照样能过。
     */
    /*
     * ⚠️ 破坏对照抓到过：只比「条数」是不成立的判据。
     *   把 spaceId 去掉（= 不过滤，直接显示工作台那 8 条），
     *   数字照样对得上 —— 因为这个空间本身就有 8 条以上，
     *   截断之后「该有的」和「实际显示」撞成了同一个数。
     *
     * ⇒ 必须比**条目身份**：在页面里独立算出这个空间应有的那批标题，
     *   和实际渲染出来的逐条比对。不过滤时两批内容不同，立刻就露。
     */
    const expectedTargets = await p.evaluate((sid) => {
      const s = window.__yqStore.getState()
      const nodeBook = new Map((s.nodes || []).map((n) => [n.docId, n.bookId]))
      const spaceOfBook = new Map((s.books || []).map((b) => [b.id, b.spaceId]))
      const rows = []
      for (const d of Object.values(s.docs || {})) {
        if (!d?.id) continue
        const bid = nodeBook.get(d.id)
        if (spaceOfBook.get(bid) !== sid) continue
        rows.push({ at: Number(d.createdAt) || 0, t: d.title })
      }
      for (const list of Object.values(s.comments || {})) {
        for (const c of list || []) {
          const d = (s.docs || {})[c.docId]
          if (!d) continue
          const bid = nodeBook.get(c.docId)
          if (spaceOfBook.get(bid) !== sid) continue
          rows.push({ at: Number(c.createdAt) || 0, t: d.title })
        }
      }
      for (const t of s.topics || []) {
        if (t?.spaceId !== sid) continue
        rows.push({ at: Number(t.createdAt) || 0, t: t.title })
      }
      return rows.filter((r) => r.at > 0).sort((a, b) => b.at - a.at).slice(0, 8).map((r) => r.t)
    }, spaceId)

    const mine = await p.evaluate((sid) => {
      const s = window.__yqStore.getState()
      return (s.books || []).filter((b) => b.spaceId === sid).map((b) => b.name)
    }, spaceId)

    const shown = feed.targets.filter(Boolean)
    const missing = expectedTargets.filter((t) => !shown.includes(t))
    const extra = shown.filter((t) => !expectedTargets.includes(t))

    console.log(`       显示 ${shown.length} 条 / 独立算出应有 ${expectedTargets.length} 条`)
    console.log(`       本空间的知识库：${mine.join('、') || '(空)'}`)
    console.log(`       条目：${shown.slice(0, 4).join(' / ')}${shown.length > 4 ? ' …' : ''}`)
    if (extra.length) console.log(`       ⚠️ 多出来的（不该属于这个空间）：${extra.join(' / ')}`)

    ok(missing.length === 0 && extra.length === 0,
      '显示的条目与**独立算出的**这个空间的条目完全一致（不过滤时两边内容不同，立刻就露）',
      `缺 ${missing.join(' / ')} | 多 ${extra.join(' / ')}`)
    ok(feed.total > 0 || feed.empty,
      `要么有真实条目，要么显示写明的空态（${feed.total} 条 / 空态=${feed.empty}）`)

    await p.screenshot({ path: 'docs/shots/space-feed.png' })
    console.log('\n截图：docs/shots/space-feed.png')
  } finally { await br.close() }
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