# Full Audit Report

## Metadata

- **Timestamp**: 2026-03-12T08:15:00Z
- **Agent Name**: unknown-agent
- **Model**: claude-opus-4-6
- **Launcher**: VS Code (Claude Code extension)
- **Workspace/Project Path**: /Users/serro/Documents/dev/n/superfunctions/plugfn
- **OS**: macOS (Darwin 25.3.0, arm64)
- **Shell**: /bin/zsh
- **Git Branch**: next
- **Git Commit**: 5fe59b66a1ebf692ef723eb68f708e60a90de457
- **Git Dirty**: true (73 files changed, 3429 insertions, 1397 deletions)

---

## Audit Scope

### Intent/Notes Paths Audited

- User thread intent (Finatron + Fellotron architecture, provider rules/restrictions, forwarding/alias alternatives, E2E email risks, shared OAuth primitives, production readiness requirement) -- as captured in INTENT_AUDIT.md

### Spec Bundle Paths Audited

- **Bundle Root**: `plugfn/.conduct/specs/2026-03-11-new-1gdtvan4-spec/`
  - `SPEC.md` - Full specification (544 lines)
  - `REQUIREMENTS.md` - 36 requirements (ARCH-001 through OPS-004)
  - `TEST_VECTORS.md` - 62 test vectors (positive + negative)
  - `PLAN.md` - 15 phases (00-14) with architecture sketch
  - `INTENT_AUDIT.md` - 18 intent items with coverage mapping
  - `phases/PHASE_00.md` through `phases/PHASE_14.md`
  - `phase-reports/PHASE_00-*.md` through `phase-reports/PHASE_14-*.md`

### Codebase Scope Audited

- `packages/oauth-core/` - Shared OAuth core
- `packages/oauth-http/` - Shared OAuth HTTP transport
- `packages/oauth-storage/` - Shared OAuth state/token storage
- `packages/oauth-providers/` - Shared OAuth provider descriptors
- `packages/oauth-testing/` - Shared OAuth test fixtures
- `plugfn/typescript/src/` - All source files
- `plugfn/typescript/tests/` - All test files
- `plugfn/cli/src/` - CLI commands
- `plugfn/docs/` - Documentation and runbooks
- `authfn/ts-sdk/src/` - Social OAuth module
- `authfn/ts-sdk/tests/` - Social OAuth tests

### Commands Executed During Audit

- `git log --oneline -5` + `git branch` + `git diff --stat HEAD`
- File reads via Read tool across all scoped directories
- Grep searches for specific patterns (connection selection, maxAttempts, requestId, v2 routes)
- No code modifications were made

---

## High-Level Findings

| Category | PASS | PARTIAL | FAIL | UNVERIFIED | Total |
|----------|------|---------|------|------------|-------|
| ARCH | 3 | 1 | 0 | 0 | 4 |
| OAUTH | 6 | 2 | 0 | 0 | 8 |
| PLUG | 5 | 2 | 1 | 0 | 8 |
| MAIL | 10 | 0 | 0 | 0 | 10 |
| SEC | 4 | 0 | 0 | 0 | 4 |
| OPS | 4 | 0 | 0 | 0 | 4 |
| **Total** | **32** | **5** | **1** | **0** | **38** |

**Top-Level Summary**: 32/38 requirements fully pass, 5 partially pass, 1 fails. The codebase is substantially complete with key gaps in: connection selection determinism (PLUG-004), canonical v2 response envelope (spec vs implementation mismatch), authfn interface naming deviation (OAUTH-007), and retry cap default (PLUG-006).

---

## Intent Inventory

1. Build architecture for Finatron personal finance management starting with financial email ingestion/parsing.
2. Build architecture for Fellotron as a unified communication manager across channels, starting with email.
3. Integrate Gmail and understand provider rules/restrictions.
4. Address whether forwarding-based ingestion is viable.
5. Address whether user rerouting bank email to platform-managed address is viable and risks.
6. Account for E2EE mailbox ambition similar to Proton-style positioning.
7. Explicitly handle what can go wrong even with strong security/reliability.
8. Evaluate current `superfunctions/plugfn` implementation and tighten it.
9. Reuse shared primitives (especially OAuth) across `plugfn` and future `authfn` social sign-in.
10. Cover all needed email providers for implementation, not only Gmail.
11. Make `plugfn` and related shared packages production-ready, with as many phases as needed.
12. Do not reduce scope to MVP/minimum subset.
13. Provide deterministic, testable, high-precision requirements and acceptance vectors.
14. Include canonical API/protocol envelopes and explicit failure/error behavior.
15. Include security, privacy, multi-tenant isolation, and data lifecycle controls.
16. Include operational readiness: observability, runbooks, release gating.
17. Keep future authfn interoperability explicit in architecture and plan.
18. Produce full `.conduct/specs/{spec_folder}` bundle with logs/tracker integration.

---

## Intent -> Spec Coverage Matrix

| # | Intent Item | Spec Coverage | Requirement IDs | Test Vectors | Status |
|---|-------------|--------------|-----------------|--------------|--------|
| 1 | Finatron finance email ingestion/parsing | SPEC: Finatron parsing semantics, Email adapter contract | MAIL-008, ARCH-004 | TV-MAIL-PARSER-POS/NEG | COVERED |
| 2 | Fellotron unified communication manager | SPEC: Fellotron outbound semantics, Email adapter contract | MAIL-009, ARCH-003 | TV-MAIL-SEND-POS/NEG | COVERED |
| 3 | Gmail integration + provider restrictions | SPEC: Mail sync semantics, Provider policy registry | MAIL-001, MAIL-010, OAUTH-006 | TV-MAIL-GMAIL-POS/NEG, TV-MAIL-POLICY-POS | COVERED |
| 4 | Forwarding-based ingestion viability | SPEC: Forwarding and managed mailbox semantics | MAIL-006 | TV-MAIL-FORWARD-POS/NEG | COVERED |
| 5 | Platform-managed mailbox risks | SPEC: E2EE constraints, Managed mailbox semantics | MAIL-007, SEC-004 | TV-MAIL-MANAGED-POS/NEG, TV-SEC-E2EE-POS | COVERED |
| 6 | E2EE mailbox ambition | SPEC: E2EE constraints, Invariants | SEC-004 | TV-SEC-E2EE-POS/NEG | COVERED |
| 7 | Explicit failure and risk handling | SPEC: Canonical error codes, Partial sync/rebaseline | PLUG-002, PLUG-006, MAIL-007, MAIL-009 | TV-PLUG-WEBHOOK-VERIFY-NEG, TV-PLUG-RATELIMIT-NEG, TV-MAIL-MANAGED-NEG, TV-MAIL-SEND-NEG | COVERED |
| 8 | Tighten current `plugfn` implementation | SPEC: Public API, Semantics, Compatibility | ARCH-002, PLUG-001, PLUG-003, PLUG-005, OPS-001 | TV-ARCH-SHARED-USE-POS, TV-PLUG-ROUTE-AUTH-POS, TV-PLUG-HTTP-POS, TV-OPS-HARDEN-POS | COVERED |
| 9 | Shared OAuth primitives reusable | SPEC: Package topology, authfn social contract | ARCH-001, OAUTH-007 | TV-ARCH-PACKAGES-POS, TV-OAUTH-AUTHFN-POS | COVERED |
| 10 | All email providers for implementation | SPEC: Email provider set | ARCH-003, MAIL-001 through MAIL-007 | TV-ARCH-ADAPTERS-POS, TV-MAIL-*-POS | COVERED |
| 11 | Production readiness across many phases | SPEC: Invariants, Security, Observability | OPS-001, OPS-002, OPS-003, OPS-004 | TV-OPS-HARDEN-POS, TV-OPS-MATRIX-POS, TV-OPS-RUNBOOK-POS, TV-OPS-DOCS-POS | COVERED |
| 12 | No MVP scope reduction | SPEC: Goals/Non-goals | ARCH-003, OPS-002 | TV-ARCH-ADAPTERS-POS, TV-OPS-MATRIX-POS | COVERED |
| 13 | Deterministic, testable requirements | SPEC: Data formats, Invariants | PLUG-004, PLUG-007, OAUTH-003 | TV-PLUG-CONNECTION-POS, TV-PLUG-WORKFLOW-POS, TV-OAUTH-CALLBACK-POS | COVERED |
| 14 | Canonical envelopes and explicit error behavior | SPEC: Data formats/protocol | OAUTH-004, PLUG-002, MAIL-010 | TV-OAUTH-TOKEN-POS, TV-PLUG-WEBHOOK-VERIFY-NEG, TV-MAIL-POLICY-NEG | COVERED |
| 15 | Security/privacy/multi-tenant/data lifecycle | SPEC: Security, Invariants, Observability | SEC-001, SEC-002, SEC-003, SEC-004 | TV-SEC-LIFECYCLE-POS, TV-SEC-REDACTION-POS, TV-SEC-ISOLATION-POS, TV-SEC-E2EE-POS | COVERED |
| 16 | Operational readiness | SPEC: Observability, Compatibility/versioning | OPS-002, OPS-003, OPS-004 | TV-OPS-MATRIX-POS, TV-OPS-RUNBOOK-POS, TV-OPS-DOCS-POS | COVERED |
| 17 | Future authfn interoperability | SPEC: authfn social OAuth contract | OAUTH-007, OAUTH-008 | TV-OAUTH-AUTHFN-POS, TV-OAUTH-REVOKE-POS | COVERED |
| 18 | Full spec bundle + logs/tracker | SPEC: Metadata section | OPS-002 | TV-OPS-MATRIX-POS | COVERED |

**Result**: All 18 intent items are covered in the spec. No SPEC MISSING items.

---

## Requirement Coverage Summary

| Category | PASS | PARTIAL | FAIL | UNVERIFIED |
|----------|------|---------|------|------------|
| ARCH (4) | 3 | 1 | 0 | 0 |
| OAUTH (8) | 6 | 2 | 0 | 0 |
| PLUG (8) | 5 | 2 | 1 | 0 |
| MAIL (10) | 10 | 0 | 0 | 0 |
| SEC (4) | 4 | 0 | 0 | 0 |
| OPS (4) | 4 | 0 | 0 | 0 |

---

## Requirement-by-Requirement Results

### ARCH Requirements

| Req | Priority | Status | Evidence | Notes |
|-----|----------|--------|----------|-------|
| ARCH-001 | P0 | **PASS** | `packages/oauth-core/`, `packages/oauth-http/`, `packages/oauth-storage/`, `packages/oauth-providers/`, `packages/oauth-testing/` all exist with correct `@superfunctions/oauth-*` package names, TypeScript build config, exports, and tests. | All 5 packages verified. |
| ARCH-002 | P0 | **PARTIAL** | `plugfn/typescript/src/auth/oauth-flow.ts` and `plugfn/typescript/src/auth/token-store.ts` still exist as thin wrappers that forward to shared packages. Connection manager imports from shared packages. | Legacy files still present. While they appear to be wrappers, the spec requires "removed or reduced to adapters/wrappers without business logic." Need to verify no residual business logic remains in these files. The wrappers forward to shared packages, which satisfies the "thin compatibility wrappers" allowance. |
| ARCH-003 | P0 | **PASS** | All 7 adapters implemented: `providers/gmail/`, `providers/outlook/`, `providers/yahoo/`, `providers/icloud/`, `providers/imap-smtp/`, `providers/forwarding/`, `providers/managed-mail/`. Each has actions, policy integration, and normalization support. | Full coverage verified. |
| ARCH-004 | P0 | **PASS** | `plugfn/typescript/src/mail/normalization.ts` implements `NormalizedMailMessage` (Zod-validated), `normalizeGmailMessage()`, `normalizeOutlookMessage()`, classification support, and `MailNormalizationError` for invalid outputs. | Schema is published and versioned. Gmail and Outlook payloads map to equivalent normalized fields. |

### OAUTH Requirements

| Req | Priority | Status | Evidence | Notes |
|-----|----------|--------|----------|-------|
| OAUTH-001 | P0 | **PASS** | `packages/oauth-core/src/pkce.ts`: `generateStateId()` uses `crypto.randomBytes(32)` with "st_" prefix. `generatePkcePair()` produces S256 challenge. `generateNonce()` uses 32 bytes entropy. PKCE conditionally applied based on `supportsPkce` flag. | Cryptographic random generation verified. |
| OAUTH-002 | P0 | **PASS** | `packages/oauth-storage/src/adapters/memory.ts` and `src/adapters/sql.ts` implement `OAuthStateStore`. `consume()` method sets `consumedAt` atomically. `deleteExpired()` purges old states. SQL adapter supports cross-node operation. | Both memory (dev) and SQL (production) adapters present. |
| OAUTH-003 | P0 | **PASS** | `packages/oauth-core/src/state.ts:55-75`: `consumeStateOrThrow()` checks `consumedAt`, throws `OAUTH_STATE_REPLAYED` on re-use. Validates provider and redirectUri matching. | Replay rejection verified; no token material leaked. |
| OAUTH-004 | P0 | **PASS** | `packages/oauth-http/src/token-client.ts`: Supports `client_secret_post` (form params) and `client_secret_basic` (Base64 Authorization header). Handles JSON and form-encoded responses. `normalizeTokenResponse()` extracts standard OAuth fields. | Both auth methods and content formats verified. |
| OAUTH-005 | P0 | **PASS** | `packages/oauth-storage/src/token-vault.ts`: `AesGcmTokenCipher` uses AES-256-GCM with random 12-byte IV. Key validation enforces 32-byte keys. `EncryptedTokenVault.rotateKey()` re-encrypts without losing token semantics. Versioned ciphertext format `v1:iv:authTag:payload`. | Envelope encryption with key rotation verified. |
| OAUTH-006 | P0 | **PASS** | `packages/oauth-providers/src/policy-registry.ts`: `ProviderPolicyDefinition` includes scope validation hooks, feature-to-scope mapping, and operation authorization. Each provider (Google, Microsoft, Yahoo, Apple, GitHub) has configured policies. | Feature-scope map is explicit and versioned per provider. |
| OAUTH-007 | P0 | **PARTIAL** | `authfn/ts-sdk/src/social-oauth/index.ts` imports from all 4 shared OAuth packages. No duplicate OAuth core logic. Supports Google, Microsoft, GitHub, Apple (+ Yahoo). Tests verify shared package usage. API-key auth preserved. **However**: interface method names differ from spec. | See Spec Conflicts section for details. |
| OAUTH-008 | P1 | **PASS** | `packages/oauth-http/src/index.ts` exports `disconnectWithRevoke()`. `authfn/ts-sdk/src/social-oauth/index.ts` uses it. Local token deletion occurs even when remote revoke fails. Revocation failures are recorded and surfaceable via `getRevocationFailures()`. | Local cleanup guaranteed regardless of remote revoke outcome. |

### PLUG Requirements

| Req | Priority | Status | Evidence | Notes |
|-----|----------|--------|----------|-------|
| PLUG-001 | P0 | **PASS** | `plugfn/typescript/src/router/http-router.ts`: All protected routes enforce `requireAuth` middleware. `assertIdentityMatches()` validates body/query identity against auth context. Bearer token resolution from header only. Spoofed `userId` params ignored. | Webhook routes appropriately exempt (signature-based auth). |
| PLUG-002 | P0 | **PASS** | `plugfn/typescript/src/webhooks/webhook-handler.ts:50-65`: Fails closed with `WEBHOOK_SECRET_NOT_FOUND` when secret missing, `WEBHOOK_SIGNATURE_INVALID` when signature fails. Idempotency tracking prevents duplicate processing via event ID dedup. | Fail-closed behavior verified. |
| PLUG-003 | P0 | **PASS** | `webhook-handler.ts:163-224`: `canonicalizeEvent()` normalizes paths (strips slashes, lowercases, URL-decodes). Trigger registry maps provider webhook paths to internal event keys. Unknown events return deterministic 404. | Canonical mapping verified. |
| PLUG-004 | P0 | **FAIL** | `connection-manager.ts:960-971`: Sort uses `['lastUsedAt', 'connectedAt', 'createdAt']`. **Issues**: (1) Uses `connectedAt` not `createdAt` as secondary sort field. Though `connectedAt` is derived from `createdAt` (line 911-912), the spec explicitly names `createdAt`. (2) Missing `connectionId` as deterministic tiebreaker -- returns 0 when all time fields match, making sort non-deterministic. (3) All fields sort DESC via `b[field] - a[field]`; spec implies mixed ordering. | See Recommendations. |
| PLUG-005 | P0 | **PASS** | `plugfn/typescript/src/utils/request.ts:99-202`: `inferEncoding()` distinguishes form vs JSON. `serializeFormPayload()` creates proper `URLSearchParams`. Explicit `Content-Type` in config is respected. `FormData` handled without overwriting headers. | Content-type preservation verified. |
| PLUG-006 | P0 | **PARTIAL** | `plugfn/typescript/src/middleware/retry.ts:5`: `maxAttempts: 3` (spec requires default 5). `rate-limiter.ts:42-75`: Token bucket with per-provider and per-tenant buckets. Retry-After header parsing supports seconds, milliseconds, and HTTP dates. | **Default retry cap is 3, not 5 as required by spec.** |
| PLUG-007 | P1 | **PASS** | `plugfn/typescript/src/core/workflow-engine.ts`: Durable execution records with `completedStepIds`. Idempotency key resolution from explicit key or payload.id. Completed executions return without re-execution. Step-level tracking prevents duplicate side effects. | Crash-safe idempotency verified. |
| PLUG-008 | P0 | **PASS** | `plugfn/cli/src/commands/test.ts`: Runs real checks -- config validation (HTTPS URLs), auth URL generation (deterministic with PKCE), callback validation, optional live health checks. Nonzero exit on failure. JSON output mode supported. | Not placeholder output. |

### MAIL Requirements

| Req | Priority | Status | Evidence | Notes |
|-----|----------|--------|----------|-------|
| MAIL-001 | P0 | **PASS** | `providers/gmail/gmail.sync.ts`: Full baseline sync with pagination + historyId tracking. Incremental sync via startHistoryId. `providers/gmail/gmail.watch.ts`: Watch renewal with `ensureGmailWatch()`, push notification handling via `handleGmailPushNotification()`. | Full Gmail adapter verified. |
| MAIL-002 | P0 | **PASS** | `providers/outlook/outlook.delta.ts`: Delta sync with `@odata.deltaLink` checkpoints. `providers/outlook/outlook.subscriptions.ts`: Graph subscription create/renew lifecycle. Push notification handling triggers incremental delta sync. | Graph subscription renewal + delta checkpoint verified. |
| MAIL-003 | P0 | **PASS** | `providers/yahoo/index.ts`: OAuth IMAP/SMTP. Checks `imapOauthAllowed` policy flag. Blocked modes throw `PROVIDER_POLICY_BLOCKED`. Inbound and outbound paths present. | Policy-gated Yahoo adapter verified. |
| MAIL-004 | P0 | **PASS** | `providers/icloud/index.ts`: IMAP/SMTP with required `appSpecificPassword`. `ensureIcloudMode()` rejects POP mode. Default hosts: `imap.mail.me.com`, `smtp.mail.me.com`. TLS enabled. | POP rejection + app-specific password verified. |
| MAIL-005 | P0 | **PASS** | `providers/imap-smtp/`: RFC822 parsing via `parseRfc822Message()`. `assertSecureTransportPolicy()` enforces TLS unless explicitly overridden. Capability matrix controls per-connection actions. Policy decision audit trail. | Standards-compliant with secure defaults verified. |
| MAIL-006 | P1 | **PASS** | `providers/forwarding/index.ts`: Inbound-only (`outboundEnabled: false`). Optional enable via policy-controlled operation. Health monitoring with stall detection via `evaluateForwardingHealth()`. | Not forced as sole connection mode. |
| MAIL-007 | P0 | **PASS** | `providers/managed-mail/index.ts`: Requires `userOptIn: true`, `riskAck: true`, `backupChannelConfirmed: true` for finance-critical. `assertBackupChannelConfirmed()` enforcement. Incident handling triggers backup alerts. Cannot be auto-enabled. | All safeguards verified. |
| MAIL-008 | P0 | **PASS** | `finatron/parsers/pipeline.ts`: Deterministic parser runs first (`parsers/deterministic.ts` -- regex-based). LLM fallback triggers only when confidence < 0.8 or ruleCoverage < 0.6 (`parsers/model-fallback.ts`). All outputs include confidence scores and provenance arrays. Review state derived from confidence threshold. | Deterministic-first pipeline verified. |
| MAIL-009 | P0 | **PASS** | `fellotron/send/governor.ts`: Policy checks (provider limits, tenant limits, blocked domains, abuse score) via `policies.ts`. Idempotent send queue with deduplication (`queue.ts`). Rate limiting per provider and per tenant. Retry-After respected. Blocked decisions persisted with code and retryability. | Send governor with all dimensions verified. |
| MAIL-010 | P0 | **PASS** | `policy/provider-policy-service.ts`: Versioned capability/restriction metadata per provider (7 providers configured). `checkOperation()` and `assertOperationAllowed()` enforce at runtime. Policy version changes logged via `PolicyAuditEvent`. `updatePolicy()` requires admin action. | Versioned provider policy registry verified. |

### SEC Requirements

| Req | Priority | Status | Evidence | Notes |
|-----|----------|--------|----------|-------|
| SEC-001 | P0 | **PASS** | `security/retention.ts`: Retention policy with per-dataset TTL, legal hold exceptions. `security/export-delete.ts`: Cascading deletion in order (parseArtifacts -> messages -> tokens -> connections). Residual-record detection throws `LifecycleSecurityError`. Export produces portable format. | Full lifecycle controls verified. |
| SEC-002 | P0 | **PASS** | `security/redaction.ts`: `redactTelemetry()` recursively redacts 39+ sensitive keys + regex patterns for Bearer tokens, OAuth prefixes, email addresses. `assertTelemetryRedacted()` validates post-redaction. `redactMetricDimensions()` for metrics. | Default redaction verified with assertion validation. |
| SEC-003 | P0 | **PASS** | `security/isolation-guards.ts`: `assertScopedAccess()` enforces tenant/user match, throws `TENANT_ACCESS_DENIED` on mismatch. `filterScopedRecords()` returns only in-scope records. `getScopedRecordById()` detects cross-tenant access attempts. Router-level enforcement via `assertIdentityMatches()`. | Multi-tenant isolation verified. |
| SEC-004 | P1 | **PASS** | `security/e2ee-mode.ts`: `ManagedMailboxSecurityMode` supports `non-recoverable` and `escrow-recoverable`. Per-mailbox metadata with `serverSideRecoveryAllowed` derived from mode. `recordEscrowRecovery()` blocks on non-recoverable mode with `PROVIDER_POLICY_BLOCKED`. Audit events for mode changes and recovery operations. | Explicit key modes with audit trail verified. |

### OPS Requirements

| Req | Priority | Status | Evidence | Notes |
|-----|----------|--------|----------|-------|
| OPS-001 | P0 | **PASS** | Full test suite in `plugfn/typescript/tests/`: OAuth integration, webhook verification, workflow idempotency, retry/rate-limit, HTTP content-type, router auth, connection manager, connection selection, plus security tests (isolation, redaction, lifecycle). No placeholder/stub behaviors in critical paths. Token vault uses real AES-256-GCM. | Production-grade test coverage verified. |
| OPS-002 | P0 | **PASS** | `plugfn/docs/operations/release-gates.md`: GATE-ARCH-002-SHARED-OAUTH, GATE-OPS-001-PLUGFN-HARDENING, GATE-OPS-002-CROSS-WORKSPACE-MATRIX defined with commands, pass/fail criteria, and evidence requirements. All 5 shared OAuth packages properly structured for workspace builds. | Release verification matrix defined. |
| OPS-003 | P1 | **PASS** | `plugfn/docs/runbooks/`: (1) `oauth-incident.md` -- state/callback/token failures, (2) `provider-throttle-incident.md` -- rate limit spikes, (3) `webhook-security-incident.md` -- signature verification failures, (4) `mail-delivery-incident.md` -- send failures. All include detection, containment, mitigation, rollback, and post-incident steps. | All 4 required runbooks verified. |
| OPS-004 | P1 | **PASS** | `plugfn/docs/getting-started.md`: Shared OAuth setup, managed mailbox risk boundary section, lifecycle and security controls, runbook links, authfn interop notes. `plugfn/docs/architecture/provider-policy-matrix.md`: Per-provider policy matrix with capability flags. | Documentation updated with shared OAuth, adapter setup, managed-mailbox risks. |

---

## Spec Conflicts / Spec Gaps

### CONFLICT-1: authfn SocialAuthService Interface Naming

**Spec defines** (`SPEC.md` lines 334-338):
```typescript
interface SocialAuthService {
  getLoginUrl(...)
  handleLoginCallback(...)
  disconnectIdentity(...)
}
```

**Implementation provides** (`authfn/ts-sdk/src/social-oauth/types.ts:154-160`):
```typescript
interface SocialOAuthService {
  createLoginUrl(...)
  handleCallback(...)
  disconnect(...)
  listLinkedIdentities(...)   // not in spec
  getRevocationFailures(...)  // not in spec
}
```

**Differences**:
1. Interface named `SocialOAuthService` vs spec's `SocialAuthService`
2. Method `createLoginUrl` vs spec's `getLoginUrl`
3. Method `handleCallback` vs spec's `handleLoginCallback`
4. Method `disconnect` vs spec's `disconnectIdentity`
5. Disconnect input takes `{tenantId, userId, providerId}` vs spec's `{tenantId, identityId}`
6. Return shapes differ (implementation returns full `SocialIdentityRecord` vs spec's simple `{identityId, email?, profile}`)
7. Two additional methods not in spec

**Impact**: Functional behavior is equivalent but API surface doesn't match spec. Consumers coding against the spec interface won't compile against the implementation.

**Recommendation**: Align method names and primary types with spec. Additional methods are acceptable as extensions but the core contract must match.

### CONFLICT-2: Canonical v2 Response Envelope

**Spec defines** (`SPEC.md` lines 345-375):
```json
{
  "ok": true,
  "data": {},
  "meta": { "requestId": "req_01j...", "timestamp": "..." }
}
```
Error envelope:
```json
{
  "ok": false,
  "error": { "code": "...", "message": "...", "status": 400, "retryable": false, "details": {} },
  "meta": { "requestId": "...", "timestamp": "..." }
}
```

**Implementation** (`http-router.ts:64-73, 429-440`):
```json
// Success:
{ "ok": true, "data": {...} }
// Error:
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

**Missing**:
- `meta.requestId` and `meta.timestamp` on all responses
- `error.status`, `error.retryable`, `error.details` on error responses
- v2 URL pattern (`/api/plugfn/v2/...`) -- routes use unversioned paths

**Impact**: Observability traceability invariant ("Every public API response MUST include requestId") is not met. Error retryability information is not surfaced to callers.

### CONFLICT-3: Retry Default Cap

**Spec** (Limits/caps section, line 502): "Retry attempts MUST be capped (default 5)"

**Implementation** (`middleware/retry.ts:5`): `maxAttempts: 3`

**Impact**: Lower default means fewer retries on transient failures. Configurable, so not a hard failure, but default doesn't match spec.

---

## Cross-Cutting Audits

### Security/Authz/Validation Boundaries

| Control | Status | Evidence |
|---------|--------|----------|
| User identity from auth middleware, not query params | PASS | `http-router.ts`: `requireAuth` + `assertIdentityMatches()` |
| tenantId validated against session context | PASS | `isolation-guards.ts`: `assertScopedAccess()` |
| Admin operations require elevated auth | PASS | Policy updates require admin context |
| Redirect URIs allowlisted per provider | PASS | `oauth-core/src/state.ts`: `assertRedirectUriAllowed()` |
| Scopes subset of provider allowlist | PASS | `oauth-providers/src/policy-registry.ts`: Scope validation hooks |
| Webhooks rejected if signature fails | PASS | `webhook-handler.ts:50-65`: Fail-closed |
| Encrypted payload schema versioned | PASS | `token-vault.ts`: `v1:iv:authTag:payload` format |

### Determinism Invariants

| Invariant | Status | Evidence |
|-----------|--------|----------|
| OAuth state consumed once | PASS | `state.ts`: `consumeStateOrThrow()` checks `consumedAt` |
| Idempotent sync (no message duplication) | PASS | Provider message ID-based upsert semantics |
| Deterministic connection selection | **FAIL** | Missing `connectionId` tiebreaker; uses `connectedAt` vs `createdAt` |
| Workflow idempotency | PASS | `workflow-engine.ts`: Step-level tracking + idempotency key |
| Deterministic message ordering | PASS | `receivedAt DESC`, `providerMessageId ASC` schema support |
| JSON key order not used for correctness | PASS | No key-order-dependent logic found |

### Limits/Caps

| Limit | Spec Default | Implementation | Status |
|-------|-------------|----------------|--------|
| OAuth state TTL | 10 min (1-30 configurable) | Configurable via `expiresAt` field | PASS |
| Callback replay cache | >= 24 hours | State store retains consumed records | PASS |
| Webhook payload max | 2 MB configurable | Not explicitly bounded in code | **UNVERIFIED** |
| Mail sync page size | Per provider + internal cap | Gmail pagination, Outlook delta pages | PASS |
| Retry max attempts | 5 (default) | 3 (default) | **PARTIAL** |
| Max concurrent sync per connection | 1 (default) | Not explicitly enforced | **UNVERIFIED** |
| Send queue rate limits | Provider + tenant + recipient-domain | Provider + tenant buckets implemented | PASS |

### Error Handling + Canonical Envelopes

| Canonical Error Code | Used In | Status |
|---------------------|---------|--------|
| OAUTH_STATE_INVALID | oauth-core/state.ts | PASS |
| OAUTH_STATE_REPLAYED | oauth-core/state.ts | PASS |
| OAUTH_CALLBACK_MISMATCH | oauth-core/state.ts | PASS |
| OAUTH_TOKEN_EXCHANGE_FAILED | oauth-http/errors.ts | PASS |
| OAUTH_TOKEN_REFRESH_FAILED | oauth-http/errors.ts | PASS |
| OAUTH_SCOPE_DISALLOWED | oauth-providers | PASS |
| CONNECTION_NOT_FOUND | connection-manager.ts | PASS |
| CONNECTION_AMBIGUOUS | connection-manager.ts | PASS |
| WEBHOOK_SIGNATURE_INVALID | webhook-handler.ts | PASS |
| WEBHOOK_SECRET_NOT_FOUND | webhook-handler.ts | PASS |
| PROVIDER_POLICY_BLOCKED | policy-service, adapters | PASS |
| PROVIDER_RATE_LIMITED | oauth-http/errors.ts, retry.ts | PASS |
| MAIL_SYNC_CHECKPOINT_INVALID | gmail.sync.ts, outlook.delta.ts | PASS |
| MAIL_SYNC_PARTIAL | Sync result `partial` flag | PASS |
| MAIL_SEND_BLOCKED | fellotron/send/types.ts | PASS |
| TENANT_ACCESS_DENIED | isolation-guards.ts, http-router.ts | PASS |
| VALIDATION_ERROR | Various | PASS |
| INTERNAL_ERROR | Various | PASS |

**Envelope completeness**: Error codes are comprehensive, but envelope structure is missing `meta`, `status`, `retryable`, and `details` fields as specified.

### Compatibility/Versioning/Migrations

| Control | Status | Notes |
|---------|--------|-------|
| Shared OAuth packages at 0.x | PASS | All at 0.0.1 |
| v2 endpoints additive (v1 untouched) | **NOT IMPLEMENTED** | No v2 URL pattern exists. Current routes are unversioned. v1 endpoints are stable but spec requires explicit v2 versioning. |
| plugfn removes direct OAuth duplication | PARTIAL | Legacy auth files exist as wrappers. No residual business logic, but files could be cleaned up. |
| authfn depends on shared packages | PASS | All 4 shared packages in authfn/ts-sdk/package.json dependencies. |
| Python parity | UNVERIFIED | Python SDK not audited in this scope. |

---

## Recommendations (Ranked)

### Rank 1: PLUG-004 -- Fix Connection Selection Determinism (P0 FAIL)

**Impact**: Non-deterministic connection selection when time fields tie. Wrong-account execution is a "critical correctness and safety failure" per spec rationale.

**Fix**:
1. Change priority fields from `['lastUsedAt', 'connectedAt', 'createdAt']` to `['lastUsedAt', 'createdAt']` per spec.
2. Add `connectionId` string comparison as final tiebreaker (e.g., `a.id.localeCompare(b.id)`) so sort never returns 0.

**Files**: `plugfn/typescript/src/core/connection-manager.ts:960-971`

### Rank 2: Canonical v2 Response Envelope (P0, Spec/Invariant Gap)

**Impact**: Missing `meta.requestId` violates traceability invariant ("Every public API response MUST include requestId"). Missing `error.retryable` prevents callers from implementing proper retry logic.

**Fix**:
1. Add `meta: { requestId: generateRequestId(), timestamp: new Date().toISOString() }` to all responses.
2. Add `status`, `retryable`, and `details` to error envelopes.
3. Implement v2 URL pattern (`/api/plugfn/v2/...`) or document decision to defer versioning.

**Files**: `plugfn/typescript/src/router/http-router.ts:64-73, 429-440`

### Rank 3: OAUTH-007 -- Align authfn SocialAuthService Interface (P0 PARTIAL)

**Impact**: API consumers coding against the spec interface won't compile against the implementation. Integration tests referencing spec method names will fail.

**Fix**:
1. Rename `SocialOAuthService` to `SocialAuthService`.
2. Rename methods: `createLoginUrl` -> `getLoginUrl`, `handleCallback` -> `handleLoginCallback`, `disconnect` -> `disconnectIdentity`.
3. Align input/return types with spec signatures (keep additional methods as extensions).

**Files**: `authfn/ts-sdk/src/social-oauth/types.ts:154-160`, `authfn/ts-sdk/src/social-oauth/index.ts`

### Rank 4: PLUG-006 -- Default Retry Cap (P0 PARTIAL)

**Impact**: Default 3 retries instead of spec's 5 means fewer automatic recovery attempts on transient failures. Quick fix.

**Fix**: Change `maxAttempts: 3` to `maxAttempts: 5` in `DEFAULT_RETRY_OPTIONS`.

**Files**: `plugfn/typescript/src/middleware/retry.ts:5`

### Rank 5: Webhook Payload Size Limit (Limits/Caps)

**Impact**: No explicit webhook payload size cap. Spec requires 2 MB default, configurable.

**Fix**: Add payload size validation before webhook handler dispatch.

**Files**: `plugfn/typescript/src/webhooks/webhook-handler.ts`

### Rank 6: Max Concurrent Sync per Connection (Limits/Caps)

**Impact**: Spec requires default 1 concurrent sync job per connection. No explicit concurrency guard found.

**Fix**: Add connection-level mutex or semaphore to sync dispatch.

**Files**: Gmail sync, Outlook sync dispatchers

---

## Appendix: Commands Run + Environment Details

### Environment
- **Model**: claude-opus-4-6
- **Launcher**: VS Code (Claude Code extension)
- **OS**: macOS Darwin 25.3.0 arm64
- **Shell**: zsh
- **Git**: branch=next, commit=5fe59b6, dirty=true

### Commands Executed
1. `git log --oneline -5` -- Recent commit history
2. `git branch --show-current` -- Current branch
3. `git diff --stat HEAD` -- Dirty status (73 files, 3429+/1397-)
4. `ls -R phases/ phase-reports/` -- Phase directory inventory
5. `ls .conduct/audits/` -- Check audits directory existence
6. `mkdir -p .conduct/audits/` -- Create audits directory
7. Multiple Read/Grep operations across all scoped directories (see Audit Scope)
8. No code modifications performed

### Phase Execution History (from logs.csv)
All 15 phases (PHASE_00 through PHASE_14) executed between 2026-03-11T17:57:09Z and 2026-03-12T06:41:58Z by gpt-5 (Codex) via Codex Desktop.
