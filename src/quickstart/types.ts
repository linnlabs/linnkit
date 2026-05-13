import type { AgentAiEngine } from '../ports';
import type {
  AgentSpec,
  AgentSpecContextPolicyInput,
  RuntimeEvent,
} from '../contracts';
import type {
  BaseTool,
  OpenAIToolSchema,
  ToolArgs,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRuntimeDefinition,
  runSupervisor,
} from '../runtime-kernel';

export interface DefinedAgent {
  readonly spec: AgentSpec;
  readonly systemPrompt: string;
  readonly modelId?: string;
  readonly tools: readonly BaseTool<ToolArgs, string>[];
}

export interface DefineAgentInput {
  id: string;
  version?: string;
  description?: string;
  role?: string;
  systemPrompt: string;
  modelId?: string;
  capabilities?: string[];
  tools?: readonly BaseTool<ToolArgs, string>[];
  contextPolicy?: AgentSpecContextPolicyInput;
  metadata?: Record<string, unknown>;
}

export interface LinnkitQuickstartConfig {
  agents: readonly DefinedAgent[];
  llm: AgentAiEngine | (() => AgentAiEngine | Promise<AgentAiEngine>);
  defaultModelId?: string;
}

export interface RunAgentOptions {
  input: string;
  llm: AgentAiEngine;
  modelId?: string;
  conversationId?: string;
  runId?: string;
  signal?: AbortSignal;
  /**
   * Quickstart 事件回调。
   *
   * 中文备注：CLI 用它打印实时输出；生产 host 应直接接入 EventBus / EventStore。
   */
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
}

export interface RunAgentResult {
  runId: string;
  finalAnswer: string;
  events: RuntimeEvent[];
  cost: RunCost;
  contextTrace?: unknown;
}

type RunCost = runSupervisor.RunCost;

export interface QuickstartToolRuntime {
  getToolSchemas(toolNames?: string[]): OpenAIToolSchema[];
  getToolDefinition(toolName: string): ToolRuntimeDefinition | undefined;
  getDisplayOptions(toolName: string): BaseTool<ToolArgs, string>['displayOptions'] | undefined;
  executeTool(
    toolName: string,
    args: ToolArgs,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}
