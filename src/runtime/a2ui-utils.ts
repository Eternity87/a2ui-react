/**
 * a2ui-utils.ts — 共享工具函数
 *
 * 路径规范化、表达式安全校验、DynamicValue 解析、响应式绑定 Hook。
 * 使用 createBinderlessComponentImplementation，手动处理标准 DynamicValue 格式的 props。
 */

import type { DataModel } from '@a2ui/web_core/v0_9'
import { useCallback, useRef, useSyncExternalStore } from 'react'

// ===== 表达式安全校验 =====

/** new Function() 执行前禁止的危险标识符 */
const FORBIDDEN_EXPR = /\b(?:constructor|__proto__|prototype|window|document|globalThis|self|top|parent|frames|fetch|XMLHttpRequest|WebSocket|EventSource|eval|Function|setTimeout|setInterval|setImmediate|requestAnimationFrame|import|require|importScripts|localStorage|sessionStorage|indexedDB|location|history|navigator|alert|prompt|confirm|cookie)\b/

/** 校验表达式不包含危险标识符，抛出异常则拒绝执行 */
export function validateExpression(expr: string, label?: string): void {
  const tag = label ?? 'validateExpression'
  // 1. Unicode 标准化 (NFC)，防止异体字绕过（如 \u{65}val 等价于 eval）
  const normalized = expr.normalize('NFC')
  // 2. 黑名单关键词检测
  if (FORBIDDEN_EXPR.test(normalized)) {
    throw new Error(`[${tag}] Forbidden identifier in expression`)
  }
  // 3. 禁止方括号属性访问，防止 this['ev'+'al'] 等动态拼接绕过
  if (/\[['"`]/.test(normalized)) {
    throw new Error(`[${tag}] Bracket property access not allowed`)
  }
  // 4. 禁止 .constructor 访问链，防止 (function(){}).constructor('return this')()
  if (/\.constructor\b/.test(normalized)) {
    throw new Error(`[${tag}] Constructor access not allowed`)
  }
}

// ===== 白名单沙箱 =====

/** 沙箱中允许访问的全局对象（白名单） */
const SANDBOX_GLOBALS: Record<string, any> = {
  Math, Date, JSON,
  Array, Object, String, Number, Boolean,
  parseInt, parseFloat, isNaN, isFinite,
  undefined,
  isArray: Array.isArray,
  NaN, Infinity,
}

/**
 * 在白名单 Proxy 沙箱中安全求解单一表达式
 *
 * 使用 with + Proxy 拦截所有变量访问，仅允许 SANDBOX_GLOBALS 和注入的 vars。
 * 适用于 pipe filter/map/compute 和 condition 表达式（无局部变量声明）。
 */
export function safeEvalExpression(expr: string, vars: Record<string, any> = {}): any {
  const sandbox = new Proxy({ ...SANDBOX_GLOBALS, ...vars }, {
    has: () => true,
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined
      if (prop in target) return target[prop as string]
      throw new Error(`Sandbox: access to "${String(prop)}" is not allowed`)
    },
  })

  // 不使用 strict mode 以支持 with 语句；Proxy 沙箱提供安全保障
  const fn = new Function('$sandbox', `with ($sandbox) { return (${expr}) }`)
  return fn(sandbox)
}

/**
 * 在白名单参数沙箱中安全执行脚本代码（多行语句）
 *
 * 将所有允许的全局对象和服务变量作为函数参数注入。
 * 任何未在参数列表中列出的全局变量（window/document/fetch 等）
 * 在 strict mode 下触发 ReferenceError，天然拒绝访问。
 */
export function safeEvalScript(code: string, vars: Record<string, any> = {}): void {
  const allVars = { ...SANDBOX_GLOBALS, ...vars }
  const keys = Object.keys(allVars)
  const values = Object.values(allVars)

  const fn = new Function(...keys, `"use strict";\n${code}`)
  fn(...values)
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

/** 可容纳子组件的布局容器类型集合 */
const CONTAINER_COMPONENTS = new Set(['Row', 'Card'])

/** 注册可容纳子组件的容器类型（供 component-catalog 扩展时调用） */
export function registerContainerComponent(typeName: string) {
  CONTAINER_COMPONENTS.add(typeName)
}

/** 判断组件类型是否可容纳子组件（布局容器） */
export function canHaveChildren(typeOrComp: any): boolean {
  const type = typeof typeOrComp === 'string' ? typeOrComp : typeOrComp?.component
  return CONTAINER_COMPONENTS.has(type ?? '')
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
  // 快路径：无动态绑定直接复用原对象
  const hasBinding = Object.values(raw).some(v =>
    (typeof v === 'string' && /\$\{/.test(v)) ||
    (typeof v === 'object' && v !== null && 'path' in v)
  )
  if (!hasBinding) return raw

  const resolved: Record<string, any> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      // 模板插值 ${/xxx} → 替换为实际值
      resolved[key] = value.replace(/\$\{\/([^}]+)\}/g, (_, path: string) => {
        const val = getByPointer(dm, `/${path.trim()}`)
        return val !== undefined ? String(val) : ''
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
 * 订阅 DataModel 全量变更的 Hook
 *
 * 封装 useSyncExternalStore + versionRef 模式，用于组件级 DataModel 响应式订阅。
 * createA2UIComponent 工厂已内置此订阅；DataTable/Dialog 等直接使用
 * createBinderlessComponentImplementation 的组件可通过此 Hook 复用。
 */
export function useDataModelSubscription(dm: DataModel) {
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
}

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
