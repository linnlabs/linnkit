import { Logger } from '../../../../shared/logger';
import { createContextComponentLedgerEntry } from '../../../token-accounting';
import { normalizedUsageFromCanonical } from '../../../../shared/llmTelemetryContext';
import {
  generateContextLedgerEntryId,
  toSerializableJsonRecord,
} from '../../../../contracts';
import type { GraphExecutorContextBuilder } from '../../executorContextBuilder';
import { defineTickStage } from '../types';
import type { TickPipelineContext, TickStage } from '../types';
import {
  buildHistorySummaryRuntimeEvent,
  isHistorySummaryEvent,
} from '../helpers';

const logger = new Logger('GraphAgentExecutor');

export interface BuildContextStageDependencies {
  contextBuilder: GraphExecutorContextBuilder;
}

export function createBuildContextStage(
  dependencies: BuildContextStageDependencies,
): TickStage {
  return defineTickStage({
    id: 'build_context',
    reads: [
      'request',
      'history',
      'summarizationCallbacks',
      'modelId',
      'toolDefinitionTokens',
      'llmOptions',
      'signal',
      'telemetry',
      'conversationId',
      'turnId',
      'input',
      'eventHandler',
    ],
    writes: [
      'llmMessages',
      'imageInputAdmissionEvidence',
      'outputProcessor',
      'contextTrace',
      'promptBudget',
      'promptUsageMeasurementPolicy',
      'llmOptions',
    ],
    async run(ctx) {
      const contextBuildResult = await dependencies.contextBuilder.build({
        request: ctx.request,
        history: ctx.history,
        summarizationCallbacks: ctx.summarizationCallbacks,
        modelId: ctx.modelId,
        toolDefinitionTokens: ctx.toolDefinitionTokens,
        signal: ctx.signal,
      });

      const contextTrace = toSerializableJsonRecord(contextBuildResult.contextTrace);

      if (contextBuildResult.tokenEstimate) {
        const tokenLedgerEntry = contextBuildResult.tokenLedgerEntry
          ?? createContextLedgerEntry(ctx, contextBuildResult);
        ctx.telemetry.emit({
          kind: 'context_build',
          modelId: ctx.modelId,
          tokenEstimate: contextBuildResult.tokenEstimate,
          ...(contextBuildResult.tokenComponents ? { tokenComponents: contextBuildResult.tokenComponents } : {}),
          ...(tokenLedgerEntry ? { tokenLedgerEntry } : {}),
          scope: {
            conversationId: ctx.conversationId,
            runId: ctx.input.toolContext?.runId,
            parentRunId: ctx.input.toolContext?.parentRunId,
            turnId: ctx.turnId,
          },
        });
      }

      for (const internalCall of contextBuildResult.internalLlmCalls ?? []) {
        ctx.telemetry.emit({
          kind: 'llm_call',
          modelId: internalCall.modelId,
          stream: false,
          durationMs: 0,
          usage: normalizedUsageFromCanonical(internalCall.canonicalUsage),
          canonicalUsage: internalCall.canonicalUsage,
          phase: 'context-internal',
          purpose: internalCall.purpose,
          scope: {
            conversationId: ctx.conversationId,
            runId: ctx.input.toolContext?.runId ?? ctx.turnId,
            parentRunId: ctx.input.toolContext?.parentRunId,
            turnId: ctx.turnId,
          },
        });
      }

      for (const event of contextBuildResult.summaryEvents) {
        if (!isHistorySummaryEvent(event)) {
          continue;
        }
        const runtimeEvent = buildHistorySummaryRuntimeEvent(event, ctx.conversationId, ctx.turnId);
        ctx.eventHandler?.(runtimeEvent);
        logger.info('[GraphAgentExecutor] 发出上下文构建摘要事件', {
          eventId: runtimeEvent.id,
        });
      }

      return {
        llmMessages: contextBuildResult.llmMessages,
        imageInputAdmissionEvidence: contextBuildResult.imageInputAdmissionEvidence,
        outputProcessor: contextBuildResult.outputProcessor,
        contextTrace,
        promptBudget: contextBuildResult.promptBudget,
        promptUsageMeasurementPolicy: contextBuildResult.promptUsageMeasurementPolicy,
        llmOptions: contextBuildResult.promptBudget
          ? {
              ...ctx.llmOptions,
              max_tokens: contextBuildResult.promptBudget.outputLimitTokens,
            }
          : ctx.llmOptions,
      };
    },
  });
}

function createContextLedgerEntry(
  ctx: Readonly<Pick<TickPipelineContext, 'conversationId' | 'turnId' | 'input'>>,
  contextBuildResult: Awaited<ReturnType<GraphExecutorContextBuilder['build']>>,
) {
  const keptComponents = contextBuildResult.tokenComponents?.filter((component) => component.kept !== false) ?? [];
  if (keptComponents.length === 0) {
    return undefined;
  }

  const runId = ctx.input.toolContext?.runId ?? ctx.turnId;
  const createdAt = Date.now();
  return createContextComponentLedgerEntry({
    id: generateContextLedgerEntryId(),
    conversationId: ctx.conversationId,
    runId,
    parentRunId: ctx.input.toolContext?.parentRunId,
    turnId: ctx.turnId,
    route: contextBuildResult.tokenEstimate?.route,
    createdAt,
    components: keptComponents,
  });
}
