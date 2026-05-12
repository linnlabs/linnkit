# `@linnlabs/linnkit` Integration Guide

这份文档只回答一件事：

**你在自己的仓库装了 `@linnlabs/linnkit`，要把一个 Agent 跑起来，至少要写什么、应该从哪里开始抄。**

> 读者画像：在外部独立仓库（如 `linnsy daemon` / `linnya`-like product / 任意自研 agent host）通过 `npm install @linnlabs/linnkit` 装包，准备从零接入的开发者。
>
> 本文不假设你在 `BCAutumn/Tingtalk_official_version` monorepo 里能直接看到 `packages/linnkit/src/*`。所有路径示例都按"装包后真实可见的子入口"写。

---

## 1. 装包

### 1.1 这个包发布在哪

`@linnlabs/linnkit` 发布到 **GitHub Packages 私有 registry**（`https://npm.pkg.github.com/`），scope 是 `@linnlabs`。原因详见包内 `docs/release/RELEASE.md` §0 v3。

### 1.2 `.npmrc` 配置

在你的项目根目录新建 `.npmrc`（**不要提交里面的 `_authToken` 明文，请用环境变量**）：

```ini
@linnlabs:registry=https://npm.pkg.github.com/
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

`GITHUB_PACKAGES_TOKEN` 必须是一个具备 `read:packages` 权限的 GitHub Personal Access Token（且账号要被授权访问 `BCAutumn` org 的私有包）。

### 1.3 安装

```bash
npm install @linnlabs/linnkit
```

`peerDependencies`：

| peer | 说明 |
|---|---|
| `zod` (`^3.22.0`) | 必需。`@linnlabs/linnkit/contracts` 用 zod 定义所有消息/事件 schema，运行时也会校验 |
| `vitest` (`^2 \|\| ^3`) | 可选。**只有当你打算 import `@linnlabs/linnkit/testkit` 写测试时才需要装** |

`@linnlabs/linnkit/testkit` 在源码顶层 `import { vi, expect } from 'vitest'`，所以生产代码 **绝对不能** import 这个子入口（详见 §8 boundary 第 7 条）。

### 1.4 验证装包成功

新建一个 `smoke.ts`：

```ts
import { runtimeKernel, generateMessageId } from '@linnlabs/linnkit';
import type { AgentInvocationRequest, AgentAiEngine } from '@linnlabs/linnkit/ports';
import type { AiMessage, RuntimeEvent } from '@linnlabs/linnkit/contracts';

console.log(generateMessageId());
console.log(typeof runtimeKernel.graph);
```

`tsc --noEmit` 通过 + 运行无报错 = 装包成功。如果你在前端项目里这么写会拖进 `node:async_hooks`，请先看 §3 浏览器规则。

---

## 2. 它是什么 / 你要写什么

`@linnlabs/linnkit` 是 **vendor-neutral 的 Agent 框架**：它只提供 runtime kernel + context manager + ports + testkit，**不内置任何具体业务实现**。

一句大白话：

> 你装的这个包负责"agent 怎么跑、上下文怎么治理"，不负责"用哪个 LLM 提供商、工具集长什么样、消息怎么落库、SSE 怎么推、产品里有哪些 agent"。这些通通是你（host）要自己写的。

最小的接入面，按重要度排序：

| 你必须自己写的 | linnkit 给的接入合同（type/symbol） | 从哪里 import |
|---|---|---|
| 1. LLM provider 适配器 | `AgentAiEngine` | `@linnlabs/linnkit/ports` |
| 2. 工具集 | `BaseTool` / `ToolRuntimePort` | `@linnlabs/linnkit/runtime-kernel` |
| 3. 上下文围栏（fence）注册 + 注入适配 | `FenceRegistry` / `FenceDescriptor` / `FenceInjection` / `MustKeepPolicy` / `FenceLifetimePreprocessor` | `@linnlabs/linnkit/context-manager` |
| 4. 持久化适配器 | `Checkpointer` / `EventStore` / `RunRegistryStore` | `@linnlabs/linnkit/runtime-kernel` |
| 5. 实时通道（SSE/WebSocket/MQTT） | （linnkit 不规定接口）从 `RuntimeEvent` 自己映射 | `@linnlabs/linnkit/contracts` |
| 6. graph executor 装配 + 默认 LLM/Tool node | `runtimeKernel.graph.GraphExecutor` 等 | `@linnlabs/linnkit/runtime-kernel` |
| 7. agent / chat / task 注册表 | `promptKey` 是 opaque string，linnkit 不认识你的产品菜单 | （host 自定义） |
| 8.（可选）telemetry | `TelemetryPort` | `@linnlabs/linnkit/runtime-kernel` |

> 推荐目录形态（host 仓库内）：
>
> ```text
> app-hosts/<your-app>/
> ├── adapters/
> │   ├── runtime-assembly/   # 把 GraphExecutor / LlmNode / ToolRuntime 拼起来
> │   ├── context-injection/  # context builder + 注入 host 请求字段为 fences
> │   ├── flow/               # history 读取 / pre-run policy / host session
> │   ├── realtime/           # SSE / WebSocket / MQTT
> │   ├── persistence/        # Checkpointer / EventStore / RunRegistryStore 实现
> │   └── tools/              # 默认 ToolManager 装配
> ├── agent-registry/         # 你的 agent / chat / system 定义
> ├── context/
> │   ├── agent/              # host invoke request shape + fence 注册 + injection adapter
> │   └── chat/               # （只在你还要兼容 chat 时需要）
> ├── context-policies/       # MustKeepPolicy / provider registry / 截断比例
> └── testkit/                # host-bound harness（依赖你的默认 adapter）
> ```
>
> 这个形态是建议而不是强制。但下面的术语全部按这个分层取名，方便对得上号。

---

## 3. 公开 API surface（7 个稳定子入口）

`package.json#exports` 写死的子入口当前是 7 个。任何不在这张表里的"deep import"（比如 `@linnlabs/linnkit/context-manager/shared/preprocessors/...`）都不算公开 API，下个 minor 升级随时可能挪。

| 子入口 | 适用环境 | 你能从这里 import 到什么 |
|---|---|---|
| `@linnlabs/linnkit` | **Node-only** | `runtimeKernel` / `ports` / `contracts` 三个 namespace；`generateMessageId` / `generateRunId` / `withLLMTelemetryContext` / `setLlmAuditRecorder` |
| `@linnlabs/linnkit/ports` | **Node-only** | `AgentInvocationRequest` / `AgentAiEngine` / `AgentAiEngineStreamContent` / `LlmCallOptions` / `LlmRequestMessage` / `ToolCall` 等 host 必须实现的合同 |
| `@linnlabs/linnkit/contracts` | **Node-only** | 长期稳定的合同：`AiMessage` / `SystemMessage` / `UserMessage` / `AssistantMessage` / `ToolMessage` / `RuntimeEvent` / `EventEnvelope` / `SSEEvent` / 默认执行常量 |
| `@linnlabs/linnkit/runtime-kernel` | **Node-only**（含 `node:async_hooks` / `crypto`） | 全套 runtime：`graph` / `tools` / `execution` / `events` / `runContext` / `llm` / `childRuns` / `runSupervisor` / `telemetry` 等 namespace + 扁平 `BaseTool` / `ToolExecutionContext` / `ENGINE_ERROR_CODES` 等符号 + `createGraphLoopHarness` / `createDefaultGraphExecutor`（仅测试用） |
| `@linnlabs/linnkit/runtime-kernel/events` | **浏览器安全** | events governance 纯函数：`shouldPersistRuntimeEvent` / `shouldEnterAgentContext` / `shouldEmitRuntimeEventToSse` / `shouldReplayRuntimeEventToUi` / `getRuntimeEventUiProjectionKind` / `eventMapper`，外加 `AnyAgentEvent` / `RuntimeEventLifecycleDecision` 类型 |
| `@linnlabs/linnkit/context-manager` | **Node-only** | context core：`createMessageFormatter` / `formatAgentLlmMessages` / `messageFormatter` / `createFenceRegistry` / `FenceDescriptor` / `FenceInjection` / `FenceRegistry` / `FenceLifetimePreprocessor` / `MustKeepPolicy` / `DEFAULT_MUST_KEEP_POLICY` / `BaseContextProvider` / `AGENT_CONSTANTS` / agent profile namespace（`agentContext` / `agentTasks` / `agentOrchestration` 等）+ chat 兼容层的少量扁平导出（`ChatMessageOrchestrator` / `BaseConversationalTask` / `chatMessageToAiMessage` 等）。`chatContext` / `chatTasks` / `chatOrchestration` 等 chat namespace 已从主入口冻结移除。 |
| `@linnlabs/linnkit/testkit` | **测试专用** | scripted AI engine harness、graph loop harness、tool context fixture、replay harness、断言。`AGENT-GUARD-10-no-testkit-in-production` 强制守门——生产代码不能 import |

### 3.1 浏览器使用规则（硬约束）

**前端代码（renderer / browser bundle）禁止 import `@linnlabs/linnkit/runtime-kernel`**。这条入口是 namespace 全展开，会把 `node:async_hooks` / `crypto` 等 Node-only 子树拖进 frontend bundle。

前端如果只是要做事件展示决策（"这条 RuntimeEvent 该不该回放给 UI？"），从 **`@linnlabs/linnkit/runtime-kernel/events`** 这个 slim seam 取纯函数：

```ts
// renderer/src/agentEventPolicy.ts
import {
  shouldReplayRuntimeEventToUi,
  getRuntimeEventUiProjectionKind,
} from '@linnlabs/linnkit/runtime-kernel/events';
import type { RuntimeEvent } from '@linnlabs/linnkit/contracts';
```

`@linnlabs/linnkit/contracts` 是纯 zod schema + 类型，技术上前端也可 import；但 zod 体积非零，前端按需。

### 3.2 import 选择决策

```text
要决定一条 import 应该走哪个子入口？
├── 我在前端 bundle 里？
│   └── 是 ──▶ 只能是 /runtime-kernel/events 或 /contracts
├── 我在测试代码里？
│   └── 是 ──▶ 可以 /testkit；其它子入口照常用
├── 我要类型/合同？
│   └── 是 ──▶ /ports（host 实现合同）或 /contracts（消息/事件合同）
├── 我要 context 和 fence 机制？
│   └── 是 ──▶ /context-manager
└── 其它（runtime 装配、graph、tool runtime、LLM caller 骨架）─▶ /runtime-kernel
```

不要 `import { something } from '@linnlabs/linnkit/runtime-kernel/<deep>'`。`exports` 字段没声明的路径在 Node 16+ ESM 解析下会直接报错，且任何 deep path 都不在稳定 API 范围。

---

## 4. 5 分钟最小 host 骨架

下面这段是"装包后能跑通一轮 agent 对话"的最小骨架。它故意不引入 SSE / persistence / telemetry，把这些放到 §5-§6 单独展开。

### 4.1 host 需要的 5 个文件

```text
app-hosts/your-app/
├── adapters/
│   ├── llm/MyLlmProvider.ts            # 实现 AgentAiEngine
│   ├── tools/myToolRegistry.ts          # BaseTool[]
│   └── runtime-assembly/createExecutor.ts
├── context/agent/myFences.ts            # FenceRegistry 注册
└── index.ts                             # 装配入口 + 跑一轮 demo
```

### 4.2 文件骨架（伪代码级，编译前需要补全细节）

```ts
// adapters/llm/MyLlmProvider.ts
import type { AgentAiEngine, AgentAiEngineStreamContent, LlmCallOptions, LlmRequestMessage } from '@linnlabs/linnkit/ports';

export class MyLlmProvider implements AgentAiEngine {
  async chatCompletion(modelId: string, messages: LlmRequestMessage[], options?: LlmCallOptions): Promise<unknown> {
    // 调用你家 SDK 的非流式接口；返回 OpenAI 风格响应即可
  }
  async chatCompletionStream(modelId, messages, options, onContent, onError, onFinish, onThought, onUsage) {
    // 调用流式接口；每个 chunk 转成 AgentAiEngineStreamContent 调 onContent；
    // 完成时 onFinish('stop' | 'tool_calls')；usage 走 onUsage
  }
}
```

```ts
// adapters/tools/myToolRegistry.ts
import { BaseTool, type ToolExecutionContext } from '@linnlabs/linnkit/runtime-kernel';

export class EchoTool extends BaseTool {
  name = 'echo';
  description = '回声测试';
  parameters = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } as const;

  async execute(args: { text: string }, _context: ToolExecutionContext) {
    return { kind: 'success', data: { echoed: args.text } };
  }
}

export const tools = [new EchoTool()];
```

```ts
// context/agent/myFences.ts
import { createFenceRegistry, type FenceDescriptor } from '@linnlabs/linnkit/context-manager';

export const myFenceDescriptors: FenceDescriptor[] = [
  // 第一次接入可以先空着；之后按 §5.4 一行行加
];

export const myFenceRegistry = createFenceRegistry(myFenceDescriptors);
```

```ts
// adapters/runtime-assembly/createExecutor.ts
import { runtimeKernel } from '@linnlabs/linnkit';
import { MyLlmProvider } from '../llm/MyLlmProvider';
import { tools } from '../tools/myToolRegistry';

export function createExecutor() {
  const aiEngine = new MyLlmProvider();
  const llmCaller = new runtimeKernel.llm.LlmCaller({
    aiEngine,
    modelResolver: /* 你自己实现的 ModelResolver；把 modelId → provider/model 解析好 */,
  });
  // 把 llmCaller、tools、fence-aware orchestrator 装进 GraphExecutor 依赖袋
  // 详细签名见 @linnlabs/linnkit/runtime-kernel 的 graph namespace
  return /* GraphExecutor */;
}
```

```ts
// index.ts
import { createExecutor } from './adapters/runtime-assembly/createExecutor';

async function main() {
  const executor = createExecutor();
  const result = await executor.runUntilYield({
    request: { query: '你好', promptKey: 'default', model_id: 'gpt-5' },
    history: [],
  });
  console.log(result);
}
main();
```

### 4.3 这一节为什么是骨架而不是 copy-paste 可跑

`GraphExecutor` 的依赖袋在 0.x 仍在收口（不是稳定 public 形状）。**官方的可参考装配示例** 在仓库 `BCAutumn/Tingtalk_official_version`（即 linnkit 的真源仓） 的 `src/app-hosts/linnya/adapters/runtime-assembly/*`、`src/app-hosts/linnya/adapters/context-injection/defaultGraphExecutorContextBuilder.ts` 下。如果你需要它们的具体形状，请直接对着那份代码抄一遍；不要凭这份指南猜。

后续 §5 / §6 给的是**单点接入合同**——这些是稳定的，可以放心抄。

---

## 5. 单点接入指南（每点都可独立完成）

每一节用相同结构：

- **linnkit 给你的合同**（type / symbol）
- **linnkit 自带的 mock primitive**（写测试用）
- **你必须做的**
- **你不要做的**
- **最小验证**

### 5.1 跑一个 agent

**linnkit 给你的合同**

- `AgentInvocationRequest`（来自 `@linnlabs/linnkit/ports`）：runtime 真正读取的字段（`query` / `promptKey` / `model_id` / `mode` / `availableTools` / `conversationHistory` / `maxSteps`）。你的产品 invoke request 通过结构类型自然满足它。
- `runtimeKernel.graph`（来自 `@linnlabs/linnkit/runtime-kernel`）：`GraphExecutor` 等核心装配点。

**linnkit 自带的 mock primitive**

- `createScriptedAiEngineHarness`（来自 `@linnlabs/linnkit/testkit`）：脚本化 AI 引擎，按预设把 LLM 输出 step-by-step 回放，不依赖真实 provider。
- `createGraphLoopHarness`（来自 `@linnlabs/linnkit/testkit`）：把 graph loop / LlmNode / AgentEventBridge / observationPreview 装好的 host-shape harness。

**你必须做的**

1. 定义 host 自己的请求入口（HTTP / IPC / CLI 都行），保证至少能给出 `query` / `promptKey` / `model_id` / `mode`。
2. 在 runtime-assembly 层 new 出 `GraphExecutor`，把 LLM caller、tool runtime、context builder 注入。
3. 用 `createGraphLoopHarness()` 写至少一个绿测试，确认本地装配能跑通。

**你不要做的**

- 不要在宿主代码里直接 new graph engine 内部节点（不要从某个 deep import 路径取 `LlmNode` / `ToolNode` / `AgentEventBridge` 实现细节）。
- 不要把 flow / realtime / persistence 的逻辑塞回 `@linnlabs/linnkit` 内部（也没法塞，因为是 npm 包）。
- 不要把 `promptKey` 当成 linnkit 认识的产品 enum——它在 ports 层是 opaque string。

**最小验证**

- 写一个集成测试：`ScriptedAiEngineHarness` 模拟 LLM 直接返回 `final_answer`，断言 `GraphExecutor.runUntilYield()` 产出的事件序列里有 `final_answer`。

### 5.2 接 LLM provider

**linnkit 给你的合同**

- `AgentAiEngine`（来自 `@linnlabs/linnkit/ports`）：必须实现 `chatCompletion` + `chatCompletionStream` 两个方法。流式接口的回调签名详见类型定义。
- `LlmRequestMessage` / `LlmCallOptions` / `ProviderReasoningDetails` / `ToolCallChunk` / `ToolCallExtraContent`（来自 `@linnlabs/linnkit/ports`）：调用入参与流式 chunk 形状。
- `runtimeKernel.llm.LlmCaller`（来自 `@linnlabs/linnkit/runtime-kernel`）：runtime 内部用的统一调用器，host 在 runtime-assembly 时把 `AgentAiEngine` 通过 `LlmCaller` 包一层。

**linnkit 自带的 mock primitive**

- `createScriptedAiEngineHarness`（来自 `@linnlabs/linnkit/testkit`）：满足 `AgentAiEngine` 接口的脚本化实现。它的 `getLlmCaller()` 直接产出可注入的 `LlmCaller`，写测试零样板。

**Provider replay sidecar（多家 reasoning model 必读）**

部分 provider（DeepSeek `reasoning_content`、OpenRouter / Claude reasoning blocks 等）会返回**必须随下一轮工具调用原样回传的不透明载荷**。linnkit 的 vendor-neutral 槽位是：

| 链路位置 | 字段 | 谁负责往里塞 |
|---|---|---|
| 流式 chunk / 非流式响应 | `AgentAiEngineStreamContent.reasoning_details` | 你的 provider adapter |
| RuntimeEvent | `tool_call_decision.payload.reasoning_details` | linnkit 自动 |
| 回放后的 AiMessage | `metadata.reasoning_details` 与 `metadata.tool_calls[*].extra_content` | linnkit 自动 |
| 工具调用扩展 | `tool_calls[*].extra_content` | 你的 provider adapter（写）；linnkit 回放时透传 |

你的 adapter 只负责字段互译——**把 provider 私有字段归一化进上面的通用槽位**，不要把私有字段散到 graph-engine 或 context-manager。出关到 LLM 时，host 默认装配应当用 `formatAgentLlmMessages(messages, { fenceRegistry })`（来自 `@linnlabs/linnkit/context-manager`）；它走 native tool 回放形态，会自动把 sidecar 写回去。

**你必须做的**

1. 实现一个符合 `AgentAiEngine` 的 adapter，把 HTTP / SDK 调用封进 `chatCompletion[Stream]`。
2. 在 runtime-assembly 里把 `aiEngine` 通过 `runtimeKernel.llm.LlmCaller` 包一层。
3. 实现 `ModelResolver` / `ModelCatalog`（来自 `@linnlabs/linnkit/runtime-kernel` 的 `llm` namespace），把 host 的 modelId 解析为 provider + provider modelId。

**你不要做的**

- 不要让 graph-side 代码直接知道你家 SDK 的 HTTP 形态。
- 不要在测试里 patch 模块级全局 ai engine——通过依赖注入替换。
- 不要把 provider 重试 / 审计 / fallback 逻辑散落在 host 业务文件里——收敛到 adapter 内。

**最小验证**

- 用 `createScriptedAiEngineHarness()` 写红绿测试。
- 在 host harness 里覆盖：多 provider 切换、reasoning_details 流式累积、tool_call sidecar 回放。

> 注意：被工具历史压缩 / 历史摘要替换 / chat formatter 处理过的旧工具组，不再保证 sidecar 可回放——这是 token 预算与 chat 兼容层的设计取舍。如果某个 provider 强要求 reasoning blocks 必须随回传，请确保该工具组以原始 `tool_call_decision + tool_output` 结构进入下一轮上下文。

### 5.3 接你的工具集

**linnkit 给你的合同**

- `BaseTool` + `CommonParameterTypes`（来自 `@linnlabs/linnkit/runtime-kernel`）：抽象类，要求实现 `name` / `description` / `parameters` / `execute(args, context)`。
- `ToolExecutionContext` / `ToolSchemaContext`（同上）：执行时 / schema 构建时收到的 context 形状。
- `ToolRuntimePort` / `ToolCatalogPort` / `ToolExecutionPort` / `ToolPresentationPort`（同上）：把工具集合装成"runtime 可调用"的合同；host 默认 `ToolManager` 实现要满足这些 port。
- `ObservationPreviewPort`（同上）：工具产出 observation 在 UI 展示前的预览决策点。
- `ensureToolContextRuntimeCapability`（同上）：把 runtime 必需的保留字段补进 host 的 patch，避免手抖漏字段。

**linnkit 自带的 mock primitive**

- `createToolContextFixture`（来自 `@linnlabs/linnkit/testkit`）：最小 `ToolExecutionContext`，已自动通过 `ensureToolContextRuntimeCapability` 补全 runtime 字段。

**你必须做的**

1. 把每个工具定义为 `BaseTool` 的子类（或满足 `AgentTool` 接口的对象）。
2. 决定哪些字段走通用 `ToolExecutionContext`，哪些走 host patch；patch 必须经 `ensureToolContextRuntimeCapability` 补齐保留字段。
3. 把工具集合装进 host 的 `ToolManager` / `ToolRuntimePort` 实现，让 runtime 在 LLM 决策返回 tool calls 时能 dispatch。

**你不要做的**

- 不要让工具直接吃 host 的全局单例（数据库、配置中心等都按 patch / context 注入）。
- 不要把 runtime 保留字段（`__runtime` / `__capabilities`）手工拼进 patch；统一过 `ensureToolContextRuntimeCapability`。
- 不要从 deep path 抓 helper（凡是没出现在 `@linnlabs/linnkit/runtime-kernel` 公开符号里的，下个 minor 可能就消失）。

**最小验证**

- 单测：用 `createToolContextFixture()` 直接测 `tool.execute(args, fixtureContext)`。
- 集成测：在 host-bound `ToolRuntimeHarness` 上覆盖"失败恢复 / 并行调用 / observation 预览"路径。

### 5.4 接 context engineering（fence 注册 + 注入）⭐ 一等接入面

如果你的产品需要把不同来源的上下文注入到 LLM 不同位置（比如"项目元信息塞 system 之后"、"被引用的段落塞当前用户输入之前"、"长记忆只塞当前轮"），**不要**自己在 system prompt 里手工拼 `<my_tag>...</my_tag>`，**也不要**继续借用 legacy `document_fragment` / `context_before` / `user_input`。这会被 boundary guard 拦下，并且生命周期治理失控。

正确的做法是用 linnkit 0.2.x 引入的 **fence 机制**：把每类上下文声明成一个"围栏家族"（fence kind），通过 `FenceRegistry` 注册，运行时由 `BaseAgentTask` 把 host 请求里的 `fences[]` 自动展开成 `context_injection` 消息，按 `placement` 落到正确位置；旧轮 `lifetime: 'turn-only'` 的注入由 `FenceLifetimePreprocessor` 自动剥离。

> 完整设计文档：包内 `docs/framework/08-context-engineering-package-boundary.md` + `09-context-engineering-package-boundary-plan.md`。

#### 5.4.1 概念三元组

| 概念 | 类型 | 谁产 | 谁消 |
|---|---|---|---|
| `FenceDescriptor` | 来自 `@linnlabs/linnkit/context-manager` | host 启动时声明（每类一个） | linnkit `MessageFormatter` / `FenceLifetimePreprocessor` / `MustKeepPolicy` |
| `FenceInjection` | 来自 `@linnlabs/linnkit/context-manager` | host 请求适配层每轮产 | linnkit `BaseAgentTask` 展开为 `context_injection` 消息 |
| `context_injection` 消息 | 来自 `@linnlabs/linnkit/contracts` 的 `AiMessage` 一种 type | linnkit 自动产 | 整条 context pipeline |

#### 5.4.2 注册一个 fence 家族（host 启动时一次）

```ts
// app-hosts/your-app/context/agent/registerFences.ts
import {
  createFenceRegistry,
  type FenceDescriptor,
  type FenceRegistry,
} from '@linnlabs/linnkit/context-manager';

export function createMyFenceRegistry(): FenceRegistry {
  return createFenceRegistry(createMyFenceDescriptors());
}

export function createMyFenceDescriptors(): FenceDescriptor[] {
  return [
    {
      kind: 'memory-context',                  // host 自定义 kebab-case
      llmRole: 'user',                         // 物理 role（注入时挂到 user 还是 system）
      placement: 'before-current-user',        // 在 system 后 / 当前 user 前 / 当前 user 后 / 上一组 tool result 后
      lifetime: 'turn-only',                   // 'turn-only' 只在本轮；'persisted' 进 history
      maxBudgetFraction: 0.2,                  // 可选：按总 token 预算上限
      formatter: (content, attrs) =>
        `<memory-context source="${attrs.source ?? 'unknown'}">\n${content}\n</memory-context>`,
    },
    {
      kind: 'system-event',
      llmRole: 'system',
      placement: 'after-system',
      lifetime: 'persisted',
      mustKeep: true,                          // 自动 must-keep（不会被 working memory 裁掉）
      formatter: (content) => `<system-event>\n${content}\n</system-event>`,
    },
    // 想要多少类就声明多少类
  ];
}

export const myFenceRegistry = createMyFenceRegistry();
```

**约束**：

- `kind` 必须 kebab-case（`/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/`）。
- `placement` 当前枚举：`'after-system'` / `'before-current-user'` / `'after-current-user'` / `'after-last-tool-result'`。
- 同一个 `kind` 在同一个 registry 不能重复 register。
- `maxBudgetFraction` 必须落在 `(0, 1]`。

#### 5.4.3 写一个 host 适配器：把请求字段转成 `FenceInjection[]`

这是把 host 自己的产品语义（"项目名"、"被选中的段落"、"用户引用的句子"等）翻成通用 fence 注入的关键一层。

```ts
// app-hosts/your-app/context/agent/createMyFenceInjections.ts
import type { FenceInjection } from '@linnlabs/linnkit/context-manager';
import type { MyAgentInvokeRequest } from './contracts';

export function createMyFenceInjections(request: MyAgentInvokeRequest): FenceInjection[] {
  const fences: FenceInjection[] = [];

  if (request.memorySnapshot?.trim()) {
    fences.push({
      kind: 'memory-context',
      content: request.memorySnapshot,
      attrs: { source: request.memorySource ?? 'memory-store' },
    });
  }

  if (request.systemEvent) {
    fences.push({ kind: 'system-event', content: request.systemEvent });
  }

  return [...fences, ...(request.fences ?? [])];
}

export function withMyFenceInjections(request: MyAgentInvokeRequest): MyAgentInvokeRequest {
  return { ...request, fences: createMyFenceInjections(request) };
}
```

**关键点**：

- 适配器**不直接拼字符串**——只产 `{ kind, content, attrs }` 三元组。字符串拼接由 `FenceDescriptor.formatter` 统一负责。
- 必须保留 `request.fences` 旧值（外部已经显式塞过的注入不被吞掉）。
- 不要在这里写 `<memory-context>` 字面 tag——tag 名归 fence descriptor 拥有，否则两边各拼一次会重复。

#### 5.4.4 把 registry 接到运行时（一处装配，三处消费）

```ts
// app-hosts/your-app/adapters/context-injection/myContextBuilder.ts
import {
  formatAgentLlmMessages,
  agentOrchestration,
  FenceLifetimePreprocessor,
  type MustKeepPolicy,
} from '@linnlabs/linnkit/context-manager';
import { myFenceRegistry } from '../../context/agent/registerFences';
import { withMyFenceInjections } from '../../context/agent/createMyFenceInjections';

const myMustKeepPolicy: MustKeepPolicy = {
  alwaysKeepTypes: ['system_prompt', 'user_input'],
  alwaysKeepFenceKinds: ['system-event'],   // 注：只列那些"事件本身就是事实"的 kind
  truncationRules: [
    { fenceKind: 'memory-context', maxBudgetFraction: 0.2, strategyName: 'memory-truncate' },
  ],
};

const orchestrator = new agentOrchestration.AgentMessageOrchestrator({
  tokenBudget: { maxTokens: 32_000, reservedForResponse: 4_000 },
  processing: { debugMode: false, preserveMetadata: true },
  taskResolver: myAgentTaskResolver,
  providerRegistry: myProviderRegistry,        // §5.4.5 提到
  fenceRegistry: myFenceRegistry,              // ← 关键：让 BaseAgentTask 认识 host 的 fence
  resolveToolReplayProtocolPolicy: ({ modelId }) => myToolReplayPolicy(modelId),
});

// 调 orchestrator 之前，把 host 字段转成 fences
const requestWithFences = withMyFenceInjections(request);

const processingResult = await orchestrator.processAgentConversation(
  requestWithFences,
  history,
  toolManager,
  summarizationCallbacks,
  { generate },
);

// 出关到 LLM 时，fence formatter 会被调用，每个 context_injection 消息变成具体 tag
const llmMessages = formatAgentLlmMessages(processingResult.messages, {
  fenceRegistry: myFenceRegistry,
});
```

`FenceLifetimePreprocessor` 通常已经被 `createDefaultAgentPreprocessorPipeline` 内置（orchestrator 内部根据 `fenceRegistry` 自动接好）；你**不需要手动 new**，只要保证 orchestrator 拿到了同一个 `fenceRegistry` 实例。

如果你完全自定义了 preprocessor pipeline，那 `FenceLifetimePreprocessor` 要从 `@linnlabs/linnkit/context-manager` 导入并手动加进去（构造参数：`{ fenceRegistry }`）。

#### 5.4.5 配 MustKeepPolicy（控制 working memory 裁剪）

`AgentCoreContextProvider`（来自 `@linnlabs/linnkit/context-manager` 的 `agentContext` namespace）现在通过 `MustKeepPolicy` 决定哪些消息一律不被裁。chat 兼容层不再通过 `chatContext` namespace 暴露；新接入方应把通用上下文注入都放到 agent profile + fence 机制里。它有两类输入：

1. `alwaysKeepTypes`：按 `AiMessage.type` 列表（`'system_prompt' | 'user_input' | ...`）。默认值 `DEFAULT_MUST_KEEP_POLICY`。
2. `alwaysKeepFenceKinds`：按 fence kind 列表（host 注入的 `metadata.fenceKind`）。

**搭配规则**（很重要）：

- `lifetime: 'persisted'` 的 fence kind，多半也想 must-keep → 加进 `alwaysKeepFenceKinds`。
- `lifetime: 'turn-only'` 的 fence kind，本身就只在本轮，**不要**加进 `alwaysKeepFenceKinds`。
- 想限量截断（不丢但只保留预算的 X%）：用 `truncationRules`。

#### 5.4.6 Fence 消费的全链路一图（接入完成后内部发生什么）

```text
host invoke request (含 host 业务字段)
  │
  ▼
withMyFenceInjections()      ← 你写的适配
  │  request.fences: FenceInjection[] = [{ kind, content, attrs }, ...]
  ▼
AgentMessageOrchestrator     ← linnkit
  │  · BaseAgentTask 展开为 AiMessage(type='context_injection', metadata.fenceKind=...)
  │  · FenceLifetimePreprocessor 剥离旧轮 turn-only 注入
  │  · AgentCoreContextProvider 按 MustKeepPolicy 决定 working memory 是否裁掉
  ▼
formatAgentLlmMessages(..., { fenceRegistry })
  │  · 找到 metadata.fenceKind → registry.get(kind).formatter(content, attrs)
  │  · 出关成具体 LLM messages（system / user 各按 llmRole）
  ▼
AgentAiEngine.chatCompletionStream(llmMessages, ...)
```

**你不要做的**：

- 不要把 `<my_tag>...</my_tag>` 写进 system prompt 字符串拼装（会绕过 fence lifetime / must-keep 治理）。
- 不要在不同链路用两个不同的 `FenceRegistry`（注册侧和 formatter 侧必须是同一个实例）。
- 不要继续借用 `document_fragment` / `context_before` / `context_after` 这些 legacy type 表达新的产品注入。它们是迁移期兼容字段，host 一律转成 fence 注入。
- 不要把 fence 概念漏到 system prompt 文案里去——fence kind 是 host-internal 命名，对 LLM 不可见；LLM 只看 formatter 输出的标签。

**最小验证**：

- 单测 1：注册 fence → `BaseAgentTask` 能展开成 `context_injection` 消息（`@linnlabs/linnkit/context-manager` 内部测试已经覆盖；host 这边写一个集成测试断言"3 类 fence 注入后，最终 LLM messages 第 N 条是 system 角色 + 包含 `<my_tag>`"即可）。
- 单测 2：`lifetime: 'turn-only'` 的 fence 在 history 里能被自动剥离。
- 单测 3：`mustKeep` 或 `alwaysKeepFenceKinds` 列出的 fence 在 working memory 抽稀时不被裁。

#### 5.4.7 兼容期注意

linnkit 0.4.x 起，agent profile 的公开请求合同已经收窄：host 产品字段不再挂在 `AgentProfileRequest` 上，`MessageFormatter` 也不再替 `document_fragment` / `additional_context` 这类产品语义做包装。新接入方应当：

- 把 host 产品字段全部走 `fences[]` 通道。
- 不引用 `chatContext` / `chatTasks` 等 namespace；需要兼容旧 chat 形态时，先使用主入口的扁平导出，后续迁到 tools-disabled `AgentSpec`。
- 不 deep import `profiles/chat/*`；这仍是迁移期兼容层，不是新功能扩展点。

#### 5.4.8 工具历史压缩策略

linnkit 0.4.x 的 agent preprocessor 已支持三种工具历史策略。未传配置时默认走 `per-run + keepLatestRuns=1`；host 仍应在各自的 `AgentDefinition.config.contextPolicy.toolHistory` 中显式声明策略，避免依赖全局默认。

| 策略 | 适用场景 | 行为 | 风险 |
|------|----------|------|------|
| `per-pair` | 4K/8K 小上下文模型；需要强力控 token | 全局保留最近 N 组完整工具交互，其余压成自然语言摘要 | 可能跨 run 腰斩同一轮工具链，prompt cache prefix 不稳定 |
| `per-run` | 默认推荐；多步 agent、review、workspace 操作 | 按 `user_input` 划 run，完整保留最近 K 个历史 run 的工具序列 | token 使用量可能高于 per-pair |
| `none` | 200K+ 长上下文模型；调试回放；审计敏感链路 | 不做常规压缩，只保留安全阀 | 长历史会明显涨 token |

安全阀：

- `maxInteractionGroups`：所有策略共用的硬上限，默认 12。
- `overflowStrategy: 'keep-latest'`：超过上限时保留最近工具组，压缩更旧组。
- `overflowStrategy: 'fail-fast'`：超过上限时抛 `ContextProviderError`，`code = 'TOOL_HISTORY_OVERFLOW'`，适合 CI 或生产 invariant。

AgentSpec schema 已落到 `linnkit/contracts`，host 装配时可用 `contextPolicy.toolHistory` 控制策略。低层测试或自定义 registry 也可以直接从默认 preprocessor registry 注入：

```ts
createDefaultAgentPreprocessorRegistry({
  toolHistory: {
    strategy: 'per-run',
    keepLatestRuns: 1,
    maxInteractionGroups: 12,
    overflowStrategy: 'keep-latest',
  },
});
```

### 5.5 接持久化（3 个 port）

> **术语提醒**：这里的 `Checkpointer` 是 **engine-state checkpoint**——保存 graph engine 执行状态（`nodeId / pendingToolCalls / executorLocal.stepCount / local`），用来"中断后从断点继续推理"。它**不是**任何"对话总结/上下文裁剪"语义；后者是上下文工程层面的 RuntimeEvent，应当走你自己的 `EventStore`，跟本接口无关。详见 §9 术语表。

**linnkit 给你的合同**

- `Checkpointer`（来自 `@linnlabs/linnkit/runtime-kernel`，在 `graph` namespace 下）：`load` / `save` / `clear` 三个必需方法 + `peekMeta` / `list` 两个可选。
- `EventStore`（来自 `@linnlabs/linnkit/runtime-kernel`，在 `graph` namespace 下）：`append` / `range` / `latestEventId` 三个必需 + `truncate` 可选。配套 `createMonotonicEventIdFactory()` 帮你生成单调 id。
- `RunRegistryStore`（来自 `@linnlabs/linnkit/runtime-kernel`，在 `runSupervisor` namespace 下）：run lifecycle 元数据落库。
- `RuntimeEvent` / `EventEnvelope` / `PersistedEvent` 类型来自 `@linnlabs/linnkit/contracts` 与 `runtime-kernel`。

**linnkit 自带的 mock primitive**

`memoryCheckpointer` / `memoryEventStore` / `memoryRunRegistryStore` 都是 in-memory contract-test 用实现。它们藏在 runtime-kernel 内部，外部消费者一般不需要直接引用——通过 `@linnlabs/linnkit/runtime-kernel` 的 namespace 访问。如果某个未导出，请告诉框架维护方补出口。

**你必须做的**

1. 决定真后端：SQLite / Postgres / IndexedDB / 文件 都行。linnkit 不规定。
2. 实现 3 个 port，作为 host runtime-assembly 的依赖注入点。
3. 写入时使用 `createMonotonicEventIdFactory()` 生成 eventId；旧数据可保持 `NULL` 并在读取时 fallback。
4. 使用**短事务**：每个 lifecycle 调用各自独立 commit，**不要**跨整个 LLM/tool 执行过程持有数据库事务。

**实现 EventStore 的常见落地形态**

- 已有 `conversations / runs / events / messages` 表？采用 **schema-preserving event-grained core**：保留既有表结构，不新增第二张事件事实表。
- 你的 `EventStore` 实现可以同时对外暴露两组 API：
  - host 主写链直接用的短事务会话 API（`beginRunSession` / `appendEventToRun` / `completeRun` / `failRun`）；
  - 给 linnkit `EventStore` port 消费的 adapter（把 `append/range/latestEventId` 桥接到底层）。

**你不要做的**

- 不要把"数据库就是平台默认实现"的假设写死。
- 不要跳过 `schemaVersion` / `CheckpointMeta` 这些契约字段。
- 不要一边写库一边偷偷吞掉冲突或重复事件——push 到上层做幂等判断。

**最小验证**

linnkit 在内部对每个 port 都跑了 contract test。你的实现必须通过这些**等价的契约测试**。建议在 host 测试里 mirror linnkit 的 contract test，把 memory 实现 → 你的实现做参数化，确保行为 1:1。

### 5.6 接 telemetry（可选）

**linnkit 给你的合同**

- `TelemetryPort`（来自 `@linnlabs/linnkit/runtime-kernel`，在 `telemetry` namespace 下）：`emit(event)` + 可选 `flush()`。
- `TelemetryEvent` / `TelemetryEventKind` / `TelemetryScope`（同上）：4 类 kind（`llm_call` / `tool_call` / `graph_node` / `run_lifecycle`）的事实 schema。
- `withLLMTelemetryContext`（来自 `@linnlabs/linnkit` 根入口）：把 run 作用域的 telemetry context 通过 AsyncLocalStorage 挂上去，避免跨异步边界丢 trace。

**linnkit 自带的 mock primitive**

- `noopTelemetry`（从 `runtimeKernel.telemetry` namespace 取）：默认无副作用实现，写测试时直接当 placeholder。

**你必须做的**

1. 决定 telemetry 落到哪：日志、指标、tracing 管道、host 自家 telemetry sink。
2. 把 `TelemetryPort` 作为可选能力接入 runtime-assembly。
3. 用 `withLLMTelemetryContext(scope, () => ...)` 把每次 run 包起来，让 LLM 调用、tool 调用都自动继承 scope。

**你不要做的**

- 不要把 telemetry 直接和 UI 事件流绑死（UI 走 SSE，telemetry 走 sink）。
- 不要把 tracing id / run id 透传到模型供应商请求体里。
- 不要把"先埋点再说"的 ad-hoc 日志散在业务文件里——所有可观测点收敛进 telemetry port。

**最小验证**

- 单测：注入一个 `Array.push`-style sink，断言一次 run 里 4 类 kind 各发了至少 1 次。
- 集成测：`withLLMTelemetryContext` 内嵌的 LLM 调用拿到的 `scope` 与外层一致；并发两个 run 时 scope 不串。

---

## 6. 实时通道（host 完全自有）

`@linnlabs/linnkit` **不规定** SSE / WebSocket / MQTT 的接口形状——一个原因是不同部署形态（HTTP server / Electron IPC / 内嵌 RPC）天差地别。

但有两条**铁规**：

1. **唯一出口原则**：所有实时事件必须经由你自己的 EventBus → realtime adapter 单一路径推给前端。**禁止**在 graph node / tool / bridge 中直接调用 sink 推送实时事件（`WaitUserNode` 是唯一的协议级例外，它发出 `requires_user_interaction` 是暂停协议的一部分）。
2. **不要绕过 EventBus 写**：会导致 seq 断裂和审计遗漏。

事件转换链路：

```text
graph 内部 AnyAgentEvent
  │  eventMapper.agentToRuntime()      ← 来自 @linnlabs/linnkit/runtime-kernel/events
  ▼
RuntimeEvent
  │  shouldEmitRuntimeEventToSse(event)  ← 你的实时 adapter 决定
  ▼
你的 SSEEvent / WS message / IPC payload
```

事件**生命周期治理**统一走 `eventGovernance` 纯函数：

| 函数 | 用途 |
|---|---|
| `shouldPersistRuntimeEvent` | 是否写入 host EventStore（`ephemeral=true` 或 `tool_process` 不持久化） |
| `shouldReplayRuntimeEventToUi` | 页面 reload 时是否从 EventStore 回放给前端 |
| `shouldEnterAgentContext` | 是否进入 LLM 上下文窗口 |
| `shouldEmitRuntimeEventToSse` | 是否走实时通道 |
| `getRuntimeEventUiProjectionKind` | UI 投影类别（不同 kind 走不同前端组件） |

这些函数在前端可以从 `@linnlabs/linnkit/runtime-kernel/events` slim seam 取，浏览器安全。

---

## 7. 测试与 testkit

`@linnlabs/linnkit/testkit` 是 **package-neutral** 的测试底座。它**只**给你"linnkit 自己的合同"测试用的 primitive；不替代你的 host-bound testkit。

### 7.1 第一层：linnkit 内置 primitive（直接装包就有）

- `createScriptedAiEngineHarness`：脚本化 AI engine。
- `createGraphLoopHarness`：把 graph loop / LlmNode / AgentEventBridge / observationPreview 装好的最小 harness。
- `createDefaultGraphExecutor`：返回一个最小默认 `GraphExecutor`（仅测试用）。
- `createReplayHarness`：context replay harness。
- `createToolContextFixture`：最小 `ToolExecutionContext`。
- `assertions` namespace：常用断言。

```ts
// 测试代码（注意：只能在测试文件里写）
import {
  createScriptedAiEngineHarness,
  createGraphLoopHarness,
  createToolContextFixture,
  assertions,
} from '@linnlabs/linnkit/testkit';
```

### 7.2 第二层：你自己写的 host-bound testkit

放在 `app-hosts/<your-app>/testkit/*` 下。它依赖你的默认 adapter，把第一层 harness 包一层：

- 把你的默认 `LlmNode` / `AgentEventBridge` / `observationPreview` 喂给 `createGraphLoopHarness()`。
- 用你的默认 `ToolManager` 创建 host-bound `ToolRuntimeHarness`。
- 用 in-memory 持久化 mirror 你的 SQLite/Postgres 实现，做 contract parity。

linnkit 不强制你的第二层 wrapper 长什么样，只要求一条铁规：**第二层 wrapper 不能回写 `@linnlabs/linnkit` 包内**——所有依赖你自己默认 adapter 的逻辑必须留在你自己仓库。

### 7.3 选择规则

- 验证 linnkit 合同（"我的 EventStore 是不是符合 port 契约？"）→ 第一层 + 你的实现做参数化。
- 验证"我的宿主装配是否通了"（"我的 host 接进 graph 后能跑出 final_answer 吗？"）→ 第二层。
- 验证产品功能 → host application-layer test，跟 linnkit 没关系。

---

## 8. 硬约束（接入方必读）

linnkit 仓库内部的 package-boundary 由 **AST 级 guard**（基于 TypeScript Compiler API）强制 10 条规则。其中**直接影响外部消费者**的：

1. **只能从公开子入口 import**。`exports` 字段没声明的路径会被 Node 16+ ESM 解析直接拒绝。
2. **不要 deep import**。`@linnlabs/linnkit/runtime-kernel/some-internal-folder/foo` 不算公开 API；下个 minor 随时可能挪。
3. **不要依赖 internal-only 模块**：`shared/logger` / `shared/errorClassifier` / `shared/TokenCalculator` 等都是包内私有。
4. **不要把你自己的 provider/tool/adapter 反向塞回 linnkit**——linnkit 是你装的 npm 包，物理上塞不进去；逻辑上也不要试图通过 monkey patch 修改 linnkit 内部。
5. **`promptKey` 在 ports 层是 opaque string**——linnkit 不认识你的产品菜单，也不会替你解析。
6. **前端代码禁止 import `@linnlabs/linnkit/runtime-kernel`**（namespace 全展开入口，含 `node:async_hooks` / `crypto` 等 Node-only 子树）。前端只能从 `@linnlabs/linnkit/runtime-kernel/events` slim seam 取 events governance 纯函数。
7. **生产代码禁止 import `@linnlabs/linnkit/testkit`**。`testkit` 顶层 `import { vi, expect } from 'vitest'`，会把 vitest runtime 拖进生产 bundle。如果你确实在 monorepo 里有 mixed 代码，请用打包阶段的 lint 规则守门。

> 第 6 / 7 条是 0.1.x 版本踩过的真坑——`@linnlabs/linnkit/testkit` 一旦从根入口被静态导入，esbuild/tsup 会把整棵 testkit 子树带进 backend production bundle，导致 electron main 启动时抛 `Vitest failed to access its internal state.`。详见包内 `docs/release/RELEASE-HISTORY.md` §A.7。

---

## 9. 当前不建议你做的事

不要这样接：

1. **直接把 linnkit 真源仓内的 host adapters（`src/app-hosts/linnya/*`）整个抄过来当模板**——那是产品决策内嵌的实现（默认 provider / 默认 task / 默认 schema），里面糊了 linnya 的产品语义。可以参考它们的**形状**和**装配顺序**，但不要直接拷贝再硬改。
2. **把别人的 agent registry / context / flow 当作公开 API 引用**——它们没在 `package.json#exports` 里。
3. **试图通过自定义 build 钩子修改 `@linnlabs/linnkit` 内部行为**——所有定制点必须通过依赖注入。
4. **为了省事继续从外部 schemas 包拿本该属于 agent 的 A 类协议**——0.1.1 已经把 schemas 收回包内（`@linnlabs/linnkit/contracts`），不要再走老路径。

正确做法：

- 复用 `@linnlabs/linnkit` 的 7 个公开子入口；
- 在你自己的 host layer 决定 provider、tool、persistence、flow 的真实实现；
- 通过 fence registry 把产品上下文挂进框架，而不是改框架。

---

## 10. 推荐阅读顺序

1. 本文 §1-§3 → 先把"我装了啥、它给我啥"看清。
2. 本文 §4 → 写一个能跑的最小骨架。
3. 按需读 §5.1-§5.6，遇到一项接一项；其中 **§5.4 fence 章节** 强烈建议接入第一周就读完，避免后期回滚。
4. 包内 `docs/README.md` —— 框架自身的总览（运行时分层、数据流全景、术语对照）。
5. 包内 `docs/framework/08-context-engineering-package-boundary.md` + `09-...-plan.md` —— 0.2.x context engineering 边界设计原文，理解 fence 机制为什么长这样。
6. 包内 `docs/framework/04-protocol-roadmap.md` + `07-roi-ranked-priorities.md` —— 协议演进路线图（理解哪些 API 接下来会变）。

---

## 11. 术语对照

agent 生态有几个名字相同语义不同的概念，第一次踩坑后才会意识到。先记住这几条：

### 11.1 "Checkpoint" 的两种含义

| 维度 | **Engine-state Checkpoint**（linnkit 拥有） | **应用层 Context Checkpoint**（你产品自有） |
|---|---|---|
| 接口 | `Checkpointer` port（`@linnlabs/linnkit/runtime-kernel`） | 不是 linnkit 接口；通常是你定义的一个 LLM tool |
| 存什么 | `EngineState`：`nodeId / pendingToolCalls / executorLocal.stepCount / local` | LLM 主动写的"阶段总结摘要" |
| 谁触发 | `GraphExecutor` 在循环内自动 save / load | LLM 模型自己在判断对话过长时主动调用工具 |
| 解决什么 | 执行控制：中断恢复、为长 run / 异步 run 铺路 | 上下文工程：压缩 LLM context window、保留语义 |
| 落到哪 | 你提供的 `Checkpointer` 适配器（SQLite/Redis/文件…） | 通常是个 RuntimeEvent，落你自己的 `EventStore` |
| linnkit 知不知道？ | 知道（公开 port） | **不知道**（产品自有） |

接入时**绝对不要**把这两件事混到一起：

- 实现 `Checkpointer` adapter 时，**只**要能 save/load `EngineState` 就够了。不要试图在里面塞"摘要 / 对话压缩"语义。
- 想做"对话太长时压缩上下文"，那是另一条产品功能：定义你自己的 LLM 工具、它的输出走你的 `EventStore`、由你自己的 context-manager pipeline 在下一轮上下文构建时识别 marker 并裁剪。

### 11.2 "Event" 的三层

| 名字 | 所在层 | 用途 |
|---|---|---|
| `AnyAgentEvent` | runtime-kernel 内部领域事件 | graph node 内部产出的原始事件 |
| `RuntimeEvent` | runtime-kernel → host 持久化事件 | 持久化、上下文重建、history 回放的事实来源 |
| 实时通道事件（如 SSE） | host realtime adapter | 前端实时渲染（**接入方自己负责**） |

`RuntimeEvent` 持久化由你的 `EventStore` adapter 落地；实时推送由你自己的 realtime adapter 决定。linnkit 不规定这一层。

### 11.3 "Fence"（0.2.x 引入）

| 维度 | 说明 |
|---|---|
| 什么是 fence | host 自定义的"上下文围栏家族"，把不同来源的上下文（项目元数据 / 长记忆 / 系统事件 / 子 agent 摘要 / 用户引用 / ……）按 placement + lifetime + role 组织，注入到 LLM 不同位置 |
| 谁拥有 fence kind 的命名 | host（kebab-case，如 `memory-context` / `system-event`） |
| linnkit 提供什么 | `FenceDescriptor` 声明 schema、`FenceRegistry` 容器、`FenceLifetimePreprocessor` 生命周期清理、`MustKeepPolicy` 必保留判定、`context_injection` 这类 `AiMessage.type` 稳定载体 |
| host 提供什么 | descriptors（fence 家族定义）+ injections adapter（请求字段 → `FenceInjection[]`）+ 起码一个 `FenceRegistry` 实例供 orchestrator/formatter 共用 |
| 为什么这么设计 | 同一套 host 适配能支持任意"项目上下文 / 文档片段 / 长记忆 / 子 agent 摘要 / 系统事件"的混搭，框架不需要任何改动；linnsy / linnya / 未来 IDE coding agent / 数据分析 agent 都通过这一套接 |

---

## 12. 关联文档

包内（装包后通过 npm 也会有这些 .md，详见 `package.json#files`）：

- `docs/README.md` —— 框架总览（运行时分层、数据流全景）。
- `docs/DEVELOPMENT_GUIDE.md` —— 给 linnkit 维护方看的开发指南（外部消费者一般不需要）。
- `docs/framework/` —— linnkit 作为独立 Agent 框架的演进活文档；其中：
  - `04-protocol-roadmap.md` —— 6 条新协议层 + 4 条治理升级
  - `07-roi-ranked-priorities.md` —— ROI 排序的优先级清单
  - **`08-context-engineering-package-boundary.md`** —— 0.2.x 围栏机制的设计原文（强烈建议接入 fence 前读一遍）
  - **`09-context-engineering-package-boundary-plan.md`** —— 配套实施计划（理解 legacy 字段到 fence 的迁移路径）
- `docs/release/RELEASE.md` —— 当前最新版本说明、版本号策略。
- `docs/release/RELEASE-HISTORY.md` —— 历次版本叙事。

仓库源码（仅供 linnkit 维护方自取，**不在装包后的 npm tarball 里**）：

- `https://github.com/BCAutumn/Tingtalk_official_version` —— linnkit 真源仓。
- 真源仓内 `src/app-hosts/linnya/*` —— 一个完整 host 装配示例，可以照着抄形状（**不要硬拷代码** / 它内嵌了 linnya 产品决策）。

---

## 13. 简短 FAQ

**Q：我装的是 `@linnlabs/linnkit`，但所有 npm/yarn 都装不下来，401 / 404？**

A：99% 概率是 GitHub Packages 鉴权问题。检查 `.npmrc` 的 `_authToken` 是否正确、token 是否有 `read:packages`、账号是否被 `BCAutumn` org 授权。

**Q：我能不能 fork linnkit、改它内部然后用我自己的 fork？**

A：技术上可以，但你要自己负担"和上游同步 + boundary guard 自维护"的成本。99% 你想做的事都能通过依赖注入在 host 层完成；如果你发现某个改动只能 fork 才能做，那大概率说明你应该来跟 linnkit 维护方提 issue / PR。

**Q：我的产品上下文是不是只能用 fence 表达？**

A：A 类（system / user 注入）走 fence 是最干净的路。B 类（per-tool 工具调用上下文）按 tool 自己的 schema/context/patch 表达，跟 fence 无关。C 类（运行时副作用、telemetry）走 telemetry port。三类互不替代。

**Q：legacy `document_fragment` / `context_before` 字段我该不该用？**

A：**不该**。它们仍存在于 0.2.x 是为了存量 host 渐进迁移；新接入方一律走 fence 通道。具体迁移映射见 `docs/framework/09-...-plan.md` Phase B3。

**Q：我能跳过 host-bound testkit，只用 linnkit 自带的 testkit 写测试吗？**

A：能跑通 contract 测试是可以的。但一旦你的 host 装配里有任何"默认 LlmNode 行为/默认 tool registry 默认值"等产品决策，第一层 testkit 不会替你验证。所以建议第二层 testkit 至少薄薄一层包一下。
