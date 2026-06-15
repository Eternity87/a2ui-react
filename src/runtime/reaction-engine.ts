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

/** Zustand store 的最小接口（ReactionEngine 只用 getState/setState） */
interface SharedStoreApi {
  getState: () => Record<string, any>
  setState: (partial: Record<string, any>) => void
}

interface ReactionServices {
  apiExecutor: (req: { url: string; method: string; params?: any; body?: any }) => Promise<{ data: any }>
  pipeEngine: PipeEngine
  toast: (msg: string, type?: string) => void
  /** 跨页面导航（由 PageProvider 注入） */
  navigate?: (pageId: string, params: Record<string, any>) => void
  /** Zustand shared store（用于 /shared/ 路径拦截） */
  sharedStore?: SharedStoreApi
  /** 父页面 DataModel（用于子 surface 的 /parent/ 路径写回父 DataModel） */
  parentDataModel?: DataModel
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
  private previousValues = new Map<string, any>()
  private static MAX_PREVIOUS_VALUES = 200

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
        const oldVal = this.previousValues.get(field)
        if (this.previousValues.size >= ReactionEngine.MAX_PREVIOUS_VALUES) {
          this.previousValues.clear()
        }
        this.previousValues.set(field, newVal)
        this.executeChain(r, { newVal, oldVal })
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
    this.previousValues.clear()
  }

  // ===== 路径拦截：/shared/ /navParams/ /parent/ → 不同目标 =====

  /** 解析值：/shared/ /navParams/ → Zustand，/parent/ → 父 DataModel，其他走自身 DataModel */
  private resolveValue(pointer: string): any {
    if (pointer.startsWith('/shared/') || pointer.startsWith('/navParams/')) {
      const store = this.services.sharedStore
      if (!store) return undefined
      const state = store.getState() as Record<string, any>
      if (pointer.startsWith('/navParams/')) {
        const key = pointer.replace('/navParams/', '')
        const val = state.navParams?.[key]
        return typeof val === 'function' ? undefined : val
      }
      const key = pointer.replace('/shared/', '')
      const val = state[key]
      return typeof val === 'function' ? undefined : val
    }
    if (pointer.startsWith('/parent/') && this.services.parentDataModel) {
      const key = pointer.replace('/parent/', '')
      return this.services.parentDataModel.get(`/${key}`)
    }
    return this.dataModel.get(dmPath(pointer))
  }

  /** 写入值：/shared/ → Zustand，/parent/ → 父 DataModel，其他走自身 DataModel */
  private setValue(pointer: string, value: any) {
    if (pointer.startsWith('/shared/')) {
      const key = pointer.replace('/shared/', '')
      // 基本校验：shared store 只接受可序列化的纯数据，拒绝函数/类实例
      if (!isSerializableValue(value)) {
        console.warn(`[ReactionEngine] Ignored non-serializable value for /shared/${key}`)
        return
      }
      this.services.sharedStore?.setState({ [key]: value } as any)
      return
    }
    if (pointer.startsWith('/parent/') && this.services.parentDataModel) {
      const key = pointer.replace('/parent/', '')
      this.services.parentDataModel.set(`/${key}`, value)
      return
    }
    this.dataModel.set(dmPath(pointer), value)
  }

  /** 获取 shared store 的纯数据快照（注入到 pipe 的 dataModel 中） */
  private getSharedSnapshot(): Record<string, any> {
    const store = this.services.sharedStore
    if (!store) return {}
    const state = store.getState()
    const result: Record<string, any> = {}
    for (const [k, v] of Object.entries(state)) {
      if (typeof v !== 'function') result[k] = v
    }
    return result
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
          typeof v === 'string' && v.startsWith('/') ? this.resolveValue(v) : v

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
        this.setValue(action.outputTo, resp.data)
        ctx.lastResponse = resp.data
        break
      }
      case 'setValues': {
        for (const [target, source] of Object.entries(action.map as Record<string, any>)) {
          if (typeof source === 'object' && source !== null && 'pipe' in source) {
            // pipe 管道：将 shared 注入 dataModel 快照，pipe 的 get 可直接读 /shared/xxx
            const engine = this.services.pipeEngine
            const dm = { ...this.dataModel.get('/'), shared: this.getSharedSnapshot() }
            engine.updateDataModel(dm)
            const result = engine.evaluate(source.pipe)
            this.setValue(target, result)
          } else if (typeof source === 'string' && source.startsWith('/')) {
            // 路径引用 → 复制值
            this.setValue(target, this.resolveValue(source))
          } else {
            // 字面量直接写入
            this.setValue(target, source)
          }
        }
        break
      }
      case 'validate': {
        const errors: Record<string, string> = {}
        for (const rule of action.rules) {
          const val = this.resolveValue(rule.field)
          if (rule.required && (val === undefined || val === null || val === ''))
            errors[rule.field] = rule.message
        }
        this.setValue(action.errorTarget ?? '/errors', Object.keys(errors).length > 0 ? errors : null)
        if (Object.keys(errors).length > 0) {
          this.services.toast(Object.values(errors)[0] as string, 'warning')
          throw new Error('validation_failed')
        }
        break
      }
      case 'toast':
        this.services.toast(this.resolveTemplate(action.message), action.variant ?? 'info')
        break
      case 'cascade':
        this.setValue(action.target, undefined)
        break
      case 'navigate': {
        if (!this.services.navigate) {
          console.warn('[ReactionEngine] navigate action ignored: no navigate callback registered')
          break
        }
        const resolved: Record<string, any> = {}
        if (action.params) {
          for (const [k, v] of Object.entries(action.params)) {
            resolved[k] = typeof v === 'string' && v.startsWith('/')
              ? this.resolveValue(v)
              : v
          }
        }
        this.services.navigate(action.pageId, resolved)
        break
      }
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

  /** 解析模板字符串中的 ${/xxx} 路径引用为实际值 */
  private resolveTemplate(message: string): string {
    return message.replace(/\$\{\/([^}]+)\}/g, (_, path: string) => {
      const val = this.resolveValue(`/${path.trim()}`)
      return val !== undefined && val !== null ? String(val) : ''
    })
  }

  /**
   * 安全求解条件表达式
   * $xxx → 从 DataModel 取值；shared.xxx → 从 Zustand 取值（有无 $ 前缀均可）
   */
  private evalCondition(expr: string): boolean {
    try {
      validateExpression(expr, 'evalCondition')
      // Step 1: 替换 $xxx 和 shared.xxx 模式
      const resolved = expr
        .replace(/\$?shared\.([\w]+)/g, (_, key: string) => {
          const state = this.services.sharedStore?.getState() as Record<string, any>
          return JSON.stringify(state?.[key])
        })
        .replace(/\$([\w][\w.]*)/g, (_, path: string) => {
          // $ 前缀（非 shared）→ DataModel
          if (path.startsWith('shared.')) return '_already_handled_'
          const val = this.dataModel.get(dmPath(`/${path.replace(/\./g, '/')}`))
          return JSON.stringify(val)
        })
      return new Function(`"use strict"; return (${resolved})`)()
    } catch { return false }
  }
}

/** 检查值是否可安全序列化（纯数据，非函数/类实例） */
function isSerializableValue(v: any): boolean {
  if (v === null || v === undefined) return true
  const t = typeof v
  if (t === 'function' || t === 'symbol') return false
  if (t === 'object') {
    if (Array.isArray(v)) return v.every(isSerializableValue)
    if (Object.getPrototypeOf(v) !== Object.prototype) return false
    return Object.values(v).every(isSerializableValue)
  }
  return true
}
