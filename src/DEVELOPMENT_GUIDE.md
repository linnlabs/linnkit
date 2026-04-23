# linnkit Development Guide

> 本指南是 linnkit package 内部开发约定。`packages/linnkit/src/*` 是 `linnkit` package 的真源，所有路径都用此前缀。

`packages/linnkit/src/*` 当前已经按 package-neutral 边界收口，并以独立 `linnkit` package 形态对外提供能力。

这份文档只回答一个问题：

**开发 linnkit 内部新能力时，代码到底该放哪。**

> 如果你在做的是接入方层的工作（把 linnkit 装进自己的产品），请改看 [`INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md)。

---

## 1. 先判断 owner

先按这四问判断：

1. 这是任何 Agent 产品都需要的平台能力吗？
2. 它是否依赖具体宿主实现、数据库、SSE、Electron、renderer？
3. 它是否依赖具体产品语义，比如 agent 列表、promptKey、默认工具集、权限、产品请求形状？
4. 它是否只是测试支撑，而不是运行时代码？

结论规则：

- 平台能力：放 `packages/linnkit/src/*`（本仓库内）
- 宿主实现：**不在本仓库**——属于接入方自己仓库的 `app-hosts/<your-host>/adapters/*`
- 产品语义：**不在本仓库**——属于接入方自己仓库的 `app-hosts/<your-host>/agent-registry/*`、`context/*`、`context-policies/*`
- 通用测试支撑：放 `packages/linnkit/src/testkit/*`
- 宿主测试支撑：**不在本仓库**——属于接入方自己仓库的 `app-hosts/<your-host>/testkit/*`

如果你判断结果不是"平台能力"，那这一行代码不应该出现在 linnkit package 里。

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
- 任何 host 层请求 shape

### 2.2 `context-manager`

放这里的东西：

- shared pipeline / provider / preprocessor 框架
- summarization / history purification / working-memory
- agent profile owner
- 通用 message formatting / event conversion

不要放：

- promptKey 绑定
- registry 查询
- 任何 host 层 request/schema validation
- 默认 provider policy

> **chat 兼容层冻结约定**：长期目标是 `chat = tools-disabled agent`。新功能**禁止**在 `context-manager/profiles/chat/*` 下扩张；只允许接受 bug fix。
> 详见 [`docs/framework/07-roi-ranked-priorities.md` Phase F](./docs/framework/07-roi-ranked-priorities.md) chat 兼容层收敛计划。

### 2.3 `ports` / `contracts`

放这里的东西：

- 任何 host 必须实现的最小接口（`ports/`）
- 任何长期稳定不变的合同结构（`contracts/`）

原则：

- ports 必须 package-neutral，不能假设某个 host 的具体实现形态
- contracts 一旦稳定就要尽量保持向后兼容

### 2.4 `testkit`

放在 `packages/linnkit/src/testkit/*` 的：

- package-neutral harness
- context replay / pipeline fixtures
- tool execution fixtures

**不**放在这里的：

- 任何依赖具体 host runtime assembly 的 harness（如 graphLoopHarness host wrapper / childRunHarness host wrapper / toolRegistryHarness host wrapper）—— 这些属于接入方自己 `app-hosts/<your-host>/testkit/*`

> **testkit 硬约束**（`AGENT-GUARD-10-no-testkit-in-production`）：生产代码（包括 `packages/linnkit/src/index.ts`）**禁止** import `linnkit/testkit` 或任何 `testkit/*` deep path；只能在测试文件中显式 import `linnkit/testkit` 子入口。
> 否则 `vitest` 等测试依赖会被 esbuild/tsup 打入生产 bundle（历史上发生过真实事故，已通过 AST guard 拦死）。

---

## 3. 当前硬边界

`npm run guard:agent-boundary` 当前已升级为 **AST 级**（基于 TypeScript Compiler API 遍历），强制 10 条规则，其中关键 5 条：

1. `packages/linnkit/src/*` 生产代码不得 import 任何 host 仓库路径（`src/app-hosts/*`、`src/electron-main/*` 等）
2. `packages/linnkit/src/*` 生产代码不得 import `packages/linnkit/src/*` 之外的其他 `src/*` owner
3. `packages/linnkit/src/*` 生产代码外部 workspace contract 引用受白名单约束
4. `packages/linnkit/src/host-adapters` / `packages/linnkit/src/product-extensions` 不得重新出现
5. **`AGENT-GUARD-10-no-testkit-in-production`**（见 §2.4 注解框）

这意味着：

- 如果你在 `packages/linnkit/src/*` 里想 import 任何 host 路径或外部 `src/*` owner
  - 先停下
  - 先判断 owner 是否应该内化到 `packages/linnkit/src/*`
  - 如果不该内化——这条改动应在 host 仓库做，不在 linnkit
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
   - 这是 host 层职责，不在 linnkit
3. 不要把任何 host 默认策略塞进 shared/profile owner
4. **不要在 `profiles/chat/*` 下加新功能**，只接受 bug fix（见 §2.2）

改 `ports` / `contracts` 时：

1. 必须保证 package-neutral
2. 加新 port 前先判断"是否真是 host 必须实现的"——而不是 host 选择性提供的能力
3. 改既有 port shape 必须考虑向后兼容；不向后兼容时必须先升 schemaVersion

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

> ⚠️ **当前已知 skip 测试**：
> - `packages/linnkit/src/context-manager/profiles/agent/preprocessors/__tests__/toolHistoryCompressor.test.ts:14`（`describe.skip`）
> - `packages/linnkit/src/context-manager/shared/preprocessors/__tests__/userQuoteLifetime.test.ts:25`（`describe.skip`）
>
> 这些是历史 tsx-script 形态遗留的，长对话 / 摘要 / 回放场景是事故高发区。计划在下一次面向"长 run 形态"的 sprint 里恢复成正式 vitest 用例。

### 改 ports / contracts

- 关注所有引用该 port 的 contract 测试
- 在 `__tests__/package.shell.test.ts` 看公开 API 表面是否被守住

---

## 6. 容易踩的术语陷阱

### 6.1 "Checkpoint" 在 agent 生态里有两种含义，不要混

| 含义 | 谁 owner | 用途 |
|---|---|---|
| **Engine-state Checkpoint** | linnkit 平台层（`runtime-kernel/graph-engine/checkpointer/` 的 `Checkpointer` port） | 保存 `EngineState`（`nodeId / pendingToolCalls / local`），让 run 中断后能恢复 |
| **应用层 Context Checkpoint** | 接入方产品层（具体由宿主自己定义的 LLM 工具实现） | 让 LLM 主动写"阶段总结"，下一轮上下文构建时把摘要点之前的旧消息从 LLM context window 裁掉 |

**判断规则**：

- 你在改"图执行如何中断/恢复" → 改 `runtime-kernel/graph-engine/checkpointer/`
- 你在改"对话太长怎么压缩 LLM context window" → 改 `context-manager`（marker 识别 + 裁剪）；具体的"摘要工具"实现属于 host 层
- 你在改 `Checkpointer` port 时，**不要**试图在里面塞"摘要"语义；它就是个 K-V，key 是 conversationId，value 是 `EngineState`
- 应用层"对话摘要工具"的产物是个 `RuntimeEvent`，应该走宿主的 `EventStore`，不要试图存进 `Checkpointer`

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

- 在 `packages/linnkit/src/*` 里 import 任何 host 仓库路径（`src/app-hosts/*` 等）
- 在 `packages/linnkit/src/*` 里偷用任何"默认 ToolRegistry / 默认 aiEngine / 默认 model policy"——这些都是 host 层职责
- 把任何 host request schema 混进 context core
- 把 host-bound harness 塞回 `packages/linnkit/src/testkit/*`
- 在生产代码里 import `linnkit/testkit`
- 在前端代码里 import `linnkit/runtime-kernel`（必须改用 `linnkit/runtime-kernel/events` slim seam）
- 在 `context-manager/profiles/chat/*` 加新功能（chat 兼容层已冻结，仅接受 bug fix）
- 为了复用，先造 bridge 再开发

---

## 8. 当前已知"按需触发"项

这些不是 TODO，是**条件触发**——只在真实需求出现时才动手，不要为了完整性提前做：

| 项目 | 触发条件 | 备注 |
|------|---------|------|
| **RunSupervisor 本体** | 出现真实的后台任务 / 主动汇报 / 子 run 树管理 / 失败恢复 等需求 | 当前只有 `RunRegistryStore` port + memory 实现 + contract 测试，本体未实现。详见 [`docs/framework/04-protocol-roadmap.md` N-3](./docs/framework/04-protocol-roadmap.md) |
| **memory port** | 调研到 ≥ 2 个真实消费者 + 穿透 [`docs/archive/engine-phase-a-to-e/00-engine-scope-audit.md §1.1`](./docs/archive/engine-phase-a-to-e/00-engine-scope-audit.md) 4 条门槛 | 当前判断"产品层 wrap 一层就够"，归 host 层候选，不进 framework；详见 [`docs/framework/04-protocol-roadmap.md` N-4](./docs/framework/04-protocol-roadmap.md) |
| **permission port** | 同 memory port | wait_user + control.requireUser + control.terminateRun 三件套已够，host 层用 wrapper 即可 |
| **wait_external** | wait_user 协议泛化触发条件出现 | 主流 agent 框架均"无内核暂停"，linnkit 的 wait_user 已是先进设计 |

---

## 9. 推荐阅读

1. [`packages/linnkit/src/README.md`](./README.md)
2. [`packages/linnkit/src/runtime-kernel/README.md`](./runtime-kernel/README.md)
3. [`packages/linnkit/src/context-manager/README.md`](./context-manager/README.md)
4. [`packages/linnkit/src/docs/README.md`](./docs/README.md) —— linnkit 文档总入口
5. [`packages/linnkit/src/docs/framework/`](./docs/framework/) —— 框架演进活文档
6. [`packages/linnkit/src/INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md) —— 接入指南
