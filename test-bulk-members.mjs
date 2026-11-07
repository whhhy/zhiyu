/* ============================================================
   批量添加知识库成员

   之前「添加成员」是一次加一个。对一个演示系统这没问题，
   对一家公司这是**上线当天就过不去的坎**：
   空间里 200 个人，管理员要给 3 个知识库开通权限，就是 600 次点击。

   更要紧的是把循环写在 UI 里而不是 store 里：
   循环 N 次 addBookMember = N 次 commit = N 次同步推送，
   中途断网就只加进去一半，而且界面上看不出加到哪了。
   所以这里要验的是「一次 commit、一次推送」。

   另外两个容易做错、错了很难发现的点：
     · 「全选」如果无视搜索框，用户搜出 8 个人一按全选把 90 个也加进去了
     · 重复添加会产生同一人的两行记录，权限界面看着像有两个同名同事
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

try {
  const p0 = await (await browser.newContext()).newPage()
  await login(p0, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const token = await p0.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }

  console.log('\n== 准备：一个专用知识库 + 一批只存在于「空间」里的成员 ==')
  // 自建专用库：共用 b1 时前面的套件已经改过成员，基线与现状天然有差异
  const bookId = await p0.evaluate((sfx) => window.__yqStore.getState().createBook('s1', '批量加成员测试 ' + sfx), suffix)
  await p0.waitForTimeout(2000)

  // 注册几个账号进空间（不加入知识库），这样它们才是「添加成员」对话框里的候选
  // 名字必须带后缀：套件会被反复跑，名字不带后缀的话
  // 上一轮留下的同名账号会一起被搜出来，「搜出 1 行」这条断言
  // 测的其实是自己造出来的脏数据。
  const wanted = [`批量甲${suffix}`, `批量乙${suffix}`, `批量丙${suffix}`, `批量丁${suffix}`]
  for (const nm of wanted) {
    const acct = `bulk_${nm}`
    const reg = await (await p0.request.post(`${BASE}/api/auth/register`, { data: { account: acct, password: 'test1234', name: nm } })).json()
    // 注册本身就建了个人空间，但**没有**被加进这个知识库
    await p0.request.post(`${BASE}/api/sync/push`, { headers: H, data: { upsert: {}, remove: {} } })
  }
  // 刷新一次让新成员进到前端 store
  await p0.reload({ waitUntil: 'domcontentloaded' })
  await p0.waitForSelector('.yq-app', { timeout: 25000 })
  await p0.waitForTimeout(2500)

  const ids = wanted.map((nm) => `bulk_${nm}`)
  const inStore = await p0.evaluate(
    (accs) => accs.every((a) => window.__yqStore.getState().members.some((m) => m.account === a)),
    ids,
  )
  ok(inStore, `${wanted.length} 个新同事都在空间成员名册里（否则测的是空对话框）`)

  console.log('\n== 新建的知识库：创建者本人必须是 owner ==')
  // 之前 createBook 不写 book_members 行，于是服务端 capsInBook 对
  // 「非空间 owner/admin 且没有成员行」的人返回 NONE ——
  // 普通成员建出来的库，他自己打不开。平台 owner 看不出来。
  const creatorCaps = await p0.evaluate(async (b) => {
    const t = localStorage.getItem('yq_token')
    const r = await fetch(`/api/perms/book/${b}`, { headers: { Authorization: 'Bearer ' + t } })
    return { status: r.status, caps: await r.json().catch(() => null) }
  }, bookId)
  ok(creatorCaps.status === 200, '能查到建库者的知识库权限', String(creatorCaps.status))
  ok(
    creatorCaps.caps?.caps?.read === true && creatorCaps.caps?.caps?.admin === true,
    '建库者对这个库有读和管理权（不是 NONE）',
    JSON.stringify(creatorCaps.caps?.caps),
  )

  console.log('\n== 一次提交多个人 ==')
  // 拿服务端的真实行当基准，不用本地视图：
  // 本地视图受 hydrate 时机影响，拿它当基准就是把「同步还没到」误判成「没这行」
  const serverRows = async (bid) => {
    const j = await (await p0.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: { Authorization: 'Bearer ' + token } })).json()
    return (j.data.bookMembers || []).filter((r) => r.bookId === bid)
  }
  const beforeRows = await serverRows(bookId)
  // 新建的知识库只有创建者一个 owner。
  // 如果这里是 0 或者「空间全体人数」，都说明 getBookMembers 在编造 ——
  // 编造出来的名单会让「添加成员」的候选人恒为空，于是谁也加不进去。
  ok(
    beforeRows.length === 1 && beforeRows[0].role === 'owner',
    '服务端这个新库只有创建者一个 owner',
    JSON.stringify(beforeRows.map((r) => `${r.userId}:${r.role}`)),
  )
  const before = beforeRows.length

  // 直接调 store：先验「一次 commit」这个架构承诺，再验界面
  const res = await p0.evaluate(
    ([b, accs]) => {
      const s = window.__yqStore.getState()
      const picked = accs
        .map((a) => s.members.find((m) => m.account === a))
        .filter(Boolean)
        .map((m) => m.id)
      s.addBookMembers(b, picked, 'editor')
      const after = window.__yqStore.getState().getBookMembers(b)
      const mine = after.filter((m) => picked.includes(m.id))
      return {
        picked: picked.length,
        total: after.length,
        added: mine.length,
        roles: [...new Set(mine.map((m) => m.role))],
      }
    },
    [bookId, ids],
  )
  ok(res.picked === wanted.length, `一次调用把 ${wanted.length} 个人都选中了`, String(res.picked))
  ok(res.total === before + wanted.length, `本地成员数从 ${before} 变成 ${before + wanted.length}`, `实际 ${res.total}`)
  ok(res.added === wanted.length, '四个人都真的在成员表里了', String(res.added))
  ok(res.roles.length === 1 && res.roles[0] === 'editor', '批量添加的人角色一致', res.roles.join(','))

  console.log('\n== 重复添加不能产生两行 ==')
  const dup = await p0.evaluate(
    ([b, accs]) => {
      const s = window.__yqStore.getState()
      const picked = accs
        .map((a) => s.members.find((m) => m.account === a))
        .filter(Boolean)
        .map((m) => m.id)
      // 故意把同一个人传两遍，外加一个已经在库里的
      s.addBookMembers(b, [...picked, picked[0], picked[1]], 'editor')
      const after = window.__yqStore.getState().getBookMembers(b)
      const ids2 = after.map((m) => m.id)
      return { total: after.length, unique: new Set(ids2).size }
    },
    [bookId, ids],
  )
  ok(dup.total === dup.unique, '同一个人重复添加不会留下两行', `${dup.total} 行 / ${dup.unique} 个不同 id`)

  console.log('\n== 跨设备能看到（真的同步了，不是只改了本地）==')
  await p0.waitForTimeout(3000)
  const rowsAfter = await serverRows(bookId)
  ok(
    rowsAfter.length === before + wanted.length,
    `服务端收到了这 ${wanted.length} 条（本地加完就是 ${before + wanted.length} 行）`,
    `服务端实际 ${rowsAfter.length} 行`,
  )
  const newOnServer = await p0.evaluate(
    ([b, accs]) => {
      const t = localStorage.getItem('yq_token')
      return fetch('/api/bootstrap?lite=0', { headers: { Authorization: 'Bearer ' + t } })
        .then((r) => r.json())
        .then((j) => {
          const rows = (j.data.bookMembers || []).filter((r) => r.bookId === b)
          const ids2 = window.__yqStore.getState().members.filter((m) => accs.includes(m.account)).map((m) => m.id)
          return { rows: rows.length, allThere: ids2.every((id) => rows.some((r) => r.userId === id)) }
        })
    },
    [bookId, ids],
  )
  ok(newOnServer.allThere, '每一个被加的人都以自己的 userId 存进了服务端（不是塞了个空壳）')

  console.log('\n== 界面上能一次选多个 ==')
  // 另建一个干净库来测界面，避免受上面影响
  const uiBook = await p0.evaluate((sfx) => window.__yqStore.getState().createBook('s1', '批量界面测试 ' + sfx), suffix)
  await p0.waitForTimeout(2000)
  await p0.goto(`${BASE}/#/book/${uiBook}/settings`, { waitUntil: 'domcontentloaded' })
  await p0.waitForSelector('.yq-bset-nav', { timeout: 25000 })
  await p0.click('.yq-bset-nav-item:has-text("权限")')
  await p0.waitForSelector('.yq-bset-card', { timeout: 15000 })
  await p0.waitForTimeout(1200)
  await p0.click('.yq-bset-card-head button:has-text("添加成员")')
  await p0.waitForSelector('.yq-bset-modal-list', { timeout: 15000 })
  await p0.waitForTimeout(600)

  const rowsAll = await p0.locator('.yq-bset-modal-item.is-multi').count()
  ok(rowsAll > 0, '对话框列出了可添加的同事', `${rowsAll} 行`)

  // 勾三个人
  for (const i of [0, 1, 2]) await p0.locator('.yq-bset-modal-item.is-multi').nth(i).click()
  await p0.waitForTimeout(400)
  const chosen = await p0.locator('.yq-bset-pick-count').textContent().catch(() => '')
  ok(/已选\s*3\s*人/.test(chosen || ''), '勾选后显示已选 3 人', chosen || '(没有计数)')

  // 「全选」必须只作用于搜索结果
  await p0.fill('.yq-bset-pick-search input', wanted[0])
  await p0.waitForTimeout(500)
  const filteredRows = await p0.locator('.yq-bset-modal-item.is-multi').count()
  ok(filteredRows === 1, '搜索把候选缩小到 1 行', `${filteredRows} 行`)
  // 先清掉已勾的，再按全选，才能看清全选到底选了什么
  await p0.click('.yq-bset-pick-bar .yq-checkbox')
  await p0.waitForTimeout(400)
  const allPickedCount = await p0.locator('.yq-bset-pick-count').textContent().catch(() => '')
  ok(/全选搜索结果/.test((await p0.locator('.yq-bset-pick-bar .yq-checkbox').textContent()) || ''), '全选的文案写明是「搜索结果」')
  ok(/已选\s*1\s*人/.test(allPickedCount || ''), '全选只选中了搜索结果这 1 个人，没有把其他人都加进来', allPickedCount || '(没有计数)')

  await p0.click('.yq-modal-footer button:has-text("添加")')
  await p0.waitForTimeout(2500)
  // 基线是 1 —— 创建者本来就在里面。所以「只加了搜索结果那 1 个人」= 2。
  const uiCount = await p0.evaluate((b) => window.__yqStore.getState().getBookMembers(b).length, uiBook)
  ok(uiCount === 2, '界面确认后只多了 1 个人（创建者 + 选中的那位）', `实际 ${uiCount}`)

  console.log('\n== 角色要真的生效（不是只能看的下拉框）==')
  /**
   * 这一条是被实测抓出来的：加成员时把 perms 写死成「只读+评论」，
   * 而服务端是「先按角色给基线、再用成员行上的 perms 逐项覆盖」——
   * 于是无论角色选管理员还是编辑者，edit/create/export/share 全被按成 false。
   * 界面上看不出任何异常，管理员还得逐个人手动勾 4 个复选框。
   *
   * 验法要小心：`/api/perms/book/:id` 判的是**当前登录者**，
   * 拿 admin 的令牌去问，量到的永远是 admin 自己的能力（我第一次就栽在这）。
   * 所以必须换成被加的那个人登录。
   */
  const E = await (await browser.newContext()).newPage()
  await login(E, `bulk_${wanted[0]}`, 'test1234')
  const caps = await E.evaluate(async (b) => {
    const t = localStorage.getItem('yq_token')
    return (await fetch(`/api/perms/book/${b}`, { headers: { Authorization: 'Bearer ' + t } })).json()
  }, bookId)
  const c = caps.caps || {}
  ok(c.read === true, '编辑者能读', JSON.stringify(c))
  ok(c.edit === true, '**编辑者能编辑**（以前是 false —— 角色形同虚设）', JSON.stringify(c))
  ok(c.create === true, '编辑者能新建', JSON.stringify(c))
  ok(c.export === true, '编辑者能导出', JSON.stringify(c))
  ok(c.admin === false, '编辑者不是管理员（角色表没被写胖）', JSON.stringify(c))

  console.log('\n== 提升角色要真的生效 ==')
  /**
   * 同一个根因的第二个实例：updateMemberRole 只改 role、不重算 perms。
   * 而 perms 是覆盖层 —— 于是把 reader 提升为 editor，服务端判定的权限
   * 一项都没变（edit 仍然是 false），界面上却已经显示「编辑者」。
   * 「把实习生提升为编辑者」在公司里是每周都会发生的操作。
   *
   * 权限是**最终一致**的：管理员改完 → 推送 → 另一端轮询取回。
   * 所以这里必须轮询等，不能只 sleep 一次就断言 ——
   * 固定等待会把「慢」误判成「没生效」。
   */
  const askCaps = () => E.evaluate(async (b) => {
    const t = localStorage.getItem('yq_token')
    return (await (await fetch(`/api/perms/book/${b}`, { headers: { Authorization: 'Bearer ' + t } })).json()).caps
  }, bookId)
  const waitCaps = async (want, label) => {
    const deadline = Date.now() + 20000
    let last = null
    while (Date.now() < deadline) {
      await E.evaluate(() => window.dispatchEvent(new Event('focus')))
      await E.waitForTimeout(1500)
      last = await askCaps()
      if (want(last)) return { got: last, waited: 0 }
    }
    return { got: last, waited: 20000 }
  }

  // ids 里存的是**账号**，而 updateMemberRole 认的是 userId。
  // 直接把账号传进去会一个都匹配不上 —— 函数静默什么都不做，
  // 后面那句「升级生效了」就变成了空过（行本来就是 editor）。
  // 所以这里先把账号换成 userId，并且**断言角色真的变了**，
  // 否则又是一次「看起来在验、其实什么都没验」。
  const setRole = (acct, role) => p0.evaluate(([b, a, r]) => {
    const s = window.__yqStore.getState()
    const m = s.members.find((x) => x.account === a)
    if (!m) return { found: false }
    window.__yqStore.getState().updateMemberRole(b, m.id, r)
    const row = window.__yqStore.getState().getBookMembers(b).find((x) => x.id === m.id)
    return { found: true, uid: m.id, role: row?.role }
  }, [bookId, acct, role])

  const downRes = await setRole(ids[0], 'reader')
  ok(downRes.found && downRes.role === 'reader', '本地行确实被改成 reader 了（不是没匹配上）', JSON.stringify(downRes))
  const down = await waitCaps((x) => x.edit === false, '降级')
  ok(down.got?.edit === false, '降级为阅读者后真的不能编辑了', JSON.stringify(down.got))

  const upRes = await setRole(ids[0], 'editor')
  ok(upRes.role === 'editor', '本地行确实被改回 editor 了', JSON.stringify(upRes))
  const up = await waitCaps((x) => x.edit === true, '升级')
  ok(
    up.got?.edit === true && up.got?.create === true,
    '**重新提升为编辑者后权限跟着变**（以前改角色完全不生效）',
    JSON.stringify(up.got),
  )
  await E.close()
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  try { await browser.close() } catch { /* 已关 */ }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
