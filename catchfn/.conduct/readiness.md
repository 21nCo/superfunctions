# CatchFn readiness work

Target branch starts at shared prerequisite 745ea7b3c, descended from sf-next/next. CatchFn is present on sf-next/next and absent from origin/dev; local next and sf-next CatchFn trees are identical. No existing CatchFn PR was found. Original specification and implementation plan are preserved.

## Original v1 requirements and gaps

- SDK currently logs reports without sending them. Implement actual WatchFn transport with authentication, bounded retries, and ingestion validation; retain the shared transport rather than duplicating it.
- Implement reporter overlay and React helper, screenshot masking and DrawFn annotation, form fields and log consent, focus management and submission/error states.
- Complete size limits, final-hook redaction, network URL/header filtering and safe overlapping collector lifetimes.
- Implement schema-owned durable server storage, validation, filters, retention, idempotency, attachment references and optional server-side BotFn issue linking.
- Repair Python distribution/dependency, HTTP and DB contracts and validate installed wheels with actual SQLite. The scaffold's advertised Python 3.8 floor conflicts with shared Python prerequisites requiring 3.10; original support must remain an explicit gate until reconciled.
- Validate source suites, typechecks, clean install, fresh npm/wheel consumers, actual browser widget/capture and shared ingestion/persistence boundaries.

Optional v1.1 replay and issue status synchronization remain identified as future requirements by the unchanged specification; no v1 functionality is dropped.

Implementation and validation are in progress; no CatchFn PR has been created.

## Validated implementation checkpoint (2026-10-18)

- SDK: final-hook privacy and UTF-8 payload bounds, cycle-safe serialization, overlapping console/fetch collector lifecycle, URL/header filters, canonical injected-client handoff with surfaced delivery errors, explicit local/dropped/sent outcome, and large-attachment upload callback.
- Reporter: vanilla modal plus React button, opt-in floating button/hotkey, screenshot masking, DrawFn rectangle/arrow/text tools and local blur, form/log consent, keyboard trap/escape/focus restoration and honest delivery status.
- TypeScript service: own wrapped schema, durable JSON payload, scoped filters, duplicate/conflict behavior, server-time retention and authenticated shared HTTP routes. This remains the flat-report service, not the completed WatchFn datastore integration.
- Python: repaired actual shared DB/HTTP APIs, typed schema and attachment metadata, strict payload/application validation, retention/idempotency and distribution metadata. Shared prerequisites require Python 3.10; the original 3.8 floor remains unmet.

Evidence in this target checkout:

- npm 10 clean scoped install: 549 packages. CatchFn, DrawFn 0.0.2, DB 0.4.0, HTTP 0.3.1, admin 0.1.5, observability 0.0.1 and MCP 0.0.6 resolve to this worktree's source directories.
- DrawFn and CatchFn SDK/server/admin builds; SDK typecheck and 81 tests; server 4 and admin 3 tests.
- Real Chrome and Playwright WebKit 2370: masked pixel in exported screenshot, DrawFn rectangle metadata, consent omission, canonical handoff, focus restoration, hotkey/Escape and cleanup. Reproduce with `node catchfn/typescript/scripts/browser-acceptance.mjs`; optional `CATCHFN_WEBKIT_EXECUTABLE` selects an installed WebKit binary. These tests use an injected capture client and do not prove network delivery or shared ingestion.
- Python 3.10 source: 3 tests, strict mypy and Ruff. Fresh local wheels for core, SQLAlchemy and CatchFn: 3 tests each in isolated Python 3.10.19 and 3.12.12 environments, including actual SQLite close/reopen and shared HTTP contract checks. Installed module paths were verified in each wheel environment. Shared Pydantic deprecation warnings remain upstream.

## Remaining gates

- Coordinated WatchFn browser transport and ingest ownership is needed before editing those cross-function paths. Endpoint/API-key configuration, retries, ingestion validation, canonical storage in the WatchFn datastore and end-to-end delivery remain incomplete. The injected client is a compatibility boundary, not a substitute for these requirements.
- Optional server-side BotFn GitHub/Linear issue creation/linking remains unimplemented.
- Packed npm consumer: fresh npm 11 resolution followed by npm 10 clean install (45 packages), ESM SDK/server and JSON round-trip through locally packed DB, plus CJS SDK import/capture passed. All Superfunctions prerequisites were supplied as local tarballs. Earlier prefix-based installs hit npm graph errors; resolving from the real isolated consumer directory produced a valid lock. TypeScript real-SQLite, canonical cross-language round-trip and broader performance/accessibility acceptance remain open.
- Exact Python 3.8 support remains unresolved rather than silently claimed via the new shared dependency floor.
- No CatchFn PR, push, release or deployment has been performed. TestFn's native Safari and historical-engine gates remain open in PR57's readiness record.

## Native SQLite and cross-language persistence — 2026-10-20

`node catchfn/server/typescript/scripts/sqlite-acceptance.mjs` now exercises the built TypeScript service with the shared Kysely adapter and native better-sqlite3 against a temporary on-disk database. The application fixture derives SQL columns from the function-owned schema; consumers do not supply `adapterSchema`. Connections are destroyed and reopened before verifying retained JSON, application isolation, exact tag/session/replay/issue filters, idempotent retries, conflicts, and received-time retention. Cleanup is scoped and its deletion survives another reopen.

The same closed database is opened in a separate Python process through the shared SQLAlchemy adapter. Python reads the TypeScript report, preserves canonical Unicode/nested metadata/attachment annotation/extra fields, and accepts the stored report idempotently. It writes a second report, disposes its engine, and TypeScript reopens and validates that report and duplicate behavior. The fixture includes redacted credentials and verifies they remain redacted. All temporary databases and canonical payload files are removed in a finally block.

Validation on Node 20.20.0: native better-sqlite3 rebuilt successfully; server build and all 4 service tests pass. The SQLite acceptance passes with isolated Python 3.10 and Python 3.12 (`CATCHFN_PYTHON=3.12`); Python 3.10 source contract suite passes all 3 tests, with existing shared-core Pydantic deprecation warnings. Python dependencies are isolated via uv, while CatchFn/shared Python modules are loaded from this checkout. This is source/built-service integration evidence, not a fresh wheel or npm tarball acceptance. No production implementation change was required.

Reproduction prerequisites: built shared DB/CatchFn SDK/server packages, local native better-sqlite3 and Kysely, and uv. After an install with ignored scripts, run `npm rebuild better-sqlite3 --foreground-scripts`. The acceptance never uses memoryAdapter. It proves clean close/reopen persistence, not crash/power-loss durability, concurrent writers, or arbitrary payload/schema parity. Original WatchFn datastore delivery, BotFn bridge, historical Python 3.8 support, performance and broader accessibility gates remain open. No PR, push, release, or deployment was performed.

## Publication checkpoint after shared prerequisite merge — 2026-10-19 UTC

The clean CatchFn branch at `d3776b5d3` was normally merged with local shared prerequisite `d8d443a5c`, producing `bd55e4eb9`. Shared is now an ancestor. The diff against shared contains only CatchFn files, the root DrawFn workspace registration required by the reporter, and the associated CatchFn/DrawFn dependency lock closure; it contains no shared implementation changes. Local remote-tracking trees still show CatchFn present in `sf-next/next` and absent in `origin/dev`, so the destination is the sf-next repository. No remote operation was performed during this checkpoint.

Exact merged-tree checks passed:

- Shared observability and DB builds, CatchFn SDK/server/admin builds, SDK/admin typechecks.
- SDK **81 tests**, TypeScript service **4 tests**, admin **3 tests**.
- One fresh `node catchfn/server/typescript/scripts/sqlite-acceptance.mjs` run against the rebuilt shared DB: native file-backed SQLite close/reopen plus separate Python 3.10 process read/write compatibility passed.
- `git diff --check` against shared passed. The earlier real Chrome/WebKit, packed npm consumer, and Python 3.10/3.12 wheel/native receipts above were not rerun; they describe their recorded checkpoints rather than fresh acceptance of this merged tree.

No new blocking defect was discovered in this bounded check. This branch is suitable for a scoped foundations PR, not an overall readiness claim: CatchFn still delegates only to an injected `watch.client.capture` interface, lacks a built-in verified WatchFn endpoint/auth/retry integration, and its separate flat-report service is not proof of canonical WatchFn datastore persistence. BotFn issue linking, original Python 3.8 support, deployment and broader performance/accessibility gates remain open. The optional router authorization callback must be configured by the hosting application when authentication is required. No push, PR, release, or deployment was performed.
