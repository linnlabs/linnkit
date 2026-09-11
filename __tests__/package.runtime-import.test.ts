/**
 * 0.1.3 新增：dist 子入口运行时 import 烟雾测试。
 *
 * 起因：0.1.0 ~ 0.1.2 三个版本的 dist/runtime-kernel.* / dist/context-manager.* / dist/index.* 都把
 * tiktoken 整段 inline bundle 进去（因为 package.json 没声明 tiktoken dep + tsup 默认只把已声明 deps
 * 视为 external），但 tiktoken_bg.wasm 没有跟着进 dist；外部 consumer 一旦 import 这三个入口就立刻
 * 报 "Missing tiktoken_bg.wasm"。
 *
 * 本测试用 `node -e` 子进程在隔离环境里 import dist 产物，覆盖：
 *   1. 之前会炸的 4 个入口（runtime-kernel / context-manager / index）现在能干净 import
 *   2. browser-safe seam (runtime-kernel/events) 一直能 import
 *   3. 纯类型入口 (contracts / ports) 一直能 import
 *   4. testkit 的 ESM 入口可被 Vitest 4 在普通 Node 中解析，CJS 入口仍按 Vitest 合同拒绝；
 *      生产代码禁用 testkit 由 AGENT-GUARD-10 守护，不依赖上游包的偶然 import 行为
 *   5. dist 文件里 tiktoken 必须以 require/import external 模式出现，不能 inline；
 *      并且 dist 不能含 tiktoken_bg.wasm 资源路径字符串
 *
 * 必须用子进程而不是 vitest 内联 await import：vitest 上下文有 paths alias
 * （linnkit/* → src/*），会把 './dist/runtime-kernel.js' 误解析到源码而不是真 dist。
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

interface NodeImportResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function nodeImport(distRelative: string): Promise<NodeImportResult> {
  return new Promise((resolveResult) => {
    const child = spawn(
      'node',
      [
        '-e',
        `import('./${distRelative}').then(()=>{process.stdout.write('ok')}).catch(e=>{process.stderr.write(String(e && (e.message ?? e)));process.exit(1)})`,
      ],
      { cwd: PACKAGE_ROOT }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      resolveResult({ ok: code === 0, exitCode: code, stdout, stderr });
    });
    child.on('error', (err) => {
      resolveResult({ ok: false, exitCode: null, stdout, stderr: String(err.message ?? err) });
    });
  });
}

function nodeRun(args: readonly string[]): Promise<NodeImportResult> {
  return new Promise((resolveResult) => {
    const child = spawn('node', args, { cwd: PACKAGE_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      resolveResult({ ok: code === 0, exitCode: code, stdout, stderr });
    });
    child.on('error', (err) => {
      resolveResult({ ok: false, exitCode: null, stdout, stderr: String(err.message ?? err) });
    });
  });
}

describe('package.runtime-import — dist 子入口隔离 import 烟雾测试', () => {
  describe('Node 全展开运行时入口（之前会炸 tiktoken wasm，0.1.3 修复）', () => {
    const NODE_RUNTIME_ENTRIES = [
      'dist/runtime-kernel.js',
      'dist/runtime-kernel.cjs',
      'dist/context-manager.js',
      'dist/context-manager.cjs',
      'dist/index.js',
      'dist/index.cjs',
    ] as const;

    it.each(NODE_RUNTIME_ENTRIES)(
      'import("./%s") 应该不报 Missing tiktoken_bg.wasm，干净返回',
      async (entry) => {
        const result = await nodeImport(entry);
        if (!result.ok) {
          throw new Error(
            `Failed to import ${entry}:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
          );
        }
        expect(result.stdout).toContain('ok');
        expect(result.stderr).not.toContain('tiktoken_bg.wasm');
        expect(result.stderr).not.toContain('Missing');
      }
    );
  });

  describe('跨公开入口的 ToolContext runtime 身份', () => {
    const MODULE_PAIRS = [
      ['dist/index.js', 'dist/runtime-kernel.js', 'esm'],
      ['dist/index.cjs', 'dist/runtime-kernel.cjs', 'cjs'],
    ] as const;

    it.each(MODULE_PAIRS)(
      '%s 创建的 runtime binding 必须能被 %s 读取并派生（%s）',
      async (rootEntry, runtimeEntry, format) => {
        const loadRoot = format === 'esm'
          ? `await import('./${rootEntry}')`
          : `require('./${rootEntry}')`;
        const loadRuntime = format === 'esm'
          ? `await import('./${runtimeEntry}')`
          : `require('./${runtimeEntry}')`;
        const script = [
          format === 'esm' ? '(async () => {' : '',
          `const root = ${loadRoot};`,
          `const runtime = ${loadRuntime};`,
          'const source = { conversationId: "conversation-1", turnId: "turn-1" };',
          'root.runtimeKernel.tools.ensureToolContextRuntimeCapability({ context: source });',
          'const target = { ...source };',
          'runtime.copyToolContextRuntimeCapability(source, target);',
          'if (!runtime.getToolContextRuntimeBinding(target)) throw new Error("binding not shared");',
          'process.stdout.write("ok");',
          format === 'esm' ? '})().catch(error => { console.error(error); process.exit(1); });' : '',
        ].join('\n');
        const result = await nodeRun(['-e', script]);

        if (!result.ok) {
          throw new Error(
            `ToolContext runtime identity failed (${format}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
          );
        }
        expect(result.stdout).toBe('ok');
      }
    );
  });

  describe('Browser-safe seam + 纯类型入口（应一直能 import）', () => {
    const SAFE_ENTRIES = [
      'dist/runtime-kernel/events.js',
      'dist/runtime-kernel/events.cjs',
      'dist/contracts.js',
      'dist/contracts.cjs',
      'dist/ports.js',
      'dist/ports.cjs',
      'dist/quickstart.js',
      'dist/quickstart.cjs',
      'dist/cli.js',
      'dist/cli.cjs',
    ] as const;

    it.each(SAFE_ENTRIES)('import("./%s") 应该干净返回', async (entry) => {
      const result = await nodeImport(entry);
      if (!result.ok) {
        throw new Error(
          `Failed to import ${entry}:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`
        );
      }
      expect(result.stdout).toContain('ok');
    });
  });

  describe('CLI bin', () => {
    it('node dist/cli.cjs --help 应该输出帮助文本且不依赖真实 provider', async () => {
      const result = await nodeRun(['dist/cli.cjs', '--help']);
      if (!result.ok) {
        throw new Error(`Failed to run CLI:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      }
      expect(result.stdout).toContain('linnkit v0 CLI');
      expect(result.stdout).toContain('linnkit init <name>');
    });

    it('node bin/linnkit.cjs --help 应该通过 npm bin wrapper 调到 dist CLI', async () => {
      const result = await nodeRun(['bin/linnkit.cjs', '--help']);
      if (!result.ok) {
        throw new Error(`Failed to run CLI bin wrapper:\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      }
      expect(result.stdout).toContain('linnkit v0 CLI');
      expect(result.stdout).toContain('linnkit init <name>');
    });
  });

  describe('testkit 入口（AGENT-GUARD-10：生产代码禁止引用）', () => {
    it('ESM 入口在普通 Node 中可解析，生产边界不依赖 Vitest 的隐式抛错', async () => {
      const result = await nodeImport('dist/testkit.js');
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('ok');
      expect(result.stderr).not.toContain('tiktoken_bg.wasm');
    });

    it('CJS 入口按 Vitest 4 合同拒绝 require', async () => {
      const result = await nodeImport('dist/testkit.cjs');
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('Vitest cannot be imported in a CommonJS module');
      expect(result.stderr).not.toContain('tiktoken_bg.wasm');
    });
  });

  describe('结构性退化守卫', () => {
    const BUNDLE_FILES = [
      'dist/runtime-kernel.js',
      'dist/runtime-kernel.cjs',
      'dist/context-manager.js',
      'dist/context-manager.cjs',
      'dist/index.js',
      'dist/index.cjs',
      'dist/testkit.js',
      'dist/testkit.cjs',
    ] as const;

    it.each(BUNDLE_FILES)(
      'dist/%s 不能含 "tiktoken_bg.wasm" 字符串（如果含，说明 tsup 又把 tiktoken inline 了）',
      async (rel) => {
        const content = await readFile(resolve(PACKAGE_ROOT, rel), 'utf8');
        expect(content).not.toContain('tiktoken_bg.wasm');
      }
    );

    const TIKTOKEN_USERS = [
      'dist/runtime-kernel.js',
      'dist/runtime-kernel.cjs',
      'dist/context-manager.js',
      'dist/context-manager.cjs',
      'dist/index.js',
      'dist/index.cjs',
    ] as const;

    it.each(TIKTOKEN_USERS)(
      'dist/%s 必须以 external 形式 require/import "tiktoken"（不能 inline）',
      async (rel) => {
        const content = await readFile(resolve(PACKAGE_ROOT, rel), 'utf8');
        const isCjs = rel.endsWith('.cjs');
        if (isCjs) {
          expect(content).toMatch(/require\(["']tiktoken["']\)/);
        } else {
          expect(content).toMatch(/from\s*["']tiktoken["']/);
        }
      }
    );

    const ZOD_USERS = [
      'dist/contracts.js',
      'dist/contracts.cjs',
      'dist/index.js',
      'dist/index.cjs',
      'dist/runtime-kernel.js',
      'dist/runtime-kernel.cjs',
      'dist/context-manager.js',
      'dist/context-manager.cjs',
    ] as const;

    it.each(ZOD_USERS)(
      'dist/%s 必须以 external 形式 require/import "zod"（不能 inline，否则 schema 实例隔离会炸）',
      async (rel) => {
        const content = await readFile(resolve(PACKAGE_ROOT, rel), 'utf8');
        const isCjs = rel.endsWith('.cjs');
        if (isCjs) {
          expect(content).toMatch(/require\(["']zod["']\)/);
        } else {
          expect(content).toMatch(/from\s*["']zod["']/);
        }
      }
    );
  });
});
