# SFN-17 Audit Remediation Completion Report

## Metadata

- Timestamp (UTC): 2026-08-10T18:17:48Z
- Issue: SFN-17 — Build MailFn as a reusable programmable mailbox function
- Source: https://linear.app/21n/issue/SFN-17/build-mailfn-as-a-reusable-programmable-mailbox-function
- Remediated audit: `.conduct/audits/2026-08-10-4dea7d06-full-audit.md`
- Agent: Codex
- Model: GPT-5
- Launcher: Codex Desktop
- Workspace: `/Users/serro/Documents/dev/n/worktrees/superfunctions/mailfn`
- Branch: `codex/sfn-17-mailfn`
- Clean base: `sf-next/next` at `9cf381238d1d8a11c899d6808ffb0bb73dfe839a`

## Status

PASS for the authorized local implementation scope. All phases and every locally actionable high- and medium-severity audit finding are implemented and regression-tested. Public activation remains a separate external gate: no Cloudflare deployment, Email Routing or DNS mutation, real-mail smoke, restore rehearsal, registry publication, billing/support activation, production-security approval, or public outbound enablement was performed.

## Audit finding disposition

### High severity

- **H-01 MCP transport:** replaced `Content-Length` framing with newline-delimited JSON-RPC, added initialization/version negotiation, process-level stdio tests, and an executable release-gate probe.
- **H-02 SendFn contract:** extended the checked-in SendFn contract and provider adapters for logical sender/reply identity, custom headers, attachments, and idempotency. `@mailfn/sendfn` is tested against the actual built SendFn package rather than a synthetic-only interface.
- **H-03 attachment discovery:** added safe attachment descriptors, scoped HTTP enumeration, typed client discovery/download metadata, MCP opt-in metadata, CLI commands, and testing-helper integration.
- **H-04 quota dimensions:** split project, inbox, and sender hourly quotas and implemented atomic memory/D1 reservations. Stored bytes, outbound daily usage, and active-inbox creation also use atomic reservations/transactions with compensation.
- **H-05 Cloudflare validation:** added real workerd tests using `@cloudflare/vitest-pool-workers` with actual local D1, R2, Queue batch, Email handler, migration, concurrent idempotency, replay, and quota behavior. A real Cloudflare-account Email Routing smoke remains an external release gate.
- **H-06 custom domains:** require exact configured zone ID/name ownership, explicitly read/enable Email Routing DNS configuration, reuse only an owned matching rule, reject conflicting rules, and compensate provider rule creation when active D1 state cannot be saved.
- **H-07 governance enforcement:** implemented compliance retention locks, exports, deletion-SLA audit monitoring, region/deployment matching, abuse and support list/update workflows, sender reputation scoring/blocking, usage access, and default-off billing/support/public gates.
- **H-08 atomic recovery:** project and inbox plus credential/idempotency creation are atomic; concurrent ingress unique conflicts return the canonical message and release losing R2/quota reservations. Raw, attachment, storage, outbound, and domain failure paths have explicit compensation.

### Medium severity

- **M-01 client type:** explicitly imports MailFn `Credential`; packed consumers are typechecked.
- **M-02 redaction:** CLI and MCP normal surfaces use strict metadata allow-lists; content and extraction are explicit actions.
- **M-03 audit TTL:** audit events persist their own retention expiry derived from stable or expiring inbox policy.
- **M-04 lifecycle depth:** drafts expose list/get/update/discard/send with compare-and-set sending; thread labels have an independent public lifecycle.
- **M-05 cursors:** scoped structured cursors reject stale, cross-inbox, and cross-query use.
- **M-06 attachment assertions:** testing helpers can obtain descriptors through the public client and assert them directly.
- **M-07 webhook/network defenses:** verification uses a durable delivery-ID replay store; dispatch resolves A/AAAA through DNS-over-HTTPS, rejects non-public destinations and redirects, and documents the still-required production egress policy.

## Additional completion evidence

- Four checked-in `.eml` fixtures cover quoted-printable alternatives, base64 Unicode, inline plus attachment content, and malformed/truncated input.
- Router/Cloudflare and unrelated framework-neutral consumer fixtures are compiled from clean packed tarballs.
- Numeric seven-day rollout thresholds, rollback/restore expectations, and explicit external release gates are documented in `mailfn/OPERATIONS.md`.
- Sender reputation automatically consumes abuse signals and blocks inbound mail from blocked senders; operators can list and override reputation state.
- Idempotency expiration deletion is conditional, preventing an expired replay cleanup from deleting a newer concurrent record.

## Verification

1. `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run gate:mailfn-release` — PASS.
   - Cleaned, built, and tested all eight publishable MailFn packages.
   - 81 MailFn tests passed: core 38, client 6, Cloudflare unit 20, real-workerd 6, testing 2, CLI 2, MCP 3, MailFn/SendFn adapter 3, facade 1.
   - Probed the packaged MCP executable over newline-delimited stdio.
   - Packed every package, installed all tarballs in a clean temporary project, imported every public entry point, and strictly typechecked the Router and unrelated consumer fixtures.
2. `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm test` in `sendfn/typescript` — PASS; 44 tests.
3. `npm ls @mailfn/core @mailfn/client @mailfn/cloudflare @mailfn/testing @mailfn/cli @mailfn/mcp @mailfn/sendfn mailfn sanitize-html --depth=0` — PASS.
4. `git diff --check` — PASS.
5. `npm --prefix docs run check:catalog` — baseline-only FAIL. MailFn-specific missing/extra/order checks are empty; the repository still reports pre-existing duplicate `http-openapi`/`oauth-router` entries and the existing `python-core` package-name mismatch.

## External gates not executed

The non-production Cloudflare deployment and real Email Routing/DNS/mail smoke, D1/R2 restore rehearsal, Router observation window, unrelated-consumer observation window, package publication, and public-production approval require separate authorization. The code and runbook are ready for those steps, but this report does not claim they occurred.

## Side effects and handoff

- No external system was mutated.
- No files were staged or committed.
- The implementation remains isolated in the requested clean-next worktree.
- The original FAIL audit remains unchanged as historical evidence; this report supersedes its implementation-status conclusion for the current worktree.
