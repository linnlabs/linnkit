/**
 * @file src/agent/shared/llmTelemetryContext.ts
 *
 * @description
 * LLM Telemetry 上下文（用于审计/统计，不进入模型上下文，不落库到 EventStore）。
 *
 * 中文备注（设计约束）：
 * - 某些“多阶段/多子任务”的审计需要一个可聚合的数据源；
 * - 这些数据不适合塞进 RuntimeEvent（会污染主时间轴、跨端联动成本高）；
 * - 因此这里用 AsyncLocalStorage 提供“同一条异步链路内可写入/可聚合”的基础设施；
 * - 默认不启用：只有当业务侧显式用 `withLLMTelemetryContext(...)` 包裹执行链路时才会收集。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { CanonicalLlmUsage } from '../contracts';

export type LlmUsageRaw = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /**
   * 仅保留旧 mock/自研 adapter 的 raw 形状；total-only 不能诚实拆成 input/output，
   * 因此不会被采信为 provider actual canonical usage。
   */
  tokens?: number;
};

export type NormalizedLlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  canonicalUsage?: CanonicalLlmUsage;
};

export type LLMTelemetryContext = {
  /**
   * 预留：用于业务侧注入“聚合维度”。
   *
   * 中文备注：
   * - 该字段不进入模型上下文、不落库，仅用于本地统计/审计聚合；
   * - 建议只放稳定标识（如 conversationId/turnId/runId 等），避免塞入大对象。
   */
  scope?: {
    conversationId?: string;
    turnId?: string;
    runId?: string;
    stepId?: string;
    stepIndex?: number;
  };
};

export type LlmCallTelemetry = {
  modelId: string;
  stream: boolean;
  startedAt: number;
  durationMs: number;
  usage?: NormalizedLlmUsage;
  canonicalUsage?: CanonicalLlmUsage;
};

type Store = {
  ctx: LLMTelemetryContext;
  calls: LlmCallTelemetry[];
};

const als = new AsyncLocalStorage<Store>();

function readTokenCount(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

export function normalizedUsageFromCanonical(canonicalUsage: CanonicalLlmUsage): NormalizedLlmUsage {
  return {
    promptTokens: canonicalUsage.inputTokens,
    completionTokens: canonicalUsage.outputTokens,
    totalTokens: canonicalUsage.totalTokens ?? canonicalUsage.inputTokens + canonicalUsage.outputTokens,
    canonicalUsage,
  };
}

/**
 * OpenAI-compatible provider response usage 的最小 canonical 映射。
 *
 * 中文备注：
 * - 只有同时拿到 input/output 时才构造 canonical，避免把缺失字段伪造成 0；
 * - OpenAI-compat 的 cached input 会从 prompt_tokens 中拆出，避免 input/cache 重复计费；
 * - 这里只覆盖 OpenAI-compatible 格式，不识别 Anthropic / Gemini 等 provider family 专有字段。
 */
export function normalizeCanonicalLlmUsage(usage: unknown): CanonicalLlmUsage | undefined {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const rec = usage as Record<string, unknown>;

  const inputTokens = readTokenCount(rec, 'prompt_tokens');
  const outputTokens = readTokenCount(rec, 'completion_tokens');
  if (inputTokens === undefined || outputTokens === undefined) {
    return undefined;
  }

  const promptDetails = readRecord(rec, 'prompt_tokens_details');
  const completionDetails = readRecord(rec, 'completion_tokens_details');
  const cacheReadTokens = promptDetails ? readTokenCount(promptDetails, 'cached_tokens') : undefined;
  const reasoningTokens = completionDetails ? readTokenCount(completionDetails, 'reasoning_tokens') : undefined;
  const totalTokens = readTokenCount(rec, 'total_tokens');
  if (cacheReadTokens !== undefined && cacheReadTokens > inputTokens) {
    return undefined;
  }

  return {
    inputTokens: cacheReadTokens !== undefined ? inputTokens - cacheReadTokens : inputTokens,
    outputTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    source: 'provider-response-usage',
    confidence: 'actual',
    rawUsage: usage,
  };
}

/**
 * 旧 telemetry / RunCost 仍消费 prompt/completion 三字段；真实语义挂在 canonicalUsage 上。
 */
export function normalizeLlmUsage(usage: unknown): NormalizedLlmUsage | undefined {
  const canonicalUsage = normalizeCanonicalLlmUsage(usage);
  return canonicalUsage ? normalizedUsageFromCanonical(canonicalUsage) : undefined;
}

export function getCurrentLLMTelemetryContext(): LLMTelemetryContext | undefined {
  return als.getStore()?.ctx;
}

export function recordLlmCallTelemetry(entry: LlmCallTelemetry): void {
  const store = als.getStore();
  if (!store) return;
  store.calls.push(entry);
}

export async function withLLMTelemetryContext<T>(
  ctx: LLMTelemetryContext,
  fn: () => Promise<T>
): Promise<{ value: T; calls: LlmCallTelemetry[] }> {
  const parent = als.getStore();
  const merged: LLMTelemetryContext = {
    ...(parent?.ctx ?? {}),
    ...(ctx ?? {}),
  };
  const store: Store = { ctx: merged, calls: [] };
  const value = await als.run(store, fn);
  return { value, calls: store.calls };
}
