import { describe, expect, it } from 'vitest';
import * as contextManager from '..';
import { runtimeKernel } from '../..';

describe('context-manager Batch 4 public surface', () => {
  it('exposes compat task and orchestration namespaces for host adapters', () => {
    expect(contextManager.agentTasks.BaseAgentTask).toBeTypeOf('function');
    expect(contextManager.agentOrchestration.AgentMessageOrchestrator).toBeTypeOf('function');
    expect(contextManager.agentTools.ToolManager).toBeTypeOf('function');
    expect(contextManager.chatTasks.BaseConversationalTask).toBeTypeOf('function');
    expect(contextManager.chatOrchestration.MessageOrchestrator).toBeTypeOf('function');
    expect(contextManager.CHECKPOINT_MARKER_TYPE).toBe('context_checkpoint');
  });

  it('exposes runtime assembly concrete defaults through runtime-kernel graph namespace', () => {
    expect(runtimeKernel.graph.GraphAgentExecutor).toBeTypeOf('function');
    expect(runtimeKernel.graph.LlmNode).toBeTypeOf('function');
  });
});
