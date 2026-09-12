import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(__dirname, '../..');
const guardFile = path.resolve(__dirname, 'no-host-leakage.test.ts');

const contextManagerLegacyLiterals = [
  'document_fragment',
  'context_before',
  'context_after',
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

const sourceTargets = ['src', '__tests__', 'build', 'bin'];

/**
 * 明确属于当前 host/product 的名称和富请求字段。
 *
 * 通用词（如 workspace、knowledge、review）不在列表中；它们可以用于解释一个任意 host。
 * 这里只阻止框架重新依赖具体 host 的产品注册项、插件名或富请求 DTO。
 */
const hostProductLiterals = [
  ['Linn', 'ya'].join(''),
  'Deep Research',
  'deep_research',
  'deep-research',
  'Slides',
  'ppt_',
  'pptx',
  'PPT ',
  'SharedMemory',
  'TaskState',
  'taskstate',
  'KnowledgeBase',
  'mindmap',
  'deepSearch',
  'workspaceProject',
  'currentBlockContent',
  'documentFragment',
  'projectMetadata',
  'documentMetadata',
  'userQuote',
  'recentRejections',
  'intentKey',
  'behaviorSummary',
  'imageGenerationModelId',
  'ToolSchemaContext',
];

function collectSourceFiles(target: string): string[] {
  // 缺失路径必须抛错；否则拆仓或移动目录会把边界检查变成空扫描假绿。
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    return isSourceFile(target) ? [target] : [];
  }

  const files: string[] = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) {
      continue;
    }

    const child = path.join(target, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(child));
      continue;
    }

    if (entry.isFile() && isSourceFile(child)) {
      files.push(child);
    }
  }
  return files;
}

function isSourceFile(filePath: string): boolean {
  // 只有本文件拥有拒绝词表；业务回归夹具不能因此整目录豁免。
  return filePath !== guardFile && /\.[cm]?[jt]sx?$/.test(filePath);
}

function isTestFile(filePath: string): boolean {
  return filePath.split(path.sep).includes('__tests__') || /\.(test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

function findLiteralViolations(
  root: string,
  targets: readonly string[],
  literals: string[],
  options: { readonly caseInsensitive?: boolean; readonly productionOnly?: boolean } = {},
): string[] {
  const violations: string[] = [];

  for (const target of targets) {
    const files = collectSourceFiles(path.join(root, target))
      .filter(file => !options.productionOnly || !isTestFile(file));
    if (files.length === 0) {
      throw new Error(`Boundary scan target has no source files: ${target}`);
    }
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const searchableContent = options.caseInsensitive ? content.toLowerCase() : content;
      const relativeFile = path.relative(root, file);

      for (const literal of literals) {
        const searchableLiteral = options.caseInsensitive
          ? literal.toLowerCase()
          : literal;
        if (searchableContent.includes(searchableLiteral)) {
          violations.push(`${relativeFile} contains ${literal}`);
        }
      }
    }
  }

  return violations;
}

describe('linnkit no host leakage', () => {
  it('keeps production contracts and runtime free of host-facing legacy literals', () => {
    expect(findLiteralViolations(
      repoRoot,
      ['src'],
      contextManagerLegacyLiterals,
      { productionOnly: true },
    )).toEqual([]);
  });

  it('keeps source, build entrypoints and test fixtures free of host product names', () => {
    expect(findLiteralViolations(
      repoRoot,
      sourceTargets,
      hostProductLiterals,
      { caseInsensitive: true },
    )).toEqual([]);
  });

  it('rejects missing or empty targets and detects product fixtures in nested tests', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linnkit-boundary-'));
    try {
      expect(() => findLiteralViolations(root, ['missing'], ['host_probe'])).toThrow();
      fs.mkdirSync(path.join(root, 'src', '__tests__'), { recursive: true });
      expect(() => findLiteralViolations(root, ['src'], ['host_probe'])).toThrow('no source files');
      fs.writeFileSync(path.join(root, 'src', '__tests__', 'probe.test.ts'), 'const tool = "host_probe";');
      expect(findLiteralViolations(root, ['src'], ['host_probe'])).toEqual([
        `${path.join('src', '__tests__', 'probe.test.ts')} contains host_probe`,
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
