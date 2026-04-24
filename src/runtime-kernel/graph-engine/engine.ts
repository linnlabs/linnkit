import { Logger } from '../../shared/logger';
import { noopTelemetry } from '../telemetry/noopTelemetry';
import type { TelemetryPort } from '../telemetry/telemetryPort';
import type { Checkpointer } from './checkpointer/base';
import { ENGINE_STATE_SCHEMA_VERSION, type EngineState, type GraphNode, type NodeResult } from './types';
import { DEFAULT_MAX_STEPS, type RuntimeEvent } from '../../contracts';

const logger = new Logger('GraphExecutor');

function asLocalRecord(local: EngineState['local']): Record<string, unknown> {
  return local && typeof local === 'object' ? { ...local } : {};
}

export interface GraphExecutorConfig {
  maxSteps?: number;
  maxCheckpoints?: number;
  /**
   * 可选：宿主提供的 TelemetryPort 实现。
   * 不传时使用 noopTelemetry（observability 默认关闭，零业务影响）。
   */
  telemetryPort?: TelemetryPort;
}

export class GraphExecutor {
  private nodes: Map<string, GraphNode> = new Map();
  private ephemeralLocals: Map<string, Record<string, unknown>> = new Map();
  private readonly config: Required<Pick<GraphExecutorConfig, 'maxSteps' | 'maxCheckpoints'>>;
  private readonly telemetryPort: TelemetryPort;

  constructor(
    private readonly checkpointer: Checkpointer,
    config: GraphExecutorConfig = {}
  ) {
    this.config = {
      maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
      maxCheckpoints: config.maxCheckpoints ?? 10,
    };
    this.telemetryPort = config.telemetryPort ?? noopTelemetry;
  }

  registerNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
  }

  async peekCheckpoint(conversationId: string): Promise<EngineState | null> {
    return await this.checkpointer.load(conversationId);
  }

  private sanitize(state: EngineState): EngineState {
    const local = asLocalRecord(state.local);
    if ('memory' in local) delete local.memory;
    if ('sseSink' in local) delete local.sseSink;
    return {
      nodeId: state.nodeId,
      schemaVersion: state.schemaVersion ?? ENGINE_STATE_SCHEMA_VERSION,
      local,
    };
  }

  async prime(conversationId: string, local: Record<string, unknown>, nodeId: string = 'user'): Promise<void> {
    this.ephemeralLocals.set(conversationId, { ...(local || {}) });
    const localSansMemory = { ...(local || {}) };
    if ('memory' in localSansMemory) delete localSansMemory.memory;
    const state: EngineState = {
      nodeId,
      schemaVersion: ENGINE_STATE_SCHEMA_VERSION,
      local: localSansMemory,
    };
    await this.checkpointer.save(conversationId, state);
  }

  async setNode(conversationId: string, nodeId: string, localPatch?: Record<string, unknown>): Promise<void> {
    const current = (await this.checkpointer.load(conversationId)) || {
      nodeId: 'user',
      schemaVersion: ENGINE_STATE_SCHEMA_VERSION,
      local: {},
    };
    const mergedLocal = { ...(current.local || {}), ...(localPatch || {}) };
    if ('memory' in mergedLocal) delete mergedLocal.memory;
    const next: EngineState = {
      nodeId,
      schemaVersion: current.schemaVersion ?? ENGINE_STATE_SCHEMA_VERSION,
      local: mergedLocal,
    };
    await this.checkpointer.save(conversationId, next);
  }

  async runUntilYield(conversationId: string): Promise<{ events: RuntimeEvent[]; checkpoint: EngineState; stepCount: number }> {
    // B2-engine Batch 4: run_lifecycle 埋点
    // - 一次 runUntilYield 调用 = 一次 "run"
    // - 进入即 emit 'spawned'，退出走 try/finally 决定 'completed' | 'failed' | 'cancelled'
    const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let lifecyclePhase: 'completed' | 'failed' | 'cancelled' = 'completed';
    this.telemetryPort.emit({
      kind: 'run_lifecycle',
      runId,
      phase: 'spawned',
      scope: { conversationId: conversationId || undefined },
    });

    try {
      return await this.runUntilYieldInternal(conversationId);
    } catch (err) {
      lifecyclePhase = (err as Error | undefined)?.name === 'AbortError' ? 'cancelled' : 'failed';
      throw err;
    } finally {
      this.telemetryPort.emit({
        kind: 'run_lifecycle',
        runId,
        phase: lifecyclePhase,
        scope: { conversationId: conversationId || undefined },
      });
    }
  }

  private async runUntilYieldInternal(conversationId: string): Promise<{ events: RuntimeEvent[]; checkpoint: EngineState; stepCount: number }> {
    let state: EngineState = (await this.checkpointer.load(conversationId)) || {
      nodeId: 'user',
      schemaVersion: ENGINE_STATE_SCHEMA_VERSION,
      local: {},
    };
    const ephemeral = this.ephemeralLocals.get(conversationId) || {};
    state = {
      ...state,
      schemaVersion: state.schemaVersion ?? ENGINE_STATE_SCHEMA_VERSION,
      local: { ...(state.local || {}), ...ephemeral },
    };

    const isAbortSignal = (v: unknown): v is AbortSignal => {
      return v !== null && typeof v === 'object' && 'aborted' in v;
    };
    const throwAbortError = (): never => {
      const err = new Error('The user aborted a request.');
      err.name = 'AbortError';
      throw err;
    };

    let stepCount = 0;
    let cycleStepCount = 0;
    let checkpointCount = 0;
    let allEvents: RuntimeEvent[] = [];
    logger.info('[GraphExecutor] 开始推理循环', {
      maxSteps: this.config.maxSteps,
      maxCheckpoints: this.config.maxCheckpoints,
    });

    const absoluteMaxSteps = this.config.maxSteps * (this.config.maxCheckpoints + 1);
    for (let i = 0; i < this.config.maxSteps && stepCount < absoluteMaxSteps; i++) {
      stepCount++;
      cycleStepCount++;

      const signalRaw = (state.local as Record<string, unknown> | undefined)?.signal;
      if (isAbortSignal(signalRaw) && signalRaw.aborted) {
        logger.warn('[GraphExecutor] 收到 AbortSignal，立即停止推理循环');
        this.ephemeralLocals.delete(conversationId);
        throwAbortError();
      }

      const isLastStep = cycleStepCount >= this.config.maxSteps;
      const rawLocal = state.local && typeof state.local === 'object' ? state.local : {};
      const localForStep: Record<string, unknown> = { ...(rawLocal as Record<string, unknown>) };

      const rawExecutorLocal = localForStep.executorLocal;
      const executorLocalForStep: Record<string, unknown> =
        rawExecutorLocal && typeof rawExecutorLocal === 'object' && !Array.isArray(rawExecutorLocal)
          ? { ...(rawExecutorLocal as Record<string, unknown>) }
          : {};
      executorLocalForStep.maxSteps = this.config.maxSteps;
      executorLocalForStep.stepCount = cycleStepCount;
      executorLocalForStep.remainingSteps = this.config.maxSteps - cycleStepCount;
      executorLocalForStep.checkpointCount = checkpointCount;

      const policyRaw = executorLocalForStep.finalStepPolicy;
      const finalStepPolicy =
        policyRaw === 'force_tools' || policyRaw === 'final_answer'
          ? (policyRaw as 'force_tools' | 'final_answer')
          : 'final_answer';

      const isPenultimateStep = cycleStepCount === this.config.maxSteps - 1;
      if (finalStepPolicy === 'force_tools') {
        executorLocalForStep.phase = isPenultimateStep
          ? 'force_tools'
          : (executorLocalForStep.phase ?? 'running');
      } else {
        executorLocalForStep.phase = isLastStep ? 'force_final_answer' : (executorLocalForStep.phase ?? 'running');
      }
      localForStep.executorLocal = executorLocalForStep;

      const shouldForceToLlm =
        finalStepPolicy === 'force_tools'
          ? isPenultimateStep
          : isLastStep;

      if (shouldForceToLlm && state.nodeId !== 'wait_user' && state.nodeId !== 'answer') {
        delete localForStep.pendingToolCalls;
        delete localForStep.pendingInteractionSpec;
        delete localForStep.lastToolResult;
        if (state.nodeId !== 'llm') {
          const reason =
            finalStepPolicy === 'force_tools'
              ? 'force tools before maxSteps'
              : 'force final answer at maxSteps';
          logger.warn('[GraphExecutor] 收尾策略强制切换到 llm 节点', {
            reason,
            fromNodeId: state.nodeId,
          });
          state = { ...state, nodeId: 'llm', local: localForStep };
        } else {
          state = { ...state, local: localForStep };
        }
      } else {
        state = { ...state, local: localForStep };
      }

      const node = this.nodes.get(state.nodeId);
      if (!node) {
        logger.info('[GraphExecutor] 推理完成，无可执行节点', {
          cycleStepCount,
          maxSteps: this.config.maxSteps,
          stepCount,
          checkpointCount,
        });
        const cp = this.sanitize(state);
        await this.checkpointer.save(conversationId, cp);
        this.ephemeralLocals.delete(conversationId);
        return { events: allEvents, checkpoint: cp, stepCount };
      }

      logger.info('[GraphExecutor] 节点切换', {
        cycleStepCount,
        maxSteps: this.config.maxSteps,
        stepCount,
        nodeId: state.nodeId,
      });

      // B2-engine Batch 3: 计时 graph_node 事件
      const nodeRunStartedAt = Date.now();
      const nodeIdForTelemetry = state.nodeId;
      let result: NodeResult;
      try {
        result = await node.run(state);
      } finally {
        const turnIdForTelemetry =
          typeof (state.local as Record<string, unknown> | undefined)?.turnId === 'string'
            ? ((state.local as Record<string, unknown>).turnId as string)
            : undefined;
        this.telemetryPort.emit({
          kind: 'graph_node',
          nodeId: nodeIdForTelemetry,
          durationMs: Date.now() - nodeRunStartedAt,
          scope: {
            conversationId: conversationId || undefined,
            turnId: turnIdForTelemetry,
          },
        });
      }

      if (Array.isArray(result.events) && result.events.length > 0) {
        logger.info('[GraphExecutor] 节点产生事件', {
          nodeId: state.nodeId,
          eventCount: result.events.length,
          events: result.events.map((event) => `${event.type}(${event.timestamp})`),
        });
        allEvents.push(...result.events);
      }

      const localAfterRun = (state.local && typeof state.local === 'object')
        ? state.local as Record<string, unknown>
        : undefined;
      if (localAfterRun?._checkpointStepReset === true) {
        delete localAfterRun._checkpointStepReset;
        checkpointCount++;
        if (checkpointCount > this.config.maxCheckpoints) {
          logger.warn('[GraphExecutor] 达到最大 checkpoint 次数，不再重置步数', {
            checkpointCount,
            maxCheckpoints: this.config.maxCheckpoints,
          });
        } else {
          logger.info('[GraphExecutor] checkpoint 重置步数预算', {
            checkpointCount,
            previousCycleStepCount: cycleStepCount,
            stepCount,
          });
          cycleStepCount = 0;
          i = -1;
        }
      }

      if (result.kind === 'route') {
        const nextNodeId = result.nextNodeId || 'user';
        logger.info('[GraphExecutor] 路由切换', {
          fromNodeId: state.nodeId,
          nextNodeId,
        });
        state = { ...state, nodeId: nextNodeId };
        const cp = this.sanitize(state);
        await this.checkpointer.save(conversationId, cp);
        continue;
      }

      if (result.kind === 'yield') {
        logger.info('[GraphExecutor] 推理暂停，等待外部输入', {
          cycleStepCount,
          maxSteps: this.config.maxSteps,
          stepCount,
          checkpointCount,
        });
        const cp = this.sanitize(state);
        await this.checkpointer.save(conversationId, cp);
        return { events: allEvents, checkpoint: cp, stepCount };
      }

      if (result.kind === 'pause') {
        logger.info('[GraphExecutor] 推理暂停，等待用户交互', {
          cycleStepCount,
          maxSteps: this.config.maxSteps,
          stepCount,
          checkpointCount,
        });
        const cp = this.sanitize(state);
        await this.checkpointer.save(conversationId, cp);
        return { events: allEvents, checkpoint: cp, stepCount };
      }
    }

    logger.warn('[GraphExecutor] 达到步数上限，强制结束', {
      cycleStepCount,
      maxSteps: this.config.maxSteps,
      stepCount,
      checkpointCount,
    });
    const cp = this.sanitize(state);
    await this.checkpointer.save(conversationId, cp);
    this.ephemeralLocals.delete(conversationId);
    return { events: allEvents, checkpoint: cp, stepCount };
  }
}
