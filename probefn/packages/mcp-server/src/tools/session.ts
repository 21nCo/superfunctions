import { strictObjectSchema } from '../schema.js';
import { z } from 'zod';

import type { JsonObject } from '@probefn/contracts';

import {
  defineTool,
  jsonToolSchema,
  startSessionFromConfig,
  stopSession,
  type ToolDefinition,
} from '../server.js';

const sessionStartSchema = strictObjectSchema({
  configPath: z.string().trim().min(1),
  mode: z.enum(['debug', 'design-review', 'visual-regression', 'mixed']).optional(),
  browser: z.enum(['chromium', 'firefox', 'webkit']).optional(),
  devServerName: z.string().trim().min(1).optional(),
  url: z.string().trim().min(1).optional(),
  authProfileId: z.string().trim().min(1).optional(),
  sessionId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
});

const sessionStopSchema = strictObjectSchema({
  sessionId: z.string().trim().min(1),
});

export function getSessionTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'probefn_session_start',
      description: 'Start a Probefn session against a configured or attached dev server.',
      inputSchema: jsonToolSchema({
        required: ['configPath'],
        properties: {
          configPath: { type: 'string' },
          mode: { type: 'string', enum: ['debug', 'design-review', 'visual-regression', 'mixed'] },
          browser: { type: 'string', enum: ['chromium', 'firefox', 'webkit'] },
          devServerName: { type: 'string' },
          url: { type: 'string' },
          authProfileId: { type: 'string' },
          sessionId: { type: 'string' },
          runId: { type: 'string' },
        },
      }),
      schema: sessionStartSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return startSessionFromConfig(context.runtime, {
          configPath: String(args.configPath),
          ...(typeof args.mode === 'string' ? { mode: args.mode as never } : {}),
          ...(typeof args.browser === 'string' ? { browser: args.browser as never } : {}),
          ...(typeof args.devServerName === 'string' ? { devServerName: args.devServerName } : {}),
          ...(typeof args.url === 'string' ? { url: args.url } : {}),
          ...(typeof args.authProfileId === 'string' ? { authProfileId: args.authProfileId } : {}),
          ...(typeof args.sessionId === 'string' ? { sessionId: args.sessionId } : {}),
          ...(typeof args.runId === 'string' ? { runId: args.runId } : {}),
        });
      },
    }),
    defineTool({
      name: 'probefn_session_stop',
      description: 'Stop a Probefn session and finalize its run manifest.',
      inputSchema: jsonToolSchema({
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
        },
      }),
      schema: sessionStopSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return stopSession(context.runtime, String(args.sessionId));
      },
    }),
  ];
}
