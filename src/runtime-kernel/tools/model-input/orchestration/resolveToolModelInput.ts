import { RuntimeResourceRefs, type RuntimeResourceRef } from '../../../../contracts';
import type { ToolExecutionContext } from '../../toolExecutionContext';
import {
  ToolModelInputResolutionError,
  type ToolModelInputAttachmentSelection,
  type ToolModelInputResolverPort,
} from '../definitions/toolModelInput';

/**
 * 把工具声明的附件 selection 交给 Host 换成正式资源引用，并核对批次身份与顺序。
 * 当前模型能否接收这些附件由 Host 在工具执行前决定；下一次 LLM 调用的 preflight 仍按真实请求校验。
 */
export async function resolveToolModelInput(input: {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly selections: readonly ToolModelInputAttachmentSelection[] | undefined;
  readonly context: ToolExecutionContext;
  readonly resolver?: ToolModelInputResolverPort;
}): Promise<readonly RuntimeResourceRef[] | undefined> {
  if (!input.selections) {
    return undefined;
  }
  if (!input.resolver) {
    throw new ToolModelInputResolutionError('Tool model input resolver is not configured.');
  }

  const resolved = await input.resolver.resolveToolModelInput({
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    selections: input.selections,
    context: input.context,
  });
  const parsed = RuntimeResourceRefs.safeParse(resolved);
  if (!parsed.success || parsed.data.length !== input.selections.length) {
    throw new ToolModelInputResolutionError('Tool model input resolver returned an invalid attachment batch.');
  }
  if (parsed.data.some((reference, index) => reference.id !== input.selections?.[index]?.id)) {
    throw new ToolModelInputResolutionError('Tool model input resolver changed attachment identity or order.');
  }
  return Object.freeze(parsed.data.map(reference => Object.freeze(reference)));
}
