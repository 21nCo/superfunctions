# Phase 08: Environment Management

## Phase Goal
Implement environment file handling, variable interpolation, and secret references.

## In Scope
- Environment file read/write (OpenCollection format)
- `{{variableName}}` interpolation in URLs, headers, body, params
- `{{process.env.VAR}}` secret references
- Variable precedence (overrides > env > collection > process.env)
- `.env` file support (via dotenv)

## Out of Scope
- Collection runner (uses these utilities — next phases)
- CLI commands

## Deliverables
- `apifn/collections/src/environment.ts`
- `apifn/collections/src/variables.ts`
- `apifn/collections/__tests__/environment.test.ts`
- `apifn/collections/__tests__/variables.test.ts`

## Requirements Covered
- ENV-001, ENV-002, ENV-003, ENV-004, ENV-005

## Implementation Tasks
1. [ ] Implement environment file reading: parse YAML, extract name from filename
2. [ ] Implement environment file writing: serialize variables to YAML
3. [ ] Implement `interpolateVariables(template, context)`: replace `{{varName}}` patterns
4. [ ] Implement `{{process.env.VAR}}` resolution
5. [ ] Implement precedence resolver: merge overrides > environment > collection > process.env
6. [ ] Implement `.env` file loading (optional dotenv integration)
7. [ ] Implement warning for unresolved variables
8. [ ] Write tests for TV-ENV-001 through TV-ENV-005
9. [ ] Export from collections index

## Verification Steps
1. `npm run test` → all environment/variable tests pass
2. TV-ENV-002: `{{baseUrl}}/users` → resolved URL
3. TV-ENV-003: `{{process.env.API_KEY}}` → value from env
4. TV-ENV-004: Precedence order verified

## Stop Condition
All interpolation and precedence tests pass. Report variable resolution coverage.
