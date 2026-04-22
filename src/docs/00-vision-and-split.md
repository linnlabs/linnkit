# 00 · 愿景与三方边界

本文回答两个问题：

1. **目标形态长什么样？**
2. **谁拥有什么，不能放在哪？**

---

## 1. 目标形态

我们最终要稳定下来三个独立的代码资产：

### 1.1 Agent Engine

- **物理位置**：`packages/linnkit/src/`*（**Phase E 已于 2026-04-22 完成 git mv，源目录已从 `src/agent/*` 物理迁移到 `packages/linnkit/src/*`**；package 名 `linnkit`，详见 [`engine/07-public-api-and-package-boundary.md`](./engine/07-public-api-and-package-boundary.md) §6 Q1）
- **角色**：**通用 Agent 运行平台**——graph engine、event model、tool runtime、context manager、child-run protocol、run-context、telemetry port、checkpointer 接口
- **不属于任何产品**。任何 Agent 产品都可以装配它使用。
- **演进原则**：每次新增能力，必须能解释"为什么所有消费者都需要"。只为某一个消费者定制的能力一律不进。
- **设计哲学**（2026-04-21 强化）：**留接口、不做工具、信息丰富**——engine 提供 capability/protocol/hook，工具/UI/编排由产品层（Linnya / linnsec）实现。详见 [`engine/00-engine-scope-audit.md`](./engine/00-engine-scope-audit.md) §1.4。
- **模式收敛方向**（2026-04-21 定稿）：长期走 **agent-only core**。纯聊天不是第二套核心模式，而是**不注册工具、不给执行能力的 agent 形态**；`chat profile` 只作为历史兼容层保留，未来逐步消亡。

### 1.2 Linnya

- **物理位置**：当前主仓库（除 `packages/linnkit/`* 之外的部分；历史上曾是 `src/agent/*`，Phase E 后只保留宿主装配）
- **角色**：**桌面知识工作工作台**——文档、表格、思维导图、幻灯片、知识库、深度研究等。
- **是 Agent Engine 的消费者之一**。
- **对 linnsec 的角色**：通过 HTTP API 暴露能力（kb_search / create_doc / run_workflow / ...），让 linnsec 把它当作可调用的"专业工具"。
- **Linnya 不需要知道 linnsec 存在**。开放 API 是 Linnya 自己的产品决策（本来就该有），不是为 linnsec 定做的。

### 1.3 linnsec

- **物理位置**：将来独立产品，独立仓库
- **角色**：**永远在线的个人 AI 秘书**——多 IM 入口、定时提醒、长期记忆、调用桌面 agent 工具（Cursor / Codex / Claude Code / ChatGPT Web）、调用 Linnya 处理重活
- **是 Agent Engine 的另一个消费者**
- **不打进 Linnya 安装包**。这是硬约定。
- 暂定代号 **linnsec**（linn 系列产品，sec = secretary），最终名待定。

---

## 2. 三方关系图

```
                       ┌────────────────────────────────┐
                       │          linnsec               │
                       │   (永远在线的 AI 秘书)          │
                       │                                │
                       │   - Gateway daemon             │
                       │   - Channel adapters           │
                       │     (TG/WeChat/Feishu/...)     │
                       │   - Cron / scheduler           │
                       │   - Long-term memory           │
                       │   - External agent tools       │
                       │     (Cursor/Codex/CC/...)      │
                       │   - Skills / workspace         │
                       │   - DM 配对 / 沙箱              │
                       │   - Node protocol              │
                       │     (手机/Mac 作 cap provider)  │
                       └────┬──────────────────┬────────┘
                            │                  │
                  作为引擎装配 │                  │ 作为外部工具调用
                            │                  │ (HTTP API)
                            ▼                  ▼
              ┌──────────────────────┐  ┌──────────────────────┐
              │   Agent Engine        │  │       Linnya          │
              │   (独立 package)       │  │  (桌面知识工作工作台)  │
              │                       │  │                       │
              │  - graph engine       │  │  对 linnsec 暴露:      │
              │  - tool runtime       │  │  - kb.search          │
              │  - context manager    │  │  - doc.create         │
              │  - child-runs         │  │  - workflow.run       │
              │  - events / persist   │  │  - ...                │
              │  - LLM / streaming    │  │                       │
              │  - run-context        │  │  自己也消费 Engine     │
              │    /telemetry/...     │  │                       │
              └──────────────────────┘  └──────────────────────┘
                       ▲
                       │
                       └─── 装配
                            (Linnya 装它做桌面 agent;
                             linnsec 装它做秘书 agent)
```

---

## 3. 三方决策原则

### 3.1 一个能力放在哪？三个判断

按以下顺序问：

1. **是否任何 Agent 产品都需要？** → 是 → 进 **Agent Engine**
2. **是否 Linnya 桌面工作场景特有？** → 是 → 进 **Linnya 仓库**
3. **是否常驻 / 多设备 / IM / 定时 / 跨产品调度场景特有？** → 是 → 进 **linnsec 仓库**

如果三个问题都答"是"或都答"否"，**先停下，回到设计层确认边界**。

### 3.2 Engine 升级判断标准

任何 engine 升级提案必须答出：

1. **谁会消费？** 必须 ≥ 2 个真实消费者（或有明确的"将来一定有"理由）
2. **Linnya 也受益吗？** 如果只是 linnsec 用，不进 engine
3. **是协议还是实现？** engine 应只拥有协议 + 最小骨架；具体实现尽量留给消费者注入
4. **是否破坏现有消费者？** 必须保持 Linnya 当前行为不退化

> **2026-04-21 第一次强化**：完成 4 份外部项目调研后，发现"调研发现 → engine 升级候选"被默认应用，违反本节原则。已在 `[engine/00-engine-scope-audit.md](./engine/00-engine-scope-audit.md)` §1.1 把上述 4 条标准升级为 Q1-Q4 强制流程图，并把 8 个原 engine topic 重新审视一遍。  
> **关键纠偏**：默认归产品层，**不是默认升级 engine**。任何 engine 升级前**必读** `[engine/00-engine-scope-audit.md](./engine/00-engine-scope-audit.md)`。

> **2026-04-21 第二次强化**（"engine 留接口、不做工具、信息丰富"原则）：上述 4 条门槛是**否决性纪律**（没过门槛绝不升级）；但**通过门槛后**，engine 应当**主动留出信息丰富的接口**，让产品层做工具时不再 wrap engine。这条**正向原则**与 4 条门槛配套使用——先用 4 条筛掉非 engine 范畴的，再用本原则把 engine 范畴的接口设计得"capability 完备 + 信息丰富 + 实现灵活"。详见 `[engine/00-engine-scope-audit.md` §1.4](./engine/00-engine-scope-audit.md)。  
> **应用样板**：[`engine/01 §5.2 RunHandle`](./engine/01-async-runs-and-handles.md)、[`engine/03 LlmProviderPort`](./engine/03-multi-provider-llm-abstraction.md)、[`engine/06 三个独立 port`](./engine/06-checkpointer-and-persistence.md)。

### 3.3 不能违反的硬边界


| 场景         | 禁止                                           |
| ---------- | -------------------------------------------- |
| Engine     | 直接 import 任何特定产品的代码（Linnya / linnsec 都不行）    |
| Linnya     | 直接 import linnsec 代码                         |
| linnsec    | 直接 import Linnya 内部代码（必须走 HTTP API）          |
| Engine     | 暴露任何带产品语义的字段（`linnyaXxx` / `linnsecXxx` 都不行） |
| Linnya 安装包 | 打入 linnsec 任何代码                              |


---

## 4. linnsec 名称备注

- 暂定名：**linnsec**（linn 系列，sec = secretary）
- **未来改名预警**（2026-04-22 备注）：`sec` 后缀极易被开源社区或开发者误解为 `security`（如 InfoSec, DevSecOps），让人误以为这是一个“AI 安全/风控防火墙产品”而非“AI 秘书”。
- 因此，未来正式独立建仓或开源时**极大概率会改名**。
- 当前备选灵感（仅作暂定，无需立刻决策）：
  - 极客/Daemon风：`linnd` (Linn Daemon)、`linnsync`
  - 助手/拟人风：`linnsy` (Linnsy)、`linn-assist`、`linnmate`
  - 调度/任务风：`linn-task`、`linn-hub`
- **当前处理方式**：本目录所有文档**仍统一维持使用 `linnsec` 代号**，保持与早期规划文档一致。未来确定最终名后，再执行一次全局字符串替换（`linnsec` → 新名称）即可。文档中提到产品功能时，称呼它“linnsec / 秘书 / Secretary”皆可，但代号写为 `linnsec`。

## 4.1 linnkit 名称备注

- **最终定名：`linnkit`**（2026-04-22 拍板，详见决策记录 `engine/07 §6 Q1`）
- 候选曾包含 `linnflow / linngent / linnai`，最终决定 `linnkit`：取其"linn 系列开发套件"语义，承认它**听起来更像一个工程依赖而非 AI 产品**——这正是 engine 该有的位置感（基础设施而非品牌产品）
- 唯一权威定义点：`engine/07-public-api-and-package-boundary.md` §6 Q1
- 设计要求：禁止发明第二个 package 别名，避免双名长期并存
- 历史落地预演：`packages/agent-engine-dryrun/`（`name: linnkit-dryrun`，`exports` 已用 `linnkit/*` 路径）曾在 dryrun 工作区验证这个名字能立得住；**Phase E PR-D 已 sunset 该 dryrun 工作区**（2026-04-22；其角色由 `packages/linnkit/` 真包替代，源目录、配置、guard 例外全部清理完毕）

---

## 5. 升级路径决策树

```
开始
  │
  ▼
设想 linnsec 完整功能
  │
  ▼
对每个功能问：是否需要 Engine 现在没有的能力？
  │
  ├── 是 → 进入 engine/<NN>-<topic>.md 评估
  │         │
  │         ▼
  │       是否所有消费者都受益？
  │         │
  │         ├── 是 → 进入引擎升级清单
  │         └── 否 → 留在 linnsec 产品层实现
  │
  └── 否 → 直接进 secretary/<NN>-<topic>.md 设计

所有 engine topic 决策完成（2026-04-21 已完成：8 份 topic 全部决策定稿）
  │
  ▼
M4 实施：执行需要的 engine 升级（01 / 02 / 03 / 06 / 07 D-1 / 08 / 10）  ✅ 2026-04-22 完成
  │
  ▼
完成 Phase D (D-1~D-5：exports + boundary 强化 + 接入指南 + schema 治理 + dry-run)  ✅ 2026-04-22 完成
  │
  ▼
M5 Phase E 真抽包（E1~E8：物理 git mv `src/agent` → `packages/linnkit` + 全量改 import + 回归全绿）  ✅ 工程层完成（2026-04-22；唯一剩桌面手测）
  │
  ▼
§5.4.3 完成判据 7 项全绿（详见 [`engine/07 §5.4.3`](./engine/07-public-api-and-package-boundary.md)）  🚧 6/7（仅桌面手测主链待用户人工跑）
  │
  ▼
启动 linnsec 产品开发  🚧 进入门口（待桌面手测通过 + `secretary/01 §9` 三个待决策问题拍板）
```

> **2026-04-22 状态更新**：Phase E 工程层（PR-A codemod / PR-B 包壳 / PR-C 真 move / PR-D dryrun sunset）已全部落地，`src/agent/*` 已物理 move 到 `packages/linnkit/src/*`。`§5.4.3 完成判据`七项中**六项已自动化验证通过**（结构、占位删除、自动化测试、guard、build、文档），唯一剩"Linnya 桌面应用完整手测主链路"需要用户人工执行。详见 [`engine/24-phase-e-implementation-runbook.md §9`](./engine/24-phase-e-implementation-runbook.md)。

---

## 6. 状态

- 本文档随讨论推进持续更新
- 任何对"三方边界"的修改必须先改本文档，再改对应 topic 文档
