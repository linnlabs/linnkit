/**
 * @file src/chat/context/providers/CoreContextProvider.ts
 * @description 核心上下文保留层Provider - 第一阶段上下文构建
 * 
 * 🎯 职责: 识别并保留必须保留的核心消息
 * 📖 规则: 系统提示词、最新用户输入、文档片段始终无条件保留
 * ✨ 特性: 支持文档片段智能截断，确保核心请求的完整性
 */

import { BaseContextProvider, MessageProcessingState, ProviderContext, ProviderResult } from './base';
import type { AiMessage } from '../../../../../contracts';

/**
 * 核心上下文保留层Provider
 * 
 * 实现README中描述的第一阶段：核心上下文保留层 (Must-Keep)
 * 内容包括：系统提示词、用户意图块(最新用户输入+相关上下文信息)
 */
export class CoreContextProvider extends BaseContextProvider {
  readonly name = 'CoreContextProvider';
  readonly description = '核心上下文保留层 - 识别并保留系统提示词、最新用户输入和文档片段';
  readonly priority = 1; // 最高优先级

  async provide(
    states: MessageProcessingState[], 
    availableBudget: number, 
    context: ProviderContext
  ): Promise<ProviderResult> {
    this.debug('🚀 开始核心上下文保留层处理', {
      totalMessages: states.length,
      availableBudget,
      config: {
        documentFragmentMaxPercentage: context.config.DOCUMENT_FRAGMENT_MAX_PERCENTAGE
      }
    }, context);

    let coreTokens = 0;
    let processedCount = 0;
    const strategiesApplied: string[] = [];
    
    // 获取所有原始消息，用于判断最新用户输入
    const allMessages = states.map(s => s.message);
    
    for (let i = 0; i < states.length; i++) {
      const state = states[i];
      const msg = state.message;
      
      // 检查是否为核心消息
      if (this.isCoreMessage(msg, i, allMessages)) {
        let processedContent = msg.content;
        let contentType: MessageProcessingState['contentType'] = 'full';
        
        // 文档片段截断逻辑 - 极端情况处理
        if (msg.type === 'document_fragment') {
          const originalTokens = context.estimateTokens(msg);
          const maxAllowedTokens = Math.floor(context.totalBudget * context.config.DOCUMENT_FRAGMENT_MAX_PERCENTAGE);
          
          if (originalTokens > maxAllowedTokens) {
            processedContent = this.truncateContent(msg.content, maxAllowedTokens, context.config.AVG_CHARS_PER_TOKEN);
            strategiesApplied.push('document_truncation');
            
            this.debug(`📄 文档片段被截断`, {
              id: msg.id,
              originalTokens,
              maxAllowedTokens,
              truncatedTokens: context.estimateTokens({ ...msg, content: processedContent })
            }, context);
          }
        }
        
        // 标记为核心消息
        state.action = 'keep_core';
        state.processedContent = processedContent;
        state.contentType = contentType;
        state.phase = 'CORE_CONTEXT';
        
        // 重新计算Token数量（基于可能被截断的内容）
        state.tokens = context.estimateTokens({ ...msg, content: processedContent });
        coreTokens += state.tokens;
        processedCount++;
        
        this.debug(`✅ 标记为核心消息`, {
          index: i,
          id: msg.id,
          type: msg.type,
          tokens: state.tokens,
          totalCoreTokens: coreTokens
        }, context);
      } else {
        this.debug(`⏭️ 跳过非核心消息`, { 
          index: i, 
          id: msg.id, 
          type: msg.type 
        }, context);
      }
    }
    
    this.debug('📊 核心上下文保留层处理完成', {
      coreMessages: processedCount,
      coreTokens,
      remainingBudget: availableBudget - coreTokens
    }, context);

    return this.createResult(
      states,
      coreTokens,
      strategiesApplied,
      {
        processedCount,
        skippedCount: states.length - processedCount,
        addedCount: 0
      }
    );
  }

  /**
   * 判断是否为核心消息
   * 🔥 关键设计：只保留真正的核心消息
   */
  private isCoreMessage(msg: AiMessage, index: number, allMessages: AiMessage[]): boolean {
    // 核心消息类型：系统提示词和文档片段始终无条件保留
    if (msg.type === 'system_prompt' || msg.type === 'document_fragment') {
      return true;
    }
    
    // README规则：最新的user_input也算核心消息
    if (msg.type === 'user_input') {
      const lastUserIndex = allMessages.map(m => m.type).lastIndexOf('user_input');
      return index === lastUserIndex;
    }
    
    // 🚨 重要：history_summary 不在此处保留，让其进入后续的处理流程
    // 这是解决"循环累积"问题的关键 - 旧摘要必须能被新摘要替换
    // 参考 AgentCoreContextProvider 的实现
    if (msg.type === 'history_summary') {
      return false;
    }
    
    return false;
  }

  /**
   * 内容截断 - 保持完整词汇
   * 复用ContextManager中的逻辑
   */
  private truncateContent(content: string, maxTokens: number, avgCharsPerToken: number): string {
    const maxChars = maxTokens * avgCharsPerToken;
    if (content.length <= maxChars) {
      return content;
    }

    // 找到最接近的词汇边界
    const truncated = content.substring(0, maxChars);
    const lastSpaceIndex = truncated.lastIndexOf(' ');
    const result = lastSpaceIndex > maxChars * 0.8 
      ? truncated.substring(0, lastSpaceIndex)
      : truncated;
      
    return result + '...';
  }
}