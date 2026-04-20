# Phase Completion Report

- Timestamp: `2026-03-29T07:48:56Z`
- Agent: `unknown-agent`
- Model: `unknown`
- Launcher: `Codex Desktop`
- Workspace: `repo root`
- OS: `Darwin arm64`
- Shell: `zsh`
- Git: `HEAD` @ `a4ed4ed01ca907e9a6beb1b2a8e76940a5dfb2ef` (`dirty`)

## Phase

- Phase: `PHASE_05`
- Status: `PASS`

## Requirements Summary

- Requirements delivered: `BLD-001`, `BLD-002`, `BLD-003`, `SURF-001`, `CFG-002`

### `BLD-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - [index.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/src/index.ts) exports `extfnVite()` from `@superfunctions/extfn-vite`.
  - [plugin.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/src/plugin.ts) implements the Vite plugin entry and config integration without introducing any WXT dependency.
  - [manifest-build.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/__tests__/manifest-build.test.ts) runs a temporary extension through programmatic `vite build` using `extfnVite()`.
  - [reloadPolicy.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/__tests__/reloadPolicy.test.ts) runs a temporary extension through programmatic `vite dev` using `extfnVite()`.
  - `npm ls wxt --all` returned an empty tree, proving no runtime or build dependency on WXT is present.
- Test status:
  - `npm run build -- --filter=@superfunctions/extfn-vite` passed.
  - `npm run test -- --filter=@superfunctions/extfn-vite` passed.
  - `npm ls wxt --all` returned `(empty)`.

### `BLD-002`

- Status: `PASS`
- Acceptance criteria evidence:
  - [buildManifest.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/src/manifest/buildManifest.ts) builds deterministic target manifests from the resolved extension config.
  - [mergeManifest.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/src/manifest/mergeManifest.ts) deep-merges manifest contributions and recursively sorts keys for stable output ordering.
  - [devOutputs.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/src/dev/devOutputs.ts) emits deterministic target output directory names for build and dev modes.
  - [plugin.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/src/plugin.ts) duplicates built assets into `dist/<target>` and writes `manifest.json` for each configured target.
  - [manifest-build.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/__tests__/manifest-build.test.ts) verifies dual-target production outputs emit `dist/chromium-mv3/manifest.json` and `dist/firefox-mv3/manifest.json`, plus deterministic manifest structure for identical inputs.
- Test status:
  - `npm run test -- --filter=@superfunctions/extfn-vite` passed.
  - `npm --workspace extfn/vite test -- --run __tests__/manifest-build.test.ts` passed.

### `BLD-003`

- Status: `PASS`
- Acceptance criteria evidence:
  - [reloadPolicy.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/src/dev/reloadPolicy.ts) selects `hmr`, `reinject`, or `full-reload` by surface and target.
  - [plugin.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/src/plugin.ts) logs structured dev strategy decisions during Vite watcher updates.
  - [reloadPolicy.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/__tests__/reloadPolicy.test.ts) verifies popup changes choose HMR, content changes choose reinjection, and background changes choose full reload.
  - [reloadPolicy.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/__tests__/reloadPolicy.test.ts) verifies unsafe content HMR selection fails with `E_CONFIG_INVALID`.
  - [reloadPolicy.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/__tests__/reloadPolicy.test.ts) verifies `dist/chromium-mv3-dev/manifest.json` and `dist/firefox-mv3-dev/manifest.json` are emitted during dev startup and that structured log lines include the applied strategy.
- Test status:
  - `npm run test -- --filter=@superfunctions/extfn-vite` passed.
  - `npm --workspace extfn/vite test -- --run __tests__/reloadPolicy.test.ts` passed.

### `SURF-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - [buildManifest.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/src/manifest/buildManifest.ts) emits `action.default_popup`, `options_ui`, and target-aware `side_panel` entries from code-first surface definitions.
  - [plugin.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/src/plugin.ts) includes page surfaces in the Vite multi-entry input map so popup/options/sidepanel surfaces compile as build inputs.
  - [manifest-build.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/__tests__/manifest-build.test.ts) verifies popup manifest output and target-directory emission.
  - [loadExtensionConfig.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/__tests__/loadExtensionConfig.test.ts) verifies missing page entries fail with `E_ENTRY_NOT_FOUND`.
  - [manifest-build.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/__tests__/manifest-build.test.ts) verifies unsupported sidepanel coverage fails before build output emission.
- Test status:
  - `npm run test -- --filter=@superfunctions/extfn-vite` passed.

### `CFG-002`

- Status: `PASS`
- Acceptance criteria evidence:
  - [loadExtensionConfig.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/src/loadExtensionConfig.ts) resolves the extension config before Vite output emission.
  - [manifest-build.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/__tests__/manifest-build.test.ts) verifies sidepanel on `chromium-mv3` plus `firefox-mv3` fails with `E_TARGET_UNSUPPORTED`.
  - [loadExtensionConfig.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/vite/__tests__/loadExtensionConfig.test.ts) verifies unknown targets fail with `E_CONFIG_INVALID`.
- Test status:
  - `npm run test -- --filter=@superfunctions/extfn-vite` passed.

## Deliverables Summary

- Files changed/added:
  - `extfn/vite/src/index.ts`
  - `extfn/vite/src/plugin.ts`
  - `extfn/vite/src/manifest/buildManifest.ts`
  - `extfn/vite/src/manifest/mergeManifest.ts`
  - `extfn/vite/src/targets/chromium.ts`
  - `extfn/vite/src/targets/firefox.ts`
  - `extfn/vite/src/dev/reloadPolicy.ts`
  - `extfn/vite/src/dev/devOutputs.ts`
  - `extfn/vite/src/loadExtensionConfig.ts`
  - `extfn/vite/__tests__/manifest-build.test.ts`
  - `extfn/vite/__tests__/reloadPolicy.test.ts`
- Files deleted/modified:
  - No files deleted.

## Verification Summary

- Phase verification steps executed:
  - `npm run build -- --filter=@superfunctions/extfn-vite` - `PASS`
  - `npm run test -- --filter=@superfunctions/extfn-vite` - `PASS`
- Supporting verification executed:
  - `npm --workspace extfn/vite run build` - `PASS`
  - `npm --workspace extfn/vite test -- --run __tests__/manifest-build.test.ts` - `PASS`
  - `npm ls wxt --all` - `PASS` (`(empty)`)
  - `rg -n "TODO|FIXME|XXX" extfn/vite/src extfn/vite/__tests__ || true` - `PASS` (no matches)
- Test execution results:
  - `@superfunctions/extfn-vite`: `5` test files passed, `12` tests passed.
  - `manifest-build.test.ts`: `3` tests passed.
  - `reloadPolicy.test.ts`: `4` tests passed.

## Notes

- The Vite plugin now resolves extension config eagerly and normalizes real paths before wiring multi-entry HTML and script inputs, which avoids macOS temp-directory root mismatches during programmatic builds.
- Production output duplication is intentionally correctness-first: the plugin preserves Vite’s root build and writes target-specific unpacked extension trees alongside it under `dist/<target>`.
- Dev mode currently emits deterministic target manifests and structured strategy logs under `dist/<target>-dev`; page HMR continues to rely on Vite’s native page updates while content/background policy is logged for orchestration.
- Firefox manifests receive a repository-owned `browser_specific_settings.gecko.id` shim so the target manifest differs deterministically without relying on consumer-authored manifest-first files.
- Content script CSS declared in `contentScripts[].css` is copied into target outputs deterministically under `content/<id>/`.
- The phase verification used temporary programmatic Vite projects rather than the repository example apps because `PHASE_06` has not yet established adapter-specific runtime scaffolding for the examples.
- No `TODO`, `FIXME`, or `XXX` markers were introduced in the phase-five files.

## Ready For Next Phase?

- Yes. The Vite plugin, deterministic dual-target manifest/output pipeline, and dev reload-policy selection are in place and verified.

## Blockers

- None.
