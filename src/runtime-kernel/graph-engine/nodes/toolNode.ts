import { Logger } from '../../../shared/logger';
import { noopTelemetry } from '../../telemetry/noopTelemetry';
import type { TelemetryPort } from '../../telemetry/telemetryPort';
import { noopAudit } from '../../audit/noopAudit';
import { emitAuditEnvelope } from '../../audit/emitAudit';
import type { AuditPort } from '../../../ports';
import type { AgentSpecToolObservationGovernancePolicy, RuntimeEvent } from '../../../contracts';
import type { ToolControlInfo } from '../../tools/ui-types';
import type {
  ObservationPreviewPort,
  ToolExecutionPort,
  ToolCatalogPort,
  ToolExecutionResult,
} from '../../tools/ports';
import type { GraphNode, EngineState, NodeResult, StandardToolCall } from '../types';
import { resolveFinalAnswerFromToolResult } from './toolNode.finalAnswerProjector';
import { ToolNodeEventBridge } from './toolNode.eventBridge';
import { applyObservationGovernance } from './toolNode.observationGovernance';
import {
  applyProtocolFuseState,
  createToolProtocolFuseError,
  checkProtocolFuse,
} from './toolNode.protocolFuse';
import { parseJsonSafe } from './toolNode.helpers';
import type { UnknownRecord } from './toolNode.helpers';
import {
  applyToolOutputIdempotencyMetadata,
  buildErrorLocalState,
  buildRequireUserLocalState,
  buildSuccessLocalState,
  buildSuccessOutputPayload,
  extractToolControlInfo,
  readStructuredObservation,
} from './toolNode.stateTransitions';
import {
  prepareToolExecution,
  prepareToolNodeContext,
  type PreparedToolNodeContext,
} from './toolNode.executionSetup';
import { DEFAULT_CONTEXT_CHECKPOINT_TOOL_NAME } from '../../system-reminder/helpers';

const logger = new Logger('ToolNode');

function isAbortSignal(value: unknown): value is AbortSignal {
  return value !== null && typeof value === 'object' && 'aborted' in value;
}

function readContextCheckpointToolName(local: UnknownRecord): string {
  const executorLocal = local.executorLocal;
  if (executorLocal && typeof executorLocal === 'object' && !Array.isArray(executorLocal)) {
    const value = (executorLocal as Record<string, unknown>).contextCheckpointToolName;
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return DEFAULT_CONTEXT_CHECKPOINT_TOOL_NAME;
}

function readToolObservationPolicy(local: UnknownRecord): AgentSpecToolObservationGovernancePolicy | undefined {
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

type ToolNodeSuccessContext = PreparedToolNodeContext & {
  calls: StandardToolCall[];
  toolName: string;
  toolCallId: string;
  exec: ToolExecutionResult;
  parsed: unknown;
  bridge: ToolNodeEventBridge;
};

type ToolNodeErrorContext = PreparedToolNodeContext & {
  calls: StandardToolCall[];
  call: StandardToolCall;
  toolName: string;
  toolCallId: string;
  toolArgs: Record<string, unknown>;
  exec: ToolExecutionResult;
  bridge: ToolNodeEventBridge;
};

export interface ToolNodeDependencies {
  toolRuntime: Pick<ToolCatalogPort, 'getToolDefinition'> & Pick<ToolExecutionPort, 'executeTool'>;
  observationPreview: ObservationPreviewPort;
  /**
   * 可选：宿主提供的 TelemetryPort 实现。
   * 不传时使用 noopTelemetry（observability 默认关闭，业务零影响）。
   */
  telemetryPort?: TelemetryPort;
  auditPort?: AuditPort;
}

export class ToolNode implements GraphNode {
  id = 'tool';
  private readonly toolRuntime: Pick<ToolCatalogPort, 'getToolDefinition'> & Pick<ToolExecutionPort, 'executeTool'>;
  private readonly observationPreview: ObservationPreviewPort;
  private readonly telemetryPort: TelemetryPort;
  private readonly auditPort: AuditPort;

  constructor(dependencies: ToolNodeDependencies) {
    this.toolRuntime = dependencies.toolRuntime;
    this.observationPreview = dependencies.observationPreview;
    this.telemetryPort = dependencies.telemetryPort ?? noopTelemetry;
    this.auditPort = dependencies.auditPort ?? noopAudit;
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
    runId?: string;
    parentRunId?: string;
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
    toolCallId: string;
    reason: string;
    conversationId: string;
    turnId: string;
    runId?: string;
    parentRunId?: string;
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
          toolCallId: args.toolCallId,
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
        runId: args.runId ?? args.turnId,
        ...(args.parentRunId === undefined ? {} : { parentRunId: args.parentRunId }),
        toolName: args.toolName,
        toolCallId: args.toolCallId,
      },
    });
  }

  async run(state: EngineState): Promise<NodeResult> {
    const events: RuntimeEvent[] = [];

    while (true) {
      const result = await this.runNextPendingToolCall(state);
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

  private async runNextPendingToolCall(state: EngineState): Promise<NodeResult> {
    const calls = (state.local?.pendingToolCalls as StandardToolCall[] | undefined) ?? [];
    const signalRaw = state.local?.signal;
    if (isAbortSignal(signalRaw) && signalRaw.aborted) {
      const abortError = new Error('The user aborted a request.');
      abortError.name = 'AbortError';
      throw abortError;
    }

    const prepared = prepareToolNodeContext(state);
    logger.info('[ToolNode] 开始执行工具节点', {
      conversationId: prepared.conversationId,
      turnId: prepared.turnId,
      pendingCallCount: calls.length,
      citationOffset: prepared.toolContext.citationOffset,
    });

    if (calls.length === 0) {
      return { kind: 'yield', events: [] };
    }

    const call = calls[0];
    const execution = prepareToolExecution({
      prepared,
      call,
      toolCatalog: this.toolRuntime,
    });
    if (!execution) {
      console.warn('[ToolNode] No tool name found in call');
      return { kind: 'yield', events: [] };
    }

    execution.bridge.emitToolProcess('start', 'loading', {
      args: execution.toolArgs,
      tool_calls: [call],
    });

    if (typeof execution.protocolError === 'string') {
      return this.handleError({
        ...prepared,
        calls,
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

    const exec = await this.toolRuntime.executeTool(
      execution.toolName,
      execution.toolArgs,
      prepared.toolContext,
    );
    if (exec.success) {
      const parsed = typeof exec.result === 'string' ? parseJsonSafe(exec.result) : exec.result;
      return this.handleSuccess({
        ...prepared,
        calls,
        toolName: execution.toolName,
        toolCallId: execution.toolCallId,
        exec,
        parsed,
        bridge: execution.bridge,
      });
    }

    return this.handleError({
      ...prepared,
      calls,
      call,
      toolName: execution.toolName,
      toolCallId: execution.toolCallId,
      toolArgs: execution.toolArgs,
      exec,
      bridge: execution.bridge,
    });
  }

  private async handleSuccess(context: ToolNodeSuccessContext): Promise<NodeResult> {
    await this.emitToolDecisionAudit({
      action: 'tool.allow',
      toolName: context.toolName,
      toolCallId: context.toolCallId,
      reason: 'tool execution succeeded',
      conversationId: context.conversationId,
      turnId: context.turnId,
      runId: context.toolContext.runId,
      parentRunId: context.toolContext.parentRunId,
    });
    this.emitToolCallTelemetry({
      toolName: context.toolName,
      durationMs: context.exec.durationMs,
      ok: true,
      conversationId: context.conversationId,
      turnId: context.turnId,
      runId: context.toolContext.runId,
      parentRunId: context.toolContext.parentRunId,
    });

    applyProtocolFuseState(context.local, 0);

    await applyObservationGovernance({
      parsed: context.parsed,
      toolName: context.toolName,
      toolContext: context.toolContext,
      structuredObservation: readStructuredObservation(context.parsed),
      observationPreview: this.observationPreview,
      policy: readToolObservationPolicy(context.local),
    });

    const control = extractToolControlInfo(context.parsed);
    if (control?.requireUser) {
      return this.handleRequireUserSuccess({ ...context, control });
    }

    const runtimeToolOutput = context.bridge.emitToolOutput(
      'success',
      buildSuccessOutputPayload(context.exec.result, context.parsed),
    );
    const finalAnswerProjection = resolveFinalAnswerFromToolResult(context.toolName, context.parsed);
    if (typeof finalAnswerProjection === 'string') {
      context.bridge.emitFinalAnswer({
        answer: finalAnswerProjection,
        sourceToolName: context.toolName,
      });
    }

    applyToolOutputIdempotencyMetadata({
      runtimeToolOutput,
      execIdempotency: context.exec.idempotency,
    });

    const remainingCalls = context.calls.slice(1);
    context.state.local = buildSuccessLocalState({
      local: context.local,
      remainingCalls,
      conversationId: context.conversationId,
      turnId: context.turnId,
      runtimeEvents: context.bridge.getRuntimeEvents(),
    });

    if (context.toolName === readContextCheckpointToolName(context.local)) {
      context.state.local._checkpointStepReset = true;
      logger.info('[ToolNode] context checkpoint 执行成功，设置步数重置标记', {
        toolName: context.toolName,
      });
    }

    if (control?.terminateRun) {
      logger.info('[ToolNode] 收到 control.terminateRun，执行完工具后直接 yield 结束本轮 run', {
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
      local: context.local,
      parsed: context.parsed,
      toolCallId: context.toolCallId,
      toolName: context.toolName,
      remainingCalls: context.calls.slice(1),
      conversationId: context.conversationId,
      turnId: context.turnId,
      runtimeEvents: context.bridge.getRuntimeEvents(),
    });

    return { kind: 'route', nextNodeId: 'wait_user', events: context.bridge.getRuntimeEvents() };
  }

  private async handleError(context: ToolNodeErrorContext): Promise<NodeResult> {
    await this.emitToolDecisionAudit({
      action: context.exec.errorKind === 'protocol' ? 'tool.deny' : 'tool.allow',
      toolName: context.toolName,
      toolCallId: context.toolCallId,
      reason: context.exec.error ?? 'tool_error',
      conversationId: context.conversationId,
      turnId: context.turnId,
      runId: context.toolContext.runId,
      parentRunId: context.toolContext.parentRunId,
      errorKind: context.exec.errorKind,
    });
    this.emitToolCallTelemetry({
      toolName: context.toolName,
      durationMs: context.exec.durationMs,
      ok: false,
      errorCode: context.exec.errorKind,
      conversationId: context.conversationId,
      turnId: context.turnId,
      runId: context.toolContext.runId,
      parentRunId: context.toolContext.parentRunId,
    });

    const errorString = (() => {
      try {
        return JSON.stringify({ error: context.exec.error || 'tool_error' });
      } catch {
        return String(context.exec.error || 'tool_error');
      }
    })();

    context.bridge.emitToolOutput('error', {
      output: errorString,
      error: context.exec.error ?? errorString,
    });

    const fuse = checkProtocolFuse({
      local: context.local,
      exec: context.exec,
      toolName: context.toolName,
      toolCallId: context.toolCallId,
      rawArguments: context.call.function?.arguments,
      parsedArguments: context.toolArgs,
    });
    const remainingCalls = context.calls.slice(1);

    context.state.local = buildErrorLocalState({
      local: context.local,
      remainingCalls,
      conversationId: context.conversationId,
      turnId: context.turnId,
      runtimeEvents: context.bridge.getRuntimeEvents(),
      nextProtocolErrorCount: fuse.nextCount,
    });

    if (fuse.shouldFuse && remainingCalls.length === 0) {
      throw createToolProtocolFuseError(fuse.nextCount, context.exec.error);
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
