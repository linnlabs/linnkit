/**
 * @file src/agent/runtime-kernel/llm/caller.ts
 * 
 * @brief LLM 调用器 - 统一管理 LLM 调用与重试逻辑
 * 
 * @description
 * 从 AgentExecutor 中提取的 LLM 调用逻辑，负责：
 * 1. LLM 调用（流式和非流式）
 * 2. 重试策略
 * 3. 错误处理
 * 4. 流式回调聚合
 * 
 * 这个模块纯粹专注于与 AI 引擎的交互，不关心业务逻辑。
 */

import type { AnyAgentEvent, ErrorEvent as AgentErrorEvent } from '../events/agentEvents';
import { generateMessageId } from '../../shared/ids';
import { ErrorClassifier, ErrorCategory } from '../../shared/errorClassifier';
import type { AgentAiEngine } from '../../ports';
import { defaultPolicyEngine } from './policies/defaultPolicyEngine';
import type { LlmCallOptions, LlmRequestMessage, LlmResponseContent, LlmRetryConfig, ToolCall } from './caller.types';
import { createEmptyModelCatalog, type ModelCatalogLike } from './modelCatalog';
import { ModelResolver, type ModelResolverLike } from './modelResolver';
import { ToolCallStreamAccumulator } from './streaming/toolCallStreamAccumulator';
import { ThoughtStreamSegmenter } from './streaming/thoughtStreamSegmenter';
import { tryParseJsonRecord } from './toolCallUtils';

export type { LlmCallOptions, LlmRequestMessage, LlmResponseContent, LlmRetryConfig, ToolCall } from './caller.types';

export interface LlmCallerOptions {
  maxRetries?: number;
  enableEmptyResponseRetry?: boolean;
  retryDelayMs?: number;
  fallbackModelPreferredOrder?: readonly string[];
  modelResolver?: ModelResolverLike;
  modelCatalog?: ModelCatalogLike;
  aiEngine: AgentAiEngine;
}

function isLlmCallerOptions(options: Partial<LlmRetryConfig> | LlmCallerOptions): options is LlmCallerOptions {
  return 'fallbackModelPreferredOrder' in options
    || 'modelResolver' in options
    || 'aiEngine' in options;
}

/**
 * 轻量类型守卫：用于安全读取“可扩展字段”（避免 any 断言）。
 */
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const isToolCall = (v: unknown): v is ToolCall => {
  if (!isRecord(v)) return false;
  if (typeof v['id'] !== 'string') return false;
  if (v['type'] !== 'function') return false;
  const fn = v['function'];
  if (!isRecord(fn)) return false;
  return typeof fn['name'] === 'string' && typeof fn['arguments'] === 'string';
};

const toToolCalls = (v: unknown): ToolCall[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  return v.filter(isToolCall);
};

function summarizeToolArguments(rawArguments: string): { length: number; head: string; tail: string } {
  const previewChars = 160;
  return {
    length: rawArguments.length,
    head: rawArguments.slice(0, previewChars),
    tail: rawArguments.slice(Math.max(0, rawArguments.length - previewChars)),
  };
}

function assertToolCallsHaveValidJsonArguments(toolCalls: ToolCall[]): void {
  for (const toolCall of toolCalls) {
    const rawArguments = toolCall.function.arguments;
    const parsed = tryParseJsonRecord(rawArguments.trim());
    if (parsed.ok) {
      continue;
    }

    const summary = summarizeToolArguments(rawArguments);

    // 🔍 诊断：判断截断模式（帮助区分 max_tokens 截断 vs 其他损坏类型）
    const trimmed = rawArguments.trim();
    const endsWithClosingBrace = trimmed.endsWith('}');
    const startsWithOpeningBrace = trimmed.startsWith('{');
    const truncationHint = startsWithOpeningBrace && !endsWithClosingBrace
      ? '(疑似输出中途被截断，可能是 max_tokens 不足)'
      : '(非典型截断模式，需进一步排查)';

    throw new Error(
      [
        `[LlmCaller] Stream ended with invalid tool_call.arguments for ${toolCall.function.name} (${toolCall.id}).`,
        `length=${summary.length}`,
        `head=${summary.head}`,
        `tail=${summary.tail}`,
        truncationHint,
      ].join(' ')
    );
  }
}

// 类型已拆分到 caller.types.ts，避免 caller.ts 承担过多“结构定义”职责

const createMissingAiEngine = (): AgentAiEngine => ({
  async chatCompletion(): Promise<never> {
    throw new Error('[LlmCaller] aiEngine is required. Inject it from host assembly or test harness.');
  },
  async chatCompletionStream(): Promise<never> {
    throw new Error('[LlmCaller] aiEngine is required. Inject it from host assembly or test harness.');
  },
});

/**
 * LLM 调用器
 */
export class LlmCaller {
  private readonly retryConfig: LlmRetryConfig;
  private readonly modelResolver: ModelResolverLike;
  private readonly modelCatalog: ModelCatalogLike;
  private readonly aiEngine: AgentAiEngine;

  constructor(options?: Partial<LlmRetryConfig> | LlmCallerOptions) {
    const normalizedOptions = this.normalizeConstructorOptions(options);
    this.retryConfig = {
      maxRetries: normalizedOptions.maxRetries ?? 3,
      enableEmptyResponseRetry: normalizedOptions.enableEmptyResponseRetry ?? true,
      retryDelayMs: normalizedOptions.retryDelayMs ?? 1000,
    };
    this.modelResolver =
      normalizedOptions.modelResolver ??
      new ModelResolver({
        fallbackModelPreferredOrder: normalizedOptions.fallbackModelPreferredOrder,
        modelCatalog: normalizedOptions.modelCatalog,
      });
    this.modelCatalog = normalizedOptions.modelCatalog ?? createEmptyModelCatalog();
    this.aiEngine = normalizedOptions.aiEngine;
  }

  private normalizeConstructorOptions(options?: Partial<LlmRetryConfig> | LlmCallerOptions): LlmCallerOptions {
    if (!options) {
      throw new Error('[LlmCaller] aiEngine is required. Inject it from host assembly or test harness.');
    }

    if (isLlmCallerOptions(options)) {
      return options;
    }

    return {
      ...options,
      aiEngine: createMissingAiEngine(),
    };
  }

  /**
   * 计算“本次调用是否允许客户端重试”。
   *
   * 中文说明（根因）：
   * - BYOK（本地直连）模式：客户端重试是合理的，成本由用户自带 key 承担；
   * - Cloud（积分计费）模式：客户端重试会导致“一次点击一个 request_id”语义被破坏，
   *   因为同一次点击可能触发多次上游调用，从而造成对账困难或平台资损。
   *
   * 因此：Cloud 模式下应默认禁用客户端重试，把重试/降级收敛到服务端网关（Cloudflare Worker）。
   *
   * 注意：
   * - 这里严格依赖模型配置的显式字段（billing_mode / enable_client_retry），不做脆弱的域名猜测。
   */
  private isClientRetryEnabledForModel(modelId: string, options: LlmCallOptions): boolean {
    // 1) 显式调用参数优先
    if (options.retry_policy === 'none') return false;
    if (options.retry_policy === 'client') return true;

    // 2) 模型配置决定
    const cfg = this.modelCatalog.getModelById(modelId);
    if (!cfg) return true;

    // billing_mode='cloud' 默认关闭客户端重试（除非显式 enable_client_retry=true）
    if (cfg.billing_mode === 'cloud') {
      return cfg.enable_client_retry === true;
    }

    // byok 或未标记：保持原行为（允许重试），除非显式关闭
    if (cfg.enable_client_retry === false) return false;
    return true;
  }

  /**
   * 非流式 LLM 调用
   */
  async call(
    modelId: string,
    messages: LlmRequestMessage[],
    options: LlmCallOptions = {},
    signal?: AbortSignal
  ): Promise<string | { content: string; tool_calls?: ToolCall[]; reasoning_details?: unknown[]; usage?: unknown }> {
    const response = await this.aiEngine.chatCompletion(modelId, messages, { ...options, signal });
    
    // 处理 null 或 undefined 响应
    if (!response) {
      return String(response);
    }
    
    // 非流式调用也可能返回工具调用，确保返回对象
    const respUnknown: unknown = response;
    if (isRecord(respUnknown)) {
      const usage = respUnknown['usage'];
      const parsedToolCalls = toToolCalls(respUnknown['tool_calls']);
      if (!parsedToolCalls) {
        // fallthrough：不包含 tool_calls 的普通响应
      } else {
      const rd = Array.isArray(respUnknown['reasoning_details']) ? (respUnknown['reasoning_details'] as unknown[]) : undefined;
      return {
        content: typeof respUnknown['content'] === 'string' ? (respUnknown['content'] as string) : '',
        tool_calls: parsedToolCalls,
        reasoning_details: rd,
        ...(usage !== undefined ? { usage } : {}),
      };
      }
    }

    if (typeof response === 'string') {
      return response;
    } else if (typeof response === 'object') {
      // 兼容：某些 provider 可能返回 { content, reasoning_details } 但不包含 tool_calls
      if (isRecord(respUnknown) && (respUnknown['content'] !== undefined || respUnknown['reasoning_details'] !== undefined)) {
        const usage = respUnknown['usage'];
        return {
          content: typeof respUnknown['content'] === 'string' ? (respUnknown['content'] as string) : '',
          reasoning_details: Array.isArray(respUnknown['reasoning_details']) ? (respUnknown['reasoning_details'] as unknown[]) : undefined,
          ...(usage !== undefined ? { usage } : {}),
        };
      }
      if (isRecord(respUnknown)) {
        const contentValue = respUnknown['content'];
        if (typeof contentValue === 'string') return contentValue;
        const textValue = respUnknown['text'];
        if (typeof textValue === 'string') return textValue;
      }
      return JSON.stringify(response);
    }
    
    return String(response);
  }

  /**
   * 流式 LLM 调用
   */
  async callStream(
    modelId: string,
    messages: LlmRequestMessage[],
    options: LlmCallOptions = {},
    eventHandler: (event: AnyAgentEvent) => void,
    signal?: AbortSignal
  ): Promise<string | { content: string; tool_calls?: ToolCall[]; reasoning_details?: unknown[]; usage?: unknown }> {
    let fullResponse = '';
    let streamError: Error | null = null;
    let streamEnded = false;
    const reasoningDetails: unknown[] = [];
    // 中文说明：
    // - `stream_chunk` 事件在类型层要求必须携带 `answer_id/seq`；
    // - 这里先在 LlmCaller 侧生成“本次流式回答”的稳定标识，保证事件本身类型完整；
    // - 后续若上游提供了更权威的 answer_id，LlmNode 仍可按既有逻辑切段重置。
    const streamAnswerId = generateMessageId();
    let streamChunkSeq = 0;
    // 🔥 usage：流式场景下仅当 provider 支持 include_usage 时才会拿到（可能出现在最后一个 chunk）
    let capturedUsage: unknown | undefined = undefined;
    // tool_calls 聚合器：将 ToolCallChunk[] 归一化为稳定的 ToolCall[]
    // 需要在拿到 tool_call_id + tool_name 时立刻渲染 loading 态的工具，必须进入占位 allowlist。
    const toolAccumulator = new ToolCallStreamAccumulator([
      'markdown_edit',
      'text_to_image',
      'ask_questions',
      'ppt_plan',
      'ppt_codegen',
    ]);
    // thought 段落聚合器：处理交错 thought + 精确计时（算法下沉到独立模块）
    const thoughtSegmenter = new ThoughtStreamSegmenter();

    /**
     * @description
     * 将 ThoughtStreamSegmenter 的“封口结果”映射为标准 thought complete 事件。
     *
     * 注意：
     * - 封口的结束锚点由 segmenter 决定（最后一个 thought delta 的时间），禁止用后续消息时间推断；
     * - 这里仅负责事件发射，算法在 segmenter 内部。
     */
    const emitThoughtComplete = (completed: ReturnType<ThoughtStreamSegmenter['finalize']>): void => {
      if (!completed) return;
      eventHandler({
        type: 'thought',
        thought_message_id: completed.thoughtMessageId,
        id: generateMessageId(),
        timestamp: completed.timestamp,
        content: completed.content,
        is_complete: true,
        meta: {
          thought_started_at: completed.thoughtStartedAt,
          thought_completed_at: completed.thoughtCompletedAt,
        }
      });
    };

    const emitToolCallPlaceholder = (toolCallId: string, toolName: string) => {
      if (!toolCallId || !toolName) return;
      eventHandler({
        type: 'tool_process',
        id: generateMessageId(),
        timestamp: Date.now(),
        tool_name: toolName,
        tool_args: {},
        tool_call_id: toolCallId,
        phase: 'start',
        status: 'loading',
        payload: { args: {} },
        meta: { ephemeral: true }
      });
    };

    const emitStreamChunk = (content: string) => {
      eventHandler({
        type: 'stream_chunk',
        timestamp: Date.now(),
        content,
        id: generateMessageId(),
        answer_id: streamAnswerId,
        seq: streamChunkSeq++,
      });
    };

    const onContent = (chunk: string | LlmResponseContent) => {
      if (typeof chunk === 'string') {
        // 内容边界：封口 thought 段落（结束锚点取最后一个 thought delta）
        emitThoughtComplete(thoughtSegmenter.onBoundary());
        fullResponse += chunk;
        emitStreamChunk(chunk);
      } else if (typeof chunk === 'object' && chunk !== null) {
        if (chunk.content) {
          emitThoughtComplete(thoughtSegmenter.onBoundary());
          fullResponse += chunk.content;
          emitStreamChunk(chunk.content);
        }
        // OpenRouter: 累积 reasoning_details（必须原样回传）
        const rd = isRecord(chunk) ? chunk['reasoning_details'] : undefined;
        if (rd !== undefined) {
          if (Array.isArray(rd)) {
            reasoningDetails.push(...rd);
          } else {
            reasoningDetails.push(rd);
          }
        }
        if (chunk.tool_calls) {
          // 工具调用边界：封口 thought 段落
          emitThoughtComplete(thoughtSegmenter.onBoundary());
          // 累积工具调用 - 在流式场景中，这些是 ToolCallChunk[]
          toolAccumulator.applyChunks(
            chunk.tool_calls,
            emitToolCallPlaceholder,
            (toolCallId, toolName, args) => {
              // ✅ args 快照流式更新：用于问卷等“结构化 UI”在 executing 阶段丝滑增量渲染
              eventHandler({
                type: 'tool_process',
                id: generateMessageId(),
                timestamp: Date.now(),
                tool_name: toolName,
                tool_args: args,
                tool_call_id: toolCallId,
                phase: 'update',
                status: 'loading',
                payload: { args },
                // 仅用于实时 UI，不应污染持久化历史（由映射层标记 ephemeral）
                meta: { ephemeral: true }
              });
            }
          );
        }
      }
    };

    const onError = (error: Error) => {
      streamError = error;
      streamEnded = true;
      /**
       * 🔎 诊断日志（开发期）：捕获“流式内部错误”发生点
       *
       * 你现在的现象是：任务每个阶段看似都能跑完（进入 paused），但前端仍收到 type='error' SSE。
       * 其中一个高概率来源就是这里：LLM 流式回调 onError 触发时会发出 AgentErrorEvent，
       * 上游若仍继续重试/切模型并最终成功，就会出现“用户看到错误但流程其实成功”的错觉。
       *
       * 先加日志把链路钉死：等你下一次复现，把控制台里这条日志和前端 error 事件的 turnId 对上即可。
       */
      if (process.env.NODE_ENV !== 'production') {
        console.error('[LlmCaller][callStream] onError fired', {
          modelId,
          messageCount: Array.isArray(messages) ? messages.length : -1,
          errorMessage: error?.message,
        });
      }
      eventHandler({ type: 'error', error: error.message, details: error.stack, timestamp: Date.now(), id: generateMessageId() });
    };

    const onFinish = (reason: string) => {
      // onFinish 不再发送事件，由 stream_end 信号处理
    };

    // 🔥 修复：和 ChatService 完全一致，直接转发 thought 事件
    // 注意：
    // - 前端的 SSE 投影使用 event.id 作为“事件ID”，并通过 processedEvents 去重
    // - 因此每一个增量 thought 事件的 id 必须唯一，否则后续增量会被视为重复事件而被直接丢弃
    // - 思考消息本身的“消息ID”由前端的 turnState.thoughtMessageId 管理，不依赖 event.id 稳定
    const onThought = (thought: string) => {
      const delta = thoughtSegmenter.onThoughtDelta(thought);
      if (!delta) return;

      eventHandler({
        type: 'thought',
        thought_message_id: delta.thoughtMessageId,
        id: generateMessageId(),
        timestamp: delta.timestamp,
        content: '',
        delta: delta.delta,
        is_complete: false,
        meta: {
          thought_started_at: delta.thoughtStartedAt,
        }
      });
    };

    const onUsage = (usage: unknown) => {
      capturedUsage = usage;
    };

    // 直接调用并让 Promise 在后台运行，不阻塞
    // 🔥 将 signal 传递给 aiEngine 以支持取消
      await this.aiEngine.chatCompletionStream(
      modelId,
      messages,
      {
        ...options,
        signal,
        /**
         * 🔥 统一尝试开启 stream usage（OpenAI-compat: stream_options.include_usage）
         *
         * 中文备注：
         * - 若 provider 不支持该字段，通常会忽略；
         * - 即使不支持，也不应影响正常流式输出。
         */
        stream_options: { include_usage: true },
      },
      onContent,
      onError,
      onFinish,
      onThought,
      onUsage
    );

    // 🔥 语义修正：如果流式调用失败，则本次 attempt 不应发送“完成 thought”
    // 原因：
    // - callWithRetries 可能会继续重试，失败 attempt 的完整 thought 会污染 UI 与持久化历史；
    // - 增量 thought（is_complete=false, delta）仍会在流式阶段透传给前端用于展示，但不会落库。
    if (streamError) {
      throw streamError;
    }

    // 🔥 流结束：若仍有未封口的 thought 段，按“最后一个 thought delta 的时间”封口
    emitThoughtComplete(thoughtSegmenter.finalize());

    // 返回累积的响应
    const mergedToolCalls = toolAccumulator.getToolCalls();
    assertToolCallsHaveValidJsonArguments(mergedToolCalls);
    if (mergedToolCalls.length > 0 || reasoningDetails.length > 0 || capturedUsage !== undefined) {
      return {
        content: fullResponse,
        tool_calls: mergedToolCalls, // 过滤无效 tool_calls；签名补齐交由 policy/adapter
        reasoning_details: reasoningDetails.length > 0 ? reasoningDetails : undefined,
        ...(capturedUsage !== undefined ? { usage: capturedUsage } : {}),
      };
    }

    return fullResponse;
  }

  /**
   * 🔥 带智能重试的 LLM 调用
   * 
   * @description
   * 根据错误类型智能判断是否应该重试：
   * - 网络错误、服务端临时错误：正常重试
   * - 速率限制错误：使用更长延迟重试
   * - 格式错误、权限错误、功能不支持：不重试，直接失败
   */
  async callWithRetries(
    modelId: string,
    messages: LlmRequestMessage[],
    options: LlmCallOptions = {},
    eventHandler?: (event: AnyAgentEvent) => void,
    signal?: AbortSignal,
    onCloudQuotaFallbackApplied?: (fallbackModelId: string) => void,
  ): Promise<string | { content: string; tool_calls?: ToolCall[]; reasoning_details?: unknown[]; usage?: unknown }> {
    let lastError: Error | null = null;
    let actualAttempts = 0; // 实际尝试次数（不包括被跳过的重试）

    // 🔥 降级/切换模型支持：在同一次 callWithRetries 中允许切换到备用模型继续跑
    let activeModelId = modelId;
    const excludedModelIds = new Set<string>([modelId]);

    const clientRetryEnabled = this.isClientRetryEnabledForModel(modelId, options);
    const configuredMaxRetries = this.retryConfig.maxRetries;

    if (!clientRetryEnabled) {
      const activeCfg = this.modelCatalog.getModelById(modelId);
      const billingMode = activeCfg?.billing_mode;
      // 中文日志：帮助你在联调 Cloud 模式时确认“客户端没有在偷偷重试”
      console.log('[LlmCaller] 🧾 默认禁用客户端重试（除非遇到本地纯网络错误）', {
        modelId,
        billing_mode: billingMode,
        reason: options.retry_policy === 'none' ? 'options.retry_policy=none' : 'model config (cloud billing or enable_client_retry=false)',
      });
    }

    for (let attempt = 0; attempt <= configuredMaxRetries; attempt++) {
      // 🔥 在每次重试前检查是否已取消
      if (signal?.aborted) {
        console.log(`[LlmCaller] 🛑 检测到取消信号，停止AI活动`);
        const cancelError = new Error('Request cancelled by user');
        cancelError.name = 'AbortError';
        throw cancelError;
      }

      const isRetry = attempt > 0;

      // 🔥 每次 attempt 独立缓存一次 error 事件（来自 callStream.onError），用于“最终失败时”再向上游补发。
      // 这样可以避免重试过程中 UI 提前结束流式状态。
      let pendingErrorEvent: AgentErrorEvent | null = null;

      const wrappedEventHandler: ((event: AnyAgentEvent) => void) | undefined = eventHandler
        ? (evt: AnyAgentEvent) => {
            if (evt && typeof evt === 'object' && evt.type === 'error') {
              pendingErrorEvent = evt;
              if (process.env.NODE_ENV !== 'production') {
                const rec = evt as { id?: unknown; error?: unknown; timestamp?: unknown };
                console.warn('[LlmCaller][callWithRetries] captured pending error event (will only forward if final failure)', {
                  attempt,
                  modelId: activeModelId,
                  eventId: typeof rec.id === 'string' ? rec.id : undefined,
                  error: typeof rec.error === 'string' ? rec.error : undefined,
                  timestamp: typeof rec.timestamp === 'number' ? rec.timestamp : undefined,
                });
              }
              return;
            }
            eventHandler(evt);
          }
        : undefined;
      
      try {
        if (isRetry) {
          console.log(`[LlmCaller] 🔄 LLM调用 - 第 ${attempt} 次重试 (最大配置 ${configuredMaxRetries} 次)`);
        }
        
        actualAttempts++;

        const llmResponse = wrappedEventHandler
          ? await this.callStream(activeModelId, messages, options, wrappedEventHandler, signal)
          : await this.call(activeModelId, messages, options, signal);

        // 检查空响应
        const responseContent =
          typeof llmResponse === 'object'
            ? (llmResponse as { content: string; tool_calls?: ToolCall[]; reasoning_details?: unknown[] }).content
            : llmResponse;
        const toolCallsFromLLM =
          typeof llmResponse === 'object'
            ? (llmResponse as { content: string; tool_calls?: ToolCall[]; reasoning_details?: unknown[] }).tool_calls
            : undefined;

        if (this.retryConfig.enableEmptyResponseRetry && !responseContent?.trim() && !toolCallsFromLLM?.length) {
          throw new Error('LLM返回了空响应');
        }

        // 成功，返回结果
        console.log(`[LlmCaller] ✅ LLM调用成功 (尝试 ${actualAttempts} 次)`);
        return llmResponse;

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // 🔥 使用共享的智能错误分类器
        const classification = ErrorClassifier.classify(lastError, { logPrefix: '[LlmCaller]' });

        // 计算本次 attempt 适用的最大重试次数
        let currentMaxRetries = clientRetryEnabled ? configuredMaxRetries : 0;
        
        // 🔥 特殊放行：针对 Cloud 模式被禁用客户端重试的情况，部分错误云端无法代为重试：
        // 1. 纯本地网络错误（如连接被重置、terminated 等）：发生在客户端与网关之间
        // 2. 空响应错误：客户端本地校验拦截，云端不知道内容为空
        // 3. 流式 tool_call.arguments 非法：属于模型输出损坏，客户端在收流结束后才能发现
        // 遇到这两种情况，破例允许客户端重试。
        if (!clientRetryEnabled && classification.category === ErrorCategory.RETRYABLE) {
          if (
            classification.reason.startsWith('网络错误') ||
            classification.reason === '空响应错误' ||
            classification.reason === '模型输出损坏: invalid tool_call.arguments'
          ) {
            console.log(`[LlmCaller] 🛟 云端模型检测到必须本地兜底的错误 (${classification.reason})，破例允许客户端重试`);
            currentMaxRetries = configuredMaxRetries;
          }
        }

        console.error(`[LlmCaller] ❌ LLM调用失败 (尝试 ${attempt + 1}/${currentMaxRetries + 1}):`, lastError.message);

        // 用户主动终止属于控制流，不应向上游发布 error 事件污染会话事实。
        if (lastError.name === 'AbortError') {
          console.log('[LlmCaller] 🛑 收到 AbortError，直接向上抛出，不进入错误事件与重试流程');
          throw lastError;
        }

        // 🔥 供应商/模型组合特判：交给 PolicyEngine 决策（例如 OpenRouter+Gemini 的 thought_signature 校验）
        const policySwitchModelId = this.tryPolicyModelSwitch({
          activeModelId,
          excludedModelIds,
          error: lastError,
        });
        if (policySwitchModelId) {
          activeModelId = policySwitchModelId;
          excludedModelIds.add(policySwitchModelId);
          // 切模型属于“同一次业务尝试内的路由修正”，不应消耗客户端 retry 配额。
          attempt -= 1;
          continue;
        }

        const runScopedQuotaFallbackModelId = this.tryCloudQuotaFallback({
          activeModelId,
          options,
          excludedModelIds,
          error: lastError,
          onCloudQuotaFallbackApplied,
        });
        if (runScopedQuotaFallbackModelId) {
          activeModelId = runScopedQuotaFallbackModelId;
          excludedModelIds.add(runScopedQuotaFallbackModelId);
          // 云端 quota 降级本质也是“同一次尝试内切路由”，不能把它算作一次 retry。
          attempt -= 1;
          continue;
        }

        // 🔥 根据错误类型决定是否重试
        if (classification.category === ErrorCategory.NON_RETRYABLE) {
          console.error(`[LlmCaller] 💥 错误不可重试，直接失败: ${classification.reason}`);
          // 仅在最终失败时向上游发出一次 error 事件（用于 UI 收敛状态）
          if (eventHandler) {
            if (pendingErrorEvent) {
              eventHandler(pendingErrorEvent);
            } else {
              eventHandler({
                type: 'error',
                id: generateMessageId(),
                timestamp: Date.now(),
                error: lastError.message,
                details: lastError.stack
              });
            }
          }
          throw lastError; // 不可重试的错误直接抛出
        }
        
        // 如果已达到最大重试次数，抛出错误
        if (attempt >= currentMaxRetries) {
          console.error(`[LlmCaller] 💥 已达到最大重试次数 (${currentMaxRetries})，放弃重试`);
          if (eventHandler) {
            if (pendingErrorEvent) {
              eventHandler(pendingErrorEvent);
            } else {
              eventHandler({
                type: 'error',
                id: generateMessageId(),
                timestamp: Date.now(),
                error: lastError.message,
                details: lastError.stack
              });
            }
          }
          throw lastError;
        }
        
        // 🔥 使用智能计算的重试延迟
        const retryDelay = ErrorClassifier.calculateRetryDelay(
          lastError,
          attempt,
          this.retryConfig.retryDelayMs,
          60000 // 最大60秒
        );
        
        if (classification.category === ErrorCategory.RATE_LIMIT) {
          console.log(`[LlmCaller] ⏱️ 速率限制错误，延迟 ${retryDelay}ms 后重试 (${classification.reason})`);
        } else if (classification.category === ErrorCategory.RETRYABLE) {
          console.log(`[LlmCaller] 🔄 可重试错误，延迟 ${retryDelay}ms 后重试 (${classification.reason})`);
        }
        
        // 🔥 在延迟等待前检查是否已取消
        if (signal?.aborted) {
          console.log(`[LlmCaller] 🛑 延迟等待前检测到取消信号，停止重试`);
          const cancelError = new Error('Request cancelled by user');
          cancelError.name = 'AbortError';
          throw cancelError;
        }
        
        if (retryDelay > 0) {
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }

    // 如果循环结束仍未成功（理论上不会到这里），抛出错误
    throw lastError || new Error('LLM调用在所有重试后都失败了');
  }

  private tryPolicyModelSwitch({
    activeModelId,
    excludedModelIds,
    error,
  }: {
    activeModelId: string;
    excludedModelIds: Set<string>;
    error: Error;
  }): string | null {
    const activeModelConfig = this.modelCatalog.getModelById(activeModelId);
    const policyDecision = defaultPolicyEngine.decideOnError(error, {
      modelId: activeModelId,
      apiBase: activeModelConfig?.api_base,
      requestModelName: activeModelConfig?.model_name,
    });
    if (policyDecision.action !== 'switch_model') {
      return null;
    }

    const fallbackModelId = this.modelResolver.pickFallbackChatModel(excludedModelIds);
    if (!fallbackModelId) {
      console.warn('[LlmCaller] 🧭 Policy要求切换模型，但未找到可用备用模型（可能未配置 API Key）');
      return null;
    }

    console.warn(`[LlmCaller] 🧭 Policy(${policyDecision.reason})，切换模型继续: ${activeModelId} -> ${fallbackModelId}`);
    return fallbackModelId;
  }

  private tryCloudQuotaFallback({
    activeModelId,
    options,
    excludedModelIds,
    error,
    onCloudQuotaFallbackApplied,
  }: {
    activeModelId: string;
    options: LlmCallOptions;
    excludedModelIds: Set<string>;
    error: Error;
    onCloudQuotaFallbackApplied?: (fallbackModelId: string) => void;
  }): string | null {
    const runScopedQuotaFallbackModelId = options.cloud_quota_fallback_model_id;
    if (
      !runScopedQuotaFallbackModelId ||
      !ErrorClassifier.isCloudQuotaError(error) ||
      excludedModelIds.has(runScopedQuotaFallbackModelId)
    ) {
      return null;
    }

    const fallbackConfig = this.modelCatalog.getModelById(runScopedQuotaFallbackModelId);
    if (!fallbackConfig?.api_key) {
      console.warn(
        `[LlmCaller] ☁️ 云端限额降级目标不可用: ${runScopedQuotaFallbackModelId}（未注册或缺少 API Key）`,
      );
      return null;
    }

    console.warn(
      `[LlmCaller] ☁️ 云端限额降级（run 内续跑）: ${activeModelId} -> ${runScopedQuotaFallbackModelId}`,
      { reason: error.message },
    );
    onCloudQuotaFallbackApplied?.(runScopedQuotaFallbackModelId);
    return runScopedQuotaFallbackModelId;
  }

  /**
   * 获取或使用默认模型ID
   */
  resolveModelId(requestedModelId?: string): string {
    return this.modelResolver.resolveModelId(requestedModelId);
  }
} 
