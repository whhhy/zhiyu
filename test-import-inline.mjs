/**
 * 侧栏「导入…」原地弹框（2026-10-18）
 * ------------------------------------------------------------
 * 这条路径**之前没有任何自动化覆盖**：所有导入套件走的都是设置页那个入口，
 * 而设置页入口没有库上下文（`targetBookId` 为空）—— 于是它测的是
 * 「新建一个知识库再导进去」这条老路。
 * 侧栏那条（`targetBookId` 有值 → 直接导进当前库）一直是**裸奔**的。
 *
 * 它已经翻过两次车，两次都是「界面看着对、实际不是那回事」：
 *   ① 落点提示写成 `books[targetBookId]?.name || '未命名'`
 *      —— books 是**数组**，字符串下标取不到 → 落到硬编码兜底 →
 *      界面**自信地显示一个假书名**（真书名叫「导入的 Word 文档」，
 *      提示却写「『未命名』」）。没有兜底反而更好：至少知道自己没查到。
 *   ② 格式选择器关闭时只清自己的状态、**不通知调用方**
 *      → 调用方的 open 停在 true → 用户第二次点「导入…」时
 *      setOpen(true) 是空操作 → **弹窗再也不开**，控制台一句错都没有。
 *
 * 所以这里刻意把「关掉再开」和「落点提示 == 侧栏书名」都钉成断言。
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const BASE = process.env.BASE || 'http://localhost:8092'
/**
 * 夹具根目录**可覆盖**。
 *
 * ⚠️ 原因：套件在 `finally` 里会 `rmSync` 掉自己的夹具目录。
 *   而全量回归和「我手动单跑一次」如果指向同一个 `data/_import-inline`，
 *   两边就会互相删对方的夹具 —— 症状是 `ENOENT ... 表格夹具.csv`，
 *   离原因（并发）很远，看起来像「路径写错了」。
 */
const FIX_ROOT = process.env.YQ_IMPORT_FIXTURE_DIR || path.resolve('data/_import-inline')
const FIXTURES = path.join(FIX_ROOT, '原地导入夹具')
/** 表格导入的夹具：一个 CSV 文件 = 一篇表格文稿 */
const CSV_DIR = path.join(FIX_ROOT, '表格夹具')
const CSV_COUNT = 1

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`) }
}

mkdirSync(FIXTURES, { recursive: true })
writeFileSync(path.join(FIXTURES, '夹具甲.md'), '# 夹具甲\n\n原地导入的第一篇。\n', 'utf8')
writeFileSync(path.join(FIXTURES, '夹具乙.md'), '# 夹具乙\n\n原地导入的第二篇。\n', 'utf8')

/* 表格夹具：一个 CSV → 一篇表格文稿。表头刻意用中文，且第一列不是日期，
   这样「第一行读得出来」这条断言不会因为某列被当日期解析而假阴性。 */
mkdirSync(CSV_DIR, { recursive: true })
writeFileSync(path.join(CSV_DIR, '表格夹具.csv'),
  '姓名,部门,入职年份\n张三,研发,2019\n李四,市场,2021\n', 'utf8')

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
await ctx.route('**/*', (r) => {
  const h = new URL(r.request().url()).hostname
  return h === 'localhost' || h === '127.0.0.1' ? r.continue() : r.abort()
})
const page = await ctx.newPage()

/** 打开侧栏 ＋ 菜单并点「导入…」——顺带返回点击前后的 URL */
async function openImportFromSidebar() {
  const before = page.url()
  await page.locator('.yq-tree-cat-add').first().click()
  await page.waitForSelector('.yq-menu-item', { state: 'visible', timeout: 8000 })
  await page.locator('.yq-menu-item', { hasText: '导入…' }).first().click()
  await page.waitForSelector('.yq-imppick-item', { state: 'visible', timeout: 8000 })
  return before
}

try {
  console.log('\n== 登录 ==')
  await page.goto(BASE + '/#/', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  if (await page.locator('.yq-login').count()) {
    await page.fill('input[placeholder="登录名"]', 'admin')
    await page.fill('input[type="password"]', process.env.ADMIN_PASS || 'yuque@2026')
    await page.click('.yq-login-submit')
    await page.waitForSelector('.yq-login', { state: 'detached', timeout: 25000 })
    ok(true, '已登录')
  } else ok(true, '已是登录态')

  console.log('\n== 拿一本书，站到它的目录树里 ==')
  const book = await page.evaluate(() => {
    const b = window.__yqStore.getState().books[0]
    return b ? { id: b.id, name: b.name } : null
  })
  ok(!!book, `拿到一本书：${book ? book.name + ' / ' + book.id : '（库里没有书）'}`)
  if (!book) throw new Error('没有可用的知识库，后面的断言没法做')

  const booksBefore = await page.evaluate(() => window.__yqStore.getState().books.length)
  await page.goto(`${BASE}/#/book/${book.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.yq-tree-cat-add', { state: 'visible', timeout: 15000 })
  ok(true, '目录树的 ＋ 入口在（书里有新建权才会出现）')

  /*
   * ⚠️ 开跑先清一遍**上一轮可能留下的**夹具。
   *   只在收尾删是不够的：上一轮要是中途抛异常（选择器写错、等超时），
   *   收尾那段根本不会跑到，于是夹具留在库里 ——
   *   下一轮数「导进来几篇」就把两轮加起来算，
   *   表现为「实得 4」，而其实那一轮只导了 2 篇。
   *
   *   **断言自己也会骗人**：形状对的那条照样过，只有计数那条会红，
   *   而症状（「实得 4」）离原因（上一轮没清干净）很远。
   */
  const stale = await page.evaluate(() => {
    const st = window.__yqStore.getState()
    /* 两个夹具都要清：Markdown 夹具按标题，表格夹具也按标题 ——
       后者尤其重要，因为它会留下**形状不对的旧数据**，
       而下面那些断言是按标题找的，混进一篇旧的就会「明明修好了还是红」。 */
    const NEEDLES = ['夹具甲', '夹具乙', '表格夹具']
    const hit = Object.keys(st.docs).filter((id) => NEEDLES.some((n) => (st.docs[id].title || '').includes(n)))
    for (const id of hit) st.deleteDoc(id)
    return hit.length
  })
  if (stale) console.log(`       （清掉上一轮遗留的 ${stale} 篇夹具）`)

  console.log('\n== 点「导入…」是**原地**弹框，不是换个页面 ==')
  const urlBefore = await openImportFromSidebar()
  ok(page.url() === urlBefore, 'URL 没变（没有跳去设置页）', `${urlBefore} → ${page.url()}`)
  ok(!(await page.locator('.yq-settings').count()), '当前不是设置页')

  console.log('\n== 落点提示说的是不是这本真书 ==')
  const hint = ((await page.locator('[data-testid="import-target"]').textContent()) || '').trim()
  ok(hint.includes(book.name), `提示里是这本真书的名字「${book.name}」`, hint)
  ok(!/未命名/.test(hint), '提示里没有那个「查不到就编一个」的兜底名字', hint)

  console.log('\n== 关掉之后还能再开（这是真机踩过的卡死态）==')
  await page.locator('.yq-modal-footer button', { hasText: '取消' }).first().click()
  await page.waitForSelector('.yq-imppick-item', { state: 'detached', timeout: 8000 })
  ok(true, '第一次关掉了')

  await openImportFromSidebar()
  ok(await page.locator('.yq-imppick-item').count() > 0,
    '第二次点「导入…」**弹窗真的又开了**（不通知调用方就会卡死在这里）')
  const hint2 = ((await page.locator('[data-testid="import-target"]').textContent()) || '').trim()
  ok(hint2 === hint, '第二次的落点提示和第一次一样', `${hint} / ${hint2}`)

  console.log('\n== 真导一份进去，落在**当前这个库** ==')
  await page.locator('.yq-imppick-item', { hasText: 'Markdown 文件夹' }).first().click()
  await page.waitForSelector('.yq-import-drop input[type="file"]', { state: 'attached', timeout: 10000 })
  await page.setInputFiles('.yq-import-drop input[type="file"]', FIXTURES)
  await page.waitForSelector('button:has-text("确认导入")', { timeout: 20000 })
  await page.waitForTimeout(400)
  const label = ((await page.locator('button:has-text("确认导入")').first().textContent()) || '').trim()
  ok(/2\s*篇/.test(label), `预览认出 2 篇（按钮写着「${label}」）`, label)

  await page.locator('button:has-text("确认导入")').first().click()
  await page.waitForTimeout(2500)

  const result = await page.evaluate((bid) => {
    const st = window.__yqStore.getState()
    /* ⚠️ 只认**自己那两篇**，不能图省事写成 includes('夹具')。
     *   `test-mdimport-e2e.mjs` 的产物叫「图种夹具」，也在同一个共用库里，
     *   而它自己承认**知识库删不掉**（产品没这个能力），所以那篇会一直躺在库里。
     *   第一版就写成了 includes('夹具')，于是数出 3 篇、
     *   还把别人的产物报成「没落在当前库里」—— 一次自己制造的假红。
     */
    const MINE = ['夹具甲', '夹具乙']
    const hit = Object.values(st.docs).filter((d) => MINE.includes(d.title || ''))
    return {
      count: hit.length,
      wrongBook: hit.filter((d) => d.bookId !== bid).map((d) => d.title),
      booksNow: st.books.length,
      currentName: (st.books.find((b) => b.id === bid) || {}).name || '',
    }
  }, book.id)
  ok(result.count === 2, `导进来 2 篇（实得 ${result.count}）`)
  ok(result.wrongBook.length === 0,
    '两篇都落在**当前这个库**里（不是新建了一个库）', JSON.stringify(result.wrongBook))
  ok(result.booksNow === booksBefore,
    `没有新建知识库（导入前 ${booksBefore} 个，导入后 ${result.booksNow} 个）`)
  ok(result.currentName === book.name, '原来那本书还在、名字没变', `${result.currentName}`)

  /*
   * 表格导入的**落库形状**（2026-10-18 补）
   * ------------------------------------------------------------
   * 这条是从一个真 bug 反推出来的：导入 Excel/CSV 时往 `sheetData.sheets`
   * 塞的是**数组**，而它应该是 `{ sheets: SheetTab[]; activeId }` 这个**对象**。
   * 读取方（`useDocSection` → `activeTab`）在里面 `.find()`，所以
   * **导入出来的表格打开是坏的**。
   *
   * 为什么之前没人发现：`test-import-office` 29 项全绿 ——
   * 它测的是「能不能把 xlsx 读成 SheetTab」，**没测读出来的东西有没有被
   * 正确地存回去**。解析器是对的，落库是错的，中间那一段没人守。
   */
  console.log('\n== 表格导入的落库形状（解析器对 ≠ 存得对）==')
  {
    const before = await page.evaluate(() => Object.keys(window.__yqStore.getState().docs).length)

    await page.locator('.yq-tree-cat-add').first().click()
    await page.waitForSelector('.yq-menu-item', { state: 'visible', timeout: 8000 })
    await page.locator('.yq-menu-item', { hasText: '导入…' }).first().click()
    await page.waitForSelector('.yq-imppick-item', { state: 'visible', timeout: 8000 })
    await page.locator('.yq-imppick-item', { hasText: 'Excel / CSV' }).first().click()
    /*
     * ⚠️ 选择器按 `accept` 定位，**不能**沿用 Markdown 那个
     *   `.yq-import-drop input[type="file"]` ——
     *   表格/zip 这两个弹窗的 input 没有 `.yq-import-drop` 外层
     *   （它们不是拖拽区），第一版就这么写，结果等了 10 秒超时。
     *   判据要跟着**真实 DOM** 走，不是跟着上一个用例的写法走。
     */
    const csvInput = '.yq-modal input[type="file"][accept*=".csv"]'
    await page.waitForSelector(csvInput, { state: 'attached', timeout: 10000 })
    /* 必须是**文件本身**：这个 input 是 `multiple` 的普通文件选择框，
       不像 Markdown 那个带 `webkitdirectory`，传目录会直接报
       「File input does not support directories」。 */
    await page.setInputFiles(csvInput, path.join(CSV_DIR, '表格夹具.csv'))

    await page.waitForSelector('button:has-text("确认导入")', { timeout: 20000 })
    await page.waitForTimeout(400)
    const csvLabel = ((await page.locator('button:has-text("确认导入")').first().textContent()) || '').trim()
    const sheetsBefore = await page.evaluate(() =>
      Object.values(window.__yqStore.getState().docs).filter((d) => d.type === 'sheet').map((d) => d.title))
    console.log(`       确认按钮写着「${csvLabel}」；导入前已有表格文稿 ${sheetsBefore.length} 篇：${JSON.stringify(sheetsBefore)}`)
    ok(/\d\s*篇/.test(csvLabel), `预览认出了 CSV 里的表（按钮写着「${csvLabel}」）`, csvLabel)

    await page.locator('button:has-text("确认导入")').first().click()
    await page.waitForTimeout(2500)

    /*
     * ⚠️ 按**夹具文件名**定位，不能用 `filter(type==='sheet').slice(-1)`。
     *   种子数据里本来就有表格文稿（「内部通讯录」），
     *   而 slice 之后断言「有 N 篇」——**那是恒真的**：切完了当然有 N 篇。
     *   第一版就这么写的，于是断言全绿、验的却是别人的文档。
     */
    const shape = await page.evaluate((needle) => {
      const st = window.__yqStore.getState()
      const mine = Object.values(st.docs).filter((d) => (d.title || '').includes(needle))
      return mine.map((d) => {
        const s = d.sheetData && d.sheetData.sheets
        return {
          title: d.title,
          type: d.type,
          sheetsIsArray: Array.isArray(s),
          hasInnerArray: !!(s && Array.isArray(s.sheets)),
          tabCount: s && Array.isArray(s.sheets) ? s.sheets.length : -1,
          activeId: s ? s.activeId : '(sheets 整个不是对象)',
          firstCell: s && Array.isArray(s.sheets) && s.sheets[0] && s.sheets[0].rows
            /* rows[0] 是**单元格对象数组** `[{ v: '张三' }, …]`，不是字符串 ——
               第一版按字符串去 `.includes('姓名')`，于是断言永远不成立。
               「数据在不在」这件事得按它真实的形状验。 */
            ? s.sheets[0].rows.map((r) => (Array.isArray(r) ? r.map((c) => (c && c.v !== undefined ? c.v : c)) : r)).join(',')
            : null,
        }
      })
    }, '表格夹具')
    console.log('       ' + JSON.stringify(shape).slice(0, 240))
    const sheetsAfter = await page.evaluate(() =>
      Object.values(window.__yqStore.getState().docs).filter((d) => d.type === 'sheet').map((d) => d.title))
    console.log(`       导入后表格文稿 ${sheetsAfter.length} 篇：${JSON.stringify(sheetsAfter)}`)

    ok(shape.length === CSV_COUNT, `导进来 ${CSV_COUNT} 篇表格（按夹具名实得 ${shape.length}）`)
    ok(shape.length > 0 && shape.every((s) => s.type === 'sheet'),
      '★ 导入出来的是**表格文稿**（type=sheet）')
    ok(shape.length > 0 && shape.every((s) => !s.sheetsIsArray),
      '★ `sheetData.sheets` 不是数组 —— 它必须是 `{ sheets, activeId }` 这个对象')
    ok(shape.length > 0 && shape.every((s) => s.hasInnerArray && s.tabCount === 1),
      '★ 每个 `sheetData.sheets` 里有 1 个 SheetTab（表真的存进去了）')
    ok(shape.length > 0 && shape.every((s) => s.firstCell && s.firstCell.includes('张三') && s.firstCell.includes('研发')),
      '★ 表里的第一行读得出来（不是空壳）', JSON.stringify(shape.map((s) => s.firstCell)))
    ok(shape.length > 0 && shape.every((s) => s.activeId && !s.activeId.startsWith('(')),
      '★ `activeId` 在 sheets 对象里（原来它被放在 sheetData 的顶层，读取方看不到）')

    // 收尾：把**按名字找到的**这几篇删掉（别用 slice，会删到别人的）
    await page.evaluate((needle) => {
      const st = window.__yqStore.getState()
      const hit = Object.values(st.docs).filter((d) => (d.title || '').includes(needle))
      for (const d of hit) st.deleteDoc(d.id)
    }, '表格夹具')
    const left = await page.evaluate((needle) =>
      Object.values(window.__yqStore.getState().docs).filter((d) => (d.title || '').includes(needle)).length,
    '表格夹具')
    ok(left === 0, `表格产物已清理（残留 ${left} 篇）`)
  }

  console.log('\n== 收尾 ==')
  const n = await page.evaluate(() => {
    const st = window.__yqStore.getState()
    const MINE = ['夹具甲', '夹具乙']
    const hit = Object.keys(st.docs).filter((id) => MINE.includes(st.docs[id].title || ''))
    for (const id of hit) st.deleteDoc(id)
    return hit.length
  })
  ok(n > 0, `删掉了 ${n} 篇导入产物`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
  try { rmSync(FIX_ROOT, { recursive: true, force: true }) } catch { /* runner 会兜底清 */ }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1
