/*
 * 抽出 src/ 里所有**用户能读到的能力声称**，供人工逐条对着实现核。
 *
 * 为什么做这件事：
 *   搜索页空态写过「覆盖文档标题、正文、**评论**与小记，并支持按**空间**过滤」——
 *   其中「评论」和「空间」**两个词都是假的**。
 *   页面上写一句自己做不到的话，比不写更糟：用户搜不到某条评论时
 *   会以为「这条评论不存在」，而它就挂在那篇文档底下。
 *
 *   那一处是我对照真实语雀时顺手抓到的。同类的说法在项目里很可能不止一处。
 *
 * ⚠️ 这是**线索清单，不是测试**：它没有断言，红了绿了都不代表什么。
 *    它的用途是「改完功能后过一遍」，把新写的文案捞出来对着实现核一遍。
 *
 *    2026-10-11 首次跑的结论：33 条里抽查 5 条，只有搜索页那两条是假的
 *    （「覆盖…评论…」「按空间过滤」），已修并加了守卫。
 */
const fs = require('fs')
const path = require('path')

function collect(root) {
  const out = []
  ;(function w(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) w(p)
      else if (/\.tsx$/.test(e.name)) out.push(p.split(path.sep).join('/'))
    }
  })(root)
  return out
}

function stripCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(Math.max(0, m.length - p1.length)))
}

/** 声称能力的措辞 */
const CLAIM = /(覆盖|支持|可以|能(?:否)?|自动|一键|实时|跨设备|无需|不用)[^。；;]{2,40}/g

/** 只看用户能读到的位置：JSX 文本 + 常见文案属性 */
const CARRY = /(?:>|desc=|title=|text=|placeholder=|hint=|label=|label2=)["'`]([^"'`<>]{6,120})["'`]/g

const files = collect('src')
const rows = []

for (const f of files) {
  const src = stripCode(fs.readFileSync(f, 'utf8'))
  const lines = src.split('\n')
  lines.forEach((line, i) => {
    // JSX 里的裸文本：>后面直接跟中文
    const jsxText = />\s*([^<>{}]{6,120}?)</g
    let m
    while ((m = jsxText.exec(line))) {
      const t = m[1].trim()
      if (!t || !CLAIM.test(t)) continue
      CLAIM.lastIndex = 0
      rows.push({ f, i: i + 1, t, from: 'jsx' })
    }
    // 文案属性
    let m2
    CARRY.lastIndex = 0
    while ((m2 = CARRY.exec(line))) {
      const t = m2[1].trim()
      if (!t || !CLAIM.test(t)) continue
      CLAIM.lastIndex = 0
      rows.push({ f, i: i + 1, t, from: 'attr' })
    }
  })
}

// 去重（同一句只留一条）
const seen = new Set()
const uniq = rows.filter((r) => {
  const k = r.t
  if (seen.has(k)) return false
  seen.add(k)
  return true
})

console.log(`抽出 ${rows.length} 条 → 去重后 ${uniq.length} 条能力声称（来自 ${files.length} 个 tsx）\n`)
for (const r of uniq) {
  console.log(`${r.f}:${r.i}  [${r.from}]`)
  console.log(`    ${r.t}`)
}