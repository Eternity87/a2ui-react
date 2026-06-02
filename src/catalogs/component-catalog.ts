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
      value: { type: 'string', required: true, description: '绑定的 JSON Pointer 路径' },
      placeholder: { type: 'string', description: '占位提示文字' },
      type: {
        type: 'string',
        defaultValue: 'text',
        enum: ['text', 'number'],
        description: '输入类型',
      },
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
      value: { type: 'string', required: true, description: '绑定的 JSON Pointer 路径' },
      options: { type: 'string', description: '选项列表的 JSON Pointer 路径' },
      placeholder: { type: 'string', description: '占位提示' },
    },
  },
  Text: {
    type: 'Text',
    description: '文本展示，支持 {/data/xxx} 模板插值',
    category: 'display',
    props: {
      text: { type: 'string', required: true, description: '展示文本，支持模板 {/data/xxx} 引用数据' },
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
      value: { type: 'string', required: true, description: '行数据数组的 JSON Pointer 路径，如 /data/orders' },
      emptyText: { type: 'string', defaultValue: '暂无数据', description: '无数据时展示的提示文字' },
    },
  },
} as const
