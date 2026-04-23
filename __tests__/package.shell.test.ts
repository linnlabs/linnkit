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

    // Phase E 已彻底完成（2026-04-23），稳定公开入口为 6 个：
    // - root + 4 个长期稳定子入口
    // - 1 个 browser-safe slim 子入口（events governance 纯函数）
    expect(Object.keys(exportsField).sort()).toEqual([
      '.',
      './context-manager',
      './contracts',
      './ports',
      './runtime-kernel',
      './runtime-kernel/events',
      './testkit',
    ]);
    expect(exportsField['.']).toBe('./src/index.ts');
    expect(exportsField['./ports']).toBe('./src/ports/index.ts');
    expect(exportsField['./contracts']).toBe('./src/contracts/index.ts');
    expect(exportsField['./runtime-kernel']).toBe('./src/runtime-kernel/index.ts');
    expect(exportsField['./runtime-kernel/events']).toBe('./src/runtime-kernel/events/index.ts');
    expect(exportsField['./context-manager']).toBe('./src/context-manager/index.ts');
    expect(exportsField['./testkit']).toBe('./src/testkit/index.ts');

    const linnkitField = manifest.linnkit;
    if (!isRecord(linnkitField)) {
      throw new Error('packages/linnkit/package.json must define a linnkit metadata object.');
    }

    expect(linnkitField.phase).toBe('E-completed (engineering layer)');
    expect(linnkitField.sourceOfTruth).toBe(
      'packages/linnkit/src/docs/engine/24-phase-e-implementation-runbook.md',
    );
    expect(Array.isArray(linnkitField.notes)).toBe(true);
    const notes = linnkitField.notes as unknown[];
    expect(notes.length).toBeGreaterThanOrEqual(2);
    // 至少其中一条说明必须明确点出 browser-safe slim seam 的不变量
    expect(
      notes.some(
        (n): n is string =>
          typeof n === 'string' && n.includes('./runtime-kernel/events') && n.includes('browser-safe'),
      ),
    ).toBe(true);
    // 另外必须有一条说明禁止前端 import 全展开 ./runtime-kernel
    expect(
      notes.some(
        (n): n is string =>
          typeof n === 'string' &&
          n.includes('前端') &&
          n.includes('./runtime-kernel') &&
          (n.includes('Node-only') || n.includes('node:async_hooks') || n.includes('crypto')),
      ),
    ).toBe(true);
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
