/* ============================================================
   Markdown → 块
   ------------------------------------------------------------
   刻意做成**纯函数**，不碰 store / localStorage / DOM。

   为什么要抽出来：以前它住在 `src/store/index.ts` 里，只有浏览器用得上。
   但服务端要用它 —— 访问令牌通过 `/api/v2` 建文稿时传的是 Markdown，
   而正文渲染认的是 blocks。只存 body 不存 blocks 的后果不是「少一个字段」：
   **API 建出来的文档在网页端打开是一片空白**（body 有字，blocks 是空数组），
   而且列表里看不出来、搜索能搜到、点进去是空的 —— 这种错最难自查。

   所以两边必须走**同一个**转换器。在服务端复制一份是明确不可行的：
   两份实现迟早分叉，而分叉之后「网页端粘 Markdown」和「API 发 Markdown」
   会给出两种结构，排障时根本猜不到是哪一份跑偏了。

   ⚠️ 这个模块只允许依赖 `@/types` 的**类型**（编译期擦除）。
   一旦引了任何运行时依赖，服务端 import 它时就会连带拖进来。
   ============================================================ */

import type { Block } from '@/types'

/** 块 id。和服务端、store 用的是同一套前缀约定（bk_） */
export const uid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/**
 * markdown 表格行 → 表格块。
 *
 * 表格块的正文存在 **`text` 里（保留 markdown 源码）**，不是 `data`。
 * 早先这里把行塞进 `data.rows`，结果 `TableBlock` 读 `block.text` 拿不到，
 * 只能回退到占位表格「列 1 | 列 2 / 内容」——
 * **转换「成功」了但显示成一堆占位符**，比不转还糟。
 */
function parseTable(rows: string[]): Block {
  return {
    id: uid('bk'),
    type: 'table',
    // 去掉每行首尾的竖线与多余空白，保留成规范化的 markdown 表格
    text: rows
      .map((r) => '| ' + r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim()).join(' | ') + ' |')
      .join('\n'),
  }
}

/**
 * markdown → blocks。
 *
 * 除了模板预览和粘贴转换（语雀最有辨识度的交互之一：
 * 从别处复制一段 Markdown 源码粘进来，自动变成标题 / 列表 / 待办 / 代码 /
 * 表格 / 图片，而不是一坨带符号的纯文本），现在也是**访问令牌写文稿**的入口。
 *
 * 覆盖：围栏代码块 / 表格 / 图片 / h1-h3 / 引用 / 分割线 / 待办 / 无序 / 有序 / 段落。
 */
export const markdownToBlocks = (md: string): Block[] => {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const out: Block[] = []
  let i = 0

  /**
   * 这些语言标签的围栏**转成文本绘图卡片**，其余仍走代码块。
   * 只收精确标签：`plaintext` / `text` 里贴 mermaid 示例是「教人怎么写」，
   * 那种必须留在代码块。
   */
  const DIAGRAM_FENCE_LANGS = new Set([
    'mermaid', 'dot', 'graphviz', 'gv',
    'plantuml', 'uml', 'puml', 'pu',
  ])

  while (i < lines.length) {
    const raw = lines[i]
    const t = raw.trim()

    // 围栏代码块：整体吃掉中间的行，不能按空行切
    /* ⚠️ 语言标签要收 `# + . -`：`objective-c` / `c++` / `mermaid-flow`
       这类是合法标签。原来的 `(\w*)` 匹配不上 —— 于是整个围栏**不**被当代码块，
       落进段落分支，**代码连同内容一起变成一段普通文字**。
       症状非常安静：没有代码块、没有报错，只是那段代码「不见了」。 */
    const fence = /^```([\w+#.-]*)\s*$/.exec(t)
    if (fence) {
      const lang = (fence[1] || '').toLowerCase()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i].trim())) { body.push(lines[i]); i++ }
      i++ // 跳过收尾的 ```
      const src = body.join('\n')

      /**
       * 带**图形语言标签**的围栏 → 文本绘图卡片（而不是代码块）。
       *
       * 为什么：从 Confluence / Notion / GitHub 导出的 Markdown 里
       * **大量**是 ```` ```mermaid ```` 围栏，而它们现在是代码块 ——
       * 读者看到的是一段没法看的源码。转成卡片后**既能看图、也能改源码**
       * （卡片自带 SyncTextarea），严格优于代码块。
       *
       * ⚠️ 只认**精确的语言标签**：`plaintext` / `text` 里贴一段 mermaid
       *    示例是「教人怎么写」，那种必须留在代码块里。
       *
       * ⚠️ 块结构必须是 `{ type:'card', data:{ cardId:'plantuml', src } }`
       *    —— 不是 `{ type:'plantuml' }`。后者编辑器**不认**，图会静默空白
       *    （2026-10-07 真的踩过，见 test-exportcards 里钉住的那条守卫）。
       */
      if (DIAGRAM_FENCE_LANGS.has(lang)) {
        out.push({ id: uid('bk'), type: 'card', text: '', data: { cardId: 'plantuml', src } })
        continue
      }
      out.push({ id: uid('bk'), type: 'code', text: src, lang: lang || 'text' })
      continue
    }

    if (!t) { i++; continue }

    // 表格：连续的 | 行，且至少两行（表头 + 分隔行）
    if (/^\|.*\|\s*$/.test(t)) {
      const rows: string[] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i].trim()); i++ }
      out.push(parseTable(rows))
      continue
    }

    // 图片：**独占一行**，但同一行**后面**还能跟字（语雀就是这样 ——
    // 用户 2026-10-20 的截图：图片右边紧跟着文字）。
    // 所以这里认「图片 + 同行尾巴文字」：
    //   · alt 文字放进 `data.alt`（它是**替代文本**，不是正文）
    //   · 同行那段话进 `text` —— 它是**这个块的正文**（搜索/导出/撤销都靠它）
    const img = /^!\[([^\]]*)\]\(([^)\s]+)\)(.*)$/.exec(t)
    if (img) {
      out.push({
        id: uid('bk'),
        type: 'image',
        text: (img[3] || '').trim(),
        src: img[2],
        ...(img[1] ? { data: { alt: img[1] } } : {}),
      })
      i++
      continue
    }

    if (/^### /.test(t)) { out.push({ id: uid('bk'), type: 'h3', text: t.slice(4) }); i++; continue }
    if (/^## /.test(t)) { out.push({ id: uid('bk'), type: 'h2', text: t.slice(3) }); i++; continue }
    if (/^# /.test(t)) { out.push({ id: uid('bk'), type: 'h1', text: t.slice(2) }); i++; continue }
    if (/^>\s?/.test(t)) { out.push({ id: uid('bk'), type: 'quote', text: t.replace(/^>\s?/, '') }); i++; continue }
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(t)) { out.push({ id: uid('bk'), type: 'divider', text: '' }); i++; continue }
    if (/^- \[[xX]\] /.test(t)) { out.push({ id: uid('bk'), type: 'todo', text: t.slice(6), checked: true }); i++; continue }
    if (/^- \[[ ]\] /.test(t)) { out.push({ id: uid('bk'), type: 'todo', text: t.slice(6), checked: false }); i++; continue }
    if (/^[-*+] /.test(t)) { out.push({ id: uid('bk'), type: 'ul', text: t.slice(2) }); i++; continue }
    if (/^\d+[.)] /.test(t)) { out.push({ id: uid('bk'), type: 'ol', text: t.replace(/^\d+[.)] /, '') }); i++; continue }
    if (/^<br\s*\/?>$/i.test(t)) { i++; continue }

    out.push({ id: uid('bk'), type: 'p', text: t })
    i++
  }
  return out
}
