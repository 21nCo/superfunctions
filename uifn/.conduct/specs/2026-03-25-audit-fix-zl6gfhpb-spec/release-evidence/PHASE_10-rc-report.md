# PHASE_10 Release Candidate Report

## Result

- RC status: `BLOCKED`
- Release gate result: `FAIL`
- Clean install result: `FAIL`

`uifn` is not signable as a final GA React/Svelte release candidate from this worktree.

## Final Gate Summary

- Command: `cd /Users/serro/.codex/worktrees/e328/superfunctions && npm run verify:uifn-release`
- Result: package checks `PASS` for `@uifn/core`, `@uifn/react`, `@uifn/svelte`, `@uifn/vue`, and `@uifn/files`
- Policy results:
  - `consumerSmoke = pass`
  - `warningPolicy = pass`
  - `coverageMatrix = pass`
  - `manualA11y = fail`
- Blocking failure:
  - Code: `UIFN_ERR_MANUAL_EVIDENCE_INVALID`
  - Message: `Manual accessibility evidence MUST come from real browser and assistive-technology runs.`

## Clean Install State

- Command: `cd /Users/serro/.codex/worktrees/e328/superfunctions && npm ci`
- Result: `FAIL`
- Reason: the root lockfile is out of sync with unrelated monorepo changes in this worktree
- Exact blockers reported by npm:
  - `Missing: @filefn/viewer@0.1.0 from lock file`
  - `Missing: @types/node@22.19.15 from lock file`

This prevents a truthful “clean install” sign-off from the current root state even though the existing install can run the release gate.

## Verified Package Matrix

| Package | Version | Status | Result |
| --- | --- | --- | --- |
| `@uifn/core` | `0.0.1` | `GA` | Package checks passed |
| `@uifn/react` | `0.0.1` | `GA` | Package checks passed |
| `@uifn/svelte` | `0.0.1` | `GA` | Package checks passed |
| `@uifn/vue` | `0.0.1` | `Experimental` | Package checks passed |
| `@uifn/files` | `0.1.0` | `Experimental` | Package checks passed |

Remaining non-GA packages:

- `@uifn/vue`
- `@uifn/files`

## Evidence Referenced

- Coverage matrix: [PHASE_09-coverage-matrix.md](/Users/serro/.codex/worktrees/e328/superfunctions/uifn/.conduct/specs/2026-03-25-audit-fix-zl6gfhpb-spec/release-evidence/PHASE_09-coverage-matrix.md)
- Consumer smoke evidence: [PHASE_09-consumer-smoke.md](/Users/serro/.codex/worktrees/e328/superfunctions/uifn/.conduct/specs/2026-03-25-audit-fix-zl6gfhpb-spec/release-evidence/PHASE_09-consumer-smoke.md)
- Consumer smoke record: [consumer-smoke.json](/Users/serro/.codex/worktrees/e328/superfunctions/uifn/.conduct/release-evidence/consumer-smoke.json)
- Manual accessibility blocker record: [PHASE_09-manual-accessibility.md](/Users/serro/.codex/worktrees/e328/superfunctions/uifn/.conduct/specs/2026-03-25-audit-fix-zl6gfhpb-spec/release-evidence/PHASE_09-manual-accessibility.md)
- Manual accessibility root record: [manual-a11y.json](/Users/serro/.codex/worktrees/e328/superfunctions/uifn/.conduct/release-evidence/manual-a11y.json)
- RC manifest: [PHASE_10-release-manifest.json](/Users/serro/.codex/worktrees/e328/superfunctions/uifn/.conduct/specs/2026-03-25-audit-fix-zl6gfhpb-spec/release-evidence/PHASE_10-release-manifest.json)

## Docs and Export Review

The final root/package review still matches the shipped surface:

- Root docs only mention shipped exports and explicitly disclaim unshipped extras such as `TooltipProvider`, `TooltipArrow`, `ComboboxEmpty`, combobox multiple selection, and unshipped ContextMenu checkbox/radio/submenu parts.
- The compatibility matrix in `uifn/README.md` remains aligned with package manifests:
  - Node `18.x`, `20.x`, `22.x`
  - React `18.2+`
  - Svelte `5.x`
  - Vue `3.5+` as Experimental
- React root exports remain the family-root/helper surface in `uifn/react/src/index.ts`.
- Svelte root exports remain the shipped component family surface in `uifn/svelte/src/index.ts`.

## Blockers

1. A human verifier still needs to replace the blocked manual accessibility artifact with real browser + assistive-technology evidence covering React and Svelte families.
2. The root workspace lockfile drift needs to be resolved before `npm ci` can serve as a clean-install verification step for this monorepo state.

## Conclusion

The final RC closure work is complete, but the bundle remains blocked rather than releasable. The release gate is now precise: it passes consumer smoke, coverage, warning policy, and package checks, and it fails only on the missing real manual accessibility evidence. The root clean-install step is separately blocked by unrelated monorepo lockfile drift.
