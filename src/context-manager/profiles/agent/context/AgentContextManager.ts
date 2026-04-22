import type { AgentProfileRequest } from '../contracts';
import { ConversationSession } from './ConversationSession';
import { 
  AGENT_CONTEXT_BUILDER_CONFIG,
  AgentBuildPhase,
  AgentContextBuildStats,
  validateAgentConfig,
  AgentContextBuilderConfig
} from './config';
import { 
  ProviderContext,
  ContextProviderRegistry,
  SummarizationCallbacks
} from './providers';
import {
  ContextManagerBase,
  type ContextManagerBaseOptions,
} from '../../../shared/context-manager-base';
import {
  buildContextResult,
  generateContextRecommendations,
} from '../../../shared/context-result';
import type { GenerateRequest, GenerateResponse } from '../../chat/contracts';
import type { AiMessage, RuntimeEvent } from '../../../../contracts';

/**
 * Agent 专用的 Provider 上下文
 * 继承自基础 ProviderContext，并添加 Agent 特有的信息
 */
export interface AgentProviderContext extends ProviderContext {
  agentRequest: AgentProfileRequest;
}

/**
 * 上下文构建结果接口
 */
export interface ContextBuildResult {
  /** 构建后的消息列表 */
  messages: AiMessage[];
  
  /** Token使用情况 */
  tokenUsage: {
    used: number;
    remaining: number;
  };
  
  /** 处理统计信息 */
  processingStats: {
    originalCount: number;
    keptCount: number;
    truncatedCount: number;
    tokenDistribution: Record<string, number>;
    strategiesApplied: string[];
    recommendations: string[];
    buildStats?: AgentContextBuildStats;
  };
  
  /** 是否进行了截断 */
  truncated: boolean;
  
  /** 截断的消息数量 */
  truncatedCount?: number;
  
  /** 应用的策略列表 */
  strategies: {
    applied: string[];
    recommendations: string[];
  };
  
  /** 🔥 新增：Provider生成的运行时事件（如摘要事件） */
  events?: RuntimeEvent[];
}

/**
 * Agent专用智能上下文管理器
 * 
 * 🎯 核心职责: 
 * 1. 编排Provider执行，构建优化的上下文
 * 2. 保证工具调用的完整性和配对保留
 * 3. 使用统一配置，不感知对话阶段
 * 
 * 🏗️ 架构特性:
 * - Provider策略模式: 实现高内聚、低耦合
 * - 责任链模式: 按优先级编排Provider
 * - 专注于Provider编排，不负责消息构建
 */
export class AgentContextManager extends ContextManagerBase<
  AgentContextBuilderConfig,
  ContextProviderRegistry
> {

  constructor(options: {
    debugMode?: boolean;
    customConfig?: Partial<AgentContextBuilderConfig>;
    providerRegistry?: ContextProviderRegistry;
  } = {}) {
    super(options as ContextManagerBaseOptions<
      AgentContextBuilderConfig,
      ContextProviderRegistry
    >, {
      defaultConfig: AGENT_CONTEXT_BUILDER_CONFIG,
      validateConfig: validateAgentConfig,
      createRegistry: () => new ContextProviderRegistry(),
      loggerName: 'AgentContextManager',
      invalidConfigMessage: 'Invalid AgentContextManager configuration',
    });

    this.debug('🏗️ [Agent上下文管理器] 初始化完成', {
      providersCount: this.providerRegistry.getAllProviders().length
    });
  }

  /**
   * 主入口：为Agent构建智能上下文
   * 专门处理预处理过的消息，专注于上下文优化
   */
  async buildContextFromPreprocessedMessages(
    request: AgentProfileRequest,
    conversationSession: ConversationSession,
    preprocessedMessages: AiMessage[],
    totalBudget: number,
    callbacks?: SummarizationCallbacks,
    phaseOverride?: any,  // 保留参数兼容性，但不再使用
    generate?: (request: GenerateRequest) => Promise<GenerateResponse>
  ): Promise<ContextBuildResult> {
    // 计算摘要触发相关信息
    const summarizationThreshold = this.config.SUMMARIZATION_TRIGGER_THRESHOLD;
    const summarizationTokenThreshold = Math.floor(totalBudget * summarizationThreshold);
    
    this.debug('🎯 [Agent上下文管理器] 开始上下文构建', { 
      requestQuery: request.query.substring(0, 50),
      preprocessedMessageCount: preprocessedMessages.length,
      totalBudget,
      摘要触发阈值: `${(summarizationThreshold * 100).toFixed(0)}%`,
      摘要Token阈值: summarizationTokenThreshold
    });

    const startTime = performance.now();
    const buildStats: AgentContextBuildStats = this.initializeBuildStats(startTime, preprocessedMessages.length);

    try {
      // 创建 ProviderContext
      const enhancedContext: AgentProviderContext = {
        totalBudget,
        config: this.config,
        debugMode: this.debugMode,
        estimateTokens: (msg: AiMessage) => this.estimateTokens(msg),
        summarizationCallbacks: callbacks,
        generate,
        agentRequest: request
      };

      // 核心流程：编排各个Provider按优先级处理预处理过的消息
      const { finalMessages, finalTokens, strategiesApplied, events } =
        await this.runPipeline({
          messages: preprocessedMessages,
          totalBudget,
          buildStats,
          providerContext: enhancedContext,
          getPhaseByProviderName: providerName => this.getPhaseByProviderName(providerName),
        });
      
      const endTime = performance.now();
      buildStats.totalTime = endTime - startTime;
      
      // 计算摘要触发相关信息
      const summarizationThreshold = this.config.SUMMARIZATION_TRIGGER_THRESHOLD;
      const summarizationTokenThreshold = Math.floor(totalBudget * summarizationThreshold);
      
      this.debug('✅ [Agent上下文管理器] 上下文构建完成', {
        预处理消息: preprocessedMessages.length,
        最终消息: finalMessages.length,
        Token使用: finalTokens,
        总预算: totalBudget,
        使用率: `${((finalTokens / totalBudget) * 100).toFixed(1)}%`,
        摘要触发阈值: `${(summarizationThreshold * 100).toFixed(0)}%`,
        摘要Token阈值: summarizationTokenThreshold,
        总耗时: `${buildStats.totalTime.toFixed(2)}ms`
      });

      return this.buildFinalResult(
        finalMessages, 
        finalTokens, 
        totalBudget, 
        preprocessedMessages.length, 
        strategiesApplied, 
        buildStats,
        events
      );

    } catch (error) {
      this.debug('❌ [Agent上下文管理器] 上下文构建失败', { error });
      throw new Error(`Agent context building failed: ${error}`);
    }
  }

  // ------------------- 核心Provider编排方法 -------------------

  // ------------------- 辅助方法 -------------------

  /**
   * 根据Provider名称获取对应的阶段名称
   */
  private getPhaseByProviderName(providerName: string): AgentBuildPhase | null {
    const phaseMap: Record<string, AgentBuildPhase> = {
      'CoreContextProvider': AgentBuildPhase.CORE_CONTEXT,
      'WorkingMemoryProvider': AgentBuildPhase.WORKING_MEMORY,
      'SummarizationProvider': AgentBuildPhase.SUMMARIZATION
    };
    return phaseMap[providerName] || null;
  }

  private initializeBuildStats(startTime: number, originalMessageCount: number): AgentContextBuildStats {
    return {
      startTime,
      phaseTiming: {} as Record<AgentBuildPhase, number>,
      phaseTokenUsage: {} as Record<AgentBuildPhase, { used: number; percentage: number }>,
      messageStats: {
        original: originalMessageCount,
        afterCoreContext: 0,
        afterWorkingMemory: 0,
        afterSummarization: 0
      },
      priorityStats: {
        p1ToolInteractions: 0,
        p2TextConversations: 0,
        p3HistoricalTools: 0,
        p4CircularFill: 0
      },
      toolStats: {
        totalToolCalls: 0,
        pairedToolCalls: 0,
        unpairedToolCalls: 0,
        toolPairingSuccessRate: 0
      },
      summarizationTriggered: false,
      documentTruncated: false,
      totalTime: 0
    };
  }

  private buildFinalResult(
    finalMessages: AiMessage[],
    finalTokens: number,
    totalBudget: number,
    originalCount: number,
    strategiesApplied: string[],
    buildStats: AgentContextBuildStats,
    events: RuntimeEvent[] = []  // 🔥 新增：事件列表
  ): ContextBuildResult {
    const recommendations = this.generateRecommendations(buildStats, totalBudget);
    return buildContextResult({
      finalMessages,
      finalTokens,
      totalBudget,
      originalCount,
      strategiesApplied,
      buildStats,
      enableBuildStats: this.config.ENABLE_BUILD_STATS,
      estimateTokens: message => this.estimateTokens(message),
      coreTypes: this.config.CORE_MESSAGE_TYPES,
      recommendations,
      events,
    });
  }
  /**
   * 生成优化建议
   */
  private generateRecommendations(stats: AgentContextBuildStats, totalBudget: number): string[] {
    return generateContextRecommendations(stats, {
      totalBudget,
      processingTimeoutMs: this.config.PROCESSING_TIMEOUT_MS,
    });
  }
}
