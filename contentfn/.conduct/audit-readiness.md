# ContentFn queryable audit checkpoint — 2026-10-23

SPEC audit-log requirement now has a durable server API implementation. Successful mutating endpoints append action, dataset, trusted actor subject, action-specific target IDs and timestamp inside the mutation database transaction. Failed operations do not append. HTTP idempotent replay does not duplicate records. Scheduled publication writes a system:scheduler audit record in the publication transaction. The scheduling operation retains its requesting actor.

Schema discovery is version 3 and includes contentfn_audit. Existing deployments must run additive migrations before switching server code. Records survive dataset deletion/name reuse. The new authorized POST /contentfn/audit/query, server API and typed client require a dataset and support optional action filtering and bounded offset pages (default100, maximum1000). Status advertises content.audit. Queries deliberately do not require a live dataset so deletion evidence remains accessible; authorization must govern historical access.

Targets are selected per action, preferring generated/normalized result IDs. Ignored input fields cannot forge unrelated targets. Request bodies, content and credentials are not logged. Direct internal storage imports and external DB writes are outside the server audit boundary. Successful no-ops are operations and produce records. Offset pagination is not a concurrent-write snapshot. Retention/tamper-proof storage are not implemented. External asset bytes cannot be rolled back with DB metadata and require backend orphan handling; no cross-resource atomicity claim is made.

## Validation

- Node22 core21/server193/client5/admin1 tests pass; server retains two existing optional-provider skips. All four package typechecks and builds pass.
- Actual file-backed SQLite audit records survive close/reopen and dataset deletion. An injected SQLite audit-write failure rolls back document/revision/event writes. HTTP idempotent replay records once. Real local HTTP verifies dataset authorization, denied direct access, page bounds and pagination. Scheduler records once with system actor. Ignored extra assetId cannot contaminate a document target list.
- Fresh isolated npm tarball consumers pass on exact Node20.19.0: ESM/CJS exports, real client/server HTTP audit query, CRUD, SSE/query snapshot, CLI, strict NodeNext declarations, schema3 discovery. Admin consumer passes. Core/client and CLI compatibility also passes on exact Node18.18.0. All three normal installs and production dependency audits pass (zero vulnerabilities at execution).
- Initial native suite invocation under default Node20 hit the preexisting installed SQLite Node22 ABI mismatch; rerunning with the matching Node22 executable passed all native tests. No package binary/dependency changes were needed.

Receipts: /tmp/content-audit-{full,types,build,packed}.log. Fresh consumer fixtures were removed after copying their install/audit receipts. Full ContentFn readiness, hosted CI and deployed acceptance remain open; no release, deployment or external provider send occurred.
