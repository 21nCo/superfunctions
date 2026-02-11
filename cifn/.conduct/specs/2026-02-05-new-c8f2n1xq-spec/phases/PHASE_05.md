# Phase 05: Artifacts and cache steps

## Phase goal
Implement artifact/upload and artifact/download steps using filefn, and cache/restore and cache/save steps using cachefn or filefn-backed cache.

## In scope
- filefn client in runner and control plane: upload directory (zip or multi-file) under run-scoped key; get download URL or fileId.
- artifact/upload step: with name, path; upload path from workspace to filefn; store artifact name → fileId/url in run context.
- artifact/download step: with name; resolve fileId/url from run context; download and extract to workspace.
- GET /runs/:runId/artifacts: return list of artifact names and fileId/url from run context.
- cache/restore: key (may contain expression); lookup in cachefn or filefn; on hit restore to workspace (e.g. paths); on miss no-op or optional fail.
- cache/save: key, paths; store paths from workspace under key in cachefn or filefn.

## Out of scope
- Expression evaluation in cache key (can pass through literal key first); testfn/hostfn steps; secrets.

## Deliverables
- `cifn/typescript/runner/src/steps/artifact-upload.ts`, `artifact-download.ts`.
- `cifn/typescript/runner/src/steps/cache-restore.ts`, `cache-save.ts`.
- filefn client usage in control plane for GET /runs/:runId/artifacts (list and URLs).
- Tests: TV-INT-002, TV-INT-003, TV-API-014.

## Requirements covered
- RUN-005, RUN-006, INT-002, API-007.

## Implementation tasks
1. Add filefn client to runner and control plane (or shared package): upload stream/directory, get fileId; get download URL for fileId.
2. Run context: store artifact name → fileId (or URL) when upload step completes; pass run context to download step.
3. artifact/upload: read path from workspace; zip or upload files to filefn with key runId/artifact/name; save mapping in run context.
4. artifact/download: read name; get fileId from run context; download from filefn and extract to workspace.
5. GET /runs/:runId/artifacts: read artifact map from store; return { artifacts: [ { name, fileId, url } ] }; url from filefn downloadUrl when available.
6. cache/restore: resolve key (literal or evaluate expression); call cachefn get or filefn get; if found, extract to workspace (paths or root).
7. cache/save: resolve key; zip paths from workspace; call cachefn set or filefn put with key.
8. Tests: pipeline with upload then download in second job; list artifacts; cache save then restore in another run.

## Verification steps
- Run pipeline: job A uploads artifact name "dist" path "dist/"; job B needs A, downloads "dist". Assert job B workspace contains dist/ contents. GET /runs/:runId/artifacts returns { name: "dist", ... }.
- Run with cache/save key "deps-1" paths [node_modules]; second run with cache/restore key "deps-1"; assert workspace has node_modules (or mock). TV-INT-002, TV-INT-003 pass.
- Run tests: `npm test` for artifact and cache steps.

## Stop condition
- Artifact upload/download and cache restore/save work with filefn (and cachefn or filefn cache). TV-API-014 and TV-INT-002, TV-INT-003 pass. Report: "Phase 05 complete; artifacts and cache ready for Phase 06 (secrets, testfn, hostfn)."
