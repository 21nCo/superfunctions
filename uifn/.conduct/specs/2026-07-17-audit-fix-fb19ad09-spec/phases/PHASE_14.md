# PHASE_14 — Actual public parity and compatibility matrix

## Objective

Prove that real exported React/Svelte/Solid component trees are semantically equivalent and supported across the full declared runtime/browser/device matrix.

## Entry

- Phases 11–13 complete all public compounds.
- Exact release-candidate-like tarballs can be produced for all stable core/DOM/adapter packages.

## Requirements

- `ADAPT-001`, `PARITY-001`, `COMPAT-001`.

## Work

1. Reduce adapter-kit to lifecycle/part/ref/event translation and the normalized trace/conformance harness; add static bans for behavior/DOM forks.
2. Replace synthetic/generic adapter verification with mounted actual public compound trees for every canonical vector and compare event/snapshot/callback/parts/DOM/ARIA/focus/error/cleanup traces.
3. Add semantic mutation tests that change one framework result at a time and prove parity fails at the precise field.
4. Execute React 18.3/19, Svelte 5, current Solid 1.x, Node 20/22/24, latest two Chrome/Firefox/Edge, current/previous Safari/iOS Safari, and current Android Chrome.
5. Record exact CI/device/OS/browser/framework/tarball versions/hashes and fail closed on skipped/stale/missing cells.

## Required evidence

- `TV-ADAPT-001-P/N`, `TV-PARITY-001-P/N`, `TV-COMPAT-001-P/N`.
- Full trace corpus and mutation outcomes; approved framework exceptions are explicit catalog entries with dedicated vectors.
- Signed device-lab/manual-device evidence where CI emulation cannot establish the cell.

## Split gates and exit

Phase 14 has two independent gates:

1. **Semantic-parity implementation gate (`ADAPT-001`, `PARITY-001`)** — every applicable actual public tree matches golden semantics across React, Svelte, and Solid in package/source modes; exact semantic mutations are killed. Passing this gate may unblock Phases 15–18.
2. **Compatibility-certification release gate (`COMPAT-001`)** — every declared compatibility cell is current, signed, bound to one clean exact artifact set, and accepted by the trusted verifier. Passing this gate is required to complete Phase 14 and enter Phase 19 or Phase 20.

The Phase 14 exit gate passes only when both sub-gates pass. Work may proceed through Phase 18 after the semantic-parity gate, but that sequencing MUST NOT be reported as Phase 14 completion or compatibility certification.

## Do not

- Do not normalize away semantic differences.
- Do not count Chromium emulation as Safari/iOS/Android device proof.
- Do not silently accept unexpected skips or infrastructure outages.

## Handoff

Phase report separately records semantic-parity and compatibility-certification status. The accepted parity corpus may be used by styling, distribution, and automated accessibility phases. Only a later report with the full signed compatibility matrix may freeze the release-candidate artifacts for manual AT and release.
