import { describe, expect, it } from 'vitest';

import type { AiMessage } from '../../../contracts';
import { createFenceRegistry } from '../fences';
import { createMessageFormatter, formatAgentLlmMessages } from '../MessageFormatter';

const contextInjection: AiMessage = {
  id: 'ctx-1',
  role: 'user',
  type: 'context_injection',
  content: 'Memory payload',
  timestamp: 1,
  metadata: {
    fenceKind: 'memory-context',
    fenceAttrs: { source: 'memory' },
  },
};

describe('MessageFormatter fences', () => {
  it('formats context_injection messages through an injected registry', () => {
    const registry = createFenceRegistry([
      {
        kind: 'memory-context',
        llmRole: 'user',
        placement: 'before-current-user',
        lifetime: 'turn-only',
        formatter: (content, attrs) => `<memory-context source="${String(attrs.source)}">\n${content}\n</memory-context>`,
      },
    ]);
    const formatter = createMessageFormatter({ fenceRegistry: registry });

    expect(formatter.format([contextInjection], { nativeTools: true, mode: 'agent' })).toEqual([
      {
        role: 'user',
        content: '<memory-context source="memory">\nMemory payload\n</memory-context>',
      },
    ]);
  });

  it('supports registry injection through formatAgentLlmMessages', () => {
    const registry = createFenceRegistry([
      {
        kind: 'memory-context',
        llmRole: 'system',
        placement: 'after-system',
        lifetime: 'persisted',
        formatter: content => `<memory-context>\n${content}\n</memory-context>`,
      },
    ]);

    expect(formatAgentLlmMessages([contextInjection], { fenceRegistry: registry })).toEqual([
      {
        role: 'system',
        content: '<memory-context>\nMemory payload\n</memory-context>',
      },
    ]);
  });

  it('passes task request content through without host-specific task type text', () => {
    const formatter = createMessageFormatter();

    expect(formatter.format([
      {
        id: 'task-1',
        role: 'user',
        type: 'task_request',
        content: 'write this',
        timestamp: 1,
        metadata: { taskType: 'editor' },
      },
    ])).toEqual([{ role: 'user', content: 'write this' }]);
  });
});
