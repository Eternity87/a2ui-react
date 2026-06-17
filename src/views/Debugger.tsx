/**
 * Debugger.tsx — 可视化页面调试器
 *
 * 【布局】三栏结构
 * - 左侧：组件面板（可拖拽） + DOM 树（TreeNode 递归渲染）
 * - 中间：实时渲染预览（A2uiSurface — 官方渲染管线）
 * - 右侧：属性配置面板（选中组件/列时显示）
 *
 * 【双状态设计】
 * - components[] React state：调试器编辑的"源"，即时响应拖拽/属性修改
 * - SurfaceModel（官方）：渲染目标，通过 syncToSurface() 在编辑后延迟同步
 *
 * 【数据流】
 * JSON 加载 → a2ui.load() → SurfaceModel 创建
 *              ↓
 *         components[] ← 从 JSON 解析（调试器自有，用于树展示和编辑）
 *              ↓ 用户编辑
 *         syncToSurface() debounce 150ms → updateComponents 消息 → A2uiSurface 重渲染
 *              ↓ Reaction
 *         surface.dataModel ← ReactionEngine.setValues/apiRequest
 *              ↓
 *         createA2UIComponent 内 useSyncExternalStore → 组件自动重渲染
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Toast } from '@/components/Toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { componentCatalog, type ComponentDef } from '@/catalogs/component-catalog'
import { useA2UI } from '@/runtime/a2ui-context'
import { ReactionEngine } from '@/runtime/reaction-engine'
import { PipeEngine } from '@/runtime/pipe-engine'
import { createMockApiExecutor } from '@/mock/api'
import { ensureRootComponent, extractComponents, extractDataModel, extractDataFromMessages, dataModelToV09Messages, normalizeToPages, type PageDef } from '@/runtime/a2ui-adapter'
import { canHaveChildren } from '@/runtime/a2ui-utils'
import { useSharedStore } from '@/runtime/shared-store'
import { registerChildPage } from '@/runtime/page-context'
import { TreeNode } from '@/views/TreeNode'
import { PageSelector } from '@/views/PageSelector'
import { A2uiSurface } from '@a2ui/react/v0_9'
import demoDefault from '@/demo5.json'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { json } from '@codemirror/lang-json'
import { oneDark } from '@codemirror/theme-one-dark'
import { javascript } from '@codemirror/lang-javascript'
import { basicSetup } from 'codemirror'
import { reactionToJS } from '@/runtime/reaction-to-js'
import { executeScript, validateScript } from '@/runtime/script-engine'
import { MockPushSimulator } from '@/mock/push-simulator'
import { logger } from '@/lib/logger'

// ===== 工具 =====

/** v0.8 组件类型名 → v0.9 映射 */
const V08_TYPE_MAP: Record<string, string> = {
  Text: 'Text', Row: 'Row', Column: 'Row', Card: 'Card',
  Button: 'Button', TextField: 'TextField', Select: 'Select',
  DataTable: 'DataTable', Modal: 'Dialog',
}

/** 将 v0.8 组件格式转为 v0.9 平级格式 */
function normalizeV08Components(comps: any[]): any[] {
  return comps.map(c => {
    if (typeof c.component !== 'object' || !c.component) return c // 非 v0.8，直接返回
    const [typeName, v08Props] = Object.entries(c.component)[0] as [string, any]
    const v09Type = V08_TYPE_MAP[typeName]
    if (!v09Type) { logger.warn(`[loadJson] Unknown v0.8 type: ${typeName}`); return c }
    const props: Record<string, any> = {}
    for (const [key, value] of Object.entries(v08Props ?? {})) {
      if (value === undefined || value === null) continue
      if (typeof value === 'object' && value !== null) {
        if ('literalString' in value) props[key] = value.literalString
        else if ('literalNumber' in value) props[key] = value.literalNumber
        else if ('literalBoolean' in value) props[key] = value.literalBoolean
        else if ('path' in value) props[key] = { path: value.path }
        else if ('name' in value && !('event' in value) && !('surfaceId' in value)) {
          // v0.8 action: { name, context: [{ key, value }] }
          const ctx: Record<string, any> = {}
          const v8action = value as { name: string; context?: { key: string; value: any }[] }
          if (Array.isArray(v8action.context)) {
            for (const item of v8action.context) {
              if (item.key) ctx[item.key] = typeof item.value === 'object' && 'literalString' in item.value
                ? item.value.literalString : item.value
            }
          }
          props[key] = { event: { name: v8action.name, context: ctx } }
        } else if (key === 'child' && 'literalString' in value) {
          // v0.8 child: { literalString: "id" } → v0.9 children: ["id"]
          props.children = [value.literalString]
        } else {
          props[key] = value
        }
      } else {
        props[key] = value
      }
    }
    return { id: c.id, component: v09Type, ...props }
  })
}

/** 收集组件及其所有后代，删除时确定需要移除的 ID 集合 */
function collectDescendants(compMap: Map<string, any>, id: string, set = new Set<string>()): Set<string> {
  set.add(id)
  const comp = compMap.get(id)
  if (comp?.props?.children) comp.props.children.forEach((cid: string) => collectDescendants(compMap, cid, set))
  return set
}

function getParentId(components: any[], childId: string): string | null {
  for (const c of components) {
    if (c.props?.children?.includes(childId)) return c.id
  }
  return null
}

const cellTypeOptions = ['text', 'input', 'number', 'select']

// ===== CodeMirror hook =====
function useCodeMirror(initialDoc: string, opts?: { language?: 'json' | 'javascript'; readOnly?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const docRef = useRef(initialDoc)
  const optsRef = useRef(opts)
  optsRef.current = opts

  // 依赖数组为空是刻意为之：通过 optsRef 读取最新 options，避免 StrictMode 下重建回调。
  // create 仅由 Dialog 的 open/close 生命周期手动调用，不依赖 React 重渲染触发。
  const create = useCallback(() => {
    if (!containerRef.current || viewRef.current) return
    const currentOpts = optsRef.current
    const langExt = currentOpts?.language === 'javascript' ? javascript() : json()
    const extensions: any[] = [
      basicSetup, langExt, oneDark,
      EditorView.lineWrapping,
      EditorView.updateListener.of(u => { if (u.docChanged) docRef.current = u.state.doc.toString() }),
      EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: '13px' } }),
    ]
    if (currentOpts?.readOnly) extensions.push(EditorView.editable.of(false))
    const view = new EditorView({
      state: EditorState.create({
        doc: docRef.current,
        extensions,
      }),
      parent: containerRef.current,
    })
    viewRef.current = view
    return view
  }, [])

  const updateDoc = useCallback((doc: string) => {
    docRef.current = doc
    if (viewRef.current) viewRef.current.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: doc } })
  }, [])

  const destroy = useCallback(() => { viewRef.current?.destroy(); viewRef.current = null }, [])

  return { containerRef, viewRef, create, updateDoc, destroy, getDoc: () => docRef.current }
}

// ===== 多页面编辑状态 =====

interface PageEditorState {
  components: any[]
  reactions: any[]
  /** reactionId → JS 代码（用户编辑后保存的脚本） */
  scripts: Record<string, string>
  initialDataModel: Record<string, any>
  children?: Record<string, any>
}

// ================================================================
//  主组件：Debugger
// ================================================================
export function Debugger() {
  // ---- 官方管线 ----
  const a2ui = useA2UI()

  // ---- 调试器自有状态（按页编辑） ----
  const [pages, setPages] = useState<Record<string, PageEditorState>>({})
  const [currentEditPage, setCurrentEditPage] = useState('main')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [paletteFilter, setPaletteFilter] = useState('')
  const [dragSource, setDragSource] = useState<{ type: 'palette'; componentType: string } | { type: 'tree'; componentId: string } | { type: 'column'; tableId: string; colIndex: number } | null>(null)
  const [dropIndicator, setDropIndicator] = useState<{ targetId: string; position: 'before' | 'after' | 'inside' | 'addColumn' } | null>(null)
  // ref 保存最新值，避免拖拽事件闭包中使用过期 state
  const dragSourceRef = useRef(dragSource)
  dragSourceRef.current = dragSource
  const dropIndicatorRef = useRef(dropIndicator)
  dropIndicatorRef.current = dropIndicator
  const [showJsonDialog, setShowJsonDialog] = useState(false)
  const [showDmDialog, setShowDmDialog] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)
  const [showReactionDialog, setShowReactionDialog] = useState(false)
  const [dialogReactionId, setDialogReactionId] = useState<string | null>(null)
  const [dialogEditMode, setDialogEditMode] = useState(false)
  const [showNewForm, setShowNewForm] = useState(false)
  const [newRxId, setNewRxId] = useState('')
  const [newRxEvent, setNewRxEvent] = useState('click')
  const [newRxField, setNewRxField] = useState('')

  // Reaction → JS 代码预览（read-only CodeMirror）
  const reactionCm = useCodeMirror('', { language: 'javascript', readOnly: !dialogEditMode })

  // 注册 toast 处理器到 A2UI context，供 Dialog 等子组件使用
  useEffect(() => {
    a2ui.setToastHandler((msg, type = 'info') => setToast({ msg, type }))
    return () => a2ui.setToastHandler(console.error)
  }, [a2ui.setToastHandler])

  const categoryGroups = useMemo(() => {
    const labelMap: Record<string, string> = {
      layout: '布局', input: '输入', display: '展示', action: '操作', chart: '图表',
    }
    const order = ['layout', 'input', 'display', 'action', 'chart']
    const entries = Object.entries(componentCatalog)
      .filter(([name]) => name.toLowerCase().includes(paletteFilter.toLowerCase()))
    const map = new Map<string, [string, ComponentDef][]>()
    for (const entry of entries) {
      const cat = entry[1].category
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat)!.push(entry)
    }
    return order
      .filter(cat => map.has(cat))
      .map(cat => ({ category: cat, label: labelMap[cat] ?? cat, items: map.get(cat)! }))
  }, [paletteFilter])

  const idCounter = useRef(1)

  // ---- 引擎与数据 ----
  const engineRef = useRef<ReactionEngine | null>(null)
  const [renderKey, setRenderKey] = useState(0)

  // 当前编辑页的状态（方便访问）
  const currentPage = pages[currentEditPage] ?? { components: [], reactions: [], scripts: {}, initialDataModel: {} }
  const components = currentPage.components
  const reactions = currentPage.reactions
  const scripts = currentPage.scripts

  // 包装 setComponents / setReactions 以操作当前页
  const setComponents = useCallback((updater: any[] | ((prev: any[]) => any[])) => {
    setPages(prev => {
      const cur = prev[currentEditPage] ?? { components: [], reactions: [], scripts: {}, initialDataModel: {} }
      const newComps = typeof updater === 'function' ? updater(cur.components) : updater
      return { ...prev, [currentEditPage]: { ...cur, components: newComps } }
    })
  }, [currentEditPage])

  const setReactions = useCallback((updater: any[] | ((prev: any[]) => any[])) => {
    setPages(prev => {
      const cur = prev[currentEditPage] ?? { components: [], reactions: [], scripts: {}, initialDataModel: {} }
      const newRx = typeof updater === 'function' ? updater(cur.reactions) : updater
      return { ...prev, [currentEditPage]: { ...cur, reactions: newRx } }
    })
  }, [currentEditPage])

  const saveScript = useCallback((reactionId: string, code: string) => {
    setPages(prev => {
      const cur = prev[currentEditPage] ?? { components: [], reactions: [], scripts: {}, initialDataModel: {} }
      return { ...prev, [currentEditPage]: { ...cur, scripts: { ...cur.scripts, [reactionId]: code } } }
    })
  }, [currentEditPage])

  const deleteScript = useCallback((reactionId: string) => {
    setPages(prev => {
      const cur = prev[currentEditPage] ?? { components: [], reactions: [], scripts: {}, initialDataModel: {} }
      const next = { ...cur.scripts }
      delete next[reactionId]
      return { ...prev, [currentEditPage]: { ...cur, scripts: next } }
    })
  }, [currentEditPage])

  const compMap = useMemo(() => {
    const m = new Map<string, any>()
    components.forEach(c => m.set(c.id, c))
    return m
  }, [components])

  // 当前选中组件关联的 reactions
  const componentReactions = useMemo(() => {
    if (!selectedId) return []
    return reactions.filter(r => r.when?.field === selectedId)
  }, [selectedId, reactions])

  // Dialog 中切换 reaction 时更新代码
  useEffect(() => {
    if (!dialogReactionId) { reactionCm.updateDoc(''); setDialogEditMode(false); return }
    // 优先展示用户保存的 script，否则展示自动生成的代码
    const code = scripts[dialogReactionId] ?? (() => {
      const r = reactions.find(r => r.id === dialogReactionId)
      return r ? reactionToJS(r) : ''
    })()
    reactionCm.updateDoc(code)
    setDialogEditMode(false)
  }, [dialogReactionId, reactions, scripts])

  // 编辑模式切换：更新 CodeMirror editable 状态
  const toggleEditMode = useCallback(() => {
    if (!dialogReactionId) return
    if (!dialogEditMode) {
      // 进入编辑模式
      setDialogEditMode(true)
    } else {
      // 保存并退出编辑模式
      const code = reactionCm.getDoc()
      const result = validateScript(code)
      if (!result.valid) {
        setToast({ msg: `脚本语法错误: ${result.error}`, type: 'error' })
        return
      }
      saveScript(dialogReactionId, code)
      setDialogEditMode(false)
      setToast({ msg: '脚本已保存', type: 'success' })
    }
  }, [dialogReactionId, dialogEditMode, reactionCm, saveScript])

  // 打开 reaction dialog 时默认选中当前组件关联的第一个
  function openReactionDialog() {
    const first = componentReactions[0]?.id ?? reactions[0]?.id ?? null
    setDialogReactionId(first)
    setShowReactionDialog(true)
  }

  // ===== 同步：components[] → SurfaceModel =====

  /** 将当前组件状态同步到 SurfaceModel */
  function syncComponents(processor: any, surface: any) {
    const v09Comps = componentsRef.current.map(c => ({
      id: c.id,
      component: c.component,
      ...c.props,
    }))
    const finalComps = ensureRootComponent(v09Comps)
    // 空组件列表时，发送仅含 root 的空树来清空渲染区
    const compsToSend = finalComps.length === 0 && v09Comps.length === 0
      ? [{ id: 'root', component: 'Row', children: [] }]
      : finalComps
    try {
      processor.processMessages([{
        version: 'v0.9',
        updateComponents: { surfaceId: surface.id, components: compsToSend },
      }] as any)
      setRenderKey(k => k + 1)
    } catch (err: any) {
      logger.warn('[Sync] 同步组件失败:', err?.message || err)
    }
  }

  const processorRef = useRef(a2ui?.processor)
  processorRef.current = a2ui?.processor
  const componentsRef = useRef(components)
  componentsRef.current = components
  const editPageRef = useRef(currentEditPage)
  editPageRef.current = currentEditPage

  const syncTimerRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => {
      const processor = processorRef.current
      if (!processor) return
      const pageId = editPageRef.current
      // 使用 processor.model 直接查找，确保与 processMessages 内部使用同一数据源
      const surface = (processor as any).model?.getSurface(pageId) ?? a2ui.getSurface(pageId)
      if (!surface) {
        // surface 不存在（可能在页面重载中）→ 延迟重试
        syncTimerRef.current = setTimeout(() => {
          const retrySurface = (processor as any).model?.getSurface(pageId) ?? a2ui.getSurface(pageId)
          if (!retrySurface) return
          syncComponents(processor, retrySurface)
        }, 300)
        return
      }
      syncComponents(processor, surface)
    }, 150)
    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    }
  }, [components])

  // ===== 加载 JSON（多页面兼容） =====

  const loadJson = useCallback((data: any) => {
    const normalized = normalizeToPages(data)
    const newPages: Record<string, PageEditorState> = {}
    let maxN = 0

    for (const [pageId, page] of Object.entries(normalized.pages)) {
      const su = page.a2ui?.find((m): m is { surfaceUpdate: { surfaceId: string; components: any[] } } => 'surfaceUpdate' in m)
      const rawComps = su ? structuredClone(su.surfaceUpdate.components) as any[] : []
      const comps = normalizeV08Components(rawComps) // v0.8 → v0.9 平级格式
      // 归一化：v0.9 平级 props → legacy 嵌套 props
      for (const c of comps) {
        if (!c.props) {
          const { id, component, ...rest } = c
          c.props = rest
          // 保留 id 和 component，删除已移入 props 的平级属性
          for (const k of Object.keys(rest)) delete c[k]
        }
      }
      // 为 JSON 中缺失的 prop 填入 catalog 默认值
      for (const c of comps) {
        const def = componentCatalog[c.component as string]
        if (def?.props) {
          for (const [key, pd] of Object.entries(def.props)) {
            if (!(key in (c.props ?? {})) && pd.defaultValue !== undefined) {
              if (!c.props) c.props = {}
              c.props[key] = pd.defaultValue
            }
          }
        }
        const m = (c.id as string).match(/(\d+)$/)
        if (m) maxN = Math.max(maxN, parseInt(m[1]))
      }
      newPages[pageId] = {
        components: comps,
        reactions: page.logic?.reactions ? structuredClone(page.logic.reactions) : [],
        scripts: page.logic?.scripts ? structuredClone(page.logic.scripts) : {},
        initialDataModel: structuredClone(extractDataFromMessages(page.a2ui)),
        children: page.children ? structuredClone(page.children) : undefined,
      }
    }

    idCounter.current = maxN + 1
    setPages(newPages)
    setSelectedId(null)
    setCollapsedIds(new Set())

    // 通过官方管线加载每个页面的 surface + 注册内嵌子页面
    for (const [pageId, page] of Object.entries(normalized.pages)) {
      a2ui.load(page.a2ui, { pageId })
      if (page.children) {
        for (const [childName, childDef] of Object.entries(page.children)) {
          registerChildPage(pageId, childName, childDef as PageDef)
        }
      }
    }

    // 设置首页为当前编辑页
    const firstPage = Object.keys(normalized.pages)[0] ?? 'main'
    setCurrentEditPage(firstPage)
    a2ui.setCurrentSurfaceId(firstPage)
    setRenderKey(k => k + 1)
  }, [])

  // ===== 初始化 =====

  useEffect(() => {
    loadJson(demoDefault)
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  // 确保 currentEditPage 始终指向有效页面（防止 pages 与 currentEditPage 更新时序不一致）
  useEffect(() => {
    const pageIds = Object.keys(pages)
    if (pageIds.length > 0 && !pages[currentEditPage]) {
      setCurrentEditPage(pageIds[0])
    }
  }, [pages, currentEditPage])

  // 页面切换时清除选中
  useEffect(() => {
    setSelectedId(null)
  }, [currentEditPage])

  // ===== ReactionEngine（绑定到当前编辑页） =====
  // 注意：必须从 a2ui 解构稳定方法，不能用 a2ui 本身 —— useA2UI() 每次 render 返回新对象引用

  // 用 ref 存储 context 函数引用，避免 effect 因 a2ui.surface 变化而重复触发
  const getSurfaceRef = useRef(a2ui.getSurface)
  getSurfaceRef.current = a2ui.getSurface
  const setCurrentSurfaceIdRef = useRef(a2ui.setCurrentSurfaceId)
  setCurrentSurfaceIdRef.current = a2ui.setCurrentSurfaceId

  // ref 保存最新 scripts，供 ReactionEngine 的 onExecuteReaction 回调和 click 事件使用
  const scriptsRef = useRef(scripts)
  scriptsRef.current = scripts

  // StrictMode 下该 effect 会被双调。boot() 有幂等守卫，cleanup 确保完整清理。
  useEffect(() => {
    const surface = getSurfaceRef.current(currentEditPage)
    if (!surface || reactions.length === 0) {
      engineRef.current?.destroy()
      engineRef.current = null
      return
    }

    engineRef.current?.destroy()
    const engine = new ReactionEngine(surface.dataModel, reactions, {
      apiExecutor: createMockApiExecutor(),
      pipeEngine: new PipeEngine(surface.dataModel.get('/') ?? {}),
      toast: (msg, type = 'info') => setToast({ msg, type }),
      sharedStore: useSharedStore,
      navigate: (pageId, params) => {
        const targetSurface = getSurfaceRef.current(pageId)
        if (targetSurface && params) {
          for (const [k, v] of Object.entries(params)) {
            targetSurface.dataModel.set(`/navParams/${k}`, v)
          }
        }
        setCurrentEditPage(pageId)
        setCurrentSurfaceIdRef.current(pageId)
      },
      // init/change 事件触发时优先检查自定义脚本
      onExecuteReaction: (rid) => {
        const script = scriptsRef.current[rid]
        if (!script || !surface) return false
        const pe = new PipeEngine((surface.dataModel.get('/') ?? {}) as Record<string, any>)
        executeScript(script, {
          dataModel: surface.dataModel,
          pipeEngine: pe,
          apiExecutor: createMockApiExecutor(),
          toast: (msg, type = 'info') => setToast({ msg, type }),
          sharedStore: useSharedStore,
          navigate: (pageId, params) => {
            const ts = getSurfaceRef.current(pageId)
            if (ts && params) {
              for (const [k, v] of Object.entries(params)) {
                ts.dataModel.set(`/navParams/${k}`, v)
              }
            }
            setCurrentEditPage(pageId)
            setCurrentSurfaceIdRef.current(pageId)
          },
          action: null,
        })
        return true
      },
    })
    engine.boot()
    engineRef.current = engine

    // 启动本地 KPI 推送模拟器（生产环境替换为 LiveTransport）
    const pushSim = new MockPushSimulator(a2ui.processor, currentEditPage)
    pushSim.start()

    return () => {
      // try/finally 确保 pushSim 和 engine 都被清理，即使其中一个抛错
      try { pushSim.stop() } finally {
        try { engine.destroy() } finally {
          engineRef.current = null
        }
      }
    }
  }, [currentEditPage, reactions])

  // ===== Action 事件 → ReactionEngine / ScriptEngine =====

  // ref 保存最新值，避免 effect 因 unstable 依赖频繁重建
  const currentEditPageRef2 = useRef(currentEditPage)
  currentEditPageRef2.current = currentEditPage

  useEffect(() => {
    return a2ui.onAction((action: any) => {
      if (action.name === 'a2ui.click' && action.context?.reactionId) {
        const rid = action.context.reactionId as string
        const pageId = currentEditPageRef2.current
        const surface = getSurfaceRef.current(pageId)
        if (action.context.clickData && surface) {
          surface.dataModel.set('/_event', action.context.clickData?.payload ?? action.context.clickData)
        }
        // 优先执行用户自定义脚本
        if (surface && scriptsRef.current[rid]) {
          const pipeEngine = new PipeEngine((surface.dataModel.get('/') ?? {}) as Record<string, any>)
          executeScript(scriptsRef.current[rid], {
            dataModel: surface.dataModel,
            pipeEngine,
            apiExecutor: createMockApiExecutor(),
            toast: (msg, type = 'info') => setToast({ msg, type }),
            sharedStore: useSharedStore,
            navigate: (pageId, params) => {
              const targetSurface = getSurfaceRef.current(pageId)
              if (targetSurface && params) {
                for (const [k, v] of Object.entries(params)) {
                  targetSurface.dataModel.set(`/navParams/${k}`, v)
                }
              }
              setCurrentEditPage(pageId)
              setCurrentSurfaceIdRef.current(pageId)
            },
            action,
          })
        } else {
          engineRef.current?.triggerReaction(rid)
        }
      }
    })
  }, [a2ui.onAction])

  // ===== Toast =====

  const showToast = useCallback((msg: string, type = 'info') => {
    setToast({ msg, type })
  }, [])

  // ===== 树 =====

  const treeRoots = useMemo(() => {
    const childIds = new Set<string>()
    components.forEach(c => {
      (c.props?.children as string[] | undefined)?.forEach(id => childIds.add(id))
    })
    return components.filter(c => !childIds.has(c.id))
  }, [components])

  // ===== 选中项 =====

  const selectedComponent = selectedId ? compMap.get(selectedId) ?? null : null
  const selectedDef: ComponentDef | null = selectedComponent
    ? componentCatalog[selectedComponent.component] as ComponentDef ?? null
    : null

  const isColumnSelected = selectedId?.includes('$col$') ?? false
  const colTableId = isColumnSelected ? selectedId!.split('$col$')[0] : null
  const colIndex = isColumnSelected ? parseInt(selectedId!.split('$col$')[1]) : null
  const selectedColumn = (isColumnSelected && colTableId && colIndex !== null)
    ? compMap.get(colTableId)?.props?.columns?.[colIndex] ?? null
    : null

  // ===== 操作 =====

  const generateId = (type: string) => `${type.toLowerCase()}${idCounter.current++}`

  function addComponent(type: string) {
    const def = componentCatalog[type]
    if (!def) return
    const id = generateId(type)
    const props: Record<string, any> = {}
    Object.entries(def.props).forEach(([key, pd]) => {
      if (pd.defaultValue !== undefined) props[key] = pd.defaultValue
      else if (pd.type === 'string[]') props[key] = []
      else if (pd.type === 'string') props[key] = ''
      else if (pd.type === 'number') props[key] = 0
      else if (pd.type === 'boolean') props[key] = false
      else if (pd.type === 'array') props[key] = []
    })
    const newComp = { id, component: type, props }
    if (selectedComponent && canHaveChildren(selectedComponent)) {
      setComponents(prev => prev.map(c =>
        c.id === selectedId
          ? { ...c, props: { ...c.props, children: [...(c.props.children || []), id] } }
          : c
      ))
    }
    setComponents(prev => [...prev, newComp])
    setSelectedId(id)
  }

  function deleteComponent() {
    if (!selectedId) return
    if (isColumnSelected) { deleteColumn(); return }
    const id = selectedId
    const toDelete = collectDescendants(compMap, id)
    setComponents(prev => {
      const next = prev.map(c => {
        if (Array.isArray(c.props?.children)) {
          return { ...c, props: { ...c.props, children: c.props.children.filter((cid: string) => !toDelete.has(cid)) } }
        }
        return c
      })
      return next.filter(c => !toDelete.has(c.id))
    })
    setSelectedId(null)
  }

  function clearPage() {
    setPages(prev => {
      const cur = prev[currentEditPage] ?? { components: [], reactions: [], scripts: {}, initialDataModel: {} }
      return { ...prev, [currentEditPage]: { ...cur, components: [], reactions: [], scripts: {}, initialDataModel: {} } }
    })
    setSelectedId(null)
    // 同步清空 SurfaceModel 中的运行时 dataModel
    const processor = processorRef.current
    if (processor) {
      const surface = (processor as any).model?.getSurface(currentEditPage) ?? a2ui.getSurface(currentEditPage)
      if (surface) {
        try {
          processor.processMessages([{
            version: 'v0.9',
            updateDataModel: { surfaceId: surface.id, path: '/', value: {} },
          }] as any)
        } catch (err: any) {
          logger.warn('[Clear] 清空 dataModel 失败:', err?.message || err)
        }
      }
    }
  }

  /** 纯函数：在组件数组中把 id 插入到 targetId 的指定位置，返回新数组（O(depth) 仅修改受影响的父节点） */
  function insertIntoTree(
    comps: any[], id: string, targetId: string, position: 'before' | 'after' | 'inside',
  ): any[] {
    if (position === 'inside') {
      return comps.map(c =>
        c.id === targetId
          ? { ...c, props: { ...c.props, children: [...(c.props.children || []), id] } }
          : c
      )
    }
    const parentId = getParentId(comps, targetId)
    if (!parentId) {
      // targetId 是顶层节点，直接在平级数组中重排
      const targetIdx = comps.findIndex(c => c.id === targetId)
      if (targetIdx === -1) return comps
      const component = comps.find(c => c.id === id)
      if (!component) return comps
      const rest = comps.filter(c => c.id !== id)
      const newTargetIdx = rest.findIndex(c => c.id === targetId)
      const insertIdx = position === 'before' ? newTargetIdx : newTargetIdx + 1
      return [...rest.slice(0, insertIdx), component, ...rest.slice(insertIdx)]
    }
    return comps.map(c => {
      if (c.id !== parentId) return c
      const children = [...(c.props.children || [])]
      const idx = children.indexOf(targetId)
      if (position === 'before') children.splice(idx, 0, id)
      else children.splice(idx + 1, 0, id)
      return { ...c, props: { ...c.props, children } }
    })
  }

  // ===== palette → DataTable 列映射 =====

  const COLUMN_ELIGIBLE: Record<string, { cellType: string; defaultLabel: string }> = {
    Text: { cellType: 'text', defaultLabel: '文本列' },
    TextField: { cellType: 'input', defaultLabel: '输入列' },
    Select: { cellType: 'select', defaultLabel: '选择列' },
  }

  function addColumnToTable(tableId: string, componentType: string, insertIndex?: number) {
    const mapping = COLUMN_ELIGIBLE[componentType]
    if (!mapping) return
    setComponents(prev => prev.map(c => {
      if (c.id !== tableId) return c
      const cols = [...(c.props.columns || [])]
      const newCol = {
        key: `col_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`,
        label: mapping.defaultLabel,
        cellType: mapping.cellType,
      }
      if (insertIndex !== undefined) {
        cols.splice(insertIndex, 0, newCol)
      } else {
        cols.push(newCol)
      }
      return { ...c, props: { ...c.props, columns: cols } }
    }))
  }

  // ===== 拖拽 =====

  function onPaletteDragStart(e: React.DragEvent, componentType: string) {
    setDragSource({ type: 'palette', componentType })
    e.dataTransfer.setData('text/plain', componentType)
    e.dataTransfer.effectAllowed = 'copy'
  }

  function onTreeNodeDragStart(e: React.DragEvent, componentId: string) {
    setDragSource({ type: 'tree', componentId })
    e.dataTransfer.setData('text/plain', componentId)
    e.dataTransfer.effectAllowed = 'move'
  }

  function onTreeNodeDragOver(e: React.DragEvent, targetId: string) {
    const ds = dragSourceRef.current
    if (!ds) return
    if (ds.type === 'tree') {
      if (ds.componentId === targetId || collectDescendants(compMap, ds.componentId).has(targetId)) {
        if (dropIndicatorRef.current) setDropIndicator(null)
        return
      }
    }
    e.preventDefault()
    const targetComp = compMap.get(targetId)
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = e.clientY - rect.top
    const h = rect.height

    // palette eligible → DataTable 下部 zone → 作为列加入
    if (
      ds.type === 'palette' &&
      targetComp?.component === 'DataTable' &&
      COLUMN_ELIGIBLE[ds.componentType] &&
      y > h * 0.65
    ) {
      setDropIndicator({ targetId, position: 'addColumn' })
      return
    }

    let position: 'before' | 'after' | 'inside'
    if (y < h * 0.3) position = 'before'
    else if (y > h * 0.7) position = 'after'
    else if (canHaveChildren(targetComp)) position = 'inside'
    else position = y < h * 0.5 ? 'before' : 'after'
    setDropIndicator({ targetId, position })
  }

  function onTreeNodeDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault()
    e.stopPropagation()
    const ds = dragSourceRef.current
    const di = dropIndicatorRef.current
    if (!ds || !di) return

    if (di.position === 'addColumn' && ds.type === 'palette') {
      addColumnToTable(targetId, ds.componentType)
      setDragSource(null)
      setDropIndicator(null)
      return
    }

    if (ds.type === 'palette') {
      const newId = generateId(ds.componentType)
      const def = componentCatalog[ds.componentType]
      if (!def) return
      const props: Record<string, any> = {}
      Object.entries(def.props).forEach(([k, pd]) => {
        if (pd.defaultValue !== undefined) props[k] = pd.defaultValue
        else if (pd.type === 'string[]') props[k] = []
        else if (pd.type === 'string') props[k] = ''
        else if (pd.type === 'number') props[k] = 0
        else if (pd.type === 'boolean') props[k] = false
        else if (pd.type === 'array') props[k] = []
      })
      const newComp = { id: newId, component: ds.componentType, props }
      setComponents(prev => insertIntoTree([...prev, newComp], newId, targetId, di.position as 'before' | 'after' | 'inside'))
      setSelectedId(newId)
    } else if (ds.type === 'tree') {
      const movedId = ds.componentId
      if (movedId === targetId) { setDragSource(null); setDropIndicator(null); return }
      setComponents(prev => {
        const oldParent = getParentId(prev, movedId)
        let next = prev.map(c => {
          if (c.id === oldParent && c.props?.children) {
            return { ...c, props: { ...c.props, children: c.props.children.filter((id: string) => id !== movedId) } }
          }
          return { ...c, props: { ...c.props } }
        })
        return insertIntoTree(next, movedId, targetId, di.position as 'before' | 'after' | 'inside')
      })
    }
    setDragSource(null)
    setDropIndicator(null)
  }

  function onDragEnd() { setDragSource(null); setDropIndicator(null) }

  function onTreeDragLeave() { if (dropIndicatorRef.current) setDropIndicator(null) }

  // ===== 列拖拽（DataTable columns 重排序） =====

  function onColumnDragStart(e: React.DragEvent, tableId: string, colIndex: number) {
    setDragSource({ type: 'column', tableId, colIndex })
    e.dataTransfer.setData('text/plain', `${tableId}$col$${colIndex}`)
    e.dataTransfer.effectAllowed = 'move'
  }

  function onColumnDragOver(e: React.DragEvent, virtualId: string) {
    const ds = dragSourceRef.current
    if (!ds) return
    if (ds.type === 'column') {
      const [tableId] = virtualId.split('$col$')
      if (tableId !== ds.tableId) return
    } else if (ds.type === 'palette' && COLUMN_ELIGIBLE[ds.componentType]) {
      // palette eligible → 允许拖到列节点上
    } else {
      return
    }
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = e.clientY - rect.top
    const position = y < rect.height * 0.5 ? 'before' : 'after'
    setDropIndicator({ targetId: virtualId, position })
  }

  function onColumnDrop(e: React.DragEvent, virtualId: string) {
    e.preventDefault()
    e.stopPropagation()
    const ds = dragSourceRef.current
    const di = dropIndicatorRef.current
    if (!ds || !di) return

    const [tableId, colIdxStr] = virtualId.split('$col$')
    const targetIndex = parseInt(colIdxStr ?? '')
    if (isNaN(targetIndex)) return

    if (ds.type === 'column') {
      setComponents(prev => prev.map(c => {
        if (c.id !== tableId) return c
        const cols = [...c.props.columns]
        const [moved] = cols.splice(ds.colIndex, 1)
        let insertAt = targetIndex
        if (ds.colIndex < targetIndex) insertAt--
        if (di.position === 'after') insertAt++
        cols.splice(insertAt, 0, moved)
        return { ...c, props: { ...c.props, columns: cols } }
      }))
    } else if (ds.type === 'palette') {
      let insertIndex = targetIndex
      if (di.position === 'after') insertIndex++
      addColumnToTable(tableId, ds.componentType, insertIndex)
    }

    setDragSource(null)
    setDropIndicator(null)
  }

  // ===== 属性编辑 =====

  function updateProp(key: string, value: any) {
    if (!selectedComponent) return
    setComponents(prev => prev.map(c =>
      c.id === selectedId ? { ...c, props: { ...c.props, [key]: value } } : c
    ))
  }

  function updateColumnField(field: string, value: any) {
    if (!colTableId || colIndex === null) return
    setComponents(prev => prev.map(c => {
      if (c.id !== colTableId) return c
      const cols = [...c.props.columns]
      cols[colIndex] = { ...cols[colIndex], [field]: value }
      return { ...c, props: { ...c.props, columns: cols } }
    }))
  }

  function addColumn() {
    const tableId = colTableId ?? selectedId
    if (!tableId) return
    setComponents(prev => prev.map(c => {
      if (c.id !== tableId) return c
      return { ...c, props: { ...c.props, columns: [...(c.props.columns || []), { key: '', label: '' }] } }
    }))
  }

  function deleteColumn() {
    if (!colTableId || colIndex === null) return
    setComponents(prev => prev.map(c => {
      if (c.id !== colTableId) return c
      return { ...c, props: { ...c.props, columns: c.props.columns.filter((_: any, i: number) => i !== colIndex) } }
    }))
    setSelectedId(colTableId)
  }

  // ===== JSON / DataModel 编辑器 =====

  const jsonCm = useCodeMirror('')
  const dmCm = useCodeMirror('')

  function openJsonDialog() {
    // 序列化所有页面为多页面 JSON 格式
    const serializedPages: Record<string, any> = {}
    for (const [pageId, ps] of Object.entries(pages)) {
      const logic: any = { reactions: ps.reactions }
      if (ps.scripts && Object.keys(ps.scripts).length > 0) {
        logic.scripts = ps.scripts
      }
      serializedPages[pageId] = {
        a2ui: [
          { beginRendering: { surfaceId: 'main', catalogId: 'basic' } },
          { surfaceUpdate: { surfaceId: 'main', components: ps.components } },
          ...dataModelToV09Messages('main', ps.initialDataModel),
        ],
        logic,
        ...(ps.children ? { children: ps.children } : {}),
      }
    }
    // 多页→外层 pages 包裹；单页→兼容旧格式（顶层 a2ui/logic）
    const output = Object.keys(serializedPages).length === 1 && serializedPages['main']
      ? serializedPages['main']
      : { pages: serializedPages }

    jsonCm.updateDoc(JSON.stringify(output, null, 2))
    setShowJsonDialog(true)
  }

  function openDmDialog() {
    const surface = a2ui.getSurface(currentEditPage)
    const dm = surface ? extractDataModel(surface) : {}
    dmCm.updateDoc(JSON.stringify(structuredClone(dm), null, 2))
    setShowDmDialog(true)
  }

  // CodeMirror 生命周期管理：Dialog 打开→DOM就绪→创建 EditorView，关闭→销毁
  useEffect(() => {
    if (showJsonDialog) {
      const t = setTimeout(() => jsonCm.create(), 100)
      return () => clearTimeout(t)
    } else {
      jsonCm.destroy()
    }
  }, [showJsonDialog])

  useEffect(() => {
    if (showDmDialog) {
      const t = setTimeout(() => dmCm.create(), 100)
      return () => clearTimeout(t)
    } else {
      dmCm.destroy()
    }
  }, [showDmDialog])

  // Reaction JS CodeMirror 生命周期：Dialog 打开/关闭 或 编辑模式切换
  useEffect(() => {
    if (showReactionDialog) {
      const t = setTimeout(() => { reactionCm.destroy(); reactionCm.create() }, 150)
      return () => clearTimeout(t)
    } else {
      reactionCm.destroy()
    }
  }, [showReactionDialog, dialogEditMode])

  function applyJsonEdit() {
    try {
      loadJson(JSON.parse(jsonCm.getDoc()))
      setShowJsonDialog(false)
      showToast('JSON 已应用', 'success')
    } catch { showToast('JSON 格式错误', 'error') }
  }

  function applyDmEdit() {
    try {
      const parsed = JSON.parse(dmCm.getDoc())
      for (const [key, value] of Object.entries(parsed)) {
        a2ui?.setDataValue(`/${key}`, value)
      }
      setRenderKey(k => k + 1)
      setShowDmDialog(false)
      showToast('DataModel 已更新', 'success')
    } catch { showToast('JSON 格式错误', 'error') }
  }

  // ===== 导出 =====

  function exportJson() {
    const serializedPages: Record<string, any> = {}
    for (const [pageId, ps] of Object.entries(pages)) {
      serializedPages[pageId] = {
        a2ui: [
          { beginRendering: { surfaceId: 'main', catalogId: 'basic' } },
          { surfaceUpdate: { surfaceId: 'main', components: ps.components } },
          ...dataModelToV09Messages('main', ps.initialDataModel),
        ],
        logic: { reactions: ps.reactions },
      }
    }
    const output = Object.keys(serializedPages).length === 1 && serializedPages['main']
      ? serializedPages['main']
      : { pages: serializedPages }

    navigator.clipboard.writeText(JSON.stringify(output, null, 2))
      .then(() => showToast('已复制到剪贴板', 'success'))
  }

  // ===== 文件上传 =====

  const fileInputRef = useRef<HTMLInputElement>(null)
  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        loadJson(JSON.parse(reader.result as string))
        showToast('JSON 文件加载成功', 'success')
      } catch { showToast('JSON 解析失败', 'error') }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  // ===== Props 值展示 =====

  /** 将 DataBinding { path } 格式化为可读字符串，普通值原样返回 */
  function formatPropValue(v: any): string {
    if (typeof v === 'object' && v !== null && 'path' in v) return v.path as string
    return v ?? ''
  }

  /** 将编辑器输入的字符串解析为存储格式：/ 开头 → DataBinding，否则 → 普通值 */
  function parsePropInput(raw: string): any {
    const trimmed = raw.trim()
    if (trimmed.startsWith('/')) return { path: trimmed }
    return trimmed
  }

  // ===== Props 元数据 =====

  const selectedPropsMeta = useMemo(() => {
    if (!selectedDef) return []
    return Object.entries(selectedDef.props).map(([key, meta]) => ({ key, ...meta }))
  }, [selectedDef])

  // ================================================================
  //  渲染
  // ================================================================

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden bg-gray-100" onDragOver={e => e.preventDefault()}>
      <Toast toast={toast} onDone={() => setToast(null)} />

      {/* ===== 左侧：组件面板 + DOM 树 ===== */}
      <aside className="w-[280px] min-w-[280px] flex flex-col border-r bg-white shrink-0">
        <div className="p-3 border-b">
          <div className="text-sm font-semibold mb-2">组件面板</div>
          <Input value={paletteFilter} onChange={e => setPaletteFilter(e.target.value)}
            placeholder="搜索组件..." className="h-8 text-xs" />
          <div className="mt-2 max-h-[320px] overflow-y-auto space-y-2">
            {categoryGroups.map(group => (
              <div key={group.category}>
                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider px-1 mb-1">
                  {group.label}
                </div>
                <div className="flex flex-wrap gap-1">
                  {group.items.map(([name]) => (
                    <div key={name}
                      className="flex items-center gap-1 px-2 py-1 border rounded text-xs cursor-grab hover:border-blue-500 hover:bg-blue-50 active:cursor-grabbing"
                      draggable
                      onDragStart={e => onPaletteDragStart(e, name)}
                      onDragEnd={onDragEnd}
                    ><span className="font-medium">{name}</span></div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex-1 flex flex-col min-h-0">
          <div className="text-sm font-semibold px-3 py-2 border-b flex justify-between">
            <span>DOM 树</span>
            <span className="text-xs text-gray-400">{components.length} 组件</span>
          </div>
          <div className="flex-1 overflow-y-auto py-1"
            onDrop={e => {
              const target = e.target as HTMLElement
              if (target.closest('.tree-row')) return
              if (!dragSource) return
              if (dragSource.type === 'palette') {
                const newId = generateId(dragSource.componentType)
                const def = componentCatalog[dragSource.componentType]
                if (!def) return
                const props: Record<string, any> = {}
                Object.entries(def.props).forEach(([k, pd]) => {
                  if (pd.defaultValue !== undefined) props[k] = pd.defaultValue
                  else if (pd.type === 'string[]') props[k] = []
                  else if (pd.type === 'string') props[k] = ''
                  else if (pd.type === 'number') props[k] = 0
                  else if (pd.type === 'boolean') props[k] = false
                  else if (pd.type === 'array') props[k] = []
                })
                setComponents(prev => [...prev, { id: newId, component: dragSource.componentType, props }])
                setSelectedId(newId)
              }
              setDragSource(null)
              setDropIndicator(null)
            }}
          >
            {treeRoots.map(root => (
              <TreeNode key={root.id} nodeId={root.id}
                compMap={compMap}
                selectedId={selectedId} collapsedIds={collapsedIds} depth={0}
                dropIndicator={dropIndicator}
                onSelect={setSelectedId}
                onToggleCollapse={id => {
                  setCollapsedIds(prev => {
                    const next = new Set(prev)
                    next.has(id) ? next.delete(id) : next.add(id)
                    return next
                  })
                }}
                onDragStart={onTreeNodeDragStart} onDragOver={onTreeNodeDragOver}
                onDragLeave={onTreeDragLeave} onDrop={onTreeNodeDrop} onDragEnd={onDragEnd}
                onColumnDragStart={onColumnDragStart} onColumnDragOver={onColumnDragOver}
                onColumnDrop={onColumnDrop}
              />
            ))}
            {treeRoots.length === 0 && (
              <div className="p-4 text-center text-gray-400 text-xs">从上方拖拽组件到此处</div>
            )}
          </div>
        </div>
      </aside>

      {/* ===== 中间：渲染区 ===== */}
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="flex gap-2 p-2 bg-white border-b shrink-0 items-center flex-wrap">
          <PageSelector
            pageIds={Object.keys(pages)}
            currentPageId={currentEditPage}
            onSelect={(pid) => {
              setCurrentEditPage(pid)
              a2ui?.setCurrentSurfaceId(pid)
            }}
          />
          <div className="w-px h-6 bg-gray-200" />
          <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>上传 JSON</Button>
          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleFileUpload} />
          <Button size="sm" variant="outline" onClick={openJsonDialog}>显示 JSON</Button>
          <Button size="sm" variant="outline" onClick={openDmDialog}>DataModel</Button>
          <Button size="sm" variant="outline" disabled={reactions.length === 0} onClick={() => { setDialogReactionId(reactions[0]?.id ?? null); setShowReactionDialog(true) }}>Reactions</Button>
          <Button size="sm" variant="destructive" disabled={!selectedId} onClick={deleteComponent}>删除</Button>
          <Button size="sm" variant="outline" onClick={clearPage}>清空</Button>
        </div>
        <div className="flex-1 p-4 overflow-y-auto bg-gray-50">
          <div className="text-xs text-gray-400 mb-2 uppercase">实时渲染预览 — {currentEditPage}</div>
          {(() => {
            const surf = a2ui.getSurface(currentEditPage)
            return surf ? (
              <div className="bg-white rounded-lg p-5 shadow-sm min-h-[200px]">
                <A2uiSurface key={`${currentEditPage}-${renderKey}`} surface={surf} />
              </div>
            ) : (
              <div className="flex items-center justify-center h-[200px] bg-white rounded-lg shadow-sm text-gray-400 text-sm">
                从左侧拖拽组件到此处
              </div>
            )
          })()}
        </div>
      </main>

      {/* ===== 右侧：属性配置 ===== */}
      <aside className="w-[320px] min-w-[320px] border-l bg-white shrink-0 overflow-y-auto">
        {isColumnSelected && selectedColumn ? (
          <>
            <div className="text-sm font-semibold px-3 py-2 border-b">列属性</div>
            <div className="p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded">列: {selectedColumn.label || '(未命名)'}</span>
              </div>
              <div>
                <label className="text-xs text-gray-500">key</label>
                <Input className="h-8 text-xs mt-1" value={selectedColumn.key ?? ''}
                  onChange={e => updateColumnField('key', e.target.value)} placeholder="字段名" />
              </div>
              <div>
                <label className="text-xs text-gray-500">label</label>
                <Input className="h-8 text-xs mt-1" value={selectedColumn.label ?? ''}
                  onChange={e => updateColumnField('label', e.target.value)} placeholder="列标题" />
              </div>
              <div>
                <label className="text-xs text-gray-500">cellType</label>
                <Select value={selectedColumn.cellType || 'text'} onValueChange={v => updateColumnField('cellType', v)}>
                  <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {cellTypeOptions.map(ct => <SelectItem key={ct} value={ct}>{ct}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {(selectedColumn.cellType || 'text') === 'select' && (
                <div>
                  <label className="text-xs text-gray-500">options <span className="text-gray-400">JSON Pointer 或 JSON 数组</span></label>
                  <Input className="h-8 text-xs mt-1 font-mono"
                    value={typeof selectedColumn.cellProps?.options === 'string'
                      ? selectedColumn.cellProps.options
                      : JSON.stringify(selectedColumn.cellProps?.options || [])}
                    onChange={e => updateColumnField('cellProps', { options: e.target.value })}
                    placeholder='例如: /data/statusOptions 或 [{"label":"..","value":".."}]' />
                </div>
              )}
            </div>
          </>
        ) : selectedComponent ? (
          <>
            <div className="text-sm font-semibold px-3 py-2 border-b">属性配置</div>
            <div className="p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded">{selectedComponent.component}</span>
                <span className="text-xs text-gray-400 font-mono">{selectedComponent.id}</span>
              </div>
              {selectedComponent.component === 'DataTable' && (
                <Button size="sm" variant="outline" onClick={addColumn}>+ 添加列</Button>
              )}
              <div>
                <label className="text-xs text-gray-500">ID</label>
                <Input className="h-8 text-xs mt-1" value={selectedComponent.id} disabled />
              </div>
              {selectedPropsMeta.map(prop => (
                <div key={prop.key}>
                  <label className="text-xs text-gray-500">
                    {prop.key}
                    {prop.required && <span className="text-red-500 ml-0.5">*</span>}
                    <span className="text-gray-300 ml-1">{prop.type}</span>
                    {prop.key === 'columns' && <span className="text-blue-400 ml-1">在 DOM 树中编辑</span>}
                  </label>
                  {prop.key === 'columns' ? (
                    <div className="text-xs text-gray-400 mt-1">{(selectedComponent.props.columns || []).length} 列</div>
                  ) : prop.type === 'boolean' ? (
                    <Switch checked={selectedComponent.props[prop.key] ?? false} onCheckedChange={v => updateProp(prop.key, v)} />
                  ) : prop.type === 'number' ? (
                    <Input type="number" className="h-8 text-xs mt-1"
                      value={selectedComponent.props[prop.key] ?? 0}
                      onChange={e => updateProp(prop.key, Number(e.target.value))} />
                  ) : prop.enum ? (
                    <Select value={formatPropValue(selectedComponent.props[prop.key]) || (prop.defaultValue as string) || ''} onValueChange={v => updateProp(prop.key, v)}>
                      <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {prop.enum.map((opt: string) => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input className="h-8 text-xs mt-1" value={formatPropValue(selectedComponent.props[prop.key])}
                      onChange={e => updateProp(prop.key,
                        /^Dynamic/.test(prop.type) ? parsePropInput(e.target.value) : e.target.value)} />
                  )}
                </div>
              ))}
            </div>
            {componentReactions.length > 0 && (
              <div className="border-t px-3 py-2">
                <Button size="sm" variant="outline" className="w-full text-xs" onClick={openReactionDialog}>
                  Reaction 代码 ({componentReactions.length})
                </Button>
              </div>
            )}
          </>
        ) : (
          <div className="p-3">
            <div className="text-sm font-semibold px-0 py-2 border-b mb-2">属性配置</div>
            <div className="text-gray-400 text-sm text-center py-8">选中组件或列以编辑属性</div>
          </div>
        )}
      </aside>

      {/* JSON Dialog */}
      <Dialog open={showJsonDialog} onOpenChange={setShowJsonDialog}>
        <DialogContent className="max-w-[800px]">
          <DialogHeader><DialogTitle>JSON 编辑器</DialogTitle></DialogHeader>
          <div ref={jsonCm.containerRef} className="h-[60vh] border rounded overflow-hidden" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowJsonDialog(false)}>取消</Button>
            <Button onClick={applyJsonEdit}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reaction JS Dialog */}
      <Dialog open={showReactionDialog} onOpenChange={setShowReactionDialog}>
        <DialogContent className="max-w-[1000px]">
          <DialogHeader>
            <DialogTitle>Reaction 代码</DialogTitle>
          </DialogHeader>
          {(() => {
            const isComponentEvent = (r: any) => r.when?.event === 'click' || r.when?.event === 'change'
            const compEvents = reactions.filter(isComponentEvent)
            const pageEvents = reactions.filter(r => !isComponentEvent(r))

            // 按组件 ID 分组
            const byComponent = new Map<string, any[]>()
            for (const r of compEvents) {
              const key = r.when?.field ?? '_unknown'
              if (!byComponent.has(key)) byComponent.set(key, [])
              byComponent.get(key)!.push(r)
            }

            return (
              <div className="flex gap-3" style={{ height: '60vh' }}>
                {/* 左侧列表 */}
                <div className="w-[260px] shrink-0 border rounded overflow-y-auto bg-gray-50">
                  {compEvents.length > 0 && (
                    <div className="py-1">
                      <div className="text-xs text-gray-400 px-3 py-1.5 font-medium">组件事件</div>
                      {[...byComponent.entries()].map(([compId, rxList]) => (
                        <div key={compId}>
                          <div className="text-xs text-gray-400 px-3 py-1 font-mono">{compId}</div>
                          {rxList.map(r => (
                            <button
                              key={r.id}
                              className={`w-full text-left px-5 py-1 text-xs font-mono hover:bg-blue-50 ${dialogReactionId === r.id ? 'bg-blue-100 text-blue-700 border-r-2 border-blue-500' : 'text-gray-600'}`}
                              onClick={() => setDialogReactionId(r.id)}
                            >
                              {r.id} <span className="text-gray-400">·{r.when?.event}</span>
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  {pageEvents.length > 0 && (
                    <div className="border-t py-1">
                      <div className="text-xs text-gray-400 px-3 py-1.5 font-medium">页面 / 数据事件</div>
                      {pageEvents.map(r => (
                        <button
                          key={r.id}
                          className={`w-full text-left px-3 py-1 text-xs font-mono hover:bg-blue-50 ${dialogReactionId === r.id ? 'bg-blue-100 text-blue-700 border-r-2 border-blue-500' : 'text-gray-600'}`}
                          onClick={() => setDialogReactionId(r.id)}
                        >
                          {r.id} <span className="text-gray-400">·{r.when?.event}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {reactions.length === 0 && (
                    <div className="text-xs text-gray-400 text-center py-8">暂无 Reaction</div>
                  )}
                  <div className="border-t px-2 py-1.5">
                    {!showNewForm ? (
                      <button
                        className="w-full text-left text-xs text-blue-600 hover:bg-blue-50 px-2 py-1 rounded"
                        onClick={() => setShowNewForm(true)}
                      >
                        + 新建
                      </button>
                    ) : (
                      <div className="space-y-1.5 p-1">
                        <input
                          className="w-full h-7 text-xs border rounded px-2 font-mono"
                          placeholder="Reaction ID (如 onFilter)"
                          value={newRxId}
                          onChange={e => setNewRxId(e.target.value)}
                        />
                        <select
                          className="w-full h-7 text-xs border rounded px-1"
                          value={newRxEvent}
                          onChange={e => { setNewRxEvent(e.target.value); setNewRxField('') }}
                        >
                          <option value="click">click — 组件点击</option>
                          <option value="change">change — 组件值变化</option>
                          <option value="init">init — 页面加载</option>
                        </select>
                        {newRxEvent !== 'init' && (
                          <select
                            className="w-full h-7 text-xs border rounded px-1"
                            value={newRxField}
                            onChange={e => setNewRxField(e.target.value)}
                          >
                            <option value="">选择组件...</option>
                            {components.map(c => (
                              <option key={c.id} value={c.id}>{c.id} ({c.component})</option>
                            ))}
                          </select>
                        )}
                        <div className="flex gap-1">
                          <button
                            className="flex-1 h-7 text-xs bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-40"
                            disabled={!newRxId.trim() || (newRxEvent !== 'init' && !newRxField)}
                            onClick={() => {
                              const id = newRxId.trim()
                              const field = newRxEvent === 'init' ? '/_' : newRxField
                              setReactions(prev => [...prev, { id, when: { field, event: newRxEvent }, then: [] }])
                              // 自动为目标组件设置 reactionId
                              if (newRxEvent !== 'init') {
                                setComponents(prev => prev.map(c =>
                                  c.id === newRxField ? { ...c, props: { ...c.props, reactionId: id } } : c
                                ))
                              }
                              setDialogReactionId(id)
                              setNewRxId('')
                              setNewRxEvent('click')
                              setNewRxField('')
                              setShowNewForm(false)
                              // 直接进入编辑模式
                              setTimeout(() => setDialogEditMode(true), 200)
                            }}
                          >
                            创建
                          </button>
                          <button
                            className="h-7 px-2 text-xs text-gray-500 hover:bg-gray-100 rounded"
                            onClick={() => { setShowNewForm(false); setNewRxId(''); setNewRxField('') }}
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                {/* 右侧代码 */}
                <div className="flex-1 min-w-0 border rounded overflow-hidden">
                  <div ref={reactionCm.containerRef} className="h-full" />
                </div>
              </div>
            )
          })()}
          <DialogFooter className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {scripts[dialogReactionId ?? ''] && (
                <span className="text-xs text-green-600 font-medium">已自定义脚本</span>
              )}
              {!scripts[dialogReactionId ?? ''] && dialogReactionId && (
                <span className="text-xs text-gray-400">自动生成</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {scripts[dialogReactionId ?? ''] && dialogReactionId && (
                <Button size="sm" variant="destructive" onClick={() => { deleteScript(dialogReactionId!); setToast({ msg: '已还原为自动生成', type: 'info' }) }}>还原</Button>
              )}
              {dialogReactionId && (
                <Button size="sm" onClick={toggleEditMode}>
                  {dialogEditMode ? '保存' : '编辑'}
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={() => setShowReactionDialog(false)}>关闭</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* DataModel Dialog */}
      <Dialog open={showDmDialog} onOpenChange={setShowDmDialog}>
        <DialogContent className="max-w-[600px]">
          <DialogHeader><DialogTitle>DataModel 编辑器</DialogTitle></DialogHeader>
          <div ref={dmCm.containerRef} className="h-[60vh] border rounded overflow-hidden" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDmDialog(false)}>取消</Button>
            <Button onClick={applyDmEdit}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 自定义 CSS */}
      <style>{`
        .tree-row { display: flex; align-items: center; gap: 4px; padding: 3px 8px; margin: 1px 4px; border: 1.5px solid transparent; border-radius: 3px; cursor: pointer; font-size: 12px; position: relative; transition: background 0.1s; }
        .tree-row:hover { background: #f5f5f5; }
        .tree-row-selected { background: #e6f7ff !important; border-color: #1890ff; }
        .tree-row-col { opacity: 0.85; }
        .tree-toggle { width: 14px; font-size: 10px; color: #999; flex-shrink: 0; cursor: pointer; text-align: center; }
        .tree-tag { display: inline-block; padding: 0 4px; font-size: 10px; background: #e6f7ff; color: #1890ff; border-radius: 2px; font-weight: 500; flex-shrink: 0; }
        .tree-row-selected > .tree-tag { background: #1890ff; color: #fff; }
        .tree-tag-col { background: #f0f5ff; color: #597ef7; font-style: italic; }
        .tree-row-selected .tree-tag-col { background: #597ef7; color: #fff; }
        .tree-label { color: #333; font-family: ui-monospace, monospace; font-size: 11px; }
        .tree-col-count { font-size: 10px; color: #bbb; margin-left: auto; }
        .tree-col-label { font-size: 10px; color: #bbb; margin-left: 4px; }
        .drop-line { position: absolute; left: 6px; right: 4px; height: 2px; background: #1890ff; border-radius: 1px; z-index: 10; pointer-events: none; }
        .drop-line::before { content: ''; position: absolute; left: -4px; top: -4px; width: 10px; height: 10px; background: #1890ff; border-radius: 50%; }
        .drop-line-before { top: -1px; }
        .drop-line-after { bottom: -1px; }
        .drop-highlight { position: absolute; inset: 0; background: rgba(24,144,255,0.12); border: 1.5px dashed #1890ff; border-radius: 3px; z-index: 10; pointer-events: none; }
        .drop-add-column { position: absolute; left: 4px; right: 4px; bottom: 0; height: 28px; display: flex; align-items: center; gap: 6px; z-index: 10; pointer-events: none; }
        .drop-add-column-bar { flex: 1; height: 2px; background: #52c41a; border-radius: 1px; }
        .drop-add-column-text { font-size: 11px; color: #52c41a; font-weight: 500; white-space: nowrap; }
      `}</style>
    </div>
  )
}
