import type {
  BaseTool,
  OpenAIToolSchema,
  ToolArgs,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRuntimeDefinition,
} from '../runtime-kernel';
import type { QuickstartToolRuntime } from './types';
import { serializeToolParameters } from './toolSchema';

function stringifyToolOutput(output: string): string {
  return output;
}

export class QuickstartMemoryToolRuntime implements QuickstartToolRuntime {
  private readonly tools = new Map<string, BaseTool<ToolArgs, string>>();

  constructor(tools: readonly BaseTool<ToolArgs, string>[] = []) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`[linnkit] duplicate tool registered: ${tool.name}`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  getToolSchemas(toolNames?: string[]): OpenAIToolSchema[] {
    const allowed = Array.isArray(toolNames) && toolNames.length > 0
      ? new Set(toolNames)
      : undefined;

    return [...this.tools.values()]
      .filter((tool) => !allowed || allowed.has(tool.name))
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: serializeToolParameters(tool.parameters),
        },
      }));
  }

  getToolDefinition(toolName: string): ToolRuntimeDefinition | undefined {
    const tool = this.tools.get(toolName);
    if (!tool) return undefined;
    return {
      parameters: tool.parameters,
      displayOptions: tool.displayOptions,
      idempotency: tool.idempotency,
    };
  }

  getDisplayOptions(toolName: string): BaseTool<ToolArgs, string>['displayOptions'] | undefined {
    return this.tools.get(toolName)?.displayOptions;
  }

  async executeTool(
    toolName: string,
    args: ToolArgs,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(toolName);
    const startedAt = Date.now();
    if (!tool) {
      return {
        success: false,
        error: `Unknown tool: ${toolName}`,
        errorKind: 'execution',
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      const result = await tool.run(args, context);
      return {
        success: true,
        result: stringifyToolOutput(result),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        errorKind: 'execution',
        durationMs: Date.now() - startedAt,
      };
    }
  }
}
