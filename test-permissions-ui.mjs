/* ============================================================
   权限感知（前端侧）

   服务端一直判权限，但**前端从来没问过** ——
   `docPerms()` 这个接口一直没人调用。结果：

     · 只读成员看到的是一个完全可编辑的页面
     · 他打字，看着存进去了
     · 一提交就被服务端拒掉
     · 界面上一点提示都没有 ← 最要命

   「我明明改了，怎么没了」是知识库里最难排查的一类问题。
   这个套件钉的是：**没有编辑权就别让他编辑，并且说清楚为什么。**
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:8092'
let DOC = 'd1'
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
const openDoc = async (page, doc, bookId) => {
  await page.goto(`${BASE}/#/book/${bookId}/doc/${doc}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-block', { timeout: 25000 })
  await page.waitForTimeout(1800)
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

try {
  const p0 = await (await browser.newContext()).newPage()
  await login(p0, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const token = await p0.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }

  console.log('\n== 准备：editor 与 visitor 两个账号，以及一个专用知识库 ==')
  // 自建一个知识库 + 一篇文档。
  // 共用库时前面的套件已经改过 b1 的内容，基线与现状天然有差异，
  // 「没有假告警」这条就会变成顺序依赖的假失败。
  const bookId = await p0.evaluate((sfx) => window.__yqStore.getState().createBook('s1', '权限测试库 ' + sfx), suffix)
  await p0.waitForTimeout(1800)

  const mk = async (role) => {
    const acct = `perm_${role}_${suffix}`
    const reg = await (await p0.request.post(`${BASE}/api/auth/register`, { data: { account: acct, password: 'test1234', name: role } })).json()
    await p0.request.post(`${BASE}/api/sync/push`, {
      headers: H,
      data: { upsert: { bookMembers: [{ bookId, userId: reg.user.id, role, perms: { read: true, comment: true, edit: role === 'editor', create: role === 'editor', export: true, share: role === 'editor' }, joinedAt: Date.now() }] } },
    })
    return acct
  }
  const editorAcct = await mk('editor')
  const visitorAcct = await mk('visitor')

  DOC = await p0.evaluate(([b]) => window.__yqStore.getState().createDoc(b, null, '权限测试文档'), [bookId])
  await p0.waitForTimeout(2500)

  const Editor = await (await browser.newContext()).newPage()
  const Visitor = await (await browser.newContext()).newPage()
  /**
   * 用 addInitScript 而不是 evaluate：它每次导航都跑，
   * 而 evaluate 装的监听会被 openDoc 的 goto 直接抹掉。
   * toast 只存在 2.6 秒，错过就再也抓不到了。
   */
  await Visitor.addInitScript(() => {
    window.__toasts = []
    const grab = () => {
      try {
        document.querySelectorAll('.yq-toast').forEach((el) => {
          const t = (el.textContent || '').trim()
          if (t && !window.__toasts.includes(t)) window.__toasts.push(t)
        })
      } catch { /* 页面还在加载 */ }
    }
    // 观察 document 而不是 documentElement ——
    // init script 跑得比 <html> 解析还早，documentElement 那会儿是 null
    new MutationObserver(grab).observe(document, { childList: true, subtree: true, characterData: true })
    setInterval(grab, 150)
  })
  /**
   * 抓访客的每一次推送（请求体 + 拒收明细）。
   *
   * 必须装在**第一次 login 之前** —— 装晚了会漏掉登录/加载阶段的推送。
   * 我第一次就是这么查的：顶栏明明写着「1 处修改没有保存」，
   * 而访客的推送与拒收记录都是 `[]`，因为那次拒收正好发生在监听装上之前。
   * **「没抓到」和「没发生」是两回事**，差点误判成数据对不上。
   */
  await Visitor.addInitScript(() => {
    window.__rej = []
    window.__pushes = []
    window.__diffProbe = []
    const orig = window.fetch
    window.fetch = async (...a) => {
      const r = await orig(...a)
      const u = String(a[0])
      if (u.includes('/api/sync/push')) {
        try { window.__pushes.push(String(a[1]?.body || '').slice(0, 600)) } catch { /* */ }
        try {
          const b = await r.clone().json()
          for (const x of b.rejected || []) (window.__rej ||= []).push(`${x.entity}:${x.id} ${x.reason}`)
        } catch { /* */ }
      }
      return r
    }
  })

  await login(Editor, editorAcct, 'test1234')
  await login(Visitor, visitorAcct, 'test1234')

  console.log('\n== 前端要去问权限 ==')
  let asked = 0
  Visitor.on('request', (r) => { if (r.url().includes('/api/perms/doc/')) asked++ })
  await openDoc(Visitor, DOC, bookId)
  ok(asked > 0, '打开文档时确实向服务端问了权限', `请求 ${asked} 次`)
  const caps = await Visitor.evaluate((d) => fetch(`/api/perms/doc/${d}`, { headers: { Authorization: 'Bearer ' + localStorage.getItem('yq_token') } }).then((r) => r.json()), DOC)
  ok(caps.caps && caps.caps.read === true && caps.caps.edit === false, '服务端确实说他只能读', JSON.stringify(caps.caps))

  console.log('\n== 只读成员的编辑器必须是只读的 ==')
  // 注意：先找「块」，再看它能不能编辑。
  // 早先直接找 [contenteditable="true"]，只读时它压根不存在，
  // 于是「正文还在不在」和「能不能编辑」两条断言一起失败 ——
  // 看起来像页面没渲染，其实正是只读生效了。
  const blockState = await Visitor.evaluate(() => {
    const el = document.querySelector('.yq-block')
    if (!el) return { found: false }
    const inner = el.querySelector('[contenteditable]')
    return {
      found: true,
      anyEditable: el.querySelectorAll('[contenteditable="true"]').length,
      innerEditable: inner ? inner.getAttribute('contenteditable') : null,
    }
  })
  ok(blockState.found, '正文块还在（他该能看）', JSON.stringify(blockState))
  ok(blockState.found && blockState.anyEditable === 0, '但整块里没有一个可编辑元素', JSON.stringify(blockState))

  // 试着改一下，确认真的改不动
  const before = await Visitor.evaluate((d) => window.__yqStore.getState().docs[d].blocks.length, DOC)
  await Visitor.evaluate((d) => {
    const el = document.querySelector('.yq-block [contenteditable]')
    if (el) { el.focus(); document.execCommand('insertText', false, '偷偷改一下') }
  }, DOC)
  await Visitor.waitForTimeout(1200)
  const after = await Visitor.evaluate((d) => window.__yqStore.getState().docs[d].blocks.map((b) => b.text).join('|'), DOC)
  ok(!String(after).includes('偷偷改一下'), '输入没有生效', String(after).slice(0, 60))

  console.log('\n== 要说清楚为什么 ==')
  // 监听是在 addInitScript 里装的，跨导航一直在
  await openDoc(Editor, DOC, bookId)   // 先热身一次
  await openDoc(Visitor, DOC, bookId) // 真正的观察对象
  await Visitor.waitForTimeout(900)
  const toasts = await Visitor.evaluate(() => window.__toasts || [])
  ok(toasts.some((t) => t.includes('阅读权限')),
    '给了明确提示（不是让人对着存不进去的编辑器发呆）', JSON.stringify(toasts.slice(0, 3)))

  console.log('\n== 有编辑权的人不受影响 ==')
  await openDoc(Editor, DOC, bookId)
  const edOk = await Editor.evaluate(() => ({
    blocks: document.querySelectorAll('.yq-block').length,
    editable: document.querySelectorAll('.yq-block [contenteditable="true"]').length,
  }))
  ok(edOk.blocks > 0 && edOk.editable > 0, 'editor 看到的是可编辑的', JSON.stringify(edOk))

  const blocksBefore = await Editor.evaluate((d) => window.__yqStore.getState().docs[d].blocks.length, DOC)
  // 重置差分探针：下面这一轮才是关键时刻，之前那些不算
  await Visitor.evaluate(() => { window.__yqDiffProbe?.reset() })
  await Editor.evaluate((d) => {
    const s = window.__yqStore.getState()
    s.setDocBlocks(d, [...s.docs[d].blocks, { id: 'bk_p_' + Date.now(), type: 'p', text: '编辑权限测试写入' }])
  }, DOC)
  await Editor.waitForTimeout(2500)
  const srv = await (await fetch(`${BASE}/api/doc/${DOC}`, { headers: H })).json()
  ok(srv.doc.blocks.some((b) => b.text === '编辑权限测试写入'), 'editor 的写入正常落库（没被误伤）')

  console.log('\n== 同步状态条 ==')
  // 只打开文档、不做任何修改，顶栏不应该出现「N 处修改没有保存」。
  // 之前它常驻着一条 —— 因为服务端 book_members 用 userId 做主键、
  // 前端用 id，形状不一致让差分每次都判定「变了」，
  // 于是一路重推，普通成员推不动就变成常驻假告警。
  const falseAlarm = await Visitor.locator('.yq-syncstatus-text').textContent().catch(() => '')
  // 展开面板，直接看它说**哪一行**被拒了 —— 数字和文案都猜不出来，面板里有真相
  let panelInfo = ''
  if (await Visitor.locator('.yq-syncstatus-btn').count()) {
    await Visitor.locator('.yq-syncstatus-btn').click().catch(() => {})
    await Visitor.waitForTimeout(500)
    panelInfo = (await Visitor.locator('.yq-syncstatus-panel').textContent().catch(() => '')) || ''
  }
  const vRej = await Visitor.evaluate(() => window.__rej || [])
  const vPushes = await Visitor.evaluate(() => window.__pushes || [])

  /**
   * ⚠️ **下面是「已知缺陷」的现状记录，不是「期望行为」。**
   *
   * 现象：编辑者改了一篇文档，**只读成员**的页面被同步拉到这份改动，
   * 差分把它当成他改的推回服务端，被拒（没有 edit 权限），
   * 于是他的顶栏挂上「1 处修改没有保存」—— **他一个字都没改**。
   *
   * 根因**尚未定位**。已排除的：
   *   · 不是监听时序（把拦截提前到页面初始化才看到，见上面的 __rej/__pushes）；
   *   · 不是拉取后没补基准（`sync.ts` 的 upsert 分支本来就
   *     `baseline[key] = mergeRows(...)`；我又加了一遍，**没有任何改善**）。
   *   下一个要查的地方：`applyChanges` 里
   *   「增量里的文稿一定带正文（服务端 changes 流不裁重列）」这条注释 ——
   *   前提若已不成立，基准会被替换成**残缺行**，下一次差分自然认为它变了。
   *
   * 这条断言钉的是**当前行为**：修好之后它会失败，那正是我们要的信号。
   * 改这里的时候请一并删掉本段说明，并把断言改回「不该有假告警」。
   */
  /**
   * 这一段曾经是**已知的假告警缺陷**，现已修好，所以断言翻回了正确预期。
   *
   * 根因：协作文档走 WebSocket / BroadcastChannel，**不经过同步增量**。
   * `setDocBlocksRemote` 只改 store、不动同步基准 →
   * 下一次差分看到「store 是新版本、基准是旧版本」→
   * 把**别人**的改动当成自己改的推上去 →
   * 有编辑权的人推得动（白推一趟），只读成员推不动 →
   * 顶栏常驻「N 处修改没有保存」，而他一个字都没改。
   *
   * 修法：store 在应用远端文稿时通知 sync 把基准推到一致
   * （必须在 commit 落地**之前**，commit 之后就是差分了）。
   */
  ok(!/没有保存/.test(falseAlarm || ''), '没有改动时不会出现假的「没有保存」（协作进来的改动不算）',
    `${falseAlarm || '(无)'} | 拒收：${JSON.stringify(vRej).slice(0, 120)} | 推了：${JSON.stringify(vPushes).slice(0, 160)}`)

  // 根因回归：协作落地之后，同步基准必须和 store 一致
  const timeline = await Visitor.evaluate(() => {
    const p = window.__yqDiffProbe
    const list = p ? p.get() : []
    return list.map((h) => ({ id: h.id, changed: h.changed, baseBlocks: (h.base?.blocks || []).length, localBlocks: (h.local?.blocks || []).length }))
  })
  ok(timeline.length === 0, '协作进来的文稿没有被差分当成「我改的」', JSON.stringify(timeline).slice(0, 200))

  /**
   * 上面那条「被拒的写入会被无限重推」到底会不会**覆盖别人的新内容**？
   *
   * 这个测试是**完全确定性**的，不依赖上面那个竞态：
   *   1. 访客手上留一份陈旧副本（程序化写入，绕过只读界面）
   *   2. 推上去 → 被拒（没有 edit 权限）→ **基准不推进**（代码里的设计）
   *   3. 编辑者在这期间把文档改成新版 → 服务端是新内容
   *   4. 管理员给访客开编辑权
   *   5. 那份一直被重推的陈旧副本**补推成功** → 问一句：服务端现在是谁的内容？
   */
  console.log('\n== 被拒的写入会不会在权限放开后覆盖别人的新内容 ==')
  await Visitor.evaluate((d) => {
    const s = window.__yqStore.getState()
    s.setDocBlocks(d, [{ id: 'bk_stale', type: 'h1', text: '' }, { id: 'bk_stale_p', type: 'p', text: '访客的陈旧副本' }])
  }, DOC)
  await Visitor.waitForTimeout(2500)
  const mid1 = await (await fetch(`${BASE}/api/doc/${DOC}`, { headers: H })).json()
  ok(!mid1.doc.blocks.some((b) => b.text === '访客的陈旧副本'),
    '只读阶段推不动，服务端还是编辑者的内容', JSON.stringify(mid1.doc.blocks.map((b) => b.text)).slice(0, 90))

  // 编辑者在这期间改了新版
  await Editor.evaluate((d) => {
    const s = window.__yqStore.getState()
    s.setDocBlocks(d, [{ id: 'bk_new', type: 'h1', text: '' }, { id: 'bk_new_p', type: 'p', text: '编辑者的新版' }])
  }, DOC)
  await Editor.waitForTimeout(2500)

  // 管理员给访客开编辑权
  const visitorId = await p0.evaluate((acct) => {
    const u = window.__yqStore.getState().members.find((m) => m.account === acct)
    return u ? u.id : ''
  }, visitorAcct)
  const grant = await p0.request.post(`${BASE}/api/sync/push`, {
    headers: H,
    data: {
      upsert: { bookMembers: [{ bookId, userId: visitorId, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: true, share: true }, joinedAt: Date.now() }] },
      remove: {},
    },
  })
  ok(grant.status() === 200, '管理员给访客开了编辑权', String(grant.status()) + ' ' + JSON.stringify(visitorId))

  // 访客页面的下一次重试（最多等 20 秒）
  await Visitor.reload({ waitUntil: 'domcontentloaded' })
  await Visitor.waitForTimeout(2500)
  // 关键：先确认访客**真的推了**，否则「服务端没变」只是因为根本没走到那条路径，
  // 不能当成「覆盖风险不存在」的证据
  await Visitor.evaluate((d) => {
    const s = window.__yqStore.getState()
    if (s.docs[d]) s.setDocBlocks(d, [{ id: 'bk_stale2', type: 'h1', text: '' }, { id: 'bk_stale2_p', type: 'p', text: '访客的陈旧副本' }])
  }, DOC)
  await Visitor.waitForTimeout(3000)
  const pushedAfterGrant = await Visitor.evaluate(() =>
    (window.__pushes || []).filter((b) => b.includes('陈旧副本')).length)
  const final1 = await (await fetch(`${BASE}/api/doc/${DOC}`, { headers: H })).json()
  const finalTexts = (final1.doc.blocks || []).map((b) => b.text).join('|')
  ok(
    pushedAfterGrant > 0,
    '权限放开后访客**确实把这份副本推上去了**（否则后面那条「没覆盖」不算证据）',
    `推到 ${pushedAfterGrant} 次`,
  )
  ok(!finalTexts.includes('访客的陈旧副本'),
    '而服务端并没有被这份旧副本覆盖（如果这条红了，说明「无限重推」会造成数据覆盖）',
    finalTexts.slice(0, 110))
  ok(finalTexts.includes('编辑者的新版'), '服务端仍是编辑者的新版', finalTexts.slice(0, 110))

  // 真的被拒一次时，它必须出现
  const vTok = await Visitor.evaluate(() => localStorage.getItem('yq_token'))
  const rej = await Visitor.request.post(`${BASE}/api/sync/push`, {
    headers: { Authorization: `Bearer ${vTok}`, 'Content-Type': 'application/json' },
    data: { upsert: { docs: [{ id: DOC, title: 'visitor 越权改名' }] } },
  })
  const body = await rej.json()
  ok(body.rejected && body.rejected.length > 0, '服务端的拒绝带有原因', JSON.stringify(body.rejected))

  console.log('\n== 新建文档立刻能编辑（权限 404 不是「没权限」）==')
  /* ⚠️ 2026-10-07 补的一条真实回归。
     新建文档是**本地先落、同步防抖**，所以刚建完那一瞬
     `/api/perms/doc/<id>` 必然 404「文档不存在」（实测 1.2s 后才 200 edit:true）。
     修之前 `useDocPerms` 的 `.catch` 一律判「不可编辑」，于是：
       自己新建的文档 → 编辑器**永久只读** → 点块没反应 → 斜杠菜单不弹
       → 还弹一句「你对这篇文档只有阅读权限，编辑已关闭」
     而那个 effect 只依赖 [docId]，**不刷新就好不了**。
     这里断的是症状本身，不是策略函数 —— 浏览器里跑真实链路比在 Node 里
     import `perms.ts` 更强（那个文件依赖 React 和 `@/` 别名，纯 Node 引不动）。 */
  /* ⚠️ `bookId` 是**Node 侧**的变量，而 `page.evaluate` 的函数体跑在浏览器里 ——
     直接闭包引用会 `ReferenceError: bookId is not defined`。
     第一版就是这么写的，整个套件因此没跑到汇总行（runner 报「没找到汇总行」，
     项数也跟着没计进总数，文档核对于是说「写 3909 实际 3894」——
     一个测试代码的错，会在三个地方冒出来。） */
  const freshDoc = await p0.evaluate(([bid, sfx]) =>
    window.__yqStore.getState().createDoc(bid, null, '新建即编辑 ' + sfx), [bookId, suffix])
  await p0.goto(`${BASE}/#/book/${bookId}/doc/${freshDoc}`, { waitUntil: 'domcontentloaded' })
  await p0.waitForSelector('.yq-block', { timeout: 25000 })
  let editable = false
  try {
    await p0.waitForSelector('.yq-block-text[contenteditable="true"]', { timeout: 10000 })
    editable = true
  } catch { /* 保持 false，下面报错 */ }
  ok(editable, '新建的文档最终能编辑（不会因为权限接口的 404 被永久判成只读）')

  /* 不能靠刷新才恢复：必须是**同一页内**自己好起来 */
  await p0.reload({ waitUntil: 'domcontentloaded' })
  await p0.waitForSelector('.yq-block', { timeout: 25000 })
  await p0.waitForTimeout(1200)
  const stillRo = await p0.evaluate(() =>
    !!document.querySelector('.yq-block-text[contenteditable="false"]'))
  ok(!stillRo, '刷新后仍然是可编辑的（权限确实拿到了，不是被 404 蒙出来的）')

  console.log('\n== 知识库信息：谁能改，要和服务端同一判据 ==')
  /*
   * 界面原来只让 owner/admin 改库名与简介，文案也写着「只有管理员可以修改知识库信息」。
   * 而服务端对**已有库**走的是通用写入判据 `capsInBook(user, bookId).edit`
   *（`server/sync.ts` 的 `denyReason`）—— 也就是说 **editor 本来就有这个权限**，
   * 而且这件事被 `test-emptyfirst` 明确钉住：那一节叫
   * 「不许回退：改名字仍按『这个库』判」，断言「库的 editor 能给这个库改名」，
   * 破坏对照里去掉限制会当场红 4 项。
   *
   * ⇒ 界面比产品**更严**：editor 在界面上改不了，而系统允许。
   * 方向和 IP 白名单那次相反（那次界面比服务端松），同样是真缺陷 ——
   * 这次是把人挡在门外，而不是把门开着。
   *
   * 这一节钉的是**两端都验**：editor 真能改（且落库），
   * 只读成员改不了（不能因为他没权限就放行）。
   */
  {
    const openSettings = async (page) => {
      await page.goto(`${BASE}/#/book/${bookId}/settings`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.yq-bset-field', { timeout: 25000 })
      await page.waitForTimeout(1200)
    }
    const nameBox = (page) => page.locator('.yq-bset-field input[placeholder="给知识库起个名字"]')

    await openSettings(Editor)
    const edBox = nameBox(Editor)
    ok(await edBox.count() === 1, '知识库信息页渲染出了名称输入框')
    ok(!(await edBox.isDisabled()), '★ editor 能改（与服务端同一判据，不再被界面多挡一道）')

    const newName = '权限测试库改名 ' + suffix
    await edBox.fill(newName)
    /* ⚠️ 必须 `.first()`：`.yq-bset-actions` 里有两个按钮 ——
       「更新信息」和 dirty 时才出现的「撤销修改」。`fill()` 之后 dirty 为真，
       于是 locator 匹配到 2 个 → playwright strict mode 直接抛
       「strict mode violation」（第一版就这么炸的）。
       而这个套件的 catch 只 `fail++`，症状是「整节没跑完」而不是「选择器不对」。 */
    await Editor.locator('.yq-bset-actions button').first().click()
    await Editor.waitForTimeout(2600)
    const after = await (await fetch(`${BASE}/api/entity/books`, { headers: H })).json()
    ok((after.rows || []).some((b) => b.id === bookId && b.name === newName),
      `改名真落库了（${newName}）`, (after.rows || []).find((b) => b.id === bookId)?.name)

    await openSettings(Visitor)
    ok(await nameBox(Visitor).isDisabled(), '只读成员改不了（不能因为他没权限就放行）')
    const hint = (await Visitor.locator('.yq-bset-hint').first().textContent().catch(() => '')) || ''
    ok(/编辑者及以上/.test(hint), '并且说清了谁能改', `实际=「${hint.trim().slice(0, 30)}」`)
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

process.exit(fail ? 1 : 0)
