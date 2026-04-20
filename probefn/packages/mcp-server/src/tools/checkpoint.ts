import { z } from 'zod';

import type { JsonObject } from '@probefn/contracts';

import {
  createCheckpointFromSession,
  defineTool,
  jsonToolSchema,
  strictObjectSchema,
  type ToolDefinition,
} from '../server.js';

const checkpointSchema = strictObjectSchema({
  sessionId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  includeTrace: z.boolean().optional(),
  includeStyles: z.boolean().optional(),
});

export function getCheckpointTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'probefn_checkpoint_create',
      description: 'Capture a checkpoint for the current session page.',
      inputSchema: jsonToolSchema({
        required: ['sessionId', 'name'],
        properties: {
          sessionId: { type: 'string' },
          name: { type: 'string' },
          includeTrace: { type: 'boolean' },
          includeStyles: { type: 'boolean' },
        },
      }),
      schema: checkpointSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return createCheckpointFromSession(context.runtime, {
          sessionId: String(args.sessionId),
          name: String(args.name),
          ...(typeof args.includeTrace === 'boolean'
            ? { includeTrace: args.includeTrace }
            : {}),
          ...(typeof args.includeStyles === 'boolean'
            ? { includeStyles: args.includeStyles }
            : {}),
        });
      },
    }),
  ];
}
