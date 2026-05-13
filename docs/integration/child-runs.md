# Child Runs · 同步嵌入 vs 异步后台子 agent

> **What** · 两种子 agent 调用形态 —— `invokeChildRun`（同步嵌入，父 agent 等结果）vs `spawnDetached`（异步后台，立刻返回 `RunHandle`）。
> **When to read** · 多 agent 协作；要在一个 agent 里调另一个 agent；想做后台调度 / 长任务 / 通知触发。
> **Prerequisites** · [`run-supervisor.md`](./run-supervisor.md)。
> **Key exports** · `invokeChildRun` / `spawnDetached` from `@linnlabs/linnkit/runtime-kernel`。
> **Related** · [`run-supervisor.md`](./run-supervisor.md) · [`agent-registration-guide.md` §6](./agent-registration-guide.md) ⭐

linnkit 提供**两条 API**承载"子 agent"概念。它们不是配置开关，是两种本质不同的调用形态——按需选用。

## 1. 概念对照

| API | 场景 | 语义 |
|---|---|---|
| `toolContext.invokeChildRun(...)` | 父 agent 工具内**同步调用**子 agent | 父等待子完成；用于 deep search / task subagent 这类嵌入式执行 |
| `runSupervisor.spawnDetached(...)` | 顶层后台任务、定时任务、wake hook、在线秘书 | 立刻返回 handle；调用方后续 `peek / waitForTerminal / cancel / drain` |

## 2. 何时用同步 `invokeChildRun`

适合场景：

- 子 agent 是**父 agent 工具的实现细节**（"调用搜索 agent → 取结果作为本工具的 observation"）
- 调用方需要立刻拿到子 agent 的结构化输出来决定下一步
- 子 agent 的成本/取消语义跟父 agent 绑死（取消父则子必停）

调用形态：在父 agent 的某个工具实现里调 `toolContext.invokeChildRun(spec)`。返回值是 child run 的最终输出，且 child run 内的 LLM cost / tool cost 会自动归到父 run 的 `childrenTotal`。

## 3. 何时用异步 `spawnDetached`

适合场景：

- 任务由**外部触发器**（HTTP / cron / wake hook / 用户在前端点了"启动一个后台代办"）触发
- 调用方**不阻塞**等待结果——立刻拿 handle 用于 cancel / observe / cost
- 子 agent 与父 agent 的生命周期解耦（子 agent 失败不直接导致父 agent 失败）

骨架：

```ts
const supervisor = new runtimeKernel.runSupervisor.DefaultRunSupervisor({
  registryStore,
  executor: {
    async execute(ctx) {
      // 这里接你自己的 GraphExecutor / daemon runner。
      // ctx.signal、ctx.eventBus、ctx.eventStore、ctx.costCollector 都来自 register spec。
      await runYourAgent(ctx);
      return {
        runId: ctx.runId,
        status: 'completed',
        completedAt: Date.now(),
      };
    },
  },
});

const handle = await supervisor.spawnDetached({
  conversationId,
  agentSpec,
  request,
  eventBus,
  eventStore,
  costCollector,
  wakeSource: 'cron',
  iterationBudget: { max: 20, refundable: true },
});

const outcome = await supervisor.waitForTerminal(handle.runId);
```

`spawnDetached` 与 `registerRun + 自己跑` 等价，但显式告诉 supervisor"这不是同步等结果的 run"——`RunRegistrationSpec.wakeSource` / `iterationBudget` / `ephemeral` 等字段都在这里生效。

## 4. 命名注意

- 公开 namespace：`runtimeKernel.childRunTrace`（含 `subrun_trace` 观测协议 publisher 与合同）。
- 事件 type 仍叫 `subrun_trace`（前端可继续按这个名字处理）。
- 内部目录是 `child-run-trace/`；外部消费者一律走公开 namespace。

## 5. 关键边界

- **不要**把 `invokeChildRun` 当成"小一号的 run"——它本质上是父 run 内部的一个嵌入式调用，与父 run 共享 abort signal、cost 聚合、enrichment registry。
- **不要**把 `spawnDetached` 用于工具调用流（HTTP 端到端响应里不应该等 spawnDetached 完成）——那是 invokeChildRun 的场景。
- 父子 run 的 cost 通过 `scope.parentRunId` 关联；如果你的 telemetry adapter 没把 `parentRunId` 透传到 sink，那 `childrenTotal` 字段就是 0。

## 6. 最小验证

- 单测：父 agent 工具内 `invokeChildRun` → 父 run 的 `cost().childrenTotal.llmCost > 0`
- 单测：`spawnDetached` 立刻返回；`waitForTerminal` 在执行结束后 resolve 出最终 status
- 单测：`spawnDetached` 中的 run 被 `cancel()` 后，executor 收到的 `ctx.signal.aborted === true`
