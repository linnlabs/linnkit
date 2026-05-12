import type { AgentProfileRequest } from '../contracts';
import {
  AgentContextManager,
  type AgentBuildPhase,
  type ContextBuildResult,
  ConversationSession,
} from '../context';
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
import type { GenerateRequest, GenerateResponse } from '../../chat/contracts';
import type { AgentSpecContextPolicy, AiMessage, RuntimeEvent } from '../../../../contracts';
import type { FenceRegistry } from '../../../shared/fences';
import {
  contextPolicyToContextBuilderConfig,
  contextPolicyToPreprocessorOptions,
} from '../../../shared/agentSpecAdapter';

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
  taskResolver: AgentTaskResolver;
  providerRegistry: ContextProviderRegistry;
  fenceRegistry?: FenceRegistry;
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
    };
    processingStats: ContextBuildResult['processingStats'];
    truncated: boolean;
    truncatedCount?: number;
  };
}

export class AgentMessageOrchestrator {
  private agentContextManager: AgentContextManager;
  private options: AgentOrchestratorOptions;
  private readonly taskResolver: AgentTaskResolver;
  private baseContextConfig: Partial<AgentContextBuilderConfig>;

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
    this.agentContextManager = new AgentContextManager({
      debugMode: options.processing.debugMode,
      customConfig: this.baseContextConfig,
      providerRegistry: options.providerRegistry,
    });
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

  private applyContextPolicy(
    request: AgentProfileRequest,
    contextPolicy: AgentSpecContextPolicy | undefined,
  ): void {
    const contextBuilderConfig = {
      ...this.baseContextConfig,
      ...(contextPolicy ? contextPolicyToContextBuilderConfig(contextPolicy) : {}),
    };
    const providerRegistry = this.options.createProviderRegistry?.({
      request,
      contextPolicy,
      contextBuilderConfig,
    }) ?? this.options.providerRegistry;

    this.agentContextManager = new AgentContextManager({
      debugMode: this.options.processing.debugMode,
      customConfig: contextBuilderConfig,
      providerRegistry,
    });
  }

  async processAgentConversation(
    request: AgentProfileRequest,
    history: RuntimeEvent[],
    toolManager: ToolManager,
    callbacks?: SummarizationCallbacks,
    extraOptions?: {
      generate?: (request: GenerateRequest) => Promise<GenerateResponse>;
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
      this.applyContextPolicy(request, contextPolicy);

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

      const tempSession = new ConversationSession('');
      tempSession.getHistory().length = 0;
      preprocessResult.messages.forEach((msg) => {
        tempSession.getHistory().push(msg);
      });

      const contextResult = await this.buildContextFromPreprocessedMessages(
        request,
        tempSession,
        preprocessResult.messages,
        callbacks,
        undefined,
        extraOptions?.generate,
        contextPolicy,
      );
      this.debug('Context built', { afterContextCount: contextResult.messages.length });

      if (this.options.processing.debugMode) {
        console.log(
          '[AgentMessageOrchestrator] DEBUG: Messages after context build:',
          JSON.stringify(
            contextResult.messages.map((m) => ({
              id: m.id,
              ts: m.timestamp,
              role: m.role,
              type: m.type,
              content: m.content.substring(0, 50),
            })),
            null,
            2
          )
        );
      }

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
            budget: this.options.tokenBudget.maxTokens,
            remaining: contextResult.tokenUsage.remaining,
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
    request: AgentProfileRequest,
    conversationSession: ConversationSession,
    messages: AiMessage[],
    callbacks?: SummarizationCallbacks,
    phaseOverride?: AgentBuildPhase,
    generate?: (request: GenerateRequest) => Promise<GenerateResponse>,
    contextPolicy?: AgentSpecContextPolicy,
  ): Promise<ContextBuildResult> {
    const totalBudget =
      this.options.tokenBudget.maxTokens - this.options.tokenBudget.reservedForResponse;

    const contextResult = await this.agentContextManager.buildContextFromPreprocessedMessages(
      request,
      conversationSession,
      messages,
      totalBudget,
      callbacks,
      phaseOverride,
      generate,
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
      console.log(`[AgentMessageOrchestrator] ${message}`, data);
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
    this.agentContextManager.updateConfig(this.baseContextConfig);
  }

  getContextManager(): AgentContextManager {
    return this.agentContextManager;
  }

  getContextInfo(): { config: AgentContextBuilderConfig } {
    return {
      config: this.agentContextManager.getConfig(),
    };
  }
}
