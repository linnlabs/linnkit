import { generateMessageId } from '../../../../shared/ids';
import type { AiMessage } from '../../../../contracts';
import {
  BasePreprocessor,
  PreprocessorContext,
  PreprocessorResult,
  type ToolReplayProtocolPolicy,
} from './base';
import {
  buildToolInteractionGroupsFromMessages,
  findCurrentRoundStartIndex,
  type ToolInteractionGroup,
} from '../utils/toolInteractionGroup';

export interface ToolReplayProtocolGuardOptions {
  policy?: ToolReplayProtocolPolicy;
  priority?: number;
}

export function resolveToolReplayProtocolPolicy(
  context: PreprocessorContext,
  explicitPolicy?: ToolReplayProtocolPolicy,
): ToolReplayProtocolPolicy {
  if (explicitPolicy) {
    return explicitPolicy;
  }

  if (context.toolReplayProtocolPolicy) {
    return context.toolReplayProtocolPolicy;
  }

  return {
    missingSidecarBehavior: 'allow',
  };
}

function hasReasoningDetails(message: AiMessage): boolean {
  const reasoningDetails = message.metadata?.reasoning_details;
  return Array.isArray(reasoningDetails) && reasoningDetails.length > 0;
}

function stringifyRecord(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    return '{}';
  }
}

function buildDegradedToolReplayMessage(group: ToolInteractionGroup<AiMessage>): AiMessage {
  const lines: string[] = [];
  const assistantContent = group.assistantMessage.content.trim();
  if (assistantContent) {
    lines.push(assistantContent);
  }

  for (const item of group.items) {
    lines.push(`Tool call ${item.toolName} args=${stringifyRecord(item.toolArgs)}`);
    const outputs = item.rawOutputs.length > 0 ? item.rawOutputs : [''];
    for (const rawOutput of outputs) {
      lines.push(`Tool result ${item.toolCallId}: ${rawOutput}`);
    }
  }

  return {
    id: generateMessageId(),
    role: 'assistant',
    type: 'final_answer',
    content: lines.join('\n\n'),
    timestamp: group.assistantMessage.timestamp,
    metadata: {
      isDegradedToolReplay: true,
      degradationReason: 'missing_required_reasoning_details',
      replacementSourceIds: group.sourceMessageIds,
      degradedToolCallIds: group.toolCallIds,
      degradedToolNames: group.toolNames,
      toolInteractionGroupSize: group.items.length,
    },
  };
}

function markProviderEmptyReplayField(message: AiMessage, group: ToolInteractionGroup<AiMessage>): AiMessage {
  return {
    ...message,
    metadata: {
      ...message.metadata,
      provider_empty_replay_field: true,
      providerSidecarMissingBehavior: 'provider_empty_replay_field',
      providerSidecarMissingReason: 'missing_required_reasoning_details',
      providerSidecarMissingSourceIds: group.sourceMessageIds,
      providerSidecarMissingToolCallIds: group.toolCallIds,
      providerSidecarMissingToolNames: group.toolNames,
    },
  };
}

/**
 * Agent 工具回放协议守卫。
 *
 * 中文说明：
 * - 正向链路必须优先保证真实 provider sidecar 不丢；
 * - 这里仅处理“已经进入历史轮次”的旧工具组，避免它们继续伪装成结构化 replay；
 * - 当前轮次的工具组不在这里降级，否则会掩盖新链路丢 sidecar 的根因。
 */
export class ToolReplayProtocolGuardPreprocessor extends BasePreprocessor {
  readonly name = 'ToolReplayProtocolGuardPreprocessor';
  readonly description = '工具回放协议守卫 - 对要求 provider sidecar 的历史工具组执行结构化回放治理';
  readonly priority: number;

  private readonly explicitPolicy?: ToolReplayProtocolPolicy;

  constructor(options: ToolReplayProtocolGuardOptions = {}) {
    super();
    this.priority = options.priority ?? 0.5;
    this.explicitPolicy = options.policy;
  }

  shouldSkip(messages: AiMessage[], context: PreprocessorContext): boolean {
    if (!messages.some((message) => message.role === 'assistant' && message.type === 'tool_calls')) {
      return true;
    }
    const policy = resolveToolReplayProtocolPolicy(context, this.explicitPolicy);
    return policy.requiresReasoningDetailsForToolReplay !== true
      || policy.missingSidecarBehavior === undefined
      || policy.missingSidecarBehavior === 'allow';
  }

  async process(messages: AiMessage[], context: PreprocessorContext): Promise<PreprocessorResult> {
    const policy = resolveToolReplayProtocolPolicy(context, this.explicitPolicy);
    if (
      policy.requiresReasoningDetailsForToolReplay !== true
      || policy.missingSidecarBehavior === undefined
      || policy.missingSidecarBehavior === 'allow'
    ) {
      return this.createResult(messages, messages, [], 0);
    }

    const currentRoundStartIndex = findCurrentRoundStartIndex(messages);
    const groups = buildToolInteractionGroupsFromMessages(messages);
    const groupsToDegrade = groups.filter((group) => {
      return group.isComplete
        && group.endIndex < currentRoundStartIndex
        && !hasReasoningDetails(group.assistantMessage);
    });

    if (groupsToDegrade.length === 0) {
      return this.createResult(messages, messages, [], 0);
    }

    if (policy.missingSidecarBehavior === 'provider_empty_replay_field') {
      const groupByAssistantIndex = new Map<number, ToolInteractionGroup<AiMessage>>();
      for (const group of groupsToDegrade) {
        groupByAssistantIndex.set(group.assistantIndex, group);
      }
      const processedMessages = messages.map((message, index) => {
        const group = groupByAssistantIndex.get(index);
        return group ? markProviderEmptyReplayField(message, group) : message;
      });

      this.debug('已标记缺少 provider sidecar 的历史工具组由 provider 空字段回放', {
        provider: policy.provider,
        markedGroupCount: groupsToDegrade.length,
      }, context);

      return this.createResult(
        messages,
        processedMessages,
        ['tool_replay_protocol_guard'],
        groupsToDegrade.length,
      );
    }

    const replacementByAssistantIndex = new Map<number, AiMessage>();
    const indexesToRemove = new Set<number>();
    for (const group of groupsToDegrade) {
      replacementByAssistantIndex.set(group.assistantIndex, buildDegradedToolReplayMessage(group));
      for (const messageIndex of group.messageIndexes) {
        indexesToRemove.add(messageIndex);
      }
    }

    const processedMessages: AiMessage[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      if (!indexesToRemove.has(index)) {
        processedMessages.push(messages[index]);
        continue;
      }
      const replacement = replacementByAssistantIndex.get(index);
      if (replacement) {
        processedMessages.push(replacement);
      }
    }

    this.debug('已降级缺少 provider sidecar 的历史工具组', {
      provider: policy.provider,
      degradedGroupCount: groupsToDegrade.length,
    }, context);

    return this.createResult(
      messages,
      processedMessages,
      ['tool_replay_protocol_guard'],
      groupsToDegrade.length,
    );
  }
}
