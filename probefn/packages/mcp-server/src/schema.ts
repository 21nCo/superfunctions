import { z } from 'zod';

export function strictObjectSchema<TShape extends z.ZodRawShape>(
  shape: TShape,
) {
  return z.strictObject(shape);
}

