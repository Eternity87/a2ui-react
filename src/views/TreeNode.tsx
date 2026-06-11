/**
 * TreeNode.tsx — 递归组件树节点
 *
 * 【在调试器中的角色】
 * DOM 树面板的每个节点。通过组件自引用实现递归渲染，
 * 支持展开/折叠、选中高亮、拖拽定位指示器。
 *
 * 【DataTable 列的虚拟节点】
 * DataTable 的 columns 不是独立的 A2UI 组件，但调试器需要编辑它们。
 * 所以为每列生成虚拟节点（virtualId: `tableId$col$0`），
 * 在树中展示为 `.tree-row-col` 样式，右栏编辑其属性。
 */

import { canHaveChildren } from '@/runtime/a2ui-utils'
import type { DragEvent } from 'react'

interface TreeNodeProps {
  nodeId: string
  compMap: Map<string, any>
  selectedId: string | null
  collapsedIds: Set<string>
  depth: number
  dropIndicator: { targetId: string; position: 'before' | 'after' | 'inside' | 'addColumn' } | null
  onSelect: (id: string) => void
  onToggleCollapse: (id: string) => void
  onDragStart: (e: DragEvent, id: string) => void
  onDragOver: (e: DragEvent, id: string) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent, id: string) => void
  onDragEnd: () => void
  onColumnDragStart?: (e: DragEvent, tableId: string, colIndex: number) => void
  onColumnDragOver?: (e: DragEvent, virtualId: string) => void
  onColumnDrop?: (e: DragEvent, virtualId: string) => void
}

export function TreeNode({
  nodeId, compMap, selectedId, collapsedIds, depth, dropIndicator,
  onSelect, onToggleCollapse, onDragStart, onDragOver, onDragLeave, onDrop, onDragEnd,
  onColumnDragStart, onColumnDragOver, onColumnDrop,
}: TreeNodeProps) {
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

  const isContainer = canHaveChildren(node.component)
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
        {dropIndicator?.targetId === nodeId && (
          <>
            {dropIndicator.position === 'before' && <div className="drop-line drop-line-before" />}
            {dropIndicator.position === 'after' && <div className="drop-line drop-line-after" />}
            {dropIndicator.position === 'inside' && <div className="drop-highlight" />}
            {dropIndicator.position === 'addColumn' && (
              <div className="drop-add-column">
                <div className="drop-add-column-bar" />
                <span className="drop-add-column-text">插入列</span>
              </div>
            )}
          </>
        )}

        <span
          className={`tree-toggle ${(!isContainer && !isDataTable) || !hasExpandable ? 'invisible' : ''}`}
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
              compMap={compMap}
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
              onColumnDragStart={onColumnDragStart}
              onColumnDragOver={onColumnDragOver}
              onColumnDrop={onColumnDrop}
            />
          ))}
          {colVirtualChildren.map((col: any) => (
            <div
              key={col.virtualId}
              className={`tree-row tree-row-col ${col.virtualId === selectedId ? 'tree-row-selected' : ''}`}
              style={{ paddingLeft: ((depth + 1) * 16 + 8) + 'px' }}
              draggable
              onClick={e => { e.stopPropagation(); onSelect(col.virtualId) }}
              onDragStart={e => onColumnDragStart?.(e, nodeId, col.colIndex)}
              onDragEnd={onDragEnd}
              onDragOver={e => { e.preventDefault(); onColumnDragOver?.(e, col.virtualId) }}
              onDragLeave={onDragLeave}
              onDrop={e => { e.preventDefault(); e.stopPropagation(); onColumnDrop?.(e, col.virtualId) }}
            >
              {dropIndicator?.targetId === col.virtualId && (
                <>
                  {dropIndicator.position === 'before' && <div className="drop-line drop-line-before" />}
                  {dropIndicator.position === 'after' && <div className="drop-line drop-line-after" />}
                </>
              )}
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
