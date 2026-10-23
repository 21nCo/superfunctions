# TypeScript durable SES alert delivery

Scope: built-in public email channel using the existing SendFn AWS SES transport,
with durable claims and conservative delivery outcomes. This is a checkpoint in
the original full readiness scope, not a declaration that all requirements pass.

## Prerequisite provenance

Origin/dev SendFn PR https://github.com/21nCo/superfunctions/pull/257, source commit
89cae9df462f2f7b03115d400b878223d68c3092, supplies the dedicated SES entry point,
one SDK attempt, abort/deadline ownership, response cap, valid receipt requirement
and admission-closed transport drain. The scoped sf-next port also retains the
current origin SES file's MIME sender encoding, safe attachment fields and bare
address helper. Unrelated connected-mailbox, SNS and push changes are not imported.
No next-only history is sent to origin. Origin commit contains no .conduct files.

Prerequisite acceptance: 130 full SendFn tests/types/build, final 13 owned HTTP
lifecycle tests (including observed socket closure before forced fixture cleanup),
5-package Turbo build, fresh five-tarball typed ESM/CJS consumers against the
resolved SDK range and earliest published matching version 3.405.0. Exact 3.400.0
was never published; the attempted install failed ETARGET and is retained in the
local diagnostic log. SDK dependency floor and higher-level SendFn retry policy
remain unchanged. Consumer fixtures use local static test credentials only.

## Watch behavior

Trusted host email configuration is validated and copied. The optional transport
is imported before a pending job is claimed. Missing installation/configuration
cannot consume an attempt or discharge an obligation. Real SES sends occur only
after the durable CAS claim. Success requires a nonempty SES receipt; all ambiguous
failures park unknown with pending accounting retained across restart. No blind
retry, idempotency header or SES deduplication claim is introduced.

Each send owns an adapter and awaits close even on timeout. Cleanup failure remains
an explicit host-operation error and retains the lease rather than settling a
false clean outcome. Transport deadlines depend on a responsive event loop.
Subjects are sanitized, HTML escaped and bare addresses/50-recipient limits
validated. Public projections omit credentials and recipients. Pending records
still contain recipients and require normal at-rest protection.

Configured metadata means host configuration, not runtime provider health.
Legacy custom senders remain overrides with cooperative cancellation only.
Namespaces retain the ts-v3 protocol and existing stopped-writer/migration rules.
Retention is host-driven; unresolved obligations are never automatically pruned.

## Validation

- Watch full suite: 279 tests / 28 files passed (Node 20.20.0), including nine
  owned HTTP/native SQLite cases for independent workers, reopen, missing transport,
  lost/empty/stalled/oversized response, pre-claim validation, privacy, shutdown and
  cleanup-failure lease retention. Typechecking passed.
- Turbo dependency build: 12 tasks passed. The public declarations contain no
  SendFn import, preserving optional-peer type usability.
- Fresh seven-tarball normal npm 11 consumer (Node 22.22.0): strict typed ESM/CJS
  actual built-in SES, PagerDuty and retention/migration flows passed. Accepted-then-
  dropped SES response remained pending and was not replayed. Removing the optional
  SendFn installation still allowed importing Watch; dispatch failed before claim
  and left the obligation pending. Typed consumer passed without that peer too.
- Ported SendFn: 13 SES lifecycle cases passed. Its broader sf-next suite reports
  15 failures / 63 passes because legacy mock adapters omit capabilities required by
  the current shared schema wrapper. An untouched HEAD archive against the same
  shared package reproduced exactly 15 failures / 50 passes. This preexisting fixture
  incompatibility remains visible; it is not a passing full SendFn suite. The origin
  prerequisite's current fixtures passed all 130 tests separately.
- Normal workspace install regenerated only the narrow Watch optional peer/dev edge
  in the root lock. No dependency versions, .gitignore, Python files or schema were
  changed. An initial command used nonexistent Watch `typecheck`; the actual `lint`
  typecheck script subsequently passed. `npm -w sendfn` also selected the existing
  empty admin test workspace; it was not treated as product acceptance.

Local logs: `/tmp/watch-ts-email-{types,focused,full,sendfn-tests,sendfn-baseline,build,installed}.log`.
Owned baseline archive and installed consumer directories were removed; all owned
runners and HTTP servers exited. Workspace dependencies were installed normally,
with no temporary dependency links. No real SES/provider requests, deployments,
releases or base merges were performed. Existing audit/overall readiness gaps are
not claimed closed by these checks.
