# PHASE_03

- Phase goal: Upgrade processing so FileFn can generate canonical image thumbnails and PDF preview artifacts on both TS and Python.
- In scope / Out of scope
  - In scope: TS processing wiring fix, PDF preview processor, canonical artifact kinds, artifact access parity.
  - Out of scope: client HEIC preprocessing, viewer package, Nucleus cutover.
- Deliverables
  - `filefn/processing/src/index.ts`
  - new `filefn/processing/src/processors/pdf-preview.ts`
  - `filefn/processing/src/processors/thumbnail.ts`
  - `filefn/server/src/index.ts`
  - `filefn/server/src/processing/service.ts`
  - `filefn/server/src/processing/routes.ts`
  - `filefn/server/src/__tests__/processing.test.ts`
  - `filefn/server/src/__tests__/artifact-authz.test.ts`
  - `filefn/python/filefn/processing/__init__.py`
  - new `filefn/python/filefn/processing/processors/pdf_preview.py`
  - `filefn/python/filefn/server/processing/service.py`
  - Python processing tests
- Requirements covered
  - `PROCESS-001`
  - `PROCESS-002`
  - `FILE-002`
  - `PY-001`
  - `PY-002`
  - `PY-003`
  - `BUILD-001`
- Implementation tasks
  1. Pass `processingService` into TS upload-session completion.
  2. Implement PDF first-page preview processor with canonical artifact kinds.
  3. Keep image thumbnail artifact kinds stable.
  4. Add artifact tests for PDF preview list/download/auth.
  5. Mirror the processing capability in Python and cover it in pytest.
- Verification steps
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/processing test -- --run`
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/processing run typecheck`
  - `npm --prefix /Users/serro/Documents/dev/n/superfunctions/filefn/server test -- --run src/__tests__/processing.test.ts src/__tests__/artifact-authz.test.ts`
  - `python3 -m pytest /Users/serro/Documents/dev/n/superfunctions/filefn/python/tests`
  - Expected outcome: processing fires automatically on TS and PDF/image artifacts are produced with canonical kinds.
- Stop condition
  - Report the artifact kinds emitted for image and PDF inputs and confirm TS/Python parity status.
