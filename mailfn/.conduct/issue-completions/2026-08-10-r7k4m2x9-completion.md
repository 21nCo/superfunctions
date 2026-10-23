# SFN-17 Second Re-audit Remediation Completion

## Metadata

- Timestamp: `2026-08-10T20:15:41Z`
- Agent name: `unknown-agent`
- Model: `GPT-5 Codex`
- Launcher: `Codex Desktop`
- Workspace: `repo root`
- Environment: `Darwin arm64`, shell `zsh`
- Git branch: `codex/sfn-17-mailfn`
- Git commit: `9cf381238d1d8a11c899d6808ffb0bb73dfe839a`
- Git state: dirty; the MailFn implementation remains an uncommitted worktree change
- Issue: `mailfn/.conduct/issues/SFN-17.md`
- Remediated audit: `.conduct/audits/2026-08-11-9f087abf-full-audit.md`

## Issue summary

Resolve every locally actionable finding in the second SFN-17 full re-audit: provider leakage, inbound identity, CLI JSON disclosure, MCP protocol behavior, SendFn crash recovery, pre-stream ingress controls, quota-ledger aging, release enforcement, shared HTTP reuse, explicit protocol gates, and accurate product positioning.

## Status

**PASS** for the authorized local implementation scope. All code, security, reliability, protocol, repository-conformance, documentation, and release-gate findings are implemented and verified. Real Cloudflare/DNS/mail delivery, restore rehearsal, actual Router and unrelated-application integration, seven-day observation, publication, and public approval remain separately authorized external acceptance evidence and were not performed or claimed.

## Requirements summary

| Requirement | Status | Evidence | Test status |
| --- | --- | --- | --- |
| Provider-neutral domain core | PASS | `MailFnDomainAdapter.getRequiredDnsRecords` owns provider routing records; core adds only MailFn ownership TXT | Core and Cloudflare domain tests pass; negative core-source scan finds no Cloudflare endpoint/MX policy |
| Trustworthy Cloudflare delivery identity | PASS | Delivery key is SHA-256 over normalized envelope plus raw evidence, independent of sender-controlled `Message-ID` | Real-workerd test deduplicates Message-ID-less retry and preserves distinct messages sharing Message-ID |
| CLI JSON secrecy | PASS | Text and JSON use one command-aware sanitizer; `--show-content`, `--show-secrets`, and extraction are explicit exceptions | Four CLI tests pass, including credential and attachment JSON negative vectors |
| MCP JSON-RPC lifecycle | PASS | Request validation, initialization sequencing, silent notifications, notification-only method validation, and NDJSON stdio | Four MCP tests plus packaged process probe pass |
| SendFn stale-pending recovery | PASS | Conditional stale claim for idempotent providers; non-idempotent ambiguous transactions close as explicit failed state without a duplicate send | Full 46-test SendFn suite passes, including claim race and ambiguous-provider vectors |
| Cheap ingress checks before raw access | PASS | Recipient lifecycle, declared size, sender policy, ingress quota, and storage quota are preflighted; reservations compensate on stream or validation failure | Core preflight compensation, Worker no-raw-access, and workerd ingestion tests pass |
| Bounded ingress reservation ledger | PASS | Memory and D1 delete prior hourly buckets before reservation; D1 has a cleanup index | Real-workerd row-count aging test passes |
| SendFn release protection | PASS | Release gate runs the complete SendFn suite; workflow triggers on SendFn plus shared DB/HTTP paths | Exact final release gate passes |
| Shared HTTP abstraction | PASS | Cloudflare HTTP API exposes an `@superfunctions/http` `Router` with typed route metadata/context and centralized error handling | HTTP lifecycle/router metadata/error tests and packed consumers pass |
| Explicit future protocol gate | PASS | `protocolServicesEnabled` and `MAILFN_PROTOCOL_SERVICES_ENABLED` default false | Core/Cloudflare builds and all tests pass |
| Accurate product positioning | PASS | Docs describe selected primitive parity and a self-hosted function, not hosted-product parity | Documentation/source review complete |
| External runtime and consumer acceptance | UNVERIFIED | Explicit authorization boundary; runbook and thresholds remain ready | Not run; no external mutation authorized |

## Implementation summary

### Files modified in this remediation

- `mailfn/core/src/contracts.ts`
- `mailfn/core/src/types.ts`
- `mailfn/core/src/defaults.ts`
- `mailfn/core/src/service.ts`
- `mailfn/core/src/memory.ts`
- `mailfn/core/src/service.test.ts`
- `mailfn/cloudflare/src/domain.ts`
- `mailfn/cloudflare/src/domain.test.ts`
- `mailfn/cloudflare/src/worker.ts`
- `mailfn/cloudflare/src/worker.test.ts`
- `mailfn/cloudflare/src/workerd.integration.workerd.test.ts`
- `mailfn/cloudflare/src/d1-store.ts`
- `mailfn/cloudflare/src/http.ts`
- `mailfn/cloudflare/src/http.test.ts`
- `mailfn/cloudflare/src/migrations.ts`
- `mailfn/cloudflare/migrations/0001_mailfn.sql`
- `mailfn/cloudflare/package.json`
- `mailfn/cloudflare/wrangler.example.jsonc`
- `mailfn/cloudflare/README.md`
- `mailfn/cli/src/index.ts`
- `mailfn/cli/src/index.test.ts`
- `mailfn/cli/README.md`
- `mailfn/mcp/src/server.ts`
- `mailfn/mcp/src/server.test.ts`
- `mailfn/README.md`
- `mailfn/SPEC.md`
- `mailfn/THREAT_MODEL.md`
- `mailfn/OPERATIONS.md`
- `sendfn/typescript/src/database/sendfn-db.ts`
- `sendfn/typescript/src/email/provider.ts`
- `sendfn/typescript/src/email/service.ts`
- `sendfn/typescript/src/email/resend-adapter.ts`
- `sendfn/typescript/src/email/aws-ses-adapter.ts`
- `sendfn/typescript/tests/email.test.ts`
- `scripts/gate-mailfn-release.mjs`
- `.github/workflows/mailfn-release.yml`
- `package-lock.json`

No files were deleted.

### Key design decisions

- Raw-evidence fingerprinting is the strongest stable identity available from Cloudflare Email Workers, which expose no provider delivery identifier. Byte-identical envelope/raw evidence is one logical delivery; different raw evidence remains distinct even when `Message-ID` collides.
- Inbound preflights are opaque, single-use service reservations. Cancellation is idempotent and cannot release an already consumed/accepted reservation.
- SendFn reclaims only when the provider declares API-level idempotency. Providers without that guarantee transition stale pending work to an explicit ambiguous failure rather than risk a duplicate send.
- MailFn route/auth/envelope semantics remain MailFn-owned while path matching, route metadata/context, and error dispatch use the shared framework-neutral HTTP router.

## Verification summary

1. `PATH=<node-22-bin>:$PATH npm run gate:mailfn-release` — **PASS** on the final code snapshot.
   - 88 MailFn tests: core 39, client 6, Cloudflare unit 21, workerd 8, testing 2, CLI 4, MCP 4, MailFn/SendFn adapter 3, facade 1.
   - 46 SendFn tests across 11 files.
   - All eight MailFn packages cleaned, built, tested, packed, installed in a clean temporary project, and imported.
   - Router-style and framework-neutral packed consumers strictly typechecked.
   - Packaged MCP process produced exactly the two request responses and no notification responses.
2. `sqlite3 :memory: < mailfn/cloudflare/migrations/0001_mailfn.sql` — **PASS**.
3. `npm ls @mailfn/core @mailfn/client @mailfn/cloudflare @mailfn/testing @mailfn/cli @mailfn/mcp @mailfn/sendfn mailfn @superfunctions/http sanitize-html --depth=0` — **PASS**.
4. Negative source checks for Cloudflare policy in core and sender `Message-ID` delivery identity — **PASS**.
5. `git diff --check` and temporary tarball cleanup — **PASS**.
6. `npm --prefix docs run check:catalog` — baseline-only **FAIL**. MailFn missing/extra/order sections are empty; the repository still reports pre-existing duplicate `http-openapi`/`oauth-router` entries and the existing `python-core` package-name mismatch.

## Manual verification

- Confirmed the audit's former CLI JSON path now calls `context.output.json(safe)` rather than emitting the raw result.
- Confirmed `mailfn/core/src` contains neither Cloudflare MX values nor Cloudflare API endpoints.
- Confirmed the release script executes `sendfn/typescript` tests and the workflow path filter includes SendFn/shared dependencies.
- Confirmed the shared router exposes health as unauthenticated and v1 routes as bearer-authenticated metadata.

## Notes

- The original audit remains historical evidence and was not rewritten.
- No deployment, DNS mutation, package publication, Linear mutation, billing/support activation, public outbound enablement, staging, or commit occurred.
- Compile/package consumer fixtures are still correctly described as local contract evidence, not as actual Router production acceptance.
- Hosted-product parity is not claimed.
- No new TODOs or local deferrals were introduced.

## Blockers

None for the authorized local remediation. External acceptance evidence requires separate authorization.
