# PHASE_16 — Canonical package/source delivery and registry safety

## Objective

Make published packages and copied source equally first-class outputs from one definition pipeline, with a transaction-safe registry CLI.

## Entry

- Phase 14 semantic-parity implementation gate and Phase 15 define final headless/styled public surfaces. Phase 14 compatibility certification may remain open; Phase 16 evidence is provisional until bound to the later certified artifact set.
- Canonical compiler from Phase 02 is stable and versioned.

## Requirements

- `GEN-001`, `REG-001`.

## Work

1. Generate package exports and framework-specific copied-source modules from the same canonical logic/anatomy/templates/vectors; remove hand-maintained duplicate implementations.
2. Make regeneration deterministic and clean-diff enforced; record definition/template/generator/output hashes and provenance.
3. Build two independent clean consumer fixtures per framework for package and source modes; run type/build/SSR/hydration/browser/a11y/trace equivalence.
4. Implement registry planning/validation for framework/dependencies/conflicts/checksums/signatures/licenses/provenance/path containment and atomic staged commit/rollback.
5. Test dry-run no-write, repeat idempotence, traversal/symlink escape, bad checksum, cycle, unsupported framework, dirty conflict, interruption, and rollback.

## Required evidence

- `TV-GEN-001-P/N`, `TV-REG-001-P/N`.
- Clean generation, consumer traces, filesystem before/after hashes, and transaction fault-injection artifacts.
- Source-install manifests identify canonical version/provenance without leaking repository-only code.

## Exit gate

Package and source modes are semantically equivalent, generation cannot drift, and registry failures leave consumers byte-identical outside declared successful changes.

## Do not

- Do not maintain copied source as an independent implementation tree.
- Do not write before complete plan/validation; do not follow untrusted paths or symlinks outside project root.

## Handoff

Phase report freezes RC delivery outputs and provides exact consumer projects Storybook/docs/accessibility must use.
