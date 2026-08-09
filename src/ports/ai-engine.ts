import type { CanonicalLlmUsage } from '../contracts';
import type { LlmCallOptions, ProviderReasoningDetails, ToolCallChunk } from './ai-engine.types';
import type { ResolvedLlmInputMessage } from './llm-input-materialization';

export type AgentAiEngineStreamContent =
  | string
  | {
      content?: string;
      tool_calls?: ToolCallChunk[];
      reasoning_details?: ProviderReasoningDetails;
      canonicalUsage?: CanonicalLlmUsage;
    };

export interface AgentAiEngine {
  chatCompletion(
    modelId: string,
    messages: ResolvedLlmInputMessage[],
    options?: LlmCallOptions & { signal?: AbortSignal }
  ): Promise<unknown>;

  chatCompletionStream(
    modelId: string,
    messages: ResolvedLlmInputMessage[],
    options?: LlmCallOptions & { signal?: AbortSignal; stream_options?: { include_usage?: boolean } },
    onContent?: (content: AgentAiEngineStreamContent) => void,
    onError?: (error: Error) => void,
    onFinish?: (reason: string) => void,
    onThought?: (thought: string) => void,
    onUsage?: (usage: unknown) => void,
    onCanonicalUsage?: (usage: CanonicalLlmUsage) => void
  ): Promise<void>;
}
