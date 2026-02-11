# CmsFn Specification

## Metadata

- **timestamp**: 2026-02-07T17:27:22Z (UTC)
- **agent_name**: unknown-agent
- **model**: GPT-5.2
- **launcher**: Cursor
- **workspace path**: /Users/ar/dev
- **project root**: /Users/ar/dev/superfunctions/cmsfn
- **OS**: darwin 25.0.0
- **shell**: zsh
- **repo**:
  - **git repo**: no (workspace is not a git repo)
- **spec_folder**: 2026-02-07-new-zr4cvxyp-spec
- **spec_folder path**: /Users/ar/dev/superfunctions/cmsfn/.conduct/specs/2026-02-07-new-zr4cvxyp-spec
- **spec_type**: new
- **spec_id**: zr4cvxyp
- **input paths**:
  - https://www.fetch.at/spec.txt
  - /Users/ar/dev/superfunctions/docsfn/.conduct/spec.md
  - /Users/ar/dev/superfunctions/docsfn/.conduct/implementation.md
  - /Users/ar/dev/superfunctions/contentfn/.conduct/specs/2026-02-07-new-k58m92je-spec/SPEC.md
  - User prompt (chat): “managing content like self hosted sanity.io” (2026-02-07)

## Overview

CmsFn (`cmsfn`) is the **self-hosted authoring studio and content operations layer** for the Superfunctions ecosystem. It provides an editorial UI and workflow system (desk, document editing, media library, preview, review/publish flow, roles/permissions) powered by `contentfn` as the canonical content backend.

CmsFn’s core principle: **all content state lives in `contentfn`**; CmsFn adds:
- schema-aware authoring UI,
- editorial workflows,
- preview/build hooks,
- access control UX and role management integration,
- operational tools (imports, releases, audit logs viewer),
while remaining self-hosted.

**One-sentence goal**: Provide a self-hosted, Sanity-like CMS studio (desk + editor + media + preview + workflows + permissions) built on ContentFn so teams can author and publish content without vendor SaaS.

**Target users**:
- Content editors (non-dev) using a browser-based Studio
- Developers configuring schema, desk structure, and preview integrations
- Operators managing deployments (auth, storage, backups)

**Target environments**:
- Web app (browser) for Studio UI (React-like recommended; Svelte optional)
- Node.js server for Studio backend (auth/session, proxy to contentfn, webhooks/preview endpoints)
- Works behind any reverse proxy; self-hosted.

## Glossary

- **Studio**: The CMS web application used by editors.
- **Desk**: The main navigation/workspace surface (document lists, structure, panes).
- **Pane**: A UI region showing a list, editor, preview, history, etc.
- **Document editor**: Schema-driven form editor for a ContentFn document.
- **Field widget**: A UI component used to edit a field type (string, richtext, reference, asset).
- **Preview**: Live rendering of draft content in a target site/app.
- **Workflow**: Editorial state machine and rules (draft → review → approved → published).
- **Release**: A named batch of changes scheduled for coordinated publish.
- **Role**: A set of permissions for datasets/types/actions.
- **Audit log**: A view over ContentFn events and webhook delivery state.

## Goals

1. CmsFn MUST provide a Sanity-like studio UX: desk navigation, document lists, document editor, and preview.
2. CmsFn MUST be schema-driven, using ContentFn schema to render editors and validate input before write.
3. CmsFn MUST support editorial workflows: drafts, review/approval gates, and publishing/unpublishing.
4. CmsFn MUST provide media (asset) management UX backed by ContentFn assets APIs.
5. CmsFn MUST provide reference selection UX (search/browse) and bounded preview of referenced docs.
6. CmsFn MUST integrate with ContentFn realtime feed for live updates and collaborative preview.
7. CmsFn MUST support role-based access control UX and enforce permissions via server-side authorization.
8. CmsFn MUST support releases (batch publish) and scheduled publishing.
9. CmsFn MUST provide operational tools: import/export triggers, webhook/audit log viewer, dataset selection.
10. CmsFn MUST be self-hosted and must not require external vendor services.

## Non-goals

- CmsFn MUST NOT define its own content storage model; it consumes ContentFn exclusively.
- CmsFn is not a general-purpose page builder; it edits schema-defined documents (richtext + blocks are sufficient).

## Public API

CmsFn exposes both:
- a **Studio web app** (UI surface), and
- an optional **server API** for Studio-specific operations (sessions, role management, preview tokens).

### Canonical envelope + errors

CmsFn server endpoints MUST use a canonical envelope:

```typescript
export type CmsfnErrorCode =
  | "AUTH_REQUIRED"
  | "PERMISSION_DENIED"
  | "VALIDATION_FAILED"
  | "PAYLOAD_TOO_LARGE"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PREVIEW_NOT_CONFIGURED"
  | "CONTENTFN_UNAVAILABLE"
  | "INTERNAL_ERROR";

export interface CmsfnError {
  code: CmsfnErrorCode;
  message: string;
  details: { path?: string; id?: string; dataset?: string; [k: string]: unknown };
}

export type CmsfnEnvelope<T> =
  | { ok: true; result: T }
  | { ok: false; error: CmsfnError };
```

### Studio configuration (conceptual)

```typescript
export interface CmsfnStudioConfig {
  /** Base URL of the ContentFn server (or in-process binding). */
  contentfn: { baseUrl: string };

  /** Datasets visible in the studio. */
  datasets: Array<{ name: string; label?: string }>;

  /** Desk structure definition (deterministic). */
  desk: CmsfnDeskNode;

  /** Preview integration. */
  preview?: {
    enabled: boolean;
    /** URL of the site/app preview endpoint. */
    targetOrigin: string;
    /** How to compute preview URLs for a document. */
    resolveUrl: (doc: unknown) => string;
  };

  /** Auth integration (deployment-defined). */
  auth: {
    kind: "authfn" | "custom";
    // exact wiring is deployment-defined
  };

  /** Limits and feature flags. */
  limits?: {
    maxUploadBytes?: number;
    maxRichtextBlocks?: number;
  };
}

export type CmsfnDeskNode =
  | { kind: "group"; title: string; children: CmsfnDeskNode[] }
  | { kind: "documentList"; title: string; dataset: string; types: string[]; defaultOrder?: { field: string; direction: "asc" | "desc" }[] }
  | { kind: "singleton"; title: string; dataset: string; type: string; id: string }
  | { kind: "divider" };
```

### Server endpoints (canonical)

- `GET /cmsfn/status`
  - returns server time + capabilities + configured datasets
- `POST /cmsfn/session/login` (deployment-defined; may redirect; envelope required if JSON)
- `POST /cmsfn/session/logout`
- `POST /cmsfn/roles/list`
- `POST /cmsfn/roles/upsert`
- `POST /cmsfn/roles/delete`
- `POST /cmsfn/preview/token` (mint a short-lived preview token)
- `POST /cmsfn/releases/create`
- `POST /cmsfn/releases/list`
- `POST /cmsfn/releases/add` (add doc changes to release)
- `POST /cmsfn/releases/publish`
- `POST /cmsfn/ops/import` (trigger ContentFn import)
- `POST /cmsfn/ops/export` (trigger ContentFn export)
- `POST /cmsfn/audit/events` (read ContentFn events through a filtered UI-safe lens)
- `POST /cmsfn/audit/webhooks` (read webhook delivery status)

### Server API types (canonical I/O shapes)

```typescript
export interface CmsfnStatusResult {
  serverTime: string; // ISO 8601
  capabilities: string[];
  datasets: string[];
}

export interface CmsfnPreviewTokenResult {
  token: string;
  expiresAt: string; // ISO 8601
  dataset: string;
  docIds: string[];
}

export interface CmsfnRelease {
  releaseId: string;
  dataset: string;
  name: string;
  publishAt?: string | null; // ISO 8601 or null
  docIds: string[];
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface CmsfnReleasePublishResult {
  releaseId: string;
  published: string[]; // doc IDs
  failures: Array<{ docId: string; code: string; message: string }>;
}

export interface CmsfnAuditEvent {
  eventId: string;
  dataset: string;
  type: string;
  timestamp: string; // ISO 8601
  actor?: { subject?: string };
  document?: { _id: string; _type: string; _rev?: string };
  diff?: { changedPaths?: string[] };
}

export interface CmsfnWebhookDeliveryStatus {
  webhookId: string;
  dataset: string;
  url: string;
  eventId: string;
  attempt: number;
  status: "pending" | "delivered" | "failed";
  lastError?: string;
  updatedAt: string; // ISO 8601
}

export interface CmsfnServerAPI {
  status: () => Promise<CmsfnEnvelope<CmsfnStatusResult>>;

  roles: {
    list: (input: { dataset: string }) => Promise<CmsfnEnvelope<{ roles: CmsfnRole[] }>>;
    upsert: (input: { role: CmsfnRole }) => Promise<CmsfnEnvelope<{ role: CmsfnRole }>>;
    delete: (input: { roleId: string }) => Promise<CmsfnEnvelope<{}>>;
  };

  preview: {
    token: (input: { dataset: string; docIds: string[] }) => Promise<CmsfnEnvelope<CmsfnPreviewTokenResult>>;
  };

  releases: {
    create: (input: { dataset: string; name: string; publishAt?: string | null }) => Promise<CmsfnEnvelope<{ releaseId: string }>>;
    list: (input: { dataset: string }) => Promise<CmsfnEnvelope<{ releases: CmsfnRelease[] }>>;
    add: (input: { dataset: string; releaseId: string; docId: string }) => Promise<CmsfnEnvelope<{}>>;
    publish: (input: { dataset: string; releaseId: string }) => Promise<CmsfnEnvelope<CmsfnReleasePublishResult>>;
  };

  ops: {
    export: (input: { dataset: string }) => Promise<CmsfnEnvelope<{ artifact: unknown }>>;
    import: (input: { dataset: string; artifact: unknown }) => Promise<CmsfnEnvelope<{}>>;
  };

  audit: {
    events: (input: { dataset: string; limit?: number; cursor?: string | null }) => Promise<CmsfnEnvelope<{ events: CmsfnAuditEvent[]; nextCursor: string | null }>>;
    webhooks: (input: { dataset: string; limit?: number; cursor?: string | null }) => Promise<CmsfnEnvelope<{ deliveries: CmsfnWebhookDeliveryStatus[]; nextCursor: string | null }>>;
  };
}
```

## Data formats / protocol

### Roles and permissions model

CmsFn permissions MUST be expressed as deterministic rules:

```typescript
export type CmsfnAction =
  | "schema.read"
  | "doc.read"
  | "doc.create"
  | "doc.patch"
  | "doc.publish"
  | "doc.unpublish"
  | "doc.delete"
  | "asset.upload"
  | "asset.read"
  | "webhook.read"
  | "audit.read"
  | "release.manage";

export interface CmsfnRole {
  id: string;
  name: string;
  rules: Array<{
    datasets: string[] | "*";
    types: string[] | "*";
    actions: CmsfnAction[] | "*";
  }>;
}
```

Enforcement rule:
- The CmsFn server MUST deny operations not permitted by the role rules **even if the client UI attempts them**, returning `PERMISSION_DENIED`.

### Workflow states (editorial)

CmsFn MUST model a document’s editorial workflow state (stored in ContentFn drafts as a reserved system field):

```json
{
  "_cms": {
    "workflow": "default",
    "state": "draft|in_review|approved|published",
    "assignees": ["user:123"],
    "updatedAt": "<ISO>"
  }
}
```

## Semantics

### Studio UX invariants

- Studio MUST show a deterministic desk structure defined by `CmsfnStudioConfig.desk`.
- Studio MUST allow selecting a dataset, and all operations MUST be dataset-scoped.
- Document list panes MUST use ContentFn CFQL queries and MUST respect deterministic ordering rules.

### Document editing

- The document editor MUST render fields based on the ContentFn schema for the selected type.
- Edits MUST be saved via ContentFn patch operations.
- The editor MUST enforce schema validation:
  - client-side pre-validation for UX
  - server-side validation is authoritative (ContentFn)
- Conflict handling:
  - when ContentFn returns `REV_CONFLICT`, Studio MUST surface a deterministic conflict UI:
    - show “remote changed” vs “your edits”
    - allow refresh + re-apply (where possible)

### Preview

- If preview is enabled, Studio MUST render live previews for draft content.
- Preview MUST update on draft changes via realtime events.
- Preview tokening:
  - server MUST mint short-lived preview tokens
  - tokens MUST be bound to dataset + document id(s) and expire deterministically

### Media library

- Studio MUST support:
  - upload assets
  - browse assets
  - search assets by filename/contentType (deterministic)
  - insert asset references into documents

### References

- Studio MUST provide a reference picker widget that:
  - lists candidate docs using CFQL
  - supports deterministic search (title/name fields; match operator when enabled)
  - shows bounded referenced doc preview (projection-limited)

### Workflows + releases

- Workflow states MUST gate publishing:
  - if state is `in_review`, `doc.publish` action MUST be denied unless role allows override.
- Releases:
  - A release is a named collection of draft document IDs with a target publish time (optional).
  - Publishing a release MUST publish all included docs atomically per dataset (best-effort atomicity using sequential publish with stop-on-failure is acceptable if documented; must be deterministic).

### Ops: import/export

- Studio MUST be able to trigger ContentFn export/import for a dataset.
- Import/export MUST not allow cross-dataset leakage.

## Invariants

- Desk structure ordering and document list ordering MUST be deterministic.
- UI state MUST not be the source of truth; ContentFn is authoritative.
- Authorization MUST be enforced server-side for all privileged operations.
- Preview tokens MUST be unforgeable and short-lived.

## Security

- CmsFn MUST integrate with deployment auth (authfn recommended).
- The server MUST protect role management endpoints and audit endpoints.
- CmsFn MUST not expose ContentFn admin endpoints to unauthenticated users.
- Studio MUST avoid storing access tokens in persistent browser storage unless explicitly configured; default to HTTP-only cookies where possible.

## Limits / caps

Default limits (deployment MAY override):
- Max upload bytes: 25 MiB
- Max richtext blocks per field: 5000
- Max release size (docs per release): 500

Requests exceeding limits MUST return `PAYLOAD_TOO_LARGE` or `VALIDATION_FAILED` deterministically.

## Observability

- CmsFn server MUST log:
  - logins/logouts (without secrets)
  - role changes (who/what)
  - release publish attempts and results
  - preview token minting (metadata only)
- CmsFn MUST NOT log:
  - raw document bodies
  - raw asset bytes
  - authentication secrets

## Compatibility / versioning strategy

- CmsFn MUST track compatibility with ContentFn capabilities via `/contentfn/status` and fail fast when required capabilities are missing (`CONTENTFN_UNAVAILABLE`).
- CmsFn Studio config is versioned; breaking changes require a new config version and documented migration.

## Undefined / Explicitly user-deferred only

None.

