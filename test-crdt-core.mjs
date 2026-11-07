/**
 * CRDT 核心算法测试（纯函数，不依赖浏览器）
 *
 * 2026-10-06 从 smoke-crdt.test.cjs 转为回归套件：那个文件是 21KB 的真测试，
 * 却因为文件名不叫 test-*.mjs、汇总行也不合约定，一直游离在 `test:all` 之外 ——
 * 于是 core.ts 的**因果投递层**（ingest/isReady/缓冲上限/去重）和**对象级合并层**
 * （mergeObject → 卡片 Block.data、工作表）回归里一项都没有。
 * test-converge3 只验 mergeText/wins 的收敛性，跟这里几乎不重叠。
 * ============================================================
 * 这些是"合并"语义的地基。合并错了，界面上再对也只是错得很精细。
 * 所以这里逐条钉死行为，包括看起来反直觉的。
 */
// core.ts 是 TypeScript，靠 runner 传的 --experimental-strip-types 直接跑
import {
  diff, applyEdits, mergeText, wins, createLog, makeOp, ingest, isReady, markApplied,
  mergeObject, deepEqual, colLetter, describeConflictPath, collectNames, lastOpForTarget,
} from './src/lib/crdt/core.ts'

let fail = 0
let pass = 0
/** 每一处「断言通过」都要走这里 —— 只有走它的才计入通过数，
    直接 ok('…') 的那些不算，汇总就会少报。 */
const ok = (name) => { pass++; console.log(`  PASS  ${name}`) }
const eq = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want)
  if (same) ok(name)
  else { fail++; console.log(`  FAIL  ${name}\n   期望 ${JSON.stringify(want)}\n   实际 ${JSON.stringify(got)}`) }
}
const t = (name, fn) => {
  try { fn() } catch (e) { fail++; console.log(`❌ ${name}\n   ${e.message}`) }
}

/* ---------------- diff 精确性 ---------------- */

t('diff：中间插入', () => {
  const e = diff('abcdef', 'abXdef')
  eq('  重放后得到 target', applyEdits('abcdef', e), 'abXdef')
})

t('diff：两处独立修改都要保留', () => {
  const e = diff('abcdef', 'abXdefY')
  eq('  重放后得到 target', applyEdits('abcdef', e), 'abXdefY')
  console.log(`   实际 edits: ${JSON.stringify(e)}`)
})

t('diff：删除 + 插入 + 修改混合', () => {
  for (const [b, x] of [
    ['hello world', 'hello brave world'],
    ['hello world', 'hi world'],
    ['abcdef', ''],
    ['', 'abc'],
    ['aaa', 'aaaa'],
    ['the quick brown fox', 'the quick red fox jumps'],
  ]) {
    const got = applyEdits(b, diff(b, x))
    if (got !== x) throw new Error(`${JSON.stringify(b)} → ${JSON.stringify(x)} 重放得到 ${JSON.stringify(got)}`)
  }
  console.log('   6 组混合用例全部重放一致')
})

t('diff：无变化返回空', () => eq('  diff(x, x)', diff('same', 'same'), []))

t('diff：超过上限退化为整体替换', () => {
  const big = 'a'.repeat(1500)
  const target = 'b' + big.slice(1)
  const e = diff(big, target)
  eq('  退化为单条整体替换', e, [{ start: 0, del: 1500, ins: target }])
})

/* ---------------- 三路合并：核心场景 ---------------- */

t('合并：只有一边改 → 直接采纳', () => {
  eq('  我没改', mergeText('abc', 'abc', 'abXc', () => true).text, 'abXc')
  eq('  对方没改', mergeText('abc', 'abXc', 'abc', () => true).text, 'abXc')
})

t('合并：两边改了不同位置 → 两处都保留', () => {
  // 这是最重要的一条：之前"剥前后缀"的 diff 会把其中一处整段覆盖
  const r = mergeText('aaaXbbbYccc', 'aaaXbbbZccc', 'aaaQbbbYccc', () => true)
  console.log(`   结果: ${JSON.stringify(r.text)}  冲突: ${r.conflicts.length}`)
  if (!r.text.includes('Q') || !r.text.includes('Z')) {
    throw new Error(`并发改两处丢了一处: ${r.text}`)
  }
  ok('合并：两边改了不同位置 → 两处都保留')
})

t('合并：同位置冲突 → 按 tieBreak 仲裁，不丢整块', () => {
  const mineWins = mergeText('hello', 'helloA', 'helloB', () => true)
  const theirWins = mergeText('hello', 'helloA', 'helloB', () => false)
  if (mineWins.text !== 'helloA') throw new Error('我赢时结果不对: ' + mineWins.text)
  if (theirWins.text !== 'helloB') throw new Error('对方赢时结果不对: ' + theirWins.text)
  if (!mineWins.conflicts.length) throw new Error('应该记录冲突')
  ok('合并：同位置冲突 → 按 tieBreak 仲裁，不丢整块')
})

t('合并：重叠与不重叠混在一起', () => {
  // base: 0123456789
  // 我：把 3-5 改成 A，并在末尾加 M
  // 对方：把 3-5 改成 B，并在开头加 N
  const base = '0123456789'
  const mine = '012AB56789M'
  const theirs = 'N012BB56789'
  const r = mergeText(base, mine, theirs, () => true)
  console.log(`   结果: ${JSON.stringify(r.text)}`)
  // N（不重叠）一定要在
  if (!r.text.startsWith('N')) throw new Error('对方开头的插入丢了: ' + r.text)
  // 我赢：A 在
  if (!r.text.includes('A')) throw new Error('我赢的 A 丢了: ' + r.text)
  ok('合并：重叠与不重叠混在一起')
})

t('合并：双方结果一致时不产生冲突', () => {
  const r = mergeText('abc', 'abcX', 'abcX', () => true)
  eq('  结果', r.text, 'abcX')
  eq('  无冲突记录', r.conflicts.length, 0)
})

/* ---------------- 胜负仲裁确定性 ---------------- */

t('仲裁：确定性（同样的输入永远同样结果）', () => {
  const r1 = mergeText('x', 'xA', 'xB', () => wins(10, 'tabA', 5, 'tabB'))
  const r2 = mergeText('x', 'xA', 'xB', () => wins(10, 'tabA', 5, 'tabB'))
  eq('  两次结果一致', r1.text, r2.text)
  if (!wins(10, 'a', 5, 'b')) throw new Error('时间戳大的应胜')
  if (wins(5, 'a', 10, 'b')) throw new Error('时间戳小的不该胜')
  if (!wins(10, 'z', 10, 'a')) throw new Error('同刻时 actor 字典序大的应胜')
  ok('仲裁：确定性（同样的输入永远同样结果）')
})

/* ---------------- 因果就绪 ---------------- */

t('因果：依赖未到 → 不就绪；到了 → 就绪', () => {
  const log = createLog()
  const a = { id: 'o1', actor: 'A', clock: 1, after: [], docId: 'd', kind: 'block.upsert', blockId: 'b1' }
  const b = { id: 'o2', actor: 'A', clock: 2, after: ['o1'], docId: 'd', kind: 'block.upsert', blockId: 'b1' }
  eq('  o2 依赖 o1，o1 未到时不就绪', isReady(b, log), false)
  markApplied(a, log)
  eq('  o1 到了之后 o2 就绪', isReady(b, log), true)
})

t('因果：乱序到达能自动补齐', () => {
  const log = createLog()
  const a = { id: 'o1', actor: 'A', clock: 1, after: [], docId: 'd', kind: 'block.upsert', blockId: 'b1' }
  const b = { id: 'o2', actor: 'B', clock: 1, after: ['o1'], docId: 'd', kind: 'block.upsert', blockId: 'b2' }
  const c = { id: 'o3', actor: 'B', clock: 2, after: ['o2'], docId: 'd', kind: 'block.upsert', blockId: 'b3' }
  // 先到 o3（依赖都没到）
  eq('  o3 先到 → 缓冲，不应用', ingest(c, log), [])
  // 再到 o1
  const r1 = ingest(a, log)
  eq('  o1 到 → 仍不够（缺 o2）', r1.map((o) => o.id), ['o1'])
  // o2 到 → o3 连带放行
  const r2 = ingest(b, log)
  eq('  o2 到 → 连带放出 o3', r2.map((o) => o.id).sort(), ['o2', 'o3'])
})

t('因果：重复的 op 只应用一次', () => {
  const log = createLog()
  const a = { id: 'o1', actor: 'A', clock: 1, after: [], docId: 'd', kind: 'block.upsert', blockId: 'b1' }
  eq('  第一次', ingest(a, log).length, 1)
  eq('  重复投递', ingest(a, log).length, 0)
})

t('因果：对端消失后不会永久卡死（缓冲上限真的收得住）', () => {
  const log = createLog()
  /*
   * ⚠️ 这一段原来是**验不到任何东西**的，2026-10-06 破坏对照时才发现。
   *
   * 原写法：先塞一个孤儿 op（依赖永远不来），再灌 250 个 `after: []` 的 op。
   * 但 `after: []` 意味着**没有未满足的依赖**，这些 op 一进来就是「就绪」的，
   * 会被立刻应用掉、根本不会留在 pending 里 —— 于是 pending 始终只有 1 条
   * （那个孤儿），`log.pending.size > 200` **恒为假**。
   * 后果：把 `ingest` 的 maxPending 默认值从 200 改成 100000，
   * 这个套件**照样 78/0 全绿**。而「对端消失后不会永久卡死」是 CRDT 的
   * 死锁保护，是真功能 —— 它的断言却恒真。
   *
   * 改法：全部造**依赖永远不来**的 op，让 pending 真的涨起来。
   * 这样上限一旦被抬高（200 → 100000），pending 就会冲到 260 > 200 而红。
   */
  const CAP = 200
  let released = 0
  for (let i = 0; i < CAP + 60; i++) {
    const orphan = {
      id: 'x' + i, actor: 'X', clock: i, after: ['never-arrives-' + i],
      docId: 'd', kind: 'block.upsert', blockId: 'b' + i,
    }
    released += ingest(orphan, log).length
  }
  if (log.pending.size > CAP) throw new Error(`缓冲无上限地涨: ${log.pending.size} > ${CAP}`)
  // 只断言「不涨」还不够：那也可能是 ingest 把 op 悄悄丢了。
  // 上限生效时，超出的那些是被**强制放行**的（返回非空），所以这里要能数到。
  if (released === 0) throw new Error('pending 是收住了，但没有任何 op 被强制放行 —— 可能只是被丢了')
  ok(`因果：缓冲收在 ${log.pending.size} ≤ ${CAP}，强制放行了 ${released} 条（对端消失不永久卡死）`)
})

/* ---------------- 端到端并发模拟 ---------------- */

t('端到端：两个客户端并发改不同块，两边改动都在', () => {
  const logA = createLog()
  const logB = createLog()

  // 共同起点
  const base = [
    { id: 'b1', type: 'p', text: '第一段' },
    { id: 'b2', type: 'p', text: '第二段' },
  ]
  const seed = makeOp(logA, 'A', 'd', 'block.upsert', { blockId: 'b1', payload: base[0] })
  markApplied(seed, logA)
  markApplied({ ...seed }, logB)
  const seed2 = makeOp(logA, 'A', 'd', 'block.upsert', { blockId: 'b2', payload: base[1] })
  markApplied(seed2, logA)
  markApplied({ ...seed2 }, logB)

  // A 改 b1，B 改 b2（互不相关）
  const opA = makeOp(logA, 'A', 'd', 'block.upsert', { blockId: 'b1', payload: { id: 'b1', type: 'p', text: '第一段改了' } })
  markApplied(opA, logA)
  const opB = makeOp(logB, 'B', 'd', 'block.upsert', { blockId: 'b2', payload: { id: 'b2', type: 'p', text: '第二段也改了' } })
  markApplied(opB, logB)

  // 交叉投递
  const gotA = ingest({ ...opB }, logA)
  const gotB = ingest({ ...opA }, logB)
  if (!gotA.length) throw new Error('A 没收到 B 的 op')
  if (!gotB.length) throw new Error('B 没收到 A 的 op')
  /* 这一条原来在转换时被漏掉了：它是**模板字符串**（带插值），
     而转换脚本的正则只匹配 `console.log('✅ …')` 的单引号字面量。
     漏掉的表现不是报错，而是通过数从 79 变成 78 ——
     靠「和旧文件逐条对比断言内容」才发现，不是靠肉眼看输出。 */
  ok(`端到端：两个客户端并发改不同块（各收到 ${gotA.length}/${gotB.length} 个 op）`)
})

t('端到端：同块并发，分「同位置」与「不同位置」两种语义', () => {
  // ① 同位置：两边都改「内容」这个词 → 任何 CRDT 都得仲裁，选一是对的
  const same = mergeText('开头内容结尾', '开头改A了结尾', '开头改B了结尾', () => wins(1, 'A', 1, 'B'))
  console.log(`   同位置 → ${same.text}（选中一方，冲突 ${same.conflicts.length} 处）`)
  if (same.text !== '开头改B了结尾' && same.text !== '开头改A了结尾') {
    throw new Error('同位置仲裁结果既不是我也不是对方: ' + same.text)
  }
  if (!same.conflicts.length) throw new Error('同位置冲突必须被记录下来')

  // ② 不同位置：我在第 5 位插 X，对方在第 8 位插 Y → 两处都该活
  const diff2 = mergeText('0123456789', '01234X56789', '01234567Y9', () => true)
  console.log(`   不同位置 → ${diff2.text}`)
  if (!diff2.text.includes('X')) throw new Error('X 丢了: ' + diff2.text)
  if (!diff2.text.includes('Y')) throw new Error('Y 丢了: ' + diff2.text)
  if (diff2.conflicts.length) throw new Error('不同位置不该记为冲突: ' + JSON.stringify(diff2.conflicts))
  ok('端到端：同块并发，同位置仲裁、不同位置全保留')
})

/* ============================================================
   对象级三路合并（doc.sheetData / Block.data 走的就是这套）
   ============================================================ */

/* ---------------- 收敛：两端各自判断，结论必须一致 ---------------- */

/**
 * 这一组是踩过的坑的钉子：
 * 仲裁时「我方版本」取错（取成了刚收进来的那条 op），wins(o, o) 恒为真，
 * 于是两端各自都判自己赢 —— 各留各的，永远不收敛。
 * 这里从两端各算一遍，要求字面完全一致，且和 clock 大小无关。
 */
t('收敛：同位置并发，两端各自算 → 字面一致（clock 大的赢，两端都认）', () => {
  const base = '正文'
  const mineA = '正文A'
  const mineB = '正文B'
  // A 的 clock=3，B 的 clock=8
  const onA = mergeText(base, mineA, mineB, () => wins(3, 'tabA', 8, 'tabB'))
  // B 那边是反过来的：mine 是 B（clock 8），theirs 是 A（clock 3）
  const onB = mergeText(base, mineB, mineA, () => wins(8, 'tabB', 3, 'tabA'))
  eq('  两端结果一致', onA.text, onB.text)
  eq('  大 clock 的一方胜出', [onA.text, onA.conflicts.length], [mineB, 1])
  eq('  两端记的冲突数一致', onA.conflicts.length, onB.conflicts.length)
})

t('收敛：clock 相等时按 actor 定序，仍然两端一致', () => {
  const base = '正文'
  const onA = mergeText(base, '正文A', '正文B', () => wins(5, 'tabA', 5, 'tabB'))
  const onB = mergeText(base, '正文B', '正文A', () => wins(5, 'tabB', 5, 'tabA'))
  eq('  两端结果一致', onA.text, onB.text)
  eq('  actor 字典序大的胜出', onA.text, '正文B')
})

t('收敛：不同位置并发，两端各自算 → 字面一致且两处都保留', () => {
  const base = '0123456789'
  const onA = mergeText(base, '01234X56789', '01234567Y9', () => wins(9, 'tabA', 2, 'tabB'))
  const onB = mergeText(base, '01234567Y9', '01234X56789', () => wins(2, 'tabB', 9, 'tabA'))
  eq('  两端结果一致', onA.text, onB.text)
  eq('  两处改动都在', onA.text.includes('X') && onA.text.includes('Y'), true)
  eq('  不算冲突', onA.conflicts.length, 0)
})

t('收敛：对象级合并同样从两端各算一遍（文稿数据 / 卡片数据）', () => {
  const base = { cardId: 'vote', myVote: '', closed: false, options: [{ id: 'o1', votes: [] }, { id: 'o2', votes: [] }] }
  const mineA = { ...base, myVote: 'o1' }
  const mineB = { ...base, closed: true }
  const onA = mergeObject(base, mineA, mineB, { tieBreak: () => wins(3, 'tabA', 8, 'tabB') })
  const onB = mergeObject(base, mineB, mineA, { tieBreak: () => wins(8, 'tabB', 3, 'tabA') })
  eq('  两端结果一致', JSON.stringify(onA.value), JSON.stringify(onB.value))
  // 这里改的是不同字段，本来就不该有冲突，两端也都该是 0
  eq('  不同字段不算冲突', [onA.conflicts.length, onB.conflicts.length], [0, 0])
})

t('对象合并：只有一边改 → 直接采纳，且不算冲突', () => {
  const base = { name: '需求', status: '待开始' }
  const r1 = mergeObject(base, { ...base, status: '进行中' }, base, { tieBreak: () => true })
  eq('  我改了 status', [r1.value.status, r1.conflicts.length], ['进行中', 0])
  const r2 = mergeObject(base, base, { ...base, status: '已完成' }, { tieBreak: () => true })
  eq('  对方改了 status', [r2.value.status, r2.conflicts.length], ['已完成', 0])
})

t('对象合并：不同字段 → 各自的都保留（投票/打卡这类最常见）', () => {
  const base = { cardId: 'vote', q: '选哪个', myVote: '', closed: false, options: [] }
  const mine = { ...base, myVote: 'o1' }
  const theirs = { ...base, closed: true }
  const r = mergeObject(base, mine, theirs, { tieBreak: () => true })
  eq('  我投了票也保住了', r.value.myVote, 'o1')
  eq('  对方结束了投票也保住了', r.value.closed, true)
  eq('  不算冲突', r.conflicts.length, 0)
})

t('对象合并：同一字段两边都改 → 按 tieBreak 仲裁并记录冲突', () => {
  const base = { cardId: 'vote', myVote: '' }
  const r1 = mergeObject(base, { ...base, myVote: 'o1' }, { ...base, myVote: 'o2' }, { tieBreak: () => true })
  const r2 = mergeObject(base, { ...base, myVote: 'o1' }, { ...base, myVote: 'o2' }, { tieBreak: () => false })
  eq('  我赢', r1.value.myVote, 'o1')
  eq('  对方赢', r2.value.myVote, 'o2')
  eq('  两次都记了冲突', [r1.conflicts.length, r2.conflicts.length], [1, 1])
  eq('  冲突路径', r1.conflicts[0].path, 'myVote')
})

t('对象合并：id 数组（画板卡片）→ 各自的卡片都在，id 不乱', () => {
  const base = { cards: [{ id: 'b1', text: 'A', x: 0 }, { id: 'b2', text: 'B', x: 0 }] }
  const mine = { cards: [{ id: 'b1', text: 'A', x: 10 }, { id: 'b2', text: 'B', x: 0 }] }
  const theirs = { cards: [{ id: 'b1', text: 'A', x: 0 }, { id: 'b2', text: 'B', x: 20 }] }
  const r = mergeObject(base, mine, theirs, { tieBreak: () => true })
  eq('  卡片数', r.value.cards.length, 2)
  eq('  顺序不变（id 认领，不靠下标）', r.value.cards.map((c) => c.id), ['b1', 'b2'])
  eq('  我挪的 b1', r.value.cards[0].x, 10)
  eq('  对方挪的 b2', r.value.cards[1].x, 20)
  eq('  不算冲突', r.conflicts.length, 0)
})

t('对象合并：id 数组并发增删 → 两边新增的都在，删掉的按「删除 vs 未改」', () => {
  const base = { cards: [{ id: 'b1' }, { id: 'b2' }] }
  const mine = { cards: [{ id: 'b1' }, { id: 'b2' }, { id: 'b3' }] }        // 我加了一张
  const theirs = { cards: [{ id: 'b2' }] }                                  // 对方删了 b1
  const r = mergeObject(base, mine, theirs, { tieBreak: () => true })
  eq('  b1 被干净地删掉（对方删、我没动）', r.value.cards.map((c) => c.id), ['b2', 'b3'])

  // 对方删除 vs 我修改：保留修改并记一条冲突（不丢数据优先）
  const r2 = mergeObject(
    { cards: [{ id: 'b1', text: '原' }] },
    { cards: [{ id: 'b1', text: '我改的' }] },
    { cards: [] },
    { tieBreak: () => true },
  )
  eq('  删除 vs 修改 → 保留修改', r2.value.cards.map((c) => c.text), ['我改的'])
  eq('  并记一条冲突', r2.conflicts.length, 1)
})

t('对象合并：工作表 → 同一行不同格都要在（A 改 B3、B 改 C3）', () => {
  const tab = (a, b, c) => ({
    sheets: [{ id: 'sh1', name: '需求列表', cols: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }], rows: [[{ v: a }, { v: b }, { v: c }]] }],
    activeId: 'sh1',
  })
  const r = mergeObject(tab('x', 'y', 'z'), tab('x', '甲', 'z'), tab('x', 'y', '乙'), { tieBreak: () => true })
  eq('  两处改动都在', r.value.sheets[0].rows[0].map((c) => c.v), ['x', '甲', '乙'])
  eq('  不算冲突', r.conflicts.length, 0)
})

t('对象合并：工作表同一格 → 仲裁 + 冲突定位到行/列', () => {
  const tab = (v) => ({ sheets: [{ id: 'sh1', name: '需求列表', rows: [[{ v: '原' }, { v }, { v: 'z' }]] }], activeId: 'sh1' })
  const r = mergeObject(tab('y'), tab('甲'), tab('乙'), { tieBreak: () => false })
  eq('  对方赢', r.value.sheets[0].rows[0][1].v, '乙')
  eq('  记了 1 处冲突', r.conflicts.length, 1)
  const names = collectNames(tab('y'))
  eq('  冲突文案', describeConflictPath(r.conflicts[0].segments, names), '工作表「需求列表」 · 第 1 行 · B 列 · 内容')
})

t('对象合并：行数不一致（一边插行）→ 整体择一且记冲突，绝不按下标硬合', () => {
  const base = { sheets: [{ id: 'sh1', rows: [[{ v: 'a' }], [{ v: 'b' }]] }] }
  const mine = { sheets: [{ id: 'sh1', rows: [[{ v: 'a' }], [{ v: 'b' }], [{ v: '新行' }]] }] }
  const theirs = { sheets: [{ id: 'sh1', rows: [[{ v: 'a' }], [{ v: 'b改' }]] }] }
  const r = mergeObject(base, mine, theirs, { tieBreak: () => true })
  eq('  我赢：整段取我方（行数对齐不上时不做逐格合并）', r.value.sheets[0].rows.length, 3)
  eq('  记一条冲突', r.conflicts.length, 1)
})

t('对象合并：纯值数组（tags）→ 整体择一', () => {
  const base = { id: 'r1', tags: ['a'] }
  const r = mergeObject(base, { ...base, tags: ['a', 'b'] }, { ...base, tags: ['c'] }, { tieBreak: () => false })
  eq('  取对方整段', r.value.tags, ['c'])
  eq('  记一条冲突', r.conflicts.length, 1)
})

t('对象合并：对方新增字段 / 我删了对方没动的字段', () => {
  const base = { a: 1, b: 2 }
  eq('  对方新增', mergeObject(base, { a: 1, b: 2 }, { a: 1, b: 2, c: 3 }, { tieBreak: () => true }).value.c, 3)
  const r = mergeObject(base, { a: 1 }, { a: 1, b: 2 }, { tieBreak: () => true })
  eq('  我删了 b（对方没动）→ 采纳删除', Object.keys(r.value), ['a'])
  eq('  删除不算冲突', r.conflicts.length, 0)
})

t('对象合并：确定性 —— 同样输入永远同样结果', () => {
  const base = { a: 0 }
  const run = () => mergeObject(base, { a: 1 }, { a: 2 }, { tieBreak: () => wins(3, 'tabA', 7, 'tabB') }).value.a
  eq('  两次一致', [run(), run()], [2, 2])
})

t('对象合并：三方收敛（我合完的结果再喂回去，值不再变化）', () => {
  const base = { sheets: [{ id: 'sh1', rows: [[{ v: 'a' }], [{ v: 'b' }]] }] }
  const mine = { sheets: [{ id: 'sh1', rows: [[{ v: 'a' }], [{ v: 'b' }]] }] }
  const theirs = { sheets: [{ id: 'sh1', rows: [[{ v: 'a' }], [{ v: 'b' }]] }] }
  mine.sheets[0].rows[0][0].v = '我改的'
  theirs.sheets[0].rows[1][0].v = '对方改的'
  const onA = mergeObject(base, mine, theirs, { tieBreak: () => true }).value
  const onB = mergeObject(base, theirs, mine, { tieBreak: () => true }).value
  eq('  两端结果一致（收敛）', JSON.stringify(onA), JSON.stringify(onB))
  const again = mergeObject(base, onA, onB, { tieBreak: () => true })
  eq('  再合一次不再变（幂等）', JSON.stringify(again.value), JSON.stringify(onA))
  eq('  再合一次不产生新冲突', again.conflicts.length, 0)
})

t('deepEqual：引用相同 / 顶层新对象 / 预算耗尽', () => {
  eq('  同引用', deepEqual({ a: 1 }, (() => { const o = { a: 1 }; return o })()), true)
  eq('  顶层不同引用、内容相同', deepEqual({ a: [1, 2] }, { a: [1, 2] }), true)
  eq('  内容不同', deepEqual({ a: 1 }, { a: 2 }), false)
  eq('  少一个键', deepEqual({ a: 1, b: 2 }, { a: 1 }), false)
  eq('  数组顺序不同', deepEqual([1, 2], [2, 1]), false)
  eq('  undefined 与 null 不等', deepEqual(null, undefined), false)
  // 预算耗尽时按「不等」处理：不会卡死，只会退化成择一
  eq('  预算耗尽 → 不等', deepEqual({ a: 1 }, { a: 2 }, { n: 0 }), false)
})

t('列标：0 → A，25 → Z，26 → AA', () => {
  eq('  三个边界', [colLetter(0), colLetter(25), colLetter(26)], ['A', 'Z', 'AA'])
})

t('目标记账：sheet.set / card.set 走 target，与块级链互不干扰', () => {
  const log = createLog()
  const a = makeOp(log, 'A', 'd', 'sheet.set', { target: 'sheet:sheets', payload: { key: 'sheets' } })
  markApplied(a, log)
  const c = makeOp(log, 'A', 'd', 'card.set', { blockId: 'b1', target: 'card:b1', payload: {} })
  markApplied(c, log)
  eq('  块级链没被卡片 op 占用（两条链独立）', log.lastOpOf.get('b1'), undefined)
  eq('  卡片链独立记账', log.lastOpOf.get('card:b1'), c.id)
  eq('  文稿数据链独立记账', log.lastOpOf.get('sheet:sheets'), a.id)
  eq('  仲裁拿到 (clock, actor)', lastOpForTarget(log, 'sheet:sheets'), { clock: 1, actor: 'A' })
  eq('  卡片链的时钟是 2', lastOpForTarget(log, 'card:b1').clock, 2)
})

/* 汇总行必须逐字是「结果：N 通过 / M 失败」——
   run-all-tests.mjs:401 按这条正则计数，写成别的语序，
   整个套件会被判成「本身异常」，它那几十项一项都不计进总数。 */
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
