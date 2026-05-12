import { describe, expect, it } from 'vitest';
import { TokenCalculator } from '../TokenCalculator';
import type { AiMessage } from '../../contracts';

function makeToolCallMessage(): AiMessage {
  return {
    id: 'assistant_tool_calls',
    role: 'assistant',
    type: 'tool_calls',
    content: '',
    timestamp: 1,
    metadata: {
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'search',
            arguments: '{"query":"linnkit"}',
          },
        },
      ],
    },
  };
}

describe('TokenCalculator configurable estimation', () => {
  it('uses avgCharsPerToken as the fallback estimator when no encoding is provided', () => {
    expect(TokenCalculator.estimateTokens('123456789', { avgCharsPerToken: 3 })).toBe(3);
  });

  it('uses configurable toolCallOverhead when estimating tool call messages', () => {
    const message = makeToolCallMessage();

    const lowOverhead = TokenCalculator.estimateMessageTokens(message, {
      avgCharsPerToken: 2,
      toolCallOverhead: 10,
    });
    const highOverhead = TokenCalculator.estimateMessageTokens(message, {
      avgCharsPerToken: 2,
      toolCallOverhead: 70,
    });

    expect(highOverhead - lowOverhead).toBe(60);
  });

  it('accepts an explicit encoding name without treating it as a model id', () => {
    const tokens = TokenCalculator.estimateTokens('hello world', {
      encoding: 'o200k_base',
      avgCharsPerToken: 2,
    });

    expect(tokens).toBeGreaterThan(0);
  });
});
