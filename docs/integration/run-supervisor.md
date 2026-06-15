# RunSupervisor · RunHandle / cost / cancel / observe

> **What** · 每次 agent 调用的"身份证 + 遥控器" —— `RunSupervisor` 注册 + `RunHandle` v2 暴露 `cancel` / `observe` / `cost` + `spawnDetached` 异步后台 run。
> **When to read** · 要支持用户取消 agent；要做长任务后台运行；要做父子 run 成本聚合；要崩溃恢复 `recoverOnBoot`。
> **Prerequisites** · [`02-quickstart.md`](./02-quickstart.md)。
> **Key exports** · `RunSupervisor` / `RunHandle` / `createInMemoryRunRegistry` from `@linnlabs/linnkit/runtime-kernel`。
> **Related** · [`child-runs.md`](./child-runs.md) · [`persistence.md`](./persistence.md) · [`audit.md`](./audit.md)

RunSupervisor 是每次 agent 调用的"身份证 + 遥控器"。host 应在一次用户请求进入 runner 前注册 run，拿到 `RunHandle` 后再把 `handle.signal` 交给 GraphExecutor / 工具上下文。

## 1. 5 行骨架

```ts
import { runtimeKernel } from '@linnlabs/linnkit';

const supervisor = new runtimeKernel.runSupervisor.DefaultRunSupervisor({
  registryStore: new runtimeKernel.runSupervisor.MemoryRunRegistryStore(),
});

const handle = await supervisor.registerRun({
  runId: turnId,                 // 推荐：host 用 turnId 对齐 RuntimeEvent / EventStore / RunRecord
  parentSignal: requestSignal,   // HTTP request cancel / 上层 run cancel 会级联到 handle.signal
  conversationId,
  agentSpec,
  request: invokeRequest,
  eventBus,
  eventStore,
  costCollector,
});
```

## 2. 接入规则

- `runId` 建议由 host 显式传入。如果 host 已有稳定的 `turnId` / request id，可以直接用 `runId = turnId`，这样 `RunHandle.observe({ includePersisted: true })` 能复用 EventStore 里的 runId 索引。
- `conversationId` 是 host 的审计/事件归属；`runId` 是本次 run 身份；`parentRunId` 只表达父子成本与审计关联。不要把 GraphExecutor 的 checkpoint key 当成这三个字段之一。
- `RunHandle.signal` 是 runner 内部唯一信号来源；不要再给 GraphExecutor 另起一根 ad-hoc `AbortController`。
- `AgentRunnerService.run()` 一类 host runner 应同步返回 `{ handle, result }`：UI 可以立刻拿 handle 做 cancel/observe/cost，执行结果继续等 `result`。
- runner 生命周期必须显式写：启动前 `markRunning()`，正常结束 `markCompleted()`，异常结束 `markFailed()`，取消由 `handle.cancel({ reason })` 写 `cancelled`。
- `WaitUserNode` 触发的 `requires_user_interaction` 是正式 pause 事实事件。事件必须带 `metadata.run_context.runId`，host runner 要把 `runUntilYield().events` 中的这类事件发布/持久化，并调用 `markAwaitingUser()`；`DefaultRunSupervisor` 也会订阅该事件作为兜底联动。这样 `supervisor.peek(runId).status` 才会从 `running` 变成 `awaiting_user`。
- `registerRun()` / `spawnDetached()` 会把 `AgentSpec` 与 request 作为注册时快照保存；`spawnDetached()` 的 executor 也读取这份快照。调用方后续修改原始对象不会改变已经注册的后台 run。
- `pause/resume/runTree/handleFailure` 仍是冷暂停/树管理/故障策略占位，调用时应抛 `NotImplementedError`，不要给假实现。

## 3. RunHandle 完整 API（截至 0.5.0）

| Method | 用途 |
|---|---|
| `runId` / `spec()` / `request()` | run 身份、对应 AgentSpec、invoke request 快照 |
| `signal` | runner 内部唯一 abort 信号；级联到 GraphExecutor 与所有 tool context |
| `cancel({ reason })` | 写 `RunRecord.status = 'cancelled'` + 触发 abort + 发 `run.cancel` audit envelope |
| `markRunning()` / `markCompleted()` / `markFailed(error)` | runner 必须显式写生命周期，否则 run 永久停在 `pending` |
| `markAwaitingUser()` | `WaitUserNode` 暂停后 host runner 调用，更新 RunRecord 到 `awaiting_user` |
| `observe(options?)` | 事件流：`includePersisted` 复用 EventStore replay，`signal` 控制订阅生命周期 |
| `cost()` | 读 `RunCostCollector.snapshot(runId)` |
| `traceContext()` | 返回 `{ runId, parentRunId?, turnId?, traceId? }`，给 telemetry / audit / child-run 派生用 |

## 4. 进程恢复（recoverOnBoot）

进程启动时建议调用 `recoverOnBoot()`，把上次进程遗留的 `pending/running/awaiting_user/paused` run 标记为 `RUN_ABANDONED`，避免管理面板里永远挂着"运行中"。

## 5. Cost 统计

`RunHandle.cost()` 只读你注入的 `RunCostCollector`。最小实现可以监听 `TelemetryPort.emit({ kind: 'llm_call', usage })`，按 `scope.runId ?? scope.turnId` 聚合 token 与 latency。

同步 child-run 场景建议把 `scope.runId` 设为 child run / subrun ID，并把 `scope.parentRunId` 设为父 run ID。这样父子 cost 可以分桶统计，父 run 的 `childrenTotal` 能覆盖同步子 agent 的 LLM cost。美元成本、quota ledger、跨进程 / detached 后台 run 的长期持久化账本属于后续阶段。

## 6. 最小验证

- 单测：显式 `runId` 注册后，`handle.runId` 和 `registryStore.load(runId)` 对齐。
- 单测：同一个 `runId` 注册两次抛 `RunAlreadyRegisteredError`。
- 单测：`parentSignal.abort('reason')` 后 `handle.signal.aborted === true`。
- 单测：`spawnDetached()` executor 收到的 `runId / parentRunId / conversationId / AgentSpec / request / metadata` 与注册时一致。
- 集成测：取消时 `RunRecord.errorIfAny.message` 能透传到你的 `stream_end.reason_message`。
