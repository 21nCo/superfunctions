# PHASE_16: Superfunction-backed Patterns

## Phase Goal

Implement Superfunction-backed pattern variants in `@uifn/sf`.

## In Scope

- authfn panels.
- plugfn panels.
- filefn panels.
- billfn panels.
- typed injected client contracts.
- mock clients.
- Storybook decorators.

## Out of Scope

- Backend implementation changes.
- Real service calls in Storybook.

## Deliverables

- `uifn/sf/src/authfn/*`
- `uifn/sf/src/plugfn/*`
- `uifn/sf/src/filefn/*`
- `uifn/sf/src/billfn/*`
- `uifn/sf/src/mocks/*`
- sf manifests and registry items

## Requirements Covered

SF-001, SF-002, SEC-001, STORY-001

## Implementation Tasks

1. Define narrow client contracts for each Superfunction.
2. Implement backed variants over controlled patterns.
3. Implement mock clients with fake data.
4. Add loading, error, partial, optimistic, and success tests.
5. Add secret redaction tests.
6. Add Storybook mock decorators.

## Verification Steps

```bash
npm --workspace @uifn/sf run test
npm run verify:uifn-sf
npm run verify:uifn-secrets
```

Expected outcome: backed patterns pass injected-client, mock, state, and redaction tests.

## Stop Condition

Report client contracts and any backend API gaps.
