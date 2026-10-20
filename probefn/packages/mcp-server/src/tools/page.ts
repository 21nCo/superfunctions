import { strictObjectSchema } from '../schema.js';
import { z } from 'zod';

import type { JsonObject } from '@probefn/contracts';

import {
  actOnPage,
  defineTool,
  findPageElement,
  getConsoleEvents,
  getLayoutReport,
  getNetworkEvents,
  getPageErrors,
  jsonToolSchema,
  openPage,
  type ToolDefinition,
} from '../server.js';

const pageOpenSchema = strictObjectSchema({
  sessionId: z.string().trim().min(1),
  url: z.string().trim().min(1),
});

const pageFindSchema = strictObjectSchema({
  sessionId: z.string().trim().min(1),
  query: z.string().trim().min(1),
});

const pageActSchema = strictObjectSchema({
  sessionId: z.string().trim().min(1),
  action: z.enum(['click', 'fill', 'select', 'hover', 'press']),
  query: z.string().trim().min(1).optional(),
  selector: z.string().trim().min(1).optional(),
  value: z.string().optional(),
  key: z.string().optional(),
  requireDomConfirmation: z.boolean().optional(),
});

const pageEventsSchema = strictObjectSchema({
  sessionId: z.string().trim().min(1),
  limit: z.number().int().min(1).max(1000).optional(),
  cursor: z.string().min(1).max(8192).optional(),
});

const pageLayoutSchema = strictObjectSchema({
  sessionId: z.string().trim().min(1),
  checkpointId: z.string().trim().min(1),
});

export function getPageTools(): ToolDefinition[] {
  return [
    defineTool({
      name: 'probefn_page_open',
      description: 'Open a new page URL inside an existing Probefn session.',
      inputSchema: jsonToolSchema({
        required: ['sessionId', 'url'],
        properties: {
          sessionId: { type: 'string' },
          url: { type: 'string' },
        },
      }),
      schema: pageOpenSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return openPage(context.runtime, {
          sessionId: String(args.sessionId),
          url: String(args.url),
        });
      },
    }),
    defineTool({
      name: 'probefn_page_find',
      description: 'Resolve a semantic target on the active page.',
      inputSchema: jsonToolSchema({
        required: ['sessionId', 'query'],
        properties: {
          sessionId: { type: 'string' },
          query: { type: 'string' },
        },
      }),
      schema: pageFindSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return findPageElement(context.runtime, {
          sessionId: String(args.sessionId),
          query: String(args.query),
        });
      },
    }),
    defineTool({
      name: 'probefn_page_act',
      description: 'Perform an action on the active page.',
      inputSchema: jsonToolSchema({
        required: ['sessionId', 'action'],
        properties: {
          sessionId: { type: 'string' },
          action: { type: 'string', enum: ['click', 'fill', 'select', 'hover', 'press'] },
          query: { type: 'string' },
          selector: { type: 'string' },
          value: { type: 'string' },
          key: { type: 'string' },
          requireDomConfirmation: { type: 'boolean' },
        },
      }),
      schema: pageActSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return actOnPage(context.runtime, {
          sessionId: String(args.sessionId),
          action: args.action as 'click' | 'fill' | 'select' | 'hover' | 'press',
          ...(typeof args.query === 'string' ? { query: args.query } : {}),
          ...(typeof args.selector === 'string' ? { selector: args.selector } : {}),
          ...(typeof args.value === 'string' ? { value: args.value } : {}),
          ...(typeof args.key === 'string' ? { key: args.key } : {}),
          ...(typeof args.requireDomConfirmation === 'boolean'
            ? { requireDomConfirmation: args.requireDomConfirmation }
            : {}),
        });
      },
    }),
    defineTool({
      name: 'probefn_page_get_console',
      description: 'Read a bounded console page (default 100 events). Follow nextCursor until null for complete traversal.',
      inputSchema: jsonToolSchema({
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 1000 },
          cursor: { type: 'string', minLength: 1, maxLength: 8192 },
        },
      }),
      schema: pageEventsSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return getConsoleEvents(context.runtime, String(args.sessionId), { ...(typeof args.limit === 'number' ? { limit: args.limit } : {}), ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}) });
      },
    }),
    defineTool({
      name: 'probefn_page_get_network',
      description: 'Read a bounded network page (default 100 events). Follow nextCursor until null for complete traversal.',
      inputSchema: jsonToolSchema({
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 1000 },
          cursor: { type: 'string', minLength: 1, maxLength: 8192 },
        },
      }),
      schema: pageEventsSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return getNetworkEvents(context.runtime, String(args.sessionId), { ...(typeof args.limit === 'number' ? { limit: args.limit } : {}), ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}) });
      },
    }),
    defineTool({
      name: 'probefn_page_get_page_errors',
      description: 'Read a bounded page-error page (default 100 events). Follow nextCursor until null for complete traversal.',
      inputSchema: jsonToolSchema({
        required: ['sessionId'],
        properties: {
          sessionId: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: 1000 },
          cursor: { type: 'string', minLength: 1, maxLength: 8192 },
        },
      }),
      schema: pageEventsSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return getPageErrors(context.runtime, String(args.sessionId), { ...(typeof args.limit === 'number' ? { limit: args.limit } : {}), ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}) });
      },
    }),
    defineTool({
      name: 'probefn_page_get_layout_report',
      description: 'Read the layout snapshot for a previously captured checkpoint.',
      inputSchema: jsonToolSchema({
        required: ['sessionId', 'checkpointId'],
        properties: {
          sessionId: { type: 'string' },
          checkpointId: { type: 'string' },
        },
      }),
      schema: pageLayoutSchema as z.ZodType<JsonObject>,
      async execute(args, context) {
        return getLayoutReport(context.runtime, {
          sessionId: String(args.sessionId),
          checkpointId: String(args.checkpointId),
        });
      },
    }),
  ];
}
