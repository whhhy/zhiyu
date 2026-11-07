/*
 * 文档级写操作的权限（2026-10-12 补）
 *
 * ============================================================
 * 补的是同一个病的**漏掉的一层**
 * ============================================================
 * 目录树的删/改名/移动早就有 `bookEditBlocked`（2026-10-12 上一轮补的），
 * 而**文档这一层从来没接过**：探针实测（真服务端，reader 与 visitor 各一轮）
 *
 *   lockDoc               → 返回 true、本地锁上了、服务端 lock 仍是 null、顶栏挂 1 条
 *   updateDoc{published}  → 本地 true、服务端仍是 false、顶栏挂 1 条
 *   updateDoc{slug}       → 本地改了、服务端没改、顶栏挂 1 条
 *   deleteDoc             → **文档从树上消失、进了本地回收站**，服务端还放着，顶栏挂 4 条
 *
 * deleteDoc 最重：用户看到「已移入回收站」，实际服务端没删 ——
 * 他既删不掉，也恢复不了（那条告警推不动）。
 *
 * ============================================================
 * 判据怎么写才不会自己骗自己
 * ============================================================
 * · 三档角色都测：**visitor / reader / editor**。
 *   只测前两档会漏掉「反向约束」—— 加了守卫之后**有编辑权的人还必须照常用得了**，
 *   而这是「功能没了」的方向，比假动作更难被发现。
 * · 反向样本是 **editor 但不是 owner**（他不是文档作者，正好也验了分享那一道）。
 * · 钉的是**行为**（store 改没改、顶栏挂没挂、服务端收没收），
 *   界面上按钮的禁用态另测一条，但不让它承担主要判断。
 * · 分享弹窗只卡**改访问权限**那部分：复制链接是读，谁都能用 ——
 *   整条禁用分享就是「功能没了」。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.DOC_WRITE_PERMS_PORT || await freePort()
const DB = 'data/_docwriteperm.db'
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

const login = async (page, a, pw) => {
  await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 25000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', a)
  await page.fill('.yq-login-card input[type="password"]', pw)
  await page.click('.yq-login-submit')
  await page.waitForSelector('.yq-app', { timeout: 30000 })
  await page.waitForTimeout(1800)
}

const P = (over = {}) => ({ read: true, comment: true, edit: false, create: false, export: false, share: false, ...over })

try {
  const br = await chromium.launch()
  try {
    const admin = await (await br.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
    await login(admin, 'admin', 'yuque@2026')
    const AH = {
      Authorization: 'Bearer ' + await admin.evaluate(() => localStorage.getItem('yq_token')),
      'Content-Type': 'application/json; charset=utf-8',
    }

    const made = await admin.evaluate(() => {
      const s = window.__yqStore.getState()
      const sfx = Date.now().toString(36)
      const b = s.createBook('s1', '文档写权限 ' + sfx)
      const mk = (t) => {
        const d = window.__yqStore.getState().createDoc(b, null, t)
        window.__yqStore.getState().setDocBlocks(d, [{ id: 'bk_1', type: 'p', text: '正文。' }])
        return d
      }
      return { b, dMain: mk('主文档 ' + sfx), dDel: mk('待删文档 ' + sfx), sfx }
    })

    // 必须等服务端**真的有这个库**再推成员行（外键对不上会报得很误导）
    for (let i = 0; i < 30; i++) {
      const bo = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
      if ((bo.data.books || []).some((x) => x.id === made.b)) break
      await admin.waitForTimeout(500)
    }

    const mk = async (key, role, perms) => {
      const acct = `dw_${key}_${made.sfx}`
      const reg = await (await admin.request.post(`${BASE}/api/auth/register`, {
        data: { account: acct, password: 'test1234', name: `${key} 同事` },
      })).json()
      await admin.request.post(`${BASE}/api/sync/push`, {
        headers: AH,
        data: { upsert: { bookMembers: [{ bookId: made.b, userId: reg.user.id, role, perms, joinedAt: Date.now() }] } },
      })
      return acct
    }
    const visitorAcct = await mk('visitor', 'visitor', P({ comment: false }))
    const readerAcct = await mk('reader', 'reader', P())
    // ⚠️ 反向样本：editor，但**不是 owner、也不是文档作者**
    const editorAcct = await mk('editor', 'editor', P({ edit: true, create: true }))
    await admin.waitForTimeout(5000)

    const srvDoc = async (token, docId) => {
      const r = await admin.request.get(`${BASE}/api/doc/${docId}`, { headers: { Authorization: 'Bearer ' + token } })
      if (!r.ok()) return null
      const j = await r.json()
      return j?.doc || j?.data || j
    }

    for (const R of [
      { key: 'visitor', acct: visitorAcct, canEdit: false },
      { key: 'reader', acct: readerAcct, canEdit: false },
      { key: 'editor', acct: editorAcct, canEdit: true },
    ]) {
      const pg = await (await br.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
      const errs = []
      pg.on('pageerror', (e) => errs.push(String(e.message).slice(0, 80)))
      await login(pg, R.acct, 'test1234')
      await pg.goto(`${BASE}/#/book/${made.b}/doc/${made.dMain}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(4500)
      const RT = await pg.evaluate(() => localStorage.getItem('yq_token'))
      const banner = async () => pg.evaluate(() => {
        const m = document.body.innerText.match(/(\d+)\s*处修改没有保存/)
        return m ? m[0] : '(无告警)'
      })

      console.log(`\n== ${R.key}（${R.canEdit ? '有编辑权' : '没有编辑权'}）==`)

      /* ---------- 界面：菜单里那几个写操作要按判据禁用 ---------- */
      {
        await pg.locator('.yq-doc-more').first().click({ timeout: 8000 })
        await pg.waitForTimeout(900)
        const items = await pg.evaluate(() =>
          [...document.querySelectorAll('.yq-menu-item')].map((b) => ({
            t: (b.innerText || '').trim().replace(/\s+/g, ' '),
            off: b.classList.contains('is-disabled') || b.disabled === true,
          })).filter((x) => x.t))
        const find = (re) => items.find((i) => re.test(i.t))
        for (const [label, re] of [
          ['锁定文档', /锁定文档|解锁文档/],
          ['标记为「已发布」', /「已发布」/],
          ['文档设置', /文档设置/],
          ['删除文档', /删除文档/],
        ]) {
          const it = find(re)
          ok(!!it && it.off === !R.canEdit, `${label}：${it ? (it.off ? '已禁用' : '可点') : '菜单里没有'}${it && it.off === !R.canEdit ? '' : ` ← 期望${R.canEdit ? '可点' : '禁用'}`}`)
        }
        // 读的那几项必须**照常可点** —— 不能为了关写按钮把读也关了
        for (const [label, re] of [['查看引用', /查看引用|收起引用/], ['历史版本', /历史版本/]]) {
          const it = find(re)
          ok(!!it && !it.off, `${label}照常可点（是读，不能跟着一起关掉）`)
        }
        await pg.keyboard.press('Escape')
        await pg.waitForTimeout(400)
      }

      /* ---------- store 第二道：四个写操作 ---------- */
      {
        // slug 用 ASCII：服务端对它做归一化（小写、空格转连字符），
        // 拿中文原样去比对会「对不上」—— 那是判据的问题，不是产品的。
        const NEW_SLUG = 'renamed-by-editor'
        const r = await pg.evaluate(([main, del, slug]) => {
          const s = window.__yqStore.getState()
          const lockRet = s.lockDoc(main)
          s.updateDoc(main, { published: true })
          s.updateDoc(main, { slug })
          s.deleteDoc(del)
          const st = window.__yqStore.getState()
          return {
            lockRet,
            lock: st.docs[main]?.lock ?? null,
            published: st.docs[main]?.published ?? false,
            slug: st.docs[main]?.slug ?? '',
            delGone: !(del in st.docs),
            delInTrash: st.trash.some((t) => t.docId === del),
          }
        }, [made.dMain, made.dDel, NEW_SLUG])
        await pg.waitForTimeout(7000)

        if (!R.canEdit) {
          ok(r.lockRet === false && r.lock === null, `lockDoc 被拒（返回 ${r.lockRet}，本地 lock=${JSON.stringify(r.lock)}）`)
          ok(r.published === false, `updateDoc{published} 被拒（本地 published=${r.published}）`)
          ok(r.slug === '', `updateDoc{slug} 被拒（本地 slug=${JSON.stringify(r.slug)}）`)
          ok(!r.delGone && !r.delInTrash, 'deleteDoc 被拒（文档还在，也没进回收站）')
          ok(await banner() === '(无告警)', `顶栏没有留下修不好的告警（${await banner()}）`)
          const sd = await srvDoc(RT, made.dDel)
          ok(!!sd, '服务端那篇待删文档还在（没被误删）')
        } else {
          ok(r.lockRet === true && !!r.lock, 'lockDoc 成功（反向：有编辑权的人必须还能锁）')
          ok(r.published === true, 'updateDoc{published} 成功（反向）')
          ok(r.slug === NEW_SLUG, `updateDoc{slug} 成功（反向）（本地实际 ${JSON.stringify(r.slug)}）`)
          ok(r.delGone && r.delInTrash, 'deleteDoc 成功（反向：本地确实删掉了）')
          const sd = await srvDoc(RT, made.dMain)
          ok(!!sd?.lock, '服务端收到了锁（不只是本地改了）')
          ok(sd?.published === true, '服务端收到了「已发布」标记')
          ok(sd?.slug === NEW_SLUG, `服务端收到了新的路径（${JSON.stringify(sd?.slug)}）`)
        }
      }

      /* ---------- 分享弹窗：只有【作者本人】能改访问权限，复制链接谁都能用 ----------
       *
       * ⚠️ 判据是**作者**，不是「有没有编辑权」—— 服务端 `denyReason` 那一条写的是
       * 「只有作者本人能改这篇的可见性」，editor 也不行
       * （否则同事一推，作者自己就再也看不见自己那篇了）。
       * 第一版我按 `canEdit` 写期望，于是把正确行为判成了失败。
       */
      {
        await pg.goto(`${BASE}/#/book/${made.b}/doc/${made.dMain}`, { waitUntil: 'domcontentloaded' })
        await pg.waitForSelector('.yq-app', { timeout: 25000 })
        await pg.waitForTimeout(3500)
        await pg.locator('.yq-doc-share-primary').first().click({ timeout: 8000 })
        await pg.waitForTimeout(1200)
        ok(await pg.evaluate(() => !!document.querySelector('.yq-share')), '分享弹窗对所有人都开得了（复制链接是读）')
        const radios = await pg.evaluate(() =>
          [...document.querySelectorAll('.yq-share-opts input[type=radio]')].map((i) => i.disabled))
        ok(radios.length > 0, `可见性选项在（${radios.length} 项）`)
        ok(radios.every(Boolean), `可见性选项全禁用（${R.key} 是别人写的这篇，不是作者）`)
        await pg.keyboard.press('Escape')
        await pg.waitForTimeout(500)

        /* 反向：换成**他自己建的**那一篇，他既是作者又有编辑权 → 必须能改 */
        if (R.canEdit) {
          const own = await pg.evaluate(async () => {
            const s = window.__yqStore.getState()
            const b = s.books[0]?.id
            if (!b) return null
            const d = s.createDoc(b, null, '我自己建的 ' + Date.now().toString(36))
            window.__yqStore.getState().setDocBlocks(d, [{ id: 'bk_1', type: 'p', text: '正文。' }])
            return d
          })
          if (own) {
            // 等它真的落库，刷新后才有服务端那份
            for (let i = 0; i < 20; i++) {
              const sd = await srvDoc(RT, own)
              if (sd) break
              await pg.waitForTimeout(500)
            }
            await pg.goto(`${BASE}/#/book/${made.b}/doc/${own}`, { waitUntil: 'domcontentloaded' })
            await pg.waitForSelector('.yq-app', { timeout: 25000 })
            await pg.waitForTimeout(4000)
            await pg.locator('.yq-doc-share-primary').first().click({ timeout: 8000 })
            await pg.waitForTimeout(1200)
            const own2 = await pg.evaluate(() =>
              [...document.querySelectorAll('.yq-share-opts input[type=radio]')].map((i) => i.disabled))
            ok(own2.length > 0 && own2.some((d) => !d),
              `自己写的文档，可见性选项**可改**（${own2.filter(Boolean).length}/${own2.length} 禁用）`)
            await pg.keyboard.press('Escape')
            await pg.waitForTimeout(400)
          }
        }
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