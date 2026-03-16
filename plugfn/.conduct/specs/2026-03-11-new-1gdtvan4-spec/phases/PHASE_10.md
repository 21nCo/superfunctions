# Phase goal

Implement forwarding fallback and managed-mailbox safety model with policy registry enforcement.

## In scope / Out of scope

- **In scope**:
  - Forwarding inbound connector.
  - Managed mailbox opt-in + risk acknowledgment + backup channel requirements.
  - Runtime policy registry enforcement for these flows.
- **Out of scope**:
  - Finatron parsing details.

## Deliverables

- `plugfn/typescript/src/providers/forwarding/index.ts`
- `plugfn/typescript/src/providers/managed-mail/index.ts`
- `plugfn/typescript/src/mail/managed-policy.ts`
- `plugfn/typescript/src/mail/backup-channel.ts`
- `plugfn/typescript/src/policy/provider-policy-service.ts`
- `plugfn/typescript/tests/providers/forwarding.test.ts`
- `plugfn/typescript/tests/providers/managed-mail.test.ts`
- `plugfn/typescript/tests/policy/provider-policy-service.test.ts`

## Requirements covered

- MAIL-006
- MAIL-007
- MAIL-010

## Implementation tasks

1. Implement forwarding connector as inbound-only capability.
2. Implement managed mailbox lifecycle with explicit consent state.
3. Add finance-critical guardrails: backup destination and risk acknowledgment.
4. Integrate provider policy checks before enabling operations.
5. Emit audit events for all policy decisions and state transitions.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run tests/providers/forwarding.test.ts tests/providers/managed-mail.test.ts tests/policy/provider-policy-service.test.ts`
2. Run manual API checks for managed mailbox setup with and without safeguards.
Expected outcome: guarded setup passes only with required controls; missing controls fail with canonical policy error.

## Stop condition

Forwarding and managed mailbox modes operate safely with enforced policy and explicit user consent requirements.
