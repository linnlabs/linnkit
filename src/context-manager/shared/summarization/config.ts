import type { ProviderContext } from '../providers/base';

export interface SummarizationConfig {
  SUMMARIZATION_TRIGGER_THRESHOLD: number;
  SUMMARY_OLDEST_MESSAGES_PERCENTAGE: number;
  DEFAULT_MODEL_ID: string;
}

export type SummarizationProviderContext = ProviderContext<SummarizationConfig>;
