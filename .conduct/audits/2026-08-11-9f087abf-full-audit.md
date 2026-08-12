# MailFn SFN-17 Full Re-audit

## Metadata

- Timestamp: `2026-08-10T19:49:56Z`
- Agent name: `unknown-agent`
- Model: `GPT-5 Codex`
- Launcher: `Codex Desktop`
- Workspace/project path: `repo root`
- Environment: `Darwin arm64`, shell `zsh`
- Git branch: `codex/sfn-17-mailfn`
- Git commit: `9cf381238d1d8a11c899d6808ffb0bb73dfe839a`
- Git state: dirty; 19 changed top-level status entries (15 modified, 4 untracked). The audited MailFn implementation is not represented by the recorded commit.
- Audit verdict: **FAIL — materially improved, but not fully implemented or product-comparable**

## Audit scope

This was a full, read-only re-audit of SFN-17 across all intended phases. It covered:

- the live Linear issue and its linked Ideation and Architecture documents;
- the local issue transcription, technical specification, threat model, operations guide, package documentation, and consumer contracts;
- all MailFn packages under `mailfn/`;
- the Cloudflare D1/R2/Queue/Email Worker adapter and migration;
- the checked-in SendFn changes and the `@mailfn/sendfn` integration;
- root package/release registration, the MailFn release workflow, and the release-gate script;
- official current capability descriptions for MailSlurp, Mailtrap Inbound Email, and AgentMail;
- the MCP stdio transport and JSON-RPC notification rules.

Generated `dist/`, dependency directories, unrelated functions, and unrelated pre-existing worktree changes were excluded from static source review. Generated package outputs were exercised by the release gate.

The audit did not deploy Cloudflare resources, mutate DNS, publish packages, enable billing/support/outbound service, or approve a public launch. Those actions are outside the authorized side-effect boundary.

## Inputs audited (intent + spec bundles)

### Authoritative intent

1. Live Linear issue `SFN-17 — Build MailFn as a reusable programmable mailbox function` (status remained Backlog at audit time).
2. Live linked Linear document `MailFn — Ideation and Product Definition`.
3. Live linked Linear document `MailFn — Architecture and Phased Plan`.
4. The user instruction to fully implement all phases and compare the result with MailSlurp, Mailtrap Inbound Email, and AgentMail.
5. Repository implementation constraints in `AGENTS.md`, including shared Superfunctions abstractions and function-specific artifact conventions.

### Local specification bundle

- `mailfn/.conduct/issues/SFN-17.md`
- `mailfn/SPEC.md`
- `mailfn/README.md`
- `mailfn/THREAT_MODEL.md`
- `mailfn/OPERATIONS.md`
- package READMEs under `mailfn/*/README.md`
- `mailfn/consumers/README.md`
- `mailfn/cloudflare/wrangler.example.jsonc`
- `mailfn/cloudflare/migrations/0001_mailfn.sql`

No formal `REQUIREMENTS.md`, `TEST_VECTORS.md`, `PLAN.md`, or `INTENT_AUDIT.md` bundle exists. For traceability, this report assigns requirement IDs to the six local issue acceptance requirements and to every normative bullet/table row in `mailfn/SPEC.md`.

### Historical context not used as compliance authority

- Earlier audit and completion artifacts were consulted only after the independent audit to understand claimed remediation. Their conclusions were not treated as evidence of correctness.

### Comparable-product and protocol sources

- [MailSlurp inboxes](https://www.mailslurp.com/docs/inboxes/), [wait/match methods](https://www.mailslurp.com/docs/wait-for/), and [API surface](https://www.mailslurp.com/docs/api/)
- [Mailtrap Inbound Email](https://mailtrap.io/inbound-email/)
- [AgentMail inbox capabilities](https://docs.agentmail.to/knowledge-base/inbox-capabilities), [MCP](https://docs.agentmail.to/integrations/mcp), and [webhook events](https://docs.agentmail.to/events)
- [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [JSON-RPC 2.0 notification semantics](https://www.jsonrpc.org/specification)
- [Cloudflare Email Routing rules API](https://developers.cloudflare.com/api/resources/email_routing/subresources/rules/) and [Email Routing DNS API](https://developers.cloudflare.com/api/resources/email_routing/subresources/dns/)

## High-level findings

The remediation is substantial. The current tree now has public attachment discovery, atomic D1 quota and bootstrap paths, workerd tests with real local D1/R2 bindings, newline-delimited MCP stdio, durable webhook replay protection, expanded mailbox depth, phase-4 control models, an actual checked-in SendFn integration, packed-consumer typechecks, and numeric rollout thresholds. The local release gate passed all eight MailFn packages and 81 MailFn tests; the full SendFn suite separately passed 44 tests; the SQLite migration executed successfully.

That evidence is not enough for a completion verdict. Three specification requirements fail, five remain partial, two original-intent validation gates remain unverified, and the provider-neutral core claim is contradicted by Cloudflare MX records embedded in the core service.

### Ranked findings

#### HIGH-1 — The provider-neutral core embeds Cloudflare routing policy

`mailfn/core/src/service.ts:1246-1267` constructs custom-domain DNS requirements with `route1.mx.cloudflare.net`, `route2.mx.cloudflare.net`, and `route3.mx.cloudflare.net`. A non-Cloudflare `MailFnDomainAdapter` cannot supply its own MX requirements without changing core code. This fails the authoritative provider-neutral objective even though the core does not literally import a Cloudflare SDK. The specification narrows the boundary to “must not import Cloudflare APIs,” leaving a spec gap relative to the stronger intent.

Impact: custom-domain support is adapter-shaped but not provider-neutral, so the central reusable-function claim is only partial.

#### HIGH-2 — Cloudflare inbound dedupe uses sender-controlled `Message-ID`, not a provider delivery identity

`mailfn/cloudflare/src/worker.ts:106-118` maps the RFC `Message-ID` header to `providerDeliveryId`; when that header is absent it generates a fresh random value. Core then deduplicates on `(inbox_id, provider_delivery_id)` in `mailfn/core/src/service.ts:463-476`.

Consequences:

- a retried delivery without `Message-ID` receives a new random ID and is stored twice;
- two distinct messages that reuse the same sender-controlled `Message-ID` for one inbox collapse into one message;
- the D1 uniqueness and concurrency tests verify storage behavior only after a trustworthy delivery ID has already been supplied, so they do not cover the runtime identity defect.

This directly fails SPEC-P1.4 and SPEC-F4 and can cause either duplicate processing or silent message loss.

#### HIGH-3 — CLI `--json` bypasses all default redaction

`mailfn/cli/src/index.ts:21-23` sends raw response data to `context.output.json` whenever `--json` is present; redaction is performed only by the text renderer. A targeted probe of `inbox create --json` printed the one-time plaintext scoped credential. The same path can emit message bodies, subjects, addresses, headers, attachment names, and verification-bearing content without `--show-content`.

This contradicts the CLI README, threat model, and SPEC-P2.1. Machine-readable output is especially likely to enter CI logs or agent transcripts, making this a security boundary failure rather than a cosmetic inconsistency.

#### HIGH-4 — The required real runtime and consumer acceptance evidence does not exist

`mailfn/OPERATIONS.md:51` correctly requires a non-production Cloudflare deploy, real Email Routing delivery, custom-domain enable/disable, retry/DLQ, retention, log-redaction, restore, Router, and unrelated-consumer validation. None was run. `mailfn/consumers/README.md` explicitly identifies both consumers as compile-only fixtures; they are not actual Router or unrelated application integrations. The live Linear issue remains Backlog and has no production-security or phase-4 approval.

This is reported as **UNVERIFIED**, not as authorization to perform external changes. It nevertheless blocks the user’s requested “all phases” completion claim and any product-comparability claim.

#### MEDIUM-1 — The MCP server replies to notifications, violating JSON-RPC

`mailfn/mcp/src/server.ts:57-73` special-cases only `notifications/initialized`. Any other notification reaches method-not-found handling, and `serveMailFnMcpStdio` writes the result. A process-level probe sent `notifications/cancelled` without an `id` and received an error response with `id: null`.

JSON-RPC requires servers not to reply to notifications. The release gate checks only initialize and tools/list, so this interoperability defect is missed. The server also does not validate the request object/version before dispatch. The MCP tool surface is usable in the happy path, but not fully protocol-conformant.

#### MEDIUM-2 — SendFn’s stale-pending idempotency reclaim cannot reclaim

`sendfn/typescript/src/email/service.ts:45-77` derives a stable transaction ID. When an existing pending transaction is older than five minutes, it attempts to insert the same primary key; the expected uniqueness failure is caught and the old pending record is returned. The provider call is therefore never retried and the transaction can remain pending forever after a crash between reservation and completion.

This makes SPEC-P3.4 partial: correlation and normal-path propagation pass, but crash recovery for the stable per-draft idempotency contract does not.

#### MEDIUM-3 — Email Worker buffers raw mail before cheap recipient and size checks

`mailfn/cloudflare/src/worker.ts:106-118` consumes the complete raw stream before `receiveInbound` checks whether the recipient exists, is active, is blocked, or exceeds configured size/quota. This contradicts the documented topology (“validates the recipient and limits, writes raw MIME”) and the threat-model requirement to apply controls before expensive processing.

The provider-supplied `rawSize` and envelope recipient are available before reading the stream. Repeated unknown-recipient or policy-rejected mail therefore still consumes per-request memory and stream work.

#### MEDIUM-4 — Accepted ingress quota reservations are never aged out

`mailfn/cloudflare/src/d1-store.ts:348-376` retains one `mailfn_ingress_reservations` row for each accepted message. Only failed ingress paths call `releaseIngressQuota`; there is no scheduled deletion of old hourly buckets. Current-hour counts remain correct, but the table grows for the lifetime of the deployment and every quota query continues to operate over an ever-growing durable table/index set.

This makes public-readiness operations partial even though atomic hourly enforcement itself passed in workerd.

#### MEDIUM-5 — The release workflow does not protect the SendFn contract it modifies

`scripts/gate-mailfn-release.mjs:23-28` builds but does not test `sendfn/typescript`. The workflow path filter in `.github/workflows/mailfn-release.yml:3-12` also omits `sendfn/typescript/**`. A SendFn-only change can therefore alter the MailFn contract without triggering the MailFn gate, and the gate itself would miss failures outside the narrow MailFn adapter test. The separately executed 44-test SendFn suite passed in this audit, but it is not enforced by the checked-in gate.

#### MEDIUM-6 — The Cloudflare HTTP surface bypasses the repository’s shared HTTP abstraction

`mailfn/cloudflare/package.json` has no `@superfunctions/http` dependency, while `mailfn/cloudflare/src/http.ts` hand-builds routing, request parsing, authentication, envelopes, errors, binary responses, and CORS. The gate builds `packages/http` but MailFn does not use it. This conflicts with the repository instruction to reuse shared HTTP abstractions and makes future Express/Fastify/Hono/Next/SvelteKit adapters duplicate the v1 surface.

### Comparable-product verdict

**MailFn is not currently comparable to MailSlurp, Mailtrap Inbound Email, or AgentMail as a product.** It is increasingly comparable to the narrow reusable-library primitives that SFN-17 selected from those products, subject to the high findings and live validation.

| Capability | MailFn current tree | MailSlurp | Mailtrap Inbound | AgentMail | Verdict |
| --- | --- | --- | --- | --- | --- |
| API-created permanent/disposable inboxes | Implemented locally | Hosted permanent/disposable inboxes | Hosted inboxes | Hosted agent inboxes | Library parity; no service parity |
| Real inbound receipt + parsed JSON | Workerd-local path; real Email Routing unverified | Hosted and production-exercised | Hosted and production-exercised | Hosted and production-exercised | Unverified operationally |
| Raw MIME and attachments | Raw R2 evidence, hashes, metadata and binary download | Attachment APIs and inspection | Parsed payload plus signed attachment URLs | Attachment upload/download | Strong primitive parity; no signed URL/CDN surface |
| Wait/match and OTP/link extraction | Bounded wait, cancel, filters, source-attributed OTP/link | Rich wait/match API plus test tooling | Poll/webhook workflow | Poll/webhook/WebSocket workflows | Strong narrow parity with MailSlurp |
| Threads, labels, drafts, reply/reply-all/forward | Implemented locally | Broader inbox/email automation | Threads and replies built in | First-class threads, labels, drafts and forwarding | Feature-level parity, SendFn recovery partial |
| Webhooks | HMAC, timestamp, retry, quarantine, replay helper | Queued event webhooks and redrive | HMAC and retry over 24 hours | Svix-signed event family | Strong design; production delivery unverified |
| Custom domains | Cloudflare-only core DNS policy; live DNS unverified | Hosted custom domains | Hosted and custom domains | Custom domains with deliverability records | Partial |
| Agent/MCP access | Six narrow stdio tools; notification noncompliance | General APIs/SDKs and automation | APIs/webhooks | Hosted MCP with OAuth/API-key auth and broad mailbox tools | Not comparable yet |
| Search and extraction | Bounded FTS5 content search; OTP/link extraction | Broad search, AI transforms/OCR, automation | Routing/filtering and AI inbox features | Full-text search and reply extraction | Narrow subset |
| Multi-tenancy and organization | Project/inbox boundaries, quotas and region controls | Accounts, roles, environments, SSO | Folders/team organization | Organizations and Pods | Core isolation only; no hosted control plane |
| Protocols and SDK breadth | TypeScript client; no IMAP/SMTP/WebSocket/Python | Multiple SDKs, IMAP/SMTP, connectors | REST/webhooks | TypeScript/Python, SMTP, WebSockets, hosted MCP | Material gap |
| Routing, folders, analytics, dashboards | No routing-rule DSL, folders, analytics UI, or dashboard | Routing/automation/governance dashboards | Routing rules, folders, analytics, sandbox | Console, org-wide views, allow/block lists | Material gap |
| Spam, virus, deliverability and delivery events | Header evidence, manual reputation controls; outbound provider delegated | Spam/virus, deliverability, device previews, monitoring | Spam score and hosted analytics | Spam/virus, delivery/bounce/complaint events, domain warming | Material gap |
| Hosted reliability and support | Code controls and documented thresholds; no observation window | Operated service | Operated service | Operated service | Not comparable |

The fairest positioning after remediation is: **a promising self-hosted programmable mailbox function and test/agent SDK, not a substitute for the comparable hosted platforms.**

## Intent Inventory (numbered)

1. Deliver MailFn as a reusable, independent Superfunction rather than app-specific mail code.
2. Keep the mailbox domain and persistence contracts provider-neutral.
3. Provide the initial Cloudflare Email Worker/Worker/D1/R2/Queue deployment adapter.
4. Support stable and expiring inboxes as first-class lifecycles.
5. Receive real internet email and preserve the original MIME as evidence.
6. Durably order R2 raw storage, D1 metadata, and Queue parsing with compensating failure behavior.
7. Parse and normalize MIME, headers, addresses, bodies, authentication evidence, and attachments.
8. Sanitize HTML, block executable/tracking content, normalize attachment metadata, and hash bytes.
9. List/read/filter/paginate messages and download raw MIME and attachments.
10. Wait with sender/subject/time/count filters, bounded timeout, cancellation, and normal timeout results.
11. Extract OTPs and verification links centrally with source attribution.
12. Provide project- and inbox-scoped, one-time, hashed, revocable, expiring credentials.
13. Enforce project/inbox ownership and prevent delegated-scope escalation or cross-inbox access.
14. Make inbox creation and inbound delivery idempotent under concurrency and at-least-once retries.
15. Provide a typed TypeScript client with typed errors, cancellation, bounded retries, and binary downloads.
16. Provide deterministic test fixtures/helpers with idempotent expiring inboxes and lifecycle cleanup.
17. Provide a least-privilege CLI with metadata/redaction defaults and explicit content actions.
18. Provide a narrow MCP server for create/wait/list/read/extract/revoke workflows with safe defaults.
19. Provide versioned, signed webhooks with bounded retry, quarantine, replay protection, and mail-acceptance isolation.
20. Defend webhook delivery against private destinations, redirects, replays, secret disclosure, and acknowledged DNS-rebinding residual risk.
21. Provide custom-domain verification, enablement, idempotent routing creation, persistence compensation, and reversible disablement.
22. Implement independent inbox/message/raw/attachment/audit retention and retry-safe object deletion.
23. Implement audit, usage, reconciliation, operational snapshots, alert thresholds, recovery, and rollback guidance.
24. Resolve threads using standard headers before normalized-subject fallback.
25. Support scoped labels and bounded message content search with durable Cloudflare indexing.
26. Support draft create/list/get/update/delete, reply, reply-all, forward, attachment references, and thread headers.
27. Compose outbound delivery through SendFn without duplicating delivery providers.
28. Preserve stable per-draft idempotency and release outbound reservations on pre-acceptance failure.
29. Enforce active-inbox, project/inbox/sender ingress, message/attachment/storage, webhook/domain, and outbound limits durably.
30. Provide abuse cases, sender reputation, resource disablement, and generic SMTP rejection reasons.
31. Provide gated support, billing-usage, compliance export, retention lock, deletion SLA, and data-region controls.
32. Keep public-platform mode, production-security approval, billing, support, verified-domain outbound, and future protocol services explicitly gated and disabled by default.
33. Define Semver, API v1, event v1, queue-job v1, migration/version compatibility, and failure invariants.
34. Register and package every public package; build, test, pack, clean-install, import, and typecheck consumers.
35. Validate the real Cloudflare path with real multipart mail, DNS/routing, DLQ/retry, retention, restore, and log-redaction evidence.
36. Validate one actual Router flow and one unrelated actual consumer.
37. Observe quantitative rollout thresholds for seven days before expansion.
38. Avoid deployment, DNS mutation, publication, billing/support activation, public outbound, or approval without separate authorization.
39. Use MailSlurp, Mailtrap, and AgentMail as capability inputs without silently claiming full commercial-product parity.

## Intent → Spec coverage matrix (complete; no sampling)

| Intent | Spec mapping | Spec coverage | Implementation | Evidence / gap |
| --- | --- | --- | --- | --- |
| 1 | SFN-17 objective; SPEC status | PASS | PARTIAL | Package family exists; current tree is dirty/uncommitted and HTTP reuse is incomplete |
| 2 | SPEC boundary | SPEC MISSING | FAIL | Spec bans imports, but does not ban Cloudflare policy data in core; hardcoded MX values remain |
| 3 | SPEC status; P1/P2 | PASS | PASS | Cloudflare Worker/D1/R2/Queue/domain/webhook packages and workerd path |
| 4 | P0.1; P1.1 | PASS | PASS | Stable/expiring lifecycles and defaults tested |
| 5 | P1.3/P1.5 | PASS | PARTIAL | Raw evidence path works locally; real Email Routing not exercised |
| 6 | P1.3; F1-F3 | PASS | PASS | Compensation and queue-failure tests plus workerd evidence |
| 7 | P1.5 | PASS | PASS | Postal MIME adapter, normalized model, authentication evidence |
| 8 | P1.5; acceptance | PASS | PASS | Sanitization, remote-image blocking, attachment hashes tested |
| 9 | P1.6; HTTP surface | PASS | PASS | Client/HTTP raw and attachment discovery/download present |
| 10 | P0.4; P1.6 | PASS | PASS | Timeout/cancel/filter/count behavior covered |
| 11 | P0.3; P1.6 | PASS | PASS | Central source-attributed extraction used by client/testing/CLI/MCP |
| 12 | P1.2 | PASS | PASS | One-time token, hash, expiry, revocation, encrypted replay |
| 13 | P3.5; threat model | PASS | PASS | Cross-inbox and delegation containment tests |
| 14 | P1.2/P1.4; F4 | PASS | FAIL | Inbox idempotency passes; runtime inbound delivery identity is unsound |
| 15 | P1.7 | PASS | PASS | Typed client tests and clean tarball import pass |
| 16 | P2.4 | PASS | PASS | Fixture cleanup and focused assertions pass |
| 17 | P2.1 | PASS | FAIL | Text mode redacts; `--json` leaks raw results |
| 18 | P2.1 | PASS | PARTIAL | Happy-path MCP works; notification semantics fail |
| 19 | P2.2; F6 | PASS | PASS | Signing/retry/quarantine/delivery state and D1 replay store present |
| 20 | P2.2; threat model | PASS | PASS | HTTPS/public-address/redirect checks and documented egress residual |
| 21 | P0.5; P2.3 | PASS | PARTIAL | Reversible Cloudflare adapter passes mocks; core is vendor-specific and live DNS unverified |
| 22 | P0.2; P2.5; F7 | PASS | PASS | Independent clocks, retry-safe deletes, audit expiry |
| 23 | P2.5; P4.1 | PASS | PARTIAL | Local controls exist; accepted ingress reservations have no aging and no live observations exist |
| 24 | P3.1 | PASS | PASS | Header-first threading tested |
| 25 | P3.2 | PASS | PASS | Scoped labels, cursor-bound search, transactional FTS5 |
| 26 | P3.3 | PASS | PASS | Full draft lifecycle and reply/forward paths present |
| 27 | P3.4 | PASS | PASS | Actual checked-in SendFn reaches provider contract in tests |
| 28 | P3.4; recovery | PASS | PARTIAL | Stable ID works normally; stale pending cannot recover |
| 29 | P1.2; P4.1 | PASS | PARTIAL | Atomic enforcement passes; ingress reservation storage is unbounded |
| 30 | P4.1 | PASS | PASS | Abuse/reputation and policy rejection paths present |
| 31 | P4.1/P4.2 | PASS | PARTIAL | Control models exist; real billing/support/compliance operations are intentionally inactive |
| 32 | P4.2/P4.3 | PASS | PARTIAL | Existing flags default off; no distinct future protocol-service control is modeled |
| 33 | P0.6; acceptance | PASS | PASS | Versions, migrations, envelope/job constants, and docs align |
| 34 | issue AR6; acceptance | PASS | PARTIAL | Local gate passes; SendFn test enforcement and workflow path coverage are incomplete |
| 35 | Operations verification | PASS | UNVERIFIED | Requires separately authorized non-production infrastructure |
| 36 | Linear architecture; Operations | PASS | FAIL | Only compile-only modeled consumers exist |
| 37 | Operations thresholds | PASS | UNVERIFIED | Thresholds are explicit; observation window has not occurred |
| 38 | issue external boundary; P4.3 | PASS | PASS | No prohibited external side effect was performed |
| 39 | issue comparables | PASS | PASS | Selected primitives are documented; this re-audit rejects full-product parity |

Intent implementation totals: **23 PASS, 10 PARTIAL, 4 FAIL, 2 UNVERIFIED**.

## Requirement coverage summary (PASS/PARTIAL/FAIL/UNVERIFIED counts per spec bundle)

| Spec bundle | PASS | PARTIAL | FAIL | UNVERIFIED | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| `mailfn/.conduct/issues/SFN-17.md` acceptance requirements | 2 | 4 | 0 | 0 | 6 |
| `mailfn/SPEC.md` assigned normative requirements | 28 | 5 | 3 | 0 | 36 |

External runtime and rollout gates are represented in the Intent matrix because the local issue’s external-side-effect boundary deliberately excludes them from its six implementation acceptance rows.

## Requirement-by-requirement results (tables + per-requirement notes)

### SFN-17 local issue acceptance requirements

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| SFN-17-AR1 | Define compatibility, tenancy, retention, threat model, failure matrix, and launch gates | PASS | SPEC, threat model, operations, versions, and failure table exist |
| SFN-17-AR2 | Stable/expiring inboxes, real inbound, durability, parsing, waits, extraction, auth, idempotency, tests | PARTIAL | Most behavior passes; Cloudflare delivery identity breaks at-least-once dedupe and live inbound is unverified |
| SFN-17-AR3 | CLI, MCP, webhooks, domains, fixtures, retention, audit, reconciliation, operations, deployment config | PARTIAL | CLI JSON redaction and MCP notification handling fail; domains are vendor-leaked and live validation is absent |
| SFN-17-AR4 | Threads, labels, search, drafts, reply/forward, SendFn, delegation | PARTIAL | Mailbox depth passes; SendFn stale-pending recovery remains broken |
| SFN-17-AR5 | Quotas, abuse/support/compliance/usage/region controls and explicit public gates | PARTIAL | Controls exist and default off; ingress ledger cleanup and external approval/operations remain incomplete |
| SFN-17-AR6 | Register packages and enforce build/test/pack/install/import without external side effects | PASS | Gate passes all MailFn packages; no prohibited action occurred. SendFn workflow enforcement is a separate medium risk |

### `mailfn/SPEC.md` normative requirements

| ID | Requirement | Status | Notes |
| --- | --- | --- | --- |
| SPEC-P0.1 | Stable and expiring modes | PASS | Implemented and tested |
| SPEC-P0.2 | Stable/expiring default retention | PASS | Constants match spec |
| SPEC-P0.3 | Central extraction | PASS | Shared implementation across surfaces |
| SPEC-P0.4 | Long polling plus webhooks | PASS | Bounded wait/cancel and push events |
| SPEC-P0.5 | Reversible custom-domain operations | PASS | Adapter supports create/verify/disable; provider neutrality assessed separately |
| SPEC-P0.6 | Semver and versioned breaking changes | PASS | Package/API/event/job versions defined |
| SPEC-P1.1 | Project bootstrap and inbox CRUD | PASS | Memory and D1 paths present |
| SPEC-P1.2 | Credentials, audit, atomic limits/reservations, idempotency | PASS | Workerd concurrency validates critical D1 paths |
| SPEC-P1.3 | Raw before metadata; enqueue after durability | PASS | Compensation tests and workerd path pass |
| SPEC-P1.4 | Dedupe by provider delivery ID | FAIL | Cloudflare adapter does not possess a stable provider delivery ID |
| SPEC-P1.5 | MIME safety, attachments, raw evidence | PASS | Tests cover sanitization, limits, hash, cleanup |
| SPEC-P1.6 | Read/list/filter/page/download/wait/extract | PASS | Core, HTTP, client and helpers present |
| SPEC-P1.7 | Typed client and deterministic adapters/tests | PASS | Client tests and package gate pass |
| SPEC-P2.1 | CLI/MCP metadata-redaction defaults | FAIL | CLI JSON leaks; MCP notification protocol is partial |
| SPEC-P2.2 | Secure durable webhooks | PASS | HMAC, timestamp, retry, quarantine, replay helper/store |
| SPEC-P2.3 | Cloudflare custom-domain verification/routing/disable | PASS | Mock API evidence and compensation pass; live call unverified |
| SPEC-P2.4 | Idempotent expiring test fixtures and cleanup | PASS | Tests pass |
| SPEC-P2.5 | Retention, audit, usage, reconciliation, snapshots/alerts | PASS | Functional paths present; public-readiness cleanup is assessed under P4 |
| SPEC-P3.1 | Header-first threading | PASS | Tested |
| SPEC-P3.2 | Scoped labels and bounded FTS5 search | PASS | Cursor binding and transactional D1 index present |
| SPEC-P3.3 | Draft/reply/reply-all/forward fidelity | PASS | Lifecycle, recipients, references and attachment IDs present |
| SPEC-P3.4 | SendFn composition and stable draft idempotency | PARTIAL | Happy path passes; stale pending cannot recover |
| SPEC-P3.5 | Delegation containment | PASS | Tests cover subset scopes and inbox boundary |
| SPEC-P4.1 | Quotas, usage, abuse/support/compliance/region/alerts | PARTIAL | Models and enforcement exist; ingress ledger is unbounded and hosted operations are inactive |
| SPEC-P4.2 | Disabled-by-default explicit public controls | PARTIAL | Security/billing/support/domain/region flags exist; future protocol-service control is not explicit |
| SPEC-P4.3 | Repository implementation is not launch approval | PASS | Documentation and defaults state this correctly |
| SPEC-HTTP | Canonical JSON/binary HTTP surface | PASS | Routes, envelopes, no-store and typed client align |
| SPEC-F1 | R2 raw write failure compensation | PASS | No row/queue; transient error |
| SPEC-F2 | D1 metadata failure compensation | PASS | Best-effort raw cleanup; no queue |
| SPEC-F3 | Queue failure retains retryable state | PASS | `queue_failed` and reconciliation |
| SPEC-F4 | Duplicate delivery returns canonical message | FAIL | Storage logic passes only with a trustworthy ID; runtime does not provide one |
| SPEC-F5 | Parse/attachment failure preserves raw and cleans partial objects | PASS | Covered by tests |
| SPEC-F6 | Webhook failure is isolated and quarantined | PASS | Covered by tests and durable state |
| SPEC-F7 | Object deletion failure remains retryable | PASS | Metadata advancement is conditional |
| SPEC-F8 | Unknown/inactive/oversize/policy recipients get safe permanent rejection | PARTIAL | Result is safe, but Worker buffers raw input before these checks |
| SPEC-ACCEPT | Build/test/pack/install/import/migration/failure test gate | PARTIAL | Local gate and migration pass; real delivery identity, actual consumers, and full SendFn enforcement remain outside the gate |

## Spec conflicts / spec gaps (explicit)

1. **Provider-neutrality gap:** the authoritative intent requires a provider-neutral core; the local spec only says the core must not import Cloudflare APIs. This narrower rule allows Cloudflare MX policy to leak into core and should be strengthened.
2. **Planning status versus implementation request:** the live Linear issue remains Backlog and its original workflow language is planning-oriented, while the user explicitly requested full implementation. The user instruction governs this audit, but no Linear approval or phase-4 approval may be inferred.
3. **External validation boundary:** the local issue excludes deployment, DNS, publication, billing/support activation, and public approval, while the architecture/operations acceptance requires real Cloudflare and real consumer evidence. This is not permission to perform those changes; it means final completion must remain UNVERIFIED until separately authorized evidence exists.
4. **Consumer-definition drift:** the architecture requires Router and an unrelated consumer; the implementation substitutes two compile-only modeled fixtures. The local consumer README is honest about the substitution, but it does not satisfy the original acceptance semantics.
5. **CLI documentation conflict:** CLI and threat-model documentation promise redaction by default and explicit reveal, while `--json` reveals unredacted data without the explicit content flag.
6. **MCP completeness gap:** the local spec calls the package an MCP server but does not enumerate JSON-RPC conformance vectors, permitting a happy-path-only implementation that replies to notifications.
7. **Comparable-product ambiguity:** the issue lists products as capability inputs, not a requirement to replicate their entire hosted platform. This report therefore evaluates both selected primitive parity and full product parity separately.
8. **Missing formal requirements bundle:** no `REQUIREMENTS.md` or `TEST_VECTORS.md` exists, so normative IDs and negative protocol/runtime vectors are not independently tracked.

## Cross-cutting audits (security/determinism/limits/errors/compat)

### Security, authorization, and validation boundaries

Positive evidence includes hashed one-time credentials, constant-time comparisons, scoped authorization, inbox containment, delegation subset checks, encrypted idempotency/webhook secrets, generic SMTP rejection reasons, HTML sanitization, remote-image blocking, attachment hashing, HMAC webhooks, durable replay consumption, redirect denial, public-IP resolution evidence, no-store responses, compliance locks, and disabled public outbound.

Blocking or partial evidence:

- CLI JSON output bypasses the content/secret disclosure boundary.
- The Email Worker buffers raw content before recipient/size/policy checks.
- Webhook DNS validation still relies on a separate hostname fetch after resolution; the threat model correctly requires an external egress policy for DNS-rebinding closure.
- No external tenant-isolation, log-redaction, domain-ownership, deletion-evidence, or production-security review was performed.

### Determinism and idempotency invariants

Inbox idempotency, request-hash conflict detection, atomic D1 inbox/credential creation, cursor binding, thread resolution, source-attributed extraction, queue reconciliation, outbound reservation IDs, and workerd quota concurrency are deterministic in tested paths.

The Cloudflare delivery identity violates deterministic at-least-once behavior, and SendFn’s stale-pending branch cannot reconcile a crashed idempotent transaction. These are the two main reliability blockers.

### Limits and caps

The implementation defines and enforces active inbox, hourly project/inbox/sender, message, attachment, stored-byte, webhook, domain, daily outbound, pagination, retry, timeout, and webhook-delivery caps. Critical D1 limits use single-statement or batch atomicity and passed concurrent workerd tests.

Remaining limit risks are pre-validation raw buffering and the absence of old ingress-reservation cleanup. Hosted-scale rate limiting, R2/D1 capacity behavior, DLQ rates, and operational labor thresholds are unverified.

### Errors and canonical envelopes

HTTP JSON responses use the canonical `{ ok, data, error, meta }` form; binary results use private no-store, nosniff, request IDs, and sanitized attachment filenames. Typed client errors and retry rules are bounded. SMTP failures avoid exposing recipient addresses.

MCP invalid notifications produce forbidden responses, request shape/version validation is incomplete, and the release probe covers only the happy path. SendFn can return a permanently pending transaction without a recovery-specific error.

### Compatibility, versioning, migrations, and ecosystem reuse

API v1, event v1, queue job v1, package version 0.1.0, D1 schema tracking, SQL migration execution, public exports, pack/install/import, and consumer typechecks pass. The workerd test now exercises actual local D1/R2 bindings and handler invocation.

Compatibility remains partial because:

- the domain core contains Cloudflare values;
- the Cloudflare HTTP surface does not reuse `@superfunctions/http`;
- the workflow omits SendFn source paths and full SendFn tests;
- the consumer fixtures are modeled, not real integrations;
- no deployed compatibility or migration/restore rehearsal exists.

## Recommendations (ranked)

1. **Fix inbound identity before any rollout** (Intent 14; SPEC-P1.4/F4). Introduce an adapter-supplied stable delivery key when available; otherwise derive a documented, deterministic retry fingerprint from trusted envelope/raw evidence while preserving distinct-message semantics. Add Email Worker tests for repeated no-`Message-ID` delivery and distinct mail sharing a `Message-ID`.
2. **Restore provider-neutral custom-domain contracts** (Intents 2/21). Move provider-required DNS records behind `MailFnDomainAdapter` or explicit runtime configuration; core should own verification state, not Cloudflare MX values.
3. **Apply redaction before output-mode selection** (Intent 17; SPEC-P2.1). Feed both text and JSON through the same command-aware sanitizer and add JSON tests for inbox credentials, message fields, attachments, and extraction exceptions.
4. **Use an MCP SDK or fully implement JSON-RPC lifecycle vectors** (Intent 18; SPEC-P2.1). Never answer notifications; validate JSON-RPC version/request shapes; test cancellation, unknown notifications, invalid requests, parse errors, and initialize sequencing.
5. **Make stale SendFn transactions explicitly claimable/reconcilable** (Intent 28; SPEC-P3.4). Use a conditional update/lease rather than a duplicate insert, and add crash-window tests that prove no duplicate provider send and no permanent pending state.
6. **Perform cheap ingress checks before consuming raw** (Intents 5/29; SPEC-F8). Validate envelope recipient, active status, provider `rawSize`, sender policy, and reservable quotas before buffering the body; preserve compensation for stream/read failure.
7. **Age ingress quota buckets** (Intent 29; SPEC-P4.1). Delete expired buckets on reservation or scheduled maintenance, index the cleanup path, and add a workerd test proving counts and table size remain bounded.
8. **Strengthen the release workflow** (Intent 34). Trigger on `sendfn/typescript/**`, run the full SendFn test suite when the integration contract changes, and keep the narrow packed adapter test.
9. **Define the HTTP contract with shared Superfunctions primitives** (Intent 1; repository constraint). Move route/envelope/auth contracts to the reusable HTTP abstraction and keep Cloudflare as an adapter, without re-exporting framework adapters.
10. **Seek separate authorization for real acceptance evidence** (Intents 35-37). Deploy non-production Cloudflare resources, run the documented real-mail/domain/retry/retention/restore matrix, integrate actual Router and one unrelated application, then observe the seven-day thresholds. Do not mark public phase 4 approved until the named external reviews and operations exist.
11. **Position the product accurately** (Intent 39). Describe MailFn as a self-hosted programmable mailbox function. Avoid claims of MailSlurp/Mailtrap/AgentMail parity until hosted provisioning, operational proof, broader protocols/SDKs, control-plane organization, spam/deliverability, and product UX exist.

## Appendix: commands run + environment details

Environment was `Darwin arm64` with `zsh`. Commands are shown relative to repo root and sanitized for portability.

### Verification commands

```sh
PATH=<node-22-bin>:$PATH npm run gate:mailfn-release
(cd sendfn/typescript && PATH=<node-22-bin>:$PATH npm test)
sqlite3 :memory: < mailfn/cloudflare/migrations/0001_mailfn.sql
```

Results:

- MailFn release gate: PASS.
- MailFn tests within gate: 81 passed.
- Workerd integration: 6 passed, using real local D1/R2 bindings and Email/Queue handler invocation.
- Full SendFn suite: 44 passed across 11 files.
- Pack/install/import: PASS for all eight public MailFn packages.
- Packed consumer typecheck: PASS for both compile-only fixtures.
- SQLite migration: PASS.

### Targeted negative probes

1. Invoked `inbox create --json` against a deterministic mocked HTTP envelope. Result: exit 0 and plaintext one-time token printed — **reproduced**.
2. Created a project and expiring inbox with memory adapters, authenticated the generated scoped token, and attempted inbox deletion. Result: `MAILFN_FORBIDDEN`; this is a least-privilege design observation, not counted as a finding because the configured project-scoped MCP client can perform revoke.
3. Sent MCP initialize followed by `notifications/cancelled` without an ID to the built stdio executable. Result: method-not-found response with `id: null` — **reproduced**.

### Read-only inspection commands

`git status`, `git diff`, `rg`, `find`, `sed`, `nl`, package-manifest inspection, migration/schema comparison, and targeted source/test review were used across the audited scope. Live Linear reads and official web documentation reads were also performed. No implementation source was edited by the audit.
