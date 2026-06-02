import type { PipeEngine } from './pipe-engine'

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

type DataModelListener = () => void

/**
 * 简易响应式 dataModel store。
 * 替代 Vue reactive() — 基于 Proxy 拦截 set 操作并通知订阅者。
 */
export class DataModelStore {
  private data: Record<string, any>
  private listeners = new Map<string, Set<DataModelListener>>()
  private wildcardListeners = new Set<DataModelListener>()

  constructor(initial: Record<string, any> = {}) {
    this.data = { ...initial }
    this.makeReactive()
  }

  private makeReactive() {
    const self = this
    this.data = new Proxy(this.data, {
      set(target, key: string, value) {
        const old = target[key]
        target[key] = value
        if (old !== value) {
          self.notify(key)
          self.wildcardListeners.forEach(fn => fn())
        }
        return true
      },
      deleteProperty(target, key: string) {
        delete target[key]
        self.notify(key)
        self.wildcardListeners.forEach(fn => fn())
        return true
      },
    })
  }

  private notify(key: string) {
    this.listeners.get(key)?.forEach(fn => fn())
  }

  /** 获取原始数据（用于序列化） */
  getRaw(): Record<string, any> {
    return { ...this.data }
  }

  /** 获取路径对应的值 */
  get(path: string): any {
    const clean = path.replace(/^\/(data|ui|errors)\//, '')
    const parts = clean.split(/[\/.]/)
    let cur: any = this.data
    for (const p of parts) {
      if (cur === null || cur === undefined) return undefined
      cur = cur[p]
    }
    return cur
  }

  /** 设置路径对应的值 */
  set(path: string, value: any) {
    const clean = path.replace(/^\/(data|ui|errors)\//, '')
    const parts = clean.split(/[\/.]/)
    let cur: any = this.data
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in cur)) cur[parts[i]] = {}
      cur = cur[parts[i]]
    }
    cur[parts[parts.length - 1]] = value
  }

  /** 批量替换全部数据 */
  replaceAll(newData: Record<string, any>) {
    const oldKeys = Object.keys(this.data)
    // 删除旧 key
    for (const k of oldKeys) delete this.data[k]
    // 设置新 key
    Object.assign(this.data, newData)
    // 通知所有
    oldKeys.forEach(k => this.notify(k))
    Object.keys(newData).forEach(k => this.notify(k))
    this.wildcardListeners.forEach(fn => fn())
  }

  /** 订阅特定 key 的变化 */
  subscribe(key: string, listener: DataModelListener): () => void {
    if (!this.listeners.has(key)) this.listeners.set(key, new Set())
    this.listeners.get(key)!.add(listener)
    return () => { this.listeners.get(key)?.delete(listener) }
  }

  /** 订阅所有变化 */
  subscribeAll(listener: DataModelListener): () => void {
    this.wildcardListeners.add(listener)
    return () => { this.wildcardListeners.delete(listener) }
  }

  /** 获取代理对象（传给 pipe-engine 等依赖 dataModel 的模块） */
  get proxy(): Record<string, any> {
    return this.data
  }
}

/**
 * Reaction 引擎 — React/Zustand 版本。
 *
 * 与 Vue 版的差异：
 * - Vue reactive() + watch() → DataModelStore Proxy + 手动订阅
 * - Vue nextTick → setTimeout(fn, 0) 或无等待直接调用
 */
export class ReactionEngine {
  private unsubscribers: (() => void)[] = []

  constructor(
    private store: DataModelStore,
    private reactions: Reaction[],
    private services: ReactionServices,
  ) {}

  /** 启动引擎：注册 init/change 事件的监听 */
  boot() {
    for (const r of this.reactions) {
      if (r.when.event === 'init') {
        // init 事件：下一个微任务执行一次
        setTimeout(() => this.executeChain(r), 0)
        continue
      }
      if (r.when.event === 'click') continue

      // change / blur 事件：订阅路径变化
      const field = r.when.field
      const parts = field.replace(/^\/(data|ui|errors)\//, '').split(/[\/.]/)
      const firstKey = parts[0]

      const unsub = this.store.subscribe(firstKey, () => {
        const newVal = this.store.get(field)
        if (newVal === undefined || newVal === null || newVal === '') return
        this.executeChain(r, { newVal, oldVal: undefined })
      })
      this.unsubscribers.push(unsub)
    }
  }

  /** 手动触发 click 事件对应的 Reaction */
  triggerReaction(reactionId: string) {
    const r = this.reactions.find(r => r.id === reactionId)
    if (r) this.executeChain(r)
  }

  /** 销毁引擎，移除所有订阅 */
  destroy() {
    this.unsubscribers.forEach(fn => fn())
    this.unsubscribers = []
  }

  // ===== 内部实现 =====

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

  private async executeAction(action: Action, ctx: any) {
    switch (action.type) {
      case 'apiRequest': {
        const resolvePointer = (v: any) =>
          typeof v === 'string' && v.startsWith('/') ? this.store.get(v) : v

        const params: any = {}
        if (action.params) {
          for (const [k, v] of Object.entries(action.params)) {
            params[k] = resolvePointer(v)
          }
        }

        const body: any = {}
        if (action.body) {
          for (const [k, v] of Object.entries(action.body)) {
            body[k] = resolvePointer(v)
          }
        }

        const resp = await this.services.apiExecutor({
          url: action.url,
          method: action.method ?? 'GET',
          params,
          body: Object.keys(body).length > 0 ? body : undefined,
        })
        this.store.set(action.outputTo, resp.data)
        ctx.lastResponse = resp.data
        break
      }
      case 'setValues': {
        for (const [target, source] of Object.entries(action.map as Record<string, any>)) {
          if (typeof source === 'object' && source !== null && 'pipe' in source) {
            // pipe 引擎需要 dataModel 代理对象来 get 路径
            const engine = this.services.pipeEngine
            const origGet = this.store.get.bind(this.store)
            ;(engine as any).dataModel = this.store.proxy
            const result = engine.evaluate(source.pipe)
            this.store.set(target, result)
          } else if (typeof source === 'string' && source.startsWith('/')) {
            this.store.set(target, this.store.get(source))
          } else {
            this.store.set(target, source)
          }
        }
        break
      }
      case 'validate': {
        const errors: Record<string, string> = {}
        for (const rule of action.rules) {
          const val = this.store.get(rule.field)
          if (rule.required && (val === undefined || val === null || val === '')) {
            errors[rule.field] = rule.message
          }
        }
        const errorTarget = action.errorTarget ?? '/errors'
        this.store.set(errorTarget, Object.keys(errors).length > 0 ? errors : null)
        if (Object.keys(errors).length > 0) {
          this.services.toast(Object.values(errors)[0] as string, 'warning')
          throw new Error('validation_failed')
        }
        break
      }
      case 'toast': {
        this.services.toast(action.message, action.variant ?? 'info')
        break
      }
      case 'cascade': {
        this.store.set(action.target, undefined)
        break
      }
      case 'condition': {
        for (const branch of action.branches) {
          const match = branch.if ? this.evalCondition(branch.if) : true
          if (match) {
            for (const a of branch.then) {
              await this.executeAction(a, ctx)
            }
            return
          }
        }
        break
      }
    }
  }

  private evalCondition(expr: string): boolean {
    try {
      const resolved = expr.replace(/\$([\w][\w.]*)/g, (_, path: string) => {
        const pointerPath = `/data/${path.replace(/\./g, '/')}`
        const val = this.store.get(pointerPath)
        return JSON.stringify(val)
      })
      return new Function(`"use strict"; return (${resolved})`)()
    } catch {
      return false
    }
  }
}
