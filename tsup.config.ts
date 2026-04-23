import { defineConfig } from 'tsup';

/**
 * tsup build config for `@linnya/linnkit`.
 *
 * 6 个稳定公开子入口（与 package.json#exports 1:1）：
 *   .                       → dist/index.{js,cjs,d.ts}
 *   ./ports                 → dist/ports.{js,cjs,d.ts}
 *   ./contracts             → dist/contracts.{js,cjs,d.ts}
 *   ./runtime-kernel        → dist/runtime-kernel.{js,cjs,d.ts}     (Node-only 全展开)
 *   ./runtime-kernel/events → dist/runtime-kernel/events.{js,cjs,d.ts}  (browser-safe slim seam)
 *   ./context-manager       → dist/context-manager.{js,cjs,d.ts}
 *   ./testkit               → dist/testkit.{js,cjs,d.ts}            (test-only；AGENT-GUARD-10)
 *
 * 不变量（详见 RELEASE.md §3）：
 *   - 所有公开入口都同时 emit cjs + esm + .d.ts；缺一个就是 break
 *   - ./runtime-kernel/events 的产物必须 browser-safe，禁止引入 node:async_hooks / crypto / fs
 *     （由 src 侧约束保证；tsup 不会主动注入这些依赖）
 *   - splitting: false —— 多入口禁用 chunk 共享，确保 require/cjs 形态干净；接入方装包后能稳定 deep import 单个子入口
 *   - 默认所有 node_modules 都视为 external（tsup 默认行为），无需手动列举依赖
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    ports: 'src/ports/index.ts',
    contracts: 'src/contracts/index.ts',
    'runtime-kernel': 'src/runtime-kernel/index.ts',
    'runtime-kernel/events': 'src/runtime-kernel/events/index.ts',
    'context-manager': 'src/context-manager/index.ts',
    testkit: 'src/testkit/index.ts',
  },
  format: ['cjs', 'esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  shims: false,
  // 显式标注：vitest 是 testkit 入口的运行时依赖，必须 external（接入方在自己的 devDeps 里装）
  external: ['vitest'],
});
