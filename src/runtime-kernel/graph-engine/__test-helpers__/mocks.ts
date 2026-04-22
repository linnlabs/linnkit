/**
 * @file src/core/graph-engine/__test-helpers__/mocks.ts
 * @description Mock 工厂函数 - 为图执行引擎测试提供 Mock 对象
 */

import { vi } from 'vitest';
import type { Checkpointer } from '../checkpointer/base';
import type { EngineState, GraphNode, NodeResult } from '../types';
import type { RuntimeEvent } from '../../../contracts';

/**
 * 创建 Mock Checkpointer
 */
export function createMockCheckpointer() {
  const states = new Map<string, EngineState>();

  return {
    save: vi.fn(async (conversationId: string, state: EngineState) => {
      states.set(conversationId, state);
    }),
    load: vi.fn(async (conversationId: string) => {
      return states.get(conversationId) || null;
    }),
    _states: states, // 测试辅助：访问内部状态
  } as any as Checkpointer;
}

/**
 * 创建 Mock GraphNode
 */
export function createMockNode(
  id: string,
  result: NodeResult | ((state: EngineState) => Promise<NodeResult>)
): GraphNode {
  const runFn = typeof result === 'function' ? result : async () => result;

  return {
    id,
    run: vi.fn(runFn),
  };
}

/**
 * 创建简单的 route 结果节点
 */
export function createRouteNode(id: string, nextNodeId: string, events: RuntimeEvent[] = []): GraphNode {
  return createMockNode(id, {
    kind: 'route',
    nextNodeId,
    events,
  });
}

/**
 * 创建 yield 节点
 */
export function createYieldNode(id: string, events: RuntimeEvent[] = []): GraphNode {
  return createMockNode(id, {
    kind: 'yield',
    events,
  });
}

/**
 * 创建 pause 节点
 */
export function createPauseNode(id: string, events: RuntimeEvent[] = []): GraphNode {
  return createMockNode(id, {
    kind: 'pause',
    events,
  });
}

/**
 * 创建测试用的 EngineState
 */
export function createMockEngineState(
  nodeId: string = 'user',
  local: Record<string, unknown> = {}
): EngineState {
  return {
    nodeId,
    local,
  };
}

/**
 * 创建测试用的 RuntimeEvent
 */
export function createMockEvent(type: string, overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    type: type as any,
    id: `test_${Date.now()}`,
    conversation_id: 'conv_test',
    turn_id: 'turn_test',
    timestamp: Date.now(),
    version: 1,
    ...overrides,
  } as RuntimeEvent;
}

/**
 * 创建测试用的历史事件数组
 */
export function createMockHistory(length: number = 5): RuntimeEvent[] {
  const history: RuntimeEvent[] = [];
  
  for (let i = 0; i < length; i++) {
    const isUser = i % 2 === 0;
    history.push({
      type: isUser ? 'user_input' : 'final_answer',
      id: `msg_${i}`,
      content: `Message ${i}`,
      conversation_id: 'conv_test',
      turn_id: `turn_${Math.floor(i / 2)}`,
      timestamp: Date.now() + i * 1000,
      version: 1,
      source: isUser ? 'user' : undefined,
    } as RuntimeEvent);
  }
  
  return history;
}

/**
 * 创建动态节点（可以在运行时改变行为）
 */
export function createDynamicNode(id: string) {
  let nextResult: NodeResult = { kind: 'yield', events: [] };

  const node: GraphNode = {
    id,
    run: vi.fn(async () => nextResult),
  };

  return {
    node,
    setResult: (result: NodeResult) => {
      nextResult = result;
    },
  };
}

