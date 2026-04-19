# Requirements

## Table of contents

- PKG-001
- PKG-002
- API-001
- API-002
- EMAIL-001
- EMAIL-002
- EMAIL-003
- DB-001
- WEBHOOK-001
- WEBHOOK-002
- SUP-001
- PUSH-001
- DEVICE-001
- PERF-001
- OBS-001
- TEST-001
- TEST-002
- DOC-001
- SHARED-001
- PARITY-001

---

### ID: PKG-001

- Priority: P0
- Statement: The TypeScript package published from `sendfn/typescript` MUST be named `sendfn`, and all shipped README/example install and import instructions MUST use that same public package name.
- Rationale: The original intent and current documentation expect `sendfn`, and the scoped package name is a release-blocking packaging mismatch.
- Acceptance criteria:
  - `sendfn/typescript/package.json` declares `"name": "sendfn"`.
  - `sendfn/typescript/README.md` uses `npm install sendfn ...` and `import { sendfn } from 'sendfn';`.
  - No shipped TypeScript example or README instructs consumers to import `@sendfn/core`.
- Test vectors: `TV-PKG-001-P`, `TV-PKG-001-N`
- Notes: A temporary compatibility alias MAY exist, but only as a stub package with no divergent runtime logic.

### ID: PKG-002

- Priority: P0
- Statement: The Python base package MUST import successfully with base dependencies only, and optional framework integrations MUST be loaded lazily.
- Rationale: A plain `pip install sendfn` must not fail on unrelated optional imports.
- Acceptance criteria:
  - `import sendfn` succeeds after installing only the base package plus repo-local shared dependencies.
  - `sendfn.http.fastapi` is not imported from `sendfn/__init__.py`.
  - Missing optional integration dependencies raise `SENDFN_OPTIONAL_DEPENDENCY_MISSING` only when the optional integration is imported or invoked.
- Test vectors: `TV-PKG-002-P`, `TV-PKG-002-N`
- Notes: `__all__` MUST only list actually imported/exported names.

### ID: API-001

- Priority: P0
- Statement: The TypeScript and Python public SDKs MUST expose the same supported lifecycle surface for shipped features, including `close()`.
- Rationale: The v0 spec and parity goal require a coherent cross-language contract.
- Acceptance criteria:
  - Both SDKs expose email, SMS, push, device, template, event, suppression, webhook, and `close()` methods.
  - Device lifecycle methods include refresh and cleanup helpers.
  - Suppression lifecycle methods include bulk add and export helpers.
  - Both SDKs surface deterministic error types/codes for shared failure classes.
  - Closing the client twice succeeds without throwing.
- Test vectors: `TV-API-001-P`, `TV-API-001-N`
- Notes: Feature parity applies only to actually supported v0 features, not future providers.

### ID: API-002

- Priority: P0
- Statement: All admin API endpoints MUST validate input and return canonical success/error envelopes with stable error codes.
- Rationale: Framework-specific raw responses are brittle and unsafe for operators.
- Acceptance criteria:
  - Success responses use `{ ok: true, data, error: null, meta }`.
  - Failure responses use `{ ok: false, data: null, error, meta }`.
  - Invalid payloads return `SENDFN_VALIDATION_ERROR`.
  - Unauthorized requests return `SENDFN_UNAUTHORIZED`.
- Test vectors: `TV-API-002-P`, `TV-API-002-N`
- Notes: The webhook endpoint MAY use HTTP `200`/`400`, but its JSON body MUST still use the canonical envelope.

### ID: EMAIL-001

- Priority: P0
- Statement: Both template engines MUST support deterministic `{{variable}}`, `{{#if}}`, and `{{#each}}` semantics with HTML escaping by default.
- Rationale: Templating is a primary v0 feature, and the current engines are behaviorally incorrect.
- Acceptance criteria:
  - Variables interpolate correctly.
  - `#if` blocks render only when the referenced value is truthy.
  - `#each` blocks iterate deterministically over list order.
  - HTML special characters in variables are escaped in output.
- Test vectors: `TV-EMAIL-001-P`, `TV-EMAIL-001-N`
- Notes: Unsupported helper syntax is undefined and MUST not be silently misinterpreted.

### ID: EMAIL-002

- Priority: P0
- Statement: Email send orchestration MUST validate resolved content and MUST check suppression before any provider call.
- Rationale: Invalid or suppressed sends must fail fast and safely.
- Acceptance criteria:
  - A suppressed recipient raises/returns `SENDFN_SUPPRESSED` before provider invocation.
  - Missing final subject or HTML body raises/returns `SENDFN_VALIDATION_ERROR`.
  - Template-not-found errors raise/return `SENDFN_TEMPLATE_NOT_FOUND`.
- Test vectors: `TV-EMAIL-002-P`, `TV-EMAIL-002-N`
- Notes: Raw `Error` without a stable code is not acceptable for these paths.

### ID: EMAIL-003

- Priority: P0
- Statement: Email provider orchestration MUST enforce recipient and attachment caps and MUST use bounded retry behavior for retryable provider failures.
- Rationale: Provider limits and retry exhaustion are core production constraints.
- Acceptance criteria:
  - Requests over 50 recipients fail before provider network calls with `SENDFN_PROVIDER_LIMIT`.
  - Requests over 10 MiB attachments fail before provider network calls with `SENDFN_PROVIDER_LIMIT`.
  - Retryable provider errors use bounded retry with deterministic maximum attempt count.
  - Non-retryable provider errors do not retry.
- Test vectors: `TV-EMAIL-003-P`, `TV-EMAIL-003-N`
- Notes: Retry exhaustion MUST surface `SENDFN_PROVIDER_RETRY_EXHAUSTED`.

### ID: DB-001

- Priority: P0
- Statement: The persistence/query layer MUST support deterministic lookup by `providerMessageId` and event filtering by provider, user, time window, and event type.
- Rationale: Webhook correlation and operator event queries depend on this query surface.
- Acceptance criteria:
  - Email transactions can be fetched by provider message ID.
  - Event queries accept provider, provider message ID, user ID, event type, and time-window filters.
  - Query pagination obeys default and maximum limits.
- Test vectors: `TV-DB-001-P`, `TV-DB-001-N`
- Notes: The time-window filter MUST be inclusive of `startAt` and exclusive of `endAt`.

### ID: WEBHOOK-001

- Priority: P0
- Statement: SES webhook processing MUST cryptographically verify SNS envelopes before inner event processing.
- Rationale: Forged provider events are the top security risk identified by the audit.
- Acceptance criteria:
  - Invalid signature fails with `SENDFN_WEBHOOK_SIGNATURE_INVALID`.
  - Unsupported certificate host fails with `SENDFN_WEBHOOK_SIGNATURE_INVALID`.
  - Stale timestamp or malformed SNS envelope fails with `SENDFN_WEBHOOK_MESSAGE_INVALID`.
  - No DB mutation occurs for invalid or unverifiable webhook payloads.
- Test vectors: `TV-WEBHOOK-001-P`, `TV-WEBHOOK-001-N`
- Notes: Certificate retrieval MUST use an SNS allowlist and HTTPS only.

### ID: WEBHOOK-002

- Priority: P0
- Statement: Verified SES lifecycle events MUST correlate to internal transactions deterministically, update status transitions idempotently, and avoid fabricated `"unknown"` references.
- Rationale: Production event history and suppression correctness require authoritative correlation.
- Acceptance criteria:
  - Verified delivery event updates the matching email transaction to `delivered`.
  - Verified bounce and complaint events update transaction state and suppression state.
  - Duplicate webhook deliveries do not create duplicate terminal events.
  - Unmatched verified events produce deterministic orphan references and metrics instead of `"unknown"`.
- Test vectors: `TV-WEBHOOK-002-P`, `TV-WEBHOOK-002-N`
- Notes: Orphan events MUST still preserve recipient and provider message ID information.

### ID: SUP-001

- Priority: P0
- Statement: Suppression management MUST normalize emails, auto-add permanent bounces and complaints, support manual unsubscribe/manual add/remove, and expose bulk-add/export operations.
- Rationale: Operators need reliable suppression correctness and recovery workflows.
- Acceptance criteria:
  - Email normalization uses trimmed lowercase keys.
  - Permanent bounce creates reason `bounce`.
  - Complaint creates reason `complaint`.
  - Manual unsubscribe and manual add are preserved distinctly.
  - Manual removal allows future sends.
  - Bulk add and export APIs are present and deterministic across both SDKs.
- Test vectors: `TV-SUP-001-P`, `TV-SUP-001-N`
- Notes: Bulk add/export MAY be exposed through SDK methods, admin routes, or both, but the public contract MUST be explicit and testable.

### ID: PUSH-001

- Priority: P0
- Statement: Push orchestration MUST respect FCM batch size limits and APNS concurrency caps while deactivating invalid tokens before completion.
- Rationale: Provider limits and token hygiene are necessary for scalable fan-out.
- Acceptance criteria:
  - FCM sends are chunked into at most 500 tokens per provider call.
  - APNS sends cap in-flight concurrency at 10.
  - Invalid tokens returned by providers are deactivated before method resolution.
  - Push send methods surface deterministic success/failure counts.
- Test vectors: `TV-PUSH-001-P`, `TV-PUSH-001-N`
- Notes: Provider-specific chunking/concurrency must be internal and not change method signatures.

### ID: DEVICE-001

- Priority: P1
- Statement: Device lifecycle management MUST support register, re-register/reactivate, refresh, deactivate, and cleanup semantics without creating duplicate active rows.
- Rationale: Real-world mobile tokens churn and must be managed safely.
- Acceptance criteria:
  - Re-registering the same `(userId, token, platform)` reactivates instead of duplicating.
  - Refresh replaces an old token with a new token while preserving metadata.
  - Cleanup removes inactive tokens older than a supplied cutoff.
- Test vectors: `TV-DEVICE-001-P`, `TV-DEVICE-001-N`
- Notes: Cleanup MAY be implemented as a service method and does not need an HTTP endpoint if not otherwise exposed.

### ID: PERF-001

- Priority: P0
- Statement: Bulk email and bulk push flows MUST use bounded concurrency or provider-native batching and MUST NOT remain purely sequential production code paths.
- Rationale: The audit found that current throughput/scalability behavior is below the release bar.
- Acceptance criteria:
  - TypeScript bulk email is not implemented as a plain sequential loop.
  - TypeScript and Python bulk push are not implemented as plain sequential wrappers over single-send methods.
  - The default concurrency is bounded and configurable.
  - Benchmark or deterministic timing tests exist for the v0 p95 targets in mock/in-memory environments.
- Test vectors: `TV-PERF-001-P`, `TV-PERF-001-N`
- Notes: Provider network latency may be excluded from benchmark assertions if explicitly documented.

### ID: OBS-001

- Priority: P1
- Statement: Logging, events, and error payloads MUST include stable correlation data and MUST redact credentials, token material, and message bodies.
- Rationale: Observability is required for production operations, but secrets must not leak.
- Acceptance criteria:
  - Structured logs include request ID, operation, provider, status, and counts.
  - Logs and error details omit or redact provider secrets, device tokens, SES signatures, and email HTML/text bodies.
  - Webhook processing logs include verification result and match/orphan counts.
- Test vectors: `TV-OBS-001-P`, `TV-OBS-001-N`
- Notes: Redaction markers SHOULD be consistent, for example `[REDACTED]`.

### ID: TEST-001

- Priority: P0
- Statement: TypeScript and Python build/lint/test/import commands MUST pass from repo root in a clean checkout after documented dependency installation.
- Rationale: Production readiness requires a reliable release gate, not ad hoc local state.
- Acceptance criteria:
  - TypeScript `build`, `lint`, and `test` pass from repo root.
  - Python base import passes after installing repo-local shared dependencies.
  - Python tests pass after installing documented extras.
  - The README commands match the actual release-gate commands.
- Test vectors: `TV-TEST-001-P`, `TV-TEST-001-N`
- Notes: Repo-local editable installs are acceptable for Python shared packages.

### ID: TEST-002

- Priority: P0
- Statement: Test doubles and memory adapters MUST emulate uniqueness, update, lookup, and failure behavior closely enough to catch the audit regressions.
- Rationale: Weak test doubles allow silent corruption bugs to escape.
- Acceptance criteria:
  - Memory adapter rejects duplicate IDs where production adapters would.
  - Test doubles support provider-message-id lookup and event filtering needed by webhook tests.
  - Tests cover template rendering, webhook verification, correlation, push limits, packaging/import behavior, and public API parity.
- Test vectors: `TV-TEST-002-P`, `TV-TEST-002-N`
- Notes: TypeScript MAY use a stronger local mock adapter instead of shipping a public memory adapter.

### ID: DOC-001

- Priority: P1
- Statement: TypeScript and Python documentation and examples MUST accurately describe shipped package names, supported features, configuration fields, and webhook setup.
- Rationale: The audit found multiple doc and example mismatches that would mislead integrators.
- Acceptance criteria:
  - TS README names/install/imports match the published package.
  - Python README accurately labels push/SMS support status.
  - Webhook setup docs describe signature verification requirements.
  - Example files run against the documented public APIs.
- Test vectors: `TV-DOC-001-P`, `TV-DOC-001-N`
- Notes: Unsupported future-provider claims MUST be removed or clearly marked undefined, not “coming soon,” unless actually implemented.

### ID: SHARED-001

- Priority: P1
- Statement: `sendfn` MUST continue to use shared Superfunctions DB and HTTP abstractions and MUST NOT reimplement generic DB/HTTP adapter behavior locally.
- Rationale: The repository convention requires reuse of shared infrastructure instead of duplicated abstractions.
- Acceptance criteria:
  - TypeScript continues to depend on `@superfunctions/db` and `@superfunctions/http`.
  - Python continues to depend on `superfunctions.db` and `superfunctions.http`.
  - New code added by this remediation does not introduce local replacements for generic DB/HTTP adapters.
- Test vectors: `TV-SHARED-001-P`, `TV-SHARED-001-N`
- Notes: Local helper wrappers around shared packages are acceptable if they do not duplicate generic transport/persistence logic.

### ID: PARITY-001

- Priority: P1
- Statement: TypeScript and Python MUST behave equivalently for all v0-supported email, push, suppression, webhook, and packaging flows covered by this spec.
- Rationale: The v0 spec explicitly sets parity as the target, and current drift is a maintenance risk.
- Acceptance criteria:
  - Template rendering vectors pass identically in both SDKs.
  - Webhook verification/correlation vectors pass identically in both SDKs.
  - Packaging/import behavior is equivalent relative to each ecosystem’s norms.
  - Documented differences are limited to language-idiomatic syntax, not feature semantics.
- Test vectors: `TV-API-001-P`, `TV-API-001-N`, `TV-EMAIL-001-P`, `TV-EMAIL-001-N`, `TV-WEBHOOK-002-P`, `TV-WEBHOOK-002-N`
- Notes: SMS remains in scope only for the currently shipped basic capability and public-surface consistency.
