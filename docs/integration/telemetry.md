# Telemetry · 接 TelemetryPort（可选）

## 1. linnkit 给你的合同

- `TelemetryPort`（来自 `@linnlabs/linnkit/runtime-kernel`，在 `telemetry` namespace 下）：`emit(event)` + 可选 `flush()`。
- `TelemetryEvent` / `TelemetryEventKind` / `TelemetryScope`（同上）：4 类 kind（`llm_call` / `tool_call` / `graph_node` / `run_lifecycle`）的事实 schema。
- `withLLMTelemetryContext`（来自 `@linnlabs/linnkit` 根入口）：把 run 作用域的 telemetry context 通过 AsyncLocalStorage 挂上去，避免跨异步边界丢 trace。

## 2. linnkit 自带的 mock primitive

- `noopTelemetry`（从 `runtimeKernel.telemetry` namespace 取）：默认无副作用实现，写测试时直接当 placeholder。
- `createMockTelemetryPort()`（来自 `@linnlabs/linnkit/testkit`）：按 `scope.runId ?? scope.turnId` 收集 telemetry，并提供可被 `RunHandle.cost()` 读取的 `RunCostCollector`。

## 3. 你必须做的

1. 决定 telemetry 落到哪：日志、指标、tracing 管道、host 自家 telemetry sink。
2. 把 `TelemetryPort` 作为可选能力接入 runtime-assembly。
3. 用 `withLLMTelemetryContext(scope, () => ...)` 把每次 run 包起来，让 LLM 调用、tool 调用都自动继承 scope。

## 4. 你不要做的

- 不要把 telemetry 直接和 UI 事件流绑死（UI 走实时通道，telemetry 走 sink）。
- 不要把 tracing id / run id 透传到模型供应商请求体里。
- 不要把"先埋点再说"的 ad-hoc 日志散在业务文件里——所有可观测点收敛进 telemetry port。

## 5. Scope 字段与父子 run

| 字段 | 何时填 |
|---|---|
| `scope.runId` | 当前 run 自己的 id（同步 child-run 应填 child run id 自己） |
| `scope.parentRunId` | 父 run 的 id（同步 child-run 必填，detached run 视场景填） |
| `scope.turnId` | host 的 turn 概念 id（推荐与 `runId` 对齐） |
| `scope.conversationId` | host 的会话/对话 id |
| `scope.traceId` | 可选；跨服务追踪 |

正确填写后，`RunCostCollector.snapshot(parentRunId)` 可以返回 `childrenTotal`，把同步子 agent 的 LLM cost 聚合到父 run。

## 6. 最小验证

- 单测：注入一个 `Array.push`-style sink，断言一次 run 里 4 类 kind 各发了至少 1 次。
- 集成测：`withLLMTelemetryContext` 内嵌的 LLM 调用拿到的 `scope` 与外层一致；并发两个 run 时 scope 不串。
- 集成测：父 agent 工具内 `invokeChildRun` → 父 run 的 `cost().childrenTotal.llmCost > 0`，且子 run 自身 cost 不重复计入父 run 的直接 cost。
