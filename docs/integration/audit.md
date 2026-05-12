# AuditPort · 决策账本

> 可选，但企业接入强烈建议。

AuditPort 是"决策账本"。Telemetry 记录事实（比如一次 LLM 调用了多久、用了多少 token），Audit 记录**为什么做了这个决定**（比如为什么取消、为什么拒绝工具、为什么 fallback 到另一个模型）。

这套接入方式是 host-neutral 的：linnya、在线秘书 agent、未来的知识库 agent 都只需要实现自己的 EventStore / file / SIEM sink，不需要把产品语义写回 linnkit。

## 1. 最小接入骨架

默认进 EventStore，再按需分发到文件 / SIEM：

```ts
import { runtimeKernel } from '@linnlabs/linnkit';

const eventStoreAudit = runtimeKernel.audit.createEventStoreAudit({ eventStore });
const fileAudit = runtimeKernel.audit.createFileAudit({ filePath: '/var/log/linnkit/audit.jsonl' });
const auditPort = runtimeKernel.audit.createCompositeAudit({
  ports: [eventStoreAudit, fileAudit],
});

const supervisor = new runtimeKernel.runSupervisor.DefaultRunSupervisor({
  registryStore,
  auditPort,
});
```

## 2. 当前已自动发出的 envelope

- `RunHandle.cancel({ reason })` 会发 `action: 'run.cancel'`，并把 `reason`、`forceCleanup`、`runId`、`conversationId`、`agentSpecId` 写进 envelope。
- `GraphAgentExecutor` 会发 `model.select`；发生模型切换时发 `model.fallback`。
- `ToolNode` 会发 `tool.allow` / `tool.deny`。
- `WaitUserNode` 会发 `wait_user.request`。
- `runtimeKernel.audit.emitSandboxDecisionAudit()` 是 sandbox 决策标准入口；当前 linnkit 还没有内置 SandboxPort，所以不会伪造 sandbox 执行链。

## 3. 你现在可以选的 sink

| sink | 用途 |
|---|---|
| `runtimeKernel.audit.noopAudit` | 测试或本地开发占位 |
| `runtimeKernel.audit.consoleAudit` / `createConsoleAudit()` | 开发期看结构 |
| `runtimeKernel.audit.createFileAudit({ filePath })` | 追加写 JSONL，适合最小生产审计或回归测试 |
| `runtimeKernel.audit.createEventStoreAudit({ eventStore })` | 默认推荐落点，写入 `type: 'audit_envelope'` 的隐藏 RuntimeEvent |
| `runtimeKernel.audit.createCompositeAudit({ ports })` | 组合多个 sink |

## 4. 接入规则

- Audit envelope 是追加只读记录；不要在 sink 里回写或修改 run 状态。
- `AuditPort.emit()` 可以是同步或异步；如果你的 sink 有缓冲，暴露 `flush()`，在进程退出或测试结束时显式调用。
- 不要把 AuditPort 当普通日志散用。只有"决策"进 audit，普通耗时 / token / 节点状态继续走 telemetry。
- `audit_envelope` 会持久化，但不会进 UI、不会进 agent context、不会走 SSE。
- `createEventStoreAudit()` 要求 envelope 带 `scope.conversationId`，这是为了避免跨会话审计混流。

## 5. 最小验证

- 单测：注入一个数组 sink，调用 `handle.cancel({ reason: 'user_request' })` 后能收到 `action === 'run.cancel'` 的 envelope。
- 单测：`createFileAudit()` 连续 emit 两条 envelope 后，JSONL 文件应有两行且可逐行 `JSON.parse`。
- 单测：`createEventStoreAudit()` emit 后，EventStore 中应出现 `type === 'audit_envelope'` 且 `shouldEnterAgentContext(event) === false`。
