# Operation-scoped HTTP authentication

2026-10-23. TypeScript WatchFn now accepts the shared AuthProvider contract and
validates returned sessions with the shared isAuthSession predicate. Explicit
watchfn:ingest, watchfn:query and watchfn:issues:status scopes separate browser
submission from operator reads. Provider auth precedes body parsing, expired
sessions reject, and missing scopes deny. Configuring a provider disables legacy
key fallback; disabled providers reject construction. Existing configurations
retain compatibility. No duplicate auth abstraction or new transport is added.

Validation:62 HTTP tests (10 new), all234 SDK tests, strict source types and
CJS/ESM/declaration build pass. A new test's initial syntax error was corrected
before the successful run. Native CatchFn combined acceptance uses a real Chrome
browser credential with ingest/status scopes, proves query403, and completes
masked annotated upload, postcommit503 retry, actualWatchHTTP/nativeSQLite,
BotFn local-provider issue link, retention and reopen. Provider credentials remain
fixture-local; no external provider request occurs. Logs /tmp/watch-auth-tests.log,
/tmp/watch-auth-full.log, /tmp/watch-auth-types.log, /tmp/watch-auth-build.log,
and /tmp/watch-catch-scoped-native.log.

Fresh normal npm11 installation of five local tarballs passes ESM import and
synchronous CommonJS require consumers, each exercising ingestion and separated
query authority. Shared auth runtime is bundled for Node20 CommonJS compatibility;
public declarations include the shared contract. The fixture removes its temporary
consumer in finally. Log /tmp/watch-auth-packed.log. No package is published.

This is operation-level authority, not tenant/app isolation or a completed key
management service. resourceIds and tenant metadata do not constrain query/status
reads; trusted deployments still need appropriate storage separation. Host owns
provider deadlines/revocation/rotation, origin controls and rate limits. Health is
public and programmatic calls are trusted. Python inspected: its HTTP routes still
lack auth and substantive query parity, explicitly not certified by this change.
The development installation reports29 advisories; no clean-development-audit
claim. No provider deployment, registry release or base merge is performed.
