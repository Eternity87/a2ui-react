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
  navigate: {
    type: 'navigate',
    description: '跨页面导航，携带 URL 参数到目标页面',
    params: {
      pageId: { type: 'string', required: true, description: '目标页面 ID（pages 对象的 key）' },
      params: { type: 'object', description: '导航参数字典，值可为静态值或路径引用（/fieldName）' },
    },
  },
  schedule: {
    type: 'schedule',
    description: '定时轮询：按 interval(ms) 间隔重复执行 then 中的 Action 链。页面关闭时自动清除',
    params: {
      interval: { type: 'number', defaultValue: 30000, description: '轮询间隔(ms)，默认 30 秒' },
      then: { type: 'array', required: true, description: '定时执行的 Action 列表' },
    },
  },
} as const
