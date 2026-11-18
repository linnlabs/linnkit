import { describe, expect, it } from 'vitest';

import type { AiMessage, RuntimeEvent } from '../../contracts';
import { projectRuntimeEventToAiMessage } from '../../runtime-kernel/events/runtime-to-ai-message';
import { createFenceRegistry } from '../shared/fences';
import { FenceLifetimePreprocessor } from '../shared/preprocessors/fenceLifetimeManager';
import { CurrentTurnMessageAssembler } from '../shared/preprocessors/currentTurnMessageAssembler';
import { messageFormatter } from '../shared/MessageFormatter';
import { convertAiMessageToEvent } from '../profiles/agent/utils/eventConverter';
import { BaseAgentTask } from '../profiles/agent/tasks/BaseAgentTask';
import type { AgentProfileRequest } from '../profiles/agent/contracts';

class TestAgentTask extends BaseAgentTask {
  readonly name = 'steer-test-task';
  protected getSystemPrompt(_request: AgentProfileRequest): string {
    return 'system prompt';
  }
}

const registry = createFenceRegistry([
  {
    kind: 'page-context',
    llmRole: 'user',
    placement: 'before-current-user',
    lifetime: 'turn-only',
    formatter: content => `<page>${content}</page>`,
  },
]);

function steerEvent(): RuntimeEvent {
  return {
    id: 'steer_1',
    type: 'user_input',
    conversation_id: 'conv',
    turn_id: 'turn',
    timestamp: 5,
    version: 1,
    content: '别改那个文件',
    source: 'user',
    delivery: 'mid_run',
  };
}

/** 一次运行：起点消息 → 工具调用与结果 → 插话。 */
function runHistory(): AiMessage[] {
  const steer = projectRuntimeEventToAiMessage(steerEvent());
  if (!steer) throw new Error('steer was not projected');
  return [
    { id: 'start', role: 'user', type: 'user_input', content: '整理这篇文档', timestamp: 1 },
    {
      id: 'calls', role: 'assistant', type: 'tool_calls', content: '', timestamp: 2,
      metadata: { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    },
    {
      id: 'out', role: 'tool', type: 'tool_output', content: 'file body', timestamp: 3,
      metadata: { tool_call_id: 'call_1', tool_name: 'read' },
    },
    steer,
  ];
}

describe('运行中插话在上下文里的形态', () => {
  it('mid_run 的 user_input 投影为 user_steer，转回事件时保留字段', () => {
    const steer = projectRuntimeEventToAiMessage(steerEvent());
    expect(steer).toMatchObject({ id: 'steer_1', role: 'user', type: 'user_steer', content: '别改那个文件' });
    const back = convertAiMessageToEvent(steer!, { conversation_id: 'conv', turn_id: 'turn' });
    expect(back).toMatchObject({ type: 'user_input', delivery: 'mid_run', content: '别改那个文件' });

    const plain = projectRuntimeEventToAiMessage({ ...steerEvent(), delivery: undefined });
    expect(plain).toMatchObject({ type: 'user_input' });
  });

  it('插话之后，本次运行的 turn-only 注入仍在，且仍合进起点消息', async () => {
    const built = new TestAgentTask({ fenceRegistry: registry }).buildMessages({
      query: '整理这篇文档',
      promptKey: 'default',
      currentUserEventId: 'start',
      fences: [{ kind: 'page-context', content: 'doc-42' }],
    }, runHistory());

    // 与 AgentMessageOrchestrator 相同的顺序：先合并当前轮注入，再清理过期注入。
    const assembled = await new CurrentTurnMessageAssembler({ fenceRegistry: registry }).process(built, {});
    const cleaned = await new FenceLifetimePreprocessor({ fenceRegistry: registry }).process(assembled.messages, {});
    const start = cleaned.messages.find(message => message.id === 'start');
    const steer = cleaned.messages.find(message => message.id === 'steer_1');
    expect(start?.content).toContain('doc-42');
    expect(steer?.content).toBe('别改那个文件');
    expect(cleaned.messages.map(message => message.id).slice(-1)).toEqual(['steer_1']);
  });

  it('发给模型时是紧跟在工具结果之后的普通用户消息', () => {
    const formatted = messageFormatter.format(runHistory(), { nativeTools: true });
    expect(formatted.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(formatted.at(-1)).toEqual({ role: 'user', content: '别改那个文件' });
  });
});
