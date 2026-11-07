/* ============================================================
   回收站「真能恢复」验证

   之前的行为：删文档 = 服务端硬删，`GET /api/doc/:id` 直接 404，
   而回收站里还列着它、点「恢复」只弹一句「已恢复，请重新归档」——
   内容其实早就没了。那不叫回收站，叫墓碑。
   误删一篇文档等于永久丢失，而界面上完全看不出这一点。

   这个套件钉的是：恢复出来的必须是**完整的**文档，不是空壳。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:8092'
const DOC = 'd2'
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

try {
  const p0 = await (await browser.newContext()).newPage()
  await login(p0, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const token = await p0.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }
  const api = async (p, opt) => (await fetch(BASE + p, { ...opt, headers: { ...H, ...(opt?.headers || {}) } }))

  // 记录原始内容
  /*
   * ⚠️⚠️ 2026-10-15：这一步以前是「直接读」，于是它**继承了前面所有套件留下的状态** ——
   *   而那些套件可能已经把 d2 删了（d2 是种子里**唯一**那条评论回复挂着的文稿，
   *   谁删了它不还回来，后面 `test-sync-integrity` 的前置就断）。
   *
   *   症状是「按标题在回收站里找 DOC 那一行 → 命中 0 行」，
   *   而真实原因不在选择器上，在**d2 早就不在正文里了**：
   *   `deleteDoc(d2)` 成了空操作，回收站里自然没有这一行。
   *
   *   修法：**先自己把状态收拾干净再开始** ——
   *   它已经在回收站就先恢复，然后再按当前标题重新读一次内容。
   *   测试不该假设「前面没人动过它」。
   */
  await p0.evaluate(async (d) => {
    const s = window.__yqStore.getState()
    if (s.trash.some((t) => String(t.docId) === d)) await s.restoreFromTrash(d)
  }, DOC)
  await p0.waitForTimeout(2500)
  const before = await (await api(`/api/doc/${DOC}`)).json()
  const beforeBlocks = before.doc.blocks.length
  const beforeTitle = before.doc.title
  ok(beforeBlocks > 0, '原始文稿有正文', `${beforeBlocks} 块`)
  // 先打开这篇再存版本 —— 轻量启动后没打开过的文稿本地没有正文，
  // 那种情况下存出来的会是空快照（addDocVersion 现在会直接拒绝）
  await p0.goto(`${BASE}/#/book/b1/doc/${DOC}`, { waitUntil: 'domcontentloaded' })
  await p0.waitForSelector('.yq-block', { timeout: 25000 })
  await p0.waitForTimeout(1500)
  /*
   * ⚠️ 2026-10-10：这里原来只是「打开 → 立刻存一版」。
   * 而现在**打开文档本身就会自动存一版**（这正是它该有的行为：
   * 轻量启动下打开那一刻正文还没到本地，守卫会拒掉那次触发，
   * 于是「打开文档先存一版」从来没发生过 —— 见 test-versions 里那组断言）。
   *
   * 于是这一下内容与刚存的「打开文档」**完全一样**，
   * `addDocVersion` 的指纹去重如实返回 `null` —— 这一步静默变成了空操作，
   * 后面「恢复后版本也还在」找的那条 `回收站测试存档` 自然就不存在了。
   *
   * 改的是**造法**，不是判据：这条测试要验的是
   * 「软删除保留整行、恢复后历史版本还在」，而那正是快照机制的本意。
   * 先让正文真的变一下，再存这一版 —— 它才是**独立的一版**。
   */
  await p0.evaluate((d) => {
    const s = window.__yqStore.getState()
    const doc = s.docs[d]
    s.setDocBlocks(d, [...doc.blocks, { id: 'bk_trash_seed', type: 'p', text: '回收站测试存档专用的一段' }])
  }, DOC)
  await p0.waitForTimeout(1200)
  const seedVersion = await p0.evaluate((d) => {
    const s = window.__yqStore.getState()
    return s.addDocVersion(d, '回收站测试存档')
  }, DOC)
  ok(!!seedVersion, '先存一版历史版本（用来验证恢复后版本也还在）', String(seedVersion))
  await p0.waitForTimeout(2000)
  /*
   * 「删除前的块数」要**在刚才那段加完之后**取。
   * 原来它取自打开文档之前，而现在打开 → 加段 → 存版这条链路上多了一块，
   * 沿用旧基线会让「恢复后块数与删除前一致」差 1 —— 而那正是
   * 「基线取早了一步」而不是「恢复丢了内容」。
   */
  const blocksBeforeDelete = await p0.evaluate((d) => window.__yqStore.getState().docs[d].blocks.length, DOC)

  console.log('\n== 删掉它 ==')
  const delRes = await p0.evaluate((d) => {
    const s = window.__yqStore.getState()
    s.deleteDoc(d)
    return true
  }, DOC)
  ok(delRes, '触发删除')
  await p0.waitForTimeout(2500)

  const afterDel = await fetch(`${BASE}/api/doc/${DOC}`, { headers: H })
  ok(afterDel.status === 410 || afterDel.status === 404, '正常接口不再返回这篇', String(afterDel.status))

  const boot = await (await api('/api/bootstrap')).json()
  const inBoot = boot.data.docs.some((d) => d.id === DOC)
  ok(!inBoot, '启动数据里也没有它了')
  const searchRes = await (await api('/api/search?q=' + encodeURIComponent(beforeTitle.slice(0, 6)))).json()
  ok(!(searchRes.results || []).some((r) => r.id === DOC), '搜索结果里也不该再出现', JSON.stringify((searchRes.results || []).map((r) => r.id)))

  console.log('\n== 另一个同事也能在回收站里看到并恢复 ==')
  const acct = `trash_${suffix}`
  const reg = await (await p0.request.post(`${BASE}/api/auth/register`, { data: { account: acct, password: 'test1234', name: '回收站同事' } })).json()
  await p0.request.post(`${BASE}/api/sync/push`, {
    headers: H,
    data: { upsert: { bookMembers: [{ bookId: 'b1', userId: reg.user.id, role: 'editor', perms: { read: 1, comment: 1, edit: 1, create: 1, export: 1, share: 1 }, joinedAt: Date.now() }] } },
  })

  const B = await (await browser.newContext()).newPage()
  await login(B, acct, 'test1234')
  const bToken = await B.evaluate(() => localStorage.getItem('yq_token'))
  const bH = { Authorization: `Bearer ${bToken}`, 'Content-Type': 'application/json; charset=utf-8' }

  const bTrash = await (await B.request.get(`${BASE}/api/bootstrap`)).json()
  const inTrash = (bTrash.data.trash || []).some((t) => t.docId === DOC)
  ok(inTrash, 'B 的回收站里能看到这篇（回收站是共享的）')

  const restored = await B.request.post(`${BASE}/api/doc/${DOC}/restore`, { headers: bH })
  ok(restored.ok(), 'B 能恢复', String(restored.status()))

  console.log('\n== 恢复出来的是完整文档 ==')
  const after = await (await fetch(`${BASE}/api/doc/${DOC}`, { headers: H })).json()
  ok(after.doc && Array.isArray(after.doc.blocks), '恢复后能取到正文', after.doc ? '有' : '无')
  ok(after.doc?.blocks.length === blocksBeforeDelete, `块数与删除前一致（${blocksBeforeDelete}）`, String(after.doc?.blocks?.length))
  ok(after.doc?.title === beforeTitle, '标题也回来了', after.doc?.title)
  const vers = await (await fetch(`${BASE}/api/doc/${DOC}/versions`, { headers: H })).json()
  ok((vers.versions || []).some((v) => v.label === '回收站测试存档'),
    '历史版本也还在（软删除保留的是整行，不是快照）',
    JSON.stringify((vers.versions || []).map((v) => v.label).slice(0, 3)))

  console.log('\n== 彻底删除需要管理员 ==')
  const denied = await B.request.post(`${BASE}/api/doc/${DOC}/purge`, { headers: bH })
  ok(!denied.ok(), 'editor 不能彻底删除', String(denied.status()))
  const stillThere = await fetch(`${BASE}/api/doc/${DOC}`, { headers: H })
  ok(stillThere.status === 200, '被拒绝的彻底删除没有生效', String(stillThere.status))

  /*
   * 保留期问不到时，**不许编一句关于数据保留的假事实**。
   *
   * 原来页面逐条写的是「· 本实例未开启自动清除」，
   * 而 `days` 缺省就是 0 —— 于是「接口失败」和「实例真的没开清除」落到同一分支。
   * 结果同屏上副标题写着「无法确认保留期」、每行却写着「未开启自动清除」，
   * **自相矛盾**，而且那句假话是逐条重复、最像事实的那句。
   *
   * 为什么这条值得钉：管理员据此以为「删掉的文档会一直留着」，
   * 而服务端可能 30 天后就清掉了 ——
   * 公司照这句话定数据保留策略，会得出一个错的结论
   * （`server/index.ts` 里专门记着这条为什么严重）。
   *
   * 做法是把那个接口**打挂**再看页面：打挂是最确定性的「问不到」模拟。
   */
  console.log('\n== 保留期问不到时，不许编出「未开启自动清除」 ==')
  /*
   * ⚠️⚠️ 这里原来**直接假设 DOC 还在回收站里**，于是踩了一个套件自身的矛盾：
   *
   *   上面第 139 行「另一个同事也能在回收站里看到并恢复」已经**把 DOC 恢复了**，
   *   到这一节回收站是空的 →
   *     · 基准断言读到「渲染出了 0 行」；
   *     · 按标题找 DOC 那一行也是 0 行；
   *   症状出现在**两条断言**上，根因却在**前面的节**。
   *
   * 而且它和文件末尾那段收摊注释（「必须把 DOC 恢复回去」）互相打架：
   * 那段注释默认 DOC 此刻**仍在**回收站，可它早就被恢复走了 ——
   * 于是整套跑完时 DOC 的状态就不是「恢复态」，后面 `test-sync-integrity`
   * 的前置（「服务端本来就有评论回复」，种子里唯一那条就挂在 d2 上）也可能被打断。
   *
   * 修法：**自己先把 DOC 删掉**，让这一节的前提与前面发生过什么**无关**。
   * ⚠️ 第二版踩的坑：**光 deleteDoc 还不够**。
   * 上面 B 是**走服务端接口**恢复的，而 p0 全程没重新水合 ——
   * 于是 p0 的本地 `trash` 里**还留着** DOC、`docs` 里**已经没有**它，
   * `deleteDoc(DOC)` 撞上 `if (!d) return {}` 直接空操作，
   * 回收站还是空的，症状一模一样。
   *
   * 所以要先 **reload 让 p0 重新水合**，再删 ——
   * 「本地状态相对服务端是陈旧的」这件事，必须显式处理，不能假设它自动同步。
   */
  await p0.reload({ waitUntil: 'domcontentloaded' })
  await p0.waitForSelector('.yq-app', { timeout: 25000 })
  await p0.waitForTimeout(3500)
  await p0.evaluate((d) => { window.__yqStore.getState().deleteDoc(d) }, DOC)
  await p0.waitForTimeout(2500)
  {
    /*
     * ⚠️ 必须先让回收站**真的有东西**，再加那条否定式断言。
     * 第一版直接开页面，结果那时 DOC 已经被恢复回去了 → 一行都没有 →
     * `.yq-list-row-meta` 匹配到空数组 → 「文本里不含『未开启自动清除』」
     * 自然成立 → **恒真的守卫**（破坏对照一跑就是 16/0，当场露馅）。
     * 否定式断言必须配基准，否则它什么也证明不了。
     */
    await p0.evaluate((d) => { window.__yqStore.getState().deleteDoc(d) }, DOC)
    await p0.waitForTimeout(2600)

    const C = await (await browser.newContext()).newPage()
    await C.route('**/api/trash/retention', (r) => r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"故意打挂"}' }))
    await C.goto(BASE, { waitUntil: 'domcontentloaded' })
    await C.waitForSelector('.yq-login-card', { timeout: 25000 })
    await C.fill('.yq-login-card input[autocomplete="username"]', 'admin')
    await C.fill('.yq-login-card input[type="password"]', process.env.ADMIN_PASS || 'yuque@2026')
    await C.click('.yq-login-submit')
    await C.waitForSelector('.yq-app', { timeout: 30000 })
    await C.goto(`${BASE}/#/trash`, { waitUntil: 'domcontentloaded' })
    await C.waitForSelector('.yq-dash-greeting', { timeout: 25000 })
    await C.waitForTimeout(1500)
    const head = (await C.locator('.yq-dash-date').textContent().catch(() => '')) || ''
    const metas = await C.locator('.yq-list-row-meta').allTextContents()
    const rows = metas.join(' | ')
    /* 基准：下面那句否定式断言只有在「确实渲染出了行」时才成立 */
    ok(metas.length > 0, `基准：回收站里确实渲染出了 ${metas.length} 行（否则下一条就是恒真的）`, rows.replace(/\s+/g, ' ').slice(0, 80))
    ok(/无法确认/.test(head), `副标题如实说「无法确认」（实际=「${head.trim().slice(0, 24)}」）`)
    ok(!/未开启自动清除/.test(rows), '★ 没有把「问不到」说成「本实例未开启自动清除」', `实际=「${rows.replace(/\s+/g, ' ').slice(0, 80)}」`)

    /*
     * ⚠️⚠️ 收摊：必须把 DOC **恢复回去**。
     *
     * runner 里所有套件共用**一个**测试库（`data/_testrun-<ts>.db`），
     * 所以每个套件都必须把自己弄出来的状态还原，否则后面那些套件的前置会被打断。
     * 实测踩过一次：这一段结束时把 d2 留在回收站 → 全量里
     * `test-sync-integrity` 的前置「服务端本来就有评论回复」读到 **0**（种子里只有 1 条，
     * 而它就挂在 d2 上）→ 那一个套件红，而**红的地方与改动毫无关系**。
     *
     * 老版本这个套件结束时 DOC 是恢复状态，所以以前不红。
     */
    await C.route('**/api/trash/retention', (r) => r.continue())
    await C.reload({ waitUntil: 'domcontentloaded' })
    await C.waitForSelector('.yq-list-row', { timeout: 25000 })
    await C.waitForTimeout(1000)
    /*
     * ⚠️⚠️ 必须**按标题定位这一行**，不能用 `.first()`。
     *
     * 单独跑这个套件时回收站是空的，恢复按钮自然就是 DOC 的；
     * 而全量里前面那些套件已经在回收站里留了别的文档 ——
     * `.first()` 点的是**别人的**那一行，于是
     *   · DOC 仍然躺在回收站（收摊断言读到 HTTP 410）；
     *   · 而且我还**顺手改了别人的状态**（把另一篇恢复了）。
     * 症状出现在**另一个文件**里（`test-sync-integrity` 的前置断了），
     * 根因却在**这一行选择器**上。
     */
    const myRow = C.locator('.yq-list-row').filter({ hasText: beforeTitle })
    const n = await myRow.count()
    ok(n === 1, `回收站里按标题找到 DOC 那一行（命中 ${n} 行）—— 不唯一就不能乱点`, beforeTitle)
    if (n === 1) {
      await myRow.locator('button', { hasText: '恢复' }).first().click()
      await C.waitForTimeout(3000)
      const back = await fetch(`${BASE}/api/doc/${DOC}`, { headers: H })
      ok(back.status === 200, `收摊：DOC 已恢复原状（HTTP ${back.status}），共享库不留残留`)
    }
    await C.close()
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

process.exit(fail ? 1 : 0)
