# Audit producer integration — 2026-10-23

Implements the event-query portion of original AUDIT-001/DESK-001 against the
actual ContentFn audit API, including the phase plan's timestamp-descending,
identity-ascending order. This is not completion of the entire audit requirement.

## Producer prerequisite and public behavior

Deploy ContentFn ordering checkpoint
`bb1d7409bce0e444328a111afc99c5e9e7fc5761` before using this CmsFn consumer. It adds
`AuditQuery.order: "asc" | "desc"`, defaults to existing ascending timestamps and
retains ascending ID ties. The prerequisite is a separate ContentFn commit;
there is no base-branch merge or dependency/lockfile change in this CmsFn slice.
Older producer versions that ignore the order option are not validated.

`POST /cmsfn/audit/events` now calls the supported
`POST /contentfn/audit/query`, requesting descending order. The producer's record
ID becomes `eventId`, action becomes `type`, and timestamp, target IDs and optional
actor subject are projected. `targetIds` is an additive optional core type field
and is rendered by the Studio event pane. ContentFn mutation actions such as
`docs.publish` are exposed as-is. The consumer does not invent document types,
revisions or changed paths absent from this producer contract, and never fetches
full documents to decorate audit records.

The existing `{events,nextCursor}` response shape is retained. Cursors encode a
version, dataset, descending order and offset; malformed, wrong-dataset and
wrong-order cursors are rejected. These are opaque position tokens, not signed
credentials or authorization grants. Limits are integers from 1 to 1000; returned
page size and next-offset progression are validated. Offset pagination is
ordered for a stable dataset, not a snapshot across concurrent insertions.

## Authorization and resource boundaries

Both CmsFn audit routes now require configured, successful `audit.read` role
resolution and a server-configured dataset. Missing, denied, malformed or
throwing identity resolution fails closed; optional handler-level authorization
is an additional strict-true veto. JSON input uses the existing shared bounded
reader with a 64 KiB limit. Optional limit/cursor values are validated instead of
silently coerced or dropped.

For the event query, `CmsfnServerConfig.contentfnAuditHeaders(req)` optionally
supplies trusted server-owned upstream headers after local authorization. Use a
service credential or explicitly derived trusted subject. Browser credentials
are never copied implicitly. Missing/denied upstream authorization remains an
error, not a successful empty page. The callback applies to the supported audit
event query; it does not establish global credential forwarding for other APIs.

Audit transports reject redirects, bound decoded response bytes to 1 MiB before
JSON parsing and apply a 10-second fetch/body deadline. Valid audit records are
projected to known metadata fields; malformed records, wrong datasets, envelopes,
HTTP failures and inconsistent pagination fail the page. Audit errors also use a
generic message and retain only canonical code plus upstream code/status, so
upstream error messages/details cannot echo raw document bodies through this API.
Other ContentFn consumers keep their previous error-detail behavior.

## Verification and limits

- CmsFn core: **46 tests** and typecheck pass. Server: **98 tests in 15 files**,
  typecheck, ESM/CJS and declaration build pass. New boundary tests cover missing,
  denied and throwing roles, dataset and cursor mismatch, trusted headers,
  malformed/oversized requests, declared/chunked oversized responses, invalid
  record/page shapes, upstream denials, error-detail projection, redirect refusal
  and stalled body cancellation. An unchanged status test encountered one
  `UND_ERR_SOCKET` failure; the full repeated suite passed. Both receipts remain.
- The exact copied Studio audit panes/tests pass **4 React/jsdom tests** plus
  strict subset typing in a disposable normal install. This verifies target
  rendering, not whole-Studio packaging or browser acceptance. Studio is not in
  this checkout's root workspace graph. An initial `--workspace=cmsfn` invocation
  selected the broader directory and hit existing admin missing built modules;
  later core/server commands use exact workspace paths. No unrelated admin or
  root metadata changes were made.
- Fresh locally packed CmsFn 0.0.2 and ContentFn 0.2.0 plus their actual built
  dependency closure were normally installed with npm 11.21.0. The committed
  `audit-http-acceptance.mjs`, copied outside both source trees, passes on exact
  Node 20.19.0. It exercises actual CmsFn HTTP → authorized ContentFn schema-3
  query → shared memory storage over three pages, compares producer/consumer
  order and identities, verifies actor/targets without document bodies, and
  checks local denial, upstream denial, absent browser credential forwarding and
  unsupported webhook error behavior. Installed strict NodeNext consumer types
  accept both the new trusted-header hook and ContentFn descending query.
- A separate production-only fresh installation repeats actual HTTP acceptance
  and reports **zero production audit vulnerabilities**. The combined UI-test
  fixture reports existing Vitest/mocker/tinypool advisories: installing its old
  test runner satisfies the shared DB package's optional Vitest peer, causing
  those packages to appear in `--omit=dev` output there. This does not establish
  a clean test-tooling audit; no force upgrade or dependency bypass was used.
- ContentFn prerequisite: four focused audit integration tests pass on Node
  22.22.0 (matching the existing SQLite binary), including ordering/ties/defaults,
  invalid order, HTTP authorization and SQLite reopen/rollback. Server types and
  core/server/client builds pass; details are in its audit-order evidence.

Dataset-wide webhook delivery integration remains open. The actual producer has
per-hook latest-100 delivery retrieval, not the fictional dataset-wide paginated
route. This checkpoint does not combine partial lists into a complete page or
manufacture an empty success. Studio lifecycle races, scheduling, other route
boundaries, full provider/browser/Studio readiness and deployment remain separate
requirements. No release, deployment or external provider send occurred.

Receipts: `/tmp/cms-audit-{types,full,full-final,core-types,core-tests,server-build}-oct23.log`,
`/tmp/cms-audit-studio-isolated-oct23.log`,
`/tmp/cms-audit-packed-{install,final-install,http,types}-oct23.log`,
`/tmp/cms-audit-packed-prod-audit-oct23.json` (test-tooling findings),
`/tmp/cms-audit-production-{install,http}-oct23.log` and
`/tmp/cms-audit-production-audit-oct23.json` (clean production-only graph).
Owned sockets/adapters close in the fixtures. Temporary installed trees are
removed after validation; receipt logs are retained.
