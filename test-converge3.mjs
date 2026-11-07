/**
 * 三端及以上、同一块、并发改动的收敛性。
 *
 * ============================================================
 * 这个套件是来干什么的
 * ------------------------------------------------------------
 * README 写过一句「三端及以上、同一块同一位置的并发仍有窄竞态，实测约一半概率复现」。
 * 问题是这句话**当时不可证伪**：唯一相关的检查是 smoke-converge 的场景 4，
 * 而那个检查靠真实浏览器 + debounce 时序，连跑 4 次全过 ——
 * 既不能证实，也不能推翻。
 *
 * 所以把合并代数从浏览器里搬出来：直接 import 真代码（mergeText / wins），
 * 用固定种子穷举到达顺序。结果是确定的、可重复的：
 * 要么这条检查一直绿，要么它能指出第一个不收敛的排列长什么样。
 *
 * ============================================================
 * 诚实的边界：这个套件里**有红是预期内的**
 * ------------------------------------------------------------
 * 第 3、4 节量出来的发散率是**当前的真实缺陷**，不是测试写错了。
 * 根因在 applyOne：仲裁只拿 `stateOf` 里那个**块级**身份去比，
 * 而合并后的正文是多人混合的 —— 一次合并里不同的冲突区需要不同的赢家，
 * 一个「谁赢」表达不了。
 *
 * 第 4 节钉的是当前行为。**有人把它修好的那天，这一节会红** ——
 * 那是修好了的信号，不是回归，记得回来删掉【已知缺陷】标记。
 *
 * ============================================================
 * 这个套件验什么、不验什么
 * ------------------------------------------------------------
 * 验的是**合并代数**：mergeText + 调用方 stateOf/claim 状态机
 * 在 3~5 个并发者、随机到达顺序下是否收敛。
 * 不验 collaboration.ts 里 applyOne 的其余分支（因果直达、localIsKnown、基准查找），
 * 那部分仍然只有浏览器测试覆盖。
 *
 * 下面的 Peer 状态机是**照着** applyOne 的并发分支重写的模型，不是它本身 ——
 * 改 applyOne 时这里不会自动跟着变。
 * ============================================================
 */
import { mergeText, wins } from './src/lib/crdt/core.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

/** 固定种子的伪随机：失败时同一批用例必现 */
function rng(seed) {
  let s = seed >>> 0
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
}

const applyInsert = (base, pos, ins) => {
  const p = Math.max(0, Math.min(pos, base.length))
  return base.slice(0, p) + ins + base.slice(p)
}

/** 一个 peer：照抄 applyOne 的「真并发」分支（baseVer 取 op 自带的 baseBlock） */
class Peer {
  constructor(self) {
    this.local = self.text
    this.ver = { clock: self.clock, actor: self.actor }   // 自己发的那条 op 会先 claim
  }
  claim(o) {
    const cur = this.ver
    if (!cur || wins(o.clock, o.actor, cur.clock, cur.actor)) this.ver = { clock: o.clock, actor: o.actor }
  }
  receive(o) {
    if (this.local === o.text) return
    if (this.local === o.base) { this.local = o.text; this.claim(o); return }
    if (o.text === o.base) return
    // 仲裁用的「我方版本」取这条 op 记账之前的 stateOf —— 先记账会让 wins(o,o) 恒真
    const mine = this.ver
    const r = mergeText(o.base, this.local, o.text, () => wins(mine.clock, mine.actor, o.clock, o.actor))
    this.local = r.text
    if (r.conflicts.some((c) => c.winner === 'theirs')) this.claim(o)
  }
}

/** 跑一轮：每个 peer 按自己的顺序收完所有人的 op，看结果是否唯一 */
function runRound(selves, orders) {
  const finals = []
  for (let i = 0; i < selves.length; i++) {
    const peer = new Peer(selves[i])
    for (const o of orders[i]) if (o.actor !== selves[i].actor) peer.receive(o)
    finals.push(peer.local)
  }
  return finals
}

console.log('\n== 第 1 节：wins() 的两条性质（整套收敛性的地基）==')
{
  ok(wins(2, 'a', 1, 'z'), 'clock 大者赢（不管 actor 谁大）')
  ok(!wins(1, 'z', 2, 'a'), '同一条结论反过来就是 false')
  ok(wins(1, 'b', 1, 'a'), 'clock 相同则 actor 字典序大者赢')
  ok(!wins(1, 'a', 1, 'b'), 'actor 字典序反过来也成立')
  ok(wins(1, 'a', 1, 'a'), 'reflexive：同一条 op 跟自己比判自己赢')
  ok(wins(3, 'a', 3, 'a'), '完全相同的 (clock, actor) 也判自己赢')
}

console.log('\n== 第 2 节：双端并发必须收敛 ==')
{
  // base=xy；mine 在 0 插 A，theirs 在 1 插 B —— 两处不重叠
  const a = mergeText('xy', 'Axy', 'xBy', () => true)
  const b = mergeText('xy', 'xBy', 'Axy', () => false)
  ok(a.text === 'AxBy' && b.text === 'AxBy', '不重叠的两处：两边都要，且与谁先谁后无关', `A侧=${a.text} B侧=${b.text}`)
  ok(a.conflicts.length === 0 && b.conflicts.length === 0, '不重叠不算冲突')

  // 同位置并发：必须择一，且两端择出同一个
  const c = mergeText('xy', 'Axy', 'Bxy', () => true)
  const d = mergeText('xy', 'Bxy', 'Axy', () => false)
  ok(c.text === d.text, '同位置并发：两端必须择出同一个', `${c.text} vs ${d.text}`)
  ok(c.text === 'Axy' || c.text === 'Bxy', '择一的结果只能是某一方的原文（不能凭空混合）', c.text)

  // 两端跑完整状态机
  const selves = [
    { actor: 'aA', clock: 1, base: 'xy', text: 'Axy' },
    { actor: 'aB', clock: 1, base: 'xy', text: 'Bxy' },
  ]
  const orders = [selves.slice(), [selves[1], selves[0]]]
  const [x, y] = runRound(selves, orders)
  ok(x === y, '双端经状态机收敛', `${x} vs ${y}`)
}

console.log('\n== 第 3 节：三端/四端并发【已知缺陷】—— 测量发散率 ==')
/**
 * 这里量的是**当前实现的真实发散率**，不是「应该收敛」。
 * 断言写成「不超过已记录的上限」，作用是**防止它变得更糟**；
 * 如果哪天上限被突破（比如改了合并逻辑），这条会红。
 */
const RATES = {}
for (const [n, ceiling] of [[3, 0.25], [4, 0.60]]) {
  const actors = Array.from({ length: n }, (_, i) => 'a' + (i + 1))
  const r = rng(20261003)
  const T = 2000
  let diverged = 0, effective = 0
  const samples = []
  for (let t = 0; t < T; t++) {
    const base = 'abcdef'
    const selves = actors.map(actor => {
      let x = base
      const k = 1 + Math.floor(r() * 3)
      for (let j = 0; j < k; j++) x = applyInsert(x, Math.floor(r() * (x.length + 1)), actor[j % actor.length].toUpperCase())
      return { actor, clock: 1, base, text: x }
    })
    // 三方文本相同就没得可测，这种用例要排除，否则会把分母灌水
    if (new Set(selves.map((s) => s.text)).size !== n) continue
    effective++
    const ops = selves.map((s) => ({ actor: s.actor, clock: s.clock, base, text: s.text }))
    const orders = selves.map((s) => {
      const rest = ops.filter((o) => o.actor !== s.actor)
      for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1));[rest[i], rest[j]] = [rest[j], rest[i]] }
      return rest
    })
    const finals = runRound(selves, orders)
    if (new Set(finals).size !== 1) {
      diverged++
      if (samples.length < 2) samples.push(`base=${base} 各自=${selves.map((s) => `${s.actor}:${s.text}`).join(' ')} → ${finals.join(' | ')}`)
    }
  }
  const rate = diverged / effective
  RATES[n] = rate
  ok(effective >= 500, `【${n} 端】有效用例 ${effective}/${T}（太少说明用例退化，测的就不是并发）`, String(effective))
  ok(rate <= ceiling,
    `【${n} 端】发散率 ${(rate * 100).toFixed(1)}% 未超过已记录上限 ${(ceiling * 100).toFixed(0)}%（${diverged}/${effective}）`,
    `上限被突破：${(rate * 100).toFixed(1)}%`)
  for (const s of samples) console.log(`       样例 ${s}`)
}
console.log(`       ⚠️ 这两个数字不是「应该」的值，是**现状**。README 里「约一半概率」对应 4 端的 ${(RATES[4] * 100).toFixed(0)}%。`)

console.log('\n== 第 4 节：最小反例【已知缺陷】==')
/**
 * 三行就能人工核对的发散样例。钉住当前行为是为了让「修好了」有信号 ——
 * 一旦 mergeText 或 applyOne 改动导致这里收敛成 1 种，本节会红，那是好事。
 */
{
  const base = 'xy'
  const selves = [
    { actor: 'aA', clock: 1, base, text: 'Axy' },   // 头部插入
    { actor: 'aB', clock: 1, base, text: 'Bxy' },   // 头部插入
    { actor: 'aC', clock: 1, base, text: 'xAy' },   // 尾部插入
  ]
  const ops = selves.map((s) => ({ actor: s.actor, clock: s.clock, base, text: s.text }))
  const finals = new Set()
  const detail = []
  for (const p of selves) {
    const rest = ops.filter((o) => o.actor !== p.actor)
    for (const order of [rest, [...rest].reverse()]) {
      const peer = new Peer(p)
      for (const o of order) peer.receive(o)
      finals.add(peer.local)
      detail.push(`${p.actor} 收到 [${order.map((o) => o.actor).join('→')}] ⇒ ${JSON.stringify(peer.local)}`)
    }
  }
  for (const d of detail) console.log(`       ${d}`)
  ok(finals.size === 2, '【已知缺陷】最小反例当前发散成 2 种（修好后这里会变成 1 种并报错，那是对的）', [...finals].join(' | '))
  ok(finals.has('AxAy') && finals.has('BxAy'), '【已知缺陷】两种结果就是 AxAy 与 BxAy', [...finals].join(' | '))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
