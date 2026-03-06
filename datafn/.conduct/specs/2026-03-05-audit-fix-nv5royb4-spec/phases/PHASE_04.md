# PHASE 04

## Phase goal
Remove route hot-path dynamic imports, eliminate synthetic REST request bridge, and complete logger-only request logging.

## In scope / Out of scope
In scope:
- Static imports in route handlers.
- REST bridge internal call cleanup.
- `logRequest` console fallback removal.

Out of scope:
- Refactor query module split.

## Deliverables
- `datafn/server/src/routes/mutation.ts`
- `datafn/server/src/server.ts`
- `datafn/server/src/logging.ts`
- Static-check tests/scripts

## Requirements covered
- FIX-PER-002
- FIX-SRV-001
- FIX-LOG-002

## Implementation tasks
- [ ] Move dynamic authz import in mutation route to top-level static import.
- [ ] Replace `new Request(...)` REST bridge with direct internal execution helpers.
- [ ] Remove `console.log` fallback in `logRequest`.

## Verification steps
- `rg -n "await import\(" datafn/server/src/routes`
- `rg -n "new Request\(\"http://localhost/datafn/" datafn/server/src/server.ts`
- `rg -n "console\." datafn/server/src/logging.ts`
- Expected: no matches.

## Stop condition
All static checks for this phase pass and route tests remain green.
