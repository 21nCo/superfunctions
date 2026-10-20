# CiFn durable state checkpoint

2026-10-20, initial checkpoint `49a14e09a`. This records the initial durable-state scope, not complete durable execution or production readiness. The later [dispatch checkpoint](durable-dispatch-readiness.md) supersedes the initial no-replay limitation for newly prepared root jobs; the remaining execution and provider gates stay open.

## Behavior

`DatabaseStore` implements the asynchronous `ControlPlaneStore` contract using `@superfunctions/db`. It internally wraps the incoming adapter with CiFn's `cifn_state` schema; application callers do not supply `adapterSchema`. Existing synchronous `MemoryStore` calls remain available. HTTP, webhook, cron, and runner registration consumers await store operations before using their results.

One versioned record stores each run, its original normalized pipeline definition, jobs, steps, artifact references, and secret redaction values. Runner records preserve labels, last-seen time and the existing password hash, never the raw runner secret. Each update uses a revision predicate and checks the affected-row count; independent connections cannot silently overwrite each other's mutations. Conflicts retry at most 16 times and then fail. Namespaces constrain record lookup and bounded keyset pagination, including tied timestamps.

All record payloads use AES-256-GCM with a fresh IV and authenticated record identity, namespace, kind, status, timestamp and revision. Selection metadata remains visible in the database. Wrong keys, altered ciphertext or authenticated metadata fail closed. An encrypted schema sentinel checks the namespace's key and version on open. Missing sentinel with existing records requires explicit repair. This is authenticated encryption, not protection against an attacker deleting records or rolling back a database backup.

`listRecoveryCandidates()` inventories queued/running runs and their retained definitions. It does not replay jobs, reset statuses, claim a lease, or assert that an external side effect did not already execute. Its definitions are privileged application data; ordinary HTTP run responses omit them and stored redaction values.

## Runtime configuration and migration

The server defaults to development-only memory storage. Opt into SQLite with:

```sh
CIFN_STORE_ADAPTER=sqlite
CIFN_SQLITE_PATH=/persistent/volume/cifn.sqlite
CIFN_STORE_NAMESPACE=default
CIFN_STORE_ENCRYPTION_KEY=<canonical base64 encoding of an independently supplied 32-byte key>
```

`CIFN_RUNNER_REGISTRATION_TOKEN`, API credentials and service adapter settings still apply. The deployment must supply, protect and back up the encryption key separately from the database. CiFn never generates or persists it and never falls back to memory on an error. Losing the key loses access to encrypted records. Key rotation and migration require an explicit offline procedure; automatic rotation, previous-key fallback, and import of prior in-memory runs are not implemented.

The SQLite runtime uses optional `better-sqlite3` and `kysely` dependencies and requires Node 20+ with a working native SQLite binding. An install omitting optional dependencies cannot use SQLite mode. Invalid configuration or missing drivers fail startup. The parent directory must exist and the file must be on persistent storage. `:memory:` and SQLite file URI paths are rejected. Runtime applies the exported `CIFN_SQLITE_SCHEMA` v1 DDL, enables WAL, synchronous FULL and a 5-second busy timeout, then creates a shared Kysely adapter. Existing tables are not rewritten. Incompatible existing schemas must be explicitly migrated before startup. Generic `DatabaseStore.open()` accepts an already provisioned persistent shared adapter; other SQL dialects and their DDL are not validated by this checkpoint.

SIGTERM/SIGINT stop the HTTP listener, drain accepted HTTP requests through Node's server close, and then close the database. Each record mutation is acknowledged before its promise resolves; a graceful shutdown is not required for already acknowledged SQLite writes. Native drivers remain external to the bundle.

## Reproducible validation

From the repository root:

```sh
npm test --workspace=./cifn/typescript/control-plane
npm run lint --workspace=./cifn/typescript/control-plane
npm run test:durable --workspace=./cifn/typescript/control-plane
npm run test:startup --workspace=./cifn/typescript/control-plane
```

Validated on Node 20.20.0 with the real better-sqlite3 native module:

- 160 tests across nine files, including eight new durable-storage cases.
- SQLite close/reopen preserves queued/running/terminal runs, jobs, steps, runner credentials, artifacts and encrypted redaction values. Reopened HTTP authentication and log redaction are exercised.
- Independent SQLite connections race record updates without lost artifacts, secrets or step statuses; only one competing terminal transition commits.
- Namespace isolation, tied-timestamp pagination, wrong keys, record tampering and missing metadata fail safely.
- A native SQLite trigger rejects inserts: run creation returns failure and does not dispatch or acknowledge the failed run.
- Strict durable/test and existing boundary TypeScript configurations use `skipLibCheck: false`; production package typecheck and CJS/ESM/declaration builds pass. The expanded strict test graph required a byte-preserving Uint8Array copy for the existing FileFn Blob upload.
- `verify-durable-startup.mjs` starts the built server, creates queued and assigned jobs, kills the process with SIGKILL, restarts against the same SQLite file, verifies job state and prior runner authentication, and scans database/WAL files and process output for plaintext test secrets. It explicitly asserts that the memory dispatch queue is empty after restart. Temporary processes and files are removed.
- Existing built-server registration/heartbeat acceptance still passes in memory mode.

## Original requirements still open

Durable records are a prerequisite, not a durable scheduler. The following remain required:

- Atomic dispatch/outbox coordination, replay after restart, idempotency, runner leases, fencing, retry/reassignment and multi-controller recovery. Persist-then-enqueue and dequeue-then-persist remain separate operations; failure between them can strand work. The default memory queue is lost after restart, and no automatic replay is attempted.
- Runner completion/event reconciliation, automatic run/job/step lifecycle propagation, cancellation delivery, and complete dependency scheduling against durable state. Existing heartbeat marks the job running but does not promote the run status.
- Durable notification delivery/outbox and actual SendFn provider acceptance; current defaults still use memory notifications and existing email integration gaps remain.
- Persistent external queue, logs, artifact and secret-provider acceptance, deployment backups and restore, key rotation/migrations, retention, concurrency/load tests and packaged-consumer matrix. SQLite crash acceptance is local process evidence, not filesystem power-loss, hosted database or production deployment evidence.
- Original cross-language, CLI, dashboard and end-to-end execution requirements remain unchanged. No Python implementation was altered or validated by this TypeScript storage slice.

### Pagination and module-consumer follow-up

Pagination boundaries use the authenticated cursor tuple even if that run changes
status between requests. A SQLite regression covers both recovery pages and
status-filtered run pages; the durable suite now has nine cases.
`node scripts/verify-module-consumers.mjs` runs independent CJS and ESM consumer
processes against built entrypoints and exercises pipeline validation, schema
exports and app construction. The Ajv ESM import includes its `.js` extension;
the ESM bundle supplies Node `createRequire` for bundled CommonJS dependencies.
These probes use the installed workspace dependency graph, not a fresh installed
npm tarball graph. Both module probes and the built SQLite restart probe pass.
