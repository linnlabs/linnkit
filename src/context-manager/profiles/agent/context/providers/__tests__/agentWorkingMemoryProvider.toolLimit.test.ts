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

function makeTextMessage(id: string, role: 'user' | 'assistant', type: AiMessage['type'], content: string): AiMessage {
  return {
    id,
    role,
    type,
    content,
    timestamp: 9000,
  } as AiMessage;
}

function makeProviderContext(): ProviderContext {
  return {
    totalBudget: 100000,
    config: AGENT_CONTEXT_BUILDER_CONFIG,
    debugMode: false,
    estimateTokens: () => 1,
  };
}

function makeProviderContextWithPhase(phase: string): ProviderContext & { currentPhase: { phase: string } } {
  return {
    ...makeProviderContext(),
    currentPhase: { phase },
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
  it('uses total input budget for working memory percentage after core messages are kept', async () => {
    const provider = new AgentWorkingMemoryProvider();
    const coreMessage = makeTextMessage('core_user', 'user', 'user_input', '当前用户输入');
    const followupMessage = makeTextMessage('assistant_text', 'assistant', 'final_answer', '可保留的历史回答');
    const states: MessageProcessingState[] = [
      {
        message: coreMessage,
        originalIndex: 0,
        action: 'keep_core',
        tokens: 600,
      },
      {
        message: followupMessage,
        originalIndex: 1,
        action: 'skip',
        tokens: 50,
      },
    ];

    const result = await provider.provide(states, 400, {
      ...makeProviderContext(),
      totalBudget: 1000,
    });

    expect(result.states.find((state) => state.message.id === 'assistant_text')?.action).toBe(
      'keep_working_memory',
    );
  });

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

  it('honors constructor customConfig instead of hardcoding AGENT_CONTEXT_BUILDER_CONFIG', async () => {
    const provider = new AgentWorkingMemoryProvider({
      MAX_TOOL_INTERACTION_GROUPS_TO_KEEP: 2,
      MAX_RECENT_TOOL_INTERACTIONS_TO_KEEP: 2,
    });
    const compressed = Array.from({ length: 5 }, (_, idx) => makeCompressedToolHistory(idx + 1));
    const userInput: AiMessage = {
      id: 'user_input_1',
      role: 'user',
      type: 'user_input',
      content: '用户输入',
      timestamp: 600,
      metadata: {},
    };

    const states = buildStates([...compressed, userInput]);

    const result = await provider.provide(states, 100000, makeProviderContext());
    const keptCompressed = result.states
      .filter((state) => state.action === 'keep_working_memory')
      .map((state) => state.message.id)
      .filter((id) => id.startsWith('c_tool_'));

    expect(keptCompressed).toHaveLength(2);
    expect(keptCompressed).toEqual(['c_tool_4', 'c_tool_5']);
  });

  it('prioritizes the latest complete tool group during post_tool_call phase', async () => {
    const provider = new AgentWorkingMemoryProvider({
      MAX_RECENT_TOOL_INTERACTIONS_TO_KEEP: 0,
      MAX_TOOL_INTERACTION_GROUPS_TO_KEEP: 0,
    });
    const oldPair = makeToolPair(1);
    const latestPair = makeToolPair(2);
    const states = buildStates([
      makeTextMessage('user_1', 'user', 'user_input', '用户输入'),
      oldPair.toolCalls,
      oldPair.toolOutput,
      latestPair.toolCalls,
      latestPair.toolOutput,
    ]);

    const result = await provider.provide(states, 100000, makeProviderContextWithPhase('post_tool_call'));
    const kept = result.states
      .filter((state) => state.action === 'keep_working_memory')
      .map((state) => state.message.id);

    expect(result.strategiesApplied).toContain('post_tool_call_priority');
    expect(kept).toEqual(expect.arrayContaining(['a_tc_2', 't_out_2']));
  });

  it('keeps only the configured number of latest thought messages', async () => {
    const provider = new AgentWorkingMemoryProvider({ MAX_THOUGHTS_TO_KEEP: 2 });
    const states = buildStates([
      makeTextMessage('thought_1', 'assistant', 'thought', '第一段思考'),
      makeTextMessage('thought_2', 'assistant', 'thought', '第二段思考'),
      makeTextMessage('thought_3', 'assistant', 'thought', '第三段思考'),
      makeTextMessage('assistant_text', 'assistant', 'final_answer', '普通回复'),
    ]);

    const result = await provider.provide(states, 100000, makeProviderContext());
    const keptThoughts = result.states
      .filter((state) => state.action === 'keep_working_memory' && state.message.type === 'thought')
      .map((state) => state.message.id);

    expect(keptThoughts).toEqual(['thought_2', 'thought_3']);
    expect(result.strategiesApplied.filter((strategy) => strategy === 'thought_processing')).toHaveLength(2);
  });

  it('keeps configured minimum tool groups even when working-memory budget is exhausted', async () => {
    const provider = new AgentWorkingMemoryProvider({
      MIN_TOOL_INTERACTIONS_TO_KEEP: 1,
      MAX_RECENT_TOOL_INTERACTIONS_TO_KEEP: 1,
      MAX_TOOL_INTERACTION_GROUPS_TO_KEEP: 1,
    });
    const pair = makeToolPair(1);
    const states = buildStates([
      pair.toolCalls,
      pair.toolOutput,
      makeTextMessage('user_1', 'user', 'user_input', '继续'),
    ]);

    const result = await provider.provide(states, 1, makeProviderContext());
    const kept = result.states
      .filter((state) => state.action === 'keep_working_memory')
      .map((state) => state.message.id);

    expect(kept).toEqual(expect.arrayContaining(['a_tc_1', 't_out_1']));
  });

  it('honors toolPairingSearchRange when matching tool outputs', async () => {
    const pair = makeToolPair(1);
    const farMessages = [
      pair.toolCalls,
      makeTextMessage('assistant_gap', 'assistant', 'final_answer', '间隔消息'),
      pair.toolOutput,
    ];
    const narrowProvider = new AgentWorkingMemoryProvider({
      TOOL_PAIRING_SEARCH_RANGE: 1,
      MIN_TOOL_INTERACTIONS_TO_KEEP: 0,
      MAX_RECENT_TOOL_INTERACTIONS_TO_KEEP: 1,
      MAX_TOOL_INTERACTION_GROUPS_TO_KEEP: 1,
    });

    const narrowResult = await narrowProvider.provide(buildStates(farMessages), 100000, makeProviderContext());
    const narrowKept = narrowResult.states
      .filter((state) => state.action === 'keep_working_memory')
      .map((state) => state.message.id);

    expect(narrowKept).not.toContain('a_tc_1');
    expect(narrowKept).not.toContain('t_out_1');

    const wideProvider = new AgentWorkingMemoryProvider({
      TOOL_PAIRING_SEARCH_RANGE: 2,
      MIN_TOOL_INTERACTIONS_TO_KEEP: 0,
      MAX_RECENT_TOOL_INTERACTIONS_TO_KEEP: 1,
      MAX_TOOL_INTERACTION_GROUPS_TO_KEEP: 1,
    });

    const wideResult = await wideProvider.provide(buildStates(farMessages), 100000, makeProviderContext());
    const wideKept = wideResult.states
      .filter((state) => state.action === 'keep_working_memory')
      .map((state) => state.message.id);

    expect(wideKept).toEqual(expect.arrayContaining(['a_tc_1', 't_out_1']));
  });

  it('keeps plain text conversation messages when budget allows', async () => {
    const provider = new AgentWorkingMemoryProvider();
    const states = buildStates([
      makeTextMessage('user_old', 'user', 'user_input', '旧问题'),
      makeTextMessage('assistant_old', 'assistant', 'final_answer', '旧回答'),
      makeTextMessage('user_new', 'user', 'user_input', '新问题'),
    ]);

    const result = await provider.provide(states, 100000, makeProviderContext());
    const kept = result.states
      .filter((state) => state.action === 'keep_working_memory')
      .map((state) => state.message.id);

    expect(kept).toEqual(expect.arrayContaining(['user_old', 'assistant_old', 'user_new']));
    expect(result.strategiesApplied).toContain('text_conversation');
  });

  it('keeps historical raw tool groups through P3 when current-turn retention is disabled', async () => {
    const provider = new AgentWorkingMemoryProvider({
      MAX_RECENT_TOOL_INTERACTIONS_TO_KEEP: 0,
      MAX_TOOL_INTERACTION_GROUPS_TO_KEEP: 1,
    });
    const historicalPair = makeToolPair(1);
    const states = buildStates([
      historicalPair.toolCalls,
      historicalPair.toolOutput,
      makeTextMessage('user_1', 'user', 'user_input', '继续'),
    ]);

    const result = await provider.provide(states, 100000, makeProviderContext());
    const kept = result.states
      .filter((state) => state.action === 'keep_working_memory')
      .map((state) => state.message.id);

    expect(result.strategiesApplied).toContain('historical_tool_interaction');
    expect(kept).toEqual(expect.arrayContaining(['a_tc_1', 't_out_1']));
  });
});
