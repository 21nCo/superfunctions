# Full Audit: PlugFn Production-Readiness Plan vs Implemented Code

## Metadata

- **Date**: 2026-05-19
- **Audit ID**: p7x4k2m9
- **Agent**: unknown-agent
- **Model**: GPT-5 (Codex)
- **Launcher**: Codex Desktop
- **Repository**: superfunctions
- **Branch**: next
- **Commit audited**: 19a2a92f
- **Workspace state**: dirty working tree with PlugFn implementation changes and unrelated pre-existing `.conduct/pr-reports/*` files
- **Audit mode**: read-only code audit, except this report and `.conduct/logs.csv`

## Scope

This audit compares the production-readiness plan in `plugfn/.conduct/production-readiness-plan.md` against the current implemented code under:

- `plugfn/typescript`
- `plugfn/client`
- `plugfn/providers`
- `plugfn/cli`
- `plugfn/docs`
- `plugfn/scripts/gate-plugfn-release.mjs`

The audit focuses on whether PlugFn is production-ready as a drop-in integration runtime for Fellotron and future Nucleum integrations, with GitHub, Linear, Notion, Gmail, and broader Google-family provider support.

## Inputs

- Plan artifact: `plugfn/.conduct/production-readiness-plan.md`
- Implementation files listed by `git status --short`
- Core runtime/router/storage/types source files
- Client and provider package manifests/source files
- CLI entrypoint
- Release gate script
- Previous same-task gate result from `npm run gate:plugfn-release`: passed
- Current whitespace check from `git diff --check`: passed

## Executive Verdict

**Not production-ready yet.**

The implementation moved in the right direction and fixed the most visible package-boundary problem: provider implementations are no longer in the main `plugfn` source tree, and a new `@plugfn/client` plus `@plugfn/providers` package exist. The full PlugFn release gate also passed after the split.

However, compared with the plan, the current code is still a **foundation pass**, not a production-ready drop-in replacement. The biggest remaining gaps are authorization enforcement, webhook verification state correctness, real sync/backfill execution, typed provider registration/action APIs, provider-specific production gates, and Postgres-safe storage defaults.

## Top Findings

### F-001: ID-based routes bypass owner authorization

- **Severity**: Critical
- **Status**: Fail
- **Requirement**: Plan lines 619-625 require connection ownership enforcement on every operation and client routes that do not trust caller-supplied identity.
- **Evidence**:
  - `plugfn/typescript/src/router/http-router.ts:206-216` returns a connection by `connectionId` without checking that it belongs to the authenticated user, tenant, organization, or delegated grant.
  - `plugfn/typescript/src/router/http-router.ts:389-398` creates sync jobs for any submitted `connectionId` without verifying that the connection belongs to the caller.
  - `plugfn/typescript/src/router/http-router.ts:425-456` lists, reads, and cancels sync jobs by filters/job ID without owner scoping.
  - `plugfn/typescript/src/router/http-router.ts:483-488` upserts checkpoints for arbitrary `connectionId` and resource.
  - `plugfn/typescript/src/core/connection-manager.ts:250-259` can filter by owner, but the router does not consistently pass owner context.
- **Impact**: An authenticated caller who can guess or obtain IDs may read another connection, create/cancel sync jobs for it, or alter checkpoints. This blocks production use.
- **Recommendation**: Add a single authorization guard for connection-scoped operations. Every route accepting `connectionId`, `jobId`, `checkpoint`, grant ID, or receipt replay should resolve the resource and enforce owner/tenant/grant policy before returning or mutating it.

### F-002: Webhook receipt is marked verified before provider verification succeeds

- **Severity**: High
- **Status**: Fail
- **Requirement**: Plan lines 610-617 require raw body preservation, signatures verified before processing, idempotency/replay protection, and failed delivery tracking.
- **Evidence**:
  - `plugfn/typescript/src/router/http-router.ts:583-599` persists a receipt with `verificationStatus: secret ? 'verified' : 'not-required'`.
  - `plugfn/typescript/src/router/http-router.ts:607-614` only calls the provider webhook handler, where signature verification happens, after the receipt and delivery have already been created.
  - If verification fails, the catch block updates only the delivery at `plugfn/typescript/src/router/http-router.ts:626-630`; the receipt remains recorded as verified.
- **Impact**: Audit trails can falsely claim forged webhook payloads were verified. Replay/idempotency decisions may be made against an incorrectly trusted receipt.
- **Recommendation**: Verify the raw body before creating a `verified` receipt. Persist failed receipts as `failed` with redacted failure metadata. Treat idempotency as a provider-specific replay guard, not only as stored metadata.

### F-003: Sync/backfill is metadata CRUD, not durable sync execution

- **Severity**: High
- **Status**: Fail
- **Requirement**: Plan lines 260-292 require `plug.sync.backfill`, `plug.sync.incremental`, pagination, checkpoints, rate limits, retries/backoff, cancellation, progress, authorization, checkpoint contracts, and summaries.
- **Evidence**:
  - `plugfn/typescript/src/core/plug-fn.ts:95-109` exposes runtime sync storage methods only.
  - `plugfn/typescript/src/core/plug-fn.ts:280-290` delegates directly to storage; there is no sync runner or provider sync-resource executor.
  - `plugfn/typescript/src/router/http-router.ts:366-490` creates, lists, cancels jobs, and upserts checkpoints but does not execute provider sync work.
  - Gmail and Outlook provider actions contain some sync logic (`plugfn/providers/src/gmail/index.ts:149-281`, `plugfn/providers/src/outlook/index.ts:234-275`), but it is action-local and uses provider default stores, not PlugFn runtime jobs/sinks.
- **Impact**: Consumers still need to hand-roll the backfill/webhook/sync glue that the plan said PlugFn should own.
- **Recommendation**: Add a sync engine in core that resolves connection ownership, invokes provider sync definitions, advances runtime checkpoints, applies retry/backoff/cancel semantics, persists counters, and calls registered sinks.

### F-004: Type-safe provider registration/action API is not implemented

- **Severity**: High
- **Status**: Partial/Fail
- **Requirement**: Plan lines 365-388 require `.use(provider)` and typed provider access while keeping dynamic `plug.action`.
- **Evidence**:
  - `plugfn/typescript/src/core/plug-fn.ts:347-354` keeps runtime `providers.register`.
  - `plugfn/typescript/src/core/plug-fn.ts:378-412` still builds provider action proxies through `Proxy` and `any`.
  - `plugfn/typescript/src/types/provider.ts:94-108` retains the older `Provider<TActions>` shape instead of the planned provider definition with capabilities, webhooks, sync, and policies.
  - `plugFn(config).use(...)` and `plug.action(...)` were not found in the core implementation.
- **Impact**: The SDK does not yet deliver the type-safety goal, and provider packages cannot express the production metadata the core needs for scalable routing, sync, and policy.
- **Recommendation**: Introduce a typed `PlugFnProviderDefinition` and builder API, preserving `providers.register` as a compatibility layer. Generate dynamic access from provider generics, and add a typed dynamic `plug.action(provider, action, input)`.

### F-005: Runtime storage defaults do not use `plugfn_*` table names

- **Severity**: Medium
- **Status**: Fail
- **Requirement**: Plan lines 148-164 require `plugfn_*` runtime table names and avoiding collisions with consumer app tables.
- **Evidence**:
  - `plugfn/typescript/src/storage/adapters/database.ts:34-50` defaults to `connections`, `oauth_states`, `provider_installations`, `sync_jobs`, etc. instead of `plugfn_connections`, `plugfn_oauth_states`, `plugfn_provider_installations`, `plugfn_sync_jobs`, etc.
  - `plugfn/typescript/src/storage/adapters/database.ts:52-65` lists only legacy required models and does not include new runtime models.
- **Impact**: In Nucleum/Fellotron, model-name collisions are plausible, especially for generic names like `connections`, `workflows`, and `action_logs`.
- **Recommendation**: Change new default model names to the planned `plugfn_*` names, add migration guidance for legacy names, and include all required runtime models in the doctor/gate checks.

### F-006: Provider package split is real but not yet the scalable final shape

- **Severity**: Medium
- **Status**: Partial
- **Requirement**: Plan lines 46-62 target a small core plus provider packages, allowing a migration stage under `plugfn/providers/*`.
- **Evidence**:
  - Core source provider directory is deleted, and provider exports moved to `plugfn/providers/src/index.ts:15-28`.
  - Package `plugfn/providers/package.json` publishes a single aggregate `@plugfn/providers` package, not individual `@plugfn/provider-github`, `@plugfn/provider-linear`, etc. packages.
  - `plugfn/providers/package.json` has an export pattern `"./*": { "types": "./dist/*.d.ts", "default": "./dist/*.js" }`, but the source tree compiles nested files such as `dist/github/index.js`; subpath export behavior should be verified before publishing.
- **Impact**: This is much better than providers in core, but it still centralizes provider releases and may not scale cleanly to hundreds of providers.
- **Recommendation**: Either publish independent provider workspaces or explicitly document `@plugfn/providers` as a temporary bundle. Fix/verify subpath exports such as `@plugfn/providers/github`.

### F-007: Route contract is incomplete

- **Severity**: Medium
- **Status**: Partial
- **Requirement**: Plan lines 564-590 define the production route contract.
- **Evidence**:
  - Present: `/providers`, `/connections`, `/connections/start`, `/connections/callback/:provider`, `/connections/disconnect`, `/sync/jobs`, `/sync/jobs/:jobId`, `/sync/jobs/:jobId/cancel`, `/webhooks/:provider`, `/webhooks/:provider/:event`, `/metrics`.
  - Missing: `POST /connections/revoke`, `GET /connections/:connectionId/status`, `GET /events`.
  - Existing `GET /connections/:connectionId` differs from the client status route and currently has the authorization gap described in F-001.
- **Impact**: Consumers cannot rely on the documented API contract without custom route work.
- **Recommendation**: Add the missing routes, keep legacy routes explicitly versioned, and add route-level contract tests.

### F-008: Browser client exists, but it exposes unsupported sync/checkpoint APIs

- **Severity**: Medium
- **Status**: Partial
- **Requirement**: Plan lines 166-184 require a browser-safe SDK for install, status, list, and disconnect.
- **Evidence**:
  - `plugfn/client/src/index.ts:32-48` includes safe lifecycle methods, but also includes sync job and checkpoint mutation APIs.
  - `plugfn/client/src/index.ts:99-101` implements `getConnectionStatus(connectionId)`, while the plan example expects provider-level status input.
  - `plugfn/client/src/index.ts:176-178` binds `globalThis.fetch` directly, which can throw in runtimes where fetch is absent before a clear SDK error can be produced.
- **Impact**: The client package is useful but currently ahead of the backend guarantees for sync/checkpoint security and execution.
- **Recommendation**: Keep browser APIs lifecycle/status first. Gate sync APIs behind server authorization fixes and a real sync engine, or move dangerous sync operations to a server-only client.

### F-009: Persistence sinks are not yet a drop-in DB persistence capability

- **Severity**: Medium
- **Status**: Partial
- **Requirement**: Plan lines 315-363 require sinks plus a Postgres-first `createDbSink` helper.
- **Evidence**:
  - Sink types exist in `plugfn/typescript/src/types/runtime.ts:149-166`.
  - Runtime registry/persist exists in `plugfn/typescript/src/core/plug-fn.ts:299-326`.
  - No `createDbSink` helper package or helper export was found.
  - Sync/webhook flows do not automatically invoke sinks as the Fellotron target path requires.
- **Impact**: Consumers still need to manually connect sync/webhook outputs to app tables.
- **Recommendation**: Add `@plugfn/persistence-db` or a core helper that uses `@superfunctions/db`, and invoke sinks from the sync engine and webhook delivery pipeline.

### F-010: Provider readiness remains provider-specific, but provider gates are not provider-specific

- **Severity**: Medium
- **Status**: Partial
- **Requirement**: Plan lines 660-685 require provider-specific production gates in addition to the global gate.
- **Evidence**:
  - `plugfn/scripts/gate-plugfn-release.mjs:27-115` now builds/tests TypeScript, client, providers, CLI, and Python.
  - `plugfn/scripts/gate-plugfn-release.mjs:160-188` checks docs inventory and provider matrix presence by string matching.
  - No provider-specific gate commands for GitHub, Linear, Gmail, or Notion were implemented.
  - No Postgres integration, sync backfill/resume, webhook replay/idempotency, or security redaction tests were found in the gate script.
- **Impact**: A green gate means the package compiles and unit tests pass, not that a given provider is production-ready.
- **Recommendation**: Add provider gates with real mocked OAuth, webhook replay, sync/resume, DB adapter, and redaction coverage. Keep the global gate as an aggregate of provider gates.

## Requirement Traceability

| Requirement | Plan Evidence | Implementation Evidence | Status |
| --- | --- | --- | --- |
| Provider code removed from core | Lines 46-62 | Core provider source deleted; providers in `plugfn/providers` | Pass |
| Core does not need code change for every provider | Lines 46-62 | Core has registry, but provider shape is still old and aggregate bundle is used | Partial |
| Runtime secrets outside provider constructors | Lines 38-44, 78-118 | Secret resolver types exist in runtime types; provider constructors mostly static | Partial |
| User/org/delegated owner model | Lines 121-147 | Owner types and connection metadata exist | Partial |
| Owner enforcement on every operation | Lines 619-625 | Major route gaps for connection/sync/checkpoint IDs | Fail |
| `plugfn_*` storage names | Lines 148-164 | Defaults remain generic names | Fail |
| Browser client SDK | Lines 166-184 | `@plugfn/client` exists | Partial |
| Deterministic provider-not-registered errors | Lines 180-184 | Router wraps errors, but core throws generic `Error` in `getAuthUrl` | Partial |
| Raw body webhook handling | Lines 610-613 | Raw body is preserved and passed | Pass |
| Webhook signature status correctness | Lines 610-617 | Receipt marked verified before verification | Fail |
| Webhook idempotency/replay protection | Lines 610-617 | Idempotency key stored; no duplicate enforcement verified | Partial |
| Webhook delivery tracking | Lines 245-257, 617 | Delivery records exist | Partial |
| Sync job model | Lines 294-312 | Job/checkpoint types and storage exist | Pass |
| Durable sync execution | Lines 260-292 | No core runner/backfill/incremental API | Fail |
| Cancellation semantics | Lines 281-292 | Job status can be set cancelled; no running worker contract | Partial |
| Persistence sink contract | Lines 315-330 | Sink type/registry exists | Partial |
| Postgres DB sink helper | Lines 352-363 | Not found | Fail |
| Typed `.use(provider)` | Lines 365-379 | Not found | Fail |
| Dynamic `plug.action` | Lines 381-388 | Not found | Fail |
| Provider definition with capabilities/sync/webhooks/policies | Lines 400-435 | Old provider interface remains | Fail |
| GitHub provider target | Lines 438-449 | Actions/webhooks exist, but org installation ownership and full target not verified | Partial |
| Linear provider target | Lines 451-460 | Actions/webhooks exist, ownership incomplete | Partial |
| Gmail target | Lines 462-475 | Sync/watch actions exist, but use provider-local default stores and no core sync/sink wiring | Partial |
| Notion target | Lines 477-488 | OAuth/actions exist; normalized types and import/sync missing | Partial/Fail |
| Google provider split | Lines 490-498 | Gmail exists separately; no vague Google provider detected in first-party exports | Pass |
| Fellotron current safe path | Lines 500-518 | OAuth/list/status/disconnect mostly present, but status route and auth gaps remain | Partial |
| Fellotron production target | Lines 519-563 | Gmail sink/backfill/PubSub route workflow not implemented end-to-end | Fail |
| Route contract | Lines 564-590 | Some routes present; revoke/status/events missing | Partial |
| CLI contract | Lines 636-659 | CLI has init/generate-types/add-provider/test only | Fail |
| Global release gate | Lines 660-678 | Gate exists and passed | Partial |
| Provider-specific gates | Lines 679-685 | Not implemented | Fail |

## Package Boundary Inventory

### Core `plugfn`

Good:

- No `plugfn/typescript/src/providers` directory remains.
- Core exports provider-authoring support instead of first-party provider implementations.
- Runtime state primitives were added for installations, grants, webhooks, sync, events, secret refs, and sinks.

Gaps:

- `PlugFn` still has dynamic provider access through `Proxy` and `any`.
- Core still owns generic runtime methods without a production policy/sync engine.
- Core route layer does not consistently enforce actor/owner authorization.

### `@plugfn/providers`

Good:

- First-party providers are now outside the main package.
- GitHub, Linear, Gmail, Notion, and mail-related providers are exported from the provider package.
- Provider tests moved to provider package.

Gaps:

- This is one aggregate package, not individual provider packages.
- Provider definitions still use the old `Provider` interface.
- Notion returns `z.unknown()` across actions and has no sync/backfill contract.
- Gmail/Outlook sync actions are provider-local, not integrated with core durable runtime jobs.

### `@plugfn/client`

Good:

- Browser-safe client package exists.
- It covers provider listing, connection listing, start, status by connection, and disconnect.
- It does not expose tokens or provider secrets.

Gaps:

- It exposes sync/checkpoint mutation before the backend security and sync execution contracts are complete.
- `getConnectionStatus` differs from the plan example.
- Fetch absence can fail with a low-quality runtime error.

### `plugfn/cli`

Good:

- CLI builds and has tests in the gate.
- Existing commands remain wired.

Gaps:

- Required production commands are missing: `providers list`, `providers inspect`, `connections list`, `sync backfill`, `webhooks replay`, and `doctor`.

## Security Assessment

### Passing/Improved

- Browser client does not expose tokens or secrets.
- Webhook raw body is preserved.
- Headers are redacted for receipts.
- OAuth state metadata now carries owner data.

### Blocking

- Connection ownership is not enforced on every route.
- Sync/checkpoint routes are not owner-scoped.
- Webhook receipt verification state can be false-positive.
- Org admin and delegated grant hooks are only modeled, not enforced.
- Provider action execution authorization is not visibly tied to actor/grants.
- Release gate does not include security redaction tests.

## Fellotron/Nucleum Drop-In Readiness

### Current Safe Use

PlugFn can be used as a starting point for:

- OAuth start/callback experiments.
- Basic connection list/disconnect flows after route authorization is fixed.
- Provider action execution where the consumer app wraps authorization externally.
- Browser install initiation through `@plugfn/client`.

### Not Safe As Drop-In Yet

It is not yet safe as a full Fellotron or Nucleum integration replacement because:

- It does not fully own sync/backfill execution.
- It does not own Gmail Pub/Sub to incremental sync to sink persistence.
- It does not safely expose sync/checkpoint routes.
- It lacks provider-specific production gates.
- It lacks the typed provider API promised for consumers.

## Verification Commands

Commands run or reviewed during this implementation/audit cycle:

```bash
git status --short
git branch --show-current
git rev-parse --short HEAD
test ! -d plugfn/typescript/src/providers
test ! -d plugfn/typescript/dist/providers
npm run gate:plugfn-release
git diff --check
rg -n "use\\(|PlugFnProviderDefinition|plug\\.action|backfill|incremental|createDbSink|plugfn_" plugfn/typescript/src plugfn/providers/src plugfn/client/src plugfn/docs plugfn/.conduct/production-readiness-plan.md
nl -ba plugfn/typescript/src/router/http-router.ts
nl -ba plugfn/typescript/src/core/plug-fn.ts
nl -ba plugfn/typescript/src/storage/adapters/database.ts
nl -ba plugfn/typescript/src/types/provider.ts
nl -ba plugfn/client/src/index.ts
nl -ba plugfn/providers/src/index.ts
nl -ba plugfn/providers/src/notion/index.ts
nl -ba plugfn/scripts/gate-plugfn-release.mjs
```

Result summary:

- `npm run gate:plugfn-release`: passed in the same implementation cycle.
- `git diff --check`: passed.
- Core provider directories: absent.
- Audit verdict remains blocked because behavior/security requirements exceed the current gate coverage.

## Recommended Fix Order

1. **Authorization first**: route-level owner/tenant/grant enforcement for every connection/job/checkpoint/receipt/action operation.
2. **Webhook correctness**: verify signatures before marking receipts verified; persist failed verification receipts accurately; enforce replay/idempotency.
3. **Storage naming and schema gate**: switch defaults to `plugfn_*`, include all runtime models in required schema checks, and add migration docs.
4. **Provider contract v2**: introduce `PlugFnProviderDefinition` with actions, webhooks, sync resources, capabilities, policies, and error normalization.
5. **Typed SDK surface**: add `.use(provider)` and `plug.action`, while keeping `providers.register` as compatibility.
6. **Sync engine**: implement `plug.sync.backfill` and `plug.sync.incremental` with resumable jobs, checkpoints, retries/backoff, cancellation, and sink invocation.
7. **Persistence DB helper**: add a Postgres-first `createDbSink` helper over `@superfunctions/db`.
8. **Client trim/hardening**: keep browser lifecycle methods stable; gate or move sync mutations until authorization and sync execution are complete.
9. **CLI**: implement providers/connections/sync/webhook/doctor commands from the plan.
10. **Provider gates**: add provider-specific gates for GitHub, Linear, Gmail, and Notion with mocked OAuth/webhooks/sync and DB-backed checks.

## Appendix: Requirement Source Highlights

- Product contract: `plugfn/.conduct/production-readiness-plan.md:13-27`
- Readiness principles: `plugfn/.conduct/production-readiness-plan.md:36-44`
- Target package shape: `plugfn/.conduct/production-readiness-plan.md:46-62`
- Required runtime tables: `plugfn/.conduct/production-readiness-plan.md:148-164`
- Browser client SDK: `plugfn/.conduct/production-readiness-plan.md:166-184`
- Sync/backfill: `plugfn/.conduct/production-readiness-plan.md:260-292`
- Persistence sinks: `plugfn/.conduct/production-readiness-plan.md:315-363`
- Type safety: `plugfn/.conduct/production-readiness-plan.md:365-388`
- Provider system: `plugfn/.conduct/production-readiness-plan.md:400-435`
- Target providers: `plugfn/.conduct/production-readiness-plan.md:436-499`
- Fellotron path: `plugfn/.conduct/production-readiness-plan.md:500-563`
- Route contract: `plugfn/.conduct/production-readiness-plan.md:564-590`
- Security requirements: `plugfn/.conduct/production-readiness-plan.md:592-635`
- CLI requirements: `plugfn/.conduct/production-readiness-plan.md:636-659`
- Release gates: `plugfn/.conduct/production-readiness-plan.md:660-685`
