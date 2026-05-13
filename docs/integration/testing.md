# Testing · 用 testkit 测接入

> **What** · `@linnlabs/linnkit/testkit` 测试底座 —— scripted AI engine / graph loop harness / tool fixtures / replay harness / 26 条 strict invariants（15 run + 11 contextPolicy + C12 tokenizer）。
> **When to read** · 写第一个 agent 单测；要校验 `contextPolicy` 决策；要 mock LLM / tokenizer / telemetry / audit；做接入回归。
> **Prerequisites** · [`02-quickstart.md`](./02-quickstart.md)。
> **Key exports** · `createGraphLoopHarness` / `createScriptedAiEngine` / `createContextPipelineHarness` / `createRunSupervisorHarness` / `createCollectingAuditPort` / `createMockTelemetryPort` / `createMockTokenizerPort` from `@linnlabs/linnkit/testkit`。
> **Related** · [`context-engineering.md` §9.4.6](./context-engineering.md) · [`audit.md`](./audit.md) · [`telemetry.md`](./telemetry.md) · [`constraints-and-pitfalls.md`](./constraints-and-pitfalls.md)（`AGENT-GUARD-10-no-testkit-in-production`）

`@linnlabs/linnkit/testkit` 是 **package-neutral** 的测试底座。它**只**给你"linnkit 自己的合同"测试用的 primitive；不替代你的 host-bound testkit。

## 1. 两层架构

```text
第一层（linnkit 自带）：装包就有，验证 linnkit 合同
   │   create*Harness / fixture / assertions / invariants
   ▼
第二层（你自己写）：放在 app-hosts/<your-app>/testkit/* 下
   │   依赖你的默认 LlmNode / ToolManager / persistence
   ▼
host application-layer test（产品级）：跟 linnkit 没关系
```

## 2. 第一层：linnkit 内置 primitive（直接装包就有）

| primitive | 用途 |
|---|---|
| `createScriptedAiEngineHarness` | 脚本化 AI engine |
| `createGraphLoopHarness` | 把 graph loop / LlmNode / AgentEventBridge / observationPreview 装好的最小 harness |
| `createDefaultGraphExecutor` | 返回一个最小默认 `GraphExecutor`（仅测试用）|
| `createReplayHarness` | context replay harness |
| `createToolContextFixture` | 最小 `ToolExecutionContext` |
| `createRunSupervisorHarness` | 一行装配 `DefaultRunSupervisor + MemoryRunRegistryStore + EventBus + MemoryEventStore + mock cost collector` |
| `createCollectingAuditPort` | 把 `AuditEnvelope` 收进数组，支持 `assertEmitted()` / `assertEmittedInOrder()` |
| `createMockTelemetryPort` | 按 `scope.runId ?? scope.turnId` 收集 telemetry，并提供 `RunCostCollector` |
| `validateRunInvariants` / `assertRunInvariants` | 默认严格校验 15 条 run 不变量，覆盖 lifecycle / audit / telemetry / cost / EventStore / ToolCall 配对、wait-user 状态联动与 detached run 终态 |
| `assertions` namespace | 常用断言 |

```ts
import {
  createScriptedAiEngineHarness,
  createGraphLoopHarness,
  createRunSupervisorHarness,
  validateRunInvariants,
  createToolContextFixture,
  assertions,
} from '@linnlabs/linnkit/testkit';
```

## 3. 最小 run 协议测试

```ts
const harness = createRunSupervisorHarness();
const handle = await harness.registerRun({ runId: 'turn_1' });
await handle.markRunning();
await handle.markCompleted();

const report = await validateRunInvariants({
  rootRunId: handle.runId,
  runRecords: await harness.getRegisteredRuns(),
  telemetryEvents: harness.telemetry.getEvents(),
  auditEnvelopes: harness.audit.getEnvelopes(),
  getCost: (runId) => harness.telemetry.costCollector.snapshot(runId),
});
```

`validateRunInvariants` 默认开启所有 15 条不变量；想跳过特定不变量需要显式传入 `{ allowed: [...] }`。生产 CI 推荐保持默认严格。

## 4. 第二层：你自己写的 host-bound testkit

放在 `app-hosts/<your-app>/testkit/*` 下。它依赖你的默认 adapter，把第一层 harness 包一层：

- 把你的默认 `LlmNode` / `AgentEventBridge` / `observationPreview` 喂给 `createGraphLoopHarness()`
- 用你的默认 `ToolManager` 创建 host-bound `ToolRuntimeHarness`
- 用 `createRunSupervisorHarness()` 承载 supervisor/audit/telemetry，再把你的真实 graph loop 包成 `runAgentScenario()` 这类一站式 driver
- 用 in-memory 持久化 mirror 你的 SQLite/Postgres 实现，做 contract parity

linnkit 不强制你的第二层 wrapper 长什么样，只要求一条铁规：**第二层 wrapper 不能回写 `@linnlabs/linnkit` 包内**——所有依赖你自己默认 adapter 的逻辑必须留在你自己仓库。

## 5. 选择规则

- 验证 linnkit 合同（"我的 EventStore 是不是符合 port 契约？"）→ 第一层 + 你的实现做参数化
- 验证"我的宿主装配是否通了"（"我的 host 接进 graph 后能跑出 final_answer 吗？"）→ 第二层
- 验证产品功能 → host application-layer test，跟 linnkit 没关系

## 6. 三类常见场景注入

第一层支持以下三种主动注入，方便覆盖错误路径：

| 场景 | 用法 |
|---|---|
| 工具抛错 | `harness.tools.injectThrowOnce({ tool: 'echo', error: new Error('boom') })` |
| LLM 抛错 | `harness.llm.injectThrow({ step: 1, error })` |
| LLM 调用中途取消 | `harness.driver.cancelMidLlm({ step: 2, reason: 'user_aborted' })` |

跑完 scenario 后用 `assertRunInvariants(report)` 验证所有 15 条不变量都没被破坏。
