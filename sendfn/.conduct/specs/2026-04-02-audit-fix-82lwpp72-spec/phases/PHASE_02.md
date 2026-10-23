# Phase goal

Make template rendering and email send orchestration correct, deterministic, and limit-aware in both SDKs.

## In scope / Out of scope

- In scope:
  - template engine correctness
  - template validation
  - email send validation
  - recipient/attachment limit enforcement
  - bounded retry behavior
- Out of scope:
  - webhook correlation
  - push batching
  - admin API envelopes

## Deliverables

- `sendfn/typescript/src/templates/engine.ts`
- `sendfn/typescript/src/templates/defaults.ts`
- `sendfn/typescript/src/email/service.ts`
- `sendfn/typescript/src/email/aws-ses-adapter.ts`
- `sendfn/python/sendfn/email/templates.py`
- `sendfn/python/sendfn/email/service.py`
- `sendfn/python/sendfn/email/aws_ses.py`
- `sendfn/typescript/tests/templates.test.ts` (new)
- `sendfn/typescript/tests/email.test.ts` (new)
- `sendfn/python/tests/test_templates.py` (new)
- `sendfn/python/tests/test_email_service.py` (new)

## Requirements covered

- `EMAIL-001`
- `EMAIL-002`
- `EMAIL-003`
- `PARITY-001`

## Implementation tasks

1. Implement `#each` support in the TypeScript template engine.
2. Reorder Python template rendering so control blocks are processed correctly before plain variable substitution.
3. Enforce deterministic escaping and malformed-template failure behavior.
4. Validate resolved email content before transaction creation and provider calls.
5. Enforce 50-recipient and 10 MiB attachment caps before provider invocation.
6. Replace raw generic exceptions in email send paths with typed `SendfnError` subclasses and stable codes.
7. Add regression tests covering positive and negative template/email vectors in both SDKs.

## Verification steps

1. Run `npm test --workspace sendfn/typescript -- --run templates email`.
   - Expected outcome: TS template and email service tests pass.
2. Run `python3 -m pytest sendfn/python/tests/test_templates.py sendfn/python/tests/test_email_service.py`.
   - Expected outcome: Python template and email service tests pass.
3. Run a manual fixture render for `TV-EMAIL-001-P`.
   - Expected outcome: rendered output matches the vector exactly in both SDKs.

## Stop condition

Stop after the shared positive and negative email/template vectors pass identically in TypeScript and Python.
