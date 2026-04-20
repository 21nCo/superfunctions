# Phase Completion Report

- Timestamp: `2026-03-29T07:38:48Z`
- Agent: `unknown-agent`
- Model: `unknown`
- Launcher: `Codex Desktop`
- Workspace: `repo root`
- OS: `Darwin arm64`
- Shell: `zsh`
- Git: `HEAD` @ `a4ed4ed01ca907e9a6beb1b2a8e76940a5dfb2ef` (`dirty`)

## Phase

- Phase: `PHASE_04`
- Status: `PASS`

## Requirements Summary

- Requirements delivered: `CNT-001`, `CNT-002`, `CNT-003`, `CNT-004`

### `CNT-001`

- Status: `PASS`
- Acceptance criteria evidence:
  - [contentScript.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/src/content/contentScript.ts) validates content script definitions, resolves entry paths, and rejects duplicate `id` values with `E_CONFIG_INVALID`.
  - [mountRegistry.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/src/content/mountRegistry.ts) keys mounted instances by `moduleId + anchorKey`, preventing collisions when multiple content modules share broad host matches.
  - [content-anchors.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/__tests__/content-anchors.test.ts) verifies two modules mount on the same URL without collisions and produce deterministic root ids `extfn-root-twitter-post` and `extfn-root-twitter-profile`.
  - [content-anchors.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/__tests__/content-anchors.test.ts) verifies duplicate ids fail with `E_CONFIG_INVALID` and message `Duplicate content script id: twitter-post`.
  - [content-anchors.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/__tests__/content-anchors.test.ts) verifies a missing entry file fails with `E_ENTRY_NOT_FOUND`.
- Test status:
  - `npm run test -- --filter=@superfunctions/extfn` passed.
  - `npm --workspace extfn/core test -- --run __tests__/content-anchors.test.ts __tests__/content-reinject.test.ts` passed.

### `CNT-002`

- Status: `PASS`
- Acceptance criteria evidence:
  - [anchors.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/src/content/anchors.ts) resolves `selector`, `selector-list`, and `resolver` anchors, returning deterministic anchor keys per resolved element.
  - [reinject.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/src/content/reinject.ts) supports `append`, `prepend`, `replace`, and `shadow` mounting modes.
  - [content-anchors.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/__tests__/content-anchors.test.ts) verifies selector-list anchors and resolver-export anchors mount three total instances with no errors.
  - [content-anchors.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/__tests__/content-anchors.test.ts) verifies a selector-list with no matching anchors becomes a no-op rather than crashing.
  - [content-anchors.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/__tests__/content-anchors.test.ts) verifies resolver failures log `E_ANCHOR_RESOLUTION` while unrelated modules continue to mount.
- Test status:
  - `npm run test -- --filter=@superfunctions/extfn` passed.
  - `npm --workspace extfn/core test -- --run __tests__/content-anchors.test.ts __tests__/content-reinject.test.ts` passed.

### `CNT-003`

- Status: `PASS`
- Acceptance criteria evidence:
  - [mountRegistry.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/src/content/mountRegistry.ts) tracks connected roots and rejects duplicate remounts for the same `moduleId/anchorKey` with `E_RUNTIME_PROTOCOL`.
  - [reinject.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/src/content/reinject.ts) cleans up disconnected anchors and allows remount after DOM replacement, keeping reinjection idempotent.
  - [content-reinject.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/__tests__/content-reinject.test.ts) verifies repeated reinjection on the same DOM yields a single mounted instance and preserves messaging connectivity.
  - [content-reinject.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/__tests__/content-reinject.test.ts) verifies remount after DOM replacement recreates the mount cleanly without duplicate roots.
  - [mountRegistry.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/src/content/mountRegistry.ts) scopes duplicate detection and failure handling per module/anchor pair instead of taking down the whole reinjection cycle.
- Test status:
  - `npm run test -- --filter=@superfunctions/extfn` passed.
  - `npm --workspace extfn/core test -- --run __tests__/content-anchors.test.ts __tests__/content-reinject.test.ts` passed.

### `CNT-004`

- Status: `PASS`
- Acceptance criteria evidence:
  - [contentScript.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/src/content/contentScript.ts) validates `styleIsolation` and rejects unsupported values with `E_CONFIG_INVALID`.
  - [reinject.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/src/content/reinject.ts) implements `inherit`, `root-scoped`, and `shadow-root` style-isolation behavior plus optional normalized root styles.
  - [reinject.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/src/content/reinject.ts) attaches style tags idempotently to the correct mount root or shadow root.
  - [content-reinject.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/__tests__/content-reinject.test.ts) verifies `shadow-root` isolation with `normalizeRootStyles: true` produces one style tag and normalized root styling across remounts.
  - [content-anchors.test.ts](/Users/serro/.codex/worktrees/f9b1/superfunctions/extfn/core/__tests__/content-anchors.test.ts) verifies invalid `styleIsolation: "global"` fails with `E_CONFIG_INVALID` and message `Unsupported styleIsolation mode: global`.
- Test status:
  - `npm run test -- --filter=@superfunctions/extfn` passed.
  - `npm --workspace extfn/core test -- --run __tests__/content-anchors.test.ts __tests__/content-reinject.test.ts` passed.

## Deliverables Summary

- Files changed/added:
  - `extfn/core/src/content/contentScript.ts`
  - `extfn/core/src/content/anchors.ts`
  - `extfn/core/src/content/mountRegistry.ts`
  - `extfn/core/src/content/reinject.ts`
  - `extfn/core/src/config.ts`
  - `extfn/core/src/errors.ts`
  - `extfn/core/src/index.ts`
  - `extfn/core/src/types.ts`
  - `extfn/core/package.json`
  - `package-lock.json`
  - `extfn/core/__tests__/content-anchors.test.ts`
  - `extfn/core/__tests__/content-reinject.test.ts`
  - `extfn/core/__tests__/fixtures/content/app.css`
  - `extfn/core/__tests__/fixtures/content/resolvers.mjs`
  - `extfn/core/__tests__/fixtures/content/twitter-post.ts`
  - `extfn/core/__tests__/fixtures/content/twitter-profile.ts`
  - `extfn/core/__tests__/fixtures/content/youtube-toolbar.ts`
- Files deleted/modified:
  - No files deleted.

## Verification Summary

- Phase verification steps executed:
  - `npm run test -- --filter=@superfunctions/extfn` - `PASS`
- Supporting verification executed:
  - `npm --workspace extfn/core run build` - `PASS`
  - `npm --workspace extfn/core test -- --run __tests__/content-anchors.test.ts __tests__/content-reinject.test.ts` - `PASS`
  - `npm install --workspace extfn/core --ignore-scripts` - `PASS`
- Test execution results:
  - `@superfunctions/extfn`: `8` test files passed, `25` tests passed.
  - Focused content verification: `2` test files passed, `5` tests passed.

## Notes

- Content modules now resolve as first-class config entries, so content-script validation is part of the main extension config load instead of a separate runtime-only path.
- Anchor resolution supports selector lists and resolver exports without requiring product-specific DOM contracts in core.
- Duplicate mount detection is scoped to a module and anchor identity, which keeps reinjection failures isolated instead of corrupting other content mounts.
- Deterministic root ids intentionally collapse the default `anchor-0` suffix so single-anchor modules get stable ids like `extfn-root-twitter-post`.
- Style isolation stays local to the chosen root or shadow root; no document-global stylesheet injection was introduced in this phase.
- `E_ANCHOR_RESOLUTION` was added to the shared extfn error catalog to make resolver failures auditable and non-fatal.
- No `TODO`, `FIXME`, or `XXX` markers were introduced in the phase-four files.

## Ready For Next Phase?

- Yes. Content-module validation, anchor resolution, isolated mounting, and idempotent reinjection are in place and verified.

## Blockers

- None.
