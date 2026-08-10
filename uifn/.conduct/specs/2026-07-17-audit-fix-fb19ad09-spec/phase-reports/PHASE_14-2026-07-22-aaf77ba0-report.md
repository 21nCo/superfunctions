# PHASE_14 continuation execution report

## Metadata

| Field | Value |
| --- | --- |
| Timestamp | `2026-07-21T21:52:15Z` |
| Agent | Codex |
| Model | GPT-5 Codex |
| Launcher | Codex Desktop |
| Workspace | repository root |
| Environment | Darwin 25.4.0 arm64; shell `zsh`; Node `v20.20.0`; npm `10.8.2` |
| Git branch | `SFN-15` |
| Git commit | `9cf381238d1d8a11c899d6808ffb0bb73dfe839a` |
| Git state | dirty before and after this continuation; existing user and prior-phase changes were preserved |
| Phase definition hash | `0fb439894fb6c52ec3d0024174e60cd5795051b39c1e37d2cf990e93049742aa` |
| Lockfile hash | `cebda7f8280b4981bbd8556dd2954f161fc5c07d17c17cd411555635cff31104` |
| Canonical aggregate | `uifn/.conduct/evidence/phase-14/2026-07-21T21-46-55-000Z-PHASE-14-raw-result-chain-final/phase-14.json` (`178ef43f8cefee67fe1f73478d3f0d14623689b4d88a974b19152729355a81d1`) |
| Parity evidence | `uifn/.conduct/evidence/phase-14/2026-07-21T21-46-55-000Z-PHASE-14-raw-result-chain-final/parity.json` (`f5b96cf2d71146379d5bafb87b7c52eaffe9a7f8d44578fb73a90aefd1867f29`) |
| Compatibility evidence | `uifn/.conduct/evidence/phase-14/2026-07-21T21-46-55-000Z-PHASE-14-raw-result-chain-final/compatibility.json` (`bf47da667db061d0a0a1f11f09a91447b5d7ad662314ec507cd757454f43aeff`) |
| Trace/package evidence | `uifn/.conduct/evidence/phase-14/2026-07-21T21-46-55-000Z-PHASE-14-raw-result-chain-final/traces/trace-run.json` (`863d283a25f3055585e9553815ec9bb656ea2d5aead5c4a7c28649b7f71b14f3`) |

## Phase

- Phase: `PHASE_14`
- Status: **BLOCKED — SIGNED EXTERNAL COMPATIBILITY MATRIX**
- Requirements: `ADAPT-001`, `PARITY-001`, `COMPAT-001`
- Vectors: `TV-ADAPT-001-P/N`, `TV-PARITY-001-P/N`, `TV-COMPAT-001-P/N`
- Scope of this continuation: close the offline raw-result evidence-chain gap and replace token-only workflow checks with parsed, job-scoped contract validation.

## Outcome

Phase 14 remains blocked, but its signed-evidence contract is stronger. Compatibility schema version 3 binds each cell to the exact raw `.result.json` filename and canonical SHA-256. The offline verifier now requires that file, recomputes its hash, checks that it reproduces the signed cell environment/command/observation/device-lab fields, and verifies both the compatibility document and raw result against the same GitHub Sigstore bundle.

The workflow verifier now parses YAML and proves the exact seven-job topology, six freeze-dependent consumer job groups, exact 35 cells, per-job permissions, runner invocation, evidence creation, dual-subject attestation, three-file upload, exact runner labels, immutable action pins, fail-closed behavior, and trust policy. Removing a raw result from either an attestation or upload is a controlled failing vector.

The final canonical aggregate ran 28 checks. All 27 implementation/parity/workflow checks passed. The sole rejected check remains the intentionally empty `signed-compatibility-matrix`: `0/35` accepted, 35 missing. The aggregate correctly returned `BLOCKED_EXTERNAL_MATRIX`; Phase 15 remains locked.

## Requirements summary

### `ADAPT-001` — PASS

Acceptance criteria evidence:

1. Static adapter-kit scans and `TV-ADAPT-001-N` continue to reject primitive behavior, key maps, focus/layer code, local stores, and lossy normalization.
2. The trace contract continues to cover events, snapshots, actions, parts, callbacks, DOM/ARIA/focus, errors, and cleanup.
3. The aggregate’s adapter typecheck, 15-test suite, build, static scan, and two controlled-negative tests all passed.

Test status: `adapter-typecheck`, `adapter-test`, `adapter-build`, `adapter-negative`, and `adapter-static` passed in the canonical aggregate.

### `PARITY-001` — PASS

Acceptance criteria evidence:

1. React, Svelte, and Solid actual public trees matched the reviewed golden across source and packed-package modes: 366/366 comparisons and 183/183 cross-install comparisons.
2. Separate Solid ARIA, Svelte callback-order, and React focus mutations were killed at their exact JSON-pointer paths.
3. No framework exception was required by the current 61-compound, 419-part corpus.

Test status: `actual-source-packed-traces`, `parity-golden`, and `parity-mutations` passed. React 18.3.1/19.2.3, Svelte 5.46.4, Solid 1.9.13, and Node 20.20.2/22.23.1/24.18.0 were observed in the packed run.

### `COMPAT-001` — PARTIAL / RELEASE-BLOCKED

Acceptance criteria evidence:

1. The exact 35-cell workflow and schema can record commit, snapshot, tarball/consumer-kit hashes, OS/device/browser/framework versions, raw results, jobs, and device-lab metadata. Actual signed external rows remain absent.
2. React/Svelte/Solid peer-range cells and exports are represented by exact required matrix entries; the local packed framework runs pass, but only signed rows can validate the release peer ranges.
3. Missing evidence remains explicit and release-blocking. Schema v3 additionally rejects a missing, renamed, tampered, independently attested, or structurally divergent raw result.

Test status: the compatibility contract suite passed 9/9, the evidence producer passed 3/3, the workflow contract suite passed 4/4, the exact workflow reports 35/35 signed-capable cells, and the trusted matrix remains 0/35 because no external workflow was dispatched.

## Deliverables summary

Files modified in this continuation:

- `package.json`
- `package-lock.json`
- `scripts/create-uifn-phase-14-compat-evidence.mjs`
- `scripts/create-uifn-phase-14-compat-evidence.test.mjs`
- `scripts/verify-uifn-phase-14-compat.mjs`
- `scripts/verify-uifn-phase-14-compat.test.mjs`
- `scripts/verify-uifn-phase-14-workflow.mjs`
- `scripts/verify-uifn-phase-14-workflow.test.mjs`
- `uifn/.conduct/compatibility/phase-14-runner-contract.md`

Files/directories added in this continuation:

- `uifn/.conduct/evidence/phase-14/2026-07-21T21-46-55-000Z-PHASE-14-raw-result-chain-final/` — 49 generated evidence files, including the aggregate, parity, compatibility, six tarballs, frozen 23-file consumer kit, framework traces, and trace manifest.
- `uifn/.conduct/specs/2026-07-17-audit-fix-fb19ad09-spec/phase-reports/PHASE_14-2026-07-22-aaf77ba0-report.md`

Files deleted: none.

## Verification summary

| Command | Result |
| --- | --- |
| `node --check` for the three changed Phase 14 scripts | pass |
| `node --test scripts/*uifn-phase-14*.test.mjs` | 29 pass, 0 fail, 2 parity tests intentionally skipped without a trace-directory input |
| `npm ci --ignore-scripts --no-audit --no-fund --dry-run` | pass; lockfile accepts the explicit root `yaml` dependency |
| `node --test scripts/create-uifn-phase-14-compat-evidence.test.mjs scripts/verify-uifn-phase-14-compat.test.mjs scripts/verify-uifn-phase-14-workflow.test.mjs` | 16/16 pass |
| `node scripts/verify-uifn-phase-14-workflow.mjs` | pass; exact 35/35 signed-capable cell contract |
| `UIFN_PHASE14_EVIDENCE_ROOT=... node scripts/verify-uifn-phase-14.mjs` | expected exit 1, `BLOCKED_EXTERNAL_MATRIX`; 27/27 implementation checks pass, only 0/35 signed matrix fails |
| `git diff --check` | pass |

Canonical package/harness identity:

- Artifact-set SHA-256: `0a5b3d6d0277833c5d5aef872660b5fd70fef492cf156a3f24e2d3545e7dc57a`.
- Consumer-kit SHA-256: `b7b4d6b8285d6737e6f98e87dcb5412ce8bba3455e844e913d11ac1cb368eef8`.
- Local dirty-source snapshot SHA-256: `5d9fdb2f57c7ffee550e6cbd28a38faa3da39b8b86d96e28155de93432b520c8`; diagnostic only and not acceptable as signed release evidence.

## Notes

- The original offline verifier proved the `.compat.json` attestation but did not independently require or verify its downloaded raw `.result.json` subject.
- Schema version 3 is a clean break; there are no accepted signed v2 cells to migrate.
- `yaml` is now an explicit root development dependency because the root workflow verifier imports it directly.
- The lockfile dry run emitted an existing Node-20 engine warning for `rollup-plugin-visualizer@7.0.1`; the Phase 14 freeze and signed workflow use Node 22, and the dry run still completed successfully.
- The final local evidence was intentionally produced from a dirty source tree and is diagnostic, not a substitute for a clean attested workflow run.
- No signed evidence was fabricated or copied from local Chrome diagnostics.
- No commit, push, pull request, workflow dispatch, self-hosted runner provisioning, device-lab session, publication, or deployment occurred.
- Phase 15 was not started because its entry gate requires Phase 14 public parity and compatibility to pass.
- The project tracker was not advanced because Phase 14 is non-final and blocked.
- Existing unrelated and prior-phase worktree changes were preserved.

## Rollback notes

Rollback is limited to compatibility schema v3 raw-result subject metadata, dual-subject offline verification, parsed workflow contract validation/tests, the explicit root `yaml` dependency, and the runner-contract paragraph. If reverted, do not retain schema v3 compatibility documents or claim raw results were independently verified. Never weaken the 35-cell completeness, exact-product/device rules, clean-source requirement, dual-subject attestation, freshness window, or fail-closed status to obtain a pass.

## Ready for next phase?

**No.** Phase 15 remains locked until the trusted verifier accepts all 35 current signed cells for one clean source commit and one exact artifact/consumer-kit set.

## Blockers

1. The compatibility evidence input contains `0/35` GitHub Sigstore-verified schema-v3 cells because the trusted external workflow was not dispatched.
2. Exact current/previous Chrome, Firefox, Edge, Safari/iOS Safari, physical Android Chrome, and rendering runners still require the external infrastructure described in `uifn/.conduct/compatibility/phase-14-runner-contract.md`.
3. A clean reviewed commit is required before the freeze job can produce admissible evidence; the current local tree is intentionally dirty and uncommitted.
