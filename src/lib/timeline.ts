/* ============================================================
   Mermaid `timeline`（时间线）→ 原生 SVG
   ------------------------------------------------------------
   覆盖：timeline / `title 标题` / `2024 Q1 : 里程碑` /
   `2024 : A : B`（一行多个事件）/ `2022-2025 : 阶段`（区间）。

   ⚠️ 布局**按年份比例定位**，不是等距分格。
      等距（官方就是这么分的）在 `2002 / 2004 / 2025` 上会把
      2002→2004 画得和 2002→2025 一样宽 —— 那是**把时间说错**，
      而时间线图的全部意义就是时间。所以这里按真实数值定位，
      再做一次「碰撞就往右推」的单调扫描，保证不重叠。

   ⚠️ 推挤之后**不再回头缩放**：宁可末列离轴远一点，
      也不要为了塞回轴内再把整条轴压缩 —— 那等于把比例又改回去。

   ⚠️ 完全认不出年份的周期（比如 `上线后`）**退回等距**并记一笔实话，
      不猜一个数字出来顶替。
   ============================================================ */

import { firstMeaningfulLine } from './first-line.ts'

export interface TimelinePeriod {
  /** 源码里写的原文（可能是 `2022-2025`） */
  raw: string
  /** 解析出的数值；null = 源码里没有可用数字 */
  value: number | null
  events: string[]
}

export interface Timeline {
  title: string
  periods: TimelinePeriod[]
  /** 布局时是否因为「有周期认不出年份」而退回了等距 */
  fellBackToEven: boolean
  skipped: string[]
}

const NUM = /-?\d+(?:\.\d+)?/

export function parseTimeline(src: string): Timeline {
  const out: Timeline = { title: '', periods: [], fellBackToEven: false, skipped: [] }

  for (const raw of String(src || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    if (/^timeline\b/i.test(line)) continue

    const t = /^title\s+(.+)$/i.exec(line)
    if (t) { out.title = t[1].trim(); continue }

    /* 事件用 ` : ` 分隔，且**行尾的冒号**后面不该产生一个空事件 ——
       `2024 : 里程碑:` 会切出 ['', ''] 两个空串，第一版把它们画成了
       两个空格子。空段直接丢掉。 */
    const parts = line.split(':').map((p) => p.trim())
    const head = parts.shift() || ''
    const events = parts.filter(Boolean)
    if (!head) { out.skipped.push(line.slice(0, 40)); continue }

    const nums = head.match(new RegExp(NUM.source, 'g')) || []
    const value = periodValue(head, [...head.matchAll(new RegExp(NUM.source, 'g'))].map((m) => ({ text: m[0], at: m.index ?? 0 })))
    out.periods.push({ raw: head, value, events })
  }

  if (out.periods.some((p) => p.value == null)) out.fellBackToEven = true
  return out
}

/* 一个周期的数值坐标。
   ⚠️ 这里第一版是「把所有数字取平均当年份」，于是
      `2024 Q3` = (2024+3)/2 = 1013.5 而 `2025 Q1` = 1013 ——
      **2025 年的一季度被排到了 2024 年三季度前面**，整条时间线错位。
      而季度路线图恰恰是公司知识库里最常见的一类，所以这是硬伤不是边角。
   现在按「数字之间夹的是什么」分派：
     区间（`2022-2025`）→ 两端年份的中点
     季度（`2024 Q3` / `2024年3季度`）→ 年 + (q-1)/4
     月份（`2024-03` / `2024年3月`）→ 年 + (m-1)/12
     其它 → 就用年份本身，不猜 */
function periodValue(head: string, ms: Array<{ text: string; at: number }>): number | null {
  if (!ms.length) return null
  const y = Number(ms[0].text)
  if (ms.length === 1) return y

  /* 头两个数字**之间**的原文 —— 分隔符决定语义，不能只看数字大小。
     ⚠️ 用 matchAll 给的**真实位置**切，不能用 `head.indexOf(nums[1])`：
        nums[1] 自带前导负号时（`2022-2025` → ['2022','-2025']），
        indexOf 找到的位置和第一个数字的**结束位置相同**，切出来是空串，
        于是 `2022-2025` 判定不出区间、退化成 2022（应是中点 2023.5）。 */
  const rawSep = head.slice(ms[0].at + ms[0].text.length, ms[1].at)
  /* 数字自带的 `-` 其实是**分隔符**：`2022-2025` 被切成 ['2022','-2025']，
     于是两个数字之间切出来是空串，区间判定必然失败（退化成起始年 2022）。
     把它补回分隔符，区间才认得出来。 */
  const sep = ms[1].text.startsWith('-') ? `-${rawSep}` : rawSep

  /* ⚠️ 必须取绝对值。NUM 里带 `-?`，于是 `2024-03` 被切成 ['2024','-03']
     —— 那个 `-` 是**分隔符**不是负号。不取绝对值的话 n1 = -3，
     季度 / 月份 / 区间三个分支**一个都进不去**，直接退化成「年份就是 2024」，
     整条时间线的位置全错，而且没有任何报错。 */
  const n1 = Math.abs(Number(ms[1].text))
  if (/^[\s]*[-~–—至到][\s]*$/.test(sep) && n1 >= 1000) return (y + n1) / 2
  if (n1 >= 1 && n1 <= 4 && /[Qq季]/.test(head)) return y + (n1 - 1) / 4
  if (n1 >= 1 && n1 <= 12) return y + (n1 - 1) / 12
  return y
}

export function isTimelineSource(src: string): boolean {
  return /^timeline\b/i.test(firstMeaningfulLine(src))
}

/* ---------------- 渲染 ---------------- */

const PAD = 16
const EV_H = 24
const GAP = 6
const FONT = 11
const LABEL = 12

const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function textWidth(s: string, size: number): number {
  let w = 0
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0) || 0
    w += cp > 0xffff || /[\u2e80-\uffff]/.test(ch) ? size : size * 0.56
  }
  return w
}

function clip(s: string, size: number, maxW: number): string {
  if (maxW <= 0) return ''
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of String(s)) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out ? out + '…' : '…'
}

export function renderTimelineSvg(t: Timeline): string {
  if (!t.periods.length) return ''

  const periods = t.periods.slice().sort((a, b) => (a.value ?? 0) - (b.value ?? 0) || a.raw.localeCompare(b.raw))

  /* 最小列宽：至少放得下该列最宽的那段文字（事件或周期标签） */
  const colW = (p: TimelinePeriod) => {
    const ev = Math.max(0, ...p.events.map((e) => textWidth(e, FONT)))
    return Math.ceil(Math.max(ev + 20, textWidth(p.raw, LABEL) + 16, 72))
  }

  const vals = periods.map((p) => p.value).filter((v): v is number => v != null)

  /* 布局模型：**列宽固定，间隙按时间差成比例**。
     ⚠️ 第一版是「整条轴按年份比例缩放」，但轴长有个下限
        （所有列宽之和 + 间隙）。季度路线图这种**列多而时间跨度小**的输入
        （4 列 / 1.75 年）永远撞上下限 —— 于是三段的实际间距全被顶成一样宽，
        「按年份比例定位」**根本没发生**，而图看着完全正常。
        现在改成：列宽不变，`i→i+1` 的**间隙** = 时间差 × PX_PER_YEAR。
        这样 108 / 108 / 123 的比例在任何输入下都成立。 */
  const PX_PER_YEAR = 60
  const usable = !t.fellBackToEven && vals.length === periods.length

  /* 左右留白：周期标签与事件框都以刻度点**为中心**（text-anchor="middle"），
     紧挨着 x=PAD 画会**有一半落在 viewBox 外面被裁掉**（浏览器实测「2024 Q1」
     变成「024 Q…」）。所以留白至少要放得下最宽的那一条的一半。 */
  const halfLabel = Math.ceil(Math.max(...periods.map((p) => textWidth(p.raw, LABEL))) / 2)
  const maxColHalf = Math.ceil(Math.max(...periods.map(colW)) / 2)
  const LEFT = Math.ceil(Math.max(PAD, halfLabel, maxColHalf) + 4)

  const xs: number[] = []
  let x = LEFT
  periods.forEach((p, i) => {
    xs.push(x)
    const next = periods[i + 1]
    if (!next) return                                  // 最后一列后面没有间隙
    const d = usable ? next.value! - p.value! : 0
    x += colW(p) + GAP + (usable ? Math.round(d * PX_PER_YEAR) : GAP * 2)
  })

  /* 右侧同样留白 */
  const W = Math.ceil(xs[xs.length - 1] + Math.max(maxColHalf, halfLabel) + PAD)
  /* 竖向布局（三条边界必须**互不重叠**，浏览器实测踩到过）：
       · 事件栈最高处  = axisY − stackH − 10（给标题留位）
       · 最低那个事件框的**下沿** = axisY + BOX_BELOW
       · 周期标签的**基线**   = axisY + LABEL_BASE，字形顶 ≈ axisY + LABEL_BASE − 8.6
     ⚠️ 第一版把最低事件框放在 `axisY - 10`（下沿到 axisY + 14），
        而标签字形顶在 axisY + 9.4 —— **重叠 4.6px**；又因为事件是在标签
        **之后** push 的，白底框正好压住标签上半截。图看着像「标签被切了」，
        而 viewBox / H / CSS 全都算得没错 —— 只看坐标永远看不出来。 */
  const BOX_BELOW = 6
  const LABEL_BASE = 20
  const maxEvents = Math.max(...periods.map((p) => p.events.length), 0)
  const stackH = maxEvents * EV_H + Math.max(0, maxEvents - 1) * GAP
  const titleH = t.title ? 24 : 0
  const axisY = PAD + titleH + stackH + 10
  const warnH = t.fellBackToEven ? 16 : 0
  const H = axisY + LABEL_BASE + 6 + warnH

  const parts: string[] = []
  if (t.title) parts.push(`<text x="${PAD}" y="${PAD + 10}" class="yq-tl-title">${esc(clip(t.title, 14, W - PAD * 2))}</text>`)

  /* 轴线：从第一列到最后一列 */
  parts.push(`<line x1="${xs[0]}" y1="${axisY}" x2="${xs[xs.length - 1]}" y2="${axisY}" class="yq-tl-axis"/>`)

  periods.forEach((p, i) => {
    const x = xs[i]
    const w = colW(p)

    /* 刻度：dot + 竖线到最下面那个事件 */
    parts.push(`<circle cx="${x}" cy="${axisY}" r="3.5" class="yq-tl-dot"/>`)
    if (p.events.length) {
      const lowest = axisY + BOX_BELOW - EV_H - (p.events.length - 1) * (EV_H + GAP)
      parts.push(`<line x1="${x}" y1="${axisY}" x2="${x}" y2="${lowest}" class="yq-tl-stem"/>`)
    }
    parts.push(
      `<text x="${x}" y="${axisY + LABEL_BASE}" text-anchor="middle" class="yq-tl-period">` +
      `${esc(clip(p.raw, LABEL, Math.max(w, textWidth(p.raw, LABEL))))}</text>`
    )

    /* 事件自下而上堆叠（时间线惯例：越晚越靠上）。
       框**以刻度点为中心**：早先是从刻度点向右铺，于是最后一个框的右边缘
       越出 viewBox（bounds 检查实测 5 个用例全越界），而图看着只是「有点挤」。 */
    p.events.forEach((e, j) => {
      const y = axisY + BOX_BELOW - EV_H - (p.events.length - 1 - j) * (EV_H + GAP)
      parts.push(
        `<rect x="${x - w / 2}" y="${y}" width="${w}" height="${EV_H}" rx="5" class="yq-tl-event"/>` +
        `<text x="${x}" y="${y + EV_H / 2}" text-anchor="middle" dominant-baseline="middle" ` +
        `class="yq-tl-event-text">${esc(clip(e, FONT, w - 16))}</text>`
      )
    })
  })

  if (t.fellBackToEven) {
    parts.push(
      `<text x="${PAD}" y="${axisY + LABEL_BASE + 16}" class="yq-tl-warn">⚠️ 有周期认不出年份，已按等距摆放（时间间隔不代表真实长短）</text>`
    )
  }

  return (
    `<svg class="yq-tl-svg" viewBox="0 0 ${W} ${Math.ceil(H)}" width="${W}" height="${Math.ceil(H)}" ` +
    `role="img" aria-label="时间线">${parts.join('')}</svg>`
  )
}