# Testing · 用 testkit 测接入

> **What** · `@linnlabs/linnkit/testkit` 测试底座 —— graph scenario（真实 Graph + 脚本模型 / 工具 / 插话）/ scripted canonical inference / graph loop harness / tool fixtures / replay harness / strict invariants（15 run + 11 contextPolicy + C12 tokenizer + 5 steering）。
> **When to read** · 写第一个 agent 单测；要校验 `contextPolicy` 决策；要 mock LLM / tokenizer / telemetry / audit；做接入回归。
> **Prerequisites** · [`02-quickstart.md`](./02-quickstart.md)。
> **Key exports** · `createGraphScenario` / `createScriptedToolRuntime` / `createPendingUserInputQueue` / `createRuntimeEventRecorder` / `formatRuntimeTimeline` / `assertSteeringInvariants` / `createGraphLoopHarness` / `createScriptedInferenceHarness` / `createContextPipelineHarness` / `createRunSupervisorHarness` / `createCollectingAuditPort` / `createMockTelemetryPort` / `createMockTokenizerPort` from `@linnlabs/linnkit/testkit`。
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
| `createGraphScenario` | 在内存里跑真实 Graph（LlmNode / ToolNode / WaitUserNode、事件总线、持久化队列、JSON 往返断点），模型、工具、插话用脚本代替；见 §2.1 |
| `createScriptedInferenceHarness` | 脚本化 canonical inference port：回合表或按请求决定回合的函数；`assertCall` 可异步，用来断言请求或在这次调用进行中触发动作；`getInferencePort()` 交给 Host 自己的装配 |
| `createScriptedToolRuntime` | 按名字写工具脚本，得到真实 `ToolRuntimePort`；返回 `{ error }` 是工具报错，抛错是端口失败 |
| `createPendingUserInputQueue` | 内存版 `PendingUserInputPort`（submit / withdraw / drain） |
| `createRuntimeEventRecorder` | 正式 `EventSequencer + EventBus + RuntimeEventPublisher` 发布链，并按顺序记下总线事件 |
| `formatRuntimeTimeline` / `formatModelMessages` | 把事件 / 一次模型调用的消息写成一行一个的可读时间线，用于整体断言和失败现场 |
| `validateSteeringInvariants` / `assertSteeringInvariants` | 运行中插话的 5 条不变量（S1–S5），按模型实际收到的消息判断 |
| `createGraphLoopHarness` | 装配 graph loop / LlmNode factory / observationPreview 的最小 harness；`runtimeEventSink` 必须由调用者提供 |
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
  createScriptedInferenceHarness,
  createGraphLoopHarness,
  createRunSupervisorHarness,
  validateRunInvariants,
  createToolContextFixture,
  assertions,
} from '@linnlabs/linnkit/testkit';
```

### 2.1 用场景写 Graph 测试

一个场景就是一段会话：可以连续开多次运行，在模型调用或工具执行的任意时刻插话、暂停、取消，最后看时间线与不变量。

```ts
const scenario = createGraphScenario({
  model: [
    { toolCalls: [{ name: 'search', arguments: { q: 'x' } }] },
    { contentChunks: ['done'] },
  ],
  tools: { search: () => { scenario.steer('只看今年的'); return 'found 3'; } },
});

const run = await scenario.start('查一下 X');     // { status: 'yielded', undeliveredSteers: [] }
expect(await scenario.timeline()).toEqual([
  'user "查一下 X"',
  'call search#call_1_1',
  'result search#call_1_1 success "found 3"',
  'steer "只看今年的"',
  'answer "done"',
]);
await scenario.assertInvariants();                // 插话不变量 + 历史 id 唯一
```

- 运行结果以状态返回（`yielded / awaiting_user / paused / cancelled / failed`），失败不打断测试，适合随机组合；`undeliveredSteers` 是运行停下时 Host 收回的插话。
- `pause()` 后用 `continue()` 从断点继续；`beforeCheckpointWrite` 抛错即模拟存储失败；`history` 选项预置会话里已有的历史。
- 默认用 Agent profile 把历史转成模型消息；需要特殊 Prompt 或 `outputProcessor` 时传 `contextBuilder`。
- Host 有自己的运行装配（持久化、实时通道、插话登记）时，用 `getInferencePort()`、`createScriptedToolRuntime()` 和 `assertSteeringInvariants()` 接进自己的第二层 harness，不必复制这些脚本。

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

- 把你的默认 `LlmNode` factory / `ToolRuntimePort` / `observationPreview` 与显式 `runtimeEventSink` 喂给 `createGraphLoopHarness()`
- 用你的默认 `ToolManager` 创建 host-bound `ToolRuntimeHarness`
- 用 `createRunSupervisorHarness()` 承载 supervisor/audit/telemetry，再把你的真实 graph loop 包成 `runAgentScenario()` 这类一站式 driver
- 用 in-memory 持久化 mirror 你的 SQLite/Postgres 实现，做 contract parity

linnkit 不强制你的第二层 wrapper 长什么样，只要求一条铁规：**第二层 wrapper 不能回写 `@linnlabs/linnkit` 包内**——所有依赖你自己默认 adapter 的逻辑必须留在你自己仓库。

Graph 测试的 `runtimeEventSink` 也必须复用正式 `EventSequencer + EventBus + RuntimeEventPublisher` admission 模型。harness 不提供默认 run identity；直接返回 draft、只调用 `routeRuntimeEvent` 的简化 sink，或从 realtime callback 回收事实，都会让测试验证另一套不存在于生产的协议。

Child-run 的 host-bound harness 还必须装配真实 lifecycle，不能让 `ChildRunInvoker` 在测试中自行创建身份或 trace 旁路。涉及 child/parent 数据流时，业务测试至少同时验证：child EventStore 能按 child run 重放正式事实、parent EventStore 能按父工具读取 trace、两者以 `source_event_id` 一一关联，以及 persistence / parent projection 失败时 child 不会进入 `completed`。只断言 trace publisher 被调用，无法证明事实所有权、持久化和终态是一致的。

并发 child 测试应让两个 child 使用不同的全局 `answer_id`，但可以产生相同的 `seq / 正文`，再证明它们仍按 `parent_run_id + parent_tool_call_id + subrun_id` 隔离。该测试必须同时证明分区依赖正式路由身份，而不是文本差异或 `answer_id` 偶然不碰撞。涉及产品副作用时，还应注入冲突或错误 metadata，证明目标归属来自共享 DTO 与正式事件 ID，而不是开放扩展字段。按文本去重、锁 mock 调用次数或只断言字段存在都不能替代这些业务证据。

运行身份隔离与 runtime 实例隔离是两种不同测试。前者在同一个 scope 内并发多个 child；后者必须创建两套完整 scope，并证明 EventStore、RunSupervisor、Audit、CostCollector 与递归 ToolContext capability 都不跨域。只重置全局 singleton 后复跑同一 fixture，无法证明旧 invoker 没有捕获上一套依赖。

会执行产品工具的 child harness 还必须使用该产品已有的正式 fixture 注入 storage / registry / host port，并为可见 child 提供 `runId + parentToolCallId + createSubRunTracePublisher`。禁止手工拼一个缺 capability 的 `ToolContext`，也禁止因为测试缺端口而放宽生产入口；嵌套 child 测试应证明这些 host capability 能进入 child ToolContext，并由内层工具继续使用。

## 5. 选择规则

- 验证 linnkit 合同（"我的 EventStore 是不是符合 port 契约？"）→ 第一层 + 你的实现做参数化
- 验证"我的宿主装配是否通了"（"我的 host 接进 graph 后能跑出 final_answer 吗？"）→ 第二层
- 验证产品功能 → host application-layer test，跟 linnkit 没关系
- 验证 HITL/并发隔离 → host application-layer test 应覆盖 foreground 等待、auxiliary 并行完成、响应落盘失败可重试、重复提交拒绝、terminal checkpoint 清理；不要用组件快照或字段存在性测试替代这条业务链。
- 验证 child/parent trace → host application-layer test 应覆盖 child durable fact、parent durable read model、source identity、双 child scope 隔离和终态失败传播；不要用文本去重或 mock 调用次数替代。
- 验证 Host 装配生命周期 → 两套 runtime scope 并发执行，分别从正式 Store 与 Supervisor 读取业务结果；生产和 fixture 都必须显式注入 child invoker，禁止测试走注入而生产走 fallback。

## 6. 三类常见场景注入

第一层支持以下三种主动注入，方便覆盖错误路径：

| 场景 | 用法 |
|---|---|
| 工具报错 / 端口抛错 | 工具脚本返回 `{ error }`（模型看到错误结果）/ 直接抛错（运行失败） |
| LLM 失败终态 | scripted turn 传入 `failure: { kind, code, retryable }` |
| LLM 事件后中断 | scripted turn 传入 `throwAfterEvents`，验证截断 stream |
| 某一时刻插话、暂停、取消 | 在 scripted turn 的 `assertCall` 或工具脚本里调用 `scenario.steer() / pause() / cancel()` |

跑完 scenario 后用 `assertRunInvariants(report)` 验证所有 15 条不变量都没被破坏。
