/**
 * pipe-engine.ts — 管道转换引擎
 *
 * 【在架构中的角色】
 * Reaction 的 setValues 动作可通过 pipe 对数据进行转换计算。
 * Pipe 是一个链式操作序列：get → filter → map → compute
 *
 * 【操作类型】
 * - get:     从 dataModel 取数据
 * - filter:  过滤数组（基于表达式）
 * - map:     转换数组元素（基于表达式）
 * - compute: 基于当前值计算新值
 *
 * 【使用示例】
 *   { "setValues": { "map": { "/productOptions": {
 *     "pipe": [
 *       { "get": "/rawProducts.list" },
 *       { "map": "({ label: $.name, value: $.id })" }
 *     ]
 *   }}}}
 *
 * 执行流程:
 *   1. get /rawProducts.list → 获取原始产品数组
 *   2. map → 将每个元素 $.name / $.id 转为 { label, value }
 *   3. 结果写入 /productOptions
 *
 * 【安全考量】
 * 表达式通过 new Function() 求值，在当前已知的 Reactive 场景下
 * 表达式只会操作 dataModel 数据，但如果将来支持自由输入需注意沙箱化。
 */

import { dmPath, validateExpression } from './a2ui-utils'

export class PipeEngine {
  /**
   * dataModel 需要在每次 evaluate 前更新为最新数据
   * （由 ReactionEngine 在执行 pipe 前设置）
   */
  constructor(public dataModel: Record<string, any>) {}

  /** 更新 dataModel 引用（由调用方在 evaluate 前调用） */
  updateDataModel(dm: Record<string, any>) {
    this.dataModel = dm
  }

  /** 执行一个管道步骤数组，返回最终结果 */
  evaluate(rawSteps: Record<string, any>[]): any {
    const steps = rawSteps.map(s => this.normalizeStep(s))
    let value: any = undefined
    for (const step of steps) {
      value = this.executeStep(step, value)
    }
    return value
  }

  /**
   * 归一化步：支持简写 { get: '...' } 和标准格式 { type: 'get', params: '...' }
   * 简写格式中第一个非 type/params 的 key 就是操作类型
   */
  private normalizeStep(step: Record<string, any>): { type: string; params?: any } {
    if (step.type) return { type: step.type, params: step.params }
    const keys = Object.keys(step).filter(k => k !== 'type' && k !== 'params')
    const type = keys[0]
    return { type, params: step[type] }
  }

  /** 执行单个步骤 */
  private executeStep(step: { type: string; params?: any }, current: any): any {
    const p = step.params
    switch (step.type) {
      case 'get':
        return this.resolvePath(p)
      case 'filter':
        return Array.isArray(current)
          ? current.filter(item => this.eval(p, { $: item }))
          : []
      case 'map':
        return Array.isArray(current)
          ? current.map((item, i) => this.eval(p, { $: item, $_index: i }))
          : []
      case 'compute':
        // compute 步骤可访问 $value（当前值）和 dataModel 中的所有字段
        return this.eval(p, { $value: current, ...this.flatData() })
      default:
        console.warn(`[PipeEngine] Unknown step: ${step.type}`)
        return current
    }
  }

  /**
   * 安全求解 JavaScript 表达式
   * 变量通过函数参数注入，避免 eval 直接访问外部作用域
   */
  private eval(expr: string, vars: Record<string, any>): any {
    try {
      validateExpression(expr, 'PipeEngine.eval')
      const keys = Object.keys(vars)
      const values = Object.values(vars)
      const fn = new Function(...keys, `"use strict"; return (${expr})`)
      return fn(...values)
    } catch (err) {
      console.error(`[PipeEngine] Eval failed: "${expr}"`, err)
      return undefined
    }
  }

  /**
   * 从 dataModel 解析简化路径
   * 例: /rawProducts.list → dataModel.rawProducts.list
   */
  private resolvePath(path: string): any {
    const normalized = dmPath(path)
    const segments = normalized.split('/').filter(Boolean)
    let cur: any = this.dataModel
    for (const p of segments) {
      if (cur === null || cur === undefined) return undefined
      cur = cur[p]
    }
    return cur
  }

  /**
   * 将 dataModel 扁平化为合法 JS 标识符键值对
   * 用于 compute 表达式中直接访问 dataModel 字段
   * 例: dataModel = { productDetail: { price: 100 } }
   *     → { productDetail: { price: 100 } }
   *     → compute 表达式中可直接用 productDetail.price
   */
  private flatData(): Record<string, any> {
    const result: Record<string, any> = {}
    const walk = (obj: any, prefix: string) => {
      if (!obj || typeof obj !== 'object') return
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k
        if (/^[a-zA-Z_$][\w$]*$/.test(key)) result[key] = v
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) walk(v, key)
      }
    }
    walk(this.dataModel, '')
    return result
  }
}
