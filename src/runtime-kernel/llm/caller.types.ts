/**
 * @file src/agent/runtime-kernel/llm/caller.types.ts
 * @description
 * 历史位置保留（向后兼容）——5 个 AI 引擎协议 type 的 definitive source
 * 已在 2026-04-23 归位到 `ports/ai-engine.types.ts`，原因是它们的语义属于
 * "host 实现 AgentAiEngine 时要填的参数"，是 ports 协议面而非 runtime-kernel
 * 实现层。归位后 `ports ⇄ runtime-kernel` 的 rollup dts 循环依赖警告彻底消失。
 *
 * 本文件仍保留一份 namespace-level re-export，原因：
 * - `runtime-kernel/llm/index.ts` 通过 `export type { ... } from './caller.types'`
 *   继续透出这 5 个 type，保证 `import { llm } from 'linnkit/runtime-kernel'` 后
 *   `llm.LlmCallOptions` 的 namespace 访问语法不变，不 break linnya 主仓 ~若干处
 *   namespace 使用点（`llm.LlmCallOptions` / `runtimeKernel.llm.ToolCallChunk`）。
 * - caller.ts 内部仍可以 `import type { ... } from './caller.types'` 获取这些 type。
 *
 * runtime-kernel → ports 是合法的分层方向（实现依赖接口契约），且通过 barrel
 * 路径 `'../../ports'` 满足 AGENT-GUARD-08-no-cross-submodule-deep-import 约束。
 */

export type {
  LlmCallOptions,
  LlmResponseContent,
  LlmRetryConfig,
  ToolCall,
  ToolCallChunk,
} from '../../ports';
