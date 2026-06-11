/**
 * PageSelector.tsx — 页面标签栏
 *
 * 水平标签栏，显示所有页面 ID，支持点击切换和当前页高亮。
 * 在调试器和预览模式中复用。
 */

import { Button } from '@/components/ui/button'

interface PageSelectorProps {
  pageIds: string[]
  currentPageId: string | null
  onSelect: (pageId: string) => void
}

export function PageSelector({ pageIds, currentPageId, onSelect }: PageSelectorProps) {
  if (pageIds.length <= 1) return null

  return (
    <div className="flex gap-1 p-1 bg-gray-100 rounded-md">
      {pageIds.map((id) => (
        <button
          key={id}
          className={`px-3 py-1 text-xs rounded transition-colors ${
            id === currentPageId
              ? 'bg-white text-blue-600 shadow-sm font-medium'
              : 'text-gray-500 hover:text-gray-700 hover:bg-white/50'
          }`}
          onClick={() => onSelect(id)}
        >
          {id.replace(/^page_/, '')}
        </button>
      ))}
    </div>
  )
}
