# Phase goal

Establish a deterministic hardening baseline and migration gate criteria before any code movement.

## In scope / Out of scope

- **In scope**:
  - Current-state inventory of `plugfn` OAuth, webhooks, routing, HTTP transport, and test failures.
  - Provider policy matrix draft for Gmail/Outlook/Yahoo/iCloud/IMAP.
  - Release gate checklist scaffolding.
- **Out of scope**:
  - Implementing new runtime behavior.
  - Shipping any adapter code.

## Deliverables

- `plugfn/docs/architecture/hardening-baseline.md`
- `plugfn/docs/architecture/provider-policy-matrix.md`
- `plugfn/docs/operations/release-gates.md`
- `plugfn/typescript/tests/baseline/current-failures.snapshot.md`

## Requirements covered

- ARCH-002
- OPS-001
- OPS-002

## Implementation tasks

1. Enumerate all current OAuth logic entrypoints and duplication points.
2. Record failing tests and classify by root cause category.
3. Define initial provider policy fields and default states for each email provider.
4. Define pass/fail release gates mapped to requirement IDs and vectors.
5. Commit baseline artifacts for subsequent phases to consume.

## Verification steps

1. `cd /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript && npm test -- --run || true`
Expected outcome: command output captured; failures referenced in baseline snapshot.
2. `rg -n "oauth|webhook|state|token" /Users/serro/Documents/dev/n/superfunctions/plugfn/typescript/src > /tmp/plugfn-oauth-inventory.txt`
Expected outcome: inventory file exists and is referenced in baseline doc.
3. `test -f /Users/serro/Documents/dev/n/superfunctions/plugfn/docs/architecture/hardening-baseline.md`
Expected outcome: file exists with requirement mappings.

## Stop condition

Baseline docs and release gates exist, are reviewed, and explicitly reference current failures and policy gaps.
