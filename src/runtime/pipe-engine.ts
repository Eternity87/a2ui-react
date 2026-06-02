export class PipeEngine {
  constructor(public dataModel: Record<string, any>) {}

  evaluate(rawSteps: Record<string, any>[]): any {
    // 归一化: 支持 { get: '...' } 简写和 { type: 'get', params: '...' } 标准格式
    const steps = rawSteps.map(s => this.normalizeStep(s))
    let value: any = undefined
    for (const step of steps) {
      value = this.executeStep(step, value)
    }
    return value
  }

  // 将简写 { get: '...' } 转为标准 { type: 'get', params: '...' }
  private normalizeStep(step: Record<string, any>): { type: string; params?: any } {
    if (step.type) return { type: step.type, params: step.params }
    // 简写格式: 第一个非空 key 是 type，值就是 params
    const keys = Object.keys(step).filter(k => k !== 'type' && k !== 'params')
    const type = keys[0]
    return { type, params: step[type] }
  }

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
        return this.eval(p, { $value: current, ...this.flatData() })
      default:
        console.warn(`[PipeEngine] Unknown step: ${step.type}`)
        return current
    }
  }

  private eval(expr: string, vars: Record<string, any>): any {
    try {
      const keys = Object.keys(vars)
      const values = Object.values(vars)
      const fn = new Function(...keys, `"use strict"; return (${expr})`)
      return fn(...values)
    } catch (err) {
      console.error(`[PipeEngine] Eval failed: "${expr}"`, err)
      return undefined
    }
  }

  private resolvePath(path: string): any {
    // /data/rawProducts.list → [rawProducts, list]
    const clean = path.replace(/^\/(data|ui|errors)\//, '')
    const parts = clean.split(/[\/.]/)
    let cur: any = this.dataModel
    for (const p of parts) {
      if (cur === null || cur === undefined) return undefined
      cur = cur[p]
    }
    return cur
  }

  private flatData(): Record<string, any> {
    const result: Record<string, any> = {}
    const walk = (obj: any, prefix: string) => {
      if (!obj || typeof obj !== 'object') return
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k
        // 只有合法 JS 标识符的 key 才暴露给表达式（跳过含点号的嵌套路径）
        if (/^[a-zA-Z_$][\w$]*$/.test(key)) {
          result[key] = v
        }
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          walk(v, key)
        }
      }
    }
    walk(this.dataModel, '')
    return result
  }
}
