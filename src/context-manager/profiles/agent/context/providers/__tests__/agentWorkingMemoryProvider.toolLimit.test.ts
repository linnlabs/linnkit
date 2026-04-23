import { describe, expect, it } from 'vitest';

import type { AiMessage } from '../../../../../../contracts';
import { AGENT_CONTEXT_BUILDER_CONFIG } from '../../config';
import type { MessageProcessingState, ProviderContext } from '../base';
import { AgentWorkingMemoryProvider } from '../AgentWorkingMemoryProvider';

function makeToolPair(i: number): { toolCalls: AiMessage; toolOutput: AiMessage } {
  const toolCallId = `tc_${i}`;

  return {
    toolCalls: {
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
            function: {
              name: 'workspace_read',
              arguments: JSON.stringify({ document_id: `doc_${i}` }),
            },
          },
        ],
      },
    },
    toolOutput: {
      id: `t_out_${i}`,
      role: 'tool',
      type: 'tool_output',
      content: `output_${i}`,
      timestamp: 1000 + i * 10 + 1,
      metadata: { tool_call_id: toolCallId, tool_name: 'workspace_read' },
    },
  };
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
          function: {
            name: 'resource_list',
            arguments: JSON.stringify({ source: 'workspace' }),
          },
        },
        {
          id: `${id}_2`,
          type: 'function',
          function: {
            name: 'resource_read',
            arguments: JSON.stringify({ uri: 'kb://doc-1' }),
          },
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

function makeProviderContext(): ProviderContext {
  return {
    totalBudget: 100000,
    config: AGENT_CONTEXT_BUILDER_CONFIG,
    debugMode: false,
    estimateTokens: () => 1,
  };
}

function buildStates(messages: AiMessage[]): MessageProcessingState[] {
  return messages.map((message, index) => ({
    message,
    originalIndex: index,
    action: 'skip',
    tokens: 1,
  }));
}

describe('AgentWorkingMemoryProvider tool limits', () => {
  it('keeps current-turn raw tool pairs and caps historical compressed groups at config limit', async () => {
    const provider = new AgentWorkingMemoryProvider();
    const compressed = Array.from(
      { length: AGENT_CONTEXT_BUILDER_CONFIG.MAX_TOOL_INTERACTION_GROUPS_TO_KEEP + 1 },
      (_, idx) => makeCompressedToolHistory(idx + 1),
    );
    const rawPairs = [makeToolPair(1), makeToolPair(2)];
    const userInput: AiMessage = {
      id: 'user_input_1',
      role: 'user',
      type: 'user_input',
      content: '用户输入',
      timestamp: 600,
      metadata: {},
    };

    const states = buildStates([
      ...compressed,
      userInput,
      rawPairs[0].toolCalls,
      rawPairs[0].toolOutput,
      rawPairs[1].toolCalls,
      rawPairs[1].toolOutput,
    ]);

    const result = await provider.provide(states, 100000, makeProviderContext());
    const kept = result.states
      .filter((state) => state.action === 'keep_working_memory')
      .map((state) => state.message.id);

    expect(kept).toEqual(expect.arrayContaining(['a_tc_1', 't_out_1', 'a_tc_2', 't_out_2']));

    const keptCompressed = kept.filter((id) => id.startsWith('c_tool_'));
    expect(keptCompressed).toHaveLength(
      AGENT_CONTEXT_BUILDER_CONFIG.MAX_TOOL_INTERACTION_GROUPS_TO_KEEP,
    );
    expect(keptCompressed).toEqual(
      expect.arrayContaining(
        Array.from(
          { length: AGENT_CONTEXT_BUILDER_CONFIG.MAX_TOOL_INTERACTION_GROUPS_TO_KEEP },
          (_, idx) => `c_tool_${idx + 2}`,
        ),
      ),
    );
  });

  it('treats a multi-tool current-turn group as one preserved raw interaction group', async () => {
    const provider = new AgentWorkingMemoryProvider();
    const compressed = Array.from(
      { length: AGENT_CONTEXT_BUILDER_CONFIG.MAX_TOOL_INTERACTION_GROUPS_TO_KEEP + 1 },
      (_, idx) => makeCompressedToolHistory(idx + 1),
    );
    const multiToolGroup = makeMultiToolGroup('multi_group');
    const userInput: AiMessage = {
      id: 'user_input_1',
      role: 'user',
      type: 'user_input',
      content: '用户输入',
      timestamp: 600,
      metadata: {},
    };

    const states = buildStates([
      ...compressed,
      userInput,
      multiToolGroup.toolCalls,
      ...multiToolGroup.outputs,
    ]);

    const result = await provider.provide(states, 100000, makeProviderContext());
    const kept = result.states
      .filter((state) => state.action === 'keep_working_memory')
      .map((state) => state.message.id);

    expect(kept).toEqual(
      expect.arrayContaining(['a_multi_group', 't_multi_group_1', 't_multi_group_2']),
    );
    expect(kept.filter((id) => id.startsWith('c_tool_'))).toHaveLength(
      AGENT_CONTEXT_BUILDER_CONFIG.MAX_TOOL_INTERACTION_GROUPS_TO_KEEP,
    );
  });
});
