import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineState } from '../../types';

const { getToolDefinitionMock } = vi.hoisted(() => ({
  getToolDefinitionMock: vi.fn(),
}));

import { prepareToolExecution, prepareToolNodeContext } from '../toolNode.executionSetup';
import { createRuntimeEventAdmissionSink } from './runtimeEventAdmissionFixture';
import { createToolOutputEvent, RunIdSchema, ToolCallIdSchema } from '../../../../contracts';

describe('toolNode.executionSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getToolDefinitionMock.mockReturnValue({
      parameters: { type: 'object', properties: {} },
      idempotency: { scope: 'conversation' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prepareToolNodeContext 应维持 working history 视图', () => {
    const baseGetHistory = vi.fn(() => []);
    const state: EngineState = {
      nodeId: 'tool',
      local: {
        conversationId: 'conv_1',
        turnId: 'turn_1',
        runtimeEventSink: createRuntimeEventAdmissionSink('conv_1', 'run_1'),
        toolContext: {
          conversationView: {
            getWorkingHistoryEvents: baseGetHistory,
            getPersistedHistoryEvents: baseGetHistory,
          },
        },
        history: [
          createToolOutputEvent(
            'event-citations',
            'conv_1',
            'turn_1',
            'search',
            'call-citations',
            {
              status: 'success',
              observation: 'citations',
              data: {
                citations: {
                  citations: [{ id: 'c1' }, { id: 'c2' }],
                },
              },
            }
          ),
        ],
      },
    };

    const prepared = prepareToolNodeContext(state);

    expect(prepared.toolContext.conversationView).toBeTruthy();
    const history = prepared.toolContext.conversationView?.getWorkingHistoryEvents();
    expect(Array.isArray(history)).toBe(true);
    expect(history ?? []).toHaveLength(1);
    expect(baseGetHistory).not.toHaveBeenCalled();
    expect(prepared.toolContext.conversationView?.getPersistedHistoryEvents()).toEqual([]);
    expect(baseGetHistory).toHaveBeenCalledTimes(1);
  });

  it('prepareToolExecution 应规范化调用装配 bridge 与运行时 toolContext', () => {
    const state: EngineState = {
      nodeId: 'tool',
      local: {
        conversationId: 'internal_1',
        turnId: 'turn_1',
        toolContext: {
          conversationId: 'conv_root_1',
        },
        runtimeEventSink: createRuntimeEventAdmissionSink('internal_1', 'run_1'),
      },
    };

    const prepared = prepareToolNodeContext(state);
    const execution = prepareToolExecution({
      prepared,
      call: {
        id: ToolCallIdSchema.parse('call_1'),
        type: 'function',
        function: {
          name: 'search',
          arguments: '{"query":"hello"}',
        },
      },
      toolCatalog: {
        getToolDefinition: getToolDefinitionMock,
      },
    });

    expect(execution).toBeTruthy();
    expect(execution?.toolName).toBe('search');
    expect(execution?.toolCallId).toBe('call_1');
    expect(execution?.idempotencyKey).toMatch(/^[a-f0-9]{32}$/);
    expect(prepared.toolContext.parentToolCallId).toBe('call_1');
    expect(prepared.toolContext.conversationId).toBe('conv_root_1');
    expect(prepared.toolContext.turnId).toBe('turn_1');
  });

  it('prepareToolExecution 在未注入 toolCatalog 时不应隐式依赖宿主默认实现', () => {
    const state: EngineState = {
      nodeId: 'tool',
      local: {
        conversationId: 'internal_2',
        turnId: 'turn_2',
        toolContext: {},
        runtimeEventSink: createRuntimeEventAdmissionSink('internal_2', 'run_2'),
      },
    };

    const prepared = prepareToolNodeContext(state);
    const execution = prepareToolExecution({
      prepared,
      call: {
        id: ToolCallIdSchema.parse('call_2'),
        type: 'function',
        function: {
          name: 'search',
          arguments: '{"query":"hello"}',
        },
      },
    });

    expect(execution).toBeTruthy();
    expect(execution?.toolArgs).toEqual({ query: 'hello' });
    expect(getToolDefinitionMock).not.toHaveBeenCalled();
  });

  it('prepareToolExecution 应将 schema 期望的 JSON 编码数组字符串归一化为真实数组', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getToolDefinitionMock.mockReturnValue({
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '批次名称' },
          items: {
            type: 'array',
            description: '批次条目',
            items: {
              type: 'object',
              description: '单个条目',
              properties: {
                title: { type: 'string', description: '条目名称' },
                content: { type: 'string', description: '条目内容' },
              },
              required: ['title', 'content'],
            },
          },
        },
      },
      idempotency: { scope: 'conversation' },
    });

    const state: EngineState = {
      nodeId: 'tool',
      local: {
        conversationId: 'internal_3',
        turnId: 'turn_3',
        toolContext: {},
        runtimeEventSink: createRuntimeEventAdmissionSink('internal_3', 'run_3'),
      },
    };

    const prepared = prepareToolNodeContext(state);
    const execution = prepareToolExecution({
      prepared,
      call: {
        id: ToolCallIdSchema.parse('call_3'),
        type: 'function',
        function: {
          name: 'submit_batch',
          arguments:
            '{"title":"Batch","items":"[{\\"title\\":\\"Overview\\",\\"content\\":\\"Summary\\"}]"}',
        },
      },
      toolCatalog: {
        getToolDefinition: getToolDefinitionMock,
      },
    });

    expect(execution).toBeTruthy();
    expect(execution?.toolArgs).toEqual({
      title: 'Batch',
      items: [{ title: 'Overview', content: 'Summary' }],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WARN] [ToolArgNormalizer] normalized JSON-encoded tool argument'),
      {
        expectedType: 'array',
        path: 'submit_batch.items',
      }
    );
  });

  it('prepareToolNodeContext 在 conversation scope 身份缺失时立即失败', () => {
    getToolDefinitionMock.mockReturnValue({
      parameters: { type: 'object', properties: {} },
      idempotency: { scope: 'conversation' },
    });
    const state: EngineState = {
      nodeId: 'tool',
      local: {
        conversationId: '',
        turnId: 'turn_4',
        toolContext: {},
        runtimeEventSink: createRuntimeEventAdmissionSink('conversation-invalid', 'run-invalid'),
      },
    };

    expect(() => prepareToolNodeContext(state)).toThrow(/conversationId/);
  });
});
