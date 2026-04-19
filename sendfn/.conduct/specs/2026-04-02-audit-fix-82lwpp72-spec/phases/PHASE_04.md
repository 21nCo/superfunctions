# Phase goal

Secure and correlate SES webhook processing so verified lifecycle events mutate authoritative state deterministically.

## In scope / Out of scope

- In scope:
  - SNS signature verification
  - verified-message parsing
  - lifecycle status transitions
  - orphan-event handling
  - webhook route hardening
- Out of scope:
  - push batching
  - README/example alignment

## Deliverables

- `sendfn/typescript/src/events/aws-sns-verifier.ts` (new)
- `sendfn/typescript/src/events/webhook-handler.ts`
- `sendfn/typescript/src/sendfn.ts`
- `sendfn/python/sendfn/events/aws_sns_verifier.py` (new)
- `sendfn/python/sendfn/events/webhook_handler.py`
- `sendfn/python/sendfn/http/routes.py`
- `sendfn/typescript/tests/webhook.test.ts` (new)
- `sendfn/python/tests/test_webhook_handler.py` (new)
- `sendfn/python/tests/test_http_routes.py` (new)

## Requirements covered

- `WEBHOOK-001`
- `WEBHOOK-002`
- `API-002`
- `OBS-001`

## Implementation tasks

1. Implement SNS verification helpers in both SDKs.
2. Reject invalid signatures, timestamps, and certificate hosts before DB mutation.
3. Correlate verified events to internal transactions via `providerMessageId`.
4. Apply deterministic lifecycle transitions and idempotent duplicate handling.
5. Replace fabricated `"unknown"` references with deterministic orphan reference IDs.
6. Return canonical JSON envelopes from webhook routes.
7. Add webhook verification and correlation regression tests.

## Verification steps

1. Run `npm test --workspace sendfn/typescript -- --run webhook`.
   - Expected outcome: TS webhook tests pass.
2. Run `python3 -m pytest sendfn/python/tests/test_webhook_handler.py sendfn/python/tests/test_http_routes.py`.
   - Expected outcome: Python webhook and route tests pass.
3. Manually exercise `TV-WEBHOOK-001-P`, `TV-WEBHOOK-001-N`, `TV-WEBHOOK-002-P`, and `TV-WEBHOOK-002-N`.
   - Expected outcome: exact vector expectations are met, including zero mutation on invalid signatures.

## Stop condition

Stop after verified webhook processing is cryptographically gated, correlated, idempotent, and free of fabricated `"unknown"` references.
