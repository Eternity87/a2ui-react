/**
 * Agent System Prompt 构建器
 *
 * 将 Catalog 序列化为 LLM 可理解的 Prompt，引导 Agent 生成 { a2ui, logic } JSON。
 */

import { componentCatalog } from '../catalogs/component-catalog'
import { actionRegistry } from '../catalogs/action-registry'
import { apiCatalog } from '../catalogs/api-catalog'

// ===== 核心 DSL 规范（固定部分） =====

function buildMultiPageSection(): string {
  return `
### 多页面支持（可选）
如需多个页面（列表+详情），使用 pages 格式：
{ "pages": { "page_list": { "a2ui": [...], "logic": {...} }, "page_detail": {...} }, "shared": { "dataModel": {...} } }
- 每页 surfaceId 始终填 "main"（系统自动分配唯一 ID）
- 跨页导航用 navigate Action；目标页 init 通过 /navParams/xxx 读参数
- shared.dataModel 定义全局共享初始数据

### navigate 跨页导航
{ "type": "navigate", "pageId": "page_detail", "params": { "id": "/selectedOrderId" } }
- pageId 对应 pages 对象的 key
- params 值可为静态值或 /fieldName 路径引用
- 导航后 URL hash 自动更新，支持浏览器前进/后退
`
}

function buildDSLSpec(): string {
  return `
## DSL 核心语法

### DynamicValue 数据绑定（A2UI v0.9 标准）
组件 props 中的动态值使用标准 DynamicValue 格式（遵循 JSON Schema oneOf）：
- 静态字面量: "产品大类" / 42 / true — 直接写值
- 数据绑定: { "path": "/字段名" } — 从 dataModel 中读取
- 模板插值（Text 组件）: "单价: \${/unitPrice} 元" — ExpressionParser 解析

### 输出格式
你必须输出一个 JSON 对象，包含 a2ui 和 logic 两部分：

\`\`\`json
{
  "a2ui": [
    { "beginRendering": { "surfaceId": "main", "catalogId": "basic" } },
    { "surfaceUpdate": { "surfaceId": "main", "components": [...] } },
    { "updateDataModel": { "surfaceId": "main", "path": "/字段名", "value": "初始值" } }
  ],
  "logic": {
    "reactions": [
      {
        "id": "规则ID",
        "when": { "field": "/字段名 或 组件ID(click事件)", "event": "init|change|click" },
        "then": [ /* Action 列表，顺序执行 */ ]
      }
    ]
  }
}
\`\`\`

### 消息顺序 (重要!)
A2UI JSONL 必须严格按: beginRendering → surfaceUpdate → updateDataModel(逐字段)
`;
}

// ===== 运行时执行模型 =====

function buildExecutionModel(): string {
  return `
## 运行时执行模型

### 数据流
- apiRequest 将 API 返回的**完整响应体**写入 outputTo。列表类 API 返回 { list: [...] }，标准模式是两段式：
  ① apiRequest → outputTo: "/rawXxx"（存原始响应对象）
  ② setValues + pipe: get "/rawXxx.list"（提取数组写入目标路径）
  切勿直接将 outputTo 指向需要数组的组件路径——组件会收到对象而非数组，无法渲染

### 路径系统
- / 是 JSON Pointer 前缀，非真实嵌套。运行时 dataModel 扁平，/productDetail.price 解析为 dataModel.productDetail.price
- Text 组件的 text 支持 \${/xxx} 模板插值（ExpressionParser 标准语法）
- compute 表达式中禁止 / 前缀，直接写字段名（如 quantity、unitPrice）

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
  const entries = Object.entries(componentCatalog)
  const chartEntries = entries.filter(([, d]) => d.category === 'chart')
  const otherEntries = entries.filter(([, d]) => d.category !== 'chart')

  // 图表共享 prop 集合（不在单组件详情中重复列出）
  const SHARED_CHART = new Set([
    'width', 'height', 'fontSize', 'fontFamily', 'chartMargin',
    'showLegend', 'showTooltip', 'showDataLabel', '_w',
    'color', 'colors',
  ])
  const SHARED_REF = new Set(['referenceValue', 'referenceLabel', 'referenceColor'])
  const SHARED_COND = new Set(['targetValue', 'colorAbove', 'colorBelow'])
  const SHARED_AXIS = new Set(['showGrid', 'xTickAngle'])
  const ALL_SHARED = new Set([...SHARED_CHART, ...SHARED_REF, ...SHARED_COND, ...SHARED_AXIS])

  const fmtProp = (pn: string, pd: { type: string; required?: boolean; defaultValue?: unknown; enum?: string[]; description: string }) => {
    const req = pd.required ? '必填, ' : ''
    const enums = pd.enum ? `=${pd.defaultValue ?? pd.enum[0]}` : ''
    const dv = pd.defaultValue && !pd.enum ? ` (默认: ${pd.defaultValue})` : ''
    if (pd.enum) return `\`${pn}\`(${pd.type})${enums}`
    return `\`${pn}\`(${pd.type}${req ? ', ' + req : ''})${dv}: ${pd.description}`
  }

  const buildBlock = (name: string, def: typeof componentCatalog[string], filterShared: boolean) => {
    let propEntries = Object.entries(def.props)
    if (filterShared) {
      propEntries = propEntries.filter(([pn]) => !ALL_SHARED.has(pn))
    }
    const core = propEntries.filter(([, p]) => (p.tier ?? 'common') === 'core')
    const common = propEntries.filter(([, p]) => (p.tier ?? 'common') === 'common')
    const styling = propEntries.filter(([, p]) => p.tier === 'styling')

    const lines: string[] = []
    lines.push(`### ${name} — ${def.description} [${def.category}]`)
    if (core.length > 0) {
      lines.push(`  **${def.category === 'layout' ? '结构' : def.category === 'input' || def.category === 'chart' ? '数据' : '功能'}:** ${core.map(([pn, pd]) => fmtProp(pn, pd)).join('; ')}`)
    }
    if (common.length > 0) {
      lines.push(`  **其他:** ${common.map(([pn, pd]) => fmtProp(pn, pd)).join('; ')}`)
    }
    if (styling.length > 0) {
      lines.push(`  **样式:** ${styling.map(([pn, pd]) => fmtProp(pn, pd)).join(', ')}`)
    }
    return lines.join('\n')
  }

  const otherBlocks = otherEntries.map(([n, d]) => buildBlock(n, d, false))
  const chartBlocks = chartEntries.map(([n, d]) => buildBlock(n, d, true))

  // 取第一个图表组件的共享 prop 实际默认值来构建共享表
  const firstChart = chartEntries[0]?.[1]
  const sharedRows = (names: Set<string>, title: string) => {
    if (!firstChart) return ''
    const props = [...names]
      .filter(n => n in (firstChart.props || {}))
      .map(n => [n, firstChart.props[n]] as const)
    if (props.length === 0) return ''
    return `**${title}:** ${props.map(([pn, pd]) => fmtProp(pn, pd)).join(', ')}\n`
  }

  return `
## 可用组件

### 图表通用配置（所有图表均支持，不再在每个图表中重复列出）

${sharedRows(SHARED_CHART, '外观')}
${sharedRows(SHARED_AXIS, '网格/坐标轴（笛卡尔图表）')}
${sharedRows(SHARED_REF, '参考线（笛卡尔图表）')}
${sharedRows(SHARED_COND, '条件着色（Bar/Pie/Line/Area/Composed/Scatter）')}
> 图表独有 props 见各组件详情。

### 基础组件

${otherBlocks.join('\n\n')}

### 图表组件

${chartBlocks.join('\n\n')}

**组件事件:**

| 组件 | 事件 | when.event | 触发时机 |
|------|------|-----------|---------|
| TextField | change | change | 输入值变化 |
| TextField | blur | blur | 失去焦点 |
| Select | change | change | 选中项变化 |
| Button | click | click | 点击按钮 |
| (页面) | init | init | 页面渲染完成后自动执行一次 |
| (页面) | unload | unload | 页面关闭/销毁时执行（清理资源） |
| (任意) | schedule | schedule | 定时轮询，需配 interval + then |

**组件使用规则:**
- surfaceUpdate 中字段名是 "component" 不是 "type"
- Row/Card/Button/DataTable 是**可见组件**，id 出现在 children 中会被渲染
- 动态值使用 DataBinding: { "path": "/字段名" }；静态选项直接填数组 [{ "label":"..", "value":".." }]
- Text 的 text 支持 \${/xxx} 模板插值: "单价: \${/unitPrice} 元"
- Button 的 reactionId 指向 event 为 click 的 Reaction.id
- Select 若选项固定，通过 updateDataModel 预填 [{ label, value }]；若动态，初始化为空数组由 init 填充
- DataTable 的 columns 是 [{ key, label, cellType? }] 数组；value 用 DataBinding 指向行数据数组
- 默认值: 数值填数字（如 quantity: 1），文本填 ""`
}

// ===== BI 看板布局 & 交互模式 =====

function buildDashboardSection(): string {
  return `
## BI 看板模式

### 数据加载（重要！）

看板数据通过 API 获取，不要用 updateDataModel 内联静态数据。标准模式:

1. init Reaction 中调用多个 apiRequest，输出到 /rawXxx 临时路径
2. 再用 setValues + pipe get 从响应中提取需要的字段写入组件 data 路径
3. 组件通过 { "path": "/xxx" } 绑定数据

\`\`\`json
{ "id": "initLoad", "when": { "field": "/_", "event": "init" }, "then": [
  { "type": "apiRequest", "url": "/api/dashboard/kpi", "outputTo": "/rawKpi" },
  { "type": "apiRequest", "url": "/api/dashboard/monthly-stats", "outputTo": "/rawMonthly" },
  { "type": "setValues", "map": {
    "/kpiSales":      { "pipe": [{ "get": "/rawKpi.totalSales" }] },
    "/kpiSalesTrend":  { "pipe": [{ "get": "/rawKpi.salesTrend" }] },
    "/kpiSalesSpark":  { "pipe": [{ "get": "/rawKpi.salesSpark" }] },
    "/barData":        { "pipe": [{ "get": "/rawMonthly.list" }] },
    "/scatterFiltered": { "pipe": [{ "get": "/rawScatter.list" }] }
  }}
]}
\`\`\`

**可用看板 API:**

| URL | 返回 |
|-----|------|
| /api/dashboard/kpi | totalSales/salesTrend/salesSpark/totalOrders/ordersTrend/ordersSpark/avgPrice/avgPriceTrend/avgPriceSpark/profitRate/profitRateTrend/profitRateSpark |
| /api/dashboard/monthly-stats | list[{ month, sales, revenue, orders, profitRate }] |
| /api/dashboard/category-share | list[{ name, value }] |
| /api/dashboard/ad-vs-sales | list[{ ad, sales }] |
| /api/dashboard/product-scores | list[{ metric, score }] |
| /api/dashboard/quarterly-targets | list[{ quarter, rate }] |

### Dashboard 网格布局

Dashboard 是 CSS Grid 容器，子组件通过 \`_w\` prop 控制占列数:

- \`columns\` 默认 12（栅格总列数），\`gap\` 默认 16（间距 px）
- 每个子组件设置 \`_w\` 决定占几列，如 \`_w: 3\` 占 3/12=25%，\`_w: 6\` 占 50%
- 不设 \`_w\` 时默认占满整行
- **重要**: 仪表盘顶层必须用 Dashboard，不能用 Row（Row 是 flex 布局，不支持 _w 网格）

### KPI 指标行（StatCard）

4 个 StatCard 并排，每个 \`_w: 3\`:

\`\`\`json
{ "id": "statSales", "component": "StatCard", "props": {
  "_w": 3, "label": "总销售额", "value": { "path": "/kpiSales" },
  "prefix": "¥", "suffix": "万", "trend": { "path": "/kpiSalesTrend" },
  "trendLabel": "同比", "sparklineData": { "path": "/kpiSalesSpark" }
}}
\`\`\`

StatCard 关键 prop:
- \`value\`: 主数值（DataBinding），\`prefix\`/\`suffix\` 装饰前后文本（如 ¥/万/%）
- \`trend\`: 同比变化百分比，正值绿箭头▲，负值红箭头▼
- \`sparklineData\`: 纯数值数组 [420,380,510,460,590,650]，自动渲染迷你趋势线
- \`color\`: 主题色，默认 #1890ff

### 图表行模式

图表应包裹在 Card 中（Card 提供标题 + 边框，图表放在 children 里）:

\`\`\`json
{ "id": "cardBar", "component": "Card", "props": { "_w": 6, "title": "月度销售额", "children": ["barChart"] } },
{ "id": "barChart", "component": "BarChart", "props": {
  "data": { "path": "/barData" }, "xField": "month", "yField": "sales",
  "height": 280, "color": "#1890ff", "showDataLabel": true,
  "reactionId": "onBarClick"
}}
\`\`\`

常用图表行配置: 两个 \`_w: 6\` 的 Card 并排，每个内嵌一个图表。**不要**把图表直接放 Dashboard 的 children 中，会缺少标题卡片。

### 图表联动模式（click → Reaction → 交叉过滤）

图表点击联动三要素:
1. 图表组件设 \`reactionId\`
2. 源 Reaction 用 pipe get \`/_event.xxx\` 读取点击数据
3. 过滤结果写入目标图表的 data 路径

完整示例（柱状图点击 → 过滤散点图）:

\`\`\`json
{
  "id": "onBarClick", "when": { "field": "barChart", "event": "click" },
  "then": [
    {
      "type": "setValues",
      "map": {
        "/clickMonth": { "pipe": [{ "get": "/_event.month" }] },
        "/drillMonth": { "pipe": [{ "get": "/_event.month" }] },
        "/drillSales": { "pipe": [{ "get": "/_event.sales" }] },
        "/scatterFiltered": {
          "pipe": [
            { "get": "/scatterAll" },
            { "filter": "$.sales >= _event.sales" }
          ]
        }
      }
    },
    { "type": "toast", "message": "已按销售额过滤散点图", "variant": "success" }
  ]
}
\`\`\`

联动关键点:
- 受联动影响的图表用另一个 data 路径（如 \`/scatterFiltered\`），初始通过 init 从 \`/scatterAll\` 复制
- filter 表达式中 \`_event\` 是点击数据对象（字段名与图表 yField 一致）
- 可加 condition 分支实现 toggle（同值再次点击恢复全量）

### 下钻信息行（Text 模板）

用 Text 组件展示当前下钻上下文:

\`\`\`json
{ "id": "drillInfo", "component": "Text", "props": { "_w": 12, "text": "下钻: \${/drillMonth} — \${/drillSales}", "size": "base", "color": "text-blue-500" } }
\`\`\`

点击图表时 Reaction 写入 \`/drillMonth\` / \`/drillSales\`，Text 自动刷新。

### 数据模型结构

\`\`\`
/rawKpi /rawMonthly /rawScatter ... — API 原始响应（临时路径，用于 pipe get 提取字段）
/barData       — 图表数据（从 /rawMonthly.list 提取）
/kpiSales      — KPI 数值（从 /rawKpi.totalSales 提取）
/kpiSalesTrend — KPI 同比 %（从 /rawKpi.salesTrend 提取）
/scatterFiltered — 散点图过滤后数据（初始 = /rawScatter.list）
/_event        — 运行时存储图表点击数据（系统自动写入，初始填 {}）
/drillMonth    — 下钻信息（初始 ""）
/drillSales    — 下钻信息（初始 0）
\`\`\`

命名规范: \`/rawXxx\` 存 API 原始响应，\`/kpiXxx\` 存指标数值，\`/xxxData\` 存图表数据数组。

### 数据加载策略

BI 看板采用三层数据架构:

**1. 首屏加载（init + apiRequest）**—— 页面打开时一次性拉取历史/静态数据:
\`\`\`json
{ "id": "initLoad", "when": { "field": "/_", "event": "init" }, "then": [
  { "type": "apiRequest", "url": "/api/dashboard/kpi", "outputTo": "/rawKpi" },
  { "type": "apiRequest", "url": "/api/dashboard/monthly-stats", "outputTo": "/rawMonthly" },
  { "type": "setValues", "map": { "/kpiSales": { "pipe": [{ "get": "/rawKpi.totalSales" }] }, ... }}
]}
\`\`\`

**2. 定时刷新（schedule）**—— 对实时性要求高的 KPI 指标每秒/每分钟拉取增量:
\`\`\`json
{ "id": "pollKpi", "when": { "field": "/_", "event": "init" }, "then": [
  { "type": "schedule", "interval": 30000, "then": [
    { "type": "apiRequest", "url": "/api/dashboard/kpi", "outputTo": "/rawKpi" },
    { "type": "setValues", "map": {
      "/kpiSales":    { "pipe": [{ "get": "/rawKpi.totalSales" }] },
      "/kpiOrders":   { "pipe": [{ "get": "/rawKpi.totalOrders" }] }
    }}
  ]}
]}
\`\`\`
- interval 建议: KPI 看板 30s，实时监控 5s
- schedule 仅刷新需要更新的字段，不用重新拉取全部历史数据
- 页面 unload 时自动清除定时器

**3. 服务端推送（WebSocket）**—— 后端主动推送 updateDataModel 增量消息:
\`\`\`json
// 后端推送的消息格式（与前端 processMessages 兼容）
{ "updateDataModel": { "surfaceId": "main", "path": "/kpiSales", "value": 6720 } }
\`\`\`
- 推送适合秒级以下实时性（交易数据、告警）
- 客户端通过 LiveTransport 连接 WebSocket，收到消息自动更新 DataModel
- 不需要 Reaction，组件通过 DataBinding 自动刷新
- unload 时关闭 WebSocket 连接

**选择规则:**
- 历史趋势数据 → init + apiRequest（一次性）
- 分钟级刷新的 KPI → schedule（定时轮询）
- 秒级实时数据 → WebSocket 推送
- **不要**在 a2ui 数组中用 updateDataModel 内联静态数据

### 看板最小骨架

\`\`\`json
{
  "a2ui": [
    { "beginRendering": { "surfaceId": "main", "catalogId": "basic" } },
    { "surfaceUpdate": { "surfaceId": "main", "components": [
      { "id": "root", "component": "Dashboard", "props": { "children": ["drillInfo","stat1","stat2","stat3","stat4","cardBar","cardLine"], "columns": 12, "gap": 16 } },
      { "id": "drillInfo", "component": "Text", "props": { "_w": 12, "text": "点击图表查看详情", "color": "text-gray-500" } },
      { "id": "stat1", "component": "StatCard", "props": { "_w": 3, "label": "指标1", "value": { "path": "/kpi1" } } },
      { "id": "stat2", "component": "StatCard", "props": { "_w": 3, "label": "指标2", "value": { "path": "/kpi2" } } },
      { "id": "stat3", "component": "StatCard", "props": { "_w": 3, "label": "指标3", "value": { "path": "/kpi3" } } },
      { "id": "stat4", "component": "StatCard", "props": { "_w": 3, "label": "指标4", "value": { "path": "/kpi4" } } },
      { "id": "cardBar", "component": "Card", "props": { "_w": 6, "title": "柱状图", "children": ["barChart"] } },
      { "id": "cardLine", "component": "Card", "props": { "_w": 6, "title": "折线图", "children": ["lineChart"] } },
      { "id": "barChart", "component": "BarChart", "props": { "data": { "path": "/barData" }, "xField": "month", "yField": "sales", "height": 280, "reactionId": "onBarClick" } },
      { "id": "lineChart", "component": "LineChart", "props": { "data": { "path": "/lineData" }, "xField": "month", "yField": "revenue", "height": 280 } }
    ] } },
    { "updateDataModel": { "surfaceId": "main", "path": "/_event", "value": {} } },
    { "updateDataModel": { "surfaceId": "main", "path": "/barData", "value": [{"month":"1月","sales":420},{"month":"2月","sales":380}] } }
  ],
  "logic": {
    "reactions": [
      { "id": "initLoad", "when": { "field": "/_", "event": "init" }, "then": [/* 初始数据写入 */] },
      { "id": "onBarClick", "when": { "field": "barChart", "event": "click" }, "then": [/* 联动逻辑 */] }
    ]
  }
}
\`\`\`
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
{ "type": "apiRequest", "url": "/api/products", "params": { "category": "/productCategory" }, "outputTo": "/rawProducts" }

// 赋值
{ "type": "setValues", "map": { "/unitPrice": "/productDetail.price" } }

// 赋值 + pipe 管道
{ "type": "setValues", "map": { "/opts": { "pipe": [{ "get": "/raw.list" }, { "map": "({ label: $.name, value: $.id })" }] } } }

// 校验（重要：校验失败会抛出异常，自动终止当前 Reaction 链，后续 Action 不会执行）
{ "type": "validate", "rules": [{ "field": "/productCategory", "required": true, "message": "请选择大类" }] }

// Toast 提示
{ "type": "toast", "message": "操作成功", "variant": "success" }

// 条件分支
{ "type": "condition", "branches": [{ "if": "$product.status === 'discontinued'", "then": [...] }, { "then": [...] }] }

// 级联重置
{ "type": "cascade", "target": "/productId" }
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
- params/body 的值若引用表单字段，用 "/字段名"（Reaction Action 内部使用简化路径）
- **outputTo 规则（重要）**：apiRequest 将 API 的完整响应体写入 outputTo。几乎所有 API 都返回 { list: [...] } 或含嵌套字段的对象结构，因此请遵循两段式模式：先写到临时路径 /rawXxx，再用 setValues + pipe get 提取需要的字段（如 get /rawXxx.list）。切勿直接将 outputTo 指向需要数组的组件路径——这会导致组件收到对象而非数组，无法正常渲染
`
}

// ===== Pipe 管道 =====

function buildPipeSection(): string {
  return `
## Pipe 管道操作符

管道用于 setValues 的 map 中做数据转换，是一组有序步骤:

| 操作符 | 用途 | 参数示例 |
|--------|------|---------|
| get | 从 dataModel 全局根路径取值（**不是**从 pipe 当前值读取，总是从 dataModel 根路径读取） | "/rawProducts.list" |
| filter | 过滤数组，$ 代表当前项，可直接访问 dataModel 字段 | "$.sales >= _event.sales" |
| map | 映射数组，$ 代表当前项，可直接访问 dataModel 字段 | "({ label: $.name, value: $.id })" |
| compute | 表达式计算，$value 代表当前值，可直接访问 dataModel 字段 | "$value * quantity" |
| yoy | 同比计算: (current - previous) / \|previous\| × 100，返回百分比 | { "current": "/sales", "previous": "/salesLastYear" } |
| mom | 环比计算: (current - previous) / \|previous\| × 100，返回百分比 | { "current": "/sales", "previous": "/salesLastMonth" } |

**yoy/mom 说明:**
- current 和 previous 支持两种写法: dataModel 路径（如 "/kpiSales"）或字面量（如 500）
- previous 为 0 时返回 0，避免除零错误
- 返回值是百分比数值（如 18.5 表示增长 18.5%，-3.2 表示下降 3.2%）

**Pipe 完整示例:**
\`\`\`json
{
  "type": "setValues",
  "map": {
    "/productOptions": {
      "pipe": [
        { "get": "/rawProducts.list" },
        { "map": "({ label: $.name, value: $.id })" }
      ]
    }
  }
}
\`\`\`

**compute 表达式规则（重要）:**
- compute 参数是纯 JavaScript 表达式，执行在受限沙箱中
- **禁止在表达式中使用 / 前缀**，直接写字段名即可
- 可用变量: $value（管道当前值）、以及 dataModel 中的所有顶层字段名（如 quantity、unitPrice、productId）
- 正确: \`"compute": "$value * quantity"\`
- 错误: \`"compute": "/unitPrice * /quantity"\` ← 这是无效 JS
- 如果只需读取一个字段并计算，先 get 再 compute:
  \`{ "get": "/unitPrice" }, { "compute": "$value * quantity" }\`
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

// ===== 表单模式 =====

function buildFormPatternSection(): string {
  return `
## 表单模式

表单页面使用 Row/Card 容器包裹输入组件，使用 Button 触发提交:

\`\`\`json
{ "id": "root", "component": "Row", "props": { "children": ["cardForm", "cardActions"], "gap": 16 } },
{ "id": "cardForm", "component": "Card", "props": { "title": "表单", "children": ["field1", "sel1"] } },
{ "id": "field1", "component": "TextField", "props": { "label": "名称", "value": { "path": "/name" } } },
{ "id": "sel1", "component": "Select", "props": { "label": "类型", "value": { "path": "/type" }, "options": { "path": "/typeOptions" } } },
{ "id": "cardActions", "component": "Card", "props": { "title": "操作", "children": ["btn"] } },
{ "id": "btn", "component": "Button", "props": { "label": "提交", "variant": "primary", "reactionId": "submit" } }
\`\`\`

**表单交互模式:**
- 下拉联动: 上级 Select change → apiRequest 加载下级选项 → setValues + pipe map 转换
- 回填: 选中项后 setValues 回填单价/单位
- 计算: TextField change → compute 计算总价
- 提交: Button click → validate 校验 → apiRequest POST → toast 提示
- 级联: 上级变化用 cascade 清空下级字段

**数据模型（updateDataModel）:**
- 表单初始值用 updateDataModel 内联（下拉选项、输入框默认值等）
- 表单页面 **不** 使用 Dashboard/StatCard/图表组件
`
}

// ===== 组装 =====

export function buildSystemPrompt(userRequirement: string, opts?: {
  existingPage?: string
  exampleType?: 'form' | 'dashboard'
}): string {
  return `你是低代码页面生成器。根据用户的自然语言需求，生成完整的 A2UI + Logic JSON。

${buildDSLSpec()}

${buildMultiPageSection()}

${buildExecutionModel()}

${typeSection}

${buildComponentSection()}

${buildActionSection()}

${buildApiSection()}

${buildPipeSection()}

${buildRulesSection()}

---

## 用户需求

${userRequirement}

${opts?.existingPage ? `\n当前页面: ${opts.existingPage}\n请根据需求修改或扩展此页面。` : ''}

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
## Pipe: get/filter/map/compute/yoy/mom
## 规则: DynamicValue { "path": "/xxx" } 引用数据, cascade 先清空再加载, when.event=change|click|init

## 需求
${userRequirement}
`
}

/**
 * 构建自包含的 Prompt（附带完整格式示例）
 * 适合首次使用或复杂需求场景
 */
const FORM_EXAMPLE = `
## 完整示例 — 订单表单

以下是一个"产品选择+订单创建"表单的完整输出，供参考格式:

\`\`\`json
{
  "a2ui": [
    { "beginRendering": { "surfaceId": "main", "catalogId": "basic" } },
    { "surfaceUpdate": { "surfaceId": "main", "components": [
      { "id": "root", "component": "Row", "props": { "children": ["card1", "card2"], "gap": 16 } },
      { "id": "card1", "component": "Card", "props": { "title": "表单", "children": ["field1"] } },
      { "id": "field1", "component": "TextField", "props": { "label": "名称", "value": { "path": "/name" }, "placeholder": "请输入" } },
      { "id": "card2", "component": "Card", "props": { "title": "操作", "children": ["btn"] } },
      { "id": "btn", "component": "Button", "props": { "label": "提交", "variant": "primary", "reactionId": "submit" } }
    ] } },
    { "updateDataModel": { "surfaceId": "main", "path": "/name", "value": "" } },
    { "updateDataModel": { "surfaceId": "main", "path": "/categoryOptions", "value": [{ "label": "选项1", "value": "V1" }] } },
    { "updateDataModel": { "surfaceId": "main", "path": "/productCategory", "value": "" } }
  ],
  "logic": {
    "reactions": [
      { "id": "submit", "when": { "field": "btn", "event": "click" }, "then": [
        { "type": "validate", "rules": [{ "field": "/name", "required": true, "message": "请输入名称" }] },
        { "type": "toast", "message": "提交成功", "variant": "success" }
      ]}
    ]
  }
}
\`\`\`
`

const DASHBOARD_EXAMPLE = `
## 完整示例 — BI 看板

以下是一个 BI 看板的完整输出，包含 KPI 指标、图表、API 数据加载和点击联动:

\`\`\`json
{
  "a2ui": [
    { "beginRendering": { "surfaceId": "main", "catalogId": "basic" } },
    { "surfaceUpdate": { "surfaceId": "main", "components": [
      { "id": "root", "component": "Dashboard", "props": { "children": ["drillInfo","stat1","stat2","cardBar","cardPie"], "columns": 12, "gap": 16 } },
      { "id": "drillInfo", "component": "Text", "props": { "_w": 12, "text": "点击图表查看详情", "color": "text-gray-500" } },
      { "id": "stat1", "component": "StatCard", "props": { "_w": 3, "label": "销售额", "value": { "path": "/kpiSales" }, "prefix": "¥", "suffix": "万", "trend": { "path": "/kpiSalesTrend" }, "trendLabel": "同比" } },
      { "id": "stat2", "component": "StatCard", "props": { "_w": 3, "label": "订单量", "value": { "path": "/kpiOrders" }, "suffix": "单", "trend": { "path": "/kpiOrdersTrend" }, "trendLabel": "同比", "color": "#52c41a" } },
      { "id": "cardBar", "component": "Card", "props": { "_w": 6, "title": "月度销售额", "children": ["barChart"] } },
      { "id": "cardPie", "component": "Card", "props": { "_w": 6, "title": "品类占比", "children": ["pieChart"] } },
      { "id": "barChart", "component": "BarChart", "props": { "data": { "path": "/barData" }, "xField": "month", "yField": "sales", "height": 280, "reactionId": "onBarClick" } },
      { "id": "pieChart", "component": "PieChart", "props": { "data": { "path": "/pieData" }, "labelField": "name", "valueField": "value", "height": 280, "reactionId": "onPieClick" } }
    ] } },
    { "updateDataModel": { "surfaceId": "main", "path": "/_event", "value": {} } },
    { "updateDataModel": { "surfaceId": "main", "path": "/drillMonth", "value": "" } },
    { "updateDataModel": { "surfaceId": "main", "path": "/drillSales", "value": 0 } }
  ],
  "logic": {
    "reactions": [
      { "id": "initLoad", "when": { "field": "/_", "event": "init" }, "then": [
        { "type": "apiRequest", "url": "/api/dashboard/kpi", "outputTo": "/rawKpi" },
        { "type": "apiRequest", "url": "/api/dashboard/monthly-stats", "outputTo": "/rawMonthly" },
        { "type": "apiRequest", "url": "/api/dashboard/category-share", "outputTo": "/rawCategory" },
        { "type": "setValues", "map": {
          "/kpiSales":      { "pipe": [{ "get": "/rawKpi.totalSales" }] },
          "/kpiSalesTrend": { "pipe": [{ "get": "/rawKpi.salesTrend" }] },
          "/kpiOrders":     { "pipe": [{ "get": "/rawKpi.totalOrders" }] },
          "/kpiOrdersTrend":{ "pipe": [{ "get": "/rawKpi.ordersTrend" }] },
          "/barData":       { "pipe": [{ "get": "/rawMonthly.list" }] },
          "/pieData":       { "pipe": [{ "get": "/rawCategory.list" }] }
        }}
      ]},
      { "id": "onBarClick", "when": { "field": "barChart", "event": "click" }, "then": [
        { "type": "setValues", "map": {
          "/drillMonth":   { "pipe": [{ "get": "/_event.month" }] },
          "/drillSales":   { "pipe": [{ "get": "/_event.sales" }] }
        }},
        { "type": "toast", "message": "选中 \${/drillMonth}: 销售额 \${/drillSales} 万", "variant": "info" }
      ]},
      { "id": "onPieClick", "when": { "field": "pieChart", "event": "click" }, "then": [
        { "type": "toast", "message": "\${/_event.name}: 占比 \${/_event.value}%", "variant": "info" }
      ]}
    ]
  }
}
\`\`\`
`

export function buildFullPrompt(userRequirement: string, exampleType: 'form' | 'dashboard' = 'dashboard'): string {
  const base = buildSystemPrompt(userRequirement, { exampleType })
  const example = exampleType === 'form' ? FORM_EXAMPLE : DASHBOARD_EXAMPLE

  return `${base}
${example}`
}
