/* 历史版本 / 回收站 跨设备验证
   和评论回复是同一类问题：嵌套数据如果不同步推上去就只活在本地。 */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:8092'
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

/**
 * 用一篇**本套件自己建的**文档，不要用种子里的 d1。
 * 共用一个库时，前面的套件可能已经把 d1 删进回收站（软删除），
 * 那时打开它会一直停在骨架态 —— 顺序依赖的假失败。
 */
let DOC = 'd1'

const login = async (page, account, password) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 25000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', account)
  await page.fill('.yq-login-card input[type="password"]', password)
  await page.click('.yq-login-submit')
  await page.waitForSelector('.yq-app', { timeout: 30000 })
  await page.waitForTimeout(1200)
}
const openDoc = async (page) => {
  await page.goto(`${BASE}/#/book/b1/doc/${DOC}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-block', { timeout: 25000 })
  await page.waitForTimeout(1500)
}

/**
 * 刷新后要等正文真的到本地。
 * 轻量启动之后文档是「先有元信息、正文后到」，
 * 只等 .yq-app 是不够的 —— 那时 store 里可能只有壳。
 */
const waitDocBody = async (page) => {
  await page.waitForSelector('.yq-block', { timeout: 25000 })
  await page.waitForFunction(
    (d) => Array.isArray(window.__yqStore.getState().docs[d]?.blocks),
    DOC,
    { timeout: 25000 },
  ).catch(() => {})
  await page.waitForTimeout(800)
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

try {
  const p0 = await (await browser.newContext()).newPage()
  await login(p0, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const token = await p0.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }

  const acct = `ver_${suffix}`
  const r = await p0.request.post(`${BASE}/api/auth/register`, { data: { account: acct, password: 'test1234', name: '版本同事' } })
  const uid = (await r.json()).user.id
  await p0.request.post(`${BASE}/api/sync/push`, {
    headers: H,
    data: { upsert: { bookMembers: [{ bookId: 'b1', userId: uid, role: 'editor', perms: { read: 1, comment: 1, edit: 1, create: 1, export: 1, share: 1 }, joinedAt: Date.now() }] } },
  })

  const A = await (await browser.newContext()).newPage()
  const B = await (await browser.newContext()).newPage()
  await login(A, acct, 'test1234')
  await login(B, acct, 'test1234')
  const bToken = await B.evaluate(() => localStorage.getItem('yq_token'))

  // 现建一篇专用的，别去动别人的文档
  DOC = await A.evaluate(() => {
    const s = window.__yqStore.getState()
    return s.createDoc('b1', null, '版本测试专用文档')
  })
  console.log(`   （本套件新建文档 ${DOC}，不复用种子文档）`)

  /*
   * ⚠️ 必须用**一篇从没被打开过**的文档来验这条。
   *
   * 下面 ③ 那几段是在**本地 `createDoc` 建出来的**文档上做的 ——
   * 那条路上 `blocks` 从一开始就是个数组，`addDocVersion` 不会被守卫挡。
   * 而真实场景是**轻量启动下打开一篇服务端已存在的文档**：
   * `docId` 变了 → effect 触发 → 那一刻 `d.blocks` 还是 `undefined`
   * → store 明确拒绝（「正文没加载到本地时不许存版本」）→ 正文随后到达，
   * 但**没有任何东西再触发一次**。
   *
   * 结果是「打开文档先存一版」从来没发生过：同事打开一篇文档，
   * 历史版本是空的 —— 而这功能的全部意义就是「误删误改可随时找回」。
   * 换句话说，**安全网根本没部署上**，而界面上恰恰写着它在。
   *
   * 所以这里专门用种子文档验：它从 bootstrap 进来时**一定**只有元信息。
   */
  console.log('\n== 打开一篇「从没打开过」的文档：必须自动有一版快照 ==')
  {
    const seedDoc = await p0.evaluate(() => {
      const s = window.__yqStore.getState()
      // 前提：这个页面刚登录完，只跑过 bootstrap，正文都还没拉到
      const unloaded = Object.values(s.docs).filter((d) => !Array.isArray(d.blocks)).length
      const n = s.nodes.find((x) => x.bookId === 'b1' && x.docId && s.docs[x.docId])
      return { id: n?.docId, unloaded, total: Object.keys(s.docs).length }
    })
    ok(seedDoc.id, '（前提）找得到一篇种子文档', JSON.stringify(seedDoc))
    ok(seedDoc.unloaded > 0,
      `（前提）**轻量启动确实先只给元信息**（${seedDoc.unloaded}/${seedDoc.total} 篇的 blocks 还没到）——`,
      `没这一条，下面验的就是本地新建的文档，压根碰不到那条路径`)

    if (seedDoc.id) {
      await p0.goto(`${BASE}/#/book/b1/doc/${seedDoc.id}`, { waitUntil: 'domcontentloaded' })
      await waitDocBody(p0)
      const vs = await p0.evaluate((d) => {
        const doc = window.__yqStore.getState().docs[d]
        return (doc?.versions || []).map((v) => v.label)
      }, seedDoc.id)
      ok(vs.length >= 1,
        '**打开一篇没打开过的文档，自动就有了一版快照**（没有它就没有后悔药）',
        JSON.stringify(vs))
      ok(vs.includes('打开文档'), '这版的 label 是「打开文档」', JSON.stringify(vs))
    }
  }

  await openDoc(A)
  await openDoc(B)

  console.log('\n== A 改文档并存一个历史版本 ==')
  await A.evaluate((d) => {
    const s = window.__yqStore.getState()
    const doc = s.docs[d]
    s.setDocBlocks(d, [...doc.blocks, { id: 'bk_v_' + Date.now(), type: 'p', text: '版本测试新增的一段' }])
    window.__yqStore.getState().addDocVersion(d, '手动存档')
  }, DOC)
  await A.waitForTimeout(3500)

  // 这里**不**断言「A 本地列表里能看到这一版」。
  // 本地读 store 属于基本行为，smoke-files 已经覆盖（版本 diff + 锁定 20/20）；
  // 这一套要验的是「跨设备」，而跨设备的权威判据是服务端与另一台设备。
  // 早先那个本地断言在自动存档去重与 re-hydrate 的时序下不稳定，
  // 查下去发现真正的问题都在服务端与嵌套数据的合并上，已分别修复并有对应用例。

  console.log('\n== 服务端真的存了 ==')
  const api = await (await fetch(`${BASE}/api/doc/${DOC}/versions`, { headers: { Authorization: `Bearer ${token}` } })).json()
  ok(Array.isArray(api.versions) && api.versions.length > 0, '服务端 doc_versions 有记录', String(api.versions?.length))
  ok((api.versions || []).some((v) => v.label === '手动存档'), '而且是这一版', JSON.stringify((api.versions || []).map((v) => v.label).slice(0, 3)))

  console.log('\n== 换设备能看到、能回滚 ==')
  // 用 B 自己的令牌直接问服务端：这是确定性的判据。
  // （读 B 页面内存里那份反而不稳 —— 它取决于 hydrate 与正文按需加载谁先谁后，
  //   而这不是要验的东西。）
  const bBoot = await (await fetch(`${BASE}/api/bootstrap`, {
    headers: { Authorization: `Bearer ${bToken}` },
  })).json()
  const bApiVers = (bBoot.data.docVersions || []).filter((v) => v.docId === DOC)
  ok(bApiVers.some((v) => v.label === '手动存档'), 'B 的启动数据里就有这一版', JSON.stringify(bApiVers.map((v) => v.label)))
  // 要看**那一版**的快照，不是数组第一项 ——
  // 打开文档时的自动存档也会产生版本，顺序不保证。
  const manual = bApiVers.find((v) => v.label === '手动存档')
  ok(Array.isArray(manual?.blocks) && manual.blocks.length > 0,
    '而且带着可回滚的正文快照（轻量裁剪不能把这里也裁掉）',
    JSON.stringify({ labels: bApiVers.map((v) => v.label), blocks: manual?.blocks?.length }))

  await B.reload({ waitUntil: 'domcontentloaded' })
  // 刷新后要等正文真的到本地：轻量启动下 store 里可能还只有壳
  await waitDocBody(B)

  // 真的回滚一次，验证 blocks 快照也跟着过来了
  const beforeRollback = await B.evaluate((d) => window.__yqStore.getState().docs[d].blocks.length, DOC)
  const rolled = await B.evaluate((d) => {
    const s = window.__yqStore.getState()
    const doc = s.docs[d]
    if (!doc) return 'no-doc'
    const vs = doc.versions || []
    const v = vs.find((x) => x.label === '手动存档')
    if (!v) return 'no-version'
    if (!Array.isArray(v.blocks)) return 'no-blocks'
    return s.restoreDocVersion(d, v.id) ? 'ok' : 'restore-failed'
  }, DOC)
  ok(rolled === 'ok', 'B 能回滚到那一版', rolled)
  await B.waitForTimeout(2500)
  const afterRollback = await B.evaluate((d) => window.__yqStore.getState().docs[d].blocks.length, DOC)
  ok(typeof afterRollback === 'number' && afterRollback > 0, '回滚后正文仍然是完整的', `${beforeRollback} -> ${afterRollback}`)

  console.log('\n== 回收站跨设备 ==')
  await B.evaluate((d) => {
    const s = window.__yqStore.getState()
    s.trashDoc ? s.trashDoc(d) : s.deleteDoc?.(d)
  }, DOC).catch(() => {})
  await B.waitForTimeout(2500)
  const trashB = await B.evaluate(() => (window.__yqStore.getState().trash || []).length)
  ok(trashB > 0, 'B 删除后进了回收站', String(trashB))
  await A.reload({ waitUntil: 'domcontentloaded' })
  // 注意别再打开 d1 —— 它刚被 B 删了，打开只会一直停在骨架态。
  // 这里要验的是「回收站是共享的」，回工作台看一眼就够。
  await A.waitForSelector('.yq-app', { timeout: 30000 })
  await A.waitForTimeout(2500)
  const trashA = await A.evaluate(() => (window.__yqStore.getState().trash || []).length)
  ok(trashA > 0, 'A 那边也看到回收站里有这篇（回收站是共享的）', String(trashA))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

process.exit(fail ? 1 : 0)
