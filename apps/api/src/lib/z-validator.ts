import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';

type SupportedTarget = 'json' | 'query' | 'param';

export function zValidator<TSchema extends z.ZodTypeAny>(
  target: SupportedTarget,
  schema: TSchema,
): MiddlewareHandler {
  return async (c, next) => {
    const value = target === 'json'
      ? await c.req.json().catch(() => null)
      : target === 'query'
        ? c.req.query()
        : c.req.param();

    const result = schema.safeParse(value);
    if (!result.success) {
      throw new HTTPException(400, {
        message: result.error.issues.map((issue) => issue.message).join('; '),
      });
    }

    (c.req as unknown as { addValidatedData: (target: SupportedTarget, data: z.infer<TSchema>) => void })
      .addValidatedData(target, result.data);

    await next();
  };
}
