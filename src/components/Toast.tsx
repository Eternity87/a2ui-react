import { useEffect, useRef, useState } from 'react'

interface ToastProps {
  toast: { msg: string; type: string } | null
  onDone: () => void
  duration?: number
}

interface ToastItem {
  id: number
  msg: string
  type: string
  leaving: boolean
}

const typeClass: Record<string, string> = {
  success: 'bg-green-500',
  error: 'bg-red-500',
  warning: 'bg-yellow-500',
  info: 'bg-blue-500',
}

/**
 * Toast 通知组件，支持队列堆叠和进出动画
 *
 * 连续触发多条 toast 时自动堆叠显示，每条独立计时。
 * 离开动画结束后自动从队列移除，队列为空时回调 onDone。
 */
export function Toast({ toast, onDone, duration = 3000 }: ToastProps) {
  const [queue, setQueue] = useState<ToastItem[]>([])
  const idRef = useRef(0)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  // 新的 toast 到达 → 追加到队列
  useEffect(() => {
    if (!toast) return
    const id = ++idRef.current
    const item: ToastItem = { id, msg: toast.msg, type: toast.type, leaving: false }
    setQueue(prev => [...prev, item])

    const dismissTimer = setTimeout(() => {
      // 启动离开动画
      setQueue(prev => prev.map(t => t.id === id ? { ...t, leaving: true } : t))
      // 动画结束后移除
      setTimeout(() => {
        setQueue(prev => {
          const next = prev.filter(t => t.id !== id)
          if (next.length === 0) onDoneRef.current()
          return next
        })
      }, 300)
    }, duration)

    return () => clearTimeout(dismissTimer)
  }, [toast])

  if (queue.length === 0) return null

  return (
    <div className="fixed top-5 right-5 z-50 flex flex-col gap-2 pointer-events-none">
      {queue.map(item => (
        <div
          key={item.id}
          className={`px-4 py-2 rounded text-white shadow-lg pointer-events-auto
            transition-all duration-300 ease-in-out
            ${item.leaving ? 'opacity-0 translate-x-4 scale-95' : 'opacity-100 translate-x-0 scale-100'}
            ${typeClass[item.type] ?? 'bg-blue-500'}`}
        >
          {item.msg}
        </div>
      ))}
    </div>
  )
}
