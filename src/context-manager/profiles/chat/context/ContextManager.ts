import { 
  CONTEXT_BUILDER_CONFIG,
  BuildPhase,
  ContextBuildStats,
  validateConfig,
  ContextBuilderConfig
} from './config';
import { 
  IContextProvider, 
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
import type { GenerateRequest, GenerateResponse } from '../contracts';
import type { AiMessage, RuntimeEvent } from '../../../../contracts';

/**
 * 上下文构建结果接口 - 与TokenBudgetManager保持兼容
 */
export interface ContextBuildResult {
  /** 构建后的消息列表 */
  messages: AiMessage[];
  
  /** Token使用情况 */
  tokenUsage: {
    used: number;
    remaining: number;
  };
  
  /** 处理统计信息 - 兼容TokenBudgetManager格式 */
  processingStats: {
    originalCount: number;
    keptCount: number;
    truncatedCount: number;
    tokenDistribution: Record<string, number>;
    strategiesApplied: string[];
    recommendations: string[];
    // 新增的上下文构建统计
    buildStats?: ContextBuildStats;
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
 * 智能上下文管理器 - Provider编排器
 * 
 * 🎯 职责: 编排各个ContextProvider，协调3阶段上下文构建流程
 * 🏗️ 架构: 策略模式 + 责任链模式，实现高内聚、低耦合
 */
export class ContextManager extends ContextManagerBase<
  ContextBuilderConfig,
  ContextProviderRegistry
> {

  constructor(options: {
    debugMode?: boolean;
    customConfig?: Partial<ContextBuilderConfig>;
    providerRegistry?: ContextProviderRegistry;
  } = {}) {
    super(options as ContextManagerBaseOptions<ContextBuilderConfig, ContextProviderRegistry>, {
      defaultConfig: CONTEXT_BUILDER_CONFIG,
      validateConfig,
      createRegistry: () => new ContextProviderRegistry(),
      loggerName: 'ContextManager',
      invalidConfigMessage: 'Invalid ContextManager configuration',
    });
  }

  /**
   * 主入口：构建智能上下文 - Provider编排模式
   */
  async buildContext(
    messages: AiMessage[], 
    totalBudget: number,
    callbacks?: SummarizationCallbacks,
    generate?: (request: GenerateRequest) => Promise<GenerateResponse>
  ): Promise<ContextBuildResult> {
    // 计算摘要触发相关信息
    const summarizationThreshold = this.config.SUMMARIZATION_TRIGGER_THRESHOLD;
    const summarizationTokenThreshold = Math.floor(totalBudget * summarizationThreshold);
    
    this.debug('🎯 [Chat上下文管理器] 开始上下文构建', { 
      原始消息数: messages.length, 
      总预算: totalBudget,
      摘要触发阈值: `${(summarizationThreshold * 100).toFixed(0)}%`,
      摘要Token阈值: summarizationTokenThreshold
    });

    const startTime = performance.now();
    const buildStats: ContextBuildStats = this.initializeBuildStats(startTime, messages.length);

    try {
      // 🔥 核心流程：编排各个Provider按优先级处理
      const providerContext: ProviderContext = {
        totalBudget,
        config: this.config,
        debugMode: this.debugMode,
        estimateTokens: message => this.estimateTokens(message),
        summarizationCallbacks: callbacks,
        generate,
      };

      const { finalMessages, finalTokens, strategiesApplied, events } =
        await this.runPipeline({
          messages,
          totalBudget,
          buildStats,
          providerContext,
          getPhaseByProviderName: providerName => this.getPhaseByProviderName(providerName),
        });
      
      const endTime = performance.now();
      buildStats.totalTime = endTime - startTime;
      
      // 计算摘要触发相关信息
      const summarizationThreshold = this.config.SUMMARIZATION_TRIGGER_THRESHOLD;
      const summarizationTokenThreshold = Math.floor(totalBudget * summarizationThreshold);
      
      this.debug('✅ [Chat上下文管理器] 上下文构建完成', {
        原始消息: messages.length,
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
        messages.length, 
        strategiesApplied, 
        buildStats,
        events  // 🔥 传递收集的事件
      );

    } catch (error) {
      this.debug('❌ [Chat上下文管理器] 上下文构建失败', { error });
      throw new Error(`Context building failed with Provider orchestration: ${error}`);
    }
  }

  // ------------------- Provider编排核心方法 -------------------

  /**
   * 根据Provider名称获取对应的阶段名称
   */
  private getPhaseByProviderName(providerName: string): BuildPhase | null {
    const phaseMap: Record<string, BuildPhase> = {
      'CoreContextProvider': BuildPhase.CORE_CONTEXT,
      'WorkingMemoryProvider': BuildPhase.WORKING_MEMORY,
      'SummarizationProvider': BuildPhase.SUMMARIZATION
    };
    return phaseMap[providerName] || null;
  }

  // ------------------- Provider编排辅助方法 -------------------

  private initializeBuildStats(startTime: number, originalMessageCount: number): ContextBuildStats {
    return {
      startTime,
      phaseTiming: {} as Record<BuildPhase, number>,
      phaseTokenUsage: {} as Record<BuildPhase, { used: number; percentage: number }>,
      messageStats: {
        original: originalMessageCount,
        afterCoreContext: 0,
        afterWorkingMemory: 0,
        afterSummarization: 0
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
    buildStats: ContextBuildStats,
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
  private generateRecommendations(stats: ContextBuildStats, totalBudget: number): string[] {
    return generateContextRecommendations(stats, {
      totalBudget,
      processingTimeoutMs: this.config.PROCESSING_TIMEOUT_MS,
      largeSummarizationWarningThreshold:
        this.config.LARGE_SUMMARIZATION_WARNING_THRESHOLD,
    });
  }
  /**
   * 获取Provider注册表（用于测试或调试）
   */
  getProviderRegistry(): ContextProviderRegistry {
    return this.providerRegistry;
  }

  /**
   * 注册新的Provider
   */
  registerProvider(provider: IContextProvider): void {
    this.providerRegistry.register(provider);
  }
}
