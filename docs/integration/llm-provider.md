# LLM Provider · 接 LLM provider

## 1. linnkit 给你的合同

- `AgentAiEngine`（来自 `@linnlabs/linnkit/ports`）：必须实现 `chatCompletion` + `chatCompletionStream` 两个方法。流式接口的回调签名详见类型定义。
- `LlmRequestMessage` / `LlmCallOptions` / `ProviderReasoningDetails` / `ToolCallChunk` / `ToolCallExtraContent`（来自 `@linnlabs/linnkit/ports`）：调用入参与流式 chunk 形状。
- `runtimeKernel.llm.LlmCaller`（来自 `@linnlabs/linnkit/runtime-kernel`）：runtime 内部用的统一调用器，host 在 runtime-assembly 时把 `AgentAiEngine` 通过 `LlmCaller` 包一层。

## 2. linnkit 自带的 mock primitive

- `createScriptedAiEngineHarness`（来自 `@linnlabs/linnkit/testkit`）：满足 `AgentAiEngine` 接口的脚本化实现。它的 `getLlmCaller()` 直接产出可注入的 `LlmCaller`，写测试零样板。

## 3. Provider replay sidecar（多家 reasoning model 必读）

部分 provider（DeepSeek `reasoning_content`、OpenRouter / Claude reasoning blocks 等）会返回**必须随下一轮工具调用原样回传的不透明载荷**。linnkit 的 vendor-neutral 槽位是：

| 链路位置 | 字段 | 谁负责往里塞 |
|---|---|---|
| 流式 chunk / 非流式响应 | `AgentAiEngineStreamContent.reasoning_details` | 你的 provider adapter |
| RuntimeEvent | `tool_call_decision.payload.reasoning_details` | linnkit 自动 |
| 回放后的 AiMessage | `metadata.reasoning_details` 与 `metadata.tool_calls[*].extra_content` | linnkit 自动 |
| 工具调用扩展 | `tool_calls[*].extra_content` | 你的 provider adapter（写）；linnkit 回放时透传 |

你的 adapter 只负责字段互译——**把 provider 私有字段归一化进上面的通用槽位**，不要把私有字段散到 graph-engine 或 context-manager。

出关到 LLM 时，host 默认装配应当用 `formatAgentLlmMessages(messages, { fenceRegistry })`（来自 `@linnlabs/linnkit/context-manager`）；它走 native tool 回放形态，会自动把 sidecar 写回去。

> ⚠️ **注意**：被工具历史压缩 / 历史摘要替换 / chat formatter 处理过的旧工具组，不再保证 sidecar 可回放——这是 token 预算与 chat 兼容层的设计取舍。如果某个 provider 强要求 reasoning blocks 必须随回传，请确保该工具组以原始 `tool_call_decision + tool_output` 结构进入下一轮上下文。

### 3.1 缺 sidecar 时怎么办

默认情况下，linnkit 不会根据 `model_id` 自己猜 provider 的 replay 约束。host 可以在装配 `AgentMessageOrchestrator` 时通过 `resolveToolReplayProtocolPolicy({ request, modelId })` 提供模型级默认策略；单个 agent 也可以用 `AgentSpec.contextPolicy.providerReplay` 覆盖它。

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

`missingSidecarBehavior` 的含义：

| 值 | 行为 |
|---|---|
| `allow` | 不治理旧工具组，保持原样 |
| `degrade_to_text` | 把缺少 sidecar 的历史工具组降级成普通 assistant 文本 |
| `provider_empty_replay_field` | 保留结构化工具组，但标记 `provider_empty_replay_field`，交给 provider adapter 出关时填空字段 |

优先级：`contextPolicy.providerReplay`（agent 级） > `resolveToolReplayProtocolPolicy`（host/model 级） > 默认 `allow`。

## 4. 你必须做的

1. 实现一个符合 `AgentAiEngine` 的 adapter，把 HTTP / SDK 调用封进 `chatCompletion[Stream]`。
2. 在 runtime-assembly 里把 `aiEngine` 通过 `runtimeKernel.llm.LlmCaller` 包一层。
3. 实现 `ModelResolver` / `ModelCatalog`（来自 `@linnlabs/linnkit/runtime-kernel` 的 `llm` namespace），把 host 的 modelId 解析为 provider + provider modelId。

## 5. 你不要做的

- 不要让 graph-side 代码直接知道你家 SDK 的 HTTP 形态。
- 不要在测试里 patch 模块级全局 ai engine——通过依赖注入替换。
- 不要把 provider 重试 / 审计 / fallback 逻辑散落在 host 业务文件里——收敛到 adapter 内。

## 6. 最小验证

- 用 `createScriptedAiEngineHarness()` 写红绿测试。
- 在 host harness 里覆盖：多 provider 切换、`reasoning_details` 流式累积、`tool_call` sidecar 回放。
