/**
 * @file AISummaryGenerator.ts
 * @description AI摘要生成器 - 负责与AI模型交互生成摘要
 */

import type { MessageProcessingState } from '../providers/base';
import type {
  SummaryGenerationRequest,
  SummaryGenerationResponse,
} from '../contracts/summaryGeneration';
import type { AiMessage } from '../../../contracts';
import type { CanonicalLlmUsage } from '../../../contracts';
import type { SummarizationProviderContext } from './config';

export interface SummaryGenerationResult {
  summary: string;
  modelId: string;
  canonicalUsage?: CanonicalLlmUsage;
}

export interface SummarizationOptions {
  /**
   * 执行摘要的已注册 agent/chat ID。
   *
   * 中文备注：linnkit 不持有 prompt 正文，也不直接决定模型调用；这里只携带注册引用，
   * 真正的 prompt 构建与模型策略由 host 的注册表解释。
  */
  agentId: string;
  modelId: string | null;
  failureBehavior?: 'fail-fast' | 'continue-if-within-budget';
  /** 内部调参与测试注入，默认保持生产重试行为。 */
  maxRetries?: number;
  /** 内部调参与测试注入，默认 1000ms。 */
  retryDelayMs?: number;
}

export class AISummaryGenerator {
  private readonly defaultOptions: SummarizationOptions;
  private readonly MAX_RETRIES: number;
  private readonly RETRY_DELAY_MS: number;

  constructor(options: SummarizationOptions) {
    this.defaultOptions = options;
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
  ): Promise<SummaryGenerationResult> {
    const generateSummary = context.generateSummary;
    if (!generateSummary) {
      throw new Error(
        '[AISummaryGenerator] ProviderContext.generateSummary is required. ' +
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
    }, context);

    const primaryResult = await this.tryGenerateSummaryWithRetries(
      generateSummary,
      conversationText,
      this.defaultOptions.modelId,
      this.MAX_RETRIES,
      context,
      debugFn
    );

    if (primaryResult.success) {
      return primaryResult.result;
    }

    debugFn('❌ 摘要模型重试后仍失败，摘要化终止', {
      primaryModel: this.defaultOptions.modelId,
      primaryError: primaryResult.error,
    }, context);

    throw new Error(`摘要生成失败。同一模型(${this.defaultOptions.modelId})重试后仍失败: ${primaryResult.error}`);
  }

  private async tryGenerateSummaryWithRetries(
    generateSummary: (
      request: SummaryGenerationRequest,
    ) => Promise<SummaryGenerationResponse>,
    conversationText: string,
    modelId: string,
    maxRetries: number,
    context: SummarizationProviderContext,
    debugFn: (
      message: string,
      data: Record<string, unknown>,
      context: SummarizationProviderContext,
    ) => void,
  ): Promise<{ success: true; result: SummaryGenerationResult } | { success: false; error: string }> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        debugFn(`🔄 尝试生成摘要 (模型: ${modelId}, 第${attempt}/${maxRetries}次)`, {
          modelId,
          attempt,
          maxRetries,
        }, context);

        const summaryRequest: SummaryGenerationRequest = {
          agentId: this.defaultOptions.agentId,
          modelId,
          content: conversationText,
        };

        const response = await generateSummary(summaryRequest);
        const summary = response.summary;

        if (!summary.trim()) {
          throw new Error('AI返回了空的摘要内容');
        }

        debugFn('✅ 摘要生成成功', {
          modelId,
          attempt,
          summaryLength: summary.length,
          hasCanonicalUsage: response.canonicalUsage !== undefined,
        }, context);

        return {
          success: true,
          result: {
            summary: summary.trim(),
            modelId,
            ...(response.canonicalUsage ? { canonicalUsage: response.canonicalUsage } : {}),
          },
        };
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
