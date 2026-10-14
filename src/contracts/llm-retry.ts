import { z } from 'zod';
import { TraceIdSchema } from './identity';

/** 失败原因控制重试预算；不包含任何 Host 或供应商语义。 */
export const LlmRetryCategory = z.enum(['transport', 'output', 'rate_limit', 'other']);
export type LlmRetryCategory = z.infer<typeof LlmRetryCategory>;

/** 一次 LLM 调用内的重试事实。每次状态变化独立持久化，UI 按 retry_id 合并。 */
export const LlmRetryState = z.object({
  retry_id: TraceIdSchema,
  status: z.enum(['waiting', 'retrying', 'succeeded', 'exhausted', 'failed', 'cancelled']),
  category: LlmRetryCategory,
  attempt: z.number().int().nonnegative(),
  max_retries: z.number().int().nonnegative(),
  total_attempts: z.number().int().positive(),
  started_at: z.number().finite(),
  delay_ms: z.number().finite().nonnegative(),
  next_retry_at: z.number().finite().optional(),
  /** 安全分类说明；不得放入供应商响应正文。 */
  error: z.string(),
  error_code: z.string().min(1),
}).strict();
export type LlmRetryState = z.infer<typeof LlmRetryState>;
