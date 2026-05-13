import type { ChatMessage, GenerateRequest, GenerateResponse } from '../contracts';
import { chatMessageToAiMessage } from '../utils/messageAdapters';
import { ContextManager, ContextBuildResult } from '../context';
import { CONTEXT_BUILDER_CONFIG } from '../context/config';
import type { ContextBuilderConfig } from '../context/config';
import type { SummarizationCallbacks } from '../context/providers/base';
import type { ContextProviderRegistry } from '../context/providers';
import { 
  PreprocessorPipeline, 
  createDefaultPreprocessorPipeline,
  PreprocessorPipelineResult 
} from '../preprocessors';
import { messageFormatter } from '../../../shared/MessageFormatter';
import type { AgentProfileRequest } from '../../agent/contracts';
import type { ChatTaskResolver } from '../tasks/base';
import { generateMessageId } from '../../../../shared/ids';
import { buildGenerateRequestFromAgentRequest } from '../request-adapters';
import type { AiMessage } from '../../../../contracts';
import type { TokenizerPort } from '../../../../ports';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readOptionalStringProperty(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value[key];
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate : undefined;
}

/**
 * 编排器配置选项
 */
export interface OrchestratorOptions {
  /** Token预算配置 (现在由ContextManager内部管理，但保留API以兼容旧用法) */
  tokenBudget: {
    maxTokens: number;
    reservedForResponse: number;
  };
  
  /** 处理选项 */
  processing: {
    enableMerge?: boolean;
    enableBatch?: boolean;
    debugMode?: boolean;
    preserveMetadata?: boolean;
  };
  
  /** 系统提示词 */
  systemPrompt?: string;
  
  /** 模型名称 (用于精确Token计算) */
  model?: string;

  /** 任务解析器 */
  taskResolver: ChatTaskResolver;
  providerRegistry: ContextProviderRegistry;
  tokenizer?: TokenizerPort;
}

/**
 * 处理结果接口
 */
export interface ProcessingResult {
  /** 处理后的消息 (AI引擎格式) */
  messages: ChatMessage[];
  
  /** 完整的上下文构建结果，包含详细统计信息 */
  contextBuildResult: ContextBuildResult;
  
  /** 处理元信息 */
  metadata: {
    originalCount: number;
    processedCount: number;
    tokenUsage: {
      estimated: number;
      budget: number;
      remaining: number;
    };
    processingStats: ContextBuildResult['processingStats'];
    truncated: boolean;
    truncatedCount?: number;
  };
}

/**
 * 消息处理编排器
 * 
 * 实现完整的处理流程：解析 → 分发 → 上下文构建 → 注入系统提示词 → 转换
 */
export class MessageOrchestrator {
  private contextManager: ContextManager;
  private preprocessorPipeline: PreprocessorPipeline;
  private options: OrchestratorOptions;
  private readonly taskResolver: ChatTaskResolver;

  constructor(options: OrchestratorOptions) {
    this.options = options;
    this.taskResolver = options.taskResolver;
    
    // 初始化预处理管道
    this.preprocessorPipeline = createDefaultPreprocessorPipeline({
      debugMode: options.processing.debugMode
    });
    
    // 初始化新的上下文管理器
    this.contextManager = new ContextManager({
      debugMode: options.processing.debugMode,
      // 允许通过 OrchestratorOptions 覆盖默认配置
      customConfig: CONTEXT_BUILDER_CONFIG,
      providerRegistry: options.providerRegistry,
      tokenizer: options.tokenizer,
      tokenizerModelId: options.model,
    });
  }

  /**
   * 🔥 新增：与 AgentOrchestrator 对称的主方法
   * 负责从 AgentProfileRequest 构建完整的初始消息列表，然后进行处理
   */
  async processChatConversation(
    request: AgentProfileRequest,
    callbacks?: SummarizationCallbacks,
    generate?: (request: GenerateRequest) => Promise<GenerateResponse>
  ): Promise<ProcessingResult> {
    console.log('[Chat-Orchestrator] 🚀 开始 Chat 对话处理');
    this.contextManager.updateTokenizerModelId(this.resolveTokenizerModelId(request));

    // 🔥 1. [预处理] 首先对原始历史记录进行净化
    const originalHistory = request.conversationHistory || [];
    const preprocessResult = await this.runPreprocessorPipeline(originalHistory);
    console.log(`[Chat-Orchestrator] 🧹 历史净化完成: ${originalHistory.length} -> ${preprocessResult.messages.length} 条`);

    // 2. 将 AgentProfileRequest 转换为 GenerateRequest 格式，并注入净化后的历史
    const generateRequest = buildGenerateRequestFromAgentRequest(
      request,
      preprocessResult.messages,
    );

    this.debug(`Converting AgentProfileRequest to GenerateRequest`, {
      promptKey: request.promptKey,
      originalHistoryCount: originalHistory.length,
      purifiedHistoryCount: preprocessResult.messages.length,
    });

    // 3. 获取任务并调用其 buildMessages 方法
    const task = this.taskResolver(request.promptKey);
    const initialChatMessages = task.buildMessages(generateRequest);
    
    this.debug(`Task built ${initialChatMessages.length} initial messages using purified history`, {
      promptKey: request.promptKey,
      taskType: task.constructor.name,
    });

    // 4. 将 ChatMessage[] 转换为 AiMessage[] 以供后续处理
    const initialAiMessages: AiMessage[] = initialChatMessages.map((chatMsg, index) => 
      chatMessageToAiMessage(chatMsg, { 
        id: chatMsg.id || generateMessageId(), 
        timestamp: chatMsg.timestamp || (Date.now() - (initialChatMessages.length - index))
      })
    );
    
    // 5. [上下文构建] - 调用ContextManager (不再需要内部预处理)
    const finalResult = await this.buildAndFinalizeContext(initialAiMessages, callbacks, generate);

    this.debug('✅ Chat 对话处理完成', {
      hasCallbacks: !!callbacks,
      onSummarizationStart: !!callbacks?.onSummarizationStart,
      onSummarizationEnd: !!callbacks?.onSummarizationEnd,
    });

    console.log('[Chat-Orchestrator] ✅ Chat 对话处理完成');
    return finalResult;
  }

  /**
   * 核心编排方法 - 处理一个预构建好的对话历史
   */
  async processConversation(
    messages: AiMessage[],
    callbacks?: SummarizationCallbacks,
    generate?: (request: GenerateRequest) => Promise<GenerateResponse>
  ): Promise<ProcessingResult> {
    this.debug('Starting conversation processing', { messageCount: messages.length });
    
    const startTime = performance.now();
    
    try {
      // 1. [解析验证] - 确保消息结构和内容的基本有效性
      const validMessages = this.parseAndValidateMessages(messages);
      this.debug('Parsed and validated messages', { validCount: validMessages.length });
      
      // 🔥 注意: 此方法现在主要由内部调用，预处理已在 processChatConversation 中完成
      // 因此，我们直接进入上下文构建
      
      // 3. [上下文构建] - 调用ContextManager在Token预算内构建最优消息组合
      const contextResult = await this.buildContext(validMessages, callbacks, generate);
      this.debug('Context built', { afterContextCount: contextResult.messages.length });
      
      if (this.options.processing.debugMode) {
        console.log('[MessageOrchestrator] DEBUG: Messages after context build:', JSON.stringify(
          contextResult.messages.map(m => ({ id: m.id, ts: m.timestamp, role: m.role, type: m.type, content: m.content.substring(0, 50) })),
          null,
          2
        ));
      }
      
      // 4. [最终格式化] - 将内部AiMessage格式转换为外部API的ChatMessage格式
      const chatMessages = this.convertToChatMessages(contextResult.messages);
      
      const endTime = performance.now();
      const processingTime = endTime - startTime;
      
      if (this.options.processing.debugMode) {
        console.log('[MessageOrchestrator] DEBUG: Final ChatMessages for AI Engine:', JSON.stringify(
          chatMessages.map(m => ({ id: m.id, ts: m.timestamp, role: m.role, type: m.type, content: m.content.substring(0, 50) })),
          null,
          2
        ));
      }
      
      this.debug('Processing completed', { 
        processingTime: `${processingTime.toFixed(2)}ms`,
        finalMessageCount: chatMessages.length
      });
      
      // 构建处理结果
      return {
        messages: chatMessages,
        contextBuildResult: contextResult,
        metadata: {
          originalCount: messages.length,
          processedCount: chatMessages.length,
          tokenUsage: {
            estimated: contextResult.tokenUsage.used,
            budget: this.options.tokenBudget.maxTokens,
            remaining: contextResult.tokenUsage.remaining
          },
          processingStats: contextResult.processingStats,
          truncated: contextResult.truncated,
          truncatedCount: contextResult.truncatedCount
        }
      };
      
    } catch (error) {
      this.debug('Processing failed', { error });
      throw new Error(`Message processing failed: ${error}`);
    }
  }

  /**
   * 封装了 buildContext 和 convertToChatMessages 的逻辑
   */
  private async buildAndFinalizeContext(
    messages: AiMessage[],
    callbacks?: SummarizationCallbacks,
    generate?: (request: GenerateRequest) => Promise<GenerateResponse>
  ): Promise<ProcessingResult> {
    const contextResult = await this.buildContext(messages, callbacks, generate);
    const chatMessages = this.convertToChatMessages(contextResult.messages);

    return {
      messages: chatMessages,
      contextBuildResult: contextResult,
      metadata: {
        originalCount: messages.length, // 注意：这里的 originalCount 是净化后的数量
        processedCount: chatMessages.length,
        tokenUsage: {
          estimated: contextResult.tokenUsage.used,
          budget: this.options.tokenBudget.maxTokens,
          remaining: contextResult.tokenUsage.remaining
        },
        processingStats: contextResult.processingStats,
        truncated: contextResult.truncated,
        truncatedCount: contextResult.truncatedCount
      }
    };
  }
  
  /**
   * 1. 解析和验证消息 - 直接使用原始消息，不进行格式转换
   */
  private parseAndValidateMessages(messages: AiMessage[]): AiMessage[] {
    this.debug('开始解析和验证消息', { originalCount: messages.length });
    
    // 直接验证原始消息，不使用historyFormatter
    const validMessages = messages.filter(message => {
      // 结构验证
      if (!message.id || !message.role || !message.type || typeof message.content !== 'string') {
        this.debug('消息结构无效', { id: message.id, type: message.type });
        return false;
      }
      
      // 内容验证
      if (!message.content.trim()) {
        this.debug('消息内容为空', { id: message.id });
        return false;
      }
      
      return true;
    });
    
    this.debug('消息解析完成', {
      原始消息数: messages.length,
      验证通过: validMessages.length,
      被过滤: messages.length - validMessages.length
    });
    
    return validMessages;
  }

  /**
   * 🔥 2. [预处理管道] - 运行所有注册的预处理器
   */
  private async runPreprocessorPipeline(messages: AiMessage[]): Promise<PreprocessorPipelineResult> {
    return await this.preprocessorPipeline.process(messages);
  }

  private resolveTokenizerModelId(request?: AgentProfileRequest): string | undefined {
    return readOptionalStringProperty(request, 'model_id')
      ?? readOptionalStringProperty(request, 'modelId')
      ?? this.options.model;
  }

  /**
   * 3. [上下文构建] - 调用ContextManager进行智能Token预算和消息构建
   */
  private async buildContext(
    messages: AiMessage[],
    callbacks?: SummarizationCallbacks,
    generate?: (request: GenerateRequest) => Promise<GenerateResponse>
  ): Promise<ContextBuildResult> {
    const totalBudget = this.options.tokenBudget.maxTokens - this.options.tokenBudget.reservedForResponse;
    
    // 委托给专门的上下文管理器处理
    const contextResult = await this.contextManager.buildContext(
      messages,
      totalBudget,
      callbacks,
      generate
    );
    
    if (this.options.processing.debugMode) {
      this.debug('Context build result', {
        original: contextResult.processingStats.originalCount,
        kept: contextResult.processingStats.keptCount,
        truncated: contextResult.processingStats.truncatedCount,
        strategies: contextResult.strategies.applied,
        tokenUsage: contextResult.tokenUsage,
        recommendations: contextResult.strategies.recommendations,
        buildStats: contextResult.processingStats.buildStats
      });
    }
    
    return contextResult;
  }

  /**
   * 4. [最终格式化] - 将内部AiMessage格式转换为外部API的ChatMessage格式
   */
  private convertToChatMessages(messages: AiMessage[]): ChatMessage[] {
    // 关键修复：使用专用的 MessageFormatter 来确保格式正确且无冗余数据
    // 🔥 Chat模式：不使用native tools，使用chat模式
    return messageFormatter.format(messages, { nativeTools: false, mode: 'chat' });
  }

  /**
   * 调试日志
   */
  private debug(message: string, data?: Record<string, unknown>): void {
    if (this.options.processing.debugMode) {
      console.log(`[MessageOrchestrator] ${message}`, data);
    }
  }

  /**
   * 更新配置
   */
  updateOptions(newOptions: Partial<OrchestratorOptions>): void {
    this.options = {
      ...this.options,
      ...newOptions,
      tokenBudget: { ...this.options.tokenBudget, ...newOptions.tokenBudget },
      processing: { ...this.options.processing, ...newOptions.processing }
    };
    
    // 同步更新上下文管理器配置
    if (newOptions.processing?.debugMode !== undefined) {
      // 这是一个示例，实际中可能需要更复杂的配置更新逻辑
    }
    this.contextManager.updateTokenizerModelId(this.options.model);
  }

  /**
   * 获取预算管理器 (用于高级配置) - 已更新为上下文管理器
   */
  getContextManager(): ContextManager {
    return this.contextManager;
  }

  /**
   * 获取预算管理状态 - 已更新为上下文管理状态
   */
  getContextInfo(): {
    config: ContextBuilderConfig;
  } {
    return {
      config: this.contextManager.getConfig()
    };
  }
}

/**
 * 🔥 工厂函数：创建默认配置的 MessageOrchestrator
 */
