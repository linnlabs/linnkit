import { describe, expect, it } from 'vitest';

import type { AiMessage } from '../../../../../../contracts';
import { AGENT_CONTEXT_BUILDER_CONFIG } from '../../config';
import { AgentCoreContextProvider } from '../AgentCoreContextProvider';
import type { MessageProcessingState, ProviderContext } from '../base';

function createState(message: AiMessage, originalIndex: number): MessageProcessingState {
  return {
    message,
    originalIndex,
    action: 'skip',
    tokens: 1,
  };
}

function createContext(messages: AiMessage[]): ProviderContext {
  return {
    totalBudget: 1000,
    config: AGENT_CONTEXT_BUILDER_CONFIG,
    debugMode: false,
    estimateTokens: message => Math.max(1, Math.ceil(message.content.length / 4)),
    agentRequest: {
      query: 'current',
      promptKey: 'default',
      conversationHistory: messages,
    },
  };
}

describe('AgentCoreContextProvider MustKeepPolicy', () => {
  it('uses the default policy without treating document_fragment as framework core', async () => {
    const messages: AiMessage[] = [
      { id: 'system-1', role: 'system', type: 'system_prompt', content: 'system', timestamp: 1 },
      { id: 'doc-1', role: 'user', type: 'document_fragment', content: 'legacy doc', timestamp: 2 },
      { id: 'user-1', role: 'user', type: 'user_input', content: 'current', timestamp: 3 },
    ];
    const states = messages.map(createState);
    const provider = new AgentCoreContextProvider();

    const result = await provider.provide(states, 1000, createContext(messages));

    expect(result.states.find(state => state.message.id === 'system-1')?.action).toBe('keep_core');
    expect(result.states.find(state => state.message.id === 'doc-1')?.action).toBe('skip');
    expect(result.states.find(state => state.message.id === 'user-1')?.action).toBe('keep_core');
  });

  it('keeps configured legacy document messages through an injected policy', async () => {
    const messages: AiMessage[] = [
      { id: 'doc-1', role: 'user', type: 'document_fragment', content: 'legacy doc', timestamp: 1 },
      {
        id: 'ctx-1',
        role: 'user',
        type: 'context_injection',
        content: 'memory',
        timestamp: 2,
        metadata: { fenceKind: 'memory-context' },
      },
      { id: 'user-1', role: 'user', type: 'user_input', content: 'current', timestamp: 3 },
    ];
    const provider = new AgentCoreContextProvider({
      mustKeepPolicy: {
        alwaysKeepTypes: ['system_prompt', 'user_input', 'document_fragment'],
        alwaysKeepFenceKinds: ['memory-context'],
        truncationRules: [],
      },
    });

    const result = await provider.provide(messages.map(createState), 1000, createContext(messages));

    expect(result.states.find(state => state.message.id === 'doc-1')?.action).toBe('keep_core');
    expect(result.states.find(state => state.message.id === 'ctx-1')?.action).toBe('keep_core');
  });
});
