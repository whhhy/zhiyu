/* ============================================================
   整库导出 —— 语雀「更多设置 → 导出知识库」

   语雀的导出是**整库打包成一个文件**。本项目原先只有单篇导出
   （文档页的 Markdown / Word / HTML / 纯文本），所以那一张卡片
   之前只能写清边界 + 跳到文档页 —— 1:1 少一块。

   现在补上。形态选 **zip**：
     · 目录层级 → 文件夹结构（语雀的目录是树，打包出来要还是树）
     · 一篇文档 → 一个 .md（正文用现成的 `blocksToMarkdown`）
     · 附一份 `_目录.md`，把整棵树写成带缩进的清单，
       这样**没有解析目录的编辑器**也能看懂结构
     · 附一份 `manifest.json`，给将来做导入留接口

   ⚠️ 不引第三方依赖：`zip()` 是项目自己写的（src/lib/docx.ts 里那套，
     docx 本身就是「zip + 几个 XML」）。同一个实现，不重复造。

   ⚠️ 权限：只导出**当前用户能读到**的文档 —— 不是「能导出就全给」。
     否则一个只读成员点一下就把全库拿走了，那不是导出，那是泄露。
     项目里已有导出限制设置（`restrictExport`），这里至少要做前者。

   ⚠️ 隐藏节点（`hidden`）：默认**不导出**。语雀里隐藏的是草稿，
     而草稿不该因为「导出一把」就被带出去。要的话在 UI 上明说。
   ============================================================ */

import { zip } from '@/lib/docx'
import { blocksToMarkdown } from '@/lib/blocks-markdown'
import type { Book, Doc, TreeNode } from '@/types'
import { safeFileName } from '@/lib/filename'

/**
 * 文件名净化。
 *
 * ⚠️ 现在**只有 `src/lib/filename.ts` 那一份**。这里以前自己写了一份，
 * 而 `src/lib/io.ts`（单篇导出走那条）写的是另一个版本 ——
 * 那份把**所有非 ASCII** 换成 `_`，于是中文标题导出成
 * `untitled-<日期>.docx`。同一天导出的多篇还会撞名。
 * 详见 `filename.ts` 头部那段。
 *
 * 原来这里对控制字符的处理是本项目**唯一**把转义写在 `new RegExp` 里的地方
 * —— 正则字面量里躺着的会是裸控制字节，`test-lint` 会立刻报红。
 * 现在转义跟着实现一起搬到 `filename.ts` 了（那里同样用 `new RegExp`）。
 */
function safeName(raw: string, fallback: string): string {
  return safeFileName(raw, fallback)
}

/** 同级同名时不能覆盖：加序号 */
function uniqueName(taken: Set<string>, name: string): string {
  if (!taken.has(name)) { taken.add(name); return name }
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let i = 2
  while (taken.has(`${base} (${i})${ext}`)) i++
  const out = `${base} (${i})${ext}`
  taken.add(out)
  return out
}

const enc = new TextEncoder()

export interface ExportBookResult {
  zipBytes: Uint8Array
  fileName: string
  docCount: number
  skipped: number
}

/**
 * 打包一个知识库。
 *
 * @param book    知识库
 * @param nodes   该库的目录树
 * @param docs    docId → 文档
 * @param canRead 判可见性：返回 false 的文档**不进包**
 */
export function exportBookZip(
  book: Book,
  nodes: TreeNode[],
  docsInput: Record<string, Doc> | Doc[],
  canRead: (d: Doc) => boolean,
): ExportBookResult {
  /*
   * ⚠️ `docs` 可能是**数组**而不是 `{id: Doc}`。
   *
   * 客户端 store 里是 `Record<string, Doc>`（`docs[id]`），
   * 而服务端 `bootstrap` 返回的 `docs` 是**数组**（key 是 0/1/2…）。
   * 传错的话 `docs[node.docId]` 全查不到 → 导出「成功」但**一篇都没有**
   * （实测踩过：13 个节点 26 篇文档，导出 0 篇，而所有安全断言全绿）。
   *
   * 这里统一成查表，两种形态都能用 —— 代价可以忽略，正确性不能。
   */
  const docs: Record<string, Doc> = Array.isArray(docsInput)
    ? Object.fromEntries((docsInput as Doc[]).map((d) => [d.id, d]))
    : docsInput
  const mine = nodes.filter((n) => n.bookId === book.id)
  const byId = new Map(mine.map((n) => [n.id, n]))
  const roots = mine
    .filter((n) => n.parentId === null || !byId.has(n.parentId))
    .sort((a, b) => a.order - b.order)

  const entries: { name: string; data: Uint8Array }[] = []
  const dirNames = new Map<string, string>()   // nodeId → 路径前缀
  const usedNames = new Map<string, Set<string>>() // 目录 → 已用文件名
  let docCount = 0
  let skipped = 0

  /**
   * 递归遍历，把「分组」变成文件夹、「文档」变成 .md。
   *
   * ⚠️ 用显式栈而不是递归：语雀目录可以很深，而深递归遇上
   *    循环引用（parentId 互指）会直接爆栈。已访问集合兜住循环。
   */
  const walk = (node: TreeNode, prefix: string, visited: Set<string>) => {
    if (visited.has(node.id)) return   // 目录成环时兜底
    visited.add(node.id)

    const isGroup = node.type === 'group' || !node.docId
    if (isGroup) {
      const dirName = uniqueName(usedNames.get(prefix) || new Set(), safeName(node.title, '未命名分组'))
      if (!usedNames.has(prefix)) usedNames.set(prefix, new Set())
      usedNames.get(prefix)!.add(dirName)
      const next = prefix ? `${prefix}/${dirName}` : dirName
      dirNames.set(node.id, next)
      for (const c of mine.filter((x) => x.parentId === node.id).sort((a, b) => a.order - b.order)) {
        walk(c, next, visited)
      }
      return
    }

    const d = docs[node.docId!]
    if (!d) { skipped++; return }
    // ⚠️ 没权限 / 被隐藏的文档**不进包**，但要计数（不能静默少几篇）
    if (!canRead(d) || node.hidden) { skipped++; return }

    const set = usedNames.get(prefix) || new Set()
    if (!usedNames.has(prefix)) usedNames.set(prefix, set)
    const fname = uniqueName(set, `${safeName(d.title, '未命名文档')}.md`)
    const path = prefix ? `${prefix}/${fname}` : fname

    /*
     * 正文从 blocks 生成，而不是直接用 `d.body`。
     *
     * `body` 是冗余缓存，而**它是可能没同步的**：轻量启动下正文还在路上时，
     * `blocks` 已到但 `body` 仍旧是空串 —— 实测过一篇 11 块的文档导出成 0 字节。
     * blocks 是唯一真相，body 只是派生值。
     */
    const md = (d.blocks?.length ? blocksToMarkdown(d.blocks) : d.body) || ''
    entries.push({ name: path, data: enc.encode(md) })
    docCount++
  }

  for (const r of roots) walk(r, '', new Set())

  /* ---- _目录.md：把整棵树写成缩进清单 ----
     为什么单独给一份：很多 markdown 编辑器 / 静态站生成器
     不读 zip 里的目录结构，这份文件让「导出来的是什么」一眼可见。 */
  const outline = [
    `# ${book.name}`,
    '',
    `> 共 ${docCount} 篇文档${skipped ? `，另有 ${skipped} 篇未导出（无权限或已隐藏）` : ''}。`,
    '',
    ...roots.map((r) => outlineLine(r, 0, mine)).filter(Boolean),
    '',
  ].join('\n')
  entries.unshift({ name: '_目录.md', data: enc.encode(outline) })

  /* ---- manifest.json：给将来的导入留接口 ----
     没有它的话，「导出来的包能不能原样导回去」这个问题的答案是「不知道」。 */
  entries.unshift({
    name: 'manifest.json',
    data: enc.encode(JSON.stringify({
      kind: 'yuque-clone-book-export',
      version: 1,
      book: { id: book.id, name: book.name, desc: book.desc || '' },
      exportedAt: new Date().toISOString(),
      docCount,
      skipped,
      files: entries.map((e) => e.name),
    }, null, 2)),
  })

  return {
    zipBytes: zip(entries),
    fileName: `${safeName(book.name, '知识库')}.zip`,
    docCount,
    skipped,
  }
}

/** 一行目录项（含缩进与图标），文档节点带路径 */
function outlineLine(node: TreeNode, depth: number, all: TreeNode[]): string {
  const pad = '  '.repeat(depth)
  const isGroup = node.type === 'group' || !node.docId
  if (isGroup) {
    const kids = all.filter((x) => x.parentId === node.id)
    const n = countDocs(node.id, all)
    const head = `${pad}- 📁 **${node.title}**${n ? `（${n} 篇）` : ''}`
    return [head, ...kids.sort((a, b) => a.order - b.order).map((k) => outlineLine(k, depth + 1, all))]
      .filter(Boolean).join('\n')
  }
  return `${pad}- ${node.title || '未命名文档'}`
}

function countDocs(nodeId: string, all: TreeNode[]): number {
  let n = 0
  const stack = [nodeId]
  const seen = new Set<string>()
  while (stack.length) {
    const id = stack.pop()!
    if (seen.has(id)) continue
    seen.add(id)
    for (const c of all.filter((x) => x.parentId === id)) {
      if (c.docId) n++
      else stack.push(c.id)
    }
  }
  return n
}

/** 触发浏览器下载 */
export function downloadBytes(bytes: Uint8Array, fileName: string, mime: string) {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}
