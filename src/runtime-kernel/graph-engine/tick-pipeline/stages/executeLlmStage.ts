import type { AnyAgentEvent } from '../../../events/agentEvents';
import type { LlmCaller } from '../../../llm/caller';
import type { TickPipelineContext, TickStage } from '../types';
import { readNonEmptyString } from '../helpers';
import { emitAuditEnvelope } from '../../../audit/emitAudit';

export interface ExecuteLlmStageDependencies {
  llmCaller: Pick<LlmCaller, 'callWithRetries'>;
}

export function createExecuteLlmStage(
  dependencies: ExecuteLlmStageDependencies,
): TickStage {
  return {
    id: 'execute_llm',
    async run(ctx: TickPipelineContext): Promise<void> {
      ctx.cloudQuotaFallbackAppliedModelId = undefined;
      ctx.modelFallbackAudit = undefined;

      const streamEventHandler: ((event: AnyAgentEvent) => void) | undefined =
        ctx.input.stream && ctx.eventHandler
          ? (event: AnyAgentEvent) => {
              ctx.eventHandler?.(event);
            }
          : undefined;

      ctx.llmCallStartedAt = Date.now();
      ctx.llmResp = await dependencies.llmCaller.callWithRetries(
        ctx.modelId,
        ctx.llmMessages,
        ctx.llmOptions,
        streamEventHandler,
        ctx.signal,
        (fallbackModelId: string) => {
          ctx.cloudQuotaFallbackAppliedModelId = readNonEmptyString(fallbackModelId);
        },
        (info) => {
          ctx.modelFallbackAudit = info;
        },
      );
      ctx.llmCallDurationMs = Date.now() - ctx.llmCallStartedAt;

      if (ctx.modelFallbackAudit) {
        await emitAuditEnvelope(ctx.audit, {
          action: 'model.fallback',
          actor: { kind: 'system' },
          decision: {
            outcome: 'fallback',
            reason: ctx.modelFallbackAudit.reason,
            policy: ctx.modelFallbackAudit.policy,
            metadata: {
              fromModelId: ctx.modelFallbackAudit.fromModelId,
              toModelId: ctx.modelFallbackAudit.toModelId,
            },
          },
          evidence: [
            {
              kind: 'llm_error',
              summary: ctx.modelFallbackAudit.reason,
            },
          ],
          scope: {
            conversationId: ctx.conversationId || undefined,
            turnId: ctx.turnId,
            runId: ctx.input.toolContext?.runId ?? ctx.turnId,
            parentRunId: ctx.input.toolContext?.parentRunId,
            modelId: ctx.modelFallbackAudit.toModelId,
          },
        });
      }
    },
  };
}
