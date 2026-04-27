import { describe, expect, it } from 'vitest';

import type { FenceInjection } from '../../shared/fences';
import type { AgentProfileRequest } from '../contracts';

describe('AgentProfileRequest contract', () => {
  it('accepts host-provided fence injections while keeping legacy fields during migration', () => {
    const fences: FenceInjection[] = [
      {
        kind: 'memory-context',
        content: 'remember this',
        attrs: { memoryId: 'mem-1' },
      },
    ];
    const request: AgentProfileRequest = {
      query: 'hello',
      promptKey: 'default',
      fences,
      document_fragment: 'legacy document fragment',
      context_before: 'legacy before',
      context_after: 'legacy after',
      user_quote: { text: 'quoted text' },
    };

    expect(request.fences).toBe(fences);
    expect(request.document_fragment).toBe('legacy document fragment');
  });
});
