# 02 · Gateway Daemon

> **状态**：🚧 初稿，待定稿  
> **日期**：2026-04-21  
> **定位**：gateway daemon 是 linnsec 的运行内核，不是一个小配套进程  
> **前置**：
> - [`01-product-vision-and-phased-direction.md`](./01-product-vision-and-phased-direction.md)
> - [`../engine/01-async-runs-and-handles.md`](../engine/01-async-runs-and-handles.md)
> - [`../engine/02-session-and-tenancy.md`](../engine/02-session-and-tenancy.md)
> - [`../engine/06-checkpointer-and-persistence.md`](../engine/06-checkpointer-and-persistence.md)

---

## 1. 用户场景

### 场景 A：消息进来时，秘书必须一直在

用户在手机上发一句：

- “催一下刚才那个任务”
- “把这个交给写代码的 agent”
- “半小时后提醒我看结果”

这时候秘书不能要求用户先打开某个桌面程序。  
它必须自己就在后台活着。

### 场景 B：任务不是一句话就结束

秘书收到任务后，往往要经历：

- 收到请求
- 解析意图
- 找到对应会话
- 调起外部能力
- 等结果
- 继续跟进
- 主动回报

所以它不是简单 webhook 收发器，而是持续运行的任务中枢。

### 场景 C：机器重启、网络抖动、入口切换后，事情不能丢

用户最不能接受的是：

- 发出去的任务丢了
- 追踪状态丢了
- 重启后秘书“失忆”

所以 daemon 必须天然带恢复能力和稳定状态管理。

---

## 2. daemon 的产品角色

gateway daemon 是 linnsec 的“秘书本体承载进程”。

它至少负责：

1. 接收入口消息
2. 统一会话路由
3. 唤起或继续 agent run
4. 调度提醒与异步任务
5. 管理记忆、状态、事件、日志
6. 对外输出反馈

它不负责：

- 直接充当 Linnya
- 亲自完成所有重活
- 内置所有专业能力

换句话说：

- `linnkit` 提供跑 agent 的能力
- gateway daemon 把这个能力变成“持续在线的秘书系统”

---

## 3. 完整方向

### 3.1 长远目标形态

长远来看，gateway daemon 应该具备这些能力：

- 多入口接入
- 稳定 session 路由
- 多 run / 多任务状态管理
- 可恢复的调度
- 外部 agent 调用
- Linnya API 调用
- 日志、健康检查、升级与恢复

### 3.2 第一阶段的合理收敛

第一阶段不需要把所有入口一次做满，但 daemon 架构必须从第一天就按“完整方向”设计。

也就是说：

- 可以先只接 1~2 个入口
- 但不能把内部写成“只能单入口活着”
- 可以先主要服务单主人
- 但 session / run / task 的结构不能从一开始就写死成一次性脚本

---

## 4. 核心职责拆分

### 4.1 Ingress

负责：

- 接 IM / Web / 本地入口的入站消息
- 归一化成统一内部请求

原则：

- 通道差异留在 adapter
- daemon 内部只看统一请求形状

### 4.2 Session Router

负责：

- 把不同入口、不同线程、不同用户上下文映射成稳定 `conversationId`
- 决定这是新任务、旧任务继续，还是提醒类 follow-up

这里是产品层能力，不属于 engine。

### 4.3 Run Orchestrator

负责：

- 调用 `linnkit`
- 启动新 run 或继续旧 run
- 管理 run 与产品任务记录之间的关系

这里依赖：

- `RunHandle`
- `RunRegistryStore`
- `EventStore`

### 4.4 Task Tracker

负责：

- 记录“老板视角”的任务状态
- 把 run 状态翻译成产品层可读状态

这里要强调：

- `RunHandle` 是计算层状态
- `TaskRecord` 是产品层状态
- 两者有关联，但不是一回事

### 4.5 Scheduler

负责：

- one-shot 提醒
- 周期提醒
- 超时跟进
- 漏跑补偿

### 4.6 Notification / Reply Layer

负责：

- 把结果整理成秘书口吻
- 控制何时主动汇报，何时被动回答

---

## 5. 数据流

一个典型链路应该是：

1. 入口收到消息
2. ingress adapter 归一化
3. session router 定位会话
4. daemon 决定：
   - 新建任务
   - 继续旧任务
   - 调 scheduler
   - 直接答复
5. 如需执行，则调用 `linnkit`
6. run 过程状态写入 run registry / event store
7. 结果经 notification layer 整理后发回入口

这意味着 daemon 不是单次请求处理器，而是一个持续事件循环。

---

## 6. 运行形态

### 6.1 基本原则

默认形态应是：

- headless daemon
- 可跑在本机
- 也可跑在远程常驻机器

### 6.2 为什么不能先按“桌面附属进程”设计

因为那样会天然把它写成：

- 依赖 GUI 生命周期
- 依赖用户打开桌面应用
- 不能稳定接住异步任务和提醒

这和秘书产品方向冲突。

### 6.3 对部署的要求

daemon 至少要考虑：

- 开机自启
- 重启恢复
- 日志落盘
- 配置管理
- 健康检查

---

## 7. 恢复与稳定性

daemon 必须天然支持：

- run 状态恢复
- 调度恢复
- 事件回放
- 任务记录续接

否则秘书这个产品本身站不住。

这里依赖 engine 已定稿能力：

- `Checkpointer`
- `EventStore`
- `RunRegistryStore`

---

## 8. 与 engine 的边界

gateway daemon 需要 engine 提供：

- 运行 agent
- 查询 run 状态
- 持久化运行状态
- 订阅运行事件

gateway daemon 自己负责：

- 通道接入
- 会话路由
- 任务记录
- 调度
- 权限
- 主动汇报策略

所以：

- engine 不做 daemon
- daemon 不反向侵入 engine 协议层

---

## 9. 与 Linnya 的边界

daemon 不直接 import Linnya 内部代码。

正确方式是：

- linnsec daemon 通过 HTTP API 调 Linnya
- daemon 自己决定何时调用 Linnya
- Linnya 只暴露专业能力，不承担秘书职责

---

## 10. 当前倾向

当前倾向是：

- daemon 从第一天就按“完整秘书系统内核”设计
- 第一阶段可以缩入口和能力数，但不能把内部设计成一次性流程脚本
- `TaskRecord` 作为产品层对象，应尽快在后续文档里明确

---

## 11. 待决策问题

- 第一阶段 daemon 优先跑在本机，还是优先支持远程常驻机
- 第一阶段是否只服务单主人
- 主动汇报的默认策略是什么
- `TaskRecord` 是否单独起文档，还是并入本篇后半部分

---

## 12. 状态

- [x] 明确 daemon 是产品内核，不是附属进程
- [x] 明确与 engine / Linnya 的边界
- [x] 明确完整方向与第一阶段收敛关系
- [ ] 与 `02b / 10 / 11 / 13` 继续对齐
- [ ] 定稿
