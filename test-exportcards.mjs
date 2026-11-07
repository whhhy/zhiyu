/* ============================================================
   导出时互动卡片去哪了
   ============================================================
   为什么要有这一节：实测发现的静默数据丢失。

   `doc.body` 是「块 → markdown」的产物，而卡片块（投票 / 看板 / 日历 / 加密…）
   在 `blocksToMarkdown` 里**没有分支**，落进 `default` —— 而 `default` 是
   `out.push(b.text)`，卡片的 `text` 恒为 `''`。
   于是导出里那个位置只剩**一个空行**，卡片内容一个字都没有。

   实测（一份含投票 / 看板 / 日历 / 加密四张卡的文档）：
     在  标题块 / 普通段落 / 表格块
     丢了 投票、看板、日历、加密四张卡片的**全部内容**
   而 `doc.body` 有三个消费方（见 store/index.ts 的注释）：
   导出、对外分享页（PublicDoc 渲染的就是 body）、发现页摘要。

   ------------------------------------------------------------
   为什么说明写在导出那一步，而不是写进 body
   ------------------------------------------------------------
   第一版就是把说明写进 `blocksToMarkdown` 的 —— 那是错的。
   写进 body 之后，分享页和发现页摘要里也会出现
   「（内容不随 Markdown 导出，请到站内查看）」，
   而那两处的语境根本不是 Markdown 导出。
   **三个消费方里有两个会被这句话带偏**，
   那正是本项目反复拒绝的「看起来像防护」的东西。

   所以：`blocksToMarkdown` 保持干净（卡片位置就是空的），
   `withCardNotices` 只在 DocPage 的四个导出入口上追加说明。

   ------------------------------------------------------------
   这一节钉住的
   ------------------------------------------------------------
   · body 里不许出现任何卡片相关的字样（否则分享页/摘要会被带偏）
   · 导出产物里必须有说明，且点名**真实卡片名**（取自卡片目录，不写死）
   · 没有卡片时一个字都不许加（否则它会到处插话）
   · 分隔线不能紧跟在正文后面：markdown 的 setext 标题会把正文最后一行吃成 H2
   · 正文内容一个字都不能少

   ⚠️ 本节**不声称**卡片内容被保真导出了 —— 恰恰相反，它就是没跟过来。
   这一点必须说清楚：本套件证明的是「不再静默」，不是「不再丢」。
   真要保真迁移走整包 JSON（/api/sync/push），不是 Markdown。
   =================================================================== */
import { blocksToMarkdown, withCardNotices } from './src/lib/blocks-markdown.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

const PLAIN = [
  { id: 'b1', type: 'h1', text: '季度复盘' },
  { id: 'b2', type: 'p', text: '正文一段。' },
]
const CARDS = [
  { id: 'b3', type: 'card', text: '', data: { cardId: 'vote', q: '哪个项目最好？', options: [{ id: 'o1', label: '知识库', votes: ['u1'] }] } },
  { id: 'b5', type: 'card', text: '', data: { cardId: 'kanban', title: '待办' } },
  { id: 'b6', type: 'card', text: '', data: { cardId: 'calendar' } },
  { id: 'b7', type: 'card', text: '', data: { cardId: 'encrypted', text: 'aGVsbG8=' } },
]
const BLOCKS = [...PLAIN, ...CARDS, { id: 'b9', type: 'p', text: '谢谢。' }]

console.log('== body（分享页 / 摘要 / 导出 共用的那一份）==')
const body = blocksToMarkdown(BLOCKS)
ok(!body.includes('互动卡片'), 'body 里没有「互动卡片」字样（分享页和摘要不会被带偏）', JSON.stringify(body.slice(0, 60)))
ok(!body.includes('不随 Markdown'), 'body 里没有导出提示')
ok(!body.includes('投票') && !body.includes('看板'), 'body 里也没有卡片的具体名字')

console.log('\n== 导出产物 ==')
const out = withCardNotices(body, BLOCKS)
ok(out.includes('互动卡片'), '导出产物里补上了说明')
ok(/4 张互动卡片/.test(out), '说明给出了条数')
ok(out.includes('投票') && out.includes('看板') && out.includes('日历') && out.includes('加密文本'),
  '说明点名了四张卡的真实名字（取自卡片目录）', out.slice(-200))
ok(out.includes('Markdown / Word / HTML / 纯文本'), '说清了哪些格式带不走（格式清单属于导出这一档，共享页不该说 Markdown）', out.slice(-220))
ok(out.includes('改用整包导出（JSON）'), '指出了真正保真的那条路')
ok(out.includes('季度复盘') && out.includes('正文一段。') && out.includes('谢谢。'),
  '正文内容一个字都没少')

console.log('\n== 边界 ==')
ok(!/谢谢。\n---/.test(out), '分隔线没紧跟在正文后面（否则正文最后一行会被 markdown 的 setext 吃成 H2）',
  JSON.stringify(out.slice(out.indexOf('谢谢'), out.indexOf('谢谢') + 12)))
ok(/谢谢。\n\n---/.test(out), '分隔线前空了一行')
ok(withCardNotices('只有正文', PLAIN) === '只有正文', '没有卡片时原样返回（一个字都不加）')
ok(withCardNotices('', CARDS).includes('互动卡片'), 'body 为空但有卡片时也能补上')
ok(withCardNotices('x', undefined) === 'x', 'blocks 缺失时不炸')
ok(withCardNotices('x', []) === 'x', 'blocks 为空数组时不加')
ok(withCardNotices('x', [{ id: 'z', type: 'p', text: 'p' }]) === 'x', '没有 card 块时不加')

console.log('\n== 分享页：同一个函数，但「下一步」那句话必须换 ==')
{
  /**
   * 分享页（PublicDoc）也走 `withCardNotices` —— 一句话只写一处。
   * 但最后一句不一样：访客没有账号，「到站内查看」对他毫无意义。
   *
   * 顺带记一笔：`blocks-markdown.ts` 的注释一直写着「分享页有写」，
   * 指的是**写在代码注释和 README 里**，页面上其实一句都没有。
   * 对外发链接的人看不到那段注释 —— 他只看到一片空缺。
   */
  const SHARE_HINT = '这一页按纯文本显示，交互部分需要向分享者索取站内链接。'
  const share = withCardNotices(blocksToMarkdown(BLOCKS), BLOCKS, SHARE_HINT)
  ok(share.includes('互动卡片'), '分享页也有说明')
  ok(share.includes(SHARE_HINT), '分享页用了它自己的「下一步」')
  ok(!share.includes('改用整包导出（JSON）'), '分享页不会出现「到站内查看 / 整包导出」那句（访客没账号）')
  ok(share.includes('不随纯文本一起走'), '正文那句是共用措辞，不重复写')
  const dflt = withCardNotices(blocksToMarkdown(BLOCKS), BLOCKS)
  ok(dflt.includes('改用整包导出（JSON）'), '导出那份仍然保留原来的「下一步」（没被这次改动带跑）')
  // 分享页也必须走「没有卡片就不加」
  ok(withCardNotices('只有正文', PLAIN, SHARE_HINT) === '只有正文', '分享页：没有卡片时同样一个字不加')
}

console.log('\n== 重复卡片按类型合并计数 ==')
{
  const dup = [...PLAIN, { id: 'c1', type: 'card', text: '', data: { cardId: 'vote' } }, { id: 'c2', type: 'card', text: '', data: { cardId: 'vote' } }]
  const o = withCardNotices(blocksToMarkdown(dup), dup)
  ok(/2 张互动卡片（投票 ×2）/.test(o), '两张同类卡片合并成「投票 ×2」', o.slice(-160))
}
console.log('\n== cardId 认不出来时要说人话 ==')
{
  const weird = [{ id: 'w1', type: 'card', text: '', data: {} }]
  const o = withCardNotices(blocksToMarkdown(weird), weird)
  ok(!/undefined|\[object/.test(o), '认不出的 cardId 不会印出 undefined', o.slice(-160))
}

console.log('\n== 「什么算一张卡片」这个判据只能有一处 ==')
{
  /* 2026-10-07 实测踩到的一个**静默**缺陷：
   *
   *   给部署实例加演示文档时，我把卡片块写成
   *     `{ type: 'plantuml', data: { src } }`
   *   而编辑器只认 `{ type: 'card', data: { cardId: 'plantuml', src } }`
   *   （DocPage.handleInsertCard 造的形状 / Editor 的 `block.type === 'card'`）。
   *
   *   症状特别安静：**API 取文档一切正常**（块数对、内容对），
   *   **单元测试全绿**（lib 的纯函数没问题），可界面上那五张图
   *   **一片空白** —— 数据层根本看不出来块类型是错的。
   *
   *   根因是同一个判据散在**两处**：Editor 认不渲染、导出认不提示。
   *   这里钉住「它们必须认同一个」，而不是各认各的。
   */
  const fs = await import('node:fs')
  const editor = fs.readFileSync('src/components/doc/Editor.tsx', 'utf8')
  const notices = fs.readFileSync('src/lib/blocks-markdown.ts', 'utf8')

  ok(/block\.type\s*===\s*['"]card['"]/.test(editor),
    '编辑器仍按 `block.type === "card"` 认卡片（改了就与这里对不上）')
  ok(/\(\s*blocks\s*\|\|\s*\[\]\s*\)\s*\.filter\(\s*\(b\)\s*=>\s*b\.type\s*===\s*['"]card['"]/.test(notices),
    '导出补说明用的也是 `b.type === "card"`（与编辑器同一判据）')

  // 顺带钉住「文本绘图这类卡片只能走 card 块」——cards.ts 里它是 kind:'card'，
  // 意味着块类型是 'card'、卡片类型写在 data.cardId 上，不是 type: 'plantuml'
  const cards = fs.readFileSync('src/data/cards.ts', 'utf8')
  const plantuml = /\{ id: 'plantuml'.*?kind: 'card'/.test(cards)
  ok(plantuml, "cards.ts 里 plantuml 是 kind:'card'（所以块 type 是 card，类型在 data.cardId）")
  ok(!/type:\s*['"]plantuml['"]/.test(editor) && !/blockType:\s*['"]plantuml['"]/.test(cards),
    'plantuml 没有自己的块类型（不是 type:"plantuml" 那种独立块）')

  // 实操层面：按正确形状造一个，确认导出真的给出说明
  const good = [{ id: 'p1', type: 'card', text: '', data: { cardId: 'plantuml', src: 'graph TD\nA-->B' } }]
  const withNote = withCardNotices(blocksToMarkdown(good), good)
  ok(withNote.includes('互动卡片') || withNote.includes('文本绘图'),
    '按正确形状造的卡片块，导出里会出现说明', withNote.slice(-140))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1