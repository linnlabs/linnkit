import type { ToolDisplayOptions } from './ui-types';
import type { ToolIdempotencyPolicy } from './idempotency/toolIdempotency';
import type { ToolExecutionContext } from './toolExecutionContext';

export interface ToolParameterProperty {
  type: string;
  description: string;
  default?: unknown;
  enum?: string[];
  properties?: Record<string, ToolParameterProperty>;
  items?: ToolParameterProperty;
  required?: string[];
}

export interface ToolParameterSchema {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolResult {
  success: boolean;
  data: string;
  metadata?: Record<string, unknown>;
}

export type UnifiedToolResult =
  | { kind: 'ok'; output: unknown }
  | { kind: 'need_user'; spec: unknown }
  | { kind: 'async'; run_id: string };

export abstract class BaseTool {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: ToolParameterSchema;

  readonly idempotency?: ToolIdempotencyPolicy;
  readonly displayOptions?: ToolDisplayOptions;

  getExecutionSummary?(output: string): string {
    const FULL_CONTENT_THRESHOLD = 200;
    if (!output) {
      return 'Tool returned no output.';
    }
    if (output.length <= FULL_CONTENT_THRESHOLD) {
      return output;
    }
    return `Tool returned ${output.length} characters of output.`;
  }

  abstract run(args: Record<string, any>, context: ToolExecutionContext): Promise<string>;

  protected validateArguments(args: Record<string, any>): { success: boolean; error?: string } {
    try {
      const required = this.parameters.required || [];
      for (const field of required) {
        if (!(field in args) || args[field] === undefined || args[field] === null) {
          return {
            success: false,
            error: `Missing required parameter: ${field}`,
          };
        }
      }

      if (this.parameters.additionalProperties === false) {
        const allowed = new Set(Object.keys(this.parameters.properties));
        const unknownFields = Object.keys(args).filter((field) => !allowed.has(field));
        if (unknownFields.length > 0) {
          return {
            success: false,
            error: `Additional properties not allowed: ${unknownFields.join(', ')}`,
          };
        }
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `Parameter validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  }

  getMetadata() {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    };
  }
}

export interface ToolRegistryEntry {
  name: string;
  toolClass: new () => BaseTool;
  metadata: ReturnType<BaseTool['getMetadata']>;
}

export const CommonParameterTypes = {
  docId: {
    type: 'string',
    description: 'The unique ID of the document',
  },
  query: {
    type: 'string',
    description: 'The search query text',
  },
  topK: {
    type: 'integer',
    description: 'The maximum number of results to return',
    default: 5,
  },
  blockId: {
    type: 'string',
    description: 'The unique ID of a content block',
  },
  pageNumber: {
    type: 'integer',
    description: 'Page number (1-indexed)',
    default: 1,
  },
} as const;

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, any>;
  execute(args: Record<string, any>): Promise<any>;
}

export interface OpenAIToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface ToolCallResult {
  toolName: string;
  args: Record<string, any>;
  result: any;
  success: boolean;
  error?: string;
  durationMs: number;
}
