import React from 'react'

interface TreeNodeProps {
  nodeId: string
  components: any[]
  selectedId: string | null
  collapsedIds: Set<string>
  depth: number
  dropIndicator: { targetId: string; position: 'before' | 'after' | 'inside' } | null
  onSelect: (id: string) => void
  onToggleCollapse: (id: string) => void
  onDragStart: (e: React.DragEvent, id: string) => void
  onDragOver: (e: React.DragEvent, id: string) => void
  onDragLeave: () => void
  onDrop: (e: React.DragEvent, id: string) => void
  onDragEnd: () => void
}

export function TreeNode({
  nodeId, components, selectedId, collapsedIds, depth, dropIndicator,
  onSelect, onToggleCollapse, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
}: TreeNodeProps) {
  const compMap = React.useMemo(() => {
    const m = new Map<string, any>()
    components.forEach(c => m.set(c.id, c))
    return m
  }, [components])

  const node = compMap.get(nodeId)
  if (!node) return null

  const isDataTable = node.component === 'DataTable'
  const realChildren: any[] = (node.props?.children || [])
    .map((id: string) => compMap.get(id))
    .filter(Boolean)

  const colVirtualChildren = isDataTable
    ? (node.props?.columns || []).map((col: any, i: number) => ({
        virtualId: `${nodeId}$col$${i}`,
        colIndex: i,
        key: col.key || '(未命名)',
        label: col.label || '',
        cellType: col.cellType || 'text',
      }))
    : []

  const canHaveChildren = ['Row', 'Card'].includes(node.component)
  const hasExpandable = realChildren.length > 0 || colVirtualChildren.length > 0
  const isCollapsed = collapsedIds.has(nodeId)
  const isSelected = nodeId === selectedId

  return (
    <>
      <div
        className={`tree-row ${isSelected ? 'tree-row-selected' : ''}`}
        style={{ paddingLeft: (depth * 16 + 8) + 'px' }}
        draggable
        onClick={e => { e.stopPropagation(); onSelect(nodeId) }}
        onDragStart={e => onDragStart(e, nodeId)}
        onDragEnd={onDragEnd}
        onDragOver={e => { e.preventDefault(); onDragOver(e, nodeId) }}
        onDragLeave={onDragLeave}
        onDrop={e => { e.preventDefault(); e.stopPropagation(); onDrop(e, nodeId) }}
      >
        {dropIndicator?.targetId === nodeId && dropIndicator?.position === 'before' && (
          <div className="drop-indicator" />
        )}
        {dropIndicator?.targetId === nodeId && dropIndicator?.position === 'inside' && (
          <div className="drop-indicator-inside" />
        )}

        <span
          className={`tree-toggle ${(!canHaveChildren && !isDataTable) || !hasExpandable ? 'invisible' : ''}`}
          onClick={e => { e.stopPropagation(); onToggleCollapse(nodeId) }}
        >
          {isCollapsed ? '▶' : '▼'}
        </span>
        <span className="tree-tag">{node.component}</span>
        <span className="tree-label">{nodeId}</span>
        {isDataTable && <span className="tree-col-count">{colVirtualChildren.length} 列</span>}
      </div>

      {!isCollapsed && (
        <>
          {realChildren.map(child => (
            <TreeNode
              key={child.id}
              nodeId={child.id}
              components={components}
              selectedId={selectedId}
              collapsedIds={collapsedIds}
              depth={depth + 1}
              dropIndicator={dropIndicator}
              onSelect={onSelect}
              onToggleCollapse={onToggleCollapse}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onDragEnd={onDragEnd}
            />
          ))}
          {colVirtualChildren.map((col: any) => (
            <div
              key={col.virtualId}
              className={`tree-row tree-row-col ${col.virtualId === selectedId ? 'tree-row-selected' : ''}`}
              style={{ paddingLeft: ((depth + 1) * 16 + 8) + 'px' }}
              onClick={e => { e.stopPropagation(); onSelect(col.virtualId) }}
            >
              <span className="tree-toggle invisible">▼</span>
              <span className="tree-tag tree-tag-col">{col.cellType}</span>
              <span className="tree-label">{col.key || '(未命名)'}</span>
              <span className="tree-col-label">{col.label}</span>
            </div>
          ))}
        </>
      )}
    </>
  )
}
