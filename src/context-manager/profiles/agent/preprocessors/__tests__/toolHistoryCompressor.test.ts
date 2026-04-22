/**
 * @file src/agent/context-manager/profiles/agent/preprocessors/__tests__/toolHistoryCompressor.test.ts
 * @description ToolHistoryCompressorPreprocessor 测试
 *
 * 运行测试:
 * npx tsx src/agent/context-manager/profiles/agent/preprocessors/__tests__/toolHistoryCompressor.test.ts
 *
 * 核心验证点：
 * 1) “历史段”里的工具交互：仅压缩更早的部分，保留最近 2 对原始 tool_calls/tool_output
 * 2) 压缩后的文案使用自然语言，不包含 "[观察]" 等容易让模型误判为工具格式的标记
 * 3) 压缩消息携带 replacementSourceIds，便于后续历史净化穿透删除
 */

import { describe } from 'vitest';
describe.skip('TODO: 恢复历史测试（tsx-script 风格，未接入 vitest）', () => { /* see git history */ });

import { ToolHistoryCompressorPreprocessor } from '../toolHistoryCompressor';
import type { AiMessage } from '../../../../../contracts';

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

function createToolCallsMessage(opts: {
  id: string;
  timestamp: number;
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
  }>;
}): AiMessage {
  const toolCalls = opts.toolCalls ?? [
    {
      toolCallId: opts.toolCallId ?? 'default_tool_call_id',
      toolName: opts.toolName ?? 'default_tool_name',
      args: opts.args ?? {},
    },
  ];
  return {
    id: opts.id,
    role: 'assistant',
    type: 'tool_calls',
    content: '',
    timestamp: opts.timestamp,
    metadata: {
      tool_calls: toolCalls.map((toolCall) => ({
        id: toolCall.toolCallId,
        type: 'function',
        function: {
          name: toolCall.toolName,
          arguments: JSON.stringify(toolCall.args),
        },
      })),
    },
  };
}

function createToolOutputMessage(opts: {
  id: string;
  timestamp: number;
  toolCallId: string;
  toolName: string;
  content: string;
}): AiMessage {
  return {
    id: opts.id,
    role: 'tool',
    type: 'tool_output',
    content: opts.content,
    timestamp: opts.timestamp,
    metadata: {
      tool_call_id: opts.toolCallId,
      tool_name: opts.toolName,
    },
  };
}

async function runTest() {
  console.log('🧪 Starting ToolHistoryCompressorPreprocessor Test...');

  // 保留最近 2 对工具交互为“原始形态”，只压缩更早的工具对
  const preprocessor = new ToolHistoryCompressorPreprocessor({ keepLatestToolPairs: 2 });

  // 构造一个消息序列：
  // - 历史段：user_old + 3 对工具交互 (pair1/pair2/pair3) + assistant_old
  // - 当前轮次段：user_current（最后一条 user，用于切分边界）
  //
  // 期望：
  // - pair1 被压缩成 1 条 assistant final_answer（自然语言模板）
  // - pair2/pair3 保持原始 tool_calls + tool_output，不压缩
  const userOld: AiMessage = {
    id: 'u_old',
    role: 'user',
    type: 'user_input',
    content: '旧问题',
    timestamp: 1000,
  };

  const pair1Call = createToolCallsMessage({
    id: 'a_tc_1',
    timestamp: 1100,
    toolCallId: 'tc_1',
    toolName: 'workspace_read',
    args: { document_id: 'doc-1' },
  });
  const pair1Out = createToolOutputMessage({
    id: 't_out_1',
    timestamp: 1200,
    toolCallId: 'tc_1',
    toolName: 'workspace_read',
    content: '{"observation":"已读取文档 doc-1，主题是代码质量"}',
  });

  const pair2Call = createToolCallsMessage({
    id: 'a_tc_2',
    timestamp: 1300,
    toolCallId: 'tc_2',
    toolName: 'workspace_read',
    args: { document_id: 'doc-2' },
  });
  const pair2Out = createToolOutputMessage({
    id: 't_out_2',
    timestamp: 1400,
    toolCallId: 'tc_2',
    toolName: 'workspace_read',
    content: '{"observation":"已读取文档 doc-2，主题是重构"}',
  });

  const pair3Call = createToolCallsMessage({
    id: 'a_tc_3',
    timestamp: 1500,
    toolCallId: 'tc_3',
    toolName: 'workspace_read',
    args: { document_id: 'doc-3' },
  });
  const pair3Out = createToolOutputMessage({
    id: 't_out_3',
    timestamp: 1600,
    toolCallId: 'tc_3',
    toolName: 'workspace_read',
    content: '{"observation":"已读取文档 doc-3，主题是技术债务"}',
  });

  const assistantOld: AiMessage = {
    id: 'a_old',
    role: 'assistant',
    type: 'final_answer',
    content: '旧回答',
    timestamp: 1700,
  };

  const userCurrent: AiMessage = {
    id: 'u_current',
    role: 'user',
    type: 'user_input',
    content: '新问题（本轮开始）',
    timestamp: 9999,
  };

  const input: AiMessage[] = [
    userOld,
    pair1Call,
    pair1Out,
    pair2Call,
    pair2Out,
    pair3Call,
    pair3Out,
    assistantOld,
    userCurrent,
  ];

  const result = await preprocessor.process(input, { debugMode: false });
  const out = result.messages;

  // 1) pair1 应该被压缩：原始 a_tc_1 / t_out_1 都不存在
  assert(!out.some(m => m.id === 'a_tc_1'), 'pair1 tool_calls should be removed');
  assert(!out.some(m => m.id === 't_out_1'), 'pair1 tool_output should be removed');

  // 2) pair2/pair3 应该保留原始消息
  assert(out.some(m => m.id === 'a_tc_2'), 'pair2 tool_calls should be kept');
  assert(out.some(m => m.id === 't_out_2'), 'pair2 tool_output should be kept');
  assert(out.some(m => m.id === 'a_tc_3'), 'pair3 tool_calls should be kept');
  assert(out.some(m => m.id === 't_out_3'), 'pair3 tool_output should be kept');

  // 3) 产物中应该出现 1 条压缩消息（assistant final_answer，包含 replacementSourceIds）
  const compressed = out.find(
    m =>
      m.role === 'assistant' &&
      m.type === 'final_answer' &&
      typeof m.metadata?.isCompressedToolHistory === 'boolean' &&
      m.metadata.isCompressedToolHistory === true
  );
  assert(!!compressed, 'compressed message should exist');
  assert(
    Array.isArray(compressed?.metadata?.replacementSourceIds),
    'compressed message should contain replacementSourceIds'
  );
  assert(
    (compressed?.metadata?.replacementSourceIds || []).includes('a_tc_1'),
    'replacementSourceIds should include original tool_calls id'
  );
  assert(
    (compressed?.metadata?.replacementSourceIds || []).includes('t_out_1'),
    'replacementSourceIds should include original tool_output id'
  );

  // 4) 文案必须是自然语言，不含 "[观察]"
  assert(!compressed?.content.includes('[观察]'), 'compressed content must not contain [观察]');
  assert(compressed?.content.includes('我已经调用了工具'), 'compressed content should use natural language record template');

  // 5) 当历史段存在 checkpoint 对时：仍执行压缩，但会额外保留 checkpoint 对
  //    且继续保留最近 2 对非-checkpoint 工具交互。
  const checkpointToolCall = createToolCallsMessage({
    id: 'a_tc_cp',
    timestamp: 1650,
    toolCallId: 'tc_cp',
    toolName: 'context_checkpoint',
    args: { summary: 'phase done' },
  });
  const checkpointRawOutput = JSON.stringify({
    data: { _type: 'context_checkpoint', summary: 'phase done' },
    observation: 'Context checkpoint created.',
  });
  const checkpointToolOutput: AiMessage = {
    id: 't_out_cp',
    role: 'tool',
    type: 'tool_output',
    content: 'Context checkpoint created.',
    timestamp: 1660,
    metadata: {
      tool_call_id: 'tc_cp',
      tool_name: 'context_checkpoint',
      raw_output: checkpointRawOutput,
    },
  };

  const inputWithCheckpoint: AiMessage[] = [
    userOld,
    pair1Call,
    pair1Out,
    pair2Call,
    pair2Out,
    pair3Call,
    pair3Out,
    checkpointToolCall,
    checkpointToolOutput,
    assistantOld,
    userCurrent,
  ];

  const resultWithCheckpoint = await preprocessor.process(inputWithCheckpoint, { debugMode: false });
  const outWithCheckpoint = resultWithCheckpoint.messages;

  // pair1 应该被压缩（最旧的非-checkpoint）
  assert(!outWithCheckpoint.some(m => m.id === 'a_tc_1'), 'pair1 should be compressed with checkpoint-aware strategy');
  assert(!outWithCheckpoint.some(m => m.id === 't_out_1'), 'pair1 output should be compressed with checkpoint-aware strategy');
  // pair2 / pair3（最近两对非-checkpoint）应保留
  assert(outWithCheckpoint.some(m => m.id === 'a_tc_2'), 'pair2 should be kept');
  assert(outWithCheckpoint.some(m => m.id === 't_out_2'), 'pair2 output should be kept');
  assert(outWithCheckpoint.some(m => m.id === 'a_tc_3'), 'pair3 should be kept');
  assert(outWithCheckpoint.some(m => m.id === 't_out_3'), 'pair3 output should be kept');
  // checkpoint 对也应保留（供 2.5 阶段识别并替换）
  assert(outWithCheckpoint.some(m => m.id === 'a_tc_cp'), 'checkpoint tool call should be kept');
  assert(outWithCheckpoint.some(m => m.id === 't_out_cp'), 'checkpoint tool output should be kept');

  assert(
    resultWithCheckpoint.appliedStrategies.includes('tool_history_compression'),
    'should still run compression with checkpoint-aware keep strategy'
  );

  // 6) 单条 assistant.tool_calls 含多个 tool_call 时，必须整组压缩而不是部分覆盖
  const multiToolCall = createToolCallsMessage({
    id: 'a_tc_multi',
    timestamp: 1800,
    toolCalls: [
      {
        toolCallId: 'tc_multi_1',
        toolName: 'resource_list',
        args: { source: 'workspace' },
      },
      {
        toolCallId: 'tc_multi_2',
        toolName: 'resource_read',
        args: { uri: 'kb://doc-1' },
      },
    ],
  });
  const multiToolOut1 = createToolOutputMessage({
    id: 't_out_multi_1',
    timestamp: 1810,
    toolCallId: 'tc_multi_1',
    toolName: 'resource_list',
    content: '{"observation":"列出了 5 个资源"}',
  });
  const multiToolOut2 = createToolOutputMessage({
    id: 't_out_multi_2',
    timestamp: 1820,
    toolCallId: 'tc_multi_2',
    toolName: 'resource_read',
    content: '{"observation":"读取了知识库文档"}',
  });
  const latestToolCall = createToolCallsMessage({
    id: 'a_tc_latest',
    timestamp: 1900,
    toolCallId: 'tc_latest',
    toolName: 'workspace_read',
    args: { document_id: 'doc-latest' },
  });
  const latestToolOut = createToolOutputMessage({
    id: 't_out_latest',
    timestamp: 1910,
    toolCallId: 'tc_latest',
    toolName: 'workspace_read',
    content: '{"observation":"保留最近工具组"}',
  });
  const multiToolInput: AiMessage[] = [
    userOld,
    multiToolCall,
    multiToolOut1,
    multiToolOut2,
    latestToolCall,
    latestToolOut,
    userCurrent,
  ];
  const multiToolPreprocessor = new ToolHistoryCompressorPreprocessor({ keepLatestToolPairs: 1 });
  const multiToolResult = await multiToolPreprocessor.process(multiToolInput, { debugMode: false });
  const multiToolMessages = multiToolResult.messages;
  assert(!multiToolMessages.some((message) => message.id === 'a_tc_multi'), 'multi-tool assistant anchor should be removed');
  assert(!multiToolMessages.some((message) => message.id === 't_out_multi_1'), 'first multi-tool output should be removed');
  assert(!multiToolMessages.some((message) => message.id === 't_out_multi_2'), 'second multi-tool output should be removed');
  const multiCompressed = multiToolMessages.find((message) => message.metadata?.isCompressedToolHistory === true);
  assert(!!multiCompressed, 'multi-tool compressed summary should exist');
  assert(
    (multiCompressed?.metadata?.replacementSourceIds || []).includes('a_tc_multi') &&
      (multiCompressed?.metadata?.replacementSourceIds || []).includes('t_out_multi_1') &&
      (multiCompressed?.metadata?.replacementSourceIds || []).includes('t_out_multi_2'),
    'multi-tool replacementSourceIds should cover the whole group',
  );
  assert(
    Array.isArray(multiCompressed?.metadata?.compressedToolCallIds) &&
      (multiCompressed?.metadata?.compressedToolCallIds || []).length === 2,
    'multi-tool compressed summary should record all tool_call ids',
  );
  assert(
    multiCompressed?.content.includes('resource_list') && multiCompressed?.content.includes('resource_read'),
    'multi-tool compressed content should mention all tool names',
  );

  console.log('🎉 All tests passed!');
}

// vitest 加载本文件时跳过自调用；npx tsx <file> 直跑时仍执行
if (!process.env.VITEST) {
  runTest().catch(console.error);
}
