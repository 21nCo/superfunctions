# REQUIREMENTS.md

## Table of contents
- [BUILD-001](#build-001)
- [PKG-001](#pkg-001)
- [API-001](#api-001)
- [AUTH-001](#auth-001)
- [AUTH-002](#auth-002)
- [UPLOAD-001](#upload-001)
- [UPLOAD-002](#upload-002)
- [UPLOAD-003](#upload-003)
- [UPLOAD-004](#upload-004)
- [UPLOAD-005](#upload-005)
- [FILE-001](#file-001)
- [FILE-002](#file-002)
- [FILE-003](#file-003)
- [FILE-004](#file-004)
- [DEDUPE-001](#dedupe-001)
- [RATE-001](#rate-001)
- [PROCESS-001](#process-001)
- [OBS-001](#obs-001)
- [CLIENT-001](#client-001)
- [CLIENT-002](#client-002)
- [PY-001](#py-001)
- [PY-002](#py-002)
- [PY-003](#py-003)
- [DEMO-001](#demo-001)

## BUILD-001
- ID: BUILD-001
- Priority: P0
- Statement: All shipped FileFn production surfaces MUST pass their local build/test verification gates, and `@superfunctions/files` MUST include an executable FileProvider conformance test suite.
- Rationale: The audit found green Vitest suites but a failing server typecheck/build and no tests in `packages/files`, which blocks production readiness.
- Acceptance criteria:
  - `filefn/server` passes `npm test -- --run`, `npm run typecheck`, and `npm run build`.
  - `filefn/client`, `filefn/processing`, `uifn/files`, `packages/storage`, `packages/storage-*`, `packages/middleware`, `packages/db`, and `packages/files` pass their required verification commands.
  - `packages/files` contains at least one automated conformance suite verifying the FileProvider contract surface.
  - `filefn/python` contains executable tests and `pytest` collects at least one test.
- Test vectors: TV-BUILD-001, TV-BUILD-NEG-001
- Notes: Existing passing tests MUST remain passing; success is not allowed to come from deleting coverage.

## PKG-001
- ID: PKG-001
- Priority: P0
- Statement: FileFn package boundaries and exports MUST match the canonical package names and public entry points defined in SPEC.md.
- Rationale: The audit found `filefn/client` published under the wrong package name and Python top-level exports effectively missing.
- Acceptance criteria:
  - `filefn/client/package.json` publishes `@filefn/client`.
  - TypeScript package exports remain consumable through their declared entry points.
  - `filefn/python/filefn/__init__.py` exports the documented server entry points.
  - `filefn/python/filefn/processing/__init__.py` exports all documented processor factories.
- Test vectors: TV-PKG-001, TV-PKG-NEG-001
- Notes: Python package naming remains `filefn`; this requirement does not rename the PyPI package.

## API-001
- ID: API-001
- Priority: P0
- Statement: Every FileFn control-plane route in TypeScript and Python MUST return canonical success/error envelopes with stable error codes and request ID propagation.
- Rationale: The prior bundles and the audit both treat canonical envelopes as foundational for client correctness.
- Acceptance criteria:
  - Successful JSON routes return `{ ok: true, data, requestId, warnings? }`.
  - Failed JSON routes return `{ ok: false, error: { code, message, details }, requestId }`.
  - `requestId` is echoed when present and SHOULD be generated when absent.
  - No control-plane route returns raw unwrapped JSON payloads.
- Test vectors: TV-ENVELOPE-001, TV-ENVELOPE-NEG-001
- Notes: Data-plane streaming routes are exempt from JSON envelope requirements because they stream bytes.

## AUTH-001
- ID: AUTH-001
- Priority: P0
- Statement: Upload-session follow-up operations MUST be bound to the initiating caller identity, using a server-minted upload session token for anonymous flows.
- Rationale: The audit found a critical authz gap where any caller with an upload session ID could act on another session.
- Acceptance criteria:
  - Authenticated upload sessions bind to `principalId` and `tenantId`.
  - Anonymous upload init returns `uploadSessionToken`, and follow-up requests require `x-upload-session-token`.
  - The server stores only the token hash.
  - Missing or invalid anonymous session tokens fail with stable auth/session-token error codes.
  - Status, sign, proxy PUT, part-complete, complete, and abort all enforce the binding.
- Test vectors: TV-UPLOAD-AUTH-001, TV-UPLOAD-AUTH-NEG-001
- Notes: This requirement applies equally to TypeScript and Python server surfaces.

## AUTH-002
- ID: AUTH-002
- Priority: P0
- Statement: File, version, share, and artifact operations MUST enforce consistent binding-checked authorization semantics on both control-plane and data-plane paths.
- Rationale: The audit found missing or inconsistent authz for artifact access, replace flows, and binding checks.
- Acceptance criteria:
  - `versionId` access requires `version.fileId === fileId`.
  - Artifact list/download requires `artifact.fileId === fileId` and file read authorization.
  - Replace-by-file authorization is checked at init and re-checked at complete.
  - Share-link downloads increment counters only after a usable download path exists.
  - Negative cases return `404 FILEFN_NOT_FOUND` for cross-file binding mismatches and `403 FILEFN_FORBIDDEN` for authz failures.
- Test vectors: TV-ACCESS-001, TV-ACCESS-NEG-001
- Notes: Returning 404 for cross-file binding avoids leaking existence of other versions/artifacts.

## UPLOAD-001
- ID: UPLOAD-001
- Priority: P0
- Statement: Upload status responses MUST expose the canonical resumability shape needed by the browser client and any parity Python client.
- Rationale: The audit found the live server status payload incompatible with the live client resume logic.
- Acceptance criteria:
  - `GET /upload/:id/status` returns `recordedParts`, `chunkSizeBytes`, `fileSize`, `totalParts`, `status`, and `expiresAt`.
  - Browser and Python client logic use the canonical fields.
  - Resuming an upload after one or more recorded parts uses the canonical fields without heuristics.
- Test vectors: TV-UPLOAD-STATUS-001, TV-UPLOAD-STATUS-NEG-001
- Notes: A temporary `uploadedParts` alias MAY exist, but tests MUST target `recordedParts`.

## UPLOAD-002
- ID: UPLOAD-002
- Priority: P0
- Statement: Upload mode selection MUST be fully capability-gated and MUST choose only `multipart-signed-url` or `proxy`.
- Rationale: The audit found the server returning bare `signed-url`, which the implementation cannot complete safely.
- Acceptance criteria:
  - `multipart-signed-url` is returned only when signed upload URLs and multipart are both supported.
  - `proxy` is returned only when proxy upload is supported.
  - No response returns bare `signed-url`.
  - When no valid mode exists, init fails with `FILEFN_NO_SUPPORTED_UPLOAD_MODE`.
- Test vectors: TV-UPLOAD-MODE-001, TV-UPLOAD-MODE-NEG-001
- Notes: Capability declarations and mode selection MUST agree.

## UPLOAD-003
- ID: UPLOAD-003
- Priority: P0
- Statement: Proxy upload MUST work end-to-end as a durable data-plane path with deterministic part recording semantics.
- Rationale: FileFn must work with providers that cannot sign upload URLs.
- Acceptance criteria:
  - `PUT /upload/:uploadSessionId/parts/:partNumber` accepts bytes and records the part durably.
  - Successful proxy uploads return a stable ETag/size result and set `recorded: true`.
  - Proxy completion stitches or finalizes parts deterministically and produces the declared final object.
  - Retrying the same accepted proxy part is idempotent; conflicting bytes fail deterministically.
- Test vectors: TV-UPLOAD-PROXY-001, TV-UPLOAD-PROXY-NEG-001
- Notes: The proxy path MUST be auth-bound using `AUTH-001` semantics.

## UPLOAD-004
- ID: UPLOAD-004
- Priority: P1
- Statement: Upload init, part recording, and upload completion MUST have deterministic idempotency and conflict behavior.
- Rationale: Flaky networks and retries are core to FileFn’s value proposition.
- Acceptance criteria:
  - Init idempotency keys return the original success result for identical inputs.
  - Init idempotency-key mismatches fail with `FILEFN_IDEMPOTENCY_CONFLICT`.
  - Part recording is idempotent only for an identical `(session, partNumber, etag, size)` tuple.
  - Completion returns the original `{ fileId, versionId }` after a successful prior completion.
  - Incomplete uploads fail with `FILEFN_UPLOAD_INCOMPLETE`.
- Test vectors: TV-IDEMPOTENCY-001, TV-IDEMPOTENCY-NEG-001
- Notes: Proxy PUT and explicit complete-part MUST converge on the same recorded-part semantics.

## UPLOAD-005
- ID: UPLOAD-005
- Priority: P1
- Statement: Upload expiry, abort, and garbage collection MUST fully clean temporary data, related records, and provider-side multipart state.
- Rationale: The audit found incomplete cleanup for proxy temp parts and upload part records.
- Acceptance criteria:
  - Expired incomplete sessions can be garbage-collected.
  - Multipart uploads are aborted when the provider supports it.
  - Proxy temp part objects are deleted during complete, abort, and GC.
  - `uploadParts` rows and abandoned session rows are removed deterministically during cleanup.
  - Completed sessions are never garbage-collected prematurely.
- Test vectors: TV-UPLOAD-GC-001, TV-UPLOAD-GC-NEG-001
- Notes: Cleanup MUST be safe to rerun.

## FILE-001
- ID: FILE-001
- Priority: P0
- Statement: `listFiles` MUST return exactly the readable file set in deterministic order with stable cursor pagination.
- Rationale: The audit found unsorted prefetch + in-memory filtering, which is not production-safe.
- Acceptance criteria:
  - Ordering is `updatedAt DESC, fileId ASC`.
  - Cursor pagination is based on the last returned tuple and does not skip or duplicate rows.
  - Files outside the readable file set are never returned.
  - The implementation does not rely on an unsorted fixed-size prefetch for correctness.
- Test vectors: TV-FILE-LIST-001, TV-FILE-LIST-NEG-001
- Notes: Limit defaults to 20 and caps at 100.

## FILE-002
- ID: FILE-002
- Priority: P0
- Statement: `getFile`, version metadata, version downloads, and `FileProvider.getFile({ versionId })` MUST honor version binding semantics.
- Rationale: The audit found provider-level `versionId` handling still incomplete.
- Acceptance criteria:
  - Provider-level `getFile({ fileId, versionId })` returns the requested version metadata when `versionId` is provided.
  - Version metadata/download routes verify the version belongs to the file.
  - Binding mismatches return `404 FILEFN_NOT_FOUND`.
- Test vectors: TV-VERSION-001, TV-VERSION-NEG-001
- Notes: The current-version shorthand remains valid when `versionId` is absent.

## FILE-003
- ID: FILE-003
- Priority: P0
- Statement: File, share-link, and artifact download control-plane routes MUST always return real signed/proxy URLs, and the corresponding proxy data-plane routes MUST stream authorized bytes.
- Rationale: The audit found unusable `proxy://...` placeholders and missing artifact auth enforcement.
- Acceptance criteria:
  - File/version/share/artifact control-plane download routes return a real HTTP URL.
  - When signed URLs are unavailable, FileFn returns the matching proxy route.
  - Share-link proxy download works end-to-end.
  - Artifact proxy download works end-to-end and enforces parent-file read authorization.
  - No placeholder URI is ever returned.
- Test vectors: TV-DOWNLOAD-FALLBACK-001, TV-DOWNLOAD-FALLBACK-NEG-001
- Notes: Share-link download counters MUST increment only after a usable descriptor is produced or proxy streaming begins.

## FILE-004
- ID: FILE-004
- Priority: P0
- Statement: Delete MUST cascade metadata cleanup and perform storage deletion only when no live reference remains.
- Rationale: The audit found orphaned permissions/shares/artifacts and did not define dedupe-safe deletion strongly enough.
- Acceptance criteria:
  - Deleting a file removes its versions, grants, shares, artifacts, and associated pending upload metadata.
  - Artifact storage objects are cleaned up along with artifact rows.
  - Storage objects referenced by other live versions/artifacts are not physically deleted.
  - Quota deltas reflect bytes whose last live reference was removed.
- Test vectors: TV-DELETE-CASCADE-001, TV-DELETE-CASCADE-NEG-001
- Notes: Delete remains hard-delete for metadata; physical storage deletion is reference-safe, not blindly per-row.

## DEDUPE-001
- ID: DEDUPE-001
- Priority: P1
- Statement: Dedupe MUST be publicly configurable, tenant-scoped, and safe with delete/reference accounting.
- Rationale: The audit found dedupe logic present but not wired from the public entry points.
- Acceptance criteria:
  - TypeScript `createFileFn()` exposes a public dedupe configuration surface.
  - Python `FileFnConfig` exposes dedupe configuration as well.
  - Identical bytes dedupe within a tenant when enabled.
  - Cross-tenant dedupe does not occur.
  - Delete semantics remain correct under dedupe.
- Test vectors: TV-DEDUP-001, TV-DEDUP-NEG-001
- Notes: This requirement does not mandate dedupe by default; it mandates correct behavior when enabled.

## RATE-001
- ID: RATE-001
- Priority: P1
- Statement: FileFn MUST support route-category-specific rate limits with ISO8601 reset timestamps.
- Rationale: The audit found generic rate-limit wiring but not the per-category semantics called for by the prior spec notes.
- Acceptance criteria:
  - `rateLimit.limits` supports `uploadInit`, `uploadSign`, `uploadComplete`, `download`, and optional share/artifact download categories.
  - Over-limit responses use `FILEFN_RATE_LIMITED`.
  - `error.details.resetAt` is ISO8601.
  - Python config parity exists for the same logical categories when the Python server surface is enabled.
- Test vectors: TV-RATE-001, TV-RATE-NEG-001
- Notes: Category omission means that route is unlimited unless the implementation documents a default.

## PROCESS-001
- ID: PROCESS-001
- Priority: P1
- Statement: Processing and artifact access MUST be idempotent, authorization-safe, and observably correct.
- Rationale: The audit found processing enqueue gaps and artifact auth issues.
- Acceptance criteria:
  - Upload completion triggers processing when enabled.
  - FlowFn enqueue uses a deterministic idempotency key.
  - Enqueue failures surface `FILEFN_PROCESSING_ENQUEUE_FAILED`.
  - Artifact list/download routes enforce parent-file read authorization.
  - Processing events include `requestId` when available.
- Test vectors: TV-PROCESS-001, TV-PROCESS-NEG-001
- Notes: Immediate in-process execution remains allowed when FlowFn is absent.

## OBS-001
- ID: OBS-001
- Priority: P0
- Statement: Logs and events MUST preserve correlation IDs while redacting secrets without over-redacting safe identifiers.
- Rationale: The audit found TS redaction largely healthy and requires the same guarantee everywhere, including Python and the new anonymous session-token flow.
- Acceptance criteria:
  - Safe IDs like `req_001`, `file_001`, `upl_001`, and `ver_001` remain visible.
  - Signed URLs, share tokens, upload session tokens, bearer credentials, secrets, and passwords are redacted.
  - Event payloads never include signed URLs or plaintext tokens.
  - Python logging follows the same policy.
- Test vectors: TV-OBS-001, TV-OBS-NEG-001
- Notes: Redaction MUST recurse into nested log contexts.

## CLIENT-001
- ID: CLIENT-001
- Priority: P0
- Statement: The browser client MUST interoperate with the canonical upload/resume/proxy semantics and publish as `@filefn/client`.
- Rationale: The audit found a broken resume contract and an incorrect package name.
- Acceptance criteria:
  - Client init sends canonical fields.
  - Client status parsing uses `recordedParts`, `chunkSizeBytes`, and `fileSize`.
  - Client handles `uploadSessionToken` for anonymous sessions.
  - Client handles both `multipart-signed-url` and `proxy` upload modes.
  - `filefn/client/package.json` publishes `@filefn/client`.
- Test vectors: TV-CLIENT-001, TV-CLIENT-NEG-001
- Notes: The client MAY accept a deprecated `uploadedParts` alias temporarily, but canonical tests target `recordedParts`.

## CLIENT-002
- ID: CLIENT-002
- Priority: P1
- Statement: Offline mode MUST stage, sync, abort, and progress-report deterministically when enabled.
- Rationale: The audit found offline staging present but with incomplete abort/progress behavior.
- Acceptance criteria:
  - Offline mode stages uploads in OPFS when supported.
  - Upload handles expose meaningful `abort()` and `onProgress()` behavior in offline mode.
  - Syncing a staged upload preserves canonical upload semantics.
  - Unsupported environments fail with `FILEFN_OFFLINE_UNSUPPORTED`.
- Test vectors: TV-CLIENT-OFFLINE-001, TV-CLIENT-OFFLINE-NEG-001
- Notes: This requirement does not mandate offline mode by default; it mandates correctness when enabled.

## PY-001
- ID: PY-001
- Priority: P0
- Statement: The Python package MUST export the documented public surfaces and MUST implement real auth, rate-limit, and dedupe configuration instead of placeholders.
- Rationale: The audit found Python top-level exports empty and core config surfaces incomplete.
- Acceptance criteria:
  - `filefn.__init__` exports the documented server entry points.
  - `AuthConfig` is functional, not a placeholder.
  - `rate_limit` configuration is implemented.
  - `dedup` configuration is publicly available and wired.
  - `processing` exports include all documented processors.
- Test vectors: TV-PY-CORE-001, TV-PY-CORE-NEG-001
- Notes: Python naming may remain snake_case.

## PY-002
- ID: PY-002
- Priority: P0
- Statement: Python upload, download, share, artifact, dedupe, and processing behavior MUST match the canonical semantics of this spec.
- Rationale: The audit found Python upload mode selection, validation, and processing protocol behavior materially divergent.
- Acceptance criteria:
  - Python upload mode selection never returns bare `signed-url`.
  - Python upload status shape matches the canonical TypeScript shape.
  - Python version-aware reads honor `versionId`.
  - Python processing uses declared storage protocol methods consistently.
  - Python share/download/proxy behavior returns real HTTP descriptors, not placeholders.
- Test vectors: TV-PY-FLOWS-001, TV-PY-FLOWS-NEG-001
- Notes: Wire semantics, auth semantics, and cleanup semantics MUST match TypeScript.

## PY-003
- ID: PY-003
- Priority: P1
- Statement: The Python package MUST ship executable tests that cover its documented core flows and import sanity in a supported environment.
- Rationale: The audit found zero collected Python tests, which makes the README claims non-credible.
- Acceptance criteria:
  - `pytest` collects and passes core FileFn tests.
  - Tests cover at minimum upload-session auth, status shape, version-aware reads, share/artifact download behavior, and processing protocol correctness.
  - Import sanity passes in an environment with the declared dependencies installed.
- Test vectors: TV-PY-TESTS-001, TV-PY-TESTS-NEG-001
- Notes: A syntax-only compile pass is insufficient.

## DEMO-001
- ID: DEMO-001
- Priority: P2
- Statement: The bundled full demo MUST pass a smoke verification for upload, list, download, and delete using canonical packages.
- Rationale: The README promises the demo as proof of end-to-end capability.
- Acceptance criteria:
  - The demo server and client start with documented commands.
  - A smoke run uploads a file, lists it, downloads it, and deletes it successfully.
  - The demo uses canonical packages and route semantics from this spec.
- Test vectors: TV-DEMO-001, TV-DEMO-NEG-001
- Notes: This is a smoke requirement, not a broad E2E UI test suite.
