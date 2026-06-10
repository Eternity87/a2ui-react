/**
 * reaction-engine.ts — Reaction 引擎
 *
 * 【在架构中的角色】
 * 定义了 A2UI 的业务逻辑层：Reaction = when(触发条件) + then(执行动作链)
 * 基于 @a2ui/web_core 的 DataModel Signal 订阅机制。
 *
 * 【Reaction 是什么】
 * Reaction = when(触发条件) + then(执行动作链)
 *
 * 触发条件（when）：
 * - { field: "/keyword", event: "init" }   → 页面加载时执行一次
 * - { field: "/productCategory", event: "change" } → 字段值变化时执行
 * - { field: "searchBtn", event: "click" }  → 按钮点击时执行
 *
 * 动作类型（then）：
 * - apiRequest: 调用 Mock API / 后端接口
 * - setValues:  写入 dataModel（支持 pipe 管道计算）
 * - validate:   表单校验
 * - toast:      提示消息
 * - cascade:    级联清空（如选择大类后清空子类）
 * - condition:  条件分支（if/then）
 *
 * 【订阅机制】
 * - init 事件：setTimeout 执行一次
 * - change 事件：DataModel.subscribe(path) 响应字段变化
 * - click 事件：外部通过 triggerReaction(id) 调用
 */

import type { DataModel } from '@a2ui/web_core/v0_9'
import type { PipeEngine } from './pipe-engine'
import { dmPath, validateExpression } from './a2ui-utils'

// ================================================================
//  ReactionEngine
// ================================================================

interface Reaction {
  id: string
  when: { field: string; event: string }
  then: Action[]
}

interface Action {
  type: string
  [key: string]: any
}

interface ReactionServices {
  apiExecutor: (req: { url: string; method: string; params?: any; body?: any }) => Promise<{ data: any }>
  pipeEngine: PipeEngine
  toast: (msg: string, type?: string) => void
}

/**
 * Reaction 引擎（官方 DataModel 版本）
 *
 * 三种触发方式：
 * 1. init   → boot() 时 setTimeout 执行
 * 2. change → DataModel.subscribe(path) 响应字段变化
 * 3. click  → 外部调用 triggerReaction(id)（由 Button dispatchAction 触发）
 */
export class ReactionEngine {
  private unsubscribers: (() => void)[] = []

  constructor(
    private dataModel: DataModel,
    private reactions: Reaction[],
    private services: ReactionServices,
  ) {}

  boot() {
    for (const r of this.reactions) {
      if (r.when.event === 'init') {
        // init 事件：下一个微任务执行一次
        setTimeout(() => this.executeChain(r), 0)
        continue
      }
      if (r.when.event === 'click') continue

      // change/blur 事件：DataModel 信号订阅
      const field = dmPath(r.when.field)
      const sub = this.dataModel.subscribe(field, (newVal: any) => {
        // 空值跳过，避免初始化时误触发
        if (newVal === undefined || newVal === null || newVal === '') return
        this.executeChain(r, { newVal, oldVal: undefined })
      })
      this.unsubscribers.push(() => sub.unsubscribe())
    }
  }

  triggerReaction(reactionId: string) {
    const r = this.reactions.find(r => r.id === reactionId)
    if (r) this.executeChain(r)
  }

  destroy() {
    this.unsubscribers.forEach(fn => fn())
    this.unsubscribers = []
  }

  // ===== 动作链执行 =====

  /** 顺序执行 Reaction 的 then 动作链（await 保证顺序） */
  private async executeChain(reaction: Reaction, trigger?: { newVal: any; oldVal: any }) {
    const ctx = { trigger, lastResponse: null as any }
    try {
      for (const action of reaction.then) {
        await this.executeAction(action, ctx)
      }
    } catch (err: any) {
      if (err?.message !== 'validation_failed') {
        console.error(`[ReactionEngine] "${reaction.id}" failed:`, err?.message || err)
        this.services.toast(`操作失败: ${err?.message || '未知错误'}`, 'error')
      }
    }
  }

  /** 执行单个 Action */
  private async executeAction(action: Action, ctx: any) {
    switch (action.type) {
      case 'apiRequest': {
        // 解析参数中的路径引用
        const resolvePointer = (v: any) =>
          typeof v === 'string' && v.startsWith('/') ? this.dataModel.get(dmPath(v)) : v

        const params: any = {}
        if (action.params)
          for (const [k, v] of Object.entries(action.params)) params[k] = resolvePointer(v)

        const body: any = {}
        if (action.body)
          for (const [k, v] of Object.entries(action.body)) body[k] = resolvePointer(v)

        const resp = await this.services.apiExecutor({
          url: action.url, method: action.method ?? 'GET',
          params,
          body: Object.keys(body).length > 0 ? body : undefined,
        })
        this.dataModel.set(dmPath(action.outputTo), resp.data)
        ctx.lastResponse = resp.data
        break
      }
      case 'setValues': {
        for (const [target, source] of Object.entries(action.map as Record<string, any>)) {
          if (typeof source === 'object' && source !== null && 'pipe' in source) {
            // pipe 管道计算：get → filter → map → compute
            const engine = this.services.pipeEngine
            engine.updateDataModel(this.dataModel.get('/') ?? {})
            const result = engine.evaluate(source.pipe)
            this.dataModel.set(dmPath(target), result)
          } else if (typeof source === 'string' && source.startsWith('/')) {
            // 路径引用 → 复制值
            this.dataModel.set(dmPath(target), this.dataModel.get(dmPath(source)))
          } else {
            // 字面量直接写入
            this.dataModel.set(dmPath(target), source)
          }
        }
        break
      }
      case 'validate': {
        const errors: Record<string, string> = {}
        for (const rule of action.rules) {
          const val = this.dataModel.get(dmPath(rule.field))
          if (rule.required && (val === undefined || val === null || val === ''))
            errors[rule.field] = rule.message
        }
        this.dataModel.set(dmPath(action.errorTarget ?? '/errors'), Object.keys(errors).length > 0 ? errors : null)
        if (Object.keys(errors).length > 0) {
          this.services.toast(Object.values(errors)[0] as string, 'warning')
          throw new Error('validation_failed')  // 中断链式执行
        }
        break
      }
      case 'toast':
        this.services.toast(action.message, action.variant ?? 'info')
        break
      case 'cascade':
        // 清空目标字段（联动场景：选大类→清空子类）
        this.dataModel.set(dmPath(action.target), undefined)
        break
      case 'condition': {
        // 条件分支：if 表达式匹配 → 执行 then
        for (const branch of action.branches) {
          const match = branch.if ? this.evalCondition(branch.if) : true
          if (match) {
            for (const a of branch.then) await this.executeAction(a, ctx)
            return
          }
        }
        break
      }
    }
  }

  /**
   * 安全求解条件表达式
   * 例: "$productDetail.status === 'discontinued'" → 替换 $ 变量为实际值后 eval
   */
  private evalCondition(expr: string): boolean {
    try {
      validateExpression(expr, 'evalCondition')
      const resolved = expr.replace(/\$([\w][\w.]*)/g, (_, path: string) => {
        const val = this.dataModel.get(dmPath(`/${path.replace(/\./g, '/')}`))
        return JSON.stringify(val)
      })
      return new Function(`"use strict"; return (${resolved})`)()
    } catch { return false }
  }
}
