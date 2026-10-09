import { describe, expect, it } from 'vitest';
import { ToolCallIdSchema, type AiMessage } from '../../../contracts';
import {
  buildToolInteractionGroupsFromMessages,
  buildToolInteractionGroupsFromStates,
} from '../toolInteractionGroup';

function callBatch(id: string, callIds: string[]): AiMessage {
  return {
    id, role: 'assistant', type: 'tool_calls', content: '', timestamp: 1,
    metadata: {
      tool_calls: callIds.map(callId => ({
        id: ToolCallIdSchema.parse(callId), type: 'function',
        function: { name: 'record_update', arguments: '{}' },
      })),
    },
  };
}

function output(id: string, callId: string, toolName = 'record_update'): AiMessage {
  return {
    id, role: 'tool', type: 'tool_output', content: `${id}: result`, timestamp: 2,
    metadata: { tool_call_id: ToolCallIdSchema.parse(callId), tool_name: toolName, data: { id } },
  };
}

function withRange(messages: AiMessage[], range: number) {
  return buildToolInteractionGroupsFromStates(messages.map((message, originalIndex) => ({
    message, originalIndex, action: 'skip', tokens: 1,
  })), { maxPairingDistance: range });
}

describe('tool batch identity and boundaries', () => {
  it('matches reordered sibling results by ID and counts only context gaps toward the range', () => {
    const ids = Array.from({ length: 12 }, (_, index) => `call-${index}`);
    const results = [...ids].reverse().map(id => output(`output-${id}`, id));
    const reminder: AiMessage = {
      id: 'reminder', role: 'system', type: 'context_injection', content: 'Continue.', timestamp: 2,
    };
    const messages = [callBatch('batch', ids), ...results.slice(0, 4), reminder, ...results.slice(4)];
    const [complete] = withRange(messages, 2);
    expect(complete.isComplete).toBe(true);
    expect(complete.toolOutputMessages).toEqual(results);
    expect(complete.items.map(item => item.toolOutputMessages[0].metadata?.tool_call_id)).toEqual(ids);
    const [incomplete] = withRange(messages, 1);
    expect(incomplete.isComplete).toBe(false);
    expect(incomplete.toolOutputMessages).toEqual(results.slice(0, 4));
  });

  it.each<AiMessage>([
    { id: 'user', role: 'user', type: 'user_input', content: 'New request.', timestamp: 2 },
    { id: 'answer', role: 'assistant', type: 'final_answer', content: 'Done.', timestamp: 2 },
    callBatch('next-batch', ['next']),
  ])('does not pair late results across $type, regardless of range', boundary => {
    const messages = [callBatch('old', ['old']), boundary, output('late', 'old')];
    expect(buildToolInteractionGroupsFromMessages(messages)[0].isComplete).toBe(false);
    expect(withRange(messages, 1000)[0].toolOutputs).toHaveLength(0);
  });

  it('ignores orphans before or within a batch without satisfying a missing call', () => {
    const groups = buildToolInteractionGroupsFromMessages([
      output('before', 'wanted'),
      callBatch('batch', ['wanted', 'missing']),
      output('orphan', 'unrelated'),
      output('matched', 'wanted'),
    ]);
    expect(groups[0].isComplete).toBe(false);
    expect(groups[0].sourceMessageIds).toEqual(['batch', 'matched']);
  });

  it('rejects duplicate declarations and results instead of replaying an ambiguous batch', () => {
    const repeatedCalls = buildToolInteractionGroupsFromMessages([
      callBatch('duplicate-calls', ['same', 'same']), output('one', 'same'),
    ]);
    const repeatedResults = buildToolInteractionGroupsFromMessages([
      callBatch('duplicate-results', ['same']), output('one', 'same'), output('two', 'same'),
    ]);
    expect(repeatedCalls[0].isComplete).toBe(false);
    expect(repeatedResults[0].isComplete).toBe(false);
    // 不隐藏重复事实，压缩层仍能看到整组来源并保护不完整边界。
    expect(repeatedResults[0].sourceMessageIds).toEqual(['duplicate-results', 'one', 'two']);
  });

  it('marks both same-turn owners incomplete when a later batch reuses a call ID', () => {
    const groups = buildToolInteractionGroupsFromMessages([
      callBatch('first', ['shared']), output('first-result', 'shared'),
      callBatch('second', ['shared']), output('second-result', 'shared'),
    ]);
    expect(groups.map(group => group.isComplete)).toEqual([false, false]);
  });

  it('does not treat a result for another tool name as a completed call', () => {
    const [group] = buildToolInteractionGroupsFromMessages([
      callBatch('batch', ['call']), output('wrong-tool', 'call', 'record_read'),
    ]);
    expect(group.isComplete).toBe(false);
    expect(group.sourceMessageIds).toEqual(['batch', 'wrong-tool']);
  });

  it('keeps the low-level AiMessage contract that identifies a result without an optional tool name', () => {
    const result: AiMessage = {
      ...output('result', 'call'),
      metadata: { tool_call_id: ToolCallIdSchema.parse('call'), data: { value: 'updated' } },
    };
    const [group] = buildToolInteractionGroupsFromMessages([callBatch('batch', ['call']), result]);
    expect(group.isComplete).toBe(true);
    expect(group.toolOutputMessages).toEqual([result]);
  });
});
