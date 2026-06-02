import React from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'

/** A2UI 组件 props 定义 */
interface A2UIComponentDef {
  id: string
  component: string
  props: Record<string, any>
}

interface RendererProps {
  components: A2UIComponentDef[]
  dataModel: Record<string, any>
  onEvent: (event: string, payload: any) => void
}

/** 解析 JSON Pointer 路径，从 dataModel 取值 */
function getByPointer(dataModel: Record<string, any>, pointer: string): any {
  const clean = pointer.replace(/^\/(data|ui|errors)\//, '')
  const parts = clean.split(/[\/.]/)
  let cur: any = dataModel
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[p]
  }
  return cur
}

/** 解析 props 中的 JSON Pointer 引用和模板插值 */
function resolveProps(raw: Record<string, any>, dataModel: Record<string, any>): Record<string, any> {
  const resolved: Record<string, any> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      if (value.startsWith('/data/')) {
        resolved[key] = getByPointer(dataModel, value)
      } else {
        resolved[key] = value.replace(/\{\/data\/([^}]+)\}/g, (_, path: string) => {
          const val = getByPointer(dataModel, `/data/${path.trim()}`)
          return val !== undefined ? String(val) : `{/data/${path}}`
        })
      }
    } else {
      resolved[key] = value
    }
  }
  return resolved
}

/** 渲染单个 A2UI 组件 */
function RenderComponent({
  def, dataModel, onEvent, compMap,
}: {
  def: A2UIComponentDef
  dataModel: Record<string, any>
  onEvent: (event: string, payload: any) => void
  compMap: Map<string, A2UIComponentDef>
}) {
  const props = resolveProps(def.props ?? {}, dataModel)

  // 渲染子组件
  const renderChildren = (childIds?: string[]) => {
    if (!childIds) return null
    return childIds
      .map(id => {
        const child = compMap.get(id)
        if (!child) return null
        return (
          <RenderComponent
            key={child.id}
            def={child}
            dataModel={dataModel}
            onEvent={onEvent}
            compMap={compMap}
          />
        )
      })
      .filter(Boolean)
  }

  switch (def.component) {
    case 'Row': {
      const gap = props.gap ?? 8
      return (
        <div style={{ display: 'flex', gap, flexWrap: 'wrap' }}>
          {renderChildren(props.children)}
        </div>
      )
    }

    case 'Card':
      return (
        <Card>
          {props.title && (
            <CardHeader>
              <CardTitle>{props.title}</CardTitle>
            </CardHeader>
          )}
          <CardContent className="flex flex-col gap-2">
            {renderChildren(props.children)}
          </CardContent>
        </Card>
      )

    case 'TextField': {
      const isNumber = def.props?.type === 'number'
      const rawValuePath = def.props?.value
      return (
        <div className="flex flex-col gap-1">
          {props.label && <label className="text-sm font-medium text-muted-foreground">{props.label}</label>}
          <Input
            type={isNumber ? 'number' : 'text'}
            value={props.value ?? ''}
            placeholder={props.placeholder}
            onChange={e =>
              onEvent('change', { field: rawValuePath, value: isNumber ? Number(e.target.value) : e.target.value })
            }
            onBlur={e =>
              onEvent('blur', { field: rawValuePath, value: isNumber ? Number((e.target as HTMLInputElement).value) : props.value })
            }
          />
        </div>
      )
    }

    case 'Select': {
      const rawValuePath = def.props?.value
      const options: any[] = Array.isArray(props.options) ? props.options : []
      return (
        <div className="flex flex-col gap-1">
          {props.label && <label className="text-sm font-medium text-muted-foreground">{props.label}</label>}
          <Select
            value={props.value ?? ''}
            onValueChange={val => onEvent('change', { field: rawValuePath, value: val })}
          >
            <SelectTrigger>
              <SelectValue placeholder={props.placeholder} />
            </SelectTrigger>
            <SelectContent>
              {options.map((opt: any) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )
    }

    case 'Text':
      return <span className="text-sm">{props.text}</span>

    case 'Button': {
      const variantMap: Record<string, 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link'> = {
        primary: 'default',
        secondary: 'secondary',
        danger: 'destructive',
      }
      return (
        <Button
          variant={variantMap[props.variant] ?? 'default'}
          disabled={props.disabled}
          onClick={() => onEvent('click', { reactionId: props.reactionId })}
        >
          {props.label}
        </Button>
      )
    }

    case 'DataTable': {
      const columns: any[] = props.columns ?? []
      const rawValue = props.value
      const rows: any[] = Array.isArray(rawValue) ? rawValue : []
      const rawValuePath = def.props?.value

      const renderCell = (col: any, scope: { row: any; rowIndex: number }) => {
        const cellValue = scope.row[col.key]
        const cellPath = rawValuePath ? `${rawValuePath}/${scope.rowIndex}/${col.key}` : ''
        const cellType = col.cellType || 'text'

        switch (cellType) {
          case 'input':
            return (
              <Input
                className="h-8 text-xs"
                value={cellValue ?? ''}
                onChange={e => onEvent('change', { field: cellPath, value: e.target.value })}
              />
            )
          case 'number':
            return (
              <Input
                type="number"
                className="h-8 text-xs"
                value={cellValue ?? ''}
                onChange={e => onEvent('change', { field: cellPath, value: Number(e.target.value) })}
              />
            )
          case 'select': {
            let options = col.cellProps?.options ?? []
            if (typeof options === 'string') {
              if (options.startsWith('/')) {
                options = getByPointer(dataModel, options) ?? []
              } else {
                try { options = JSON.parse(options) } catch { options = [] }
              }
            }
            return (
              <Select
                value={cellValue ?? ''}
                onValueChange={val => onEvent('change', { field: cellPath, value: val })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
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
                <TableHead key={col.key} style={{ width: col.width }}>
                  {col.label || col.key}
                </TableHead>
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
                <TableRow key={rowIndex}>
                  {columns.map((col: any) => (
                    <TableCell key={col.key}>
                      {renderCell(col, { row, rowIndex })}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      )
    }

    default:
      return <span className="text-muted-foreground text-sm">[{def.component}]</span>
  }
}

/** 主渲染器：将 A2UI 组件列表渲染为 React 元素树 */
export function A2UIRenderer({ components, dataModel, onEvent }: RendererProps) {
  if (!components || components.length === 0) return null

  const compMap = new Map<string, A2UIComponentDef>()
  components.forEach(c => compMap.set(c.id, c))

  // 找根组件（未被任何父组件引用的组件）
  const childIds = new Set<string>()
  components.forEach(c => {
    (c.props?.children as string[] | undefined)?.forEach(id => childIds.add(id))
  })
  const roots = components.filter(c => !childIds.has(c.id))

  return (
    <div className="flex flex-col gap-4">
      {roots.map(root => (
        <RenderComponent
          key={root.id}
          def={root}
          dataModel={dataModel}
          onEvent={onEvent}
          compMap={compMap}
        />
      ))}
    </div>
  )
}
