import { describe, expect, it } from 'vitest';
import {
  createToolCallDecisionEvent,
  createToolOutputEvent,
  createUserInputEvent,
  defineContextPolicy,
  type AgentSpecContextPolicyInput,
  type ContextUsageSnapshot,
  type HistorySummaryEvent,
  type RuntimeEvent,
} from '../../../contracts';
import type {
  CanonicalInferenceEvent,
  CanonicalInferencePort,
  CanonicalInferenceRequest,
  TokenizerPort,
} from '../../../ports';
import { AgentMessageOrchestrator, type AgentProcessingResult } from '../../../context-manager/profiles/agent/orchestration/AgentMessageOrchestrator';
import { AgentCoreContextProvider, AgentWorkingMemoryProvider, ContextProviderRegistry } from '../../../context-manager/profiles/agent/context/providers';
import { ToolManager } from '../../../context-manager/profiles/agent/tools/ToolManager';
import type { IAgentTask } from '../../../context-manager/profiles/agent/tasks/base';
import { formatAgentLlmMessages } from '../../../context-manager/shared/MessageFormatter';
import { LlmCaller } from '../../llm/caller';
import type { ModelCatalogEntry, ModelCatalogLike } from '../../llm/modelCatalog';
import { GraphAgentExecutor } from '../executor';
import type { GraphExecutorContextBuilder } from '../executorContextBuilder';

const checkpoint = `<context-checkpoint version="1" trust="untrusted-memory">
## Current Goal
Complete the task.
## Hard Constraints
Keep verified evidence.
## Completed Work
Earlier records were read.
## Key Facts and Evidence
The records are synthetic.
## Artifacts and External Handles
No external artifacts.
## Failures and Lessons
No failures.
## Open Work
Respond to the current request.
## Next Action
Complete the response.
</context-checkpoint>`;

// 用带 token 标记的合成记录控制水位，实际构建、压缩、计量及 Provider 请求均走正式链。
const tokenizer: TokenizerPort = {
  estimateText: text => Math.ceil(text.length / 4),
  estimateMessage: message => {
    const text = typeof message.content === 'string' ? message.content : '';
    const marker = /\[tokens:(\d+)\]/u.exec(text);
    return marker ? Number(marker[1]) : Math.ceil(text.length / 4) + 4;
  },
};
const task: IAgentTask = {
  name: 'output-budget-test',
  buildMessages: (request, history) => [
    { id: 'system', role: 'system', type: 'system_prompt', content: 'Complete the task.', timestamp: 0 },
    ...history,
    { id: 'current-user', role: 'user', type: 'user_input', content: request.query, timestamp: 100 },
  ],
  processResponse: response => response,
  processStreamChunk: chunk => chunk,
};

function createHarness(input: {
  window?: number;
  maxOutput?: number;
  policy?: AgentSpecContextPolicyInput;
  remoteTokens?: number;
  retryOnce?: boolean;
  fallbackRemoteTokens?: number;
} = {}) {
  const model: ModelCatalogEntry = {
    id: 'capacity-model', enabled: true, capabilities: ['chat', 'tool_calling'],
    inference_route: {
      context_window_tokens: input.window ?? 1_048_576,
      max_output_tokens: input.maxOutput ?? 1_048_576,
    },
    token_route: { capabilityId: 'test', modelId: 'capacity-model', capabilities: { supportsRemoteTokenCount: true } },
  };
  const fallbackModel: ModelCatalogEntry = {
    ...model, id: 'fallback-model',
    token_route: { capabilityId: 'test-fallback', modelId: 'fallback-model', capabilities: { supportsRemoteTokenCount: true } },
  };
  const catalog: ModelCatalogLike = {
    getModelById: id => id === model.id ? model : id === fallbackModel.id ? fallbackModel : undefined,
    getModelsByCapability: () => [model, fallbackModel], getModelsByUIVisibility: () => [model, fallbackModel],
  };
  const policy = defineContextPolicy(input.policy);
  const providers = new ContextProviderRegistry();
  providers.register(new AgentCoreContextProvider());
  providers.register(new AgentWorkingMemoryProvider());
  const orchestrator = new AgentMessageOrchestrator({
    tokenBudget: { maxTokens: 256_000, reservedForResponse: 16_384 },
    processing: {}, taskResolver: () => task, providerRegistry: providers,
    tokenizer, resolveContextPolicy: () => policy,
  });
  const toolManager = new ToolManager({
    getTool: () => undefined, getAvailableToolNames: () => ['read_record'],
    validateToolCall: () => ({ success: true }),
  });
  const route = model.inference_route;
  if (!route) throw new Error('Test model route is required.');
  const projectContext = (processed: AgentProcessingResult) => ({
    llmMessages: formatAgentLlmMessages(processed.messages),
    promptBudget: processed.promptBudget,
    promptUsageMeasurementPolicy: {
      remote_count_enabled: input.remoteTokens !== undefined,
      remote_count_failure_behavior: 'fail-fast' as const,
      token_route: model.token_route,
    },
    contextCompactionCandidate: processed.contextBuildResult.contextCompactionCandidate,
    contextCompactionPolicy: processed.contextBuildResult.contextCompactionPolicy,
  });
  const build: GraphExecutorContextBuilder['build'] = async buildInput => {
    const processed = await orchestrator.processAgentConversation(buildInput.request, buildInput.history, toolManager, {
      promptBudgetLimits: {
        modelContextWindowTokens: route.context_window_tokens,
        modelMaxOutputTokens: route.max_output_tokens,
        toolDefinitionTokens: buildInput.toolDefinitionTokens,
      },
    });
    return projectContext(processed);
  };
  const contextBuilder: GraphExecutorContextBuilder = {
    build,
    async applyCompaction(applyInput) {
      const result = await orchestrator.applyContextCompaction(applyInput.request, applyInput.history, toolManager, {
        id: applyInput.summaryId, conversationId: applyInput.conversationId, turnId: applyInput.turnId,
        timestamp: applyInput.timestamp, checkpointContent: applyInput.checkpointContent,
        plan: applyInput.plan, maxOutputTokens: applyInput.maxOutputTokens,
        promptBudgetLimits: {
          modelContextWindowTokens: route.context_window_tokens,
          modelMaxOutputTokens: route.max_output_tokens,
          toolDefinitionTokens: applyInput.toolDefinitionTokens,
        },
      });
      if (result.kind !== 'ready') return result;
      return {
        kind: 'ready', rebuiltContext: projectContext(result.processingResult),
        pendingSummaryEvent: result.pendingSummaryEvent, compressionRatio: result.compressionRatio,
        summaryTokenEstimate: result.summaryTokenEstimate,
      };
    },
  };
  const requests: CanonicalInferenceRequest[] = [];
  const order: string[] = [];
  const inferencePort: CanonicalInferencePort = {
    async *stream(request): AsyncIterable<CanonicalInferenceEvent> {
      requests.push(request);
      yield { type: 'start', model_id: request.model_id, attempt_id: request.invocation.attempt_id };
      if (requests.length === 1 && (input.retryOnce || input.fallbackRemoteTokens !== undefined)) {
        yield { type: 'failure', kind: 'transport', code: 'connection_reset', retryable: true };
        return;
      }
      const isCompaction = request.tool_choice === 'none';
      order.push(isCompaction ? 'summary-call' : 'main-call');
      yield { type: 'answer_delta', text: isCompaction ? checkpoint : 'done' };
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const committed: HistorySummaryEvent[] = [];
  const caller = new LlmCaller({
    inferencePort, modelCatalog: catalog, maxRetries: 1, retryDelayMs: 0,
    modelResolver: { resolveModelId: id => id ?? model.id, pickFallbackChatModel: () => fallbackModel.id },
    policyEngine: { decideOnError: () => input.fallbackRemoteTokens !== undefined
      ? { action: 'switch_model', reason: 'test route switch' } : { action: 'none' } },
  });
  const executor = new GraphAgentExecutor({
    modelCatalog: catalog, modelResolver: { resolveModelId: () => model.id }, llmCaller: caller, contextBuilder, tokenizer,
    toolRuntime: {
      getToolDefinition: () => undefined,
      getToolSchemas: () => [{ type: 'function', function: { name: 'read_record', description: 'Read a synthetic record.', parameters: { type: 'object', properties: {} } } }],
    },
    ...(input.remoteTokens !== undefined ? { tokenCounter: { countMessages: async request => ({
      inputTokens: request.route.modelId === fallbackModel.id
        ? input.fallbackRemoteTokens ?? 0 : input.remoteTokens ?? 0,
      source: 'provider-preflight-count' as const, confidence: 'provider-estimate' as const,
    }) } } : {}),
    resolveTokenRoute: id => catalog.getModelById(id)?.token_route,
  });
  return {
    requests, committed, order, caller,
    tick: (query = 'Hello', history: RuntimeEvent[] = [], stream = false) => executor.tick({
      request: { query, promptKey: 'output-budget-test', model_id: model.id, enableTools: true }, history, stream,
      toolContext: { conversationId: 'budget-conversation', turnId: 'budget-turn' },
      runtimeEventCommitPort: async event => { if (event.type === 'history_summary') { committed.push(event); order.push('commit'); } },
    }, event => { if (event.type === 'history_summary') order.push('publish'); }),
  };
}

describe('模型容量与实际输出预算的完整调用链', () => {
  it.each([false, true])('1M 窗口 / 1M 输出首轮可调用，stream=%s 的请求和快照使用同一剩余窗口', async stream => {
    const f = createHarness();
    const result = await f.tick('Hello', [], stream);
    expect(result.decision).toEqual({ kind: 'final_answer', answer: 'done' });
    expect(f.requests).toHaveLength(1);
    const usage = result.contextUsage;
    if (!usage) throw new Error('Successful attempt must publish context usage.');
    expect(usage.input_budget_tokens).toBe(1_048_575);
    expect(usage.output_limit_tokens).toBe(1_048_576 - usage.used_tokens);
    expect(f.requests[0]?.sampling.max_output_tokens).toBe(usage.output_limit_tokens);
    expect(usage.components.tool_definition_tokens).toBeGreaterThan(0);
  });

  it('显式响应预留继续收窄输入和输出，并以 remote count 确认实际请求', async () => {
    const f = createHarness({ policy: { budget: { reservedForResponse: 16_384 } }, remoteTokens: 1234 });
    const result = await f.tick();
    expect(result.contextUsage).toMatchObject({ used_tokens: 1234, input_budget_tokens: 1_032_192, output_limit_tokens: 16_384 });
    expect(f.requests[0]?.sampling.max_output_tokens).toBe(16_384);
  });

  it('动态输出同时尊重模型输出能力和 Agent 显式窗口上限', async () => {
    const capped = createHarness({ maxOutput: 32_768 });
    await capped.tick();
    expect(capped.requests[0]?.sampling.max_output_tokens).toBe(32_768);

    const small = createHarness({ policy: { budget: { maxTokens: 4_096 } } });
    const result = await small.tick();
    expect(result.contextUsage?.input_budget_tokens).toBe(4_095);
    expect(small.requests[0]?.sampling.max_output_tokens).toBe(4_096 - (result.contextUsage?.used_tokens ?? 0));
  });

  it('remote count 决定动态输出，真实重试使用同一接纳预算', async () => {
    const f = createHarness({ remoteTokens: 1234, retryOnce: true });
    const result = await f.tick('Hello', [], true);
    expect(f.requests).toHaveLength(2);
    expect(f.requests.map(request => request.sampling.max_output_tokens)).toEqual([1_047_342, 1_047_342]);
    expect(result.contextUsage).toMatchObject({ used_tokens: 1234, output_limit_tokens: 1_047_342 });
  });

  it('独立 caller 的显式输出上限不会被注入的计量快照放大', async () => {
    const f = createHarness();
    let succeededUsage: ContextUsageSnapshot | undefined;
    await f.caller.callWithRetries('capacity-model', [{ role: 'user', content: 'Hello' }], { max_tokens: 64 },
      undefined, undefined, { onLlmAttemptSucceeded: (_model, usage) => { succeededUsage = usage; } }, {
        measurePromptUsage: async () => ({
          basis: 'last_completed_llm_prompt', budget_model_id: 'capacity-model', used_tokens: 1000,
          components: { system_prompt_tokens: 0, conversation_tokens: 1000, tool_definition_tokens: 0 },
          component_attribution: 'normalized_local_estimate', input_budget_tokens: 1_048_575,
          remaining_tokens: 1_047_575, output_limit_tokens: 1_047_576,
          source: 'test-fixture', confidence: 'estimate', measured_at: 1,
        }),
      });
    expect(f.requests[0]?.sampling.max_output_tokens).toBe(64);
    expect(succeededUsage?.output_limit_tokens).toBe(64);
  });

  it('fallback 保留本次已请求的输出量，重新计量且只提交成功模型的快照', async () => {
    const f = createHarness({ remoteTokens: 1000, fallbackRemoteTokens: 800 });
    const result = await f.tick();
    expect(f.requests.map(request => request.model_id)).toEqual(['capacity-model', 'fallback-model']);
    expect(result.contextUsage).toMatchObject({ served_model_id: 'fallback-model', used_tokens: 800, output_limit_tokens: 1_047_576 });
    expect(f.requests[1]?.sampling.max_output_tokens).toBe(1_047_576);
  });

  it('fallback 重测后输入与本次输出合计超窗口时，在第二次 Provider 请求前拒绝', async () => {
    const f = createHarness({ remoteTokens: 1000, fallbackRemoteTokens: 1100 });
    await expect(f.tick()).rejects.toMatchObject({
      errorCode: 'llm.prompt.input_budget_exceeded',
      metadata: { modelId: 'fallback-model', usedTokens: 1100, inputBudgetTokens: 1000 },
    });
    expect(f.requests).toHaveLength(1);
  });

  it('输入占满窗口时在 Provider 前明确失败', async () => {
    const f = createHarness({ remoteTokens: 1_048_576, policy: { compaction: { enabled: false } } });
    await expect(f.tick()).rejects.toMatchObject({ errorCode: 'llm.prompt.input_budget_exceeded' });
    expect(f.requests).toEqual([]);
  });

  it('长历史先压缩并持久提交，再按重建后的剩余窗口生成主回答', async () => {
    const f = createHarness({ window: 16_384, maxOutput: 16_384, policy: { compaction: { maxOutputTokens: 16_384 } } });
    const history: RuntimeEvent[] = [
      createUserInputEvent('old-user', 'budget-conversation', 'old-turn', 'Read the records.', { timestamp: 1 }),
      ...Array.from({ length: 3 }, (_, i) => [
        createToolCallDecisionEvent(`decision-${i}`, 'budget-conversation', 'old-turn', 'read_record', `call-${i}`, {
          timestamp: i * 2 + 2, args: {},
        }),
        createToolOutputEvent(`output-${i}`, 'budget-conversation', 'old-turn', 'read_record', `call-${i}`, {
          status: 'success', observation: `Synthetic record [tokens:4400]`, data: null,
        }, { timestamp: i * 2 + 3 }),
      ]).flat(),
    ];
    const result = await f.tick('Complete the task.', history);
    expect(result.decision).toEqual({ kind: 'final_answer', answer: 'done' });
    expect(f.order).toEqual(['summary-call', 'commit', 'publish', 'main-call']);
    expect(f.committed).toHaveLength(1);
    expect(f.requests[0]?.sampling.max_output_tokens).toBeGreaterThan(0);
    expect(f.requests[0]?.sampling.max_output_tokens).toBeLessThan(16_384);
    const usage = result.contextUsage;
    if (!usage) throw new Error('Successful attempt must publish context usage.');
    expect(usage.used_tokens).toBeLessThan(16_383 * 0.8);
    expect(f.requests[1]?.sampling.max_output_tokens).toBe(16_384 - usage.used_tokens);
    expect(usage.output_limit_tokens).toBe(f.requests[1]?.sampling.max_output_tokens);
  });
});
