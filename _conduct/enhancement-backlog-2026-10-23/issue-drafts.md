# Executable issue drafts

All PLAN-* handles are local planning aliases, not existing Linear identifiers. Publication and queue intake have not occurred.

# PLAN-A01: Bind authenticated service actors to a delegated-action context

Status: proposed Backlog issue; not published or queued.

## Outcome

Bind authenticated service actors to a delegated-action context.

## Trigger and behavior

Existing authenticated user/service-key fixtures resolve an actor identity, audience and expiry without accepting those fields from a request body.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `authfn/core/src/core`, `authfn/api-keys/src`.

## Interfaces and invariants

- Extend the existing AuthFn provider/API-key boundary; do not create a second identity database.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- Existing authenticated user/service-key fixtures resolve an actor identity, audience and expiry without accepting those fields from a request body.
- Forged, absent, expired and revoked identities fail closed; existing placement-grant logout/expiry semantics remain unchanged.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-A-PROVIDER and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: PLAN-A. Parent linkage is not a dependency.

## Exclusions

- Session access-policy orchestration belongs to SFO-39.
- Passkey enrollment, cross-domain SSO and Python adoption are separate future decisions.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 650 non-test lines; 1,500 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-A02: Persist versioned delegated connection grants

Status: proposed Backlog issue; not published or queued.

## Outcome

Persist versioned delegated connection grants.

## Trigger and behavior

An additive schema/store represents principal, exact connection/action scope, expiry, revision and revocation state.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `plugfn/core/src/storage`, `plugfn/core/src/types`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

Atomic invariant: The grant schema and its scoped persistence contract must land together.

## Decisions and defaults

- Existing user/organization grants remain valid under their documented semantics.
- New delegated grants are opt-in, explicitly scoped, and store no provider token values.
- Data-preserving additive migration; reverting code does not delete grant history.

## Acceptance evidence

- An additive schema/store represents principal, exact connection/action scope, expiry, revision and revocation state.
- Migration fixtures preserve existing connections and grants; down-version readers reject unknown required policy fields rather than widen access.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-A-DB and is not claimed by this issue.

## Dependencies

PLAN-A01

Hierarchy parent: PLUG-1. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 700 non-test lines; 1,600 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-A03: Evaluate delegated grants against current scope and revocation

Status: proposed Backlog issue; not published or queued.

## Outcome

Evaluate delegated grants against current scope and revocation.

## Trigger and behavior

An evaluator checks exact principal, tenant, connection, action, expiry and grant revision at the protected boundary.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `plugfn/core/src/policy`, `plugfn/core/src/core/connection-manager.ts`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

Atomic invariant: Grant evaluation and current revocation authority are one authorization invariant.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- An evaluator checks exact principal, tenant, connection, action, expiry and grant revision at the protected boundary.
- Revoking a delegated grant prevents the next authorization decision; stale cached decisions cannot authorize a new action.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-A-DB, PLAN-QA-A-PROVIDER and is not claimed by this issue.

## Dependencies

PLAN-A02

Hierarchy parent: PLUG-1. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 850 non-test lines; 1,900 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-A04: Enforce atomic per-grant action limits

Status: proposed Backlog issue; not published or queued.

## Outcome

Enforce atomic per-grant action limits.

## Trigger and behavior

Two concurrent workers cannot both consume the last permitted action for the same grant and window.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `plugfn/core/src/policy`, `plugfn/core/src/storage`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

Atomic invariant: Admission and usage reservation must be atomic.

## Decisions and defaults

- Windows and limits are explicitly configured; no unlimited fallback on store failure.
- Admission counts are distinct from provider delivery receipts and billing settlement.

## Acceptance evidence

- Two concurrent workers cannot both consume the last permitted action for the same grant and window.
- A failed store operation denies execution; retries reuse a logical attempt identity and do not reset the usage window.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-A-DB and is not claimed by this issue.

## Dependencies

PLAN-A03

Hierarchy parent: PLUG-1. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 850 non-test lines; 2,100 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-A05: Apply delegated policy at provider action dispatch

Status: proposed Backlog issue; not published or queued.

## Outcome

Apply delegated policy at provider action dispatch.

## Trigger and behavior

Credential-held execution rechecks current grant/scope after a credential refresh and before dispatch.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `plugfn/core/src/core/action-executor.ts`, `plugfn/core/src/core/connection-manager.ts`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

Atomic invariant: Dispatch may only consume a currently authorized scoped grant.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- Credential-held execution rechecks current grant/scope after a credential refresh and before dispatch.
- Denied calls cannot execute through direct, batch or cached action paths; result/audit fixtures contain no provider credential.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-A-PROVIDER and is not claimed by this issue.

## Dependencies

PLAN-A03, PLAN-A04

Hierarchy parent: PLUG-1. Parent linkage is not a dependency.

## Exclusions

- General Gmail scope/action/persistence work stays in PLUG-1.
- No new OAuth provider or hosted credential service.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 1,000 non-test lines; 2,300 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-A06: Bind optional tool approvals to the canonical manifest revision

Status: proposed Backlog issue; not published or queued.

## Outcome

Bind optional tool approvals to the canonical manifest revision.

## Trigger and behavior

A stored approval references the canonical tool description/schema/scope digest and principal.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `mcpfn/core/src/manifest.ts`, `mcpfn/core/src/diff.ts`, `mcpfn/auth/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- A stored approval references the canonical tool description/schema/scope digest and principal.
- Changing a policy-relevant declaration invalidates that approval; unchanged declarations remain usable.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux
- Node.js 20 ESM compatibility on Ubuntu
- Node.js 18 CommonJS compatibility on Ubuntu

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-MCP-HOST and is not claimed by this issue.

## Dependencies

PLAN-A01

Hierarchy parent: PLAN-A. Parent linkage is not a dependency.

## Exclusions

- Reuse current manifest, diff, protocol, auth and conformance features.
- No standalone proxy product or inspector UI.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 950 non-test lines; 2,200 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-A07: Scan bounded agent transcript and tool-result formats without leaking matches

Status: proposed Backlog issue; not published or queued.

## Outcome

Scan bounded agent transcript and tool-result formats without leaking matches.

## Trigger and behavior

Closed set: JSONL messages, JSON tool results, bearer authorization fields, cookie fields, key=value secrets and PEM private-key blocks; one positive/negative fixture per form.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `secfn/core/src`, `secfn/cli/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Audit-only by default; no claim of intercepting every client or preventing every leak.
- Synthetic fixtures only; no automatic scan of personal session history.
- Encoded/obfuscated/custom binary formats are excluded and go to PLAN-A-HARDENING.

## Acceptance evidence

- Closed set: JSONL messages, JSON tool results, bearer authorization fields, cookie fields, key=value secrets and PEM private-key blocks; one positive/negative fixture per form.
- Inputs are capped at 1 MiB per record and processed in bounded time; output includes redacted offsets, format coverage and explicit unsupported-format diagnostics.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-A-PRIVACY and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: PLAN-A. Parent linkage is not a dependency.

## Exclusions

- Active SFN-16 security-hardening work is preserved.
- No live client hook installation, document-wide injection classifier or universal secret detector.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Preserve active SFN-16; confirm its current security scope/ownership before adding this scanner work.

Planning size estimate: 900 non-test lines; 2,200 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-B01: Bind stored memories to revisioned source evidence

Status: proposed Backlog issue; not published or queued.

## Outcome

Bind stored memories to revisioned source evidence.

## Trigger and behavior

Additive fields identify source ID/revision, source span/hash, author and validity interval within the existing tenant/container scope.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `memoryfn/typescript/src/core/types.ts`, `memoryfn/typescript/src/storage`, `memoryfn/typescript/migrations`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

Atomic invariant: Evidence identity and its additive persistence representation land together.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- Additive fields identify source ID/revision, source span/hash, author and validity interval within the existing tenant/container scope.
- Migrations preserve existing scoped updates, tombstones and relationship cleanup; legacy memories without evidence are explicitly unverified.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.
- Exclusion: Python for this function is absent from dev; adding or claiming Python parity is a separate prerequisite decision.

External acceptance is deferred to PLAN-QA-B-DB and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: PLAN-B. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 750 non-test lines; 1,700 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-B02: Return stale and unavailable evidence states during memory retrieval

Status: proposed Backlog issue; not published or queued.

## Outcome

Return stale and unavailable evidence states during memory retrieval.

## Trigger and behavior

A changed/missing source or tombstone cannot be returned as current evidence; superseded relationships remain inspectable.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `memoryfn/typescript/src/core/pipeline.ts`, `memoryfn/typescript/src/storage`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- These are evidence-validity states, not a claim of semantic entailment.
- Existing contradiction/update edges and deletion authority are reused.
- No learned support classifier is enabled without a separate calibrated evaluation decision.

## Acceptance evidence

- A changed/missing source or tombstone cannot be returned as current evidence; superseded relationships remain inspectable.
- Results distinguish valid-source, stale-source, unavailable-source and related-memory states with source references.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.
- Exclusion: Python for this function is absent from dev; adding or claiming Python parity is a separate prerequisite decision.

External acceptance is deferred to PLAN-QA-B-DB and is not claimed by this issue.

## Dependencies

PLAN-B01, PLAN-B04

Hierarchy parent: PLAN-B. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 1,000 non-test lines; 2,300 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-B03: Expose optional source spans and revisions through search results

Status: proposed Backlog issue; not published or queued.

## Outcome

Expose optional source spans and revisions through search results.

## Trigger and behavior

An additive rich-result path returns source ID/revision/span and resource-scoped ranking evidence while legacy ID-array APIs keep their contract.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `searchfn/adapter-contracts/src`, `searchfn/client/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- An additive rich-result path returns source ID/revision/span and resource-scoped ranking evidence while legacy ID-array APIs keep their contract.
- Forbidden/deleted documents produce no hit, excerpt or citation; capability metadata identifies adapters lacking rich-result support.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-B-DB and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: PLAN-B. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 700 non-test lines; 1,600 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-B04: Resolve immutable file evidence references under current grants

Status: proposed Backlog issue; not published or queued.

## Outcome

Resolve immutable file evidence references under current grants.

## Trigger and behavior

A reference binds file version/digest/span metadata without embedding a signed download URL or bypassing current grants.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `filefn/server/src`, `filefn/client/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- A reference binds file version/digest/span metadata without embedding a signed download URL or bypassing current grants.
- Revocation or deletion invalidates resolution on the next read; version evidence survives an allowed metadata-only edit.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-B-FILES and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: PLAN-B. Parent linkage is not a dependency.

## Exclusions

- Client-side encryption modes and billing-gated file sharing remain later policy choices.
- No new file-store implementation.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 700 non-test lines; 1,600 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-B05: Promote reusable procedures only from matching executed evidence

Status: proposed Backlog issue; not published or queued.

## Outcome

Promote reusable procedures only from matching executed evidence.

## Trigger and behavior

A procedure candidate names an exact procedure revision and at least two distinct passing run receipts for the same declared check set.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `memoryfn/typescript/src/core`, `memoryfn/typescript/src/storage`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Promotion is off by default and never follows from an agent’s own narrative alone.
- No automatic execution of stored text.
- Benchmark improvements and generalized learning claims are outside this issue.

## Acceptance evidence

- A procedure candidate names an exact procedure revision and at least two distinct passing run receipts for the same declared check set.
- Promotion requires a caller-authorized explicit decision; stale source/check revisions or a failed receipt revoke eligibility and remain inspectable.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.
- Exclusion: Python for this function is absent from dev; adding or claiming Python parity is a separate prerequisite decision.

External acceptance is deferred to PLAN-QA-B-QUALITY and is not claimed by this issue.

## Dependencies

PLAN-B02

Hierarchy parent: PLAN-B. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 800 non-test lines; 1,800 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-C01: Normalize per-attempt inference usage and cost receipts

Status: proposed Backlog issue; not published or queued.

## Outcome

Normalize per-attempt inference usage and cost receipts.

## Trigger and behavior

Receipts link request, attempt, provider/model, policy version, finish state, token usage and cost basis without raw prompts or credentials.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `langfn/typescript/src/core`, `langfn/typescript/src/observability`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- TypeScript only on dev; no Python parity claim.
- Costs use configured integer minor units and an explicit currency/rate version; provider data and estimates are distinguished.

## Acceptance evidence

- Receipts link request, attempt, provider/model, policy version, finish state, token usage and cost basis without raw prompts or credentials.
- Unknown usage/cost stays unknown; cancellation, retries and fallback preserve individual attempt identities.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.
- Exclusion: Python for this function is absent from dev; adding or claiming Python parity is a separate prerequisite decision.

External acceptance is deferred to PLAN-QA-MODEL and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: PLAN-C. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 650 non-test lines; 1,500 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-C02: Add an additive usage-reservation ledger

Status: proposed Backlog issue; not published or queued.

## Outcome

Add an additive usage-reservation ledger.

## Trigger and behavior

Schema fixtures represent immutable reservation/commit/release identities, billing scope, amount, currency and source receipt.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `billfn/core/src/schema.ts`, `billfn/core/src/storage`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- Schema fixtures represent immutable reservation/commit/release identities, billing scope, amount, currency and source receipt.
- Existing subscriptions, entitlements, provider charges and refunds are unchanged; repeat migration is safe.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-C-DB and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: PLAN-C. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 600 non-test lines; 1,400 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-C03: Commit or release usage reservations atomically

Status: proposed Backlog issue; not published or queued.

## Outcome

Commit or release usage reservations atomically.

## Trigger and behavior

Duplicate requests, restarts and two-worker races produce one terminal transition per logical usage event.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `billfn/core/src/service.ts`, `billfn/core/src/storage`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

Atomic invariant: Reservation balance and terminal transition are one atomic ledger invariant.

## Decisions and defaults

- This is internal usage accounting, not automatic money movement or provider refunds.
- The selected durable adapter must support the required atomic transition; missing support is a prerequisite, never a memory-only production substitute.

## Acceptance evidence

- Duplicate requests, restarts and two-worker races produce one terminal transition per logical usage event.
- Defined failed work releases its reservation; an ambiguous outcome remains pending reconciliation rather than being charged or released twice.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-C-DB and is not claimed by this issue.

## Dependencies

PLAN-C02

Hierarchy parent: PLAN-C. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 1,100 non-test lines; 2,500 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.

Ordered fallback if the change approaches/exceeds budget:

1. `billfn/core/src/storage`: Land storage compare-and-transition with the complete race fixture set.
2. `billfn/core/src/service.ts`: Bind public reservation operations to that merged store contract; preserve all terminal-state invariants.


---

# PLAN-C04: Route inference within an explicit attempt and cost budget

Status: proposed Backlog issue; not published or queued.

## Outcome

Route inference within an explicit attempt and cost budget.

## Trigger and behavior

A caller-supplied finite routing policy selects allowed models, per-attempt budget, timeout and structured result checks.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `langfn/typescript/src/models`, `langfn/typescript/src/orchestration`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Routing is opt-in; no provider/geography/model change is inferred from a cheap price alone.
- Quality means caller-declared observable checks in this slice; broad natural-language quality scoring is deferred.

## Acceptance evidence

- A caller-supplied finite routing policy selects allowed models, per-attempt budget, timeout and structured result checks.
- A failed attempt can fall back only within remaining budget and allowed providers; every choice and failure has a receipt.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.
- Exclusion: Python for this function is absent from dev; adding or claiming Python parity is a separate prerequisite decision.

External acceptance is deferred to PLAN-QA-MODEL and is not claimed by this issue.

## Dependencies

PLAN-C01

Hierarchy parent: PLAN-C. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 950 non-test lines; 2,200 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-C05: Compose inference attempts with billing reservations

Status: proposed Backlog issue; not published or queued.

## Outcome

Compose inference attempts with billing reservations.

## Trigger and behavior

The adapter links one logical task to its attempt receipts and usage reservation; cancellation preserves unresolved provider outcomes.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `langfn/typescript/src`, `billfn/core/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- The adapter links one logical task to its attempt receipts and usage reservation; cancellation preserves unresolved provider outcomes.
- Duplicate retries cannot create a second reservation; rejected budgets prevent model dispatch.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.
- Exclusion: Python for this function is absent from dev; adding or claiming Python parity is a separate prerequisite decision.

External acceptance is deferred to PLAN-QA-MODEL, PLAN-QA-C-DB and is not claimed by this issue.

## Dependencies

PLAN-C03, PLAN-C04

Hierarchy parent: PLAN-C. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 750 non-test lines; 1,800 total lines; at most 2 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-C06: Add an opt-in semantic-cache admission and identity contract

Status: proposed Backlog issue; not published or queued.

## Outcome

Add an opt-in semantic-cache admission and identity contract.

## Trigger and behavior

Cache identity includes tenant, permission scope, corpus revision, model and prompt policy revision.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `cachefn/typescript/src`, `langfn/typescript/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Disabled by default; similarity threshold and eviction policy are explicit caller configuration.
- No claim that embedding similarity proves answer equivalence.
- TS implementation only; a Python port requires its own prerequisite decision.

## Acceptance evidence

- Cache identity includes tenant, permission scope, corpus revision, model and prompt policy revision.
- Closed fixtures cover identical meaning, negation, different numeric amounts, changed corpus and different tenant; unsafe/unknown cases bypass reuse.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.
- Exclusion: Python for this function is absent from dev; adding or claiming Python parity is a separate prerequisite decision.

External acceptance is deferred to PLAN-QA-CACHE-EVAL and is not claimed by this issue.

## Dependencies

PLAN-C01, PLAN-C04, GATE-cachefn

Hierarchy parent: PLAN-C. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 950 non-test lines; 2,200 total lines; at most 2 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-C07: Provide validated execution-cost chart presets through the existing adapter

Status: proposed Backlog issue; not published or queued.

## Outcome

Provide validated execution-cost chart presets through the existing adapter.

## Trigger and behavior

Typed fixtures project known usage receipts into cost-flow and retry/latency presets with explicit units and source IDs.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `chartfn/core`, `chartfn/react`, `chartfn/svelte`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Use the existing ECharts path; no new chart renderer.
- This is a demand-gated later slice, not a prerequisite for inference routing.

## Acceptance evidence

- Typed fixtures project known usage receipts into cost-flow and retry/latency presets with explicit units and source IDs.
- Unknown values remain unknown; exported plots contain no prompts or raw data beyond the caller-selected fields.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-CHART-VISUAL and is not claimed by this issue.

## Dependencies

PLAN-C01, GATE-chartfn

Hierarchy parent: PLAN-C. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 450 non-test lines; 1,000 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-D01: Bind declared requirements to exact-revision test receipts

Status: proposed Backlog issue; not published or queued.

## Outcome

Bind declared requirements to exact-revision test receipts.

## Trigger and behavior

A closed requirement manifest format maps IDs to executed assertions and exact code/check revisions.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `testfn/typescript/src`, `testfn/python/testfn`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Initial adapters: the existing Vitest and pytest paths; other runners need explicit adapter follow-up.
- Tests never infer requirement coverage from a passing process exit alone.

## Acceptance evidence

- A closed requirement manifest format maps IDs to executed assertions and exact code/check revisions.
- A requirement with no executed assertion stays unverified; unit, running-service and browser evidence are different receipt types.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux
- Python 3.11 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-D-RUNTIME and is not claimed by this issue.

## Dependencies

BASE-01, GATE-testfn

Hierarchy parent: PLAN-D. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 1,100 non-test lines; 2,500 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.

Ordered fallback if the change approaches/exceeds budget:

1. `testfn/typescript/src/contracts`, `testfn/python/testfn/contracts`: Land shared wire schema, identity rules and positive/negative fixture vectors.
2. `testfn/typescript/src/reporters`, `testfn/python/testfn/reporters`: Attach actual runner results to the merged contract; test stale and missing evidence.


---

# PLAN-D02: Export editable browser reproductions from captured evidence

Status: proposed Backlog issue; not published or queued.

## Outcome

Export editable browser reproductions from captured evidence.

## Trigger and behavior

A local captured flow exports a Playwright draft with exact URL, viewport, authorized profile reference, assertions and locator alternatives.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `probefn/packages/contracts`, `probefn/packages/browser-runner`, `probefn/packages/session-reporter`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Generated code is a draft until it replays deterministically against the intended revision.
- Recorded evidence is data; arbitrary captured text is not executable runner code.

## Acceptance evidence

- A local captured flow exports a Playwright draft with exact URL, viewport, authorized profile reference, assertions and locator alternatives.
- Duplicate/unstable locators and missing assertions are explicit; redacted fields are never restored in exported code.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux
- Headless Playwright fixture coverage on Ubuntu; actual browser/device acceptance is separate.

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-D-BROWSER and is not claimed by this issue.

## Dependencies

PLAN-D01, GATE-probefn

Hierarchy parent: PLAN-D. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 1,000 non-test lines; 2,300 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-D03: Link bug reports to a bounded reproduction task

Status: proposed Backlog issue; not published or queued.

## Outcome

Link bug reports to a bounded reproduction task.

## Trigger and behavior

A sanitized report links release, runtime evidence, source report identity and the reproduction/test draft.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `catchfn/typescript/src`, `catchfn/server/typescript`, `probefn/packages/session-reporter`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- A sanitized report links release, runtime evidence, source report identity and the reproduction/test draft.
- Task export preserves uncertainty and missing evidence; a generated task never implies a verified reproduction or fix.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux
- Headless Playwright fixture coverage on Ubuntu; actual browser/device acceptance is separate.

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-D-BROWSER and is not claimed by this issue.

## Dependencies

PLAN-D02, GATE-catchfn, GATE-probefn

Hierarchy parent: PLAN-D. Parent linkage is not a dependency.

## Exclusions

- Tracker-specific OAuth and delivery stay in PlugFn.
- No autonomous code modification or customer communication.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 850 non-test lines; 1,900 total lines; at most 2 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-D04: Prevent superseded CI revisions from claiming promotion

Status: proposed Backlog issue; not published or queued.

## Outcome

Prevent superseded CI revisions from claiming promotion.

## Trigger and behavior

Revision ownership and promotion claims are atomic; an older run cannot promote after a newer accepted revision supersedes it.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `cifn/typescript/control-plane`, `cifn/typescript/runner`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

Atomic invariant: Supersession and promotion authority are one concurrency invariant.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- Revision ownership and promotion claims are atomic; an older run cannot promote after a newer accepted revision supersedes it.
- Test/requirement receipts and artifact identities are bound to the promoted revision; cancellation and restarted runner fixtures preserve the claim invariant.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-D-RUNNER and is not claimed by this issue.

## Dependencies

PLAN-D01, GATE-cifn

Hierarchy parent: PLAN-D. Parent linkage is not a dependency.

## Exclusions

- Ephemeral VM provider selection, native runner code and autoscaling are separate later issues.
- No runtime/container sandbox claim from scheduling policy alone.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 1,000 non-test lines; 2,300 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-D05: Assert required tool selection from observed client-run traces

Status: proposed Backlog issue; not published or queued.

## Outcome

Assert required tool selection from observed client-run traces.

## Trigger and behavior

A recorded client-run trace is checked for required/forbidden tool calls under a finite named scenario.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `mcpfn/testing/src/scenarios.ts`, `mcpfn/testing/src/client.ts`, `mcpfn/testing/src/reports.ts`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- A recorded client-run trace is checked for required/forbidden tool calls under a finite named scenario.
- A run that answers without the required tool fails even if direct server calls and protocol conformance pass; dropped events yield incomplete evidence.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux
- Node.js 20 ESM compatibility on Ubuntu
- Node.js 18 CommonJS compatibility on Ubuntu

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-MCP-HOST and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: PLAN-D. Parent linkage is not a dependency.

## Exclusions

- Reuse existing scenario, client-event, host-profile and conformance contracts.
- No model benchmark or unbounded agent evaluator.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 700 non-test lines; 1,600 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-E01: Emit post-sync integrity receipts from existing reconciliation

Status: proposed Backlog issue; not published or queued.

## Outcome

Emit post-sync integrity receipts from existing reconciliation.

## Trigger and behavior

A receipt identifies the scoped sync/source revision and missing, duplicate or changed-field keys under a declared comparison schema.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `datafn/server/src`, `datafn/client/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- A receipt identifies the scoped sync/source revision and missing, duplicate or changed-field keys under a declared comparison schema.
- Pagination or comparison failures are incomplete, not success; injected dropped/duplicated mutations are found independently of transport success.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-E-DATA and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: PLAN-E. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 850 non-test lines; 1,900 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-E02: Bind deployment plans to exact target and revision

Status: proposed Backlog issue; not published or queued.

## Outcome

Bind deployment plans to exact target and revision.

## Trigger and behavior

A plan includes the configured provider/account/target, code revision, health gates, migration ordering and rollback limitations.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `hostfn/cli/src`, `hostfn/admin/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- A plan includes the configured provider/account/target, code revision, health gates, migration ordering and rollback limitations.
- Execution rejects a changed target/revision or stale plan; health-check failure cannot cut traffic over to the candidate.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-HOST and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: PLAN-E. Parent linkage is not a dependency.

## Exclusions

- No new cloud provider, domain provisioning or implicit production deployment.
- Database rollback is never implied by application rollback.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 900 non-test lines; 2,100 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-E03: Persist explicit durable-effect checkpoints

Status: proposed Backlog issue; not published or queued.

## Outcome

Persist explicit durable-effect checkpoints.

## Trigger and behavior

A storage contract identifies workflow/effect, input digest, durable boundary and committed/unknown/failed outcomes.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `flowfn/typescript/src/storage`, `flowfn/typescript/src/workflow`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- A storage contract identifies workflow/effect, input digest, durable boundary and committed/unknown/failed outcomes.
- Additive migration and restart fixtures preserve effect identity; a backend lacking atomic transition support fails capability checks.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-FLOW-DB and is not claimed by this issue.

## Dependencies

BASE-01, GATE-flowfn

Hierarchy parent: PLAN-E. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 750 non-test lines; 1,800 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-E04: Resume durable effects without replaying committed side effects

Status: proposed Backlog issue; not published or queued.

## Outcome

Resume durable effects without replaying committed side effects.

## Trigger and behavior

On restart, committed effects return their recorded result and unresolved effects reconcile according to an explicit idempotency policy.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `flowfn/typescript/src/workflow`, `flowfn/typescript/src/core`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

Atomic invariant: Checkpoint commit, effect ownership and cancellation authority cannot be separated into an unsafe intermediate contract.

## Decisions and defaults

- No universal exactly-once claim for arbitrary external APIs.
- Unknown outcomes require the configured reconciler; no blind retry for non-idempotent work.

## Acceptance evidence

- On restart, committed effects return their recorded result and unresolved effects reconcile according to an explicit idempotency policy.
- A canceled durable wait or expired owner cannot dispatch a later side effect; child joins preserve completion identities.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-FLOW-DB and is not claimed by this issue.

## Dependencies

PLAN-E03, GATE-flowfn

Hierarchy parent: PLAN-E. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 1,200 non-test lines; 2,700 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.

Ordered fallback if the change approaches/exceeds budget:

1. `flowfn/typescript/src/workflow/effect-runtime.ts`: Implement committed-effect read/reconcile against the merged E03 store.
2. `flowfn/typescript/src/workflow/waits.ts`: Add durable waits/joins only after the effect API is stable; retain the same cancellation/ownership invariant.


---

# PLAN-E05: Prove recovery at a closed set of effect boundaries

Status: proposed Backlog issue; not published or queued.

## Outcome

Prove recovery at a closed set of effect boundaries.

## Trigger and behavior

The harness kills a fixture workflow before/after reservation, dispatch, outcome recording and checkpoint commit, then compares with a baseline.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `flowfn/typescript/tests/recovery`, `flowfn/typescript/examples`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- The harness kills a fixture workflow before/after reservation, dispatch, outcome recording and checkpoint commit, then compares with a baseline.
- The report counts duplicate/missing effects and unknown outcomes and identifies backend/policy versions; it never labels untested boundaries passed.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-FLOW-DB and is not claimed by this issue.

## Dependencies

PLAN-E04, GATE-flowfn

Hierarchy parent: PLAN-E. Parent linkage is not a dependency.

## Exclusions

- No production failure injection or generalized program-continuation engine.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 450 non-test lines; 1,200 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-E06: Restore a scoped data-and-file fixture with verification receipts

Status: proposed Backlog issue; not published or queued.

## Outcome

Restore a scoped data-and-file fixture with verification receipts.

## Trigger and behavior

A manifest links data records and file versions/digests under explicit target scope; restore rejects a nonempty or unregistered target.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `datafn/server/src`, `filefn/server/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- No credential/session cloning or automatic account restoration.
- No destructive restore into production or an arbitrary existing environment.

## Acceptance evidence

- A manifest links data records and file versions/digests under explicit target scope; restore rejects a nonempty or unregistered target.
- An interrupted restore resumes/reconciles and produces referential-integrity plus authorization checks; cleanup is confined to resources created by the run.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-RECOVERY and is not claimed by this issue.

## Dependencies

PLAN-E01, PLAN-B04

Hierarchy parent: PLAN-E. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 1,100 non-test lines; 2,600 total lines; at most 2 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.

Ordered fallback if the change approaches/exceeds budget:

1. `datafn/server/src/recovery`: Land versioned manifest, empty-target preconditions and record reconciliation.
2. `filefn/server/src/recovery`: Resolve/verify exact file versions against the merged manifest, then integrate cross-resource receipt fixtures.


---

# PLAN-E07: Own preview-environment resource leases and cleanup

Status: proposed Backlog issue; not published or queued.

## Outcome

Own preview-environment resource leases and cleanup.

## Trigger and behavior

A preview run records exact created resources and an expiring ownership lease before executing provider changes.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `hostfn/cli/src`, `hostfn/cli/tests`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

Atomic invariant: Resource identity and lease ownership must be verified before cleanup.

## Decisions and defaults

- Only explicitly registered nonproduction targets are permitted.
- Preview provisioning stays off unless requested by the caller.

## Acceptance evidence

- A preview run records exact created resources and an expiring ownership lease before executing provider changes.
- Concurrent cleanup, failed provisioning and restart fixtures do not delete unowned resources; deletion readback is retained.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-HOST and is not claimed by this issue.

## Dependencies

PLAN-E02

Hierarchy parent: PLAN-E. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 1,000 non-test lines; 2,300 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-E08: Normalize retrieval evidence and extraction failures across providers

Status: proposed Backlog issue; not published or queued.

## Outcome

Normalize retrieval evidence and extraction failures across providers.

## Trigger and behavior

Closed adapters: current HTML/HTTP and Playwright web retrieval; outputs include final URL, timestamp, render mode, source spans and schema-validation result.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `browsefn/typescript/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- No anti-bot bypass, credential scraping or universal website-success claim.
- Python and other provider paths are explicit later capabilities, not inferred from TS support.

## Acceptance evidence

- Closed adapters: current HTML/HTTP and Playwright web retrieval; outputs include final URL, timestamp, render mode, source spans and schema-validation result.
- Blocked/challenged/empty pages remain failed or incomplete; a structured extraction cannot fabricate fields absent from captured evidence.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-WEB and is not claimed by this issue.

## Dependencies

BASE-01, GATE-browsefn

Hierarchy parent: PLAN-E. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 850 non-test lines; 1,900 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-F01: Reject stale AI edit proposals using the current source revision

Status: proposed Backlog issue; not published or queued.

## Outcome

Reject stale AI edit proposals using the current source revision.

## Trigger and behavior

Existing range-validated AI edits/suggestions can carry an expected source hash/version; a stale proposal is rejected before changing the document.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `mdfn/ai/src/index.ts`, `mdfn/core/src/transaction.ts`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- Existing range-validated AI edits/suggestions can carry an expected source hash/version; a stale proposal is rejected before changing the document.
- Accepted proposals use the normal transaction/sidecar path and preserve untouched source plus unsupported constructs.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux
- Headless Playwright fixture coverage on Ubuntu; actual browser/device acceptance is separate.

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-AUTHORING and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: PLAN-F. Parent linkage is not a dependency.

## Exclusions

- Do not recreate existing AI edit conversion, suggestions, undo or collaboration.
- No remote inference or replacement editor.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 350 non-test lines; 850 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-F02: Expose schema-derived content patch plans

Status: proposed Backlog issue; not published or queued.

## Outcome

Expose schema-derived content patch plans.

## Trigger and behavior

A plan names schema/document revisions, exact field operations and validation diagnostics before an authorized write.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `contentfn/core/src`, `contentfn/server/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- ContentFn owns schema/patch validity; CMS workflow and permissions remain CmsFn-owned.
- Plan generation performs no publication.

## Acceptance evidence

- A plan names schema/document revisions, exact field operations and validation diagnostics before an authorized write.
- Unknown fields, protected scope and stale revisions fail before publication; HTTP/CLI/MCP projections consume the same plan representation.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-CONTENT and is not claimed by this issue.

## Dependencies

BASE-01, GATE-contentfn

Hierarchy parent: PLAN-F. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 850 non-test lines; 1,900 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-F03: Provide schema-driven draft forms and scoped publish previews

Status: proposed Backlog issue; not published or queued.

## Outcome

Provide schema-driven draft forms and scoped publish previews.

## Trigger and behavior

A small fixed schema can be drafted, edited and previewed through existing authoring bindings without manual JSON editing.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `cmsfn/studio/src`, `cmsfn/server/src`, `mdfn/components/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Reuse the existing Mdfn editor; do not add another document engine.
- No automatic multilingual publishing or broad CMS migration.

## Acceptance evidence

- A small fixed schema can be drafted, edited and previewed through existing authoring bindings without manual JSON editing.
- An agent may propose a release, but current permission checks, source revisions and preview scope govern publication.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux
- Headless Playwright fixture coverage on Ubuntu; actual browser/device acceptance is separate.

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-CONTENT, PLAN-QA-AUTHORING and is not claimed by this issue.

## Dependencies

PLAN-F01, PLAN-F02, GATE-cmsfn

Hierarchy parent: PLAN-F. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 1,100 non-test lines; 2,500 total lines; at most 2 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.

Ordered fallback if the change approaches/exceeds budget:

1. `cmsfn/server/src`: Define draft/preview authorization and release plan fixtures.
2. `cmsfn/studio/src`: Build forms and existing Mdfn binding against the merged server contract; verify stale/denied states.


---

# PLAN-F04: Apply reversible structured diagram changes with source references

Status: proposed Backlog issue; not published or queued.

## Outcome

Apply reversible structured diagram changes with source references.

## Trigger and behavior

A closed scene-delta JSON format updates existing typed nodes/edges while retaining stable IDs and untouched layout.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `drawfn/core/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Initial grammar is versioned JSON deltas only.
- General diagram-language import and automatic layout replacement are deferred.

## Acceptance evidence

- A closed scene-delta JSON format updates existing typed nodes/edges while retaining stable IDs and untouched layout.
- Source ID/revision references survive scene export/import and undo; stale referenced evidence is visible.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-DIAGRAM and is not claimed by this issue.

## Dependencies

BASE-01, GATE-drawfn

Hierarchy parent: PLAN-F. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 850 non-test lines; 1,900 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-F05: Mark documentation stale when its declared API/source revision changes

Status: proposed Backlog issue; not published or queued.

## Outcome

Mark documentation stale when its declared API/source revision changes.

## Trigger and behavior

A bounded manifest links a page/example to declared symbols/operation IDs and revision digests.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `docsfn/core`, `docsfn/provider-fs`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- A bounded manifest links a page/example to declared symbols/operation IDs and revision digests.
- A changed source marks the related page/example stale and produces a patch proposal; it does not publish new prose automatically.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-DOCS and is not claimed by this issue.

## Dependencies

DOC-7, SFNS-16, SFNS-25, DOC-6

Hierarchy parent: DOC-1. Parent linkage is not a dependency.

## Exclusions

- Standalone publishing, framework routes, public agent outputs and reader MCP remain DOC-1–10.
- No replacement renderer, SDK generator or second API catalog.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 700 non-test lines; 1,600 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-G01: Standardize scoped command plans and dry-run output

Status: proposed Backlog issue; not published or queued.

## Outcome

Standardize scoped command plans and dry-run output.

## Trigger and behavior

A typed plan identifies account, environment, target and intended effect; an owning CLI validates plan identity before execution.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `clifn/core/src/output.ts`, `clifn/core/src/runner.ts`, `clifn/core/src/diagnostics.ts`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- A typed plan identifies account, environment, target and intended effect; an owning CLI validates plan identity before execution.
- JSON stdout remains parseable while progress is on stderr; errors expose stable codes and next-step hints without secrets.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-CLI and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: PLAN-G. Parent linkage is not a dependency.

## Exclusions

- Each owning CLI keeps its command graph, policy and external executor.
- No shell-evaluation engine or inferred permission from displaying a plan.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 650 non-test lines; 1,500 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-G02: Publish bounded page-context capture and sidepanel extension recipes

Status: proposed Backlog issue; not published or queued.

## Outcome

Publish bounded page-context capture and sidepanel extension recipes.

## Trigger and behavior

The same recipe captures selected public element text, selector candidates and optional build-provided source metadata on Chromium/Firefox MV3.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `extfn/examples`, `extfn/core/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- The same recipe captures selected public element text, selector candidates and optional build-provided source metadata on Chromium/Firefox MV3.
- Password fields, form values and unrelated page contents are excluded; missing permissions or unsupported browser capabilities are visible.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-EXTENSION and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: SFO-44. Parent linkage is not a dependency.

## Exclusions

- Existing extension platform work remains SFO-44.
- No third-party site automation or browser credential custody.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 800 non-test lines; 1,800 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-G03: Define experimental agent-run interaction states

Status: proposed Backlog issue; not published or queued.

## Outcome

Define experimental agent-run interaction states.

## Trigger and behavior

A controlled event model represents running, waiting, retrying, canceled, failed and complete states with tool/action context.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `uifn/patterns/src`, `uifn/patterns/fixtures`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Remain in the existing experimental lane.
- Expose meaningful state without depending on animation, color or a particular agent backend.

## Acceptance evidence

- A controlled event model represents running, waiting, retrying, canceled, failed and complete states with tool/action context.
- Patterns accept explicit data/callbacks and never execute tools themselves; unknown events fail visibly.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux
- Headless Playwright fixture coverage on Ubuntu; actual browser/device acceptance is separate.

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-UI-BROWSER, PLAN-QA-A11Y-MAC, PLAN-QA-A11Y-WINDOWS and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: PLAN-G. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 500 non-test lines; 1,200 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-G04: Bind agent-run patterns consistently across supported frameworks

Status: proposed Backlog issue; not published or queued.

## Outcome

Bind agent-run patterns consistently across supported frameworks.

## Trigger and behavior

One fixture sequence produces equivalent semantic state and accessible names in React, Svelte and Solid.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `uifn/components-react`, `uifn/components-svelte`, `uifn/components-solid`, `uifn/patterns/stories`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- One fixture sequence produces equivalent semantic state and accessible names in React, Svelte and Solid.
- Keyboard focus, cancellation/pending states and reduced-motion behavior remain deterministic across adapters.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux
- Headless Playwright fixture coverage on Ubuntu; actual browser/device acceptance is separate.

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-UI-BROWSER, PLAN-QA-A11Y-MAC, PLAN-QA-A11Y-WINDOWS and is not claimed by this issue.

## Dependencies

PLAN-G03

Hierarchy parent: PLAN-G. Parent linkage is not a dependency.

## Exclusions

- Stable UIFn packages and existing upload/billing/auth patterns are reused.
- No promotion of experimental packages to stable as part of this issue.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 1,000 non-test lines; 2,300 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-G05: Resolve semantic icon aliases through a thin catalog adapter

Status: proposed Backlog issue; not published or queued.

## Outcome

Resolve semantic icon aliases through a thin catalog adapter.

## Trigger and behavior

A small declared alias set resolves deterministically with source/license metadata and accessible labels.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `iconfn/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Demand-gated later candidate; reuse an existing icon engine.
- No bespoke large asset catalog or unlicensed asset copying.

## Acceptance evidence

- A small declared alias set resolves deterministically with source/license metadata and accessible labels.
- Missing icons produce an explicit fallback; sizing follows current UI tokens.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-UI-BROWSER and is not claimed by this issue.

## Dependencies

BASE-01, GATE-iconfn

Hierarchy parent: PLAN-G. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 300 non-test lines; 700 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-G06: Project an attention inbox from configured operator capabilities

Status: proposed Backlog issue; not published or queued.

## Outcome

Project an attention inbox from configured operator capabilities.

## Trigger and behavior

An injected provider turns configured function records into scoped attention items with authoritative links and available actions.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `superconsole/src`, `packages/admin/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- An injected provider turns configured function records into scoped attention items with authoritative links and available actions.
- The shell cannot invent capabilities or infer a global function catalog; existing audit/confirmation/idempotency gates apply to every action.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-CONSOLE and is not claimed by this issue.

## Dependencies

PLAN-G01, PLAN-I02

Hierarchy parent: PLAN-G. Parent linkage is not a dependency.

## Exclusions

- No operator-policy rewrite or hardcoded integration list.
- No automatic remediation.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 800 non-test lines; 1,800 total lines; at most 2 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-G07: Extend existing upload patterns with verified processing states

Status: proposed Backlog issue; not published or queued.

## Outcome

Extend existing upload patterns with verified processing states.

## Trigger and behavior

Existing dropzone/progress patterns expose queue, retry, resume and processing/scan states from the owning FileFn client.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `uifn/patterns/src`, `filefn/client/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- Existing dropzone/progress patterns expose queue, retry, resume and processing/scan states from the owning FileFn client.
- A reload or temporary network loss preserves honest progress; an unavailable scan capability is not shown as passed.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux
- Headless Playwright fixture coverage on Ubuntu; actual browser/device acceptance is separate.

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-UI-BROWSER, PLAN-QA-B-FILES and is not claimed by this issue.

## Dependencies

PLAN-B04

Hierarchy parent: PLAN-G. Parent linkage is not a dependency.

## Exclusions

- Do not recreate existing FileDropzonePanel or UploadProgressList.
- No new upload storage engine or encryption implementation.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 650 non-test lines; 1,500 total lines; at most 2 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-H01: Package a scoped inbox-to-reply starter using existing composition

Status: proposed Backlog issue; not published or queued.

## Outcome

Package a scoped inbox-to-reply starter using existing composition.

## Trigger and behavior

Local fixtures demonstrate scoped inbox provisioning, MIME receipt, wait/OTP extraction, a reply draft and explicit send through the current composition adapter.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `mailfn/examples`, `mailfn/sendfn`, `sendfn/typescript/examples`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- Local fixtures demonstrate scoped inbox provisioning, MIME receipt, wait/OTP extraction, a reply draft and explicit send through the current composition adapter.
- The starter shows stable logical send identity, reply/thread linkage and uncertain outcomes without claiming provider deduplication.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-MAIL-DNS, PLAN-QA-MAIL-DELIVERY and is not claimed by this issue.

## Dependencies

BASE-01

Hierarchy parent: PLAN-H. Parent linkage is not a dependency.

Preserve active PRs #256, #257; revalidate their merged/dispositioned scope before editing the same boundary.

## Exclusions

- Inbox scope, waits, OTP, CLI/MCP and SendFn composition already exist.
- No automatic external signup, domain registration or provider send during code acceptance.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Rebase and recheck the named active PR scope after its disposition; do not amend that work.

Planning size estimate: 650 non-test lines; 1,500 total lines; at most 2 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-H02: Reserve transactional delivery capacity through the durable scheduler

Status: proposed Backlog issue; not published or queued.

## Outcome

Reserve transactional delivery capacity through the durable scheduler.

## Trigger and behavior

An explicit transactional lane has reserved admission/capacity when a broadcast lane is saturated.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `sendfn/typescript/src`, `sendfn/python/sendfn`, `flowfn/typescript/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Reuse FlowFn scheduling; do not create a second durable queue in SendFn.
- No provider exactly-once guarantee is inferred from MIME idempotency headers.
- Only caller-declared lane/policy is used; no inferred marketing classification.

## Acceptance evidence

- An explicit transactional lane has reserved admission/capacity when a broadcast lane is saturated.
- Unknown SES/provider outcomes are reconciled before any resend/fallback; caller cancellation does not prove delivery failed.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux
- Python 3.11 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-MAIL-DELIVERY and is not claimed by this issue.

## Dependencies

PLAN-E04, GATE-flowfn

Hierarchy parent: PLAN-H. Parent linkage is not a dependency.

Preserve active PRs #256, #257; revalidate their merged/dispositioned scope before editing the same boundary.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base. Rebase and recheck the named active PR scope after its disposition; do not amend that work.

Planning size estimate: 1,000 non-test lines; 2,300 total lines; at most 2 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-H03: Provide typed bot event recipes with deterministic replay

Status: proposed Backlog issue; not published or queued.

## Outcome

Provide typed bot event recipes with deterministic replay.

## Trigger and behavior

A finite command/event recipe format maps a declared platform event to a previewable action payload.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `botfn/shared-types`, `botfn/persistence`, `botfn/bot-slack`, `botfn/bot-discord`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- A finite command/event recipe format maps a declared platform event to a previewable action payload.
- Duplicate event identity is deduplicated in a durable configured store; replay cannot widen channel/server or action scope.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-BOT and is not claimed by this issue.

## Dependencies

PLAN-A05

Hierarchy parent: PLAN-H. Parent linkage is not a dependency.

## Exclusions

- No general no-code workflow builder or new platform connection system.
- Outbound provider actions use PlugFn policy; scheduling uses FlowFn when enabled.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 750 non-test lines; 1,700 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

Existing function sources on dev, plus the explicit earlier drafts/existing issues named in dependencies.


---

# PLAN-H04: Attach capability and source-span evidence to transcription results

Status: proposed Backlog issue; not published or queued.

## Outcome

Attach capability and source-span evidence to transcription results.

## Trigger and behavior

ASR adapters declare local/cloud, supported timing and diarization capabilities; unsupported metadata stays unavailable.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `recfn/core`, `recfn/server`, `recfn/adapters`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- No claim of speaker accuracy from an adapter field alone.
- Source audio retention and model choice are explicit caller configuration.

## Acceptance evidence

- ASR adapters declare local/cloud, supported timing and diarization capabilities; unsupported metadata stays unavailable.
- Transcript segments and derived action items reference exact audio/transcript revision and timestamps.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-RECORDING and is not claimed by this issue.

## Dependencies

BASE-01, GATE-recfn

Hierarchy parent: PLAN-H. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 850 non-test lines; 1,900 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-H05: Make local recording mode explicit on the supported Mac path

Status: proposed Backlog issue; not published or queued.

## Outcome

Make local recording mode explicit on the supported Mac path.

## Trigger and behavior

An explicit owner action starts/stops the existing local capture path; recording state and selected mic/system source remain visible.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `recfn/desktop/macos`, `recfn/desktop/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

Atomic invariant: Native capture ownership and stop/disposal behavior must remain one lifecycle invariant.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- An explicit owner action starts/stops the existing local capture path; recording state and selected mic/system source remain visible.
- A local-only mode cannot upload audio; unavailable permissions/models are explicit and cancel/stop releases capture resources.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- macOS 14+ on Apple Silicon; supported Swift/toolchain must be pinned in its prerequisite plan.

- Exclusion: Windows/Linux capture and Intel Mac support are excluded from this slice.

External acceptance is deferred to PLAN-QA-RECORDING and is not claimed by this issue.

## Dependencies

PLAN-H04, GATE-recfn

Hierarchy parent: PLAN-H. Parent linkage is not a dependency.

## Exclusions

- macOS 14+ on Apple Silicon only for this native slice.
- Windows/Linux capture, automatic recording and model installation are excluded.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base. A Mac CI execution lane is not verified; do not accept a Linux test skip as native coverage.

Planning size estimate: 1,100 non-test lines; 2,600 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.

Ordered fallback if the change approaches/exceeds budget:

1. `recfn/desktop/macos`: Land permission/source/capture ownership and disposal with native fixtures.
2. `recfn/desktop/src`: Bind visible start/stop/local-only states to that merged lifecycle and integration fixtures.


---

# PLAN-I01: Propagate workflow, release and tool-call correlation through LogFn

Status: proposed Backlog issue; not published or queued.

## Outcome

Propagate workflow, release and tool-call correlation through LogFn.

## Trigger and behavior

A bounded shared event envelope links trace/span, workflow/job, release and tool-call IDs using existing observability contracts.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `logfn/typescript/src`, `logfn/python/logfn`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Remote logging stays opt-in.
- No raw request bodies, prompts or credentials in the correlation envelope.

## Acceptance evidence

- A bounded shared event envelope links trace/span, workflow/job, release and tool-call IDs using existing observability contracts.
- Redaction precedes sink delivery and retry/export; TS/Python fixtures preserve the same declared wire fields.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux
- Python 3.11 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-OPERATIONS and is not claimed by this issue.

## Dependencies

SFNS-21

Hierarchy parent: PLAN-I. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 750 non-test lines; 1,700 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-I02: Build a read-only incident evidence projection

Status: proposed Backlog issue; not published or queued.

## Outcome

Build a read-only incident evidence projection.

## Trigger and behavior

A scoped query joins bounded event/deployment references and returns observations, proposed hypotheses and missing/contradicting evidence separately.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `watchfn/typescript/src/query`, `watchfn/typescript/src/http`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- A scoped query joins bounded event/deployment references and returns observations, proposed hypotheses and missing/contradicting evidence separately.
- Authorization, pagination and incomplete source states are enforced; no hypothesis can execute a remediation action.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-OPERATIONS and is not claimed by this issue.

## Dependencies

PLAN-I01, SFNS-22

Hierarchy parent: PLAN-I. Parent linkage is not a dependency.

## Exclusions

- The minimal event runtime remains SFNS-22; SDK-specific feedback remains SFNS-24.
- Full APM/RUM/collector product ports require separate prerequisite decisions.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready.

Planning size estimate: 850 non-test lines; 1,900 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-I03: Collect revisioned compliance evidence through scoped integrations

Status: proposed Backlog issue; not published or queued.

## Outcome

Collect revisioned compliance evidence through scoped integrations.

## Trigger and behavior

A closed collector set reads repository settings and deployment receipts through explicitly registered connections and records source account, scope, timestamp, expiry and control linkage.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `compfn/core`, `plugfn/core/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Read-only collectors; no generated assertion of certification.
- Initial collector grammar is fixed to declared fields and evidence types; extensions go to PLAN-I-HARDENING.

## Acceptance evidence

- A closed collector set reads repository settings and deployment receipts through explicitly registered connections and records source account, scope, timestamp, expiry and control linkage.
- Revocation prevents refresh; stale/incomplete data cannot be exported as current evidence.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-COMPLIANCE and is not claimed by this issue.

## Dependencies

PLAN-A05, GATE-compfn

Hierarchy parent: PLAN-I. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 950 non-test lines; 2,200 total lines; at most 2 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-I04: Record stable experiment exposure and holdout assignments

Status: proposed Backlog issue; not published or queued.

## Outcome

Record stable experiment exposure and holdout assignments.

## Trigger and behavior

A fixed flag revision and subject produce deterministic exposure/holdout assignments across the selected supported language implementations.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `userfn/typescript/src`, `userfn/python/userfn`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Opt-in; existing public defaults remain compatible.
- Caller scope is resolved at the trusted boundary; input data cannot select another tenant, account or environment.
- Failure, cancellation and incomplete evidence are represented explicitly; no automatic external mutation is introduced.

## Acceptance evidence

- A fixed flag revision and subject produce deterministic exposure/holdout assignments across the selected supported language implementations.
- Exposure receipts carry scope, flag/config revision and timestamp without raw identity; duplicate events have bounded semantics.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux
- Python 3.11 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-EXPERIMENT and is not claimed by this issue.

## Dependencies

BASE-01, GATE-userfn

Hierarchy parent: SFO-40. Parent linkage is not a dependency.

## Exclusions

- User identity/cohort/config baseline remains SFO-40; access orchestration remains SFO-39.
- No new product analytics backend or automatic flag rollout.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 850 non-test lines; 1,900 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.


---

# PLAN-I05: Report rollout guardrail breaches without claiming causality

Status: proposed Backlog issue; not published or queued.

## Outcome

Report rollout guardrail breaches without claiming causality.

## Trigger and behavior

A fixed query/metric definition reports observed outcomes and configured threshold breaches with exposure/version context.

## Scope and owned boundary

Implement the title’s single behavior in the owned paths. Tests, exports, docs and minimal package/workspace wiring needed for that behavior are included; unrelated adapters and migrations are excluded.

Owned paths: `userfn/typescript/src`, `userfn/admin/src`.

## Interfaces and invariants

- Reuse existing function-owned contracts and shared database/HTTP/auth abstractions; add only the narrow named contract in this issue.

## Decisions and defaults

- Read-only recommendations by default; no automatic promotion or rollback.
- Sequential statistical inference and warehouse-provider selection require a separately approved method/adapter.

## Acceptance evidence

- A fixed query/metric definition reports observed outcomes and configured threshold breaches with exposure/version context.
- Missing denominators, sample mismatch and incomplete windows are visible; no observational change is labeled causal.

## Verification and platforms

Unit and local integration/contract tests with fixtures or fakes; clean package import/build where public exports change.

- Node.js 22 on Ubuntu Linux

- Exclusion: No unlisted native platform or live provider behavior is claimed.

External acceptance is deferred to PLAN-QA-EXPERIMENT and is not claimed by this issue.

## Dependencies

PLAN-I04, GATE-userfn

Hierarchy parent: SFO-40. Parent linkage is not a dependency.

## Exclusions

- No production deployment, registry publication or automatic dispatch.
- No unrelated function migration or redesign.

## Migration, rollout and rollback

Additive opt-in contract. Preserve existing data and public compatibility; rollback disables/reverts the new path. Any additive storage migration must be repeatable and document its compatibility window; never delete historical evidence on code rollback.

## Readiness

needs decision: The target-base health gate BASE-01 is unresolved; this draft is not dispatch-ready. Resolve the absent-function prerequisite by a bounded port plan, a later phase, or an explicitly chosen different base.

Planning size estimate: 750 non-test lines; 1,700 total lines; at most 1 owned subsystems. Generated files, schemas, snapshots and lockfile churn count as non-test lines. These are scope estimates, not Linear estimates or commitments.

At least one function is absent from dev; its explicit GATE or existing port issue must resolve before this draft can execute.
