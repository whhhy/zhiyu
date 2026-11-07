import { useEffect, useState } from 'react'
import { CardShell, MiniBtn } from './common'
import { renderLatex } from './latex'
import type { CardProps } from './types'

interface FormulaData {
  src?: string
  display?: boolean
}

const SAMPLES: [string, string][] = [
  ['分式', '\\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}'],
  ['求和', '\\sum_{i=1}^{n} \\frac{1}{i^2} = \\frac{\\pi^2}{6}'],
  ['积分', '\\int_{0}^{\\infty} e^{-x^2} dx = \\frac{\\sqrt{\\pi}}{2}'],
  ['矩阵', 'A = \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'],
  ['上下标', 'f(x) = \\sum_{k=0}^{n} \\binom{n}{k} x^{k} (1-x)^{n-k}'],
  ['分段函数', 'f(x) = \\begin{cases} x^2 & x \\geq 0 \\\\ -x & x < 0 \\end{cases}'],
]

/** 渲染器能力清单：放字符串常量里，避免 JSX 里出现裸反斜杠 */
const CAPABILITIES =
  '自研渲染器，支持分式 / 根号 / 上下标 / 希腊字母 / 关系符 / 大算符限位 / 矩阵 / 分段函数 / 重音 / ' +
  '\\text{} / \\mathbb{R} / \\begin{pmatrix}。'

/** 公式卡片：左写 LaTeX，右真渲染（自研迷你 KaTeX，不引第三方库） */
export default function FormulaCard({ data, onChange, readOnly }: CardProps<FormulaData>) {
  const src = data?.src ?? ''
  const [showAll, setShowAll] = useState(false)

  // 输入时防抖渲染，避免每敲一个字符都重排整段公式
  const [live, setLive] = useState(src)
  useEffect(() => setLive(src), [src])
  useEffect(() => {
    const t = setTimeout(() => {
      if (live !== src && !readOnly) onChange({ src: live })
    }, 350)
    return () => clearTimeout(t)
  }, [live]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <CardShell
      icon="∑"
      title="公式"
      desc="LaTeX 源码"
      actions={
        <>
          <MiniBtn active={data?.display !== false} onClick={() => onChange({ display: data?.display === false })}>
            行内/块级
          </MiniBtn>
          {!readOnly && (
            <MiniBtn onClick={() => setShowAll((v) => !v)}>{showAll ? '收起示例' : '示例'}</MiniBtn>
          )}
        </>
      }
    >
      <textarea
        className="yq-kc-textarea yq-kc-formula-src"
        defaultValue={src}
        readOnly={readOnly}
        placeholder="例如 \frac{a}{b} 或 \sum_{i=1}^{n} i"
        onChange={(e) => setLive(e.target.value)}
      />
      <div className="yq-kc-formula-out">{src.trim() ? renderLatex(src) : <span className="yq-kc-hint">在上方写公式，这里实时渲染</span>}</div>
      {showAll && (
        <div className="yq-kc-row" style={{ marginTop: 8 }}>
          {SAMPLES.map(([label, code]) => (
            <MiniBtn key={label} onClick={() => { setLive(code); onChange({ src: code }) }}>
              {label}
            </MiniBtn>
          ))}
        </div>
      )}
      <div className="yq-kc-hint" style={{ marginTop: 6 }}>
        {CAPABILITIES}
      </div>
    </CardShell>
  )
}
