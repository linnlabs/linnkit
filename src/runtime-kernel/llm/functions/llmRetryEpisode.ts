import { generateRuntimeEventId, type LlmRetryState } from '../../../contracts';
import type { AnyAgentEvent } from '../../events/agentEvents';

const SAFE_RETRY_MESSAGES: Record<LlmRetryState['category'], string> = {
  transport: 'Network connection interrupted',
  output: 'Model output could not be accepted',
  rate_limit: 'Model request rate limit reached',
  other: 'Model request temporarily failed',
};

/** 只拥有重试事实，不调度请求；失败信息由稳定分类产生，避免复制原始响应。 */
export class LlmRetryEpisode {
  private state?: LlmRetryState;
  private ended = false;

  constructor(
    readonly id: string,
    private readonly emit?: (event: AnyAgentEvent) => void,
  ) {}

  get activeId(): string | undefined { return this.state ? this.id : undefined; }

  waiting(params: Pick<LlmRetryState, 'category' | 'attempt' | 'max_retries' | 'total_attempts' | 'error_code'>, delay: number): void {
    const now = Date.now();
    this.state = {
      ...params,
      retry_id: this.id,
      status: 'waiting',
      started_at: this.state?.started_at ?? now,
      delay_ms: delay,
      next_retry_at: now + delay,
      error: SAFE_RETRY_MESSAGES[params.category],
    };
    this.publish();
  }

  retrying(totalAttempts: number): void {
    if (!this.state || this.ended) return;
    const { next_retry_at: ignored, ...state } = this.state;
    this.state = { ...state, status: 'retrying', total_attempts: totalAttempts, delay_ms: 0 };
    this.publish();
  }

  finish(
    status: 'succeeded' | 'exhausted' | 'failed' | 'cancelled',
    failure?: Pick<LlmRetryState, 'category' | 'attempt' | 'max_retries' | 'total_attempts' | 'error_code'>,
  ): void {
    if (!this.state || this.ended) return;
    this.ended = true;
    const { next_retry_at: ignored, ...state } = this.state;
    this.state = { ...state, ...failure, status, delay_ms: 0, ...(failure ? { error: SAFE_RETRY_MESSAGES[failure.category] } : {}) };
    this.publish();
  }

  private publish(): void {
    if (!this.state) return;
    this.emit?.({ type: 'llm_retry', id: generateRuntimeEventId(), timestamp: Date.now(), ...this.state });
  }
}
