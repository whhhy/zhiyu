/* ============================================================
   Mermaid `classDiagram`（类图）→ 原生 SVG
   ------------------------------------------------------------
   为什么这么做、为什么不画三角/菱形：

   UML 的关系符号（继承空心三角、组合实心菱形、聚合空心菱形）是
   **语义本身**。画错一个符号，读者读出来的关系就是错的 ——
   「B 继承 A」画成聚合，读代码的人会照着错的关系理解。
   这正是我在状态图复合态上踩过的坑：**宁可少画，也不要画个看着
   像那么回事的错东西**。

   所以这里：**类画得完整（隔层盒子 + 成员列表），关系画成普通连线，
   但线上标出关系类型文字**（继承 / 组合 / 聚合 / 关联 / 依赖 / 实现）。
   信息一点没丢，而且不会有人把虚线看成聚合、把实线看成关联。

   ⚠️ 分层**复用** flowchart 的 `assignLayers`（不重写 BFS），
   但节点绘制是自己写的 —— 一个隔层盒子画不出 flowchart 那种单行矩形。

   覆盖范围**如实标注**：
     · 支持 classDiagram / `class 名 { … }`（属性与方法混排）、
       `class 名` 单独声明、属性前缀（+ - # ~）与方法的 `()`、泛型 `~T~`
     · 六种关系：继承 `<|--`、实现 `..|>`、依赖 `..>`、关联 `-->`、
       聚合 `o--`、组合 `*--`，以及带基数与标签的 `"1" o-- "*" 名 : 说明`
   **不支持**：注解 `<<interface>>` 的**样式**（文字保留）、方向 `direction`、
     泛型参数的显示（原文里的 `~T~` 原样保留）、注释 `%%`（已忽略）。
     认不出来行进 `skipped`，界面上明说。
   ============================================================ */

import { assignLayers, type FlowEdge, type FlowNode } from './flowchart.ts'
import { firstMeaningfulLine } from './first-line.ts'
import { parseStyles, styleForNode, styleAttr, isClassAssign, CLASS_DEF_RE } from './diagram-style.ts'

export interface ClassDef {
  id: string
  /** `class 名` 后面那个显示名（带引号的会用引号里的） */
  label: string
  /** 属性 / 方法，按源码顺序 */
  rows: string[]
  /** `<<interface>>` 之类的注解文字（保留，不做样式） */
  annotation: string
  /** classDef 生成的、已校验转义的 style 属性串（` style="fill:#fee"`）；无则 undefined */
  style?: string
  /** classDef 的 `color`（文字色），单独挂在 text 上（fill 对 text 无效） */
  labelFill?: string
}

export type RelKind = '继承' | '实现' | '依赖' | '关联' | '聚合' | '组合'

export interface Relation {
  from: string
  to: string
  /**
   * 类图里是六种关系之一（`RelKind`）。
   * ⚠️ 类型是 `string` 而不是 `RelKind`，因为 **erDiagram 复用这套渲染**
   *    而它的「类型」是**基数文字**（`1 → 0..N`）——
   *    同样是「宁可标文字也不画可能画错的符号」的取舍。
   */
  kind: string
  /** 源码里 `: 说明` 那部分 */
  label: string
  /** `"1" o-- "*"` 里的两端基数 */
  fromCard: string
  toCard: string
  /**
   * 这条线要不要虚线。默认按 `kind` 判（依赖/实现虚线）。
   * erDiagram 复用这套渲染但语义不同（非识别关系是虚线），所以给它一个显式开关。
   */
  dashed?: boolean
}

export interface ClassDiagram {
  classes: ClassDef[]
  relations: Relation[]
  skipped: string[]
}

/**
 * 关系箭头 token → 关系类型。
 *
 * ⚠️ 顺序有讲究：`<|--`（继承三角）必须排在 `-->` 之前，
 *    否则 `<|--` 会被先当成「`<` + `-->`」拆开，认成关联。
 * ⚠️ 实现（`<|..` / `..|>`）是**虚线三角**，与继承（实线三角）**不是一回事**，
 *    混在一起会让读者以为「实现了抽象类」和「继承了父类」是一回事。
 *    第一版就把它们并进了继承，断言抓到了。
 */
function kindOf(token: string): RelKind | null {
  const t = String(token || '').trim()
  if (!t) return null
  if (/^<\|--$/.test(t) || /^<\|\{$/.test(t)) return '继承'
  if (/^<\|\.\.$/.test(t) || /^\.\.\|>$/.test(t)) return '实现'
  if (/^\.\.>$/.test(t)) return '依赖'
  if (/^o--$/.test(t) || /^o\{1,2\}$/.test(t)) return '聚合'
  if (/^\*--$/.test(t) || /^\*\{1,2\}$/.test(t)) return '组合'
  if (/^--?>?$/.test(t) || /^--{1,2}$/.test(t)) return '关联'
  return null
}

/* 基数：`"1"` / `1` / `*` / `o+` / `{a,b}` / 任意短词（mermaid 允许自定义）*/
const CARD = '("[^"]*"|\\d+|\\*+|o\\+|\\{[\\w,]*\\}|\\w+)'
/**
 * 关系整行的形状：`A ["1"] <token> ["*"] B : 说明`
 *
 * ⚠️ 六个捕获组：**基数那两组必须是捕获组**。
 *    第一版写成了 `(?:…)`（非捕获），结果 `rel[3]` 拿到的是**目标类名**
 *    而不是基数 —— 而 `kindOf(rel[2])` 因为 `rel[2]` 位置对不上而收到 `undefined`，
 *    整段解析在第一行就炸了。
 *    组号：1=from 2=fromCard 3=token 4=toCard 5=to 6=label
 */
const REL_RE = new RegExp(
  '^(\\S+)\\s*(?:' + CARD + '\\s+)?' +              // 1 = from
  '(<\\|--|<\\|\\.\\.|\\.\\.\\|>|<\\|\\{|\\.\\.>|o--|\\*--|--|-->|\\.\\.>|\\.\\.\\|>)' + // 3 = token
  '\\s*(?:' + CARD + '\\s+)?' +                    // 4 = toCard
  '(\\S+?)\\s*(?::\\s*(.*))?$'                     // 5 = to, 6 = label
)

/** `<<interface>>` 之类 */
const ANNOT = /<<\s*([^>]+?)\s*>>/

export function parseClassDiagram(src: string): ClassDiagram {
  const out: ClassDiagram = { classes: [], relations: [], skipped: [] }
  const byId = new Map<string, ClassDef>()
  let inBody: ClassDef | null = null
  /** namespace 的花括号深度 —— 只为了**吃掉它的收尾 `}`**，
   *  不然那一行会掉进 skipped，看起来像「有个写法不认识」，
   *  而实际上只是我没配对括号。 */
  let nsDepth = 0
  /** classDef / `class A,B name` 的行。
   *  ⚠️ 类图里 `class X`（**只有一个** token）是**声明一个类**，
   *     `class X,Y name` 才是挂样式 —— 两者必须分开，
   *     把声明当样式会「样式全丢」，反过来会「类全没了」。 */
  const styleLines: string[] = []

  const ensure = (id: string, label?: string, ann?: string): ClassDef => {
    let c = byId.get(id)
    if (!c) {
      c = { id, label: label || id, rows: [], annotation: ann || '' }
      byId.set(id, c)
      out.classes.push(c)
    } else {
      if (label) c.label = label
      if (ann) c.annotation = ann
    }
    return c
  }

  for (const raw of String(src || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    if (/^classDiagram\b/i.test(line)) continue
    /* `class A,B name` = 挂样式；`class A` / `class A {` / `class A <<interface>> {` = 声明，往下走。
       判据在 diagram-style.isClassAssign 里，三个图种共用一份。 */
    if (CLASS_DEF_RE.test(line) || isClassAssign(line)) { styleLines.push(line); continue }
    if (/^direction\b/i.test(line)) { out.skipped.push('direction（方向）未实现，按默认布局'); continue }
    if (/^namespace\b/i.test(line)) {
      out.skipped.push('namespace（命名空间）未实现，里面的类照常解析')
      if (line.includes('{')) nsDepth++
      continue
    }
    /* namespace 的收尾括号：吃掉，别报成「不认识的写法」 */
    if (nsDepth > 0 && line === '}') { nsDepth--; continue }

    /* 类体结束 */
    if (inBody && line === '}') { inBody = null; continue }

    /* `class 名 [<<注解>>] {` / `class 名 [<<注解>>]` / `class 名 {` */
    const decl = /^class\s+(.+?)\s*(<<[^>]+>>)?\s*(\{)?\s*$/.exec(line)
    if (decl) {
      const rawName = decl[1].trim()
      const ann = decl[2] ? ANNOT.exec(decl[2])?.[1] || '' : ''
      // `class 文档["显示名"]`
      const quoted = /^(\S+?)\s*\[\s*"([^"]+)"\s*\]$/.exec(rawName)
      const id = quoted ? quoted[1] : rawName
      const label = quoted ? quoted[2] : rawName
      const c = ensure(id, label, ann)
      if (decl[3]) inBody = c
      continue
    }

    /* 类体里的一行：属性或方法 */
    if (inBody) {
      const row = line.replace(/\s*:\s*.*$/, '').trim()      // 去掉 ` : 类型`
      if (row) inBody.rows.push(row)
      continue
    }

    /* 关系：`A "1" o-- "*" B : 说明` */
    const rel = REL_RE.exec(line)
    if (rel) {
      const kind = kindOf(rel[3])
      if (!kind) { out.skipped.push(line.slice(0, 50)); continue }
      const a = rel[1], b = rel[5]
      ensure(a); ensure(b)
      out.relations.push({
        /* `<|--` 的箭头指向**基类**，所以边的方向要反过来 */
        from: kind === '继承' ? b : a,
        to: kind === '继承' ? a : b,
        kind,
        label: (rel[6] || '').trim(),
        fromCard: (rel[2] || '').replace(/"/g, ''),
        toCard: (rel[4] || '').replace(/"/g, ''),
      })
      continue
    }

    out.skipped.push(line.slice(0, 50))
  }

  /* classDef → 类样式。放在最后：此时所有类（含被关系顺带 ensure 出来的）
     都已登记完，早做会给随后才出现的类漏掉样式。 */
  if (styleLines.length) {
    const parsed = parseStyles(styleLines.join('\n'))
    for (const c of out.classes) {
      const p = styleForNode(parsed, c.id)
      if (!p) continue
      c.style = styleAttr(p) || undefined
      c.labelFill = p.color ? String(p.color) : undefined
    }
    out.skipped.push(...parsed.problems)
  }
  return out
}

/** 一眼看出这份源码是不是类图 */
export function isClassDiagramSource(src: string): boolean {
  return /^classDiagram\b/i.test(firstMeaningfulLine(src))
}

/* ---------------- 渲染 ---------------- */

/* 相邻列的间距要放得下关系标注。
   ⚠️ 第一版 LEVEL_W=230 → 列间距只有 40px，而标注最宽 150px ——
   于是标注有一半压在盒子成员表上（浏览器上一看，「组合 · 历史」
   正好盖住 文档 的成员行）。宽度按「标注上限 + 两侧留白」给。 */
const LEVEL_W = 300
const HEAD_H = 26
const ROW_H = 18
const BOX_W = 190
const PAD = 20
const MAX_ROWS = 6
/** 标注最大宽度：**必须小于列间距**（LEVEL_W - BOX_W = 110），
 *  否则两端各溢出一点，蹭到相邻盒子的成员行上（浏览器实测：正好压到 +int rev）。
 *  想写长说明就用 : 说明 原样截断，宁可少字也不要盖住内容。 */
const REL_LABEL_W = 104

const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function textWidth(s: string, size: number): number {
  let w = 0
  for (const ch of String(s)) w += /[\u2e80-\uffff]/.test(ch) ? size : size * 0.56
  return w
}

function clip(s: string, size: number, maxW: number): string {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of String(s)) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out ? out + '…' : '…'
}

/** 盒子的高度**随成员行数变化** —— 写死高度会让长类名和成员表挤在一起。 */
function boxH(c: ClassDef) { return HEAD_H + Math.min(c.rows.length, MAX_ROWS) * ROW_H + 6 }

export function renderClassDiagramSvg(d: ClassDiagram): string {
  if (!d.classes.length) return ''

  /* 分层：把类图当成「类 = 点、关系 = 边」的有向图喂给 flowchart 的 BFS。
     ⚠️ 这里**必须**走 assignLayers —— 类与类之间几乎一定有**环**
     （A 依赖 B，B 又引用 A），而迭代松弛在环上永远不收敛。 */
  const nodes: FlowNode[] = d.classes.map((c) => ({
    id: c.id, label: c.label, shape: 'rect' as FlowNode['shape'], layer: 0, order: 0,
  }))
  const edges: FlowEdge[] = d.relations.map((r) => ({ from: r.from, to: r.to, label: '', arrow: 'solid' as const }))
  assignLayers(nodes, edges)

  const byLayer = new Map<number, FlowNode[]>()
  for (const n of nodes) {
    const l = byLayer.get(n.layer) || []
    l.push(n); byLayer.set(n.layer, l)
  }
  const layers = [...byLayer.keys()].sort((a, b) => a - b)
  const maxPerLayer = Math.max(...layers.map((l) => byLayer.get(l)!.length))

  const pos = new Map<string, { x: number; y: number }>()
  layers.forEach((layer, li) => {
    const list = byLayer.get(layer)!
    const colW = list.reduce((a, n) => a + boxH(d.classes.find((c) => c.id === n.id)!) + 26, 0)
    let y = PAD + 30
    for (const n of list) {
      const c = d.classes.find((x) => x.id === n.id)!
      pos.set(n.id, { x: PAD + li * LEVEL_W, y: y + boxH(c) / 2 })
      y += boxH(c) + 26
    }
    void colW
  })

  const w = PAD * 2 + (layers.length - 1) * LEVEL_W + BOX_W + 120
  const h = PAD * 2 + 40 + maxPerLayer * (HEAD_H + MAX_ROWS * ROW_H + 40)

  /* 连线画在下层 */
  const lines: string[] = []
  const labels: string[] = []
  for (const r of d.relations) {
    const a = pos.get(r.from), b = pos.get(r.to)
    if (!a || !b) continue
    const kind = r.kind
    /* 依赖 / 实现 用虚线，其它是实线。
       ⚠️ 虚实只区分「依赖类」和「拥有类」，**不冒充**继承三角 / 聚合菱形 ——
       真正的类型标在线上方的文字里，不靠线型猜。
       ⚠️ `dashed` 显式开关给 erDiagram 复用：它那边的虚线含义是「非识别关系」。 */
    const dashed = r.dashed ?? (kind === '依赖')
    const dash = dashed ? ' stroke-dasharray="5 4"' : ''

    /* 同一列（x2 ≤ x1）时直线会**穿过盒子**，标注也就落在成员表上。
       改成绕到这一列**左侧**去，标注放在左侧留白里。 */
    const backward = b.x <= a.x + 8
    let labelX: number, labelY: number, markerAt: 0 | 1
    if (backward) {
      const bow = Math.min(a.x, b.x) - 46
      lines.push(
        `<path d="M${a.x},${a.y} C${bow},${a.y} ${bow},${b.y} ${b.x + BOX_W},${b.y}" fill="none" class="yq-cd-rel"${dash} marker-end="url(#yq-cd-arrow-0)"/>`
      )
      labelX = bow
      labelY = (a.y + b.y) / 2 - 5
      markerAt = 0
    } else {
      const x1 = a.x + BOX_W, x2 = b.x
      lines.push(
        `<path d="M${x1},${a.y} C${(x1 + x2) / 2},${a.y} ${(x1 + x2) / 2},${b.y} ${x2},${b.y}" fill="none" class="yq-cd-rel"${dash} marker-end="url(#yq-cd-arrow-1)"/>`
      )
      labelX = (x1 + x2) / 2
      labelY = (a.y + b.y) / 2 - 5
      markerAt = 1
    }
    void markerAt

    const tag = r.label ? `${kind} · ${r.label}` : kind
    const cards = [r.fromCard && `"${r.fromCard}"`, r.toCard && `"${r.toCard}"`].filter(Boolean).join(' ')
    const text = [cards, tag].filter(Boolean).join(' ')
    /* ⚠️ 加一圈**底色描边光晕**（paint-order: stroke）：关系标注难免与线交叉，
       光晕保证任何位置都读得清，不用为了避让而把线画得扭曲。 */
    labels.push(
      `<text x="${labelX}" y="${labelY}" text-anchor="middle" class="yq-cd-rel-label">${esc(clip(text, 10, REL_LABEL_W))}</text>`
    )
  }

  /* 盒子：头部（类名 + 注解）+ 成员分隔线 + 成员行 */
  const boxes: string[] = []
  for (const c of d.classes) {
    const p = pos.get(c.id)
    if (!p) continue
    const h2 = boxH(c)
    const x = p.x, y = p.y - h2 / 2
    const shown = c.rows.slice(0, MAX_ROWS)
    /* classDef 样式：盒子与头部**都要上色** —— 只给外框上色的话，
       头部的默认底色会把颜色盖掉，用户看到的是「没生效」。
       文字颜色单独给（fill 对 text 无效，见 diagram-style 的 colorAttr）。 */
    const st = c.style || ''
    const nameFill = c.labelFill ? ` fill="${esc(c.labelFill)}"` : ''
    boxes.push(
      `<rect x="${x}" y="${y}" width="${BOX_W}" height="${h2}" rx="4" class="yq-cd-box"${st}/>` +
      `<rect x="${x}" y="${y}" width="${BOX_W}" height="${HEAD_H}" rx="4" class="yq-cd-head"${st}/>` +
      `<text x="${x + BOX_W / 2}" y="${y + HEAD_H / 2}" text-anchor="middle" dominant-baseline="middle" class="yq-cd-name"${nameFill}>${esc(clip(c.label, 12, BOX_W - 14))}</text>` +
      (c.annotation ? `<text x="${x + BOX_W / 2}" y="${y + HEAD_H + 11}" text-anchor="middle" class="yq-cd-annot"${nameFill}>${esc(clip(`«${c.annotation}»`, 9, BOX_W - 14))}</text>` : '')
    )
    const rowTop = y + HEAD_H + (c.annotation ? 16 : 0)
    if (shown.length) {
      boxes.push(`<line x1="${x}" y1="${rowTop}" x2="${x + BOX_W}" y2="${rowTop}" class="yq-cd-div"/>`)
      shown.forEach((r2, i) => {
        boxes.push(`<text x="${x + 8}" y="${rowTop + 13 + i * ROW_H}" class="yq-cd-row">${esc(clip(r2, 10, BOX_W - 16))}</text>`)
      })
      if (c.rows.length > MAX_ROWS) {
        boxes.push(`<text x="${x + BOX_W / 2}" y="${rowTop + 13 + shown.length * ROW_H}" text-anchor="middle" class="yq-cd-more">… 还有 ${c.rows.length - MAX_ROWS} 行</text>`)
      }
    }
  }

  const title = d.classes.length ? '' : ''
  return `<svg class="yq-cd-svg" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}" width="${Math.ceil(w)}" height="${Math.ceil(h)}" role="img" aria-label="类图">` +
    `<defs>` +
    `<marker id="yq-cd-arrow-1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="yq-cd-arrowhead"/></marker>` +
    `<marker id="yq-cd-arrow-0" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="yq-cd-arrowhead"/></marker>` +
    `</defs>` + title + lines.join('') + boxes.join('') + labels.join('') + `</svg>`
}