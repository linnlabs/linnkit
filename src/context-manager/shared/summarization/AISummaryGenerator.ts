/**
 * @file AISummaryGenerator.ts
 * @description AI摘要生成器 - 负责与AI模型交互生成摘要
 */

import type { MessageProcessingState } from '../providers/base';
import type {
  GenerateRequest,
  GenerateResponse,
} from '../contracts/chatLineMessage';
import type { AiMessage } from '../../../contracts';
import type { SummarizationProviderContext } from './config';

export interface SummarizationOptions {
  maxSummaryTokens: number;
  targetCompressionRatio?: number;
  /**
   * 执行摘要的已注册 agent/chat ID。
   *
   * 中文备注：linnkit 不持有 prompt 正文，也不直接决定模型调用；这里只携带注册引用，
   * 真正的 prompt 构建与模型策略由 host 的注册表解释。
   */
  agentId: string;
  modelId: string | null;
  fallbackModelId?: string | null;
  language: 'zh' | 'en' | 'auto';
  failureBehavior?: 'fail-fast' | 'continue-if-within-budget';
  /** 内部调参与测试注入，默认保持生产重试行为。 */
  maxRetries?: number;
  /** 内部调参与测试注入，默认 1000ms。 */
  retryDelayMs?: number;
}

export class AISummaryGenerator {
  private readonly defaultOptions: SummarizationOptions;
  private readonly fallbackModelId: string | null;
  private readonly MAX_RETRIES: number;
  private readonly RETRY_DELAY_MS: number;

  constructor(options: SummarizationOptions) {
    this.defaultOptions = options;
    this.fallbackModelId = options.fallbackModelId ?? null;
    this.MAX_RETRIES = normalizePositiveInteger(options.maxRetries, 3);
    this.RETRY_DELAY_MS = normalizeNonNegativeInteger(options.retryDelayMs, 1000);
  }

  async generateHistorySummary(
    candidates: MessageProcessingState[],
    context: SummarizationProviderContext,
    debugFn: (
      message: string,
      data: Record<string, unknown>,
      context: SummarizationProviderContext,
    ) => void,
  ): Promise<string> {
    const effectiveGenerate = context.generate;
    if (!effectiveGenerate) {
      throw new Error(
        '[AISummaryGenerator] ProviderContext.generate is required. ' +
        'Inject summarization generation from host or profile orchestration.'
      );
    }

    if (!this.defaultOptions.modelId) {
      throw new Error(
        '[AISummaryGenerator] No summarization model configured. ' +
        'Inject model selection from product/provider assembly.'
      );
    }

    const conversationText = this.formatMessagesForSummary(candidates.map((c) => c.message));

    debugFn('开始AI摘要生成', {
      messageCount: candidates.length,
      textLength: conversationText.length,
      primaryModel: this.defaultOptions.modelId,
      fallbackModel: this.fallbackModelId,
    }, context);

    const primaryResult = await this.tryGenerateSummaryWithRetries(
      effectiveGenerate,
      conversationText,
      this.defaultOptions.modelId,
      this.MAX_RETRIES,
      context,
      debugFn
    );

    if (primaryResult.success) {
      return primaryResult.summary!;
    }

    if (!this.fallbackModelId) {
      throw new Error(`摘要生成失败（无可用降级模型）。主模型(${this.defaultOptions.modelId})错误: ${primaryResult.error}`);
    }

    debugFn('⚠️ 主模型摘要失败，尝试降级到备用模型', {
      primaryModel: this.defaultOptions.modelId,
      fallbackModel: this.fallbackModelId,
      primaryError: primaryResult.error,
    }, context);

    const fallbackResult = await this.tryGenerateSummaryWithRetries(
      effectiveGenerate,
      conversationText,
      this.fallbackModelId,
      this.MAX_RETRIES,
      context,
      debugFn
    );

    if (fallbackResult.success) {
      return fallbackResult.summary!;
    }

    debugFn('❌ 主模型和备用模型均失败，摘要化终止', {
      primaryModel: this.defaultOptions.modelId,
      fallbackModel: this.fallbackModelId,
      primaryError: primaryResult.error,
      fallbackError: fallbackResult.error,
    }, context);

    throw new Error(
      `摘要生成完全失败。主模型(${this.defaultOptions.modelId})错误: ${primaryResult.error}; ` +
      `备用模型(${this.fallbackModelId})错误: ${fallbackResult.error}`
    );
  }

  private async tryGenerateSummaryWithRetries(
    generate: (request: GenerateRequest) => Promise<GenerateResponse>,
    conversationText: string,
    modelId: string,
    maxRetries: number,
    context: SummarizationProviderContext,
    debugFn: (
      message: string,
      data: Record<string, unknown>,
      context: SummarizationProviderContext,
    ) => void,
  ): Promise<{ success: true; summary: string } | { success: false; error: string }> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        debugFn(`🔄 尝试生成摘要 (模型: ${modelId}, 第${attempt}/${maxRetries}次)`, {
          modelId,
          attempt,
          maxRetries,
        }, context);

        const summaryRequest: GenerateRequest = {
          promptKey: this.defaultOptions.agentId,
          modelId,
          prompt: conversationText,
        };

        const response = await generate(summaryRequest);
        const summary = response.generatedText;

        if (!summary.trim()) {
          throw new Error('AI返回了空的摘要内容');
        }

        debugFn('✅ 摘要生成成功', {
          modelId,
          attempt,
          summaryLength: summary.length,
        }, context);

        return { success: true, summary: summary.trim() };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        debugFn(`❌ 摘要生成失败 (模型: ${modelId}, 第${attempt}/${maxRetries}次)`, {
          modelId,
          attempt,
          error: lastError.message,
        }, context);

        if (attempt < maxRetries) {
          await this.sleep(attempt * this.RETRY_DELAY_MS);
        }
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Unknown error',
    };
  }

  private formatMessagesForSummary(messages: AiMessage[]): string {
    return messages
      .map((message) => `${message.role}: ${message.content}`)
      .join('\n\n');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}
