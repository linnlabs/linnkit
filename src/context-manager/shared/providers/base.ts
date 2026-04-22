import type {
  GenerateRequest,
  GenerateResponse,
} from '../../profiles/chat/contracts';
import type { AiMessage, RuntimeEvent } from '../../../contracts';

export interface MessageProcessingState {
  message: AiMessage;
  originalIndex: number;
  action: 'keep_core' | 'keep_working_memory' | 'summarize' | 'skip';
  tokens: number;
  processedContent?: string;
  contentType?: 'full' | 'final_answer_only' | 'thinking_only';
  phase?: string;
  replacementSourceIds?: string[];
}

export interface SummarizationCallbacks {
  onSummarizationStart?: () => void;
  onSummarizationEnd?: (info: {
    originalMessageCount: number;
    summaryTokenCount?: number;
    newSummaryId?: string;
    summaryEvent?: RuntimeEvent;
  }) => void;
  onSummarizationError?: (error: Error) => void;
}

export interface ProviderContext<TConfig = unknown> {
  totalBudget: number;
  config: TConfig;
  debugMode: boolean;
  estimateTokens: (message: AiMessage) => number;
  summarizationCallbacks?: SummarizationCallbacks;
  generate?: (request: GenerateRequest) => Promise<GenerateResponse>;
}

export interface ProviderResult {
  states: MessageProcessingState[];
  tokensUsed: number;
  strategiesApplied: string[];
  stats: {
    processedCount: number;
    skippedCount: number;
    addedCount: number;
  };
  events?: RuntimeEvent[];
}

export interface IContextProvider<TConfig = unknown> {
  readonly name: string;
  readonly description: string;
  readonly priority: number;

  provide(
    states: MessageProcessingState[],
    availableBudget: number,
    context: ProviderContext<TConfig>,
  ): Promise<ProviderResult>;

  shouldSkip?(
    states: MessageProcessingState[],
    availableBudget: number,
    context: ProviderContext<TConfig>,
  ): boolean;
}

export abstract class BaseContextProvider<TConfig = unknown>
  implements IContextProvider<TConfig>
{
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly priority: number;

  abstract provide(
    states: MessageProcessingState[],
    availableBudget: number,
    context: ProviderContext<TConfig>,
  ): Promise<ProviderResult>;

  shouldSkip(
    _states: MessageProcessingState[],
    availableBudget: number,
    _context: ProviderContext<TConfig>,
  ): boolean {
    return availableBudget <= 0;
  }

  protected debug(
    message: string,
    data?: Record<string, unknown>,
    context?: ProviderContext<TConfig>,
  ): void {
    if (context?.debugMode) {
      console.log(`[${this.name}] ${message}`, data);
    }
  }

  protected createResult(
    states: MessageProcessingState[],
    tokensUsed = 0,
    strategiesApplied: string[] = [],
    stats = { processedCount: 0, skippedCount: 0, addedCount: 0 },
    events: RuntimeEvent[] = [],
  ): ProviderResult {
    return {
      states,
      tokensUsed,
      strategiesApplied,
      stats,
      ...(events.length > 0 && { events }),
    };
  }
}
