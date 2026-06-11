export interface ComponentDef {
  type: string
  description: string
  category: 'layout' | 'input' | 'display' | 'action'
  events?: Record<string, {
    description: string
    mapsTo: string            // Reaction when.event 值
    payload: string           // 传给 handleEvent 的 payload 说明
  }>
  props: Record<string, {
    type: string
    required?: boolean
    description: string
    defaultValue?: unknown
    enum?: string[]
  }>
}

export const componentCatalog: Record<string, ComponentDef> = {
  Row: {
    type: 'Row',
    description: '水平弹性布局容器',
    category: 'layout',
    props: {
      children: { type: 'string[]', required: true, description: '子组件 ID 列表' },
      gap: { type: 'number', defaultValue: 8, description: '间距(px)' },
    },
  },
  Card: {
    type: 'Card',
    description: '卡片容器，带标题和阴影',
    category: 'layout',
    props: {
      children: { type: 'string[]', required: true, description: '子组件 ID 列表' },
      title: { type: 'string', description: '卡片标题' },
    },
  },
  TextField: {
    type: 'TextField',
    description: '文本输入框，支持 text/number 类型',
    category: 'input',
    events: {
      change: {
        description: '输入值变化时触发',
        mapsTo: 'change',
        payload: '{ field: 组件 props.value 路径, value: 新输入值 }',
      },
      blur: {
        description: '失去焦点时触发',
        mapsTo: 'blur',
        payload: '{ field: 组件 props.value 路径, value: 当前输入值 }',
      },
    },
    props: {
      label: { type: 'string', required: true, description: '标签' },
      value: { type: 'DynamicString', required: true, description: '绑定的值，支持 DataBinding { path } 或静态字符串' },
      placeholder: { type: 'string', description: '占位提示文字' },
      type: {
        type: 'string',
        defaultValue: 'text',
        enum: ['text', 'number'],
        description: '输入类型',
      },
      size: { type: 'string', defaultValue: 'default', enum: ['sm', 'default', 'lg'], description: '输入框尺寸' },
      width: { type: 'string', defaultValue: '', description: '宽度 CSS 值，如 200px / 100% / 20rem' },
    },
  },
  Select: {
    type: 'Select',
    description: '下拉选择器，选项从数据模型读取',
    category: 'input',
    events: {
      change: {
        description: '选中项变化时触发',
        mapsTo: 'change',
        payload: '{ field: 组件 props.value 路径, value: 选中的值 }',
      },
    },
    props: {
      label: { type: 'string', required: true, description: '标签' },
      value: { type: 'DynamicString', required: true, description: '绑定的值，支持 DataBinding { path } 或静态值' },
      options: { type: 'DynamicValue', description: '选项列表，支持 DataBinding { path } 或静态数组 [{ label, value }]' },
      placeholder: { type: 'string', description: '占位提示' },
      size: { type: 'string', defaultValue: 'default', enum: ['sm', 'default', 'lg'], description: '选择器尺寸' },
      width: { type: 'string', defaultValue: '', description: '宽度 CSS 值，如 200px / 100% / 20rem' },
    },
  },
  Text: {
    type: 'Text',
    description: '文本展示，支持 ${/xxx} 模板插值（ExpressionParser）',
    category: 'display',
    props: {
      text: { type: 'DynamicString', required: true, description: '展示文本，支持 ${/xxx} 模板插值引用数据' },
      size: { type: 'string', defaultValue: 'sm', enum: ['xs', 'sm', 'base', 'lg', 'xl', '2xl'], description: '字号' },
      color: { type: 'string', defaultValue: '', description: '文字颜色，Tailwind class (如 text-red-500) 或 hex (如 #ff0000)' },
      bold: { type: 'boolean', defaultValue: false, description: '是否加粗' },
      italic: { type: 'boolean', defaultValue: false, description: '是否斜体' },
    },
  },
  Button: {
    type: 'Button',
    description: '按钮，通过 reactionId 绑定点击事件',
    category: 'action',
    events: {
      click: {
        description: '点击按钮时触发',
        mapsTo: 'click',
        payload: '{ reactionId: 绑定的 Reaction ID }',
      },
    },
    props: {
      label: { type: 'string', required: true, description: '按钮文字' },
      variant: {
        type: 'string',
        defaultValue: 'primary',
        enum: ['primary', 'secondary', 'danger'],
        description: '按钮样式变体',
      },
      reactionId: { type: 'string', description: '点击时触发的 Reaction ID' },
      disabled: { type: 'boolean', defaultValue: false, description: '是否禁用' },
    },
  },
  DataTable: {
    type: 'DataTable',
    description: '数据表格，支持列定义、动态行数据和可编辑单元格',
    category: 'display',
    props: {
      columns: { type: 'array', required: true, description: '列定义数组 [{ key, label, cellType?, cellProps? }]。cellType 可选: text(默认)/input/number/select，cellProps 透传给底层组件' },
      value: { type: 'DynamicValue', required: true, description: '行数据数组的 DataBinding 路径，如 { "path": "/orders" }' },
      emptyText: { type: 'string', defaultValue: '暂无数据', description: '无数据时展示的提示文字' },
    },
  },
  Dialog: {
    type: 'Dialog',
    description: '弹窗容器，内部渲染独立 A2UI 子 Surface（独立 DataModel + Reactions），支持多实例隔离',
    category: 'layout',
    props: {
      open: { type: 'DynamicBoolean', required: true, description: '控制弹窗显隐的 DataBinding { path }，值为 true 时打开' },
      title: { type: 'string', description: '弹窗标题' },
      source: { type: 'string', required: true, description: '子页面来源：本地 children key（如 "confirmDialog"）或远程 URL（如 "/api/pages/productPicker"）' },
      width: { type: 'string', defaultValue: 'max-w-lg', description: '弹窗宽度 CSS class（如 max-w-lg / max-w-2xl / max-w-4xl）' },
    },
  },
} as const
