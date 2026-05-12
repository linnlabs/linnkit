/**
 * @file src/agent/context/providers/AgentWorkingMemoryProvider.ts
 * @description Agent专用工作记忆填充层Provider - 第二阶段上下文构建
 *
 * 🎯 职责: 实现Agent的P1-P4优先级填充策略
 * 📖 策略: P1(工具交互) > P2(纯文本对话) > P3(历史工具交互) > P4(循环填充)
 * ✨ Agent特性: 工具调用优先级、配对保留策略
 * 🔧 核心逻辑: 保留工具调用时，必须确保其对应的另一半也被保留
 */

import { BaseContextProvider, MessageProcessingState, ProviderContext, ProviderResult } from './base';
import {
  createAgentContextBuilderConfig,
  type AgentContextBuilderConfig,
} from '../config';
import { ToolPairMatcher, ToolPairTruncator, ReplacementSourceTagger } from './working-memory';
import type { DebugFn } from './working-memory';
import {
  buildToolInteractionGroupsFromStates,
  findLastUserInputOriginalIndex,
  type ToolInteractionGroup,
} from '../../utils/toolInteractionGroup';

/**
 * Agent专用工作记忆填充层Provider
 *
 * 实现Agent README中描述的第二阶段：工作记忆填充层 (Working Memory)
 * 工具调用为最高优先级，确保工具交互的完整性
 */
export class AgentWorkingMemoryProvider extends BaseContextProvider {
  readonly name = 'AgentWorkingMemoryProvider';
  readonly description = 'Agent工作记忆填充层 - 工具优先的反向填充策略，支持配对保留';
  readonly priority = 2; // 仅次于核心上下文

  private readonly matcher: ToolPairMatcher;
  private readonly truncator: ToolPairTruncator;
  private readonly tagger: ReplacementSourceTagger;
  private readonly config: AgentContextBuilderConfig;

  constructor(customConfig?: Partial<AgentContextBuilderConfig>) {
    super();
    this.config = createAgentContextBuilderConfig(customConfig ?? {});
    this.matcher = new ToolPairMatcher(this.config);
    this.truncator = new ToolPairTruncator(this.config);
    this.tagger = new ReplacementSourceTagger();
  }

  /**
   * 类型守卫：用于安全读取 ProviderContext 上的"扩展字段"
   * 注意：ProviderContext 本身是稳定契约，扩展字段来自编排层（不应污染接口定义）。
   */
  private isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  /**
   * 读取当前上下文阶段（如果编排层提供了 currentPhase）
   * - 禁止 any 类型断言：这里用 Record 逐层收窄。
   */
  private readCurrentPhase(context: ProviderContext): string | undefined {
    const ctx = context as unknown;
    if (!this.isRecord(ctx)) return undefined;
    const currentPhase = ctx['currentPhase'];
    if (!this.isRecord(currentPhase)) return undefined;
    const phase = currentPhase['phase'];
    return typeof phase === 'string' ? phase : undefined;
  }

  /**
   * 创建调试函数
   */
  private createDebugFn(context: ProviderContext): DebugFn {
    return (message: string, data?: Record<string, unknown>) => {
      this.debug(message, data, context);
    };
  }

  async provide(
    states: MessageProcessingState[],
    availableBudget: number,
    context: ProviderContext
  ): Promise<ProviderResult> {
    // 使用统一配置
    const config = this.config;

    this.debug('🧠 开始Agent工作记忆填充层处理', {
      totalMessages: states.length,
      availableBudget,
      config: {
        budgetPercentage: config.WORKING_MEMORY_BUDGET_PERCENTAGE
      }
    }, context);

    // 计算当前已使用的Token (核心上下文)
    const coreTokens = this.calculateUsedTokens(states);
    let workingMemoryTokens = coreTokens;
    let processedCount = 0;
    const strategiesApplied: string[] = [];

    // 计算工作记忆预算（使用配置中的百分比）
    const workingMemoryBudget = Math.floor(availableBudget * config.WORKING_MEMORY_BUDGET_PERCENTAGE);
    const remainingBudget = workingMemoryBudget - coreTokens;

    if (remainingBudget <= 0) {
      this.debug('⚠️ 核心上下文已用尽预算，跳过工作记忆填充', {
        coreTokens,
        workingMemoryBudget
      }, context);
      return this.createResult(states, 0, [], { processedCount: 0, skippedCount: 0, addedCount: 0 });
    }

    // 🔥 阶段感知：POST_TOOL_CALL 优先保留"最近一对"工具交互（tool_calls ↔ tool_output）
    const processedIds = new Set<string>();
    const inPostToolCall = this.readCurrentPhase(context) === 'post_tool_call';
    if (inPostToolCall) {
      const pri = this.promoteMostRecentToolPair(
        states,
        processedIds,
        workingMemoryTokens,
        workingMemoryBudget,
        context
      );
      workingMemoryTokens += pri.tokensUsed;
      processedCount += pri.processedCount;
      strategiesApplied.push(...pri.strategiesApplied);
    }

    // 获取所有跳过的消息状态，用于填充
    const skippedStates = states.filter(s => s.action === 'skip');
    const toolGroups = buildToolInteractionGroupsFromStates(states);

    // === Agent专用逻辑：工具优先填充策略 ===
    const maxToolGroupsTotal = config.MAX_TOOL_INTERACTION_GROUPS_TO_KEEP;
    const maxRecentToolPairs = config.MAX_RECENT_TOOL_INTERACTIONS_TO_KEEP;
    let historicalToolGroupsKept = 0;

    // 计算"当前轮次起点（最后一条 user_input）"的 originalIndex
    const lastUserOriginalIndex = findLastUserInputOriginalIndex(states);

    // P1 优先级：工具交互（tool_calls 和 tool 消息）- 配对保留
    this.debug('🔧 P1优先级：开始处理工具交互（配对保留）', { remainingBudget: workingMemoryBudget - workingMemoryTokens });
    const p1Result = await this.processToolInteractions(
      states,
      toolGroups,
      processedIds,
      workingMemoryTokens,
      workingMemoryBudget,
      context,
      {
        maxToolPairsToKeep: Math.min(maxRecentToolPairs, maxToolGroupsTotal),
        lastUserOriginalIndex
      }
    );

    workingMemoryTokens += p1Result.tokensUsed;
    processedCount += p1Result.processedCount;
    strategiesApplied.push(...p1Result.strategiesApplied);
    historicalToolGroupsKept += p1Result.historicalToolGroupsKept;

    // P2 优先级：纯文本对话（user 和 assistant 纯文本消息）
    if (workingMemoryTokens < workingMemoryBudget) {
      this.debug('💬 P2优先级：开始处理纯文本对话', {
        remainingBudget: workingMemoryBudget - workingMemoryTokens
      });
      const p2Result = await this.processTextConversations(
        skippedStates,
        processedIds,
        workingMemoryTokens,
        workingMemoryBudget,
        context
      );

      workingMemoryTokens += p2Result.tokensUsed;
      processedCount += p2Result.processedCount;
      strategiesApplied.push(...p2Result.strategiesApplied);
    }

    // P3 优先级：历史工具交互（第3组及以前的工具交互）
    if (workingMemoryTokens < workingMemoryBudget && lastUserOriginalIndex !== null) {
      this.debug('📚 P3优先级：开始处理历史工具交互', {
        remainingBudget: workingMemoryBudget - workingMemoryTokens
      });
      const remainingToolGroups = Math.max(0, maxToolGroupsTotal - historicalToolGroupsKept);
      const p3Result = await this.processHistoricalToolInteractions(
        states,
        toolGroups,
        processedIds,
        workingMemoryTokens,
        workingMemoryBudget,
        context,
        {
          maxToolGroupsToKeep: remainingToolGroups,
          lastUserOriginalIndex
        }
      );

      workingMemoryTokens += p3Result.tokensUsed;
      processedCount += p3Result.processedCount;
      strategiesApplied.push(...p3Result.strategiesApplied);
    }

    const finalTokensUsed = workingMemoryTokens - coreTokens;

    this.debug('📊 Agent工作记忆填充层处理完成', {
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
   * P1优先级处理：工具交互（配对保留）
   */
  private async processToolInteractions(
    allStates: MessageProcessingState[],
    toolGroups: ToolInteractionGroup<MessageProcessingState>[],
    processedIds: Set<string>,
    currentTokens: number,
    budgetLimit: number,
    context: ProviderContext,
    options: { maxToolPairsToKeep: number; lastUserOriginalIndex: number | null }
  ): Promise<{ tokensUsed: number; processedCount: number; strategiesApplied: string[]; historicalToolGroupsKept: number }> {
    let tokensUsed = 0;
    let processedCount = 0;
    const strategiesApplied: string[] = [];
    let historicalToolGroupsKept = 0;
    const maxToolPairsToKeep = Math.max(0, Math.floor(options.maxToolPairsToKeep));
    const lastUserOriginalIndex = options.lastUserOriginalIndex;
    const debugFn = this.createDebugFn(context);

    for (let index = toolGroups.length - 1; index >= 0; index -= 1) {
      const group = toolGroups[index];
      const isInCurrentTurn =
        lastUserOriginalIndex === null
          ? true
          : group.startIndex > lastUserOriginalIndex;

      if (!isInCurrentTurn) {
        if (historicalToolGroupsKept >= maxToolPairsToKeep) {
          break;
        }
      }

      if (currentTokens + tokensUsed >= budgetLimit) {
        this.debug('💰 达到预算限制，停止工具交互填充', {
          currentTokens: currentTokens + tokensUsed,
          budgetLimit
        }, context);
        break;
      }

      if (processedIds.has(group.anchorId)) {
        continue;
      }

      if (!group.isComplete) {
        this.debug('⚠️ 跳过不完整工具组，避免破坏协议顺序', {
          anchorId: group.anchorId,
          toolCallIds: group.toolCallIds,
        }, context);
        continue;
      }

      this.tagger.tagReplacementSources(group.messages, allStates);

      const fit = this.matcher.canFitToolPair(group, currentTokens + tokensUsed, budgetLimit, debugFn);
      if (fit.canFit) {
        for (const pairState of fit.pair) {
          if (pairState.action === 'skip') {
            pairState.action = 'keep_working_memory';
            pairState.phase = 'WORKING_MEMORY';
            tokensUsed += pairState.tokens;
            processedCount++;
          }
          processedIds.add(pairState.message.id);
        }
        strategiesApplied.push('tool_interaction_pairing');
        if (!isInCurrentTurn) {
          historicalToolGroupsKept++;
        }

        this.debug(`✅ P1保留工具交互对`, {
          anchorId: group.anchorId,
          pairSize: fit.pair.length,
          tokens: fit.totalTokens,
        }, context);
      } else {
        const truncationResult = this.truncator.truncate(group, context.estimateTokens, debugFn);
        if (truncationResult.success) {
          const fitAfterTruncation = this.matcher.canFitToolPair(group, currentTokens + tokensUsed, budgetLimit, debugFn);
          if (!fitAfterTruncation.canFit) {
            this.debug('💰 截断后仍无法装入预算，停止继续保留更旧工具对（保持结构一致）', {
              pairTokens: fitAfterTruncation.totalTokens,
              budgetLimit
            }, context);
            break;
          }
          for (const pairState of fitAfterTruncation.pair) {
            if (pairState.action === 'skip') {
              pairState.action = 'keep_working_memory';
              pairState.phase = 'WORKING_MEMORY';
              tokensUsed += pairState.tokens;
              processedCount++;
            }
            processedIds.add(pairState.message.id);
          }
          strategiesApplied.push('tool_interaction_truncation');
          if (!isInCurrentTurn) {
            historicalToolGroupsKept++;
          }
          this.debug(`✅ P1截断工具交互对`, {
            anchorId: group.anchorId,
            pairSize: fitAfterTruncation.pair.length,
            tokens: fitAfterTruncation.totalTokens,
            truncatedTokens: truncationResult.tokensSaved
          }, context);
        } else {
          this.debug(`❌ P1截断工具交互对失败`, {
            anchorId: group.anchorId,
            pairSize: group.messages.length,
            tokens: group.messages.reduce((sum, s) => sum + s.tokens, 0)
          }, context);
        }
      }
    }

    return { tokensUsed, processedCount, strategiesApplied, historicalToolGroupsKept };
  }

  /**
   * P2优先级处理：纯文本对话
   */
  private async processTextConversations(
    skippedStates: MessageProcessingState[],
    processedIds: Set<string>,
    currentTokens: number,
    budgetLimit: number,
    context: ProviderContext
  ): Promise<{ tokensUsed: number; processedCount: number; strategiesApplied: string[] }> {
    let tokensUsed = 0;
    let processedCount = 0;
    const strategiesApplied: string[] = [];
    let thoughtsKeptCount = 0;
    const config = this.config;

    for (let i = skippedStates.length - 1; i >= 0; i--) {
      const state = skippedStates[i];

      if (currentTokens + tokensUsed >= budgetLimit) {
        this.debug('💰 达到预算限制，停止纯文本对话填充', {
          currentTokens: currentTokens + tokensUsed,
          budgetLimit
        }, context);
        break;
      }

      if (state.action !== 'skip' || processedIds.has(state.message.id)) {
        continue;
      }

      // 处理历史摘要
      if (state.message.role === 'system' && state.message.type === 'history_summary') {
        if (currentTokens + tokensUsed + state.tokens <= budgetLimit) {
          state.action = 'keep_working_memory';
          state.phase = 'WORKING_MEMORY';
          tokensUsed += state.tokens;
          processedCount++;
          processedIds.add(state.message.id);
          strategiesApplied.push('history_summary');

          this.debug(`✅ P2保留历史摘要`, {
            id: state.message.id,
            tokens: state.tokens,
            totalTokens: currentTokens + tokensUsed
          }, context);
        }
        continue;
      }

      // 处理纯文本用户消息
      if (state.message.role === 'user' &&
          !state.message.metadata?.tool_name &&
          state.message.metadata?.fragmentType !== 'document') {

        if (currentTokens + tokensUsed + state.tokens <= budgetLimit) {
          state.action = 'keep_working_memory';
          state.phase = 'WORKING_MEMORY';
          tokensUsed += state.tokens;
          processedCount++;
          strategiesApplied.push('text_conversation');

          this.debug(`✅ P2保留用户文本消息`, {
            id: state.message.id,
            tokens: state.tokens,
            totalTokens: currentTokens + tokensUsed
          }, context);
        }
      }

      // 处理纯文本助手消息
      else if (state.message.role === 'assistant' &&
               !state.message.metadata?.tool_name &&
               !state.message.metadata?.tool_calls &&
               state.message.type !== 'tool_calls') {
        // 压缩后的工具历史摘要消息不应按"纯文本对话"纳入
        if (this.matcher.isCompressedToolHistoryMessage(state.message)) {
          continue;
        }

        // 处理 thought 消息
        if (state.message.type === 'thought') {
          if (thoughtsKeptCount < config.MAX_THOUGHTS_TO_KEEP) {
            if (currentTokens + tokensUsed + state.tokens <= budgetLimit) {
              state.action = 'keep_working_memory';
              state.phase = 'WORKING_MEMORY';
              tokensUsed += state.tokens;
              processedCount++;
              thoughtsKeptCount++;
              strategiesApplied.push('thought_processing');

              this.debug(`✅ P2保留thought消息`, {
                id: state.message.id,
                tokens: state.tokens,
                totalTokens: currentTokens + tokensUsed
              }, context);
            }
          }
        } else {
          // 处理普通助手消息
          if (currentTokens + tokensUsed + state.tokens <= budgetLimit) {
            state.action = 'keep_working_memory';
            state.phase = 'WORKING_MEMORY';
            tokensUsed += state.tokens;
            processedCount++;
            strategiesApplied.push('text_conversation');

            this.debug(`✅ P2保留助手文本消息`, {
              id: state.message.id,
              tokens: state.tokens,
              totalTokens: currentTokens + tokensUsed
            }, context);
          }
        }
      }
    }

    return { tokensUsed, processedCount, strategiesApplied };
  }

  /**
   * P3优先级处理：历史工具交互
   */
  private async processHistoricalToolInteractions(
    allStates: MessageProcessingState[],
    toolGroups: ToolInteractionGroup<MessageProcessingState>[],
    processedIds: Set<string>,
    currentTokens: number,
    budgetLimit: number,
    context: ProviderContext,
    options: { maxToolGroupsToKeep: number; lastUserOriginalIndex: number }
  ): Promise<{ tokensUsed: number; processedCount: number; strategiesApplied: string[]; toolGroupsKept: number }> {
    let tokensUsed = 0;
    let processedCount = 0;
    const strategiesApplied: string[] = [];
    let toolGroupsKept = 0;
    const maxToolGroupsToKeep = Math.max(0, Math.floor(options.maxToolGroupsToKeep));
    const debugFn = this.createDebugFn(context);

    const candidates = this.buildHistoricalToolCandidates(allStates, toolGroups, options.lastUserOriginalIndex);
    for (const candidate of candidates) {
      if (toolGroupsKept >= maxToolGroupsToKeep) {
        break;
      }

      if (currentTokens + tokensUsed >= budgetLimit) {
        this.debug('💰 达到预算限制，停止历史工具交互填充', {
          currentTokens: currentTokens + tokensUsed,
          budgetLimit
        }, context);
        break;
      }

      if (candidate.kind === 'compressed') {
        const state = candidate.state;
        if (processedIds.has(state.message.id) || state.action !== 'skip') {
          continue;
        }
        if (currentTokens + tokensUsed + state.tokens > budgetLimit) {
          continue;
        }
        state.action = 'keep_working_memory';
        state.phase = 'WORKING_MEMORY';
        tokensUsed += state.tokens;
        processedCount++;
        processedIds.add(state.message.id);
        toolGroupsKept++;
        strategiesApplied.push('compressed_tool_history');
        continue;
      }

      const group = candidate.group;
      if (processedIds.has(group.anchorId) || !group.isComplete) {
        continue;
      }

      this.tagger.tagReplacementSources(group.messages, allStates);
      const fit = this.matcher.canFitToolPair(group, currentTokens + tokensUsed, budgetLimit, debugFn);
      if (fit.canFit) {
        for (const pairState of fit.pair) {
          if (pairState.action === 'skip') {
            pairState.action = 'keep_working_memory';
            pairState.phase = 'WORKING_MEMORY';
            tokensUsed += pairState.tokens;
            processedCount++;
          }
          processedIds.add(pairState.message.id);
        }
        strategiesApplied.push('historical_tool_interaction');
        toolGroupsKept++;

        this.debug(`✅ P3保留历史工具交互`, {
          anchorId: group.anchorId,
          pairSize: fit.pair.length,
          tokens: fit.totalTokens,
        }, context);
        continue;
      }

      const truncationResult = this.truncator.truncate(group, context.estimateTokens, debugFn);
      if (!truncationResult.success) {
        this.debug(`❌ P3截断历史工具交互对失败`, {
          anchorId: group.anchorId,
          pairSize: group.messages.length,
          tokens: group.messages.reduce((sum, state) => sum + state.tokens, 0),
        }, context);
        continue;
      }

      const fitAfterTruncation = this.matcher.canFitToolPair(group, currentTokens + tokensUsed, budgetLimit, debugFn);
      if (!fitAfterTruncation.canFit) {
        continue;
      }
      for (const pairState of fitAfterTruncation.pair) {
        if (pairState.action === 'skip') {
          pairState.action = 'keep_working_memory';
          pairState.phase = 'WORKING_MEMORY';
          tokensUsed += pairState.tokens;
          processedCount++;
        }
        processedIds.add(pairState.message.id);
      }
      strategiesApplied.push('historical_tool_interaction_truncation');
      toolGroupsKept++;
      this.debug(`✅ P3截断历史工具交互对`, {
        anchorId: group.anchorId,
        pairSize: fitAfterTruncation.pair.length,
        tokens: fitAfterTruncation.totalTokens,
        truncatedTokens: truncationResult.tokensSaved
      }, context);
    }

    return { tokensUsed, processedCount, strategiesApplied, toolGroupsKept };
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
   * POST_TOOL_CALL 阶段优先保留最近工具对
   */
  private promoteMostRecentToolPair(
    allStates: MessageProcessingState[],
    processedIds: Set<string>,
    currentTokens: number,
    budgetLimit: number,
    context: ProviderContext
  ): { tokensUsed: number; processedCount: number; strategiesApplied: string[] } {
    let tokensUsed = 0;
    let processedCount = 0;
    const strategiesApplied: string[] = [];
    const debugFn = this.createDebugFn(context);
    const toolGroups = buildToolInteractionGroupsFromStates(allStates);
    const group = [...toolGroups].reverse().find((candidate) => candidate.isComplete);
    if (!group) {
      return { tokensUsed, processedCount, strategiesApplied };
    }

    if (processedIds.has(group.anchorId)) {
      return { tokensUsed, processedCount, strategiesApplied };
    }

    this.tagger.tagReplacementSources(group.messages, allStates);

    // 若能直接装入，成对保留
    const fit = this.matcher.canFitToolPair(group, currentTokens, budgetLimit, debugFn);
    if (fit.canFit) {
      for (const s of fit.pair) {
        if (s.action === 'skip') {
          s.action = 'keep_working_memory';
          s.phase = 'WORKING_MEMORY';
          tokensUsed += s.tokens;
          processedCount++;
        }
        processedIds.add(s.message.id);
      }
      strategiesApplied.push('post_tool_call_priority');
      this.debug('✅ POST_TOOL_CALL：优先保留最近工具交互对', { pairTokens: fit.totalTokens }, context);
      return { tokensUsed, processedCount, strategiesApplied };
    }

    // 否则尝试摘要截断后再装入
    const truncated = this.truncator.truncate(group, context.estimateTokens, debugFn);
    if (truncated.success) {
      const fit2 = this.matcher.canFitToolPair(group, currentTokens, budgetLimit, debugFn);
      if (fit2.canFit) {
        for (const s of fit2.pair) {
          if (s.action === 'skip') {
            s.action = 'keep_working_memory';
            s.phase = 'WORKING_MEMORY';
            tokensUsed += s.tokens;
            processedCount++;
          }
          processedIds.add(s.message.id);
        }
        strategiesApplied.push('post_tool_call_truncation');
        this.debug('✅ POST_TOOL_CALL：截断后优先保留最近工具交互对', { pairTokens: fit2.totalTokens }, context);
        return { tokensUsed, processedCount, strategiesApplied };
      }
    }

    return { tokensUsed, processedCount, strategiesApplied };
  }

  private buildHistoricalToolCandidates(
    allStates: MessageProcessingState[],
    toolGroups: ToolInteractionGroup<MessageProcessingState>[],
    lastUserOriginalIndex: number,
  ): Array<
    | { kind: 'compressed'; sortIndex: number; state: MessageProcessingState }
    | { kind: 'group'; sortIndex: number; group: ToolInteractionGroup<MessageProcessingState> }
  > {
    const compressedCandidates = allStates
      .filter((state) => {
        if (!this.matcher.isCompressedToolHistoryMessage(state.message)) {
          return false;
        }
        return typeof state.originalIndex === 'number' && state.originalIndex <= lastUserOriginalIndex;
      })
      .map((state) => ({
        kind: 'compressed' as const,
        sortIndex: state.originalIndex,
        state,
      }));

    const groupCandidates = toolGroups
      .filter((group) => group.startIndex <= lastUserOriginalIndex)
      .map((group) => ({
        kind: 'group' as const,
        sortIndex: group.startIndex,
        group,
      }));

    return [...compressedCandidates, ...groupCandidates].sort((left, right) => right.sortIndex - left.sortIndex);
  }
}
