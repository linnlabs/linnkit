import type { LlmCallOptions, ToolCallChunk } from './ai-engine.types';
import type { AiMessage } from '../contracts';

export type AgentAiEngineStreamContent =
  | string
  | {
      content?: string;
      tool_calls?: ToolCallChunk[];
      reasoning_details?: unknown[];
    };

export interface AgentAiEngine {
  chatCompletion(
    modelId: string,
    messages: AiMessage[],
    options?: LlmCallOptions & { signal?: AbortSignal }
  ): Promise<unknown>;

  chatCompletionStream(
    modelId: string,
    messages: AiMessage[],
    options?: LlmCallOptions & { signal?: AbortSignal; stream_options?: { include_usage?: boolean } },
    onContent?: (content: AgentAiEngineStreamContent) => void,
    onError?: (error: Error) => void,
    onFinish?: (reason: string) => void,
    onThought?: (thought: string) => void,
    onUsage?: (usage: unknown) => void
  ): Promise<void>;
}
