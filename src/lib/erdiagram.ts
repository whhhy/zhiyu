/* ============================================================
   Mermaid `erDiagram`（实体关系图）→ 复用 ClassDiagram 的渲染
   ------------------------------------------------------------
   为什么不另写一套渲染：实体与类**结构完全一样** —— 都是
   「名字 + 一张属性表」的隔层盒子，关系也都是一条带标注的连线。
   所以这里只写解析，渲染直接调 `renderClassDiagramSvg`，
   零新增渲染代码、零新增 CSS。

   ⚠️ 和类图一样，**不画乌鸦脚**。基数是**语义本身**
      （`||--o{` 是「恰好一 → 零或多」，画错就是画错的数据模型），
      所以线上标的是**基数文字**（`1 → 0..N · places`），
      线型只区分「识别（实线）/ 非识别（虚线）」。

   语法：
     erDiagram
         CUSTOMER ||--o{ ORDER : places
         ORDER { string id PK  int amount }
         CUSTOMER { string name  string email UK }

   基数（左边 2 字符 / 右边 2 字符，方向相反）：
     `||` 恰好一     `|o`/`o|` 零或一     `}o`/`o{` 零或多     `}|`/`|{` 一或多
   关系线：`--` 识别（实线）    `..` 非识别（虚线）

   **不支持**：属性上的 `FK` 反向连线、注释 `%%`（已忽略）、属性类型里的复杂泛型。
     认不出来的行进 `skipped`，界面上明说。
   ============================================================ */

import { renderClassDiagramSvg, type ClassDiagram } from './classdiagram.ts'
import { parseStyles, styleForNode, styleAttr, isClassAssign, CLASS_DEF_RE } from './diagram-style.ts'
import { firstMeaningfulLine } from './first-line.ts'

export type { ClassDiagram }

/** 两端基数 token → 人话。左边和右边方向相反，都映射到同一套。 */
function cardinality(tok: string): string | null {
  switch (tok) {
    case '||': return '1'
    case '|o': case 'o|': return '0..1'
    case '}o': case 'o{': return '0..N'
    case '}|': case '|{': return '1..N'
    default: return null
  }
}

/* `A ||--o{ B : 说明`
   组号：1=左实体 2=左基数 3=线型 4=右基数 5=右实体 6=说明
   ⚠️ 两个基数**必须是捕获组**。写成 `(?:…)` 的话整份正则只剩 4 个组，
      而代码按 6 个读 —— 于是「线型」被当成「左基数」、「右实体」被当成
      「线型」，`to` 直接是 undefined，**四条关系一条都没画出来**，
      全部掉进 skipped。这是同一个坑的第三次：非捕获组让组号错位。 */
const REL_RE = /^(\S+)\s*(\|\||\|o|\}o|\}\|)\s*(--|\.\.)\s*(\|\||o\||o\{|\|\{)\s*(\S+?)\s*(?::\s*(.*))?$/
const ATTR_RE = /^[\w[\]{}<>., ]+?\s+\w+\s*(?:PK|FK|UK)?\s*$/i

export function parseErDiagram(src: string): ClassDiagram {
  const out: ClassDiagram = { classes: [], relations: [], skipped: [] }
  const byId = new Map<string, ClassDiagram['classes'][number]>()
  /** classDef / `class A name` 的行 */
  const styleLines: string[] = []
  let inBody: ClassDiagram['classes'][number] | null = null

  const ensure = (id: string): ClassDiagram['classes'][number] => {
    let e = byId.get(id)
    if (!e) { e = { id, label: id, rows: [], annotation: '' }; byId.set(id, e); out.classes.push(e) }
    return e
  }

  for (const raw of String(src || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    if (/^erDiagram\b/i.test(line)) continue

    /* classDef / `class A name` —— ER 图在 mermaid 里同样支持样式。
       ⚠️ 实体关系图**有自己的解析器**（只写解析、渲染复用类图），
          所以类图那边加的拦截在这里碰不到：这两行会一路掉到最后的
          `out.skipped.push(...)`，界面上报「不认」。 */
    if (CLASS_DEF_RE.test(line) || isClassAssign(line)) { styleLines.push(line); continue }

    if (inBody && line === '}') { inBody = null; continue }
    if (inBody) {
      if (ATTR_RE.test(line)) inBody.rows.push(line)
      else out.skipped.push(line.slice(0, 40))
      continue
    }

    /* 实体声明（可选）：`CUSTOMER {` */
    const decl = /^(\S+)\s*\{\s*$/.exec(line)
    if (decl) { inBody = ensure(decl[1]); continue }

    const rel = REL_RE.exec(line)
    if (rel) {
      const lc = cardinality(rel[2])
      const rc = cardinality(rel[4])
      if (!lc || !rc) { out.skipped.push(line.slice(0, 50)); continue }
      ensure(rel[1]); ensure(rel[5])
      const identifying = rel[3] === '--'
      out.relations.push({
        from: rel[1], to: rel[5],
        /* kind 会被渲染成「类型 · 说明」，这里就放**基数** ——
           正是「宁可标文字也不画可能画错的符号」那个取舍的落点。
           ⚠️ fromCard/toCard 留空：「识别 / 非识别」由**线型**（实线/虚线）
           表达，写进文字只会把标注撑宽、把真正的基数挤到被截断。 */
        kind: `${lc} → ${rc}`,
        /* 引号是 mermaid 的**定界符**不是内容 —— `: "lives at"` 的显示名是
           lives at。留着引号会让标注多两字符，而标注宽度本来就紧张
           （上一轮实测过标注一宽就蹭到相邻盒子的成员行）。 */
        label: (rel[6] || '').trim().replace(/^["']|["']$/g, ''),
        fromCard: '',
        toCard: '',
        dashed: !identifying,
      })
      continue
    }

    /* 光秃秃一个实体名（没属性、没关系）也要认，否则会掉进 skipped */
    if (/^\S+$/.test(line)) { ensure(line); continue }

    out.skipped.push(line.slice(0, 50))
  }

  /* classDef → 实体样式。放在最后：此时所有实体（含只出现在关系行里的）
     都已登记完，早做会漏。渲染复用类图，所以样式自动跟着过去。 */
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

/** 一眼看出这份源码是不是实体关系图 */
export function isErDiagramSource(src: string): boolean {
  return /^erDiagram\b/i.test(firstMeaningfulLine(src))
}

/** 与类图共用渲染（这里包一层，调用方不必知道它其实走的是类图那条路） */
export function renderErDiagramSvg(d: ClassDiagram): string {
  return renderClassDiagramSvg(d)
}