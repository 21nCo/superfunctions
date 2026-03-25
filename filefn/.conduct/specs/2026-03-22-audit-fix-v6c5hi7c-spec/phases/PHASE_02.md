# PHASE_02

- Phase goal: Add logical storage targets and routed physical multi-bucket support without changing FileFn core’s bucket-agnostic contract.
- In scope / Out of scope
  - In scope: storage-router plugin/wrapper, policy `storageTarget` support, artifact target routing, TS/Python routed-storage parity.
  - Out of scope: PDF preview generation, viewer package, Nucleus write/read adoption.
- Deliverables
  - `packages/storage/src/index.ts`
  - new `packages/storage/src/router.ts`
  - `packages/storage/src/types.ts` only if additive typings are required
  - `packages/storage/tests/` or `packages/storage/src/__tests__/` routed-adapter tests
  - `filefn/server/src/policies.ts`
  - `filefn/server/src/upload-sessions/service.ts`
  - `filefn/server/src/processing/service.ts`
  - `filefn/python/filefn/server/policies.py`
  - new routed storage helper under `filefn/python/filefn/server/` or `filefn/python/filefn/storage/`
- Requirements covered
  - `STORAGE-001`
  - `DEDUPE-001`
  - `POLICY-001`
  - `PY-001`
  - `PY-002`
  - `BUILD-001`
- Implementation tasks
  1. Define logical storage target semantics in policy models.
  2. Implement routed storage adapter wrapper for TS and Python.
  3. Ensure original files and artifacts can target different logical storage targets.
  4. Add routed-storage tests for durable vs temporary behavior and unknown target failure cases.
  5. Verify delete/dedupe semantics still work when routing is enabled.
- Verification steps
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/packages/storage test -- --run`
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/packages/storage run typecheck`
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/server test -- --run src/__tests__/files.test.ts src/__tests__/delete-cascade.test.ts src/__tests__/upload-sessions.test.ts`
  - `python3 -m pytest /Users/serro/Documents/dev/n/superfunctions/filefn/python/tests`
  - Expected outcome: routed storage tests pass and FileFn integration tests prove logical target behavior.
- Stop condition
  - Report the chosen logical target names, routed adapter entry points, and proof that FileFn core stayed bucket-agnostic.
