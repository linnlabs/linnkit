import {
  generateAnswerSegmentId,
  generateRuntimeEventId,
  ToolCallIdSchema,
} from '../../../../contracts';
import type { FinalAnswerEvent, ToolCallDecisionEvent } from '../../../events/agentEvents';
import { defineTickStage } from '../types';
import type { TickStage } from '../types';
import {
  extractResponseText,
  normalizeToolCalls,
  parsePrimaryToolArgs,
  resolveReasoningDetails,
  resolveToolCalls,
} from '../helpers';
import { toSerializableJsonValue } from '../../../../contracts';

export function createBuildDecisionStage(): TickStage {
  return defineTickStage({
    id: 'build_decision',
    reads: ['llmResp', 'outputProcessor', 'forceFinalAnswer', 'eventHandler'],
    writes: ['decision'],
    async run(ctx) {
      const rawRespText = extractResponseText(ctx.llmResp);
      const respText = ctx.outputProcessor?.processResponse
        ? ctx.outputProcessor.processResponse(rawRespText)
        : rawRespText;
      const toolCallsRaw = resolveToolCalls(ctx.llmResp);
      const reasoningDetailsRaw = resolveReasoningDetails(ctx.llmResp);
      const reasoningDetails = Array.isArray(reasoningDetailsRaw)
        ? reasoningDetailsRaw
            .map(item => toSerializableJsonValue(item))
            .filter((item): item is NonNullable<typeof item> => item !== undefined)
        : undefined;
      const toolCalls = ctx.forceFinalAnswer ? undefined : toolCallsRaw;

      if (toolCalls?.length) {
        const normalizedToolCalls = normalizeToolCalls(toolCalls).map((toolCall, index) => ({
          ...toolCall,
          id: ToolCallIdSchema.parse(toolCall.id, {
            path: [`tool_calls[${index}].id`],
          }),
        }));
        const firstToolCall = normalizedToolCalls[0];
        if (!firstToolCall) {
          throw new Error('Tool decision must contain at least one normalized tool call.');
        }
        normalizedToolCalls.forEach((toolCall, index) => {
          requireNonEmptyToolIdentity(toolCall.function.name, `tool_calls[${index}].function.name`);
        });
        const primaryArgs = parsePrimaryToolArgs(firstToolCall);
        const primaryToolName = firstToolCall.function.name.trim();
        const primaryToolCallId = firstToolCall.id;

        const actionEvent: ToolCallDecisionEvent = {
          type: 'tool_call_decision',
          timestamp: Date.now(),
          tool_name: primaryToolName,
          tool_args: primaryArgs,
          tool_calls: normalizedToolCalls,
          tool_call_id: primaryToolCallId,
          phase: 'start',
          status: 'loading',
          payload: {
            args: primaryArgs,
            tool_calls: normalizedToolCalls,
            ...(reasoningDetails && reasoningDetails.length > 0
              ? { reasoning_details: reasoningDetails }
              : {}),
          },
          meta: {
            primary_tool_call_id: primaryToolCallId,
            tool_call_ids: normalizedToolCalls.map(toolCall => toolCall.id),
            tool_batch_size: normalizedToolCalls.length,
          },
          id: generateRuntimeEventId(),
        };

        ctx.eventHandler?.(actionEvent);
        return {
          decision: {
            kind: 'tool_calls',
            toolCalls: normalizedToolCalls,
          },
        };
      }

      if (respText.trim().length > 0) {
        const answerId = generateAnswerSegmentId();
        const finalAnswerSidecar =
          reasoningDetails && reasoningDetails.length > 0
            ? { reasoning_details: reasoningDetails }
            : {};
        const finalEvent: FinalAnswerEvent = {
          type: 'final_answer',
          timestamp: Date.now(),
          answer: respText,
          answer_id: answerId,
          completion_reason: 'terminal',
          id: answerId,
          ...finalAnswerSidecar,
        };
        ctx.eventHandler?.(finalEvent);
        return {
          decision: { kind: 'final_answer', answer: respText },
        };
      }

      return {
        decision: { kind: 'yield' },
      };
    },
  });
}

function requireNonEmptyToolIdentity(value: unknown, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
}
