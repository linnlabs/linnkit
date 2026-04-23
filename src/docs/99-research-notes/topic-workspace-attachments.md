# Topic · 多任务工作空间 + 文件归属（OpenClaw / Hermes 源码深度对比）

> 调研日期：2026-04-23
> 调研深度：**深**（直接读源码 + 关键 file:line 引用）
> 触发：linnsec `01b-product-scenarios.md` §5.2 拍板时，第一次调研只读了二手笔记，结论与源码不符；主人指出后重新派 explore subagent 直接读 `/Users/tiansi/code/{hermes-agent, openclaw}/` 源码
> 笔记类型：**主题横向**（CC / Codex 不在此调研范围——它们工作区 = 用户项目根，没有"24/7 多任务并发"这层归属问题）

---

## 0. 教训：第一次调研错了哪些点

| 第一次调研结论 | 源码事实 | 错的根因 |
|----|----|----|
| "per-task directory 是 Linnsy 独有，2 家都没" | Hermes 有 `cron/output/{job_id}/`；OpenClaw 有 `agents/<id>/sessions/<sessionKey>` | 没看 `cron/jobs.py` 与 `config/sessions/paths.ts` |
| "IM 附件路由 2 家都没方案" | OpenClaw 有完整 `attachments + attachAs.mountPath`（`subagent-attachments.ts:96-130`）；Hermes 有 MCP `attachments_fetch` | 完全没 grep `attachments` |
| "学 OpenClaw `cwd` 覆盖" | OpenClaw subagent 路径**不传 `cwd`**，用 `spawnedWorkspaceDir` patch；只有 ACP 路径用 `cwd`；Hermes 用 `_resolve_workspace_hint` 写系统提示 | 没区分 OpenClaw subagent vs ACP 两条路径 |
| "清理归档 2 家都没策略，Phase 2 再做" | Hermes `disk-cleanup` 插件有完整 retention 表（cron-output 14 天 / 临时 7 天）；OpenClaw `subagent-registry-run-manager + sweeper` archive/delete | 完全没看 `plugins/disk-cleanup/` 与 `subagent-registry.ts` |
| "Hermes 路径纪律 = 禁止硬编码" | `get_hermes_home()` 是规范入口（`hermes_constants.py:11-18`），但**仍有未走 helper 的硬编码**（`tools/mcp_tool.py` / `plugins/memory/honcho/client.py` 等）—— "禁止硬编码"是**规范不是强制**| 没全仓 grep `~/.hermes` 看违反纪律的地方 |

→ 与子 agent 主题（`topic-sub-agent-multi-turn.md`）一样，**二手笔记不可作为结论源**。

---

## 1. 调研提纲

5 条调研维度（针对 OpenClaw / Hermes）：

1. per-task / per-session directory（实际目录约定 + 谁定义）
2. 路径管理抽象（是否有 `get_*_home()` 类函数 + env 优先 + 硬编码情况）
3. IM 附件如何关联到任务（实际协议 + 落地路径）
4. 子 agent spawn 时 cwd / workspace 注入机制
5. 清理 / 归档 / 容量

---

## 2. Hermes 源码事实

**仓库**：`/Users/tiansi/code/hermes-agent/`

### 2.1 per-task / per-session directory

**没有**统一的"任务工作区根"产品抽象，**但**：

- **Cron 输出按 job_id 分目录**：

```python
# cron/jobs.py:4-37
"""
Output is saved to ~/.hermes/cron/output/{job_id}/{timestamp}.md
"""
OUTPUT_DIR = CRON_DIR / "output"
```

注意：模块注释写 `~/.hermes`，但实际根目录由 `get_hermes_home()` 决定。

- **子 run 的 task_id**：

```python
# run_agent.py:9248-9249
# effective_task_id = uuid.uuid4()  # 当 run_conversation 未传 task_id 时
```

子 agent 的"任务隔离"主要体现在 **terminal/VM/browser 的 `task_id`**，不是文件系统目录。

### 2.2 路径管理抽象

`hermes_constants.get_hermes_home()` 是规范入口（HERMES_HOME 优先，否则 `Path.home() / ".hermes"`）：

```python
# hermes_constants.py:11-18
def get_hermes_home() -> Path:
    """Return the Hermes home directory (default: ~/.hermes).

    Reads HERMES_HOME env var, falls back to ~/.hermes.
    This is the single source of truth — all other copies should import this.
    """
```

**但**仍存在未走该 helper 的硬编码 `Path.home() / ".hermes"` 或 `expanduser("~/.hermes")` 回退（如 `tools/mcp_tool.py`、`tools/mcp_oauth.py`、`plugins/memory/honcho/client.py`）—— "single source of truth" 是**规范不是强制**。

### 2.3 IM 附件路由

`attachments_fetch` 在 **MCP 工具**层暴露：

```python
# mcp_serve.py:597-645
def attachments_fetch(
    session_key: str,
    message_id: str,
) -> str:
    """List non-text attachments for a message in a conversation."""
    ...
    attachments = _extract_attachments(target_msg)

    return json.dumps({
        "message_id": message_id,
        "count": len(attachments),
        "attachments": attachments,
    }, indent=2)
```

按 `session_key` 找会话，按 `message_id` 取消息，返回 JSON。**这是面向 MCP 工具会话模型，不是 delegate 内建协议**。

网关侧另有媒体下发（`gateway/stream_consumer.py` 附件相关），未发现 cron 任务直接绑定的"附件→任务"路由。

### 2.4 子 agent 工作目录注入

`delegate_tool` **未**向 `AIAgent` 传专用 `cwd` 参数；用 `_resolve_workspace_hint` 把绝对目录**写进子系统提示**：

```python
# tools/delegate_tool.py:125-147
def _resolve_workspace_hint(parent_agent) -> Optional[str]:
    ...
    candidates = [
        os.getenv("TERMINAL_CWD"),
        getattr(getattr(parent_agent, "_subdirectory_hints", None), "working_dir", None),
        getattr(parent_agent, "terminal_cwd", None),
        getattr(parent_agent, "cwd", None),
    ]
```

这个 hint 进了 `ephemeral_system_prompt`，让子 agent 自己知道在哪个目录工作（终端/文件工具与宿主 `TERMINAL_CWD` 一致）。

### 2.5 清理 / 归档

`disk-cleanup` 插件有完整 retention 规则：

```python
# plugins/disk-cleanup/disk_cleanup.py:9-19
"""
Rules:
  - test files    → delete immediately at task end (age >= 0)
  - temp files    → delete after 7 days
  - cron-output   → delete after 14 days
...
Scope: strictly HERMES_HOME and /tmp/hermes-*
"""
```

scope 严格限定在 `HERMES_HOME` 与 `/tmp/hermes-*`（不会动用户其他目录）。

---

## 3. OpenClaw 源码事实

**仓库**：`/Users/tiansi/code/openclaw/`（TypeScript）

### 3.1 per-task / per-session directory

**无**"per-task directory"概念，**但**会话元数据按 agent + session 分目录：

```typescript
// src/config/sessions/paths.ts:9-17
function resolveAgentSessionsDir(
  agentId?: string,
  ...
): string {
  const root = resolveStateDir(env, homedir);
  const id = normalizeAgentId(agentId ?? DEFAULT_AGENT_ID);
  return path.join(root, "agents", id, "sessions");
}
```

`sessionKey`（含 `subagent:uuid`）是逻辑归属键，转录文件按会话解析路径存。

### 3.2 路径管理抽象

**没有 `getOpenclawHome` 函数**（之前调研提纲里写的这个名是错的）。

实际抽象：

```typescript
// src/config/paths.ts:60-88
export function resolveStateDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = envHomedir(env),
): string {
  ...
  const newDir = newStateDir(effectiveHomedir);
  ...
}
```

```typescript
// src/agents/workspace.ts:13-23
export function resolveDefaultAgentWorkspaceDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const home = resolveRequiredHomeDir(env, homedir);
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (profile && normalizeOptionalLowercaseString(profile) !== "default") {
    return path.join(home, ".openclaw", `workspace-${profile}`);
  }
  return path.join(home, ".openclaw", "workspace");
}
```

**`OPENCLAW_HOME` env 优先 + Profile 概念**（不同 profile 走不同 workspace 目录）—— Linnsy 可借鉴这套 env + profile 设计。

### 3.3 IM 附件路由（**关键修正点**）

OpenClaw 有完整方案：

```typescript
// src/agents/subagent-attachments.ts:96-130
const childWorkspaceDir = resolveAgentWorkspaceDir(params.config, params.targetAgentId);
const absRootDir = path.join(childWorkspaceDir, ".openclaw", "attachments");
const relDir = path.posix.join(".openclaw", "attachments", attachmentId);
const absDir = path.join(absRootDir, attachmentId);
```

工具参数支持 `attachments + attachAs.mountPath`，落地到 `<workspace>/.openclaw/attachments/<uuid>/`，受 `tools.sessions_spawn.attachments` 配置开关（默认需 `enabled: true`）。

**这是 Linnsy IM 文件归属设计的最佳借鉴源**——`mountPath` 这个字段名值得学：让主人/LLM 显式声明"这个文件挂到任务工作空间的哪个子路径"。

### 3.4 子 agent 工作目录注入（**关键修正点**）

OpenClaw subagent 路径**不传 `cwd`**——`SpawnSubagentParams` 无该字段：

```typescript
// src/agents/tools/sessions-spawn-tool.ts:96-145
const SessionsSpawnToolSchema = Type.Object({
  task: Type.String(),
  ...
  runtime: optionalStringEnum(SESSIONS_SPAWN_RUNTIMES),
  ...
  cwd: Type.Optional(Type.String()),  // 这个是给 ACP 用的
});
```

实际 subagent 工作目录走 `resolveSpawnedWorkspaceInheritance` + 会话 patch `spawnedWorkspaceDir`。

**只有 ACP 路径**（外部进程）才用 `cwd`：

```typescript
// src/agents/acp-spawn.ts:1022-1085（前面引用过）
const initializedSession = await initializeAcpSpawnRuntime({
  ...
  cwd: runtimeCwd,
});
```

→ Linnsy 的"子 agent cwd 注入"应该改成**双路径**：①子 agent 同进程 → workspace 配置 patch；②外部 agent（codex/cursor）→ cwd 显式传。

### 3.5 跨会话文件共享

同 agent 的 `workspace` 目录可共享；子会话 patch `spawnedWorkspaceDir` 用于"入口工具视角的工作区覆盖"。**无独立"共享池"概念**——是配置级 workspace + 会话元数据组合。

### 3.6 清理 / 归档

`subagent-registry-run-manager + sweeper` 做有界清理：

- `archiveAtMs` 字段标记归档时间
- delete 模式 / keep 模式

**不是**全仓库自动 GC 用户盘，**是 registry / 会话生命周期相关**的有界清理。

---

## 4. 横向对比表

| # | 维度 | Hermes | OpenClaw | Linnsy 启示 |
|---|------|--------|----------|-----------|
| 1 | per-task directory | 无统一抽象；cron 有 `output/{job_id}/`；子 run UUID | 无；按 sessionKey 分；`agents/<id>/sessions/` | **Linnsy 延伸到"业务任务"维度**（不是独有，是新维度） |
| 2 | 路径抽象 | `get_hermes_home()` 是规范入口 + HERMES_HOME；**未 100% 强制** | `resolveStateDir` + `OPENCLAW_HOME` env + **Profile 概念** | 学 Hermes 命名 + OpenClaw env/Profile 设计；坦诚"零硬编码"难做到 |
| 3 | IM 附件归属 | MCP `attachments_fetch(session_key, message_id)` | **完整方案**：`attachments + attachAs.mountPath` 落到 `<workspace>/.openclaw/attachments/<uuid>/` | **借鉴 OpenClaw `mountPath` 设计** |
| 4 | 子 agent cwd 注入 | 不传 `cwd`；写系统提示（`_resolve_workspace_hint`） | subagent 不传 `cwd`，用 `spawnedWorkspaceDir` patch；只有 ACP 用 `cwd` | **双路径**：同进程 → workspace patch；外部 → cwd |
| 5 | 跨任务共享 | 未单独设计 | 同 agent workspace 目录可共享 | Phase 1 仅引用，不复制不软链 |
| 6 | 清理 / 归档 | `disk-cleanup` 插件，**完整 retention 表** | `subagent-registry sweeper`，archive/delete 模式 | Phase 1 至少留 retention 接口（学 Hermes） |

---

## 5. 关键产品判断：Linnsy 的"per-task directory"是创新吗？

不是创新，**是延伸**：

- **Hermes**：按 cron job 维度分目录（`cron/output/{job_id}/`）
- **OpenClaw**：按 session 维度分目录（`agents/<id>/sessions/<sessionKey>`）
- **Linnsy**：按**业务任务**维度分目录（`workspaces/<task_id>/`）

**两家共识**：「按某维度分目录」是合理的；具体维度看产品形态。

Linnsy 选"业务任务"维度的理由：

- 主人视角的最自然单位（"那个写报告的任务"、"那个旅游计划"）
- 24/7 多任务并发场景下，**比 sessionKey（IM 会话维度）更稳定**——同一任务可能跨多次 IM 会话讨论
- 比 cron job 维度更通用——支持非定时类任务

---

## 6. 对 Linnsy §5.2 决策的影响（已落档）

详见 [`linnsy/01b-product-scenarios.md`](../../../../linnsy/01b-product-scenarios.md) §5.2「2026-04-23 拍板，2026-04-23 源码深度调研后修订」段。

修订后的 7 条 Phase 1 拍板：

1. ✅ 每任务一个目录（**修订定位**：不是"独有"，是"按某维度分目录"延伸）
2. ✅ Phase 1 显式建任务 + inbox 暂存
3. 🔄 IM 文件三档归属（**修订**：借鉴 OpenClaw `attachments + mountPath`）
4. 🔄 子 agent 产物**双路径**注入（**修订**：workspace patch + 系统提示，不是 cwd 覆盖）
5. 🔄 路径纪律：抽象 + env 优先（**修订**：坦诚两家都没 100% 做到"零硬编码"）
6. ✅ 跨任务文件引用 = 仅引用
7. 🔄 清理 / 归档**Phase 1 留接口**（**修订**：之前说 Phase 2 再做过保守，Hermes/OpenClaw 都已实现完整方案）

---

## 7. 后续深挖待办

- OpenClaw 的 Profile 机制（`OPENCLAW_PROFILE`）—— Linnsy 是否需要类似（不同主人 profile 走不同 workspace？）
- Hermes `disk-cleanup` 插件的具体实现（按 mtime 还是元数据？容错？）
- OpenClaw `archiveAtMs` 字段的触发条件（任务关闭时 vs 主人显式 vs 定时）
- 跨任务文件引用的元数据存储（OpenClaw / Hermes 都没明确，Linnsy 自己定）
- IM 平台原生附件 API 的横向比较（Telegram / WeChat / Feishu / iMessage）—— Phase 1 实现时再研究

---

## 附 · 与 `topic-sub-agent-multi-turn.md` 的关联

本笔记的 §3.4（子 agent 工作目录注入）与 `topic-sub-agent-multi-turn.md` 的 §2.3.x（子 agent 实现机制）部分重叠——前者从"工作空间"视角看，后者从"子 agent"视角看，**以本文为工作空间主题的权威源**，子 agent 主题的源码事实以那篇为权威源。
