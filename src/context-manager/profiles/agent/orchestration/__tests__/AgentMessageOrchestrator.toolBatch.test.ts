import { describe, expect, it } from 'vitest';
import {
  ToolCallIdSchema,
  ToolCallsMeta,
  type RuntimeEvent,
} from '../../../../../contracts';
import { formatAgentLlmMessages } from '../../../../shared';
import {
  AgentCoreContextProvider,
  AgentWorkingMemoryProvider,
  ContextProviderRegistry,
} from '../../context/providers';
import type { IAgentTask } from '../../tasks/base';
import { ToolManager } from '../../tools/ToolManager';
import { AgentMessageOrchestrator } from '../AgentMessageOrchestrator';

const task: IAgentTask = {
  name: 'tool-batch-feedback',
  // 同一 user turn 的每次模型调用都复用真实历史，不能额外插入 user 来改变配对边界。
  buildMessages: (_request, history) => history,
  processResponse: response => response,
  processStreamChunk: chunk => chunk,
};

const toolManager = new ToolManager({
  getTool: () => undefined,
  getAvailableToolNames: () => ['record_update'],
  validateToolCall: () => ({ success: true }),
});

function createOrchestrator(maxTokens = 100_000): AgentMessageOrchestrator {
  const providerRegistry = new ContextProviderRegistry();
  providerRegistry.register(new AgentCoreContextProvider());
  providerRegistry.register(new AgentWorkingMemoryProvider());
  return new AgentMessageOrchestrator({
    tokenBudget: { maxTokens, reservedForResponse: 10 },
    processing: { debugMode: false },
    taskResolver: () => task,
    providerRegistry,
    tokenizer: { estimateText: () => 10, estimateMessage: () => 10 },
  });
}

function userInput(): RuntimeEvent {
  return {
    id: 'user',
    type: 'user_input',
    conversation_id: 'conversation-batch',
    turn_id: 'turn-batch',
    timestamp: 1,
    version: 1,
    content: 'Update the records and inspect every result.',
    source: 'user',
  };
}

function batch(
  index: number,
  size: number,
  outcome: 'success' | 'error' | 'mixed' = 'success',
): RuntimeEvent[] {
  const calls = Array.from({ length: size }, (_, item) => ({
    id: ToolCallIdSchema.parse(`batch-${index}-call-${item}`),
    type: 'function' as const,
    // 新 call_id 可以再次请求相同参数；上下文必须保留每次实际回执，不能按参数去重。
    function: { name: 'record_update', arguments: JSON.stringify({ record: item, value: 'updated' }) },
  }));
  const base: Pick<RuntimeEvent, 'conversation_id' | 'turn_id' | 'version'> = {
    conversation_id: 'conversation-batch',
    turn_id: 'turn-batch',
    version: 1,
  };
  return [
    {
      ...base,
      id: `batch-${index}`,
      type: 'tool_call_decision',
      timestamp: index * 1000 + 2,
      tool_name: 'record_update',
      tool_call_id: calls[0].id,
      phase: 'start',
      status: 'loading',
      payload: { tool_calls: calls },
    },
    ...calls.map((call, item): RuntimeEvent => {
      const failed = outcome === 'error' || (outcome === 'mixed' && item % 2 === 1);
      const observation = failed
        ? `batch ${index}, record ${item}: PRECONDITION_FAILED; current value is already updated`
        : `batch ${index}, record ${item}: applied; before=original, after=updated`;
      return {
        ...base,
        id: `result-${index}-${item}`,
        type: 'tool_output',
        timestamp: index * 1000 + item + 3,
        tool_name: 'record_update',
        tool_call_id: call.id,
        ...(failed
          ? { status: 'error', observation, error: 'PRECONDITION_FAILED' }
          : { status: 'success', observation, data: { before: 'original', after: 'updated' } }),
      };
    }),
  ];
}

function expectCanonicalFeedback(
  messages: Parameters<typeof formatAgentLlmMessages>[0],
  history: RuntimeEvent[],
): void {
  const canonical = formatAgentLlmMessages(messages);
  const expected: ReturnType<typeof formatAgentLlmMessages> = [];
  for (const event of history) {
    if (event.type === 'tool_call_decision') {
      expected.push({ role: 'assistant', content: null, tool_calls: ToolCallsMeta.parse(event.payload).tool_calls });
    } else if (event.type === 'tool_output') {
      expected.push({ role: 'tool', tool_call_id: event.tool_call_id, content: event.observation });
    }
  }
  expect(canonical.filter(message => message.role === 'assistant' || message.role === 'tool'))
    .toEqual(expected);
}

describe('AgentMessageOrchestrator tool batch feedback', () => {
  it.each([4, 10, 11, 12, 128])('replays all %i results through the normal canonical build', async size => {
    const history = [userInput(), ...batch(0, size)];
    const result = await createOrchestrator().processAgentConversation(
      { promptKey: 'default', query: 'Continue.' }, history, toolManager,
    );
    expectCanonicalFeedback(result.messages, history);
  });

  it('keeps successful, repeatedly failed and mixed batches visible on every next build', async () => {
    const history = [userInput()];
    const orchestrator = createOrchestrator();
    const outcomes = ['success', 'error', 'error', 'error', 'error', 'mixed'] as const;
    for (const [index, outcome] of outcomes.entries()) {
      history.push(...batch(index, 12, outcome));
      const result = await orchestrator.processAgentConversation(
        { promptKey: 'default', query: 'Continue.' }, history, toolManager,
      );
      expectCanonicalFeedback(result.messages, history);
    }
  });

  it('omits a genuinely incomplete batch without losing an adjacent complete batch', async () => {
    const incomplete = batch(0, 12).slice(0, -1);
    const complete = batch(1, 12, 'mixed');
    const history = [userInput(), ...incomplete, ...complete];
    const result = await createOrchestrator().processAgentConversation(
      { promptKey: 'default', query: 'Continue.' }, history, toolManager,
    );
    expectCanonicalFeedback(result.messages, complete);
  });

  it('reports budget overflow while keeping the protected batch atomic', async () => {
    const history = [userInput(), ...batch(0, 12)];
    const result = await createOrchestrator(100).processAgentConversation(
      { promptKey: 'default', query: 'Continue.' }, history, toolManager,
    );
    expectCanonicalFeedback(result.messages, history);
    // 后续 Graph capacity admission 决定压缩或拒绝调用；不能靠遗漏回执伪装满足预算。
    expect(result.contextBuildResult.tokenUsage.remaining).toBeLessThan(0);
  });
});
