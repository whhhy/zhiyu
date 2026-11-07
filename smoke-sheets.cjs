/**
 * 冒烟：工作表 / 数据表 / 画板 的「改数据 → 断言 store → 刷新 → 断言恢复」
 *   核心断言：数据落在 doc.sheetData（localStorage 往返），不是组件里的临时 state。
 *   附带：工作表 / 画板 的全屏态与内嵌态数据一致；存量文档（无 sheetData）能正常打开。
 *
 * 用法：node smoke-sheets.cjs
 *      SMOKE_DIST=/path/to/dist  可以指向一份构建快照，避免和并行的 build 抢同一个目录
 */
const { chromium } = require('playwright')
const http = require('http')
const fs = require('fs')
const path = require('path')
const DIST = process.env.SMOKE_DIST || 'dist'

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0]
  let f = path.join(DIST, u === '/' ? 'index.html' : u)
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
  res.end(fs.readFileSync(f))
})

const PORT = 5100 + Math.floor(Math.random() * 500)
const BASE = process.env.SMOKE_BASE || `http://localhost:${PORT}`
// ⚠️ 这里原来写死的是 '/workspace/yuque/.smoke…' —— Linux 开发环境的残留。
//    在 Windows 上它被解析成 `H:\workspace\yuque\.smoke`，**截图落在工作区外面、
//    盘根下面**，而 .gitignore 里明明列着这些目录名（本来的意图就是放在项目根）。
//    实测一次就堆了 15.1MB，而且**没有任何地方会报**。
//    截图是手动套件唯一的失败取证手段，落在人不会去看的地方，
//    「失败了但看不出为什么」和「套件没跑」长得一模一样。
//    所以改成脚本所在目录；要放别处用 SMOKE_OUT 覆盖。
const OUT = process.env.SMOKE_OUT || path.join(__dirname, '.smoke-sheets')
fs.mkdirSync(OUT, { recursive: true })

const STORAGE_KEY = 'yuque-clone-data-v1'
const SHEET_DOC = 't6'   // 工作表
const TABLE_DOC = 'd7'   // 数据表
const BOARD_DOC = 'd8'   // 画板

const errors = []
const steps = []

;(async () => {
  await new Promise((r) => server.listen(PORT, r))
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  const page = await ctx.newPage()

  page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`) })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

  const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` })

  const check = async (label, fn) => {
    const before = errors.length
    try {
      await fn()
      const newErrs = errors.slice(before)
      steps.push({ label, ok: newErrs.length === 0, errs: newErrs })
      console.log(`${newErrs.length === 0 ? '✅' : '❌'} ${label}${newErrs.length ? '\n   ' + newErrs.join('\n   ') : ''}`)
    } catch (e) {
      steps.push({ label, ok: false, errs: [e.message] })
      console.log(`❌ ${label}\n   ${e.message}`)
    }
  }

  /** store 里那篇文档的 sheetData 快照（深拷贝，避免拿到活引用） */
  const sheetData = (id) =>
    page.evaluate((docId) => {
      const d = window.__yqStore.getState().docs[docId]
      return d && d.sheetData ? JSON.parse(JSON.stringify(d.sheetData)) : null
    }, id)

  /** 当前选中的那个工作表 */
  const activeTab = async (id) => {
    const d = await sheetData(id)
    return d.sheets.sheets.find((x) => x.id === d.sheets.activeId)
  }
  const tabs = async (id) => (await sheetData(id)).sheets.sheets

  /** localStorage 里的落盘结果 */
  const stored = () =>
    page.evaluate((key) => {
      const raw = localStorage.getItem(key)
      return raw ? JSON.parse(raw) : null
    }, STORAGE_KEY)

  const open = async (hash, sel) => {
    await page.goto(`${BASE}${hash}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(sel, { timeout: 8000 })
    await page.waitForTimeout(250)
  }

  const eq = (actual, expected, what) => {
    if (actual !== expected) throw new Error(`${what}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
  const near = (actual, expected, what, tol = 2) => {
    if (Math.abs(actual - expected) > tol) throw new Error(`${what}：期望 ≈${expected}，实际 ${actual}`)
  }
  /** 落盘有 400ms 防抖，刷新前先等它落完（pagehide 也会兜底） */
  const settle = () => page.waitForTimeout(700)

  /* ============================================================
     一、工作表
     ============================================================ */

  await check('工作表：首次打开把种子写进 doc.sheetData', async () => {
    await open('/#/book/b2/doc/t6', '.yq-sheet-grid')
    const d = await sheetData(SHEET_DOC)
    if (!d || !d.sheets || d.sheets.sheets.length !== 1) throw new Error('sheetData.sheets 未落盘: ' + JSON.stringify(d))
    eq(d.sheets.sheets[0].rows.length, 8, '种子行数')
    eq(d.sheets.sheets[0].cols.length, 6, '种子列数')
    eq(await page.locator('.yq-sheet-tab').count(), 1, 'tab 数量')
    await settle()
    const ls = await stored()
    if (!ls || !ls.docs[SHEET_DOC].sheetData) throw new Error('localStorage 里没有 sheetData')
    await shot('01-sheet-seed')
  })

  await check('工作表：改单元格 → store → 刷新 → 恢复', async () => {
    const cell = page.locator('[data-cell="1-1"] input')
    await cell.click()
    await cell.fill('改过的需求名称')
    await page.waitForTimeout(200)
    let d = await sheetData(SHEET_DOC)
    eq(d.sheets.sheets[0].rows[1][1].v, '改过的需求名称', 'store 里的单元格值')
    // 别的行不能被牵连
    eq(d.sheets.sheets[0].rows[2][1].v, '全文检索支持评论', '相邻行未受影响')

    await settle()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-cell="1-1"] input', { timeout: 8000 })
    eq(await page.inputValue('[data-cell="1-1"] input'), '改过的需求名称', '刷新后 DOM 上的值')
    d = await sheetData(SHEET_DOC)
    eq(d.sheets.sheets[0].rows[1][1].v, '改过的需求名称', '刷新后 store 里的值')
    await shot('02-sheet-cell')
  })

  await check('工作表：类型化单元格（下拉 / 日期）写入真实数据', async () => {
    await page.selectOption('[data-cell="1-3"] select', '已完成')
    await page.waitForTimeout(150)
    await page.fill('[data-cell="1-5"] input', '2025-12-31')
    await page.waitForTimeout(200)
    const d = await sheetData(SHEET_DOC)
    eq(d.sheets.sheets[0].rows[1][3].v, '已完成', '下拉列的值')
    eq(d.sheets.sheets[0].rows[1][5].v, '2025-12-31', '日期列的值')
  })

  await check('工作表：多工作表（新增 / 改名 / 切换数据独立 / 删除）', async () => {
    await page.click('.yq-sheet-bar button:has-text("工作表")')
    await page.waitForSelector('.yq-sheet-tab:nth-of-type(2)', { timeout: 3000 })
    let d = await sheetData(SHEET_DOC)
    eq(d.sheets.sheets.length, 2, '新增后的 sheet 数')
    eq(d.sheets.activeId, d.sheets.sheets[1].id, '新 sheet 已激活')

    // 双击第二个 tab 改名
    await page.dblclick('.yq-sheet-tab:nth-of-type(2)')
    await page.waitForSelector('.yq-sheet-rename', { timeout: 3000 })
    await page.fill('.yq-sheet-rename', '副本表')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(200)
    d = await sheetData(SHEET_DOC)
    eq(d.sheets.sheets[1].name, '副本表', '改后的 sheet 名')

    // 新 sheet 里的改动不能污染第一个 sheet
    await page.fill('[data-cell="0-0"] input', '只属于副本表')
    await page.waitForTimeout(200)
    d = await sheetData(SHEET_DOC)
    eq(d.sheets.sheets[1].rows[0][0].v, '只属于副本表', '新 sheet 自己的数据')
    eq(d.sheets.sheets[0].rows[0][0].v, 'REQ-001', '原 sheet 未被污染')

    // 切回第一个 tab：数据还在
    await page.click('.yq-sheet-tab:nth-of-type(1)')
    await page.waitForTimeout(200)
    eq(await page.inputValue('[data-cell="1-1"] input'), '改过的需求名称', '切回后原数据仍在')

    // 删掉第二个 sheet
    await page.click('.yq-sheet-more')
    await page.click('.yq-menu-item:has-text("删除工作表")')
    await page.waitForTimeout(250)
    d = await sheetData(SHEET_DOC)
    eq(d.sheets.sheets.length, 1, '删除后的 sheet 数')
    if (d.sheets.activeId !== d.sheets.sheets[0].id) throw new Error('activeId 指向了已删除的 sheet')
    await shot('03-sheet-tabs')
  })

  await check('工作表：增删行列落到 sheetData', async () => {
    await page.click('[title="插入一行"]')
    await page.waitForTimeout(200)
    let t = await activeTab(SHEET_DOC)
    eq(t.rows.length, 9, '插入行后的行数')
    eq(t.rows[8].length, 6, '新行按列数补齐')

    await page.click('[title="删除当前行"]')
    await page.waitForTimeout(200)
    t = await activeTab(SHEET_DOC)
    eq(t.rows.length, 8, '删除行后的行数')

    await page.click('[title="插入一列"]')
    await page.waitForTimeout(200)
    t = await activeTab(SHEET_DOC)
    eq(t.cols.length, 7, '插入列后的列数')
    eq(t.rows[0].length, 7, '每行都补齐了新列')

    // 改列名 + 改列类型（数字）
    await page.fill('.yq-sheet-header-row td:nth-of-type(8) .yq-sheet-colname', '预估工时')
    await page.click('.yq-sheet-header-row td:nth-of-type(8) .yq-sheet-colkind')
    await page.click('.yq-menu-item:has-text("数字")')
    await page.waitForTimeout(250)
    t = await activeTab(SHEET_DOC)
    eq(t.cols[6].name, '预估工时', '列名')
    eq(t.cols[6].k, 'number', '列类型')

    await page.click('[title="删除当前列"]')
    await page.waitForTimeout(200)
    t = await activeTab(SHEET_DOC)
    eq(t.cols.length, 6, '删除列后的列数')
    eq(t.rows[0].length, 6, '删除列后每行长度')
  })

  await check('工作表：键盘导航（方向键 / Enter / Tab）', async () => {
    // 焦点在 input 上，data-cell 在它所在的 td 上
    const focusCell = () =>
      page.evaluate(() => document.activeElement?.closest?.('[data-cell]')?.getAttribute('data-cell') ?? null)
    await page.click('[data-cell="0-0"] input')
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(150)
    eq(await focusCell(), '1-0', 'ArrowDown 后焦点')
    await page.keyboard.press('Tab')
    await page.waitForTimeout(150)
    eq(await focusCell(), '1-1', 'Tab 后焦点')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(150)
    eq(await focusCell(), '2-1', 'Enter 后焦点')
    await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(150)
    eq(await focusCell(), '2-0', 'Shift+Tab 后焦点')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(150)
    eq(await focusCell(), '2-1', 'ArrowRight 后焦点')
  })

  await check('工作表：全屏态与内嵌态数据一致', async () => {
    // 内嵌态改一格 → 进全屏看得见
    await page.click('[data-cell="3-1"] input')
    await page.fill('[data-cell="3-1"] input', '全屏前改的')
    await page.waitForTimeout(200)
    await page.click('button[title="进入卡片的独立编辑界面"]')
    await page.waitForSelector('.yq-sheet-fs', { timeout: 3000 })
    await page.waitForTimeout(500)
    eq(await page.inputValue('.yq-sheet-fs [data-cell="3-1"] input'), '全屏前改的', '全屏里看到内嵌态的改动')
    const fsBox = await page.locator('.yq-sheet-fs').boundingBox()
    const vp = page.viewportSize()
    if (fsBox.width < vp.width * 0.95 || fsBox.height < vp.height * 0.95) {
      throw new Error(`工作表未铺满全屏 ${JSON.stringify(fsBox)}`)
    }
    await shot('04-sheet-fs')

    // 全屏态再改一格 → 退出后仍在（且落盘）
    await page.fill('.yq-sheet-fs [data-cell="4-2"] input', '全屏里改的')
    await page.click('.yq-sheet-fs [title="插入一行"]')
    await page.waitForTimeout(250)
    let d = await sheetData(SHEET_DOC)
    eq(d.sheets.sheets[0].rows[4][2].v, '全屏里改的', '全屏态改动已落盘')
    eq(d.sheets.sheets[0].rows.length, 9, '全屏态插入的行已落盘')

    await page.click('.yq-sheet-fs-back')
    await page.waitForTimeout(300)
    if ((await page.locator('.yq-sheet-fs').count()) > 0) throw new Error('未退出全屏')
    eq(await page.inputValue('[data-cell="4-2"] input'), '全屏里改的', '退出全屏后改动仍在')

    await settle()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-sheet-grid', { timeout: 8000 })
    d = await sheetData(SHEET_DOC)
    eq(d.sheets.sheets[0].rows[4][2].v, '全屏里改的', '刷新后仍在')
    eq(d.sheets.sheets[0].rows[3][1].v, '全屏前改的', '刷新后内嵌态的改动仍在')
  })

  /* ============================================================
     二、数据表
     ============================================================ */

  await check('数据表：首次打开把种子写进 doc.sheetData', async () => {
    await open('/#/book/b2/doc/d7', '.yq-dt-bar')
    const d = await sheetData(TABLE_DOC)
    if (!d || !d.table) throw new Error('sheetData.table 未落盘: ' + JSON.stringify(d))
    eq(d.table.records.length, 8, '种子记录数')
    eq(d.table.views.length, 4, '种子视图数')
    eq(await page.locator('.yq-dt-table tbody tr[data-record-id]').count(), 8, '表格渲染行数')
  })

  await check('数据表：增删记录 → store → 刷新 → 恢复', async () => {
    await page.click('.yq-dt-bar button:has-text("新建记录")')
    await page.waitForSelector('.yq-dt-editor', { timeout: 3000 })
    let d = await sheetData(TABLE_DOC)
    eq(d.table.records.length, 9, '新建后的记录数')
    const newId = d.table.records[8].id
    // 新记录默认挂在成员（周砚）上
    const members = await page.evaluate(() => window.__yqStore.getState().members.map((m) => m.name))
    if (!members.includes(d.table.records[8].owner)) {
      throw new Error(`新记录的负责人不是真实成员: ${d.table.records[8].owner}`)
    }
    // 详情面板里改字段（负责人 / 状态 / 日期）
    await page.fill('.yq-dt-editor .yq-dt-field:nth-of-type(1) .yq-dt-input', '刷新后要还在')
    await page.selectOption('.yq-dt-editor .yq-dt-field:nth-of-type(3) select', '进行中')
    await page.waitForTimeout(250)
    d = await sheetData(TABLE_DOC)
    const rec = d.table.records.find((r) => r.id === newId)
    eq(rec.name, '刷新后要还在', '改后的记录名')
    eq(rec.status, '进行中', '改后的状态')

    await settle()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-dt-table tbody tr[data-record-id]', { timeout: 8000 })
    eq(await page.locator('.yq-dt-table tbody tr[data-record-id]').count(), 9, '刷新后的行数')
    d = await sheetData(TABLE_DOC)
    const rec2 = d.table.records.find((r) => r.id === newId)
    eq(rec2.name, '刷新后要还在', '刷新后的记录名')
    eq(rec2.status, '进行中', '刷新后的状态')
    await shot('05-table-crud')

    // 删掉一条，回到 8 条并持久化
    await page.click(`.yq-dt-table tr[data-record-id="${newId}"] .yq-dt-del`)
    await page.waitForTimeout(250)
    d = await sheetData(TABLE_DOC)
    eq(d.table.records.length, 8, '删除后的记录数')
    await settle()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-dt-table tbody tr[data-record-id]', { timeout: 8000 })
    eq(await page.locator('.yq-dt-table tbody tr[data-record-id]').count(), 8, '刷新后的行数')
  })

  await check('数据表：四个视图看的是同一份数据', async () => {
    const readRecs = async () => (await sheetData(TABLE_DOC)).table.records.length

    await page.click('.yq-segmented button:has-text("看板")')
    await page.waitForSelector('.yq-dt-kanban', { timeout: 3000 })
    const kanbanCards = await page.locator('.yq-dt-card').count()
    eq(kanbanCards, 8, '看板卡片数')
    eq(await readRecs(), 8, '看板下记录数没变')

    await page.click('.yq-segmented button:has-text("画廊")')
    await page.waitForSelector('.yq-dt-gallery', { timeout: 3000 })
    eq(await page.locator('.yq-dt-gcard').count(), 8, '画廊卡片数')

    await page.click('.yq-segmented button:has-text("日历")')
    await page.waitForSelector('.yq-dt-cal-grid', { timeout: 3000 })
    // 切到日历应落在最早有数据的那个月，而不是空白的当月
    if ((await page.locator('.yq-dt-event').count()) < 1) throw new Error('日历视图没有事件')
    eq(await page.locator('.yq-dt-cell').count(), 42, '月历格子数')
    const month0 = await page.textContent('.yq-dt-cal-title')
    await page.click('.yq-dt-cal-nav button:has-text("‹")')
    await page.waitForTimeout(250)
    if ((await page.textContent('.yq-dt-cal-title')) === month0) throw new Error('上一月没翻动')
    const d = await sheetData(TABLE_DOC)
    eq(d.table.views.find((v) => v.id === d.table.activeViewId).month.length, 7, '翻月已落盘')
    await page.click('.yq-dt-cal-nav button:has-text("›")')
    await page.waitForTimeout(250)
    eq(await page.textContent('.yq-dt-cal-title'), month0, '翻回原月份')
    eq(await readRecs(), 8, '日历下记录数没变')

    await page.click('.yq-segmented button:has-text("表格")')
    await page.waitForSelector('.yq-dt-table', { timeout: 3000 })
    eq(await page.locator('.yq-dt-table tbody tr[data-record-id]').count(), 8, '切回表格仍是 8 条')
    await shot('06-table-views')
  })

  await check('数据表：筛选 / 搜索 / 排序作用在真实数据上', async () => {
    // 状态筛选
    await page.selectOption('.yq-dt-filter >> nth=0', '已完成')
    await page.waitForTimeout(250)
    eq(await page.locator('.yq-dt-table tbody tr[data-record-id]').count(), 3, '已完成记录数')
    let d = await sheetData(TABLE_DOC)
    eq(d.table.views.find((v) => v.id === d.table.activeViewId).status, '已完成', '筛选落盘')

    // 搜索（叠加在筛选之上）
    await page.fill('.yq-dt-search input', '导出')
    await page.waitForTimeout(250)
    eq(await page.locator('.yq-dt-table tbody tr[data-record-id]').count(), 1, '搜索后的行数')
    d = await sheetData(TABLE_DOC)
    eq(d.table.views.find((v) => v.id === d.table.activeViewId).q, '导出', '搜索词落盘')

    // 排序方向切换
    await page.click('.yq-dt-bar button:has-text("升序")')
    await page.waitForTimeout(250)
    d = await sheetData(TABLE_DOC)
    eq(d.table.views.find((v) => v.id === d.table.activeViewId).dir, 'desc', '排序方向落盘')

    // 清掉筛选条件
    await page.fill('.yq-dt-search input', '')
    await page.selectOption('.yq-dt-filter >> nth=0', '全部')
    await page.waitForTimeout(250)
    eq(await page.locator('.yq-dt-table tbody tr[data-record-id]').count(), 8, '恢复全部')

    // 高级筛选条件：优先级 = P0
    await page.click('.yq-dt-bar button:has-text("筛选条件")')
    await page.waitForSelector('.yq-dt-rules', { timeout: 3000 })
    await page.click('.yq-dt-rules button:has-text("添加条件")')
    await page.waitForTimeout(200)
    await page.selectOption('.yq-dt-rule >> nth=0 >> select >> nth=0', 'priority')
    await page.waitForTimeout(200)
    await page.selectOption('.yq-dt-rule >> nth=0 >> select >> nth=2', 'P0')
    await page.waitForTimeout(250)
    eq(await page.locator('.yq-dt-table tbody tr[data-record-id]').count(), 2, 'P0 记录数')
    // Popover 靠「点外面」关闭：直接按坐标点正文空白处（绕开 actionability 检查，
    // 点的地方也不能是顶栏/侧栏那种会触发导航的元素）
    await page.mouse.click(700, 860)
    await page.waitForTimeout(250)
    // 收尾：删掉条件，后续用例从全量数据开始
    await page.click('.yq-dt-bar button:has-text("筛选条件")')
    await page.waitForSelector('.yq-dt-rules', { timeout: 3000 })
    await page.click('.yq-dt-rule-del >> nth=0')
    await page.waitForTimeout(250)
    await page.mouse.click(700, 860)
    await page.waitForTimeout(250)
    eq(await page.locator('.yq-dt-table tbody tr[data-record-id]').count(), 8, '清掉条件后恢复全量')
    await shot('07-table-filter')
  })

  await check('数据表：看板拖拽改状态，刷新后仍在', async () => {
    await page.click('.yq-segmented button:has-text("看板")')
    await page.waitForSelector('.yq-dt-kanban', { timeout: 3000 })
    const src = page.locator('.yq-dt-col[data-status="进行中"] .yq-dt-card').first()
    const id = await src.getAttribute('data-record-id')
    const name = await src.locator('.yq-dt-card-name').textContent()

    await page.evaluate((rid) => {
      const el = document.querySelector(`[data-record-id="${rid}"]`)
      el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }))
    }, id)
    await page.waitForTimeout(100)
    await page.evaluate((rid) => {
      const el = document.querySelector('.yq-dt-col[data-status="已完成"]')
      const dt = new DataTransfer()
      const b = el.getBoundingClientRect()
      const at = { clientX: b.left + b.width / 2, clientY: b.top + 30 }
      el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }))
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, ...at }))
    }, id)
    await page.waitForTimeout(300)
    let d = await sheetData(TABLE_DOC)
    eq(d.table.records.find((r) => r.id === id).status, '已完成', '拖拽后的状态')

    await settle()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-dt-kanban', { timeout: 8000 })
    d = await sheetData(TABLE_DOC)
    eq(d.table.records.find((r) => r.id === id).status, '已完成', '刷新后的状态')
    const moved = await page.locator(`.yq-dt-col[data-status="已完成"] [data-record-id="${id}"]`).count()
    eq(moved, 1, `刷新后「${name}」仍在已完成列`)
    await page.click('.yq-segmented button:has-text("表格")')
    await page.waitForTimeout(200)
  })

  await check('数据表：刷新后视图与筛选条件都恢复', async () => {
    await page.click('.yq-dt-viewbtn')
    await page.waitForSelector('.yq-menu-item:has-text("卡片墙")', { timeout: 3000 })
    await page.click('.yq-menu-item:has-text("卡片墙")')
    await page.waitForSelector('.yq-dt-gallery', { timeout: 3000 })
    await page.selectOption('.yq-dt-filter >> nth=0', '进行中')
    await page.waitForTimeout(250)
    const shown = await page.locator('.yq-dt-gcard').count()
    let d = await sheetData(TABLE_DOC)
    const viewId = d.table.activeViewId

    await settle()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-dt-gallery', { timeout: 8000 })
    d = await sheetData(TABLE_DOC)
    eq(d.table.activeViewId, viewId, '刷新后仍是同一个视图')
    eq(d.table.views.find((v) => v.id === viewId).status, '进行中', '刷新后筛选条件仍在')
    eq(await page.locator('.yq-dt-gcard').count(), shown, '刷新后画廊卡片数一致')

    // 收尾：切回「全部需求」
    await page.click('.yq-dt-viewbtn')
    await page.waitForSelector('.yq-menu-item:has-text("全部需求")', { timeout: 3000 })
    await page.click('.yq-menu-item:has-text("全部需求")')
    await page.waitForTimeout(200)
    await page.selectOption('.yq-dt-filter >> nth=0', '全部')
    await page.waitForTimeout(200)
  })

  /* ============================================================
     三、画板
     ============================================================ */

  await check('画板：首次打开把种子写进 doc.sheetData', async () => {
    await open('/#/book/b2/doc/d8', '.yq-board-card')
    const d = await sheetData(BOARD_DOC)
    if (!d || !d.board) throw new Error('sheetData.board 未落盘: ' + JSON.stringify(d))
    eq(d.board.cards.length, 8, '种子卡片数')
    eq(d.board.edges.length, 7, '种子连线数')
    eq(await page.locator('.yq-board-card').count(), 8, '渲染卡片数')
    await settle()
    const ls = await stored()
    if (!ls || !ls.docs[BOARD_DOC].sheetData) throw new Error('localStorage 里没有 sheetData')
    await shot('08-board-seed')
  })

  await check('画板：增删卡片 / 拖动位置 / 改底色形状 → 刷新恢复', async () => {
    // 拖动 b1：(40,30) → (140,100)
    const box = await page.locator('.yq-board-card[data-card-id="b1"]').boundingBox()
    await page.mouse.move(box.x + 30, box.y + 20)
    await page.mouse.down()
    await page.mouse.move(box.x + 130, box.y + 90, { steps: 10 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    let d = await sheetData(BOARD_DOC)
    const moved = d.board.cards.find((c) => c.id === 'b1')
    near(moved.x, 140, '拖动后的 x')
    near(moved.y, 100, '拖动后的 y')

    // 选中 → 改底色 + 形状
    await page.click('.yq-board-card[data-card-id="b1"]')
    await page.waitForTimeout(150)
    await page.click('.yq-board-bar .yq-board-swatch >> nth=2')
    await page.waitForTimeout(200)
    await page.click('.yq-board-bar button:has-text("形状")')
    await page.waitForSelector('.yq-menu-item:has-text("菱形")', { timeout: 3000 })
    await page.click('.yq-menu-item:has-text("菱形")')
    await page.waitForTimeout(250)
    d = await sheetData(BOARD_DOC)
    eq(d.board.cards.find((c) => c.id === 'b1').shape, 'diamond', '形状已改')
    if (!d.board.cards.find((c) => c.id === 'b1').color.startsWith('var(--yq-')) {
      throw new Error('底色没有用 token')
    }

    // 双击改文字
    await page.dblclick('.yq-board-card[data-card-id="b1"]')
    await page.waitForSelector('.yq-board-edit', { timeout: 3000 })
    await page.fill('.yq-board-edit', '改过的卡片')
    await page.click('.yq-board-canvas', { position: { x: 5, y: 480 } })
    await page.waitForTimeout(300)
    d = await sheetData(BOARD_DOC)
    eq(d.board.cards.find((c) => c.id === 'b1').text, '改过的卡片', '改后的文字')

    // 新增一张卡片
    await page.click('.yq-board-add')
    await page.waitForTimeout(250)
    d = await sheetData(BOARD_DOC)
    eq(d.board.cards.length, 9, '新增后的卡片数')
    const added = d.board.cards[8].id
    await shot('09-board-edit')

    // 刷新后全部恢复
    await settle()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-board-card', { timeout: 8000 })
    d = await sheetData(BOARD_DOC)
    eq(d.board.cards.length, 9, '刷新后的卡片数')
    const b1 = d.board.cards.find((c) => c.id === 'b1')
    near(b1.x, 140, '刷新后的 x')
    near(b1.y, 100, '刷新后的 y')
    eq(b1.text, '改过的卡片', '刷新后的文字')
    eq(b1.shape, 'diamond', '刷新后的形状')
    if (!d.board.cards.some((c) => c.id === added)) throw new Error('刷新后新增的卡片不见了')
    eq(await page.locator('.yq-board-card').count(), 9, '刷新后渲染卡片数')
  })

  await check('画板：连线增删', async () => {
    await page.click('.yq-board-card[data-card-id="b8"]')
    await page.waitForTimeout(150)
    await page.click('.yq-board-bar button:has-text("连线")')
    await page.waitForTimeout(150)
    await page.click('.yq-board-card[data-card-id="b1"]')
    await page.waitForTimeout(300)
    let d = await sheetData(BOARD_DOC)
    eq(d.board.edges.length, 8, '新增连线后的连线数')
    eq(d.board.edges.filter((e) => e.from === 'b8' && e.to === 'b1').length, 1, '新连线在数据里')

    // 重复连同一条不应该产生第二条
    await page.click('.yq-board-bar button:has-text("连线")')
    await page.waitForTimeout(120)
    await page.click('.yq-board-card[data-card-id="b1"]')
    await page.waitForTimeout(200)
    d = await sheetData(BOARD_DOC)
    eq(d.board.edges.length, 8, '重复连线没有新增')

    // 删掉刚建的那条
    const chip = page.locator('.yq-board-chip', { hasText: '📌 待办' }).first()
    await chip.locator('button').click()
    await page.waitForTimeout(250)
    d = await sheetData(BOARD_DOC)
    eq(d.board.edges.length, 7, '删除连线后的连线数')

    // 删卡片要连它身上的线一起删
    await page.click('.yq-board-card[data-card-id="b4"]')
    await page.waitForTimeout(150)
    await page.click('.yq-board-del')
    await page.waitForTimeout(250)
    d = await sheetData(BOARD_DOC)
    eq(d.board.cards.length, 8, '删卡片后的卡片数')
    if (d.board.edges.some((e) => e.from === 'b4' || e.to === 'b4')) throw new Error('删卡片后留下了悬空连线')
  })

  await check('画板：导出 JSON（可下载）', async () => {
    await page.click('.yq-board-bar button:has-text("JSON")')
    await page.waitForSelector('.yq-board-json', { timeout: 3000 })
    const raw = await page.textContent('.yq-board-json')
    const json = JSON.parse(raw)
    eq(json.type, 'board', '导出类型')
    const board = (await sheetData(BOARD_DOC)).board
    eq(json.cards.length, board.cards.length, '导出的卡片数与 store 一致')
    eq(json.edges.length, board.edges.length, '导出的连线数与 store 一致')
    if (typeof json.cards[0].x !== 'number' || typeof json.cards[0].text !== 'string') {
      throw new Error('导出的结构不是纯数据')
    }
    const ids = new Set(json.cards.map((c) => c.id))
    if (json.edges.some((e) => !ids.has(e.from) || !ids.has(e.to))) {
      throw new Error('导出里有悬空连线')
    }
    // 纯 JSON：不能夹带任何 DOM / 函数
    if (JSON.stringify(json).includes('[object')) throw new Error('导出内容不干净')
    const dl = page.waitForEvent('download', { timeout: 8000 })
    await page.click('.yq-board-btn.is-primary')
    const file = await dl
    if (!file.suggestedFilename()) throw new Error('下载没有文件名')
    if (!/\.json$/.test(file.suggestedFilename())) {
      throw new Error('下载文件名不对: ' + file.suggestedFilename())
    }
    console.log(`   ⇩ 下载文件名: ${file.suggestedFilename()}`)
    await shot('10-board-export')
  })

  await check('画板：全屏态与内嵌态数据一致', async () => {
    await page.click('.yq-board-bar button:has-text("全屏")')
    await page.waitForSelector('.yq-board-fs', { timeout: 3000 })
    await page.waitForTimeout(500)
    const fsBox = await page.locator('.yq-board-fs').boundingBox()
    const vp = page.viewportSize()
    if (fsBox.width < vp.width * 0.95 || fsBox.height < vp.height * 0.95) {
      throw new Error(`画板未铺满全屏 ${JSON.stringify(fsBox)}`)
    }
    eq(await page.locator('.yq-board-fs .yq-board-card').count(), 8, '全屏里的卡片数')
    const before = (await sheetData(BOARD_DOC)).board.cards.length

    // 全屏态里加一张卡
    await page.click('.yq-board-fs .yq-board-add')
    await page.waitForTimeout(300)
    const mid = await sheetData(BOARD_DOC)
    eq(mid.board.cards.length, before + 1, '全屏态新增的卡片已落盘')

    // 全屏态里拖动
    const b = await page.locator('.yq-board-fs .yq-board-card[data-card-id="b2"]').boundingBox()
    await page.mouse.move(b.x + 30, b.y + 20)
    await page.mouse.down()
    await page.mouse.move(b.x + 90, b.y + 60, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)
    const dragged = (await sheetData(BOARD_DOC)).board.cards.find((c) => c.id === 'b2')
    if (dragged.x === 240 && dragged.y === 30) throw new Error('全屏态拖动没有落盘')
    await shot('11-board-fs')

    // 退出全屏：数据仍在
    await page.click('.yq-board-fs .yq-board-bar button:has-text("退出全屏")')
    await page.waitForTimeout(300)
    if ((await page.locator('.yq-board-fs').count()) > 0) throw new Error('未退出全屏')
    eq(await page.locator('.yq-board-card').count(), before + 1, '退出后卡片数一致')
    const after = (await sheetData(BOARD_DOC)).board.cards.find((c) => c.id === 'b2')
    eq(after.x, dragged.x, '退出全屏后 x 一致')
    eq(after.y, dragged.y, '退出全屏后 y 一致')
  })

  /* ============================================================
     四、存量文档兼容
     ============================================================ */

  await check('存量文档（没有 sheetData）能正常打开并补写种子', async () => {
    await page.goto(`${BASE}/#/book/b2/doc/d8`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-board-card', { timeout: 8000 })
    await settle()
    // 手动把三篇文稿的 sheetData 抠掉，模拟升级前的存档
    await page.evaluate(([key, ids]) => {
      const raw = JSON.parse(localStorage.getItem(key))
      ids.forEach((id) => { if (raw.docs[id]) delete raw.docs[id].sheetData })
      localStorage.setItem(key, JSON.stringify(raw))
    }, [STORAGE_KEY, [SHEET_DOC, TABLE_DOC, BOARD_DOC]])

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-board-card', { timeout: 8000 })
    eq(await page.locator('.yq-board-card').count(), 8, '画板按种子兜底渲染')
    let d = await sheetData(BOARD_DOC)
    eq(d.board.cards.length, 8, '种子补写回 doc.sheetData')

    await open('/#/book/b2/doc/t6', '.yq-sheet-grid')
    eq(await page.locator('.yq-sheet-grid tbody tr').count(), 9, '工作表按种子兜底渲染')
    d = await sheetData(SHEET_DOC)
    eq(d.sheets.sheets.length, 1, '工作表种子补写')

    await open('/#/book/b2/doc/d7', '.yq-dt-bar')
    eq(await page.locator('.yq-dt-table tbody tr[data-record-id]').count(), 8, '数据表按种子兜底渲染')
    d = await sheetData(TABLE_DOC)
    eq(d.table.records.length, 8, '数据表种子补写')
    await shot('12-legacy-fallback')
  })

  await check('只读模式不写盘', async () => {
    await page.goto(`${BASE}/#/book/b2/doc/t6`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-sheet-grid', { timeout: 8000 })
    await settle()
    const before = JSON.stringify((await tabs(SHEET_DOC))[0].rows)
    // 切到阅读模式：DocPage 把 readOnly 传下来，组件不该再提供任何写入口
    // 阅读模式开关是正文工具条上的第一个 .yq-doc-act（👁）
    await page.locator('.yq-doc-act').first().click()
    await page.waitForTimeout(400)
    if ((await page.locator('.yq-sheet-bar button:has-text("全屏")').count()) > 0) {
      throw new Error('阅读态不该出现全屏（可写）入口')
    }
    if ((await page.locator('[title="插入一行"]').count()) > 0) {
      throw new Error('阅读态不该出现插入行按钮')
    }
    const after = JSON.stringify((await tabs(SHEET_DOC))[0].rows)
    if (before !== after) throw new Error('阅读态不应改数据')
    await page.locator('.yq-doc-act').first().click()
    await page.waitForTimeout(300)
  })

  await browser.close()
  server.close()

  const failed = steps.filter((s) => !s.ok)
  console.log('\n' + '='.repeat(50))
  console.log(`通过 ${steps.length - failed.length}/${steps.length}`)
  if (failed.length) {
    console.log('\n失败项：')
    failed.forEach((f) => console.log(`  ✗ ${f.label}\n    ${f.errs.join('\n    ')}`))
  }
  console.log(`\n截图目录: ${OUT}`)
  process.exit(failed.length ? 1 : 0)
})()
