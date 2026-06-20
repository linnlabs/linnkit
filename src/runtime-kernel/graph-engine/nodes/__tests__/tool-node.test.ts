/**
 * @file src/core/graph-engine/nodes/__tests__/tool-node.test.ts
 * @description ToolNode 单元测试
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolNode } from '../toolNode';
import { EngineState } from '../../types';
import { setLlmAuditRecorder } from '../../../../shared/llmAuditRecorder';
import type { ObservationPreviewPort, ToolRuntimePort } from '../../../tools/ports';
import type { RuntimeEvent } from '../../../../contracts';

const { getToolDefinitionMock, executeToolMock } = vi.hoisted(() => ({
  getToolDefinitionMock: vi.fn(),
  executeToolMock: vi.fn(),
}));

vi.mock('../../../../shared/ids', () => ({
  generateAuditEnvelopeId: vi.fn(() => `audit_${Date.now()}`),
  generateMessageId: vi.fn(() => `msg_${Date.now()}`),
}));

describe('ToolNode - 单元测试', () => {
  let toolNode: ToolNode;
  let mockRecordToolProtocolError: any;
  let mockToolRuntime: Pick<ToolRuntimePort, 'getToolDefinition' | 'executeTool'>;
  let mockObservationPreview: ObservationPreviewPort;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordToolProtocolError = vi.fn();
    setLlmAuditRecorder({
      recordToolProtocolError: mockRecordToolProtocolError,
    });
    mockToolRuntime = {
      getToolDefinition: getToolDefinitionMock,
      executeTool: executeToolMock,
    };
    const truncateObservationMock = vi.fn<ObservationPreviewPort['truncateObservation']>(
      async ({ text }) => ({ truncated: false, preview: text }),
    );
    mockObservationPreview = {
      truncateObservation: truncateObservationMock,
    };
    toolNode = new ToolNode({
      toolRuntime: mockToolRuntime,
      observationPreview: mockObservationPreview,
    });
    getToolDefinitionMock.mockReturnValue({
      displayOptions: {},
      parameters: { type: 'object', properties: {} },
    });
  });

  afterEach(() => {
    setLlmAuditRecorder(null);
  });

  describe('1. 基础功能', () => {
    it('应该有正确的节点 ID', () => {
      expect(toolNode.id).toBe('tool');
    });

    it('应该在没有 pendingToolCalls 时 yield', async () => {
      const state: EngineState = {
        nodeId: 'tool',
        local: { conversationId: 'conv_1' },
      };

      const result = await toolNode.run(state);

      expect(result.kind).toBe('yield');
      expect(result.events).toEqual([]);
    });
  });

  describe('2. 工具执行成功', () => {
    it('应该路由回 llm 节点', async () => {
      executeToolMock.mockResolvedValue({
        success: true,
        result: 'Tool result',
      });

      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          pendingToolCalls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'search', arguments: '{"query":"test"}' },
            },
          ],
          toolContext: {},
        },
      };

      const result = await toolNode.run(state);

      expect(result.kind).toBe('route');
      expect(result.nextNodeId).toBe('llm');
    });

    it('应该从 executorLocal 读取 observation governance 配置', async () => {
      executeToolMock.mockResolvedValue({
        success: true,
        result: JSON.stringify({
          observation: 'very long output',
          data: {},
        }),
      });

      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          executorLocal: {
            stepCount: 0,
            toolObservationPolicy: {
              maxChars: 1024,
              maxLines: 64,
            },
          },
          pendingToolCalls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'search', arguments: '{"query":"test"}' },
            },
          ],
          toolContext: {},
        },
      };

      await toolNode.run(state);

      expect(mockObservationPreview.truncateObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          maxChars: 1024,
          maxLines: 64,
        }),
      );
    });

    it('不应覆盖已注入的 toolContext.conversationId（用于 conversation-root artifacts）', async () => {
      let capturedContext: any = null;
      executeToolMock.mockImplementation(async (_toolName: string, _args: unknown, ctx: unknown) => {
        capturedContext = ctx;
        return { success: true, result: 'OK' };
      });

      const state: EngineState = {
        nodeId: 'tool',
        local: {
          // 模拟 internal 子 run：local.conversationId 是 internal_*
          conversationId: 'internal_1',
          turnId: 'turn_1',
          pendingToolCalls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'search', arguments: '{"query":"test"}' },
            },
          ],
          // ✅ 上游（父会话）已经注入真实 conv-*：必须保留
          toolContext: { conversationId: 'conv_root_1' },
        },
      };

      await toolNode.run(state);

      expect(capturedContext).toBeTruthy();
      expect(capturedContext.conversationId).toBe('conv_root_1');
    });

    it('requireUser 工具不应预写 tool_output，而应直接进入 wait_user', async () => {
      executeToolMock.mockResolvedValue({
        success: true,
        result: JSON.stringify({
          data: {
            title: 'Deck Plan',
            pageCount: 2,
            pages: [
              { slideNumber: 1, title: 'Intro', content: '介绍背景' },
              { slideNumber: 2, title: 'Plan', content: '说明方案' },
            ],
          },
          observation: 'PPT 计划已生成。',
          control: {
            requireUser: true,
            resumeStrategy: 'continue',
          },
        }),
      });

      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          pendingToolCalls: [
            {
              id: 'call_ppt_plan_1',
              type: 'function' as const,
              function: { name: 'ppt_plan', arguments: '{"title":"Deck Plan"}' },
            },
          ],
          toolContext: {},
        },
      };

      const result = await toolNode.run(state);

      expect(result.kind).toBe('route');
      expect(result.nextNodeId).toBe('wait_user');

      const runtimeEvents = result.events ?? [];
      expect(runtimeEvents.filter((event) => event.type === 'tool_process')).toHaveLength(1);
      expect(runtimeEvents.find((event) => event.type === 'tool_output')).toBeUndefined();
    });

    it('执行期 observation 截断后应把字符计量写入 tool_output metadata', async () => {
      executeToolMock.mockResolvedValue({
        success: true,
        result: JSON.stringify({
          observation: 'line 1\nline 2\nline 3',
          data: {},
        }),
        durationMs: 5,
      });
      mockObservationPreview.truncateObservation = vi.fn(async () => ({
        truncated: true,
        preview: 'line 1',
        blob_id: 'blob_1',
        originalChars: 20,
        previewChars: 6,
        originalLines: 3,
        previewLines: 1,
      }));

      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          pendingToolCalls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'search', arguments: '{"query":"test"}' },
            },
          ],
          toolContext: {},
        },
      };

      const result = await toolNode.run(state);
      const runtimeEvents = result.events ?? [];
      const toolOutput = runtimeEvents.find((event) => event.type === 'tool_output');

      expect(toolOutput?.metadata?.observationTruncation).toEqual({
        originalChars: 20,
        previewChars: 6,
        originalLines: 3,
        previewLines: 1,
      });
      expect(state.local?.history?.find((event) => event.type === 'tool_output')?.metadata?.observationTruncation)
        .toEqual({
          originalChars: 20,
          previewChars: 6,
          originalLines: 3,
          previewLines: 1,
        });
    });
  });

  describe('3. 工具执行失败', () => {
    it('应该处理工具执行错误', async () => {
      executeToolMock.mockResolvedValue({
        success: false,
        error: 'Tool failed',
        errorKind: 'execution',
      });

      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          pendingToolCalls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'search', arguments: '{}' },
            },
          ],
          toolContext: {},
        },
      };

      const result = await toolNode.run(state);

      expect(result.kind).toBe('route');
      expect(result.nextNodeId).toBe('llm');
      expect(result.events).toBeDefined();
    });

    it('批量工具调用中某个工具失败时，也应继续消费剩余工具调用', async () => {
      executeToolMock
        .mockResolvedValueOnce({
          success: false,
          error: 'Root path is a directory',
          errorKind: 'execution',
        })
        .mockResolvedValueOnce({
          success: true,
          result: 'read result',
        });

      const secondCall = {
        id: 'call_2',
        type: 'function' as const,
        function: { name: 'read_file', arguments: '{"path":"/"}' },
      };
      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          pendingToolCalls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'list_files', arguments: '{"path":"/"}' },
            },
            secondCall,
          ],
          toolContext: {},
        },
      };

      const result = await toolNode.run(state);

      expect(result.kind).toBe('route');
      expect(result.nextNodeId).toBe('llm');
      expect(state.local?.pendingToolCalls).toEqual([]);
      expect(executeToolMock).toHaveBeenCalledTimes(2);
      expect(
        state.local?.history?.filter((event) => event.type === 'tool_output'),
      ).toHaveLength(2);
    });

    it('批量工具调用中连续 protocol error 达到熔断阈值时，应先消费剩余工具调用', async () => {
      executeToolMock.mockResolvedValue({
        success: true,
        result: 'OK',
      });

      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          pendingToolCalls: [
            {
              id: 'call_bad_1',
              type: 'function' as const,
              function: { name: 'bad_tool_1', arguments: 'invalid json' },
            },
            {
              id: 'call_bad_2',
              type: 'function' as const,
              function: { name: 'bad_tool_2', arguments: 'invalid json' },
            },
            {
              id: 'call_bad_3',
              type: 'function' as const,
              function: { name: 'bad_tool_3', arguments: 'invalid json' },
            },
            {
              id: 'call_bad_4',
              type: 'function' as const,
              function: { name: 'bad_tool_4', arguments: 'invalid json' },
            },
            {
              id: 'call_ok_5',
              type: 'function' as const,
              function: { name: 'ok_tool', arguments: '{}' },
            },
          ],
          toolContext: {},
        },
      };

      const result = await toolNode.run(state);

      expect(result.kind).toBe('route');
      expect(result.nextNodeId).toBe('llm');
      expect(state.local?.pendingToolCalls).toEqual([]);
      expect(executeToolMock).toHaveBeenCalledTimes(1);
      expect(mockRecordToolProtocolError).toHaveBeenCalledTimes(4);
      expect(
        state.local?.history?.filter((event) => event.type === 'tool_output'),
      ).toHaveLength(5);
      expect('_consecutiveToolProtocolErrors' in (state.local ?? {})).toBe(false);
    });

    it('第一次 protocol error 应允许回到 llm 自修正，并记录连续次数', async () => {
      executeToolMock.mockResolvedValue({
        success: false,
        error: 'Missing required parameter: name',
        errorKind: 'protocol',
      });

      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          pendingToolCalls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'workspace_create_document', arguments: '{}' },
            },
          ],
          toolContext: {},
        },
      };

      const result = await toolNode.run(state);

      expect(result.kind).toBe('route');
      expect(result.nextNodeId).toBe('llm');
      expect(state.local?._consecutiveToolProtocolErrors).toBe(1);
      expect(mockRecordToolProtocolError).toHaveBeenCalledWith({
        mode: 'agent',
        toolName: 'workspace_create_document',
        toolCallId: 'call_1',
        rawArguments: '{}',
        parsedArguments: {},
        error: 'Missing required parameter: name',
      });
    });

    it('连续第三次 protocol error 仍应允许回到 llm，保留更多自修正空间', async () => {
      executeToolMock.mockResolvedValue({
        success: false,
        error: 'Missing required parameter: name',
        errorKind: 'protocol',
      });

      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          _consecutiveToolProtocolErrors: 2,
          pendingToolCalls: [
            {
              id: 'call_3',
              type: 'function' as const,
              function: { name: 'workspace_create_document', arguments: '{}' },
            },
          ],
          toolContext: {},
        },
      };

      const result = await toolNode.run(state);

      expect(result.kind).toBe('route');
      expect(result.nextNodeId).toBe('llm');
      expect(state.local?._consecutiveToolProtocolErrors).toBe(3);
    });

    it('连续第四次 protocol error 应直接熔断，而不是继续回 llm', async () => {
      executeToolMock.mockResolvedValue({
        success: false,
        error: 'Missing required parameter: name',
        errorKind: 'protocol',
      });

      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          _consecutiveToolProtocolErrors: 3,
          pendingToolCalls: [
            {
              id: 'call_4',
              type: 'function' as const,
              function: { name: 'workspace_create_document', arguments: '{}' },
            },
          ],
          toolContext: {},
        },
      };

      await expect(toolNode.run(state)).rejects.toMatchObject({
        name: 'ToolProtocolFuseError',
      });
    });

    it('应该处理 JSON 解析错误', async () => {
      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          pendingToolCalls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'search', arguments: 'invalid json' },
            },
          ],
          toolContext: {},
        },
      };

      const result = await toolNode.run(state);

      expect(result.kind).toBe('route');
      expect(result.nextNodeId).toBe('llm');
      expect(executeToolMock).not.toHaveBeenCalled();
      expect(state.local?._consecutiveToolProtocolErrors).toBe(1);
      expect(mockRecordToolProtocolError).toHaveBeenCalledWith({
        mode: 'agent',
        toolName: 'search',
        toolCallId: 'call_1',
        rawArguments: 'invalid json',
        parsedArguments: {},
        error: expect.stringContaining('Tool arguments are not valid JSON'),
      });
    });

    it('收到 AbortError 时应直接向上抛出，而不是继续回 llm', async () => {
      const abortError = new Error('The user aborted a request.');
      abortError.name = 'AbortError';
      executeToolMock.mockRejectedValue(abortError);

      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          pendingToolCalls: [
            {
              id: 'call_abort',
              type: 'function' as const,
              function: { name: 'task', arguments: '{}' },
            },
          ],
          toolContext: {},
        },
      };

      await expect(toolNode.run(state)).rejects.toMatchObject({
        name: 'AbortError',
        message: 'The user aborted a request.',
      });
    });
  });

  describe('4. SSE 事件分发', () => {
    it('应该通过 sseSink 分发事件', async () => {
      const mockSseSink = vi.fn();
      executeToolMock.mockResolvedValue({
        success: true,
        result: 'OK',
      });

      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          sseSink: mockSseSink,
          pendingToolCalls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'search', arguments: '{}' },
            },
          ],
          toolContext: {},
        },
      };

      await toolNode.run(state);

      expect(mockSseSink).toHaveBeenCalled();
    });

    it('应该处理 sseSink 错误而不崩溃', async () => {
      const mockSseSink = vi.fn(() => {
        throw new Error('SSE failed');
      });
      executeToolMock.mockResolvedValue({
        success: true,
        result: 'OK',
      });

      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          sseSink: mockSseSink,
          pendingToolCalls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'search', arguments: '{}' },
            },
          ],
          toolContext: {},
        },
      };

      await expect(toolNode.run(state)).resolves.toBeDefined();
    });
  });

  describe('5. 历史事件管理', () => {
    it('应该更新历史事件', async () => {
      executeToolMock.mockResolvedValue({
        success: true,
        result: 'OK',
      });

      const existingHistory: RuntimeEvent[] = [
        {
          type: 'user_input',
          id: 'u1',
          timestamp: 1,
          conversation_id: 'conv_1',
          turn_id: 'turn_1',
          version: 1,
          source: 'user',
          content: 'hello',
        },
      ];
      const state: EngineState = {
        nodeId: 'tool',
        local: {
          conversationId: 'conv_1',
          turnId: 'turn_1',
          history: existingHistory,
          pendingToolCalls: [
            {
              id: 'call_1',
              type: 'function' as const,
              function: { name: 'search', arguments: '{}' },
            },
          ],
          toolContext: {},
        },
      };

      await toolNode.run(state);

      expect(state.local?.history).toBeDefined();
      expect((state.local?.history as any[]).length).toBeGreaterThan(existingHistory.length);
    });
  });
});
