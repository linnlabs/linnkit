import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const filePath = resolve(testDir, '..', relativePath);
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error(`${relativePath} must parse to a JSON object.`);
  }
  return parsed;
}

describe('packages/linnkit shell manifest', () => {
  it('defines the formal linnkit package shape without duplicating source ownership', async () => {
    const manifest = await readJson('package.json');

    expect(manifest.name).toBe('linnkit');
    expect(manifest.version).toBe('0.0.0-dev');
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe('module');

    const exportsField = manifest.exports;
    if (!isRecord(exportsField)) {
      throw new Error('packages/linnkit/package.json must define an exports object.');
    }

    expect(Object.keys(exportsField).sort()).toEqual([
      '.',
      './context-manager',
      './contracts',
      './ports',
      './runtime-kernel',
      './testkit',
    ]);
    expect(exportsField['.']).toBe('./src/index.ts');
    expect(exportsField['./ports']).toBe('./src/ports/index.ts');
    expect(exportsField['./contracts']).toBe('./src/contracts/index.ts');
    expect(exportsField['./runtime-kernel']).toBe('./src/runtime-kernel/index.ts');
    expect(exportsField['./context-manager']).toBe('./src/context-manager/index.ts');
    expect(exportsField['./testkit']).toBe('./src/testkit/index.ts');

    const linnkitField = manifest.linnkit;
    if (!isRecord(linnkitField)) {
      throw new Error('packages/linnkit/package.json must define a linnkit metadata object.');
    }

    expect(linnkitField.phase).toBe('E-PR-B shell');
    expect(linnkitField.sourceOfTruth).toBe(
      'src/agent/docs/engine/24-phase-e-implementation-runbook.md',
    );
    expect(linnkitField.movePlan).toBe('src/agent -> packages/linnkit/src');
    expect(linnkitField.notes).toEqual([
      '本包当前只建立正式 package 壳子，不复制第二份 src',
      'PR-C 使用 git mv 将 src/agent 物理迁入 packages/linnkit/src',
      '在 PR-C 完成前，不允许把本目录变成回指 src/agent 的过渡 re-export 层',
    ]);
  });
});

describe('packages/linnkit shell tsconfig', () => {
  it('locks the future public entry aliases for the real package path', async () => {
    const tsconfig = await readJson('tsconfig.json');
    const compilerOptions = tsconfig.compilerOptions;
    if (!isRecord(compilerOptions)) {
      throw new Error('packages/linnkit/tsconfig.json must define compilerOptions.');
    }

    const paths = compilerOptions.paths;
    if (!isRecord(paths)) {
      throw new Error('packages/linnkit/tsconfig.json must define compilerOptions.paths.');
    }

    expect(paths.linnkit).toEqual(['./src/index.ts']);
    expect(paths['linnkit/ports']).toEqual(['./src/ports/index.ts']);
    expect(paths['linnkit/contracts']).toEqual(['./src/contracts/index.ts']);
    expect(paths['linnkit/runtime-kernel']).toEqual(['./src/runtime-kernel/index.ts']);
    expect(paths['linnkit/context-manager']).toEqual(['./src/context-manager/index.ts']);
    expect(paths['linnkit/testkit']).toEqual(['./src/testkit/index.ts']);
    expect(paths['@app/schemas']).toEqual(['../schemas/src/index.ts']);
    expect(paths['@app/schemas/*']).toEqual(['../schemas/src/*']);
  });
});
