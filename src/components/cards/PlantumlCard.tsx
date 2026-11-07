import { CardShell, MiniBtn, SyncTextarea } from './common'
import { parseFlowchart, renderFlowchartSvg, type Flowchart } from '@/lib/flowchart'
import { parseDot } from '@/lib/dot'
import { parseGantt, renderGanttSvg, type Gantt } from '@/lib/gantt'
import { parseStateDiagram } from '@/lib/statediagram'
import { parseMindmap, renderMindmapSvg, type Mindmap } from '@/lib/mindmap'
import { parsePie, renderPieSvg, type PieChart } from '@/lib/pie'
import { parseClassDiagram, renderClassDiagramSvg, type ClassDiagram } from '@/lib/classdiagram'
import { parseErDiagram } from '@/lib/erdiagram'
import { parseJourney, renderJourneySvg, type Journey } from '@/lib/journey'
import { parseTimeline, renderTimelineSvg, type Timeline } from '@/lib/timeline'
import { parseSankey, renderSankeySvg, type Sankey } from '@/lib/sankey'
import { parseSequence, renderSequenceSvg, detectMermaid, mermaidLocalNotice, KIND_LABEL, type Sequence, type MermaidKind } from '@/lib/mermaid'
import { pickDiagramMode, type DiagramMode } from '@/lib/diagram'
import type { CardProps } from './types'

interface PlantData {
  src?: string
  img?: string
}

const SAMPLE = `@startuml
skinparam monochrome true
actor 用户
participant 网关
database 订单库
用户 -> 网关 : 下单
网关 -> 订单库 : 写入订单
订单库 --> 用户 : 返回订单号
@enduml`

/* 语雀官方《如何插入文本绘图》列的是 PlantUML / Mermaid / Flowchart /
   Graphviz / Gantt 五种。这里的覆盖范围是**如实标注**的：
     · PlantUML（`@startuml` 开头）—— 真渲染要 PlantUML Server（联网），
       所以只给**结构**预览，界面上明写「这不是渲染图」，不假装；
     · **其余 12 种全部本地直接出 SVG**（零依赖）。清单以
       `LOCALLY_RENDERED_MODES` 为准，**不要在这里另抄一份** —— 抄的必然过期：
       流程图 / 时序图 / Graphviz DOT / Gantt / 状态图 / 脑图 / 饼图 /
       类图 / 实体关系图 / 用户旅程图 / 时间线 / 桑基图；
     · Mermaid 里**还没做**的那些图种（xychart / gitGraph / …）走 `unsupported`，
       界面明说差哪一种，不假装出图。

   ⚠️ 这条注释原来写的是「Mermaid 其余图种（类图 / 状态图 / 饼图 / 甘特图…）**未实现**」
   加「Graphviz / Gantt 仍未实现」。那是 2026-10-06 之前的状态：那五种**后来全都实现了**，
   实现代码就在同一个文件下面的 CYCLES 里躺着。注释比代码旧，后果不是「不好看」——
   它会让下一个人以为这功能没做而去查一个已经修好的地方。
   **判据一律看 `LOCALLY_RENDERED_MODES`，不要看注释。** */
const FLOW_SAMPLE = `graph TD
    A([开始]) --> B{审核通过吗}
    B -->|是| C[生成正式文档]
    B -->|否| D[(退回队列)]
    C --> E([完成])
    D -.-> A`

const SEQ_SAMPLE = `sequenceDiagram
    autonumber
    actor 用户
    participant 网关 as GW
    database 订单库
    用户->>GW: 提交订单
    GW->>+订单库: 写入订单
    订单库-->>-GW: 返回订单号
    alt 库存充足
        GW-->>用户: 下单成功
    else 库存不足
        GW--x用户: 缺货
    end`

const DOT_SAMPLE = `digraph 工单流转 {
    rankdir=LR;
    start  [label="收到工单", shape=box];
    check  [label="需要审批吗", shape=diamond];
    store  [label="工单库", shape=cylinder];
    start -> check [label="提交"];
    check -> store [label="是"];
    check -> start [label="否，重新提交"];
}`

const GANTT_SAMPLE = `gantt
    dateFormat YYYY-MM-DD
    title 内网知识库一期排期
    section 准备
    需求确认      :done,    r1, 2026-01-05, 2026-01-09
    环境准备      :done,    r2, 2026-01-06, 4d
    section 开发
    认证与权限    :crit,    d1, 2026-01-12, 8d
    知识库 CRUD   :active,  d2, after d1, 10d
    section 上线
    灰度发布      :crit,    m1, 2026-02-02, 0d
    全量切换      :         m2, after m1, 2d`

const STATE_SAMPLE = `stateDiagram-v2
    [*] --> 待支付
    待支付 --> 已支付 : 用户付款
    已支付 --> 履约中
    履约中 --> 已发货 : 出库
    已发货 --> [*]
    state 售后 {
        [*] --> 申请中
        申请中 --> 通过 : 审核
        通过 --> [*]
    }
    履约中 --> 售后 : 用户申请`

const MIND_SAMPLE = `mindmap
  root((知识库))
    文档
      规范
        编码约定
      流程
      模板
    卡片
      互动
      媒体
    设置
      成员
      权限`

const PIE_SAMPLE = `pie title 文档内容分布
    "正文" : 45
    "卡片" : 30
    "附件" : 15
    "其他" : 10`

const CLASS_SAMPLE = `classDiagram
    class 文档 {
      +string 标题
      +string 状态
      +int 字数
    }
    class 知识库 {
      +string 名称
    }
    文档 "1" <-- "0..N" 知识库 : 归属`

const ER_SAMPLE = `erDiagram
    CUSTOMER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    CUSTOMER {
      string name PK
      string email UK
    }
    ORDER {
      int id PK
      int amount
    }`

const JOURNEY_SAMPLE = `journey
    title 新同事入职第一周
    section 第一天
      领账号: 3: 小王
      配机器: 4: 小王, 运维
    section 第一周
      跑通流程: 5: 小王, 导师
      独立提交: 2: 小王`

const TIMELINE_SAMPLE = `timeline
    title 知识库建设历程
    2024 Q1 : 调研选型
    2024 Q3 : 试点上线
    2025 Q1 : 全员推广
    2025 Q4 : 内网私有化部署`

const SANKEY_SAMPLE = `sankey-beta
    title 预算分配
    收入,成本,40
    成本,人力,25
    成本,房租,15
    人力,产出,25`

/* ⚠️ 这里存的是 **kind** 而不是序号。
   原来存的是序号，另有一张 `{ class: 8, er: 9 }` 的手工映射表 ——
   两处各写一遍，**必然漂**：映射表加到 er:9 时 CYCLES 只有 8 项，
   于是类图 / ER 图卡片上点「重置成…」按钮 = `CYCLES[8].src`
   → TypeError，示例按钮直接失效（而且不报任何错，只是点了没反应）。
   现在按 kind 查表，加一个示例就是加一项，越界在结构上不可能发生。 */
const CYCLES: Array<{ kind: Mode['kind']; src: string; label: string }> = [
  { kind: 'uml', src: SAMPLE, label: 'PlantUML' },
  { kind: 'flow', src: FLOW_SAMPLE, label: 'Flowchart' },
  { kind: 'seq', src: SEQ_SAMPLE, label: 'Mermaid 时序图' },
  { kind: 'dot', src: DOT_SAMPLE, label: 'Graphviz' },
  { kind: 'gantt', src: GANTT_SAMPLE, label: 'Gantt' },
  { kind: 'state', src: STATE_SAMPLE, label: 'Mermaid 状态图' },
  { kind: 'mind', src: MIND_SAMPLE, label: 'Mermaid 脑图' },
  { kind: 'pie', src: PIE_SAMPLE, label: 'Mermaid 饼图' },
  { kind: 'class', src: CLASS_SAMPLE, label: 'Mermaid 类图' },
  { kind: 'er', src: ER_SAMPLE, label: 'Mermaid 实体关系图' },
  { kind: 'journey', src: JOURNEY_SAMPLE, label: 'Mermaid 用户旅程图' },
  { kind: 'timeline', src: TIMELINE_SAMPLE, label: 'Mermaid 时间线' },
  /* ⚠️ sankey 也得在这儿有一项：它是 `detect()` 的一个 mode、界面标题写的是
     「（本地渲染）」，却没有示例可填 —— 用户点「填入…示例」永远轮不到它。
     「声明成能本地渲染」和「给得出示例」是两件事，缺一个就是半截。 */
  { kind: 'sankey', src: SANKEY_SAMPLE, label: 'Mermaid 桑基图' },
]

interface Parsed {
  participants: string[]
  edges: string[]
}

/** 只做结构解析：把 @startuml 里的角色/组件和调用关系列出来 */
function parse(src: string): Parsed {
  const participants: string[] = []
  const edges: string[] = []
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith("'") || line.startsWith('@')) continue
    const decl = /^(actor|participant|boundary|control|entity|database|collections|queue)\s+(\S+)/.exec(line)
    if (decl) {
      if (!participants.includes(decl[2])) participants.push(decl[2])
      continue
    }
    const arrow = line.match(/^(\S+)\s*(-{1,2}>|<-{1,2}|-{2,}|--)\s*(\S+)\s*:\s*(.*)$/)
    if (arrow) {
      for (const side of [arrow[1], arrow[3]]) if (!participants.includes(side)) participants.push(side)
      edges.push(`${arrow[1]} ─${arrow[2]}→ ${arrow[3]}${arrow[4] ? ` : ${arrow[4]}` : ''}`)
    }
  }
  return { participants, edges }
}

/** 这段源码走哪条路。**顺序要紧**：先认 PlantUML（`@startuml`），
 *  再认 mermaid 的图种 —— 认错了会渲染出一张完全无关的图，
 * 而界面上看不出「认错了」，只会显得「图画怪」。 */
type Mode =
  | { kind: 'empty' }
  | { kind: 'uml' }
  | { kind: 'flow'; fc: Flowchart; svg: string }
  | { kind: 'seq'; seq: Sequence; svg: string }
  | { kind: 'dot'; fc: Flowchart; svg: string }
  | { kind: 'gantt'; g: Gantt; svg: string }
  | { kind: 'state'; fc: Flowchart; svg: string }
  | { kind: 'mind'; mm: Mindmap; svg: string }
  | { kind: 'pie'; pie: PieChart; svg: string }
  | { kind: 'class'; cd: ClassDiagram; svg: string }
  | { kind: 'er'; er: ClassDiagram; svg: string }
  | { kind: 'journey'; jn: Journey; svg: string }
  | { kind: 'timeline'; tl: Timeline; svg: string }
  | { kind: 'sankey'; sk: Sankey; svg: string }
  | { kind: 'unsupported'; mkind: Exclude<MermaidKind, 'unknown'> }

/** 走哪条路由**由 `diagram.ts` 的 `pickDiagramMode` 判定，组件只负责把结果展开成内容。
 * 别在这里再判一次 —— 判错的后果是画出一张不相干的图，而界面看不出是认错了。 */
function detect(src: string): Mode {
  const mode: DiagramMode = pickDiagramMode(src)
  switch (mode) {
    case 'empty': return { kind: 'empty' }
    case 'uml': return { kind: 'uml' }
    case 'flow':
    case 'dot':
    case 'state': {
      // 三者都是「点 + 边」，共用同一套布局与渲染，只是语法来源不同
      const fc = mode === 'dot' ? parseDot(src) : mode === 'state' ? parseStateDiagram(src) : parseFlowchart(src)
      return { kind: mode, fc, svg: renderFlowchartSvg(fc) }
    }
    case 'gantt': {
      const g = parseGantt(src)
      return { kind: 'gantt', g, svg: renderGanttSvg(g) }
    }
    case 'mind': {
      const mm = parseMindmap(src)
      return { kind: 'mind', mm, svg: renderMindmapSvg(mm) }
    }
    case 'pie': {
      const pie = parsePie(src)
      return { kind: 'pie', pie, svg: renderPieSvg(pie) }
    }
    case 'class': {
      const cd = parseClassDiagram(src)
      return { kind: 'class', cd, svg: renderClassDiagramSvg(cd) }
    }
    case 'er': {
      const er = parseErDiagram(src)
      return { kind: 'er', er, svg: renderClassDiagramSvg(er) }
    }
    case 'journey': {
      const jn = parseJourney(src)
      return { kind: 'journey', jn, svg: renderJourneySvg(jn) }
    }
    case 'timeline': {
      const tl = parseTimeline(src)
      return { kind: 'timeline', tl, svg: renderTimelineSvg(tl) }
    }
    case 'sankey': {
      const sk = parseSankey(src)
      return { kind: 'sankey', sk, svg: renderSankeySvg(sk) }
    }
    case 'seq': {
      const seq = parseSequence(src)
      return { kind: 'seq', seq, svg: renderSequenceSvg(seq) }
    }
    case 'unsupported': {
      // pickDiagramMode 判 unsupported 时一定不是 unknown（它内部先排除掉了）
      const mk = detectMermaid(src)
      return mk === 'unknown'
        ? { kind: 'uml' }
        : { kind: 'unsupported', mkind: mk }
    }
  }
}

const DESC: Record<Mode['kind'], string> = {
  empty: 'PlantUML（结构预览）',
  uml: 'PlantUML（结构预览）',
  flow: 'Mermaid 流程图（本地渲染）',
  seq: 'Mermaid 时序图（本地渲染）',
  dot: 'Graphviz DOT（本地渲染）',
  gantt: 'Gantt 甘特图（本地渲染）',
  state: 'Mermaid 状态图（本地渲染）',
  mind: 'Mermaid 脑图（本地渲染）',
  pie: 'Mermaid 饼图（本地渲染）',
  class: 'Mermaid 类图（本地渲染）',
  er: 'Mermaid 实体关系图（本地渲染）',
  journey: 'Mermaid 用户旅程图（本地渲染）',
  timeline: 'Mermaid 时间线（本地渲染）',
  sankey: 'Mermaid 桑基图（本地渲染）',
  unsupported: '未实现的图种',
}

/** 文本绘图：源码可编辑 + **本地预览**。
 *
 *  预览方式**故意不一样**，而且各自都写清楚了：
 *   · PlantUML（`@startuml` 开头）—— 真渲染要 PlantUML Server（联网），
 *     所以这里只给**结构**，界面上明写「这不是渲染图」，不假装。
 *   · 其余 12 种（`LOCALLY_RENDERED_MODES`）—— 本地直接出 SVG，零依赖。
 *   · 认得出但还没做的 Mermaid 图种 —— 明说差哪一种，不画一张不相干的图。
 *
 *  ⚠️ 这里原来写「四种语法的预览方式」——那是只有 PlantUML / 流程图 / 时序图 / DOT
 *  的时候。现在的数量是 13 种，数字写在注释里就等于埋一个未来的假话，
 *  所以改成指向 `LOCALLY_RENDERED_MODES`，让它自己数。
 */
export default function PlantumlCard({ data, onChange, readOnly }: CardProps<PlantData>) {
  const src = data?.src ?? ''
  const mode = detect(src)

  // 当前这一路对应的示例 / 下一个示例（顺序与 CYCLES 一致）
  // findIndex 找不到时是 -1，必须兜回 0 —— 否则 CYCLES[-1] 是 undefined，
  // 「填入…示例」按钮一点就抛（findIndex 返回 -1 而不是报错，最容易漏）
  const found = CYCLES.findIndex((c) => c.kind === mode.kind)
  const curIdx = found === -1 ? 0 : found
  const nextIdx = (curIdx + 1) % CYCLES.length
  const placeholder = CYCLES[0].src

  const fc = mode.kind === 'flow' || mode.kind === 'dot' || mode.kind === 'state' ? mode.fc : null
  const seq = mode.kind === 'seq' ? mode.seq : null
  const gantt = mode.kind === 'gantt' ? mode.g : null
  const mm = mode.kind === 'mind' ? mode.mm : null
  const pie = mode.kind === 'pie' ? mode.pie : null
  const cd = mode.kind === 'class' ? mode.cd : null
  const er = mode.kind === 'er' ? mode.er : null
  const jn = mode.kind === 'journey' ? mode.jn : null
  const tl = mode.kind === 'timeline' ? mode.tl : null
  const sk = mode.kind === 'sankey' ? mode.sk : null
  const svg = (mode.kind === 'flow' || mode.kind === 'seq' || mode.kind === 'dot'
    || mode.kind === 'gantt' || mode.kind === 'state' || mode.kind === 'mind'
    || mode.kind === 'pie' || mode.kind === 'class' || mode.kind === 'er'
    || mode.kind === 'journey' || mode.kind === 'timeline' || mode.kind === 'sankey') ? mode.svg : ''
  const skipped = fc ? fc.skipped : seq ? seq.skipped : gantt ? gantt.skipped
    : mm ? mm.skipped : pie ? pie.skipped : cd ? cd.skipped : er ? er.skipped
    : jn ? jn.skipped : tl ? tl.skipped : sk ? sk.skipped : []
  const p = mode.kind === 'uml' || mode.kind === 'empty' ? parse(src) : null

  return (
    <CardShell
      icon="📈"
      title="文本绘图"
      desc={mode.kind === 'unsupported' ? `Mermaid ${KIND_LABEL[mode.mkind]}（未实现）` : DESC[mode.kind]}
      actions={!readOnly ? (
        <>
          <MiniBtn onClick={() => onChange({ src: CYCLES[nextIdx].src })}>
            填入 {CYCLES[nextIdx].label} 示例
          </MiniBtn>
          <MiniBtn onClick={() => onChange({ src: CYCLES[curIdx].src })}>
            重置成 {CYCLES[curIdx].label}
          </MiniBtn>
        </>
      ) : null}
    >
      <SyncTextarea
        className="yq-kc-textarea yq-kc-plant-src"
        value={src}
        readOnly={readOnly}
        rows={6}
        placeholder={placeholder}
        onCommit={(v) => onChange({ src: v })}
      />

      {mode.kind === 'unsupported' ? (
        <div className="yq-kc-note is-warn" style={{ marginTop: 8, marginBottom: 0 }}>
          <span>⚠️</span>
          <span dangerouslySetInnerHTML={{ __html: noticeHtml(mode.mkind) }} />
        </div>
      ) : mode.kind === 'flow' || mode.kind === 'seq' || mode.kind === 'dot'
        || mode.kind === 'gantt' || mode.kind === 'state' || mode.kind === 'mind'
        || mode.kind === 'pie' || mode.kind === 'class' || mode.kind === 'er'
        || mode.kind === 'journey' || mode.kind === 'timeline' || mode.kind === 'sankey' ? (
        <>
          {svg
            ? <div className="yq-kc-plant-svg" dangerouslySetInnerHTML={{ __html: svg }} />
            : (
              <div className="yq-kc-note is-warn" style={{ marginTop: 8, marginBottom: 0 }}>
                <span>⚠️</span>
                <span>
                  这段源码里没解析出任何{mode.kind === 'seq' ? '参与者' : mode.kind === 'gantt' ? '任务' : mode.kind === 'journey' ? '任务' : mode.kind === 'timeline' ? '周期' : mode.kind === 'mind' ? '节点' : '节点'}。确认第一行是
                  <code>{mode.kind === 'seq' ? 'sequenceDiagram' : mode.kind === 'dot' ? 'digraph G {' : mode.kind === 'gantt' ? 'gantt' : mode.kind === 'state' ? 'stateDiagram-v2' : mode.kind === 'mind' ? 'mindmap' : mode.kind === 'pie' ? 'pie' : mode.kind === 'class' ? 'classDiagram' : mode.kind === 'er' ? 'erDiagram' : mode.kind === 'journey' ? 'journey' : mode.kind === 'timeline' ? 'timeline' : 'graph TD'}</code>。
                </span>
              </div>
            )}
          {skipped.length > 0 && (
            <div className="yq-kc-note is-warn" style={{ marginTop: 8, marginBottom: 0 }}>
              <span>⚠️</span>
              <span>
                有 {skipped.length} 处写法本地渲染器<strong>不认</strong>（已跳过，不是全支持）：
                <code>{skipped.slice(0, 4).join('、')}</code>。
                {mode.kind === 'seq'
                  ? <>时序图支持参与者、消息箭头、激活条、Note、loop/alt 框与 autonumber。</>
                  : mode.kind === 'dot'
                    ? <>DOT 支持 digraph/graph、rankdir、节点形状、边标签与 <strong>cluster 分组框</strong>；<strong>不支持</strong> rank 约束与端口布局。</>
                    : mode.kind === 'gantt'
                      ? <>甘特图支持 section、标签（done/active/crit/milestone）、`after` 依赖与 d/w/h/m/s 时长；<strong>不支持</strong> exclude 日历排除与 until 依赖 —— 这两类会在上面逐条列出来。</>
                      : mode.kind === 'state'
                        ? <>状态图支持 `[*]` 起止点、迁移标签、复合态（<code>state 名称 {'{ … }'}</code>）与 direction；<strong>不支持</strong> 复合态外框、note 旁注与并发区域。</>
                        : mode.kind === 'mind'
                          ? <>脑图支持缩进层级、`root((名称))` 这类外壳、<code>::icon</code>、<code>:::</code> 类标记与 classDef 样式；<strong>不支持</strong> 左右双向布局。</>
                          : mode.kind === 'pie'
                            ? <>饼图支持标题、带引号与不带引号的名称、0 值条目；<strong>不支持</strong>负值（饼图画不了，会逐条列出来）。</>
                            : mode.kind === 'class'
                              ? <>类图支持隔层盒子（类名 + 成员表）、六种关系与基数；关系线上标的是<strong>关系类型文字</strong>，<strong>不画</strong>继承三角 / 组合菱形 —— 符号画错，读者读出来的关系就错了。namespace 与 direction 未实现。</>
                              : mode.kind === 'er'
                                ? <>实体关系图支持实体盒（名称 + 属性表 + PK/FK/UK）与四种基数（1 / 0..1 / 0..N / 1..N）；基数标在<strong>线上文字</strong>，<strong>不画</strong>乌鸦脚 —— 基数画错就是画错的数据模型。实线=识别、虚线=非识别。</>
                                : <>流程图支持方向、连线、四种常见节点形状、连线标签、<strong>subgraph 分组框</strong>（可嵌套）和 <strong>classDef 样式</strong>（含 <code>:::</code> 行内标记）；<strong>不支持</strong>组内单独换方向。</>}
              </span>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="yq-kc-note is-warn" style={{ marginTop: 8, marginBottom: 0 }}>
            <span>⚠️</span>
            <span>
              真正的 PlantUML 图形由 <strong>PlantUML Server</strong> 渲染（需要联网 + 服务地址），
              本地复刻没有内置渲染器。下面是<strong>从源码里解析出来的结构</strong>，不是渲染图。
              想要本地就能出图，把源码换成 <code>graph TD</code>（流程图）或 <code>sequenceDiagram</code>（时序图）。
            </span>
          </div>
          {p && p.participants.length > 0 && (
            <div className="yq-kc-plant-view">
              <div className="yq-kc-plant-line">
                <span className="yq-kc-plant-kind">参与者</span>
                <span>{p.participants.join('、')}</span>
              </div>
              {p.edges.length > 0 && (
                <div className="yq-kc-plant-edges">
                  {p.edges.map((e, i) => (
                    <div className="yq-kc-plant-line" key={i}>
                      <span className="yq-kc-plant-kind">调用</span>
                      <span>{e}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
      {!readOnly && (
        <div className="yq-kc-row" style={{ marginTop: 8 }}>
          <input
            className="yq-kc-input"
            defaultValue={data?.img ?? ''}
            placeholder="已经有渲染好的图片地址？贴进来直接显示（https://…）"
            onChange={(e) => onChange({ img: e.target.value })}
          />
        </div>
      )}
      {data?.img && <img className="yq-kc-media" style={{ marginTop: 8 }} src={data.img} alt="plantuml" />}
    </CardShell>
  )
}

/** 未实现图种的提示。**只允许插值 lib 里给定的名字**，
 * 不把源码原文拼进 innerHTML —— 源码是用户自己输入的，不能当 HTML 执行。 */
function noticeHtml(mkind: Exclude<MermaidKind, 'unknown'>): string {
  const safe = mermaidLocalNotice(mkind)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
  // 白名单之外一律替换掉，杜绝任何注入
  return safe.replace(/[<>&](?!lt;|gt;|amp;|quot;|#)/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' } as Record<string, string>)[c] || '')
}
