/**
 * Word（.docx）读写。
 *
 * ============================================================
 * 为什么自己写
 * ------------------------------------------------------------
 * 公司里第一批知识往往就在 Word 里，而官方的选型文档把
 * 「导入 / 导出 docx」列为**基本功能**。项目里此前只有
 * md / html / txt / json 四个格式 ——
 * 结果「导出限制」那条安全说明里写着一句不成立的话：
 * 「Markdown / Word / PDF 是在浏览器本地生成的」，
 * 拿一个不存在的能力当论据。
 *
 * 也不引第三方库：docx 就是一个 zip 加几个 XML，
 * 而 zip 的写入只需要「存储」方式就能生成合法文件；
 * 解压用同目录下的 inflate.ts（纯 TS，因为这段代码要在浏览器里跑）。
 * 为了一个导出格式塞进一个几 MB 的依赖，在内网离线部署里是负担。
 *
 * ============================================================
 * 范围（说清楚，免得被当成「Word 全家桶」）
 * ------------------------------------------------------------
 * 认这些块：标题、正文、引用、无序 / 有序列表、待办、
 * 代码块、分割线、表格、段落内的加粗 / 斜体 / 行内代码 / 链接。
 *
 * 明确**不做**：图片内嵌、目录域、页眉页脚、修订 / 批注、
 * 样式自定义、表格合并单元格。那些进了 Word 也多半要在 Word 里再调一遍，
 * 做一个半吊子的比不做更糟 —— 至少不做不会给人「导出了就能直接用」的错觉。
 * ============================================================
 */
// 用带扩展名的相对路径而不是 `@/lib/...`：
// 这个文件要被 test-docx.mjs 在**纯 Node** 里直接 import，
// 那里既不认 Vite 的 alias，也不补 .ts 扩展名。两边都要通就只能写全。
import { inflateRaw } from './inflate.ts'

/* ============================================================
   一、ZIP 的最小实现
   ============================================================ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const enc = new TextEncoder()

/** 日期转 DOS 时间（ZIP 头里用的老格式） */
function dosTime(d: Date) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff
  return { time, date }
}

type ZipEntry = { name: string; data: Uint8Array }

/**
 * 打包成 zip。全部用「存储」方式（method 0）——
 * 不压缩也完全合法，docx 也就几十 KB，换来的是不必处理 deflate 的边界。
 */
export function zip(entries: ZipEntry[]): Uint8Array {
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  const { time, date } = dosTime(new Date())

  for (const e of entries) {
    const name = enc.encode(e.name)
    const crc = crc32(e.data)
    const size = e.data.length

    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)   // local file header
    lv.setUint16(4, 20, true)           // version needed
    lv.setUint16(6, 0x0800, true)       // flags: UTF-8 文件名
    lv.setUint16(8, 0, true)            // method 0 = stored
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)
    chunks.push(local, e.data)

    const cen = new Uint8Array(46 + name.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true)   // central directory header
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    cen.set(name, 46)
    central.push(cen)

    offset += local.length + size
  }

  const centralSize = central.reduce((a, c) => a + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) { out.set(c, p); p += c.length }
  for (const c of central) { out.set(c, p); p += c.length }
  out.set(eocd, p)
  return out
}

/** 解包：按中央目录找条目，支持 stored 与 deflate 两种方式 */
export function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // 找 EOCD：末尾最多 64KB + 22
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 65558; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip / docx 文件（找不到中央目录）')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const dec = new TextDecoder()

  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break
    const method = dv.getUint16(p + 10, true)
    const compSize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const cmtLen = dv.getUint16(p + 32, true)
    const localOff = dv.getUint32(p + 42, true)
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen))

    // 本地头里的 extra 长度可能和中央目录不同，必须重新读
    const lNameLen = dv.getUint16(localOff + 26, true)
    const lExtraLen = dv.getUint16(localOff + 28, true)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const raw = bytes.subarray(dataStart, dataStart + compSize)
    out.set(name, method === 8 ? inflateRaw(new Uint8Array(raw)) : new Uint8Array(raw))
    p += 46 + nameLen + extraLen + cmtLen
  }
  return out
}

/* ============================================================
   二、Markdown → Word
   ============================================================ */

const xmlEsc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // XML 1.0 不允许的控制字符：留着会让 Word 报「文件已损坏」
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')

/**
 * 段落内解析：加粗 / 斜体 / 行内代码 / 链接 → w:r。
 *
 * 链接要摘出来换成占位符再换回去，中间那一步不能省 ——
 * 链接文字里的 **bold** 会和外层的 **bold** 配对错，出来的结构是乱的。
 *
 * 占位符用 **私用区** 字符 \uE000 / \uE001 夹序号，有两个原因：
 *  ① 不用空格/数字 —— 一开始写成「空格 + 序号 + 空格」，
 *     正文里真写了「见 3 号文档」就被当成占位符替换掉了；
 *  ② 不用控制字符 —— \u0000 / \u0001 会被下面的 xmlEsc 清掉
 *     （XML 1.0 确实禁止它们出现在正文里），占位符活不到换回来那一步，
 *     结果是链接**整段消失**，而表面上看不出任何异常。
 *     私用区字符是合法 XML 字符，又能保证不出现在真实文档里。
 */
const PH_OPEN = '\uE000'
const PH_CLOSE = '\uE001'

function runs(text: string): string {
  const stash: string[] = []
  const s = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, url: string) => {
    stash.push(`<w:hyperlink r:id="rIdLink${stash.length}"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t xml:space="preserve">${xmlEsc(label)}</w:t></w:r></w:hyperlink>`)
    return `${PH_OPEN}${stash.length - 1}${PH_CLOSE}`
  })

  const tokens = s.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g).filter((t) => t !== '')
  const body = tokens.map((t) => {
    if (t.startsWith('`') && t.endsWith('`') && t.length > 1) {
      return `<w:r><w:rPr><w:rStyle w:val="CodeChar"/></w:rPr><w:t xml:space="preserve">${xmlEsc(t.slice(1, -1))}</w:t></w:r>`
    }
    if (t.startsWith('**') && t.endsWith('**') && t.length > 3) {
      return `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${xmlEsc(t.slice(2, -2))}</w:t></w:r>`
    }
    if (t.startsWith('*') && t.endsWith('*') && t.length > 2) {
      return `<w:r><w:rPr><w:i/></w:rPr><w:t xml:space="preserve">${xmlEsc(t.slice(1, -1))}</w:t></w:r>`
    }
    return `<w:r><w:t xml:space="preserve">${xmlEsc(t)}</w:t></w:r>`
  }).join('')

  // 把占位符换回真正的 hyperlink
  const re = new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, 'g')
  return body.replace(re, (_m, i: string) => stash[Number(i)] || '')
}

const para = (text: string, style?: string, extra = '') => {
  // style 与 extra 只要有值就生成 pPr。
  // 「只有 extra」这个分支目前没有调用点（代码块重构后改成传 style 了），
  // 但留着是对的：它写在这里是为了让「传了 extra 却被整段丢掉」不可能发生。
  // 这一点必须说清楚 —— 留着一条**没有测试覆盖**的分支，
  // 比假装它被验过要诚实。
  const pPr = style || extra ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${extra}</w:pPr>` : ''
  return `<w:p>${pPr}${runs(text)}</w:p>`
}

/** 把 Markdown 正文编成 word/document.xml 的 w:body */
function bodyToXml(title: string, body: string): { xml: string; links: string[] } {
  const out: string[] = []
  const links: string[] = []
  const lines = body.split('\n')
  let codeBuf: string[] | null = null
  let tableBuf: string[][] = []

  const flushCode = () => {
    if (!codeBuf) return
    // 整段代码 = **一个** 段落，里面多个 run（用 <w:br/> 换行）。
    // 一开始写成「遇到 ``` 就 </w:p>，之后每行往外面塞 <w:r>」——
    // 那是把 run 放到段落外面，XML 结构是坏的，Word 会报文件损坏。
    out.push(para('', 'CodeBlock').replace('<w:p>', '<w:p>').replace(/<\/w:p>$/, '') +
      codeBuf.map((l, i) => (i ? '<w:r><w:br/></w:r>' : '') + `<w:r><w:t xml:space="preserve">${xmlEsc(l)}</w:t></w:r>`).join('') +
      '</w:p>')
    codeBuf = null
  }

  const flushTable = () => {
    if (!tableBuf.length) return
    const [head, ...rest] = tableBuf
    const cell = (t: string, tag: string) => `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${runs(t)}</w:p></w:tc>`
    out.push(
      `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr>` +
      `<w:tr>${head.map((c) => cell(c, 'th')).join('')}</w:tr>` +
      rest.map((r) => `<w:tr>${r.map((c) => cell(c, 'td')).join('')}</w:tr>`).join('') +
      `</w:tbl>`,
    )
    tableBuf = []
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const t = line.trim()

    if (t.startsWith('```')) {
      flushTable()
      if (codeBuf) flushCode()
      else codeBuf = []
      continue
    }
    if (codeBuf) { codeBuf.push(line); continue }

    if (t.startsWith('|') && t.endsWith('|')) {
      if (/^[\s:|-]+$/.test(t)) continue
      tableBuf.push(t.slice(1, -1).split('|').map((c) => c.trim()))
      continue
    }
    flushTable()

    if (!t) continue

    const h = t.match(/^(#{1,6})\s+(.*)$/)
    if (h) { out.push(para(h[2], `Heading${Math.min(h[1].length, 6)}`)); continue }
    if (/^(-{3,}|\*{3,})$/.test(t)) { out.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>'); continue }
    if (/^>\s?/.test(line)) { out.push(para(line.replace(/^>\s?/, ''), 'Quote')); continue }

    const todo = t.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/)
    if (todo) {
      const box = todo[1].toLowerCase() === 'x' ? '☑ ' : '☐ '
      out.push(para(box + todo[2], 'ListParagraph')); continue
    }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/)
    if (ul) { out.push(para('• ' + ul[1], 'ListParagraph')); continue }
    const ol = line.match(/^\s*\d+\.\s+(.*)$/)
    if (ol) { out.push(para(ol[1], 'ListParagraph', '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>')); continue }

    out.push(para(t))
  }
  flushTable()
  // 文档结尾的代码段没有收尾的 ``` ：照样要落成段落，不能把 XML 留在半开状态
  flushCode()

  // 收集外链（w:hyperlink 需要在 document.xml.rels 里登记）
  for (const m of body.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g)) links.push(m[2])

  return {
    xml:
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>` +
      (title ? para(title, 'Title') : '') +
      out.join('') +
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>` +
      `</w:body></w:document>`,
    links,
  }
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="Microsoft YaHei" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading6"><w:name w:val="heading 6"/><w:rPr><w:b/><w:i/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:pPr><w:ind w:left="480"/></w:pPr><w:rPr><w:i/><w:color w:val="666666"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:pPr><w:ind w:left="420"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:pPr><w:shd w:val="clear" w:fill="F5F5F5"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:fill="F0F0F0"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0A7CFF"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>
<w:top w:val="single" w:sz="4" w:color="BFBFBF"/><w:left w:val="single" w:sz="4" w:color="BFBFBF"/>
<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/><w:right w:val="single" w:sz="4" w:color="BFBFBF"/>
<w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/><w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>
</w:tblBorders></w:tblPr></w:style>
<w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
</w:styles>`

const NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`

/** 生成一个 .docx 的字节 */
export function buildDocx(title: string, body: string): Uint8Array {
  const { xml, links } = bodyToXml(title, body)

  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` +
    links.map((u, i) => `<Relationship Id="rIdLink${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEsc(u)}" TargetMode="External"/>`).join('') +
    `</Relationships>`

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
    `</Types>`

  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`

  return zip([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rootRels) },
    { name: 'word/document.xml', data: enc.encode(xml) },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(rels) },
    { name: 'word/styles.xml', data: enc.encode(STYLES_XML) },
    { name: 'word/numbering.xml', data: enc.encode(NUMBERING_XML) },
  ])
}

/* ============================================================
   三、Word → Markdown（导入）
   ============================================================ */

/**
 * 解析 word/document.xml，转回 Markdown。
 *
 * 走的是「结构 → 块」的还原，不是逐字符扒标签 ——
 * 段落属性（w:pStyle）决定它是标题几级还是引用，
 * 列表编号（w:numPr）决定它是有序还是无序。
 * 只扒 w:t 会把所有东西糊成一大段，那不是导入，是丢数据。
 */
export function readDocx(bytes: Uint8Array): { title: string; markdown: string } {
  const files = unzip(bytes)
  const doc = files.get('word/document.xml')
  if (!doc) throw new Error('这不是 Word 文档：里面没有 word/document.xml')
  const xml = new TextDecoder().decode(doc)

  // 标题 = 第一个 Title 或 Heading1 段落的文字
  const paragraphs = [...xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g)].map((m) => m[0])
  const rows: string[] = []
  let title = ''

  for (const p of paragraphs) {
    const style = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] || ''
    const numId = /<w:numId w:val="([^"]+)"/.exec(p)?.[1]
    // 段落内文字：把 w:t 拼起来，w:tab / w:br 转成可读的符号
    const text = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((m) => unescapeXml(m[1]))
      .join('')
      .replace(/\u0000/g, ' ')

    if (!text.trim() && !/<w:br/.test(p)) { rows.push(''); continue }

    if (/^(Title|Heading1)$/.test(style) && !title) { title = text.trim(); continue }

    if (/^Heading([1-6])$/.test(style)) { rows.push('#'.repeat(Number(style.slice(7))) + ' ' + text.trim()); continue }
    if (style === 'Quote') { rows.push('> ' + text.trim()); continue }
    if (numId) { rows.push('1. ' + text.trim()); continue }
    if (style === 'ListParagraph' || /^\s*•/.test(text)) { rows.push('- ' + text.replace(/^\s*•\s*/, '')); continue }
    if (style === 'CodeBlock') { rows.push('```'); rows.push(text); rows.push('```'); continue }
    rows.push(text)
  }

  // 表格：w:tbl 逐行逐格
  for (const t of [...xml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)].map((m) => m[0])) {
    const trs = [...t.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)].map((m) => m[0])
    const lines = trs.map((tr) =>
      '| ' + [...tr.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)].map((m) =>
        [...m[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((x) => unescapeXml(x[1])).join('').trim(),
      ).join(' | ') + ' |',
    )
    if (lines.length >= 1) {
      rows.push(lines[0])
      rows.push('| ' + lines[0].split('|').slice(1, -1).map(() => '---').join(' | ') + ' |')
      rows.push(...lines.slice(1))
    }
  }

  return { title, markdown: rows.join('\n').replace(/\n{3,}/g, '\n\n').trim() }
}

function unescapeXml(s: string): string {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}
