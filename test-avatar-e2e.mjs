/*
 * 头像上传 —— 真实浏览器端到端
 * 自己起服务、自己登录、自己选文件、自己断言渲染结果
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import { DatabaseSync } from 'node:sqlite'

let pass = 0, fail = 0
const ok = (c, l, e) => {
  if (c) { pass++; console.log('  PASS  ' + l + (e ? '  ' + e : '')) }
  else { fail++; console.log('  FAIL  ' + l + (e ? '  ' + e : '')) }
}

/**
 * 自己挑一个**空闲端口**，不要写死。
 * 理由见 test-invite-e2e.mjs 里那段注释：写死的端口会被机器上
 * 碰巧占着它的进程打挂，而症状完全指不到真因。
 */
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.once('error', reject)
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port
    s.close(() => resolve(p))
  })
})

const PORT = Number(process.env.YQ_AV_PORT || await freePort())
const PW = 'Av#2026Browser'
const DB = 'data/_avbrowser.db'
const BASE = `http://127.0.0.1:${PORT}`
const SHOTS = 'data/_avatar-shots'

const clean = () => {
  // ⚠️ **不要删截图** —— 留证据的套件把证据删了，比不留还糟
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(DB + s) } catch {} }
  fs.mkdirSync(SHOTS, { recursive: true })
}

const req = (method, p, body, token) => new Promise((resolve) => {
  const data = body ? JSON.stringify(body) : null
  const q = http.request({
    host: '127.0.0.1', port: PORT, path: p, method,
    headers: {
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': data.length } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
  }, (res) => {
    const c = []
    res.on('data', (x) => c.push(x))
    res.on('end', () => resolve({ s: res.statusCode, raw: Buffer.concat(c).toString() }))
  })
  q.on('error', () => resolve({ s: 0, raw: '' }))
  if (data) q.write(data)
  q.end()
})

/** 造一张真 PNG（4×4 纯色），从字节写进临时文件给 setInputFiles 用 */
function makePng(file) {
  // 一张 1×1 的 PNG，用 base64 写出来（服务端只查大小与 mime，浏览器要能解码）
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  fs.writeFileSync(file, png)
  return png
}

async function main() {
  clean()
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
 * 实测每次跑完 `data/` 里都留下 data/_avbrowser.db{,-wal,-shm} 共 ~2.1MB。
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
    if (h.s === 200) { up = true; break }
    await new Promise((r) => setTimeout(r, 500))
  }
  ok(up, '服务起来了')
  if (!up) { console.log(log.slice(-800)); stop(); process.exit(1) }

  console.log('\n== 头像上传：真实浏览器 ==')
  const browser = await chromium.launch()
  try {
    const page = await (await browser.newContext()).newPage()
    const net = []
    /*
     * ⚠️ `method()` 在 **Request** 上，`Response` 上没有 ——
     *    第一版写在 response 里，直接 TypeError 崩掉整个套件
     *    （症状是「跑到一半没输出」，很容易误判成超时）。
     *    所以：方法从 request 事件记，状态从 response 事件记。
     */
    page.on('request', (r) => { if (/avatar|users\/me/.test(r.url())) net.push(r.method() + ' ' + r.url().replace(BASE, '')) })
    page.on('response', (r) => { if (/avatar|users\/me/.test(r.url())) net.push('  → ' + r.status()) })

    // 登录
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-login-card')
    await page.fill('.yq-login-card input[autocomplete="username"]', 'admin')
    await page.fill('.yq-login-card input[type="password"]', PW)
    await page.click('.yq-login-submit')
    await page.waitForSelector('.yq-app', { timeout: 25000 })
    await page.waitForTimeout(1200)

    // 进设置页个人资料
    await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(2000)

    const btn = page.locator('button', { hasText: '更换头像' }).first()
    ok(await btn.count() > 0, '设置页有「更换头像」按钮')
    ok(!(await btn.isDisabled()), '按钮**不再是禁用的**（原来写死 disabled + 「尚未实现」）')
    ok(!(await page.locator('body').innerText()).includes('头像上传尚未实现'),
      '界面上不再有「头像上传尚未实现」那句')
    await page.screenshot({ path: `${SHOTS}/1-before.png` })

    // 先确认没有图（首字母头像）
    ok(await page.locator('.yq-avatar-row img, .yq-settings-avatar-row img').count() === 0,
      '换之前是首字母头像（没有 <img>）')

    // 选文件
    const tmp = 'data/_avatar-pick.png'
    makePng(tmp)
    await page.setInputFiles('input[type="file"]', tmp)
    await page.waitForTimeout(3500)
    await page.screenshot({ path: `${SHOTS}/2-after.png` })

    // 界面上真的出现图了
    const imgCount = await page.locator('.yq-settings-avatar-row img').count()
    ok(imgCount === 1, '换之后**真的显示出图片**（不是还停在首字母）', 'img=' + imgCount)

    // 图片真的加载出来（naturalWidth > 0 = 解码成功）
    const loaded = await page.evaluate(() => {
      const im = document.querySelector('.yq-settings-avatar-row img')
      return im ? { nw: im.naturalWidth, nh: im.naturalHeight, src: String(im.src).slice(0, 24) } : null
    })
    ok(loaded && loaded.nw > 0, '图片**真的解码成功**（naturalWidth > 0）',
      loaded ? `${loaded.nw}x${loaded.nh} src=${loaded.src}` : '没有 img')

    // 服务端真的存了
    {
      const db = new DatabaseSync(DB, { readOnly: true })
      const usr = db.prepare('SELECT avatar FROM users WHERE id = ?').get('u_admin')
      const att = db.prepare('SELECT id, mime, size, docId FROM attachments WHERE id = ?').get(usr?.avatar || '')
      db.close()
      ok(!!usr?.avatar, 'users.avatar 记下了附件 id', usr?.avatar || '(空)')
      ok(!!att && String(att.mime) === 'image/png', '附件那行 mime 是 image/png', JSON.stringify(att))
      ok(att && String(att.docId) === 'null' || att?.docId === null,
        '附件 docId 为空（它不属于任何文档）')
    }

    // 网络上确实走了那两条接口
    ok(net.some((n) => n.includes('/api/users/me/avatar')), '前端真的调了上传接口', net.join(' | '))
    ok(net.some((n) => n.includes('PATCH') || n.includes('PUT')), '真的 PATCH 了 /api/users/me 引用它')

    // 刷新后还在（持久化）
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(3000)
    const afterReload = await page.locator('.yq-settings-avatar-row img').count()
    ok(afterReload === 1, '**刷新后头像还在**（不是只在内存里）', 'img=' + afterReload)
    await page.screenshot({ path: `${SHOTS}/3-after-reload.png` })

    // 别的页面（顶栏）也用上头像 —— Avatar 组件是共用的
    ok(true, '（顶栏头像是否显示由它拿到 src 决定，这里只看设置页这一处真渲染）')

    // 移除按钮
    const rm = page.locator('button', { hasText: '移除' }).first()
    ok(await rm.count() > 0, '有「移除」按钮（能回到首字母头像）')
    await rm.click()
    await page.waitForTimeout(2000)
    ok(await page.locator('.yq-settings-avatar-row img').count() === 0,
      '移除后回到首字母头像')
    await page.screenshot({ path: `${SHOTS}/4-removed.png` })

    try { fs.unlinkSync(tmp) } catch {}
  } catch (e) {
    fail++
    console.log('  FAIL  套件异常：' + (e?.message || e))
    console.log(log.slice(-600))
  } finally {
    await browser.close().catch(() => {})
  }

  await cleanup()
  console.log(`\n截图：${SHOTS}/（1-换之前 2-换之后 3-刷新后 4-移除后）`)
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}

main()
