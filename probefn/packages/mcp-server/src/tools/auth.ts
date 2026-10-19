import { strictObjectSchema } from '../schema.js';
import { z } from 'zod';

import type { JsonObject } from '@probefn/contracts';

import {
  defineTool,
  jsonToolSchema,
  saveAuthProfile,
  type ToolDefinition,
} from '../server.js';

const authProfileSaveSchema = strictObjectSchema({
  sessionId: z.string().trim().min(1),
  profileId: z.string().trim().min(1),
});

export function getAuthTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'probefn_auth_profile_save',
      description: 'Persist the current session storage state as a reusable auth profile.',
      inputSchema: jsonToolSchema({
        required: ['sessionId', 'profileId'],
        properties: {
          sessionId: { type: 'string' },
          profileId: { type: 'string' },
        },
      }),
      schema: authProfileSaveSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return saveAuthProfile(context.runtime, {
          sessionId: String(args.sessionId),
          profileId: String(args.profileId),
        });
      },
    }),
  ];
}
