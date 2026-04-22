# Agent Development Guide

`src/agent/*` 当前已经按 package-neutral 边界收口。

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

- 平台能力：放 `src/agent/*`
- 宿主实现：放 `src/app-hosts/linnya/adapters/*`
- 产品语义：放 `src/app-hosts/linnya/agent-registry/*`、`context/*`、`context-policies/*`
- 通用测试支撑：放 `src/agent/testkit/*`
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

不要放：

- 默认工具集
- 默认 model policy
- SSE / persistence / flow orchestration
- Linnya request shape

### 2.2 `context-manager`

放这里的东西：

- shared pipeline / provider / preprocessor 框架
- summarization / history purification / working-memory
- agent/chat profile owner
- 通用 message formatting / event conversion

不要放：

- promptKey 绑定
- registry 查询
- Linnya request/schema validation
- 默认 provider policy

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

放在 `src/agent/testkit/*`：

- package-neutral harness
- context replay / pipeline fixtures
- tool execution fixtures

放在 `src/app-hosts/linnya/testkit/*`：

- graphLoopHarness
- childRunHarness
- toolRegistryHarness
- 任何依赖 Linnya host assembly 的 fixture

---

## 3. 当前硬边界

`npm run guard:agent-boundary` 当前强制：

1. `src/agent/*` 生产代码不得 import `src/app-hosts/*`
2. `src/agent/*` 生产代码不得 import `src/agent/*` 之外的其他 `src/*` owner
3. `src/agent/*` 生产代码唯一允许的外部 workspace contract 是 `@app/schemas`

这意味着：

- 如果你在 `src/agent/*` 里想 import `src/shared/*`、`src/tools/*`、`src/core/*`
  - 先停下
  - 先判断 owner 是否应该内化到 `src/agent/*`

---

## 4. 改动 checklist

改 `runtime-kernel` 时：

1. 先确认不是 host/product 逻辑
2. 确认协议 owner 在 `src/agent/*`
3. 优先显式注入，不要偷默认实现
4. 补对应 unit / contract / integration 测试

改 `context-manager` 时：

1. 先确认它是不是 profile/core，而不是 app binding
2. 如果需要 task resolver / default policy / request adapter
   - 继续放外层
3. 不要把 Linnya 默认策略塞回 shared/profile owner

改 `app-hosts/linnya/*` 时：

1. 把它当成接入方代码，不是平台协议
2. 可以装配 `src/agent/*`
3. 不能回头定义 `runtime-kernel` 或 `context-manager` 的最小合同

---

## 5. 最小验证集合

### 改 runtime-kernel

- `src/agent/runtime-kernel/graph-engine/__tests__/*`
- `src/agent/runtime-kernel/llm/__tests__/*`
- `src/agent/runtime-kernel/child-runs/__tests__/*`

### 改 context-manager

- `src/agent/context-manager/__tests__/summary-purification-integration.test.ts`
- `src/agent/context-manager/profiles/agent/context/providers/__tests__/multiToolFollowup.integration.test.ts`
- `src/agent/context-manager/profiles/agent/context/providers/__tests__/checkpointSummarizationProvider.test.ts`

### 改 host flow / assembly

- `src/app-hosts/linnya/adapters/flow/__integration-tests__/flow.followup-tool-history.integration.test.ts`
- `src/app-hosts/linnya/adapters/flow/__integration-tests__/summarization.test.ts`
- `src/app-hosts/linnya/adapters/flow/agent-runner/__tests__/toolContextFactory.test.ts`

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

详见 `src/agent/README.md` §4.5 的对比表。

---

## 7. 反模式

不要这样做：

- 在 `src/agent/*` 里直接 import `src/app-hosts/*`
- 在 `src/agent/*` 里偷用默认 `ToolRegistry`、默认 `aiEngine`、默认 model policy
- 把 Linnya request schema 混进 context core
- 把 host-bound harness 塞回 `src/agent/testkit/*`
- 为了复用，先造 bridge 再开发

---

## 8. 推荐阅读

1. `src/agent/README.md`
2. `src/agent/runtime-kernel/README.md`
3. `src/agent/context-manager/README.md`
4. `src/app-hosts/linnya/README.md`
5. `docs/proposals/agent-package-boundary-extraction-proposal.md`
