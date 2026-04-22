import type { AnyAgentEvent } from '../../../events/agentEvents';
import type { LlmCaller } from '../../../llm/caller';
import type { TickPipelineContext, TickStage } from '../types';
import { readNonEmptyString } from '../helpers';

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
      );
      ctx.llmCallDurationMs = Date.now() - ctx.llmCallStartedAt;
    },
  };
}
