/**
 * ToolNode 把“工具结果接下来交给的模型”注入 ToolContext.activeModelId。
 *
 * 中文备注：云端额度兜底后 run 锁定到兜底模型（executorLocal.runLockedModelId），工具若仍按选定模型
 * 判断（如附图），下一次请求会给不能看图的兜底模型带图而在输入预检被拒。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolNode } from '../toolNode';
import type { EngineState } from '../../types';
import type { ObservationPreviewPort, ToolRuntimePort } from '../../../tools/ports';
import type { ToolExecutionContext } from '../../../tools/toolExecutionContext';
import { createRuntimeEventRecorder } from '../../../../testkit';
import { ToolCallIdSchema } from '../../../../contracts';

const { getToolDefinitionMock, executeToolMock } = vi.hoisted(() => ({
  getToolDefinitionMock: vi.fn(),
  executeToolMock: vi.fn(),
}));

function stateWith(executorLocal: Record<string, unknown> | undefined): EngineState {
  return {
    nodeId: 'tool',
    local: {
      conversationId: 'conv_active_model',
      turnId: 'turn_active_model',
      runtimeEventSink: createRuntimeEventRecorder({ conversationId: 'conv_active_model', runId: 'run_active_model' }).sink,
      toolContext: { modelId: 'vision-model' },
      ...(executorLocal ? { executorLocal } : {}),
      pendingToolCalls: [
        { id: ToolCallIdSchema.parse('call_screenshot'), type: 'function' as const, function: { name: 'screenshot', arguments: '{}' } },
      ],
    },
  };
}

describe('ToolNode - activeModelId', () => {
  let node: ToolNode;
  let seen: ToolExecutionContext | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    seen = undefined;
    getToolDefinitionMock.mockReturnValue({ parameters: { type: 'object', properties: {} } });
    executeToolMock.mockImplementation(async (_name: string, _args: unknown, context: ToolExecutionContext) => {
      seen = { modelId: context.modelId, activeModelId: context.activeModelId };
      return { success: true, result: JSON.stringify({ data: {}, observation: 'ok' }) };
    });
    const runtime: Pick<ToolRuntimePort, 'getToolDefinition' | 'executeTool'> = {
      getToolDefinition: getToolDefinitionMock,
      executeTool: executeToolMock,
    };
    const preview: ObservationPreviewPort = {
      truncateObservation: vi.fn<ObservationPreviewPort['truncateObservation']>(async ({ text }) => ({ truncated: false, preview: text })),
    };
    node = new ToolNode({ toolRuntime: runtime, observationPreview: preview });
  });

  it('没有兜底锁定时，工具结果交给选定模型', async () => {
    await node.run(stateWith({ stepCount: 1 }));
    expect(seen).toEqual({ modelId: 'vision-model', activeModelId: 'vision-model' });
  });

  it('云端额度兜底锁定后，工具看到的是兜底模型，选定模型不变（child-run 继承仍读 modelId）', async () => {
    await node.run(stateWith({ stepCount: 2, runLockedModelId: 'text-only-fallback' }));
    expect(seen).toEqual({ modelId: 'vision-model', activeModelId: 'text-only-fallback' });
  });
});
