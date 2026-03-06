# PHASE 09

## Phase goal
Run full verification sweep and finalize audit-fix completion evidence.

## In scope / Out of scope
In scope:
- Full server test pass for impacted suites.
- Static checks for no-regression conditions.
- Completion report artifact.

Out of scope:
- New feature work.

## Deliverables
- Updated/added tests across impacted suites
- Final phase report in spec `phase-reports/`

## Requirements covered
- FIX-SEC-006
- FIX-SEC-008
- FIX-REL-002
- FIX-REL-011
- FIX-PER-002
- FIX-SRV-001
- FIX-SRV-003
- FIX-SRV-005
- FIX-EXE-014
- FIX-EXE-017
- FIX-EXE-018
- FIX-EXE-022
- FIX-LOG-002

## Implementation tasks
- [ ] Execute targeted and broad regression suites.
- [ ] Execute static grep checks from vectors.
- [ ] Produce completion summary with pass/fail mapping to requirement IDs.

## Verification steps
- `cd datafn/server && npm test`
- `rg -n "await import\(" datafn/server/src/routes`
- `rg -n "new Request\(\"http://localhost/datafn/" datafn/server/src/server.ts`
- `rg -n "console\." datafn/server/src/logging.ts`
- Expected: all tests pass; static checks match vector expectations.

## Stop condition
All requirement vectors pass and completion report is generated.
