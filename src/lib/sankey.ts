/* ============================================================
   Mermaid `sankey-beta`（桑基图）→ 原生 SVG
   ------------------------------------------------------------
   为什么做：11 种「认得出但没做」的图种里，桑基图是**公司文档里真的
   会出现**的那一类（资源流向、预算分配、订单来源、用户来源）。
   它结构上也最省：一堆带权重的有向边，没有环上的布局难题 ——
   按「最长路径深度」分列，列内堆叠，宽度按流量缩放。

   ⚠️ 宽度是**语义本身**：一条带宽两倍就表示流量两倍。
      所以缩放必须是**全局单一系数**（value → px），
      绝不能每条边各自归一化 —— 那样「A 比 B 大」这个信息就整个丢了。

   ⚠️ 有**环**时最长路径会发散。第一版按 DFS 求最长路径，
      遇到环直接死循环；现在先按拓扑剥（入度 0 起算），
      剥不掉的（真在环里的）**如实在 skipped 里说**，不假装能算。

   语法：
       sankey-beta
       收入,成本,40
       成本,人力,25
       成本,房租,15
   ============================================================ */

export interface SankeyNode { id: string; rank: number; y: number; h: number; inTotal: number; outTotal: number }
export interface SankeyLink { from: string; to: string; value: number }

export interface Sankey {
  nodes: SankeyNode[]
  links: SankeyLink[]
  /** `title 行`（可省） */
  title: string
  /** 没法处理的写法，界面上如实说 */
  skipped: string[]
  /** 参与布局的最大层数 */
  depth: number
}

const NODE_W = 13
const RANK_GAP = 74
const NODE_GAP = 12
const PAD = 18
const TITLE_H = 24

export function parseSankey(src: string): Sankey {
  const out: Sankey = { nodes: [], links: [], title: '', skipped: [], depth: 0 }
  const byId = new Map<string, SankeyNode>()
  const links: SankeyLink[] = []

  for (const raw of String(src || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    if (/^sankey(-beta)?\b/i.test(line)) continue
    const t = /^title\s+(.+)$/i.exec(line)
    if (t) { out.title = t[1].trim(); continue }

    /* `A,B,10` —— 节点名里可以带逗号，所以**不能简单 split(',')**：
       真实来源里有 `华东,大区,销售,40` 这种。做法是从两端往里找
       「最后一个逗号后是纯数字」和「第一个逗号」，把中间的当节点名。 */
    const m = /^(.*),([^,]*),(-?\d+(?:\.\d+)?)$/.exec(line)
    if (!m) { out.skipped.push(line.slice(0, 40)); continue }
    const from = unquote(m[1].trim())
    const to = unquote(m[2].trim())
    const value = Number(m[3])
    if (!from || !to) { out.skipped.push(line.slice(0, 40)); continue }
    /* ⚠️ 负权重画出来是一条**方向相反、宽度却为正**的带子 ——
       那是在说谎。直接拒掉并报出来。 */
    if (!(value > 0)) { out.skipped.push(`${from} → ${to}：权重 ${m[3]} 不是正数，画不了`); continue }

    for (const id of [from, to]) if (!byId.has(id)) byId.set(id, { id, rank: 0, y: 0, h: 0, inTotal: 0, outTotal: 0 })
    links.push({ from, to, value })
  }

  if (!links.length) return out

  /* 汇总每个节点的进出总量 —— 节点高度按「通过的总量」缩放 */
  for (const l of links) {
    byId.get(l.from)!.outTotal += l.value
    byId.get(l.to)!.inTotal += l.value
  }

  const nodes = [...byId.values()]
  assignRanks(nodes, links, out)
  const maxV = Math.max(...nodes.map((n) => Math.max(n.inTotal, n.outTotal)), 1)
  const H = 15                                  // 满流量节点的像素高度
  for (const n of nodes) n.h = Math.max(5, (Math.max(n.inTotal, n.outTotal) / maxV) * H)

  /* 列内堆叠：按节点名排序（可预期，不随遍历抖动），列高不足时等比压缩 */
  const byRank = new Map<number, SankeyNode[]>()
  for (const n of nodes) {
    const l = byRank.get(n.rank) || []
    l.push(n)
    byRank.set(n.rank, l)
  }
  let maxStack = 0
  for (const [, list] of byRank) {
    list.sort((a, b) => a.id.localeCompare(b.id))
    maxStack = Math.max(maxStack, list.reduce((a, n) => a + n.h, 0) + (list.length - 1) * NODE_GAP)
  }
  out.depth = Math.max(...nodes.map((n) => n.rank), 0)
  for (const [, list] of byRank) {
    const total = list.reduce((a, n) => a + n.h, 0) + (list.length - 1) * NODE_GAP
    let y = (maxStack - total) / 2
    for (const n of list) { n.y = y; y += n.h + NODE_GAP }
  }

  out.nodes = nodes
  out.links = links
  return out
}

function unquote(s: string): string {
  return s.replace(/^["']|["']$/g, '').trim()
}

/**
 * 按「从源头出发的最长路径」分列。
 * 先反复剥掉**入度为 0** 的节点（拓扑），剩下的就是**真在环里的**——
 * 那些不参与分列（rank 留 0）并如实报出来，而不是假装能算。
 */
function assignRanks(nodes: SankeyNode[], links: SankeyLink[], out: Sankey): void {
  const indeg = new Map<string, number>()
  const next = new Map<string, SankeyLink[]>()
  for (const n of nodes) { indeg.set(n.id, 0); next.set(n.id, []) }
  for (const l of links) {
    indeg.set(l.to, (indeg.get(l.to) || 0) + 1)
    next.get(l.from)?.push(l)
  }

  const rank = new Map<string, number>()
  const peeled = new Set<string>()
  const q: string[] = []
  for (const n of nodes) if ((indeg.get(n.id) || 0) === 0) q.push(n.id)

  while (q.length) {
    const cur = q.shift()!
    peeled.add(cur)
    for (const l of next.get(cur) || []) {
      rank.set(l.to, Math.max(rank.get(l.to) ?? 0, (rank.get(cur) ?? 0) + 1))
      indeg.set(l.to, (indeg.get(l.to) || 1) - 1)
      if ((indeg.get(l.to) || 0) === 0) q.push(l.to)
    }
  }

  const stuck = nodes.filter((n) => !peeled.has(n.id))
  if (stuck.length) {
    out.skipped.push(
      `${stuck.length} 个节点处在**环里**（A→B→A 这种），桑基图的列次算不出来` +
      `（涉及：${stuck.slice(0, 3).map((n) => n.id).join('、')}${stuck.length > 3 ? '…' : ''}）；` +
      `这些连线按原始方向画，不参与分列`
    )
  }
  for (const n of nodes) n.rank = rank.get(n.id) ?? 0
}

/* ---------------- 渲染 ---------------- */

const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function textPx(s: string, size: number): number {
  let w = 0
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0) || 0
    w += cp > 0xffff || /[\u2e80-\uffff]/.test(ch) ? size : size * 0.56
  }
  return w
}

export function renderSankeySvg(s: Sankey): string {
  if (!s.nodes.length || !s.links.length) return ''
  const title = s.title
  const top = PAD + (title ? TITLE_H : 0)
  const H = Math.ceil(top + Math.max(...s.nodes.map((n) => n.y + n.h)) + PAD)
  const W = Math.ceil(PAD * 2 + s.depth * RANK_GAP + NODE_W + Math.max(40, Math.max(...s.nodes.map((n) => textPx(n.id, 11)))))

  /* ⚠️ 带宽是**语义**（流量两倍 → 带宽两倍），所以全局共用一个系数 */
  const maxV = Math.max(...s.links.map((l) => l.value), 1)
  const band = (v: number) => Math.max(1.5, (v / maxV) * 22)
  const at = (id: string) => s.nodes.find((n) => n.id === id)!
  const nodeX = (n: SankeyNode) => PAD + n.rank * RANK_GAP
  const nodeCY = (n: SankeyNode) => top + n.y + n.h / 2

  const parts: string[] = []
  if (title) parts.push(`<text x="${PAD}" y="${PAD + 12}" class="yq-sk-title">${esc(title)}</text>`)

  /* 带子在**节点下面**，否则宽带子会把节点框盖住 */
  for (const l of s.links) {
    const a = at(l.from), b = at(l.to)
    const x1 = nodeX(a) + NODE_W, y1 = nodeCY(a)
    const x2 = nodeX(b), y2 = nodeCY(b)
    const midX = (x1 + x2) / 2
    parts.push(
      `<path d="M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}" fill="none" ` +
      `class="yq-sk-band" stroke-width="${band(l.value).toFixed(2)}"/>`
    )
  }
  for (const n of s.nodes) {
    const x = nodeX(n)
    parts.push(`<rect x="${x}" y="${top + n.y}" width="${NODE_W}" height="${n.h.toFixed(1)}" rx="2" class="yq-sk-node"/>`)
    /* 标签放节点**右侧**：列越靠后节点右边越挤，放左边更稳 */
    parts.push(
      `<text x="${x + NODE_W + 6}" y="${nodeCY(n)}" dominant-baseline="middle" class="yq-sk-label">` +
      `${esc(n.id.length > 10 ? n.id.slice(0, 9) + '…' : n.id)}</text>`
    )
  }

  return `<svg class="yq-sk-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="桑基图">` +
    parts.join('') + `</svg>`
}

export function isSankeySource(src: string): boolean {
  return /^sankey(-beta)?\b/i.test(
    String(src || '').split('\n').find((l) => l.trim() && !l.trim().startsWith('%%'))?.trim() || ''
  )
}