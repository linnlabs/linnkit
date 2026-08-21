import {
  jsonSchema,
  tool,
  type AssistantContent,
  type ModelMessage,
  type ToolChoice,
  type ToolSet,
  type UserContent,
} from 'ai';
import type { SharedV4ProviderOptions as ProviderOptions } from '@ai-sdk/provider';
import type {
  CanonicalInferenceMessage,
  CanonicalInferenceRequest,
} from '@linnlabs/linnkit/ports';
import type { ProviderContinuation, SerializableJsonValue } from '@linnlabs/linnkit/contracts';
import { AI_SDK_INFERENCE_CAPABILITY_IDS } from '../definitions/aiSdkCapabilityIds';
import type { AiSdkInferenceRoute } from '../definitions/aiSdkInferenceSurface';

type JsonRecord = Record<string, SerializableJsonValue>;
const CHATGPT_CODEX_ROUTE_PROFILE_ID = 'chatgpt_codex_responses';

function continuationMatchesRoute(
  continuation: ProviderContinuation,
  route: AiSdkInferenceRoute
): boolean {
  const producer = continuation.producer;
  return (
    producer.model_id === route.model_id &&
    producer.endpoint_id === route.endpoint_id &&
    producer.api_surface === route.surface &&
    producer.capability_id === route.capability_id &&
    producer.endpoint_model_id === route.endpoint_model_id
  );
}

function requireContinuationPayload(
  continuation: ProviderContinuation,
  route: AiSdkInferenceRoute
): JsonRecord {
  if (!continuationMatchesRoute(continuation, route)) {
    throw new Error('[AiSdkInference] Provider continuation 与当前 route 不一致。');
  }
  const payload = continuation.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('[AiSdkInference] Provider continuation payload 必须是对象。');
  }
  return payload;
}

function readString(record: JsonRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readArray(record: JsonRecord, key: string): SerializableJsonValue[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? [...value] : undefined;
}

function readTarget(
  continuation: ProviderContinuation,
  route: AiSdkInferenceRoute
): { payload: JsonRecord; target: string } {
  const payload = requireContinuationPayload(continuation, route);
  const target = readString(payload, 'target');
  if (!target) throw new Error('[AiSdkInference] Provider continuation 缺少 target。');
  return { payload, target };
}

function providerOptionsFromContinuation(
  continuation: ProviderContinuation,
  route: AiSdkInferenceRoute
): ProviderOptions {
  const payload = requireContinuationPayload(continuation, route);
  switch (continuation.kind) {
    case 'ai-sdk:anthropic-reasoning': {
      const signature = readString(payload, 'signature');
      const redactedData = readString(payload, 'redacted_data');
      return { anthropic: { ...(signature ? { signature } : {}), ...(redactedData ? { redactedData } : {}) } };
    }
    case 'ai-sdk:google-part': {
      const thoughtSignature = readString(payload, 'thought_signature');
      if (!thoughtSignature) throw new Error('[AiSdkInference] Google continuation 缺少 thought_signature。');
      return { google: { thoughtSignature } };
    }
    case 'ai-sdk:openai-responses-part': {
      const itemId = readString(payload, 'item_id');
      if (!itemId) throw new Error('[AiSdkInference] OpenAI Responses continuation 缺少 item_id。');
      const reasoningEncryptedContent = readString(payload, 'reasoning_encrypted_content');
      return {
        openai: {
          itemId,
          ...(reasoningEncryptedContent ? { reasoningEncryptedContent } : {}),
        },
      };
    }
    case 'ai-sdk:xai-responses-part': {
      const itemId = readString(payload, 'item_id');
      if (!itemId) throw new Error('[AiSdkInference] xAI Responses continuation 缺少 item_id。');
      const reasoningEncryptedContent = readString(payload, 'reasoning_encrypted_content');
      return {
        xai: {
          itemId,
          ...(reasoningEncryptedContent ? { reasoningEncryptedContent } : {}),
        },
      };
    }
    case 'ai-sdk:openrouter-reasoning': {
      const reasoningDetails = readArray(payload, 'reasoning_details');
      if (!reasoningDetails || reasoningDetails.length === 0) {
        throw new Error('[AiSdkInference] OpenRouter continuation 缺少 reasoning_details。');
      }
      return { openrouter: { reasoning_details: reasoningDetails } };
    }
    default:
      throw new Error(`[AiSdkInference] 不支持的 Provider continuation kind: ${continuation.kind}`);
  }
}

function mergeProviderOptions(options: readonly ProviderOptions[]): ProviderOptions | undefined {
  if (options.length === 0) return undefined;
  const merged: ProviderOptions = {};
  for (const option of options) {
    for (const [provider, value] of Object.entries(option)) {
      merged[provider] = { ...(merged[provider] ?? {}), ...value };
    }
  }
  return merged;
}

function projectUserContent(message: Extract<CanonicalInferenceMessage, { role: 'user' }>): UserContent {
  return message.content.map(block =>
    block.type === 'text'
      ? { type: 'text', text: block.text }
      : {
          type: 'file',
          data: { type: 'data', data: block.bytes },
          mediaType: block.media_type,
        }
  );
}

function indexToolCalls(messages: readonly CanonicalInferenceMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const part of message.parts) {
      if (part.type !== 'tool_call') continue;
      const call = part.call;
      if (names.has(call.id)) {
        throw new Error(`[AiSdkInference] 对话包含重复 tool_call_id: ${call.id}`);
      }
      names.set(call.id, call.name);
    }
  }
  return names;
}

function projectAssistantContent(
  message: Extract<CanonicalInferenceMessage, { role: 'assistant' }>,
  route: AiSdkInferenceRoute
): AssistantContent {
  return message.parts.map(part => {
    if (part.type === 'tool_call') {
      for (const value of part.call.continuation ?? []) {
        const { payload, target } = readTarget(value, route);
        if (target !== 'tool_call') {
          throw new Error('[AiSdkInference] Provider continuation target 与 assistant tool part 不一致。');
        }
        if (readString(payload, 'tool_call_id') !== part.call.id) {
          throw new Error('[AiSdkInference] Provider continuation tool_call_id 与 assistant tool part 不一致。');
        }
      }
      const providerOptions = mergeProviderOptions(
        (part.call.continuation ?? []).map(value => providerOptionsFromContinuation(value, route))
      );
      return {
        type: 'tool-call',
        toolCallId: part.call.id,
        toolName: part.call.name,
        input: part.call.arguments,
        ...(providerOptions ? { providerOptions } : {}),
      };
    }
    const continuations = part.continuation ?? [];
    for (const value of continuations) {
      const { target } = readTarget(value, route);
      if (target !== part.type) {
        throw new Error('[AiSdkInference] Provider continuation target 与 assistant part 不一致。');
      }
    }
    const providerOptions = mergeProviderOptions(
      continuations.map(value => providerOptionsFromContinuation(value, route))
    );
    return {
      type: part.type,
      text: part.text,
      ...(providerOptions ? { providerOptions } : {}),
    };
  });
}

function projectToolContent(
  message: Extract<CanonicalInferenceMessage, { role: 'tool' }>,
  toolNames: ReadonlyMap<string, string>
) {
  const toolName = toolNames.get(message.tool_call_id);
  if (!toolName) {
    throw new Error(
      `[AiSdkInference] tool result 找不到已完成的 assistant tool call: ${message.tool_call_id}`
    );
  }
  const files = message.content.filter(block => block.type === 'image');
  const text = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
  return [{
    type: 'tool-result' as const,
    toolCallId: message.tool_call_id,
    toolName,
    output: files.length === 0
      ? { type: 'text' as const, value: text }
      : {
          type: 'content' as const,
          value: [
            ...(text ? [{ type: 'text' as const, text }] : []),
            ...files.map(file => ({
              type: 'file' as const,
              data: { type: 'data' as const, data: file.bytes },
              mediaType: file.media_type,
            })),
          ],
        },
  }];
}

export function projectCanonicalMessages(
  messages: readonly CanonicalInferenceMessage[],
  route: AiSdkInferenceRoute
): ModelMessage[] {
  const toolNames = indexToolCalls(messages);
  return messages.map(message => {
    switch (message.role) {
      case 'system':
        return { role: 'system', content: message.content };
      case 'user':
        return { role: 'user', content: projectUserContent(message) };
      case 'assistant':
        return { role: 'assistant', content: projectAssistantContent(message, route) };
      case 'tool':
        return { role: 'tool', content: projectToolContent(message, toolNames) };
    }
  });
}

export interface AiSdkToolConfiguration {
  readonly tools?: ToolSet;
  readonly toolChoice?: ToolChoice<ToolSet>;
}

/**
 * Linnkit 已经拥有 durable history，Responses 请求必须使用无状态回放。
 *
 * AI SDK/OpenAI 默认 `store=true`，会把带 item ID 的历史压成 `item_reference`。这要求下一跳
 * 持有 OpenAI 服务端会话状态，普通 Responses-compatible 网关无法保证该语义。显式关闭服务端
 * 存储后，官方 package 会使用 canonical history 中保存的完整 item 与 encrypted reasoning 重建请求。
 */
export function projectAiSdkRequestProviderOptions(
  request: CanonicalInferenceRequest,
  route: AiSdkInferenceRoute
): ProviderOptions | undefined {
  if (route.surface !== 'openai_responses') return undefined;
  switch (route.capability_id) {
    case AI_SDK_INFERENCE_CAPABILITY_IDS.OPENAI_RESPONSES: {
      if (route.request_profile === CHATGPT_CODEX_ROUTE_PROFILE_ID) {
        const instructions = request.messages
          .filter(message => message.role === 'system')
          .map(message => message.content)
          .join('\n\n');
        return {
          openai: {
            store: false,
            ...(instructions ? { instructions } : {}),
            systemMessageMode: 'remove',
            strictJsonSchema: false,
            parallelToolCalls: true,
            textVerbosity: 'low',
            ...(request.sampling.reasoning_effort !== undefined &&
              request.sampling.reasoning_effort !== 'none'
              ? { reasoningSummary: 'auto' }
              : {}),
          },
        };
      }
      return { openai: { store: false } };
    }
    case AI_SDK_INFERENCE_CAPABILITY_IDS.XAI_RESPONSES:
      return { xai: { store: false } };
    default:
      throw new Error(
        `[AiSdkInference] ${route.capability_id} 不是已准入的 Responses request capability。`
      );
  }
}

/**
 * ChatGPT Codex 账号后端不是普通 OpenAI API 产品。Host 仍用 Linnkit 输出预算做 admission，
 * 但按 Codex 客户端合同省略 wire max_output_tokens。
 */
export function projectAiSdkGenerationSettings(
  request: CanonicalInferenceRequest,
  route: AiSdkInferenceRoute
): {
  readonly maxOutputTokens?: number;
  readonly reasoning?: CanonicalInferenceRequest['sampling']['reasoning_effort'];
} {
  const isChatGptCodex = route.request_profile === CHATGPT_CODEX_ROUTE_PROFILE_ID;
  return {
    ...(!isChatGptCodex && request.sampling.max_output_tokens !== undefined
      ? { maxOutputTokens: request.sampling.max_output_tokens }
      : {}),
    ...(request.sampling.reasoning_effort !== undefined &&
      (!isChatGptCodex || request.sampling.reasoning_effort !== 'none')
      ? { reasoning: request.sampling.reasoning_effort }
      : {}),
  };
}

/**
 * AI SDK 不接受“空工具集 + auto”组合，因此没有候选工具时省略整个工具配置。
 * 有候选工具时也省略 canonical auto，让具体 Provider package 决定自己的默认 wire；
 * `none`、`required` 和指定工具仍显式投影。
 */
export function projectCanonicalToolConfiguration(
  request: CanonicalInferenceRequest
): AiSdkToolConfiguration {
  if (request.tools.length === 0) return {};

  const tools = Object.fromEntries(
    request.tools.map(definition => [
      definition.name,
      tool({
        description: definition.description,
        inputSchema: jsonSchema(definition.parameters),
      }),
    ])
  );
  if (request.tool_choice === 'auto') {
    // auto 是 canonical 默认语义。省略字段让每个 Provider package 使用自己的默认值，
    // 避免把 OpenAI 风格的显式 tool_choice=auto 强加给不接受该 wire 的厂商。
    return { tools };
  }
  const toolChoice: ToolChoice<ToolSet> = typeof request.tool_choice === 'object'
    ? { type: 'tool', toolName: request.tool_choice.name }
    : request.tool_choice;
  return { tools, toolChoice };
}
