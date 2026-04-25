import { describe, expect, it } from 'vitest';

import type { AiMessage } from '../../../../../contracts';
import { ToolHistoryCompressorPreprocessor } from '../toolHistoryCompressor';

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
    extraContent?: Record<string, unknown>;
  }>;
  reasoningDetails?: unknown[];
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
      ...(opts.reasoningDetails ? { reasoning_details: opts.reasoningDetails } : {}),
      tool_calls: toolCalls.map((toolCall) => ({
        id: toolCall.toolCallId,
        type: 'function',
        function: {
          name: toolCall.toolName,
          arguments: JSON.stringify(toolCall.args),
        },
        ...(toolCall.extraContent ? { extra_content: toolCall.extraContent } : {}),
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
  rawOutput?: string;
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
      ...(opts.rawOutput ? { raw_output: opts.rawOutput } : {}),
    },
  };
}

function createUserInput(id: string, timestamp: number, content: string): AiMessage {
  return {
    id,
    role: 'user',
    type: 'user_input',
    content,
    timestamp,
  };
}

describe('ToolHistoryCompressorPreprocessor', () => {
  it('compresses only older tool groups and keeps the latest two raw groups', async () => {
    const preprocessor = new ToolHistoryCompressorPreprocessor({ keepLatestToolPairs: 2 });

    const messages: AiMessage[] = [
      createUserInput('u_old', 1000, '旧问题'),
      createToolCallsMessage({
        id: 'a_tc_1',
        timestamp: 1100,
        toolCallId: 'tc_1',
        toolName: 'workspace_read',
        args: { document_id: 'doc-1' },
      }),
      createToolOutputMessage({
        id: 't_out_1',
        timestamp: 1200,
        toolCallId: 'tc_1',
        toolName: 'workspace_read',
        content: '{"observation":"已读取文档 doc-1，主题是代码质量"}',
      }),
      createToolCallsMessage({
        id: 'a_tc_2',
        timestamp: 1300,
        toolCallId: 'tc_2',
        toolName: 'workspace_read',
        args: { document_id: 'doc-2' },
      }),
      createToolOutputMessage({
        id: 't_out_2',
        timestamp: 1400,
        toolCallId: 'tc_2',
        toolName: 'workspace_read',
        content: '{"observation":"已读取文档 doc-2，主题是重构"}',
      }),
      createToolCallsMessage({
        id: 'a_tc_3',
        timestamp: 1500,
        toolCallId: 'tc_3',
        toolName: 'workspace_read',
        args: { document_id: 'doc-3' },
      }),
      createToolOutputMessage({
        id: 't_out_3',
        timestamp: 1600,
        toolCallId: 'tc_3',
        toolName: 'workspace_read',
        content: '{"observation":"已读取文档 doc-3，主题是技术债务"}',
      }),
      {
        id: 'a_old',
        role: 'assistant',
        type: 'final_answer',
        content: '旧回答',
        timestamp: 1700,
      },
      createUserInput('u_current', 9999, '新问题（本轮开始）'),
    ];

    const result = await preprocessor.process(messages, { debugMode: false });

    expect(result.messages.some((message) => message.id === 'a_tc_1')).toBe(false);
    expect(result.messages.some((message) => message.id === 't_out_1')).toBe(false);
    expect(result.messages.some((message) => message.id === 'a_tc_2')).toBe(true);
    expect(result.messages.some((message) => message.id === 't_out_2')).toBe(true);
    expect(result.messages.some((message) => message.id === 'a_tc_3')).toBe(true);
    expect(result.messages.some((message) => message.id === 't_out_3')).toBe(true);

    const compressed = result.messages.find(
      (message) =>
        message.role === 'assistant' &&
        message.type === 'final_answer' &&
        message.metadata?.isCompressedToolHistory === true,
    );

    expect(compressed).toBeDefined();
    expect(compressed?.metadata?.replacementSourceIds).toEqual(
      expect.arrayContaining(['a_tc_1', 't_out_1']),
    );
    expect(compressed?.content).toContain('我已经调用了工具');
    expect(compressed?.content).not.toContain('[观察]');
    expect(result.appliedStrategies).toContain('tool_history_compression');
  });

  it('keeps the latest checkpoint group while still compressing older non-checkpoint groups', async () => {
    const preprocessor = new ToolHistoryCompressorPreprocessor({ keepLatestToolPairs: 2 });

    const checkpointRawOutput = JSON.stringify({
      data: { _type: 'context_checkpoint', summary: 'phase done' },
      observation: 'Context checkpoint created.',
    });

    const messages: AiMessage[] = [
      createUserInput('u_old', 1000, '旧问题'),
      createToolCallsMessage({
        id: 'a_tc_1',
        timestamp: 1100,
        toolCallId: 'tc_1',
        toolName: 'workspace_read',
        args: { document_id: 'doc-1' },
      }),
      createToolOutputMessage({
        id: 't_out_1',
        timestamp: 1200,
        toolCallId: 'tc_1',
        toolName: 'workspace_read',
        content: '{"observation":"已读取文档 doc-1"}',
      }),
      createToolCallsMessage({
        id: 'a_tc_2',
        timestamp: 1300,
        toolCallId: 'tc_2',
        toolName: 'workspace_read',
        args: { document_id: 'doc-2' },
      }),
      createToolOutputMessage({
        id: 't_out_2',
        timestamp: 1400,
        toolCallId: 'tc_2',
        toolName: 'workspace_read',
        content: '{"observation":"已读取文档 doc-2"}',
      }),
      createToolCallsMessage({
        id: 'a_tc_3',
        timestamp: 1500,
        toolCallId: 'tc_3',
        toolName: 'workspace_read',
        args: { document_id: 'doc-3' },
      }),
      createToolOutputMessage({
        id: 't_out_3',
        timestamp: 1600,
        toolCallId: 'tc_3',
        toolName: 'workspace_read',
        content: '{"observation":"已读取文档 doc-3"}',
      }),
      createToolCallsMessage({
        id: 'a_tc_cp',
        timestamp: 1650,
        toolCallId: 'tc_cp',
        toolName: 'context_checkpoint',
        args: { summary: 'phase done' },
      }),
      createToolOutputMessage({
        id: 't_out_cp',
        timestamp: 1660,
        toolCallId: 'tc_cp',
        toolName: 'context_checkpoint',
        content: 'Context checkpoint created.',
        rawOutput: checkpointRawOutput,
      }),
      {
        id: 'a_old',
        role: 'assistant',
        type: 'final_answer',
        content: '旧回答',
        timestamp: 1700,
      },
      createUserInput('u_current', 9999, '新问题（本轮开始）'),
    ];

    const result = await preprocessor.process(messages, { debugMode: false });

    expect(result.messages.some((message) => message.id === 'a_tc_1')).toBe(false);
    expect(result.messages.some((message) => message.id === 't_out_1')).toBe(false);
    expect(result.messages.some((message) => message.id === 'a_tc_2')).toBe(true);
    expect(result.messages.some((message) => message.id === 't_out_2')).toBe(true);
    expect(result.messages.some((message) => message.id === 'a_tc_3')).toBe(true);
    expect(result.messages.some((message) => message.id === 't_out_3')).toBe(true);
    expect(result.messages.some((message) => message.id === 'a_tc_cp')).toBe(true);
    expect(result.messages.some((message) => message.id === 't_out_cp')).toBe(true);
    expect(result.appliedStrategies).toContain('tool_history_compression');
  });

  it('compresses a multi-tool assistant group as one atomic replacement and summarizes long outputs', async () => {
    const preprocessor = new ToolHistoryCompressorPreprocessor({ keepLatestToolPairs: 1 });
    const veryLongObservation = JSON.stringify({
      observation: 'A'.repeat(520),
    });

    const messages: AiMessage[] = [
      createUserInput('u_old', 1000, '旧问题'),
      createToolCallsMessage({
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
      }),
      createToolOutputMessage({
        id: 't_out_multi_1',
        timestamp: 1810,
        toolCallId: 'tc_multi_1',
        toolName: 'resource_list',
        content: '{"observation":"列出了 5 个资源"}',
      }),
      createToolOutputMessage({
        id: 't_out_multi_2',
        timestamp: 1820,
        toolCallId: 'tc_multi_2',
        toolName: 'resource_read',
        content: veryLongObservation,
      }),
      createToolCallsMessage({
        id: 'a_tc_latest',
        timestamp: 1900,
        toolCallId: 'tc_latest',
        toolName: 'workspace_read',
        args: { document_id: 'doc-latest' },
      }),
      createToolOutputMessage({
        id: 't_out_latest',
        timestamp: 1910,
        toolCallId: 'tc_latest',
        toolName: 'workspace_read',
        content: '{"observation":"保留最近工具组"}',
      }),
      createUserInput('u_current', 9999, '新问题（本轮开始）'),
    ];

    const result = await preprocessor.process(messages, { debugMode: false });

    expect(result.messages.some((message) => message.id === 'a_tc_multi')).toBe(false);
    expect(result.messages.some((message) => message.id === 't_out_multi_1')).toBe(false);
    expect(result.messages.some((message) => message.id === 't_out_multi_2')).toBe(false);

    const compressed = result.messages.find(
      (message) => message.metadata?.isCompressedToolHistory === true,
    );

    expect(compressed).toBeDefined();
    expect(compressed?.metadata?.replacementSourceIds).toEqual(
      expect.arrayContaining(['a_tc_multi', 't_out_multi_1', 't_out_multi_2']),
    );
    expect(compressed?.metadata?.compressedToolCallIds).toEqual(
      expect.arrayContaining(['tc_multi_1', 'tc_multi_2']),
    );
    expect(compressed?.content).toContain('resource_list');
    expect(compressed?.content).toContain('resource_read');
    expect(compressed?.content).toContain('返回了520字符的文本');
  });

  it('keeps provider sidecar on retained tool groups and drops structured sidecar from compressed groups', async () => {
    const preprocessor = new ToolHistoryCompressorPreprocessor({ keepLatestToolPairs: 1 });
    const oldReasoning = [
      { provider: 'deepseek', type: 'reasoning_content', reasoning_content: 'Old reason.' },
    ];
    const keptReasoning = [
      { provider: 'deepseek', type: 'reasoning_content', reasoning_content: 'Kept reason.' },
    ];

    const messages: AiMessage[] = [
      createUserInput('u_old', 1000, '旧问题'),
      createToolCallsMessage({
        id: 'a_tc_old',
        timestamp: 1100,
        toolCallId: 'tc_old',
        toolName: 'workspace_read',
        args: { path: 'old.md' },
        reasoningDetails: oldReasoning,
      }),
      createToolOutputMessage({
        id: 't_out_old',
        timestamp: 1200,
        toolCallId: 'tc_old',
        toolName: 'workspace_read',
        content: 'old output',
      }),
      createToolCallsMessage({
        id: 'a_tc_kept',
        timestamp: 1300,
        toolCalls: [
          {
            toolCallId: 'tc_kept',
            toolName: 'workspace_read',
            args: { path: 'kept.md' },
            extraContent: {
              google: { thought_signature: '<sig>' },
              deepseek: { replay_marker: 'opaque' },
            },
          },
        ],
        reasoningDetails: keptReasoning,
      }),
      createToolOutputMessage({
        id: 't_out_kept',
        timestamp: 1400,
        toolCallId: 'tc_kept',
        toolName: 'workspace_read',
        content: 'kept output',
      }),
      createUserInput('u_current', 9999, '新问题（本轮开始）'),
    ];

    const result = await preprocessor.process(messages, { debugMode: false });
    const kept = result.messages.find((message) => message.id === 'a_tc_kept');
    const compressed = result.messages.find(
      (message) => message.metadata?.isCompressedToolHistory === true,
    );

    expect(kept?.metadata?.reasoning_details).toEqual(keptReasoning);
    expect(kept?.metadata?.tool_calls?.[0]?.extra_content).toEqual({
      google: { thought_signature: '<sig>' },
      deepseek: { replay_marker: 'opaque' },
    });
    expect(compressed?.metadata?.reasoning_details).toBeUndefined();
    expect(compressed?.metadata?.tool_calls).toBeUndefined();
  });
});
