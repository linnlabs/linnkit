import { describe, expect, it } from 'vitest';
import {
  normalizeCanonicalLlmUsage,
  normalizeLlmUsage,
  normalizedUsageFromCanonical,
} from '../llmTelemetryContext';

describe('llmTelemetryContext usage normalization', () => {
  it('maps OpenAI-compatible response usage to canonical actual usage', () => {
    const rawUsage = {
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
    };

    expect(normalizeCanonicalLlmUsage(rawUsage)).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      totalTokens: 17,
      source: 'provider-response-usage',
      confidence: 'actual',
      rawUsage,
    });
    expect(normalizeLlmUsage(rawUsage)).toEqual({
      promptTokens: 12,
      completionTokens: 5,
      totalTokens: 17,
      canonicalUsage: {
        inputTokens: 12,
        outputTokens: 5,
        totalTokens: 17,
        source: 'provider-response-usage',
        confidence: 'actual',
        rawUsage,
      },
    });
  });

  it('splits OpenAI-compatible cached input tokens out of prompt tokens', () => {
    const rawUsage = {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
      prompt_tokens_details: {
        cached_tokens: 40,
      },
      completion_tokens_details: {
        reasoning_tokens: 10,
      },
    };

    expect(normalizeCanonicalLlmUsage(rawUsage)).toEqual({
      inputTokens: 80,
      outputTokens: 30,
      reasoningTokens: 10,
      cacheReadTokens: 40,
      totalTokens: 150,
      source: 'provider-response-usage',
      confidence: 'actual',
      rawUsage,
    });
  });

  it('does not normalize impossible OpenAI-compatible cache details', () => {
    expect(normalizeCanonicalLlmUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: {
        cached_tokens: 11,
      },
    })).toBeUndefined();
  });

  it('does not fabricate input/output when raw usage only reports total tokens', () => {
    expect(normalizeCanonicalLlmUsage({ tokens: 100 })).toBeUndefined();
    expect(normalizeLlmUsage({ tokens: 100 })).toBeUndefined();
  });

  it('keeps optional canonical fields unknown when provider did not report them', () => {
    const normalized = normalizedUsageFromCanonical({
      inputTokens: 3,
      outputTokens: 2,
      source: 'test-fixture',
      confidence: 'actual',
    });

    expect(normalized).toEqual({
      promptTokens: 3,
      completionTokens: 2,
      totalTokens: 5,
      canonicalUsage: {
        inputTokens: 3,
        outputTokens: 2,
        source: 'test-fixture',
        confidence: 'actual',
      },
    });
  });
});
