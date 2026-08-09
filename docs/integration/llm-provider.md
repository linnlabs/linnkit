# LLM Provider · 接 LLM provider

> **What** · 实现 `AgentAiEngine` 接 OpenAI / Anthropic / DeepSeek / OpenRouter 等 provider，含流式 + 非流式 + reasoning sidecar。
> **When to read** · 选定 LLM provider 后做适配器；要扩展支持的模型族；做多 provider 路由 / fallback。
> **Prerequisites** · [`02-quickstart.md`](./02-quickstart.md)。
> **Key exports** · `AgentAiEngine` / `LlmCallOptions` / `LlmRequestMessage` / `ToolCall` / `ProviderReasoningDetails` from `@linnlabs/linnkit/ports` · `CanonicalLlmUsage` from `@linnlabs/linnkit/contracts`。
> **Related** · [`token-management.md`](./token-management.md) · [`agent-registration-guide.md`](./agent-registration-guide.md) ⭐ · [`context-engineering.md` §10](./context-engineering.md)

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

> ⚠️ **注意**：被工具历史删除、工具历史可选压缩 / 历史摘要替换 / chat formatter 处理过的旧工具组，不再保证 sidecar 可回放——这是 token 预算与 chat 兼容层的设计取舍。如果某个 provider 强要求 reasoning blocks 必须随回传，请确保该工具组以原始 `tool_call_decision + tool_output` 结构进入下一轮上下文。

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

## 4. 图片输入与模型适配

图片输入由模型能力与 adapter 协议能力共同决定：

| 层级 | 真相源 | 含义 |
|---|---|---|
| 模型能力 | `ModelCatalogEntry.capabilities` | 模型是否声明 `image_input` |
| Adapter 位置 | `ModelCatalogEntry.adapter_input_support` | 当前 API surface 的 converter 是否已经实现对应位置 |

`user_image` 与 `tool_result_image` 是 runtime 从最终消息和已暴露工具派生的输入来源，不是模型配置项。图片调用必须同时满足：具体模型声明 `image_input`，且当前 adapter descriptor 对本次全部 placement 都为 `true`。不得根据 model ID、display name、provider 或 API base 猜测模型图片能力；adapter 能力必须来自与真实选路同源的显式 descriptor。

复用同一已验收 API surface 的视觉模型只需声明 `image_input`，不需要再配置图片来源。若某个兼容网关实际不支持该 surface 已声明的工具图片协议，应拆成准确的 adapter route/descriptor 并保持 fail closed，不能把协议差异下沉为模型级开关。

### 4.1 Durable 与 resolved 两段合同

Context 与持久化层只保存 `RuntimeResourceRef`，包含稳定资源身份、媒体类型、尺寸、长度和摘要，不包含本地路径、object URL、base64 或 bytes。发送前由 host 实现的 `LlmInputMaterializerPort` 在每次真实 attempt 上完成 scope、完整性、route 限额和预算复核，产出只供 adapter 消费的 `ResolvedLlmInputMessage`。

图片 requirement 必须从每次调用的 final messages 重新派生。历史中曾经有图，不代表当前调用永久需要图片能力；图片消息退出最终上下文后 requirement 应自然解除。fallback 切换模型后必须按新 route 的 profile 重新校验和物化，不能复用上一 attempt 的 bytes。

### 4.2 新增图片 Adapter 的实施顺序

1. 为 API surface 定义窄 typed request part，不复用其他 provider 的宽对象。
2. 同时实现流式与非流式共用的 message converter 和 request builder。
3. 增加 policy 后 finalizer：只接受该 surface 的合法图片 part，并递归拒绝 durable 字段。
4. 增加 metadata-only debug projector；日志不得包含 base64、bytes、路径、hash、文件名或资源 ID。
5. 登记 route 的图片 processing profile，明确 MIME、单图/总大小、张数、transport、detail 和 token 估算。
6. provider body 测试通过后才打开 adapter placement；具体模型只需单独声明 `image_input` capability。

`tool_result_image` 还要求 provider 原生工具结果协议已经验收。不能因为同一模型支持普通 user 图片，就把工具图片伪装成普通 user 消息；这会改变信任边界和工具调用语义。尚未验收工具图片的 Chat Completions 兼容面应稳定拒绝，而不是静默丢图。

### 4.3 错误与验证门禁

- capability、placement、asset scope、完整性、route 限额和 mapping 失败都必须在 provider attempt 前失败，并进入同一条结构化错误链。
- 任一附件失败时整批不产生 resolved 结果；不得部分发送。
- context 预算必须把同一图片组件计费一次，含图 tool call/output 组保持原子，不被摘要或裁剪拆开。
- child run 默认不继承父附件；只有显式策略允许时才保留 durable identity，并在 child 自己的最终上下文重新校验。
- 最小业务验证应覆盖：final messages → requirement、materializer → typed provider body、流式/非流式等价、模型 capability 与 route placement 的双侧拒绝、fallback 重新物化、工具图片回放和日志脱敏。

## 5. 你必须做的

1. 实现一个符合 `AgentAiEngine` 的 adapter，把 HTTP / SDK 调用封进 `chatCompletion[Stream]`。
2. 在 runtime-assembly 里把 `aiEngine` 通过 `runtimeKernel.llm.LlmCaller` 包一层。
3. 实现 `ModelResolver` / `ModelCatalog`（来自 `@linnlabs/linnkit/runtime-kernel` 的 `llm` namespace），把 host 的 modelId 解析为 provider + provider modelId。
4. 尽量在 adapter 响应里返回 `canonicalUsage`。provider 私有 usage 字段应该在 host adapter 里归一化；linnkit 只提供 OpenAI-compatible 的保守默认解析，不负责猜 Anthropic / Gemini / 中转平台的字段语义。

## 6. 你不要做的

- 不要让 graph-side 代码直接知道你家 SDK 的 HTTP 形态。
- 不要在测试里 patch 模块级全局 ai engine——通过依赖注入替换。
- 不要把 provider 重试 / 审计 / fallback 逻辑散落在 host 业务文件里——收敛到 adapter 内。
- 不要把缺失的 usage 字段伪造成 0。拿不到 input/output 时就不要返回 `canonicalUsage`，避免污染成本统计和 calibration 样本。
- 不要让 provider adapter 自己读取 workspace 路径；它只能接收 materializer 已解析的 `ResolvedLlmInputMessage`。
- 不要把 durable attachment 对象原样放进 HTTP/SDK body，也不要用“忽略未知字段”作为图片未适配时的 fallback。

## 7. 最小验证

- 用 `createScriptedAiEngineHarness()` 写红绿测试。
- 在 host harness 里覆盖：多 provider 切换、`reasoning_details` 流式累积、`tool_call` sidecar 回放。
- 图片 surface 还要覆盖真实文件/账本 → resolver → Context → materializer → provider finalizer 的 host-bound Agent loop；外网 live smoke 只能补充，不能替代离线 body 合同。
