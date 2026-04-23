import { describe, expect, it } from 'vitest';

import type { AiMessage } from '../../../../../../../contracts';
import { AGENT_CONTEXT_BUILDER_CONFIG } from '../../../config';
import type { MessageProcessingState } from '../../base';
import { ToolPairTruncator } from '../../working-memory/ToolPairTruncator';
import { collectToolInteractionGroups } from '../../../../utils/toolInteractionGroup';

function makeToolCallMessage(id: string, toolCallId: string, toolName = 'test_tool'): AiMessage {
  return {
    id,
    role: 'assistant',
    type: 'tool_calls',
    content: '',
    timestamp: Date.now(),
    metadata: {
      tool_calls: [
        {
          id: toolCallId,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify({ query: 'test' }),
          },
        },
      ],
    },
  };
}

function makeToolOutputMessage(id: string, toolCallId: string, content: string): AiMessage {
  return {
    id,
    role: 'tool',
    type: 'tool_output',
    content,
    timestamp: Date.now(),
    metadata: { tool_call_id: toolCallId, tool_name: 'test_tool' },
  };
}

function makeState(message: AiMessage, index: number, tokens: number): MessageProcessingState {
  return {
    message,
    originalIndex: index,
    action: 'skip',
    tokens,
  };
}

function estimateTokens(message: AiMessage): number {
  return Math.ceil(message.content.length / 4);
}

function makeGroup(messages: AiMessage[]) {
  const states = messages.map((message, index) =>
    makeState(message, index, estimateTokens(message)),
  );
  const groups = collectToolInteractionGroups(states);
  if (groups.length === 0) {
    throw new Error('Expected at least one tool interaction group');
  }
  return groups[0];
}

describe('ToolPairTruncator', () => {
  it('truncates long tool output and marks it as truncated', () => {
    const truncator = new ToolPairTruncator(AGENT_CONTEXT_BUILDER_CONFIG);
    const longOutput = 'x'.repeat(2000);
    const group = makeGroup([
      makeToolCallMessage('tc1', 'call_1'),
      makeToolOutputMessage('to1', 'call_1', longOutput),
    ]);

    const result = truncator.truncate(group, estimateTokens);

    expect(result.success).toBe(true);
    expect(result.tokensSaved).toBeGreaterThan(0);
    expect(group.toolOutputs[0].message.content.length).toBeLessThan(longOutput.length);
    expect(group.toolOutputs[0].message.metadata).toEqual(
      expect.objectContaining({
        truncated: true,
        originalLength: longOutput.length,
      }),
    );
  });

  it('does not report truncation success when output is already short', () => {
    const truncator = new ToolPairTruncator(AGENT_CONTEXT_BUILDER_CONFIG);
    const shortOutput = 'short output';
    const group = makeGroup([
      makeToolCallMessage('tc2', 'call_2'),
      makeToolOutputMessage('to2', 'call_2', shortOutput),
    ]);

    const originalContent = group.toolOutputs[0].message.content;
    const result = truncator.truncate(group, estimateTokens);

    expect(result.success).toBe(false);
    expect(result.tokensSaved).toBe(0);
    expect(group.toolOutputs[0].message.content).toBe(originalContent);
  });

  it('fails cleanly when a group has no tool outputs', () => {
    const truncator = new ToolPairTruncator(AGENT_CONTEXT_BUILDER_CONFIG);
    const assistantState = makeState(makeToolCallMessage('tc3', 'call_3'), 0, 100);
    const group = {
      anchorId: assistantState.message.id,
      assistantState,
      assistantMessage: assistantState.message,
      assistantIndex: 0,
      toolOutputs: [],
      toolOutputMessages: [],
      toolOutputIndexes: [],
      toolCallIds: ['call_3'],
      toolNames: ['test_tool'],
      sourceMessageIds: [assistantState.message.id],
      messageIndexes: [0],
      startIndex: 0,
      endIndex: 0,
      isCheckpointGroup: false,
      isComplete: false,
      isCompressed: false,
      items: [],
      messages: [assistantState],
    };

    const result = truncator.truncate(group, estimateTokens);

    expect(result).toEqual({ success: false, tokensSaved: 0 });
  });

  it('summarizes large JSON outputs into natural language previews', () => {
    const truncator = new ToolPairTruncator(AGENT_CONTEXT_BUILDER_CONFIG);
    const jsonOutput = JSON.stringify({ items: Array(100).fill({ id: 1, name: 'test' }) });
    const group = makeGroup([
      makeToolCallMessage('tc5', 'call_5'),
      makeToolOutputMessage('to5', 'call_5', jsonOutput),
    ]);

    const result = truncator.truncate(group, estimateTokens);

    expect(result.success).toBe(true);
    expect(group.toolOutputs[0].message.content).toContain('返回了');
  });
});
