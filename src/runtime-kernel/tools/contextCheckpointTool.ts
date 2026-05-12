import {
  CHECKPOINT_MARKER_TYPE,
  DEFAULT_CONTEXT_CHECKPOINT_TOOL_NAME,
} from '../../shared/checkpointMarker';
import { BaseTool, type ToolArgs, type ToolParameterProperty, type ToolParameterSchema } from './toolContracts';
import type { ToolExecutionContext } from './toolExecutionContext';
import type { StructuredToolResult } from './ui-types';

const DEFAULT_SUMMARY_MAX_LENGTH = 8000;

export interface ContextCheckpointToolArgs extends ToolArgs {
  summary?: unknown;
}

export interface ContextCheckpointPayload extends Record<string, unknown> {
  _type: typeof CHECKPOINT_MARKER_TYPE;
  summary: string;
}

export interface ContextCheckpointToolHookParams {
  args: ContextCheckpointToolArgs;
  context: ToolExecutionContext;
  summary: string;
}

export type ContextCheckpointPayloadExtension =
  | Record<string, unknown>
  | void
  | undefined;

export interface ContextCheckpointToolOptions {
  /**
   * 工具名。必须与 `AgentSpec.contextPolicy.checkpoint.triggerToolName` 保持一致。
   */
  name?: string;
  /**
   * 工具描述。host 可以替换成更贴合自己状态系统的文案。
   */
  description?: string;
  /**
   * summary 最大字符数。
   */
  summaryMaxLength?: number;
  /**
   * host 额外参数 schema，例如 taskstate / references。
   */
  extraParameters?: Record<string, ToolParameterProperty>;
  /**
   * host 额外 required 字段。`summary` 永远必填。
   */
  requiredExtraParameters?: string[];
  /**
   * 扩展 checkpoint payload。返回值会被合并到 data 中，但 `_type` 与 `summary`
   * 由 framework 最后写入，host 不能覆盖协议核心字段。
   */
  buildPayloadExtension?: (params: ContextCheckpointToolHookParams) =>
    | Promise<ContextCheckpointPayloadExtension>
    | ContextCheckpointPayloadExtension;
  /**
   * 自定义给模型看的 observation 文本。不影响 provider 识别；provider 只读 raw output marker。
   */
  buildObservation?: (params: ContextCheckpointToolHookParams & {
    payload: ContextCheckpointPayload;
  }) => Promise<string> | string;
}

function normalizeToolName(value: string | undefined): string {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_CONTEXT_CHECKPOINT_TOOL_NAME;
}

function normalizeSummaryMaxLength(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_SUMMARY_MAX_LENGTH;
}

function buildDefaultDescription(toolName: string): string {
  return [
    'Create a context checkpoint to aggressively clean old conversation history.',
    '',
    '# When to Use',
    '- After completing a major phase or milestone.',
    '- When receiving a system reminder that context is running low.',
    '',
    '# What Happens',
    '1. You provide a structured, detailed phase summary.',
    `2. The tool returns a ${CHECKPOINT_MARKER_TYPE} marker that linnkit can recognize.`,
    '3. On the next context build, old history before this checkpoint will be trimmed.',
    '4. The checkpoint tool call/output itself remains visible as the bridge into the next phase.',
    '',
    '# Summary Requirements',
    'The summary is the bridge between old context and future continuation. Include completed work, failures, key discoveries, relevant references, and next steps.',
    '',
    `# Tool Name`,
    `This tool is registered as ${toolName}. If you rename it, set contextPolicy.checkpoint.triggerToolName to the same value.`,
  ].join('\n');
}

function buildParameters(options: ContextCheckpointToolOptions): ToolParameterSchema {
  return {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Structured phase transition summary. This is the context bridge after checkpoint trimming.',
      },
      ...(options.extraParameters ?? {}),
    },
    required: ['summary', ...(options.requiredExtraParameters ?? [])],
    additionalProperties: true,
  };
}

function buildDefaultObservation(summary: string): string {
  return [
    'Context checkpoint created. Prior conversation history before this checkpoint can now be trimmed.',
    'Continue using the checkpoint summary as the bridge into the next phase.',
    '',
    'Checkpoint summary:',
    summary,
  ].join('\n');
}

/**
 * host-neutral 的最小 checkpoint 工具。
 *
 * 中文备注：
 * - 它只负责输出 linnkit 能识别的 checkpoint marker；
 * - TaskState / SharedMemory / 外部文档写入属于 host 能力，可通过 hook 扩展；
 * - host 不注册这个工具时，主动 checkpoint 行为不会启用。
 */
export class ContextCheckpointTool extends BaseTool<ContextCheckpointToolArgs, string> {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameterSchema;

  private readonly summaryMaxLength: number;
  private readonly buildPayloadExtension?: ContextCheckpointToolOptions['buildPayloadExtension'];
  private readonly buildObservation?: ContextCheckpointToolOptions['buildObservation'];

  constructor(options: ContextCheckpointToolOptions = {}) {
    super();
    this.name = normalizeToolName(options.name);
    this.description = options.description ?? buildDefaultDescription(this.name);
    this.parameters = buildParameters(options);
    this.summaryMaxLength = normalizeSummaryMaxLength(options.summaryMaxLength);
    this.buildPayloadExtension = options.buildPayloadExtension;
    this.buildObservation = options.buildObservation;
  }

  async run(args: ContextCheckpointToolArgs, context: ToolExecutionContext): Promise<string> {
    const validation = this.validateArguments(args);
    if (!validation.success) {
      throw new Error(`[${this.name}] ${validation.error ?? 'Invalid arguments'}`);
    }

    const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
    if (!summary) {
      throw new Error(`[${this.name}] summary is required`);
    }
    if (summary.length > this.summaryMaxLength) {
      throw new Error(`[${this.name}] summary is too long; max length is ${this.summaryMaxLength} characters`);
    }

    const hookParams: ContextCheckpointToolHookParams = { args, context, summary };
    const extension = await this.buildPayloadExtension?.(hookParams);
    const payload: ContextCheckpointPayload = {
      ...(extension ?? {}),
      _type: CHECKPOINT_MARKER_TYPE,
      summary,
    };
    const observation = this.buildObservation
      ? await this.buildObservation({ ...hookParams, payload })
      : buildDefaultObservation(summary);

    const result: StructuredToolResult<ContextCheckpointPayload> = {
      data: payload,
      observation,
    };
    return JSON.stringify(result);
  }
}

export function createContextCheckpointTool(options?: ContextCheckpointToolOptions): ContextCheckpointTool {
  return new ContextCheckpointTool(options);
}
