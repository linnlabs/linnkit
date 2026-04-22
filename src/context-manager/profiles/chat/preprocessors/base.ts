import type { AiMessage } from '../../../../contracts';

/**
 * 预处理器上下文 - 为管道模式提供的轻量级上下文
 */
export interface PreprocessorContext {
  /** 调试模式开关 */
  debugMode?: boolean;
  /** 可选的元数据传递 */
  metadata?: Record<string, unknown>;
}

/**
 * 预处理结果接口
 */
export interface PreprocessorResult {
  /** 预处理后的消息列表 */
  messages: AiMessage[];
  /** 预处理统计信息 */
  stats: {
    /** 原始消息数量 */
    originalCount: number;
    /** 处理后消息数量 */
    processedCount: number;
    /** 被移除的消息数量 */
    removedCount: number;
    /** 被修改的消息数量 */
    modifiedCount: number;
  };
  /** 应用的策略列表 */
  appliedStrategies: string[];
}

/**
 * 预处理器接口 - 管道模式的核心契约
 */
export interface IPreprocessor {
  /** 预处理器名称 */
  readonly name: string;
  
  /** 预处理器描述 */
  readonly description: string;
  
  /** 执行顺序优先级 (数字越小越先执行) */
  readonly priority: number;

  /**
   * 预处理方法 - 管道模式的核心方法
   * 
   * @param messages 输入的消息列表
   * @param context 预处理上下文
   * @returns 预处理结果
   */
  process(
    messages: AiMessage[], 
    context: PreprocessorContext
  ): Promise<PreprocessorResult>;

  /**
   * 可选：判断是否应该跳过此预处理器
   * 
   * @param messages 输入的消息列表
   * @param context 预处理上下文
   * @returns true表示跳过，false表示执行
   */
  shouldSkip?(messages: AiMessage[], context: PreprocessorContext): boolean;
}

/**
 * 预处理器基类 - 提供通用功能实现
 */
export abstract class BasePreprocessor implements IPreprocessor {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly priority: number;

  abstract process(
    messages: AiMessage[], 
    context: PreprocessorContext
  ): Promise<PreprocessorResult>;

  /**
   * 默认的跳过逻辑 - 子类可以覆盖
   */
  shouldSkip?(messages: AiMessage[], context: PreprocessorContext): boolean {
    return false; // 默认不跳过
  }

  /**
   * 创建预处理结果的辅助方法
   */
  protected createResult(
    originalMessages: AiMessage[],
    processedMessages: AiMessage[],
    appliedStrategies: string[],
    modifiedCount: number = 0
  ): PreprocessorResult {
    const removedCount = originalMessages.length - processedMessages.length;
    
    return {
      messages: processedMessages,
      stats: {
        originalCount: originalMessages.length,
        processedCount: processedMessages.length,
        removedCount,
        modifiedCount
      },
      appliedStrategies
    };
  }

  /**
   * 调试日志辅助方法
   */
  protected debug(message: string, data?: Record<string, unknown>, context?: PreprocessorContext): void {
    if (context?.debugMode) {
      console.log(`[${this.name}] ${message}`, data);
    }
  }
}
