# PHASE_16 execution report

## Metadata

| Field | Value |
| --- | --- |
| Timestamp | `2026-07-22T13:27:34Z` |
| Agent | Codex |
| Model | GPT-5 Codex |
| Launcher | Codex Desktop |
| Workspace | repository root |
| Environment | Darwin arm64; shell `zsh`; Node `v20.20.0`; npm `10.8.2` |
| Git branch | `SFN-15` |
| Git commit | `9cf381238d1d8a11c899d6808ffb0bb73dfe839a` |
| Git state | dirty before and after Phase 16; existing user and prior-phase changes were preserved |
| Phase definition hash | `1abc7416bdbaf9f02848f4d4164bdcfc8e1da0c0523c046be9bb0071d12595f5` |
| Lockfile hash | `abff4d8eac0d1a1def427b525bd4c2a169c3c6d84775f64fd0e5328e0d4b5e1b` |
| Canonical Phase 16 evidence | `uifn/.conduct/evidence/phase-16/20260722T132517Z-PHASE-16-final/phase-16.json` (`fdb84a3193287f8567b60a9c1b591bb3b0183c8bbf5e0e7aab3f5c94d81063b2`) |
| Clean-consumer evidence | `uifn/.conduct/evidence/phase-16/20260722T132517Z-PHASE-16-final/clean-consumers.json` (`f4ef338ff4597dc5ec9116bda7af66b85fc9cbf92a5dc27e3fc75bf289a2f748`) |
| Signed registry catalog | `uifn/registry/generated/catalog.json` (`f3efae51b95d1aaa1f7b9cc195a64519b68b6784a2da60ca6c327b26db2d1868`) |
| Delivery manifest | `uifn/registry/generated/delivery-manifest.json` (`4fe4e31be71676158c43ce3fcab28fe69d6be37bde7a1337ee57f19228f855f9`) |

## Phase

- Phase: `PHASE_16`
- Status: **PASS**
- Requirements: `GEN-001`, `REG-001`
- Vectors: `TV-GEN-001-P/N`, `TV-REG-001-P/N`

## Gate boundary used

Phase 16 is complete under the approved split-gate model. The Phase 14 semantic implementation gate (`ADAPT-001`, `PARITY-001`) passes and permits Phases 15–18. The signed external compatibility gate (`COMPAT-001`) remains open and must later bind this exact delivery work to a certified release-candidate artifact set before Phase 19, Phase 20, publication, support promises, or a `10/10` readiness claim.

This report does not treat local tarballs, Chromium, or registry signatures as a substitute for the required signed browser/device compatibility matrix.

## Outcome

Phase 16 replaces separate package and copied-source implementations with one deterministic delivery compiler. The compiler reads the canonical 61-primitive / 419-part anatomy once, creates package sources and copied-source templates from the same in-memory output, and records every output hash, byte count, definition hash, generator hash, version, license, dependency, and clean-room provenance record. React and Solid now own a self-contained generated module per primitive; Svelte owns a generated directory per primitive. Root indexes re-export those modules instead of serving as a second implementation.

The stable source registry is now a bundled, offline-capable schema-v2 catalog containing the same 61 artifacts and exactly 602 templates. A detached Ed25519 signature is verified before catalog use. The public trust root is committed; the ephemeral private key used to create the signature was deleted and is not in the repository or package.

Registry installation is plan-first and fail-closed. Complete framework, dependency, graph, checksum, signature, license, provenance, destination, case-collision, containment, and symlink validation happens before writes. Successful changes stage on the consumer filesystem and commit through atomic renames. Preconditions detect concurrent changes. Injected interruption restores original bytes and removes created files/directories. Dry runs return the exact public plan without writing; repeated installs are byte-idempotent; dirty updates and removals return base/local/incoming hashes instead of overwriting consumer work.

Six independent tarball consumers—package and source mode for React, Svelte, and Solid—passed type checking, production build, SSR, real Chromium hydration, semantic DOM tracing, and axe serious/critical checks. Each framework's package and source trace was exactly equal. Source locks recorded schema v2, canonical `1.0.0`, generator `16.0.0`, catalog/signing identities, dependencies, file hashes, and clean-room provenance without repository-only import leakage.

## Requirements summary

### `GEN-001` — PASS

1. One compiler produced package sources and source-install templates for 61 components / 419 parts / 602 templates.
2. Every template is byte-identical to its package source; every embedded catalog copy matches both.
3. Two consecutive clean generation checks passed with definition SHA-256 `3551faf58e62adf4495d0e1e5b124bab4ddd9f9b21db99f27aa901204a8e726a` and generator SHA-256 `df7d5b101209a737e02008a235e39d18b2b5b69454921ce9c97b9c103066606c`.
4. A hand-edited generated-output mutation fails with `UIFN_GENERATED_SOURCE_DRIFT`.
5. The 45 obsolete hand-maintained stable registry component manifests were removed. The generated delivery manifest is the exact output inventory.
6. Six clean consumers passed package/source type, build, SSR, hydration, browser, a11y, and trace equivalence.
7. The inherited Phase 14 semantic corpus replay passed its 366 golden comparisons, 183 cross-install comparisons, and three seeded semantic mutations.

### `REG-001` — PASS

1. The schema-v2 bundled catalog validates the exact React/Svelte/Solid framework set, artifacts, dependencies, graph, checksums, licenses, provenance, paths, and outputs.
2. Detached Ed25519 verification passed with key ID `d5e16295e5e7a35bc1e2ed39` and catalog SHA-256 `f3efae51b95d1aaa1f7b9cc195a64519b68b6784a2da60ca6c327b26db2d1868`.
3. Dry-run no-write, atomic commit, repeat idempotence, dirty conflict, safe remove, and exact provenance tests passed.
4. Bad checksum, traversal, symlink escape, dependency cycle, unsupported framework, invalid signature, invalid license/provenance, and mid-commit interruption were rejected with stable codes.
5. Fault-injected rollback left project and outside-target snapshots byte-identical.
6. Registry type checking, 17/17 tests, ESM/CJS/DTS builds, packed-package dry run, and the compatibility CLI surface passed.

## Deliverables

Canonical generation and gates:

- `scripts/uifn-delivery-generator.mjs`
- `scripts/generate-uifn-phase-15.mjs`
- `scripts/generate-uifn-phase-16.mjs`
- `scripts/sign-uifn-registry.mjs`
- `scripts/verify-uifn-phase-15.mjs`
- `scripts/verify-uifn-phase-16.mjs`
- `scripts/verify-uifn-phase-16-contract.test.mjs`
- `scripts/verify-uifn-phase-16-consumers.mjs`
- `scripts/verify-uifn-registry.mjs`
- root `package.json` and `package-lock.json`

Generated delivery outputs:

- `uifn/components-react/src/generated/**` — 61 generated primitive modules.
- `uifn/components-solid/src/generated/**` — 61 generated primitive modules.
- `uifn/components-svelte/src/generated/**` — 61 generated primitive directories / 480 files.
- `uifn/components-react/src/index.ts`, `uifn/components-solid/src/index.ts`, and `uifn/components-svelte/src/index.ts` — generated re-export boundaries.
- `uifn/components/src/generated/catalog.ts` and `uifn/components/src/generated/neutral.ts`.
- `uifn/components/styles.css`.
- `uifn/registry/generated/templates/**` — exact 602-file copied-source tree.
- `uifn/registry/generated/delivery-manifest.json` — complete path/hash/byte inventory for all generated delivery outputs.
- `uifn/registry/generated/catalog.json`, `uifn/registry/src/generated/catalog.ts`, `uifn/registry/generated/catalog-signature.json`, and `uifn/registry/src/generated/signature.ts`.
- `uifn/registry/trust/registry-ed25519-public.pem`.

Registry runtime and tests:

- `uifn/registry/src/schema.ts`
- `uifn/registry/src/trust.ts`
- `uifn/registry/src/build-registry.ts`
- `uifn/registry/src/plan.ts`
- `uifn/registry/src/transaction.ts`
- `uifn/registry/src/add.ts`
- `uifn/registry/src/diff.ts`
- `uifn/registry/src/update.ts`
- `uifn/registry/src/remove.ts`
- `uifn/registry/src/lockfile.ts`
- `uifn/registry/src/cli.ts`
- `uifn/registry/src/index.ts`
- `uifn/registry/src/validate-catalog.ts`
- `uifn/registry/src/__tests__/catalog.test.ts`
- `uifn/registry/src/__tests__/stable-lane.test.ts`
- `uifn/registry/src/__tests__/registry-cli.test.ts`
- `uifn/registry/package.json` and `uifn/registry/README.md`
- Removed `uifn/registry/catalog/components/*.json` (45 obsolete, untracked hand-maintained manifests).

## Verification summary

| Check | Result |
| --- | --- |
| Phase 16 static contract | 3/3 tests pass |
| Deterministic generation | two consecutive checks pass |
| Generated delivery coverage | 61 components, 419 parts, 602 templates |
| Package/template byte equality | 602/602 pass |
| Legacy stable registry manifests | 0 remain |
| Registry signature | Ed25519 valid; trusted catalog hash/key match |
| Registry typecheck/build | pass |
| Registry unit/adversarial tests | 17/17 pass |
| Registry packed-package dry run | pass |
| Clean package consumers | React, Svelte, Solid pass |
| Clean source consumers | React, Svelte, Solid pass |
| Per-consumer type/build/SSR/hydration/browser/a11y | 6/6 pass in every category |
| Package/source semantic traces | React equal; Svelte equal; Solid equal |
| Axe serious/critical violations | 0 across all six consumers |
| Phase 14 semantic parity replay | pass |
| Consolidated Phase 16 verifier | 10/10 commands pass; 0 failures |
| `git diff --check` | pass |

## Notes and limits

- Phase 16 is complete, but its evidence is provisional until the later signed Phase 14 compatibility certificate is bound to the same frozen release-candidate artifacts.
- The signed compatibility matrix remains open. No release, browser/device support, manual assistive-technology, or `10/10` readiness claim follows from this phase.
- The registry currently bundles source templates into its compiled CLI. Its dry-run tarball passed, but size optimization and hard package budgets remain owned by Phase 20.
- The retained `uifn/components/registry/components` metadata is consumed by current Storybook/accessibility tooling and is not an independent source implementation. Phase 17 owns migration of those executable public surfaces to the canonical delivery contract.
- The Node-20 engine warning for `rollup-plugin-visualizer@7.0.1` appeared during the lockfile-only install. It did not fail Phase 16; runtime/toolchain certification remains owned by the compatibility and release phases.
- No commit, push, pull request, trusted workflow dispatch, publication, or deployment occurred.
- The tracker was not advanced because Phase 20 is the final tracker-closing phase.

## Rollback notes

Rollback must keep generated package sources, source templates, catalog payload, delivery manifest, signature envelope, public trust root, registry runtime, tests, package metadata, and lockfile coherent. Do not restore the old 45-manifest stable registry or an independently maintained copied-source implementation. If generation changes, regenerate all package/template outputs and sign the exact new catalog with an authorized Ed25519 private key; never commit or ship a private signing key. If transaction behavior is reverted, preserve plan-before-write, path/symlink containment, preconditions, atomic staging, and byte-exact rollback as non-negotiable safety properties.

## Ready for next phase?

**Yes — Phase 17.** Storybook and documentation may now consume the frozen Phase 16 package/source delivery outputs under the passing semantic implementation gate.

## Blockers

None for Phase 16 or entry to Phase 17. Signed external compatibility remains a later Phase 19/20 and release blocker.
