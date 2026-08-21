# 14 · linnkit 治理收官索引

> 立稿：2026-06-22。
> 整理：2026-06-24。
> 性质：治理总纲的压缩版索引。完整施工细节以 git history、15 号质量账本、16 号 benchmark 入口为准；本文只保留当前结论、已完成治理、迁移去向和少量剩余尾巴。

---

## 1. 当前结论

linnkit 的 2026-06 治理主线已经完成：

| 工作面 | 状态 | 当前口径 |
|---|---:|---|
| 文档校准 | ✅ | 旧 0.5/0.8 时代计划已校准到当前 `0.23.0`；`CHANGELOG.md` / 源码是权威状态源 |
| bug / 边界治理 | ✅ | 关键 bug、Linnya 语义泄漏、旧 chat execution mode、子 agent 模型继承等已处理 |
| 质量审计专项 | ✅ | 见 [15](./15-robustness-and-decoupling-audit.md)，Q-B/Q-M/Q-L/Q-R 主线已收官 |
| 根因重构 | ✅ | 见 [16](./16-refactor-and-benchmark-baseline-plan.md)，Q-R1/R2/R3 与 Q-M13 已完成 |
| benchmark 自动化 | 🟦 | BM-1/BM-2 已闭环；BM-4 已固化全部 6 个 default-agent case 能力锚点，入口在 [16](./16-refactor-and-benchmark-baseline-plan.md) |
| Behavior Control Loop | ⬜ | 已有专门研究笔记，见 [`topic-behavior-engineering`](../99-research-notes/topic-behavior-engineering.md) |

本文不再维护长施工清单。后续新增治理项应直接进入对应专题文档，避免 14 号重新变成杂物间。

---

## 2. 已完成治理摘要

### C · 文档与版本画像

- 当前包版本校准为 `0.23.0`，不再引用旧 plan 里的 0.5/0.8 进度作为真实状态。
- README / comparison / 10 / 11 / RELEASE 的过期口径已校准。
- `MemoryPort` / `KnowledgePort` / `PromptTrace` 重新评估为不做 framework port：它们属于 host 业务层工具、召回与 fence 组合；framework 只保留通用 ContextTrace / fence / port 边界。

### H/BG/M · 关键 bug 与模型治理

- 子 agent fixed model 不再被父 `ToolContext.modelId` 隐式覆盖；fixed run 禁止自动 fallback 掩盖配置错误。
- `AgentSpec.modelHints` 死字段已删除；fallback policy 后续必须显式、可审计、可测试。
- `GraphExecutor` run lifecycle / graph node telemetry 使用真实 run scope。
- `ToolRegistry.strictInitialization` 已可用于 eval / benchmark fail-fast。
- `MemoryCheckpointer` / `MemoryEventStore` 深克隆、checkpoint local sanitize、错误分类、终态守卫、并发隔离等进入 15 号专项账本。

### LKG · Linnya 语义泄漏

- ToolNode 不再识别具体产品工具名；结束循环由 `StructuredToolResult.control` 声明。
- `deepSearchDepth` 泛化为 `childRunDepth`。
- Linnya 专属的 Tool Conversation scope 保持在 Host adapter；Linnkit 只定义语义无关的 `conversationId`，不认识 `research.instanceId` 或 Artifact 存储。
- system reminder 默认文案去 TaskState / Workspace 语义，host 通过 `contextPolicy.systemReminder.extraRules` 注入产品规则。
- `ToolExecutionContext` / `ToolSchemaContext` / Linnya `ToolContext` 移除 loose index signature，改为真实字段白名单。

### A · 旧 chat execution mode 清理

- 旧 `profiles/chat/*` 与 Linnya host `chats/*` 注册路径已删除。
- 8 类旧单轮能力迁为 tools-disabled agent，集中到 `agents/single_turn/*` 或对应 agent 目录。
- `history_compression` 不再经由 chat resolver。
- runtime / flow / renderer 执行请求不再携带 `mode:'chat'` / `mode:'agent'`。
- 当前前端里的 `chatFlowOrchestrator`、`sendChatMessage`、`ConversationChatSurface` 等命名表达的是产品“对话流”，不是旧 execution mode，不作为债务清理。

### D1 / Q-R3 · 胖控制器拆分

- `runSupervisor.ts` 已从大文件压到 298 行。
- terminal waiter、slot limiter、awaiting-user watcher、boot recovery、detached executor、run record 投影、run registration 等已抽出。
- graph executor 的 step/result、telemetry scope、checkpoint 保存边界、graph-node 与 run-lifecycle telemetry 编排已收敛。
- audit / telemetry 全局副作用已 Port 化。

---

## 3. 已迁出的专题

| 内容 | 去向 |
|---|---|
| 健壮性 / 解耦审计细账 | [15 · 健壮性 / 解耦专项收官账本](./15-robustness-and-decoupling-audit.md) |
| Q-R1/R2/R3 根因重构收官 | [16 · 根因重构收官 + benchmark 自动化入口](./16-refactor-and-benchmark-baseline-plan.md) |
| benchmark 产品化 / SN-5 慢循环基线 | [16](./16-refactor-and-benchmark-baseline-plan.md) |
| Behavior Control Loop / Agent Behavior Engineering | [`topic-behavior-engineering.md`](../99-research-notes/topic-behavior-engineering.md) |
| token ledger 后续 | [13 · token management ledger plan](./13-token-management-ledger-plan.md) |
| 2026 H1 已完成历史与决策 | [10 · history and decisions](./10-history-and-decisions-2026.md) |

---

## 4. 当前剩余尾巴

这些不阻塞进入 benchmark，但需要保持可见：

| 项 | 状态 | 建议 |
|---|---:|---|
| M3 model fallback policy 边界 | ⬜ | 明确哪些错误可自动换模型，哪些固定模型必须失败暴露；禁止恢复隐式 fallback |
| B2-B6 DX / docs / testkit 小修 | ⬜ | CLI 模板、minimal-host 示例、`defineAgentTest()`、quickstart CI smoke、tool calls docs 可按需穿插 |
| PF1-PF3 性能可观测 | ⬜ | context build duration、phaseTiming、prompt cache 元信息仍可补出口 |
| D2-D6 token/cost/replay/permission/detached host 接入 | ⬜ | 各自已有方向，按真实需求拉专题，不塞回 14 |
| LKG7 SystemReminder host registry | ⬜ | 只有当 `extraRules` 不够表达 host 复杂模板时再做 |
| MEM 长期记忆 | ⬜ | host 侧可选模块，不进入 linnkit 主线；framework 只需 fence 注入能力 |
| Q-M15 `TOOL_TIMEOUT` | 🟦 | 等真实工具超时机制施工时再接 `tool.timeout` errorCode |

---

## 5. 下一步

1. 按 [16](./16-refactor-and-benchmark-baseline-plan.md) 进入阶段三 benchmark 自动化。
2. 先做 BM-0 决策确认：runtime 形态、KB 策略、是否立即抽 `packages/agent-bench`。
3. 继续 BM-3 Judge、BM-5 分包与 BM-6 并发统计。当前旧 `post-Q-R-stage-2-initial` 只算装配 baseline；真实能力锚点已覆盖全部 6 个 default-agent case，详见 16 号。
4. Behavior Control Loop 暂不混入 benchmark 主线；若要落地，先把研究笔记摘成独立 framework 协议草案。

---

## 6. 状态登记

- **2026-06-22**：立治理总纲，完成版本画像、兼容债、bug、chat execution mode、benchmark、Behavior Control Loop 等工作面盘点。
- **2026-06-22 ~ 2026-06-24**：按主线完成文档校准、关键 bug 修复、Linnya 语义泄漏清理、旧 chat execution mode 删除、Q-B/Q-M/Q-L/Q-R 专项治理。
- **2026-06-24**：15/16 号文档已压缩成专项收官账本与 benchmark 入口；14 号同步压缩为治理索引。Behavior Control Loop 正文移出本文，统一指向专门研究笔记。
- **2026-06-25**：BM-1/BM-2 已接通纯 Node memory benchmark 主线；BM-4 已把剩余复杂 case 接入 in-memory fixture。SN-5 现有 6 份 N=3 能力 baseline：`post-BM2-smoke-telemetry-artifact-initial`、`post-BM4-cross-domain-initial`、`post-BM4-diligence-conflict-initial`、`post-BM4-monolith-initial`、`post-BM4-localization-initial`、`post-BM4-meta-analysis-initial`。
