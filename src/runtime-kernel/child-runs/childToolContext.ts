import type { RuntimeEvent } from '../../contracts';
import {
  ensureToolContextRuntimeCapability,
  stripRuntimeReservedToolContextPatch,
} from '../tools/toolContextRuntime';
import type { ChildRunParentContext, ChildRunToolContext } from './types';

export function createChildRunToolContext(params: {
  parentToolContext: ChildRunParentContext;
  internalConversationId: string;
  turnId: string;
  runId: string;
  parentRunId?: string;
  seedHistory: ReadonlyArray<RuntimeEvent>;
  abortSignal?: AbortSignal;
}): ChildRunToolContext {
  const inheritedConversationId =
    typeof params.parentToolContext.conversationId === 'string' && params.parentToolContext.conversationId.trim().length > 0
      ? params.parentToolContext.conversationId.trim()
      : undefined;
  const inheritedContext = stripRuntimeReservedToolContextPatch(params.parentToolContext);
  const childToolContext: ChildRunToolContext = {
    ...inheritedContext,
    deepSearchDepth:
      (typeof params.parentToolContext.deepSearchDepth === 'number' ? params.parentToolContext.deepSearchDepth : 0) + 1,
    abortSignal: params.abortSignal ?? params.parentToolContext.abortSignal,
  };

  ensureToolContextRuntimeCapability({
    context: childToolContext,
    persistedHistory: params.seedHistory,
    workingHistory: params.seedHistory,
    executionMeta: {
      conversationId: inheritedConversationId ?? params.internalConversationId,
      turnId: params.turnId,
      runId: params.runId,
      parentRunId: params.parentRunId,
    },
  });

  return childToolContext;
}
