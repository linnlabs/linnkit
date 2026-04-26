import { describe, expect, it } from 'vitest';

import { defaultPolicyEngine } from '../defaultPolicyEngine';

describe('defaultPolicyEngine', () => {
  it('linnkit 默认 policy engine 不应内置 provider/model 适配策略', () => {
    const requestData = {
      model: 'google/gemini-3-pro-preview',
      messages: [{ role: 'user', content: 'hi' }],
    };

    const before = defaultPolicyEngine.applyBeforeRequest({
      modelId: 'google/gemini-3-pro-preview',
      apiBase: 'https://openrouter.ai/api/v1',
      requestModelName: 'google/gemini-3-pro-preview',
      endpoint: 'chat/completions',
      requestData,
      headers: {},
    });
    const errorDecision = defaultPolicyEngine.decideOnError(
      new Error('User location is not supported'),
      {
        modelId: 'google/gemini-3-pro-preview',
        apiBase: 'https://openrouter.ai/api/v1',
        requestModelName: 'google/gemini-3-pro-preview',
      },
    );

    expect(before.requestData).toBe(requestData);
    expect(before.headers).toEqual({});
    expect(errorDecision).toEqual({ action: 'none' });
  });
});
