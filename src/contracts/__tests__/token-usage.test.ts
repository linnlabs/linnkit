import { describe, expect, it } from 'vitest';

import { InternalLlmCallUsage } from '../token-usage';

describe('token usage contracts', () => {
  it('validates context-internal LLM usage sidecar data', () => {
    const parsed = InternalLlmCallUsage.safeParse({
      purpose: 'summarization',
      modelId: 'summary-model',
      canonicalUsage: {
        inputTokens: 120,
        outputTokens: 18,
        totalTokens: 138,
        source: 'provider-response-usage',
        confidence: 'actual',
      },
    });

    expect(parsed.success).toBe(true);
  });

  it('requires explicit purpose and model id for internal LLM usage', () => {
    const parsed = InternalLlmCallUsage.safeParse({
      purpose: '',
      modelId: '',
      canonicalUsage: {
        inputTokens: 120,
        outputTokens: 18,
        source: 'provider-response-usage',
        confidence: 'actual',
      },
    });

    expect(parsed.success).toBe(false);
  });
});
