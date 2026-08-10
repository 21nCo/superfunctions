# PHASE_17 execution report

## Metadata

| Field | Value |
| --- | --- |
| Timestamp | `2026-07-24T10:48:25Z` |
| Agent | Codex |
| Model | GPT-5 Codex |
| Launcher | Codex Desktop |
| Workspace | repository root |
| Environment | Darwin 25.5.0 arm64; shell `zsh`; Node `v20.20.0`; npm `10.8.2` |
| Git branch | `SFN-15` |
| Git commit | `9cf381238d1d8a11c899d6808ffb0bb73dfe839a` |
| Git state | dirty before and after Phase 17; existing user and prior-phase changes were preserved |
| Phase definition hash | `fdf90610c8716b9a3679435252e62d1f190e94e808fda12769cb42df2de8a42f` |
| Lockfile hash | `b6eb7085aaa93040ccc2d1290683d4d4670b7340166c1495523002a78b0abfeb` |
| Canonical Phase 17 evidence | `uifn/.conduct/evidence/phase-17/20260724T010655Z-PHASE-17-final/phase-17.json` (`edf1e5ae66fe13d10d3979eaaa79a64d233c12b0f3a9e683ff36ac38b5e9c1f2`) |
| Storybook evidence | `uifn/.conduct/evidence/phase-17/20260724T010655Z-PHASE-17-final/storybook.json` (`3d988bca2f629b8d0ff8e5168c7994eaaf129216fbfcda9844010979f5e02b86`) |
| Documentation evidence | `uifn/.conduct/evidence/phase-17/20260724T010655Z-PHASE-17-final/docs.json` (`b7ff8ff9f5ab7dedaedfbb02046193afa24191c14ce7193dbd54037f860e565c`) |
| Phase 16 revalidation | `uifn/.conduct/evidence/phase-16/20260724T010655Z-PHASE-17-revalidation/phase-16.json` (`c4baa867100492704ba0326d372879f53aab8017ee8f93ce30e93c1819103cff`) |

## Phase

- Phase: `PHASE_17`
- Status: **PASS**
- Requirements: `STORY-001`, `DOCS-001`
- Vectors: `TV-STORY-001-P/N`, `TV-DOCS-001-P/N`

## Gate boundary used

The approved split gate remains in force:

1. Phase 14 semantic implementation parity (`ADAPT-001`, `PARITY-001`) passes and permits Phase 18.
2. Signed external compatibility (`COMPAT-001`) remains mandatory before Phase 19, Phase 20, publication, support promises, or a `10/10` readiness claim.

Phase 17 evidence is therefore passing but provisional. Local Chromium, axe, tarball consumers, the reviewed semantic golden, and the detached registry signature do not substitute for the later signed browser/device/assistive-technology certificate.

## Outcome

Phase 17 turns Storybook and documentation into executable public-consumer surfaces generated from the canonical 61-primitive catalog.

The Storybook implementation provides real React, Svelte, and Solid workbenches, framework presets, an accessibility addon configuration, public-package story modules, and live recursive anatomy harnesses. The canonical inventory contains 1,914 stories: 638 per framework, covering 61 primitives and 11 required scenarios per primitive. Every final story was built from packed public packages, visited in Chromium, operated, and checked for console errors, page errors, failed network requests, runtime errors, semantic anatomy presence, portal behavior, and axe violations. All 1,914 passed.

Documentation now contains 61 generated primitive pages with 13 required sections each, 793 required sections total, and 11,626 catalog-leaf mappings. It includes package/source installation, controller and compound APIs, styling, SSR/hydration, forms, composition, accessibility, keyboard/pointer/touch behavior, limitations, and migration posture. The 366 generated samples cover React, Svelte, and Solid in both package and copied-source delivery modes. All six clean consumers installed tarballs, typechecked, built production bundles, booted in Chromium, and rendered exactly 61 sample roots without browser errors.

The browser audit found and fixed real production defects instead of weakening the verifier:

- selection wrappers emitted unsupported ARIA and nested checkbox/radio controls;
- range, meter, scrubber, cropper, and resize controls lacked names or required finite values;
- ContextMenu and HoverCard triggers exposed invalid popup ARIA;
- Select’s combobox trigger lacked a reliable accessible name;
- disabled styling caused insufficient contrast;
- Pagination accepted non-finite page values into runtime snapshots;
- FileUpload story topology nested interactive controls and passed invalid item identities;
- generic story values sent strings to numeric Pagination parts;
- generated Input documentation duplicated `aria-label`;
- the clean Storybook verifier invoked a removed Storybook CLI path.

The fixes are locked by core regression tests, exact runtime diagnostics, exhaustive story traversal, and clean documentation consumers.

## Requirements summary

### `STORY-001` — PASS

1. Canonical story generation is deterministic with definition SHA-256 `b4fb1eed9344928e8c8ceb80809ed185fc6128c02d4d32b64f57d3ad46366953` and generator SHA-256 `21a73a76e53b1405594e4ab8b5de6b03ae893a2f726312794841ad1874a27a4f`.
2. The built indexes contain exactly 638 stories and 61 docs entries for each of React, Svelte, and Solid.
3. Fifteen public package tarballs were installed into a clean consumer before the three Storybooks were built.
4. All 1,914 stories were visited and passed public-component, anatomy, interaction, network, console, runtime, portal, and axe checks.
5. Removing a Solid story export is rejected as `UIFN_STORY_MISSING`.
6. Replacing a Dialog story with static test-double markup is rejected as `UIFN_STORY_NOT_PUBLIC_COMPONENT`.

### `DOCS-001` — PASS

1. Sixty-one primitive pages contain all 793 required sections and map all 11,626 canonical leaf fields.
2. The sample manifest contains exactly 366 samples: 61 primitives × three frameworks × package/source modes.
3. All six clean consumers passed strict framework typechecking, production build, browser boot, and exact 61-root runtime assertions.
4. Generated page hashes, internal links, registry version claims, support claims, removed APIs, forbidden absolute paths, and sample hashes pass.
5. A stale Vue support claim is rejected as `UIFN_DOCS_UNSUPPORTED_CLAIM`.
6. A legacy `StateMachine` sample is rejected as `UIFN_DOCS_REMOVED_API`.

## Phase 16 artifact revalidation

The disabled-state contrast fix changed a Phase 16 generated CSS output. The fix was moved into `scripts/uifn-delivery-generator.mjs`, all 61 artifacts / 419 parts / 602 source templates were regenerated, and the exact new catalog was signed with a one-use Ed25519 key. The private key was created under `/tmp`, used once, deleted immediately, and was not written to the repository.

The current signature passes with:

- key ID `52bc9d0afaa99b8671b3e463`;
- signed catalog SHA-256 `12c06c726aef4f742d4babdd7f7af3a9d587f182785f7b444858a55ca3ad21b5`;
- delivery generator SHA-256 `3c56e4dd070fbf99dc0204474931c4b20b33ec5459a509cbc9cc8f5e6eba4937`;
- delivery manifest SHA-256 `638669381b39f53ee2fcc49daeb3a917a4c8f4388e85e3eff8edbf58528ee99a`.

The corrected canonical NumberInput string-value catalog identity made the Phase 14 golden metadata stale. The explicit golden-acceptance ceremony was rerun after exact three-framework and source/package consensus. It passed 366/366 semantic comparisons, 183/183 cross-install comparisons, and all three seeded ARIA/callback/focus mutations. The trace hash remained unchanged at `5ce3a4be91a87d560b8cdac06291e697bfea67dac7a70c90f288efdeb63974f6`.

The full Phase 16 verifier then passed 10/10 commands, including six clean package/source consumers and semantic parity replay. This revalidation is recorded rather than relying on stale Phase 16 evidence.

## Verification summary

| Check | Result |
| --- | --- |
| Deterministic Phase 17 generation | two consecutive checks pass |
| Storybook typecheck/tests/build/pack | pass |
| Phase 17 contract/mutation tests | 5/5 pass |
| Packed public packages for Storybook | 15 |
| Built React stories/docs | 638 / 61 |
| Built Svelte stories/docs | 638 / 61 |
| Built Solid stories/docs | 638 / 61 |
| Exhaustive browser story traversal | 1,914/1,914 pass |
| Story browser/console/network/runtime/axe failures | 0 |
| Documentation coverage | 61 pages, 793 sections, 11,626 mapped fields |
| Documentation samples | 366 |
| Clean docs consumers | 6/6 pass |
| Core typecheck/build | pass |
| Core tests | 32 files, 165 tests pass |
| Phase 16 signed revalidation | 10/10 commands pass |
| Phase 14 reviewed parity rebind | 366 comparisons, 183 cross-install comparisons, 3/3 mutations killed |
| Consolidated Phase 17 verifier | 10/10 commands pass; 0 failures |
| Private signing key residue | none |
| `git diff --check` | pass |

## Deliverables

Canonical generation and verification:

- `scripts/generate-uifn-phase-17.mjs`
- `scripts/uifn-phase-17-fixtures.mjs`
- `scripts/verify-uifn-phase-17-storybook.mjs`
- `scripts/verify-uifn-phase-17-docs.mjs`
- `scripts/verify-uifn-phase-17-contract.test.mjs`
- `scripts/verify-uifn-phase-17.mjs`
- corrected `scripts/uifn-delivery-generator.mjs`

Storybook and documentation:

- `uifn/storybook/**`
- `uifn/docs/generated/**`
- React/Svelte/Solid public Storybook workbenches and generated story modules
- exact story, docs-coverage, and sample manifests

Accessibility/runtime repairs:

- `uifn/core/src/__tests__/phase-17-accessibility.test.ts`
- selection, range/gesture, input, menu, hover-card, floating-panel, image-cropper, and pagination controller corrections
- generated disabled-state CSS with a contrast-safe default

Evidence:

- `uifn/.conduct/evidence/phase-17/20260724T010655Z-PHASE-17-final/**`
- `uifn/.conduct/evidence/phase-16/20260724T010655Z-PHASE-17-revalidation/**`
- reviewed Phase 14 semantic golden rebound to the corrected catalog identity

Failed verifier and sample attempts are retained beside the passing evidence. They document the obsolete Storybook CLI path and duplicate Input `aria-label` failure and were not used as passing evidence.

## Notes and limits

- Phase 17 passes its implementation gate and permits Phase 18.
- Evidence remains provisional until signed external compatibility is run against or cryptographically bound to the final release-candidate artifacts.
- The Storybook build reports large-chunk warnings. Those are non-failing here and remain part of Phase 20 performance/package budgets.
- Axe and browser automation do not establish screen-reader speech correctness. Phase 18 owns normative and expanded automated accessibility proof; Phase 19 owns signed human VoiceOver, NVDA, and TalkBack evidence. JAWS remains deferred by explicit user decision.
- No commit, push, pull request, trusted workflow dispatch, publication, or deployment occurred.
- The tracker was not advanced because Phase 20 is the only tracker-closing phase.

## Rollback notes

Rollback must keep Phase 16 generated packages/templates, delivery manifest, signed catalog, public trust root, Phase 17 inventories, generated docs, and evidence identities coherent. Do not revert only the generated CSS or catalog signature. If delivery generation changes, regenerate all outputs, sign the exact catalog with an authorized Ed25519 key, delete the private key, rebind reviewed parity only after exact consensus, and rerun all packed Storybook/docs consumers.

Do not restore the invalid ARIA, nested interactive controls, non-finite Pagination state, inaccessible disabled opacity, duplicate docs props, static story doubles, unsupported framework claims, or the obsolete Storybook CLI path.

## Ready for next phase?

**Yes — Phase 18.** The complete public Storybook/docs scenario inventory is available for normative accessibility ledgers and expanded automated proof.

## Blockers

None for Phase 17 or entry to Phase 18. Signed external compatibility remains a later Phase 19/20 and release blocker.
