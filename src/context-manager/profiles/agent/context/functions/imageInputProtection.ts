import type { AiMessage } from '../../../../../contracts';
import type { MessageProcessingState } from '../providers/base';
import {
  buildToolInteractionGroupsFromMessages,
  buildToolInteractionGroupsFromStates,
} from '../../utils/toolInteractionGroup';

export interface ProtectedMessageRange {
  readonly startIndex: number;
  readonly endIndex: number;
}

export function hasImageInput(message: AiMessage): boolean {
  return 'attachments' in message
    && Array.isArray(message.attachments)
    && message.attachments.some(attachment => attachment.kind === 'image');
}

/**
 * 图片不能被文本摘要覆盖，因此先把它所属的会话轮次和工具交互组提升为原子保护区段。
 */
export function buildImageProtectedMessageRanges(
  messages: readonly AiMessage[],
): ProtectedMessageRange[] {
  const ranges: ProtectedMessageRange[] = [];

  for (let startIndex = 0; startIndex < messages.length; startIndex += 1) {
    if (messages[startIndex].role !== 'user' || messages[startIndex].type !== 'user_input') {
      continue;
    }
    let endIndex = messages.length - 1;
    for (let index = startIndex + 1; index < messages.length; index += 1) {
      if (messages[index].role === 'user' && messages[index].type === 'user_input') {
        endIndex = index - 1;
        break;
      }
    }
    if (messages.slice(startIndex, endIndex + 1).some(hasImageInput)) {
      ranges.push({ startIndex, endIndex });
    }
  }

  for (const group of buildToolInteractionGroupsFromMessages([...messages])) {
    if (group.messages.some(hasImageInput)) {
      ranges.push({ startIndex: group.startIndex, endIndex: group.endIndex });
    }
  }

  messages.forEach((message, index) => {
    if (hasImageInput(message)) {
      ranges.push({ startIndex: index, endIndex: index });
    }
  });

  return mergeRanges(ranges);
}

export function collectImageProtectedStateIndexes(
  states: readonly MessageProcessingState[],
): number[] {
  const protectedStates = new Set<MessageProcessingState>(
    states.filter(state => hasImageInput(state.message)),
  );
  for (const group of buildToolInteractionGroupsFromStates([...states])) {
    if (group.messages.some(state => hasImageInput(state.message))) {
      for (const state of group.messages) protectedStates.add(state);
    }
  }
  return states.flatMap((state, index) => protectedStates.has(state) ? [index] : []);
}

function mergeRanges(ranges: readonly ProtectedMessageRange[]): ProtectedMessageRange[] {
  const sorted = [...ranges].sort((left, right) =>
    left.startIndex - right.startIndex || left.endIndex - right.endIndex
  );
  const merged: ProtectedMessageRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || range.startIndex > previous.endIndex + 1) {
      merged.push(range);
      continue;
    }
    merged[merged.length - 1] = {
      startIndex: previous.startIndex,
      endIndex: Math.max(previous.endIndex, range.endIndex),
    };
  }
  return merged;
}
