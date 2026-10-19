import { strictObjectSchema } from '../schema.js';
import { z } from 'zod';

import type { JsonObject } from '@probefn/contracts';

import {
  compareVisualBaseline,
  defineTool,
  jsonToolSchema,
  recordVisualBaseline,
  type ToolDefinition,
} from '../server.js';

const baselineSchema = strictObjectSchema({
  sessionId: z.string().trim().min(1),
  checkpointId: z.string().trim().min(1),
  key: z.string().trim().min(1),
  configPath: z.string().trim().min(1).optional(),
});

export function getBaselineTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'probefn_baseline_record',
      description: 'Record a checkpoint as the baseline for a deterministic key.',
      inputSchema: jsonToolSchema({
        required: ['sessionId', 'checkpointId', 'key'],
        properties: {
          sessionId: { type: 'string' },
          checkpointId: { type: 'string' },
          key: { type: 'string' },
          configPath: { type: 'string' },
        },
      }),
      schema: baselineSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return recordVisualBaseline(context.runtime, {
          sessionId: String(args.sessionId),
          checkpointId: String(args.checkpointId),
          key: String(args.key),
          ...(typeof args.configPath === 'string' ? { configPath: args.configPath } : {}),
        });
      },
    }),
    defineTool({
      name: 'probefn_baseline_compare',
      description: 'Compare a checkpoint against a previously recorded baseline.',
      inputSchema: jsonToolSchema({
        required: ['sessionId', 'checkpointId', 'key'],
        properties: {
          sessionId: { type: 'string' },
          checkpointId: { type: 'string' },
          key: { type: 'string' },
          configPath: { type: 'string' },
        },
      }),
      schema: baselineSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return compareVisualBaseline(context.runtime, {
          sessionId: String(args.sessionId),
          checkpointId: String(args.checkpointId),
          key: String(args.key),
          ...(typeof args.configPath === 'string' ? { configPath: args.configPath } : {}),
        });
      },
    }),
  ];
}
