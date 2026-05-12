/**
 * @file src/agent/runtime-kernel/graph-engine/executor.ts
 *
 * @brief 图执行引擎的单步推理执行器
 */
import type { LlmCaller } from '../llm/caller';
import { createEmptyModelCatalog, type ModelCatalogLike } from '../llm/modelCatalog';
import { ModelResolver, type ModelResolverLike } from '../llm/modelResolver';
import { noopTelemetry } from '../telemetry/noopTelemetry';
import type { TelemetryPort } from '../telemetry/telemetryPort';
import { noopAudit } from '../audit/noopAudit';
import type { AuditPort } from '../../ports';
import type { ToolCatalogPort, ToolPresentationPort } from '../tools/ports';
import { Logger } from '../../shared/logger';
import type { GraphExecutorContextBuilder } from './executorContextBuilder';
import {
  resolveConversationIdForRuntimeEvents,
  readNonEmptyString,
} from './tick-pipeline/helpers';
import { contextAuditMiddleware } from './tick-pipeline/middlewares/contextAuditMiddleware';
import { llmTelemetryMiddleware } from './tick-pipeline/middlewares/llmTelemetryMiddleware';
import { runModelLockMiddleware } from './tick-pipeline/middlewares/runModelLockMiddleware';
import { runTickPipeline } from './tick-pipeline/runTickPipeline';
import { createApplySystemReminderStage } from './tick-pipeline/stages/applySystemReminderStage';
import { createBuildContextStage } from './tick-pipeline/stages/buildContextStage';
import { createBuildDecisionStage } from './tick-pipeline/stages/buildDecisionStage';
import { createExecuteLlmStage } from './tick-pipeline/stages/executeLlmStage';
import { createPrepareCallStage } from './tick-pipeline/stages/prepareCallStage';
import type {
  TickAroundMiddleware,
  TickEvent,
  TickInput,
  TickOutput,
  TickPipelineContext,
  TickStage,
} from './tick-pipeline/types';

export type {
  AgentStepDecision,
  TickEvent,
  TickInput,
  TickOutput,
} from './tick-pipeline/types';

const logger = new Logger('GraphAgentExecutor');

export interface GraphAgentExecutorOptions {
  cloudQuotaFallbackModelId?: string;
  modelCatalog?: ModelCatalogLike;
  modelResolver?: Pick<ModelResolverLike, 'resolveModelId'>;
}

export interface GraphAgentExecutorToolRuntime
  extends Pick<ToolCatalogPort, 'getToolSchemas'>,
    Pick<ToolPresentationPort, 'getDisplayOptions'> {}

export interface GraphAgentExecutorLlmCaller
  extends Pick<LlmCaller, 'callWithRetries'> {}

export interface GraphAgentExecutorDependencies extends GraphAgentExecutorOptions {
  llmCaller: GraphAgentExecutorLlmCaller;
  toolRuntime: GraphAgentExecutorToolRuntime;
  contextBuilder: GraphExecutorContextBuilder;
  /**
   * 可选：宿主提供的 TelemetryPort 实现。
   * 不传时使用 noopTelemetry（保持当前行为：observability 默认关闭，零业务影响）。
   */
  telemetryPort?: TelemetryPort;
  auditPort?: AuditPort;
}

export class GraphAgentExecutor {
  private readonly llmCaller: GraphAgentExecutorLlmCaller;
  private readonly toolRuntime: GraphAgentExecutorToolRuntime;
  private readonly contextBuilder: GraphExecutorContextBuilder;
  private readonly cloudQuotaFallbackModelId?: string;
  private readonly modelResolver: Pick<ModelResolverLike, 'resolveModelId'>;
  private readonly modelCatalog: ModelCatalogLike;
  private readonly telemetryPort: TelemetryPort;
  private readonly auditPort: AuditPort;
  private readonly stages: TickStage[];
  private readonly middlewares: TickAroundMiddleware[];

  constructor(
    dependencies: GraphAgentExecutorDependencies,
  ) {
    this.llmCaller = dependencies.llmCaller;
    this.toolRuntime = dependencies.toolRuntime;
    this.contextBuilder = dependencies.contextBuilder;
    this.cloudQuotaFallbackModelId = readNonEmptyString(dependencies.cloudQuotaFallbackModelId);
    this.modelCatalog = dependencies.modelCatalog ?? createEmptyModelCatalog();
    this.modelResolver =
      dependencies.modelResolver ??
      new ModelResolver({
        modelCatalog: this.modelCatalog,
      });
    this.telemetryPort = dependencies.telemetryPort ?? noopTelemetry;
    this.auditPort = dependencies.auditPort ?? noopAudit;
    this.stages = [
      createPrepareCallStage({
        modelResolver: this.modelResolver,
        modelCatalog: this.modelCatalog,
        toolCatalog: this.toolRuntime,
        cloudQuotaFallbackModelId: this.cloudQuotaFallbackModelId,
      }),
      createBuildContextStage({
        contextBuilder: this.contextBuilder,
      }),
      createApplySystemReminderStage(),
      createExecuteLlmStage({
        llmCaller: this.llmCaller,
      }),
      createBuildDecisionStage({
        toolPresentation: this.toolRuntime,
      }),
    ];
    this.middlewares = [
      contextAuditMiddleware,
      llmTelemetryMiddleware,
      runModelLockMiddleware,
    ];
  }

  async tick(
    input: TickInput,
    eventHandler?: (event: TickEvent) => void,
  ): Promise<TickOutput> {
    const ctx: TickPipelineContext = {
      input,
      eventHandler,
      newEvents: [],
      request: input.request,
      history: input.history,
      signal: input.signal,
      forceFinalAnswer: input.forceFinalAnswer === true,
      executorLocal: input.executorLocal,
      summarizationCallbacks: input.summarizationCallbacks,
      modelId: '',
      toolSchemas: [],
      llmOptions: {},
      llmMessages: [],
      mode: input.request.mode === 'chat' ? 'chat' : 'agent',
      conversationId: resolveConversationIdForRuntimeEvents(input.toolContext),
      turnId: readNonEmptyString(input.toolContext?.turnId) ?? `turn_${Date.now()}`,
      telemetry: this.telemetryPort,
      audit: this.auditPort,
    };

    logger.info('[GraphAgentExecutor] tick 调用', {
      stream: input.stream === true,
      mode: ctx.mode,
      hasEventHandler: Boolean(eventHandler),
      hasSummarizationCallbacks: Boolean(input.summarizationCallbacks),
    });

    await runTickPipeline(ctx, this.stages, this.middlewares);

    return {
      decision: ctx.decision ?? { kind: 'yield' },
      newEvents: ctx.newEvents,
    };
  }
}
