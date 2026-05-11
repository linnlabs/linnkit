/**
 * @file src/agent/runtime-kernel/llm/policies/types.ts
 *
 * @description
 * LLM Policy 是对“供应商/模型组合差异”的封装。
 * 主链路只调用 PolicyEngine，不再内联 provider-specific 逻辑。
 */

export type LLMPolicyMatchContext = {
  /** 逻辑模型 ID（如 google/gemini-3-pro-preview） */
  modelId?: string;
  /** 供应商/网关的 base url（如 https://openrouter.ai/api/v1） */
  apiBase?: string;
  /** 实际请求体中的 model 字段（如 google/gemini-3-pro-preview） */
  requestModelName?: string;
};

export type LLMPolicyRequestContext = LLMPolicyMatchContext & {
  endpoint: string;
  requestData: unknown;
  headers?: Record<string, string>;
};

export type LLMPolicyResponseContext = LLMPolicyMatchContext & {
  endpoint: string;
  responseData: unknown;
};

export type LLMPolicyErrorDecision =
  | { action: 'none' }
  | { action: 'retry'; delayMs?: number }
  | { action: 'switch_model'; reason: string };

export interface LLMPolicy {
  /** 名称仅用于日志/调试 */
  name: string;

  /** 是否匹配当前请求上下文 */
  match(ctx: LLMPolicyMatchContext): boolean;

  /** 发送前：可修改 requestData / headers（必须保持幂等） */
  beforeRequest?(ctx: LLMPolicyRequestContext): { requestData?: unknown; headers?: Record<string, string> };

  /** 收到后（非流式）：可修改 responseData（必须保持幂等） */
  afterResponse?(ctx: LLMPolicyResponseContext): { responseData?: unknown };

  /** 错误处理：给主链路一个“是否需要切模型/重试”的建议 */
  onError?(error: Error, ctx: LLMPolicyMatchContext): LLMPolicyErrorDecision;
}
