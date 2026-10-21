import { describe, expect, it, vi } from 'vitest';
import { ToolCallIdSchema } from '../../../../contracts';
import { BaseTool, type ToolArgs, type ToolParameterSchema } from '../../../tools/toolContracts';
import type { ToolRuntimePort } from '../../../tools/ports';
import type { EngineState } from '../../types';
import { ToolNode } from '../toolNode';
import { createRuntimeEventAdmissionSink } from './runtimeEventAdmissionFixture';

class SearchFixture extends BaseTool {
  readonly name = 'search_fixture';
  readonly description = 'A neutral parameter-admission fixture.';
  readonly parameters: ToolParameterSchema = {
    type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string', description: 'Query' },
      limit: { type: 'integer', description: 'Limit' },
      mode: { type: 'string', description: 'Mode' },
      node: { type: 'string', description: 'Node' },
    },
    required: ['query'],
  };

  admit(args: ToolArgs) { return this.validateArguments(args); }

  async run(): Promise<string> {
    return JSON.stringify({ data: {}, observation: 'Search completed.' });
  }
}

function pending(id: string, args: ToolArgs) {
  return [{
    id: ToolCallIdSchema.parse(id), type: 'function' as const,
    function: { name: 'search_fixture', arguments: JSON.stringify(args) },
  }];
}

describe('default argument feedback in the real tool lifecycle', () => {
  it('rejects a typo before start, returns repair hints without values, then executes a corrected call once', async () => {
    const tool = new SearchFixture();
    const execute = vi.fn<ToolRuntimePort['executeTool']>(async () => ({
      success: true, result: await tool.run(), durationMs: 0,
    }));
    const node = new ToolNode({
      observationPreview: { truncateObservation: async ({ text }) => ({ truncated: false, preview: text }) },
      toolRuntime: {
        getToolDefinition: () => ({
          parameters: tool.parameters, validateArguments: args => tool.admit(args),
        }),
        executeTool: execute,
      },
    });
    const original = { query: 'a query', limti: 'do-not-echo-this-value' };
    const state: EngineState = {
      nodeId: 'tool', local: {
        conversationId: 'argument-feedback', turnId: 'turn-argument-feedback',
        runtimeEventSink: createRuntimeEventAdmissionSink('argument-feedback', 'run-argument-feedback'),
        pendingToolCalls: pending('typo-call', original), toolContext: {},
      },
    };
    const rejected = await node.run(state);
    const failure = rejected.events.find(event => event.type === 'tool_output');
    expect(failure?.type).toBe('tool_output');
    if (failure?.type !== 'tool_output') throw new Error('Expected protocol rejection');
    expect(failure.status).toBe('error');
    expect(failure.observation).toContain('Allowed parameters:');
    expect(failure.observation).toContain('"limti" → "limit"');
    expect(failure.observation).not.toContain('do-not-echo-this-value');
    expect(rejected.events.some(event => event.type === 'tool_process')).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(original).toEqual({ query: 'a query', limti: 'do-not-echo-this-value' });

    if (!state.local) throw new Error('Expected local state');
    state.local.pendingToolCalls = pending('fixed-call', { query: 'a query', limit: 5 });
    const accepted = await node.run(state);
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[1]).toEqual({ query: 'a query', limit: 5 });
    expect(accepted.events.some(event => event.type === 'tool_output' && event.status === 'success')).toBe(true);
  });

  it('does not guess tied or unrelated field names and keeps missing-required rejection', () => {
    const tool = new SearchFixture();
    for (const unknown of ['code', 'unrelated_setting']) {
      const result = tool.admit({ query: 'q', [unknown]: 'hidden-value' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('Allowed parameters:');
      expect(result.error).not.toContain('Possible spelling corrections:');
      expect(result.error).not.toContain('hidden-value');
    }
    expect(tool.admit({})).toEqual({ success: false, error: 'Missing required parameter: query' });
  });
});
