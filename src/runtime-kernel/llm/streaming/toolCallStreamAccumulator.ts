/**
 * @file src/agent/runtime-kernel/llm/streaming/toolCallStreamAccumulator.ts
 * @description
 * 流式 tool_calls 聚合器：把 ToolCallChunk[] 拼成稳定的 ToolCall[]。
 *
 * 说明：
 * - 该模块只做 tool_calls 的结构化聚合，不负责发送事件；
 * - 兼容 OpenAI 标准“arguments delta”与部分 OpenAI-compat 的异常形态（同 index 新 id、多顶层 JSON `}{` 等）。
 */

import { generateMessageId } from '../../../shared/ids';
import { splitConcatenatedJsonObjects, tryParseJsonRecord } from '../toolCallUtils';
import type { ToolCall, ToolCallChunk } from '../caller.types';

const isToolCallChunk = (v: unknown): v is ToolCallChunk => {
  if (!v || typeof v !== 'object') return false;
  return 'index' in v;
};

export class ToolCallStreamAccumulator {
  private toolCalls: ToolCall[] = [];
  private readonly emittedToolCallIds = new Set<string>();
  private readonly placeholderAllowlist: Set<string>;
  /**
   * 已发出的“可解析 args 快照”（按 tool_call_id 去重），用于避免 update 事件刷屏与 UI 抖动。
   *
   * 说明：
   * - 这里用“原始 JSON 字符串（trim 后）”作为快照指纹，比 JSON.stringify(object) 更稳定：
   *   - 可保留模型/供应商的 key 顺序（避免 stringify 造成无意义 diff）；
   *   - 也能覆盖 “provider 直接发送完整 JSON snapshot” 的场景。
   */
  private readonly emittedArgsSnapshotByToolCallId = new Map<string, string>();
  private readonly lastArgsEmitAtByToolCallId = new Map<string, number>();

  constructor(placeholderToolAllowlist: Iterable<string>) {
    this.placeholderAllowlist = new Set<string>(placeholderToolAllowlist);
  }

  /**
   * @description
   * 在 tool_call id + name 都就绪时触发，用于上层发“占位 action”。
   */
  private maybeEmitPlaceholder(toolCallId: string, toolName: string, onPlaceholder?: (toolCallId: string, toolName: string) => void): void {
    if (!onPlaceholder) return;
    if (!toolCallId || !toolName) return;
    if (!this.placeholderAllowlist.has(toolName)) return;
    if (this.emittedToolCallIds.has(toolCallId)) return;
    this.emittedToolCallIds.add(toolCallId);
    onPlaceholder(toolCallId, toolName);
  }

  /**
   * @description
   * 尝试在“arguments 已经是合法 JSON 对象”时发出 args 快照。
   *
   * 约束：
   * - 仅当 arguments 能 parse 成 Record 才触发（不做半吊子容错解析，避免补丁式行为）；
   * - 默认做轻量节流（同一 tool_call_id 50ms 内最多 1 次），防止 provider 高频 snapshot 导致 UI 抖动。
   */
  private maybeEmitArgsSnapshot(
    toolCallId: string,
    toolName: string,
    rawArgsJson: string,
    onArgsSnapshot?: (toolCallId: string, toolName: string, args: Record<string, unknown>) => void
  ): void {
    if (!onArgsSnapshot) return;
    if (!toolCallId || !toolName) return;

    const now = Date.now();
    const lastAt = this.lastArgsEmitAtByToolCallId.get(toolCallId) ?? 0;
    if (now - lastAt < 50) return;

    const trimmed = rawArgsJson.trim();
    if (!trimmed) return;

    const prev = this.emittedArgsSnapshotByToolCallId.get(toolCallId);
    if (prev === trimmed) return;

    const parsed = tryParseJsonRecord(trimmed);
    if (!parsed.ok) return;

    this.emittedArgsSnapshotByToolCallId.set(toolCallId, trimmed);
    this.lastArgsEmitAtByToolCallId.set(toolCallId, now);
    onArgsSnapshot(toolCallId, toolName, parsed.value);
  }

  applyChunks(
    chunks: unknown[],
    onPlaceholder?: (toolCallId: string, toolName: string) => void,
    onArgsSnapshot?: (toolCallId: string, toolName: string, args: Record<string, unknown>) => void
  ): void {
    for (const toolCallChunk of chunks) {
      if (!isToolCallChunk(toolCallChunk)) continue;

      /**
       * OpenAI 标准：tool_calls[*].function.arguments 是“增量 delta”，可直接拼接。
       *
       * 但在部分 OpenAI-compat 供应商中，可能会出现以下异常流式形态：
       * - 同一 index 上出现“新的 tool_call id”（意味着其实是下一条 tool_call）
       * - arguments 在一个 index 上输出了多个完整 JSON 对象片段，导致拼接后出现 `}{`
       */
      let index = toolCallChunk.index;

      if (!this.toolCalls[index]) {
        this.toolCalls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } };
      }

      if (toolCallChunk.id) {
        // 同一 index 出现“不同 id”：通常意味着 provider 把下一条 tool_call 仍标成旧 index。
        if (this.toolCalls[index].id && this.toolCalls[index].id !== toolCallChunk.id) {
          const nextIndex = this.toolCalls.length;
          this.toolCalls[nextIndex] = { id: toolCallChunk.id, type: 'function', function: { name: '', arguments: '' } };
          index = nextIndex;
        } else {
          this.toolCalls[index].id = toolCallChunk.id;
        }
      }

      // Gemini：thought_signature 可能只在首个 tool_call 片段里出现一次，需要在本地累积并回传
      const signature =
        typeof toolCallChunk.extra_content?.google?.thought_signature === 'string'
          ? toolCallChunk.extra_content.google.thought_signature
          : undefined;
      if (signature && !this.toolCalls[index].extra_content?.google?.thought_signature) {
        this.toolCalls[index].extra_content = {
          ...(this.toolCalls[index].extra_content || {}),
          google: {
            ...((this.toolCalls[index].extra_content || {}).google || {}),
            thought_signature: signature
          }
        };
      }

      if (toolCallChunk.function?.name) {
        // 直接覆盖名称（OpenAI协议中名称通常一次性给出）
        this.toolCalls[index].function.name = toolCallChunk.function.name;
      }

      const readyId = this.toolCalls[index].id;
      const readyName = this.toolCalls[index].function.name;
      if (readyId && readyName) {
        this.maybeEmitPlaceholder(readyId, readyName, onPlaceholder);
        // 如果 provider 在“name/id 就绪”时就给出完整 JSON snapshot，可直接触发一次 update
        this.maybeEmitArgsSnapshot(readyId, readyName, this.toolCalls[index].function.arguments, onArgsSnapshot);
      }

      if (toolCallChunk.function?.arguments) {
        const oldArgs = this.toolCalls[index].function.arguments;
        const newArgsChunk =
          typeof toolCallChunk.function.arguments === 'string'
            ? toolCallChunk.function.arguments
            : JSON.stringify(toolCallChunk.function.arguments);

        // 1) 若 newArgsChunk 自身是一个完整 JSON 对象，优先用“覆盖”语义（兼容非-delta 供应商）
        const newIsFullJson = tryParseJsonRecord(newArgsChunk.trim()).ok;
        const oldIsFullJson = tryParseJsonRecord(oldArgs.trim()).ok;

        if (newIsFullJson && (!oldArgs || !oldIsFullJson || newArgsChunk.trim().length >= oldArgs.trim().length)) {
          this.toolCalls[index].function.arguments = newArgsChunk;
          if (readyId && readyName) {
            this.maybeEmitArgsSnapshot(readyId, readyName, this.toolCalls[index].function.arguments, onArgsSnapshot);
          }
          continue;
        }

        // 2) 默认按 delta 追加
        const merged = oldArgs + newArgsChunk;

        // 3) 若拼接后出现多个顶层 JSON（典型表现为 `}{`），尝试拆分为多条 tool_call
        const pieces = splitConcatenatedJsonObjects(merged);
        if (pieces.length >= 2 && pieces.every(p => tryParseJsonRecord(p).ok)) {
          // 当前 index 保留第一段，其余段作为“后续 tool_call”追加
          this.toolCalls[index].function.arguments = pieces[0];
          if (readyId && readyName) {
            this.maybeEmitArgsSnapshot(readyId, readyName, this.toolCalls[index].function.arguments, onArgsSnapshot);
          }

          for (let pi = 1; pi < pieces.length; pi += 1) {
            const nextIndex = this.toolCalls.length;
            this.toolCalls[nextIndex] = {
              id: generateMessageId(),
              type: 'function',
              function: {
                name: this.toolCalls[index].function.name,
                arguments: pieces[pi]
              },
              // 仅透传一次 thought_signature（额外 tool_call 为兼容生成，不强行复制签名）
              extra_content: undefined
            };
          }
          continue;
        }

        this.toolCalls[index].function.arguments = merged;
        if (readyId && readyName) {
          this.maybeEmitArgsSnapshot(readyId, readyName, this.toolCalls[index].function.arguments, onArgsSnapshot);
        }
      }
    }
  }

  getToolCalls(): ToolCall[] {
    return this.toolCalls.filter(tc => tc && tc.function && tc.function.name);
  }
}
