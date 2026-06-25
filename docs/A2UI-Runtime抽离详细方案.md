# A2UI Runtime 抽离详细方案

## 1. 文档目的

本文档用于指导 `a2ui-react` 项目将页面运行能力从现有调试功能中抽离，形成项目内部统一、可复用的 `A2UI Runtime`。

需要先明确当前产品边界：

- 当前“预览页”负责调用 Agent 生成或上传 JSON，并立即查看运行效果。
- 当前“调试器页面”负责组件树、数据模型和运行过程调试。
- 上述两个页面合在一起，才构成项目现有的完整调试功能。
- 当前项目缺少的是“实际渲染页”：它不包含 Agent、JSON 编辑、组件树或调试面板，只从路由参数、组件参数或页面配置接口取得 JSON，再交给 Runtime 渲染。

抽离完成后，以下场景必须使用同一套 Runtime：

- 调试功能中的 Agent 生成结果预览
- 调试功能中的 Debugger 页面
- 独立的实际渲染页
- 后续作为微前端子应用嵌入生产系统的实际渲染页
- 将来可能提供的 npm 包或 Module Federation Remote

核心目标是保证：

> 调试功能中运行的页面和实际应用中渲染的页面使用同一条渲染及交互链路。

---

## 2. 当前项目现状

### 2.1 已具备的 Runtime 基础能力

当前项目已经具备较完整的页面运行链路：

```text
页面 JSON
  ↓
normalizeToPages / toV09
  ↓
A2UIProvider / MessageProcessor
  ↓
SurfaceModel / DataModel
  ↓
A2uiSurface
  ↓
组件 Catalog
  ↓
ReactionEngine / PipeEngine
  ↓
API、数据更新、导航、Toast
```

主要代码分布如下：

| 文件 | 当前职责 |
| --- | --- |
| `src/app/A2UIApp.tsx` | 完整调试功能入口，组合 Debugger 与 Agent 预览页，同时包含部分 Runtime 编排逻辑 |
| `src/runtime/a2ui-context.tsx` | MessageProcessor、Surface、DataModel 生命周期 |
| `src/runtime/page-context.tsx` | 多页面加载、页面切换、URL Hash 同步 |
| `src/runtime/a2ui-adapter.ts` | Legacy、v0.8、v0.9 JSON 格式归一化 |
| `src/runtime/a2ui-catalog.tsx` | A2UI 组件实现及 Catalog |
| `src/runtime/reaction-engine.ts` | Reaction 注册、触发和 Action 执行 |
| `src/runtime/pipe-engine.ts` | 数据处理管道 |
| `src/runtime/shared-store.ts` | 跨页面共享数据及导航参数 |
| `src/mock/api.ts` | Mock API Executor |
| `src/views/Debugger.tsx` | 编辑和调试工具界面 |

### 2.2 当前主要问题

目前 `A2UIApp.tsx` 中混合了以下职责：

- Agent 配置及页面生成
- JSON 文件上传
- 示例页面选择
- Agent 生成/JSON 上传预览界面
- PageProvider 初始化
- ReactionEngine 创建与销毁
- Surface action 监听
- Toast 展示
- 页面实际渲染

因此存在以下风险：

1. 新增实际渲染页时容易复制现有 Agent 预览页中的运行代码，形成第二套运行逻辑。
2. 调试功能和实际渲染页可能采用不同的 Engine 初始化方式。
3. API、导航、Toast 等能力目前与具体实现耦合。
4. `PageProvider` 直接修改浏览器 Hash，嵌入宿主后可能与宿主路由冲突。
5. Mock API Executor 在 Runtime 编排层被直接创建，不利于生产替换。
6. Runtime 缺乏稳定的公开接口和生命周期事件。
7. Agent 预览页与 Debugger 目前没有通过统一 Runtime 公共接口协作。
8. 项目尚无只接收参数和 JSON 的纯实际渲染入口。

---

## 3. 抽离目标与非目标

### 3.1 本次目标

本次抽离需要实现：

1. 提供统一的 `<A2UIRuntime />` React 入口。
2. Runtime 仅接收页面定义和外部服务，不包含编辑器工具 UI。
3. 统一管理 JSON 归一化、Surface、Engine、页面导航和销毁。
4. Agent 预览页、Debugger 页面和新增的实际渲染页全部复用 Runtime。
5. 支持注入 Mock API 和生产 API。
6. 支持内部路由、URL Hash 路由和宿主代理路由。
7. 支持 Runtime 事件、错误、日志及状态快照。
8. 为后续微前端封装提供稳定接口。

### 3.2 本次非目标

以下内容不建议与 Runtime 抽离同时完成：

- 完整页面配置中心
- 数据库存储和发布审批
- 多租户管理后台
- 微前端框架选型和正式接入
- npm 包发布
- 全量重写 ReactionEngine
- 全量迁移现有 JSON 协议

这些工作可以在 Runtime 边界稳定后独立推进。

---

## 4. 目标架构

```text
┌────────────────────────────────────────────────────────────┐
│                        产品入口层                           │
│                                                            │
│  DebugApp                          RenderApp                │
│  ├─ AgentPreviewPage               只接收参数/加载 JSON     │
│  └─ DebuggerPage                   不包含任何调试工具        │
│       完整调试功能                       │                  │
└───────────────┬──────────────────────────┬───────────────────┘
                │ definition/services      │ definition/context
                ▼                          ▼
┌────────────────────────────────────────────────────────────┐
│                       A2UIRuntime                           │
│ RuntimeBoundary / Provider / Controller / Renderer         │
│ RuntimeRouter / RuntimeEventBus                            │
└──────────────────────────┬─────────────────────────────────┘
                           │
       ┌───────────────────┼───────────────┬─────────────────┐
       ▼                   ▼               ▼                 ▼
 A2UIProvider         PageProvider   ReactionEngine     SharedStore
       │                   │               │
       ▼                   ▼               ▼
 MessageProcessor       Surface         Pipe/Action
       │
       ▼
 A2uiSurface + Catalog

RenderApp 可进一步由 micro-app 包装后嵌入生产宿主。
```

### 4.1 分层原则

建议划分为四层：

#### 协议层

负责页面 JSON 类型、格式归一化、协议版本和校验。

#### 运行内核层

负责 Surface、DataModel、Reaction、Pipe、页面及资源生命周期。

#### 能力适配层

负责 API、导航、Toast、鉴权上下文、日志、埋点等外部能力。

#### 产品入口层

负责完整调试端、纯实际渲染页和微前端宿主桥接。Agent 预览页与 Debugger 页面属于同一个调试端，而不是两个独立产品入口。

产品入口层不能直接创建 `ReactionEngine` 或操作 `MessageProcessor`。

---

## 5. 建议目录结构

```text
src/                                      # 项目业务源码
  runtime/                                # 与调试工具 UI 无关的统一页面运行内核
    public/                               # Runtime 对外公开 API；上层原则上只从这里导入
      A2UIRuntime.tsx                     # Runtime 主组件，组合初始化、渲染、错误处理及 ref
      runtime-types.ts                    # Props、Options、Context、Event、Error 等公共类型
      runtime-handle.ts                   # 调试端/宿主可调用的受控命令接口
      index.ts                            # Runtime 公共导出入口，隐藏内部实现文件

    core/                                 # Runtime 生命周期和运行流程编排
      RuntimeProvider.tsx                 # 统一组合 Services、Event、A2UI、Page 等 Provider
      RuntimeController.ts                # 管理加载、重载、导航、快照和销毁等核心命令
      RuntimeRenderer.tsx                 # 获取当前 Surface 并通过 A2uiSurface 渲染页面
      RuntimeErrorBoundary.tsx            # 捕获组件树渲染异常并转换为 RuntimeError
      RuntimeEventBus.ts                  # 发布和订阅 Runtime、页面、Reaction、API 等事件
      RuntimeDefinitionLoader.ts          # 接收、校验、归一化 Definition，并确定初始页面

    routing/                              # 页面导航抽象，避免 Runtime 直接依赖浏览器 Hash
      RuntimeRouter.ts                    # Router 接口、Location 和 NavigationTarget 类型
      memory-router.ts                    # 内存路由；默认用于微前端和调试端预览
      hash-router.ts                      # Hash 路由；用于 Runtime 独立运行页面
      host-router.ts                      # 宿主代理路由；把跨应用导航请求交给生产宿主

    services/                             # Runtime 对外部环境能力的抽象和默认实现
      runtime-services.ts                 # API、Toast、导航、日志、埋点、错误上报服务定义
      default-services.ts                 # 无副作用默认实现及缺失服务的明确报错策略
      api-executor.ts                     # API 请求模型、执行器接口及 API Registry 适配
      logger-adapter.ts                   # 将项目日志或宿主日志转换成 RuntimeLogger

    protocol/                             # 页面 Definition 协议处理与兼容
      a2ui-adapter.ts                     # Legacy、v0.8、v0.9 格式转换和页面归一化
      definition-validator.ts             # 校验组件、引用、Reaction、API 和安全限制
      protocol-version.ts                 # 协议、Catalog、Runtime 版本兼容规则

    engines/                              # 页面声明式业务逻辑执行引擎
      reaction-engine.ts                  # 监听事件并按顺序执行 Action 链
      pipe-engine.ts                      # 执行 get、filter、map、compute 等数据管道
      script-engine.ts                    # 在受限上下文中执行允许的脚本或表达式
      reaction-to-js.ts                   # Reaction 定义与可执行表达形式之间的转换辅助

    state/                                # Surface、页面、共享数据等运行状态管理
      a2ui-context.tsx                    # 管理 MessageProcessor、Surface 和 DataModel
      page-context.tsx                    # 管理多页面加载、当前页面和页面历史
      page-state.ts                       # 管理 Dialog 等子页面的注册表和纯状态逻辑
      shared-store.ts                     # 管理跨页面共享数据及导航参数

    catalog/                              # Runtime 可渲染组件的注册与类型
      a2ui-catalog.tsx                    # Text、Card、Form、Chart 等组件实现和注册
      catalog-types.ts                    # 组件 Schema、扩展 Catalog 和组件元信息类型

  debug-app/                              # 完整调试功能；包含 Agent 预览页和 Debugger 页面
    DebugApp.tsx                          # 调试端总入口，负责两个调试页面的模式切换和布局
    AgentPreviewPage.tsx                  # 调用 Agent/上传 JSON，并通过 A2UIRuntime 查看效果
    DebuggerPage.tsx                      # 组件树、数据模型、属性及运行过程调试页面
    AgentPanel.tsx                        # 模型配置、需求输入和页面生成操作
    JsonUploadPanel.tsx                   # 上传、解析和切换本地 JSON Definition
    RuntimeDebugPanel.tsx                 # 展示 Runtime 快照、事件时间线和受控调试命令

  render-app/                             # 当前缺少的实际应用渲染入口，不包含调试工具
    RenderApp.tsx                         # 根据传参取得 Definition 并渲染 A2UIRuntime
    definition-source.ts                  # 从 props、URL 参数或配置 API 解析/加载 JSON
    render-app-types.ts                   # pageId、version、definition、context 等入参类型
    RenderLoading.tsx                     # Definition 获取过程中的生产加载状态
    RenderError.tsx                       # 参数、加载或 Runtime 错误的生产错误状态

  micro-app/                              # 将 render-app 适配到生产宿主的微前端层
    MicroApp.tsx                          # 加载发布 Definition 并渲染生产 A2UIRuntime
    host-bridge.ts                        # 封装导航、Toast、请求和事件等宿主通信
    micro-app-types.ts                    # 宿主参数、消息协议及协议版本类型
    adapters/                             # 可选：不同微前端接入方式的薄适配器
      iframe-bridge.ts                    # iframe postMessage 通信与来源校验
      qiankun-entry.tsx                   # qiankun bootstrap/mount/unmount 生命周期
      single-spa-entry.tsx                # single-spa 生命周期适配
      federation-entry.tsx                # Module Federation Remote 暴露入口
```

第一阶段不必立即移动所有现有文件。可以先建立 `runtime/public` 和 `runtime/core`，复用当前 `src/runtime` 内的实现；等公共入口稳定后再进行目录整理，降低一次性改动风险。

### 5.1 目录职责和依赖规则

| 目录 | 主要职责 | 可以依赖 | 不应依赖 |
| --- | --- | --- | --- |
| `runtime/public` | 对外提供稳定组件、类型和控制接口 | `runtime/core` 及公共类型 | Debug App、Render App、Micro App 的具体实现 |
| `runtime/core` | 编排 Definition、Surface、Engine、页面和生命周期 | Protocol、State、Engines、Services、Routing、Catalog | Agent、Mock API、调试面板 |
| `runtime/routing` | 统一页面位置和导航行为 | 通用类型、宿主回调 | React 页面 UI、ReactionEngine 内部实现 |
| `runtime/services` | 抽象请求、Toast、日志、埋点等环境能力 | 公共类型和少量协议类型 | 具体生产系统 SDK，除非通过 Adapter 封装 |
| `runtime/protocol` | 负责 Definition 格式兼容、版本和校验 | Types、Catalog 元数据 | React UI、浏览器路由、宿主状态 |
| `runtime/engines` | 执行 Reaction、Action、Pipe 和受控脚本 | Services 接口、DataModel 接口 | Debug App、Render App、具体微前端框架 |
| `runtime/state` | 管理运行状态和 Provider | Protocol、Routing、A2UI SDK | Agent 和设计器工具状态 |
| `runtime/catalog` | 注册并实现 Runtime 组件 | UI 基础组件、A2UI SDK、运行状态接口 | Debugger 属性面板和 Agent Prompt |
| `debug-app` | 组合 Agent 预览页和 Debugger，提供完整调试功能 | `runtime/public`、Agent、Mock Adapter | Runtime 内部 Controller、Surface、Engine 实例 |
| `render-app` | 仅根据传参或配置接口取得 JSON 并实际渲染 | `runtime/public`、Definition Source、生产 Services | Agent、Debugger、Mock 数据和 Runtime 私有实现 |
| `micro-app` | 将 Render App 适配到生产宿主及具体微前端形式 | `render-app`、Host Bridge | Runtime 私有实现、调试功能和 Mock 数据 |

关键依赖方向为：

```text
Debug App / Render App
          ↓
    Runtime Public
            ↓
       Runtime Core
            ↓
Protocol / Routing / Services / Engines / State / Catalog
```

依赖只能自上而下。Runtime 内部不能反向引用 `debug-app`、`render-app` 或 `micro-app`，否则会造成循环依赖并把工具代码带入生产 Bundle。

### 5.2 `micro-app` 目录的定位与作用

`micro-app` 不是 Runtime Core 的组成部分，而是 Runtime 与生产宿主应用之间的适配层。它的核心作用是把纯生产 `RenderApp` 包装成可以被生产系统嵌入的微前端子应用；`RenderApp` 内部再使用通用的 `<A2UIRuntime />`。

```text
生产宿主应用
  ↕ 宿主通信协议
micro-app 适配层
  ↕ 宿主参数 / Host Bridge
RenderApp
  ↕ Definition / Runtime Services
A2UIRuntime
```

`micro-app` 只负责接入形式和环境转换，不负责解释或运行页面 JSON。页面 JSON 的归一化、Surface 创建、Reaction 执行、组件渲染等能力仍由 Runtime Core 统一完成。

#### 主要职责

##### 1. 接收宿主参数

宿主应用可能传入：

```ts
export interface MicroAppProps {
  pageId: string
  version?: string
  token?: string
  context?: {
    userId: string
    tenantId: string
    permissions: string[]
  }
}
```

`micro-app` 负责把这些参数和宿主能力转换成 `RenderApp` 所需的 props；`RenderApp` 再负责加载 Definition 并组装 `A2UIRuntime`。

##### 2. 复用 Render App 的 Definition 加载能力

Runtime Core 原则上只负责运行 Definition，不负责决定 Definition 来自本地文件、Agent、数据库还是配置中心。生产 Definition 的来源解析和加载由 `render-app/definition-source.ts` 统一负责，`micro-app` 不应再实现一份加载逻辑。

```text
宿主传入 pageId + version
  ↓
micro-app 转换宿主参数
  ↓
RenderApp / definition-source
  ↓
请求页面配置中心并获得已发布 Definition
  ↓
A2UIRuntime
```

示例：

```tsx
function MicroApp({ pageId, version, context, bridge }: MicroAppProps) {
  return (
    <RenderApp
      pageId={pageId}
      version={version}
      context={context}
      services={createHostServices(bridge)}
      routerMode="memory"
    />
  )
}
```

##### 3. 将宿主能力转换成 Runtime Services

生产宿主通常希望统一控制请求、导航、Toast、鉴权、埋点和错误上报。`micro-app` 将宿主能力转换成 Runtime 能理解的标准服务：

```ts
const services: Partial<A2UIRuntimeServices> = {
  apiExecutor: request => hostBridge.request(request),
  navigate: target => hostBridge.emit('NAVIGATE', target),
  toast: (message, options) =>
    hostBridge.emit('TOAST', { message, options }),
  reportError: error => hostBridge.emit('RUNTIME_ERROR', error),
  track: event => hostBridge.emit('TRACK', event),
}
```

这样 Runtime 不需要知道宿主使用 React Router、Vue Router、全局消息组件还是哪一种监控平台。

##### 4. 将 Runtime 事件通知宿主

`micro-app` 负责把 Runtime 内部事件转换为稳定的宿主通信消息，例如：

- Runtime 初始化完成
- 页面加载完成
- 页面请求跳转
- 表单提交成功
- API 或 Reaction 执行失败
- Runtime 出现不可恢复错误
- iframe 场景中的页面高度变化

```ts
function handleRuntimeEvent(event: RuntimeEvent) {
  hostBridge.emit('A2UI_RUNTIME_EVENT', {
    protocol: 'a2ui-host',
    protocolVersion: '1.0',
    event,
  })
}
```

宿主通信协议应独立版本化，不能直接暴露 Runtime 内部对象。

##### 5. 适配具体微前端形式

iframe、qiankun、single-spa 和 Module Federation 的差异应停留在 `micro-app` 层：

```text
micro-app/
  MicroApp.tsx
  micro-app-types.ts
  host-bridge.ts

  adapters/
    iframe-bridge.ts
    qiankun-entry.tsx
    single-spa-entry.tsx
    federation-entry.tsx
```

其中：

- `MicroApp.tsx`：与具体微前端框架无关的生产入口。
- `micro-app-types.ts`：宿主参数、消息和协议版本定义。
- `host-bridge.ts`：宿主通信的抽象接口。
- `iframe-bridge.ts`：通过受限 `postMessage` 与父窗口通信。
- `qiankun-entry.tsx`：提供 `bootstrap`、`mount`、`unmount` 生命周期。
- `single-spa-entry.tsx`：提供 single-spa 生命周期适配。
- `federation-entry.tsx`：暴露可被远程加载的 React 组件。

无论使用哪种适配器，最终都只能调用同一个 `MicroApp`；`MicroApp` 复用 `RenderApp`，`RenderApp` 再复用 `A2UIRuntime`。

#### `micro-app` 不应该承担的职责

`micro-app` 不应该：

- 创建或管理 `ReactionEngine`
- 解析、转换页面组件 JSON
- 直接调用 `MessageProcessor`
- 直接修改 `SurfaceModel`
- 实现另一套页面导航状态
- 复制 `RuntimeRenderer`
- 实现业务组件渲染规则
- 包含 Debugger、Agent 生成面板或其他调试功能

否则它会逐渐演变为第二套 Runtime，重新造成设计态和生产态行为不一致。

#### 实施时机

`micro-app` 不是 Runtime 抽离第一阶段的前置条件。建议顺序为：

```text
1. 建立 A2UIRuntime 公共入口
2. AgentPreviewPage 和 DebuggerPage 全部接入 Runtime
3. 稳定 Services、Events、Router 和 Runtime Handle
4. 完善 Definition 校验及生命周期清理
5. 实现纯生产 RenderApp
6. 再实现 micro-app 宿主适配层
```

如果当前尚未确定使用 iframe、qiankun 还是 Module Federation，可以先保留目录及接口设计，不必提前编写具体框架适配代码。

---

## 6. Runtime 对外接口设计

### 6.1 A2UIRuntime Props

建议定义：

```ts
export interface A2UIRuntimeProps {
  /** 页面定义，支持单页或多页格式 */
  definition: unknown

  /** Runtime 外部能力 */
  services?: Partial<A2UIRuntimeServices>

  /** 宿主传入的只读上下文 */
  context?: A2UIRuntimeContext

  /** Runtime 行为配置 */
  options?: A2UIRuntimeOptions

  /** Runtime 初始化完成 */
  onReady?: (event: RuntimeReadyEvent) => void

  /** 统一事件出口 */
  onEvent?: (event: RuntimeEvent) => void

  /** Runtime 不可恢复错误 */
  onError?: (error: RuntimeError) => void

  /** 可选的加载状态 */
  fallback?: React.ReactNode

  /** 可选的错误状态 */
  errorFallback?: React.ReactNode | ((error: RuntimeError) => React.ReactNode)
}
```

### 6.2 Runtime Options

```ts
export interface A2UIRuntimeOptions {
  mode?: 'debug' | 'production'
  debug?: boolean

  /** memory 适用于微前端；hash 适用于独立应用；host 由宿主管理 */
  routerMode?: 'memory' | 'hash' | 'host'

  initialPageId?: string
  preservePageState?: boolean
  strictValidation?: boolean

  /** 单页面允许的最大组件数量等安全限制 */
  limits?: {
    maxPages?: number
    maxComponentsPerPage?: number
    maxReactionsPerPage?: number
    maxDefinitionSize?: number
  }
}
```

默认建议：

```ts
const defaultOptions: A2UIRuntimeOptions = {
  mode: 'production',
  debug: false,
  routerMode: 'memory',
  preservePageState: true,
  strictValidation: true,
}
```

### 6.3 Runtime Context

```ts
export interface A2UIRuntimeContext {
  user?: {
    id: string
    name?: string
    roles?: string[]
  }
  tenant?: {
    id: string
    name?: string
  }
  permissions?: string[]
  locale?: string
  timezone?: string
  theme?: Record<string, string>
  params?: Record<string, unknown>
  extensions?: Record<string, unknown>
}
```

Runtime Context 应作为外部只读数据注入，建议映射到独立命名空间，例如：

```text
/$context/user
/$context/tenant
/$context/permissions
/$context/params
```

页面 Reaction 默认不能修改 `/$context`。

### 6.4 Runtime Services

```ts
export interface A2UIRuntimeServices {
  apiExecutor: RuntimeApiExecutor

  navigate: (
    target: RuntimeNavigationTarget
  ) => void | Promise<void>

  toast: (
    message: string,
    options?: RuntimeToastOptions
  ) => void

  logger: RuntimeLogger

  reportError: (
    error: RuntimeError
  ) => void

  track: (
    event: RuntimeTrackEvent
  ) => void

  now: () => number
}
```

所有服务都应有安全默认实现。例如未提供 `track` 时使用空函数，但生产环境缺少 `apiExecutor` 时应给出明确错误。

### 6.5 API Executor

建议将 API 调用从具体 URL 逐步升级为 API Key：

```ts
export interface RuntimeApiRequest {
  api: string
  method?: string
  params?: Record<string, unknown>
  body?: Record<string, unknown>
  signal?: AbortSignal
  runtimeContext: A2UIRuntimeContext
}

export type RuntimeApiExecutor = (
  request: RuntimeApiRequest
) => Promise<unknown>
```

兼容期可同时支持：

```ts
type RuntimeApiTarget =
  | { api: string }
  | { url: string }
```

生产模式建议默认禁止任意 URL，仅允许 API Registry 中的 Key。

---

## 7. Runtime 控制接口

Debugger 页面需要读取状态及主动控制 Runtime。建议通过 `forwardRef` 暴露有限接口：

```ts
export interface A2UIRuntimeHandle {
  reload(definition: unknown): Promise<void>

  navigate(
    pageId: string,
    params?: Record<string, unknown>
  ): void

  goBack(): void

  getCurrentPageId(): string | null

  getDataModel(
    pageId?: string
  ): Record<string, unknown>

  setDataValue(
    path: string,
    value: unknown,
    pageId?: string
  ): void

  triggerReaction(
    reactionId: string,
    pageId?: string
  ): Promise<void>

  getSnapshot(): RuntimeSnapshot

  destroy(): void
}
```

禁止暴露：

- 原始 `MessageProcessor`
- 可任意修改的 `SurfaceModel`
- `ReactionEngine` 实例
- 内部订阅集合

这样可以避免上层代码依赖 Runtime 内部实现。

---

## 8. Runtime 事件设计

建议建立统一事件出口：

```ts
export type RuntimeEvent =
  | { type: 'runtime:ready'; payload: RuntimeReadyEvent }
  | { type: 'runtime:error'; payload: RuntimeError }
  | { type: 'page:loading'; payload: { pageId: string } }
  | { type: 'page:ready'; payload: { pageId: string } }
  | { type: 'page:changed'; payload: { from?: string; to: string } }
  | { type: 'page:unloaded'; payload: { pageId: string } }
  | { type: 'reaction:start'; payload: ReactionEvent }
  | { type: 'reaction:end'; payload: ReactionEvent }
  | { type: 'reaction:error'; payload: ReactionErrorEvent }
  | { type: 'api:start'; payload: ApiEvent }
  | { type: 'api:end'; payload: ApiEvent }
  | { type: 'api:error'; payload: ApiErrorEvent }
  | { type: 'host:navigate'; payload: RuntimeNavigationTarget }
  | { type: 'data:changed'; payload: DataChangedEvent }
```

用途包括：

- Debugger 事件时间线
- 生产埋点
- 微前端宿主通信
- 故障诊断
- E2E 测试等待页面 Ready

事件中不要直接传递包含循环引用的内部实例。

---

## 9. Runtime 内部生命周期

### 9.1 初始化

```text
接收 definition
  ↓
校验大小和基本格式
  ↓
normalizeToPages
  ↓
校验页面、组件、Reaction、导航目标
  ↓
创建 Provider 和 RuntimeController
  ↓
注入 Runtime Context
  ↓
加载初始页面 Surface
  ↓
创建 ReactionEngine
  ↓
绑定 Surface Action
  ↓
执行 init Reaction
  ↓
发出 runtime:ready / page:ready
```

### 9.2 页面切换

```text
navigate(pageId)
  ↓
校验目标页面
  ↓
触发当前页面 unload
  ↓
按配置保留或销毁当前 Surface
  ↓
首次访问时加载目标 Surface
  ↓
销毁旧页面 ReactionEngine
  ↓
创建目标页 ReactionEngine
  ↓
执行目标页 init
  ↓
发出 page:changed
```

### 9.3 Definition 更新

调试端中 JSON 会频繁更新，不能简单依赖 React 树整体重建。

建议提供两种更新策略：

```ts
type DefinitionUpdateMode =
  | 'reload'
  | 'preserve-data'
```

- `reload`：销毁所有页面状态并重新加载，适合生产切换版本。
- `preserve-data`：提取当前 DataModel，重新创建 Surface 后恢复兼容字段，适合 Agent 预览页和 Debugger 实时调试。

第一阶段可以仅实现可靠的 `reload`，第二阶段再增加增量更新。

### 9.4 销毁

Runtime 卸载时必须：

- 执行页面 unload Reaction
- 清理所有 schedule 定时器
- Abort 未完成 API 请求
- 取消 DataModel 订阅
- 取消 Surface action 订阅
- 销毁所有 ReactionEngine
- 销毁 Dialog 子 Surface
- 清理 child page registry
- 销毁全部 Surface
- 清理事件总线监听

需要确保 React Strict Mode 下重复初始化和清理不会报错。

---

## 10. 对现有模块的改造方案

### 10.1 `A2UIApp.tsx`

当前 `A2UIApp.tsx` 应被视为“完整调试功能”的总入口，而不是生产渲染入口。它包含两个互补页面：

- Agent 预览页：负责调用 Agent 生成 JSON、上传 JSON、选择示例并查看运行效果。
- Debugger 页面：负责组件树、属性、DataModel 和运行过程调试。

应保留在调试端：

- debugger/preview 两个调试页面的模式切换
- Agent 配置、页面生成和 JSON 上传
- 示例选择
- Debugger 工具栏、组件树和调试布局
- 调试端自己的 Toast、日志和 Mock 配置

应迁入 Runtime：

- `PageRenderer`
- ReactionEngine 初始化和销毁
- Surface action 监听
- `A2uiSurface` 实际渲染
- Runtime ErrorBoundary
- 页面加载、导航和资源清理

改造后两个调试页面都通过同一个 Runtime：

```tsx
function AgentPreviewPage() {
  const [definition, setDefinition] = useState(demoData)

  return (
    <div className="debug-preview-layout">
      <AgentPanel onDefinitionChange={setDefinition} />
      <A2UIRuntime
        definition={definition}
        services={debugServices}
        options={{
          mode: 'debug',
          routerMode: 'memory',
          debug: true,
        }}
      />
    </div>
  )
}

function DebuggerPage() {
  return (
    <A2UIRuntime
      ref={runtimeRef}
      definition={debugDefinition}
      services={debugServices}
      options={{ mode: 'debug', debug: true }}
      onEvent={appendDebugEvent}
    />
  )
}
```

新增的实际渲染页不应放进 `A2UIApp.tsx` 的调试模式切换中，建议使用独立路由或独立入口，例如 `/render?pageId=order-list`。

### 10.2 `a2ui-context.tsx`

短期内继续作为 Runtime 内部 Provider。

建议调整：

- 不再由产品入口直接使用。
- `load` 支持返回加载结果或 Promise。
- `onAction` 支持按指定 Surface 订阅，而非只使用 currentSurfaceId。
- 增加显式的 `destroyAllSurfaces`。
- 取消与 Toast 的直接耦合，Toast 通过 Runtime Services 提供。
- Surface 创建、销毁事件转发给 Runtime EventBus。

建议接口：

```ts
load(
  messages: A2UIMessage[],
  options: { pageId: string }
): RuntimeSurfaceHandle

subscribeAction(
  surfaceId: string,
  handler: RuntimeActionHandler
): () => void
```

### 10.3 `page-context.tsx`

需要将页面状态管理与浏览器 Hash 解耦。

当前问题：

- `navigateTo` 直接调用 `window.history.pushState`。
- `popstate` 监听固定存在。
- 微前端嵌入时可能污染宿主 URL。

建议注入 Router Adapter：

```ts
export interface RuntimeRouter {
  getLocation(): RuntimeLocation
  navigate(target: RuntimeNavigationTarget): void
  back(): void
  subscribe(listener: RuntimeLocationListener): () => void
}
```

实现三种 Router：

- `MemoryRuntimeRouter`
- `HashRuntimeRouter`
- `HostRuntimeRouter`

`PageProvider` 只调用 Router 接口，不再直接访问 `window.history`。

### 10.4 `reaction-engine.ts`

保持核心执行能力，增加依赖注入和可观测性：

- API Executor 从 Runtime Services 注入。
- Toast 从 Runtime Services 注入。
- Navigate 从 Runtime Router 注入。
- Reaction 前后发出事件。
- API 请求支持 AbortSignal。
- Engine destroy 时取消未完成任务。
- `schedule` 必须登记并在 destroy 中清理。
- 生产模式限制动态脚本执行能力。

### 10.5 `a2ui-catalog.tsx`

Catalog 是 Runtime 的组成部分，但应允许扩展：

```ts
<A2UIRuntime
  catalog={defaultCatalog}
  extensions={{
    components: businessComponents,
  }}
/>
```

建议把以下内容分离：

- 组件注册清单
- 组件实现
- 组件 Schema
- 组件设计器元数据

Runtime 只需要组件运行 Schema 和实现；编辑器所需的名称、分组、图标、属性面板配置不应进入生产 Runtime。

### 10.6 Mock API

`createMockApiExecutor()` 只能由完整调试端注入。

Runtime Core 不应 import：

```ts
@/mock/api
```

实际渲染页应注入：

```ts
createProductionApiExecutor({
  registry,
  authProvider,
  tenantProvider,
})
```

---

## 11. Runtime Provider 组合

建议 Runtime 内部统一组合 Provider：

```tsx
function RuntimeProvider({
  definition,
  services,
  context,
  options,
  children,
}: RuntimeProviderProps) {
  return (
    <RuntimeServicesProvider value={services}>
      <RuntimeEventProvider>
        <RuntimeContextProvider value={context}>
          <A2UIProvider catalog={catalog}>
            <PageProvider
              data={definition}
              router={router}
            >
              {children}
            </PageProvider>
          </A2UIProvider>
        </RuntimeContextProvider>
      </RuntimeEventProvider>
    </RuntimeServicesProvider>
  )
}
```

上层入口不再自行拼装这些 Provider。

---

## 12. Runtime Renderer 设计

`RuntimeRenderer` 负责：

- 获取当前 Page 和 Surface
- 创建、切换和销毁 ReactionEngine
- 监听 Surface action
- 渲染 `A2uiSurface`
- 展示 Runtime 级 Loading/Error
- 发出页面生命周期事件

建议伪代码：

```tsx
function RuntimeRenderer() {
  const runtime = useRuntimeController()
  const currentSurface = runtime.getCurrentSurface()

  if (runtime.status === 'loading') {
    return <RuntimeLoading />
  }

  if (runtime.status === 'error') {
    return <RuntimeErrorView error={runtime.error} />
  }

  if (!currentSurface) {
    return <RuntimeEmpty />
  }

  return (
    <RuntimeErrorBoundary>
      <A2uiSurface
        key={runtime.currentPageId}
        surface={currentSurface}
      />
    </RuntimeErrorBoundary>
  )
}
```

`PageSelector` 是调试工具，不属于 Runtime Renderer。Debugger 可以通过 Runtime Handle 获取 pageIds 后自行展示。

---

## 13. 完整调试功能如何复用 Runtime

当前 Agent 预览页和 Debugger 页面共同组成完整调试功能。两者职责不同，但都必须把 JSON 交给同一个 `A2UIRuntime` 运行。

### 13.1 Agent 预览页

Agent 预览页负责产生 Definition，不负责解释 Definition：

```tsx
function AgentPreviewPage() {
  const [definition, setDefinition] = useState(initialDefinition)

  return (
    <>
      <AgentPanel onGenerated={setDefinition} />
      <JsonUploadPanel onLoaded={setDefinition} />
      <A2UIRuntime
        definition={definition}
        services={debugServices}
        options={{ mode: 'debug', debug: true }}
      />
    </>
  )
}
```

### 13.2 Debugger 页面

Debugger 通过 Runtime Handle 和 Runtime Event 获取快照、执行受控命令和展示事件时间线：

```tsx
function DebuggerPage() {
  const runtimeRef = useRef<A2UIRuntimeHandle>(null)

  return (
    <>
      <RuntimeDebugPanel
        getSnapshot={() => runtimeRef.current?.getSnapshot()}
        setDataValue={(path, value) =>
          runtimeRef.current?.setDataValue(path, value)
        }
      />
      <A2UIRuntime
        ref={runtimeRef}
        definition={definition}
        services={debugServices}
        options={{ mode: 'debug', debug: true }}
        onEvent={appendDebugEvent}
      />
    </>
  )
}
```

### 13.3 调试端约束

Agent 预览页和 Debugger 都不得：

- 直接创建 `ReactionEngine`
- 直接调用 `processor.processMessages`
- 直接修改 SurfaceModel
- 维护另一套页面导航逻辑
- 重写组件渲染器

调试端可以：

- 生成、上传和修改 JSON Definition
- 调用 Runtime Handle
- 订阅 Runtime Event
- 展示 Runtime Snapshot
- 注入 Mock API、调试日志和测试上下文

---

## 14. 实际渲染页与微前端如何复用 Runtime

### 14.1 当前缺少的实际渲染页

实际渲染页是一个纯生产入口，其输入可以来自：

- React props 中直接传入的 `definition`
- URL 参数中的 `pageId` 和 `version`
- 微前端宿主传入的页面参数
- 页面配置中心返回的已发布 JSON

它不包含：

- Agent 调用和 Prompt 配置
- JSON 编辑/上传工具或上传工具
- 组件树和属性面板
- Runtime 调试时间线
- Mock API 选择器

建议实现：

```tsx
function RenderApp(props: RenderAppProps) {
  const source = useDefinitionSource(props)

  if (source.loading) return <RenderLoading />
  if (source.error) return <RenderError error={source.error} />

  return (
    <A2UIRuntime
      definition={source.definition}
      context={props.context}
      services={props.services ?? productionServices}
      options={{
        mode: 'production',
        routerMode: props.routerMode ?? 'memory',
        debug: false,
      }}
      onReady={props.onReady}
      onError={props.onError}
    />
  )
}
```

`definition-source.ts` 负责统一解析来源：

```ts
export type DefinitionSource =
  | { type: 'inline'; definition: unknown }
  | { type: 'page'; pageId: string; version?: string }

export async function loadDefinition(
  source: DefinitionSource,
): Promise<unknown> {
  if (source.type === 'inline') return source.definition
  return pageDefinitionClient.getPublished(source.pageId, source.version)
}
```

Runtime 不负责请求配置中心；Render App 先取得 Definition，再把它交给 Runtime。

### 14.2 微前端适配

微前端入口只负责把宿主参数和能力转换给 `RenderApp`：

```tsx
function MicroApp(props: MicroAppProps) {
  const services = useMemo(() => ({
    apiExecutor: createHostApiExecutor(props.bridge),
    navigate: target => props.bridge.emit('NAVIGATE', target),
    toast: (message, options) =>
      props.bridge.emit('TOAST', { message, options }),
    reportError: error =>
      props.bridge.emit('RUNTIME_ERROR', error),
  }), [props.bridge])

  return (
    <RenderApp
      pageId={props.pageId}
      version={props.version}
      context={props.context}
      services={services}
      routerMode="memory"
      onReady={event => props.bridge.emit('RUNTIME_READY', event)}
      onError={error => props.bridge.emit('RUNTIME_ERROR', error)}
    />
  )
}
```

这样 iframe、qiankun、single-spa 或 Module Federation 只需更换 Host Bridge 或生命周期适配器，不需要修改 Render App 和 Runtime。

---

## 15. JSON Definition 校验

Runtime 至少需要两级校验。

### 15.1 加载前结构校验

检查：

- Definition 是否为对象
- `pages` 是否为空
- 页面是否包含 `a2ui`
- `logic.reactions` 是否为数组
- JSON 大小是否超限
- 页数是否超限

### 15.2 语义校验

检查：

- 组件类型是否存在于 Catalog
- `id` 是否重复
- `root` 是否存在或可自动补全
- children 引用是否存在
- children 是否形成循环
- Button 的 reactionId 是否存在
- Reaction id 是否重复
- Navigate 的 pageId 是否存在
- Action type 是否注册
- API Key 是否存在
- 数据绑定路径是否符合规范
- 脚本、表达式是否满足安全策略

建议校验结果：

```ts
export interface DefinitionValidationResult {
  valid: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  normalized?: NormalizedPages
}
```

编辑模式可以展示 Warning；生产模式遇到 Error 必须拒绝运行。

---

## 16. 错误处理

建议定义错误分类：

```ts
type RuntimeErrorCode =
  | 'DEFINITION_INVALID'
  | 'PROTOCOL_UNSUPPORTED'
  | 'CATALOG_COMPONENT_MISSING'
  | 'SURFACE_CREATE_FAILED'
  | 'PAGE_NOT_FOUND'
  | 'REACTION_FAILED'
  | 'API_FAILED'
  | 'NAVIGATION_FAILED'
  | 'SCRIPT_REJECTED'
  | 'RUNTIME_INTERNAL_ERROR'
```

错误对象：

```ts
export interface RuntimeError {
  code: RuntimeErrorCode
  message: string
  recoverable: boolean
  pageId?: string
  componentId?: string
  reactionId?: string
  cause?: unknown
  details?: Record<string, unknown>
}
```

需要区分：

- 组件局部错误：显示组件错误占位，不一定终止整页。
- 页面错误：当前页面不可运行，可导航到其他页面。
- Runtime 错误：Definition 或内核初始化失败，展示统一错误页。

---

## 17. 日志与可观测性

Runtime 日志不要直接散落使用 `console`。

```ts
export interface RuntimeLogger {
  debug(message: string, meta?: unknown): void
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, meta?: unknown): void
}
```

建议每次运行生成：

- `runtimeId`
- `definitionId`
- `definitionVersion`
- `pageId`
- `surfaceId`

生产监控至少记录：

- Runtime 初始化耗时
- Definition 获取及校验耗时
- 首页面可用耗时
- API 成功率和耗时
- Reaction 错误率
- 组件渲染异常
- 页面切换次数

---

## 18. 性能考虑

### 18.1 避免重复创建

- Catalog 在模块级或 Runtime 实例级创建一次。
- Services 使用稳定引用。
- Event handler 避免因 render 频繁重订阅。
- Definition 未变化时不重新 normalize。

### 18.2 多页面加载

建议继续采用懒加载：

- 首次只创建初始页面 Surface。
- 首次导航到页面时加载。
- 根据 `preservePageState` 决定是否缓存 Surface。

### 18.3 调试端实时更新

输入每个字符都 reload 会产生较大开销，建议：

- 300～500ms debounce。
- JSON 解析失败时保留上一次有效页面。
- 后续再实现组件级增量更新。

### 18.4 Bundle

生产 Runtime 不应打包：

- Debugger
- Agent Client
- Prompt Builder
- JSON 编辑/上传工具
- Mock API 数据
- 设计器组件元数据

图表组件较重，后续可以根据 Catalog 拆分或懒加载。

---

## 19. 安全边界

Runtime 抽离时应同时确定以下底线：

1. 生产 JSON 不允许任意网络 URL。
2. API 请求必须经过 API Registry 或宿主 Executor。
3. 权限不能仅由前端 JSON 控制。
4. `/$context` 默认为只读。
5. 动态脚本不能访问 `window`、`document`、Cookie 和 LocalStorage。
6. 表达式执行应设置能力白名单。
7. Definition 大小、组件数量、Reaction 数量必须有限制。
8. schedule interval 应设置最小值，避免高频轮询。
9. Runtime 销毁时必须取消请求及定时器。
10. 日志和事件不得泄露 Token、密码等敏感字段。

---

## 20. 测试方案

### 20.1 单元测试

重点测试：

- Definition 归一化
- Legacy/v0.8/v0.9 转换
- 页面导航状态
- Memory Router
- Host Router
- Runtime EventBus
- Service 默认值和覆盖
- Definition Validator
- Runtime Error 转换
- Engine destroy 清理

### 20.2 组件测试

使用 React Testing Library 验证：

- Runtime 能渲染单页 Definition
- Runtime 能渲染多页 Definition
- 数据绑定更新后组件重新渲染
- Button 能触发 Reaction
- API Executor 被正确调用
- Navigate 能切换页面
- Definition 更新能重新加载
- ErrorBoundary 能捕获渲染异常
- 卸载后没有残留订阅和定时器

### 20.3 集成测试

至少覆盖以下用例：

1. 订单表单：级联、回填、计算、校验、提交。
2. 订单列表：init 查询、搜索、表格展示。
3. Dashboard：多 API、Pipe、图表点击联动。
4. 多页面：navigate、参数传递、返回。
5. Dialog 子 Surface：打开、交互、关闭和销毁。
6. Definition 热更新：旧 Runtime 正确清理。

### 20.4 一致性测试

同一份 JSON 分别运行于：

- Agent 预览页中的 Runtime
- Debugger 页面中的 Runtime
- 实际渲染页中的 Runtime

验证：

- 组件树一致
- 初始 DataModel 一致
- Reaction 结果一致
- API 参数一致
- 页面导航结果一致

其中前两项属于同一个完整调试功能，第三项属于实际应用。三者运行结果一致，是 Runtime 抽离成功最关键的验收项。

---

## 21. 分阶段实施计划

### 阶段一：建立 Runtime 公共入口

目标：不改变现有能力，只完成职责搬迁。

任务：

1. 新建 `runtime-types.ts`。
2. 新建 `A2UIRuntime.tsx`。
3. 将 `PageRenderer` 从 `A2UIApp.tsx` 移入 Runtime。
4. 将 Runtime ErrorBoundary 移入 Runtime。
5. Runtime 内部组合 `A2UIProvider + PageProvider`。
6. Agent 预览页改为使用 `<A2UIRuntime definition={...} />`。
7. Debugger 页面改为使用 Runtime Handle 和 Runtime Event。
8. 保持现有 Mock API 行为。

验收：

- Demo 页面显示和交互与改造前一致。
- `A2UIApp.tsx` 不再创建 ReactionEngine。
- Agent 预览页和 Debugger 都不再直接操作 Surface。

预计工作量：2～4 个开发日。

### 阶段二：服务依赖注入

目标：Runtime 不依赖 Mock 和具体 UI。

任务：

1. 定义 Runtime Services。
2. API Executor 改为注入。
3. Toast 改为注入。
4. Logger 和 reportError 改为注入。
5. ReactionEngine 通过 Services 执行外部能力。
6. 提供完整调试端默认 Services。

验收：

- Runtime Core 不 import `src/mock`。
- 替换 API Executor 不需要改 Runtime 文件。
- Toast 可由宿主显示，也可由调试端自己显示。

预计工作量：2～3 个开发日。

### 阶段三：路由解耦

目标：支持独立应用和微前端。

任务：

1. 定义 RuntimeRouter。
2. 实现 Memory Router。
3. 把 Hash 逻辑迁移到 Hash Router。
4. 实现 Host Router。
5. PageProvider 改为依赖 Router。

验收：

- Memory 模式不修改浏览器 URL。
- Hash 模式保持当前行为。
- Host 模式能把导航事件交给宿主。

预计工作量：2～3 个开发日。

### 阶段四：控制接口和事件系统

目标：Debugger 和实际渲染/微前端入口通过稳定协议观察或控制 Runtime。

任务：

1. 实现 Runtime Handle。
2. 实现 Runtime EventBus。
3. 增加 ready、page、reaction、api、error 事件。
4. Debugger 改为读取 Runtime Snapshot 和事件。
5. 禁止 Debugger 直接访问 Engine。

验收：

- Debugger 可以刷新 Definition、查看数据和切换页面。
- 微前端可获得 Runtime Ready 和 Error 事件。

预计工作量：3～4 个开发日。

### 阶段五：校验、清理和测试

目标：达到生产封装前的稳定状态。

任务：

1. 增加 Definition Validator。
2. 增加安全限制。
3. 完善 Abort、Timer、Subscription 清理。
4. 增加 Runtime 单元及集成测试。
5. 增加一致性测试。
6. 从实际渲染页 Bundle 中排除完整调试端、Agent 和 Mock。

验收：

- 无效 JSON 在渲染前给出明确错误。
- Runtime 多次 reload 无 Surface 重名和订阅泄漏。
- Strict Mode 下运行正常。
- Agent 预览页、Debugger 页面和实际渲染页运行结果一致。

预计工作量：4～6 个开发日。

### 阶段六：实际渲染页和微前端入口

目标：在 Runtime 上增加薄封装，而非复制运行逻辑。

任务：

1. 新建不含任何调试功能的 Render App。
2. 支持通过 inline definition 或 pageId/version 加载发布 Definition。
3. 使用 Render App 完成独立实际渲染路由。
4. 实现 Host Bridge。
5. 接入鉴权、主题、导航和错误上报。
6. 根据实际条件选择 iframe、qiankun 或 Module Federation 包装。

预计工作量取决于宿主接入方式，通常为 3～8 个开发日。

---

## 22. 推荐提交拆分

为降低重构风险，建议按以下提交拆分：

1. `refactor(runtime): add public runtime types`
2. `refactor(runtime): extract runtime renderer from debug app`
3. `refactor(runtime): add A2UIRuntime public component`
4. `refactor(debug): reuse A2UIRuntime in agent preview and debugger`
5. `feat(render-app): add parameter-driven production renderer`
6. `refactor(runtime): inject api and toast services`
7. `refactor(runtime): introduce router adapters`
8. `feat(runtime): expose runtime handle and events`
9. `feat(runtime): validate page definitions before load`
10. `test(runtime): add lifecycle and consistency tests`

每个提交都应保持项目可运行，避免一次性移动所有文件。

---

## 23. 验收标准

Runtime 抽离完成需要同时满足：

### 架构标准

- Agent 预览页、Debugger 页面和实际渲染页使用同一个 `A2UIRuntime`。
- 上层代码不直接创建 ReactionEngine。
- 上层代码不直接操作 MessageProcessor 和 SurfaceModel。
- Runtime Core 不依赖 Agent、Debugger 和 Mock API。
- 路由、API、Toast、日志均可注入。

### 功能标准

- 当前 Demo JSON 全部可运行。
- 多页面导航正常。
- Dialog 子页面正常。
- Reaction、Pipe、API 和图表联动正常。
- Definition 更新后可可靠重载。
- Runtime 卸载后无残留定时器和订阅。

### 生产准备标准

- 支持 Memory Router。
- 支持宿主 Context。
- 支持统一错误回调。
- 支持 Runtime 生命周期事件。
- 支持 Definition 基础校验。
- Mock 代码不进入生产 Runtime 依赖链。

---

## 24. 主要风险及处理建议

### 风险一：重构时行为变化

处理：

- 先搬迁逻辑，不立即重写。
- 使用现有 Demo 作为回归样本。
- 在服务注入和路由解耦前建立基线测试。

### 风险二：React Effect 重复执行

处理：

- 所有初始化必须幂等。
- Engine、订阅、Timer 必须显式清理。
- 在 Strict Mode 中验证。

### 风险三：Definition 更新造成状态丢失

处理：

- 第一阶段明确使用全量 reload。
- 调试端保存上一次有效 Definition。
- 后续单独设计 preserve-data 和增量更新。

### 风险四：微前端过早影响 Runtime 设计

处理：

- Runtime 只定义通用 Services 和 Events。
- iframe、qiankun、Module Federation 差异放在 Host Bridge。
- Runtime 不依赖具体微前端框架。

### 风险五：组件 Catalog 继续膨胀

处理：

- 将默认组件和业务组件分组。
- Runtime 支持 Catalog 扩展。
- 设计器元数据与生产组件实现分离。

---

## 25. 最终建议

当前项目最合适的路线不是马上把 Runtime 发布成 npm 包，也不是马上引入微前端框架，而是：

1. 先在当前仓库内部建立稳定的 `A2UIRuntime` 公共入口。
2. 把现有 Agent 预览页和 Debugger 中的运行编排迁入 Runtime。
3. 通过 Services 和 Router Adapter 消除环境依赖。
4. 新增只从参数或配置接口取得 JSON 的 Render App。
5. 让 Agent 预览页、Debugger 页面和 Render App 全部复用 Runtime。
6. 完成生命周期、校验和一致性测试。
7. 最后用很薄的适配层把 Runtime 包装成微前端。

目标形态：

```text
完整调试功能
  ├─ AgentPreviewPage ─┐
  └─ DebuggerPage ─────┼─ A2UI Runtime Core
                       │
实际应用               │
  └─ RenderApp ────────┘
       ├─ 独立渲染路由
       ├─ Micro Frontend Adapter
       ├─ Module Federation Adapter
       └─ npm Adapter（可选）
```

其中真正需要长期稳定维护的是 `A2UI Runtime Core` 的公开接口，而不是某一种接入形式。

