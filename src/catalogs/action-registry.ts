export const actionRegistry = {
  apiRequest: {
    type: 'apiRequest',
    description: '调用后端 API',
    params: {
      url: { type: 'string', required: true, description: 'API 地址，必须从 API Catalog 中选择' },
      method: { type: 'string', defaultValue: 'GET', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP 方法' },
      params: { type: 'object', description: '请求参数。值可为静态值或简化路径（/fieldName）' },
      outputTo: { type: 'string', required: true, description: '响应写入目标 (JSON Pointer)' },
    },
  },
  setValues: {
    type: 'setValues',
    description: '批量赋值数据模型',
    params: {
      map: {
        type: 'object',
        required: true,
        description: '{ 目标路径: 值来源 }。值可为静态值、简化路径引用、或 pipe 管道',
      },
    },
  },
  validate: {
    type: 'validate',
    description: '校验字段',
    params: {
      rules: { type: 'array', required: true, description: '校验规则列表 [{ field, required?, message }]' },
      errorTarget: { type: 'string', defaultValue: '/errors', description: '错误写入路径' },
    },
  },
  toast: {
    type: 'toast',
    description: '弹出提示',
    params: {
      message: { type: 'string', required: true },
      variant: { type: 'string', defaultValue: 'info', enum: ['success', 'error', 'warning', 'info'], description: '提示样式变体' },
    },
  },
  condition: {
    type: 'condition',
    description: '条件分支，按顺序匹配第一个为 true 的 if',
    params: {
      branches: { type: 'array', required: true, description: '[{ if?: string, then: Action[] }]' },
    },
  },
  cascade: {
    type: 'cascade',
    description: '重置/清空下级字段',
    params: {
      target: { type: 'string', required: true, description: '目标 JSON Pointer 路径' },
    },
  },
} as const
