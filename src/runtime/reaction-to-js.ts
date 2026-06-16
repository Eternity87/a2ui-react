/**
 * reaction-to-js.ts — 将声明式 Reaction JSON 转换为可编辑 JS 代码
 *
 * 单向生成：Reaction → JS（body-only，不含函数包裹）。
 * 生成的代码可直接在 ScriptEngine 中执行，用户也可自由编辑。
 */

interface Action {
  type: string
  [key: string]: any
}

interface ConditionAction extends Action {
  type: 'condition'
  branches: { if?: string; then: Action[] }[]
}

interface Reaction {
  id: string
  when: { field: string; event: string }
  then: Action[]
}

const INDENT = '  '

/** 可用的全局变量说明 */
const API_HEADER = [
  '// 可用全局变量:',
  '//   dataModel    — DataModel 实例 (get/set/subscribe)',
  '//   pipe         — pipe(steps) 执行管道计算',
  '//   toast        — toast(message, variant) 弹出提示',
  '//   sharedStore  — 跨页面共享状态 (getState/setState)',
  '//   navigate     — navigate(pageId, params) 页面跳转',
  '//   action       — 触发该 reaction 的原始 action 对象',
  '',
]

/** 将单个 Reaction 转换为可执行 JS 代码（body-only） */
export function reactionToJS(reaction: Reaction): string {
  const lines: string[] = []
  const triggerLabel = reaction.when.event === 'click'
    ? `// 触发: 组件 ${reaction.when.field} 被点击`
    : reaction.when.event === 'init'
      ? `// 触发: 页面加载 (init)`
      : reaction.when.event === 'change'
        ? `// 触发: ${reaction.when.field} 值变化`
        : `// 触发: ${reaction.when.field} ${reaction.when.event}`

  lines.push(triggerLabel)
  lines.push(...API_HEADER)
  if (reaction.then.length === 0) {
    lines.push('// TODO: 在此编写业务逻辑')
    lines.push('')
  } else {
    for (const a of reaction.then) {
      for (const l of actionToJS(a, 0)) {
        lines.push(l)
      }
    }
  }
  return lines.join('\n')
}

// ===== Action 翻译 =====

function actionToJS(action: Action, depth: number): string[] {
  const pad = INDENT.repeat(depth)
  switch (action.type) {
    case 'setValues':
      return setValuesToJS(action, depth)
    case 'condition':
      return conditionToJS(action, depth)
    case 'toast':
      return [`${pad}toast(${fmtJson(action.message)}, ${fmtJson(action.variant ?? 'info')})`]
    case 'apiRequest': {
      const url = fmtJson(action.url)
      const method = fmtJson(action.method ?? 'GET')
      return [
        `${pad}// apiRequest`,
        `${pad}const response = await apiRequest({ url: ${url}, method: ${method} })`,
        action.outputTo ? `${pad}dataModel.set(${fmtJson(action.outputTo)}, response.data)` : null,
      ].filter(Boolean) as string[]
    }
    case 'validate': {
      const target = action.errorTarget ?? '/errors'
      const rules = action.rules?.map((r: any) =>
        `${pad}// ${r.field}: ${r.required ? '必填' : ''} ${r.message}`
      ) ?? []
      return [
        `${pad}// validate → ${target}`,
        ...rules,
      ]
    }
    case 'cascade':
      return [`${pad}dataModel.set(${fmtJson(action.target)}, undefined)`]
    case 'navigate': {
      const params = action.params
        ? `{ ${Object.entries(action.params).map(([k, v]) => `${k}: ${fmtJson(v)}`).join(', ')} }`
        : '{}'
      return [`${pad}navigate(${fmtJson(action.pageId)}, ${params})`]
    }
    default:
      return [`${pad}// unknown action: ${action.type}`]
  }
}

// ===== setValues =====

function setValuesToJS(action: Action, depth: number): string[] {
  const pad = INDENT.repeat(depth)
  const lines: string[] = [`${pad}// setValues`]
  const map = action.map as Record<string, any> ?? {}
  for (const [target, source] of Object.entries(map)) {
    if (typeof source === 'object' && source !== null && 'pipe' in source) {
      const pipeExpr = pipeToExpr(source.pipe as Record<string, any>[])
      lines.push(`${pad}dataModel.set(${fmtJson(target)}, ${pipeExpr})`)
    } else if (typeof source === 'string' && source.startsWith('/')) {
      lines.push(`${pad}dataModel.set(${fmtJson(target)}, dataModel.get(${fmtJson(source)}))`)
    } else {
      lines.push(`${pad}dataModel.set(${fmtJson(target)}, ${fmtJson(source)})`)
    }
  }
  return lines
}

// ===== condition =====

function conditionToJS(action: Action, depth: number): string[] {
  const pad = INDENT.repeat(depth)
  const lines: string[] = []
  const branches = (action as ConditionAction).branches ?? []

  for (let i = 0; i < branches.length; i++) {
    const branch = branches[i]
    if (branch.if) {
      const cond = branch.if
        .replace(/\$([\w][\w.]*)/g, (_, p: string) => `dataModel.get('/${p.replace(/\./g, '/')}')`)
      if (i === 0) {
        lines.push(`${pad}if (${cond}) {`)
      } else {
        lines.push(`${pad}} else if (${cond}) {`)
      }
    } else {
      lines.push(`${pad}} else {`)
    }
    if (branch.then) {
      for (const a of branch.then as Action[]) {
        for (const l of actionToJS(a, depth + 1)) {
          lines.push(l)
        }
      }
    }
  }
  lines.push(`${pad}}`)
  return lines
}

// ===== Pipe 表达式 =====

function pipeToExpr(steps: Record<string, any>[]): string {
  if (steps.length === 0) return `pipe([])`
  if (steps.length === 1) {
    const [s] = steps
    const type = Object.keys(s).find(k => k !== 'type' && k !== 'params') ?? 'get'
    const param = s.type ? s.params : s[type]
    if (type === 'get') return `dataModel.get(${fmtJson(param)})`
    return `pipe([${fmtJson(s)}])`
  }
  return `pipe(${fmtJson(steps)})`
}

// ===== 工具 =====

function fmtJson(v: any): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (v === null || v === undefined) return String(v)
  return JSON.stringify(v)
}
