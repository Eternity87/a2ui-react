/**
 * page-state.ts — 页面状态纯逻辑（无 React / 浏览器依赖）
 *
 * 负责子页面注册表管理，与任何 UI 框架解耦，可独立测试。
 */

import type { PageDef } from './a2ui-adapter'

// ===== 子页面注册表 =====

const childPageRegistry = new Map<string, PageDef>()

export function registerChildPage(parentPageId: string, childName: string, def: PageDef) {
  childPageRegistry.set(`${parentPageId}/${childName}`, def)
}

export function unregisterChildPage(parentPageId: string, childName: string) {
  childPageRegistry.delete(`${parentPageId}/${childName}`)
}

export function unregisterAllChildPages(parentPageId: string) {
  const prefix = `${parentPageId}/`
  for (const key of childPageRegistry.keys()) {
    if (key.startsWith(prefix)) childPageRegistry.delete(key)
  }
}

export function getChildPage(parentPageId: string, childName: string): PageDef | undefined {
  return childPageRegistry.get(`${parentPageId}/${childName}`)
}
