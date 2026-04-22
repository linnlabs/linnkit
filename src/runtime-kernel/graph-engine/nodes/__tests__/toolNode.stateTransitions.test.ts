import { describe, expect, it } from 'vitest';
import {
  applyToolOutputIdempotencyMetadata,
  buildErrorLocalState,
  buildRequireUserLocalState,
  buildSuccessLocalState,
  buildSuccessOutputPayload,
  extractToolControlInfo,
  readStructuredObservation,
} from '../toolNode.stateTransitions';

describe('toolNode.stateTransitions', () => {
  it('应提取 structuredObservation 与 tool control', () => {
    const parsed = {
      observation: 'hello',
      control: {
        requireUser: true,
        questionnaireId: 'q_1',
        resumeStrategy: 'continue',
      },
    };

    expect(readStructuredObservation(parsed)).toBe('hello');
    expect(extractToolControlInfo(parsed)).toEqual({
      requireUser: true,
      questionnaireId: 'q_1',
      resumeStrategy: 'continue',
    });
  });

  it('应构造 success output payload 并写入 idempotency metadata', () => {
    const payload = buildSuccessOutputPayload('raw-output', { data: { ok: true } });
    expect(payload).toEqual({
      output: 'raw-output',
      result: { data: { ok: true } },
    });

    const runtimeEvent: Record<string, unknown> = {};
    applyToolOutputIdempotencyMetadata({
      runtimeToolOutput: runtimeEvent as never,
      execIdempotency: { key: 'idem_1', cacheHit: true },
    });

    expect(runtimeEvent.ephemeral).toBe(true);
    expect(runtimeEvent.metadata).toEqual({
      idempotency: { key: 'idem_1', cache_hit: true },
    });
  });

  it('应构造 requireUser local state', () => {
    const parsed = {
      data: { form: true },
      control: { requireUser: true, question: '继续吗？' },
    };

    const nextLocal = buildRequireUserLocalState({
      local: { history: [{ id: 'h1' }] },
      parsed,
      toolCallId: 'call_1',
      toolName: 'ask_questions',
      remainingCalls: [],
      conversationId: 'conv_1',
      turnId: 'turn_1',
      runtimeEvents: [{ id: 'evt_1' } as never],
    });

    expect(nextLocal.pendingInteractionSpec).toEqual({
      requireUser: true,
      question: '继续吗？',
      toolCallId: 'call_1',
      toolName: 'ask_questions',
    });
    expect((nextLocal.history as unknown[])).toHaveLength(2);
  });

  it('应支持无 questionnaireId 的 requireUser 工具进入 wait_user', () => {
    const parsed = {
      data: { title: 'Deck Plan', pageCount: 3 },
      control: { requireUser: true, resumeStrategy: 'continue' },
    };

    expect(extractToolControlInfo(parsed)).toEqual({
      requireUser: true,
      resumeStrategy: 'continue',
    });

    const nextLocal = buildRequireUserLocalState({
      local: { history: [] },
      parsed,
      toolCallId: 'call_ppt_plan_1',
      toolName: 'ppt_plan',
      remainingCalls: [],
      conversationId: 'conv_1',
      turnId: 'turn_1',
      runtimeEvents: [],
    });

    expect(nextLocal.pendingInteractionSpec).toEqual({
      requireUser: true,
      resumeStrategy: 'continue',
      toolCallId: 'call_ppt_plan_1',
      toolName: 'ppt_plan',
    });
  });

  it('应构造 success / error local state，并在 error=0 时清除旧 protocol 计数', () => {
    const successLocal = buildSuccessLocalState({
      local: {
        answerId: 'ans_1',
        chunkSeq: 4,
        history: [{ id: 'h1' }],
      },
      remainingCalls: ['next'],
      conversationId: 'conv_1',
      turnId: 'turn_1',
      runtimeEvents: [{ id: 'evt_1' } as never],
    });

    expect('answerId' in successLocal).toBe(false);
    expect('chunkSeq' in successLocal).toBe(false);
    expect(successLocal.pendingToolCalls).toEqual(['next']);

    const errorLocal = buildErrorLocalState({
      local: {
        _consecutiveToolProtocolErrors: 3,
        history: [{ id: 'h1' }],
      },
      remainingCalls: [],
      conversationId: 'conv_1',
      turnId: 'turn_1',
      runtimeEvents: [{ id: 'evt_2' } as never],
      nextProtocolErrorCount: 0,
    });

    expect('_consecutiveToolProtocolErrors' in errorLocal).toBe(false);
    expect((errorLocal.history as unknown[])).toHaveLength(2);
  });
});
