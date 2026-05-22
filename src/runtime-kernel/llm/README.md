# LLM 调用层

## 概述

`packages/linnkit/src/runtime-kernel/llm/` 是 runtime-kernel 下的 LLM 调用模块，提供统一的 LLM 调用接口、流式聚合与通用策略引擎。

## Adapter vs Policy（重要）

本项目将“供应商差异”拆成两层来控制复杂度：

- **Adapter（适配器）**：负责“线协议 / API 形态”的差异，也就是**怎么发请求、怎么收响应**。
  - 典型职责：
    - 选择端点：`chat/completions` vs `responses`
    - headers / auth / provider routing（如 OpenRouter 的 `HTTP-Referer`、`X-Title`、`provider` 字段）
    - 流式格式解析（SSE chunk 的拆分与解码）
  - 代码位置：`src/infra/adapters/llm/*`

- **PolicyEngine（策略引擎）**：负责提供“请求/响应边界策略”的通用执行机制。
  - 典型职责：
    - 按 `match` 选择策略
    - 发送前/收到后按序调用 hook
    - 失败时收集“是否切换模型/是否重试”的建议
  - `linnkit` 只提供 `LLMPolicyEngine` / `LLMPolicy` 类型和空的 `defaultPolicyEngine`
  - provider/model 具体策略由宿主注入，例如 Linnya 位于 `src/infra/adapters/llm/policies/*`

**设计目标**：
- 主链路（Graph/Context/Formatter/LlmCaller）尽量固化，只调用宿主注入的 PolicyEngine；
- 新增或变更供应商/模型组合时，优先在宿主 adapter / integration 层新增 policy 文件，而不是在 `linnkit` 里堆厂商 if/else。

## 职责

- **LLM 调用封装**: 统一管理流式和非流式 LLM 调用
- **重试策略**: 智能错误分类和重试机制
- **错误处理**: 统一的错误处理和日志记录
- **模型管理**: 模型选择和配置管理

中文备注：

- `ModelResolver` 负责“模型解析 / 默认聊天模型 / 策略切模备用模型选择”；
- `LlmCaller` 只负责“对外编排入口”，实际调用、流式适配、重试与路由修正已拆到独立文件；
- `ModelCatalogLike` 负责提供最小模型元数据查询协议，真实实现由宿主注入；
- 这样 `prepareCallStage` 可以直接依赖 `ModelResolver + ModelCatalogLike`，不必再直接 import app `model-registry`。

## 模块结构

```text
packages/linnkit/src/runtime-kernel/llm/
├── caller.ts                 # LlmCaller - 对外 orchestrator，保持 public API
├── request-builder.ts        # 构造参数归一化与依赖装配
├── streaming-adapter.ts      # 流式 chunk/thought/tool_call → AgentEvent 适配
├── retry-fallback.ts         # 重试循环、错误分类、最终 error 事件收敛
├── retry-fallback-routing.ts # 策略切模与 cloud quota fallback 路由
├── usage-telemetry.ts        # 非流式响应与 usage 字段归一化
├── sidecar-replay.ts         # provider sidecar / tool_call JSON 守卫
├── reasoning-details.ts      # reasoning_details 流式纯文本片段归并
├── modelResolver.ts          # Phase 1.5-4：模型解析与策略切模备用模型选择
├── policies/          # ✅ 通用策略引擎（不内置 provider/model 策略）
│   ├── types.ts
│   ├── policyEngine.ts
│   ├── defaultPolicyEngine.ts
├── index.ts           # 统一导出
└── README.md          # 本文档
```

## 核心组件

### LlmCaller

**职责**: 
- 暴露 `call / callStream / callWithRetries` 三个稳定入口
- 装配并委托到非流式响应归一化、流式适配、智能重试策略
- 支持流式和非流式调用
- 支持取消信号 (AbortSignal)
- **调用宿主注入的 PolicyEngine**：在失败时基于策略建议执行“切换模型/重试”（避免主链路内联组合特判）

**输入**:
- `modelId`: 模型ID
- `messages`: 消息数组
- `options`: LLM 调用选项（工具、温度等）
- `eventHandler`: (可选) 流式事件处理器
- `signal`: (可选) 取消信号

### ModelResolver / ModelCatalog

**职责**:
- 解析显式请求模型或默认聊天模型
- 收口“策略切模”备用模型选择规则
- 隔离 model catalog 选模细节，不让 caller / executor stage 重复感知

`ModelCatalogLike` 的职责：
- 提供 `getModelById / getModelsByCapability / getModelsByUIVisibility`
- 作为 runtime-kernel 的最小模型目录协议
- 当前 Linnya 默认实现位于 `src/app-hosts/linnya/adapters/runtime-assembly/modelCatalog.ts`

### 构造参数

`LlmCaller` 当前支持两类构造方式：

1. 直接传结构化选项

```ts
new LlmCaller({
  maxRetries: 3,
  enableEmptyResponseRetry: true,
  retryDelayMs: 1000,
  aiEngine,
  modelCatalog,
});
```

2. 传 fallback / policy 相关选项

```ts
new LlmCaller({
  aiEngine,
  modelCatalog,
  fallbackModelPreferredOrder: ['model-a', 'model-b'],
  policyEngine,
});
```

中文备注：

- `fallbackModelPreferredOrder` 现在通过构造函数注入；
- `policyEngine` 可由宿主通过构造函数注入；不传时使用空的 `defaultPolicyEngine`；
- 这让 `runtime-kernel/llm/caller.ts` 不再直接依赖产品层的 fallback 模型常量或供应商策略。

### Provider sidecar

`LlmCaller` 对 provider sidecar 只做通用搬运，不解释厂商字段：

- 非流式响应中的 `reasoning_details` 会随 `{ content, tool_calls?, reasoning_details? }` 返回。
- 流式响应中的 `reasoning_details` 会被累积到最终返回值；相邻的纯 `reasoning_content` 文本片段由 `reasoning-details.ts` 统一归并。
- 流式过程中还会发出 `provider_sidecar` 事件，供 host 层把 sidecar 落到最终 `final_answer.reasoning_details`。
- DeepSeek `reasoning_content`、Gemini `thought_signature` 等 wire format 互译应留在 Linnya adapter / integration / policy 层。

**输出**:
- 非流式: `string | { content: string, tool_calls?: ToolCall[], reasoning_details?: unknown[] }`
- 流式: 通过 `eventHandler` 回调流式事件

## 使用示例

```typescript
import { LlmCaller } from '@/agent/runtime-kernel/llm';

const caller = new LlmCaller({
  aiEngine,
  modelCatalog,
  maxRetries: 3,
  enableEmptyResponseRetry: true,
  retryDelayMs: 1000,
  fallbackModelPreferredOrder: ['fallback-a', 'fallback-b'],
});

// 非流式调用
const response = await caller.call(modelId, messages, options);

// 流式调用
const response = await caller.callStream(
  modelId, 
  messages, 
  options, 
  (event) => {
    // 处理流式事件
  }
);

// 带重试的调用
const response = await caller.callWithRetries(
  modelId, 
  messages, 
  options, 
  eventHandler
);
```

## 架构位置

`LlmCaller` 被以下模块使用：
- `src/app-hosts/linnya/adapters/runtime-assembly/graphRuntimeFactory.ts` - 默认产品运行时装配
- `packages/linnkit/src/runtime-kernel/graph-engine/executor.ts` - 由调用方注入后使用

## 设计原则

1. **单一职责**: 只负责 LLM 调用，不关心业务逻辑
2. **无状态**: 不维护任何会话状态
3. **可配置**: 重试策略、超时等都可配置
4. **可测试**: 纯函数式设计，易于单元测试
