# Agent Registration Guide · Agent 注册与装配规范

> **What** · `AgentSpec` 静态蓝图 + `defineAgent` quickstart helper + `contextPolicy` 12 大分组 + 多 agent 协作。
> **When to read** · 第一次注册 agent；精细化控制上下文；多 agent 串接；做 agent 注册表。
> **Prerequisites** · [`02-quickstart.md`](./02-quickstart.md)；建议先读 [`tool-development-guide.md`](./tool-development-guide.md) ⭐。
> **Key exports** · `AgentSpec` / `ToolBindingSpec` / `defineContextPolicy` from `@linnlabs/linnkit/contracts` · `defineAgent` / `runAgent` from `@linnlabs/linnkit/quickstart`。
> **Related** · [`context-engineering.md`](./context-engineering.md) ⭐ · [`context-fences.md`](./context-fences.md) ⭐ · [`child-runs.md`](./child-runs.md) · [`llm-provider.md`](./llm-provider.md)

linnkit 把 Agent 视为**一等对象**——一个 Agent 是**可序列化的静态蓝图**（`AgentSpec`），不是一段散落的配置 + prompt。这让它能进入 audit / replay / testkit 不变量校验路径。

---

## 0. 一句话分层

| 层 | 是什么 | 谁持有 |
|----|--------|--------|
| **`AgentSpec`** | 蓝图：id / version / 工具集 / contextPolicy / model hints | host 装配期注册到 registry |
| **`AgentInvocationRequest`** | 一次调用：query / history / fences / modelId | runtime 每次调用构造 |

修改 `AgentSpec` = 版本升级（需 audit）；修改 `AgentInvocationRequest` = 运行期决策（不需 audit）。

---

## 1. 在哪里定义 Agent · 示例

> **TL;DR**：一个 Agent 一个文件 / 子目录。**Quickstart** → `agents/<id>.ts`；**生产 host** → `agent-registry/<id>/spec.ts`。linnkit 不规定路径——下面是推荐形态。

### 1.1 Quickstart 形态（demo / 试用 / 单测）

```text
my-agent-demo/
├── tools/searchDocs.ts          # SearchDocsTool extends BaseTool
├── agents/
│   ├── pptAssistant.ts          # defineAgent({...})
│   └── emailWriter.ts
└── main.ts                       # runAgent(agent, { input, llm })
```

### 1.2 生产 host 形态（产品里长期维护）

```text
app-hosts/<your-app>/
├── agent-registry/
│   ├── index.ts                 # 集中导出 + 注册到 host registry
│   ├── pptAssistant/
│   │   ├── spec.ts              # AgentSpec.parse({...})
│   │   ├── prompt.ts            # systemPrompt（host 自管，不进 AgentSpec）
│   │   └── tools.ts             # toolId 字符串数组
│   └── emailWriter/spec.ts
├── adapters/{tools,llm}/
└── runtime-assembly/             # GraphExecutor 装配
```

### 1.3 新加一个 Agent · 三步走

| 步 | Quickstart | 生产 host |
|----|------------|----------|
| 1. 入口 API | `defineAgent()` from `@linnlabs/linnkit/quickstart` | `AgentSpec.parse()` from `@linnlabs/linnkit/contracts` |
| 2. 建文件 | `agents/<id>.ts` 一个文件 | `agent-registry/<id>/spec.ts` 一个子目录 |
| 3. 注册 | `import` 给 `runAgent()` | `agent-registry/index.ts` 集中 `AgentRegistry.register(spec)` |

> `AgentRegistry` 是 host 自己实现的（最简就是 `Map<string, AgentSpec>`）——linnkit 协议层不规定形状。详见 §6.1。

---

## 2. `AgentSpec` 字段速查

```ts
import { AgentSpec, defineContextPolicy } from '@linnlabs/linnkit/contracts';

const spec = AgentSpec.parse({
  id: 'pptAssistant',
  version: '1.2.3',
  capabilities: ['agent', 'createPpt'],
  tools: [{ toolId: 'search_docs', argsSchema: searchDocsTool.parameters }],
  contextPolicy: defineContextPolicy({
    profileId: 'agent',
    budget: { maxTokens: 128_000 },
  }),
  role: 'PPT 制作助手',           // ⚪
  modelHints: { preferredProviders: ['anthropic'] }, // ⚪
  audit: { redactionLevel: 'standard', pii: false }, // ⚪
  metadata: {},                    // ⚪ host 业务字段，不要升格为协议字段
});
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | ✅ | host registry 唯一标识；audit / replay / telemetry 全部用它 |
| `version` | ✅ | semver；任何协议级改动 bump 这里（见 §7） |
| `capabilities` | ✅ | 能力声明字符串数组；host 路由 / 权限决策可用 |
| `tools` | ✅ | `ToolBindingSpec[]` —— 见 §3 |
| `contextPolicy` | ✅ | **必须**用 `defineContextPolicy()` helper —— 见 §4 |
| `role` / `description` / `modelHints` / `audit` / `metadata` | ⚪ | 见上方示例 |

---

## 3. `tools` 字段：`ToolBindingSpec[]`

```ts
tools: [
  { toolId: 'search_docs', argsSchema: searchDocsTool.parameters },
  { toolId: 'search_docs', argsSchema: ..., bindingId: 'search_v2', config: { topK: 10 } },
]
```

**核心约束**：

1. **`argsSchema` 是可序列化 JSON Schema 副本**——直接塞 runtime `zod` 对象会被协议层拒绝（让 `AgentSpec` 不可 audit / replay）。
2. **`toolId` ≠ `BaseTool` 实例**——`AgentSpec` 只持名字字符串，实际工具实例由 host 的 `ToolRuntimePort` 管理。
3. **同一 `toolId` 可绑定多次**——用 `bindingId` 区分（如同一搜索工具配两套 `topK`）。
4. **`config` / `metadata` 是 host 自由字段**——framework 不解读。

---

## 4. `contextPolicy` 与 `defineContextPolicy()`

```ts
import { defineContextPolicy } from '@linnlabs/linnkit/contracts';

const contextPolicy = defineContextPolicy({
  profileId: 'agent',
  budget: { maxTokens: 128_000, reservedForResponse: 8_000 },
  toolHistory: { strategy: 'per-run', overflowStrategy: 'keep-latest' },
  summarization: { enabled: true, agentId: 'summarizer', triggerThreshold: 0.8 },
});
```

12 大分组的详细说明见 [`context-engineering.md`](./context-engineering.md) ⭐。

如果你只是想确认“改预算要不要改很多地方”，先看 [`context-engineering.md §0.1`](./context-engineering.md#context-policy-source-of-truth)：`contextPolicy` 是配置真相源，运行时会先做三层合并，再由 adapter 拆给各消费点。

> ⚠️ **不要手写 `AgentSpecContextPolicy` 对象**——`defineContextPolicy()` 不只补默认值，还**校验组合约束**（如 `summarization.enabled = true` 必须有 `agentId`）。手写绕过 helper 会在运行时崩溃。

### 4.1 `maxTokens` 谁来算？

linnkit 内置默认 tokenizer（`tiktoken` + 字节比兜底），用于 `contextPolicy.budget` 决策。三种调整方式：

| 你的场景 | 推荐做法 |
|---------|---------|
| 试用 / 默认行为够用 | 不动 |
| GPT-4o 系 | `tokenEstimation: { encoding: 'o200k_base' }` |
| 中文为主 | `tokenEstimation: { avgCharsPerToken: 1.7 }` |
| 严格按真实 Claude/Gemini 计费做预算 | 注入自定义 `TokenizerPort`（见 [`context-engineering.md §9.4`](./context-engineering.md)） |

linnkit **不**做：跨 provider 统一计费 token 数协议（不同模型口径不一样）。计费 token 走 provider `usage`。

### 4.2 摘要 agent：`summarization.agentId`

被动摘要（`contextPolicy.summarization`）会把一批旧消息交给 host 注册表里的**无工具**摘要 agent/chat；framework 不写摘要 prompt、不直接裸调 LLM。接入顺序：**先在 host 侧注册摘要项** → **再让业务 `AgentSpec` 的 `summarization.agentId` 指向该注册 id**。

```ts
// ① host：注册一个无工具的摘要 agent/chat（表单项形状随 host 而定；核心是 id 可被解析、tools 为空）
//    例如注册 id: 'history_compression'，并自行装配 prompt / 模型。

// ② 业务 AgentSpec.contextPolicy（片段）
defineContextPolicy({
  profileId: 'agent',
  summarization: {
    agentId: 'history_compression',
    triggerThreshold: 0.72,
    failureBehavior: 'continue-if-within-budget',
  },
}),
```

- `agentId` 必须在 host 注册表里存在；未知 id 应在装配期失败。
- 摘要 agent **不要带工具**，否则摘要路径可能二次进工具循环。
- `failureBehavior: 'continue-if-within-budget'`：仅当当前上下文仍不超预算时可继续用原文；**已超预算仍会 fail-fast**。字段语义与阈值细则见 [`context-engineering.md`](./context-engineering.md) §5.4。

---

## 5. 两种注册 API

### 5.1 生产：`AgentSpec.parse()`

```ts
// agent-registry/pptAssistant/spec.ts
import { AgentSpec, defineContextPolicy } from '@linnlabs/linnkit/contracts';

export const pptAssistantSpec = AgentSpec.parse({
  id: 'pptAssistant',
  version: '1.2.3',
  capabilities: ['agent', 'createPpt'],
  tools: [{ toolId: 'search_docs', argsSchema: searchDocsToolSchema }],
  contextPolicy: defineContextPolicy({ profileId: 'agent', budget: { maxTokens: 128_000 } }),
  modelHints: { preferredProviders: ['anthropic'] },
});
```

### 5.2 Quickstart：`defineAgent()`

```ts
import { defineAgent } from '@linnlabs/linnkit/quickstart';

export const pptAssistant = defineAgent({
  id: 'pptAssistant',
  version: '1.2.3',
  role: 'PPT 制作助手',
  systemPrompt: '你是 ...',
  modelId: 'claude-sonnet-4',
  capabilities: ['agent', 'createPpt'],
  tools: [new SearchDocsTool()],
  contextPolicy: { budget: { maxTokens: 128_000 } },
});
```

| 维度 | `defineAgent()` | `AgentSpec.parse()` |
|------|----------------|---------------------|
| 工具引用 | 持有 `BaseTool` 实例 | 只持 `toolId` 字符串 |
| systemPrompt | 必填，由 helper 持有 | 不存在（host 自管 prompt 装配）|
| modelId | helper 字段 | 走 `modelHints` |
| 用途 | demo / 测试 / 5 分钟入门 | 生产 host 接入 |

完整 quickstart demo 见 [`02-quickstart.md`](./02-quickstart.md)。

---

## 6. 生产 host 装配 · 三件事

### 6.1 实现 `AgentRegistry`

linnkit 不规定形状，host 自己实现。最小职责：`register(spec)` + `get(agentId)`。

| Pattern | 适用场景 |
|---------|----------|
| **A · 内存 Map** | 80% 场景；agent 集合在编译期确定（典型单进程宿主）。`new Map<string, AgentSpec>()` 即可 |
| **B · 启动时从 JSON 加载** | 让运维 / PM 改配置就能调 agent。boot 时 `AgentSpec.parse(json)` 校验 |
| **C · 数据库 + 动态更新** | 多租户 SaaS；UI 编辑 spec；要 audit trail |

> ⚠️ 无论用哪种 pattern，**`AgentSpec.parse()` 是必经入口**——保证进入 runtime 的 spec 100% 满足协议约束。绕过 = 让坏数据流到生产。

### 6.2 装配 GraphExecutor（进程级共享单例）

```ts
import { createDefaultGraphExecutor, LlmNode, LlmCaller } from '@linnlabs/linnkit/runtime-kernel';

const executor = createDefaultGraphExecutor({
  llmNode: new LlmNode({ llmCaller: new LlmCaller({ aiEngine }) }),
  toolRuntime,             // host 实现，见 tools.md
  observationPreview,      // host 实现，见 tools.md
});
```

所有 agent 共用一个 executor，每次调用通过 `agentSpec` 切换蓝图。

### 6.3 运行期入口 · `AgentInvocationRequest`

```ts
// HTTP / IPC / CLI handler
const spec = AgentRegistry.get(req.agentId);
if (!spec) throw new Error(`Unknown agent: ${req.agentId}`);

await executor.run({
  agentSpec: spec,
  runId: generateRunId(),
  query: req.userMessage,
  history: await loadHistory(req.conversationId),
  fences: await buildFences(req),    // 见 context-fences.md
  modelId: spec.modelHints?.preferredModels?.[0] ?? 'claude-sonnet-4',
});
```

详细装配见 [`02-quickstart.md`](./02-quickstart.md) 与 [`run-supervisor.md`](./run-supervisor.md)。

---

## 7. AgentSpec 版本管理

`AgentSpec` 是协议层蓝图——任何修改都要 bump version：

| 修改 | 版本号 | 配套动作 |
|------|--------|----------|
| 加工具 / 加 capability | minor | audit log 记"能力扩展" |
| 改 `contextPolicy.budget` / `toolHistory.strategy` / `toolHistory.retentionMode` | minor | audit log；考虑 replay 验证 |
| 删工具 / 删 capability | **major** | audit log；既有 run 进 deprecated 路径 |
| 改 `metadata` / `role` / `description` 文案 | patch | 一般不需要 audit |

**对 replay 的影响**：未来 Replay SDK 按 `AgentSpec.version` 精确匹配——同一 runId 必须用**当时的 spec 版本**重演。这是 `version` 必填、spec 必须可序列化的原因。

---

## 8. 多 Agent 协作

linnkit 协议层只承认两种多 agent 形态——**不做** AgentMessageBus / role / backstory 这类"自由 chat"协议。所有多 agent 行为必须能映射到下面其一，才能 100% 可审计 / 可回放。

```ts
import { runSupervisor } from '@linnlabs/linnkit/runtime-kernel';

// 同步嵌入：子 run 的 cost 聚合到父 run
const result = await runSupervisor.invokeChildRun({
  parentRunId: context.runId,
  agentSpec: emailWriterSpec,
  input: { query: '写感谢信...' },
});

// 异步后台：立刻返回 handle，可 observe / cancel / waitForTerminal
const handle = runSupervisor.spawnDetached({
  agentSpec: backgroundAgentSpec,
  input: { task: '生成每日报告' },
});
```

详细对比见 [`child-runs.md`](./child-runs.md)。

---

## 9. 自查清单

- [ ] agent 文件位置正确（Quickstart `agents/<id>.ts` / 生产 `agent-registry/<id>/spec.ts`）
- [ ] 一个文件 / 子目录只放一个 Agent
- [ ] 已在入口处注册（`runAgent()` 引用 或 `AgentRegistry.register(spec)`）
- [ ] `AgentSpec.parse()` 是 registry 入口必经路径（生产 host）
- [ ] `id` 在 registry 中唯一；`version` 是 semver；`capabilities` 明确
- [ ] `argsSchema` 是可序列化 JSON Schema 副本（**不是** runtime `zod` 对象）
- [ ] `contextPolicy` 用 `defineContextPolicy()` 而**不是**手写
- [ ] 多 agent 协作走 `invokeChildRun` 或 `spawnDetached`，不自由 chat
- [ ] 有交互工具 → 配套 `WaitUserNode` 路径（见 [`tool-development-guide.md §7`](./tool-development-guide.md)）
- [ ] 配套写了 testkit 不变量测试（见 [`testing.md`](./testing.md)）

---

## 10. 与其他文档的关系

- [`tool-development-guide.md`](./tool-development-guide.md) — 工具内部设计规范
- [`tools.md`](./tools.md) — `ToolRuntimePort` / `ObservationPreviewPort` 接入面
- [`context-engineering.md`](./context-engineering.md) — 12 大分组 `contextPolicy` + `TokenizerPort`
- [`context-fences.md`](./context-fences.md) — fence 注册与注入（与 `mustKeep` 配合）
- [`run-supervisor.md`](./run-supervisor.md) — `RunHandle.cost()` / `observe` / `cancel`
- [`child-runs.md`](./child-runs.md) — `invokeChildRun` vs `spawnDetached`
- [`audit.md`](./audit.md) — Agent 调用 / spec 升级的审计 envelope
- [`testing.md`](./testing.md) — testkit 26 条 strict invariants
