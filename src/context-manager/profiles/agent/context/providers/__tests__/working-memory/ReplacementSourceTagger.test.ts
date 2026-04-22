/**
 * @file src/agent/context-manager/profiles/agent/context/providers/__tests__/working-memory/ReplacementSourceTagger.test.ts
 * @description ReplacementSourceTagger 单元测试
 *
 * 运行测试:
 * npx tsx src/agent/context-manager/profiles/agent/context/providers/__tests__/working-memory/ReplacementSourceTagger.test.ts
 */

import { describe } from 'vitest';
describe.skip('TODO: 恢复历史测试（tsx-script 风格，未接入 vitest）', () => { /* see git history */ });

import { ReplacementSourceTagger } from '../../working-memory/ReplacementSourceTagger';
import type { MessageProcessingState } from '../../base';
import type { AiMessage } from '../../../../../../../contracts';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function makeMessage(id: string, role: string, type: string): AiMessage {
  return {
    id,
    role: role as 'user' | 'assistant' | 'system' | 'tool',
    type,
    content: 'content',
    timestamp: Date.now(),
    metadata: {},
  };
}

function makeState(message: AiMessage, index: number): MessageProcessingState {
  return {
    message,
    originalIndex: index,
    action: 'skip',
    tokens: 100,
  };
}

async function runTests() {
  console.log('🧪 Starting ReplacementSourceTagger tests...');

  const tagger = new ReplacementSourceTagger();

  // Test 1: addReplacementSources
  console.log('  Test 1: addReplacementSources');
  {
    const state = makeState(makeMessage('m1', 'assistant', 'final_answer'), 0);
    tagger.addReplacementSources(state, ['id1', 'id2']);
    assert(state.replacementSourceIds?.includes('id1'), 'should include id1');
    assert(state.replacementSourceIds?.includes('id2'), 'should include id2');
    assert(state.replacementSourceIds?.length === 2, 'should have 2 ids');
  }

  // Test 2: addReplacementSources with deduplication
  console.log('  Test 2: addReplacementSources with deduplication');
  {
    const state = makeState(makeMessage('m2', 'assistant', 'final_answer'), 0);
    state.replacementSourceIds = ['id1'];
    tagger.addReplacementSources(state, ['id1', 'id2']);
    assert(state.replacementSourceIds?.length === 2, 'should deduplicate ids');
  }

  // Test 3: findAdjacentState - forward
  console.log('  Test 3: findAdjacentState - forward');
  {
    const states = [
      makeState(makeMessage('m1', 'user', 'user_input'), 0),
      makeState(makeMessage('m2', 'assistant', 'tool_calls'), 1),
      makeState(makeMessage('m3', 'tool', 'tool_output'), 2),
      makeState(makeMessage('m4', 'assistant', 'final_answer'), 3),
    ];
    const stateMap = new Map(states.map(s => [s.originalIndex, s]));

    const found = tagger.findAdjacentState(stateMap, 2, 1, s => s.message.type === 'final_answer');
    assert(found !== null, 'should find adjacent state');
    assert(found!.message.id === 'm4', 'should find final_answer');
  }

  // Test 4: findAdjacentState - backward
  console.log('  Test 4: findAdjacentState - backward');
  {
    const states = [
      makeState(makeMessage('m1', 'user', 'user_input'), 0),
      makeState(makeMessage('m2', 'assistant', 'tool_calls'), 1),
      makeState(makeMessage('m3', 'tool', 'tool_output'), 2),
    ];
    const stateMap = new Map(states.map(s => [s.originalIndex, s]));

    const found = tagger.findAdjacentState(stateMap, 2, -1, s => s.message.type === 'user_input');
    assert(found !== null, 'should find adjacent state');
    assert(found!.message.id === 'm1', 'should find user_input');
  }

  // Test 5: findAdjacentState - not found
  console.log('  Test 5: findAdjacentState - not found');
  {
    const states = [
      makeState(makeMessage('m1', 'assistant', 'tool_calls'), 0),
      makeState(makeMessage('m2', 'tool', 'tool_output'), 1),
    ];
    const stateMap = new Map(states.map(s => [s.originalIndex, s]));

    const found = tagger.findAdjacentState(stateMap, 0, -1, s => s.message.type === 'user_input');
    assert(found === null, 'should not find non-existent state');
  }

  // Test 6: tagReplacementSources
  console.log('  Test 6: tagReplacementSources');
  {
    const states = [
      makeState(makeMessage('user1', 'user', 'user_input'), 0),
      makeState(makeMessage('tc1', 'assistant', 'tool_calls'), 1),
      makeState(makeMessage('to1', 'tool', 'tool_output'), 2),
      makeState(makeMessage('fa1', 'assistant', 'final_answer'), 3),
    ];

    const pair = [states[1], states[2]];
    tagger.tagReplacementSources(pair, states);

    // Check that pair members have replacement source ids
    assert(states[1].replacementSourceIds?.includes('tc1'), 'tool_calls should have its own id');
    assert(states[1].replacementSourceIds?.includes('to1'), 'tool_calls should have tool_output id');
    assert(states[2].replacementSourceIds?.includes('tc1'), 'tool_output should have tool_calls id');
    assert(states[2].replacementSourceIds?.includes('to1'), 'tool_output should have its own id');

    // 相邻 user_input / final_answer 不再扩散标记
    assert(states[0].replacementSourceIds === undefined, 'user_input should not be tagged');
    assert(states[3].replacementSourceIds === undefined, 'final_answer should not be tagged');
  }

  // Test 7: tagReplacementSources with empty pair
  console.log('  Test 7: tagReplacementSources with empty pair');
  {
    const states = [makeState(makeMessage('m1', 'user', 'user_input'), 0)];
    const pair: MessageProcessingState[] = [];

    // Should not throw
    tagger.tagReplacementSources(pair, states);
    assert(states[0].replacementSourceIds === undefined, 'should not tag when pair is empty');
  }

  console.log('🎉 All ReplacementSourceTagger tests passed!');
}

// vitest 加载本文件时跳过自调用；npx tsx <file> 直跑时仍执行
if (!process.env.VITEST) {
  runTests().catch(console.error);
}
