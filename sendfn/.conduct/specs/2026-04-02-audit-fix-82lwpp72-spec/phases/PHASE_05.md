# Phase goal

Fix push/device scalability and determinism by enforcing provider caps, deterministic returns, token invalidation, and lifecycle helpers.

## In scope / Out of scope

- In scope:
  - FCM chunking
  - APNS concurrency cap
  - deterministic multi-platform return behavior
  - invalid-token deactivation
  - token refresh and cleanup helpers
- Out of scope:
  - new push providers
  - docs/examples

## Deliverables

- `sendfn/typescript/src/push/service.ts`
- `sendfn/typescript/src/push/fcm.ts`
- `sendfn/typescript/src/push/apns.ts`
- `sendfn/typescript/src/push/device-manager.ts`
- `sendfn/python/sendfn/push/service.py`
- `sendfn/python/sendfn/push/fcm.py`
- `sendfn/python/sendfn/push/apns.py`
- `sendfn/python/sendfn/push/device_manager.py`
- `sendfn/typescript/tests/push.test.ts` (new)
- `sendfn/python/tests/test_push.py` (new)

## Requirements covered

- `PUSH-001`
- `DEVICE-001`
- `PERF-001`
- `PARITY-001`

## Implementation tasks

1. Chunk FCM sends at 500 tokens in both SDKs.
2. Add APNS concurrency limiter capped at 10.
3. Ensure invalid tokens are deactivated before resolution.
4. Implement deterministic stable-order return semantics and `metadata.notificationIds`.
5. Add refresh-token and cleanup helpers to device lifecycle management.
6. Add push/device regression tests, including timing/concurrency assertions in mocked environments.

## Verification steps

1. Run `npm test --workspace sendfn/typescript -- --run push`.
   - Expected outcome: TS push tests pass.
2. Run `python3 -m pytest sendfn/python/tests/test_push.py`.
   - Expected outcome: Python push tests pass.
3. Manually exercise `TV-PUSH-001-P`, `TV-PUSH-001-N`, `TV-DEVICE-001-P`, `TV-DEVICE-001-N`, and `TV-PERF-001-P`.
   - Expected outcome: exact vector expectations are met.

## Stop condition

Stop after push fan-out obeys provider limits, invalid tokens are cleaned up deterministically, and device lifecycle helpers cover refresh and cleanup flows.
