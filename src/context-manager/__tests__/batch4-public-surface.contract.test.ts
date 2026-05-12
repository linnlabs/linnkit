import { describe, expect, it } from 'vitest';
import * as contextManager from '..';
import { runtimeKernel } from '../..';

describe('context-manager Batch 4 public surface', () => {
  it('exposes agent namespaces and freezes chat profile namespace exports', () => {
    expect(contextManager.agentTasks.BaseAgentTask).toBeTypeOf('function');
    expect(contextManager.agentOrchestration.AgentMessageOrchestrator).toBeTypeOf('function');
    expect(contextManager.agentTools.ToolManager).toBeTypeOf('function');
    expect(contextManager.BaseConversationalTask).toBeTypeOf('function');
    expect(contextManager.ChatMessageOrchestrator).toBeTypeOf('function');
    expect(contextManager).not.toHaveProperty('chatTasks');
    expect(contextManager).not.toHaveProperty('chatOrchestration');
    expect(contextManager).not.toHaveProperty('chatContracts');
    expect(contextManager).not.toHaveProperty('chatContext');
    expect(contextManager.CHECKPOINT_MARKER_TYPE).toBe('context_checkpoint');
  });

  it('exposes runtime assembly concrete defaults through runtime-kernel graph namespace', () => {
    expect(runtimeKernel.graph.GraphAgentExecutor).toBeTypeOf('function');
    expect(runtimeKernel.graph.LlmNode).toBeTypeOf('function');
  });
});
