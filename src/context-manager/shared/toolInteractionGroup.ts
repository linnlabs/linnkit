import type { AiMessage } from '../../contracts';
import type { MessageProcessingState } from './providers/base';

type IndexedEntry<T> = {
  value: T;
  originalIndex: number;
  message: AiMessage;
};

type ToolCallRecord = {
  id: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
};

interface ToolInteractionGroupBuildOptions {
  /**
   * 工具调用到结果的最大距离，不计已经配对的同批结果；相邻结果的距离为 1。
   *
   * 中文备注：窗口约束插入的非本批消息，不能把合法批次的第 N 条结果误当成迟到结果。
   * user_input 或后续 assistant 消息始终关闭旧批次，不受窗口大小影响。
   */
  maxPairingDistance?: number;
}

export interface ToolInteractionGroupItem<T> {
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCall: ToolCallRecord;
  toolOutputs: T[];
  toolOutputMessages: AiMessage[];
  rawOutputs: string[];
}

export interface ToolInteractionGroup<T> {
  anchorId: string;
  /** 工具组所属的用户轮次序号：0 表示第一条 user_input 之前，之后每遇到一条 user_input 递增。 */
  runOrdinal: number;
  assistantState: T;
  assistantMessage: AiMessage;
  assistantIndex: number;
  toolOutputs: T[];
  toolOutputMessages: AiMessage[];
  toolOutputIndexes: number[];
  toolCallIds: string[];
  toolNames: string[];
  sourceMessageIds: string[];
  messageIndexes: number[];
  startIndex: number;
  endIndex: number;
  isComplete: boolean;
  isCompressed: boolean;
  items: ToolInteractionGroupItem<T>[];
  messages: T[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolCallRecord(value: unknown): value is ToolCallRecord {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.id === 'string' && value.id.trim().length > 0;
}

function getToolCalls(message: AiMessage): ToolCallRecord[] {
  const toolCalls = message.metadata?.tool_calls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.filter(isToolCallRecord);
}

function safeParseArgs(rawArgs: string | undefined): Record<string, unknown> {
  if (typeof rawArgs !== 'string' || rawArgs.trim().length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(rawArgs);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getRawOutput(message: AiMessage): string {
  if (message.metadata?.data !== undefined) {
    return JSON.stringify({
      data: message.metadata.data,
      observation: message.content,
      ...(isRecord(message.metadata.presentation) && message.metadata.presentation['media'] !== undefined
        ? { media: message.metadata.presentation['media'] }
        : {}),
    });
  }
  if (typeof message.metadata?.error === 'string') {
    return JSON.stringify({ error: message.metadata.error, observation: message.content });
  }
  throw new Error(`tool_output message ${message.id} is missing canonical data or error metadata.`);
}

function buildToolInteractionGroups<T>(
  entries: IndexedEntry<T>[],
  options: ToolInteractionGroupBuildOptions = {},
): ToolInteractionGroup<T>[] {
  type MutableGroup = {
    anchorId: string;
    assistantState: T;
    assistantMessage: AiMessage;
    assistantIndex: number;
    toolOutputs: Array<{ value: T; message: AiMessage; index: number }>;
    sourceMessageIds: Set<string>;
    runOrdinal: number;
    startIndex: number;
    endIndex: number;
    isCompressed: boolean;
    hasIdentityConflict: boolean;
    items: Array<{
      toolCallId: string;
      toolName: string;
      toolArgs: Record<string, unknown>;
      toolCall: ToolCallRecord;
      toolOutputs: Array<{ value: T; message: AiMessage; index: number }>;
      rawOutputs: string[];
    }>;
  };

  const groups: MutableGroup[] = [];
  type MutableItem = MutableGroup['items'][number];
  const activeToolCalls = new Map<string, { group: MutableGroup; item: MutableItem }>();
  const runToolCallOwners = new Map<string, MutableGroup>();
  let currentRunOrdinal = 0;
  for (const entry of entries) {
    const { message } = entry;
    if (message.role === 'user' && message.type === 'user_input') {
      currentRunOrdinal += 1;
      activeToolCalls.clear();
      runToolCallOwners.clear();
    }
    if (message.role === 'assistant') {
      // 下一次 assistant 决策或正文代表新边界；迟到结果不能补全前一次调用。
      activeToolCalls.clear();
    }

    if (message.role === 'assistant' && message.type === 'tool_calls') {
      const toolCalls = getToolCalls(message);
      if (toolCalls.length === 0) {
        continue;
      }
      const itemList: MutableItem[] = toolCalls.map((toolCall) => {
        const toolName =
          typeof toolCall.function?.name === 'string' && toolCall.function.name.trim().length > 0
            ? toolCall.function.name
            : 'unknown_tool';
        return {
          toolCallId: toolCall.id,
          toolName,
          toolArgs: safeParseArgs(toolCall.function?.arguments),
          toolCall,
          toolOutputs: [],
          rawOutputs: [],
        };
      });

      const group: MutableGroup = {
        anchorId: message.id,
        assistantState: entry.value,
        assistantMessage: message,
        assistantIndex: entry.originalIndex,
        toolOutputs: [],
        sourceMessageIds: new Set<string>(message.id ? [message.id] : []),
        runOrdinal: currentRunOrdinal,
        startIndex: entry.originalIndex,
        endIndex: entry.originalIndex,
        isCompressed: false,
        hasIdentityConflict: false,
        items: itemList,
      };

      groups.push(group);
      for (const item of itemList) {
        const previousOwner = runToolCallOwners.get(item.toolCallId);
        if (previousOwner) {
          // 同轮 ID 重用无法唯一归属；两组都不能作为完整 replay 或压缩单元。
          previousOwner.hasIdentityConflict = true;
          group.hasIdentityConflict = true;
        }
        runToolCallOwners.set(item.toolCallId, group);
        activeToolCalls.set(item.toolCallId, { group, item });
      }
      continue;
    }

    if (message.role !== 'tool' || message.type !== 'tool_output') {
      continue;
    }

    const toolCallId = message.metadata?.tool_call_id;
    if (typeof toolCallId !== 'string' || toolCallId.trim().length === 0) {
      continue;
    }

    const pairing = activeToolCalls.get(toolCallId);
    if (!pairing) {
      continue;
    }

    const { group, item } = pairing;
    if (
      options.maxPairingDistance !== undefined &&
      entry.originalIndex - group.assistantIndex - group.toolOutputs.length > options.maxPairingDistance
    ) {
      continue;
    }
    // AiMessage 低层合同允许省略 tool_name；存在时才校验，身份始终由 call_id 决定。
    if (message.metadata?.tool_name !== undefined && message.metadata.tool_name !== item.toolName) {
      group.hasIdentityConflict = true;
    }

    const outputEntry = { value: entry.value, message, index: entry.originalIndex };
    item.toolOutputs.push(outputEntry);
    item.rawOutputs.push(getRawOutput(message));
    group.toolOutputs.push(outputEntry);
    if (message.id) {
      group.sourceMessageIds.add(message.id);
    }
    group.endIndex = Math.max(group.endIndex, entry.originalIndex);
  }

  return groups.map((group) => {
    // entries 已按原始顺序遍历，无需重新排序；每个结果只做一次 Map 查找。
    const outputs = group.toolOutputs;
    const items = group.items.map((item) => {
      const itemOutputs = item.toolOutputs;
      return {
        toolCallId: item.toolCallId,
        toolName: item.toolName,
        toolArgs: item.toolArgs,
        toolCall: item.toolCall,
        toolOutputs: itemOutputs.map((output) => output.value),
        toolOutputMessages: itemOutputs.map((output) => output.message),
        rawOutputs: [...item.rawOutputs],
      };
    });

    return {
      anchorId: group.anchorId,
      runOrdinal: group.runOrdinal,
      assistantState: group.assistantState,
      assistantMessage: group.assistantMessage,
      assistantIndex: group.assistantIndex,
      toolOutputs: outputs.map((output) => output.value),
      toolOutputMessages: outputs.map((output) => output.message),
      toolOutputIndexes: outputs.map((output) => output.index),
      toolCallIds: items.map((item) => item.toolCallId),
      toolNames: items.map((item) => item.toolName),
      sourceMessageIds: Array.from(group.sourceMessageIds),
      messageIndexes: [group.assistantIndex, ...outputs.map((output) => output.index)],
      startIndex: group.startIndex,
      endIndex: group.endIndex,
      isComplete: !group.hasIdentityConflict && items.every((item) => item.toolOutputs.length === 1),
      isCompressed: group.isCompressed,
      items,
      messages: [group.assistantState, ...outputs.map((output) => output.value)],
    };
  });
}

export function collectToolInteractionGroups<T extends MessageProcessingState>(
  states: T[],
): ToolInteractionGroup<T>[] {
  const entries: IndexedEntry<T>[] = states.map((value, index) => ({
    value,
    originalIndex: index,
    message: value.message,
  }));

  return buildToolInteractionGroups(entries);
}

export function buildToolInteractionGroupsFromMessages(
  messages: AiMessage[],
  options: {
    startIndex?: number;
    endIndexExclusive?: number;
  } = {},
): ToolInteractionGroup<AiMessage>[] {
  const startIndex = Math.max(0, options.startIndex ?? 0);
  const endIndexExclusive = Math.min(messages.length, options.endIndexExclusive ?? messages.length);
  const entries = messages.slice(startIndex, endIndexExclusive).map((message, orderIndex) => ({
    value: message,
    originalIndex: startIndex + orderIndex,
    message,
  }));
  return buildToolInteractionGroups(entries);
}

export function buildToolInteractionGroupsFromStates(
  states: MessageProcessingState[],
  options: ToolInteractionGroupBuildOptions = {},
): ToolInteractionGroup<MessageProcessingState>[] {
  const normalizedPositions = getNormalizedStatePositions(states);
  const entries = states.map((state, orderIndex) => ({
    value: state,
    originalIndex: normalizedPositions[orderIndex],
    message: state.message,
  }));
  return buildToolInteractionGroups(entries, options);
}

export function findCurrentRunStartIndex(messages: AiMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === 'user' && message.type === 'user_input') {
      return index;
    }
  }
  return messages.length;
}

export function findLastUserInputOriginalIndex(states: MessageProcessingState[]): number | null {
  const normalizedPositions = getNormalizedStatePositions(states);
  let result: number | null = null;
  for (let orderIndex = 0; orderIndex < states.length; orderIndex += 1) {
    const state = states[orderIndex];
    if (state.message.role !== 'user' || state.message.type !== 'user_input') {
      continue;
    }
    const currentIndex = normalizedPositions[orderIndex];
    result = result === null ? currentIndex : Math.max(result, currentIndex);
  }
  return result;
}

function getNormalizedStatePositions(states: MessageProcessingState[]): number[] {
  const positions: number[] = [];
  let lastPosition = -1;
  for (let orderIndex = 0; orderIndex < states.length; orderIndex += 1) {
    const state = states[orderIndex];
    const rawPosition = typeof state.originalIndex === 'number' ? state.originalIndex : orderIndex;
    if (rawPosition > lastPosition) {
      positions.push(rawPosition);
      lastPosition = rawPosition;
      continue;
    }
    const nextPosition = lastPosition + 1;
    positions.push(nextPosition);
    lastPosition = nextPosition;
  }
  return positions;
}
