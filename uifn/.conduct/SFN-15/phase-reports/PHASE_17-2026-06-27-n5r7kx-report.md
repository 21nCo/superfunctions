# PHASE_17 Completion Report

## Metadata

- timestamp: 2026-06-27T17:31:54Z
- agent_name: Codex
- model: GPT-5 Codex
- launcher: Codex Desktop
- repo root: repository root
- OS: Darwin arm64
- shell: zsh
- git branch: SFN-15
- git commit: 9cf38123
- git dirty status: dirty worktree with prior phase changes and PHASE_17 changes

## Phase

PHASE_17: Registry and CLI

## Status

PASS

## Requirements Summary

Requirements delivered: REG-001, REG-002, DOCS-001, SEC-001

### REG-001

Status: PASS

Acceptance criteria evidence:

- Manifest schema validates all artifacts: `uifn/registry/src/schema.ts` defines required fields and `validateManifest`; `npm --workspace @uifn/registry run test` passed `registry-cli.test.ts` manifest validation across components, hooks, patterns, and Superfunction-backed variants.
- Manifests include owner, status, dependencies, framework support, and tests: `npm run verify:uifn-registry` passed metadata validation for 45 components, 2 hooks, 14 patterns, and 7 Superfunction-backed entries.
- Dependency graph can be computed from manifests: `uifn/registry/src/build-registry.ts` emits `dependencyGraph`; tests assert Data Table dependencies and AuthFn backing metadata.
- Missing required metadata fails the release gate: `registry-cli.test.ts` mutates Button owners to empty and asserts `UIFN_REGISTRY_OWNER_MISSING`.

Test status: PASS via `npm --workspace @uifn/registry run test` with 2 files and 10 tests passing.

### REG-002

Status: PASS

Acceptance criteria evidence:

- `uifn add` writes source files, stories, fixtures, tests, manifest, and lock entries: `registry-cli.test.ts` asserts the exact `button` React vector and lock checksums.
- `uifn info` prints package import instructions: `infoArtifact` and `runCli(['info', 'button', '--framework', 'react', '--json'])` are covered in tests.
- `uifn diff` reports local modifications: `diffInstalled` reports a modified `components/ui/button.tsx` after local edit.
- Unsupported framework requests fail before writing files: `addArtifact({ framework: 'ember' })` returns `UIFN_REGISTRY_UNSUPPORTED_FRAMEWORK` and leaves no install directories.

Test status: PASS via `npm --workspace @uifn/registry run test`.

### DOCS-001

Status: PASS

Acceptance criteria evidence:

- Docs list package import and source install instructions: `uifn/registry/README.md` documents manifest fields, CLI commands, package import guidance, source install, and lock format.
- Docs generation rejects local absolute paths: `registry-cli.test.ts` and `scripts/verify-uifn-registry.mjs` scan registry docs for local absolute path patterns.
- Docs are synchronized with manifests: `scripts/verify-uifn-registry.mjs` validates catalog counts and required framework metadata from manifest JSON.

Test status: PASS via `npm run verify:uifn-registry`.

### SEC-001

Status: PASS

Acceptance criteria evidence:

- CLI checksum and install errors redact sensitive paths and values: `uifn/registry/src/diagnostics.ts` redacts secret-like keys, local paths, and email-like values.
- No logs include secrets, tokens, upload URLs, PII payloads, local absolute paths, hostnames, or usernames: targeted hygiene scans over PHASE_17 registry files returned no matches for TODO/FIXME/deferral/local path or raw secret examples.
- Superfunction-backed panels receive clients and data explicitly: PHASE_17 registry metadata preserves `sf-pattern` backing and controlled counterpart metadata rather than embedding credentials or tenants.

Test status: PASS via `registry-cli.test.ts` redaction test and `npm run verify:uifn-registry`.

## Deliverables Summary

Files changed or added:

- `package.json`
- `scripts/verify-uifn-registry.mjs`
- `uifn/registry/README.md`
- `uifn/registry/package.json`
- `uifn/registry/fixtures/angular-app/uifn.config.json`
- `uifn/registry/fixtures/react-app/uifn.config.json`
- `uifn/registry/fixtures/solid-app/uifn.config.json`
- `uifn/registry/fixtures/svelte-app/uifn.config.json`
- `uifn/registry/fixtures/vue-app/uifn.config.json`
- `uifn/registry/src/__tests__/registry-cli.test.ts`
- `uifn/registry/src/add.ts`
- `uifn/registry/src/bin.ts`
- `uifn/registry/src/build-registry.ts`
- `uifn/registry/src/cli.ts`
- `uifn/registry/src/diagnostics.ts`
- `uifn/registry/src/diff.ts`
- `uifn/registry/src/index.ts`
- `uifn/registry/src/lockfile.ts`
- `uifn/registry/src/schema.ts`
- `uifn/registry/src/update.ts`

Files deleted or removed:

- Cleaned generated `uifn/registry/dist`
- Cleaned generated `uifn/registry/node_modules`

## Verification Summary

Phase verification steps executed:

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/registry run test` - PASS
  - Result: 2 test files passed, 10 tests passed.
- `PATH=<node22-bin>:$PATH npm run verify:uifn-registry` - PASS
  - Result: commands `list`, `info`, `add`, `diff`, `update`, `validate`; fixture frameworks `react`, `svelte`, `vue`, `solid`, `angular`; manifest counts components 45, hooks 2, patterns 14, sf 7.

Additional audit commands executed:

- `PATH=<node22-bin>:$PATH npm --workspace @uifn/registry run typecheck` - PASS
- `PATH=<node22-bin>:$PATH npm --workspace @uifn/registry run build` - PASS
- `PATH=<node22-bin>:$PATH node scripts/verify-uifn-package-graph.mjs` - PASS
- `rg -n "TODO|FIXME|defer|Nucleus|<absolute-user-path>/" uifn/registry/src uifn/registry/fixtures scripts/verify-uifn-registry.mjs uifn/registry/README.md package.json` - PASS, no matches
- `rg -n "sk_live|person@example\\.com|uploadUrl\\s*:|password\\s*:|token\\s*: \\\"|token\\s*=" uifn/registry/src uifn/registry/fixtures scripts/verify-uifn-registry.mjs uifn/registry/README.md` - PASS, no matches
- `find uifn/registry -maxdepth 2 \( -name dist -o -name node_modules \) -type d -print` after cleanup - PASS, no generated directories remain

## Notes

- CLI UX now supports `list`, `info`, `add`, `diff`, `update`, and `validate`.
- The importable CLI implementation lives in `uifn/registry/src/cli.ts`; executable startup lives in `uifn/registry/src/bin.ts` so declaration builds do not parse a shebang in exported types.
- Lock files are written at `.uifn/lock.json` with `schemaVersion: 1`, lock-keyed entries, repository-relative file paths, and SHA-256 checksums.
- React component source install intentionally follows the test vector path shape, for example `components/ui/button.tsx`.
- Other framework and artifact installs use each manifest's `sourceInstall` metadata, filling missing story, fixture, test, and manifest files where needed.
- Unsupported framework requests return `UIFN_REGISTRY_UNSUPPORTED_FRAMEWORK` before writing files or locks.
- Remote registry hosting and Bit publishing remain out of scope for this phase.

## Ready for Next Phase?

Yes. PHASE_17 deliverables and required verification steps are complete.

## Blockers

None.
