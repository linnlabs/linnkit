# linnkit Development Guide

> ✅✅ **2026-04-23 阶段终态 banner**：Phase E 真抽包已**彻底完成**。`packages/linnkit/src/*` 已是 `linnkit` package 的真源，本指南所有路径已统一刷新，不再使用任何 `src/agent/*` 历史路径。

`packages/linnkit/src/*` 当前已经按 package-neutral 边界收口，并以独立 `linnkit` package 形态对外提供能力。

这份文档只回答一个问题：

**开发一个新能力时，代码到底该放哪。**

---

## 1. 先判断 owner

先按这四问判断：

1. 这是任何 Agent 产品都需要的平台能力吗？
2. 它是否依赖具体宿主实现、数据库、SSE、Electron、renderer？
3. 它是否依赖具体产品语义，比如 agent 列表、promptKey、默认工具集、权限、产品请求形状？
4. 它是否只是测试支撑，而不是运行时代码？

结论规则：

- 平台能力：放 `packages/linnkit/src/*`
- 宿主实现：放 `src/app-hosts/linnya/adapters/*`
- 产品语义：放 `src/app-hosts/linnya/agent-registry/*`、`context/*`、`context-policies/*`
- 通用测试支撑：放 `packages/linnkit/src/testkit/*`
- 宿主测试支撑：放 `src/app-hosts/linnya/testkit/*`

---

## 2. 常见落点

### 2.1 `runtime-kernel`

放这里的东西：

- graph loop / tick pipeline / node protocol
- RuntimeEvent lifecycle
- tool runtime protocol
- child-run protocol
- LLM caller / resolver / streaming skeleton
- run-context / reminder / enrichment framework
- Telemetry port + 4 类 kind 常量
- RunRegistryStore port（**注意**：RunSupervisor 本体目前是按需触发项，详见 §8）

不要放：

- 默认工具集
- 默认 model policy
- SSE / persistence / flow orchestration
- Linnya request shape

### 2.2 `context-manager`

放这里的东西：

- shared pipeline / provider / preprocessor 框架
- summarization / history purification / working-memory
- agent profile owner
- 通用 message formatting / event conversion

不要放：

- promptKey 绑定
- registry 查询
- Linnya request/schema validation
- 默认 provider policy

> **chat 兼容层冻结约定**（2026-04-23 立约）：长期目标是 `chat = tools-disabled agent`。新功能**禁止**在 `context-manager/profiles/chat/*` 下扩张；只允许接受 bug fix。
> 详见 [`docs/secretary/README.md §4`](./docs/secretary/README.md) chat 兼容层冻结计划。

### 2.3 `app-hosts/linnya/adapters`

放这里的东西：

- flow
- context injection
- runtime assembly
- child-run 默认装配
- realtime
- persistence
- tools default ports / default registry

### 2.4 `app-hosts/linnya/context*`

放这里的东西：

- request adapters
- API validation / schema shape
- default context policy
- task resolver / default provider registry

### 2.5 `testkit`

放在 `packages/linnkit/src/testkit/*`：

- package-neutral harness
- context replay / pipeline fixtures
- tool execution fixtures

放在 `src/app-hosts/linnya/testkit/*`：

- graphLoopHarness
- childRunHarness
- toolRegistryHarness
- 任何依赖 Linnya host assembly 的 fixture

> **testkit 硬约束**（`AGENT-GUARD-10-no-testkit-in-production`）：生产代码（包括 `packages/linnkit/src/index.ts`）**禁止** import `linnkit/testkit` 或任何 `testkit/*` deep path；只能在测试文件中显式 import `linnkit/testkit` 子入口。
> 否则 `vitest` 等测试依赖会被 esbuild/tsup 打入生产 bundle（这是 Phase E 收尾期遇到过的真实事故，详见 [`docs/engine/24 §12.2`](./docs/engine/24-phase-e-implementation-runbook.md)）。

---

## 3. 当前硬边界

`npm run guard:agent-boundary` 当前已升级为 **AST 级**（基于 TypeScript Compiler API 遍历），强制 10 条规则，其中关键 5 条：

1. `packages/linnkit/src/*` 生产代码不得 import `src/app-hosts/*`
2. `packages/linnkit/src/*` 生产代码不得 import `packages/linnkit/src/*` 之外的其他 `src/*` owner
3. `packages/linnkit/src/*` 生产代码唯一允许的外部 workspace contract 是 `@app/schemas`
4. `packages/linnkit/src/host-adapters` / `packages/linnkit/src/product-extensions` 不得重新出现
5. **`AGENT-GUARD-10-no-testkit-in-production`**（见 §2.5 注解框）

这意味着：

- 如果你在 `packages/linnkit/src/*` 里想 import `src/shared/*`、`src/tools/*`、`src/core/*`
  - 先停下
  - 先判断 owner 是否应该内化到 `packages/linnkit/src/*`
- 如果你想 import `linnkit/testkit`（包括 deep path）
  - 必须确认这是测试文件（被 guard 的 `isTestFile` / `isTestInfrastructureFile` 识别）
  - 否则会被 CI 直接拦掉

---

## 4. 改动 checklist

改 `runtime-kernel` 时：

1. 先确认不是 host/product 逻辑
2. 确认协议 owner 在 `packages/linnkit/src/*`
3. 优先显式注入，不要偷默认实现
4. 补对应 unit / contract / integration 测试
5. **如果新加可序列化结构**（如新增 RuntimeEvent 类型 / 新增 Checkpointer schema 字段），需评估是否影响历史回放与 schemaVersion 兼容性

改 `context-manager` 时：

1. 先确认它是不是 profile/core，而不是 app binding
2. 如果需要 task resolver / default policy / request adapter
   - 继续放外层
3. 不要把 Linnya 默认策略塞回 shared/profile owner
4. **不要在 `profiles/chat/*` 下加新功能**，只接受 bug fix（见 §2.2）

改 `app-hosts/linnya/*` 时：

1. 把它当成接入方代码，不是平台协议
2. 可以装配 `packages/linnkit/src/*`
3. 不能回头定义 `runtime-kernel` 或 `context-manager` 的最小合同

改 `Database / Schema / Migration` 时：

1. **加新表/索引**：只改 schema-provider（无需配对写一条 migration），老库会被 `DatabaseService.initialize()` 内的 `createTables()` 自动补齐
2. **改老表结构**：必须写 migration；migration 必须**真正幂等**（"列存在 return"是反模式，UPDATE 必须永远跑且 WHERE 兜底）
3. 详见 [`src/electron-main/services/database/migrations/README.md`](../../../src/electron-main/services/database/migrations/README.md) §5/§6

---

## 5. 最小验证集合

### 改 runtime-kernel

- `packages/linnkit/src/runtime-kernel/graph-engine/__tests__/*`
- `packages/linnkit/src/runtime-kernel/llm/__tests__/*`
- `packages/linnkit/src/runtime-kernel/child-runs/__tests__/*`
- `packages/linnkit/src/runtime-kernel/run-supervisor/__tests__/runRegistryStore.contract.test.ts`
- `packages/linnkit/src/runtime-kernel/telemetry/__tests__/telemetry.contract.test.ts`
- `packages/linnkit/src/testkit/__tests__/graphLoop.endToEnd.contract.test.ts` —— **包内端到端永久回归门**

### 改 context-manager

- `packages/linnkit/src/context-manager/__tests__/summary-purification-integration.test.ts`
- `packages/linnkit/src/context-manager/profiles/agent/context/providers/__tests__/multiToolFollowup.integration.test.ts`
- `packages/linnkit/src/context-manager/profiles/agent/context/providers/__tests__/checkpointSummarizationProvider.test.ts`

> ⚠️ **当前已知 skip 测试**（恢复计划见 [`docs/secretary/README.md §4`](./docs/secretary/README.md)）：
> - `packages/linnkit/src/context-manager/profiles/agent/preprocessors/__tests__/toolHistoryCompressor.test.ts:14`（`describe.skip`）
> - `packages/linnkit/src/context-manager/shared/preprocessors/__tests__/userQuoteLifetime.test.ts:25`（`describe.skip`）
>
> 这些是 Phase E 之前用历史 tsx-script 形态留下的，linnsec 一旦进入长对话/提醒/总结/回放场景就是事故高发区。计划在 linnsec 立项前 sprint 中恢复成正式 vitest 用例。

### 改 host flow / assembly

- `src/app-hosts/linnya/adapters/flow/__integration-tests__/flow.followup-tool-history.integration.test.ts`
- `src/app-hosts/linnya/adapters/flow/__integration-tests__/summarization.test.ts`
- `src/app-hosts/linnya/adapters/flow/agent-runner/__tests__/toolContextFactory.test.ts`

### 改 Database / Schema

- `src/electron-main/services/database/__tests__/database-service.idempotent-init.test.ts` —— **createTables-always 不变量看护**
- `src/electron-main/services/database/migrations/__tests__/v014-v019-idempotency.test.ts` —— **migration 真幂等性看护**

---

## 6. 容易踩的术语陷阱

### 6.1 "Checkpoint" 在本仓库里有两种含义，不要混

| 含义 | 在哪 | 谁 owner |
|---|---|---|
| **Engine-state Checkpoint** | `runtime-kernel/graph-engine/checkpointer/` 的 `Checkpointer` port | 平台层。保存 `EngineState`（`nodeId / pendingToolCalls / local`），让 run 中断后能恢复 |
| **应用层 Context Checkpoint** | 宿主/产品层的 LLM 工具（在本仓库里具体落在 `src/tools/context_checkpoint/`） | 产品层。让 LLM 主动写"阶段总结"，下一轮上下文构建时把摘要点之前的旧消息从 LLM context window 裁掉 |

**判断规则**：

- 你在改"图执行如何中断/恢复" → 改 `runtime-kernel/graph-engine/checkpointer/`
- 你在改"对话太长怎么压缩 LLM context window" → 改 `context-manager` 和宿主侧产品工具
- 你在改 `Checkpointer` port 时，**不要**试图在里面塞"摘要"语义；它就是个 K-V，key 是 conversationId，value 是 `EngineState`
- 你在改产品层的"对话摘要工具"时，**不要**试图把它的产物存进 `Checkpointer`；它的产物是个 `RuntimeEvent`，应该走宿主的 `EventStore`

详见 [`packages/linnkit/src/README.md §4.5`](./README.md) 的对比表。

### 6.2 "Event" 的几个层

| 名字 | 所在层 | 用途 |
|---|---|---|
| `AnyAgentEvent` | runtime-kernel 内部领域事件 | graph node 内部产出的原始事件 |
| `RuntimeEvent` | runtime-kernel → host 持久化事件 | 持久化、上下文重建、history 回放的事实来源 |
| 实时通道事件（如 SSE） | host realtime adapter | 前端实时渲染（**接入方自己负责**） |

注意：`RuntimeEvent` 的**生命周期治理**（`persist / replayToUi / enterAgentContext / realtimeChannel`）由 `runtime-kernel/events/eventGovernance.ts` 决定，它是浏览器安全的（通过 `linnkit/runtime-kernel/events` slim seam 暴露）。前端 reload 回放也走这条 governance。

---

## 7. 反模式

不要这样做：

- 在 `packages/linnkit/src/*` 里直接 import `src/app-hosts/*`
- 在 `packages/linnkit/src/*` 里偷用默认 `ToolRegistry`、默认 `aiEngine`、默认 model policy
- 把 Linnya request schema 混进 context core
- 把 host-bound harness 塞回 `packages/linnkit/src/testkit/*`
- 在生产代码里 import `linnkit/testkit`
- 在前端代码里 import `linnkit/runtime-kernel`（必须改用 `linnkit/runtime-kernel/events` slim seam）
- 在 `context-manager/profiles/chat/*` 加新功能（chat 兼容层已冻结，仅接受 bug fix）
- 加新表/索引时 **同时** 写 schema-provider + migration（schema-provider 一条就够，DRY）
- 写 migration 时用"列存在 return"模式跳过 UPDATE（这是反模式，会留脏数据，详见 v14/v19 的修法）
- 为了复用，先造 bridge 再开发

---

## 8. 当前已知"按需触发"项

这些不是 TODO，是**条件触发**——只在真实需求出现时才动手，不要为了完整性提前做：

| 项目 | 触发条件 | 备注 |
|------|---------|------|
| **RunSupervisor 本体** | linnsec Phase 1 确认有后台任务 / 主动汇报 / 子 run 树管理 / 失败恢复 等需求 | 当前只有 `RunRegistryStore` port + memory 实现 + contract 测试，本体未实现。Linnya 不是硬阻塞，linnsec 很可能是真需求 |
| **memory port** | 调研到 ≥ 2 个真实消费者 + 穿透 [`docs/engine/00-engine-scope-audit.md §1.1`](./docs/engine/00-engine-scope-audit.md) 4 条门槛 | 当前判断"产品层 wrap 一层就够"，归 secretary 候选，不进 engine |
| **permission port** | 同 memory port | wait_user + control.requireUser + control.terminateRun 三件套已够，产品层用 wrapper 即可 |
| **wait_external** | wait_user 协议泛化触发条件出现 | CC + Codex + Hermes 均"无内核暂停"，wait_user 已存在 |

---

## 9. 推荐阅读

1. [`packages/linnkit/src/README.md`](./README.md)
2. [`packages/linnkit/src/runtime-kernel/README.md`](./runtime-kernel/README.md)
3. [`packages/linnkit/src/context-manager/README.md`](./context-manager/README.md)
4. [`src/app-hosts/linnya/README.md`](../../../src/app-hosts/linnya/README.md)
5. [`packages/linnkit/src/docs/README.md`](./docs/README.md) —— engine + secretary 文档总入口（含归档/活动状态）
6. [`packages/linnkit/src/INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md) —— 第三方接入指南
