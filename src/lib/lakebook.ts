/* ============================================================
   语雀 Lakebook 导出包解析
   ------------------------------------------------------------
   这是「无语雀格式互导」那个缺口的实现。格式不是猜的 ——
   语雀官方《lakebook 格式说明》（https://www.yuque.com/yuque/developer/lt69uo）
   明确写了这个结构，并且说明「如需导入其他平台，可按照文档进行解析」。

   包的结构：
     · `.lakebook` 是一个 **tar 包**（可能 gzip 压缩）
     · 里面是若干个 `.json`，**文件名就是文档的 slug**
     · 其中 `$meta.json` 存知识库元信息，其中 `meta.book.tocYml`
       是一段**内嵌的 YAML**，描述整棵目录树
     · 每个文档 JSON 里 `body` 是 HTML，`body_asl` 是语雀自己的
       Lake 结构化格式

   目录树靠 tocYml 里的这几个字段还原：
     uuid / parent_uuid / child_uuid / sibling_uuid / level / title / url
   其中 `url` 就是那个 `.json` 的文件名（slug）。

   为什么正文走 HTML → Markdown 而不是解析 `body_asl`：
   ASL 是语雀的私有结构（卡片、富文本节点都有自己的一套），
   而 HTML 是标准格式、语义完整，而且**本项目已经有一条被测过的
   Markdown → 块 通路**。转成 Markdown 再走那条路，等于复用已有的
   转换质量，而不是新写一套必然有边界的 HTML 解析器。
   ============================================================ */

import type { Block } from '@/types'

/* ============================================================
   tar 读取
   ------------------------------------------------------------
   自己写而不是引依赖：tar 的格式简单到不值得为它加一个运行时依赖，
   而 gzip 用的是**原生** DecompressionStream（浏览器与 Node 都有），
   所以整条链路零新依赖 —— 这跟「内网机器没有编译工具链」的约束一致。
   ============================================================ */

const TAR_BLOCK = 512

function readOctal(buf: Uint8Array, offset: number, length: number): number {
  // tar 的数字字段是「N 字节的八进制 + NUL/空格」
  // 有些实现会用 base-256（高位 0x80）表示超大文件，这里一并兼容
  if (buf[offset] & 0x80) {
    let v = 0
    for (let i = offset + 1; i < offset + length; i++) v = v * 256 + buf[i]
    return v
  }
  let s = ''
  for (let i = offset; i < offset + length; i++) {
    const c = buf[i]
    if (c === 0 || c === 32) { if (s) break; continue }
    s += String.fromCharCode(c)
  }
  return s ? parseInt(s, 8) || 0 : 0
}

function readStr(buf: Uint8Array, offset: number, length: number): string {
  let s = ''
  for (let i = offset; i < offset + length; i++) {
    const c = buf[i]
    if (c === 0) break
    s += String.fromCharCode(c)
  }
  return s
}

async function gunzipIfNeeded(data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) return data
  const ds = new DecompressionStream('gzip')
  const stream = new Blob([data as unknown as BlobPart]).stream().pipeThrough(ds)
  const buf = await new Response(stream).arrayBuffer()
  return new Uint8Array(buf)
}

export interface TarEntry {
  name: string
  size: number
  bytes: Uint8Array
}

/** 解析 tar，返回所有普通文件（目录项跳过） */
export function parseTar(input: Uint8Array): TarEntry[] {
  const out: TarEntry[] = []
  let off = 0
  while (off + TAR_BLOCK <= input.length) {
    const name = readStr(input, off, 100)
    if (!name) break // 两个连续的 NUL 块 = 归档结束
    const size = readOctal(input, off + 124, 12)
    const type = String.fromCharCode(input[off + 156] || 48)
    const prefix = readStr(input, off + 345, 155)
    const full = prefix ? `${prefix}/${name}` : name
    const dataStart = off + TAR_BLOCK
    if (type === '0') {
      out.push({ name: full, size, bytes: input.subarray(dataStart, dataStart + size) })
    }
    // 数据区按 512 对齐；负的 size 见过（损坏包），直接停，避免死循环
    const step = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    if (size < 0 || dataStart + step <= off) break
    off = dataStart + step
  }
  return out
}

const dec = new TextDecoder('utf-8')

/** 语雀导出包里条目可能在子目录（`xxx.lakebook/xxx.json`），按文件名取 */
const baseName = (p: string) => p.split('/').pop() || p

/* ============================================================
   $meta.json 与 tocYml
   ============================================================ */

export interface LakeTocNode {
  /** tocYml 里的 uuid，父子关系靠它 */
  uuid: string
  title: string
  /** 对应文档 JSON 的文件名（slug） */
  slug: string
  level: number
  visible: number
  type: string
}

export interface LakeMeta {
  title: string
  description: string
  nodes: LakeTocNode[]
}

const META_NAME = '$meta.json'

/**
 * 解析内嵌的 tocYml。
 *
 * 只支持它实际用到的形状：一串 `- key: value` 开头的条目，
 * 顶层还有若干个 `key: value`。值里带引号与转义（\n、\"），
 * 语雀确实这么写，所以必须处理，不能简单地 `split(':')`。
 * 写一个通用 YAML 解析器不划算 —— 这个形状稳定且窄。
 */
export function parseTocYml(yaml: string): LakeTocNode[] {
  const nodes: LakeTocNode[] = []
  let cur: Record<string, string> | null = null
  for (const rawLine of yaml.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (!line.trim()) continue
    if (line.startsWith('- ')) {
      if (cur) nodes.push(toToc(cur))
      cur = {}
      const kv = line.slice(2)
      applyKv(cur, kv)
    } else if (cur) {
      applyKv(cur, line.trim())
    } else {
      // 顶层字段（display_level / version_id 之类），目录用不到，忽略
    }
  }
  if (cur) nodes.push(toToc(cur))
  return nodes
}

function applyKv(target: Record<string, string>, kv: string) {
  const i = kv.indexOf(':')
  if (i < 0) return
  const k = kv.slice(0, i).trim()
  let v = kv.slice(i + 1).trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  target[k] = v
}

const toToc = (r: Record<string, string>): LakeTocNode => ({
  uuid: r.uuid || '',
  title: r.title || '',
  slug: r.url || '',
  level: Number(r.level || 0) || 0,
  visible: Number(r.visible || 1) || 0,
  type: r.type || 'DOC',
})

/** 从包里取出知识库元信息 */
export function parseLakeMeta(files: { name: string; bytes: Uint8Array }[]): LakeMeta | null {
  const f = files.find((x) => baseName(x.name) === META_NAME)
  if (!f) return null
  let j: any
  try { j = JSON.parse(dec.decode(f.bytes)) } catch { return null }
  const book = j?.meta?.book || {}
  // tocYml 有时在 book 下、有时在 meta 下，两处都找
  const tocYml = String(book.tocYml ?? j?.meta?.tocYml ?? '')
  return {
    title: String(book.name || j?.meta?.name || '导入的知识库'),
    description: String(book.description || ''),
    nodes: tocYml ? parseTocYml(tocYml) : [],
  }
}

/* ============================================================
   HTML → Markdown
   ------------------------------------------------------------
   只覆盖语雀文档里真正会出现的标签。少覆盖没关系 ——
   少认识一种标签，最坏结果是那部分内容退化成纯文本，
   而**不会**丢文档或打乱结构。
   ============================================================ */

const INLINE: Record<string, string> = {
  strong: '**', b: '**', em: '*', i: '*', code: '`', del: '~~', s: '~~',
}

export function htmlToMarkdown(html: string): string {
  if (!html) return ''
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n\n---\n\n')

  /*
   * 顺序是这里的关键，踩过一次。
   *
   * 最早我先做了一趟「把所有块级标签换成换行」，再回头处理标题 / 列表 /
   * 代码块 / 表格 —— 结果那一趟把 `<h1>`、`<li>`、`</tr>`、`<blockquote>`
   * 全部吃掉了，后面的规则再匹配时标签已经不存在，于是：
   * 标题不认得、列表项丢了、表格整块塌成一行纯文本。
   * 规则之间有依赖：先跑需要保留标签的规则，再做通用剥离。
   */

  // 表格（要保留 <tr>/<td>，必须最先处理）
  text = text.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, inner) => {
    const rows = [...String(inner).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...String(r[1]).matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => stripTags(String(c[1])).trim()),
    )
    if (!rows.length) return '\n\n'
    const width = Math.max(...rows.map((r) => r.length))
    const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill('')].join(' | ')
    const lines = [`| ${pad(rows[0])} |`, `| ${Array(width).fill('---').join(' | ')} |`]
    for (const r of rows.slice(1)) lines.push(`| ${pad(r)} |`)
    return '\n\n' + lines.join('\n') + '\n\n'
  })

  // 代码块
  text = text.replace(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_m, code) => fence(String(code)))
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, code) => fence(String(code)))

  // 标题
  for (let n = 1; n <= 6; n++) {
    text = text.replace(new RegExp(`<h${n}(\\s[^>]*)?>([\\s\\S]*?)<\\/h${n}>`, 'gi'), (_m, _a, inner) => {
      return `\n\n${'#'.repeat(n)} ${stripTags(String(inner)).trim()}\n\n`
    })
  }

  // 引用
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner) => {
    const body = stripTags(String(inner)).replace(/\n{2,}/g, '\n').trim()
    return '\n\n' + body.split(/\n+/).filter(Boolean).map((l) => `> ${l}`).join('\n') + '\n\n'
  })

  // 图片与链接（行内，但要在通用剥离之前）
  text = text.replace(/<img([^>]*?)src=["']([^"']+)["']([^>]*)>/gi, (_m, _a, src, rest) => {
    const alt = /alt=["']([^"']*)["']/.exec(rest)?.[1] || ''
    return `\n\n![${alt}](${src})\n\n`
  })
  text = text.replace(/<a([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi, (_m, _a, href, _b, inner) => {
    const t = stripTags(String(inner)).trim()
    return t ? `[${t}](${href})` : ''
  })

  // 列表项
  text = text.replace(/<li(\s[^>]*)?>/gi, '- ')

  // 行内强调
  for (const [tag, mark] of Object.entries(INLINE)) {
    text = text.replace(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi'), (_m, _a, inner) => {
      const t = stripTags(String(inner))
      return mark + t + mark
    })
  }

  // 到这里才开始通用剥离
  text = text
    .replace(/<\/(p|div|section|tr|li|blockquote|pre)>/gi, '\n')
    .replace(/<(p|div|section)(\s[^>]*)?>/gi, '\n')

  const md = decodeEntities(stripTags(text))
  return md.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

const fence = (code: string) => `\n\n\`\`\`\n${decodeEntities(code).replace(/^\n+|\n+$/g, '')}\n\`\`\`\n\n`

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/* ============================================================
   整体解析
   ============================================================ */

export interface LakeDoc {
  slug: string
  title: string
  /** 语雀里的类型：文档 / BOARD / TABLE / SHEET … */
  kind: string
  blocks: Block[]
}

export interface LakebookParse {
  title: string
  description: string
  docs: LakeDoc[]
  /** 目录结构（按 tocYml 的层级还原），与 docs 一一对应 */
  tree: { title: string; slug: string; depth: number; doc: LakeDoc }[]
  /** 包里有多少个文档 JSON（哪怕正文没解析出来也要报出来） */
  fileCount: number
  warnings: string[]
}

export async function parseLakebook(
  file: ArrayBuffer | Uint8Array,
  /** Markdown → 块。由调用方注入（store 里的 markdownToBlocks）。
   *  做成参数而不是直接 import：解析器不該拖着一个 store 依赖，
   *  那样它就没法在 Node 里直接测了。 */
  mdToBlocks: (md: string) => Block[],
): Promise<LakebookParse> {
  const raw = file instanceof Uint8Array ? file : new Uint8Array(file)
  const warnings: string[] = []
  const data = await gunzipIfNeeded(raw)
  const entries = parseTar(data)
  if (!entries.length) throw new Error('这不是一个有效的 Lakebook 包：里面没有读到任何文件')

  const meta = parseLakeMeta(entries)
  const jsonFiles = entries.filter((e) => baseName(e.name).endsWith('.json') && baseName(e.name) !== META_NAME)
  if (!jsonFiles.length) throw new Error('包里没有找到文档 JSON（.lakebook 结构可能变了，请反馈）')

  const bySlug = new Map<string, any>()
  for (const f of jsonFiles) {
    try { bySlug.set(baseName(f.name).replace(/\.json$/, ''), JSON.parse(dec.decode(f.bytes))) } catch { /* 单篇坏掉不该让整包失败 */ }
  }

  const docs: LakeDoc[] = []
  /**
   * 语雀的画板 / 数据表 / 表格**不是 HTML 正文**：
   * 它们的 format 分别是 lakeboard / laketable / lakesheet，body 里是各自的
   * 结构化数据。拿 HTML 转换器去处理，只会得到一堆标签残渣。
   *
   * 所以这里按类型分开走，并且**明说**它们被降级了 ——
   * 悄悄把 30 张表格变成 30 篇空文档，导入的人完全看不出来，
   * 等发现的时候已经白忙一场了。
   *
   * ⚠️ **lakesheet 的真实格式已经查到了，这里只是还没实现。**
   * 依据是基于 PZh101/YuqueExportToMarkdown 扩展的那个转换器，它写明：
   *   - lakesheet 的数据在 **`body_draft`** 字段里（不是 body）；
   *   - 该字段是 JSON，其中 `sheet` 子字段是 **latin-1 编码的字符串**；
   *   - 解码路径：取 sheet → encode('latin-1') → **zlib.decompress** → JSON.parse；
   *   - 公式单元格形如 `{ class: 'formula', value: ... }`，要用算完的 `value`，
   *     不能直接用原始 JSON。
   * 另外 laketable 导出还会带 Excel 友好的列信息，select/multi_select 存的是
   * 选项 id，要映射回显示文本。
   *
   * **为什么有这些信息却还不做**：缺一个真的 lakesheet 样本。
   * 上面这些是从别人的实现描述里来的，而那个实现的目标是「转成 Markdown 表格」，
   * 不是「转成本项目的 sheet 模型」—— 单元格/行/工作表的实际形状没验证过。
   * 照着描述硬写一个转换器，出来的很可能是个「看起来对」的假货：
   * 表格能显示，但合并单元格、公式、多工作表全是错的，而用户分辨不出来。
   * 等真拿到样本再实现，比现在就猜要负责。
   *
   * ⚠️ 2026-10-11：**试过拿真样本，没拿到**。卡点记在这儿，免得下一个人重走一遍。
   *   · 路径是通的：语雀 → 知识库设置 → **更多设置** → 「导出知识库」→ 导出按钮。
   *     顺带实测确认：那页「导出 / 转移知识库 / 删除知识库」三块的位置，
   *     与我们 BookSettings 的 AdvancedTab 一致。
   *   · 卡在最后一步：那是**浏览器下载**，文件落到磁盘哪个目录拿不到；
   *     导出过程中内置浏览器还出现了操作超时（页面反复重渲染，ref 一直失效）。
   *   ⇒ 所以只差「把导出的 .lakebook 放进工作区」这一步 ——
   *     拿到之后，解析与转换就能自己做完并测。
   *     这不是「要你操作的权限类事情」，是我这边没有可靠的下载落盘通道。
   */
  const degraded: string[] = []
  for (const j of bySlug.values()) {
    const slug = String(j.slug || '')
    const title = String(j.title || slug || '未命名')
    const format = String(j.format || 'lake')
    const type = String(j.type || 'ASL')
    /**
     * 普通文档的 format 是 **`lake`**，不是 `lakebook`。
     *
     * 依据语雀官方《lakebook 格式说明》($meta.json 示例)：
     *   普通文档 yuuex6 → "format": "lake"
     *   画板           → "format": "lakeboard"
     * `lakebook` 是**包**的后缀名（.lakebook），不是文档的 format。
     *
     * 这里曾经把 `lakebook` 当成普通文档的 format，于是拿一个**真的**语雀导出包
     * 进来，每一篇普通文档都会被判成「结构化内容、暂不还原」，
     * 正文被换成一句提示 —— 整库内容全被清空，而导入预览的警告还把它
     * 混在「画板 / 数据表 / 表格」里，看半天看不出正常文档也没了。
     * 一直没被发现，是因为测试夹具**也**把普通文档写成了 `lakebook` ——
     * 两边一致地错，测试当然是绿的。
     *
     * `lakebook` 仍然收着：有的导出确实把包名写进了 format。
     */
    const isPlainDoc = format === 'lake' || format === 'lakebook' || format === ''
    if (!isPlainDoc) {
      const kind = format.replace(/^lake/, '').toUpperCase() || type
      degraded.push(`${title}（${kind}）`)
      docs.push({
        slug, title, kind,
        blocks: mdToBlocks(
          `> ⚠️ 这是语雀的${kind}，本项目暂不还原其结构，已作为普通文档导入。\n` +
          `> 原始内容在语雀导出包的 \`${slug}.json\` 里。`,
        ),
      })
      continue
    }
    docs.push({ slug, title, kind: '文档', blocks: mdToBlocks(htmlToMarkdown(String(j.body || ''))) })
  }
  if (degraded.length) {
    warnings.push(
      `有 ${degraded.length} 个语雀结构化内容（画板 / 数据表 / 表格）无法还原，已作为普通文档导入：${degraded.slice(0, 5).join('、')}` +
      (degraded.length > 5 ? ` 等 ${degraded.length} 个` : ''),
    )
  }

  // 目录树：按 tocYml 的顺序 + level 还原层级
  const tree: LakebookParse['tree'] = []
  if (meta?.nodes.length) {
    const titleBySlug = new Map(docs.map((d) => [d.slug, d.title]))
    for (const n of meta.nodes) {
      if (!n.slug) continue
      const doc = docs.find((d) => d.slug === n.slug)
      if (!doc) { warnings.push(`目录里的「${n.title}」在包里找不到对应文档，已跳过`); continue }
      doc.title = n.title || titleBySlug.get(n.slug) || doc.title
      tree.push({ title: doc.title, slug: n.slug, depth: n.level, doc })
    }
    // 目录里没提到的文档不能丢：接在末尾，警告里说明
    for (const d of docs) {
      if (!tree.some((t) => t.slug === d.slug)) {
        warnings.push(`「${d.title}」不在目录树里，已放到末尾`)
        tree.push({ title: d.title, slug: d.slug, depth: 0, doc: d })
      }
    }
  } else {
    warnings.push('包里没有 $meta.json 或 tocYml，全部文档按平铺处理')
    for (const d of docs) tree.push({ title: d.title, slug: d.slug, depth: 0, doc: d })
  }

  return {
    title: meta?.title || '导入的知识库',
    description: meta?.description || '',
    docs,
    tree,
    fileCount: jsonFiles.length,
    warnings,
  }
}
