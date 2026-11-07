/* ============================================================
   Mermaid `journey`（用户旅程图）→ 原生 SVG
   ------------------------------------------------------------
   为什么值得做：用户旅程是**内网文档里真实会出现的**那一类
   （上线复盘、客服工单链路、新人入职流程），而它结构上最简单：
   「一串按 section 分组的任务，每项带一个 0–5 的评分和参与者」。

   ⚠️ 为什么**竖着排**而官方是横着波浪排：官方那种横排宽度随任务数
      线性增长，十几项就把 SVG 撑到几千 px，内网文档里横向滚动条
      比纵向长文档难受得多。竖排 + section 色带读起来一样清楚。

   ⚠️ 评分**不画人脸**：官方用 5 张脸表示分数，而「脸」是**语义本身**
      —— 笑/无表情/哭 各自对应一个区间，画错就是读错满意度。
      这里画「五格填充条 + 数字」，一个格子就是一分，不存在解释空间。

   语法：
     journey
         title 上线复盘
         section 发布
           联调: 4: 张三
           压测: 2: 张三, 李四
         section 回滚
           定位: 5: 李四

   **不支持**：`%%` 之外的注释写法、任务的富文本、`task: score: actor`
   之外的变体。认不出来的行进 `skipped`，界面上明说，不静默丢。
   ============================================================ */

import { firstMeaningfulLine } from './first-line.ts'

export interface JourneyTask {
  name: string
  /** 0..5；源码没写就是 null（不是 0 —— 「没评分」和「评了 0 分」不是一回事） */
  score: number | null
  /** 源码写了但超出 0–5：任务照画，评分**不画**并记一笔实话 */
  scoreRejected: string
  actors: string[]
}

export interface JourneySection {
  title: string
  tasks: JourneyTask[]
}

export interface Journey {
  title: string
  sections: JourneySection[]
  skipped: string[]
}

export function parseJourney(src: string): Journey {
  const out: Journey = { title: '', sections: [], skipped: [] }
  let cur: JourneySection | null = null

  for (const raw of String(src || '').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('%%')) continue
    if (/^journey\b/i.test(line)) continue

    const t = /^title\s+(.+)$/i.exec(line)
    if (t) { out.title = t[1].trim(); continue }

    const sec = /^section\s+(.+)$/i.exec(line)
    if (sec) { cur = { title: sec[1].trim(), tasks: [] }; out.sections.push(cur); continue }

    /* 任务行 `名称[: 分数][: 参与者, 参与者]`
       ⚠️ 这里**故意用 split(':') 而不是一组正则捕获** ——
          「名称里也可能带冒号」与「参与者多人」两个需求叠在一起时，
          按组号取值非常容易错位（类图/实体关系图已经在这上面栽过两次）。

       三段的中间那个字段有歧义，判据必须写死：
         · 中间段是数字      → 它是分数（0–5）
         · 中间段不是数字、且**只有两段** → 它是参与者（`任务: 参与者`）
         · 中间段不是数字、且**有三段**  → 它是**任务名的一部分**
           （`时间: 下午三点: 我`）。第一版按「第二段一定是参与者」处理，
           于是「下午三点」被**静默丢弃** —— 界面上任务名只剩「时间」，
           没人看得出少了一截。宁可把名字接回去，也不能悄悄少字。 */
    const parts = line.split(':')
    let name = (parts[0] || '').trim()
    if (!name) { out.skipped.push(line.slice(0, 40)); continue }

    let score: number | null = null
    let scoreRejected = ''
    let actorsRaw = ''

    if (parts.length >= 2) {
      const second = parts[1].trim()
      /* ⚠️ 负号**必须**收进这个判断里：`-1` 不匹配数字时会被当成参与者名，
         界面上那个「负分任务」看起来就是一条普通任务，没有异常也没有提示。 */
      if (/^-?\d+(?:\.\d+)?$/.test(second)) {
        const v = Number(second)
        if (v < 0 || v > 5) {
          scoreRejected = `${name}：分数 ${second} 超出 0–5，评分没画`
        } else if (!Number.isInteger(v)) {
          /* 官方评分就是整数。静默取整 = 图上是 5、源码写 4.6 ——
             数据被改却没有任何提示，所以取整这件事必须说出来。 */
          const r = Math.round(v)
          score = r
          scoreRejected = `${name}：分数 ${second} 不是整数，图中按 ${r} 画`
        } else {
          score = v
        }
      } else if (parts.length >= 3) {
        name = `${name}: ${second}`
      } else {
        actorsRaw = second
      }
    }
    if (parts.length >= 3) actorsRaw = parts.slice(2).join(':')

    const task: JourneyTask = {
      name,
      score,
      scoreRejected,
      actors: actorsRaw ? actorsRaw.split(',').map((a) => a.trim()).filter(Boolean) : [],
    }
    if (scoreRejected) out.skipped.push(scoreRejected)

    /* 没有 section 的任务归到一个匿名分组 —— 官方也允许不写 section，
       直接扔掉等于丢内容。 */
    if (!cur) { cur = { title: '', tasks: [] }; out.sections.push(cur) }
    cur.tasks.push(task)
  }

  /* 空分组（只有 section 标题、没任务）不画 —— 画一条空色带像是出错了 */
  out.sections = out.sections.filter((s) => s.tasks.length)
  return out
}

/** 一眼看出这份源码是不是用户旅程图 */
export function isJourneySource(src: string): boolean {
  return /^journey\b/i.test(firstMeaningfulLine(src))
}

/* ---------------- 渲染 ---------------- */

const PAD = 16
const SPINE_X = 26
const NODE_X = 48
const NODE_H = 46
const SEC_H = 26
const GAP = 8
const FONT = 12
const SUB = 10

const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function textWidth(s: string, size: number): number {
  let w = 0
  /* 中西文宽度差一倍多：中文按字号算，西文按 0.56 × 字号算。
     按**字符个数**估宽会让中文标签算窄一大截，于是被裁成「知…」——
     脑图的根名就是这么被裁掉的，所以这里必须按字符分别算。
     ⚠️ emoji（> U+FFFF，如 👤）按**整个字号**算：按西文那档算会低估，
     而参与者是右对齐的（text-anchor="end"），估窄了文字就往左压到评分条上。 */
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0) || 0
    w += cp > 0xffff || /[\u2e80-\uffff]/.test(ch) ? size : size * 0.56
  }
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

export function renderJourneySvg(j: Journey): string {
  const tasks = j.sections.reduce((a, s) => a + s.tasks.length, 0)
  if (!tasks) return ''

  const widestName = Math.max(...j.sections.flatMap((s) => s.tasks.map((t) => textWidth(t.name, FONT))))
  const widestActor = Math.max(
    0,
    ...j.sections.flatMap((s) => s.tasks.map((t) => textWidth('👤 ' + t.actors.join('、'), SUB))),
  )
  const widestSec = Math.max(...j.sections.map((s) => textWidth(s.title || '（未命名阶段）', SUB + 1)))

  /* 节点宽度取「名字放得下」与「评分条 + 参与者放得下」的较大者：
     只按名字算的话，参与者一多就被裁成「👤 张…」，而参与者恰恰是
     旅程图里「谁参与」这条信息本身。 */
  const needByName = widestName + 24
  const needByActor = widestActor + 24 + 92          // 92 = 五格评分条 + 数字 + 间隙
  const needBySec = widestSec + 20
  const nodeW = Math.min(460, Math.max(200, Math.ceil(Math.max(needByName, needByActor))))
  const W = Math.max(NODE_X + nodeW + PAD, needBySec + PAD * 2)
  const H =
    PAD + (j.title ? 24 : 0) +
    j.sections.reduce((a, s) => a + SEC_H + GAP + s.tasks.length * (NODE_H + GAP), 0)

  let y = PAD + (j.title ? 24 : 0)
  const dots: number[] = []
  const parts: string[] = []
  if (j.title) {
    parts.push(`<text x="${PAD}" y="${PAD + 10}" class="yq-journey-title">${esc(clip(j.title, 14, W - PAD * 2))}</text>`)
  }

  for (const sec of j.sections) {
    parts.push(
      `<rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="${SEC_H}" rx="5" class="yq-journey-section"/>` +
      `<text x="${PAD + 10}" y="${y + SEC_H / 2}" dominant-baseline="middle" class="yq-journey-section-label">` +
      `${esc(clip(sec.title || '（未命名阶段）', SUB + 1, W - PAD * 2 - 20))}</text>`
    )
    y += SEC_H + GAP

    for (const t of sec.tasks) {
      const cy = y + NODE_H / 2
      dots.push(cy)
      parts.push(
        `<rect x="${NODE_X}" y="${y}" width="${nodeW}" height="${NODE_H}" rx="6" class="yq-journey-node"/>` +
        `<text x="${NODE_X + 12}" y="${y + 17}" class="yq-journey-name">${esc(clip(t.name, FONT, nodeW - 24))}</text>`
      )

      /* 评分：五格填充条 + 数字。一格一分，不画人脸。 */
      let bx = NODE_X + 12
      if (t.score != null) {
        const bar: string[] = []
        for (let i = 0; i < 5; i++) {
          bar.push(
            `<rect x="${bx + i * 11}" y="${y + NODE_H - 17}" width="8" height="8" rx="1.5" ` +
            `class="yq-journey-score${i < t.score ? ' on' : ''}"/>`
          )
        }
        parts.push(bar.join(''))
        parts.push(
          `<text x="${bx + 5 * 11 + 6}" y="${y + NODE_H - 13}" dominant-baseline="middle" class="yq-journey-score-text">${t.score}/5</text>`
        )
        bx += 5 * 11 + 6 + textWidth(`${t.score}/5`, SUB) + 12
      }

      if (t.actors.length) {
        parts.push(
          `<text x="${NODE_X + nodeW - 12}" y="${y + NODE_H - 13}" text-anchor="end" dominant-baseline="middle" ` +
          `class="yq-journey-actor">${esc(clip('👤 ' + t.actors.join('、'), SUB, Math.max(0, nodeW - 24 - (bx - NODE_X))))}</text>`
        )
      }
      y += NODE_H + GAP
    }
  }

  /* 脊柱：**一整条**线（首尾任务的中点之间），不是每行画一段 ——
     分段画会出现首尾各多出半截、以及任务数为 1 时那条线长度取负。 */
  const spine =
    dots.length > 1
      ? `<line x1="${SPINE_X}" y1="${dots[0]}" x2="${SPINE_X}" y2="${dots[dots.length - 1]}" class="yq-journey-spine"/>`
      : ''
  const dotEls = dots.map((cy) => `<circle cx="${SPINE_X}" cy="${cy}" r="3" class="yq-journey-dot"/>`).join('')

  return (
    `<svg class="yq-journey-svg" viewBox="0 0 ${Math.ceil(W)} ${Math.ceil(H)}" width="${Math.ceil(W)}" height="${Math.ceil(H)}" role="img" aria-label="用户旅程图">` +
    spine + dotEls + parts.join('') +
    `</svg>`
  )
}