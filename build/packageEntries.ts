/** JavaScript 与声明构建共用入口，避免两条产物链的公开面漂移。 */
export const packageEntries = {
  index: 'src/index.ts',
  ports: 'src/ports/index.ts',
  contracts: 'src/contracts/index.ts',
  'runtime-kernel': 'src/runtime-kernel/index.ts',
  'runtime-kernel/events': 'src/runtime-kernel/events/index.ts',
  'context-manager': 'src/context-manager/index.ts',
  testkit: 'src/testkit/index.ts',
  quickstart: 'src/quickstart/index.ts',
  cli: 'src/cli/index.ts',
};
