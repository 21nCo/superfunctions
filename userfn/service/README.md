# UserFn feedback service

`@userfn/service` provides the dedicated feedback persistence path through shared HTTP, auth and database abstractions. It is a Node ESM package. Consumers provide the HTTP framework adapter and database connection; this package does not re-export or duplicate them.

```typescript
import { createUserFnService, getUserFnSchema } from '@userfn/service';

const { router } = createUserFnService({
  database, // shared Adapter; do not pass adapterSchema when constructing it
  auth: authProvider,
  // Optional trusted application policy, required when the provider lacks tenant/scopes:
  resolveAccess: async session => {
    const binding = await keyBindings.findByActorId(session.subject.actorId);
    return binding ? { tenantId: binding.tenantId, scopes: binding.scopes } : null;
  },
  allowedOrigins: ['https://app.example.com'], // omit for server-only clients
});
// Mount router with a shared HTTP framework adapter, or call router.handle(request).
// Apply getUserFnSchema() through your shared database migration workflow first.
```

Authentication must verify credentials on every request. Only explicit bearer credentials are accepted; cookies are removed before authentication. By default the verified session must include `subject.tenantId` and explicit `userfn:feedback:write` / `userfn:feedback:read` scopes. The optional access resolver runs only after valid, unexpired authentication and supplies a trusted server-side tenant and permission mapping. It cannot replace the authenticated actor. Missing tenant, mapping or permission fails closed with 403. Credential failures return 401; provider/storage outages return sanitized 503.

The current AuthFn API-key provider returns the key ID as actor and key scopes in `metadata.scopes`, with no tenant. Supplying that raw provider alone therefore returns 403. Bind its verified actor ID to a tenant in trusted application storage, and map its verified scopes or application policy through `resolveAccess`. Never derive these values from request headers, feedback fields or claimed client identity. Key issuance, rotation and tenant enrollment remain the host application's responsibility. The dedicated AuthFn acceptance test issues and revokes actual keys through its authenticated API-key plugin routes and uses the real provider. It uses AuthFn repository source with the current shared stack; the older published AuthFn dependency closure is not validated.

## Routes and persistence contract

- `POST /feedback`: JSON `{feedback, context: {source: "in_app", user: {id, traits} | null}}`. Requires write scope. Title/body/category and optional tags, attachments, priority and score are validated before writes. Unknown authority fields are rejected. Default request limit is 65,536 bytes.
- `Idempotency-Key`: 1–128 ASCII letters/digits/dot/underscore/colon/hyphen. SDKs generate it once per call. A tenant-scoped digest is the row primary key. Matching actor and canonical payload replay returns 200; first committed write returns 201; conflicting reuse returns 409. Both success responses contain `{id, accepted: true}`. Omitted keys are generated server-side and cannot deduplicate independent callers.
- `GET /feedback/:id`: requires read scope, filters by authenticated tenant and ID, and returns stored payload, authoritative actor, timestamp, current status, authoritative vote score and the caller's vote. Missing or another tenant's row returns 404. Client identity/traits remain untrusted metadata.
- Invalid input returns 400, oversized input 413, and persistence failures 503. Responses disable caching. Explicit CORS origins support browser preflights without cookies.

The service wraps the incoming shared adapter with its own schema. Create the actual `userfn_feedback` table before serving traffic; `id` must have a primary-key/unique constraint for race-safe idempotency. `getUserFnSchema()` exposes fields and indexes. This package does not create tables, close caller-owned adapters or claim that a memory adapter is durable. Idempotency lasts while its row is retained; no TTL/retention worker is implemented.

## Validation and current limits

Run `npm test --workspace=@userfn/service` for service contract tests, `npm run test:native --workspace=@userfn/service` for file-backed SQLite, actual loopback HTTP, and both SDKs, and `npm run test:authfn --workspace=@userfn/service` for real AuthFn issuance/revocation through its provider. The latter uses AuthFn memory storage and UserFn file-backed SQLite; it does not prove durable AuthFn credentials. Native acceptance requires a compatible better-sqlite3 build and `uv` with Python 3.10. It closes and reopens SQLite before reading both languages' submissions; it also covers response loss after commit, concurrent duplicate/conflicting keys, tenant isolation and database failure.

This checkpoint implements feedback submission/readback, not the complete UserFn product. Config delivery, external sources, offline queues, moderation, retention, rate limiting, deployment and real browser/framework/hosted-provider acceptance remain open. PostgreSQL/MySQL/other adapters are not validated here. Local SQLite reopen proves that local storage boundary, not hosted durability or disaster recovery. HTTPS termination and narrowly scoped browser credentials are deployment responsibilities.

## Feedback board, voting and moderation

`GET /feedback?limit=20&after=<cursor>&status=planned` requires `userfn:feedback:read` and returns `{items, nextCursor}`. Limit is 1–100; the default is 20. `after` is the prior page's cursor. Items are sorted by ID ascending and contain title, body, category, tags, status, createdAt, votes and viewerVote. They exclude client identity/traits and the authenticated actor. Unknown/repeated query parameters and invalid filters return 400. Status is optional and uses `open`, `planned`, `in_progress`, `done`, `closed`. Pagination is a live view, not a retained snapshot: keep filters fixed across pages; newly inserted earlier IDs or concurrent status changes can change the visible set. Tag/product-area filtering and vote-ranked sorting remain unimplemented.

`POST /feedback/:id/vote` takes `{direction: -1 | 0 | 1}` and requires `userfn:feedback:vote`. A unique row per tenant, feedback item and authenticated actor type/ID stores the current direction. Zero removes the row. Repeating a direction/removal is idempotent; concurrent changes use the last committed mutation. Response is `{id, votes, viewerVote}`. Client `identify()` and traits never select the voter. An API-key actor gets one vote **per key**, not per human; use verified user bearer principals for per-user voting. Anonymous voting is not enabled, and merely sharing a tenant credential does not establish individual users.

`PATCH /feedback/:id/status` takes `{status}` and requires `userfn:feedback:moderate`; it returns `{id, status}`. Repeated updates are idempotent; concurrent moderation uses the last committed update. Other tenants' items return 404. Read, write, vote and moderate permissions are independent; browser write keys should not receive moderation scopes.

Apply the new `userfn_feedback_votes` table before upgrading an existing feedback service, including its unique/primary `id` constraint and tenant/item/direction index from `getUserFnSchema()`. The old feedback-row `votes` field is retained for schema compatibility but is no longer authoritative. Existing submissions had zero votes and need no vote backfill.

Scores and viewer votes come from one projected database query, avoiding independently racing positive/negative counts or denormalized counter increments. `maxVotesPerFeedback` bounds that projection: default 10,000, configurable integer range 1–100,000. Exceeding it returns 503 rather than a truncated total. A vote may already have committed before its response projection exceeds the bound; reconcile through idempotent direction/removal or increase the configured bound. Listing fails rather than omitting an item's unavailable score. Scalable database aggregation is an outstanding gate; this is not an arbitrary-scale voting implementation. Board SDK responses are capped at 16 MiB; mutation receipts retain the 64 KiB bound.

The native suite now also exercises 20 concurrent actors, duplicate same-actor submissions, concurrent direction flips, repeated removals, cursor continuity, scope denial, status filtering, both SDKs, and scores/status surviving SQLite reopen. Other adapter concurrency guarantees remain unvalidated.
