# Intent audit

## Result

`PASS` for specification intent coverage. This does not mean the implementation is ready: source audit `ee1f9d6c` remains `FAIL`, and this bundle defines the work required to change that result.

## User intent trace

| User decision | Interpretation fixed by this spec | Requirements | Phases | Status |
| --- | --- | --- | --- | --- |
| 1. “acceptable” | Keep public `state + actions + parts`; implement one private owned runtime; focused proven dependencies are allowed after review. | `ARCH-001`, `ARCH-002`, `CORE-001`–`CORE-004`, `SEC-001`, `PERF-001` | 03, 04, 20 | Fully represented |
| 2. “drop both” | Delete Vue and Angular completely, including current product tooling/docs; preserve immutable history only. No shims. | `CLEAN-001`, `SCOPE-001`, `REL-002` | 01, 20 | Fully represented |
| 3. “confirmed” | Breaking cleanup is authorized; delete generic StateMachine/legacy creators/adapters rather than retaining compatibility paths. | `ARCH-003`, `CLEAN-001`, `REL-002` | 01, 04, 20 | Fully represented |
| 4. “expand” | Expand to the explicitly enumerated 61 stable primitives and shared algorithms/utilities. | `CAT-001`, `CAT-002`, `PRIM-001`–`PRIM-008` | 02, 06–10 | Fully represented |
| 5. “recommended” | Stable ecosystem includes core, DOM, adapter-kit, React/Svelte/Solid, hooks, styling, framework-isolated compounds, registry, Storybook/docs/examples; patterns/sf stay separate experimental. | `SCOPE-001`, `EXP-001`, `DOM-001`–`DOM-007`, `COMP-001`, `HOOK-001`, `GEN-001`, `STORY-001`, `DOCS-001` | 01, 05, 15–17 | Fully represented |
| 6. “recommended (leave out JAWS for now)” | Require WCAG 2.2 AA/APG plus VoiceOver macOS/iOS, NVDA Windows, TalkBack Android; JAWS alone is explicitly deferred and disclosed. | `A11Y-001`–`A11Y-004`, `COMPAT-001` | 18, 19 | Fully represented; one explicit deferment |
| 7. “recommended” | Test React 18.3/19, Svelte 5, current Solid 1.x, Node 20/22/24, latest two Chrome/Firefox/Edge, current+previous Safari/iOS Safari, current Android Chrome. | `COMPAT-001`, framework requirements | 11–14 | Fully represented |
| 8. “recommended” | Package and copied-source install are equal first-class delivery modes from one canonical pipeline. | `GEN-001`, `REG-001`, `REL-002` | 16, 20 | Fully represented |
| 9. “proceed” | Use hard evidence-backed numeric bundle/runtime/leak budgets that fail release. | `PERF-001`, `PERF-002`, `REL-001` | 20 | Fully represented |
| 10. “recommended” | Require automation, signed manual matrix, unresolved-defect gate, provenance/license evidence, and independent accessibility review before 1.0. | `OPS-001`, `A11Y-002`–`A11Y-004`, `SEC-001`, `REL-001`, `REL-002` | 00, 18–20 | Fully represented |
| 11. “split the gate conceptually” | Let mutation-proven public semantic parity unblock implementation Phases 15–18 while signed external compatibility remains mandatory for Phase 14 completion, manual AT entry, release, support claims, and both 10/10 claims. | `ADAPT-001`, `PARITY-001`, `COMPAT-001`, `REL-001` | 14–20 | Fully represented; no requirement deferred |

## Original goal trace

| Goal | Spec response | Proof of coverage |
| --- | --- | --- |
| Fix every previously identified downgrade | Deletes competing runtimes/legacy paths, centralizes DOM behavior, makes adapters behavior-free, adds complete compounds, and creates evidence-backed gates. | `ARCH-*`, `CORE-*`, `DOM-*`, `REACT-001`, `SVELTE-001`, `SOLID-001`, `PARITY-001`; Phases 03–14. |
| Reach rigor comparable to strong primitive approaches | Adds reactive runtime semantics, effects/cleanup/scope/refs/computed, canonical models, mutation/property testing, real public-tree parity, complete DOM services, compatibility and hard budgets. | `CORE-*`, `CAT-*`, `TEST-001`, `COMPAT-001`, `PERF-*`; Phases 02–14, 18, 20. |
| Accessibility confidence 10/10 | Requires normative ledgers, primitive-specific automation, device/browser behavior, signed human VoiceOver/NVDA/TalkBack results, zero blockers, and independent review. | `A11Y-001`–`A11Y-004`; Phases 18–19. |
| Production maturity 10/10 | Requires stable ownership, package isolation, clean distribution, compatibility, performance/leaks, security/SBOM/signatures/provenance, docs, evidence freshness, migration and rollback. | `OPS-001`, `SCOPE-001`, `GEN-001`, `COMPAT-001`, `PERF-*`, `SEC-001`, `REL-*`; Phases 00–20. |
| Support React, Svelte, Solid at minimum | Treats exactly these three as equal stable targets and removes Vue/Angular. | `CLEAN-001`, `REACT-001`, `SVELTE-001`, `SOLID-001`, `PARITY-001`; Phases 01, 11–14. |
| Create a new spec under `uifn/.conduct` | Creates audit-fix bundle `uifn/.conduct/specs/2026-07-17-audit-fix-fb19ad09-spec/` and the source audit. | Bundle inventory and `.conduct` logs/tracker. |

## Audit finding disposition

| Source-audit finding | Disposition in requirements | Owning phase(s) | Closure evidence |
| --- | --- | --- | --- |
| F-01: no authentic human/independent accessibility evidence | `A11Y-003`, `A11Y-004`, `REL-001` | 19, 20 | Signed AT rows and independent unqualified assessment on exact RC hashes. |
| F-02: no single rigorous behavior runtime | `ARCH-001`, `ARCH-003`, `CORE-001`–`CORE-004` | 03, 04 | One-runtime static proof, property/model/lifecycle tests, legacy scan. |
| F-03: frameworks own behavior and drift | `ARCH-003`, `ADAPT-001`, framework requirements, `PARITY-001` | 04, 11–14 | Actual public-tree semantic traces and behavior-fork scans/mutations. |
| F-04: DOM behavior too shallow/decentralized | `ENV-001`, `DOM-001`–`DOM-007` | 04, 05 | Cross-root/browser layer/focus/modal/position/presence/form/live and leak corpus. |
| F-05: conformance/browser checks allow false confidence | `PARITY-001`, `A11Y-002`, `TEST-001`, `REL-001` | 14, 18, 20 | Primitive-specific observed results and semantic mutations; no sidecars/irrelevant auto-passes. |
| F-06: Solid is incomplete | `SOLID-001`, `PARITY-001` | 13, 14 | Exact 61-catalog compound/anatomy match and actual Solid public-tree traces. |
| F-07: styled package couples frameworks/product demos | `COMP-001`, `STYLE-001`, `PERF-001` | 15, 20 | Framework-isolated tarballs, content scan, styled/headless trace equality, budgets. |
| F-08: controller lifecycle/update/metadata gaps | `ARCH-002`, `CORE-004` | 03, 04 | Uniform controller contract, destroyed errors, typed metadata/traces. |
| F-09: generic parts and wrong handler precedence | `PART-001` | 04 | Typed anatomy parts and cancellable user-first composition vectors. |
| F-10: core catalog breadth is too small | `CAT-001`, `CAT-002`, `PRIM-001`–`PRIM-008` | 02, 06–10 | Exactly 61 implemented catalog entries with family vectors and no undocumented exports. |
| F-11: package/source outputs are hand-maintained and distribution is weak | `SVELTE-001`, `GEN-001`, `REG-001`, `REL-002` | 12, 16, 20 | Compiled exports, deterministic generation, clean consumer equivalence, registry fault injection. |
| F-12: a11y requirements/evidence are not substantive enough | `PRIM-*`, `I18N-001`, `A11Y-001`–`A11Y-004` | 06–10, 18–19 | Normative rule ledger, explicit automation, human AT, independent review. |
| F-13: compatibility evidence is incomplete | `ENV-001`, framework requirements, `COMPAT-001` | 04, 11–14 | Exact supported framework/Node/browser/device matrix with hashes/versions. |
| F-14: no hard performance, size, or leak budgets | `PERF-001`, `PERF-002` | 20 | Reproducible consumer bundles, reference-device statistics, zero-resource leak evidence. |
| F-15: provenance/security checking is shallow | `REG-001`, `SEC-001`, `REL-002` | 16, 20 | Threat model, SBOM, licenses/vulnerabilities, signing/attestation, tested=published hashes. |
| F-16: release target/gate is mis-scoped | `SCOPE-001`, `EXP-001`, `REL-001`, `REL-002` | 01, 20 | Three-framework stable-only fail-closed non-dry release manifest. |
| F-17: Storybook verification can be metadata-only | `STORY-001`, `DOCS-001` | 17 | Built exact coverage and actual public-story operations. |
| F-18: large generated evidence obscures real rigor | `TEST-001`, `REL-001` | 00, 18, 20 | Requirement/vector trace, semantic mutation, compact summaries with immutable raw artifacts. |

All audit findings have an owner, at least one requirement, positive and negative vectors, an implementation phase, and a release-closure artifact. No finding is accepted as “documentation only.”

## External benchmark principles retained

The spec adopts principles, not copied internals:

- A machine/connect-like separation between portable behavior and DOM/framework binding, while keeping the machine private and the controller public.
- Ark-like cross-framework headless breadth, but only for the three confirmed frameworks.
- Base/Radix-like compound composition and native/ARIA focus on each framework.
- W3C WCAG 2.2 and APG/native behavior as normative accessibility inputs, supplemented by browser and human AT evidence.

Clean-room/source-license requirements in `SEC-001` prohibit copying external implementation, prose, tests, or styling.

## Explicit deferments

| Item | Status | Boundary |
| --- | --- | --- |
| JAWS testing | Deferred by user | MUST be disclosed as untested; cannot be implied by NVDA results. Adding JAWS later requires matrix/scripts/evidence but does not delay this specified 1.0. |
| Stable `@uifn/patterns` / `@uifn/sf` | Outside stable 1.0 by user decision | Remain separately versioned experimental; their failures cannot block or be hidden by stable release. |

There are no other deferred, optional, “MVP,” post-1.0, or best-effort items in this bundle.

## Sequencing amendment audit

The 2026-07-22 gate split changes dependency sequencing only. It does not weaken the 35-cell compatibility denominator, signature/freshness/artifact-identity requirements, human AT matrix, independent review, release invariant, or either 10/10 scorecard. Phase 14 remains incomplete while `COMPAT-001` is open, and all provisional Phase 15–18 evidence must still match or be rerun on the ultimately certified artifact set.

## Assumptions made without expanding scope

1. `@uifn/dom` is a new stable package at `uifn/dom`; final workspace naming may vary only if package name and dependency boundary remain exact.
2. Focused dependencies such as a positioning or tabbability library may be selected only after Phase 05/20 license, security, size, support, and wrapper-boundary review; this is permission to evaluate, not a predetermined dependency choice.
3. “Current” browser/framework versions are resolved and frozen when the release-candidate matrix begins, then recorded exactly; they are not floating during one evidence run.
4. Historical `.conduct` artifacts may retain Vue/Angular and old claims for provenance; current code/config/docs/generated product surfaces may not.

## Scope-creep audit

- The 61-primitives list is an intentional expansion chosen by the user, not an inferred side project.
- Security, performance, packaging, docs, Storybook, registry, support matrix, evidence, and operations are included because the user requested production maturity 10/10 and “everything that needs to be done in uifn/core and other packages.”
- No application/business workflow, design-system visual redesign, external code import, experimental-pattern GA work, Vue/Angular retention, or JAWS testing was added.
- No implementation is performed by this spec-writing task beyond `.conduct` artifacts and tracking rows.

## Coverage audit

- User decisions: 11/11 traced.
- Source audit findings: 18/18 traced.
- Normative requirements: 54/54 assigned to phases and positive/negative vector classes.
- Stable primitives: 61/61 named in `SPEC.md` and owned by Phases 06–10.
- Supported frameworks: 3/3 owned by Phases 11–14.
- Explicit deferments: exactly 2 boundaries, only one accessibility technology (JAWS) and the two experimental product packages.
- Unassigned MUST statements: zero expected; bundle validation MUST fail if any requirement/vector/phase mapping drifts.
