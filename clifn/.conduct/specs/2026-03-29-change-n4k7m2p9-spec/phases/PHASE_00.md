# Phase goal

Finalize the `clifn` package contract, export map, compatibility guarantees, and file scaffolding for the new generic CLI-builder modules.

# In scope / Out of scope

- In scope:
  - package metadata updates
  - export-map changes
  - file scaffolding for new modules
  - compatibility guarantees for current subpaths
- Out of scope:
  - implementation of module logic
  - migration of external or internal consumer CLIs

# Deliverables

- Modify `clifn/core/package.json`
- Modify `clifn/core/src/index.ts`
- Create `clifn/core/src/output.ts`
- Create `clifn/core/src/runner.ts`
- Create `clifn/core/src/config-loader.ts`
- Create `clifn/core/src/env.ts`
- Create `clifn/core/src/diagnostics.ts`
- Create `clifn/core/src/exec.ts`
- Create `clifn/core/src/scaffold.ts`
- Modify `clifn/core/README.md`

# Requirements covered

- `PKG-001`
- `COMP-001`
- `ADOPT-001`

# Implementation tasks

- Confirm and preserve the current package name `clifn`.
- Add public subpath exports for the new generic modules.
- Keep all existing subpaths intact.
- Add placeholder module files with exported types and factory stubs where needed.
- Update the README to document the additive module surface and compatibility promise.
- Ensure any new dependency choices needed by later phases are documented explicitly in package metadata planning.

# Verification steps

- Run `npm run build -- --filter=clifn`
- Run an import smoke test that resolves:
  - `clifn/output`
  - `clifn/runner`
  - `clifn/config-loader`
  - `clifn/env`
  - `clifn/diagnostics`
  - `clifn/exec`
  - `clifn/scaffold`
  - `clifn/ui`
- Expected outcomes:
  - package builds
  - new subpaths resolve
  - legacy subpaths still resolve

# Stop condition

Stop after the package export map and file layout support the new module surface without breaking existing subpaths.

