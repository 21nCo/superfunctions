# SFN-17 Issue Completion Report

## Metadata

- Timestamp (UTC): 2026-08-10T17:10:46Z
- Issue: SFN-17 — Build MailFn as a reusable programmable mailbox function
- Source: https://linear.app/21n/issue/SFN-17/build-mailfn-as-a-reusable-programmable-mailbox-function
- Agent: Codex
- Model: GPT-5
- Launcher: Codex Desktop
- Workspace: `/Users/serro/Documents/dev/n/worktrees/superfunctions/mailfn`
- OS / shell: macOS 26.5.2 arm64 / zsh
- Branch: `codex/sfn-17-mailfn`
- Clean base: `sf-next/next` at `9cf381238d1d8a11c899d6808ffb0bb73dfe839a`
- Issue file: `mailfn/.conduct/issues/SFN-17.md`

## Status

PASS — all implementation phases are complete in the local worktree. Public-platform capabilities are intentionally disabled by default, and no external deployment, DNS mutation, registry publication, billing/support activation, or production-security approval was performed.

## Requirements and evidence

### Phase 0 — product, architecture, threat, retention, and release decisions

- Added the package family `@mailfn/core`, `@mailfn/cloudflare`, `@mailfn/client`, `@mailfn/testing`, `@mailfn/cli`, `@mailfn/mcp`, `@mailfn/sendfn`, plus the `mailfn` facade.
- Defined API/event/Queue versioning, stable and expiring retention defaults, tenancy, compatibility, failure invariants, public-launch gates, and explicit external side-effect boundaries.
- Added `mailfn/SPEC.md`, `mailfn/THREAT_MODEL.md`, `mailfn/OPERATIONS.md`, root/package READMEs, release registration, a Node 22 release workflow, and a clean pack/install/import gate.
- Incorporated product lessons from MailSlurp, Mailtrap Inbound Email, and AgentMail while retaining a portable core and explicit deployment adapter.

### Phase 1 — inbound test inbox and Cloudflare durability

- Implemented project bootstrap, stable/expiring inbox lifecycle, scoped one-time credentials, revocation/expiry, idempotent inbox creation, tenant isolation, rate/size/storage quotas, audits, and usage records.
- Implemented raw-MIME-first R2 receipt, D1 metadata, versioned Queue jobs, at-least-once delivery dedupe, queue-failure reconciliation, MIME parsing, attachment hashing, conservative HTML sanitization, blocked remote images, threads, raw/attachment reads, filtering, pagination, typed waits, cancellation, timeout results, and source-attributed OTP/link extraction.
- Implemented D1 schema plus executable migration, transactionally maintained FTS5 search, R2/Queue adapters, Email Worker/HTTP/Queue/scheduled handlers, and a typed TypeScript client.
- Hardened partial failures so non-critical event/usage outages cannot strand accepted mail, attachment metadata failure cleans R2 writes, duplicate pending receipt requeues, and failed object deletion preserves retryable metadata.

### Phase 2 — integrations, custom domains, webhooks, testing, and operations

- Implemented redacted-by-default CLI and MCP surfaces with explicit content/extraction actions.
- Implemented signed timestamped webhooks, replay verification, manual redirect handling, public-HTTPS/obvious-SSRF validation, durable retry state, scheduled redelivery, dead-lettering, and endpoint quarantine.
- Implemented custom-domain DNS evidence, Cloudflare routing rule creation, exact record verification, and reversible disablement.
- Implemented expiring test fixtures, lifecycle hooks, waits, focused message/attachment assertions, retention, reconciliation, operational snapshots/alerts, and audit APIs.

### Phase 3 — mailbox depth and SendFn composition

- Implemented deterministic threading, labels, D1 FTS5 search, drafts, reply/reply-all/forward, attachment/thread containment, and least-privilege credential delegation.
- Implemented the SendFn adapter without duplicating providers. Replies preserve `In-Reply-To`/`References`, and all outbound sends propagate a stable per-draft idempotency key.

### Phase 4 — explicitly gated public readiness

- Implemented per-project active-inbox, ingress, message, attachment, stored-byte, webhook, domain, and outbound quotas; billing usage records; abuse cases; support cases; compliance/data-region profiles; deletion SLA data; and operational alerts.
- Public-platform, billing, support, verified-domain outbound, and production-security approval are independent controls and default off. Public outbound is denied when public mode lacks explicit security approval.
- Protocol compatibility is bounded to the versioned HTTP API/client/CLI/MCP surface for this release. Any public IMAP/SMTP/JMAP service remains a separately reviewed and deployed compatibility layer, not an implicit side effect of this implementation.

## Primary implementation surfaces

- `mailfn/core/src/*` — domain types/contracts/service, memory adapters, extraction, threading, security/runtime helpers, and tests.
- `mailfn/cloudflare/src/*` and `migrations/0001_mailfn.sql` — D1/R2/Queue/Email/HTTP/webhook/domain/scheduled runtime and tests.
- `mailfn/client`, `mailfn/testing`, `mailfn/cli`, `mailfn/mcp`, `mailfn/sendfn`, `mailfn/facade` — public integrations and tests.
- Root `package.json`, `package-lock.json`, `release-packages.json`, `scripts/gate-mailfn-release.mjs`, and `.github/workflows/mailfn-release.yml` — workspace and release integration.
- `README.md`, `AGENTS.md`, and `docs/lib/ecosystem-catalog.ts` — ecosystem discovery.

## Verification

1. `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run gate:mailfn-release` — PASS.
   - Cleaned and built all 8 packages.
   - 52 tests passed: core 26, client 4, Cloudflare 13, testing 2, CLI 2, MCP 2, SendFn 2, facade 1.
   - Packed all public npm tarballs, installed them in a clean temporary project, and imported every package entry point.
2. `sqlite3 :memory: < mailfn/cloudflare/migrations/0001_mailfn.sql` — PASS.
3. SQLite D1/FTS smoke query using the shipped migration and the runtime join/MATCH shape — PASS; returned the expected message JSON.
4. `npm ls @mailfn/core @mailfn/client @mailfn/cloudflare @mailfn/testing @mailfn/cli @mailfn/mcp @mailfn/sendfn mailfn sanitize-html --depth=0` — PASS; all workspace packages resolve at `0.1.0` and `sanitize-html@2.17.0` is present.
5. `git diff --check` — PASS.
6. `npm --prefix docs run check:catalog` — baseline-only FAIL. MailFn-specific checks are clean (`missingEcosystemEntries`, `extraEcosystemEntries`, and order mismatch are empty); the repository already reports duplicate `http-openapi`/`oauth-router` catalog entries and the existing `python-core` package-name mismatch.
7. `npx turbo run typecheck --filter='./mailfn/*'` — blocked before filtering by the repository's existing Probefn dependency cycle. The MailFn release gate's direct clean TypeScript builds all pass.

## Side effects and handoff

- No Cloudflare deployment or Email Routing/DNS change was made.
- No npm package was published.
- No Linear status/comment mutation was made.
- No files were staged or committed.
- The original Superfunctions checkout and its unrelated dirty changes were not modified; all implementation work is isolated in the requested worktree.

## Blockers

None for the requested local implementation. Live deployment/public release remains intentionally approval-gated.
