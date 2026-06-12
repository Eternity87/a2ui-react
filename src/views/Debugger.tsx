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
import demoDefault from '@/demo.json'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { json } from '@codemirror/lang-json'
import { oneDark } from '@codemirror/theme-one-dark'
import { basicSetup } from 'codemirror'

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
    if (!v09Type) { console.warn(`[loadJson] Unknown v0.8 type: ${typeName}`); return c }
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
          if (Array.isArray(value.context)) {
            for (const item of value.context) {
              if (item.key) ctx[item.key] = typeof item.value === 'object' && 'literalString' in item.value
                ? item.value.literalString : item.value
            }
          }
          props[key] = { event: { name: value.name, context: ctx } }
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
function useCodeMirror(initialDoc: string) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const docRef = useRef(initialDoc)

  const create = useCallback(() => {
    if (!containerRef.current || viewRef.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: docRef.current,
        extensions: [
          basicSetup, json(), oneDark,
          EditorView.updateListener.of(u => { if (u.docChanged) docRef.current = u.state.doc.toString() }),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: '13px' } }),
        ],
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
  const [showJsonDialog, setShowJsonDialog] = useState(false)
  const [showDmDialog, setShowDmDialog] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  // 注册 toast 处理器到 A2UI context，供 Dialog 等子组件使用
  useEffect(() => {
    a2ui.setToastHandler((msg, type = 'info') => setToast({ msg, type }))
    return () => a2ui.setToastHandler(console.error)
  }, [a2ui.setToastHandler])
  const idCounter = useRef(1)

  // ---- 引擎与数据 ----
  const engineRef = useRef<ReactionEngine | null>(null)
  const [renderKey, setRenderKey] = useState(0)

  // 当前编辑页的状态（方便访问）
  const currentPage = pages[currentEditPage] ?? { components: [], reactions: [], initialDataModel: {} }
  const components = currentPage.components
  const reactions = currentPage.reactions

  // 包装 setComponents / setReactions 以操作当前页
  const setComponents = useCallback((updater: any[] | ((prev: any[]) => any[])) => {
    setPages(prev => {
      const cur = prev[currentEditPage] ?? { components: [], reactions: [], initialDataModel: {} }
      const newComps = typeof updater === 'function' ? updater(cur.components) : updater
      return { ...prev, [currentEditPage]: { ...cur, components: newComps } }
    })
  }, [currentEditPage])

  const compMap = useMemo(() => {
    const m = new Map<string, any>()
    components.forEach(c => m.set(c.id, c))
    return m
  }, [components])

  // ===== 同步：components[] → SurfaceModel =====

  const processorRef = useRef(a2ui?.processor)
  processorRef.current = a2ui?.processor
  const componentsRef = useRef(components)
  componentsRef.current = components
  const editPageRef = useRef(currentEditPage)
  editPageRef.current = currentEditPage

  const syncTimerRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    if (components.length === 0) return
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => {
      const processor = processorRef.current
      if (!processor) return
      const pageId = editPageRef.current
      const surface = a2ui.getSurface(pageId)
      if (!surface) return
      const v09Comps = componentsRef.current.map(c => ({
        id: c.id,
        component: c.component,
        ...c.props,
      }))
      const finalComps = ensureRootComponent(v09Comps)
      processor.processMessages([{
        updateComponents: { surfaceId: surface.id, components: finalComps },
      }] as any)
      setRenderKey(k => k + 1)
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
      const su = page.a2ui?.find((m: any) => 'surfaceUpdate' in m)
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
    })
    engine.boot()
    engineRef.current = engine

    return () => {
      engine.destroy()
      engineRef.current = null
    }
  }, [currentEditPage, reactions])

  // ===== Action 事件 → ReactionEngine =====

  useEffect(() => {
    return a2ui.onAction((action: any) => {
      if (action.name === 'a2ui.click' && action.context?.reactionId) {
        engineRef.current?.triggerReaction(action.context.reactionId)
      }
    })
  }, [a2ui.currentSurfaceId])

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
    if (!parentId) return comps
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
    if (!dragSource) return
    if (dragSource.type === 'tree') {
      if (dragSource.componentId === targetId) return
      if (collectDescendants(compMap, dragSource.componentId).has(targetId)) return
    }
    e.preventDefault()
    const targetComp = compMap.get(targetId)
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = e.clientY - rect.top
    const h = rect.height

    // palette eligible → DataTable 下部 zone → 作为列加入
    if (
      dragSource.type === 'palette' &&
      targetComp?.component === 'DataTable' &&
      COLUMN_ELIGIBLE[dragSource.componentType] &&
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
    if (!dragSource || !dropIndicator) return

    if (dropIndicator.position === 'addColumn' && dragSource.type === 'palette') {
      addColumnToTable(targetId, dragSource.componentType)
      setDragSource(null)
      setDropIndicator(null)
      return
    }

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
      const newComp = { id: newId, component: dragSource.componentType, props }
      // 单次 setComponents：添加新组件 + 插入树位置
      setComponents(prev => insertIntoTree([...prev, newComp], newId, targetId, dropIndicator.position))
      setSelectedId(newId)
    } else if (dragSource.type === 'tree') {
      const movedId = dragSource.componentId
      // 单次 setComponents：从旧父节点移除 + 插入新位置
      setComponents(prev => {
        const oldParent = getParentId(prev, movedId)
        let next = prev.map(c => {
          if (c.id === oldParent && c.props?.children) {
            return { ...c, props: { ...c.props, children: c.props.children.filter((id: string) => id !== movedId) } }
          }
          return { ...c, props: { ...c.props } }
        })
        return insertIntoTree(next, movedId, targetId, dropIndicator.position)
      })
    }
    setDragSource(null)
    setDropIndicator(null)
  }

  function onDragEnd() { setDragSource(null); setDropIndicator(null) }

  // ===== 列拖拽（DataTable columns 重排序） =====

  function onColumnDragStart(e: React.DragEvent, tableId: string, colIndex: number) {
    setDragSource({ type: 'column', tableId, colIndex })
    e.dataTransfer.setData('text/plain', `${tableId}$col$${colIndex}`)
    e.dataTransfer.effectAllowed = 'move'
  }

  function onColumnDragOver(e: React.DragEvent, virtualId: string) {
    if (!dragSource) return
    if (dragSource.type === 'column') {
      const [tableId] = virtualId.split('$col$')
      if (tableId !== dragSource.tableId) return
    } else if (dragSource.type === 'palette' && COLUMN_ELIGIBLE[dragSource.componentType]) {
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
    if (!dragSource || !dropIndicator) return

    const [tableId, colIdxStr] = virtualId.split('$col$')
    const targetIndex = parseInt(colIdxStr)
    if (isNaN(targetIndex)) return

    if (dragSource.type === 'column') {
      setComponents(prev => prev.map(c => {
        if (c.id !== tableId) return c
        const cols = [...c.props.columns]
        const [moved] = cols.splice(dragSource.colIndex, 1)
        let insertAt = targetIndex
        if (dragSource.colIndex < targetIndex) insertAt--
        if (dropIndicator.position === 'after') insertAt++
        cols.splice(insertAt, 0, moved)
        return { ...c, props: { ...c.props, columns: cols } }
      }))
    } else if (dragSource.type === 'palette') {
      let insertIndex = targetIndex
      if (dropIndicator.position === 'after') insertIndex++
      addColumnToTable(tableId, dragSource.componentType, insertIndex)
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
      serializedPages[pageId] = {
        a2ui: [
          { beginRendering: { surfaceId: 'main', catalogId: 'basic' } },
          { surfaceUpdate: { surfaceId: 'main', components: ps.components } },
          ...dataModelToV09Messages('main', ps.initialDataModel),
        ],
        logic: { reactions: ps.reactions },
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
          <div className="flex flex-wrap gap-1 mt-2 max-h-[180px] overflow-y-auto">
            {Object.entries(componentCatalog)
              .filter(([name]) => name.toLowerCase().includes(paletteFilter.toLowerCase()))
              .map(([name, def]) => (
                <div key={name}
                  className="flex items-center gap-1 px-2 py-1 border rounded text-xs cursor-grab hover:border-blue-500 hover:bg-blue-50 active:cursor-grabbing"
                  draggable
                  onDragStart={e => onPaletteDragStart(e, name)}
                  onDragEnd={onDragEnd}
                ><span className="font-medium">{name}</span></div>
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
                onDragLeave={() => {}} onDrop={onTreeNodeDrop} onDragEnd={onDragEnd}
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
          <Button size="sm" variant="destructive" disabled={!selectedId} onClick={deleteComponent}>删除</Button>
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
