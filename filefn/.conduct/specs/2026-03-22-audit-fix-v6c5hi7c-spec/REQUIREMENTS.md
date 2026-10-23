# REQUIREMENTS.md

## Table of contents
- [BUILD-001](#build-001)
- [API-001](#api-001)
- [AUTH-001](#auth-001)
- [AUTH-002](#auth-002)
- [UPLOAD-001](#upload-001)
- [UPLOAD-002](#upload-002)
- [FILE-001](#file-001)
- [FILE-002](#file-002)
- [FILE-003](#file-003)
- [META-001](#meta-001)
- [STORAGE-001](#storage-001)
- [DEDUPE-001](#dedupe-001)
- [RATE-001](#rate-001)
- [PROCESS-001](#process-001)
- [PROCESS-002](#process-002)
- [OBS-001](#obs-001)
- [CLIENT-001](#client-001)
- [CLIENT-002](#client-002)
- [CLIENT-003](#client-003)
- [VIEW-001](#view-001)
- [VIEW-002](#view-002)
- [PY-001](#py-001)
- [PY-002](#py-002)
- [PY-003](#py-003)
- [POLICY-001](#policy-001)
- [MIG-001](#mig-001)
- [MIG-002](#mig-002)
- [NUCLEUS-001](#nucleus-001)
- [NUCLEUS-002](#nucleus-002)
- [DEMO-001](#demo-001)

## BUILD-001
- ID: BUILD-001
- Priority: P0
- Statement: All FileFn and Nucleus surfaces touched by this bundle MUST pass targeted local test, typecheck, and build verification before cutover.
- Rationale: This bundle supersedes the prior audit-fix work and adds new packages plus Nucleus integration; green tests alone are insufficient.
- Acceptance criteria:
  - `filefn/server`, `filefn/client`, `filefn/processing`, `filefn/viewer`, `packages/storage`, `packages/files`, and `filefn/python` have executable verification commands.
  - The targeted Nucleus migration surfaces have automated or scripted verification in the Nucleus repo.
  - No requirement in this bundle is considered complete without passing verification commands.
- Test vectors: TV-BUILD-001
- Notes: Deleting tests or downgrading verification rigor does not satisfy this requirement.

## API-001
- ID: API-001
- Priority: P0
- Statement: Every control-plane route touched by this bundle MUST use canonical success/error envelopes with stable error codes and request ID propagation.
- Rationale: Viewer resolution, migration tooling, and Nucleus integration depend on stable envelopes.
- Acceptance criteria:
  - `getFile`, `listArtifacts`, `downloadArtifact`, and `render` return canonical envelopes.
  - Error codes added by this bundle are stable and documented.
  - `requestId` is echoed when provided.
- Test vectors: TV-API-001
- Notes: Data-plane byte streams remain exempt from JSON envelopes.

## AUTH-001
- ID: AUTH-001
- Priority: P0
- Statement: Upload-session continuation MUST remain bound to the initiating caller, including deterministic anonymous token replay semantics.
- Rationale: The current audit still found incorrect anonymous init replay behavior.
- Acceptance criteria:
  - Anonymous init replay with identical payload returns the original semantic success result, including the original upload session token.
  - Missing or invalid upload session tokens fail with stable auth codes.
  - Authenticated and anonymous follow-up routes enforce the same session binding rules on TS and Python.
- Test vectors: TV-AUTH-001
- Notes: This requirement carries forward the prior bundle and closes the remaining replay/token defect.

## AUTH-002
- ID: AUTH-002
- Priority: P0
- Statement: Replace, version, artifact, share, and render operations MUST enforce consistent binding-checked authorization on TS and Python surfaces.
- Rationale: The current compliance audit found the TS replace completion auth re-check still missing.
- Acceptance criteria:
  - Replace-by-file authorization is re-checked at completion.
  - Version and artifact bindings return `404 FILEFN_NOT_FOUND` on cross-file mismatch.
  - Render descriptor access uses the same read boundary as artifact and file access.
  - Share/proxy counter timing remains correct and authorization-safe.
- Test vectors: TV-AUTH-002
- Notes: This applies to control-plane and proxy data-plane routes.

## UPLOAD-001
- ID: UPLOAD-001
- Priority: P0
- Statement: Upload init, status, part recording, completion, abort, and GC MUST remain deterministic and resumable across online and offline-assisted client flows.
- Rationale: FileFn’s value depends on stable resumability under retries and intermittent connectivity.
- Acceptance criteria:
  - Status responses expose canonical resumability fields required by the browser client.
  - Init idempotency replay returns the original semantic result for identical input.
  - Completion replay returns the original `{ fileId, versionId }`.
  - Abort and GC clean temporary state deterministically.
- Test vectors: TV-UPLOAD-001
- Notes: The proxy upload path remains first-class.

## UPLOAD-002
- ID: UPLOAD-002
- Priority: P1
- Statement: Upload mode selection MUST advertise only supported modes and MUST continue to support proxy upload as a production fallback.
- Rationale: The prior spec already forbade unsupported bare `signed-url` behavior; this bundle must not regress it.
- Acceptance criteria:
  - Only `multipart-signed-url` or `proxy` are returned.
  - Unsupported capability combinations fail with `FILEFN_NO_SUPPORTED_UPLOAD_MODE`.
  - Proxy upload remains covered by tests after viewer/migration additions.
- Test vectors: TV-UPLOAD-002
- Notes: This requirement is unchanged in principle but remains in scope.

## FILE-001
- ID: FILE-001
- Priority: P0
- Statement: File listing and version-aware reads/downloads MUST be deterministic, access-filtered, and parity-correct on TS and Python.
- Rationale: The compliance audit still found Python divergence in list and version-aware read semantics.
- Acceptance criteria:
  - Ordering is `updatedAt DESC, fileId ASC`.
  - Cursor pagination is stable and does not rely on unsorted fixed-size prefetch.
  - `getFile({ versionId })` returns version-aware metadata on TS and Python.
  - `downloadUrl` binds version to file on TS and Python.
- Test vectors: TV-FILE-001
- Notes: Cursor compatibility aliases MAY remain only where documented.

## FILE-002
- ID: FILE-002
- Priority: P0
- Statement: File, share, artifact, and render descriptor routes MUST return usable HTTP descriptors and never placeholder proxy URIs.
- Rationale: The prior and current audits both treat real descriptor URLs as foundational.
- Acceptance criteria:
  - File and artifact control-plane routes return real signed or proxy HTTP URLs.
  - Render descriptor routes return an artifact URL, original URL, or a deterministic placeholder descriptor.
  - No public response returns `proxy://...`.
- Test vectors: TV-FILE-002
- Notes: Placeholder descriptors are allowed only for render intents, not for download routes.

## FILE-003
- ID: FILE-003
- Priority: P0
- Statement: Delete MUST cascade metadata cleanup and remain dedupe/reference-safe on TS and Python.
- Rationale: The compliance audit still found Python delete divergence and prior bundles made delete correctness a P0 invariant.
- Acceptance criteria:
  - Deleting a file removes related versions, shares, permissions, artifacts, and abandoned upload metadata.
  - Physical storage is deleted only when no live reference remains.
  - Quota accounting reflects last-reference deletion correctly.
  - TS and Python behavior matches for successful delete and negative cases.
- Test vectors: TV-FILE-003
- Notes: Metadata hard-delete remains the expected semantic.

## META-001
- ID: META-001
- Priority: P0
- Statement: Upload and migration metadata MUST be persisted on the canonical FileFn records instead of being dropped at completion/import time.
- Rationale: The readiness audit found metadata accepted into idempotency/session flow but persisted as `{}`.
- Acceptance criteria:
  - Upload metadata written during init is present on the resulting file record.
  - Migration-imported legacy metadata is preserved in imported FileFn rows.
  - Persisted metadata matches the payload used for init idempotency hashing.
- Test vectors: TV-META-001
- Notes: Version-level provenance MAY be added when it is required by migration or processing.

## STORAGE-001
- ID: STORAGE-001
- Priority: P0
- Statement: Multi-bucket support MUST be implemented as a routed storage adapter plugin driven by logical policy storage targets, without adding bucket branching to FileFn core.
- Rationale: The readiness audit found single-bucket adapters incompatible with Nucleus temp/permanent semantics.
- Acceptance criteria:
  - Policies can declare a logical `storageTarget`.
  - A routed storage adapter maps logical targets to physical adapters/buckets.
  - FileFn core stays bucket-agnostic and interacts only through the storage adapter contract.
  - TS and Python server/storage semantics support the same logical target behavior.
- Test vectors: TV-STORAGE-001
- Notes: Imported legacy objects MAY remain in existing buckets if routing can resolve them safely.

## DEDUPE-001
- ID: DEDUPE-001
- Priority: P1
- Statement: Dedupe MUST remain tenant-scoped, publicly configurable, and correct under routed storage plus delete/reference accounting.
- Rationale: Routing and migration must not reintroduce unsafe physical deletion or cross-tenant reuse.
- Acceptance criteria:
  - Dedupe configuration remains public on TS and Python.
  - Cross-tenant dedupe does not occur.
  - Delete remains correct when multiple logical files reference the same storage object.
- Test vectors: TV-STORAGE-001
- Notes: This bundle does not require dedupe to be enabled by default.

## RATE-001
- ID: RATE-001
- Priority: P1
- Statement: Route-category rate limiting MUST continue to work for upload, file, share, artifact, and render control-plane routes with ISO8601 reset timestamps.
- Rationale: The render route and migration-triggered control-plane paths expand the surface area that must remain rate-limit aware.
- Acceptance criteria:
  - Existing route categories remain supported.
  - Artifact and render descriptor routes use explicit category semantics.
  - Over-limit responses include stable error codes and ISO8601 reset timestamps.
- Test vectors: TV-RATE-001
- Notes: Data-plane proxy byte streams remain outside JSON rate-limit envelope requirements.

## PROCESS-001
- ID: PROCESS-001
- Priority: P0
- Statement: Upload completion MUST trigger processing deterministically on TS and Python when processing is enabled.
- Rationale: The readiness audit found the TS processing wiring bug in `createFileFn()`.
- Acceptance criteria:
  - TypeScript `createFileFn()` passes the processing service into upload-session completion.
  - Processing is idempotent per `(fileId, versionId, processor-set)`.
  - Request IDs flow through processing events on TS and Python.
- Test vectors: TV-PROCESS-001
- Notes: FlowFn-backed and inline processing are both allowed if semantics stay deterministic.

## PROCESS-002
- ID: PROCESS-002
- Priority: P0
- Statement: FileFn MUST support canonical image thumbnail artifacts and PDF first-page preview artifacts on TS and Python processing surfaces.
- Rationale: Nucleus functionality depends on thumbnails/previews, and PDF preview support is a newly required gap closure.
- Acceptance criteria:
  - Image thumbnail processor continues to emit reserved thumbnail artifact kinds.
  - PDF preview processor emits reserved `pdf-preview-page-1-*` artifact kinds.
  - Processing failures surface stable error codes.
  - Artifact download/list semantics work with the new PDF artifacts.
- Test vectors: TV-PROCESS-002
- Notes: Video poster generation remains out of scope.

## OBS-001
- ID: OBS-001
- Priority: P0
- Statement: Logs and events MUST preserve correlation identifiers while redacting tokens, signed URLs, and credentials on TS and Python.
- Rationale: The prior audit left Python observability parity incomplete.
- Acceptance criteria:
  - TS and Python have redaction tests covering upload tokens, share tokens, signed URLs, and auth headers.
  - `fileId`, `versionId`, `artifactId`, `policyId`, and `requestId` remain visible when safe.
  - Migration summaries emit counts without leaking secrets.
- Test vectors: TV-OBS-001
- Notes: Over-redaction of safe identifiers fails this requirement.

## CLIENT-001
- ID: CLIENT-001
- Priority: P0
- Statement: `@filefn/client` MUST support stable FileFn-native IDs for online and offline flows, and those IDs MUST be the final application-facing identity in Nucleus.
- Rationale: Final state native FileFn IDs are a user decision and are required to delete the old Nucleus file model.
- Acceptance criteria:
  - The client exposes `generateFileId()`.
  - Offline/local-preview flows auto-generate `fileId` when absent.
  - Completed remote uploads preserve the same `fileId`.
  - Nucleus write paths persist FileFn-native IDs rather than legacy `file:` resource IDs.
- Test vectors: TV-CLIENT-001, TV-NUCLEUS-001
- Notes: Compatibility logic may translate legacy IDs only during the migration window.

## CLIENT-002
- ID: CLIENT-002
- Priority: P0
- Statement: OPFS-backed offline persistence MUST support immediate local preview/access for unsynced files, not only deferred upload staging.
- Rationale: The user explicitly chose immediate local preview/access as a MUST.
- Acceptance criteria:
  - OPFS pending-upload metadata stores enough information to resolve a local render source.
  - Unsynced local images render immediately from OPFS.
  - Unsynced local PDFs support immediate access and deterministic preview behavior.
  - Remote sync completion preserves the same file identity.
- Test vectors: TV-CLIENT-002, TV-VIEW-002
- Notes: The UX MUST not require old Nucleus `data`/`thumbnailData` persistence.

## CLIENT-003
- ID: CLIENT-003
- Priority: P0
- Statement: `@filefn/client` MUST provide a preprocessing pipeline with browser HEIC conversion as a first-class capability.
- Rationale: Nucleus currently depends on browser-side HEIC conversion and the user selected browser support as MUST.
- Acceptance criteria:
  - The client supports pluggable upload preprocessors.
  - A built-in HEIC conversion preprocessor is exported.
  - Converted output updates MIME type, file name, and preview metadata deterministically.
  - Failed conversion yields a stable user-facing error code.
- Test vectors: TV-CLIENT-003
- Notes: Server-side/non-browser HEIC conversion is not required for this bundle.

## VIEW-001
- ID: VIEW-001
- Priority: P0
- Statement: FileFn MUST provide a first-class render/view abstraction through a render descriptor API and the new `@filefn/viewer` package.
- Rationale: This is the chosen replacement for the old Nucleus file view model.
- Acceptance criteria:
  - Server exposes `GET /:fileId/render`.
  - Client exposes `resolveRenderable(...)`.
  - `@filefn/viewer` resolves local or remote viewer sources from FileFn IDs.
  - The new viewer package is not marked experimental.
- Test vectors: TV-VIEW-001
- Notes: Nucleus-specific UI wrappers may live outside the package.

## VIEW-002
- ID: VIEW-002
- Priority: P0
- Statement: Render resolution MUST choose deterministic local or remote sources for image, PDF, audio, video, and generic file flows without persisting direct signed URLs as identity.
- Rationale: App functionality depends on predictable rendering semantics after deleting the old Nucleus file code.
- Acceptance criteria:
  - Intent selection rules are deterministic and documented.
  - Image `thumbnail` and PDF `preview` prefer artifacts when present.
  - Unsynced local files prefer OPFS/local object URLs when `preferLocal=true`.
  - Unsupported preview cases return deterministic placeholders instead of undefined behavior.
- Test vectors: TV-VIEW-002
- Notes: `download` intent remains the original-file path.

## PY-001
- ID: PY-001
- Priority: P0
- Statement: Python exports/configuration MUST expose the new routed storage, processing, render, and migration-support surfaces needed for server/storage parity.
- Rationale: Python parity is an explicit hard constraint for server/storage semantics in this bundle.
- Acceptance criteria:
  - Python config/export surfaces are updated for logical storage targets and routed storage helper support.
  - Python processing exposes PDF preview capability.
  - Python tests import the documented public surfaces successfully.
- Test vectors: TV-PY-001
- Notes: This requirement does not require a Python browser viewer package.

## PY-002
- ID: PY-002
- Priority: P0
- Statement: Python MUST match TypeScript semantics for every server/storage feature touched by this bundle.
- Rationale: The compliance audit still found concrete Python behavior drift from canonical TS semantics.
- Acceptance criteria:
  - List, version-aware read, delete cascade, auth binding, artifact access, and processing semantics match TS.
  - Routed storage semantics match TS for logical targets.
  - Render descriptor semantics match TS where implemented on the server surface.
- Test vectors: TV-PY-002
- Notes: Naming differences such as snake_case vs camelCase are allowed; semantic drift is not.

## PY-003
- ID: PY-003
- Priority: P1
- Statement: Python MUST have executable tests covering the new routed storage, processing, and parity behaviors introduced by this bundle.
- Rationale: Executable proof is required to keep parity from drifting again.
- Acceptance criteria:
  - `python3 -m pytest` collects and runs tests for the new Python surfaces.
  - Positive and negative parity cases exist for routed storage, PDF previews, and auth/binding semantics.
  - Import sanity is part of the verification suite.
- Test vectors: TV-PY-003
- Notes: Syntax-only validation is insufficient.

## POLICY-001
- ID: POLICY-001
- Priority: P0
- Statement: FileFn MUST ship a documented Nucleus-aligned policy/profile set covering MIME acceptance, 100 MiB size cap, storage targets, and render profile defaults.
- Rationale: The readiness audit found capability-level support but no Nucleus-aligned policy bundle proving parity.
- Acceptance criteria:
  - Durable and temporary Nucleus-aligned policy definitions exist.
  - Accepted file types and the 100 MiB cap are encoded in policies, not only in client-side validation.
  - Image thumbnails and PDF previews are enabled by the chosen render profile where appropriate.
- Test vectors: TV-POLICY-001
- Notes: Client-side validation still matters, but server policy is the authoritative limit.

## MIG-001
- ID: MIG-001
- Priority: P0
- Statement: The migration workflow MUST support deterministic manifest export, in-place legacy object adoption, and FileFn row import without requiring a full byte copy when policy/storage rules allow reuse.
- Rationale: The user explicitly chose in-place adoption as the default migration strategy.
- Acceptance criteria:
  - A dry-run export/import workflow produces deterministic manifest rows and target FileFn IDs.
  - Import can backfill `files`, `fileVersions`, and artifact rows against existing storage objects.
  - Ambiguous or conflicting rows fail validation deterministically.
  - The importer emits a mapping/report artifact suitable for later rewrite and rollback steps.
- Test vectors: TV-MIG-001
- Notes: Copying bytes remains allowed only as a fallback for rows that cannot be safely adopted in place.

## MIG-002
- ID: MIG-002
- Priority: P0
- Statement: The cutover workflow MUST provide a deterministic Nucleus reference rewrite, temporary dual-read compatibility window, rollback manifest, and completion report.
- Rationale: Deleting old code safely requires a reversible and inspectable cutover path.
- Acceptance criteria:
  - A rewrite manifest maps each legacy reference to its final FileFn-native ID.
  - Nucleus dual-read compatibility resolves both legacy and native references during the migration window.
  - A rollback manifest is emitted before legacy code deletion.
  - Completion reports include counts for imported files, rewritten references, skipped rows, and failures.
- Test vectors: TV-MIG-002
- Notes: The compatibility window is temporary and must be removed in the final phase.

## NUCLEUS-001
- ID: NUCLEUS-001
- Priority: P0
- Statement: Nucleus write and read flows covered by the readiness audit MUST adopt native FileFn IDs and FileFn viewer/render resolution semantics.
- Rationale: Final-state native FileFn IDs and the viewer package are explicit user decisions.
- Acceptance criteria:
  - Avatar, cover, memotron capture, markdown temp uploads, embed downloads, and file view flows use FileFn-native IDs.
  - No new Nucleus writes create legacy `file:` resource records.
  - Read paths use FileFn render resolution instead of legacy signed-URL parsing.
- Test vectors: TV-NUCLEUS-001
- Notes: Temporary compatibility may still resolve old references during cutover.

## NUCLEUS-002
- ID: NUCLEUS-002
- Priority: P0
- Statement: After migration verification succeeds, Nucleus legacy file upload/render/refresh code MUST be deleted from the steady-state implementation.
- Rationale: The user explicitly wants to fully migrate and delete the old code.
- Acceptance criteria:
  - Legacy `uploadFileV2`-specific compatibility logic is removed or reduced to a migration-only shim that is deleted by the final phase.
  - Legacy direct signed-URL refresh logic is removed from steady state.
  - Final-state rendering no longer depends on persisted `url` / `thumbnailUrl` file-resource shapes.
- Test vectors: TV-NUCLEUS-002
- Notes: This requirement is satisfied only after the migration window closes successfully.

## DEMO-001
- ID: DEMO-001
- Priority: P1
- Statement: FileFn examples and smoke tests MUST cover the new viewer/render, storage routing, and migration-critical behaviors introduced by this bundle.
- Rationale: The prior demo smoke was valuable and the surface area is now larger.
- Acceptance criteria:
  - FileFn example apps demonstrate routed storage plus viewer render resolution.
  - Smoke coverage includes upload, list, download, artifact/render resolution, and delete.
  - At least one migration dry-run/apply smoke path is documented and locally verifiable.
- Test vectors: TV-DEMO-001
- Notes: Demo coverage supplements, not replaces, targeted tests.
