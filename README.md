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
- 当前版本：`0.1.1`（GitHub Packages 私有发布）
- 阶段：**0.x experimental** — 7 个稳定子入口已收口；Phase F 协议演进仍在路上（详见 [`docs/framework/`](./docs/framework/)）
- 公开开源 + npmjs.com 路线见 [`docs/release/RELEASE.md §7`](./docs/release/RELEASE.md)

## 安装

仓库根加 `.npmrc`（参考 [`.npmrc.example`](./.npmrc.example)），然后：

```bash
npm install @linnlabs/linnkit
```

详细装配链路与 7 个公开子入口的语义见 [`docs/INTEGRATION_GUIDE.md`](./docs/INTEGRATION_GUIDE.md)。

## 文档

文档枢纽在 [`docs/`](./docs/)，主要入口：

- [`docs/README.md`](./docs/README.md) —— **Engine 总入口**：模块定位 / 公开子入口 / 读文档顺序
- [`docs/INTEGRATION_GUIDE.md`](./docs/INTEGRATION_GUIDE.md) —— 接入方装配指南（host 必读）
- [`docs/DEVELOPMENT_GUIDE.md`](./docs/DEVELOPMENT_GUIDE.md) —— linnkit 包内部 dev 流程
- [`docs/framework/`](./docs/framework/) —— **活文档**：linnkit 作为独立 Agent 框架的演进
- [`docs/release/RELEASE.md`](./docs/release/RELEASE.md) —— Build / Publish / Version 流水（每次发包前必读）
- [`docs/release/RELEASE-HISTORY.md`](./docs/release/RELEASE-HISTORY.md) —— 历次发版长叙事 / 踩坑教训 / PAT runbook
- [`docs/99-research-notes/`](./docs/99-research-notes/) —— 外部项目调研笔记池
- [`docs/archive/engine-phases/`](./docs/archive/engine-phases/) —— **已归档**：早期抽包决策档案

## License

UNLICENSED（私有仓内发布；公开开源 + npmjs.com 公开发布路线见 [`docs/release/RELEASE.md §7`](./docs/release/RELEASE.md)）
