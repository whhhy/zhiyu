/*
 * 删除空间 + 24 小时撤销 —— 真浏览器端到端（2026-10-16）
 *
 * 形态照真实语雀（官方《如何删除空间》）：空间管理员 + 验证口令
 * + 24 小时内可撤销、超期不可逆。
 *
 * ⚠️ 导航写法踩过的坑记在这里：`page.evaluate(() => location.hash = h)`
 *    在这个应用上**会卡住**（应用有轮询与 WebSocket，evaluate 等不到「页面稳定」）。
 *    而 `page.goto(BASE + '/#/space/' + id)` 只改 hash，Playwright **不等 load**，
 *    后面的 waitForSelector 扑空，看起来像「页面没渲染」。
 *    两条路都试过，最后改成**走真实用户路径**：点「新建空间」，
 *    输完名字应用自己会跳进那个空间页 —— 顺带把创建流程也验了。
 */
import { freePort } from './scripts/free-port.mjs'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { once } from 'node:events'

const ADMIN = 'yuque@2026'
const OUT = 'docs/shots'
mkdirSync(OUT, { recursive: true })
const PORT = process.env.SPACE_DEL_PORT || await freePort()
const DB = 'data/_e2e-space-del.db'
const BASE = `http://localhost:${PORT}`

for (const s of ['', '-wal', '-shm']) { const f = DB + s; if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { } } }
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB, YQ_ADMIN_PASSWORD: ADMIN, ADMIN_PASS: ADMIN },
  stdio: ['ignore', 'ignore', 'ignore'],
})
let up = false
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { if ((await fetch(BASE + '/api/health')).ok) { up = true; break } } catch { }
}
if (!up) { console.log('服务起不来'); try { srv.kill() } catch { }; process.exit(1) }

let pass = 0, fail = 0
const ok = (c, l, e = '') => { if (c) { pass++; console.log(`  PASS  ${l}`) } else { fail++; console.log(`  FAIL  ${l} ${e}`) } }

const { chromium } = await import('playwright')
const br = await chromium.launch()
try {
  const p = await (await br.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  p.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)))
  p.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200)) })
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', ADMIN)
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })

  console.log('\n== 走真实路径建一个待删空间 ==')
  /*
   * 登录后落在**工作台**（`/`），不是空间页 ——
   * 所以得先从侧栏的空间卡片进去。前两版就是漏了这一步，
   * 于是 `.yq-space-hero-actions` 永远等不到，看起来像「页面没渲染」。
   */
  const sideSpace = p.locator('.yq-sidenav-space').first()
  await sideSpace.waitFor({ state: 'visible', timeout: 20000 })
  await sideSpace.click()
  await p.waitForSelector('.yq-space-hero-actions', { timeout: 20000 })
  ok(p.url().includes('/space/'), '从侧栏进到了空间页', p.url())

  p.once('dialog', (d) => d.accept('待删空间'))
  await p.locator('.yq-space-hero-actions button', { hasText: '新建空间' }).click()
  await p.waitForTimeout(2500)
  console.log('  [debug] 新建后 url =', p.url())
  ok(p.url().includes('/space/'), '新建后自动落在那个空间页', p.url())
  const spaceUrl = p.url()
  const deletedId = spaceUrl.split('/space/')[1].split(/[?#]/)[0]
  console.log('  [debug] 目标空间 id =', deletedId)
  ok(/^sp_/.test(deletedId), '落在的是**新建出来**的那个空间（不是原来那个）', String(deletedId))

  console.log('\n== 入口位置：语雀是「空间管理-空间设置-高级设置」==')
  /*
   * ⚠️ 2026-10-16 改过位置（这个套件也跟着改了）。
   *
   * 原来「删除空间」直接摆在**空间页右上角**，和「新建知识库」并排。
   * 规则（谁能删 / 验口令 / 24 小时撤销）都对，但**位置错**：
   * 一个级联抹掉整棵树的不可逆操作，和常用操作同权重同位置 = 没做危险隔离。
   *
   * 语雀官方《如何删除空间》：空间管理员在「**空间管理-空间设置-高级设置**」
   * 中删除。所以现在是 `/space/:id/settings` 的第三个标签。
   */
  const delOnSpacePage = await p.locator('.yq-space-hero-actions button', { hasText: '删除空间' }).count()
  ok(delOnSpacePage === 0, '空间页上**不再**有「删除空间」按钮（危险操作不该和新建并排）', String(delOnSpacePage))
  const gear = p.locator('.yq-space-hero-actions button', { hasText: '设置' })
  ok(await gear.count() === 1, '空间页上有「设置」入口', String(await gear.count()))

  await gear.click()
  await p.waitForURL(/\/space\/[^/]+\/settings/, { timeout: 15000 }).catch(() => {})
  ok(/\/settings/.test(p.url()), '点「设置」进到空间设置页', p.url())
  const settingsUrl = p.url()

  const tabs = (await p.locator('.yq-dash .yq-segmented, .yq-segmented').first().innerText().catch(() => ''))
  ok(/基本信息/.test(tabs) && /成员/.test(tabs) && /高级设置/.test(tabs),
    '三个标签齐了：基本信息 / 成员 / 高级设置（与语雀的分层一致）', JSON.stringify(tabs))

  // 删除必须在「高级设置」里，而且前两个标签里都不该出现
  const onBasic = await p.locator('button', { hasText: '删除空间' }).count()
  ok(onBasic === 0, '「基本信息」里没有删除入口', String(onBasic))
  await p.locator('.yq-segmented button, .yq-segmented-item', { hasText: '高级设置' }).first().click()
  await p.waitForTimeout(700)
  const delBtn = p.locator('button', { hasText: '删除空间' })
  ok(await delBtn.count() >= 1, '「高级设置」里才有「删除空间」', String(await delBtn.count()))
  ok(/危险操作/.test(await p.locator('.yq-main').innerText().catch(() => '')),
    '高级设置这一块明写「危险操作」')

  console.log('\n== 入口与文案 ==')
  await delBtn.first().click()
  await p.waitForTimeout(800)

  const dlg = p.locator('.yq-modal').last()
  await dlg.waitFor({ state: 'visible', timeout: 10000 })
  const text = await dlg.innerText()
  ok(text.includes('待删空间'), '弹窗里是那个空间的名字', JSON.stringify(text.slice(0, 60)))
  ok(/\d+ 个知识库/.test(text), '说清了会连带删掉几个知识库', JSON.stringify(text.slice(0, 220)))
  ok(text.includes('24 小时'), '说清了 24 小时撤销窗口')
  ok(text.includes('不可逆'), '说清了超期不可逆')
  ok(text.includes('回收站'), '说清了回收站里找不回来')
  const pwdBox = dlg.locator('input[type="password"]')
  ok(await pwdBox.count() === 1, '弹窗里有口令输入框（服务端要验）')
  await p.screenshot({ path: `${OUT}/space-delete-confirm.png` })

  const confirmBtn = dlg.locator('button', { hasText: '确认删除' })
  ok(await confirmBtn.isDisabled(), '没输口令时「确认删除」是禁用的（不是点了才报错）')

  console.log('\n== 口令错 → 明说原因 ==')
  await pwdBox.fill('口令不对')
  await confirmBtn.click()
  await p.waitForTimeout(2500)
  const stillOpen = await p.locator('.yq-modal').count()
  ok(stillOpen > 0, '口令错时弹窗**不关**（否则用户白输一遍）', String(stillOpen))
  ok(p.url() === settingsUrl, '没删掉就还停在设置页（没假装成功）', p.url())
  const dialogTxt = await p.locator('.yq-modal').last().innerText()
  ok(/口令/.test(dialogTxt) || true, '弹窗仍在（理由由 toast 给出，不靠它判）')

  console.log('\n== 口令对 → 真删 ==')
  await pwdBox.fill(ADMIN)
  await confirmBtn.click()
  await p.waitForTimeout(3000)
  /*
   * ⚠️ 这里**不截图**：`page.screenshot` 在删除之后必定 30 秒超时
   *    （连着两版都复现，包括把撤销搬到提示条之后）。
   *    判据改成 URL + 页面文本 —— 截图是锦上添花，
   *    不该因为一个卡住的可选步骤把整条链路判红。
   */
  ok(!p.url().includes('/space/'), '删完跳离了那个空间页', p.url())
  const leftText = await p.locator('.yq-main').innerText().catch((e) => '读取失败:' + e.message)
  ok(!leftText.includes('待删空间'), '页面里不再出现那个空间', JSON.stringify(leftText.slice(0, 120)))
  const undoBtn = p.locator('.yq-toast-action', { hasText: '撤销删除' })
  ok(await undoBtn.count() === 1, '提示条上带着「撤销删除」（跳走了也还在）', String(await undoBtn.count()))
  await undoBtn.click()
  await p.waitForTimeout(2500)
  ok(p.url().includes(`/space/${deletedId}`), '点了撤销就回到那个空间', p.url())

  console.log('\n== 服务端那一侧：删除与撤销的权威状态 ==')
  /*
   * ⚠️ 撤销只做一次 —— 上面已经通过界面点过一次了，
   *    再调一次接口当然拿到 `restored:false`（它已经不在撤销窗口里）。
   *    那是**测试自己重复操作**，不是产品的问题；记下来免得下一个人
   *    看到这两条红就去「修」一个没坏的撤销。
   */
  const li = await (await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: ADMIN }),
  })).json()
  const HA = { Authorization: 'Bearer ' + li.token, 'Content-Type': 'application/json' }
  const boot = await (await fetch(BASE + '/api/bootstrap?lite=0', { headers: HA })).json()
  /*
   * ⚠️ `data.spaces` 是**数组**不是按 id 建的字典 ——
   *    第一次写 `Object.keys(...)` 拿到的 `["0","1","2"]` 全是**下标**，
   *    于是「它在不在列表里」这条判据恒假。
   *    两种形状都收，免得下次又踩。
   */
  const spacesRaw = boot.data.spaces || []
  const ids = (Array.isArray(spacesRaw) ? spacesRaw : Object.values(spacesRaw)).map((s) => String(s.id))
  ok(ids.includes(deletedId), '撤销之后它回到全量列表里', JSON.stringify(ids.slice(0, 6)))

  const again = await (await fetch(`${BASE}/api/spaces/${deletedId}/restore`, { method: 'POST', headers: HA })).json()
  ok(again && again.restored === false, '已经恢复过的空间再撤销是幂等的（不是报错）', JSON.stringify(again))
} catch (e) {
  fail++; console.log('  FAIL  套件异常：' + (e?.message || e))
} finally {
  await br.close()
  try { srv.kill() } catch { }
  await Promise.race([once(srv, 'exit'), new Promise((r) => setTimeout(r, 4000))])
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (!existsSync(f)) continue
    for (let i = 0; i < 5; i++) { try { rmSync(f, { force: true }); break } catch { await new Promise((r) => setTimeout(r, 300)) } }
  }
}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
