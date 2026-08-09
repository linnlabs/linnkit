import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { LinnkitQuickstartConfig } from '../quickstart';
import { defineConfig } from '../quickstart';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readDefaultExport(moduleValue: unknown): unknown {
  if (isRecord(moduleValue) && 'default' in moduleValue) {
    return moduleValue.default;
  }
  return moduleValue;
}

function isConfiguredLlm(value: unknown): value is LinnkitQuickstartConfig['llm'] {
  if (typeof value === 'function') {
    return true;
  }
  return (
    isRecord(value) &&
    typeof value.chatCompletion === 'function' &&
    typeof value.chatCompletionStream === 'function'
  );
}

function readConfig(value: Record<string, unknown>, absolutePath: string): LinnkitQuickstartConfig {
  const agents = value.agents;
  if (!Array.isArray(agents)) {
    throw new Error(`[linnkit] config.agents must be an array: ${absolutePath}`);
  }
  const llm = value.llm;
  if (!isConfiguredLlm(llm)) {
    throw new Error(`[linnkit] config.llm must be an AgentAiEngine or factory: ${absolutePath}`);
  }
  const defaultModelId = value.defaultModelId;
  if (defaultModelId !== undefined && typeof defaultModelId !== 'string') {
    throw new Error(`[linnkit] config.defaultModelId must be a string when provided: ${absolutePath}`);
  }
  return {
    agents: agents as LinnkitQuickstartConfig['agents'],
    llm,
    defaultModelId,
  };
}

export async function loadConfig(
  configPath: string,
  cwd: string,
): Promise<LinnkitQuickstartConfig> {
  const absolutePath = resolve(cwd, configPath);
  const moduleUrl = pathToFileURL(absolutePath);
  moduleUrl.searchParams.set('t', String(Date.now()));
  const loaded = await import(moduleUrl.href);
  const config = readDefaultExport(loaded);
  if (!isRecord(config)) {
    throw new Error(`[linnkit] config must export an object: ${absolutePath}`);
  }
  return defineConfig(readConfig(config, absolutePath));
}
