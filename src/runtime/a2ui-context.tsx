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
import { toV09, extractComponents, extractDataModel } from './a2ui-adapter'
import type { ReactComponentImplementation } from '@a2ui/react/v0_9'

// ===== Context 类型定义 =====

interface A2UIContextValue {
  processor: MessageProcessor<ReactComponentImplementation>
  /** 当前活动的 surface（A2uiSurface 渲染的目标） */
  surface: SurfaceModel<ReactComponentImplementation> | null
  /** 加载任何格式的 A2UI JSON */
  load: (messages: any[]) => void
  /** 获取简化格式的组件列表（调试用） */
  getComponents: () => any[]
  /** 获取当前 dataModel 的快照 */
  getDataModel: () => Record<string, any>
  /** 订阅 dataModel 变化（返回 unsubscribe） */
  subscribeDataModel: (callback: () => void) => () => void
  /** 设置 dataModel 值 */
  setDataValue: (path: string, value: any) => void
  /** 订阅 surface 上的 action 事件（按钮点击等） */
  onAction: (handler: (action: any) => void) => () => void
  /** 版本号（dataModel 变更时递增，用于触发重渲染） */
  version: number
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
  // 使用 ref 存储 surface，确保在 MessageProcessor 回调中同步可用
  const surfaceRef = useRef<SurfaceModel<ReactComponentImplementation> | null>(null)
  const dmSubRef = useRef<{ unsubscribe: () => void } | null>(null)

  /**
   * MessageProcessor 创建一次（依赖 catalog 不变）
   * 在 onSurfaceCreated 回调中建立 dataModel 订阅，驱动 React 重渲染
   */
  const processor = useMemo(() => {
    const p = new MessageProcessor<ReactComponentImplementation>([catalog])

    // surface 创建 → 建立 dataModel 订阅链
    p.model.onSurfaceCreated.subscribe((s: SurfaceModel<ReactComponentImplementation>) => {
      surfaceRef.current = s
      dmSubRef.current?.unsubscribe()
      // 订阅根路径变化 → 触发 version 递增 → React 重渲染
      dmSubRef.current = s.dataModel.subscribe('/', () => setVersion(v => v + 1))
      setVersion(v => v + 1)
    })

    // surface 销毁 → 清理订阅
    p.model.onSurfaceDeleted.subscribe(() => {
      dmSubRef.current?.unsubscribe()
      surfaceRef.current = null
      setVersion(v => v + 1)
    })

    return p
  }, [catalog])

  /**
   * 加载 A2UI 消息（自动检测格式：简化 / v0.9 / v0.8）
   *
   * 关键：加载前先删除同名 surface，避免 "Surface X already exists" 错误
   * （React Strict Mode 会双次执行 effect，也会触发此问题）
   */
  const load = useCallback((messages: any[]) => {
    const v09 = toV09(messages, { catalogId: catalog.id })

    // 删除同名 surface（处理 Strict Mode 和页面重新生成）
    for (const msg of v09) {
      if ('createSurface' in msg && msg.createSurface) {
        const sid = msg.createSurface.surfaceId
        if (processor.model.getSurface(sid)) {
          processor.processMessages([{ deleteSurface: { surfaceId: sid } } as any])
        }
      }
    }

    processor.processMessages(v09)
    setVersion(v => v + 1)
  }, [processor, catalog.id])

  // 辅助方法
  const getComponents = useCallback(() => {
    const s = surfaceRef.current
    return s ? extractComponents(s) : []
  }, [])

  const getDataModel = useCallback(() => {
    const s = surfaceRef.current
    return s ? extractDataModel(s) : {}
  }, [])

  const subscribeDataModel = useCallback((callback: () => void) => {
    const s = surfaceRef.current
    if (!s) return () => {}
    const sub = s.dataModel.subscribe('/', callback)
    return () => sub.unsubscribe()
  }, [])

  const setDataValue = useCallback((path: string, value: any) => {
    surfaceRef.current?.dataModel.set(path, value)
  }, [])

  const onAction = useCallback((handler: (action: any) => void) => {
    const s = surfaceRef.current
    if (!s) return () => {}
    const sub = s.onAction.subscribe(handler)
    return () => sub.unsubscribe()
  }, [])

  const value: A2UIContextValue = {
    processor,
    surface: surfaceRef.current,  // ref 同步更新，避免闭包过期
    load,
    getComponents,
    getDataModel,
    subscribeDataModel,
    setDataValue,
    onAction,
    version,
  }

  return React.createElement(A2UIContext.Provider, { value }, children)
}
