# Quickstart · 5 分钟跑通 hello agent

> **What** · 用 `defineAgent` + `runAgent` 写 hello agent 最小骨架，5 分钟跑通一轮对话。
> **When to read** · 装包成功后立刻读；想试用 quickstart helper；写第一个 demo。
> **Prerequisites** · [`01-installation.md`](./01-installation.md)（装包鉴权已通过）。
> **Key exports** · `defineAgent` / `runAgent` / `defineConfig` from `@linnlabs/linnkit/quickstart`。
> **Related** · [`tool-development-guide.md`](./tool-development-guide.md) ⭐ · [`agent-registration-guide.md`](./agent-registration-guide.md) ⭐ · [`llm-provider.md`](./llm-provider.md)

本页是 **试用入口**：目标是让你装包后立刻跑通一轮 agent 对话，确认包、配置、LLM adapter 和 graph runtime 能正常工作。

它不是生产接入方案。生产 host 仍然应该按后续主题手册逐项替换 LLM provider、工具系统、持久化、实时通道、审计和上下文工程策略：

- [llm-provider.md](./llm-provider.md)
- [tools.md](./tools.md)
- [context-fences.md](./context-fences.md)
- [persistence.md](./persistence.md)
- [run-supervisor.md](./run-supervisor.md)
- [audit.md](./audit.md)
- [testing.md](./testing.md)

## 1. 配 GitHub Packages

在你的项目根目录准备 `.npmrc`：

```ini
@linnlabs:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

`GITHUB_PACKAGES_TOKEN` 需要 `read:packages` 权限。

## 2. 创建 demo host

```bash
npm install -g @linnlabs/linnkit
linnkit init hello-linnkit
cd hello-linnkit
cp .npmrc.example .npmrc
cp .env.example .env
npm install
```

`linnkit init <name>` 会在**当前执行命令的目录**下创建一个同名子目录。例如你在 `/Users/you/projects` 执行 `linnkit init hello-linnkit`，最终路径就是 `/Users/you/projects/hello-linnkit`。如果目标目录已存在且非空，CLI 会直接报错，不会覆盖你的文件。

如果你不想全局安装，也可以在任意已安装 `@linnlabs/linnkit` 的项目里用：

```bash
npx linnkit init hello-linnkit
```

## 3. 配置 LLM

编辑 `.env`：

```bash
OPENAI_API_KEY=sk-...
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini
```

quickstart 模板不依赖 OpenAI SDK，只用 Node 20 原生 `fetch` 调 OpenAI-compatible Chat Completions streaming API。你也可以把 `OPENAI_BASE_URL` 指向任何兼容服务。

## 4. 检查环境

```bash
npx linnkit doctor
```

`doctor` 会检查：

- Node.js >= 20
- GitHub Packages `.npmrc` 提示
- `OPENAI_API_KEY`
- `linnkit.config.mjs` 能加载
- agent id 唯一
- LLM adapter 是否符合 `AgentAiEngine` 形状

## 5. 跑 hello agent

```bash
npx linnkit run hello --input "你好，介绍一下你自己"
```

你会看到实时 final answer chunk，结束后会打印：

```text
[linnkit] runId=...
[linnkit] tokens input=... output=...
```

## 6. 生成项目里有什么

```text
hello-linnkit/
├── agents/hello.mjs
├── adapters/openai-compatible.mjs
├── linnkit.config.mjs
├── .env.example
├── .npmrc.example
└── package.json
```

关键点：

- `agents/hello.mjs` 用 `defineAgent()` 声明一个无工具 agent。
- `linnkit.config.mjs` 用 `defineConfig()` 声明 agent 列表、默认模型和 LLM adapter。
- `adapters/openai-compatible.mjs` 是 demo adapter，只证明 `AgentAiEngine` 怎么接；生产接入建议维护自己的 provider adapter。
- `linnkit run` 内部用 `runAgent()` 自动装配内存版 EventStore / Checkpointer / RunSupervisor，只适合 quickstart 和小型 smoke test。

## 7. 下一步

- 接你自己的 provider：看 [llm-provider.md](./llm-provider.md)
- 注册工具：看 [tools.md](./tools.md)
- 精细控制上下文 token：看 [context-fences.md](./context-fences.md)、[tool-history.md](./tool-history.md)
- 接持久化和恢复：看 [persistence.md](./persistence.md)
- 接 run 管理：看 [run-supervisor.md](./run-supervisor.md)
- 写集成测试：看 [testing.md](./testing.md)
