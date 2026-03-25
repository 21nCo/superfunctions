# PHASE_09

- Phase goal: Delete the legacy Nucleus file code after successful cutover, finalize docs/examples, and prove the final steady state.
- In scope / Out of scope
  - In scope: removal of temporary compatibility/legacy code, final docs, example/demo smoke, final verification matrix.
  - Out of scope: new functionality beyond what this bundle already specifies.
- Deliverables
  - final cleanup of legacy Nucleus upload/render code under `/Users/serro/Documents/dev/n/nucleus/client/`
  - `filefn/examples/full-demo/README.md`
  - `filefn/examples/production/server/src/index.ts`
  - `filefn/python/README.md`
  - `filefn/viewer/README.md`
  - final migration completion report and rollback archive references
- Requirements covered
  - `BUILD-001`
  - `NUCLEUS-002`
  - `DEMO-001`
  - `MIG-002`
- Implementation tasks
  1. Remove temporary dual-read compatibility once migration verification succeeds.
  2. Delete legacy Nucleus `uploadFileV2`-era steady-state code and signed-URL refresh code.
  3. Update FileFn and viewer docs/examples to reflect the final architecture.
  4. Run the full local verification matrix and record the completion report.
- Verification steps
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/server test -- --run`
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/client test -- --run`
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/processing test -- --run`
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/viewer test -- --run`
  - `python3 -m pytest /Users/serro/Documents/dev/n/superfunctions/filefn/python/tests`
  - `npm --prefix /Users/serro/Documents/dev/n/nucleus/tests test`
  - `node /Users/serro/Documents/dev/n/superfunctions/filefn/examples/full-demo/smoke.mjs`
  - Expected outcome: the entire matrix passes and no legacy Nucleus steady-state file code remains.
- Stop condition
  - Report the exact deleted legacy entry points, attach the final verification matrix, and confirm the migration window has been closed.
