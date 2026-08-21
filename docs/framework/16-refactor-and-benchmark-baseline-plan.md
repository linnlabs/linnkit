# 16 · 根因重构收官 + benchmark 自动化入口

> 立项：2026-06-23。
> 性质：阶段二收官索引 + 阶段三 benchmark 施工入口。
> 关系：14 号是治理收官索引；15 号记录质量治理和 Q-R 根因重构结果；本文只保留进入 benchmark 开工需要的最短路线。

---

## 1. 当前进度盘

| 模块 | 状态 | 备注 |
|---|---:|---|
| 阶段一 SN-1..SN-4 快循环安全网 | ✅ | context 物化、tick stage、supervisor×graphLoop、side-effect Port 已守住 |
| Q-R1 MessageProcessingState 分层 | ✅ | 原始 message 不再被 provider mutate |
| Q-R2 typed stage 契约 | ✅ | reads/writes、patch、middleware patch、typed reads DTO 已完成；字段分层为可选增强 |
| Q-R3 supervisor / graph executor 拆分 | ✅ | supervisor 298 行；核心模块与 orchestration 已抽出 |
| Q-M13 Audit / Telemetry Port | ✅ | kernel 生产路径不直接写全局 recorder / ALS |
| Q-L3 / L4 / L6 / L7 | ✅ | SSE、类型单源、dead config、preprocessor 收敛完成 |
| Q-M15 error code 可观测 | 🟦 | 3/4 已接通；`TOOL_TIMEOUT` 待真实超时功能 |
| SN-5 慢循环能力基线 | 🟦 | 能力锚点归属 electron real-chain（待真跑）；6 个 case 的 memory N=3 结果仅作**冒烟样本，不作能力锚点、不 gate**；旧 `post-Q-R-stage-2-initial` 仅作装配 baseline |
| 阶段三 BM benchmark 自动化 | 🟦 | BM-1/BM-2 已闭环；BM-4 headless fixture 已覆盖全部 6 个 case |

**结论**：阶段二已经具备收官条件。接下来不要继续在已完成的 Q-R/Q-L 上打转，应该转入 benchmark 产品化和能力基线。

### 1.1 进入 benchmark 前完成了什么

14/15/16 三份文档覆盖的是同一段阶段二收官工作：先把历史治理线收干净，再修执行内核的真实风险，最后把根因重构做成可持续维护的结构。进入 benchmark 前，主要完成了四类工作。

| 工作 | 改造内容 | 最终效果 |
|---|---|---|
| 治理与边界清理 | 旧计划校准到 `0.23.0`；旧 chat execution mode 删除；Linnya 产品语义从 linnkit kernel 下沉；dead config / dead mapper / 类型双源清理 | 文档和代码口径一致；framework 不再背 host 产品概念；后续接入方看到的是更干净的公共协议 |
| 真实 bug 与健壮性修复 | error 事件不进 agent context；终态覆写守卫；HTTP 错误分类修正；流式失败 attempt 隔离；工具幂等并发互斥；checkpoint / event store 深克隆 | 执行结果更可信，失败不会污染下一轮上下文；重试、终态、持久化、幂等这些底层语义更稳 |
| 并发与生命周期补强 | per-transport EventBus；按 runId checkpoint 串行；observe 按 runId 过滤；supervisor `maxActiveRuns` 与 concurrencyKey 背压；逻辑终态释放 handle/controller/slot | 多 run 共存时不串事件、不漏 slot；awaiting_user 可跨 transport 恢复；长 run / 并发 benchmark 有基础承压边界 |
| 根因重构 | Q-R1 context state 实体/DTO 分层；Q-R2 tick stage reads/writes + patch；Q-R3 supervisor / graph executor 拆分；Q-M13 Audit/Telemetry Port 化 | 胖控制器变薄，共享可变状态减少，副作用从隐藏全局变成显式 Port；后续 benchmark 接线不需要先拆地基 |

阶段二最重要的效果不是“修了很多点”，而是把 linnkit 的核心运行链路从“能跑”推进到“可测、可观察、可并发承压、可继续演进”：

- **输入上下文可信**：provider 不再原地改历史 message，trace before/after 可信。
- **tick 流程可约束**：stage 读写边界自声明，runner 只接受声明内 patch。
- **run 生命周期可信**：终态、等待、取消、detached、恢复、背压都有独立模块和 contract test。
- **观测出口可替换**：audit / telemetry 不再绑定全局 recorder 或 ALS，host 可以用自己的 adapter 收集。
- **benchmark 前置风险已降到可控**：剩余项多为策略或产品化问题，核心 runtime 不再是黑盒大球。

因此阶段三 benchmark 的目标不再是“先证明内核没坏”，而是开始衡量 agent 的慢循环能力：质量、稳定性、成本、并发表现和回归趋势。

---

## 2. 安全网资产

这些测试是后续重构 / benchmark 接线时继续保护内核的快循环：

| 编号 | 文件 | 守护内容 |
|---|---|---|
| SN-1 | `contextMaterialization.golden.test.ts` | 最终 `AiMessage[]` 物化、原始实体不可变、trace before/after 可信 |
| SN-2 | `stageContract.test.ts` | tick stage reads/writes 声明与实际写入一致 |
| SN-3 | `supervisorGraphLoop.e2e.contract.test.ts` | supervisor × graphLoop 生命周期串联：正常、cancel、detached |
| SN-4 | `sideEffectIsolation.test.ts` | audit / telemetry 经显式 Port 出口 |

建议每次动 runtime-kernel 关键路径时至少跑：

```bash
cd packages/linnkit
npx vitest run \
  src/context-manager/shared/__tests__/contextMaterialization.golden.test.ts \
  src/runtime-kernel/graph-engine/tick-pipeline/__tests__/stageContract.test.ts \
  src/runtime-kernel/graph-engine/tick-pipeline/__tests__/sideEffectIsolation.test.ts \
  src/testkit/__tests__/supervisorGraphLoop.e2e.contract.test.ts
npm run typecheck
```

---

## 3. 阶段二收官摘要

### Q-R1 · Context State 分层

目标：消除 `MessageProcessingState` 同时承载处理状态和可变 message 实体的混用。

当前事实：

- `processedContent` 已删除。
- `message/originalIndex` 已 readonly。
- 内容覆盖统一为 `overrideContent ?? message.content`。
- `ToolPairTruncator` 不再原地改 `message.content`。
- SN-1 B/C 已从红灯判据转为正式测试。

### Q-R2 · Tick Pipeline Typed Contract

目标：从共享大可变袋转为显式 reads/writes + patch。

当前事实：

- 五个真实 stage 都声明 `reads/writes`。
- runner 校验 patch key 必须属于 stage `writes`。
- 五个 stage 均已迁为返回 patch。
- `build_decision` 的事件累加通过 runner `appendNewEvents` 表达，保留原数组引用。
- middleware 只允许返回窄 `TickMiddlewarePatch`，当前仅 `executorLocalPatch`。
- `defineTickStage` 已提供 typed reads DTO 和 typed patch 约束。

可选增强：进一步拆分跨 stage 字段与 stage 内临时字段。目前不阻塞 benchmark。

### Q-R3 · Supervisor / Graph Executor 拆分

目标：削薄胖控制器，隐藏全局副作用 Port 化。

当前事实：

- `runSupervisor.ts` 已压到 298 行。
- 已抽模块：`terminalWaiterRegistry`、`runSlotLimiter`、`awaitingUserWatcher`、`runRecovery`、`detachedRunExecutor`、`runRecordProjection`、`runRegistration`。
- graph executor 已抽：`prepareGraphStep`、`resolveGraphStepResult`、`graphTelemetryScope`、checkpoint 保存边界、`runGraphNodeWithTelemetry`、`runWithLifecycleTelemetry`。
- Q-M13 已完成：audit / telemetry 均走 Port。

---

## 4. Benchmark 产品目标

一句话：benchmark 是 linnkit / linnya 的 **agent 能力回归台**。

目标用户：

- 开发者：看维度分、定位退化。
- 外部 coding agent：能通过 CLI 批量跑、读机器可读结果、自动迭代 agent。

核心目标：

1. **可定量**：输出结构化分数，不靠感觉。
2. **可稳定度量**：支持多 trial、pass@1 / pass@k / pass^k、置信区间。
3. **可批量并发**：跑 `(suite × agent × model × task × trial)` 矩阵。
4. **可创建 / 可扩展**：声明式新增 benchmark，不改框架。
5. **可回放**：开发环境可把 run 入对话库，按 runId 回放。

非目标：

- 不做公开 leaderboard。
- 不做实时在线监控。
- 不为了评测在业务链路里塞 `if (benchmark)` 分支。

---

## 5. BM-0 调研结论

调研时间：2026-06-24。覆盖 `src/testkit/default-agent-benchmark/*`、Flow run hook、renderer dev 入口、SQLite/Qdrant/KB 装配、外部 eval 框架实践。

一句话结论：benchmark 不是从零开始，已有 case、指标、规则评分、Judge、reporter、CLI 和 UI dev 入口；但它现在是 **真实产品链路 benchmark + UI 旁路观测** 的混合体。进入阶段三不能直接抽大包，也不能直接上 CI；第一刀应先把 **benchmark core** 和 **host adapter / runtime fixture** 的边界切出来。

### 5.1 现有资产分级

| 资产 | 现状 | 分级 | 处理建议 |
|---|---|---:|---|
| `cases/*` + `case_registry.ts` | 6 个 case 覆盖 smoke、跨领域研报、尽调冲突、单体重构、本地化合规、医学 meta-analysis | 接线就用 | 保留；补 case manifest / fixture SoT |
| `benchmarkObservationCollector.ts` | 从 RuntimeEvent + LLM telemetry 采集 steps、tool、sub-agent、checkpoint、citation 等指标 | 接线就用 | 可作为 core 模块迁出；少量 host artifact URI helper 需抽 port |
| `scoreComposer.ts` + rules | 通用规则 + case-specific 规则，规则/Judge 60/40 融合 | 接线就用 | 保留规则优先；Judge 不进硬门禁 |
| `jsonReporter.ts` | CLI 已用，输出 suite JSON + Markdown | 接线就用 | 增 suiteName/config/baseline 字段 |
| `benchmarkCli.ts` | 能跑单模型 × 单/全部 case，输出 JSON/Markdown | 小改可用 | 保留为真实链路 runner；另加纯 Node runner |
| `benchmarkMatrixRunner.ts` | 已有 `models × cases × repeats` 顺序矩阵 | 小改可用 | 接 CLI；补 synthetic failure result 与计划运行数 |
| `comparisonReporter.ts` | 能消费 suite result 输出多模型对比 | 小改可用 | 接矩阵 CLI；修展示顺序；补 baseline diff |
| `judgeRunner.ts` | `--judge-model` 可触发 5 维 LLM Judge | 小改可用 | 改为可采样、可预算、可重试记录；默认关闭 |
| UI `BenchmarkRunHook` | dev-only 旁路观测，报告写 `_dev_data/benchmark-results` 并回填 `stream_end.stats.benchmark` | 小改可用 | 保留为人工调试入口；不要作为 CI 主入口 |
| `packages/agent-bench` | 尚不存在 | 不立即抽 | 先在原地切 seam，边界稳定后再分包 |

没有发现需要推倒重写的模块。最大的问题不是功能缺失，而是依赖方向混在一起：benchmark core 反向 import host/renderer/Flow 细节，导致它很难成为 coding agent 可稳定调用的工具。

### 5.2 两条入口不是同一个东西

| 入口 | 调用链 | 优点 | 局限 |
|---|---|---|---|
| UI dev 入口 | renderer 选择 `benchmark_case_id` → Flow run hook → `stream_end.stats.benchmark` | 最贴近真实用户路径；Agent 不知道自己在被测；适合人工观察 | 依赖 Electron/UI/真实项目/真实 KB；不是批量 runner |
| CLI 入口 | `pnpm benchmark:default-agent` → Electron-as-Node → `benchmarkCli.ts` 自己 bootstrap FlowOrchestrator | 可无头跑真实链路；已有 JSON/Markdown | 不走 `BenchmarkRunHook`；当前强绑 SQLite/Qdrant；不是纯 Node |

关键事实：

- UI 入口通过 `options.benchmark_case_id` 触发 `BenchmarkRunHook`。
- CLI 构造的 request 不带 `benchmark_case_id`，因此不会产生 `stream_end.stats.benchmark`，它自己采集指标、评分、写报告。
- 两者共用 collector / scorer / reporter，但运行入口和生命周期不同。后续文档和 CLI 帮助必须明确区分：**UI = 旁路观测 benchmark；CLI = 批量 runner benchmark**。

### 5.3 依赖与侵入点

| 点位 | 事实 | 结论 |
|---|---|---|
| SQLite / better-sqlite3 | 当前 CLI 初始化 `DatabaseService`、`SQLiteEventStore`、`SQLiteRunRegistryStore`；package script 用 Electron runtime 跑，目的是避开 native ABI mismatch | 当前 CLI 必须 Electron；但业务语义不要求 Electron |
| `persist:false` | CLI 的 `runBenchmark()` 调 `FlowOrchestrator.next(..., { persist:false })` | 只是不持久化对话事件；run registry / runtime singleton 仍可能写 SQLite，不能等同“无 DB” |
| Qdrant / KB | CLI 装配真实 `QdrantAdapter`、SQLite metadata、SoT、KnowledgeGraph、`KnowledgeBaseCoordinator` | 适合绝对能力评估；不适合 CI/SN-5 默认链路 |
| in-memory KB | 工具侧统一从 `ToolContext.knowledgeBaseService` 读搜索/文档能力 | stub 整个 `KnowledgeBaseService` 是最干净入口；不要 stub 工具内部 |
| renderer 侵入 | dev 菜单、`conversationState.benchmarkCaseId`、`chatFlowOrchestrator` 透传、assistant service 透传 | 用户路径侵入低；代码依赖层还需把 benchmark core 从 host hook 反向 import 中抽离 |
| run hook | `FlowOrchestrator` side-effect import 注册 `BenchmarkRunHook` | 适合作为 host 扩展点；长期应让 hook 依赖 benchmark port，不直接依赖 testkit 内部路径 |

### 5.4 外部实践对照

外部 eval 工具给出的共同分层很一致：

- LangSmith 把 evaluation 拆成 dataset、evaluator、experiment，并支持 repetitions / concurrency / caching；repetitions 会展示平均值和标准差。
- Inspect AI 把 samples、epochs、epochs reducer、retry、日志恢复作为一等能力，`inspect eval-set` 支持失败重试与续跑。
- OpenAI evals/graders 文档强调 eval 要把期待标准显式化，grader 可组合；同时官方也提醒生成式模型有随机性，不能把单次输出当传统确定性测试。

对 linnkit 的落地含义：

1. case/task definition、tested configuration、run records 必须分层。
2. repeats/trials 不是 nice-to-have，是阶段三基线的必要字段。
3. Judge 是软评分补充，不应默认作为硬门禁。
4. raw transcript/events/logs 必须可保存，报告默认看结构化指标。

参考：
[LangSmith Evaluation](https://docs.langchain.com/langsmith/evaluation) / [Experiment configuration](https://docs.langchain.com/langsmith/experiment-configuration)、
[Inspect AI eval-set](https://inspect.aisi.org.uk/eval-sets.html) / [inspect eval options](https://inspect.aisi.org.uk/options.html)、
[OpenAI evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices) / [Graders](https://developers.openai.com/api/docs/guides/graders)。

---

## 6. 已拍板决策

### D1 · Runtime 形态

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---:|
| A. 纯 Node + Memory runtime + in-memory KB | CI/coding agent 友好；绕开 Electron/SQLite/Qdrant；最适合 SN-5 回归 | 不是完整产品链路；需要做 benchmark host adapter | ✅ 主线 |
| B. Vitest 包装跑 benchmark | 能复用测试 runner / snapshot / fixture | 长任务 + 真 LLM 不适合塞进测试进程；报告/退出码语义别扭 | ❌ 不作为主线 |
| C. Electron 包装真实链路 | 与产品最一致；现在已经能跑 | native ABI/Qdrant/真实 DB 依赖重；不适合 CI/coding agent 默认 | 🟦 保留为绝对评估入口 |

最终策略：**双入口**。BM-1 已把默认 `benchmark:default-agent` 切到纯 Node + memory runtime，用于 SN-5、CI dry-run、coding agent；Electron 真实链路保留为 `benchmark:default-agent:real-chain`。

#### D1 修订 · 2026-06-25（能力锚点改走 electron real-chain，memory 降级冒烟）

原 D1 把"纯 Node + memory"当能力主线。试跑后发现这条主线测不到真实 default-agent，故修订如下，并以本修订为准：

- **事实澄清**：`benchmark:default-agent:real-chain` 已经是 CLI——它通过 `ELECTRON_RUN_AS_NODE=1` 用 Electron 自带的 node 跑 `benchmarkCli.ts`，无 GUI、无窗口。借 Electron 的**唯一**原因是 `better-sqlite3` 原生模块的 ABI 对齐；Qdrant 本来就是独立 HTTP 服务，纯 Node 也能直连，**从来不是阻塞点**。真正卡纯 Node 的是 app 后端的进程内 Electron 单例（DatabaseService / agentRuntimeSingletons / pathManager / SQLite event store）。
- **保真度不可兼得**：真实 default-agent 能力 = 真 prompt（`promptKey='default'`）+ 真工具 + 真 KB + 真 child run，这套就是重后端本身。"零重依赖随处跑"与"真实能力"无法同时满足。
- **决策**：**真实 default-agent 能力锚点统一走 `benchmark:default-agent:real-chain`，且只在能装 Electron + 起 Qdrant 的环境（开发机 / 满足条件的 CI）运行。** 不再投入"纯 Node 跑真实能力"（抽后端服务 / 换 sqlite 实现）；除非将来出现"必须在装不了 Electron 的受限沙盒里测真实能力"的硬需求，再单独立项评估。
- **memory 降级**：memory runtime 降为**流水线冒烟 harness**，只验证 benchmark 本身（采集 / 评分 / 落 manifest / diff）是否正确，**不代表真实 default-agent、不作能力锚点、不进任何 gate**。memory 用占位 prompt + 桩工具，与真实 default-agent 的 prompt / 工具白名单 / KB 都不一致，禁止据 memory baseline 推断真实能力。

### D2 · 是否现在抽 `packages/agent-bench`

结论：**缓抽**。

原因：现在 benchmark core 仍 import host artifact helper、Flow 类型、Judge prompt、Logger 等内部路径。立刻分包会把未切开的 host seam 带进新包，制造一个“伪独立包”。

施工策略：

1. BM-1/BM-2 在原目录先切出 `definitions / functions / runner / host-adapters` 边界。
2. BM-4 后，core 只依赖 `linnkit` 公共契约和窄 ports。
3. BM-5 再物理抽 `packages/agent-bench`。

### D3 · KB / Qdrant headless 策略

| 模式 | 用途 | 实现 |
|---|---|---|
| `kbMode: in-memory` | SN-5、CI、coding agent 默认 | `KnowledgeBaseService` stub，从 case fixture 内存文档返回稳定搜索结果 |
| `kbMode: qdrant-fixture` | 绝对能力评估、人工 benchmark | 真实 Qdrant + SQLite metadata + SoT；需要导入/检查 fixture |
| `kbMode: linked-project` | UI dev 入口 | 继续走当前项目关联知识库 |

主线先做 `in-memory`。Qdrant fixture 不阻塞 baseline/diff，等 CLI 稳定后做。

### D4 · LLM Judge 策略

结论：**Judge 默认关闭，作为采样软评分**。

当前风险：

- 每个 case 最多 5 次 Judge 调用，矩阵成本按 `models × cases × repeats × dimensions` 放大。
- 维度逐个串行，默认 60s timeout；超时 race 不保证取消底层 provider 调用。
- 事件摘要只保留部分工具时间线和 500 字 final answer，Judge 看不到完整 artifact。
- JSON 解析失败会给 50 分，容易掩盖 Judge 故障。

施工口径：

- BM-1/BM-2 只用规则分和结构化指标。
- BM-3 再做 `judgeMode: off | sampled | full`、`judgeSampleRate`、`judgeBudget`、`judgeDimensions`。
- Judge 结果必须记录 model、prompt/rubric version、raw response、parse status、cost。

### D5 · 低侵入业务代码

保留当前原则：benchmark 不改变 agent 正常行为。

但要收敛依赖方向：

- Flow 主链路只知道 `RunLifecycleHook`，不直接知道 benchmark scoring/reporting。
- `BenchmarkRunHook` 只做 host adapter：收集 raw events / telemetry，调用 benchmark port。
- benchmark core 不 import Flow/renderer/electron-main 内部路径。
- CLI host adapter 负责真实 FlowOrchestrator 或 Memory harness 装配。

---

## 7. 三层数据模型

### 7.1 Task Definition

描述“要测什么”，稳定、可复用、可版本化。

最小字段：

- `caseId / suiteId / version`
- `name / description / difficulty / dimensions`
- `userPrompt / optional documentFragment`
- `fixtures`: `kbFixtureId / workspaceFixtureId / memorySeeds`
- `expectedArtifacts / expectedBehaviorPath`
- `scoringWeights / ruleSetVersion`

当前 `BenchmarkCaseDefinition` 已接近 Task Definition，只缺 fixture 实体化和 version 字段。

### 7.2 Tested Configuration

描述“这次用什么配置测”。

最小字段：

- `agentId / promptKey / modelId`
- `runtimeMode: memory | electron-real`
- `kbMode: in-memory | qdrant-fixture | linked-project`
- `maxSteps / maxActiveRuns / timeoutMs`
- `trialCount / concurrency / intervalMs`
- `judgeMode / judgeModelId / judgeDimensions`
- `gitCommitHash / appVersion / schemaVersion`

当前 `RunEnvironment` 太薄，只记录了模型、promptKey、maxSteps、maxCheckpoints；BM-1 需扩展。

### 7.3 Run Records

描述“一次运行实际发生了什么”。

最小字段：

- `runId / matrixRunId / trialIndex`
- `caseId / testedConfigId`
- `startedAt / finishedAt / status / failure`
- `metrics`
- `score`
- `artifacts summary`
- `rawEventsPath / transcriptPath / auditPath`
- `judgeResults[]`

当前 `BenchmarkRunResult` 可作为 Run Record 起点；需要补 matrix/trial/config 引用和 raw artifact 路径。

---

## 8. 阶段三施工总图

### BM-1 · CLI 产品化与入口分流

目标：让 coding agent 能稳定调用纯 Node benchmark，同时保留真实链路 benchmark。

施工前对齐（三个细节先定，避免施工中纠结）：

- **默认 runtime / 入口隔离**：`pnpm benchmark:default-agent` 默认走 `--runtime memory`（零外部依赖、CI/coding agent 友好）；Electron real-chain 通过独立 npm script（建议 `benchmark:default-agent:real-chain`）暴露，不依赖 `--runtime electron-real` 这一个参数避免误触发。两个 script 共用 CLI 入口但默认 runtime 不同。
- **`benchmarkHostFactory` interface 最小化**：实际落地只暴露 `runtime`、`createRunner()`、`dispose()`。`createConversationContext` / `createKnowledgeBaseService` 没有被执行链真实消费，已避免变成伪抽象；memory / electron-real 各自在 adapter 内部装配自己的环境。
- **退出码**：`0` 成功 / `1` 通用失败（参数 / 环境 / 运行任一失败都归到 1）/ `2` 回归门禁失败（仅 `--fail-on-regression` 触发时）。单 case 失败默认归 `1`，不再静默 `exit 0`。`2` 这个码让 CI 能区分「benchmark 跑炸」vs「agent 真退化」。

提交拆分：

1. ✅ `benchmarkCliArgs`：已补 `--models`、`--matrix`、`--repeats`、`--interval-ms`、`--format json|markdown|both`、`--fail-on-regression`、`--runtime memory|electron-real`。args 解析失败走退出码 1 + 友好 stderr。
2. ✅ `benchmarkHostFactory`：CLI 只依赖窄 host port；memory/electron-real host 均通过动态 import 延迟加载，`--list-cases` 不再加载 AIEngine / SQLite / Qdrant。
3. ✅ `memoryBenchmarkHost`：新增纯 Node memory runtime，使用 linnkit graph loop + 真实 LLM caller。BM-1 先接 smoke 最小工具面；BM-4 已扩成覆盖 6 个 default-agent case 的 case-aware fixture 和复杂 case 工具面。
4. ✅ `matrixCli`：`benchmarkMatrixRunner` 已接进 CLI，输出 `suite.json` + `comparison.md`；补 synthetic failure result、planned/completed/synthetic failure 计数、trialIndex。
5. ✅ `exitPolicy`：实现 `0/1/2` 退出码约定；JSON / Markdown 报告写入本次退出码及触发原因。

验收：

```bash
pnpm benchmark:default-agent --list-cases
pnpm benchmark:default-agent --case smoke_summary --format json   # 默认 memory
pnpm benchmark:default-agent --matrix --models cloud-deepseek-v4-flash --suite smoke --repeats 1
pnpm benchmark:default-agent:real-chain --case smoke_summary       # 显式走 Electron real-chain
```

退化场景测试（确保非 0 退出码触发）：后续 BM-2 接 baseline diff 后，故意制造 regression，断言 `--fail-on-regression` 退出码 = 2 且报告包含「regression」字样。

### BM-2 · Baseline + Diff + SN-5

目标：阶段二后第一次慢循环能力基线可保存、可比较。

施工前决策（已按此落地第 1 段）：

- **schema 边界**：`TaskDefinition` / `TestedConfiguration` / `RunRecord` 三个独立 zod schema，加 `BaselineManifest` 聚合 schema。后续 BM-3/4/5/6 可只 import 自己关心的层，不被 manifest 锁死。
- **版本策略**：顶层 `manifestVersion` 控制文件格式；三层 DTO 各自有 `schemaVersion`。版本不匹配时 fail-fast，迁移工具后续再单独补。
- **字段策略**：紧派 schema，只放 BM-2 baseline/diff 当前真实需要的字段。Judge 在 BM-2 只能是 `off`，采样与 raw judge record 到 BM-3 再扩。
- **一致性契约**：manifest 内 run 必须归属同一个 task/config，`trialIndex <= trialCount`；失败 run 必须带 failure，成功 run 不能带 failure。
- **目录约定**：`benchmark-results` 作为 store 根目录；单次 run 写入 `runs/<isoDate>-<runId>.json`，固化基线写入 `baselines/<label>/<caseId>.json`，diff 写入 `comparisons/<label-a>-vs-<label-b>/<caseId>.diff.json`。CLI 调用方已把 root 分成两类：run records 默认落 `_dev_data/benchmark-results/runs/`（本地/CI artifact，不进 git），shared baselines/comparisons 默认落仓库根 `benchmark-results/{baselines,comparisons}/`（进 git，作为团队共享锚点）。
- **diff 策略**：BM-2 使用 `simple_threshold`，结构化输出 `regression | noise | improvement | insufficient_data`。阈值随 comparison 文件落盘；bootstrap/CI 等统计方法留到后续阶段显式扩 schema。

提交拆分：

1. ✅ `baselineSchema`：新增 baseline manifest，记录 Task Definition + Tested Configuration + Run Records；schema 使用 zod strict 校验并带契约测试。
2. ✅ `baselineStore`：标准目录 `benchmark-results/{runs,baselines,comparisons}/...`；当前实现 read/write/list，不包含 diff 逻辑。
3. ✅ `compareToBaseline`：输出 score/token/duration/tool/error 维度 diff；Judge 维度仍待 BM-3 接入。
4. ✅ `sn5Baseline`：CLI 已把真实 run 结果投影并写入本地 run record store；`smoke_summary` 曾用 `cloud-deepseek-v4-flash` 在 memory runtime 跑出 N=3，3/3 `passed`，并固化到 `_dev_data/benchmark-results/baselines/post-Q-R-stage-2-initial/smoke_summary.json`。该旧 baseline 生成时 LLM telemetry 和 artifact summary 仍缺线，只能证明装配可用，**禁止作为 SN-5 能力 diff/gate 锚点**。采集修复后已用 `post-BM2-smoke-telemetry-artifact-initial` 在 memory runtime 重跑 N=3，3/3 `passed`，并写入仓库根 `benchmark-results/baselines/` 以便 git 跟踪：三轮 `score=68`，`llmCallCount=6/5/4`，`totalTokens=9801/6490/6661`，workspace 文档 `1/1/1`，citation `0/0/2`。本阶段 baseline **只观察、不 gate**；BM-4 已补齐剩余 5 个复杂 case 锚点。
5. ✅ `reportRegressionSummary`：`--compare-baseline <label>` 会读取 shared baseline store，生成 `comparisons/<old>-vs-<current>/<caseId>.diff.json` 与 `.diff.md`；Markdown 明确展示“真实退化 / 随机波动 / 数据不足 / 改进”。默认只观察；同时传 `--fail-on-regression` 才把 `verdict=regression` 映射为退出码 2。

已知缺口：

- smoke 规则分仍可能约 68：模型完成检索与写文档，但不稳定遵守标题“快速摘要.md”和正文引用要求。该分数现在反映 agent/任务遵循表现，不再是 collector 把 telemetry/artifact 记成 0。
- RunRecord v1 只保存 workspace 文档数量和 refs，不保存标题/字数；BM-2 第 5 段报告摘要若要解释 `workspace_document_keywords`，需要读取 suite JSON 或显式扩 baseline schema。
- CLI 默认模型依赖云端模型 catalog，若 catalog 拉取超时，`cloud-*` 模型不会进入 registry；baseline 固化时应显式指定当前 catalog 中存在的模型 ID。

### BM-3 · Judge 采样与成本控制

目标：把 Judge 从同步附加项变成可控软评估。

提交拆分：

1. `judgeConfig`：`off | sampled | full`，支持 dimensions、sampleRate、maxJudgeCalls、timeout。
2. `judgeRecord`：保存 raw response、parse status、judge prompt version、model、耗时、token。
3. `judgeCancellation`：给 LLM call 传 AbortSignal 或 provider 可取消能力；不能取消时文档标注。
4. `judgeVariance`：同一维度多 Judge 或多 trial 时输出均值/标准差，不进硬门禁。

### BM-4 · Fixture 与 KB Headless

目标：让 in-memory KB 成为 CI/SN-5 默认。

提交拆分：

1. 🟦 `caseFixtureManifest`：当前先以 `memoryCaseFixtures.ts` 承载 6 个 default-agent case 的版本化内存文档；后续再把 fixture id/version 显式并入 case schema。
2. ✅ `memoryBenchmarkTools`：只实现工具链真实使用的方法，放在 benchmark feature 的 host adapter 内；复杂 case 已统一为 `task_write` / Knowledge search-read / `list_files` / `read_file` / `delegate` / `write_file` / `edit_file` / `sheet_write_range` / `context_checkpoint`。子任务通过 Workspace inode 交接，不再模拟已退役的 SharedMemory/Resource 工具。
3. ✅ `fixtureSearchIndex`：最小关键词/标签检索已接通，不模拟复杂向量能力。
4. ✅ `fixturePrecheck`：未配置 fixture 的 case 会 fail-fast，不静默退回 smoke 数据。
5. `qdrantFixtureMode`：真实 Qdrant 入口保留，但移到非默认 profile。

BM-4 已用 memory runtime 跑出全部 5 个复杂 case 的 N=3 结果（按 D1 修订，这些是 **memory 冒烟样本，非能力锚点、不 gate**；memory 用占位 prompt + 桩工具，不等于真实 default-agent）：

| Baseline label | Case | N=3 结果 | 观察 |
|---|---|---|---|
| `post-BM4-cross-domain-initial` | `cross_domain_research` | 3/3 passed，分数 `52/40/37`，总 tokens `110,981` | 能跑通 KB/resource/taskstate/workspace，但多产物、checkpoint、引用稳定性仍是 agent 能力缺口 |
| `post-BM4-diligence-conflict-initial` | `diligence_conflict` | 3/3 passed，分数 `51/52/51`，总 tokens `87,895` | 冲突材料可被检索和读取，分数稳定；citation 仍为 0，属于任务遵循表现 |
| `post-BM4-monolith-initial` | `monolith_rearchitecture` | 3/3 passed，分数 `49/25/39`，总 tokens `127,667` | 单体架构材料可检索；多文档交付、审查委派、checkpoint 使用不足，分数波动明显 |
| `post-BM4-localization-initial` | `localization_compliance` | 3/3 passed，分数 `59/43/42`，总 tokens `259,745` | 多语言合规材料可用；模型常用 Markdown 交付，未稳定使用 `sheet_edit` / 子任务 / SharedMemory |
| `post-BM4-meta-analysis-initial` | `meta_analysis_trial_design` | 3/3 passed，分数 `27/37/43`，总 tokens `197,319` | 医学文献筛选 fixture 可用；多轮搜索、证据快照、citation 仍是主要能力缺口 |

暂缓项：`qdrantFixtureMode` 仍未做；真实 Qdrant fixture 只用于后续绝对能力评估，不阻塞 memory SN-5。

### BM-5 · `agent-bench` 分包

前置条件：BM-1 到 BM-4 完成，core 不再 import host 内部路径。

提交拆分：

1. 新建 `packages/agent-bench`：schemas、runner、matrix、scoring、reporters、baseline diff。
2. root host adapter 留在 `src/testkit/default-agent-benchmark`。
3. 加 boundary guard：`agent-bench` 只能依赖 `@linnlabs/linnkit` 公共契约和自身代码。
4. README 分流：通用 agent-bench 文档 vs Linnya default-agent benchmark 文档。

### BM-6 · 多并发与承压

目标：验证 15 号并发契约在 benchmark 场景下成立。

提交拆分：

1. `workerPool`：并发度、rate limit、provider 429 backoff。
2. `resourceIsolation`：每 worker 独立 conversation/run/workspace/kb fixture。
3. `concurrencyContractBench`：验证事件不串、slot 释放、handle 不线性增长。
4. `passK`：输出 pass@1、pass@k、pass^k、bootstrap CI。

---

## 9. 验收门槛

阶段三第一批完成时应满足：

- 纯 Node CLI 可启动并列出 case；BM-1 memory smoke 运行入口已接通，`smoke_summary` 慢循环基线已在 BM-2/SN-5 固化。
- 输出 JSON 可被外部 coding agent 直接消费。
- 可保存 baseline，并对 current 生成 diff。
- 支持至少 N=3 trial，并报告均值/方差。
- SN-5 可跑出阶段二后能力基线；BM-4 后已覆盖全部 6 个 default-agent case。
- UI dev benchmark 仍可用，但与 CLI runner 明确分工。
- `packages/linnkit` 快循环安全网继续全绿。

---

## 10. 状态登记

- **2026-06-24 BM-0 调研**：确认现有 benchmark 资产可复用，无需推倒重写；当前最大问题是 real-chain CLI 强绑定 SQLite/Qdrant/Electron，且 benchmark core 与 host adapter 依赖方向混杂。阶段三主线拍板：先做纯 Node + Memory runtime + in-memory KB 的 runner；保留 Electron real-chain 入口；`packages/agent-bench` 缓抽，等 seam 切稳后再物理分包；Judge 默认关闭，作为采样软评分。
- **2026-06-25 BM-1 施工**：默认 `benchmark:default-agent` 已切到纯 Node + memory runtime；新增 `benchmark:default-agent:real-chain` 保留 Electron/SQLite/Qdrant 产品链；CLI 轻入口只做 args/case/host/report/exit，host adapter 延迟加载；matrix 接入 CLI 并补 synthetic failure / planned count；退出码 `0/1/2` 与报告 metadata 已落地。
- **2026-06-25 BM-2 第 4 段**：新增 baseline manifest 投影与 `--baseline-label` 写入路径；只允许单 case × 单 model 的矩阵 run 固化 baseline，失败 run 会被 schema/projection 拒绝。`smoke_summary` 以 `cloud-deepseek-v4-flash` 跑 N=3，3/3 passed，生成 `post-Q-R-stage-2-initial/smoke_summary.json`。复查后确认该旧 baseline 仅证明装配可用，不可作为能力锚点。
- **2026-06-25 BM-2 数据保真修复**：memory runtime 的 `GraphAgentExecutor` telemetry port 已接入 runner，`write_file/edit_file` artifact summary 已接入 workspace 文档摘要与稳定 inode；真实 smoke 单 trial 已从 `llmCallCount=0,totalTokens=0` 修正到 `llmCallCount=5,totalTokens≈7k`。
- **2026-06-25 BM-2 smoke 能力锚点**：默认 writer 已把本地 run records 与共享 baselines 拆开；run records 落 `_dev_data/benchmark-results/runs/`，baseline manifest 落仓库根 `benchmark-results/baselines/`。`post-BM2-smoke-telemetry-artifact-initial/smoke_summary.json` 已用 N=3 固化，3/3 passed，平均分 68，只观察不 gate。
- **2026-06-25 BM-2 comparison 摘要**：新增 `baselineComparisonReporter` 与 CLI `--compare-baseline` 接线；comparison JSON/Markdown 落仓库根 `benchmark-results/comparisons/`。`--fail-on-regression` 仅在 comparison verdict 为 `regression` 时退出 2，默认不 gate。
- **2026-06-25 BM-4 fixture 扩展**：新增 case-aware `memoryCaseFixtures` 与 `memoryBenchmarkTools`，memory runtime 不再只有 smoke 最小工具面；先支持 `smoke_summary`、`cross_domain_research`、`diligence_conflict`，未知 case fail-fast。`cross_domain_research` N=3 baseline 已固化到 `post-BM4-cross-domain-initial`，`diligence_conflict` N=3 baseline 已固化到 `post-BM4-diligence-conflict-initial`。
- **2026-06-25 BM-4 收尾 fixture**：补齐 `monolith_rearchitecture`、`localization_compliance`、`meta_analysis_trial_design` in-memory fixture；memory runtime 新增真实 `sheet_edit` 写表产物与 artifact summary 识别，工具定义抽到 `memoryBenchmarkToolDefinitions.ts` 控制文件规模。三份 N=3 baseline 已固化到 `post-BM4-monolith-initial`、`post-BM4-localization-initial`、`post-BM4-meta-analysis-initial`。至此 memory 冒烟样本覆盖全部 6 个 case（按 2026-06-25 D1 修订，仅为冒烟样本，非 SN-5 能力锚点）。
- **2026-06-25 保真度与 CLI 边界定档（D1 修订）**：试跑暴露"memory CLI 跑得通但测不到真实 default-agent"。核对确认 real-chain 已是 electron-as-node 的 headless CLI（`ELECTRON_RUN_AS_NODE=1`），借 Electron 仅为 `better-sqlite3` ABI，Qdrant 是独立 HTTP 服务非阻塞。拍板：真实能力锚点统一走 `benchmark:default-agent:real-chain`，仅在可装 Electron + 起 Qdrant 的环境运行；不再投入纯 Node 跑真实能力。memory runtime 降级为流水线冒烟 harness，占位 prompt + 桩工具，**不代表真实 default-agent、不作能力锚点、不 gate**；BM-4 那 6 份 memory N=3 结果改口径为冒烟样本。详见 §6 D1 修订。

---

## 11. 未压缩到本文的内容

- 14 号只保留治理索引，不再承载 benchmark 细节。
- 15 号保留质量治理收官账本，不再保留逐提交流水。
- Behavior Control Loop 正文在 [`topic-behavior-engineering.md`](../99-research-notes/topic-behavior-engineering.md)，不混入本文 benchmark 主线。
- 更细的历史施工记录以 git commit / PR review 为准。
