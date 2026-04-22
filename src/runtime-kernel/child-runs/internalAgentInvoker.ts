/**
 * @file src/agent/runtime-kernel/child-runs/internalAgentInvoker.ts
 * @description 内部 Agent 调用器
 */

import { GraphExecutor } from '../graph-engine/engine';
import type { Checkpointer } from '../graph-engine/checkpointer/base';
import { MemoryCheckpointer } from '../graph-engine/checkpointer/memoryCheckpointer';
import { ToolNode } from '../graph-engine/nodes/toolNode';
import { LlmNode } from '../graph-engine/nodes/llmNode';
import { AnswerNode } from '../graph-engine/nodes/answerNode';
import { WaitUserNode } from '../graph-engine/nodes/waitUserNode';
import type { AgentInvocationRequest } from '../../ports';
import type { ObservationPreviewPort, ToolRuntimePort } from '../tools/ports';
import {
  ensureToolContextRuntimeCapability,
  stripRuntimeReservedToolContextPatch,
} from '../tools/toolContextRuntime';
import type { ChildRunParentContext, ChildRunToolContext } from './types';
import { generateMessageId } from '../../shared/ids';
import { Logger } from '../../shared/logger';
import { recordRunTranscript } from '../../shared/llmAuditRecorder';
import type { ModelResolverLike } from '../llm/modelResolver';
import type { SubRunTracePublisher } from '../subrun/subrunTrace.types';
import { FinalAnswerCollector } from './finalAnswerCollector';
import type { EngineState, GraphNode } from '../graph-engine/types';
import type { RuntimeEvent } from '../../contracts';

const logger = new Logger('InternalAgentInvoker');

type FinalizeSubrunOptions = {
  isComplete?: boolean;
};

type SubrunTraceSink = ((evt: unknown) => RuntimeEvent[]) & {
  finalize?: (options?: FinalizeSubrunOptions) => RuntimeEvent[];
};

export interface InternalAgentConfig {
  id: string;
  promptKey: string;
  availableTools?: readonly string[];
  modelPolicy?: { kind: 'fixed'; modelId: string };
  stepPolicy?: {
    kind: 'final_answer' | 'force_tools';
    lastStepsHintThreshold?: number;
    forcedTools?: readonly string[];
  };
  systemReminderRuleIds?: readonly string[];
  systemPromptBuilder?: (request: AgentInvocationRequest) => string;
  judgeToolName?: string;
}

export interface InternalAgentInvokeConfig {
  agentConfig: InternalAgentConfig;
  userMessage: string;
  parentToolContext: ChildRunParentContext;
  abortSignal?: AbortSignal;
  subrunTracePublisher?: SubRunTracePublisher;
  seedHistoryEvents?: RuntimeEvent[];
  maxSteps?: number;
  modelId?: string;
}

export interface InternalAgentInvokeResult {
  success: boolean;
  judgeToolOutput?: string;
  finalAnswer?: string;
  events: RuntimeEvent[];
  stepCount: number;
  error?: string;
}

export class InternalAgentInvoker {
  private readonly modelResolver: Pick<ModelResolverLike, 'resolveModelId'>;
  private readonly createLlmNode: () => GraphNode;
  private readonly toolRuntime: Pick<ToolRuntimePort, 'getToolDefinition' | 'executeTool'>;
  private readonly observationPreview: ObservationPreviewPort;
  private readonly eventToMessageConverter: (events: RuntimeEvent[]) => unknown[];
  private readonly defaultJudgeToolName?: string;

  constructor(dependencies: {
    modelResolver: Pick<ModelResolverLike, 'resolveModelId'>;
    createLlmNode: () => GraphNode;
    toolRuntime: Pick<ToolRuntimePort, 'getToolDefinition' | 'executeTool'>;
    observationPreview: ObservationPreviewPort;
    eventToMessageConverter: (events: RuntimeEvent[]) => unknown[];
    defaultJudgeToolName?: string;
  }) {
    this.modelResolver = dependencies.modelResolver;
    this.createLlmNode = dependencies.createLlmNode;
    this.toolRuntime = dependencies.toolRuntime;
    this.observationPreview = dependencies.observationPreview;
    this.eventToMessageConverter = dependencies.eventToMessageConverter;
    this.defaultJudgeToolName = dependencies.defaultJudgeToolName;
  }

  private createSubrunTraceSink(params: {
    publisher: SubRunTracePublisher;
    conversationId: string;
    turnId: string;
  }): SubrunTraceSink {
    const { publisher, conversationId, turnId } = params;
    const isRecord = (v: unknown): v is Record<string, unknown> => {
      return !!v && typeof v === 'object' && !Array.isArray(v);
    };

    const getString = (obj: Record<string, unknown>, key: string): string | undefined => {
      const v = obj[key];
      return typeof v === 'string' ? v : undefined;
    };

    const getNumber = (obj: Record<string, unknown>, key: string): number | undefined => {
      const v = obj[key];
      return typeof v === 'number' ? v : undefined;
    };

    const getBoolean = (obj: Record<string, unknown>, key: string): boolean | undefined => {
      const v = obj[key];
      return typeof v === 'boolean' ? v : undefined;
    };

    const normalizePhase = (
      v: string | undefined
    ): 'start' | 'update' | 'complete' | 'error' | undefined => {
      if (!v) return undefined;
      if (v === 'start' || v === 'update' || v === 'complete' || v === 'error') {
        return v;
      }
      return undefined;
    };

    const normalizeStatus = (
      v: string | undefined
    ): 'loading' | 'success' | 'error' | undefined => {
      if (!v) return undefined;
      if (v === 'loading' || v === 'success' || v === 'error') {
        return v;
      }
      return undefined;
    };

    const finalAnswerCollector = new FinalAnswerCollector(conversationId, turnId);

    const sink = (evt: unknown) => {
      if (!isRecord(evt)) {
        return [];
      }
      const type = getString(evt, 'type');
      if (!type) {
        return [];
      }

      const sourceEventId = getString(evt, 'id');
      const commonMeta: Record<string, unknown> = {
        source_event_type: type,
        ...(sourceEventId ? { source_event_id: sourceEventId } : {}),
      };

      switch (type) {
        case 'thought': {
          const delta = getString(evt, 'delta');
          const content = getString(evt, 'content');
          const isComplete = getBoolean(evt, 'is_complete') === true;

          if (delta) {
            publisher.publish({
              kind: 'thought_delta',
              delta,
              meta: commonMeta,
            });
          }

          if (isComplete) {
            publisher.publish({
              kind: 'thought_complete',
              content: content ?? '',
              meta: commonMeta,
            });
          }
          return [];
        }

        case 'tool_call_decision':
        case 'tool_process': {
          const finalized = finalAnswerCollector.finalize();
          const toolArgs = evt['tool_args'];
          publisher.publish({
            kind: type === 'tool_call_decision' ? 'tool_call_decision' : 'tool_process',
            tool_name: getString(evt, 'tool_name'),
            tool_call_id: getString(evt, 'tool_call_id'),
            phase: normalizePhase(getString(evt, 'phase')),
            status: normalizeStatus(getString(evt, 'status')),
            args: toolArgs,
            meta: {
              ...commonMeta,
            },
          });
          return finalized;
        }

        case 'observation': {
          const toolName = getString(evt, 'tool_name');
          const toolCallId = getString(evt, 'tool_call_id');
          const output = getString(evt, 'output');
          const success = getBoolean(evt, 'success');
          const durationMs = getNumber(evt, 'duration_ms');

          publisher.publish({
            kind: 'tool_output',
            tool_name: toolName,
            tool_call_id: toolCallId,
            status: success === false ? 'error' : 'success',
            output,
            duration_ms: durationMs,
            meta: commonMeta,
          });
          return [];
        }

        case 'stream_chunk': {
          const chunk = getString(evt, 'content');
          const answerId = getString(evt, 'answer_id');
          const seq = getNumber(evt, 'seq');
          const isLast = getBoolean(evt, 'is_last');

          if (chunk) {
            finalAnswerCollector.pushChunk(chunk, answerId);
            publisher.publish({
              kind: 'final_answer_chunk',
              delta: chunk,
              meta: {
                ...commonMeta,
                ...(answerId ? { answer_id: answerId } : {}),
                ...(typeof seq === 'number' ? { seq } : {}),
                ...(typeof isLast === 'boolean' ? { is_last: isLast } : {}),
              },
            });
          }
          return [];
        }

        case 'final_answer': {
          const answer = getString(evt, 'answer');
          const answerId = getString(evt, 'answer_id');
          if (answer) {
            publisher.publish({
              kind: 'final_answer',
              content: answer,
              meta: {
                ...commonMeta,
                ...(answerId ? { answer_id: answerId } : {}),
              },
            });
          }
          return [];
        }

        default: {
          return [];
        }
      }
    };

    sink.finalize = (options?: FinalizeSubrunOptions) => {
      return finalAnswerCollector.finalize({ isComplete: options?.isComplete });
    };

    return sink;
  }

  private appendUniqueEvents(target: RuntimeEvent[], events: ReadonlyArray<RuntimeEvent>): void {
    if (events.length === 0) return;

    const seenIds = new Set(target.map((event) => event.id));
    for (const event of events) {
      if (seenIds.has(event.id)) continue;
      seenIds.add(event.id);
      target.push(event);
    }
  }

  private extractJudgeToolOutput(
    events: ReadonlyArray<RuntimeEvent>,
    judgeToolName?: string,
  ): string | undefined {
    const effectiveJudgeToolName = judgeToolName ?? this.defaultJudgeToolName;
    if (typeof effectiveJudgeToolName !== 'string' || effectiveJudgeToolName.length === 0) {
      return undefined;
    }
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const evt = events[i];
      if (evt.type !== 'tool_output') continue;
      if (evt.tool_name !== effectiveJudgeToolName) continue;
      if (evt.status !== 'success') continue;
      if (typeof evt.output === 'string' && evt.output.length > 0) {
        return evt.output;
      }
    }
    return undefined;
  }

  private extractFinalAnswer(events: ReadonlyArray<RuntimeEvent>): string | undefined {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.type !== 'final_answer') continue;
      const content = typeof event.content === 'string' ? event.content : '';
      if (content.trim().length > 0) {
        return content;
      }
    }

    const chunks: Array<{ seq: number; content: string }> = [];
    for (const event of events) {
      if (event.type === 'final_answer_chunk') {
        chunks.push({ seq: event.seq, content: event.content });
      }
    }
    if (chunks.length === 0) {
      return undefined;
    }

    chunks.sort((a, b) => a.seq - b.seq);
    const stitched = chunks.map((chunk) => chunk.content).join('').trim();
    return stitched.length > 0 ? stitched : undefined;
  }

  private hasSeedHistoryPrefix(history: ReadonlyArray<RuntimeEvent>, seedHistory: ReadonlyArray<RuntimeEvent>): boolean {
    if (seedHistory.length === 0) return true;
    if (history.length < seedHistory.length) return false;

    for (let i = 0; i < seedHistory.length; i += 1) {
      const historyEvent = history[i];
      const seedEvent = seedHistory[i];
      if (!historyEvent || !seedEvent) return false;
      if (historyEvent.id !== seedEvent.id || historyEvent.type !== seedEvent.type) {
        return false;
      }
    }
    return true;
  }

  private readCheckpointHistory(checkpoint: EngineState | null): RuntimeEvent[] {
    if (!checkpoint?.local) return [];
    const history = checkpoint.local['history'];
    if (!Array.isArray(history)) return [];
    return history.filter((event): event is RuntimeEvent => {
      return !!event && typeof event === 'object' && typeof (event as RuntimeEvent).type === 'string';
    });
  }

  private async recoverEventsFromCheckpoint(params: {
    checkpointer: Checkpointer;
    conversationId: string;
    internalConversationId: string;
    seedHistory: ReadonlyArray<RuntimeEvent>;
  }): Promise<RuntimeEvent[]> {
    const checkpoint = await params.checkpointer.load(params.conversationId);
    const history = this.readCheckpointHistory(checkpoint);
    if (history.length === 0) {
      return [];
    }

    if (this.hasSeedHistoryPrefix(history, params.seedHistory)) {
      return history.slice(params.seedHistory.length);
    }

    return history.filter((event) => event.conversation_id === params.internalConversationId);
  }

  private createChildToolContext(params: {
    parentToolContext: ChildRunParentContext;
    internalConversationId: string;
    turnId: string;
    seedHistory: ReadonlyArray<RuntimeEvent>;
    abortSignal?: AbortSignal;
  }): ChildRunToolContext {
    const inheritedConversationId =
      typeof params.parentToolContext.conversationId === 'string' && params.parentToolContext.conversationId.trim().length > 0
        ? params.parentToolContext.conversationId.trim()
        : undefined;
    const inheritedContext = stripRuntimeReservedToolContextPatch(params.parentToolContext);
    const childToolContext: ChildRunToolContext = {
      ...inheritedContext,
      deepSearchDepth:
        (typeof params.parentToolContext.deepSearchDepth === 'number' ? params.parentToolContext.deepSearchDepth : 0) + 1,
      abortSignal: params.abortSignal ?? params.parentToolContext.abortSignal,
    };

    ensureToolContextRuntimeCapability({
      context: childToolContext,
      persistedHistory: params.seedHistory,
      workingHistory: params.seedHistory,
      executionMeta: {
        conversationId: inheritedConversationId ?? params.internalConversationId,
        turnId: params.turnId,
      },
    });

    return childToolContext;
  }

  async invoke(config: InternalAgentInvokeConfig): Promise<InternalAgentInvokeResult> {
    const {
      agentConfig,
      userMessage,
      parentToolContext,
      subrunTracePublisher,
      seedHistoryEvents,
      maxSteps = 8,
      modelId,
      abortSignal,
    } = config;

    const internalConversationId = `internal_${generateMessageId()}`;
    const turnId = `turn_${Date.now()}`;

    logger.info(`[InternalAgentInvoker] 启动内部 Agent: ${agentConfig.id}`, {
      conversationId: internalConversationId,
      maxSteps,
      userMessage: userMessage.slice(0, 100) + (userMessage.length > 100 ? '...' : ''),
    });

    const checkpointer = new MemoryCheckpointer();
    const graphExecutor = new GraphExecutor(checkpointer, { maxSteps });

    const llmNode = this.createLlmNode();
    const toolNode = new ToolNode({
      toolRuntime: this.toolRuntime,
      observationPreview: this.observationPreview,
    });
    const answerNode = new AnswerNode();
    const waitUserNode = new WaitUserNode();

    graphExecutor.registerNode(llmNode);
    graphExecutor.registerNode(toolNode);
    graphExecutor.registerNode(answerNode);
    graphExecutor.registerNode(waitUserNode);

    const request: AgentInvocationRequest = {
      query: userMessage,
      promptKey: agentConfig.promptKey,
      mode: 'agent',
      model_id:
        modelId ??
        (agentConfig.modelPolicy?.kind === 'fixed'
          ? agentConfig.modelPolicy.modelId
          : undefined) ??
        this.modelResolver.resolveModelId(),
      maxSteps,
      enableTools: true,
      availableTools: agentConfig.availableTools
        ? [...agentConfig.availableTools]
        : undefined,
    };

    const systemPrompt = agentConfig.systemPromptBuilder ? agentConfig.systemPromptBuilder(request) : '';

    const stepPolicy = agentConfig.stepPolicy;
    const executorLocalPolicy: Record<string, unknown> = {};
    if (stepPolicy && typeof stepPolicy === 'object' && !Array.isArray(stepPolicy)) {
      const raw = stepPolicy as Record<string, unknown>;
      const kind = raw.kind;
      if (kind === 'final_answer' || kind === 'force_tools') {
        executorLocalPolicy.finalStepPolicy = kind;
      }
      const threshold = raw.lastStepsHintThreshold;
      if (typeof threshold === 'number' && Number.isFinite(threshold)) {
        executorLocalPolicy.lastStepsHintThreshold = threshold;
      }
      const forcedTools = raw.forcedTools;
      if (Array.isArray(forcedTools)) {
        const names = forcedTools.filter((x): x is string => typeof x === 'string' && x.length > 0);
        const allowed = Array.isArray(request.availableTools)
          ? new Set(request.availableTools.filter((x): x is string => typeof x === 'string' && x.length > 0))
          : undefined;
        const finalNames = allowed ? names.filter((n) => allowed.has(n)) : names;
        if (finalNames.length > 0) {
          executorLocalPolicy.finalStepForcedTools = finalNames;
        }
      }
    }

    const srRuleIds = agentConfig.systemReminderRuleIds;
    if (Array.isArray(srRuleIds)) {
      const normalized = srRuleIds
        .map((x) => (typeof x === 'string' ? x.trim() : ''))
        .filter((x) => x.length > 0);
      if (normalized.length > 0) {
        executorLocalPolicy.systemReminderRuleIds = normalized;
      }
    }

    const seedHistory: RuntimeEvent[] = Array.isArray(seedHistoryEvents) ? seedHistoryEvents : [];

    const childToolContext = this.createChildToolContext({
      parentToolContext,
      internalConversationId,
      turnId,
      seedHistory,
      abortSignal,
    });

    const subrunSseSink: SubrunTraceSink | undefined = subrunTracePublisher
      ? this.createSubrunTraceSink({
          publisher: subrunTracePublisher,
          conversationId: internalConversationId,
          turnId,
        })
      : undefined;

    const initialLocal: Record<string, unknown> = {
      request,
      history: seedHistory,
      conversationId: internalConversationId,
      turnId,
      toolContext: childToolContext,
      ...(abortSignal ? { signal: abortSignal } : {}),
      ...(Object.keys(executorLocalPolicy).length > 0 ? { executorLocal: executorLocalPolicy } : {}),
      ...(subrunSseSink ? { sseSink: subrunSseSink } : {}),
      systemPrompt,
    };

    await graphExecutor.prime(internalConversationId, initialLocal, 'llm');

    const allEvents: RuntimeEvent[] = [];
    let stepCount = 0;
    let finalAnswer: string | undefined;
    let judgeToolOutput: string | undefined;
    let error: string | undefined;

    try {
      if (abortSignal?.aborted || parentToolContext.abortSignal?.aborted) {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
      }

      const result = await graphExecutor.runUntilYield(internalConversationId);
      this.appendUniqueEvents(allEvents, result.events);
      stepCount = result.stepCount;

      if (subrunSseSink && typeof subrunSseSink.finalize === 'function') {
        const finalized = subrunSseSink.finalize();
        this.appendUniqueEvents(allEvents, finalized);
      }

      judgeToolOutput = this.extractJudgeToolOutput(allEvents, agentConfig.judgeToolName);
      finalAnswer = this.extractFinalAnswer(allEvents);

      logger.info(`[InternalAgentInvoker] 子 Agent 执行完成`, {
        stepCount,
        eventCount: allEvents.length,
        hasFinalAnswer: !!finalAnswer,
        hasJudgeToolOutput: !!judgeToolOutput,
      });

      const transcriptMessages = (() => {
        const dedupeDecisionsForTranscript = (events: RuntimeEvent[]): RuntimeEvent[] => {
          const out: RuntimeEvent[] = [];
          const seenDecisionByToolCallId = new Set<string>();
          for (const e of events) {
            if (e.type === 'tool_call_decision') {
              const toolCallId = typeof e.tool_call_id === 'string' ? e.tool_call_id : '';
              if (toolCallId && seenDecisionByToolCallId.has(toolCallId)) {
                continue;
              }
              if (toolCallId) {
                seenDecisionByToolCallId.add(toolCallId);
              }
              out.push(e);
              continue;
            }
            if (e.type === 'tool_output') {
              const toolCallId = typeof e.tool_call_id === 'string' ? e.tool_call_id : '';
              if (toolCallId) {
                seenDecisionByToolCallId.delete(toolCallId);
              }
              out.push(e);
              continue;
            }
            out.push(e);
          }
          return out;
        };

        const out: unknown[] = [];
        if (typeof systemPrompt === 'string' && systemPrompt.trim().length > 0) {
          out.push({ role: 'system', content: systemPrompt });
        }
        if (typeof userMessage === 'string' && userMessage.trim().length > 0) {
          out.push({ role: 'user', content: userMessage });
        }
        const normalizedEvents = dedupeDecisionsForTranscript(allEvents);
        const aiMessages = this.eventToMessageConverter(normalizedEvents);
        out.push(...aiMessages);
        return out;
      })();

      recordRunTranscript({
        mode: 'agent',
        transcriptMessages,
        toolset: {
          availableTools: Array.isArray(request.availableTools) ? request.availableTools : undefined,
        },
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }

      const recoveredEvents = await this.recoverEventsFromCheckpoint({
        checkpointer,
        conversationId: internalConversationId,
        internalConversationId,
        seedHistory,
      });
      this.appendUniqueEvents(allEvents, recoveredEvents);

      if (subrunSseSink && typeof subrunSseSink.finalize === 'function') {
        const finalized = subrunSseSink.finalize({ isComplete: false });
        this.appendUniqueEvents(allEvents, finalized);
      }

      judgeToolOutput = this.extractJudgeToolOutput(allEvents, agentConfig.judgeToolName);
      finalAnswer = this.extractFinalAnswer(allEvents);
      error = err instanceof Error ? err.message : String(err);
      logger.error('[InternalAgentInvoker] 子 Agent 执行失败:', err instanceof Error
        ? {
            name: err.name,
            message: err.message,
            stack: err.stack,
          }
        : { error: String(err) });
    }

    await checkpointer.clear(internalConversationId);

    return {
      success: !error,
      judgeToolOutput,
      finalAnswer,
      events: allEvents,
      stepCount,
      error,
    };
  }
}
