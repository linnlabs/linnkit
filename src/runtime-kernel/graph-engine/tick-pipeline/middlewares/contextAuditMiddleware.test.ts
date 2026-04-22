import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInvocationRequest } from '../../../../ports/agent-invocation';
import { setLlmAuditRecorder } from '../../../../shared/llmAuditRecorder';
import type { TickPipelineContext, TickStage } from '../types';

const recordBeforeContextManagerMock = vi.fn();
const recordAfterContextManagerMock = vi.fn();
const recordAfterContextManagerOnSystemReminderHitMock = vi.fn();

function createRequest(): AgentInvocationRequest {
  return {
    query: '继续执行',
    promptKey: 'default',
    model_id: 'mock-model',
    mode: 'agent',
    maxSteps: 8,
    enableTools: true,
    availableTools: ['tool_a'],
  };
}

function createContext(): TickPipelineContext {
  const request = createRequest();
  return {
    input: {
      request,
      history: [],
      stream: false,
    },
    newEvents: [],
    request,
    history: [],
    forceFinalAnswer: false,
    modelId: 'mock-model',
    toolSchemas: [
      {
        type: 'function',
        function: {
          name: 'tool_a',
          description: 'tool a',
          parameters: {
            type: 'object',
            properties: {},
          },
        },
      },
    ],
    llmOptions: {},
    llmMessages: [{ role: 'user', content: 'hello' }],
    mode: 'agent',
    conversationId: 'conv_audit',
    turnId: 'turn_audit',
  };
}

describe('contextAuditMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLlmAuditRecorder({
      recordBeforeContextManager: recordBeforeContextManagerMock,
      recordAfterContextManager: recordAfterContextManagerMock,
      recordAfterContextManagerOnSystemReminderHit: recordAfterContextManagerOnSystemReminderHitMock,
    });
  });

  it('在 build_context 前记录 before 快照，在 system reminder 后记录 after 与命中快照', async () => {
    const { contextAuditMiddleware } = await import('./contextAuditMiddleware');
    const ctx = createContext();
    const markers: string[] = [];

    recordBeforeContextManagerMock.mockImplementation(() => {
      markers.push('before');
    });
    recordAfterContextManagerMock.mockImplementation(() => {
      markers.push('after');
    });
    recordAfterContextManagerOnSystemReminderHitMock.mockImplementation(() => {
      markers.push('after_hit');
    });

    const buildContextStage: TickStage = {
      id: 'build_context',
      async run() {},
    };
    await contextAuditMiddleware(ctx, buildContextStage, async () => {
      markers.push('build_context');
    });

    ctx.systemReminderHitRuleIds = ['last_steps_hint'];
    const applyReminderStage: TickStage = {
      id: 'apply_system_reminder',
      async run() {},
    };
    await contextAuditMiddleware(ctx, applyReminderStage, async () => {
      markers.push('apply_system_reminder');
    });

    expect(markers).toEqual([
      'before',
      'build_context',
      'apply_system_reminder',
      'after',
      'after_hit',
    ]);

    expect(recordBeforeContextManagerMock).toHaveBeenCalledWith({
      mode: 'agent',
      payload: {
        request: ctx.request,
        history: ctx.history,
      },
    });
    expect(recordAfterContextManagerMock).toHaveBeenCalledWith({
      mode: 'agent',
      llmMessages: ctx.llmMessages,
      toolNames: ['tool_a'],
    });
    expect(recordAfterContextManagerOnSystemReminderHitMock).toHaveBeenCalledWith({
      mode: 'agent',
      llmMessages: ctx.llmMessages,
      toolNames: ['tool_a'],
      systemReminder: { ruleIds: ['last_steps_hint'] },
    });
  });

  afterEach(() => {
    setLlmAuditRecorder(null);
  });
});
