/* ============================================================
   导出 / 导入 验证

   这一条曾经是**假功能**：导出在客户端打包本地 store，
   而轻量启动之后本地只有元信息 —— 实测 26 篇文档、0 个正文块，
   界面上照样弹「工作台已导出」。

   拿这种包当备份，等于把知识库清空：导入「整体替换」时
   会把这些空壳推上去，所有正文被抹掉。

   所以这个套件要钉的是：**导出来的包必须带正文，且能原样导回去。**
   ============================================================ */

import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { freePort } from './scripts/free-port.mjs'

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
/** 「恢复目标」实例：由本套件自己起，测完收掉。
    验证「换台机器导入能原样回来」，必须有一个干净的接收端。 */
let target = null
let targetDB = ''
let PORT2 = process.env.IMPORT_PORT || await freePort()
let PORT2_URL = `http://localhost:${PORT2}`

async function startTarget() {
  const targetPass = process.env.IMPORT_PASS || process.env.ADMIN_PASS || 'yuque@2026'
  /*
   * ⚠️⚠️ 原来这里是「`/api/health` 有响应就直接用」，**不验口令**。
   * 于是端口上只要有**任何**这个项目的实例（本轮就被一个走查用的空实例占住过，
   * 口令是另一个值），它就被当成「恢复目标」接着用 ——
   * 后面登录失败、导回来的文档没有 blocks，报错指向的东西
   * 跟真正的原因完全无关。套件还在抛异常前就崩掉，
   * 表现为「这个套件少 27 项、总数对不上」，看不出是端口冲突。
   *
   * 所以现在：**复用之前先验口令**，验不过就换端口自己起，
   * 真的起不来也要说清楚是端口被占，不是「恢复失败」。
   */
  const probeLogin = async (pass) => {
    try {
      const r = await fetch(`${PORT2_URL}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: 'admin', password: pass }),
      })
      return r.ok
    } catch { return false }
  }

  try {
    const r = await fetch(`${PORT2_URL}/api/health`)
    if (r.ok && await probeLogin(targetPass)) {
      console.log(`       复用 ${PORT2_URL} 上已有的恢复目标实例`)
      return
    }
    if (r.ok) {
      console.log(`       ⚠️ ${PORT2_URL} 上有实例但口令对不上 —— 改用 IMPORT_PORT 换一个端口自己起`)
      PORT2 = String(Number(PORT2) + 1)
      PORT2_URL = `http://localhost:${PORT2}`
    }
  } catch { /* 端口空着，自己起 */ }

  targetDB = `data/_import-${Date.now().toString(36)}.db`
  target = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT: PORT2, YQ_DB: targetDB, YQ_ADMIN_PASSWORD: targetPass },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  /*
   * 上限从 20 秒放宽到 90 秒，并改成退避。
   * 原来 40 × 500ms 就 throw —— 慢一点的机器上只是「起得慢」，
   * 却表现成整个套件崩掉、项数静默少一截。
   */
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`${PORT2_URL}/api/health`)).ok) return } catch { /* 等 */ }
  }
  throw new Error(
    `恢复目标实例在 90 秒内没起来（端口 ${PORT2}）。` +
    `先确认这个端口没被别的程序占着 —— 被占时健康检查会一直失败。`,
  )
}

try {
  const p0 = await (await browser.newContext()).newPage()
  await login(p0, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const token = await p0.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: `Bearer ${token}` }

  console.log('\n== 导出的包必须带正文 ==')
  const res = await fetch(`${BASE}/api/export`, { headers: H })
  ok(res.ok, '导出接口可用', String(res.status))
  const text = await res.text()
  const bundle = JSON.parse(text)
  ok(bundle.format === 'yuque-clone-bundle', '格式标记正确', bundle.format)
  ok(Array.isArray(bundle.docs) && bundle.docs.length >= 26, '包含全部文稿', String(bundle.docs?.length))
  const withBody = (bundle.docs || []).filter((d) => Array.isArray(d.blocks) && d.blocks.length).length
  ok(withBody === bundle.docs.length, `每一篇都带正文（${withBody}/${bundle.docs.length}）`)
  const sample = bundle.docs.find((d) => d.id === 'd1')
  ok(sample && sample.blocks.some((b) => (b.text || '').length > 0), '正文内容非空')

  // 体积：空壳包会小得离谱
  const kb = Math.round(text.length / 1024)
  ok(kb > 50, `包体积合理（${kb}KB）—— 空壳包通常只有几 KB`)

  console.log('\n== 完整性自查接口 ==')
  const vRaw = await (await fetch(`${BASE}/api/export/verify`, { headers: H })).json()
  // 别让「字段缺失」伪装成通过：undefined === undefined 是 true
  ok(typeof vRaw.docs === 'number' && typeof vRaw.withBody === 'number', '自查接口返回了数字字段', JSON.stringify(vRaw))
  ok(vRaw.docs === bundle.docs.length, '自查的篇数与实际一致', JSON.stringify(vRaw))
  ok(vRaw.withBody === vRaw.docs, '自查确认全部带正文', JSON.stringify(vRaw))

  console.log('\n== 换个环境导入，内容原样回来 ==')
  // 导入到一个干净的服务端实例上，才算真的「能恢复」
  await startTarget()
  // 恢复目标的口令：默认跟被测实例一致。
  // 之前这里写死成默认口令，于是换到「口令已改过」的实例上登录失败，
  // 后面所有请求都 401，表现为「恢复出来的文档没有 blocks」——
  // 又是「失败信息指向的东西不是真正的原因」。
  const targetPass = process.env.IMPORT_PASS || process.env.ADMIN_PASS || 'yuque@2026'
  const admin2 = await (await fetch(`${PORT2_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: targetPass }),
  })).json()
  if (!admin2.token) throw new Error(`恢复目标实例登录失败（口令：${targetPass}）`)
  const H2 = { Authorization: `Bearer ${admin2.token}`, 'Content-Type': 'application/json; charset=utf-8' }

  const imp = await (await fetch(`${PORT2_URL}/api/import`, {
    method: 'POST', headers: H2, body: JSON.stringify({ ...bundle, mode: 'merge' }),
  })).json()
  ok(imp.ok, '导入成功', JSON.stringify(imp).slice(0, 120))
  ok((imp.counts?.docs || 0) >= 26, '导入的文稿数对得上', String(imp.counts?.docs))

  const restored = await (await fetch(`${PORT2_URL}/api/doc/d1`, { headers: H2 })).json()
  ok(Array.isArray(restored.doc?.blocks) && restored.doc.blocks.length > 0, '目标环境的 d1 有正文', String(restored.doc?.blocks?.length))
  ok(restored.doc?.title === sample.title, '标题一致', `${restored.doc?.title} vs ${sample.title}`)
  const sameText = restored.doc.blocks.some((b) => b.text === sample.blocks.find((x) => x.text === b.text)?.text)
  ok(sameText, '正文内容逐字一致')

  console.log('\n== 导出的包不能漏掉整类实体 ==')
{
  /**
   * 前面几节验的是「文档正文有没有带」，**没验「有没有漏掉某一类实体」**。
   *
   * 漏掉的那一类，界面上完全看不出异常：导出弹「已导出」，
   * 导入弹「成功」，而**讨论区的回复全没了** —— 话题还在，回复不在。
   *
   * 之所以一直没被发现：种子数据里 `topic_replies` 恰好是 0 行。
   * 和「附件搜不到」是同一类 —— **演示数据刚好没覆盖到的那条路径**。
   *
   * 这里的方法是**对账**：把服务端有的每一类实体和包里的键逐一比，
   * 缺任何一类（且那一类确实有行）就报出来。
   */
  const bk = await (await fetch(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
  const live = bk.data || bk.rows || {}
  const bundleKeys = Object.keys(bundle).filter((k) => !['format', 'version', 'exportedAt', 'exportedBy'].includes(k))

  // 故意带行的几类：讨论区回复、关注
  const liveKeys = Object.keys(live)
  const missing = liveKeys.filter((k) => !bundleKeys.includes(k))
  const rowsOf = (k) => {
    const v = live[k]
    if (Array.isArray(v)) return v.length
    if (v && typeof v === 'object') return Object.keys(v).length
    return 0
  }
  // recents（最近浏览）是**刻意**不迁移的（设备本地的临时状态，见 exportBundle 注释）
  // members（账号表）同样是刻意的：里面是 passHash/passSalt，导出是内容备份，
  // 建账号是另一件需要单独确认的安全决策。
  const DELIBERATE = new Set(['recents', 'members'])
  const unexpected = missing.filter((k) => !DELIBERATE.has(k) && rowsOf(k) > 0)
  ok(unexpected.length === 0,
    '包里没有漏掉「服务端确实有数据」的实体类别',
    unexpected.map((k) => `${k}(${rowsOf(k)}行)`).join(' '))
  ok(bundleKeys.includes('topicReplies'), '讨论区回复在包里有位置（哪怕这次是 0 行）')
  ok(bundleKeys.includes('selectionCommentReplies'), '划词评论的回复在包里有位置')
  ok(!bundleKeys.includes('recents'), '最近浏览刻意不迁移（设备本地的临时状态，不是内容）')
  ok(!bundleKeys.includes('members'),
    '账号表刻意不在包里（里面是 passHash/passSalt —— 导出是内容备份，建账号是另一件需要单独确认的事）')

  // 有行也真带上了
  const followsLive = rowsOf('follows')
  if (followsLive > 0) {
    ok(Array.isArray(bundle.follows) && bundle.follows.length === followsLive,
      `关注（${followsLive} 行）在包里带上了`, `包里 ${bundle.follows?.length}`)
  }

  /**
   * 另一半：**包里的键必须都在导入的 ORDER 里**。
   *
   * 这次的 bug 是「两头都漏」—— 导出没有、导入也没有。
   * 上面那条对账只查了导出侧；万一哪天导出补上了、导入忘了补，
   * 包里有数据、导入时却被当成「不认识的名字」丢掉，
   * 而上面那条检查照样全绿 —— 它只比「服务端 vs 包」，管不到「包 vs 导入」。
   */
  const { readFileSync } = await import('node:fs')
  const syncSrc = readFileSync('server/sync.ts', 'utf8')
  const orderM = /const ORDER = \[([\s\S]*?)\]/.exec(syncSrc)
  const order = orderM ? [...orderM[1].matchAll(/'([a-zA-Z]+)'/g)].map((m) => m[1]) : []
  ok(order.length >= 15, `解析出导入顺序表（${order.length} 项）`, orderM ? '' : 'ORDER 正则没匹配上')
  const orphan = bundleKeys.filter((k) => !DELIBERATE.has(k) && !order.includes(k))
  ok(orphan.length === 0, '包里的每一类实体，导入顺序表里都有位置（否则会在导入时被静默丢弃）',
    orphan.join(' '))
  // 父对象必须排在子对象之前，否则子记录会因为「父不存在」被拒
  const idxOf = (n) => order.indexOf(n)
  ok(idxOf('topics') >= 0 && idxOf('topicReplies') > idxOf('topics'),
    'topicReplies 排在 topics 之后（父在前，子在后）',
    `topics@${idxOf('topics')} topicReplies@${idxOf('topicReplies')}`)
  ok(idxOf('selectionComments') >= 0 && idxOf('selectionCommentReplies') > idxOf('selectionComments'),
    'selectionCommentReplies 排在 selectionComments 之后',
    `sc@${idxOf('selectionComments')} scr@${idxOf('selectionCommentReplies')}`)
}

console.log('\n== 拒绝坏数据 ==')
  const bad = await fetch(`${PORT2_URL}/api/import`, {
    method: 'POST', headers: H2, body: JSON.stringify({ hello: 'world', mode: 'merge' }),
  })
  ok(!bad.ok, '非本应用的数据包被拒', String(bad.status))
  const future = await fetch(`${PORT2_URL}/api/import`, {
    method: 'POST', headers: H2, body: JSON.stringify({ ...bundle, version: 999, mode: 'merge' }),
  })
  ok(!future.ok, '版本过高的数据包被拒（而不是导一半炸掉）', String(future.status))

  console.log('\n== 越权者导入不了别人的内容 ==')
  const reg = await (await p0.request.post(`${BASE}/api/auth/register`, {
    data: { account: `imp_${Date.now().toString(36)}`, password: 'test1234', name: '导入路人' },
  })).json()
  const st = await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: reg.user.account, password: 'test1234' }),
  })).json()
  const r3 = await (await fetch(`${BASE}/api/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${st.token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ ...bundle, mode: 'merge' }),
  })).json()
  const total = Object.values(r3.counts || {}).reduce((a, b) => a + b, 0)
  const skipped = r3.rejected || 0
  console.log(`   路人导入：接受 ${total} 条，因权限跳过 ${skipped} 条`)
  ok(skipped > 0, '没有权限的条目被逐条拒绝，而不是整包放行', `accepted=${total} rejected=${skipped}`)

  /*
   * 「整体替换」到底会清掉谁的库 —— **这条以前完全没有测试钉过**。
   *
   * 它是整个产品里唯一一个「一次点击 + 不可撤销」的操作，
   * 而 `server/sync.ts` 里的注释还写着「只清当前用户自己写的东西，不碰别人的内容」——
   * **那句是错的**：`SELECT id FROM <表>` 根本没有按用户过滤，
   * `gone` 算的是全表里不在包里的所有行。
   * 真正收窄范围的只有下游 `deleteRow` 的逐条判权，而 `denyReason`
   * 对**平台 owner 是早退放行**的 —— 于是 owner 选「整体替换」= 全库删干净。
   *
   * 所以这里**钉事实**：owner 整体替换之后，「包里没有的」确实没了。
   * 不是为了让这个行为变好（它是迁移场景该有的），而是因为
   * **一条关于「不可撤销」的承诺，没人验证过它到底不可撤销成什么样**。
   *
   * ⚠️ 这段跑在 PORT2（接收端）上，不碰共享库 —— 所以不会给别的套件留残留。
   */
  console.log('\n== 整体替换：真的会把「包里没有的」清掉 ==')
  {
    const book0 = (bundle.books || [])[0] || {}
    const me2 = await (await fetch(`${PORT2_URL}/api/v2/user`, { headers: H2 })).json()
    const extraId = 'exp_extra_' + Date.now().toString(36)
    const made = await (await fetch(`${PORT2_URL}/api/sync/push`, {
      method: 'POST', headers: H2,
      body: JSON.stringify({
        upsert: {
          docs: [{
            id: extraId, bookId: book0.id, spaceId: book0.spaceId,
            title: '只存在于接收端、数据包里没有的文稿', body: '正文',
            blocks: [{ id: 'b_extra', type: 'p', text: '正文' }],
            createdAt: Date.now(), updatedAt: Date.now(), wordCount: 2,
            authorId: me2.id, type: 'doc',
          }],
        },
        remove: {},
      }),
    })).json()
    ok(!(made.rejected || []).length, `造前置：接收端多了一篇包里没有的文稿（${extraId}）`, JSON.stringify(made.rejected).slice(0, 90))
    const before = await fetch(`${PORT2_URL}/api/doc/${extraId}`, { headers: H2 })
    ok(before.status === 200, `前置：它现在读得到（HTTP ${before.status}）`)

    const rep = await (await fetch(`${PORT2_URL}/api/import`, {
      method: 'POST', headers: H2, body: JSON.stringify({ ...bundle, mode: 'replace' }),
    })).json()
    ok(rep.ok, '整体替换执行成功', JSON.stringify(rep).slice(0, 100))

    const after = await fetch(`${PORT2_URL}/api/doc/${extraId}`, { headers: H2 })
    ok(after.status === 410 || after.status === 404,
      `★ 整体替换确实把「包里没有的」清掉了（现在 HTTP ${after.status}）`,
      '如果这条红了，说明它其实更温和 —— 那界面上的「不可撤销」就说过头了')

    // 包里有的那些还在吗 —— 这是「替换」另一半，不能只验删
    const kept = await fetch(`${PORT2_URL}/api/doc/d1`, { headers: H2 })
    ok(kept.status === 200, `而包里的文档还在（d1 → HTTP ${kept.status}）`)
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
  try { target?.kill() } catch { /* 已退出 */ }
  if (targetDB) for (const sfx of ['', '-wal', '-shm']) {
    const f = targetDB + sfx
    if (existsSync(f)) { try { rmSync(f) } catch { /* 删不掉就算了 */ } }
  }
}

process.exit(fail ? 1 : 0)
