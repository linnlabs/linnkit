import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineState } from '../../types';

const { getToolDefinitionMock } = vi.hoisted(() => ({
  getToolDefinitionMock: vi.fn(),
}));

vi.mock('../../tools/idempotency/toolIdempotency', () => ({
  computeToolIdempotencyKey: vi.fn(() => 'idem_exec_setup'),
}));

import {
  prepareToolExecution,
  prepareToolNodeContext,
} from '../toolNode.executionSetup';

describe('toolNode.executionSetup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getToolDefinitionMock.mockReturnValue({
      displayOptions: { viewType: 'card' },
      parameters: { type: 'object', properties: {} },
      idempotency: { level: 'strict' },
    });
  });

  it('prepareToolNodeContext 应维持 working history 视图并计算 citationOffset', () => {
    const baseGetHistory = vi.fn(() => [{ id: 'persisted_1' }]);
    const state: EngineState = {
      nodeId: 'tool',
      local: {
        conversationId: 'conv_1',
        turnId: 'turn_1',
        toolContext: {
          getConversationHistoryEvents: baseGetHistory,
        },
        history: [
          {
            type: 'tool_output',
            turn_id: 'turn_1',
            payload: {
              result: {
                data: {
                  citations: {
                    citations: [{ id: 'c1' }, { id: 'c2' }],
                  },
                },
              },
            },
          },
        ],
      },
    };

    const prepared = prepareToolNodeContext(state);

    expect(prepared.toolContext.citationOffset).toBe(2);
    expect(prepared.toolContext.conversationView).toBeTruthy();
    const history = prepared.toolContext.getConversationHistoryEvents?.();
    expect(Array.isArray(history)).toBe(true);
    expect((history ?? [])).toHaveLength(1);
    expect(baseGetHistory).not.toHaveBeenCalled();
    expect(prepared.toolContext.conversationView?.getPersistedHistoryEvents()).toEqual([{ id: 'persisted_1' }]);
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
        sseSink: vi.fn(),
      },
    };

    const prepared = prepareToolNodeContext(state);
    const execution = prepareToolExecution({
      prepared,
      call: {
        id: 'call_1',
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
        sseSink: vi.fn(),
      },
    };

    const prepared = prepareToolNodeContext(state);
    const execution = prepareToolExecution({
      prepared,
      call: {
        id: 'call_2',
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
      displayOptions: { viewType: 'card' },
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'PPT 标题' },
          pages: {
            type: 'array',
            description: '逐页计划',
            items: {
              type: 'object',
              description: '单页计划',
              properties: {
                title: { type: 'string', description: '页标题' },
                content: { type: 'string', description: '页内容' },
              },
              required: ['title', 'content'],
            },
          },
        },
      },
      idempotency: { level: 'strict' },
    });

    const state: EngineState = {
      nodeId: 'tool',
      local: {
        conversationId: 'internal_3',
        turnId: 'turn_3',
        toolContext: {},
        sseSink: vi.fn(),
      },
    };

    const prepared = prepareToolNodeContext(state);
    const execution = prepareToolExecution({
      prepared,
      call: {
        id: 'call_3',
        type: 'function',
        function: {
          name: 'ppt_plan',
          arguments:
            '{"title":"Deck","pages":"[{\\"title\\":\\"Overview\\",\\"content\\":\\"Summary\\"}]"}',
        },
      },
      toolCatalog: {
        getToolDefinition: getToolDefinitionMock,
      },
    });

    expect(execution).toBeTruthy();
    expect(execution?.toolArgs).toEqual({
      title: 'Deck',
      pages: [{ title: 'Overview', content: 'Summary' }],
    });
    expect(warnSpy).toHaveBeenCalledWith(
      '[ToolArgNormalizer] Normalized JSON-encoded array string for ppt_plan.pages'
    );
  });
});
