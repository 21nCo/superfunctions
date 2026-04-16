# Phase goal

Implement the mandatory `extfn` CLI with dev, build, package, and strict-by-default scan workflows.

# In scope / Out of scope

- In scope:
  - `extfn/cli` package
  - `extfn dev` orchestration
  - `extfn build` and `extfn package`
  - store-uploadable archive generation
  - `extfn scan` reporting and strictness behavior
  - CLI integration tests against example extensions
- Out of scope:
  - external store publishing APIs
  - changes in external consumer repositories

# Deliverables

- Modify `packages/cli/src/index.ts`
- Modify `packages/cli/package.json`
- Modify `packages/config/src/index.ts` only if shared env helpers need one small extraction for extfn CLI defaults
- Modify `packages/errors/src/index.ts` or extract a shared derivative only if extfn needs typed error registration not already exported
- Modify `packages/metrics/src/index.ts` only if one small compatibility helper is needed for extfn observability
- Modify `clifn/core/src/index.ts` if new generic CLI primitives need to be exported for extfn and other repository CLIs
- Modify `clifn/core/src/output.ts` if shared output formatting primitives are missing
- Modify `clifn/core/src/runner.ts` if shared action-runner semantics are missing
- Modify `clifn/core/src/config-loader.ts` if shared config discovery/loading primitives are missing
- Modify `clifn/core/src/env.ts` if shared env-reader primitives are missing
- Modify `clifn/core/src/diagnostics.ts` if shared structured diagnostics formatting is missing
- Modify `clifn/core/src/exec.ts` if shared subprocess primitives are missing
- Modify `clifn/core/src/scaffold.ts` if shared scaffolding helpers are missing
- Create `extfn/cli/src/index.ts`
- Create `extfn/cli/src/commands/dev.ts`
- Create `extfn/cli/src/commands/build.ts`
- Create `extfn/cli/src/commands/package.ts`
- Create `extfn/cli/src/commands/scan.ts`
- Create `extfn/cli/src/browser/openBrowser.ts`
- Create `extfn/cli/src/package/archive.ts`
- Create `extfn/cli/src/scan/report.ts`
- Create `extfn/cli/src/scan/rules/*`
- Create `extfn/cli/__tests__/dev.test.ts`
- Create `extfn/cli/__tests__/package.test.ts`
- Create `extfn/cli/__tests__/scan.test.ts`

# Requirements covered

- `CLI-001`
- `CLI-002`
- `CLI-003`
- `SCN-001`
- `SCN-002`
- `OBS-001`
- `EX-001`
- `REUSE-001`
- `REUSE-002`

# Implementation tasks

- Implement the `extfn` binary and command parser in `extfn/cli`.
- Adopt `clifn` for generic CLI concerns including action execution, output formatting, diagnostics formatting, subprocess execution, env-backed defaults, and scaffolding; if any of those primitives are missing, add them to `clifn` before introducing extfn-specific duplicate helpers.
- Reuse or extract the shared TypeScript config loader and config-discovery helpers from `packages/cli` instead of introducing a second independent implementation.
- Reuse `@superfunctions/config` for any env-backed CLI defaults and `@superfunctions/errors`/`@superfunctions/metrics` compatible primitives where those semantics match.
- Wire `extfn dev` to `@superfunctions/extfn-vite` watch mode and target selection.
- Implement browser opening support with explicit `--open` and `--no-open` behavior.
- Implement `extfn build` as the canonical production build entrypoint.
- Implement `extfn package` so it builds as needed, runs scan by default, and emits deterministic `.zip` and `.xpi` archives.
- Implement `extfn scan` with structured report output for text, JSON, and SARIF formats.
- Add scan rules for remote hosted code, insecure transport, dynamic execution, risky permissions, externally connectable scope, CSP issues, content-script socket usage, and manual-review reminders.
- Ensure scan rules evaluate plugin-contributed manifest state, including future package-owned contributions from integrations such as `datafn`, and are designed so future `searchfn` and `filefn` plugins can reuse the same reporting model.
- Implement strict-by-default exit behavior with `--no-strict` opt-out.
- Validate the CLI against the example extensions from earlier phases.

# Verification steps

- Run `npm run test -- --filter=@superfunctions/extfn-cli`
- Run `npm exec extfn build -- --target chromium-mv3 --config extfn/examples/vanilla-messaging-demo/extfn.config.ts`
- Run `npm exec extfn scan -- --target chromium-mv3 --config extfn/examples/vanilla-messaging-demo/extfn.config.ts`
- Run `npm exec extfn package -- --target firefox-mv3 --config extfn/examples/svelte-multi-content-demo/extfn.config.ts`
- Expected outcomes:
  - CLI tests pass
  - `extfn build` emits deterministic target outputs
  - `extfn scan` emits a structured report and exits non-zero on blocking findings in default mode
  - `extfn package` emits an archive only when scan permits it or when `--no-strict` is explicitly supplied
  - Generic CLI building concerns used by `extfn/cli` are sourced from `clifn` instead of extfn-local duplicate helpers
  - CLI source does not directly depend on `hostfn/cli` deployment modules

# Stop condition

Stop after the `extfn` CLI can drive local dev, build, package, and scan flows for the repository examples with deterministic exit behavior.
