import type { ReactElement } from 'react'

/**
 * 卡片数据 —— 直接落在 Block.data 上。
 * 唯一硬约束：必须是 JSON 可序列化的（要进 localStorage，刷新后还在）。
 */
export type CardData = Record<string, any>

export interface CardProps<T extends CardData = CardData> {
  /** 卡片当前数据（来自 block.data） */
  data: T
  /** 浅合并写回 block.data —— 卡片内部不许留「唯一真相」 */
  onChange: (patch: Partial<T>) => void
  readOnly?: boolean
}

/** 卡片组件：data 进来，onChange 出去（浅合并写回 block.data） */
export type CardComponent = (props: CardProps) => ReactElement | null

/** 卡片内局部 id 生成器（节点、选项等结构化数据用） */
export const uid = (p: string) =>
  `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
