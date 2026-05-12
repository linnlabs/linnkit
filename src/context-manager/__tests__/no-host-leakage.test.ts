import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../../../../..');

const scannedTargets = [
  'packages/linnkit/src/context-manager/index.ts',
  'packages/linnkit/src/context-manager/shared',
  'packages/linnkit/src/context-manager/profiles/agent',
];

const forbiddenLiterals = [
  'document_fragment',
  'project_context',
  'document_context',
  'user_quote',
  'additional_context',
  '前置上下文',
  '后置上下文',
  '编辑器写作',
  '批注回复',
  '表格填充',
  '音频转录',
  '[任务完成]',
];

function collectSourceFiles(target: string): string[] {
  const absoluteTarget = path.join(repoRoot, target);
  if (!fs.existsSync(absoluteTarget)) {
    return [];
  }

  const stat = fs.statSync(absoluteTarget);
  if (stat.isFile()) {
    return isTypeScriptFile(absoluteTarget) ? [absoluteTarget] : [];
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(absoluteTarget, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const child = path.join(absoluteTarget, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(path.relative(repoRoot, child)));
      continue;
    }

    if (entry.isFile() && isTypeScriptFile(child)) {
      files.push(child);
    }
  }
  return files;
}

function isTypeScriptFile(filePath: string): boolean {
  return filePath.endsWith('.ts') && !filePath.endsWith('.d.ts');
}

describe('context-manager no host leakage', () => {
  it('keeps shared and agent profile code free of host-facing legacy literals', () => {
    const violations: string[] = [];

    for (const target of scannedTargets) {
      for (const file of collectSourceFiles(target)) {
        const content = fs.readFileSync(file, 'utf8');
        const relativeFile = path.relative(repoRoot, file);

        for (const literal of forbiddenLiterals) {
          if (content.includes(literal)) {
            violations.push(`${relativeFile} contains ${literal}`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
