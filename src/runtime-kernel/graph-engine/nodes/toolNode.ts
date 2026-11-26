import { Logger } from '../../../shared/logger';
import { noopTelemetry } from '../../telemetry/noopTelemetry';
import type { TelemetryPort } from '../../telemetry/telemetryPort';
import { noopAudit } from '../../audit/noopAudit';
import { emitAuditEnvelope } from '../../audit/emitAudit';
import type { AuditPort } from '../../../ports';
import type {
  AgentSpecToolObservationGovernancePolicy,
  RoutedRuntimeEvent,
  RunId,
  RuntimeEvent,
  RuntimeResourceRef,
  ToolCallId,
} from '../../../contracts';
import { parseRuntimeEvents, runIdFromTurnId, toSerializableJsonValue } from '../../../contracts';
import type { ToolControlInfo } from '../../tools/ui-types';
import type {
  ObservationPreviewPort,
  ToolExecutionPort,
  ToolCatalogPort,
  ToolExecutionResult,
} from '../../tools/ports';
import type { ToolModelInputResolverPort } from '../../tools/model-input';
import { resolveToolModelInput } from '../../tools/model-input';
import type { GraphNode, EngineState, NodeResult, StandardToolCall } from '../types';
import { resolveFinalAnswerFromToolControl } from './toolNode.finalAnswerProjector';
import { ToolNodeEventBridge } from './toolNode.eventBridge';
import { applyObservationGovernance } from './toolNode.observationGovernance';
import {
  applyProtocolFuseState,
  createToolProtocolFuseError,
  checkProtocolFuse,
} from './toolNode.protocolFuse';
import { isRecord, parseJsonSafe, withoutToolCall } from './toolNode.helpers';
import type { UnknownRecord } from './toolNode.helpers';
import {
  buildErrorLocalState,
  buildRequireUserLocalState,
  buildSuccessLocalState,
  extractToolControlInfo,
  validateStructuredToolResultContract,
} from './toolNode.stateTransitions';
import {
  prepareToolExecution,
  prepareToolNodeContext,
  type PreparedToolNodeContext,
} from './toolNode.executionSetup';
import {
  executeToolWithIdempotency,
  type ToolIdempotencyInFlightRegistry,
} from './toolNode.idempotency';
import { parsePendingToolCalls } from '../functions/parsePendingToolCalls';
import {
  isToolExecutionAbort,
  settlePendingToolCallsAfterAbort,
  settleToolCallAfterExecutionAbort,
} from './toolNode.cancellation';
import { recordToolProtocolError } from '../../../shared/llmAuditRecorder';
import {
  assertExecutionIntentsArePending,
  commitToolBoundary,
  executeRecoverableTool,
  readExecutingToolCallIds,
} from './toolNode.recovery';
import {
  DEFAULT_MAX_PARALLEL_TOOL_CALLS,
  readProtocolErrorCount,
  runParallelToolGroup,
  selectParallelToolGroup,
  type ToolCallMode,
  type ToolCallOutcome,
} from './toolNode.parallelGroup';
import { isRunPauseSignal, RunRecoveryBlockedError } from '../definitions/runContinuation';
import { claimPendingUserInputs } from './toolNode.pendingUserInput';

const logger = new Logger('ToolNode');

function isAbortSignal(value: unknown): value is AbortSignal {
  return value !== null && typeof value === 'object' && 'aborted' in value;
}

function readToolObservationPolicy(
  local: UnknownRecord
): AgentSpecToolObservationGovernancePolicy | undefined {
  const executorLocal = local.executorLocal;
  if (executorLocal && typeof executorLocal === 'object' && !Array.isArray(executorLocal)) {
    const value = (executorLocal as Record<string, unknown>).toolObservationPolicy;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const policy: AgentSpecToolObservationGovernancePolicy = {};
      if (typeof record.enabled === 'boolean') {
        policy.enabled = record.enabled;
      }
      if (typeof record.maxChars === 'number' && Number.isFinite(record.maxChars)) {
        policy.maxChars = record.maxChars;
      }
      if (typeof record.maxLines === 'number' && Number.isFinite(record.maxLines)) {
        policy.maxLines = record.maxLines;
      }
      return Object.keys(policy).length > 0 ? policy : undefined;
    }
  }
  return undefined;
}

function readHistoryEvents(local: UnknownRecord): RuntimeEvent[] {
  return parseRuntimeEvents(local.history ?? []);
}

function formatCapabilityError(error: unknown): string {
  if (isRecord(error)) {
    const codeValue = error.errorCode ?? error.code;
    const code = typeof codeValue === 'string' ? codeValue.trim() : '';
    const message = typeof error.message === 'string' ? error.message.trim() : '';
    if (code) {
      return `${code}: ${message || 'tool model input is not supported'}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

const SERIAL_MODE: ToolCallMode = { kind: 'serial' };

/** toolContext 是本次调用派生的上下文，不是 prepared 里共享的那份。 */
type ToolNodeSuccessContext = PreparedToolNodeContext & {
  mode: ToolCallMode;
  toolName: string;
  toolCallId: ToolCallId;
  exec: ToolExecutionResult;
  parsed: UnknownRecord;
  observation: string;
  attachments?: readonly RuntimeResourceRef[];
  bridge: ToolNodeEventBridge;
};

type ToolNodeErrorContext = PreparedToolNodeContext & {
  mode: ToolCallMode;
  call: StandardToolCall;
  toolName: string;
  toolCallId: ToolCallId;
  toolArgs: Record<string, unknown>;
  exec: ToolExecutionResult;
  bridge: ToolNodeEventBridge;
};

/** 并行组里其他调用结算时会替换 state.local；结算时必须读最新对象，不能用准备阶段拿到的引用。 */
function currentLocal(state: EngineState): UnknownRecord {
  if (!state.local) state.local = {};
  return state.local;
}

function remainingCallsAfter(state: EngineState, toolCallId: ToolCallId): StandardToolCall[] {
  return withoutToolCall(parsePendingToolCalls(currentLocal(state).pendingToolCalls ?? []), toolCallId);
}

export interface ToolNodeDependencies {
  toolRuntime: Pick<ToolCatalogPort, 'getToolDefinition'> & Pick<ToolExecutionPort, 'executeTool'>;
  observationPreview: ObservationPreviewPort;
  /**
   * 可选：宿主提供的 TelemetryPort 实现。
   * 不传时使用 noopTelemetry（observability 默认关闭，业务零影响）。
   */
  telemetryPort?: TelemetryPort;
  auditPort?: AuditPort;
  modelInputResolver?: ToolModelInputResolverPort;
  /** 停止信号发出后等工具自行结束的期限；默认 3 秒，超时按中断处理并丢弃迟到结果。 */
  abortGraceMs?: number;
  /**
   * 一组相邻的可并行调用里同时执行的上限，超出的排队；默认 3。
   * 由 Host 装配决定，模型无法通过调用参数改变它。
   */
  maxParallelToolCalls?: number;
}

export class ToolNode implements GraphNode {
  id = 'tool';
  private readonly toolRuntime: Pick<ToolCatalogPort, 'getToolDefinition'> &
    Pick<ToolExecutionPort, 'executeTool'>;
  private readonly observationPreview: ObservationPreviewPort;
  private readonly telemetryPort: TelemetryPort;
  private readonly auditPort: AuditPort;
  private readonly modelInputResolver?: ToolModelInputResolverPort;
  private readonly idempotencyInFlight: ToolIdempotencyInFlightRegistry = new Map();
  private readonly abortGraceMs?: number;
  private readonly maxParallelToolCalls: number;

  constructor(dependencies: ToolNodeDependencies) {
    this.abortGraceMs = dependencies.abortGraceMs;
    const maxParallelToolCalls = dependencies.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS;
    if (!Number.isInteger(maxParallelToolCalls) || maxParallelToolCalls < 1) {
      throw new Error(`ToolNode maxParallelToolCalls must be a positive integer, got ${maxParallelToolCalls}`);
    }
    this.maxParallelToolCalls = maxParallelToolCalls;
    this.toolRuntime = dependencies.toolRuntime;
    this.observationPreview = dependencies.observationPreview;
    this.telemetryPort = dependencies.telemetryPort ?? noopTelemetry;
    this.auditPort = dependencies.auditPort ?? noopAudit;
    this.modelInputResolver = dependencies.modelInputResolver;
  }

  /**
   * B2-engine Batch 2: 上报 tool_call 事件到宿主侧 TelemetryPort。
   * 在 handleSuccess / handleError 入口处调用。
   */
  private emitToolCallTelemetry(args: {
    toolName: string;
    durationMs: number;
    ok: boolean;
    errorCode?: string;
    conversationId: string;
    turnId: string;
    runId?: RunId;
    parentRunId?: RunId;
  }): void {
    this.telemetryPort.emit({
      kind: 'tool_call',
      toolName: args.toolName,
      durationMs: args.durationMs,
      ok: args.ok,
      errorCode: args.errorCode,
      scope: {
        conversationId: args.conversationId || undefined,
        turnId: args.turnId,
        ...(args.runId === undefined ? {} : { runId: args.runId }),
        ...(args.parentRunId === undefined ? {} : { parentRunId: args.parentRunId }),
      },
    });
  }

  private async emitToolDecisionAudit(args: {
    action: 'tool.allow' | 'tool.deny';
    toolName: string;
    toolCallId: ToolCallId;
    reason: string;
    conversationId: string;
    turnId: string;
    runId?: RunId;
    parentRunId?: RunId;
    errorKind?: string;
  }): Promise<void> {
    await emitAuditEnvelope(this.auditPort, {
      parentRunId: args.parentRunId,
      action: args.action,
      actor: { kind: 'system' },
      decision: {
        outcome: args.action === 'tool.allow' ? 'allowed' : 'denied',
        reason: args.reason,
        metadata: {
          errorKind: args.errorKind,
        },
      },
      evidence: [
        {
          kind: 'tool_call',
          ref: args.toolCallId,
          summary: `${args.action} ${args.toolName}`,
        },
      ],
      scope: {
        conversationId: args.conversationId || undefined,
        turnId: args.turnId,
        runId: args.runId ?? runIdFromTurnId(args.turnId),
        ...(args.parentRunId === undefined ? {} : { parentRunId: args.parentRunId }),
        toolName: args.toolName,
        toolCallId: args.toolCallId,
      },
    });
  }

  private async emitToolProtocolErrorAudit(args: {
    toolName: string;
    toolCallId?: ToolCallId;
    rawArguments?: string;
    parsedArguments: Record<string, unknown>;
    error: string;
    conversationId: string;
    turnId: string;
    runId?: RunId;
    parentRunId?: RunId;
  }): Promise<void> {
    recordToolProtocolError({
      toolName: args.toolName,
      ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
      ...(args.rawArguments === undefined ? {} : { rawArguments: args.rawArguments }),
      parsedArguments: args.parsedArguments,
      error: args.error,
    });

    const metadata = {
      ...(args.rawArguments === undefined ? {} : { rawArguments: args.rawArguments }),
      parsedArguments: args.parsedArguments,
    };
    const evidence = {
      kind: 'tool_protocol_error',
      ...(args.toolCallId === undefined ? {} : { ref: args.toolCallId }),
      summary: args.error,
    };

    await emitAuditEnvelope(this.auditPort, {
      parentRunId: args.parentRunId,
      action: 'tool.protocol_error',
      actor: { kind: 'system' },
      decision: {
        outcome: 'recorded',
        reason: args.error,
        metadata,
      },
      evidence: [evidence],
      scope: {
        conversationId: args.conversationId || undefined,
        turnId: args.turnId,
        runId: args.runId ?? runIdFromTurnId(args.turnId),
        ...(args.parentRunId === undefined ? {} : { parentRunId: args.parentRunId }),
        toolName: args.toolName,
        ...(args.toolCallId === undefined ? {} : { toolCallId: args.toolCallId }),
      },
    });
  }

  async run(state: EngineState): Promise<NodeResult> {
    assertExecutionIntentsArePending(state);
    const events: RoutedRuntimeEvent[] = [];

    while (true) {
      let result: ToolCallOutcome;
      try {
        result = await this.runNextPendingToolCall(state);
      } catch (error) {
        if (isToolExecutionAbort(error) && !isRunPauseSignal(state.local?.signal)) {
          await this.cancel(state);
        }
        throw error;
      }
      const signal = state.local?.signal;
      if (isAbortSignal(signal) && signal.aborted && !isRunPauseSignal(signal)) {
        // 动作可能已完成：保留其真实结果，仅取消 batch 剩余调用，再提交同一终止边界。
        await this.cancel(state);
        const error = new Error('The user aborted a request.');
        error.name = 'AbortError';
        throw error;
      }
      if (result.kind === 'interrupted') {
        // 熔断只中断本 execution；批次已结算，显式继续时应从 LLM 消费原错误历史。
        // 必须先提交，Host 离开 Graph 后会作废未提交 attempt，不能让它从 journal 补写。
        await commitToolBoundary(state, {
          kind: 'route', nextNodeId: 'llm', events: result.events,
        });
        throw result.error;
      }
      // 插话只在整批结算、回到模型前送达，并与本次边界同一次提交。
      const steering = await claimPendingUserInputs(state, result);
      if (steering) {
        result = { ...result, events: [...(result.events ?? []), ...steering.events] };
        try {
          await commitToolBoundary(state, result);
        } catch (error) {
          await steering.release();
          throw error;
        }
        await steering.confirm();
      } else {
        await commitToolBoundary(state, result);
      }
      if (Array.isArray(result.events) && result.events.length > 0) {
        events.push(...result.events);
      }

      if (result.kind === 'route' && result.nextNodeId === 'tool') {
        continue;
      }

      return {
        ...result,
        events,
      };
    }
  }

  async cancel(state: EngineState): Promise<void> {
    settlePendingToolCallsAfterAbort({
      state,
      calls: parsePendingToolCalls(state.local?.pendingToolCalls ?? []),
      toolCatalog: this.toolRuntime,
    });
    // 必须在 AbortError 离开 Graph 前提交；Host finishCheckpointWrites 会作废未提交 attempt。
    await commitToolBoundary(state, { kind: 'yield', events: [] });
  }

  private async runNextPendingToolCall(state: EngineState): Promise<ToolCallOutcome> {
    const calls = parsePendingToolCalls(state.local?.pendingToolCalls ?? []);
    const signalRaw = state.local?.signal;
    if (isAbortSignal(signalRaw) && signalRaw.aborted) {
      if (!isRunPauseSignal(signalRaw)) {
        settlePendingToolCallsAfterAbort({ state, calls, toolCatalog: this.toolRuntime });
      }
      const abortError = new Error('The user aborted a request.');
      abortError.name = 'AbortError';
      throw abortError;
    }

    const prepared = prepareToolNodeContext(state);
    logger.info('[ToolNode] 开始执行工具节点', {
      conversationId: prepared.conversationId,
      turnId: prepared.turnId,
      pendingCallCount: calls.length,
    });

    if (calls.length === 0) {
      return { kind: 'yield', events: [] };
    }

    const group = selectParallelToolGroup(calls, this.toolRuntime);
    if (group.length > 0) {
      return this.runParallelGroup(state, prepared, group);
    }
    return this.runToolCall(state, prepared, calls[0], SERIAL_MODE);
  }

  private runParallelGroup(
    state: EngineState,
    prepared: PreparedToolNodeContext,
    group: readonly StandardToolCall[],
  ): Promise<ToolCallOutcome> {
    return runParallelToolGroup({
      state,
      group,
      limit: this.maxParallelToolCalls,
      conversationId: prepared.conversationId,
      turnId: prepared.turnId,
      runCall: (call, mode) => this.runToolCall(state, prepared, call, mode),
    });
  }

  private async runToolCall(
    state: EngineState,
    prepared: PreparedToolNodeContext,
    call: StandardToolCall,
    mode: ToolCallMode,
  ): Promise<ToolCallOutcome> {
    const execution = prepareToolExecution({
      prepared,
      call,
      toolCatalog: this.toolRuntime,
    });
    if (!execution) {
      logger.warn('no tool name found in call');
      return { kind: 'yield', events: [] };
    }
    const callContext = { ...prepared, toolContext: execution.toolContext };

    if (typeof execution.protocolError === 'string') {
      return this.handleError({
        ...callContext,
        mode,
        call,
        toolName: execution.toolName,
        toolCallId: execution.toolCallId,
        toolArgs: execution.toolArgs,
        exec: {
          success: false,
          error: execution.protocolError,
          errorKind: 'protocol',
          durationMs: 0,
        },
        bridge: execution.bridge,
      });
    }

    await this.emitToolDecisionAudit({
      action: 'tool.allow',
      toolName: execution.toolName,
      toolCallId: execution.toolCallId,
      reason: 'tool call passed protocol validation',
      conversationId: prepared.conversationId,
      turnId: prepared.turnId,
      runId: execution.toolContext.runId,
      parentRunId: execution.toolContext.parentRunId,
    });

    // tool_process(start) 是“实际开始执行”的事实，不是参数或能力准入的占位。
    // 所有拒绝分支都在上面结算为配对 tool_output(error)，因此这里是唯一启动边界。
    execution.bridge.emitToolProcess('start', 'loading', {
      args: execution.toolArgs,
      tool_calls: [call],
    });

    try {
      const exec = await executeRecoverableTool({
        state,
        call,
        context: execution.toolContext,
        abortGraceMs: this.abortGraceMs,
        ...(mode.kind === 'parallel' ? { group: { commitQueue: mode.commitQueue } } : {}),
        onAbandon: () => logger.warn('[ToolNode] 工具未在停止期限内结束，按中断处理并丢弃迟到结果', {
          toolName: execution.toolName,
          toolCallId: execution.toolCallId,
          conversationId: prepared.conversationId,
          turnId: prepared.turnId,
        }),
        execute: () => executeToolWithIdempotency({
        idempotencyKey: execution.idempotencyKey,
        inFlight: this.idempotencyInFlight,
        history: readHistoryEvents(currentLocal(state)),
        toolName: execution.toolName,
        execute: () =>
          this.toolRuntime.executeTool(
            execution.toolName,
            execution.toolArgs,
            execution.toolContext
          ),
        }),
      });
      if (exec.success) {
        const parsed = typeof exec.result === 'string' ? parseJsonSafe(exec.result) : exec.result;
        const contract = validateStructuredToolResultContract(parsed);
        const violation = !contract.ok
          ? contract.reason
          : mode.kind === 'parallel' && extractToolControlInfo(contract.result)
            // 等待用户、结束运行、最终答案都要求本批之后不再有别的调用结算，并行组无法保证。
            ? 'tools declared parallel must not return control.requireUser, control.terminateRun or control.finalAnswer.'
            : undefined;
        if (!contract.ok || violation !== undefined) {
          return this.handleError({
            ...callContext,
            mode,
            call,
            toolName: execution.toolName,
            toolCallId: execution.toolCallId,
            toolArgs: execution.toolArgs,
            exec: {
              success: false,
              error: `TOOL_RESULT_CONTRACT_VIOLATION: ${violation}`,
              errorKind: 'execution',
              durationMs: exec.durationMs,
            },
            bridge: execution.bridge,
          });
        }
        // 是否返回模型附件由工具与 Host 决定；框架只把声明的 selection 交给 Host resolver 换成正式引用。
        // 幂等命中复用当时已解析的引用。
        let attachments: readonly RuntimeResourceRef[] | undefined = exec.cachedAttachments;
        try {
          if (!attachments) {
            attachments = await resolveToolModelInput({
              toolName: execution.toolName,
              toolCallId: execution.toolCallId,
              selections: contract.modelInputAttachments,
              context: execution.toolContext,
              resolver: this.modelInputResolver,
            });
          }
        } catch (error) {
          return this.handleError({
            ...callContext,
            mode,
            call,
            toolName: execution.toolName,
            toolCallId: execution.toolCallId,
            toolArgs: execution.toolArgs,
            exec: {
              success: false,
              error: formatCapabilityError(error),
              errorKind: 'capability',
              durationMs: exec.durationMs,
              idempotency: exec.idempotency,
            },
            bridge: execution.bridge,
          });
        }
        return this.handleSuccess({
          ...callContext,
          mode,
          toolName: execution.toolName,
          toolCallId: execution.toolCallId,
          exec,
          parsed: contract.result,
          observation: contract.observation,
          attachments,
          bridge: execution.bridge,
        });
      }

      return this.handleError({
        ...callContext,
        mode,
        call,
        toolName: execution.toolName,
        toolCallId: execution.toolCallId,
        toolArgs: execution.toolArgs,
        exec,
        bridge: execution.bridge,
      });
    } catch (error) {
      if (isToolExecutionAbort(error) && !isRunPauseSignal(state.local?.signal)) {
        // 只结算本调用；同批未启动的调用由 ToolNode.cancel 统一结算。
        settleToolCallAfterExecutionAbort({
          state,
          call,
          currentBridge: execution.bridge,
        });
      }
      throw error;
    } finally {
      await this.modelInputResolver?.completeToolModelInput({
        toolName: execution.toolName,
        toolCallId: execution.toolCallId,
        context: execution.toolContext,
      });
    }
  }

  private async handleSuccess(context: ToolNodeSuccessContext): Promise<NodeResult> {
    this.emitToolCallTelemetry({
      toolName: context.toolName,
      durationMs: context.exec.durationMs,
      ok: true,
      conversationId: context.conversationId,
      turnId: context.turnId,
      runId: context.toolContext.runId,
      parentRunId: context.toolContext.parentRunId,
    });

    const observationGovernance = await applyObservationGovernance({
      parsed: context.parsed,
      toolName: context.toolName,
      toolContext: context.toolContext,
      structuredObservation: context.observation,
      observationPreview: this.observationPreview,
      policy: readToolObservationPolicy(currentLocal(context.state)),
    });

    const control = extractToolControlInfo(context.parsed);
    if (control?.requireUser) {
      return this.handleRequireUserSuccess({ ...context, control });
    }

    const presentationMedia =
      context.parsed.media === undefined
        ? undefined
        : toSerializableJsonValue(context.parsed.media);
    const toolOutputMetadata = {
      ...(context.exec.idempotency
        ? {
            idempotency: {
              key: context.exec.idempotency.key,
              cache_hit: context.exec.idempotency.cacheHit,
            },
          }
        : {}),
      ...(observationGovernance.observationTruncation
        ? { observationTruncation: observationGovernance.observationTruncation }
        : {}),
      ...(presentationMedia !== undefined ? { presentation: { media: presentationMedia } } : {}),
    };
    context.bridge.emitToolOutput(
      {
        status: 'success',
        observation: observationGovernance.observation,
        data: context.parsed.data,
      },
      {
        attachments: context.attachments,
        metadata: Object.keys(toolOutputMetadata).length > 0 ? toolOutputMetadata : undefined,
        // 缓存复用的是业务结果，不是当前 call 的终态身份；每个新 call 都必须可持久化配对。
        durationMs: context.exec.durationMs,
      }
    );
    const finalAnswerProjection = resolveFinalAnswerFromToolControl(control?.finalAnswer);
    if (typeof finalAnswerProjection === 'string') {
      context.bridge.emitFinalAnswer({
        answer: finalAnswerProjection,
        sourceToolName: context.toolName,
      });
    }

    // 从这里到写回 state 之间没有 await：并行组内的结算不会互相覆盖。
    const local = currentLocal(context.state);
    if (context.mode.kind === 'serial') {
      applyProtocolFuseState(local, 0);
    }
    const remainingCalls = remainingCallsAfter(context.state, context.toolCallId);
    context.state.local = buildSuccessLocalState({
      local,
      remainingCalls,
      conversationId: context.conversationId,
      turnId: context.turnId,
      runtimeEvents: context.bridge.getRuntimeEvents(),
    });

    if (control?.terminateRun) {
      logger.info('[ToolNode] 收到 control.terminateRun，执行完工具后直接 yield 结束本轮 run', {
        toolName: context.toolName,
        toolCallId: context.toolCallId,
        conversationId: context.conversationId,
        turnId: context.turnId,
      });
      return { kind: 'yield', events: context.bridge.getRuntimeEvents() };
    }

    if (
      remainingCalls.length === 0
      && local.toolBatchCompletionMode === 'yield_after_batch'
    ) {
      logger.info('[ToolNode] 工具批次已结算，按 Host 策略直接 yield', {
        toolName: context.toolName,
        toolCallId: context.toolCallId,
        conversationId: context.conversationId,
        turnId: context.turnId,
      });
      return { kind: 'yield', events: context.bridge.getRuntimeEvents() };
    }

    return {
      kind: 'route',
      nextNodeId: remainingCalls.length > 0 ? 'tool' : 'llm',
      events: context.bridge.getRuntimeEvents(),
    };
  }

  private handleRequireUserSuccess(
    context: ToolNodeSuccessContext & { control: ToolControlInfo }
  ): NodeResult {
    context.state.local = buildRequireUserLocalState({
      local: currentLocal(context.state),
      parsed: context.parsed,
      toolCallId: context.toolCallId,
      toolName: context.toolName,
      remainingCalls: remainingCallsAfter(context.state, context.toolCallId),
      conversationId: context.conversationId,
      turnId: context.turnId,
      runtimeEvents: context.bridge.getRuntimeEvents(),
    });

    return { kind: 'route', nextNodeId: 'wait_user', events: context.bridge.getRuntimeEvents() };
  }

  private async handleError(context: ToolNodeErrorContext): Promise<ToolCallOutcome> {
    if (readExecutingToolCallIds(context.state).includes(context.toolCallId)
      && (context.exec.errorKind === 'protocol' || context.exec.errorKind === 'capability')) {
      // 当前能力不可用不证明原副作用失败；保留未决意图，待 owner 能再次对账。
      throw new RunRecoveryBlockedError(context.exec.error ?? 'Tool recovery capability is unavailable');
    }
    if (context.exec.errorKind === 'protocol' || context.exec.errorKind === 'capability') {
      await this.emitToolDecisionAudit({
        action: 'tool.deny',
        toolName: context.toolName,
        toolCallId: context.toolCallId,
        reason: context.exec.error ?? 'tool protocol validation failed',
        conversationId: context.conversationId,
        turnId: context.turnId,
        runId: context.toolContext.runId,
        parentRunId: context.toolContext.parentRunId,
        errorKind: context.exec.errorKind,
      });
    }
    this.emitToolCallTelemetry({
      toolName: context.toolName,
      durationMs: context.exec.durationMs,
      ok: false,
      errorCode: context.exec.errorCode ?? context.exec.errorKind,
      conversationId: context.conversationId,
      turnId: context.turnId,
      runId: context.toolContext.runId,
      parentRunId: context.toolContext.parentRunId,
    });

    const error = context.exec.error || 'tool_error';
    context.bridge.emitToolOutput(
      {
        status: 'error',
        observation: error,
        error,
        ...(context.exec.errorCode === undefined
          ? {}
          : { error_code: context.exec.errorCode }),
      },
      { durationMs: context.exec.durationMs }
    );

    const fuse = checkProtocolFuse({
      local: currentLocal(context.state),
      exec: context.exec,
      toolName: context.toolName,
      toolCallId: context.toolCallId,
      rawArguments: context.call.function?.arguments,
      parsedArguments: context.toolArgs,
    });
    if (fuse.protocolErrorAudit) {
      await this.emitToolProtocolErrorAudit({
        ...fuse.protocolErrorAudit,
        conversationId: context.conversationId,
        turnId: context.turnId,
        runId: context.toolContext.runId,
        parentRunId: context.toolContext.parentRunId,
      });
    }
    if (context.mode.kind === 'parallel' && fuse.isProtocolError) {
      context.mode.protocolErrors.set(context.toolCallId, error);
    }

    // 从这里到写回 state 之间没有 await：并行组内的结算不会互相覆盖。
    const local = currentLocal(context.state);
    const remainingCalls = remainingCallsAfter(context.state, context.toolCallId);
    context.state.local = buildErrorLocalState({
      local,
      remainingCalls,
      conversationId: context.conversationId,
      turnId: context.turnId,
      runtimeEvents: context.bridge.getRuntimeEvents(),
      // 并行组的计数在组结束后按原顺序重算，这里保持原值。
      nextProtocolErrorCount: context.mode.kind === 'serial' ? fuse.nextCount : readProtocolErrorCount(local),
    });

    if (context.mode.kind === 'serial' && fuse.shouldFuse && remainingCalls.length === 0) {
      return {
        kind: 'interrupted',
        error: createToolProtocolFuseError(fuse.nextCount, context.exec.error),
        events: context.bridge.getRuntimeEvents(),
      };
    }

    if (
      remainingCalls.length === 0
      && local.toolBatchCompletionMode === 'yield_after_batch'
    ) {
      return { kind: 'yield', events: context.bridge.getRuntimeEvents() };
    }

    return {
      kind: 'route',
      // 同一个 assistant.tool_calls batch 必须为每个 call 产出 tool_output。
      // 出错时也继续消费剩余 call，ToolNode.run 会在本节点内 drain 完 batch 再回 LLM。
      nextNodeId: remainingCalls.length > 0 ? 'tool' : 'llm',
      events: context.bridge.getRuntimeEvents(),
    };
  }
}
