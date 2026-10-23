# PHASE_05

- Phase goal: Introduce the canonical FileFn render/view model through a render descriptor API and the new `@filefn/viewer` package.
- In scope / Out of scope
  - In scope: server render route, client `resolveRenderable`, new viewer package, deterministic render selection and placeholders.
  - Out of scope: Nucleus migration/cutover code, legacy manifest tooling.
- Deliverables
  - `filefn/server/src/files/routes.ts`
  - `filefn/server/src/files/service.ts`
  - `filefn/client/src/index.ts`
  - `filefn/client/src/client.ts`
  - new `filefn/viewer/package.json`
  - new `filefn/viewer/src/index.ts`
  - new `filefn/viewer/src/resolver.ts`
  - new `filefn/viewer/src/__tests__/`
- Requirements covered
  - `API-001`
  - `FILE-002`
  - `VIEW-001`
  - `VIEW-002`
  - `BUILD-001`
- Implementation tasks
  1. Add `GET /:fileId/render` server route and descriptor selection logic.
  2. Add client `listArtifacts`, `downloadArtifact`, and `resolveRenderable`.
  3. Create `@filefn/viewer` with framework-agnostic resolution helpers.
  4. Add placeholder semantics for unsupported or still-processing preview cases.
  5. Add unit tests covering image, PDF, pending-local, and generic-file flows.
- Verification steps
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/server test -- --run src/__tests__/files.test.ts src/__tests__/artifact-authz.test.ts`
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/client test -- --run`
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/viewer test -- --run`
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/viewer run typecheck`
  - Expected outcome: descriptor and viewer tests pass for remote and local resolution cases.
- Stop condition
  - Report the final render descriptor schema and the fallback order for each render intent.
