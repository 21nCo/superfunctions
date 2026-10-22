# Attachment upload validation and native acceptance

Large inline attachments use the configured `uploadAttachment` callback. A missing,
empty, whitespace-only or null receipt URL previously allowed some captures to lose
their inline bytes without obtaining a usable reference. Capture now rejects these
receipts before deleting inline bytes or delivering the report. Existing validation
still requires HTTP(S) URLs without embedded credentials.

Validation on 2026-10-22:

- Four receipt regressions failed before the fix and pass afterwards.
- All 107 SDK tests across 10 files pass, along with SDK/admin typechecks and SDK
  runtime/declaration builds.
- `typescript/scripts/attachment-acceptance.mjs` uses the built SDK in Node and
  actual installed Chrome, a local authenticated upload endpoint, private temporary
  files, actual WatchFn HTTP routes and native SQLite. Both environments upload
  deterministic 96 KiB binary blobs; fetched stored bytes match exactly and report
  references survive SQLite close/reopen.
- A failed ingestion followed by `CatchFnDeliveryError.retry()` uploads only once.
  Upload 401, 413 and 503 responses and an invalid success receipt prevent ingestion.
  The fixture removes its browser, HTTP server, database and uploaded files.

Reproduction after building CatchFn, WatchFn browser/core and shared DB:

```sh
CATCHFN_WATCH_CORE=/absolute/path/to/watchfn/typescript/dist/index.mjs \
  node catchfn/typescript/scripts/attachment-acceptance.mjs
```

The acceptance requires local better-sqlite3, Kysely, esbuild, Playwright and Chrome.
This run used the WatchFn prerequisite checkout's built core. It proves configured
upload callback behavior, not a hosted storage provider or a combined masked and
annotated screenshot upload flow. Existing reporter acceptance separately covers
masking and annotation. The fixture's request buffering is test-only, not a
production upload endpoint. Applications still own upload authorization, bounded
ingress/timeouts, storage access and orphan cleanup; CatchFn cannot undo remote
storage after an invalid receipt or later ingestion failure. Broader original
readiness requirements remain open.
