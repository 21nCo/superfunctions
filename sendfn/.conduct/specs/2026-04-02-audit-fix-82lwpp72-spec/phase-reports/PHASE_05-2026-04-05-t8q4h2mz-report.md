# Metadata

- timestamp: 2026-04-05T09:22:04Z
- agent_name: unknown-agent
- model: unknown
- launcher: Codex Desktop
- workspace/project path: repo root
- os: Darwin arm64
- shell: zsh
- git.branch: detached HEAD
- git.commit: `7adae77`
- git.dirty: true

# Phase

- Phase: `PHASE_05`
- Status: `PASS`

# Requirements summary

- Requirements delivered:
  - `PUSH-001`
  - `DEVICE-001`
  - `PERF-001`
  - `PARITY-001`

## PUSH-001

- Status: `PASS`
- Acceptance criteria evidence:
  - `sendfn/typescript/src/push/fcm.ts` now chunks FCM token sends at `MAX_FCM_BATCH_SIZE = 500` and aggregates provider results across batches.
  - `sendfn/python/sendfn/push/fcm.py` mirrors the same 500-token batching behavior and aggregate result handling.
  - `sendfn/typescript/src/push/apns.ts` now processes APNS token sends through a bounded concurrency mapper with a cap of 10 in-flight requests.
  - `sendfn/python/sendfn/push/apns.py` mirrors the APNS concurrency cap with semaphore-bounded async execution.
  - `sendfn/typescript/src/push/service.ts` and `sendfn/python/sendfn/push/service.py` now deactivate invalid device tokens before resolving and surface deterministic aggregate `sentCount` / `failedCount` values.
  - Both push services now return the first processed platform in stable order (`android`, `ios`, `web`) and include all created notification IDs in `metadata.notificationIds` in that same stable order.
  - `sendfn/typescript/tests/push.test.ts` verifies FCM 500-token chunking, APNS concurrency capping, invalid-token deactivation before resolution, and stable multi-platform return semantics.
  - `sendfn/python/tests/test_push.py` verifies the same Python-side chunking, APNS cap, invalid-token deactivation, and deterministic multi-platform behavior.
- Test status:
  - `npm test --workspace sendfn/typescript -- --run push` passed with 6 push tests.
  - `.venv-sendfn-phase5/bin/python -m pytest sendfn/python/tests/test_push.py -q` passed with 5 Python push tests.
  - Manual vector artifact `sendfn/.conduct/specs/2026-04-02-audit-fix-82lwpp72-spec/phase-artifacts/PHASE_05-manual-vectors.ts` passed `TV-PUSH-001-P` and `TV-PUSH-001-N`.

## DEVICE-001

- Status: `PASS`
- Acceptance criteria evidence:
  - `sendfn/typescript/src/push/device-manager.ts` now refreshes device tokens by validating the old token for the supplied user/platform, preserving `appVersion` and `deviceInfo`, and re-registering the replacement token without duplication.
  - `sendfn/python/sendfn/push/device_manager.py` mirrors the same old-token validation and metadata-preserving refresh flow.
  - `sendfn/typescript/src/push/device-manager.ts` and `sendfn/python/sendfn/push/device_manager.py` continue to reactivate an existing `(userId, token, platform)` registration instead of inserting duplicates.
  - `sendfn/python/sendfn/database/helpers.py` now normalizes device token IDs consistently so reactivation, cleanup, and deactivation operate correctly in the memory adapter and remain deterministic.
  - `sendfn/typescript/tests/push.test.ts` verifies re-registration reactivates instead of duplicating, refresh preserves metadata, missing old token returns `SENDFN_VALIDATION_ERROR`, and cleanup removes inactive rows older than the cutoff.
  - `sendfn/python/tests/test_push.py` verifies the same Python-side refresh, reactivation, validation-error, and cleanup behavior.
- Test status:
  - TypeScript device lifecycle assertions passed in `tests/push.test.ts`.
  - Python device lifecycle assertions passed in `sendfn/python/tests/test_push.py`.
  - Manual vector artifact passed `TV-DEVICE-001-P` and `TV-DEVICE-001-N`.

## PERF-001

- Status: `PASS`
- Acceptance criteria evidence:
  - `sendfn/typescript/src/utils/concurrency.ts` introduces a reusable bounded-concurrency mapper, and `sendfn/python/sendfn/_concurrency.py` mirrors it for the Python SDK.
  - `sendfn/typescript/src/push/service.ts` and `sendfn/python/sendfn/push/service.py` now execute bulk push operations with bounded concurrency instead of a purely sequential wrapper over single-send operations.
  - `sendfn/typescript/src/types.ts`, `sendfn/python/sendfn/models.py`, and `sendfn/python/sendfn/client.py` now expose/configure `bulkConcurrency` / `bulk_concurrency` so concurrency is bounded by default and configurable.
  - `sendfn/typescript/src/email/service.ts` now uses the same bounded-concurrency helper for bulk email, satisfying the production-readiness requirement that TypeScript bulk email not remain a plain sequential loop.
  - `sendfn/typescript/tests/push.test.ts` includes non-sequential gate assertions for bulk push and bulk email, and a strict APNS concurrency-cap gate for the TypeScript SDK.
  - `sendfn/python/tests/test_push.py` includes equivalent non-sequential bulk-push and APNS concurrency-cap gate assertions for the Python SDK.
- Test status:
  - `npm test --workspace sendfn/typescript -- --run push` passed with bounded-concurrency assertions active.
  - `.venv-sendfn-phase5/bin/python -m pytest sendfn/python/tests/test_push.py -q` passed with bounded-concurrency assertions active.
  - Manual vector artifact passed `TV-PERF-001-P` and reported observed max concurrency of `5` for both bulk push and bulk email.

## PARITY-001

- Status: `PASS`
- Acceptance criteria evidence:
  - `sendfn/typescript/src/push/service.ts` and `sendfn/python/sendfn/push/service.py` now share the same stable platform ordering, notification ID metadata shape, invalid-token deactivation timing, and aggregate count semantics.
  - `sendfn/typescript/src/push/device-manager.ts` and `sendfn/python/sendfn/push/device_manager.py` now share the same validation semantics and metadata-preserving token-refresh behavior.
  - `sendfn/typescript/src/push/fcm.ts` / `sendfn/python/sendfn/push/fcm.py` and `sendfn/typescript/src/push/apns.ts` / `sendfn/python/sendfn/push/apns.py` now enforce equivalent provider caps in both SDKs.
  - The phase test suites cover matching positive and negative cases across both SDKs for push determinism, lifecycle handling, and bounded concurrency.
- Test status:
  - TypeScript and Python phase-specific push suites both passed.
  - Manual vectors passed the shared push/device/performance scenarios used to validate parity-sensitive behavior.

# Deliverables summary

- Files changed/added:
  - `sendfn/.conduct/specs/2026-04-02-audit-fix-82lwpp72-spec/phase-artifacts/PHASE_05-manual-vectors.ts`
  - `sendfn/python/sendfn/_concurrency.py`
  - `sendfn/python/sendfn/client.py`
  - `sendfn/python/sendfn/database/helpers.py`
  - `sendfn/python/sendfn/models.py`
  - `sendfn/python/sendfn/push/apns.py`
  - `sendfn/python/sendfn/push/device_manager.py`
  - `sendfn/python/sendfn/push/fcm.py`
  - `sendfn/python/sendfn/push/service.py`
  - `sendfn/python/tests/test_push.py`
  - `sendfn/typescript/src/email/service.ts`
  - `sendfn/typescript/src/push/apns.ts`
  - `sendfn/typescript/src/push/device-manager.ts`
  - `sendfn/typescript/src/push/fcm.ts`
  - `sendfn/typescript/src/push/service.ts`
  - `sendfn/typescript/src/types.ts`
  - `sendfn/typescript/src/utils/concurrency.ts`
  - `sendfn/typescript/tests/push.test.ts`
- Files deleted/modified:
  - No files were deleted.

# Verification summary

- Phase verification steps executed:
  - `npm test --workspace sendfn/typescript -- --run push` -> passed
  - `python3 -m pytest sendfn/python/tests/test_push.py` -> blocked by local environment (`python3` is 3.9 here, while the repo-local `sendfn/python` flow requires Python 3.10+ and the plain invocation does not provide the editable `superfunctions` install)
  - `python3.13 -m venv .venv-sendfn-phase5` -> passed
  - `.venv-sendfn-phase5/bin/python -m pip install -e ./packages/python-core -e './sendfn/python[dev]'` -> passed
  - `.venv-sendfn-phase5/bin/python -m pytest sendfn/python/tests/test_push.py -q` -> passed
  - `./node_modules/.bin/vite-node --config sendfn/typescript/vitest.config.ts sendfn/.conduct/specs/2026-04-02-audit-fix-82lwpp72-spec/phase-artifacts/PHASE_05-manual-vectors.ts` -> passed
- Test execution results:
  - TypeScript:
    - `tests/push.test.ts`: 6 passed
    - Total: 6 passed, 0 failed
  - Python:
    - `sendfn/python/tests/test_push.py`: 5 passed
    - Total: 5 passed, 0 failed
  - Manual vectors:
    - `TV-PUSH-001-P`: passed
    - `TV-PUSH-001-N`: passed
    - `TV-DEVICE-001-P`: passed
    - `TV-DEVICE-001-N`: passed
    - `TV-PERF-001-P`: passed
  - Non-blocking warnings:
    - Vite emitted an existing deprecation warning about the CJS build of the Vite Node API when running the manual vector artifact.
    - Python 3.13 test runs emitted existing Pydantic and `datetime.utcnow()` deprecation warnings from shared repo codepaths.

# Notes

- The local `python3` binary in this environment is Python 3.9.x, while the repo-local `sendfn/python` verification flow requires Python 3.10+; verification therefore used `python3.13` in a temporary virtual environment after recording the default-command failure. The temporary venv was removed after verification.
- `PHASE_05.md` lists push/device deliverables only, but `PERF-001` also required fixing the sequential TypeScript bulk-email path. The phase therefore intentionally updated `sendfn/typescript/src/email/service.ts` and added shared concurrency helpers in both SDKs to satisfy the requirement rather than stopping at the narrower deliverables list.
- Python push providers now import optional provider SDKs lazily so the package can be imported and tested in the repo-local dev environment without `firebase-admin` or `aioapns` installed unless those providers are actually initialized.
- `sendfn/python/sendfn/database/helpers.py` needed an additional ID-normalization fix so the Python memory adapter handled device-row updates and cleanup deterministically under the new lifecycle coverage.
- No new TODOs or deferrals were introduced.

# Ready for next phase?

- Yes. Push/device determinism, provider caps, token invalidation, and bounded bulk concurrency are now implemented and verified for both SDKs, so `PHASE_06` is unblocked.

# Blockers

- None.
