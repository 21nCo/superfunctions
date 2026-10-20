# Signed durable flag configuration service

2026-10-20. Implements the original specification's server storage and signed/
ETagged configuration publication boundary, reusing the shared HTTP/auth/database
abstractions. It does not complete the original flag SDK/analytics requirements.

## Behavior and storage

Optional host-provided Ed25519 private key and explicit key ID enable authenticated
`GET/PUT /config/:environment`. Readers and publishers require separate
`userfn:config:read/write` scopes. Trusted auth resolves tenant identity; payloads
cannot choose it. Permissions cover that tenant's environments. The function
wraps incoming adapters with its own schema, including the new
`userfn_flag_config` table. Hosts must migrate this table before enabling routes.
No adapterSchema escape hatch is required.

Complete flags/segments are runtime validated before storage, using the SDK flag
validator and existing supported segment constraints. JSON depth, canonical byte
size and item counts are bounded, in addition to the shared streamed request
limit. Malformed input cannot replace the current snapshot. Read and publish
operations authenticate before consuming the body.

Create requires If-None-Match:*; replacement requires the exact prior strong
If-Match value. Atomic database transactions and conditional update counts select
one winner. Missing conditions return 428; stale/conflicting conditions return 412.
Initial creation is protected by the table's unique identity. The current row
contains canonical wire bytes, ETag and signature; no private key is stored.
This is latest-version storage, not immutable revision-history storage.

Signatures cover exact UTF-8 response bytes, including fixed version/algorithm,
tenant, environment, UUID revision and signing-key identity. ETag hashes the same
bytes. A verifier must use an out-of-band trusted public-key map, reject unknown
key/algorithm/version, verify exact bytes and check expected tenant/environment.
Conditional 304 responses reuse a previously verified snapshot; they do not
replace signature verification. Responses are private/revalidated and vary on
Authorization. Key rotation preserves old stored signatures until republishing.

## Evidence

- Seven real local HTTP acceptance cases against actual file-backed SQLite through
  the shared Kysely adapter: signed byte/tamper verification, ETag/304, tenant and
  scope isolation, SQLite close/reopen, and competing writes through two separate
  SQLite connections (one 200/one 412; initial create one 201/one 412).
- Malformed JSON/config, missing/stale/invalid conditional headers and streamed
  oversized bodies reject without changing the accepted snapshot. Invalid signing
  configuration fails at construction. CORS exposes the conditional/signature
  headers only for configured origins.
- TS client evaluates the delivered flags/segments. Python performs real HTTP
  GET and evaluates prerequisite/environment values after explicit fixture mapping
  to native dataclasses. This fixture is not an SDK transport or verifier.
- Existing service 10 tests, native feedback 4 acceptance cases and the AuthFn
  integration case pass after the schema extension (combined native suite: 10 before the additional segment wire case; config suite: 7). Service typecheck/build pass; SDK build exposes the existing
  validator via its operator entry point. The service tarball manifest includes
  the built config runtime/types/schema. No shared source changes.

Reproduce after building the SDK and existing shared dependency closure:

```sh
npm run build --workspace userfn/typescript
npm run typecheck --workspace userfn/service
npm run build --workspace userfn/service
npm test --workspace userfn/service
npm run test:native --workspace userfn/service
```

## Installed package acceptance

`service/scripts/verify-config-package.mjs` packs six built tarballs (service,
SDK, shared DB/HTTP/auth/observability), installs them in a fresh temporary consumer
with normal npm dependency resolution, and runs actual local HTTP signed
publication/conditional fetch plus SDK evaluation. It compiles installed service
and memory-adapter declarations under strict NodeNext without skipLibCheck or peer
bypass. Both runtime and declarations passed on Node 20.20.0 with npm 11. This
package-runtime fixture uses memory storage; durable SQLite evidence is the
separate native acceptance above. Temporary directories are removed.

The initial npm10.8.2 unconstrained optional-peer resolution hit Arborist's null
`edgesOut` error while choosing the latest Vitest4 graph. npm11 resolves the
normal declared graph successfully, without extra consumer peer pins. A first
compatible pinned-matrix run also passed, but the final reproducible script does
not add Drizzle/Vitest or other artificial peers. Shared dependency manifests
were not changed. The only explicit consumer development tools are
TypeScript5.6.3 and Node22 types.

```sh
# With npm11 on PATH:
node userfn/service/scripts/verify-config-package.mjs
# Or select an existing npm11 CLI without changing the global installation:
USERFN_NPM_CLI=/absolute/path/to/npm/bin/npm-cli.js node userfn/service/scripts/verify-config-package.mjs
```

## Original gates still open

Automatic SDK config fetch/signature verification, ETag-backed client cache and
refresh scheduling, refresh failure/rollback policy, signed-key distribution and
rotation administration, WatchFn exposures and evaluation telemetry, a durable
operator-store bridge/UI, owner/tag administration, broader segment parity and
operators, edge/CDN delivery and hosted/browser/load acceptance remain open.
Existing messaging, survey, feedback source, roadmap/changelog and all other
original requirements remain in scope. This checkpoint does not claim them ready.
