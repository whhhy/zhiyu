/**
 * 纯 TypeScript 的 DEFLATE 解压（RFC 1951）。
 *
 * ============================================================
 * 为什么不用 node:zlib
 * ------------------------------------------------------------
 * `src/` 是浏览器代码，没有 node 的类型声明，打包器也不该把 node:zlib
 * 塞进前端产物 —— importDocx 是**真的在浏览器里跑**的。
 *
 * 而只支持「存储」方式也不行：Word 存出来的 .docx 一定是 deflate 的，
 * 只认 stored 的话导入对真实文件**必然失败** ——
 * 那就是一个「界面上看着能用、实际永远失败」的功能，比没有更糟。
 *
 * 所以这里实现解压。范围只到 RFC 1951 需要的部分：
 * 存储块 / 固定 Huffman / 动态 Huffman。写它是因为
 * 「用 node:zlib 写测试、用纯 TS 跑实现」这件事能验出它真的对 ——
 * 测试端用 zlib 造出真实的压缩流喂进来。
 * ============================================================ */

/** 按位读的小工具：位序是 LSB 先行，跨字节 */
class BitReader {
  private d: Uint8Array
  private pos = 0
  private bitBuf = 0
  private bitCnt = 0
  // 写成显式字段而不是 TS 的参数属性（constructor(private readonly d: …)）——
  // Node 的 strip-only 模式不支持那种语法，本文件要能在纯 Node 里被直接 import。
  constructor(d: Uint8Array) { this.d = d }

  bits(n: number): number {
    while (this.bitCnt < n) {
      if (this.pos >= this.d.length) throw new Error('压缩数据提前结束')
      this.bitBuf |= this.d[this.pos++] << this.bitCnt
      this.bitCnt += 8
    }
    const v = this.bitBuf & ((1 << n) - 1)
    this.bitBuf >>>= n
    this.bitCnt -= n
    return v
  }

  /** 丢掉当前字节剩下的位，回到字节边界 */
  align() {
    this.bitBuf = 0
    this.bitCnt = 0
  }

  /** 存储块要用：一次读 3 个头字节再接原始数据 */
  bytes(n: number): Uint8Array {
    const out = this.d.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  atEnd(): boolean { return this.pos >= this.d.length && this.bitCnt === 0 }
}

/** 由码长表建一棵规范 Huffman 解码表（count / symbol 两张表） */
function buildHuffman(lengths: number[]): { counts: number[]; symbols: number[] } {
  const MAXBITS = 15
  const counts = new Array(MAXBITS + 1).fill(0)
  for (const l of lengths) counts[l]++
  counts[0] = 0                      // 码长 0 的符号不参与解码

  /**
   * offsets[l] = 「码长恰好是 l 的第一个符号」在 symbols 里的下标。
   * 注意别写成 offsets[l+1] —— 我一开始就这么写的，
   * 于是每种码长的符号整体后移了 counts[1] 个位置，
   * 表现是解到一半报「压缩数据提前结束」，而且只在**动态块**上炸（固定块的码长对称，错位没露出来）。
   */
  const offsets = new Array(MAXBITS + 2).fill(0)
  for (let i = 1; i < MAXBITS; i++) offsets[i + 1] = offsets[i] + counts[i]

  const symbols = new Array(lengths.length).fill(0)
  for (let sym = 0; sym < lengths.length; sym++) {
    if (lengths[sym]) symbols[offsets[lengths[sym]]++] = sym
  }
  return { counts, symbols }
}

function decodeSymbol(br: BitReader, h: { counts: number[]; symbols: number[] }): number {
  let code = 0, first = 0, index = 0
  for (let len = 1; len <= 15; len++) {
    code |= br.bits(1)
    const count = h.counts[len]
    if (code - first < count) return h.symbols[index + (code - first)]
    index += count
    first = (first + count) << 1
    code <<= 1
  }
  throw new Error('非法的 Huffman 码')
}

// 长度码 → 实际长度
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
// 距离码 → 实际距离
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
// 码长顺序：动态块的 code length alphabet
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]

/** 解压一个 raw deflate 流 */
export function inflateRaw(data: Uint8Array): Uint8Array {
  const br = new BitReader(data)
  const out: number[] = []
  const LIMIT = 1 << 26   // 64MB 上限：解压炸弹不该把标签页拖死

  for (;;) {
    const last = br.bits(1)
    const type = br.bits(2)

    if (type === 0) {
      // 存储块：头是一个 16 位的长度和它的补码，必须按字节读，
      // 所以先把位缓冲里剩下的位丢掉
      br.align()
      const lenBytes = br.bytes(2)
      const nlenBytes = br.bytes(2)
      if (nlenBytes[0] !== (lenBytes[0] ^ 0xff) || nlenBytes[1] !== (lenBytes[1] ^ 0xff)) {
        throw new Error('存储块的长度校验不过')
      }
      const n = lenBytes[0] | (lenBytes[1] << 8)
      for (const b of br.bytes(n)) out.push(b)
    } else if (type === 1 || type === 2) {
      let lit: { counts: number[]; symbols: number[] }
      let dist: { counts: number[]; symbols: number[] }
      if (type === 1) {
        const ll = new Array(288)
        for (let i = 0; i < 144; i++) ll[i] = 8
        for (let i = 144; i < 256; i++) ll[i] = 9
        for (let i = 256; i < 280; i++) ll[i] = 7
        for (let i = 280; i < 288; i++) ll[i] = 8
        lit = buildHuffman(ll)
        dist = buildHuffman(new Array(30).fill(5))
      } else {
        const hlit = br.bits(5) + 257
        const hdist = br.bits(5) + 1
        const hclen = br.bits(4) + 4
        const clens = new Array(19).fill(0)
        for (let i = 0; i < hclen; i++) clens[CLEN_ORDER[i]] = br.bits(3)
        const clHuff = buildHuffman(clens)
        const lens: number[] = []
        while (lens.length < hlit + hdist) {
          const sym = decodeSymbol(br, clHuff)
          if (sym < 16) { lens.push(sym); continue }
          if (sym === 16) {
            if (!lens.length) throw new Error('码长重复指令出现在第一个位置')
            const prev = lens[lens.length - 1]
            const rep = 3 + br.bits(2)
            for (let i = 0; i < rep; i++) lens.push(prev)
          } else if (sym === 17) {
            const rep = 3 + br.bits(3)
            for (let i = 0; i < rep; i++) lens.push(0)
          } else {
            const rep = 11 + br.bits(7)
            for (let i = 0; i < rep; i++) lens.push(0)
          }
        }
        if (lens.length > hlit + hdist) throw new Error('码长表比声明的长')
        lit = buildHuffman(lens.slice(0, hlit))
        dist = buildHuffman(lens.slice(hlit, hlit + hdist))
      }

      for (;;) {
        const sym = decodeSymbol(br, lit)
        if (sym < 256) { out.push(sym); if (out.length > LIMIT) throw new Error('解压结果超过 64MB，疑似压缩炸弹'); continue }
        if (sym === 256) break
        const li = sym - 257
        if (li >= LEN_BASE.length) throw new Error('非法的长度码 ' + sym)
        const length = LEN_BASE[li] + br.bits(LEN_EXTRA[li])
        const ds = decodeSymbol(br, dist)
        if (ds >= DIST_BASE.length) throw new Error('非法的距离码 ' + ds)
        const distance = DIST_BASE[ds] + br.bits(DIST_EXTRA[ds])
        if (distance > out.length) throw new Error('距离超出了已解出的长度（数据损坏）')
        let from = out.length - distance
        for (let i = 0; i < length; i++) out.push(out[from++])
        if (out.length > LIMIT) throw new Error('解压结果超过 64MB，疑似压缩炸弹')
      }
    } else {
      throw new Error('保留的块类型 3 出现在数据里（不是合法的 deflate）')
    }

    if (last) break
  }
  return new Uint8Array(out)
}
