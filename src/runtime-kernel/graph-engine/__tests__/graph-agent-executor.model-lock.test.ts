import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInvocationRequest } from '../../../ports/agent-invocation';
import type { ExecutorLocalState } from '../types';
import type { RuntimeEvent } from '../../../contracts';

const applySystemRemindersMock = vi.fn();
const getModelByIdMock = vi.fn();

vi.mock('../../system-reminder/apply', () => ({
  applySystemReminders: applySystemRemindersMock,
}));

vi.mock('../../system-reminder/rules', () => ({
  SYSTEM_REMINDER_RULES: [],
}));

vi.mock('../../../shared/llmAuditRecorder', () => ({
  recordBeforeContextManager: vi.fn(),
  recordAfterContextManager: vi.fn(),
  recordAfterContextManagerOnSystemReminderHit: vi.fn(),
}));

vi.mock('../../../shared/llmTelemetryContext', () => ({
  normalizeLlmUsage: vi.fn(),
  recordLlmCallTelemetry: vi.fn(),
}));

describe('GraphAgentExecutor - run 内 quota 模型锁定', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applySystemRemindersMock.mockImplementation(({ llmMessages }: { llmMessages: unknown[] }) => llmMessages);

    getModelByIdMock.mockImplementation((modelId: string) => {
      if (modelId === 'cloud-primary-model') {
        return {
          id: 'cloud-primary-model',
          model_name: 'cloud-primary-model',
          billing_mode: 'cloud',
          provider: 'system_default',
          enabled: true,
        };
      }
      if (modelId === 'cloud-deepseek-reasoner') {
        return {
          id: 'cloud-deepseek-reasoner',
          model_name: 'deepseek-reasoner',
          billing_mode: 'cloud',
          provider: 'system_default',
          enabled: true,
        };
      }
      return undefined;
    });
  });

  it('同一个 run 一旦 quota 降级，后续 tick 应持续使用锁定的 fallback 模型', async () => {
    const { GraphAgentExecutor } = await import('../executor');

    const resolveModelId = vi.fn((modelId?: string) => modelId ?? 'default-chat-model');
    const callWithRetries = vi
      .fn()
      .mockImplementationOnce(
        async (
          modelId: string,
          _messages: unknown[],
          _options: unknown,
          _eventHandler: unknown,
          _signal: unknown,
          onCloudQuotaFallbackApplied?: (fallbackModelId: string) => void,
        ) => {
          expect(modelId).toBe('cloud-primary-model');
          onCloudQuotaFallbackApplied?.('cloud-deepseek-reasoner');
          return '第一次已自动降级';
        }
      )
      .mockImplementationOnce(async (modelId: string) => {
        expect(modelId).toBe('cloud-deepseek-reasoner');
        return '第二次继续使用锁定模型';
      });

    const llmCaller = {
      callWithRetries,
      call: vi.fn(),
    };
    const modelResolver = {
      resolveModelId,
    };

    const toolRuntime = {
      getToolSchemas: vi.fn(() => []),
      getDisplayOptions: vi.fn(() => undefined),
    };
    const contextBuilder = {
      build: vi.fn().mockResolvedValue({
        mode: 'agent',
        llmMessages: [
          {
            role: 'user',
            type: 'user_input',
            content: '继续执行任务',
            id: 'msg_user_1',
            timestamp: Date.now(),
          },
        ],
        summaryEvents: [],
      }),
    };

    const executor = new GraphAgentExecutor({
      llmCaller: llmCaller as never,
      toolRuntime: toolRuntime as never,
      contextBuilder,
      cloudQuotaFallbackModelId: 'cloud-deepseek-reasoner',
      modelCatalog: {
        getModelById: getModelByIdMock,
        getModelsByCapability: vi.fn(() => []),
        getModelsByUIVisibility: vi.fn(() => []),
      },
      modelResolver,
    });

    const request: AgentInvocationRequest = {
      query: '继续执行任务',
      promptKey: 'default',
      model_id: 'cloud-primary-model',
      mode: 'agent',
      maxSteps: 8,
      enableTools: false,
      availableTools: [],
    };

    const history: RuntimeEvent[] = [];
    const executorLocal: ExecutorLocalState = {
      stepCount: 1,
    };

    await executor.tick({
      request,
      history,
      stream: false,
      executorLocal,
    });

    expect(executorLocal.runLockedModelId).toBe('cloud-deepseek-reasoner');

    await executor.tick({
      request,
      history,
      stream: false,
      executorLocal,
    });

    expect(resolveModelId.mock.calls[0]?.[0]).toBe('cloud-primary-model');
    expect(resolveModelId.mock.calls[1]?.[0]).toBe('cloud-deepseek-reasoner');
    expect(callWithRetries).toHaveBeenCalledTimes(2);
  }, 10_000);
});
