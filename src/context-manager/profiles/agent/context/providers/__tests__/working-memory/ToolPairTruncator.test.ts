/**
 * @file src/agent/context-manager/profiles/agent/context/providers/__tests__/working-memory/ToolPairTruncator.test.ts
 * @description ToolPairTruncator 单元测试
 *
 * 运行测试:
 * npx tsx src/agent/context-manager/profiles/agent/context/providers/__tests__/working-memory/ToolPairTruncator.test.ts
 */

import { describe } from 'vitest';
describe.skip('TODO: 恢复历史测试（tsx-script 风格，未接入 vitest）', () => { /* see git history */ });

import { ToolPairTruncator } from '../../working-memory/ToolPairTruncator';
import { AGENT_CONTEXT_BUILDER_CONFIG } from '../../../config';
import type { MessageProcessingState } from '../../base';
import { collectToolInteractionGroups } from '../../../../utils/toolInteractionGroup';
import type { AiMessage } from '../../../../../../../contracts';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

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
          function: { name: toolName, arguments: JSON.stringify({ query: 'test' }) },
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

function makeGroup(messages: AiMessage[]): NonNullable<ReturnType<typeof collectToolInteractionGroups<MessageProcessingState>>[number]> {
  const states = messages.map((message, index) => makeState(message, index, estimateTokens(message)));
  const groups = collectToolInteractionGroups(states);
  if (groups.length === 0) {
    throw new Error('Expected at least one tool interaction group');
  }
  return groups[0];
}

async function runTests() {
  console.log('🧪 Starting ToolPairTruncator tests...');

  const truncator = new ToolPairTruncator(AGENT_CONTEXT_BUILDER_CONFIG);

  // Test 1: Successful truncation
  console.log('  Test 1: Successful truncation');
  {
    const longOutput = 'x'.repeat(2000); // Long output that will be truncated
    const toolCall = makeToolCallMessage('tc1', 'call_1');
    const toolOutput = makeToolOutputMessage('to1', 'call_1', longOutput);
    const group = makeGroup([toolCall, toolOutput]);

    const result = truncator.truncate(group, estimateTokens);
    assert(result.success, 'truncation should succeed');
    assert(result.tokensSaved > 0, 'should save tokens');
    assert(group.toolOutputs[0].message.content.length < longOutput.length, 'content should be shorter');
    assert(group.toolOutputs[0].message.metadata?.truncated === true, 'should mark as truncated');
  }

  // Test 2: Short output does not save tokens
  console.log('  Test 2: Short output does not save tokens');
  {
    const shortOutput = 'short output';
    const toolCall = makeToolCallMessage('tc2', 'call_2');
    const toolOutput = makeToolOutputMessage('to2', 'call_2', shortOutput);
    const group = makeGroup([toolCall, toolOutput]);

    const originalContent = group.toolOutputs[0].message.content;
    const result = truncator.truncate(group, estimateTokens);
    assert(!result.success, 'short output should not report truncation success');
    assert(result.tokensSaved === 0, 'short output should not save tokens');
    assert(group.toolOutputs[0].message.content === originalContent, 'short content should remain unchanged');
  }

  // Test 3: Truncation fails when group contains no tool outputs
  console.log('  Test 3: Truncation fails without tool outputs');
  {
    const toolCall = makeToolCallMessage('tc3', 'call_3');
    const assistantState = makeState(toolCall, 0, 100);
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
    assert(!result.success, 'truncation should fail without tool outputs');
    assert(result.tokensSaved === 0, 'should not save tokens');
  }

  // Test 4: Truncation with JSON output
  console.log('  Test 4: Truncation with JSON output');
  {
    const jsonOutput = JSON.stringify({ items: Array(100).fill({ id: 1, name: 'test' }) });
    const toolCall = makeToolCallMessage('tc5', 'call_5');
    const toolOutput = makeToolOutputMessage('to5', 'call_5', jsonOutput);
    const group = makeGroup([toolCall, toolOutput]);

    const result = truncator.truncate(group, estimateTokens);
    assert(result.success, 'truncation should succeed for JSON');
    // JSON should be summarized
    assert(group.toolOutputs[0].message.content.includes('返回了'), 'should contain summary text');
  }

  console.log('🎉 All ToolPairTruncator tests passed!');
}

// vitest 加载本文件时跳过自调用；npx tsx <file> 直跑时仍执行
if (!process.env.VITEST) {
  runTests().catch(console.error);
}
