import { createRouter } from '../../../../packages/http/src/router.js';
import type { Route } from '../../../../packages/http/src/types.js';
import { z } from 'zod';
import type { IMemoryFn } from '../core/config';
import { requireScope, MemorySourceLimitError, type MemoryScope } from '../storage/adapter';

const MEMORY_TYPES = ['profile_static', 'profile_dynamic', 'conversational', 'procedural', 'document', 'derived'] as const;
/** Errors upsertDocument and forgetBySource raise for caller input the schema cannot see. */
const DOCUMENT_INPUT_ERRORS = new Set(['MEMORY_SCOPE_REQUIRED', 'MEMORY_SOURCE_KEY_REQUIRED', 'MEMORY_SOURCE_HASH_REQUIRED',
  'MEMORY_CONTENT_REQUIRED', 'MEMORY_CHUNKING_INVALID', 'MEMORY_SOURCE_CHUNK_INVALID']);

/** Maps a caller-input failure of a document call to 400 or 413; anything else reaches the router's error handler. */
async function documentCall(call: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await call());
  } catch (error) {
    if (error instanceof MemorySourceLimitError) return Response.json({ error: error.code }, { status: 413 });
    if (error instanceof Error && DOCUMENT_INPUT_ERRORS.has(error.message)) return Response.json({ error: 'INVALID_INPUT', code: error.message }, { status: 400 });
    throw error;
  }
}

/** The host authenticates on every request; caller JSON cannot choose its tenant. */
export function createMemoryRouter(memory: IMemoryFn, options: {
  authorize(request: Request): Promise<MemoryScope | null>;
  maxBodyBytes?: number;
}) {
  const tags = z.array(z.string().min(1)).default([]);
  const add = z.object({ content: z.string().min(1), containerTags: tags, metadata: z.record(z.unknown()).optional() }).strict();
  const search = z.object({ q: z.string().min(1), containerTags: tags, filters: z.record(z.unknown()).optional(), limit: z.number().int().min(1).max(100).optional(), threshold: z.number().min(-1).max(1).optional() }).strict();
  const source = { sourceKey: z.string().min(1), containerTags: tags };
  const upsert = z.object({
    ...source, content: z.string().min(1), contentHash: z.string().min(1).optional(), metadata: z.record(z.unknown()).optional(),
    type: z.enum(MEMORY_TYPES).optional(), extract: z.boolean().optional(),
    chunking: z.object({ targetChars: z.number().int().optional(), overlapChars: z.number().int().optional() }).strict().optional(),
  }).strict();
  const forget = z.object(source).strict();
  /** Authorizes the request and parses its body exactly as the memory routes do. */
  const scoped = async <T>(request: Request, json: () => Promise<unknown>, schema: z.ZodType<T, z.ZodTypeDef, unknown>):
    Promise<{ response: Response } | { scope: MemoryScope; data: T }> => {
    const scope = await options.authorize(request);
    if (!scope) return { response: Response.json({ error: 'UNAUTHORIZED' }, { status: 401 }) };
    requireScope(scope.tenantId, scope.containerTags);
    const input = schema.safeParse(await json());
    if (!input.success) return { response: Response.json({ error: 'INVALID_INPUT' }, { status: 400 }) };
    return { scope, data: input.data };
  };
  const routes: Route[] = [
    { method: 'POST', path: '/v1/memories', handler: async (request, ctx) => {
      const scope = await options.authorize(request);
      if (!scope) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
      requireScope(scope.tenantId, scope.containerTags);
      const input = add.safeParse(await ctx.json());
      if (!input.success) return Response.json({ error: 'INVALID_INPUT' }, { status: 400 });
      return Response.json(await memory.add({ ...input.data, tenantId: scope.tenantId, containerTags: [...scope.containerTags, ...input.data.containerTags] }));
    } },
    { method: 'POST', path: '/v1/memories/search', handler: async (request, ctx) => {
      const scope = await options.authorize(request);
      if (!scope) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
      requireScope(scope.tenantId, scope.containerTags);
      const input = search.safeParse(await ctx.json());
      if (!input.success) return Response.json({ error: 'INVALID_INPUT' }, { status: 400 });
      return Response.json(await memory.search({ ...input.data, tenantId: scope.tenantId, containerTags: [...scope.containerTags, ...input.data.containerTags] }));
    } },
    // A source is its exact tag set: the trusted host tags plus the body tags, so DELETE must repeat the PUT's tags.
    { method: 'PUT', path: '/v1/documents', handler: async (request, ctx) => {
      const parsed = await scoped(request, () => ctx.json(), upsert);
      if ('response' in parsed) return parsed.response;
      const { scope, data } = parsed;
      return documentCall(() => memory.upsertDocument({ ...data, tenantId: scope.tenantId, containerTags: [...scope.containerTags, ...data.containerTags] }));
    } },
    { method: 'DELETE', path: '/v1/documents', handler: async (request, ctx) => {
      const parsed = await scoped(request, () => ctx.json(), forget);
      if ('response' in parsed) return parsed.response;
      const { scope, data } = parsed;
      return documentCall(() => memory.forgetBySource({ ...data, tenantId: scope.tenantId, containerTags: [...scope.containerTags, ...data.containerTags] }));
    } },
  ];
  return createRouter({ routes, maxBodyBytes: options.maxBodyBytes ?? 1024 * 1024 });
}
