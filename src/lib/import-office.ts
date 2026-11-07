/* ============================================================
   zip（Markdown + 图片）与 Excel / CSV 导入
   ------------------------------------------------------------
   2026-10-16 照真实语雀补的两条口子。语雀官方《如何导入导出知识库》列的
   导入格式是：Word(.docx .doc) / Excel(.xlsx .xls .csv) /
   Markdown(.md .markdown .mark .txt) / zip / Evernote(.html+zip)
   加它自己的 .lakebook 等。

   我们已有的：Markdown 文件夹、Word .docx、语雀 .lakebook、数据包 JSON。
   这一次补的是 **zip** 和 **Excel/CSV** 两项。

   ⚠️ **明确不支持的（界面上也写清，不藏着）**：
   · `.doc` —— 老二进制 OLE 复合文档，不是 zip。解析它要引第三方依赖，
     而引依赖意味着「以后每次构建都要联网装」——内网部署直接起不来。
   · `.xls` —— 同理，老 BIFF 二进制格式。
   · Evernote `.html + zip` —— Evernote 导出的是 HTML 包装，
     它的内部笔记格式（ENEX 里的 base64 资源、内嵌附件）我们没有对应的
     数据结构，硬转只会得到一堆标签残渣。

   这几条宁可写在界面上说「暂不支持」，也不要摆一个「导入」按钮
   让人以为都能进 —— 那是这个项目一直在清的同一类假动作。
   ============================================================ */

import type { SheetTab } from '@/types'
// 用 `.ts` 扩展名（和 src/lib/classdiagram.ts、erdiagram.ts 一样）：
// 省略扩展名 Vite 能解析，**Node 的 ESM 不能** —— 而这个模块要被
// `test-import-office.mjs` 直接 import 来单测。
import { isZip, listZip, readZipText } from './unzip.ts'
import type { ImportFile } from './import-markdown.ts'

/** 和 `import-markdown.ts` 里那份判定保持一致（那边是私有的，这里不重复实现） */
const isMarkdownName = (n: string) => /\.(md|markdown|mdown|txt)$/i.test(n)

/* ============================================================
   一、zip（Markdown + 目录结构）
   ============================================================ */

/**
 * 把一个 zip 拆成一组「带相对路径的文件」。
 *
 * 刻意**不新开一条导入通路**：出来的 `ImportFile[]` 和
 * 「Markdown 文件夹」那条走的是同一个 `planImport`，
 * 于是目录层级、转换规则、预览、落库全部复用同一份实现 ——
 * 抄第二遍就是「同一份逻辑两处、必漏一处」。
 *
 * ⚠️ **包里的图片不会被上传**（2026-10-16 的已知边界）。
 * Markdown 里 `![](a.png)` 这种相对引用，在本系统里会指向一个
 * 根本不存在的附件 —— 导入完是「文档在、图裂了」。
 * 与其那样，不如在下面如实报出「包里有 N 个图片文件、这次不会跟着进来」。
 */
export async function zipToImportFiles(bytes: Uint8Array): Promise<{
  files: ImportFile[]
  skipped: { name: string; reason: string }[]
}> {
  if (!isZip(bytes)) throw new Error('这不是一个有效的 ZIP 包')
  const entries = listZip(bytes)
  const files: ImportFile[] = []
  const skipped: { name: string; reason: string }[] = []
  let imageCount = 0

  for (const e of entries) {
    if (e.isDir) continue
    if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(e.name)) { imageCount++; continue }
    if (!isMarkdownName(e.name)) {
      skipped.push({ name: e.name, reason: '不是 Markdown 文件（本次只导入 .md/.markdown/.txt）' })
      continue
    }
    let text = ''
    try {
      text = await readZipText(bytes, e)
    } catch (err) {
      skipped.push({ name: e.name, reason: `解压失败：${(err as Error)?.message || err}` })
      continue
    }
    if (!text.trim()) { skipped.push({ name: e.name, reason: '文件是空的' }); continue }
    files.push({ name: e.name.split('/').pop() || e.name, webkitRelativePath: e.name, text })
  }

  if (imageCount) {
    skipped.push({
      name: `（包内 ${imageCount} 个图片文件）`,
      reason: '本次不随 zip 一起上传图片 —— 导入后正文里的图片引用会失效，需要在文档里重新插入附件',
    })
  }
  return { files, skipped }
}

/* ============================================================
   二、CSV
   ============================================================ */

/** 一行 CSV → 单元格数组。处理引号、逗号、换行、`""` 转义。 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }      // "" → 一个引号
        else inQuote = false
      } else cur += ch
    } else if (ch === '"') inQuote = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out
}

/** 整份 CSV → 二维数组（去掉完全空白的行） */
export function parseCsv(text: string): string[][] {
  const raw = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  const rows = raw.map(parseCsvLine).filter((r) => r.some((c) => c.trim()))
  if (!rows.length) throw new Error('这个 CSV 里没有数据')
  return rows
}

/* ============================================================
   三、xlsx
   ------------------------------------------------------------
   xlsx 本身就是个 zip，所以复用 unzip 那套（inflate 支持 deflate，
   见 inflate.ts 的说明 —— 只认 stored 的话真实 xlsx 必然解不开）。
   要读三样东西：
     xl/sharedStrings.xml   共享字符串表（绝大多数中文单元格在这里）
     xl/workbook.xml       工作表名字与 r:id 的对应
     xl/worksheets/sheetN.xml  单元格
   ============================================================ */

const dec = new TextDecoder('utf-8')

/** `B7` → 列下标 1；`AA3` → 26 */
function colIndex(ref: string): number {
  const m = /^([A-Z]+)/.exec(ref.toUpperCase())
  if (!m) return 0
  let n = 0
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** 把 XML 拆成标签数组 —— 这里只需要「文本」和「属性」，不需要真正的 DOM */
function tags(xml: string, name: string): { attrs: Record<string, string>; inner: string }[] {
  const re = new RegExp(`<${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${name}>)`, 'g')
  const out: { attrs: Record<string, string>; inner: string }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const attrs: Record<string, string> = {}
    const attrRe = /([\w:]+)="([^"]*)"/g
    let a: RegExpExecArray | null
    while ((a = attrRe.exec(m[1] || ''))) attrs[a[1]] = decodeXml(a[2])
    out.push({ attrs, inner: m[2] || '' })
  }
  return out
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
}

/** `<t>hello</t>` → `hello`（会拆成多段的 `<t>` 直接接起来） */
function textOf(inner: string): string {
  let s = ''
  for (const t of tags(inner, 't')) s += t.inner
  return s
}

/**
 * `<v>12</v>` → `12`。
 *
 * ⚠️ 数字单元格的值在 **`v`** 里，只有字符串在 `t` 里 ——
 * 第一版对数字也用 `textOf`（只找 `<t>`），于是每一个数字都读成空串：
 * 「第 1 周 | 12 | 导入 Excel」变成了「第 1 周 | | 导入 Excel」。
 * 而这种丢失**看着完全正常**（表格就是少几个值），所以必须是测试逼出来的。
 */
function valueOf(inner: string): string {
  let s = ''
  for (const v of tags(inner, 'v')) s += v.inner
  return s
}

export interface XlsxSheet { name: string; rows: string[][] }

/**
 * 读一个 .xlsx。
 *
 * 只取「值」：共享字符串 / 内联字符串 / 数字。
 * **公式、合并单元格、样式、日期格式一律不还原** —— 那些在导入成一张
 * 通用表格时本来就带不过来，硬还原反而会让数字变成一串序列号。
 * 界面上如实说明，不假装「完整支持」。
 */
export async function readXlsx(bytes: Uint8Array): Promise<XlsxSheet[]> {
  if (!isZip(bytes)) throw new Error('这不是一个有效的 xlsx（它应该是个 ZIP 包）')
  const entries = listZip(bytes)
  const byName = new Map(entries.map((e) => [e.name, e]))
  const getText = async (n: string): Promise<string> => {
    const e = byName.get(n)
    return e ? await readZipText(bytes, e) : ''
  }

  // 共享字符串表
  const shared: string[] = []
  const ss = await getText('xl/sharedStrings.xml')
  if (ss) for (const si of tags(ss, 'si')) shared.push(textOf(si.inner))

  // 工作表名字：`<sheet name="需求" sheetId="1" r:id="rId1"/>`
  const wb = await getText('xl/workbook.xml')
  const names = tags(wb, 'sheet').map((s) => s.attrs.name || '')

  // 逐个工作表读
  const sheetFiles = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => {
      const na = Number(/sheet(\d+)\.xml$/.exec(a.name)![1])
      const nb = Number(/sheet(\d+)\.xml$/.exec(b.name)![1])
      return na - nb
    })

  const out: XlsxSheet[] = []
  for (let i = 0; i < sheetFiles.length; i++) {
    const xml = await getText(sheetFiles[i].name)
    const rows: string[][] = []
    for (const row of tags(xml, 'row')) {
      const cells: string[] = []
      for (const c of tags(row.inner, 'c')) {
        const at = colIndex(c.attrs.r || '')
        const t = c.attrs.t
        let v = ''
        if (t === 's') {
          const idx = Number((tags(c.inner, 'v')[0]?.inner ?? '-1').trim())
          v = Number.isFinite(idx) ? (shared[idx] ?? '') : ''
        } else if (t === 'inlineStr') {
          v = textOf(c.inner)
        } else {
          v = valueOf(c.inner).trim()      // 数字 / 布尔（在 <v> 里，不是 <t>）
        }
        while (cells.length < at) cells.push('')
        cells[at] = v
      }
      if (cells.some((c) => c !== '')) rows.push(cells)
    }
    if (rows.length) out.push({ name: names[i] || `工作表${i + 1}`, rows })
  }
  if (!out.length) throw new Error('这个 xlsx 里没有读到任何单元格')
  return out
}

/* ============================================================
   四、表格数据组装
   ============================================================ */

/**
 * 二维数组 → 我们的 `sheet` 文稿数据。
 *
 * 第一行当表头（语雀/Excel 的一般习惯），
 * 但**表头为空**时就不硬套 —— 那种情况下第一行是数据，
 * 硬套会把第一条记录变成列名，而数据就永远丢了。
 */
/**
 * 返回的是**单个工作表**（SheetTab），不是 DocSheetData['sheets'] 那个对象。
 *
 * ⚠️ 原来这里标成 `DocSheetData['sheets'][number]` ——
 * 但 `sheets` 本身就是 `{ sheets: SheetTab[]; activeId }` 这个对象，
 * 少写一层索引，标注的是一个从来不存在的东西（tsc TS2537）。
 * 调用处是 `sheets: [p.data]`，所以元素类型就是 SheetTab。
 */
export function sheetDataFromRows(sheetName: string, rows: string[][]): SheetTab {
  const width = Math.max(...rows.map((r) => r.length), 1)
  const pad = (r: string[]) => [...r, ...Array(Math.max(0, width - r.length)).fill('')]

  const firstRow = pad(rows[0] || [])
  const hasHeader = firstRow.some((c) => c.trim())
  const body = hasHeader ? rows.slice(1) : rows
  const cols = Array.from({ length: width }, (_, i) => ({
    id: `c${i + 1}`,
    name: (hasHeader ? firstRow[i] : `列${i + 1}`) || `列${i + 1}`,
    k: 'text' as const,
  }))

  return {
    id: 'sh1',
    name: sheetName || 'Sheet1',
    cols,
    rows: body.map((r) => pad(r).map((v) => ({ v }))),
  }
}

/** 一个文件 → 能导入吗（Excel / CSV） */
export function isSpreadsheetName(name: string): boolean {
  return /\.(xlsx|csv)$/i.test(name)
}

/** CSV 要按 GBK 读吗？—— 中文 Excel 导出的 CSV 默认就是 GBK。 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  // UTF-8 解出来有替换字符 → 多半是 GBK
  if (utf8.includes('\uFFFD')) {
    try { return new TextDecoder('gbk').decode(bytes) } catch { /* 浏览器不支持 gbk 就退回 utf-8 */ }
  }
  return utf8
}
