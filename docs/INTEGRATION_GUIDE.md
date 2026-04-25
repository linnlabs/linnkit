# linnkit Integration Guide

这份文档回答的是一件事：

**如果你要接入 linnkit 这套 Agent 框架，最少需要自己提供什么，应该从哪里开始看。**

当前 package 形态：

- `packages/linnkit/src/*` 是 linnkit 框架本体，也是 `linnkit` 包的真源
- 接入方需要在自己的仓库里提供 **host 层**（runtime assembly / registry / context-policy / persistence / realtime 适配器 / 默认 tool 集合）
- `packages/linnkit/package.json` 的 `exports` 当前稳定子入口是 6 个：`.` / `./ports` / `./contracts` / `./runtime-kernel` / `./runtime-kernel/events` / `./context-manager` / `./testkit`。其中 `./runtime-kernel/events` 是 **browser-safe slim seam**，`./testkit` 是 **测试专用**（生产代码 import 会被 guard 拦掉）
- 所有跨包 import 必须走 `linnkit` 或 `linnkit/<entry>` 子入口；deep import `packages/linnkit/src/<sub>/<deep>` 会被 AST 级 boundary guard 拦掉
- `runtime-kernel` 公开面已包含持久化与 telemetry 的 port 插槽，下面 5 个完整例子可以直接套用

一句大白话：

你要复用的是 `linnkit`（即 `packages/linnkit/src/*`），然后在自己的仓库里实现一个 host layer；不要试图把宿主默认实现塞回 `linnkit` 内部。

## 1. 你需要接什么

一个新项目要把 Agent 跑起来，至少要提供这几类东西：

1. 宿主装配：把 graph、LLM、tool runtime、context builder 拼起来。
2. registry：告诉平台有哪些 agent / task / chat 入口。
3. context binding：把你自己的请求、策略、provider 约束接到平台上下文里。
4. tool runtime：把你自己的工具集和执行权限接进来。
5. flow / realtime / persistence：决定请求从哪里来、如何存历史、如何把事件推给外部系统。

参考目录形态（建议放在你自己仓库的 `app-hosts/<your-app>/*` 下）：

- `app-hosts/<your-app>/adapters/*` —— flow、realtime、persistence、runtime-assembly、context-injection、tools、child-runs 等接入面
- `app-hosts/<your-app>/agent-registry/*` —— 你的 agent / task / chat 注册表
- `app-hosts/<your-app>/context/*` —— 请求 schema 与 context request adapters
- `app-hosts/<your-app>/context-policies/*` —— 默认 provider registry / 上下文裁剪策略
- `app-hosts/<your-app>/testkit/*` —— host-bound 测试 wrapper

linnkit 不强制你的目录长这样，但建议保持"adapters / registry / context / context-policies / testkit"分层，便于复用本指南的术语。

## 2. linnkit 公开面

现在要优先走的是公开入口，不是内部文件路径。

### 2.1 根入口

- `packages/linnkit/src/index.ts:1`：根入口稳定暴露 `ports`、`runtimeKernel`、`testkit`、`generateMessageId`、`generateRunId`、`withLLMTelemetryContext`。
- `packages/linnkit/src/index.ts:12`：`linnkitCompat` 仍存在，但它是迁移期兼容面，不应该成为新接入方的默认入口。

### 2.2 子入口

- `packages/linnkit/package.json` 的 `exports` 字段（**真源**）：当前已收口为 6 个稳定入口：`.` / `./ports` / `./contracts` / `./runtime-kernel` / `./runtime-kernel/events` / `./context-manager` / `./testkit`。
- `packages/linnkit/src/ports/index.ts`：宿主最小调用合同（→ `linnkit/ports`）。
- `packages/linnkit/src/contracts/index.ts`：长期稳定 contract 定义（→ `linnkit/contracts`）。
- `packages/linnkit/src/runtime-kernel/index.ts:1`：graph / tools / execution / events / llm / runSupervisor / telemetry 等长期依赖面（→ `linnkit/runtime-kernel`，**Node-only**）。
- `packages/linnkit/src/runtime-kernel/events/index.ts`：browser-safe slim seam，仅 events governance 纯函数（→ `linnkit/runtime-kernel/events`，**前端必须走这个**）。
- `packages/linnkit/src/context-manager/index.ts`：context 与 task resolver 的兼容导出层（→ `linnkit/context-manager`）。
- `packages/linnkit/src/testkit/index.ts`：package-neutral 测试 primitive（→ `linnkit/testkit`，**测试专用**，`AGENT-GUARD-10-no-testkit-in-production` 强制守门）。

### 2.3 选择规则

新接入代码优先级应该是：

1. 先看 `packages/linnkit/src/<entry>/index.ts`
2. 找不到再补公开面
3. 不要直接 `from 'packages/linnkit/src/<sub>/<deep>'`

## 3. 双层 testkit 是什么

这里有两层 testkit，不是重复建设。

### 3.1 `packages/linnkit/src/testkit/*`（linnkit 提供）

这是 package-neutral 的测试底座，只放平台自己拥有的 primitive：

- scripted AI harness
- graph loop runtime-owned seam
- tool context fixture
- context pipeline / replay harness

参考：

- `packages/linnkit/src/testkit/README.md`
- `packages/linnkit/src/testkit/agent-harness/scriptedAiEngineHarness.ts:97`
- `packages/linnkit/src/runtime-kernel/testkit/graphLoopHarness.ts:24`
- `packages/linnkit/src/testkit/tool-fixtures/toolContext.ts:21`

### 3.2 host-bound testkit（你自己提供）

这是依赖你的默认 adapter 的 wrapper，建议放在 `app-hosts/<your-app>/testkit/*` 下。典型形态：

- graph loop host harness：把你的默认 `LlmNode` / `AgentEventBridge` / `observationPreview` 塞进 linnkit 提供的 `createGraphLoopHarness()`
- child-run host harness：复用你的 child-run 装配
- tool registry harness：基于你的 default `ToolManager` 做 host-bound `ToolRuntimeHarness`
- host-bound in-memory event store：在测试里替代你生产的 SQLite/Postgres 实现

linnkit 不强制规定 host-bound testkit 的实现细节，但要求第二层 wrapper 不要回写 `packages/linnkit/src/*`。

### 3.3 你怎么用

- 你要验证平台 contract：先看 `packages/linnkit/src/testkit/*`
- 你要验证"你的宿主装配是不是通了"：在你自己的 `app-hosts/<your-app>/testkit/*` 里做第二层 wrapper

## 4. 5 个最小接入例子

下面 5 段都用同一个结构：

- `linnkit 公共契约`
- `linnkit 自带 mock primitive`
- `你要做的`
- `你不要做的`
- `最小验证`

### 4.1 例 1：跑一个 agent

**linnkit 公共契约**

- `packages/linnkit/src/ports/agent-invocation.ts:14` 看 `AgentInvocationRequest`
- `packages/linnkit/src/runtime-kernel/index.ts:1` 看 `graph` namespace

**linnkit 自带 mock primitive**

- `packages/linnkit/src/testkit/agent-harness/scriptedAiEngineHarness.ts:97` 看 `createScriptedAiEngineHarness`
- `packages/linnkit/src/runtime-kernel/testkit/graphLoopHarness.ts:24` 看 `createGraphLoopHarness`

**你要做的**

1. 定义你自己的请求入口，让它至少能给出 `query`、`promptKey`、`model_id`、`mode`。
2. 在你的 host runtime assembly 里 new 出 `GraphAgentExecutor` 或 `GraphExecutor` 依赖袋。
3. 用 `GraphLoopHarness` 或你自己的 host wrapper 跑通一轮最小对话。

**你不要做的**

- 不要在宿主里直接 new `packages/linnkit/src/runtime-kernel/graph-engine/nodes/*`
- 不要把你自己的 flow / realtime / persistence 逻辑塞回 `packages/linnkit/src/*`
- 不要把 `PromptKeys` 这类产品菜单再绑回平台 ports

**最小验证**

- 先跑 `packages/linnkit/src/testkit/__tests__/graphLoopHarness.contract.test.ts`
- 然后在你自己的 `app-hosts/<your-app>/testkit/agent-harness/__tests__/` 下做一组 graph-loop 集成测试

### 4.2 例 2：接 LLM provider

**linnkit 公共契约**

- `packages/linnkit/src/ports/ai-engine.ts:15` 看 `AgentAiEngine`
- `packages/linnkit/src/runtime-kernel/llm/index.ts` 看 `LlmCaller`、`ModelResolver`、`ModelCatalogLike`

**linnkit 自带 mock primitive**

- `packages/linnkit/src/testkit/agent-harness/scriptedAiEngineHarness.ts:54` 看 `ScriptedAiEngineHarness`
- `packages/linnkit/src/testkit/agent-harness/scriptedAiEngineHarness.ts:183` 看 `getLlmCaller()` 如何直接产出可注入的 `LlmCaller`

**你要做的**

1. 实现一个符合 `AgentAiEngine` 的适配器。
2. 用 `LlmCaller` 包一层，让 graph 侧只依赖统一调用口。
3. 在 runtime factory 里把 model catalog、model resolver、provider adapter 装进同一个依赖袋。

**Reasoning / provider replay sidecar**

部分 reasoning model 在工具调用轮次中会返回必须原样回传的 provider sidecar。linnkit 的通用槽位是：

- `AgentAiEngineStreamContent.reasoning_details`：流式 chunk 或非流式响应中的不透明 reasoning blocks。
- `RuntimeEvent(tool_call_decision).payload.reasoning_details`：运行时事实事件中的标准持久化位置。
- `AiMessage.metadata.reasoning_details`：回放到 context-manager 后的标准位置。
- `tool_calls[*].extra_content`：工具调用自身的 provider 扩展载体，例如需要随工具调用原样回放的签名。

接入方的 adapter 只需要把供应商私有字段归一到这些通用槽位；不要把供应商私有字段直接扩散到 graph-engine 或 context-manager。linnkit 会在 `LlmCaller -> buildDecisionStage -> RuntimeEvent -> eventConverter -> formatAgentLlmMessages` 这条链路上保留这些不透明载荷。

出关到 LLM 时，Agent 模式推荐统一使用 `formatAgentLlmMessages(messages)`。它固定使用 native tool 回放形态，避免把 `AiMessage[]` 误当作最终 LLM request messages。

注意：被工具历史压缩、历史摘要替换或 chat formatter 处理过的旧工具组，不再保证结构化 sidecar 可回放；这是 token 预算与 chat 兼容层的设计取舍。若某个 provider 要求工具调用后的 reasoning blocks 必须回传，应确保对应工具组仍以原始 `tool_call_decision + tool_output` 结构进入下一轮上下文。

**你不要做的**

- 不要让 graph 代码直接知道你家的 HTTP SDK
- 不要在测试里 patch 模块级全局 AI engine
- 不要把 provider 专属重试、审计、fallback 逻辑散在业务文件里

**最小验证**

- 直接用 `createScriptedAiEngineHarness()` 做红绿测试
- 然后在你自己的 host harness 里覆盖"step policy / 多 provider 切换"路径

### 4.3 例 3：接你的工具集

**linnkit 公共契约**

- `packages/linnkit/src/runtime-kernel/tools/index.ts:1` 看 `BaseTool`、`ToolRuntimePort`、`ToolExecutionContext`、`ObservationPreviewPort`
- `packages/linnkit/src/runtime-kernel/tools/index.ts:9` 看 `ensureToolContextRuntimeCapability`

**linnkit 自带 mock primitive**

- `packages/linnkit/src/testkit/tool-fixtures/toolContext.ts:21` 看 `createToolContextFixture`
- `packages/linnkit/src/testkit/tool-fixtures/toolContext.ts:31` 看 runtime capability 是怎么补进去的

**你要做的**

1. 定义你自己的 `BaseTool[]` 或 `ToolRuntimePort`。
2. 约定哪些字段走通用 `ToolExecutionContext`，哪些字段由 host patch 补进去。
3. 在 host 的默认 tool manager / registry 层把工具集挂进去。

**你不要做的**

- 不要让工具直接吃宿主的全局单例
- 不要把运行时保留字段手工混进 patch，优先用 `ensureToolContextRuntimeCapability`
- 不要从 `packages/linnkit/src/runtime-kernel/tools/<deep>` 里抓内部 helper

**最小验证**

- 跑 `packages/linnkit/src/testkit/tool-fixtures/toolContext.test.ts`
- 然后在你自己的 host-bound `ToolRuntimeHarness` 上覆盖"失败恢复 / 并行"路径

### 4.4 例 4：接持久化

> **术语提醒**：`Checkpointer` 在这里指 **engine-state checkpoint**——保存 graph engine 执行状态（`nodeId / pendingToolCalls / executorLocal.stepCount / local`），用来"中断后从断点继续推理"。它**不是**任何"对话总结/上下文裁剪"语义；如果你产品里有那种语义工具（例如让 LLM 主动写阶段摘要、下一轮裁掉旧消息），那是上下文工程层面的 RuntimeEvent，应该走你自己的 `EventStore`，跟本接口无关。详见 §9 术语表。

**linnkit 公共契约**

- `packages/linnkit/src/runtime-kernel/graph-engine/checkpointer/base.ts:27` 看 `Checkpointer`
- `packages/linnkit/src/runtime-kernel/graph-engine/event-store/base.ts:17` 看 `EventStore`
- `packages/linnkit/src/runtime-kernel/run-supervisor/runRegistryStorePort.ts:32` 看 `RunRegistryStore`
- `packages/linnkit/src/runtime-kernel/index.ts:11` 看 `runSupervisor` namespace

**linnkit 自带 mock primitive**

- `packages/linnkit/src/runtime-kernel/graph-engine/checkpointer/memoryCheckpointer.ts`
- `packages/linnkit/src/runtime-kernel/graph-engine/event-store/memoryEventStore.ts`
- `packages/linnkit/src/runtime-kernel/run-supervisor/memoryRunRegistryStore.ts`

**你要做的**

1. 自己决定真正落盘的后端是 SQLite、Postgres、IndexedDB 还是别的。
2. 只需要实现 port，不需要把数据库实现塞进 `packages/linnkit/src/*`。
3. 把 `Checkpointer`、`EventStore`、`RunRegistryStore` 作为 host 装配点依赖注入。

**实现 EventStore 的常见落地建议**

- 如果你有既存表（如 `conversations / runs / events / messages`），可以采用 **schema-preserving event-grained core**：保留既有表结构，不新增第二张事件事实表。
- 你的 `EventStore` 实现可以同时对外暴露两组 API：
  - host 主写链直接使用的短事务写入会话 API（如 `beginRunSession` / `appendEventToRun` / `completeRun` / `failRun`）
  - 给 `linnkit EventStore` port 消费的 adapter（把 `append/range/latestEventId` 语义桥接到底层实现）
- adapter 是 host-owned，不进入 `packages/linnkit/src/*` 公开面。
- 写入时使用 linnkit 已提供的 `createMonotonicEventIdFactory()` 生成单调 id；旧数据可保持 `NULL` 并在读取时 fallback。
- 事务边界推荐**短事务**：每个 lifecycle 调用各自独立 commit，**不要**跨整个 LLM/tool 执行过程持有数据库事务。

**你不要做的**

- 不要把"数据库就是平台默认实现"这个假设写死
- 不要跳过 `schemaVersion` / `CheckpointMeta` 这些契约字段
- 不要一边写库一边偷偷吞掉冲突或重复事件

**最小验证**

- 跑 `packages/linnkit/src/runtime-kernel/graph-engine/checkpointer/__tests__/memoryCheckpointer.contract.test.ts`
- 跑 `packages/linnkit/src/runtime-kernel/graph-engine/event-store/__tests__/eventStore.contract.test.ts`
- 跑 `packages/linnkit/src/runtime-kernel/run-supervisor/__tests__/runRegistryStore.contract.test.ts`

### 4.5 例 5：监听事件流 / 接 Telemetry

**linnkit 公共契约**

- `packages/linnkit/src/runtime-kernel/telemetry/telemetryPort.ts:12` 看 `TelemetryEvent`
- `packages/linnkit/src/runtime-kernel/telemetry/telemetryPort.ts:42` 看 `TelemetryPort`
- `packages/linnkit/src/runtime-kernel/telemetry/telemetryEvents.ts` 看 4 类 kind 常量

**linnkit 自带 mock primitive**

- `packages/linnkit/src/runtime-kernel/telemetry/noopTelemetry.ts:3` 看默认 noop 实现
- `packages/linnkit/src/runtime-kernel/telemetry/__tests__/telemetry.contract.test.ts` 看 contract 约束

**你要做的**

1. 决定 telemetry 是写日志、打指标、还是投递到你自己的 tracing 管道。
2. 把 `TelemetryPort` 作为可选能力接入，不影响默认运行。
3. 把 provider、tool、graph node、run lifecycle 的观测统一收敛到同一条管道。
4. 在你的 host run 包裹层用 `withLLMTelemetryContext` 把 run 作用域的 telemetry context 挂上去。

**你不要做的**

- 不要把 telemetry 直接和 UI 事件流绑死
- 不要把 tracing id、run id 透传到模型供应商请求体里
- 不要把"先埋点再说"的 ad-hoc 日志继续散在 host 业务逻辑里

**最小验证**

- 跑 `packages/linnkit/src/runtime-kernel/telemetry/__tests__/telemetry.contract.test.ts`
- 然后用你自己的 host run wrapper 验证 run 作用域内 telemetry context 不串。

## 5. 平台与接入方边界

### 5.1 平台层：`packages/linnkit/src/*`

平台负责：

- runtime-kernel
- context-manager
- ports
- shared kernel utilities
- package-neutral testkit

平台不负责：

- 你的默认 provider 选择
- 你的数据库实现
- 你的项目专属 task 菜单
- 你的 API / UI DTO

### 5.2 接入方：`app-hosts/<your-app>/*`

你要自己提供：

- flow / realtime / persistence
- runtime assembly
- context request adapters
- default tool registry / tool ports
- agent/chat/task registry
- project-specific policy

## 6. 硬约束（接入方必读）

linnkit 的 package-boundary 由 **AST 级 guard**（基于 TypeScript Compiler API）强制 10 条规则。新接入方要遵守下面几条硬规则：

1. 只能从 `linnkit` 根入口或 6 个公开子入口（`linnkit/ports` / `linnkit/contracts` / `linnkit/runtime-kernel` / `linnkit/runtime-kernel/events` / `linnkit/context-manager` / `linnkit/testkit`）导入。
2. 不能 deep import `packages/linnkit/src/<sub>/<deep>`。
3. 不能依赖 `packages/linnkit/src/shared/logger`、`packages/linnkit/src/shared/errorClassifier`、`packages/linnkit/src/shared/TokenCalculator` 这类 internal-only 文件。
4. 不要把你自己的 provider/tool/adapter 反向塞回 `packages/linnkit/src/*`。
5. `promptKey` 在 ports 层是 opaque string，平台不认识你的产品菜单。
6. **前端代码禁止 import `linnkit/runtime-kernel`**（namespace 全展开入口，含 `node:async_hooks` / `crypto` 等 Node-only 子树）。前端只能从 `linnkit/runtime-kernel/events` slim seam 取 events governance 纯函数。
7. **生产代码（包括根 `index.ts`）禁止 import `linnkit/testkit`**。否则 `vitest` 等测试依赖会被 esbuild/tsup 打入生产 bundle。`AGENT-GUARD-10-no-testkit-in-production` 强制守门。

如果你违反这些规则，当前 guard/CI 会直接拦。

## 7. 当前不建议你做的事

不要这样接：

1. 直接复制别人的 host adapters 然后硬改——别人的宿主内嵌了它们的产品决策（默认 provider / 默认 task / 默认 schema），不能直接当模板。
2. 让新项目继续 import 别人的宿主 registry / context / flow。
3. 在 `packages/linnkit/src/*` 里增加某个项目专属 policy 或默认实现。
4. 为了省事继续从外部 schemas 包拿本该属于 agent 的 A 类协议。

正确做法是：

- 复用 `packages/linnkit/src/*`
- 新建你自己的 host layer
- 在 host 里决定 provider、tool、persistence、flow 的真实实现

## 8. 推荐阅读顺序

1. `packages/linnkit/docs/README.md`
2. `packages/linnkit/docs/DEVELOPMENT_GUIDE.md`
3. `packages/linnkit/src/runtime-kernel/README.md`
4. `packages/linnkit/src/context-manager/README.md`
5. `packages/linnkit/src/testkit/README.md`
6. `packages/linnkit/docs/framework/` —— linnkit 作为独立 Agent 框架的演进方向

## 9. 术语对照（重要）

agent 生态里有几个名字相同但语义完全不同的概念，外部接入方常在第一次踩坑后才意识到。先记一下：

### 9.1 "Checkpoint" 的两种含义

| 维度 | **Engine-state Checkpoint**（linnkit 拥有） | **应用层 Context Checkpoint**（你自己的产品工具） |
|---|---|---|
| 接口 | `Checkpointer` port（`runtime-kernel/graph-engine/checkpointer/base.ts`） | 不是 linnkit 接口；通常是你定义的一个 LLM 工具 |
| 存什么 | `EngineState`：`nodeId / pendingToolCalls / executorLocal.stepCount / local` | LLM 主动写的"阶段总结摘要" |
| 谁触发 | `GraphExecutor` 在循环内自动 save / load | LLM 模型自己在判断对话过长时主动调用工具 |
| 解决什么 | 执行控制：中断恢复、为长 run / 异步 run 铺路 | 上下文工程：压缩 LLM context window、保留语义 |
| 落到哪 | 你提供的 `Checkpointer` 适配器（SQLite/Redis/文件…） | 通常是个 RuntimeEvent，落你自己的 `EventStore` |
| linnkit 知不知道？ | 知道（公开 port） | **不知道**（这是你产品自己的事） |

接入时不要把这两件事混到一起：
- 实现 `Checkpointer` adapter 时，**只**要能 save/load `EngineState` 就够了。不要试图在里面塞"摘要 / 对话压缩"语义。
- 如果你想做"对话太长时压缩上下文"，那是另外一条产品功能：定义你自己的 LLM 工具、它的输出走你的 `EventStore`、由你自己的 context-manager pipeline 在下一轮上下文构建时识别 marker 并裁剪。

### 9.2 "Event" 的几个层

| 名字 | 所在层 | 用途 |
|---|---|---|
| `AnyAgentEvent` | runtime-kernel 内部领域事件 | graph node 内部产出的原始事件 |
| `RuntimeEvent` | runtime-kernel → host 持久化事件 | 持久化、上下文重建、history 回放的事实来源 |
| 实时通道事件（如 SSE） | host realtime adapter | 前端实时渲染（**接入方自己负责**） |

`RuntimeEvent` 的持久化由你的 `EventStore` adapter 落地；实时推送由你自己的 realtime adapter 决定（SSE/WebSocket/MQTT 都行）。linnkit 不规定这一层。

## 10. 关联文档

### 框架演进与协议路线图

- [`packages/linnkit/docs/framework/`](./framework/) —— linnkit 作为独立 Agent 框架的演进活文档
- [`packages/linnkit/docs/framework/04-protocol-roadmap.md`](./framework/04-protocol-roadmap.md) —— 6 条新协议层 + 4 条治理升级
- [`packages/linnkit/docs/framework/07-roi-ranked-priorities.md`](./framework/07-roi-ranked-priorities.md) —— ROI 排序的优先级清单 + Phase F/G/H 时间表

### 历史抽包决策档案（已归档）

- [`packages/linnkit/docs/archive/engine-phases/13-public-api-surface-and-host-migration-batches.md`](./archive/engine-phases/13-public-api-surface-and-host-migration-batches.md)
- [`packages/linnkit/docs/archive/engine-phases/14-stable-vs-compat-exports.md`](./archive/engine-phases/14-stable-vs-compat-exports.md)
- [`packages/linnkit/docs/archive/engine-phases/20-d3-d4-port-interfaces-plan.md`](./archive/engine-phases/20-d3-d4-port-interfaces-plan.md)
