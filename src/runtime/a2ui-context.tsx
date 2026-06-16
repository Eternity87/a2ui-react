/**
 * a2ui-context.tsx — A2UI React 上下文与 Provider
 *
 * 【在架构中的角色】
 * 预览模式的核心入口。封装 Google 官方 @a2ui/web_core 的 MessageProcessor 和
 * SurfaceModel，提供 React 上下文供组件树使用。
 *
 * 【数据流】
 *   1. App 加载 JSON → load(data.a2ui) → adapter.toV09() → MessageProcessor.processMessages()
 *   2. MessageProcessor 创建 SurfaceModel（包含 componentsModel + dataModel）
 *   3. A2uiSurface 从 SurfaceModel 渲染组件树
 *   4. 用户交互 → dataContext.set() / dispatchAction() → dataModel 变更 / action 事件
 *   5. 组件通过 useSyncExternalStore 订阅 dataModel 变更 → 自动重渲染
 *
 * 【两种模式共用】
 * 调试器和预览模式现在都使用官方管线：
 * - 数据模型：DataModel (Signals)
 * - 组件渲染：A2uiSurface + binderless
 * - 反应引擎：ReactionEngine
 */

import React, { createContext, useContext, useRef, useState, useCallback, useMemo } from 'react'
import { MessageProcessor, type SurfaceModel } from '@a2ui/web_core/v0_9'
import type { Catalog } from '@a2ui/web_core/v0_9'
import { toV09, extractComponents, extractDataModel, rewriteSurfaceId } from './a2ui-adapter'
import type { ReactComponentImplementation } from '@a2ui/react/v0_9'

// ===== Context 类型定义 =====

interface A2UIContextValue {
  processor: MessageProcessor<ReactComponentImplementation>
  /** 所有已加载的 surface（按 surfaceId 索引） */
  surfaces: Record<string, SurfaceModel<ReactComponentImplementation>>
  /** 获取指定 surface */
  getSurface: (id: string) => SurfaceModel<ReactComponentImplementation> | null
  /** 当前活动的 surfaceId */
  currentSurfaceId: string
  /** 切换当前 surface */
  setCurrentSurfaceId: (id: string) => void
  /** 当前活动的 surface（向后兼容） */
  surface: SurfaceModel<ReactComponentImplementation> | null
  /** 加载 A2UI JSON（可指定 pageId 以分配唯一 surfaceId） */
  load: (messages: any[], options?: { pageId?: string }) => void
  /** 获取简化格式的组件列表（调试用） */
  getComponents: () => any[]
  /** 获取当前 dataModel 的快照 */
  getDataModel: () => Record<string, any>
  /** 订阅 dataModel 变化（返回 unsubscribe） */
  subscribeDataModel: (callback: () => void) => () => void
  /** 设置 dataModel 值 */
  setDataValue: (path: string, value: any) => void
  /** 销毁指定 surface（用于 Dialog 关闭时清理子 surface） */
  destroySurface: (id: string) => void
  /** 订阅 surface 上的 action 事件（按钮点击等） */
  onAction: (handler: (action: any) => void) => () => void
  /** 版本号（dataModel 变更时递增，用于触发重渲染） */
  version: number
  /** 弹出 toast 提示（默认 console.error，子组件可通过 setToastHandler 注册自定义实现） */
  toast: (msg: string, type?: string) => void
  /** 注册自定义 toast 实现（Debugger/PreviewInner 在 mount 时调用） */
  setToastHandler: (handler: (msg: string, type?: string) => void) => void
}

const A2UIContext = createContext<A2UIContextValue | null>(null)

/** 使用 A2UI 上下文（Provider 不存在时抛出异常） */
export function useA2UI() {
  const ctx = useContext(A2UIContext)
  if (!ctx) throw new Error('useA2UI must be used within A2UIProvider')
  return ctx
}

/** 可选的上下文访问（不抛异常，用于可选场景） */
export function useA2UIOptional() {
  return useContext(A2UIContext)
}

// ===== Provider =====

interface A2UIProviderProps {
  catalog: Catalog<ReactComponentImplementation>
  children: React.ReactNode
}

/**
 * A2UIProvider — 预览模式的根组件
 *
 * 职责：
 * 1. 创建 MessageProcessor 并注册我们的组件 Catalog
 * 2. 监听 surface 的创建/销毁生命周期
 * 3. 在 dataModel 变更时自动通知 React 重渲染
 * 4. 通过 React Context 向下暴露所有 A2UI 操作
 */
export function A2UIProvider({ catalog, children }: A2UIProviderProps) {
  const [version, setVersion] = useState(0)
  const [currentSurfaceId, setCurrentSurfaceId] = useState('main')
  const surfacesRef = useRef<Map<string, SurfaceModel<ReactComponentImplementation>>>(new Map())
  const [surfaces, setSurfaces] = useState<Record<string, SurfaceModel<ReactComponentImplementation>>>({})
  const dmSubsRef = useRef<Map<string, { unsubscribe: () => void }>>(new Map())
  const toastHandlerRef = useRef<(msg: string, type?: string) => void>(console.error)

  const toast = useCallback((msg: string, type?: string) => {
    toastHandlerRef.current(msg, type)
  }, [])

  const setToastHandler = useCallback((handler: (msg: string, type?: string) => void) => {
    toastHandlerRef.current = handler
  }, [])

  /**
   * MessageProcessor 创建一次（依赖 catalog 不变）
   * 在 onSurfaceCreated 回调中建立 dataModel 订阅，驱动 React 重渲染
   */
  const processor = useMemo(() => {
    const p = new MessageProcessor<ReactComponentImplementation>([catalog])

    // surface 创建 → 加入 surfaces map + 建立 dataModel 订阅
    p.model.onSurfaceCreated.subscribe((s: SurfaceModel<ReactComponentImplementation>) => {
      surfacesRef.current.set(s.id, s)
      setSurfaces(prev => ({ ...prev, [s.id]: s }))
      // 清理旧订阅
      dmSubsRef.current.get(s.id)?.unsubscribe()
      // 订阅该 surface 根路径变化 → 触发 version 递增 → React 重渲染
      dmSubsRef.current.set(s.id, s.dataModel.subscribe('/', () => setVersion(v => v + 1)))
      setVersion(v => v + 1)
    })

    // surface 销毁 → 从 map 移除 + 清理订阅
    p.model.onSurfaceDeleted.subscribe((sid: string) => {
      dmSubsRef.current.get(sid)?.unsubscribe()
      dmSubsRef.current.delete(sid)
      surfacesRef.current.delete(sid)
      setSurfaces(prev => {
        const next = { ...prev }
        delete next[sid]
        return next
      })
      setVersion(v => v + 1)
    })

    return p
  }, [catalog])

  /**
   * 加载 A2UI 消息（自动检测格式：简化 / v0.9 / v0.8）
   *
   * options.pageId: 多页面场景下的页面 ID。如果指定，会将消息中的 surfaceId 从
   * "main" 替换为 pageId，确保每个页面拥有独立的 Surface。
   *
   * 关键：加载前先删除同名 surface，避免 "Surface X already exists" 错误
   */
  const load = useCallback((messages: any[], options?: { pageId?: string }) => {
    const pageId = options?.pageId ?? 'main'
    const converted = rewriteSurfaceId(messages, pageId)
    const v09 = toV09(converted, { catalogId: catalog.id })

    // 删除同名 surface（处理 Strict Mode 和页面重新生成）
    for (const msg of v09) {
      if ('createSurface' in msg && msg.createSurface) {
        const sid = msg.createSurface.surfaceId
        if (processor.model.getSurface(sid)) {
          processor.processMessages([{ version: 'v0.9', deleteSurface: { surfaceId: sid } } as any])
        }
      }
    }

    processor.processMessages(v09 as any)
    setVersion(v => v + 1)
  }, [processor, catalog.id])

  // 辅助方法 — 均操作当前 surface
  const getSurface = useCallback((id: string) => {
    return surfacesRef.current.get(id) ?? null
  }, [])

  const getComponents = useCallback(() => {
    const s = surfacesRef.current.get(currentSurfaceId)
    return s ? extractComponents(s) : []
  }, [currentSurfaceId])

  const getDataModel = useCallback(() => {
    const s = surfacesRef.current.get(currentSurfaceId)
    return s ? extractDataModel(s) : {}
  }, [currentSurfaceId])

  const subscribeDataModel = useCallback((callback: () => void) => {
    const s = surfacesRef.current.get(currentSurfaceId)
    if (!s) return () => {}
    const sub = s.dataModel.subscribe('/', callback)
    return () => sub.unsubscribe()
  }, [currentSurfaceId])

  const setDataValue = useCallback((path: string, value: any) => {
    surfacesRef.current.get(currentSurfaceId)?.dataModel.set(path, value)
  }, [currentSurfaceId])

  const destroySurface = useCallback((id: string) => {
    const s = processor.model.getSurface(id)
    if (s) {
      processor.processMessages([{ version: 'v0.9', deleteSurface: { surfaceId: id } } as any])
      setVersion(v => v + 1)
    }
  }, [processor])

  const onAction = useCallback((handler: (action: any) => void) => {
    const s = surfacesRef.current.get(currentSurfaceId)
    if (!s) return () => {}
    const sub = s.onAction.subscribe(handler)
    return () => sub.unsubscribe()
  }, [currentSurfaceId])

  const value = useMemo<A2UIContextValue>(() => ({
    processor,
    surfaces,
    getSurface,
    currentSurfaceId,
    setCurrentSurfaceId,
    surface: surfacesRef.current.get(currentSurfaceId) ?? null,
    load,
    getComponents,
    getDataModel,
    subscribeDataModel,
    setDataValue,
    destroySurface,
    onAction,
    version,
    toast,
    setToastHandler,
  }), [
    processor, surfaces, getSurface, currentSurfaceId, setCurrentSurfaceId,
    load, getComponents, getDataModel, subscribeDataModel,
    setDataValue, destroySurface, onAction, version,
    toast, setToastHandler,
  ])

  return React.createElement(A2UIContext.Provider, { value }, children)
}
