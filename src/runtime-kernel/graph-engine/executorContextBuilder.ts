import type { AgentInvocationRequest } from '../../ports';
import type { AiMessage, RuntimeEvent } from '../../contracts';

export interface GraphExecutorSummarizationCallbacks {
  onSummarizationStart?: () => void;
  onSummarizationEnd?: (summaryInfo: unknown) => void;
}

export interface PendingContextRuntimeEvent extends Record<string, unknown> {
  id: string;
  type: string;
}

export interface GraphExecutorContextBuildInput {
  request: AgentInvocationRequest;
  history: RuntimeEvent[];
  summarizationCallbacks?: GraphExecutorSummarizationCallbacks;
  modelId: string;
  signal?: AbortSignal;
}

export interface GraphExecutorContextBuildOutput {
  mode: 'agent' | 'chat';
  llmMessages: AiMessage[];
  summaryEvents: PendingContextRuntimeEvent[];
}

export interface GraphExecutorContextBuilder {
  build(input: GraphExecutorContextBuildInput): Promise<GraphExecutorContextBuildOutput>;
}
