/* ============================================================
   服务不可达：宁可停下来，也不能拿本地数据顶上
   ------------------------------------------------------------
   之前 probe() 一失败就静默回落本地模式，后果链条是：

     服务重启的 2 秒空窗
       → 用户看到的是**本地那份数据**（甚至演示种子）
       → SyncStatus 因为「本地模式」**不显示任何离线提示**
       → 用户以为在编辑真实知识库，照常写了一通
       → 服务恢复后重新进 AppGate，第 33 行 clearLocalSnapshot()
       → **他这期间的修改被直接删掉**

   一次网络抖动造成真实数据丢失，而且全程界面上看不出任何异常。

   这个套件把整条链路走一遍：登录 → 停服务 → 刷新 → 重开 → 恢复。
   ============================================================ */

import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, extname, normalize } from 'node:path'
import { chromium } from 'playwright'

const PORT = process.env.OFFLINE_PORT || await freePort()
const BASE = `http://localhost:${PORT}`
const DB = `data/_offline-${Date.now().toString(36)}.db`
const PW = 'offline-test@2026'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const startServer = () => spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0' },
  stdio: ['ignore', 'ignore', 'ignore'],
})
let kid = startServer()
const waitUp = async (base = BASE) => {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`${base}/api/health`)).ok) return true } catch { /* 等 */ }
  }
  return false
}

/**
 * 一个「nginx 式」的前置：静态资源由它托管，`/api` 才转发给后端。
 *
 * 这才是「服务端不可达」在真实部署里的样子 —— DEPLOY.md 第四节支持反代部署，
 * 静态资源和后端是两个进程：**后端挂了静态还在，页面能加载，
 * 而 `/api/health` 直接 404**。只杀掉应用服务器是测不到这个的，
 * 因为那样连页面本身都加载不出来，浏览器直接给网络错误页。
 */
let backend = ''
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' }
function createStaticOnlyServer() {
  const srv = createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      if (!backend) { res.writeHead(502); res.end('upstream down'); return }
      try {
        // Authorization 必须转发：不转发的话 me() 会 401，
        // 用户点完「重试」被弹回登录页 —— 那是**代理**的问题，不是应用的
        const hdr = { 'Content-Type': req.headers['content-type'] || 'application/json' }
        if (req.headers.authorization) hdr.Authorization = String(req.headers.authorization)
        const chunks = []
        for await (const c of req) chunks.push(c)
        const r = await fetch(backend + req.url, {
          method: req.method,
          headers: hdr,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
        })
        const buf = Buffer.from(await r.arrayBuffer())
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') || 'application/json' })
        res.end(buf)
      } catch { res.writeHead(502); res.end('upstream down') }
      return
    }
    let p = normalize(req.url.split('?')[0])
    if (p === '/' || p === '\\') p = '/index.html'
    const file = join('dist', p)
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, srv })))
}

const startLiveServer = () => {
  const port = String(Number(PORT) + 1)
  const p = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT: port, YQ_DB: DB + '2', YQ_ADMIN_PASSWORD: PW, YQ_DEMO: '0' },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  liveKid = p
  return `http://127.0.0.1:${port}`
}

let br
let deadSrv = null
let liveKid = null
try {
  ok(await waitUp(), '服务起来了')

  console.log('\n== 先正常登录一次 ==')
  br = await chromium.launch()
  const ctx = await br.newContext()
  const p = await ctx.newPage()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', PW)
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.waitForTimeout(1200)
  ok(true, '登录成功，应用打开了')
  const token = await p.evaluate(() => localStorage.getItem('yq_token') || '')
  ok(!!token, '浏览器里有令牌（这是「本来有服务端」的证据）')

  console.log('\n== 把后端「停掉」，但静态资源还在 ==')
  /**
   * 怎么才算「服务端不可达」？最直接的想法是杀掉服务再刷新 ——
   * 但那测不到：**这个应用是由服务端托管的**，服务一停，
   * 页面本身就加载不出来，浏览器直接给一个网络错误页，压根进不到应用。
   *
   * 真实可达的路径是**反代**：nginx 托管 dist/ 静态资源，只把 /api 转发给后端。
   * 后端挂了静态还在，页面能加载，`/api/health` 却 404 ——
   * probe() 失败，而这时**回落本地模式就是拿假数据冒充真实数据**。
   * DEPLOY.md 第四节明确支持这种部署，所以它是真实场景。
   */
  const dead = await createStaticOnlyServer()
  deadSrv = dead
  const deadBase = `http://127.0.0.1:${dead.port}`

  // 把「这台机器有服务端」的证据带过去：令牌 + 模式标记
  const ctxDead = await br.newContext()
  await ctxDead.addInitScript((tk) => {
    localStorage.setItem('yq_token', tk)
    localStorage.setItem('yq_mode_hint', 'server')
  }, token)
  const pd = await ctxDead.newPage()
  await pd.goto(deadBase, { waitUntil: 'domcontentloaded' })
  await pd.waitForTimeout(5000)   // 探测有 2.5 秒超时，再留点余量

  const bootText = (await pd.locator('.yq-boot-text').first().textContent().catch(() => '')) || ''
  const appVisible = await pd.locator('.yq-app').count()
  ok(/连不上/.test(bootText), '页面显示「连不上知识库服务」', bootText)
  ok(appVisible === 0, '**没有**放行应用（放行就等于拿本地数据冒充真实数据）', `应用节点数 ${appVisible}`)
  const why = (await pd.locator('.yq-offline-why').textContent().catch(() => '')) || ''
  ok(/不会/.test(why) && why.length > 20, '说明了为什么不用本地数据顶替', why.replace(/\s+/g, ' ').slice(0, 100))

  console.log('\n== 后端恢复后点重试能回去 ==')
  /**
   * 代理指回**同一个**后端（同一个库）。
   * 之前我另起了一个「新后端」，结果令牌在新库里不存在，
   * me() 401 → 被弹回登录页 —— 那是测试搭错了，不是应用的问题。
   * 真实场景是：nginx 后面那个应用进程带着同一个数据库回来了。
   */
  backend = BASE
  ok(await waitUp(backend), '后端重新起来了')
  await pd.locator('.yq-boot-retry').click()
  let gotApp = false
  try { await pd.waitForSelector('.yq-app', { timeout: 20000 }); gotApp = true } catch { /* 下面报 */ }
  const after = {
    boot: (await pd.locator('.yq-boot-text').first().textContent().catch(() => '')) || '',
    login: await pd.locator('.yq-login-card').count(),
    app: await pd.locator('.yq-app').count(),
    err: (await pd.locator('.yq-login-err').textContent().catch(() => '')) || '',
  }
  ok(gotApp, '点「重试」后应用正常打开了', JSON.stringify(after))

  console.log('\n== 对照：真的没有服务端记录的人（本地演示）仍然能进 ==')
  const ctx2 = await br.newContext()   // 全新浏览器，没有令牌也没有模式标记
  const p2 = await ctx2.newPage()
  await p2.goto(deadBase, { waitUntil: 'domcontentloaded' })
  await p2.waitForTimeout(5000)
  const p2text = (await p2.locator('body').textContent().catch(() => '')) || ''
  const blocked = /连不上知识库服务/.test(p2text)
  ok(!blocked, '没有服务端记录的人不会被这句挡住（本地演示仍然可用）', p2text.replace(/\s+/g, ' ').slice(0, 80))

  console.log('\n== 会话中途失效：同一条数据丢失链路，更容易撞上 ==')
  /**
   * 之前 401 只做了 setToken(null)，界面**纹丝不动**：应用照常渲染、
   * 写入被静默拒绝、同步提示栏是空的。用户拿到的反馈是**零**。
   *
   * 真实场景里最容易撞上的入口是「办理离职」——
   * 那个动作本来就会清空该同事的全部会话。
   */
  const ctx3 = await br.newContext()
  await ctx3.addInitScript((tk) => {
    localStorage.setItem('yq_token', tk)
    localStorage.setItem('yq_mode_hint', 'server')
  }, token)
  const p3 = await ctx3.newPage()
  await p3.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p3.waitForSelector('.yq-app', { timeout: 30000 })
  await p3.waitForTimeout(1200)
  ok((await p3.locator('.yq-app').count()) === 1, '第二个浏览器用同一个令牌，正常打开')

  // 服务端把这个会话作废（等价于「会话过期」/「被办理离职」）
  const out = await p3.evaluate(async () => {
    const t = localStorage.getItem('yq_token') || ''
    const r = await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + t } })
    return r.status
  })
  ok(out === 200, '服务端把会话作废了', String(out))

  // 触发一次会被拒的写入
  const push = await p3.evaluate(async () => {
    const t = localStorage.getItem('yq_token') || ''
    const r = await fetch('/api/sync/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t },
      body: JSON.stringify({ upsert: { notes: [{ id: 'n_exp', spaceId: 'sp_x', authorId: 'u1', text: '会话过期时写的', createdAt: 1 }] }, remove: {} }),
    })
    return r.status
  })
  ok(push === 401, '过期后的写入被服务端拒了（这一段是对的）', String(push))

  // 界面必须**在若干秒内**把用户送回登录页并说明原因
  let told = false
  for (let i = 0; i < 20 && !told; i++) {
    await p3.waitForTimeout(500)
    const loginN = await p3.locator('.yq-login-card').count()
    if (loginN) {
      const err = (await p3.locator('.yq-login-err').textContent().catch(() => '')) || ''
      told = /过期|重新登录/.test(err)
      if (!told) {
        fail++
        console.log(`  FAIL  回到了登录页但没说原因：「${err.replace(/\s+/g, ' ').slice(0, 80)}」`)
      }
    }
  }
  ok(told, '会话失效后用户被送回登录页，并被告知原因（之前是**零反馈**）')
  ok((await p3.locator('.yq-app').count()) === 0, '不再继续把界面当成「一切正常」')
  ok((await p3.evaluate(() => localStorage.getItem('yq_token'))) === null, '令牌被清掉了')
} catch (e) {
  fail++
  console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  try { br?.close() } catch { /* 已关 */ }
  try { kid?.kill() } catch { /* 已退出 */ }
  try { liveKid?.kill() } catch { /* 已退出 */ }
  try { deadSrv?.srv?.close() } catch { /* 已关 */ }
  await new Promise((r) => setTimeout(r, 400))
  for (const f of [DB, DB + '2']) {
    for (const s of ['', '-wal', '-shm']) if (existsSync(f + s)) { try { rmSync(f + s, { force: true }) } catch { /* 删不掉就算了 */ } }
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
