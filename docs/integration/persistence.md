# Persistence · 接持久化（3 个 port）

> **What** · 三个持久化适配 port —— `Checkpointer`（断点续推）/ `EventStore`（事件归档）/ `RunRegistryStore`（run 元数据）。
> **When to read** · 要让 run 跨进程崩溃后恢复；要审计 / 回放 agent 历史；要把 in-memory 默认实现换成真实 DB。
> **Prerequisites** · [`02-quickstart.md`](./02-quickstart.md)；建议与 [`run-supervisor.md`](./run-supervisor.md) 并读。
> **Key exports** · `Checkpointer` / `EventStore` / `RunRegistryStore` from `@linnlabs/linnkit/runtime-kernel`。
> **Related** · [`run-supervisor.md`](./run-supervisor.md) · [`audit.md`](./audit.md) · [`realtime.md`](./realtime.md) · [`glossary.md`](./glossary.md)

> **术语提醒**：这里的 `Checkpointer` 是 **engine-state checkpoint**——保存 graph engine 执行状态（`nodeId / pendingToolCalls / executorLocal.stepCount / local`），用来"中断后从断点继续推理"。它**不是**任何"对话总结/上下文裁剪"语义；后者是上下文工程层面的 RuntimeEvent，应当走你自己的 `EventStore`，跟本接口无关。详见 [glossary.md](./glossary.md)。

## 1. linnkit 给你的合同

- `Checkpointer`（来自 `@linnlabs/linnkit/runtime-kernel`，在 `graph` namespace 下）：`load` / `save` / `clear` 三个必需方法 + `peekMeta` / `list` 两个可选。
- JSON 持久化 adapter 使用 `graph.parseEngineCheckpoint` 解析读取结果，校验版本、执行位置、预算与事件合同并拒绝序列化能力对象；不能把 JSON 直接断言为 EngineState。Graph result 的 `stepCount` 是本 execution 增量，checkpoint `executorLocal.stepCount` 才是 durable run 的累计值；已 yielded 的继续返回零增量。
- `Checkpointer` 的 key 参数叫 `checkpointKey`：它是 EngineState 快照索引。所有可独立运行的顶层、foreground、auxiliary、detached run 都必须使用稳定 `runId`；同步 child-run 使用自己的内部 run-scoped key。禁止用 `conversationId`，否则同会话并行 run 会互相覆盖。
- `EventStore`（来自 `@linnlabs/linnkit/runtime-kernel`，在 `graph` namespace 下）：`append` / `range` / `latestEventStoreId` 三个必需 + `truncate` 可选。配套 `createMonotonicEventStoreIdFactory()` 帮你生成单调 storage cursor。
- `RunRegistryStore`（来自 `@linnlabs/linnkit/runtime-kernel`，在 `runSupervisor` namespace 下）：run lifecycle 元数据落库。
- `RuntimeEvent` / `RoutedRuntimeEvent` / `EventEnvelope` / `PersistedEvent` 类型来自 `@linnlabs/linnkit/contracts` 与 `runtime-kernel`。

## 2. linnkit 自带的 mock primitive

`memoryCheckpointer` / `memoryEventStore` / `memoryRunRegistryStore` 都是 in-memory contract-test 用实现。它们藏在 runtime-kernel 内部，外部消费者一般不需要直接引用——通过 `@linnlabs/linnkit/runtime-kernel` 的 namespace 访问。如果某个未导出，请告诉框架维护方补出口。

## 3. 你必须做的

1. 决定真后端：SQLite / Postgres / IndexedDB / 文件 都行。linnkit 不规定。
2. 实现 3 个 port，作为 host runtime-assembly 的依赖注入点。
3. 写入时使用 `createMonotonicEventStoreIdFactory()` 生成非空 `eventStoreId`。它只用于稳定分页，不等同于 `RuntimeEvent.id`，禁止缺失时用业务 event ID 或时间戳 fallback。
4. 使用**短事务**：每个 lifecycle 调用各自独立 commit，**不要**跨整个 LLM/tool 执行过程持有数据库事务。

EventStore 是 durable fact 边界，只接收：

- 已通过 `parseRoutedRuntimeEvent()` 语义的 `RoutedRuntimeEvent`；
- `describeRuntimeEventLifecycle(event).persist === true` 的事实；
- 非空、单调、由 storage owner 分配的 `eventStoreId`。

`ephemeral=true`、`final_answer_chunk`、`tool_process` 等实时进度直写 EventStore 必须失败，不能 silent no-op。过滤发生在 EventBus persistence consumer，EventStore 的拒绝用于暴露绕过正常发布链的调用。

generated facts 的持久化入口只能是 EventBus persistence consumer。Graph journal、quickstart callback、child result 和 transcript 都读取 admission 后的同一 `RoutedRuntimeEvent`，不得在执行结束时遍历返回事件补写 EventStore。Host incoming fact 若采用 durable-first transaction，也必须先由同一个 publisher route，提交成功后再 `publishRouted`，并显式登记已提交事实，避免 persistence consumer 重复写入。

## 4. 实现 EventStore 的常见落地形态

- 已有 `conversations / runs / events` 表？采用 **event-grained core**：只保留一张事件事实表，不新增第二份事实源。
- 你的 `EventStore` 实现可以同时对外暴露两组 API：
  - host 主写链直接用的短事务会话 API（`beginRunSession` / `appendEventToRun` / `completeRun` / `failRun`）；
  - 给 linnkit `EventStore` port 消费的 adapter（把 `append/range/latestEventStoreId` 桥接到底层）。

UI 历史应由 `events` 派生为可重建 read model。read model 可以与事实在同一短事务更新，但不能成为审计、Agent context 或 replay 的第二事实源。

## 5. 你不要做的

- 不要把"数据库就是平台默认实现"的假设写死。
- 不要跳过 `schemaVersion` / `CheckpointMeta` 这些契约字段。
- 不要一边写库一边偷偷吞掉冲突或重复事件——push 到上层做幂等判断。
- 不要在 `PersistedEvent` 外层重复保存 `conversationId / runId / timestamp`；这些字段以 `event` 内的正式事实为准。
- 不要从 metadata、session 参数或 active conversation 补齐事件身份；参数只用于与正式字段做一致性校验。
- 不要让 mapper、Graph node、collector 或 test harness 直接承担 EventStore 写入；它们不是 persistence owner。

## 6. 最小验证

### 可恢复执行的显式接入

`GraphExecutorConfig.executionCheckpointPort` 启用可恢复执行提交：Host 必须把 publisher
已接纳的本步骤 durable facts 与传入 checkpoint 放进同一短事务，并校验当前 activation
的写入权。普通 EventBus consumer 在此模式下暂存事实，由该提交释放；不能先独立落盘
再把两次写入称为原子提交。`RuntimeEventCommitPort` 的显式 durable-first 事实仍走原入口。

`EventBusEventPersistence.checkpointWriter` 在现有 consumer 内暂存本步骤事实；Graph 的
提交端口调用同实例 `commitCheckpoint`，writer 一次收到 facts 与 checkpoint。
离开 Graph 时调用 `finishCheckpointWrites` 作废未提交 attempt 并恢复普通 settlement
写入。`drain` 只等待已安排的事务，不能把 staged facts 当成已持久化。客户端以持久运行
状态确认完成，不把尚未提交的实时进度当作恢复凭据。

Graph 在节点调用前保存进度，每个工具 call 前保存执行意图、结束后保存结果与下一位置。
`continueSession` 只挂载新的临时能力，保留原请求、历史、模型和累计预算；不创建用户输入，
也不从 `user` 重启。`yielded` checkpoint 只返回已完成状态，不能重跑最终节点。
未决工具必须经 `ToolRecoveryPort` 查询 owner；无 owner 证明时抛 `RunRecoveryBlockedError`，
不按相同参数猜测成功。允许安全重试是 owner 的显式决定。

`RunPauseRequested` 是临时停止的 signal reason；它不等于取消，也不结算尚未执行的
工具为失败。Host 仍负责 RunDescriptor、权限重建、唯一 activation、生命周期和资源保留。
仅使用原 `Checkpointer` 的 Host 不会自动获得这些恢复保证。

永久取消时 ToolNode 在 AbortError 离开前提交 yielded 边界，保留真实已完成结果并为未启动
调用配对取消输出。Graph 在节点切换间收到取消时调用可选 `GraphNode.cancel(state)`；
此入口只结算已接纳工作，不能启动新动作，不用于 RunPauseRequested。拥有取消收尾事实
的自定义节点也应履行同一合同。Host 不得在 finishCheckpointWrites 后从 journal 补写。

协议熔断也必须先完成结果提交：ToolNode 消费完整个已接纳 batch，提交全部配对
`tool_output`、清除工具执行意图并保存 `ready / llm` 位置，之后才抛出稳定的
`tool.protocol_fuse`。这表示当前 execution 被中断，不表示 run 已成功完成；Host
仍拥有失败或暂停的生命周期决策。若 Host 允许用户显式继续，Graph 从 LLM 消费原错误
历史，不重跑已拒绝的工具，也不自动继续本次熔断。结果提交失败时优先传播存储异常，
保留此前已提交的 checkpoint，不能先报告熔断完成再补写丢失事实。

该结果边界不适用于任意未知异常：未获得工具 owner 证明的副作用仍须保留执行意图并按
恢复合同对账，不能为了“每个调用看起来结束”而伪造失败输出或直接清除未决动作。

Supervisor 的 cancelled 状态先撤销动作权限，不意味着在途提交已经排空。Host checkpoint
writer 应允许原 activation 在现存 revision 链上完成收尾（包括取消时已排队的边界），
但不能恢复工具效果写入权；yielded 或释放后必须拒绝迟到提交，不得复活已清理的断点。

linnkit 在内部对每个 port 都跑了 contract test。你的实现必须通过这些**等价的契约测试**。建议在 host 测试里 mirror linnkit 的 contract test，把 memory 实现 → 你的实现做参数化，确保行为 1:1。
