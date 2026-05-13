# Persistence · 接持久化（3 个 port）

> **What** · 三个持久化适配 port —— `Checkpointer`（断点续推）/ `EventStore`（事件归档）/ `RunRegistryStore`（run 元数据）。
> **When to read** · 要让 run 跨进程崩溃后恢复；要审计 / 回放 agent 历史；要把 in-memory 默认实现换成真实 DB。
> **Prerequisites** · [`02-quickstart.md`](./02-quickstart.md)；建议与 [`run-supervisor.md`](./run-supervisor.md) 并读。
> **Key exports** · `Checkpointer` / `EventStore` / `RunRegistryStore` from `@linnlabs/linnkit/runtime-kernel`。
> **Related** · [`run-supervisor.md`](./run-supervisor.md) · [`audit.md`](./audit.md) · [`realtime.md`](./realtime.md) · [`glossary.md`](./glossary.md)

> **术语提醒**：这里的 `Checkpointer` 是 **engine-state checkpoint**——保存 graph engine 执行状态（`nodeId / pendingToolCalls / executorLocal.stepCount / local`），用来"中断后从断点继续推理"。它**不是**任何"对话总结/上下文裁剪"语义；后者是上下文工程层面的 RuntimeEvent，应当走你自己的 `EventStore`，跟本接口无关。详见 [glossary.md](./glossary.md)。

## 1. linnkit 给你的合同

- `Checkpointer`（来自 `@linnlabs/linnkit/runtime-kernel`，在 `graph` namespace 下）：`load` / `save` / `clear` 三个必需方法 + `peekMeta` / `list` 两个可选。
- `EventStore`（来自 `@linnlabs/linnkit/runtime-kernel`，在 `graph` namespace 下）：`append` / `range` / `latestEventId` 三个必需 + `truncate` 可选。配套 `createMonotonicEventIdFactory()` 帮你生成单调 id。
- `RunRegistryStore`（来自 `@linnlabs/linnkit/runtime-kernel`，在 `runSupervisor` namespace 下）：run lifecycle 元数据落库。
- `RuntimeEvent` / `EventEnvelope` / `PersistedEvent` 类型来自 `@linnlabs/linnkit/contracts` 与 `runtime-kernel`。

## 2. linnkit 自带的 mock primitive

`memoryCheckpointer` / `memoryEventStore` / `memoryRunRegistryStore` 都是 in-memory contract-test 用实现。它们藏在 runtime-kernel 内部，外部消费者一般不需要直接引用——通过 `@linnlabs/linnkit/runtime-kernel` 的 namespace 访问。如果某个未导出，请告诉框架维护方补出口。

## 3. 你必须做的

1. 决定真后端：SQLite / Postgres / IndexedDB / 文件 都行。linnkit 不规定。
2. 实现 3 个 port，作为 host runtime-assembly 的依赖注入点。
3. 写入时使用 `createMonotonicEventIdFactory()` 生成 eventId；旧数据可保持 `NULL` 并在读取时 fallback。
4. 使用**短事务**：每个 lifecycle 调用各自独立 commit，**不要**跨整个 LLM/tool 执行过程持有数据库事务。

## 4. 实现 EventStore 的常见落地形态

- 已有 `conversations / runs / events / messages` 表？采用 **schema-preserving event-grained core**：保留既有表结构，不新增第二张事件事实表。
- 你的 `EventStore` 实现可以同时对外暴露两组 API：
  - host 主写链直接用的短事务会话 API（`beginRunSession` / `appendEventToRun` / `completeRun` / `failRun`）；
  - 给 linnkit `EventStore` port 消费的 adapter（把 `append/range/latestEventId` 桥接到底层）。

## 5. 你不要做的

- 不要把"数据库就是平台默认实现"的假设写死。
- 不要跳过 `schemaVersion` / `CheckpointMeta` 这些契约字段。
- 不要一边写库一边偷偷吞掉冲突或重复事件——push 到上层做幂等判断。

## 6. 最小验证

linnkit 在内部对每个 port 都跑了 contract test。你的实现必须通过这些**等价的契约测试**。建议在 host 测试里 mirror linnkit 的 contract test，把 memory 实现 → 你的实现做参数化，确保行为 1:1。
