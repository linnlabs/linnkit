import { describe, expect, it } from 'vitest';

import { ContextUsageSnapshot, InternalLlmCallUsage } from '../token-usage';

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

  it('严格校验最终 Prompt 三项归因与剩余预算等式', () => {
    const snapshot = {
      basis: 'last_completed_llm_prompt' as const,
      budget_model_id: 'primary-model',
      used_tokens: 900,
      components: {
        system_prompt_tokens: 200,
        conversation_tokens: 600,
        tool_definition_tokens: 100,
      },
      component_attribution: 'normalized_local_estimate' as const,
      input_budget_tokens: 1_000,
      remaining_tokens: 100,
      output_limit_tokens: 200,
      source: 'local-estimate' as const,
      confidence: 'estimate' as const,
      measured_at: 1_234,
    };

    expect(ContextUsageSnapshot.safeParse(snapshot).success).toBe(true);
    expect(ContextUsageSnapshot.safeParse({
      ...snapshot,
      components: { ...snapshot.components, conversation_tokens: 599 },
    }).success).toBe(false);
    expect(ContextUsageSnapshot.safeParse({
      ...snapshot,
      remaining_tokens: 99,
    }).success).toBe(false);
    expect(ContextUsageSnapshot.safeParse({
      ...snapshot,
      used_tokens: Number.MAX_SAFE_INTEGER + 1,
    }).success).toBe(false);
  });
});
