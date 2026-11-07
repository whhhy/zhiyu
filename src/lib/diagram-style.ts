/* ============================================================
   Mermaid `classDef` / `class` / `A:::name` → 节点样式（共用）
   ------------------------------------------------------------
   为什么单独一个文件：classDef 在**流程图 / 状态图 / 类图**里是同一套
   语法，三个解析器各写一遍就一定会漂（改一处忘另一处）。流程图与状态图
   本来就共用渲染器，所以接进去零成本；类图要单独接。

   ⚠️⚠️ **安全：这里是全文里唯一一处把「用户写的源码」拼进 HTML 属性
      的地方，所以必须严格过滤，不能只做转义。**
      知识库是全员可写的，一个
          classDef x fill:red" onload="fetch('/internal/steal')
      如果原样拼进 `style="..."` 就是**属性注入**：引号闭合后后面整段
      变成新属性，事件处理器直接生效。转义（`&quot;`）在这里**不够** ——
      SVG 属性里浏览器会先解实体，`&quot;` 又变回引号。
      所以口径是**白名单**：每个属性的值都要整串匹配一个字符集有限的正则，
      匹配不上就**丢掉并报出来**，绝不「清洗后凑合用」。

      ⚠️ 上面这个例子里的假路径**是故意不写成服务端那种前缀的**：
         lint 有一条守卫会扫源码里的静态接口路径、去服务端找对应路由，
         注释里随手写一个就会变成「这条接口没实现」而报红 ——
         明明只是注释，却让人去查一个不存在的问题。
         （本条注释自己也守这个规矩：描述那个守卫时同样不把前缀写出来。）

      这也是为什么 `parseStyles` 要返回 `problems` —— 被丢掉的东西
      必须让用户看见，否则就是「我明明写了颜色怎么没生效」。

   支持的属性（mermaid classDef 常用子集）：
     fill / stroke / color   —— 颜色
     stroke-width / font-size —— 数字 + 单位
     stroke-dasharray        —— 数字、逗号、空格
     opacity                 —— 0~1
   **不支持**：渐变、阴影、transform、动画、CSS 变量、`url(...)`
     （`url()` 能引用外部资源，必须挡掉）、`expression(...)`（老 IE 的老坑）。
   ============================================================ */

export interface StyleProps {
  fill?: string
  stroke?: string
  strokeWidth?: string
  strokeDasharray?: string
  color?: string
  opacity?: string
  fontSize?: string
}

export interface ParsedStyles {
  /** classDef 名 → 属性 */
  defs: Map<string, StyleProps>
  /** 节点 id → 它身上的 classDef 名（一个节点可以挂多个） */
  assign: Map<string, string[]>
  /** 被拒的写法 / 引用了不存在的 classDef —— 界面上如实显示 */
  problems: string[]
}

/* ---------- 值校验 ---------- */

/* ⚠️ 源码里的键是**连字符**（`stroke-width` / `font-size`），内部字段是驼峰。
   少这张映射表的后果很隐蔽：解析时按驼峰查不到键 → 报「属性不支持」，
   于是 `stroke-width:4px` 这种**最常见的 classDef 属性**被全盘拒掉，
   而界面只说「不支持」，用户根本看不出是连字符的问题。 */
const KEY_ALIAS: Record<string, keyof StyleProps> = {
  fill: 'fill',
  stroke: 'stroke',
  color: 'color',
  'stroke-width': 'strokeWidth',
  'font-size': 'fontSize',
  'stroke-dasharray': 'strokeDasharray',
  opacity: 'opacity',
}

/* 颜色：`#rgb/#rgba/#rrggbb/#rrggbbaa`、`rgb()/rgba()/hsl()/hsla()`
   （括号里只收数字 / `%` / `,` / 空格 / `/`）、CSS 具名颜色（纯字母）。
   ⚠️ 不允许 `url(`、括号、`;`、`"`、`'` —— 这几个就是注入面。 */
const COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\([0-9.,%/\s]+\)|hsla?\([0-9.,%/\s]+\)|[a-zA-Z]{3,24}|transparent|currentColor)$/
const LEN = /^[0-9]+(\.[0-9]+)?(px|pt|em|rem|%)?$/
const DASH = /^[0-9.,\s]+(px)?$/
const OPACITY = /^(0|1|0?\.[0-9]+|1\.0+)$/

const V: Record<keyof StyleProps, RegExp> = {
  fill: COLOR,
  stroke: COLOR,
  color: COLOR,
  strokeWidth: LEN,
  fontSize: LEN,
  strokeDasharray: DASH,
  opacity: OPACITY,
}

/** `fill:#f9f,stroke:#333,stroke-width:4px` → 属性表（不合规的丢掉） */
function parseProps(text: string, where: string, problems: string[]): StyleProps {
  const out: StyleProps = {}
  for (const seg of String(text).split(',')) {
    const s = seg.trim()
    if (!s) continue
    const i = s.indexOf(':')
    if (i < 0) { problems.push(`${where} 的「${s.slice(0, 24)}」不是 key:value`); continue }
    const rawKey = s.slice(0, i).trim().toLowerCase()
    const val = s.slice(i + 1).trim()
    const key = KEY_ALIAS[rawKey]
    if (!key) { problems.push(`${where}：属性 ${rawKey || '(空)'} 本地渲染器不支持`); continue }
    if (!val) { problems.push(`${where}：${rawKey} 没有值`); continue }
    /* ⚠️ 整串匹配，不做「清洗」—— 清洗意味着「看起来能用」，而这里要的是
       「要么完全合法，要么明确报出来」。 */
    if (!V[key].test(val)) { problems.push(`${where}：${rawKey} 的值「${val.slice(0, 24)}」不合法`); continue }
    out[key] = val
  }
  return out
}

/* ---------- 源码扫描 ---------- */

/**
 * `class A,B name` / `class A name` —— **挂样式**。
 *
 * ⚠️⚠️ 第二个 token **必须排除 `{`**。写成
 *     `/^class\s+[^\s{]+\s+\S/i` 时，`class 文档 {` 也会命中 ——
 *     `\S` 匹配得到 `{`，于是**类声明整行被当成样式行吞掉**，
 *     类图里一个类都没了（实测：类数 0、成员全进 skipped），
 *     而报错只是「引用了没有定义的 classDef「{」」，完全指不到真因。
 *
 * 判据共用一份，不要在三个解析器里各写一遍 —— 上一版就是这么错的，
 * 而同一个错在流程图 / 状态图 / 类图里各犯一次。
 */
export const CLASS_ASSIGN_RE = /^class\s+[^\s{]+(?:\s*,\s*[^\s{]+)*\s+(?!\{)\S/

/** `classDef 名字 …` 行 */
export const CLASS_DEF_RE = /^classDef\s/i

/**
 * 这一行是「给类挂样式」吗？
 *
 * ⚠️ 光靠正则不够：`class 文档 <<interface>> {`（类图的注解声明）里，
 *   第二个 token 是 `<<interface>>` 而不是 `{`，躲过了 `CLASS_ASSIGN_RE`
 *   的约束，于是**整行声明被当成样式行吞掉** —— 类没了、成员进了 skipped，
 *   报错只是「引用了没有定义的 classDef「<<interface>>」」，完全指不到真因。
 *   （实测 classdiagram 套件 52/58，就是这么红的。）
 *
 * 判据：**出现 `<<…>>` 就是注解、是声明**，不是样式。
 */
export function isClassAssign(line: string): boolean {
  if (CLASS_DEF_RE.test(line)) return false
  if (!CLASS_ASSIGN_RE.test(line)) return false
  return !/<<[^>]*>>/.test(line)
}

/**
 * @param src      原始源码
 * @param skipLines 交给调用方自己处理、这里不要动的行（各解析器自己过滤）
 */
export function parseStyles(src: string, skipLines?: (line: string) => boolean): ParsedStyles {
  const defs = new Map<string, StyleProps>()
  const assign = new Map<string, string[]>()
  const problems: string[] = []

  for (const raw of String(src || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    if (skipLines && skipLines(line)) continue

    /* classDef 名字  fill:#f9f,stroke:#333 */
    const def = /^classDef\s+([A-Za-z_][\w-]*)\s+(.+)$/i.exec(line)
    if (def) {
      defs.set(def[1], parseProps(def[2], `classDef ${def[1]}`, problems))
      continue
    }

    /* class A,B,C name  —— 只有一个 token 的是**类声明**（classDiagram 里
       `class A` 是声明一个类），交给各解析器自己处理，这里只管 ≥2 个。 */
    const cls = /^class\s+([^\s{][^\s]*)\s+(.+)$/i.exec(line)
    if (cls) {
      const names = cls[2].split(',').map((s) => s.trim()).filter(Boolean)
      if (!names.length) continue
      for (const id of cls[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        assign.set(id, [...(assign.get(id) || []), ...names])
      }
      continue
    }

    /* 行内挂样式：A:::name / 产品:::hot（可能多个 :::name）
       ⚠️ 键名**不能**只收 `[A-Za-z_]`：中文节点名（`产品:::hot`、`文档:::doc`）
          是内网文档里最常见的写法，用字母数字开头去卡的话整条赋值被**静默丢掉** ——
          图上就是「明明写了颜色、节点却没变色」，而且没有任何提示。
       ⚠️ 仍只认**整行就是一个键 + :::** 的写法；`A --> B:::x` 那类带连线的
          整行由流程图解析器自己先摘掉 `:::`、再合成单独一行送过来，
          这里不抢 —— 抢了会把边吃掉。 */
    const inline = /^([^\s:]+)((?:\s*:::\s*[\w-]+)+)$/.exec(line)
    if (inline) {
      const names = [...inline[2].matchAll(/:::\s*([\w-]+)/g)].map((m) => m[1])
      assign.set(inline[1], [...(assign.get(inline[1]) || []), ...names])
    }
  }

  /* 引用了没定义的 classDef —— 界面必须说出来。
     症状形态特别能骗人：节点就是没变色，而源码里明明写了 `classDef`。 */
  for (const [id, names] of assign) {
    for (const n of names) if (!defs.has(n)) problems.push(`${id} 引用了没有定义的 classDef「${n}」`)
  }
  return { defs, assign, problems }
}

/** 节点 id → 合并后的样式（后写的 classDef 覆盖先写的，与 CSS 一致） */
export function styleForNode(parsed: ParsedStyles, id: string): StyleProps | null {
  const names = parsed.assign.get(id)
  if (!names || !names.length) return null
  let out: StyleProps | null = null
  for (const n of names) {
    const d = parsed.defs.get(n)
    if (d) out = { ...(out || {}), ...d }
  }
  return out && Object.keys(out).length ? out : null
}

const CSS_KEY: Record<keyof StyleProps, string> = {
  fill: 'fill',
  stroke: 'stroke',
  color: 'color',
  strokeWidth: 'stroke-width',
  fontSize: 'font-size',
  strokeDasharray: 'stroke-dasharray',
  opacity: 'opacity',
}

/**
 * → ` style="fill:#f9f;stroke:#333"`（可直接插在标签里），无样式返回空串。
 *
 * ⚠️ 之所以还做一次转义：值虽然已经过白名单正则（不可能含引号/分号），
 * 但「校验 + 转义」两层都在，比只留一层便宜 —— 一层写错了就是注入。
 */
export function styleAttr(p?: StyleProps | null): string {
  if (!p) return ''
  const parts: string[] = []
  for (const k of Object.keys(CSS_KEY) as Array<keyof StyleProps>) {
    const v = p[k]
    if (v == null) continue
    parts.push(`${CSS_KEY[k]}:${String(v).replace(/["'<>\\]/g, '')}`)
  }
  return parts.length ? ` style="${parts.join(';')}"` : ''
}

/** 给类图那种「盒子由多行 rect 组成」的图用：文字颜色单独挂在 text 上 */
export function colorAttr(p?: StyleProps | null): string {
  if (!p || !p.color) return ''
  return ` fill="${String(p.color).replace(/["'<>\\]/g, '')}"`
}