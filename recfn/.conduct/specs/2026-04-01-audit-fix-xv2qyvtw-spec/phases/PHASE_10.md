# Phase goal

Close the Python SDK, CLI, and desktop capture gaps identified by the audit.

## In scope / Out of scope

- In scope:
  - Python parity for audited surfaces
  - CLI redaction-safe defaults
  - desktop session lifecycle control
- Out of scope:
  - server persistence or platform capture internals

## Deliverables

- `recfn/python/recfn/client.py`
- `recfn/python/recfn/ws.py`
- `recfn/python/recfn/resources/recordings.py`
- `recfn/python/tests/test_client.py`
- `recfn/python/tests/test_ws.py`
- `recfn/cli/src/index.ts`
- `recfn/cli/src/commands/transcript.ts`
- `recfn/cli/__tests__/cli.test.ts`
- `recfn/desktop/src/recorder.ts`
- `recfn/desktop/src/capture.ts`
- `recfn/desktop/src/uploader.ts`
- `recfn/desktop/__tests__/recorder.test.ts`
- `recfn/desktop/__tests__/uploader.test.ts`

## Requirements covered

- `SDK-001`
- `CLI-001`
- `DSK-001`

## Implementation tasks

1. Add Python `recordings.upload(...)` and update WS parsing for canonical status frames.
2. Make CLI transcript output redacted by default and add explicit raw opt-in.
3. Replace the desktop recorder hard-coded 2-second stop with caller-controlled lifecycle behavior.
4. Add or update tests for all three package surfaces.

## Verification steps

- `npm test --workspace recfn-cli`
- `npm test --workspace recfn-desktop`
- `PYTHONPATH=recfn/python python3 -m pytest recfn/python/tests`

Expected outcome:

- Python parity gaps close, CLI defaults are safe, and desktop recording duration is caller-controlled.

## Stop condition

Report back with passing SDK, CLI, and desktop tests plus the final user-facing CLI flag behavior.

