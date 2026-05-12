# Tools · 注册工具集

## 1. linnkit 给你的合同

- `BaseTool` + `CommonParameterTypes`（来自 `@linnlabs/linnkit/runtime-kernel`）：抽象类，要求实现 `name` / `description` / `parameters` / `execute(args, context)`。
- `ToolExecutionContext` / `ToolSchemaContext`（同上）：执行时 / schema 构建时收到的 context 形状。
- `ToolRuntimePort` / `ToolCatalogPort` / `ToolExecutionPort` / `ToolPresentationPort`（同上）：把工具集合装成"runtime 可调用"的合同；host 默认 `ToolManager` 实现要满足这些 port。
- `ObservationPreviewPort`（同上）：工具产出 observation 在 UI 展示前的预览决策点。
- `ensureToolContextRuntimeCapability`（同上）：把 runtime 必需的保留字段补进 host 的 patch，避免手抖漏字段。

## 2. linnkit 自带的 mock primitive

- `createToolContextFixture`（来自 `@linnlabs/linnkit/testkit`）：最小 `ToolExecutionContext`，已自动通过 `ensureToolContextRuntimeCapability` 补全 runtime 字段。

## 3. 你必须做的

1. 把每个工具定义为 `BaseTool` 的子类（或满足 `AgentTool` 接口的对象）。
2. 决定哪些字段走通用 `ToolExecutionContext`，哪些走 host patch；patch 必须经 `ensureToolContextRuntimeCapability` 补齐保留字段。
3. 把工具集合装进 host 的 `ToolManager` / `ToolRuntimePort` 实现，让 runtime 在 LLM 决策返回 tool calls 时能 dispatch。
4. 实现 `ObservationPreviewPort`，决定超长 observation 的完整副本写到哪里；再在 runtime assembly 里传给 `createDefaultGraphExecutor({ observationPreview })` 或你的自定义 `ToolNode` 装配。

## 4. 你不要做的

- 不要让工具直接吃 host 的全局单例（数据库、配置中心等都按 patch / context 注入）。
- 不要把 runtime 保留字段（`__runtime` / `__capabilities`）手工拼进 patch；统一过 `ensureToolContextRuntimeCapability`。
- 不要从 deep path 抓 helper（凡是没出现在 `@linnlabs/linnkit/runtime-kernel` 公开符号里的，下个 minor 可能就消失）。

## 5. 最小验证

- 单测：用 `createToolContextFixture()` 直接测 `tool.execute(args, fixtureContext)`。
- 集成测：在 host-bound `ToolRuntimeHarness` 上覆盖"失败恢复 / 并行调用 / observation 预览"路径。

## 6. ObservationPreviewPort：配置超长 observation 存储路径

`contextPolicy.toolOutput.observationGovernance` 只控制**什么时候治理**：

```ts
contextPolicy: {
  profileId: 'agent',
  toolOutput: {
    observationGovernance: {
      enabled: true,
      maxChars: 20_000,
      maxLines: 1_200,
    },
  },
}
```

完整内容**存到哪里**由 host 的 `ObservationPreviewPort` 决定。最小形态：

```ts
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ObservationPreviewPort } from '@linnlabs/linnkit/runtime-kernel';

export function createFsObservationPreviewPort(params: {
  rootDir: string;
}): ObservationPreviewPort {
  return {
    async truncateObservation({ context, toolName, text, maxChars, maxLines }) {
      const raw = String(text ?? '');
      const lines = raw.split('\n');
      if (raw.length <= maxChars && lines.length <= maxLines) {
        return { truncated: false, preview: raw };
      }

      const blobId = createHash('sha256')
        .update(JSON.stringify({
          conversationId: context.conversationId,
          turnId: context.turnId,
          toolName,
          textHash: createHash('sha256').update(raw).digest('hex'),
        }))
        .digest('hex')
        .slice(0, 16);

      const filePath = path.join(params.rootDir, 'tool_output', 'blobs', `${blobId}.json`);
      await fsp.mkdir(path.dirname(filePath), { recursive: true });
      await fsp.writeFile(
        filePath,
        JSON.stringify({
          version: 1,
          kind: 'tool_output_text',
          conversation_id: context.conversationId,
          turn_id: context.turnId,
          tool_name: toolName,
          text: raw,
        }, null, 2),
        'utf-8',
      );

      return {
        truncated: true,
        blob_id: blobId,
        preview: [
          raw.slice(0, Math.floor(maxChars * 0.7)),
          '',
          `...（内容已截断，完整内容已写入 blob_id=${blobId}）...`,
        ].join('\n'),
      };
    },
  };
}
```

然后在 executor 装配处传入：

```ts
import { createDefaultGraphExecutor } from '@linnlabs/linnkit/runtime-kernel';

const observationPreview = createFsObservationPreviewPort({
  rootDir: process.env.MY_AGENT_TOOL_OUTPUT_DIR ?? '/var/lib/my-agent',
});

const executor = createDefaultGraphExecutor({
  llmNode,
  toolRuntime,
  observationPreview,
});
```

**重要边界**：

- `blob_id` 只是指针。你如果提供读取工具（例如 `resource_read("tool_output://blobs/<blob_id>")`），读取工具必须和 `ObservationPreviewPort` 使用同一个 store / rootDir。
- AgentSpec 不应该包含本地路径、S3 bucket、数据库 DSN 这类基础设施字段；这些属于 host 部署配置。
- 示例 host 可以使用 workspace root 下的 conversation artifact 路径：
  `<workspaceRoot>/Artifacts/v1/conversations/<conversationId>/instances/<instanceId>/tool_output/blobs/<blobId>.json`。
  其中 `workspaceRoot` 应来自 host 自己的部署配置、环境变量或工作区配置。读取 `tool_output://blobs/<blob_id>` 的工具也必须使用同一个 store，否则模型拿到 `blob_id` 后无法续读。

## 7. 工具示例

```ts
import { BaseTool, type ToolExecutionContext } from '@linnlabs/linnkit/runtime-kernel';

export class EchoTool extends BaseTool {
  name = 'echo';
  description = '回声测试，用于验证工具调用链路';

  parameters = {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要回声的文本' },
    },
    required: ['text'],
  } as const;

  async execute(args: { text: string }, context: ToolExecutionContext) {
    return {
      kind: 'success' as const,
      data: { echoed: args.text },
    };
  }
}
```

返回值形态：

| `kind` | 含义 |
|--------|------|
| `'success'` | 工具成功；`data` 字段是结构化结果 |
| `'failure'` | 工具失败；`error` 字段是失败原因 |
| `'requireUser'` | 工具要等用户输入（交互式工具）；不返回 `data`，等下一轮 |

详见 `@linnlabs/linnkit/runtime-kernel` 中 `ToolCallResult` 类型定义。
