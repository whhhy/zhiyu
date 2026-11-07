/**
 * Markdown 导入端到端：导入的图，**导入后真的画得出来**。
 *
 * ⚠️ 为什么要单独有这条：
 *   `test-mdgraph.mjs` 在**解析层**断块结构（32 项全绿），而渲染要走
 *   `PlantumlCard` → `detect()` → `pickDiagramMode` → 各渲染器。
 *   中间任何一段对不上，导入的文档里就是一片空白或写着「未实现」，
 *   而**没有一项断言会红**。
 *   甘特图那个缺陷就是这么活下来的：解析器 40 多项全绿，
 *   而用户点产品的「填入 Gantt 示例」得到的是一张「未实现」的卡。
 *
 * 走的是**真实入口**：设置 → 数据管理 → 导入 Markdown 文件夹 → 真目录 → 确认导入。
 * 覆盖 `LOCALLY_RENDERED_MODES` 全部 12 种 —— 公司里现成的文档正是这批围栏。
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'

const BASE = process.env.BASE || 'http://localhost:8092'
const DIR = path.resolve('data/_mdimport-e2e/导入夹具')

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`) }
}

/* 12 种：10 种 mermaid 全走 ```mermaid，DOT 走 ```dot，PlantUML 走 ```plantuml。
   围栏语言只认 `DIAGRAM_FENCE_LANGS`（mermaid/dot/graphviz/gv/plantuml/uml/puml/pu），
   写别的标签会落进代码块分支 —— 那样测的就不是「图渲染」了。 */
const CASES = [
  { name: '流程图', fence: 'mermaid', src: 'graph TD\n    A([开始]) --> B{审核通过吗}\n    B -->|是| C[完成]', desc: 'Mermaid 流程图（本地渲染）' },
  { name: '时序图', fence: 'mermaid', src: 'sequenceDiagram\n    autonumber\n    actor 用户\n    participant 网关 as GW\n    用户->>GW: 提交订单\n    GW-->>用户: 成功', desc: 'Mermaid 时序图（本地渲染）' },
  { name: '状态图', fence: 'mermaid', src: 'stateDiagram-v2\n    [*] --> 待支付\n    待支付 --> 已支付 : 用户付款\n    已支付 --> [*]', desc: 'Mermaid 状态图（本地渲染）' },
  { name: '脑图', fence: 'mermaid', src: 'mindmap\n  root((知识库))\n    文档\n      规范\n    卡片\n      互动', desc: 'Mermaid 脑图（本地渲染）' },
  { name: '饼图', fence: 'mermaid', src: 'pie title 文档内容分布\n    "正文" : 45\n    "卡片" : 30\n    "附件" : 15', desc: 'Mermaid 饼图（本地渲染）' },
  { name: '类图', fence: 'mermaid', src: 'classDiagram\n    class 文档 {\n      +string 标题\n      +int 字数\n    }\n    文档 "1" <-- "0..N" 知识库 : 归属', desc: 'Mermaid 类图（本地渲染）' },
  { name: '实体关系图', fence: 'mermaid', src: 'erDiagram\n    CUSTOMER ||--o{ ORDER : places\n    CUSTOMER {\n      string name PK\n    }\n    ORDER {\n      int id PK\n    }', desc: 'Mermaid 实体关系图（本地渲染）' },
  { name: '用户旅程', fence: 'mermaid', src: 'journey\n  title 上岗\n  section 第一天\n    领账号: 3: 小王\n  section 首周\n    跑通流程: 5: 小王', desc: 'Mermaid 用户旅程图（本地渲染）' },
  { name: '时间线', fence: 'mermaid', src: 'timeline\n  title 历程\n  2024 Q1 : 调研\n  2025 Q1 : 上线', desc: 'Mermaid 时间线（本地渲染）' },
  { name: '桑基图', fence: 'mermaid', src: 'sankey-beta\n    title 预算分配\n    收入,成本,40\n    成本,人力,25', desc: 'Mermaid 桑基图（本地渲染）' },
  { name: 'Graphviz', fence: 'dot', src: 'digraph 工单流转 {\n    rankdir=LR;\n    start  [label="收到工单", shape=box];\n    start -> check [label="提交"];\n}', desc: 'Graphviz DOT（本地渲染）' },
  { name: 'PlantUML', fence: 'plantuml', src: '@startuml\nactor 用户\nparticipant 网关\n用户 -> 网关 : 下单\n@enduml', desc: 'PlantUML（结构预览）' },
]

mkdirSync(DIR, { recursive: true })
writeFileSync(
  path.join(DIR, '图种夹具.md'),
  ['# 图种夹具', '',
    ...CASES.flatMap((c) => [`## ${c.name}`, '', '```' + c.fence, c.src, '```', '']),
  ].join('\n'),
  'utf8',
)

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
/* 只放行本域：内网部署场景下第三方的 iframe 不该占住主线程 */
await ctx.route('**/*', (r) => {
  const h = new URL(r.request().url()).hostname
  return h === 'localhost' || h === '127.0.0.1' ? r.continue() : r.abort()
})
const page = await ctx.newPage()

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

  console.log('\n== 走真实入口导入 ==')
  await page.goto(BASE + '/#/settings', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  /* ⚠️ 设置页是**分页签**布局，导入那一组在「数据管理」里，不点开就没有那个入口。
     2026-10-16 起入口收成了「导入…」→ 格式选择器（照语雀的形态），
     「选择文件夹」那个按钮没有了 —— 现在是选择器里的「Markdown 文件夹」这一项。 */
  await page.locator('button', { hasText: '数据管理' }).first().click()
  await page.waitForTimeout(700)
  await page.locator('button', { hasText: '导入…' }).first().click()
  await page.waitForSelector('.yq-imppick-item', { state: 'visible', timeout: 8000 })
  await page.locator('.yq-imppick-item', { hasText: 'Markdown 文件夹' }).first().click()
  /* `<input webkitdirectory>` 是隐藏的，必须等 attached 而不是默认的 visible */
  await page.waitForSelector('.yq-import-drop input[type="file"]', { state: 'attached', timeout: 10000 })
  await page.setInputFiles('.yq-import-drop input[type="file"]', DIR)

  await page.waitForSelector('button:has-text("确认导入")', { timeout: 20000 })
  await page.waitForTimeout(400)
  const label = (await page.locator('button:has-text("确认导入")').first().textContent() || '').trim()
  ok(/确认导入\s*1\s*篇/.test(label), `预览里认出 1 篇（按钮写着「${label}」）`, label)
  await page.locator('button:has-text("确认导入")').first().click()
  await page.waitForTimeout(2500)

  const docId = await page.evaluate(() => {
    const d = Object.values(window.__yqStore.getState().docs).find((x) => (x.title || '').includes('图种夹具'))
    return d ? d.id : null
  })
  ok(!!docId, '导入的文档出现在库里', String(docId))
  if (!docId) throw new Error('导入后找不到文档，后面的断言没法做')

  console.log('\n== 12 种图种逐个验「真的出了 SVG」==')
  await page.goto(`${BASE}/#/book/b1/doc/${docId}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-card-id="plantuml"]', { timeout: 20000 })
  await page.waitForTimeout(800)

  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('[data-card-id="plantuml"]')].map((c) => ({
      desc: (c.querySelector('.yq-kc-desc') || {}).textContent?.trim() || '',
      hasSvg: !!c.querySelector('.yq-kc-plant-svg svg, .yq-kc-plant-view'),
    })))
  ok(cards.length === CASES.length, `产出 ${CASES.length} 张文本绘图卡片`, `实际 ${cards.length}`)

  for (const c of CASES) {
    const hit = cards.filter((x) => x.desc === c.desc)
    if (!hit.length) {
      ok(false, `${c.name}：没找到标题为「${c.desc}」的卡片`,
        '现有标题：' + JSON.stringify(cards.map((x) => x.desc).filter(Boolean)))
      continue
    }
    /* ⚠️ 两件事都要断：标题判对了**且** SVG 出来了。
       只断标题的话，判对了却画出空图照样绿（那才是「骗人」）。 */
    ok(hit[0].hasSvg, `${c.name}：标题判成「${c.desc}」且真的出了 SVG`)
  }

  console.log('\n== 收尾 ==')
  const n = await page.evaluate(() => {
    const st = window.__yqStore.getState()
    const hit = Object.keys(st.docs).filter((id) => {
      const t = st.docs[id].title || ''
      return t.includes('图种夹具') || t.includes('导入夹具')
    })
    for (const id of hit) st.deleteDoc(id)
    return hit.length
  })
  ok(n > 0, `删掉了 ${n} 篇导入产物`)

  /* ⚠️ **知识库本身删不掉**，这不是本套件偷懒，是产品现在**没有这个能力**：
     store 里只有 `createBook` / `updateBook`，没有 `deleteBook`；
     服务端也没有删除知识库的端点；UI 里同样没有入口。
     导入是按文件夹建库的，于是每跑一次就留下一个空的「导入夹具」库。
     官方语雀是可以删除知识库的 —— 这是一个真实缺口，已列入待办。
     这里只**如实说明**，不把「删库」算成本套件的失败项。 */
  const leftover = await page.evaluate(() =>
    window.__yqStore.getState().books.filter((b) => (b.name || '').includes('导入夹具')).length)
  console.log(`  ⚠️ 留下 ${leftover} 个「导入夹具」知识库 —— 产品没有删除知识库的能力，不是本套件能清的`)
} catch (e) {
  fail++
  console.error('异常：', e.message)
} finally {
  await browser.close()
  try { rmSync(path.resolve('data/_mdimport-e2e'), { recursive: true, force: true }) } catch { /* runner 会兜底清 */ }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1