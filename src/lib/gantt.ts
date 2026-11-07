/* ============================================================
   Gantt 甘特图（mermaid `gantt` 语法 / PlantUML 方言）→ 原生 SVG
   ------------------------------------------------------------
   为什么要做：语雀官方《如何插入文本绘图》的五种里，Gantt 是**最后一个
   完全没碰的**。而且它是这几种里**最便宜**的一种 —— 排期图本质上就是
   「时间轴 + 一行一个横条」，没有分层、没有成环、没有环回退，
   所以不需要图算法，纯线性布局就够。零依赖。

   覆盖范围**如实标注**：
     · 支持 dateFormat / title / section / 任务行
       （`名称 : [标签,] [id,] 起始, 时长`）、`after <id>`、crit/done/
       active/milestone 标签、日期跨 section 连号
     · 时长单位 d / w / h / m / s / ms
   **不支持**：exclude（排除日，语义要单独算）、多周分页、
     `until` 依赖、刻度自定义。认不出来的行进 `skipped`，
     界面上明说「不认的写法已跳过」，不静默画错。
   ============================================================ */

export interface GanttTask {
  id: string
  name: string
  section: string
  tags: string[]
  /** 归一化后的起止（毫秒）。`after` 依赖在解析末尾补算。 */
  start: number
  end: number
  /** 原始的 `after <id>` 引用（解析时记下，末尾统一补算） */
  afterRef: string
  /** 显式时长（毫秒）。**必须单独存** —— `after` 任务在补算前
      start/end 都还是 NaN，从 `end - start` 取时长只会拿到 NaN，
      于是条的长度变成 0，图上是一条看不见的线。 */
  dur: number
  /** 有没有被 `after` 推迟过 —— 推迟说明依赖没解算出来，要如实说 */
  unresolved: boolean
}

export interface Gantt {
  title: string
  dateFormat: string
  tasks: GanttTask[]
  skipped: string[]
}

/* ---------------- 日期 ---------------- */

const MS_DAY = 86400000
/** 时长单位 → **毫秒整数**。
 *  ⚠️ 这里必须是整数，不能写「天数再乘 86400000」：
 *     `30 * (1/1440) * 86400000` 出来是 1800000.0000000002。
 *     差值小到看不出，但它会一路带进日期算术，
 *     而**精确比较的断言会因此变成 flaky** —— 那种坑最难查。
 *  ⚠️ `m` 是「分」不是月 —— 写成月会让一条 `5m` 的任务横跨 5 个月，
 *     排期图直接画错，而且**看不出错在哪**。 */
const UNIT_MS: Record<string, number> = {
  ms: 1, s: 1000, m: 60000, h: 3600000, d: MS_DAY, w: 7 * MS_DAY,
}

/** `YYYY-MM-DD[ HH:mm[:ss]]` → 毫秒。认不出来返回 NaN（**不猜日期**）。 */
function parseDate(s: string, fmt: string): number {
  const t = String(s || '').trim()
  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t)
  if (ymd && /Y/i.test(fmt)) {
    return Date.UTC(+ymd[1], +ymd[2] - 1, +ymd[3], +(ymd[4] || 0), +(ymd[5] || 0), +(ymd[6] || 0))
  }
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t)
  if (dmy) {
    return Date.UTC(+dmy[3], +dmy[2] - 1, +dmy[1], +(dmy[4] || 0), +(dmy[5] || 0), +(dmy[6] || 0))
  }
  // 纯 ISO / 带 Z 的
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) {
    const ms = Date.parse(t)
    return Number.isNaN(ms) ? NaN : ms
  }
  return NaN
}

/** `3d` / `2w` / `12h` / `500ms` → 毫秒。认不出来返回 NaN。 */
function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/i.exec(String(s || '').trim())
  if (!m) return NaN
  const n = parseFloat(m[1])
  if (!Number.isFinite(n)) return NaN
  if (n < 0) return NaN
  const unit = UNIT_MS[(m[2] || 'd').toLowerCase()] ?? MS_DAY
  const ms = n * unit
  return Number.isInteger(ms) ? ms : Math.round(ms)   // 整数化，别把浮点误差带进日期算术
}

/* ---------------- 解析 ---------------- */

/** 标签里那些不是语义的词（它们出现在冒号后靠前位置）。 */
const KNOWN_TAGS = new Set(['done', 'active', 'crit', 'milestone', 'vert'])

export function parseGantt(src: string): Gantt {
  const out: Gantt = { title: '', dateFormat: 'YYYY-MM-DD', tasks: [], skipped: [] }
  let section = '未分组'

  for (const raw of String(src || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    if (/^(gantt|@startgantt)\b/i.test(line)) continue
    if (/^@endgantt\b/i.test(line)) continue          // 成对标记，不是「不认识的写法」

    const fmt = /^dateFormat\s+(\S+)/i.exec(line)
    if (fmt) { out.dateFormat = fmt[1]; continue }

    const title = /^title\s+(.+)$/i.exec(line)
    if (title) { out.title = title[1].trim(); continue }

    const sec = /^section\s+(.+)$/i.exec(line)
    if (sec) { section = sec[1].trim(); continue }

    /* exclude（日历排除）语义要单独算，不实现就明说，
       **不能当成普通行悄悄画一根条** */
    if (/^exclude\b/i.test(line)) {
      out.skipped.push(`exclude ${line.replace(/^exclude\s+/i, '').slice(0, 30)}（日历排除日未参与计算）`)
      continue
    }

    const colon = line.indexOf(':')
    if (colon < 0) { out.skipped.push(line.slice(0, 60)); continue }
    const name = line.slice(0, colon).trim()
    if (!name) { out.skipped.push(line.slice(0, 60)); continue }
    const parts = line.slice(colon + 1).split(',').map((p) => p.trim()).filter(Boolean)
    if (!parts.length) { out.skipped.push(line.slice(0, 60)); continue }

    /* 前缀里出现的已知标签先摘走，剩下的第一个裸 token 当 id */
    const tags: string[] = []
    let k = 0
    while (k < parts.length && KNOWN_TAGS.has(parts[k].toLowerCase())) {
      tags.push(parts[k].toLowerCase()); k++
    }
    let id = ''
    if (k < parts.length && !/^[\d]/.test(parts[k]) && !/^after\b/i.test(parts[k])) {
      id = parts[k]; k++
    }

    const afterM = /^after\s+(\S+)/i.exec(parts[k] || '')
    let start = NaN
    let endGiven = NaN
    let afterRef = ''
    if (afterM) {
      afterRef = afterM[1]
      start = NaN                                  // 末尾按依赖补算
      k++                                         // ⚠️ 必须前进，否则后面读到的还是 "after x"
    } else if (/^until\s+/i.test(parts[k] || '')) {
      out.skipped.push(`${name}：until 依赖未实现，整条没画`)
      continue
    } else {
      start = parseDate(parts[k] || '', out.dateFormat)
      k++
    }

    const durRaw = parts[k] || ''
    /* mermaid 允许最后一段写**结束日期**而不是时长：
         `需求确认 : done, r1, 2026-01-05, 2026-01-09`
       第一版把它当时长，parseDuration 返回 NaN，于是掉进「没写时长」
       分支被按 1 天画 —— 条短了 3 倍，**图看着还挺像那么回事**。 */
    const asEnd = parseDate(durRaw, out.dateFormat)
    if (Number.isFinite(asEnd)) {
      endGiven = asEnd
    }

    /* ⚠️ `0d` 是**合法**的 —— 那正是 mermaid 的 milestone（一个点）。
       写成 `dur <= 0 就报错` 会把里程碑整条丢掉，
       而「少了一个里程碑」的图看上去仍然完全正常。 */
    const durParsed = parseDuration(durRaw)
    let dur: number
    if (Number.isFinite(endGiven)) {
      dur = endGiven - start
      if (!Number.isFinite(dur) || dur < 0) dur = 0
    } else if (durRaw) {
      if (!Number.isFinite(durParsed) || durParsed < 0) {
        out.skipped.push(`${name}：时长「${durRaw}」认不出`)
        continue
      }
      dur = durParsed
    } else {
      /* 完全没写结束：mermaid 是「画到下一个任务」，那是依赖型布局，
         这里按**当天**收尾并如实标注 —— 不能默默画一根猜的条。 */
      dur = 0
      out.skipped.push(`${name}：没写时长/结束，按里程碑画`)
    }
    if (Number.isNaN(start) && !afterRef) {
      out.skipped.push(`${name}：起始「${parts[k - 1] || ''}」认不出`)
      continue
    }

    out.tasks.push({
      id: id || `t${out.tasks.length + 1}`,
      name, section, tags, afterRef, dur,
      start, end: Number.isFinite(endGiven) ? endGiven : start + dur, unresolved: false,
    })
  }

  resolveAfter(out)
  return out
}

/**
 * 补算 `after` 起始。
 *
 * ⚠️ 成环必须停手，不能靠「多迭代几轮」糊过去 —— 和 flowchart 分层那次
 *   一个毛病：环上每轮都涨，跑满也不收敛，最后把条推到几百年后。
 *   这里每条依赖只解算一次，解不出就标 `unresolved`，
 *   **界面上明说「这条没排进去」**，而不是画一个位置错掉的条。
 */
function resolveAfter(g: Gantt) {
  const byId = new Map(g.tasks.map((t) => [t.id, t]))
  const waiting = g.tasks.filter((t) => t.afterRef)
  if (!waiting.length) return

  // 按依赖深度分层解算（最多 |tasks| 层，够用且不会死循环）
  for (let round = 0; round <= g.tasks.length; round++) {
    const left: GanttTask[] = []
    for (const t of waiting) {
      const ref = byId.get(t.afterRef)
      if (ref && Number.isFinite(ref.start) && !ref.unresolved) {
        t.start = ref.end
        t.end = ref.end + t.dur          // 用显式存的 dur，别从 NaN 里反推
      } else {
        left.push(t)
      }
    }
    if (!left.length) return
    if (left.length === waiting.length) break           // 这一轮一个都没解开 → 环或引用不存在
    waiting.length = 0
    waiting.push(...left)
  }
  for (const t of waiting) {
    t.unresolved = true
    g.skipped.push(`${t.name}：after ${t.afterRef} 解不出来（找不到引用或成环），没排进时间轴`)
  }
}

/* ---------------- 渲染 ---------------- */

const ROW_H = 30
const BAR_H = 16
/** 头部要同时放下**标题**和**时间轴刻度**。第一版给 34，
 *  两者只差 8px，而字号是 14 和 9 —— 于是标题和第一个刻度标签
 *  挤在同一行，看着像两段文字连在一起。50 才放得开。 */
const HEAD_H = 50
const PAD = 18
const LABEL_W = 150
const MIN_W = 320
/** ⚠️ 右边必须给**一个日期标签**留位。
 *  最右一格的网格线画在 `LABEL_W + PAD + (axisW - 24)`，而标签画在 `gx + 3`
 *  —— 它往右伸出去约 53px（`2026-01-21` @ 10px）。原先画布右缘只比它多留
 *  `PAD + 24 = 42`，于是**最右那个日期被切掉一截**，界面上是 `2026-01-2`。
 *  实测（浏览器 getBBox，非估算）：右端 809 / viewBox 宽 798，**超出 11px**。
 *  这条以前没有断言守着 —— 套件只断「刻度画了」，没断「刻度放得下」。
 *  导出给套件用：断言要拿**这两个真常量**去比，不能在测试里另写 58 / 3。
 *  ⚠️ 两者的关系不能各记一半：`TICK_W` 是**从网格线**起算的预留宽度，
 *  而 <text> 的 x 是网格线 + TICK_TEXT_DX。把 TICK_W 加在 text.x 上会**重复算**
 *  那 3px（我第一版就是这么写的，短跨度图差 3px 假红）。 */
export const TICK_W = 58
export const TICK_TEXT_DX = 3
const TITLE_Y = PAD + 10
const TICK_Y = PAD + HEAD_H - 20

const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 粗略量文字宽度：中文按字号，西文 0.56 字号。只用来定框宽。 */
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

const ymd = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}

/** 甘特图 → SVG。任务按 section 分组，section 之间留一条分隔线。 */
export function renderGanttSvg(g: Gantt): string {
  const tasks = g.tasks.filter((t) => Number.isFinite(t.start) && Number.isFinite(t.end))
  if (!tasks.length) return ''

  const t0 = Math.min(...tasks.map((t) => t.start))
  const t1 = Math.max(...tasks.map((t) => t.end))
  const span = Math.max(1, t1 - t0)

  /* 时间轴刻度：按跨度自动选 1/2/3/7 天一格，别刻度挤成一团 */
  const days = span / MS_DAY
  const steps = [1, 2, 3, 7, 14, 30, 60, 90, 180, 365]
  const stepDays = steps.find((s) => days / s <= 12) ?? 365
  const stepMs = stepDays * MS_DAY
  const axisW = Math.max(MIN_W, Math.ceil(span / stepMs) * 74 + 20)
  const x = (ms: number) => LABEL_W + PAD + ((ms - t0) / span) * (axisW - 24)

  /* 行：section 标题行 + 任务行 */
  const rows: Array<{ kind: 'section' | 'task'; label: string; task?: GanttTask }> = []
  let last = ''
  for (const t of tasks) {
    if (t.section !== last) { rows.push({ kind: 'section', label: t.section }); last = t.section }
    rows.push({ kind: 'task', label: t.name, task: t })
  }
  const totalH = PAD * 2 + HEAD_H + rows.length * ROW_H + 24
  /* 画布右缘 = 最后一格网格线 + TICK_W（留给那个日期标签）。
   以前是 `LABEL_W + PAD * 2 + axisW`，右边只剩 `PAD + 24`，
   放不下 `2026-01-21` 这种 10 字符的标签 —— 最右一格被切。 */
const w = LABEL_W + PAD + (axisW - 24) + TICK_W

  const parts: string[] = []
  /* 刻度 */
  for (let ms = Math.floor(t0 / stepMs) * stepMs; ms <= t1; ms += stepMs) {
    const gx = x(ms)
    if (gx > LABEL_W + PAD + axisW - 6) break
    parts.push(
      `<line x1="${gx}" y1="${TICK_Y + 4}" x2="${gx}" y2="${totalH - PAD}" class="yq-gantt-grid"/>` +
      `<text x="${gx + TICK_TEXT_DX}" y="${TICK_Y}" class="yq-gantt-tick">${esc(ymd(ms))}</text>`
    )
  }

  rows.forEach((r, i) => {
    const y = PAD + HEAD_H + i * ROW_H
    if (r.kind === 'section') {
      parts.push(
        `<text x="${PAD}" y="${y + ROW_H / 2}" dominant-baseline="middle" class="yq-gantt-section">${esc(clip(r.label, 12, LABEL_W))}</text>` +
        `<line x1="${PAD}" y1="${y + ROW_H - 1}" x2="${w - PAD}" y2="${y + ROW_H - 1}" class="yq-gantt-grid"/>`
      )
      return
    }
    const t = r.task!
    const bx = x(t.start)
    const bw = Math.max(3, x(t.end) - bx)
    /* 里程碑：打了 milestone 标签，**或者时长就是 0**（`0d` 是合法写法）。
       只认标签的话，`m1, 2026-02-02, 0d` 这种最常见的写法会被画成
       一个 3px 的小条 —— 看着像一条线，不像一个事件。 */
    const isMs = t.tags.includes('milestone') || t.dur === 0
    const by = y + (ROW_H - BAR_H) / 2
    const cls = isMs ? 'yq-gantt-ms' : t.tags.includes('crit') ? 'yq-gantt-crit'
      : t.tags.includes('done') ? 'yq-gantt-done' : t.tags.includes('active') ? 'yq-gantt-active' : 'yq-gantt-bar'
    /* 标签画在**条的上方**而不是条里 —— 排期图里任务名普遍比条长，
       塞进条里必然溢出成一团糊。 */
    parts.push(
      `<text x="${PAD}" y="${by + BAR_H / 2}" dominant-baseline="middle" class="yq-gantt-name">${esc(clip(t.name, 11, LABEL_W - 8))}</text>`
    )
    if (isMs) {
      const cxp = bx, cyp = by + BAR_H / 2
      parts.push(`<polygon points="${cxp},${cyp - 8} ${cxp + 8},${cyp} ${cxp},${cyp + 8} ${cxp - 8},${cyp}" class="${cls}"/>`)
    } else {
      parts.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${BAR_H}" rx="3" class="${cls}"/>`)
    }
    parts.push(
      `<text x="${bx + (isMs ? 12 : 0)}" y="${by - 3}" class="yq-gantt-range">${esc(ymd(t.start))}${bw > 70 ? ` → ${esc(ymd(t.end))}` : ''}</text>`
    )
  })

  const title = g.title
    ? `<text x="${PAD}" y="${TITLE_Y}" class="yq-gantt-title">${esc(clip(g.title, 14, w - PAD * 2))}</text>`
    : ''

  return `<svg class="yq-gantt-svg" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(totalH)}" width="${Math.ceil(w)}" height="${Math.ceil(totalH)}" role="img" aria-label="甘特图">` +
    title + parts.join('') + `</svg>`
}

/** 一眼看出这份源码是不是甘特图 */
export function isGanttSource(src: string): boolean {
  const t = String(src || '').trim()
  if (/^@startgantt\b/i.test(t)) return true
  return /^(gantt|@startgantt)\b/i.test(t)
}