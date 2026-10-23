# Phase 00: Project Scaffolding

## Phase Goal
Set up the multi-package project structure with build tooling, test tooling, and TypeScript configuration for all apifn packages.

## In Scope
- Package directory structure for all 9 packages (core, collections, cli, snippets, mock, react, svelte, docsfn, python)
- `package.json` with correct names, versions, dependencies, exports
- `tsconfig.json` for each TypeScript package
- `tsup.config.ts` for each buildable package
- `vitest.config.ts` for each testable package
- `pyproject.toml` for the Python package
- Root workspace entries in the monorepo `package.json`
- Empty `src/index.ts` entry points

## Out of Scope
- Any actual implementation code
- Tests beyond build verification
- Examples

## Deliverables
- `apifn/core/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `src/index.ts`
- `apifn/collections/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `src/index.ts`
- `apifn/cli/package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`
- `apifn/snippets/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `src/index.ts`
- `apifn/mock/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `src/index.ts`
- `apifn/react/package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`
- `apifn/svelte/package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`
- `apifn/docsfn/package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts`
- `apifn/python/pyproject.toml`, `apifn/__init__.py`
- Updated root `package.json` workspaces

## Requirements Covered
- CORE-001

## Implementation Tasks
1. [ ] Create `apifn/core/` directory with package.json (`@apifn/core` v0.0.1), tsconfig, tsup, vitest configs
2. [ ] Create `apifn/collections/` directory with package.json (`@apifn/collections` v0.0.1), tsconfig, tsup, vitest configs
3. [ ] Create `apifn/cli/` directory with package.json (`@apifn/cli` v0.0.1), tsconfig, tsup configs. Add `bin` entry for `apifn` command.
4. [ ] Create `apifn/snippets/` directory with package.json (`@apifn/snippets` v0.0.1), tsconfig, tsup, vitest configs
5. [ ] Create `apifn/mock/` directory with package.json (`@apifn/mock` v0.0.1), tsconfig, tsup, vitest configs
6. [ ] Create `apifn/react/` directory with package.json (`@apifn/react` v0.0.1), tsconfig, tsup configs. Peer deps: react, react-dom.
7. [ ] Create `apifn/svelte/` directory with package.json (`@apifn/svelte` v0.0.1), tsconfig, tsup configs. Peer deps: svelte.
8. [ ] Create `apifn/docsfn/` directory with package.json (`@apifn/docsfn` v0.0.1), tsconfig, tsup configs. Peer deps: docsfn.
9. [ ] Create `apifn/python/` with pyproject.toml (name: `apifn`, version 0.0.1), `apifn/__init__.py`
10. [ ] Create empty `src/index.ts` entry points in all TS packages
11. [ ] Add `"apifn/*"` to root `package.json` workspaces
12. [ ] Run `npm install` from root
13. [ ] Verify `npm run build` succeeds for each package
14. [ ] Verify `npm run test` succeeds (with no tests) for each testable package

## Verification Steps
1. `cd apifn/core && npm run build` → exit 0, `dist/index.js` exists
2. `cd apifn/collections && npm run build` → exit 0
3. `cd apifn/cli && npm run build` → exit 0
4. `cd apifn/snippets && npm run build` → exit 0
5. `cd apifn/mock && npm run build` → exit 0
6. `cd apifn/react && npm run build` → exit 0
7. `cd apifn/svelte && npm run build` → exit 0
8. `cd apifn/docsfn && npm run build` → exit 0
9. `cd apifn/python && pip install -e .` → success
10. All `package.json` names match: `@apifn/core`, `@apifn/collections`, `@apifn/cli`, `@apifn/snippets`, `@apifn/mock`, `@apifn/react`, `@apifn/svelte`, `@apifn/docsfn`

## Stop Condition
All packages build without errors. Report package list and build output.
