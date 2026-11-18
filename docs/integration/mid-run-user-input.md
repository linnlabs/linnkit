# 运行中插话 · `PendingUserInputPort`

> **What** · Agent 运行期间，用户补充或纠正的话（插话）怎样交给正在运行的这一次执行。
> **When to read** · Host 想让用户在 Agent 跑工具时继续发消息，而不是只能等它做完或先暂停。
> **Key exports** · `PendingUserInput` / `PendingUserInputPort` from `@linnlabs/linnkit/runtime-kernel`（graph 命名空间）；`user_input.delivery`、`AiMessage` 类型 `user_steer` from `@linnlabs/linnkit/contracts`。
> **Related** · [`persistence.md`](./persistence.md) · [`context-fences.md`](./context-fences.md) · [`run-supervisor.md`](./run-supervisor.md)

## 1. 什么时候送达

一批工具全部结算完、即将回到模型之前。批次里的工具照常执行，正在执行的工具不被打断，
还没开始的工具也不跳过。插话写成一条 `user_input` 事实，`delivery: 'mid_run'`，排在本批
所有工具结果之后，并与本次工具边界**同一次提交**。

以下情况不取用，条目留在 Host 手里，由 Host 在运行结束后处理（例如转成下一次运行的输入）：

- 本批结果不是回到模型：Host 主动工具的 `yield_after_batch`、工具返回 `terminateRun`、协议熔断；
- 已收到暂停或取消信号；
- 剩余步数不够再调用一次模型（否则插话已送达，模型却读不到）。

## 2. 端口合同

```ts
interface PendingUserInput {
  readonly id: string;        // 直接成为送达后 user_input 事件的 id
  readonly content: string;
  readonly timestamp?: number;
}

interface PendingUserInputPort {
  claim(): Promise<readonly PendingUserInput[]> | readonly PendingUserInput[];
  confirm(ids: readonly string[]): Promise<void> | void;
  release(ids: readonly string[]): Promise<void> | void;
}
```

- `claim` 取走当前待送达的条目。在 `confirm` 之前，这些条目仍归 Host 所有：Host 不得让用户在这段时间撤回后又被送达。
- 边界提交成功后 Graph 调用 `confirm`；提交或发布失败时调用 `release`，条目回到待送达。
- `id` 在重新取用时保持不变，Host 可据此去重。

端口是运行能力，与 `toolRecoveryPort` 一样放进 Graph local，不进入 checkpoint：

- 新运行：放进 `startSession` 的 local；
- 暂停后继续：`continueSession` 的 `capabilities.pendingUserInputPort`；
- 等待用户后继续：`resumeSession` 的 `localPatch`。

子运行不应装配该端口。没有装配时行为与以前完全相同。

发布时机：插话在取用时经 `RuntimeEventSink` 发布，所以实时通道里它排在本批所有 `tool_output` 之后、
下一次模型调用的事件之前。它是唯一走实时通道的 `user_input`：`runtimeEventToSSEEvent` 投影为 SSE
`user_input`（用户原文 + `delivery: 'mid_run'`），客户端按 `id` 确认送达。运行起点的输入仍不回传。

## 3. 上下文里的形态

- 事件层仍是 `user_input`，Host 的时间线投影、搜索等按普通用户消息处理即可。
- 进入上下文时投影为 `AiMessage` 类型 `user_steer`（role `user`），发给模型时是一条紧跟在工具结果之后的普通用户消息。
- “当前轮从哪里开始”仍以运行起点的 `user_input` 为准：当前轮 fence 的合并与过期清理、工具历史分组、
  工作记忆的当前轮保护都不受插话影响。
- 本次运行里的插话和起点消息一样是核心上下文，压缩时不会被替换；更早运行里的插话按历史用户文本处理。

**不要**把插话塞进 system-reminder 或工具输出：system-reminder 只对当次调用生效，并沿用最后一条消息的角色。
一批工具做完时最后一条正是工具结果，插话会被模型当作工具输出忽略，或当作提示注入；
工具读到的内容也能写出同样的文本来冒充用户。
