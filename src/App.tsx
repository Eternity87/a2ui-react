import { useState, useRef, useEffect, useCallback } from 'react'
import { A2UIRenderer } from '@/runtime/a2ui-renderer'
import { DataModelStore, ReactionEngine } from '@/runtime/reaction-engine'
import { PipeEngine } from '@/runtime/pipe-engine'
import { createMockApiExecutor } from '@/mock/api'
import { Debugger } from '@/views/Debugger'
import { generatePage, generatePageWithExample, type AgentConfig } from '@/agent/agent-client'
import demoData from '@/demo.json'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'

const defaultKeys: Record<string, string> = {
  gemini: 'AIzaSyAbbmvC-NFN125RGv4Nba3bQoSRl1Cbcso',
  deepseek: 'sk-15f45580bc7f4adb9350013902f88ccd',
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

      {mode === 'debugger' ? <Debugger /> : <Preview />}
    </div>
  )
}

function Preview() {
  const storeRef = useRef<DataModelStore>(new DataModelStore({}))
  const engineRef = useRef<ReactionEngine | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [renderKey, setRenderKey] = useState(0)
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null)
  const [components, setComponents] = useState<any[]>([])
  const [reactions, setReactions] = useState<any[]>([])

  // Agent state
  const [provider, setProvider] = useState<AgentConfig['provider']>('mock')
  const [apiKey, setApiKey] = useState('')
  const [requirement, setRequirement] = useState('')
  const [useFullPrompt, setUseFullPrompt] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState('')
  const [showConfig, setShowConfig] = useState(true)

  function initFromData(data: any) {
    const store = storeRef.current
    const su = data.a2ui?.find((m: any) => 'surfaceUpdate' in m)
    const comps = su?.surfaceUpdate?.components ?? []
    const dm = data.a2ui?.find((m: any) => 'dataModelUpdate' in m)
    const reacts = data.logic?.reactions ?? []

    store.replaceAll(dm?.dataModelUpdate?.data ?? {})
    setComponents(comps)
    setReactions(reacts)

    engineRef.current?.destroy()
    const engine = new ReactionEngine(store, reacts, {
      apiExecutor: createMockApiExecutor(),
      pipeEngine: new PipeEngine(store.proxy),
      toast: (msg, type = 'info') => setToast({ msg, type }),
    })
    engine.boot()
    engineRef.current = engine
    setRenderKey(k => k + 1)
  }

  // 初始加载 demo
  useEffect(() => {
    initFromData(demoData)
    const unsub = storeRef.current.subscribeAll(() => setRenderKey(k => k + 1))
    return () => { unsub(); engineRef.current?.destroy() }
  }, [])

  const handleEvent = useCallback((event: string, payload: any) => {
    if (event === 'change' && payload.field) {
      storeRef.current.set(payload.field, payload.value)
      setRenderKey(k => k + 1)
    }
    if (event === 'click' && payload.reactionId) {
      engineRef.current?.triggerReaction(payload.reactionId)
      setTimeout(() => setRenderKey(k => k + 1), 100)
    }
  }, [])

  useEffect(() => {
    if (toast) { const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t) }
  }, [toast])

  // Agent 生成
  async function doGenerate() {
    if (!requirement.trim() && provider === 'mock') {
      // mock mode uses demo data directly
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

  const dataModel = storeRef.current.getRaw()

  return (
    <div className="flex-1 flex overflow-hidden">
      {toast && (
        <div className={`fixed top-5 right-5 px-4 py-2 rounded text-white z-50 ${
          toast.type === 'success' ? 'bg-green-500' : toast.type === 'error' ? 'bg-red-500' : toast.type === 'warning' ? 'bg-yellow-500' : 'bg-blue-500'
        }`}>{toast.msg}</div>
      )}

      {/* ===== Agent 控制面板 ===== */}
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

      {/* ===== 渲染区 ===== */}
      <main className="flex-1 overflow-auto p-6 bg-gray-50">
        {components.length > 0 ? (
          <div className="max-w-3xl mx-auto">
            <div className="bg-white rounded-lg p-6 shadow-sm">
              <A2UIRenderer key={renderKey} components={components} dataModel={dataModel} onEvent={handleEvent} />
            </div>
          </div>
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
