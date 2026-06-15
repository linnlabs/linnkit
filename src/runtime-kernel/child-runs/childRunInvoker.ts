/**
 * @file src/agent/runtime-kernel/child-runs/childRunInvoker.ts
 * @description child-run 调用器
 */

import { GraphExecutor } from '../graph-engine/engine';
import { MemoryCheckpointer } from '../graph-engine/checkpointer/memoryCheckpointer';
import { ToolNode } from '../graph-engine/nodes/toolNode';
import { AnswerNode } from '../graph-engine/nodes/answerNode';
import { WaitUserNode } from '../graph-engine/nodes/waitUserNode';
import type { AgentInvocationRequest } from '../../ports';
import type { ObservationPreviewPort, ToolRuntimePort } from '../tools/ports';
import { noopAudit } from '../audit/noopAudit';
import { noopTelemetry } from '../telemetry/noopTelemetry';
import type { AuditPort } from '../../ports';
import type { TelemetryPort } from '../telemetry/telemetryPort';
import type { ChildRunParentContext } from './types';
import { generateMessageId } from '../../shared/ids';
import { Logger } from '../../shared/logger';
import { recordRunTranscript } from '../../shared/llmAuditRecorder';
import type { ModelResolverLike } from '../llm/modelResolver';
import type { SubRunTracePublisher } from '../child-run-trace/subrunTrace.types';
import type { GraphNode } from '../graph-engine/types';
import type { AgentSpecContextPolicy, AgentSpecSystemReminderPolicy, RuntimeEvent } from '../../contracts';
import { createChildRunToolContext } from './childToolContext';
import {
  appendUniqueEvents,
  buildChildRunTranscriptMessages,
  extractFinalAnswer,
  extractJudgeToolOutput,
} from './childRunEvents';
import { createChildRunTraceSink, type ChildRunTraceSink } from './childRunTraceSink';
import { recoverChildRunEventsFromCheckpoint } from './checkpointRecovery';

const logger = new Logger('ChildRunInvoker');

export interface ChildRunAgentConfig {
  id: string;
  promptKey: string;
  availableTools?: readonly string[];
  modelPolicy?: { kind: 'fixed'; modelId: string };
  stepPolicy?: {
    kind: 'final_answer' | 'force_tools';
    lastStepsHintThreshold?: number;
    forcedTools?: readonly string[];
  };
  contextPolicy?: AgentSpecContextPolicy;
  systemReminderPolicy?: AgentSpecSystemReminderPolicy;
  systemPromptBuilder?: (request: AgentInvocationRequest) => string;
  judgeToolName?: string;
}

export interface ChildRunInvokeConfig {
  agentConfig: ChildRunAgentConfig;
  userMessage: string;
  parentToolContext: ChildRunParentContext;
  /**
   * child-run 的宿主会话归属，用于 RuntimeEvent / Audit / Telemetry。
   *
   * 中文备注：
   * - 同步 child-run 需要独立 checkpoint key 隔离图状态，但审计与 run registry
   *   必须落在 host 注册 child run 时使用的 conversationId 下；
   * - 不传时优先继承 parentToolContext.conversationId，最后才退回内部 checkpoint key。
   */
  conversationId?: string;
  runId?: string;
  parentRunId?: string;
  abortSignal?: AbortSignal;
  subrunTracePublisher?: SubRunTracePublisher;
  seedHistoryEvents?: RuntimeEvent[];
  maxSteps?: number;
  modelId?: string;
}

export interface ChildRunInvokeResult {
  runId?: string;
  parentRunId?: string;
  success: boolean;
  judgeToolOutput?: string;
  finalAnswer?: string;
  events: RuntimeEvent[];
  stepCount: number;
  error?: string;
}

export class ChildRunInvoker {
  private readonly modelResolver: Pick<ModelResolverLike, 'resolveModelId'>;
  private readonly createLlmNode: () => GraphNode;
  private readonly toolRuntime: Pick<ToolRuntimePort, 'getToolDefinition' | 'executeTool'>;
  private readonly observationPreview: ObservationPreviewPort;
  private readonly eventToMessageConverter: (events: RuntimeEvent[]) => unknown[];
  private readonly defaultJudgeToolName?: string;
  private readonly telemetryPort: TelemetryPort;
  private readonly auditPort: AuditPort;

  constructor(dependencies: {
    modelResolver: Pick<ModelResolverLike, 'resolveModelId'>;
    createLlmNode: () => GraphNode;
    toolRuntime: Pick<ToolRuntimePort, 'getToolDefinition' | 'executeTool'>;
    observationPreview: ObservationPreviewPort;
    eventToMessageConverter: (events: RuntimeEvent[]) => unknown[];
    defaultJudgeToolName?: string;
    telemetryPort?: TelemetryPort;
    auditPort?: AuditPort;
  }) {
    this.modelResolver = dependencies.modelResolver;
    this.createLlmNode = dependencies.createLlmNode;
    this.toolRuntime = dependencies.toolRuntime;
    this.observationPreview = dependencies.observationPreview;
    this.eventToMessageConverter = dependencies.eventToMessageConverter;
    this.defaultJudgeToolName = dependencies.defaultJudgeToolName;
    this.telemetryPort = dependencies.telemetryPort ?? noopTelemetry;
    this.auditPort = dependencies.auditPort ?? noopAudit;
  }

  async invoke(config: ChildRunInvokeConfig): Promise<ChildRunInvokeResult> {
    const {
      agentConfig,
      userMessage,
      parentToolContext,
      conversationId,
      runId,
      parentRunId,
      subrunTracePublisher,
      seedHistoryEvents,
      maxSteps = 8,
      modelId,
      abortSignal,
    } = config;

    const internalCheckpointKey = `internal_${generateMessageId()}`;
    const runtimeConversationId = resolveChildRunConversationId({
      explicitConversationId: conversationId,
      parentToolContext,
      fallbackConversationId: internalCheckpointKey,
    });
    const turnId = `turn_${Date.now()}`;
    const childRunId = typeof runId === 'string' && runId.trim().length > 0
      ? runId.trim()
      : internalCheckpointKey;
    const resolvedParentRunId = typeof parentRunId === 'string' && parentRunId.trim().length > 0
      ? parentRunId.trim()
      : typeof parentToolContext.runId === 'string' && parentToolContext.runId.trim().length > 0
        ? parentToolContext.runId.trim()
        : undefined;

    logger.info(`启动 child-run: ${agentConfig.id}`, {
      conversationId: runtimeConversationId,
      checkpointKey: internalCheckpointKey,
      maxSteps,
      userMessage: userMessage.slice(0, 100) + (userMessage.length > 100 ? '...' : ''),
    });

    const checkpointer = new MemoryCheckpointer();
    const graphExecutor = new GraphExecutor(checkpointer, { maxSteps });

    const llmNode = this.createLlmNode();
    const toolNode = new ToolNode({
      toolRuntime: this.toolRuntime,
      observationPreview: this.observationPreview,
      telemetryPort: this.telemetryPort,
      auditPort: this.auditPort,
    });
    const answerNode = new AnswerNode();
    const waitUserNode = new WaitUserNode({ auditPort: this.auditPort });

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
    if (stepPolicy) {
      const kind = stepPolicy.kind;
      if (kind === 'final_answer' || kind === 'force_tools') {
        executorLocalPolicy.finalStepPolicy = kind;
      }
      const threshold = stepPolicy.lastStepsHintThreshold;
      if (typeof threshold === 'number' && Number.isFinite(threshold)) {
        executorLocalPolicy.lastStepsHintThreshold = threshold;
      }
      const forcedTools = stepPolicy.forcedTools;
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

    const systemReminderPolicy = resolveChildRunSystemReminderPolicy(agentConfig);
    if (systemReminderPolicy) {
      executorLocalPolicy.systemReminderPolicy = systemReminderPolicy;
    }

    const contextCheckpointToolName = agentConfig.contextPolicy?.checkpoint?.triggerToolName;
    if (typeof contextCheckpointToolName === 'string' && contextCheckpointToolName.trim().length > 0) {
      executorLocalPolicy.contextCheckpointToolName = contextCheckpointToolName.trim();
    }

    const seedHistory: RuntimeEvent[] = Array.isArray(seedHistoryEvents) ? seedHistoryEvents : [];

    const childToolContext = createChildRunToolContext({
      parentToolContext,
      conversationId: runtimeConversationId,
      turnId,
      runId: childRunId,
      parentRunId: resolvedParentRunId,
      seedHistory,
      abortSignal,
    });

    const subrunSseSink: ChildRunTraceSink | undefined = subrunTracePublisher
      ? createChildRunTraceSink({
          publisher: subrunTracePublisher,
          conversationId: runtimeConversationId,
          turnId,
        })
      : undefined;

    const initialLocal: Record<string, unknown> = {
      request,
      history: seedHistory,
      conversationId: runtimeConversationId,
      turnId,
      toolContext: childToolContext,
      ...(abortSignal ? { signal: abortSignal } : {}),
      ...(Object.keys(executorLocalPolicy).length > 0 ? { executorLocal: executorLocalPolicy } : {}),
      ...(subrunSseSink ? { sseSink: subrunSseSink } : {}),
      systemPrompt,
    };

    await graphExecutor.prime(internalCheckpointKey, initialLocal, 'llm');

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

      const result = await graphExecutor.runUntilYield(internalCheckpointKey);
      appendUniqueEvents(allEvents, result.events);
      stepCount = result.stepCount;

      if (subrunSseSink && typeof subrunSseSink.finalize === 'function') {
        const finalized = subrunSseSink.finalize();
        appendUniqueEvents(allEvents, finalized);
      }

      judgeToolOutput = extractJudgeToolOutput(allEvents, agentConfig.judgeToolName ?? this.defaultJudgeToolName);
      finalAnswer = extractFinalAnswer(allEvents);

      logger.info('child-run 执行完成', {
        stepCount,
        eventCount: allEvents.length,
        hasFinalAnswer: !!finalAnswer,
        hasJudgeToolOutput: !!judgeToolOutput,
      });

      const transcriptMessages = buildChildRunTranscriptMessages({
        systemPrompt,
        userMessage,
        events: allEvents,
        eventToMessageConverter: this.eventToMessageConverter,
      });

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

      const recoveredEvents = await recoverChildRunEventsFromCheckpoint({
        checkpointer,
        checkpointKey: internalCheckpointKey,
        childConversationId: runtimeConversationId,
        seedHistory,
      });
      appendUniqueEvents(allEvents, recoveredEvents);

      if (subrunSseSink && typeof subrunSseSink.finalize === 'function') {
        const finalized = subrunSseSink.finalize({ isComplete: false });
        appendUniqueEvents(allEvents, finalized);
      }

      judgeToolOutput = extractJudgeToolOutput(allEvents, agentConfig.judgeToolName ?? this.defaultJudgeToolName);
      finalAnswer = extractFinalAnswer(allEvents);
      error = err instanceof Error ? err.message : String(err);
      logger.error('child-run 执行失败:', err instanceof Error
        ? {
            name: err.name,
            message: err.message,
            stack: err.stack,
          }
        : { error: String(err) });
    }

    await checkpointer.clear(internalCheckpointKey);

    return {
      success: !error,
      runId: childRunId,
      parentRunId: resolvedParentRunId,
      judgeToolOutput,
      finalAnswer,
      events: allEvents,
      stepCount,
      error,
    };
  }
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveChildRunConversationId(params: {
  explicitConversationId?: string;
  parentToolContext: ChildRunParentContext;
  fallbackConversationId: string;
}): string {
  return (
    readNonEmptyString(params.explicitConversationId) ??
    readNonEmptyString(params.parentToolContext.conversationId) ??
    params.fallbackConversationId
  );
}

function resolveChildRunSystemReminderPolicy(
  agentConfig: ChildRunAgentConfig,
): AgentSpecSystemReminderPolicy | undefined {
  const configured = agentConfig.systemReminderPolicy ?? agentConfig.contextPolicy?.systemReminder;
  const threshold = agentConfig.stepPolicy?.lastStepsHintThreshold;
  const nextPolicy: AgentSpecSystemReminderPolicy = {
    ...(configured ?? {}),
  };

  if (
    typeof threshold === 'number' &&
    Number.isFinite(threshold) &&
    nextPolicy.thresholds?.lastStepsHintThreshold === undefined
  ) {
    nextPolicy.thresholds = {
      ...(nextPolicy.thresholds ?? {}),
      lastStepsHintThreshold: threshold,
    };
  }

  return Object.keys(nextPolicy).length > 0 ? nextPolicy : undefined;
}
