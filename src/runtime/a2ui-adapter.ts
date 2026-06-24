/**
 * a2ui-adapter.ts — 多格式 A2UI 消息转换适配器
 *
 * 【在架构中的角色】
 * 这是"翻译层"：将 Agent 生成的简化格式、v0.8 标准消息、v0.9 标准消息
 * 统一转换为 MessageProcessor 能理解的 v0.9 格式。
 *
 * 【为什么需要这个文件】
 * - Agent 输出的简化格式（beginRendering / surfaceUpdate / dataModelUpdate）
 *   不兼容 Google 官方 @a2ui/web_core 的 v0.9 消息格式
 * - 同时保留对 v0.8 和 v0.9 标准格式的透传能力，为未来对接外部工具链做准备
 *
 * 【关键转换规则】
 * 1. 简化格式的 props 是嵌套对象 → v0.9 需要扁平到组件顶层
 *    例: { id, component, props: { label, value } } → { id, component, label, value }
 * 2. 简化格式的 dataModel 是整体对象 → v0.9 写为 path="/" 的单次写入
 * 3. 自动补全 id="root" 的根组件（A2uiSurface 的硬性要求）
 *
 * 【Data Flow】
 * Agent JSON → detectFormat() → legacyToV09() / 透传 → MessageProcessor.processMessages()
 */

import { logger } from '@/lib/logger'
import type {
  LegacyMessage, V09Message, InputFormat,
  PageDef, NormalizedPages, A2UIMessage, ComponentNode,
} from '@/types/a2ui-types'

export type { PageDef, NormalizedPages } from '@/types/a2ui-types'

// ---- 类型定义 ----

/** Agent 生成的简化格式消息（内部使用，宽松 any 便于格式转换） */
interface LegacyMessageInternal {
  beginRendering?: { surfaceId: string; catalogId: string }
  surfaceUpdate?: { surfaceId: string; components: any[] }
  dataModelUpdate?: { surfaceId: string; data: Record<string, any> }
  updateDataModel?: { surfaceId: string; path?: string; value?: any }
}

/** Google 官方 v0.9 标准消息（内部使用） */
interface V09MessageInternal {
  version: 'v0.9'
  createSurface?: { surfaceId: string; catalogId: string; sendDataModel?: boolean }
  updateComponents?: { surfaceId: string; components: any[] }
  updateDataModel?: { surfaceId: string; path?: string; value?: any }
  deleteSurface?: { surfaceId: string }
}

// ---- 格式检测 ----

/**
 * 检测输入消息的格式类型
 *
 * 策略：检查第一条消息的字段名
 * - beginRendering/surfaceUpdate → 我们自己的简化格式
 * - createSurface/updateComponents  → Google 官方 v0.9
 * - 其他                            → 假定为 v0.8（透传）
 */
export function detectFormat(messages: A2UIMessage[]): InputFormat {
  if (!Array.isArray(messages) || messages.length === 0) return 'v09'
  const first = messages[0]
  if ('beginRendering' in first || 'surfaceUpdate' in first || 'dataModelUpdate' in first) {
    return 'legacy'
  }
  if ('createSurface' in first || 'updateComponents' in first || 'updateDataModel' in first) {
    return 'v09'
  }
  return 'v08'
}

/** 统一入口：任何格式的 A2UI 消息 → v0.9 标准消息数组 */
export function toV09(
  messages: A2UIMessage[],
  options?: { sendDataModel?: boolean; catalogId?: string },
): V09Message[] {
  const format = detectFormat(messages)
  switch (format) {
    case 'legacy': return legacyToV09(messages as unknown as LegacyMessageInternal[], options) as unknown as V09Message[]
    case 'v09':   return messages as unknown as V09Message[]
    case 'v08':   return v08ToV09(messages) as unknown as V09Message[]
  }
}

// ---- 简化格式 → v0.9 ----

/**
 * 将 Agent 输出的简化格式 JSON 转换为 v0.9 消息数组
 *
 * 三项关键转换：
 * 1. beginRendering   → createSurface          (surface 创建)
 * 2. surfaceUpdate    → updateComponents       (组件注册，props 扁平化)
 * 3. dataModelUpdate  → updateDataModel(path="/") (数据模型整体写入)
 */
export function legacyToV09(
  legacyMessages: LegacyMessageInternal[],
  options?: { sendDataModel?: boolean; catalogId?: string },
): V09MessageInternal[] {
  const result: V09MessageInternal[] = []
  const catalogId = options?.catalogId ?? 'basic'

  for (const msg of legacyMessages) {
    if (msg.beginRendering) {
      result.push({
        version: 'v0.9' as const,
        createSurface: {
          surfaceId: msg.beginRendering.surfaceId,
          catalogId,
          sendDataModel: options?.sendDataModel ?? true,
        },
      })
    }

    if (msg.surfaceUpdate) {
      // 兼容两种格式：legacy (props 嵌套) 和 v0.9 (props 平级)
      let comps = msg.surfaceUpdate.components.map(c => {
        const { props, ...rest } = c
        return { ...rest, ...(props || {}) }
      })
      // A2uiSurface 要求必须有 id="root" 的根组件，自动补全
      comps = ensureRootComponent(comps)
      result.push({
        version: 'v0.9' as const,
        updateComponents: { surfaceId: msg.surfaceUpdate.surfaceId, components: comps },
      })
    }

    if (msg.dataModelUpdate) {
      // 旧格式：整体写入到根路径
      const { surfaceId, data } = msg.dataModelUpdate
      if (data && Object.keys(data).length > 0) {
        result.push({ version: 'v0.9' as const, updateDataModel: { surfaceId, path: '/', value: data } })
      }
    }

    if (msg.updateDataModel) {
      // 新标准格式：逐字段透传
      result.push({ version: 'v0.9' as const, updateDataModel: msg.updateDataModel })
    }
  }

  return result
}

// ---- v0.8 → v0.9 转换 ----

/**
 * v0.8 → v0.9 消息转换
 *
 * v0.8 和 v0.9 的关键差异：
 * 1. 消息信封：v0.8 用 beginRendering/surfaceUpdate/dataModelUpdate，v0.9 用 createSurface/updateComponents/updateDataModel
 * 2. 组件结构：v0.8 的 component: { TypeName: { props } }，v0.9 的 component: "TypeName" + 平级 props
 * 3. 属性值：v0.8 的 { literalString: "x" } / { path: "/x" }，v0.9 的原生 "x" 或 { path: "/x" }
 * 4. 数据更新：v0.8 的 ValueMap[] 数组，v0.9 的普通对象 value
 */
function v08ToV09(messages: any[]): V09Message[] {
  // 检测是否真的是 v0.8 格式（beginRendering/surfaceUpdate/dataModelUpdate），
  // 如果已经是 v0.9 格式则直接返回
  if (messages.length > 0 && messages[0]?.version === 'v0.9') return messages

  const result: V09Message[] = []
  for (const msg of messages) {
    if ('beginRendering' in msg) {
      result.push(convertBeginRendering(msg.beginRendering))
    } else if ('surfaceUpdate' in msg) {
      result.push(convertSurfaceUpdate(msg.surfaceUpdate))
    } else if ('dataModelUpdate' in msg) {
      result.push(...convertDataModelUpdate(msg.dataModelUpdate))
    } else if ('deleteSurface' in msg) {
      result.push(convertDeleteSurface(msg.deleteSurface))
    }
  }
  return result
}

function convertBeginRendering(br: any): V09Message {
  return {
    version: 'v0.9' as const,
    createSurface: {
      surfaceId: br.surfaceId,
      catalogId: br.catalogId ?? 'basic',
      sendDataModel: true,
    },
  }
}

function convertSurfaceUpdate(su: any): V09Message {
  return {
    version: 'v0.9' as const,
    updateComponents: {
      surfaceId: su.surfaceId,
      components: (su.components ?? []).map((c: any) => convertComponent(c)).filter(Boolean),
    },
  }
}

function convertDataModelUpdate(dm: any): V09Message[] {
  const { surfaceId, path, contents } = dm
  const value = convertValueMap(contents ?? [])
  // 如果 path 为空，写根路径；否则按 path 写入
  const targetPath = path || '/'
  return [{ version: 'v0.9' as const, updateDataModel: { surfaceId, path: targetPath, value } }]
}

function convertDeleteSurface(ds: any): V09Message {
  return {
    version: 'v0.9' as const,
    deleteSurface: { surfaceId: ds.surfaceId },
  }
}

// ---- 组件转换 ----

const COMPONENT_MAP: Record<string, string> = {
  Text: 'Text', Row: 'Row', Column: 'Row', Card: 'Card',
  Button: 'Button', TextField: 'TextField', Select: 'Select',
  DataTable: 'DataTable', Modal: 'Dialog',
}

function convertComponent(comp: any): any | null {
  if (!comp.component || typeof comp.component !== 'object') {
    // 可能已经是 v0.9 格式
    return comp
  }
  // v0.8 format: component: { TypeName: { ...props } }
  const [typeName, v08Props] = Object.entries(comp.component)[0] as [string, any]
  const v09Type = COMPONENT_MAP[typeName]
  if (!v09Type) {
    logger.warn(`[v08ToV09] Unknown component type: ${typeName}, skipping`)
    return null
  }

  const converted = convertComponentProps(v09Type, v08Props ?? {})
  return {
    id: comp.id,
    weight: comp.weight,
    component: v09Type,
    ...converted,
  }
}

function convertComponentProps(type: string, props: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {}
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue

    // 通用属性值转换
    if (isStringValue(value)) {
      result[key] = convertStringValue(value)
    } else if (isNumberValue(value)) {
      // v0.8 NumberValue
      result[key] = convertNumberValue(value)
    } else if (isBooleanValue(value)) {
      // v0.8 BooleanValue
      result[key] = convertBooleanValue(value)
    } else if (isActionValue(value)) {
      result[key] = convertActionValue(value)
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      // 嵌套对象，递归转换
      result[key] = convertComponentProps(type, value)
    } else {
      result[key] = value
    }
  }

  // 组件特定字段映射
  if (type === 'Text' && props.usageHint !== undefined) {
    result.variant = convertStringValue(props.usageHint)
  }
  if (type === 'Button') {
    // v0.8 child (单数字符串) → v0.9 children (数组)
    if (props.child !== undefined) {
      result.children = [convertStringValue(props.child)]
    }
    // v0.8 primary: true → v0.9 variant: "primary"
    if (props.primary === true || convertBooleanValue(props.primary) === true) {
      result.variant = 'primary'
    }
  }
  if (type === 'Column') {
    result.style = { ...(result.style || {}), flexDirection: 'column' }
  }

  return result
}

// ---- 值类型检测与转换 ----

function isStringValue(v: any): boolean {
  if (typeof v !== 'object' || v === null) return false
  if ('literalString' in v) return true
  if ('path' in v && !('literalNumber' in v) && !('literalBoolean' in v)) {
    return Object.keys(v).every(k => k === 'path')
  }
  return false
}

function convertStringValue(v: any): any {
  if (typeof v !== 'object' || v === null) return v
  if (v.literalString !== undefined) return v.literalString
  if (v.path !== undefined) return { path: v.path }
  return v
}

function isNumberValue(v: any): boolean {
  if (typeof v !== 'object' || v === null) return false
  if ('literalNumber' in v) return true
  if ('path' in v) {
    return Object.keys(v).every(k => k === 'path' || k === 'literalNumber')
  }
  return false
}

function convertNumberValue(v: any): any {
  if (typeof v !== 'object' || v === null) return v
  if (v.literalNumber !== undefined) return v.literalNumber
  if (v.path !== undefined) return { path: v.path }
  return v
}

function isBooleanValue(v: any): boolean {
  if (typeof v !== 'object' || v === null) return false
  if ('literalBoolean' in v) return true
  if ('path' in v && !('literalString' in v) && !('literalNumber' in v)) {
    return Object.keys(v).every(k => k === 'path')
  }
  return false
}

function convertBooleanValue(v: any): any {
  if (typeof v !== 'object' || v === null) return v
  if (v.literalBoolean !== undefined) return v.literalBoolean
  if (v.path !== undefined) return { path: v.path }
  return v
}

function isActionValue(v: any): boolean {
  return typeof v === 'object' && v !== null &&
    'name' in v && !('event' in v) && !('surfaceId' in v)
}

function convertActionValue(v: any): any {
  // v0.8: { name: "submit", context: [{ key: "id", value: { path: "/x" } }] }
  // v0.9: { event: { name: "submit", context: { id: { path: "/x" } } } }
  const context: Record<string, any> = {}
  if (Array.isArray(v.context)) {
    for (const item of v.context) {
      if (item.key && item.value !== undefined) {
        context[item.key] = convertStringValue(item.value)
      }
    }
  }
  return { event: { name: v.name, context } }
}

// ---- ValueMap 转换 ----

function convertValueMap(contents: any[]): any {
  if (!Array.isArray(contents)) return contents
  // 如果内容是 [{ key, valueString/number/boolean/map }] 格式
  if (contents.length > 0 && contents[0]?.key !== undefined) {
    const result: Record<string, any> = {}
    for (const item of contents) {
      result[item.key] =
        item.valueString ?? item.valueNumber ?? item.valueBoolean ??
        (item.valueMap ? convertValueMap(item.valueMap) : undefined)
    }
    return result
  }
  return contents
}

// ---- 根组件自动补全 ----

/**
 * 确保组件列表中 id="root" 是唯一的渲染入口
 *
 * A2uiSurface 固定从 "root" 开始渲染，旧 A2UIRenderer 则渲染所有不被引用的根组件。
 * 此函数弥合这个差异：
 * 1. 没有 root → 自动创建（单根改名 / 多根 Row 包裹）
 * 2. 有 root + 孤儿根节点 → 将孤儿挂到 root 的 children 下
 * 3. 全部在 root 树下 → 不动
 */
export function ensureRootComponent(comps: ComponentNode[]): ComponentNode[] {
  const allIds = new Set(comps.map(c => c.id))

  // 收集所有被 children 引用的节点 ID
  const childIds = new Set<string>()
  for (const c of comps) {
    if (Array.isArray(c.children)) {
      for (const id of c.children) childIds.add(id)
    }
  }

  if (!allIds.has('root')) {
    // 没有 root → 自动创建
    const rootIds = comps.filter(c => !childIds.has(c.id)).map(c => c.id)
    if (rootIds.length === 0) return comps
    if (rootIds.length === 1) {
      // 不可变：用 map 创建新数组，避免修改传入对象
      const renameId = rootIds[0]
      return comps.map(c => c.id === renameId ? { ...c, id: 'root' } : c)
    }
    return [...comps, { id: 'root', component: 'Row', children: rootIds, gap: 16 }]
  }

  // root 存在 → 收集 root 的完整后代树
  const inTree = new Set<string>()
  const collectTree = (id: string) => {
    if (inTree.has(id)) return
    const comp = comps.find(c => c.id === id)
    if (!comp) return // 组件不存在则不加入 visited，避免悬空引用污染集合
    inTree.add(id)
    if (Array.isArray(comp.children)) {
      for (const cid of comp.children) collectTree(cid)
    }
  }
  collectTree('root')

  // 将孤儿根节点（不被任何组件引用、也不在 root 树中）挂到 root 下
  const orphans = comps.filter(c => !childIds.has(c.id) && !inTree.has(c.id))
  if (orphans.length > 0) {
    const root = comps.find(c => c.id === 'root')
    if (!root) return comps
    const existing: string[] = Array.isArray(root.children) ? root.children : []
    const mergedChildren = [...existing, ...orphans.map(c => c.id)]
    return comps.map(c => c.id === 'root' ? { ...c, children: mergedChildren } : c)
  }

  return comps
}

// ---- 工具 ----

/** 按 JSON Pointer 路径设置嵌套对象的值 */
export function setAtPath(obj: Record<string, any>, path: string, value: any) {
  const segments = path.split('/').filter(p => p.length > 0)
  let cur = obj
  for (let i = 0; i < segments.length - 1; i++) {
    if (!(segments[i] in cur)) cur[segments[i]] = {}
    cur = cur[segments[i]]
  }
  if (segments.length > 0) {
    cur[segments[segments.length - 1]] = value
  }
}

/** 从 a2ui 消息数组中提取 dataModel（兼容旧 dataModelUpdate 和新 updateDataModel） */
export function extractDataFromMessages(messages: A2UIMessage[]): Record<string, any> {
  const data: Record<string, any> = {}

  // 新格式：逐字段 updateDataModel
  for (const msg of messages) {
    if ('updateDataModel' in msg && msg.updateDataModel) {
      const { path, value } = msg.updateDataModel as { path?: string; value?: unknown }
      if (path && value !== undefined) setAtPath(data, path, value)
    }
  }

  // 旧格式：dataModelUpdate.data 整体写入
  if (Object.keys(data).length === 0) {
    const dm = messages.find((m): m is LegacyMessage => 'dataModelUpdate' in m)
    if (dm?.dataModelUpdate?.data) {
      Object.assign(data, dm.dataModelUpdate.data)
    }
  }

  return data
}

/** 将 dataModel 对象转为标准 v0.9 逐字段 updateDataModel 消息 */
export function dataModelToV09Messages(surfaceId: string, data: Record<string, any>): V09Message[] {
  const msgs: V09Message[] = []
  for (const [key, value] of Object.entries(data)) {
    msgs.push({ version: 'v0.9' as const, updateDataModel: { surfaceId, path: `/${key}`, value } })
  }
  return msgs
}

// ---- 多页面支持 ----

/**
 * 将 A2UI 消息数组中的所有 surfaceId 替换为目标 ID
 * Agent 生成的每页消息都使用 surfaceId: "main"，加载时需为每页分配唯一 surfaceId
 */
export function rewriteSurfaceId(messages: A2UIMessage[], newId: string): A2UIMessage[] {
  return messages.map((msg: any) => {
    const updated: any = {}
    for (const [key, val] of Object.entries(msg)) {
      if (val && typeof val === 'object' && 'surfaceId' in val) {
        updated[key] = { ...val, surfaceId: newId }
      } else {
        updated[key] = val
      }
    }
    return updated
  })
}

/**
 * 将任意输入格式归一化为 { pages, shared } 结构
 * - 有 pages key → 多页面格式
 * - 无 pages key → 视为单页面，自动包装为 { main: {...} }
 */
export function normalizeToPages(input: Record<string, any>): NormalizedPages {
  if (input && typeof input === 'object' && 'pages' in input) {
    return { pages: input.pages, shared: input.shared }
  }
  return {
    pages: { main: { a2ui: input.a2ui ?? [], logic: input.logic ?? { reactions: [] } } },
  }
}

// ---- 反向提取（用于调试器/导出） ----

/** SurfaceModel 的调试器访问子集 */
interface SurfaceLike {
  componentsModel?: { entries?: Iterable<[string, { id: string; type: string; properties: Record<string, unknown> }]> }
  dataModel?: { get: (path: string) => Record<string, unknown> | undefined }
}

/** 将 v0.9 扁平格式还原为简化格式的组件列表 */
export function toLegacyComponents(v09Components: ComponentNode[]): ComponentNode[] {
  return v09Components.map(c => {
    const { id, component, ...rest } = c
    return { id, component: component ?? c.type, props: rest }
  })
}

/** 从 SurfaceModel 提取组件列表（简化格式，调试器用） */
export function extractComponents(surface: SurfaceLike): ComponentNode[] {
  try {
    const comps: any[] = []
    if (surface?.componentsModel?.entries) {
      for (const [, model] of surface.componentsModel.entries) {
        comps.push({
          id: model.id,
          component: model.type,
          props: { ...model.properties },
        })
      }
    }
    return comps
  } catch {
    return []
  }
}

/** 从 SurfaceModel 提取 dataModel 原始数据 */
export function extractDataModel(surface: SurfaceLike): Record<string, unknown> {
  try {
    return surface?.dataModel?.get('/') ?? {}
  } catch {
    return {}
  }
}
