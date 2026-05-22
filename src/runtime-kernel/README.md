# Runtime Kernel 总览

Layer: `runtime-kernel`

这里承接后端 Agent 可复用的运行时骨架。  
本目录是 `linnkit` package 的 runtime-kernel 真源。任何新接入方都通过 `linnkit/runtime-kernel` 装配它。

---

## 1. 模块定位

本目录负责：

- graph loop 与节点协议
- RuntimeEvent 生命周期与事件映射
- llm caller / resolver / streaming normalization
- tool runtime 最小协议
- child-run 最小协议
- run-context / enrichment / reminder / subrun trace
- audit sink 与决策审计 helper（EventStore / noop / console / file / composite）

本目录不负责：

- Linnya 默认 runtime 装配
- SSE / persistence / Flow host application layer
- concrete tools 与产品服务

---

## 2. 关键边界 / 不变量

1. `runtime-kernel` 不得反向依赖 `host-adapters`
2. 不得直接依赖 `context-manager / agent-registry / workspace / knowledge-base`
3. 新协议要优先定义最小合同，不要继续把 product 类型直接拖进来
4. `ToolContext` 不能整体粗暴搬进来，只能继续拆成 runtime-owned 小接口
5. `audit/` 只放 sink、组合器与决策审计 helper；审计协议 schema 真源在 `contracts/audit.ts`

---

## 3. 详细目录树

```text
packages/linnkit/src/runtime-kernel/
├── README.md
├── audit/                     # AuditPort sink：EventStore / noop / console / file / composite
├── child-runs/                # child-run 原语、history policy、最小上下文（同步子 run 可独立 runId/parentRunId）
├── execution/                 # event-bus / sequencer / runtime error factory
├── events/                    # agentEvents / eventGovernance / eventMappers（含浏览器安全 slim seam 的真源）
├── graph-engine/              # GraphExecutor / tick-pipeline / nodes / checkpointer / event-store
├── llm/                       # caller / modelResolver / policies / streaming
├── enrichment/                # enrichment registry 与 patch 合同
├── run-context/               # run trace / parent / tags
├── run-supervisor/            # RunRegistryStore port + memory 实现 + contract 测试
├── child-run-trace/           # subrun_trace 观测协议 publisher 与最小合同
├── system-reminder/           # reminder 规则与 apply
├── telemetry/                 # TelemetryPort + 4 类 kind 常量 + noop 默认实现 + contract 测试
└── tools/                     # tool contracts / execution context / schema context / helpers
```

> **公开入口提醒**：本目录通过两个 package export 暴露：
> - `linnkit/runtime-kernel`（**Node-only** 全展开 namespace，含 `node:async_hooks` / `crypto` 等）
> - `linnkit/runtime-kernel/events`（**browser-safe slim seam**，仅 `events/` 下的 governance 纯函数；前端**必须**走这个）

---

## 4. 真实数据流

### 4.1 graph run

1. `GraphExecutor` 驱动 graph loop
2. `tick-pipeline` 完成一次 llm 调用前后的阶段化处理
3. `LlmNode` / `ToolNode` 执行节点语义
4. 事件统一落到 `events/*`
5. 工具执行依赖 `tools/*` 的最小协议

### 4.2 child-run

1. runtime-kernel 只定义 child-run 原语与最小上下文
2. registered agent resolve 与默认 invoker 装配在 host-adapter
3. 工具侧只消费 child-run 入口，不拥有协议本体

---

## 5. 开发注意事项

1. 如果一个能力必须知道 “Linnya 默认怎么接”，它大概率不该放这里
2. 如果一个类型包含明显的 product 字段，优先继续拆小接口，而不是搬整个大类型
3. 变更 `events / graph-engine / tools` 协议时，必须补最小 contract 回归
4. 不要把 compatibility bridge 当成真实 owner 路径

---

## 6. 推荐阅读顺序

1. [`graph-engine/README.md`](./graph-engine/README.md)
2. [`tools/README.md`](./tools/README.md)
3. [`llm/README.md`](./llm/README.md)
4. [`../../../../src/app-hosts/linnya/adapters/flow/README.md`](../../../../src/app-hosts/linnya/adapters/flow/README.md)

---

## 7. 相关文档

- [`packages/linnkit/docs/README.md`](../../docs/README.md)
- [`packages/linnkit/src/runtime-kernel/graph-engine/README.md`](./graph-engine/README.md)
- [`packages/linnkit/src/runtime-kernel/tools/README.md`](./tools/README.md)
- [`packages/linnkit/docs/archive/engine-phases/README.md`](../../docs/archive/engine-phases/README.md)（早期抽包决策档案总览，**已归档**）
- [`packages/linnkit/docs/framework/`](../../docs/framework/)（linnkit 框架演进活文档）
- [`packages/linnkit/docs/archive/engine-phases/24-phase-e-implementation-runbook.md`](../../docs/archive/engine-phases/24-phase-e-implementation-runbook.md)（早期抽包 runbook，归档参考）
- [`docs/archive/agent-proposals/README.md`](../../../../docs/archive/agent-proposals/README.md)
