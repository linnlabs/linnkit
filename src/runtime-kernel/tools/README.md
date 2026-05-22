# Runtime Kernel Tools Protocol

Layer: `runtime-kernel/tools`

这里承接工具系统中可复用的 runtime 协议与 helper。  
如果要回答“graph 执行工具时最小需要哪些合同”，应该看这里。

---

## 1. 模块定位

本目录负责：

- `BaseTool` 这类纯工具合同
- `ToolExecutionContext` / `ToolSchemaContext`
- `ToolContextCompatibilityFields`
- `ToolContextPatch`
- history capability
- 参数规范化与幂等 key
- host-neutral 的最小 `ContextCheckpointTool`（只输出 checkpoint marker；TaskState / Memory 由 host hook 扩展）

本目录不负责：

- 默认 ToolRegistry 装配
- `allToolClasses`
- `tool_output` host 存储
- concrete Linnya tools

---

## 2. 关键边界 / 不变量

1. `ToolContext` 不整体搬进 runtime-kernel，只继续拆 runtime-owned 小接口
2. runtime consumer 优先吃小接口，不再直接依赖完整 `ToolContext`
3. host 默认 ports 和 default ToolManager 不属于这里
4. concrete tools 不属于这里

---

## 3. 详细目录树

```text
packages/linnkit/src/runtime-kernel/tools/
├── README.md
├── toolContracts.ts              # BaseTool / ToolParameterSchema / ToolResult 合同
├── contextCheckpointTool.ts      # 最小 context checkpoint 工具
├── toolExecutionContext.ts       # 最小执行上下文
├── toolSchemaContext.ts          # schema generation 最小上下文
├── toolContextCompatibility.ts   # 受控兼容字段
├── toolContextPatch.ts           # host/product 增量 patch 合同
├── toolContextRuntime.ts         # working/persisted history capability helper
├── conversationView.ts           # history 视图合同
├── argNormalizer.ts              # 参数规范化
├── ui-types.ts                   # tool ui / structured result 协议
└── idempotency/
    └── toolIdempotency.ts
```

---

## 4. 真实数据流

1. graph-engine 通过 `ToolExecutionContext` 与 ports 使用工具
2. schema generation 通过 `ToolSchemaContext` 生成 tool schema
3. runtime 通过 `toolContextRuntime.ts` 读取 working / persisted history
4. host 或 product 在外层通过 `ToolContextPatch` 注入增量信息

---

## 5. 开发注意事项

1. 如果一个类型只是给 runtime consumer 用，优先放这里
2. 如果一个能力需要默认 registry 或 preview 存储，它大概率不该放这里
3. 改 `ToolExecutionContext` / `ToolSchemaContext` 时，要想到 graph-engine 和 testkit 都会受影响
4. 不要重新把完整 `ToolContext` 当成“任意 patch 袋子”

---

## 6. 相关文档

- `packages/linnkit/src/runtime-kernel/graph-engine/README.md`
- `src/app-hosts/linnya/adapters/tools/README.md`
- `src/tools/README.md`
- `docs/archive/agent-proposals/README.md`
