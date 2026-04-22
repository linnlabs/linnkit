import type { ContextBuilderConfig } from '../config';
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

export type ProviderContext = SharedProviderContext<ContextBuilderConfig>;
export interface IContextProvider extends SharedIContextProvider<ContextBuilderConfig> {}
export abstract class BaseContextProvider
  extends SharedBaseContextProvider<ContextBuilderConfig>
  implements IContextProvider {}
