import type { AgentAiEngine } from '../../ports';
import type { LlmCallOptions, LlmRequestMessage, ToolCall } from './caller.types';
import { isRecord, toToolCalls } from './sidecar-replay';

export type LlmCallResult =
  | string
  | {
      content: string;
      tool_calls?: ToolCall[];
      reasoning_details?: unknown[];
      usage?: unknown;
    };

export async function callPlainCompletion(
  aiEngine: AgentAiEngine,
  modelId: string,
  messages: LlmRequestMessage[],
  options: LlmCallOptions = {},
  signal?: AbortSignal,
): Promise<LlmCallResult> {
  const response = await aiEngine.chatCompletion(modelId, messages, { ...options, signal });
  return normalizeCompletionResponse(response);
}

export function normalizeCompletionResponse(response: unknown): LlmCallResult {
  if (!response) {
    return String(response);
  }

  if (isRecord(response)) {
    const usage = response['usage'];
    const parsedToolCalls = toToolCalls(response['tool_calls']);
    if (parsedToolCalls) {
      const reasoningDetails = Array.isArray(response['reasoning_details'])
        ? response['reasoning_details']
        : undefined;
      return {
        content: typeof response['content'] === 'string' ? response['content'] : '',
        tool_calls: parsedToolCalls,
        reasoning_details: reasoningDetails,
        ...(usage !== undefined ? { usage } : {}),
      };
    }
  }

  if (typeof response === 'string') {
    return response;
  }

  if (typeof response === 'object') {
    if (isRecord(response) && (response['content'] !== undefined || response['reasoning_details'] !== undefined)) {
      const usage = response['usage'];
      return {
        content: typeof response['content'] === 'string' ? response['content'] : '',
        reasoning_details: Array.isArray(response['reasoning_details'])
          ? response['reasoning_details']
          : undefined,
        ...(usage !== undefined ? { usage } : {}),
      };
    }

    if (isRecord(response)) {
      const contentValue = response['content'];
      if (typeof contentValue === 'string') return contentValue;
      const textValue = response['text'];
      if (typeof textValue === 'string') return textValue;
    }

    return JSON.stringify(response);
  }

  return String(response);
}

export function getLlmResultContent(result: LlmCallResult): string {
  return typeof result === 'object' ? result.content : result;
}

export function getLlmResultToolCalls(result: LlmCallResult): ToolCall[] | undefined {
  return typeof result === 'object' ? result.tool_calls : undefined;
}
