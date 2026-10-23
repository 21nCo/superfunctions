# PlugFn Production Readiness Audit

**Date**: 2026-05-19
**Auditor**: Droid (automated review)
**Scope**: `plugfn/` (TypeScript runtime, browser client, providers, CLI, Python runtime, docs, release gates)
**Reference commit baseline**: branch `next` (working tree dirty per `git status` at time of audit)
**Local gate result**: `npm run gate:plugfn-release` => `ok: true` (all 20 steps green; docs inventory clean)

## TL;DR

The release gate is green and the matrix-bounded readiness model is solid. PlugFn is in a defensible "production for a small core surface, experimental elsewhere" state. The core OAuth, webhook, owner/tenant, and sink primitives are well covered by tests. The biggest gaps blocking a wider, durable production claim are: in-process trigger/sync execution (no durable scheduler), webhook delivery retry/dead-letter loop, Notion Python parity, and global runtime concerns (registry, rotation, observability). None of these are critical for the currently `production`-marked TypeScript surface, but they are real for adoption beyond a single-process deployment.

Recommended posture:

- Keep current matrix-bounded language. Do not loosen the readiness vocabulary.
- Treat the four "production" TS surfaces (`github`, `linear`, `clickup`, `gmail`) and the four sub-products (`plugfn`, `@plugfn/client`, `@plugfn/providers`, `@plugfn/cli`) as production-ready *for single-process Postgres deployments* with the open issues below tracked.
- Treat `notion` (Python), all adjacent (`slack`, `discord`, `stripe`), and all vertical-only providers as not-yet-production per the existing matrix.

---

## 1. Repository state

| Surface | Path | Version | Status |
| --- | --- | --- | --- |
| TS runtime | `plugfn/typescript` | `0.0.1` | Builds, type-checks, 110 tests pass |
| Browser client | `plugfn/client` | `0.0.1` | Builds, typechecks, tests pass |
| Providers package | `plugfn/providers` | `0.0.1` | Builds, typechecks, tests pass |
| CLI | `plugfn/cli` | `0.0.1` (declared `1.0.0` in `src/index.ts`) | Builds, typechecks, tests pass |
| Python runtime | `plugfn/python` | `0.0.1` (declared `0.1.0` in `__init__.py`) | 27 tests pass |
| Release gate | `npm run gate:plugfn-release` | — | green |

> Version drift: CLI `package.json` is `0.0.1` but `Command#version('1.0.0')`; Python `pyproject.toml` is `0.0.1` but `__init__.py` exposes `__version__ = "0.1.0"`. Low risk, but should be aligned before publishing.

---

## 2. Release-gate proof

`npm run gate:plugfn-release` runs and passes 20 deterministic steps plus a docs-inventory check, exactly matching `docs/operations/release-gates.md`:

- TS clean/build/typecheck/test, E2E OAuth + webhook
- Client build/typecheck/test
- Providers clean/build/typecheck/test + per-provider gates (`github`, `linear`, `gmail`, `notion`)
- CLI build/typecheck/test
- Python `pytest plugfn/python/tests`
- Docs inventory (paths, package names, gate wording, core-provider coverage)

The gate is reproducible from the repo root and emits a single deterministic JSON envelope. This is a strong baseline.

---

## 3. Strengths

### 3.1 Security

- **Token encryption at rest**: AES-256-GCM with IV + auth tag (`typescript/src/utils/crypto.ts`); shared `EncryptedTokenVault` from `@superfunctions/oauth-storage`; legacy `SecureTokenStorage` retained as fallback for non-OAuth credentials only.
- **OAuth state**: bound to `tenantId`, `userId`, owner metadata, redirect URI; state is single-use (`consumed_at` asserted in e2e test); redirect URIs allowlisted via runtime config or per-tenant secret resolver.
- **Webhook signatures**: raw-body driven verification with `timingSafeEqual` (GitHub HMAC-SHA256 reference impl in `providers/src/github/index.ts`). E2E test proves raw bytes are passed through router → handler → provider verifier, and rejects when transmitted bytes diverge from signed bytes even if JSON parses identically.
- **Identity assertion guards**: router rejects caller-supplied `userId`/`tenantId` mismatching the authenticated principal (`TENANT_ACCESS_DENIED` with status 403, retryable=false).
- **Connection ownership enforcement**: `requireAuthorizedConnection` checks ownership for read/disconnect/revoke/sync/checkpoint operations, including `organization` and `delegated` owners with grant/role hooks.
- **Header redaction**: webhook headers persisted with `authorization|signature|secret|token` stripped before storage; `redactTelemetry` covers structured logs and metric dimensions, with pattern matching for `Bearer`, `xoxp`, `ghp`, `ya29`, emails.
- **Webhook payload size cap**: configurable `maxWebhookPayloadBytes` (default 2MB) with deterministic 413 error containing `maxBytes`.
- **Deterministic error envelope**: `{ ok, error: { code, message, status, retryable, details }, meta: { requestId, timestamp } }` for every router response; `meta.requestId` is randomBytes-derived per call.

### 3.2 Runtime model

- **Owner-aware contracts** (`user`, `organization`, `delegated` with grants and tenant scoping) propagate end-to-end through `connections.start`/`list`, sync jobs, webhook receipts, installations.
- **Persistent runtime storage**: `plugfn_connections`, `plugfn_oauth_states`, `plugfn_oauth_tokens`, `plugfn_provider_installations`, `plugfn_connection_grants`, `plugfn_webhook_receipts`, `plugfn_webhook_deliveries`, `plugfn_sync_jobs`, `plugfn_sync_checkpoints`, `plugfn_provider_events`, `plugfn_secret_refs`, `plugfn_workflows`, `plugfn_workflow_executions`, `plugfn_action_logs`.
- **Sync job lifecycle**: durable rows (queued → running → completed/failed), upsert-on-idempotency receipt creation, checkpoint upserts per (`connectionId`, `resource`).
- **Workflow idempotency**: re-execution of the same idempotency key returns the existing completed execution; per-step `completedStepIds` resume state is persisted in `__workflow` envelope. Delay steps fail closed with `WORKFLOW_DURABILITY_UNSUPPORTED` instead of pretending durability.
- **Persistence sinks**: contract supports `idempotencyKey`/`transform`/`upsert`/`delete`; `db-sink` helper exists; sinks are auto-resolved by `(provider, resource)` when no explicit sinkId is supplied.
- **Secret resolver hook**: `resolveOAuthClient(context)` is a first-class branch on the integration config; redirect URIs are still allowlisted from the resolved config.

### 3.3 Robustness

- **Retry middleware** honors `Retry-After` header (numeric or HTTP date), `error.retryAfterMs`, `error.retryAfterSeconds`, and converts `429` exhausted retries to `ProviderRateLimitedError` for surfacing.
- **Rate limiter** is a shared token-bucket abstraction with destruction semantics, snapshot inspection, and per-tenant key support.
- **HTTP router v2 prefix**: every canonical route is also exposed under `/v2/*`. Inventory is asserted by `router-auth.test.ts`.
- **Sync concurrency guard**: per-connection FIFO queue for `mail.sync` action prevents concurrent backfills clobbering each other.
- **Telemetry redaction assertion API** (`assertTelemetryRedacted`) enables guardrail tests in CI.

### 3.4 Testing

- 110 TS runtime tests, plus client/providers/CLI suites and an additional 27 Python tests.
- E2E OAuth callback and webhook verification cover the most important wire paths.
- Provider-specific test suites for github, linear, gmail (sync + watch), clickup, notion, outlook delta/subscription, etc.
- Security tests for isolation, lifecycle, redaction.
- Workflow tests for durability, idempotency, lifecycle.

### 3.5 Docs and process discipline

- Provider readiness matrix is explicit and authoritative; gate validates it.
- Docs-inventory enforces: no absolute paths, no legacy package names, no stale "future repo-root gate" wording, presence of release-gate command.
- Runbooks present for OAuth/webhook/provider-throttle/mail-delivery incidents.
- Phase map and STATUS file accurately describe the current `experimental baseline` for Python and matrix-bound TS readiness.

---

## 4. Risks and gaps

The gaps below are ranked by impact for adoption *beyond* a single-process deployment. The current matrix-bound production claim still holds.

### 4.1 HIGH — Durability gaps in execution loops

| Item | Where | Risk |
| --- | --- | --- |
| In-process trigger registration only | `WorkflowEngine.registerTrigger` uses `WebhookHandler` bindings | Triggers lost on process restart unless rebound at boot. Documented, but no auto-rehydrate from DB on cold start. |
| In-memory webhook idempotency cache | `WebhookHandler.processedEventIds: Set<string>` | Unbounded growth in single process; bypassed when receipt persistence is used at the router layer, but in-process `webhooks.handle` calls still grow indefinitely. |
| Sync execution is synchronous | `plug-fn.ts#runSyncJob` runs `executeSyncResource` in-line | No durable queue; long backfills hold an HTTP request open if invoked through the route. |
| Webhook delivery retry loop missing | `plugfn_webhook_deliveries` has `pending|running|success|failed|dead-lettered` + `nextAttemptAt`, but no scheduler reads/retries them | Failed deliveries become inert rows with no recovery automation. |
| Workflow delay step | fail-closed `WORKFLOW_DURABILITY_UNSUPPORTED` | Correct conservative behaviour, but means any workflow with delays cannot be enabled until a durable scheduler exists. |

Recommendation: introduce a minimal durable executor (e.g. polling worker over `nextAttemptAt`/`status='queued'`) before claiming production readiness for sync jobs, webhook deliveries, or workflows beyond an in-process happy path. Until then, document the limit explicitly in `architecture.md` and the runbooks.

### 4.2 HIGH — Python parity is narrower than TS

- Python webhook handler hard-codes verification for `github` and `slack` only (`SIGNED_PROVIDERS`). Linear, ClickUp, Gmail, Notion webhooks have no Python signature path.
- Python OAuth flow exists but uses a `MemoryTokenStore` for state and does not use the shared `@superfunctions/oauth-storage` Postgres-backed vault.
- Python `connection_manager` does not enforce owner/grant/tenant model; `disconnect` only verifies `user_id` equality.
- Python providers package does not export Notion; matrix correctly marks notion Python as `unsupported`.
- Adapter contract mismatch: Python tests use `createConnection`/`getConnection` camelCase but TS uses adapter-level snake-case `plugfn_connections` model. The Python adapter contract is informal.

Recommendation: Python remains correctly tagged `experimental`. Do not treat the gate-included Python tests as parity proof; they are smoke-level. Either commit to closing parity (notion + per-provider signature verification + owner model + shared OAuth storage), or move Python tests to a separate "Python smoke" gate stage so the release gate semantics stay clean.

### 4.3 MEDIUM — Encryption key handling

- `deriveKey` in `utils/crypto.ts` falls back to `SHA-256(encryptionKey)` when the provided key is not a 32-byte hex value. This means a weak `encryptionKey` (e.g. a 12-char string) is silently expanded; there is no minimum-entropy check at startup.
- `DEFAULT_TOKEN_KEY_REF` is a single static key reference. There is no documented rotation procedure or key-version envelope on stored ciphertexts (envelope is `iv:authTag:ciphertext`, no `keyRef` byte).
- `EncryptedCredentials` does carry `keyRef` and `schemaVersion: 'oauth-v1'`, so the shared vault path supports rotation, but the legacy `SecureTokenStorage.encryptCredentials` returns a record with no `keyRef`.

Recommendation: validate `encryptionKey` at `plugFn()` construction (length, entropy), document rotation explicitly in a runbook, and either remove the legacy `SecureTokenStorage` or make rotation explicit at the `EncryptedCredentials` schema level.

### 4.4 MEDIUM — Routing and auth surface

- Canonical route inventory exposes both unversioned and `/v2/*` paths for every route. Mirroring all routes doubles the registered handlers; if both `v1` and `v2` will live long-term, a deprecation policy and removal target should be added (legacy `auth/oauth-flow` has a removal target; the route mirror does not).
- `GET /callback` accepts state + code without auth middleware. This is correct (OAuth providers don't authenticate the caller), but the route accepts callbacks even when the runtime has no integration for the resolved provider; consider explicit "provider not registered/configured" deterministic error there.
- `assertIdentityMatchesQuery` only checks `user`/`uid`/`userId` and `tenantId`. Other identity-leak query parameters (e.g. an attacker-supplied `organizationId`) are not validated against the principal. Most routes do not consume these, but `requireAuthorizedConnection` ultimately blocks misuse; an explicit guard would harden the boundary.

### 4.5 MEDIUM — Observability and audit

- `plugfn_action_logs` model is declared but `ActionExecutor` only feeds the in-memory `MetricsMiddleware`/`LoggingMiddleware`. There is no DB write for action logs; metrics are not persisted across process restarts.
- No structured tracing (no OpenTelemetry hooks). The redaction utility exists but is not auto-wired into the metrics middleware output (call sites must redact manually).
- Health endpoint: `GET /metrics` requires auth; there is no unauthenticated `/healthz` or `/readyz`. Operators running PlugFn behind LB/k8s need to add their own.

### 4.6 LOW — Code hygiene

- `connection-manager.ts` has explicit `@ts-ignore`-style dynamic accesses (`providerRegistry['providers']`) to expose the underlying Map. A cleaner contract on `ProviderRegistry` would avoid private-state escape hatches.
- `ProviderProxy.__getattr__` in Python re-checks `actions` lazily and supports dotted namespaces; TS proxy enumerates actions eagerly. Behaviour is consistent enough but the two implementations diverge in error messages.
- `MetricsMiddleware` and `RateLimiter` are constructed but `enableRetry`/`enableCache`/etc. flags on `ActionExecutor` are read into a destructured `_options` and not actually used after construction. The middlewares are unconditionally instantiated. Either honour the flags or drop them.
- `cli/src/index.ts` declares `version('1.0.0')` while package.json says `0.0.1`. Align before any publish.
- `python/plugfn/__init__.py` declares `__version__ = "0.1.0"` while `pyproject.toml` says `0.0.1`. Same alignment issue.
- IMPLEMENTATION.md (legacy) still references `@superfunctions/plugfn` as the install package and `src/providers/github`. The current public docs are correct; the legacy artifact under `.conduct/IMPLEMENTATION.md` should be moved or marked superseded.

### 4.7 LOW — Provider package contract

- Providers register through a single global `Map<string, Provider>`. There is no scoping (per tenant or per request); resolvers/secret hooks compensate, but a provider registered for one tenant is visible to all.
- Notion overall status in the matrix is `beta` because Python `unsupported`. TS Notion is gated as production. The wording is correct but the matrix's `Overall status` column doubles as both "minimum across languages" and "release-target" — make this explicit so consumers don't read `beta` as "TS not ready".

### 4.8 LOW — Tests

- 110 TS tests is healthy, but coverage is not measured. Consider running `vitest --coverage` in the gate and tracking thresholds in `docs/operations`.
- No load or soak test for sync backfill (esp. Gmail with 50-page maxPages default).
- No fuzz tests for webhook payload parsing or for `redactTelemetry`.

---

## 5. Per-domain assessment

### 5.1 OAuth lifecycle

- `start`, `getAuthUrl`, `handleCallback`, `refresh`, `disconnect` all go through `@superfunctions/oauth-flow` and the encrypted token vault.
- `handleCallback` rebinds a pending token row to the final `connection.id`, then re-reads it to set `EncryptedCredentials` on the connection. Verified by `oauth-callback.test.ts` (single-use state, persisted token row, encrypted payload non-empty).
- Refresh path calls `oauthFlowService.refresh` with the connection's redirect URI (allowlisted), updates `expiresAt`, and surfaces deterministic errors.
- Disconnect path attempts remote revocation and surfaces failures (does not silently swallow).

### 5.2 Webhook lifecycle

- Receipts persisted with payload hash, headers redaction, verification status, idempotency key.
- Idempotent re-delivery short-circuits to the existing verified receipt.
- Failed verification still creates a receipt with `verificationStatus: 'failed'` for forensic visibility.
- Provider event resolution is provider-specific via header heuristics; trigger resolution canonicalizes events (slash-to-dot, lowercased, URI-decoded).
- Missing: a durable delivery retry executor (see 4.1).

### 5.3 Connections & ownership

- `ListConnectionsOptions.owner` filtering enforces (ownerKind, ownerId) match before returning rows.
- `resolveConnectionForAction` raises `CONNECTION_AMBIGUOUS` (409) when multiple equally-prioritized active connections exist.
- Authorization hook (`config.authorization.authorizeConnection`) overrides built-in `connectionMatchesAuthContext` when supplied, so consumers can plug org-admin policies without forking the router.

### 5.4 Sync jobs and sinks

- `plug.sync.backfill`/`incremental` is end-to-end with `executeSyncResource` → provider sync def or fallback action → sink persistence with idempotency key → checkpoint upsert → terminal status.
- `maxPages` defaults to 50 to prevent runaway pagination.
- Missing: backoff between pages, observability of per-page latencies, ability to resume from `nextAttemptAt` on failure.

### 5.5 Workflows

- Lifecycle DB-backed; webhook-backed triggers detached on disable/delete; delay steps fail closed; idempotency by trigger payload `id` honored; resume from `completedStepIds`.
- `getStats` reads at most 1000 executions in memory; for production-grade tenants this should move to a SQL aggregate.

### 5.6 CLI

- Commands: `init`, `generate-types`, `add-provider`, `test`, `providers list|inspect`, `connections list`, `sync backfill`, `webhooks replay`, `doctor`.
- `doctor` is the right shape (validates runtime wiring); ensure it exits with the documented codes (0/1/2/3) — verify in CLI tests.

### 5.7 Browser client (`@plugfn/client`)

- Per `docs/client-sdk-boundary.md`, only provider catalog + connection initiation are exposed; tokens/secrets/refresh/webhook-verify never cross the boundary. The package is intentionally tiny.

---

## 6. Production claim, as currently allowed

Following SPEC.md and release-gate truth, the following surfaces are claimable as production *on this commit*, given the gate is green and the matrix marks them `production`:

- Runtime: `plugfn` (TS), `@plugfn/client`, `@plugfn/providers`, `@plugfn/cli`
- Providers (TS): `github`, `linear`, `clickup`, `gmail`, `notion`

The following must remain non-production:

- Provider (Python): `notion` (unsupported), and any Python provider depending on raw-body verification beyond github/slack.
- Overall (matrix): `notion` (beta until Python parity).
- All `experimental`, `vertical-only`, `unsupported` rows in the matrix.

---

## 7. Recommended action list (ranked)

1. **Durable execution worker.** Implement a polling executor for `plugfn_webhook_deliveries` (status='pending' OR retry due) and a sync-job runner that can resume `running` rows after a restart. Without this, "production" should be qualified as "single-process".
2. **Workflow trigger rehydration on boot.** Read enabled workflows on startup and register webhook bindings, otherwise enabled workflows silently stop after restart.
3. **Webhook handler in-memory idempotency cap.** Either replace `processedEventIds: Set` with the persisted receipt lookup (already used by the router) or bound it with an LRU. Today it is an unbounded leak in long-lived processes.
4. **Encryption key validation + rotation runbook.** Reject weak keys at construction time. Add a key-rotation runbook (or remove legacy `SecureTokenStorage`).
5. **Version alignment.** Sync CLI and Python version strings with their package manifests.
6. **Action log persistence.** Wire `plugfn_action_logs` into `ActionExecutor`, or remove the model.
7. **Python parity decisions.** Either commit to closing parity for `notion`, owner model, raw-body verification for linear/clickup/gmail/notion, and shared OAuth storage, or move Python into an opt-in stage of the gate.
8. **Health endpoints.** Add unauthenticated `/healthz` and `/readyz` for ops.
9. **Coverage in gate.** Enable `vitest --coverage` (or equivalent) with documented thresholds.
10. **Deprecate route mirror.** Decide on a removal target for the unversioned routes or commit to keeping both; document in CHANGELOG.
11. **Tracing.** Add an OpenTelemetry hook in the action executor and webhook router; auto-wire `redactTelemetry` on emit.
12. **Provider registry scoping.** If multi-tenant providers ever need different shapes per tenant, the single global Map will not survive; design before adoption demand forces it.

---

## 8. Quick verification commands

```bash
# Full gate (the only authoritative readiness proof)
npm run gate:plugfn-release

# Per-provider gates
npm run gate:plugfn-provider-github
npm run gate:plugfn-provider-linear
npm run gate:plugfn-provider-gmail
npm run gate:plugfn-provider-notion

# Individual TS test suite
npm --prefix plugfn/typescript test -- --run

# Python smoke suite
python3 -m pytest -q plugfn/python/tests
```

## 9. Conclusion

PlugFn's current architecture, security posture, route surface, and matrix-bounded readiness model are all consistent with a credible "production for a narrow, well-defined surface" claim. The release gate is real, deterministic, and green. The remaining risks are concentrated in durable execution, Python parity, and operational ergonomics rather than in correctness of the in-scope flows. None of the recommendations above invalidate the current production claim for the matrix-marked TS surface; each one extends the safe-adoption envelope.
