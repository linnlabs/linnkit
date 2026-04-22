import type { ToolContextConversationView } from './conversationView';
import type { ToolExecutionContext } from './toolExecutionContext';
import type { RuntimeEvent } from '../../contracts';

type RuntimeEventSource = () => ReadonlyArray<RuntimeEvent>;

export interface ToolContextExecutionMeta {
  conversationId?: string;
  turnId?: string;
  parentToolCallId?: string;
  citationOffset?: number;
}

export interface ToolContextRuntimeBinding {
  readonly conversationView: ToolContextConversationView;
  getWorkingHistoryEvents(): ReadonlyArray<RuntimeEvent>;
  getPersistedHistoryEvents(): ReadonlyArray<RuntimeEvent>;
  setWorkingHistorySource(source: ReadonlyArray<RuntimeEvent> | RuntimeEventSource): void;
  setPersistedHistorySource(source: ReadonlyArray<RuntimeEvent> | RuntimeEventSource): void;
  bindExecutionMeta(meta: ToolContextExecutionMeta): void;
  readExecutionMeta(): Readonly<ToolContextExecutionMeta>;
}

export const TOOL_CONTEXT_RUNTIME_RESERVED_KEYS = [
  'conversationView',
  'getConversationHistoryEvents',
  'conversationId',
  'turnId',
  'parentToolCallId',
  'citationOffset',
] as const;

const TOOL_CONTEXT_RUNTIME_BINDING_KEY = '__tool_context_runtime_binding__';

function toEventSource(source: ReadonlyArray<RuntimeEvent> | RuntimeEventSource): RuntimeEventSource {
  if (typeof source === 'function') {
    return source;
  }
  return () => source;
}

function syncExecutionMetaToContext(context: ToolExecutionContext, meta: ToolContextExecutionMeta): void {
  if (typeof meta.conversationId === 'string') {
    context.conversationId = meta.conversationId;
  }
  if (typeof meta.turnId === 'string') {
    context.turnId = meta.turnId;
  }
  if (typeof meta.parentToolCallId === 'string') {
    context.parentToolCallId = meta.parentToolCallId;
  }
  if (typeof meta.citationOffset === 'number' && Number.isFinite(meta.citationOffset)) {
    context.citationOffset = meta.citationOffset;
  }
}

function createRuntimeBinding(params: {
  context: ToolExecutionContext;
  persistedHistory: ReadonlyArray<RuntimeEvent> | RuntimeEventSource;
  workingHistory: ReadonlyArray<RuntimeEvent> | RuntimeEventSource;
  executionMeta?: ToolContextExecutionMeta;
}): ToolContextRuntimeBinding {
  let persistedHistorySource = toEventSource(params.persistedHistory);
  let workingHistorySource = toEventSource(params.workingHistory);
  let executionMeta: ToolContextExecutionMeta = {};

  const conversationView: ToolContextConversationView = {
    getWorkingHistoryEvents: () => workingHistorySource(),
    getPersistedHistoryEvents: () => persistedHistorySource(),
  };

  const binding: ToolContextRuntimeBinding = {
    conversationView,
    getWorkingHistoryEvents: () => conversationView.getWorkingHistoryEvents(),
    getPersistedHistoryEvents: () => conversationView.getPersistedHistoryEvents(),
    setWorkingHistorySource: (source) => {
      workingHistorySource = toEventSource(source);
    },
    setPersistedHistorySource: (source) => {
      persistedHistorySource = toEventSource(source);
    },
    bindExecutionMeta: (meta) => {
      executionMeta = {
        ...executionMeta,
        ...meta,
      };
      syncExecutionMetaToContext(params.context, executionMeta);
    },
    readExecutionMeta: () => ({ ...executionMeta }),
  };

  if (params.executionMeta) {
    binding.bindExecutionMeta(params.executionMeta);
  }

  return binding;
}

function readBinding(context: ToolExecutionContext): ToolContextRuntimeBinding | undefined {
  const maybeBinding = (context as Record<string, unknown>)[TOOL_CONTEXT_RUNTIME_BINDING_KEY];
  return isRuntimeBinding(maybeBinding) ? maybeBinding : undefined;
}

function isRuntimeBinding(value: unknown): value is ToolContextRuntimeBinding {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return (
    typeof (value as ToolContextRuntimeBinding).getWorkingHistoryEvents === 'function' &&
    typeof (value as ToolContextRuntimeBinding).getPersistedHistoryEvents === 'function' &&
    typeof (value as ToolContextRuntimeBinding).setWorkingHistorySource === 'function' &&
    typeof (value as ToolContextRuntimeBinding).setPersistedHistorySource === 'function' &&
    typeof (value as ToolContextRuntimeBinding).bindExecutionMeta === 'function' &&
    typeof (value as ToolContextRuntimeBinding).readExecutionMeta === 'function'
  );
}

function pickDefaultHistorySource(params: {
  preferred?: ReadonlyArray<RuntimeEvent> | RuntimeEventSource;
  fallback?: () => ReadonlyArray<RuntimeEvent>;
}): ReadonlyArray<RuntimeEvent> | RuntimeEventSource {
  if (params.preferred !== undefined) {
    return params.preferred;
  }
  if (params.fallback) {
    return params.fallback;
  }
  return [];
}

function exposeCompatibilitySurface(context: ToolExecutionContext, binding: ToolContextRuntimeBinding): void {
  context.conversationView = binding.conversationView;
  context.getConversationHistoryEvents = () => binding.getWorkingHistoryEvents();
}

export function ensureToolContextRuntimeCapability(params: {
  context: ToolExecutionContext;
  persistedHistory?: ReadonlyArray<RuntimeEvent> | RuntimeEventSource;
  workingHistory?: ReadonlyArray<RuntimeEvent> | RuntimeEventSource;
  executionMeta?: ToolContextExecutionMeta;
}): ToolContextRuntimeBinding {
  let binding = readBinding(params.context);

  if (!binding) {
    const existingConversationView = params.context.conversationView;
    const existingHistoryGetter = params.context.getConversationHistoryEvents;
    binding = createRuntimeBinding({
      context: params.context,
      persistedHistory: pickDefaultHistorySource({
        preferred: params.persistedHistory,
        fallback: () =>
          existingConversationView?.getPersistedHistoryEvents() ??
          existingHistoryGetter?.() ??
          [],
      }),
      workingHistory: pickDefaultHistorySource({
        preferred: params.workingHistory,
        fallback: () =>
          existingConversationView?.getWorkingHistoryEvents() ??
          existingHistoryGetter?.() ??
          [],
      }),
      executionMeta: params.executionMeta,
    });

    Object.defineProperty(params.context, TOOL_CONTEXT_RUNTIME_BINDING_KEY, {
      value: binding,
      enumerable: false,
      configurable: true,
      writable: false,
    });
  } else {
    if (params.persistedHistory !== undefined) {
      binding.setPersistedHistorySource(params.persistedHistory);
    }
    if (params.workingHistory !== undefined) {
      binding.setWorkingHistorySource(params.workingHistory);
    }
    if (params.executionMeta) {
      binding.bindExecutionMeta(params.executionMeta);
    }
  }

  exposeCompatibilitySurface(params.context, binding);
  return binding;
}

export function getToolContextRuntimeBinding(context: ToolExecutionContext): ToolContextRuntimeBinding | undefined {
  return readBinding(context);
}

export function readToolContextWorkingHistory(context: ToolExecutionContext): ReadonlyArray<RuntimeEvent> {
  if (context.conversationView) {
    return context.conversationView.getWorkingHistoryEvents();
  }
  if (typeof context.getConversationHistoryEvents === 'function') {
    return context.getConversationHistoryEvents() ?? [];
  }
  return [];
}

export function readToolContextPersistedHistory(context: ToolExecutionContext): ReadonlyArray<RuntimeEvent> {
  if (context.conversationView) {
    return context.conversationView.getPersistedHistoryEvents();
  }
  if (typeof context.getConversationHistoryEvents === 'function') {
    return context.getConversationHistoryEvents() ?? [];
  }
  return [];
}

export function stripRuntimeReservedToolContextPatch(
  patch: Partial<ToolExecutionContext> | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!patch) {
    return {};
  }

  const nextPatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if ((TOOL_CONTEXT_RUNTIME_RESERVED_KEYS as readonly string[]).includes(key)) {
      continue;
    }
    nextPatch[key] = value;
  }
  return nextPatch;
}
