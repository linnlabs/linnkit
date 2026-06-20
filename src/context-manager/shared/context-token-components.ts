import type {
  AiMessage,
  ContextTokenComponent,
  ContextTokenComponentKind,
  PersistentMetadata,
} from '../../contracts';
import type { MessageProcessingState } from './providers/base';

function isKept(action: MessageProcessingState['action']): boolean {
  return action.startsWith('keep_');
}

function classifyMessage(message: AiMessage): ContextTokenComponentKind {
  const metadata = message.metadata;
  if (metadata?.fenceKind) {
    return 'fence';
  }
  if (message.type === 'history_summary' || metadata?.messageType === 'summary') {
    return 'history-summary';
  }
  if (
    message.role === 'tool'
    || message.type === 'tool_output'
    || message.type === 'tool_calls'
    || message.type === 'tool_code'
  ) {
    return 'tool';
  }
  if (
    message.type === 'context_injection'
    || message.type === 'context_before'
    || message.type === 'context_after'
  ) {
    return 'context-injection';
  }
  if (message.role === 'system') {
    return 'system';
  }
  if (message.role === 'user') {
    return 'user';
  }
  if (message.role === 'assistant') {
    return 'assistant';
  }
  return 'other';
}

function buildLabel(message: AiMessage, metadata: PersistentMetadata | undefined): string {
  return metadata?.fenceKind
    ?? metadata?.tool_name
    ?? metadata?.messageType
    ?? message.type;
}

function buildTruncationFields(state: MessageProcessingState): Pick<
  ContextTokenComponent,
  'truncatedAtExecution' | 'originalTokensEstimate' | 'droppedTokensEstimate'
> {
  const truncation = state.message.metadata?.observationTruncation;
  if (!truncation || truncation.originalChars <= truncation.previewChars || truncation.previewChars === 0) {
    return {};
  }

  // 执行期只保存字符计量；这里用 build 期已校准的 preview token 按字符比例反推原始 token。
  const originalTokensEstimate = Math.max(
    state.tokens,
    Math.ceil((state.tokens * truncation.originalChars) / truncation.previewChars),
  );
  const droppedTokensEstimate = Math.max(0, originalTokensEstimate - state.tokens);

  return {
    truncatedAtExecution: true,
    originalTokensEstimate,
    droppedTokensEstimate,
  };
}

export function buildContextTokenComponents(
  states: ReadonlyArray<MessageProcessingState>,
): ContextTokenComponent[] {
  return states.map((state) => ({
    componentId: `${state.originalIndex}:${state.message.id}`,
    kind: classifyMessage(state.message),
    tokens: state.tokens,
    source: 'local-estimate',
    confidence: 'estimate',
    label: buildLabel(state.message, state.message.metadata),
    messageId: state.message.id,
    role: state.message.role,
    action: state.action,
    kept: isKept(state.action),
    ...buildTruncationFields(state),
  }));
}
