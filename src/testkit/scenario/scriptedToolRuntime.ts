import type {
  FunctionToolSchema,
  ToolArgs,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolParameterSchema,
  ToolRuntimeDefinition,
  ToolRuntimePort,
} from '../../runtime-kernel';

/** 工具脚本的返回：字符串即成功的 observation；对象可以给出结构化数据或失败。 */
export type ScriptedToolOutcome =
  | string
  | {
      readonly observation?: string;
      readonly data?: Record<string, unknown>;
      /** 给出即失败：工具按执行错误结算。 */
      readonly error?: string;
      readonly errorCode?: string;
    };

export interface ScriptedToolInvocation {
  readonly toolName: string;
  readonly args: ToolArgs;
  readonly context: ToolExecutionContext;
  /** 该工具第几次被执行（从 1 开始）。 */
  readonly count: number;
}

export type ScriptedToolHandler = (
  invocation: ScriptedToolInvocation,
) => ScriptedToolOutcome | Promise<ScriptedToolOutcome>;

export interface ScriptedToolSpec {
  readonly run?: ScriptedToolHandler;
  readonly description?: string;
  readonly parameters?: ToolParameterSchema;
  readonly validateArguments?: ToolRuntimeDefinition['validateArguments'];
  /** 声明可与相邻的可并行调用同时执行，见 `ToolRuntimeDefinition.parallel`。 */
  readonly parallel?: true;
}

export type ScriptedToolMap = Readonly<Record<string, ScriptedToolHandler | ScriptedToolSpec>>;

export interface ScriptedToolExecution {
  readonly toolName: string;
  readonly args: ToolArgs;
  readonly startedAt: number;
  finishedAt?: number;
  outcome?: 'success' | 'error' | 'threw';
}

export interface ScriptedToolRuntime extends ToolRuntimePort {
  /** 按开始顺序记录的每次执行。 */
  readonly executions: ScriptedToolExecution[];
}

const EMPTY_PARAMETERS: ToolParameterSchema = { type: 'object', properties: {} };

function specOf(entry: ScriptedToolHandler | ScriptedToolSpec): ScriptedToolSpec {
  return typeof entry === 'function' ? { run: entry } : entry;
}

function toResult(outcome: ScriptedToolOutcome, toolName: string, durationMs: number): ToolExecutionResult {
  if (typeof outcome === 'string') {
    return { success: true, result: JSON.stringify({ data: {}, observation: outcome }), durationMs };
  }
  if (outcome.error !== undefined) {
    return {
      success: false,
      error: outcome.error,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
      errorKind: 'execution',
      durationMs,
    };
  }
  return {
    success: true,
    result: JSON.stringify({ data: outcome.data ?? {}, observation: outcome.observation ?? `${toolName} done` }),
    durationMs,
  };
}

/**
 * 按名字写工具脚本，得到一个真实可执行的 ToolRuntimePort。
 *
 * - 值是函数时即执行逻辑；可以是异步，用来在“工具执行中”这一刻插话、暂停、取消或等待放行；
 * - 返回 `{ error }` 是工具自己报告失败（模型会看到错误结果，运行继续）；
 * - 抛错是工具端口本身失败，原样抛给 ToolNode，运行以失败结束（覆盖 Host 端口崩溃路径）；
 * - 不写执行逻辑时返回 `<工具名> done`。
 */
export function createScriptedToolRuntime(tools: ScriptedToolMap = {}): ScriptedToolRuntime {
  const specs = new Map(Object.entries(tools).map(([name, entry]) => [name, specOf(entry)]));
  const executions: ScriptedToolExecution[] = [];
  const counts = new Map<string, number>();

  return {
    executions,
    getToolSchemas(): FunctionToolSchema[] {
      return [...specs].map(([name, spec]) => ({
        type: 'function',
        function: {
          name,
          description: spec.description ?? `scripted tool ${name}`,
          parameters: spec.parameters ?? EMPTY_PARAMETERS,
        },
      }));
    },
    getToolDefinition(toolName) {
      const spec = specs.get(toolName);
      if (!spec) return undefined;
      return {
        parameters: spec.parameters ?? EMPTY_PARAMETERS,
        ...(spec.validateArguments ? { validateArguments: spec.validateArguments } : {}),
        ...(spec.parallel ? { parallel: spec.parallel } : {}),
      };
    },
    async executeTool(toolName, args, context) {
      const spec = specs.get(toolName);
      if (!spec) throw new Error(`[scriptedToolRuntime] 未登记的工具：${toolName}`);
      const count = (counts.get(toolName) ?? 0) + 1;
      counts.set(toolName, count);
      const execution: ScriptedToolExecution = { toolName, args, startedAt: Date.now() };
      executions.push(execution);
      try {
        const outcome = spec.run ? await spec.run({ toolName, args, context, count }) : `${toolName} done`;
        execution.finishedAt = Date.now();
        const result = toResult(outcome, toolName, execution.finishedAt - execution.startedAt);
        execution.outcome = result.success ? 'success' : 'error';
        return result;
      } catch (error) {
        execution.finishedAt = Date.now();
        execution.outcome = 'threw';
        throw error;
      }
    },
  };
}
