/**
 * @file src/core/graph-engine/nodes/__tests__/llmNode.state.test.ts
 * @description LlmNode 状态 reducer 纯函数单测（Phase 1.5-2a 护栏）
 */
import { describe, it, expect } from 'vitest';
import {
  llmNodeReducer,
  initLlmNodeState,
  buildLocalPatch,
  type LlmNodeLocalState,
  type LlmNodeAction,
} from '../llmNode.state';

function makeState(overrides?: Partial<LlmNodeLocalState>): LlmNodeLocalState {
  return {
    answerId: undefined,
    chunkSeq: 0,
    streamRuntimeEvents: [],
    seenRuntimeIds: new Set(),
    pendingToolCalls: undefined,
    finalAnswer: undefined,
    pendingInteractionSpec: undefined,
    lastToolResult: undefined,
    ...overrides,
  };
}

function makeRuntimeEvent(id: string, type = 'thought'): { id: string; type: string; timestamp: number; conversation_id: string; turn_id: string; version: number } {
  return { id, type, timestamp: Date.now(), conversation_id: 'conv_1', turn_id: 'turn_1', version: 1 };
}

// ── STREAM_CHUNK_RECEIVED ──────────────────────────────────────────────

describe('STREAM_CHUNK_RECEIVED', () => {
  it('首次 chunk：应使用 generatedAnswerId，chunkSeq 从 0→1', () => {
    const state = makeState({ answerId: undefined, chunkSeq: 0 });
    const next = llmNodeReducer(state, {
      type: 'STREAM_CHUNK_RECEIVED',
      incomingAnswerId: undefined,
      generatedAnswerId: 'gen_1',
    });
    expect(next.answerId).toBe('gen_1');
    expect(next.chunkSeq).toBe(1);
  });

  it('连续 chunk（同一 answerId）：chunkSeq 递增', () => {
    const state = makeState({ answerId: 'ans_1', chunkSeq: 3 });
    const next = llmNodeReducer(state, {
      type: 'STREAM_CHUNK_RECEIVED',
      incomingAnswerId: undefined,
      generatedAnswerId: 'ans_1',
    });
    expect(next.answerId).toBe('ans_1');
    expect(next.chunkSeq).toBe(4);
  });

  it('上游携带新 answer_id：应切换并重置 chunkSeq', () => {
    const state = makeState({ answerId: 'ans_before_tool', chunkSeq: 5 });
    const next = llmNodeReducer(state, {
      type: 'STREAM_CHUNK_RECEIVED',
      incomingAnswerId: 'ans_after_tool',
      generatedAnswerId: 'ans_before_tool',
    });
    expect(next.answerId).toBe('ans_after_tool');
    // 重置为 0 后自增一次 → 1
    expect(next.chunkSeq).toBe(1);
  });

  it('上游携带相同 answer_id：不重置 chunkSeq', () => {
    const state = makeState({ answerId: 'ans_same', chunkSeq: 2 });
    const next = llmNodeReducer(state, {
      type: 'STREAM_CHUNK_RECEIVED',
      incomingAnswerId: 'ans_same',
      generatedAnswerId: 'ans_same',
    });
    expect(next.answerId).toBe('ans_same');
    expect(next.chunkSeq).toBe(3);
  });

  it('调用方可通过 chunkSeq - 1 读取本次 chunk 的 seq', () => {
    const state = makeState({ answerId: 'ans_1', chunkSeq: 7 });
    const next = llmNodeReducer(state, {
      type: 'STREAM_CHUNK_RECEIVED',
      incomingAnswerId: undefined,
      generatedAnswerId: 'ans_1',
    });
    const emittedSeq = next.chunkSeq - 1;
    expect(emittedSeq).toBe(7);
  });

  it('不应影响 streamRuntimeEvents 和 seenRuntimeIds', () => {
    const evt = makeRuntimeEvent('rt_1');
    const state = makeState({
      streamRuntimeEvents: [evt as never],
      seenRuntimeIds: new Set(['rt_1']),
    });
    const next = llmNodeReducer(state, {
      type: 'STREAM_CHUNK_RECEIVED',
      incomingAnswerId: undefined,
      generatedAnswerId: 'ans_1',
    });
    expect(next.streamRuntimeEvents).toBe(state.streamRuntimeEvents);
    expect(next.seenRuntimeIds).toBe(state.seenRuntimeIds);
  });
});

// ── FINAL_ANSWER_IGNORED ───────────────────────────────────────────────

describe('FINAL_ANSWER_IGNORED', () => {
  it('已有 chunk 时忽略 final_answer：重置 answerId 和 chunkSeq', () => {
    const state = makeState({ answerId: 'ans_1', chunkSeq: 5 });
    const next = llmNodeReducer(state, { type: 'FINAL_ANSWER_IGNORED' });
    expect(next.answerId).toBeUndefined();
    expect(next.chunkSeq).toBe(0);
  });

  it('不应影响其他字段', () => {
    const state = makeState({
      answerId: 'ans_1',
      chunkSeq: 3,
      finalAnswer: 'some',
      pendingToolCalls: [{ id: 'c1', type: 'function', function: { name: 'test', arguments: '{}' } }],
    });
    const next = llmNodeReducer(state, { type: 'FINAL_ANSWER_IGNORED' });
    expect(next.finalAnswer).toBe('some');
    expect(next.pendingToolCalls).toBe(state.pendingToolCalls);
  });
});

// ── FINAL_ANSWER_RECEIVED ──────────────────────────────────────────────

describe('FINAL_ANSWER_RECEIVED', () => {
  it('正常接收 final_answer：重置 answerId 和 chunkSeq', () => {
    const state = makeState({ answerId: 'ans_1', chunkSeq: 0 });
    const next = llmNodeReducer(state, { type: 'FINAL_ANSWER_RECEIVED' });
    expect(next.answerId).toBeUndefined();
    expect(next.chunkSeq).toBe(0);
  });
});

// ── RUNTIME_EVENT_BUFFERED ─────────────────────────────────────────────

describe('RUNTIME_EVENT_BUFFERED', () => {
  it('应缓冲新事件并更新去重集合', () => {
    const state = makeState();
    const evt = makeRuntimeEvent('rt_1');
    const next = llmNodeReducer(state, { type: 'RUNTIME_EVENT_BUFFERED', event: evt as never });
    expect(next.streamRuntimeEvents).toHaveLength(1);
    expect(next.streamRuntimeEvents[0]).toBe(evt);
    expect(next.seenRuntimeIds.has('rt_1')).toBe(true);
  });

  it('应跳过重复 ID 的事件', () => {
    const evt = makeRuntimeEvent('rt_dup');
    const state = makeState({
      streamRuntimeEvents: [evt as never],
      seenRuntimeIds: new Set(['rt_dup']),
    });
    const next = llmNodeReducer(state, { type: 'RUNTIME_EVENT_BUFFERED', event: evt as never });
    // 返回原引用表示未变更
    expect(next).toBe(state);
  });

  it('不应修改原始 Set 和数组（不可变语义）', () => {
    const state = makeState();
    const evt = makeRuntimeEvent('rt_new');
    const next = llmNodeReducer(state, { type: 'RUNTIME_EVENT_BUFFERED', event: evt as never });
    expect(state.streamRuntimeEvents).toHaveLength(0);
    expect(state.seenRuntimeIds.size).toBe(0);
    expect(next.streamRuntimeEvents).toHaveLength(1);
    expect(next.seenRuntimeIds.size).toBe(1);
  });
});

// ── TOOL_CALLS_ACCEPTED ────────────────────────────────────────────────

describe('TOOL_CALLS_ACCEPTED', () => {
  it('应设置 pendingToolCalls 并清空 answerId/chunkSeq', () => {
    const toolCalls = [
      { id: 'call_1', type: 'function' as const, function: { name: 'search', arguments: '{}' } },
    ];
    const state = makeState({ answerId: 'ans_1', chunkSeq: 3 });
    const next = llmNodeReducer(state, { type: 'TOOL_CALLS_ACCEPTED', toolCalls });
    expect(next.pendingToolCalls).toBe(toolCalls);
    expect(next.answerId).toBeUndefined();
    expect(next.chunkSeq).toBe(0);
  });

  it('不应影响 streamRuntimeEvents', () => {
    const evt = makeRuntimeEvent('rt_1');
    const state = makeState({ streamRuntimeEvents: [evt as never] });
    const next = llmNodeReducer(state, {
      type: 'TOOL_CALLS_ACCEPTED',
      toolCalls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }],
    });
    expect(next.streamRuntimeEvents).toBe(state.streamRuntimeEvents);
  });
});

// ── TOOL_CALLS_REJECTED_BY_FORCE_FINAL ─────────────────────────────────

describe('TOOL_CALLS_REJECTED_BY_FORCE_FINAL', () => {
  it('不应修改任何状态（返回原引用）', () => {
    const state = makeState({ answerId: 'ans_1', chunkSeq: 2 });
    const next = llmNodeReducer(state, { type: 'TOOL_CALLS_REJECTED_BY_FORCE_FINAL' });
    expect(next).toBe(state);
  });
});

// ── FINAL_ANSWER_DECISION ──────────────────────────────────────────────

describe('FINAL_ANSWER_DECISION', () => {
  it('应设置 finalAnswer', () => {
    const state = makeState();
    const next = llmNodeReducer(state, { type: 'FINAL_ANSWER_DECISION', answer: '最终回答' });
    expect(next.finalAnswer).toBe('最终回答');
  });

  it('不应影响 answerId/chunkSeq', () => {
    const state = makeState({ answerId: 'ans_1', chunkSeq: 2 });
    const next = llmNodeReducer(state, { type: 'FINAL_ANSWER_DECISION', answer: 'done' });
    expect(next.answerId).toBe('ans_1');
    expect(next.chunkSeq).toBe(2);
  });
});

// ── WAIT_USER_DECISION ─────────────────────────────────────────────────

describe('WAIT_USER_DECISION', () => {
  it('应设置 pendingInteractionSpec/lastToolResult 并清空 answerId/chunkSeq', () => {
    const state = makeState({ answerId: 'ans_1', chunkSeq: 4 });
    const spec = { questionnaireId: 'q1' };
    const toolResult = { data: 'ok' };
    const next = llmNodeReducer(state, {
      type: 'WAIT_USER_DECISION',
      spec,
      lastToolResult: toolResult,
    });
    expect(next.pendingInteractionSpec).toBe(spec);
    expect(next.lastToolResult).toBe(toolResult);
    expect(next.answerId).toBeUndefined();
    expect(next.chunkSeq).toBe(0);
  });
});

// ── initLlmNodeState ───────────────────────────────────────────────────

describe('initLlmNodeState', () => {
  it('应从初始值创建干净的状态', () => {
    const state = initLlmNodeState({ answerId: 'ans_init', chunkSeq: 5 });
    expect(state.answerId).toBe('ans_init');
    expect(state.chunkSeq).toBe(5);
    expect(state.streamRuntimeEvents).toEqual([]);
    expect(state.seenRuntimeIds.size).toBe(0);
    expect(state.pendingToolCalls).toBeUndefined();
    expect(state.finalAnswer).toBeUndefined();
    expect(state.pendingInteractionSpec).toBeUndefined();
    expect(state.lastToolResult).toBeUndefined();
  });

  it('应接受 undefined answerId', () => {
    const state = initLlmNodeState({ answerId: undefined, chunkSeq: 0 });
    expect(state.answerId).toBeUndefined();
    expect(state.chunkSeq).toBe(0);
  });
});

// ── buildLocalPatch ────────────────────────────────────────────────────

describe('buildLocalPatch', () => {
  it('基础场景：应包含 answerId/chunkSeq/conversationId/turnId/history', () => {
    const state = makeState({ answerId: 'ans_1', chunkSeq: 3 });
    const ctx = {
      conversationId: 'conv_1',
      turnId: 'turn_1',
      history: [makeRuntimeEvent('h1') as never],
      newEvents: [makeRuntimeEvent('n1') as never],
    };
    const patch = buildLocalPatch(state, ctx);
    expect(patch.answerId).toBe('ans_1');
    expect(patch.chunkSeq).toBe(3);
    expect(patch.conversationId).toBe('conv_1');
    expect(patch.turnId).toBe('turn_1');
    expect(patch.history).toHaveLength(2);
    // 不应包含未设置的决策字段
    expect('pendingToolCalls' in patch).toBe(false);
    expect('finalAnswer' in patch).toBe(false);
  });

  it('TOOL_CALLS_ACCEPTED 后：应包含 pendingToolCalls', () => {
    const toolCalls = [{ id: 'c1', type: 'function' as const, function: { name: 'x', arguments: '{}' } }];
    let state = makeState();
    state = llmNodeReducer(state, { type: 'TOOL_CALLS_ACCEPTED', toolCalls });
    const patch = buildLocalPatch(state, {
      conversationId: 'c',
      turnId: 't',
      history: [],
      newEvents: [],
    });
    expect(patch.pendingToolCalls).toBe(toolCalls);
    expect(patch.answerId).toBeUndefined();
    expect(patch.chunkSeq).toBe(0);
  });

  it('FINAL_ANSWER_DECISION 后：应包含 finalAnswer', () => {
    let state = makeState();
    state = llmNodeReducer(state, { type: 'FINAL_ANSWER_DECISION', answer: '答案' });
    const patch = buildLocalPatch(state, {
      conversationId: 'c',
      turnId: 't',
      history: [],
      newEvents: [],
    });
    expect(patch.finalAnswer).toBe('答案');
  });

  it('WAIT_USER_DECISION 后：应包含 pendingInteractionSpec 和 lastToolResult', () => {
    let state = makeState();
    state = llmNodeReducer(state, {
      type: 'WAIT_USER_DECISION',
      spec: { q: 1 },
      lastToolResult: { r: 2 },
    });
    const patch = buildLocalPatch(state, {
      conversationId: 'c',
      turnId: 't',
      history: [],
      newEvents: [],
    });
    expect(patch.pendingInteractionSpec).toEqual({ q: 1 });
    expect(patch.lastToolResult).toEqual({ r: 2 });
  });

  it('history 应按 initialHistory + newEvents + streamRuntimeEvents 顺序合并', () => {
    const h1 = makeRuntimeEvent('h1');
    const n1 = makeRuntimeEvent('n1');
    const s1 = makeRuntimeEvent('s1');
    const state = makeState({ streamRuntimeEvents: [s1 as never] });
    const patch = buildLocalPatch(state, {
      conversationId: 'c',
      turnId: 't',
      history: [h1 as never],
      newEvents: [n1 as never],
    });
    const history = patch.history as Array<{ id: string }>;
    expect(history.map((e) => e.id)).toEqual(['h1', 'n1', 's1']);
  });
});

// ── 组合场景 ───────────────────────────────────────────────────────────

describe('组合场景', () => {
  it('完整流式 → tool_calls 流程应正确收口状态', () => {
    let state = initLlmNodeState({ answerId: undefined, chunkSeq: 0 });

    // 第一个 chunk
    state = llmNodeReducer(state, {
      type: 'STREAM_CHUNK_RECEIVED',
      incomingAnswerId: undefined,
      generatedAnswerId: 'ans_gen',
    });
    expect(state.answerId).toBe('ans_gen');
    expect(state.chunkSeq).toBe(1);

    // 第二个 chunk（同一 answerId）
    state = llmNodeReducer(state, {
      type: 'STREAM_CHUNK_RECEIVED',
      incomingAnswerId: undefined,
      generatedAnswerId: 'ans_gen',
    });
    expect(state.chunkSeq).toBe(2);

    // 忽略 LLM 直接返回的 final_answer
    state = llmNodeReducer(state, { type: 'FINAL_ANSWER_IGNORED' });
    expect(state.answerId).toBeUndefined();
    expect(state.chunkSeq).toBe(0);

    // 缓冲一个 tool_call_decision 的 RuntimeEvent
    const rtEvt = makeRuntimeEvent('tc_1', 'tool_call_decision');
    state = llmNodeReducer(state, { type: 'RUNTIME_EVENT_BUFFERED', event: rtEvt as never });
    expect(state.streamRuntimeEvents).toHaveLength(1);

    // 决策：接受工具调用
    const toolCalls = [{ id: 'call_1', type: 'function' as const, function: { name: 'search', arguments: '{}' } }];
    state = llmNodeReducer(state, { type: 'TOOL_CALLS_ACCEPTED', toolCalls });
    expect(state.pendingToolCalls).toBe(toolCalls);
    expect(state.answerId).toBeUndefined();
    expect(state.chunkSeq).toBe(0);
    // streamRuntimeEvents 不应被 TOOL_CALLS_ACCEPTED 清空
    expect(state.streamRuntimeEvents).toHaveLength(1);
  });

  it('answer_id 切换 → FINAL_ANSWER_RECEIVED 流程', () => {
    let state = initLlmNodeState({ answerId: undefined, chunkSeq: 0 });

    // 工具前答案段
    state = llmNodeReducer(state, {
      type: 'STREAM_CHUNK_RECEIVED',
      incomingAnswerId: 'ans_before',
      generatedAnswerId: 'unused',
    });
    expect(state.answerId).toBe('ans_before');
    expect(state.chunkSeq).toBe(1);

    // 切换到工具后答案段
    state = llmNodeReducer(state, {
      type: 'STREAM_CHUNK_RECEIVED',
      incomingAnswerId: 'ans_after',
      generatedAnswerId: 'unused',
    });
    expect(state.answerId).toBe('ans_after');
    // chunkSeq 应重置为 0 再自增 → 1
    expect(state.chunkSeq).toBe(1);
  });
});
