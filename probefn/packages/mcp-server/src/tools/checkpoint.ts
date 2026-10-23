import { strictObjectSchema } from '../schema.js';
import { z } from 'zod';

import type { JsonObject } from '@probefn/contracts';

import {
  createCheckpointFromSession,
  defineTool,
  jsonToolSchema,
  type ToolDefinition,
} from '../server.js';

const checkpointSchema = strictObjectSchema({
  sessionId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  artifactCapBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  includeTrace: z.boolean().optional(),
  includeStyles: z.boolean().optional(),
  includeVideo: z.boolean().optional(),
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
          artifactCapBytes: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          includeTrace: { type: 'boolean' },
          includeStyles: { type: 'boolean' },
          includeVideo: { type: 'boolean' },
        },
      }),
      schema: checkpointSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return createCheckpointFromSession(context.runtime, {
          sessionId: String(args.sessionId),
          name: String(args.name),
          ...(typeof args.artifactCapBytes === 'number' ? { artifactCapBytes: args.artifactCapBytes } : {}),
          ...(typeof args.includeVideo === 'boolean' ? { includeVideo: args.includeVideo } : {}),
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
