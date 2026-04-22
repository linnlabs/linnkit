import { beforeEach, describe, expect, it, vi } from 'vitest';

const { agentToRuntimeMock, generateMessageIdMock } = vi.hoisted(() => ({
  agentToRuntimeMock: vi.fn((evt: Record<string, unknown>, context: Record<string, unknown>) => ({
    type: evt.type,
    id: evt.id,
    conversation_id: context.conversationId,
    turn_id: context.turnId,
    timestamp: context.timestamp,
    metadata: context.metadata,
  })),
  generateMessageIdMock: vi.fn(),
}));

vi.mock('../../../events/eventMappers', () => ({
  eventMapper: {
    agentToRuntime: agentToRuntimeMock,
  },
}));

vi.mock('src/agent/shared/ids', () => ({
  generateMessageId: generateMessageIdMock,
}));

import { ToolNodeEventBridge } from '../toolNode.eventBridge';

describe('ToolNodeEventBridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateMessageIdMock
      .mockReturnValueOnce('evt_1')
      .mockReturnValueOnce('evt_2')
      .mockReturnValueOnce('evt_3');
  });

  it('应发出 tool_process 并缓冲 RuntimeEvent', () => {
    const sseSink = vi.fn();
    const bridge = new ToolNodeEventBridge({
      sseSink,
      conversationId: 'conv_test',
      turnId: 'turn_test',
      toolName: 'search',
      toolCallId: 'call_1',
      toolArgs: { query: 'hello' },
      displayOptions: { viewType: 'card' },
      idempotencyKey: 'idem_1',
    });

    bridge.emitToolProcess('start', 'loading', { args: { query: 'hello' } });

    expect(sseSink).toHaveBeenCalledTimes(1);
    expect(agentToRuntimeMock).toHaveBeenCalledTimes(1);
    expect(bridge.getRuntimeEvents()).toHaveLength(1);
    expect(bridge.getRuntimeEvents()[0]?.metadata).toEqual({ idempotency: { key: 'idem_1' } });
  });

  it('应发出 tool_output 与 final_answer，并给 SSE 事件打标', () => {
    const captured: unknown[] = [];
    const sseSink = vi.fn((evt: unknown) => {
      captured.push(evt);
    });
    const bridge = new ToolNodeEventBridge({
      sseSink,
      conversationId: 'conv_test',
      turnId: 'turn_test',
      toolName: 'write_report',
      toolCallId: 'call_2',
      toolArgs: {},
      displayOptions: {},
    });

    bridge.emitToolOutput('success', { output: { ok: true } });
    bridge.emitFinalAnswer({ answer: 'done', sourceToolName: 'write_report' });

    expect(bridge.getRuntimeEvents()).toHaveLength(2);
    expect(captured).toHaveLength(2);
    const marker = Object.getOwnPropertyDescriptor(captured[0] as object, '__dispatched_via_sse__');
    expect(marker?.value).toBe(true);
    expect(marker?.enumerable).toBe(false);
  });

  it('sseSink 抛错时不应影响 runtime 缓冲', () => {
    const bridge = new ToolNodeEventBridge({
      sseSink: vi.fn(() => {
        throw new Error('SSE boom');
      }),
      conversationId: 'conv_test',
      turnId: 'turn_test',
      toolName: 'search',
      toolCallId: 'call_3',
      toolArgs: {},
      displayOptions: {},
    });

    expect(() => {
      bridge.emitToolProcess('start', 'loading', {});
    }).not.toThrow();
    expect(bridge.getRuntimeEvents()).toHaveLength(1);
  });
});
