/**
 * @file src/agent/context-manager/profiles/chat/context/providers/index.ts
 * @description Chat profile provider 协议与实现导出
 */

export * from './base';

export { CoreContextProvider } from './CoreContextProvider';
export { WorkingMemoryProvider } from './WorkingMemoryProvider';
export { SummarizationProvider } from '../../../../shared/providers';
import { ContextProviderRegistry as SharedContextProviderRegistry } from '../../../../shared/providers';
import type { ContextBuilderConfig } from '../config';

export class ContextProviderRegistry extends SharedContextProviderRegistry<ContextBuilderConfig> {}
