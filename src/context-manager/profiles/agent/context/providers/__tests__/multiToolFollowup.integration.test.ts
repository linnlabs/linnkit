import { describe, expect, it } from 'vitest';
import { ToolHistoryCompressorPreprocessor } from '../../../preprocessors/toolHistoryCompressor';
import { ToolReplayProtocolGuardPreprocessor } from '../../../preprocessors/toolReplayProtocolGuard';
import { AgentWorkingMemoryProvider } from '../AgentWorkingMemoryProvider';
import { HistoryPurificationPreprocessor } from '../../../../../shared/preprocessors';
import { formatAgentLlmMessages } from '../../../../../shared';
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

  it('应让带真实 reasoning_details 的历史工具组经过三阶段后仍随 assistant(tool_calls) 出关', async () => {
    const reasoningDetails = [
      { provider: 'deepseek', type: 'reasoning_content', reasoning_content: 'Need the tool.' },
    ];
    const sourceMessages: AiMessage[] = [
      {
        id: 'user_old_sidecar',
        role: 'user',
        type: 'user_input',
        content: '先读文档',
        timestamp: 1000,
      },
      {
        id: 'assistant_sidecar',
        role: 'assistant',
        type: 'tool_calls',
        content: '',
        timestamp: 1100,
        metadata: {
          reasoning_details: reasoningDetails,
          tool_calls: [
            {
              id: 'call_sidecar',
              type: 'function',
              function: {
                name: 'workspace_read',
                arguments: JSON.stringify({ path: 'README.md' }),
              },
            },
          ],
        },
      },
      {
        id: 'tool_sidecar',
        role: 'tool',
        type: 'tool_output',
        content: '{"observation":"README 内容"}',
        timestamp: 1200,
        metadata: {
          tool_call_id: 'call_sidecar',
          tool_name: 'workspace_read',
          raw_output: '{"observation":"README 内容"}',
        },
      },
      {
        id: 'assistant_after_tool',
        role: 'assistant',
        type: 'final_answer',
        content: '已读完。',
        timestamp: 1300,
      },
      {
        id: 'user_followup_sidecar',
        role: 'user',
        type: 'user_input',
        content: '继续',
        timestamp: 2000,
      },
    ];

    const pipelineHarness = createContextPipelineHarness({
      messages: sourceMessages,
      estimateTokens: () => 1,
      totalBudget: 100_000,
    });
    const compressedResult = await pipelineHarness.runPreprocessors([
      new ToolHistoryCompressorPreprocessor({ keepLatestToolPairs: 2 }),
      new HistoryPurificationPreprocessor({ logPrefix: 'SidecarRootCauseTest' }),
    ]);
    const workingMemoryResult = await pipelineHarness.runProvider(
      new AgentWorkingMemoryProvider(),
      {
        messages: compressedResult.messages,
        coreMessageIds: ['user_followup_sidecar'],
      },
    );
    const selectedMessages = workingMemoryResult.states
      .filter((state) => state.action === 'keep_core' || state.action === 'keep_working_memory')
      .map((state) => state.message);
    const llmMessages = formatAgentLlmMessages(selectedMessages);
    const assistantToolCalls = llmMessages.find((message) => {
      return message.role === 'assistant' && 'tool_calls' in message;
    });

    expect(assistantToolCalls).toBeDefined();
    expect(assistantToolCalls?.reasoning_details).toEqual(reasoningDetails);
  });

  it('DeepSeek 历史工具组缺真实 reasoning_details 时应降级为文本，不应从 thought 伪造 sidecar', async () => {
    const sourceMessages: AiMessage[] = [
      {
        id: 'user_old_missing_sidecar',
        role: 'user',
        type: 'user_input',
        content: '先读文档',
        timestamp: 1000,
      },
      {
        id: 'thought_old_missing_sidecar',
        role: 'assistant',
        type: 'thought',
        content: '我需要读 README。',
        timestamp: 1050,
      },
      {
        id: 'assistant_missing_sidecar',
        role: 'assistant',
        type: 'tool_calls',
        content: '',
        timestamp: 1100,
        metadata: {
          tool_calls: [
            {
              id: 'call_missing_sidecar',
              type: 'function',
              function: {
                name: 'workspace_read',
                arguments: JSON.stringify({ path: 'README.md' }),
              },
            },
          ],
        },
      },
      {
        id: 'tool_missing_sidecar',
        role: 'tool',
        type: 'tool_output',
        content: '{"observation":"README 内容"}',
        timestamp: 1200,
        metadata: {
          tool_call_id: 'call_missing_sidecar',
          tool_name: 'workspace_read',
          raw_output: '{"observation":"README 内容"}',
        },
      },
      {
        id: 'user_followup_missing_sidecar',
        role: 'user',
        type: 'user_input',
        content: '继续',
        timestamp: 2000,
      },
    ];

    const pipelineHarness = createContextPipelineHarness({
      messages: sourceMessages,
      estimateTokens: () => 1,
      totalBudget: 100_000,
    });
    const preprocessed = await pipelineHarness.runPreprocessors([
      new ToolHistoryCompressorPreprocessor({ keepLatestToolPairs: 2 }),
      new ToolReplayProtocolGuardPreprocessor({
        policy: {
          provider: 'deepseek',
          requiresReasoningDetailsForToolReplay: true,
          missingSidecarBehavior: 'degrade_to_text',
        },
      }),
      new HistoryPurificationPreprocessor({ logPrefix: 'SidecarGuardTest' }),
    ]);
    const llmMessages = formatAgentLlmMessages(preprocessed.messages);

    expect(llmMessages.some((message) => message.role === 'assistant' && 'tool_calls' in message)).toBe(false);
    expect(llmMessages.some((message) => message.role === 'tool')).toBe(false);
    expect(
      preprocessed.messages.some((message) => message.metadata?.isDegradedToolReplay === true),
    ).toBe(true);
  });
});
