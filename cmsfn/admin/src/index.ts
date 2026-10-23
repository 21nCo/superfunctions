import {
  AdminError,
  createAdminCapabilityAdapter as createKernelAdminCapabilityAdapter,
  createCapabilityAdminClient,
  defineAdminCapability,
  type AdminClient,
  type AdminClientRequestOptions,
  type AdminOperationContext,
} from "@superfunctions/admin";
import type { ContentfnServer } from "@contentfn/server";
import type { CfqlFilter, ContentfnDocument, ContentfnEnvelope, ContentfnPatchOp, ContentfnSchema } from "@contentfn/core";

export interface CmsFnAdminServiceOptions {
  contentfn: ContentfnServer;
  datasetForScope?: (context: AdminOperationContext) => string;
}
export interface DatasetResult { item: { id: string; name: string } }
export interface DatasetListResult { items: Array<{ id: string; name: string }> }
export interface SchemaResult { item: ContentfnSchema }
export interface UpsertSchemaInput { schema: ContentfnSchema }
export interface ListDocumentsInput { types?: string[]; filter?: CfqlFilter; cursor?: string; limit?: number }
export interface DocumentListResult { items: ContentfnDocument[]; nextCursor: string | null }
export interface GetDocumentInput { id: string; perspective?: "published" | "draft" }
export interface DocumentResult { item: ContentfnDocument }
export interface CreateDocumentInput { id?: string; type: string; document: Record<string, unknown>; asDraft?: boolean }
export interface PatchDocumentInput { id: string; ifRev?: string; ops: ContentfnPatchOp[] }
export interface DeleteDocumentInput { id: string; purge?: boolean }
export interface PublishDocumentInput { id: string; ifRev?: string }
export interface ListRevisionsInput { id: string; limit?: number; cursor?: string }
export interface RevisionListResult { items: ContentfnDocument[]; nextCursor: string | null }
export interface RestoreRevisionInput { id: string; rev: string }
export interface MutationResult { completed: true }

const documentSchema = { type: "object", properties: { _id: { type: "string" }, _type: { type: "string" }, _rev: { type: "string" }, _createdAt: { type: "string" }, _updatedAt: { type: "string" }, _publishedAt: { type: "string" } }, required: ["_id", "_type", "_rev", "_createdAt", "_updatedAt"], additionalProperties: true } as const;
const schemaSchema = { type: "object", properties: { version: { type: "integer", minimum: 1 }, documentTypes: { type: "array", items: { type: "object", additionalProperties: true } } }, required: ["version", "documentTypes"], additionalProperties: false } as const;
const documentResultSchema = { type: "object", properties: { item: documentSchema }, required: ["item"], additionalProperties: false } as const;
const completedSchema = { type: "object", properties: { completed: { type: "boolean", const: true } }, required: ["completed"], additionalProperties: false } as const;

const operations = [
  {
    id: "cmsfn.datasets.list", title: "Get active dataset", description: "Return the ContentFn dataset bound to the active administration scope.",
    inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"], additionalProperties: false } } }, required: ["items"], additionalProperties: false },
    route: { method: "GET", path: "/resources/datasets" }, permission: "cmsfn.datasets.read", safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" }, mcp: { readOnlyHint: true }, target: { resource: "datasets", collection: true },
  },
  {
    id: "cmsfn.datasets.create", title: "Create active dataset", description: "Create the ContentFn dataset derived from the active administration scope.",
    inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object", properties: { item: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } }, required: ["id", "name"], additionalProperties: false } }, required: ["item"], additionalProperties: false },
    route: { method: "POST", path: "/resources/datasets" }, permission: "cmsfn.datasets.create", safety: { classification: "write", idempotent: true, requiresConfirmation: false, audit: "required" }, mcp: { readOnlyHint: false, idempotentHint: true }, target: { resource: "datasets", collection: true },
  },
  {
    id: "cmsfn.schemas.get", title: "Get schema", description: "Get the schema for the active ContentFn dataset.",
    inputSchema: { type: "object", additionalProperties: false }, outputSchema: { type: "object", properties: { item: schemaSchema }, required: ["item"], additionalProperties: false },
    route: { method: "GET", path: "/resources/schemas/active" }, permission: "cmsfn.schemas.read", safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" }, mcp: { readOnlyHint: true }, target: { resource: "schemas", collection: true },
  },
  {
    id: "cmsfn.schemas.upsert", title: "Upsert schema", description: "Validate and upsert the schema for the active ContentFn dataset.",
    inputSchema: { type: "object", properties: { schema: schemaSchema }, required: ["schema"], additionalProperties: false }, outputSchema: { type: "object", properties: { item: schemaSchema }, required: ["item"], additionalProperties: false },
    route: { method: "PUT", path: "/resources/schemas/active" }, permission: "cmsfn.schemas.upsert", safety: { classification: "write", idempotent: true, requiresConfirmation: false, audit: "required" }, mcp: { readOnlyHint: false, idempotentHint: true }, target: { resource: "schemas", collection: true },
  },
  {
    id: "cmsfn.documents.list", title: "List documents", description: "Query published documents in the active ContentFn dataset.",
    inputSchema: { type: "object", properties: { types: { type: "array", items: { type: "string" }, maxItems: 100 }, filter: { type: "object", additionalProperties: true }, cursor: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100, default: 50 } }, additionalProperties: false },
    outputSchema: { type: "object", properties: { items: { type: "array", items: documentSchema }, nextCursor: { oneOf: [{ type: "string" }, { type: "null" }] } }, required: ["items", "nextCursor"], additionalProperties: false },
    route: { method: "GET", path: "/resources/documents" }, permission: "cmsfn.documents.read", safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" }, pagination: { mode: "cursor", defaultLimit: 50, maxLimit: 100 }, mcp: { readOnlyHint: true }, target: { resource: "documents", collection: true },
  },
  {
    id: "cmsfn.documents.get", title: "Get document", description: "Get one document from the active ContentFn dataset.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 }, perspective: { type: "string", enum: ["published", "draft"] } }, required: ["id"], additionalProperties: false }, outputSchema: documentResultSchema,
    route: { method: "GET", path: "/resources/documents/:id" }, permission: "cmsfn.documents.read", safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" }, mcp: { readOnlyHint: true }, target: { resource: "documents", idInput: "id" },
  },
  {
    id: "cmsfn.documents.create", title: "Create document", description: "Create a typed ContentFn document in the active dataset.",
    inputSchema: { type: "object", properties: { id: { type: "string" }, type: { type: "string", minLength: 1 }, document: { type: "object", additionalProperties: true }, asDraft: { type: "boolean", default: true } }, required: ["type", "document"], additionalProperties: false }, outputSchema: documentResultSchema,
    route: { method: "POST", path: "/resources/documents" }, permission: "cmsfn.documents.create", safety: { classification: "write", idempotent: true, requiresConfirmation: false, audit: "required" }, mcp: { readOnlyHint: false, idempotentHint: true }, target: { resource: "documents", collection: true },
  },
  {
    id: "cmsfn.documents.patch", title: "Patch document", description: "Apply typed ContentFn patch operations with optional revision precondition.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 }, ifRev: { type: "string" }, ops: { type: "array", items: { type: "object", additionalProperties: true }, minItems: 1, maxItems: 100 } }, required: ["id", "ops"], additionalProperties: false }, outputSchema: documentResultSchema,
    route: { method: "PATCH", path: "/resources/documents/:id" }, permission: "cmsfn.documents.patch", safety: { classification: "write", idempotent: true, requiresConfirmation: false, audit: "required" }, mcp: { readOnlyHint: false, idempotentHint: true }, target: { resource: "documents", idInput: "id" },
  },
  {
    id: "cmsfn.documents.delete", title: "Delete document", description: "Delete a document from the active ContentFn dataset.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 }, purge: { type: "boolean", default: false } }, required: ["id"], additionalProperties: false }, outputSchema: completedSchema,
    route: { method: "DELETE", path: "/resources/documents/:id" }, permission: "cmsfn.documents.delete", safety: { classification: "destructive", idempotent: true, requiresConfirmation: true, confirmation: { risk: "high", method: "recent-auth", reason: "Document deletion can remove published and draft content.", maxAgeSeconds: 600 }, audit: "required" }, mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, target: { resource: "documents", idInput: "id" },
  },
  {
    id: "cmsfn.documents.publish", title: "Publish document", description: "Publish a draft through ContentFn and deliver its events/webhooks.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 }, ifRev: { type: "string" } }, required: ["id"], additionalProperties: false }, outputSchema: documentResultSchema,
    route: { method: "POST", path: "/resources/documents/actions/publish" }, permission: "cmsfn.documents.publish", safety: { classification: "write", idempotent: true, requiresConfirmation: true, confirmation: { risk: "high", method: "explicit", reason: "Publishing changes the public document and delivers configured events or webhooks.", maxAgeSeconds: 300 }, audit: "required" }, mcp: { readOnlyHint: false, idempotentHint: true }, target: { resource: "documents", idInput: "id" },
  },
  {
    id: "cmsfn.documents.unpublish", title: "Unpublish document", description: "Remove a published document from the active ContentFn dataset.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 }, ifRev: { type: "string" } }, required: ["id"], additionalProperties: false }, outputSchema: completedSchema,
    route: { method: "POST", path: "/resources/documents/actions/unpublish" }, permission: "cmsfn.documents.unpublish", safety: { classification: "destructive", idempotent: true, requiresConfirmation: true, confirmation: { risk: "high", method: "explicit", reason: "Unpublishing removes content from the published perspective." }, audit: "required" }, mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }, target: { resource: "documents", idInput: "id" },
  },
  {
    id: "cmsfn.documents.list-revisions", title: "List revisions", description: "List immutable ContentFn revisions for a scoped document.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string" } }, required: ["id"], additionalProperties: false },
    outputSchema: { type: "object", properties: { items: { type: "array", items: documentSchema }, nextCursor: { oneOf: [{ type: "string" }, { type: "null" }] } }, required: ["items", "nextCursor"], additionalProperties: false },
    route: { method: "GET", path: "/resources/documents/:id/revisions" }, permission: "cmsfn.revisions.read", safety: { classification: "read", idempotent: true, requiresConfirmation: false, audit: "optional" }, pagination: { mode: "cursor", maxLimit: 100 }, mcp: { readOnlyHint: true }, target: { resource: "documents", idInput: "id" },
  },
  {
    id: "cmsfn.documents.restore-revision", title: "Restore revision", description: "Restore a ContentFn revision into the draft perspective.",
    inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 }, rev: { type: "string", minLength: 1 } }, required: ["id", "rev"], additionalProperties: false }, outputSchema: documentResultSchema,
    route: { method: "POST", path: "/resources/documents/:id/actions/restore" }, permission: "cmsfn.revisions.restore", safety: { classification: "write", idempotent: true, requiresConfirmation: true, confirmation: { risk: "high", method: "explicit", reason: "Revision restore replaces the active draft state." }, audit: "required" }, mcp: { readOnlyHint: false, idempotentHint: true }, target: { resource: "documents", idInput: "id" },
  },
] as const;

export const cmsFnAdminCapability = defineAdminCapability({
  schemaVersion: "1.0", id: "cmsfn", displayName: "CmsFn", version: "1.1.0",
  description: "CmsFn administration backed directly by the ContentFn programmatic server API.", category: "content",
  availability: "required-product", scopeLevels: ["organization", "workspace", "project", "environment"],
  // ContentFn is the domain implementation behind this adapter, not an independently
  // enabled administration module. Its folded manifest therefore is not a registry dependency.
  dependencies: [],
  resources: [
    { id: "datasets", label: "Dataset", description: "ContentFn dataset bound to the active environment.", icon: "cmsfn:dataset", risk: "standard", idField: "id", displayFields: ["id", "name"] },
    { id: "schemas", label: "Schema", description: "Content model for the active dataset.", icon: "cmsfn:schema", risk: "standard", idField: "version", displayFields: ["version"] },
    { id: "documents", label: "Documents", description: "Draft and published ContentFn documents.", icon: "cmsfn:documents", risk: "standard", idField: "_id", displayFields: ["_id", "_type", "_rev", "_updatedAt"], searchableFields: ["_id", "_type"], filterableFields: ["_type"], sortableFields: ["_updatedAt", "_createdAt"] },
    { id: "revisions", label: "Revisions", description: "Immutable ContentFn document revisions.", icon: "cmsfn:revisions", risk: "standard", idField: "_rev", displayFields: ["_id", "_rev", "_updatedAt"] },
  ],
  navigation: [{ id: "cmsfn", label: "CmsFn", path: "/modules/cmsfn", icon: "cmsfn", order: 40 }],
  operations,
});

function mapDomainError(error: Extract<ContentfnEnvelope<unknown>, { ok: false }>["error"]): AdminError {
  const code = error.code === "AUTH_REQUIRED" ? "unauthenticated"
    : error.code === "PERMISSION_DENIED" ? "forbidden"
    : error.code === "RATE_LIMITED" ? "rate_limited"
    : error.code === "DATASET_NOT_FOUND" || error.code === "SCHEMA_NOT_FOUND" || error.code === "DOCUMENT_NOT_FOUND" || error.code === "ASSET_NOT_FOUND" || error.code === "WEBHOOK_NOT_FOUND" ? "not_found"
    : error.code === "DATASET_ALREADY_EXISTS" || error.code === "SCHEMA_VERSION_CONFLICT" || error.code === "DOCUMENT_ALREADY_EXISTS" || error.code === "REV_CONFLICT" ? "conflict"
    : error.code === "ASSET_UPLOAD_FAILED" || error.code === "WEBHOOK_DELIVERY_FAILED" || error.code === "REALTIME_NOT_AVAILABLE" || error.code === "STORAGE_ERROR" ? "dependency_unavailable"
    : error.code === "INTERNAL_ERROR" ? "internal"
    : "invalid_argument";
  return new AdminError(code, error.message, { details: error.details });
}
async function unwrap<T>(promise: Promise<ContentfnEnvelope<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw mapDomainError(result.error);
  return result.result;
}

export interface CmsFnAdminService {
  listDatasets(context: AdminOperationContext): Promise<DatasetListResult>;
  createDataset(context: AdminOperationContext): Promise<DatasetResult>;
  getSchema(context: AdminOperationContext): Promise<SchemaResult>;
  upsertSchema(input: UpsertSchemaInput, context: AdminOperationContext): Promise<SchemaResult>;
  listDocuments(input: ListDocumentsInput, context: AdminOperationContext): Promise<DocumentListResult>;
  getDocument(input: GetDocumentInput, context: AdminOperationContext): Promise<DocumentResult>;
  createDocument(input: CreateDocumentInput, context: AdminOperationContext): Promise<DocumentResult>;
  patchDocument(input: PatchDocumentInput, context: AdminOperationContext): Promise<DocumentResult>;
  deleteDocument(input: DeleteDocumentInput, context: AdminOperationContext): Promise<MutationResult>;
  publishDocument(input: PublishDocumentInput, context: AdminOperationContext): Promise<DocumentResult>;
  unpublishDocument(input: PublishDocumentInput, context: AdminOperationContext): Promise<MutationResult>;
  listRevisions(input: ListRevisionsInput, context: AdminOperationContext): Promise<RevisionListResult>;
  restoreRevision(input: RestoreRevisionInput, context: AdminOperationContext): Promise<DocumentResult>;
}

export function createCmsFnAdminService(options: CmsFnAdminServiceOptions): CmsFnAdminService {
  const dataset = (context: AdminOperationContext) => {
    const resolver = options.datasetForScope;
    const resolved = resolver ? resolver(context) : context.scope.environmentId;
    if (!resolved) throw new AdminError("forbidden", "The active scope does not resolve to a ContentFn dataset.");
    const value = resolved.trim();
    if (!value) throw new AdminError("forbidden", "The active scope does not resolve to a ContentFn dataset.");
    return value;
  };
  const api = options.contentfn.api;
  return {
    async listDatasets(context) { const name = dataset(context); const all = await unwrap(api.datasets.list()); return { items: all.datasets.includes(name) ? [{ id: name, name }] : [] }; },
    async createDataset(context) { const name = dataset(context); await unwrap(api.datasets.create({ dataset: name })); return { item: { id: name, name } }; },
    async getSchema(context) { return { item: await unwrap(api.schema.get({ dataset: dataset(context) })) }; },
    async upsertSchema(input, context) { const name = dataset(context); await unwrap(api.schema.upsert({ dataset: name, schema: input.schema })); return { item: await unwrap(api.schema.get({ dataset: name })) }; },
    async listDocuments(input, context) { const page = await unwrap(api.docs.list({ dataset: dataset(context), types: input.types, filter: input.filter, cursor: input.cursor, limit: input.limit })); return { items: page.data, nextCursor: page.nextCursor }; },
    async getDocument(input, context) { return { item: await unwrap(api.docs.get({ dataset: dataset(context), ...input })) }; },
    async createDocument(input, context) { return { item: await unwrap(api.docs.create({ dataset: dataset(context), id: input.id, type: input.type, doc: input.document, asDraft: input.asDraft ?? true })) }; },
    async patchDocument(input, context) { return { item: await unwrap(api.docs.patch({ dataset: dataset(context), ...input })) }; },
    async deleteDocument(input, context) { await unwrap(api.docs.delete({ dataset: dataset(context), ...input })); return { completed: true }; },
    async publishDocument(input, context) { return { item: await unwrap(api.docs.publish({ dataset: dataset(context), ...input })) }; },
    async unpublishDocument(input, context) { await unwrap(api.docs.unpublish({ dataset: dataset(context), ...input })); return { completed: true }; },
    async listRevisions(input, context) { const page = await unwrap(api.docs.history({ dataset: dataset(context), ...input })); return { items: page.revisions, nextCursor: page.nextCursor }; },
    async restoreRevision(input, context) { return { item: await unwrap(api.docs.restore({ dataset: dataset(context), ...input })) }; },
  };
}

export function createCmsFnAdminAdapter(service: CmsFnAdminService) {
  return createKernelAdminCapabilityAdapter(cmsFnAdminCapability, {
    "cmsfn.datasets.list": ({ context }) => service.listDatasets(context),
    "cmsfn.datasets.create": ({ context }) => service.createDataset(context),
    "cmsfn.schemas.get": ({ context }) => service.getSchema(context),
    "cmsfn.schemas.upsert": ({ input, context }) => service.upsertSchema(input as UpsertSchemaInput, context),
    "cmsfn.documents.list": ({ input, context }) => service.listDocuments(input as ListDocumentsInput, context),
    "cmsfn.documents.get": ({ input, context }) => service.getDocument(input as GetDocumentInput, context),
    "cmsfn.documents.create": ({ input, context }) => service.createDocument(input as CreateDocumentInput, context),
    "cmsfn.documents.patch": ({ input, context }) => service.patchDocument(input as PatchDocumentInput, context),
    "cmsfn.documents.delete": ({ input, context }) => service.deleteDocument(input as DeleteDocumentInput, context),
    "cmsfn.documents.publish": ({ input, context }) => service.publishDocument(input as PublishDocumentInput, context),
    "cmsfn.documents.unpublish": ({ input, context }) => service.unpublishDocument(input as PublishDocumentInput, context),
    "cmsfn.documents.list-revisions": ({ input, context }) => service.listRevisions(input as ListRevisionsInput, context),
    "cmsfn.documents.restore-revision": ({ input, context }) => service.restoreRevision(input as RestoreRevisionInput, context),
  });
}

export function createCmsFnAdminClient(adminClient: AdminClient) {
  const capability = createCapabilityAdminClient(cmsFnAdminCapability, adminClient);
  return Object.assign(capability, {
    datasets: {
      list: (options?: AdminClientRequestOptions) => capability.invoke("cmsfn.datasets.list", {}, options),
      create: (options?: AdminClientRequestOptions) => capability.invoke("cmsfn.datasets.create", {}, options),
    },
    schemas: {
      get: (options?: AdminClientRequestOptions) => capability.invoke("cmsfn.schemas.get", {}, options),
      upsert: (input: UpsertSchemaInput, options?: AdminClientRequestOptions) => capability.invoke("cmsfn.schemas.upsert", input, options),
    },
    documents: {
      list: (input: ListDocumentsInput = {}, options?: AdminClientRequestOptions) => capability.invoke("cmsfn.documents.list", input, options),
      get: (input: GetDocumentInput, options?: AdminClientRequestOptions) => capability.invoke("cmsfn.documents.get", input, options),
      create: (input: CreateDocumentInput, options?: AdminClientRequestOptions) => capability.invoke("cmsfn.documents.create", input, options),
      patch: (input: PatchDocumentInput, options?: AdminClientRequestOptions) => capability.invoke("cmsfn.documents.patch", input, options),
      delete: (input: DeleteDocumentInput, options?: AdminClientRequestOptions) => capability.invoke("cmsfn.documents.delete", input, options),
      publish: (input: PublishDocumentInput, options?: AdminClientRequestOptions) => capability.invoke("cmsfn.documents.publish", input, options),
      unpublish: (input: PublishDocumentInput, options?: AdminClientRequestOptions) => capability.invoke("cmsfn.documents.unpublish", input, options),
      revisions: (input: ListRevisionsInput, options?: AdminClientRequestOptions) => capability.invoke("cmsfn.documents.list-revisions", input, options),
      restore: (input: RestoreRevisionInput, options?: AdminClientRequestOptions) => capability.invoke("cmsfn.documents.restore-revision", input, options),
    },
  });
}

export const adminCapability = cmsFnAdminCapability;
export const createAdminAdapter = createCmsFnAdminAdapter;
