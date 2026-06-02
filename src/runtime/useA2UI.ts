import { useRef, useState, useCallback, useEffect } from 'react'
import { MessageProcessor } from '@a2ui/web_core/v0_9'
import { legacyToV09, extractDataModel, extractComponents } from './a2ui-adapter'

interface LegacyMessage {
  beginRendering?: { surfaceId: string; catalogId: string }
  surfaceUpdate?: { surfaceId: string; components: any[] }
  dataModelUpdate?: { surfaceId: string; data: Record<string, any> }
}

export interface A2UIState {
  components: any[]
  dataModel: Record<string, any>
  surfaces: any[]
  processor: MessageProcessor<any> | null
  /** 加载 legacy 格式的 A2UI JSON 数组 */
  loadMessages: (messages: LegacyMessage[]) => void
  /** 直接喂入 v0.9 标准消息 */
  processMessages: (messages: any[]) => void
  /** 更新 dataModel 中某个路径的值 */
  setDataValue: (path: string, value: any) => void
  /** 获取某个路径的值 */
  getDataValue: (path: string) => any
}

export function useA2UI(): A2UIState {
  const processorRef = useRef<MessageProcessor<any> | null>(null)
  const [components, setComponents] = useState<any[]>([])
  const [dataModel, setDataModel] = useState<Record<string, any>>({})
  const [surfaces, setSurfaces] = useState<any[]>([])

  const surfacesRef = useRef<any[]>([])

  const refreshState = useCallback(() => {
    setSurfaces([...surfacesRef.current])
    if (surfacesRef.current.length > 0) {
      const comps = extractComponents(surfacesRef.current[0])
      if (comps.length > 0) setComponents(comps)
      const dm = extractDataModel(surfacesRef.current[0])
      if (Object.keys(dm).length > 0) setDataModel(dm)
    }
  }, [])

  const ensureProcessor = useCallback(() => {
    if (!processorRef.current) {
      processorRef.current = new MessageProcessor([])
      surfacesRef.current = []
      processorRef.current.model.onSurfaceCreated.subscribe((s: any) => {
        surfacesRef.current.push(s)
        refreshState()
      })
      processorRef.current.model.onSurfaceDeleted.subscribe((id: any) => {
        surfacesRef.current = surfacesRef.current.filter(s => (s as any).surfaceId !== id)
        refreshState()
      })
    }
    return processorRef.current
  }, [refreshState])

  const loadMessages = useCallback((legacyMessages: LegacyMessage[]) => {
    const p = ensureProcessor()
    const v09 = legacyToV09(legacyMessages, { sendDataModel: true })
    p.processMessages(v09 as any)
    // Force refresh in case data was processed synchronously
    setTimeout(() => refreshState(), 0)
  }, [ensureProcessor, refreshState])

  const processMessages = useCallback((messages: any[]) => {
    const p = ensureProcessor()
    p.processMessages(messages as any)
    setTimeout(() => refreshState(), 0)
  }, [ensureProcessor, refreshState])

  const setDataValue = useCallback((path: string, value: any) => {
    setDataModel(prev => {
      const clean = path.replace(/^\/(data|ui|errors)\//, '')
      const parts = clean.split(/[\/.]/)
      const next = { ...prev }
      let cur: any = next
      for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in cur)) cur[parts[i]] = {}
        cur[parts[i]] = { ...cur[parts[i]] }
        cur = cur[parts[i]]
      }
      cur[parts[parts.length - 1]] = value
      return next
    })
  }, [])

  const getDataValue = useCallback((path: string): any => {
    const clean = path.replace(/^\/(data|ui|errors)\//, '')
    const parts = clean.split(/[\/.]/)
    let cur: any = dataModel
    for (const p of parts) {
      if (cur === null || cur === undefined) return undefined
      cur = cur[p]
    }
    return cur
  }, [dataModel])

  // Cleanup
  useEffect(() => {
    return () => {
      processorRef.current = null
    }
  }, [])

  return {
    components,
    dataModel,
    surfaces,
    processor: processorRef.current,
    loadMessages,
    processMessages,
    setDataValue,
    getDataValue,
  }
}
