import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';

import { packageEntries } from './packageEntries.ts';

// 多入口声明合并会把跨 chunk 的 namespace 类型误判成值。保留声明模块图，
// 让 TypeScript 直接解析原始重导出，并让不同公开入口引用同一份 class/brand 身份。
const bundle = await rollup({
  input: packageEntries,
  plugins: [dts({ tsconfig: 'tsconfig.src.json' })],
});

try {
  for (const extension of ['d.ts', 'd.cts']) {
    await bundle.write({
      dir: 'dist',
      format: 'es',
      preserveModules: true,
      preserveModulesRoot: 'src',
      entryFileNames: `[name].${extension}`,
      chunkFileNames: `[name]-[hash].${extension}`,
    });
  }
} finally {
  await bundle.close();
}
