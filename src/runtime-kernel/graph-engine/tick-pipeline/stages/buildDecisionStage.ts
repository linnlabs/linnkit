import { generateMessageId } from '../../../../shared/ids';
import type {
  FinalAnswerEvent,
  ToolCallDecisionEvent,
} from '../../../events/agentEvents';
import type { ToolPresentationPort } from '../../../tools/ports';
import type { TickPipelineContext, TickStage } from '../types';
import {
  extractResponseText,
  normalizeToolCalls,
  parsePrimaryToolArgs,
  resolveReasoningDetails,
  resolveToolCalls,
} from '../helpers';

export interface BuildDecisionStageDependencies {
  toolPresentation: Pick<ToolPresentationPort, 'getDisplayOptions'>;
}

export function createBuildDecisionStage(
  dependencies: BuildDecisionStageDependencies,
): TickStage {
  return {
    id: 'build_decision',
    async run(ctx: TickPipelineContext): Promise<void> {
      const respText = extractResponseText(ctx.llmResp);
      const toolCallsRaw = resolveToolCalls(ctx.llmResp);
      const reasoningDetailsRaw = resolveReasoningDetails(ctx.llmResp);
      const toolCalls = ctx.forceFinalAnswer ? undefined : toolCallsRaw;

      if (toolCalls?.length) {
        const normalizedToolCalls = normalizeToolCalls(toolCalls);
        const firstToolCall = normalizedToolCalls[0];
        const primaryArgs = parsePrimaryToolArgs(firstToolCall);
        const primaryToolName = firstToolCall?.function?.name ?? 'unknown';
        const primaryToolCallId = firstToolCall?.id ?? '';

        const actionEvent: ToolCallDecisionEvent = {
          type: 'tool_call_decision',
          timestamp: Date.now(),
          tool_name: primaryToolName,
          tool_args: primaryArgs,
          tool_calls: normalizedToolCalls,
          tool_call_id: primaryToolCallId,
          status: 'loading',
          payload: {
            args: primaryArgs,
            tool_calls: normalizedToolCalls,
            ...(Array.isArray(reasoningDetailsRaw) && reasoningDetailsRaw.length > 0
              ? { reasoning_details: reasoningDetailsRaw }
              : {}),
          },
          meta: {
            displayOptions: dependencies.toolPresentation.getDisplayOptions(primaryToolName),
            primary_tool_call_id: primaryToolCallId,
            tool_call_ids: normalizedToolCalls.map((toolCall) => toolCall.id),
            tool_batch_size: normalizedToolCalls.length,
          },
          id: generateMessageId(),
        };

        ctx.eventHandler?.(actionEvent);
        ctx.decision = {
          kind: 'tool_calls',
          toolCalls: normalizedToolCalls,
        };
        return;
      }

      if (!ctx.input.stream) {
        const answerId = generateMessageId();
        const finalAnswerSidecar = Array.isArray(reasoningDetailsRaw) && reasoningDetailsRaw.length > 0
          ? { reasoning_details: reasoningDetailsRaw }
          : {};
        const finalEvent: FinalAnswerEvent = {
          type: 'final_answer',
          timestamp: Date.now(),
          answer: respText,
          id: generateMessageId(),
          ...finalAnswerSidecar,
        };
        ctx.eventHandler?.(finalEvent);
        ctx.newEvents.push({
          type: 'final_answer',
          id: finalEvent.id!,
          conversation_id: ctx.conversationId,
          turn_id: ctx.turnId,
          timestamp: finalEvent.timestamp,
          version: 1,
          answer_id: answerId,
          content: respText,
          is_complete: true,
          ...finalAnswerSidecar,
        });
        ctx.decision = { kind: 'final_answer', answer: respText };
        return;
      }

      ctx.decision = { kind: 'yield' };
    },
  };
}
