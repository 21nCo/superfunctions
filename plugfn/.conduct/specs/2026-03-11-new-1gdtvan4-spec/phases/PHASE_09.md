# Phase goal

Deliver Yahoo, iCloud, and generic IMAP/SMTP adapters with secure defaults and policy enforcement.

## In scope / Out of scope

- **In scope**:
  - Yahoo OAuth IMAP/SMTP adapter.
  - iCloud IMAP/SMTP adapter with app-password constraints.
  - Generic IMAP/SMTP adapter and capability flags.
- **Out of scope**:
  - Forwarding and managed mailbox safety controls.

## Deliverables

- `plugfn/typescript/src/providers/yahoo/index.ts`
- `plugfn/typescript/src/providers/icloud/index.ts`
- `plugfn/typescript/src/providers/imap-smtp/index.ts`
- `plugfn/typescript/src/providers/imap-smtp/imap-client.ts`
- `plugfn/typescript/src/providers/imap-smtp/smtp-client.ts`
- `plugfn/typescript/src/providers/index.ts` (registration updates)
- `plugfn/typescript/tests/providers/yahoo.test.ts`
- `plugfn/typescript/tests/providers/icloud.test.ts`
- `plugfn/typescript/tests/providers/imap-smtp.test.ts`

## Requirements covered

- ARCH-003
- ARCH-004
- MAIL-003
- MAIL-004
- MAIL-005
- MAIL-010

## Implementation tasks

1. Implement Yahoo adapter with policy-gated OAuth setup checks.
2. Implement iCloud adapter with IMAP/SMTP and POP rejection path.
3. Implement generic IMAP/SMTP adapter with TLS-on default and explicit insecure override.
4. Normalize all outputs into canonical mail model.
5. Add contract and negative-path tests for policy and transport safety.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run tests/providers/yahoo.test.ts tests/providers/icloud.test.ts tests/providers/imap-smtp.test.ts`
2. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run tests/providers/provider-contracts.test.ts`
Expected outcome: all three provider adapters pass conformance and safety checks.

## Stop condition

Yahoo/iCloud/generic IMAP adapters are fully integrated and policy-compliant.
