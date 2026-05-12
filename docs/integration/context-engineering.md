# Context Engineering · linnkit 的上下文工程总览

> linnkit 的宗旨：**让上下文工程变成精细化、可自由配置、可观测、可审计的事**。
>
> 本文是一份**全机制速查表**：列出 linnkit 当前所有作用在"发给 LLM 的 messages"上的机制，**说人话**讲清楚它在做什么、什么时候触发、在哪里改它、当前可以配到什么粒度。
>
> 想看 fence 一等接入面的具体落地骨架，跳到 [`context-fences.md`](./context-fences.md)。
>
> **2026-05-13 状态提示**：F1.1-F1.14 已把 `AgentSpec.contextPolicy` 扩展到 12 大分组，并把 `mustKeep` / `workingMemory` / `checkpoint` / `tokenEstimation` / `reasoningRetention` / `summarization` / `systemReminder` / `contextTrace` / `toolOutput` / `providerReplay` 接到运行时。接入方现在可以通过声明式 `contextPolicy` 控制上下文，并用 `ContextTrace` 验证最终 token 决策。

---

## 0. 一张总览图（一轮请求里发生了什么）

```text
host 发出 invoke request
  │
  ▼
[A] AgentMessageOrchestrator 装配
    ├─ contextPolicy.mustKeep（哪些消息绝不能被裁）
    ├─ FenceRegistry（host 注册了哪些围栏家族）
    └─ Preprocessor pipeline 按 request 重建
  │
  ▼
[B] Preprocessor Pipeline（按优先级跑）
    1. ToolHistoryCompressorPreprocessor   ─ 工具历史压缩
    2. ToolReplayProtocolGuardPreprocessor ─ 工具回放协议守卫
    3. HistoryPurificationPreprocessor     ─ 历史净化（清孤儿 / 同 ID 去重）
    4. FenceLifetimePreprocessor           ─ 剥离旧轮 turn-only fence
  │
  ▼
[C] ContextProvider 三阶段填充
    1. AgentCoreContextProvider          ─ 不可裁的核心层（system / user）
    2. AgentWorkingMemoryProvider        ─ 工作记忆按 P1-P4 优先级填到预算上限
    3. CheckpointSummarizationProvider   ─ checkpoint 前的旧轮裁干净
    4. (自动触发) SummarizationProvider   ─ 超预算时整段历史摘要
  │
  ▼
[D] applySystemReminderStage 注入
    根据 stepCount / phase / 工具调用次数等触发规则
    在最后一条 message 末尾追加 <system-reminder>...</system-reminder>
  │
  ▼
[E] formatAgentLlmMessages 出关
    根据 fence formatter / 物理 role 把所有 AiMessage 翻译成 LLM wire messages
  │
  ▼
LLM provider
```

每个阶段都有独立的配置面。下面一段一段讲。

---

## 1. 消息的三大角色与物理位置

linnkit 的内部消息（`AiMessage` union）最终都会按 LLM 协议的三个 role 出关：

| Role | 这里有什么 |
|------|-----------|
| `system` | `system_prompt`、`placement: 'after-system'` 的 fence（不常变化的固定上下文），例如长期记忆、项目元信息、用户偏好等 |
| `assistant` | LLM 自己产的 `final_answer` / `thought`（reasoning_content）/ `tool_calls`；以及配对的 `tool_output`（在物理 wire 上挂 `tool` role） |
| `user` | 用户的 `user_input`、`placement: 'before-current-user'` / `'after-current-user'` 的 fence（经常变化的高频上下文）、例如用户上传的文件、当前时间等以及触发后的 `<system-reminder>` 注入 |

**重要不变量**：`tool_calls` 和 `tool_output` **必须成对出现**——任何一边丢了另一边就废了。这条不变量贯穿所有压缩 / 裁剪机制。

---

## 2. Fence 围栏家族（高度可配置 ✅）

**一句话**：把任何"想塞给 LLM 的额外上下文"声明成一个家族（kind），告诉 linnkit"放哪、活多久、是否必保留、最多占多少预算"，linnkit 帮你按规则塞进 messages、按生命周期清掉。

**配置位置**：host 启动时调 `createFenceRegistry(descriptors)`，每条 `FenceDescriptor` 包含：

| 字段 | 含义 | 取值 |
|------|------|------|
| `kind` | 围栏家族名 | host 自定义 kebab-case |
| `llmRole` | 物理挂到哪个 role | `'system'` / `'user'` |
| `placement` | 物理位置 | `'after-system'` / `'before-current-user'` / `'after-current-user'` / `'after-last-tool-result'` |
| `lifetime` | 活多久 | `'turn-only'`（只本轮）/ `'persisted'`（进 history） |
| `mustKeep` | 是否在 working memory 抽稀时必保留 | `boolean` |
| `maxBudgetFraction` | 单类 fence 最多占总预算多少 | `(0, 1]` |
| `formatter` | 怎么把内容包装成 LLM 看到的字面 | host 提供函数 |

**开放状态**：完全开放。详细装配骨架见 [`context-fences.md`](./context-fences.md)。

---

## 3. MustKeepPolicy（通过 `contextPolicy.mustKeep` 配置 ✅）

**一句话**：声明"哪些消息**永远不能**被工作记忆抽稀机制裁掉"——比如 `system_prompt`、最新的 `user_input`、某类 fence kind。

**配置位置**：优先写在 `AgentSpec.contextPolicy.mustKeep`。host 也可以提供 fallback policy，作为所有 agent 的默认值。

```ts
contextPolicy: {
  profileId: 'agent',
  mustKeep: {
    alwaysKeepTypes: ['system_prompt', 'user_input'],   // 按 AiMessage.type
    alwaysKeepFenceKinds: ['system-event'],              // 按 fence kind
    truncationRules: [
      // 想限量截断（不丢但只保留预算的 X%）
      { fenceKind: 'memory-context', maxBudgetFraction: 0.2, strategyName: 'memory-truncate' },
    ],
  },
}
```

**默认值**：`DEFAULT_MUST_KEEP_POLICY` 已经把 `system_prompt` / `user_input` 等核心 type 列进 alwaysKeepTypes。

**开放状态**：`AgentSpec.contextPolicy.mustKeep` 已完成运行时接线。host 可以提供 fallback policy，单个 agent 可以通过 spec 覆盖；例如 `additional-context` 这类产品语义应属于 host fallback，不写进 linnkit framework。

---

## 4. Preprocessor Pipeline（4 个内置预处理器）

这一层在"消息进 ContextProvider 之前"跑。按 priority 顺序执行；任何一个抛 fatal `ContextProviderError` 都会中断 pipeline。

### 4.1 ToolHistoryCompressorPreprocessor —— 工具历史压缩（AgentSpec 高度可配置 ✅）

**一句话**：把旧的 `tool_calls` + `tool_output` 配对压缩成简短的 assistant 文本，控制工具历史不无限膨胀。

**三种策略**：

| strategy | 行为 | 适用 |
|----------|------|------|
| `'per-pair'` | 保留最近 N 个**工具对**，更早的全部压缩 | 4K/8K 模型、token 极度紧张 |
| `'per-run'`（**默认**） | 保留最近 K 个 **run**（用户输入边界）的完整工具序列 | 主流场景：prompt cache 命中率友好、不腰斩同一意图工具链 |
| `'none'` | 不做常规压缩 | 200K+ 长 context 模型 |

**安全阀**：`maxInteractionGroups` 硬上限 + `overflowStrategy`（`'keep-latest'` 自愈 / `'fail-fast'` 报错）。

**配置位置**：每个 agent 在 `AgentDefinition.config.contextPolicy.toolHistory` 显式声明。完整字段：

```ts
contextPolicy: {
  toolHistory: {
    strategy: 'per-run',           // 默认
    keepLatestRuns: 1,             // per-run 用
    keepLatestToolPairs: 2,        // per-pair 用
    maxInteractionGroups: 12,      // 硬上限
    overflowStrategy: 'keep-latest',
    maxPairTokens: 6000,           // 单对工具最大 token
    maxOutputSummaryTokens: 1000,  // 摘要替换 tool_output 时的目标 token
  },
}
```

**开放状态**：完全开放。详见 [`tool-history.md`](./tool-history.md)。

### 4.2 ToolReplayProtocolGuardPreprocessor —— 工具回放协议守卫（无需配置，自动开启）

**一句话**：避免旧的工具组被 provider 误认为是结构化 replay。host 装配时已自动启用，不需要管。

**配置位置**：无；如果你完全自定义 pipeline 才需要手动 register。

**开放状态**：默认开启；属于协议级保护，没设计成可配置项。

### 4.3 HistoryPurificationPreprocessor —— 历史净化（无需配置）

**一句话**：清理孤儿 `tool_calls`（没有对应 `tool_output`）、同 ID 重复消息、空消息等异常状态。

**开放状态**：默认开启，无配置；这是数据卫生层。

### 4.4 FenceLifetimePreprocessor —— 旧轮 turn-only 剥离（自动跟 FenceRegistry 走）

**一句话**：上一轮注入的 `lifetime: 'turn-only'` 的 fence（比如临时引用文本、临时记忆片段），这一轮自动剥掉。

**配置位置**：注册 fence 时通过 `lifetime` 字段控制；不需要单独配 preprocessor。

---

## 5. ContextProvider 三阶段填充

### 5.1 AgentCoreContextProvider —— 核心层（无需配置）

**一句话**：把 must-keep 的核心消息（system_prompt + 最新 user_input + alwaysKeep 的 fence）按物理 role 钉到 messages 数组里，**永不裁剪**。

**开放状态**：行为完全由 MustKeepPolicy 决定（见 §3）。

### 5.2 AgentWorkingMemoryProvider —— 工作记忆按 P1-P4 优先级填充（AgentSpec 已运行时接线 ✅）

**一句话**：扣掉核心层之后剩多少预算，按 4 个优先级倒着塞进消息：

| 优先级 | 内容 |
|--------|------|
| **P1** | 最近的工具交互对（tool_calls + tool_output） |
| **P2** | 纯文本对话（final_answer + user 消息） |
| **P3** | 更早的工具交互（可能已被 ToolHistoryCompressor 压成 assistant 文本） |
| **P4** | 循环填充剩余空间 |

**可配置字段**（写在 `AgentSpec.contextPolicy`）：

| 字段 | 默认 | 含义 | 开放状态 |
|------|------|------|---------|
| `budget.maxTokens` | `120000` | 总预算上限 | ✅ AgentSpec + runtime |
| `budget.reservedForResponse` | `2400` | 留给 LLM 输出的 token | ✅ AgentSpec + runtime |
| `budget.workingMemoryBudgetPercentage` | `0.70` | 工作记忆占可用预算的比例 | ✅ AgentSpec + runtime |
| `reasoningRetention.keepLatestThoughts` | `1` | 最近保留多少条 thought | ✅ AgentSpec + runtime |
| `workingMemory.minToolInteractionsToKeep` | `2` | 即便预算不够也至少保留多少组工具对 | ✅ AgentSpec + runtime |
| `workingMemory.maxRecentToolInteractions` | `2` | 原始 tool_calls 形态保留的最大组数 | ✅ AgentSpec + runtime |
| `workingMemory.toolPairingSearchRange` | `10` | 搜工具配对的窗口范围 | ✅ AgentSpec + runtime |
| P1-P4 优先级数字 | `1/2/3/4` | 优先级编号 | ❌ 不开放（属算法骨架） |

**说明**：`workingMemory` 与 `reasoningRetention.keepLatestThoughts` 已经走 `AgentSpec.contextPolicy -> AgentContextBuilderConfig -> AgentWorkingMemoryProvider` 链路。

### 5.3 CheckpointSummarizationProvider —— Checkpoint 主动压缩（开放方式特殊 ✅）

**一句话**：Agent 主动调一个约定为 `context_checkpoint` 的工具。工具执行成功后，history 里会出现一组普通的 `tool_calls -> tool_output`；只要这个 tool output 的原始结果里带有 linnkit 认可的 checkpoint marker，`CheckpointSummarizationProvider` 就会在下一次上下文构建时清理 checkpoint 之前的旧历史。

- **保留**：must-keep + 这个 checkpoint 工具对本身 + checkpoint 之前最近 N 对工具交互（默认 N=2，可用 `checkpoint.keepPairsBefore` 覆盖）
- **清掉**：checkpoint 之前更旧的 tool_calls / tool_output / final_answer / thought / 旧 history_summary

**先分清两层**：

| 层 | linnkit 是否提供 | 说明 |
|----|------------------|------|
| checkpoint 协议与裁剪机制 | ✅ 提供 | `CHECKPOINT_MARKER_TYPE`、`CheckpointSummarizationProvider`、`checkpoint.keepPairsBefore` / `triggerToolName`、SystemReminder 与 step-reset 联动都在 framework 内 |
| 最小工具实现 | ✅ 提供 | `ContextCheckpointTool` / `createContextCheckpointTool()` 只处理 `summary -> checkpoint marker`；host 显式注册后才启用主动 checkpoint |
| host 状态扩展 | host 自己负责 | `taskstate` / shared memory / 外部文档写入属于 host 能力，可通过 hook 包进最小工具，也可以自定义完整工具 |

最小接入：

```ts
import { ContextCheckpointTool } from '@linnlabs/linnkit/runtime-kernel';

export const tools = [
  new ContextCheckpointTool(),
];
```

如果你改工具名，必须同时改 `contextPolicy.checkpoint.triggerToolName`：

```ts
const checkpointTool = new ContextCheckpointTool({ name: 'phase_checkpoint' });

contextPolicy: {
  profileId: 'agent',
  checkpoint: {
    triggerToolName: 'phase_checkpoint',
  },
}
```

如果 host 有自己的状态系统，可以用 hook 扩展 payload / observation：

```ts
const checkpointTool = new ContextCheckpointTool({
  extraParameters: {
    taskstate: {
      type: 'object',
      description: 'Host task state snapshot',
    },
  },
  buildPayloadExtension: async ({ args, context }) => {
    // 可选：写入 host 自己的 TaskState / Memory / 文件系统。
    // 返回值会合并到 tool result data 中，但 _type 与 summary 由 linnkit 固定写回。
    return {
      conversation_id: context.conversationId,
      taskstate: args.taskstate,
    };
  },
});
```

> 注意：`CheckpointSummarizationProvider` 严格读取 `tool_output.metadata.raw_output` 里的 marker，而不是解析展示给模型看的 observation 文本。这是为了避免普通工具输出碰巧像 JSON 时误触发 checkpoint。

**与 summarization 的关键区别**：

| 维度 | summarization | checkpoint |
|------|---------------|-----------|
| 谁触发 | linnkit 在 token 超阈值时**被动**触发 | agent 主动判断（"完成了一个阶段任务"等）**主动**触发 |
| 体感 | 文本摘要，丢得多 | 工具对形态，保留 agent 自己的总结 + task state | 
| 何时 | 上限附近 | 任何时候 |
| 颗粒度 | 较粗 | agent 自己控制颗粒 |

**配置位置 / 开放状态**：

- ✅ **启用方式**：host 把 `context_checkpoint` 工具注册进 agent 的工具集；不想用就不注册
- ✅ **保留多少对**：`checkpoint.keepPairsBefore` 已从 AgentSpec 透传到 `CheckpointSummarizationProvider`；`0` 表示只保留 checkpoint 工具对本身，不额外保留 checkpoint 前工具对
- ✅ **识别哪个工具**：`checkpoint.triggerToolName` 已从 AgentSpec 透传到 provider；host 可以把 context trimming 层的 checkpoint 工具名改成自己的名字
- ✅ **最小工具**：`ContextCheckpointTool` 已由 linnkit 提供，外部接入方可以直接注册
- ✅ **marker 协议**：`CHECKPOINT_MARKER_TYPE` 在 framework 内固定；自定义工具也必须输出这个 marker
- ✅ **工具 args 协议**：linnkit 最小工具只要求 `summary`；`taskstate` / shared memory / 引用列表等属于 host 能力，接入方可以用 hook 或自定义工具扩展

> 边界说明：`checkpoint.triggerToolName` 已同时控制 `CheckpointSummarizationProvider` 的裁剪识别、GraphExecutor 的 step-reset、以及 SystemReminder 的上下文预算提醒文案。host 改名时必须确保对应工具也真实注册进 agent 工具集。

**当前接入方式是否优雅？**

现在是"协议在 framework，状态在 host"：

- 好处：外部接入方可以开箱注册 `ContextCheckpointTool`，不需要自己拼 marker；复杂 host 仍然能通过 hook 或自定义工具接 TaskState / Memory。
- 边界：linnkit 不持有任何 host 的状态存储、任务状态 schema 或 shared memory 路径；这些能力必须由 host 自己实现。
- 不注册工具就完全没有主动 checkpoint 行为；被动 summarization 仍可照常工作。

### 5.4 自动 SummarizationProvider —— 超预算被动摘要（注册 agent 可配置 ✅）

**一句话**：当 token 总用量超过阈值，把最旧的一批消息丢给一个**专用的摘要 agent**，让它生成一段总结，替换掉这批旧消息。

**可配置字段**：

| 字段 | 默认 | 含义 | 开放状态 |
|------|------|------|---------|
| `summarization.triggerThreshold` | `0.70` | 超过总预算的多少比例触发 | ✅ AgentSpec |
| `summarization.budgetPercentage` | `0.12` | 摘要文本本身的 token 长度上限占比 | ✅ AgentSpec |
| `summarization.oldestMessagesPercentage` | `0.75` | 选取多大比例的最老消息进摘要 | ✅ AgentSpec |
| 摘要 agent + 失败行为 | `summarization.agentId` / `failureBehavior`；摘要必须通过 host 注册 agent/chat 调用 | ✅ AgentSpec + runtime |
| 摘要失败的 fatal 判断 | 通过 `ContextProviderError({ code: 'SUMMARIZATION_FAILED', fatal: true })` 抛出 | ✅ 协议化 |

**摘要 agent 的注册边界**：framework 不持有摘要 prompt 正文，也不直接发起裸 LLM call。它只把 `summarization.agentId` 放进 `GenerateRequest.promptKey`，由 host 通过自己的注册表解析成一个无工具摘要 agent/chat，再按该注册项的 prompt、模型策略与执行方式完成调用。host 可以把默认摘要 agent 注册为 `history_compression`，也可以在 `contextPolicy.summarization.agentId` 中为单个 agent 指定别的注册项。

**失败行为**：

| `failureBehavior` | 行为 |
|-------------------|------|
| `'fail-fast'`（默认）| 摘要失败立即抛 typed fatal `ContextProviderError`，保持旧行为 |
| `'continue-if-within-budget'` | 只有当前上下文仍在预算内时才允许继续使用原始消息；如果已经超预算，仍然 fail-fast |

---

## 6. System Reminder（注册表 + AgentSpec 已接线 ✅，**有一项不开放**）

**一句话**：根据当前 tick 的状态（步数、phase、工具调用次数等）在**最后一条 message 末尾**追加一段 `<system-reminder>...</system-reminder>`，利用 LLM 注意力的末尾效应做行为引导。

**核心设计原则**（重要，你草稿里有一处理解偏差，看下面）：

| 不变量 | 说明 |
|--------|------|
| ✅ 只对当前 tick 生效 | 不写入 history、不持久化、不产生 RuntimeEvent |
| ✅ 注入位置固定 | 最后一条 message 的 content 末尾，包裹在 `<system-reminder>` 标签 |
| ✅ 配置驱动 | 内置规则与 host extraRules 都通过 trigger + contentTemplate 注册表解释 |
| ❌ **不能配置进短期对话历史** | "可以配置允许进入短期对话历史并持久化"——这条**当前不支持**，是反协议的：reminder 本质是"瞬态状态注入"，进 history 会污染缓存与回放语义。如果产品真有"持久化提示"需求，应该走 fence 通道（`lifetime: 'persisted'`），而不是 reminder |

**触发方式**：framework 内置 5 条规则，按顺序判定：

| 规则 ID | 触发条件 | 用途 |
|---------|---------|------|
| `max_steps_force_final_answer` | `phase === 'force_final_answer'` | 最后一步强制收尾，禁用工具 |
| `last_steps_hint` | `remainingSteps <= threshold` | 剩余步数提示 |
| `tool_call_streak_every_ten` | 本轮工具调用次数 ≥ 10 且为 10 的倍数 | 工具循环过深告警 |
| `periodic_taskstate_reflection` | `stepCount` 是 30 的倍数 | 长程任务定期反思 |
| `context_budget_warning` | `stepCount` 达 maxSteps 的 90% 且 agent 有 `checkpoint.triggerToolName` 对应工具 | 上下文即将耗尽，引导调 checkpoint |

**配置开放状态**：

| 项 | 开放状态 | 备注 |
|---|---------|------|
| 规则触发的阈值（10 / 30 / 90% 等数字）| ✅ AgentSpec + runtime | `systemReminder.thresholds` 覆盖 |
| 规则文案 | ✅ 注册表 | 内置文案在 runtime template；host extraRules 通过 `contentTemplate` 引用 host 注册模板 |
| 是否启用某条规则（白名单/黑名单）| ✅ AgentSpec + runtime | `enabledRuleIds` 与 `disabledRuleIds` 二选一 |
| host 自定义新规则 | ✅ AgentSpec + runtime | `systemReminder.extraRules` 通过 trigger/template 注册表解释 |
| reminder 进 history（持久化）| 🔴 **不开放且不计划开放** | 见上面不变量第 4 条 |

**注册式扩展边界**：

- spec 只写 `extraRules: [{ id, trigger, contentTemplate, contentArgs }]`，不允许写函数。
- trigger 由 `SystemReminderRegistry.registerTriggerKind(kind, evaluator)` 注册。
- 文案由 `SystemReminderRegistry.registerContentTemplate(name, template)` 注册。
- 内置 5 条规则也走同一套解释链路，因此自定义规则、阈值覆盖、启用/禁用规则的行为一致。

---

## 7. Tool Output 截断与落盘（AgentSpec 阈值可配置 ✅）

**一句话**：工具返回结果太长会**两端各处理一次**——一次在执行期、一次在上下文构建期：

### 7.1 执行期落盘（ToolNode observationGovernance）

- 工具刚执行完，原始 observation 字符串如果超过阈值，就通过 host 提供的 `ObservationPreviewPort` **写一份完整副本到 ToolOutputStore / 本地文件 / 对象存储**，messages 里只保留 preview + `tool_output_store.blob_id` 指针
- 截断治理由 `AgentSpec.contextPolicy.toolOutput.observationGovernance` 控制；**存储后端、目录、文件命名规则由 host 的 `ObservationPreviewPort` 配置**，不进入 AgentSpec
- **开放状态**：阈值与启停已进 AgentSpec + runtime；落盘实现仍由 host 的 `ObservationPreviewPort` 决定

```ts
contextPolicy: {
  profileId: 'agent',
  toolOutput: {
    observationGovernance: {
      enabled: true,
      maxChars: 20_000,
      maxLines: 1_200,
    },
  },
}
```

接入方配置存储路径的方式见 [`tools.md §6`](./tools.md#6-observationpreviewport配置超长-observation-存储路径)：实现自己的 `ObservationPreviewPort`，把 `rootDir` / 对象存储 bucket / 数据库连接等部署参数放在 host 配置里，再在 runtime assembly 时传给 `createDefaultGraphExecutor({ observationPreview })`。

示例 host 可以写入：

```text
<workspaceRoot>/Artifacts/v1/conversations/<conversationId>/instances/<instanceId>/tool_output/blobs/<blobId>.json
```

`workspaceRoot` 应来自 host 自己的部署配置、环境变量或工作区配置。注意：如果 host 自定义了存储路径，读取 `tool_output://blobs/<blob_id>` 的工具也必须使用同一个 store，否则模型拿到 `blob_id` 后无法续读。

### 7.2 上下文构建期截断（MAX_TOOL_PAIR_TOKENS）

- 工具历史在进 working memory 时，如果**单对工具的 token 总量**超过 `MAX_TOOL_PAIR_TOKENS`，会触发 `ToolOutputSummarizer` 把 `tool_output` 摘要替换成短文本
- 这两个阈值已经进 AgentSpec：

```ts
contextPolicy: {
  toolHistory: {
    maxPairTokens: 6000,           // 单对工具的 token 上限
    maxOutputSummaryTokens: 1000,  // 摘要替换时的目标 token
  },
}
```

**两层独立、各管各的**：执行期落盘解决"原始观察值过大不该塞进 wire"；上下文构建期截断解决"历史工具结果占用过多预算"。

---

## 8. Reasoning / Thought 保留策略（AgentSpec 已运行时接线 ✅）

**一句话**：部分 LLM provider 会返回 `reasoning_content`（思考过程文本），有些模型在能看到之前 reasoning 历史时表现更好——所以 linnkit 把 `thought` 当作一类 AiMessage 保留。

**当前可配置且已接入 runtime**：

| 项 | 默认 | 开放状态 |
|---|------|---------|
| 工作记忆里保留的最近 thought 数量 | `reasoningRetention.keepLatestThoughts = 1` | ✅ AgentSpec + runtime |
| Provider sidecar replay 行为（reasoning_details 缺失时怎么办）| `'allow'` / `'degrade_to_text'` / `'provider_empty_replay_field'` | ✅ `contextPolicy.providerReplay` 可覆盖；未配置时 host 仍可按模型默认注入 |

默认生产运行时保留**1 条**（最新的那条 thought）。如果需要保留多轮 reasoning，可在 AgentSpec 中设置 `reasoningRetention.keepLatestThoughts`，该字段会透传到 `AgentWorkingMemoryProvider`。

Provider replay 是另一件事：它不决定"保留几条 thought"，而决定"历史工具组缺少 provider sidecar 时怎么回放"。配置例子：

```ts
contextPolicy: {
  profileId: 'agent',
  providerReplay: {
    provider: 'system_default',
    requiresReasoningDetailsForToolReplay: true,
    missingSidecarBehavior: 'provider_empty_replay_field',
  },
}
```

边界：如果 `providerReplay` 不配置，linnkit 不会按 `model_id` 自己猜 provider；host 仍可以通过 `resolveToolReplayProtocolPolicy` 按模型提供默认策略。单个 agent 的 `contextPolicy.providerReplay` 优先级高于 host 的模型默认策略。

---

## 9. Token 预算与估算

| 字段 | 默认 | 含义 | 开放状态 |
|------|------|------|---------|
| `budget.maxTokens` | `120000` | 总预算 | ✅ AgentSpec |
| `budget.reservedForResponse` | `2400` | 留给响应的 token | ✅ AgentSpec |
| `budget.workingMemoryBudgetPercentage` | `0.70` | 工作记忆占可用预算的比例 | ✅ AgentSpec |
| `tokenEstimation.encoding` | `'cl100k_base'` | 估算用的 tiktoken encoding 名 | ✅ AgentSpec + runtime |
| `tokenEstimation.avgCharsPerToken` | `2.0` | tiktoken 不可用或未配置 encoding 时的字符/token 兜底比 | ✅ AgentSpec + runtime |
| `tokenEstimation.toolCallOverhead` | `50` | 工具调用本身的额外开销估算 | ✅ AgentSpec + runtime |

**说明**：runtime 统一通过 `TokenCalculator.estimateMessageTokens()` 估算 message token，因此预算判断会同时计入基础 message overhead、内容 token、tool call 参数 token 与 `tokenEstimation.toolCallOverhead`。如果 `encoding` 不可用，才回退到 `avgCharsPerToken`。

---

## 10. 出关：`formatAgentLlmMessages`

**一句话**：把所有 AiMessage 翻译成最终 LLM 协议 wire 格式（具体调哪个 provider 这里无关）；fence 消息走 host 提供的 `formatter` 包成字面标签；`tool_calls` / `tool_output` 按 LLM 协议挂正确的 role。

**配置面**：
- fence formatter（host 决定围栏字面长什么样）
- LLM provider 自己的 codec（OpenAI Chat / Anthropic Messages / DeepSeek 等）—— 详见 [`llm-provider.md`](./llm-provider.md)

---

## 10.5 ContextTrace：解释这次上下文为什么长这样

**一句话**：`contextTrace` 是本次 context build 的机器可读旁路记录。它不进入 LLM messages、不落成历史事实，只跟随 `ContextBuildResult.contextTrace` 返回，用来解释 effective policy、每个 provider 的 token 增减、以及每条消息最终被保留还是裁掉。

**配置面**：

```ts
contextPolicy: {
  profileId: 'agent',
  contextTrace: {
    enabled: true,
    includeMessageIds: true,
    includeTokenBreakdown: true,
    maxTraceEvents: 200,
  },
}
```

**输出里会看到**：

- `effectivePolicy`：本次实际生效的 `contextPolicy`（已经合并 framework 默认、host fallback、agent spec）。
- `provider` 事件：每个 provider 执行前后保留消息数、token delta、剩余预算、命中的策略名。
- `message-decision` 事件：每条候选消息的 `keep/drop` 结果、阶段、token、原因；`includeMessageIds=false` 时不会带 message id。
- `overflowed`：trace 事件超过 `maxTraceEvents` 时为 `true`，防止观测数据反过来膨胀。
- GraphExecutor 会把 `contextTrace` 从 context builder 透传到 context audit record；runtime-kernel 只按 `unknown` 透传，不反向依赖 context-manager 类型。

**边界**：ContextTrace 不是 DevTools，也不是 PromptTrace 可视化；它只提供最小可观测闭环。跨 run prompt diff、图形化时间线、长期审计落库属于阶段 2。

---

## 11. 当前开放面 vs 未开放面 · 速查

### ✅ 已通过 AgentSpec 协议化开放，且 runtime 已接线

- `budget.maxTokens` / `reservedForResponse` / `workingMemoryBudgetPercentage`
- `toolHistory.{strategy, keepLatestToolPairs, keepLatestRuns, maxInteractionGroups, overflowStrategy, maxPairTokens, maxOutputSummaryTokens}`
- `toolOutput.observationGovernance.{enabled, maxChars, maxLines}`
- `providerReplay.{provider, requiresReasoningDetailsForToolReplay, missingSidecarBehavior}`
- `summarization.{triggerThreshold, budgetPercentage, oldestMessagesPercentage, agentId, failureBehavior}`
- `MustKeepPolicy.{alwaysKeepTypes, alwaysKeepFenceKinds, truncationRules}`
- `workingMemory.{maxRecentToolInteractions, minToolInteractionsToKeep, toolPairingSearchRange}`
- `checkpoint.{keepPairsBefore, triggerToolName}`
- `reasoningRetention.keepLatestThoughts`
- `tokenEstimation.{encoding, avgCharsPerToken, toolCallOverhead}`
- `systemReminder.{enabledRuleIds, disabledRuleIds, thresholds, extraRules}`
- `contextTrace.{enabled, includeMessageIds, includeTokenBreakdown, maxTraceEvents}`
- `defineContextPolicy()` 可补齐 12 大分组默认值，便于外部接入方生成完整策略
- fence 注册（`FenceRegistry`，host 自由扩展）

### 🔴 当前不开放（未来可能开放）

- Preprocessor pipeline **顺序与白名单**（host 现在只能在默认 pipeline 之外追加，不能改默认顺序）

### 🚫 协议性不开放（不计划开放）

- system reminder **持久化进 history**（违反 reminder 协议本质——若需持久化请走 fence `lifetime: 'persisted'`）
- ContextProvider 三阶段顺序（核心 → 工作记忆 → 摘要）
- 工具压缩的 P1-P4 优先级数字（属算法骨架）
- `tool_calls` / `tool_output` 配对不变量

---

## 12. 草稿里的两处需要校准

1. **"system reminder 默认不会进入短期对话历史，触发后下次请求的时候就没了，但可以配置允许进入短期对话历史并持久化"** —— 前半句完全正确；后半句**当前不支持，也不计划支持**（见 §6 协议性不开放）。如果产品真需要持久化的"提示性文本"，正确的做法是走 fence 通道 `lifetime: 'persisted'`，而不是把它塞进 reminder。

2. **"允许配置 reasoning_content 的保留策略，例如保留最近几轮 reasoning_content"** —— 已支持：`reasoningRetention.keepLatestThoughts` 会透传到工作记忆层，控制最近 thought 的保留数量。

---

## 13. 想动哪一层 · 5 秒决策

| 你想做什么 | 应该动哪里 | 验证方式 |
|------------|------------|----------|
| 控制总预算 / 预留响应 token | `contextPolicy.budget` | `ContextTrace.effectivePolicy` + final token usage |
| 控制工具历史保留方式 | `contextPolicy.toolHistory` | `ContextTrace.message-decision` 中 tool_calls / tool_output 的 keep/drop |
| 控制摘要何时触发、用哪个摘要 agent | `contextPolicy.summarization` | summary event + `ContextTrace.provider` 中 summarization provider token delta |
| 必保留某类 host 上下文 | `contextPolicy.mustKeep.alwaysKeepFenceKinds` | fence 对应 message 的 decision 为 `kept_by_CORE_CONTEXT` |
| 调整工作记忆工具组数量 | `contextPolicy.workingMemory` | working-memory provider 后的 kept count / token delta |
| 改 checkpoint 工具名或保留窗口 | `contextPolicy.checkpoint` | checkpoint provider 策略命中 + GraphExecutor step-reset 行为 |
| 控制 thought 保留数量 | `contextPolicy.reasoningRetention.keepLatestThoughts` | thought message 的 keep/drop 数量 |
| 控制工具 observation 执行期预览阈值 | `contextPolicy.toolOutput.observationGovernance` | `tool_output_store.blob_id` 是否生成 + tool node 单测 |
| 控制 provider sidecar 缺失时的历史工具回放 | `contextPolicy.providerReplay` | `ToolReplayProtocolGuardPreprocessor` 是否降级 / 标记 |
| 调整 token 估算口径 | `contextPolicy.tokenEstimation` | provider token delta 曲线变化 |
| 自定义 transient system reminder | `contextPolicy.systemReminder` + registry | `systemReminderHitRuleIds` + final LLM input |
| 看清最终 token 决策 | `contextPolicy.contextTrace.enabled=true` | `ContextBuildResult.contextTrace` |

---

## 14. 声明你的第一个 summarization agent

摘要不是 provider 自己发起裸 LLM call。linnkit 的边界是：**summary provider 只引用 host 注册表里的无工具 agent/chat**，真正的 prompt、模型、注册制都在 host。

```ts
// app-hosts/your-app/agent-registry/chats/history_compression/index.ts
export const historyCompression = {
  id: 'history_compression',
  promptKey: 'history_compression',
  tools: [],
  config: {
    contextPolicy: {
      profileId: 'agent',
      toolHistory: {
        strategy: 'per-pair',
        keepLatestToolPairs: 0,
        maxInteractionGroups: 4,
        overflowStrategy: 'fail-fast',
      },
    },
  },
};
```

然后在需要覆盖默认摘要 agent 的业务 agent 上声明：

```ts
contextPolicy: {
  profileId: 'agent',
  summarization: {
    agentId: 'history_compression',
    triggerThreshold: 0.72,
    failureBehavior: 'continue-if-within-budget',
  },
}
```

**注意**：

- `agentId` 必须能被 host 注册表解析；unknown id 应在装配期报错。
- 这个 agent/chat 应该没有工具，避免摘要流程变成二次工具调用。
- `failureBehavior: 'continue-if-within-budget'` 只在当前上下文仍未超预算时继续；已超预算仍会 fail-fast。

---

## 15. 声明你的第一个 system reminder

SystemReminder 是**当前 tick 的瞬态提醒**，不会进入历史。内置规则可通过 `enabledRuleIds` / `disabledRuleIds` / `thresholds` 控制；host 自定义规则走 trigger/template 注册表。

```ts
contextPolicy: {
  profileId: 'agent',
  systemReminder: {
    enabledRuleIds: ['last_steps_hint', 'context_budget_warning'],
    thresholds: {
      lastStepsHintThreshold: 2,
      budgetWarningRatio: 0.85,
    },
  },
}
```

自定义规则示意：

```ts
import { systemReminder } from '@linnlabs/linnkit/runtime-kernel';

systemReminder.defaultSystemReminderRegistry.registerContentTemplate(
  'memoryDensityWarning',
  (_ctx, args) => `请先整理 ${String(args.resourceName ?? 'memory')} 的关键信息，再继续调用工具。`,
);

contextPolicy: {
  profileId: 'agent',
  systemReminder: {
    extraRules: [
      {
        id: 'memory-density-warning',
        trigger: { kind: 'tool-call-streak', threshold: 5 },
        contentTemplate: 'memoryDensityWarning',
        contentArgs: { resourceName: 'memory_recall' },
      },
    ],
  },
}
```

**注意**：

- 不要把 reminder 持久化进 history；需要持久化提示时走 fence。
- spec 里只放 trigger/template ID 和可序列化参数，不放函数。

- **想加一类 host 业务上下文**（项目元信息 / 引用文本 / 长记忆等）→ fence（[`context-fences.md`](./context-fences.md)）
- **想换工具历史压缩策略 / 调上限**→ `AgentSpec.contextPolicy.toolHistory`（[`tool-history.md`](./tool-history.md)）
- **想动总 token 预算 / 工作记忆占比**→ `AgentSpec.contextPolicy.budget`
- **想动自动摘要的触发点 / 占比 / 摘要 agent**→ `AgentSpec.contextPolicy.summarization`；`agentId` 必须引用 host 已注册的无工具摘要 agent/chat
- **想先生成完整默认策略**→ `defineContextPolicy()`（F1.1 已开放）
- **想让 agent 主动清上下文**→ 把 `checkpoint.triggerToolName` 对应工具注册进 agent 工具集
- **想让 agent 注意某个阶段提醒**→ `AgentSpec.contextPolicy.systemReminder`；内置规则支持阈值、白名单/黑名单，host extraRules 通过注册表扩展
- **想换 LLM provider 行为 / reasoning sidecar 策略**→ 默认由 host 按模型注入，单个 agent 可用 `AgentSpec.contextPolicy.providerReplay` 覆盖（[`llm-provider.md`](./llm-provider.md)）
- **想让某类消息永不被裁**→ `AgentSpec.contextPolicy.mustKeep`；host 级默认规则通过 fallback policy 注入，单个 agent 可覆盖
