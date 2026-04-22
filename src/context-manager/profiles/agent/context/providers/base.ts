import type { AgentContextBuilderConfig } from '../config';
import {
  BaseContextProvider as SharedBaseContextProvider,
  type IContextProvider as SharedIContextProvider,
  type MessageProcessingState,
  type ProviderContext as SharedProviderContext,
  type ProviderResult,
  type SummarizationCallbacks,
} from '../../../../shared/providers/base';

export type {
  MessageProcessingState,
  ProviderResult,
  SummarizationCallbacks,
} from '../../../../shared/providers/base';

export type ProviderContext = SharedProviderContext<AgentContextBuilderConfig>;
export interface IContextProvider extends SharedIContextProvider<AgentContextBuilderConfig> {}
export abstract class BaseContextProvider
  extends SharedBaseContextProvider<AgentContextBuilderConfig>
  implements IContextProvider {}
