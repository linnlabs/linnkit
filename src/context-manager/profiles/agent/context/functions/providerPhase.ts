import { AgentBuildPhase } from '../config';

const PROVIDER_PHASE_BY_NAME: Readonly<Record<string, AgentBuildPhase>> = {
  AgentCoreContextProvider: AgentBuildPhase.CORE_CONTEXT,
  CoreContextProvider: AgentBuildPhase.CORE_CONTEXT,
  AgentWorkingMemoryProvider: AgentBuildPhase.WORKING_MEMORY,
  WorkingMemoryProvider: AgentBuildPhase.WORKING_MEMORY,
  CheckpointSummarizationProvider: AgentBuildPhase.SUMMARIZATION,
  SummarizationProvider: AgentBuildPhase.SUMMARIZATION,
};

export function getAgentBuildPhaseByProviderName(providerName: string): AgentBuildPhase | null {
  return PROVIDER_PHASE_BY_NAME[providerName] ?? null;
}
