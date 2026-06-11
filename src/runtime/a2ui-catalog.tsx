/**
 * a2ui-catalog.tsx — A2UI 组件目录与实现
 *
 * 使用 createBinderlessComponentImplementation + 自定义 resolveProps。
 * 接收标准 DynamicValue 格式 JSON（{ path, call } / ${} 模板），
 * 通过 resolveProps 手动解析为实际值，useSyncExternalStore 实现响应式订阅。
 *
 * 组件列表：Text / Row / Card / TextField / Select / Button / DataTable
 */

import React, { useCallback, useSyncExternalStore, useEffect, useMemo, useRef, useState } from 'react'
import { createBinderlessComponentImplementation, type ReactComponentImplementation } from '@a2ui/react/v0_9'
import { Catalog } from '@a2ui/web_core/v0_9'
import type { ComponentContext } from '@a2ui/web_core/v0_9'
import { dmPath, getBindingPath, resolveProps, useDataModelSubscription } from './a2ui-utils'
import { useA2UI } from './a2ui-context'
import { ReactionEngine } from './reaction-engine'
import { PipeEngine } from './pipe-engine'
import { createMockApiExecutor, fetchPageSource } from '@/mock/api'
import { getChildPage } from './page-context'
import { useSharedStore } from './shared-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { A2uiSurface } from '@a2ui/react/v0_9'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog'

// ===== 类型 =====

/** A2uiSurface 传给每个 binderless 组件的原始 props */
type A2UIRenderProps = {
  context: ComponentContext
  buildChild: (id: string, basePath?: string) => React.ReactNode
}

/** createA2UIComponent 工厂注入给业务组件的元信息 */
export interface A2UIComponentMeta {
  surfaceId: string
  dataContext: ComponentContext['dataContext']
  buildChild: (id: string, basePath?: string) => React.ReactNode
  dispatchAction: (name: string, context?: Record<string, any>) => void
  rawProps: Record<string, any>
}

// ===== createA2UIComponent：组件工厂 =====

/**
 * 创建一个 A2UI 组件的便捷工厂
 *
 * 自动完成：
 * 1. resolveProps(raw, dm) — 解析 DynamicValue（{ path } / ${} 模板）
 * 2. useSyncExternalStore — 订阅 dataModel 变更，自动重渲染
 * 3. 注入 meta 信息（dataContext, buildChild, dispatchAction, rawProps）
 */
export function createA2UIComponent<P = Record<string, any>>(
  name: string,
  RenderComponent: React.FC<P & A2UIComponentMeta>,
) {
  return createBinderlessComponentImplementation(
    { name, schema: {} as any },
    ({ context, buildChild }: A2UIRenderProps) => {
      const dm = context.dataContext.dataModel
      const versionRef = useRef(0)

      const subscribe = useCallback(
        (cb: () => void) => {
          return dm.subscribe('/', () => {
            versionRef.current += 1
            cb()
          }).unsubscribe
        },
        [dm],
      )
      const getSnapshot = useCallback(() => versionRef.current, [])
      useSyncExternalStore(subscribe, getSnapshot)

      const rawProps = context.componentModel.properties
      const resolved = resolveProps(rawProps, dm)

      const meta: A2UIComponentMeta = {
        surfaceId: context.componentModel.id,
        dataContext: context.dataContext,
        buildChild,
        dispatchAction: (n, ctx) =>
          context.dispatchAction({ event: { name: n, context: ctx ?? {} } }),
        rawProps,
      }

      return <RenderComponent {...(resolved as any)} {...meta} />
    },
  )
}

// ===== 组件实现 =====

// Button variant 映射：A2UI 命名 → shadcn/ui 命名
const variantMap: Record<string, 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'> = {
  primary: 'default', secondary: 'secondary', danger: 'destructive',
}

const sizeTextMap: Record<string, string> = { xs: 'text-xs', sm: 'text-sm', base: 'text-base', lg: 'text-lg', xl: 'text-xl', '2xl': 'text-2xl' }

/** Text — 纯文本展示，支持 ${/xxx} 模板插值（由 resolveProps 处理） */
const TextImpl = createA2UIComponent<{ text?: string; size?: string; color?: string; bold?: boolean; italic?: boolean }>(
  'Text', ({ text, size, color, bold, italic }) => {
    const cls = [
      sizeTextMap[size ?? 'sm'] ?? 'text-sm',
      bold ? 'font-bold' : '',
      italic ? 'italic' : '',
      color && !color.startsWith('#') ? color : '',
    ].filter(Boolean).join(' ')
    const style = color && color.startsWith('#') ? { color } : undefined
    return <span className={cls} style={style}>{text}</span>
  },
)

/** Row — Flexbox 水平容器，递归渲染 children */
const RowImpl = createA2UIComponent<{ children?: string[]; gap?: number }>('Row', ({ children, gap, buildChild }) => (
  <div style={{ display: 'flex', gap: gap ?? 8, flexWrap: 'wrap' }}>
    {(children ?? []).map(id => buildChild(id))}
  </div>
))

/** Card — shadcn/ui Card 包装，支持 title 和 children */
const CardImpl = createA2UIComponent<{ title?: string; children?: string[] }>('Card', ({ title, children, buildChild }) => (
  <Card>
    {title && <CardHeader><CardTitle>{title}</CardTitle></CardHeader>}
    <CardContent className="flex flex-col gap-2">
      {(children ?? []).map(id => buildChild(id))}
    </CardContent>
  </Card>
))

/**
 * TextField — 文本/数字输入
 * value 是 resolveProps 解析后的实际值，rawProps.value 保留原始 { path } 对象用于 write-back
 */
const sizeInputMap: Record<string, string> = { sm: 'h-7 text-xs', default: 'h-9 text-sm', lg: 'h-11 text-base' }

const TextFieldImpl = createA2UIComponent<{
  label?: string; value?: any; placeholder?: string; type?: string; size?: string; width?: string
}>('TextField', ({ label, value, placeholder, type, size, width, rawProps, dataContext }) => {
  const isNumber = type === 'number'
  const valuePath = getBindingPath(rawProps.value)

  return (
    <div className="flex flex-col gap-1" style={width ? { width } : undefined}>
      {label && <label className="text-sm font-medium text-muted-foreground">{label as string}</label>}
      <Input
        type={isNumber ? 'number' : 'text'}
        value={value ?? ''}
        placeholder={placeholder as string | undefined}
        className={sizeInputMap[size ?? 'default'] ?? sizeInputMap.default}
        onChange={e => {
          const v = isNumber ? Number((e.target as HTMLInputElement).value) : (e.target as HTMLInputElement).value
          if (valuePath) dataContext.set(valuePath, v)
        }}
      />
    </div>
  )
})

/**
 * Select — 下拉选择
 * options 支持 DataBinding { path } 或静态数组；由 resolveProps 解析
 */
const SelectImpl = createA2UIComponent<{
  label?: string; value?: any; options?: any[]; placeholder?: string; size?: string; width?: string
}>('Select', ({ label, value, options, placeholder, size, width, rawProps, dataContext }) => {
  const valuePath = getBindingPath(rawProps.value)
  const opts: any[] = Array.isArray(options) ? options : []

  return (
    <div className="flex flex-col gap-1" style={width ? { width } : undefined}>
      {label && <label className="text-sm font-medium text-muted-foreground">{label as string}</label>}
      <Select
        value={(value as string) ?? ''}
        onValueChange={val => {
          if (valuePath) dataContext.set(valuePath, val)
        }}
      >
        <SelectTrigger className={sizeInputMap[size ?? 'default'] ?? sizeInputMap.default}>
          <SelectValue placeholder={placeholder as string | undefined} />
        </SelectTrigger>
        <SelectContent>
          {opts.map((opt: any) => (
            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
})

/**
 * Button — 触发 Reaction
 * 通过 dispatchAction('a2ui.click', { reactionId }) 发送动作
 */
const ButtonImpl = createA2UIComponent<{
  label?: string; variant?: string; disabled?: boolean; reactionId?: string
}>('Button', ({ label, variant, disabled, reactionId, dispatchAction }) => (
  <Button
    variant={variantMap[variant as string ?? ''] ?? 'default'}
    disabled={disabled as boolean | undefined}
    onClick={() => dispatchAction('a2ui.click', { reactionId })}
  >
    {label as string}
  </Button>
))

/**
 * DataTable — 可编辑数据表格
 *
 * 支持四种列类型（cellType）：text / input / number / select
 * value（行数据）由 resolveProps 解析；columns 由 JSON 静态定义
 */
const DataTableImpl = createBinderlessComponentImplementation(
  { name: 'DataTable', schema: {} as any },
  ({ context }: A2UIRenderProps) => {
    const dm = context.dataContext.dataModel
    useDataModelSubscription(dm)

    const rawProps = context.componentModel.properties
    const props = resolveProps(rawProps, dm)
    const columns: any[] = props.columns ?? []
    const rows: any[] = Array.isArray(props.value) ? props.value : []
    const rawValuePath = getBindingPath(rawProps.value)

    const renderCell = (col: any, scope: { row: any; rowIndex: number }) => {
      const cellValue = scope.row[col.key]
      const cellPath = rawValuePath
        ? `${rawValuePath}/${scope.rowIndex}/${col.key}`
        : ''
      const cellType = col.cellType || 'text'

      switch (cellType) {
        case 'input':
          return (
            <Input className="h-8 text-xs" value={cellValue ?? ''}
              onChange={e => context.dataContext.set(cellPath, (e.target as HTMLInputElement).value)} />
          )
        case 'number':
          return (
            <Input type="number" className="h-8 text-xs" value={cellValue ?? ''}
              onChange={e => context.dataContext.set(cellPath, Number((e.target as HTMLInputElement).value))} />
          )
        case 'select': {
          let options = col.cellProps?.options ?? []
          if (typeof options === 'string') {
            try { options = JSON.parse(options) } catch { options = [] }
          }
          return (
            <Select value={cellValue ?? ''} onValueChange={val => context.dataContext.set(cellPath, val)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {options.map((opt: any) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
        }
        default:
          return <span>{String(cellValue ?? '')}</span>
      }
    }

    return (
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col: any) => (
              <TableHead key={col.key} style={{ width: col.width }}>{col.label || col.key}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-muted-foreground">
                {props.emptyText || '暂无数据'}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row: any, rowIndex: number) => (
              <TableRow key={row.id ?? rowIndex}>
                {columns.map((col: any) => (
                  <TableCell key={col.key}>{renderCell(col, { row, rowIndex })}</TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    )
  },
)

// ===== Dialog 组件（独立子 Surface 弹窗） =====

const DialogImpl = createBinderlessComponentImplementation(
  { name: 'Dialog', schema: {} as any },
  ({ context }: A2UIRenderProps) => {
    const dm = context.dataContext.dataModel
    useDataModelSubscription(dm)

    const rawProps = context.componentModel.properties
    const props = resolveProps(rawProps, dm)
    const open: boolean = props.open ?? false
    const title: string | undefined = props.title
    const source: string = props.source ?? ''
    const width: string = props.width ?? 'max-w-lg'

    const a2ui = useA2UI()
    const { getSurface, load, destroySurface, currentSurfaceId } = a2ui
    const parentDataModel = dm

    // 用 ref 存储 context 函数引用，避免 effect 因 context 值变化而重复触发
    const getSurfaceRef = useRef(getSurface)
    getSurfaceRef.current = getSurface
    const loadRef = useRef(load)
    loadRef.current = load
    const destroySurfaceRef = useRef(destroySurface)
    destroySurfaceRef.current = destroySurface
    const currentSurfaceIdRef = useRef(currentSurfaceId)
    currentSurfaceIdRef.current = currentSurfaceId

    const [instanceId] = useState(() =>
      `dlg_${source.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`)
    const engineRef = useRef<ReactionEngine | null>(null)
    const [loaded, setLoaded] = useState(false)
    const remoteReactionsRef = useRef<any[]>([])

    // open 变为 true → 加载子 surface
    useEffect(() => {
      if (!open || loaded) return
      const loadChild = async () => {
        try {
          let childA2ui: any[]
          const sid = currentSurfaceIdRef.current
          if (source.startsWith('/') || source.startsWith('http')) {
            const pageData = await fetchPageSource(source)
            if (!pageData) { setLoaded(true); return }
            childA2ui = pageData.a2ui ?? []
            remoteReactionsRef.current = pageData.logic?.reactions ?? []
          } else {
            // 尝试多种 pageId 查找（兼容 page_ 前缀有无的情况）
            let child = getChildPage(sid, source)
            if (!child && sid.startsWith('page_')) {
              child = getChildPage(sid.replace('page_', ''), source)
            }
            if (!child) {
              child = getChildPage(`page_${sid}`, source)
            }
            if (!child) {
              console.warn(`[Dialog] Child page "${source}" not found in registry for surface "${sid}"`)
              setLoaded(true)
              return
            }
            childA2ui = child.a2ui
            remoteReactionsRef.current = child.logic?.reactions ?? []
          }
          // 确保第一条消息是 beginRendering（本地 children 定义中可能省略）
          if (childA2ui.length > 0 && !('beginRendering' in childA2ui[0])) {
            childA2ui = [{ beginRendering: { surfaceId: 'main', catalogId: 'basic' } }, ...childA2ui]
          }
          loadRef.current(childA2ui, { pageId: instanceId })
          setLoaded(true)
        } catch (err: any) {
          console.error('[Dialog] Failed to load child page:', err?.message || err)
          setLoaded(true)
        }
      }
      loadChild()
    }, [open, loaded, source, instanceId])

    // open 变为 false → 清理子 surface
    useEffect(() => {
      if (open || !loaded) return
      engineRef.current?.destroy()
      engineRef.current = null
      remoteReactionsRef.current = []
      destroySurfaceRef.current(instanceId)
      setLoaded(false)
    }, [open, loaded, instanceId])

    // 子 surface 创建后 → 创建 ReactionEngine
    useEffect(() => {
      if (!loaded || !open) return
      const surface = getSurfaceRef.current(instanceId)
      if (!surface) return

      const reactions = remoteReactionsRef.current
      if (reactions.length === 0) return

      engineRef.current?.destroy()
      const engine = new ReactionEngine(surface.dataModel, reactions, {
        apiExecutor: createMockApiExecutor(),
        pipeEngine: new PipeEngine({}),
        toast: a2ui.toast,
        sharedStore: useSharedStore,
        parentDataModel,
      })
      engine.boot()
      engineRef.current = engine

      // 子 surface 的 click 事件 → engine.triggerReaction
      const actionSub = surface.onAction.subscribe((action: any) => {
        if (action.name === 'a2ui.click' && action.context?.reactionId) {
          engine.triggerReaction(action.context.reactionId)
        }
      })

      return () => {
        actionSub.unsubscribe()
        engine.destroy()
        engineRef.current = null
      }
    }, [loaded, open, instanceId])

    const childSurface = instanceId ? getSurface(instanceId) : null

    return (
      <Dialog open={open} onOpenChange={(o) => {
        if (!o) { context.dataContext.set(dmPath(rawProps.open?.path ?? '/dialogOpen'), false) }
      }}>
        <DialogContent className={width} aria-describedby={undefined}>
          {title && (
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
          )}
          {childSurface ? (
            <A2uiSurface key={instanceId} surface={childSurface} />
          ) : (
            <div className="py-8 text-center text-gray-400 text-sm">加载中...</div>
          )}
        </DialogContent>
      </Dialog>
    )
  },
)

// ===== 创建 Catalog =====

/** 创建包含所有组件实现的 Catalog，供 A2UIProvider 使用 */
export function createA2UICatalog(): Catalog<ReactComponentImplementation> {
  const components = [
    TextImpl, RowImpl, CardImpl, TextFieldImpl, SelectImpl, ButtonImpl, DataTableImpl, DialogImpl,
  ]
  return new Catalog('basic', components)
}
