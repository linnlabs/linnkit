# Realtime · 实时通道（host 完全自有）

> **What** · 实时通道（SSE / WebSocket / IPC）接入 —— `RuntimeEvent` 映射到 host 自己的 wire 协议；前端用 browser-safe events seam 做事件治理决策。
> **When to read** · 要把 agent 进度推到前端；做 daemon ↔ renderer IPC；做 Web SSE；想知道"哪些事件该回放给 UI / 哪些只该写 EventStore"。
> **Prerequisites** · [`02-quickstart.md`](./02-quickstart.md)；浏览器使用规则见 [`README §5`](./README.md)。
> **Key exports** · `RuntimeEvent` / `EventEnvelope` / `SSEEvent` from `@linnlabs/linnkit/contracts` · `shouldReplayRuntimeEventToUi` / `shouldEmitRuntimeEventToSse` / `getRuntimeEventUiProjectionKind` from `@linnlabs/linnkit/runtime-kernel/events`（**前端唯一可 import 的入口**）。
> **Related** · [`audit.md`](./audit.md) · [`persistence.md`](./persistence.md) · [`constraints-and-pitfalls.md`](./constraints-and-pitfalls.md)

`@linnlabs/linnkit` **不规定** SSE / WebSocket / MQTT 的接口形状——一个原因是不同部署形态（HTTP server / Electron IPC / 内嵌 RPC）天差地别。

但有两条**铁规**：

1. **唯一出口原则**：所有实时事件必须经由你自己的 EventBus → realtime adapter 单一路径推给前端。**禁止**在 graph node / tool / bridge 中直接调用 sink 推送实时事件（`WaitUserNode` 是唯一的协议级例外，它发出 `requires_user_interaction` 是暂停协议的一部分）。
2. **不要绕过 EventBus 写**：会导致 seq 断裂和审计遗漏。

## 1. 事件转换链路

```text
graph 内部 AnyAgentEvent
  │  eventMapper.agentToRuntime()      ← 来自 @linnlabs/linnkit/runtime-kernel/events
  ▼
RuntimeEvent
  │  shouldEmitRuntimeEventToSse(event)  ← 你的实时 adapter 决定
  ▼
你的 SSEEvent / WS message / IPC payload
```

## 2. eventGovernance 决策函数（前端可用）

事件**生命周期治理**统一走 `eventGovernance` 纯函数：

| 函数 | 用途 |
|---|---|
| `shouldPersistRuntimeEvent` | 是否写入 host EventStore（`ephemeral=true` 或 `tool_process` 不持久化） |
| `shouldReplayRuntimeEventToUi` | 页面 reload 时是否从 EventStore 回放给前端 |
| `shouldEnterAgentContext` | 是否进入 LLM 上下文窗口 |
| `shouldEmitRuntimeEventToSse` | 是否走实时通道 |
| `getRuntimeEventUiProjectionKind` | UI 投影类别（不同 kind 走不同前端组件） |

这些函数都在 `@linnlabs/linnkit/runtime-kernel/events` slim seam，**浏览器安全**。前端 renderer / 任意 browser bundle 都可直接 import。

```ts
// renderer/src/agentEventPolicy.ts
import {
  shouldReplayRuntimeEventToUi,
  getRuntimeEventUiProjectionKind,
} from '@linnlabs/linnkit/runtime-kernel/events';
import type { RuntimeEvent } from '@linnlabs/linnkit/contracts';
```

## 3. 三种事件模型

| 模型 | 所在层 | 用途 |
|------|--------|------|
| `AnyAgentEvent` | runtime-kernel（领域事件）| graph node 内部产出的原始事件 |
| `RuntimeEvent` | runtime-kernel → host（持久化事件）| 持久化、上下文重建、history 回放的事实来源 |
| 实时通道事件（如 SSE）| host realtime adapter（表现层事件）| 前端实时渲染（**接入方自己负责**）|

`RuntimeEvent` 持久化由你的 `EventStore` adapter 落地；实时推送由你自己的 realtime adapter 决定。linnkit 不规定这一层。

## 4. 几个常见事件的处置 cheatsheet

| RuntimeEvent | persist | replayToUi | enterAgentContext | realtime |
|---|---|---|---|---|
| `final_answer_chunk` | ✗（ephemeral）| ✗ | ✗ | ✓ |
| `final_answer` | ✓ | ✓ | ✓ | ✓ |
| `tool_process` | ✗ | ✗ | ✗ | ✓ |
| `tool_output` | ✓ | ✓ | ✓ | ✓ |
| `thought`（增量）| ✗ | ✗ | ✗ | ✓ |
| `thought`（完成）| ✓ | ✓ | ✓ | ✓ |
| `tool_call_decision` | ✓ | ✓ | ✓ | ✓ |
| `requires_user_interaction` | ✓ | ✓ | ✗ | ✓ |
| `stream_end` | ✓ | ✓ | ✗ | ✓ |
| `audit_envelope` | ✓ | ✗ | ✗ | ✗ |

实际决策一律以 `shouldXxxRuntimeEvent()` 函数返回值为准；这张表只是速查。
