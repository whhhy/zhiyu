/* ============================================================
   Confluence 空间导出（XML）解析
   ============================================================
   ⚠️⚠️ **没有真实样本验证。** ⚠️⚠️
   本文件的结构依据是两份公开文档：
     · Atlassian 官方《Export Content to Word, PDF, HTML and XML》
       —— 说明 XML 导出「包含每一页、博客、评论和附件」
     · XWiki 官方技术文档《Confluence XML Format》
       （https://extensions.xwiki.org/.../ConfluenceXMLFormat/）
       —— 给出 entities.xml 的确切结构
   **但我手上一个真实的 Confluence 导出包都没有。** 拿不到样本时，
   盲写出来的解析器大概率要在真包上调结构。

   所以这个文件的读法是：
     · 注释里凡是写「实测」的地方，都是**在我按文档构造的样例上**测的
     · 结构假设集中放在「结构假设」那一节，改的时候先看那里
   这跟项目里对「 Lake* 缺真实样本」的处理是同一个态度：
   **先说清哪些是猜的，别把猜测写成结论。**

   ------------------------------------------------------------
   格式（按 XWiki 那份文档）
   ------------------------------------------------------------
   包里是：`entities.xml` + `attachments/` 目录（+ `exportDescriptor.properties`）

   entities.xml 是个「hibernate 数据库转储」，根节点 `hibernate-generic`，
   下面全是 `object`，每个 object 有 class/package，`class` 的最后一段是类型名：

       <object class="com.atlassian.confluence.pages.Page" package="...">
         <id name="id">786435</id>
         <property name="title"><![CDATA[某页标题]]></property>
         <property name="bodyContentId">819224</property>
         <collection name="ancestors" class="java.util.Collection">
           <element class="com.atlassian.confluence.pages.Page"><id name="id">753689</id></element>
         </collection>
       </object>

   页面正文**不在 Page 里**，而在另一条 `BodyContent` 上，靠 `bodyContentId` 串起来：

       <object class="com.atlassian.confluence.core.BodyContent" package="...">
         <id name="id">819224</id>
         <property name="body"><![CDATA[<p>正文是 Confluence storage format</p>]]></property>
       </object>

   **目录层级靠 `ancestors` 集合**（从根到父的顺序），不是靠 parentId 字段 ——
   Confluence 的页面树没有单数的 parent 指针，父链在 ancestors 里。
   这也是为什么 HTML 导出会「看起来是平的」：那条路没有这层结构。

   ------------------------------------------------------------
   正文走 storage format → HTML → Markdown → 块
   ------------------------------------------------------------
   和 `.lakebook` 一样，**不自己写 storage format 的解析器**：
   storage format 本质是 XHTML，本项目已有 `htmlToMarkdown` 覆盖了
   标题 / 列表 / 表格 / 代码块 / 引用 / 图片 / 链接，
   再走 `mdToBlocks` 复用已有的转换质量。

   认不出的标签（各种 `ac:` 宏）**降级成纯文本，不报错、不丢文档** ——
   这跟 `htmlToMarkdown` 自己的取舍一致。
   ============================================================ */

import type { Block } from '@/types'
// 写成 `./lakebook.ts` 而不是 `./lakebook`：
// Vite 两种都认，但 Node 直接跑套件时（`--experimental-strip-types`）
// **只认带扩展名的**。少一个点，测试就跑不起来。
import { htmlToMarkdown } from './lakebook.ts'

/* ============================================================
   结构假设（改之前先看这里）
   ------------------------------------------------------------
   下面 6 条是**按文档写的、没在真包上验过**的假设。
   每条后面标了它在文档里的出处，方便对照，也方便你拿到样本后逐条核。
   ============================================================ */

/** ① object 的 class 属性的最后一段就是类型名（文档：Common concepts） */
const typeOf = (cls: string) => cls.split('.').pop() || ''

/** ② 属性写在 <property name="X">…</property>，值常包在 CDATA 里（文档：property nodes） */
const propRe = /<property\s+name="([^"]+)"\s*>([\s\S]*?)<\/property>/g
/** ③ 对象 id 写在 <id name="id">N</id>（ConfluenceUserImpl 是 name="key"） */
const idRe = /<id\s+name="(?:id|key)"\s*>\s*([^<\s]+)\s*<\/id>/
/** ④ 页面正文通过 bodyContentId 指向另一条 BodyContent */
const pageCls = 'com.atlassian.confluence.pages.Page'
const bodyCls = 'com.atlassian.confluence.core.BodyContent'

/** ⑤ 一个 object 节点：<object …>…</object>（不嵌套 object，所以非贪婪即可） */
const objectRe = /<object\b[^>]*class="([^"]+)"[^>]*>([\s\S]*?)<\/object>/g
/** ⑥ ancestors 集合里的 <element class="…Page"><id name="id">N</id></element> */
const ancestorRe = /<collection\s+name="ancestors"[^>]*>([\s\S]*?)<\/collection>/

/** 拆 CDATA / 实体 */
function unwrap(raw: string): string {
  let s = raw.trim()
  const cd = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(s)
  if (cd) s = cd[1]
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')   // **必须最后**：早做会把 &lt; 里的 & 也吃掉
}

/** 把一个 object 的内部拆成 { props: Map, ancestors: string[] } */
function parseObject(body: string) {
  const props = new Map<string, string>()
  propRe.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = propRe.exec(body))) props.set(m[1], unwrap(m[2]))

  const id = idRe.exec(body)?.[1] || ''

  const ancBlock = ancestorRe.exec(body)?.[1] || ''
  const ancestors: string[] = []
  // 逐个 <element …><id …>N</id></element> 依次取
  const elRe = /<element\b[^>]*>[\s\S]*?<id\s+name="(?:id|key)"\s*>\s*([^<\s]+)\s*<\/id>[\s\S]*?<\/element>/g
  let e: RegExpExecArray | null
  while ((e = elRe.exec(ancBlock))) ancestors.push(e[1])

  return { id, props, ancestors }
}

/* ============================================================
   对外
   ============================================================ */

export interface ConfluenceDoc {
  /** Confluence 里的页面 id（导出包里唯一，导入后也用它做稳定标识） */
  id: string
  title: string
  /** Confluence storage format 的 XHTML 原样 */
  html: string
  /** 转出来的 Markdown（导入前的预览用这个） */
  markdown: string
  blocks: Block[]
  /** 祖先页面 id，从根到父。空数组 = 顶层页面 */
  ancestors: string[]
  /** 这页在导出包里的**深度**（0 = 顶层）。父链缺页面时按能对上的那些算 */
  depth: number
}

export interface ConfluenceParse {
  /** 空间名（从 exportDescriptor.properties 拿，拿不到就空） */
  spaceName: string
  docs: ConfluenceDoc[]
  /** 目录树：按 depth 还原，docs 里带 doc 引用 */
  tree: { title: string; doc: ConfluenceDoc; depth: number }[]
  warnings: string[]
  /** 统计，用来在预览里如实说「多少篇、多少张附件、多少条评论没导」 */
  stats: {
    pages: number
    blogs: number
    bodies: number
    attachments: number
    comments: number
    /** 正文为空的页数——这种页导进来是空文档，必须让人看见 */
    emptyPages: string[]
  }
}

/**
 * 解析 entities.xml。
 *
 * `mdToBlocks` 由调用方注入（store 里的 markdownToBlocks），
 * 理由和 `parseLakebook` 一样：解析器不该拖着 store 依赖，
 * 那样它就没法在 Node 里直接测。
 */
export function parseConfluenceXml(
  entitiesXml: string,
  exportDescriptor: string,
  mdToBlocks: (md: string) => Block[],
): ConfluenceParse {
  const warnings: string[] = []
  const spaceName = /^spaceName\s*=\s*(.+)$/m.exec(exportDescriptor || '')?.[1]?.trim() || ''

  // 先扫一遍所有 object，按类型分堆
  const pages = new Map<string, { id: string; props: Map<string, string>; ancestors: string[] }>()
  const bodies = new Map<string, string>()
  let blogs = 0, attachments = 0, comments = 0

  objectRe.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = objectRe.exec(entitiesXml))) {
    const cls = m[1]
    const t = typeOf(cls)
    const o = parseObject(m[2])
    if (t === 'Page') pages.set(o.id, { id: o.id, props: o.props, ancestors: o.ancestors })
    else if (t === 'BlogPost') blogs++
    else if (t === 'BodyContent') bodies.set(o.id, o.props.get('body') || '')
    else if (t === 'Attachment') attachments++
    else if (t === 'Comment') comments++
  }

  if (!pages.size) {
    throw new Error(
      '这个 XML 里没有读到任何页面（object class 没有 …pages.Page）。' +
      '它可能不是 Confluence 的空间导出包。',
    )
  }

  // 正文通过 bodyContentId 串起来。串不上就**如实记一条**，
  // 而不是静默导一篇空文档 —— 后者会表现为「导入后这篇是空的」，
  // 而用户完全看不出是导出包的问题。
  const docs: ConfluenceDoc[] = []
  const emptyPages: string[] = []
  for (const p of [...pages.values()]) {
    const title = p.props.get('title') || ''
    const bodyId = p.props.get('bodyContentId') || ''
    const html = bodies.get(bodyId) || ''
    if (!html) {
      emptyPages.push(title || p.id)
      warnings.push(`「${title || p.id}」在导出包里找不到正文（bodyContentId=${bodyId || '空'}），导入后会是空文档`)
    }
    docs.push({
      id: p.id,
      title,
      html,
      markdown: htmlToMarkdown(html),
      blocks: mdToBlocks(htmlToMarkdown(html)),
      ancestors: p.ancestors,
      depth: p.ancestors.length,
    })
  }

  // 父链里指向的页面不在包里（选了 Custom Export 就会这样）
  const known = new Set(pages.keys())
  const dangling = new Set<string>()
  for (const d of docs) for (const a of d.ancestors) if (!known.has(a)) dangling.add(a)
  if (dangling.size) {
    warnings.push(
      `有 ${dangling.size} 个父页面不在这个导出包里（选「Custom Export」时会发生）。` +
      `这些页面会挂在目录下层，父级缺失。`,
    )
  }

  return {
    spaceName,
    docs,
    tree: docs.map((d) => ({ title: d.title, doc: d, depth: d.depth })),
    warnings,
    stats: { pages: pages.size, blogs, bodies: bodies.size, attachments, comments, emptyPages },
  }
}
