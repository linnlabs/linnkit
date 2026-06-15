/**
 * @file src/core/graph-engine/__tests__/graph-executor.test.ts
 * @description GraphExecutor 核心单元测试
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphExecutor } from '../engine';
import type { Checkpointer } from '../checkpointer/base';
import type { EngineState, GraphNode, NodeResult } from '../types';

describe('GraphExecutor - 核心单元测试', () => {
  let mockCheckpointer: Checkpointer;
  let executor: GraphExecutor;

  beforeEach(() => {
    mockCheckpointer = {
      save: vi.fn<Checkpointer['save']>().mockResolvedValue(undefined),
      load: vi.fn<Checkpointer['load']>().mockResolvedValue(null),
      clear: vi.fn<Checkpointer['clear']>().mockResolvedValue(undefined),
    };

    executor = new GraphExecutor(mockCheckpointer, { maxSteps: 10 });
  });

  describe('1. 基础功能测试', () => {
    it('应该正确注册和执行节点', async () => {
      const mockNode: GraphNode = {
        id: 'test',
        run: vi.fn().mockResolvedValue({ kind: 'yield', events: [] }),
      };

      executor.registerNode(mockNode);
      
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'test',
        local: {},
      });

      await executor.runUntilYield('conv_1');

      expect(mockNode.run).toHaveBeenCalled();
    });

    it('应该在 prime 时设置初始状态', async () => {
      const initialLocal = { stepCount: 0, userId: '123' };

      await executor.prime('conv_1', initialLocal, 'user');

      expect(mockCheckpointer.save).toHaveBeenCalledWith('conv_1', {
        nodeId: 'user',
        local: { stepCount: 0, userId: '123' },
        schemaVersion: 1,
      });
    });

    it('应该在 prime 时移除 memory 字段', async () => {
      await executor.prime('conv_1', { memory: {}, stepCount: 0 }, 'user');

      const saveCall = vi.mocked(mockCheckpointer.save).mock.calls[0];
      expect(saveCall[1].local).not.toHaveProperty('memory');
    });

    it('应该正确使用 setNode 切换节点', async () => {
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'user',
        local: { stepCount: 1 },
      });

      await executor.setNode('conv_1', 'llm');

      expect(mockCheckpointer.save).toHaveBeenCalledWith('conv_1', {
        nodeId: 'llm',
        local: { stepCount: 1 },
        schemaVersion: 1,
      });
    });
  });

  describe('2. 执行循环测试', () => {
    it('应该正确执行单步路由', async () => {
      const userNode: GraphNode = {
        id: 'user',
        run: vi.fn().mockResolvedValue({
          kind: 'route',
          nextNodeId: 'llm',
          events: [{ type: 'user_input', content: 'hello' }],
        }),
      };
      const llmNode: GraphNode = {
        id: 'llm',
        run: vi.fn().mockResolvedValue({
          kind: 'yield',
          events: [{ type: 'final_answer', content: 'hi' }],
        }),
      };

      executor.registerNode(userNode);
      executor.registerNode(llmNode);

      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'user',
        local: {},
      });

      const result = await executor.runUntilYield('conv_1');

      expect(result.events).toHaveLength(2);
      expect(result.stepCount).toBe(2);
    });

    it('应该支持多步路由链', async () => {
      const nodes = ['node1', 'node2', 'node3'].map((id, i) => ({
        id,
        run: vi.fn().mockResolvedValue({
          kind: i === 2 ? 'yield' : 'route',
          nextNodeId: `node${i + 2}`,
          events: [{ type: `event${i + 1}` }],
        }),
      }));

      nodes.forEach((n) => executor.registerNode(n));

      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'node1',
        local: {},
      });

      const result = await executor.runUntilYield('conv_1');

      expect(result.stepCount).toBe(3);
      expect(result.events).toHaveLength(3);
    });

    it('应该在 yield 时正确暂停', async () => {
      const node: GraphNode = {
        id: 'wait',
        run: vi.fn().mockResolvedValue({
          kind: 'yield',
          events: [{ type: 'waiting' }],
        }),
      };

      executor.registerNode(node);
      
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'wait',
        local: {},
      });

      const result = await executor.runUntilYield('conv_1');

      expect(result.stepCount).toBe(1);
      expect(result.events).toHaveLength(1);
      expect(result.checkpoint.nodeId).toBe('wait');
    });

    it('应该在 pause 时正确暂停', async () => {
      const node: GraphNode = {
        id: 'wait-user',
        run: vi.fn().mockResolvedValue({
          kind: 'pause',
          events: [{ type: 'waiting_user' }],
        }),
      };

      executor.registerNode(node);
      
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'wait-user',
        local: {},
      });

      const result = await executor.runUntilYield('conv_1');

      expect(result.stepCount).toBe(1);
      expect(result.checkpoint.nodeId).toBe('wait-user');
    });

    it('应该累积所有节点产生的事件', async () => {
      const node1: GraphNode = {
        id: 'node1',
        run: vi.fn().mockResolvedValue({
          kind: 'route',
          nextNodeId: 'node2',
          events: [{ type: 'event1' }, { type: 'event2' }],
        }),
      };
      const node2: GraphNode = {
        id: 'node2',
        run: vi.fn().mockResolvedValue({
          kind: 'yield',
          events: [{ type: 'event3' }],
        }),
      };

      executor.registerNode(node1);
      executor.registerNode(node2);
      
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'node1',
        local: {},
      });

      const result = await executor.runUntilYield('conv_1');

      expect(result.events).toHaveLength(3);
    });

    it('应该准确记录执行的步数', async () => {
      const nodes = [1, 2, 3, 4, 5].map((i) => ({
        id: `node${i}`,
        run: vi.fn().mockResolvedValue({
          kind: i === 5 ? 'yield' : 'route',
          nextNodeId: `node${i + 1}`,
          events: [],
        }),
      }));

      nodes.forEach((n) => executor.registerNode(n));
      
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'node1',
        local: {},
      });

      const result = await executor.runUntilYield('conv_1');

      expect(result.stepCount).toBe(5);
    });

    it('应该在达到 maxSteps 时停止执行', async () => {
      const loopNode: GraphNode = {
        id: 'loop',
        run: vi.fn().mockResolvedValue({
          kind: 'route',
          nextNodeId: 'loop',
          events: [{ type: 'loop_event' }],
        }),
      };

      executor.registerNode(loopNode);
      
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'loop',
        local: {},
      });

      const result = await executor.runUntilYield('conv_1');

      expect(result.stepCount).toBe(10);
      // 中文备注：
      // - 当前 `maxSteps` 语义统计的是“节点切换次数”，不是“原节点 run 次数”；
      // - 在最后一步，GraphExecutor 会先应用 `force_final_answer` 收尾策略，
      //   将 nodeId 从 `loop` 强制切到 `llm`；
      // - 因此这里应验证：
      //   1) 总步数仍达到 10；
      //   2) 原 loop 节点在前 9 步被执行；
      //   3) 第 10 步用于收尾切换，而不是继续跑 loop。
      expect(loopNode.run).toHaveBeenCalledTimes(9);
    });

    it('应该支持自定义 maxSteps', async () => {
      const customExecutor = new GraphExecutor(mockCheckpointer, { maxSteps: 3 });
      
      const loopNode: GraphNode = {
        id: 'loop',
        run: vi.fn().mockResolvedValue({
          kind: 'route',
          nextNodeId: 'loop',
          events: [],
        }),
      };

      customExecutor.registerNode(loopNode);
      
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'loop',
        local: {},
      });

      const result = await customExecutor.runUntilYield('conv_1');

      expect(result.stepCount).toBe(3);
    });
  });

  describe('3. 状态管理测试', () => {
    it('应该正确加载已保存的状态', async () => {
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'saved',
        local: { count: 5 },
      });

      const node: GraphNode = {
        id: 'saved',
        run: vi.fn((state) => {
          expect(state.local?.count).toBe(5);
          return Promise.resolve({ kind: 'yield', events: [] } satisfies NodeResult);
        }),
      };

      executor.registerNode(node);
      await executor.runUntilYield('conv_1');

      expect(node.run).toHaveBeenCalled();
    });

    it('应该正确合并 checkpoint 和 ephemeral 状态', async () => {
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'test',
        local: { persistent: 'data', count: 1 },
      });

      await executor.prime('conv_1', { memory: { temp: 'data' }, count: 2 }, 'test');

      const node: GraphNode = {
        id: 'test',
        run: vi.fn((state) => {
          expect(state.local?.count).toBe(2); // ephemeral 覆盖
          expect(state.local?.persistent).toBe('data'); // persistent 保留
          expect(state.local?.memory).toBeDefined(); // memory 存在
          return Promise.resolve({ kind: 'yield', events: [] } satisfies NodeResult);
        }),
      };

      executor.registerNode(node);
      await executor.runUntilYield('conv_1');

      expect(node.run).toHaveBeenCalled();
    });
  });

  describe('4. 错误处理', () => {
    it('应该在没有可执行节点时正确返回', async () => {
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'nonexistent',
        local: {},
      });

      const result = await executor.runUntilYield('conv_1');

      expect(result.events).toEqual([]);
      expect(result.stepCount).toBe(1);
    });

    it('应该在路由到不存在的节点时停止', async () => {
      const node: GraphNode = {
        id: 'start',
        run: vi.fn().mockResolvedValue({
          kind: 'route',
          nextNodeId: 'nonexistent',
          events: [{ type: 'routed' }],
        }),
      };

      executor.registerNode(node);
      
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'start',
        local: {},
      });

      const result = await executor.runUntilYield('conv_1');

      expect(result.stepCount).toBe(2);
      expect(result.events).toHaveLength(1);
    });

    it('应该传播节点执行错误', async () => {
      const testError = new Error('Node execution failed');
      const node: GraphNode = {
        id: 'failing',
        run: vi.fn().mockRejectedValue(testError),
      };

      executor.registerNode(node);
      
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'failing',
        local: {},
      });

      await expect(executor.runUntilYield('conv_1')).rejects.toThrow(
        'Node execution failed'
      );
    });

    it('应该传播 checkpointer.save 错误', async () => {
      const saveError = new Error('Save failed');
      vi.mocked(mockCheckpointer.save).mockRejectedValue(saveError);

      await expect(executor.prime('conv_1', {}, 'test')).rejects.toThrow('Save failed');
    });

    it('应该传播 checkpointer.load 错误', async () => {
      const loadError = new Error('Load failed');
      vi.mocked(mockCheckpointer.load).mockRejectedValue(loadError);

      await expect(executor.runUntilYield('conv_1')).rejects.toThrow('Load failed');
    });

    it('应该处理 route 没有 nextNodeId 的情况', async () => {
      const testNode: GraphNode = {
        id: 'test',
        run: vi.fn().mockResolvedValue({
          kind: 'route',
          // nextNodeId 缺失，引擎会使用默认值 'user'
          events: [],
        }),
      };
      const userNode: GraphNode = {
        id: 'user',
        run: vi.fn().mockResolvedValue({ kind: 'yield', events: [] }),
      };

      executor.registerNode(testNode);
      executor.registerNode(userNode);
      
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'test',
        local: {},
      });

      const result = await executor.runUntilYield('conv_1');

      expect(result.stepCount).toBe(2);
    });
  });

  describe('5. B2-engine Batch 3: graph_node telemetry', () => {
    it('每次 node.run 都会 emit 一次 graph_node 事件，含 nodeId/durationMs/scope', async () => {
      const emit = vi.fn();
      const telemetryExecutor = new GraphExecutor(mockCheckpointer, {
        maxSteps: 10,
        telemetryPort: { emit },
      });

      const node: GraphNode = {
        id: 'test',
        run: vi.fn().mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 5));
          return { kind: 'yield', events: [] } as NodeResult;
        }),
      };
      telemetryExecutor.registerNode(node);

      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'test',
        local: { conversationId: 'runtime_conversation', turnId: 'turn_x' },
      } as EngineState);

      await telemetryExecutor.runUntilYield('checkpoint_telemetry');

      const graphNodeEvents = emit.mock.calls
        .map((c) => c[0])
        .filter((e) => e.kind === 'graph_node');
      expect(graphNodeEvents).toHaveLength(1);
      const event = graphNodeEvents[0];
      expect(event.nodeId).toBe('test');
      expect(typeof event.durationMs).toBe('number');
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(event.scope).toEqual({
        conversationId: 'runtime_conversation',
        turnId: 'turn_x',
      });
    });

    it('多步路由：每次 node 切换都各自 emit graph_node', async () => {
      const emit = vi.fn();
      const telemetryExecutor = new GraphExecutor(mockCheckpointer, {
        maxSteps: 10,
        telemetryPort: { emit },
      });

      const start: GraphNode = {
        id: 'start',
        run: vi.fn().mockResolvedValue({ kind: 'route', nextNodeId: 'end', events: [] }),
      };
      const end: GraphNode = {
        id: 'end',
        run: vi.fn().mockResolvedValue({ kind: 'yield', events: [] }),
      };
      telemetryExecutor.registerNode(start);
      telemetryExecutor.registerNode(end);

      vi.mocked(mockCheckpointer.load).mockResolvedValue({ nodeId: 'start', local: {} } as EngineState);

      await telemetryExecutor.runUntilYield('conv_multi');

      const graphNodeEvents = emit.mock.calls
        .map((c) => c[0])
        .filter((e) => e.kind === 'graph_node');
      expect(graphNodeEvents).toHaveLength(2);
      expect(graphNodeEvents[0].nodeId).toBe('start');
      expect(graphNodeEvents[1].nodeId).toBe('end');
    });

    it('node.run 抛错时仍然 emit graph_node（try/finally 兜底）', async () => {
      const emit = vi.fn();
      const telemetryExecutor = new GraphExecutor(mockCheckpointer, {
        maxSteps: 10,
        telemetryPort: { emit },
      });

      const exploding: GraphNode = {
        id: 'boom',
        run: vi.fn().mockRejectedValue(new Error('boom')),
      };
      telemetryExecutor.registerNode(exploding);
      vi.mocked(mockCheckpointer.load).mockResolvedValue({ nodeId: 'boom', local: {} } as EngineState);

      await expect(telemetryExecutor.runUntilYield('conv_boom')).rejects.toThrow('boom');
      const graphNodeEvents = emit.mock.calls
        .map((c) => c[0])
        .filter((e) => e.kind === 'graph_node');
      expect(graphNodeEvents).toHaveLength(1);
      expect(graphNodeEvents[0]).toMatchObject({ kind: 'graph_node', nodeId: 'boom' });
    });

    it('未传 telemetryPort 时使用 noopTelemetry，不影响行为', async () => {
      // 已经在 beforeEach 中创建的默认 executor 跑通即可
      const node: GraphNode = {
        id: 'test',
        run: vi.fn().mockResolvedValue({ kind: 'yield', events: [] }),
      };
      executor.registerNode(node);
      vi.mocked(mockCheckpointer.load).mockResolvedValue({ nodeId: 'test', local: {} } as EngineState);

      await expect(executor.runUntilYield('conv_default')).resolves.toBeDefined();
    });
  });

  describe('6. B2-engine Batch 4: run_lifecycle telemetry', () => {
    function createEmittingExecutor(emit: ReturnType<typeof vi.fn>): GraphExecutor {
      return new GraphExecutor(mockCheckpointer, {
        maxSteps: 10,
        telemetryPort: { emit },
      });
    }

    it('正常 yield 路径：先 spawned 后 completed，runId 一致', async () => {
      const emit = vi.fn();
      const exec = createEmittingExecutor(emit);
      const node: GraphNode = {
        id: 'test',
        run: vi.fn().mockResolvedValue({ kind: 'yield', events: [] }),
      };
      exec.registerNode(node);
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'test',
        local: { conversationId: 'runtime_lifecycle', turnId: 'turn_lifecycle' },
      } as EngineState);

      await exec.runUntilYield('checkpoint_lifecycle');

      const lifecycle = emit.mock.calls
        .map((c) => c[0])
        .filter((e) => e.kind === 'run_lifecycle');
      expect(lifecycle).toHaveLength(2);
      expect(lifecycle[0].phase).toBe('spawned');
      expect(lifecycle[1].phase).toBe('completed');
      expect(lifecycle[0].runId).toBe(lifecycle[1].runId);
      expect(lifecycle[0].runId).toMatch(/^run_/);
      expect(lifecycle[0].scope).toEqual({
        conversationId: 'runtime_lifecycle',
        turnId: 'turn_lifecycle',
      });
      expect(lifecycle[1].scope).toEqual({
        conversationId: 'runtime_lifecycle',
        turnId: 'turn_lifecycle',
      });
    });

    it('node 抛非 AbortError：phase=failed', async () => {
      const emit = vi.fn();
      const exec = createEmittingExecutor(emit);
      const node: GraphNode = {
        id: 'boom',
        run: vi.fn().mockRejectedValue(new Error('boom')),
      };
      exec.registerNode(node);
      vi.mocked(mockCheckpointer.load).mockResolvedValue({ nodeId: 'boom', local: {} } as EngineState);

      await expect(exec.runUntilYield('conv_fail')).rejects.toThrow('boom');

      const lifecycle = emit.mock.calls
        .map((c) => c[0])
        .filter((e) => e.kind === 'run_lifecycle');
      expect(lifecycle.map((e) => e.phase)).toEqual(['spawned', 'failed']);
    });

    it('AbortSignal 命中：phase=cancelled', async () => {
      const emit = vi.fn();
      const exec = createEmittingExecutor(emit);
      const node: GraphNode = {
        id: 'test',
        run: vi.fn().mockResolvedValue({ kind: 'yield', events: [] }),
      };
      exec.registerNode(node);
      const abortedSignal = { aborted: true } as AbortSignal;
      vi.mocked(mockCheckpointer.load).mockResolvedValue({
        nodeId: 'test',
        local: { signal: abortedSignal },
      } as EngineState);

      await expect(exec.runUntilYield('conv_abort')).rejects.toMatchObject({ name: 'AbortError' });

      const lifecycle = emit.mock.calls
        .map((c) => c[0])
        .filter((e) => e.kind === 'run_lifecycle');
      expect(lifecycle.map((e) => e.phase)).toEqual(['spawned', 'cancelled']);
    });

    it('checkpointer.load 抛错：仍 emit spawned + failed（finally 兜底）', async () => {
      const emit = vi.fn();
      const exec = createEmittingExecutor(emit);
      vi.mocked(mockCheckpointer.load).mockRejectedValue(new Error('load fail'));

      await expect(exec.runUntilYield('conv_load_fail')).rejects.toThrow('load fail');

      const lifecycle = emit.mock.calls
        .map((c) => c[0])
        .filter((e) => e.kind === 'run_lifecycle');
      expect(lifecycle.map((e) => e.phase)).toEqual(['spawned', 'failed']);
    });
  });
});
