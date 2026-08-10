# PHASE_14 continuation execution report

## Metadata

| Field | Value |
| --- | --- |
| Timestamp | `2026-07-21T20:14:51Z` |
| Agent | Codex |
| Model | GPT-5 Codex |
| Launcher | Codex Desktop |
| Workspace | repository root |
| Environment | Darwin 25.4.0 arm64; shell `zsh`; Node `v20.20.0`; npm `10.8.2` |
| Git branch | `SFN-15` |
| Git commit | `9cf381238d1d8a11c899d6808ffb0bb73dfe839a` |
| Git state | dirty before and after the continuation; existing user and prior-phase changes were preserved |
| Phase definition hash | `0fb439894fb6c52ec3d0024174e60cd5795051b39c1e37d2cf990e93049742aa` |
| Lockfile hash | `7d506c44267f978ed24dfea9c7d02fb7ed576fcda12aa6423015572b8d77ab21` |
| Vector manifest | `uifn/parity/generated/phase-14-public-vectors.json` (`cbc6c3cc0c902df63a436bd4f9025fba9a483a2bdb84638c65fe46ada006de2c`) |
| Reviewed golden | `uifn/parity/golden/phase-14-semantic-traces.json` (`c1a27948cddc80fed1fce17c2dd65266d6e809b93b1dbf961cb315030346a961`) |
| Aggregate evidence | `uifn/.conduct/evidence/phase-14/2026-07-21T20-09-29-000Z-PHASE-14-aggregate-15-lanes-valid-menu/phase-14.json` (`255f29261ddf5f35c462d9a6dbaa8d6ebff7b7fa04f40bf6b9779730db3bb4ae`) |
| Parity evidence | `uifn/.conduct/evidence/phase-14/2026-07-21T20-09-29-000Z-PHASE-14-aggregate-15-lanes-valid-menu/parity.json` (`f5b96cf2d71146379d5bafb87b7c52eaffe9a7f8d44578fb73a90aefd1867f29`) |
| Compatibility evidence | `uifn/.conduct/evidence/phase-14/2026-07-21T20-09-29-000Z-PHASE-14-aggregate-15-lanes-valid-menu/compatibility.json` (`bf47da667db061d0a0a1f11f09a91447b5d7ad662314ec507cd757454f43aeff`) |
| Trace/package evidence | `uifn/.conduct/evidence/phase-14/2026-07-21T20-09-29-000Z-PHASE-14-aggregate-15-lanes-valid-menu/traces/trace-run.json` (`e49cf41a911868a83153060fa915ca0aad34fea92a0ace2a2f39af411549e96d`) |

## Phase

- Phase: `PHASE_14`
- Status: **BLOCKED — SIGNED EXTERNAL COMPATIBILITY MATRIX**
- Requirements: `ADAPT-001`, `PARITY-001`, `COMPAT-001`
- Vectors: `TV-ADAPT-001-P/N`, `TV-PARITY-001-P/N`, `TV-COMPAT-001-P/N`
- Scope of this continuation: add React RSC-import and Svelte/Solid SSR-hydration compatibility lanes, harden frozen package evidence, resolve the Svelte packed-consumer mismatch, and eliminate a nondeterministic invalid Menu parity fixture.

## Outcome

Phase 14 is materially stronger but remains blocked. The checked-in attested workflow can now produce 15 of the exact 35 required signed cell types, up from 11:

- Node 20, 22, and 24;
- React 18.3 and 19 client, StrictMode, SSR/hydration, and RSC-import;
- Svelte 5 CSR and SSR/hydration;
- Solid 1 CSR and SSR/hydration.

Every framework mode executes the actual packed public package surface for all 61 public trees. The Svelte and Solid SSR lanes use real server rendering followed by real Chromium hydration, a fresh page per primitive, exact anatomy cardinality checks before and after hydration, duplicate-ID rejection, deterministic image resources, and zero accepted console warnings/errors or page errors. These local executions are implementation evidence; they are not mislabeled as signed browser-matrix coverage.

The authoritative aggregate returned `BLOCKED_EXTERNAL_MATRIX` with `implementationChecksOk: true`. It ran 27 checks: 26 passed and the sole rejected check was `signed-compatibility-matrix`. The compatibility input intentionally contains no fabricated local attestations, so the Sigstore verifier accepts `0/35` required cells and reports all 35 missing. Phase 15 remains locked.

## New framework rigor

### React RSC-import cells

The React 18.3 and React 19 consumers now scan and import the root plus all 61 direct primitive entrypoints from the frozen tarball. Each of the 62 entrypoints must begin with an explicit `'use client'` directive, import without `window` or `document`, expose a non-empty module namespace, and match the exact supported React line. A controlled negative test removes a direct-entry directive and proves the runner rejects it.

### Svelte 5 SSR/hydration

The prior Accordion hydration mismatch was reproduced in a packed consumer and traced to Vite prebundling the Svelte package differently between server and client. The retained runner excludes `@uifn/svelte` from dependency optimization and forces the package through SSR transformation. Accordion then passed, followed by all 61 packed trees. This was a consumer-harness configuration defect; no framework exception or hydration recovery was introduced.

### Solid 1 SSR/hydration

Solid now has one shared actual public-tree builder used by CSR and SSR/hydration. The packed runner renders all 61 trees with Solid's server runtime, includes the hydration bootstrap, hydrates in real Chromium, and rejects anatomy, ID, console, and page failures. Source and frozen-package runs both pass 61/61.

## Invalid Menu fixture defect killed

The first aggregate after adding the new lanes exposed a nondeterministic React Menu focus trace. The generic parity fixture had rendered `Item` as a sibling of `Content`. Opening the menu focused that outside item, the dismissable layer treated it as focus outside, and the menu closed again. React sometimes captured before focus restoration while Svelte and Solid captured after it.

The React, Svelte, and Solid fixtures now render both Menu and ContextMenu with valid composition: Trigger plus Positioner/Content, with Item/Indicator, Separator, Group/Label, and submenu parts inside Content. All three frameworks now deterministically:

- remain open after `setOpen(true)`;
- emit exactly one `onOpenChange(true)` callback;
- focus the active item;
- produce the same source and packed semantic trace.

The failed aggregate remains negative evidence and was not used as passing evidence. The reviewed golden was replaced only through the explicit acceptance ceremony after exact consensus across all three frameworks and both install modes. The new reviewed corpus passes 366/366 semantic comparisons, 183/183 source/package comparisons, and all three precise ARIA/callback/focus mutations.

## Frozen artifacts from the authoritative run

| Package | Tarball | SHA-256 |
| --- | --- | --- |
| `@uifn/core` | `uifn-core-0.0.1.tgz` | `10152e19d974347ee260a410aefe813828cd3dcecfa8591588b94d6432a9d60f` |
| `@uifn/dom` | `uifn-dom-0.0.1.tgz` | `85f8f38d626981d8ef0b165e872b5e1725736162995309578340d4c33650e148` |
| `@uifn/adapter-kit` | `uifn-adapter-kit-0.0.1.tgz` | `cecc040efc9d8282c66459104d4de75ca69dac9ae187adb0b95c3e73c163c90a` |
| `@uifn/react` | `uifn-react-0.0.1.tgz` | `3d9ee4b4b0bd8dc4062d68e2de562305033c31d3dcd5bcfb4244a82cb3627594` |
| `@uifn/svelte` | `uifn-svelte-0.0.1.tgz` | `b91fbe698efac2f8507a27feca28f79df80d00274e5d589d8ca29d43a06f42b9` |
| `@uifn/solid` | `uifn-solid-0.0.1.tgz` | `2782d959d4c2e778e9909d6fe13cb37bc90f5e208ee72d9d769767cbe71e8ef0` |

- Artifact-set SHA-256: `0a5b3d6d0277833c5d5aef872660b5fd70fef492cf156a3f24e2d3545e7dc57a`.
- Local source snapshot SHA-256: `622a9af7e3258d332b942492626aef432ee8fef5e9da3e569f975817cb0be9ec`.
- Source was dirty; the evidence producer therefore refuses to create attestable compatibility cells from this local run.
- Exact observed Node versions were `v20.20.2`, `v22.23.1`, and `v24.18.0`.
- Exact observed framework lines were React `18.3.1`/`19.2.3`, Svelte `5.46.4`, and Solid `1.9.13`.

## Verification summary

| Gate | Result |
| --- | --- |
| Core | 31 files, 160 tests; typecheck and build pass |
| DOM | 2 files, 4 tests; typecheck and build pass |
| Adapter kit | 3 files, 15 tests; static boundary, negative tests, typecheck, and build pass |
| Adapter typechecks | React, Svelte, and Solid pass; Svelte reports 0 errors and 0 warnings |
| Framework source/package parity | 366/366 comparisons pass |
| Source/package equivalence | 183/183 comparisons pass |
| Mutation proof | 3/3 precise semantic mutations killed |
| Framework compatibility runners | 12/12 local packed framework modes pass, each with 61 public trees |
| Node compatibility runners | Node 20/22/24 packed imports pass |
| Workflow contract | 3 Node + 12 framework = 15 signed-capable lane types; full-SHA actions and fail-closed checks pass |
| Repository whitespace | `git diff --check` passes |
| Signed compatibility matrix | blocked, `0/35` current verified cells |

## Remaining 20 external runner/lab cells

| Category | Count | Remaining cells |
| --- | ---: | --- |
| Real desktop browsers | 8 | Chrome latest/previous, Firefox latest/previous, Edge latest/previous, Safari current/previous |
| Physical mobile devices | 3 | iOS Safari current/previous and Android Chrome current |
| Rendering profiles | 9 | LTR, RTL, forced colors, reduced motion, zoom 200/400, light, dark, high contrast |

These rows require current, exact-product execution over the frozen artifact set and a verified one-cell Sigstore document. Playwright WebKit cannot stand in for Safari, Chromium cannot stand in for Edge, and emulation cannot stand in for physical iOS or Android evidence.

## Deliverables added or hardened

- `.github/workflows/uifn-phase-14-compat.yml` — expanded from 11 to 15 signed-capable foundational cells and installs the real Chromium runtime needed by framework hydration gates.
- `scripts/run-uifn-phase-14-react-rsc-cell.mjs` and its controlled-negative tests — exact React 18.3/19 RSC boundary/import verification.
- `scripts/run-uifn-phase-14-traces.mjs` — frozen Svelte/Solid SSR-hydration and React RSC trace production.
- `scripts/extract-uifn-phase-14-framework-cell.mjs` and workflow verifiers — exact allowlisting and byte-matched extraction of all 12 framework modes.
- Svelte real-browser SSR/hydration runner and actual-tree fixtures.
- Solid shared CSR/SSR actual-tree builder and real-browser SSR/hydration runner.
- Valid Menu/ContextMenu public-tree composition in all three adapter harnesses and React SSR coverage.
- Refreshed reviewed semantic golden after six-corpus consensus.

## Notes and limitations

- Phase 14 remains blocked and the global tracker was intentionally not advanced.
- Phase 15 must not begin because its entry depends on a passing Phase 14 exit gate.
- This report does not claim accessibility confidence 10/10 or production maturity 10/10.
- Local Chromium hydration, source tests, and frozen-package smoke results are not signed browser/device/profile matrix coverage.
- No GitHub workflow, physical device lab, commit, push, pull request, publication, or deployment was performed.
- The transient Svelte Vitest cache was removed after validation.

## Rollback notes

Rollback is scoped to the four new framework lanes, their workflow/extractor contracts, the Svelte and Solid browser-hydration fixtures, valid Menu/ContextMenu test composition, and the reviewed golden generated from that composition. Do not restore flat menu fixtures, accept hydration recovery, weaken direct `'use client'` checks, or relabel local/emulated results as signed external coverage. If any composition change is reverted, remove the reviewed golden and regenerate it only after all three frameworks and both install modes regain exact consensus.

## Ready for next phase?

**No.** Continue Phase 14 until all 35 exact signed compatibility cells pass. The implementation priority is now the eight real desktop-browser lanes and nine rendering-profile lanes, followed by the three physical mobile-device rows. Only a full aggregate `PASS` may unblock Phase 15.

## Blockers

1. The authoritative local evidence directory contains `0/35` verified signed cells because no clean GitHub/device-lab execution was performed.
2. Twenty exact browser/device/rendering cell types still require runners and/or external lab execution.
3. Safari current/previous and physical iOS/Android coverage require appropriate real-product infrastructure; emulation is explicitly rejected.
