import {
  normalizedUsageFromCanonical,
  normalizeLlmUsage,
  recordLlmCallTelemetry,
} from '../../../../shared/llmTelemetryContext';
import { extractResponseText, resolveCanonicalUsage, resolveUsage } from '../helpers';
import type { TickAroundMiddleware } from '../types';

export const llmTelemetryMiddleware: TickAroundMiddleware = async (ctx, stage, next) => {
  await next();

  if (stage.id !== 'execute_llm' || ctx.llmCallStartedAt === undefined || ctx.llmCallDurationMs === undefined) {
    return;
  }

  const canonicalUsageFromHost = resolveCanonicalUsage(ctx.llmResp);
  const normalizedUsageFromProvider = canonicalUsageFromHost
    ? normalizedUsageFromCanonical(canonicalUsageFromHost)
    : normalizeLlmUsage(resolveUsage(ctx.llmResp));
  const respText = extractResponseText(ctx.llmResp);
  const normalizedUsage =
    normalizedUsageFromProvider ??
    (() => {
      try {
        const promptTokens = ctx.llmMessages.reduce(
          (total, message) => total + ctx.tokenizer.estimateMessage(message, ctx.modelId),
          0,
        );
        const completionTokens = ctx.tokenizer.estimateText(respText, ctx.modelId);
        return normalizedUsageFromCanonical({
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          totalTokens: promptTokens + completionTokens,
          source: 'local-estimate',
          confidence: 'estimate',
        });
      } catch {
        return undefined;
      }
    })();

  recordLlmCallTelemetry({
    modelId: ctx.modelId,
    stream: ctx.input.stream === true,
    startedAt: ctx.llmCallStartedAt,
    durationMs: ctx.llmCallDurationMs,
    usage: normalizedUsage,
    ...(normalizedUsage?.canonicalUsage ? { canonicalUsage: normalizedUsage.canonicalUsage } : {}),
  });

  // B2-engine Batch 1: 同步上报到宿主侧 TelemetryPort（默认 noopTelemetry，业务无感）
  // 与 ALS 写入互不影响：ALS 给 benchmark 等"链路内聚合"场景，TelemetryPort 给宿主全局 sink。
  ctx.telemetry.emit({
    kind: 'llm_call',
    modelId: ctx.modelId,
    stream: ctx.input.stream === true,
    durationMs: ctx.llmCallDurationMs,
    usage: normalizedUsage,
    ...(normalizedUsage?.canonicalUsage ? { canonicalUsage: normalizedUsage.canonicalUsage } : {}),
    scope: {
      conversationId: ctx.conversationId || undefined,
      turnId: ctx.turnId,
      runId: ctx.input.toolContext?.runId ?? ctx.turnId,
      parentRunId: ctx.input.toolContext?.parentRunId,
    },
  });
};
