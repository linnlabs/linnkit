/**
 * @file packages/linnkit/src/ports/ai-engine.types.ts
 * @description
 * AI 引擎协议参数 type 的**真正 owner**。
 *
 * 历史背景：这 5 个 type 原本定义在 `runtime-kernel/llm/caller.types.ts`，
 * 但它们的语义其实是"host 实现 `AgentAiEngine` 时要填入的参数形状" —— 属于 ports
 * 协议面，不属于 runtime-kernel 实现层。把它们放在 runtime-kernel 一侧导致
 * `ports/ai-engine.ts` 反向 import runtime-kernel，形成 ports ⇄ runtime-kernel 循环
 * 依赖（rollup dts 打包阶段发出 chunk 循环警告）。
 *
 * 2026-04-23 归位：
 * - 5 个 type 的 **definitive source** 移到本文件
 * - `runtime-kernel/llm/caller.types.ts` 改为从 `'../../ports'` barrel re-export，保持
 *   runtime-kernel 的 public face 兼容（`llm.LlmCallOptions` namespace 访问仍然 work）
 * - `ports` 不再依赖 runtime-kernel，循环彻底消除
 *
 * 约定：
 * - 本文件**只放类型定义**，不包含业务逻辑；
 * - 供 ports / runtime-kernel / testkit / 外部 host 共享引用；
 * - 字段语义与 OpenAI chat completion / tool calls 协议对齐，兼容 Anthropic / Gemini
 *   等供应商（由各 adapter 做映射）。
 */

import type { AiMessage, CanonicalLlmUsage } from '../contracts';

/**
 * 工具调用的结构类型（OpenAI tool_calls 兼容）
 */
export type ProviderReasoningDetails = unknown[];

export type ToolCallExtraContent = {
  google?: {
    thought_signature?: string;
  } & Record<string, unknown>;
} & Record<string, unknown>;

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  /**
   * Provider 工具调用扩展载荷。
   *
   * 说明：
   * - linnkit 不解析 provider 私有内容，只负责在工具调用轮次中原样回放；
   * - Gemini / Google OpenAI-compat 会在 google.thought_signature 中放置签名；
   * - 其他 provider 可使用自己的命名空间承载不透明 replay 数据。
   */
  extra_content?: ToolCallExtraContent;
}

/**
 * 流式工具调用增量（OpenAI tool_calls delta）
 */
export interface ToolCallChunk {
  index: number;
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
  /**
   * Provider 工具调用扩展增量（可能只在首个 tool_call 上出现一次）。
   */
  extra_content?: ToolCallExtraContent;
}

export type LlmRequestMessage =
  | AiMessage
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls: unknown[]; reasoning_details?: ProviderReasoningDetails }
  | { role: 'tool'; tool_call_id: string; content: string };

/**
 * LLM 流式/非流式的统一响应载荷（caller 内部使用）
 */
export interface LlmResponseContent {
  content?: string;
  tool_calls?: ToolCall[] | ToolCallChunk[];
  /**
   * Provider reasoning replay blocks。
   *
   * 这些 blocks 是不透明的 provider sidecar：linnkit 只负责保存、绑定到工具调用决策并在
   * 下一轮回放，具体结构由 adapter/policy 解释。部分 reasoning models 在工具调用后
   * 要求这些 blocks 原样传回，否则后续请求会被拒绝。
   */
  reasoning_details?: ProviderReasoningDetails;
  /**
   * 供应商返回的 token 用量（若支持）
   *
   * 中文备注：
   * - 流式场景需配合 `stream_options.include_usage` 才可能拿到；
   * - 不同 provider 字段可能不同（例如 mock 返回 usage.tokens），上层应做归一化处理。
   */
  usage?: unknown;
  /**
   * 已归一化的 token 用量。
   *
   * host adapter 如果已经理解 provider usage 字段，应直接回传这个结构；
   * linnkit 会优先使用它，避免从 raw usage 里猜 provider family。
   */
  canonicalUsage?: CanonicalLlmUsage;
}

export interface LlmCallOptions {
  tools?: unknown[];
  /**
   * 工具选择策略（OpenAI tool_choice 兼容）
   *
   * 说明：
   * - 'auto' / 'none'：常见 provider 统一语义；
   * - {type:'function', function:{name}}：强制调用指定工具（用于步数收尾策略 force_tools 等）。
   *
   * 注意：不同 provider 的"强制工具调用"字段名可能不同（例如 Anthropic 为 {type:'tool', name}），
   * 但在本系统边界内统一使用 OpenAI-compat 形态，由各 adapter 做映射。
   */
  tool_choice?:
    | 'auto'
    | 'none'
    | { type: 'function'; function: { name: string } };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  /**
   * 重试策略（仅影响客户端侧 `LlmCaller.callWithRetries`）。
   *
   * 背景（中文说明）：
   * - BYOK（本地直连）模式下，客户端重试是合理的：成本由用户自带 key 承担；
   * - Cloud（积分计费）模式下，客户端重试会导致"一次点击一个 request_id"的账单语义被破坏，
   *   因为同一次点击可能触发多次上游调用，造成对账困难或平台资损。
   *
   * 约定：
   * - `client`：允许客户端按本地 retryConfig 重试（默认）；
   * - `none`：强制不重试（只执行一次，失败直接返回错误）。Cloud 模式推荐使用该值或在模型配置中关闭客户端重试。
   */
  retry_policy?: 'client' | 'none';

  /**
   * 云端模型限额降级目标（同一个 run 内续跑专用）
   *
   * 中文说明：
   * - 仅当"同一个 run 内已经不是第一次 LLM 调用"时由上层传入；
   * - 如果本次 LLM 调用因为云端 quota/限额被拒，LlmCaller 会静默切到该模型继续，
   *   不向前端发 error 事件（前端无感知）；
   * - 若为 undefined 或空字符串，则 quota 错误仍按"不可重试"处理（即新请求直接报错）。
   */
  cloud_quota_fallback_model_id?: string;
}

export interface LlmRetryConfig {
  maxRetries: number;
  enableEmptyResponseRetry: boolean;
  retryDelayMs: number;
}
