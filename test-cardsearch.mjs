/* ============================================================
   可搜文本：服务端索引 与 前端本地搜索 **必须同一口径**
   ------------------------------------------------------------
   2026-10-06 实测到的分叉：服务端 reindex 抽了卡片 data，
   而 `useSearch` 的本地形态只抽 `b.text` —— 于是同一个人、
   同一份数据，连上服务端能搜到「投票的问题」，
   不连服务端（纯前端形态）就搜不到。
   同一份数据、两种形态、两种答案，而**没有任何地方会提示这件事**。

   本套件钉住「两边一致」，并且守住深走的三道边界。
   纯函数，不起服务、不开浏览器。
   ============================================================ */
import { cardSearchText, blocksSearchText, docSearchText } from './src/lib/card-search.ts'
import { matchCards, YUQUE_CARDS } from './src/data/cards.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => { if (c) { pass++; console.log(`  PASS  ${label}`) } else { fail++; console.log(`  FAIL  ${label} ${extra}`) } }

const DOC = {
  title: '季度复盘',
  body: '# 季度复盘\n\n正文一段。\n\n\n\n\n\n\n\n谢谢。',   // 卡片位置是空的（导出成 markdown 就是这样）
  blocks: [
    { id: 'b1', type: 'p', text: '正文一段。' },
    { id: 'c1', type: 'card', text: '', data: { cardId: 'vote', q: '投票问题甲', options: [{ id: 'o1', text: '选项乙', votes: ['u1'] }] } },
    { id: 'c2', type: 'card', text: '', data: { cardId: 'kanban', lists: [{ id: 'l1', name: '进行中', cards: [{ id: 'k1', text: '看板条目丙' }] }] } },
    { id: 'b2', type: 'p', text: '谢谢。' },
  ],
}

console.log('== 前端本地搜索能拿到卡片内容 ==')
{
  const t = docSearchText(DOC)
  ok(t.includes('投票问题甲'), '投票的问题进得了索引', t.slice(0, 80))
  ok(t.includes('选项乙'), '投票的选项进得了索引')
  ok(t.includes('看板条目丙'), '看板的条目进得了索引')
  ok(t.includes('正文一段。') && t.includes('谢谢。'), '块 text 照样在')
}

console.log('\n== ⭐ 关键：服务端与前端是同一口径 ==')
{
  /* 服务端 reindex 的口径：body + 块 text + 卡片深走。
     这里用同一个函数复算一遍 —— 如果两边将来又分叉，这条会红。 */
  const serverText = [DOC.body, blocksSearchText(DOC.blocks)].filter(Boolean).join(' ')
  const clientText = docSearchText(DOC)
  const norm = (s) => s.replace(/\s+/g, ' ').trim()
  for (const w of ['投票问题甲', '选项乙', '看板条目丙']) {
    ok(norm(serverText).includes(w) === norm(clientText).includes(w),
      `「${w}」在服务端与前端同时可搜`, `server=${norm(serverText).includes(w)} client=${norm(clientText).includes(w)}`)
  }
}

console.log('\n== 没有 blocks 时退回 body（导入包 / 老数据）==')
ok(docSearchText({ body: '只有 body' }) === '只有 body', '只有 body 也能搜')
ok(docSearchText({}) === '', '什么都没有时返回空串，不抛')
ok(docSearchText({ blocks: '不是数组', body: 'B' }) === 'B', 'blocks 不是数组时退回 body')

console.log('\n== 深走的三道边界 ==')
{
  const BLOB = 'blobmark'
  const LONG = 'longmark'
  const DEEP = 'deepmark'
  const VOTEID = 'votemark'
  const KEEP = 'keepmark'
  const deep = (n, leaf) => (n === 0 ? leaf : { child: deep(n - 1, leaf) })
  const t = blocksSearchText([
    { type: 'card', text: '', data: { cardId: 'album', name: KEEP, dataUrl: 'data:image/png;base64,' + BLOB + 'AAAA' } },
    { type: 'card', text: '', data: { cardId: 'file', longText: LONG + 'x'.repeat(260) } },
    { type: 'card', text: '', data: { cardId: 'mindmap', tree: deep(9, DEEP) } },
    { type: 'card', text: '', data: { cardId: 'vote', q: '问题', options: [{ id: 'o', text: '选项', votes: [VOTEID] }] } },
  ])
  ok(t.includes(KEEP), '正常内容照常进索引（不是跳过过头）')
  ok(!t.includes(BLOB), 'dataUrl 里的 base64 不进')
  ok(!t.includes(LONG), '超过 200 字符的长串不进')
  ok(!t.includes(DEEP), '埋得太深（第 9 层）不进')
  ok(!t.includes(VOTEID), 'votes 里的用户 id 列表不进')
  ok(t.includes('问题') && t.includes('选项'), '同一张卡的正常字段都进了')
}

console.log('\n== 图片 / 分割线的空壳不进 ==')
{
  const t = blocksSearchText([
    { type: 'p', text: '真内容' },
    { type: 'image', text: '', data: { name: '图片说明不该进' } },
    { type: 'divider', text: '' },
  ])
  ok(t.includes('真内容'), '正文在')
  ok(!t.includes('图片说明不该进'), '图片 data 里的说明不进索引（否则只会稀释结果）')
}

console.log('\n== 坏的输入不炸 ==')
{
  ok(blocksSearchText(undefined) === '', 'blocks 是 undefined')
  ok(blocksSearchText([null, 'x', 42]) === '', '数组里混着非对象')
  const got = []
  cardSearchText(null, (s) => got.push(s))
  ok(got.length === 0, 'data 是 null 时 emit 一次都不调')
}

console.log('\n== 斜杠菜单的搜索：照着看到的名字打要能搜到 ==')
{
  /* ⚠️ 2026-10-07 在部署端补的回归。
     现象：菜单上写着「标题 1」，用户照着打，**命中 0 项**。
     根因：`matchCards` 用 `c.name.includes(q.trim())` 比**原始**名字，
     而名字里的那个空格在 contentEditable 里常常根本落不进去 ——
     实测打出来的是 `标题1`，于是 `'标题 1'.includes('标题1')` 为假。
     「照着看到的打」是最自然的用法，也是唯一该保证的用法。
     定位方式：在部署实例上把各种输入的命中数逐个量出来（一次只测一件事），
     而不是靠一个把「搜索 / 转换 / 残留」混在一起的综合探针猜。 */
  const hit = (q) => matchCards(q).map((c) => c.id)

  ok(hit('标题 1').includes('h1'), '带空格「标题 1」能搜到', JSON.stringify(hit('标题 1')))
  ok(hit('标题1').includes('h1'), '不带空格「标题1」也能搜到', JSON.stringify(hit('标题1')))
  ok(hit('  标题  1  ').includes('h1'), '多个空格 / 首尾空格不影响结果', JSON.stringify(hit('  标题  1  ')))
  ok(hit('标题').length === 4, '前缀「标题」仍命中 4 个', String(hit('标题').length))
  ok(hit('bt1').includes('h1'), '拼音首字母仍能搜到', JSON.stringify(hit('bt1')))

  /* 原来同一个函数里两套大小写口径：name 用原始 q、en 用小写 kw */
  ok(hit('FIGMA').includes('figma'), '英文名大小写不敏感', JSON.stringify(hit('FIGMA')))

  /* 回归护栏：带空格的卡片名不止标题这一条路，走一遍全部格式项 */
  const spaced = YUQUE_CARDS.filter((c) => /\s/.test(c.name)).map((c) => c.name)
  ok(spaced.length > 0, `卡片目录里确实有带空格的条目（${spaced.length} 个）`, spaced.join('/'))
  const allFound = spaced.every((n) => matchCards(n).some((c) => c.name === n))
  ok(allFound, '每一个带空格的卡片名都能按原样搜到它自己', JSON.stringify(spaced))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) process.exitCode = 1