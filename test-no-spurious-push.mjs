/* ============================================================
   只读成员不该产生任何推送（回归锁）

   这条锁的是一个很难复现的家族问题：
   **本地这一侧比服务端多出字段** → 差分判定「变了」→ 整份数据被推上去
   → 普通成员推不动 → 顶栏常驻「N 处修改没有保存」，而他一个字都没改。

   曾经踩到的具体形态（每一个都会独立造成全量重推）：
     · 服务端发 `lockMemberId`/`lockAt`，前端要的是 `lock`
     · 服务端把 `trashed`/`_lite` 这类内部标记混进业务数据
     · 本地的 `_loaded`/`versions` 等客户端字段没排除
     · hydrate 之前拿到的是 localStorage 的陈旧快照
     · hydrate 之前的那次 `await` 里，组件挂载并 commit，而基准是空的

   关键：**这条用例只用自己的知识库和自带口令**。
   之前用临时探针复现时，探针里硬编码了一个错口令却仍被当成证据 ——
   一个坏掉的验证脚本会持续产出「看起来像产品缺陷」的东西。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:8092'
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const login = async (page, account, password) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 25000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', account)
  await page.fill('.yq-login-card input[type="password"]', password)
  await page.click('.yq-login-submit')
  await page.waitForSelector('.yq-app', { timeout: 30000 })
  await page.waitForTimeout(1200)
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)
const ADMIN = process.env.ADMIN_PASS || 'yuque@2026'

try {
  const p0 = await (await browser.newContext()).newPage()
  await login(p0, process.env.ADMIN_ACCOUNT || 'admin', ADMIN)
  const token = await p0.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }

  // 自建知识库，不碰种子数据
  const bookId = await p0.evaluate((sfx) => window.__yqStore.getState().createBook('s1', '静默推送测试 ' + sfx), suffix)
  await p0.waitForTimeout(2000)
  const seedDoc = await p0.evaluate(([b, sfx]) => {
    const id = window.__yqStore.getState().createDoc(b, null, '静默测试文档 ' + sfx)
    // 必须**重新取一次** state：createDoc 内部是 set()，
    // 之前拿到的 s 还是旧对象，里面没有刚建的文档
    const s = window.__yqStore.getState()
    s.setDocBlocks(id, [...s.docs[id].blocks, { id: 'bk_' + sfx, type: 'p', text: '初始内容' }])
    return id
  }, [bookId, suffix])
  await p0.waitForTimeout(2500)

  const acct = `ro2_${suffix}`
  const reg = await (await p0.request.post(`${BASE}/api/auth/register`, { data: { account: acct, password: 'test1234', name: '只读同事' } })).json()
  await p0.request.post(`${BASE}/api/sync/push`, {
    headers: H,
    data: { upsert: { bookMembers: [{ bookId, userId: reg.user.id, role: 'visitor', perms: { read: true, comment: true, edit: false, create: false, export: true, share: false }, joinedAt: Date.now() }] } },
  })

  console.log('\n== 只读成员打开文档，全程监听推送 ==')
  const p = await (await browser.newContext()).newPage()
  const pushed = []
  const rejected = []
  p.on('request', (r) => {
    if (!r.url().includes('/api/sync/push')) return
    try {
      const jb = JSON.parse(r.postData() || '{}')
      for (const [k, v] of Object.entries(jb.upsert || {})) {
        if (k === 'recents') continue // 他确实访问过，最近访问是合法写入
        pushed.push(`${k}×${v.length}`)
      }
    } catch { /* */ }
  })
  p.on('response', async (r) => {
    if (!r.url().includes('/api/sync/push')) return
    try {
      const b = await r.json()
      for (const x of b.rejected || []) rejected.push(`${x.entity}/${x.id}: ${x.reason}`)
    } catch { /* */ }
  })

  await login(p, acct, 'test1234')
  await p.goto(`${BASE}/#/book/${bookId}/doc/${seedDoc}`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-block', { timeout: 25000 })
  await p.waitForTimeout(4000)

  ok(pushed.length === 0, '除了最近访问，没有推送任何东西', JSON.stringify(pushed))
  ok(rejected.length === 0, '没有任何被拒的写入（顶栏不该挂告警）', JSON.stringify(rejected))
  const bar = await p.locator('.yq-syncstatus-text').textContent().catch(() => '')
  ok(!bar || !/没有保存/.test(bar), '顶栏没有「N 处修改没有保存」', bar || '(无)')
  const editable = await p.evaluate(() => document.querySelectorAll('.yq-block [contenteditable="true"]').length)
  ok(editable === 0, '编辑器确实是只读的', String(editable))

  console.log('\n== 服务端内容没被动过 ==')
  const after = await (await fetch(`${BASE}/api/doc/${seedDoc}`, { headers: H })).json()
  ok(after.doc.blocks.some((b) => b.text === '初始内容'), '正文完好')
  ok(after.doc.title.includes('静默测试文档'), '标题完好', after.doc.title)

  console.log('\n== 有编辑权的人正常写入 ==')
  const p2 = await (await browser.newContext()).newPage()
  const e2 = `ed2_${suffix}`
  const reg2 = await (await p0.request.post(`${BASE}/api/auth/register`, { data: { account: e2, password: 'test1234', name: '编辑同事' } })).json()
  await p0.request.post(`${BASE}/api/sync/push`, {
    headers: H,
    data: { upsert: { bookMembers: [{ bookId, userId: reg2.user.id, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: true, share: true }, joinedAt: Date.now() }] } },
  })
  await login(p2, e2, 'test1234')
  await p2.goto(`${BASE}/#/book/${bookId}/doc/${seedDoc}`, { waitUntil: 'domcontentloaded' })
  await p2.waitForSelector('.yq-block', { timeout: 25000 })
  await p2.waitForTimeout(2500)
  await p2.evaluate((d) => {
    const s = window.__yqStore.getState()
    s.setDocBlocks(d, [...s.docs[d].blocks, { id: 'bk_ed_' + Date.now(), type: 'p', text: '编辑者写入的一段' }])
  }, seedDoc)
  await p2.waitForTimeout(2500)
  const after2 = await (await fetch(`${BASE}/api/doc/${seedDoc}`, { headers: H })).json()
  ok(after2.doc.blocks.some((b) => b.text === '编辑者写入的一段'), '编辑者的写入正常落库（没被误伤）')

  /**
   * 前面全在验**否定面**：「没有改动时不该挂告警」。
   * 但 SyncStatus 存在的全部意义是「我明明改了，怎么没了」——
   * **真的被拒时它到底说不说，反而没人验。**
   *
   * 用「文档被别人锁住」这个服务端明确会拒的场景（`denyReason` 返回
   * 「文档已被他人锁定」）：编辑者的页面还开着，管理员把文档锁了，
   * 他继续写 → 客户端推 → 服务端拒 → **他的改动存不上去**。
   * 这时候界面上必须说话。
   */
  console.log('\n== 真的被拒时，顶栏必须说话 ==')

  // 1) 管理员把文档锁上
  const lockerName = '锁定人'
  const lockRes = await p0.request.post(`${BASE}/api/sync/push`, {
    headers: H,
    data: { upsert: { docs: [{ ...after2.doc, lockMemberId: 'locker_' + suffix, lockAt: Date.now() }] }, remove: {} },
  })
  ok(lockRes.status() === 200, '管理员把文档锁上了', String(lockRes.status()))
  await p0.waitForTimeout(500)
  const lockedNow = await (await fetch(`${BASE}/api/doc/${seedDoc}`, { headers: H })).json()
  // ⚠️ 读出来的是 `lock`（对象），不是 `lockMemberId`（列名）——
  // 服务端 toClient 会把这两列合成一个字段。断言写列名会得到 null，
  // 然后你会以为「锁没生效」，其实锁生效得很。
  ok(!!(lockedNow.doc.lock?.memberId || lockedNow.doc.lockMemberId), '服务端确实记着锁',
    JSON.stringify(lockedNow.doc.lock || lockedNow.doc.lockMemberId || null))

  // 2) 编辑者不知道被锁了，继续写 —— 走应用自己的同步路径
  //    先装观察器：告警可能只闪一下，靠 500ms 轮询会漏掉。
  //    MutationObserver 能确定性地回答「它**到底有没有出现过**」。
  await p2.evaluate(() => {
    const w = window
    w.__sawSyncBar = []
    w.__barObserver = new MutationObserver(() => {
      const el = document.querySelector('.yq-syncstatus')
      if (el) {
        const t = (el.textContent || '').trim()
        if (t && !w.__sawSyncBar.includes(t)) w.__sawSyncBar.push(t)
      }
    })
    w.__barObserver.observe(document.body, { childList: true, subtree: true })
  })
  const rejectedByPage = []
  const pushBodies = []
  p2.on('response', async (r) => {
    if (!r.url().includes('/api/sync/push')) return
    try {
      const b = await r.json()
      pushBodies.push(b)
      for (const x of b.rejected || []) rejectedByPage.push(`${x.entity}: ${x.reason}`)
    } catch { /* */ }
  })
  await p2.evaluate((d) => {
    const s = window.__yqStore.getState()
    s.setDocBlocks(d, [...s.docs[d].blocks, { id: 'bk_lock_' + Date.now(), type: 'p', text: '锁着的时候写的' }])
  }, seedDoc)
  await p2.waitForTimeout(2500)

  ok(rejectedByPage.some((x) => /锁定/.test(x)), '编辑者的写入被服务端以「锁定」为由拒了',
    JSON.stringify(rejectedByPage))

  // 3) 界面必须说话（观察器已经记下了它出现过的每一帧）
  await p2.waitForTimeout(1500)
  const seen = await p2.evaluate(() => {
    window.__barObserver?.disconnect()
    return window.__sawSyncBar || []
  })
  ok(seen.some((t) => /没有保存/.test(t)),
    '顶栏**出现过**「N 处修改没有保存」（MutationObserver 全程盯着）', JSON.stringify(seen))

  let panelText = ''
  if (seen.length) {
    const bar = p2.locator('.yq-syncstatus-text').first()
    if (await bar.count()) {
      await bar.click().catch(() => {})
      await p2.waitForSelector('.yq-syncstatus-panel', { timeout: 5000 }).catch(() => {})
      panelText = (await p2.locator('.yq-syncstatus-panel').textContent().catch(() => '')) || ''
    }
  }
  ok(/锁定/.test(panelText), '展开后写明了原因（锁定）', panelText.replace(/\s+/g, ' ').slice(0, 110))
  ok(/复制出来|先复制/.test(panelText), '并告诉用户该怎么做（把内容复制出来）',
    panelText.replace(/\s+/g, ' ').slice(0, 110))

  // 4) 服务端内容必须真的没被改掉
  const afterLock = await (await fetch(`${BASE}/api/doc/${seedDoc}`, { headers: H })).json()
  ok(!afterLock.doc.blocks.some((b) => b.text === '锁着的时候写的'),
    '被拒的写入没有落库（服务端是对的，界面说的是真话）')


  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

process.exit(fail ? 1 : 0)
