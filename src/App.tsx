/**
 * App.tsx — 应用入口
 *
 * 【两种模式】均使用官方 @a2ui 渲染管线
 * - 页面调试器 (debugger): 三栏布局，编辑组件树 → syncToSurface → A2uiSurface 渲染
 * - 渲染预览 (preview):   Agent 控制面板 + A2uiSurface 渲染
 *
 * 【统一数据流】
 * Agent/JSON → a2ui.load() → MessageProcessor → SurfaceModel → A2uiSurface
 *                                                    ↓
 *                           ReactionEngine ← DataModel(Signals)
 *                                                    ↓
 *                      组件通过 useSyncExternalStore 订阅变更 → 自动重渲染
 */

import { useState, useRef, useEffect, useCallback, Component } from 'react'
import { ReactionEngine } from '@/runtime/reaction-engine'
import { PipeEngine } from '@/runtime/pipe-engine'
import { createMockApiExecutor } from '@/mock/api'
import { A2UIProvider, useA2UI } from '@/runtime/a2ui-context'
import { createA2UICatalog } from '@/runtime/a2ui-catalog'
import { normalizeToPages } from '@/runtime/a2ui-adapter'
import { PageProvider, usePageContext } from '@/runtime/page-context'
import { useSharedStore } from '@/runtime/shared-store'
import { A2uiSurface } from '@a2ui/react/v0_9'
import { Debugger } from '@/views/Debugger'
import { PageSelector } from '@/views/PageSelector'
import { generatePage, generatePageWithExample, type AgentConfig } from '@/agent/agent-client'
import demoData from '@/demo.json'
import { Toast } from '@/components/Toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'

const defaultKeys: Record<string, string> = {
  gemini: import.meta.env.VITE_GEMINI_API_KEY ?? '',
  deepseek: import.meta.env.VITE_DEEPSEEK_API_KEY ?? '',
}

export default function App() {
  const [mode, setMode] = useState<'debugger' | 'preview'>('debugger')

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      <div className="flex gap-0 bg-white border-b px-2 shrink-0">
        <button
          className={`px-4 py-2 text-sm transition-colors ${mode === 'debugger' ? 'bg-blue-500 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
          onClick={() => setMode('debugger')}
        >
          页面调试器
        </button>
        <button
          className={`px-4 py-2 text-sm transition-colors ${mode === 'preview' ? 'bg-blue-500 text-white' : 'text-gray-600 hover:bg-gray-100'}`}
          onClick={() => setMode('preview')}
        >
          渲染预览
        </button>
      </div>

      {mode === 'debugger' ? (
        <A2UIProvider catalog={catalog}>
          <Debugger />
        </A2UIProvider>
      ) : (
        <Preview />
      )}
    </div>
  )
}

/**
 * 预览模式内部组件（在 A2UIProvider 内）
 *
 * 多页面数据流:
 *   JSON → normalizeToPages() → PageProvider
 *     → shared data → useSharedStore().hydrate()
 *     → 首页 a2ui → a2ui.load(page.a2ui, { pageId })
 *     → PageProvider 管理 currentPageId
 *     → 渲染区根据 currentPageId 显示对应 A2uiSurface
 */
function PreviewInner() {
  const a2ui = useA2UI()
  const engineRef = useRef<ReactionEngine | null>(null)
  const pipeEngineRef = useRef(new PipeEngine({}))
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)

  // 注册 toast 处理器到 A2UI context，供 Dialog 等子组件使用
  useEffect(() => {
    a2ui.setToastHandler((msg, type = 'info') => setToast({ msg, type }))
    return () => a2ui.setToastHandler(console.error)
  }, [a2ui.setToastHandler])

  // 归一化后的多页面数据（null 表示未加载）
  const [appData, setAppData] = useState<ReturnType<typeof normalizeToPages> | null>(null)

  // Agent state
  const [provider, setProvider] = useState<AgentConfig['provider']>('mock')
  const [apiKey, setApiKey] = useState('')
  const [requirement, setRequirement] = useState('')
  const [useFullPrompt, setUseFullPrompt] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState('')
  const [showConfig, setShowConfig] = useState(true)

  function initFromData(data: any) {
    const normalized = normalizeToPages(data)
    setAppData(normalized)
  }

  // 初始加载：默认展示 demo.json
  useEffect(() => {
    initFromData(demoData)
  }, [])

  // Agent 生成
  async function doGenerate() {
    if (!requirement.trim() && provider === 'mock') {
      initFromData(demoData)
      return
    }
    if (!requirement.trim()) {
      setGenError('请输入页面需求描述')
      return
    }

    setGenerating(true)
    setGenError('')

    try {
      const config: AgentConfig = {
        provider,
        apiKey: provider !== 'mock' ? apiKey || undefined : undefined,
      }
      const result = useFullPrompt
        ? await generatePageWithExample(requirement, config)
        : await generatePage(requirement, config)
      initFromData(result)
      setToast({ msg: '页面生成成功！', type: 'success' })
    } catch (err: any) {
      setGenError(err?.message || String(err))
      setToast({ msg: `生成失败: ${err?.message || '未知错误'}`, type: 'error' })
    } finally {
      setGenerating(false)
    }
  }

  // 文件上传
  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        initFromData(JSON.parse(reader.result as string))
        setToast({ msg: 'JSON 文件加载成功', type: 'success' })
      } catch { setToast({ msg: 'JSON 解析失败', type: 'error' }) }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  return (
    <div className="flex-1 flex overflow-hidden">
      <Toast toast={toast} onDone={() => setToast(null)} />

      {/* Agent 控制面板 */}
      <aside className="w-[320px] min-w-[320px] border-r bg-white flex flex-col shrink-0">
        <div className="flex items-center justify-between px-3 py-2 border-b cursor-pointer select-none"
          onClick={() => setShowConfig(!showConfig)}>
          <span className="text-sm font-semibold">Agent 控制面板</span>
          <span className="text-xs text-gray-400">{showConfig ? '▲' : '▼'}</span>
        </div>

        {showConfig && (
          <div className="p-3 space-y-3 overflow-y-auto flex-1">
            <div>
              <label className="text-xs text-gray-500">提供商</label>
              <Select value={provider} onValueChange={v => { setProvider(v as any); setApiKey(defaultKeys[v] ?? '') }}>
                <SelectTrigger className="h-8 text-xs mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="mock">Mock (无需 Key)</SelectItem>
                  <SelectItem value="gemini">Gemini (Google)</SelectItem>
                  <SelectItem value="deepseek">DeepSeek</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {provider !== 'mock' && (
              <div>
                <label className="text-xs text-gray-500">API Key</label>
                <Input type="password" className="h-8 text-xs mt-1" value={apiKey}
                  onChange={e => setApiKey(e.target.value)} placeholder={`输入 ${provider} API Key`} />
              </div>
            )}

            <div className="flex items-center gap-2">
              <Checkbox checked={useFullPrompt} onCheckedChange={v => setUseFullPrompt(!!v)} id="fullPrompt" />
              <label htmlFor="fullPrompt" className="text-xs text-gray-500 cursor-pointer">使用完整示例 Prompt</label>
            </div>

            <div>
              <label className="text-xs text-gray-500">需求描述</label>
              <textarea className="w-full h-20 text-xs mt-1 p-2 border rounded resize-y font-sans"
                value={requirement} onChange={e => setRequirement(e.target.value)}
                placeholder="例如：创建一个订单创建表单..." />
            </div>

            <div className="flex gap-2 flex-wrap">
              <Button size="sm" onClick={doGenerate} disabled={generating}>
                {generating ? '生成中...' : '生成页面'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
                上传 JSON
              </Button>
              <input ref={fileInputRef} type="file" accept=".json" className="hidden" onChange={handleFileUpload} />
            </div>

            {genError && (
              <div className="text-xs text-red-500 p-2 bg-red-50 border border-red-200 rounded">{genError}</div>
            )}

            <details className="text-xs">
              <summary className="cursor-pointer text-gray-500">Prompt 模板</summary>
              <div className="mt-1 space-y-1">
                <div className="p-1.5 bg-gray-50 rounded cursor-pointer hover:bg-blue-50"
                  onClick={() => setRequirement('创建一个订单表单：包含产品大类和产品子类下拉联动，选择大类后加载对应产品，选择产品后自动回填单价，输入数量后实时计算总价，点击提交时校验必填项。')}>
                  <span className="font-medium">订单表单</span>
                  <p className="text-gray-400 text-[11px] mt-0.5">大类联动 → 回填单价 → 计算总价 → 提交校验</p>
                </div>
                <div className="p-1.5 bg-gray-50 rounded cursor-pointer hover:bg-blue-50"
                  onClick={() => setRequirement('创建一个订单列表页面：用卡片容器包裹搜索栏和数据表格。页面加载时自动查询全部订单，搜索栏输入关键词后点击搜索可过滤。表格列展示订单号、产品、数量、单价、总价、状态、创建时间。')}>
                  <span className="font-medium">订单列表</span>
                  <p className="text-gray-400 text-[11px] mt-0.5">搜索 + DataTable + init 自动加载</p>
                </div>
              </div>
            </details>
          </div>
        )}
      </aside>

      {/* 渲染区 — 多页面支持 */}
      <main className="flex-1 overflow-auto p-6 bg-gray-50">
        {appData ? (
          <PageProvider data={appData}>
            <PageRenderer toast={toast} setToast={setToast} pipeEngine={pipeEngineRef.current}
              engineRef={engineRef} a2ui={a2ui} />
          </PageProvider>
        ) : (
          <div className="flex items-center justify-center h-full">
            <div className="text-center text-gray-400">
              <p className="text-lg mb-2">尚无页面</p>
              <p className="text-sm">在左侧控制面板中输入需求，点击「生成页面」开始</p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

/** 页面渲染区域（在 PageProvider 内部，可访问 usePageContext） */
function PageRenderer({
  toast, setToast, pipeEngine, engineRef, a2ui,
}: {
  toast: { msg: string; type: string } | null
  setToast: (t: { msg: string; type: string } | null) => void
  pipeEngine: PipeEngine
  engineRef: React.MutableRefObject<ReactionEngine | null>
  a2ui: ReturnType<typeof useA2UI>
}) {
  const { pages, currentPageId, navigateTo, pageIds } = usePageContext()
  const sharedStore = useSharedStore()
  const surfaceRef = useRef(a2ui.getSurface(''))

  // 跟踪当前 surface
  useEffect(() => {
    surfaceRef.current = currentPageId ? a2ui.getSurface(currentPageId) : null
  }, [currentPageId])

  // 页面切换时创建/重建 ReactionEngine
  useEffect(() => {
    if (!currentPageId || !pages[currentPageId]) return
    const page = pages[currentPageId]
    const surface = a2ui.getSurface(currentPageId)
    if (!surface) return

    engineRef.current?.destroy()
    pipeEngine.updateDataModel(surface.dataModel.get('/') ?? {})

    const engine = new ReactionEngine(surface.dataModel, page.logic.reactions ?? [], {
      apiExecutor: createMockApiExecutor(),
      pipeEngine,
      toast: (msg, type = 'info') => setToast({ msg, type }),
      sharedStore: useSharedStore,
      navigate: (targetPage, params) => {
        navigateTo(targetPage, params)
      },
    })
    engine.boot()
    engineRef.current = engine

    return () => engine.destroy()
  }, [currentPageId, pages, pipeEngine, setToast, navigateTo, sharedStore])

  // Wire click actions → ReactionEngine
  useEffect(() => {
    return a2ui.onAction((action: any) => {
      if (action.name === 'a2ui.click' && action.context?.reactionId) {
        const surface = a2ui.getSurface(currentPageId)
        if (action.context.clickData && surface) {
          // 统一取 payload（recharts 所有图形元素的原始数据都在 payload 中）
          surface.dataModel.set('/_event', action.context.clickData?.payload ?? action.context.clickData)
        }
        engineRef.current?.triggerReaction(action.context.reactionId)
      }
    })
  }, [currentPageId, a2ui.surface])

  const currentSurface = currentPageId ? a2ui.getSurface(currentPageId) : null

  return (
    <div className="max-w-3xl mx-auto space-y-3">
      <PageSelector pageIds={pageIds} currentPageId={currentPageId}
        onSelect={(pid) => navigateTo(pid)} />
      {currentSurface ? (
        <div className="bg-white rounded-lg p-6 shadow-sm">
          <ErrorBoundary>
            <A2uiSurface key={currentPageId} surface={currentSurface} />
          </ErrorBoundary>
        </div>
      ) : (
        <div className="flex items-center justify-center h-40 bg-white rounded-lg shadow-sm text-gray-400 text-sm">
          加载中...
        </div>
      )}
    </div>
  )
}

/**
 * 预览模式入口
 *
 * 层级结构：
 *   ErrorBoundary → A2UIProvider(持有 MessageProcessor + SurfaceModel) → PreviewInner
 *
 * catalog 在模块级别创建一次，避免每次渲染重建
 */
const catalog = createA2UICatalog()

/** React 错误边界：捕获 A2UI 渲染树中的异常，显示友好错误信息而非白屏 */
class ErrorBoundary extends Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) { return { error } }
  render() {
    if (this.state.error) {
      return (
        <div className="flex items-center justify-center h-full">
          <div className="text-center text-red-500 p-8">
            <p className="text-lg font-bold mb-2">渲染错误</p>
            <p className="text-sm font-mono">{this.state.error.message}</p>
            <pre className="text-xs mt-2 text-left max-h-60 overflow-auto">{this.state.error.stack}</pre>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

function Preview() {
  return (
    <ErrorBoundary>
      <A2UIProvider catalog={catalog}>
        <PreviewInner />
      </A2UIProvider>
    </ErrorBoundary>
  )
}
