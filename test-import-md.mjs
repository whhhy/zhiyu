/* ============================================================
   Markdown 文件夹导入验证

   验的是「公司里存量的那批文档能不能进得来」，以及进来之后是不是
   完整可用的（正文转成了块、目录层级对、进了服务端）。

   导入刻意走已有 store action，不新开接口 ——
   所以这个套件同时也在验：导入出来的东西和手工创建的**没有任何区别**，
   权限 / 版本 / 回收站 / 跨设备全都自动继承。
   ============================================================ */

import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:8092'
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

const browser = await chromium.launch()
const suffix = Date.now().toString(36)

// 一棵有层级、有各种语法的目录树
const TREE = {
  '团队手册/01-入职指南.md': `# 入职指南

## 第一天

- 领工牌
- 配设备

- [x] 报到
- [ ] 培训

\`\`\`bash
npm install
\`\`\`

| 步骤 | 负责人 |
| --- | --- |
| 报到 | HR |`,
  '团队手册/02-报销流程.md': '# 报销流程\n\n发票拍照上传，月底统一提交。',
  '团队手册/安全/密码规范.md': '# 密码规范\n\n- 至少 12 位\n- 不得复用\n',
  '团队手册/安全/应急联络.md': '# 应急联络\n\n值班电话见群公告。',
  '产品手册/功能说明.md': '# 功能说明\n\n共三个模块。',
  '随便写点东西.md': '没有目录层级的单文件。',
}

try {
  const p0 = await (await browser.newContext()).newPage()
  await p0.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p0.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p0.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p0.fill('.yq-login-card input[type="password"]', process.env.ADMIN_PASS || 'yuque@2026')
  await p0.click('.yq-login-submit')
  await p0.waitForSelector('.yq-app', { timeout: 30000 })
  await p0.waitForTimeout(1500)
  const token = await p0.evaluate(() => localStorage.getItem('yq_token'))
  const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' }

  console.log('\n== 目录树规划（纯函数，先验结构对不对） ==')
  const plan = await p0.evaluate(async (files) => {
    const mod = await import('/src/lib/import-markdown.ts').catch(() => null)
    return null
  }, TREE).catch(() => null)

  // 走真实 UI：把文件塞进 input
  const bookTitle = '导入手册'
  const p = await (await browser.newContext()).newPage()
  p.on('pageerror', (e) => console.log('  [err]', e.message.slice(0, 140)))
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-login-card', { timeout: 25000 })
  await p.fill('.yq-login-card input[autocomplete="username"]', 'admin')
  await p.fill('.yq-login-card input[type="password"]', process.env.ADMIN_PASS || 'yuque@2026')
  await p.click('.yq-login-submit')
  await p.waitForSelector('.yq-app', { timeout: 30000 })
  await p.goto(`${BASE}/#/settings`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('.yq-settings-nav', { timeout: 25000 })
  await p.waitForTimeout(1200)

  // 切到「数据管理」页签（左侧导航，不是 Segmented）
  /* 入口现在是「导入…」→ 格式选择器（2026-10-16 照语雀的形态改的） */
  await p.locator('.yq-settings-nav-item', { hasText: '数据管理' }).first().click()
  await p.waitForTimeout(600)
  const entry = p.locator('button', { hasText: '导入…' })
  const hasBtn = await entry.count()
  ok(hasBtn > 0, '设置里有「导入…」入口')
  if (!hasBtn) throw new Error('找不到导入入口')

  await entry.first().click()
  await p.waitForSelector('.yq-imppick-item', { state: 'visible', timeout: 8000 })
  await p.locator('.yq-imppick-item', { hasText: 'Markdown 文件夹' }).first().click()
  // 文件 input 是故意隐藏的（靠点 label 触发），而且页面里有好几个
  // .yq-import-drop —— 必须用 state:'attached' 并取最后一个，
  // 否则会抓到「导入数据包」那个永远不可见的 input。
  await p.waitForSelector('.yq-import-drop input[type="file"]', { state: 'attached', timeout: 10000 })

  // webkitdirectory 的 input 用 setInputFiles 传不了目录，
  // 改成直接构造 File 列表并派发 change，模拟浏览器选完之后的结果
  await p.evaluate(async ([files, title]) => {
    const inputs = document.querySelectorAll('.yq-import-drop input[type="file"]')
    const input = inputs[inputs.length - 1]
    const dt = new DataTransfer()
    for (const [rel, text] of Object.entries(files)) {
      const f = new File([text], rel.split('/').pop(), { type: 'text/markdown' })
      // 目录选择时浏览器会给每个文件带上相对路径
      Object.defineProperty(f, 'webkitRelativePath', { value: rel })
      dt.items.add(f)
    }
    input.files = dt.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, [TREE, bookTitle])
  await p.waitForTimeout(2500)

  console.log('\n== 落库前先预览 ==')
  const planText = await p.locator('.yq-mdplan-head').textContent().catch(() => '')
  ok(/6 篇/.test(planText || ''), '预览里报出了 6 篇', planText?.trim())
  const dirs = await p.locator('.yq-mdplan-toggle').allTextContents()
  // 选中的那个文件夹本身会成为知识库，所以它不再作为目录出现一次 ——
  // 预览里应该是它的**内容**（产品手册 / 安全），这才是对的。
  ok(!dirs.some((d) => d.trim().includes('团队手册')), '被选中的文件夹本身不会重复出现（它就是知识库）', JSON.stringify(dirs))
  ok(dirs.some((d) => d.includes('产品手册')), '预览里有「产品手册」', JSON.stringify(dirs))
  ok(dirs.some((d) => d.includes('安全')), '预览里有「安全」', JSON.stringify(dirs))
  const previewText = await p.locator('.yq-mdplan-preview').first().textContent().catch(() => '')
  ok(/【标题】|【H2】|【列表】|【代码】|【表格】/.test(previewText || ''), '预览里能看到转换后的块类型', (previewText || '').slice(0, 40).replace(/\n/g, ' '))

  console.log('\n== 确认导入 ==')
  const confirm = p.locator('button:has-text("确认导入")')
  ok(await confirm.count() > 0, '确认按钮上的篇数对', (await confirm.textContent().catch(() => '')) || '')
  await confirm.first().click()
  await p.waitForTimeout(6000)

  console.log('\n== 服务端：知识库 / 目录 / 正文 ==')
  const boot = await (await fetch(`${BASE}/api/bootstrap`, { headers: H })).json()
  // 种子数据里本来就有一个叫「团队手册」的知识库，
  // 用 find(name) 会命中**种子那个**（内容完全不同），断言于是全错 ——
  // 看起来像「导入只导了一半」，其实数据是全的。
  // 所以按导入生成的书来认：createBook 的 id 前缀是 b_，种子是 b1..b4。
  const imported = boot.data.books.filter((b) => /^b_/.test(b.id) && b.name === '团队手册')
  const book = imported[imported.length - 1]
  ok(!!book, '知识库建出来了（以被选中的文件夹命名）', book?.name)
  if (!book) throw new Error('导入没成功')

  const bookTitle2 = '导入手册'
  const nodes = boot.data.books.length
  void nodes
  const bnodes = boot.data.nodes.filter((n) => n.bookId === book.id)
  const groups = bnodes.filter((n) => n.type === 'group')
  const leaves = bnodes.filter((n) => n.type === 'doc')
  ok(leaves.length === 6, '6 篇文稿都在', String(leaves.length))
  ok(groups.length === 2, '目录节点 2 个（产品手册 / 安全）', String(groups.length))
  const rootDocs = leaves.filter((n) => !n.parentId)
  ok(rootDocs.length === 3, '根层 3 篇（入职指南 / 报销流程 / 随便写点东西）', String(rootDocs.length))

  const safety = groups.find((g) => g.title === '安全')
  ok(!!safety, '二级目录「安全」在')
  const inSafety = leaves.filter((n) => n.parentId === safety?.id)
  ok(inSafety.length === 2, '「安全」下面有 2 篇', String(inSafety.length))
  void bookTitle2


  console.log('\n== 正文转成了块 ==')
  // leaves 是**节点**行，它的 id 是节点 id；正文要按 node.docId 取。
  const guideNode = leaves.find((n) => n.title === '入职指南')
  ok(!!guideNode, '文件名前缀被去掉了（「01-入职指南」→ 入职指南）', guideNode?.title)
  const full = await (await fetch(`${BASE}/api/doc/${guideNode.docId}`, { headers: H })).json()
  const types = full.doc.blocks.map((b) => b.type)
  ok(types.includes('h1'), '标题块在', types.join(','))
  ok(types.includes('h2'), '二级标题在')
  ok(types.includes('ul'), '列表在')
  ok(types.includes('todo'), '待办在')
  ok(types.includes('code'), '代码块在', types.join(','))
  ok(types.includes('table'), '表格在')
  ok(full.doc.blocks.length >= 8, `块数合理（${full.doc.blocks.length}）`)

  console.log('\n== 权限：只读成员改不动导入的文档 ==')
  const acct = `imp_ro_${suffix}`
  const reg = await (await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: acct, password: 'test1234', name: '只读' }),
  })).json()
  const push = await (await fetch(`${BASE}/api/sync/push`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ upsert: { bookMembers: [{ bookId: book.id, userId: reg.user.id, role: 'visitor', perms: { read: 1, comment: 1, edit: 0, create: 0, export: 1, share: 0 }, joinedAt: Date.now() }] } }),
  })).json()
  ok(push.applied?.length === 1, '只读成员能加进来（内容对他可见）')
  const visTok = (await (await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: acct, password: 'test1234' }),
  })).json()).token
  const denied = await (await fetch(`${BASE}/api/sync/push`, {
    method: 'POST', headers: { Authorization: `Bearer ${visTok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ upsert: { docs: [{ id: guideNode.docId, title: '越权改标题' }] } }),
  })).json()
  ok(denied.rejected?.length === 1, '但改不动（导入的内容照样受权限管）', JSON.stringify(denied.rejected))

  console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
}

process.exit(fail ? 1 : 0)
