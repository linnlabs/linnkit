import type {
  AiMessage,
  ContextBuildTokenEstimate,
  ContextTokenComponent,
  RuntimeEvent,
} from '../../contracts';
import type { ContextTrace } from './context-trace';

export interface RecommendationStats {
  phaseTokenUsage: Record<PropertyKey, { used: number; percentage: number }>;
  summarizationTriggered: boolean;
  summarizedCount?: number;
  documentTruncated: boolean;
  totalTime: number;
}

export interface BuildContextResultOptions<TBuildStats> {
  finalMessages: AiMessage[];
  finalTokens: number;
  totalBudget: number;
  originalCount: number;
  strategiesApplied: string[];
  buildStats: TBuildStats;
  enableBuildStats: boolean;
  estimateTokens: (message: AiMessage) => number;
  coreTypes: readonly string[];
  recommendations: string[];
  events?: RuntimeEvent[];
  contextTrace?: ContextTrace;
  tokenEstimate?: ContextBuildTokenEstimate;
  tokenComponents?: ContextTokenComponent[];
}

export function buildContextResult<TBuildStats>(
  options: BuildContextResultOptions<TBuildStats>,
) {
  const {
    finalMessages,
    finalTokens,
    totalBudget,
    originalCount,
    strategiesApplied,
    buildStats,
    enableBuildStats,
    estimateTokens,
    coreTypes,
    recommendations,
    events = [],
    contextTrace,
    tokenEstimate,
    tokenComponents,
  } = options;

  const tokenDistribution = calculateTokenDistribution(
    finalMessages,
    estimateTokens,
    coreTypes,
  );

  const processingStats = {
    originalCount,
    keptCount: finalMessages.length,
    truncatedCount: originalCount - finalMessages.length,
    tokenDistribution,
    strategiesApplied,
    recommendations,
    buildStats: enableBuildStats ? buildStats : undefined,
  };

  return {
    messages: finalMessages,
    tokenUsage: { used: finalTokens, remaining: totalBudget - finalTokens },
    processingStats,
    truncated: originalCount !== finalMessages.length,
    truncatedCount:
      originalCount > finalMessages.length
        ? originalCount - finalMessages.length
        : undefined,
    strategies: {
      applied: strategiesApplied,
      recommendations,
    },
    events,
    ...(contextTrace ? { contextTrace } : {}),
    ...(tokenEstimate ? { tokenEstimate } : {}),
    ...(tokenComponents ? { tokenComponents } : {}),
  };
}

export function generateContextRecommendations(
  stats: RecommendationStats,
  options: {
    totalBudget: number;
    processingTimeoutMs: number;
    largeSummarizationWarningThreshold?: number;
  },
): string[] {
  const recommendations: string[] = [];
  const usagePercentage =
    Object.values(stats.phaseTokenUsage).reduce(
      (sum, phase) => sum + phase.used,
      0,
    ) / options.totalBudget;

  if (usagePercentage > 0.9) {
    recommendations.push('预算使用率较高，建议增加Token预算或减少输入长度');
  }

  if (stats.documentTruncated) {
    recommendations.push('文档片段被截断，建议分批处理或增加文档片段预算');
  }

  const summaryWarningThreshold =
    options.largeSummarizationWarningThreshold ?? 10;
  if (
    stats.summarizationTriggered &&
    (stats.summarizedCount || 0) > summaryWarningThreshold
  ) {
    recommendations.push('大量历史消息被摘要，建议定期清理对话历史');
  }

  if (stats.totalTime > options.processingTimeoutMs) {
    recommendations.push('上下文构建耗时较长，建议优化消息预处理流程');
  }

  return recommendations;
}

function calculateTokenDistribution(
  finalMessages: AiMessage[],
  estimateTokens: (message: AiMessage) => number,
  coreTypes: readonly string[],
): Record<string, number> {
  const tokenDistribution: Record<string, number> = {
    core_context: 0,
    working_memory: 0,
    summarization: 0,
  };
  const lastUserIndex = finalMessages
    .map(message => message.type)
    .lastIndexOf('user_input');

  finalMessages.forEach((message, index) => {
    const token = estimateTokens(message);
    if (message.metadata?.messageType === 'summary') {
      tokenDistribution.summarization += token;
    } else if (
      coreTypes.includes(message.type) ||
      (message.type === 'user_input' && index === lastUserIndex)
    ) {
      tokenDistribution.core_context += token;
    } else {
      tokenDistribution.working_memory += token;
    }
  });

  return tokenDistribution;
}
