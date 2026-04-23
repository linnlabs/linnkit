# linnkit · Agent Engine 总入口

> ✅✅ **2026-04-23 阶段终态 banner**：Phase E 真抽包已**彻底完成**（§9 完成判据 11/11 全绿，桌面手测主链路用户已亲手验证通过）。
> 本目录就是 `linnkit` package 的真源（`packages/linnkit/src/*`），不再有任何 `src/agent/*` 历史路径。
>
> **当前形态一句话**：`linnkit` 已是独立 package，具备 linnsec 运行所需的全部基础能力；同时这一轮升级也让 Linnya 自然受益于多 provider LLM / RunHandle / Checkpointer / EventStore / Telemetry / 工具并行 / 跨切面错误模型 等高级特性。

`packages/linnkit/src/*` 是 Linnya 后端 Agent 主链的真实根目录，也是 `linnkit` 包的发布真源。Linnya 桌面、未来的 linnsec 秘书产品、以及任何第三方接入方，都通过 `linnkit` package 公开入口装配它。

如果你只记一件事，就记这个：

- `packages/linnkit/src/runtime-kernel/*` 定义可复用运行时骨架
- `packages/linnkit/src/context-manager/*` 承接通用上下文子系统
- `src/app-hosts/linnya/*` 承接已外置出的 Linnya 宿主/产品实现
- `packages/linnkit/src/testkit/*` 承接通用后端验证底座

后端 Agent 主链已经完成收口。旧 `src/core/*`、`src/features/conversation/flow/*`、`src/features/context-manager/*`、`src/features/agent-registry/*` 不再是权威开发入口；其中 Agent bridge 主线已删除完成。

当前真实状态：

- `packages/linnkit/src/*` 主体边界已彻底收口，**Phase E 真抽包已完成**（详见 [`docs/engine/24 §9`](./docs/engine/24-phase-e-implementation-runbook.md)）
- public API 已收口为 6 个稳定子入口（详见 §5.2）
- `src/app-hosts/linnya/*` 是 Linnya 作为接入方的真实宿主树
- `packages/schemas` 当前继续作为共享 contract 层保留在外部；后续按 D-4 审计结果再决定是否把 agent 自有子集并回 `linnkit`
- 前端 / Electron 验收已通过，桌面主流程手测验证全绿

---

## 1. 模块定位

Layer: `backend umbrella`

本目录负责：

- 汇总后端 Agent 的真实代码树
- 提供总入口 README
- 明确后端 Agent 的层次边界与读文档顺序

本目录不负责：

- 前端对话域文档
- proposal 历史归档
- 把产品层和测试层提前强行塞进同一棵树

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
- Linnya 默认用哪些工具
- 产品上下文如何拼装

### 2.2 App Hosts

位置：

- `src/app-hosts/linnya/*`

它回答的问题是：

- Linnya 如何把 runtime、context、tools、realtime、persistence、flow 装到一起
- Linnya 默认 registry、context policy、request binding 在哪里
- 哪些测试 harness 明确依赖 Linnya 宿主装配

它不回答的问题是：

- graph loop 协议本身
- RuntimeEvent 生命周期规则本身
- ToolExecutionContext 这种 runtime 最小合同本身

### 2.3 Testkit

位置：

- `packages/linnkit/src/testkit/*`
- 公开入口：`linnkit/testkit`（**仅测试代码可 import**；`AGENT-GUARD-10-no-testkit-in-production` 强制守门，禁止生产路径引用）

这层承接：

- tool fixtures
- package-neutral harness primitives
- context harness

已外置到 Linnya app-host 的 host-bound testkit：

- `src/app-hosts/linnya/testkit/agent-harness/*`
- `src/app-hosts/linnya/testkit/persistence/*`

说明：

- `default-agent-benchmark` 明确保留在 `src/testkit/default-agent-benchmark/*`
- 它属于 Linnya 专属评测层，不纳入通用 Agent 模块

---

## 3. 大模块地图

这一节不是重复目录树，而是回答：

- 每个大模块真正负责什么
- 它和相邻模块怎么协作
- 哪些东西不要往这里塞

### 3.1 `runtime-kernel/*`

位置：

- `packages/linnkit/src/runtime-kernel/*`

这是 Agent 平台最核心的一层。它定义的不是某个产品如何接入，而是：

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
  - RunRegistryStore port + memory 实现 + contract 测试；RunSupervisor 本体待按需触发（详见 [`docs/secretary/README.md §4`](./docs/secretary/README.md)）
- `telemetry/*`
  - TelemetryPort + 4 类 kind 常量 + noop 默认实现 + contract 测试

一句话：

- `runtime-kernel` 拥有"Agent 平台如何运行"
- 不拥有"Linnya 默认怎么接"

### 3.2 `context-manager/*`

位置：

- `packages/linnkit/src/context-manager/*`
- 公开入口：`linnkit/context-manager`

这是 Agent 的通用上下文子系统，不再属于 Linnya 产品包。

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
  - chat 兼容层冻结计划详见 [`docs/secretary/README.md §4`](./docs/secretary/README.md)（linnsec 立项前 sprint 的 P1 项）

它不拥有的东西：

- Linnya 默认 task resolver
- Linnya 默认 provider registry
- Linnya 请求 schema 和 request adapter 的最终 owner
- 具体产品策略默认值

这些都应该留在 `src/app-hosts/linnya/*`。

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

### 3.4 `shared/*`

位置：

- `packages/linnkit/src/shared/*`
- **internal-only**：禁止外部 import；接入者通过 root 入口或子入口取等价能力

这是 Agent 平台自己的共享基础设施层，当前主要承接：

- `ids.ts`（同构：浏览器走 `globalThis.crypto.randomUUID()`，Node 退化路径自实现 v4，不依赖 `crypto`）
- `logger.ts`
- `TokenCalculator.ts`
- `llmTelemetryContext.ts`
- `llmAuditRecorder.ts`
- `errorClassifier.ts`

这层存在的意义是：

- 把 Agent 真正内部需要的共用能力收回 package 内
- 避免 `packages/linnkit/src/*` 继续回头依赖 `src/shared/*`

### 3.5 `testkit/*`

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

已经明确不留在这里的：

- 依赖 Linnya host runtime assembly 的 harness
- 依赖 workspace/pathManager/DB 的 fixture

这些已经外置到：

- `src/app-hosts/linnya/testkit/*`

### 3.6 `src/app-hosts/linnya/*`

位置：

- `src/app-hosts/linnya/*`

这不是 `packages/linnkit/src/*` 的一部分，但理解整体架构时必须一起看。

这里承接的是 Linnya 作为"接入方"所拥有的东西：

- `adapters/*`
  - `runtime-assembly/*`
  - `context-injection/*`
  - `flow/*`
  - `realtime/*`
  - `persistence/*`
  - `tools/*`
  - `child-runs/*`
  - 这些都是宿主实现，不是内核协议
- `agent-registry/*`
  - 具体有哪些 agent/chat/system 定义
  - promptKey 到定义的绑定
- `context/*`
  - Linnya 请求 shape、contracts、request adapters
- `context-policies/*`
  - Linnya 默认摘要/上下文策略
- `testkit/*`
  - host-bound harness 和 persistence fixtures

一句话：

- `packages/linnkit/src/*` 负责平台能力
- `src/app-hosts/linnya/*` 负责把平台接成 Linnya

---

## 4. 数据流全景

一次完整 Agent run 的数据流如下：

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

### 4.1 三种事件模型

| 模型 | 所在层 | 用途 |
|------|--------|------|
| `AnyAgentEvent` | runtime-kernel（领域事件） | graph node 内部产出的原始事件 |
| `RuntimeEvent` | runtime-kernel → host（持久化事件） | 持久化、上下文重建、history 回放的事实来源 |
| `SSEEvent` | host realtime adapter（表现层事件） | 前端实时渲染 |

转换链路：

```
AnyAgentEvent ──[eventMapper.agentToRuntime()]──▶ RuntimeEvent
                                                      │
                                                      ├──[EventBus.publish()]──▶ SsePort ──[mapToSse()]──▶ SSEEvent ──▶ 前端
                                                      │
                                                      └──[shouldPersistRuntimeEvent()]──▶ Host EventStore（当前是 Linnya EventStore）
```

### 4.2 事件生命周期治理（eventGovernance）

`eventGovernance.ts` 是事件生命周期的唯一权威入口，每个 RuntimeEvent 的 lifecycle 由以下四维决策决定：

| 维度 | 含义 |
|------|------|
| `persist` | 是否写入宿主事件存储（当前 Linnya 宿主是 `Linnya EventStore`；`ephemeral=true` 或 `tool_process` 不持久化） |
| `replayToUi` | 页面 reload 时是否从宿主事件存储回放给前端 |
| `enterAgentContext` | 是否进入 LLM 上下文窗口 |
| `realtimeChannel` | 实时通道：`event_bus_sse` 或 `none` |

关键规则：

- `final_answer_chunk`：`ephemeral=true`，不持久化，不进上下文，只走 SSE
- `tool_process`：不持久化，不进上下文，只走 SSE（中间态更新）
- `tool_output`：`ephemeral=false`，持久化，进上下文，走 SSE
- `thought`（增量）：`ephemeral=true`，不持久化
- `thought`（完成）：`ephemeral=false`，持久化，进上下文

### 4.3 存储协议

- **写入时机**：每轮 run 结束后，`FlowHostSessionService.persistRunEvents()` 一次性原子写入
- **过滤规则**：只持久化 `shouldPersistRuntimeEvent(event) === true` 的事件
- **立即持久化**：用户输入事件（user_input / tool_output from user）在 run 开始前通过 `persistImmediately()` 写入
- **stream_end**：在 `finalize()` 中单独持久化（包含 stats / metadata）
- **存储格式**：每个 conversation 由多个 run 组成，每个 run 是一组有序 RuntimeEvent

### 4.4 SSE 出口

SSE 推送的唯一出口是 `SsePort`：

1. `FlowHostSessionService` 构造时创建 `SsePort` 并 `connect(eventBus)`
2. `SsePort` 监听 `EventBus` 的 `event` 事件
3. `DefaultRuntimeEventSseMapper` 将 RuntimeEvent → SSEEvent
4. 通过 `sseSink` 函数推送给前端

禁止项：

- **禁止** 在 graph node / tool / bridge 中直接调用 sseSink 发送 SSE（`WaitUserNode` 是唯一的协议级例外，因为 `requires_user_interaction` 是暂停协议的一部分）
- **禁止** 绕过 EventBus 发送 SSE（会导致 seq 断裂和审计遗漏）
- **禁止** 在 StreamCollector 中发送 SSE（它只负责缓冲）

### 4.5 术语：两个不同的 "checkpoint"

"checkpoint" 在 agent 生态里是个被严重重载的词，本仓库里至少存在两类含义完全不同但容易混的 checkpoint，请按上下文区分：

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

1. `runtime-kernel` 不得依赖 `host-adapters`
2. `host-adapters` 可以装配 `runtime-kernel`，但不能回头定义内核协议
3. 产品语义不得重新侵入 runtime 协议
4. 历史兼容出口不得恢复成真实 owner
5. 工具可以触发 child-run，但 child-run protocol 本体属于 `packages/linnkit/src/*`

### 5.1 Package Boundary Guard

当前已落地的工程护栏：

- `npm run guard:agent-boundary`

它已升级为 **AST 级**（基于 TypeScript Compiler API 的 `ts.createSourceFile` + AST 遍历，不再用纯正则），并强制 10 条规则，其中关键 5 条：

1. `packages/linnkit/src/*` 的生产代码不得直接 import `src/app-hosts/*`
2. `packages/linnkit/src/*` 的生产代码不得直接 import `packages/linnkit/src/*` 之外的其他 `src/*` owner
3. `packages/linnkit/src/*` 的生产代码唯一允许的外部 workspace contract 是 `@app/schemas`
4. `packages/linnkit/src/host-adapters` / `packages/linnkit/src/product-extensions` 不得重新出现
5. **`AGENT-GUARD-10-no-testkit-in-production`**：生产代码（包括 root `index.ts`）禁止 import `linnkit/testkit` 或任何 `testkit/*` deep path（防止 `vitest` 等测试依赖被 esbuild/tsup 打入生产 bundle）

说明：

- 这是当前 package-boundary 的硬护栏
- `packages/schemas` 当前继续作为共享协议层保留在 `packages/linnkit/src/*` 外部
- 长远会按 D-4 审计把 agent 自有合同尽量收回 `linnkit`，但不和 Phase E 真抽包绑死

### 5.2 当前公开 API（Phase E 终态）

`packages/linnkit/package.json` 的 `exports` 字段明确定义了 6 个稳定子入口：

| 子入口 | 文件 | 用途 | 浏览器安全？ |
|--------|------|------|------------|
| `linnkit` | `./src/index.ts` | root：ports / runtimeKernel namespace / 必要 utility | ❌ Node-only |
| `linnkit/ports` | `./src/ports/index.ts` | 宿主接入 port 合同 | ❌ Node-only |
| `linnkit/contracts` | `./src/contracts/index.ts` | 长期稳定的 contract 定义 | ❌ Node-only |
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
    ├── docs/                   # engine + secretary + 99-research-notes 全部文档
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

```text
src/app-hosts/linnya/
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
  - 去 `src/app-hosts/linnya/adapters/*`
- agent definition / context strategy / concrete tools
  - 这通常还是 product 层

---

## 8. 最容易放错层的几类改动

1. 默认 ToolRegistry / default ports
   - 这是 host-adapter，不是 runtime-kernel
2. `ToolContext` 产品字段
   - 这是 tools/context/product 边界，不是 graph-engine
3. `stream_end` / SSE 行为
   - 这是 Flow host session，不是 runtime-kernel
4. child-run 的"已注册 agent 解析"
   - 这是 host adapter，不是 child-run kernel 原语

---

## 9. 当前明确不并入通用 Agent 模块的部分

这不是遗漏，而是边界选择：

- `src/testkit/default-agent-benchmark/*`
  - Linnya 专属评测层
- concrete Linnya tools
  - 当前仍按产品语义与工具族继续组织
- 前端 projection / UI 相关目录
  - 不属于后端 Agent 模块

下一阶段真正要研究的，不是"再把更多旧目录搬进来"，而是：

- 哪些 `src/app-hosts/linnya/*` 仍可继续下沉成 product-neutral shared layer
- 哪些能力应继续保留为 Linnya 专属
- chat 兼容层何时彻底冻结、统一收敛到"tools-disabled agent"形态（详见 [`docs/secretary/README.md §4`](./docs/secretary/README.md)）

---

## 10. 推荐阅读顺序

### 理解整体后端架构

1. 本文档
2. [`packages/linnkit/src/runtime-kernel/README.md`](./runtime-kernel/README.md)
3. [`src/app-hosts/linnya/adapters/flow/README.md`](../../../src/app-hosts/linnya/adapters/flow/README.md)
4. [`packages/linnkit/src/runtime-kernel/graph-engine/README.md`](./runtime-kernel/graph-engine/README.md)
5. [`packages/linnkit/src/runtime-kernel/tools/README.md`](./runtime-kernel/tools/README.md)

### 改 graph / event / tool runtime

1. [`packages/linnkit/src/runtime-kernel/graph-engine/README.md`](./runtime-kernel/graph-engine/README.md)
2. [`packages/linnkit/src/runtime-kernel/tools/README.md`](./runtime-kernel/tools/README.md)
3. [`packages/linnkit/src/runtime-kernel/README.md`](./runtime-kernel/README.md)

### 改 Flow / 持久化 / SSE / 默认装配

1. [`src/app-hosts/linnya/adapters/flow/README.md`](../../../src/app-hosts/linnya/adapters/flow/README.md)
2. [`src/app-hosts/linnya/adapters/context-injection/README.md`](../../../src/app-hosts/linnya/adapters/context-injection/README.md)
3. [`src/app-hosts/linnya/adapters/tools/README.md`](../../../src/app-hosts/linnya/adapters/tools/README.md)

---

## 11. 开发注意事项

1. 写代码前先判断 owner，不要先挑一个"顺手的旧路径"
2. 不要为了目录整齐把 product 语义硬塞进 runtime-kernel
3. 新 bridge 只能作为过渡，不能作为新开发入口
4. 修改 runtime 协议时，必须补 contract / integration tests
5. 文档必须追随真实路径，不追随历史 import 习惯
6. 前端代码**禁止**从 `linnkit/runtime-kernel`（namespace 全展开入口）import；只能从 `linnkit/runtime-kernel/events` 这个 browser-safe slim seam 取 events governance 纯函数

如果你是准备继续开发或接入，不要只看这份 README：

- 开发指南：[`packages/linnkit/src/DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md)
- 外部接入指南：[`packages/linnkit/src/INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md)

---

## 12. 文档树索引

### Runtime Kernel

- [`packages/linnkit/src/runtime-kernel/README.md`](./runtime-kernel/README.md)
- [`packages/linnkit/src/runtime-kernel/graph-engine/README.md`](./runtime-kernel/graph-engine/README.md)
- [`packages/linnkit/src/runtime-kernel/llm/README.md`](./runtime-kernel/llm/README.md)
- [`packages/linnkit/src/runtime-kernel/tools/README.md`](./runtime-kernel/tools/README.md)

### Host Adapters

- [`src/app-hosts/linnya/adapters/runtime-assembly/README.md`](../../../src/app-hosts/linnya/adapters/runtime-assembly/README.md)
- [`src/app-hosts/linnya/adapters/context-injection/README.md`](../../../src/app-hosts/linnya/adapters/context-injection/README.md)
- [`src/app-hosts/linnya/adapters/flow/README.md`](../../../src/app-hosts/linnya/adapters/flow/README.md)
- [`src/app-hosts/linnya/adapters/flow/agent-runner/README.md`](../../../src/app-hosts/linnya/adapters/flow/agent-runner/README.md)
- [`src/app-hosts/linnya/adapters/flow/run-hooks/README.md`](../../../src/app-hosts/linnya/adapters/flow/run-hooks/README.md)
- [`src/app-hosts/linnya/adapters/realtime/README.md`](../../../src/app-hosts/linnya/adapters/realtime/README.md)
- [`src/app-hosts/linnya/adapters/persistence/event-store/README.md`](../../../src/app-hosts/linnya/adapters/persistence/event-store/README.md)
- [`src/app-hosts/linnya/adapters/tools/README.md`](../../../src/app-hosts/linnya/adapters/tools/README.md)
- [`src/app-hosts/linnya/adapters/child-runs/README.md`](../../../src/app-hosts/linnya/adapters/child-runs/README.md)

### App Host

- [`src/app-hosts/linnya/README.md`](../../../src/app-hosts/linnya/README.md)
- [`src/app-hosts/linnya/agent-registry/README.md`](../../../src/app-hosts/linnya/agent-registry/README.md)
- [`src/app-hosts/linnya/context/README.md`](../../../src/app-hosts/linnya/context/README.md)
- [`src/app-hosts/linnya/context-policies/README.md`](../../../src/app-hosts/linnya/context-policies/README.md)

### Testkit

- [`packages/linnkit/src/testkit/README.md`](./testkit/README.md)
- [`packages/linnkit/src/testkit/agent-harness/README.md`](./testkit/agent-harness/README.md)
- [`packages/linnkit/src/testkit/context-harness/README.md`](./testkit/context-harness/README.md)
- [`src/app-hosts/linnya/testkit/README.md`](../../../src/app-hosts/linnya/testkit/README.md)
- [`src/app-hosts/linnya/testkit/agent-harness/README.md`](../../../src/app-hosts/linnya/testkit/agent-harness/README.md)

### Guide

- [`packages/linnkit/src/DEVELOPMENT_GUIDE.md`](./DEVELOPMENT_GUIDE.md)
- [`packages/linnkit/src/INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md)

### Engine 与 Secretary 文档（已归档/活文档）

- [`packages/linnkit/src/docs/README.md`](./docs/README.md) —— 总入口（含本目录所有文档的归档/活动状态）
- [`packages/linnkit/src/docs/00-vision-and-split.md`](./docs/00-vision-and-split.md) —— 三方边界稳定参考
- [`packages/linnkit/src/docs/engine/README.md`](./docs/engine/README.md) —— engine 升级总览（**已归档**）
- [`packages/linnkit/src/docs/engine/24-phase-e-implementation-runbook.md`](./docs/engine/24-phase-e-implementation-runbook.md) —— Phase E 终态 runbook（含 §12.2 收官期 7 项硬件加固）
- [`packages/linnkit/src/docs/secretary/README.md`](./docs/secretary/README.md) —— linnsec 立项工作面（**活文档**）

### 历史归档 Proposal

- [`docs/proposals/agent-architecture-upgrade-and-evolution-plan.md`](../../../docs/proposals/agent-architecture-upgrade-and-evolution-plan.md)
- [`docs/proposals/agent-package-boundary-extraction-proposal.md`](../../../docs/proposals/agent-package-boundary-extraction-proposal.md)
- [`docs/archive/agent-proposals/README.md`](../../../docs/archive/agent-proposals/README.md)
