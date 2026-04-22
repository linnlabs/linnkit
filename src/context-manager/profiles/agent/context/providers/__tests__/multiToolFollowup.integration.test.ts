import { describe, expect, it } from 'vitest';
import { ToolHistoryCompressorPreprocessor } from '../../../preprocessors/toolHistoryCompressor';
import { AgentWorkingMemoryProvider } from '../AgentWorkingMemoryProvider';
import { HistoryPurificationPreprocessor } from '../../../../../shared/preprocessors';
import { createContextPipelineHarness } from '../../../../../../testkit/context-harness/contextPipelineHarness';
import type { AiMessage } from '../../../../../../contracts';

function makeMultiToolMessages(): AiMessage[] {
  return [
    {
      id: 'user_old',
      role: 'user',
      type: 'user_input',
      content: '先测试多工具调用',
      timestamp: 1000,
    },
    {
      id: 'assistant_multi',
      role: 'assistant',
      type: 'tool_calls',
      content: '',
      timestamp: 1100,
      metadata: {
        tool_calls: [
          {
            id: 'call_list',
            type: 'function',
            function: {
              name: 'resource_list',
              arguments: JSON.stringify({ source: 'workspace' }),
            },
          },
          {
            id: 'call_read',
            type: 'function',
            function: {
              name: 'resource_read',
              arguments: JSON.stringify({ uri: 'kb://doc-1' }),
            },
          },
        ],
      },
    },
    {
      id: 'tool_list',
      role: 'tool',
      type: 'tool_output',
      content: '{"observation":"列出 3 个资源"}',
      timestamp: 1200,
      metadata: {
        tool_call_id: 'call_list',
        tool_name: 'resource_list',
      },
    },
    {
      id: 'tool_read',
      role: 'tool',
      type: 'tool_output',
      content: '{"observation":"读取文档成功"}',
      timestamp: 1300,
      metadata: {
        tool_call_id: 'call_read',
        tool_name: 'resource_read',
      },
    },
    {
      id: 'user_new',
      role: 'user',
      type: 'user_input',
      content: '继续追问',
      timestamp: 2000,
    },
  ];
}

describe('multi tool follow-up integration', () => {
  it('应保留压缩后的多工具摘要，并在净化阶段通过 replacementSourceIds 移除', async () => {
    const sourceMessages = makeMultiToolMessages();
    const pipelineHarness = createContextPipelineHarness({
      messages: sourceMessages,
      estimateTokens: () => 1,
      totalBudget: 100_000,
    });

    const compressedResult = await pipelineHarness.runPreprocessors([
      new ToolHistoryCompressorPreprocessor({ keepLatestToolPairs: 0 }),
    ]);
    const compressedSummary = compressedResult.messages.find(
      (message) => message.metadata?.isCompressedToolHistory === true,
    );

    expect(compressedSummary).toBeDefined();
    expect(compressedSummary?.metadata?.replacementSourceIds).toHaveLength(3);

    const workingMemoryResult = await pipelineHarness.runProvider(
      new AgentWorkingMemoryProvider(),
      {
        messages: compressedResult.messages,
        coreMessageIds: ['user_new'],
      },
    );
    const keptCompressedSummary = workingMemoryResult.states.find(
      (state) => state.message.id === compressedSummary?.id,
    );

    expect(keptCompressedSummary?.action).toBe('keep_working_memory');

    const historySummary: AiMessage = {
      id: 'history_summary_1',
      role: 'system',
      type: 'history_summary',
      content: '历史摘要',
      timestamp: 3000,
      metadata: {
        summarySeq: 1,
        replacedMessageIds: compressedSummary?.metadata?.replacementSourceIds ?? [],
      },
    };
    const purifiedResult = await createContextPipelineHarness({
      messages: [
        historySummary,
        ...(compressedSummary ? [compressedSummary] : []),
        {
          id: 'user_after_summary',
          role: 'user',
          type: 'user_input',
          content: '摘要后继续提问',
          timestamp: 4000,
        },
      ],
      estimateTokens: () => 1,
    }).runPreprocessors([
      new HistoryPurificationPreprocessor({ logPrefix: 'MultiToolFollowupTest' }),
    ]);

    expect(
      purifiedResult.messages.some((message) => message.id === compressedSummary?.id),
    ).toBe(false);
  });
});
