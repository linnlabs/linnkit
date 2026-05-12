# `@linnlabs/linnkit` Integration Guide

这是 `@linnlabs/linnkit` 的**接入文档集**——回答一件事：

> 你在自己的仓库装了 `@linnlabs/linnkit`，要把一个 Agent 跑起来，至少要写什么、应该从哪里开始抄。

**读者画像**：在外部独立仓库（如 daemon、桌面应用、Web 服务、知识库 agent 或任意自研 agent host）通过 `npm install @linnlabs/linnkit` 装包，准备从零接入的开发者。

---

## 1. 它是什么

`@linnlabs/linnkit` 是 **vendor-neutral 的 Agent 框架**：它只提供 runtime kernel + context manager + ports + testkit，**不内置任何具体业务实现**。

一句大白话：

> 你装的这个包负责"agent 怎么跑、上下文怎么治理"，不负责"用哪个 LLM 提供商、工具集长什么样、消息怎么落库、SSE 怎么推、产品里有哪些 agent"。这些通通是你（host）要自己写的。

## 2. 你必须自己写的（接入面）

按重要度排序：

| 你必须自己写的 | linnkit 给的接入合同（type/symbol）| 从哪里 import |
|---|---|---|
| 1. LLM provider 适配器 | `AgentAiEngine` | `@linnlabs/linnkit/ports` |
| 2. 工具集 | `BaseTool` / `ToolRuntimePort` | `@linnlabs/linnkit/runtime-kernel` |
| 3. 上下文围栏（fence）注册 + 注入适配 | `FenceRegistry` / `FenceDescriptor` / `FenceInjection` / `MustKeepPolicy` / `FenceLifetimePreprocessor` | `@linnlabs/linnkit/context-manager` |
| 4. 持久化适配器 | `Checkpointer` / `EventStore` / `RunRegistryStore` | `@linnlabs/linnkit/runtime-kernel` |
| 5. 实时通道（SSE/WebSocket/MQTT）| linnkit 不规定接口；从 `RuntimeEvent` 自己映射 | `@linnlabs/linnkit/contracts` |
| 6. graph executor 装配 + 默认 LLM/Tool node | `runtimeKernel.graph.GraphExecutor` 等 | `@linnlabs/linnkit/runtime-kernel` |
| 7. agent / chat / task 注册表 | `promptKey` 是 opaque string，linnkit 不认识你的产品菜单 | （host 自定义）|
| 8.（可选）telemetry | `TelemetryPort` | `@linnlabs/linnkit/runtime-kernel` |

## 3. 推荐目录形态（host 仓库内）

```text
app-hosts/<your-app>/
├── adapters/
│   ├── runtime-assembly/   # 把 GraphExecutor / LlmNode / ToolRuntime 拼起来
│   ├── context-injection/  # context builder + 注入 host 请求字段为 fences
│   ├── flow/               # history 读取 / pre-run policy / host session
│   ├── realtime/           # SSE / WebSocket / MQTT
│   ├── persistence/        # Checkpointer / EventStore / RunRegistryStore 实现
│   └── tools/              # 默认 ToolManager 装配
├── agent-registry/         # 你的 agent / chat / system 定义
├── context/
│   ├── agent/              # host invoke request shape + fence 注册 + injection adapter
│   └── chat/               # （只在你还要兼容 chat 时需要）
├── context-policies/       # MustKeepPolicy / provider registry / 截断比例
└── testkit/                # host-bound harness（依赖你的默认 adapter）
```

这是建议而不是强制。下面的术语全部按这个分层取名。

## 4. 公开 API surface（7 个稳定子入口）

`package.json#exports` 写死的子入口当前是 7 个。任何不在这张表里的"deep import"（比如 `@linnlabs/linnkit/context-manager/shared/preprocessors/...`）都不算公开 API，下个 minor 升级随时可能挪。

| 子入口 | 适用环境 | 你能从这里 import 到什么 |
|---|---|---|
| `@linnlabs/linnkit` | **Node-only** | `runtimeKernel` / `ports` / `contracts` 三个 namespace；`generateMessageId` / `generateRunId` / `withLLMTelemetryContext` / `setLlmAuditRecorder` |
| `@linnlabs/linnkit/ports` | **Node-only** | `AgentInvocationRequest` / `AgentAiEngine` / `AgentAiEngineStreamContent` / `LlmCallOptions` / `LlmRequestMessage` / `ToolCall` 等 host 必须实现的合同 |
| `@linnlabs/linnkit/contracts` | **Node-only** | 长期稳定的合同：`AiMessage` / `SystemMessage` / `UserMessage` / `AssistantMessage` / `ToolMessage` / `RuntimeEvent` / `EventEnvelope` / `SSEEvent` / 默认执行常量 |
| `@linnlabs/linnkit/runtime-kernel` | **Node-only**（含 `node:async_hooks` / `crypto`）| 全套 runtime：`graph` / `tools` / `execution` / `events` / `runContext` / `llm` / `childRuns` / `childRunTrace` / `runSupervisor` / `telemetry` 等 namespace + 扁平 `BaseTool` / `ToolExecutionContext` / `ENGINE_ERROR_CODES` 等符号 + `createGraphLoopHarness` / `createDefaultGraphExecutor`（仅测试用）|
| `@linnlabs/linnkit/runtime-kernel/events` | **浏览器安全** | events governance 纯函数：`shouldPersistRuntimeEvent` / `shouldEnterAgentContext` / `shouldEmitRuntimeEventToSse` / `shouldReplayRuntimeEventToUi` / `getRuntimeEventUiProjectionKind` / `eventMapper`，外加 `AnyAgentEvent` / `RuntimeEventLifecycleDecision` 类型 |
| `@linnlabs/linnkit/context-manager` | **Node-only** | context core：`createMessageFormatter` / `formatAgentLlmMessages` / `messageFormatter` / `createFenceRegistry` / `FenceDescriptor` / `FenceInjection` / `FenceRegistry` / `FenceLifetimePreprocessor` / `MustKeepPolicy` / `DEFAULT_MUST_KEEP_POLICY` / `BaseContextProvider` / `AGENT_CONSTANTS` / agent profile namespace。chat 兼容层只剩下少量扁平导出（`ChatMessageOrchestrator` / `BaseConversationalTask` / `chatMessageToAiMessage` 等），新接入方应只用 agent profile + fence 机制 |
| `@linnlabs/linnkit/testkit` | **测试专用** | scripted AI engine harness、graph loop harness、tool context fixture、replay harness、断言、`createRunSupervisorHarness` / `createCollectingAuditPort` / `createMockTelemetryPort` / 15 条 run 不变量校验。`AGENT-GUARD-10-no-testkit-in-production` 强制守门——生产代码不能 import |

## 5. 浏览器使用规则（硬约束）

**前端代码（renderer / browser bundle）禁止 import `@linnlabs/linnkit/runtime-kernel`**——这条入口是 namespace 全展开，会把 `node:async_hooks` / `crypto` 等 Node-only 子树拖进 frontend bundle。

前端如果只是要做事件展示决策（"这条 RuntimeEvent 该不该回放给 UI？"），从 **`@linnlabs/linnkit/runtime-kernel/events`** 这个 slim seam 取纯函数：

```ts
// renderer/src/agentEventPolicy.ts
import {
  shouldReplayRuntimeEventToUi,
  getRuntimeEventUiProjectionKind,
} from '@linnlabs/linnkit/runtime-kernel/events';
import type { RuntimeEvent } from '@linnlabs/linnkit/contracts';
```

`@linnlabs/linnkit/contracts` 是纯 zod schema + 类型，技术上前端也可 import；但 zod 体积非零，前端按需。

## 6. import 选择决策

```text
要决定一条 import 应该走哪个子入口？
├── 我在前端 bundle 里？
│   └── 是 ──▶ 只能是 /runtime-kernel/events 或 /contracts
├── 我在测试代码里？
│   └── 是 ──▶ 可以 /testkit；其它子入口照常用
├── 我要类型/合同？
│   └── 是 ──▶ /ports（host 实现合同）或 /contracts（消息/事件合同）
├── 我要 context 和 fence 机制？
│   └── 是 ──▶ /context-manager
└── 其它（runtime 装配、graph、tool runtime、LLM caller 骨架）─▶ /runtime-kernel
```

不要 `import { something } from '@linnlabs/linnkit/runtime-kernel/<deep>'`。`exports` 字段没声明的路径在 Node 16+ ESM 解析下会直接报错，且任何 deep path 都不在稳定 API 范围。

---

## 7. 文档索引

### 7.1 起步必读（按顺序）

| # | 文档 | 内容 |
|---|------|------|
| 1 | 本文 §1-§6 | 它是什么 / 你要写什么 / 7 个公开 API 子入口 / 浏览器规则 |
| 2 | [installation.md](./installation.md) | 装包 / `.npmrc` 鉴权 / 验证 |
| 3 | [quickstart.md](./quickstart.md) | 5 分钟最小 host 骨架 |

### 7.2 单点接入（按你需要的功能查）

| 主题 | 文档 |
|------|------|
| 接 LLM provider（OpenAI / Anthropic / DeepSeek / OpenRouter）| [llm-provider.md](./llm-provider.md) |
| 注册工具集 / 配置超长 observation 落盘路径 | [tools.md](./tools.md) |
| **上下文工程总览**（所有作用在 messages 上的机制 + `contextPolicy` / `ContextTrace` 可观测闭环）⭐ | [context-engineering.md](./context-engineering.md) |
| **接 context engineering（fence 注册 + 注入）⭐ 一等接入面** | [context-fences.md](./context-fences.md) |
| 配置工具历史压缩策略（per-pair / per-run / none）| [tool-history.md](./tool-history.md) |
| 接持久化（Checkpointer / EventStore / RunRegistryStore）| [persistence.md](./persistence.md) |
| 接 RunSupervisor + RunHandle | [run-supervisor.md](./run-supervisor.md) |
| 同步嵌入 vs 异步后台子 agent | [child-runs.md](./child-runs.md) |
| 接 AuditPort（决策账本）| [audit.md](./audit.md) |
| 接 telemetry | [telemetry.md](./telemetry.md) |
| 实时通道（SSE / WebSocket / IPC）| [realtime.md](./realtime.md) |

### 7.3 测试 / 边界 / 速查

| 主题 | 文档 |
|------|------|
| 测试与 testkit（两层架构）| [testing.md](./testing.md) |
| 硬约束 + 不建议做的事 + FAQ | [constraints-and-pitfalls.md](./constraints-and-pitfalls.md) |
| 术语对照（Checkpoint / Event / Fence 的不同含义）| [glossary.md](./glossary.md) |

### 7.4 推荐阅读顺序

**第一次接入（最少 30 分钟）**：

1. 本文 §1-§6 → 先把"我装了啥、它给我啥"看清
2. [installation.md](./installation.md) → 装包鉴权跑通 smoke
3. [quickstart.md](./quickstart.md) → 写一个能跑的最小骨架
4. [context-engineering.md](./context-engineering.md) ⭐ → **第一周必读 · 鸟瞰**：所有作用在 messages 上的机制是什么、如何声明 `contextPolicy`、如何用 `ContextTrace` 解释最终 token 决策
5. [context-fences.md](./context-fences.md) ⭐ → **第一周必读 · 实操**：fence 注册与注入是 linnkit 一等接入面
6. 按需读单点接入文档

**续作（按需）**：

- 写测试 → [testing.md](./testing.md)
- 上线前 → [constraints-and-pitfalls.md](./constraints-and-pitfalls.md) + [glossary.md](./glossary.md)

---

## 8. 当前版本与稳定性

- 当前版本：以 `package.json#version` 为准
- 0.x = pre-release 期：**任何加 export / 改既有签名都 bump minor**，patch 兼容
- 7 个稳定子入口已在 `package.json#exports` 锁定；任何 deep import 都不在稳定面
- 详见 `docs/release/RELEASE.md`

---

## 9. 与其他文档的关系

- **包根 [README.md](../../README.md)**：包级总览（一句话价值 + 装包 + 文档枢纽）
- **[docs/README.md](../README.md)**：框架总览（运行时分层、数据流、术语速查）
- **[docs/release/](../release/)**：发版流水 + 历次发版叙事
- **本目录**：接入手册（你正在读的）

> ℹ️ **关于内部开发文档**：framework 演进路线图 / ADR 决策档案 / 隐患台账等**不在 npm tarball 里**——它们是 linnkit 维护方的工作档案。如果你想参与 linnkit 开发（不是接入），看仓库 `docs/framework/` + `docs/DEVELOPMENT_GUIDE.md`。
