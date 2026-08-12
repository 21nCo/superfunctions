import { hashString, resolveExtensions, type MdfnExtension, type MdfnSidecar } from "@mdfn/core";
import { parseMarkdown, type MarkdownOptions } from "@mdfn/markdown";
import { wrapWithSchema, type Adapter, type TableSchema } from "@superfunctions/db";
import { createRouter, type Router } from "@superfunctions/http";

const DOCUMENTS = "mdfnDocuments";
const VERSIONS = "mdfnVersions";
const RECEIPTS = "mdfnReceipts";
const COLLAB_UPDATES = "mdfnCollaborationUpdates";
export const MDFN_SERVER_SCHEMA_VERSION = 1;

export interface MdfnPrincipal { readonly id: string; readonly tenantId?: string; readonly roles?: readonly string[]; }
export type MdfnServerAction = "create" | "read" | "update" | "delete" | "history" | "collaborate";

export interface MdfnDocumentRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly tenantId?: string;
  readonly title?: string;
  readonly markdown: string;
  readonly sourceHash: string;
  readonly schemaHash: string;
  readonly sidecar?: MdfnSidecar;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MdfnVersionRecord extends MdfnDocumentRecord { readonly documentId: string; readonly authorId: string; readonly changeSource: string; }

export interface MdfnServerConfig {
  readonly database: Adapter;
  readonly authorize: (action: MdfnServerAction, principal: MdfnPrincipal, document?: MdfnDocumentRecord) => boolean | Promise<boolean>;
  readonly resolvePrincipal?: (request: Request) => MdfnPrincipal | Promise<MdfnPrincipal>;
  readonly extensions?: readonly MdfnExtension[];
  readonly markdown?: MarkdownOptions;
  readonly basePath?: string;
  readonly createId?: () => string;
  readonly maxCollaborationUpdateBytes?: number;
}

export class MdfnServerError extends Error {
  constructor(readonly code: string, readonly status: number, message = code) { super(message); this.name = "MdfnServerError"; }
}

export function getSchema(): { version: number; schemas: TableSchema[] } {
  const date = { type: "date" as const, required: true, dateValueType: "date" as const };
  return { version: MDFN_SERVER_SCHEMA_VERSION, schemas: [
    { modelName: DOCUMENTS, fields: { id: { type: "string", required: true }, ownerId: { type: "string", required: true }, tenantId: { type: "string" }, title: { type: "string" }, markdown: { type: "string", required: true }, sourceHash: { type: "string", required: true }, schemaHash: { type: "string", required: true }, sidecar: { type: "json" }, version: { type: "number", required: true }, createdAt: date, updatedAt: date }, indexes: [{ name: "idx_mdfn_documents_owner", fields: ["ownerId"] }, { name: "idx_mdfn_documents_tenant", fields: ["tenantId"] }] },
    { modelName: VERSIONS, fields: { id: { type: "string", required: true }, documentId: { type: "string", required: true }, ownerId: { type: "string", required: true }, tenantId: { type: "string" }, title: { type: "string" }, markdown: { type: "string", required: true }, sourceHash: { type: "string", required: true }, schemaHash: { type: "string", required: true }, sidecar: { type: "json" }, version: { type: "number", required: true }, authorId: { type: "string", required: true }, changeSource: { type: "string", required: true }, createdAt: date, updatedAt: date }, indexes: [{ name: "idx_mdfn_versions_document_version", fields: ["documentId", "version"], unique: true }] },
    { modelName: RECEIPTS, fields: { id: { type: "string", required: true }, documentId: { type: "string", required: true }, idempotencyKey: { type: "string", required: true }, result: { type: "json", required: true }, createdAt: date }, indexes: [{ name: "idx_mdfn_receipts_key", fields: ["documentId", "idempotencyKey"], unique: true }] },
    { modelName: COLLAB_UPDATES, fields: { id: { type: "string", required: true }, documentId: { type: "string", required: true }, authorId: { type: "string", required: true }, update: { type: "string", required: true }, createdAt: date }, indexes: [{ name: "idx_mdfn_collab_document", fields: ["documentId", "createdAt"] }] },
  ] };
}

export interface MdfnService {
  create(principal: MdfnPrincipal, input: { readonly id?: string; readonly title?: string; readonly markdown: string; readonly sidecar?: MdfnSidecar }): Promise<MdfnDocumentRecord>;
  read(principal: MdfnPrincipal, id: string): Promise<MdfnDocumentRecord>;
  list(principal: MdfnPrincipal, options?: { readonly limit?: number; readonly offset?: number }): Promise<readonly MdfnDocumentRecord[]>;
  update(principal: MdfnPrincipal, id: string, input: { readonly expectedVersion: number; readonly markdown?: string; readonly title?: string; readonly sidecar?: MdfnSidecar; readonly changeSource?: string; readonly idempotencyKey?: string }): Promise<MdfnDocumentRecord>;
  delete(principal: MdfnPrincipal, id: string): Promise<void>;
  versions(principal: MdfnPrincipal, id: string): Promise<readonly MdfnVersionRecord[]>;
  version(principal: MdfnPrincipal, id: string, version: number): Promise<MdfnVersionRecord>;
  appendCollaborationUpdate(principal: MdfnPrincipal, id: string, update: string): Promise<string>;
  collaborationUpdates(principal: MdfnPrincipal, id: string): Promise<readonly string[]>;
}

async function allowed(config: MdfnServerConfig, action: MdfnServerAction, principal: MdfnPrincipal, document?: MdfnDocumentRecord): Promise<void> {
  if (!(await config.authorize(action, principal, document))) throw new MdfnServerError("MDFN_FORBIDDEN", 403);
}

function whereId(id: string) { return [{ field: "id", operator: "eq" as const, value: id }]; }

export function createMdfnService(config: MdfnServerConfig): MdfnService {
  const database = wrapWithSchema(config.database, getSchema());
  const registry = resolveExtensions(config.extensions ?? []);
  const markdownOptions: MarkdownOptions = { ...config.markdown, extensions: registry };
  const createId = config.createId ?? (() => crypto.randomUUID());
  const parse = (source: string): void => { parseMarkdown(source, markdownOptions); };
  const load = async (id: string): Promise<MdfnDocumentRecord> => {
    const result = await database.findOne<MdfnDocumentRecord>({ model: DOCUMENTS, where: whereId(id) });
    if (!result) throw new MdfnServerError("MDFN_DOCUMENT_NOT_FOUND", 404);
    return result;
  };
  const loadScoped = async (principal: MdfnPrincipal, id: string): Promise<MdfnDocumentRecord> => {
    const document = await load(id);
    const inScope = principal.tenantId
      ? document.tenantId === principal.tenantId
      : document.tenantId === undefined && document.ownerId === principal.id;
    if (!inScope) throw new MdfnServerError("MDFN_DOCUMENT_NOT_FOUND", 404);
    return document;
  };
  const revision = (document: MdfnDocumentRecord, authorId: string, changeSource: string): MdfnVersionRecord => ({ ...document, id: `${document.id}:${document.version}`, documentId: document.id, authorId, changeSource });
  type Storage = Pick<Adapter, "create" | "findOne" | "update">;
  const withStorage = <T>(callback: (storage: Storage) => Promise<T>): Promise<T> => database.capabilities.transactions.supported
    ? database.transaction((transaction) => callback(transaction))
    : callback(database);
  return {
    async create(principal, input) {
      await allowed(config, "create", principal);
      parse(input.markdown);
      const now = new Date();
      const document: MdfnDocumentRecord = { id: input.id ?? createId(), ownerId: principal.id, tenantId: principal.tenantId, title: input.title, markdown: input.markdown, sourceHash: hashString(input.markdown), schemaHash: registry.schemaHash, sidecar: input.sidecar, version: 1, createdAt: now, updatedAt: now };
      return withStorage(async (storage) => {
        const created = await storage.create<MdfnDocumentRecord>({ model: DOCUMENTS, data: document });
        await storage.create({ model: VERSIONS, data: revision(created, principal.id, "create") });
        return created;
      });
    },
    async read(principal, id) { const document = await loadScoped(principal, id); await allowed(config, "read", principal, document); return document; },
    async list(principal, options = {}) {
      await allowed(config, "read", principal);
      const where = principal.tenantId ? [{ field: "tenantId", operator: "eq" as const, value: principal.tenantId }] : [{ field: "ownerId", operator: "eq" as const, value: principal.id }];
      return database.findMany<MdfnDocumentRecord>({ model: DOCUMENTS, where, limit: Math.min(100, Math.max(1, options.limit ?? 50)), offset: Math.max(0, options.offset ?? 0), orderBy: [{ field: "updatedAt", direction: "desc" }] });
    },
    async update(principal, id, input) {
      const current = await loadScoped(principal, id);
      await allowed(config, "update", principal, current);
      if (input.idempotencyKey) {
        const receipt = await database.findOne<{ result: MdfnDocumentRecord }>({ model: RECEIPTS, where: [{ field: "documentId", operator: "eq", value: id }, { field: "idempotencyKey", operator: "eq", value: input.idempotencyKey }] });
        if (receipt) return receipt.result;
      }
      if (current.version !== input.expectedVersion) throw new MdfnServerError("MDFN_VERSION_CONFLICT", 409);
      const markdown = input.markdown ?? current.markdown;
      parse(markdown);
      const next: MdfnDocumentRecord = { ...current, title: input.title ?? current.title, markdown, sourceHash: hashString(markdown), schemaHash: registry.schemaHash, sidecar: input.sidecar ?? current.sidecar, version: current.version + 1, updatedAt: new Date() };
      return withStorage(async (storage) => {
        const latest = await storage.findOne<MdfnDocumentRecord>({ model: DOCUMENTS, where: whereId(id) });
        if (!latest || latest.version !== input.expectedVersion) throw new MdfnServerError("MDFN_VERSION_CONFLICT", 409);
        const updated = await storage.update<MdfnDocumentRecord>({ model: DOCUMENTS, where: [{ field: "id", operator: "eq", value: id }, { field: "version", operator: "eq", value: input.expectedVersion }], data: next });
        await storage.create({ model: VERSIONS, data: revision(updated, principal.id, input.changeSource ?? "update") });
        if (input.idempotencyKey) await storage.create({ model: RECEIPTS, data: { id: createId(), documentId: id, idempotencyKey: input.idempotencyKey, result: updated, createdAt: new Date() } });
        return updated;
      });
    },
    async delete(principal, id) { const current = await loadScoped(principal, id); await allowed(config, "delete", principal, current); await database.delete({ model: DOCUMENTS, where: whereId(id) }); },
    async versions(principal, id) { const document = await loadScoped(principal, id); await allowed(config, "history", principal, document); return database.findMany<MdfnVersionRecord>({ model: VERSIONS, where: [{ field: "documentId", operator: "eq", value: id }], orderBy: [{ field: "version", direction: "desc" }] }); },
    async version(principal, id, version) { const document = await loadScoped(principal, id); await allowed(config, "history", principal, document); const result = await database.findOne<MdfnVersionRecord>({ model: VERSIONS, where: [{ field: "documentId", operator: "eq", value: id }, { field: "version", operator: "eq", value: version }] }); if (!result) throw new MdfnServerError("MDFN_VERSION_NOT_FOUND", 404); return result; },
    async appendCollaborationUpdate(principal, id, update) { const document = await loadScoped(principal, id); await allowed(config, "collaborate", principal, document); const limit = config.maxCollaborationUpdateBytes ?? 1024 * 1024; if (new TextEncoder().encode(update).byteLength > limit) throw new MdfnServerError("MDFN_COLLAB_UPDATE_TOO_LARGE", 413); const updateId = createId(); await database.create({ model: COLLAB_UPDATES, data: { id: updateId, documentId: id, authorId: principal.id, update, createdAt: new Date() } }); return updateId; },
    async collaborationUpdates(principal, id) { const document = await loadScoped(principal, id); await allowed(config, "collaborate", principal, document); const rows = await database.findMany<{ update: string }>({ model: COLLAB_UPDATES, where: [{ field: "documentId", operator: "eq", value: id }], orderBy: [{ field: "createdAt", direction: "asc" }] }); return rows.map((row) => row.update); },
  };
}

function etag(document: MdfnDocumentRecord): string { return `\"mdfn-${document.version}-${document.sourceHash}\"`; }
function response(document: MdfnDocumentRecord, status = 200): Response { return Response.json(document, { status, headers: { ETag: etag(document), "Cache-Control": "no-store" } }); }

export function createMdfnRouter(config: MdfnServerConfig, service = createMdfnService(config)): Router<{ principal: MdfnPrincipal }> {
  const principal = config.resolvePrincipal ?? (() => { throw new MdfnServerError("MDFN_UNAUTHENTICATED", 401); });
  return createRouter({
    basePath: config.basePath ?? "/api/mdfn",
    context: async (request) => ({ principal: await principal(request) }),
    onError: (error) => error instanceof MdfnServerError ? Response.json({ error: error.code }, { status: error.status }) : Response.json({ error: "MDFN_INTERNAL_ERROR" }, { status: 500 }),
    routes: [
      { method: "GET", path: "/documents", handler: (_request, context) => service.list(context.principal, { limit: Number(context.query.get("limit") ?? 50), offset: Number(context.query.get("offset") ?? 0) }).then((documents) => Response.json({ documents })) },
      { method: "POST", path: "/documents", handler: async (_request, context) => response(await service.create(context.principal, await context.json()), 201) },
      { method: "GET", path: "/documents/:id", handler: async (_request, context) => response(await service.read(context.principal, context.params.id!)) },
      { method: "PATCH", path: "/documents/:id", handler: async (_request, context) => response(await service.update(context.principal, context.params.id!, await context.json())) },
      { method: "DELETE", path: "/documents/:id", handler: async (_request, context) => { await service.delete(context.principal, context.params.id!); return new Response(null, { status: 204 }); } },
      { method: "GET", path: "/documents/:id/versions", handler: async (_request, context) => Response.json({ versions: await service.versions(context.principal, context.params.id!) }) },
      { method: "GET", path: "/documents/:id/versions/:version", handler: async (_request, context) => Response.json(await service.version(context.principal, context.params.id!, Number(context.params.version))) },
      { method: "GET", path: "/documents/:id/sidecar", handler: async (_request, context) => Response.json((await service.read(context.principal, context.params.id!)).sidecar ?? {}) },
      { method: "PUT", path: "/documents/:id/sidecar", handler: async (_request, context) => { const body = await context.json<{ expectedVersion: number; sidecar: MdfnSidecar }>(); return response(await service.update(context.principal, context.params.id!, { ...body, changeSource: "sidecar" })); } },
      { method: "GET", path: "/documents/:id/collaboration-updates", handler: async (_request, context) => Response.json({ updates: await service.collaborationUpdates(context.principal, context.params.id!) }) },
      { method: "POST", path: "/documents/:id/collaboration-updates", handler: async (_request, context) => { const body = await context.json<{ update: string }>(); return Response.json({ id: await service.appendCollaborationUpdate(context.principal, context.params.id!, body.update) }, { status: 201 }); } },
    ],
  });
}

export function createMdfnServer(config: MdfnServerConfig): { readonly service: MdfnService; readonly router: Router<{ principal: MdfnPrincipal }>; readonly schema: ReturnType<typeof getSchema> } {
  const service = createMdfnService(config);
  return { service, router: createMdfnRouter(config, service), schema: getSchema() };
}

export const MDFN_SERVER_VERSION = "0.1.0" as const;
