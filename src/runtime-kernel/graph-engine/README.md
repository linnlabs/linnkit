# Runtime Kernel Graph Engine

Layer: `runtime-kernel/graph-engine`

这里是后端 Agent 运行时最核心的一层：图执行引擎。

如果要理解"一次 run 为什么会在 llm、tool、wait_user、answer 之间切换"，就应该看这里。

---

## 1. 模块定位

本目录负责：

- `GraphExecutor`
- `tick-pipeline`
- 各类 graph nodes
- graph local state
- memory checkpointer

本目录不负责：

- 宿主默认装配
- SSE / persistence 收口
- 产品上下文构建
- 默认 ToolRegistry 选择

---

## 2. 核心职责

1. 驱动一次 graph run 的主循环
2. 在 pipeline 中把 llm 调用拆成稳定阶段
3. 让 `LlmNode` 与 `ToolNode` 各自承担单一职责
4. 在不依赖宿主细节的前提下表达 stepPolicy、节点切换与 child-run 接入点

---

## 3. 关键边界 / 不变量

1. graph-engine 只定义运行时执行协议，不定义宿主默认装配
2. 节点类不应继续回退到 host 默认 port
3. `ToolNode` 主骨架保持薄，policy / governance / bridge 优先拆子模块
4. child-run 在这里是原语接入点，不是已注册 agent 的宿主解析层
5. `requireUser` 是通用暂停协议，不是问卷专属；任何工具都可以通过 tool result 的 `control.requireUser=true` 进入 `wait_user`

---

## 4. 详细目录树

```text
packages/linnkit/src/runtime-kernel/graph-engine/
├── README.md
├── engine.ts                         # GraphExecutor 主循环
├── executor.ts                       # GraphAgentExecutor 与依赖袋
├── executorContextBuilder.ts         # 最小上下文构建合同
├── graphLocal.ts                     # graph local 读取合同
├── types.ts                          # graph-engine 核心类型
├── checkpointer/
│   ├── base.ts                       # checkpointer 最小接口
│   └── memoryCheckpointer.ts         # 内存实现
├── tick-pipeline/
│   ├── runTickPipeline.ts            # pipeline 主入口
│   ├── helpers.ts                    # tick 级 helper
│   ├── types.ts                      # pipeline 类型
│   ├── stages/
│   │   ├── prepareCallStage.ts
│   │   ├── buildContextStage.ts
│   │   ├── applySystemReminderStage.ts
│   │   ├── executeLlmStage.ts
│   │   └── buildDecisionStage.ts
│   └── middlewares/
│       ├── contextAuditMiddleware.ts
│       ├── llmTelemetryMiddleware.ts
│       └── runModelLockMiddleware.ts
└── nodes/
    ├── llmNode.ts
    ├── llmNode.state.ts
    ├── llmNode.eventBridge.ts
    ├── toolNode.ts
    ├── toolNode.executionSetup.ts
    ├── toolNode.eventBridge.ts
    ├── toolNode.helpers.ts
    ├── toolNode.protocolFuse.ts
    ├── toolNode.observationGovernance.ts
    ├── toolNode.stateTransitions.ts
    ├── toolNode.finalAnswerProjector.ts
    ├── answerNode.ts
    ├── userNode.ts
    └── waitUserNode.ts
```

---

## 5. 真实执行链

### 5.1 GraphExecutor 主循环详解

`GraphExecutor.runUntilYield(conversationId)` 是整个 graph run 的入口：

```
加载 checkpoint + ephemeral locals
  │
  ▼
for (stepCount < maxSteps)
  │
  ├─ 检查 AbortSignal
  ├─ 注入 executorLocal（stepCount / remainingSteps / phase / checkpointCount）
  ├─ 收尾策略判断：
  │    ├─ finalStepPolicy='final_answer' → 最后一步强制切到 llm（force_final_answer）
  │    └─ finalStepPolicy='force_tools' → 倒数第二步切到 llm（force_tools）
  │
  ├─ node.run(state) → NodeResult
  │    ├─ kind='route' → 切到 nextNodeId，保存 checkpoint，continue
  │    ├─ kind='yield' → 保存 checkpoint，返回所有事件
  │    └─ kind='pause' → 保存 checkpoint，返回所有事件（wait_user 专用）
  │
  ├─ _checkpointStepReset=true → 重置 cycleStepCount（context_checkpoint 触发）
  │    └─ 最多重置 maxCheckpoints 次
  │
  └─ 达到步数上限 → 强制结束，保存 checkpoint

返回 { events, checkpoint, stepCount }
```

**关键不变量**：

- checkpoint 保存时会 sanitize：删除 `memory` 和 `sseSink`（不可序列化的运行时引用）
- `ephemeralLocals` 只存在于单次 `runUntilYield` 调用期间，不持久化
- 所有节点产出的 events 在主循环中聚合，最终一次性返回
- `absoluteMaxSteps = maxSteps * (maxCheckpoints + 1)` 是硬性上限，防止无限循环

### 5.2 节点状态机

五个节点构成完整的状态图：

```
                ┌─────────────┐
                │    user     │ ── 检查 newEvents 中是否有 user_input
                └──────┬──────┘
                       │ route → llm
                       ▼
                ┌─────────────┐
         ┌──────│     llm     │──────┐
         │      └──────┬──────┘      │
         │             │             │
    tool_calls    final_answer   wait_user
         │             │             │
         ▼             ▼             ▼
   ┌──────────┐  ┌──────────┐  ┌───────────┐
   │   tool   │  │  answer  │  │ wait_user │
   └────┬─────┘  └──────────┘  └───────────┘
        │             │              │
        │           yield          pause
        │
        ├─ ToolNode 内部 drain 完本批 pendingToolCalls
        ├─ 无剩余 calls → route → llm（回 LLM 继续推理）
        ├─ requireUser=true → route → wait_user
        └─ terminateRun=true → yield
```

### 5.3 节点详细职责

#### `UserNode`

- 检查 `newEvents` 中是否存在 `user_input`
- 有则 route → llm，无则 yield
- 不产出任何事件

#### `LlmNode`

- 通过 `LlmNodeReasoner.tick()` 执行一次 LLM 推理
- 内部使用 `llmNode.state.ts` 的 reducer 模式管理状态（answerId / chunkSeq / streamRuntimeEvents）
- 通过 `LlmNodeEventBridge` 将 tick 事件转为 `AnyAgentEvent` 回调给 sseSink
- 决策输出：`tool_calls` / `final_answer` / `wait_user` / `yield` / `error`
- `forceFinalAnswer` 时禁用工具，强制产出文本回答
- `forceTools` 时限制可用工具列表

#### `ToolNode`

- 消费当前 `pendingToolCalls` batch，直到本批工具调用全部产生对应的 `tool_output` 后才回到 LLM
- 单个工具失败只生成该工具自己的 error `tool_output`，不能中断同批后续工具调用
- protocol error 熔断只能在本批工具调用消费完成后生效，避免形成 `assistant.tool_calls` 中有 call 却没有 sibling `tool_output` 的不完整协议组
- 当前实现按顺序 drain batch；即使 provider 一次返回大量并行 `tool_calls`，也不通过 GraphExecutor 步数逐个消耗，避免 `maxSteps` 提前截断工具协议
- 子模块拆分（**后续改工具执行主链，优先改子模块，不要塞回 `toolNode.ts`**）：
  - `executionSetup`：解析工具调用、准备上下文
  - `eventBridge`：发出 tool_process / tool_output 事件
  - `observationGovernance`：执行期结果预览治理；当 observation 超过 20,000 字符或 1,200 行时落盘到 ToolOutputStore，并返回短预览与续读指引
  - `protocolFuse`：连续协议错误熔断（防止 LLM 反复发出无效调用）
  - `stateTransitions`：构建成功/失败/requireUser 的 local state
  - `finalAnswerProjector`：某些工具结果可直接投影为最终答案
- `context_checkpoint` 工具执行成功时设置 `_checkpointStepReset=true`

#### `AnswerNode`

- 读取 `local.finalAnswer`，生成 `final_answer` RuntimeEvent
- 返回 yield

#### `WaitUserNode`

- 读取 `local.pendingInteractionSpec`，构造 `requires_user_interaction` 事件
- 保存 `resume_request_snapshot` 到事件 metadata（用于恢复上下文）
- 把 `metadata.run_context.runId` 写进事件，供 `RunSupervisor` / host runner 把 `RunRecord.status` 联动为 `awaiting_user`
- 返回 pause

### 5.4 一次 tick 的阶段化流程（tick-pipeline）

LlmNode 内部的推理由 `runTickPipeline` 驱动：

1. `prepareCallStage` — 准备 LLM 调用参数（工具定义、请求配置）
2. `buildContextStage` — 构建上下文窗口（history → context manager → messages）
3. `applySystemReminderStage` — 注入系统提醒（剩余步数、最后一步提示等）
4. `executeLlmStage` — 发送 LLM 请求，处理流式响应
5. `buildDecisionStage` — 解析 LLM 响应，产出结构化决策

`buildDecisionStage` 还有一个 provider sidecar 不变量：

- 如果 LLM 响应同时包含 `tool_calls` 和真实 `reasoning_details`，必须把 `reasoning_details` 写入 `tool_call_decision.payload.reasoning_details`
- 这个字段不是调试信息，而是下一轮 provider replay 的协议材料
- graph-engine 只负责把事实事件写完整，不负责理解 DeepSeek / Gemini 的私有字段语义
- 后续 context-manager 会把它回放到 `AiMessage.metadata.reasoning_details`，再由 `formatAgentLlmMessages(...)` 放回同一条 `assistant(tool_calls)` 消息

middlewares 在 pipeline 周围提供横切治理：

- `contextAuditMiddleware` — 上下文审计日志
- `llmTelemetryMiddleware` — LLM 调用遥测
- `runModelLockMiddleware` — 运行时模型锁定

### 5.5 `requireUser` / `wait_user` 正式协议

`requireUser` 不是"前端 loading 卡片"的特判，而是一条正式的 runtime 协议：

1. 工具返回完整 `StructuredToolResult`
2. 其中 `result.control.requireUser=true`
3. `ToolNode` 把 `pendingInteractionSpec` 写入 local state，并直接 route 到 `wait_user`
4. `WaitUserNode` 发出 `requires_user_interaction`
   - 它只表示"run 已 pause，等待用户继续"
   - 不承担卡片数据职责；卡片应从 `tool_call.arguments` 恢复

后续用户提交 `approve / modify / submit / skip` 时，会开启新的 turn，并以唯一那条 `tool_output` 回复事件继续执行；卡片侧读取 `metadata.interaction`，执行侧读取 `output/payload`。

### 5.6 EngineLocalState 核心字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `conversationId` | string | 当前会话 ID |
| `turnId` | string | 当前轮次 ID |
| `request` | AgentInvokeRequest | 当前请求（经过 enrich） |
| `toolContext` | ToolExecutionContext | 工具执行上下文 |
| `history` | RuntimeEvent[] | 历史事件列表（含本轮 newEvents） |
| `newEvents` | RuntimeEvent[] | 本轮新增事件 |
| `executorLocal` | ExecutorLocalState | 执行器级状态（stepCount / phase / policy） |
| `pendingToolCalls` | StandardToolCall[] | 待执行的工具调用 |
| `pendingInteractionSpec` | Record | requireUser 时的交互规格 |
| `finalAnswer` | string | 最终答案文本 |
| `answerId` | string | 当前答案 ID |
| `signal` | AbortSignal | 中断信号 |
| `sseSink` | function | 事件回调出口（AgentEventBridge 包装） |
| `summarizationCallbacks` | object | 摘要回调 |

### 5.7 sseSink 事件回调协议

`sseSink` 是 graph-engine 到 host 层的唯一事件出口：

- 类型签名：`(evt: AnyAgentEvent) => RuntimeEvent[] | void`
- 由 `AgentEventBridge.createSink()` 创建，注入到 `EngineLocalState.sseSink`
- 节点通过调用 `sseSink(event)` 将 `AnyAgentEvent` 发出
- 返回值 `RuntimeEvent[]` 用于 feedback events（如 tool_output 需要回灌到 history）
- sseSink 内部完成：`AnyAgentEvent → RuntimeEvent → EventEnvelope → EventBus → SsePort → SSE`

**标准**：

- 所有节点产出的运行时事件必须通过 sseSink 出口
- sseSink 不直接发 SSE，它只触发 EventBus 管道

---

## 6. 最容易放错层的改动

1. 默认 ToolRegistry / default ports
   - 这是 host-adapter，不是 graph-engine
2. `ToolContext` 产品字段
   - 这是 tools/context/product 边界，不是 graph-engine
3. `stream_end` 与 SSE 结束时机
   - 这是 Flow host session，不是 graph-engine
4. persistence 策略
   - 这是 host persistence adapter，不是 graph-engine
5. 把交互工具结果塞进 `tool_process(update)` 再指望前端自己记住
   - 这会导致重启后只剩"等待中"外壳
   - interactive tool 的可恢复初始数据必须能从 `tool_call.arguments` 重建，提交态再叠加 `metadata.interaction`

---

## 7. 禁止项

1. **禁止** 在节点类中直接 import host 层模块（persistence / realtime / registry）
2. **禁止** 把 `sseSink` / `signal` / `memory` 写入 checkpoint（sanitize 会删除，但源头就不应写入）
3. **禁止** 在 `ToolNode` 中直接修改 `executorLocal.stepCount`（由 GraphExecutor 主循环管理）
4. **禁止** 绕过 `sseSink` 回调直接发送 SSE（`WaitUserNode` 是唯一的协议级例外）
5. **禁止** 在新增工具执行逻辑时把代码塞回 `toolNode.ts` 主文件（优先拆子模块）
6. **禁止** 在 graph-engine 中定义具体工具集合或默认模型目录

---

## 8. 开发注意事项

1. 改 graph loop / node / pipeline / stepPolicy 时，优先改这里
2. 如果一段逻辑同时涉及状态、事件和 policy，优先继续拆子模块
3. 不要把 host 默认装配重新拉回 graph-engine
4. child-run 的 registered agent 解析不属于这里
5. 新增节点时必须同时更新本文档的节点状态机图

---

## 9. 最小回归集合

改 graph 主链时，至少补或复跑：

- `graph-loop.integration`
- `graph-loop.stepPolicy`
- `graph-agent-executor.model-lock`
- `graph-executor`

改节点细节时，再加：

- `nodes/__tests__/*`

改 pipeline 时，再加：

- `tick-pipeline/__tests__/*`
- `prepareCallStage.test.ts`
- `middlewares/*.test.ts`

---

## 10. 相关文档

- `packages/linnkit/src/runtime-kernel/README.md`
- `packages/linnkit/src/runtime-kernel/tools/README.md`
- `src/app-hosts/linnya/adapters/flow/README.md`
- `docs/archive/agent-proposals/README.md`
