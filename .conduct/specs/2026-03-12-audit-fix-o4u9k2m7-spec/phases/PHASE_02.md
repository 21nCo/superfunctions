# PHASE 02

## Phase goal
Create `@superfunctions/oauth-flow` package scaffolding and public API contracts.

## In scope / Out of scope

- **In scope:** new package structure, exports, base service interfaces, initial tests.
- **Out of scope:** consumer migrations.

## Deliverables

- New package directory `packages/oauth-flow/` with `package.json`, `tsconfig.json`, `src/index.ts`, `src/service.ts`, and tests.
- API contracts from SPEC public API section.

## Requirements covered

- OAUTH-002
- OAUTH-007

## Implementation tasks

1. Scaffold package with standard build/test/typecheck scripts.
2. Define `OAuthFlowService` interfaces and input/output types.
3. Implement minimal service constructor and dependency typing.
4. Add export tests for package surface.

## Verification steps

1. Run:
```bash
npm -w @superfunctions/oauth-flow run typecheck
npm -w @superfunctions/oauth-flow run test
```
Expected: package compiles and tests pass.

2. Run:
```bash
node -e "import('@superfunctions/oauth-flow').then(()=>console.log('ok'))"
```
Expected: import resolves without runtime errors (workspace mode).

## Stop condition
oauth-flow package exists with stable typed API and passing package tests.
