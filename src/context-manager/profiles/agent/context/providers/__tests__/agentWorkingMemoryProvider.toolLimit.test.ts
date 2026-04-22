/**
 * @file src/agent/context-manager/profiles/agent/context/providers/__tests__/agentWorkingMemoryProvider.toolLimit.test.ts
 * @description AgentWorkingMemoryProvider 工具交互组上限测试
 *
 * 运行测试:
 * npx tsx src/agent/context-manager/profiles/agent/context/providers/__tests__/agentWorkingMemoryProvider.toolLimit.test.ts
 *
 * 验证点：
 * - P1 只保留最近 2 对原始 tool_calls/tool_output
 * - P3 会把“压缩后的工具历史摘要消息”（assistant + metadata.isCompressedToolHistory）当作工具交互组处理
 * - 工作记忆层工具交互组总数最多 10，超过的保持 skip（等价于丢弃）
 */

import { describe } from 'vitest';
describe.skip('TODO: 恢复历史测试（tsx-script 风格，未接入 vitest）', () => { /* see git history */ });

import { AgentWorkingMemoryProvider } from '../AgentWorkingMemoryProvider';
import { AGENT_CONTEXT_BUILDER_CONFIG } from '../../config';
import type { MessageProcessingState, ProviderContext } from '../base';
import type { AiMessage } from '../../../../../../contracts';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function makeToolPair(i: number): { toolCalls: AiMessage; toolOutput: AiMessage } {
  const toolCallId = `tc_${i}`;
  const toolCalls: AiMessage = {
    id: `a_tc_${i}`,
    role: 'assistant',
    type: 'tool_calls',
    content: '',
    timestamp: 1000 + i * 10,
    metadata: {
      tool_calls: [
        {
          id: toolCallId,
          type: 'function',
          function: { name: 'workspace_read', arguments: JSON.stringify({ document_id: `doc_${i}` }) },
        },
      ],
    },
  };
  const toolOutput: AiMessage = {
    id: `t_out_${i}`,
    role: 'tool',
    type: 'tool_output',
    content: `output_${i}`,
    timestamp: 1000 + i * 10 + 1,
    metadata: { tool_call_id: toolCallId, tool_name: 'workspace_read' },
  };
  return { toolCalls, toolOutput };
}

function makeMultiToolGroup(id: string): { toolCalls: AiMessage; outputs: AiMessage[] } {
  const toolCalls: AiMessage = {
    id: `a_${id}`,
    role: 'assistant',
    type: 'tool_calls',
    content: '',
    timestamp: 3000,
    metadata: {
      tool_calls: [
        {
          id: `${id}_1`,
          type: 'function',
          function: { name: 'resource_list', arguments: JSON.stringify({ source: 'workspace' }) },
        },
        {
          id: `${id}_2`,
          type: 'function',
          function: { name: 'resource_read', arguments: JSON.stringify({ uri: 'kb://doc-1' }) },
        },
      ],
    },
  };
  return {
    toolCalls,
    outputs: [
      {
        id: `t_${id}_1`,
        role: 'tool',
        type: 'tool_output',
        content: 'resource_list output',
        timestamp: 3001,
        metadata: { tool_call_id: `${id}_1`, tool_name: 'resource_list' },
      },
      {
        id: `t_${id}_2`,
        role: 'tool',
        type: 'tool_output',
        content: 'resource_read output',
        timestamp: 3002,
        metadata: { tool_call_id: `${id}_2`, tool_name: 'resource_read' },
      },
    ],
  };
}

function makeCompressedToolHistory(i: number): AiMessage {
  return {
    id: `c_tool_${i}`,
    role: 'assistant',
    type: 'final_answer',
    content: `压缩工具摘要_${i}`,
    timestamp: 500 + i,
    metadata: {
      isCompressedToolHistory: true,
      replacementSourceIds: [`a_tc_old_${i}`, `t_out_old_${i}`],
    },
  };
}

async function runTest() {
  console.log('🧪 Starting AgentWorkingMemoryProvider tool-limit test...');

  const provider = new AgentWorkingMemoryProvider();

  // 构造消息：13 条压缩工具摘要 + 2 对当前轮次工具交互
  // 期望：
  // - 当前轮次的 2 对工具交互全部保留（不受历史组上限限制）
  // - 历史段的压缩摘要最多保留 12 条（P3 上限独立于当前轮次原始组）
  const compressed = Array.from({ length: 13 }, (_, idx) => makeCompressedToolHistory(idx + 1));

  const rawPairs = [makeToolPair(1), makeToolPair(2)];

  // 🔥 关键：添加 user_input 消息，将压缩摘要划入"历史段"
  // user_input 放在压缩摘要之后，这样压缩摘要属于历史段，rawPairs 属于当前轮次
  const userInput: AiMessage = {
    id: 'user_input_1',
    role: 'user',
    type: 'user_input',
    content: '用户输入',
    timestamp: 600, // 在压缩摘要之后
    metadata: {},
  };

  const messages: AiMessage[] = [
    ...compressed,
    // user_input 作为当前轮次的起点
    userInput,
    // 2 对原始工具交互（属于当前轮次）
    rawPairs[0].toolCalls, rawPairs[0].toolOutput,
    rawPairs[1].toolCalls, rawPairs[1].toolOutput,
  ];

  const states: MessageProcessingState[] = messages.map((m, idx) => ({
    message: m,
    originalIndex: idx,
    action: 'skip',
    tokens: 1, // 测试不关心 token 估算，给常量即可
  }));

  const ctx: ProviderContext = {
    totalBudget: 100000,
    config: AGENT_CONTEXT_BUILDER_CONFIG,
    debugMode: false,
    estimateTokens: () => 1,
  };

  const res = await provider.provide(states, 100000, ctx);
  const kept = res.states.filter(s => s.action === 'keep_working_memory').map(s => s.message.id);

  // 1) 当前轮次的工具交互：全部保留（pair1/pair2）
  assert(kept.includes('a_tc_1') && kept.includes('t_out_1'), 'should keep tool pair 1 (current turn)');
  assert(kept.includes('a_tc_2') && kept.includes('t_out_2'), 'should keep tool pair 2 (current turn)');

  // 2) 历史段工具交互组上限 12：压缩摘要最多保留 12 条
  const keptCompressed = kept.filter(id => id.startsWith('c_tool_'));
  assert(keptCompressed.length === 12, `should keep 12 compressed tool summaries, got ${keptCompressed.length}`);

  // 3) 压缩摘要应该优先保留"更近"的（靠后的那些）
  // 我们构造的压缩摘要 id 是 c_tool_1 ... c_tool_13，越大越"新"
  const expectedKept = new Set(['c_tool_2', 'c_tool_3', 'c_tool_4', 'c_tool_5', 'c_tool_6', 'c_tool_7', 'c_tool_8', 'c_tool_9', 'c_tool_10', 'c_tool_11', 'c_tool_12', 'c_tool_13']);
  for (const id of keptCompressed) {
    assert(expectedKept.has(id), `unexpected compressed summary kept: ${id}`);
  }

  // 4) multi-tool raw group 在 P1 中只计 1 组额度，且必须整组保留
  const multiToolGroup = makeMultiToolGroup('multi_group');
  const multiMessages: AiMessage[] = [
    ...compressed,
    userInput,
    multiToolGroup.toolCalls,
    ...multiToolGroup.outputs,
  ];
  const multiStates: MessageProcessingState[] = multiMessages.map((message, index) => ({
    message,
    originalIndex: index,
    action: 'skip',
    tokens: 1,
  }));
  const multiRes = await provider.provide(multiStates, 100000, ctx);
  const multiKept = multiRes.states.filter((state) => state.action === 'keep_working_memory').map((state) => state.message.id);
  assert(multiKept.includes('a_multi_group'), 'should keep multi-tool assistant anchor');
  assert(multiKept.includes('t_multi_group_1'), 'should keep first multi-tool output');
  assert(multiKept.includes('t_multi_group_2'), 'should keep second multi-tool output');
  const multiKeptCompressed = multiKept.filter((id) => id.startsWith('c_tool_'));
  assert(multiKeptCompressed.length === 12, `multi-tool current turn should not reduce historical group quota, got ${multiKeptCompressed.length}`);

  console.log('🎉 All tests passed!');
}

// vitest 加载本文件时跳过自调用；npx tsx <file> 直跑时仍执行
if (!process.env.VITEST) {
  runTest().catch(console.error);
}
