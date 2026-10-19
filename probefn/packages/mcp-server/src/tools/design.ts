import { strictObjectSchema } from '../schema.js';
import { z } from 'zod';

import type { JsonObject } from '@probefn/contracts';

import {
  auditDesign,
  defineTool,
  jsonToolSchema,
  type ToolDefinition,
} from '../server.js';

const designAuditSchema = strictObjectSchema({
  sessionId: z.string().trim().min(1),
  checkpointId: z.string().trim().min(1),
  configPath: z.string().trim().min(1).optional(),
});

export function getDesignTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'probefn_page_design_audit',
      description: 'Run the design analyzer against a stored checkpoint bundle.',
      inputSchema: jsonToolSchema({
        required: ['sessionId', 'checkpointId'],
        properties: {
          sessionId: { type: 'string' },
          checkpointId: { type: 'string' },
          configPath: { type: 'string' },
        },
      }),
      schema: designAuditSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return auditDesign(context.runtime, {
          sessionId: String(args.sessionId),
          checkpointId: String(args.checkpointId),
          ...(typeof args.configPath === 'string' ? { configPath: args.configPath } : {}),
        });
      },
    }),
  ];
}
