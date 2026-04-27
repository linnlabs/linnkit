# linnkit · Agent Engine 总入口

> **2026-04-24 消费者目录变化**：`linnsy`（linnkit 首批消费者，秘书产品）已从本仓的 `linnya/linnsy/` 子目录迁出到独立 repo **`BCAutumn/linnsy`**（私有）。本仓 `linnya/linnsy/` 已删除。本仓后续提到的 "linnsy" 一律指外部独立仓 `BCAutumn/linnsy`，不再是 monorepo 内子目录。`linnkit` 通过 GitHub Packages 私有 scope `@linnlabs/linnkit` 被 linnsy 装包消费（以 `package.json#version` / [`docs/release/RELEASE.md`](./release/RELEASE.md) 为准，勿依赖本行硬编码版本号）。

`packages/linnkit/src/*` 是 `linnkit` 包的发布真源。任何想做 agent 应用的接入方都通过 `linnkit` package 的公开入口装配它。

linnkit 是 vendor-neutral 的 Agent 框架，**不内置任何具体业务实现**——它提供：runtime-kernel + context-manager + ports + testkit + 公开入口面，让接入方在外部装配自己的宿主。

如果你只记一件事，就记这个：

- `packages/linnkit/src/runtime-kernel/*` 定义可复用运行时骨架
- `packages/linnkit/src/context-manager/*` 承接通用上下文子系统
- `packages/linnkit/src/ports/*` 是宿主接入面（host 必须实现）
- `packages/linnkit/src/testkit/*` 承接通用后端验证底座

接入方的宿主树（registry / context-policy / persistence / SSE 适配器 / 默认 tool 集合等）**不在本目录**——请放到接入方自己的仓库（建议路径形态：`app-hosts/<your-host>/*`）。

当前 package 形态：

- `packages/linnkit/src/*` 主体边界已收口；不再回头依赖 `src/core/*`、`src/features/*` 等任何 host 侧路径
- public API 收口为 **7 条**可 import 子路径（根 `.` + 6 条子入口；另 `exports` 含 `./package.json` 元数据；详见 §5.2）
- 历史抽包决策档案见 [`docs/archive/engine-phases/`](./archive/engine-phases/)；当前 / 未来演进文档见 [`docs/framework/`](./framework/)

---

## 1. 模块定位

Layer: `framework`

本目录负责：

- 汇总 linnkit 框架的真实代码树
- 提供总入口 README
- 明确 Agent 框架的层次边界与读文档顺序

本目录不负责：

- 任何接入方的宿主装配
- 任何接入方的 UI / API 表达层
- 任何接入方的产品策略默认值

---

## 2. 这棵树到底怎么分层

### 2.1 Runtime Kernel

位置：

- `packages/linnkit/src/runtime-kernel/*`
- 公开入口：`linnkit/runtime-kernel`（Node-only 全展开）/ `linnkit/runtime-kernel/events`（browser-safe slim seam，仅 events governance 纯函数）

它回答的问题是：

- 一次 graph run 如何执行
- 事件怎么治理
- tool runtime 最小协议是什么
- child-run 最小协议是什么
- LLM 调用骨架和 streaming 规范化是什么

它不回答的问题是：

- SSE 怎么推
- 会话怎么持久化
- 默认有哪些工具
- 产品上下文如何拼装

### 2.2 Context Manager

位置：

- `packages/linnkit/src/context-manager/*`
- 公开入口：`linnkit/context-manager`

它回答的问题是：

- 历史消息怎么进入上下文窗口
- 什么时候压缩、净化、摘要
- working memory 怎样裁剪
- agent / chat 两类 profile 的 pipeline 差异

它不回答的问题是：

- 接入方默认的 task resolver
- 接入方默认的 provider registry
- 接入方请求 schema / request adapter 的最终形态
- 任何具体产品策略默认值

### 2.3 Testkit

位置：

- `packages/linnkit/src/testkit/*`
- 公开入口：`linnkit/testkit`（**仅测试代码可 import**；`AGENT-GUARD-10-no-testkit-in-production` 强制守门，禁止生产路径引用）

这层承接 package-neutral 的测试夹具：

- tool fixtures
- agent harness primitives
- context harness

接入方还需要在自己的仓库里维护**第二层 host-bound testkit**（依赖你自己的默认 adapter 的 wrapper），linnkit 不规定该层的实现细节，只要求不要把它写回 `packages/linnkit/src/*`。

---

## 3. 大模块地图

这一节不是重复目录树，而是回答：

- 每个大模块真正负责什么
- 它和相邻模块怎么协作
- 哪些东西不要往这里塞

### 3.1 `runtime-kernel/*`

位置：

- `packages/linnkit/src/runtime-kernel/*`

这是 Agent 框架最核心的一层。它定义的不是某个产品如何接入，而是：

- 一次 run 怎样推进
- LLM/tool/child-run 怎样在同一条执行链里协同
- 事件如何被产生、治理、投影和收口

主要子模块：

- `graph-engine/*`
  - graph loop、tick pipeline、node 执行、checkpointer、step policy
  - 它拥有"run 如何前进"的规则
  - interactive tool 的正式暂停协议也定义在这里：写入 `pendingInteractionSpec` 后进入 `wait_user`，卡片数据从 `tool_call.arguments` 恢复
  - 这里的 `Checkpointer` 是 **engine-state 层** 的 checkpoint：保存 `EngineState`（`nodeId / pendingToolCalls / executorLocal.stepCount / local`）。它**不是**应用层"对话总结/上下文裁剪 checkpoint"——后者是宿主自己实现的 LLM 工具产物，落宿主的 `EventStore` 而不是这里。详见 §4.5
  - 它不拥有具体宿主的 SSE、持久化、registry、默认 tool 集合
- `events/*`
  - RuntimeEvent 合同、event mapper、生命周期规则
  - 它定义"发生了什么"，不定义"前端怎么展示"
  - 是浏览器安全的：通过 `linnkit/runtime-kernel/events` slim seam 暴露，前端可以安全 import
- `execution/*`
  - run sequencer、runtime 错误映射、执行侧公共收口
  - 它负责 run 级执行秩序，不负责具体业务流程
- `llm/*`
  - caller、model resolver、streaming 规范化、LLM policy
  - 它拥有"怎么调用模型"的平台骨架
  - 具体默认模型目录和产品策略由宿主提供
- `tools/*`
  - tool execution context、tool ports、idempotency、artifact context
  - 它定义工具运行协议，不定义具体有哪些工具
- `child-runs/*`
  - 内部 agent 调用协议、子 run 约束、调用面合同
  - 它只定义协议，不负责"已注册 agent 怎么解析"
- `run-context/*`
  - run 过程中共享的上下文合同和最小状态
- `enrichment/*`
  - runtime 侧补充元信息的最小能力
- `subrun/*`
  - 子 run 相关的共享合同与小型辅助逻辑
- `system-reminder/*`
  - runtime 级系统提醒拼装与约束
- `run-supervisor/*`
  - RunRegistryStore port + memory 实现 + contract 测试；RunSupervisor 本体待按需触发（详见 [`docs/framework/04-protocol-roadmap.md` N-3](./framework/04-protocol-roadmap.md)）
- `telemetry/*`
  - TelemetryPort + 4 类 kind 常量 + noop 默认实现 + contract 测试

一句话：

- `runtime-kernel` 拥有"Agent 框架如何运行"
- 不拥有"接入方默认怎么接"

### 3.2 `context-manager/*`

位置：

- `packages/linnkit/src/context-manager/*`
- 公开入口：`linnkit/context-manager`

这是 Agent 的通用上下文子系统。

它回答的问题是：

- 历史消息怎么进入上下文窗口
- 什么时候压缩、净化、摘要
- working memory 怎样裁剪
- 统一 agent pipeline 如何覆盖"可执行 agent"与"无工具对话"两种运行形态

主要子模块：

- `shared/*`
  - `context-pipeline`
  - `context-manager-base`
  - `context-result`
  - `MessageFormatter`
  - `preprocessors/*`
  - `providers/*`
  - `summarization/*`
  - 这里拥有真正的 context core
- `profiles/agent/*`
  - agent profile 的 context manager、orchestration、tasks 抽象、tools、utils、preprocessors
  - 这里放"agent 这种 profile 的通用差异"
- `profiles/chat/*`
  - chat 兼容层的对应实现
  - **只承接历史兼容；长期目标是 `chat = tools-disabled agent`**
  - chat 兼容层冻结计划详见 [`docs/framework/07-roi-ranked-priorities.md` Phase F](./framework/07-roi-ranked-priorities.md)（chat 兼容收敛 + 删 `linnkitCompat`）

它不拥有的东西：

- 接入方默认 task resolver
- 接入方默认 provider registry
- 接入方请求 schema 与 request adapter
- 具体产品策略默认值

这些都属于 host 层，应该留在接入方自己的仓库里。

### 3.3 `ports/*`

位置：

- `packages/linnkit/src/ports/*`
- 公开入口：`linnkit/ports`

这里是 package-neutral 的宿主接入面。它们定义：

- agent invocation request
- AI engine / model catalog 这类宿主要提供的能力接口

原则是：

- 只放 runtime 必须依赖、但不能自己拥有实现的合同
- 不放某个产品的默认实现

### 3.4 Provider replay sidecar

位置：

- 类型入口：`linnkit/ports`、`linnkit/contracts`
- 运行时链路：`runtime-kernel/llm/*`、`runtime-kernel/graph-engine/tick-pipeline/*`
- 回放链路：`context-manager/profiles/agent/utils/eventConverter.ts`、`context-manager/shared/MessageFormatter.ts`

部分 LLM provider 会返回必须随下一轮工具调用原样回放的不透明载荷，例如 reasoning blocks、工具调用签名或其它 provider 扩展。linnkit 的原则是：

- 核心只定义 vendor-neutral 槽位，不解析 provider 私有 JSON。
- LLM 响应侧统一进入 `reasoning_details` 或 `tool_calls[*].extra_content`。
- RuntimeEvent 层标准位置是 `tool_call_decision.payload.reasoning_details`。
- AiMessage 层标准位置是 `metadata.reasoning_details` 与 `metadata.tool_calls[*].extra_content`。
- Agent 出关给 LLM 时应使用 `formatAgentLlmMessages(...)`，它固定走 native tools 回放形态。

这让接入方 adapter 只负责字段互译：把 DeepSeek、Gemini、Claude、OpenRouter 等供应商私有字段归一化到通用 sidecar；不要让 graph-engine、context-manager 或 host 业务代码知道供应商私有协议。

边界也要明确：

- `subrun_trace` 是 UI / 子过程侧车，不进入主 Agent 上下文。
- `raw_output` 是 metadata / 审计 / 截断输入，不会作为独立 API 字段自动发给 LLM。
- 被工具历史压缩或摘要替换的旧工具组会失去结构化 sidecar，只保留摘要文本，这是上下文预算策略，不是 provider replay 通道。

### 3.5 `shared/*`

位置：

- `packages/linnkit/src/shared/*`
- **internal-only**：禁止外部 import；接入者通过 root 入口或子入口取等价能力

这是 Agent 框架自己的共享基础设施层，当前主要承接：

- `ids.ts`（同构：浏览器走 `globalThis.crypto.randomUUID()`，Node 退化路径自实现 v4，不依赖 `crypto`）
- `logger.ts`
- `TokenCalculator.ts`
- `llmTelemetryContext.ts`
- `llmAuditRecorder.ts`
- `errorClassifier.ts`

这层存在的意义是：

- 把 Agent 框架真正内部需要的共用能力收回 package 内
- 避免 `packages/linnkit/src/*` 继续回头依赖外部 `src/shared/*`

### 3.6 `testkit/*`

位置：

- `packages/linnkit/src/testkit/*`
- 公开入口：`linnkit/testkit`（**测试代码专用**，`AGENT-GUARD-10-no-testkit-in-production` 强制守门）

这是 package-neutral 的测试底座，只保留通用夹具：

- `tool-fixtures/*`
  - 最小 tool context、工具输入输出夹具
- `agent-harness/*`
  - scripted AI engine harness、断言和运行辅助
- `context-harness/*`
  - context pipeline / replay 相关 harness

明确不在这里的：

- 依赖宿主 runtime assembly 的 harness
- 依赖具体存储 / pathManager / DB 的 fixture

这些属于接入方自己的 host-bound testkit（建议放在 `app-hosts/<your-host>/testkit/*` 下）。

### 3.6 Host Layer（接入方负责，**不在本仓库**）

linnkit 不内置任何宿主默认实现。一个完整 Agent 应用还需要接入方自己提供：

- `adapters/*`
  - `runtime-assembly/*` —— 把 runtime-kernel 装配成可调用的 `GraphExecutor`
  - `context-injection/*` —— 把宿主请求接进 context pipeline
  - `flow/*` —— Flow 编排：history 读取、pre-run policy、host session
  - `realtime/*` —— SSE / WebSocket / MQTT 等实时通道
  - `persistence/*` —— `EventStore` / `Checkpointer` 落地
  - `tools/*` —— 默认 `ToolManager` 装配
  - `child-runs/*` —— 已注册 agent 的解析与调用
- `agent-registry/*`
  - 你的 agent / chat / system 定义
  - promptKey 到定义的绑定
- `context/*`
  - 接入方请求 shape、contracts、request adapters
- `context-policies/*`
  - 接入方默认摘要 / 上下文策略
- `testkit/*`
  - host-bound harness 与 persistence fixtures

一句话：

- `packages/linnkit/src/*` 负责框架能力
- `app-hosts/<your-host>/*`（在你自己仓库里）负责把框架接成具体产品

---

## 4. 数据流全景

一次完整 Agent run 的典型数据流（接入方装配后）：

```
前端请求 (ConversationNextRequest)
  │
  ▼
FlowOrchestrator.next()
  │
  ├─ FlowHostSessionService
  │    ├─ 创建 EventSequencer（分配 execution_id + seq）
  │    ├─ 创建 EventBus（内存事件总线）
  │    ├─ 连接 SsePort（EventBus → SSEEvent → SSE sink → 前端）
  │    └─ 立即持久化 incoming events（user_input / tool_output）
  │
  ├─ FlowRunPreparationService
  │    └─ prepareForRun()：history 读取 / truncate / 编辑重发
  │
  ▼
AgentRunnerService.run()
  │
  ├─ AgentEventBridge（sseSink 包装层）
  │    ├─ 监听 GraphExecutor 产出的 AnyAgentEvent
  │    ├─ 调用 eventMapper.agentToRuntime() 转为 RuntimeEvent
  │    ├─ 通过 EventSequencer.wrapEvent() 包装为 EventEnvelope
  │    ├─ 通过 EventBus.publish() 发布
  │    │     └─ SsePort 监听 EventBus，映射为 SSEEvent 推给前端
  │    └─ 同时收集所有生成的 RuntimeEvent（用于持久化）
  │
  ├─ StreamCollector
  │    ├─ 缓冲 final_answer_chunk → 生成完整 final_answer RuntimeEvent
  │    └─ 不发 SSE（SSE 由 SsePort 统一负责）
  │
  ▼
GraphExecutor.runUntilYield()
  │
  ├─ user → llm → tool → llm → ... → answer → yield
  │
  ├─ LlmNode
  │    ├─ 调用 tick pipeline（prepareCall → buildContext → systemReminder → executeLlm → buildDecision）
  │    ├─ 通过 sseSink 回调产出 AnyAgentEvent（thought / stream_chunk / tool_call_decision）
  │    └─ 返回 NodeResult（route / yield）
  │
  ├─ ToolNode
  │    ├─ 执行工具 → 产出 observation → 通过 sseSink 回调发出 AnyAgentEvent
  │    ├─ requireUser=true 时：不额外发首条 tool_output，直接 route 到 wait_user
  │    └─ terminateRun=true 时：直接 yield 结束本轮
  │
  └─ WaitUserNode
       ├─ 发出 requires_user_interaction SSE 事件
       └─ 返回 NodeResult(pause)
  │
  ▼
FlowHostSessionService.finalize()
  ├─ 持久化本轮 AI 产出的 RuntimeEvent（过滤 ephemeral/tool_process）
  ├─ 发出 stream_end SSE 事件
  └─ 关闭 EventBus
```

> 上图描绘的是一个**典型**接入路径：linnkit 拥有 `GraphExecutor` / `AnyAgentEvent` / `RuntimeEvent` / `eventGovernance` 这些核心抽象，但 `FlowOrchestrator` / `AgentRunnerService` / `AgentEventBridge` / `SsePort` / `FlowHostSessionService` 这些组件名是**接入方自己的命名**，linnkit 不强制存在。换成你自己的命名也可以。

### 4.1 三种事件模型

| 模型 | 所在层 | 用途 |
|------|--------|------|
| `AnyAgentEvent` | runtime-kernel（领域事件） | graph node 内部产出的原始事件 |
| `RuntimeEvent` | runtime-kernel → host（持久化事件） | 持久化、上下文重建、history 回放的事实来源 |
| 实时通道事件（如 SSE） | host realtime adapter（表现层事件） | 前端实时渲染（**接入方自己负责**） |

转换链路：

```
AnyAgentEvent ──[eventMapper.agentToRuntime()]──▶ RuntimeEvent
                                                      │
                                                      ├──[EventBus.publish()]──▶ realtime adapter ──▶ 前端
                                                      │
                                                      └──[shouldPersistRuntimeEvent()]──▶ Host EventStore
```

### 4.2 事件生命周期治理（eventGovernance）

`eventGovernance.ts` 是事件生命周期的唯一权威入口，每个 RuntimeEvent 的 lifecycle 由以下四维决策决定：

| 维度 | 含义 |
|------|------|
| `persist` | 是否写入宿主事件存储（`ephemeral=true` 或 `tool_process` 不持久化） |
| `replayToUi` | 页面 reload 时是否从宿主事件存储回放给前端 |
| `enterAgentContext` | 是否进入 LLM 上下文窗口 |
| `realtimeChannel` | 实时通道：`event_bus_sse` 或 `none` |

关键规则：

- `final_answer_chunk`：`ephemeral=true`，不持久化，不进上下文，只走实时通道
- `tool_process`：不持久化，不进上下文，只走实时通道（中间态更新）
- `tool_output`：`ephemeral=false`，持久化，进上下文，走实时通道
- `thought`（增量）：`ephemeral=true`，不持久化
- `thought`（完成）：`ephemeral=false`，持久化，进上下文

### 4.3 存储协议

- **写入时机**：每轮 run 结束后由宿主一次性原子写入
- **过滤规则**：只持久化 `shouldPersistRuntimeEvent(event) === true` 的事件
- **立即持久化**：用户输入事件（user_input / tool_output from user）应在 run 开始前直接写入
- **stream_end**：在 finalize 阶段单独持久化（包含 stats / metadata）
- **存储格式**：每个 conversation 由多个 run 组成，每个 run 是一组有序 RuntimeEvent

### 4.4 实时通道出口

linnkit 不规定具体的实时通道实现，但要求：

- **唯一出口原则**：所有实时事件必须经由 `EventBus → realtime adapter` 单一路径推给前端
- **禁止** 在 graph node / tool / bridge 中直接调用 sink 推送实时事件（`WaitUserNode` 是唯一的协议级例外，因为 `requires_user_interaction` 是暂停协议的一部分）
- **禁止** 绕过 EventBus 推送（会导致 seq 断裂和审计遗漏）
- **禁止** 在 StreamCollector 中推送实时事件（它只负责缓冲）

### 4.5 术语：两个不同的 "checkpoint"

"checkpoint" 在 agent 生态里是个被严重重载的词，至少存在两类含义完全不同但容易混的 checkpoint，请按上下文区分：

| 维度 | **Engine-state Checkpoint** | **应用层 Context Checkpoint** |
|---|---|---|
| 所属层 | `runtime-kernel/graph-engine` 平台层 | 宿主/产品层（具体由宿主 LLM 工具实现） |
| 接口 | `Checkpointer`（runtime-kernel 公开 port） | 不是平台接口，宿主自定义 |
| 存什么 | `EngineState`：`nodeId / pendingToolCalls / executorLocal.stepCount / local` | LLM 主动写的"阶段总结摘要 + 可选状态快照" |
| 谁写 | `GraphExecutor.runUntilYield` 在循环内自动 `save` | LLM 模型自己调用宿主提供的"上下文摘要"工具 |
| 谁读 | `GraphExecutor.runUntilYield` 在新循环开始时自动 `load` | 宿主的 context-manager 在下一轮上下文构建时识别 marker，把摘要点之前的旧消息从 LLM context window 裁掉 |
| 落到哪 | 宿主实现的 `Checkpointer` 适配器（如 SQLite 表 / Redis / 文件） | 通常是个 RuntimeEvent，落宿主的 `EventStore` |
| 解决什么问题 | **执行控制**：run 中断后能从断点继续推理；为长 run / 异步 run 铺路 | **上下文工程**：对话太长时压缩 LLM context window，保留语义不超 token 上限 |
| linnkit 知不知道？ | 知道（这是平台 port） | **不知道**（这是宿主产品自己的工具，linnkit 完全 unaware） |

记住一句话：

- 看到 "Checkpointer" / "EngineState checkpoint" / "checkpointer.save/load" → 永远是引擎执行状态层
- 看到 "上下文 checkpoint" / "对话摘要点" / "context summary checkpoint" → 永远是应用层语义工具，跟 `Checkpointer` port 没关系

---

## 5. 关键边界 / 不变量

1. `runtime-kernel` 不得依赖任何 host adapter 路径
2. host adapter 可以装配 `runtime-kernel`，但不能回头定义内核协议
3. 产品语义不得重新侵入 runtime 协议
4. 历史兼容出口不得恢复成真实 owner
5. 工具可以触发 child-run，但 child-run protocol 本体属于 `packages/linnkit/src/*`

### 5.1 Package Boundary Guard

当前已落地的工程护栏：

- `npm run guard:agent-boundary`

它已升级为 **AST 级**（基于 TypeScript Compiler API 的 `ts.createSourceFile` + AST 遍历，不再用纯正则），并强制 10 条规则，其中关键 5 条：

1. `packages/linnkit/src/*` 的生产代码不得直接 import 任何 host 仓库路径（`src/app-hosts/*`、`src/electron-main/*` 等）
2. `packages/linnkit/src/*` 的生产代码不得直接 import `packages/linnkit/src/*` 之外的其他 `src/*` owner
3. `packages/linnkit/src/*` 的生产代码外部 workspace contract 引用受白名单约束
4. `packages/linnkit/src/host-adapters` / `packages/linnkit/src/product-extensions` 不得重新出现
5. **`AGENT-GUARD-10-no-testkit-in-production`**：生产代码（包括 root `index.ts`）禁止 import `linnkit/testkit` 或任何 `testkit/*` deep path（防止 `vitest` 等测试依赖被 esbuild/tsup 打入生产 bundle）

### 5.2 当前公开 API

`packages/linnkit/package.json` 的 `exports` 字段明确定义了 **7 条**可 import 子路径（下表 7 行；**另**有 `./package.json` 供读 `version` 等元数据）。**装包/外部仓库**请写 `@linnlabs/linnkit`；下表 `linnkit/...` 为 monorepo 内 tsconfig alias，与 `@linnlabs/linnkit/...` 指向同一份源码。

| 子路径 | 文件 | 用途 | 浏览器安全？ |
|--------|------|------|------------|
| `linnkit`（≡ `@linnlabs/linnkit`） | `./src/index.ts` | root：ports / runtimeKernel namespace / 必要 utility | ❌ Node-only |
| `linnkit/ports` | `./src/ports/index.ts` | 宿主接入 port 合同 | ❌ Node-only |
| `linnkit/contracts` | `./src/contracts/index.ts` | 长期稳定的 contract 定义（消息 / RuntimeEvent / EventEnvelope / SSEEvent / 默认执行常量） | ❌ Node-only |
| `linnkit/runtime-kernel` | `./src/runtime-kernel/index.ts` | runtime-kernel 全展开 namespace | ❌ Node-only（含 `node:async_hooks` / `crypto` 等） |
| `linnkit/runtime-kernel/events` | `./src/runtime-kernel/events/index.ts` | **browser-safe slim seam**：仅 events governance 纯函数 | ✅ 浏览器安全 |
| `linnkit/context-manager` | `./src/context-manager/index.ts` | context 与 task resolver 的兼容导出层 | ❌ Node-only |
| `linnkit/testkit` | `./src/testkit/index.ts` | **测试专用**，guard 强制守门，禁止生产 import | ❌ Node-only |

刻意暂不从根入口导出：

- `runtime-kernel/llm`（仍带宿主装配假设）
- 其他仍带 app 基础设施假设的 runtime 子模块

原因：

- 目录已经接近 package-neutral，不代表所有子模块都已经准备好成为稳定 public API
- public API 必须比目录收口更保守

---

## 6. 详细目录树

```text
packages/linnkit/
├── package.json                # 真 package manifest（exports / linnkit metadata）
├── tsconfig.json
├── vitest.config.ts
├── README.md                   # （包级总览）
├── __tests__/                  # 包级 smoke（package shell + tsconfig 不变量守护）
└── src/
    ├── README.md               # 本文件
    ├── DEVELOPMENT_GUIDE.md
    ├── INTEGRATION_GUIDE.md
    ├── docs/                   # framework 演进文档 + 99-research-notes + archive
    ├── index.ts                # root 公开入口
    ├── runtime-kernel/
    │   ├── README.md
    │   ├── child-runs/         # child-run 原语、history policy、最小上下文
    │   ├── execution/          # event-bus / sequencer / runtime error factory
    │   ├── events/             # agentEvents / eventGovernance / eventMappers（含浏览器安全 slim seam 的真源）
    │   ├── graph-engine/       # GraphExecutor / tick-pipeline / nodes / checkpointer / event-store
    │   ├── llm/                # caller / modelResolver / policies / streaming
    │   ├── enrichment/         # enrichment registry 与 patch 合同
    │   ├── run-context/        # run trace / parent / tags
    │   ├── run-supervisor/     # RunRegistryStore port + memory 实现 + contract 测试
    │   ├── subrun/             # subrun trace publisher 与最小合同
    │   ├── system-reminder/    # reminder 规则与 apply
    │   ├── telemetry/          # TelemetryPort + noop 默认 + contract 测试
    │   └── tools/              # tool contracts / execution context / schema context / helpers
    ├── context-manager/
    │   ├── README.md
    │   ├── shared/             # context core（pipeline / preprocessors / providers / summarization）
    │   └── profiles/
    │       ├── agent/          # agent profile owner
    │       └── chat/           # chat 历史兼容层（长期目标 = tools-disabled agent）
    ├── shared/                 # internal-only：ids / logger / TokenCalculator / errorClassifier / ...
    ├── ports/                  # agent-invocation / ai-engine / model-catalog 等接入面
    ├── contracts/              # 长期稳定 contract 定义
    └── testkit/
        ├── tool-fixtures/      # 最小 tool context、I/O 夹具
        ├── agent-harness/      # scriptedAiEngineHarness / assertions
        └── context-harness/    # context pipeline / replay 相关 harness
```

接入方建议的 host 目录形态（**不在 linnkit 仓库**，放在你自己的仓库里）：

```text
app-hosts/<your-host>/
├── adapters/
│   ├── child-runs/
│   ├── context-injection/
│   ├── flow/
│   ├── persistence/
│   ├── realtime/
│   ├── runtime-assembly/
│   └── tools/
├── agent-registry/
├── context/
├── context-policies/
└── testkit/
    ├── agent-harness/
    └── persistence/
```

---

## 7. 后端 Agent 的真实执行链

### 7.1 一次 run 如何被启动

1. Host adapter 收到请求
2. Flow 做 history read / pre-run policy / host session 建立
3. runtime-assembly 装好默认 `GraphExecutor`、`LlmNode`、`toolRuntime`
4. runtime-kernel 执行：
   - graph loop
   - llm node
   - tool node
   - child-run protocol
5. host adapter 收口：
   - realtime
   - persistence
   - stream_end

### 7.2 你应该在哪里改

如果你改的是：

- graph loop / node / event / llm / tool runtime capability
  - 去 `packages/linnkit/src/runtime-kernel/*`
- Flow 编排 / realtime / persistence / 默认装配
  - 去你自己仓库的 `app-hosts/<your-host>/adapters/*`
- agent definition / context strategy / concrete tools
  - 这通常还是 host product 层，不在 linnkit 内

---

## 8. 最容易放错层的几类改动

1. 默认 ToolRegistry / default ports
   - 这是 host adapter，不是 runtime-kernel
2. `ToolContext` 产品字段
   - 这是 tools/context/product 边界，不是 graph-engine
3. `stream_end` / 实时事件行为
   - 这是 Flow host session，不是 runtime-kernel
4. child-run 的"已注册 agent 解析"
   - 这是 host adapter，不是 child-run kernel 原语

---

## 9. 当前明确不并入框架的部分

linnkit 不内置以下任何东西，它们应留在接入方自己的仓库：

- 任何具体业务工具集（如文件操作、KB 检索、网页抓取等）——按你的产品语义和工具族在 host 层组织
- 前端 projection / UI 相关目录——不属于 Agent 框架范畴
- 任何 product-specific 评测层——属于 host 评测，不属于通用框架

下一阶段框架自身要研究的，详见 [`docs/framework/`](./framework/)：

- 协议层下沉（`AgentSpec` / `MessageBus` / `Memory` / `Permission` 等）
- chat 兼容层何时彻底冻结、统一收敛到"tools-disabled agent"形态（[`docs/framework/07-roi-ranked-priorities.md` Phase F](./framework/07-roi-ranked-priorities.md)）

---

## 10. 推荐阅读顺序

### 理解整体框架架构

1. 本文档
2. [`packages/linnkit/src/runtime-kernel/README.md`](../src/runtime-kernel/README.md)
3. [`packages/linnkit/src/runtime-kernel/graph-engine/README.md`](../src/runtime-kernel/graph-engine/README.md)
4. [`packages/linnkit/src/runtime-kernel/tools/README.md`](../src/runtime-kernel/tools/README.md)
5. [`packages/linnkit/src/context-manager/README.md`](../src/context-manager/README.md)

### 改 graph / event / tool runtime

1. [`packages/linnkit/src/runtime-kernel/graph-engine/README.md`](../src/runtime-kernel/graph-engine/README.md)
2. [`packages/linnkit/src/runtime-kernel/tools/README.md`](../src/runtime-kernel/tools/README.md)
3. [`packages/linnkit/src/runtime-kernel/README.md`](../src/runtime-kernel/README.md)

### 准备接入 / 装配宿主

1. [`packages/linnkit/docs/INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md)
2. [`packages/linnkit/src/runtime-kernel/README.md`](../src/runtime-kernel/README.md)
3. [`packages/linnkit/src/context-manager/README.md`](../src/context-manager/README.md)
4. [`packages/linnkit/src/testkit/README.md`](../src/testkit/README.md)

---

## 11. 开发注意事项

1. 写代码前先判断 owner，不要先挑一个"顺手的旧路径"
2. 不要为了目录整齐把 product 语义硬塞进 runtime-kernel
3. 新 bridge 只能作为过渡，不能作为新开发入口
4. 修改 runtime 协议时，必须补 contract / integration tests
5. 文档必须追随真实路径，不追随历史 import 习惯
6. 前端代码**禁止**从 `linnkit/runtime-kernel`（namespace 全展开入口）import；只能从 `linnkit/runtime-kernel/events` 这个 browser-safe slim seam 取 events governance 纯函数

如果你是准备继续开发或接入，不要只看这份 README：

- 开发指南：[`packages/linnkit/docs/DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md)
- 外部接入指南：[`packages/linnkit/docs/INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md)

---

## 12. 文档树索引

### Runtime Kernel

- [`packages/linnkit/src/runtime-kernel/README.md`](../src/runtime-kernel/README.md)
- [`packages/linnkit/src/runtime-kernel/graph-engine/README.md`](../src/runtime-kernel/graph-engine/README.md)
- [`packages/linnkit/src/runtime-kernel/llm/README.md`](../src/runtime-kernel/llm/README.md)
- [`packages/linnkit/src/runtime-kernel/tools/README.md`](../src/runtime-kernel/tools/README.md)

### Context Manager

- [`packages/linnkit/src/context-manager/README.md`](../src/context-manager/README.md)

### Testkit

- [`packages/linnkit/src/testkit/README.md`](../src/testkit/README.md)
- [`packages/linnkit/src/testkit/agent-harness/README.md`](../src/testkit/agent-harness/README.md)
- [`packages/linnkit/src/testkit/context-harness/README.md`](../src/testkit/context-harness/README.md)

### Guide

- [`packages/linnkit/docs/DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md)
- [`packages/linnkit/docs/INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md)

### linnkit 框架文档

- [`packages/linnkit/docs/framework/`](./framework/) —— **活文档**：linnkit 作为独立 Agent 框架的演进
- [`packages/linnkit/docs/99-research-notes/`](./99-research-notes/) —— 外部项目调研笔记
- [`packages/linnkit/docs/archive/engine-phases/`](./archive/engine-phases/) —— **已归档**：早期抽包决策档案
- [`packages/linnkit/docs/release/`](./release/) —— 发布流水（RELEASE.md + 历史叙事）

---

## 13. docs/framework 写作约定

框架演进活文档（[`docs/framework/`](./framework/)）的写作必须遵循：

1. **一次研究一个 topic**，不并行
2. **每个 topic 文档统一模板**：问题 / 现状 / 同类做法 / 候选方案 / 倾向 / 落地任务 / 状态
3. **外部项目调研结论先进 [`docs/99-research-notes/<project>.md`](./99-research-notes/)**，再把"对我们的启发"摘进对应 framework topic
4. **写完一个 topic commit 一个**。message：`docs(linnkit): write framework/<topic-id> <短描述>`
5. **未完成的 topic 不创建空文件**
6. **任何往协议层加东西的请求，先过门槛**：协议而非实现 / ≥2 消费者真实需求 / framework 不加就没法接 / 不破坏现有不变量。详见 [`docs/archive/engine-phases/00-engine-scope-audit.md`](./archive/engine-phases/00-engine-scope-audit.md) §1.1。**默认归产品层，不是默认升级 framework**
