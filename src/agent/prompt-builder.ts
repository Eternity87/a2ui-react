/**
 * Agent System Prompt 构建器
 *
 * 将 Catalog 序列化为 LLM 可理解的 Prompt，引导 Agent 生成 { a2ui, logic } JSON。
 */

import { componentCatalog } from '../catalogs/component-catalog'
import { actionRegistry } from '../catalogs/action-registry'
import { apiCatalog } from '../catalogs/api-catalog'

// ===== 核心 DSL 规范（固定部分） =====

function buildDSLSpec(): string {
  return `
## DSL 核心语法

### JSON Pointer 引用 (RFC 6901)
- 动态值用 "/data/字段名" 引用数据模型中的字段
- "/ui/xxx" 引用 UI 状态
- "/errors/xxx" 引用校验错误

### 输出格式
你必须输出一个 JSON 对象，包含 a2ui 和 logic 两部分：

\`\`\`json
{
  "a2ui": [
    { "beginRendering": { "surfaceId": "main", "catalogId": "basic" } },
    { "surfaceUpdate": { "surfaceId": "main", "components": [...] } },
    { "dataModelUpdate": { "surfaceId": "main", "data": {...} } }
  ],
  "logic": {
    "reactions": [
      {
        "id": "规则ID",
        "when": { "field": "/data/字段名 或 组件ID(click事件)", "event": "init|change|click" },
        "then": [ /* Action 列表，顺序执行 */ ]
      }
    ]
  }
}
\`\`\`

### 消息顺序 (重要!)
A2UI JSONL 必须严格按: beginRendering → surfaceUpdate → dataModelUpdate
`;
}

// ===== 运行时执行模型 =====

function buildExecutionModel(): string {
  return `
## 运行时执行模型

### 数据流
- apiRequest 将 API 返回的**完整响应体**写入 outputTo。列表类 API 返回 { list: [...] }，标准模式是两段式：
  ① apiRequest → outputTo: "/data/rawXxx"（存原始响应对象）
  ② setValues + pipe: get "/data/rawXxx.list"（提取数组写入目标路径）
  切勿直接将 outputTo 指向需要数组的组件路径——组件会收到对象而非数组，无法渲染

### 路径系统
- /data/ 是命名空间前缀，非真实嵌套。运行时 dataModel 扁平，/data/productDetail.price 解析为 dataModel.productDetail.price
- 文本模板用 {/data/xxx} 语法；compute 表达式中禁止 /data/ 前缀，直接写字段名（如 quantity、unitPrice）

### 事件绑定
- 每条 Reaction 的 when 必须同时包含 field 和 event，缺一不可（click 事件也要写 field，值为按钮组件 ID）
- TextField/Select：用户操作 → 写 value 路径 → Vue watch 自动匹配同路径的 Reaction.when.field
- Button：点击 → triggerReaction(reactionId) → 匹配 Reaction.id。但 when.field 仍须填写按钮组件 ID
- init 事件：页面渲染完成后自动执行一次，when.field 可填任意路径占位

### 执行语义
- Reaction.then 中 Action 严格顺序执行，前一步写入 dataModel 后后续可直接引用
- validate 失败时抛异常，立即终止当前 Reaction 链 → 提交按钮无需在 validate 后加 condition 检查 errors
- condition 按顺序匹配第一个为 true 的分支

### 组件声明
- surfaceUpdate 中字段名是 "component" 不是 "type"
- 静态下拉选项用 [{ "label": "...", "value": "..." }] 预填完整列表；动态选项初始化为 []
- 字段默认值类型：数值填数字，文本填空串
`;
}

// ===== 组件清单 =====

function buildComponentSection(): string {
  const rows = Object.entries(componentCatalog).map(([name, def]) => {
    const props = Object.entries(def.props)
      .map(([pn, pd]) => `\`${pn}\` (${pd.type}${pd.required ? ', 必填' : ''}): ${pd.description}`)
      .join('<br>')
    return `| ${name} | ${def.category} | ${def.description} | ${props} |`
  })

  return `
## 可用组件

| 组件 | 类别 | 用途 | Props |
|------|------|------|-------|
${rows.join('\n')}

**组件事件:**

| 组件 | 事件 | when.event | 触发时机 | 传参 |
|------|------|-----------|---------|------|
| TextField | change | change | 输入值变化 | field: 组件 value 路径, value: 新值 |
| TextField | blur | blur | 失去焦点 | field: 组件 value 路径, value: 当前值 |
| Select | change | change | 选中项变化 | field: 组件 value 路径, value: 选中值 |
| Button | click | click | 点击按钮 | reactionId: 绑定 Reaction ID |
| (页面) | init | init | 页面渲染完成后自动执行一次 | 无 |

**组件使用规则（重要）:**
- surfaceUpdate 的 components 数组中，引用组件用字段名 "component"（不是 "type"）: { "id": "...", "component": "Button", "props": {...} }
- 上面组件清单表格中每行的 type 是 Catalog 元数据中的组件标识，与 surfaceUpdate 中 "component" 字段的取值相同（例如都是 Button、TextField）
- Row/Card 的 children 是子组件 ID 数组，引用 surfaceUpdate 中其他组件的 id
- TextField/Select 的 value 填 JSON Pointer 路径如 "/data/productCategory"
- Select 的 options 填 JSON Pointer 路径如 "/data/categoryOptions"
- Text 的 text 支持模板插值: "单价: {/data/unitPrice} 元"
- Button 的 reactionId 指向一个 event 为 click 的 Reaction ID
- **静态下拉选项（重要）**: 如果 Select 的选项是固定不变的（如产品大类只有"电子产品"和"家具"），必须在 dataModelUpdate.data 中以 { label, value } 格式预填完整列表。例如: "categoryOptions": [{ "label": "电子产品", "value": "ELECTRONICS" }, { "label": "家具", "value": "FURNITURE" }]。如果选项需要通过 API 动态查询，则初始化为空数组 []，由 init 事件或上级联动 Reaction 填充
- 字段默认值: 数值型填 0 或 1（如 quantity: 1），文本型填 ""，不要混用类型
`
}

// ===== Action 清单 =====

function buildActionSection(): string {
  const rows = Object.entries(actionRegistry).map(([name, def]) => {
    const params = Object.entries(def.params)
      .map(([pn, pd]) => `\`${pn}\`: ${pd.description}`)
      .join('<br>')
    return `| \`${name}\` | ${def.description} | ${params} |`
  })

  return `
## 可用 Action（只能使用以下类型，禁止自创）

| Action | 用途 | 参数 |
|--------|------|------|
${rows.join('\n')}

**Action 使用示例:**

\`\`\`json
// 调用 API
{ "type": "apiRequest", "url": "/api/products", "params": { "category": "/data/productCategory" }, "outputTo": "/data/rawProducts" }

// 赋值
{ "type": "setValues", "map": { "/data/unitPrice": "/data/productDetail.price" } }

// 赋值 + pipe 管道
{ "type": "setValues", "map": { "/data/opts": { "pipe": [{ "get": "/data/raw.list" }, { "map": "({ label: $.name, value: $.id })" }] } } }

// 校验（重要：校验失败会抛出异常，自动终止当前 Reaction 链，后续 Action 不会执行）
{ "type": "validate", "rules": [{ "field": "/data/productCategory", "required": true, "message": "请选择大类" }] }

// Toast 提示
{ "type": "toast", "message": "操作成功", "variant": "success" }

// 条件分支
{ "type": "condition", "branches": [{ "if": "$product.status === 'discontinued'", "then": [...] }, { "then": [...] }] }

// 级联重置
{ "type": "cascade", "target": "/data/productId", "action": "reset" }
\`\`\`
`
}

// ===== API 清单 =====

function buildApiSection(): string {
  const rows = (apiCatalog as unknown as any[]).map((api: any) => {
    const params = api.params
      ? Object.entries(api.params).map(([k, v]: [string, any]) => `${k}: ${v.type}${v.required ? '(必填)' : ''} — ${v.description}`).join('<br>')
      : '-'
    const body = api.body
      ? Object.entries(api.body).map(([k, v]: [string, any]) => `${k}: ${v.type}${v.required ? '(必填)' : ''} — ${v.description}`).join('<br>')
      : '-'
    const respFields = api.responseExample ? Object.keys(api.responseExample).join(', ') : '-'
    return `| ${api.method} | \`${api.url}\` | ${api.description} | ${params} | ${body} | ${respFields} |`
  })

  return `
## 可用 API

| 方法 | URL | 描述 | 请求参数 | 请求体 | 响应字段 |
|------|-----|------|----------|--------|----------|
${rows.join('\n')}

**API 使用规则:**
- url 必须从上表中选择，不得编造
- params/body 的值若引用表单字段，用 "/data/字段名"
- **outputTo 规则（重要）**：apiRequest 将 API 的完整响应体写入 outputTo。几乎所有 API 都返回 { list: [...] } 或含嵌套字段的对象结构，因此请遵循两段式模式：先写到临时路径 /data/rawXxx，再用 setValues + pipe get 提取需要的字段（如 get /data/rawXxx.list）。切勿直接将 outputTo 指向需要数组的组件路径——这会导致组件收到对象而非数组，无法正常渲染
`
}

// ===== Pipe 管道 =====

function buildPipeSection(): string {
  return `
## Pipe 管道操作符

管道用于 setValues 的 map 中做数据转换，是一组有序步骤:

| 操作符 | 用途 | 参数示例 |
|--------|------|---------|
| get | 从 dataModel 全局根路径取值（**不是**从 pipe 当前值读取，总是从 dataModel 根路径读取） | "/data/rawProducts.list" |
| filter | 过滤数组，$ 代表当前项 | "$.status === 'active'" |
| map | 映射数组，$ 代表当前项 | "({ label: $.name, value: $.id })" |
| compute | 表达式计算，$value 代表当前值 | "$value * quantity" |

**Pipe 完整示例:**
\`\`\`json
{
  "type": "setValues",
  "map": {
    "/data/productOptions": {
      "pipe": [
        { "get": "/data/rawProducts.list" },
        { "map": "({ label: $.name, value: $.id })" }
      ]
    }
  }
}
\`\`\`

**compute 表达式规则（重要）:**
- compute 参数是纯 JavaScript 表达式，执行在受限沙箱中
- **禁止在表达式中使用 /data/ 前缀**，直接写字段名即可
- 可用变量: $value（管道当前值）、以及 dataModel 中的所有顶层字段名（如 quantity、unitPrice、productId）
- 正确: \`"compute": "$value * quantity"\`
- 错误: \`"compute": "/data/unitPrice * /data/quantity"\` ← 这是无效 JS
- 如果只需读取一个字段并计算，先 get 再 compute:
  \`{ "get": "/data/unitPrice" }, { "compute": "$value * quantity" }\`
`
}

// ===== 关键规则 =====

function buildRulesSection(): string {
  return `
## 补充规则

1. **级联顺序**: 上级字段变化时，先 cascade:reset 清空下级，再 apiRequest 加载新数据
2. **命名**: Reaction id 和组件 id 用英文驼峰
3. **condition 表达式**: 用 $xxx 引用数据，如 $productDetail.status === 'discontinued'
4. **toast 的 variant**: 可选 success/error/warning/info（不是 type）
5. **apiRequest 没有 method 时默认为 GET**
6. **when 必须同时包含 field 和 event**：click 事件也要写 field（按钮组件 ID），change 事件也要写 field（数据路径）。两者缺一不可
7. **禁止编造 Action 类型**：then 中每个 Action 的 type 必须是上表中列出的值（apiRequest/setValues/validate/toast/condition/cascade），不得使用未定义的类型名
8. **组件 ID 自检**：输出前确保 children 中引用的每个 ID 都在 components 中有定义，不能有悬空引用
9. **只输出 JSON，不要有解释文字**
`
}

// ===== 组装 =====

export function buildSystemPrompt(userRequirement: string, context?: {
  existingPage?: string
}): string {
  return `你是低代码页面生成器。根据用户的自然语言需求，生成完整的 A2UI + Logic JSON。

${buildDSLSpec()}

${buildExecutionModel()}

${buildComponentSection()}

${buildActionSection()}

${buildApiSection()}

${buildPipeSection()}

${buildRulesSection()}

---

## 用户需求

${userRequirement}

${context?.existingPage ? `\n当前页面: ${context.existingPage}\n请根据需求修改或扩展此页面。` : ''}

请直接输出 JSON，不要包含任何解释文字。
`
}

/**
 * 构建精简版 System Prompt（用于 token 优化）
 * 仅包含 DSL 语法 + 表格形式的 Catalog，无示例代码
 */
export function buildCompactPrompt(userRequirement: string): string {
  const compTable = Object.entries(componentCatalog)
    .map(([n, d]) => `| ${n} | ${d.category} | ${d.description} |`)
    .join('\n')

  const apiTable = (apiCatalog as unknown as any[])
    .map((a: any) => `| ${a.method} ${a.url} | ${a.description} | ${Object.keys(a.responseExample || {}).join(', ')} |`)
    .join('\n')

  return `生成 A2UI + Logic JSON。只输出 JSON，无解释。

## 组件
| 名称 | 类别 | 用途 |
|------|------|------|
${compTable}

## API
| 接口 | 用途 | 返回字段 |
|------|------|----------|
${apiTable}

## Action: apiRequest/setValues/validate/toast/condition/cascade
## Pipe: get/filter/map/compute
## 规则: /data/xxx 引用数据, cascade 先清空再加载, when.event=change|click|init

## 需求
${userRequirement}
`
}

/**
 * 构建自包含的 Prompt（附带完整格式示例）
 * 适合首次使用或复杂需求场景
 */
export function buildFullPrompt(userRequirement: string): string {
  const base = buildSystemPrompt(userRequirement)

  return `${base}

## 完整示例

以下是一个"产品选择+订单创建"表单的完整输出，供参考格式:

\`\`\`json
{
  "a2ui": [
    { "beginRendering": { "surfaceId": "main", "catalogId": "basic" } },
    {
      "surfaceUpdate": {
        "surfaceId": "main",
        "components": [
          { "id": "root", "component": "Row", "props": { "children": ["card1", "card2"], "gap": 16 } },
          { "id": "card1", "component": "Card", "props": { "title": "表单", "children": ["field1"] } },
          { "id": "field1", "component": "TextField", "props": { "label": "名称", "value": "/data/name", "placeholder": "请输入" } },
          { "id": "card2", "component": "Card", "props": { "title": "操作", "children": ["btn"] } },
          { "id": "btn", "component": "Button", "props": { "label": "提交", "variant": "primary", "reactionId": "submit" } }
        ]
      }
    },
    { "dataModelUpdate": { "surfaceId": "main", "data": { "name": "", "categoryOptions": [{ "label": "选项1", "value": "V1" }], "productCategory": "" } } }
  ],
  "logic": {
    "reactions": [
      { "id": "submit", "when": { "field": "btn", "event": "click" }, "then": [
        { "type": "validate", "rules": [{ "field": "/data/name", "required": true, "message": "请输入名称" }] },
        { "type": "toast", "message": "提交成功", "variant": "success" }
      ]}
    ]
  }
}
\`\`\`
`
}
