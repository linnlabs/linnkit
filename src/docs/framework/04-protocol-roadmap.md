# 04 · 协议层路线图（N-1~N-6 + G-1~G-4）

> linnkit 接下来 12 个月要补齐的 **6 条新协议层（N-x）+ 4 条治理升级（G-x）**。每条都给出问题陈述、接口形态、关键不变量、与目标轴的映射、ROI 评估。

---

## 1. 协议设计原则（强制）

每条新协议层在动手设计前必须答出 4 个问题（继承自 [`../archive/engine-phase-a-to-e/00-engine-scope-audit.md`](../archive/engine-phase-a-to-e/00-engine-scope-audit.md) §1.1 Q1-Q4）：

1. **协议而非实现**：linnkit 出 port + contract test，宿主出实现。除非是"参考实现"（in-memory + 1 个轻量级），否则不内置。
2. **≥ 2 个消费者真实需求**：必须至少 2 个消费者真有需要；不接受单消费者驱动的协议升级。
3. **linnkit 不加就没法接**：宿主能不能在 linnkit 之外 wrap 一层做到？能 → 不进 linnkit。
4. **不破坏既有消费者**：现有不变量不能动。要动先升级不变量再做。

通过门槛后，遵循 4 条**正向原则**：

- **信息丰富**：port 接口带"宿主可能需要的元信息"，不让宿主反向回查
- **可审计**：所有决策走 `AuditEnvelope`（G-1）
- **可回放**：所有写操作是 `RuntimeEvent`，能被 EventStore 持久 + 回放
- **可降级**：每个 port 都有 `noop` 默认实现，宿主可选择不接

---

## 2. 6 条新协议层（N-x）

### N-1. `AgentSpec` / `AgentDescriptor`（一等对象） — P0

**目标轴**：通用化 / 灵活 / 多 Agent

**问题**：当前 agent 是"宿主 registry 里的 promptKey + 工具集"，没有自描述结构；外部很难把 agent 当资源管理；未来 N-2 / N-3 / discovery / capability 协商都缺基础。

**接口形态**（草案）：

```ts
interface AgentSpec {
  id: string;                        // 全局唯一
  version: string;                   // semver
  role?: string;                     // 自由文本（"主秘书" / "调研助手" / ...）
  description?: string;
  capabilities: AgentCapability[];   // ["llm:tools-disabled" | "llm:streaming" | "tool:filesystem" | ...]
  tools: ToolBindingSpec[];          // 引用工具 id + 参数化配置
  contextPolicy: {
    profileId: string;               // 复用现有 context profile 概念
    workingMemoryLimit?: number;
    summarizationStrategy?: string;
  };
  modelHints?: {
    preferredProviders?: string[];
    preferredModels?: string[];
    fallbackChain?: string[];
  };
  lifecycle?: {
    startupHook?: string;            // 注册到宿主的 hook id
    shutdownHook?: string;
  };
  audit?: {
    redactionLevel?: 'none' | 'standard' | 'strict';
    pii?: boolean;
  };
  metadata?: Record<string, unknown>; // 宿主自由扩展
}
```

**与现有协议的关系**：

- `mode: 'agent' | 'chat'` 退役：chat 是 `tools: []` 的 agent；mode 字段从 `AgentInvocationRequest` 删除
- `promptKey` 退役：promptKey 是 `AgentSpec.id` 的别名；`promptKey` 字段从 `AgentInvocationRequest` 删除
- 现有 profile 保留：变成 `AgentSpec.contextPolicy.profileId`

**关键不变量**：

- AgentSpec **可序列化**（JSON）—— 用于 cluster 跨节点发现 / 持久化
- AgentSpec **可版本化** —— 同一 id 多版本可并存
- AgentSpec 的 `capabilities` 字段是**协议级 vocabulary**，不是宿主自由字符串

**ROI**：⭐⭐⭐⭐⭐ —— 代价低（本质是给 promptKey 加描述符层）；后续 N-2 / N-3 / discovery / multi-tenant / SKILL 包装都靠它

---

### N-2. `AgentMessageBus` port（agent-to-agent 异步消息） — P1

**目标轴**：多 Agent 协作 / 集群

**问题**：child-runs 只是父子单向调用；没有 actor mailbox；没有 publish/subscribe；没有"两个 agent 互相对话"。

**接口形态**（草案，actor 风格）：

```ts
interface AgentMessageBus {
  send(toAgentId: string, message: AgentMessage): Promise<void>;
  subscribe(agentId: string, handler: (msg: AgentMessage) => Promise<void>): Subscription;

  // 高级：广播 / 模式订阅
  publish?(topic: string, message: AgentMessage): Promise<void>;
  subscribeTopic?(pattern: string, handler: (msg: AgentMessage) => Promise<void>): Subscription;
}

interface AgentMessage {
  id: string;
  fromAgentId: string;
  toAgentId?: string;     // 直接发送
  topic?: string;         // 广播
  conversationId?: string;
  payload: unknown;
  causedByEventId?: string; // 关联到 RuntimeEvent，用于 audit / replay
  ts: number;
}
```

**为什么是 actor 而非 RPC**：

- 更通用——RPC 形态本质是 actor 的特例（"一次性单消息 + 等回复"）
- 更适合分布式——at-least-once + idempotent handler 比 exactly-once RPC 容易实现
- 解耦时间——发送方不必等接收方在线

**参考实现**：

- 进程内：`InMemoryAgentMessageBus`（基于 EventEmitter）
- 跨进程：宿主可装 Redis Stream / NATS / Kafka 适配器

**关键不变量**：

- 消息走 `RuntimeEvent` 同一脉络，**保持 eventGovernance 四维一致**——mesh 内消息也能 audit / replay
- 消息有 `causedByEventId`，可以反推完整因果链
- subscribe handler 是 idempotent（at-least-once 语义）

**ROI**：⭐⭐⭐⭐ —— 解锁 multi-agent 形态；进程内实现成本低；跨进程是 N-6 之后的事

---

### N-3. `RunSupervisor` 本体 + `RunHandle v2` — P0

**目标轴**：管理 / 健壮 / 集群

**问题**：`RunSupervisor` port 已有，本体未实现；cancel 靠单根 AbortSignal；没有 pause / resume / observe / cost / progress；后台 daemon、定时任务、子 run 树管理、长 run 全部硬阻塞。

**接口形态**（草案）：

```ts
interface RunSupervisor {
  // 注册 / 启动
  registerRun(spec: RunRegistrationSpec): RunHandle;
  spawnDetached(spec: RunRegistrationSpec): RunHandle;

  // 观察
  observeRun(runId: string, filter?: RunObserveFilter): AsyncIterable<RuntimeEvent>;
  peek(runId: string): Promise<PeekRunResult>;
  list(filter?: RunListFilter): Promise<RunMeta[]>;
  runTree(rootRunId: string): Promise<RunTreeNode>;

  // 控制
  cancel(runId: string, opts: CancelOpts): Promise<void>;
  pause(runId: string, reason?: string): Promise<void>;
  resume(runId: string): Promise<void>;

  // 故障恢复
  handleFailure(runId: string, error: unknown, policy?: FailurePolicy): Promise<void>;
}

interface RunHandle {
  readonly runId: string;
  readonly parentRunId?: string;

  cancel(opts: CancelOpts): Promise<void>;
  pause(reason?: string): Promise<void>;
  resume(): Promise<void>;
  observe(filter?: RunObserveFilter): AsyncIterable<RuntimeEvent>;
  cost(): Promise<RunCost>;          // tokens / dollar / latency 累计
  progress(): Promise<RunProgress>;  // currentNode / iterationsUsed / pendingInteractionSpec
  meta(): Promise<RunMeta>;
}

interface CancelOpts {
  reason: string;
  forceCleanup?: boolean;            // hard vs soft cancel
  timeout?: number;
}
```

**与现有 port 的关系**：

- 已有 `RunSupervisor` port + memory + contract test → 实现本体（中枢）
- 已有 `RunRegistryStore` port → 作为 RunSupervisor 内部使用
- 已有 `Checkpointer` → pause / resume 走它

**关键不变量**：

- `cancel(forceCleanup=false)` = soft cancel：跑完当前 tick，节点善后，发出 `run.cancelled` 事件
- `cancel(forceCleanup=true)` = hard cancel：立即 abort，可能丢失 in-flight tool result
- `pause` 不是 cancel：保留 graph state，可以 resume；`pause` 持续期 cost 不计算
- `cost()` 父子聚合：runTree 的 cost 是子 run 之和

**ROI**：⭐⭐⭐⭐⭐ —— 任何后台 daemon / 异步 / 长 run 形态硬阻塞

---

### N-4. `MemoryPort` + `KnowledgePort`（产品中性的记忆抽象） — P1

**目标轴**：通用 / 高级 / 多 Agent

**问题**：行业内已有 8+ 种 memory backend（CC / Codex / Hermes / OpenClaw / mem0 / letta / zep / openmemory），没有产品中性的抽象。

**接口形态**（草案）：

```ts
interface MemoryPort {
  write(scope: MemoryScope, fact: MemoryFact, citations: CitationRef[]): Promise<MemoryRef>;
  search(scope: MemoryScope, query: string, opts?: SearchOpts): Promise<MemoryHit[]>;
  delete(ref: MemoryRef): Promise<void>;

  // 周期性整理
  consolidate?(scope: MemoryScope, opts?: ConsolidateOpts): Promise<void>;
}

interface MemoryFact {
  content: string;
  type?: 'episodic' | 'semantic' | 'procedural';
  importance?: number;
  ttl?: number;
}

interface CitationRef {
  eventId?: string;          // 来源 RuntimeEvent
  sourceText?: string;       // 摘录
  conversationId?: string;
}

type MemoryScope =
  | { kind: 'agent'; agentId: string }
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'tenant'; tenantId: string }
  | { kind: 'shared'; sharedId: string };

interface KnowledgePort {  // 只读 / 静态知识
  search(query: string, opts?: SearchOpts): Promise<KnowledgeHit[]>;
}
```

**关键不变量（向 Codex 学习）**：

- **Memory Citation 强制**：write 必须带 citations，不准凭空写；这是回放与审计的基础
- **memory 写入是 RuntimeEvent**：通过 eventGovernance 落进事件流，自然被 EventStore 持久化、被 DevTools 回放
- **scope 分层**：agent-private / conversation / tenant / shared，对应不同生命周期

**参考实现**（仅 1-2 个，不要走 Hermes 的"8 个 backend 各做一遍"）：

- `InMemoryMemory`：进程内 Map，开发用
- `MarkdownFlatFileMemory`：CC 风格，单文件 Markdown + YAML frontmatter

**ROI**：⭐⭐⭐⭐ —— 长期记忆 / 多 agent 共享 memory 场景硬阻塞

---

### N-5. `PermissionPort` + `SandboxPort` — P1

**目标轴**：健壮 / 易审计 / 灵活

**问题**：当前工具调用是"工具自己决定能不能执行"；没有统一的权限决策点；没有 sandbox 执行能力；"用户审批" 走的是工具内部弹窗（违反协议化原则）。

**接口形态**（草案）：

```ts
interface PermissionPort {
  check(toolCall: ToolCall, context: PermissionContext): Promise<PermissionDecision>;
}

type PermissionDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string }
  | { kind: 'ask'; promptSpec: WaitUserSpec }      // → 走 wait_user 协议
  | { kind: 'sandbox'; policy: SandboxPolicy };

interface SandboxPort {
  run(command: SandboxCommand, policy: SandboxPolicy): Promise<SandboxResult>;
}
```

**关键不变量**：

- **`ask` 走 wait_user 协议**——绝不在工具内部弹窗
- 决策走 `AuditEnvelope`（G-1）——可审计每次允许 / 拒绝 / 沙箱
- `SandboxPort` 只暴露 `run`，**linnkit 不内置任何沙箱实现**——宿主决定是 Seatbelt / bubblewrap / Windows restricted-token / Docker 还是别的

**参考**：

- Codex 的 Execpolicy DSL（Starlark）→ 宿主决策器示例
- Codex 的 Guardian 小 LLM 自动批准 → 宿主可在 `ask` 决策器里接 LLM

**ROI**：⭐⭐⭐ —— 任何"接外部 / 多租户 / 自动化执行"场景的安全模型必需

---

### N-6. `EventBusPort` 跨进程化 — P2

**目标轴**：集群

**问题**：当前 `execution/event-bus` 是进程内 EventEmitter；要做 daemon + 移动端 IM 节点，必须跨进程，但目前没有"event bus port"。

**接口形态**（草案）：

```ts
interface EventBusPort {
  publish(channel: string, event: RuntimeEvent): Promise<void>;
  subscribe(channel: string, handler: (event: RuntimeEvent) => Promise<void>): Subscription;

  // 高级：模式订阅
  subscribePattern?(pattern: string, handler: (event: RuntimeEvent) => Promise<void>): Subscription;
}
```

**关键不变量**：

- channel 命名规范：`run/{runId}` / `agent/{agentId}` / `conversation/{conversationId}` / `tenant/{tenantId}`
- 跨进程消息保留 `eventGovernance`——`persist` / `replayToUi` 标记不变
- at-least-once 语义；handler 必须 idempotent

**参考实现**：

- 进程内：`InMemoryEventBus`（默认）
- 跨进程：宿主自装 Redis Stream / NATS / WebSocket fan-out

**ROI**：⭐⭐ —— 只有迈向 cluster 时才硬需要；P2 是合适优先级

---

## 3. 4 条治理升级（G-x）

### G-1. `AuditEnvelope` 标准化 — P0

**目标轴**：易审计

**问题**：TelemetryPort 只有 4 类 kind 常量 + noop；run 失败 / 模型 fallback / 工具拒绝 / 用户审批 / sandbox 决策 / memory 写入都不是一等审计事件。

**接口形态**：

```ts
interface AuditEnvelope {
  envelopeId: string;
  runId: string;
  parentRunId?: string;
  ts: number;

  actor: AuditActor;          // 谁发起：agent / user / system / tool
  action: AuditAction;         // 做了什么：tool_call / model_call / permission_decide / memory_write / ...
  decision?: AuditDecision;    // 结果：allowed / denied / fallback / retry / ...
  evidence: AuditEvidence;     // 证据：原始事件 id / payload 摘要
  costDelta?: CostDelta;       // 本次 envelope 增加的 cost

  scope: AuditScope;           // tenant / workspace / conversation
}

interface AuditPort {
  emit(envelope: AuditEnvelope): void;
}
```

**关键不变量**：

- 所有"非确定性决策"（工具拒绝 / fallback / sandbox 选择 / memory 写入）都必须发 envelope
- envelope 是**追加只读**（不可修改）
- envelope 默认进 EventStore（per `eventGovernance`），宿主可选择再发到 OTel / SIEM / 文件

**ROI**：⭐⭐⭐⭐⭐ —— 出事时复盘的基础；接入方第一周就会要

---

### G-2. `CostLedger` + `QuotaPort` — P1

**目标轴**：健壮 / 管理

**问题**：`TokenCalculator` 是 internal-only utility；没有"cost ledger"按 run 累计 / 按租户限额 / 按工具统计。

**接口形态**：

```ts
interface CostLedger {
  charge(runId: string, charge: CostCharge): Promise<void>;
  total(runId: string, opts?: { includeChildren?: boolean }): Promise<RunCost>;
  totalByScope(scope: AuditScope, period?: TimeRange): Promise<ScopeCost>;
}

interface CostCharge {
  provider: string;            // "openai" / "anthropic" / ...
  resource: string;            // "gpt-4o" / "claude-sonnet-4" / ...
  tokensInput?: number;
  tokensOutput?: number;
  costUsd?: number;
  latencyMs?: number;
  ts: number;
}

interface QuotaPort {
  check(actor: AuditActor, scope: AuditScope): Promise<QuotaDecision>;
  reserve(runId: string, estimate: CostEstimate): Promise<QuotaReservation>;
}
```

**关键不变量**：

- charge 调用是 RunHandle.cost() 的事实表
- quota 决策走 `AuditEnvelope`
- pause 期间不计 cost

**ROI**：⭐⭐⭐⭐ —— 多租户必需；单用户场景也能受益（每月成本统计）

---

### G-3. Replay SDK + DevTools — P1

**目标轴**：开发易用 / 易审计

**问题**：`replayHarness` 在 testkit 内部；没有公开 SDK；没有可视化工具。

**交付物**：

| 产物 | 形态 | 描述 |
|---|---|---|
| `linnkit/replay` 子入口 | npm export | `replayRun(runId, store) → ReplayedRun`，对外稳定 API |
| DevTools Web | 独立 npm 包 + 静态 SPA | 加载 EventStore 数据，可视化事件流 / 上下文窗口 / prompt diff / tool call diff |
| DevTools 桌面集成 | 可选 | 桌面 app 可内嵌 panel；常驻 daemon 也可开 web port |

**ROI**：⭐⭐⭐⭐⭐ —— 接入方第一天就会要的东西

---

### G-4. PII / Secret Redaction Port — P2

**目标轴**：健壮 / 易审计

**问题**：审计与隐私是同一根管道两端，目前都缺；"多租户 + 外部通道接入"场景必然遇到 PII。

**接口形态**：

```ts
interface RedactionPort {
  redact(text: string, context: RedactionContext): Promise<RedactionResult>;
}

interface RedactionContext {
  pipeline: 'llm-input' | 'tool-input' | 'event-persist';
  scope: AuditScope;
  level: 'none' | 'standard' | 'strict';
}

interface RedactionResult {
  text: string;                    // 处理后
  redactions: RedactionMark[];     // 哪里被改了
  reversible?: boolean;            // 是否可还原（需要 sealed key）
}
```

**hook 位置**：

1. LLM 调用前（输入给模型的 prompt）
2. 工具入参（特别是发外部 API 的工具）
3. 事件持久化（写 EventStore 前）

**ROI**：⭐⭐ —— 单租户场景不急；多租户 / IM 场景必需

---

## 4. 协议成熟度时间线

| 协议 | 设计 | port + memory | contract test | 中枢实现 | 参考实现 | DevTools 接入 |
|---|---|---|---|---|---|---|
| N-1 AgentSpec | F.1 | F.1 | F.1 | F.1 | — | F.2 |
| N-2 AgentMessageBus | G.1 | G.1 | G.1 | G.2 | G.2 in-memory | G.2 |
| N-3 RunSupervisor | F.1 | ✅ 已有 | ✅ 已有 | F.1 | ✅ 已有 in-memory | F.2 |
| N-4 MemoryPort | G.1 | G.1 | G.1 | — | G.2 in-memory + markdown | G.2 |
| N-5 PermissionPort | G.1 | G.1 | G.1 | — | G.1 allowlist | G.2 |
| N-6 EventBusPort | H.1 | H.1 | H.1 | H.1 | H.1 in-memory | — |
| G-1 AuditEnvelope | F.1 | F.1 | F.1 | F.1 | F.1 noop + console | F.2 |
| G-2 CostLedger | G.1 | G.1 | G.1 | G.1 | G.1 in-memory | G.2 |
| G-3 Replay SDK | F.2 | — | — | F.2 | — | G.1 |
| G-4 RedactionPort | H.1 | H.1 | H.1 | — | H.1 noop | — |

> F / G / H 对应 Phase F / G / H，详见 [`07`](./07-roi-ranked-priorities.md)。

---

## 5. 候选协议（待考察，未列入路线图）

### 5.1 reasoning artifact 协议（候选）

让 `plan` / `hypothesis` / `reflection` / `self_critique` 成为一等领域事件。需要先确认：

- 至少 2 个消费者真有这种推理形态？
- 是不是用 `thought` 事件 + 字段足够？

**结论**：暂搁，等 N-1 + N-2 上后再评估。

### 5.2 NodeRegistry 协议（候选）

让用户注册新 graph 节点（`verify` / `critic` / `reflect` / `vote` / `route`）。需要先确认：

- 当前固定 5 节点是不是真的不够？
- 用 child-run + AgentMessageBus 能不能拼出同样形态？

**结论**：暂搁，N-2 上线后大部分场景能用 mesh 解决；只在真的需要"在主 run 里插一个节点"才动 graph。

### 5.3 Skill / Plugin 协议（候选）

让第三方包能注册工具 / 节点 / port adapter。需要 N-1 AgentSpec.capabilities 协议先稳。

**结论**：列入 Phase G 候选，详见 [`06 §5`](./06-developer-experience-roadmap.md)。
