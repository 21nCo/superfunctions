# PHASE_20 — Performance, security, evidence closure, and 1.0 release

## Objective

Prove hard consumer/runtime budgets and supply-chain integrity, close semantic test coverage, and release the exact fully verified 1.0 artifact set.

## Entry

- Phase 19 accessibility assessment passes on current candidate artifacts.
- Phase 14 signed compatibility certification and all prior phase reports are complete; any code change after certification or Phase 19 invalidates/requires affected evidence and review retest.

## Requirements

- `TEST-001`, `PERF-001`, `PERF-002`, `SEC-001`, `REL-001`, `REL-002`.

## Work

1. Measure exact `SPEC.md` gzip/tree-shaking/tarball budgets using esbuild and Rollup/Vite public-import consumers; inspect module graphs and allowlisted packed contents.
2. Run fixed-device dispatch/DOM/overlay/virtualization benchmarks with warmup/statistics/raw results and stress mount/interact/destroy for listeners/observers/timers/RAF/abort tasks/detached nodes/heap.
3. Complete threat model, source/tarball/dependency/license/secret/unsafe-DOM/registry scans, SBOM, reproducible build, signed tag/artifacts, attestation, and clean-room attribution review.
4. Close requirement/vector/primitive/family semantic and mutation coverage; add permanent regressions for all P0/P1 fixes.
5. Build exact RC tarballs/source outputs, install clean registry consumers, execute non-dry-run full release gate, validate all 54 requirements/evidence/matrix/budgets/defects, and freeze hashes.
6. Verify semver/peers/changelogs/migrations/dist-tags, publish atomically with signatures/provenance, verify downloaded bytes, and rehearse/document rollback.

## Required evidence

- `TV-TEST-001-P/N`, `TV-PERF-001-P/N`, `TV-PERF-002-P/N`, `TV-SEC-001-P/N`, `TV-REL-001-P/N`, `TV-REL-002-P/N`.
- Raw bundle/benchmark/resource data; complete SPDX/CycloneDX SBOM; vulnerability/license dispositions; signed provenance; exact tested/published hashes.
- Release manifest has current pass evidence for every requirement/vector/matrix row and zero blocker; dry-run output is never accepted.

## Exit gate

Accessibility confidence is independently signed 10/10, production maturity rubric is 10/10, all hard budgets and supply-chain gates pass, tested/published bytes match, and rollback is proven. Only then may tracker status become complete.

## Do not

- Do not raise budgets to fit results without explicit spec/user change and rationale.
- Do not publish untested rebuilds or allow missing/stale/blocked evidence.
- Do not call a signed tag alone supply-chain provenance.

## Handoff

Final report records release version/dist-tags/URLs/hashes/signatures/attestation/SBOM, matrix summary, independent assessment, known non-blocking limitations including JAWS deferment, and rollback procedure.
