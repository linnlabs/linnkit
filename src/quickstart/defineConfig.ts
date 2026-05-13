import type { AgentAiEngine } from '../ports';
import type { DefinedAgent, LinnkitQuickstartConfig } from './types';

function isAgentAiEngine(value: unknown): value is AgentAiEngine {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { chatCompletion?: unknown }).chatCompletion === 'function' &&
    typeof (value as { chatCompletionStream?: unknown }).chatCompletionStream === 'function'
  );
}

function isLlmFactory(value: unknown): value is () => AgentAiEngine | Promise<AgentAiEngine> {
  return typeof value === 'function';
}

function validateAgents(agents: readonly DefinedAgent[]): void {
  if (!Array.isArray(agents) || agents.length === 0) {
    throw new Error('[linnkit] defineConfig requires at least one agent.');
  }

  const seen = new Set<string>();
  for (const agent of agents) {
    const id = agent?.spec?.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('[linnkit] defineConfig received an agent without spec.id.');
    }
    if (seen.has(id)) {
      throw new Error(`[linnkit] duplicate agent id in config: ${id}`);
    }
    seen.add(id);
  }
}

/**
 * Quickstart 配置构造器。
 *
 * 中文备注：
 * - 只做轻量运行时校验，避免 CLI 加载坏 config 后给出晦涩堆栈；
 * - 不接管生产 host 的完整配置系统。
 */
export function defineConfig(config: LinnkitQuickstartConfig): LinnkitQuickstartConfig {
  validateAgents(config.agents);
  if (!isAgentAiEngine(config.llm) && !isLlmFactory(config.llm)) {
    throw new Error('[linnkit] defineConfig requires llm to be an AgentAiEngine or a factory.');
  }

  return {
    agents: [...config.agents],
    llm: config.llm,
    defaultModelId: config.defaultModelId,
  };
}

export async function resolveConfiguredLlm(
  config: LinnkitQuickstartConfig,
): Promise<AgentAiEngine> {
  const llm = typeof config.llm === 'function' ? await config.llm() : config.llm;
  if (!isAgentAiEngine(llm)) {
    throw new Error('[linnkit] configured llm factory did not return an AgentAiEngine.');
  }
  return llm;
}
