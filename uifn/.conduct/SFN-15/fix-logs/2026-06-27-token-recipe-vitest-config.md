# Fix Log: Token And Recipe Vitest Isolation

- timestamp: 2026-06-27T17:49:40Z
- phase: PHASE_19
- trigger: Final release gate failed `test:@uifn/tokens` and `test:@uifn/recipes` after generated workspace dependency folders were cleaned.
- symptom: Package tests inherited an unrelated root Vitest project configuration.
- fix: Added package-local `vitest.config.ts` files for `@uifn/tokens` and `@uifn/recipes`, and updated each test script to use the local config.
- verification: `npm --workspace @uifn/tokens run test` passed, `npm --workspace @uifn/recipes run test` passed, and final `npm run verify:uifn-release` passed 80/80 checks.
