# Phase 17: CLI Serve & Mock Commands

## Phase Goal
Implement `apifn serve` (local API explorer) and `apifn mock` (mock server) CLI commands, plus `apifn snippet`.

## In Scope
- `apifn serve [router-or-spec]` — serve interactive explorer
- `apifn mock [spec]` — start mock server
- `apifn snippet <spec> <path>` — generate code snippet
- Port configuration, auto-open browser
- Hot reload on file changes

## Out of Scope
- Explorer UI components (next phases)
- Full production-grade explorer (serve uses a basic HTML page with embedded React for now)

## Deliverables
- `apifn/cli/src/commands/serve.ts`
- `apifn/cli/src/commands/mock.ts`
- `apifn/cli/src/commands/snippet.ts`

## Requirements Covered
- CLI-006, CLI-007, CLI-008, SERVE-001, SERVE-002

## Implementation Tasks
1. [ ] Implement `apifn serve`: load spec, create HTTP server serving a basic HTML page + bundled explorer component
2. [ ] Implement file watching with `chokidar` for hot reload
3. [ ] Implement WebSocket for browser auto-refresh on spec change
4. [ ] Implement `--port`, `--open` flags
5. [ ] Implement `apifn mock`: load spec, create mock server, start
6. [ ] Implement `--mode`, `--port`, `--validate-requests`, `--delay` flags
7. [ ] Implement `apifn snippet`: load spec, find operation by path, generate snippet
8. [ ] Implement `--target`, `--all` flags

## Verification Steps
1. `apifn serve ./fixtures/petstore.yml --port 4200` → server starts, browser page loads
2. `apifn mock ./fixtures/petstore.yml --port 4010` → mock responds to requests
3. `apifn snippet ./fixtures/petstore.yml /users --target curl` → curl command printed
4. TV-CLI-006, TV-CLI-007, TV-CLI-008

## Stop Condition
All three commands work. Serve shows a basic explorer page, mock responds correctly, snippet prints code.
