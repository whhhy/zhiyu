/*
 * 评论与划词评论的权限（2026-10-12 补）
 *
 * ============================================================
 * 补的是**同一个病在评论这一片**上的两处，两处方向还相反
 * ============================================================
 * 服务端对 comments / selectionComments / commentReplies /
 * selectionCommentReplies 这**四个实体**统一按 `caps.comment` 判
 * （`server/sync.ts` 的 isComment 分支），**不是** `edit`。
 * 而这一片界面**一个门都没接**。
 *
 * ① 假动作：visitor（comment=false）在划词面板里照样看到「回复」「标记解决」，
 *    点下去 store 照收、界面立刻变了 → 服务端才拒 →
 *    顶栏常驻「N 处修改没有保存」，**而他自己修不好**。
 *
 * ② 功能没了：划词工具条的渲染条件是 `!editorReadOnly`，而它含 `noEditRight`
 *    （= !caps.edit）。于是 **reader（comment=true、edit=false）连工具条都出不来** ——
 *    服务端明明允许他发划词评论，界面上却一个入口都没有。
 *    这是「功能没了」而不是「假动作」，一样是假的，只是方向相反，
 *    而且管理员只会以为「这功能还没做」。
 *
 * 同一个条件还把「复制」一起藏了 —— 复制根本不需要任何权限。
 *
 * ============================================================
 * 判据怎么写才不会自己骗自己
 * ============================================================
 * · **必须按角色分档测，不能只测一个**。只测 visitor 会漏掉 ②，
 *   只测 reader 会漏掉 ① —— 两个 bug 正好互为反向。
 * · **反向样本要挑「有权限但不是最高权限」那一档**（reader）：
 *   平台超管 / 知识库 owner / 本地模式都不验证判据本身，拿它们当反向样本等于白测。
 * · 判据钉的是**按钮显隐**（可观测行为），不是源码里有没有 `canComment` 字样。
 * · 两道防线各配一条能单独红的：界面看按钮，store 直接调 action 看它有没有偷偷改数据。
 * · 「看别人写的评论」不需要权限 —— 不能为了关写按钮把读也关了。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.COMMENT_PERMS_PORT || await freePort()
const DB = 'data/_cmtperm.db'
const BASE = `http://127.0.0.1:${PORT}`

for (const s of ['', '-wal', '-shm']) {
  const f = DB + s
  if (existsSync(f)) { try { rmSync(f, { force: true }) } catch { /* 锁着就留着删 */ } }
}
if (await fetch(`${BASE}/api/health`).then((r) => r.ok).catch(() => false)) {
  console.error(`端口 ${PORT} 上已经有服务在跑。自起服务会打错目标，结果不可信。`)
  process.exit(1)
}
const srv = spawn(process.execPath, ['--import', './server/alias-hooks.mjs', 'server/index.ts'], {
  env: { ...process.env, PORT, YQ_DB: DB },
  stdio: ['ignore', 'ignore', 'ignore'],
})
let up = false
for (let i = 0; i < 40 && !up; i++) {
  await new Promise((r) => setTimeout(r, 500))
  try { if ((await fetch(`${BASE}/api/health`)).ok) up = true } catch { /* 还没起 */ }
}
if (!up) { console.error('服务没起来'); srv.kill(); process.exit(1) }

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

/**
 * 真实拖选一段文字。
 *
 * ⚠️ 别用三击：`SelectionToolbar` 自己挂了一个「点到外面就收起」的 mousedown 监听，
 * 三击的第 2、3 次按下正好打在文档上 → 工具条刚挂载就被自己收走 →
 * 读出来永远是「没出工具条」，看起来像「权限不给」——
 * 那是探针的手法问题，不是产品的问题。
 */
const dragSelect = async (page, blockText) => {
  const blk = page.locator('[data-block-id]').filter({ hasText: blockText }).first()
  if (!(await blk.count())) return ''
  const box = await blk.boundingBox()
  const y = box.y + Math.min(box.height / 2, 12)
  await page.mouse.move(box.x + 4, y)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 4, y, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(900)
  return page.evaluate(() => window.getSelection()?.toString() || '')
}

const QUOTE = '这一段文字足够长，应该能选中才对。'

const login = async (page, a, pw) => {
  await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 25000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', a)
  await page.fill('.yq-login-card input[type="password"]', pw)
  await page.click('.yq-login-submit')
  await page.waitForSelector('.yq-app', { timeout: 30000 })
  await page.waitForTimeout(1800)
}

try {
  const br = await chromium.launch()
  try {
    const admin = await (await br.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    await login(admin, 'admin', 'yuque@2026')
    const AH = {
      Authorization: 'Bearer ' + await admin.evaluate(() => localStorage.getItem('yq_token')),
      'Content-Type': 'application/json; charset=utf-8',
    }

    const made = await admin.evaluate((q) => {
      const s = window.__yqStore.getState()
      const b = s.createBook('s1', '评论权限 ' + Date.now().toString(36))
      const d = window.__yqStore.getState().createDoc(b, null, '评论权限')
      const s2 = window.__yqStore.getState()
      s2.setDocBlocks(d, [...s2.docs[d].blocks, { id: 'bk_q1', type: 'p', text: q }])
      s2.addSelectionComment(d, q, 'bk_q1', '管理员留的一条划词评论')
      s2.addComment(d, '管理员留的一条评论')
      return { b, d }
    }, QUOTE)

    // ⚠️ 必须等服务端**真的有这个库**再推成员行（见 test-tree-perms 的同一条注释）：
    // createBook 只写本地，那一刻服务端还没有这个库，外键对不上，
    // 报出来的是 FOREIGN KEY constraint failed —— 看着像「加成员这条路坏了」。
    for (let i = 0; i < 30; i++) {
      const bo = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
      if ((bo.data.books || []).some((x) => x.id === made.b)) break
      await admin.waitForTimeout(500)
    }

    const sfx = Date.now().toString(36)
    const mk = async (key, role, comment) => {
      const acct = `ro_cmt_${key}_${sfx}`
      const reg = await (await admin.request.post(`${BASE}/api/auth/register`, {
        data: { account: acct, password: 'test1234', name: `${key} 同事` },
      })).json()
      await admin.request.post(`${BASE}/api/sync/push`, {
        headers: AH,
        data: {
          upsert: {
            bookMembers: [{
              bookId: made.b, userId: reg.user.id, role,
              perms: { read: true, comment, edit: false, create: false, export: false, share: false },
              joinedAt: Date.now(),
            }],
          },
        },
      })
      return acct
    }
    const visitorAcct = await mk('visitor', 'visitor', false)
    const readerAcct = await mk('reader', 'reader', true)
    await admin.waitForTimeout(5000)

    /* ---------- 基准：管理员三个按钮都在 ---------- */
    console.log('\n== 基准：管理员（最高权限）==')
    {
      await admin.goto(`${BASE}/#/book/${made.b}/doc/${made.d}`, { waitUntil: 'domcontentloaded' })
      await admin.waitForSelector('.yq-app', { timeout: 25000 })
      await admin.waitForTimeout(4000)
      const sel = await dragSelect(admin, QUOTE)
      ok(sel.length > 3, `真的选中了正文（${JSON.stringify(sel.slice(0, 8))}…）`)
      ok(await admin.evaluate(() => !!document.querySelector('.yq-selbar')), '工具条出得来')
      const btns = await admin.evaluate(() =>
        [...document.querySelectorAll('.yq-selbar button')].map((b) => b.textContent.trim()).join(' / '))
      ok(/评论/.test(btns), `有「评论」（${btns}）`)
      ok(/存小记/.test(btns), '有「存小记」')
      ok(/⧉/.test(btns), '有「复制」')
    }

    for (const R of [
      { key: 'visitor', acct: visitorAcct, comment: false, canComment: false },
      { key: 'reader', acct: readerAcct, comment: true, canComment: true },
    ]) {
      const pg = await (await br.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
      const errs = []
      pg.on('pageerror', (e) => errs.push(String(e.message).slice(0, 80)))
      await login(pg, R.acct, 'test1234')
      await pg.goto(`${BASE}/#/book/${made.b}/doc/${made.d}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(4500)

      console.log(`\n== ${R.key}（comment=${R.comment}）==`)

      /* ---- 读：面板和工具条本身对所有人开放 ---- */
      await dragSelect(pg, QUOTE)
      ok(await pg.evaluate(() => !!document.querySelector('.yq-selbar')), '选中文字后工具条出得来')
      const barBtns = await pg.evaluate(() =>
        [...document.querySelectorAll('.yq-selbar button')].map((b) => b.textContent.trim()).join(' / '))
      ok(/⧉/.test(barBtns), `「复制」无条件给（${barBtns}）`)
      ok(/评论/.test(barBtns) === R.canComment, `工具条上「评论」${R.canComment ? '在' : '不在'}（判据是文档的 comment）`)

      await pg.locator('.yq-doc-bar-right button', { hasText: '✎' }).first().click({ timeout: 8000 })
      await pg.waitForTimeout(1200)
      ok(await pg.evaluate(() => !!document.querySelector('.yq-selpanel')), '划词面板开得开（看别人的评论是读）')
      const panelTxt = await pg.evaluate(() => document.querySelector('.yq-selpanel')?.innerText || '')
      ok(panelTxt.includes('管理员留的一条划词评论'), '能看到别人写的划词评论')

      /* ---- 写：面板里的写按钮按 comment 显隐 ---- */
      const acts = await pg.evaluate(() =>
        [...document.querySelectorAll('.yq-selpanel .yq-selc-acts button')].map((b) => b.textContent.trim()))
      ok(acts.includes('回复') === R.canComment, `「回复」${R.canComment ? '在' : '不在'}：${acts.join(' / ') || '（一个都没有）'}`)
      ok(acts.includes('标记解决') === R.canComment, `「标记解决」${R.canComment ? '在' : '不在'}`)

      /* ---- 评论面板的输入区 ---- */
      await pg.locator('.yq-doc-comment-btn').first().click({ timeout: 8000 })
      await pg.waitForTimeout(1000)
      if (!(await pg.evaluate(() => !!document.querySelector('.yq-comment')))) {
        await pg.locator('.yq-doc-comment-btn').first().click({ timeout: 8000 })
        await pg.waitForTimeout(1000)
      }
      ok(await pg.evaluate(() => !!document.querySelector('.yq-comment')), '评论面板开得开')
      ok(
        await pg.evaluate(() => !!document.querySelector('.yq-comment-input')) === R.canComment,
        `评论输入区${R.canComment ? '在' : '不在'}`,
      )
      ok(
        await pg.evaluate(() => !!document.querySelector('.yq-comment-text')) ,
        '别人的评论正文照常看得见',
      )

      /* ---- store 第二道：绕过界面直接调，它也必须不改数据 ---- */
      if (!R.canComment) {
        const probe = await pg.evaluate((d) => {
          const s = window.__yqStore.getState()
          const before = JSON.stringify(s.comments[d] || [])
          const beforeSel = JSON.stringify(s.selectionComments[d] || [])
          const id = (s.comments[d] || [])[0]?.id
          s.addComment(d, '绕过界面发的')
          s.addReply(d, id, '绕过界面回的')
          s.addSelectionComment(d, '绕过界面发的划词', 'bk_q1', '绕过界面发的划词')
          if (id) s.replySelectionComment(d, id, '绕过界面回的划词')
          if (id) s.resolveSelectionComment(d, id)
          if (id) s.deleteComment(d, id)
          return {
            commentsChanged: JSON.stringify(window.__yqStore.getState().comments[d] || []) !== before,
            selChanged: JSON.stringify(window.__yqStore.getState().selectionComments[d] || []) !== beforeSel,
          }
        }, made.d)
        await pg.waitForTimeout(5000)
        ok(!probe.commentsChanged, 'store 层也拒了（评论/回复/删除一条都没生效）')
        ok(!probe.selChanged, 'store 层也拒了（划词评论/回复/标记解决一条都没生效）')
        const banner = await pg.evaluate(() => document.body.innerText.includes('处修改没有保存'))
        ok(!banner, '顶栏没有留下「N 处修改没有保存」这种他自己修不好的状态')
        const sc = (await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json())
          .data.selectionComments.filter((c) => c.docId === made.d)
        ok(sc.length === 1, `服务端划词评论仍是 1 条（实到 ${sc.length}）`)
      }

      ok(errs.length === 0, '全程没有异常', errs.join(' | '))
      await pg.close()
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

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)