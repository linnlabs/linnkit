import type { ProviderContext } from '../providers/base';

export interface SummarizationConfig {
  SUMMARIZATION_TRIGGER_THRESHOLD: number;
  SUMMARY_OLDEST_MESSAGES_PERCENTAGE: number;
  TOKEN_ENCODING_NAME: string;
}

export interface SummarizationProtectedRange {
  readonly startIndex: number;
  readonly endIndex: number;
}

export type SummarizationProviderContext = ProviderContext<SummarizationConfig> & {
  /** 摘要不得进入或跨越的原始消息区段。 */
  readonly summarizationProtectedRanges?: readonly SummarizationProtectedRange[];
};
