import { TokenCalculator } from '../../../../shared/TokenCalculator';
import {
  normalizeLlmUsage,
  recordLlmCallTelemetry,
} from '../../../../shared/llmTelemetryContext';
import { extractResponseText, resolveUsage } from '../helpers';
import type { TickAroundMiddleware } from '../types';

export const llmTelemetryMiddleware: TickAroundMiddleware = async (ctx, stage, next) => {
  await next();

  if (stage.id !== 'execute_llm' || ctx.llmCallStartedAt === undefined || ctx.llmCallDurationMs === undefined) {
    return;
  }

  const normalizedUsageFromProvider = normalizeLlmUsage(resolveUsage(ctx.llmResp));
  const respText = extractResponseText(ctx.llmResp);
  const normalizedUsage =
    normalizedUsageFromProvider ??
    (() => {
      try {
        const promptTokens = TokenCalculator.estimateMessagesTokensPrecise(ctx.llmMessages, ctx.modelId);
        const completionTokens = TokenCalculator.estimateTokensPrecise(respText, ctx.modelId);
        return {
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
        };
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
  });

  // B2-engine Batch 1: 同步上报到宿主侧 TelemetryPort（默认 noopTelemetry，业务无感）
  // 与 ALS 写入互不影响：ALS 给 benchmark 等"链路内聚合"场景，TelemetryPort 给宿主全局 sink。
  ctx.telemetry.emit({
    kind: 'llm_call',
    modelId: ctx.modelId,
    stream: ctx.input.stream === true,
    durationMs: ctx.llmCallDurationMs,
    usage: normalizedUsage,
    scope: {
      conversationId: ctx.conversationId || undefined,
      turnId: ctx.turnId,
    },
  });
};
