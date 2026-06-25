# A2UI React 项目设计文档

## 1. 概述

A2UI React 是一个低代码 BI 看板生成器与调试器，支持自然语言输入页面需求，通过 LLM Agent 自动生成 A2UI JSON，并提供可视化编辑器进行实时预览和组件级编辑。

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Next.js 16 (App Router) + React 18 |
| 语言 | TypeScript 6 (strict) |
| 样式 | Tailwind CSS 3.4 + Radix UI (shadcn/ui) |
| 状态管理 | Zustand 5 (persist) |
| 图表 | Recharts 3 |
| 代码编辑器 | CodeMirror 6 |
| 渲染引擎 | @a2ui/react v0.10 + @a2ui/web_core v0.10 |
| 数据库 | Drizzle ORM + PostgreSQL |
| 构建工具 | Turbopack |

## 3. Monorepo 目录结构

项目直接采用“单仓库、两个独立 Next.js 应用、多个共享包”的最终结构，不再保留单个 Next.js 应用内通过路由区分 Debugger/Renderer 的过渡方案。

```text
a2ui-react/
  apps/                                      # 可独立构建、部署和回滚的 Next.js 应用
    debugger/                                # 调试端 Next.js App，仅面向内部用户
      app/
        layout.tsx
        page.tsx                             # DebugApp 入口
        globals.css
        api/
          generate/route.ts                  # Agent LLM 生成
          save-test-json/route.ts            # 调试 JSON 保存
          pages/                             # 页面全量管理 API
            route.ts                         # GET 列表 / POST 新建
            [id]/
              route.ts                       # GET / PUT / DELETE
              publish/route.ts               # POST 发布
              versions/
                route.ts                     # GET 历史版本
                [ver]/route.ts               # GET 指定版本
      src/
        debug-app/
          DebugApp.tsx                       # 调试端总入口
          DebugWorkspaceProvider.tsx         # Agent 预览与 Debugger 共享工作区状态
          AgentPreviewPage.tsx               # Agent 生成/上传 JSON + Runtime 预览
          DebuggerPage.tsx                   # 组件树、DataModel 和事件调试
          RuntimeDebugPanel.tsx
        agent/
          agent-client.ts
          prompt-builder.ts
        server/
          agent-executor.ts                  # server-only Agent 执行器
          auth-adapter.ts                    # 外部 Token 验证与 Claims 映射
        mock/
          api.ts                             # 仅调试端使用的 Mock Executor
      next.config.ts
      package.json
      tsconfig.json
      tailwind.config.ts

    renderer/                                # 实际渲染端 Next.js App，面向终端用户
      app/
        layout.tsx
        page.tsx                             # 可选首页或健康说明
        render/
          page.tsx                           # /render?pageId=...&version=...
        globals.css
        api/
          runtime/
            pages/
              [pageKey]/route.ts             # 仅 GET 已发布 Definition
      src/
        bootstrap.ts                         # Renderer 环境、Services 和鉴权上下文组装
        server/
          auth-adapter.ts                    # 外部 Token 验证与 Claims 映射
      next.config.ts
      package.json
      tsconfig.json
      tailwind.config.ts

  packages/                                  # 被两个 App 复用的工作区包
    a2ui-runtime/                            # 与产品入口无关的统一运行内核
      src/
        public/
          A2UIRuntime.tsx
          runtime-types.ts
          runtime-handle.ts
          index.ts
        core/
        routing/
        services/
        protocol/
        engines/
        state/
        catalog/
      package.json
      tsconfig.json

    a2ui-render-app/                         # 纯生产 RenderApp，共享给 Renderer 和 MicroApp
      src/
        RenderApp.tsx
        definition-source.ts
        render-app-types.ts
        RenderLoading.tsx
        RenderError.tsx
        index.ts
      package.json
      tsconfig.json

    a2ui-micro-app/                          # 微前端适配包
      src/
        MicroApp.tsx                         # 复用 @a2ui/render-app
        host-bridge.ts
        micro-app-types.ts
        adapters/
          iframe-bridge.ts
          qiankun-entry.tsx
          single-spa-entry.tsx
          federation-entry.tsx
      package.json
      tsconfig.json

    shared-types/                            # 前后端共享且无运行时副作用的类型
      src/
        page-definition.ts
        api-contracts.ts
        index.ts

    shared-ui/                               # Debugger/Renderer 可安全复用的基础 UI
      src/
        components/
        styles/
        index.ts

    db/                                      # server-only 数据库 Schema 和 Repository
      src/
        schema.ts
        page-repository.ts
        index.ts
      drizzle.config.ts
      package.json

  package.json                               # npm/pnpm workspaces 根配置
  tsconfig.base.json                         # 工作区 TypeScript 基础配置
  package-lock.json
```

依赖方向：

```text
apps/debugger ───────────────┐
                             ├─> @a2ui/runtime
apps/renderer ─> @a2ui/render-app ─> @a2ui/runtime
                             │
@a2ui/micro-app ─────────────┘
       └─> @a2ui/render-app

apps/debugger ─┐
apps/renderer ─┼─> @a2ui/shared-types / @a2ui/shared-ui
apps/* server ─┴─> @a2ui/db（仅服务端）
```

关键约束：

- `apps/debugger` 和 `apps/renderer` 都是完整且独立的 Next.js App，各自拥有 `app/`、`next.config.ts` 和 `package.json`。
- 两个 App 不得相互 import 私有源码。
- `@a2ui/micro-app` 不得依赖 `apps/renderer`，只能依赖共享的 `@a2ui/render-app`。
- `@a2ui/runtime` 不得依赖 Debugger、Agent、Mock、RenderApp 或具体微前端框架。
- `@a2ui/db` 标记为 server-only，禁止进入 Runtime 和客户端 Bundle。
- 两个 App 可以共享仓库、锁文件、CI 和公共包，但构建产物、环境变量、API、域名及发布周期相互独立。

## 4. 架构设计

### 4.1 应用与客户端/服务端边界

```text
┌─ apps/debugger（独立 Next.js App）────────────────────────┐
│ Server                                                    │
│  app/api/generate/route.ts                                │
│  app/api/pages/**                                         │
│  src/server/agent-executor.ts                             │
│                                                          │
│ Client                                                    │
│  DebugApp / AgentPreviewPage / DebuggerPage                │
│  @a2ui/runtime                                             │
└──────────────────────────────────────────────────────────┘

┌─ apps/renderer（独立 Next.js App）────────────────────────┐
│ Server                                                    │
│  app/api/runtime/pages/[pageKey]/route.ts                  │
│  只读取 PUBLISHED Definition                              │
│                                                          │
│ Client                                                    │
│  @a2ui/render-app                                          │
│  @a2ui/runtime                                             │
└──────────────────────────────────────────────────────────┘

┌─ packages（共享代码，不独立监听端口）─────────────────────┐
│ @a2ui/runtime / @a2ui/render-app / shared-types / shared-ui│
│ @a2ui/db（server-only）                                    │
└──────────────────────────────────────────────────────────┘
```

核心原则：

- 浏览器能力留在各 App 的 Client Component 或共享客户端包中。
- LLM API Key、数据库连接和权限校验只存在于对应 App 的 Route Handler/Server Module。
- Debugger 的管理 API 不会进入 Renderer 构建产物。
- Renderer 只提供 Definition 的只读接口；页面运行期间的业务请求仍通过注入的 RuntimeApiExecutor 调用业务网关。
- 共享包只承载真正需要复用的代码，不承载某个 App 的私有路由和环境配置。

### 4.2 数据流

```
用户需求
  → agent-client.fetch('/api/generate')
    → agent-executor 构建 Prompt → LLM API → JSON 解析 → 校验 → 落盘 test.json
      → 返回 { a2ui, logic }
        → a2ui.load() → MessageProcessor → SurfaceModel
          → createA2UIComponent (resolveProps + useSyncExternalStore)
            → A2uiSurface 渲染

Reaction 点击/change 事件
  → dispatchAction('a2ui.click')
    → ReactionEngine.triggerReaction()
      → Pipe 管道 → dataModel.set()
        → 组件 useSyncExternalStore 自动重渲染
```

### 4.3 环境变量

```env
# Debugger 服务端（不暴露到浏览器）
GEMINI_API_KEY=         # Gemini API Key
DEEPSEEK_API_KEY=       # DeepSeek API Key

# 外部身份系统（两个 App 按需配置）
AUTH_ISSUER=            # Token issuer
AUTH_AUDIENCE=          # Debugger/Renderer audience
AUTH_JWKS_URI=          # JWT 公钥地址或 introspection endpoint

# 数据库（计划中）
DATABASE_URL=           # PostgreSQL 连接串
```

## 5. API 路由与物理隔离

两个 Next.js App 各自编译自己的 `app/api` 路由，API 不通过运行时开关共享，也不会出现在对方构建产物中。

### 5.1 Debugger App API

部署域名示例：`https://debug.a2ui.example.com`

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/generate` | POST | Agent 生成 A2UI JSON |
| `/api/pages` | GET/POST | 页面列表与新建 |
| `/api/pages/[id]` | GET/PUT/DELETE | 页面读取、编辑和归档 |
| `/api/pages/[id]/publish` | POST | 校验并发布新版本 |
| `/api/pages/[id]/versions` | GET | 历史版本列表 |
| `/api/pages/[id]/versions/[ver]` | GET | 读取指定版本 |

这些接口面向内部用户，必须进行身份、租户和编辑/发布权限校验。

### 5.2 Renderer App API

部署域名示例：`https://render.a2ui.example.com`

| 路由 | 方法 | 用途 |
|---|---|---|
| `/api/runtime/pages/[pageKey]` | GET | 读取当前已发布 Definition |
| `/api/runtime/pages/[pageKey]?version=12` | GET | 读取允许访问的固定发布版本 |

生产响应建议包含：

```ts
interface PublishedDefinitionResponse {
  pageId: string
  pageKey: string
  version: number
  schemaVersion: string
  runtimeVersion: string
  catalogVersion: string
  checksum: string
  definition: unknown
}
```

Renderer 的“只读”仅指 Definition API。页面中的查询、提交等业务请求由 Runtime 注入的 `RuntimeApiExecutor` 调用 API Gateway 或宿主能力，不经过 Debugger 管理 API。

生产读取接口建议同时返回并使用：

- `ETag: "<checksum>"`，客户端可通过 `If-None-Match` 获取 304。
- 固定版本响应使用长期不可变缓存；“当前发布版本”使用较短缓存并支持主动失效。
- 响应中的 `version` 和 `checksum` 在一次 Runtime 会话内固定，避免页面运行中间切换版本。
- 发布操作必须先完成 Definition 校验、Runtime/Catalog 兼容性校验，再原子更新当前发布指针。

### 5.3 共享数据访问

两个 App 可以通过 server-only 的 `@a2ui/db` 共享数据库 Schema 和 Repository，但使用不同的 API 路由与权限策略：

- Debugger Repository 能读取草稿、写入页面、发布和回滚。
- Renderer Repository 只允许读取 PUBLISHED 快照。
- 数据库权限允许时，建议给 Renderer 使用只读数据库账号或只读视图。

## 6. 核心模块

### 6.1 组件系统

组件通过 `createA2UIComponent` 工厂注册到 Catalog：

| 类别 | 组件 |
|---|---|
| 布局 | Row, Card, Dashboard, Dialog |
| 输入 | TextField, Select, Button |
| 展示 | Text, DataTable, StatCard |
| 图表 | BarChart, LineChart, PieChart, AreaChart, ComposedChart, ScatterChart, RadarChart, RadialBarChart |

每个组件自动完成：`resolveProps` 解析 Databinding → `useSyncExternalStore` 订阅 → `data-a2ui-id` 注入。

### 6.2 Agent 链路

- `prompt-builder.ts`：从 Catalog 序列化组件清单/Action 表/API 表/DSL 规范，组装 System Prompt
- `agent-executor.ts`：服务端执行器，调用 Gemini/DeepSeek，解析 JSON，校验结构，保存 test.json
- `agent-client.ts`：客户端薄层，mock 模式返回本地 demo，非 mock 调 `/api/generate`

### 6.3 Reaction 引擎

- **ReactionEngine**：监听 `when.event`（init/change/click/schedule），按序执行 `then` Action 链
- **PipeEngine**：支持 get/filter/map/compute/yoy/mom 管道操作符
- **脚本支持**：自定义 Reaction 可通过 `safeEvalScript` 执行沙箱 JavaScript

## 7. 数据库设计

### 7.1 数据表

本项目不维护登录、用户、角色、团队或租户成员关系。`tenantId`、`userId` 和权限列表均来自外部身份系统验证后的 Token。

页面表仅保存资源、租户归属和审计信息，不保存 `editors[]`、`viewers[]`、页面 ACL 或本地角色字段。

```ts
// packages/db/src/schema.ts
import {
  pgTable, varchar, integer, jsonb, timestamp,
  pgEnum, index, uniqueIndex,
} from 'drizzle-orm/pg-core'

export const pageStatusEnum = pgEnum(
  'page_status',
  ['DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED'],
)

export const a2uiPages = pgTable('a2ui_pages', {
  id: varchar('id', { length: 36 }).primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar('tenant_id', { length: 64 }).notNull(),
  pageKey: varchar('page_key', { length: 128 }).notNull(),
  name: varchar('name', { length: 200 }).notNull(),
  status: pageStatusEnum('status').default('DRAFT').notNull(),
  version: integer('version').default(1).notNull(),
  content: jsonb('content').notNull(),
  createdBy: varchar('created_by', { length: 64 }).notNull(),
  updatedBy: varchar('updated_by', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow()
    .$onUpdate(() => new Date()).notNull(),
}, (t) => [
  uniqueIndex('uq_tenant_page_key').on(t.tenantId, t.pageKey),
  index('idx_tenant_page_status').on(t.tenantId, t.status),
])

export const a2uiPageVersions = pgTable('a2ui_page_versions', {
  id: varchar('id', { length: 36 }).primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar('tenant_id', { length: 64 }).notNull(),
  pageId: varchar('page_id', { length: 36 }).notNull()
    .references(() => a2uiPages.id),
  version: integer('version').notNull(),
  content: jsonb('content').notNull(),
  checksum: varchar('checksum', { length: 128 }).notNull(),
  changelog: varchar('changelog', { length: 500 }),
  createdBy: varchar('created_by', { length: 64 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  uniqueIndex('uq_tenant_page_version')
    .on(t.tenantId, t.pageId, t.version),
])

export const a2uiAuditLogs = pgTable('a2ui_audit_logs', {
  id: varchar('id', { length: 36 }).primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  tenantId: varchar('tenant_id', { length: 64 }).notNull(),
  userId: varchar('user_id', { length: 64 }).notNull(),
  action: varchar('action', { length: 64 }).notNull(),
  resourceType: varchar('resource_type', { length: 64 }).notNull(),
  resourceId: varchar('resource_id', { length: 64 }).notNull(),
  metadata: jsonb('metadata'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (t) => [
  index('idx_audit_tenant_resource')
    .on(t.tenantId, t.resourceType, t.resourceId),
])
```

设计说明：

- `createdBy`、`updatedBy` 和审计日志中的 `userId` 均保存外部身份系统的稳定用户 ID，仅用于审计。
- 本项目不建立 users、roles、teams、tenant_members 或 page_acl 表。
- 所有资源表必须包含 `tenantId`，所有 Repository 方法必须显式接收 `tenantId`。
- `pageKey` 在租户内唯一，即唯一键为 `(tenantId, pageKey)`。
- 如数据库支持行级安全策略，可进一步按 `tenantId` 配置 PostgreSQL RLS。

### 7.2 Repository 与 API 映射

数据库操作由 server-only 的 `@a2ui/db` Repository 封装，再由两个 App 的 Route Handler 以不同权限调用：

| Repository 能力 | Debugger API | Renderer API |
|---|---|---|
| 列表、新建、编辑、归档 | `/api/pages`、`/api/pages/[id]` | 不暴露 |
| 发布、版本历史、回滚 | `/api/pages/[id]/publish`、`versions/**` | 不暴露 |
| 按 pageKey 读取已发布快照 | 可用于发布后校验 | `/api/runtime/pages/[pageKey]` |

API 路径以第 5 节为唯一标准，Repository 不包含 HTTP 路由和用户会话逻辑。

---

## 8. JSON 状态管理与发布

### 8.1 生命周期

```
DRAFT → REVIEW → PUBLISHED → ARCHIVED
  ↑                    |
  └── 放弃审核 ────────┘
```

- **DRAFT**：编辑中，可自由修改，不对外可见
- **REVIEW**：提交审核，锁定编辑（可选，视团队规模引入）
- **PUBLISHED**：只读保护，修改需新建版本或先回退到 DRAFT
- **ARCHIVED**：下架归档，仍可查询历史数据

### 8.2 版本控制

每次发布（POST `/publish`）时：
1. `A2UIPageVersion` 插入一条历史记录（快照当前 content）
2. `A2UIPage.version` 自增
3. `A2UIPage.status` 改为 PUBLISHED

后续修改需先回退到 DRAFT，修改完再次发布即生成新版本。支持：
- 历史版本列表查看
- 指定版本回滚（将历史 content 覆盖回主表的 content 并生成新版本）
- 两版本对比（JSON diff）

### 8.3 外部身份与权限控制

当前阶段完全依赖外部身份系统，本项目不提供登录、用户管理、角色管理、租户成员管理或页面级 ACL。

#### 外部认证上下文

Debugger 和 Renderer 的服务端收到请求后，通过 Auth Adapter 验证外部 Token，并转换成统一上下文：

```ts
export interface ExternalAuthContext {
  userId: string
  tenantId: string
  permissions: string[]
  roles?: string[]        // 仅透传给 Runtime Context，本项目不维护角色关系
  displayName?: string
  tokenId?: string
  expiresAt?: number
}

export interface ExternalAuthAdapter {
  authenticate(request: Request): Promise<ExternalAuthContext>
}
```

Auth Adapter 负责：

- 从 Authorization Header、HttpOnly Cookie 或可信宿主 Bridge 获取 Token。
- 验证签名、issuer、audience、有效期和撤销状态。
- 把外部 Claims 映射成统一的 `userId`、`tenantId` 和 `permissions`。
- 验证失败返回 401；Token 有效但权限不足返回 403。

禁止直接解析未经验证的 JWT，也不能信任客户端单独传入的 `tenantId` 或权限数组。

#### 外部权限码

建议约定以下权限码；实际字符串可通过 Auth Adapter 映射外部系统权限：

| 权限码 | 对应操作 |
|---|---|
| `a2ui.page.create` | 新建页面 |
| `a2ui.page.read` | 查看租户内页面、草稿和版本 |
| `a2ui.page.edit` | 修改页面草稿 |
| `a2ui.page.delete` | 归档或删除页面 |
| `a2ui.page.publish` | 提交审核、发布和回滚版本 |
| `a2ui.runtime.read` | Renderer 读取已发布 Definition |

统一权限校验：

```ts
function requirePermission(
  auth: ExternalAuthContext,
  permission: string,
): void {
  if (!auth.permissions.includes(permission)) {
    throw new ForbiddenError(permission)
  }
}

export async function PUT(request: Request, context: RouteContext) {
  const auth = await authAdapter.authenticate(request)
  requirePermission(auth, 'a2ui.page.edit')

  return pageService.update({
    tenantId: auth.tenantId,
    userId: auth.userId,
    pageId: context.params.id,
    input: await request.json(),
  })
}
```

#### 权限判断规则

当前阶段只进行两项判断：

1. 用户是否拥有执行该 API 操作所需的外部权限码。
2. 被访问资源的 `tenantId` 是否等于 Token 中经过验证的 `tenantId`。

同一租户内，只要用户拥有对应外部权限码，就能对该租户内所有页面执行相应操作；暂不支持“只允许编辑某几个页面”的细粒度授权。

如果未来明确出现页面级授权需求，再单独引入页面 ACL，而不是提前保留空 ACL 结构。

### 8.4 多租户隔离

租户字段统一使用 `tenantId`，其唯一可信来源是经过 Auth Adapter 验证的外部 Token：

```ts
const auth = await authAdapter.authenticate(request)

const pages = await pageRepository.list({
  tenantId: auth.tenantId,
  status: 'PUBLISHED',
})
```

租户隔离规则：

- 所有 Repository 的读取、写入、版本和审计方法都必须接收 `tenantId`。
- 所有 SQL 查询必须同时使用 `tenantId` 和资源标识，禁止只按 `pageId` 查询。
- URL、Query、Request Body 和 Runtime Definition 中的 tenantId 都不能作为鉴权依据。
- 即使客户端传入 tenantId，也必须忽略或与 Token tenantId 比对后拒绝不一致请求。
- `pageKey` 在租户内唯一，数据库唯一键为 `(tenantId, pageKey)`。
- Renderer 缓存键必须包含 tenantId、pageKey 和 version。
- 页面、版本、审计日志、后台任务和消息队列 payload 都必须携带 tenantId。
- 对外错误不应区分“其他租户存在该资源”和“资源不存在”，统一返回 404，避免资源枚举。

#### Debugger 与 Renderer 的 Token 使用

- Debugger App 使用外部 Token 校验管理权限，例如 create/edit/publish。
- Renderer App 使用外部 Token 校验 `a2ui.runtime.read`，并只读取当前 tenantId 下的 PUBLISHED Definition。
- 微前端优先由宿主提供 request Bridge；避免把长期 Token 写入 URL、localStorage、Definition、DataModel、Runtime Event 或日志。
- 如果使用浏览器直连，优先采用同域 HttpOnly Cookie，或使用短期、限定 audience 的访问 Token。

---

## 9. 模块拆分

### 9.1 现状问题

当前 `src/runtime/`、`src/views/`、`src/agent/` 等目录耦合了调试器和渲染器两套逻辑。需要将**纯渲染能力**抽离为独立包，使其可脱离调试器单独使用。

### 9.2 核心原则

调试功能中运行的页面和实际应用中渲染的页面必须使用**同一条渲染及交互链路**。当前 `A2UIApp.tsx` 混合了以下职责：

- Agent 配置及页面生成
- JSON 文件上传和示例选择
- `PageRenderer`（ReactionEngine 创建/销毁、Surface action 监听、A2uiSurface 渲染）
- Toast 展示

因此存在以下风险：新增实际渲染页时容易复制 Agent 预览页的运行代码形成第二套逻辑；调试和生产可能采用不同 Engine 初始化方式；API、导航、Toast 等能力与具体实现耦合。

### 9.3 分层架构

```
┌─ 产品入口层 ───────────────────────────────────────────┐
│  DebugApp（调试器 + Agent 预览）    RenderApp（纯渲染）  │
│  MicroApp（微前端适配层，包装 RenderApp）                │
└───────────────┬─────────────────────────────────────────┘
                │ definition / services / context
                ▼
┌─ A2UIRuntime 公共入口 ──────────────────────────────────┐
│  RuntimeBoundary / Provider / Controller / Renderer     │
│  RuntimeRouter / RuntimeEventBus                        │
└───────────────┬─────────────────────────────────────────┘
                │
    ┌───────────┼───────────┬─────────────────┐
    ▼           ▼           ▼                 ▼
A2UIProvider  PageProvider  ReactionEngine  SharedStore
    │           │           │
    ▼           ▼           ▼
MessageProcessor  Surface  Pipe/Action
    │
    ▼
A2uiSurface + Catalog
```

四个层次：

- **协议层**：JSON 格式归一化、版本兼容、结构校验
- **运行内核层**：Surface/DataModel、Reaction/Pipe 引擎、页面生命周期
- **能力适配层**：API/导航/Toast/日志等外部能力的抽象接口及默认实现
- **产品入口层**：完整调试端、纯实际渲染页、微前端宿主桥接

产品入口层不能直接创建 `ReactionEngine` 或操作 `MessageProcessor`。

### 9.4 模块在 Monorepo 中的归属

第 3 节已经给出最终目录结构。本节只强调模块归属：

| 模块 | 所属位置 | 是否进入 Debugger | 是否进入 Renderer |
|---|---|---:|---:|
| DebugApp、Agent、Debugger、Mock | `apps/debugger/src` | 是 | 否 |
| Debugger 管理 API | `apps/debugger/app/api` | 是 | 否 |
| Renderer 启动壳和只读 API | `apps/renderer` | 否 | 是 |
| A2UIRuntime | `packages/a2ui-runtime` | 是 | 是 |
| RenderApp | `packages/a2ui-render-app` | 可用于调试测试 | 是 |
| MicroApp adapters | `packages/a2ui-micro-app` | 否 | 按接入产物使用 |
| 基础 UI/共享类型 | `packages/shared-ui`、`packages/shared-types` | 是 | 是 |
| 数据库访问 | `packages/db`（server-only） | 服务端 | 服务端只读 |

应用层只能依赖共享包；共享包不能反向依赖 `apps/*`。

### 9.5 依赖规则

依赖只能自上而下。Runtime 内部不能反向引用 `debug-app`、`render-app` 或 `micro-app`。

| 目录 | 主要职责 | 不应依赖 |
|---|---|---|
| `runtime/public` | 对外提供稳定组件、类型和控制接口 | Debug App、Render App 的具体实现 |
| `runtime/core` | 编排 Definition、Surface、Engine、页面和生命周期 | Agent、Mock API、调试面板 |
| `runtime/routing` | 统一页面位置和导航行为 | React UI、ReactionEngine 内部实现 |
| `runtime/services` | 抽象请求、Toast、日志、埋点等环境能力 | 具体生产系统 SDK |
| `runtime/protocol` | Definition 格式兼容、版本和校验 | React UI、浏览器路由、宿主状态 |
| `runtime/engines` | 执行 Reaction、Action、Pipe 和受控脚本 | Debug App、Render App |
| `runtime/state` | 管理运行状态和 Provider | Agent 和设计器工具状态 |
| `runtime/catalog` | 注册并实现 Runtime 组件 | Debugger 属性面板和 Agent Prompt |
| `debug-app` | 组合 Agent 预览页和 Debugger | Runtime 内部 Controller、Surface、Engine 实例 |
| `render-app` | 仅根据传参取得 JSON 并实际渲染 | Agent、Debugger、Mock 数据和 Runtime 私有实现 |
| `micro-app` | 将 Render App 适配到生产宿主 | Runtime 私有实现、调试功能和 Mock 数据 |

### 9.6 A2UIRuntime 公共接口

```ts
export interface A2UIRuntimeProps {
  definition: unknown
  services: A2UIRuntimeServices
  context?: A2UIRuntimeContext
  options?: A2UIRuntimeOptions
  onReady?: (event: RuntimeReadyEvent) => void
  onEvent?: (event: RuntimeEvent) => void
  onError?: (error: RuntimeError) => void
  fallback?: React.ReactNode
  errorFallback?: React.ReactNode | ((error: RuntimeError) => React.ReactNode)
}

export interface A2UIRuntimeOptions {
  mode?: 'debug' | 'production'
  routerMode?: 'memory' | 'hash' | 'host'
  initialPageId?: string
  preservePageState?: boolean
  limits?: {
    maxDefinitionBytes?: number
    maxPages?: number
    maxComponentsPerPage?: number
    maxReactionsPerPage?: number
  }
}

export interface A2UIRuntimeContext {
  user?: { id: string; name?: string; roles?: string[] }
  tenant?: { id: string; name?: string }
  permissions?: string[]
  locale?: string
  timezone?: string
  theme?: Record<string, string>
  params?: Record<string, unknown>
  // 注入 /$context 命名空间，Reaction 只读
}

export interface A2UIRuntimeServices {
  apiExecutor: RuntimeApiExecutor
  toast: (message: string, options?: RuntimeToastOptions) => void
  navigateExternal: (target: ExternalNavigationTarget) => void | Promise<void>
  openExternal?: (url: string) => void
  logger: RuntimeLogger
  reportError: (error: RuntimeError) => void
  track: (event: RuntimeTrackEvent) => void
}
```

#### 内部页面导航与宿主导航分离

`RuntimeRouter` 只管理一份 Definition 内的页面切换；Runtime Services 只处理跳出 Runtime 的宿主/外部导航：

```ts
export interface RuntimeRouter {
  navigatePage(pageId: string, params?: Record<string, unknown>): void
  back(): void
  getLocation(): RuntimeLocation
  subscribe(listener: (location: RuntimeLocation) => void): () => void
}

export interface ExternalNavigationTarget {
  path: string
  params?: Record<string, unknown>
  replace?: boolean
}
```

规则：

- Reaction 的 `navigate.pageId` 调用 `RuntimeRouter.navigatePage`。
- 跳转宿主业务路由调用 `services.navigateExternal`，并发出 `host:navigate` 事件。
- 打开外部 URL 必须调用 `openExternal`，只允许配置的 `https:` 等协议和域名白名单。
- Runtime Router 不得直接调用宿主 React Router/Vue Router；由 Host Router Adapter 完成转换。

#### Runtime Handle

```ts
export interface A2UIRuntimeHandle {
  reload(definition: unknown): Promise<void>
  navigatePage(pageId: string, params?: Record<string, unknown>): void
  goBack(): void
  getCurrentPageId(): string | null
  getDataModel(pageId?: string): Record<string, unknown>
  setDataValue(path: string, value: unknown, pageId?: string): void
  triggerReaction(reactionId: string, pageId?: string): Promise<void>
  getSnapshot(): RuntimeSnapshot
  destroy(): void
}
```

禁止通过 Handle 暴露原始 `MessageProcessor`、`SurfaceModel`、`ReactionEngine` 实例。

### 9.7 运行时事件

```ts
type RuntimeEvent =
  | { type: 'runtime:ready' }
  | { type: 'runtime:error'; payload: RuntimeError }
  | { type: 'page:loading' | 'page:ready' | 'page:changed' | 'page:unloaded' }
  | { type: 'reaction:start' | 'reaction:end' | 'reaction:error' }
  | { type: 'api:start' | 'api:end' | 'api:error' }
  | { type: 'host:navigate'; payload: RuntimeNavigationTarget }
  | { type: 'data:changed'; payload: DataChangedEvent }
```

### 9.8 错误处理

```ts
type RuntimeErrorCode =
  | 'DEFINITION_INVALID' | 'PROTOCOL_UNSUPPORTED'
  | 'CATALOG_COMPONENT_MISSING' | 'SURFACE_CREATE_FAILED'
  | 'PAGE_NOT_FOUND' | 'REACTION_FAILED' | 'API_FAILED'
  | 'NAVIGATION_FAILED' | 'SCRIPT_REJECTED'
  | 'RUNTIME_INTERNAL_ERROR'

interface RuntimeError {
  code: RuntimeErrorCode
  message: string
  recoverable: boolean       // 可恢复：组件局部错误；不可恢复：Definition 解析失败
  pageId?: string
  componentId?: string
  reactionId?: string
}
```

### 9.9 安全边界

1. 生产 JSON 不允许任意网络 URL
2. API 请求必须经过 API Registry 或宿主 Executor
3. `/$context` 默认为只读
4. 动态脚本不能访问 `window`、`document`、Cookie、localStorage
5. Definition 大小、组件数量、Reaction 数量必须有限制
6. schedule interval 应设置最小值，避免高频轮询
7. Runtime 销毁时必须取消所有请求和定时器
8. 日志和事件不得泄露 Token 等敏感字段

---

## 10. 调试/渲染入口拆分

### 10.1 三个入口

| 入口 | 目录 | 用途 | 当前状态 |
|---|---|---|---|
| DebugApp | `apps/debugger/src/debug-app/` | Agent 预览 + 完整调试器 | 现有功能迁移目标 |
| RenderApp | `packages/a2ui-render-app/` | 纯渲染：inline/发布接口获取 JSON → A2UIRuntime | 待实现 |
| MicroApp | `packages/a2ui-micro-app/` | 将 RenderApp 包装为微前端子应用 | 待实现 |

### 10.2 入口关系

```
MicroApp（生产宿主适配层）
  → RenderApp（加载 Definition + 组装 A2UIRuntime）
    → A2UIRuntime（统一运行内核）

DebugApp（调试端）
  ├─ AgentPreviewPage → A2UIRuntime
  └─ DebuggerPage → A2UIRuntime + RuntimeHandle
```

三者都使用同一个 `A2UIRuntime`，保证行为一致。

### 10.3 DebugApp

AgentPreviewPage 和 DebuggerPage 属于同一个调试工作区，不能分别维护 Definition。由 `DebugWorkspaceProvider` 统一保存当前草稿、最后有效 Definition、选中节点和未保存状态：

```ts
interface DebugWorkspaceState {
  definition: unknown
  lastValidDefinition: unknown
  selectedPageId?: string
  selectedComponentId?: string
  dirty: boolean
  savedVersion?: number
}

interface DebugWorkspaceActions {
  replaceDefinition(definition: unknown): void
  updateDefinition(updater: (current: unknown) => unknown): void
  selectPage(pageId?: string): void
  selectComponent(componentId?: string): void
  markSaved(version: number): void
}
```

数据流：

```text
Agent 生成 / JSON 上传 / 组件属性编辑
                 ↓
        DebugWorkspaceProvider
          ┌──────┴────────┐
          ↓               ↓
 AgentPreviewPage     DebuggerPage
          ↓               ↓
        同一个 Definition → A2UIRuntime
```

```tsx
function DebugApp() {
  return (
    <DebugWorkspaceProvider>
      <DebugModeTabs
        preview={<AgentPreviewPage />}
        debugger={<DebuggerPage />}
      />
    </DebugWorkspaceProvider>
  )
}

function AgentPreviewPage() {
  const { definition, replaceDefinition } = useDebugWorkspace()
  return (
    <>
      <AgentPanel onGenerated={replaceDefinition} />
      <A2UIRuntime definition={definition} services={debugServices}
        options={{ mode: 'debug', routerMode: 'memory' }} />
    </>
  )
}

function DebuggerPage() {
  const runtimeRef = useRef<A2UIRuntimeHandle>(null)
  const { definition, selectedComponentId } = useDebugWorkspace()
  return (
    <>
      <RuntimeDebugPanel runtimeRef={runtimeRef}
        selectedComponentId={selectedComponentId} />
      <A2UIRuntime ref={runtimeRef} definition={definition}
        services={debugServices} options={{ mode: 'debug' }}
        onEvent={appendDebugEvent} />
    </>
  )
}
```

约束：调试端不得直接创建 ReactionEngine、调用 `processor.processMessages` 或修改 SurfaceModel；JSON 解析失败时保留 `lastValidDefinition` 继续运行，并在工具栏展示错误。

### 10.4 RenderApp

RenderApp 使用判别联合类型描述 Definition 来源，避免 `definition`、`pageId` 和 URL 参数同时存在时产生隐式优先级：

```ts
export type RenderDefinitionSource =
  | {
      type: 'inline'
      definition: unknown
    }
  | {
      type: 'published-page'
      pageKey: string
      version?: number
    }

export interface RenderAppProps {
  source: RenderDefinitionSource
  context?: A2UIRuntimeContext
  services: A2UIRuntimeServices
  routerMode?: 'memory' | 'hash' | 'host'
  onReady?: (event: RuntimeReadyEvent) => void
  onError?: (error: RuntimeError) => void
}
```

完整 JSON 不允许放入 URL Query。独立 Renderer 页面只从 URL 解析 `pageKey/version`，然后构造 `published-page` Source；微前端初始化参数可以使用 inline Definition。

```tsx
function RenderApp(props: RenderAppProps) {
  const result = useDefinitionSource(props.source)

  if (result.loading) return <RenderLoading />
  if (result.error) return <RenderError error={result.error} />

  return (
    <A2UIRuntime
      definition={result.definition}
      context={props.context}
      services={props.services}
      options={{
        mode: 'production',
        routerMode: props.routerMode ?? 'memory',
      }}
      onReady={props.onReady}
      onError={props.onError}
    />
  )
}
```

#### Definition Source 的 IO 责任

`packages/a2ui-render-app/definition-source.ts` 负责外部 IO；Runtime 内的 Definition Processor 只负责纯校验和归一化：

```text
DefinitionSource
  → definition-source.ts：请求/缓存/取消请求
  → PublishedDefinitionResponse.definition
  → RuntimeDefinitionProcessor：大小限制/版本检查/校验/normalizeToPages
  → A2UIRuntime
```

`definition-source.ts` 必须实现：

- 使用 `AbortController`，Source 变化或组件卸载时取消旧请求。
- 使用 requestId 或 signal 防止旧响应覆盖新页面。
- 缓存键至少包含 tenant、pageKey、version 和 locale。
- 固定版本在当前会话中不得静默漂移到新版本。
- 校验响应的 checksum、schemaVersion、runtimeVersion 和 catalogVersion。
- 明确区分 401/403、404、协议不兼容、网络失败和 Definition 校验失败。
- 重试只用于幂等 GET，并设置次数上限和退避策略。

### 10.5 MicroApp

微前端入口只负责把宿主参数和能力转换给 RenderApp，不加载自己的 JSON、不创建 Engine，也不直接依赖 Next.js Route Handler：

```tsx
function MicroApp({ source, context, bridge }: MicroAppProps) {
  const services = useMemo<A2UIRuntimeServices>(() => ({
    apiExecutor: req => bridge.request(req),
    navigateExternal: target => bridge.emit('NAVIGATE', target),
    openExternal: url => bridge.emit('OPEN_EXTERNAL', { url }),
    toast: (message, options) =>
      bridge.emit('TOAST', { message, options }),
    reportError: error => bridge.emit('RUNTIME_ERROR', error),
    logger: bridge.logger,
    track: event => bridge.emit('TRACK', event),
  }), [bridge])

  return (
    <RenderApp
      source={source}
      context={context}
      services={services}
      routerMode="memory"
      onReady={event => bridge.emit('RUNTIME_READY', event)}
      onError={error => bridge.emit('RUNTIME_ERROR', error)}
    />
  )
}
```

不同接入方式需要不同构建产物，不应假设增加 Adapter 文件后即可使用：

| 接入方式 | 构建产物 | 生命周期/通信 |
|---|---|---|
| iframe | 完整 Renderer Web App | URL 参数 + 受控 postMessage |
| qiankun | 客户端 Bundle | `bootstrap/mount/unmount` |
| single-spa | SystemJS/ESM 客户端 Bundle | single-spa 生命周期 |
| Module Federation | Remote Entry + exposed module | 暴露 `MicroApp` 或 `RenderApp` |
| React npm 包 | ESM/CJS + 类型声明 | Props、Callbacks、Runtime Services |

因此 `@a2ui/render-app` 和 `@a2ui/micro-app` 必须保持为纯客户端共享包，不依赖 Next.js Server Component、`next/navigation` 或某个 App 的 Route Handler。

#### iframe/postMessage 安全要求

- 固定允许的 `targetOrigin`，禁止生产代码使用 `'*'`。
- 接收消息时校验 `event.origin`、`event.source`、协议名和协议版本。
- 使用 Schema 校验消息的 type 与 payload。
- 消息不得携带长期 Token、Cookie 或完整用户敏感数据。
- iframe 应设置按需的 `sandbox` 和 Permissions Policy。
- 对 NAVIGATE、OPEN_EXTERNAL 等能力设置路径/域名白名单。

### 10.6 独立构建与部署

Debugger 和 Renderer 是 Monorepo 中两个独立的 Next.js App，而不是同一个 Next.js App 中的两个路由。每个 App 执行自己的 `next build`，生成独立的 `.next` 或 standalone 产物。

根 `package.json` 示例：

```json
{
  "private": true,
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "dev:debugger": "npm --workspace @a2ui/debugger run dev",
    "dev:renderer": "npm --workspace @a2ui/renderer run dev",
    "build:debugger": "npm --workspace @a2ui/debugger run build",
    "build:renderer": "npm --workspace @a2ui/renderer run build",
    "build": "npm run build:debugger && npm run build:renderer",
    "typecheck": "npm run typecheck --workspaces --if-present",
    "test": "npm run test --workspaces --if-present"
  }
}
```

各 App 的包名示例：

```json
// apps/debugger/package.json
{
  "name": "@a2ui/debugger",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3000",
    "build": "next build",
    "start": "next start -p 3000"
  },
  "dependencies": {
    "@a2ui/runtime": "*"
  }
}

// apps/renderer/package.json
{
  "name": "@a2ui/renderer",
  "private": true,
  "scripts": {
    "dev": "next dev -p 3001",
    "build": "next build",
    "start": "next start -p 3001"
  },
  "dependencies": {
    "@a2ui/runtime": "*",
    "@a2ui/render-app": "*"
  }
}
```

两个 `next.config.ts` 均建议启用 standalone，并显式转译工作区包：

```ts
import type { NextConfig } from 'next'

const config: NextConfig = {
  output: 'standalone',
  transpilePackages: [
    '@a2ui/runtime',
    '@a2ui/render-app',
    '@a2ui/shared-ui',
  ],
}

export default config
```

构建与发布：

```text
npm run build:debugger
  → apps/debugger/.next/standalone
  → debugger 镜像
  → debug.a2ui.example.com

npm run build:renderer
  → apps/renderer/.next/standalone
  → renderer 镜像
  → render.a2ui.example.com
```

| | Debugger App | Renderer App |
|---|---|---|
| 构建入口 | `apps/debugger` | `apps/renderer` |
| 页面入口 | `app/page.tsx` | `app/render/page.tsx` |
| 包含模块 | DebugApp、Agent、Debugger、Runtime | RenderApp、Runtime |
| 明确排除 | — | Agent、Prompt Builder、CodeMirror、Debugger、Mock API |
| API | 管理 CRUD、生成、发布、版本 | 仅发布 Definition 读取 |
| 环境变量 | LLM Key、管理鉴权、数据库写权限 | Runtime 配置、数据库只读权限或 Definition API |
| 发布对象 | 内部调试平台 | 终端渲染服务 |
| 发布节奏 | 可独立升级/回滚 | 可独立升级/回滚 |

部署架构：

```text
内部用户
  → debug.a2ui.example.com
    → Debugger Next.js App
      → Agent + Debugger + 管理 API
      → @a2ui/runtime

终端用户
  → render.a2ui.example.com/render?pageId=...
    → Renderer Next.js App
      → @a2ui/render-app
      → @a2ui/runtime
      → 只读 Published Definition API

外部宿主
  → @a2ui/micro-app 或 iframe
    → @a2ui/render-app
    → @a2ui/runtime
```

### 10.7 CI/CD 建议

可以在同一流水线中根据变更路径决定构建目标：

- 修改 `apps/debugger/**`：只构建和发布 Debugger。
- 修改 `apps/renderer/**`：只构建和发布 Renderer。
- 修改 `packages/a2ui-runtime/**`：同时构建并回归两个 App。
- 修改 `packages/a2ui-render-app/**`：构建 Renderer 和 MicroApp 产物。
- 修改数据库协议或共享类型：同时运行两个 App 的类型检查和契约测试。

不要预估固定的 Bundle 缩减百分比。应使用 Bundle Analyzer 验证 Renderer 构建中不存在 Agent、CodeMirror、Debugger 和 Mock 模块，并设置可量化的首包预算。


### 10.8 从当前项目直接迁移到 Monorepo

本项目选择直接进入最终 Monorepo 结构，但迁移仍应按可运行提交拆分，避免同时重写 Runtime 和目录：

1. 在根目录启用 workspaces，创建 `apps/debugger`、`apps/renderer` 和 `packages/*` 空骨架。
2. 先把现有项目整体迁入 `apps/debugger`，确保 Debugger App 可以独立开发和构建。
3. 在 `packages/a2ui-runtime` 中建立公共入口，逐步迁移现有 `src/runtime`；每迁移一个模块即从 Debugger App 改为包导入。
4. 建立 `packages/a2ui-render-app`，实现严格的 Definition Source 协议和纯生产 RenderApp。
5. 建立 `apps/renderer`，只组合 RenderApp、生产 Services 和只读 Definition API。
6. 建立 `packages/a2ui-micro-app`，复用 RenderApp，不复制 Definition 加载或 Runtime 编排。
7. 分别执行 Debugger/Renderer 的构建、契约测试和 Bundle 检查。
8. 最后拆分 CI/CD、环境变量、数据库权限、域名和部署镜像。

迁移过程中的硬性验收点：

- 任意提交都至少保证 Debugger App 可构建，进入第 5 步后两个 App 都必须可构建。
- Renderer 源码和构建依赖图中不得出现 Agent、Debugger、CodeMirror 或 Mock API。
- 两个 App 不得通过相对路径跨目录读取对方源码。
- Runtime 变更必须同时运行 Debugger 和 Renderer 的一致性测试。
- 同一份 Definition 在 AgentPreviewPage、DebuggerPage 和 RenderApp 中产生相同组件树、初始 DataModel 和 Reaction 结果。


### 10.9 拆分验收测试

#### 一致性测试

同一份 Definition 分别运行于 AgentPreviewPage、DebuggerPage 和 RenderApp，验证：

- 归一化后的页面结构一致。
- 初始 DataModel 一致。
- Reaction、Pipe 和 API 参数一致。
- 页面导航和 Dialog 子 Surface 行为一致。
- 错误码和 Runtime Event 顺序一致。

#### DebugApp 测试

- Agent 生成、JSON 上传和属性编辑都更新同一个 DebugWorkspaceState。
- AgentPreviewPage 与 DebuggerPage 切换时 Definition、选中节点和 dirty 状态不丢失。
- 非法 JSON 不覆盖 lastValidDefinition。
- Debugger 只能通过 Runtime Handle/Event 调试，不访问内部 Engine。

#### RenderApp 测试

- inline 和 published-page 两种 Source 均可运行。
- pageKey 快速变化时，旧请求被取消且不能覆盖新 Definition。
- Renderer 只能获得 PUBLISHED Definition。
- 固定 version 在会话中保持不变。
- checksum 或版本协议不匹配时拒绝运行并返回明确错误。

#### MicroApp 测试

- Memory Router 不修改宿主 URL。
- 卸载后无 Surface、订阅、定时器和未完成请求残留。
- iframe 消息拒绝未知 origin、错误协议版本和非法 payload。
- qiankun/single-spa 重复 mount/unmount 幂等。

#### 构建边界测试

- Debugger 和 Renderer 分别执行独立 `next build`。
- Renderer 的依赖图和 Bundle 中不存在 Agent、Debugger、CodeMirror、Prompt Builder 和 Mock API。
- Debugger 管理 API 不出现在 Renderer Route Manifest。
- Renderer 的只读 API 不具备写入或发布权限。
- 修改 Runtime 后两个 App 的类型检查和一致性测试必须同时通过。

---

## 11. 外部框架与第三方嵌入

### 11.1 JSON 定义外部框架

A2UI 除了渲染页面内部组件，还可定义外层框架结构（菜单、导航、布局），实现微前端壳：

```json
{
  "framework": {
    "type": "sidebar",
    "items": [
      { "label": "销售看板", "icon": "chart", "page": "dashboard_sales" },
      { "label": "订单管理", "icon": "order", "page": "order_list" },
      { "label": "系统设置", "icon": "settings", "children": [
        { "label": "用户管理", "url": "/external/users" },
        { "label": "角色管理", "url": "/external/roles" }
      ]}
    ]
  },
  "pages": {
    "dashboard_sales": { "a2ui": [...], "logic": {...} },
    "order_list": { "a2ui": [...], "logic": {...} }
  }
}
```

- `framework` 定义壳结构（侧边栏/顶栏/多级菜单）
- A2UI 自主生成的页面使用 `page` 引用内部页面
- 第三方页面使用 `url` 指向外部地址

### 11.2 第三方页面嵌入

通过 `<iframe>` 嵌入外部页面，A2UI 负责壳渲染，第三方负责内容：

```tsx
// framework 中 menu item 为 url → 渲染 iframe
function FrameworkShell({ framework, currentPage }) {
  return (
    <div className="flex h-screen">
      <Sidebar items={framework.items} />
      <main className="flex-1">
        {isExternal(currentPage)
          ? <iframe
              src={validateExternalUrl(currentPage.url)}
              title={currentPage.label ?? 'External page'}
              sandbox="allow-scripts allow-forms allow-same-origin"
              referrerPolicy="strict-origin-when-cross-origin"
              className="w-full h-full"
            />
          : <A2uiSurface surface={a2ui.getSurface(currentPage.page)} />
        }
      </main>
    </div>
  )
}
```

### 11.3 跨框架数据通信

A2UI 壳与嵌入的第三方页面通过 `postMessage` 双向通信：

```
┌─ A2UI Shell ──────────────────────────┐
│  Sidebar + PageSelector               │
│                                        │
│  ┌─ iframe (third-party) ──────────┐  │
│  │  window.addEventListener(       │  │
│  │    'message', handler)          │  │
│  └─────────────────────────────────┘  │
└────────────────────────────────────────┘
    ↓ postMessage({ type, payload }) ↑
```

通信协议（JSON 格式）：

```ts
// A2UI → 第三方（推送上下文）
thirdPartyWindow.postMessage({
  protocol: 'a2ui-host',
  version: '1.0',
  source: 'a2ui-shell',
  type: 'context',
  payload: {
    currentUser: '/currentUser',
    selectedTenant: '/tenantId',
    theme: 'light',
  }
}, allowedThirdPartyOrigin)

// 第三方 → A2UI（触发事件）
a2uiWindow.postMessage({
  protocol: 'a2ui-host',
  version: '1.0',
  source: 'third-party',
  type: 'navigate',
  payload: { page: 'order_detail', params: { orderId: 'ORD-001' } }
}, allowedA2UIOrigin)
```

A2UI 壳监听 `message` 事件时必须校验 `origin`、`source`、协议版本和 payload Schema，再根据 `type` 分发到对应的 Reaction 或 Navigation。第三方页面无需引入 A2UI SDK，但必须遵守版本化通信协议。

---

## 12. 与外部应用对接

### 12.1 嵌入方式

A2UI 渲染器可通过以下方式嵌入外部应用：

| 方式 | 适用场景 | 通信方式 |
|---|---|---|
| iframe | 跨域、不同技术栈 | postMessage |
| Web Component | 同域、需要紧密集成 | Custom Events + Props |
| SDK (npm 包) | React 宿主应用 | 直接 Props 传递 |

### 12.2 React SDK 接口设计（计划中）

外部 React 应用直接使用共享的 `@a2ui/render-app`，而不是定义另一套 `A2UIRenderer` API：

```tsx
import { RenderApp } from '@a2ui/render-app'
import type { A2UIRuntimeServices } from '@a2ui/runtime'

function MyApp() {
  const services = useMemo<A2UIRuntimeServices>(() => ({
    apiExecutor: request => businessApi.execute(request),
    navigateExternal: target => hostRouter.navigate(target.path),
    openExternal: url => window.open(url, '_blank', 'noopener,noreferrer'),
    toast: (message, options) => hostToast.show(message, options),
    logger: hostLogger,
    reportError: error => errorReporter.capture(error),
    track: event => analytics.track(event),
  }), [])

  return (
    <RenderApp
      source={{ type: 'inline', definition: pageDefinition }}
      context={{
        user: currentUser,
        tenant: currentTenant,
        permissions,
      }}
      services={services}
      routerMode="memory"
      onReady={handleReady}
      onError={handleRuntimeError}
    />
  )
}
```

数据模型默认由 Runtime 自治，宿主通过 Runtime Event 观察变化，通过 Runtime Handle 执行受控调试/管理命令。生产 SDK 不支持宿主直接替换整个内部 DataModel，以避免破坏 ReactionEngine 的一致性。

如未来确实需要受控数据同步，应单独设计版本化接口，例如：

```ts
interface RuntimeDataBridge {
  initialData?: Record<string, unknown>
  onPatch?: (patch: RuntimeDataPatch) => void
  applyPatch?: (patch: RuntimeDataPatch) => Promise<void>
}
```

该接口使用增量 Patch 和路径白名单，不直接暴露可变 SurfaceModel 或 DataModel 实例。