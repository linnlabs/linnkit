# 02 · 现状评估

> 客观、偏严格地评估 linnkit 在 2026-04-23 这个时间点的水平，给打分、列做对的、列没做的。

---

## 1. 总评

> linnkit 当前是国内手搓 agent 框架里少见的"**工程纪律压过功能扩张**"的产物：边界清楚、不变量稳固、可测试性极强；但还停留在 **"单宿主单机内核 + 多 profile 上下文 + 单 agent 主链"** 这一格，离"通用 / 多 agent / 集群"还差几个明确的协议层。

打分（满分 10）：

| 维度 | 现状评分 | 备注 |
|---|---|---|
| 架构纪律（边界 / 不变量 / 守门） | **9** | AST 级 guard、10 条规则、双层 testkit、6 入口公开面，已超过绝大多数同类开源框架 |
| 内核可复用性（runtime-kernel） | **8** | graph loop / tick pipeline / 节点协议 / 事件治理 / 工具协议都已 product-neutral |
| 上下文工程（context-manager） | **8.5** | 三阶段 + working memory + checkpoint 裁剪 + replacementSourceIds 闭环，业界平均之上 |
| 可观测 / 审计 | **5.5** | TelemetryPort 是骨架，缺统一审计事实表与回放 SDK |
| 多 Agent / 协作 | **3** | 只有 child-run 原语，没有 agent mesh / 协议消息 / 角色协议 / 协作策略 |
| 集群 / 分布式 | **2** | EventStore / Checkpointer / RunRegistry 全是本地内存 + SQLite 心智，没有跨进程协议 |
| 开发者体验 | **6.5** | 文档密度极高，但缺"30 行跑起 hello-agent"的 5 分钟入门 |
| 扩展机制 | **6** | port 已布到关键卡点，但 plugin / capability 描述符 / skill 协议尚未抽象 |

**两条加权结论**：

- 如果按**"做对的事的密度"** 加权：8.5 / 10——超过 90% 的开源 agent 框架。
- 如果按**"离 multi-agent / cluster 还差多远"** 加权：6 / 10——P0 + P1 协议层还没补完。

---

## 2. 做对的 6 件事（必须继续守住）

### 2.1 Phase E 真抽包做得很干净

`packages/linnkit/src/*` 是真源；宿主示范 / 默认值留在宿主侧，**没有让任何具体宿主的默认值反向污染内核**。

AST 级 `guard:agent-boundary` 强制 10 条规则，包括：

- 内核不能直接 import 宿主代码
- ports 文件夹不能含实现
- testkit 不能依赖产品代码

这是国内绝大多数同类框架做不到的工程纪律。

### 2.2 6 入口公开面 + Node-only / browser-safe 双形态

```text
linnkit                          # 主入口（Node-only）
linnkit/runtime-kernel/events    # 浏览器安全 slim seam
linnkit/contracts                # 协议类型
linnkit/runtime-kernel           # 完整 runtime
linnkit/context-manager          # 上下文子系统
linnkit/testkit                  # 测试工具
```

**`linnkit/runtime-kernel/events`** slim seam 是少见的成熟设计——把"事件治理纯函数"切给前端用，前端不需要拉整个 Node 依赖。

### 2.3 事件三层模型 + eventGovernance 四维

这是 linnkit **真正的护城河**。

三层：
1. `AnyAgentEvent` —— 业务事件（thought / tool_call / answer / ...）
2. `RuntimeEvent` —— 包了治理元信息的事件（带 `eventGovernance`）
3. 实时通道事件 —— SSE 投影

四维 `eventGovernance`：

| 维度 | 用途 |
|---|---|
| `persist` | 是否进 EventStore |
| `replayToUi` | 是否需要 SSE 回放给 UI |
| `enterAgentContext` | 是否进上下文窗口 |
| `realtimeChannel` | 是否走实时通道 |

**这个设计让 SSE / 持久化 / 上下文准入是同一份事实的不同视图**，绝大多数对手做不到。

### 2.4 两类 checkpoint 严格区分

- **执行控制层 `Checkpointer`**：用于"程序崩了 / 恢复运行"，存的是 graph state、pending tool calls、待 resume 节点
- **上下文工程层"摘要 marker"**：用于"上下文太长了 / 恢复理解"，存的是历史压缩点 + replacementSourceIds

这两件事在 LangGraph 里是糅在一起的。linnkit 的文档专门花一节解释为什么必须切开（被反复教训出来的成熟设计）。

### 2.5 `replacementSourceIds` 数据契约

context-manager 的核心契约：从压缩、净化、摘要、回放全链路用同一把 ID 串起来。

```ts
// 简化示意
type ContextItem = {
  id: string;
  replacementSourceIds?: string[];  // 我替换了哪些原始 item
  // ...
};
```

任何 item（包括摘要、压缩占位、净化结果）都能追溯到原始来源。回放时可以反推"我此刻看到的上下文窗口里，每一段对应原始事件流的哪些条"。

### 2.6 interactive tool → `wait_user` 协议级暂停

通过 `control.requireUser=true` 触发 graph engine 暂停到 `wait_user` 节点，**而不是前端临时 patch**。

这条路通后，未来 `wait_external` / `wait_human` / `wait_subagent` 都是同一条协议泛化：

```ts
// 现在
{ kind: 'wait_user', spec: { ... } }

// 未来
{ kind: 'wait_external', spec: { channel, callbackId, expectedShape } }
{ kind: 'wait_subagent', spec: { childRunId } }
```

---

## 3. 明显短板（按目标关键词归类）

### 3.1 通用化（generality）

- **`AgentInvocationRequest` 仍带宿主气味**：`promptKey`、`mode: 'agent' | 'chat'` 这种字段还在 ports 层
- **没有"Agent 即一等对象"**：当前 agent 是"宿主 registry 里的一条记录 + 一份 prompt + 工具集"，没有 `AgentSpec` 这种自描述结构
- **profile 概念只覆盖 context**，没有覆盖"agent profile"层（角色、权限、可用能力包）

→ 解决方案：[`04 N-1 AgentSpec`](./04-protocol-roadmap.md#n-1-agentspec--agentdescriptor一等对象-p0)

### 3.2 高级 / 灵活

- **没有 plan / reasoning artifact 的一等表达**——`thought` 事件存在，但没有 `plan` / `hypothesis` / `reflection` / `self-critique` 显式领域事件
- **graph 是固定 5 节点状态机**——好的极简 baseline，但没有把"图"做成可扩展 node graph，用户不能注册新节点（`verify` / `critic` / `reflect` / `plan` / `vote` / `route`）
- **child-runs 只解决"我调一个子 agent"**——没有解决"两个 agent 互相对话" / "orchestrator + worker" / "多 agent 共享 working memory"

→ 解决方案：[`03 §1.2`](./03-target-evolution-axes.md) 节点扩展机制 + [`04 N-2 AgentMessageBus`](./04-protocol-roadmap.md#n-2-agentmessagebus-portagent-to-agent-异步消息-p1)

### 3.3 健壮 / 易审计

- **TelemetryPort 只有 4 类 kind 常量 + noop**——没有"标准化的 audit envelope"；run 失败、模型 fallback、工具拒绝、用户审批轨迹都不是一等审计事件
- **没有 cost / token / quota 的一等模型**——`TokenCalculator` 是 internal-only utility，但没有"cost ledger"按 run 累计 / 按租户限额 / 按工具统计
- **没有 PII / secret redaction port**——审计与隐私是同一根管道的两端，目前都缺
- **`Checkpointer` 协议虽然清晰，但只有 memory + SQLite host 实现**——没有 contract test 覆盖"恢复点偏移" / "幂等 append" / "乱序重放"等极端情形

→ 解决方案：[`04 G-1 AuditEnvelope`](./04-protocol-roadmap.md#g-1-auditenvelope-标准化-p0) + [`G-2 CostLedger`](./04-protocol-roadmap.md#g-2-costledger--quotaport-p1) + [`G-4 Redaction`](./04-protocol-roadmap.md#g-4-pii--secret-redaction-port-p2)

### 3.4 管理（生命周期 / 后台）

- **`RunSupervisor` 本体未实现**（自己也明确写为"按需触发"）——这是 后台 daemon 形态、定时任务、主动汇报、子 run 树管理、长 run / 异步 run 的硬阻塞
- **没有 `RunHandle` 的 cancel / observe / resume 完整协议**——目前是 AbortSignal 一根棒子，缺"暂停可恢复" / "软中断 vs 硬中断"分级
- **没有租户 / workspace / actor 隔离的一等 port**——`session_key template` 只在 secretary 文档里调研，没落到 engine

→ 解决方案：[`04 N-3 RunSupervisor`](./04-protocol-roadmap.md#n-3-runsupervisor-本体--runhandle-v2-p0) + session_key template 进 ports

### 3.5 多 Agent 协作 / 集群

- **child-runs 只是父子单向调用**——没有 message bus、actor mailbox、publish/subscribe
- **没有 agent discovery / registry**——第三方装一个 agent 进来需要宿主自己写 adapter
- **没有 capability negotiation**——A 想找一个能写代码的 agent，没有标准方式声明"我能写 TypeScript / 我有 sandbox / 我接受 stream"
- **没有跨进程 / 跨节点的事件协议**——EventBus 是进程内 EventEmitter
- **`session_key` / 多通道 / 多 peer 的会话键模板**只在 secretary 文档里调研，没有进 engine ports

→ 解决方案：[`04 N-2 AgentMessageBus`](./04-protocol-roadmap.md#n-2-agentmessagebus-portagent-to-agent-异步消息-p1) + [`N-6 EventBusPort`](./04-protocol-roadmap.md#n-6-eventbusport-跨进程化-p2) + AgentSpec.capabilities 字段

### 3.6 开发者易用性

- **文档密度高、深度好，但缺"5 分钟跑通 hello-agent"的极简入口**——`INTEGRATION_GUIDE` 5 个例子是好的，但每个都要求接入方先理解 `GraphExecutor`、依赖袋、bridge 这些"成年期"概念
- **没有 CLI**（`linnkit init` / `linnkit run` / `linnkit replay`）
- **没有 DevTools**（事件流可视化、上下文窗口可视化、prompt diff、tool call diff）
- **scriptedAiEngineHarness 是好的测试 primitive，但没有 fluent test DSL**

→ 解决方案：[`06 DX 路线图`](./06-developer-experience-roadmap.md)

### 3.7 优雅（语义债务）

- **chat 兼容层**还存在；冻结已立约但收敛期未启动
- **`linnkitCompat` 仍在根入口**，迁移期兼容面没有截止日期
- **`packages/schemas`** 仍是外部 contract 层；agent 自有协议长期看应该并回 `linnkit/contracts`

→ 解决方案：[`07 Phase F`](./07-roi-ranked-priorities.md#phase-f) 第 4-6 项

---

## 4. 评估结论

linnkit 当前的瓶颈**不是"再雕一遍发动机"**，而是 4 件事按顺序做：

1. 把这台发动机**装进"车身"**：`AgentSpec` 一等对象、`RunSupervisor` 中枢、`AuditEnvelope` 仪表盘
2. 给它**造"车队协议"**：`AgentMessageBus`、`MemoryPort`、`PermissionPort`
3. **把方向盘交出去**：CLI / DevTools / Quickstart
4. **然后**才是开上赛道：cluster / 跨进程 / `wait_external`

详见 [`07 ROI 排序优先级`](./07-roi-ranked-priorities.md)。

---

## 5. 同行水平参照

| 维度 | linnkit | 国内 TS 同类（手搓） | 国际 TS 同类（开源） | 顶级闭源（CC / Codex） |
|---|---|---|---|---|
| 架构纪律 | 9 | 4-5 | 6-7 | 9 |
| 内核可复用性 | 8 | 3-4 | 7 | 8 |
| 上下文工程 | 8.5 | 3-4 | 5-6 | 9 |
| 可观测 / 审计 | 5.5 | 2 | 5 | 8 |
| 多 Agent | 3 | 1-2 | 5-6（LangGraph） | 7 |
| 集群 | 2 | 1 | 3 | 5 |
| DX | 6.5 | 3 | 8 | 9 |

**结论**：linnkit 在**内核纪律、上下文工程**上接近顶级闭源水平；在 **DX、多 agent、集群**上明显落后；在**可审计**上跟国际开源中位齐平但落后顶级闭源。下一阶段的优先级正好对应短板。
