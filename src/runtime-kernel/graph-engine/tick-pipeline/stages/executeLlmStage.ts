import type { AnyAgentEvent } from '../../../events/agentEvents';
import type { LlmCaller } from '../../../llm/caller';
import { defineTickStage } from '../types';
import type { ModelFallbackAudit, TickPipelineContext, TickStage } from '../types';
import { readNonEmptyString } from '../helpers';
import { emitAuditEnvelope } from '../../../audit/emitAudit';
import type { GraphExecutorOutputProcessor } from '../../executorContextBuilder';
import type { ModelFallbackRejectedInfo } from '../../../llm';
import { runIdFromTurnId } from '../../../../contracts';

export interface ExecuteLlmStageDependencies {
  llmCaller: Pick<LlmCaller, 'callWithRetries'>;
}

export function createExecuteLlmStage(dependencies: ExecuteLlmStageDependencies): TickStage {
  return defineTickStage({
    id: 'execute_llm',
    reads: [
      'input',
      'eventHandler',
      'outputProcessor',
      'modelId',
      'llmMessages',
      'toolModelInputRequirement',
      'toolCallStreamingPolicies',
      'imageInputAdmissionEvidence',
      'llmOptions',
      'signal',
      'audit',
      'conversationId',
      'turnId',
    ],
    writes: [
      'cloudQuotaFallbackAppliedModelId',
      'modelFallbackAudit',
      'llmCallStartedAt',
      'llmResp',
      'llmCallDurationMs',
      'executorLocalPatch',
    ],
    async run(ctx) {
      let cloudQuotaFallbackAppliedModelId: string | undefined;
      let modelFallbackAudit: ModelFallbackAudit | undefined;
      let lastSuccessfulLlmModelId: string | undefined;
      const modelFallbackRejections: ModelFallbackRejectedInfo[] = [];

      const streamEventHandler: ((event: AnyAgentEvent) => void) | undefined =
        ctx.input.stream && ctx.eventHandler
          ? (event: AnyAgentEvent) => {
              const processedEvent = processStreamEvent(event, ctx.outputProcessor);
              if (processedEvent) {
                ctx.eventHandler?.(processedEvent);
              }
            }
          : undefined;

      const llmCallStartedAt = Date.now();
      let llmResp: Awaited<ReturnType<typeof dependencies.llmCaller.callWithRetries>>;
      try {
        llmResp = await dependencies.llmCaller.callWithRetries(
          ctx.modelId,
          ctx.llmMessages,
          ctx.llmOptions,
          streamEventHandler,
          ctx.signal,
          {
            onCloudQuotaFallbackApplied(fallbackModelId) {
              cloudQuotaFallbackAppliedModelId = readNonEmptyString(fallbackModelId);
            },
            onLlmAttemptSucceeded(activeModelId) {
              lastSuccessfulLlmModelId = readNonEmptyString(activeModelId);
            },
            onModelFallbackApplied(info) {
              modelFallbackAudit = info;
            },
            onModelFallbackRejected(info) {
              modelFallbackRejections.push(info);
            },
          },
          {
            imageInputAdmissionEvidence: ctx.imageInputAdmissionEvidence,
            additionalModelInputRequirement: ctx.toolModelInputRequirement,
            toolCallStreamingPolicies: ctx.toolCallStreamingPolicies,
          }
        );
      } catch (error) {
        await emitModelFallbackRejectionAudits(ctx, modelFallbackRejections);
        throw error;
      }
      const llmCallDurationMs = Date.now() - llmCallStartedAt;

      await emitModelFallbackRejectionAudits(ctx, modelFallbackRejections);

      if (modelFallbackAudit) {
        await emitAuditEnvelope(ctx.audit, {
          action: 'model.fallback',
          actor: { kind: 'system' },
          decision: {
            outcome: 'fallback',
            reason: modelFallbackAudit.reason,
            policy: modelFallbackAudit.policy,
            metadata: {
              fromModelId: modelFallbackAudit.fromModelId,
              toModelId: modelFallbackAudit.toModelId,
            },
          },
          evidence: [
            {
              kind: 'llm_error',
              summary: modelFallbackAudit.reason,
            },
          ],
          scope: {
            conversationId: ctx.conversationId || undefined,
            turnId: ctx.turnId,
            runId: ctx.input.toolContext?.runId ?? runIdFromTurnId(ctx.turnId),
            parentRunId: ctx.input.toolContext?.parentRunId,
            modelId: modelFallbackAudit.toModelId,
          },
        });
      }

      return {
        cloudQuotaFallbackAppliedModelId,
        modelFallbackAudit,
        llmCallStartedAt,
        llmResp,
        llmCallDurationMs,
        executorLocalPatch: lastSuccessfulLlmModelId ? { lastSuccessfulLlmModelId } : undefined,
      };
    },
  });
}

async function emitModelFallbackRejectionAudits(
  ctx: Readonly<Pick<TickPipelineContext, 'audit' | 'conversationId' | 'turnId' | 'input'>>,
  rejections: readonly ModelFallbackRejectedInfo[]
): Promise<void> {
  for (const rejection of rejections) {
    await emitAuditEnvelope(ctx.audit, {
      action: 'model.fallback',
      actor: { kind: 'system' },
      decision: {
        outcome: 'denied',
        reason: rejection.reason,
        policy: rejection.policy,
        metadata: {
          fromModelId: rejection.fromModelId,
          ...(rejection.candidateModelId ? { candidateModelId: rejection.candidateModelId } : {}),
          requiredPlacements: rejection.requiredPlacements,
        },
      },
      evidence: [
        {
          kind: 'model_input_capability',
          summary: rejection.reason,
        },
      ],
      scope: {
        conversationId: ctx.conversationId || undefined,
        turnId: ctx.turnId,
        runId: ctx.input.toolContext?.runId ?? runIdFromTurnId(ctx.turnId),
        parentRunId: ctx.input.toolContext?.parentRunId,
        modelId: rejection.candidateModelId ?? rejection.fromModelId,
      },
    });
  }
}

function processStreamEvent(
  event: AnyAgentEvent,
  outputProcessor: GraphExecutorOutputProcessor | undefined
): AnyAgentEvent | null {
  if (!outputProcessor?.processStreamChunk || event.type !== 'stream_chunk') {
    return event;
  }

  const processedContent = outputProcessor.processStreamChunk(event.content);
  if (processedContent.length === 0) {
    return null;
  }

  return {
    ...event,
    content: processedContent,
  };
}
