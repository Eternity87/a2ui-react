/**
 * 将当前的 simplified A2UI JSON 格式转换为 v0.9 标准消息格式。
 *
 * 当前格式:
 *   { beginRendering: {...}, surfaceUpdate: {...}, dataModelUpdate: {...} }
 *
 * v0.9 格式:
 *   { version: "v0.9", createSurface: {...} }
 *   { version: "v0.9", updateComponents: {...} }
 *   { version: "v0.9", updateDataModel: {...} }  (每条消息一个字段)
 */

interface LegacyMessage {
  beginRendering?: { surfaceId: string; catalogId: string }
  surfaceUpdate?: { surfaceId: string; components: any[] }
  dataModelUpdate?: { surfaceId: string; data: Record<string, any> }
}

interface V09Message {
  version: 'v0.9'
  createSurface?: { surfaceId: string; catalogId: string; sendDataModel?: boolean }
  updateComponents?: { surfaceId: string; components: any[] }
  updateDataModel?: { surfaceId: string; path: string; value: any }
  deleteSurface?: { surfaceId: string }
}

/**
 * 将当前简化格式的 A2UI JSON 数组转换为 v0.9 标准消息数组。
 */
export function legacyToV09(
  legacyMessages: LegacyMessage[],
  options?: { sendDataModel?: boolean },
): V09Message[] {
  const result: V09Message[] = []

  for (const msg of legacyMessages) {
    if (msg.beginRendering) {
      result.push({
        version: 'v0.9',
        createSurface: {
          surfaceId: msg.beginRendering.surfaceId,
          catalogId: msg.beginRendering.catalogId,
          sendDataModel: options?.sendDataModel ?? true,
        },
      })
    }

    if (msg.surfaceUpdate) {
      result.push({
        version: 'v0.9',
        updateComponents: {
          surfaceId: msg.surfaceUpdate.surfaceId,
          components: msg.surfaceUpdate.components,
        },
      })
    }

    if (msg.dataModelUpdate) {
      const { surfaceId, data } = msg.dataModelUpdate
      for (const [key, value] of Object.entries(data)) {
        result.push({
          version: 'v0.9',
          updateDataModel: {
            surfaceId,
            path: `/${key}`,
            value,
          },
        })
      }
    }
  }

  return result
}

/**
 * 从 v0.9 SurfaceModel 中提取当前项目所需的扁平 dataModel 对象。
 */
export function extractDataModel(surfaceModel: any): Record<string, any> {
  const data: Record<string, any> = {}
  try {
    const raw = surfaceModel?.dataModel?.value
    if (raw && typeof raw === 'object') {
      Object.assign(data, raw)
    }
  } catch {
    // ignore extraction errors
  }
  return data
}

/**
 * 从 v0.9 SurfaceModel 中提取组件列表。
 */
export function extractComponents(surfaceModel: any): any[] {
  try {
    return surfaceModel?.componentModel?.value?.components ?? []
  } catch {
    return []
  }
}
