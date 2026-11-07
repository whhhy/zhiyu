/* ============================================================
   附件跨设备验证（服务端形态）
   ------------------------------------------------------------
   关键不是「能不能上传」，而是**换个人、换台设备还能不能打开** ——
   存进自己浏览器的 IndexedDB 是做不到这一点的，那正是本项目要修的。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:' + (process.env.YQ_PORT || '8092')
const DOC = 'd2'
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const login = async (page, account, password) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-login-card', { timeout: 20000 })
  await page.fill('.yq-login-card input[autocomplete="username"]', account)
  await page.fill('.yq-login-card input[type="password"]', password)
  await page.click('.yq-login-submit')
  await page.waitForSelector('.yq-app', { timeout: 25000 })
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

try {
  const ctx0 = await browser.newContext()
  const p0 = await ctx0.newPage()
  await login(p0, 'admin', process.env.ADMIN_PASS || 'yuque@2026')
  const adminToken = await p0.evaluate(() => localStorage.getItem('yq_token'))

  // 第二个同事
  const acct = `att_${suffix}`
  const r = await p0.request.post(`${BASE}/api/auth/register`, { data: { account: acct, password: 'test1234', name: '附件同事' } })
  const uid = (await r.json()).user.id
  await p0.request.post(`${BASE}/api/sync/push`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { upsert: { bookMembers: [{ bookId: 'b1', userId: uid, role: 'editor', perms: { read: true, comment: true, edit: true, create: true, export: true, share: true }, joinedAt: Date.now() }] } },
  })

  const A = await (await browser.newContext()).newPage()
  const B = await (await browser.newContext()).newPage()
  await login(A, acct, 'test1234')
  await login(B, acct, 'test1234')

  for (const p of [A, B]) {
    await p.goto(`${BASE}/#/book/b1/doc/${DOC}`, { waitUntil: 'domcontentloaded' })
    await p.waitForSelector('.yq-block', { timeout: 20000 })
    await p.waitForTimeout(1200)
  }

  console.log('\n== A 插入一张附件卡片 ==')
  // 直接驱动卡片组件的上传流程：造一个 File 塞进 file input
  await A.evaluate(async (docId) => {
    const s = window.__yqStore.getState()
    const doc = s.docs[docId]
    const content = '内网知识库附件 · 服务端存储验证'
    const file = new File(['附件内容：' + content], '测试附件.txt', { type: 'text/plain' })
    // 走真实的 FileCard 上传逻辑
    const mod = window.__yqAttach
    await mod.attachFileToDoc(file, true)
    const patch = await mod.attachFileToDoc(file, true)
    s.setDocBlocks(docId, [...doc.blocks, { id: 'bk_att_' + Date.now(), type: 'card', text: '', data: { cardId: 'file', ...patch } }])
  }, DOC)
  await A.waitForTimeout(2500)

  const keyA = await A.evaluate((d) => {
    const b = window.__yqStore.getState().docs[d].blocks.find((x) => x.data?.cardId === 'file')
    return b?.data?.key || ''
  }, DOC)
  ok(!!keyA, '附件卡片的 key 已落进文档', keyA)

  const storedFlag = await A.evaluate((d) => {
    const b = window.__yqStore.getState().docs[d].blocks.find((x) => x.data?.cardId === 'file')
    return b?.data?.stored === true
  }, DOC)
  ok(storedFlag, '标记为「已存储」（不是降级成 data URL）')

  console.log('\n== 服务端确实存下了二进制 ==')
  const head = await A.request.get(`${BASE}/api/attachment/${keyA}`, { headers: { Authorization: `Bearer ${await A.evaluate(() => localStorage.getItem('yq_token'))}` } })
  ok(head.ok(), '服务端能取回该附件', String(head.status()))
  const body = await head.text()
  ok(body.includes('内网知识库附件'), '二进制内容正确', body.slice(0, 60))

  console.log('\n== 换一台「设备」也能打开 ==')
  await B.reload({ waitUntil: 'domcontentloaded' })
  await B.waitForSelector('.yq-block', { timeout: 20000 })
  await B.waitForTimeout(2500)
  const keyB = await B.evaluate((d) => {
    const b = window.__yqStore.getState().docs[d].blocks.find((x) => x.data?.cardId === 'file')
    return b?.data?.key || ''
  }, DOC)
  ok(keyB === keyA, 'B 拿到的 key 与 A 一致（存的是服务端 id，不是本地指纹）', `A=${keyA} B=${keyB}`)

  const urlB = await B.locator('.yq-kc-file a, .yq-kc-file [href], .yq-kc a[href]').first().getAttribute('href').catch(() => null)
  console.log('   B 卡片上的链接:', urlB)
  if (urlB) {
    const r = await B.request.get(urlB.startsWith('http') ? urlB : BASE + urlB, { headers: { Authorization: `Bearer ${await B.evaluate(() => localStorage.getItem('yq_token'))}` } })
    ok(r.ok(), 'B 直接下载该链接成功', String(r.status()))
  }

  console.log('\n== 越权者拿不到 ==')
  const stranger = `att_ro_${suffix}`
  const r2 = await p0.request.post(`${BASE}/api/auth/register`, { data: { account: stranger, password: 'test1234', name: '无关同事' } })
  const uid2 = (await r2.json()).user.id
  const ctxS = await browser.newContext()
  const S = await ctxS.newPage()
  await login(S, stranger, 'test1234')
  const denied = await S.request.get(`${BASE}/api/attachment/${keyA}`, { headers: { Authorization: `Bearer ${await S.evaluate(() => localStorage.getItem('yq_token'))}` } })
  ok(denied.status() === 403, '未被授权的同事下载附件被拒（403）', String(denied.status()))

  /*
   * ============================================================
   * 点「删除」之后，服务端那行到底有没有真的没了
   * ------------------------------------------------------------
   * 这一段是本套件最要紧的部分，理由是：**光看上传是验不出这个 bug 的**。
   * 服务端从来没有过删除接口，而卡片上的「删除」只清了本机 IndexedDB，
   * 于是卡片从正文消失（用户以为删掉了）、二进制继续躺在库里。
   * 前面所有断言在这种情况下都照样全绿 —— 它们只看「能不能拿到」，
   * 而「删掉之后拿不拿得到」才是那个问题的形状。
   *
   * 所以这里直接驱动界面：上传 → 点卡片上的「删除」→ 回服务端查。
   * ============================================================
   */
  const tokenOf = (pg) => pg.evaluate(() => localStorage.getItem('yq_token'))
  const serverHas = async (pg, key) => {
    const r = await pg.request.get(`${BASE}/api/attachment/${key}`, { headers: { Authorization: `Bearer ${await tokenOf(pg)}` } })
    return r.status()
  }
  /** 再插一份附件，返回它的 key */
  const insertFile = async (pg, tag) => pg.evaluate(async ([docId, t]) => {
    const s = window.__yqStore.getState()
    const file = new File(['要删掉的内容：' + t], '待删除-' + t + '.txt', { type: 'text/plain' })
    const patch = await window.__yqAttach.attachFileToDoc(file, true)
    s.setDocBlocks(docId, [...s.docs[docId].blocks, { id: 'bk_del_' + t, type: 'card', text: '', data: { cardId: 'file', ...patch } }])
    return patch.key || ''
  }, [DOC, tag])

  console.log('\n== 点卡片上的「删除」：服务端那行必须真的消失 ==')
  {
    const bid = 'bk_del_a' + suffix
    const k = await insertFile(A, 'a' + suffix)
    ok(!!k, '插入一份待删除的附件', k)
    await A.waitForTimeout(2200)
    ok(await serverHas(A, k) === 200, '删之前服务端确实存着（不然下面「删没了」证明不了任何事）')

    /*
     * 必须**按块 id 定位**。写这一段时先用了 `.yq-kc-btn.is-danger` 的 `.first()`，
     * 结果点掉的是本文档里**前一张卡**的删除按钮 —— 上一节插的那张。
     * 断言照样红，但红的原因和要验的东西完全不是一回事：
     * 那一刻被删的是别人，不是被测对象。
     * 教训和「红的常常不是代码而是期望算错了」是同一条。
     */
    const delBtn = A.locator(`[data-block-id="${bid}"] .yq-kc-btn.is-danger`).filter({ hasText: '删除' }).first()
    await A.locator(`[data-block-id="${bid}"]`).scrollIntoViewIfNeeded()
    await delBtn.waitFor({ state: 'visible', timeout: 15000 })
    await delBtn.click()
    await A.waitForTimeout(2500)

    const st = await serverHas(A, k)
    ok(st === 404, '**点完删除，服务端真的取不到了**（不是只把卡片从正文里抹掉）', `状态 ${st}`)

    const stillKey = await A.evaluate(([d, id]) => {
      const b = window.__yqStore.getState().docs[d].blocks.find((x) => x.id === id)
      return b?.data?.key || ''
    }, [DOC, bid])
    ok(!stillKey, '卡片里的 key 也一并清掉了', stillKey)
  }

  console.log('\n== 用块菜单的「删除块」整块删掉：附件同样要跟着走 ==')
  {
    /*
     * **先把 B 关掉再删。**
     *
     * B 的使命在前面已经完成了（验证「换一台设备也能打开」）。
     *
     * 为什么关：这个用例原先**偶发**失败 —— 删掉块和附件之后，
     * 服务端出现「附件 404（消失）+ 块又回来（在）」这种方向相反的状态。
     * 方向相反说明有一次**别处来的写入**带着旧 blocks，而不是这两步自己排错了序。
     *
     * **是哪一次写入，没有坐实。** 两个受控探针（都保留 B、都跑完整序列）
     * 都没复现，而且都显示删除路径本身是对的：附件的 DELETE 先发，
     * 400ms 防抖到期后才推 blocks，推上去的就是已经删掉那个块的版本，B 一次都没推。
     * 所以「B 用旧内容覆盖」只是当时最像的猜测。详见 README「已知边界」里那条。
     *
     * 那这里为什么还关 B：**断言要能重复跑。**
     * 保留一个长时间开着同一篇文档的 editor 在场，这条用例就变成
     * 「测某个尚未坐实的时序」，协作行为一变就随机红绿。
     * 「两个 editor 同时开着同一篇文档」是**另一件事**（`test-collab-live`），
     * 不该混在这里 —— 混进来就等于用一条测不准的断言换取一个假的安心。
     *
     * 如果哪天坐实了根因，这里该改成**精确复现那个时序**，
     * 而不是继续靠关掉 B 绕开。
     */
    await B.close()
    await A.waitForTimeout(500)

    const bid = 'bk_del_b' + suffix
    const k = await insertFile(A, 'b' + suffix)
    ok(!!k, '再插一份', k)
    await A.waitForTimeout(2200)
    ok(await serverHas(A, k) === 200, '删之前服务端确实存着')

    /*
     * 走的**不是**上面那条代码：块菜单的「删除块」落到 Editor 的 removeBlock。
     *
     * （原以为可以用卡片工具栏的「删除卡片」—— 那个工具条只给**表格卡片**渲染，
     *   文件卡上根本没有。找错控件会让人以为功能不存在。）
     */
    const block = A.locator(`[data-block-id="${bid}"]`)
    // 块菜单按钮 opacity:0（靠悬浮显现），而且文档很长、块在首屏之外：
    // 不先滚过去再悬浮，Playwright 会一直报「element is outside of the viewport」
    await block.scrollIntoViewIfNeeded()
    await block.hover()
    await block.locator('.yq-block-more').click()
    const menuItem = A.locator('.yq-menu-item').filter({ hasText: '删除块' }).first()
    await menuItem.waitFor({ state: 'visible', timeout: 10000 })
    await menuItem.click()
    await A.waitForTimeout(2500)

    const st = await serverHas(A, k)
    ok(st === 404, '**整块删掉，附件二进制也回收了**（以前这条路上附件是孤儿，谁也删不掉）', `状态 ${st}`)

    const gone = await A.evaluate(([d, id]) => {
      const blocks = window.__yqStore.getState().docs[d].blocks
      return { has: blocks.some((x) => x.id === id), ids: blocks.map((x) => `${x.id}:${x.type}`) }
    }, [DOC, bid])
    ok(!gone.has, '块本身也从正文里消失了', `还在：${gone.ids.join('、')}`)
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

process.exit(fail ? 1 : 0)
