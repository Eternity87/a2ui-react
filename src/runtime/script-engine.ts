/**
 * script-engine.ts — 执行用户编辑的 Reaction JS 代码
 *
 * 当 reaction 有对应的 script 时，优先执行 script 而非 reaction 链。
 * 代码在 new Function() 沙箱中运行，注入 dataModel / pipe / toast 等服务。
 */

import type { DataModel } from '@a2ui/web_core/v0_9'
import type { PipeEngine } from './pipe-engine'
import { validateExpression } from './a2ui-utils'

interface ScriptServices {
  dataModel: DataModel
  pipeEngine: PipeEngine
  toast: (msg: string, type?: string) => void
  sharedStore?: { getState: () => Record<string, any>; setState: (s: Record<string, any>) => void }
  navigate?: (pageId: string, params: Record<string, any>) => void
  /** 触发该 reaction 的原始 action */
  action?: any
}

/** 执行一段 JS 代码，注入服务变量 */
export function executeScript(code: string, services: ScriptServices): void {
  try {
    // pipe 辅助函数
    const pipe = (steps: Record<string, any>[]): any => {
      const dm = { ...services.dataModel.get('/'), shared: services.sharedStore?.getState() ?? {} }
      services.pipeEngine.updateDataModel(dm)
      return services.pipeEngine.evaluate(steps)
    }

    // 包装代码为函数体并执行
    const fn = new Function(
      'dataModel',
      'pipe',
      'toast',
      'sharedStore',
      'navigate',
      'action',
      `"use strict";\n${code}`
    )
    fn(
      services.dataModel,
      pipe,
      services.toast,
      services.sharedStore,
      services.navigate ?? null,
      services.action ?? null,
    )
  } catch (err: any) {
    console.error(`[ScriptEngine] 脚本执行失败:`, err?.message || err)
    services.toast(`脚本执行失败: ${err?.message || '未知错误'}`, 'error')
  }
}

/** 校验用户编辑的 JS 代码安全性 */
export function validateScript(code: string): { valid: boolean; error?: string } {
  try {
    validateExpression(code, 'ScriptEngine')
    // 确保能被 new Function 解析
    new Function(`"use strict";\n${code}`)
    return { valid: true }
  } catch (err: any) {
    return { valid: false, error: err?.message || '未知错误' }
  }
}
