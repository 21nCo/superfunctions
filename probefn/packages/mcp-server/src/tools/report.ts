import { z } from 'zod';

import type { JsonObject } from '@probefn/contracts';

import {
  defineTool,
  exportSessionReport,
  jsonToolSchema,
  runFlow,
  strictObjectSchema,
  type ToolDefinition,
} from '../server.js';

const reportExportSchema = strictObjectSchema({
  sessionId: z.string().trim().min(1),
  format: z.enum(['json', 'markdown']).default('json'),
});

const flowSchema = strictObjectSchema({
  sessionId: z.string().trim().min(1),
  file: z.string().trim().min(1),
});

export function getReportTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'probefn_report_export',
      description: 'Export a session report in JSON or Markdown format.',
      inputSchema: jsonToolSchema({
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
          format: { type: 'string', enum: ['json', 'markdown'] },
        },
      }),
      schema: reportExportSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return exportSessionReport(context.runtime, {
          sessionId: String(args.sessionId),
          format: (args.format as 'json' | 'markdown') ?? 'json',
        });
      },
    }),
    defineTool({
      name: 'probefn_run_flow',
      description: 'Execute a repo-relative flow file against an active session.',
      inputSchema: jsonToolSchema({
        required: ['sessionId', 'file'],
        properties: {
          sessionId: { type: 'string' },
          file: { type: 'string' },
        },
      }),
      schema: flowSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return runFlow(context.runtime, {
          sessionId: String(args.sessionId),
          file: String(args.file),
        });
      },
    }),
  ];
}
