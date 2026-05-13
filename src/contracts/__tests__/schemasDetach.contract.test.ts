import { existsSync, readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import * as agentContracts from '../index';

const movedRuntimeExports = [
  'AiMessage',
  'RuntimeEvent',
  'createFinalAnswerEvent',
  'createErrorEvent',
  'validateRuntimeEvent',
] as const;

const movedExecutionAndSseExports = [
  'DEFAULT_MAX_STEPS',
  'EventEnvelope',
  'ExecutionTraceContext',
  'SSEEvent',
  'SSEThoughtEvent',
  'SSEToolCallDecisionEvent',
  'SSEToolProcessEvent',
  'SSEToolOutputEvent',
  'SSEFinalAnswerChunkEvent',
  'SSEFinalAnswerEvent',
  'SSERequiresUserInteractionEvent',
  'SSEErrorEvent',
  'createSSEThoughtEvent',
  'createSSEToolCallDecisionEvent',
  'createSSEToolProcessEvent',
  'createSSEToolOutputEvent',
  'createSSEFinalAnswerChunkEvent',
  'createSSEFinalAnswerEvent',
  'createSSERequiresUserInteractionEvent',
  'createSSEErrorEvent',
] as const;

function walkProductionTypeScriptFiles(dir: URL): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const entryPath = new URL(`${entry}`, dir);
    const stat = statSync(entryPath);
    if (stat.isDirectory()) {
      if (entry === '__tests__' || entry === 'docs') {
        continue;
      }
      files.push(...walkProductionTypeScriptFiles(new URL(`${entry}/`, dir)));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) {
      continue;
    }
    files.push(entryPath.pathname);
  }
  return files;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function loadHostSchemasPackage(): Promise<Record<string, unknown> | null> {
  if (!existsSync(new URL('../../../../../packages/schemas/package.json', import.meta.url))) {
    return null;
  }

  const imported: unknown = await import('@app/schemas');
  if (!isRecord(imported)) {
    throw new Error('@app/schemas must import to an object-like module namespace.');
  }
  return imported;
}

describe('contracts migration boundary', () => {
  it('keeps moved A-class runtime exports on src/agent/contracts', () => {
    for (const exportName of movedRuntimeExports) {
      expect(agentContracts).toHaveProperty(exportName);
    }
  });

  it('does not continue exposing moved A-class runtime exports from @app/schemas root', async () => {
    const appSchemas = await loadHostSchemasPackage();
    if (!appSchemas) {
      expect(appSchemas).toBeNull();
      return;
    }

    for (const exportName of movedRuntimeExports) {
      expect(appSchemas).not.toHaveProperty(exportName);
    }
  });

  it('removes legacy A-class subpath exports from @app/schemas package metadata', () => {
    const packageJsonUrl = new URL('../../../../../packages/schemas/package.json', import.meta.url);
    if (!existsSync(packageJsonUrl)) {
      expect(existsSync(packageJsonUrl)).toBe(false);
      return;
    }

    const packageJson = JSON.parse(
      readFileSync(packageJsonUrl, 'utf8'),
    ) as {
      exports?: Record<string, unknown>;
    };

    expect(packageJson.exports).toBeDefined();
    expect(packageJson.exports).not.toHaveProperty('./runtime-events');
    expect(packageJson.exports).not.toHaveProperty('./domain-models');
    expect(packageJson.exports).not.toHaveProperty('./view-models');
    expect(packageJson.exports).not.toHaveProperty('./runtime-models');
    expect(packageJson.exports).not.toHaveProperty('./sse-events');
  });

  it('removes legacy A-class source files and their derived dead surfaces from packages/schemas', () => {
    const schemasIndexUrl = new URL('../../../../../packages/schemas/src/index.ts', import.meta.url);
    if (!existsSync(schemasIndexUrl)) {
      expect(existsSync(schemasIndexUrl)).toBe(false);
      return;
    }

    expect(
      readFileSync(schemasIndexUrl, 'utf8'),
    ).not.toContain("./view-models");
    expect(
      readFileSync(schemasIndexUrl, 'utf8'),
    ).not.toContain("./runtime-models");

    expect(
      existsSync(new URL('../../../../../packages/schemas/src/domain-models.ts', import.meta.url)),
    ).toBe(false);
    expect(
      existsSync(new URL('../../../../../packages/schemas/src/runtime-events.ts', import.meta.url)),
    ).toBe(false);
    expect(
      existsSync(new URL('../../../../../packages/schemas/src/view-models.ts', import.meta.url)),
    ).toBe(false);
    expect(
      existsSync(new URL('../../../../../packages/schemas/src/runtime-models.ts', import.meta.url)),
    ).toBe(false);
  });

  it('keeps moved execution and SSE protocol exports on linnkit/contracts', () => {
    for (const exportName of movedExecutionAndSseExports) {
      expect(agentContracts).toHaveProperty(exportName);
    }
  });

  it('does not expose moved execution and SSE protocol exports from @app/schemas root', async () => {
    const appSchemas = await loadHostSchemasPackage();
    if (!appSchemas) {
      expect(appSchemas).toBeNull();
      return;
    }

    for (const exportName of movedExecutionAndSseExports) {
      expect(appSchemas).not.toHaveProperty(exportName);
    }
  });

  it('keeps linnkit production code detached from @app/schemas', () => {
    const linnkitSrcRoot = new URL('../../..', import.meta.url);
    const offenders = walkProductionTypeScriptFiles(linnkitSrcRoot)
      .filter((filePath) => readFileSync(filePath, 'utf8').includes('@app/schemas'))
      .map((filePath) => path.relative(linnkitSrcRoot.pathname, filePath))
      .sort();

    expect(offenders).toEqual([]);
  });
});
