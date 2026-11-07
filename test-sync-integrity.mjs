/* ============================================================
   同步完整性：客户端不能删掉服务端有的东西

   这一组 bug 的共同形状是「**静默丢数据**」：
   差分算出一批 remove，服务端照删 —— 因为删除在协议上完全合法，
   没有任何一环会报错。界面上看不出任何异常，
   等发现的时候，别人的评论回复已经没了。

   具体三个，都真实发生过：

   1. **评论回复被登录本身删掉。**
      commentReplies 在同步清单里，但 store 里**没有**这个顶层字段
      （回复是嵌在 comment.replies 里的）。通用差分循环于是拿
      `toRows(key, undefined)` 得到空数组，跟「服务端确实有这些行」的
      基准一比，得出结论：全删。
      → 打开一次应用（登录 → hydrate → 第一次推送）就清空全部回复。
      docVersions 当年为同一个坑专门跳过，回复这条漏了。

   2. **在界面上加成员 / 改角色，服务器一律不收。**
      服务端 book_members 的复合主键是 (bookId, userId)，
      而客户端这行只有 `id`（内容是 userId）、没有 `userId` 这一列，
      服务端判「缺少主键」，**整行丢弃**。服务端一直在回
      rejected: [{reason:'缺少主键'}]，只是没人看。
      → 加人、改角色、改逐项权限，全都「看着成功了，刷新就没了」。

   3. **把一个人从一个知识库移出，他所有知识库的成员身份一起没了。**
      deleteRow 只按 def.pk（userId）删，没带 bookId。

   还有一处会互相打架：客户端算差分用的行键是 `String(r.id)`，
   对 bookMembers 就是 userId —— 同一个人在两个知识库里的行会撞成一行，
   于是 B 库的改动被判成「没变」丢掉，A 库的改动却可能被推到 B 库去。

   这个套件钉的就是这些：每一条都用**服务端真实数据**核对，
   不用「界面上看着对」当证据。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')
const PW = process.env.ADMIN_PASS || 'yuque@2026'
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

try {
  const p0 = await (await browser.newContext()).newPage()
  await p0.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p0.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p0.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p0.fill('.yq-login-card input[type="password"]', PW)
  await p0.click('.yq-login-submit')
  await p0.waitForSelector('.yq-app', { timeout: 30000 })
  await p0.waitForTimeout(1200)
  const token = await p0.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: `Bearer ${token}` }
  const boot = () => fetch(`${BASE}/api/bootstrap?lite=0`, { headers: H }).then((r) => r.json())

  const base0 = await boot()
  const replies0 = base0.data.commentReplies || []
  const versions0 = base0.data.docVersions || []
  ok(replies0.length > 0, '服务端本来就有评论回复（否则这组用例测不到东西）', String(replies0.length))
  const seededReplyIds = replies0.map((r) => r.id)

  /* ---------- 1. 登录 + 推送不能删掉既有回复与版本 ---------- */
  console.log('\n== 登录与推送不该删掉服务端已有的数据 ==')
  // 制造一次真实的本地活动，确保一定走到推送
  await p0.evaluate((sfx) => window.__yqStore.getState().createBook('s1', '完整性校验 ' + sfx), suffix)
  await p0.waitForTimeout(4000)

  const base1 = await boot()
  const replies1 = base1.data.commentReplies || []
  const versions1 = base1.data.docVersions || []
  const stillThere = seededReplyIds.filter((id) => replies1.some((r) => r.id === id))
  ok(
    stillThere.length === seededReplyIds.length,
    `既有的 ${seededReplyIds.length} 条评论回复一条没少`,
    `剩 ${stillThere.length}：缺 ${seededReplyIds.filter((id) => !stillThere.includes(id)).join(',')}`,
  )
  ok(versions1.length >= versions0.length, '历史版本没被推送删掉', `${versions0.length} → ${versions1.length}`)
  ok((base1.data.docs || []).length >= (base0.data.docs || []).length, '文稿一篇没少')

  /* ---------- 2. 界面加成员，服务端必须真的收下 ---------- */
  console.log('\n== 在界面上加成员，服务端要真的收下 ==')
  const ids = await p0.evaluate(() => {
    const s = window.__yqStore.getState()
    const others = s.members.filter((m) => m.id !== s.currentUser.id).slice(0, 2).map((m) => m.id)
    const bookA = s.createBook('s1', '完整性 A ' + Date.now().toString(36))
    window.__yqStore.getState().addBookMembers(bookA, others, 'editor')
    return { bookA, others }
  })
  await p0.waitForTimeout(4000)

  const base2 = await boot()
  const rowsA = (base2.data.bookMembers || []).filter((r) => r.bookId === ids.bookA)
  ok(
    rowsA.length === ids.others.length + 1,
    `服务端 A 库有 ${ids.others.length + 1} 行成员（创建者 + 新加的）`,
    String(rowsA.length),
  )
  ok(
    ids.others.every((u) => rowsA.some((r) => r.userId === u && r.role === 'editor')),
    '新加的成员角色也存下来了（不是只存了个空壳）',
    JSON.stringify(rowsA.map((r) => `${r.userId}:${r.role}`)),
  )

  /* ---------- 3. 复合主键：同一个人在两个库里不能互相误伤 ---------- */
  console.log('\n== 同一个人的改动不能串到别的知识库 ==')
  /**
   * 挑一个**不是创建者**的人来验。
   * 创建者是 admin，而 admin 也是 bookB 的创建者 —— 拿他当样本的话，
   * B 库里那行本来就是 owner，跟「有没有串库」毫无关系，测的是别的东西。
   */
  const bookB = await p0.evaluate(([a, others]) => {
    const s = window.__yqStore.getState()
    const who = others[0]
    const bid = s.createBook('s1', '完整性 B ' + Date.now().toString(36))
    window.__yqStore.getState().addBookMembers(bid, [who], 'reader')
    return { bookB: bid, meId: who }
  }, [ids, ids.others])
  await p0.waitForTimeout(4000)

  const checkB1 = await boot()
  const bRow1 = (checkB1.data.bookMembers || []).find((r) => r.bookId === bookB.bookB && r.userId === bookB.meId)
  ok(bRow1?.role === 'reader', '前置：B 库里那个人确实是 reader', String(bRow1?.role))

  // 把 A 库里那个人的角色改成 admin，B 库里必须**纹丝不动**
  await p0.evaluate(([a, meId]) => {
    window.__yqStore.getState().updateMemberRole(a.bookA, meId, 'admin')
  }, [ids, bookB.meId])
  await p0.waitForTimeout(4000)

  const base3 = await boot()
  const inA = (base3.data.bookMembers || []).find((r) => r.bookId === ids.bookA && r.userId === bookB.meId)
  const inB = (base3.data.bookMembers || []).find((r) => r.bookId === bookB.bookB && r.userId === bookB.meId)
  ok(inA?.role === 'admin', 'A 库里的角色确实改成了 admin', String(inA?.role))
  ok(inB?.role === 'reader', 'B 库里同一个人的角色没被顺手改掉（复合主键没串）', String(inB?.role))

  /* ---------- 4. 从一个库移出，不能连带删掉别的库 ---------- */
  console.log('\n== 从一个知识库移出成员，不能连带删掉他在别的库的成员身份 ==')
  await p0.evaluate(([bid, meId]) => {
    window.__yqStore.getState().removeBookMember(bid, meId)
  }, [bookB.bookB, bookB.meId])
  await p0.waitForTimeout(4000)

  const base4 = await boot()
  const bRows4 = (base4.data.bookMembers || []).filter((r) => r.bookId === bookB.bookB)
  const stillInA = (base4.data.bookMembers || []).some((r) => r.bookId === ids.bookA && r.userId === bookB.meId)
  const goneInB = !bRows4.some((r) => r.userId === bookB.meId)
  ok(goneInB, 'B 库里那一行确实删掉了', '还在：' + JSON.stringify(bRows4.map((r) => r.userId)))
  ok(stillInA, 'A 库里的成员身份还在（删除没有按 userId 误伤）', '被连带删了')

  /* ---------- 5. 远端的移除要能落到本地 ---------- */
  console.log('\n== 别人那边把成员移出，这边要跟着变 ==')
  const other = await (await browser.newContext()).newPage()
  await other.goto(BASE, { waitUntil: 'domcontentloaded' })
  await other.waitForSelector('.yq-login-card', { timeout: 25000 })
  await other.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await other.fill('.yq-login-card input[type="password"]', PW)
  await other.click('.yq-login-submit')
  await other.waitForSelector('.yq-app', { timeout: 30000 })
  await other.waitForTimeout(2000)

  // 服务端直接删一行，模拟「另一台设备上有人移出了他」
  const victim = ids.others[0]
  await fetch(`${BASE}/api/sync/push`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      upsert: {},
      remove: { bookMembers: [`${ids.bookA}::${victim}`] },
    }),
  })
  // 这边的轮询要把增量取回来
  await p0.evaluate(() => window.dispatchEvent(new Event('focus')))
  await p0.waitForTimeout(5000)

  const localGone = await p0.evaluate(
    ([a, v]) => !window.__yqStore.getState().getBookMembers(a).some((m) => m.id === v),
    [ids.bookA, victim],
  )
  ok(localGone, '本地也把那行移除了（复合键的 remove 落到了正确的桶里）')
  await other.close()
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  try { await browser.close() } catch { /* 已关 */ }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
