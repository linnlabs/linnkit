# Tool History · 工具历史压缩策略

> **What** · 工具历史压缩策略配置 —— `per-pair` / `per-run` / `none` 三种策略 + `overflowStrategy` 溢出兜底。
> **When to read** · 上下文里工具调用反复占满 token；想配置工具调用历史的压缩窗口；做长 run 任务的成本控制。
> **Prerequisites** · [`tools.md`](./tools.md) · [`context-engineering.md` §5](./context-engineering.md)。
> **Key exports** · `toolHistory` field in `AgentSpec.contextPolicy` from `@linnlabs/linnkit` · `ToolHistoryCompressor` preprocessor 由 framework 内置自动注入。
> **Related** · [`context-engineering.md`](./context-engineering.md) ⭐ · [`tools.md`](./tools.md) · [`agent-registration-guide.md`](./agent-registration-guide.md) ⭐

linnkit 的 agent preprocessor 支持三种工具历史压缩策略，host 可在 `AgentDefinition.config.contextPolicy.toolHistory` 中显式声明。

## 1. 三种策略对比

| 策略 | 适用场景 | 行为 | 风险 |
|------|----------|------|------|
| `per-pair` | 4K/8K 小上下文模型；需要强力控 token | 全局保留最近 N 组完整工具交互，其余压成自然语言摘要 | 可能跨 run 腰斩同一轮工具链，prompt cache prefix 不稳定 |
| **`per-run`**（默认推荐）| 多步 agent、review、workspace 操作 | 按 `user_input` 划 run，完整保留最近 K 个历史 run 的工具序列 | token 使用量可能高于 per-pair |
| `none` | 200K+ 长上下文模型；调试回放；审计敏感链路 | 不做常规压缩，只保留安全阀 | 长历史会明显涨 token |

**未传配置时默认走 `per-run` + `keepLatestRuns: 1`**。host 仍应在各自的 `AgentDefinition.config.contextPolicy.toolHistory` 中显式声明策略，避免依赖全局默认。

## 2. 默认值汇总

| 字段 | 默认 |
|------|------|
| `toolHistory.strategy` | `'per-run'` |
| `toolHistory.keepLatestRuns` | `1`（保留上一个 run 完整工具序列）|
| `toolHistory.keepLatestToolPairs` | `2`（仅 `strategy='per-pair'` 时生效）|
| `toolHistory.maxInteractionGroups` | `12` |
| `toolHistory.overflowStrategy` | `'keep-latest'` |
| `toolHistory.maxPairTokens` | `6000` |
| `toolHistory.maxOutputSummaryTokens` | `1000` |

## 3. 安全阀

所有策略共用：

- `maxInteractionGroups`：硬上限，默认 12
- `overflowStrategy: 'keep-latest'`：超过上限时保留最近工具组，压缩更旧组
- `overflowStrategy: 'fail-fast'`：超过上限时抛 `ContextProviderError`，`code = 'TOOL_HISTORY_OVERFLOW'`，适合 CI 或生产 invariant

## 4. `AgentSpecContextPolicy.toolHistory` 字段

```ts
interface AgentSpecContextPolicy {
  profileId: string;

  budget?: {
    maxTokens?: number;
    reservedForResponse?: number;
    workingMemoryBudgetPercentage?: number;
  };

  toolHistory?: {
    /**
     * 压缩策略类型（默认 'per-run'）
     * - 'per-pair'：按工具对个数裁（旧默认；适合 4K/8K 等超紧上下文模型）
     * - 'per-run'：按 user_input 划 run 边界，保留最近 K 个 run 完整工具序列（prompt cache 友好；通用默认）
     * - 'none'：不压缩（适合 200K+ 长 context 模型；仅靠单 tool_output token cap 兜底）
     *
     * 注：当前 run（最后一条 user_input 之后）所有工具对永不压缩，不受 strategy 影响。
     */
    strategy?: 'per-pair' | 'per-run' | 'none';

    /** strategy='per-pair' 时：保留最近 N 组完整工具对（默认 2）*/
    keepLatestToolPairs?: number;

    /** strategy='per-run' 时：保留最近 K 个 run 完整工具序列（默认 1）*/
    keepLatestRuns?: number;

    /** 工作记忆层最多保留的工具交互组总数硬上限（所有 strategy 共用，默认 12）*/
    maxInteractionGroups?: number;

    /**
     * 溢出 maxInteractionGroups 时的处置（默认 'keep-latest'）
     * - 'keep-latest'：按 originalIndex 倒序截，留尾不留头（保证最近行动可见）
     * - 'fail-fast'：抛 ContextProviderError，让 host 显式处理
     */
    overflowStrategy?: 'keep-latest' | 'fail-fast';

    /** 单组 tool pair token 上限（所有 strategy 共用，超过触发截断，默认 6000）*/
    maxPairTokens?: number;

    /** tool_output 摘要后的 token 上限（所有 strategy 共用，默认 1000）*/
    maxOutputSummaryTokens?: number;
  };

  summarization?: {
    triggerThreshold?: number;
    budgetPercentage?: number;
    oldestMessagesPercentage?: number;
    agentId?: string;
    failureBehavior?: 'fail-fast' | 'continue-if-within-budget';
  };
}
```

## 5. AgentSpec 装配

AgentSpec schema 已落到 `@linnlabs/linnkit/contracts`，host 装配时可用 `contextPolicy.toolHistory` 控制策略：

```ts
import type { AgentSpec } from '@linnlabs/linnkit/contracts';

const myAgentSpec: AgentSpec = {
  id: 'my-research-agent',
  version: '1.0.0',
  capabilities: ['llm', 'tools'],
  tools: [],
  contextPolicy: {
    profileId: 'agent',
    toolHistory: {
      strategy: 'per-run',
      keepLatestRuns: 2,            // 高密度子调度 agent 建议 K=2-3
      maxInteractionGroups: 12,
      overflowStrategy: 'keep-latest',
    },
  },
};
```

## 6. 低层 preprocessor 注入

测试或自定义 registry 也可以直接从默认 preprocessor registry 注入：

```ts
import { createDefaultAgentPreprocessorRegistry } from '@linnlabs/linnkit/context-manager';

const registry = createDefaultAgentPreprocessorRegistry({
  toolHistory: {
    strategy: 'per-run',
    keepLatestRuns: 1,
    maxInteractionGroups: 12,
    overflowStrategy: 'keep-latest',
  },
});
```

## 7. 默认值变更的兼容声明

`strategy` 默认从历史隐式的 `per-pair`（N=2）→ `'per-run'`（K=1）。对所有 host 来说：

- 不会引入新 bug（per-run 是 per-pair 的超集——保留更多消息，不会少留）
- 平均 history token 数 +20-40%（具体看 history 中工具调用密度）
- prompt cache 命中率上升
- host 想保持旧行为：在 AgentSpec 显式设 `toolHistory.strategy: 'per-pair'`

## 8. 每个 agent 显式声明（推荐做法）

每个 agent 在自己的 `index.ts` 显式声明 `contextPolicy`，**不走预设模板、不依赖全局默认**：

```ts
// app-hosts/your-app/agent-registry/agents/research-agent/index.ts
import type { AgentDefinition } from '../../types';
import type { AgentSpecContextPolicy } from '@linnlabs/linnkit/contracts';

const RESEARCH_AGENT_CONTEXT_POLICY: AgentSpecContextPolicy = {
  profileId: 'agent',
  toolHistory: {
    strategy: 'per-run',
    keepLatestRuns: 3,            // 深度子调度，保留更多上下文
  },
};

export const researchAgent: AgentDefinition = {
  // ...
  config: {
    contextPolicy: RESEARCH_AGENT_CONTEXT_POLICY,
  },
};
```

**理由**：

- agent 作者最了解自己的预期工具密度 + 配置的模型 ctx + 工具结果体量
- 全局默认 per-run K=1 是合理兜底，但高密度子调度 agent 应该显式 K=2-3；translation / autocomplete / 内部子 agent 应该显式 N=0 极致省 token
- 预设模板会增加间接耦合——换模型时不知道哪些预设需要联动改

## 9. 用 ContextTrace 验证策略真的生效

`toolHistory` 最终会影响 preprocessor 与 working-memory provider 的消息选择。调试时建议临时打开：

```ts
contextPolicy: {
  profileId: 'agent',
  toolHistory: {
    strategy: 'per-run',
    keepLatestRuns: 2,
  },
  contextTrace: {
    enabled: true,
    includeMessageIds: true,
    includeTokenBreakdown: true,
    maxTraceEvents: 200,
  },
}
```

然后检查 `ContextBuildResult.contextTrace.events`：

- `provider` 事件能看到 working-memory 阶段保留消息数与 token delta。
- `message-decision` 事件能看到每条 `tool_calls` / `tool_output` 的 keep/drop 决策。
- 如果 trace `overflowed=true`，说明这次上下文太大，先提高 `maxTraceEvents` 做一次诊断；不要长期把它开太大。
