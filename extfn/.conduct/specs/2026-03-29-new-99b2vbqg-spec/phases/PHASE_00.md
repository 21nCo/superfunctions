# Phase goal

Create the repository scaffolding and workspace wiring required to implement `extfn`, its CLI and adapters, `datafn/extfn`, and the example extensions entirely inside this repository.

# In scope / Out of scope

- In scope:
  - root workspace and Turbo wiring
  - package shells for `extfn/core`, `extfn/vite`, `extfn/cli`, `extfn/svelte`, `datafn/extfn`
  - example package shells under `extfn/examples/*`
  - documenting the reuse path for shared packages already present on `next`
- Out of scope:
  - runtime implementation
  - manifest generation
  - messaging logic
  - DataFn authority logic

# Deliverables

- Modify `package.json`
- Modify `turbo.json`
- Create `extfn/core/package.json`
- Create `extfn/core/tsconfig.json`
- Create `extfn/vite/package.json`
- Create `extfn/vite/tsconfig.json`
- Create `extfn/cli/package.json`
- Create `extfn/cli/tsconfig.json`
- Create `extfn/svelte/package.json`
- Create `extfn/svelte/tsconfig.json`
- Create `datafn/extfn/package.json`
- Create `datafn/extfn/tsconfig.json`
- Create `extfn/examples/vanilla-messaging-demo/package.json`
- Create `extfn/examples/vanilla-messaging-demo/tsconfig.json`
- Create `extfn/examples/svelte-multi-content-demo/package.json`
- Create `extfn/examples/svelte-multi-content-demo/tsconfig.json`
- Create `extfn/examples/svelte-datafn-demo/package.json`
- Create `extfn/examples/svelte-datafn-demo/tsconfig.json`
- Decide and document which shared helpers are reused directly and which require extraction first from:
  - `packages/cli`
  - `packages/config`
  - `packages/errors`
  - `packages/envelope`
  - `packages/metrics`

# Requirements covered

- `BLD-001`
- `CLI-001`
- `DFX-001`
- `EX-001`
- `REUSE-001`

# Implementation tasks

- Add workspace globs for `extfn/*`, `extfn/examples/*`, and `datafn/extfn`.
- Add Turbo tasks or outputs needed for the new packages and example builds.
- Create package metadata for the four `extfn` packages and the `datafn/extfn` package.
- Create package metadata for the three example extensions.
- Decide and document whether shared CLI config-loading helpers will be exported from `packages/cli` or extracted into a shared internal utility before `extfn` implementation begins.
- Document how shared config, error, envelope, and metrics primitives will be reused so later phases do not introduce redundant abstractions.
- Align package naming with existing repository conventions:
  - `@superfunctions/extfn`
  - `@superfunctions/extfn-vite`
  - `@superfunctions/extfn-cli`
  - `@superfunctions/extfn-svelte`
  - `@datafn/extfn`
- Ensure example packages are marked private.

# Verification steps

- Run `npm install`
- Run `npm run build -- --filter=@superfunctions/extfn`
- Run `npm run build -- --filter=@superfunctions/extfn-vite`
- Run `npm run build -- --filter=@superfunctions/extfn-cli`
- Run `npm run build -- --filter=@superfunctions/extfn-svelte`
- Run `npm run build -- --filter=@datafn/extfn`
- Expected outcomes:
  - workspace discovery succeeds
  - the new packages are visible to Turbo
  - package graph contains no `wxt` dependency
  - the reuse path for shared CLI loader helpers is documented before implementation starts
  - the reuse path for shared config/error/envelope/metrics helpers is documented before implementation starts

# Stop condition

Stop after the repository can discover all new packages and examples without build graph errors.
