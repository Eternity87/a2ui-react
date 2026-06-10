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

// ---- 类型定义 ----

/** Agent 生成的简化格式消息 */
interface LegacyMessage {
  beginRendering?: { surfaceId: string; catalogId: string }
  surfaceUpdate?: { surfaceId: string; components: any[] }
  dataModelUpdate?: { surfaceId: string; data: Record<string, any> }
}

/** Google 官方 v0.9 标准消息 */
interface V09Message {
  version?: 'v0.9'
  createSurface?: { surfaceId: string; catalogId: string; sendDataModel?: boolean }
  updateComponents?: { surfaceId: string; components: any[] }
  updateDataModel?: { surfaceId: string; path?: string; value?: any }
  deleteSurface?: { surfaceId: string }
}

type InputFormat = 'legacy' | 'v09' | 'v08'

// ---- 格式检测 ----

/**
 * 检测输入消息的格式类型
 *
 * 策略：检查第一条消息的字段名
 * - beginRendering/surfaceUpdate → 我们自己的简化格式
 * - createSurface/updateComponents  → Google 官方 v0.9
 * - 其他                            → 假定为 v0.8（透传）
 */
export function detectFormat(messages: any[]): InputFormat {
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
  messages: any[],
  options?: { sendDataModel?: boolean; catalogId?: string },
): V09Message[] {
  const format = detectFormat(messages)
  switch (format) {
    case 'legacy': return legacyToV09(messages as LegacyMessage[], options)
    case 'v09':   return messages as V09Message[]
    case 'v08':   return v08ToV09(messages)
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
  legacyMessages: LegacyMessage[],
  options?: { sendDataModel?: boolean; catalogId?: string },
): V09Message[] {
  const result: V09Message[] = []
  const catalogId = options?.catalogId ?? 'basic'

  for (const msg of legacyMessages) {
    if (msg.beginRendering) {
      result.push({
        createSurface: {
          surfaceId: msg.beginRendering.surfaceId,
          catalogId,
          sendDataModel: options?.sendDataModel ?? true,
        },
      })
    }

    if (msg.surfaceUpdate) {
      // 扁平化：将嵌套的 props 展开到组件顶层
      let comps = msg.surfaceUpdate.components.map(c => ({
        id: c.id,
        component: c.component,
        ...(c.props || {}),
      }))
      // A2uiSurface 要求必须有 id="root" 的根组件，自动补全
      comps = ensureRootComponent(comps)
      result.push({
        updateComponents: { surfaceId: msg.surfaceUpdate.surfaceId, components: comps },
      })
    }

    if (msg.dataModelUpdate) {
      // 旧格式：整体写入到根路径
      const { surfaceId, data } = msg.dataModelUpdate
      if (data && Object.keys(data).length > 0) {
        result.push({ updateDataModel: { surfaceId, path: '/', value: data } })
      }
    }

    if (msg.updateDataModel) {
      // 新标准格式：逐字段透传
      result.push({ updateDataModel: msg.updateDataModel })
    }
  }

  return result
}

/** v0.8 → v0.9 转换（当前为透传，后续可按需添加字段映射） */
function v08ToV09(messages: any[]): V09Message[] {
  return messages
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
export function ensureRootComponent(comps: any[]): any[] {
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
    inTree.add(id)
    const comp = comps.find(c => c.id === id)
    if (comp && Array.isArray(comp.children)) {
      for (const cid of comp.children) collectTree(cid)
    }
  }
  collectTree('root')

  // 将孤儿根节点（不被任何组件引用、也不在 root 树中）挂到 root 下
  const orphans = comps.filter(c => !childIds.has(c.id) && !inTree.has(c.id))
  if (orphans.length > 0) {
    const root = comps.find(c => c.id === 'root')!
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
export function extractDataFromMessages(messages: any[]): Record<string, any> {
  const data: Record<string, any> = {}

  // 新格式：逐字段 updateDataModel
  for (const msg of messages) {
    if ('updateDataModel' in msg) {
      const { path, value } = msg.updateDataModel
      if (path && value !== undefined) setAtPath(data, path, value)
    }
  }

  // 旧格式：dataModelUpdate.data 整体写入
  if (Object.keys(data).length === 0) {
    const dm = messages.find((m: any) => 'dataModelUpdate' in m)
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
    msgs.push({ updateDataModel: { surfaceId, path: `/${key}`, value } })
  }
  return msgs
}

// ---- 反向提取（用于调试器/导出） ----

/** 将 v0.9 扁平格式还原为简化格式的组件列表 */
export function toLegacyComponents(v09Components: any[]): any[] {
  return v09Components.map(c => {
    const { id, component, ...rest } = c
    return { id, component: component ?? c.type, props: rest }
  })
}

/** 从 SurfaceModel 提取组件列表（简化格式，调试器用） */
export function extractComponents(surface: any): any[] {
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
export function extractDataModel(surface: any): Record<string, any> {
  try {
    return surface?.dataModel?.get('/') ?? {}
  } catch {
    return {}
  }
}
