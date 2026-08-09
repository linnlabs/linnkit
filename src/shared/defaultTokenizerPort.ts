import type { LlmRequestMessage, TokenizerPort } from '../ports';
import { TokenCalculator } from './TokenCalculator';

export interface DefaultTokenizerPortConfig {
  /** tiktoken encoding 名，默认沿用 TokenCalculator 的 cl100k_base 近似路径。 */
  encoding?: string;
  /** 未显式配置 encoding 时，是否优先按调用传入的 modelId 选择默认 encoding，默认开启。 */
  preferModelIdWhenEncodingMissing?: boolean;
  /** tiktoken 不可用或不指定 encoding 时的字符/token 兜底比。 */
  avgCharsPerToken?: number;
  /** 单个 tool_call 的额外 token 开销估算。 */
  toolCallOverhead?: number;
}

/**
 * linnkit 默认 tokenizer。
 *
 * 中文备注：
 * - 这是 TokenCalculator 的薄包装，保持 0.7.x 默认行为；
 * - host 不注入 TokenizerPort 时，context-manager 自动使用该实现；
 * - 只用于上下文 budget 估算，不用于计费。
 */
export class DefaultTokenizerPort implements TokenizerPort {
  constructor(private readonly config: DefaultTokenizerPortConfig = {}) {}

  estimateText(text: string, modelId?: string): number {
    return TokenCalculator.estimateTokens(text, {
      encoding: this.resolveEncoding(modelId),
      avgCharsPerToken: this.config.avgCharsPerToken,
    });
  }

  estimateMessage(message: LlmRequestMessage, modelId?: string): number {
    return TokenCalculator.estimateMessageTokens(message, {
      encoding: this.resolveEncoding(modelId),
      avgCharsPerToken: this.config.avgCharsPerToken,
      toolCallOverhead: this.config.toolCallOverhead,
    });
  }

  private resolveEncoding(modelId: string | undefined): string | undefined {
    if (this.config.encoding) {
      return this.config.encoding;
    }
    if (this.config.preferModelIdWhenEncodingMissing !== false) {
      return modelId;
    }
    return undefined;
  }
}

export function createDefaultTokenizerPort(config: DefaultTokenizerPortConfig = {}): TokenizerPort {
  return new DefaultTokenizerPort(config);
}
