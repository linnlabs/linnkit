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
    };

    const tokenizer = createDefaultTokenizerPort(config);

    expect(tokenizer.estimateMessage(message, 'ignored')).toBe(
      TokenCalculator.estimateMessageTokens(message, config),
    );
  });
});
