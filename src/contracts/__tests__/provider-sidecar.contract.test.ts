import { describe, expect, it } from 'vitest';

import { validateAiMessage } from '../messages';

describe('provider replay sidecar contracts', () => {
  it('AiMessage metadata should preserve opaque reasoning_details and provider tool_call extra_content', () => {
    const reasoningDetails = [
      { provider: 'deepseek', type: 'reasoning_content', reasoning_content: 'Need the tool.' },
    ];

    const parsed = validateAiMessage({
      id: 'msg_tool_calls_1',
      role: 'assistant',
      type: 'tool_calls',
      content: '',
      timestamp: 1,
      metadata: {
        reasoning_details: reasoningDetails,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'workspace_read', arguments: '{}' },
            extra_content: {
              google: { thought_signature: '<sig>', other_opaque: 'kept' },
              deepseek: { replay_marker: 'opaque' },
            },
          },
        ],
      },
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }
    expect(parsed.data.metadata?.reasoning_details).toEqual(reasoningDetails);
    expect(parsed.data.metadata?.tool_calls?.[0]?.extra_content).toEqual({
      google: { thought_signature: '<sig>', other_opaque: 'kept' },
      deepseek: { replay_marker: 'opaque' },
    });
  });
});
