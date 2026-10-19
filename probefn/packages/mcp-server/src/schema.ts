import { z } from 'zod';

export function strictObjectSchema<TShape extends z.ZodRawShape>(
  shape: TShape,
): z.ZodObject<TShape, 'strict'> {
  return z.object(shape).strict();
}

