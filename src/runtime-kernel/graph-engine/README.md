# Runtime Kernel Graph Engine

Layer: `runtime-kernel/graph-engine`

本目录负责一次 Agent run 的图执行、节点控制流、checkpoint 与 RuntimeEvent 事实创建。宿主传输、数据库和产品注册不属于这里。

## 1. 领域边界

Graph Engine 负责：

- `GraphExecutor` 的 start / resume / route / yield / pause；
- `LlmNode`、`ToolNode`、`WaitUserNode` 的执行语义；
- tick pipeline、step policy、checkpoint snapshot；
- 节点创建 RuntimeEvent 后调用宿主注入的 `RuntimeEventSink`；
- 把已经发布的同一 RuntimeEvent 放入 graph journal，供 history、child result 和审计 transcript 使用。

Graph Engine 不负责：

- 创建 EventBus、EventSequencer 或 EventStore；
- 把 RuntimeEvent 投影成 SSE；
- 选择持久化策略；
- 解析宿主 Agent registry、模型目录或工具集合；
- 硬编码宿主业务工具名，或管理某个业务工具自己的状态、展示与历史恢复；
- 按事件类型为 root / child 维护不同的补发规则。

## 2. 状态机

当前生产状态机只有四个节点：

| 节点 | 输入 | 控制流结果 |
|---|---|---|
| `user` | 当前请求的 user input | 有输入时 route 到 `llm`，否则 yield |
| `llm` | history、request、tool context | tool calls route 到 `tool`；wait-user route 到 `wait_user`；最终答案直接 yield |
| `tool` | pending tool calls | 同批工具全部结算后回到 `llm`；require-user 转到 `wait_user`；terminate-run 直接 yield |
| `wait_user` | interaction spec 与稳定 run identity | 发布 interaction 事实后 pause |

`AnswerNode` 已删除。完整 `final_answer` 由 `LlmNodeEventBridge` 或 `ToolNodeEventBridge` 创建并发布，不能再增加“Graph 返回答案、Host 重新组装答案”的第二条链。所有可见答案都必须先进入 `final_answer_chunk` live 链；非流式 LLM 和 ToolNode 终答先发布一个 `seq=0,is_last=true` 的 one-shot chunk，再发布 durable `final_answer`。

## 3. RuntimeEvent 主链

节点事件的固定顺序是：

1. 领域边界创建或映射一份 RuntimeEvent；
2. 调用 `runtimeEventSink(event, source)`；
3. sink 返回附着正式 run identity 后的 `RoutedRuntimeEvent`；
4. 节点把该返回对象加入 graph journal；
5. publisher 的消费者独立完成 realtime 与 persistence fan-out。

`RuntimeEventSink` 是 Graph 必需的 run admission port，不是 SSE callback。它的返回值也不是“feedback events”，只表示 admission 接纳并附着身份后的同一事实。可执行 Graph 缺少 sink 必须立即失败；节点、bridge 和 mapper 不得创建默认身份或退回未路由草稿。

所有 Provider / Agent event mapper 永远只创建 `RuntimeEvent` 草稿。mapper context 可以补充不参与路由的 metadata，但不得接收 `routingIdentity`，也不得调用 `routeRuntimeEvent()`。`run_id / parent_run_id / lane / visibility` 只能由 root 或 child lifecycle 装配的 `RuntimeEventPublisher` 附着。

Graph journal 只接收 sink 返回的 `RoutedRuntimeEvent`。`TickOutput` 只返回 decision、executor patch 与 context trace，不携带 `newEvents`；否则 callback 发布与 tick return 会重新形成两个事件出口。

Host 可以在 publisher 前用一个 execution-scoped sink 为所有来源统一补充 `activity`、`runtime_trace` 等非路由 metadata；该 wrapper 不得附着或改写顶层 routing identity。`run_id / parent_run_id / lane / visibility` 始终由 execution 的 `RuntimeEventPublisher` 统一提交，避免 wrapper、mapper 与 publisher 出现多个身份 owner。

Host 自己创建的 incoming fact（例如 HITL 提交的 `tool_output`）不属于 Graph 生成结果。它必须先通过 `RuntimeEventPublisher.route` 取得正式身份，再 durable commit；commit 成功后使用 `publishRouted` 进入同一个 EventBus fan-out，并标记为非 generated journal 事件。禁止先持久化无 run identity 的 payload，再在实时链复制另一份不同身份的事件。

发布失败、schema 失败和序号失败必须向上传播。失败事件不得进入 journal，run 也不得继续进入 completed。

## 4. 字段所有权

| 字段 | 唯一 owner | 其他层允许做什么 |
|---|---|---|
| `answer_id` | LLM streaming adapter；非流式终答由终答创建边界生成 | mapper、node、host 只透传 |
| `final_answer_chunk.seq` | LLM streaming adapter；非流式终答创建边界 | 从 0 连续；下游只验证、不改写 |
| `run_id / parent_run_id / lane / visibility` | Host root / child lifecycle admission | 对应 execution 的 `RuntimeEventPublisher` 附着正式字段 |
| EventEnvelope `seq` | `EventSequencer` | SSE 投影为 `execution_seq`，不得覆盖答案 seq |
| `conversation_id / turn_id` | Host request / run bootstrap | 节点映射时复制，不从 active 全局状态猜测 |

核心身份和关键操作语义禁止放在 metadata。metadata 只承载不参与路由、并发隔离、生命周期、所有权判断或副作用目标选择的扩展材料。产品 workflow 若需把 child 映射到业务目标，应在启动前从已校验 DTO 建立显式映射，再以正式 `subrun_id` 查找；Graph 不解释该业务绑定。

## 5. LLM 事件与完整答案

`LlmNodeEventBridge` 是 LLM callback 到 RuntimeEvent 的单次映射边界。

- 每个 stream chunk 只映射、发布和记账一次；
- chunk 必须带非空 `answer_id` 和从 0 连续的 `seq`；
- `FinalAnswerAssembler` 只做确定性文本拼接，不生成答案身份，不发布，不持久化；
- 工具决策到来前，必须先结算当前答案段，再发布 `tool_call_decision`；
- provider 最终响应到来时，有 chunk 就结算已有段；没有 chunk 时由 LlmNode 发布 one-shot chunk，再发布非流式完整事实；
- ToolNode 的 `control.finalAnswer` 同样先发 one-shot chunk，禁止 Renderer 或 read model 从 `tool_output` 再造答案；
- 中断或异常时，已经输出的 chunk 结算为 `is_complete=false` 的完整答案；
- 完整答案必须原样拼接 chunk，不能 trim 或改写文本，否则 live 与 reload 不一致；
- Renderer 收到完整答案时只能校验同 `answer_id` 的 chunk 内容并把临时 live 消息 id 提交为 durable event id，不能用完整正文补造缺失的 live 流；
- provider reasoning details 作为 final answer 或 tool decision 的正式 sidecar 保存，不从 thought 文本反推。
- provider 正常完成、回调报错或取消都必须封口已经开始的 thought 段；完成事件使用同一个 `thought_message_id`。Renderer 不得根据 transport end、run status 或组件卸载补造 thought 终态。
- LLM 终态 error 由 `LlmNodeEventBridge` 映射、发布和 journal 一次；发布后的 classified fact 通过 `RuntimeFailureFactSink` 交给 Host lifecycle。该 sink 只观察同一事实，不发布、不持久化、不附着 routing identity；Execution settlement 不得补造第二条 run-level error。

## 6. Tool 与 WaitUser

`ToolNodeEventBridge` 在发布前完成 idempotency metadata、attachments、ephemeral 等事实字段，publisher 之后禁止再修改 payload。

`tool_call_decision` 只表示模型已经提交一组工具调用，不表示其中每个调用都已开始执行。普通 `ToolNode` 按 decision 中的顺序串行消费，只有对应的 `tool_process(phase=start)` 才表示某个调用实际启动；工具内部显式使用 batch API 时，批内并发由该工具自己的合同负责。

一个 decision 进入 Agent 上下文后，其中每个 `tool_call_id` 都必须最终配对一条 `tool_output`。用户取消串行 batch 时，若工具已返回正式结果就按该结果结算；若执行抛出 `AbortError`，ToolNode 必须先为当前调用发布“执行中取消”的 error output，再为尚未启动的 pending calls 发布“执行前取消”的 error output，最后才允许原 AbortError 离开节点。Host settlement、EventStore projector 与 Renderer 都不得扫描 loading 行并补造结果。

Root 与 child 共享上述事实出口。Child lifecycle 进入 completed / failed / cancelled 前必须依次 drain child persistence 与 parent trace projection，确保刚发布的工具终态同时进入 child truth 和 parent trace；父 execution 的 EventBus persistence 仍由父 lifecycle 自己持有和 drain，不能把两条管线合成隐式的全局 manager。

Graph 与 ToolNode 只理解通用的工具调用、执行过程、结构化结果和 `StructuredToolResult.control`。宿主业务工具名对 Runtime 没有内置含义：不得因为某个业务工具需要“记住状态”，就在 Linnkit 增加专属 RuntimeEvent、SSE variant、ToolContext 字段或硬编码 history retention。宿主可以通过通用 tool history policy 按正式 `tool_name` 配置保留范围，工具自己的状态只能由正式工具事实或宿主产品存储表达。

`WaitUserNode` 只创建一份 `requires_user_interaction` RuntimeEvent：

- interaction 业务字段 `run_id` 来自 `toolContext.runId`；它不负责决定 lane / visibility；
- 节点通过 runtimeEventSink 发布；
- pause 返回的 journal event 必须与 sink 返回对象是同一引用；
- 节点不构造 SSE DTO，Host 不按 type cherry-pick 补发；
- 同步 child-run 不支持 wait-user，必须明确失败并交给 foreground run。

## 7. Root 与 Child

root、resume 与 child 共用相同节点事实语义。

- root Host 注入 `RuntimeEventPublisher`，EventBus 消费发布事实；
- child lifecycle 始终创建独立的 `RuntimeEventPublisher + EventSequencer + EventBus`，并向 Graph 只注入窄 `RuntimeEventSink`；
- quickstart、benchmark 和 testkit 必须显式装配 sink；公共 `createGraphLoopHarness` 不创建默认 run identity；
- child 事实先进入 child EventBus，再由共用 persistence consumer 按 child run 落盘；
- parent trace projector 是 child EventBus consumer，通过父 publisher 生成 read model，不参与 child admission；
- parent trace 是 child 事实的额外投影，不是第二份 child truth；二者以 `source_event_id` 一一关联；
- child result 与 transcript 从 graph journal 构建；
- parent 只有通过显式 trace publisher 或工具结果才能看见 child 过程；
- 不允许依据“root 还是 child”改变 NodeResult.events 的事件含义。

Host 必须在 composition root 选择 execution runtime scope，把同一批 Supervisor、EventStore、cursor factory、CostCollector、Audit 与同一装配点的 Telemetry 显式交给 root 和 child。Host 若另有 incoming-fact 写入口，它必须通过 adapter 落到同一个底层事实源；Graph 集成测试也必须遵守这一点。禁止执行编排器或 child lifecycle 内部读取进程全局端口，因为生产装配“碰巧相同”会掩盖测试、runtime 重建和其它 host 的跨作用域双事实源。

需要递归 child 的 Host 应在 composition root 创建一次 child invoker，并通过 ToolContext capability 注入。派生 child ToolContext 继承该实例；缺少 capability 时调用必须在 admission 前失败。模块级默认 invoker、执行期 global getter 与隐式 Memory fallback 都会破坏实例生命周期隔离。

## 8. Checkpoint

checkpoint 只保存可序列化状态。`memory`、`runtimeEventSink`、`signal`、`summarizationCallbacks`、`toolContext` 会在 snapshot 时移除。

稳定 host run 使用 `runId` 作为 checkpoint key。同步 child-run 使用独立内部 key 隔离图状态，但 RuntimeEvent 的 conversation / run identity 必须使用真实宿主身份，不能用 checkpoint key 代替。

## 9. 扩展规范

新增或修改节点事件时必须依次完成：

1. 在 Linnkit contracts 定义或复用 RuntimeEvent schema；
2. 确定事实创建者和每个字段 owner；
3. 在节点边界只映射一次；
4. mapper 只产 draft，经 RuntimeEventSink admission 后把返回的 routed 对象写入 journal；
5. 在 event governance 定义 persistence、replay、context、realtime 行为；
6. 增加业务测试，至少覆盖顺序、身份、失败传播和 root / child 一致性；
7. 同步更新本 README、integration realtime 文档和 Conversation 架构文档。

新增可见 child 调用方时，工具只提供 prompt、执行策略和非关键展示 metadata，并统一调用宿主公开的 registered-subagent orchestration。工具不得自行构造 trace publisher、手写 child→parent 映射或从结果数组补发过程事件。

## 10. 禁止项

- 禁止节点直接 import Host realtime / persistence / registry。
- 禁止节点创建 SSE DTO 或直接写数据库。
- 禁止 Host 从 NodeResult.events 按 type 补发。
- 禁止 persistence-only 正常业务链。
- 禁止 publisher 之后修改 RuntimeEvent。
- 禁止客户端、Host 收尾或 Graph 为已经提交的 incoming fact 再合成第二份 RuntimeEvent。
- 禁止 execution-scoped wrapper 与 publisher 重复附着 routing identity。
- 禁止 mapper context、Graph local 或 bridge 持有 routing identity。
- 禁止 `TickOutput`、Node 内部 collector 或 run 结束补写形成第二事件出口。
- 禁止吞掉 publisher、schema、sequence 或 persistence 错误。
- 禁止为 root、resume、auxiliary、child 分别实现事件创建逻辑。
- 禁止用 stepCount、数组位置或 active conversation 推断业务身份。
- 禁止按宿主业务工具名在 Graph、Context Manager、RuntimeEvent、SSE 或 ToolContext 中增加内置特例。
- 禁止把新业务规则塞入 `ToolNode` 主文件；按 execution setup、event bridge、state transition、governance 等既有边界归类。
- 禁止把 `tool_call_decision` 当成实际执行开始；调度、Telemetry 与 UI 运行态只能以 `tool_process(start)` 或 ToolNode 自身 pending state 为准。
- 禁止 run 取消时遗留没有 `tool_output` 的 assistant tool call；这会同时破坏 provider 历史配对与 durable UI 终态。
- 禁止 Host execution 编排器自行选择或回退 EventStore；Store 与 cursor factory 必须由 composition root 显式注入。
- 禁止 child invoker 或 lifecycle 按需读取全局 runtime；root、child、递归 child 必须继承同一个显式 scope。

## 11. 回归门禁

修改本模块至少运行：

- LLM bridge 的 chunk、工具边界、partial answer 与 publisher failure 测试；
- Tool bridge 的单次发布与失败传播测试；
- WaitUser 单次发布与 pause 测试；
- Graph loop 的工具成功、工具失败、多工具、step policy 测试；
- 串行多工具执行中取消后，未启动调用仍有 error output，SQLite 重开后没有 loading 工具行；
- provider 在 thought delta 后以普通错误结束时，仍发布同身份的 completed thought；
- child-run result / trace / wait-user 边界测试；
- root / child 相同 scripted flow 的事实集合与终态 parity 测试；
- child fact 与 parent trace 的 SQLite replay 一一对应测试，以及 persistence / projector 失败阻止 completed 的测试；
- 两套 host runtime scope 并发执行时，EventStore、Audit、Supervisor 与递归 child capability 互不泄漏的测试；
- Linnkit TypeScript 检查。

测试应验证业务事实集合和顺序，不要锁内部方法调用、旧节点名或无业务意义的快照。
