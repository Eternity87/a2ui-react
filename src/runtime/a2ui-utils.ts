/**
 * a2ui-utils.ts — 共享工具函数
 *
 * 路径规范化、表达式安全校验、DynamicValue 解析、响应式绑定 Hook。
 * 使用 createBinderlessComponentImplementation，手动处理标准 DynamicValue 格式的 props。
 */

import type { DataModel } from '@a2ui/web_core/v0_9'
import { useCallback, useSyncExternalStore } from 'react'

// ===== 表达式安全校验 =====

/** new Function() 执行前禁止的危险标识符 */
const FORBIDDEN_EXPR = /\b(?:constructor|__proto__|prototype|window|document|globalThis|self|top|parent|frames|fetch|XMLHttpRequest|WebSocket|EventSource|eval|Function|setTimeout|setInterval|setImmediate|requestAnimationFrame|import|require|importScripts|localStorage|sessionStorage|indexedDB|location|history|navigator|alert|prompt|confirm|cookie)\b/

/** 校验表达式不包含危险标识符，抛出异常则拒绝执行 */
export function validateExpression(expr: string, label?: string): void {
  if (FORBIDDEN_EXPR.test(expr)) {
    throw new Error(`[${label ?? 'validateExpression'}] Forbidden identifier in expression`)
  }
}

// ===== 路径工具 =====

/**
 * 将简化路径转为标准 JSON Pointer 格式
 *
 * 例: "/productCategory"    → "/productCategory"
 *     "/rawProducts.list"   → "/rawProducts/list"   (点号也转斜杠)
 *     "/errors/formError"   → "/formError"
 *
 * 用于 ReactionEngine when.field、DataTable cellPath 等内部路径处理。
 */
export function dmPath(pointer: string): string {
  const clean = pointer.replace(/^\/(data|ui|errors)\//, '').replace(/^\//, '')
  const parts = clean.split(/[\/.]/)
  return '/' + parts.join('/')
}

/** 判断组件类型是否可容纳子组件（布局容器） */
export function canHaveChildren(typeOrComp: any): boolean {
  const type = typeof typeOrComp === 'string' ? typeOrComp : typeOrComp?.component
  return ['Row', 'Card'].includes(type ?? '')
}

// ===== DynamicValue 解析 =====

/** 从 DataModel 取值（内部使用） */
function getByPointer(dm: DataModel, pointer: string): any {
  return dm.get(dmPath(pointer))
}

/** 解析单个值：如果是 { path } DataBinding 则查 dataModel，否则原样返回 */
function resolveDynamicValue(value: any, dm: DataModel): any {
  if (typeof value === 'object' && value !== null && 'path' in value) {
    return getByPointer(dm, value.path)
  }
  return value
}

/**
 * 解析组件 props 中的标准 DynamicValue 引用
 *
 * 支持 A2UI v0.9 标准格式：
 * 1. DataBinding: { "path": "/quantity" } → 从 dataModel 取值
 * 2. 模板插值: "总价: ${/totalPrice} 元" → 替换 ${/xxx} 为实际值
 * 3. 静态值: "提交" / 42 / [...] → 保持原样
 */
export function resolveProps(raw: Record<string, any>, dm: DataModel): Record<string, any> {
  const resolved: Record<string, any> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      // 模板插值 ${/xxx} → 替换为实际值
      resolved[key] = value.replace(/\$\{\/([^}]+)\}/g, (_, path: string) => {
        const val = getByPointer(dm, `/${path.trim()}`)
        return val !== undefined ? String(val) : `\${/${path}}`
      })
    } else if (typeof value === 'object' && value !== null && 'path' in value) {
      // DataBinding { "path": "..." } → 解析为实际值
      resolved[key] = getByPointer(dm, value.path)
    } else {
      resolved[key] = value
    }
  }
  return resolved
}

/** 从组件原始 props 中提取 DataBinding 的路径，用于 write-back */
export function getBindingPath(rawValue: any): string | undefined {
  if (typeof rawValue === 'object' && rawValue !== null && 'path' in rawValue) {
    return rawValue.path
  }
  return undefined
}

// ===== 响应式 Hook =====

/**
 * 细粒度响应式数据绑定 Hook
 *
 * 用 useSyncExternalStore 订阅 DataModel 特定路径的变化。
 */
export function useDataBinding<T>(dm: DataModel, path: string, fallback: T): T {
  const subscribe = useCallback(
    (cb: () => void) => dm.subscribe(path, () => cb()).unsubscribe,
    [dm, path],
  )
  const getSnapshot = useCallback(() => dm.get(path) ?? fallback, [dm, path, fallback])
  return useSyncExternalStore(subscribe, getSnapshot)
}
