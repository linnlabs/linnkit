import { describe, expect, it } from 'vitest';
import * as contextManager from '..';

describe('context-manager Batch 3 public surface', () => {
  it('exposes history-builder compatibility helpers through namespaces', () => {
    expect(contextManager.agentConfig.AGENT_CONSTANTS.DEFAULT_MAX_STEPS).toBeTypeOf('number');
    expect(contextManager.chatUtils.convertEventsToChatMessages).toBeTypeOf('function');
    expect(contextManager.chatUtils.chatMessageToAiMessage).toBeTypeOf('function');
  });
});
