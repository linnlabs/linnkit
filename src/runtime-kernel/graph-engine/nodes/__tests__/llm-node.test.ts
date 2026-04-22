/**
 * @file src/core/graph-engine/nodes/__tests__/llm-node.test.ts
 * @description LlmNode 单元测试 - 使用彻底的 mock 策略避免深层依赖
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EngineState } from '../../types';

vi.mock('../../../events/eventMappers', () => ({
  eventMapper: {
    agentToSse: vi.fn((evt) => ({ ...evt, _type: 'sse' })),
    agentToRuntime: vi.fn((evt) => evt),
  },
}));

vi.mock('../../../../shared/ids', () => ({
  generateMessageId: vi.fn(() => `msg_${Date.now()}`),
}));

describe('LlmNode - 单元测试', () => {
  type LlmNodeModule = typeof import('../llmNode');
  let LlmNode: LlmNodeModule['LlmNode'];
  let mockReasonerTick: ReturnType<typeof vi.fn>;

  const createNode = () => {
    return new LlmNode({
      reasoner: {
        tick: mockReasonerTick,
      },
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockReasonerTick = vi.fn();

    const module = await import('../llmNode');
    LlmNode = module.LlmNode;
  });

  describe('1. 基础功能', () => {
    it('应该有正确的节点 ID', () => {
      const node = createNode();
      expect(node.id).toBe('llm');
    });

    it('应该在缺少 request 时 yield', async () => {
      mockReasonerTick.mockResolvedValue({
        decision: { kind: 'yield' },
        newEvents: [],
      });

      const node = createNode();
      const state: EngineState = {
        nodeId: 'llm',
        local: { conversationId: 'conv_1' },
      };

      const result = await node.run(state);

      expect(result.kind).toBe('yield');
      expect(result.events).toEqual([]);
    });
  });

  describe('2. 工具调用决策', () => {
    it('应该路由到 tool 节点', async () => {
      const toolCalls = [
        { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
      ];

      mockReasonerTick.mockResolvedValue({
        decision: { kind: 'tool_calls', toolCalls },
        newEvents: [{ type: 'tool_call_decision', id: 'a1' }],
      });

      const node = createNode();
      const state: EngineState = {
        nodeId: 'llm',
        local: {
          conversationId: 'conv_1',
          request: { query: 'test', promptKey: 'default', maxSteps: 10, enableTools: true },
          history: [],
        },
      };

      const result = await node.run(state);

      expect(result.kind).toBe('route');
      expect(result.nextNodeId).toBe('tool');
      expect(state.local?.pendingToolCalls).toEqual(toolCalls);
    });
  });

  describe('2.1 MaxSteps 强制收尾', () => {
    it('在 force_final_answer 模式下，不应路由到 tool 节点（即使底层返回 tool_calls）', async () => {
      const toolCalls = [
        { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{}' } },
      ];

      mockReasonerTick.mockResolvedValue({
        decision: { kind: 'tool_calls', toolCalls },
        newEvents: [{ type: 'tool_call_decision', id: 'a1' }],
      });

      const node = createNode();
      const state: EngineState = {
        nodeId: 'llm',
        local: {
          conversationId: 'conv_1',
          request: { query: 'test', promptKey: 'default', maxSteps: 10, enableTools: true },
          history: [],
          executorLocal: { stepCount: 10, phase: 'force_final_answer' },
        },
      };

      const result = await node.run(state);

      expect(result.kind).toBe('yield');
      expect(result.nextNodeId).toBeUndefined();
    });
  });

  describe('3. 最终答案生成', () => {
    it('应该路由到 answer 节点', async () => {
      mockReasonerTick.mockResolvedValue({
        decision: { kind: 'final_answer', answer: 'Done' },
        newEvents: [{ type: 'final_answer', id: 'ans1' }],
      });

      const node = createNode();
      const state: EngineState = {
        nodeId: 'llm',
        local: {
          conversationId: 'conv_1',
          request: { query: 'test', promptKey: 'default', maxSteps: 10, enableTools: false },
          history: [],
        },
      };

      const result = await node.run(state);

      expect(result.kind).toBe('route');
      expect(result.nextNodeId).toBe('answer');
      expect(state.local?.finalAnswer).toBe('Done');
    });
  });

  describe('4. Yield 处理', () => {
    it('应该正确处理 yield decision', async () => {
      mockReasonerTick.mockResolvedValue({
        decision: { kind: 'yield' },
        newEvents: [{ type: 'thought', id: 't1' }],
      });

      const node = createNode();
      const state: EngineState = {
        nodeId: 'llm',
        local: {
          conversationId: 'conv_1',
          request: { query: 'test', promptKey: 'default', maxSteps: 10, enableTools: false },
          history: [],
        },
      };

      const result = await node.run(state);

      expect(result.kind).toBe('yield');
      expect(result.events).toHaveLength(1);
    });

    it('应该忽略占位 answer_id，并为每轮流式回答生成独立 ID', async () => {
      mockReasonerTick.mockImplementationOnce(async (_input: unknown, eventHandler?: (event: unknown) => void) => {
        eventHandler?.({ type: 'stream_chunk', id: 'chunk_1', content: 'hello', answer_id: 'temp_answer' });
        eventHandler?.({ type: 'final_answer', id: 'final_1', answer: 'hello' });
        return { decision: { kind: 'yield' }, newEvents: [] };
      });

      const sseEvents: Array<Record<string, unknown>> = [];
      const node = createNode();
      const state: EngineState = {
        nodeId: 'llm',
        local: {
          conversationId: 'conv_1',
          request: { query: 'test', promptKey: 'default', maxSteps: 10, enableTools: false },
          history: [],
          sseSink: (evt: unknown) => {
            if (evt && typeof evt === 'object' && !Array.isArray(evt)) {
              sseEvents.push(evt as Record<string, unknown>);
            }
            return [];
          },
        },
      };

      await node.run(state);

      expect(sseEvents).toHaveLength(1);
      expect(sseEvents[0].type).toBe('stream_chunk');
      expect(sseEvents[0].answer_id).not.toBe('temp_answer');
      expect(state.local?.answerId).toBeUndefined();
      expect(state.local?.chunkSeq).toBe(0);
    });

    it('应该保留 Claude tool runner 提供的真实 answer_id', async () => {
      mockReasonerTick.mockImplementationOnce(async (_input: unknown, eventHandler?: (event: unknown) => void) => {
        eventHandler?.({ type: 'stream_chunk', id: 'chunk_1', content: 'hello', answer_id: 'answer_turn_1_abc' });
        return { decision: { kind: 'yield' }, newEvents: [] };
      });

      const sseEvents: Array<Record<string, unknown>> = [];
      const node = createNode();
      const state: EngineState = {
        nodeId: 'llm',
        local: {
          conversationId: 'conv_1',
          request: { query: 'test', promptKey: 'default', maxSteps: 10, enableTools: false },
          history: [],
          sseSink: (evt: unknown) => {
            if (evt && typeof evt === 'object' && !Array.isArray(evt)) {
              sseEvents.push(evt as Record<string, unknown>);
            }
            return [];
          },
        },
      };

      await node.run(state);

      expect(sseEvents).toHaveLength(1);
      expect(sseEvents[0].answer_id).toBe('answer_turn_1_abc');
      expect(sseEvents[0].seq).toBe(0);
    });

    it('应该在 answer_id 切换时重置 chunk seq，并把活动 answer 锁到最新片段', async () => {
      mockReasonerTick.mockImplementationOnce(async (_input: unknown, eventHandler?: (event: unknown) => void) => {
        // 中文备注：
        // - 这里模拟“工具前答案”和“工具后答案”属于两个不同的 answer 片段；
        // - LlmNode 必须在 answer_id 切换时把 seq 重置为 0，避免前端把两段内容错误归并。
        eventHandler?.({ type: 'stream_chunk', id: 'chunk_1', content: '第一段', answer_id: 'answer_before_tool' });
        eventHandler?.({ type: 'stream_chunk', id: 'chunk_2', content: '第二段', answer_id: 'answer_after_tool' });
        return { decision: { kind: 'yield' }, newEvents: [] };
      });

      const sseEvents: Array<Record<string, unknown>> = [];
      const node = createNode();
      const state: EngineState = {
        nodeId: 'llm',
        local: {
          conversationId: 'conv_1',
          request: { query: 'test', promptKey: 'default', maxSteps: 10, enableTools: false },
          history: [],
          sseSink: (evt: unknown) => {
            if (evt && typeof evt === 'object' && !Array.isArray(evt)) {
              sseEvents.push(evt as Record<string, unknown>);
            }
            return [];
          },
        },
      };

      await node.run(state);

      expect(sseEvents).toHaveLength(2);
      expect(sseEvents[0]?.answer_id).toBe('answer_before_tool');
      expect(sseEvents[0]?.seq).toBe(0);
      expect(sseEvents[1]?.answer_id).toBe('answer_after_tool');
      expect(sseEvents[1]?.seq).toBe(0);
      expect(state.local?.answerId).toBe('answer_after_tool');
      expect(state.local?.chunkSeq).toBe(1);
    });
  });

  describe('5. 错误处理', () => {
    it('应该在 error decision 时 yield', async () => {
      mockReasonerTick.mockResolvedValue({
        decision: { kind: 'error', error: new Error('Failed') },
        newEvents: [],
      });

      const node = createNode();
      const state: EngineState = {
        nodeId: 'llm',
        local: {
          conversationId: 'conv_1',
          request: { query: 'test', promptKey: 'default', maxSteps: 10, enableTools: false },
          history: [],
        },
      };

      const result = await node.run(state);

      expect(result.kind).toBe('yield');
    });

    it('应该传播 reasoner 抛出的错误', async () => {
      mockReasonerTick.mockRejectedValue(new Error('LLM failed'));

      const node = createNode();
      const state: EngineState = {
        nodeId: 'llm',
        local: {
          conversationId: 'conv_1',
          request: { query: 'test', promptKey: 'default', maxSteps: 10, enableTools: false },
          history: [],
        },
      };

      await expect(node.run(state)).rejects.toThrow('LLM failed');
    });
  });

  describe('6. 历史事件管理', () => {
    it('应该更新历史事件', async () => {
      mockReasonerTick.mockResolvedValue({
        decision: { kind: 'yield' },
        newEvents: [{ type: 'thought', id: 't1' }],
      });

      const node = createNode();
      const existingHistory = [{ type: 'user_input', id: 'u1' }];
      
      const state: EngineState = {
        nodeId: 'llm',
        local: {
          conversationId: 'conv_1',
          request: { query: 'test', promptKey: 'default', maxSteps: 10, enableTools: false },
          history: existingHistory,
        },
      };

      await node.run(state);

      expect(state.local?.history).toBeDefined();
      expect(state.local?.history?.length).toBeGreaterThan(existingHistory.length);
    });
  });

  describe('7. SSE 事件处理', () => {
    it('应该调用 sseSink 分发事件', async () => {
      const mockSseSink = vi.fn();

      // 中文备注：tick 的 eventHandler 是第二个参数（由 LlmNode 透传），不是 input 内的字段
      mockReasonerTick.mockImplementation(async (_input: unknown, eventHandler?: (e: unknown) => void) => {
        eventHandler?.({ type: 'thought', content: 'test' });
        return {
          decision: { kind: 'yield' },
          newEvents: [],
        };
      });

      const node = createNode();
      const state: EngineState = {
        nodeId: 'llm',
        local: {
          conversationId: 'conv_1',
          request: { query: 'test', promptKey: 'default', maxSteps: 10, enableTools: false },
          sseSink: mockSseSink,
          history: [],
        },
      };

      await node.run(state);

      expect(mockSseSink).toHaveBeenCalled();
    });

    it('应该处理 sseSink 错误而不崩溃', async () => {
      const mockSseSink = vi.fn(() => {
        throw new Error('SSE failed');
      });

      // 中文备注：tick 的 eventHandler 是第二个参数（由 LlmNode 透传），不是 input 内的字段
      mockReasonerTick.mockImplementation(async (_input: unknown, eventHandler?: (e: unknown) => void) => {
        eventHandler?.({ type: 'thought', content: 'test' });
        return {
          decision: { kind: 'yield' },
          newEvents: [],
        };
      });

      const node = createNode();
      const state: EngineState = {
        nodeId: 'llm',
        local: {
          conversationId: 'conv_1',
          request: { query: 'test', promptKey: 'default', maxSteps: 10, enableTools: false },
          sseSink: mockSseSink,
          history: [],
        },
      };

      // 不应该抛出错误
      await expect(node.run(state)).resolves.toBeDefined();
    });
  });
});
