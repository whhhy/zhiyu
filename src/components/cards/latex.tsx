import { Fragment, type ReactNode } from 'react'

/* ============================================================
   迷你 LaTeX 渲染器（自研，零依赖）
   覆盖语雀公式卡片的实际用法：
     - 上下标 ^ _（含 a_1^2、x^{i+j}）
     - 分式 \frac、平方根 \sqrt[n]{}
     - 希腊字母 / 关系符 / 箭头 / 运算符 / 函数名（正体）
     - 上下标限位的大算符 \sum \prod \int \lim \bigcup
     - 重音 \hat \bar \vec \dot \tilde \overline
     - 字体 \mathrm \mathbf \mathbb \mathcal \text
     - 矩阵 pmatrix/bmatrix/matrix、array{cases|aligned}
   渲染成语义化 DOM + CSS 排版，不依赖任何第三方库。
   ============================================================ */

type Group = TeXNode[]

type TeXNode =
  | { k: 'sym'; ch: string; cls?: string }
  | { k: 'txt'; s: string }
  | { k: 'fn'; name: string }
  | { k: 'sup'; base: TeXNode; e: Group }
  | { k: 'sub'; base: TeXNode; s: Group }
  | { k: 'frac'; n: Group; d: Group }
  | { k: 'sqrt'; b: Group; i?: Group }
  | { k: 'accent'; kind: string; b: Group }
  | { k: 'grp'; items: Group }
  | { k: 'style'; s: string; b: Group }
  | { k: 'delim'; l: string; r: string; items: Group; tall: boolean }
  | { k: 'env'; name: string; rows: Group[][]; align: string }
  | { k: 'bigop'; name: string; sub?: Group; sup?: Group }
  | { k: 'space'; w: string }
  | { k: 'rule' }

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ',
  eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν',
  xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ',
  upsilon: 'υ', phi: 'ϕ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ',
  Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
}

/** 二元运算符 */
const BINOPS: Record<string, string> = {
  pm: '±', mp: '∓', times: '×', div: '÷', cdot: '·', ast: '∗', star: '⋆', circ: '∘',
  bullet: '∙', cap: '∩', cup: '∪', setminus: '∖', oplus: '⊕', otimes: '⊗', odot: '⊙',
  wedge: '∧', vee: '∨', ddot: '¨', tilde: '~', approx: '≈', sim: '∼', simeq: '≃',
  cong: '≅', propto: '∝', equiv: '≡', ll: '≪', gg: '≫', asy: '≍', bowtie: '⋈',
}

/** 关系符 */
const RELS: Record<string, string> = {
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', equiv: '≡', approx: '≈',
  sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫', in: '∈', notin: '∉',
  ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆', supseteq: '⊇', perp: '⊥',
  parallel: '∥', mid: '∣', doteq: '≐', models: '⊨', vdash: '⊢', to: '→', gets: '←',
  iff: '⟺', implies: '⟹',
}

const ARROWS: Record<string, string> = {
  to: '→', rightarrow: '→', gets: '←', leftarrow: '←', leftrightarrow: '↔',
  Leftarrow: '⇐', Rightarrow: '⇒', Leftrightarrow: '⇔', mapsto: '↦',
  longrightarrow: '⟶', longleftarrow: '⟵', longleftrightarrow: '⟷', implies: '⟹',
  iff: '⟺', uparrow: '↑', downarrow: '↓', hookrightarrow: '↪', nearrow: '↗', searrow: '↘',
}

const MISC: Record<string, string> = {
  infty: '∞', partial: '∂', nabla: '∇', forall: '∀', exists: '∃', nexists: '∄',
  neg: '¬', lnot: '¬', emptyset: '∅', varnothing: '∅', angle: '∠', triangle: '△',
  square: '□', Box: '□', diamond: '◇', ldots: '…', cdots: '⋯', dots: '…', vdots: '⋮',
  ddots: '⋱', prime: '′', degree: '°', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ',
  aleph: 'ℵ', wp: '℘', surd: '√', top: '⊤', bot: '⊥', therefore: '∴', because: '∵',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', langle: '⟨', rangle: '⟩',
  lbrace: '{', rbrace: '}', backslash: '\\', vert: '|', Vert: '‖', '{': '{', '}': '}',
  '%': '%', $: '$', '#': '#', '&': '&', _: '_', '|': '|', '||': '‖',
}

/** 大算符：上下标排到正上下方 */
const BIGOPS: Record<string, string> = {
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮',
  bigcup: '⋃', bigcap: '⋂', bigvee: '⋁', bigwedge: '⋀', bigoplus: '⨁', bigotimes: '⨂',
  bigsqcup: '⨆', lim: 'lim', limsup: 'lim sup', liminf: 'lim inf', max: 'max', min: 'min',
  sup: 'sup', inf: 'inf', det: 'det', gcd: 'gcd', Pr: 'Pr', arg: 'arg', deg: 'deg',
}

/** 函数名：正体 + 函数型间距 */
const FUNCS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh',
  'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'dim', 'hom', 'ker', 'deg',
  'gcd', 'arg', 'sgn',
])

/** 字体样式 */
const STYLES: Record<string, string> = {
  mathrm: 'up', mathbf: 'bf', boldsymbol: 'bf', mathbb: 'bb', mathcal: 'cal',
  mathscr: 'cal', mathsf: 'sf', mathtt: 'tt', mathit: 'it', text: 'up',
  textbf: 'bf', textit: 'it', textrm: 'up', textsf: 'sf', texttt: 'tt', mbox: 'up',
}

/** 黑板体 / 花体字符（够用即可，不是全字符集） */
const BB: Record<string, string> = {
  R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', E: '𝔼', H: 'ℍ', F: '𝔽',
}
const CAL: Record<string, string> = {
  A: '𝒜', B: 'ℬ', C: '𝒞', D: '𝒟', E: 'ℰ', F: 'ℱ', G: '𝒢', H: 'ℋ', I: 'ℐ',
  J: '𝒥', K: '𝒦', L: 'ℒ', M: 'ℳ', N: '𝒩', O: '𝒪', P: '𝒫', Q: '𝒬', R: 'ℛ',
  S: '𝒮', T: '𝒯', U: '𝒰', V: '𝒱', W: '𝒲', X: '𝒳', Y: '𝒴', Z: '𝒵',
}

const ACCENTS: Record<string, string> = {
  hat: '^', widehat: '^', bar: '̅', overline: '‾', vec: '→', dot: '˙', ddot: '¨',
  tilde: '~', widetilde: '~', check: 'ˇ', breve: '˘', acute: '´', grave: '`',
  overrightarrow: '→', underline: '_',
}

const SPACE: Record<string, string> = {
  ',': '0.17em', ':': '0.22em', ';': '0.28em', '!': '-0.17em', quad: '1em', qquad: '2em',
  enspace: '0.5em', thinspace: '0.2em', negthinspace: '-0.2em', ' ': '0.25em',
}

/* ---------------- 词法 ---------------- */

type Tok =
  | { t: 'cmd'; name: string }
  | { t: 'ch'; ch: string }
  | { t: 'open' }
  | { t: 'close' }
  | { t: 'sup' }
  | { t: 'sub' }
  | { t: 'amp' }

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      const rest = src.slice(i + 1)
      const m = /^[a-zA-Z]+/.exec(rest)
      if (m) {
        out.push({ t: 'cmd', name: m[0] })
        i += m[0].length
      } else {
        out.push({ t: 'cmd', name: rest[0] ?? '' })
        i += 1
      }
      continue
    }
    if (/\s/.test(c)) continue
    if (c === '{') out.push({ t: 'open' })
    else if (c === '}') out.push({ t: 'close' })
    else if (c === '^') out.push({ t: 'sup' })
    else if (c === '_') out.push({ t: 'sub' })
    else if (c === '&') out.push({ t: 'amp' })
    else out.push({ t: 'ch', ch: c })
  }
  return out
}

/* ---------------- 语法 ---------------- */

const STOPS = new Set(['}', 'end', 'right'])

class Parser {
  toks: Tok[]
  i = 0
  constructor(src: string) {
    this.toks = tokenize(src)
  }
  peek(): Tok | undefined {
    return this.toks[this.i]
  }
  /** peek 后安全取字符：不是 ch token 时返回 undefined（避免联合类型上没有该属性） */
  peekCh(): string | undefined {
    const t = this.toks[this.i]
    return t && t.t === 'ch' ? t.ch : undefined
  }
  peekCmd(): string | undefined {
    const t = this.toks[this.i]
    return t && t.t === 'cmd' ? t.name : undefined
  }
  next(): Tok | undefined {
    return this.toks[this.i++]
  }
  /** 读一个必选参数：{...} 或单个 token */
  arg(): Group {
    const t = this.peek()
    if (!t) return []
    if (t.t === 'open') {
      this.i++
      const g = this.seq()
      if (this.peek()?.t === 'close') this.i++
      return g
    }
    if (t.t === 'close') return []
    const a = this.atom()
    return a ? [a] : []
  }
  /** 序列：遇到 } / \end / \right / & / \\ 停 */
  seq(stopAtRow = false): Group {
    const items: Group = []
    for (;;) {
      const t = this.peek()
      if (!t) break
      if (t.t === 'close') break
      if (t.t === 'cmd' && (t.name === 'end' || t.name === 'right' || t.name === 'cr')) break
      if (t.t === 'amp') break
      if (stopAtRow && t.t === 'cmd' && t.name === '\\') break
      const a = this.atomWithScripts()
      if (a) items.push(a)
      else break
    }
    return items
  }
  /** 原子 + 后缀的上下标 */
  atomWithScripts(): TeXNode | null {
    let base = this.atom()
    if (base === null) return null
    let sub: Group | undefined
    let sup: Group | undefined
    for (;;) {
      const t = this.peek()
      if (t?.t === 'sub' && sub === undefined) {
        this.i++
        sub = this.arg()
      } else if (t?.t === 'sup' && sup === undefined) {
        this.i++
        sup = this.arg()
      } else break
    }
    if (sub && sup) {
      // 大算符（\sum \int）的限位排到正上下方，其余叠在右上/右下
      if (base.k === 'bigop') return { ...base, sub, sup }
      return { k: 'sup', base: withSub(base, sub), e: sup }
    }
    if (sub) {
      if (base.k === 'bigop') return { ...base, sub }
      return withSub(base, sub)
    }
    if (sup) {
      if (base.k === 'bigop') return { ...base, sup }
      return { k: 'sup', base, e: sup }
    }
    return base
  }
  atom(): TeXNode | null {
    const t = this.next()
    if (!t) return null
    if (t.t === 'ch') {
      if (/[0-9]/.test(t.ch)) return { k: 'sym', ch: t.ch, cls: 'up' }
      if (/[A-Za-z]/.test(t.ch)) return { k: 'sym', ch: t.ch, cls: 'it' }
      if (t.ch === '-' || t.ch === '+') return { k: 'sym', ch: t.ch, cls: 'bin' }
      return { k: 'sym', ch: t.ch }
    }
    if (t.t === 'open') {
      const items = this.seq()
      if (this.peek()?.t === 'close') this.i++
      return { k: 'grp', items }
    }
    if (t.t === 'close' || t.t === 'amp' || t.t === 'sup' || t.t === 'sub') {
      this.i--
      return null
    }
    // t.t === 'cmd'
    const n = t.name
    if (n === 'frac' || n === 'dfrac' || n === 'tfrac') {
      return { k: 'frac', n: this.arg(), d: this.arg() }
    }
    if (n === 'sqrt') {
      let idx: Group | undefined
      if (this.peekCh() === '[') {
        this.i++
        idx = this.seq()
        if (this.peekCh() === ']') this.i++
      }
      return { k: 'sqrt', b: this.arg(), i: idx }
    }
    if (ACCENTS[n]) return { k: 'accent', kind: ACCENTS[n], b: this.arg() }
    if (STYLES[n]) return { k: 'style', s: STYLES[n], b: this.arg() }
    if (n === 'text' || n === 'textrm' || n === 'mbox') {
      const g = this.arg()
      return { k: 'style', s: 'up', b: g }
    }
    if (n === 'left' || n === 'middle') {
      const l = this.delim()
      const items = this.seq()
      let r = ''
      if (this.peekCmd() === 'right') {
        this.i++
        r = this.delim()
      }
      return { k: 'delim', l, r, items, tall: isTall(items) }
    }
    if (n === 'begin') return this.env()
    if (n === 'hspace' || n === 'mspace') {
      const g = this.arg()
      // \hspace{2em} 里的单位原样取出来，裸数字按 em 算
      const raw = g
        .map((x) => (x.k === 'sym' ? x.ch : x.k === 'txt' ? x.s : ''))
        .join('')
      return { k: 'space', w: raw ? (/^\d/.test(raw) ? `${raw}em` : raw) : '0.8em' }
    }
    if (n in SPACE) return { k: 'space', w: SPACE[n] }
    if (n === '\\' || n === 'cr' || n === 'newline' || n === 'smallskip' || n === 'medskip')
      return { k: 'space', w: '0.5em' }
    if (n === 'phantom' || n === 'hphantom' || n === 'vphantom') {
      this.arg()
      return { k: 'space', w: '0em' }
    }
    if (BIGOPS[n]) return { k: 'bigop', name: BIGOPS[n] }
    if (FUNCS.has(n)) return { k: 'fn', name: n }
    if (GREEK[n]) return { k: 'sym', ch: GREEK[n], cls: /^[A-Z]/.test(n) ? 'up' : 'it' }
    if (ARROWS[n]) return { k: 'sym', ch: ARROWS[n], cls: 'rel' }
    if (RELS[n]) return { k: 'sym', ch: RELS[n], cls: 'rel' }
    if (BINOPS[n]) return { k: 'sym', ch: BINOPS[n], cls: 'bin' }
    if (MISC[n]) return { k: 'sym', ch: MISC[n] }
    if (n === '') return null
    // 未知命令：原样显示命令名，不静默吞掉
    return { k: 'txt', s: '\\' + n }
  }
  delim(): string {
    const t = this.next()
    if (!t) return ''
    if (t.t === 'ch') return t.ch
    if (t.t === 'cmd') {
      if (t.name === '{' || t.name === 'lbrace') return '{'
      if (t.name === '}' || t.name === 'rbrace') return '}'
      if (t.name === 'langle') return '⟨'
      if (t.name === 'rangle') return '⟩'
      if (t.name === 'vert' || t.name === '|') return '|'
      if (t.name === 'Vert' || t.name === '||') return '‖'
      if (MISC[t.name]) return MISC[t.name]
      return t.name
    }
    return ''
  }
  /** 环境：array / pmatrix / cases / aligned */
  env(): TeXNode {
    const nameTok = this.next()
    const name = nameTok && nameTok.t === 'ch' ? nameTok.ch : ''
    let align = 'c'
    if (name === 'array' && this.peek()?.t === 'open') {
      const g = this.arg()
      align = g
        .map((n) => (n.k === 'sym' ? n.ch : 'c'))
        .join('')
    }
    const rows: Group[][] = [[]]
    let cells: Group = []
    for (;;) {
      const t = this.peek()
      if (!t) break
      if (t.t === 'cmd' && t.name === 'end') {
        this.i++
        this.next()
        break
      }
      if (t.t === 'cmd' && (t.name === '\\' || t.name === 'cr')) {
        this.i++
        rows[rows.length - 1].push(cells)
        rows.push([])
        cells = []
        continue
      }
      if (t.t === 'amp') {
        this.i++
        rows[rows.length - 1].push(cells)
        cells = []
        continue
      }
      const a = this.atomWithScripts()
      if (a === null) {
        // 死循环保护：遇到看不懂的 token 直接跳过
        this.i++
        continue
      }
      cells.push(a)
    }
    rows[rows.length - 1].push(cells)
    // 去掉末尾空行
    while (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0].length === 0)
      rows.pop()
    return { k: 'env', name, rows, align }
  }
}

function withSub(base: TeXNode, s: Group): TeXNode {
  return { k: 'sub', base, s }
}

function isTall(items: Group): boolean {
  return items.some((n) => n.k === 'frac' || n.k === 'sqrt' || n.k === 'env')
}

/* ---------------- 渲染 ---------------- */

function mapNodes(items: Group, key = 'n'): ReactNode[] {
  return items.map((n, i) => (
    <Fragment key={`${key}${i}`}>{renderNode(n, `${key}${i}`)}</Fragment>
  ))
}

function renderGroup(items: Group, key: string): ReactNode {
  return <>{mapNodes(items, key)}</>
}

function renderNode(n: TeXNode, key: string): ReactNode {
  switch (n.k) {
    case 'sym':
      return <span key={key} className={n.cls ? `yq-tex-${n.cls}` : undefined}>{n.ch}</span>
    case 'txt':
      return <span key={key} className="yq-tex-up">{n.s}</span>
    case 'fn':
      return (
        <span key={key} className="yq-tex-fn">
          {n.name}
        </span>
      )
    case 'rule':
      return <span key={key} className="yq-tex-space" style={{ width: '0.4em' }} />
    case 'space':
      return <span key={key} className="yq-tex-space" style={{ width: n.w }} />
    case 'grp':
      return <span key={key}>{mapNodes(n.items, key)}</span>
    case 'sup':
      return (
        <span key={key} className="yq-tex-scripts">
          {renderNode(n.base, key + 'b')}
          <span className="yq-tex-sup">{renderGroup(n.e, key + 's')}</span>
        </span>
      )
    case 'sub':
      return (
        <span key={key} className="yq-tex-scripts">
          {renderNode(n.base, key + 'b')}
          <span className="yq-tex-sub">{renderGroup(n.s, key + 's')}</span>
        </span>
      )
    case 'frac':
      return (
        <span key={key} className="yq-tex-frac">
          <span className="yq-tex-frac-n">{renderGroup(n.n, key + 'n')}</span>
          <span className="yq-tex-frac-d">{renderGroup(n.d, key + 'd')}</span>
        </span>
      )
    case 'sqrt':
      return (
        <span key={key} className="yq-tex-sqrt">
          <span className="yq-tex-sqrt-sign">√</span>
          <span className="yq-tex-sqrt-body">
            {n.i && <span className="yq-tex-sqrt-idx">{renderGroup(n.i, key + 'i')}</span>}
            <span className="yq-tex-sqrt-bar">{renderGroup(n.b, key + 'b')}</span>
          </span>
        </span>
      )
    case 'accent':
      return (
        <span key={key} className="yq-tex-accent">
          <span className="yq-tex-accent-mark">{n.kind}</span>
          <span className="yq-tex-accent-body">{renderGroup(n.b, key + 'b')}</span>
        </span>
      )
    case 'style': {
      const inner = renderGroup(n.b, key)
      if (n.s === 'bb')
        return (
          <span key={key} className="yq-tex-bb">
            {n.b.map((c, i) => (
              <Fragment key={i}>{c.k === 'sym' ? BB[c.ch] || c.ch : renderNode(c, key + i)}</Fragment>
            ))}
          </span>
        )
      if (n.s === 'cal')
        return (
          <span key={key} className="yq-tex-cal">
            {n.b.map((c, i) => (
              <Fragment key={i}>{c.k === 'sym' ? CAL[c.ch] || c.ch : renderNode(c, key + i)}</Fragment>
            ))}
          </span>
        )
      return <span key={key} className={`yq-tex-st yq-tex-st-${n.s}`}>{inner}</span>
    }
    case 'delim': {
      const L = n.l === '.' ? null : n.l
      const R = n.r === '.' ? null : n.r
      return (
        <span key={key} className={`yq-tex-delim ${n.tall ? 'is-tall' : ''}`}>
          {L && <span className="yq-tex-delim-ch">{L}</span>}
          <span className="yq-tex-delim-body">{mapNodes(n.items, key)}</span>
          {R && <span className="yq-tex-delim-ch">{R}</span>}
        </span>
      )
    }
    case 'bigop':
      return (
        <span key={key} className="yq-tex-bigop">
          {n.sup && <span className="yq-tex-bigop-sup">{renderGroup(n.sup, key + 'u')}</span>}
          <span className="yq-tex-bigop-ch">{n.name}</span>
          {n.sub && <span className="yq-tex-bigop-sub">{renderGroup(n.sub, key + 'b')}</span>}
        </span>
      )
    case 'env': {
      const cls =
        n.name === 'pmatrix' ? 'is-pmatrix' : n.name === 'bmatrix' ? 'is-bmatrix' : n.name === 'cases' ? 'is-cases' : ''
      return (
        <span key={key} className={`yq-tex-matrix ${cls}`}>
          <table className="yq-tex-table">
            <tbody>
              {n.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => (
                    <td key={ci} className={n.align[ci] ? `is-${n.align[ci]}` : undefined}>
                      {mapNodes(cell, `${key}r${ri}c${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </span>
      )
    }
    default:
      return null
  }
}

/** 解析并渲染一段 LaTeX。非法输入不会抛错：降级成原样文本。 */
export function renderLatex(src: string): ReactNode {
  if (!src || !src.trim()) return null
  try {
    const p = new Parser(src)
    const items = p.seq()
    return <span className="yq-tex">{mapNodes(items, 'x')}</span>
  } catch {
    return <span className="yq-tex-raw">{src}</span>
  }
}

