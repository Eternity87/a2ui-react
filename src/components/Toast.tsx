import { useEffect, useRef, useState } from 'react'

interface ToastProps {
  toast: { msg: string; type: string } | null
  onDone: () => void
  duration?: number
}

const typeClass: Record<string, string> = {
  success: 'bg-green-500',
  error: 'bg-red-500',
  warning: 'bg-yellow-500',
  info: 'bg-blue-500',
}

export function Toast({ toast, onDone, duration = 3000 }: ToastProps) {
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const [trigger, setTrigger] = useState(0)

  useEffect(() => {
    if (toast) setTrigger(t => t + 1)
  }, [toast])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => onDoneRef.current(), duration)
    return () => clearTimeout(t)
  }, [toast, duration, trigger])

  if (!toast) return null

  return (
    <div className={`fixed top-5 right-5 px-4 py-2 rounded text-white z-50 ${typeClass[toast.type] ?? 'bg-blue-500'}`}>
      {toast.msg}
    </div>
  )
}
