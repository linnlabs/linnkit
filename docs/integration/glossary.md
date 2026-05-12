# Glossary · 术语对照

agent 生态有几个名字相同语义不同的概念，第一次踩坑后才会意识到。先记住这几条。

## 1. "Checkpoint" 的两种含义

| 维度 | **Engine-state Checkpoint**（linnkit 拥有）| **应用层 Context Checkpoint**（你产品自有）|
|---|---|---|
| 接口 | `Checkpointer` port（`@linnlabs/linnkit/runtime-kernel`）| 不是 linnkit 接口；通常是你定义的一个 LLM tool |
| 存什么 | `EngineState`：`nodeId / pendingToolCalls / executorLocal.stepCount / local` | LLM 主动写的"阶段总结摘要" |
| 谁触发 | `GraphExecutor` 在循环内自动 save / load | LLM 模型自己在判断对话过长时主动调用工具 |
| 解决什么 | 执行控制：中断恢复、为长 run / 异步 run 铺路 | 上下文工程：压缩 LLM context window、保留语义 |
| 落到哪 | 你提供的 `Checkpointer` 适配器（SQLite/Redis/文件…）| 通常是个 RuntimeEvent，落你自己的 `EventStore` |
| linnkit 知不知道？ | 知道（公开 port）| **不知道**（产品自有）|

接入时**绝对不要**把这两件事混到一起：

- 实现 `Checkpointer` adapter 时，**只**要能 save/load `EngineState` 就够了。不要试图在里面塞"摘要 / 对话压缩"语义。
- 想做"对话太长时压缩上下文"，那是另一条产品功能：定义你自己的 LLM 工具、它的输出走你的 `EventStore`、由你自己的 context-manager pipeline 在下一轮上下文构建时识别 marker 并裁剪。

## 2. "Event" 的三层

| 名字 | 所在层 | 用途 |
|---|---|---|
| `AnyAgentEvent` | runtime-kernel 内部领域事件 | graph node 内部产出的原始事件 |
| `RuntimeEvent` | runtime-kernel → host 持久化事件 | 持久化、上下文重建、history 回放的事实来源 |
| 实时通道事件（如 SSE）| host realtime adapter | 前端实时渲染（**接入方自己负责**）|

`RuntimeEvent` 持久化由你的 `EventStore` adapter 落地；实时推送由你自己的 realtime adapter 决定。linnkit 不规定这一层。

## 3. "Fence"

| 维度 | 说明 |
|---|---|
| 什么是 fence | host 自定义的"上下文围栏家族"，把不同来源的上下文（项目元数据 / 长记忆 / 系统事件 / 子 agent 摘要 / 用户引用 / ……）按 placement + lifetime + role 组织，注入到 LLM 不同位置 |
| 谁拥有 fence kind 的命名 | host（kebab-case，如 `memory-context` / `system-event`）|
| linnkit 提供什么 | `FenceDescriptor` 声明 schema、`FenceRegistry` 容器、`FenceLifetimePreprocessor` 生命周期清理、`MustKeepPolicy` 必保留判定、`context_injection` 这类 `AiMessage.type` 稳定载体 |
| host 提供什么 | descriptors（fence 家族定义）+ injections adapter（请求字段 → `FenceInjection[]`）+ 起码一个 `FenceRegistry` 实例供 orchestrator/formatter 共用 |
| 为什么这么设计 | 同一套 host 适配能支持任意"项目上下文 / 文档片段 / 长记忆 / 子 agent 摘要 / 系统事件"的混搭，框架不需要任何改动 |

## 4. "Run" / "Turn" / "Conversation" / "Trace"

| ID | 语义 | 谁拥有 |
|---|---|---|
| `runId` | 一次 agent 执行的唯一 id；从注册到终态（completed/failed/cancelled/awaiting_user/paused）有完整生命周期 | linnkit RunSupervisor（host 可在 register 时显式传入对齐自己的 `turnId`）|
| `turnId` | host 概念：一次用户输入 → 一次 agent 回答 的轮次 id | host |
| `conversationId` | host 概念：一段连续对话 id（一个 conversation 含多个 turn / run）| host |
| `traceId` | 可选：跨服务/跨进程追踪 id（如 OpenTelemetry trace id）| host |
| `parentRunId` | 当前 run 的父 run id（同步 child-run / detached spawned run 都会用）| linnkit RunSupervisor |

**推荐做法**：`runId = turnId`。这样 `RuntimeEvent.metadata.run_context.runId` 在 host 的 EventStore 里有现成索引，`RunHandle.observe({ includePersisted: true })` 可以直接 replay。

## 5. "Subrun" / "Child-run" / "Internal Agent"

linnkit 0.5.0 起统一术语：

| 概念 | 用什么 |
|---|---|
| 父 agent 调用子 agent 这件事 | **child run**（公开 namespace：`runtimeKernel.childRunTrace`）|
| 子调用的观测协议（前端 trace UI 用）| 事件 type 仍叫 `subrun_trace`（向后兼容）|
| 子调用的"调用器"组件 | `ChildRunInvoker`（内部代码命名）|

**不要**在新代码里用 `subrun` 或 `internalAgent` 作为新命名——它们是历史遗留。
