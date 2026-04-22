/**
 * @file src/core/graph-engine/nodes/__tests__/llmNode.eventBridge.test.ts
 * @description LlmNodeEventBridge 单元测试（Phase 1.5-2b 护栏）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../events/eventMappers', () => ({
  eventMapper: {
    agentToRuntime: vi.fn((evt: Record<string, unknown>) => ({ ...evt, _mapped: true })),
  },
}));

vi.mock('src/agent/shared/ids', () => ({
  generateMessageId: vi.fn(() => 'msg_generated_test'),
}));

import { LlmNodeEventBridge, readIncomingAnswerId } from '../llmNode.eventBridge';
import type { LlmNodeEventBridgeDeps } from '../llmNode.eventBridge';
import {
  initLlmNodeState,
  llmNodeReducer,
  type LlmNodeLocalState,
  type LlmNodeAction,
} from '../llmNode.state';

/**
 * 创建带有真实 reducer 的测试环境：
 * - state 通过 reducer 管理，保证与生产行为一致
 * - sseSink 使用 vi.fn() 便于断言
 */
function createTestEnv(overrides?: {
  sseSink?: LlmNodeEventBridgeDeps['sseSink'];
  answerId?: string;
  chunkSeq?: number;
}) {
  let state = initLlmNodeState({
    answerId: overrides?.answerId,
    chunkSeq: overrides?.chunkSeq ?? 0,
  });

  const dispatched: LlmNodeAction[] = [];

  const dispatch = (action: LlmNodeAction) => {
    dispatched.push(action);
    state = llmNodeReducer(state, action);
  };

  const sseSink = overrides?.sseSink ?? vi.fn(() => []);

  const bridge = new LlmNodeEventBridge({
    getState: () => state,
    dispatch,
    sseSink,
    conversationId: 'conv_test',
    turnId: 'turn_test',
  });

  return { bridge, getState: () => state, dispatched, sseSink };
}

// ── readIncomingAnswerId ────────────────────────────────────────────────

describe('readIncomingAnswerId', () => {
  it('应返回有效的 answer_id', () => {
    expect(readIncomingAnswerId({ answer_id: 'ans_123' })).toBe('ans_123');
  });

  it('应过滤 temp_answer 占位符', () => {
    expect(readIncomingAnswerId({ answer_id: 'temp_answer' })).toBeUndefined();
  });

  it('应过滤空字符串', () => {
    expect(readIncomingAnswerId({ answer_id: '' })).toBeUndefined();
    expect(readIncomingAnswerId({ answer_id: '   ' })).toBeUndefined();
  });

  it('应过滤非字符串类型', () => {
    expect(readIncomingAnswerId({ answer_id: 123 })).toBeUndefined();
    expect(readIncomingAnswerId({ answer_id: null })).toBeUndefined();
  });

  it('应处理非对象输入', () => {
    expect(readIncomingAnswerId(null)).toBeUndefined();
    expect(readIncomingAnswerId(undefined)).toBeUndefined();
    expect(readIncomingAnswerId('string')).toBeUndefined();
  });
});

// ── handle: stream_chunk ────────────────────────────────────────────────

describe('handle: stream_chunk', () => {
  it('首次 chunk：应生成 answerId 并构建增强事件', () => {
    const { bridge, getState, sseSink } = createTestEnv();

    bridge.handle({ type: 'stream_chunk', id: 'c1', content: 'hello', timestamp: 1000 } as never);

    expect(getState().answerId).toBe('msg_generated_test');
    expect(getState().chunkSeq).toBe(1);

    expect(sseSink).toHaveBeenCalledTimes(1);
    const sseArg = (sseSink as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(sseArg.answer_id).toBe('msg_generated_test');
    expect(sseArg.seq).toBe(0);
    expect(sseArg.turn_id).toBe('turn_test');
  });

  it('上游携带 answer_id：应使用上游 answer_id', () => {
    const { bridge, getState, sseSink } = createTestEnv();

    bridge.handle({
      type: 'stream_chunk', id: 'c1', content: 'hello',
      answer_id: 'ans_upstream', timestamp: 1000,
    } as never);

    expect(getState().answerId).toBe('ans_upstream');
    const sseArg = (sseSink as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(sseArg.answer_id).toBe('ans_upstream');
  });

  it('answer_id 切换：应重置 seq', () => {
    const { bridge, sseSink } = createTestEnv({ answerId: 'ans_before', chunkSeq: 5 });

    bridge.handle({
      type: 'stream_chunk', id: 'c1', content: 'after',
      answer_id: 'ans_after', timestamp: 1000,
    } as never);

    const sseArg = (sseSink as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(sseArg.answer_id).toBe('ans_after');
    expect(sseArg.seq).toBe(0);
  });

  it('连续 chunk（同一 answerId）：seq 递增', () => {
    const { bridge, sseSink } = createTestEnv({ answerId: 'ans_1', chunkSeq: 3 });

    bridge.handle({
      type: 'stream_chunk', id: 'c1', content: '...', timestamp: 1000,
    } as never);

    const sseArg = (sseSink as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<string, unknown>;
    expect(sseArg.seq).toBe(3);
  });

  it('不应将 stream_chunk 映射为 RuntimeEvent', () => {
    const { dispatched } = createTestEnv();
    const env = createTestEnv();
    env.bridge.handle({ type: 'stream_chunk', id: 'c1', content: '...', timestamp: 1000 } as never);

    const runtimeBuffered = env.dispatched.filter((a) => a.type === 'RUNTIME_EVENT_BUFFERED');
    expect(runtimeBuffered).toHaveLength(0);
  });
});

// ── handle: final_answer ────────────────────────────────────────────────

describe('handle: final_answer', () => {
  it('已有 chunk 时应忽略（dispatch FINAL_ANSWER_IGNORED，不调用 sseSink）', () => {
    const { bridge, dispatched, sseSink } = createTestEnv({ answerId: 'ans_1', chunkSeq: 3 });

    bridge.handle({ type: 'final_answer', id: 'fa1', answer: 'done', timestamp: 1000 } as never);

    expect(dispatched.some((a) => a.type === 'FINAL_ANSWER_IGNORED')).toBe(true);
    expect(sseSink).not.toHaveBeenCalled();
  });

  it('无 chunk 时应正常处理（dispatch FINAL_ANSWER_RECEIVED + RUNTIME_EVENT_BUFFERED）', () => {
    const { bridge, dispatched, sseSink } = createTestEnv();

    bridge.handle({ type: 'final_answer', id: 'fa1', answer: 'done', timestamp: 1000 } as never);

    expect(sseSink).toHaveBeenCalledTimes(1);
    expect(dispatched.some((a) => a.type === 'RUNTIME_EVENT_BUFFERED')).toBe(true);
    expect(dispatched.some((a) => a.type === 'FINAL_ANSWER_RECEIVED')).toBe(true);
  });

  it('FINAL_ANSWER_RECEIVED 应在 RUNTIME_EVENT_BUFFERED 之后 dispatch', () => {
    const { bridge, dispatched } = createTestEnv();

    bridge.handle({ type: 'final_answer', id: 'fa1', answer: 'done', timestamp: 1000 } as never);

    const bufIdx = dispatched.findIndex((a) => a.type === 'RUNTIME_EVENT_BUFFERED');
    const recIdx = dispatched.findIndex((a) => a.type === 'FINAL_ANSWER_RECEIVED');
    expect(bufIdx).toBeGreaterThanOrEqual(0);
    expect(recIdx).toBeGreaterThan(bufIdx);
  });
});

// ── handle: 其他事件类型 ────────────────────────────────────────────────

describe('handle: 其他事件类型', () => {
  it('thought 事件：应通过 SSE 发送并缓冲为 RuntimeEvent', () => {
    const { bridge, dispatched, sseSink } = createTestEnv();

    bridge.handle({ type: 'thought', id: 'th1', content: '思考中...', timestamp: 1000 } as never);

    expect(sseSink).toHaveBeenCalledTimes(1);
    expect(dispatched.some((a) => a.type === 'RUNTIME_EVENT_BUFFERED')).toBe(true);
  });

  it('tool_call_decision 事件：应通过 SSE 发送并缓冲', () => {
    const { bridge, dispatched, sseSink } = createTestEnv();

    bridge.handle({
      type: 'tool_call_decision', id: 'tcd1', timestamp: 1000,
      tool_name: 'search', tool_args: {}, tool_call_id: 'tc1',
    } as never);

    expect(sseSink).toHaveBeenCalledTimes(1);
    expect(dispatched.some((a) => a.type === 'RUNTIME_EVENT_BUFFERED')).toBe(true);
  });
});

// ── SSE 分发与反馈 ────────────────────────────────────────────────────

describe('SSE 分发与反馈', () => {
  it('sseSink 返回事件时应 dispatch RUNTIME_EVENT_BUFFERED', () => {
    const feedbackEvent = { id: 'fb1', type: 'final_answer', timestamp: 2000, conversation_id: 'c', turn_id: 't', version: 1 };
    const sseSink = vi.fn(() => [feedbackEvent]);

    const { bridge, dispatched } = createTestEnv({ sseSink: sseSink as never });

    bridge.handle({ type: 'thought', id: 'th1', content: '...', timestamp: 1000 } as never);

    const buffered = dispatched.filter((a) => a.type === 'RUNTIME_EVENT_BUFFERED');
    // 一个来自 eventMapper（thought 本身），一个来自 sink feedback
    expect(buffered.length).toBeGreaterThanOrEqual(2);
  });

  it('sseSink 为 undefined 时不应报错', () => {
    const { bridge, dispatched } = createTestEnv({ sseSink: undefined });

    expect(() => {
      bridge.handle({ type: 'thought', id: 'th1', content: '...', timestamp: 1000 } as never);
    }).not.toThrow();

    // eventMapper 仍应被调用，RuntimeEvent 仍应被缓冲
    expect(dispatched.some((a) => a.type === 'RUNTIME_EVENT_BUFFERED')).toBe(true);
  });

  it('sseSink 抛出错误时不应传播', () => {
    const sseSink = vi.fn(() => { throw new Error('SSE boom'); });

    const { bridge } = createTestEnv({ sseSink: sseSink as never });

    expect(() => {
      bridge.handle({ type: 'thought', id: 'th1', content: '...', timestamp: 1000 } as never);
    }).not.toThrow();
  });

  it('事件应被标记 __dispatched_via_sse__', () => {
    const captured: unknown[] = [];
    const sseSink = vi.fn((evt: unknown) => { captured.push(evt); return []; });

    const { bridge } = createTestEnv({ sseSink: sseSink as never });

    bridge.handle({ type: 'thought', id: 'th1', content: '...', timestamp: 1000 } as never);

    expect(captured).toHaveLength(1);
    const desc = Object.getOwnPropertyDescriptor(captured[0], '__dispatched_via_sse__');
    expect(desc?.value).toBe(true);
    expect(desc?.enumerable).toBe(false);
  });
});

// ── 边界情况 ────────────────────────────────────────────────────────────

describe('边界情况', () => {
  it('null/undefined 事件应被忽略', () => {
    const { bridge, dispatched, sseSink } = createTestEnv();

    bridge.handle(null as never);
    bridge.handle(undefined as never);

    expect(dispatched).toHaveLength(0);
    expect(sseSink).not.toHaveBeenCalled();
  });

  it('非对象事件应被忽略', () => {
    const { bridge, dispatched } = createTestEnv();

    bridge.handle('string_event' as never);
    bridge.handle(42 as never);

    expect(dispatched).toHaveLength(0);
  });
});
