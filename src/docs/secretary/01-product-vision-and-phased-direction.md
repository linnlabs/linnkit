# 01 · Product Vision and Phased Direction

> **状态**：🚧 初稿，待定稿  
> **日期**：2026-04-21  
> **定位**：这份文档描述的是 **linnsec 的完整产品方向**，不是“最小能跑起来的 MVP 清单”  
> **前置**：
> - [`../00-vision-and-split.md`](../00-vision-and-split.md)
> - [`../engine/07-public-api-and-package-boundary.md`](../engine/07-public-api-and-package-boundary.md)
> - [`README.md`](./README.md)

---

## 1. 用户场景

### 场景 A：老板的统一入口

用户不想分别打开 Linnya、Cursor、Codex、Claude Code、手机提醒、日历和消息工具。

他要的是一个统一入口，可以直接说：

- “把这篇报告安排人去做，做完提醒我”
- “下午 4 点前如果还没出结果，再催一次”
- “把这个需求交给写代码的 agent 处理”
- “查一下 Linnya 里之前关于这个客户的资料”

### 场景 B：不只是会聊天，而是真的会“盯事”

用户需要的不是一个会接话的 chatbot，而是一个会：

- 记住事情
- 安排事情
- 追踪进展
- 主动汇报
- 在边界内自己处理简单事务
- 在边界外调用专业工具和专业 agent

### 场景 C：多入口，但人格和任务状态一致

用户可能会从这些入口找它：

- 手机 IM
- 桌面 Web
- Mac 菜单栏或本地入口
- 将来的语音入口

不管从哪里来，它都应该是**同一个秘书**，不是多份割裂的 bot。

---

## 2. 产品本质

**linnsec = 永远在线的个人 AI 秘书。**

它不是：

- Linnya 的附属功能
- 另一个普通聊天窗口
- 一个什么都亲自做的全能执行器

它是：

- 一个长期存在的“秘书角色”
- 一个统一调度台
- 一个任务跟踪与反馈中心
- 一个对外代表用户意图、对内调用专业能力的中枢

换句话说：

- 重活交给外部 agent 或 Linnya
- 轻活由 linnsec 自己处理
- 事情的安排、串联、提醒、汇报，由 linnsec 负责到底

---

## 3. 完整方向

### 3.1 完整产品形态

长远来看，linnsec 不是“一次问一句答”的产品，而是一套持续运转的秘书系统，至少包含：

1. **统一入口层**  
支持多入口接入，但对用户保持一个统一身份。

2. **gateway daemon**  
常驻后台，负责收消息、派任务、盯状态、做恢复。

3. **任务与会话路由层**  
把不同入口、不同人、不同线程映射到稳定的会话和任务。

4. **调度层**  
包括即时任务、延时任务、周期任务、提醒和超时追踪。

5. **记忆层**  
维护秘书自己的长期记忆，不与 Linnya 的知识库混为一体。

6. **能力调度层**  
调 Linnya、调外部 agent、调本地工具、调将来的节点设备能力。

7. **反馈层**  
把结果整理成秘书口吻，持续给用户同步，而不是只在结束时丢一坨原始输出。

### 3.2 和 Linnya 的关系

Linnya 是专业工作台，linnsec 是秘书。

关系应该是：

- linnsec 通过 API 调用 Linnya
- Linnya 不需要知道 linnsec 存在
- 两者独立发布、独立升级、独立部署

### 3.3 和 `linnkit` 的关系

`linnkit` 是运行平台，不是产品。

关系应该是：

- `linnkit` 提供运行能力
- linnsec 决定秘书人格、入口、权限、记忆、调度、外部集成
- 任何“秘书特有”的判断，不应该反向塞回 engine

---

## 4. 产品边界

### 4.1 linnsec 自己做什么

适合由秘书自己完成的，是这些事：

- 组织信息
- 追问澄清
- 做提醒和追踪
- 做轻量总结
- 整理任务状态
- 管理对外派发和回收结果

### 4.2 linnsec 不自己做什么

不适合由秘书自己承担的，是这些事：

- 大规模写代码
- 深度研究的完整执行
- 复杂文档生产
- 大量专业工具操作

这些应该交给：

- Linnya
- Cursor
- Codex
- Claude Code
- 将来的其他专业 agent

### 4.3 明确反目标

linnsec 不追求：

- 成为另一个“万能执行器”
- 把所有能力都塞进自己体内
- 用一套巨型 prompt 硬扛所有场景
- 和 Linnya 变成一个安装包、一个升级节奏、一个状态树

---

## 5. 阶段化落地

> 这里写的是“完整方向下的阶段化落地”，不是把产品降级成“只做一个最小 MVP”。

### Phase 0：前置条件

前置条件只有一个：

- `linnkit` 完成 Phase E 真抽包

没有这个前置，linnsec 不进入正式开发。

### Phase 1：第一阶段可落地产品

第一阶段应当形成一个**可持续使用的秘书雏形**，而不是一次性 demo。

建议目标：

- 单用户为主
- 1~2 个入口
- daemon 常驻
- 可调用 Linnya
- 可调用 1~2 个外部 agent
- 有基础提醒和任务追踪
- 有最基本的长期记忆

### Phase 2：完整秘书闭环

第二阶段开始补秘书真正的闭环能力：

- 多入口一致人格
- 更强的任务跟踪
- 更强的调度与超时追踪
- 更完整的外部 agent 工具集
- 更强的记忆和总结链路

### Phase 3：多设备与更高自治

再往后才考虑：

- 手机 / Mac 节点能力
- 语音
- 更复杂的自动审批
- 更企业化的安全与运维

---

## 6. 设计原则

### 6.1 先统一人格，再扩入口

入口可以晚一点扩，但秘书人格和任务状态必须先统一。

### 6.2 先把“盯事能力”做扎实，再扩“做事能力”

秘书价值首先来自：

- 会跟进
- 会提醒
- 会汇报

不是首先来自“能亲手干多少活”。

### 6.3 秘书的可信度高于炫技

用户愿意把事交给秘书，核心前提是：

- 它的行为可预测
- 它的权限边界明确
- 它不会自己乱长能力

### 6.4 产品方向先讲完整，实施先做分层

我们现在写文档时必须先把完整方向讲清楚；  
但实施时仍然按阶段推进，避免一口吞。

---

## 7. 依赖的 engine 能力

本主题依赖这些 engine 能力已经定稿：

- [`../engine/01-async-runs-and-handles.md`](../engine/01-async-runs-and-handles.md)
- [`../engine/02-session-and-tenancy.md`](../engine/02-session-and-tenancy.md)
- [`../engine/03-multi-provider-llm-abstraction.md`](../engine/03-multi-provider-llm-abstraction.md)
- [`../engine/06-checkpointer-and-persistence.md`](../engine/06-checkpointer-and-persistence.md)
- [`../engine/07-public-api-and-package-boundary.md`](../engine/07-public-api-and-package-boundary.md)
- [`../engine/08-cross-cutting-concerns.md`](../engine/08-cross-cutting-concerns.md)

### 7.1 产品需求 ↔ engine 能力映射（S-4，2026-04-21）

这张表是 linnsec 反推 `linnkit` 的核心校验：每一条产品需求都必须能在已定稿的 engine 接口上找到对应"能用什么"，否则说明 engine 还缺接口、不能立即进 M5。

> **使用说明**：本表"engine 接口"列只引用**已定稿**的 ports / interfaces，不包含未来才会加的能力。如果某个产品需求找不到对应 engine 能力，说明 engine 还需要补，需要回到 `engine/0X` 增补 topic。

| 产品需求 | engine 接口（已定稿）| 信息丰富度检查 | 结论 |
|---------|--------------------|--------------|------|
| **场景 A** 老板的统一入口（多端、跨入口、人格一致） | `engine/02 AgentInvocationRequest.conversationId` + `parentConversationId` | ✅ 任意宿主只需透传 conversationId 即可继承会话 | 可落地 |
| **场景 B** "盯事"：长期运行任务 + 后台进度 | `engine/01 RunSupervisor.spawnDetached` + `peek` + `subscribe` | ✅ peek 提供 status / currentNode / iterationsUsed / pendingInteractionSpec | 可落地 |
| **场景 B** 任务进度查询 / 中途接管 | `engine/01 RunSupervisor.peek` + `wait` + `cancel(forceCleanup)` | ✅ 返回 PeekRunResult 含 recentEvents、pendingInteractionSpec、iterationBudgetRemaining | 可落地 |
| **场景 C** 多入口、人格一致（Linnya 桌面 / web / IM bot） | `engine/03 LlmProviderPort` + `engine/02 conversationId` | ✅ 同一 conversationId + 同一 provider key → 跨宿主一致 | 可落地 |
| 主动提醒 / 主动汇报（gateway daemon） | `engine/01 RunSupervisor.spawnDetached`（cron / trigger 由 host 包） | ⚠️ engine 不做调度，host 自己有 daemon | 可落地（host 责任） |
| 多设备一致：会话状态跨设备同步 | `engine/06 Checkpointer.peekMeta?` + `list?` + `RunRegistryStore` | ✅ peekMeta + list 让 host 可以 enumerate / sync 而不全量 load | 可落地 |
| 中断恢复 / 跨进程接力 | `engine/06 Checkpointer.schemaVersion` + `engine/01 subscribe(fromEventId)` | ✅ schemaVersion 防止跨版本错配；fromEventId 支持断点续传 | 可落地 |
| 错误诊断 / 用户反馈分类 | `engine/08 ErrorClassification` + `ENGINE_ERROR_CODES` | ✅ errorCode + recoverable + retryAfterMs + hint 已涵盖 | 可落地 |
| 性能 / 成本可观测 | `engine/08 TelemetryPort.emit` （llm_call / tool_call / graph_node / run_lifecycle 4 类事件）| ✅ 含 scope（conversationId/runId/parentRunId/turnId/stepId）+ usage 数据 | 可落地 |
| 子 agent / 任务嵌套（"研究→撰写"流水线）| `engine/02 AgentInvocationRequest.parentRunId` + `engine/01 spawnDetached` | ✅ parentRunId 让 host 自己组织树形 budget | 可落地 |
| 安全审计：所有调用全程留痕 | `engine/08 TelemetryPort` + `engine/06 EventStore`（optional） | ✅ host 注入自己的 sink 即可 | 可落地（host 责任） |
| 多模型 / 多 provider 路由 | `engine/03 LlmProviderPort` + `LlmProviderFactoryLike` | ✅ 完全 host 决策，engine 不锁 | 可落地 |
| 工具白名单 / 灰度 / 版本分发 | host 端 AgentRegistry（不在 engine 内）| ✅ engine 不管，host 完全自由 | 可落地（host 责任）|

**结论**：linnsec 当前规划的所有场景，在 `engine/01 ~ /08` 已定稿接口上都能找到对应能力，无 engine 能力缺口。

**这张表的作用**：

1. **进入 M5 Phase E 前的最后一道校验** —— 如果发现新增产品需求找不到对应 engine 接口，说明 engine 还要补，不应进 Phase E
2. **linnsec 启动后的对接 checklist** —— 实施 linnsec 时可以反向 check 是否真的用上了这些 engine 能力（如果没用上某条，要么这条产品需求没做、要么 engine 接口设计错了）
3. **未来 engine 增加能力的入口** —— 任何 linnsec 团队提"engine 缺这个能力"的请求，都要先在本表里找不到对应项，再到 `engine/0X` 起 topic

---

## 8. 当前倾向

当前倾向很明确：

- 文档层面先把 linnsec 写成完整方向
- 工程层面仍按阶段落地
- 第一阶段不是“最小 MVP 演示品”，而是“可持续使用的第一阶段产品”

---

## 9. 待决策问题

- 第一阶段优先做哪两个入口
- 第一阶段是否先限制为单用户 / 单主人
- 第一阶段秘书是否允许主动发起提醒之外的“主动汇报”

---

## 10. 状态

- [x] 明确“完整方向，不按最小 MVP 写”
- [x] 明确 Linnya / `linnkit` / linnsec 三者边界
- [x] 明确阶段化落地方式
- [ ] 与 `02 / 10 / 11` 继续对齐
- [ ] 定稿
