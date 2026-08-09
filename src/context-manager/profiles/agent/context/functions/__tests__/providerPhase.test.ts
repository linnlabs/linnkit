import { describe, expect, it } from 'vitest';

import { AgentBuildPhase } from '../../config';
import { getAgentBuildPhaseByProviderName } from '../providerPhase';

describe('providerPhase.getAgentBuildPhaseByProviderName', () => {
  it('映射真实 agent provider 名称到构建阶段', () => {
    expect(getAgentBuildPhaseByProviderName('AgentCoreContextProvider')).toBe(AgentBuildPhase.CORE_CONTEXT);
    expect(getAgentBuildPhaseByProviderName('AgentWorkingMemoryProvider')).toBe(AgentBuildPhase.WORKING_MEMORY);
    expect(getAgentBuildPhaseByProviderName('CheckpointSummarizationProvider')).toBe(AgentBuildPhase.SUMMARIZATION);
    expect(getAgentBuildPhaseByProviderName('SummarizationProvider')).toBe(AgentBuildPhase.SUMMARIZATION);
  });

  it('保留旧 provider 名称兼容', () => {
    expect(getAgentBuildPhaseByProviderName('CoreContextProvider')).toBe(AgentBuildPhase.CORE_CONTEXT);
    expect(getAgentBuildPhaseByProviderName('WorkingMemoryProvider')).toBe(AgentBuildPhase.WORKING_MEMORY);
  });

  it('未知 provider 返回 null，避免伪造阶段统计', () => {
    expect(getAgentBuildPhaseByProviderName('HostCustomProvider')).toBeNull();
  });
});
