import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('published declaration consumer', () => {
  it.each([
    ['ESNext', 'Bundler'],
    ['NodeNext', 'NodeNext'],
  ])('checks package exports with %s / %s and no source aliases', (module, resolution) => {
    // 独立 tsconfig 不继承源码 paths；包自身引用按 package.json exports 读取真实 dist。
    // skipLibCheck=false 同时验证声明图，避免只检查源码、运行时 import 都绿但类型产物已损坏。
    const result = spawnSync(process.execPath, [
      resolve(packageRoot, 'node_modules/typescript/bin/tsc'),
      '--project', '__tests__/fixtures/package-consumer/tsconfig.json',
      '--module', module,
      '--moduleResolution', resolution,
      '--pretty', 'false',
    ], { cwd: packageRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    if (result.error) throw result.error;
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 30_000);
});
