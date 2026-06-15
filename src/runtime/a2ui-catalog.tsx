/**
 * a2ui-catalog.tsx — A2UI 组件目录与实现
 *
 * 使用 createBinderlessComponentImplementation + 自定义 resolveProps。
 * 接收标准 DynamicValue 格式 JSON（{ path, call } / ${} 模板），
 * 通过 resolveProps 手动解析为实际值，useSyncExternalStore 实现响应式订阅。
 *
 * 组件列表：Text / Row / Card / TextField / Select / Button / DataTable / Dialog / BarChart / LineChart / PieChart / AreaChart / ComposedChart / ScatterChart / RadarChart / RadialBarChart
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
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  AreaChart, Area, ComposedChart, ScatterChart, Scatter,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis,
  RadialBarChart, RadialBar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, ReferenceLine, LabelList,
} from 'recharts'

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
const CardImpl = createA2UIComponent<{ title?: string; children?: string[]; width?: any }>('Card', ({ title, children, width, buildChild }) => (
  <div style={{ width: cssWidth(width) }}>
    <Card>
      {title && <CardHeader><CardTitle>{title}</CardTitle></CardHeader>}
      <CardContent className="flex flex-col gap-2">
        {(children ?? []).map(id => buildChild(id))}
      </CardContent>
    </Card>
  </div>
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

// ===== Chart 图表组件 =====

const DEFAULT_FONT = "Inter, system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif"

/** 将 width prop 转为 CSS 可用值：纯数字补 px，字符串原样使用 */
function cssWidth(w: any): string {
  if (w === undefined || w === null) return '100%'
  if (typeof w === 'number') return `${w}px`
  return String(w)
}

const BarChartImpl = createA2UIComponent<{
  data?: any[]; xField?: string; yField?: string; title?: string; height?: number; width?: any; color?: string
  showLegend?: boolean; showTooltip?: boolean; showGrid?: boolean; showDataLabel?: boolean
  layout?: string; barSize?: number
  referenceValue?: number; referenceLabel?: string; referenceColor?: string
  targetValue?: number; colorAbove?: string; colorBelow?: string
  fontSize?: number; fontFamily?: string; chartMargin?: number; xTickAngle?: number
}>('BarChart', ({ data, xField, yField, title, height, width, color, showLegend, showTooltip, showGrid, showDataLabel, layout, barSize, referenceValue, referenceLabel, referenceColor, targetValue, colorAbove, colorBelow, fontSize, fontFamily, chartMargin, xTickAngle, reactionId, dispatchAction }) => {
  const chartData = Array.isArray(data) ? data : []
  const isVertical = layout === 'vertical'
  const hasCondition = targetValue !== undefined && targetValue !== null
  const fs = fontSize ?? 13
  const ff = fontFamily ?? DEFAULT_FONT
  const m = chartMargin ?? 16
  return (
    <div style={{ width: cssWidth(width), fontFamily: ff, fontSize: fs }}>
      {title && <div className="text-sm font-medium mb-2">{title}</div>}
      <ResponsiveContainer width="100%" height={height ?? 300}>
        <BarChart data={chartData} layout={isVertical ? 'vertical' : 'horizontal'} margin={{ top: m, right: m, bottom: m, left: m }}>
          {(showGrid ?? true) && <CartesianGrid strokeDasharray="3 3" />}
          {isVertical ? <YAxis type="category" dataKey={xField} tick={{ fontSize: fs }} /> : <XAxis dataKey={xField} tick={{ fontSize: fs, angle: xTickAngle ?? 0 }} />}
          {isVertical ? <XAxis type="number" tick={{ fontSize: fs }} /> : <YAxis tick={{ fontSize: fs }} />}
          {(showTooltip ?? true) && <Tooltip contentStyle={{ fontSize: fs }} />}
          {(showLegend ?? true) && <Legend wrapperStyle={{ fontSize: fs }} />}
          {referenceValue !== undefined && (
            <ReferenceLine y={referenceValue} stroke={referenceColor ?? '#ff4d4f'} strokeDasharray="4 4" label={referenceLabel} />
          )}
          <Bar dataKey={yField} barSize={barSize}
            onClick={reactionId ? (d: any) => dispatchAction('a2ui.click', { reactionId, clickData: d }) : undefined}>
            {hasCondition
              ? chartData.map((item, i) => {
                  const val = Number(item[yField ?? ''])
                  const cellColor = val >= (targetValue ?? 0) ? (colorAbove ?? '#52c41a') : (colorBelow ?? '#ff4d4f')
                  return <Cell key={i} fill={cellColor} />
                })
              : <Cell fill={color ?? '#1890ff'} />}
            {(showDataLabel ?? false) && <LabelList dataKey={yField} position={isVertical ? 'right' : 'top'} />}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
})

const LineChartImpl = createA2UIComponent<{
  data?: any[]; xField?: string; yField?: string; title?: string; height?: number; width?: any; color?: string
  showLegend?: boolean; showTooltip?: boolean; showGrid?: boolean; showDataLabel?: boolean
  showDot?: boolean; strokeWidth?: number; curveType?: string
  referenceValue?: number; referenceLabel?: string; referenceColor?: string
  fontSize?: number; fontFamily?: string; chartMargin?: number; xTickAngle?: number
  targetValue?: number; colorAbove?: string; colorBelow?: string
}>('LineChart', ({ data, xField, yField, title, height, width, color, showLegend, showTooltip, showGrid, showDataLabel, showDot, strokeWidth, curveType, referenceValue, referenceLabel, referenceColor, fontSize, fontFamily, chartMargin, xTickAngle, targetValue, colorAbove, colorBelow, reactionId, dispatchAction }) => {
  const chartData = Array.isArray(data) ? data : []
  const fs = fontSize ?? 13
  const ff = fontFamily ?? DEFAULT_FONT
  const m = chartMargin ?? 16
  const lastVal = chartData.length > 0 ? Number(chartData[chartData.length - 1][yField ?? '']) : 0
  const lineColor = targetValue !== undefined && targetValue !== null
    ? (lastVal >= targetValue ? (colorAbove ?? '#52c41a') : (colorBelow ?? '#ff4d4f'))
    : (color ?? '#1890ff')
  return (
    <div style={{ width: cssWidth(width), fontFamily: ff, fontSize: fs }}>
      {title && <div className="text-sm font-medium mb-2">{title}</div>}
      <ResponsiveContainer width="100%" height={height ?? 300}>
        <LineChart data={chartData} margin={{ top: m, right: m, bottom: m, left: m }}>
          {(showGrid ?? true) && <CartesianGrid strokeDasharray="3 3" />}
          <XAxis dataKey={xField} tick={{ fontSize: fs, angle: xTickAngle ?? 0 }} />
          <YAxis tick={{ fontSize: fs }} />
          {(showTooltip ?? true) && <Tooltip contentStyle={{ fontSize: fs }} />}
          {(showLegend ?? true) && <Legend wrapperStyle={{ fontSize: fs }} />}
          {referenceValue !== undefined && (
            <ReferenceLine y={referenceValue} stroke={referenceColor ?? '#ff4d4f'} strokeDasharray="4 4" label={referenceLabel} />
          )}
          <Line type={(curveType as any) ?? 'monotone'} dataKey={yField} stroke={lineColor} strokeWidth={strokeWidth ?? 2} dot={showDot ?? true}
            label={(showDataLabel ?? false) ? { position: 'top' } : undefined}
            onClick={reactionId ? (d: any) => dispatchAction('a2ui.click', { reactionId, clickData: d }) : undefined} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
})

const PieChartImpl = createA2UIComponent<{
  data?: any[]; labelField?: string; valueField?: string; title?: string; height?: number; width?: any; colors?: string
  showLegend?: boolean; showTooltip?: boolean; showLabel?: boolean
  innerRadius?: number; outerRadius?: number; labelFormat?: string
  targetValue?: number; colorAbove?: string; colorBelow?: string
  fontSize?: number; fontFamily?: string; chartMargin?: number
  labelPosition?: string; labelOffset?: number
}>('PieChart', ({ data, labelField, valueField, title, height, width, colors, showLegend, showTooltip, showLabel, innerRadius, outerRadius, labelFormat, targetValue, colorAbove, colorBelow, fontSize, fontFamily, chartMargin, labelPosition, labelOffset, reactionId, dispatchAction }) => {
  const chartData = Array.isArray(data) ? data : []
  const colorArr = (colors ?? '#1890ff,#52c41a,#faad14,#f5222d,#722ed1').split(',').map(c => c.trim())
  const hasCondition = targetValue !== undefined && targetValue !== null
  const fs = fontSize ?? 13
  const ff = fontFamily ?? DEFAULT_FONT
  const m = chartMargin ?? 16
  const isOutside = (labelPosition ?? 'outside') === 'outside'
  const fmt = labelFormat ?? 'name'
  const labelFn = !(showLabel ?? true) ? false : (entry: any) => {
    switch (fmt) {
      case 'value': return entry.value
      case 'percent': return `${(entry.percent * 100).toFixed(0)}%`
      case 'nameValue': return `${entry.name}: ${entry.value}`
      case 'namePercent': return `${entry.name}: ${(entry.percent * 100).toFixed(0)}%`
      default: return entry.name
    }
  }
  return (
    <div style={{ width: cssWidth(width), fontFamily: ff, fontSize: fs }}>
      {title && <div className="text-sm font-medium mb-2">{title}</div>}
      <ResponsiveContainer width="100%" height={height ?? 300}>
        <PieChart margin={{ top: m, right: m, bottom: m, left: m }}>
          <Pie data={chartData} dataKey={valueField} nameKey={labelField} cx="50%" cy="50%"
            innerRadius={innerRadius ?? 0} outerRadius={outerRadius ?? 80}
            label={labelFn as any}
            labelLine={isOutside}
            onClick={reactionId ? (d: any) => dispatchAction('a2ui.click', { reactionId, clickData: d }) : undefined}>
            {chartData.map((item, i) => {
              if (hasCondition) {
                const val = Number(item[valueField ?? ''])
                const c = val >= (targetValue ?? 0) ? (colorAbove ?? '#52c41a') : (colorBelow ?? '#ff4d4f')
                return <Cell key={i} fill={c} />
              }
              return <Cell key={i} fill={colorArr[i % colorArr.length]} />
            })}
          </Pie>
          {(showTooltip ?? true) && <Tooltip contentStyle={{ fontSize: fs }} />}
          {(showLegend ?? true) && <Legend wrapperStyle={{ fontSize: fs }} />}
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
})

const AreaChartImpl = createA2UIComponent<{
  data?: any[]; xField?: string; yField?: string; title?: string; height?: number; width?: any; color?: string
  showLegend?: boolean; showTooltip?: boolean; showGrid?: boolean; showDataLabel?: boolean
  strokeWidth?: number; fillOpacity?: number; curveType?: string
  referenceValue?: number; referenceLabel?: string; referenceColor?: string
  fontSize?: number; fontFamily?: string; chartMargin?: number; xTickAngle?: number
  targetValue?: number; colorAbove?: string; colorBelow?: string
}>('AreaChart', ({ data, xField, yField, title, height, width, color, showLegend, showTooltip, showGrid, showDataLabel, strokeWidth, fillOpacity, curveType, referenceValue, referenceLabel, referenceColor, fontSize, fontFamily, chartMargin, xTickAngle, targetValue, colorAbove, colorBelow }) => {
  const chartData = Array.isArray(data) ? data : []
  const fs = fontSize ?? 13
  const ff = fontFamily ?? DEFAULT_FONT
  const m = chartMargin ?? 16
  const lastVal = chartData.length > 0 ? Number(chartData[chartData.length - 1][yField ?? '']) : 0
  const areaColor = targetValue !== undefined && targetValue !== null
    ? (lastVal >= targetValue ? (colorAbove ?? '#52c41a') : (colorBelow ?? '#ff4d4f'))
    : (color ?? '#1890ff')
  return (
    <div style={{ width: cssWidth(width), fontFamily: ff, fontSize: fs }}>
      {title && <div className="text-sm font-medium mb-2">{title}</div>}
      <ResponsiveContainer width="100%" height={height ?? 300}>
        <AreaChart data={chartData} margin={{ top: m, right: m, bottom: m, left: m }}>
          {(showGrid ?? true) && <CartesianGrid strokeDasharray="3 3" />}
          <XAxis dataKey={xField} tick={{ fontSize: fs, angle: xTickAngle ?? 0 }} />
          <YAxis tick={{ fontSize: fs }} />
          {(showTooltip ?? true) && <Tooltip contentStyle={{ fontSize: fs }} />}
          {(showLegend ?? true) && <Legend wrapperStyle={{ fontSize: fs }} />}
          {referenceValue !== undefined && (
            <ReferenceLine y={referenceValue} stroke={referenceColor ?? '#ff4d4f'} strokeDasharray="4 4" label={referenceLabel} />
          )}
          <Area type={(curveType as any) ?? 'monotone'} dataKey={yField} stroke={areaColor} fill={areaColor} strokeWidth={strokeWidth ?? 2} fillOpacity={fillOpacity ?? 0.3}
            label={(showDataLabel ?? false) ? { position: 'top' } : undefined} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
})

const ComposedChartImpl = createA2UIComponent<{
  data?: any[]; xField?: string; yField?: string; yField2?: string; title?: string
  height?: number; width?: any; color?: string; color2?: string
  showLegend?: boolean; showTooltip?: boolean; showGrid?: boolean; showDataLabel?: boolean
  referenceValue?: number; referenceLabel?: string; referenceColor?: string
  fontSize?: number; fontFamily?: string; chartMargin?: number; xTickAngle?: number
  targetValue?: number; colorAbove?: string; colorBelow?: string
}>('ComposedChart', ({ data, xField, yField, yField2, title, height, width, color, color2, showLegend, showTooltip, showGrid, showDataLabel, referenceValue, referenceLabel, referenceColor, fontSize, fontFamily, chartMargin, xTickAngle, targetValue, colorAbove, colorBelow }) => {
  const chartData = Array.isArray(data) ? data : []
  const fs = fontSize ?? 13
  const ff = fontFamily ?? DEFAULT_FONT
  const m = chartMargin ?? 16
  const lastVal = chartData.length > 0 ? Number(chartData[chartData.length - 1][yField ?? '']) : 0
  const condColor = targetValue !== undefined && targetValue !== null
    ? (lastVal >= targetValue ? (colorAbove ?? '#52c41a') : (colorBelow ?? '#ff4d4f'))
    : null
  const barColor = condColor ?? (color ?? '#1890ff')
  const lineColor2 = condColor ?? (color2 ?? '#52c41a')
  return (
    <div style={{ width: cssWidth(width), fontFamily: ff, fontSize: fs }}>
      {title && <div className="text-sm font-medium mb-2">{title}</div>}
      <ResponsiveContainer width="100%" height={height ?? 300}>
        <ComposedChart data={chartData} margin={{ top: m, right: m, bottom: m, left: m }}>
          {(showGrid ?? true) && <CartesianGrid strokeDasharray="3 3" />}
          <XAxis dataKey={xField} tick={{ fontSize: fs, angle: xTickAngle ?? 0 }} />
          <YAxis yAxisId="left" tick={{ fontSize: fs }} />
          {yField2 && <YAxis yAxisId="right" orientation="right" tick={{ fontSize: fs }} />}
          {(showTooltip ?? true) && <Tooltip contentStyle={{ fontSize: fs }} />}
          {(showLegend ?? true) && <Legend wrapperStyle={{ fontSize: fs }} />}
          {referenceValue !== undefined && (
            <ReferenceLine y={referenceValue} stroke={referenceColor ?? '#ff4d4f'} strokeDasharray="4 4" label={referenceLabel} yAxisId="left" />
          )}
          <Bar yAxisId="left" dataKey={yField ?? ''} fill={barColor}>
            {(showDataLabel ?? false) && <LabelList dataKey={yField} position="top" />}
          </Bar>
          {yField2 && <Line yAxisId="right" type="monotone" dataKey={yField2} stroke={lineColor2} strokeWidth={2}
            label={(showDataLabel ?? false) ? { position: 'top' } : undefined} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
})

const ScatterChartImpl = createA2UIComponent<{
  data?: any[]; xField?: string; yField?: string; title?: string
  height?: number; width?: any; color?: string
  showLegend?: boolean; showTooltip?: boolean; showGrid?: boolean; showDataLabel?: boolean
  referenceValue?: number; referenceLabel?: string; referenceColor?: string
  fontSize?: number; fontFamily?: string; chartMargin?: number; xTickAngle?: number
  targetValue?: number; colorAbove?: string; colorBelow?: string
}>('ScatterChart', ({ data, xField, yField, title, height, width, color, showLegend, showTooltip, showGrid, showDataLabel, referenceValue, referenceLabel, referenceColor, fontSize, fontFamily, chartMargin, xTickAngle, targetValue, colorAbove, colorBelow, reactionId, dispatchAction }) => {
  const chartData = Array.isArray(data) ? data : []
  const fs = fontSize ?? 13
  const ff = fontFamily ?? DEFAULT_FONT
  const m = chartMargin ?? 16
  const hasCond = targetValue !== undefined && targetValue !== null
  const aboveC = colorAbove ?? '#52c41a'
  const belowC = colorBelow ?? '#ff4d4f'
  return (
    <div style={{ width: cssWidth(width), fontFamily: ff, fontSize: fs }}>
      {title && <div className="text-sm font-medium mb-2">{title}</div>}
      <ResponsiveContainer width="100%" height={height ?? 300}>
        <ScatterChart margin={{ top: m, right: m, bottom: m, left: m }}>
          {(showGrid ?? true) && <CartesianGrid strokeDasharray="3 3" />}
          <XAxis dataKey={xField} tick={{ fontSize: fs, angle: xTickAngle ?? 0 }} />
          <YAxis dataKey={yField} tick={{ fontSize: fs }} />
          {(showTooltip ?? true) && <Tooltip contentStyle={{ fontSize: fs }} />}
          {(showLegend ?? true) && <Legend wrapperStyle={{ fontSize: fs }} />}
          {referenceValue !== undefined && (
            <ReferenceLine y={referenceValue} stroke={referenceColor ?? '#ff4d4f'} strokeDasharray="4 4" label={referenceLabel} />
          )}
          <Scatter data={chartData} fill={color ?? '#1890ff'}
            label={(showDataLabel ?? false) ? { dataKey: yField } : undefined}
            onClick={reactionId ? (d: any) => dispatchAction('a2ui.click', { reactionId, clickData: d }) : undefined}>
            {hasCond && chartData.map((item, i) => {
              const val = Number(item[yField ?? ''])
              return <Cell key={i} fill={val >= (targetValue ?? 0) ? aboveC : belowC} />
            })}
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  )
})

const RadarChartImpl = createA2UIComponent<{
  data?: any[]; nameKey?: string; dataKey?: string; title?: string
  height?: number; width?: any; color?: string; fillOpacity?: number; strokeWidth?: number
  showLegend?: boolean; showTooltip?: boolean
  fontSize?: number; fontFamily?: string; chartMargin?: number
}>('RadarChart', ({ data, nameKey, dataKey, title, height, width, color, fillOpacity, strokeWidth, showLegend, showTooltip, fontSize, fontFamily, chartMargin }) => {
  const chartData = Array.isArray(data) ? data : []
  const fs = fontSize ?? 13
  const ff = fontFamily ?? DEFAULT_FONT
  const m = chartMargin ?? 16
  return (
    <div style={{ width: cssWidth(width), fontFamily: ff, fontSize: fs }}>
      {title && <div className="text-sm font-medium mb-2">{title}</div>}
      <ResponsiveContainer width="100%" height={height ?? 300}>
        <RadarChart data={chartData} margin={{ top: m, right: m, bottom: m, left: m }}>
          <PolarGrid />
          <PolarAngleAxis dataKey={nameKey} tick={{ fontSize: fs }} />
          <PolarRadiusAxis tick={{ fontSize: fs }} />
          {(showTooltip ?? true) && <Tooltip contentStyle={{ fontSize: fs }} />}
          {(showLegend ?? true) && <Legend wrapperStyle={{ fontSize: fs }} />}
          <Radar name={title ?? ''} dataKey={dataKey ?? ''} stroke={color ?? '#1890ff'} fill={color ?? '#1890ff'} fillOpacity={fillOpacity ?? 0.3} strokeWidth={strokeWidth ?? 2} />
        </RadarChart>
      </ResponsiveContainer>
    </div>
  )
})

const RadialBarChartImpl = createA2UIComponent<{
  data?: any[]; nameKey?: string; valueKey?: string; title?: string
  height?: number; width?: any; colors?: string
  innerRadius?: number; outerRadius?: number
  showLegend?: boolean; showTooltip?: boolean
  fontSize?: number; fontFamily?: string; chartMargin?: number
}>('RadialBarChart', ({ data, nameKey, valueKey, title, height, width, colors, innerRadius, outerRadius, showLegend, showTooltip, fontSize, fontFamily, chartMargin }) => {
  const chartData = Array.isArray(data) ? data : []
  const colorArr = (colors ?? '#1890ff,#52c41a,#faad14,#f5222d,#722ed1').split(',').map(c => c.trim())
  const fs = fontSize ?? 13
  const ff = fontFamily ?? DEFAULT_FONT
  const m = chartMargin ?? 16
  return (
    <div style={{ width: cssWidth(width), fontFamily: ff, fontSize: fs }}>
      {title && <div className="text-sm font-medium mb-2">{title}</div>}
      <ResponsiveContainer width="100%" height={height ?? 300}>
        <RadialBarChart data={chartData} innerRadius={innerRadius ?? 30} outerRadius={outerRadius ?? 120} margin={{ top: m, right: m, bottom: m, left: m }}>
          <PolarAngleAxis type="number" tick={{ fontSize: fs }} />
          <PolarRadiusAxis angle={30} type="category" dataKey={nameKey} tick={{ fontSize: fs }} />
          {(showTooltip ?? true) && <Tooltip contentStyle={{ fontSize: fs }} />}
          {(showLegend ?? true) && <Legend wrapperStyle={{ fontSize: fs }} />}
          <RadialBar dataKey={valueKey ?? ''} background>
            {chartData.map((_, i) => (
              <Cell key={i} fill={colorArr[i % colorArr.length]} />
            ))}
          </RadialBar>
        </RadialBarChart>
      </ResponsiveContainer>
    </div>
  )
})

// ===== StatCard KPI 指标卡 =====

const StatCardImpl = createA2UIComponent<{
  label?: string; value?: any; prefix?: string; suffix?: string
  trend?: number; trendLabel?: string
  sparklineData?: any; sparklineColor?: string
  height?: number; width?: any; color?: string
  fontSize?: number; fontFamily?: string
}>('StatCard', ({ label, value, prefix, suffix, trend, trendLabel, sparklineData, sparklineColor, height, width, color, fontSize, fontFamily }) => {
  const fs = fontSize ?? 13
  const ff = fontFamily ?? DEFAULT_FONT
  const accent = color ?? '#1890ff'
  const trendVal = trend ?? 0
  const trendUp = trendVal >= 0
  const trendColor = sparklineColor ?? (trendUp ? '#52c41a' : '#ff4d4f')
  const trendArrow = trendVal !== undefined && trendVal !== null ? (trendUp ? '▲' : '▼') : null
  const trendPct = `${Math.abs(trendVal).toFixed(1)}%`
  const sparkData = Array.isArray(sparklineData) ? sparklineData.map((v: number, i: number) => ({ i, v })) : []
  const displayValue = value !== undefined && value !== null ? String(value) : '--'

  return (
    <div style={{ width: cssWidth(width), height: height ?? 150, fontFamily: ff }}>
      <Card className="h-full">
        <CardContent className="flex flex-col justify-between h-full p-4">
          {/* 指标名称 */}
          <div className="text-xs text-gray-500 truncate" style={{ fontSize: Math.max(fs - 2, 11) }}>
            {label}
          </div>

          {/* 数值 + 前缀后缀 */}
          <div className="flex items-baseline gap-1 mt-1">
            {prefix && <span className="text-lg text-gray-400">{prefix}</span>}
            <span className="text-3xl font-bold tracking-tight" style={{ color: accent, fontSize: fs + 16 }}>
              {displayValue}
            </span>
            {suffix && <span className="text-sm text-gray-400 ml-0.5">{suffix}</span>}
          </div>

          {/* 趋势 + 迷你趋势线 */}
          <div className="flex items-center gap-3 mt-2">
            {trendArrow && (
              <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: trendColor }}>
                <span style={{ fontSize: fs - 3 }}>{trendArrow}</span>
                {trendPct}
                {trendLabel && <span className="text-gray-400 ml-0.5">{trendLabel}</span>}
              </span>
            )}
            {sparkData.length > 0 && (
              <div className="flex-1 min-w-0" style={{ height: 36 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={sparkData}>
                    <Line type="monotone" dataKey="v" stroke={trendColor} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
})

// ===== Dashboard 网格布局容器 =====

const DashboardImpl = createBinderlessComponentImplementation(
  { name: 'Dashboard', schema: {} as any },
  ({ context, buildChild }: A2UIRenderProps) => {
    const dm = context.dataContext.dataModel
    useDataModelSubscription(dm)

    const rawProps = context.componentModel.properties
    const props = resolveProps(rawProps, dm)
    const ids: string[] = props.children ?? []
    const cols = props.columns ?? 12
    const g = props.gap ?? 16

    return (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: g }}>
        {ids.map(id => {
          const childModel = (context as any).surfaceComponents?.get(id)
          const w = childModel?.properties?._w ?? cols
          return (
            <div key={id} style={{ gridColumn: `span ${w}`, minWidth: 0 }}>
              {buildChild(id)}
            </div>
          )
        })}
      </div>
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
    TextImpl, RowImpl, CardImpl, TextFieldImpl, SelectImpl, ButtonImpl, DataTableImpl,
    BarChartImpl, LineChartImpl, PieChartImpl, AreaChartImpl,
    ComposedChartImpl, ScatterChartImpl, RadarChartImpl, RadialBarChartImpl,
    StatCardImpl, DashboardImpl, DialogImpl,
  ]
  return new Catalog('basic', components)
}
