# PLAN

## Architecture Sketch

### Module layout

- `docsfn/core`
  - `src/config.ts`: config schema, loading, defaults, validation
  - `src/diagnostics.ts`: canonical diagnostic/error types and helpers
  - `src/provider.ts`: provider contract and remote-ready helpers
  - `src/normalize/*`: source normalization, slug rules, index semantics, frontmatter/meta handling
  - `src/navigation/*`: sidebar, top-nav, breadcrumbs, pagination, version routing
  - `src/compile/*`: React MDX pipeline, Svelte mdsvex pipeline contract, compatibility transforms
  - `src/search/*`: search artifact build and query helpers
  - `src/openapi/*`: JSON/YAML/remote normalization into canonical API reference models
  - `src/build.ts`: manifest/search/compat-report/diagnostics orchestration
- `docsfn/provider-fs`
  - filesystem discovery, meta loading, asset scanning, watch support
- `docsfn/react`
  - chrome components and React rendering helpers over compiled content
- `docsfn/svelte`
  - chrome components and Svelte rendering helpers over compiled content
- `docsfn/next`
  - Next.js App Router site kit and route helpers
- `docsfn/sveltekit`
  - SvelteKit load/static-path site kit and route helpers
- `docsfn/cli`
  - `validate`, `build`, `dev`
- `docsfn/examples`
  - `next-docs-site`
  - `sveltekit-docs-site`
- `docsfn/test-fixtures`
  - canonical snapshots or linked copies of `datafn/docs` and `searchfn/docs`
  - focused blog/OpenAPI/security fixtures

## Dependency Graph

1. Config and diagnostics MUST exist before any provider or build orchestration work.
2. Provider contracts and filesystem ingest MUST exist before normalization/routing work.
3. Routing, navigation, and compatibility transforms MUST exist before search, API, and site-kit work.
4. Search and OpenAPI normalization MUST exist before example site-kit end-to-end verification.
5. React/Svelte component layers depend on canonical compiled-content contracts from core.
6. Next/SvelteKit site kits depend on core + framework component layers.
7. CLI depends on core build orchestration and provider implementations.
8. Release-gate tests depend on examples, fixtures, and all artifacts.

## Phases Overview

| Phase | Goal | Delivered capability | Verification method |
| --- | --- | --- | --- |
| `00` | Establish production contract and package/release baseline | Config/diagnostics contracts, package metadata corrections, fixture inventory | Build matrix + config validation smoke tests |
| `01` | Implement source contracts | Remote-ready provider contract + filesystem provider coverage | Provider unit tests on multi-collection fixtures |
| `02` | Fix routing and navigation semantics | Root index routes, version routing, `meta.json`, breadcrumbs, pagination | Manifest golden tests on repo fixtures |
| `03` | Implement trusted compilation + compatibility | MDX/mdsvex pipeline, Fumadocs preset, TOC/anchor correctness, page chrome data | Compilation tests on tabs/mermaid/unicode fixtures |
| `04` | Restore search | Deterministic search artifact and adapter runtime behavior | Search artifact + query golden tests |
| `05` | Complete OpenAPI support | JSON/YAML/remote ingestion and routeable API reference pages | OpenAPI normalization and route tests |
| `06` | Ship React + Next site kit | React components, Next route helpers, example Next site | Next example build + route assertions |
| `07` | Ship Svelte + SvelteKit site kit | Safe Svelte components, SvelteKit helpers, example SvelteKit site | Svelte example build + prerender assertions |
| `08` | Cover blog and embedded modes | Blog pages/tags/rss and embedded page/surface contracts | Blog + embedded integration tests |
| `09` | Add security, auth, analytics, and CLI hardening | Sanitization, auth gates, watchfn hooks, fail-closed CLI | Security/auth/CLI verification matrix |
| `10` | Final hardening and release gate | Docs, examples, fixture matrix, release checklist | Full end-to-end release gate passes |

## Definition Of Done

No phase is complete unless its verification steps pass.

Global Definition of Done:

1. All requirements mapped to the phase are implemented with tests or golden vectors.
2. No verification step in the phase remains manual-only if it can be automated locally.
3. No phase may claim completion while emitting error-severity diagnostics on the canonical `datafn/docs` and `searchfn/docs` fixtures.
4. Example sites for the relevant framework layer build and run against the canonical artifacts.
