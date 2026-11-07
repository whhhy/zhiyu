/* ============================================================
   文本绘图：这段源码该走哪条渲染路
   ------------------------------------------------------------
   ⚠️ 这个判定**只能住在这里**，不许在卡片组件里再写一遍。
      理由不是洁癖，是后果：选错分支会**画出一张完全不相干的图**，
      而界面上看不出「认错了」，只显得「图画怪」——
      用户不会想到去查路由，只会以为自己的源码写错了。

   语法家族与优先级（顺序有讲究）：
     ① PlantUML 家族（`@startuml` / `@startmind` / `@startjson` …）
        ⚠️ 必须**先**判，否则会被当成同名图种（`@startgantt` vs `gantt`）。
     ② Graphviz DOT（`digraph {` / `graph G {`）
     ③ Mermaid（图种由 mermaid.ts 判，流程图与时序图本地能画）
     ④ Gantt（`gantt` / `@startgantt`，由 gantt.ts 判）
     ⑤ 兜底：按 PlantUML 给结构预览（而不是「认不出」）

   ⚠️ Gantt 放在 mermaid 判定**之后**：mermaid 也有 `gantt` 图种，
      而它那份带 exclude/多周分页，本地渲染器做不了；
      真要渲染就自己那套语法，两边不能互相抢。
   ============================================================ */

import { detectMermaid } from './mermaid.ts'
import { isDotSource } from './dot.ts'
import { isGanttSource } from './gantt.ts'
import { isStateDiagramSource } from './statediagram.ts'
import { isMindmapSource } from './mindmap.ts'
import { isPieSource } from './pie.ts'
import { isClassDiagramSource } from './classdiagram.ts'
import { isErDiagramSource } from './erdiagram.ts'
import { isJourneySource } from './journey.ts'
import { isTimelineSource } from './timeline.ts'
import { isSankeySource } from './sankey.ts'

export type DiagramMode =
  | 'empty' | 'uml' | 'flow' | 'seq' | 'dot' | 'gantt' | 'state' | 'mind' | 'pie' | 'class' | 'er'
  | 'journey' | 'timeline' | 'sankey'
  | 'unsupported'

const PLANTUML_FAMILY = /^\s*@start(uml|mind|json|wbs)/i

/** 本地直接出 SVG 的几种（界面只对这几种说「本地渲染」） */
export const LOCALLY_RENDERED_MODES: DiagramMode[] =
  ['flow', 'seq', 'dot', 'gantt', 'state', 'mind', 'pie', 'class', 'er', 'journey', 'timeline', 'sankey']

export function pickDiagramMode(src: string): DiagramMode {
  const text = String(src || '')
  if (!text.trim()) return 'empty'
  if (PLANTUML_FAMILY.test(text)) return 'uml'
  if (isDotSource(text)) return 'dot'
  const mk = detectMermaid(text)
  if (mk === 'flowchart') return 'flow'
  if (mk === 'sequence') return 'seq'
  /* ⚠️ 这里原来多了一个 `mk === 'unknown'` 条件，**甘特图从来没被路由到过**。
     `detectMermaid('gantt\n…')` 返回的是 `'gantt'`（mermaid 自己有这个图种），
     所以 `mk === 'unknown'` 恒假 → 一路落到下面 `if (mk !== 'unknown')` →
     `unsupported`。后果不是「某个写法不认」，是**整个功能用户看不到**：
       · 套件 43 项全绿 —— 因为它们只断 `parseGantt` / `renderGanttSvg` /
         `isGanttSource`，**从不调 `pickDiagramMode`**，静态预览页更是直接
         `renderGanttSvg(parseGantt(src))` 把路由整个绕过去了；
       · 产品自己的「填入 Gantt 示例」按钮加载的就是 `gantt` 源码，
         点下去得到一张写着「Mermaid 甘特图（未实现）」的卡。

     当时加这道闸是怕 mermaid 的 `exclude` / 多周分页画出来**时间不对**
     （README 也跟着写了「硬画会画出时间不对的排期图」）。那个顾虑已经被
     `parseGantt` 的 skipped 挡住了：`exclude` / `until` / 认不出的日期时长 /
     解不出的 after 全部进 skipped，并在卡片上逐条说明（见 gantt.ts）。
     所以这是道多余的闸，删掉它。 */
  if (isGanttSource(text)) return 'gantt'
  // stateDiagram 交给自己的解析器 —— 直接喂给 parseFlowchart 会造出
  // 「凭空多出来的方框 + 少一半线」，而界面上看不出是认错了
  if (mk === 'state' || isStateDiagramSource(text)) return 'state'
  // mindmap 同理：它是**缩进树**，边得由缩进推出来，
  // 而 flowchart 的边来自源码里的 `A-->B` —— 喂过去会得到一堆**没有连线**的方框
  if (mk === 'mindmap' || isMindmapSource(text)) return 'mind'
  if (mk === 'pie' || isPieSource(text)) return 'pie'
  if (mk === 'class' || isClassDiagramSource(text)) return 'class'
  if (mk === 'er' || isErDiagramSource(text)) return 'er'
  if (mk === 'journey' || isJourneySource(text)) return 'journey'
  if (mk === 'timeline' || isTimelineSource(text)) return 'timeline'
  /* sankey 在 mermaid 里是 `sankey-beta`，也接受不带 -beta 的写法；
     这里同时判 mk 与 isSankeySource，是为了**不依赖 KIND_RE 的写法顺序**。 */
  if (mk === 'sankey' || isSankeySource(text)) return 'sankey'
  if (mk !== 'unknown') return 'unsupported'
  return 'uml'                              // 既不是 PlantUML 也不是 DOT/mermaid：按 PlantUML 兜底
}