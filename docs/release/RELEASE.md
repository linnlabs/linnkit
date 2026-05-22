# linnkit · Release / Publish 流水

> **状态**：**当前源码开发线：`0.8.0`**（2026-05-13，**TokenizerPort**：host 可选注入自定义 tokenizer，默认继续走 TokenCalculator + tiktoken + 字符比兜底；0.7.x 行为不变）。上一条已发布基线：✅ **0.7.0**（2026-05-13，Phase 1C Quickstart + linnkit-cli v0）；✅ **0.6.0**（2026-05-13，Context Engineering 协议化 minor）；✅ **0.5.0**（2026-05-12，Phase F P0 三件：N-1 AgentSpec / N-3 RunSupervisor / G-1 AuditEnvelope + testkit 15 条不变量 + docs/integration 主题手册）；历史已发布 tarball：✅ **0.2.2**（2026-04-27，docs patch，`dist` 与 0.2.1 一致）；✅ **0.2.1**（`INTEGRATION_GUIDE` 外部消费者重写）；✅ **0.2.0** 已发布（2026-04-26，provider sidecar replay 升级：`final_answer.reasoning_details`、流式 `provider_sidecar`、host-configurable tool replay guard）；0.1.3 已发布（2026-04-24，**packaging fix**：tiktoken external + declare as dep，修复 0.1.0~0.1.2 三个版本 `import @linnlabs/linnkit/runtime-kernel` 立即报 "Missing tiktoken_bg.wasm" 的灾难）；0.1.2（2026-04-24，docs/ 重组）；0.1.1（2026-04-24）；0.1.0 首发（2026-04-23）。`@linnlabs/linnkit` 已在 npmjs.com 公开发布，0.8.0 起发布口径切到 npmjs public registry；独立 repo 拆分见 §7。
> **拍板背景**：linnsy 准备独立建仓，必须有"linnsy 通过包管理器装 linnkit"的稳定路径。本文是这条路径的**单一权威**。
> **目标**：让任意外部仓库（首先是 linnsy）能用 `npm install @linnlabs/linnkit` 装到一份**编译后的、版本化的** linnkit。
> **伴生文件**：[`RELEASE-HISTORY.md`](./RELEASE-HISTORY.md) —— 修订记录全文 / 历次发版长叙事 / 踩坑教训 / PAT rotate runbook。本文只留"现在该怎么做 + 当前状态"；过往叙事去那里查。
>
> **文档分工**：
>
> | 读者 | 优先读 |
> |------|--------|
> | **外部装包接入**（`npm install @linnlabs/linnkit`） | [`docs/integration/`](../integration/)（按主题拆分的 17 个手册：overview / installation / quickstart / llm-provider / tools / context-fences / tool-history / persistence / run-supervisor / child-runs / audit / telemetry / realtime / testing / constraints-and-pitfalls / glossary）；本文只补 **发版/打 tag/CI** 与 **本包元数据** |
> | **本仓 / fork 上改 linnkit 源码** | [`DEVELOPMENT_GUIDE.md`](../DEVELOPMENT_GUIDE.md) + 本文 §1 / §4 / `package.shell.test.ts` |
> | **评审公开 API 边界** | 本文 **§3** + `package.json#exports`（单一真源） |
> | **查某次发版长叙事** | [`RELEASE-HISTORY.md`](./RELEASE-HISTORY.md) §A / §C，不是本文 |
>
> 2026-05-12 起：原单文件 `INTEGRATION_GUIDE.md` 已拆分为 `docs/integration/` 17 个主题手册；旧版里大量 `packages/linnkit/src/...:line` 式引用**不再作为对外契约**，以 **§3 子入口名 + 类型/符号**为准。
>
> **修订记录摘要**（详细背景见 [RELEASE-HISTORY.md §A](./RELEASE-HISTORY.md#a-修订记录全文)）：
> - 2026-05-13 v16：**npm scope 核查 + npmjs public 发布口径收口**——`@linnlabs/linnkit` 在 npmjs.com 已有 `latest=0.7.0`，源码线 0.8.0 的 `publishConfig` / release workflow / installation docs / CLI quickstart 从 GitHub Packages 私有口径切到 npmjs public；独立仓时机从"跟 npmjs 绑定"拆成单独决策，见 §7。
> - 2026-05-13 v15：**0.8.0 开发线（TokenizerPort）**——见下方 §0 0.8.0 draft notes
> - 2026-05-13 v14：**0.7.0 开发线（Phase 1C Quickstart + CLI v0）**——见下方 §0 0.7.0 draft notes
> - 2026-05-13 v13：**0.6.0 发布（Context Engineering 协议化 minor）**——见下方 §0.5 0.6.0 release notes
> - 2026-05-12 v12：**0.5.0 准备发布（Phase F P0 三件 minor + docs 重组）**——见下方 §0 0.5.0 release notes
> - 2026-04-23 v0：立项 + 规格草稿
> - 2026-04-23 v1：工程层落地；dev 体验改用 paths/alias 平行别名（不用 `customConditions`）—— 详见 §1.3
> - 2026-04-23 v2：架构归位（5 个 LLM 协议 type 从 `runtime-kernel` 搬到 `ports`，消除循环依赖）
> - 2026-04-23 v3：scope 重选 `@linnya` → `@linnlabs`（旧名实测被占；新名是 linn 系列总品牌伞）
> - 2026-04-24 v4：0.1.1 发布（D-5 schemas detach round 2 + manifest 修正）+ §7 独立 repo 路线拍板 + npmjs `@linnlabs` scope 抢注锁定
> - 2026-04-24 v5：0.1.2 发布（docs/ 文档架构重组：所有 .md 从 src/ 收口到包根 docs/{README,INTEGRATION_GUIDE,DEVELOPMENT_GUIDE,framework,release}/；package.json#files + .npmignore 同步刷新；新增包根 README.md 作为 npmjs/GitHub 标准入口；运行时 dist 零变化）
> - 2026-04-24 v6：**0.1.3 发布（packaging fix）**：tiktoken 从 dist inline 改为 external + 在 `package.json#dependencies` 声明 `^1.0.22`（与主仓 root 对齐）；vitest 改为 `peerDependencies` (optional)；新增 `package.runtime-import.test.ts`（dist 7 入口子进程隔离 import 烟雾测试）+ `package.events-browser-safe.test.ts`（events seam 静态 import 守卫）+ `package.shell.test.ts` 新增 src 第三方 import 反向稽核（防止下个第三方 dep 漏声明 → 又被 inline）；修复 0.1.0~0.1.2 三个版本 `import @linnlabs/linnkit/runtime-kernel` / `/context-manager` / 根入口都会报 "Missing tiktoken_bg.wasm" 的事故，linnsy daemon 现可正式 install 装配 GraphExecutor 全链路。详见 [`RELEASE-HISTORY.md §A.7 + §C.5`](./RELEASE-HISTORY.md#c5-013-2026-04-24--packaging-fix-tiktoken-external--declared-dep)
> - 2026-05-11 v11：**0.4.0 准备发布（Phase E boundary cleanup minor）**：`AgentProfileRequest` 移除 framework legacy host 字段，只保留通用 agent profile 合同与 `fences[]`；`MessageFormatter` 删除 `document_fragment` / `<additional_context>` / `[任务完成]` 包装；`shared/preprocessors/userQuoteLifetime` 下线，旧 quote 逻辑移动到 chat 兼容层；`linnkit/context-manager` 主入口冻结 chat namespace，只保留必要扁平兼容导出；新增 `no-host-leakage` 测试与 boundary guard 规则，禁止 shared 反向 import profiles。chat profile 不在本阶段物理删除，后续随 tools-disabled AgentSpec 收敛。
> - 2026-05-11 v10：**0.3.0 准备发布（stage 0 cleanup minor）**：`BaseTool<TArgs, TResult>` / `AgentTool` / `ToolCallResult` / `OpenAIToolSchema` 统一收口到 `Record<string, unknown>` 边界；删除根入口 `linnkitCompat`；`ContextProviderError` 承载 provider fatal 语义；`runtime-kernel/llm/caller.ts` 与 `runtime-kernel/events/eventMappers.ts` 按职责拆分，避免 Phase E/F 继续在 700 行以上旧债上叠加。因为公开类型边界与根入口导出发生变化，按 §4 bump minor。
> - 2026-04-27 v9：**0.2.2 发布（docs patch）**：`docs/README.md` 公开 API 与 7 条子路径一致；`RELEASE.md` 删除已闭合 S0 长清单、§5 以「现行发版」为主；`RELEASE-HISTORY` 与 npm 验证叙事同步。`dist` / `exports` / 类型与 0.2.1 无变化。
> - 2026-04-27 v8：**0.2.1 发布（docs patch）**：`docs/INTEGRATION_GUIDE.md` 重写为外部装包消费者手册（真包名 `@linnlabs/linnkit`、7 子入口、GitHub Packages 鉴权、fence 一等接入骨架）；`dist` / `exports` / 类型签名与 0.2.0 无变化。
> - 2026-04-26 v7：**0.2.0 发布（provider sidecar replay upgrade）**：`reasoning_details` 从 tool-call-only 扩展为 assistant 输出通用 sidecar；`final_answer.reasoning_details` 与流式 `provider_sidecar` 进入公开契约；`ToolReplayProtocolPolicy.missingSidecarBehavior` 新增 `provider_empty_replay_field`；具体 DeepSeek `reasoning_content` wire format 仍留在 Linnya integration。

---

## 0. Draft Release Notes · 0.8.0（2026-05-13）

0.8.0 是 TokenizerPort minor。目标是让开源前的 provider-neutral 边界闭合：linnkit 继续内置默认 tokenizer，但 host 可以用官方 Claude / Gemini / 私有模型 tokenizer 替换上下文预算估算逻辑。

### 0.1 ✨ New

| 功能 | 说明 |
|---|---|
| `TokenizerPort` | 新增 `@linnlabs/linnkit/ports` type，定义 `estimateText()` / `estimateMessage()` |
| `DefaultTokenizerPort` | `runtime-kernel/llm` 导出默认实现，包装现有 `TokenCalculator` |
| `createDefaultTokenizerPort(config)` | host 想显式复用默认 tokenizer 时使用 |
| `ContextManagerBaseOptions.tokenizer` | `AgentContextManager` / `ChatContextManager` / orchestrator 支持 host 注入 |
| `ContextManagerBase.updateTokenizerModelId(modelId)` | 高级接入方复用同一个 context-manager 跑不同模型时，可显式刷新传给 tokenizer 的 modelId |
| `createMockTokenizerPort()` | testkit mock，便于接入方验证预算决策走自定义 tokenizer |
| `C12_HOST_TOKENIZER_DRIVES_BUDGET` | context-harness 新增严格不变量：host 注入 tokenizer 后，预算 trace 的 token 明细必须来自 host tokenizer |

### 0.2 Compatibility

- 不注入 tokenizer 时，行为与 0.7.x 一致：继续使用 `TokenCalculator` + `contextPolicy.tokenEstimation` 三参数。
- 注入 tokenizer 后，`tokenEstimation` 三参数只保留在 spec 中，不参与预算决策。
- tokenizer 只用于 context budget，不用于计费；计费继续以 provider `usage` 为准。
- `DefaultTokenizerPort` 的公开 API surface 是 `@linnlabs/linnkit/runtime-kernel`；内部真实实现文件在 `src/shared/`，`./shared` 不进入 package exports。

### 0.3 Migration

1. 默认 host 不需要改。
2. 需要精确 Claude/Gemini/私有模型 token 估算的 host：实现 `TokenizerPort` 并传给 `AgentMessageOrchestrator` / `ChatMessageOrchestrator`。
3. 测试里用 `createMockTokenizerPort()` 固定估算值，验证 overflow / trimming / contextTrace 行为。

---

## 0.5 Previous Release Notes · 0.7.0（2026-05-13）

0.7.0 是 Phase 1C DX minor。目标很克制：让外部接入方能 `npm install` 后 5 分钟跑通 hello agent，但不把 quickstart 做成平台，不提前承诺 replay / inspect / starter 包维护面。

### 0.1 ✨ New

| 功能 | 说明 |
|---|---|
| `defineAgent(input)` | quickstart 级 AgentSpec 构造器，自动补默认 `contextPolicy.profileId='agent'` |
| `runAgent(agent, opts)` | 自动装配 LlmCaller / GraphAgentExecutor / GraphExecutor / memory checkpointer / memory EventStore / RunSupervisor，返回 `{ runId, finalAnswer, events, cost, contextTrace }` |
| `defineConfig(config)` | `linnkit.config.mjs` 的轻量运行时校验：agents 非空、id 唯一、llm adapter 形状合法 |
| `@linnlabs/linnkit/quickstart` | 只引入 DX helper 的子入口 |
| `linnkit init <name>` | 生成 JS ESM demo host：`agents/hello.mjs`、`adapters/openai-compatible.mjs`、`linnkit.config.mjs` |
| `linnkit doctor` | 检查 Node >= 20、旧 GitHub Packages registry override、`OPENAI_API_KEY`、config 和 LLM adapter 形状 |
| `linnkit run <agent-id> --input "..."` | 加载 quickstart config，运行 agent，打印实时 final answer chunk 与 cost 摘要 |

### 0.2 明确不做

- 不做 `linnkit replay` / `linnkit inspect`：这两件依赖 G-3 Replay SDK 和真实 EventStore 接入。
- 不新增 `@linnlabs/llm-openai` / `@linnlabs/store-memory` 包：quickstart 模板内联 demo adapter/store，生产 host 自行实现。
- 不把 OpenAI adapter 放进 linnkit runtime：framework 继续保持 provider-neutral。

### 0.3 升级清单（外部接入方）

1. 升级到 `@linnlabs/linnkit@^0.7.0`
2. 试用：`npx linnkit init hello-linnkit && cd hello-linnkit && npm install && npx linnkit doctor`
3. 生产：继续按 `docs/integration/*` 接入 provider / tools / persistence / audit / context engineering；不要把 quickstart memory runtime 当生产存储

---

## 0.5 Previous Release Notes · 0.6.0（2026-05-13）

**面向外部接入方**。0.6.0 是一次 Context Engineering 大更新：目标是让接入方能通过 `AgentSpec.contextPolicy` 精细控制上下文窗口中的每一类 token，同时保持 framework 不绑定任何具体 host 产品语义。

### 0.1 ⚠️ Breaking / 行为变化

| # | 改动 | 你需要做什么 |
|---|------|-------------|
| 1 | **`AgentSpec.contextPolicy` 新增多个可选分组**：`mustKeep` / `workingMemory` / `checkpoint` / `reasoningRetention` / `tokenEstimation` / `systemReminder` / `contextTrace` / `toolOutput` / `providerReplay` | 旧 spec 仍可解析；想精细控制上下文的 host 应逐步显式声明这些字段。默认值由 framework + host fallback 合并 |
| 2 | **摘要执行方式收口为注册 agent 引用**：`summarization.agentId` 指向 host 注册的无工具摘要 agent/chat；framework 不直接发起裸 LLM call | host 需要提供 summarization agent，或沿用 host fallback；不要在 framework 内写 provider 直连摘要 |
| 3 | **工具执行期 observation 预览治理进入协议面**：超长 observation 可通过 `ObservationPreviewPort` 写完整副本，传给模型的是 preview + `tool_output://...` 指针 | host 必须实现自己的存储路径与读取工具；linnkit 只定义治理阈值和 URI 语义，不规定本地路径 / 对象存储布局 |
| 4 | **provider sidecar replay policy 可按 agent 覆盖** | 如果某个 agent 使用强约束 provider（如要求 tool replay sidecar），优先在 `contextPolicy.providerReplay` 显式声明；不要靠模型名字符串猜测 |

### 0.2 ✨ New

#### Context Engineering 协议化

- `AgentSpec.contextPolicy` 扩展为 12 个分组：`budget` / `toolHistory` / `summarization` / `mustKeep` / `workingMemory` / `checkpoint` / `reasoningRetention` / `tokenEstimation` / `systemReminder` / `contextTrace` / `toolOutput` / `providerReplay`
- host 可声明装配级 fallback policy，agent 级字段优先，framework 默认值兜底
- 所有新增字段保持 optional；0.5.0 形态的 AgentSpec 不需要一次性改完

#### ContextTrace 最小可观测闭环

- `contextTrace.enabled` 控制是否记录上下文构建 trace
- trace 可解释 message keep/drop、token breakdown、policy merge 后实际生效值
- 这是 DevTools / PromptTrace 之前的机器可读底座

#### ObservationPreviewPort

- `contextPolicy.toolOutput.observationGovernance` 控制执行期 tool observation 的预览阈值
- host 通过 `ObservationPreviewPort` 决定完整副本写到哪里：本地文件、ToolOutputStore、对象存储或数据库
- 模型只拿 preview + `tool_output://...` 指针，避免超长工具结果直接塞爆上下文

#### Provider Replay Policy

- `contextPolicy.providerReplay` 允许按 agent 覆盖工具历史回放策略
- `missingSidecarBehavior` 支持 `allow` / `degrade_to_text` / `provider_empty_replay_field`
- host 仍可按模型注册表注入默认策略；agent policy 优先级更高

#### ContextCheckpointTool

- `linnkit/runtime-kernel` 新增 host-neutral `ContextCheckpointTool` 与 `createContextCheckpointTool()`
- 默认工具名使用 `context_checkpoint`
- 最小参数为 `summary`，输出标准 checkpoint marker：`_type: "context_checkpoint"`
- host 若需要 TaskState / SharedMemory / 外部文档状态，可用 hook 扩展 payload，或继续实现自己的 richer checkpoint 工具

### 0.3 🛠 Improved

- `mustKeep` 从 host 装配级策略上提到 `AgentSpec.contextPolicy`
- `workingMemory` 的工具组保留、配对搜索范围、最小保留组数可配置
- `checkpoint.keepPairsBefore` 与 `checkpoint.triggerToolName` 可配置，并联动 checkpoint trimming、GraphExecutor step reset、SystemReminder 提醒文案
- `reasoningRetention.keepLatestThoughts` 可配置
- `tokenEstimation` 暴露 encoding / 字符估算比 / tool call overhead
- `systemReminder` 通过规则注册表扩展，避免在 spec 里塞函数
- `framework/01` / `framework/02` / `99-research-notes/topic-agent-framework-comparison-2026.md` 已按 0.5.0 已发布基线 + 0.6.0 候选源码重评

### 0.4 升级清单（外部接入方）

1. 升级到 `@linnlabs/linnkit@^0.6.0`
2. 保持只从 `@linnlabs/linnkit` 的公开子入口导入；不要 deep import 内部文件
3. 为每类 agent 梳理 `contextPolicy`：先显式声明 budget/toolHistory/summarization，再按需要补 mustKeep/checkpoint/toolOutput/providerReplay
4. 如果启用主动 checkpoint：注册 `ContextCheckpointTool` 或 host 自定义同协议工具，并确保 `checkpoint.triggerToolName` 与真实工具名一致
5. 如果启用 observation preview：实现 `ObservationPreviewPort` 和对应读取工具，确保存储端与读取端使用同一套 blob store

---

## 0.5 Previous Release Notes · 0.5.0（2026-05-12）

**面向外部接入方**。本节是 minor release 的对外说明，按 Breaking / New / Improved / Internal 四段写。

### 0.1 ⚠️ Breaking

| # | 改动 | 你需要做什么 |
|---|------|-------------|
| 1 | **`linnkitCompat` 命名空间已下线**（0.3.0 起；本次发版作为汇总提醒）| 任何 `import { linnkitCompat } from '@linnlabs/linnkit'` 改为直接从 `@linnlabs/linnkit/runtime-kernel` / `/contracts` 取对应符号 |
| 2 | **`AgentProfileRequest` 的 host 产品字段已移除**（0.4.0 起）：`document_fragment` / `document_title` / `context_before` / `context_after` / `project_metadata` / `document_metadata` / `user_quote` / `injected_context` / `completionLengthHint` / `recentRejections` 不再是 framework 协议字段 | host 把这些字段全部走 `fences[]` 通道（见 [`docs/integration/context-fences.md`](../integration/context-fences.md)）|
| 3 | **`MessageFormatter` 不再特殊处理产品语义**：`document_fragment` 包装、`<additional_context>` 字面、`[任务完成]` 中文文案、`getTaskTypeText()` 全部移除 | 想保留旧 LLM messages 形态：自己在 host 注册 fence + formatter；`task_request` / `task_completion` 仍是协议 type，但 MessageFormatter 改为纯内容透传 |
| 4 | **`linnkit/context-manager` 主入口冻结 chat namespace**：`chatContext` / `chatTasks` / `chatOrchestration` 等不再 re-export | 仍兼容 chat 的接入方：使用主入口剩下的 5 个扁平符号（`ChatMessageOrchestrator` / `BaseConversationalTask` / `chatMessageToAiMessage` / `aiMessageToChatMessage` / `buildGenerateRequestFromAgentRequest`）。**长期目标是迁到 tools-disabled `AgentSpec`**，详见 [`docs/integration/context-fences.md`](../integration/context-fences.md) 与未来 0.6.0 |
| 5 | **`AgentRunnerService.run()` 一类 host runner 签名变化**（0.5.0 N-3.A）：返回 `{ handle, result }` 而非 `RunResult`；`FlowAgentRunRequest` 强制携带 `runHandle` | 若你自己实现 host runner：在调用 graph executor 前先 `supervisor.registerRun({ runId: turnId, parentSignal })`，把 `runHandle` 传入 runner，runner 内显式 `markRunning / markCompleted / markFailed` |
| 6 | **`docs/INTEGRATION_GUIDE.md` 单文件已删除**；外部接入文档迁到 `docs/integration/` 目录下 17 个主题手册 | 任何指向 `docs/INTEGRATION_GUIDE.md#xxx` 的链接改为对应 `docs/integration/<topic>.md` |
| 7 | **`docs/framework/` / `docs/DEVELOPMENT_GUIDE.md` 退出 npm tarball**（内部维护文档，不影响接入）| 接入方不会看到这些文件；想看 framework 演进路线请到 GitHub repo 查 |

### 0.2 ✨ New

#### N-1 AgentSpec 一等对象

- `linnkit/contracts` 导出新 zod schema：`AgentSpec` / `AgentCapability` / `ToolBindingSpec` / `AgentSpecContextPolicy`（11 字段）
- `AgentSpecContextPolicy.toolHistory` 支持 3 种策略：`per-pair`（旧默认，4K/8K 模型）、`per-run`（新默认，prompt cache 友好）、`none`（200K+ 长 context 模型）
- 配套 `overflowStrategy: 'keep-latest' | 'fail-fast'` 与 `maxInteractionGroups` 安全阀
- `AgentSpec` 与 `AgentProfileRequest` **并存且互补**（不互相替代）：AgentSpec 是静态画像，AgentProfileRequest 是单次调用契约
- host adapter 新增 `context-manager/shared/agentSpecAdapter.ts`，把 AgentSpec 映射到 context builder 与 preprocessor options

详见 [`docs/integration/tool-history.md`](../integration/tool-history.md)。

#### N-3 RunSupervisor + RunHandle v2

- 新公开 namespace：`runtimeKernel.runSupervisor`，含 `DefaultRunSupervisor` / `MemoryRunRegistryStore` / `RunRegistryStore` port
- `RunHandle` 完整 API：`runId` / `spec()` / `request()` / `signal` / `cancel({ reason })` / `markRunning()` / `markCompleted()` / `markFailed(error)` / `markAwaitingUser()` / `observe(options?)` / `cost()` / `traceContext()`
- `RunSupervisor` 完整 API：`registerRun` / `observeRun` / `cancel` / `list` / `peek` / `spawnDetached` / `waitForTerminal` / `findActiveByConversation` / `drain` / `recoverOnBoot`
- 同步 child-run 的 cost 自动聚合到父 run 的 `childrenTotal`
- detached 异步后台 run：HTTP / cron / wake hook 场景（适合在线秘书类 host）
- `WaitUserNode` 触发 `requires_user_interaction` 事件并写入 `metadata.run_context.runId`，host runner 联动 `markAwaitingUser()`，supervisor 兜底更新 `RunRecord.status = 'awaiting_user'`
- `RunRegistrationSpec` 支持 host 显式传 `runId`（推荐对齐 `turnId`）+ `parentSignal: AbortSignal` 实现 abort 级联

详见 [`docs/integration/run-supervisor.md`](../integration/run-supervisor.md) + [`docs/integration/child-runs.md`](../integration/child-runs.md)。

#### G-1 AuditEnvelope + AuditPort

- 新公开 namespace：`runtimeKernel.audit`
- 5 类非确定性决策自动发 envelope：`run.cancel` / `model.select` / `model.fallback` / `tool.allow` / `tool.deny` / `wait_user.request`
- 5 个 sink 实现：`noopAudit` / `consoleAudit` / `createFileAudit({ filePath })` / `createEventStoreAudit({ eventStore })` / `createCompositeAudit({ ports })`
- 默认推荐落点 EventStore：写 `type: 'audit_envelope'` 的隐藏 RuntimeEvent，只持久化、不进 UI / agent context / SSE
- `emitSandboxDecisionAudit()` 是 sandbox 决策标准入口（待 SandboxPort 接入）

详见 [`docs/integration/audit.md`](../integration/audit.md)。

#### Telemetry scope 升级

- `TelemetryScope` 增加 `runId` + `parentRunId` 字段
- `withLLMTelemetryContext(scope, () => ...)` 支持父子 run 嵌套
- host 可基于 `scope.parentRunId` 实现 cost 父子聚合

详见 [`docs/integration/telemetry.md`](../integration/telemetry.md)。

#### Testkit 升级（15 条 run 不变量）

- `@linnlabs/linnkit/testkit` 新增 `createRunSupervisorHarness` / `createCollectingAuditPort` / `createMockTelemetryPort` / `validateRunInvariants` / `assertRunInvariants`
- 默认开启全部 15 条严格不变量（lifecycle / audit / telemetry / cost / EventStore / ToolCall 配对 / wait_user 状态联动 / detached run 终态）
- 支持 `tool_throw` / `llm_throw` / `cancel_mid_llm` 三种失败注入

详见 [`docs/integration/testing.md`](../integration/testing.md)。

#### 文档重组

- 原单文件 `INTEGRATION_GUIDE.md`（1049 行）拆分为 `docs/integration/` 17 个主题手册：`README` / `overview` / `installation` / `quickstart` / `llm-provider` / `tools` / `context-fences` ⭐ / `tool-history` / `persistence` / `run-supervisor` / `child-runs` / `audit` / `telemetry` / `realtime` / `testing` / `constraints-and-pitfalls` / `glossary`
- 从 `docs/integration/README.md` 进入；每个手册都是独立可读单元

### 0.3 🛠 Improved

- `toolHistoryCompressor` 默认策略从 `per-pair` 改为 `per-run`：prompt cache 命中率上升；token 平均 +20-40%；host 可显式 `strategy: 'per-pair'` 保留旧行为
- `AgentMessageOrchestrator` 改为按 request 创建 preprocessor pipeline：避免不同 agent 间策略串扰
- `ToolInteractionGroup.runOrdinal` 元数据：按 `user_input` 边界递增，提供 run 级别的工具组定位
- `findCurrentRunStartIndex`（原 `findCurrentRoundStartIndex` deprecated alias，1 sprint 后移除）
- `DEFAULT_MODEL_ID` 改名为 `TOKEN_ENCODING_NAME`（实际是 tiktoken encoding，不是 model id）
- `context-pipeline` fatal 判断改为 `ContextProviderError`（typed error + `code` + `fatal` + `providerName` + `cause`）；不再靠中文字符串
- `runtime-kernel/llm/caller.ts`（原 ~800 行）按职责拆为 5 个文件，全部 ≤ 250 行
- `runtime-kernel/events/eventMappers.ts`（原 ~751 行）按职责拆为 4 个 mapper 文件，全部 ≤ 250 行
- `runtime-kernel/child-runs/internalAgentInvoker.ts`（原 682 行）重命名 `childRunInvoker.ts`，拆分 trace sink / checkpoint recovery / child tool context / child run events，主文件降到 ~367 行
- 命名规范化：`subrun/` → `child-run-trace/`，公开 namespace 为 `runtimeKernel.childRunTrace`；事件 type `subrun_trace` 与 `SubRunTrace*` 协议类型保留（前端可继续按这个名字处理）

### 0.4 🏗 Internal（接入方可以忽略，仅作维护方记录）

- `no-host-leakage.test.ts` + `shared 禁止 import profiles` boundary guard（0.4.0 起 active）
- testkit run-harness 不再 deep import runtime-kernel 内部文件，全部走 runtime-kernel 公开入口（修复了 boundary guard 漏洞）
- linnsy 独立仓 detached run 协议已回流到 linnkit `RunSupervisor`（`spawnDetached` / `waitForTerminal` / `findActiveByConversation` / `drain` / `recoverOnBoot`）
- framework 演进路线、ADR 决策档案、隐患台账等内部档案统一在仓库 `docs/framework/`，不再随 npm tarball 发布

### 0.5 升级清单（外部接入方）

1. 升级到 `@linnlabs/linnkit@^0.5.0`
2. 检查是否还在用 `linnkitCompat` / `AgentProfileRequest` 的 host 产品字段 / `MessageFormatter` 的 `document_fragment` 隐式包装：按 §0.1 Breaking 表的对应迁移路径处理
3. 升级 host runner 装配（如果你已有）：注册 RunSupervisor + RunCostCollector + 接入 G-1 AuditPort；详见 [`docs/integration/run-supervisor.md`](../integration/run-supervisor.md)
4. 检查 `tool history` 策略：默认变为 `per-run`，绝大多数 host 不需要改；想保留旧行为在 `AgentDefinition.config.contextPolicy.toolHistory.strategy = 'per-pair'` 显式声明
5. 升级 testkit：把现有 `RunSupervisor`/audit/telemetry 测试改为 `createRunSupervisorHarness` + `validateRunInvariants` 形态

---

## 0. 决策表（2026-04-23 v3）

| 维度 | 选择 | 理由 |
|------|------|------|
| **包名** | `@linnlabs/linnkit`（scoped）| scope `@linnlabs` 是 linn 系列总品牌伞（不是单一产品名），未来 linnya / linnsy 都挂同 scope；`@linn`（被音响公司占）/ `@linnya`（被废弃 user 占）实测都不可注册 |
| **registry** | **npmjs.com 公开 registry** | 2026-05-13 核查：`npm view @linnlabs/linnkit --registry=https://registry.npmjs.org` 返回 `latest=0.7.0`；scope 与包名已被真实发布占住。0.8.0 起继续发 npmjs public。 |
| **何时发** | 已公开发布；0.8.0 继续走 npmjs public | 早期 GitHub Packages 私有版本作为历史存在；新接入方不再需要 `.npmrc` 或 GitHub token。 |
| **当前版本** | `0.8.0`（源码准备线；0.7.0 是上一条已发布基线）| 0.x = pre-release 期，不承诺 semver minor 兼容性，只承诺 patch 兼容；任何"加新 export / 改既有签名"都 bump minor |
| **稳定性边界** | 公开面 = `package.json#exports` 的 **8 条**可 import 子路径（根 `.` + 7 条子入口；另 `./package.json`；详见 §3）| 任何不在 exports 里的内部模块都不算 public API；接入方 deep import 视为越界 |
| **build 工具** | tsup（与 linnya backend 同款）| 输出 cjs + esm + .d.ts；与 **8 条**子路径一一对应 **8 份**主 dist（`./package.json` 不经 tsup；CLI 额外产出 `dist/cli.cjs` 供 `bin` 使用） |

---

## 1. 工程层 3 件套（已落地）

> 本节描述实施完成态。任何修订都必须把对应文件 + `package.shell.test.ts` 断言一起改。

### 1.1 build 流水（tsup → dist/）

权威文件：[`packages/linnkit/tsup.config.ts`](../../tsup.config.ts)

形态：

- `entry` 用 object map 给 **7 条**可 import 子路径都指定输出名，输出布局**与 `package.json#exports` 1:1**（`./package.json` 不经过 tsup，由 npm 原样打包）：
  - `.`                       → `dist/index.{js,cjs,d.ts}`
  - `./ports`                 → `dist/ports.{js,cjs,d.ts}`
  - `./contracts`             → `dist/contracts.{js,cjs,d.ts}`
  - `./runtime-kernel`        → `dist/runtime-kernel.{js,cjs,d.ts}`
  - `./runtime-kernel/events` → `dist/runtime-kernel/events.{js,cjs,d.ts}`（browser-safe slim seam）
  - `./context-manager`       → `dist/context-manager.{js,cjs,d.ts}`
  - `./testkit`               → `dist/testkit.{js,cjs,d.ts}`
- `format: ['cjs', 'esm']`、`platform: 'node'`、`target: 'node20'`、`dts: true`、`sourcemap: true`、`clean: true`
- `splitting: false`：多入口禁用 chunk 共享；保证 require/cjs 形态稳定，接入方任何 deep import 都自给自足
- `external: ['vitest', 'tiktoken']`：必须**同时**在 `package.json#dependencies` 或 `peerDependencies` 出现，且**所有**第三方 import（src/ 里非 node-builtin / 非自身 alias）必须满足这两条 — 否则 tsup 默认会把整个包 inline 进 dist，wasm/native 资源会丢失（0.1.0~0.1.2 tiktoken 灾难即此原因，详见 [RELEASE-HISTORY §C.5](./RELEASE-HISTORY.md#c5-013-2026-04-24--packaging-fix-tiktoken-external--declared-dep)）。`package.shell.test.ts` 的 src 反向稽核 + `package.runtime-import.test.ts` 的子进程 import 烟雾测试双重守护这条规则

约束（违反即 break）：

- **7 份 dist 入口必须全部 emit**（根 + `ports` / `contracts` / `runtime-kernel` / `runtime-kernel/events` / `context-manager` / `testkit`）；缺一个 = `package.shell.test.ts` 红 + CI workflow 红
- `./runtime-kernel/events` 的 dist 必须 **browser-safe**——禁止引入 `node:async_hooks` / `crypto` / `fs` / `os` / `path`；2026-04-23 首次 build 已验证产物里无任何 `node:*` 引用

### 1.2 `package.json` 已切到发包形态

权威文件：[`packages/linnkit/package.json`](../../package.json)

要点：

- `name`：`@linnlabs/linnkit`
- `version`：`0.8.0`（TokenizerPort minor；版本号策略见 §4，历次发版见 [`RELEASE-HISTORY.md §C`](./RELEASE-HISTORY.md#c-历次-release-发版历程)）
- 不再设 `private`
- `type`：`module`；`main` / `module` / `types` 都指 `./dist/index.{cjs,js,d.ts}`
- `exports`：**8 条**子路径（根 `.` + 上述 7 个）+ `./package.json`；除 `./package.json` 外每个都是 conditional export（`types` / `import` / `require` 三件套）
- `dependencies`（0.1.3 起）：`{ "tiktoken": "^1.0.22" }` —— TokenCalculator → llmTelemetryMiddleware / context-manager 用，自带 wasm 必须从 tiktoken 包目录加载，不能 inline
- `peerDependencies`：`zod` 必需；`vitest` optional —— 仅 testkit 入口在 vitest 上下文里用；不接 testkit 的消费者不需要装
- `files`：`["dist", "LICENSE", "CHANGELOG.md", "README.md", "README.zh-CN.md", "docs/README.md", "docs/integration", "docs/release"]` —— 不发 `src/**/*.ts`、不发 `docs/framework/`、不发 `docs/archive/`、不发 `docs/99-research-notes/`、不发 `docs/DEVELOPMENT_GUIDE.md` / 旧 `docs/INTEGRATION_GUIDE.md`（兜底见 `.npmignore`）
- `publishConfig`：`registry: https://registry.npmjs.org/`、`access: public`、`provenance: true`
- `repository.directory`：`packages/linnkit`（npm 识别 monorepo 子包）
- `scripts`：`build` / `build:clean` / `prepublishOnly` / `publish:npm` / `publish:dry-run` / `test:smoke`（0.1.3 起聚合 package.* 测试） / `typecheck`
- `linnkit.notes`：各版本叙事 + 不变量（首条为当前最新发版说明；0.1.3 packaging、events slim、双别名、`0.x` semver 等）由 `package.shell.test.ts` 与人工维护；**勿**在 notes 里写对外的长接入教程——那属于 [`docs/integration/`](../integration/)

`.npmignore`（权威：[`packages/linnkit/.npmignore`](../../.npmignore)）作为 `files` 白名单的兜底黑名单，把 `src/**/*.ts`、`__tests__/`、`tsup.config.ts`、`tsconfig.json` 等开发期文件挡掉。

### 1.3 monorepo 内 linnya 怎么继续工作？—— **paths/alias 平行别名**

**关键事实**：linnya 主仓不通过 node_modules 解析 linnkit。它一直靠三处 alias 直读 `packages/linnkit/src/`：

| 配置文件 | 作用 |
|----------|------|
| [`tsconfig.json#compilerOptions.paths`](../../../../tsconfig.json) | TypeScript 类型解析 |
| [`vite.config.mjs#resolve.alias`](../../../../vite.config.mjs) | electron renderer 运行时 |
| [`vitest.config.ts#resolve.alias`](../../../../vitest.config.ts) | 单测运行时 |

所以 `customConditions: ["linnya-dev"]` 这种 conditional exports 方案在 linnya 这条路径上**不会被触发**。`exports` 字段只在 Node/打包器走 `node_modules/@linnlabs/linnkit/package.json` 时才生效，而 linnya 根本不读它。

正确的做法：**两套别名同时登记到同一份 src**。

linnya 三处 alias 在 `linnkit*` 系列的基础上，**平行**加一份 `@linnlabs/linnkit*`：

| 别名（旧） | 别名（新真包名） | 解析到 |
|------------|------------------|--------|
| `linnkit` | `@linnlabs/linnkit` | `packages/linnkit/src/index.ts` |
| `linnkit/ports` | `@linnlabs/linnkit/ports` | `packages/linnkit/src/ports/index.ts` |
| `linnkit/contracts` | `@linnlabs/linnkit/contracts` | `packages/linnkit/src/contracts/index.ts` |
| `linnkit/runtime-kernel` | `@linnlabs/linnkit/runtime-kernel` | `packages/linnkit/src/runtime-kernel/index.ts` |
| `linnkit/runtime-kernel/events` | `@linnlabs/linnkit/runtime-kernel/events` | `packages/linnkit/src/runtime-kernel/events/index.ts`（**前缀必须排在 `runtime-kernel` 之前**，否则被前缀劫持，把 Node-only 子树拖进 frontend bundle） |
| `linnkit/context-manager` | `@linnlabs/linnkit/context-manager` | `packages/linnkit/src/context-manager/index.ts` |
| `linnkit/testkit` | `@linnlabs/linnkit/testkit` | `packages/linnkit/src/testkit/index.ts` |

效果：

- linnya 主仓 ~170 处 `import 'linnkit'` / `import 'linnkit/...'` **零成本保留**（兼容旧名）
- 新代码、`linnsy` daemon、任何外部消费者都用真包名 `@linnlabs/linnkit`
- 两组别名指向同一份 src，dev 体验完全一致
- `package.shell.test.ts` 同时断言两组 alias 的存在，删旧别名前必须先 codemod 把全部 `import 'linnkit'` → `import '@linnlabs/linnkit'`

> **未来路径**：S1+ 任意时机做一次性 codemod 把 linnya 内全部 `linnkit*` 旧名改成 `@linnlabs/linnkit*`，然后从三处 alias 删掉旧条目，保留单一名字。这是独立 PR，不阻塞 linnsy。

---

## 2. npmjs 发布配置

### 2.1 发布方法（当前推荐：本地交互发布）

GitHub 只做开源源码展示；npm 包发布从本地发到 npmjs。不要折腾临时 granular token，容易卡在 scope/package write 权限或 2FA。

```bash
# monorepo 中先 cd packages/linnkit；独立 linnkit 仓在仓库根目录执行即可
npm run typecheck
npm run build:clean && npm run build
npm run test:smoke && npm run test:smoke:dist
npm run publish:dry-run
npm publish --provenance=false --access public --registry https://registry.npmjs.org/
```

`npm publish` 如果提示网页登录认证，按回车打开浏览器确认即可；成功后用下面命令确认 latest：

```bash
npm view @linnlabs/linnkit version dist-tags.latest --registry https://registry.npmjs.org/
```

说明：

- 本地发布用 `--provenance=false`，因为 `publishConfig.provenance=true` 适合 GitHub Actions/OIDC，本地没有 provenance provider。
- `prepublishOnly` 会自动重新 build + smoke test；上面手动跑一遍是为了发布前先失败。

### 2.2 CI 发布（历史/可选）

权威文件：[`.github/workflows/release-linnkit.yml`](../../../../.github/workflows/release-linnkit.yml)

形态：

- 触发：push tag `linnkit-v*` 或 `workflow_dispatch`（手动；带 `dry_run` 选项）
- 步骤（在 `packages/linnkit` 工作目录）：
  1. checkout
  2. `actions/setup-node@v5`（registry-url=`https://registry.npmjs.org/`、scope=`@linnlabs`，自动注入 `NODE_AUTH_TOKEN`）
  3. 根目录 `npm ci`（拉 tsup / vitest 等）
  4. **校验 `package.json#name === '@linnlabs/linnkit'`**（防误改）
  5. **校验 git tag 版本号 === `package.json#version`**（防 tag 漂移；只在 push 触发时校验）
  6. `npm run test:smoke` → `npm run build`
  7. **校验 dist 入口产物全部就位**（`index` / `ports` / `contracts` / `runtime-kernel` / `runtime-kernel/events` / `context-manager` / `testkit` / `quickstart` / `cli` 各 3 件套，缺一即红）
  8. `npm pack --dry-run` 一份 tarball 摘要到日志
  9. `npm publish`（dry-run 模式跳过；`publishConfig.provenance=true`，workflow 需要 `id-token: write`）

发版操作：

```bash
# 在 packages/linnkit 改完代码（版本号按 §4 策略手动改或 npm version）
cd packages/linnkit
npm version 0.6.0 --no-git-tag-version          # 示例：只 bump package.json，不自动 tag
git add package.json docs/release/RELEASE.md docs/release/RELEASE-HISTORY.md && git commit -m "chore(linnkit): release 0.6.0"

# 在仓库根打语义化 tag（前缀必须是 linnkit-v，与 workflow on.push.tags 对齐）
git tag linnkit-v0.6.0
git push origin main linnkit-v0.6.0
```

CI 看到 `linnkit-v*` tag 就自动校验 + build + publish 到 npmjs.com。当前常规发布优先走 §2.1 的本地交互发布。

### 2.3 消费者侧（linnsy 仓 / 任何接入方）

新接入方不需要 `.npmrc`，直接使用默认 npmjs registry：

`package.json` 装 dep（**新接入方**直接跟当前公开最新版；本文写稿时 npmjs `latest=0.7.0`，0.8.0 发布后升级到 `^0.8.0`）：

```jsonc
{
  "dependencies": {
    "@linnlabs/linnkit": "^0.8.0"
  }
}
```

> **注意（历史版本）**：`^0.1.0` ~ `^0.1.2` 在 npm semver 下虽然能解析到 0.1.3，但是**强烈建议**至少写 `^0.1.3`——0.1.0~0.1.2 三个版本里 `import @linnlabs/linnkit/runtime-kernel` 会立即报 `Missing tiktoken_bg.wasm`（详见 [RELEASE-HISTORY §C.5](./RELEASE-HISTORY.md#c5-013-2026-04-24--packaging-fix-tiktoken-external--declared-dep)）。需要 **0.2.x** 侧车 replay / context fence 等能力时，以 **`^0.2.0`** 为下限。`0.3.0` 删除 `linnkitCompat` 且收紧工具类型边界；`0.4.0` 删除 framework legacy host context 字段并冻结 chat namespace；`0.5.0` 引入 AgentSpec / RunSupervisor / AuditPort 协议且 docs 重组为 `docs/integration/` 主题手册；`0.6.0` 进一步开放 Context Engineering 配置面——外部消费者升级前请先跑 typecheck。

> 如果旧项目曾配置 `@linnlabs:registry=https://npm.pkg.github.com/`，请删除这条 scope registry override，否则 npm 会继续去 GitHub Packages 找包。

> linnya 主仓本身仍通过 paths/alias 直读 src（详见 §1.3）；等独立仓切换时再决定改成 `node_modules/@linnlabs/linnkit` 还是保留 mirror。

---

## 3. 公开 API 边界（凡是不在这里的都是私有）

| 子入口 | 用途 | 稳定性承诺 |
|--------|------|------------|
| `@linnlabs/linnkit` | 框架总入口 | 0.x = patch 兼容，minor 可能 break |
| `@linnlabs/linnkit/ports` | host 必须实现的 ports | ⭐ 最核心稳定面 |
| `@linnlabs/linnkit/contracts` | host ⇔ engine 共享 contracts / 类型；**v0.1.1 起也是 `EventEnvelope` / `ExecutionTraceContext` / `SSEEvent` 全系列 + `createSSE*` 工厂 + `DEFAULT_MAX_STEPS` 的真源**（D-5 schemas detach round 2 完成后从 `@app/schemas` 内化）| ⭐ 最核心稳定面 |
| `@linnlabs/linnkit/runtime-kernel` | runtime 全展开（**Node-only**）| 内部演进可能频繁；接入方装配时小心 |
| `@linnlabs/linnkit/runtime-kernel/events` | events governance 纯函数（**browser-safe**） | ⭐ slim seam，**永远不允许引入 Node-only 依赖** |
| `@linnlabs/linnkit/context-manager` | 上下文子系统；**0.2.x 起**含 fence 族（`FenceRegistry` / `context_injection` 等；操作步骤见 [`INTEGRATION_GUIDE.md`](../INTEGRATION_GUIDE.md) **§5.4**） | preprocessor / provider 可能新增；`exports` 级符号按 §4 策略演进 |
| `@linnlabs/linnkit/testkit` | **测试代码专用**（生产路径禁用，由 `AGENT-GUARD-10` 强制）| 测试夹具签名稳定 |

**红线**：

- ❌ 接入方禁止 deep import `@linnlabs/linnkit/runtime-kernel/internal/...` 之类路径（exports 不暴露 = 私有）
- ❌ 接入方生产代码禁止 import `@linnlabs/linnkit/testkit`（与 linnya 同款 `AGENT-GUARD-10-no-testkit-in-production` 守门规则）
- ❌ 0.x 期间不接受 "linnkit 帮我加协议" 的请求；按 [`docs/framework/04-protocol-roadmap.md`](../framework/04-protocol-roadmap.md) 的 4 thresholds 评估

---

## 4. 版本号策略（0.x 期间）

| 改动类型 | bump 哪一位 | 例 |
|----------|-------------|-----|
| bug fix / 实现优化 / 不改 exports / 不改既有签名 | **patch** | 0.1.0 → 0.1.1 |
| 新增 exports / 既有 export 加可选参数 / 新增 type | **minor** | 0.1.x → 0.2.0 |
| 删除 exports / 改既有签名 / 删 type / 改运行时行为破坏既有调用 | **minor**（0.x 期）| 0.1.x → 0.2.0 |
| 进入"长期稳定承诺"阶段 | **major 1.0.0** | 0.x → 1.0.0 |

> 0.x 期间不区分 minor 和 break——都 bump minor。这是 npm 0.x 惯例，让接入方 `^0.1.0` 不会偶然吃到 break。

---

## 5. 发版你要做什么（现行）

> 本节是 **每次 bump 前真正要执行** 的内容。下面 **§5.1** 即「Release-time 机械检查」；旧文里那套 **S0 的 5.1~5.9 全打勾长清单** 已全部闭合，**继续贴在 mainline RELEASE 里只会占版面、和 §8 / [`RELEASE-HISTORY.md`](./RELEASE-HISTORY.md) 重复**——已收掉，考古请只读 HISTORY。

### 5.1 每次 patch / minor release 前必跑（3 条）

> 2026-04-24 沉淀。0.1.1 首发连撞 2 坑就是因为这 3 条没跑全；CI 能兜底，但提前跑能直接避免红。

- (a) bump version 的 commit 后 `git diff HEAD~1 -- packages/linnkit/package.json` 必须看到 `version` 行变化
- (b) `git status --short` 必须**完全为空**才允许打 release tag（任何 untracked / modified 都先解决——尤其新建文件容易被 `git commit -am` 漏掉）
- (c) 本地 `npm --prefix packages/linnkit run build` 且 `npm --prefix packages/linnkit run test:smoke`（与 `prepublishOnly` 一致）全绿再 push `linnkit-v*` tag

**版本号 bump 位** 见 **§4**。打 tag / CI 发布 见 **§2.1**。

### 5.2 S0 年代实施项（5.1~5.9，已闭合）

S0（约 2026-04）里做过的「加 tsup 七入口、exports、GitHub org `linnlabs`、PAT、workflow dry-run、0.1.x 首发、linnsy daemon 首装…」**逐条长叙事、踩坑、版本线** 只在 [`RELEASE-HISTORY.md` §A / §C](./RELEASE-HISTORY.md) 保留；**不要**在本文再维护一份全 `[x]` 清单——读者要发 **0.2.x** 时那几行历史帮助为零。

若外部文档（如 linnsy 旧 sprint）仍写「见 RELEASE §5 checklist」→ **含义已迁移**：现行 checklist = 本文 **§5.1** + §2.1 + §4。

---

## 6. 与已有文档的关系

| 文档 | 关系 |
|------|------|
| [`packages/linnkit/docs/README.md`](../README.md) | 框架总览、分层、数据流；**不**承担逐步装包教程 |
| [`packages/linnkit/docs/DEVELOPMENT_GUIDE.md`](../DEVELOPMENT_GUIDE.md) | 本仓开发 / boundary guard / 改 linnkit 源码流程 |
| [`packages/linnkit/docs/INTEGRATION_GUIDE.md`](../INTEGRATION_GUIDE.md) | **外部消费者主入口**（`@linnlabs/linnkit`、7 子路径、鉴权、fence、单点接入）；**0.2.1** 起与本文分工见上文「文档分工」表（**0.2.2** 起 `docs/README` §5.2 与子路径数一致） |
| [`framework/08` · `framework/09`](../framework/08-context-engineering-package-boundary.md) | context engineering 边界与 fence **设计**（长文）；**操作步骤**以 [`INTEGRATION_GUIDE`](../INTEGRATION_GUIDE.md) §5.4 为准 |
| [`packages/linnkit/docs/framework/04-protocol-roadmap.md`](../framework/04-protocol-roadmap.md) | 升级判定 4 thresholds；本文不动 |
| [`linnsy/02c-tech-stack.md`](../../../../linnsy/02c-tech-stack.md) | linnsy 技术栈；§3 deps 草稿是 linnkit 发包的第一个消费者 |
| [`linnsy/plan/phase1/02-sprint-plan.md`](../../../../linnsy/plan/phase1/02-sprint-plan.md) | 历史 sprint 曾指「本文 §5」；**现行**发版以本文 **§5.1** + **§2.1** 为准（S0 长清单已收进 [RELEASE-HISTORY.md](./RELEASE-HISTORY.md)） |
| [`RELEASE-HISTORY.md`](./RELEASE-HISTORY.md) | 本文伴生文件——修订记录全文 / 历次发版长叙事 / 0.1.1 连撞 2 坑教训 / PAT rotate runbook |

---

## 7. 独立 repo 路线（linnkit 开源前硬前置）

> 本节回答一个问题：linnkit 已经能从 npmjs.com 公开安装后，要不要立刻从 linnya monorepo 拆成独立 public repo？
> **答**：如果只是验证外部 `npm install`，可以先保留 monorepo；但如果要正式开源 linnkit 源码，独立 repo 是硬前置。linnya 暂时不开源，不能让公开 npm 包的源码链接指向私有 monorepo。

### 7.1 决策与触发条件

**决策**：npmjs 发布口径先收口到 `@linnlabs/linnkit` public package；正式开源 linnkit 前必须创建 `github.com/linnlabs/linnkit` public repo，并把 npm manifest 的 `repository` / `homepage` / `bugs` 指向新仓。

**判断依据**（2026-04-24 与 owner 对齐）：
- npmjs 公开包已经解决"外部用户零配置 install"这个硬门槛，但没有解决"源码可见 / issue 可提 / PR 可开"。
- linnya 暂时不开源，因此当前 monorepo 不能作为 linnkit 的公开 source repository。
- 如果 npm 包 metadata 继续指向 `BCAutumn/Tingtalk_official_version/tree/main/packages/linnkit`，外部用户会点到私有仓或业务仓，这不符合开源框架的基本预期。
- 继续留在 monorepo 只适合作为**发布前过渡**，方便 linnya/linnkit 联动开发；正式宣布开源前必须抽仓。

**触发时机**：准备对外说"linnkit 开源"之前启动独立仓拆分；不再等外部 issue/PR 常态化。

**当前建议**：短期可以继续用 npmjs public package 验证 install；但在 0.8.0 正式开源 announcement 前，先完成 `linnlabs/linnkit` 独立仓、manifest 链接切换、CI 重建、codename 体检。

### 7.2 当前准备度评估（已就位 vs 待办）

| 维度 | 状态 | 备注 |
|------|------|------|
| **scope 命名** | ✅ 已被真实包占住 | npmjs.com `@linnlabs/linnkit` 已有公开版本；`npm view @linnlabs/linnkit --registry=https://registry.npmjs.org` 返回 `latest=0.7.0`。 |
| **包名** | ✅ 已是终态 | `@linnlabs/linnkit` 两边通用 |
| **dist 自包含** | ✅ D-5 兑现 | runtime零 `@app/schemas` / 零 monorepo 跨包依赖；独立 repo 时把 `packages/linnkit/` 整棵子树原样搬走即可，不需要再 detach |
| **公开 API 边界** | ✅ §3 锁死 + smoke test 守门 | `package.shell.test.ts` 把 7 个 entry 的 conditional exports 钉死，外部消费者只能走 §3 表里的入口 |
| **版本号策略** | ✅ §4 锁死 | 0.x semver 约定不变 |
| **dev 体验过渡机制** | ✅ paths/alias 平行别名已在 | 独立 repo 后建议先在 linnya monorepo 保留 `packages/linnkit/` 作为 read-only mirror 或 git subtree mirror；linnkit 修改只在独立仓做。这样 linnya 暂不公开也能继续本地开发。 |
| **CI publish 流水** | ✅ `.github/workflows/release-linnkit.yml` 已在 | 独立 repo 后整文件搬过去；`NODE_AUTH_TOKEN` 改用 npmjs 的 access token（不再需要 PAT for cross-owner） |
| **registry 切换** | ✅ 已完成 | 0.8.0 源码线 `publishConfig.registry=https://registry.npmjs.org/`、`access=public`、`provenance=true`；workflow 使用 npmjs `NPM_TOKEN`。 |
| **LICENSE** | ✅ 已完成 | MIT，随 npm tarball 发布。 |
| **CONTRIBUTING.md / issue 模板** | ✅ 已完成 | `CONTRIBUTING.md` + `.github/ISSUE_TEMPLATE/` 已有；`SECURITY.md` / `CODE_OF_CONDUCT.md` 当前显式跳过。 |
| **README 语言** | ⚠️ 待办 | 当前中文。开源后建议双语（英文为主、中文为辅），或英文为主。决策点：linnkit 目标用户群是中文圈还是国际？独立时再决 |
| **codename 体检** | ⚠️ 待办 | 全包 grep 一遍：是否有内部业务名 / 客户名 / 内部 prompt / 敏感字符串 / 调试信息？独立前必须扫干净 |
| **commit history** | ⚠️ 待办 | 必须用临时 clone + `git filter-repo --path packages/linnkit/ --path-rename packages/linnkit/:` 抽出子树 history；不要把 linnya 业务历史带进公开仓。 |
| **trademark 检索** | 优先级低 | linnkit / linnlabs 是否需要 trademark search？独立前评估，不阻塞 |

**读法**：✅ 6 项（核心工程层）= 独立 repo 这事工程上**已经准备好**，剩下 ⚠️ 7 项都是开源所需的**外围品控**，可以分散到 phase 1 期间慢慢做（"平时改代码时顺手清"），到独立那一刻就全准备好了。

### 7.3 触发动作清单（phase 1 中后期执行）

按依赖顺序：

- [ ] **7.3.1 创建 `github.com/linnlabs/linnkit` public repo**（空仓 + 默认 main + 加 README placeholder）
- [ ] **7.3.2 用 `git filter-repo --subdirectory-filter packages/linnkit/` 抽出 linnkit 子树 commit history** → 推到新 repo
- [ ] **7.3.3 在新 repo 加 LICENSE / CONTRIBUTING.md / Code of Conduct / issue 模板 / PR 模板** —— 内容前置在 §7.2 ⚠️ 各项里准备好
- [ ] **7.3.4 README 英化（或双语）** —— 当前 `docs/README.md` / `docs/INTEGRATION_GUIDE.md` / `docs/DEVELOPMENT_GUIDE.md` 全部中文，独立时一并处理
- [ ] **7.3.5 codename 体检**：全包 grep 内部业务名 / 客户名 / 敏感字符串 / 调试信息，清干净
- [x] **7.3.6 切 publish 目标到 npmjs.com**：workflow yml `registry-url: https://registry.npmjs.org/`、`scope: '@linnlabs'`；发布 token 改为 npmjs `NPM_TOKEN`；`package.json#publishConfig` 改为 npmjs public + provenance。
- [x] **7.3.7 第一次发到 npmjs**：已能通过 `npm view @linnlabs/linnkit --registry=https://registry.npmjs.org/` 查到公开包；当前 `latest=0.7.0`。
- [ ] **7.3.8 在独立仓内改 npm manifest**：`repository.url` → `git+https://github.com/linnlabs/linnkit.git`；删除 `repository.directory`；`homepage` → `https://github.com/linnlabs/linnkit#readme`；`bugs.url` → `https://github.com/linnlabs/linnkit/issues`。
- [ ] **7.3.9 linnya monorepo 过渡策略**：暂不公开 linnya；优先保留 `packages/linnkit/` 作为 read-only mirror / subtree mirror，或改为 npm 依赖。二选一必须在迁仓 PR 里明确，避免双源同时可写。
- [ ] **7.3.10 同步外部接入方文档**：外部仓不再需要 GitHub Packages `.npmrc`；若旧项目保留 `@linnlabs:registry=https://npm.pkg.github.com/`，需要删除。
- [ ] **7.3.11 独立仓前观察期**：linnkit 在 npmjs.com 至少跑过 1 ~ 2 个 0.8.x patch，install / 装配 / dist 完整性都被真实场景验证过。

### 7.4 阶段性 deadline（视 linnsy 进度调整）

| 节点 | linnsy 状态 | linnkit 状态 |
|------|------------|------------|
| 当前 | npmjs 公开包已可安装 | 保留 monorepo 子目录，仅作为 install 链路验证；不把这等同于"源码已开源" |
| 正式 open-source announcement 前 | linnya 暂不公开 | 必须执行 §7.3 独立仓动作清单，公开 `linnlabs/linnkit`，并切 manifest 链接 |
| announcement 后 | 外部 issue/PR 进入新仓 | linnya 继续私有；通过 npm 依赖或 read-only mirror 消费 linnkit |

### 7.5 与本文之前章节的关系修订

§0 v3 / v4 修订记录里"等以后把 linnkit source 迁到 linnlabs/linnkit 独立仓时..."等暗示性描述，**升级为本 §7 的明确路线**。npmjs 公开发布已经完成；但由于 linnya 暂不公开，linnkit 正式开源前必须完成独立 repo。本节是这条路径的**单一权威**。

---

## 8. 当前状态总览

> 详细发版历程见 [RELEASE-HISTORY.md §C](./RELEASE-HISTORY.md#c-历次-release-发版历程)。

| 维度 | 状态 |
|------|------|
| 工程层 §1 ~ §4（tsup / paths-alias 双名机制 / API 边界 / 版本号策略） | ✅ 2026-04-23 落地 |
| 凭据层 §5.5（GitHub `linnlabs` org / dedicated PAT） | ✅ 2026-04-23 落地 |
| 0.1.0 首发（GitHub Packages） | ✅ 2026-04-23 落地（manifest URL 三件套有瑕疵，0.1.1 修正） |
| 0.1.1 patch（D-5 schemas detach + manifest 修正 + Actions v5） | ✅ 2026-04-24 落地（连撞 2 坑全被 CI 兜住，npm 零污染） |
| 0.1.2 patch（docs/ 文档架构重组 + package.files/.npmignore 同步刷新） | ✅ 2026-04-24 落地（运行时 dist 字节级一致；纯包结构 patch） |
| 0.1.3 patch（tiktoken external + `dependencies` 声明；外部可 import 7 入口） | ✅ 2026-04-24 — 详见 [RELEASE-HISTORY §C.5](./RELEASE-HISTORY.md#c5-013-2026-04-24--packaging-fix-tiktoken-external--declared-dep) |
| 0.2.0 minor（provider sidecar replay：`reasoning_details` / `provider_sidecar` / tool replay policy） | ✅ 2026-04-26 — 详见 [RELEASE-HISTORY.md · §C.6](./RELEASE-HISTORY.md#c6-020-minor-release2026-04-26--provider-sidecar-replay-upgrade) |
| 0.2.1 patch（`INTEGRATION_GUIDE` 外部装包消费者手册） | ✅ 2026-04-27 — 详见 [RELEASE-HISTORY · §C.7](./RELEASE-HISTORY.md#c7-021-patch-release2026-04-27--docs-integration_guide-npm-consumer-rewrite) |
| 0.2.2 patch（`README` / `RELEASE` / `RELEASE-HISTORY` 文档收敛） | ✅ 2026-04-27 — `dist` 与 0.2.1 一致；详见 [RELEASE-HISTORY · §C.8](./RELEASE-HISTORY.md#c8-022-patch-release2026-04-27--docs-readmereleasehistory) |
| 0.3.0 minor（stage 0 cleanup：工具泛型边界、compat 删除、typed provider error、LLM/events 拆分） | 🟡 2026-05-11 源码准备线；并入 0.5.0 发版线 |
| 0.4.0 minor（Phase E boundary cleanup：framework legacy context 清扫、fence-first、no-host-leakage guard） | 🟡 2026-05-12 源码准备线；并入 0.5.0 发版线 |
| 0.5.0 minor（Phase F P0 三件：AgentSpec / RunSupervisor / AuditEnvelope + testkit 15 不变量 + docs 拆分 docs/integration/）| ✅ 2026-05-12 已发布基线 |
| 0.6.0 minor（Context Engineering 协议化：细粒度 contextPolicy + ContextTrace + ObservationPreviewPort + providerReplay + ContextCheckpointTool）| 🟡 2026-05-13 源码准备线；待 tag/publish |
| §5.8 ~ §5.9（linnsy daemon 装包验证 + 02c-tech-stack 复核） | ✅ 首发链路已跑通（0.1.x）；**新消费者**发布后请直接依赖 **`^0.6.0`**，发布前继续用 **`^0.5.0`** 或至少 `^0.1.3`，见 §2.3 |
| §7 独立 repo + npmjs 公开路线 | ✅ 拍板（执行点 = linnsy phase 1 中后期）；npmjs `@linnlabs` scope 已抢注锁定 |
