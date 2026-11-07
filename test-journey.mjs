/* ============================================================
   Mermaid `journey`（用户旅程图）解析与 SVG 渲染
   ------------------------------------------------------------
   为什么是「竖排脊柱 + 五格评分条」而不是人脸：人脸才是**语义本身**，
   画得像不像都可能被当成「画对了」，而脊柱 + 评分条是能逐项核的几何。

   ⚠️ 2026-10-15：这套曾经被**整个覆盖掉** ——
   我把一个同名的新文件 `test-journey.mjs`（用户旅程的端到端测试）
   用 `Move-Item -Force` 放到了这个路径上，把本套 31 项冲掉了。
   产品代码没受影响（`src/lib/journey.ts` 原样在），但测试没了，
   于是按实现里**已经写明的每一条陷阱**重建一份。
   教训：新建文件前先确认**这个名字没人用过** ——
   撞名的后果不是「新文件多了」，是「旧文件没了」，而且报告上完全看不出来。

   套件里的断言照**实现注释里写明的坑**写：
     · 任务行 `名称[: 分数][: 参与者, 参与者]`，而**名称里也可能带冒号**：
       按组号取值极易错位（类图/实体关系图已在这上面栽过两次），
       所以实现刻意用 `split(':')`。三段歧义必须判死：
         数字 → 分数；非数字且两段 → 参与者；非数字且三段 → 名字的一部分。
     · **负号必须收进数字判断**：`-1` 不收的话会被当成参与者名，
       界面上那条「负分任务」看起来就是一条普通任务，没有异常也没有提示。
     · 官方评分是整数：静默取整 = 图上 5、源码写 4.6，**数据被改却零提示**。
     · 超出 0–5：任务照画、评分**不画**，并记一笔实话。
     · `score: null` ≠ `score: 0` —— 「没评分」和「评了 0 分」不是一回事。
   ============================================================ */
import { parseJourney, renderJourneySvg, isJourneySource } from './src/lib/journey.ts'
import { parseFlowchart } from './src/lib/flowchart.ts'

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}${extra ? '  ' + extra : ''}`) }
}
const tasksOf = (j) => j.sections.flatMap((s) => s.tasks)

console.log('== 基本解析 ==')
{
  const j = parseJourney([
    'journey',
    'title 一次入职',
    'section 入职前',
    '准备材料: 5: 我, HR',
    '约面试: 3: HR',
    'section 入职后',
    '领电脑: 4',
    '培训: ',
  ].join('\n'))
  ok(j.title === '一次入职', '标题取到了', j.title)
  ok(j.sections.length === 2, '两个 section', String(j.sections.length))
  ok(j.sections[0].title === '入职前', '第一个 section 标题')
  ok(j.sections[1].title === '入职后', '第二个 section 标题')
  const ts = tasksOf(j)
  // ⚠️ 这里是 **4** 个任务 —— 我第一版写成了 3（自己数错了）。
  ok(ts.length === 4, '四个任务', String(ts.length))
  ok(ts[0].name === '准备材料' && ts[0].score === 5, '名称与分数都对', JSON.stringify(ts[0]))
  ok(ts[0].actors.join(',') === '我,HR', '多个参与者按逗号拆开', JSON.stringify(ts[0].actors))
  ok(ts[1].score === 3 && ts[1].actors.join(',') === 'HR', '只有参与者没有分数时不会错位', JSON.stringify(ts[1]))
  ok(ts[2].score === 4 && ts[2].actors.length === 0, '只有分数没有参与者', JSON.stringify(ts[2]))
  // 尾随冒号、第二段为空：既不是分数也不是参与者，但**不能因此丢掉这条任务**
  ok(ts[3].name === '培训' && ts[3].score === null && ts[3].actors.length === 0,
    '尾随冒号（`培训: `）被当成「没分数没参与者」，任务仍在', JSON.stringify(ts[3]))
}

console.log('\n== 三段歧义：名称里带冒号 ==')
{
  // `时间: 下午三点: 我` —— 第二段既不是数字也不是唯一的参与者段
  const j = parseJourney(['journey', 'section 一天', '时间: 下午三点: 我'].join('\n'))
  const t = tasksOf(j)[0]
  ok(t && t.name === '时间: 下午三点', '**名字接了回去**，没有被静默截断', t && t.name)
  ok(t && t.actors.join(',') === '我', '第三段才是参与者', t && JSON.stringify(t.actors))
  ok(t && t.score === null, '不是分数', t && String(t.score))
}
{
  // 只有两段且第二段非数字 → 参与者
  const j = parseJourney(['journey', 'section 一天', '午饭: 我, 小李'].join('\n'))
  const t = tasksOf(j)[0]
  ok(t && t.name === '午饭', '两段时名字就是名字', t && t.name)
  ok(t && t.actors.join(',') === '我,小李', '第二段是参与者', t && JSON.stringify(t.actors))
}

console.log('\n== 分数的三种「不算分」形态 ==')
{
  const j = parseJourney([
    'journey', 'section 一',
    '负分任务: -1: 我',       // 负号必须在数字判断里
    '超范围: 7: 我',
    '非整数: 4.6: 我',
  ].join('\n'))
  const ts = tasksOf(j)
  ok(ts.length === 3, '三个任务都画（不因为数据有问题就丢掉内容）', String(ts.length))
  const neg = ts[0]
  ok(neg.name === '负分任务', '负分那条**名字完好**', neg.name)
  ok(neg.actors.join(',') === '我', '负号没被当成参与者名的一部分', JSON.stringify(neg.actors))
  ok(/超出 0–5/.test(neg.scoreRejected), '并记下了「分数超出 0–5，评分没画」', neg.scoreRejected)

  ok(ts[1].score === null && /超出 0–5/.test(ts[1].scoreRejected),
    '超范围的分数**不画**并记实话', JSON.stringify(ts[1]))
  ok(ts[2].score === 5 && /不是整数/.test(ts[2].scoreRejected),
    '非整数取整到 5，且**说出来**（不能静默改数据）', JSON.stringify(ts[2]))
  ok(j.skipped.length === 3, '三条实话都进了 skipped', JSON.stringify(j.skipped))
}

console.log('\n== null 不等于 0 ==')
{
  const j = parseJourney([
    'journey', 'section 一',
    '没评分: 我',
    '评了零分: 0: 我',
  ].join('\n'))
  const ts = tasksOf(j)
  ok(ts[0].score === null, '没写分数是 null', String(ts[0].score))
  ok(ts[1].score === 0, '写了 0 分是 0', String(ts[1].score))
  ok(ts[0].score !== ts[1].score, '**两者可区分**（渲染时才能画成「没评分」而不是「0 分」）')
}

console.log('\n== 分组容错 ==')
{
  const j = parseJourney(['journey', '没写 section 的一条: 我'].join('\n'))
  ok(j.sections.length === 1, '没有 section 的任务**不丢**，归到匿名分组', JSON.stringify(j.sections.length))
  ok(j.sections[0].tasks.length === 1, '任务在里面')
}
{
  const j = parseJourney(['journey', 'title T', 'section 空组', 'section 有内容', '真任务: 我'].join('\n'))
  ok(j.sections.length === 1 && j.sections[0].title === '有内容', '空分组被过滤掉（画一条空色带像是出错了）', JSON.stringify(j.sections.map((s) => s.title)))
}

console.log('\n== 识别 ==')
{
  ok(isJourneySource('journey\ntitle X'), '认得出 journey')
  ok(isJourneySource('%% 注释\n\njourney\ntitle X'), '跳过 %% 注释与空行后再认', '（首行有意义的那行才是判据）')
  ok(isJourneySource('JOURNEY'), '大小写不敏感')
  ok(!isJourneySource('flowchart TD\nA-->B'), '不会把流程图认成旅程图')
  ok(!isJourneySource(''), '空输入不是旅程图')
}

console.log('\n== 识别得由识别层负责，不是解析器 ==')
{
  /*
   * ⚠️ 第一版在这里断言「parseFlowchart 不该把它拆成节点（≤2）」——
   *   那是**我猜的**，实现里根本没有这条契约（实测是 4 个节点，不多不少）。
   *   真正的契约只有一个：**识别层认得它**，于是派发到 journey 而不是 flowchart。
   *
   *   「被别的解析器拆成几个节点」不是缺陷 —— 派发对了，别的解析器看到什么
   *   根本不会被执行。断言一个不存在的要求，只会让人为了让它变绿去改正确的产品代码。
   */
  const src = 'journey\ntitle T\nsection 一\n任务: 5: 我'
  ok(isJourneySource(src), '识别层认领了 journey 源码（派发靠的就是这一条）')
  ok(!isJourneySource('flowchart TD\nA-->B'), '而流程图不会被误认成 journey')
}

console.log('\n== SVG 渲染 ==')
{
  const j = parseJourney([
    'journey', 'title 一次入职', 'section 入职', '准备材料: 5: 我', '约面试: 2',
  ].join('\n'))
  const svg = renderJourneySvg(j)
  ok(/^<svg/.test(svg), '产出 SVG')
  ok(svg.includes('一次入职'), '标题画进去了')
  ok(svg.includes('准备材料') && svg.includes('约面试'), '两个任务都在')
  // 评分条：5 分 = 5 格、2 分 = 2 格
  const rects = (svg.match(/<rect/g) || []).length
  ok(rects > 0, `有矩形元素（${rects} 个）—— 评分条是画出来的，不是文字`)
  /*
   * ⚠️ 第一版断言「SVG 里有 stroke 属性」，那是**我猜的**。
   * 实际的样式走 **CSS class**（`yq-journey-section` 等），
   * SVG 里刻意不带内联样式（配色在样式表里，改主题不用重渲）。
   * 断言一个不存在的属性，只会让人去给渲染器硬塞内联样式。
   */
  ok(/class="yq-journey-section"/.test(svg), '阶段色带带上了样式 class（配色在样式表，不在 SVG 里）')
  ok(!/<svg[^>]*\sstyle=/.test(svg), 'SVG 根上没有内联 style')
}

console.log('\n== 转义与中文宽度 ==')
{
  const j = parseJourney([
    'journey', 'title <b>&"危险"</b>', 'section <script>', 'a<b>&c: 5: 我',
  ].join('\n'))
  const svg = renderJourneySvg(j)
  ok(!svg.includes('<b>'), '标题里的 <b> 被转义了，没有变成真的标签')
  ok(svg.includes('&lt;b&gt;'), '以实体形式出现')
  ok(svg.includes('&amp;'), '& 也转义了')
  ok(!/<script>/.test(svg), '<script> 没有原样进 SVG')
  // 中文按字号算宽、西文按 0.56 倍 —— 估窄了会被裁成「知…」
  const long = parseJourney(['journey', 'title T', 'section 一', '一个很长的中文任务名字用来测试宽度计算是否正确不会把字裁掉: 5: 我'].join('\n'))
  const s2 = renderJourneySvg(long)
  ok(!s2.includes('…'), '中文标签**没有被裁成省略号**（宽度按中西文分别算）')
}

console.log('\n== 空输入不崩 ==')
{
  const j = parseJourney('')
  ok(j && Array.isArray(j.sections) && j.title === '', '空源码返回空结构，不抛')
  /*
   * ⚠️ 第一版断言「空结构也能渲染出 SVG」—— 也是**我猜的**。
   * 实现里是 `if (!tasks) return ''`：**一个任务都没有就什么都不画**。
   * 那是对的 —— 画一张空画布会被当成「渲染坏了」。
   */
  const svg = renderJourneySvg(j)
  ok(svg === '', '一个任务都没有时**什么都不画**（返回空串，不是空画布）', `实得 ${JSON.stringify(svg).slice(0, 40)}`)
  // 只写标题、没有任务 → 同样什么都不画
  ok(renderJourneySvg(parseJourney('journey\ntitle 只有标题')) === '', '只有标题没有任务时也不画')
  // 但有一个任务就必须画
  ok(renderJourneySvg(parseJourney('journey\ntitle T\nsection 一\n任务: 我')).length > 0, '有一个任务就正常画出来')
}
{
  const j = parseJourney('journey')
  ok(j.sections.length === 0, '只有一行 journey 时没有分组')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)