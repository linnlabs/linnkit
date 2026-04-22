import { describe, expect, it } from 'vitest';
import { createToolContextFixture } from './toolContext';
import type { RuntimeEvent } from '../../contracts';

function makeEvent(id: string): RuntimeEvent {
  return {
    type: 'tool_output',
    id,
    conversation_id: 'conv_fixture',
    turn_id: 'turn_fixture',
    timestamp: Date.now(),
    version: 1,
    tool_name: 'fixture_tool',
    tool_call_id: `call_${id}`,
    status: 'success',
    output: '{}',
  };
}

describe('createToolContextFixture', () => {
  it('应优先暴露显式 working/persisted history，而不是要求测试手搓兼容 getter', () => {
    const persistedHistory = [makeEvent('persisted_1')];
    const workingHistory = [makeEvent('working_1')];

    const context = createToolContextFixture({
      conversationId: 'conv_fixture',
      turnId: 'turn_fixture',
      persistedHistoryEvents: persistedHistory,
      workingHistoryEvents: workingHistory,
    });

    expect(context.conversationView?.getPersistedHistoryEvents()).toBe(persistedHistory);
    expect(context.conversationView?.getWorkingHistoryEvents()).toBe(workingHistory);
    expect(context.getConversationHistoryEvents?.()).toBe(workingHistory);
  });
});
