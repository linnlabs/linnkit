/**
 * @file src/agent/context-manager/profiles/agent/context/providers/__tests__/working-memory/ToolPairMatcher.test.ts
 * @description ToolPairMatcher 单元测试
 *
 * 运行测试:
 * npx tsx src/agent/context-manager/profiles/agent/context/providers/__tests__/working-memory/ToolPairMatcher.test.ts
 */

import { describe } from 'vitest';
describe.skip('TODO: 恢复历史测试（tsx-script 风格，未接入 vitest）', () => { /* see git history */ });

import { ToolPairMatcher } from '../../working-memory/ToolPairMatcher';
import { AGENT_CONTEXT_BUILDER_CONFIG } from '../../../config';
import type { MessageProcessingState } from '../../base';
import type { AiMessage } from '../../../../../../../contracts';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function makeToolCallMessage(id: string, toolCallIds: string[]): AiMessage {
  return {
    id,
    role: 'assistant',
    type: 'tool_calls',
    content: '',
    timestamp: Date.now(),
    metadata: {
      tool_calls: toolCallIds.map((toolCallId, index) => ({
        id: toolCallId,
        type: 'function',
        function: { name: `test_tool_${index + 1}`, arguments: '{}' },
      })),
    },
  };
}

function makeToolOutputMessage(id: string, toolCallId: string): AiMessage {
  return {
    id,
    role: 'tool',
    type: 'tool_output',
    content: 'output',
    timestamp: Date.now(),
    metadata: { tool_call_id: toolCallId, tool_name: 'test_tool' },
  };
}

function makeCompressedToolHistoryMessage(id: string): AiMessage {
  return {
    id,
    role: 'assistant',
    type: 'final_answer',
    content: '压缩工具摘要',
    timestamp: Date.now(),
    metadata: { isCompressedToolHistory: true },
  };
}

function makeState(message: AiMessage, index: number, tokens = 100): MessageProcessingState {
  return {
    message,
    originalIndex: index,
    action: 'skip',
    tokens,
  };
}

async function runTests() {
  console.log('🧪 Starting ToolPairMatcher tests...');

  const matcher = new ToolPairMatcher(AGENT_CONTEXT_BUILDER_CONFIG);

  // Test 1: isCompressedToolHistoryMessage
  console.log('  Test 1: isCompressedToolHistoryMessage');
  {
    const compressed = makeCompressedToolHistoryMessage('c1');
    assert(matcher.isCompressedToolHistoryMessage(compressed), 'should identify compressed tool history');

    const normal: AiMessage = {
      id: 'n1',
      role: 'assistant',
      type: 'final_answer',
      content: 'normal',
      timestamp: Date.now(),
      metadata: {},
    };
    assert(!matcher.isCompressedToolHistoryMessage(normal), 'should not identify normal message as compressed');
  }

  // Test 2: findToolResultPair
  console.log('  Test 2: findToolResultPair');
  {
    const toolCall = makeToolCallMessage('tc1', ['call_1', 'call_2']);
    const toolOutput = makeToolOutputMessage('to1', 'call_1');
    const siblingToolOutput = makeToolOutputMessage('to2', 'call_2');
    const states = [
      makeState(toolCall, 0),
      makeState(toolOutput, 1),
      makeState(siblingToolOutput, 2),
    ];

    const group = matcher.findToolResultPair(states[1], states);
    assert(group !== null, 'should find group');
    assert(group!.messages.length === 3, 'group should contain assistant + all sibling outputs');
    assert(group!.messages[0].message.id === 'tc1', 'first element should be tool call');
    assert(group!.toolOutputs.some((state) => state.message.id === 'to1'), 'group should contain requested tool output');
    assert(group!.toolOutputs.some((state) => state.message.id === 'to2'), 'group should contain sibling tool output');
  }

  // Test 3: findToolResultPair with no match
  console.log('  Test 3: findToolResultPair with no match');
  {
    const toolOutput = makeToolOutputMessage('to1', 'call_nonexistent');
    const states = [makeState(toolOutput, 0)];

    const group = matcher.findToolResultPair(states[0], states);
    assert(group === null, 'should return null when no match found');
  }

  // Test 4: findToolCallPair
  console.log('  Test 4: findToolCallPair');
  {
    const toolCall = makeToolCallMessage('tc1', ['call_1', 'call_2']);
    const toolOutput = makeToolOutputMessage('to1', 'call_1');
    const siblingToolOutput = makeToolOutputMessage('to2', 'call_2');
    const states = [
      makeState(toolCall, 0),
      makeState(toolOutput, 1),
      makeState(siblingToolOutput, 2),
    ];

    const group = matcher.findToolCallPair(states[0], states);
    assert(group !== null, 'should find group');
    assert(group!.messages.length === 3, 'group should have 3 elements');
  }

  // Test 5: canFitToolPair - within budget
  console.log('  Test 5: canFitToolPair - within budget');
  {
    const toolCall = makeToolCallMessage('tc1', ['call_1', 'call_2']);
    const toolOutput = makeToolOutputMessage('to1', 'call_1');
    const siblingToolOutput = makeToolOutputMessage('to2', 'call_2');
    const states = [
      makeState(toolCall, 0, 100),
      makeState(toolOutput, 1, 100),
      makeState(siblingToolOutput, 2, 100),
    ];

    const group = matcher.findToolCallPair(states[0], states);
    assert(group !== null, 'group should exist');
    const result = matcher.canFitToolPair(group!, 0, 1000);
    assert(result.canFit, 'should fit within budget');
    assert(result.totalTokens === 300, 'total tokens should be 300');
  }

  // Test 6: canFitToolPair - exceeds budget
  console.log('  Test 6: canFitToolPair - exceeds budget');
  {
    const toolCall = makeToolCallMessage('tc1', ['call_1']);
    const toolOutput = makeToolOutputMessage('to1', 'call_1');
    const states = [
      makeState(toolCall, 0, 500),
      makeState(toolOutput, 1, 600),
    ];

    const group = matcher.findToolCallPair(states[0], states);
    assert(group !== null, 'group should exist');
    const result = matcher.canFitToolPair(group!, 0, 1000);
    assert(!result.canFit, 'should not fit when exceeds budget');
    assert(result.reason === 'budget_exceeded', 'reason should be budget_exceeded');
  }

  // Test 7: canFitToolPair - pair too large
  console.log('  Test 7: canFitToolPair - pair too large');
  {
    const toolCall = makeToolCallMessage('tc1', ['call_1', 'call_2']);
    const toolOutput = makeToolOutputMessage('to1', 'call_1');
    const siblingToolOutput = makeToolOutputMessage('to2', 'call_2');
    const states = [
      makeState(toolCall, 0, 3000),
      makeState(toolOutput, 1, 2000),
      makeState(siblingToolOutput, 2, 2000), // Total 7000 > MAX_TOOL_PAIR_TOKENS (6000)
    ];

    const group = matcher.findToolCallPair(states[0], states);
    assert(group !== null, 'group should exist');
    const result = matcher.canFitToolPair(group!, 0, 100000);
    assert(!result.canFit, 'should not fit when pair too large');
    assert(result.reason === 'pair_too_large', 'reason should be pair_too_large');
  }

  console.log('🎉 All ToolPairMatcher tests passed!');
}

// vitest 加载本文件时跳过自调用；npx tsx <file> 直跑时仍执行
if (!process.env.VITEST) {
  runTests().catch(console.error);
}
