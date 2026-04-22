import { GraphNode, EngineState, NodeResult } from '../types';
import type { TickInput, TickOutput } from '../tick-pipeline/types';
import { Logger } from '../../../shared/logger';
import type { ExecutorLocalState } from '../types';
import { readGraphAgentLocal } from '../graphLocal';
import {
  initLlmNodeState,
  llmNodeReducer,
  buildLocalPatch,
  type LlmNodeAction,
} from './llmNode.state';
import { LlmNodeEventBridge, type TickEvent } from './llmNode.eventBridge';
import type { RuntimeEvent } from '../../../contracts';

const logger = new Logger('LlmNode');

/**
 * LlmNode 只依赖"单步推理"能力，不直接依赖具体执行器实现。
 *
 * 中文备注：
 * - 这样节点本身只关注图节点职责，不负责组装 `LlmCaller` / `ToolRegistry`；
 * - 默认依赖装配放到工厂里，方便测试替换，也降低构造函数耦合。
 */
export interface LlmNodeReasoner {
  tick(
    input: TickInput,
    eventHandler?: (event: TickEvent) => void,
  ): Promise<TickOutput>;
}

export interface LlmNodeDependencies {
  reasoner: LlmNodeReasoner;
}

export class LlmNode implements GraphNode {
  id = 'llm';
  private readonly reasoner: LlmNodeReasoner;

  constructor(dependencies: LlmNodeDependencies) {
    this.reasoner = dependencies.reasoner;
  }

  async run(state: EngineState): Promise<NodeResult> {
    const local = state.local ?? {};
    logger.info('[LlmNode] 开始执行 LLM 节点', {
      localKeys: Object.keys(local),
    });

    const graphLocal = readGraphAgentLocal(state.local);
    const { conversationId, request, toolContext, summarizationCallbacks, sseSink, signal, history } = graphLocal;
    logger.info('[LlmNode] 已加载历史事件', {
      historyCount: history.length,
      hasSummarizationCallbacks: Boolean(summarizationCallbacks),
    });

    const turnId = graphLocal.turnId ?? `turn_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    if (!request) {
      logger.warn('Request object is missing, yielding.');
      return { kind: 'yield', events: [] };
    }

    // ── 阶段/请求解析 ──

    const phase = graphLocal.executorLocal?.phase;
    const forceFinalAnswer = phase === 'force_final_answer';
    const forceTools = phase === 'force_tools';

    const finalStepForcedTools = graphLocal.executorLocal?.finalStepForcedTools;
    const forcedTools = Array.isArray(finalStepForcedTools)
      ? finalStepForcedTools.filter((toolName) => typeof toolName === 'string' && toolName.length > 0)
      : [];

    const effectiveRequest = forceFinalAnswer
      ? { ...request, enableTools: false, availableTools: [] }
      : forceTools
        ? { ...request, enableTools: true, availableTools: forcedTools }
        : request;
    const executorLocal: ExecutorLocalState | undefined = graphLocal.executorLocal;

    // ── 状态 reducer ──

    let nodeState = initLlmNodeState({ answerId: graphLocal.answerId, chunkSeq: graphLocal.chunkSeq });
    const dispatch = (action: LlmNodeAction) => {
      nodeState = llmNodeReducer(nodeState, action);
    };

    // ── 事件桥（Phase 1.5-2b：SSE 分发与事件映射职责抽离） ──

    const bridge = new LlmNodeEventBridge({
      getState: () => nodeState,
      dispatch,
      sseSink,
      conversationId,
      turnId,
    });

    // ── 执行 tick ──

    const { decision, newEvents } = await this.reasoner.tick({
      request: effectiveRequest,
      toolContext,
      stream: true,
      history,
      signal,
      forceFinalAnswer,
      executorLocal,
      summarizationCallbacks,
    }, bridge.handle);

    // ── 决策 dispatch ──

    switch (decision.kind) {
      case 'tool_calls': {
        if (forceFinalAnswer) {
          dispatch({ type: 'TOOL_CALLS_REJECTED_BY_FORCE_FINAL' });
        } else {
          dispatch({ type: 'TOOL_CALLS_ACCEPTED', toolCalls: decision.toolCalls });
        }
        break;
      }
      case 'final_answer': {
        dispatch({ type: 'FINAL_ANSWER_DECISION', answer: decision.answer });
        break;
      }
      case 'wait_user': {
        dispatch({
          type: 'WAIT_USER_DECISION',
          spec: decision.pendingInteractionSpec,
          lastToolResult: decision.lastToolResult,
        });
        break;
      }
    }

    // ── 一次性回写 state.local ──

    const patch = buildLocalPatch(nodeState, { conversationId, turnId, history, newEvents });
    state.local = { ...(state.local || {}), ...patch };

    const combinedEvents = [...newEvents, ...nodeState.streamRuntimeEvents];

    logger.info('[LlmNode] 历史事件已更新', {
      previousCount: history.length,
      nextCount: (patch.history as RuntimeEvent[]).length,
      newEventCount: newEvents.length,
      streamedEventCount: nodeState.streamRuntimeEvents.length,
    });

    logger.info('[LlmNode] 执行器决策完成', {
      decisionKind: decision.kind,
      emittedEventCount: combinedEvents.length,
    });

    // ── 路由 ──

    switch (decision.kind) {
      case 'tool_calls': {
        if (forceFinalAnswer) {
          return { kind: 'yield', events: combinedEvents };
        }
        return { kind: 'route', nextNodeId: 'tool', events: combinedEvents };
      }
      case 'final_answer': {
        return { kind: 'route', nextNodeId: 'answer', events: combinedEvents };
      }
      case 'wait_user': {
        return { kind: 'route', nextNodeId: 'wait_user', events: combinedEvents };
      }
      case 'yield': {
        return { kind: 'yield', events: combinedEvents };
      }
      case 'error': {
        // Logger 的载荷类型为 Record<string, unknown>，需将 Error 序列化为普通对象
        const { name, message, stack } = decision.error;
        logger.error('[LlmNode] Executor returned an error', { name, message, stack });
        return { kind: 'yield', events: combinedEvents };
      }
      default: {
        return { kind: 'yield', events: combinedEvents };
      }
    }
  }
}
