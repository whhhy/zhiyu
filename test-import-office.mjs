/*
 * zip / Excel / CSV 导入（2026-10-16）
 *
 * 语雀官方《如何导入导出知识库》的导入清单里有 Word / Excel / Markdown /
 * zip / Evernote。这一轮补的是 **zip** 和 **Excel/CSV** 两项。
 *
 * 这里刻意**造真实的字节**（一个真 xlsx、一个真 zip）去跑，
 * 而不是只测几个字符串函数 ——
 * 「能解析我们自己造的输入」和「能解析 Excel 存出来的文件」是两件事，
 * 而后者才是用户会遇到的那种。
 */
import { deflateRawSync, crc32 } from 'node:zlib'

let pass = 0, fail = 0
const ok = (c, l, e = '') => { if (c) { pass++; console.log(`  PASS  ${l}`) } else { fail++; console.log(`  FAIL  ${l} ${e}`) } }

/* ---------------- 造一个真的 zip ---------------- */
function crc32Of(buf) {
  return crc32 ? (crc32(buf) >>> 0) : 0
}
function zipOf(files) {
  const parts = []
  const central = []
  let offset = 0
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32Of(data)
    const comp = deflateRawSync(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 6); local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28)
    parts.push(local, nameBuf, comp)

    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0)
    cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(8, 8); cen.writeUInt16LE(8, 10)
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0, 14)
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cen, nameBuf]))
    offset += local.length + nameBuf.length + comp.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...parts, cd, end]))
}

const xml = (s) => Buffer.from(s, 'utf8')

function xlsxOf(sheets) {
  const files = []
  files.push({ name: '[Content_Types].xml', data: xml('<Types/>') })
  files.push({ name: 'xl/workbook.xml', data: xml(
    `<workbook><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`) })
  /*
   * ⚠️ 共享字符串表是**所有工作表的并集**，而单元格里的 `<v>` 是它的下标。
   * 所以下标必须按并集取 —— 第一版按「每个表各自的 shared」取下标，
   * 造出来的文件里第二个表的 0/1/2 指到了第一个表的字符串，
   * 于是读出来是「周报」里装着「需求编号」。
   * （解析器是对的，是这份假 xlsx 自己不自洽。）
   */
  const uniq = [...new Set(sheets.flatMap((s) => s.rows.flat()))]
  sheets.forEach((s, i) => {
    const rows = s.rows.map((r, ri) => {
      const cells = r.map((v, ci) => {
        const ref = String.fromCharCode(65 + ci) + (ri + 1)
        if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`
        return `<c r="${ref}" t="s"><v>${uniq.indexOf(v)}</v></c>`
      }).join('')
      return `<row r="${ri + 1}">${cells}</row>`
    }).join('')
    files.push({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: xml(`<worksheet><sheetData>${rows}</sheetData></worksheet>`),
    })
  })
  files.push({
    name: 'xl/sharedStrings.xml',
    data: xml(`<sst>${uniq.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`),
  })
  return zipOf(files)
}

const { zipToImportFiles, readXlsx, parseCsv, parseCsvLine, sheetDataFromRows, isSpreadsheetName, decodeCsvBytes } =
  await import('./src/lib/import-office.ts')

/* ---------------- CSV ---------------- */
console.log('\n== CSV ==')
{
  ok(parseCsvLine('a,b,c').join('|') === 'a|b|c', '最基本的分隔')
  ok(parseCsvLine('a,"b,c",d').join('|') === 'a|b,c|d', '引号里的逗号不算分隔')
  ok(parseCsvLine('"他说""你好"""').join('|') === '他说"你好"', '"" 转义成一个引号')
  ok(parseCsvLine('a,,b').length === 3, '空字段保留位置（否则列会错位）')

  const rows = parseCsv('姓名,年龄\n张三,30\n李四,25\n')
  ok(rows.length === 3, `表头 + 两行 = 3 行（实得 ${rows.length}）`)
  ok(rows[0][0] === '姓名' && rows[1][1] === '30', '中文表头与数字都对', JSON.stringify(rows))
  let emptyErr = ''
  try { parseCsv('\n\n') } catch (e) { emptyErr = e?.message || '' }
  ok(emptyErr.includes('没有数据'), '全空文件明确报错，而不是静默产出一张空表', emptyErr)
}

/* ---------------- xlsx ---------------- */
console.log('\n== xlsx（用真实字节）==')
{
  const shared1 = ['需求编号', '需求名称', '负责人', 'REQ-001', '登录改造', '周砚', 'REQ-002', '导出 PDF', '苏晚']
  const bytes = xlsxOf([
    { name: '需求列表', shared: shared1, rows: [
      ['需求编号', '需求名称', '负责人'],
      ['REQ-001', '登录改造', '周砚'],
      ['REQ-002', '导出 PDF', '苏晚'],
    ] },
    { name: '周报', shared: ['周次', '完成', '下周'], rows: [
      ['周次', '完成', '下周'],
      ['第 1 周', 12, '导入 Excel'],
    ] },
  ])

  const sheets = await readXlsx(bytes)
  ok(sheets.length === 2, `两个工作表都读出来了（实得 ${sheets.length}）`)
  ok(sheets[0].name === '需求列表', '工作表名字来自 workbook.xml', sheets[0] && sheets[0].name)
  ok(sheets[1].name === '周报', '第二个工作表的名字也对', sheets[1] && sheets[1].name)
  ok(sheets[0].rows.length === 3, `第一张表三行（实得 ${sheets[0] && sheets[0].rows.length}）`)
  ok(JSON.stringify(sheets[0].rows[0]) === JSON.stringify(['需求编号', '需求名称', '负责人']),
    '中文表头经共享字符串表还原', JSON.stringify(sheets[0] && sheets[0].rows[0]))
  ok(sheets[0].rows[1][0] === 'REQ-001' && sheets[0].rows[1][2] === '周砚',
    '数据行也对得上', JSON.stringify(sheets[0] && sheets[0].rows[1]))
  ok(sheets[1] && sheets[1].rows[1] && sheets[1].rows[1][1] === '12',
    '数字单元格是字符串形态（表格里显示什么就是什么）',
    JSON.stringify(sheets[1]))

  const single = await readXlsx(xlsxOf([{ name: '只有一张', shared: ['列A', '值1'], rows: [['列A'], ['值1']] }]))
  ok(single.length === 1 && single[0].name === '只有一张', '单工作表也正常')

  let threw = ''
  try { await readXlsx(new Uint8Array([1, 2, 3, 4])) } catch (e) { threw = e?.message || '' }
  ok(threw.includes('ZIP') || threw.includes('ZIP') || threw.length > 0, '不是 xlsx 时明确报错而不是返回空', threw)
}

/* ---------------- sheetData 组装 ---------------- */
console.log('\n== 表格数据组装 ==')
{
  const sd = sheetDataFromRows('需求列表', [['编号', '名称'], ['A1', '甲'], ['A2', '乙']])
  ok(sd.cols.length === 2 && sd.cols[0].name === '编号', '第一行当表头')
  ok(sd.rows.length === 2, '表头不算进数据行（实得 ' + sd.rows.length + '）')
  ok(sd.rows[0][0].v === 'A1' && sd.rows[1][1].v === '乙', '单元格值落位正确', JSON.stringify(sd.rows))

  const ragged = sheetDataFromRows('S', [['a', 'b', 'c'], ['1']])
  ok(ragged.rows[0].length === 3, '短行补齐到与表头同宽（否则列错位）', String(ragged.rows[0].length))
}

console.log('\n== 文件名判定 ==')
{
  ok(isSpreadsheetName('a.xlsx') && isSpreadsheetName('A.CSV'), '.xlsx / .csv 收')
  ok(!isSpreadsheetName('a.xls') && !isSpreadsheetName('a.doc'), '.xls / .doc 不收（界面上已写明不支持）')
}

/* ---------------- zip ---------------- */
console.log('\n== zip（用真实字节）==')
{
  const zip = zipOf([
    { name: '手册/接入/SSO.md', data: Buffer.from('# SSO 接入\n\n正文', 'utf8') },
    { name: '手册/总览.md', data: Buffer.from('# 总览', 'utf8') },
    { name: '手册/img/a.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    { name: '手册/notes.txt', data: Buffer.from('随手记', 'utf8') },
  ])
  const { files, skipped } = await zipToImportFiles(zip)
  ok(files.length === 3, `包里的 .md/.txt 都读出来了（实得 ${files.length}）`, JSON.stringify(files.map((f) => f.name)))
  ok(files.some((f) => f.webkitRelativePath === '手册/接入/SSO.md'), '保留了包内目录结构（决定导入后的层级）')
  ok(files.find((f) => f.webkitRelativePath === '手册/接入/SSO.md')?.text.includes('SSO'), '中文正文没乱码')
  const imgSkip = skipped.find((s) => s.reason.includes('图片'))
  ok(!!imgSkip, '包里的图片被明确报出来（不假装会跟着进来）', JSON.stringify(skipped))
  ok(skipped.length === 1, '只跳过了图片那一个', JSON.stringify(skipped.map((s) => s.name)))

  let threw = ''
  try { await zipToImportFiles(new Uint8Array([9, 9, 9])) } catch (e) { threw = e?.message || '' }
  ok(threw.includes('ZIP'), '不是 zip 时明确报错', threw)

  const gbk = Buffer.concat([Buffer.from([0xd0, 0xd5, 0xcc, 0xec]), Buffer.from('姓名', 'utf8')])
  ok(typeof decodeCsvBytes(new Uint8Array(gbk)) === 'string', 'decodeCsvBytes 对非 UTF-8 不崩')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
