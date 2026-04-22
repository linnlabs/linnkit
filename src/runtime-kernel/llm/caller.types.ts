/**
 * @file src/agent/runtime-kernel/llm/caller.types.ts
 * @description
 * LlmCaller 对外类型（拆分自 caller.ts），避免 caller 文件承担过多“结构定义”职责。
 *
 * 约定：
 * - 这里只放类型定义，不包含业务逻辑；
 * - 供 caller / streaming 聚合器 / 单测 与上层引用。
 */

/**
 * 工具调用的结构类型（OpenAI tool_calls 兼容）
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
  /**
   * Gemini / Google OpenAI-compat 扩展字段：用于传递 thought_signature。
   * 说明：Gemini 思考模型在函数调用轮次中会返回该字段，下一轮必须原样回传。
   */
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
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
   * Gemini / Google OpenAI-compat 增量字段（可能只在首个 tool_call 上出现一次）
   */
  extra_content?: {
    google?: {
      thought_signature?: string;
    };
  };
}

/**
 * LLM 流式/非流式的统一响应载荷（caller 内部使用）
 */
export interface LlmResponseContent {
  content?: string;
  tool_calls?: ToolCall[] | ToolCallChunk[];
  /**
   * OpenRouter / reasoning models 扩展：必须原样回传的 reasoning blocks
   */
  reasoning_details?: unknown[];
  /**
   * 供应商返回的 token 用量（若支持）
   *
   * 中文备注：
   * - 流式场景需配合 `stream_options.include_usage` 才可能拿到；
   * - 不同 provider 字段可能不同（例如 mock 返回 usage.tokens），上层应做归一化处理。
   */
  usage?: unknown;
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
   * 注意：不同 provider 的“强制工具调用”字段名可能不同（例如 Anthropic 为 {type:'tool', name}），
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
   * - Cloud（积分计费）模式下，客户端重试会导致“一次点击一个 request_id”的账单语义被破坏，
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

