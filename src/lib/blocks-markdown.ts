/**
 * blocks → markdown
 *
 * ============================================================
 * 为什么从 data/seed.ts 搬出来
 * ------------------------------------------------------------
 * 它原来只是「造种子数据时顺手把 blocks 转成 markdown 存进 body」用的。
 * 但 `docs.body` 现在有**三个真实的用户可见消费方**（见下），而编辑路径
 * 从来不调它 —— 于是 body 对用户写的内容永远是空的或旧的。
 *
 * 搬到 lib 是因为它已经是 store 的依赖，不是种子的私事。
 *
 * ============================================================
 * 三个消费方，以及它们曾经各自的表现
 * ------------------------------------------------------------
 *   ① 单篇导出 Markdown / Word / HTML / 纯文本（DocPage 的「···」菜单）
 *      —— `downloadDoc(title, doc.body)` 四个格式全走 body
 *      实测：新建文档在编辑器里敲一段话，导出的 .md **长度 0**
 *   ② 对外分享页（PublicDoc.tsx）
 *      —— `renderMarkdown(state.doc.body)`
 *      实测：访客只看到一个标题，正文一个字都没有
 *   ③ 发现页卡片摘要（Discover.tsx）
 *      —— `d.body.replace(...)`，空 body 就是空摘要
 *
 * 而搜索**早就发现过这个问题**，只是用 `d.body || blocks.map(b => b.text)`
 * 绕过去了（见 useSearch.ts 的注释：「没打开过的文档 body 是空的」）。
 * 同一个根因，当时选了绕过而不是根治 —— 于是另外三处一直在流血。
 * ============================================================ */

import type { Block } from '@/types'
/**
 * ⚠️ 这里必须用**相对路径**，不能用 `@/data/cards`。
 * `@/` 是 Vite 的别名，Node 直接读这个模块时解析不了（ERR_MODULE_NOT_FOUND）。
 * 这个文件原本只有 `import type`，那是**类型导入**、编译时被抹掉的，所以一直没暴露。
 * 加了这条运行时 import 之后，它就成了本项目里**第一个**能被 Node 直接 import 的
 * 运行时依赖 —— 那正是 `test-lakebook` / `test-converge3` / `test-crdt-core`
 * 能直接调这些纯函数的原因，别把它弄坏。
 *
 * 扩展名要写全（`.ts`）：Node 的 ESM 解析相对导入时**不补扩展名**，
 * 写 `'../data/cards'` 会报 ERR_MODULE_NOT_FOUND。
 * `test-lakebook` 里 `import … from './src/lib/lakebook.ts'` 就是这个写法。
 */
import { YUQUE_CARDS } from '../data/cards.ts'

/**
 * blocks → markdown。
 *
 * 卡片类块（投票 / 画板 / 工作表 / 表格卡片）**进不了 markdown**：
 * 它们是交互组件，本来就没有对应的 markdown 语法。
 * 但「进不了」不等于「可以一声不吭地消失」——
 * 2026-10-06 实测过（见下面 `case 'card'` 的注释）：四张卡片的全部内容
 * 在导出里只剩空行，而 `doc.body` 是导出 / 分享 / 发现页摘要**共用**的那一份。
 *
 * 所以现在每张卡片在导出里留一行如实说明（分享页上本来就有说明，
 * 导出这边欠的那笔账就还在这里 —— 写在产物里比写在导出前的弹窗里更管用，
 * 因为弹窗关掉就没了、这一行会跟着文件走）。
 */

/** 卡片的中文名（导出提示里要用） */
function cardTitle(id: string): string {
  return YUQUE_CARDS.find((c) => c.id === id)?.name || id || '未指定类型'
}

/**
 * 导出用的正文 = `doc.body` + 一段「本文档有 N 张互动卡片、内容没跟过来」的说明。
 *
 * 放在导出这一步而不是写进 body，理由见 `case 'card'` 那段注释：
 * body 还有分享页和发现页摘要两个消费方，在那里说「不随 Markdown 导出」是错的。
 *
 * 说明写在**产物里**而不是导出前的弹窗里：弹窗关掉就没了，
 * 这一行会跟着文件走 —— 半年后有人翻到这份导出，仍然知道这里少了东西。
 *
 * ⚠️ 本函数**不把卡片内容渲染成 markdown**：27 个注册卡片 + 3 个独立文稿类型，
 * 每种 `data` 形状都不一样，凭猜渲染出来的导出比空行更糟 —— 它看着像内容，其实是错的。
 * 真要保真迁移，走的是整包 JSON（/api/sync/push 那条），不是 Markdown。
 */
export function withCardNotices(
  body: string,
  blocks: Block[],
  /** 最后一句「哪些格式带不走 + 下一步怎么办」。对外分享页的读者没有账号，
   *  那句「到站内查看 / 整包导出」对他毫无意义，所以那一处传自己的说法。 */
  hint = 'Markdown / Word / HTML / 纯文本这四种导出都带不走它。需要完整内容请到站内查看，或改用整包导出（JSON）。',
): string {
  const cards = (blocks || []).filter((b) => b.type === 'card')
  if (!cards.length) return body
  const names = cards.map((b) => cardTitle((b.data && typeof b.data.cardId === 'string') ? b.data.cardId : ''))
  const tally = new Map()
  for (const n of names) tally.set(n, (tally.get(n) || 0) + 1)
  const list = [...tally].map(([n, k]) => (k > 1 ? `${n} ×${k}` : n)).join('、')
  const note = [
    // ⚠️ 这里必须空**两**行。只空一行的话 `正文` + `---` 在支持 setext 的
    // 渲染器里会把正文最后一行吃成一个二级标题 —— 而这段是接在正文后面的。
    '',
    '',
    '---',
    '',
    `> ⚠️ 这份文档里有 ${cards.length} 张互动卡片（${list}）。`,
    '> 卡片是交互组件，内容不随纯文本一起走 —— 上面那些位置是空的。',
    `> ${hint}`,
  ].join('\n')
  return (body || '') + note
}
export function blocksToMarkdown(blocks: Block[]): string {
  const out: string[] = []
  for (const b of blocks) {
    switch (b.type) {
      case 'h1': out.push(`# ${b.text}`); break
      case 'h2': out.push(`## ${b.text}`); break
      case 'h3': out.push(`### ${b.text}`); break
      case 'h4': out.push(`#### ${b.text}`); break
      case 'quote': out.push(b.text.split('\n').map((l) => `> ${l}`).join('\n')); break
      case 'code': out.push('```' + (b.lang || '') + '\n' + b.text + '\n```'); break
      case 'divider': out.push('---'); break
      /**
       * 上传的图片 `src` 是**空的**（它改由 `data.key` 指路），
       * 所以这里产出的是 `![]()` —— 一个空地址的图片。
       *
       * 这不是 bug，是「markdown 里表达不了本机/服务端附件」的必然结果。
       * 但它有两个后果，必须写下来而不是留给下一个人踩：
       *   · 分享页上会出现一张**加载不出来的空图**（而不是干脆没有）
       *   · 导出的 .md 里有 `![]()`，在别的 markdown 渲染器里也是一张坏图
       * 所以空 src 时**不输出这一行** —— 少一张坏图好过一张坏图。
       * 代价是「这张图没了」这件事没有被表达出来，界面上要另外说明。
       */
      /**
       * 图片**右边**那段话跟在同一行（语雀的形态 —— 见用户 2026-10-20 的截图）。
       * ⚠️ 上传的图片 `src` 是**空的**（它改由 `data.key` 指路），
       *    那时导出不出图片 —— 但**那段话不能跟着丢**，所以单独输出一行。
       * ⚠️ 这里的写法（`case 'image': if (b.src)`）被 test-bodyfresh 按**源码形状**盯着，
       *    改结构时记得同步那条守卫（或把它改成行为断言）。
       */
      case 'image': if (b.src) out.push(`![](${b.src})${b.text || ''}`); else if (b.text) out.push(b.text); break
      case 'callout': out.push(`> ${b.emoji || '💡'} ${b.text}`); break
      case 'table': out.push(b.text); break
      case 'ul': out.push(`- ${b.text}`); break
      case 'ol': out.push(`1. ${b.text}`); break
      case 'todo': out.push(`- [${b.checked ? 'x' : ' '}] ${b.text}`); break
      /**
       * 卡片块落进 `default`，而 `default` 是 `out.push(b.text)`，
       * 卡片的 `text` 恒为 '' —— 于是导出里只剩一个**空行**。
       *
       * 实测（把一份含投票/看板/日历/加密四张卡的文档导出）：
       *   在  标题块 / 普通段落 / 表格块
       *   丢了 投票、看板、日历、加密四张卡片的**全部内容**
       *
       * 这里**故意仍然什么都不输出**，说明由 `withCardNotices` 在导出那一步单独补上。
       * 为什么不在这里补（第一版就是那么写的，跑出来是错的）：
       * `doc.body` 有三个消费方 —— 导出、**分享页（PublicDoc 渲染的就是 body）**、
       * 发现页摘要。说明写进 body 之后，分享页和摘要里也会出现
       * 「（内容不随 Markdown 导出，请到站内查看）」——
       * 而那两处的语境根本不是 Markdown 导出。
       * **在三个消费方里有两个它是错的**，这正是本项目反复拒绝的那种
       * 「看起来像防护」的东西。所以说明必须待在它说得出口的那一步。
       */
      default: out.push(b.text)
    }
  }
  return out.join('\n\n')
}
