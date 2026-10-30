import { z } from 'zod';

/** Zod 4 不再接受 parse 的 path 参数；保留调用边界的字段定位，不改变接纳规则。 */
export function parseSchemaAtPath<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  path: readonly (string | number)[],
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new z.ZodError(result.error.issues.map(issue => ({
    ...issue,
    path: [...path, ...issue.path],
  })));
}
