import { describe, expect, it } from 'vitest';
import type { LlmRequestMessage } from '../../../ports';
import { TokenCalculator } from '../../../shared/TokenCalculator';
import { createDefaultTokenizerPort } from '../defaultTokenizerPort';

describe('DefaultTokenizerPort', () => {
  it('matches TokenCalculator message estimation', () => {
    const message: LlmRequestMessage = {
      role: 'assistant',
      content: 'hello',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"q":"hello"}' },
        },
      ],
    };
    const config = {
      avgCharsPerToken: 2,
      toolCallOverhead: 17,
      preferModelIdWhenEncodingMissing: false,
    };

    const tokenizer = createDefaultTokenizerPort(config);

    expect(tokenizer.estimateMessage(message, 'gpt-4o-mini')).toBe(
      TokenCalculator.estimateMessageTokens(message, config),
    );
  });

  it('uses modelId for default encoding selection when no encoding is configured', () => {
    const tokenizer = createDefaultTokenizerPort({
      avgCharsPerToken: 2,
    });

    expect(tokenizer.estimateText('hello world', 'gpt-4o-mini')).toBe(
      TokenCalculator.estimateTokens('hello world', {
        encoding: 'gpt-4o-mini',
        avgCharsPerToken: 2,
      }),
    );
  });

  it('keeps explicit encoding ahead of modelId', () => {
    const tokenizer = createDefaultTokenizerPort({
      encoding: 'cl100k_base',
      avgCharsPerToken: 2,
    });

    expect(tokenizer.estimateText('hello world', 'gpt-4o-mini')).toBe(
      TokenCalculator.estimateTokens('hello world', {
        encoding: 'cl100k_base',
        avgCharsPerToken: 2,
      }),
    );
  });
});
