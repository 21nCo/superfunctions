# PHASE 08

## Phase goal
Migrate RecFn calendar token storage and refresh handling to shared OAuth packages.

## In scope / Out of scope

- **In scope:** recfn calendar token-store/token-refresh modules and integrations.
- **Out of scope:** recfn domain-specific calendar scheduling/business rules.

## Deliverables

- Shared OAuth-backed token store/refresh path in recfn.
- Compatibility wrapper or migration layer for existing recfn calendar interfaces.
- Updated calendar integration tests.

## Requirements covered

- OAUTH-012
- PLAT-004

## Implementation tasks

1. Replace local calendar token store interface with oauth-storage-backed abstraction.
2. Replace local refresh provider flow with oauth-flow/oauth-http-based refresh.
3. Preserve recfn route behavior and error mapping.
4. Add migration notes for any type/interface renames.

## Verification steps

1. Run:
```bash
npm -w recfn-server run test -- calendars
npm -w recfn-server run typecheck
```
Expected: calendar tests pass.

2. Run:
```bash
rg -n "interface CalendarTokenStore|interface TokenRefreshProvider" recfn/server/src/calendar
```
Expected: local duplicated interfaces removed or wrapper-only.

## Stop condition
RecFn calendar OAuth handling is shared-package backed with passing tests.
