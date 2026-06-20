import { Logger } from '../../../../shared/logger';
import { createContextComponentLedgerEntry } from '../../../token-accounting';
import type { GraphExecutorContextBuilder } from '../../executorContextBuilder';
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
  return {
    id: 'build_context',
    async run(ctx: TickPipelineContext): Promise<void> {
      const contextBuildResult = await dependencies.contextBuilder.build({
        request: ctx.request,
        history: ctx.history,
        summarizationCallbacks: ctx.summarizationCallbacks,
        modelId: ctx.modelId,
        signal: ctx.signal,
      });

      ctx.mode = contextBuildResult.mode;
      ctx.llmMessages = contextBuildResult.llmMessages;
      ctx.contextTrace = contextBuildResult.contextTrace;

      if (contextBuildResult.tokenEstimate) {
        const tokenLedgerEntry = contextBuildResult.tokenLedgerEntry
          ?? createContextLedgerEntry(ctx, contextBuildResult);
        ctx.telemetry.emit({
          kind: 'context_build',
          modelId: ctx.modelId,
          mode: contextBuildResult.mode,
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

      for (const event of contextBuildResult.summaryEvents) {
        if (!isHistorySummaryEvent(event)) {
          continue;
        }
        const runtimeEvent = buildHistorySummaryRuntimeEvent(event, ctx.conversationId, ctx.turnId);
        ctx.eventHandler?.(runtimeEvent);
        logger.info('[GraphAgentExecutor] 发出上下文构建摘要事件', {
          mode: ctx.mode,
          eventId: runtimeEvent.id,
        });
      }
    },
  };
}

function createContextLedgerEntry(
  ctx: TickPipelineContext,
  contextBuildResult: Awaited<ReturnType<GraphExecutorContextBuilder['build']>>,
) {
  const keptComponents = contextBuildResult.tokenComponents?.filter((component) => component.kept !== false) ?? [];
  if (keptComponents.length === 0) {
    return undefined;
  }

  const runId = ctx.input.toolContext?.runId ?? ctx.turnId;
  const createdAt = Date.now();
  return createContextComponentLedgerEntry({
    id: `context_${runId}_${ctx.turnId}_${createdAt}`,
    conversationId: ctx.conversationId,
    runId,
    parentRunId: ctx.input.toolContext?.parentRunId,
    turnId: ctx.turnId,
    route: contextBuildResult.tokenEstimate?.route,
    createdAt,
    components: keptComponents,
  });
}
