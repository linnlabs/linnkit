/**
 * @file src/agent/context-manager/profiles/agent/context/providers/CheckpointSummarizationProvider.ts
 * @description 上下文检查点 Provider（根因级语义修正版）：
 *
 * ✅ checkpoint 是一个“正常工具调用”，必须以 tool_calls → tool_output 的形式按顺序保留在历史中，
 * 也必须按顺序进入发送给 LLM 的 messages（而不是被替换成 system history_summary 顶置到最前）。
 *
 * 🎯 checkpoint 的职责是“清理 checkpoint 之前的旧历史”，而不是“把 checkpoint 本身变成摘要”：
 * - 保留：Must-Keep（system_prompt / 最新 user_input / 必保留 fence 等）、checkpoint 工具对、
 *        以及 checkpoint 之前最近 N 对工具交互（默认 N=2）。
 * - 清理：checkpoint 之前更旧的工具对 / final_answer / thought / 旧 history_summary 等。
 *
 * ✅ 设计原则：
 * - checkpoint 只影响“本轮发给 LLM 的 messages 选择”，不生成任何 system 摘要事件；
 * - 数据库仍然落全量事实历史：裁剪不会影响持久化/回放，只影响本轮 LLM 输入。
 */

import {
  BaseContextProvider,
  type MessageProcessingState,
  type ProviderContext,
  type ProviderResult,
} from './base';
import { CHECKPOINT_MARKER_TYPE } from '../../../../shared/checkpointMarker';
import { Logger } from '../../../../../shared/logger';
import {
  buildToolInteractionGroupsFromStates,
  type ToolInteractionGroup,
} from '../../utils/toolInteractionGroup';

const logger = new Logger('CheckpointSummarizationProvider');

const CHECKPOINT_TOOL_NAME = 'context_checkpoint';
const DEFAULT_KEEP_PAIRS_BEFORE_CHECKPOINT = 2;

type UnknownRecord = Record<string, unknown>;
function isRecord(v: unknown): v is UnknownRecord {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 从 tool_output 消息的 content 中尝试解析 checkpoint 标记
 * 返回 summary 字符串或 null
 */
function extractCheckpointSummary(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    // StructuredToolResult 格式：{ data: { _type, summary }, observation }
    const data = parsed['data'];
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const rec = data as Record<string, unknown>;
      if (rec['_type'] === CHECKPOINT_MARKER_TYPE && typeof rec['summary'] === 'string') {
        return rec['summary'];
      }
    }
    // 兼容直接格式
    if (parsed['_type'] === CHECKPOINT_MARKER_TYPE && typeof parsed['summary'] === 'string') {
      return parsed['summary'] as string;
    }
  } catch {
    // content 不是 JSON，跳过
  }
  return null;
}

/**
 * 从 tool_output 消息中提取 checkpoint summary（严格模式）：
 * - 仅使用 metadata.raw_output（原始 JSON）
 * - 不解析 content，避免与 observation（给 AI 的纯文本）语义混淆
 */
function extractCheckpointSummaryFromToolOutputMessage(message: {
  content?: unknown;
  metadata?: Record<string, unknown> | undefined;
}): string | null {
  const rawOutput = message.metadata?.['raw_output'];
  if (typeof rawOutput === 'string') {
    return extractCheckpointSummary(rawOutput);
  }

  return null;
}

export interface CheckpointSummarizationProviderOptions {
  /** checkpoint 之前保留的最近工具交互轮数。 */
  keepPairsBefore?: number;
  /** 触发 checkpoint 裁剪的工具名。默认 context_checkpoint。 */
  triggerToolName?: string;
}

export class CheckpointSummarizationProvider extends BaseContextProvider {
  readonly name = 'CheckpointSummarizationProvider';
  readonly description = '上下文检查点 - 保留 checkpoint 工具对，裁剪其之前旧历史';
  readonly priority = 2.5;

  private readonly keepPairsBefore: number;
  private readonly triggerToolName: string;

  constructor(options: CheckpointSummarizationProviderOptions = {}) {
    super();
    this.keepPairsBefore = normalizeNonNegativeInteger(
      options.keepPairsBefore,
      DEFAULT_KEEP_PAIRS_BEFORE_CHECKPOINT,
    );
    this.triggerToolName = normalizeTriggerToolName(options.triggerToolName);
  }

  async provide(
    states: MessageProcessingState[],
    availableBudget: number,
    context: ProviderContext,
  ): Promise<ProviderResult> {
    // 1) 在 states 中搜索 context_checkpoint 的 tool_output
    const checkpointResult = this.findCheckpoint(states);
    if (!checkpointResult) {
      return this.createResult(states, 0, [], {
        processedCount: 0,
        skippedCount: 0,
        addedCount: 0,
      });
    }

    const { checkpointGroup } = checkpointResult;

    logger.info('🔄 检测到 checkpoint，开始执行 checkpoint 前历史清理', {
      totalStates: states.length,
      checkpointAnchorId: checkpointGroup.anchorId,
      triggerToolName: this.triggerToolName,
      keepPairsBefore: this.keepPairsBefore,
    });
    const keepBefore = this.findRecentToolPairIndicesBeforeCheckpoint(states, checkpointGroup.startIndex);

    const keepSet = new Set<number>([
      ...checkpointGroup.messageIndexes,
      ...keepBefore,
    ]);

    // 2.2) 强制提升保留工具交互的 action：checkpoint 与其前两对工具对必须进入最终 messages
    let promotedKeepCount = 0;
    for (const idx of keepSet) {
      const state = states[idx];
      if (!state) continue;
      if (state.action === 'skip') {
        state.action = 'keep_working_memory';
        state.phase = 'CHECKPOINT';
        promotedKeepCount++;
      }
    }

    // 3) 选择要裁剪的候选（仅限 checkpoint 之前）
    const candidatesToPurge: MessageProcessingState[] = [];
    for (let i = 0; i < states.length; i++) {
      if (i >= checkpointGroup.startIndex) {
        // checkpoint 本身以及之后的消息：全部不参与 purge（只做预算筛选）
        continue;
      }
      const s = states[i];
      const msg = s.message;

      // Must-Keep：永远不 purge（由 CoreContextProvider 标记）
      if (s.action === 'keep_core' && msg.type !== 'history_summary') {
        continue;
      }
      // 系统提示词类：永远不 purge（history_summary 除外）
      if (msg.role === 'system' && msg.type !== 'history_summary') {
        continue;
      }
      // checkpoint 前最近 N 对工具交互：不 purge
      if (keepSet.has(i)) {
        continue;
      }

      candidatesToPurge.push(s);
    }

    if (candidatesToPurge.length === 0) {
      logger.info('⏭️ 无可清理的 checkpoint 前历史，跳过 purge');
      return this.createResult(states, 0, [], {
        processedCount: 0,
        skippedCount: 0,
        addedCount: 0,
      });
    }

    // 4) 立即在本 tick 的 states 中应用裁剪：把候选全部降级为 skip（即不进 LLM messages）
    let demotedCount = 0;
    for (const s of candidatesToPurge) {
      if (s.action !== 'skip') {
        s.action = 'skip';
        s.phase = 'CHECKPOINT_PURGED';
        demotedCount++;
      }
    }

    logger.info('✅ Checkpoint 前历史裁剪完成', {
      purgedCount: candidatesToPurge.length,
      promotedKeepCount,
      demotedCount,
    });

    return this.createResult(
      states,
      0,
      ['checkpoint_trim_before'],
      {
        processedCount: candidatesToPurge.length,
        skippedCount: 0,
        addedCount: 0,
      },
    );
  }

  /**
   * 在 states 中查找 context_checkpoint 工具的 observation
   * 返回 { summary, checkpointStateIndex } 或 null
   */
  private findCheckpoint(
    states: MessageProcessingState[],
  ): { summary: string; checkpointGroup: ToolInteractionGroup<MessageProcessingState> } | null {
    const groups = buildToolInteractionGroupsFromStates(states, {
      checkpointToolName: this.triggerToolName,
    });
    for (let index = groups.length - 1; index >= 0; index -= 1) {
      const group = groups[index];
      const summary = this.extractCheckpointSummaryFromGroup(group);
      if (summary) {
        return { summary, checkpointGroup: group };
      }
    }
    return null;
  }

  /**
   * 找到 checkpoint 之前最近 N 轮工具交互 indices
   * - 仅扫描 checkpoint tool_calls 之前的历史段
   */
  private findRecentToolPairIndicesBeforeCheckpoint(states: MessageProcessingState[], beforeIndexExclusive: number): number[] {
    if (this.keepPairsBefore <= 0) {
      return [];
    }

    const indices: number[] = [];
    const groups = buildToolInteractionGroupsFromStates(states, {
      checkpointToolName: this.triggerToolName,
    })
      .filter((group) => group.startIndex < beforeIndexExclusive && group.isComplete && !group.isCheckpointGroup)
      .slice(-this.keepPairsBefore);
    for (const group of groups) {
      indices.push(...group.messageIndexes);
    }
    return indices;
  }

  private extractCheckpointSummaryFromGroup(
    group: ToolInteractionGroup<MessageProcessingState>,
  ): string | null {
    if (!group.toolNames.includes(this.triggerToolName)) {
      return null;
    }
    for (const message of group.toolOutputMessages) {
      const summary = extractCheckpointSummaryFromToolOutputMessage(message);
      if (summary) {
        return summary;
      }
    }
    return null;
  }

  // 中文备注：这里不做“跨 tick 幂等事件锚点”，因为本 Provider 是纯裁剪逻辑，重复运行是幂等的。
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeTriggerToolName(value: string | undefined): string {
  const candidate = value?.trim();
  return candidate && candidate.length > 0 ? candidate : CHECKPOINT_TOOL_NAME;
}
