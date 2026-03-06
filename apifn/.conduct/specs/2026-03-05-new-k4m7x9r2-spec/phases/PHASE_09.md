# Phase 09: CLI Foundation

## Phase Goal
Implement the CLI framework with `init`, `generate`, `export`, and `validate` commands.

## In Scope
- CLI entry point using `cac`
- Config file loading (`apifn.config.ts` via jiti/tsx)
- `defineConfig()` helper
- `apifn init` — scaffold new collection
- `apifn generate` — generate OpenAPI from router
- `apifn export` — export as YAML/JSON
- `apifn validate` — validate OpenAPI spec
- Global flags: `--config`, `--verbose`, `--quiet`, `--no-color`

## Out of Scope
- `apifn test`, `apifn diff`, `apifn serve`, `apifn mock`, `apifn snippet` (later phases)

## Deliverables
- `apifn/cli/src/index.ts` — CLI entry point
- `apifn/cli/src/config.ts` — config loading + defineConfig
- `apifn/cli/src/commands/init.ts`
- `apifn/cli/src/commands/generate.ts`
- `apifn/cli/src/commands/export.ts`
- `apifn/cli/src/commands/validate.ts`
- `apifn/cli/src/utils/router-loader.ts`
- `apifn/cli/src/utils/output.ts`

## Requirements Covered
- CORE-003, CLI-001, CLI-002, CLI-003, CLI-009, CLI-010

## Implementation Tasks
1. [ ] Set up `cac` CLI framework with global flags
2. [ ] Implement `loadConfig(path?)` using `jiti` for TypeScript config
3. [ ] Implement `defineConfig(config)` type helper (exported from @apifn/cli)
4. [ ] Implement `loadRouter(path)` — dynamically import TS file and extract Router export
5. [ ] Implement `apifn init` — interactive prompts (collection name, base URL), scaffold files via `writeCollection()`
6. [ ] Implement `apifn generate` — load router, introspect, generate OpenAPI, write to output
7. [ ] Implement `apifn export` — read generated spec, write as YAML or JSON
8. [ ] Implement `apifn validate` — parse and validate spec, print errors
9. [ ] Implement console output utilities (colored output, verbose/quiet modes)
10. [ ] Add dependencies: `cac`, `picocolors`, `jiti`
11. [ ] Test CLI commands manually and with integration tests

## Verification Steps
1. `apifn --help` → shows all commands and global flags
2. `apifn init --yes ./test-col` → creates collection directory
3. `apifn validate ./fixtures/valid.yml` → exit 0
4. `apifn validate ./fixtures/invalid.yml` → exit 1 with errors
5. TV-CLI-001, TV-CLI-002, TV-CLI-003, TV-CLI-009, TV-CLI-010

## Stop Condition
All four commands work. Config loading from `apifn.config.ts` works. Report command output.
