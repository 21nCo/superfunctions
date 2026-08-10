# PHASE_02 — Canonical catalog and definition compiler

## Objective

Create one authoritative, validated definition pipeline for all 61 stable primitives and every downstream inventory.

## Entry

- Phase 01 stable package graph passes.
- The 61-name list and stable package set in `SPEC.md` are unchanged or explicitly reauthorized by the user.

## Requirements

- Owns `CAT-001`.
- Establishes the canonical foundation later completed by `GEN-001` and `A11Y-001`.

## Work

1. Define versioned schemas for primitive identity, anatomy, behavior family, inputs/events/states, controlled model, form semantics, DOM services, accessibility rules, framework support, vectors, docs/stories, package/source outputs, release status, and explicit exceptions.
2. Author complete entries for exactly the 61 GA primitives and distinguish interactive controllers from typed static contracts.
3. Build deterministic generation for package export inventories, anatomy/types stubs, adapter coverage manifests, registry metadata, story/docs/test manifests, and release matrices.
4. Add a clean-diff verifier, schema migrations, generator version/hash recording, and negative fixtures for omissions, duplicates, unsupported values, undocumented exports, and hand-edited outputs.
5. Encode the behavior-family phase ownership so generation may produce stubs/manifests but cannot label unimplemented primitives complete.

## Required evidence

- `TV-CAT-001-P` and `TV-CAT-001-N`.
- Two independent generation runs are byte-identical and produce a clean diff.
- Every catalog entry maps to requirements, vectors, owning phase, required DOM services, and three framework targets.

## Exit gate

Catalog is complete, deterministic, reviewed, and fails closed on drift. Generated stubs or metadata are never counted as implemented behavior.

## Do not

- Do not generate copied source or registry writes yet.
- Do not copy external project code, prose, tests, or internal schemas.
- Do not turn APG references into generic one-size-fits-all behavior.

## Handoff

Phase report provides compiler commands, schema version, catalog hash, all generated outputs, and the runtime contracts Phase 03 must satisfy.
