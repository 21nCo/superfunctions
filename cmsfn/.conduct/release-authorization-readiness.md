# Release authorization and request boundaries

2026-10-22 UTC. Implements the original ROLE-001 release permission boundary in the four HTTP release routes. All broader CmsFn production requirements remain open.

## Behavior and migration

Create, list, add and publish now require an explicitly configured `getRolesForSubject` resolver and a valid `release.manage` role grant for the requested dataset. Missing configuration, empty/malformed roles, resolver exceptions and denied grants return the existing `PERMISSION_DENIED` envelope, without release storage access or ContentFn calls. Error details do not expose resolver exceptions. Deployments that relied on anonymous release access must configure a role resolver; `auth.kind` alone does not authenticate a request.

The HTTP server also checks its configured dataset registry. A wildcard role cannot enable an unconfigured dataset. Existing storage predicates retain dataset plus release ID ownership for add and publish. The optional internal `authorizeReleases` callback remains an additional veto, requiring literal `true`; it cannot replace role authorization. Missing identity configuration and an outer veto are rejected before consuming the body. Dataset-specific roles necessarily require reading the bounded dataset field first.

All four routes accept only a JSON object within 65,536 UTF-8 bytes. Malformed JSON and non-object bodies return `VALIDATION_FAILED`; declared or streamed overflows return `PAYLOAD_TOO_LARGE`. The Node request bridge uses the existing shared HTTP parser and does not destroy the response socket when cancelling an oversized request. The same local bridge is reused by role endpoints. This is a byte cap, not an upload deadline or a concurrent-request admission limit.

Publishing retains per-document `doc.publish` and workflow checks. A resolver exception during a later document check produces a denied document in the existing deterministic partial-success result; no publish call is made for that document. Already published documents are not rolled back. ContentFn draft retrieval still precedes the document-type authorization check, because the type comes from the draft. Actual authentication and resolver identity verification remain deployment responsibilities.

## Evidence

Node 20.20.0, native SQLite via better-sqlite3 and Kysely:

- `npm test --workspace=@cmsfn/server`: 78 tests pass in 12 files, including eight new release-boundary cases and all existing role/storage/release cases.
- New tests exercise owned real Node HTTP sockets, real SQLite tables and an owned ContentFn protocol fixture. Every route denies missing/empty/malformed/throwing authorization without DB reads, mutations or upstream requests. They cover role dataset scope, configured dataset scope even with wildcard roles, cross-dataset release IDs, retained create/list/add/publish, per-document authorization exceptions, malformed JSON, both Content-Length and chunked overflow, UTF-8 accounting and the exact byte boundary. Outer veto tests assert that no request iterator is attached.
- `node node_modules/typescript/bin/tsc -p cmsfn/server/tsconfig.roles.json`: passes, including the extracted shared request bridge.
- `npm run build --workspace=@cmsfn/server`: ESM, CJS and declarations pass.
- Freshly built ESM output served real HTTP: all four anonymous release requests denied, then configured authorized create/list/add passed.
- Full server typecheck still fails with 143 diagnostics. An isolated temporary copy of committed baseline server sources, using the same installed dependencies and core declarations, produced 145 diagnostics. The current diagnostic set adds none and removes the missing release-result import and widened release-envelope return type errors. The remaining historical diagnostics include untyped HTTP response bodies and missing ContentFn declarations. No full server typecheck pass is claimed.

Local logs: `/tmp/cms-release-all.log`, `/tmp/cms-release-build.log`, `/tmp/cms-release-built-http.log`, `/tmp/cms-release-parser-types.log`, `/tmp/cms-release-types.log`, `/tmp/cms-release-baseline-types.log`. Owned servers/databases are closed; temporary baseline source copies were removed.

## Remaining original requirements

Other HTTP route authorization/body limits, live ContentFn service integration, release scheduling, concurrent release mutation behavior, durable multi-provider storage acceptance, studio workflows, the complete package declaration matrix and the full-package typecheck remain unproven or incomplete. The owned ContentFn fixture establishes the release HTTP protocol and denial behavior, not a deployed end-to-end system. No remote publication or deployment was performed for this change.
