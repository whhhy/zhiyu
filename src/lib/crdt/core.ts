/**
 * CRDT 核心 —— 操作日志 + 因果就绪 + 三路合并
 * ============================================================
 * 为什么要换掉现在的「整篇覆盖」：
 *   A 改块1、B 改块2 → 后到的把先到的整篇盖掉，两个改动全丢。
 *   这不是边缘情况，是多人同时写文档最常见的形态。
 *
 * 分层解决（这也是为什么要分层）：
 *   ① 块级并发（改不同的块）—— 必须彻底解决，覆盖 80% 真实场景
 *   ② 块内文本并发（改同一个块的不同位置）—— 三路合并，不丢整块
 *   ③ 块内同位置并发 —— 任何 CRDT 都得仲裁，这里按 (ts, actor) 定序
 *
 * 纯函数，无副作用，可独立测试。
 */

/* ============================================================
   一、操作（Op）
   ------------------------------------------------------------
   不再传「最终状态」，只传「做了什么」。状态由 op 重放得出。
   ============================================================ */

export type OpKind =
  | 'block.upsert'   // 新增 / 修改一个块（带该块快照）
  | 'block.remove'   // 删除一个块
  | 'block.move'     // 调整块顺序
  | 'doc.title'      // 文档标题变更
  | 'sheet.set'      // 三大文稿数据变更（工作表 / 数据表 / 画板）
  | 'card.set'       // 卡片块的数据变更（投票选项 / 看板列 / 打卡状态 …）

export interface Op {
  /** 全局唯一 */
  id: string
  /** 发起者：标签页 id（判断因果必须用它，memberId 会一人多端） */
  actor: string
  /** 逻辑时间戳（同 actor 内单调递增） */
  clock: number
  /** 因果依赖：做这个 op 之前，我已知晓的这些 op */
  after: string[]
  docId: string
  kind: OpKind
  /** 目标块（doc.title / sheet.set 时为 undefined） */
  blockId?: string
  payload?: any
  /**
   * 做这个 op **之前**该块的快照。
   * 真并发时 after 可能是空的（双方互不知晓），
   * 对端就找不到共同祖先，只能退化成「择一」——那等于丢掉一方。
   * 自带基准快照才能保证任何情况下都做得出三路合并。
   */
  baseBlock?: any
  /**
   * 逻辑目标键。非块级 op（sheet.set / card.set）用它参与因果判定与
   * lastOpOf 记账 —— 没有它，对端就无法区分「基于我的改动继续改」与
   * 「我们各改各的」，只能一律当并发处理。
   * 约定：sheet.set → `sheet:<段名>`，card.set → `card:<blockId>`。
   */
  target?: string
  /** card.set：改动之前的 block.data（卡片字段级合并的 base） */
  baseData?: any
  /** sheet.set：改动之前的 doc.sheetData[段名]（文稿数据合并的 base） */
  baseValue?: any
}

/* ============================================================
   二、三路合并（块内文本）
   ------------------------------------------------------------
   base 是「两边共同的祖先」版本的块文本，mine / theirs 是各自的版本。
   先各自算出相对 base 的变更区间，再看区间是否重叠：
     不重叠 → 全部保留
     重叠   → 该区间按 (ts, actor) 仲裁，只丢重叠部分
   这样做的好处：并发改同一块的两处不同位置，两处都能留下。
   ============================================================ */

/** 从 base 到 target 的变更区间：{ start, del, ins } */
export interface Edit { start: number; del: number; ins: string }

/**
 * 差异计算：算出 base → target 的精确编辑序列。
 *
 * 早期版本只剥公共前后缀，对「A 在中间插 X、B 在后面插 Y」这种最常见的并发
 * 会退化成整段替换 —— 而整段替换在合并时必然和对方重叠，等于丢掉一方。
 * 所以这里用 LCS 动态规划拿精确编辑序列。
 *
 * 取舍：O(n·m)。块文本通常几十~几百字完全够用；
 * 超过 DIFF_MAX_CHARS 就退化为「整体替换」并由调用方按 LWW 处理，
 * 避免超长文本把主线程卡住。
 */
export const DIFF_MAX_CHARS = 2000

export function diff(base: string, target: string): Edit[] {
  if (base === target) return []
  if (!base) return [{ start: 0, del: 0, ins: target }]
  if (!target) return [{ start: 0, del: base.length, ins: '' }]

  if (base.length + target.length > DIFF_MAX_CHARS) {
    return [{ start: 0, del: base.length, ins: target }]
  }

  const n = base.length
  const m = target.length

  // dp[i][j] = LCS(base[i..], target[j..]) 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = base[i] === target[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  // 回溯：把连续的删除/插入聚合成一个 Edit
  const edits: Edit[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (base[i] === target[j]) {
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // 删除 base[i]
      const start = i
      while (i < n && (j >= m || base[i] !== target[j]) && dp[i][j + 1] < dp[i + 1][j]) i++
      if (i === start) i++
      pushEdit(edits, start, i - start, '')
    } else {
      // 插入 target[j]
      const start = i
      let ins = ''
      while (j < m && (i >= n || base[i] !== target[j]) && dp[i][j + 1] > dp[i + 1][j]) {
        ins += target[j]
        j++
      }
      if (!ins) {
        ins = target[j]
        j++
      }
      pushEdit(edits, start, 0, ins)
    }
  }
  if (i < n) pushEdit(edits, i, n - i, '')
  if (j < m) pushEdit(edits, n, 0, target.slice(j))

  return mergeAdjacent(edits)
}

/** 相邻/重叠的编辑聚合成一个，避免 applyEdits 时坐标互相错位 */
function pushEdit(edits: Edit[], start: number, del: number, ins: string) {
  const last = edits[edits.length - 1]
  if (last && last.start + last.del === start) {
    last.del += del
    last.ins += ins
    return
  }
  edits.push({ start, del, ins })
}

function mergeAdjacent(edits: Edit[]): Edit[] {
  const out: Edit[] = []
  for (const e of edits) {
    if (!e.del && !e.ins) continue
    const last = out[out.length - 1]
    if (last && last.start + last.del >= e.start) {
      // 区间相交：合并成一个大区间（内容以较晚出现的为准）
      const end = Math.max(last.start + last.del, e.start + e.del)
      const tail = e.ins.slice(Math.max(0, last.start + last.del - e.start))
      last.del = end - last.start
      last.ins += tail
    } else {
      out.push({ ...e })
    }
  }
  return out
}

/** 把 edits 应用到 text 上（edits 里的 start 是相对 base 的坐标） */
export function applyEdits(text: string, edits: Edit[]): string {
  if (!edits.length) return text
  const sorted = [...edits].sort((a, b) => b.start - a.start) // 从后往前改，坐标不失效
  let out = text
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.ins + out.slice(e.start + e.del)
  }
  return out
}

/** 区间是否相交 */
const overlaps = (a: Edit, b: Edit): boolean => {
  const aEnd = a.start + Math.max(a.del, a.ins.length ? 1 : 0)
  const bEnd = b.start + Math.max(b.del, b.ins.length ? 1 : 0)
  return !(aEnd <= b.start || bEnd <= a.start)
}

/**
 * 确定性的胜负比较：时间戳大者胜；同刻则 actor 字典序大者胜。
 *
 * 注意 clock 是**每个 actor 各自递增**的，跨 actor 比大小不等于比真实时间
 * （等价于按「谁改得更多、tabId 谁大」定序）。这没关系：
 * 收敛只要求 (a) 同样的输入永远同样结果，(b) 交换 mine/theirs 后结论正好相反。
 * 两条都满足 → 两端从各自视角算出来的合并结果必然字面一致。
 * 真正的坑在调用方：把「我方版本」取成了刚收进来的那条 op，
 * 于是 wins(o, o) 恒真，两端都判自己赢 —— 谁也不服谁，永远不收敛。
 */
export function wins(mineTs: number, mineActor: string, theirTs: number, theirActor: string): boolean {
  if (mineTs !== theirTs) return mineTs > theirTs
  return mineActor >= theirActor
}

export interface MergeResult {
  text: string
  conflicts: { start: number; len: number; winner: 'mine' | 'theirs' }[]
}

/**
 * 块内文本三路合并。
 *
 * base 是两边共同的祖先版本。先各自算出相对 base 的变更，
 * 不重叠的区间**两边都保留**（所以「A 在中间插 X、B 在后面插 Y」两处都活）；
 * 重叠的区间按 tieBreak 仲裁，只丢重叠部分，不丢整块。
 */
export function mergeText(base: string, mine: string, theirs: string, tieBreak: () => boolean): MergeResult {
  if (mine === theirs) return { text: mine, conflicts: [] }
  if (mine === base) return { text: theirs, conflicts: [] }
  if (theirs === base) return { text: mine, conflicts: [] }

  const myEdits = diff(base, mine)
  const theirEdits = diff(base, theirs)

  const mineClash = new Set<number>()
  const theirClash = new Set<number>()
  myEdits.forEach((me, i) => {
    theirEdits.forEach((te, j) => {
      if (overlaps(me, te)) {
        mineClash.add(i)
        theirClash.add(j)
      }
    })
  })

  // 一个都没撞上：直接全都要
  if (!mineClash.size && !theirClash.size) {
    return { text: applyEdits(base, [...myEdits, ...theirEdits]), conflicts: [] }
  }

  const mineWins = tieBreak()
  const chosen: Edit[] = []
  const conflicts: MergeResult['conflicts'] = []

  myEdits.forEach((me, i) => {
    if (mineClash.has(i)) {
      if (mineWins) {
        chosen.push(me)
        conflicts.push({ start: me.start, len: Math.max(me.del, me.ins.length, 1), winner: 'mine' })
      }
      // 输了就整段丢弃，让 their 的对应区间生效
    } else {
      chosen.push(me)
    }
  })

  theirEdits.forEach((te, j) => {
    if (theirClash.has(j)) {
      if (!mineWins) {
        chosen.push(te)
        conflicts.push({ start: te.start, len: Math.max(te.del, te.ins.length, 1), winner: 'theirs' })
      }
    } else {
      chosen.push(te)
    }
  })

  return { text: applyEdits(base, chosen), conflicts }
}

/* ============================================================
   三、对象级三路合并（文稿数据 / 卡片数据）
   ------------------------------------------------------------
   块内文本那一套（mergeText）是按**字符串**做三路合并的。
   但 doc.sheetData 和 Block.data 都是**对象树**，两边的形态是：
     工作表  sheets[].rows[][].v
     数据表  table.records[] / table.views[]
     画板    board.cards[] / board.edges[]
     卡片    data.options[] / data.votes[]
   这一节按「路径」分层合并，规则只有四条：
     ① 不同对象（不同 sheet / 不同 record / 不同卡片）→ 互不干扰，直接应用
     ② 同一对象的不同字段 → 字段级合并，各自改的都保留
     ③ 同一对象的同一字段 → 按 (clock, actor) 仲裁，记一条冲突
     ④ 数组 → 见 resolveArrayMode：
         id 模式   按 id 归并（工作表、记录、画板卡片、投票选项）——不靠下标，
                    所以并发增删行也不会把别人的行挪位、id 不会乱
         index 模式 按下标逐个合并（工作表的 rows：行是数组、没有 id，
                    而「A 改 B3、B 改 C3 两处都要在」要求逐格合并）
         atomic    整体择一（tags / votes 这种无 id 的纯值数组，
                    逐项合并没有意义，硬做只会把顺序搅乱）
   纯函数，无副作用，可独立测试。
   ============================================================ */

/** 路径分段：字段名 / 下标 / 集合里的一项（用 {id} 标记，便于展示成「名称」而不是 id） */
export type PathSeg = string | number | { id: string }

export interface ObjConflict {
  /** 结构路径，例：sheets.@sh1.rows.2.3.v */
  path: string
  /** 路径分段（UI 定位与文案都用它） */
  segments: PathSeg[]
  /** 仲裁结果：谁的版本留下来了 */
  winner: 'mine' | 'theirs'
}

export interface ObjMergeResult {
  value: any
  conflicts: ObjConflict[]
}

export type ArrayMode = 'id' | 'index' | 'atomic'

export interface MergeObjectOptions {
  /** 同一个叶子两边都改了：true = 我赢（由 (clock, actor) 决定） */
  tieBreak: () => boolean
  /** 数组合并策略的按路径覆盖（自动判定已经够用，这里留给特例） */
  arrayModes?: Record<string, ArrayMode>
  /** 节点预算：超大表不至于把主线程卡死，超了退化为择一 */
  budget?: number
}

/** 深比较的节点预算 */
export const DEEP_BUDGET = 40_000

export function isPlainObject(v: any): v is Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const p = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}

const has = (o: any, k: string) => !!o && Object.prototype.hasOwnProperty.call(o, k)

/**
 * 结构相等（引用相同直接返回 true）。
 *
 * 为什么不能一律用引用比较：doc.sheetData 每次写入都是
 * `{ v, ...doc.sheetData, [key]: value }` 新建顶层对象，
 * 不比内容就会把「只改了工作表」误判成「整份 sheetData 都变了」，
 * 每次按键都白广播一条。反过来也不能一律 JSON.stringify：
 * 几百行的工作表每敲一个键都要序列化两次，主线程直接卡住 ——
 * 所以先比引用，只有引用不同的分支才继续往下走
 * （未改动的子结构天然共享引用，常见情况下这一步就短路了）。
 */
export function deepEqual(a: any, b: any, budget = { n: DEEP_BUDGET }): boolean {
  if (a === b) return true
  if (a === null || b === null || a === undefined || b === undefined) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return typeof a === 'number' && Number.isNaN(a) && Number.isNaN(b)
  if (Array.isArray(a) !== Array.isArray(b)) return false
  // 预算耗尽：按「不相等」处理。最坏结果退化成择一，但不会卡死主线程。
  if (budget.n-- <= 0) return false
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], budget)) return false
    return true
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false // Date / Map 之类：只认引用
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) if (!has(b, k) || !deepEqual(a[k], b[k], budget)) return false
  return true
}

interface MergeCtx {
  tieBreak: () => boolean
  arrayModes: Record<string, ArrayMode>
  budget: { n: number }
  conflicts: ObjConflict[]
}

const segKey = (segs: PathSeg[]) => segs.filter((s) => typeof s === 'string').join('.')

function pathText(segs: PathSeg[]): string {
  return segs.map((s) => (typeof s === 'object' ? '@' + s.id : String(s))).join('.')
}

function pushConflict(ctx: MergeCtx, segs: PathSeg[], winner: 'mine' | 'theirs') {
  ctx.conflicts.push({ path: pathText(segs), segments: segs, winner })
}

/** 整体择一 + 记一条冲突（原子数组 / 类型不一致 / 预算耗尽都走这里） */
function pickOne(_base: any, mine: any, theirs: any, segs: PathSeg[], ctx: MergeCtx) {
  const mineWins = ctx.tieBreak()
  pushConflict(ctx, segs, mineWins ? 'mine' : 'theirs')
  return mineWins ? mine : theirs
}

/**
 * 对象级三路合并（纯函数）。
 * base 是两边共同的祖先值；mine / theirs 是各自的版本。
 * 返回合并结果与冲突清单（冲突清单喂给协作条的「N 处并发编辑已自动合并」）。
 */
export function mergeObject(base: any, mine: any, theirs: any, opts: MergeObjectOptions): ObjMergeResult {
  const ctx: MergeCtx = {
    tieBreak: opts.tieBreak,
    arrayModes: opts.arrayModes || {},
    budget: { n: opts.budget ?? DEEP_BUDGET },
    conflicts: [],
  }
  const value = mergeValue(base, mine, theirs, [], ctx)
  return { value, conflicts: ctx.conflicts }
}

function mergeValue(base: any, mine: any, theirs: any, segs: PathSeg[], ctx: MergeCtx): any {
  if (ctx.budget.n-- <= 0) return theirs
  if (deepEqual(mine, theirs)) return mine
  // 只有一边动过 → 直接采纳另一边，不算冲突（这是最常见的情况，必须快）
  if (deepEqual(mine, base)) return theirs
  if (deepEqual(theirs, base)) return mine

  if (Array.isArray(mine) && Array.isArray(theirs)) return mergeArray(base, mine, theirs, segs, ctx)
  if (isPlainObject(mine) && isPlainObject(theirs)) return mergePlain(base, mine, theirs, segs, ctx)
  return pickOne(base, mine, theirs, segs, ctx)
}

/**
 * 字段级合并。
 * 删除按「对方的删除 vs 我的修改」处理：**保留修改**并记一条冲突。
 * 反过来（服从删除）等于把对方敲的字直接抹掉，代价比丢格式大得多。
 */
function mergePlain(base: any, mine: any, theirs: any, segs: PathSeg[], ctx: MergeCtx): any {
  const b = isPlainObject(base) ? base : {}
  const out: Record<string, any> = {}
  const keys = new Set<string>([...Object.keys(mine), ...Object.keys(theirs), ...Object.keys(b)])
  for (const k of keys) {
    const inMine = has(mine, k)
    const inTheirs = has(theirs, k)
    const bv = b[k]
    if (!inMine && !inTheirs) continue
    if (!inMine) {
      if (inTheirs && !has(b, k)) out[k] = theirs[k] // 对方新增 → 直接收下
      else if (!deepEqual(bv, theirs[k])) {
        out[k] = theirs[k] // 我删了、对方改了 → 保留修改
        pushConflict(ctx, [...segs, k], 'theirs')
      }
      continue
    }
    if (!inTheirs) {
      if (!has(b, k)) out[k] = mine[k]
      else if (!deepEqual(bv, mine[k])) {
        out[k] = mine[k] // 对方删了、我改了 → 保留修改
        pushConflict(ctx, [...segs, k], 'mine')
      }
      continue
    }
    out[k] = mergeValue(has(b, k) ? bv : undefined, mine[k], theirs[k], [...segs, k], ctx)
  }
  return out
}

/** 集合类字段的中文名（冲突文案用） */
const COLLECTION_LABELS: Record<string, string> = {
  sheets: '工作表',
  cols: '列',
  rows: '单元格区域',
  records: '数据表记录',
  views: '视图',
  rules: '筛选条件',
  cards: '画板卡片',
  edges: '连线',
  options: '投票选项',
  tags: '标签',
  votes: '投票人',
}

/** 叶子字段的中文名（认不出的原样透出，宁可难看也不要误导） */
const FIELD_LABELS: Record<string, string> = {
  v: '内容',
  q: '问题',
  myVote: '我的投票',
  closed: '是否结束',
  checked: '完成状态',
  text: '文字',
  name: '名称',
  owner: '负责人',
  status: '状态',
  priority: '优先级',
  date: '日期',
  note: '备注',
  x: '横坐标',
  y: '纵坐标',
  w: '宽度',
  h: '高度',
  color: '底色',
  shape: '形状',
  background: '画布底色',
  layout: '布局',
  from: '起点',
  to: '终点',
  activeId: '当前选中',
  activeViewId: '当前视图',
  kind: '形态',
  sort: '排序字段',
  dir: '排序方向',
  groupBy: '分组字段',
  month: '月份',
  cardId: '卡片类型',
}

/** 0 → A，25 → Z，26 → AA（与 SheetView 的列标一致） */
export function colLetter(i: number): string {
  let s = ''
  let n = i
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  }
  return s || 'A'
}

const idOf = (x: any): string | null => (isPlainObject(x) && typeof x.id === 'string' ? x.id : null)

function resolveArrayMode(_base: any, mine: any[], theirs: any[], segs: PathSeg[], ctx: MergeCtx): ArrayMode {
  const override = ctx.arrayModes[segKey(segs)]
  if (override) return override
  const all = [...mine, ...theirs]
  // 每一项都有 id：按 id 归并。工作表、记录、画板卡片、投票选项都走这里 ——
  // 靠 id 认领，并发增删行也不会把别人的行挪位。
  if (all.length && all.every((e) => idOf(e) !== null)) return 'id'
  // 复合项（行、单元格）没有 id：只能按下标对齐，也必须按下标对齐 ——
  //「A 改 B3、B 改 C3 两处都在」靠的就是逐项合并。
  if (all.length && all.every((e) => Array.isArray(e) || isPlainObject(e))) return 'index'
  // 纯值数组（tags / votes）：逐项合并没有意义，硬做只会把顺序搅乱
  return 'atomic'
}

function mergeArray(base: any, mine: any[], theirs: any[], segs: PathSeg[], ctx: MergeCtx): any {
  const mode = resolveArrayMode(base, mine, theirs, segs, ctx)
  if (mode === 'id') return mergeIdArray(base, mine, theirs, segs, ctx)
  if (mode === 'index' && mine.length === theirs.length) {
    const b = Array.isArray(base) ? base : []
    return mine.map((m, i) => mergeValue(b[i], m, theirs[i], [...segs, i], ctx))
  }
  // 下标对不齐（一边插了行 / 删了行）→ 整体择一。
  // 硬按下标合会把两行内容搅在一起，比择一糟得多；记一条冲突让用户看得见。
  return pickOne(base, mine, theirs, segs, ctx)
}

/**
 * 按 id 归并的数组合并。
 * 顺序：先按 base 的原顺序走（所以别人的行不会被挪位），
 * 本方新增的接在后面，再接对方新增的 —— 全程按 id 认领，不按引用、不按下标。
 */
function mergeIdArray(base: any, mine: any[], theirs: any[], segs: PathSeg[], ctx: MergeCtx): any[] {
  const bArr = Array.isArray(base) ? base : []
  const bMap = new Map<string, any>()
  const mMap = new Map<string, any>()
  const tMap = new Map<string, any>()
  for (const e of bArr) { const id = idOf(e); if (id) bMap.set(id, e) }
  for (const e of mine) { const id = idOf(e); if (id) mMap.set(id, e) }
  for (const e of theirs) { const id = idOf(e); if (id) tMap.set(id, e) }

  const order: string[] = []
  const seen = new Set<string>()
  for (const list of [bArr, mine, theirs]) {
    for (const e of list) {
      const id = idOf(e)
      if (id && !seen.has(id)) { seen.add(id); order.push(id) }
    }
  }

  const out: any[] = []
  for (const id of order) {
    const m = mMap.get(id)
    const t = tMap.get(id)
    const b = bMap.get(id)
    if (m !== undefined && t !== undefined) {
      out.push(mergeValue(b, m, t, [...segs, { id }], ctx))
      continue
    }
    const only = m !== undefined ? m : t
    if (only === undefined) continue // 两边都删了
    if (b === undefined) { out.push(only); continue } // 一边新增 → 直接收下
    if (!deepEqual(only, b)) {
      out.push(only) // 对方删了、我改了 → 保留修改，并记一条冲突
      pushConflict(ctx, [...segs, { id }], m !== undefined ? 'mine' : 'theirs')
    }
  }
  return out
}

/**
 * 冲突路径 → 人话。
 * 例：sheets.@sh1.rows.2.3.v + { sh1: '需求列表' }
 *   → 「工作表「需求列表」 · 第 3 行 · D 列 · 内容」
 * names 是 id → 名字的查表（调用方按当前数据现建）。
 */
export function describeConflictPath(segments: PathSeg[], names: Record<string, string> = {}): string {
  const parts: string[] = []
  /** 上一个片段是不是还在等一个「名字」补上来（「工作表」+「需求列表」要连成一句） */
  let open = false
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    if (typeof s === 'object' && s !== null) {
      const piece = `「${names[s.id] ?? s.id}」`
      if (open && parts.length) parts[parts.length - 1] += piece
      else parts.push(piece)
      open = false
      continue
    }
    if (typeof s === 'number') {
      const prev = segments[i - 1]
      parts.push(prev === 'rows' ? `第 ${s + 1} 行` : `${colLetter(s)} 列`)
      open = false
      continue
    }
    const next = segments[i + 1]
    // rows 的行号自己就够定位，集合名不重复出现
    if (s === 'rows' && typeof next === 'number') continue
    // 后面跟着下标或集合项 → 这是集合名
    if (next !== undefined) {
      parts.push(COLLECTION_LABELS[s] ?? s)
      open = typeof next === 'object'
      continue
    }
    parts.push(FIELD_LABELS[s] ?? s)
    open = false
  }
  return parts.join(' · ')
}

/** 当前文稿数据里的 id → 名字（冲突文案用；找不到就退回 id） */
export function collectNames(value: any, out: Record<string, string> = {}, depth = 0): Record<string, string> {
  if (!value || typeof value !== 'object' || depth > 6) return out
  if (Array.isArray(value)) {
    for (const e of value) collectNames(e, out, depth + 1)
    return out
  }
  // 先认「自己」：sheets[] 里那一项的 id 就是路径里 {id} 段的值
  const id = (value as any).id
  if (typeof id === 'string' && !out[id]) {
    const label =
      typeof (value as any).name === 'string'
        ? (value as any).name
        : typeof (value as any).text === 'string'
          ? String((value as any).text).split('\n')[0]
          : ''
    if (label) out[id] = label.slice(0, 24)
  }
  for (const v of Object.values(value)) collectNames(v, out, depth + 1)
  return out
}

/* ============================================================
   四、操作日志
   ============================================================ */

export interface OpLogState {
  /** 已应用的 op id 集合 */
  seen: Set<string>
  /** 已应用的 op（按应用顺序），用于回放与三路合并取 base */
  history: Op[]
  /** 因果未就绪的 op（依赖还没到），等齐了再应用 */
  pending: Map<string, Op>
  /** 每个块最后一次被哪个 op 改过（用于取 base 与冲突仲裁） */
  lastOpOf: Map<string, string>
  /**
   * 每个逻辑目标最后一次的 (clock, actor)。
   * 块级 op 用 blockId 记账，sheet.set / card.set 用 target 记账 ——
   * 文稿数据与卡片数据也要能判断「对方是不是基于我的改动继续改的」。
   */
  verOf: Map<string, { clock: number; actor: string }>
  /** 每个 actor 的逻辑时钟 */
  clockOf: Map<string, number>
}

export function createLog(): OpLogState {
  return {
    seen: new Set(),
    history: [],
    pending: new Map(),
    lastOpOf: new Map(),
    verOf: new Map(),
    clockOf: new Map(),
  }
}

/** 造一个 op：自动分配 id / clock / after */
export function makeOp(
  log: OpLogState,
  actor: string,
  docId: string,
  kind: OpKind,
  extra: {
    blockId?: string
    payload?: any
    after?: string[]
    baseBlock?: any
    target?: string
    baseData?: any
    baseValue?: any
  } = {},
): Op {
  const clock = (log.clockOf.get(actor) || 0) + 1
  log.clockOf.set(actor, clock)
  // after 默认取「我已知的最后若干个 op」，简化为最近 32 个——
  // 太少会让依赖链断，太多会让消息体膨胀
  const after = extra.after ?? log.history.slice(-32).map((o) => o.id)
  return {
    id: `${actor}@${clock}`,
    actor,
    clock,
    after,
    docId,
    kind,
    blockId: extra.blockId,
    payload: extra.payload,
    baseBlock: extra.baseBlock,
    target: extra.target,
    baseData: extra.baseData,
    baseValue: extra.baseValue,
  }
}

/** 因果是否就绪：依赖的 op 全部已应用 */
export function isReady(op: Op, log: OpLogState): boolean {
  return op.after.every((d) => log.seen.has(d))
}

/** 把 op 记为已应用（返回是否首次） */
export function markApplied(op: Op, log: OpLogState): boolean {
  if (log.seen.has(op.id)) return false
  log.seen.add(op.id)
  log.history.push(op)
  // 记账键优先用 target：card.set 既带 blockId 又带 target，
  // 用 blockId 记账会把「卡片数据链」和「正文块链」混成一条，
  // 对端判断因果时就会把「基于我改的」误判成并发。
  const key = op.target ?? op.blockId
  if (key) {
    log.lastOpOf.set(key, op.id)
    log.verOf.set(key, { clock: op.clock, actor: op.actor })
  }
  return true
}

/**
 * 收下一个远端 op。
 * 返回真正可以应用的 op 列表（可能连带把 pending 里攒着的也一起放出来）。
 * 死锁保护：若一个 op 等的依赖永远不来，要能被判为「对端已消失」而不是永久缓冲。
 */
export function ingest(op: Op, log: OpLogState, maxPending = 200): Op[] {
  if (log.seen.has(op.id)) return []
  log.pending.set(op.id, op)
  if (log.pending.size > maxPending) {
    // 缓冲爆了（对端可能被关闭）：按到达顺序放行最早的一批，避免永久卡死
    const oldest = log.pending.keys().next().value as string | undefined
    if (oldest) {
      const o = log.pending.get(oldest)!
      log.pending.delete(oldest)
      markApplied(o, log)
      return [o]
    }
  }

  const out: Op[] = []
  let progress = true
  while (progress) {
    progress = false
    for (const [id, o] of [...log.pending]) {
      if (isReady(o, log)) {
        log.pending.delete(id)
        markApplied(o, log)
        out.push(o)
        progress = true
      }
    }
  }
  return out
}

export interface BlockVer {
  /** 该版本对应的 Block 快照 */
  block: any
  text: string
  /** 做出这个版本的 op */
  opId: string
  clock: number
  actor: string
}

/**
 * 取某块在「指定 op 之前」的版本，用作三路合并的 base。
 * 没指定 beforeOpId 时返回该块最新版本。
 */
export function blockVersionAt(log: OpLogState, blockId: string, beforeOpId?: string): BlockVer | undefined {
  let picked: Op | undefined
  for (const o of log.history) {
    if (o.blockId === blockId && o.kind === 'block.upsert') {
      if (beforeOpId && o.id === beforeOpId) break
      picked = o
    }
  }
  if (!picked) return undefined
  return {
    block: picked.payload,
    text: String(picked.payload?.text ?? ''),
    opId: picked.id,
    clock: picked.clock,
    actor: picked.actor,
  }
}

/** 该块最近一次被改动的 op（用于冲突仲裁时比较双方的新旧程度） */
export function lastOpForBlock(log: OpLogState, blockId: string): BlockVer | undefined {
  return blockVersionAt(log, blockId)
}

/**
 * 某个逻辑目标（block:<id> / sheet:<段> / card:<id>）最近一次改动的 (clock, actor)。
 * sheet.set / card.set 不是块，没有 BlockVer，但仲裁一样要比较新旧程度。
 */
export function lastOpForTarget(log: OpLogState, key: string): { clock: number; actor: string } | undefined {
  return log.verOf.get(key)
}
