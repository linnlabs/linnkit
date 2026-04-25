import { get_encoding, Tiktoken } from 'tiktoken';
import type { LlmRequestMessage } from '../ports';

export class TokenCalculator {
  private static readonly BYTES_PER_TOKEN_LATIN = 4;
  private static readonly BYTES_PER_TOKEN_CJK = 3;
  private static readonly OVERHEAD_PER_MESSAGE = 5;
  private static readonly OVERHEAD_PER_TOOL_CALL = 10;
  private static encoderCache = new Map<TokenEncodingName, Tiktoken>();
  private static readonly DEFAULT_ENCODING: TokenEncodingName = 'cl100k_base';

  private static resolveEncodingFromModelIdentifier(modelIdentifier: string): TokenEncodingName {
    const normalized = (modelIdentifier || '').trim().toLowerCase();

    if (normalized.includes('deepseek')) {
      return 'cl100k_base';
    }

    if (normalized.includes('gpt-4o') || normalized.startsWith('o1')) {
      return 'o200k_base';
    }

    if (normalized.includes('gemini') || normalized.includes('claude')) {
      return 'cl100k_base';
    }

    return this.DEFAULT_ENCODING;
  }

  private static getEncoder(modelIdentifier: string): Tiktoken {
    const encodingName = this.resolveEncodingFromModelIdentifier(modelIdentifier);
    const cached = this.encoderCache.get(encodingName);
    if (cached) {
      return cached;
    }

    const encoder = get_encoding(encodingName);
    this.encoderCache.set(encodingName, encoder);
    return encoder;
  }

  public static estimateTokensRough(text: string | null | undefined, _modelIdentifier?: string): number {
    if (!text) return 0;

    const hasCJK = /[\u4e00-\u9fa5]|[\u3040-\u30ff]|[\uac00-\ud7af]/.test(text);
    const ratio = hasCJK ? this.BYTES_PER_TOKEN_CJK : this.BYTES_PER_TOKEN_LATIN;
    const byteLength = new TextEncoder().encode(text).length;

    return Math.ceil(byteLength / ratio);
  }

  public static estimateTokensPrecise(text: string | null | undefined, modelIdentifier: string): number {
    if (!text) return 0;
    const encoder = this.getEncoder(modelIdentifier);
    return encoder.encode(text).length;
  }

  public static estimateMessageTokensPrecise(message: LlmRequestMessage, modelIdentifier: string): number {
    let totalTokens = this.OVERHEAD_PER_MESSAGE;

    if (message.content) {
      totalTokens += this.estimateTokensPrecise(String(message.content), modelIdentifier);
    }

    const toolCalls = this.extractToolCallsForTokenEstimate(message);
    for (const toolCall of toolCalls) {
      totalTokens += this.OVERHEAD_PER_TOOL_CALL;
      const fn = toolCall['function'];
      if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
        const fnRecord = fn as Record<string, unknown>;
        totalTokens += this.estimateTokensPrecise(String(fnRecord['name'] ?? ''), modelIdentifier);
        totalTokens += this.estimateTokensPrecise(String(fnRecord['arguments'] ?? ''), modelIdentifier);
      }
    }

    const toolCallId = this.extractToolCallIdForTokenEstimate(message);
    if (toolCallId) {
      totalTokens += this.estimateTokensPrecise(toolCallId, modelIdentifier);
    }

    return totalTokens;
  }

  public static estimateMessagesTokensPrecise(messages: LlmRequestMessage[], modelIdentifier: string): number {
    return messages.reduce((total, msg) => total + this.estimateMessageTokensPrecise(msg, modelIdentifier), 0);
  }

  private static extractToolCallsForTokenEstimate(message: LlmRequestMessage): unknown[] {
    const direct = 'tool_calls' in message ? message.tool_calls : undefined;
    if (Array.isArray(direct)) return direct;

    const metadata = 'metadata' in message ? message.metadata : undefined;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return [];
    const metadataRecord = metadata as Record<string, unknown>;
    const metadataToolCalls = metadataRecord['tool_calls'];
    return Array.isArray(metadataToolCalls) ? metadataToolCalls : [];
  }

  private static extractToolCallIdForTokenEstimate(message: LlmRequestMessage): string | undefined {
    if ('tool_call_id' in message && typeof message.tool_call_id === 'string') {
      return message.tool_call_id;
    }

    const metadata = 'metadata' in message ? message.metadata : undefined;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
    const metadataRecord = metadata as Record<string, unknown>;
    const toolCallId = metadataRecord['tool_call_id'];
    return typeof toolCallId === 'string' ? toolCallId : undefined;
  }

  public static truncateTextByTokens(
    text: string,
    maxTokens: number,
    modelIdentifier: string,
    strategy: 'start' | 'end' | 'middle' = 'end',
  ): string {
    if (!text || maxTokens <= 0) return '';

    const encoder = this.getEncoder(modelIdentifier);
    const tokens = encoder.encode(text);

    if (tokens.length <= maxTokens) {
      return text;
    }

    let truncatedTokens: Uint32Array;
    const ellipsis = '...';

    switch (strategy) {
      case 'start':
        truncatedTokens = tokens.slice(0, maxTokens);
        return encoder.decode(truncatedTokens) + ellipsis;
      case 'end':
        truncatedTokens = tokens.slice(tokens.length - maxTokens);
        return ellipsis + encoder.decode(truncatedTokens);
      case 'middle': {
        const half = Math.floor(maxTokens / 2);
        const head = tokens.slice(0, half);
        const tail = tokens.slice(tokens.length - (maxTokens - half));
        return encoder.decode(head) + ellipsis + encoder.decode(tail);
      }
      default:
        truncatedTokens = tokens.slice(0, maxTokens);
        return encoder.decode(truncatedTokens) + ellipsis;
    }
  }

  public static cleanup(): void {
    for (const encoder of this.encoderCache.values()) {
      encoder.free();
    }
    this.encoderCache.clear();
  }
}

type TokenEncodingName = Parameters<typeof get_encoding>[0];
