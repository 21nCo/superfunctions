# PHASE_01

- Phase goal: Bring Python back to semantic parity for the carried-forward server/storage behaviors and add parity/redaction coverage.
- In scope / Out of scope
  - In scope: Python list/read/delete parity, share/proxy counter timing, redaction parity, imports/tests for the new bundle baseline.
  - Out of scope: routed storage, PDF preview processor, viewer package, Nucleus integration.
- Deliverables
  - `filefn/python/filefn/server/upload_sessions/service.py`
  - `filefn/python/filefn/server/files/service.py`
  - `filefn/python/filefn/server/shares/service.py`
  - `filefn/python/filefn/server/__init__.py`
  - `filefn/python/filefn/server/events.py`
  - `filefn/python/tests/test_upload_flow.py`
  - `filefn/python/tests/test_downloads.py`
  - `filefn/python/tests/test_processing.py`
  - new redaction/parity-focused Python tests as needed under `filefn/python/tests/`
- Requirements covered
  - `AUTH-001`
  - `AUTH-002`
  - `FILE-001`
  - `FILE-003`
  - `OBS-001`
  - `PY-001`
  - `PY-002`
  - `PY-003`
  - `BUILD-001`
- Implementation tasks
  1. Return version-aware metadata from Python `get_file(version_id=...)`.
  2. Make Python `list_files()` deterministic and cursor-correct.
  3. Make Python delete cascade metadata-complete and reference-safe.
  4. Fix Python share/proxy counter timing to match TS semantics.
  5. Add Python secret-redaction helpers/tests equivalent to TS observability guarantees.
  6. Expand Python pytest coverage for all corrected behaviors.
- Verification steps
  - `python3 -m pytest /Users/serro/Documents/dev/n/superfunctions/filefn/python/tests`
  - `python3 -c "from filefn.server import create_file_fn, FileFnConfig; print('ok')"`
  - Expected outcome: pytest exits `0`; imports succeed; parity-focused tests demonstrate TS/Python alignment.
- Stop condition
  - Report exact Python semantic deltas removed and reference the parity tests proving each one.
