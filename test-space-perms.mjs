/*
 * 讨论区与小记的权限 —— 含「没有发言权时**用户输入不能被无声吞掉**」（2026-10-14 补）
 *
 * ============================================================
 * 补的是**空间级**的那一片
 * ============================================================
 * 服务端 `denyReason` 里 `isSpaceLevel(def.name)` 把 `topics` / `topicReplies` /
 * `notes` 三张表统一按 **`capsInSpace().comment`** 判 —— 不是知识库的 `edit`，
 * 也不是空间的 `admin`。理由在服务端那段注释里写得很清楚：
 * 这三张表压根不属于任何知识库，拿「是不是某知识库的 editor」来判发言权是判错了对象。
 *
 * 而客户端这五个 action 以前**一个门都没有**：
 * `createTopic` / `replyToTopic` / `likeNote` / `addDocVersion` / `restoreDocVersion`
 *
 * 这一片和前面几处的性质不同，判据必须分两组：
 *   · **空间级**（话题 / 回复 / 小记 / 小记点赞）：看**是不是这个空间的成员**
 *   · **文档级**（历史版本）：看**这个知识库的 edit**
 * 一个「只是这个空间的成员、但不是任何知识库成员」的人，
 * 前一组必须放行、后一组必须拦住 —— 只测一组就分不出判据接对没有。
 *
 * ⚠️ 边界与别处一致：只判「**问过**且**没有**」。
 *   所以判据必须先让页面把空间权限**问回来**（判据自己不会发请求），
 *   否则 store 里 caps 是 null，守卫压根不会触发 —— 那会让这条判据恒真。
 */
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { freePort } from './scripts/free-port.mjs'

const PORT = process.env.SPACE_PERMS_PORT || await freePort()
const DB = 'data/_spaceperm.db'
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

try {
  const br = await chromium.launch()
  try {
    const admin = await (await br.newContext({ viewport: { width: 1400, height: 950 } })).newPage()
    await login(admin, 'admin', 'yuque@2026')
    const AH = {
      Authorization: 'Bearer ' + await admin.evaluate(() => localStorage.getItem('yq_token')),
      'Content-Type': 'application/json; charset=utf-8',
    }
    const sfx = Date.now().toString(36)

    const made = await admin.evaluate((x) => {
      const s = window.__yqStore.getState()
      const b = s.createBook('s1', '讨论区权限 ' + x)
      const d = window.__yqStore.getState().createDoc(b, null, '一篇 ' + x)
      window.__yqStore.getState().setDocBlocks(d, [{ id: 'bk_1', type: 'p', text: '第一版正文。' }])
      // 一条既有小记、一条既有话题，好让两个「点赞 / 回复」有对象
      window.__yqStore.getState().addNote('s1', '管理员留的一条小记')
      const t = window.__yqStore.getState().createTopic('s1', '管理员留的话题', '管理员留的正文')
      window.__yqStore.getState().addDocVersion(d, '基准版')
      return { b, d, topic: t }
    }, sfx)
    console.log(`topic id = ${made.topic}`)

    for (let i = 0; i < 30; i++) {
      const bo = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
      if ((bo.data.books || []).some((x) => x.id === made.b)) break
      await admin.waitForTimeout(500)
    }

    const mkUser = async (key) => {
      const acct = `sp_${key}_${sfx}`
      const reg = await (await admin.request.post(`${BASE}/api/auth/register`, {
        data: { account: acct, password: 'test1234', name: `${key} 同事` },
      })).json()
      return { acct, id: reg.user.id }
    }
    // ⚠️ 组装空间成员关系要**两种身份分开做**：
    //   · member   —— 是 s1 的空间成员，但不是任何知识库的成员
    //   · outsider —— 连空间都不是（注册后只有自己的个人空间）
    // ⚠️ 载荷是 `{ userIds }` / `{ userId }`，**不是** `{ members: [...] }`
    //   （写错的话接口回 400「缺少 userId」，而那一句不像权限错误，很容易看过去）
    const member = await mkUser('member')
    const outsider = await mkUser('outsider')
    const addSp = await admin.request.post(`${BASE}/api/spaces/s1/members`, {
      headers: AH,
      data: { userIds: [member.id], role: 'member' },
    })
    if (!addSp.ok()) console.log('加空间成员失败：', await addSp.text())
    await admin.waitForTimeout(6000)

    const srvCount = async () => {
      const bo = await (await admin.request.get(`${BASE}/api/bootstrap?lite=0`, { headers: AH })).json()
      return {
        topics: (bo.data.topics || []).length,
        notes: (bo.data.notes || []).length,
        replies: (bo.data.topicReplies || []).length,
        versions: (bo.data.docVersions || []).filter((v) => v.docId === made.d).length,
      }
    }
    const base0 = await srvCount()
    console.log('服务端初始：', JSON.stringify(base0))

    for (const R of [
      { key: 'outsider', u: outsider, inSpace: false, canSpeak: false },
      { key: 'member', u: member, inSpace: true, canSpeak: true },
    ]) {
      const pg = await (await br.newContext({ viewport: { width: 1400, height: 950 } })).newPage()
      const errs = []
      pg.on('pageerror', (e) => errs.push(String(e.message).slice(0, 80)))
      await login(pg, R.u.acct, 'test1234')
      await pg.goto(`${BASE}/#/`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(4000)
      /*
       * ⚠️ 必须让**两组权限都被问回来**，否则 store 里 caps 是 null、
       *    「问过才拦」的守卫压根不触发 —— 那这几条判据就恒真了。
       *
       * 空间权限：界面会调的那个 action（`loadSpaceCaps`）。
       *   非空间成员在界面上压根进不了 s1（`Space.tsx` 那一行
       *   `spaces.find(...) || spaces[0]` 会回退到自己的空间），
       *   所以这里**显式调它** —— 这是第二道防线的正常前提：
       *   它防的是脚本/控制台，而不是假装 UI 上有个按钮。
       *
       * 文档权限：得真进一次文档页，`useDocPerms` / `useBookPerms` 才会发请求。
       */
      await pg.evaluate(() => window.__yqStore.getState().loadSpaceCaps('s1'))
      await pg.goto(`${BASE}/#/book/${made.b}/doc/${made.d}`, { waitUntil: 'domcontentloaded' })
      await pg.waitForSelector('.yq-app', { timeout: 25000 })
      await pg.waitForTimeout(5000)
      const caps = await pg.evaluate(() => window.__yqStore.getState().spaceCaps?.['s1'] ?? '(还没问回来)')
      const blocksLoaded = await pg.evaluate((d) => Array.isArray(window.__yqStore.getState().docs[d]?.blocks), made.d)
      console.log(`\n== ${R.key} ==`)
      console.log('  s1 的空间权限：', JSON.stringify(caps))
      console.log('  正文加载了吗：', blocksLoaded)
      ok(!!caps && caps !== '(还没问回来)', '空间权限已经问回来了（守卫的前提）')
      // ⚠️ 只有**看得见这篇文档的人**才可能加载正文 ——
      //    outsider 不是空间成员，压根读不到这篇（`blocksLoaded=false` 是对的）。
      //    所以这条断言只对能读的人成立，别把它当成通用前提。
      if (R.inSpace) ok(blocksLoaded, '正文已经加载（历史版本那两条的前提）')
      else console.log('  （他不是空间成员，读不到这篇正文 —— 这是对的，所以不验正文这条）')

      const r = await pg.evaluate(([bid, did, tid]) => {
        const s = window.__yqStore.getState()
        // ⚠️ 点赞要**先记住那条小记的 id**：`addNote` 是**插在最前面**的，
        //    事后查 `notes[0]` 拿到的是新加的那条（likes 恒为空）——
        //    量到的 false 与那次点赞毫无关系。
        const noteId = s.notes[0]?.id
        const before = {
          topics: (s.topics || []).length,
          notes: (s.notes || []).length,
          replies: (s.topicReplies || []).length,
          versions: (s.docs[did]?.versions || []).length,
        }
        const newTopic = s.createTopic('s1', '试试看能不能发 ' + Date.now().toString(36), '正文')
        s.replyToTopic(tid, '试试看能不能回')
        s.likeNote(noteId)
        const likedNow = !!window.__yqStore.getState().notes.find((n) => n.id === noteId)?.likes?.length
        s.addNote('s1', '试试看能不能存小记')
        const vres = s.addDocVersion(did, '越权试试')
        const vid = (window.__yqStore.getState().docs[did]?.versions || [])[0]?.id
        const restored = vid ? s.restoreDocVersion(did, vid) : false
        const st = window.__yqStore.getState()
        return {
          before,
          newTopic: !!newTopic,
          replied: (st.topicReplies || []).length > before.replies,
          liked: likedNow,
          noted: (st.notes || []).length > before.notes,
          versionAdded: (st.docs[did]?.versions || []).length > before.versions,
          restored: !!restored,
        }
      }, [made.b, made.d, made.topic])
      await pg.waitForTimeout(9000)

      const banner = await pg.evaluate(() => {
        const m = document.body.innerText.match(/(\d+)\s*处修改没有保存/)
        return m ? m[0] : '(无告警)'
      })

      /* ---------- 界面那一半：没有发言权时，用户写的东西不能被吞掉 ---------- */
      /*
       * ⚠️ 这条钉的是 2026-10-14 修的那个缺陷，**危害不是「点了没反应」**：
       *   `replyToTopic` / `addNote` 以前返回 `void`，调用方判不了成败，
       *   于是 `KnowledgeDetail` 与 `Notes` 都是「无条件 setText('')」——
       *   **没有权限时，用户写的整段话被清空了，一条提示都没有**。
       * 用户会以为系统吞了草稿，重打一遍还是一样。
       *
       * 判据分两半，缺一不可：
       *   · 界面不该给「能写但发不出去」的输入框（给了就是白写）；
       *   · 绕过界面直接调 action 时，**内容要留着 + 有明确提示**。
       * 只钉后一半的话，界面那半坏了没人知道；只钉前一半的话，
       * store 被脚本绕过时又回到「静默丢弃」。
       */
      {
        /*
         * ⚠️ 必须先**切到 s1**，否则这条断言测不到任何东西（我第一版就栽在这儿）：
         * 新注册用户的 `activeSpaceId` 是他自己的**个人空间**，在那里发小记完全合法，
         * 于是「看不到输入框」必然失败 —— 而产品是对的。
         * 真正够得着这个缺陷的场景是：**切到一个自己没有发言权的空间**。
         */
        await pg.evaluate(() => window.__yqStore.getState().setActiveSpace('s1'))
        await pg.goto(`${BASE}/#/notes`, { waitUntil: 'domcontentloaded' })
        await pg.waitForSelector('.yq-app', { timeout: 25000 })
        await pg.waitForTimeout(3000)
        const ui = await pg.evaluate(() => {
          const box = document.querySelector('.yq-notes-composer')
          return {
            space: window.__yqStore.getState().activeSpaceId,
            hasComposer: !!box,
            hasInput: !!document.querySelector('.yq-notes-input'),
            text: (box?.innerText || '').replace(/\s+/g, ' ').slice(0, 80),
          }
        })
        console.log('  小记页输入区：', JSON.stringify(ui))
        if (R.canSpeak) {
          ok(ui.hasInput, '有发言权的人**有**输入框（反向：不能把入口关没了）')
          // 真发一条，确认发出去之后输入框会被清空（清空本身是对的）
          const cleared = await pg.evaluate(async () => {
            const el = document.querySelector('.yq-notes-input')
            if (!el) return { skipped: true }
            const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
            setter.call(el, '回归：在空间里发一条小记')
            el.dispatchEvent(new Event('input', { bubbles: true }))
            await new Promise((r) => setTimeout(r, 600))
            const btn = [...document.querySelectorAll('.yq-notes-composer button')]
              .find((b) => (b.textContent || '').includes('发布小记'))
            if (btn) btn.click()
            await new Promise((r) => setTimeout(r, 1500))
            return { value: el.value, notes: window.__yqStore.getState().notes.length }
          })
          console.log('  发完之后输入框内容：', JSON.stringify(cleared))
          ok(cleared.skipped || cleared.value === '', '**发成功之后**输入框才清空')
        } else {
          ok(!ui.hasInput, '没有发言权的人**看不到输入框**（不给「能写但发不出去」的框）')
          ok(/没有发言权限/.test(ui.text), '并且写明了原因（实测：' + ui.text + '）')
        }

        // 绕过界面：内容不能丢，而且要有提示
        const bypass = await pg.evaluate(() => {
          const s = window.__yqStore.getState()
          const before = s.notes.length
          const ret = s.addNote('s1', '这句不该被吞掉')
          return {
            ret,
            grew: window.__yqStore.getState().notes.length > before,
            toasts: window.__yqStore.getState().toasts.map((t) => t.message || ''),
          }
        })
        console.log('  绕过界面直接调 addNote：', JSON.stringify(bypass))
        if (R.canSpeak) {
          ok(!!bypass.ret && bypass.grew, '有发言权时 addNote **返回真实 id**（调用方据此才知道成功没有）')
        } else {
          ok(bypass.ret === '', '被拒时 addNote **返回空串**而不是 void —— 调用方才判得了成败')
          ok(!bypass.grew, '本地没有多出小记')
        }
      }

      const banner2 = await pg.evaluate(() => {
        const m = document.body.innerText.match(/(\d+)\s*处修改没有保存/)
        return m ? m[0] : '(无告警)'
      })
      ok(banner2 === '(无告警)', `整个流程跑完顶栏仍然干净（${banner2}）`)
      const now = await srvCount()
      console.log(`  本地：发话题=${r.newTopic} 回帖=${r.replied} 赞小记=${r.liked} 存小记=${r.noted} 存版本=${r.versionAdded} 回滚=${r.restored}`)
      console.log(`  服务端：${JSON.stringify(now)}（基线 ${JSON.stringify(base0)}）`)

      if (!R.canSpeak) {
        ok(!r.newTopic, 'createTopic 被拒')
        ok(!r.replied, 'replyToTopic 被拒')
        ok(!r.liked, 'likeNote 被拒')
        ok(!r.noted, 'addNote 被拒')
        ok(banner === '(无告警)', `顶栏没有留下修不好的告警（${banner}）`)
        ok(now.topics === base0.topics && now.notes === base0.notes && now.replies === base0.replies,
          '服务端一个都没多')
      } else {
        ok(r.newTopic, 'createTopic 成功（反向：空间成员本来就该能发言）')
        ok(r.replied, 'replyToTopic 成功（反向）')
        ok(r.liked, 'likeNote 成功（反向）')
        ok(r.noted, 'addNote 成功（反向）')
        ok(banner === '(无告警)', `顶栏干净（${banner}）`)
      }

      /* 文档级：两组都该被拦 —— 讨论区是空间级，历史版本是知识库级，
         这个人**不是这个知识库的成员**，所以两边都不该放行。 */
      ok(!r.versionAdded, 'addDocVersion 被拒（他是空间成员，但不是这个库的成员）')
      ok(!r.restored, 'restoreDocVersion 被拒')
      ok(now.versions === base0.versions, `服务端历史版本没多（${now.versions}）`)

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