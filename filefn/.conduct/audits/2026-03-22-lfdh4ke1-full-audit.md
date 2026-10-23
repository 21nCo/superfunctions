# Audit Report

## Metadata
- Timestamp: 2026-03-22T08:14:32Z
- agent_name: unknown-agent
- model: gpt-5-codex
- launcher: Codex Desktop
- Workspace/project absolute path: `/Users/serro/Documents/dev/n/superfunctions/filefn`
- Monorepo root: `/Users/serro/Documents/dev/n/superfunctions`
- External comparison project: `/Users/serro/Documents/dev/n/nucleus`
- OS + shell: `macOS 26.3.1 (25D2128)`, `Darwin 25.3.0 arm64`, `zsh`
- Repo metadata:
  - `superfunctions`: branch `next`, commit `b69090aaa83f0515924aa9b11df3b1fcd4de3a1a`, dirty `yes`
  - `nucleus` baseline: branch `next`, commit `7de5a9a6176b61b11a4dff4ec5c1e99ca46c7776`, dirty `yes`
- intent/notes paths audited:
  - User request in Codex thread: readiness of `filefn` to replace Nucleus file uploads "both on client and server"
  - `/Users/serro/Documents/dev/n/superfunctions/AGENTS.md`
  - `/Users/serro/Documents/dev/n/nucleus/AGENTS.md`
  - `/Users/serro/Documents/dev/n/nucleus/README.md`
  - `/Users/serro/Documents/dev/n/nucleus/WARP.md`
  - Nucleus baseline implementation paths:
    - `/Users/serro/Documents/dev/n/nucleus/client/stores/account.store.ts`
    - `/Users/serro/Documents/dev/n/nucleus/client/components/files/file.store.ts`
    - `/Users/serro/Documents/dev/n/nucleus/client/components/files/FileView.svelte`
    - `/Users/serro/Documents/dev/n/nucleus/client/persistence/persistence.ts`
    - `/Users/serro/Documents/dev/n/nucleus/client/components/markdown/mediaGrid/MediaGrid.svelte`
    - `/Users/serro/Documents/dev/n/nucleus/client/elements/avatarPicker/AvatarPicker.svelte`
    - `/Users/serro/Documents/dev/n/nucleus/client/elements/coverPicker/CoverPicker.svelte`
    - `/Users/serro/Documents/dev/n/nucleus/client/products/memotron/capture/FileUploader.svelte`
    - `/Users/serro/Documents/dev/n/nucleus/client/products/memotron/capture/capture.store.ts`
    - `/Users/serro/Documents/dev/n/nucleus/server/s3v2.ts`
- spec bundle paths audited: none provided or found for this migration audit
- codebase scope audited:
  - `/Users/serro/Documents/dev/n/superfunctions/filefn/client`
  - `/Users/serro/Documents/dev/n/superfunctions/filefn/server`
  - `/Users/serro/Documents/dev/n/superfunctions/filefn/python`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/storage`
  - `/Users/serro/Documents/dev/n/superfunctions/packages/storage-s3`
  - External comparison scope: `/Users/serro/Documents/dev/n/nucleus/client`, `/Users/serro/Documents/dev/n/nucleus/server`
  - Excluded: `node_modules`, build outputs, unrelated superfunctions packages/functions except shared storage dependencies
- commands executed during audit:
  - `rg`, `rg --files`, `nl -ba`, `sed`
  - `npm --prefix filefn/server test -- --run src/__tests__/upload-sessions.test.ts src/__tests__/files.test.ts src/__tests__/upload-proxy.test.ts src/__tests__/permissions.test.ts src/__tests__/processing.test.ts src/__tests__/artifact-authz.test.ts src/__tests__/upload-size-validate.test.ts src/__tests__/upload-status-contract.test.ts`
  - `npm --prefix filefn/client test -- --run src/__tests__/upload.test.ts src/__tests__/resume-contract.test.ts src/__tests__/upload-proxy.test.ts tests/offline.test.ts tests/envelope-unwrapping.test.ts`
  - `pytest -q ...` and `python3 -m pytest -q ...`
  - `git branch --show-current`, `git rev-parse HEAD`, `git status --short`, `date -u`, `uname -a`, `sw_vers`

## Audit scope
This audit evaluates whether `filefn` is ready to replace the current Nucleus file-upload and file-access stack on both client and server. Because no formal migration spec bundle was provided, this is an intent-vs-code readiness audit using the user request and the current Nucleus implementation as the authoritative behavioral baseline. The audit covers the TypeScript and Python `filefn` implementations, the shared storage abstraction that constrains `filefn`, and the client/server Nucleus paths that currently own upload, signed URL refresh, display, and downstream file-resource usage.

## Inputs audited (intent + spec bundles)
- Authoritative intent sources:
  - User request in Codex thread
  - `/Users/serro/Documents/dev/n/superfunctions/AGENTS.md`
  - `/Users/serro/Documents/dev/n/nucleus/AGENTS.md`
  - `/Users/serro/Documents/dev/n/nucleus/README.md`
  - `/Users/serro/Documents/dev/n/nucleus/WARP.md`
  - Current Nucleus upload/view/server code paths listed in Metadata
- Supporting implementation/docs reviewed as behavior references, not formal spec bundles:
  - `/Users/serro/Documents/dev/n/superfunctions/filefn/examples/full-demo/README.md`
  - `/Users/serro/Documents/dev/n/superfunctions/filefn/python/README.md`
- Formal spec bundles:
  - None provided
  - No `REQUIREMENTS.md`, `TEST_VECTORS.md`, `SPEC.md`, or migration bundle was identified for the `filefn` -> Nucleus replacement effort
- Consequence:
  - Every row in the intent-to-spec matrix is `SPEC MISSING`
  - Implementation scoring below uses intent-derived replacement requirements rather than an external requirements bundle

## High-level findings
- Overall readiness verdict: `filefn` is not drop-in ready to replace Nucleus uploads today. Server readiness is `PARTIAL`; client readiness is `FAIL` for a direct swap.
- `filefn` is a strong backend substrate. The TypeScript server has session-based uploads, idempotency, quota hooks, dedup integration, authenticated file metadata/download/delete routes, and targeted tests passing (`63` server tests, `38` client tests in the selected suites).
- The main blocker is contract mismatch, not lack of generic file primitives. Nucleus currently centers uploads around `account.uploadFileV2(...)`, client-generated `file:` resource IDs, persisted `url`/`thumbnailUrl`, temp upload flags, raw-URL return mode, extension-env return mode, local byte persistence, HEIC conversion, and client-side thumbnail generation. `filefn` currently exposes `uploadFile()` returning `{ fileId, versionId }` plus separate `getFile()` / `downloadUrl()` calls.
- There is also a concrete TypeScript server defect: `createFileFn()` creates `processingService` after `uploadService` and never passes it into `createUploadSessionService()`, so upload completion does not automatically trigger processing in the normal TypeScript server path even though the upload-session service supports it when present.
- Shared storage currently binds a single bucket per adapter. That is not a direct fit for Nucleus's current temp-vs-permanent bucket split.
- Python parity is incomplete for rollout confidence. The Python code wires processing correctly, unlike TypeScript, but targeted Python tests could not be verified in this environment because `pytest` was absent and `python3 -m pytest` failed collection with an import error despite the symbol being exported in source.

## Intent Inventory
1. Replacement readiness must be evaluated for both Nucleus client and server flows, not just server upload primitives.
2. A replacement backend must provide a secure, resumable, session-based upload lifecycle suitable for large files and retryable clients.
3. A replacement backend must provide authenticated file metadata, download URL, and delete operations.
4. A replacement must preserve or explicitly replace the current `account.uploadFileV2(...)` client contract used throughout Nucleus.
5. Downstream Nucleus callers must continue to receive a Nucleus-usable file identifier because many flows persist `response[0].id` into app resources.
6. Replacement must cover Nucleus local/prevent-sync behavior where raw file bytes and thumbnails can be stored locally instead of uploaded.
7. Replacement must support `isTemp` semantics used for temporary file uploads.
8. Replacement must support the raw-URL return mode used for embed/download flows (`isReturnUrl`).
9. Replacement must support the special file-object return mode used in extension-oriented paths (`isExtensionEnv`) or provide an explicit contract migration.
10. Replacement must preserve current client-side HEIC-to-PNG conversion behavior or provide an equivalent user-visible experience.
11. Replacement must preserve thumbnail generation behavior or provide an equivalent artifact flow that satisfies current Nucleus UX.
12. Replacement must preserve or explicitly migrate the Nucleus file resource shape used by `fileStore` and `FileView`, including `url` and `thumbnailUrl`.
13. Replacement must preserve the ability to refresh expired file and thumbnail URLs after persistence.
14. Replacement must support the file types and size cap currently enforced by Nucleus UI flows, including HEIC and the 100 MB cap.
15. Replacement must account for Nucleus's current temp-vs-permanent storage split implemented as different S3 buckets.
16. Replacement must preserve the current server auth invariant that signed download access is scoped to the authenticated principal's objects.
17. Replacement must expose enough metadata and retrieval semantics to keep existing UI/view/download flows working without silent behavior regressions.
18. Replacement-critical behavior should be consistent across TypeScript and Python `filefn` implementations where parity is claimed or expected in this monorepo.
19. Readiness should be proven against Nucleus integration call sites, not only against standalone `filefn` tests.
20. If replacement is not drop-in, the migration contract and required Nucleus rewrites must be explicit before rollout.

## Intent → Spec coverage matrix

| Intent # | Intent item | Primary intent evidence | Spec coverage |
| --- | --- | --- | --- |
| 1 | Evaluate readiness for both client and server. | User request; `nucleus/client/stores/account.store.ts:426-558`; `nucleus/server/s3v2.ts:61-104` | SPEC MISSING |
| 2 | Replacement backend needs resumable/session-based uploads. | `filefn/examples/full-demo/README.md:3-10`; `filefn/python/README.md:9-18,81-108` | SPEC MISSING |
| 3 | Replacement backend needs metadata/download/delete operations. | `filefn/examples/full-demo/README.md:7-10,46-60`; `filefn/python/README.md:110-125` | SPEC MISSING |
| 4 | Preserve or replace `account.uploadFileV2(...)`. | `nucleus/client/stores/account.store.ts:426-558`; `rg -n "uploadFileV2\\(" nucleus/client` call sites | SPEC MISSING |
| 5 | Preserve Nucleus-usable returned file IDs. | `nucleus/client/elements/avatarPicker/AvatarPicker.svelte:409-417`; `nucleus/client/elements/coverPicker/CoverPicker.svelte:98-107`; `nucleus/client/products/memotron/capture/capture.store.ts:723-740` | SPEC MISSING |
| 6 | Preserve local/prevent-sync byte storage path. | `nucleus/client/stores/account.store.ts:486-505`; `nucleus/client/components/files/file.store.ts:169-187` | SPEC MISSING |
| 7 | Support `isTemp` uploads. | `nucleus/client/stores/account.store.ts:430-438,507-510,525-529`; `nucleus/client/components/markdown/mediaGrid/MediaGrid.svelte:249-260`; `nucleus/server/s3v2.ts:23-26` | SPEC MISSING |
| 8 | Support raw URL return mode. | `nucleus/client/components/files/file.store.ts:84-96`; `nucleus/client/stores/account.store.ts:552-553` | SPEC MISSING |
| 9 | Support extension-env file-object return mode or migrate it explicitly. | `nucleus/client/stores/account.store.ts:554-555` | SPEC MISSING |
| 10 | Preserve HEIC conversion. | `nucleus/client/stores/account.store.ts:450-475`; `nucleus/client/products/memotron/capture/FileUploader.svelte:29-48` | SPEC MISSING |
| 11 | Preserve thumbnail generation behavior. | `nucleus/client/stores/account.store.ts:477-484,523-541`; `nucleus/client/components/files/FileView.svelte:61-76,100-126` | SPEC MISSING |
| 12 | Preserve/migrate Nucleus file resource shape. | `nucleus/client/stores/account.store.ts:543-558`; `nucleus/client/components/files/file.store.ts:109-191`; `nucleus/client/components/files/FileView.svelte:61-76` | SPEC MISSING |
| 13 | Preserve URL refresh after persistence. | `nucleus/client/components/files/file.store.ts:109-147,155-191`; `nucleus/client/persistence/persistence.ts:218-229` | SPEC MISSING |
| 14 | Support current file types and 100 MB cap. | `nucleus/client/products/memotron/capture/FileUploader.svelte:29-48,136-140,210-216`; `nucleus/client/components/record/record.store.ts:74` | SPEC MISSING |
| 15 | Account for temp/permanent bucket split. | `nucleus/server/s3v2.ts:23-26`; `nucleus/client/persistence/persistence.ts:208-215` | SPEC MISSING |
| 16 | Preserve principal-scoped download auth. | `nucleus/server/s3v2.ts:72-103` | SPEC MISSING |
| 17 | Preserve enough metadata/retrieval semantics for current UI flows. | `nucleus/client/components/files/FileView.svelte:61-76,100-145`; `nucleus/client/products/memotron/capture/capture.store.ts:900-917,969-979,1042-1052` | SPEC MISSING |
| 18 | Preserve TS/Python parity for rollout-critical features. | `superfunctions/AGENTS.md` note to check both TypeScript and Python implementations for core functions | SPEC MISSING |
| 19 | Prove readiness at Nucleus call sites. | User request; Nucleus call sites in avatar/cover/memotron/markdown/file store paths | SPEC MISSING |
| 20 | Make migration contract explicit if not drop-in. | User request for readiness assessment plus absence of formal migration bundle | SPEC MISSING |

## Requirement coverage summary

Formal spec bundle coverage:

| Spec bundle | PASS | PARTIAL | FAIL | UNVERIFIED | Notes |
| --- | --- | --- | --- | --- | --- |
| None provided / found | 0 | 0 | 0 | 0 | No formal requirements bundle exists for this migration audit. |

Intent-derived replacement requirement coverage used for implementation scoring:

| Basis | PASS | PARTIAL | FAIL | UNVERIFIED |
| --- | --- | --- | --- | --- |
| Intent inventory items 1-20 | 2 | 7 | 10 | 1 |

Intent coverage in spec:

| Metric | Count | Notes |
| --- | --- | --- |
| Intent items covered by a formal spec bundle | 0 / 20 | Every intent item is `SPEC MISSING`. |
| Intent items missing formal specification | 20 / 20 | This replacement effort currently lacks a requirements/spec/test-vector bundle. |

## Requirement-by-requirement results
Because no formal `REQUIREMENTS.md` was supplied, the table below scores intent-derived replacement requirements. These statuses measure drop-in readiness against the current Nucleus behavior, not generic usefulness of `filefn` in isolation.

| ID | Status | Implementation evidence | Notes |
| --- | --- | --- | --- |
| INT-001 | PARTIAL | `filefn/client`, `filefn/server`, `filefn/python` exist; Nucleus client/server baseline reviewed | `filefn` covers both surfaces as packages, but replacement readiness is not end-to-end because client-side contract gaps remain substantial. |
| INT-002 | PASS | `filefn/server/src/upload-sessions/service.ts:259-430,495-529,820-905`; targeted server tests passed | Strong upload-session lifecycle: idempotency, policy validation, quota checks, multipart/proxy upload, completion, events. |
| INT-003 | PASS | `filefn/client/src/client.ts:195-223`; `filefn/server/src/files/routes.ts:88-128` | Authenticated get-file, download-url, and delete routes exist and are exposed by the TS client. |
| INT-004 | FAIL | `filefn/client/src/index.ts:62-71`; `filefn/client/src/types.ts:17-44`; compare `nucleus/client/stores/account.store.ts:426-558` | No `uploadFileV2`-style facade exists. Current API returns an upload handle resolving to `{ fileId, versionId }`, not the shapes Nucleus callers expect. |
| INT-005 | FAIL | `filefn/client/src/types.ts:33-44`; compare `nucleus/client/elements/avatarPicker/AvatarPicker.svelte:409-417`, `nucleus/client/elements/coverPicker/CoverPicker.svelte:98-107`, `nucleus/client/products/memotron/capture/capture.store.ts:723-740` | Nucleus callers expect `response[0].id` and store that ID into records. `filefn` does not emit a Nucleus `file:` resource ID or array-wrapped resource response. |
| INT-006 | FAIL | `filefn/client/src/index.ts:80-140`; compare `nucleus/client/stores/account.store.ts:486-505`, `nucleus/client/components/files/file.store.ts:169-187` | `filefn` has OPFS offline staging, but not Nucleus's local-byte persistence model where files and thumbnails are created in `fileStore` and later rendered via blob URLs. |
| INT-007 | PARTIAL | `filefn/server/src/upload-sessions/service.ts:307-364`; compare `nucleus/server/s3v2.ts:23-26`; `packages/storage-s3/src/adapter.ts:5-15,27-33` | `filefn` policies can model temp-like behavior, but the default storage adapter is single-bucket and does not directly encode Nucleus's temp/permanent split. |
| INT-008 | PARTIAL | `filefn/client/src/client.ts:214-218`; compare `nucleus/client/components/files/file.store.ts:84-96`, `nucleus/client/stores/account.store.ts:552-553` | A raw download URL can be fetched after upload via `downloadUrl(fileId)`, but there is no single-step upload helper that returns the URL in the way Nucleus expects. |
| INT-009 | FAIL | `filefn/client/src/index.ts:62-71`; compare `nucleus/client/stores/account.store.ts:554-555` | No built-in equivalent to `isExtensionEnv` returning a Nucleus-style file object. |
| INT-010 | FAIL | No HEIC conversion helper in `filefn/client`; compare `nucleus/client/stores/account.store.ts:450-475` | Nucleus currently converts HEIC client-side before upload. `filefn` does not provide this behavior. |
| INT-011 | PARTIAL | `filefn/server/src/index.ts:152-165,215-232`; `filefn/server/src/upload-sessions/service.ts:893-902`; `filefn/python/README.md:11-18,143-170`; compare `nucleus/client/stores/account.store.ts:477-484,523-541` | `filefn` has a processing/artifact concept, but the TS server wiring currently fails to pass `processingService` into upload completion. Nucleus also expects immediate thumbnail URLs / local thumbnails, which are not exposed compatibly today. |
| INT-012 | FAIL | `filefn/server/src/files/routes.ts:88-109`; compare `nucleus/client/stores/account.store.ts:543-558`, `nucleus/client/components/files/file.store.ts:109-191` | `filefn` returns metadata such as `fileId`, `mimeType`, `size`, `name`; it does not provide a persisted Nucleus file resource with `url`, `thumbnailUrl`, `isMeta`, or local data fields. |
| INT-013 | PARTIAL | `filefn/client/src/client.ts:214-218`; `filefn/server/src/files/routes.ts:116-128`; compare `nucleus/client/components/files/file.store.ts:109-147` | Fresh download URLs are supported by file ID, but Nucleus currently refreshes persisted URLs by parsing bucket/key. Existing refresh code would require migration. |
| INT-014 | PARTIAL | `filefn/server/src/upload-sessions/service.ts:307-322`; compare `nucleus/client/products/memotron/capture/FileUploader.svelte:29-48,136-140`; `nucleus/client/components/record/record.store.ts:74` | Policy-level type and size enforcement exists, but there is no audited Nucleus-aligned policy set proving coverage of current accepted types and the 100 MB limit. |
| INT-015 | FAIL | `packages/storage/src/types.ts:39-81`; `packages/storage-s3/src/adapter.ts:5-15,27-33`; `packages/storage/src/internal/s3-compatible.ts:41-130`; compare `nucleus/server/s3v2.ts:23-26` | The storage API operates on `key` only and the S3 adapter is configured with one bucket. Nucleus currently switches between temp and permanent buckets per request. |
| INT-016 | PARTIAL | `filefn/server/src/files/routes.ts:88-128` plus auth/provider hooks in `filefn/server/src/index.ts:39-64`; compare `nucleus/server/s3v2.ts:84-90` | `filefn` can protect access at the file level through auth and authorizer hooks, but this audit did not find a Nucleus-specific mapping that preserves the current key-ownership invariant without integration work. |
| INT-017 | FAIL | `filefn/server/src/files/routes.ts:88-128`; compare `nucleus/client/components/files/FileView.svelte:61-76,100-145`, `nucleus/client/products/memotron/capture/capture.store.ts:900-917,969-979,1042-1052` | Existing Nucleus UI/view flows depend on readily available `url` / `thumbnailUrl` and on storing returned file IDs in app nodes. `filefn` metadata/download primitives alone are not enough for a drop-in swap. |
| INT-018 | UNVERIFIED | `filefn/server/src/index.ts:152-165,215-232`; `filefn/python/filefn/server/core.py:245-260`; `filefn/python/filefn/server/upload_sessions/service.py:660-672`; `filefn/python/filefn/server/__init__.py:1-33` | Static review shows a TS/Python divergence in processing wiring. Python test verification was blocked locally (`pytest` unavailable; `python3 -m pytest` failed collection with `cannot import name 'create_event_emitter' from 'filefn.server'`). |
| INT-019 | FAIL | Standalone filefn tests passed; no Nucleus integration harness found or run | Current tests validate `filefn` in isolation, not Nucleus call sites such as avatar upload, cover upload, memotron capture, markdown temp uploads, or embed downloads. |
| INT-020 | FAIL | No migration bundle found; compare size of contract mismatch above | A direct replacement would require explicit Nucleus-side contract adapters and/or schema/UI migration, but no formal migration contract currently exists. |

Per-requirement notes:
- `INT-004` and `INT-005` are the primary client blockers. Nucleus callers in avatar/cover/memotron paths are tightly coupled to `uploadFileV2()` returning array-wrapped Nucleus file resources whose IDs are immediately persisted.
- `INT-011` is a concrete server blocker for artifact-based replacement. The TS code path constructs `uploadService` before `processingService` and never injects the latter, so configured processing is not triggered by normal uploads.
- `INT-015` is an architectural integration gap, not just a missing option. The current storage abstraction does not let a single `filefn` instance pick a bucket per request.
- `INT-018` means parity confidence is not release-ready even if Nucleus only adopts the TypeScript stack first, because the monorepo expectation is to check both implementations for core functions.
- `INT-019` means even apparently successful standalone tests do not reduce the highest-risk replacement regressions, which are all contract/integration level.

## Spec conflicts / spec gaps
Spec conflicts:
- None identified, because no formal spec bundles were provided for this migration effort.

Spec gaps:
1. No formal replacement requirements define whether Nucleus should keep its `file:` resource model or migrate to native `filefn` IDs.
2. No spec defines the temp upload strategy (`isTemp`) under `filefn`, including whether bucket separation remains a hard requirement.
3. No spec defines how Nucleus `url` / `thumbnailUrl` persistence should map to `filefn` download URLs and artifacts.
4. No spec defines local-mode / prevent-sync behavior under `filefn`, including whether OPFS staging, local `fileStore` rows, or another approach is authoritative.
5. No spec defines client preprocessing responsibilities such as HEIC conversion and thumbnail generation after migration.
6. No spec defines the exact policy set for supported MIME types and the 100 MB cap.
7. No spec defines the migration/backfill strategy for existing persisted Nucleus file resources.
8. No spec defines parity expectations between TypeScript and Python for release readiness.
9. No spec defines the Nucleus integration test matrix required before rollout.

## Cross-cutting audits

### Security/authz/validation boundaries
- `filefn` has solid server-side validation primitives: policy lookup, content-type validation, max-size checks, quota checks, idempotency conflict detection, upload-session token logic for anonymous sessions, and authenticated file routes.
- Nucleus currently relies on a simpler but explicit invariant for signed downloads: parse the requested key, ensure the embedded user ID matches the authenticated user, then sign the GET URL. `filefn` can enforce stronger file-level authz, but only after Nucleus maps requests to `fileId` / `versionId` coherently.
- Replacement risk: if Nucleus stores mixed legacy S3 URLs and new `filefn` IDs without a clear compatibility layer, authz bugs become more likely at the URL-refresh boundary.
- Metadata handling is weaker than it appears: upload metadata is accepted into session creation and idempotency hashing, but the created file record stores `metadata: {}` in both TS and Python.

### Determinism invariants
- Nucleus currently creates app-level `file:` resource IDs on the client before persistence. `filefn` defaults to server-generated `fileId` / `versionId` values. This is a major identity-source change that will affect determinism of downstream records, sync behavior, and migration tooling.
- `filefn` idempotency behavior is well-defined for upload session creation, including payload hash checks, but that determinism does not preserve the current Nucleus return-shape contract.
- Processing determinism is currently compromised in the TypeScript path because configured processing is not wired into upload completion.

### Limits/caps
- Nucleus UI currently enforces a specific accepted-type list and a `100 MB` max size.
- `filefn` can enforce equivalent caps through policies, but this audit did not find a shipped Nucleus-aligned policy configuration proving parity across image/video/audio/pdf/md flows.
- `filefn` also introduces additional limits worth planning around: signed URL TTLs, upload-session TTLs, chunk sizes, and multipart/proxy mode behavior. None of these are currently specified for the Nucleus migration.

### Error handling + canonical envelopes
- `filefn` has a cleaner canonical API surface than the current Nucleus signed-URL endpoint, and the targeted client tests include envelope-unwrapping and upload-status contract coverage.
- Nucleus callers are not written against that surface today. They expect `getSignedUrl(...)`, `fetchSignedUrlForGet(...)`, and `uploadFileV2(...)` return conventions, including special-case URL/file-object returns.
- Without an adapter or migration, the improved `filefn` envelope does not help existing Nucleus callers; it simply changes the contract.

### Compatibility/versioning/migrations
- Compatibility is currently the weakest part of the readiness story. Nucleus persists file resources, persisted signed URLs, thumbnails, and sometimes raw file bytes. `filefn` does not natively speak that model.
- The most realistic migration shape is a Nucleus-specific compatibility adapter that keeps the Nucleus file resource as the application-facing object while storing `filefn` identifiers internally.
- A safe rollout likely needs dual-read or transitional behavior for existing Nucleus file records, plus an explicit plan for refreshing old URLs and backfilling any new `filefn` identifiers/metadata.

## Recommendations
1. Do not replace Nucleus upload callers with direct `filefn.client.uploadFile()` calls. Build a Nucleus-specific adapter/facade that preserves `uploadFileV2()` semantics for callers while delegating storage to `filefn`.
2. Fix the TypeScript `createFileFn()` processing wiring bug and add an end-to-end test proving upload completion triggers processors/artifacts when `processing` is configured.
3. Decide the identity model before any rollout: either keep Nucleus `file:` resources as the app-facing source of truth with embedded `filefn` IDs, or migrate Nucleus UI/data flows to native `filefn` IDs and document the rewrite.
4. Define the temp/permanent storage strategy explicitly. Options include multiple `filefn` instances/routes, a custom storage router/adapter, or a Nucleus product decision to remove the dual-bucket requirement.
5. Define the thumbnail strategy explicitly. Either keep client-side thumbnail generation and persist thumbnails in a Nucleus-compatible way, or expose `filefn` processing artifacts through a Nucleus-compatible `thumbnailUrl` resolution layer.
6. Add Nucleus-compatible helper modes for raw URL returns, extension-env returns, and local/prevent-sync behavior, or publish a migration doc that retires those modes and updates every affected caller.
7. Add an explicit Nucleus policy bundle for MIME types and the 100 MB size cap, then test it against current accepted upload types.
8. Create an integration test matrix for the real call sites: avatar upload, cover upload, memotron single/multi-file capture, audio capture with thumbnail, camera capture, markdown temp uploads, and embed download flow.
9. Resolve Python packaging/test verification if Python parity is part of the release bar; at minimum, document whether the Nucleus rollout is intentionally TypeScript-only.

## Appendix: commands run + environment details

Commands run during audit:
- Repository and artifact discovery:
  - `pwd`
  - `ls -la .conduct`
  - `ls -la .conduct/audits`
  - `sed -n '1,20p' .conduct/logs.csv`
  - `rg --files /Users/serro/Documents/dev/n/superfunctions`
  - `rg --files /Users/serro/Documents/dev/n/nucleus`
- Code-path discovery and evidence gathering:
  - `rg -n "uploadFileV2|getSignedUrl|fetchSignedUrlForGet|thumbnailUrl|isTemp|isReturnUrl|isExtensionEnv|MAX_FILE_SIZE_MB" /Users/serro/Documents/dev/n/nucleus/client`
  - `rg -n "uploadFileV2\\(" /Users/serro/Documents/dev/n/nucleus/client`
  - `nl -ba` / `sed -n` on the key files listed in Metadata
- Targeted TypeScript verification:
  - `npm --prefix filefn/server test -- --run src/__tests__/upload-sessions.test.ts src/__tests__/files.test.ts src/__tests__/upload-proxy.test.ts src/__tests__/permissions.test.ts src/__tests__/processing.test.ts src/__tests__/artifact-authz.test.ts src/__tests__/upload-size-validate.test.ts src/__tests__/upload-status-contract.test.ts`
  - Result summary: `8` test files passed, `63` tests passed
  - `npm --prefix filefn/client test -- --run src/__tests__/upload.test.ts src/__tests__/resume-contract.test.ts src/__tests__/upload-proxy.test.ts tests/offline.test.ts tests/envelope-unwrapping.test.ts`
  - Result summary: `5` test files passed, `38` tests passed
- Targeted Python verification:
  - `pytest -q filefn/python/tests/test_upload_flow.py filefn/python/tests/test_downloads.py filefn/python/tests/test_processing.py`
  - Result: failed immediately because `pytest` command was not installed in this environment
  - `python3 -m pytest -q filefn/python/tests/test_upload_flow.py filefn/python/tests/test_downloads.py filefn/python/tests/test_processing.py`
  - Result: collection failed with `ImportError: cannot import name 'create_event_emitter' from 'filefn.server'`
- Environment / repo metadata:
  - `date -u +"%Y-%m-%dT%H:%M:%SZ"`
  - `uname -a`
  - `sw_vers`
  - `git branch --show-current`
  - `git rev-parse HEAD`
  - `git status --short`
  - `git -C /Users/serro/Documents/dev/n/nucleus branch --show-current`
  - `git -C /Users/serro/Documents/dev/n/nucleus rev-parse HEAD`
  - `git -C /Users/serro/Documents/dev/n/nucleus status --short`

Environment details:
- Audit timestamp: `2026-03-22T08:14:32Z`
- Function project root: `/Users/serro/Documents/dev/n/superfunctions/filefn`
- Monorepo root: `/Users/serro/Documents/dev/n/superfunctions`
- External baseline repo: `/Users/serro/Documents/dev/n/nucleus`
- Host OS: `macOS 26.3.1 (25D2128)`
- Kernel: `Darwin 25.3.0 arm64`
- Shell: `zsh`
