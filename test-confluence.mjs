/**
 * test-confluence：Confluence XML 导出解析
 *
 * ⚠️ **样例是我按公开文档构造的，不是真实导出包。**
 *   结构依据：Atlassian 官方导出文档 + XWiki《Confluence XML Format》。
 *   所以这个套件能验的是「解析器对我理解的格式是否自洽」，
 *   **不能**证明「在真包上能跑」。拿到真样本后这里要大改。
 *   这一点在 `src/lib/confluence.ts` 顶部也写着了。
 */
import { parseConfluenceXml } from './src/lib/confluence.ts'

/**
 * 极简 Markdown → 块，和 `test-lakebook` 用的是同一套（那边也是自己写的）。
 *
 * 为什么不 import store 的真函数：那个函数在 `src/store` 里，
 * 拖着 React 与一堆状态；解析器本身不依赖它，测试也就更不该依赖。
 * 这里验的是「storage format 真的被转成了块」，
 * 不是「store 那个 markdownToBlocks 好不好」——那是另一件事。
 */
const mdToBlocks = (md) =>
  md.split(/\n{2,}/).filter((s) => s.trim()).map((s, i) => {
    const t = s.trim()
    const h = /^(#{1,6})\s+(.*)$/.exec(t)
    if (h) return { id: 'b' + i, type: 'h' + h[1].length, text: h[2], order: i }
    return { id: 'b' + i, type: 'p', text: t, order: i }
  })

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label} ${extra}`) }
}

/* ============================================================
   按文档构造的样例
   ------------------------------------------------------------
   结构照 XWiki 那份文档写：hibernate-generic 根、object 带 class、
   id 用 <id name="id">、属性用 <property name="X"><![CDATA[…]]></property>、
   页面正文在另一条 BodyContent 上、层级在 <collection name="ancestors"> 里。
   ============================================================ */

const ENTITIES = `<?xml version="1.0" encoding="UTF-8"?>
<hibernate-generic datetime="2026-10-01 10:00:00" package="com.atlassian.confluence">

<object class="com.atlassian.confluence.spaces.Space" package="com.atlassian.confluence.spaces">
  <id name="key">ENG</id>
  <property name="name"><![CDATA[工程手册]]></property>
</object>

<object class="com.atlassian.confluence.pages.Page" package="com.atlassian.confluence.pages">
  <id name="id">100</id>
  <property name="title"><![CDATA[快速上手]]></property>
  <property name="bodyContentId">110</property>
  <collection name="ancestors" class="java.util.Collection"/>
</object>

<object class="com.atlassian.confluence.pages.Page" package="com.atlassian.confluence.pages">
  <id name="id">200</id>
  <property name="title"><![CDATA[部署说明]]></property>
  <property name="bodyContentId">210</property>
  <collection name="ancestors" class="java.util.Collection">
    <element class="com.atlassian.confluence.pages.Page"><id name="id">100</id></element>
  </collection>
</object>

<object class="com.atlassian.confluence.pages.Page" package="com.atlassian.confluence.pages">
  <id name="id">300</id>
  <property name="title"><![CDATA[灰度发布]]></property>
  <property name="bodyContentId">310</property>
  <collection name="ancestors" class="java.util.Collection">
    <element class="com.atlassian.confluence.pages.Page"><id name="id">100</id></element>
    <element class="com.atlassian.confluence.pages.Page"><id name="id">200</id></element>
  </collection>
</object>

<object class="com.atlassian.confluence.core.BodyContent" package="com.atlassian.confluence.core">
  <id name="id">110</id>
  <property name="body"><![CDATA[<h1>快速上手</h1><p>先装依赖，再跑起来。</p><ul><li>第一步</li><li>第二步</li></ul>]]></property>
</object>

<object class="com.atlassian.confluence.core.BodyContent" package="com.atlassian.confluence.core">
  <id name="id">210</id>
  <property name="body"><![CDATA[<h2>部署</h2><table><tbody><tr><th>环境</th><th>命令</th></tr><tr><td>生产</td><td>make deploy</td></tr></tbody></table>]]></property>
</object>

<object class="com.atlassian.confluence.core.BodyContent" package="com.atlassian.confluence.core">
  <id name="id">310</id>
  <property name="body"><![CDATA[<p>灰度步骤 &amp; 回滚方式</p><pre><code>make canary</code></pre>]]></property>
</object>

<object class="com.atlassian.confluence.pages.Attachment" package="com.atlassian.confluence.pages">
  <id name="id">900</id>
  <property name="fileName"><![CDATA[架构图.png]]></property>
  <property name="contentId"><![CDATA[100]]></property>
</object>

<object class="com.atlassian.confluence.comments.Comment" package="com.atlassian.confluence.comments">
  <id name="id">950</id>
  <property name="body"><![CDATA[这条评论本版不导]]></property>
</object>

<object class="com.atlassian.confluence.pages.BlogPost" package="com.atlassian.confluence.pages">
  <id name="id">980</id>
  <property name="title"><![CDATA[一篇博客]]></property>
</object>

</hibernate-generic>`

const DESCRIPTOR = `# Confluence Site Backup
spaceName=工程手册
spaceKey=ENG
exportDate=2026-10-01
`

const parse = (xml = ENTITIES, desc = DESCRIPTOR) =>
  parseConfluenceXml(xml, desc, (md) => mdToBlocks(md))

/* ============================================================ */

console.log('\n== 页面：认得出来、标题与正文串对了 ==')
{
  const r = parse()
  ok(r.docs.length === 3, `解析出 3 篇页面（实际 ${r.docs.length}）`, JSON.stringify(r.docs.map((d) => d.title)))
  const top = r.docs.find((d) => d.id === '100')
  ok(!!top && top.title === '快速上手', '标题读对了', top && top.title)
  ok(!!top && /装依赖/.test(top.html), '**正文通过 bodyContentId 串起来了**（不在 Page 里，在 BodyContent 上）', (top && top.html || '').slice(0, 50))
  ok(!!top && /第一步/.test(top.html), '列表那部分也在正文里', '')
}

console.log('\n== storage format → Markdown：复用已有通路 ==')
{
  const top = parse().docs.find((d) => d.id === '100')
  ok(/# 快速上手/.test(top.markdown), 'h1 变成 Markdown 标题', JSON.stringify(top.markdown.slice(0, 30)))
  ok(/- 第一步/.test(top.markdown) || /- 第一步/.test(top.markdown), '列表项变成 `- `', JSON.stringify(top.markdown))
  ok(top.blocks.length > 0, '**块也生成了**（走的是 store 同一套 mdToBlocks）', String(top.blocks.length))
  ok(top.blocks[0]?.type === 'h1', '第一块是 h1（不是退化成纯文本）', top.blocks[0]?.type)
}

console.log('\n== 表格和代码块 ==')
{
  const dep = parse().docs.find((d) => d.id === '200')
  ok(/\| 环境 \| 命令 \|/.test(dep.markdown), '表格转成 Markdown 表格', JSON.stringify(dep.markdown.slice(0, 60)))
  const canary = parse().docs.find((d) => d.id === '300')
  ok(/```/.test(canary.markdown), '代码块转成围栏', JSON.stringify(canary.markdown.slice(0, 60)))
  ok(/&/.test(canary.markdown) && !/&amp;/.test(canary.markdown),
    '**实体被解开了**（`&amp;` 变 `&`）', JSON.stringify(canary.markdown.slice(0, 40)))
}

console.log('\n== 目录层级：靠 ancestors，不靠 parentId ==')
{
  const r = parse()
  const byId = Object.fromEntries(r.docs.map((d) => [d.id, d]))
  ok(byId['100'].depth === 0, '顶层页 depth 0', String(byId['100'].depth))
  ok(byId['200'].depth === 1, '第二层 depth 1', String(byId['200'].depth))
  ok(byId['300'].depth === 2, '第三层 depth 2', String(byId['300'].depth))
  ok(byId['200'].ancestors[0] === '100', '父链存的是页面 id', JSON.stringify(byId['200'].ancestors))
  ok(r.tree.length === 3 && r.tree[2].title === '灰度发布', 'tree 也带上了', JSON.stringify(r.tree.map((t) => t.title)))
}

console.log('\n== 统计：要说清「什么没导」，不能只说导了几篇 ==')
{
  const r = parse()
  ok(r.stats.pages === 3, '3 篇页面', String(r.stats.pages))
  ok(r.stats.attachments === 1, '**附件数被数出来了**（本版只数不导，得让人知道）', String(r.stats.attachments))
  ok(r.stats.comments === 1, '评论数被数出来了', String(r.stats.comments))
  ok(r.stats.blogs === 1, '博客数被数出来了', String(r.stats.blogs))
  ok(r.spaceName === '工程手册', '空间名从 exportDescriptor.properties 读到了', r.spaceName)
}

console.log('\n== 坏包 / 缺东西要报，不能静默导出一堆空文档 ==')
{
  let msg = ''
  try { parse('<hibernate-generic><object class="com.foo.Bar"><id name="id">1</id></object></hibernate-generic>') }
  catch (e) { msg = String(e.message) }
  ok(/没有读到任何页面|不是 Confluence/.test(msg), '一个页面都没有时说清楚了', msg)

  // bodyContentId 串不上 → 如实记一条 + 列出是哪几篇
  const broken = ENTITIES.replace('<property name="bodyContentId">110</property>', '<property name="bodyContentId">999</property>')
  const r = parse(broken)
  const top = r.docs.find((d) => d.id === '100')
  ok(top && top.html === '', '串不上的正文是空的（**不编造内容**）', JSON.stringify(top && top.html))
  ok(r.stats.emptyPages.includes('快速上手'), '`emptyPages` 里点名了是哪一篇', JSON.stringify(r.stats.emptyPages))
  ok(r.warnings.some((w) => /快速上手/.test(w) && /空文档/.test(w)),
    '**warning 里说清了「导入后会是空文档」**（这是用户最需要知道的一句）', JSON.stringify(r.warnings))

  /*
   * 父页不在包里（选 Custom Export 就会这样）。
   *
   * ⚠️ 第一版这条红过，而红的原因**不是**解析器有问题 —— 是我的**造法不对**：
   * 我用 `ENTITIES.replace(/…<id name="id">100<\/id><\/element>/g, '')`，
   * 可那条正则**在 300 那页里删掉的是祖先列表里的一项**，
   * 结果 200 / 300 的父链都空了，「父页不在包里」这件事压根没造出来。
   *
   * 真正要造的是「父链指向一个包里没有的 id」，所以这里直接把
   * ancestors 里的 100 换成 9999（一个包里不存在的 id），
   * 而**不动任何页面本身**。这样才是「这一页的父在包外」那个形状。
   */
  const orphan = ENTITIES
    .replace(
      '<element class="com.atlassian.confluence.pages.Page"><id name="id">100</id></element>',
      '<element class="com.atlassian.confluence.pages.Page"><id name="id">9999</id></element>',
    )
  ok(orphan !== ENTITIES, '（前置确认）父链真的被改成了包外的 id', '')
  const r2 = parse(orphan)
  ok(r2.docs.length === 3, '缺父页也不丢页面', String(r2.docs.length))
  ok(r2.docs.find((d) => d.id === '200')?.ancestors[0] === '9999',
    '父链里存的就是那个包外 id', JSON.stringify(r2.docs.find((d) => d.id === '200')?.ancestors))
  ok(r2.warnings.some((w) => /父页面不在/.test(w)),
    '父链指向包外页面时给出提示', JSON.stringify(r2.warnings))
}

console.log('\n== 结构假设：这份样例是我照文档造的 ==')
{
  /*
   * 这一节把「我凭什么这么写」摆在明面上。
   * 它验的不是格式对不对（那要真样本），而是**代码确实按我说的假设走** ——
   * 万一以后有人改了正则，这里会红。
   */
  const t = parse()
  const top = t.docs.find((d) => d.id === '100')
  ok(top && top.markdown.length > 0, 'CDATA 里的内容被取出来了（不是 XML 标签本身）', (top && top.markdown || '').slice(0, 40))
  ok(top && !top.markdown.includes('CDATA'), '**没有把 CDATA 标记当正文**', '')

  /*
   * 类型名认不出来时要怎样。
   *
   * 第一版我把 `…core.BodyContent` 改成 `…somethingelse.BodyContent`，
   * 然后断言「正文为空」—— 红了，而**红的是我的期望**：
   * 类型名是「class 属性的最后一段」，`somethingelse.BodyContent` 的
   * 最后一段**仍然是 `BodyContent`**，所以它照常被认出来。
   * 换句话说那条改名**根本没造出「认不出来」的形状**。
   *
   * 真要造，得把**类名本身**改掉（`…core.正文容器`），而不是改包名。
   * 顺便把这条陷阱写在注释里：改 class 时要看的是**最后一段**。
   */
  // `replace` 只换**第一处**，而样例里有 3 个 BodyContent —— 所以要 replaceAll，
  // 否则只改了 110（快速上手那篇），200/300 的正文照常有内容。
  // 第一版就是在这儿只红了一项，现象是「有的篇空了有的没空」。
  const withOther = ENTITIES.replaceAll('core.BodyContent', 'core.UnknownBodyThing')
  ok((ENTITIES.match(/core\.BodyContent/g) || []).length === 3
    && (withOther.match(/core\.BodyContent/g) || []).length === 0,
  '（前置确认）三条 BodyContent 全被改了（replace 不带 All 只改第一处）', '')
  const r = parse(withOther)
  ok(r.stats.bodies === 0, '类名认不出来时不算成正文（`bodies=0`）', String(r.stats.bodies))
  ok(r.docs.every((d) => d.html === ''), '三篇正文都是空的（**不编造内容**）', JSON.stringify(r.docs.map((d) => d.html.length)))
  ok(r.stats.emptyPages.length === 3, '**三篇都进了 emptyPages**（用户能一眼看出哪几篇是空的）', JSON.stringify(r.stats.emptyPages))
  ok(r.warnings.filter((w) => /空文档/.test(w)).length === 3, '三条 warning 逐篇点名', String(r.warnings.length))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
