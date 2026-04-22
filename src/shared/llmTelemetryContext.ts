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

export type LlmUsageRaw = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /**
   * 兼容：部分 mock/自研 adapter 只返回 usage.tokens
   */
  tokens?: number;
};

export type NormalizedLlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
};

type Store = {
  ctx: LLMTelemetryContext;
  calls: LlmCallTelemetry[];
};

const als = new AsyncLocalStorage<Store>();

/**
 * 轻量规范化：把 provider 的 usage（不同字段名）收敛为统一结构。
 */
export function normalizeLlmUsage(usage: unknown): NormalizedLlmUsage | undefined {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const rec = usage as Record<string, unknown>;

  const promptTokensRaw = rec['prompt_tokens'];
  const completionTokensRaw = rec['completion_tokens'];
  const totalTokensRaw = rec['total_tokens'];
  const tokensRaw = rec['tokens'];

  const promptTokens = typeof promptTokensRaw === 'number' && Number.isFinite(promptTokensRaw) ? promptTokensRaw : 0;
  const completionTokens =
    typeof completionTokensRaw === 'number' && Number.isFinite(completionTokensRaw) ? completionTokensRaw : 0;
  const totalFromExplicit =
    typeof totalTokensRaw === 'number' && Number.isFinite(totalTokensRaw) ? totalTokensRaw : undefined;
  const totalFromTokens = typeof tokensRaw === 'number' && Number.isFinite(tokensRaw) ? tokensRaw : undefined;

  const totalTokens = totalFromExplicit ?? totalFromTokens ?? promptTokens + completionTokens;

  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return undefined;

  return { promptTokens, completionTokens, totalTokens };
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
