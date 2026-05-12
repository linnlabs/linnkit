import { Logger } from '../../shared/logger';
import type { ContextProviderRegistry } from './providers/registry';
import type { ProviderContext } from './providers/base';
import { TokenCalculator } from '../../shared/TokenCalculator';
import {
  runContextPipeline,
  type ContextPipelineStats,
  type RunContextPipelineResult,
} from './context-pipeline';
import type { AiMessage } from '../../contracts';
import type { ContextTraceCollector } from './context-trace';

export interface ContextManagerBaseConfig {
  AVG_CHARS_PER_TOKEN: number;
  TOOL_CALL_OVERHEAD_TOKENS?: number;
  TOKEN_ENCODING_NAME?: string;
}

export interface ContextManagerBaseOptions<TConfig, TRegistry> {
  debugMode?: boolean;
  customConfig?: Partial<TConfig>;
  providerRegistry?: TRegistry;
}

interface ContextManagerBaseInit<TConfig, TRegistry> {
  defaultConfig: TConfig;
  validateConfig: (config: TConfig) => boolean;
  createRegistry: () => TRegistry;
  loggerName: string;
  invalidConfigMessage: string;
}

export abstract class ContextManagerBase<
  TConfig extends ContextManagerBaseConfig,
  TRegistry extends ContextProviderRegistry<TConfig>,
> {
  protected config: TConfig;
  protected debugMode: boolean;
  protected providerRegistry: TRegistry;
  protected logger: Logger;
  private readonly validateConfigFn: (config: TConfig) => boolean;
  private readonly invalidConfigMessage: string;

  protected constructor(
    options: ContextManagerBaseOptions<TConfig, TRegistry>,
    init: ContextManagerBaseInit<TConfig, TRegistry>,
  ) {
    this.debugMode = options.debugMode ?? false;
    this.config = options.customConfig
      ? { ...init.defaultConfig, ...options.customConfig }
      : init.defaultConfig;
    this.providerRegistry = options.providerRegistry ?? init.createRegistry();
    this.logger = new Logger(init.loggerName);
    this.validateConfigFn = init.validateConfig;
    this.invalidConfigMessage = init.invalidConfigMessage;

    if (!this.validateConfigFn(this.config)) {
      throw new Error(this.invalidConfigMessage);
    }
  }

  protected estimateTokens(message: AiMessage): number {
    return TokenCalculator.estimateMessageTokens(message, {
      encoding: this.config.TOKEN_ENCODING_NAME,
      avgCharsPerToken: this.config.AVG_CHARS_PER_TOKEN,
      toolCallOverhead: this.config.TOOL_CALL_OVERHEAD_TOKENS,
    });
  }

  protected debug(message: string, data?: Record<string, unknown>): void {
    if (this.debugMode) {
      this.logger.debug(message, data);
    }
  }

  protected runPipeline<
    TContext extends ProviderContext<TConfig>,
    TPhase extends PropertyKey,
    TStats extends ContextPipelineStats<TPhase>,
  >(options: {
    messages: AiMessage[];
    totalBudget: number;
    buildStats: TStats;
    providerContext: TContext;
    getPhaseByProviderName: (providerName: string) => TPhase | null;
    contextTrace?: ContextTraceCollector;
  }): Promise<RunContextPipelineResult> {
    return runContextPipeline({
      messages: options.messages,
      totalBudget: options.totalBudget,
      buildStats: options.buildStats,
      providerRegistry: this.providerRegistry,
      providerContext: options.providerContext,
      estimateTokens: message => this.estimateTokens(message),
      getPhaseByProviderName: options.getPhaseByProviderName,
      debug: (message, data) => this.debug(message, data),
      contextTrace: options.contextTrace,
    });
  }

  getConfig(): TConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<TConfig>): void {
    this.config = { ...this.config, ...newConfig };
    if (!this.validateConfigFn(this.config)) {
      throw new Error(this.invalidConfigMessage);
    }
  }
}
