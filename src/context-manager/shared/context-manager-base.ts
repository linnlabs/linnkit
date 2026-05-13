import { Logger } from '../../shared/logger';
import type { ContextProviderRegistry } from './providers/registry';
import type { ProviderContext } from './providers/base';
import { createDefaultTokenizerPort } from '../../shared/defaultTokenizerPort';
import {
  runContextPipeline,
  type ContextPipelineStats,
  type RunContextPipelineResult,
} from './context-pipeline';
import type { AiMessage } from '../../contracts';
import type { LlmRequestMessage, TokenizerPort } from '../../ports';
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
  tokenizer?: TokenizerPort;
  tokenizerModelId?: string;
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
  protected tokenizer: TokenizerPort;
  protected tokenizerModelId?: string;
  private readonly validateConfigFn: (config: TConfig) => boolean;
  private readonly invalidConfigMessage: string;
  private readonly hasCustomTokenizer: boolean;

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
    this.hasCustomTokenizer = options.tokenizer !== undefined;
    this.tokenizer = options.tokenizer ?? this.createDefaultTokenizer();
    this.tokenizerModelId = options.tokenizerModelId;

    if (!this.validateConfigFn(this.config)) {
      throw new Error(this.invalidConfigMessage);
    }
  }

  private createDefaultTokenizer(): TokenizerPort {
    return createDefaultTokenizerPort({
      encoding: this.config.TOKEN_ENCODING_NAME,
      avgCharsPerToken: this.config.AVG_CHARS_PER_TOKEN,
      toolCallOverhead: this.config.TOOL_CALL_OVERHEAD_TOKENS,
    });
  }

  protected estimateTokens(message: AiMessage): number {
    return this.tokenizer.estimateMessage(message as LlmRequestMessage, this.tokenizerModelId);
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
    if (!this.hasCustomTokenizer) {
      this.tokenizer = this.createDefaultTokenizer();
    }
  }

  /**
   * 更新传给 TokenizerPort 的模型 ID。
   *
   * 中文备注：同一个 context manager 被复用到不同模型时，host 必须同步更新这里；
   * AgentMessageOrchestrator 会按 request 自动处理，直接使用 ContextManager 的高级接入方才需要手动调用。
   */
  updateTokenizerModelId(modelId: string | undefined): void {
    this.tokenizerModelId = modelId;
  }
}
