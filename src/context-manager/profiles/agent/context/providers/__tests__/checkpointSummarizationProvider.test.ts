/**
 * @file CheckpointSummarizationProvider 单元测试
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { CheckpointSummarizationProvider } from '../CheckpointSummarizationProvider';
import type { MessageProcessingState, ProviderContext } from '../base';
import { CHECKPOINT_MARKER_TYPE } from '../../../../../shared/checkpointMarker';
import type { AiMessage } from '../../../../../../contracts';

/** 生成唯一 ID */
let idCounter = 0;
function makeId(): string {
  return `msg_${++idCounter}`;
}

/** 生成 tool_call_id（与 message.id 分离，避免语义混淆） */
function makeToolCallId(): string {
  return `call_${++idCounter}`;
}

/** 创建模拟 AiMessage */
function makeMsg(overrides: Partial<AiMessage> & { role: string; type?: string }): AiMessage {
  return {
    id: makeId(),
    timestamp: Date.now(),
    content: '',
    ...overrides,
  } as AiMessage;
}

function makeToolPair(toolName: string, toolOutputContent: string): { call: AiMessage; out: AiMessage; toolCallId: string } {
  const toolCallId = makeToolCallId();
  const call = makeMsg({
    role: 'assistant',
    type: 'tool_calls',
    content: `call ${toolName}`,
    metadata: {
      tool_calls: [
        {
          id: toolCallId,
          type: 'function',
          function: { name: toolName, arguments: '{}' },
        },
      ],
    },
  });
  const out = makeMsg({
    role: 'tool',
    type: 'tool_output',
    content: toolOutputContent,
    metadata: { tool_call_id: toolCallId, tool_name: toolName },
  });
  return { call, out, toolCallId };
}

/** 创建 MessageProcessingState */
function makeState(msg: AiMessage, action: MessageProcessingState['action'] = 'keep_working_memory'): MessageProcessingState {
  return {
    message: msg,
    originalIndex: 0,
    action,
    tokens: 100,
  };
}

/** 创建包含 checkpoint 标记的 tool_output content */
function makeCheckpointContent(summary: string): string {
  return JSON.stringify({
    data: {
      _type: CHECKPOINT_MARKER_TYPE,
      summary,
    },
    observation: 'Context checkpoint created.',
  });
}

/** 最小化 ProviderContext */
function makeProviderContext(): ProviderContext {
  return {
    totalBudget: 100000,
    config: {} as ProviderContext['config'],
    debugMode: false,
    estimateTokens: () => 100,
  };
}

describe('CheckpointSummarizationProvider', () => {
  const provider = new CheckpointSummarizationProvider();

  beforeEach(() => {
    idCounter = 0;
  });

  it('没有 checkpoint 标记时直接透传', async () => {
    const tool1 = makeToolPair('tool_1', 'tool_1 result');
    const states: MessageProcessingState[] = [
      makeState(makeMsg({ role: 'system', content: 'system prompt' }), 'keep_core'),
      makeState(makeMsg({ role: 'user', content: 'hello' })),
      makeState(tool1.call),
      makeState(tool1.out),
    ];

    const result = await provider.provide(states, 100000, makeProviderContext());

    expect(result.states).toBe(states);
    expect(result.strategiesApplied).toHaveLength(0);
    expect(result.events).toBeUndefined();
  });

  it('检测到 checkpoint 时保留 checkpoint 工具对，并裁剪 checkpoint 之前的旧历史', async () => {
    const tool1 = makeToolPair('tool_1', 'tool_1 result');
    const tool2 = makeToolPair('tool_2', 'tool_2 result');
    const tool3 = makeToolPair('tool_3', 'tool_3 result');
    const tool4 = makeToolPair('tool_4', 'tool_4 result');
    const checkpoint = makeToolPair('context_checkpoint', 'Context checkpoint created.');

    // checkpoint tool_output 必须携带 raw_output marker（严格协议）
    checkpoint.out.metadata = {
      ...(checkpoint.out.metadata ?? {}),
      raw_output: makeCheckpointContent('Phase A done. Next: Phase B'),
    };

    // 构建 10 条消息 + 1 个 checkpoint
    const states: MessageProcessingState[] = [
      makeState(makeMsg({ role: 'system', content: 'system prompt' }), 'keep_core'),
      // 旧对话
      makeState(makeMsg({ role: 'user', content: 'task A' })),
      makeState(tool1.call),
      makeState(tool1.out),
      makeState(tool2.call),
      makeState(tool2.out),
      // 最近 2 轮工具交互（应被保留）
      makeState(tool3.call),
      makeState(tool3.out),
      makeState(tool4.call),
      makeState(tool4.out),
      // checkpoint 工具调用
      makeState(checkpoint.call),
      makeState(checkpoint.out),
    ];

    const result = await provider.provide(states, 100000, makeProviderContext());

    // 应用了裁剪策略（不再生成任何摘要事件）
    expect(result.strategiesApplied).toContain('checkpoint_trim_before');
    expect(result.events).toBeUndefined();

    // 验证保留了 system_prompt
    const hasSystem = result.states.some((s) => s.message.role === 'system' && s.message.content === 'system prompt');
    expect(hasSystem).toBe(true);

    // 验证保留了最近 2 轮工具交互（tool_3 和 tool_4）
    const toolOutputContents = result.states
      .filter((s) => s.message.type === 'tool_output')
      .map((s) => s.message.content);
    expect(toolOutputContents).toContain('tool_3 result');
    expect(toolOutputContents).toContain('tool_4 result');

    // checkpoint 本身的 tool_output 必须保留在最终结果中（作为正常工具消息）
    const hasCheckpointToolOutput = result.states.some((s) => {
      if (s.message.type !== 'tool_output') return false;
      const meta = s.message.metadata as Record<string, unknown> | undefined;
      const raw = meta?.['raw_output'];
      return typeof raw === 'string' && raw.includes(CHECKPOINT_MARKER_TYPE);
    });
    expect(hasCheckpointToolOutput).toBe(true);

    // 不应新增 history_summary 消息
    const hasSummaryMessage = result.states.some((s) => s.message.type === 'history_summary');
    expect(hasSummaryMessage).toBe(false);
  });

  it('旧 history_summary 会被裁剪为 skip', async () => {
    const tool1 = makeToolPair('tool_1', 'tool_1 result');
    const checkpoint = makeToolPair('context_checkpoint', 'Context checkpoint created.');
    checkpoint.out.metadata = {
      ...(checkpoint.out.metadata ?? {}),
      raw_output: makeCheckpointContent('Summary after old summary'),
    };
    const states: MessageProcessingState[] = [
      makeState(makeMsg({ role: 'system', content: 'system prompt' }), 'keep_core'),
      // 旧摘要
      makeState(makeMsg({ role: 'system', type: 'history_summary', content: '[旧摘要]' })),
      // 工具交互
      makeState(tool1.call),
      makeState(tool1.out),
      // checkpoint
      makeState(checkpoint.call),
      makeState(checkpoint.out),
    ];

    const result = await provider.provide(states, 100000, makeProviderContext());
    expect(result.strategiesApplied).toContain('checkpoint_trim_before');
    expect(result.events).toBeUndefined();

    // 裁剪发生后，旧 history_summary 必须被降级为 skip（不会进入最终 LLM messages）
    const summaryStates = result.states.filter((s) => s.message.type === 'history_summary');
    expect(summaryStates.length).toBe(1);
    expect(summaryStates[0].action).toBe('skip');
  });

  it('只有 system_prompt 和 checkpoint 时也能正常工作（无可裁剪时直接透传）', async () => {
    const checkpoint = makeToolPair('context_checkpoint', 'Context checkpoint created.');
    checkpoint.out.metadata = {
      ...(checkpoint.out.metadata ?? {}),
      raw_output: makeCheckpointContent('Quick summary'),
    };
    const states: MessageProcessingState[] = [
      makeState(makeMsg({ role: 'system', content: 'system prompt' }), 'keep_core'),
      makeState(checkpoint.call),
      makeState(checkpoint.out),
    ];

    const result = await provider.provide(states, 100000, makeProviderContext());
    // 没有可清理历史时：不会触发裁剪
    expect(result.strategiesApplied).toHaveLength(0);
    expect(result.events).toBeUndefined();
    // 不应新增 summary 消息
    expect(result.states.some((s) => s.message.type === 'history_summary')).toBe(false);
    expect(result.states.some((s) => s.message.role === 'system' && s.message.type !== 'history_summary')).toBe(true);
  });

  it('content 为 observation 文本时，可从 metadata.raw_output 识别 checkpoint', async () => {
    const tool1 = makeToolPair('tool_1', 'tool_1 result');
    const checkpoint = makeToolPair('context_checkpoint', '✅ Context checkpoint created. On the next processing cycle, conversation history will be cleaned.');
    checkpoint.out.metadata = {
      ...(checkpoint.out.metadata ?? {}),
      raw_output: makeCheckpointContent('Summary from raw_output marker'),
    };
    const states: MessageProcessingState[] = [
      makeState(makeMsg({ role: 'system', content: 'system prompt' }), 'keep_core'),
      makeState(tool1.call),
      makeState(tool1.out),
      makeState(checkpoint.call),
      makeState(checkpoint.out),
      makeState(makeMsg({ role: 'user', content: 'next question' }), 'keep_core'),
    ];

    const result = await provider.provide(states, 100000, makeProviderContext());

    // tool_1 属于“checkpoint 前最近 N 对工具交互”，因此无可清理历史，不触发 purge
    expect(result.strategiesApplied).toHaveLength(0);
    expect(result.events).toBeUndefined();
  });

  it('raw_output 缺失时，即使 content 是 checkpoint JSON 也不触发（严格协议）', async () => {
    const checkpoint = makeToolPair('context_checkpoint', makeCheckpointContent('Should not be detected without raw_output'));
    const states: MessageProcessingState[] = [
      makeState(makeMsg({ role: 'system', content: 'system prompt' }), 'keep_core'),
      makeState(checkpoint.call),
      makeState(checkpoint.out),
    ];

    const result = await provider.provide(states, 100000, makeProviderContext());
    expect(result.strategiesApplied).toHaveLength(0);
    expect(result.events).toBeUndefined();
  });

  it('会将 checkpoint 保留的工具交互从 skip 提升为 keep_working_memory', async () => {
    const tool1 = makeToolPair('tool_1', 'tool_1 result');
    const tool2 = makeToolPair('tool_2', 'tool_2 result');
    const checkpoint = makeToolPair('context_checkpoint', 'Context checkpoint created.');
    checkpoint.out.metadata = {
      ...(checkpoint.out.metadata ?? {}),
      raw_output: makeCheckpointContent('Checkpoint summary'),
    };
    const states: MessageProcessingState[] = [
      makeState(makeMsg({ role: 'system', content: 'system prompt' }), 'keep_core'),
      makeState(tool1.call, 'skip'),
      makeState(tool1.out, 'skip'),
      makeState(tool2.call, 'skip'),
      makeState(tool2.out, 'skip'),
      makeState(checkpoint.call, 'skip'),
      makeState(checkpoint.out, 'skip'),
    ];

    const result = await provider.provide(states, 100000, makeProviderContext());
    // tool_1/tool_2 属于“checkpoint 前最近 N 对工具交互”，因此无可清理历史，不触发 purge
    // 但仍应提升 keepSet 中的工具对到 keep_working_memory
    expect(result.strategiesApplied).toHaveLength(0);

    const keptTool1Call = result.states.find((s) => s.message.content === 'call tool_1');
    const keptTool1Out = result.states.find((s) => s.message.content === 'tool_1 result');
    const keptTool2Call = result.states.find((s) => s.message.content === 'call tool_2');
    const keptTool2Out = result.states.find((s) => s.message.content === 'tool_2 result');

    expect(keptTool1Call?.action).toBe('keep_working_memory');
    expect(keptTool1Out?.action).toBe('keep_working_memory');
    expect(keptTool2Call?.action).toBe('keep_working_memory');
    expect(keptTool2Out?.action).toBe('keep_working_memory');
  });

  it('同一组中混合 checkpoint 与普通工具时，整组按 checkpoint 组保留', async () => {
    const preTool = makeToolPair('tool_before', 'tool_before result');
    const mixedToolCallId = makeToolCallId();
    const mixedAssistant = makeMsg({
      role: 'assistant',
      type: 'tool_calls',
      content: 'mixed checkpoint group',
      metadata: {
        tool_calls: [
          {
            id: mixedToolCallId,
            type: 'function',
            function: { name: 'context_checkpoint', arguments: '{}' },
          },
          {
            id: 'call_mixed_normal',
            type: 'function',
            function: { name: 'tool_normal', arguments: '{}' },
          },
        ],
      },
    });
    const mixedCheckpointOut = makeMsg({
      role: 'tool',
      type: 'tool_output',
      content: 'Context checkpoint created.',
      metadata: {
        tool_call_id: mixedToolCallId,
        tool_name: 'context_checkpoint',
        raw_output: makeCheckpointContent('Mixed checkpoint summary'),
      },
    });
    const mixedNormalOut = makeMsg({
      role: 'tool',
      type: 'tool_output',
      content: 'tool_normal result',
      metadata: {
        tool_call_id: 'call_mixed_normal',
        tool_name: 'tool_normal',
      },
    });

    const states: MessageProcessingState[] = [
      makeState(makeMsg({ role: 'system', content: 'system prompt' }), 'keep_core'),
      makeState(preTool.call, 'skip'),
      makeState(preTool.out, 'skip'),
      makeState(mixedAssistant, 'skip'),
      makeState(mixedCheckpointOut, 'skip'),
      makeState(mixedNormalOut, 'skip'),
    ];

    const result = await provider.provide(states, 100000, makeProviderContext());
    const keptMixedAssistant = result.states.find((state) => state.message.id === mixedAssistant.id);
    const keptMixedCheckpointOut = result.states.find((state) => state.message.id === mixedCheckpointOut.id);
    const keptMixedNormalOut = result.states.find((state) => state.message.id === mixedNormalOut.id);

    expect(keptMixedAssistant?.action).toBe('keep_working_memory');
    expect(keptMixedCheckpointOut?.action).toBe('keep_working_memory');
    expect(keptMixedNormalOut?.action).toBe('keep_working_memory');
  });

  it('重复 tool_calls（同 tool_call_id）时，checkpoint 必须选择最近一条配对，避免协议 400', async () => {
    // 手工构造：两条 tool_calls 复用同一个 tool_call_id，但只有第二条后面紧跟 tool_output
    const toolCallId = 'call_dup_1';
    const toolCalls1 = makeMsg({
      role: 'assistant',
      type: 'tool_calls',
      content: null as any,
      metadata: {
        tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'context_checkpoint', arguments: '{}' } }],
      },
    });
    const assistantTextBetween = makeMsg({ role: 'assistant', type: 'final_answer', content: '中间插入了一条assistant文本' });
    const toolCalls2 = makeMsg({
      role: 'assistant',
      type: 'tool_calls',
      content: null as any,
      metadata: {
        tool_calls: [{ id: toolCallId, type: 'function', function: { name: 'context_checkpoint', arguments: '{}' } }],
      },
    });
    const toolOut = makeMsg({
      role: 'tool',
      type: 'tool_output',
      content: '✅ Context checkpoint created.',
      metadata: {
        tool_call_id: toolCallId,
        tool_name: 'context_checkpoint',
        raw_output: makeCheckpointContent('dup checkpoint'),
      },
    });

    const states: MessageProcessingState[] = [
      makeState(makeMsg({ role: 'system', content: 'system prompt' }), 'keep_core'),
      // 旧历史（随便放一条，让 provider 真正执行裁剪）
      makeState(makeMsg({ role: 'user', type: 'user_input', content: 'old user' })),
      makeState(toolCalls1, 'skip'),
      makeState(assistantTextBetween, 'skip'),
      makeState(toolCalls2, 'skip'),
      makeState(toolOut, 'skip'),
      makeState(makeMsg({ role: 'user', type: 'user_input', content: 'new user' }), 'keep_core'),
    ];

    const result = await provider.provide(states, 100000, makeProviderContext());

    // 断言：只提升“最近的那条 tool_calls2”与 toolOut
    const s1 = result.states.find((s) => s.message.id === toolCalls1.id);
    const s2 = result.states.find((s) => s.message.id === toolCalls2.id);
    const out = result.states.find((s) => s.message.id === toolOut.id);
    expect(s2?.action).toBe('keep_working_memory');
    expect(out?.action).toBe('keep_working_memory');
    expect(s1?.action).toBe('skip');
  });
});
