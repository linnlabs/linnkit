import { readFile, readdir } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
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

/**
 * Smoke test for `@linnlabs/linnkit` 0.6.0 publishable shape.
 *
 * 这个 test 是 docs/release/RELEASE.md §3 工程层不变量的硬性闸门，覆盖：
 *   1. 包元数据（name / version / 不再 private / repository / publishConfig）
 *   2. 7 条可 import 子路径的 conditional exports（types/import/require 三件套，全部指 dist）
 *   3. files 字段只发 dist + 包根 README.md + docs/README.md + docs/integration/ + docs/release/
 *      docs/framework / docs/archive / docs/99-research-notes / DEVELOPMENT_GUIDE / INTEGRATION_GUIDE
 *      0.5.0 起一律不进 tarball（外部接入文档全部收口到 docs/integration/）
 *   4. tsconfig.paths 同时为 `linnkit*`（兼容 linnya monorepo）和 `@linnlabs/linnkit*`（真包名）解析
 *   5. linnkit 元数据 notes 仍然守住 browser-safe seam 与前端 deep-import 红线
 *   6. (0.1.3 新增) src/ 里所有非 node-builtin / 非 alias / 非相对路径的 import 都必须在 package.json
 *     #dependencies 或 #peerDependencies 里声明 —— 防止 0.1.0~0.1.2 那种 tiktoken 既未 declare
 *     又未 external 导致被 inline + wasm 资源缺失的灾难重演。
 *
 * 任何破坏以上不变量的改动 = break，必须先在 docs/release/RELEASE.md 留一行变更说明。
 */
describe('packages/linnkit shell manifest', () => {
  it('declares the publishable @linnlabs/linnkit 0.6.0 shape with dist-only exports', async () => {
    const manifest = await readJson('package.json');

    expect(manifest.name).toBe('@linnlabs/linnkit');
    expect(manifest.version).toBe('0.6.0');
    expect(manifest.private).toBeUndefined();
    expect(manifest.type).toBe('module');
    expect(manifest.main).toBe('./dist/index.cjs');
    expect(manifest.module).toBe('./dist/index.js');
    expect(manifest.types).toBe('./dist/index.d.ts');

    const repository = manifest.repository;
    if (!isRecord(repository)) {
      throw new Error('packages/linnkit/package.json must define a repository object.');
    }
    expect(repository.directory).toBe('packages/linnkit');

    const publishConfig = manifest.publishConfig;
    if (!isRecord(publishConfig)) {
      throw new Error('packages/linnkit/package.json must define publishConfig (registry + access).');
    }
    expect(publishConfig.registry).toBe('https://npm.pkg.github.com/');
    expect(publishConfig.access).toBe('restricted');

    const files = manifest.files;
    if (!Array.isArray(files)) {
      throw new Error('packages/linnkit/package.json must define a files array (do NOT publish raw src).');
    }
    expect(files).toContain('dist');
    expect(files).not.toContain('src');
    expect(files).toContain('README.md');
    expect(files).toContain('docs/README.md');
    expect(files).toContain('docs/integration');
    expect(files).toContain('docs/release');
    // 0.5.0 起：framework / archive / 99-research-notes / DEVELOPMENT_GUIDE / INTEGRATION_GUIDE 退出 tarball
    expect(files).not.toContain('docs/framework');
    expect(files).not.toContain('docs/archive');
    expect(files).not.toContain('docs/99-research-notes');
    expect(files).not.toContain('docs/DEVELOPMENT_GUIDE.md');
    expect(files).not.toContain('docs/INTEGRATION_GUIDE.md');
    expect(files.some((entry) => typeof entry === 'string' && entry.startsWith('src/'))).toBe(false);

    const exportsField = manifest.exports;
    if (!isRecord(exportsField)) {
      throw new Error('packages/linnkit/package.json must define an exports object.');
    }

    // Phase E 已彻底完成（2026-04-23），稳定公开入口为 6 个 + 1 个 ./package.json：
    // - root + 4 个长期稳定子入口
    // - 1 个 browser-safe slim 子入口（events governance 纯函数）
    // - ./package.json：允许接入方读元数据（如检测 version），不算 6 入口之一
    expect(Object.keys(exportsField).sort()).toEqual([
      '.',
      './context-manager',
      './contracts',
      './package.json',
      './ports',
      './runtime-kernel',
      './runtime-kernel/events',
      './testkit',
    ]);

    const subentryToDistBase: ReadonlyArray<readonly [string, string]> = [
      ['.', 'index'],
      ['./ports', 'ports'],
      ['./contracts', 'contracts'],
      ['./runtime-kernel', 'runtime-kernel'],
      ['./runtime-kernel/events', 'runtime-kernel/events'],
      ['./context-manager', 'context-manager'],
      ['./testkit', 'testkit'],
    ];

    for (const [subentry, distBase] of subentryToDistBase) {
      const value = exportsField[subentry];
      if (!isRecord(value)) {
        throw new Error(`exports["${subentry}"] must be a conditional export object`);
      }
      expect(value.types).toBe(`./dist/${distBase}.d.ts`);
      expect(value.import).toBe(`./dist/${distBase}.js`);
      expect(value.require).toBe(`./dist/${distBase}.cjs`);
    }

    expect(exportsField['./package.json']).toBe('./package.json');

    const linnkitField = manifest.linnkit;
    if (!isRecord(linnkitField)) {
      throw new Error('packages/linnkit/package.json must define a linnkit metadata object.');
    }

    expect(typeof linnkitField.phase).toBe('string');
    expect(linnkitField.sourceOfTruth).toBe('packages/linnkit/docs/release/RELEASE.md');
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
  it('locks alias paths for both linnkit (monorepo legacy) and @linnlabs/linnkit (real package name)', async () => {
    const tsconfig = await readJson('tsconfig.json');
    const compilerOptions = tsconfig.compilerOptions;
    if (!isRecord(compilerOptions)) {
      throw new Error('packages/linnkit/tsconfig.json must define compilerOptions.');
    }

    const paths = compilerOptions.paths;
    if (!isRecord(paths)) {
      throw new Error('packages/linnkit/tsconfig.json must define compilerOptions.paths.');
    }

    // 旧别名（linnkit/*）：linnya 主仓内大量 import 仍走这条路径，必须保留
    expect(paths.linnkit).toEqual(['./src/index.ts']);
    expect(paths['linnkit/ports']).toEqual(['./src/ports/index.ts']);
    expect(paths['linnkit/contracts']).toEqual(['./src/contracts/index.ts']);
    expect(paths['linnkit/runtime-kernel']).toEqual(['./src/runtime-kernel/index.ts']);
    expect(paths['linnkit/runtime-kernel/events']).toEqual(['./src/runtime-kernel/events/index.ts']);
    expect(paths['linnkit/context-manager']).toEqual(['./src/context-manager/index.ts']);
    expect(paths['linnkit/testkit']).toEqual(['./src/testkit/index.ts']);

    // 新别名（@linnlabs/linnkit/*）：与发包后的真名 1:1 对齐，linnsy 端用真名 import，monorepo 内同样能解析
    expect(paths['@linnlabs/linnkit']).toEqual(['./src/index.ts']);
    expect(paths['@linnlabs/linnkit/ports']).toEqual(['./src/ports/index.ts']);
    expect(paths['@linnlabs/linnkit/contracts']).toEqual(['./src/contracts/index.ts']);
    expect(paths['@linnlabs/linnkit/runtime-kernel']).toEqual(['./src/runtime-kernel/index.ts']);
    expect(paths['@linnlabs/linnkit/runtime-kernel/events']).toEqual(['./src/runtime-kernel/events/index.ts']);
    expect(paths['@linnlabs/linnkit/context-manager']).toEqual(['./src/context-manager/index.ts']);
    expect(paths['@linnlabs/linnkit/testkit']).toEqual(['./src/testkit/index.ts']);

    expect(paths).not.toHaveProperty('@app/schemas');
    expect(paths).not.toHaveProperty('@app/schemas/*');
  });
});

/**
 * 0.1.3 新增：src/ 第三方 import 反向稽核。
 *
 * 真实事故：0.1.0~0.1.2 三个版本的 TokenCalculator.ts 顶层 `import 'tiktoken'`，但
 * package.json 既没声明 dep 也没 external，导致 tsup 把整个 tiktoken JS inline 进 dist，
 * 但 tiktoken_bg.wasm 没跟着进 dist —— 任何 import @linnlabs/linnkit/runtime-kernel 都
 * 立即 "Missing tiktoken_bg.wasm"。
 *
 * 这条测试是结构守卫：扫描 src/ 全部 .ts 的 import 语句，提取所有 bare specifier，
 * 排除 node-builtin / 自身 alias / 相对路径后，剩下的必须**全部**在 package.json
 * 的 dependencies / peerDependencies 里出现。否则 break。
 *
 * 注意：tsup external 数组也必须同步声明（见 tsup.config.ts 顶部注释），但 external 数组
 * 是构建期 hint，本测试不直接校验 — 只校验 npm install 闭环。external 漏声明会被
 * package.runtime-import.test.ts 的实际 import 测出来。
 */
describe('packages/linnkit src third-party import reverse audit', () => {
  async function listTsFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
        out.push(...(await listTsFiles(full)));
      } else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  function extractBareSpecifiers(source: string): string[] {
    const specs: string[] = [];
    const re = /(?:^|\s|;|\}|\))\s*(?:import|export)\s+(?:[^'"]+?\s+from\s+)?['"]([^'"]+)['"]/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      specs.push(m[1]);
    }
    const re2 = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = re2.exec(source)) !== null) {
      specs.push(m[1]);
    }
    const re3 = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = re3.exec(source)) !== null) {
      specs.push(m[1]);
    }
    return specs;
  }

  function isOwnAlias(spec: string): boolean {
    return (
      spec === 'linnkit' ||
      spec.startsWith('linnkit/') ||
      spec === '@linnlabs/linnkit' ||
      spec.startsWith('@linnlabs/linnkit/')
    );
  }

  function isRelative(spec: string): boolean {
    return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
  }

  function isAbsolute(spec: string): boolean {
    return spec.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(spec);
  }

  function packageNameFromSpecifier(spec: string): string {
    if (spec.startsWith('@')) {
      const parts = spec.split('/');
      return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
    }
    const idx = spec.indexOf('/');
    return idx === -1 ? spec : spec.slice(0, idx);
  }

  it('src/ 里所有第三方 bare import 都必须在 package.json dependencies / peerDependencies 里声明', async () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const srcDir = resolve(testDir, '..', 'src');
    const manifest = await readJson('package.json');
    const deps = isRecord(manifest.dependencies) ? Object.keys(manifest.dependencies) : [];
    const peers = isRecord(manifest.peerDependencies) ? Object.keys(manifest.peerDependencies) : [];
    const declared = new Set([...deps, ...peers]);

    const files = await listTsFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);

    const undeclared = new Map<string, string[]>();

    for (const file of files) {
      const content = await readFile(file, 'utf8');
      const specs = extractBareSpecifiers(content);
      for (const spec of specs) {
        if (isRelative(spec) || isAbsolute(spec)) continue;
        if (isOwnAlias(spec)) continue;
        if (isBuiltin(spec)) continue;
        const pkgName = packageNameFromSpecifier(spec);
        if (declared.has(pkgName)) continue;
        const list = undeclared.get(pkgName) ?? [];
        list.push(file.replace(srcDir, 'src'));
        undeclared.set(pkgName, list);
      }
    }

    if (undeclared.size > 0) {
      const lines: string[] = [
        '以下第三方包在 src/ 里被 import 但未在 package.json dependencies / peerDependencies 声明，',
        '这是 0.1.0~0.1.2 tiktoken 灾难的同款风险（tsup 会 inline 进 dist，wasm/native 资源会缺失）：',
        '',
      ];
      for (const [pkg, fileList] of [...undeclared.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`  - ${pkg}`);
        const unique = [...new Set(fileList)].slice(0, 3);
        for (const f of unique) lines.push(`      ${f}`);
        if (fileList.length > 3) lines.push(`      ... +${fileList.length - 3} more`);
      }
      lines.push('');
      lines.push('修复：把这些包加入 package.json dependencies（或 peerDependencies），');
      lines.push('     并同步加入 tsup.config.ts external 数组。');
      throw new Error(lines.join('\n'));
    }
  });
});
