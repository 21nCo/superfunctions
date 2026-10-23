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

`GET /feedback?limit=20&after=<cursor>&status=planned` requires `userfn:feedback:read` and returns `{items, nextCursor}`. Limit is 1–100; the default is 20. `after` is the prior page's cursor. Items are sorted by ID ascending and contain title, body, category, tags, status, createdAt, votes and viewerVote. They exclude client identity/traits and the authenticated actor. Unknown/repeated query parameters and invalid filters return 400. Status is optional and uses `open`, `planned`, `in_progress`, `done`, `closed`. Pagination is a live view, not a retained snapshot: keep filters fixed across pages; newly inserted earlier IDs or concurrent status changes can change the visible set. Tag and product-area filters are available after the migration below. Vote-ranked sorting remains unimplemented.

`POST /feedback/:id/vote` takes `{direction: -1 | 0 | 1}` and requires `userfn:feedback:vote`. A unique row per tenant, feedback item and authenticated actor type/ID stores the current direction. Zero removes the row. Repeating a direction/removal is idempotent; concurrent changes use the last committed mutation. Response is `{id, votes, viewerVote}`. Client `identify()` and traits never select the voter. An API-key actor gets one vote **per key**, not per human; use verified user bearer principals for per-user voting. Anonymous voting is not enabled, and merely sharing a tenant credential does not establish individual users.

`PATCH /feedback/:id/status` takes `{status}` and requires `userfn:feedback:moderate`; it returns `{id, status}`. Repeated updates are idempotent; concurrent moderation uses the last committed update. Other tenants' items return 404. Read, write, vote and moderate permissions are independent; browser write keys should not receive moderation scopes.

Apply the new `userfn_feedback_votes` table before upgrading an existing feedback service, including its unique/primary `id` constraint and tenant/item/direction index from `getUserFnSchema()`. The old feedback-row `votes` field is retained for schema compatibility but is no longer authoritative. Existing submissions had zero votes and need no vote backfill.

Scores and viewer votes come from one projected database query, avoiding independently racing positive/negative counts or denormalized counter increments. `maxVotesPerFeedback` bounds that projection: default 10,000, configurable integer range 1–100,000. Exceeding it returns 503 rather than a truncated total. A vote may already have committed before its response projection exceeds the bound; reconcile through idempotent direction/removal or increase the configured bound. Listing fails rather than omitting an item's unavailable score. Scalable database aggregation is an outstanding gate; this is not an arbitrary-scale voting implementation. Board SDK responses are capped at 16 MiB; mutation receipts retain the 64 KiB bound.

The native suite now also exercises 20 concurrent actors, duplicate same-actor submissions, concurrent direction flips, repeated removals, cursor continuity, scope denial, status filtering, both SDKs, and scores/status surviving SQLite reopen. Other adapter concurrency guarantees remain unvalidated.

## Tag and product-area filters: migration required

Submissions accept optional `productArea` (1–100 characters) alongside existing tags. Filter keys and displayed values use Unicode NFC normalization and surrounding-whitespace trimming, with case-sensitive matching. Tags deduplicate after normalization. The original submission payload/fingerprint remains unchanged so retries of earlier submissions keep their original receipt identity.

Both new and existing installations must apply the three additive tables from `getUserFnSchema()`: `userfn_feedback_attributes`, `userfn_feedback_tags`, and `userfn_feedback_migrations`, including their unique IDs and indexes. No existing feedback columns or payloads are rewritten.

Run the migration in maintenance mode with **all writers stopped**, including older service versions. Use one migration worker:

```typescript
import { backfillFeedbackFilters } from '@userfn/service';
// First apply getUserFnSchema() through the shared database migration workflow.
for (;;) {
  const progress = await backfillFeedbackFilters(database, { batchSize: 100 });
  if (progress.done) break;
}
// Start the new service only after completion. Do not resume older writers.
```

Each bounded batch (1–500 rows) commits normalized data and a persisted cursor together. Failed batches roll back; rerunning resumes from the last committed cursor. Repeated calls after completion are harmless. The global readiness marker changes to `ready` only after the complete scan. Filtered reads fail with 503 while the marker is absent/incomplete, and submissions are blocked when a committed migration marker says `building`. Existing submission replay remains available. New submissions atomically write feedback and normalized rows through shared DB transactions; adapters without transaction support fail closed. An empty installation still needs the migration call to mark filters ready. Restoring/importing legacy rows after completion or running multiple migration workers is outside this migration contract.

Use `GET /feedback?tag=UI&productArea=Search&status=open`; each filter is optional and combines with status and the existing cursor. Each normalized lookup is tenant-scoped. `maxFilterCandidates` defaults to 500 and accepts 1–500; it now means the maximum candidates **scanned per request**, not a ceiling on total matches. Candidate queries use chunks of at most100 IDs. With both filters, the tag index drives the scan and product area/status narrow each chunk.

When the requested page fills within a chunk, `nextCursor` is the last returned match, preserving all unreturned matches. When the scan budget ends first, `nextCursor` advances past the consumed candidates and the page may be partial or empty. Continue until `nextCursor === null`; never stop merely because an item list is empty or shorter than `limit`. A full final page may be followed by one empty terminal page. Keep filters unchanged during traversal. More than500 matching rows are traversable across requests without truncation or a candidate-overflow503. The existing migration readiness gate and vote-projection bound still apply independently.

This remains live keyset pagination, not a snapshot. Concurrent insertions before a cursor and status/filter changes may alter the traversal; static-data acceptance verifies no missing or duplicate matches. Per-request work is bounded, but full traversal of a very broad/sparse filter can require many requests. Snapshot export, ranked sorting and aggregate pushdown are separate requirements.

The SQLite migration acceptance starts with only the prior tables and 501 legacy rows, checks fail-closed reads before/partway through backfill, interrupts and resumes a batch, verifies atomic rollback, reopens the database, and confirms unchanged payloads/fingerprints and original receipt replay. Both SDKs exercise tag/product-area/status combinations over actual HTTP. Moderator metadata updates are described below. Duplicate merging, ranking and moderation history remain separate work.


## Moderator tags and product area

`PATCH /feedback/:id/metadata` requires `userfn:feedback:moderate` and accepts a nonempty JSON object with `tags` and/or `productArea`. Tags replace the complete set (up to 20 strings, each 1–64 characters); `[]` clears them. A product area is a 1–100 character string; `null` removes the assignment. Omitted fields remain unchanged. Labels use the same NFC/trim normalization and case-sensitive semantics as submission and filtering. Unknown fields, including tenant/actor/scopes, are rejected. Other tenants' IDs return 404; insufficient scope returns 403.

The normalized-table backfill must be complete before moderation; otherwise the operation returns 503. No additional schema migration is needed. The service requires transaction support, updates the existing attributes row to serialize same-item SQL mutations, and commits tag replacement and area assignment together. Storage/commit failures return 503 without acknowledgment. Repeating a patch sets the same requested fields; concurrent updates to the same field follow the database's serialization order. An automatic retry can therefore supersede another moderator's intervening edit; no optimistic version check is provided.

Successful receipts are `{id, tags, productArea}` with the current normalized metadata. Board items show these current values, and board filters immediately use the updated projections after commit. `GET /feedback/:id` adds `metadata: {tags, productArea}` while retaining the immutable original `payload`; submission fingerprints and idempotency receipts are unchanged. Replaying the original submission never restores old metadata. Do not restart old writers or rerun backfill with a deleted readiness marker after moderation: the original payload is submission history, not the current metadata source.

Native SQLite acceptance covers both actual SDK transports, concurrent complete tag replacements and disjoint-field updates, failed transaction rollback, clearing, tenant/scope rejection, original submission replay and close/reopen persistence. Other adapter isolation/locking behavior remains unvalidated; deployment must validate the chosen shared adapter. No moderation audit history or arbitrary-scale vote aggregation is added here.


## Signed flag configuration

Pass `flagConfigSigning: { privateKey, keyId }` to `createUserFnService` to enable
`GET/PUT /config/:environment`. The host supplies an Ed25519 private KeyObject or
PEM string and a stable key ID; keys are not generated, persisted or logged by
UserFn. Apply the additional `userfn_flag_config` table from `getUserFnSchema()`
before enabling these routes. Existing feedback migrations do not create it.

Authentication uses the same configured shared auth provider and trusted tenant
mapping as feedback. Readers require `userfn:config:read`; publishers require
`userfn:config:write`. Permissions cover environments within the authenticated
tenant. Environment identifiers use 1–100 ASCII letters/digits/underscore/dot/
hyphen and must begin with a letter or digit. No anonymous config endpoint is
introduced.

Publish a complete `{ flags: FlagConfig[], segments: Segment[] }` JSON snapshot.
Use `If-None-Match: *` to create, then the prior strong `ETag` in `If-Match` to
replace it. Missing conditions return 428, invalid conditions 400 and competing
or stale writes 412. Writes use the database transaction and conditional update;
there is no unconditional overwrite. A failed/lost response can be reconciled by
an authenticated GET. This table stores the latest snapshot, not revision history.
The router defaults to a 64 KiB streamed request limit; independently, canonical
configuration is capped at 256 KiB, 1,000 flags, 1,000 segments and 20 JSON levels.
Invalid definitions leave the previous snapshot intact.

A successful publication/fetch returns exact canonical JSON bytes containing
`version: 1`, `tenantId`, `environment`, UUID `revision`, `keyId`,
`algorithm: "Ed25519"`, `flags` and `segments`. Object keys are sorted using
JavaScript UTF-16 order; arrays preserve order and numbers follow JavaScript JSON
semantics. The `X-UserFn-Signature` header is base64url Ed25519 over **the exact
UTF-8 response bytes**, including all identity fields. Verify those bytes against
a pinned public key selected from a trusted key-ID map, require the fixed
algorithm/version and expected tenant/environment, and only then load values.
Do not reserialize JSON for verification or trust a key delivered in the payload.
Exact large identifiers belong in strings.

The strong ETag is the quoted SHA-256 of those bytes. Authenticated GET supports
`If-None-Match` and returns 304 with an empty body when unchanged. Responses use
`private, no-cache` and `Vary: Authorization`; configured CORS exposes ETag and
signature headers and permits conditional request headers. A 304 applies to an
already verified locally retained snapshot. Key rotation affects subsequent
publications; existing rows keep their original signature/key ID, so keep the
corresponding trusted public key until republishing.

Persistent client caches, exposures, a flag
administration UI and CDN integration remain separate requirements. Both SDKs now offer opt-in explicit verified refresh; their acceptance fixtures
verify this service response before applying it. Both SDKs also provide explicit start/awaitable stop for periodic refresh.

Built package acceptance is reproducible with
`node userfn/service/scripts/verify-config-package.mjs` from the repository root
after building SDK/service/shared dependencies. It installs fresh tarballs and
checks signed HTTP behavior plus strict installed declaration consumption.

Use npm 11 for this consumer check if npm 10 fails while resolving optional
peers. `USERFN_NPM_CLI=/absolute/path/to/npm/bin/npm-cli.js` selects an existing
CLI without changing the global installation or bypassing peer checks.

## Durable campaign caps

Apply `getUserFnSchema()` migrations and enable `messaging` with trusted
`resolvePolicy(session, campaignId)` and `resolveSession(session)` callbacks.
Policies return `{ enabled, perUser?, perSession? }`; sessions must identify a
verified application session, and bearer users need `userfn:messages:write`.
The service reserves capacity atomically before display and reconciles stable
idempotency keys. Uncertain display consumes its reservation.

See [the migration and delivery contract](../.conduct/durable-campaign-caps-readiness.md)
for SDK configuration, persisted pending/shown states and operational limits.

### Campaign schedules and cooldowns

The trusted messaging policy additionally accepts
`{ schedule: { startAt?, endAt? }, cooldownMs? }`. Schedule timestamps are UTC
Unix epoch milliseconds, consistent with SDK delivery timestamps. Start is
inclusive; end is exclusive. Omitted bounds are open. Values must be nonnegative
integers within the JavaScript Date range, start must precede end, and zero
cooldown is permitted. For example:

```ts
resolvePolicy: () => ({
  enabled: true, perUser: 10, perSession: 2,
  schedule: { startAt: Date.UTC(2026, 10, 1), endAt: Date.UTC(2026, 11, 1) },
  cooldownMs: 24 * 60 * 60 * 1000,
})
```

Cooldown is per verified tenant/user/campaign across sessions. It begins when a
reservation commits, including reservations that never render or never confirm.
Confirmation does not restart it, and failure/withdrawal does not refund it.
Time comes from the service wall clock; all instances need synchronized trusted
clocks. Backward time relative to the last reservation fails closed.

Apply the added `userfn_message_timing` and `userfn_message_receipt_timing` tables
from `getUserFnSchema()` before using this version, even when temporal policies
are omitted. Every admitted reservation records timing to support later policy
changes. Existing lifetime counters and receipts remain intact. Where historical
counters lack timing, enabling cooldown starts a conservative full interval on
the first request and denies that request. A legacy receipt without timing cannot
re-authorize a temporal campaign. Do not delete timing state to reset quotas.

Admission responses include `expiresAt`. Replay preserves the original end bound
and checks the current schedule; extending a campaign cannot revive an expired
reservation. Disabled or expired schedules deny render re-admission, while
`shown` still reconciles a prior side effect after campaign end or retirement.
A denied idempotency key remains denied: a later trigger uses a fresh key.
SDKs check expiry immediately before presentation/handoff. Their clocks must be
synchronized too; this is an admission and handoff policy, not remote cancellation
of already displayed UI. Offline delivery, dismissal policy, campaign CRUD,
bootstrap and survey per-time-window caps remain separate unfinished scope.

## Durable survey responses

Apply the additive `userfn_survey_counters` and `userfn_survey_responses` tables
and indexes returned by `getUserFnSchema()` before enabling `surveys`.
Configure a trusted `surveys.resolvePolicy(session, surveyId)` to return the
allowed user's survey questions, `enabled`, `perUser` (default one), and optional
`window: {limit, durationMs}`. Return null for surveys outside the user's audience.
The service snapshots this policy at request acceptance; clients cannot provide
policy, identity, or timestamps. The database adapter must support transactions.

Submit `POST /surveys/:surveyId/responses` with a bearer credential carrying
`userfn:surveys:write`, a stable `Idempotency-Key`, and
`{answers: [{questionId: "score", value: 8}]}`. Identity must resolve to a verified
user and tenant. Answer IDs must be unique and present in the trusted question
list; required questions, text bounds, configured choice values and integer scale
bounds are checked. Supported question types match the current SDK: nps, csat,
text and single choice. Branching and richer templates remain unfinished.

A successful response returns `{id, surveyId, submittedAt, accepted: true}` only
after the response and counters commit together. Retry identical data with the
same key after an unknown outcome. Conflicting reuse returns409. A committed
receipt remains replayable after survey retirement; it does not consume capacity
again. Lifetime and rolling-window cap denial returns429; disabled returns403.
The interval is `(now-durationMs, now]`, using the server clock. A backwards clock
relative to that user's latest acceptance returns503 until time catches up.

Caps count accepted responses, not display impressions. Transactions and a
counter compare-and-swap coordinate concurrent service instances. Keep historical
responses when changing rolling policies; deleting them changes rolling-cap
history. This API has no automatic retention, anonymous submission, response
listing, display reservation, or WatchFn outbox yet. TypeScript and Python SDKs
provide explicit response submission; they do not reserve display capacity. The existing
local survey renderer is not connected to this endpoint automatically.
