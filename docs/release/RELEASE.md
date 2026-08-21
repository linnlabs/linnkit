# linnkit Release Runbook

本文只回答一个问题：**现在怎么发布 Linnkit core 和可选 AI SDK adapter**。不要在这里写版本流水账、事故复盘、长篇 release notes 或历史清单。

## 1. 文档职责

| 文件 | 职责 | 不放什么 |
|---|---|---|
| [`CHANGELOG.md`](../../CHANGELOG.md) | 对外版本变化。按版本写 Added / Changed / Fixed / Compatibility。GitHub Release 从这里抽取正文。 | 发布过程、踩坑叙事、内部操作日志。 |
| [`RELEASE-HISTORY.md`](./RELEASE-HISTORY.md) | 发版历史、踩坑、历史决策、事故复盘。 | 当前发布步骤的重复副本。 |
| 本文 | 发布流程手册。只保留边界、步骤、检查项和失败处理。 | 版本说明、历史版本表、长叙事。 |

更新原则：每次发版只改 `CHANGELOG.md` 的对应版本段；只有发布流程本身变化时才改本文。

## 2. 发布边界

linnkit 有三个位置，职责不同：

| 位置 | 职责 | 发版时怎么处理 |
|---|---|---|
| linnya 私有仓 `packages/linnkit`、`packages/linnkit-provider-ai-sdk` | 日常开发镜像，跟随 linnya 一起提交和推送。 | 不从这里打 npm release tag，也不从 linnya workflow 发布 npm。 |
| GitHub 公开仓 [`linnlabs/linnkit`](https://github.com/linnlabs/linnkit) | core 位于仓库根，Adapter 位于 `packages/provider-ai-sdk`；保存公开源码、release tag 与 GitHub Release。 | `v*` 发布 core；`provider-ai-sdk-v*` 发布 Adapter。 |
| npm 包 [`@linnlabs/linnkit`](https://www.npmjs.com/package/@linnlabs/linnkit) | 外部消费者安装的正式包。 | 由公开仓 GitHub Actions 通过 npm Trusted Publishing 发布。 |
| npm 包 `@linnlabs/linnkit-provider-ai-sdk` | Host 可选安装的 AI SDK language adapter。 | 独立版本、独立 tag、独立 Trusted Publisher，不进入 Linnkit core 依赖。 |

也就是说：源码只公开到 `github.com/linnlabs/linnkit`；两个 npm package 各自发布。linnya 私有仓里的镜像只随 linnya 自己的 git 流程走。

## 3. 发版前检查

在公开仓根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build:clean
pnpm run build
pnpm run test
pnpm run test:smoke
pnpm run test:smoke:dist
pnpm run publish:dry-run
pnpm --filter @linnlabs/linnkit-provider-ai-sdk typecheck
pnpm --filter @linnlabs/linnkit-provider-ai-sdk test
pnpm --filter @linnlabs/linnkit-provider-ai-sdk pack-smoke
```

然后检查：

```bash
git status --short
npm view @linnlabs/linnkit version dist-tags.latest versions --json --registry=https://registry.npmjs.org/
npm view @linnlabs/linnkit-provider-ai-sdk version dist-tags.latest versions --json --registry=https://registry.npmjs.org/
```

必须满足：

- 准备发布的 package version 与它自己的 tag 一致。
- `CHANGELOG.md` 有对应版本段。
- `CHANGELOG.md` 中所有看起来像正式版本的段落，要么已经有对应 npm version + Git tag，要么在标题中明确标注为 `unpublished milestone` / `pre-npmjs milestone` 并说明折入或被哪个已发布版本覆盖。
- `git status --short` 为空。
- npm 上还没有同版本；如果已经有同版本，只能按“已发布版本”处理，不能覆盖。

## 4. 常规发布步骤

1. 在 linnya 私有仓完成开发、测试、提交和推送。
2. 把 `packages/linnkit` 同步到公开仓根目录，把 `packages/linnkit-provider-ai-sdk` 同步到公开仓 `packages/provider-ai-sdk`；不得复制 `dist`、`node_modules`，也不得覆盖公开仓的 `.git`、`.github`、`.gitignore`、`pnpm-workspace.yaml` 和 lockfile。
3. 在公开仓补齐或确认：
   - `package.json#version`
   - `CHANGELOG.md`
   - `README.md` / `docs/integration/*` 中必要的公开接入口径
   - **回写画像（防文档漂移 · 2026-06-22 治理纪律）**：同步 `docs/framework/README.md §7` 阶段台账与 `docs/99-research-notes/topic-agent-framework-comparison-2026.md` 的版本/能力画像，使其与本次 `CHANGELOG.md` 一致。**CHANGELOG 是版本权威源；画像类文档每次发版后必须对齐**，否则会像 0.8→0.21 期间那样把旧短板继续传播。
4. 跑完第 3 节的本地检查。
5. 提交并推送公开仓 `main`。
6. 只为实际发布的 package 打自己的 tag 并推送：

```bash
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z

git tag provider-ai-sdk-vX.Y.Z
git push origin provider-ai-sdk-vX.Y.Z
```

7. core 观察 `Release` workflow；Adapter 观察 `Release Provider AI SDK Adapter` workflow。
8. 发布成功后验证 npm：

```bash
npm view @linnlabs/linnkit@X.Y.Z version --registry=https://registry.npmjs.org/
npm view @linnlabs/linnkit version dist-tags.latest --registry=https://registry.npmjs.org/
npm view @linnlabs/linnkit-provider-ai-sdk version dist-tags.latest --registry=https://registry.npmjs.org/
```

## 5. Trusted Publishing 前置条件

公开仓 `.github/workflows/release.yml` 使用 npm Trusted Publishing / GitHub OIDC，不使用长期 npm token。

npm package settings 必须分别配置 Trusted Publisher：

| 字段 | 值 |
|---|---|
| Publisher type | GitHub Actions |
| Organization / User | `linnlabs` |
| Repository | `linnkit` |
| Workflow filename | core 使用 `release.yml`；Adapter 使用 `release-provider-ai-sdk.yml` |
| Package | 分别为 `@linnlabs/linnkit`、`@linnlabs/linnkit-provider-ai-sdk` |

`@linnlabs/linnkit-provider-ai-sdk@0.1.0` 是新 package，npm 在 package 尚不存在时不能预先配置 Trusted Publisher。首次发布只能做一次 bootstrap：先让源码进入公开仓 `main`，由 maintainer 在本机登录 npm，然后在公开仓 `packages/provider-ai-sdk` 执行 `npm publish --access public --provenance=false`。发布成功后立即配置上述 Trusted Publisher；再推 `provider-ai-sdk-v0.1.0`，工作流会把已存在版本视为幂等完成并创建 GitHub Release。后续版本一律走 OIDC，禁止继续本地发包。

注意：

- `npm whoami` 不能验证 OIDC 发布权限，因为 OIDC token 只在 `npm publish` 时由 npm 颁发。
- 不要把 `NPM_TOKEN` / `LINNLABS_NPM_TOKEN` 加回常规 release workflow。token 路线只会重新制造长期凭据维护问题。
- workflow 当前固定 Node 24，并安装 npm 11.x，满足 npm Trusted Publishing 对新版 Node/npm 的要求。

## 6. 失败处理

| 现象 | 通常原因 | 处理 |
|---|---|---|
| `npm publish` 报 `E404` / `you do not have permission` / `could not be found` | npm Trusted Publisher 未配置，或 org/repo/workflow 文件名不匹配。 | 去 npm package settings 修 Trusted Publisher。不要改成 token 发布。 |
| workflow 报 tag version mismatch | tag 前缀或版本与对应 package manifest 不一致。 | core 使用 `vX.Y.Z`；Adapter 使用 `provider-ai-sdk-vX.Y.Z`，修正后重打。 |
| `npm publish` 报版本已存在 | npm 不允许覆盖已发布版本。 | 如果 npm 上的同版本就是这次产物，可视为幂等完成；否则 bump 新版本。 |
| tarball 缺 CLI bin | `package.json#files` 没包含 `bin`，或 `bin/linnkit.cjs` 不存在。 | 修 manifest / bin wrapper，重新 dry-run。 |
| 外部 import 报 `Missing tiktoken_bg.wasm` 或类似资源缺失 | 第三方依赖被 tsup inline，资源没进包。 | 确认依赖同时在 `package.json#dependencies` / `peerDependencies` 和 `tsup.config.ts#external`，并跑 dist smoke。 |
| GitHub Release 正文不对 | `CHANGELOG.md` 对应版本段缺失或格式不对。 | 修 `CHANGELOG.md`，重新跑 workflow 或手动更新 GitHub Release。 |

## 7. 应急本地发布

只在 GitHub Actions / npm OIDC 故障且确实必须发包时使用。常规发版不要走这条路。

前置条件：

- maintainer 本地已登录 npm，且有 `@linnlabs/linnkit` publish 权限。
- 本地 `main` 与公开仓 `origin/main` 对齐。
- 第 3 节检查全部通过。

执行：

```bash
npm publish --access public --provenance
```

本地发布完成后仍要：

- 推送公开仓 `main` 和 `vX.Y.Z` tag。
- 确认 GitHub Release 从 `CHANGELOG.md` 补齐。
- 在 [`RELEASE-HISTORY.md`](./RELEASE-HISTORY.md) 记录为什么绕过常规 workflow。

## 8. 维护约束

- `package.json#files` 必须继续排除 `src`、`docs/framework`、`docs/release`、`docs/99-research-notes` 和开发手册。
- `package.shell.test.ts`、`package.runtime-import.test.ts`、`package.events-browser-safe.test.ts` 是发布包边界的守门测试，不能因为“只是文档/打包麻烦”跳过。
- `packages/provider-ai-sdk` 必须继续拥有自己的 manifest、构建、Vitest 配置、conformance、packed runtime smoke、LICENSE 和 CHANGELOG；禁止反向依赖公开仓根脚本或 Host 私有路径。
- Adapter 可以依赖 Linnkit 公开 `/ports`、`/contracts`，Linnkit core 禁止反向依赖 Adapter 或任何 `@ai-sdk/*` package。
- 公开 API 和版本兼容性写进 `CHANGELOG.md`；内部原因和长叙事写进 `RELEASE-HISTORY.md`；本文只在流程变化时更新。
