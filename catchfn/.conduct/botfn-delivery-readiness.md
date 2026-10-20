# Canonical CatchFn to BotFn issue delivery

This checkpoint connects the original canonical CatchFn bug-report path to WatchFn's transactional issue outbox and actual BotFn provider clients. It does not route through the separate flat-report persistence service.

## Client and server contract

`CatchFnConfig.integration` supplies an optional default `{target?, project?}` hint; `captureBug({integration})` overrides it per report. The event and canonical envelope retain that hint. The server chooses only a configured app/target/project route. Client options reject unsupported target values, empty/oversized projects, arbitrary extra fields and provider credentials. Provider keys and clients belong only in WatchFn server configuration. Server linkage fields remain supported on returned reports from an injected client, but are not accepted as creation hints.

A 202 acknowledgment means the canonical event and outbox entry are committed, not that a provider issue exists. Delivery is explicit server work. Exact replay under the enabled outbox deduplicates by namespace/app/report ID and immutable content; modified content conflicts. Original retry closures retain the ID/envelope. Without this opt-in Watch integration, existing generic arrival semantics remain at least once.

The Watch API key authorizes both ingestion and query and every route in its deployment. This is one trusted application boundary, not per-app/tenant authorization. Use an authenticated app-backend proxy if the full Watch key is unsuitable for browser exposure. Outbox namespaces do not make Watch queries tenant-isolated. Provider credentials stay server-side. Privileged delivery/status/reconciliation methods require host/operator access control if exposed remotely.

The TypeScript browser SDK is the canonical client described by this original specification. Existing Python code is the separate flat-report server contract, not a canonical Watch transport SDK; it remains unchanged and does not gain or claim BotFn delivery from this change.

## Validation

- CatchFn TypeScript SDK: 92 tests across 9 files pass, including default/override hint preservation, no false issue acknowledgment and malformed/credential-hint rejection. Source typecheck and dual-format/declaration build pass.
- `node catchfn/typescript/scripts/botfn-acceptance.mjs` passes using the built Catch SDK, actual shared Watch browser transport, built Watch core, real loopback HTTP, actual native SQLite and the actual BotFn GitHub client bundled from source. An ordinary PKCS#1 RSA PEM produces a verified JWT for an installation-token request before issue creation.
- The same acceptance launches installed Chrome and submits through the actual browser CatchFn SDK into Watch HTTP. It verifies pending acknowledgment without an invented link, authenticated routing, server delivery and persisted provider linkage.
- A dropped intake response triggers identical canonical replay and stores exactly one event/outbox. Pending state survives database close/reopen before delivery. Both Node and browser reports retain linkage across another close/reopen. Wrong API keys and unconfigured repository hints fail; redacted context persists without being included in provider issue text. Reprocessing linked rows sends no additional creates.
- Existing canonical HTTP/SQLite acceptance and actual Chrome cross-origin delivery acceptance pass unchanged with the integration disabled, retaining documented at-least-once semantics. The separate TypeScript flat-report server's four contract tests also pass; it remains outside issue delivery.
- Watch's separate native acceptance covers both actual GitHub and Linear request clients, two-connection claims, transaction rollback, lost provider response and verified reconciliation after reopening. See `watchfn/.conduct/botfn-issue-readiness.md` for exact scope.

Reproduction requires built shared DB, Watch browser/core and Catch SDK plus local `better-sqlite3`, `kysely`, esbuild, Playwright and Chrome. The acceptance script supports `CATCHFN_WATCH_CORE=/absolute/path/to/dist/index.mjs`. This run used the built Watch artifact from the identical merged Watch commit in the sibling readiness checkout: the Catch tree's intentionally scoped install lacks optional HTTP-adapter packages required by the full Watch multi-entry build. Catch's own SDK builds/types pass; the full Watch build and fresh packed matrix were validated in its own checkout. No dependency or lockfile changes were needed.

## Remaining original gates

No hosted issue or message was created. Local protocol fixtures exercise real clients and authentication code, not live GitHub installation permissions, Linear workspace access or provider reliability. The original hosted-provider acceptance, per-tenant query/auth design, scalable event query indexing, production worker/retention operations, BotFn package deployment and v1.1 closed-issue synchronization remain open.

The reporter can show a link returned immediately by an injected client, but does not automatically poll for a link created later by the outbox worker. Application-specific status UI/authorized polling remains open. Linear's current request interface cannot cancel the underlying operation and both existing provider clients parse full response JSON; Watch's wait timeout is not a universal transport/memory bound. Unknown provider outcomes are parked for verified operator reconciliation and are never automatically recreated. This is a tested canonical integration checkpoint, not full CatchFn/WatchFn/BotFn readiness.
