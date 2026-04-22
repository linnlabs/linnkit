import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readManifest(): Promise<Record<string, unknown>> {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const manifestPath = resolve(testDir, '../package.json');
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!isRecord(parsed)) {
    throw new Error('src/agent/package.json must parse to a JSON object.');
  }
  return parsed;
}

describe('src/agent package manifest', () => {
  it('defines the draft linnkit entrypoints', async () => {
    const manifest = await readManifest();

    expect(manifest.name).toBe('linnkit');
    expect(manifest.version).toBe('0.0.0-dev');
    expect(manifest.private).toBe(true);
    expect(manifest.type).toBe('module');

    const exportsField = manifest.exports;
    if (!isRecord(exportsField)) {
      throw new Error('src/agent/package.json must define an exports object.');
    }

    expect(Object.keys(exportsField).sort()).toEqual([
      '.',
      './context-manager',
      './contracts',
      './ports',
      './runtime-kernel',
      './testkit',
    ]);
    expect(exportsField['.']).toBe('./index.ts');
    expect(exportsField['./contracts']).toBe('./contracts/index.ts');
    expect(exportsField['./ports']).toBe('./ports/index.ts');
    expect(exportsField['./runtime-kernel']).toBe('./runtime-kernel/index.ts');
    expect(exportsField['./context-manager']).toBe('./context-manager/index.ts');
    expect(exportsField['./testkit']).toBe('./testkit/index.ts');
  });

  it('records phase-d draft metadata for future extraction', async () => {
    const manifest = await readManifest();
    const linnkitField = manifest.linnkit;
    if (!isRecord(linnkitField)) {
      throw new Error('src/agent/package.json must define a linnkit metadata object.');
    }

    expect(linnkitField.phase).toBe('D-1.b draft');
    expect(linnkitField.stableExportsTruth).toBe(
      'src/agent/docs/engine/14-stable-vs-compat-exports.md',
    );
    expect(linnkitField.extractionPlan).toBe(
      'src/agent/docs/engine/07-public-api-and-package-boundary.md',
    );
    expect(linnkitField.notes).toEqual([
      '本文件是 Phase D 起草版，不真发布',
      'Phase E (E-1) 时迁到独立 packages/linnkit/ 目录',
      'TODO(D-2): 加 boundary guard CI hook reference',
      'TODO(engine/03): exports 表加 ./ports 下的 LlmProviderPort 子条目（如适用）',
    ]);
  });
});
