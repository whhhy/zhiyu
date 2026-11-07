/*
 * 协作邀请 —— 真实浏览器端到端（两个真实账号走完整条路）
 * ============================================================
 * ⚠️ 为什么这个套件存在：
 *   2026-10-11 那几轮里，我反复请用户手动登录去看界面 ——
 *   而**那些口令全是我自己设的临时实例**（admin / 探针口令），
 *   把登录的活推给用户是没道理的。
 *   项目本来就带 playwright：它能自己登录、自己点、自己截图，
 *   证据还比人工看更硬（断言在渲染后的 DOM 上，不是 API 返回值）。
 *
 * ⚠️ 而且这样更值：手动看一次就没了，这个套件**每一轮全量都会跑**，
 *   界面改坏了立刻报红 —— 手动实测做不到这件事。
 *
 * 它验的是「界面真的能用」，而 test-invite 验的是「接口真的对」。
 * 两者互补：接口对了但按钮没接上，只有这个套件能发现。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { DatabaseSync } from 'node:sqlite'

let pass = 0
let fail = 0
const ok = (c, l, e) => {
  if (c) { pass++; console.log('  PASS  ' + l + (e ? '  ' + e : '')) }
  else { fail++; console.log('  FAIL  ' + l + (e ? '  ' + e : '')) }
}

/**
 * 自己挑一个**空闲端口**，不要写死。
 *
 * 实测（2026-10-19 20:54）：这一套用写死的 8111，而那台机器上恰好有个
 * python 程序在 20:33 起了、占着 8111 —— 于是套件**起不来**，
 * runner 那边看到的是「没找到汇总行「结果：N 通过 / M 失败」，
 * 连逐项 PASS/FAIL 都没有，看起来是真的没跑起来」。
 *
 * 那个失败信息**完全指不到真因**（真因是端口冲突，不是功能坏了）。
 * 写死端口的套件，等于把「机器上碰巧跑了什么」变成回归结果的一部分。
 *
 * ⇒ 向操作系统要一个空闲端口（listen(0) 让系统分配），用完立刻释放。
 *    仍有极小的竞态（释放到占用之间），但比写死一个端口可靠得多。
 */
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => resolve(p))
  })
})

const PORT = Number(process.env.YQ_E2E_PORT || await freePort())
const PW = process.env.YQ_E2E_PASS || 'E2e#2026Browser'
const DB = 'data/_e2ebrowser.db'
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = 'data/_e2e-shots'

const clean = () => {
  // ⚠️ **不要删截图**。
  //   第一版 `clean()` 连 `data/_e2e-shots` 一起删了，于是
  //   「跑完了、21 项全绿、一张图都没留下」——
  //   留证据的套件把证据删了，那它比不留还糟。
  //   只清数据库（那才是真临时产物），截图留着给人看。
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s) } catch {} }
  fs.mkdirSync(SHOTS, { recursive: true })
}

const req = (method, p, body, token) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : null
  const r = http.request({
    host: '127.0.0.1', port: PORT, path: p, method,
    headers: {
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
  }, (res) => {
    const c = []
    res.on('data', (x) => c.push(x))
    res.on('end', () => {
      const raw = Buffer.concat(c).toString()
      let j = {}
      try { j = JSON.parse(raw) } catch {}
      resolve({ status: res.statusCode, json: j, raw })
    })
  })
  r.on('error', (e) => resolve({ status: 0, json: {}, raw: e.message }))
  if (data) r.write(data)
  r.end()
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 在页面里登录一个账号（playwright 直接填，不经过用户的浏览器） */
async function login(page, account) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 20000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', account)
  await page.fill('.yq-login-card input[type="password"]', PW)
  await page.click('.yq-login-submit')
  await page.waitForSelector('.yq-app', { timeout: 25000 })
  await page.waitForTimeout(1200)
}

async function main() {
  clean()

  // ---- 起服务 ----
  const child = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', YQ_DB: DB, YQ_ADMIN_PASSWORD: PW },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (b) => { log += b })
  child.stderr.on('data', (b) => { log += b })
  
/* ---- 收摊：等子进程**真的退出**再删库 ----
 *
 * ⚠️ 原来只有 `process.on('exit', stop)`，而 exit 处理器是**同步**的：
 * `child.kill()` 只是发信号，那一刻子进程还活着（Windows 文件锁），
 * `clean()` 里的 unlinkSync 必然失败，又被 `catch {}` 吞掉。
 * 实测每次跑完 `data/` 里都留下 data/_e2ebrowser.db{,-wal,-shm} 共 ~2.1MB。
 * 「有清理代码」和「真的清了」是两回事 —— 尤其当 catch 是空的。
 *
 * 现在：主流程 await 到 exit → 重试删除 → 删不掉就**说出来**；
 * exit 处理器留作兜底（崩溃路径仍然需要它）。
 */
let srvExited = false
child.once('exit', () => { srvExited = true })
const cleanup = async () => {
  if (!srvExited) {
    child.kill()
    for (let i = 0; i < 50 && !srvExited; i++) await new Promise((r) => setTimeout(r, 100))
  }
  clean()                                   // 截图目录不动：它存着证据
  let stuck = []
  for (const s of ['', '-wal', '-shm']) {
    let gone = false
    for (let i = 0; i < 5 && !gone; i++) {
      try { fs.unlinkSync(DB + s); gone = true } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
    if (!gone && fs.existsSync(DB + s)) stuck.push(DB + s)
  }
  if (stuck.length) console.log('  ⚠️  临时库删不掉（服务可能还占着）：' + stuck.join(', '))
}
/* 兜底：崩溃/异常退出时也收一次（那时没法 await，只能尽力） */
const stop = () => { try { child.kill() } catch {} ; clean() }
  process.on('exit', stop)

  let up = false
  for (let i = 0; i < 60; i++) {
    const h = await req('GET', '/api/health')
    if (h.status === 200) { up = true; break }
    await sleep(500)
  }
  if (!up) { console.log('服务没起来\n' + log.slice(-800)); process.exit(1) }

  console.log('\n== 协作邀请：真实浏览器端到端 ==')

  const browser = await chromium.launch()
  try {
    // ================= 第一步：admin 发起邀请 =================
    const adminCtx = await browser.newContext()
    const admin = await adminCtx.newPage()
    await login(admin, 'admin')

    // 找一个「有非成员」的库，并记住它
    const db = new DatabaseSync(DB, { readOnly: true })
    const books = db.prepare('SELECT id,name FROM books').all()
    const users = db.prepare("SELECT id,account,name FROM users WHERE account <> 'admin'").all()
    const memberOf = new Map()
    for (const b of books) {
      memberOf.set(b.id, new Set(
        db.prepare('SELECT userId FROM book_members WHERE bookId=?').all(b.id).map((r) => r.userId),
      ))
    }
    db.close()
    const pick = books.find((b) => users.some((u) => !memberOf.get(b.id).has(u.id)))
    if (!pick) { ok(false, '有可邀请的对象'); return }
    const target = users.find((u) => !memberOf.get(pick.id).has(u.id))
    console.log(`  知识库「${pick.name}」→ 邀请 ${target.account}（${target.name}）\n`)

    // ---- 进设置页的权限 tab ----
    await admin.goto(`${BASE}/#/book/${pick.id}/settings`, { waitUntil: 'domcontentloaded' })
    await admin.waitForTimeout(1500)
    const permBtn = admin.locator('.yq-bset-nav button', { hasText: '权限' }).first()
    ok(await permBtn.count() > 0, '设置页左栏有「权限」这一项')
    await permBtn.click()
    await admin.waitForTimeout(1200)

    // ---- 点「邀请」打开弹窗 ----
    const inviteBtn = admin.locator('.yq-bset-card-head button', { hasText: '邀请' }).first()
    ok(await inviteBtn.count() > 0, '权限页有「邀请」按钮（与「添加成员」并存）')
    ok(await admin.locator('button', { hasText: '添加成员' }).count() > 0,
      '「添加成员」仍然在（两个入口并存，不是替换）')
    await inviteBtn.click()
    await admin.waitForTimeout(900)

    const modal = admin.locator('.yq-modal').first()
    ok(await modal.count() > 0, '点「邀请」弹出弹窗')
    const modalText = await modal.innerText().catch(() => '')
    ok(/不会自动获得权限/.test(modalText),
      '弹窗说清了「对方可以接受也可以拒绝」（不假装是直接加人）')
    ok(await modal.locator('button', { hasText: '发出邀请' }).count() > 0, '弹窗里有「发出邀请」')
    // 默认给最小权限（阅读者）——邀请不该一上来就给人写权限
    const roleDefault = await modal.locator('select').nth(1).inputValue()
    ok(roleDefault === 'reader', '角色默认是**阅读者**（邀请不该一上来就给人写权限）', roleDefault)

    // ---- 选人 + 选角色 + 填话 + 发出 ----
    //
    // ⚠️ 角色**必须显式选**：弹窗默认是「阅读者」，
    //    而下面断言的是 editor。第一版只选了人（select[0]）没选角色，
    //    于是库里 reader、断言 editor 红了 ——
    //    **看着像产品 bug，其实是测试没把要验证的东西选上**。
    await modal.locator('select').nth(0).selectOption({ index: 1 })
    await modal.locator('select').nth(1).selectOption('editor')
    await modal.locator('input').last().fill('这份文档要一起维护')
    await admin.screenshot({ path: `${SHOTS}/1-invite-dialog.png` })
    await modal.locator('button', { hasText: '发出邀请' }).click()
    await admin.waitForTimeout(2000)

    // ---- 发起方能看到「等待对方处理」 ----
    const bodyTxt = await admin.locator('.yq-bset-body').innerText().catch(() => '')
    ok(/等待对方处理/.test(bodyTxt), '**发起方**在权限页看到「等待对方处理」那一块')
    ok(bodyTxt.includes(target.name), '那一块里列出了被邀请的人', target.name)
    ok(/撤回/.test(bodyTxt), '管理员能撤回自己发出去的邀请')
    await admin.screenshot({ path: `${SHOTS}/2-sender-pending.png` })

    // ================= 第二步：另一个人登录，看待办 =================
    const userCtx = await browser.newContext()   // ← 独立上下文 = 另一个人
    const other = await userCtx.newPage()
    await login(other, target.account)

    // ---- 顶栏红点 ----
    const bellDot = other.locator('.yq-bell-dot')
    ok(await bellDot.count() > 0, '**接收方顶栏出现红点**（登录后自动拉待办）')
    await other.screenshot({ path: `${SHOTS}/3-receiver-bell.png` })

    // ---- 点铃铛 → 协作页 ----
    const bell = other.locator('.yq-bell, .yq-topbar-bell').first()
    if (await bell.count() > 0) {
      await bell.click()
      await other.waitForTimeout(1000)
      const panelTxt = await other.locator('.yq-activity').innerText().catch(() => '')
      ok(/邀请你/.test(panelTxt) && panelTxt.includes(pick.name),
        '铃铛面板里能看到这条邀请（谁邀的、进哪个库）', panelTxt.split('\n')[0] || '')
      await other.screenshot({ path: `${SHOTS}/4-bell-panel.png` })
      await other.keyboard.press('Escape')
      await other.waitForTimeout(500)
    } else {
      ok(false, '找得到铃铛按钮')
    }

    // ---- 协作页的接受/拒绝 ----
    await other.goto(`${BASE}/#/?tab=collab`, { waitUntil: 'domcontentloaded' })
    await other.waitForTimeout(1800)
    const collabTxt = await other.locator('.yq-main').innerText().catch(() => '')
    ok(/协作邀请/.test(collabTxt), '协作页渲染出来了（不再是那个恒空的假页面）')
    ok(collabTxt.includes(target.name) || /邀请你/.test(collabTxt),
      '待办里是这条邀请', collabTxt.slice(0, 80))
    ok(await other.locator('button', { hasText: '接受' }).count() > 0, '有「接受」按钮')
    ok(await other.locator('button', { hasText: '拒绝' }).count() > 0, '有「拒绝」按钮')
    await other.screenshot({ path: `${SHOTS}/5-inbox.png` })

    // ---- 点接受 → 应该直接进那个库 ----
    await other.locator('button', { hasText: '接受' }).first().click()
    await other.waitForTimeout(2500)

    const afterUrl = other.url()
    ok(afterUrl.includes(`/book/${pick.id}`),
      '点「接受」后**直接进了那个知识库**（不是只把列表刷一下）', afterUrl)
    // ⚠️ 要等正文渲染完再断言：第一版读完 innerText 就查，
    //    那时候还在骨架屏上，于是「能看到内容」判红 ——
    //    **看着像功能没做，其实是断言跑得太早**。
    await other.waitForTimeout(3000)
    await other.screenshot({ path: `${SHOTS}/6-joined.png` }).catch(() => {})
    const afterTxt = await other.locator('.yq-main').innerText().catch(() => '')
    ok(afterTxt.includes(pick.name), '进去之后能看到知识库内容',
      '实际内容前 120 字：' + afterTxt.slice(0, 120).replace(/\s+/g, ' '))
    await other.screenshot({ path: `${SHOTS}/6-joined.png` })

    // ---- 真的成了成员吗（查服务端，不看界面） ----
    const li = await req('POST', '/api/auth/login', { account: 'admin', password: PW })
    const token = JSON.parse(li.raw).token || ''
    const role = await new Promise((resolve) => {
      const r = http.request({
        host: '127.0.0.1', port: PORT, path: `/api/perms/book/${pick.id}`,
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      }, (res) => {
        const c = []
        res.on('data', (x) => c.push(x))
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(c).toString()).read) } catch { resolve(null) }
        })
      })
      r.on('error', () => resolve(null))
      r.end()
    })
    const d2 = new DatabaseSync(DB, { readOnly: true })
    const mem = d2.prepare('SELECT role FROM book_members WHERE bookId=? AND userId=?')
      .get(pick.id, target.id)
    d2.close()
    ok(!!mem, '服务端 book_members 里**真的多了这一行**（不是只改了界面）',
      mem ? `role=${mem.role}` : '')
    ok(mem?.role === 'editor', '角色是邀请时说的那个（editor）', String(mem?.role))

    // ---- 接受后待办该消失 ----
    await other.reload({ waitUntil: 'domcontentloaded' })
    await other.waitForTimeout(2000)
    const bellAfter = other.locator('.yq-bell-dot')
    ok(await bellAfter.count() === 0, '接受后**红点消失了**（待办真的被消费掉了）')

    /*
     * ⚠️ 这一条是被**截图**逮到的，不是想出来的。
     *
     * 第一版接受之后顺手「乐观补」了一行 book（desc:'' / spaceId:''），
     * 页面是不再显示「🫥 知识库不存在」了 ——
     * 但同步的差分是**逐行 JSON.stringify 比较**，那一行与服务端真数据不同
     * → 判定「本地改了」→ 推上去 → 被服务端拒 →
     * 顶栏从此**常驻「1 处修改没有保存」**。
     *
     * 而那个用户**什么都没改**，他只是接受了一条邀请。
     *
     * **假告警比没有告警更糟**：人会开始无视所有告警，
     * 而下一次真的没保存时他也不会当回事。
     */
    const syncBar = await other.locator('text=处修改没有保存').count()
    ok(syncBar === 0, '接受邀请**不会触发假告警**（「N 处修改没有保存」不该为 0 ——他什么都没改）')
  } catch (e) {
    fail++
    console.log('  FAIL  套件异常：' + (e?.message || e))
    console.log(log.slice(-600))
  } finally {
    await browser.close().catch(() => {})
  }

  await cleanup()
  console.log(`\n截图：${SHOTS}/（1-邀请弹窗 2-发起方待发 3-接收方红点 4-铃铛面板 5-待办页 6-已进库）`)
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main()
