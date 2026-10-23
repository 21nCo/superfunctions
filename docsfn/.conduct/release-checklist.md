# docsfn release checklist

Use this checklist before publishing docsfn packages.

## 0) Clean-checkout bootstrap

- [ ] From repository root run `npm ci`
- [ ] Preflight passes: `node docsfn/scripts/release-preflight.mjs`
- [ ] Final gate passes: `node docsfn/scripts/release-gate.mjs`
- [ ] Release summary exists at `docsfn/.tmp/release-gate/summary.json`

## 1) Package metadata and publish contract

- [ ] `docsfn/core/package.json` package name is `@docsfn/core`
- [ ] `docsfn/react/package.json` peers include React 18 and 19
- [ ] `docsfn/next/package.json` peer includes Next 15
- [ ] `docsfn/svelte/package.json` peers include Svelte 4 and 5
- [ ] `docsfn/sveltekit/package.json` peer includes SvelteKit 2
- [ ] All package `types`, `main`, and `module` entries point to emitted files

## 2) Package build + type artifacts

- [ ] Shared search runtime packages build:
  - `npm --prefix searchfn/core run build`
  - `npm --prefix searchfn/adapter-contracts run build`
  - `npm --prefix searchfn/adapter-memory run build`
  - `npm --prefix searchfn/adapter-indexeddb run build`
  - `npm --prefix searchfn/client run build`
- [ ] Core builds: `npm --prefix docsfn/core run build`
- [ ] Provider builds: `npm --prefix docsfn/provider-fs run build`
- [ ] React builds: `npm --prefix docsfn/react run build`
- [ ] Svelte builds: `npm --prefix docsfn/svelte run build`
- [ ] Next builds: `npm --prefix docsfn/next run build`
- [ ] SvelteKit builds: `npm --prefix docsfn/sveltekit run build`
- [ ] CLI builds: `npm --prefix docsfn/cli run build`
- [ ] Declared type files exist in each package `dist/`

## 3) Fixture and integration verification

- [ ] Core tests pass: `npm --prefix docsfn/core run test -- --run`
- [ ] Provider tests pass: `npm --prefix docsfn/provider-fs run test -- --run`
- [ ] React parity tests pass: `npm --prefix docsfn/react run test -- --run src/DocsContent.test.tsx src/DocsSearch.test.tsx src/Pagination.test.tsx src/ApiReferenceRenderer.test.tsx`
- [ ] Svelte parity tests pass: `npm exec -- vitest run docsfn/svelte/src/DocsContent.test.ts docsfn/svelte/src/ApiReferenceRenderer.test.ts`
- [ ] Search runtime tests pass: `npm --prefix searchfn/client run test -- --run __tests__/in-memory-search.test.ts __tests__/constructors.test.ts __tests__/legacy-guard.test.ts`
- [ ] Adapter parity test passes: `npm exec -- vitest --config docsfn/sveltekit/vitest.config.ts run src/route-helpers.test.ts`
- [ ] Dogfood site tests pass: `npm --prefix docsfn/docs run test -- --run src/lib/server/docs-site-source.test.ts`
- [ ] Dogfood site build passes: `npm --prefix docsfn/docs run build`
- [ ] CLI validate passes for `datafn-docs` and `searchfn-docs`
- [ ] CLI build emits `manifest.json`, `search.json`, `diagnostics.json`, `compat-report.json` for canonical fixtures

## 4) Example site verification

- [ ] Next example builds against `searchfn-docs`
- [ ] Next example builds against `datafn-docs`
- [ ] SvelteKit example builds against `searchfn-docs`
- [ ] SvelteKit example builds against `datafn-docs`

## 5) Migration parity

- [ ] `node docsfn/scripts/migration-check.mjs` passes
- [ ] Route parity includes `/docs/documentation/server/routes` for `datafn-docs`
- [ ] Route parity includes `/docs/reference/client` for `searchfn-docs`
- [ ] Sidebar snapshots match expected top-level labels
- [ ] Compatibility checks report no unresolved `DOCS_COMPAT_UNSUPPORTED`

## 6) Final gate

- [ ] `node docsfn/scripts/release-gate.mjs` passes with zero error diagnostics
- [ ] Summary schema path is `docsfn/scripts/release-gate-summary.schema.json`
- [ ] Any residual warnings are documented and explicitly accepted as non-blocking in phase report / release notes
