import { describe, expect, it } from 'vitest';
import * as contextManager from '..';

describe('context-manager Batch 3 public surface', () => {
  it('exposes history-builder compatibility helpers without chat namespaces', () => {
    expect(contextManager.agentConfig.AGENT_CONSTANTS.DEFAULT_MAX_STEPS).toBeTypeOf('number');
    expect(contextManager.convertEventsToChatMessages).toBeTypeOf('function');
    expect(contextManager.chatMessageToAiMessage).toBeTypeOf('function');
    expect(contextManager).not.toHaveProperty('chatUtils');
  });
});
