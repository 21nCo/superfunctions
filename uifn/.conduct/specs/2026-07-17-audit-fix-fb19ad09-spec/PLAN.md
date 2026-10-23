# Execution plan

Execute exactly one phase at a time. A phase is complete only after its implementation, required vectors, evidence, phase report, local `logs.csv` row, global `uifn/.conduct/logs.csv` row, and tracker update are present. Later-phase test scaffolding may be added earlier, but a phase MUST NOT claim later requirements complete. Phase 14 is the sole split-gate exception: its passing semantic-parity sub-gate may unblock Phases 15–18 while Phase 14 itself and `COMPAT-001` remain open until signed compatibility certification passes.

## Dependency graph

```text
00 governance/baseline
 └─01 graph cleanup
    └─02 canonical compiler
       └─03 private runtime
          └─04 controller/parts/environment
             └─05 DOM platform
                ├─06 shared algorithms + foundations
                ├─07 overlays
                ├─08 navigation
                ├─09 selection + text input
                └─10 gesture + date/color + feedback + i18n
                   ├─11 React
                   ├─12 Svelte
                   └─13 Solid
                      └─14A semantic parity implementation gate
                         ├─15 styling + hooks
                         └─16 package/source + registry
                            └─17 Storybook + docs
                               └─18 automated accessibility
14B signed compatibility certification ─────────────┐
18 automated accessibility ─────────────────────────┴─19 manual AT + independent review
                                                       └─20 performance + security + 1.0 release
```

Phases 06–10 can be implemented family-by-family after Phase 05, but Phase 10 cannot close until all five are complete. Phases 11–13 may run independently after core/DOM/catalog families are stable. Phase 14 requires all three adapters. `14A` and `14B` are sub-gates of the existing Phase 14, not new numbered phases: `14A` may open Phases 15–18, while `14B` must join the dependency chain before Phase 19 and remains mandatory for Phase 14 and final-spec completion.

## Phase matrix

| Phase | Objective | Primary requirements | Entry dependency | Exit evidence |
| --- | --- | --- | --- | --- |
| 00 | Freeze baseline, evidence schemas, ownership, defect policy, and non-negotiable decisions. | `OPS-001`, scaffolding for `TEST-001`, `REL-001` | None | Baseline manifest, owner/defect ledgers, evidence schema, current FAIL report. |
| 01 | Establish the three-framework stable graph; remove Vue/Angular; isolate experimental packages. | `SCOPE-001`, `CLEAN-001`, `EXP-001` | 00 | Graph verifier, removal scan, migration skeleton, stable gate independent of experimental workspaces. |
| 02 | Build the canonical definition compiler and 61-primitive authoritative catalog. | `CAT-001`, foundation for `GEN-001`, `A11Y-001` | 01 | Schema/compiler, complete catalog, deterministic generated inventory, drift verifier. |
| 03 | Replace competing state mechanisms with the one private service runtime. | `ARCH-001`, `CORE-001`–`CORE-004` | 02 | Runtime model/property/lifecycle/error/trace suites; no exported internals. |
| 04 | Implement the public controller, typed parts, environment/scope, and delete legacy paths. | `ARCH-002`, `ARCH-003`, `PART-001`, `ENV-001` | 03 | Contract/type tests, SSR/root-scope fixtures, legacy scan, migration mapping. |
| 05 | Implement and prove the full DOM platform package. | `DOM-001`–`DOM-007` | 04 | Real-browser DOM corpus for scope/layer/focus/modal/position/presence/form/live regions and leak evidence. |
| 06 | Implement shared algorithms and foundational/static/disclosure primitives. | `CAT-002`, `PRIM-001` | 05 | Property tests and canonical traces for Phase 06 family in package/source harnesses. |
| 07 | Implement overlay and modal primitives solely on shared DOM services. | `PRIM-002` | 05, 06 shared infrastructure | Nested overlay, dismissal, focus, geometry, presence, AT-ready trace evidence. |
| 08 | Implement menu and navigation primitives. | `PRIM-003` | 05, 06 shared algorithms | APG/native keyboard tables, dynamic collections, submenu and RTL traces. |
| 09 | Implement selection, collection, editable, text, number, clipboard, and file primitives. | `PRIM-004`, `PRIM-005` | 05, 06 shared algorithms | Controlled/form/IME/async/secure-input traces and adversarial browser vectors. |
| 10 | Implement range/gesture, date/time/color, feedback/workflow, and cross-catalog i18n. | `PRIM-006`–`PRIM-008`, `I18N-001` | 05, 06 shared algorithms | Pointer/touch, locale/timezone/RTL, fake-clock, announcement, model/property evidence. |
| 11 | Deliver the complete public React compound system. | `REACT-001` | 06–10 behavior families | React 18.3/19 public-tree contract, SSR/hydration/concurrency, package/source traces. |
| 12 | Deliver the complete public Svelte compound system. | `SVELTE-001` | 06–10 behavior families | Svelte 5 public-tree contract, compiled package, SSR/hydration/reactivity, package/source traces. |
| 13 | Deliver the complete public Solid compound system. | `SOLID-001` | 06–10 behavior families | Solid public-tree inventory, fine-grained reactivity, SSR/hydration/owner cleanup, package/source traces. |
| 14 | Compare actual public trees and prove the full support matrix. Semantic parity is an implementation sub-gate; signed compatibility remains the phase/release sub-gate. | `ADAPT-001`, `PARITY-001`, `COMPAT-001` | 11–13 | Mutation-proven semantic parity plus the exact signed Node/framework/desktop/mobile browser matrix; Phase 14 remains open until both pass. |
| 15 | Split styled components by framework and complete tokens/themes/recipes/hooks. | `COMP-001`, `STYLE-001`, `HOOK-001` | Phase 14 semantic-parity sub-gate (`ADAPT-001`, `PARITY-001`) | Framework-isolated tarballs, headless/styled trace parity, preferences/visual/hook lifecycle evidence. |
| 16 | Make package and source installation one canonical, safe delivery system. | `GEN-001`, `REG-001` | Phase 14 semantic-parity sub-gate, 15 | Deterministic generation, clean consumer equivalence, registry adversarial/rollback suite. |
| 17 | Make Storybook and docs complete executable public surfaces. | `STORY-001`, `DOCS-001` | 16 | Built story exact coverage and runnable/current documentation examples. |
| 18 | Complete normative ledger and automated accessibility/interaction verification. | `A11Y-001`, `A11Y-002`, most of `TEST-001` | Phase 14 semantic-parity sub-gate, 16, 17 | Reviewed ledgers, browser-specific explicit assertions, axe/preferences/zoom evidence, mutation score. |
| 19 | Execute manual AT/device testing and obtain independent review. | `A11Y-003`, `A11Y-004` | 18, Phase 14 signed compatibility certification, and release-candidate artifact freeze | Signed VoiceOver/NVDA/TalkBack evidence, retests, independent 10/10 assessment, JAWS disclosure. |
| 20 | Enforce hard budgets, supply-chain integrity, and publishable 1.0 release. | `PERF-001`, `PERF-002`, `SEC-001`, `REL-001`, `REL-002`, close `TEST-001` | 19 | Size/perf/leak raw evidence, SBOM/signatures/attestation, exact RC gate, release/rollback proof. |

## Requirement traceability

Every requirement has one owning phase below. Cross-phase verification may add evidence but does not change ownership.

| Requirement | Owning phase | Required vectors |
| --- | --- | --- |
| `SCOPE-001` | 01 | `TV-SCOPE-001-P/N` |
| `CLEAN-001` | 01 | `TV-CLEAN-001-P/N` |
| `EXP-001` | 01 | `TV-EXP-001-P/N` |
| `OPS-001` | 00 | `TV-OPS-001-P/N` |
| `ARCH-001` | 03 | `TV-ARCH-001-P/N` |
| `ARCH-002` | 04 | `TV-ARCH-002-P/N` |
| `ARCH-003` | 04 | `TV-ARCH-003-P/N` |
| `CORE-001` | 03 | `TV-CORE-001-P/N` |
| `CORE-002` | 03 | `TV-CORE-002-P/N` |
| `CORE-003` | 03 | `TV-CORE-003-P/N` |
| `CORE-004` | 03 | `TV-CORE-004-P/N` |
| `PART-001` | 04 | `TV-PART-001-P/N` |
| `ENV-001` | 04 | `TV-ENV-001-P/N` |
| `DOM-001`–`DOM-007` | 05 | Corresponding `TV-DOM-00x-P/N` |
| `CAT-001` | 02 | `TV-CAT-001-P/N` |
| `CAT-002` | 06 | `TV-CAT-002-P/N` |
| `PRIM-001` | 06 | `TV-PRIM-001-P/N` |
| `PRIM-002` | 07 | `TV-PRIM-002-P/N` |
| `PRIM-003` | 08 | `TV-PRIM-003-P/N` |
| `PRIM-004`–`PRIM-005` | 09 | Corresponding `TV-PRIM-00x-P/N` |
| `PRIM-006`–`PRIM-008` | 10 | Corresponding `TV-PRIM-00x-P/N` |
| `I18N-001` | 10 | `TV-I18N-001-P/N` |
| `ADAPT-001` | 14 | `TV-ADAPT-001-P/N` |
| `REACT-001` | 11 | `TV-REACT-001-P/N` |
| `SVELTE-001` | 12 | `TV-SVELTE-001-P/N` |
| `SOLID-001` | 13 | `TV-SOLID-001-P/N` |
| `PARITY-001` | 14 | `TV-PARITY-001-P/N` |
| `COMPAT-001` | 14 | `TV-COMPAT-001-P/N` |
| `COMP-001` | 15 | `TV-COMP-001-P/N` |
| `STYLE-001` | 15 | `TV-STYLE-001-P/N` |
| `HOOK-001` | 15 | `TV-HOOK-001-P/N` |
| `GEN-001` | 16 | `TV-GEN-001-P/N` |
| `REG-001` | 16 | `TV-REG-001-P/N` |
| `STORY-001` | 17 | `TV-STORY-001-P/N` |
| `DOCS-001` | 17 | `TV-DOCS-001-P/N` |
| `A11Y-001`–`A11Y-002` | 18 | Corresponding `TV-A11Y-00x-P/N` |
| `A11Y-003`–`A11Y-004` | 19 | Corresponding `TV-A11Y-00x-P/N` |
| `TEST-001` | 20, scaffolded 00 and exercised throughout | `TV-TEST-001-P/N` |
| `PERF-001`–`PERF-002` | 20 | Corresponding `TV-PERF-00x-P/N` |
| `SEC-001` | 20 | `TV-SEC-001-P/N` |
| `REL-001`–`REL-002` | 20 | Corresponding `TV-REL-00x-P/N` |

## Phase completion protocol

For each phase:

1. Read `SPEC.md`, `REQUIREMENTS.md`, `TEST_VECTORS.md`, `INTENT_AUDIT.md`, this plan, and the phase file in full.
2. Re-check current worktree and prior phase reports; do not overwrite unrelated user work.
3. Implement only the phase scope and its necessary test/evidence infrastructure.
4. Run every phase vector, relevant regression suites, clean consumer tests, typechecks, package checks, and negative/mutation fixtures.
5. Write `phase-reports/PHASE_XX-<date>-<id>-report.md` with changed files, commands, exact outcomes, evidence paths, unresolved defects, requirement/vector status, and rollback notes.
6. Mark complete only with no unresolved phase-blocking finding. Otherwise report `FAIL` and keep tracker status open.
7. Append logs; never rewrite previous evidence or reports.

## Final release invariant

The end state is not “all phase files exist.” It is one exact release-candidate artifact set for which all 54 requirements and all positive/negative vector classes have current evidence, every required compatibility and assistive-technology row is signed and passing, every hard budget is met, no release-blocking defect is open, and the independently reviewed release verifier returns a non-dry-run pass. Advancing through Phases 15–18 on semantic parity never relaxes this invariant.
