/*
 * 讨论区能「发起话题」（2026-10-12 补）
 *
 * ============================================================
 * 它补的是一个**从来只有一半**的功能
 * ============================================================
 * `topics` 这张表、那个实体（`writable` 七项齐全）、`Topic` 类型、
 * `SHAPE.topics` 同步形状、`replyToTopic` 回复动作、动态流里
 * `what: '发起了话题'` 那一支 —— **全都在**。
 * 唯独没有的是：一个写入路径，和一个按钮。
 *
 * 而**三处文案都承诺了它**：
 *   · `Space.tsx` 的空状态：「同事新建文档、评论或**发起话题**之后会出现在这里」
 *   · `Dashboard.tsx` 的空状态：同一句
 *   · `Help.tsx`：「遇到问题可以直接在讨论区**发帖**」+ 一个「去讨论区」按钮
 *
 * 也就是说：一个**点了没用、但被三处告诉你可以用**的入口。
 * 正确做法是把能力补上（改文案去说「不能发帖」只是把假承诺换成另一句）。
 *
 * ============================================================
 * 三条容易做成「看起来能发、其实发不出去」的地方
 * ============================================================
 * ① 只写进 store 不等于发得出去 —— 必须验**服务端真的收到了**。
 *    `topics` 在同步清单里，但 `replyCount` / `participants` 是 json/bool 列，
 *    序列化哪一步出问题都是「不报错但少东西」。
 * ② 正文是**第一条回复**，不是话题的字段（`Topic` 只有标题）。
 *    只建标题的话，打开详情页是一片空白。
 * ③ 刷新之后必须还在 —— 与本项目最常见的那个形状一模一样
 *    （写进去了但没落库，刷新就回原样）。
 *
 * 自起服务 + 全新库：它要发话题，共享库里不该留别人的讨论。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync, readFileSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.TOPIC_CREATE_PORT || await freePort()
const DB = 'data/_topic.db'
const BASE = `http://127.0.0.1:${PORT}`

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着 */ } }
}
if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在跑 —— 自起服务会打错目标，结果不可信。`)
  process.exit(1)
}
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB },
  stdio: ['ignore', 'ignore', 'ignore'],
})
let up = false
for (let i = 0; i < 40 && !up; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { if ((await fetch(`${BASE}/api/health`)).ok) up = true } catch { /* 等 */ }
}
if (!up) { console.error('服务没起来'); srv.kill(); process.exit(1) }

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

try {
  const br = await chromium.launch()
  try {
    const p = await (await br.newContext({ viewport: { width: 1280, height: 800 } })).newPage()
    await p.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-login-card', { timeout: 25000 })
    await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
    await p.fill('.yq-login-card input[type="password"]', 'yuque@2026')
    await p.click('.yq-login-submit')
    await p.waitForSelector('.yq-app', { timeout: 30000 })
    await p.waitForTimeout(1800)
    const token = await p.evaluate(() => localStorage.getItem('yq_token'))
    const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' }

    const topicsOf = async () => {
      const j = await (await p.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: H })).json()
      return j.data.topics || []
    }
    const before = await topicsOf()
    console.log(`       服务端原有 ${before.length} 个话题`)

    /* ---------- 入口存在 ---------- */
    console.log('\n== 入口在，而且真的点得动 ==')
    /*
     * ⚠️ 路由是 **HashRouter**，所以 `?tab=discuss` 必须写在 `#` **里面**。
     *   写成 `${BASE}/?tab=discuss` 的话那个 query 落在**路径**上，
     *   `useSearchParams` 读的是 hash 里的那段 —— 结果一直停在默认的 `doc` 页，
     *   于是「讨论区没有入口」这个结论是**假的**，红的原因和被测的东西无关。
     *   （这个坑在 HashRouter 下不止一次踩：深路径那回也是它。）
     */
    await p.goto(`${BASE}/#/?tab=discuss`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-app', { timeout: 25000 })
    await p.waitForTimeout(1500)
    ok((await p.evaluate(() => document.body.innerText)).includes('讨论'),
      '真的停在了「讨论」这一页（HashRouter 下 tab 参数要写在 # 里面）')
    const btn = p.locator('button:has-text("发起话题")').first()
    ok(await btn.count() > 0, '讨论区有一个「发起话题」入口（以前一个都没有）')

    await btn.click()
    await p.waitForSelector('#yq-topic-title', { timeout: 8000 })
    ok(true, '点开确实弹出了对话框（不是装饰按钮）')

    /* ---------- 空标题不给发 ---------- */
    console.log('\n== 空标题不许发 ==')
    {
      const disabled = await p.evaluate(() => {
        const b = [...document.querySelectorAll('.yq-modal-footer button, .yq-modal button')]
          .find((e) => (e.textContent || '').trim() === '发起')
        return b ? b.disabled : null
      })
      ok(disabled === true, '标题没填时「发起」是禁用的', String(disabled))
    }

    /* ---------- 真的发出去 ---------- */
    console.log('\n== 真的发得出去，而且服务端收得到 ==')
    const sfx = Date.now().toString(36)
    const TITLE = '这个话题必须真的落库 ' + sfx
    const BODY = '正文会作为第一条回复 ' + sfx
    await p.fill('#yq-topic-title', TITLE)
    await p.fill('#yq-topic-body', BODY)
    await p.locator('.yq-modal button:has-text("发起")').first().click()
    await p.waitForTimeout(1200)
    const toastTxt = await p.evaluate(() =>
      [...document.querySelectorAll('.yq-toast, .yq-toaster')].map((e) => (e.textContent || '').trim()).join(' | '))
    ok(/发起/.test(toastTxt), `提示说的是「发起」而不是别的（${toastTxt || '无'}）`)
    const hash = await p.evaluate(() => location.hash)
    ok(/\/knowledge\//.test(hash), `跳到那条话题的详情页（${hash}）`, hash)

    await p.waitForTimeout(4000)
    const after = await topicsOf()
    const mine = after.find((t) => t.title === TITLE)
    ok(!!mine, '★ 服务端真的收到了这条话题', `服务端话题数 ${before.length} → ${after.length}`)
    ok(mine && mine.authorId === 'u_admin', '发起人记对了', JSON.stringify(mine?.authorId))
    ok(mine && JSON.stringify(mine.participants || []).includes('u_admin'),
      '参与者里有他自己（json 列没丢）', JSON.stringify(mine?.participants))

    /* ---------- 正文落在第一条回复上 ---------- */
    const replies = await p.evaluate((id) =>
      window.__yqStore.getState().topicReplies.filter((r) => r.topicId === id).map((r) => r.text), mine.id)
    ok(replies.some((t) => t.includes(BODY)),
      '★ 正文作为第一条回复存在（Topic 类型只有标题，内容在回复里）', JSON.stringify(replies).slice(0, 90))

    /* ---------- 刷新后还在 ---------- */
    console.log('\n== 刷新之后还在 ==')
    await p.goto(BASE + '/#/?tab=discuss', { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-app', { timeout: 25000 })
    await p.waitForTimeout(3500)
    const listed = await p.evaluate(() => document.body.innerText)
    ok(listed.includes(TITLE), '刷新后讨论区里还能看到它')
    const stillThere = (await topicsOf()).some((t) => t.title === TITLE)
    ok(stillThere, '服务端也还在（不是只在本地）')

    /* ---------- 文案与能力对齐 ---------- */
    console.log('\n== 那三处文案现在是真的 ==')
    {
      const src = readAll(['src/pages/Space.tsx', 'src/pages/Dashboard.tsx', 'src/pages/Help.tsx'])
      ok(/发起话题/.test(src), '空状态/帮助页承诺的「发起话题」现在有对应的 action 了')
      const st = readAll(['src/store/index.ts'])
      ok(/createTopic:/.test(st), 'store 里确实有 createTopic（不是只在界面上摆了个按钮）')
    }
  } finally { await br.close() }
} catch (e) {
  fail++
  console.error('异常：', e.stack || e.message)
} finally {
  const exited = once(srv, 'exit')
  srv.kill()
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))])
  for (const s of ['', '-wal', '-shm']) {
    const f = DB + s
    if (!existsSync(f)) continue
    for (let i = 0; i < 5; i++) {
      try { rmSync(f, { force: true }); break } catch { await new Promise((r) => setTimeout(r, 300)) }
    }
  }
}

function readAll(files) {
  return files.map((f) => readFileSync(f, 'utf8')).join('\n')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)