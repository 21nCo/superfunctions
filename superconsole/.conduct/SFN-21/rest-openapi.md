# REST and OpenAPI

## Base paths

- Administration API: `/api/admin/v1`
- Capability discovery: `/api/admin/v1/registry`
- Installation overview: `/api/admin/v1/overview`
- Enabled module operations: `/api/admin/v1/modules/{moduleId}/...`
- Global search: `/api/admin/v1/search`
- Audit stream/query: `/api/admin/v1/audit`
- Installation and module settings: `/api/admin/v1/settings`
- MCP discovery/configuration: `/api/admin/v1/mcp`
- McpFn streamable HTTP transport: `/api/admin/v1/mcp/transport`
- Confirmation issuance: `/api/admin/v1/confirmations`
- AuthFn password sign-in: `/api/admin/v1/auth/sign-in`
- AuthFn two-factor completion: `/api/admin/v1/auth/2fa`
- AuthFn sign-out: `/api/admin/v1/auth/sign-out`
- OpenAPI 3.1 document: `/api/admin/v1/openapi.json`

Only enabled operations appear in routing and OpenAPI.

## Scope

Canonical scope is carried in query parameters or validated headers according to the deployment adapter. The normalized context is a contiguous installation, workspace, project, and environment chain down to the operation's declared minimum, with optional function namespace and region. Supported query keys are `installationId`, `workspaceId`, `projectId`, `environmentId`, `namespace`, and `region`; `organizationId` is the deprecated installation-root alias. Corresponding headers use `x-superconsole-<level>-id` and `x-superconsole-namespace|region`.

Scope values are never trusted merely because they were sent by a client. AuthFn membership and the function's object-level authorization are evaluated for each request.

## Envelopes

Success:

```json
{
  "ok": true,
  "data": {},
  "page": { "nextCursor": null, "hasMore": false },
  "requestId": "req_...",
  "auditId": "audit_..."
}
```

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "forbidden",
    "message": "The active actor cannot perform this operation.",
    "issues": [],
    "retryable": false
  },
  "requestId": "req_..."
}
```

`auditId` is returned when the dispatcher records the terminal event, including audited failures after domain invocation. An `attempted` event is deliberately not exposed as a terminal receipt. Shared shell endpoints use the same success/error envelope but do not fabricate pagination or audit metadata. Secret or private domain payloads never appear in generic errors.

Intentional one-time credentials are an explicit exception, not a generic redaction opt-out. The manifest validator accepts them only for non-idempotent operations with required audit and strong recent-auth, MFA, or approval confirmation. The successful response may reveal only the declared fields once; audit, error, and replay data remain redacted. OpenAPI and MCP describe those fields as `oneTimeOutputFields` and never expose the kernel's internal allow-list name.

## Pagination, filtering, and sorting

- Cursor pagination is stable under the injected resource service's declared ordering.
- Default and maximum page sizes are operation metadata.
- Each function package publishes its supported search, filter, and sort fields in its typed administration inventory.
- The v1 transport schema validates the bounded filter/sort envelope; the injected function administration service remains authoritative for field support and must reject unknown fields rather than silently ignore them. Generated per-resource filter enums are a future SDK/OpenAPI refinement.
- The transport treats provider cursors as opaque and requires production providers to make them integrity-protected and scope-bound. The shared package's basic encoded cursor helper checks scope equality but is not a signed-token substitute for hostile public clients.

## Idempotency and concurrency

- Operations marked idempotent accept `Idempotency-Key`.
- Keys are scoped to actor, tenant, module, operation, and normalized request identity.
- Repeated matching requests return the stored outcome and original audit reference.
- Reusing a key for different input returns conflict.
- A function may declare optimistic concurrency in its own schema or headers; the generic transport does not invent an ETag policy.

## Authentication

Interactive requests use AuthFn sessions. Automation uses scoped service credentials or API keys. The OpenAPI document declares configured security schemes but never embeds credentials. CSRF rules remain active for cookie-authenticated mutations.

Password sign-in delegates to AuthFn's composed router, including rate limits, plugins, and two-factor challenge behavior. A successful operator sign-in sets AuthFn cookies. If AuthFn returns a two-factor challenge, the caller submits `challengeId` and `code` to `/auth/2fa`. Authenticated session bootstrap identifies the exact readable AuthFn CSRF cookie for the active namespaced session; cookie-authenticated unsafe requests echo its value in `x-authfn-csrf`. Sign-out is also CSRF-protected.

Destructive operations first request a token from `/confirmations` with `{ "operationId": "...", "input": { ... } }`, then send the returned token in `x-admin-confirmation`. Idempotent mutations send `Idempotency-Key`; retries reuse the same key only for identical input.

## OpenAPI projection

The generator emits OpenAPI 3.1 with:

- one tag per enabled module and nested grouping metadata;
- deterministic operation IDs;
- per-operation request/response schemas plus the shared normalized error schema; pagination, audit receipts, and safety metadata are represented in operation envelopes/extensions;
- security schemes and per-operation permissions;
- scope, confirmation, idempotency, safety, target, and redaction extensions, including `oneTimeOutputFields` for narrowly confirmed one-time credentials;
- module and capability versions;
- disabled modules omitted from paths and components when safe to do so.

The document also records the implemented shared shell, AuthFn, confirmation, and McpFn paths. Kernel tests compare enabled registry operations, REST paths, OpenAPI operation IDs, and McpFn projections.

Available function operations expose the exact schema enforced by their
domain-backed adapter. OpenAPI, MCP, the TypeScript client, and the console form
all consume that schema. A package without a canonical domain service exposes
no REST/OpenAPI/MCP operations and cannot be selected at startup.

## Versioning

`v1` is the transport major version. Function capability versions are returned independently. A breaking transport change uses a new base path. Additive capability changes remain in the same transport version. V1 does not define deprecation fields. A future deprecation contract must declare replacement and sunset metadata consistently across every projection and must not fabricate dates when no policy exists.
