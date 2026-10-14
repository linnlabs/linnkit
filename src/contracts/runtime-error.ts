import { z } from 'zod';
import { SerializableJsonValue } from './json';
import { TraceIdSchema } from './identity';

/** 运行失败的安全投影；Provider body/credential 不属于这个合同。 */
export const RuntimeErrorState = z.object({
  error: z.string(),
  error_code: z.string().optional(),
  retryable: z.boolean().optional(),
  retry_id: TraceIdSchema.optional(),
  details: SerializableJsonValue.optional(),
}).strict();
export type RuntimeErrorState = z.infer<typeof RuntimeErrorState>;
