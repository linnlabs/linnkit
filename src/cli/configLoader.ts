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
  return defineConfig(config as LinnkitQuickstartConfig);
}
