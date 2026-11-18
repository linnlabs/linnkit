import {
  LlmCaller,
  type LlmCallOptions,
  type ModelCatalogEntry,
  type ModelCatalogLike,
} from '../../runtime-kernel';
import type {
  CanonicalInferenceEvent,
  CanonicalInferenceFinishReason,
  CanonicalInferencePort,
  CanonicalInferenceRequest,
  LlmInputMaterializerPort,
  ProviderContinuation,
} from '../../ports';
import type { CanonicalLlmUsage } from '../../contracts';
import { toSerializableJsonRecord } from '../../contracts';

type ScriptedLlmCaller = LlmCaller;

export interface ScriptedLlmCall {
  readonly request: CanonicalInferenceRequest;
  readonly modelId: string;
  readonly messages: CanonicalInferenceRequest['messages'];
  readonly options: LlmCallOptions;
}

export interface ScriptedToolCall {
  /** 省略时按调用序号生成 `call_<调用序号>_<位置>`，同一脚本内不会重复。 */
  id?: string;
  name: string;
  /** 二选一：`arguments` 直接给对象；`argumentsJson` 用于测试非法或特殊 JSON。都省略时为 `{}`。 */
  arguments?: Record<string, unknown>;
  argumentsJson?: string;
  index?: number;
  continuations?: ProviderContinuation[];
}

export interface ScriptedLlmTurn {
  thoughtDeltas?: string[];
  contentChunks?: string[];
  toolCalls?: ScriptedToolCall[];
  textContinuations?: ProviderContinuation[];
  reasoningContinuations?: ProviderContinuation[];
  canonicalUsage?: CanonicalLlmUsage;
  finishReason?: CanonicalInferenceFinishReason;
  failure?: {
    kind: 'aborted' | 'transport' | 'provider' | 'protocol';
    code: string;
    retryable: boolean;
  };
  throwAfterEvents?: string | Error;
  /**
   * 在这次调用开始流式输出前执行，可以是异步。
   *
   * 用来断言请求内容，也用来在“第 N 次模型调用进行中”这一刻触发动作（插话、暂停、取消），
   * 或等待测试放行（返回一个由测试控制的 Promise）。
   */
  assertCall?: (call: ScriptedLlmCall) => void | Promise<void>;
}

/**
 * 脚本：按顺序消费的回合表，或按请求即时决定回合的函数。
 *
 * 函数形式适合“看到某条工具结果再决定下一步”“随机组合”这类不能提前写死顺序的场景。
 */
export type ScriptedInferenceScript =
  | readonly ScriptedLlmTurn[]
  | ((call: ScriptedLlmCall, callIndex: number) => ScriptedLlmTurn | Promise<ScriptedLlmTurn>);

export interface ScriptedInferenceHarness {
  getCalls(): ScriptedLlmCall[];
  getConsumedTurnCount(): number;
  getLlmCaller(): ScriptedLlmCaller;
  /** 直接拿推理端口，交给 Host 自己的 LlmCaller / 推理适配装配。 */
  getInferencePort(): CanonicalInferencePort;
  /** 回合表形式时检查是否全部消费；函数形式没有“剩余回合”，总是通过。 */
  assertAllTurnsConsumed(): void;
}

export interface ScriptedInferenceHarnessOptions {
  modelCatalog?: ModelCatalogLike;
  llmInputMaterializer?: LlmInputMaterializerPort;
}

function toError(input: string | Error): Error {
  return typeof input === 'string' ? new Error(input) : input;
}

function callOptions(request: CanonicalInferenceRequest): LlmCallOptions {
  return {
    tools: [...request.tools],
    tool_choice: request.tool_choice,
    ...(request.sampling.temperature !== undefined
      ? { temperature: request.sampling.temperature }
      : {}),
    ...(request.sampling.top_p !== undefined ? { top_p: request.sampling.top_p } : {}),
    ...(request.sampling.max_output_tokens !== undefined
      ? { max_tokens: request.sampling.max_output_tokens }
      : {}),
    ...(request.sampling.reasoning_effort !== undefined
      ? {
          reasoning_effort:
            request.sampling.reasoning_effort === 'none'
              ? 'off' as const
              : request.sampling.reasoning_effort,
        }
      : {}),
  };
}

function createScriptedModelCatalog(): ModelCatalogLike {
  const entry = (id: string): ModelCatalogEntry => ({
    id,
    enabled: true,
    capabilities: ['chat'],
    adapter_input_support: { user_image: false, tool_result_image: false },
  });
  return {
    getModelById: entry,
    getModelsByCapability: () => [],
    getModelsByUIVisibility: () => [],
  };
}

function argumentsJsonOf(toolCall: ScriptedToolCall): string {
  if (toolCall.argumentsJson !== undefined) return toolCall.argumentsJson;
  return JSON.stringify(toolCall.arguments ?? {});
}

function parseArguments(toolCall: ScriptedToolCall) {
  const parsed: unknown = JSON.parse(argumentsJsonOf(toolCall));
  const record = toSerializableJsonRecord(parsed);
  if (!record) {
    throw new Error(`[scriptedInferenceHarness] ${toolCall.name} arguments 必须是 JSON object。`);
  }
  return record;
}

export function createScriptedInferenceHarness(
  script: ScriptedInferenceScript,
  options: ScriptedInferenceHarnessOptions = {},
): ScriptedInferenceHarness {
  const streamTurns = typeof script === 'function' ? undefined : [...script];
  const respond = typeof script === 'function' ? script : undefined;
  const calls: ScriptedLlmCall[] = [];

  const inferencePort: CanonicalInferencePort = {
    async *stream(request): AsyncIterable<CanonicalInferenceEvent> {
      const call: ScriptedLlmCall = {
        request,
        modelId: request.model_id,
        messages: request.messages,
        options: callOptions(request),
      };
      const callIndex = calls.length;
      const turn = respond ? await respond(call, callIndex) : streamTurns?.shift();
      if (!turn) {
        throw new Error('[scriptedInferenceHarness] 没有可消费的 scripted turn，请补齐脚本。');
      }
      calls.push(call);
      await turn.assertCall?.(call);

      yield { type: 'start', model_id: request.model_id, attempt_id: request.invocation.attempt_id };
      if (turn.failure) {
        yield { type: 'failure', ...turn.failure };
        return;
      }
      let nextAssistantPartIndex = 0;
      for (const thought of turn.thoughtDeltas ?? []) {
        yield { type: 'thought_delta', text: thought };
      }
      if (turn.thoughtDeltas?.length) {
        yield {
          type: 'assistant_part_end',
          index: nextAssistantPartIndex++,
          part: {
            type: 'reasoning',
            text: turn.thoughtDeltas.join(''),
            ...(turn.reasoningContinuations?.length
              ? { continuation: turn.reasoningContinuations }
              : {}),
          },
        };
      }
      for (const chunk of turn.contentChunks ?? []) {
        yield { type: 'answer_delta', text: chunk };
      }
      if (turn.contentChunks?.length) {
        yield {
          type: 'assistant_part_end',
          index: nextAssistantPartIndex++,
          part: {
            type: 'text',
            text: turn.contentChunks.join(''),
            ...(turn.textContinuations?.length
              ? { continuation: turn.textContinuations }
              : {}),
          },
        };
      }
      for (const [position, toolCall] of (turn.toolCalls ?? []).entries()) {
        const index = toolCall.index ?? position;
        const id = toolCall.id ?? `call_${callIndex + 1}_${position + 1}`;
        yield {
          type: 'tool_call_start',
          index,
          part_index: nextAssistantPartIndex++,
          id,
          name: toolCall.name,
        };
        yield {
          type: 'tool_argument_delta',
          index,
          json_delta: argumentsJsonOf(toolCall),
        };
        yield {
          type: 'tool_call_end',
          index,
          call: {
            id,
            name: toolCall.name,
            arguments: parseArguments(toolCall),
            ...(toolCall.continuations?.length
              ? { continuation: toolCall.continuations }
              : {}),
          },
        };
      }
      if (turn.canonicalUsage) {
        yield { type: 'usage', usage: turn.canonicalUsage };
      }
      if (request.signal?.aborted) {
        yield { type: 'failure', kind: 'aborted', code: 'request_aborted', retryable: false };
        return;
      }
      if (turn.throwAfterEvents) throw toError(turn.throwAfterEvents);
      yield { type: 'finish', reason: turn.finishReason ?? 'stop' };
    },
  };

  const llmCaller = new LlmCaller({
    inferencePort,
    modelCatalog: options.modelCatalog ?? createScriptedModelCatalog(),
    llmInputMaterializer: options.llmInputMaterializer,
  });

  return {
    getCalls: () => [...calls],
    getConsumedTurnCount: () => calls.length,
    getLlmCaller: () => llmCaller,
    getInferencePort: () => inferencePort,
    assertAllTurnsConsumed(): void {
      if (streamTurns && streamTurns.length > 0) {
        throw new Error(
          `[scriptedInferenceHarness] 仍有 ${streamTurns.length} 个 scripted turn 未被消费，请检查图执行是否提前结束。`
        );
      }
    },
  };
}
