import { Logger } from '../../../../shared/logger';
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
