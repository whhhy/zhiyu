/*
 * 知识库的「成员与设置」权限（2026-10-12 补）
 *
 * ============================================================
 * 补的是后果最重的一处
 * ============================================================
 * 服务端 `server/sync.ts` 把 `bookSettings` 与 `bookMembers` **两个实体放一起**判：
 * `capsInBook(user, bookId).admin`，拒绝文案「需要该知识库的管理员权限」。
 * 注意是 **admin** —— `editor` 的 admin 是 **false**，编辑者也不能改成员。
 *
 * 而 `BookSettings` 整页**没有角色门**（`App.tsx` 的路由也不挡），
 * 任何成员敲 `/book/:bookId/settings` 就进得来，8 个标签全看得见。
 * 实测（探针，visitor / reader / editor 各一轮）：
 *   · 「添加成员」「邀请」无条件渲染
 *   · 角色下拉框、移除按钮、权限矩阵复选框全部可点
 *   · 安全设置那 5 个开关全部可点
 *   · 调 `addBookMember(bookId, x, 'admin')` → **界面的名单当场多出一个管理员**，
 *     服务端一条没改，顶栏挂 4 条修不好的告警
 *
 * 也就是说一个**阅读者**可以在界面上「把某人设成管理员」，名单当场就变了。
 *
 * ============================================================
 * 判据要小心的一处
 * ============================================================
 * 验 `updateMemberPerm` 时**不能挑 owner**：owner 的 perms 天然全是 true，
 * 量到 `edit === true` 跟那次调用有没有生效毫无关系 —— 我第一版就栽在这里，
 * 它给出的 `true` 是假象（真正的结论是「被拒了，但判据量的是既有值」）。
 * 必须挑一个**非 owner** 的成员，比对调用前后的差值。
 *
 * 反向样本是**知识库管理员但平台角色只是 member** ——
 * 平台 owner / 库 owner 都不验证判据本身，拿它们当反向样本等于白测。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.BOOK_PERMS_PORT || await freePort()
const DB = 'data/_bsetperm.db'
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
const P = (o = {}) => ({ read: true, comment: true, edit: false, create: false, export: false, share: false, ...o })

try {
  const br = await chromium.launch()
  try {
    const admin = await (await br.newContext({ viewport: { width: 1400, height: 1000 } })).newPage()
    await login(admin, 'admin', 'yuque@2026')
    const AH = {
      Authorization: 'Bearer ' + await admin.evaluate(() => localStorage.getItem('yq_token')),
      'Content-Type': 'application/json; charset=utf-8',
    }
    const sfx = Date.now().toString(36)
    const made = await admin.evaluate((x) => {
      const s = window.__yqStore.getState()
      const b = s.createBook('s1', '成员设置权限 ' + x)
      const d = window.__yqStore.getState().createDoc(b, null, '一篇 ' + x)
      window.__yqStore.getState().setDocBlocks(d, [{ id: 'bk_1', type: 'p', text: '正文。' }])
      return { b, d }
    }, sfx)
    for (let i = 0; i < 30; i++) {
      const bo = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
      if ((bo.data.books || []).some((x2) => x2.id === made.b)) break
      await admin.waitForTimeout(500)
    }

    /* 注册一批人 */
    const mkUser = async (key) => {
      const acct = `bs_${key}_${sfx}`
      const reg = await (await admin.request.post(`${BASE}/api/auth/register`, {
        data: { account: acct, password: 'test1234', name: `${key} 同事` },
      })).json()
      return { acct, id: reg.user.id }
    }
    const outsider = await mkUser('outsider')      // 不在这个库里，给「添加成员」用
    const visitor = await mkUser('visitor')
    const reader = await mkUser('reader')
    const editor = await mkUser('editor')
    const bookAdmin = await mkUser('bookadmin')    // ⚠️ 反向样本：库管理员、平台只是 member

    // 库管理员这行必须由**平台管理员**推（只有 admin 判得了 bookMembers）
    await admin.request.post(`${BASE}/api/sync/push`, {
      headers: AH,
      data: {
        upsert: {
          bookMembers: [
            { bookId: made.b, userId: visitor.id, role: 'visitor', perms: P({ comment: false }), joinedAt: Date.now() },
            { bookId: made.b, userId: reader.id, role: 'reader', perms: P(), joinedAt: Date.now() },
            { bookId: made.b, userId: editor.id, role: 'editor', perms: P({ edit: true, create: true }), joinedAt: Date.now() },
            { bookId: made.b, userId: bookAdmin.id, role: 'admin', perms: P({ edit: true, create: true }), joinedAt: Date.now() },
          ],
        },
      },
    })
    await admin.waitForTimeout(6000)

    const serverMembers = async () => {
      const bo = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
      return (bo.data.bookMembers || []).filter((m) => m.bookId === made.b).length
    }
    const srvCount = await serverMembers()
    console.log(`服务端成员数：${srvCount}`)

    for (const R of [
      { key: 'visitor', u: visitor, canAdmin: false },
      { key: 'reader', u: reader, canAdmin: false },
      { key: 'editor', u: editor, canAdmin: false },   // ⚠️ editor 的 admin 是 false
      { key: 'bookadmin', u: bookAdmin, canAdmin: true },
    ]) {
      const pg = await (await br.newContext({ viewport: { width: 1400, height: 1000 } })).newPage()
      const errs = []
      pg.on('pageerror', (e) => errs.push(String(e.message).slice(0, 80)))
      await login(pg, R.u.acct, 'test1234')
      await pg.goto(`${BASE}/#/book/${made.b}/settings`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(5000)

      console.log(`\n== ${R.key}（${R.canAdmin ? '库管理员' : '非管理员'}）==`)
      ok(await pg.evaluate(() => !!document.querySelector('.yq-bset')), '设置页进得来（路由本来就不挡）')

      /* ---------- 界面：权限 tab ---------- */
      await pg.locator('.yq-bset-nav-item', { hasText: '权限' }).first().click({ timeout: 8000 })
      await pg.waitForTimeout(1300)
      {
        const btns = await pg.evaluate(() =>
          // 收在卡片里查，别把整个侧边栏的按钮都捞进来 —— 失败时要能一眼看出是哪几个
          [...document.querySelectorAll('.yq-bset-body button')].map((b) => (b.innerText || '').trim()).filter(Boolean))
        ok(/添加成员/.test(btns.join('|')) === R.canAdmin, `「添加成员」${R.canAdmin ? '在' : '不在'}${R.canAdmin ? '' : `（卡片里只有：${btns.slice(0, 6).join('/')}）`}`)
        ok(/邀请/.test(btns.join('|')) === R.canAdmin, `「邀请」${R.canAdmin ? '在' : '不在'}`)
        // 移除按钮：owner 的那个本来就禁用，所以只看**非 owner** 的那一行
        const opBtns = await pg.evaluate(() =>
          [...document.querySelectorAll('.yq-bset-op-btn')].map((b) => ({ t: b.textContent.trim(), off: b.disabled })))
        const nonOwner = opBtns.slice(1)
        ok(nonOwner.length === 0 || nonOwner.every((b) => b.off === !R.canAdmin),
          `非 owner 那几行的「移除」${R.canAdmin ? '可点' : '已禁用'}`)
        // 权限矩阵复选框（要展开一个非 owner 成员的行）
        await pg.locator('.yq-bset-member-group').nth(1).locator('.yq-bset-member').first().click({ timeout: 8000 })
          .catch(() => {})
        await pg.waitForTimeout(900)
        const boxes = await pg.evaluate(() =>
          [...document.querySelectorAll('.yq-bset-perm input[type=checkbox]')].map((i) => i.disabled))
        ok(boxes.length > 0 && boxes.every(Boolean) === !R.canAdmin,
          `权限矩阵复选框：${boxes.length ? (boxes.every(Boolean) ? '全禁用' : '可勾') : '(没展开)'}（${boxes.filter(Boolean).length}/${boxes.length} 禁用）`)
      }

      /* ---------- 界面：安全 tab ---------- */
      {
        await pg.locator('.yq-bset-nav-item', { hasText: '安全' }).first().click({ timeout: 8000 })
        await pg.waitForTimeout(1300)
        const sw = await pg.evaluate(() => document.querySelectorAll('.yq-bset-body input[type=checkbox], .yq-bset-body .yq-switch').length)
        ok((sw > 0) === R.canAdmin, `安全设置那 5 个开关：${sw > 0 ? '在' : '整节挡掉了'}`)
      }

      /* ---------- store 第二道：五个写操作 ---------- */
      {
        const r = await pg.evaluate(([bid, self, outsiderId]) => {
          const s = window.__yqStore.getState()
          const members = () => window.__yqStore.getState().getBookMembers(bid)
          // ⚠️ 挑一个**非 owner** 的成员来验 updateMemberPerm：
          //    owner 的 perms 天然全 true，量到的 edit===true 与这次调用无关
          const nonOwners = members().filter((m) => m.role !== 'owner')
          const target = nonOwners[0]
          // ⚠️ victim 必须**另一个人**：第一版它挑的就是 target 本身，
          // 于是「改完角色再把这个人移走」，回头量不到那个角色变化 ——
          // 判据红了两条，而产品是对的。
          const victim = nonOwners.find((m) => m.id !== self && m.id !== target?.id)
          const before = { role: target?.role, edit: target?.perms?.edit, n: members().length }
          s.addBookMember(bid, outsiderId, 'admin')
          if (target) {
            s.updateMemberRole(bid, target.id, 'admin')
            s.updateMemberPerm(bid, target.id, 'edit', true)
          }
          if (victim) s.removeBookMember(bid, victim.id)
          s.updateBookSettings(bid, { restrictExport: true })
          const after = members()
          const t2 = after.find((m) => m.id === target?.id)
          return {
            added: after.some((m) => m.id === outsiderId),
            roleChanged: !!t2 && t2.role !== before.role,
            permChanged: !!t2 && !!t2.perms?.edit !== !!before.edit,
            victimGone: !!victim && !after.some((m) => m.id === victim.id),
            nBefore: before.n, nAfter: after.length,
            restrict: window.__yqStore.getState().getBookSettings(bid).restrictExport,
          }
        }, [made.b, R.u.id, outsider.id])
        await pg.waitForTimeout(8000)

        if (!R.canAdmin) {
          ok(!r.added, 'addBookMember(admin) 被拒（界面上没多出这个管理员）')
          ok(!r.roleChanged, 'updateMemberRole 被拒')
          ok(!r.permChanged, `updateMemberPerm 被拒（目标是非 owner，调用前后 perms.edit 不变：${r.permChanged}）`)
          ok(!r.victimGone, 'removeBookMember 被拒（那个人还在）')
          ok(r.nAfter === r.nBefore, `成员数没变（${r.nBefore} → ${r.nAfter}）`)
          ok(r.restrict !== true, 'updateBookSettings 被拒（导出限制没被打开）')
          const banner = await pg.evaluate(() => {
            const m = document.body.innerText.match(/(\d+)\s*处修改没有保存/)
            return m ? m[0] : '(无告警)'
          })
          ok(banner === '(无告警)', `顶栏没有留下修不好的告警（${banner}）`)
          ok(await serverMembers() === srvCount, '服务端成员数没变')
        } else {
          ok(r.added, 'addBookMember 成功（反向：库管理员必须还加得进人来）')
          ok(r.roleChanged, 'updateMemberRole 成功（反向）')
          ok(r.permChanged, 'updateMemberPerm 成功（反向）')
          ok(r.victimGone, 'removeBookMember 成功（反向：移得掉人）')
          ok(r.nAfter === r.nBefore, `加一个、移一个，人数刚好抵平（${r.nBefore} → ${r.nAfter}）`)
          ok(r.restrict === true, 'updateBookSettings 成功（反向：安全开关要还能用）')
          const after2 = await serverMembers()
          ok(after2 === srvCount, `服务端成员数也没变（加一个移一个，${after2}）`)
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