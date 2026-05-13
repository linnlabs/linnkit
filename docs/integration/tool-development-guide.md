# Tool Development Guide · 工具开发推荐规范

> **What** · 写自定义工具的设计推荐规范 —— `data` / `observation` 分层、错误处理、`getExecutionSummary`、长 observation 治理、7 条协议约束。
> **When to read** · 第一次写自定义工具；现有工具 token 偏多想优化；review 工具实现是否符合规范。
> **Prerequisites** · [`tools.md`](./tools.md)（工具接入面基础）；[`02-quickstart.md`](./02-quickstart.md)。
> **Key exports** · `BaseTool` / `ToolExecutionContext` from `@linnlabs/linnkit/runtime-kernel`。
> **Related** · [`tools.md`](./tools.md) · [`tool-history.md`](./tool-history.md) · [`context-engineering.md` §6](./context-engineering.md)

> 这份文档回答一个问题：**怎么写一个高质量的工具，让它既能被 linnkit 协议层接住，又能给 AI / UI 双方都提供恰到好处的信息密度？**

linnkit 在协议层守住"工具调用的边界"——`ToolRuntimePort` + `BaseTool` 抽象类 + tool 配对不变量（C10）+ `AuditEnvelope`。但**工具内部怎么设计参数、怎么组织返回结构、怎么治理超长输出、怎么响应失败**，是 host 的工程实践。

---

## 0. 设计哲学（一行话）

> **用最少的 token 传递最多的信息。**

linnkit 在协议层提供细粒度上下文工程能力（12 大分组 `contextPolicy` + `mustKeep` + fence + ContextTrace），但**这些只能管"已经进入上下文的消息怎么调度"**——**工具返回了什么、参数里塞了什么**，则是工具作者的工作。一个工具如果在 `parameters` 里塞 10 个可选字段、在返回值里嵌套四层 JSON，会让 LLM 上下文窗口被这一个工具吃掉 30%。这违背 linnkit 的产品特色：**对每一个发给 AI 的 token 进行精细化管理**。

派生原则：

| 原则 | 含义 |
|------|------|
| **工具是抽象的，复杂实现归上层** | 不在工具内部实现复杂业务函数；工具是"接受参数 → 调用 host 服务 → 返回结构化结果"的薄壳 |
| **数据合同优先选择最小且稳定的结构** | 中间推导物、展示噪音、上层可自由决定的字段，不进参数、不进返回值 |
| **不为"看起来更结构化"拆出多层嵌套** | 嵌套对象不是免费的，每一层 token 都要算账 |

---

## 1. 协议层强制约束

下表是 linnkit 协议层会**强制校验**的规则。违反会被运行时拒绝、被 testkit invariants 抓住、或导致 ContextTrace / AuditEnvelope 失真。

| 规则 | 校验机制 | 违反后果 |
|------|---------|---------|
| `name` / `description` / `parameters` 必填 | `BaseTool` 抽象类 | TS 编译失败 |
| `run(args, context): Promise<string>` 签名 | `BaseTool` 抽象类 | TS 编译失败 |
| `parameters.required[]` 声明的字段缺失 | `BaseTool.validateArguments()` 自动校验 | `ToolExecutionResult.errorKind = 'protocol'`，不进入 `run` |
| `run` 必须返回字符串（不是对象）| `BaseTool` 签名 | 下游解析失败 / 投影层崩溃 |
| 工具配对：`tool_call` ↔ `tool_output` 严格 1:1 | tool 配对不变量 C10 + testkit invariant | 26 条 strict invariants 报错 |
| 失败必须 `throw`，不能返回伪装成功的 JSON | runtime 接住 throw → `tool_output.status = 'error'` | UI 状态与实际不一致（最难排查的 bug 类） |
| `tool_calls` / `tool_outputs` 不可单独删（只能成对压缩）| `toolHistoryCompressor` + `ToolReplayProtocolGuard` | provider replay 协议违反 → LLM 调用失败 |

---

## 2. `run` 的返回值结构（强烈推荐 `JSON.stringify({ data, observation })`）

linnkit 不强制 `data` / `observation` 这套分层（host 可以自己决定），但**强烈推荐**——这是已有项目实战验证的最佳实践，能让一个工具同时满足两类消费者：

| 字段 | 服务对象 | 设计原则 |
|------|---------|---------|
| `data` | **UI 渲染** | 结构化、字段名稳定、避免重复正文；UI 不应做"二次加工"，前端只忠实渲染 |
| `observation` | **AI 上下文** | 纯文本、可读、信息密度高；**禁止**重复 `data` 中的字段、**禁止**拼大段 JSON、**禁止**加 emoji 等噪音 |

**为什么这套分层重要**：

- 没有分层时，工具作者要么"AI 友好 UI 不友好"（observation 给前端解析 → 解析失败），要么"UI 友好 AI 不友好"（结构化 JSON 进 LLM 上下文 → token 爆炸 + 模型不擅长读嵌套 JSON）。
- 有了分层后，`linnkit` 的 `enterAgentContext` 治理（`eventGovernance`）+ `observationGovernance`（治理超长 observation 落盘）能精准地只让 `observation` 进入 AI 上下文，`data` 留给前端。

### 2.1 最小返回值示例

```ts
async run(args: SumArgs, _context: ToolExecutionContext): Promise<string> {
  const sum = args.numbers.reduce((acc, n) => acc + n, 0);
  const result = {
    data: { sum },
    observation: `The sum of ${args.numbers.length} numbers is ${sum}.`,
  };
  return JSON.stringify(result);
}
```

### 2.2 真实工具示例（含 ToolExecutionContext 注入）

```ts
import {
  BaseTool,
  type ToolArgs,
  type ToolExecutionContext,
  type ToolParameterSchema,
} from '@linnlabs/linnkit/runtime-kernel';

interface SearchDocsArgs extends ToolArgs {
  query: string;
  topK?: number;
}

interface DocHit {
  documentId: string;
  title: string;
  snippet: string;
  score: number;
}

export class SearchDocsTool extends BaseTool<SearchDocsArgs> {
  readonly name = 'search_docs';

  readonly description = `Search documents in the user's knowledge base.

# When to Use

- When the user asks to find / search / look up content across documents.
- Prefer this over reading every document one by one.

# Output

Returns top-K documents ranked by relevance, each with id / title / snippet.`;

  readonly parameters: ToolParameterSchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (natural language).' },
      topK: { type: 'integer', description: 'Max number of results.', default: 5 },
    },
    required: ['query'],
  };

  async run(args: SearchDocsArgs, context: ToolExecutionContext): Promise<string> {
    const knowledgeBase = context.knowledgeBaseService;
    if (!knowledgeBase) {
      throw new Error('SearchDocsTool requires knowledgeBaseService in ToolExecutionContext');
    }

    const hits: DocHit[] = await knowledgeBase.search(args.query, args.topK ?? 5);

    const result = {
      data: { hits },
      observation: hits.length === 0
        ? `No documents matched query: "${args.query}"`
        : `Found ${hits.length} documents for "${args.query}":\n` +
          hits.map((h, i) => `${i + 1}. [${h.documentId}] ${h.title} — ${h.snippet}`).join('\n'),
    };
    return JSON.stringify(result);
  }
}
```

注意几点：

1. **`description` 是写给 LLM 看的**：包含 "When to Use" / "Output" 等结构化指引，质量直接决定 LLM 的工具选择准确度。
2. **`context.knowledgeBaseService` 来自 host patch**：linnkit 协议层只定义 `ToolExecutionContext` 的保留字段（`__runtime` / `__capabilities`），host 通过 `ensureToolContextRuntimeCapability` 把自己的服务注入 context。
3. **`observation` 包含完整可读信息，但不重复 `data` 的字段名**：LLM 读完 `observation` 已经知道有哪些文档、引用 ID 是什么——不需要再 parse `data`。
4. **失败 throw**：`knowledgeBase` 缺失是配置错误，不是业务失败——`throw` 让 `AuditEnvelope` 与 `tool_output.status` 准确反映"协议级错误"。

---

## 3. 错误处理协议

| 场景 | 正确做法 | 错误做法 |
|------|---------|---------|
| 工具执行失败（外部服务挂了 / 业务规则违反）| `throw new Error('...')`，runtime 标记 `tool_output.status = 'error'` | 返回 `{"data":{"error":"..."}}` 伪装成功 |
| 必填参数缺失 | 通过 `parameters.required[]` 声明，让 `validateArguments` 拦截 | 在 `run` 里 `if (!args.x) throw` 或返回错误 JSON |
| Schema 不匹配（类型错 / 多余字段）| `parameters.additionalProperties = false` + `validateArguments` 拦截 | 在 `run` 里手写校验 |
| 批量场景部分失败 | 整体 `success`，但 `data` 中给出每条 `{ status, message }`，`observation` 简短摘要 | 抛错让整个批次失败 |
| 增强步骤降级（主操作成功，附加步骤失败）| 整体 `success`，在 `data.warnings` / `observation` 标注降级 | 抛错让主操作的产出丢失 |
| LLM 产出坏掉的 `tool_call.arguments`（流式 JSON 损坏）| 不属于工具错误——runtime / LLM 调用层处理为协议错误 | 在 `run` 里返回"成功但 data.error=..." |

### 3.1 不允许"伪装成功的失败"

`tool_output.status` 是协议层契约，**驱动**三个下游消费者：

1. **UI 渲染**：失败应该红色卡片 + 错误信息；伪装成功 → UI 显示绿色，但内容是错误，用户困惑
2. **`toolHistoryCompressor`**：失败的工具可以被压缩成 "tool X failed"，伪装成功会被当成成功结果保留正文
3. **`AuditEnvelope`**：tool retry / tool deny 等审计决策依赖 `tool_output.status` 准确

**违反这一条的 bug 是最难排查的一类**。`throw` 一次，三处一致；伪装一次，三处全错。

---

## 4. `parameters.required[]` 是强约束，不是提示

任何业务上"没有它就不能执行"的字段，**必须**放进 `required`。

linnkit 的 `BaseTool.validateArguments()` 会在 `run` 之前自动校验：

```ts
const required = this.parameters.required || [];
for (const field of required) {
  if (!(field in args) || args[field] === undefined || args[field] === null) {
    return {
      success: false,
      error: `Missing required parameter: ${field}`,
    };
  }
}
```

这意味着：

- ✅ 缺失 required 字段 → `ToolExecutionResult.errorKind = 'protocol'`，不进入 `run`
- ❌ 在 `run` 里写 `if (!args.x) throw` → 协议级错误被误标为执行级错误，audit / telemetry / replay 全都失真

**强约束的好处**：LLM 看到 `required` 列表后，会有更强的"必须传"心智；运行时拦截也能让 token 用尽更早暴露（避免 `run` 里走了 1/3 才发现缺字段）。

---

## 5. `getExecutionSummary` —— 把工具产出压成历史摘要

`toolHistoryCompressor` 在 `strategy: 'per-run'` / `'per-pair'` 下，会用 `getExecutionSummary(output)` 把历史轮次的工具产出**压缩成一行摘要**——这是 linnkit 上下文工程的核心机制之一。

**默认实现**（`BaseTool.getExecutionSummary` 已提供）：

```ts
getExecutionSummary?(output: string): string {
  if (!output) return 'Tool returned no output.';
  if (output.length <= 200) return output;
  return `Tool returned ${output.length} characters of output.`;
}
```

默认实现对短输出原样保留、对长输出说"返回了 N 字符"——**信息量很弱**。每个工具都应当**自己实现** `getExecutionSummary`：

```ts
getExecutionSummary(output: string): string {
  try {
    const parsed = JSON.parse(output);
    const hits = parsed?.data?.hits ?? [];
    return `搜索到 ${hits.length} 篇文档：${hits.slice(0, 3).map((h: DocHit) => h.title).join('、')}${hits.length > 3 ? '…' : ''}`;
  } catch {
    return '搜索结果解析失败。';
  }
}
```

**对 token 的影响**：在 `strategy: 'per-run'` 下，一次 run 的 N-1 历史轮次工具产出都会被压成 `getExecutionSummary` 一行摘要——一个高质量的 summary 能把工具历史的 token 占用从几万压到几百。这是 linnkit "对每一个发给 AI 的 token 进行精细化管理" 的真实落地点。

---

## 6. 超长 observation 治理（不要在工具内部截断）

**❌ 错误做法**：

```ts
async run(args, context) {
  const fullText = await fetchHugeContent(args);
  if (fullText.length > 20_000) {
    return JSON.stringify({
      data: { preview: fullText.slice(0, 20_000), truncated: true, blobPath: writeToDisk(fullText) },
      observation: fullText.slice(0, 20_000),
    });
  }
  return JSON.stringify({ data: { text: fullText }, observation: fullText });
}
```

每个工具都自己实现一遍截断 + 落盘 = 协议不一致、blob 路径不一致、replay 不一致。

**✅ 正确做法**：让 linnkit 协议层的 `toolOutput.observationGovernance` + host 的 `ObservationPreviewPort` 接管：

```ts
async run(args, context) {
  const fullText = await fetchHugeContent(args);
  return JSON.stringify({
    data: { text: fullText },
    observation: fullText,
  });
}
```

工具只负责"拿到完整内容、放进返回值"。当 `observation` 超过 `contextPolicy.toolOutput.observationGovernance.maxChars`（默认 20,000）或 `maxLines`（默认 1,200）时，`ToolNode` 会自动调用 host 的 `ObservationPreviewPort.truncateObservation()` 把全文落盘、生成 `blob_id`、把 observation 替换成"短预览 + 续读指引"。

详见 [`tools.md §6`](./tools.md#6-observationpreviewport配置超长-observation-存储路径)。

**为什么协议化**：

- 全仓一致：所有工具共用同一套截断 / 落盘 / 续读协议
- 可观测：截断决策进入 ContextTrace，可解释"为什么这次 observation 这么短"
- 可配置：`contextPolicy.toolOutput.observationGovernance` 让每个 agent 独立配置阈值

---

## 7. 交互工具（`requireUser`）的单消息协议

如果你的工具需要用户输入（如确认操作、问卷、多选），**不能**自己写"先返回一段提示 → 等用户输入 → 再返回结果"——这会破坏 `tool_call` ↔ `tool_output` 1:1 配对，违反 C10 不变量。

**正确做法**：

1. **第 1 段**：工具返回完整 `StructuredToolResult`，并在 `result.control.requireUser = true` 声明"需要用户继续交互"。
2. **第 2 段**：`ToolNode` 不再持久化首条 `tool_output`，而是把 `pendingInteractionSpec` 写入 local state，然后 route 到 `wait_user` 节点。
3. **第 3 段**：`WaitUserNode` 发出 `requires_user_interaction` 事件，run 进入 `awaiting_user` 状态。
4. **第 4 段**：用户提交回复后，runtime 用**同一条** `tool_output` 事件继续——`metadata.interaction` 字段承载用户的 `approved / modified / submitted / skipped` 状态。

**reload / replay 的关键**：交互卡片的初始内容**必须**能从 `tool_call.arguments` 直接重建——不要把"首次工具输出快照"当成唯一事实来源。

---

## 8. 注册到 host 的 `ToolRuntimePort`

工具写完之后，host 通过 `ToolRuntimePort` 把它装配进 runtime。最简单的做法是用 quickstart 提供的 `QuickstartMemoryToolRuntime`：

```ts
import { QuickstartMemoryToolRuntime } from '@linnlabs/linnkit/quickstart';

const toolRuntime = new QuickstartMemoryToolRuntime([
  new SearchDocsTool(),
  new EchoTool(),
]);
```

生产 host 通常自己实现 `ToolRuntimePort`（实现 `ToolCatalogPort` + `ToolPresentationPort` + `ToolExecutionPort` 三个 sub-port），把工具与 host 的服务、权限、UI 渲染 registry 串起来——详见 [`tools.md`](./tools.md)。

---

## 9. 推荐遵守的 host 层约定

以下几条规范是 **host 业务层强烈推荐**遵守的——linnkit 协议层不会守门，但它们对工具开发质量影响很大：

| 约定 | 说明 |
|------|------|
| **`name` 用 `snake_case`** | 所有工具名小写下划线，避免与 LLM 自由生成的工具调用名混淆 |
| **`description` 包含 "When to Use"** | 明确告诉 LLM 何时调用、避免误用 |
| **`data` / `observation` 分层强制** | UI 字段稳定、observation 纯文本高密度（见 §2） |
| **`tag/badge` 慎用** | 只在创建态 / 审核态 / 风险态等强调操作时用 |
| **占位渲染白名单（早期 tool_call）** | 流式 tool_call delta 阶段，仅允许特定工具提前显示占位卡片 |
| **`requireUser` 工具的单消息交互协议** | 见 §7 |

---

## 10. 与 linnkit 协议的边界对齐表

| 工具内部决策 | 由谁负责 | 协议接入点 |
|------------|---------|----------|
| 工具名 / 描述 / 参数 schema | host（工具作者）| `BaseTool` |
| 返回值结构（`data` / `observation` 分层）| host（工具作者）| `BaseTool.run` 返回字符串 |
| 错误处理（throw vs 返回）| host（遵守 §3）| runtime 接住 throw → `tool_output.status = 'error'` |
| 必填参数校验 | linnkit 协议层 | `BaseTool.validateArguments()` |
| 超长 observation 治理 | linnkit 协议层 + host | `contextPolicy.toolOutput.observationGovernance` + `ObservationPreviewPort` |
| 工具历史压缩 | linnkit 协议层 | `contextPolicy.toolHistory.strategy` + `getExecutionSummary` |
| 工具配对一致性 | linnkit 协议层 | tool 配对不变量 C10 + `ToolReplayProtocolGuard` |
| 交互工具的 wait_user 路由 | linnkit 协议层 | `WaitUserNode` + `requires_user_interaction` 事件 |
| `data` 字段名约定 / 前端 registry 注册 | host（工具作者 + 前端工程师）| linnkit 不规定 |
| 工具的业务实现（数据库 / 外部服务调用）| host | linnkit 不规定 |

---

## 11. 自查清单

- [ ] `name` 用 `snake_case`，在 host 工具集中唯一
- [ ] `description` 包含 "When to Use"，写给 LLM 看
- [ ] 必填参数全部放进 `parameters.required[]`
- [ ] `additionalProperties: false`（如果不希望 LLM 传额外字段）
- [ ] `run` 返回 `JSON.stringify({ data, observation })`
- [ ] `data` 给前端，`observation` 给 AI，**两者不重复字段**
- [ ] `observation` 是纯文本、无 emoji、信息密度高
- [ ] 失败用 `throw new Error(...)`，**不**返回伪装成功的 JSON
- [ ] 实现 `getExecutionSummary(output)`，给 ToolHistoryCompressor 用
- [ ] 不在工具内部做超长截断 / 落盘——交给 `ObservationPreviewPort`
- [ ] 如果是交互工具：第一段返回 `result.control.requireUser = true`，复活路径只从 `tool_call.arguments` 重建
- [ ] 单测用 `createToolContextFixture()` 直接测 `tool.run(args, fixtureContext)`
- [ ] 在 host 的 `ToolRuntimePort` 实例化里注册

---

## 12. 与其他文档的关系

- [`tools.md`](./tools.md) — `ToolRuntimePort` / `ObservationPreviewPort` 等**协议接入面**
- [`agent-registration-guide.md`](./agent-registration-guide.md) — 把工具集装进 `AgentSpec` / 注册到 host agent registry
- [`tool-history.md`](./tool-history.md) — `toolHistoryCompressor` 的 `per-pair` / `per-run` / `none` 三策略配置
- [`context-engineering.md`](./context-engineering.md) — 12 大分组 `contextPolicy` 总览，含 `toolOutput.observationGovernance`
- [`audit.md`](./audit.md) — tool retry / tool deny 等审计决策
- [`testing.md`](./testing.md) — testkit 提供的 26 条 strict invariants（含工具相关的 C10）
