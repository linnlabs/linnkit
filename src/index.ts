export * as ports from './ports';
export * as runtimeKernel from './runtime-kernel';
export * as testkit from './testkit';
export * as contracts from './contracts';
export { generateMessageId, generateRunId } from './shared/ids';
export { withLLMTelemetryContext } from './shared/llmTelemetryContext';
export type { LlmCallTelemetry } from './shared/llmTelemetryContext';

import * as contextManager from './context-manager';
import * as llmTelemetryContext from './shared/llmTelemetryContext';
import * as llmAuditRecorder from './shared/llmAuditRecorder';

export const linnkitCompat = {
  contextManager,
  llmTelemetryContext,
  llmAuditRecorder,
} as const;
