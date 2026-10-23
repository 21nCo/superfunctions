# ContentFn Specification

## Metadata

- **timestamp**: 2026-02-07T17:27:22Z (UTC)
- **agent_name**: unknown-agent
- **model**: GPT-5.2
- **launcher**: Cursor
- **workspace path**: /Users/ar/dev
- **project root**: /Users/ar/dev/superfunctions/contentfn
- **OS**: darwin 25.0.0
- **shell**: zsh
- **repo**:
  - **git repo**: no (workspace is not a git repo)
- **spec_folder**: 2026-02-07-new-k58m92je-spec
- **spec_folder path**: /Users/ar/dev/superfunctions/contentfn/.conduct/specs/2026-02-07-new-k58m92je-spec
- **spec_type**: new
- **spec_id**: k58m92je
- **input paths**:
  - https://www.fetch.at/spec.txt
  - /Users/ar/dev/superfunctions/pop.md
  - /Users/ar/dev/superfunctions/docsfn/.conduct/spec.md
  - /Users/ar/dev/superfunctions/docsfn/.conduct/implementation.md
  - User prompt (chat): “manage content like self-hosted sanity.io” (2026-02-07)

## Overview

ContentFn (`contentfn`) is a **self-hosted, schema-driven content engine** for the Superfunctions ecosystem. It provides a headless API for managing structured documents (content), references between documents, rich text (portable blocks), assets (files/images), revisions, drafts, publishing workflows, query and projection, real-time change feeds, and webhooks.

**One-sentence goal**: Provide a Sanity-like self-hosted headless content engine (schema + documents + assets + drafts/publish + query + events) that integrates with Superfunctions primitives while keeping all data in the deployer’s infrastructure.

**Target users**:
- Developers building content-driven apps (marketing sites, product docs, blogs, knowledge bases).
- Teams that want Sanity-like authoring workflows but **self-hosted** (no vendor SaaS data plane).
- Superfunctions users who want a unified content primitive usable by `docsfn`, `uifn`, `searchfn`, `watchfn`, `authfn`, `filefn`.

**Target environments**:
- **Server**: Node.js (primary) for `@contentfn/server` (HTTP + realtime).
- **Client**: Browser/Node for `@contentfn/client`.
- **Storage**: Any DB supported by `@superfunctions/db` adapter interface (Postgres/MySQL/SQLite/Memory, etc).
- **Object storage**: Optional; via `@superfunctions/storage` or `filefn`-compatible storage for assets.

**Non-goals**:
- A managed SaaS offering (hosting, global CDN) is out of scope; ContentFn is self-hosted.
- A full studio UI is not in `contentfn`; that is `cmsfn` (authoring product) built on top.

## Glossary

- **Dataset**: A named logical namespace of content (e.g. `prod`, `staging`). Datasets isolate documents, assets, schema versions, and events.
- **Schema**: The set of type definitions that describe allowed document shapes and constraints.
- **Document**: A JSON-like record with mandatory system fields (e.g. `_id`, `_type`, `_rev`, `_createdAt`, `_updatedAt`) plus schema-defined fields.
- **Draft**: A mutable pre-publish version of a document; publishing makes draft content visible as the canonical “published” document.
- **Published document**: The canonical externally-consumed version of a document.
- **Revision**: An immutable snapshot describing a document state at a point in time; revisions allow history, diff, and restore.
- **Patch**: A minimal update described by operations applied to a document without sending the whole document.
- **Reference**: A typed pointer from one document to another (strong or weak).
- **Asset**: A stored file/image with metadata; documents can reference assets.
- **CFQL (ContentFn Query Language)**: A canonical JSON query format for listing and projecting documents deterministically.
- **Envelope**: Canonical response shape for all fallible operations: `{ ok: true, result: T } | { ok: false, error: ContentfnError }`.

## Goals

1. ContentFn MUST provide schema-driven document storage with validation and deterministic behavior.
2. ContentFn MUST support drafts and publishing workflows (draft, publish, unpublish, scheduled publish).
3. ContentFn MUST support patch-based mutations with optimistic concurrency.
4. ContentFn MUST maintain revision history and support restore/rollback.
5. ContentFn MUST provide a deterministic query API with filtering, ordering, pagination, projection, and bounded reference expansion.
6. ContentFn MUST manage assets (file/image) with metadata and integrate with self-hosted storage backends.
7. ContentFn MUST emit change events via webhooks and a realtime feed for live preview and collaborative tooling.
8. ContentFn MUST integrate with Superfunctions primitives (notably `@superfunctions/db` adapter, optional `authfn` for auth, optional `searchfn` for indexing, optional `watchfn`/`logfn` for observability).
9. ContentFn MUST support dataset export/import for backup, restore, and environment promotion.

## Non-goals

- ContentFn MUST NOT embed a full authoring UI; `cmsfn` (or other apps) consume ContentFn APIs to provide a studio experience.
- ContentFn MUST NOT require any external vendor services; all persistence is in deployer-controlled DB/storage.

## Assumptions and open questions (non-blocking)

Assumptions used for MUST-level requirements in this spec:
- ContentFn is implemented primarily in TypeScript for Node/browser.
- Rich text is represented as a portable “block array” (similar in spirit to Sanity Portable Text) and stored as JSON.
- Query language is a structured JSON format (CFQL), not a GROQ string parser.

Open questions (do not block this spec; answers may refine ergonomics but not core semantics):
1. Should ContentFn expose an optional GROQ-compatible query endpoint in addition to CFQL?
2. Should multi-project hosting be modeled as **datasets** only, or as **projects + datasets** (Sanity-style)?
3. Which image transform pipeline should be first-class (sharp/libvips, or defer to a storage CDN-like adapter)?

## Public API

### Canonical envelope + errors (shared)

```typescript
export type ContentfnErrorCode =
  | "AUTH_REQUIRED"
  | "PERMISSION_DENIED"
  | "VALIDATION_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "DATASET_NOT_FOUND"
  | "DATASET_ALREADY_EXISTS"
  | "SCHEMA_NOT_FOUND"
  | "SCHEMA_INVALID"
  | "SCHEMA_VERSION_CONFLICT"
  | "DOCUMENT_NOT_FOUND"
  | "DOCUMENT_ALREADY_EXISTS"
  | "REV_CONFLICT"
  | "PATCH_INVALID"
  | "QUERY_INVALID"
  | "QUERY_TOO_COMPLEX"
  | "ASSET_NOT_FOUND"
  | "ASSET_UPLOAD_FAILED"
  | "WEBHOOK_NOT_FOUND"
  | "WEBHOOK_DELIVERY_FAILED"
  | "REALTIME_NOT_AVAILABLE"
  | "STORAGE_ERROR"
  | "INTERNAL_ERROR";

export interface ContentfnError {
  code: ContentfnErrorCode;
  message: string;
  details: {
    /** Dot-path or JSON-pointer-like path to the invalid field when applicable. */
    path?: string;
    /** Resource identifier when applicable. */
    id?: string;
    dataset?: string;
    type?: string;
    expectedRev?: string;
    actualRev?: string;
    [key: string]: unknown;
  };
}

export type ContentfnEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: ContentfnError };
```

### Core types (schema + documents)

```typescript
export type ContentfnPrimitiveType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "json";

export type ContentfnFieldType =
  | { kind: "primitive"; type: ContentfnPrimitiveType }
  | { kind: "object"; fields: ContentfnField[] }
  | { kind: "array"; of: Array<ContentfnFieldType | { kind: "reference"; to: string[] }>; maxLength?: number }
  | { kind: "reference"; to: string[]; weak?: boolean }
  | { kind: "richtext"; of?: "block"; allowMarks?: string[]; allowObjects?: string[] }
  | { kind: "asset"; assetType: "file" | "image" };

export interface ContentfnField {
  name: string;
  type: ContentfnFieldType;
  required?: boolean;
  /** Validation rules are declarative and deterministic. */
  validation?: Array<
    | { rule: "min"; value: number }
    | { rule: "max"; value: number }
    | { rule: "regex"; value: string }
    | { rule: "enum"; value: string[] }
    | { rule: "unique" }
  >;
}

export interface ContentfnDocumentType {
  name: string;
  fields: ContentfnField[];
  /** Optional: deterministic slug generation hints, preview config, etc. */
  meta?: Record<string, unknown>;
}

export interface ContentfnSchema {
  version: number;
  documentTypes: ContentfnDocumentType[];
}

export interface ContentfnSystemFields {
  _id: string;
  _type: string;
  _rev: string;
  _createdAt: string; // ISO 8601
  _updatedAt: string; // ISO 8601
  _publishedAt?: string; // ISO 8601 when published
}

export type ContentfnDocument = ContentfnSystemFields & Record<string, unknown>;
```

### Query API (CFQL)

CFQL is the canonical query protocol for ContentFn.

```typescript
export type CfqlOperator =
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "not_in"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "is_null"
  | "is_not_null"
  | "match"; // full-text match where supported

export type CfqlFilter =
  | { op: "and"; filters: CfqlFilter[] }
  | { op: "or"; filters: CfqlFilter[] }
  | { field: string; op: CfqlOperator; value?: unknown };

export interface CfqlOrderBy {
  field: string;
  direction: "asc" | "desc";
}

export interface CfqlProjection {
  /** Fields to include; absent means include all user fields + system fields. */
  fields?: string[];
  /** Optional reference expansion; bounded by server limits. */
  expand?: Record<
    string,
    {
      /** Field name that contains a reference (or array of references). */
      field: string;
      /** Projection applied to the referenced documents. */
      projection?: CfqlProjection;
    }
  >;
}

export interface CfqlQuery {
  dataset: string;
  types?: string[]; // document _type filter
  filter?: CfqlFilter;
  orderBy?: CfqlOrderBy[];
  projection?: CfqlProjection;
  limit?: number;
  cursor?: string | null;
}

export interface CfqlResultPage {
  data: ContentfnDocument[];
  nextCursor: string | null;
}
```

### Patch API

ContentFn uses a deterministic patch format inspired by JSON Patch but with stable addressing for array items by `_key` when present.

```typescript
export type ContentfnPatchOp =
  | { op: "set"; path: string; value: unknown }
  | { op: "unset"; path: string }
  | { op: "inc"; path: string; value: number }
  | { op: "dec"; path: string; value: number }
  | { op: "insert"; path: string; position: "before" | "after"; ref: string; items: unknown[] }
  | { op: "splice"; path: string; index: number; deleteCount: number; items?: unknown[] };

export interface ContentfnPatchInput {
  dataset: string;
  id: string;
  /** If provided, server MUST enforce optimistic concurrency. */
  ifRev?: string;
  ops: ContentfnPatchOp[];
}
```

### Server and client APIs (conceptual)

```typescript
export interface ContentfnConfig {
  /** DB adapter (required). */
  db: import("@superfunctions/db").Adapter;
  /** Optional asset storage backend. */
  storage?: unknown;
  /** Optional authorization hook. */
  authorize?: (ctx: unknown, action: string, input: unknown) => Promise<boolean> | boolean;
  /** Optional limits. */
  limits?: {
    maxPayloadBytes?: number;
    maxPatchOps?: number;
    maxQueryLimit?: number;
    maxExpandDepth?: number;
    maxFilterDepth?: number;
  };
}

export interface ContentfnAPI {
  datasets: {
    create: (input: { dataset: string }) => Promise<ContentfnEnvelope<{ dataset: string }>>;
    list: (input?: {}) => Promise<ContentfnEnvelope<{ datasets: string[] }>>;
    delete: (input: { dataset: string }) => Promise<ContentfnEnvelope<{}>>;
    export: (input: { dataset: string }) => Promise<
      ContentfnEnvelope<{
        dataset: string;
        exportedAt: string; // ISO 8601
        artifact: unknown; // deterministic JSON artifact (see Semantics)
      }>
    >;
    import: (input: { dataset: string; artifact: unknown }) => Promise<ContentfnEnvelope<{ dataset: string }>>;
  };
  schema: {
    upsert: (input: { dataset: string; schema: ContentfnSchema }) => Promise<ContentfnEnvelope<{ schemaHash: string }>>;
    get: (input: { dataset: string }) => Promise<ContentfnEnvelope<ContentfnSchema>>;
  };
  docs: {
    create: (input: { dataset: string; id?: string; type: string; doc: Record<string, unknown>; asDraft?: boolean }) => Promise<ContentfnEnvelope<ContentfnDocument>>;
    get: (input: { dataset: string; id: string; perspective?: "published" | "draft" | "raw" }) => Promise<ContentfnEnvelope<ContentfnDocument>>;
    query: (input: CfqlQuery) => Promise<ContentfnEnvelope<CfqlResultPage>>;
    patch: (input: ContentfnPatchInput) => Promise<ContentfnEnvelope<ContentfnDocument>>;
    delete: (input: { dataset: string; id: string; purge?: boolean }) => Promise<ContentfnEnvelope<{}>>;
    publish: (input: { dataset: string; id: string; ifRev?: string }) => Promise<ContentfnEnvelope<ContentfnDocument>>;
    unpublish: (input: { dataset: string; id: string; ifRev?: string }) => Promise<ContentfnEnvelope<{}>>;
    history: (input: { dataset: string; id: string; limit?: number; cursor?: string | null }) => Promise<ContentfnEnvelope<{ revisions: ContentfnDocument[]; nextCursor: string | null }>>;
    restore: (input: { dataset: string; id: string; rev: string }) => Promise<ContentfnEnvelope<ContentfnDocument>>;
  };
  assets: {
    upload: (input: { dataset: string; filename: string; contentType: string; bytesBase64: string }) => Promise<ContentfnEnvelope<{ assetId: string; url: string }>>;
    get: (input: { dataset: string; assetId: string }) => Promise<ContentfnEnvelope<{ assetId: string; url: string; metadata: Record<string, unknown> }>>;
  };
  webhooks: {
    register: (input: { dataset: string; url: string; events: string[]; secret?: string }) => Promise<ContentfnEnvelope<{ webhookId: string }>>;
    list: (input: { dataset: string }) => Promise<ContentfnEnvelope<{ webhooks: Array<{ webhookId: string; url: string; events: string[] }> }>>;
    delete: (input: { dataset: string; webhookId: string }) => Promise<ContentfnEnvelope<{}>>;
  };
  realtime: {
    /** Server-side: subscribe to events. Client-side: connect + subscribe. */
    // exact transport defined in protocol section
  };
}
```

### HTTP API (canonical endpoints)

All endpoints MUST respond with the canonical envelope (`ContentfnEnvelope<T>`). All request bodies MUST be JSON unless stated otherwise.

- `GET /contentfn/status`
  - Returns `{ ok: true, result: { serverTime: string, capabilities: string[], limits: object } }`.
- `POST /contentfn/datasets/create`
- `POST /contentfn/datasets/list`
- `POST /contentfn/datasets/delete`
- `POST /contentfn/datasets/export`
- `POST /contentfn/datasets/import`
- `POST /contentfn/schema/upsert`
- `POST /contentfn/schema/get`
- `POST /contentfn/docs/create`
- `POST /contentfn/docs/get`
- `POST /contentfn/query`
- `POST /contentfn/docs/patch`
- `POST /contentfn/docs/delete`
- `POST /contentfn/docs/publish`
- `POST /contentfn/docs/unpublish`
- `POST /contentfn/docs/history`
- `POST /contentfn/docs/restore`
- `POST /contentfn/assets/upload`
- `POST /contentfn/assets/get`
- `POST /contentfn/webhooks/register`
- `POST /contentfn/webhooks/list`
- `POST /contentfn/webhooks/delete`

## Data formats / protocol

### Canonical timestamps

- `_createdAt`, `_updatedAt`, `_publishedAt` MUST be ISO 8601 strings in UTC (e.g. `2026-02-07T17:27:22Z`).

### Document identity

- `_id` MUST be unique within a dataset.
- Draft IDs MUST use the prefix `drafts.` (e.g. `drafts.post-123`) and MUST map to a canonical published ID by removing the prefix.

### Revisions

- `_rev` MUST be a stable opaque string that changes for every successful mutation to that document perspective (draft or published).
- Server MUST reject mutations with `ifRev` that does not match the current `_rev` using `REV_CONFLICT`.

### Reference encoding

References MUST use the following canonical shape:

```json
{ "_type": "reference", "_ref": "doc-id", "_weak": false }
```

### Webhook delivery envelope

Webhook payload MUST be:

```json
{
  "eventId": "evt_...",
  "dataset": "prod",
  "type": "doc.published",
  "timestamp": "2026-02-07T17:27:22Z",
  "actor": { "subject": "user:123" },
  "document": { "_id": "post-123", "_type": "post", "_rev": "rev_..." },
  "diff": { "changedPaths": ["title", "body[0]"] }
}
```

If a webhook has a `secret`, the request MUST include an HMAC signature header:
- Header: `X-ContentFn-Signature: v1=<hex>`
- Signature: HMAC-SHA256 over the raw request body.

## Semantics

### Datasets

- ContentFn MUST support multiple datasets.
- Dataset names MUST match `^[a-z0-9][a-z0-9_-]{1,62}$`.
- Deleting a dataset MUST delete all documents, revisions, assets metadata, webhooks, and event logs for that dataset (unless the deployment overrides with retention rules).

### Import / export

- Export MUST produce a deterministic JSON artifact containing:
  - the current schema (and schema version) for the dataset
  - all documents in both draft and published perspectives
  - asset metadata records (and storage URLs if applicable)
  - revision history sufficient to restore state
- Import MUST:
  - validate the artifact structure deterministically
  - create the target dataset if it does not exist
  - restore schema, documents, and metadata into the target dataset without cross-dataset leakage
- If the artifact is malformed, import MUST return `VALIDATION_FAILED` (or `SCHEMA_INVALID` when schema is invalid).

### Schema

- Schema upsert MUST validate:
  - unique document type names
  - unique field names per type/object
  - referenced types exist
  - validation rules are well-formed and deterministic
- Schema version MUST be monotonic per dataset.
- Schema changes MUST NOT retroactively mutate stored documents; instead, documents are validated on write and optionally re-validated on read when requested.

### Document perspectives (draft vs published)

- `perspective="published"` returns the published document only.
- `perspective="draft"` returns the draft document if it exists; otherwise `DOCUMENT_NOT_FOUND`.
- `perspective="raw"` returns both when available (implementation-defined envelope shape); if unsupported, MUST return `QUERY_INVALID` or `VALIDATION_FAILED`.

### Create

- `docs.create({ asDraft: true })` MUST create a draft ID with `drafts.` prefix if not provided.
- If `id` is provided and does not begin with `drafts.` but `asDraft=true`, server MUST create `drafts.{id}`.

### Patch

- Patch operations MUST be applied in order.
- Paths MUST be deterministic and refer to existing structures unless `set` creates intermediate objects (explicitly allowed) under server-configured rules.
- Array item addressing:
  - If array elements are objects with a stable `_key` string field, `insert` and `set` MAY address items via a ref path containing `_key==...` (exact encoding documented by implementation).
  - If `_key` is absent, array addressing uses numeric indices only.

### Publish / Unpublish

- Publish MUST:
  - require a draft to exist
  - atomically copy the draft content to the published document ID
  - set `_publishedAt`
  - increment revisions of both draft and published representations as needed
  - emit `doc.published` event
- Unpublish MUST:
  - remove the published representation while retaining the draft (unless `purge=true` delete is requested)
  - emit `doc.unpublished` event

### Revision history

- Each successful mutation MUST append a revision record that can be retrieved via `docs.history`.
- `docs.restore({ rev })` MUST restore a chosen revision into the **draft** perspective by default and MUST require an explicit publish to affect published content.

### Query (CFQL)

- Filtering MUST apply to system fields and user fields.
- Query MUST be deterministic:
  - if `orderBy` is not provided, server MUST order by `_updatedAt desc, _id asc`
  - if `orderBy` is provided, server MUST append `_id asc` as a deterministic tie-breaker when not already present
- Pagination MUST use an opaque `cursor` that encodes the last seen ordering tuple.
- Reference expansion MUST be bounded by `maxExpandDepth` and MUST detect reference cycles and stop expansion deterministically.

### Assets

- Assets MUST be created by upload and referenced from documents using canonical asset reference objects:

```json
{ "_type": "asset", "_ref": "asset-id", "assetType": "image" }
```

- Image assets MUST store width/height metadata when determinable.

### Webhooks

- Webhooks MUST support at least: `doc.created`, `doc.updated`, `doc.published`, `doc.unpublished`, `doc.deleted`, `asset.created`.
- Delivery MUST be retried with exponential backoff up to a configured maximum.
- Delivery failures MUST be observable (logged + queryable by admins).

### Realtime feed

- ContentFn MUST expose a realtime feed of events for:
  - live preview (subscribing to a document or query)
  - collaborative editing signals (presence and change broadcasts)
- Transport MAY be WebSocket or SSE; the canonical message envelope MUST include `eventId`, `type`, `dataset`, `timestamp`, and relevant identifiers.

## Invariants

- **Determinism**: Given the same dataset state and the same request inputs, ContentFn MUST return identical results (excluding timestamps generated during mutation).
- **Idempotency**: If an idempotency key is provided (implementation-defined header or field), mutations MUST be de-duplicated.
- **Ordering**: List/query ordering MUST be deterministic and documented; `_id` is the final tie-breaker.
- **Immutability**: Revisions MUST be immutable once written.
- **Consistency**: Publish/unpublish operations MUST be atomic with respect to read perspectives and events.

## Security

- ContentFn MUST support pluggable authn/authz. The core MUST be deployable behind any auth system, and SHOULD integrate with `authfn` in reference implementations.
- The server MUST provide an `authorize(ctx, action, input)` hook that can deny operations with `PERMISSION_DENIED`.
- Multi-tenant isolation MUST be possible by dataset naming + auth context (e.g. `tenant:{tenantId}`-prefixed datasets), and MUST prevent cross-dataset reads/writes when configured.
- ContentFn MUST validate all inputs (schema, doc mutations, patch paths, queries) and MUST reject invalid inputs with `VALIDATION_FAILED`, `PATCH_INVALID`, or `QUERY_INVALID` as appropriate.
- ContentFn MUST NOT log secrets or raw asset bytes in application logs.

## Limits / caps

Default limits (deployments MAY override):
- `maxPayloadBytes`: 1,048,576 (1 MiB) for JSON requests
- `maxPatchOps`: 100 ops per patch
- `maxQueryLimit`: 100
- `maxExpandDepth`: 3
- `maxFilterDepth`: 10

When limits are exceeded, server MUST return `PAYLOAD_TOO_LARGE` or `QUERY_TOO_COMPLEX` (as appropriate).

## Observability

- ContentFn MUST emit structured logs for:
  - schema upsert
  - document mutations (without logging full document bodies by default)
  - publish/unpublish
  - asset uploads (metadata only)
  - webhook delivery attempts and failures
  - realtime connections (connect/disconnect, subscribe/unsubscribe)
- ContentFn SHOULD support an audit log stream (queryable) that records actor + action + target IDs + timestamp.

## Compatibility / versioning strategy

- API MUST be versioned semantically at the package level.
- Schema versions are per-dataset and monotonic. Schema updates MUST be backward-compatible by default; breaking changes MUST require explicit migration steps and MUST be detectable by validation failures.
- The HTTP API MAY expose a `capabilities` array in `/contentfn/status` to allow clients to feature-detect.

## Undefined / Explicitly user-deferred only

None.

