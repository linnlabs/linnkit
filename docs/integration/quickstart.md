# Quickstart · 5 分钟最小 host 骨架

下面这段是"装包后能跑通一轮 agent 对话"的最小骨架。它故意不引入 SSE / persistence / telemetry，把这些放到单独的接入文档：

- [llm-provider.md](./llm-provider.md)
- [tools.md](./tools.md)
- [context-fences.md](./context-fences.md)
- [persistence.md](./persistence.md)
- [realtime.md](./realtime.md)
- [telemetry.md](./telemetry.md)

## 1. host 需要的 5 个文件

```text
app-hosts/your-app/
├── adapters/
│   ├── llm/MyLlmProvider.ts            # 实现 AgentAiEngine
│   ├── tools/myToolRegistry.ts          # BaseTool[]
│   └── runtime-assembly/createExecutor.ts
├── context/agent/myFences.ts            # FenceRegistry 注册
└── index.ts                             # 装配入口 + 跑一轮 demo
```

## 2. 文件骨架（伪代码级，编译前需要补全细节）

### `adapters/llm/MyLlmProvider.ts`

```ts
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

### `adapters/tools/myToolRegistry.ts`

```ts
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

### `context/agent/myFences.ts`

```ts
import { createFenceRegistry, type FenceDescriptor } from '@linnlabs/linnkit/context-manager';

export const myFenceDescriptors: FenceDescriptor[] = [
  // 第一次接入可以先空着；之后按 context-fences.md 一行行加
];

export const myFenceRegistry = createFenceRegistry(myFenceDescriptors);
```

### `adapters/runtime-assembly/createExecutor.ts`

```ts
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

### `index.ts`

```ts
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

## 3. 这一节为什么是骨架而不是 copy-paste 可跑

`GraphExecutor` 的依赖袋在 0.x 仍在收口（不是稳定 public 形状）。**官方的可参考装配示例** 在 linnkit 真源仓 (`BCAutumn/Tingtalk_official_version`) 的 `src/app-hosts/linnya/adapters/runtime-assembly/*`、`src/app-hosts/linnya/adapters/context-injection/defaultGraphExecutorContextBuilder.ts` 下。如果你需要它们的具体形状，请直接对着那份代码抄一遍；不要凭这份骨架猜。

后续单点接入指南给的是**稳定的合同**，可以放心抄。

---

## 下一步

- 把 LLM provider 接好 → [llm-provider.md](./llm-provider.md)
- 注册工具 → [tools.md](./tools.md)
- **接 context engineering（一等接入面）** → [context-fences.md](./context-fences.md)
- 接持久化让 run 能落库恢复 → [persistence.md](./persistence.md)
- 写测试验证装配通了 → [testing.md](./testing.md)
