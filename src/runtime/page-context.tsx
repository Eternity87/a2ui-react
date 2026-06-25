/**
 * page-context.tsx — 多页面路由上下文
 *
 * 管理页面生命周期、导航、URL hash 同步。
 * 与 A2UIProvider 配合：A2UIProvider 管理 surface，PageProvider 管理页面切换。
 *
 * 导航流程:
 *   Reaction navigate action
 *     → services.navigate(pageId, params)
 *       → useSharedStore.setNavParams(params)
 *       → setCurrentPageId(pageId)
 *       → A2UIProvider.setCurrentSurfaceId(pageId)
 *       → update URL hash
 *       → 新页的 ReactionEngine 在 useEffect 中创建
 */

import React, {
  createContext, useContext, useState, useCallback, useRef, useEffect,
} from 'react'
import { useA2UI } from './a2ui-context'
import { logger } from '@/lib/logger'
import { normalizeToPages, rewriteSurfaceId, type NormalizedPages } from './a2ui-adapter'
import { useSharedStore } from './shared-store'
import { registerChildPage, unregisterAllChildPages } from './page-state'
export { registerChildPage, unregisterChildPage, unregisterAllChildPages, getChildPage } from './page-state'

// ===== 类型 =====

interface PageContextValue {
  pages: NormalizedPages['pages']
  shared: NormalizedPages['shared']
  currentPageId: string | null
  pageIds: string[]
  navigateTo: (pageId: string, params?: Record<string, any>) => void
  goBack: () => void
  canGoBack: boolean
}

const PageContext = createContext<PageContextValue | null>(null)

export function usePageContext() {
  const ctx = useContext(PageContext)
  if (!ctx) throw new Error('usePageContext must be used within PageProvider')
  return ctx
}

// ===== Provider =====

interface PageProviderProps {
  /** 归一化后的多页面数据 */
  data: NormalizedPages
  children: React.ReactNode
}

export function PageProvider({ data, children }: PageProviderProps) {
  const a2ui = useA2UI()
  const sharedStore = useSharedStore()
  const pageIds = Object.keys(data.pages)
  const homePageId = pageIds[0] ?? 'main'

  const [currentPageId, setCurrentPageId] = useState<string | null>(null)
  const historyRef = useRef<string[]>([])
  const loadedRef = useRef<Set<string>>(new Set())
  const hydratedRef = useRef(false)
  const prevDataRef = useRef<NormalizedPages | null>(null)
  const navigatingRef = useRef(false)

  useEffect(() => {
    const isNewData = prevDataRef.current !== data
    prevDataRef.current = data

    if (isNewData) {
      loadedRef.current = new Set()
      hydratedRef.current = false
    }

    if (!hydratedRef.current && data.shared?.dataModel) {
      sharedStore.hydrate(data.shared.dataModel)
      hydratedRef.current = true
    }

    const firstPage = homePageId
    if (!loadedRef.current.has(firstPage)) {
      const page = data.pages[firstPage]
      if (page) {
        a2ui.load(page.a2ui, { pageId: firstPage })
        loadedRef.current.add(firstPage)
      }
    }
    for (const [pageId, page] of Object.entries(data.pages)) {
      if (page.children) {
        for (const [childName, childDef] of Object.entries(page.children)) {
          registerChildPage(pageId, childName, childDef)
        }
      }
    }

    a2ui.setCurrentSurfaceId(firstPage)
    setCurrentPageId(firstPage)
    historyRef.current = [firstPage]

    return () => {
      // 批量清理注册的子页面。使用 unregisterAllChildPages 确保异常中断也不残留。
      for (const pageId of Object.keys(data.pages)) {
        unregisterAllChildPages(pageId)
      }
    }
  }, [data, homePageId, a2ui, sharedStore])

  /** 导航到目标页面 */
  const navigateTo = useCallback((pageId: string, params?: Record<string, any>) => {
    if (navigatingRef.current) return
    if (!data.pages[pageId]) {
      logger.warn(`[PageContext] Unknown page: ${pageId}`)
      return
    }

    navigatingRef.current = true

    try {
      // 写入导航参数到共享 store
      if (params && Object.keys(params).length > 0) {
        sharedStore.setNavParams(params)
      }

      // 懒加载：首次访问时加载该页的 surface
      if (!loadedRef.current.has(pageId)) {
        const page = data.pages[pageId]
        a2ui.load(page.a2ui, { pageId })
        loadedRef.current.add(pageId)
      }

      // 切换 surface
      a2ui.setCurrentSurfaceId(pageId)
      setCurrentPageId(pageId)

      // 记录导航历史
      historyRef.current = [...historyRef.current, pageId]

      // URL hash 同步
      updateHash(pageId, params)
    } finally {
      navigatingRef.current = false
    }
  }, [data.pages, sharedStore])

  /** 返回上一页 */
  const goBack = useCallback(() => {
    const hist = historyRef.current
    if (hist.length < 2) return

    const newHist = [...hist]
    newHist.pop() // 移除当前页
    const prevPageId = newHist[newHist.length - 1]

    a2ui.setCurrentSurfaceId(prevPageId)
    setCurrentPageId(prevPageId)
    historyRef.current = newHist

    sharedStore.clearNavParams()
    updateHash(prevPageId)
  }, [a2ui, sharedStore])

  /** 监听浏览器前进/后退 */
  useEffect(() => {
    const handler = () => {
      const info = parseHash()
      if (info.pageId && data.pages[info.pageId]) {
        if (!loadedRef.current.has(info.pageId)) {
          a2ui.load(data.pages[info.pageId].a2ui, { pageId: info.pageId })
          loadedRef.current.add(info.pageId)
        }
        a2ui.setCurrentSurfaceId(info.pageId)
        setCurrentPageId(info.pageId)
        if (info.params) sharedStore.setNavParams(info.params)
      }
    }
    window.addEventListener('popstate', handler)
    return () => window.removeEventListener('popstate', handler)
  }, [data.pages, sharedStore])

  const value: PageContextValue = {
    pages: data.pages,
    shared: data.shared,
    currentPageId,
    pageIds,
    navigateTo,
    goBack,
    canGoBack: historyRef.current.length > 1,
  }

  return React.createElement(PageContext.Provider, { value }, children)
}

// ===== URL hash 工具 =====

function updateHash(pageId: string, params?: Record<string, any>) {
  const query = params ? new URLSearchParams(params).toString() : ''
  const hash = query ? `#/${pageId}?${query}` : `#/${pageId}`
  window.history.pushState({ pageId }, '', hash)
}

function parseHash(): { pageId?: string; params?: Record<string, string> } {
  const hash = window.location.hash.slice(1) // remove #
  if (!hash.startsWith('/')) return {}
  const [path, queryStr] = hash.split('?')
  const pageId = path.slice(1) // remove leading /
  const params: Record<string, string> = {}
  if (queryStr) {
    for (const [k, v] of new URLSearchParams(queryStr).entries()) {
      params[k] = v
    }
  }
  return { pageId, params }
}
