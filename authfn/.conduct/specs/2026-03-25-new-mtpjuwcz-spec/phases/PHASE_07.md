# Phase goal

Polish the authfn example portfolio documentation and run the full deterministic verification matrix.

## In scope / Out of scope

- In scope:
  - README polish
  - selector-contract checks
  - no-external-network verification
  - final cross-example test matrix
- Out of scope:
  - new feature scope beyond the defined five examples

## Deliverables

- `authfn/examples/README.md`
- `authfn/examples/password-sessions/README.md`
- `authfn/examples/otp-recovery/README.md`
- `authfn/examples/social-oauth/README.md`
- `authfn/examples/account-settings/README.md`
- `authfn/examples/multi-region-routing/README.md`
- `authfn/examples/shared/src/e2e/validate-ui-contract.ts`
- `authfn/examples/shared/src/e2e/validate-no-external-network.ts`

## Requirements covered

- `EXAUTH-011`
- `EXAUTH-012`
- `EXAUTH-013`

## Implementation tasks

1. Confirm that the portfolio index README lists all examples, ports, and commands.
2. Confirm that each example README matches the actual package scripts.
3. Add a shared selector-contract validator or equivalent Playwright assertion helper.
4. Add a shared external-network guard or equivalent test helper.
5. Run the full example matrix and capture any remaining deterministic failures.
6. Update docs/screens/notes only as needed to match the final working behavior.

## Verification steps

- Run all example suites:

```bash
npm --prefix authfn/examples/password-sessions run test:e2e
npm --prefix authfn/examples/otp-recovery run test:e2e
npm --prefix authfn/examples/social-oauth run test:e2e
npm --prefix authfn/examples/account-settings run test:e2e
npm --prefix authfn/examples/multi-region-routing run test:e2e
```

  - Expected: all suites pass.
- Run the selector-contract validator.
  - Expected: documented `data-testid` selectors are present.
- Run the external-network guard validation.
  - Expected: no non-local requests are attempted.

## Stop condition

Report the final command matrix, the full test pass set, and any explicitly documented residual risks.
