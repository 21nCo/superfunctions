# Phase 00

## Phase goal
Scaffold the workspace packages and baseline build/test wiring for FileFn + storage adapters.

## In scope
- Create package directories and minimal `package.json`/`tsconfig.json`/build+test configs.
- Ensure packages build and tests run (even if tests are placeholders).

## Out of scope
- Implementing real storage behavior, FileFn APIs, or processors.

## Deliverables
- `packages/storage/package.json`
- `packages/storage/src/index.ts`
- `packages/storage/src/types.ts`
- `packages/storage/vitest.config.ts`
- `packages/storage/tsconfig.json`
- `packages/storage/README.md`
- `packages/files/package.json`
- `packages/files/src/index.ts`
- `packages/files/src/types.ts`
- `packages/middleware/package.json`
- `packages/middleware/src/index.ts`
- `packages/middleware/src/rate-limit.ts`
- `packages/storage-s3/package.json` (+ minimal src)
- `packages/storage-local/package.json` (+ minimal src)
- `filefn/server/package.json` (+ minimal src)
- `filefn/client/package.json` (+ minimal src)
- `filefn/processing/package.json` (+ minimal src)
- `uifn/files/package.json` (+ minimal src)

## Requirements covered
- PKG-001
- PKG-005
- PKG-006
- PKG-003
- PKG-004

## Implementation tasks
1. Create directories: `packages/storage`, `packages/files`, `packages/middleware`, `packages/storage-s3`, `packages/storage-local`, `filefn/server`, `filefn/client`, `filefn/processing`, `uifn/files`.
2. Add minimal `package.json` files with correct names and workspace dependencies.
3. Add minimal `tsconfig.json` aligned with repo TypeScript version.
4. Add minimal build configs (tsup/tsc) consistent with other packages.
5. Add minimal vitest configs and a placeholder test per package.
6. Ensure each package exports a stable entrypoint (even if placeholder).

## Verification steps
1. Build:
   - `npm run build -- --filter=@superfunctions/storage --filter=@superfunctions/files --filter=@superfunctions/middleware --filter=@superfunctions/db --filter=@filefn/server --filter=@filefn/client --filter=@filefn/processing`
   - Expected: exit code 0.
2. Test:
   - `npm test -- --filter=@superfunctions/storage --filter=@superfunctions/middleware --filter=@filefn/server --filter=@filefn/client --filter=@filefn/processing`
   - Expected: exit code 0 (placeholder tests pass).

## Stop condition
Report:
- The created package paths.
- The package names as published.
- Confirmation that build+test pass for those packages.
