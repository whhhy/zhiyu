/* ============================================================
   Markdown 文件夹导入
   ------------------------------------------------------------
   公司里真正的第一批知识往往不在这个系统里 —— 在 Word、Confluence、
   某个工程师的本地 Markdown 目录里。没有进得来的口子，
   前面做的权限 / 版本 / 回收站全都用不上，因为里面是空的。

   做法刻意走**已有的 store action**（createBook / createNode / createDoc），
   而不新开一个导入接口。这样导入的内容天然享有同一套能力：
   服务端同步、权限、历史版本、回收站、跨设备可见 —— 一样都不用额外做。
   ============================================================ */

import type { Block } from '@/types'
// markdownToBlocks / looksLikeMarkdown 从 store 取。
// store 不会 import 本模块，所以不成环 —— 这一点要保持住：
// 一旦 store 反过来依赖这里，模块初始化顺序就会开始打架。
import { markdownToBlocks } from '@/store'

/** 一个待导入的文件 */
export interface ImportFile {
  /** 文件名（含扩展名） */
  name: string
  /** 浏览器用 webkitdirectory 时的相对路径，形如 `手册/接入/SSO.md` */
  webkitRelativePath?: string
  text: string
}

export interface ImportPlanNode {
  title: string
  /** 目录节点（分组） */
  children: ImportPlanNode[]
  /** 叶子：正文块 */
  blocks?: Block[]
  /** 源文件路径，出问题时告诉用户是哪一篇 */
  source: string
}

export interface ImportPlan {
  title: string
  tree: ImportPlanNode[]
  fileCount: number
  skipped: { name: string; reason: string }[]
}

/** Markdown 文件名 → 标题：`03-SSO 接入.md` → `SSO 接入` */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.(md|markdown|mdown|txt)$/i, '').replace(/\\/g, '/').split('/').pop() || name
  // 去掉开头的前导序号（`01-` / `1.` / `一、`），那是目录里的排序习惯
  const cleaned = base.replace(/^\s*(\d{1,3}\s*[-.、)]\s*|\d{1,3}\s+)/, '').trim()
  return cleaned || base
}

/** 文件扩展名是不是我们收的 */
function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdown|txt)$/i.test(name)
}

/**
 * 把一批文件整理成一棵目录树。
 *
 * 同名目录会合并（`a/x.md` 和 `b/a/y.md` 里的 `a` 应该是同一个分组），
 * 而不是各建一个 —— 否则同一份文档树的两个子目录会裂成两个同名分组。
 */
export function planImport(files: ImportFile[], bookTitle: string): ImportPlan {
  const skipped: ImportPlan['skipped'] = []
  const roots: ImportPlanNode[] = []
  const dirIndex = new Map<string, ImportPlanNode>()

  const ensureDir = (pathParts: string[]): ImportPlanNode => {
    if (!pathParts.length) {
      let root: ImportPlanNode | undefined
      if (roots.length === 1 && !roots[0].blocks) root = roots[0]
      else {
        root = { title: '', children: [], source: '' }
        roots.push(root)
      }
      return root
    }
    const key = pathParts.join('/')
    const hit = dirIndex.get(key)
    if (hit) return hit
    const parent = ensureDir(pathParts.slice(0, -1))
    const node: ImportPlanNode = { title: pathParts[pathParts.length - 1], children: [], source: key }
    parent.children.push(node)
    dirIndex.set(key, node)
    return node
  }

  let count = 0
  for (const f of files) {
    if (!isMarkdown(f.name)) { skipped.push({ name: f.name, reason: '不是 Markdown 文件' }); continue }
    if (!f.text.trim()) { skipped.push({ name: f.name, reason: '文件是空的' }); continue }

    // 相对路径去掉文件名，剩下的就是目录层级
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/')
    const parts = rel.split('/').filter(Boolean)
    parts.pop() // 去掉文件名
    // 顶层就是那个目录时不必再套一层
    if (parts.length && parts[0] === bookTitle) parts.shift()

    const dir = ensureDir(parts)
    dir.children.push({
      title: titleFromFileName(f.name),
      children: [],
      blocks: markdownToBlocks(f.text),
      source: rel,
    })
    count++
  }

  return { title: bookTitle, tree: roots, fileCount: count, skipped }
}

/** 树里一共多少篇文档 */
export function countDocs(nodes: ImportPlanNode[]): number {
  return nodes.reduce((n, x) => n + (x.blocks ? 1 : 0) + countDocs(x.children), 0)
}

/** 树里最深有几层（给「导入预览」用） */
export function treeDepth(nodes: ImportPlanNode[]): number {
  if (!nodes.length) return 0
  return 1 + Math.max(...nodes.map((n) => treeDepth(n.children)))
}

/** 渲染成纯文本预览，确认转换没跑偏 */
export function previewBlocks(blocks: Block[] | undefined, max = 4): string {
  if (!blocks?.length) return '（空）'
  return blocks.slice(0, max).map((b) => {
    const t = b.text || ''
    const label: Record<string, string> = {
      h1: '标题', h2: 'H2', h3: 'H3', p: '正文', ul: '列表', ol: '有序',
      todo: '待办', quote: '引用', code: '代码', table: '表格', image: '图片', divider: '分割线',
    }
    const name = label[b.type] || b.type
    return t ? `【${name}】${t.slice(0, 40)}` : `【${name}】`
  }).join('\n')
}
