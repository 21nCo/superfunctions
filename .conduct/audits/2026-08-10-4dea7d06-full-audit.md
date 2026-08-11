# Full audit: SFN-17 MailFn all phases

## Metadata

| Field | Value |
|---|---|
| Timestamp | 2026-08-10T17:22:45Z |
| Agent | audit-agent |
| Model | GPT-5 (Codex) |
| Launcher | Codex Desktop |
| Repository root | `.` |
| OS / shell | Darwin arm64 / zsh |
| Git branch | `codex/sfn-17-mailfn` |
| Git commit | `9cf381238d1d8a11c899d6808ffb0bb73dfe839a` |
| Git state before audit artifacts | Dirty: six modified root files and three untracked MailFn/release paths |
| Audit mode | Thorough, read-only implementation audit; only this report and the required audit ledger row were written |
| Verdict | **FAIL — SFN-17 is broadly implemented but all phases are not fully complete** |

Commands used included repository inventory and diffs, targeted source searches, the MailFn release gate under Node 22, SQLite migration execution, dependency inspection, catalog validation, and focused behavioral probes for MCP stdio and project quota semantics. No deployment, DNS mutation, package publication, Linear mutation, or other external side effect was performed.

## Audit scope

The audit target is the complete local implementation of [Linear issue SFN-17](https://linear.app/21n/issue/SFN-17/build-mailfn-as-a-reusable-programmable-mailbox-function), interpreted using its two live supporting documents and the user's explicit requirement to audit **all phases**. This is stronger than the original issue description's planning-only execution note, so phases 0 through 4, their validation plan, release integration, and rollout claims are all treated as required audit surfaces.

Code scope:

- All source, tests, manifests, documentation, migration, and configuration under `mailfn/`.
- Root workspace/release/catalog integration in `package.json`, `package-lock.json`, `release-packages.json`, `README.md`, `docs/lib/ecosystem-catalog.ts`, `.github/workflows/mailfn-release.yml`, and `scripts/gate-mailfn-release.mjs`.
- The existing `sendfn/typescript/` public API and email service, because actual SendFn interoperability is an explicit SFN-17 boundary.
- Current modified, untracked, and baseline repository state. The pre-existing completion report was treated as a claim to verify, not as proof.

Out of scope:

- Authorizing or performing a live Cloudflare deployment, DNS changes, registry publication, billing/support activation, or public-production approval.
- Product features not required by the issue, such as a full webmail UI or general-purpose public IMAP/SMTP service.
- Fixing implementation defects.

## Inputs audited

### Authoritative intent and architecture

1. Live Linear issue SFN-17, fetched on 2026-08-10.
2. Live supporting document, “MailFn ideation and product rationale.”
3. Live supporting document, “MailFn architecture and phased delivery plan.”
4. User instruction to audit full implementation of every phase.

### Local specifications and claims

- `mailfn/.conduct/issues/SFN-17.md`
- `mailfn/SPEC.md`
- `mailfn/README.md`
- `mailfn/THREAT_MODEL.md`
- `mailfn/OPERATIONS.md`
- `mailfn/.conduct/issue-completions/2026-08-10-m7q2x9p4-completion.md`
- Package READMEs and public declaration output.

### Comparable-product evidence

- [MailSlurp](https://www.mailslurp.com/): programmable real inboxes, waits, OTP/testing flows, webhooks, SDKs, and custom-domain capabilities.
- [Mailtrap Inbound Email](https://mailtrap.io/inbound-email/): structured and raw inbound payloads, attachments, threading/replies, routing, signed webhook delivery, and retries.
- [AgentMail](https://www.agentmail.to/): inbox APIs, threads/replies, attachments, real-time events, custom domains, SDK/CLI/MCP, and agent-oriented retrieval.

The comparables are design references, not a requirement for exact feature parity. Gaps are findings only where SFN-17 independently promises the same capability.

### Standards and provider references

- [Model Context Protocol stdio transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Cloudflare Email Routing rules API](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/)
- [Cloudflare Email Routing DNS configuration API](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/)
- [Cloudflare Email Routing domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/)

## High-level findings

The implementation is substantial and not a scaffold. Eight publishable packages exist; the core has real storage contracts, scoped credentials, inbound processing, raw evidence, parsing, waits, extraction, threading, drafts, retention, webhooks, custom-domain records, operations, and public-platform gates. Release registration is comprehensive, and the clean-package gate passes all 52 tests plus build, pack, temporary install, public import, and migration checks.

That green gate does not prove the requested product is complete. The audit found **eight high-severity** and **seven medium-severity** gaps. The most consequential are independently reproducible:

1. The MCP executable does not speak the MCP stdio wire format. A normal newline-delimited `tools/list` request produces zero output.
2. The checked-in SendFn implementation cannot honor MailFn's reply headers, logical sender, attachment IDs, or stable idempotency key through the adapter path MailFn calls.
3. Attachments are stored, but no public response enumerates their IDs or metadata, so ordinary API/client consumers cannot discover what to download.
4. `maxMessagesPerHour` is enforced per inbox despite being a project quota; a second message through a second inbox is accepted. No sender quota exists.
5. Cloudflare tests use Node fakes rather than a Workers runtime, D1, R2, Queue, or Email Routing integration, so the required runtime validation is absent.
6. The custom-domain adapter uses one configured zone for every domain, creates an all-recipient rule, never enables/checks Email Routing through the provider DNS configuration endpoint, and can orphan or duplicate rules.
7. Phase 4 persists several governance records but does not enforce retention lock/deletion SLA/export policy and lacks complete abuse, billing, support, and reputation workflows.
8. Multi-step project/inbox creation and concurrent inbound dedupe are not transactional or compensating, leaving recoverability holes under partial failure/race conditions.

No cross-project credential-isolation bypass or obvious public open-relay path was found in the reviewed routes. Public outbound remains disabled by default and separately approval-gated. That is a positive security property, but it does not turn the incomplete phase-4 operational controls into a completed public-readiness phase.

## Intent Inventory

The following inventory reconstructs the complete intent from the live issue and documents. Audit IDs are introduced here because the source documents do not provide stable requirement identifiers.

### Product and package boundary

- **INT-01** Independently publishable and deployable MailFn package family.
- **INT-02** MailFn owns inbox identity, inbound state, retrieval, testing, lifecycle, and mailbox semantics.
- **INT-03** SendFn owns outbound transport; TestFn may consume MailFn without owning it.
- **INT-04** Provider-neutral core with no Cloudflare imports.
- **INT-05** Reusable from Router and unrelated applications without product-specific assumptions.
- **INT-06** Stable and expiring inbox modes with explicit behavior.

### Inbound, storage, and retrieval

- **INT-07** Create returns address, inbox identifier, scoped credential, and expiry where relevant.
- **INT-08** Real inbound mail through Cloudflare Email Routing and an Email Worker.
- **INT-09** Raw-first persistence to R2, durable metadata/state in D1, parsing through Queue/DLQ.
- **INT-10** Robust MIME parsing across text, HTML, multipart, encodings, malformed input, threading headers, authentication results, and attachments.
- **INT-11** Parsed and normalized bodies plus original raw evidence.
- **INT-12** Attachment metadata, hashes, identifiers, retrieval, and retention.
- **INT-13** Inbox lifecycle, expiry, revocation, deletion, and credential revocation.
- **INT-14** Message list/read with filters, stable pagination, unread state, and search.
- **INT-15** Wait semantics with sender/recipient/subject/time/status/expected-count predicates, typed timeout, cancellation, and reconnect-safe behavior.
- **INT-16** Deterministic OTP and verification-link extraction with source attribution and stale-message avoidance.

### Security, reliability, and operations

- **INT-17** Least-privilege, hashed, one-time-visible credentials with project and inbox isolation and contained delegation.
- **INT-18** Generic rejection of unknown/inactive recipients without leaking tenant state.
- **INT-19** Idempotent ingress, dedupe, retries, DLQ/reconciliation, and explicit compensation for every cross-service write order.
- **INT-20** Independent message/raw/attachment/audit retention clocks and observable, retryable deletion.
- **INT-21** Signed webhooks with timestamp/replay protection, retries, quarantine, and delivery idempotency.
- **INT-22** Project, inbox, sender, size, storage, and outbound quotas/rate controls.
- **INT-23** OTP/link secrecy, no sensitive content in normal logs, HTML sanitization, remote-image blocking, attachment safety, and secure webhook egress.
- **INT-24** Metadata-only observability, audit trails, metrics, dashboards, alerts, and runbooks.
- **INT-25** Versioned schemas/events/jobs, migrations, rollback, backups, and reconciliation.

### Client and automation surfaces

- **INT-26** Typed TypeScript client with stable errors, bounded retries, aborts, and complete public types.
- **INT-27** CLI with safe defaults, useful inbox/message/wait/extract operations, and explicit content reveal.
- **INT-28** Narrow, inbox-scoped, metadata-minimizing MCP server using the standard transport.
- **INT-29** Test fixtures, runner lifecycle, deterministic waits, and assertions for message and attachment evidence.

### Mailbox depth and public readiness

- **INT-30** Threads with deterministic fallback threading.
- **INT-31** Labels and label-aware listing/search/thread behavior.
- **INT-32** Draft lifecycle.
- **INT-33** Reply/reply-all/forward through real SendFn composition, preserving headers, attachments, sender identity, and idempotency.
- **INT-34** Custom-domain onboarding, diagnostics, reversible routing, and verified sender controls.
- **INT-35** Public tenancy/isolation and limits.
- **INT-36** Abuse/reputation, billing/metering, support, compliance, deletion SLA, data residency, and launch approval gates.
- **INT-37** No arbitrary public outbound or implicit open relay.

### Validation, release, and rollout

- **INT-38** Unit, MIME, real Cloudflare integration, authorization, concurrency, retry, webhook, retention, and DNS validation.
- **INT-39** Router consumer validation plus at least one unrelated consumer proving reusability.
- **INT-40** Workspace/release registration, package metadata, dedicated CI, pack/install/import, and migration coverage gates.
- **INT-41** Internal-domain rollout, measured latency/reliability/extraction/storage/operational thresholds, and rollback readiness.
- **INT-42** Explicit approval before public activation, deployment, DNS mutation, or registry publication.

## Intent → Spec coverage matrix

| Intent IDs | Live issue / architecture | Local spec coverage | Coverage assessment |
|---|---|---|---|
| INT-01–06 | Boundary, principles, packages, phases 0–1 | `mailfn/SPEC.md:5-42`, package manifests | Covered |
| INT-07–16 | Core model, inbound flow, API, waits/extraction | `mailfn/SPEC.md:34-43`, `mailfn/README.md:23-60` | Covered, but attachment discovery and pagination failure semantics are underspecified |
| INT-17–25 | Security, reliability, retention, operations | `mailfn/THREAT_MODEL.md`, `mailfn/SPEC.md:84-97`, `mailfn/OPERATIONS.md` | Covered at policy level; exact compensation and webhook replay state are not specified concretely |
| INT-26–29 | SDK, CLI, MCP, testing | `mailfn/SPEC.md:44-50`, package READMEs | Covered, but the MCP wire protocol/version is not pinned |
| INT-30–34 | Threads, labels, search, drafts, SendFn, domains | `mailfn/SPEC.md:52-59` | Covered as outcome claims; draft lifecycle and the exact checked-in SendFn contract are not traced |
| INT-35–37 | Public controls and no open relay | `mailfn/SPEC.md:60-67`, `mailfn/THREAT_MODEL.md` | Covered, but “implemented” is conflated with “persisted/configurable” |
| INT-38–41 | Validation, release, rollout | `mailfn/SPEC.md:97`, `mailfn/OPERATIONS.md:32-40` | Partial: real-runtime and consumer/rollout validation is deferred, with no recorded success thresholds |
| INT-42 | External side-effect and approval boundary | `mailfn/.conduct/issues/SFN-17.md`, `mailfn/README.md:72` | Covered and respected |

## Requirement coverage summary

Status definitions:

- **PASS**: implementation and proportionate evidence satisfy the requirement.
- **PARTIAL**: material implementation exists, but a required behavior or proof is incomplete.
- **FAIL**: a central behavior is absent, incompatible, or reproducibly broken.
- **UNVERIFIED**: the requirement depends on an authorized external state that was not available or was explicitly out of bounds.

| Requirement set | Pass | Partial | Fail | Unverified | Overall |
|---|---:|---:|---:|---:|---|
| Live issue acceptance criteria (10) | 5 | 2 | 3 | 0 | FAIL |
| Local all-phase acceptance criteria (6) | 1 | 3 | 2 | 0 | FAIL |
| Phase 0 items (6) | 2 | 4 | 0 | 0 | PARTIAL |
| Phase 1 items (9) | 5 | 4 | 0 | 0 | PARTIAL |
| Phase 2 items (8) | 1 | 4 | 2 | 1 | FAIL |
| Phase 3 items (6) | 2 | 3 | 1 | 0 | FAIL |
| Phase 4 items (6) | 1 | 4 | 0 | 1 | PARTIAL / approval-gated |
| Validation plan (11) | 4 | 3 | 4 | 0 | FAIL |

The counts are separate traceability ledgers and must not be summed as unique requirements because some phase items restate acceptance criteria.

## Requirement-by-requirement results

### Live issue acceptance criteria

| ID | Requirement | Status | Evidence and rationale |
|---|---|---|---|
| AC-01 | Boundary documented and approved | PARTIAL | Boundary is clear in `mailfn/SPEC.md` and package design; live Linear has no approval comment or other approval evidence. |
| AC-02 | Core contract covers inboxes, messages, attachments, threads, scoped credentials, storage, inbound | PASS | Real interfaces and service/storage implementations exist across `mailfn/core/src/`; Cloudflare adapters implement the contracts. |
| AC-03 | Cloudflare design covers Email Routing, Workers, D1, R2, Queues, DNS, failure handling | PASS | Architecture and operations docs cover the topology and failure expectations. Runtime proof is separately failed under AC-08/VAL-03. |
| AC-04 | Initial API covers stable/expiring lifecycle, list/read/wait/filtering, OTP/link, retention, revocation | PASS | Routes and core behaviors are implemented and tested; lower-severity cursor behavior remains in M-05. |
| AC-05 | TypeScript SDK, CLI, MCP with least privilege | FAIL | SDK/CLI exist, but the public SDK emits the wrong `Credential` type and MCP stdio is wire-incompatible; see H-01 and M-01. |
| AC-06 | Security model covers secrecy, scopes, webhook verification, idempotency, rejection, retention/deletion, rate limits, audit | PARTIAL | Strong credential containment and public outbound gating exist, but sender/project rate controls, webhook replay state, redaction, and policy enforcement are incomplete. |
| AC-07 | Send/reply/forward through SendFn rather than duplicate outbound provider logic | FAIL | An adapter exists, but it is incompatible with the actual checked-in SendFn contract for headers, sender, attachments, and idempotency; see H-02. |
| AC-08 | Test plan covers MIME, concurrency, verification, attachments, retries, expiry, auth, Cloudflare failures | FAIL | Local tests cover many service paths but not real Workers/D1/R2/Queue/Email Routing, true concurrent delivery dedupe, or consumer-level attachment discovery. |
| AC-09 | Phased roadmap from initial inboxes to durable service and public-readiness work | PASS | `mailfn/SPEC.md:24-67` and the live architecture document provide phases 0–4. |
| AC-10 | Release registration, package metadata, scoped CI, dedicated quality gate | PASS | Eight packages are registered; workflow and gate cover build/test/pack/install/import/migration. |

### Local all-phase acceptance criteria

| ID | Requirement | Status | Evidence and rationale |
|---|---|---|---|
| LAC-01 | Phase-0 compatibility, tenancy, retention, threat, failure, and launch decisions complete | PARTIAL | Most decisions are documented, but approval, success thresholds, backup expectations, and exact multi-store compensation remain unresolved. |
| LAC-02 | Complete Phase-1 inbound/durable/API/client/auth/failure behavior | PARTIAL | Broadly real, but attachment discovery, project/sender quotas, concurrency, and real-runtime evidence are incomplete. |
| LAC-03 | Complete Phase-2 CLI/MCP/webhook/domain/testing/retention/audit/reconciliation/operations | FAIL | MCP transport is unusable; domain setup is not provider-complete; webhook replay and attachment test ergonomics are incomplete. |
| LAC-04 | Complete Phase-3 threads/labels/search/drafts/SendFn/delegation | FAIL | Threads and delegation are meaningful; labels/search/drafts are shallow and actual SendFn composition loses required semantics. |
| LAC-05 | Implement gated Phase-4 public controls without activation | PARTIAL | The closed-by-default gate is correct, but several controls are data records rather than enforced operational capabilities. |
| LAC-06 | Register/release-gate every package without external side effects | PASS | Gate passes and no external side effects occurred. |

### Phase 0 — definition and release design

| ID | Requirement | Status | Evidence and rationale |
|---|---|---|---|
| PH0-01 | Approved boundary and package split | PARTIAL | Split is implemented; approval is not evidenced. |
| PH0-02 | Versioned API, event, queue, and schema contracts | PASS | Constants, types, migrations, and envelopes exist. |
| PH0-03 | Stable/expiring retention defaults | PASS | Defaults exist and message/object clocks are applied. |
| PH0-04 | Threat model and failure matrix | PARTIAL | Documented, but multi-write compensation is not exhaustive and several stated controls are not enforced. |
| PH0-05 | Resolve open product/tenancy/extraction/wait/visibility questions | PARTIAL | Most have implementation choices; success thresholds, backup/restore guarantees, and public approval remain open. |
| PH0-06 | Release/compatibility/rollback design | PARTIAL | Packaging and migration are covered; no actual rollback/restore or upgrade-compatibility proof is recorded. |

### Phase 1 — inbound test inbox and Cloudflare durability

| ID | Requirement | Status | Evidence and rationale |
|---|---|---|---|
| PH1-01 | Provider-neutral core | PASS | `mailfn/core` has no Cloudflare dependency. |
| PH1-02 | Email Worker and recipient rejection | PARTIAL | Worker behavior exists and unknown/inactive recipients are rejected, but only fake-runtime tests exercise it. |
| PH1-03 | D1, R2, Queue, DLQ, raw-first flow | PASS | Concrete adapters, migration, raw-first write, queue status, reconciliation, and DLQ concepts exist. |
| PH1-04 | Stable/expiring inbox lifecycle | PASS | Create/update/delete/expire and scoped credentials are real. |
| PH1-05 | Parsed/raw/attachment evidence | PARTIAL | Storage is real; public attachment enumeration is absent. |
| PH1-06 | List/read/wait/filter/extract | PASS | Core and HTTP/client behavior exist with typed waits and extraction attribution. |
| PH1-07 | Typed TypeScript client | PARTIAL | Broad surface and retry behavior exist, but `revokeToken` emits the unrelated DOM `Credential` type. |
| PH1-08 | Scoped tokens and isolation | PASS | Hashed credentials, project/inbox checks, scope containment, revocation, and expiry are implemented. |
| PH1-09 | Failure-mode verification | PARTIAL | Unit fakes cover failures; real Cloudflare and concurrency validation does not. |

### Phase 2 — integrations and operations

| ID | Requirement | Status | Evidence and rationale |
|---|---|---|---|
| PH2-01 | Safe CLI | PARTIAL | Commands work and bodies/tokens are redacted by key name, but subjects/headers/metadata may expose OTPs or links. |
| PH2-02 | Standard, narrow MCP server | FAIL | Tool logic exists, but the executable uses `Content-Length` framing rather than newline-delimited MCP stdio. |
| PH2-03 | Signed, retrying, replay-safe webhooks | PARTIAL | HMAC/timestamp, retry, quarantine, and delivery records exist; inbound verification has no delivery-ID replay store and SSRF protection relies on external egress policy for DNS resolution. |
| PH2-04 | Custom-domain onboarding and reversible routing | FAIL | Record model and delete exist, but zone/domain binding, Email Routing enablement, and failure compensation are incomplete. |
| PH2-05 | Test runner and attachment assertions | PARTIAL | Fixtures/waits/assertions exist; attachment metadata cannot be obtained through the client and `assertMessage` always rejects attachment expectations. |
| PH2-06 | Retention and audit | PARTIAL | Core behavior exists, but expiring audit TTL is not applied and compliance retention lock is not enforced. |
| PH2-07 | Reconciliation, snapshots, alerts, runbook | PASS | Implemented with operational documentation. |
| PH2-08 | Non-production Cloudflare proof | UNVERIFIED | Explicitly deferred in `mailfn/OPERATIONS.md:40`; no deployment authorization or evidence was present. |

### Phase 3 — mailbox depth and SendFn composition

| ID | Requirement | Status | Evidence and rationale |
|---|---|---|---|
| PH3-01 | Threads | PASS | Internet-message threading plus fallback normalized-subject behavior exist. |
| PH3-02 | Labels | PARTIAL | Message label replacement exists, but no independent thread-label lifecycle is exposed and thread labels are overwritten from one message's set. |
| PH3-03 | Search | PARTIAL | D1 FTS and memory search exist; missing/stale cursors silently restart at page one. |
| PH3-04 | Draft lifecycle | PARTIAL | Create and send exist; no list/get/update/delete/discard public lifecycle is exposed. |
| PH3-05 | Reply/reply-all/forward through actual SendFn | FAIL | MailFn constructs correct intent internally, but the checked-in SendFn path cannot carry key fields. |
| PH3-06 | Delegation and agent policy controls | PASS | Credential delegation containment and inbox scoping are real. |

### Phase 4 — gated public readiness

| ID | Requirement | Status | Evidence and rationale |
|---|---|---|---|
| PH4-01 | Public tenancy and quotas | PARTIAL | Project isolation is strong; project message quota is misapplied per inbox and sender-rate/reputation controls are absent. |
| PH4-02 | Verified-domain and outbound approval gates | PASS | Public outbound is off by default and requires explicit approval plus verified domains. |
| PH4-03 | Abuse/reputation operations | PARTIAL | Abuse records can be opened; no triage/resolution/reputation enforcement flow exists. |
| PH4-04 | Billing/metering and support | PARTIAL | Usage records and case creation exist behind flags; billing and case-management workflows are not complete. |
| PH4-05 | Compliance/data residency/deletion controls | PARTIAL | Profiles are stored, but lock/export/SLA semantics are not enforced and residency is a label/allow-list rather than demonstrated placement. |
| PH4-06 | Public-production approval and rollout | UNVERIFIED | Correctly not activated; no approval or live rollout evidence exists. |

### Validation plan

| ID | Requirement | Status | Evidence and rationale |
|---|---|---|---|
| VAL-01 | Unit coverage for normalization, permissions, retention, extraction, threading | PASS | Covered across 26 core tests. |
| VAL-02 | MIME fixture matrix including encodings and malformed input | FAIL | Two parser tests exercise one rich fixture and one simple malformed body, not a matrix of real fixtures and failure cases. |
| VAL-03 | Actual Workers/D1/R2/Queue/Email Routing integration | FAIL | Every Vitest config uses Node; Cloudflare services are faked. |
| VAL-04 | Cross-project and cross-inbox authorization | PASS | Explicit isolation and scope tests exist. |
| VAL-05 | Concurrent signup/message attribution | PARTIAL | Attribution predicates are tested after sequential insertion; no truly concurrent delivery or waiter race is exercised. |
| VAL-06 | Retry/idempotency/at-least-once behavior | PARTIAL | Sequential duplicate and queue retry tests exist; concurrent uniqueness races and multi-write compensation do not. |
| VAL-07 | Webhook signature and replay | PARTIAL | Signature/timestamp checks exist; persistent replay-key rejection is absent. |
| VAL-08 | Retention and delete lifecycle | PASS | Object deletion retry and independent clocks are tested, subject to the audit-TTL issue. |
| VAL-09 | DNS/custom-domain smoke | FAIL | Provider calls are mocked; no zone-specific or Email Routing configuration smoke exists. |
| VAL-10 | Router plus unrelated consumer | FAIL | No consumer integration evidence exists in the worktree. |
| VAL-11 | Build/typecheck/test/pack/install/import/migration gate | PASS | Dedicated release gate succeeds. |

## Spec conflicts / spec gaps

1. **Execution-scope conflict.** The live issue says the original backlog item is planning/documentation only, while the local issue says to implement every phase and the local completion report claims all phases complete. The user's explicit audit target resolves the audit scope in favor of all phases, but this divergence should be reconciled in Linear.
2. **Phase-4 approval conflict.** The live architecture says phase 4 is only after explicit public-product approval. No approval evidence exists. It is valid to implement closed-by-default primitives, but invalid to claim the phase is complete when required operational workflows and approval are absent.
3. **Completion claim exceeds evidence.** `mailfn/.conduct/issue-completions/2026-08-10-m7q2x9p4-completion.md:19` says every implementation phase is complete. H-01 through H-08 directly contradict that claim.
4. **MCP transport unspecified locally.** The local spec promises MCP but does not pin a protocol version or stdio framing. This let an LSP-style `Content-Length` transport pass unit tests while violating the MCP standard.
5. **SendFn contract not traced.** The spec promises preserved threading headers, attachments, sender identity, and idempotency but does not map those fields to the actual `sendfn/typescript` public interface.
6. **Attachment discovery omitted from route design.** The API table specifies only a direct attachment download route and never specifies where attachment IDs/metadata are listed.
7. **Quota dimensions are not formalized.** The architecture requests project/inbox/sender controls; the model has one project `maxMessagesPerHour` field, and the implementation interprets it as per-inbox.
8. **Compliance semantics are declarative only.** The spec labels phase-4 compliance “implemented,” but does not define how retention locks, deletion SLAs, exports, or residency are enforced and verified.
9. **No stable source requirement IDs.** The live documents and local specs use prose/bullets only. This audit introduced IDs; future implementation and tests should trace to canonical IDs.
10. **Rollout thresholds missing.** The live plan requires measured success thresholds for reliability, extraction accuracy, storage cost, and operational burden; no numeric thresholds or recorded consumer results were found.

## Cross-cutting audits

### High-severity findings

#### H-01 — MCP stdio transport is not MCP-compatible

`mailfn/mcp/src/server.ts:135-164` waits for `Content-Length: ...\r\n\r\n` frames and emits the same format. MCP stdio requires each JSON-RPC message on its own line. The tests call `MailFnMcpServer.handleRequest` directly and never exercise the process transport. A standard newline-delimited `tools/list` probe produced zero bytes.

Impact: normal MCP hosts cannot initialize or call MailFn, so the phase-2 agent surface is unusable even though package unit tests pass.

Recommendation: use the official MCP SDK stdio transport or implement newline-delimited JSON exactly, add initialize/capability negotiation and protocol-version tests, and spawn the packaged executable in an integration test.

#### H-02 — SendFn adapter is incompatible with the repository's real SendFn

`mailfn/sendfn/src/index.ts:52-70` sends MailFn's logical sender, threading headers, attachment IDs, and idempotency key only as metadata when using `sendfn.email`. The actual `SendEmailParams` in `sendfn/typescript/src/types.ts:78-90` has no header, sender, or idempotency fields and expects full attachment payloads. `sendfn/typescript/src/email/service.ts:42-70` uses configured `fromEmail`/`replyTo` and never promotes MailFn metadata into transport headers or attachments.

Impact: replies lose `In-Reply-To`/`References`, forwarded attachments are not sent, the inbox address may not be the actual From/Reply-To identity, and stable draft idempotency is not enforced. Unit tests pass because they use a synthetic interface that is more capable than the real dependency.

Recommendation: define and implement an explicit SendFn transport contract for custom headers, verified sender/reply identity, attachment data or resolvers, and provider idempotency; add a package-level integration test against the actual checked-in SendFn service.

#### H-03 — Stored attachments are not discoverable through the public API/client

`Message` has no attachment collection (`mailfn/core/src/types.ts:110-145`). The HTTP handler has only a direct `.../attachments/:attachmentId` route (`mailfn/cloudflare/src/http.ts:110-114`). `MailFnClient.downloadAttachment` requires a caller-supplied ID and returns only bytes despite advertising optional metadata (`mailfn/client/src/client.ts:103-112`). The internal store can list attachments, but no public route/client method exposes that list.

Impact: ordinary consumers cannot learn attachment IDs, filenames, types, sizes, or hashes and therefore cannot reliably download or assert attachments. This misses a direct SFN-17 requirement and a capability present in all three comparable products.

Recommendation: include sanitized attachment descriptors on message reads or add a scoped attachment-list endpoint and client method; return metadata with bytes; connect testing helpers to that surface.

#### H-04 — Project and sender rate controls do not match the security contract

The model calls `maxMessagesPerHour` a project quota, but `mailfn/core/src/service.ts:461-465` counts messages for only the current inbox. A targeted probe with a project limit of one and two inboxes accepted one message in each (`SECOND_ACCEPTED`). There is no sender-rate quota field or enforcement path.

Impact: tenants can multiply allowed inbound rate by creating inboxes, and abusive senders cannot be throttled independently. This weakens the phase-4 tenancy/abuse boundary and contradicts the live architecture's project/inbox/sender dimensions.

Recommendation: define separate project, inbox, and sender dimensions, enforce them atomically in durable storage, and add multi-inbox and multi-sender tests.

#### H-05 — Required Cloudflare runtime integration is not tested

All `mailfn/*/vitest.config.ts` files use the Node environment. Cloudflare tests use recording fakes or memory storage; there is no Workers pool, Miniflare/workerd, actual D1 SQL behavior, R2 object behavior, Queue delivery/retry, Email Worker invocation, or non-production Email Routing smoke. `mailfn/OPERATIONS.md:40` explicitly defers the runtime validation.

Impact: the release gate can pass even if binding shapes, transactions/batches, streaming/raw limits, queue semantics, scheduled handlers, or deployed routing fail. The live architecture explicitly requires actual Cloudflare integration tests.

Recommendation: add `@cloudflare/vitest-pool-workers` or equivalent workerd integration coverage, then perform the documented disposable non-production smoke under explicit authorization before claiming runtime readiness.

#### H-06 — Custom-domain setup is zone-global and provider-incomplete

`mailfn/cloudflare/src/domain.ts:23-33` ignores the requested domain when choosing a zone and always uses the single configured `zoneId`; it creates an `all` recipient routing rule. DNS verification reads general DNS records, but the adapter never invokes Cloudflare's Email Routing DNS configuration/enable endpoint. In `mailfn/core/src/service.ts:1093-1110`, route creation occurs before saving the active state, without compensation if the save fails; a retry can create another rule.

Impact: multi-domain/multi-tenant deployments can mutate the wrong zone, an all-recipient rule can capture unrelated zone mail, routing may remain disabled despite apparently valid MX records, and partial failures can orphan provider state.

Recommendation: resolve and authorize the exact zone per domain, configure/check Email Routing explicitly, use a literal/catch-all rule matching the intended domain policy, persist an operation state/idempotency key, and compensate or reconcile orphan rules.

#### H-07 — Phase-4 governance controls are records, not completed enforcement

`mailfn/core/src/service.ts:1239-1247` validates and saves a `ComplianceProfile`, but `retentionLocked`, `exportEnabled`, and `deletionSlaHours` are not consulted by retention, export, or deletion behavior. Abuse and support surfaces mostly create records; reputation, triage/resolution, billing collection, compliance export, and deletion-SLA monitoring are absent. Data-region selection is an allowed string rather than demonstrated physical placement.

Impact: the package cannot substantiate the local claim that phase 4 is fully implemented. These are reasonable future/public gates, but they must be marked incomplete until their behavior and operations exist.

Recommendation: change status claims to gated/incomplete, or implement and verify each control end to end with explicit state transitions, enforcement hooks, metrics, and operator workflows.

#### H-08 — Multi-write creation and ingress dedupe lack atomic recovery

`bootstrapProject` saves the project before issuing its only credential (`mailfn/core/src/service.ts:137-179`). `createInbox` saves the active inbox before issuing the credential and idempotency replay record (`mailfn/core/src/service.ts:333-362`). Inbound dedupe performs a read-before-write (`mailfn/core/src/service.ts:448-475`), so concurrent duplicate deliveries can both pass the lookup and race the unique write; the loser becomes a storage failure rather than returning the already accepted message.

Impact: injected or real storage failures can leave projects/inboxes that the caller cannot claim, and concurrent provider retries are not transparently idempotent. The architecture required an explicit compensation matrix for cross-service orderings.

Recommendation: add durable transactions where possible, reserve operation/idempotency records before creating user-visible resources, implement compensation/recovery states, and make unique-conflict ingress re-read and return the canonical record.

### Medium-severity findings

#### M-01 — Public client declarations expose the wrong `Credential` type

`mailfn/client/src/client.ts:87` returns `Promise<Credential>` without importing MailFn's `Credential`. DOM library globals allow compilation, and the emitted declaration repeats that unrelated browser type. Consumers therefore see fields such as DOM credential `id/type`, not MailFn credential status/scopes.

Recommendation: import the MailFn type explicitly and add a consumer type test that builds with a minimal non-DOM TypeScript configuration.

#### M-02 — Redaction can expose verification secrets in subject, headers, and metadata

`mailfn/cli/src/index.ts:100-107` redacts only keys matching body/token/secret/verification/raw patterns. OTPs and magic links frequently appear in `subject`, `headers`, or metadata. MCP metadata includes `subject` (`mailfn/mcp/src/server.ts:184-189`). This conflicts with the stated default that secret-bearing values are minimized.

Recommendation: define sensitivity by command/tool and value provenance rather than key regex alone; default to a strict allow-list of non-content metadata and require explicit reveal/extract operations.

#### M-03 — Expiring inbox audit retention does not use the documented 90-day default

`mailfn/SPEC.md:28` documents a 90-day audit TTL for expiring inboxes, but `runRetention` deletes all project audits using only `project.defaultRetentionPolicy.auditTtlSeconds` (`mailfn/core/src/service.ts:1188-1189`). Audits lack inbox retention provenance, so the expiring policy cannot be applied.

Recommendation: either make audit retention strictly project-wide in the spec or persist retention class/inbox linkage and enforce the documented clock.

#### M-04 — Draft and label lifecycle is shallower than the phase-3 claim

HTTP exposes draft create and send only (`mailfn/cloudflare/src/http.ts:136-143`), with no list/get/update/delete/discard flow. Message labels are replaced, but thread labels have no direct API or independent semantics.

Recommendation: define the minimum phase-3 lifecycle explicitly and either implement the missing transitions or narrow the completion claim.

#### M-05 — Missing/stale pagination cursors silently restart at the first page

Both list and search compute `Math.max(0, findIndex(...) + 1)` (`mailfn/core/src/service.ts:741-746`, `823-828`). A cursor for a missing/deleted/message from another inbox resolves to index zero and repeats page one rather than returning an invalid-cursor error.

Recommendation: use signed/structured cursors with scope and sort key, and reject unknown or mismatched cursors.

#### M-06 — Testing package advertises attachment assertions it cannot obtain through its own client

`assertMessage` accepts attachment expectations but always throws and instructs users to call `assertAttachments` (`mailfn/testing/src/index.ts:113-161`). Because H-03 prevents normal metadata retrieval, the testing flow cannot deliver the advertised client-level assertion experience.

Recommendation: add a fixture/client attachment-list method and make the higher-level assertion fetch or accept those descriptors consistently.

#### M-07 — Webhook replay and network-destination defenses are incomplete

Webhook delivery retries are durable, and a verification helper checks signature/time, but no persistent delivery-ID nonce prevents replay within the accepted time window. URL validation rejects obvious local literals, while DNS resolution/rebinding defense is delegated to deployment egress policy.

Recommendation: include and persist a delivery identifier for inbound verification, reject duplicates, resolve/validate destinations at dispatch, and enforce outbound network policy in the deployed runtime.

### Comparable-product audit

| Capability promised by SFN-17 | MailSlurp | Mailtrap Inbound | AgentMail | MailFn audited state |
|---|---|---|---|---|
| Real programmable inbox | Yes | Yes | Yes | Core/runtime code exists; live/runtime proof absent |
| Wait/retrieval primitives | Yes | Webhook/API-centric | Events/API | Implemented and unit-tested |
| Raw and parsed evidence | Yes | Yes | Yes | Implemented |
| Discoverable attachments | Yes | Yes | Yes | Stored but public discovery missing (H-03) |
| Threads/replies | Yes | Yes | Yes | Threads exist; actual SendFn reply semantics break (H-02) |
| Custom domains | Yes | Yes | Yes | Model exists; Cloudflare setup incomplete (H-06) |
| Webhooks/events | Yes | Yes | Yes | Implemented with replay/network gaps |
| MCP/agent surface | Not the primary differentiator | Not the primary differentiator | Yes | Tools exist; stdio transport unusable (H-01) |
| Testing/OTP use case | Strong | Sandboxing/inbound testing | Agent OTP workflows | Core extraction/waits are meaningful; secret minimization and full integration proof incomplete |

MailFn's differentiators—provider-neutral core, explicit Cloudflare adapter, test fixtures, and SendFn composition—are coherent design choices. The audit failures concentrate precisely where those abstractions meet real transports or public consumers.

### Security audit

Positive evidence:

- Credential tokens are hashed, shown once, scoped, expirable, revocable, and contained by project/inbox authorization checks.
- Delegated credentials cannot exceed caller scopes or escape their inbox.
- Unknown/inactive recipient rejection is generic.
- Raw and content responses use no-store/private response headers.
- HTML sanitization and remote-image blocking exist.
- Public outbound is disabled by default and approval/domain gated.
- Audits avoid storing the extracted OTP/link value itself.

Residual security gaps are H-04, H-06, H-07, M-02, and M-07. No critical tenant-isolation break was demonstrated.

### Reliability and data-lifecycle audit

Positive evidence:

- Raw MIME is written before parse queuing.
- Queue failure state is durable and reconcilable.
- Attachment/object failures are represented and retention object deletion is retryable.
- Webhook retries and dead-letter/quarantine behavior exist.
- Inbox expiry and credential revocation are implemented.

Residual reliability gaps are H-08, M-03, and M-05. Backup/restore, migration upgrade/rollback, deployed Queue behavior, and operational thresholds are unproven.

### Release and repository integration audit

The eight packages are present in workspace and release registries, have scoped names and public exports, and are covered by `.github/workflows/mailfn-release.yml` and `scripts/gate-mailfn-release.mjs`. The gate validates package creation and clean-project imports, which is materially stronger than source-only tests.

The work is not committed: the entire `mailfn/` tree and release workflow/gate are untracked, while root integration files are modified. This is not a functional failure for a local audit, but it means no immutable review or CI execution on the actual snapshot exists yet.

## Recommendations

### Release blockers

1. Replace the MCP process transport with standards-compliant stdio and add executable-level protocol tests.
2. Reconcile MailFn's SendFn adapter with the actual SendFn contract; prove threading headers, logical sender/reply identity, attachments, and idempotency through a real package integration test.
3. Add public attachment enumeration/metadata and wire it through the client, MCP/CLI as appropriate, and test helpers.
4. Correct quota modeling/enforcement for project, inbox, and sender dimensions using durable atomic counters or equivalent.
5. Add workerd-based Cloudflare integration tests and complete an authorized disposable-environment Email Routing smoke before any runtime-ready claim.
6. Redesign custom-domain setup around exact zone ownership, explicit Email Routing enablement, scoped matchers, idempotency, and compensation.
7. Mark phase 4 as incomplete/approval-gated until governance controls are enforced end to end; do not retain the “all phases complete” claim.
8. Add transactional or recoverable state machines for project/inbox creation and concurrent ingress dedupe.

### Important follow-up

9. Fix the client `Credential` import and add declaration-consumer tests without DOM globals.
10. Make CLI/MCP default output allow-list-based and treat subject/header/metadata as potentially secret.
11. Resolve audit-retention semantics for expiring inboxes.
12. Complete or explicitly narrow draft/label lifecycle claims.
13. Reject stale/mismatched cursors.
14. Add persistent webhook replay protection and deployed egress controls.
15. Define rollout success thresholds and validate Router plus an unrelated consumer.

### Suggested acceptance sequence

1. Fix H-01 through H-04 and add focused regression tests.
2. Fix H-06/H-08 and run workerd integration coverage.
3. Re-run the package/release gate and consumer type/package tests.
4. Under explicit authorization, run the non-production Cloudflare/DNS/real-mail smoke from `mailfn/OPERATIONS.md`.
5. Record Router and unrelated-consumer evidence plus thresholds.
6. Re-audit phase 4 separately after product/security approval rather than treating inactive scaffolds as completion.

## Appendix

### Verification results

| Check | Result | Notes |
|---|---|---|
| `npm run gate:mailfn-release` under Node 22 | PASS | 52 tests: core 26, client 4, Cloudflare 13, testing 2, CLI 2, MCP 2, SendFn 2, facade 1; build, pack, clean install, and public imports passed |
| D1 migration executed in SQLite memory database | PASS | `mailfn/cloudflare/migrations/0001_mailfn.sql` parsed/executed successfully |
| MailFn package dependency tree | PASS | No missing/invalid MailFn package dependency reported |
| `git diff --check` | PASS | No whitespace errors in tracked diff |
| Documentation catalog validation | FAIL, baseline-only | Duplicate existing slugs and an existing `python-core` package-name mismatch; MailFn missing/extra/order sections were empty |
| Standard newline-delimited MCP `tools/list` process probe | FAIL | Process emitted 0 bytes |
| Project quota probe (`maxMessagesPerHour: 1`, two inboxes) | FAIL | Second inbox message was accepted (`SECOND_ACCEPTED`) |
| Live Cloudflare deployment/DNS/real-mail smoke | NOT RUN | Explicit external side effect and authorization boundary |
| Registry publication | NOT RUN | Explicit external side effect boundary |

### Baseline-noise separation

The catalog validator failure is not attributed to MailFn: it reported duplicate pre-existing catalog slugs and a pre-existing package-name mismatch, while its MailFn-specific missing, extra, and ordering reports were empty. All other findings above are within MailFn's touched/untracked surface or its explicitly required SendFn integration boundary.

### Repository state after verification, before audit artifacts

Tracked modifications remained limited to `AGENTS.md`, root `README.md`, `docs/lib/ecosystem-catalog.ts`, `package-lock.json`, `package.json`, and `release-packages.json`. Untracked implementation paths remained `.github/workflows/mailfn-release.yml`, `mailfn/`, and `scripts/gate-mailfn-release.mjs`. Verification did not introduce additional implementation changes.

### Final determination

The correct completion status is:

> **SFN-17 has a substantial local implementation and a strong package gate, but it is not fully implemented across all phases. Phases 2 and 3 fail central requirements; phases 0, 1, and 4 remain partial; real Cloudflare and consumer rollout validation is absent.**
