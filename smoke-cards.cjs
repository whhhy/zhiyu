/**
 * 特色卡片冒烟测试
 * 逐张卡片：/ 斜杠菜单插入 → 真交互（填字/选人/投票/拖节点/传文件…）
 *          → 断言 DOM 结构 + 断言数据真的进了 store
 * 最后刷新一次，断言所有卡片和它们的结构化数据都还在。
 */
const { chromium } = require('playwright')
const http = require('http')
const fs = require('fs')
const path = require('path')
const DIST = process.env.SMOKE_DIST || 'dist'

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0]
  let f = path.join(__dirname, DIST, u === '/' ? 'index.html' : u)
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(__dirname, DIST, 'index.html')
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' })
  res.end(fs.readFileSync(f))
})

const PORT = 4800 + Math.floor(Math.random() * 300)
const BASE = `http://localhost:${PORT}`
// ⚠️ 这里原来写死的是 '/workspace/yuque/.smoke…' —— Linux 开发环境的残留。
//    在 Windows 上它被解析成 `H:\workspace\yuque\.smoke`，**截图落在工作区外面、
//    盘根下面**，而 .gitignore 里明明列着这些目录名（本来的意图就是放在项目根）。
//    实测一次就堆了 15.1MB，而且**没有任何地方会报**。
//    截图是手动套件唯一的失败取证手段，落在人不会去看的地方，
//    「失败了但看不出为什么」和「套件没跑」长得一模一样。
//    所以改成脚本所在目录；要放别处用 SMOKE_OUT 覆盖。
const OUT = process.env.SMOKE_OUT || path.join(__dirname, 'data', '_smoke-cards')
fs.mkdirSync(OUT, { recursive: true })

const errors = []
const steps = []

/* 1×1 透明 PNG，测本地文件读 base64 用 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
/* 44 字节静音 WAV：44 字节头 + 一段采样 */
const WAV = Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([0x24, 0, 0, 0]), Buffer.from('WAVEfmt '),
  Buffer.from([0x10, 0, 0, 0, 0x01, 0x00, 0x01, 0x00, 0x44, 0xac, 0, 0, 0x88, 0x58, 0x01, 0x00, 0x02, 0x00, 0x10, 0x00]),
  Buffer.from('data'), Buffer.from([0, 0, 0, 0]),
])

/** 每张卡：id、中文名（斜杠菜单里点的字）、交互、DOM 断言、store 断言 */
const CARDS = [
  {
    id: 'file', name: '附件',
    async run(page, sel) {
      await page.setInputFiles(`${sel} input[type=file]`, {
        name: '需求说明.txt', mimeType: 'text/plain', buffer: Buffer.from('hello card'),
      })
      await page.waitForSelector(`${sel} .yq-kc-file-name`, { timeout: 3000 })
      const name = await page.textContent(`${sel} .yq-kc-file-name`)
      if (name.trim() !== '需求说明.txt') throw new Error('文件名不对: ' + name)
    },
    dom: (sel) => `${sel} .yq-kc-file`,
    // 附件二进制进了 IndexedDB：Block.data 里只留元信息 + 指纹，不该再有 base64
    data: (d) =>
      d.name === '需求说明.txt' &&
      !!d.key &&
      d.stored === true &&
      !d.dataUrl &&
      !JSON.stringify(d).includes('base64'),
    desc: '文件 → IndexedDB（Block.data 只留元信息）',
  },
  {
    id: 'formula', name: '公式',
    async run(page, sel) {
      await page.fill(`${sel} textarea`, '\\frac{a}{b} + \\sum_{i=1}^{n} x_i^2')
      await page.waitForSelector(`${sel} .yq-tex-frac`, { timeout: 3000 })
      if ((await page.locator(`${sel} .yq-tex-bigop-sup`).count()) !== 1)
        throw new Error('\\sum 的上限位没渲染出来')
      await page.waitForTimeout(500) // 卡片里有 350ms 防抖，等它写回文档
    },
    dom: (sel) => `${sel} .yq-tex-frac`,
    data: (d) => String(d.src).includes('frac'),
    desc: 'LaTeX 真渲染（分式 + 大算符限位）',
  },
  {
    id: 'fold', name: '折叠块',
    async run(page, sel) {
      await page.fill(`${sel} .yq-kc-fold-title`, '点击展开看细节')
      await page.waitForSelector(`${sel} .yq-kc-fold-body`, { timeout: 2000 })
      await page.click(`${sel} .yq-kc-fold-caret`)
      if ((await page.locator(`${sel} .yq-kc-fold-body`).count()) !== 0)
        throw new Error('点折叠头没收起来')
      await page.click(`${sel} .yq-kc-fold-caret`)
      await page.waitForSelector(`${sel} .yq-kc-fold-body`, { timeout: 2000 })
    },
    dom: (sel) => `${sel} .yq-kc-fold.is-open`,
    data: (d) => d.title === '点击展开看细节' && d.open === true,
    desc: '展开/收起 + 标题可编辑',
  },
  {
    id: 'columns', name: '分栏卡片',
    async run(page, sel) {
      if ((await page.locator(`${sel} .yq-kc-col`).count()) !== 2) throw new Error('默认不是 2 栏')
      await page.click(`${sel} .yq-kc-btn:has-text("增加一栏")`)
      if ((await page.locator(`${sel} .yq-kc-col`).count()) !== 3) throw new Error('加栏没生效')
      await page.fill(`${sel} .yq-kc-col textarea`, '第一栏内容')
    },
    dom: (sel) => `${sel} .yq-kc-columns`,
    data: (d) => Array.isArray(d.cols) && d.cols.length === 3,
    desc: '2 栏 → 3 栏',
  },
  {
    id: 'emoji', name: '表情',
    async run(page, sel) {
      await page.click(`${sel} .yq-kc-emoji-grid .yq-kc-emoji-btn >> nth=0`)
      await page.waitForSelector(`${sel} .yq-kc-emoji-used`, { timeout: 2000 })
    },
    dom: (sel) => `${sel} .yq-kc-emoji-grid`,
    data: (d) => Array.isArray(d.used) && d.used.length === 1,
    desc: '点选表情（插到光标处 + 记住最近使用）',
  },
  {
    id: 'status', name: '状态',
    async run(page, sel) {
      await page.selectOption(`${sel} select`, 'doing')
      const badge = await page.textContent(`${sel} .yq-kc-badge`)
      if (badge.trim() !== '进行中') throw new Error('徽章没变: ' + badge)
    },
    dom: (sel) => `${sel} .yq-kc-badge.is-doing`,
    data: (d) => d.status === 'doing',
    desc: '下拉选状态 → 彩色徽章',
  },
  {
    id: 'mention', name: '提及',
    async run(page, sel) {
      await page.click(`${sel} .yq-kc-picker-item >> nth=1`)
      const chip = await page.textContent(`${sel} .yq-chip`)
      if (!chip.includes('@')) throw new Error('chip 不是 @名字 形态: ' + chip)
    },
    dom: (sel) => `${sel} .yq-chip`,
    data: (d) => !!d.memberId,
    desc: '选成员 → @名字 chip',
  },
  {
    id: 'calendar', name: '日历',
    async run(page, sel) {
      const today = new Date()
      const p = (n) => String(n).padStart(2, '0')
      const ds = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`
      await page.click(`${sel} .yq-kc-cal-cell[data-date="${ds}"]`)
      const t = await page.textContent(`${sel} .yq-kc-cal-sel`)
      if (t.trim() !== ds) throw new Error('选中日期没显示: ' + t)
    },
    dom: (sel) => `${sel} .yq-kc-cal-grid`,
    data: (d) => /^\d{4}-\d{2}-\d{2}$/.test(d.selected || ''),
    desc: '月视图 + 点选日期',
  },
  {
    id: 'vote', name: '投票',
    async run(page, sel) {
      await page.fill(`${sel} .yq-kc-vote-q`, '上线时间选哪天？')
      await page.click(`${sel} .yq-kc-vote-opt >> nth=0 >> .yq-kc-btn:has-text("投这一票")`)
      const num = await page.textContent(`${sel} .yq-kc-vote-opt >> nth=0 >> .yq-kc-vote-num`)
      if (!num.includes('100%')) throw new Error('结果条没算对: ' + num)
      const w = await page.getAttribute(`${sel} .yq-kc-vote-fill`, 'style')
      if (!w || !w.includes('100%')) throw new Error('结果条宽度不对: ' + w)
    },
    dom: (sel) => `${sel} .yq-kc-vote-fill`,
    data: (d) => d.options[0].votes.length === 1 && d.q === '上线时间选哪天？',
    desc: '投票 + 结果条',
  },
  {
    id: 'checkin', name: '打卡',
    async run(page, sel) {
      await page.click(`${sel} .yq-kc-btn:has-text("打卡")`)
      const n = await page.textContent(`${sel} .yq-kc-checkin-num`)
      if (n.trim() !== '1') throw new Error('连续天数不对: ' + n)
      await page.click(`${sel} .yq-kc-btn:has-text("30 格")`)
      if ((await page.locator(`${sel} .yq-kc-checkin-cell`).count()) !== 30)
        throw new Error('切 30 格没生效')
    },
    dom: (sel) => `${sel} .yq-kc-checkin-cell.is-on`,
    data: (d) => d.dates.length === 1 && d.span === 30,
    desc: '打卡 + 连续天数 + 7/30 格',
  },
  {
    id: 'mindmap', name: '思维导图',
    async run(page, sel) {
      const before = await page.locator(`${sel} .yq-kc-map-node`).count()
      await page.click(`${sel} li[data-map-node] >> nth=0 >> .yq-kc-btn:has-text("＋")`)
      const after = await page.locator(`${sel} .yq-kc-map-node`).count()
      if (after !== before + 1) throw new Error(`加子节点没生效 ${before}→${after}`)
    },
    dom: (sel) => `${sel} .yq-kc-map-tree`,
    data: (d) => d.nodes.length === 4 && d.nodes.filter((n) => n.parent === 'n1').length === 3,
    desc: '增删节点 + 父子关系',
  },
  {
    id: 'flowchart', name: '流程图',
    async run(page, sel) {
      // 1) 拖动节点
      const box = await page.locator(`${sel} [data-flow-node]`).first().boundingBox()
      const before = await page.evaluate(() => 0) // 占位，真实断言在下面取 store
      void before
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 8 })
      await page.mouse.up()
      await page.waitForTimeout(200)

      // 2) 从右侧圆点拉线到第三个节点
      const port = await page.locator(`${sel} [data-flow-node] >> nth=0 >> .yq-kc-flow-port`).first().boundingBox()
      const target = await page.locator(`${sel} [data-flow-node]`).nth(2).boundingBox()
      await page.mouse.move(port.x + port.width / 2, port.y + port.height / 2)
      await page.mouse.down()
      await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 })
      await page.mouse.up()
      await page.waitForTimeout(200)

      // 排除拉线过程中的临时虚线（.is-new）
      if ((await page.locator(`${sel} .yq-kc-flow-edge:not(.is-new)`).count()) !== 3)
        throw new Error('连线没加上')
    },
    dom: (sel) => `${sel} .yq-kc-flow-node`,
    data: (d) => d.edges.length === 3 && d.nodes[0].x !== 30,
    desc: '拖动节点 + 拉线连节点',
  },
  {
    id: 'encrypted', name: '加密文本',
    async run(page, sel) {
      await page.fill(`${sel} textarea`, '你好 hello 语雀')
      await page.click(`${sel} .yq-kc-btn:has-text("编码")`)
      const cipher = (await page.textContent(`${sel} .yq-kc-enc-out`)).trim()
      if (!cipher) throw new Error('没生成密文')
      await page.fill(`${sel} textarea`, '')
      await page.click(`${sel} .yq-kc-btn:has-text("解码")`)
      const back = await page.inputValue(`${sel} textarea`)
      if (back !== '你好 hello 语雀') throw new Error('解码回来不对: ' + back)
    },
    dom: (sel) => `${sel} .yq-kc-enc-out[data-cipher="1"]`,
    data: (d) => !!d.cipher && d.text === '你好 hello 语雀',
    desc: 'Base64 编解码（中文不乱码）',
  },
  {
    id: 'album', name: '画册',
    async run(page, sel) {
      await page.setInputFiles(`${sel} input[type=file]`, {
        name: 'pic.png', mimeType: 'image/png', buffer: PNG,
      })
      await page.waitForSelector(`${sel} .yq-kc-album-item img`, { timeout: 3000 })
    },
    dom: (sel) => `${sel} .yq-kc-album`,
    data: (d) => d.items.length === 1 && d.items[0].url.startsWith('data:image/png;base64,'),
    desc: '图片九宫格 + 本地图片 base64',
  },
  {
    id: 'kanban', name: '看板',
    async run(page, sel) {
      page.once('dialog', (d) => d.accept('写卡片冒烟'))
      await page.click(`${sel} .yq-kc-kb-col >> nth=0 >> .yq-kc-kb-add`)
      await page.waitForSelector(`${sel} .yq-kc-kb-card`, { timeout: 2000 })
      // 往右移一列
      await page.click(`${sel} .yq-kc-kb-card >> nth=0 >> .yq-kc-btn:has-text("›")`)
      const inCol = await page.locator(`${sel} .yq-kc-kb-col >> nth=1 >> .yq-kc-kb-card`).count()
      if (inCol !== 1) throw new Error('卡片没移到第二列')
    },
    dom: (sel) => `${sel} .yq-kc-kanban`,
    data: (d) => d.cols[1].cards.length === 1,
    desc: '看板 + 左右移动卡片',
  },
  {
    id: 'yuquedoc', name: '知语内容',   // 跟 src/data/cards.ts 的显示名同步
    async run(page, sel) {
      await page.click(`${sel} .yq-kc-picker-item >> nth=0`)
      await page.waitForSelector(`${sel} .yq-kc-yqdoc`, { timeout: 2000 })
    },
    dom: (sel) => `${sel} .yq-kc-yqdoc`,
    data: (d) => !!d.docId,
    desc: '选一篇文档 → 站内可点卡片',
  },
  {
    id: 'uml', name: 'UML图',
    async run(page, sel) {
      if ((await page.locator(`${sel} .yq-kc-uml-box`).count()) !== 2) throw new Error('默认 2 个类不对')
      await page.click(`${sel} .yq-kc-btn:has-text("＋ 类")`)
      if ((await page.locator(`${sel} .yq-kc-uml-box`).count()) !== 3) throw new Error('加类没生效')
      await page.click(`${sel} .yq-kc-btn:has-text("＋ 关系")`)
      await page.waitForTimeout(300)
      // 连线是 <svg><path>：没有包围盒，Playwright 会判它 hidden，只能断言存在
      if ((await page.locator(`${sel} .yq-kc-uml-line`).count()) !== 1) throw new Error('关系连线没画出来')
    },
    dom: (sel) => `${sel} .yq-kc-uml-box`,
    data: (d) => d.classes.length === 3 && d.relations.length === 1,
    desc: '类图：增删类 + 关系连线',
  },
  {
    id: 'plantuml', name: '文本绘图',
    async run(page, sel) {
      /* ⚠️ 下面这 15 条验的是**真实卡片组件那条路**：改 textarea → React 重渲染 →
         PlantumlCard 的 detect() → pickDiagramMode 路由 → 本地渲染器 → SVG 进 DOM。
         之前的像素验证全是「静态预览页 + 真实 CSS」，**绕过了 detect()** ——
         路由写错（比如某个图种落到 unsupported）静态页照样好看，
         而用户在卡片里看到的是「没解析出任何节点」。这一段补的就是那道盲区。

         覆盖 `LOCALLY_RENDERED_MODES` **全部 12 种**（状态图另加 fork/note/复合态三条，
         那三个的 CSS 类是独立写的，正是「代码在但样式从来没写过」那类坑的高发区）。

         ⚠️ 每条断两件事，缺一不可：
           ① 根 SVG 类名出现了（图真的画出来了）
           ② `.yq-kc-desc` 的标题正好是这一种（图种**判对了**）
         ② 不是多余的：**flow / state / dot 三种都渲染成 `yq-fc-svg`**
         （state 和 dot 都复用 flowchart 的渲染器），类图与实体关系图更是共用 `yq-cd-svg`。
         只断 ① 的话，把 `graph TD` 误判成 dot、把类图误判成 ER 照样全绿 ——
         而用户在卡片里看到的是一张不相干的图。

         为什么并在这张卡里、而不是新开一张「本地渲染图」：
         data/cards.ts 里文本绘图只有 plantuml 这一个 id，本地渲染是**这张卡
         内部按源码内容分的 12 条路**，不是另一张卡。第一版新开了一个 id，
         斜杠菜单里根本没有那个条目 → insert() 打字打不中 → 正文残留
         「/本地渲染图」→ 后面 12 张卡跟着全塌（21 通过 / 13 失败）。
         卡的数量由 CARDS.length 定死，「27 张卡片全部落进文档」那条也跟着对不上。 */
      const LOCAL = [
        ['流程图', `graph TD
    A([开始]) --> B{审核通过吗}
    B -->|是| C[生成正式文档]
    B -->|否| D[(退回队列)]
    C --> E([完成])
    D -.-> A`, 'yq-fc-svg', 'Mermaid 流程图（本地渲染）'],
        ['时序图', `sequenceDiagram
    autonumber
    actor 用户
    participant 网关 as GW
    database 订单库
    用户->>GW: 提交订单
    GW->>+订单库: 写入订单
    订单库-->>-GW: 返回订单号
    alt 库存充足
        GW-->>用户: 下单成功
    else 库存不足
        GW--x用户: 缺货
    end`, 'yq-seq-svg', 'Mermaid 时序图（本地渲染）'],
        ['Graphviz', `digraph 工单流转 {
    rankdir=LR;
    start  [label="收到工单", shape=box];
    check  [label="需要审批吗", shape=diamond];
    start -> check [label="提交"];
}`, 'yq-fc-svg', 'Graphviz DOT（本地渲染）'],
        ['甘特图', `gantt
    dateFormat YYYY-MM-DD
    title 内网知识库一期排期
    section 准备
    需求确认      :done,    r1, 2026-01-05, 2026-01-09
    section 开发
    知识库 CRUD   :active,  d2, after r1, 10d
    section 上线
    全量切换      :         m2, after d2, 2d`, 'yq-gantt-svg', 'Gantt 甘特图（本地渲染）'],
        ['状态图', `stateDiagram-v2
    [*] --> 待支付
    待支付 --> 已支付 : 用户付款
    已支付 --> [*]`, 'yq-fc-svg', 'Mermaid 状态图（本地渲染）'],
        ['脑图', `mindmap
  root((知识库))
    文档
      规范
      流程
    卡片
      互动`, 'yq-mm-svg', 'Mermaid 脑图（本地渲染）'],
        ['饼图', `pie title 文档内容分布
    "正文" : 45
    "卡片" : 30
    "附件" : 15`, 'yq-pie-svg', 'Mermaid 饼图（本地渲染）'],
        ['类图', `classDiagram
    class 文档 {
      +string 标题
      +int 字数
    }
    文档 "1" <-- "0..N" 知识库 : 归属`, 'yq-cd-svg', 'Mermaid 类图（本地渲染）'],
        ['实体关系图', `erDiagram
    CUSTOMER ||--o{ ORDER : places
    CUSTOMER {
      string name PK
    }
    ORDER {
      int id PK
    }`, 'yq-cd-svg', 'Mermaid 实体关系图（本地渲染）'],
        ['状态图 fork', `stateDiagram-v2
  [*] --> A
  state 分 <<fork>>
  A --> 分
  分 --> B
  B --> [*]`, 'yq-fc-fork', 'Mermaid 状态图（本地渲染）'],
        ['状态图 note', `stateDiagram-v2
  [*] --> A
  A --> [*]
  note right of A : 客户已签收`, 'yq-fc-note', 'Mermaid 状态图（本地渲染）'],
        ['状态图复合态', `stateDiagram-v2
  [*] --> A
  A --> 外层
  外层 --> [*]
  state 外层 {
    内1 --> 内2
  }`, 'yq-fc-composite', 'Mermaid 状态图（本地渲染）'],
        ['用户旅程', `journey
  title 上岗
  section 第一天
    领账号: 3: 小王
  section 首周
    跑通流程: 5: 小王`, 'yq-journey-svg', 'Mermaid 用户旅程图（本地渲染）'],
        ['时间线', `timeline
  title 历程
  2024 Q1 : 调研
  2025 Q1 : 上线`, 'yq-tl-svg', 'Mermaid 时间线（本地渲染）'],
        ['桑基图', `sankey-beta
  总预算,人力,40
  总预算,云服务,25`, 'yq-sk-svg', 'Mermaid 桑基图（本地渲染）'],
      ]
      for (const [nm, s2, cls, want] of LOCAL) {
        await page.fill(`${sel} textarea`, s2)
        try {
          await page.waitForSelector(`${sel} .${cls}`, { timeout: 3000 })
        } catch {
          const view = await page.textContent(`${sel} .yq-kc-plant-view`).catch(() => '')
          throw new Error(`${nm}：卡片里没出现 .${cls}（多半是 detect() 把它路由成了别的东西）。卡片标题=` +
            (await page.textContent(`${sel} .yq-kc-desc`).catch(() => '?')) +
            ' 视图=' + String(view).slice(0, 60))
        }
        /* ⚠️ 括号位置：`.trim()` 必须在 await 之后。写成
           `(await page.textContent(...).trim())` 是对 **Promise** 调 trim，
           报 `page.textContent(...).trim is not a function`。
           第一版就是这么写的，15 条一条都没跑完 —— 因为它挂在第一条。 */
        const got = (await page.textContent(`${sel} .yq-kc-desc`)).trim()
        if (got !== want) {
          throw new Error(`${nm}：**图种判错了** —— 期望标题「${want}」，实际「${got}」` +
            '（这类错光看 SVG 类名抓不到）')
        }
      }
      /* ⚠️ 循环放前面、@startuml 放**最后**：底下的 data() 判据读的是最后一次
         写入的 src，所以判据一个字都不用改。顺序反过来就得同时改判据和
         「27 张卡片」那个写死数字的检查名 —— 两处都容易漏。 */
      await page.fill(`${sel} textarea`, '@startuml\nactor 用户\nparticipant 网关\n用户 -> 网关 : 下单\n@enduml')
      await page.waitForSelector(`${sel} .yq-kc-plant-view`, { timeout: 2000 })
      const t = await page.textContent(`${sel} .yq-kc-plant-view`)
      if (!t.includes('用户') || !t.includes('网关')) throw new Error('结构预览没解析出来: ' + t)
    },
    dom: (sel) => `${sel} .yq-kc-plant-view`,
    data: (d) => String(d.src).includes('@startuml'),
    desc: 'PlantUML 源码 + 本地结构预览；且 12 种图种在真实卡片里经 detect() 路由后真出 SVG 且图种判对（另含状态图 fork·note·复合态）',
  },
  {
    id: 'localfile', name: '本地文件',
    async run(page, sel) {
      await page.setInputFiles(`${sel} input[type=file]`, {
        name: 'readme.md', mimeType: 'text/markdown', buffer: Buffer.from('# hi'),
      })
      await page.waitForSelector(`${sel} .yq-kc-file-name`, { timeout: 3000 })
    },
    dom: (sel) => `${sel} .yq-kc-file`,
    data: (d) => d.name === 'readme.md' && !!d.key && !d.dataUrl && !JSON.stringify(d).includes('base64'),
    desc: '本地文档 → IndexedDB + 下载',
  },
  {
    id: 'localaudio', name: '本地音频',
    async run(page, sel) {
      await page.setInputFiles(`${sel} input[type=file]`, {
        name: 'ding.wav', mimeType: 'audio/wav', buffer: WAV,
      })
      await page.waitForSelector(`${sel} audio`, { timeout: 3000 })
      const src = await page.getAttribute(`${sel} audio`, 'src')
      // 从 IndexedDB 取回后生成的是 blob: URL，不再是内联 data URL
      if (!src.startsWith('blob:')) throw new Error('音频 src 不对: ' + src)
    },
    dom: (sel) => `${sel} audio.yq-kc-media`,
    data: (d) => !!d.key && d.type === 'audio/wav' && !d.dataUrl,
    desc: '音频真能播（<audio> + blob URL）',
  },
  {
    id: 'localvideo', name: '本地视频',
    async run(page, sel) {
      await page.setInputFiles(`${sel} input[type=file]`, {
        name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(2048, 7),
      })
      await page.waitForSelector(`${sel} video`, { timeout: 3000 })
      const src = await page.getAttribute(`${sel} video`, 'src')
      if (!src.startsWith('blob:')) throw new Error('视频 src 不对: ' + src)
    },
    dom: (sel) => `${sel} video.yq-kc-media`,
    data: (d) => !!d.key && d.type === 'video/mp4' && !d.dataUrl,
    desc: '视频播放器（<video> + blob URL；测试用的是合成文件，只验元素与数据）',
  },
  {
    id: 'youku', name: '优酷',
    async run(page, sel) {
      await page.fill(`${sel} input.yq-kc-input`, 'https://v.youku.com/v_show/id_XNTg4NzQyMzUy.html')
      await page.waitForSelector(`${sel} iframe`, { timeout: 2000 })
      const src = await page.getAttribute(`${sel} iframe`, 'src')
      if (!src.includes('player.youku.com/embed/XNTg4NzQyMzUy')) throw new Error('优酷嵌入地址不对: ' + src)
    },
    dom: (sel) => `${sel} .yq-kc-embed-frame`,
    data: (d) => String(d.url).includes('youku.com'),
    desc: 'URL → 优酷官方播放器 iframe（需联网）',
  },
  {
    id: 'bilibili', name: '哔哩哔哩',
    async run(page, sel) {
      await page.fill(`${sel} input.yq-kc-input`, 'https://www.bilibili.com/video/BV1GJ411x7h7')
      await page.waitForSelector(`${sel} iframe`, { timeout: 2000 })
      const src = await page.getAttribute(`${sel} iframe`, 'src')
      if (!src.includes('player.bilibili.com/player.html?bvid=BV1GJ411x7h7')) throw new Error('B 站嵌入地址不对: ' + src)
    },
    dom: (sel) => `${sel} iframe`,
    data: (d) => String(d.url).includes('bilibili'),
    desc: 'URL → B 站官方播放器 iframe（需联网）',
  },
  {
    id: 'netease', name: '网易云音乐',
    async run(page, sel) {
      await page.fill(`${sel} input.yq-kc-input`, 'https://music.163.com/#/song?id=1824045033')
      await page.waitForSelector(`${sel} iframe`, { timeout: 2000 })
      const src = await page.getAttribute(`${sel} iframe`, 'src')
      if (!src.includes('music.163.com/outreach/player?id=1824045033')) throw new Error('网易云嵌入地址不对: ' + src)
    },
    dom: (sel) => `${sel} iframe`,
    data: (d) => String(d.url).includes('163.com'),
    desc: 'URL → 网易云外链播放器（需联网）',
  },
  {
    id: 'amap', name: '高德地图',
    async run(page, sel) {
      await page.fill(`${sel} input.yq-kc-input`, 'https://m.amap.com/search/mapview/keywords=西湖')
      await page.waitForSelector(`${sel} iframe`, { timeout: 2000 })
      const src = await page.getAttribute(`${sel} iframe`, 'src')
      if (!src.includes('m.amap.com/search/mapview/keywords=')) throw new Error('高德嵌入地址不对: ' + src)
    },
    dom: (sel) => `${sel} .yq-kc-embed-frame`,
    data: (d) => String(d.url).includes('amap.com'),
    desc: 'URL → 高德移动端搜索页（官方嵌入需 JS key，需联网）',
  },
  {
    id: 'figma', name: 'Figma',
    async run(page, sel) {
      await page.fill(`${sel} input.yq-kc-input`, 'https://www.figma.com/file/abc123XYZ/My-Design')
      await page.waitForSelector(`${sel} iframe`, { timeout: 2000 })
      const src = await page.getAttribute(`${sel} iframe`, 'src')
      if (!src.includes('figma.com/embed?embed_host=share')) throw new Error('Figma 嵌入地址不对: ' + src)
    },
    dom: (sel) => `${sel} iframe`,
    data: (d) => String(d.url).includes('figma.com'),
    desc: 'URL → Figma 官方 embed（需联网 + 文件可公开）',
  },
  {
    id: 'juejin', name: '码上掘金',
    async run(page, sel) {
      await page.fill(`${sel} input.yq-kc-input`, 'https://juejin.cn/post/7309335877025186322')
      await page.waitForSelector(`${sel} .yq-kc-embed-fallback a`, { timeout: 2000 })
      if ((await page.locator(`${sel} iframe`).count()) !== 0)
        throw new Error('掘金没有可嵌入地址，不该出现 iframe')
      const href = await page.getAttribute(`${sel} .yq-kc-embed-fallback a`, 'href')
      if (href !== 'https://juejin.cn/post/7309335877025186322') throw new Error('原文链接不对: ' + href)
    },
    dom: (sel) => `${sel} .yq-kc-embed-fallback`,
    data: (d) => String(d.url).includes('juejin.cn'),
    desc: '掘金无官方嵌入 → 如实占位框 + 原文链接',
  },
]

;(async () => {
  await new Promise((r) => server.listen(PORT, r))
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  /**
   * 浏览器里**一律不放行第三方请求**，只放行本域（localhost）。
   *
   * 为什么：youku / bilibili / netease / amap / figma 五张嵌入卡的 iframe 会往
   * log.mmstat.com、d-gm.mmstat.com、gm.mmstat.com、fourier.taobao.com、
   * g.alicdn.com 等域拉资源，一轮实测 137~163 条请求。主线程被这些 iframe
   * 占住之后，**最后一张卡 juejin 的斜杠菜单 15 秒都弹不出来**
   * （`.yq-slash-cards` 等到超时）→ 卡片插不进去 → 「只落了 26/27」
   * 「juejin 刷新后不见了」全是它的连锁。连续两轮同样症状，
   * 所以这不是抖动，是确定性复现 —— 原来那条「放宽到 15s 就够了」的注释不成立。
   *
   * ⚠️ 这**不是**把失败藏起来，理由是这张套件本来就不验远端内容：
   *   · 五张嵌入卡的断言全是「`iframe` 元素存在」+「`src` **属性**是对的那串地址」
   *     —— src 是 React 渲染时就写进属性的，跟远端有没有加载回来无关；
   *   · 「第三方嵌入可达性」那一段走的是 **Node 的 fetch**（下面 EMBED_HOSTS 那个
   *     循环），本来就不经过浏览器，拦浏览器请求一点都碰不到它；
   *   · 套件自述里那句「远端服务真实可达这一层在本机没有验过」仍然成立。
   * 拦掉之后主线程空出来，验的还是同一批结构。
   */
  await ctx.route('**/*', (route) => {
    const host = new URL(route.request().url()).hostname
    if (host === 'localhost' || host === '127.0.0.1') return route.continue()
    return route.abort()
  })
  const page = await ctx.newPage()
  /**
   * 为什么要把 console 错误分两桶。
   *
   * 原来只有一桶 `errors`，判据是「这一步窗口里有没有新错误」。
   * 两个后果，都是实测出来的：
   *
   * ① **把环境问题算成产品缺陷。** 27 张卡片里有 6 张是第三方嵌入
   *    （B站 / 网易云 / 高德 / Figma / 优酷 / 掘金），它们 iframe 指向外网。
   *    本机连不上公网，于是这些 iframe 全部 `ERR_CONNECTION_CLOSED`，
   *    于是这 6 张卡片被报成 ❌ —— 而卡片本身是对的：
   *    `run()` 验的是 **iframe 的 src 属性**，压根不需要联网。
   * ② **错误跨步骤串味。** `errors` 是全局流，iframe 的失败是异步的，
   *    会在任意时刻落进当时正在跑的那一步。实测「按 Ctrl+B 不会把卡片洗掉」
   *    红的原因是一行 `@bilibili/bili-user-fingerprint(report): report is not found`
   *    —— B 站的脚本报的，账却记在了 Ctrl+B 头上。
   *
   * 判据：**同源（本机服务）= 我们的 bug，异源 = 别的服务的问题。**
   * 注意不能把「Failed to load resource」整类当噪音 —— 那样会盖掉
   * 本机资源 404 这种真问题，所以按 URL 的 host 来分，不按文本分。
   */
  const OWN_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]']
  const isOwn = (u) => { try { return OWN_HOSTS.includes(new URL(u).hostname) } catch { return true } }
  const noise = []
  /**
   * 分流规则，按优先级：
   *   1. 有来源 URL 且同源 → errors（我们的资源出问题，是产品缺陷）
   *   2. 有来源 URL 且异源 → noise（别的服务的问题）
   *   3. **没有来源 URL → noise**（浏览器自己发的策略提示，不是某段脚本报的）
   *
   * 第 3 条是踩出来的：`Permissions policy violation: Geolocation access has
   * been blocked…` 这类消息**不带 location**（正文里那个 crbug.com 只是说明页链接），
   * 而 `new URL('')` 会抛错、我上一版的 catch 返回 true —— 于是「查不出来来源」
   * 被当成了「是我们自己的」，Figma 卡片和「刷新后 27 张全在」两项都被它带红。
   *
   * 这样分流不会盖住我们自己的 bug：我们代码报的 console.error 是**带 location 的**
   * （指向本机那个 js 文件），未捕获异常走 pageerror，本来就一直在 errors 里。
   */
  const classify = (text, url) => {
    if (url && isOwn(url)) { errors.push(`[${new URL(url).host}] ${text}`); return }
    noise.push(url ? `[${new URL(url).host}] ${text}` : `[浏览器提示·无来源] ${text}`)
  }
  page.on('console', (m) => { if (m.type() === 'error') classify(m.text(), m.location()?.url) })
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

  /**
   * 本机能不能连公网，逐个第三方域各探一次。
   * 用途只有两个：① 汇总里如实写明那几张卡片「只验了结构、没验远端可达」；
   * ② 以后有人问「为什么这张卡在 CI 上红」，这里能给出当时的答案。
   * **不参与判定** —— 判不判失败看的是上面的同源/异源分流。
   */
  const EMBED_HOSTS = ['www.bilibili.com', 'player.bilibili.com', 'music.163.com',
    'm.amap.com', 'www.figma.com', 'v.youku.com']
  const net = {}
  for (const h of EMBED_HOSTS) {
    try {
      const r = await fetch(`https://${h}/`, { method: 'HEAD', signal: AbortSignal.timeout(2500) })
      net[h] = r.status < 500
    } catch { net[h] = false }
  }

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

  const DOC = 'd_cards_smoke'
  const readData = (cardId) =>
    page.evaluate(([docId, cid]) => {
      const doc = window.__yqStore.getState().docs[docId]
      if (!doc) return null
      const b = doc.blocks.find((x) => x.type === 'card' && x.data && x.data.cardId === cid)
      return b ? JSON.parse(JSON.stringify(b.data)) : null
    }, [DOC, cardId])

  /**
   * 走真实路径：正文里按 "/" → 斜杠菜单 → 选中卡片。
   * 用键盘回车而不是点菜单项：卡片越插越多，菜单会挂在视口外面点不到。
   * 每个卡片名在全目录里唯一，回车选中的就是它（下面会断言选中项的名字）。
   *
   * ⚠️ 等菜单的时限是 15s，但**这已经不再是「靠放宽时限兜住」的那个版本了**。
   * 原注释写的是「从 4s 放宽到 15s 就够了」—— 2026-10-07 实测**不成立**：
   * 15s 下连续两轮都在这里超时，所以它不是抖动，是确定性复现。
   * 真正的修法在上面 ctx.route：**浏览器里根本不放行第三方请求**，
   * iframe 不再往 mmstat / taobao / alicdn 拉那 130~160 条资源，主线程空出来。
   * 15s 现在只是留着的兜底，不承担「保证菜单会出来」这个责任。
   *
   * 说清楚限度：**拦掉第三方之后，这个套件不能证明「重负载下斜杠菜单仍然够快」**。
   * 主线程被占满时菜单多久出来这件事，现在**没有被验**（之前也没有）——
   * 要验得单独构造一个「空文档 + 一堆真 iframe」的用例，那是另一件事。
   * 本套件能证明的是：在没有第三方干扰时 27 张卡逐张插得进去、数据回写正确、
   * 刷新后还在。别把它说成「斜杠菜单不慢」。
   */
  const SLASH_TIMEOUT = 15000
  const insert = async (name, cardId) => {
    const last = page.locator('.yq-block-text').last()
    await last.scrollIntoViewIfNeeded()
    await last.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter') // 造一个干净空块
    await page.locator('.yq-block-text').last().scrollIntoViewIfNeeded()
    await page.keyboard.type('/', { delay: 25 })
    await page.waitForSelector('.yq-slash-cards', { timeout: SLASH_TIMEOUT })
    await page.keyboard.type(name, { delay: 20 })
    await page.waitForTimeout(280)
    const item = page.locator('.yq-slash-item').first()
    if ((await item.count()) !== 1) throw new Error(`「${name}」在菜单里不唯一或没命中`)
    const label = (await item.locator('.yq-slash-name').textContent()).trim()
    if (label !== name) throw new Error(`搜索「${name}」选中的是「${label}」`)
    await page.keyboard.press('Enter')
    await page.waitForSelector(`[data-card-id="${cardId}"]`, { timeout: 4000 })
    // 触发用的 "/" 必须被清掉：曾经因为回写旧 blocks，"/附件" "/公式" 全留在正文里
    await page.waitForTimeout(150)
    const left = await page.$$eval('.yq-block-text', (els) =>
      els.map((e) => e.innerText).filter((t) => t.includes('/')))
    if (left.length) throw new Error(`斜杠菜单的 "/" 没清干净，正文残留: ${JSON.stringify(left)}`)
    await page.locator(`[data-card-id="${cardId}"]`).scrollIntoViewIfNeeded()
  }

  /**
   * 分流规则自检。
   *
   * 为什么非要专门加这一条：健康跑法里**一条同源错误都不会出现**
   * （有的话套件早就红了），所以「同源仍然会被判红」这条路径
   * 在正常运行时是**验不到的**。一个从来没被走过的分支，不能拿来
   * 保证「它没把所有东西都吞进 noise」—— 那正是这次改动最该防的失败模式。
   *
   * 所以直接调 classify 验三个分支，跑完把长度截回去，不污染后面的窗口计数。
   */
  await check('分流自检：同源算错、异源与无来源算噪音', async () => {
    const e0 = errors.length, n0 = noise.length
    classify('自检-同源', 'http://localhost:' + PORT + '/assets/index.js')
    classify('自检-异源', 'https://player.bilibili.com/player.js')
    classify('自检-无来源', undefined)
    const gotE = errors.length - e0
    const gotN = noise.length - n0
    errors.length = e0
    noise.length = n0
    if (gotE !== 1) throw new Error(`同源应算 1 条错，实际 ${gotE}`)
    if (gotN !== 2) throw new Error(`异源 + 无来源应算 2 条噪音，实际 ${gotN}`)
  })

  // 0. 建一篇专用文档
  await check('准备：新建专用文档', async () => {
    await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle' })
    await page.evaluate(([id]) => {
      localStorage.removeItem('yuque-clone-data-v1')
      const s = window.__yqStore.getState()
      const nid = s.createDoc('b1', null, '特色卡片冒烟', 'doc')
      // 固定成好记的 id，刷新后还能按 id 找回来
      const st = window.__yqStore.getState()
      const docs = { ...st.docs }
      const doc = docs[nid]
      delete docs[nid]
      docs[id] = { ...doc, id }
      window.__yqStore.setState({ docs })
      window.__yqStore.getState().toast(`文档已建：${id}`, 'info')
    }, [DOC])
    await page.waitForTimeout(900) // 等防抖落盘
    await page.goto(`${BASE}/#/book/b1/doc/${DOC}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.yq-block-text', { timeout: 5000 })
  })

  /* ⚠️ 2026-10-07 补的一条回归：**斜杠菜单里打空格会把菜单整个关掉**。
   `handleInput` 原来的判据是 `/^\/\S*$/`（`\S` = 非空白），正文一有空格就走
   `onSlashClose()`。实测（在部署实例上逐个输入量命中）：
     「正文 」/「正文 x」/「本 地」/「标题 1」→ 菜单全部消失
   而卡片目录里 4 个名字带空格（标题 1~4），**照菜单上显示的输入一个都选不中**。
   下面这条走真实路径：打 `/标题 1` → 选中 → 块类型真的变成 h1 → `/` 不残留。
   ⚠️ 它放在逐张卡片循环**之前**：格式项走的是 Editor 里 `c.blockType` 那条分支，
   不产生 `data-card-id`，所以下面那个「N 张卡片全部落进文档」的计数不受影响。 */
await check('斜杠菜单：名字带空格的格式项也选得中（标题 1）', async () => {
    const el = page.locator('.yq-block-text').last()
    await el.scrollIntoViewIfNeeded()
    await el.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.locator('.yq-block-text').last().scrollIntoViewIfNeeded()
    await page.keyboard.type('/', { delay: 20 })
    await page.waitForSelector('.yq-slash-cards', { timeout: SLASH_TIMEOUT })
    await page.keyboard.type('标题 1', { delay: 20 })
    await page.waitForTimeout(320)
    const item = page.locator('.yq-slash-item').first()
    const n = await item.count()
    if (n !== 1) throw new Error(`打「标题 1」命中 ${n} 项（期望 1；菜单消失 = 空格把它关了）`)
    const label = (await item.locator('.yq-slash-name').textContent()).trim()
    if (label !== '标题 1') throw new Error(`选中的是「${label}」`)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(400)
    const cls = await page.evaluate(() => {
      const bs = document.querySelectorAll('[data-block-id]')
      return bs[bs.length - 1].className
    })
    if (!cls.includes('yq-block-h1')) throw new Error('块类型没有变成 h1：' + cls)
    const left = await page.$$eval('.yq-block-text', (els) =>
      els.map((e) => e.innerText).filter((t) => t.includes('/')))
    if (left.length) throw new Error('"/" 残留在正文里：' + JSON.stringify(left))
  })

  /* ⚠️ 2026-10-07 补的第二条回归：**插完分割线就写不下去了**。
   分割线没有 contentEditable 区域（`!isDivider` 把 `.yq-block-text` 整个排除），
   唯一交互是「点击删除」，所以 onPick 里那句 `focusBlock(slash.id)` 必然落空 ——
   焦点丢到 BODY，用户被卡在死路上，界面零提示（实测：块数不增加、
   `activeElement` 是 BODY、打字没反应）。
   语雀 / Notion 的做法是转成分割线后**在下面补一个空段落并聚焦**，这里照做。

   ⚠️ 修的时候踩过一次坑值得记：先 `onChange(转换)` 再调 `insertAfter`，
     而 `insertAfter` 闭包里的 `blocks` 是**转换前**那一份 ——
     于是「分割线」被覆盖没了，界面上只剩一个空段落，没有任何报错。
     所以必须**一次算完最终数组**（见 Editor.tsx 里那段注释）。 */
await check('斜杠菜单：分割线下面能接着写（不是死路）', async () => {
    const el = page.locator('.yq-block-text').last()
    await el.scrollIntoViewIfNeeded()
    await el.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.locator('.yq-block-text').last().scrollIntoViewIfNeeded()
    await page.keyboard.type('/', { delay: 20 })
    await page.waitForSelector('.yq-slash-cards', { timeout: SLASH_TIMEOUT })
    await page.keyboard.type('分割线', { delay: 20 })
    await page.waitForTimeout(320)
    if ((await page.locator('.yq-slash-item').count()) !== 1) throw new Error('菜单没命中「分割线」')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(500)
    const st = await page.evaluate(() => {
      const bs = [...document.querySelectorAll('[data-block-id]')]
      const a = document.activeElement
      return {
        types: bs.map((b) => [...b.classList].find((c) => c.startsWith('yq-block-') && c !== 'yq-block-text') || '?'),
        focusInBlock: !!(a && a.closest && a.closest('[data-block-id]')),
      }
    })
    if (!st.types.includes('yq-block-divider')) throw new Error('分割线没插上：' + JSON.stringify(st.types))
    if (!st.focusInBlock) throw new Error('分割线下面没有可聚焦的块 —— 插完就写不下去了')
    await page.keyboard.type('分割线下面这行', { delay: 20 })
    await page.waitForTimeout(350)
    const lastText = await page.evaluate(() =>
      [...document.querySelectorAll('.yq-block-text')].map((e) => e.innerText).filter(Boolean).pop())
    if (lastText !== '分割线下面这行') throw new Error('字没打进去：' + JSON.stringify(lastText))
  })

  /* ⚠️ 2026-10-07 补的第三条回归：**插完表格，触发词 `/表格` 赖在前一段落里**。
   `DocPage.handleInsertCard` 用的是闭包里的 `doc.blocks`，而 Editor 的 onPick 是
   `flushSync(清空)` 之后**同一 tick 内**调它 —— 于是 `[...doc.blocks, nb]`
   把清空结果整个盖回去。界面零报错，只是那两个字赖着不走，紧接着打的字
   全接在它后面（实测 store：`{"t":"p","txt":"/表格改一下"}`）。
   这是本会话第三次为「两次写同一处、后者拿着旧快照」栽跟头。

   顺带钉住表格**如实标出「不能编辑」**：它是 contentEditable={false} 的静态渲染，
   官方语雀的表格是可交互的 —— 这是本项目还没做的部分，所以界面上写明差在哪，
   而不是摆一个看不出所以然的禁用态。 */
await check('斜杠菜单：表格 —— 不残留触发词，且单元格可编辑、能增删行', async () => {
    const el = page.locator('.yq-block-text').last()
    await el.scrollIntoViewIfNeeded()
    await el.click()
    await page.keyboard.press('End')
    await page.keyboard.press('Enter')
    await page.locator('.yq-block-text').last().scrollIntoViewIfNeeded()
    await page.keyboard.type('/', { delay: 20 })
    await page.waitForSelector('.yq-slash-cards', { timeout: SLASH_TIMEOUT })
    await page.keyboard.type('表格', { delay: 20 })
    await page.waitForTimeout(320)
    if ((await page.locator('.yq-slash-item').count()) !== 1) throw new Error('菜单没命中「表格」')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.yq-table-block', { timeout: 8000 })
    const left = await page.$$eval('.yq-block-text', (els) =>
      els.map((e) => e.innerText).filter((t) => t.includes('/')))
    if (left.length) throw new Error('触发词 "/表格" 残留在正文里：' + JSON.stringify(left))
    /* ⚠️ 2026-10-07：表格从只读改成**可编辑**（官方语雀的表格本来就是可交互的，
       这里原本是 contentEditable={false} 的静态渲染、onChange 一次都没调用）。
       所以断言也跟着反过来 —— 不只是「提示没了」，还要**真的能改、能增删行**，
       并且内容真的回写到 block.text（markdown 是它在 store 里的唯一形态）。 */
    if (await page.locator('.yq-table-note').count()) {
      throw new Error('表格已经能编辑了，那条「暂不支持编辑」的提示必须一起删掉')
    }
    const cell = page.locator('table.yq-table-block td[contenteditable="true"]').first()
    if (!(await cell.count())) throw new Error('表格单元格不是 contentEditable —— 还是只读的')
    await cell.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.type('改过的格子')
    await page.keyboard.press('Tab') // 失焦触发提交
    await page.waitForTimeout(500)
    const stored = await page.evaluate(() => {
      const d = window.__yqStore.getState().docs[location.hash.split('/').pop()]
      const t = d?.blocks?.find((b) => b.type === 'table')?.text || ''
      return t
    })
    if (!stored.includes('改过的格子')) throw new Error('单元格改动没回写到 block.text：' + JSON.stringify(stored))
    const rowsBefore = await page.locator('table.yq-table-block tbody tr:not(.yq-table-ops)').count()
    await page.locator('button:has-text("+ 行")').click()
    await page.waitForTimeout(450)
    const rowsAfter = await page.locator('table.yq-table-block tbody tr:not(.yq-table-ops)').count()
    if (rowsAfter !== rowsBefore + 1) throw new Error(`「+ 行」没生效（${rowsBefore} → ${rowsAfter}）`)
    /* 增删按钮那一行**不进 markdown** —— 少一行「假的」表格数据 */
    const storedRows = (stored.match(/^\|/gm) || []).length
    if (storedRows !== 3) throw new Error(`增行后 markdown 里应仍是 3 行（含表头+分隔行），实际 ${storedRows}`, stored)
  })

  // 1~N. 逐张卡片
  for (const c of CARDS) {
    const sel = `[data-card-id="${c.id}"]`
    await check(`卡片 ${c.id}（${c.name}）— ${c.desc}`, async () => {
      await insert(c.name, c.id)
      await c.run(page, sel)
      if (!(await page.locator(c.dom(sel)).count())) throw new Error('DOM 结构没出现: ' + c.dom(sel))
      const d = await readData(c.id)
      if (!d) throw new Error('store 里找不到这个 card 块')
      if (!c.data(d)) throw new Error('数据没写回 block.data: ' + JSON.stringify(d).slice(0, 160))
      if (c.id === 'flowchart' || c.id === 'uml') {
        await page.screenshot({ path: `${OUT}/${c.id}.png` })
      }
    })
  }

  // N+1. 卡片数对得上
  await check('27 张卡片全部落进文档', async () => {
    const n = await page.evaluate(([docId]) => {
      const d = window.__yqStore.getState().docs[docId]
      return d.blocks.filter((b) => b.type === 'card').length
    }, [DOC])
    if (n !== CARDS.length) throw new Error(`只落了 ${n}/${CARDS.length} 张`)
  })

  // N+2. 刷新后全在
  await check('刷新后 27 张卡片全部恢复', async () => {
    await page.waitForTimeout(700) // 等 persist 防抖
    // 这里不能用 networkidle：第三方卡片（B站/网易云/高德）是 iframe，
    // 在受限网络里它们的请求会一直挂着，网络永远静不下来，
    // reload 必然 30s 超时 —— 表现为「卡片没了」，其实是根本没刷新完。
    // 本项目 README「测试」一节记的就是这个坑。
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-kc-host', { timeout: 8000 })
    for (const c of CARDS) {
      const sel = `[data-card-id="${c.id}"]`
      if ((await page.locator(sel).count()) !== 1) throw new Error(`${c.id} 刷新后不见了`)
      if (!(await page.locator(c.dom(sel)).count())) throw new Error(`${c.id} 刷新后结构没了`)
      const d = await readData(c.id)
      if (!d || !c.data(d)) throw new Error(`${c.id} 刷新后数据不对: ${JSON.stringify(d).slice(0, 120)}`)
    }
    await page.screenshot({ path: `${OUT}/after-reload.png`, fullPage: true })
  })

  // N+3. 卡片不会被富文本命令误删（syncFromDom 的坑）
  await check('按 Ctrl+B 不会把卡片洗掉', async () => {
    const before = await page.evaluate(([docId]) =>
      window.__yqStore.getState().docs[docId].blocks.filter((b) => b.type === 'card').length, [DOC])
    await page.locator('.yq-block-text').first().click()
    await page.keyboard.press('Control+b')
    await page.waitForTimeout(600)
    const after = await page.evaluate(([docId]) =>
      window.__yqStore.getState().docs[docId].blocks.filter((b) => b.type === 'card').length, [DOC])
    if (after !== before) throw new Error(`加粗把卡片洗掉了：${before} → ${after}`)
  })

  // N+4. 刷新一次后仍然是 27 张（确认上面那次误删没有落盘）
  await check('再次刷新仍是 27 张', async () => {
    // 同上：networkidle 会被第三方 iframe 的悬挂请求拖死
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.yq-kc-host', { timeout: 8000 })
    const n = await page.locator('.yq-kc-host').count()
    if (n !== CARDS.length) throw new Error(`刷新后卡片数不对: ${n}`)
  })

  await browser.close()
  server.close()

  const failed = steps.filter((s) => !s.ok)
  console.log('\n' + '='.repeat(52))
  console.log(`通过 ${steps.length - failed.length}/${steps.length}（同源错误算失败；异源错误不计入）`)
  if (failed.length) {
    console.log('\n失败项：')
    failed.forEach((f) => console.log(`  ✗ ${f.label}\n    ${f.errs.join('\n    ')}`))
  }

  /**
   * 如实交代两件容易被这个「通过 N/N」盖过去的事。
   * 一个只看第一行的读者会以为 27 张卡片全验过了，其实：
   */
  const down = Object.entries(net).filter(([, ok]) => !ok).map(([h]) => h)
  console.log(`\n第三方嵌入可达性（本机 → 外网）：${Object.keys(net).length - down.length}/${Object.keys(net).length} 个域可达`)
  if (down.length) {
    console.log(`  不可达：${down.join('、')}`)
    console.log('  → 上面这几张嵌入卡片（B站/网易云/高德/Figma/优酷）验的是')
    console.log('    **插入 + iframe 地址 + 数据回写 + 刷新后还在**，也就是结构；')
    console.log('    **远端服务真实可达**这一层在本机没有验过 —— 不是「验过了」，是没条件验。')
  }
  console.log(`\n外部服务产生的错误（已与本机错误分开，不计入上面那个通过率）：${noise.length} 条`)
  const byHost = {}
  for (const n of noise) {
    const h = (n.match(/^\[([^\]]+)\]/) || [, '(无来源 URL)'])[1]
    byHost[h] = (byHost[h] || 0) + 1
  }
  for (const [h, n] of Object.entries(byHost).sort((a, b) => b[1] - a[1]).slice(0, 8))
    console.log(`  ${h}: ${n} 条`)
  console.log(`\n截图目录: ${OUT}`)
  /* 汇总行逐字用约定的「结果：N 通过 / M 失败」。
     run-all-tests.mjs:401 就是按这条正则计数的 —— 写成别的语序，
     套件会被判成「本身异常」，它那 33 项一项都不计进总数。 */
  console.log(`结果：${steps.length - failed.length} 通过 / ${failed.length} 失败`)
  process.exit(failed.length ? 1 : 0)
})()
