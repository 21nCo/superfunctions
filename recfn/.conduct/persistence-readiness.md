# RecFn persistence boundary — 2026-10-19

This slice implements the shared database boundary from the original phase 00 and TV-ARCH-001 requirements. It does not establish overall production readiness.

## Behavior

- `createDbStore` owns `wrapWithSchema(adapter, getRecFnSchema())`. Applications supply a normal shared adapter; `adapterSchema` is not required.
- Durability defaults false. A caller must explicitly assert that its configured backend persists across restarts. The built-in memory adapter rejects `durable: true`, including when its display name is overridden. The existing production guard remains in place.
- Schema metadata declares JSON text and ISO date text, preserving structured runtime values and canonical ISO timestamps. Meeting metadata has a unique namespace/bot index. Participant, metadata, and calendar mapping upserts use explicit conflict targets.
- Shared dependency versions now resolve to the local shared stack rather than stale nested DB/HTTP/storage/middleware packages. The root lock changes only the RecFn server dependency closure.

## Native SQLite evidence

`server/__tests__/db-sqlite.test.ts` creates an actual file-backed better-sqlite3 database, applies tables/indexes from the exported schema, and uses the shared Kysely adapter without caller schema configuration. It writes bots, recordings, transcripts, participants, chat, metadata, webhooks, calendars, and event/bot mappings; closes the adapter; opens a new database connection and store; and verifies aggregate content, nested JSON, Unicode, canonical dates, boolean values, upsert updates, and namespace isolation. It deletes a bot aggregate, closes/reopens again, verifies deletion and retention of another namespace, and checks that an actual missing-table error propagates. Temporary databases are removed in finally.

The existing memory test now explicitly describes reuse across store instances; it is not durability evidence. SQLite close/reopen proves persistence across connections, but this test does not restart a server process, exercise crash recovery, validate a hosted database, or certify production backups.

## Validation

- Node 20.20.0, npm 10.8.2; lock regenerated with npm 11 and scoped clean installation completed with npm 10. Native better-sqlite3 and esbuild rebuild passed.
- Shared DB build and complete suite: **220 tests passed in 22 files**. Prerequisite commits: `517a4f8d0` (Kysely conflict targets/returning) and `1073a1329` (declared SQLite boolean codecs).
- `npm test -w @recfn/server -- __tests__/db-store.test.ts __tests__/db-sqlite.test.ts __tests__/api-recordings.test.ts __tests__/storage-adapter.test.ts`: **20 tests passed in 4 files**.
- Scoped strict TypeScript check for `server/src/store/db.ts` and `server/src/store/schema.ts`: passed (`--noEmit --target ES2022 --module ESNext --moduleResolution bundler --strict --skipLibCheck --esModuleInterop`).
- Complete dependency builds reach the server, which fails at unchanged `server/src/webhooks/deliver.ts:37`: the consumer passes `fetch`, but shared `WebhookDeliveryOptions` intentionally has no custom-fetch option. Both source files match base `9b841ff4a`. No shared transport behavior was changed here.
- Full server suite after dependency builds: **206 passed, 5 failed (211 tests, 39 files)**. Failures are the existing injected-fetch expectations in `participant-tracking.test.ts` (one) and `webhook-delivery.test.ts` (four), consistent with that stale webhook seam. The recording timestamp assertion was updated for the shared codec's canonical ISO output.
- Build/test transcripts during this run: `/tmp/recfn-build.log`, `/tmp/recfn-server-tests-final.log`; these temporary logs are not committed evidence dependencies.

## Remaining gates

Existing installations require an explicit migration for JSON/date text representations and the unique metadata index; duplicate namespace/bot metadata must be resolved first. Automatic migration and rollback were not implemented. PostgreSQL, MySQL, Drizzle, and Prisma persistence are unvalidated. The native fixture creates schema directly through Kysely and is not a deployment migration runner. Full server build/tests remain blocked by the webhook consumer seam above. The Python tree is an HTTP/WebSocket client, not another persistence implementation; Python transport tests and cross-language live server acceptance were not run in this slice. Real meeting capture, ASR providers, distributed queue/storage, server process restart, and production deployment remain outside this evidence.
