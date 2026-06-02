import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { componentCatalog, type ComponentDef } from '@/catalogs/component-catalog'
import { A2UIRenderer } from '@/runtime/a2ui-renderer'
import { DataModelStore, ReactionEngine } from '@/runtime/reaction-engine'
import { PipeEngine } from '@/runtime/pipe-engine'
import { createMockApiExecutor } from '@/mock/api'
import { TreeNode } from '@/views/TreeNode'
import demoDefault from '@/demo.json'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { json } from '@codemirror/lang-json'
import { oneDark } from '@codemirror/theme-one-dark'
import { basicSetup } from 'codemirror'

// ===== 工具 =====
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

function canHaveChildren(typeOrComp: any): boolean {
  const type = typeof typeOrComp === 'string' ? typeOrComp : typeOrComp?.component
  return ['Row', 'Card'].includes(type ?? '')
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
          basicSetup,
          json(),
          oneDark,
          EditorView.updateListener.of(u => { if (u.docChanged) docRef.current = u.state.doc.toString() }),
          EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { overflow: 'auto', fontFamily: "ui-monospace, monospace", fontSize: '13px' } }),
        ],
      }),
      parent: containerRef.current,
    })
    viewRef.current = view
    return view
  }, [])

  const updateDoc = useCallback((doc: string) => {
    docRef.current = doc
    if (viewRef.current) {
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: doc },
      })
    }
  }, [])

  const destroy = useCallback(() => {
    viewRef.current?.destroy()
    viewRef.current = null
  }, [])

  return { containerRef, viewRef, create, updateDoc, destroy, getDoc: () => docRef.current }
}

// ===== 主组件 =====
export function Debugger() {
  const [components, setComponents] = useState<any[]>([])
  const [dataModel, setDataModel] = useState<Record<string, any>>({})
  const [reactions, setReactions] = useState<any[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set())
  const [paletteFilter, setPaletteFilter] = useState('')
  const [dragSource, setDragSource] = useState<{ type: 'palette'; componentType: string } | { type: 'tree'; componentId: string } | null>(null)
  const [dropIndicator, setDropIndicator] = useState<{ targetId: string; position: 'before' | 'after' | 'inside' } | null>(null)
  const [showJsonDialog, setShowJsonDialog] = useState(false)
  const [showDmDialog, setShowDmDialog] = useState(false)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)
  const idCounter = useRef(1)
  const storeRef = useRef(new DataModelStore({}))
  const engineRef = useRef<ReactionEngine | null>(null)
  const initialDataModelRef = useRef<Record<string, any>>({})
  const [, forceUpdate] = useState(0)

  const compMap = useMemo(() => {
    const m = new Map<string, any>()
    components.forEach(c => m.set(c.id, c))
    return m
  }, [components])

  // ===== 加载 =====
  const loadJson = useCallback((data: any) => {
    const su = data.a2ui?.find((m: any) => 'surfaceUpdate' in m)
    if (!su) return
    setComponents(JSON.parse(JSON.stringify(su.surfaceUpdate.components)))
    const dm = data.a2ui?.find((m: any) => 'dataModelUpdate' in m)
    const reacts = data.logic?.reactions ? JSON.parse(JSON.stringify(data.logic.reactions)) : []

    // 初始化 DataModelStore
    const store = storeRef.current
    const initialDM = JSON.parse(JSON.stringify(dm?.dataModelUpdate?.data ?? {}))
    initialDataModelRef.current = initialDM
    store.replaceAll(initialDM)

    // 重建引擎
    engineRef.current?.destroy()
    const engine = new ReactionEngine(store, reacts, {
      apiExecutor: createMockApiExecutor(),
      pipeEngine: new PipeEngine(store.proxy),
      toast: (msg, type = 'info') => setToast({ msg, type }),
    })
    engine.boot()
    engineRef.current = engine

    setDataModel(store.getRaw())
    setReactions(reacts)
    setSelectedId(null)
    forceUpdate(k => k + 1)
  }, [])

  // ===== 初始化 + store 订阅 =====
  useEffect(() => {
    loadJson(demoDefault)
    const unsub = storeRef.current.subscribeAll(() => {
      setDataModel(storeRef.current.getRaw())
      forceUpdate(k => k + 1)
    })
    return () => { unsub(); engineRef.current?.destroy() }
  }, [loadJson])

  // ===== 渲染器事件 → 引擎 =====
  const handleRendererEvent = useCallback((event: string, payload: any) => {
    if (event === 'change' && payload.field) {
      storeRef.current.set(payload.field, payload.value)
      setDataModel(storeRef.current.getRaw())
      forceUpdate(k => k + 1)
    }
    if (event === 'click' && payload.reactionId) {
      engineRef.current?.triggerReaction(payload.reactionId)
    }
  }, [])

  const showToast = useCallback((msg: string, type = 'info') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 2500)
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
  const selectedDef: ComponentDef | null = selectedComponent ? componentCatalog[selectedComponent.component] as ComponentDef ?? null : null

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
      const sel = components.find(c => c.id === selectedId)!
      if (!sel.props.children) sel.props.children = []
      sel.props.children.push(id)
    }
    setComponents(prev => [...prev, newComp])
    setSelectedId(id)
  }

  function deleteComponent() {
    if (!selectedId || isColumnSelected) return
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

  function insertIntoTree(id: string, targetId: string, position: 'before' | 'after' | 'inside') {
    setComponents(prev => {
      const next = prev.map(c => ({ ...c, props: { ...c.props, children: c.props?.children ? [...c.props.children] : undefined } }))
      if (position === 'inside') {
        const target = next.find(c => c.id === targetId)!
        if (!target.props.children) target.props.children = []
        target.props.children.push(id)
      } else {
        const parentId = getParentId(next, targetId)
        if (parentId) {
          const parent = next.find(c => c.id === parentId)!
          const idx = parent.props.children.indexOf(targetId)
          if (position === 'before') parent.props.children.splice(idx, 0, id)
          else parent.props.children.splice(idx + 1, 0, id)
        }
      }
      return next
    })
  }

  // ===== 拖拽 =====
  function onPaletteDragStart(e: React.DragEvent, componentType: string) {
    setDragSource({ type: 'palette', componentType })
    e.dataTransfer.effectAllowed = 'copy'
  }

  function onTreeNodeDragStart(e: React.DragEvent, componentId: string) {
    setDragSource({ type: 'tree', componentId })
    e.dataTransfer.effectAllowed = 'move'
  }

  function onTreeNodeDragOver(e: React.DragEvent, targetId: string) {
    if (!dragSource) return
    if (dragSource.type === 'tree') {
      if (dragSource.componentId === targetId) return
      if (collectDescendants(compMap, dragSource.componentId).has(targetId)) return
    }
    e.preventDefault()
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const y = e.clientY - rect.top
    const h = rect.height
    let position: 'before' | 'after' | 'inside'
    if (y < h * 0.25) position = 'before'
    else if (y > h * 0.75) position = 'after'
    else if (canHaveChildren(compMap.get(targetId))) position = 'inside'
    else position = 'after'
    setDropIndicator({ targetId, position })
  }

  function onTreeNodeDrop(e: React.DragEvent, targetId: string) {
    e.preventDefault()
    e.stopPropagation()
    if (!dragSource || !dropIndicator) return
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
      setComponents(prev => [...prev, newComp])
      insertIntoTree(newId, targetId, dropIndicator.position)
      setSelectedId(newId)
    } else if (dragSource.type === 'tree') {
      const movedId = dragSource.componentId
      const oldParent = getParentId(components, movedId)
      setComponents(prev => {
        const next = prev.map(c => {
          if (c.id === oldParent && c.props?.children) {
            return { ...c, props: { ...c.props, children: c.props.children.filter((id: string) => id !== movedId) } }
          }
          return { ...c, props: { ...c.props } }
        })
        return next
      })
      insertIntoTree(movedId, targetId, dropIndicator.position)
    }
    setDragSource(null)
    setDropIndicator(null)
  }

  function onDragEnd() { setDragSource(null); setDropIndicator(null) }

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

  // ===== JSON 编辑器 =====
  const jsonCm = useCodeMirror('')
  const dmCm = useCodeMirror('')

  function openJsonDialog() {
    const output = {
      a2ui: [
        { beginRendering: { surfaceId: 'main', catalogId: 'basic' } },
        { surfaceUpdate: { surfaceId: 'main', components } },
        { dataModelUpdate: { surfaceId: 'main', data: initialDataModelRef.current } },
      ],
      logic: { reactions },
    }
    const text = JSON.stringify(output, null, 2)
    jsonCm.updateDoc(text)
    setShowJsonDialog(true)
    setTimeout(() => jsonCm.create(), 50)
  }

  function openDmDialog() {
    const text = JSON.stringify(JSON.parse(JSON.stringify(dataModel)), null, 2)
    dmCm.updateDoc(text)
    setShowDmDialog(true)
    setTimeout(() => dmCm.create(), 50)
  }

  function applyJsonEdit() {
    try {
      const data = JSON.parse(jsonCm.getDoc())
      loadJson(data)
      setShowJsonDialog(false)
      showToast('JSON 已应用', 'success')
    } catch { showToast('JSON 格式错误', 'error') }
  }

  function applyDmEdit() {
    try {
      const parsed = JSON.parse(dmCm.getDoc())
      setDataModel(parsed)
      setShowDmDialog(false)
      showToast('DataModel 已更新', 'success')
    } catch { showToast('JSON 格式错误', 'error') }
  }

  // ===== 导出 =====
  function exportJson() {
    const output = {
      a2ui: [
        { beginRendering: { surfaceId: 'main', catalogId: 'basic' } },
        { surfaceUpdate: { surfaceId: 'main', components } },
        { dataModelUpdate: { surfaceId: 'main', data: initialDataModelRef.current } },
      ],
      logic: { reactions },
    }
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

  // ===== Props 元数据 =====
  const selectedPropsMeta = useMemo(() => {
    if (!selectedDef) return []
    return Object.entries(selectedDef.props).map(([key, meta]) => ({ key, ...meta }))
  }, [selectedDef])

  // ===== 文件上传 =====
  function handleFileUploadClick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        loadJson(JSON.parse(reader.result as string))
        showToast('加载成功', 'success')
      } catch { showToast('解析失败', 'error') }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  // ===== 渲染 =====
  return (
    <div className="flex flex-1 min-h-0 overflow-hidden bg-gray-100" onDragOver={e => e.preventDefault()}>
      {toast && (
        <div className={`fixed top-5 right-5 px-4 py-2 rounded text-white z-50 ${
          toast.type === 'success' ? 'bg-green-500' : toast.type === 'error' ? 'bg-red-500' : toast.type === 'warning' ? 'bg-yellow-500' : 'bg-blue-500'
        }`}>{toast.msg}</div>
      )}

      {/* ===== 左侧 ===== */}
      <aside className="w-[280px] min-w-[280px] flex flex-col border-r bg-white shrink-0">
        <div className="p-3 border-b">
          <div className="text-sm font-semibold mb-2">组件面板</div>
          <Input
            value={paletteFilter}
            onChange={e => setPaletteFilter(e.target.value)}
            placeholder="搜索组件..."
            className="h-8 text-xs"
          />
          <div className="flex flex-wrap gap-1 mt-2 max-h-[180px] overflow-y-auto">
            {Object.entries(componentCatalog)
              .filter(([name]) => name.toLowerCase().includes(paletteFilter.toLowerCase()))
              .map(([name, def]) => (
                <div
                  key={name}
                  className="flex items-center gap-1 px-2 py-1 border rounded text-xs cursor-grab hover:border-blue-500 hover:bg-blue-50 active:cursor-grabbing"
                  draggable
                  onDragStart={e => onPaletteDragStart(e, name)}
                  onDragEnd={onDragEnd}
                >
                  <span className="font-medium">{name}</span>
                </div>
              ))}
          </div>
        </div>
        <div className="flex-1 flex flex-col min-h-0">
          <div className="text-sm font-semibold px-3 py-2 border-b flex justify-between">
            <span>DOM 树</span>
            <span className="text-xs text-gray-400">{components.length} 组件</span>
          </div>
          <div
            className="flex-1 overflow-y-auto py-1"
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
              <TreeNode
                key={root.id}
                nodeId={root.id}
                components={components}
                selectedId={selectedId}
                collapsedIds={collapsedIds}
                depth={0}
                dropIndicator={dropIndicator}
                onSelect={setSelectedId}
                onToggleCollapse={id => {
                  setCollapsedIds(prev => {
                    const next = new Set(prev)
                    if (next.has(id)) next.delete(id)
                    else next.add(id)
                    return next
                  })
                }}
                onDragStart={onTreeNodeDragStart}
                onDragOver={onTreeNodeDragOver}
                onDragLeave={() => {}}
                onDrop={onTreeNodeDrop}
                onDragEnd={onDragEnd}
              />
            ))}
            {treeRoots.length === 0 && (
              <div className="p-4 text-center text-gray-400 text-xs">从上方拖拽组件到此处</div>
            )}
          </div>
        </div>
      </aside>

      {/* ===== 中间 ===== */}
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="flex gap-2 p-2 bg-white border-b shrink-0">
          <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>上传 JSON</Button>
          <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleFileUploadClick} />
          <Button size="sm" variant="outline" onClick={openJsonDialog}>显示 JSON</Button>
          <Button size="sm" variant="outline" onClick={openDmDialog}>DataModel</Button>
          <Button size="sm" variant="outline" onClick={exportJson}>复制 JSON</Button>
          <Button size="sm" variant="destructive" disabled={!selectedId || isColumnSelected} onClick={deleteComponent}>删除</Button>
        </div>
        <div className="flex-1 p-4 overflow-y-auto bg-gray-50">
          <div className="text-xs text-gray-400 mb-2 uppercase">实时渲染预览</div>
          {components.length > 0 ? (
            <div className="bg-white rounded-lg p-5 shadow-sm min-h-[200px]">
              <A2UIRenderer components={components} dataModel={dataModel} onEvent={handleRendererEvent} />
            </div>
          ) : (
            <div className="flex items-center justify-center h-[200px] bg-white rounded-lg shadow-sm text-gray-400 text-sm">
              从左侧拖拽组件到此处
            </div>
          )}
        </div>
      </main>

      {/* ===== 右侧 ===== */}
      <aside className="w-[320px] min-w-[320px] border-l bg-white shrink-0 overflow-y-auto">
        {/* 列编辑器 */}
        {isColumnSelected && selectedColumn ? (
          <>
            <div className="text-sm font-semibold px-3 py-2 border-b">列属性</div>
            <div className="p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 rounded">列: {selectedColumn.label || '(未命名)'}</span>
              </div>
              <div>
                <label className="text-xs text-gray-500">key</label>
                <Input className="h-8 text-xs mt-1" value={selectedColumn.key ?? ''} onChange={e => updateColumnField('key', e.target.value)} placeholder="字段名" />
              </div>
              <div>
                <label className="text-xs text-gray-500">label</label>
                <Input className="h-8 text-xs mt-1" value={selectedColumn.label ?? ''} onChange={e => updateColumnField('label', e.target.value)} placeholder="列标题" />
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
                  <label className="text-xs text-gray-500">
                    options <span className="text-gray-400">JSON Pointer 或 JSON 数组</span>
                  </label>
                  <Input
                    className="h-8 text-xs mt-1 font-mono"
                    value={typeof selectedColumn.cellProps?.options === 'string' ? selectedColumn.cellProps.options : JSON.stringify(selectedColumn.cellProps?.options || [])}
                    onChange={e => { updateColumnField('cellProps', { options: e.target.value }) }}
                    placeholder='例如: /data/statusOptions 或 [{"label":"..","value":".."}]'
                  />
                </div>
              )}
              <Button size="sm" variant="destructive" onClick={deleteColumn}>删除此列</Button>
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
                    <Input type="number" className="h-8 text-xs mt-1" value={selectedComponent.props[prop.key] ?? 0} onChange={e => updateProp(prop.key, Number(e.target.value))} />
                  ) : prop.enum ? (
                    <Select value={selectedComponent.props[prop.key] ?? ''} onValueChange={v => updateProp(prop.key, v)}>
                      <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {prop.enum.map((opt: string) => <SelectItem key={opt} value={opt}>{opt}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input className="h-8 text-xs mt-1" value={selectedComponent.props[prop.key] ?? ''} onChange={e => updateProp(prop.key, e.target.value)} />
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
            <Button variant="outline" onClick={() => { setShowJsonDialog(false); jsonCm.destroy() }}>取消</Button>
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
            <Button variant="outline" onClick={() => { setShowDmDialog(false); dmCm.destroy() }}>取消</Button>
            <Button onClick={applyDmEdit}>确定</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 自定义 CSS */}
      <style>{`
        .tree-row {
          display: flex; align-items: center; gap: 4px; padding: 3px 8px; margin: 1px 4px;
          border: 1.5px solid transparent; border-radius: 3px; cursor: pointer; font-size: 12px;
          position: relative; transition: background 0.1s;
        }
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
        .drop-indicator { position: absolute; top: -2px; left: 4px; right: 4px; height: 2px; background: #1890ff; border-radius: 1px; z-index: 10; pointer-events: none; }
        .drop-indicator-inside { position: absolute; inset: 0; border: 2px solid #1890ff; border-radius: 3px; background: rgba(24,144,255,0.08); z-index: 10; pointer-events: none; }
      `}</style>
    </div>
  )
}
