/* ============================================================
   Mermaid `pie`（饼图）→ 原生 SVG
   ------------------------------------------------------------
   为什么做：官方五种里剩下的几种（类图 / 实体关系图 / 甘特图 /
   用户旅程 / 时间线）都需要**专属的视觉语言** —— 类图要隔层盒子和
   继承三角，实体关系图要乌鸦脚。硬做很容易变成「看着像画对了、
   其实关系符号是错的」，比不做更糟（状态图复合态那个框就是前车之鉴）。
   饼图**没有这种陷阱**：就是时间轴之外最简单的几何，所以先做它。

   ⚠️ **不能复用 flowchart**：实测把 `pie` 源码喂进 `parseFlowchart`
     只得到 1 个叫「pie」的节点，三行 `"名称" : 数值` 全进 skipped。

   覆盖范围**如实标注**：
     · 支持 pie / pie showData / `pie title 标题` / `名称 : 数值`
       / 带引号与不带引号的名称 / 0 值条目
   **不支持**：`pie showData` 的**显示方式**（值照样显示在图例里）、
     负值（mermaid 也不支持）、多张饼图同图。
     负值与非法数值进 `skipped`，界面上明说，不静默丢。

   配色用**同一主色的深浅档**，不引色板也不造新 token ——
   本项目最看重「内网机器上少一个依赖」。
   ============================================================ */

import { firstMeaningfulLine } from './first-line.ts'

export interface PieSlice {
  label: string
  value: number
  /** 0..1，色档序号 */
  tone: number
}

export interface PieChart {
  title: string
  slices: PieSlice[]
  skipped: string[]
}

/** 8 档色深。够覆盖常见分类数，又不用引色板。 */
const TONES = 8

export function parsePie(src: string): PieChart {
  const out: PieChart = { title: '', slices: [], skipped: [] }
  let i = 0

  for (const raw of String(src || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    if (/^pie\b/i.test(line)) {
      // `pie` / `pie showData` / `pie title 分布`
      const t = /^pie\b\s*(?:showData\s*)?(?:title\s+(.+))?$/i.exec(line)
      if (t?.[1]) out.title = t[1].trim()
      continue
    }
    if (/^title\b/i.test(line)) { out.title = line.replace(/^title\s+/i, '').trim(); continue }

    // `"名称" : 数值` 或 `名称 : 数值`
    const m = /^("([^"]*)"|[^:]+?)\s*:\s*(-?\d+(?:\.\d+)?)\s*$/.exec(line)
    if (!m) { out.skipped.push(line.slice(0, 40)); continue }
    const label = (m[2] ?? m[1]).trim() || '(未命名)'
    const value = Number(m[3])
    if (!Number.isFinite(value)) { out.skipped.push(`${label}：数值认不出`); continue }
    /* 负值：饼图的扇形面积与半径方向相反，画出来是**镜像的假扇区**。
       明确拒掉并报出来 —— 第一版把它当 0，界面上看着「有这一项」，
       而实际上那一块根本不画。 */
    if (value < 0) { out.skipped.push(`${label}：负值（${value}）饼图画不了`); continue }
    out.slices.push({ label, value, tone: i++ % TONES })
  }
  return out
}

/** 一眼看出这份源码是不是饼图 */
export function isPieSource(src: string): boolean {
  return /^pie\b/i.test(firstMeaningfulLine(src))
}

/* ---------------- 渲染 ---------------- */

const SIZE = 320
const PAD = 20
const LEGEND_ROW = 22

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

const OPACITY = (tone: number) => 1 - tone * 0.11

export function renderPieSvg(p: PieChart): string {
  const total = p.slices.reduce((a, s) => a + s.value, 0)
  if (!p.slices.length || total <= 0) return ''

  const cx = SIZE / 2
  const cy = SIZE / 2
  const r = SIZE / 2 - 4
  const parts: string[] = []

  /* 扇形角度从 12 点开始、顺时针（屏幕坐标 y 向下，正角度就是顺时针）。
     整圆那一片（占比 100%）特殊处理：path 的两段弧同起同止会画不出来，
     所以走「两个半圆 + 一条直径」的路子。 */
  let a0 = -Math.PI / 2
  for (const s of p.slices) {
    const frac = s.value / total
    const sweep = frac * Math.PI * 2
    const a1 = a0 + sweep
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0)
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1)
    const large = sweep > Math.PI ? 1 : 0
    const d = frac >= 0.9999
      ? `M${cx},${cy - r} A${r},${r} 0 1 1 ${cx},${cy + r} A${r},${r} 0 1 1 ${cx},${cy - r} Z`
      : `M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} Z`
    parts.push(`<path d="${d}" class="yq-pie-slice" fill-opacity="${OPACITY(s.tone).toFixed(2)}"/>`)
    a0 = a1
  }

  /* 图例放在饼**右侧**竖排：中文标签通常比数字长，
     放下面横排会把每行撑得很宽，图和文字抢地方。 */
  const legendX = SIZE + 14
  const rows = p.slices
  const legendH = rows.length * LEGEND_ROW
  const maxLabel = Math.max(...rows.map((s) => textWidth(s.label, 12)), 40)
  const w = legendX + 14 + maxLabel + 56
  const h = Math.max(SIZE, legendH) + PAD * 2 + (p.title ? 20 : 0)

  rows.forEach((s, i) => {
    const y = PAD + (p.title ? 20 : 0) + i * LEGEND_ROW + LEGEND_ROW / 2
    const pct = Math.round((s.value / total) * 1000) / 10
    parts.push(
      `<rect x="${legendX}" y="${y - 6}" width="12" height="12" rx="2" class="yq-pie-slice" fill-opacity="${OPACITY(s.tone).toFixed(2)}"/>` +
      `<text x="${legendX + 18}" y="${y}" dominant-baseline="middle" class="yq-pie-legend">${esc(clip(s.label, 12, maxLabel))}</text>` +
      `<text x="${legendX + 18 + maxLabel + 10}" y="${y}" dominant-baseline="middle" class="yq-pie-value">${s.value}（${pct}%）</text>`
    )
  })

  const title = p.title
    ? `<text x="${PAD}" y="${PAD + 8}" class="yq-pie-title">${esc(clip(p.title, 14, w - PAD * 2))}</text>`
    : ''

  return `<svg class="yq-pie-svg" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}" width="${Math.ceil(w)}" height="${Math.ceil(h)}" role="img" aria-label="饼图">` +
    title + `<g transform="translate(0, ${p.title ? 16 : 0})">${parts.join('')}</g></svg>`
}