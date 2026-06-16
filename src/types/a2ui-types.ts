/**
 * a2ui-types.ts — 核心类型定义
 *
 * 覆盖 agent → adapter → reaction-engine → catalog 四个模块的边界数据结构。
 * 所有类型均基于 A2UI v0.9 标准 + 项目扩展。
 */

// ====================================================================
// Layer 0: DynamicValue — 组件 props 的数据绑定基础
// ====================================================================

/** A2UI v0.9 标准 DataBinding：从 dataModel 指定路径读取值 */
export interface DataBinding {
  path: string
}

/**
 * 组件 prop 的合法动态值类型：
 * - 静态字面量（直接写值）
 * - DataBinding（{ path: "/xxx" }）
 * - 模板字符串（"${/xxx}"）
 */
export type DynamicValue<T = unknown> = T | DataBinding | string

// ====================================================================
// Layer 1: A2UIMessage — agent 输出的单条消息
// ====================================================================

/** 组件节点（surfaceUpdate.components 中的元素） */
export interface ComponentNode {
  id: string
  component: string
  /** legacy 格式：props 嵌套在 props 字段中 */
  props?: Record<string, unknown>
  /** v0.9 平级格式：props 展平到顶层（children, gap, label, value...） */
  [key: string]: unknown
}

/**
 * A2UI 消息联合类型
 * 兼容 legacy 简化格式（beginRendering/surfaceUpdate/updateDataModel）
 * 和 v0.9 标准格式（createSurface/updateComponents/updateDataModel/deleteSurface）
 */
export type A2UIMessage =
  | LegacyMessage
  | V09Message

/** 简化格式消息（Agent 直接输出，adapter 会转为 v0.9） */
export interface LegacyMessage {
  beginRendering?: { surfaceId: string; catalogId: string }
  surfaceUpdate?: { surfaceId: string; components: ComponentNode[] }
  dataModelUpdate?: { surfaceId: string; data: Record<string, unknown> }
  updateDataModel?: { surfaceId: string; path?: string; value?: unknown }
}

/** v0.9 标准格式消息（MessageProcessor 直接消费） */
export interface V09Message {
  version?: 'v0.9'
  createSurface?: { surfaceId: string; catalogId: string; sendDataModel?: boolean }
  updateComponents?: { surfaceId: string; components: ComponentNode[] }
  updateDataModel?: { surfaceId: string; path?: string; value?: unknown }
  deleteSurface?: { surfaceId: string }
}

/** 检测消息数组的格式类型 */
export type InputFormat = 'legacy' | 'v09' | 'v08'

// ====================================================================
// Layer 2: Action — Reaction.then 中的每个动作（区分类型）
// ====================================================================

export interface ValidationRule {
  field: string
  required?: boolean
  message: string
}

export interface ConditionBranch {
  if?: string
  then: Action[]
}

/**
 * Pipe 管道步骤联合类型
 * 简写格式 { get: '...' } 和标准格式 { type: 'get', params: '...' } 均支持
 */
export type PipeStep =
  | { type?: string; [key: string]: unknown }
  | { get: string }
  | { filter: string }
  | { map: string }
  | { compute: string }
  | { yoy: { current: unknown; previous: unknown } }
  | { mom: { current: unknown; previous: unknown } }

/** Reaction 动作联合类型 */
export type Action =
  | ApiRequestAction
  | SetValuesAction
  | ValidateAction
  | ToastAction
  | CascadeAction
  | ConditionAction
  | NavigateAction
  | ScheduleAction

export interface ApiRequestAction {
  type: 'apiRequest'
  url: string
  method?: string
  params?: Record<string, unknown>
  body?: Record<string, unknown>
  outputTo: string
}

export interface SetValuesAction {
  type: 'setValues'
  map: Record<string, unknown | { pipe: PipeStep[] }>
}

export interface ValidateAction {
  type: 'validate'
  rules: ValidationRule[]
  errorTarget?: string
}

export interface ToastAction {
  type: 'toast'
  message: string
  variant?: 'success' | 'error' | 'warning' | 'info'
}

export interface CascadeAction {
  type: 'cascade'
  target: string
}

export interface ConditionAction {
  type: 'condition'
  branches: ConditionBranch[]
}

export interface NavigateAction {
  type: 'navigate'
  pageId: string
  params?: Record<string, unknown>
}

export interface ScheduleAction {
  type: 'schedule'
  interval?: number
  then: Action[]
}

// ====================================================================
// Layer 2: Reaction — 声明式业务逻辑规则
// ====================================================================

export interface ReactionDef {
  id: string
  when: {
    field: string
    event: 'init' | 'click' | 'change' | 'blur' | 'unload'
  }
  then: Action[]
}

// ====================================================================
// Layer 3: PageDef / NormalizedPages — 页面归一化输出
// ====================================================================

/** 单页面定义（adapter 归一化后的输出） */
export interface PageDef {
  a2ui: A2UIMessage[]
  logic: {
    reactions: ReactionDef[]
    scripts?: Record<string, string>
  }
  /** 内嵌子 surface 定义（供 Dialog 组件引用） */
  children?: Record<string, PageDef>
}

/** 归一化后的多页面结构 */
export interface NormalizedPages {
  pages: Record<string, PageDef>
  shared?: {
    dataModel?: Record<string, unknown>
    logic?: { reactions: ReactionDef[] }
  }
}

// ====================================================================
// Agent 输出 / 输入
// ====================================================================

/** Agent 生成结果（经过 extractJson + validateOutput 后） */
export interface AgentResult {
  a2ui: A2UIMessage[]
  logic: { reactions: ReactionDef[] }
}
