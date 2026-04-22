export { ContextManager } from './ContextManager';
export type { ContextBuildResult } from './ContextManager';

export {
  CONTEXT_BUILDER_CONFIG,
  BuildPhase,
  MessagePriority,
  createContextBuilderConfig,
  validateConfig,
} from './config';
export type { ContextBuildStats } from './config';

export * from './providers';
