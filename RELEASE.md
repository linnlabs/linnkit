# linnkit · Release / Publish 流水

> **状态**：✅ 0.1.0 工程层就位（2026-04-23）；剩 §5 checklist 的 token / tag / 首发动作尚未触发
> **拍板背景**：linnsy 准备独立建仓，必须有"linnsy 通过包管理器装 linnkit"的稳定路径。本文是这条路径的**单一权威**。
> **目标**：让任意外部仓库（首先是 linnsy）能用 `npm install @linnlabs/linnkit` 装到一份**编译后的、版本化的** linnkit。
>
> **修订记录**：
> - 2026-04-23 v0：立项 + 规格草稿（拍板表 + 草拟 customConditions 双入口方案）
> - 2026-04-23 v1：工程层全部落地。**关键修订**：dev 体验改用 **paths/alias 平行别名**（`linnkit*` + `@linnya/linnkit*` 两组同时登记），而非 `customConditions: ["linnya-dev"]` —— 因为 linnya 主仓本就不通过 node_modules 解析 linnkit，而是靠 `tsconfig.paths` + `vite.alias` + `vitest.alias` 直读 src，customConditions 在这条路径上不会生效。详见 §1.3。
> - 2026-04-23 v2：**架构归位**——把 `LlmCallOptions` / `ToolCallChunk` / `LlmResponseContent` / `LlmRetryConfig` / `ToolCall` 5 个 AI 引擎协议 type 从 `runtime-kernel/llm/caller.types.ts`（实现层）搬到 `ports/ai-engine.types.ts`（协议层）。原位置改为从 `../../ports` barrel re-export，保持 `llm.LlmCallOptions` namespace 访问语法不变。效果：`ports ⇄ runtime-kernel` 反向循环依赖彻底消除，rollup dts 打包层不再有 circular 警告；`LlmCaller` 全部 47 个单测 + linnya 主仓 boundary guard / harness integration test 全绿。
> - 2026-04-23 v3：**scope 重选 `@linnya` → `@linnlabs`**。发包前置检查时实测发现 v0 拍板表里"`@linnya` org 已存在"是错的——`github.com/linnya` 是一个 2016 年注册、2018 年后废弃的个人 user 账号（type=User，name="linnya network"），不属于自己；同时 `@linn` 这个最干净的总品牌 scope 被英国 Hi-Fi 公司 Linn Products（github.com/linn，verified org，2014 注册）永久占用。新拍板：用 `@linnlabs`（GitHub username 可注册，命名学上明确表达 "linn 系列总品牌伞"），未来 `@linnlabs/linnya`、`@linnlabs/linnsy` 也都挂同一 scope。所有出现 `@linnya/linnkit` 的位置（包名、tsconfig paths、vite/vitest alias、shell test、CI workflow scope、各种文档表格）一并替换为 `@linnlabs/linnkit`，旧名 `linnkit*` 别名仍保留，linnya 主仓 ~170 处 `import 'linnkit'` 零改动。详见 §0 拍板表 + §1.3。

---

## 0. 拍板表（2026-04-23 v3）

| 维度 | 选择 | 理由 |
|------|------|------|
| **包名** | `@linnlabs/linnkit`（scoped）| scope `@linnlabs` 是 linn 系列总品牌伞（不是单一产品名），未来 linnya / linnsy 都挂同 scope；`@linn`（被音响公司占）/ `@linnya`（被废弃 user 占）实测都不可注册 |
| **registry** | **GitHub Packages**（私有 scope）| 免费；不必承诺公开 API 稳定；`linnlabs` org 待新建（GitHub username 经探测可用）；CI 一条 token 搞定 |
| **何时发** | **S0 阶段**（在 S1 启动**前**完成 0.1.0 首发）| 用户拍板：S0 启动会后立刻把 build/dist/publish 全链路打通；linnsy daemon 第一次 install 就走 registry，不再走 workspace |
| **当前版本** | `0.1.0`（首发）| 0.x = pre-release 期，不承诺 semver minor 兼容性，只承诺 patch 兼容；任何"加新 export / 改既有签名"都 bump minor |
| **稳定性边界** | 公开面 = `package.json#exports` 的 6 个子入口（详见 §3）| 任何不在 exports 里的内部模块都不算 public API；接入方深 import 视为越界 |
| **build 工具** | tsup（与 linnya backend 同款）| 输出 cjs + esm + .d.ts；与 6 个子入口对应 6 份 dist |

---

## 1. 工程层 3 件套（已落地）

> 本节描述实施完成态。任何修订都必须把对应文件 + `package.shell.test.ts` 断言一起改。

### 1.1 build 流水（tsup → dist/）

权威文件：[`packages/linnkit/tsup.config.ts`](./tsup.config.ts)

形态：

- `entry` 用 object map 给 6 个公开入口都指定输出名，输出布局**与 `package.json#exports` 1:1**：
  - `.`                       → `dist/index.{js,cjs,d.ts}`
  - `./ports`                 → `dist/ports.{js,cjs,d.ts}`
  - `./contracts`             → `dist/contracts.{js,cjs,d.ts}`
  - `./runtime-kernel`        → `dist/runtime-kernel.{js,cjs,d.ts}`
  - `./runtime-kernel/events` → `dist/runtime-kernel/events.{js,cjs,d.ts}`（browser-safe slim seam）
  - `./context-manager`       → `dist/context-manager.{js,cjs,d.ts}`
  - `./testkit`               → `dist/testkit.{js,cjs,d.ts}`
- `format: ['cjs', 'esm']`、`platform: 'node'`、`target: 'node20'`、`dts: true`、`sourcemap: true`、`clean: true`
- `splitting: false`：多入口禁用 chunk 共享；保证 require/cjs 形态稳定，接入方任何 deep import 都自给自足
- `external: ['vitest']`：testkit 入口对 vitest 的依赖必须由接入方在自己的 devDeps 里装（已被 `package.shell.test.ts` + `AGENT-GUARD-10` 双重守护）

约束（违反即 break）：

- **7 份 dist 入口必须全部 emit**（6 个公开 + 1 个 events slim seam）；缺一个 = `package.shell.test.ts` 红 + CI workflow 红
- `./runtime-kernel/events` 的 dist 必须 **browser-safe**——禁止引入 `node:async_hooks` / `crypto` / `fs` / `os` / `path`；2026-04-23 首次 build 已验证产物里无任何 `node:*` 引用

### 1.2 `package.json` 已切到发包形态

权威文件：[`packages/linnkit/package.json`](./package.json)

要点：

- `name`：`@linnlabs/linnkit`
- `version`：`0.1.0`
- 不再设 `private`
- `type`：`module`；`main` / `module` / `types` 都指 `./dist/index.{cjs,js,d.ts}`
- `exports`：6 个子入口 + `./package.json`，每个子入口都是 conditional export（`types` / `import` / `require` 三件套）
- `files`：`["dist", "src/README.md", "src/INTEGRATION_GUIDE.md", "src/DEVELOPMENT_GUIDE.md", "RELEASE.md"]` —— 不发 `src/**/*.ts`
- `publishConfig`：`registry: https://npm.pkg.github.com/`、`access: restricted`（双重防误发到公开 npm）
- `repository.directory`：`packages/linnkit`（npm 识别 monorepo 子包）
- `scripts`：`build` / `build:clean` / `prepublishOnly` / `publish:gh` / `publish:dry-run` / `test:smoke` / `typecheck`
- `linnkit.notes`：里面的 5 条不变量（首发版本、events slim、前端禁全展开、monorepo paths/alias 双名机制、0.x semver 策略）由 `package.shell.test.ts` 守护

`.npmignore`（权威：[`packages/linnkit/.npmignore`](./.npmignore)）作为 `files` 白名单的兜底黑名单，把 `src/**/*.ts`、`__tests__/`、`tsup.config.ts`、`tsconfig.json` 等开发期文件挡掉。

### 1.3 monorepo 内 linnya 怎么继续工作？—— **paths/alias 平行别名**

**关键事实**：linnya 主仓不通过 node_modules 解析 linnkit。它一直靠三处 alias 直读 `packages/linnkit/src/`：

| 配置文件 | 作用 |
|----------|------|
| [`tsconfig.json#compilerOptions.paths`](../../tsconfig.json) | TypeScript 类型解析 |
| [`vite.config.mjs#resolve.alias`](../../vite.config.mjs) | electron renderer 运行时 |
| [`vitest.config.ts#resolve.alias`](../../vitest.config.ts) | 单测运行时 |

所以 `customConditions: ["linnya-dev"]` 这种 conditional exports 方案在 linnya 这条路径上**不会被触发**。`exports` 字段只在 Node/打包器走 `node_modules/@linnlabs/linnkit/package.json` 时才生效，而 linnya 根本不读它。

正确的做法：**两套别名同时登记到同一份 src**。

linnya 三处 alias 在 `linnkit*` 系列的基础上，**平行**加一份 `@linnlabs/linnkit*`：

| 别名（旧） | 别名（新真包名） | 解析到 |
|------------|------------------|--------|
| `linnkit` | `@linnlabs/linnkit` | `packages/linnkit/src/index.ts` |
| `linnkit/ports` | `@linnlabs/linnkit/ports` | `packages/linnkit/src/ports/index.ts` |
| `linnkit/contracts` | `@linnlabs/linnkit/contracts` | `packages/linnkit/src/contracts/index.ts` |
| `linnkit/runtime-kernel` | `@linnlabs/linnkit/runtime-kernel` | `packages/linnkit/src/runtime-kernel/index.ts` |
| `linnkit/runtime-kernel/events` | `@linnlabs/linnkit/runtime-kernel/events` | `packages/linnkit/src/runtime-kernel/events/index.ts`（**前缀必须排在 `runtime-kernel` 之前**，否则被前缀劫持，把 Node-only 子树拖进 frontend bundle） |
| `linnkit/context-manager` | `@linnlabs/linnkit/context-manager` | `packages/linnkit/src/context-manager/index.ts` |
| `linnkit/testkit` | `@linnlabs/linnkit/testkit` | `packages/linnkit/src/testkit/index.ts` |

效果：

- linnya 主仓 ~170 处 `import 'linnkit'` / `import 'linnkit/...'` **零成本保留**（兼容旧名）
- 新代码、`linnsy` daemon、任何外部消费者都用真包名 `@linnlabs/linnkit`
- 两组别名指向同一份 src，dev 体验完全一致
- `package.shell.test.ts` 同时断言两组 alias 的存在，删旧别名前必须先 codemod 把全部 `import 'linnkit'` → `import '@linnlabs/linnkit'`

> **未来路径**：S1+ 任意时机做一次性 codemod 把 linnya 内全部 `linnkit*` 旧名改成 `@linnlabs/linnkit*`，然后从三处 alias 删掉旧条目，保留单一名字。这是独立 PR，不阻塞 linnsy。

---

## 2. GitHub Packages 配置

### 2.1 仓库侧（当前 monorepo）

权威文件：[`.github/workflows/release-linnkit.yml`](../../.github/workflows/release-linnkit.yml)

形态：

- 触发：push tag `linnkit-v*` 或 `workflow_dispatch`（手动；带 `dry_run` 选项）
- 步骤（在 `packages/linnkit` 工作目录）：
  1. checkout
  2. `actions/setup-node@v4`（registry-url=`https://npm.pkg.github.com/`、scope=`@linnlabs`，自动注入 `NODE_AUTH_TOKEN`）
  3. 根目录 `npm ci`（拉 tsup / vitest 等）
  4. **校验 `package.json#name === '@linnlabs/linnkit'`**（防误改）
  5. **校验 git tag 版本号 === `package.json#version`**（防 tag 漂移；只在 push 触发时校验）
  6. `npm run test:smoke` → `npm run build`
  7. **校验 7 份 dist 入口产物全部就位**（`index` / `ports` / `contracts` / `runtime-kernel` / `runtime-kernel/events` / `context-manager` / `testkit` 各 3 件套，缺一即红）
  8. `npm pack --dry-run` 一份 tarball 摘要到日志
  9. `npm publish`（dry-run 模式跳过）

发版操作：

```bash
# 在 packages/linnkit 改完代码
cd packages/linnkit
npm version 0.1.1 --no-git-tag-version          # 只 bump package.json，不自动 tag
git add package.json && git commit -m "chore(linnkit): release 0.1.1"

# 在仓库根打语义化 tag（前缀必须是 linnkit-v，与 workflow on.push.tags 对齐）
git tag linnkit-v0.1.1
git push origin main linnkit-v0.1.1
```

CI 看到 `linnkit-v*` tag 就自动校验 + build + publish 到 `https://github.com/orgs/linnlabs/packages`。

### 2.2 消费者侧（linnsy 仓 / 任何接入方）

仓库根加 `.npmrc`（参考模板：[`packages/linnkit/.npmrc.example`](./.npmrc.example)）：

```
@linnlabs:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

CI / 本地都需要 token：

- 本地开发：用一个有 `read:packages` 权限的 PAT，写进 shell 环境（如 `export NPM_TOKEN=ghp_xxx`，或走 1Password CLI / `direnv`）
- CI：GitHub Actions 自动注入 `secrets.GITHUB_TOKEN`（如果是组织内仓库；跨组织时建 dedicated PAT）

`package.json` 装 dep：

```jsonc
{
  "dependencies": {
    "@linnlabs/linnkit": "^0.1.0"
  }
}
```

> linnya 主仓本身**不需要这份 .npmrc**——它通过 paths/alias 直读 src，不走 node_modules（详见 §1.3）。

---

## 3. 公开 API 边界（凡是不在这里的都是私有）

| 子入口 | 用途 | 稳定性承诺 |
|--------|------|------------|
| `@linnlabs/linnkit` | 框架总入口 | 0.x = patch 兼容，minor 可能 break |
| `@linnlabs/linnkit/ports` | host 必须实现的 ports | ⭐ 最核心稳定面 |
| `@linnlabs/linnkit/contracts` | host ⇔ engine 共享 contracts / 类型 | ⭐ 最核心稳定面 |
| `@linnlabs/linnkit/runtime-kernel` | runtime 全展开（**Node-only**）| 内部演进可能频繁；接入方装配时小心 |
| `@linnlabs/linnkit/runtime-kernel/events` | events governance 纯函数（**browser-safe**） | ⭐ slim seam，**永远不允许引入 Node-only 依赖** |
| `@linnlabs/linnkit/context-manager` | 上下文子系统 | preprocessor / provider 可能新增；既有签名稳定 |
| `@linnlabs/linnkit/testkit` | **测试代码专用**（生产路径禁用，由 `AGENT-GUARD-10` 强制）| 测试夹具签名稳定 |

**红线**：

- ❌ 接入方禁止 deep import `@linnlabs/linnkit/runtime-kernel/internal/...` 之类路径（exports 不暴露 = 私有）
- ❌ 接入方生产代码禁止 import `@linnlabs/linnkit/testkit`（与 linnya 同款 `AGENT-GUARD-10-no-testkit-in-production` 守门规则）
- ❌ 0.x 期间不接受 "linnkit 帮我加协议" 的请求；按 [`docs/framework/04-protocol-roadmap.md`](./src/docs/framework/04-protocol-roadmap.md) 的 4 thresholds 评估

---

## 4. 版本号策略（0.x 期间）

| 改动类型 | bump 哪一位 | 例 |
|----------|-------------|-----|
| bug fix / 实现优化 / 不改 exports / 不改既有签名 | **patch** | 0.1.0 → 0.1.1 |
| 新增 exports / 既有 export 加可选参数 / 新增 type | **minor** | 0.1.x → 0.2.0 |
| 删除 exports / 改既有签名 / 删 type / 改运行时行为破坏既有调用 | **minor**（0.x 期）| 0.1.x → 0.2.0 |
| 进入"长期稳定承诺"阶段 | **major 1.0.0** | 0.x → 1.0.0 |

> 0.x 期间不区分 minor 和 break——都 bump minor。这是 npm 0.x 惯例，让接入方 `^0.1.0` 不会偶然吃到 break。

---

## 5. S0 阶段实施 checklist

S0 启动会后由 linnkit owner 执行，必须先于 S1 完成。
**5.1 ~ 5.4 已于 2026-04-23 一次性落地**；剩余 5.5 ~ 5.9 在 S0 启动会后触发。

- [x] **5.1** 在 `packages/linnkit/` 加 `tsup.config.ts`，7 份入口（6 公开 + 1 events slim）都 emit cjs + esm + .d.ts
- [x] **5.2** 跑 `npm run build`，验证 dist/ 生成完整；`./runtime-kernel/events` 的 dist 不含任何 `node:*` import（已 grep 验证）
- [x] **5.3** 改 `package.json`：去掉 `"private"`、改 `name` 为 `@linnlabs/linnkit`、`version` 为 `0.1.0`、exports 指向 dist（conditional `types`/`import`/`require`）、加 `publishConfig` / `repository` / `files` / `.npmignore`
- [x] **5.4** **paths/alias 平行别名**（替代原计划的 `customConditions`）：linnya 三处 alias（tsconfig / vite / vitest）同时登记 `linnkit*` + `@linnlabs/linnkit*`，`package.shell.test.ts` 守门两组别名同时存在；linnya 主仓 dev 体验零变化（已抽样 `src/tools/__tests__/registry.test.ts` 验证 alias 解析无回归）
- [x] **5.5a** **新建 GitHub org `linnlabs`**（GitHub UI 操作；Free plan 即可）—— 2026-04-23 落地；GitHub username `linnlabs` 可注册并已锁定，未来 `@linnlabs/linnya`、`@linnlabs/linnsy` 也都挂同 scope
- [x] **5.5b** **走 dedicated PAT 路径**（不做仓库 transfer）—— 2026-04-23 落地：在 `BCAutumn/Tingtalk_official_version` repo settings 加 secret `LINNLABS_NPM_TOKEN`（classic PAT, scope = `repo` + `write:packages` + `read:packages`，90 天过期）；workflow yml `NODE_AUTH_TOKEN` 引用从 `secrets.GITHUB_TOKEN` 切到 `secrets.LINNLABS_NPM_TOKEN`。理由：本仓 owner 是个人账号、包 scope owner 是 org（linnlabs），repo-scoped 的 `secrets.GITHUB_TOKEN` 不能跨 owner publish。等 `linnkit` source 未来迁到 `linnlabs/linnkit` 独立仓时（同 owner），可改回 `secrets.GITHUB_TOKEN` 并删除该 PAT。
  - **PAT rotate 流程**（90 天到期或泄漏时）：①`https://github.com/settings/tokens` revoke 旧 token → ②同页面新建同 scope token → ③本地 `nano ~/.npmrc` 替换（**不要 cat / heredoc，避免泄漏到 shell history**）→ ④`https://github.com/BCAutumn/Tingtalk_official_version/settings/secrets/actions` 编辑 `LINNLABS_NPM_TOKEN` 重新粘贴 → ⑤`npm whoami --registry=https://npm.pkg.github.com/` 验证本地 → ⑥workflow_dispatch dry-run 验证 CI
- [x] **5.6** workflow_dispatch + `dry_run=true` 跑通 —— 2026-04-23 落地：CI run 2m 2s Success，`Publish to GitHub Packages` 步骤按预期 skipped；`https://github.com/orgs/linnlabs/packages` 仍为引导页（零包）确认 dry-run 没真发
- [x] **5.7** 打 tag `linnkit-v0.1.0` → CI 真发 —— 2026-04-23 落地：包已上 `https://github.com/orgs/linnlabs/packages`；`npm view @linnlabs/linnkit --registry=https://npm.pkg.github.com/` 输出 `@linnlabs/linnkit@0.1.0 | UNLICENSED | deps: none | versions: 1 | latest: 0.1.0 | published by BCAutumn`，shasum + sha512 integrity 齐全
  - **0.1.0 manifest 已知瑕疵**（不影响包可用性，下版本修）：homepage / repository.url / bugs.url 在发包当时错写为虚构的 `linnya/linnya`，0.1.1 已修正为真实仓库 `BCAutumn/Tingtalk_official_version`；GitHub Packages 不支持改已发版本 manifest，所以 0.1.0 元数据保持原样直至 0.1.1 出现
- [ ] **5.8** 在新建的 `packages/linnsy-daemon/` 内通过 `.npmrc`（参考 [`packages/linnkit/.npmrc.example`](./.npmrc.example)）+ `"@linnlabs/linnkit": "^0.1.0"` 装一次，跑通 `linnsy doctor` 验证装配链路 —— **留待 S1 启动时执行**
- [ ] **5.9** 同步更新 [`linnsy/02c-tech-stack.md §3`](../../linnsy/02c-tech-stack.md) 的 `package.json` 草稿，把 `"linnkit": "workspace:*"` 注释成历史，正式形态改为 `"@linnlabs/linnkit": "^0.1.0"`（草稿当前已是新形态，复核即可）—— **留待 S1 启动时执行**

---

## 6. 与已有文档的关系

| 文档 | 关系 |
|------|------|
| [`src/README.md`](./src/README.md) | linnkit 包整体说明；§5.2 6 个公开子入口的语义不变；本文是它的"发包侧"补充 |
| [`src/DEVELOPMENT_GUIDE.md`](./src/DEVELOPMENT_GUIDE.md) | dev 流程；本文新增 build / publish 步骤 |
| [`src/INTEGRATION_GUIDE.md`](./src/INTEGRATION_GUIDE.md) | 接入方装配指南；本文新增"装包"前置步骤（.npmrc + GitHub Token） |
| [`src/docs/framework/04-protocol-roadmap.md`](./src/docs/framework/04-protocol-roadmap.md) | 升级判定 4 thresholds；本文不动 |
| [`linnsy/02c-tech-stack.md`](../../linnsy/02c-tech-stack.md) | linnsy 技术栈；§3 deps 草稿是 linnkit 发包的第一个消费者 |
| [`linnsy/plan/phase1/02-sprint-plan.md`](../../linnsy/plan/phase1/02-sprint-plan.md) | Sprint S0 任务 T0.7 ~ T0.9 引用本文 §5 实施 checklist |

---

## 7. 状态

- [x] 拍板表落地（2026-04-23）
- [x] 工程层 3 件套规格落地
- [x] GitHub Packages 配置规格落地
- [x] 公开 API 边界 + 版本号策略落地
- [x] S0 实施 checklist 落地
- [x] **§5.1 ~ §5.4 工程层就位**（2026-04-23）：tsup config / build / package.json / paths-alias 双名机制 + smoke test + boundary guard 全绿
- [x] **§5.5 凭据层就位**（2026-04-23）：`linnlabs` org 已注册 + classic PAT 已生成（90 天过期）+ 本地 `~/.npmrc` 配置 + `npm whoami` 验证为 `BCAutumn` + repo secret `LINNLABS_NPM_TOKEN` 已加 + workflow yml 切到 dedicated PAT
- [x] **§5.6 ~ §5.7 首发完成**（2026-04-23）：workflow_dispatch dry-run 2m 2s Success + 打 tag `linnkit-v0.1.0` 触发 CI 真发，`@linnlabs/linnkit@0.1.0` 已活在 GitHub Packages（npm view 验证 sha512 integrity 齐全；published by BCAutumn）
- [ ] **§5.8 ~ §5.9 留待 S1 启动**：linnsy daemon 第一次装包验证 + 02c-tech-stack 草稿复核（必须在 `packages/linnsy-daemon/` 实体存在后才能做）
- [x] **CI workflow 升级 + 0.1.0 manifest 瑕疵修正**（2026-04-23 收尾）：actions/checkout / setup-node `@v4 → @v5`（修 Node 20 deprecation warning）+ package.json 三个 URL 字段从虚构 `linnya/linnya` 改为真实 `BCAutumn/Tingtalk_official_version`（0.1.0 已带瑕疵字段无法回炉，下次 0.1.1 出现时即修正）
