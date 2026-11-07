import type { CardProps, CardComponent, CardData } from './types'
import FileCard from './FileCard'
import FormulaCard from './FormulaCard'
import FoldCard from './FoldCard'
import ColumnsCard from './ColumnsCard'
import EmojiCard from './EmojiCard'
import StatusCard from './StatusCard'
import MentionCard from './MentionCard'
import CalendarCard from './CalendarCard'
import VoteCard from './VoteCard'
import CheckinCard from './CheckinCard'
import MindmapCard from './MindmapCard'
import FlowchartCard from './FlowchartCard'
import EncryptedCard from './EncryptedCard'
import AlbumCard from './AlbumCard'
import KanbanCard from './KanbanCard'
import YuqueDocCard from './YuqueDocCard'
import LocalFileCard from './LocalFileCard'
import LocalAudioCard from './LocalAudioCard'
import LocalVideoCard from './LocalVideoCard'
import PlantumlCard from './PlantumlCard'
import UmlCard from './UmlCard'
import { YoukuCard, BilibiliCard, NeteaseCard, AmapCard, FigmaCard, JuejinCard } from './EmbedCards'
import { YUQUE_CARDS } from '@/data/cards'
import './cards.css'

/* ============================================================
   特色卡片注册表
   key = src/data/cards.ts 里的 card id
   Editor 拿到 data.cardId 后按这里查组件，组件把变更回写到 data。
   ============================================================ */

export const CARD_REGISTRY: Record<string, CardComponent> = {
  /* 基础类 */
  file: FileCard,
  status: StatusCard,
  /* 画板类 */
  mindmap: MindmapCard,
  flowchart: FlowchartCard,
  /* 数据表 */
  album: AlbumCard,
  kanban: KanbanCard,
  /* 程序员专区 */
  formula: FormulaCard,
  uml: UmlCard,
  plantuml: PlantumlCard,
  /* 布局和样式 */
  fold: FoldCard,
  columns: ColumnsCard,
  emoji: EmojiCard,
  /* 小工具 */
  mention: MentionCard,
  calendar: CalendarCard,
  vote: VoteCard,
  checkin: CheckinCard,
  encrypted: EncryptedCard,
  yuquedoc: YuqueDocCard,
  /* 嵌入本地文件 */
  localfile: LocalFileCard,
  localaudio: LocalAudioCard,
  localvideo: LocalVideoCard,
  /* 嵌入第三方服务 */
  youku: YoukuCard,
  bilibili: BilibiliCard,
  netease: NeteaseCard,
  amap: AmapCard,
  figma: FigmaCard,
  juejin: JuejinCard,
}

/** 画板 / 工作表 / 数据表 是「独立文稿类型」，插入时新建文稿，不在正文里当卡片渲染 */
export const STANDALONE_CARD_IDS = ['board', 'sheet', 'datatable'] as const

const cardName = (id: string) => YUQUE_CARDS.find((c) => c.id === id)?.name || id

/**
 * 卡片宿主：Editor 的 BlockRow 遇到 type === 'card' 的块时渲染它。
 * data 只从 block.data 来，onChange 把补丁写回 block.data —— 组件内部不留唯一真相。
 */
export default function CardHost({
  cardId,
  data,
  onChange,
  readOnly,
}: {
  cardId: string
  data?: CardData
  onChange: (patch: CardData) => void
  readOnly?: boolean
}) {
  const Cmp = CARD_REGISTRY[cardId]
  return (
    <div className="yq-kc-host" data-card-id={cardId} contentEditable={false}>
      {Cmp ? (
        <Cmp data={data || {}} onChange={onChange} readOnly={readOnly} />
      ) : (
        <div className="yq-kc yq-kc-flat">
          <div className="yq-kc-head">
            <span className="yq-kc-icon">❓</span>
            <span className="yq-kc-title">未实现的卡片：{cardName(cardId)}</span>
          </div>
          <div className="yq-kc-body">
            <div className="yq-kc-note is-info">
              <span>ℹ️</span>
              <span>
                这张卡片没有对应的正文内编辑器。
                {(STANDALONE_CARD_IDS as readonly string[]).includes(cardId)
                  ? '它是一种独立文稿类型，应该从左侧目录里打开对应的文稿。'
                  : '可以直接删掉这个块。'}
              </span>
            </div>
            <pre
              style={{
                margin: 0, fontSize: 11, color: 'var(--yq-text-3)',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 120, overflow: 'auto',
              }}
            >
              {JSON.stringify(data || {}, null, 2).slice(0, 400)}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}
