/* ============================================================
   搜索的权限过滤必须发生在 LIMIT 之前
   ------------------------------------------------------------
   原来的写法是：SQL 先 `LIMIT 400`，再在 JS 里逐条判权限。

   于是一个高频词只要**前 400 条命中恰好都是别人家的文档**，
   用户有权看的那几条排在 401 条之后 —— 结果是**零条**。
   而且界面上看不出任何异常：搜索框有东西打进去、返回空、
   看起来就像「公司里确实没有这篇文档」。

   这个套件用 450 篇无权文档把前 400 条占满，
   验证他**仍然搜得到**自己那两篇。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')
const PW = process.env.ADMIN_PASS || 'yuque@2026'
const KW = '限流测试关键词'
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const browser = await chromium.launch()
const SUF = Date.now().toString(36)

try {
  const p = await (await browser.newContext()).newPage()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', PW)
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(1500)
  const token = await p.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }

  // 一个普通同事，只能看 allowed
  const acct = `searchuser_${SUF}`
  const reg = await (await p.request.post(`${BASE}/api/auth/register`, {
    data: { account: acct, password: 'test1234', name: '搜索同事' },
  })).json()
  const uid = reg.user.id

  // 两个库：denied 里放 450 篇命中文档，allowed 里放 2 篇
  const sid = (await (await p.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()).data.spaces[0].id
  const mkBooks = await p.request.post(`${BASE}/api/sync/push`, {
    headers: H,
    data: {
      upsert: {
        books: [
          { id: 'b_denied', spaceId: sid, name: '看不到的库', desc: '', avatar: '🔒', visibility: 'private', docCount: 450, wordCount: 0, createdAt: 1, updatedAt: 1 },
          { id: 'b_allowed', spaceId: sid, name: '能看的库', desc: '', avatar: '📗', visibility: 'private', docCount: 2, wordCount: 0, createdAt: 1, updatedAt: 1 },
        ],
        bookMembers: [{ bookId: 'b_allowed', userId: uid, id: uid, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: true, share: true }, joinedAt: 1 }],
      },
      remove: {},
    },
  })
  ok(mkBooks.status() === 200, '两个知识库建好了', String(mkBooks.status()))

  const doc = (id, bookId, title) => ({
    id, bookId, spaceId: sid, type: 'doc', title,
    body: `${title} ${KW}`,
    blocks: [{ id: 'k' + id, type: 'p', text: `${title} ${KW}`, order: 0 }],
    order: 0, wordCount: 8, createdAt: 1, updatedAt: 1, rev: 0,
  })

  // 450 篇无权限的，**先推**（rowid 靠前，会占满前 400 条）
  const denied = Array.from({ length: 450 }, (_, i) => doc(`d_den_${i}`, 'b_denied', `看不到 ${i}`))
  // 再推有权的那两篇
  const allowed = [doc('d_ok_0', 'b_allowed', '我能看到的第一篇'), doc('d_ok_1', 'b_allowed', '我能看到的第二篇')]

  const chunks = [...denied, ...allowed].reduce((acc, r, i) => {
    if (i % 150 === 0) acc.push([])
    acc[acc.length - 1].push(r)
    return acc
  }, [])
  for (const chunk of chunks) {
    const r = await p.request.post(`${BASE}/api/sync/push`, {
      headers: H, data: { upsert: { docs: chunk, nodes: chunk.map((d) => ({ id: 'n_' + d.id, bookId: d.bookId, parentId: null, title: d.title, type: 'doc', docId: d.id, ord: 0, rev: 0 })) }, remove: {} },
    })
    if (r.status() !== 200) { ok(false, '批量推文稿失败', String(r.status())); break }
  }
  await p.waitForTimeout(2500)

  // 换个身份来搜：他只能看 b_allowed
  const uLogin = await (await p.request.post(`${BASE}/api/auth/login`, {
    data: { account: acct, password: 'test1234' },
  })).json()
  const UH = { Authorization: 'Bearer ' + uLogin.token }

  const res = await (await p.request.get(`${BASE}/api/search?q=${encodeURIComponent(KW)}`, { headers: UH })).json()
  const titles = (res.results || res.items || res.data || []).map((r) => r.title)

  ok(Array.isArray(res.results || res.items || res.data), '搜索接口返回了结果数组', JSON.stringify(res).slice(0, 120))
  ok(
    titles.includes('我能看到的第一篇') && titles.includes('我能看到的第二篇'),
    '前 400 条被无权文档占满时，他仍然搜得到自己有权限的那两篇',
    `返回 ${titles.length} 条：${JSON.stringify(titles).slice(0, 160)}`,
  )
  ok(
    !titles.some((t) => String(t).startsWith('看不到')),
    '同时没有泄露他看不到的 450 篇',
    JSON.stringify(titles.filter((t) => String(t).startsWith('看不到')).slice(0, 3)),
  )

  // 关键词在标题里也应当搜得到
  const byTitle = await (await p.request.get(`${BASE}/api/search?q=${encodeURIComponent('第二篇')}`, { headers: UH })).json()
  const t2 = (byTitle.results || byTitle.items || byTitle.data || []).map((r) => r.title)
  ok(t2.includes('我能看到的第二篇'), '按标题搜也能命中', JSON.stringify(t2).slice(0, 120))

  // 越权的词搜不到
  const deniedOnly = await (await p.request.get(`${BASE}/api/search?q=${encodeURIComponent('看不到 17')}`, { headers: UH })).json()
  const t3 = (deniedOnly.results || deniedOnly.items || deniedOnly.data || []).map((r) => r.title)
  ok(t3.length === 0, '只在他无权文档里出现的词，搜不到任何东西', JSON.stringify(t3).slice(0, 100))
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  try { await browser.close() } catch { /* 已关 */ }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
