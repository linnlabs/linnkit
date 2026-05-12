# `@linnlabs/linnkit`

> Vendor-neutral Agent framework — runtime-kernel + context-manager + ports + testkit + browser-safe events seam.

`linnkit` 是用来构造 Agent 应用的 runtime / 协议骨架，由 4 个层组成：

- **`runtime-kernel`** — graph engine + tools + LLM caller + run supervisor + telemetry
- **`context-manager`** — agent context profiles + preprocessors
- **`ports`** — host 装配面（接入方必须实现）
- **`testkit`** — 包合约测试 primitive

任何想做 agent 应用的接入方都装配它。**框架本身不内置任何具体业务实现**——产品形态、UI 表达层、persistence 选型、SSE 适配器等全部归接入方宿主。

## 状态

- npm scope：`@linnlabs/linnkit`
- 当前版本：以 [`package.json#version`](./package.json) 与 [`docs/release/RELEASE.md`](./docs/release/RELEASE.md) 为准（GitHub Packages 私有发布）
- 阶段：**0.x experimental** — 7 个稳定子入口已收口；0.5.0 起 Phase F P0 三件（AgentSpec / RunSupervisor / AuditEnvelope）已落地
- 公开开源 + npmjs.com 路线见 [`docs/release/RELEASE.md §7`](./docs/release/RELEASE.md)

## 安装

仓库根加 `.npmrc`（参考 [`.npmrc.example`](./.npmrc.example)），然后：

```bash
npm install @linnlabs/linnkit
```

接入文档按主题拆分在 [`docs/integration/`](./docs/integration/)，建议从 [`docs/integration/README.md`](./docs/integration/README.md) 进入。

## 文档

文档枢纽在 [`docs/`](./docs/)：

- [`docs/README.md`](./docs/README.md) —— **框架总入口**：模块定位 / 公开子入口 / 数据流 / 术语速查
- [`docs/integration/`](./docs/integration/) —— **接入手册集（host 必读）**：按主题拆分的 17 个手册（installation / quickstart / context-fences / run-supervisor / audit / telemetry / ...）
- [`docs/release/RELEASE.md`](./docs/release/RELEASE.md) —— Build / Publish / Version 流水（每次发包前必读）
- [`docs/release/RELEASE-HISTORY.md`](./docs/release/RELEASE-HISTORY.md) —— 历次发版长叙事 / 踩坑教训 / PAT runbook

仓库内还有以下**内部维护文档**（不在 npm tarball 内，仅 linnkit 维护方使用）：

- `docs/DEVELOPMENT_GUIDE.md` —— linnkit 包内部 dev 流程
- `docs/framework/` —— 框架演进路线图、协议升级、ADR 决策档案
- `docs/99-research-notes/` —— 外部项目调研笔记池
- `docs/archive/` —— 早期抽包决策档案

## License

UNLICENSED（私有仓内发布；公开开源 + npmjs.com 公开发布路线见 [`docs/release/RELEASE.md §7`](./docs/release/RELEASE.md)）
