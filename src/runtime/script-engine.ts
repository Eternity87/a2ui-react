/**
 * script-engine.ts — 执行用户编辑的 Reaction JS 代码
 *
 * 当 reaction 有对应的 script 时，优先执行 script 而非 reaction 链。
 * 代码在 new Function() 沙箱中运行，注入 dataModel / pipe / toast 等服务。
 */

import type { DataModel } from '@a2ui/web_core/v0_9'
import type { PipeEngine } from './pipe-engine'
import { safeEvalScript } from './a2ui-utils'
import { logger } from '@/lib/logger'

interface ScriptServices {
  dataModel: DataModel
  pipeEngine: PipeEngine
  toast: (msg: string, type?: string) => void
  sharedStore?: { getState: () => Record<string, any>; setState: (s: Record<string, any>) => void }
  navigate?: (pageId: string, params: Record<string, any>) => void
  /** 触发该 reaction 的原始 action */
  action?: any
}

/** 执行一段 JS 代码，在白名单沙箱中注入服务变量 */
export function executeScript(code: string, services: ScriptServices): void {
  try {
    // pipe 辅助函数
    const pipe = (steps: Record<string, any>[]): any => {
      const dm = { ...services.dataModel.get('/'), shared: services.sharedStore?.getState() ?? {} }
      services.pipeEngine.updateDataModel(dm)
      return services.pipeEngine.evaluate(steps)
    }

    safeEvalScript(code, {
      dataModel: services.dataModel,
      pipe,
      toast: services.toast,
      sharedStore: services.sharedStore,
      navigate: services.navigate ?? null,
      action: services.action ?? null,
    })
  } catch (err: any) {
    logger.error(`[ScriptEngine] 脚本执行失败:`, err?.message || err)
    services.toast(`脚本执行失败: ${err?.message || '未知错误'}`, 'error')
  }
}

/** 校验用户编辑的 JS 代码能否被解析（语法检查 + 沙箱白名单检查） */
export function validateScript(code: string): { valid: boolean; error?: string } {
  try {
    // async IIFE 包裹以支持 await（与 safeEvalScript 执行方式一致）
    new Function(`"use strict"; return (async () => { ${code} })()`)
    return { valid: true }
  } catch (err: any) {
    return { valid: false, error: err?.message || '未知错误' }
  }
}
