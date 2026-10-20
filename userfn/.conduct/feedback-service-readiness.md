# Dedicated feedback service checkpoint — 2026-10-20

## Scope delivered

The original UserFn specification requires a dedicated shared HTTP/DB service. This checkpoint replaces the endpoint's previously unused feedback path with `@userfn/service` and actual TypeScript/Python HTTP clients. The earlier injected service contract remains an explicit override, not the default backend implementation.

The service wraps a caller-provided shared DB Adapter internally with `getUserFnSchema()`, authenticates explicit bearer credentials through shared AuthProvider, requires tenant-bound read/write scopes, and awaits persistence before issuing a positive receipt. Tenant-scoped stable keys plus an actual database uniqueness constraint handle concurrent retries and response loss after commit; conflicting actor/payload reuse returns 409. Readback is tenant-filtered. Validation, request/receipt limits, bounded retry counts, cookie exclusion, redirect rejection and sanitized failures are covered.

AuthFn compatibility is explicit: its API-key session supplies actor ID and metadata scopes but no tenant. A trusted `resolveAccess` callback may map verified actor IDs to tenant/scopes. Raw missing-tenant sessions fail closed. Tests exercise that actual session shape and trusted policy mapping; they do not issue/revoke keys through a running AuthFn deployment. Client identity/traits never become the authenticated actor or authorization policy.

## Validation

Environment: Node 20.20.0; npm 10.8.2 scoped install, npm 11.21 lock generation/fresh tarball consumer; local native better-sqlite3; Python 3.9 and 3.10 through uv.

- `npm run typecheck --workspace=./userfn/typescript`: pass.
- `npm test --workspace=./userfn/typescript`: 27 tests pass across seven files.
- `npm run build --workspace=./userfn/typescript`: ESM, CJS and declarations pass.
- `npm run build --workspace=@userfn/service`: strict TypeScript/declarations pass.
- `npm test --workspace=@userfn/service`: eight service contract tests pass, including awaited writes, tenant scopes, auth failures, trusted mapping, metadata claims, bounded validation, CORS and HTTP method headers.
- `npm run test:native --workspace=@userfn/service`: one real SQLite/HTTP acceptance passes. Both SDKs submit over a local Node HTTP server into shared Kysely adapter storage without adapterSchema. The test drops a response after commit, tests same-key concurrent submissions and conflicting races, closes/reopens the SQLite connection, reads both payloads from the new service/connection, checks cross-tenant 404 and retries after reopen, then verifies a missing table produces 503. Four actual rows survive reopen. This is not memory-adapter durability evidence.
- Python `uv run --isolated --no-project --python 3.9 --with pytest python -m pytest -q`: 25 pass. The same suite passed on Python 3.10; native cross-language acceptance uses Python 3.10.
- Fresh npm-pack consumer installed local tarballs for shared observability/auth/http/db, SDK and service. Service + ESM SDK submission smoke and CJS SDK export loading pass. This smoke uses memory storage and is packaging evidence only. npm 10 first failed internally with `Cannot read properties of null (reading 'edgesOut')`; npm 11 installation succeeded. No source workaround or shared package modification was used.
- `uv build --wheel` and isolated Python 3.9 import of the built wheel pass.
- `git diff --check`: pass.

An initial `--workspace=userfn` typecheck selected the unrelated UserFn admin workspace as well and failed because its uninstalled `@superfunctions/admin` dependency was absent. The explicit SDK path and new service checks above pass. This checkpoint does not claim admin validation.

## Remaining original requirements and deployment gates

This is a feedback submission/readback checkpoint, not full UserFn readiness. Dedicated configuration delivery, feedback listing/board/voting/status updates, multi-source ingestion, snapshot workflows, offline queues, moderation, retention and broader engagement synchronization remain open. Rate limiting and deployment configuration are not included.

Production hosts must apply the exported schema, including a unique/primary key on `id`, provide durable storage, configure genuine credential verification and trusted tenant enrollment, and mount the router via a shared framework adapter. Actual AuthFn issuance, hosted DB durability, non-SQLite adapters, framework deployments, real browsers and production HTTPS have not been exercised. The local test explicitly owns schema creation and caller-owned DB/server cleanup.

Python uses stdlib HTTP on an asyncio worker. Its timeout bounds socket operations rather than a total slow-stream deadline; task cancellation does not terminate the worker or undo an accepted write. TypeScript uses an abort deadline per attempt. Both SDKs preserve a stable key during automatic retries; applications must reuse an explicit key for manual reconciliation. There is no durable offline retry queue. Client submission methods preserve their existing void/None return API; direct POST receipts and authenticated GET support service readback.

No hosted changes or publication were performed for this checkpoint.
