import { CardShell, MiniBtn, uid, useCardDefaults } from './common'
import type { CardProps } from './types'

interface MapNode {
  id: string
  text: string
  parent: string | null
}
interface MindmapData {
  nodes?: MapNode[]
}

const DEFAULT: MapNode[] = [
  { id: 'n1', text: '中心主题', parent: null },
  { id: 'n2', text: '分支一', parent: 'n1' },
  { id: 'n3', text: '分支二', parent: 'n1' },
]

/** 思维导图卡片：可增删节点、可改父子关系，画成缩进树 */
export default function MindmapCard({ data, onChange, readOnly }: CardProps<MindmapData>) {
  useCardDefaults(data, onChange, { nodes: DEFAULT })
  const nodes = data?.nodes?.length ? data.nodes : DEFAULT
  const kids = (id: string | null) => nodes.filter((n) => n.parent === id)

  const setNodes = (next: MapNode[]) => onChange({ nodes: next })
  const addChild = (parent: string | null) =>
    setNodes([...nodes, { id: uid('n'), text: '新节点', parent }])
  const del = (id: string) => {
    // 删掉父节点时把它的孩子提到上一层，避免整棵子树消失
    const target = nodes.find((n) => n.id === id)
    if (!target) return
    setNodes(nodes.filter((n) => n.id !== id).map((n) => (n.parent === id ? { ...n, parent: target.parent } : n)))
  }
  const reparent = (id: string, parent: string) => {
    if (id === parent) return
    // 防环：不能挂到自己的子孙下面
    const isDescendant = (pid: string, root: string): boolean => {
      const p = nodes.find((n) => n.id === pid)?.parent
      if (!p) return false
      return p === root || isDescendant(p, root)
    }
    if (isDescendant(parent, id)) return
    setNodes(nodes.map((n) => (n.id === id ? { ...n, parent } : n)))
  }

  const renderLevel = (parent: string | null, depth: number): JSX.Element => {
    const list = kids(parent)
    return (
      <ul className={depth === 0 ? 'yq-kc-map-tree' : 'yq-kc-map-kids'}>
        {list.map((n) => (
          <li key={n.id} data-map-node={n.id}>
            <div className="yq-kc-map-row">
              <span className={`yq-kc-map-node ${depth === 0 ? 'is-root' : ''}`}>
                <input
                  className="yq-kc-map-text"
                  defaultValue={n.text}
                  readOnly={readOnly}
                  style={{ width: depth === 0 ? 100 : 84 }}
                  onChange={(e) => setNodes(nodes.map((x) => (x.id === n.id ? { ...x, text: e.target.value } : x)))}
                />
              </span>
              {!readOnly && (
                <>
                  <button className="yq-kc-btn" onClick={() => addChild(n.id)} title="加子节点">＋</button>
                  <button className="yq-kc-btn is-danger" onClick={() => del(n.id)} title="删除节点">✕</button>
                  <select
                    className="yq-kc-select"
                    style={{ width: 92, height: 20, fontSize: 11 }}
                    value={n.parent || ''}
                    onChange={(e) => reparent(n.id, e.target.value)}
                    title="改父节点"
                  >
                    <option value="">（顶层）</option>
                    {nodes
                      .filter((x) => x.id !== n.id)
                      .map((x) => (
                        <option key={x.id} value={x.id}>{x.text || '未命名'}</option>
                      ))}
                  </select>
                </>
              )}
            </div>
            {kids(n.id).length > 0 && renderLevel(n.id, depth + 1)}
          </li>
        ))}
      </ul>
    )
  }

  return (
    <CardShell
      icon="🧠"
      title="思维导图"
      desc={`${nodes.length} 个节点`}
      actions={!readOnly ? <MiniBtn onClick={() => addChild(null)}>＋ 顶层节点</MiniBtn> : null}
    >
      <div className="yq-kc-map">{renderLevel(null, 0)}</div>
      {nodes.length === 0 && <div className="yq-kc-hint">节点被删光了，点右上角加一个。</div>}
    </CardShell>
  )
}
