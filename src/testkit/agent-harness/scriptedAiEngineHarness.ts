import { vi } from 'vitest';
import { runtimeKernel } from '../..';

type LlmCaller = runtimeKernel.llm.LlmCaller;
type LlmCallOptions = runtimeKernel.llm.LlmCallOptions;
type ToolCallChunk = runtimeKernel.llm.ToolCallChunk;

const { AI_ENGINE_MOCK } = vi.hoisted(() => ({
  AI_ENGINE_MOCK: {
    chatCompletion: vi.fn(),
    chatCompletionStream: vi.fn(),
  },
}));

vi.mock('src/infra/adapters/llm/adapter-factory', () => ({
  createAdapter: vi.fn(() => ({
    chatCompletion: vi.fn(),
    chatCompletionStream: vi.fn(),
  })),
}));

vi.mock('src/agent/shared/TokenCalculator', () => ({
  TokenCalculator: {
    estimateTokens: vi.fn(() => 0),
    estimateMessagesTokens: vi.fn(() => 0),
  },
}));

export interface ScriptedLlmCall {
  modelId: string;
  messages: unknown[];
  options: LlmCallOptions & { signal?: AbortSignal; stream_options?: { include_usage?: boolean } };
}

export interface ScriptedToolCall {
  id: string;
  name: string;
  argumentsJson: string;
  index?: number;
}

export interface ScriptedLlmTurn {
  thoughtDeltas?: string[];
  contentChunks?: string[];
  toolCalls?: ScriptedToolCall[];
  reasoningDetails?: unknown[];
  usage?: unknown;
  finishReason?: string;
  error?: string | Error;
  throwAfterCallbacks?: string | Error;
  assertCall?: (call: ScriptedLlmCall) => void;
}

export interface ScriptedAiEngineHarness {
  getCalls(): ScriptedLlmCall[];
  getConsumedTurnCount(): number;
  getLlmCaller(): LlmCaller;
  assertAllTurnsConsumed(): void;
  restore(): void;
}

export interface ScriptedAiEngineHarnessOptions {
  /**
   * 迁移期兼容开关：历史上可把 scripted engine patch 到模块级 `aiEngine`。
   *
   * 中文备注：
   * - `src/agent/testkit/*` 现在不再依赖 `src/core/aiEngine`；
   * - 新旧测试都应显式注入 `getLlmCaller()`；
   * - 若仍传入 `true`，直接抛错，避免 package boundary 悄悄回退。
   */
  patchModuleAiEngine?: boolean;
}

function toError(input: string | Error): Error {
  return typeof input === 'string' ? new Error(input) : input;
}

function buildToolCallChunks(toolCalls: ScriptedToolCall[]): ToolCallChunk[] {
  return toolCalls.map((toolCall, index) => ({
    index: typeof toolCall.index === 'number' ? toolCall.index : index,
    id: toolCall.id,
    function: {
      name: toolCall.name,
      arguments: toolCall.argumentsJson,
    },
  }));
}

type ScriptedAiEngineCallbacks = {
  onContent?: (content: string | { content?: string; tool_calls?: ToolCallChunk[]; reasoning_details?: unknown[] }) => void;
  onError?: (error: Error) => void;
  onFinish?: (reason: string) => void;
  onThought?: (thought: string) => void;
  onUsage?: (usage: unknown) => void;
};

export function createScriptedAiEngineHarness(
  turns: ScriptedLlmTurn[],
  options: ScriptedAiEngineHarnessOptions = {},
): ScriptedAiEngineHarness {
  const streamTurns = [...turns];
  const calls: ScriptedLlmCall[] = [];

  const consumeStreamTurn = async (
    modelId: string,
    messages: unknown[],
    options: LlmCallOptions & { signal?: AbortSignal; stream_options?: { include_usage?: boolean } },
    callbacks: ScriptedAiEngineCallbacks,
  ): Promise<void> => {
    const turn = streamTurns.shift();
    if (!turn) {
      throw new Error('[scriptedAiEngineHarness] 没有可消费的 scripted turn，请补齐脚本。');
    }

    const call: ScriptedLlmCall = {
      modelId,
      messages: [...messages],
      options,
    };
    calls.push(call);
    turn.assertCall?.(call);

    if (turn.error) {
      callbacks.onError?.(toError(turn.error));
      return;
    }

    for (const thought of turn.thoughtDeltas ?? []) {
      callbacks.onThought?.(thought);
    }

    for (const chunk of turn.contentChunks ?? []) {
      callbacks.onContent?.(chunk);
    }

    if (Array.isArray(turn.toolCalls) && turn.toolCalls.length > 0) {
      callbacks.onContent?.({
        tool_calls: buildToolCallChunks(turn.toolCalls),
        ...(Array.isArray(turn.reasoningDetails) && turn.reasoningDetails.length > 0
          ? { reasoning_details: turn.reasoningDetails }
          : {}),
      });
    } else if (Array.isArray(turn.reasoningDetails) && turn.reasoningDetails.length > 0) {
      callbacks.onContent?.({
        reasoning_details: turn.reasoningDetails,
      });
    }

    if (turn.usage !== undefined) {
      callbacks.onUsage?.(turn.usage);
    }

    if (turn.throwAfterCallbacks) {
      throw toError(turn.throwAfterCallbacks);
    }

    callbacks.onFinish?.(turn.finishReason ?? 'done');
  };

  const scriptedAiEngine = {
    async chatCompletion(): Promise<never> {
      throw new Error('[scriptedAiEngineHarness] 当前测试未配置非流式 chatCompletion。');
    },
    async chatCompletionStream(
      modelId: string,
      messages: unknown[],
      options: LlmCallOptions & { signal?: AbortSignal; stream_options?: { include_usage?: boolean } },
      onContent?: (content: string | { content?: string; tool_calls?: ToolCallChunk[]; reasoning_details?: unknown[] }) => void,
      onError?: (error: Error) => void,
      onFinish?: (reason: string) => void,
      onThought?: (thought: string) => void,
      onUsage?: (usage: unknown) => void
    ): Promise<void> {
      return consumeStreamTurn(modelId, messages, options, {
        onContent,
        onError,
        onFinish,
        onThought,
        onUsage,
      });
    },
  };
  const llmCaller = new runtimeKernel.llm.LlmCaller({ aiEngine: scriptedAiEngine });
  if (options.patchModuleAiEngine === true) {
    throw new Error(
      '[scriptedAiEngineHarness] patchModuleAiEngine 已退役；请改为显式使用 getLlmCaller() 注入 LlmCaller。'
    );
  }

  return {
    getCalls(): ScriptedLlmCall[] {
      return [...calls];
    },
    getConsumedTurnCount(): number {
      return calls.length;
    },
    getLlmCaller(): LlmCaller {
      return llmCaller;
    },
    assertAllTurnsConsumed(): void {
      if (streamTurns.length > 0) {
        throw new Error(
          `[scriptedAiEngineHarness] 仍有 ${streamTurns.length} 个 scripted turn 未被消费，请检查图执行是否提前结束。`
        );
      }
    },
    restore(): void {
      AI_ENGINE_MOCK.chatCompletion.mockReset();
      AI_ENGINE_MOCK.chatCompletionStream.mockReset();
    },
  };
}
