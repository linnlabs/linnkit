/**
 * @file src/chat/context/providers/WorkingMemoryProvider.ts
 * @description 工作记忆填充层Provider - 第二阶段上下文构建
 * 
 * 🎯 职责: 使用剩余预算，从最近的历史消息开始反向逐条填充
 * 📖 策略: P1优先级(最终回答) + P2优先级(思维链回补)
 * ✨ 特性: 智能内容提取，最大化保留对话的"事实"和"结论"
 *
 * 🧩 说明（Chat 与工具消息）：
 * - Chat 模式下，来自 Agent 历史的 `tool_calls/tool_output` 默认会被 `ToolHistoryFilterPreprocessor` 过滤掉，
 *   因此本 Provider 不承担“工具交互优先级/配对保留”等职责（这些属于 AgentWorkingMemoryProvider）。
 */

import { BaseContextProvider, MessageProcessingState, ProviderContext, ProviderResult } from './base';
import type { AiMessage } from '../../../../../contracts';

/**
 * 工作记忆填充层Provider
 * 
 * 实现README中描述的第二阶段：工作记忆填充层 (Working Memory)
 * 使用剩余预算反向填充，优先保留最终回答，其次回补思维链
 */
export class WorkingMemoryProvider extends BaseContextProvider {
  readonly name = 'WorkingMemoryProvider';
  readonly description = '工作记忆填充层 - 反向填充最终回答和思维链，最大化保留对话事实';
  readonly priority = 2; // 仅次于核心上下文

  async provide(
    states: MessageProcessingState[], 
    availableBudget: number, 
    context: ProviderContext
  ): Promise<ProviderResult> {
    this.debug('🧠 开始工作记忆填充层处理', {
      totalMessages: states.length,
      availableBudget,
      config: {
        thinkingRecallCount: context.config.THINKING_RECALL_COUNT
      }
    }, context);

    // 计算当前已使用的Token (核心上下文)
    const coreTokens = this.calculateUsedTokens(states);
    let workingMemoryTokens = coreTokens;
    let processedCount = 0;
    const strategiesApplied: string[] = [];

    // 获取所有跳过的消息状态，用于填充
    const skippedStates = states.filter(s => s.action === 'skip');

    // === P1 优先级：反向填充最终回答部分 ===
    this.debug('🎯 P1优先级：开始标记最终回答部分');
    const p1Result = await this.processP1Priority(
      skippedStates, 
      workingMemoryTokens, 
      availableBudget, 
      context
    );
    
    workingMemoryTokens += p1Result.tokensUsed;
    processedCount += p1Result.processedCount;
    strategiesApplied.push(...p1Result.strategiesApplied);

    // === P2 优先级：回补思维链 ===
    if (workingMemoryTokens < availableBudget) {
      this.debug('🧠 P2优先级：开始标记思维链回补');
      const p2Result = await this.processP2Priority(
        states, 
        workingMemoryTokens, 
        availableBudget, 
        context
      );
      
      workingMemoryTokens += p2Result.tokensUsed;
      processedCount += p2Result.processedCount;
      strategiesApplied.push(...p2Result.strategiesApplied);
    }

    const finalTokensUsed = workingMemoryTokens - coreTokens;

    this.debug('📊 工作记忆填充层处理完成', {
      workingMemoryMessages: processedCount,
      workingMemoryTokens: finalTokensUsed,
      totalTokensUsed: workingMemoryTokens,
      remainingBudget: availableBudget - workingMemoryTokens
    }, context);

    return this.createResult(
      states,
      finalTokensUsed,
      strategiesApplied,
      {
        processedCount,
        skippedCount: skippedStates.length - processedCount,
        addedCount: 0
      }
    );
  }

  /**
   * P1优先级处理：反向填充最终回答部分
   */
  private async processP1Priority(
    skippedStates: MessageProcessingState[],
    currentTokens: number,
    budgetLimit: number,
    context: ProviderContext
  ): Promise<{ tokensUsed: number; processedCount: number; strategiesApplied: string[] }> {
    let tokensUsed = 0;
    let processedCount = 0;
    const strategiesApplied: string[] = [];

    // 反向遍历跳过的消息
    for (let i = skippedStates.length - 1; i >= 0; i--) {
      const state = skippedStates[i];
      
      if (currentTokens + tokensUsed >= budgetLimit) {
        this.debug('💰 达到预算限制，停止P1填充', { 
          currentTokens: currentTokens + tokensUsed, 
          budgetLimit 
        }, context);
        break;
      }

      // 处理 assistant final_answer 消息
      if (state.message.role === 'assistant' && state.message.type === 'final_answer') {
        const finalAnswerContent = this.extractFinalAnswerContent(state.message);
        if (finalAnswerContent) {
          const finalAnswerTokens = context.estimateTokens({ 
            ...state.message, 
            content: finalAnswerContent 
          });
          
          if (currentTokens + tokensUsed + finalAnswerTokens <= budgetLimit) {
            state.action = 'keep_working_memory';
            state.processedContent = finalAnswerContent;
            state.tokens = finalAnswerTokens;
            state.contentType = 'final_answer_only';
            state.phase = 'WORKING_MEMORY';
            
            tokensUsed += finalAnswerTokens;
            processedCount++;
            strategiesApplied.push('final_answer_extraction');
            
            this.debug(`✅ P1标记assistant消息`, {
              id: state.message.id,
              tokens: finalAnswerTokens,
              totalTokens: currentTokens + tokensUsed
            }, context);
          } else {
            this.debug(`❌ P1超出预算`, { 
              id: state.message.id, 
              wouldExceed: currentTokens + tokensUsed + finalAnswerTokens,
              budgetLimit 
            }, context);
          }
        }
      }
      // 新增：处理 assistant task_completion 消息（完整保留，不做<think>剥离）
      else if (state.message.role === 'assistant' && state.message.type === 'task_completion') {
        if (currentTokens + tokensUsed + state.tokens <= budgetLimit) {
          state.action = 'keep_working_memory';
          state.phase = 'WORKING_MEMORY';
          // contentType 维持默认 'full'
          tokensUsed += state.tokens;
          processedCount++;
          strategiesApplied.push('task_completion_preservation');

          this.debug(`✅ P1标记task_completion消息`, {
            id: state.message.id,
            tokens: state.tokens,
            totalTokens: currentTokens + tokensUsed
          }, context);
        } else {
          this.debug(`❌ P1超出预算(task_completion)`, { 
            id: state.message.id, 
            wouldExceed: currentTokens + tokensUsed + state.tokens,
            budgetLimit 
          }, context);
        }
      }
      // 处理其他优先级消息 (final_answer, user_input)
      else if (state.message.type === 'final_answer' || state.message.type === 'user_input') {
        if (currentTokens + tokensUsed + state.tokens <= budgetLimit) {
          state.action = 'keep_working_memory';
          state.phase = 'WORKING_MEMORY';
          tokensUsed += state.tokens;
          processedCount++;
          
          this.debug(`✅ P1标记优先级消息`, {
            id: state.message.id,
            type: state.message.type,
            tokens: state.tokens,
            totalTokens: currentTokens + tokensUsed
          }, context);
        }
      }
    }

    return { tokensUsed, processedCount, strategiesApplied };
  }

  /**
   * P2优先级处理：回补思维链 + 历史摘要
   * 
   * 💬 处理顺序（参考 AgentWorkingMemoryProvider）：
   * 1. 首先处理 history_summary（如果有）
   * 2. 然后回补思维链
   */
  private async processP2Priority(
    states: MessageProcessingState[],
    currentTokens: number,
    budgetLimit: number,
    context: ProviderContext
  ): Promise<{ tokensUsed: number; processedCount: number; strategiesApplied: string[] }> {
    let tokensUsed = 0;
    let processedCount = 0;
    const strategiesApplied: string[] = [];

    // 🔥 新增：优先处理历史摘要（参考 AgentWorkingMemoryProvider）
    // 此时已由HistoryPurificationPreprocessor清理，最多只会有一条摘要
    for (const state of states) {
      if (state.message.role === 'system' && state.message.type === 'history_summary') {
        if (state.action === 'skip' && currentTokens + tokensUsed + state.tokens <= budgetLimit) {
          state.action = 'keep_working_memory';
          state.phase = 'WORKING_MEMORY';
          tokensUsed += state.tokens;
          processedCount++;
          strategiesApplied.push('history_summary');
          
          this.debug(`✅ P2保留历史摘要`, {
            id: state.message.id,
            tokens: state.tokens,
            totalTokens: currentTokens + tokensUsed
          }, context);
        }
        break; // 最多只有一条摘要，找到后退出
      }
    }

    // 获取最近保留的 assistant final_answer 消息
    const recentFinalAnswers = states
      .filter(s => s.action === 'keep_working_memory' && 
                   s.message.role === 'assistant' && 
                   s.message.type === 'final_answer')
      .slice(-context.config.THINKING_RECALL_COUNT);

    for (const finalAnswerState of recentFinalAnswers) {
      if (currentTokens + tokensUsed >= budgetLimit) {
        this.debug('💰 达到预算限制，停止P2回补', { 
          currentTokens: currentTokens + tokensUsed, 
          budgetLimit 
        }, context);
        break;
      }

      // 寻找对应的独立 thought 消息
      // 关键修复：仅在 final_answer 消息紧邻的前一条消息是 thought 时才进行回补
      const finalAnswerIndex = finalAnswerState.originalIndex;
      let thoughtState: MessageProcessingState | undefined = undefined;

      if (finalAnswerIndex > 0) {
        const potentialThoughtState = states[finalAnswerIndex - 1];
        if (
          potentialThoughtState &&
          potentialThoughtState.action === 'skip' &&
          potentialThoughtState.message.role === 'assistant' &&
          potentialThoughtState.message.type === 'thought'
        ) {
          thoughtState = potentialThoughtState;
        }
      }

      if (thoughtState && currentTokens + tokensUsed + thoughtState.tokens <= budgetLimit) {
        thoughtState.action = 'keep_working_memory';
        thoughtState.phase = 'WORKING_MEMORY';
        thoughtState.contentType = 'thinking_only';
        
        tokensUsed += thoughtState.tokens;
        processedCount++;
        strategiesApplied.push('independent_thinking_recall');

        this.debug(`✅ P2回补独立思维链`, {
          thoughtId: thoughtState.message.id,
          finalAnswerId: finalAnswerState.message.id,
          tokens: thoughtState.tokens,
          totalTokens: currentTokens + tokensUsed
        }, context);
      }
    }

    // 新增：Fallback 回补 - 当没有可用的 final_answer 配对时，按最近顺序回补少量 thought
    if (processedCount === 0 && currentTokens + tokensUsed < budgetLimit) {
      let recalled = 0;
      for (let i = states.length - 1; i >= 0; i--) {
        if (recalled >= context.config.THINKING_RECALL_COUNT) break;
        const s = states[i];
        if (s.action !== 'skip') continue;
        if (s.message.role === 'assistant' && s.message.type === 'thought') {
          if (currentTokens + tokensUsed + s.tokens <= budgetLimit) {
            s.action = 'keep_working_memory';
            s.phase = 'WORKING_MEMORY';
            s.contentType = 'thinking_only';
            tokensUsed += s.tokens;
            processedCount++;
            recalled++;
            strategiesApplied.push('independent_thinking_recall_fallback');
            this.debug(`✅ P2回补(无配对)思维链`, {
              thoughtId: s.message.id,
              tokens: s.tokens,
              totalTokens: currentTokens + tokensUsed
            }, context);
          } else {
            break;
          }
        }
      }
    }

    return { tokensUsed, processedCount, strategiesApplied };
  }

  /**
   * 计算当前已使用的Token数
   */
  private calculateUsedTokens(states: MessageProcessingState[]): number {
    return states
      .filter(s => s.action.startsWith('keep_'))
      .reduce((total, state) => total + state.tokens, 0);
  }

  /**
   * 提取AI消息的最终回答部分（移除<think>标签内容）
   */
  private extractFinalAnswerContent(message: AiMessage): string {
    const thinkRegex = /<think>([\s\S]*?)<\/think>/gi;
    return message.content.replace(thinkRegex, '').trim();
  }
}
