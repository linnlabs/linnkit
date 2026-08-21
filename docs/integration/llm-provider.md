# LLM Provider · Canonical inference Host 接入

> **What** · Host 通过 `CanonicalInferencePort` 把 Linnkit 接到 Provider SDK。
> **When to read** · 接入 OpenAI、Anthropic、Google、兼容网关或自建模型时。
> **Key exports** · `CanonicalInferencePort` / `CanonicalInferenceRequest` / `CanonicalInferenceEvent` from `@linnlabs/linnkit/ports`。
> **Related** · [`token-management.md`](./token-management.md) · [`testing.md`](./testing.md) · [`context-engineering.md`](./context-engineering.md)

## 1. 正式合同

`CanonicalInferencePort` 是唯一 LLM Host port。旧 `AgentAiEngine`、OpenAI-shaped callback stream 和模块级 patch harness 已删除，不提供兼容 bridge。

`LlmCaller` 仍然属于 Linnkit 内核，它拥有：

- 输入能力校验、每次 attempt 的图片物化与总调用预算；
- 同模型重试、产品已批准的模型 fallback 和 Cloud quota 续跑策略；
- canonical stream 到 AgentEvent / RuntimeEvent 的唯一映射；
- thought、answer、tool call、usage 和 continuation 的持久化语义。

Host 拥有：

- Linnya model ID 到显式 Provider route 的解析；
- 每次 attempt 的 credential、base URL 和 headers；
- Provider SDK 的 message/tool/options 映射；
- Provider 事件、raw usage、continuation 和错误的安全投影。

Provider SDK 不得执行工具、开启自动 multi-step、自行重试或决定切模型。

## 2. 请求与流事件

Canonical request 只携带 Linnkit 已经决定的事实：模型 ID、resolved messages、可移植 JSON Schema 工具、tool choice、sampling、AbortSignal 和 invocation identity。API key、base URL、Provider 对象和 Provider 重试参数不能进入 Linnkit。

Stream 是 discriminated union：

- `start`；
- `answer_delta` / `thought_delta`；
- `tool_call_start` / `tool_argument_delta` / `tool_call_end`；
- `assistant_part_end` / `usage`；
- 唯一 terminal：`finish` 或 `failure`。

`tool_call_start.part_index` 与 `assistant_part_end.index` 是一次 Assistant 产出内跨 text/reasoning/tool 的全局顺序。索引在 part 开始时分配，不能按结束顺序补排。`consumeCanonicalInferenceStream()` 会检查单 start、单 terminal、工具 block 生命周期、ID/name 一致性、part index 唯一性和截断 stream。Host 不应用 try/catch 或 fallback 绕过这些错误。

## 3. Provider continuation

Reasoning signature、encrypted reasoning item 和 Provider part metadata 统一映射为版本化 `ProviderContinuation`，并绑定到 `assistant_replay_parts` 的所属 part。每项必须包含完整 producer route identity：

- Host model ID；
- endpoint ID；
- API surface；
- capability ID；
- endpoint model ID。

Continuation 只能回放到完全相同的 route 和 part target；tool continuation 还必须匹配 `tool_call_id`。当前选中的模型 ID 不能代替 producer identity，Host 也不得从历史文本、模型名、URL 或常见 content block 顺序猜测来源。

Linnkit 只验证 continuation 外层 schema、身份和顺序，然后原样转交、持久化与审计；它不读取 `payload` 内部字段，不按内容合并、去重、压缩或补空值。只有拥有对应 capability 的 Host codec 可以解释 payload。可见 reasoning 文本继续使用 canonical reasoning part，不为了某个 Provider 的回放规则伪装成 opaque continuation。

`inference_route.continuation.tool_replay` 是 presence policy 的唯一真相源。`required` route 上每个完整工具调用都必须有有序 tool continuation；缺失时 fail closed，不补空字段，不从 `<think>` 文本伪造。当前 Host 持久化基线只接受 continuation v2 和 ordered parts；桌面开发数据不再迁移匿名、无序或缺少 capability identity 的历史 sidecar，也不按当前模型猜测。

## 4. Usage provenance

`usage` 事件只能承载 `source=provider-response-usage` 且 `confidence=actual` 的 canonical usage。未上报时不发 usage 事件，禁止用 0、本地估算或 Linnkit 对 raw response 的猜测冒充 Provider 事实。

使用 Vercel AI SDK 的 Host 只从 `LanguageModelUsage` 标准字段构造 canonical 数值；`usage.raw` 只证明本次 Provider 确实上报了 usage，并作为 opaque provenance 保留。Host 不再按 API surface 解析 `prompt_tokens`、`completion_tokens` 或其他厂商 raw key；若标准字段缺少 canonical 必需的 input/output 数值，本次不产生 actual usage。`rawUsage` 可用于受限对账，不进入 UI，不在普通日志打印，Linnkit 也不会读取它补数。

## 5. 图片输入

Context 和持久化层只保存 `RuntimeResourceRef`。Host 的 `LlmInputMaterializerPort` 在每个真实 attempt 的 route 确定后物化 bytes，并校验 workspace scope、完整性、MIME、尺寸、预算和 placement。

`user_image` 与 `tool_result_image` 是 canonical history 中两个独立的图片来源，不能互相改写角色。产品只需声明统一的
`image_input` 模型能力；Linnya 的视觉开关会同时允许这两个来源。Host codec 仍必须按各自原生角色编码，尤其不能因为
Provider package 只方便编码 user 图片，就把工具结果图片伪装成 user message。Fallback 到新 route 后必须重新校验和
物化，不复用上一 attempt 的 bytes。非视觉模型仍可执行图片生成工具并向用户展示结果，只是不产生下一轮模型附件。
Host 的固定 route profile 必须声明第三方 codec 实际支持的图片来源；只有同时原生支持两种来源的 profile 才能承载
产品的统一 `image_input` 能力。Chat-only profile 可以编码用户图片，不等于能够声明完整视觉能力。

## 6. Vercel AI SDK 可选 adapter 与 Host 实现约束

通用 AI SDK 实现见 [`@linnlabs/linnkit-provider-ai-sdk`](https://github.com/linnlabs/linnkit/tree/main/packages/provider-ai-sdk)。Linnkit 只看到 canonical port；可选 adapter 拥有 AI SDK Core、Provider packages 和 factory conformance，Host 仍拥有产品目录、route、credential 与 audit。核心约束是：

- Adapter 只维护一个类型安全的 Provider factory registry，Host 业务代码和 Linnkit 不直接 import 具体 language package；
- “一个 registry”不表示“一个 npm 包”：OpenAI、Anthropic、Google、DeepSeek、MiniMax 等正式协议各注册对应第三方 package factory，通用 OpenAI-compatible 只服务确实属于该兼容合同的 endpoint；
- Adapter registry 只按显式 `capability_id` 选 factory，`endpoint_id`、模型名、base URL 和厂商品牌都不能选择 codec；
- Host 每次 attempt 传入已解析的 credential、base URL 和 headers，adapter 不读 SDK 默认环境变量；
- OpenAI Chat、OpenAI Responses、Anthropic Messages、Google Generative AI、DeepSeek Chat、MiniMax Chat、Moonshot/Kimi Chat 与 Alibaba/Qwen Chat 是显式 profile，不根据 model name 猜测；
- 每次 `streamText` 固定单 step、`maxRetries: 0`、无 `execute`、无 tool repair、无 Agent API；
- Adapter 使用 AI SDK 原生 first/chunk timeout 限制连续无内容分片时间；timeout、未知上游断流和 terminal 前 EOF 投影为可重试 transport failure，用户取消仍是 aborted，adapter 能证明的 stream 状态机违规才是不可重试 protocol failure；
- Provider error 只由 adapter 投影稳定 code/retryable/kind，response body 不进入 canonical stream 或日志。
- `contracts`、`ports`、`context-manager`、`runtime-kernel` 与通用 `shared` 由 boundary guard 约束：不能 import Provider SDK，不能出现厂商 wire 字段或按厂商/模型家族名称分支；CLI quickstart 和 Host conformance fixture 不属于核心实现。

每个正式 factory 必须暴露 package 名称与版本，统一参加 adapter package conformance。升级 AI SDK Core 或任一 Provider package 后，至少重跑真实 SDK request codec、SSE/event、工具增量、usage provenance、continuation round-trip、认证、零重试与 packed CJS/ESM 门禁。SDK 负责厂商 wire 适配，不接管 Linnkit 的上下文管理、工具循环、调用预算、fallback 或持久化。

## 7. 测试门禁

Linnkit 测试使用 `createScriptedInferenceHarness()`。Host 测试至少覆盖：

- canonical 文本、thought、工具增量、usage、continuation、finish/failure 的完整流；
- text/reasoning/tool 交错结束仍按 part start index 回放，重复 index 失败；
- 带工具调用的正文封口和 decision 只形成一个 Context Assistant turn；
- 无 terminal、重复 terminal、未闭合工具、非 JSON object 参数和 route identity 不匹配；
- 零 SDK 重试、Abort 不发普通 error、工具只产生数据不执行；
- 首分片/中途分片空闲、未知断流、Host 状态机违规与用户取消的独立终因；Linnkit 重试前撤回失败 attempt 的 partial output，成功重试只形成一个 durable Assistant turn；
- 每个 API surface 的受控 request/event/raw-usage fixture；
- 生产 composition root 的 Model Catalog → Host port → capability 路由；
- 有图输入的 final messages → requirement → materializer → Provider body 闭环。

Live smoke 只是补充，不能替代离线受控 fixture。桌面安装包、签名、公证和 Windows 安装属于 Electron 发布门禁，不阻塞 canonical Provider 代码开发与合并。
