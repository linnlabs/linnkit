import type { ProviderContext } from '../providers/base';

export interface SummarizationConfig {
  SUMMARIZATION_TRIGGER_THRESHOLD: number;
  SUMMARY_OLDEST_MESSAGES_PERCENTAGE: number;
  TOKEN_ENCODING_NAME: string;
}

export type SummarizationProviderContext = ProviderContext<SummarizationConfig>;
