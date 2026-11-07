/* ============================================================
   讨论区：回复是真存的
   ------------------------------------------------------------
   这一页以前是**整个假的**，而且四处都假得不一样：

   1. 回复列表是组件里写死的 `SEED_REPLIES`（5 条），只活在 useState 里 ——
      刷新就没、换设备看不见、发出去的东西存不住。
      界面上却和真评论长得一模一样。
   2. 「赞」按钮**根本没有 onClick**。纯装饰，点下去什么都不发生。
   3. 条数写的是 `replies.length + topic.replyCount` —— 把本地假回复数和
      种子里的历史值相加，是在编数字。而 Dashboard / 发现 / 小记 / 顶栏
      这 4 处也都在直接显示 `topic.replyCount`。
   4. 正文那句「这个问题没有标准答案」是**写死的**，每个话题都一样，
      包括标题为「Q3 OKR 初稿征求意见」的那个。

   这个套件钉住修复后的行为：回复落库、跨设备看得见、重启后还在、
   条数是真数、假按钮没了、没权限的人看不见。
   ============================================================ */

import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { chromium } from 'playwright'

const PORT = process.env.TOPIC_PORT || await freePort()
const BASE = `http://localhost:${PORT}`
const DB = `data/_topic-${Date.now().toString(36)}.db`
const PW = 'topic-test@2026'
const SUF = Date.now().toString(36)

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const start = () => spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0' },
  stdio: ['ignore', 'ignore', 'ignore'],
})
let kid = start()

const json = async (p, opt = {}) => {
  const res = await fetch(BASE + p, opt)
  const t = await res.text()
  try { return { status: res.status, data: t ? JSON.parse(t) : null } } catch { return { status: res.status, data: null } }
}
const post = (p, body, tk) => json(p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: 'Bearer ' + tk } : {}) },
  body: JSON.stringify(body || {}),
})
const waitUp = async () => {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`${BASE}/api/health`)).ok) return true } catch { /* 等 */ }
  }
  return false
}

try {
  await waitUp()

  console.log('\n== 新库里讨论区是空的（不是 5 条假回复）==')
  const admin = (await post('/api/auth/login', { account: 'admin', password: PW })).data
  const T = admin.token
  const H = { Authorization: 'Bearer ' + T, 'Content-Type': 'application/json' }

  const boot = (await json('/api/bootstrap?lite=0', { headers: H })).data
  const sid = (boot.data.spaces || [])[0]?.id
  ok(!!sid, '拿到个人空间 id', String(sid))

  // YQ_DEMO=0 的全新库里没有话题，先造一个
  const topicId = 'tp_' + SUF
  const pushed = await post('/api/sync/push', {
    upsert: { topics: [{ id: topicId, spaceId: sid, title: '这个回复存得住吗', authorId: admin.user.id, createdAt: 1, replyCount: 99, participants: [admin.user.id], hot: false }] },
    remove: {},
  }, T)
  ok(pushed.status === 200, '能建话题', String(pushed.status))

  const boot2 = (await json('/api/bootstrap?lite=0', { headers: H })).data
  ok((boot2.data.topicReplies || []).length === 0, '全新库里讨论区回复是空的（以前那 5 条是组件里写死的）',
    JSON.stringify(boot2.data.topicReplies))

  console.log('\n== 发出去要真的存住 ==')
  const replyId = 'tr_' + SUF
  const pushReply = await post('/api/sync/push', {
    upsert: { topicReplies: [{ id: replyId, topicId, authorId: admin.user.id, text: '存住了吗', createdAt: Date.now() }] },
    remove: {},
  }, T)
  ok(pushReply.status === 200, '推一条回复不报错', String(pushReply.status))
  ok(!JSON.stringify(pushReply.data || {}).includes('缺少主键'), '没被当成「缺少主键」静默丢掉', JSON.stringify(pushReply.data).slice(0, 200))

  const boot3 = (await json('/api/bootstrap?lite=0', { headers: H })).data
  const got = (boot3.data.topicReplies || []).filter((r) => r.topicId === topicId)
  ok(got.length === 1, '回读能拿到这一条', String(got.length))
  ok(got[0]?.text === '存住了吗' && got[0]?.authorId === admin.user.id, '正文和作者都对', JSON.stringify(got[0]))

  console.log('\n== 权限：不在空间里的人看不到 ==')
  const out = (await post('/api/auth/register', { account: `tp_out_${SUF}`, password: 'test1234', name: `路人${SUF}` })).data
  ok(!!out?.token, '注册一个路人账号')
  const outBoot = (await json('/api/bootstrap?lite=0', { headers: { Authorization: 'Bearer ' + out.token } })).data
  ok(!(outBoot.data.topics || []).some((t) => t.id === topicId), '路人看不到这个话题', JSON.stringify((outBoot.data.topics || []).map((t) => t.id)))
  ok(!(outBoot.data.topicReplies || []).some((r) => r.id === replyId), '路人拿不到这个话题的回复（权限跟父话题走）',
    JSON.stringify(outBoot.data.topicReplies))

  console.log('\n== 重启之后还在 ==')
  try { kid.kill() } catch { /* 已退出 */ }
  await new Promise((r) => setTimeout(r, 800))
  kid = start()
  await waitUp()
  const admin2 = (await post('/api/auth/login', { account: 'admin', password: PW })).data
  const boot4 = (await json('/api/bootstrap?lite=0', { headers: { Authorization: 'Bearer ' + admin2.token } })).data
  ok((boot4.data.topicReplies || []).some((r) => r.id === replyId), '重启后回复还在（真的落库了）',
    JSON.stringify(boot4.data.topicReplies))

  console.log('\n== 界面上是真数据 ==')
  const br = await chromium.launch()
  const ctxA = await br.newContext()
  const p1 = await ctxA.newPage()
  await p1.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p1.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p1.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p1.fill('.yq-login-card input[type="password"]', PW)
  await p1.click('.yq-login-submit')
  await p1.waitForSelector('.yq-app', { timeout: 30000 })
  await p1.waitForTimeout(1500)
  await p1.goto(`${BASE}/#/knowledge/${topicId}`, { waitUntil: 'domcontentloaded' })
  await p1.waitForSelector('.yq-topic-title', { timeout: 20000 })
  await p1.waitForTimeout(600)

  // 种子里这个话题的 replyCount 写的是 99，而真实回复只有 1 条。
  // 显示 99 就是编数字 —— 这条断言专门盯这个。
  const meta = (await p1.locator('.yq-topic-meta').textContent().catch(() => '')) || ''
  ok(/1 条回复/.test(meta), `条数用的是真数而不是 replyCount=99（显示「${meta.replace(/\s+/g, ' ').trim()}」）`, meta.trim())
  ok(!/99/.test(meta), '没有把种子里那个 99 显示出来', meta.trim())

  const bodyText = (await p1.locator('.yq-topic-replies').textContent().catch(() => '')) || ''
  ok(bodyText.includes('存住了吗'), '真实回复渲染出来了')
  // 以前写死的那段正文
  ok(!/这个问题没有标准答案/.test(await p1.content()), '写死的正文被去掉了（每个话题都显示同一段话是假的）')

  // 「赞」按钮以前没有 onClick，点了什么都不发生
  ok((await p1.locator('.yq-topic-reply button:has-text("赞")').count()) === 0, '点不动的「赞」按钮已经去掉')

  console.log('\n== 界面发的回复要活过刷新 ==')
  await p1.fill('.yq-topic-input', '这条是界面上发的')
  await p1.click('.yq-topic-composer button:has-text("发表回复")')
  await p1.waitForTimeout(1200)
  ok((await p1.locator('.yq-topic-reply:has-text("这条是界面上发的")').count()) === 1, '发出去立刻能看到')

  // 关键的一步：刷新。以前这里就没了。
  await p1.reload({ waitUntil: 'domcontentloaded' })
  await p1.waitForSelector('.yq-topic-reply', { timeout: 20000 })
  await p1.waitForTimeout(600)
  ok((await p1.locator('.yq-topic-reply:has-text("这条是界面上发的")').count()) === 1,
    '刷新之后还在（以前是 useState，刷新必丢）')

  const afterReload = (await p1.locator('.yq-topic-meta').textContent().catch(() => '')) || ''
  ok(/2 条回复/.test(afterReload), `刷新后条数变成 2（显示「${afterReload.replace(/\s+/g, ' ').trim()}」）`, afterReload.trim())

  console.log('\n== 换一台设备也看得见 ==')
  // 新 context 的 localStorage 是空的，不先登录会被 AppGate 直接挡在登录页 ——
  // 症状是「等了 25 秒没等到回复」，看着像同步没生效，其实是压根没登录。
  const ctxB = await br.newContext()
  const p2 = await ctxB.newPage()
  await p2.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p2.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p2.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p2.fill('.yq-login-card input[type="password"]', PW)
  await p2.click('.yq-login-submit')
  await p2.waitForSelector('.yq-app', { timeout: 30000 })
  await p2.waitForTimeout(1200)
  await p2.goto(`${BASE}/#/knowledge/${topicId}`, { waitUntil: 'domcontentloaded' })
  await p2.waitForSelector('.yq-topic-reply', { timeout: 25000 })
  await p2.waitForTimeout(800)
  ok((await p2.locator('.yq-topic-reply:has-text("这条是界面上发的")').count()) === 1,
    '另一台设备也看得见（服务端返回的，不是本地的）')
  ok((await p2.locator('.yq-topic-reply').count()) === 2, '另一台设备上是 2 条，不是只有 1 条（数据完整）',
    String(await p2.locator('.yq-topic-reply').count()))

  await br.close()
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  try { kid.kill() } catch { /* 已退出 */ }
  /**
   * 清理必须**说实话**。
   *
   * SQLite 的 `-wal` / `-shm` 文件在进程刚被杀后还会被短暂占用，
   * 这时 rmSync 会抛 EPERM/EBUSY。之前这里写的是 `catch {}` 吞掉，
   * 于是每次跑完都留下几个库 —— 而套件照样报「全通过」。
   * 吞掉的清理失败等于谎称干净。
   */
  await new Promise((r) => setTimeout(r, 500))
  const left = []
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (!existsSync(f)) continue
    try { rmSync(f, { force: true }) } catch { left.push(f) }
  }
  if (left.length || existsSync(DB)) {
    console.log(`  WARN  临时库没删干净（服务刚退出时文件还被占用）：${left.join(', ')}`)
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
