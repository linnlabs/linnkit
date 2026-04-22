import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const filePath = resolve(testDir, relativePath);
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${relativePath} must parse to a JSON object.`);
  }
  return parsed;
}

describe('agent dry-run workspace skeleton', () => {
  it('defines a dedicated dry-run package manifest', async () => {
    const manifest = await readJson('../../../packages/agent-engine-dryrun/package.json');

    expect(manifest.name).toBe('linnkit-dryrun');
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe('module');

    const scriptsField = manifest.scripts;
    if (!isRecord(scriptsField)) {
      throw new Error('packages/agent-engine-dryrun/package.json must define a scripts object.');
    }

    expect(scriptsField.typecheck).toBe('npx tsc --noEmit -p tsconfig.json');
    expect(scriptsField['test:smoke']).toBe(
      'npx vitest run src/__tests__/index.exports.snapshot.test.ts src/runtime-kernel/__tests__/index.exports.snapshot.test.ts src/testkit/__tests__/index.exports.snapshot.test.ts',
    );

    const exportsField = manifest.exports;
    if (!isRecord(exportsField)) {
      throw new Error('packages/agent-engine-dryrun/package.json must define an exports object.');
    }

    expect(Object.keys(exportsField).sort()).toEqual([
      '.',
      './context-manager',
      './contracts',
      './ports',
      './runtime-kernel',
      './testkit',
    ]);
  });

  it('defines an isolated dry-run tsconfig', async () => {
    const tsconfig = await readJson('../../../packages/agent-engine-dryrun/tsconfig.json');

    const compilerOptions = tsconfig.compilerOptions;
    if (!isRecord(compilerOptions)) {
      throw new Error('packages/agent-engine-dryrun/tsconfig.json must define compilerOptions.');
    }

    expect(compilerOptions.baseUrl).toBe('.');
    expect(compilerOptions.rootDirs).toEqual(['./src', '../schemas/src']);

    const paths = compilerOptions.paths;
    if (!isRecord(paths)) {
      throw new Error('packages/agent-engine-dryrun/tsconfig.json must define compilerOptions.paths.');
    }

    expect(paths['linnkit']).toEqual(['./src/index.ts']);
    expect(paths['linnkit/contracts']).toEqual(['./src/contracts/index.ts']);
    expect(paths['linnkit/runtime-kernel']).toEqual(['./src/runtime-kernel/index.ts']);
  });

  it('defines a package-local vitest alias config for copied source imports', async () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const configPath = resolve(testDir, '../../../packages/agent-engine-dryrun/vitest.config.ts');
    const configText = await readFile(configPath, 'utf8');

    expect(configText).toContain("find: 'src/agent'");
    expect(configText).toContain("find: '@app/schemas'");
    expect(configText).toContain("find: /^linnkit$/");
    expect(configText).toContain("environment: 'node'");
  });
});
