import type { AgentProfileRequest } from '../contracts';
import {
  AgentContextManager,
  type AgentBuildPhase,
  type ContextBuildResult,
} from '../context';
import type { ContextManagerBaseOptions } from '../../../shared/context-manager-base';
import {
  AGENT_CONTEXT_BUILDER_CONFIG,
  type AgentContextBuilderConfig,
} from '../context/config';
import type { SummarizationCallbacks } from '../context/providers/base';
import type { ContextProviderRegistry } from '../context/providers';
import {
  type PreprocessorPipeline,
  type PreprocessorPipelineResult,
  createDefaultAgentPreprocessorPipeline,
  type ToolReplayProtocolPolicy,
} from '../preprocessors';
import { ToolManager } from '../tools/ToolManager';
import type { AgentTaskResolver } from '../tasks/base';
import { convertEventsToAiMessages } from '../utils/eventConverter';
import type {
  SummaryGenerationRequest,
  SummaryGenerationResponse,
} from '../../../shared/contracts/summaryGeneration';
import { recordBeforeContextManager } from '../../../../shared/llmAuditRecorder';
import type {
  AgentSpecContextPolicy,
  AiMessage,
  RuntimeEvent,
  TokenCountConfidence,
  TokenCountSource,
  TokenRoute,
  TokenUsageCalibrationSample,
} from '../../../../contracts';
import type {
  LlmImageInputEstimatorPort,
  TokenCounterPort,
  TokenizerPort,
} from '../../../../ports';
import type { FenceRegistry } from '../../../shared/fences';
import {
  contextPolicyToContextBuilderConfig,
  contextPolicyToPreprocessorOptions,
} from '../../../shared/agentSpecAdapter';
import { Logger } from '../../../../shared/logger';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readOptionalStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : undefined;
}

export interface AgentOrchestratorOptions {
  tokenBudget: {
    maxTokens: number;
    reservedForResponse: number;
  };
  processing: {
    debugMode?: boolean;
    preserveMetadata?: boolean;
  };
  model?: string;
  resolveToolReplayProtocolPolicy?: (params: {
    request: AgentProfileRequest;
    modelId: string;
  }) => ToolReplayProtocolPolicy | undefined;
  resolveContextPolicy?: (request: AgentProfileRequest) => AgentSpecContextPolicy | undefined;
  createProviderRegistry?: (params: {
    request: AgentProfileRequest;
    contextPolicy: AgentSpecContextPolicy | undefined;
    contextBuilderConfig: Partial<AgentContextBuilderConfig>;
  }) => ContextProviderRegistry;
  resolveTokenCalibration?: (params: {
    request: AgentProfileRequest;
    modelId: string;
    contextPolicy: AgentSpecContextPolicy | undefined;
  }) => {
    route?: TokenRoute;
    samples?: readonly TokenUsageCalibrationSample[];
  } | undefined;
  taskResolver: AgentTaskResolver;
  providerRegistry: ContextProviderRegistry;
  fenceRegistry?: FenceRegistry;
  tokenizer?: TokenizerPort;
  tokenCounter?: TokenCounterPort;
  imageInputEstimator?: LlmImageInputEstimatorPort;
  resolveTokenRoute?: (params: {
    request: AgentProfileRequest;
    modelId: string;
    contextPolicy: AgentSpecContextPolicy | undefined;
  }) => TokenRoute | undefined;
}

export interface AgentProcessingResult {
  messages: AiMessage[];
  contextBuildResult: ContextBuildResult;
  metadata: {
    originalCount: number;
    processedCount: number;
    tokenUsage: {
      estimated: number;
      budget: number;
      remaining: number;
      source: TokenCountSource;
      confidence: TokenCountConfidence;
    };
    processingStats: ContextBuildResult['processingStats'];
    truncated: boolean;
    truncatedCount?: number;
  };
}

interface EffectiveContextBudget {
  maxTokens: number;
  reservedForResponse: number;
  totalBudget: number;
}

interface RequestContextAssembly {
  contextBuilderConfig: Partial<AgentContextBuilderConfig>;
  contextManager: AgentContextManager;
}

type AgentContextManagerOptions = NonNullable<ConstructorParameters<typeof AgentContextManager>[0]>;
type AgentRemoteCountPolicy = ContextManagerBaseOptions<
  AgentContextBuilderConfig,
  ContextProviderRegistry
>['remoteCount'];
type AgentTokenCalibrationOptions = ContextManagerBaseOptions<
  AgentContextBuilderConfig,
  ContextProviderRegistry
>['tokenCalibration'];

export class AgentMessageOrchestrator {
  private baseAgentContextManager: AgentContextManager;
  private options: AgentOrchestratorOptions;
  private readonly taskResolver: AgentTaskResolver;
  private baseContextConfig: Partial<AgentContextBuilderConfig>;
  private readonly logger = new Logger('AgentMessageOrchestrator');

  constructor(options: AgentOrchestratorOptions) {
    this.options = options;
    this.taskResolver = options.taskResolver;
    this.baseContextConfig = {
      DEFAULT_MAX_TOKENS: options.tokenBudget.maxTokens,
      RESERVED_FOR_RESPONSE: options.tokenBudget.reservedForResponse,
      WORKING_MEMORY_BUDGET_PERCENTAGE: AGENT_CONTEXT_BUILDER_CONFIG.WORKING_MEMORY_BUDGET_PERCENTAGE,
      SUMMARIZATION_TRIGGER_THRESHOLD: AGENT_CONTEXT_BUILDER_CONFIG.SUMMARIZATION_TRIGGER_THRESHOLD,
      SUMMARY_BUDGET_PERCENTAGE: AGENT_CONTEXT_BUILDER_CONFIG.SUMMARY_BUDGET_PERCENTAGE,
      SUMMARY_OLDEST_MESSAGES_PERCENTAGE: AGENT_CONTEXT_BUILDER_CONFIG.SUMMARY_OLDEST_MESSAGES_PERCENTAGE,
    };
    this.baseAgentContextManager = this.createAgentContextManager({
      debugMode: options.processing.debugMode,
      customConfig: this.baseContextConfig,
      providerRegistry: options.providerRegistry,
      tokenizer: options.tokenizer,
      tokenizerModelId: options.model,
      tokenCounter: options.tokenCounter,
      imageInputEstimator: options.imageInputEstimator,
    });
  }

  private createAgentContextManager(options: {
    debugMode?: boolean;
    customConfig: Partial<AgentContextBuilderConfig>;
    providerRegistry: ContextProviderRegistry;
    tokenizer?: TokenizerPort;
    tokenizerModelId?: string;
    tokenCounter?: TokenCounterPort;
    tokenRoute?: TokenRoute;
    remoteCount?: AgentRemoteCountPolicy;
    tokenCalibration?: AgentTokenCalibrationOptions;
    imageInputEstimator?: LlmImageInputEstimatorPort;
  }): AgentContextManager {
    const managerOptions: AgentContextManagerOptions = options;
    return new AgentContextManager(managerOptions);
  }

  private buildPreprocessorPipelineForRequest(
    toolManager: ToolManager,
    request: AgentProfileRequest,
    contextPolicy: AgentSpecContextPolicy | undefined,
  ): PreprocessorPipeline {
    return createDefaultAgentPreprocessorPipeline({
      debugMode: this.options.processing.debugMode,
      model: this.resolvePreprocessorModel(request),
      toolSummaryProvider: toolManager.getSummaryProvider(),
    }, {
      fenceRegistry: this.options.fenceRegistry,
      ...contextPolicyToPreprocessorOptions(contextPolicy),
    });
  }

  private resolvePreprocessorModel(request: AgentProfileRequest): string {
    return readOptionalStringProperty(request, 'model_id')
      ?? readOptionalStringProperty(request, 'modelId')
      ?? this.options.model
      ?? 'default';
  }

  private resolveContextPolicy(request: AgentProfileRequest): AgentSpecContextPolicy | undefined {
    return this.options.resolveContextPolicy?.(request);
  }

  private assembleRequestContext(
    request: AgentProfileRequest,
    contextPolicy: AgentSpecContextPolicy | undefined,
  ): RequestContextAssembly {
    const contextBuilderConfig = {
      ...this.baseContextConfig,
      ...(contextPolicy ? contextPolicyToContextBuilderConfig(contextPolicy) : {}),
    };
    const providerRegistry = this.options.createProviderRegistry?.({
      request,
      contextPolicy,
      contextBuilderConfig,
    }) ?? this.options.providerRegistry;
    const modelId = this.resolvePreprocessorModel(request);
    const tokenCalibration = this.options.resolveTokenCalibration?.({
      request,
      modelId,
      contextPolicy,
    });
    const tokenRoute = this.options.resolveTokenRoute?.({
      request,
      modelId,
      contextPolicy,
    }) ?? tokenCalibration?.route;

    const contextManager = this.createAgentContextManager({
      debugMode: this.options.processing.debugMode,
      customConfig: contextBuilderConfig,
      providerRegistry,
      tokenizer: this.options.tokenizer,
      tokenizerModelId: modelId,
      tokenCounter: this.options.tokenCounter,
      tokenRoute,
      remoteCount: contextPolicy?.tokenEstimation?.remoteCount,
      tokenCalibration: {
        policy: contextPolicy?.tokenEstimation?.calibration,
        route: tokenCalibration?.route,
        samples: tokenCalibration?.samples,
      },
      imageInputEstimator: this.options.imageInputEstimator,
    });

    return {
      contextBuilderConfig,
      contextManager,
    };
  }

  private resolveEffectiveContextBudget(
    contextBuilderConfig: Partial<AgentContextBuilderConfig>,
  ): EffectiveContextBudget {
    const maxTokens = contextBuilderConfig.DEFAULT_MAX_TOKENS ?? this.options.tokenBudget.maxTokens;
    const reservedForResponse =
      contextBuilderConfig.RESERVED_FOR_RESPONSE ?? this.options.tokenBudget.reservedForResponse;

    return {
      maxTokens,
      reservedForResponse,
      // 中文备注：ContextManager 接收的是“可放入上下文的输入预算”，不是模型完整窗口。
      // 因此单个 agent 通过 contextPolicy.budget 覆盖预算时，这里必须同步使用覆盖后的值。
      totalBudget: maxTokens - reservedForResponse,
    };
  }

  async processAgentConversation(
    request: AgentProfileRequest,
    history: RuntimeEvent[],
    toolManager: ToolManager,
    callbacks?: SummarizationCallbacks,
    extraOptions?: {
      generateSummary?: (
        request: SummaryGenerationRequest,
      ) => Promise<SummaryGenerationResponse>;
    }
  ): Promise<AgentProcessingResult> {
    const historyCount = history.length;

    this.debug('Starting agent conversation processing', {
      requestQuery: request.query.substring(0, 50),
      historyEventCount: historyCount,
      availableTools: request.availableTools || 'all_tools',
    });

    const startTime = performance.now();

    try {
      const historyMessages = convertEventsToAiMessages(history);
      this.debug('Converted history events to messages', {
        eventCount: history.length,
        messageCount: historyMessages.length,
      });

      const allMessages = this.buildCompleteMessageList(request, historyMessages);
      this.debug('Built complete message list', { totalCount: allMessages.length });

      const contextPolicy = this.resolveContextPolicy(request);
      const { contextBuilderConfig, contextManager } = this.assembleRequestContext(request, contextPolicy);
      const effectiveContextBudget = this.resolveEffectiveContextBudget(contextBuilderConfig);

      const preprocessorPipeline = this.buildPreprocessorPipelineForRequest(toolManager, request, contextPolicy);
      const modelId = this.resolvePreprocessorModel(request);
      preprocessorPipeline.updateContext({
        model: modelId,
        toolReplayProtocolPolicy: this.options.resolveToolReplayProtocolPolicy?.({
          request,
          modelId,
        }),
      });

      const preprocessResult = await this.runPreprocessorPipeline(preprocessorPipeline, allMessages);
      this.debug('Preprocessor pipeline completed', {
        originalCount: allMessages.length,
        processedCount: preprocessResult.messages.length,
        appliedStrategies: preprocessResult.pipelineStats.appliedStrategies,
      });
      recordBeforeContextManager({
        payload: {
          request,
          history,
          preprocessedMessages: preprocessResult.messages,
          preprocessorStrategies: preprocessResult.pipelineStats.appliedStrategies,
        },
      });

      const contextResult = await this.buildContextFromPreprocessedMessages(
        contextManager,
        request,
        preprocessResult.messages,
        callbacks,
        undefined,
        extraOptions?.generateSummary,
        contextPolicy,
        effectiveContextBudget.totalBudget,
      );
      this.debug('Context built', { afterContextCount: contextResult.messages.length });

      this.debug('Messages after context build', {
        messages: contextResult.messages.map((m) => ({
          id: m.id,
          ts: m.timestamp,
          role: m.role,
          type: m.type,
          content: m.content.substring(0, 50),
        })),
      });

      const endTime = performance.now();
      const processingTime = endTime - startTime;

      this.debug('Processing completed', {
        processingTime: `${processingTime.toFixed(2)}ms`,
        finalMessageCount: contextResult.messages.length,
      });

      return {
        messages: contextResult.messages,
        contextBuildResult: contextResult,
        metadata: {
          originalCount: allMessages.length,
          processedCount: contextResult.messages.length,
          tokenUsage: {
            estimated: contextResult.tokenUsage.used,
            budget: effectiveContextBudget.totalBudget,
            remaining: contextResult.tokenUsage.remaining,
            source: contextResult.tokenUsage.source,
            confidence: contextResult.tokenUsage.confidence,
          },
          processingStats: contextResult.processingStats,
          truncated: contextResult.truncated,
          truncatedCount: contextResult.truncatedCount,
        },
      };
    } catch (error) {
      this.debug('Processing failed', { error });
      throw new Error(`Agent message processing failed: ${error}`);
    }
  }

  private buildCompleteMessageList(request: AgentProfileRequest, historyMessages: AiMessage[]): AiMessage[] {
    const task = this.taskResolver(request.promptKey);
    return task.buildMessages(request, historyMessages);
  }

  private async runPreprocessorPipeline(
    preprocessorPipeline: PreprocessorPipeline,
    messages: AiMessage[],
  ): Promise<PreprocessorPipelineResult> {
    return preprocessorPipeline.process(messages);
  }

  private async buildContextFromPreprocessedMessages(
    contextManager: AgentContextManager,
    request: AgentProfileRequest,
    messages: AiMessage[],
    callbacks?: SummarizationCallbacks,
    phaseOverride?: AgentBuildPhase,
    generateSummary?: (
      request: SummaryGenerationRequest,
    ) => Promise<SummaryGenerationResponse>,
    contextPolicy?: AgentSpecContextPolicy,
    totalBudget?: number,
  ): Promise<ContextBuildResult> {
    const resolvedTotalBudget =
      totalBudget ?? this.options.tokenBudget.maxTokens - this.options.tokenBudget.reservedForResponse;

    const contextResult = await contextManager.buildContextFromPreprocessedMessages(
      request,
      messages,
      resolvedTotalBudget,
      callbacks,
      phaseOverride,
      generateSummary,
      {
        policy: contextPolicy?.contextTrace,
        effectiveContextPolicy: contextPolicy,
      },
    );

    if (this.options.processing.debugMode) {
      this.debug('Context build result', {
        original: contextResult.processingStats.originalCount,
        kept: contextResult.processingStats.keptCount,
        truncated: contextResult.processingStats.truncatedCount,
        strategies: contextResult.strategies.applied,
        tokenUsage: contextResult.tokenUsage,
        recommendations: contextResult.strategies.recommendations,
        buildStats: contextResult.processingStats.buildStats,
      });
    }

    return contextResult;
  }

  private debug(message: string, data?: Record<string, unknown>): void {
    if (this.options.processing.debugMode) {
      this.logger.debug(message, data);
    }
  }

  updateOptions(newOptions: Partial<AgentOrchestratorOptions>): void {
    this.options = {
      ...this.options,
      ...newOptions,
      tokenBudget: { ...this.options.tokenBudget, ...newOptions.tokenBudget },
      processing: { ...this.options.processing, ...newOptions.processing },
    };
    this.baseContextConfig = {
      ...this.baseContextConfig,
      DEFAULT_MAX_TOKENS: this.options.tokenBudget.maxTokens,
      RESERVED_FOR_RESPONSE: this.options.tokenBudget.reservedForResponse,
    };
    this.baseAgentContextManager.updateConfig(this.baseContextConfig);
    this.baseAgentContextManager.updateTokenizerModelId(this.options.model);
  }

  getContextManager(): AgentContextManager {
    return this.baseAgentContextManager;
  }

  getContextInfo(): { config: AgentContextBuilderConfig } {
    return {
      config: this.baseAgentContextManager.getConfig(),
    };
  }
}
